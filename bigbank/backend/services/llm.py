"""Provider-agnostic AI evaluator using strictly isolated direct provider adapters."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import ssl
from typing import Any, Callable, Coroutine

import httpx

from backend.config import Settings

logger = logging.getLogger(__name__)

_DISABLED_PROVIDERS = {"", "none", "disabled", "off", "manual"}
_KEYLESS_PROVIDERS = {"ollama", "vertex_ai", "vertex", "bedrock"}
_PROVIDER_PREFIX_MAP: dict[str, str] = {
    "anthropic": "anthropic",
    "gemini": "gemini",
    "google": "gemini",
    "vertex_ai": "vertex_ai",
    "vertex": "vertex_ai",
    "azure": "azure",
    "bedrock": "bedrock",
    "ollama": "ollama",
    "groq": "groq",
    "mistral": "mistral",
    "cohere": "cohere",
    "deepseek": "deepseek",
    "together_ai": "together_ai",
    "openrouter": "openrouter",
    "openai_compatible": "openai",
    "custom": "openai",
}
_ALWAYS_PREFIX_PROVIDERS = {
    "bedrock",
    "openrouter",
    "openai_compatible",
    "custom",
    "together_ai",
    "groq",
    "ollama",
}
_OPENAI_VENDOR_BASE_URLS: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "together_ai": "https://api.together.xyz/v1",
    "mistral": "https://api.mistral.ai/v1",
}
_PLACEHOLDER_PROJECTS = {
    "",
    "your-gcp-project-id",
    "your-project-id",
    "my-gcp-project",
    "project-id",
    "<project-id>",
}
_ANTHROPIC_VERSION = "2023-06-01"
_AZURE_DEFAULT_API_VERSION = "2024-06-01"
_VERTEX_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)
_DIFFICULTY_DEFAULT_POINTS = {"easy": 10.0, "medium": 20.0, "hard": 30.0}
_DATA_URI_RE = re.compile(r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+")
_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)


def _strip_data_uris(text: str) -> str:
    if not text:
        return ""
    return _DATA_URI_RE.sub("[Image output omitted]", text)


def _stringify_source(source: Any) -> str:
    if source is None:
        return ""
    if isinstance(source, list):
        return "".join(str(line) for line in source)
    return str(source)


def _extract_jupyter_outputs(outputs: list[Any]) -> tuple[list[str], list[str], int]:
    """Extract stdout/text outputs, error outputs, and image counts from Jupyter-style outputs."""
    out_parts: list[str] = []
    err_parts: list[str] = []
    image_count = 0

    for item in outputs:
        if isinstance(item, str):
            cleaned = _strip_data_uris(item).strip()
            if cleaned:
                out_parts.append(cleaned)
            continue
        if not isinstance(item, dict):
            continue

        out_type = str(item.get("output_type") or item.get("type") or "").lower()
        if out_type == "error":
            ename = item.get("ename", "")
            evalue = item.get("evalue", "")
            tb = item.get("traceback")
            if isinstance(tb, list) and tb:
                err_parts.append("\n".join(str(line) for line in tb))
            elif ename or evalue:
                err_parts.append(f"{ename}: {evalue}".strip(": "))
            continue

        if out_type == "image" or item.get("image"):
            image_count += 1
            continue

        text_val = item.get("text")
        if text_val:
            text_str = _strip_data_uris(_stringify_source(text_val)).strip()
            if text_str:
                if item.get("name") == "stderr":
                    err_parts.append(text_str)
                else:
                    out_parts.append(text_str)

        data = item.get("data")
        if isinstance(data, dict):
            for mime in data:
                if str(mime).startswith("image/"):
                    image_count += 1
            plain = data.get("text/plain")
            if plain:
                plain_str = _strip_data_uris(_stringify_source(plain)).strip()
                if plain_str:
                    out_parts.append(plain_str)

    return out_parts, err_parts, image_count


def format_notebook_answer(raw_answer: str | dict[str, Any] | list[Any] | None) -> str:
    """Render notebook JSON cells and outputs into clean readable text for LLM and PDF."""
    if raw_answer is None:
        return ""

    parsed: Any
    if isinstance(raw_answer, str):
        stripped = raw_answer.strip()
        if not stripped:
            return ""
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return _strip_data_uris(raw_answer)
    else:
        parsed = raw_answer

    cells: list[Any] | None = None
    if isinstance(parsed, dict) and isinstance(parsed.get("cells"), list):
        cells = parsed["cells"]
    elif isinstance(parsed, list) and all(isinstance(c, dict) for c in parsed):
        cells = parsed

    if cells is None:
        return _strip_data_uris(raw_answer if isinstance(raw_answer, str) else json.dumps(parsed, indent=2))

    if not cells:
        return "(Empty notebook)"

    rendered_blocks: list[str] = []
    for idx, cell in enumerate(cells, start=1):
        if not isinstance(cell, dict):
            continue
        cell_type = str(cell.get("type") or cell.get("cell_type") or "code").strip().lower()
        source = _strip_data_uris(_stringify_source(cell.get("source"))).rstrip()

        lines: list[str] = [f"--- Cell {idx} ({cell_type}) ---"]
        lines.append(source if source else "(empty cell)")

        out_parts: list[str] = []
        err_parts: list[str] = []
        image_count = 0

        for field in ("output", "stdout"):
            val = cell.get(field)
            if val is not None and str(val).strip():
                out_parts.append(_strip_data_uris(str(val)).strip())

        for field in ("stderr", "error"):
            val = cell.get(field)
            if val is not None and str(val).strip():
                err_parts.append(_strip_data_uris(str(val)).strip())

        images = cell.get("images")
        if isinstance(images, list):
            image_count += len([img for img in images if img])

        jupyter_outputs = cell.get("outputs")
        if isinstance(jupyter_outputs, list):
            j_out, j_err, j_imgs = _extract_jupyter_outputs(jupyter_outputs)
            out_parts.extend(j_out)
            err_parts.extend(j_err)
            image_count += j_imgs

        if out_parts:
            lines.append("[Output]:")
            lines.append("\n".join(out_parts))
        if err_parts:
            lines.append("[Error]:")
            lines.append("\n".join(err_parts))
        if image_count > 0:
            label = "image" if image_count == 1 else "images"
            lines.append(f"[Plot/Image Output]: {image_count} {label} rendered")

        rendered_blocks.append("\n".join(lines))

    return "\n\n".join(rendered_blocks)


def _extract_json_object(raw_text: str) -> dict[str, Any]:
    """Extract a JSON object from raw LLM output, handling markdown fences and surrounding prose."""
    text = (raw_text or "").strip()
    if not text:
        raise ValueError("Empty LLM response")

    for match in _FENCED_JSON_RE.finditer(text):
        candidate = match.group(1).strip()
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        parsed = json.loads(text[start : end + 1])
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("No valid JSON object found in LLM response")


def _build_ssl_context() -> ssl.SSLContext:
    """Use configured CA bundle if valid, otherwise the OS native trust store."""
    for env_var in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"):
        cafile = (os.environ.get(env_var) or "").strip()
        if cafile and os.path.isfile(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


def _split_system_messages(
    messages: list[dict[str, str]],
) -> tuple[str, list[dict[str, str]]]:
    """Separate system prompts from user/assistant turns for providers with top-level system fields."""
    sys_parts: list[str] = []
    turns: list[dict[str, str]] = []
    for msg in messages:
        role = str(msg.get("role") or "user").strip().lower()
        content = str(msg.get("content") or "")
        if role == "system":
            if content.strip():
                sys_parts.append(content.strip())
        else:
            turns.append({"role": role, "content": content})
    return "\n\n".join(sys_parts), turns


def _resolve_vertex_project(
    adc_project: str | None, configured_project: str = ""
) -> str:
    """Resolve Vertex AI GCP project from explicit Settings, env vars, or ADC."""
    configured = (configured_project or "").strip()
    if configured.lower() not in _PLACEHOLDER_PROJECTS:
        return configured
    for env_var in ("VERTEXAI_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"):
        candidate = (os.environ.get(env_var) or "").strip()
        if candidate.lower() not in _PLACEHOLDER_PROJECTS:
            return candidate
    if adc_project and adc_project.strip().lower() not in _PLACEHOLDER_PROJECTS:
        return adc_project.strip()
    raise RuntimeError(
        "Vertex AI requires a GCP project ID. Enter GCP Project ID in Settings or authenticate via gcloud ADC."
    )


def _resolve_vertex_location(configured_location: str = "") -> str:
    """Resolve Vertex AI region/location from explicit Settings, env vars, or default."""
    configured = (configured_location or "").strip()
    if configured:
        return configured
    for env_var in ("VERTEXAI_LOCATION", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_REGION"):
        candidate = (os.environ.get(env_var) or "").strip()
        if candidate:
            return candidate
    return "us-central1"


async def _post_json(
    url: str,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout: int,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Execute an isolated HTTPS/HTTP JSON POST using OS TLS certificates."""
    async with httpx.AsyncClient(timeout=timeout, verify=_build_ssl_context()) as client:
        response = await client.post(url, headers=headers, json=payload, params=params)
    if response.status_code >= 400:
        snippet = response.text.strip().replace("\n", " ")[:400]
        raise RuntimeError(f"HTTP {response.status_code} from provider endpoint: {snippet}")
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("Expected JSON object response from provider endpoint")
    return data


def _extract_openai_text(data: dict[str, Any]) -> str:
    """Extract assistant reply text from an OpenAI Chat Completions JSON payload."""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message") or {}
    content = message.get("content") if isinstance(message, dict) else ""
    if isinstance(content, list):
        parts = [
            str(block.get("text", ""))
            for block in content
            if isinstance(block, dict) and block.get("text")
        ]
        return "\n".join(parts)
    return str(content or "")


def _extract_anthropic_text(data: dict[str, Any]) -> str:
    """Extract text blocks from an Anthropic Messages JSON payload."""
    blocks = data.get("content")
    if not isinstance(blocks, list):
        return ""
    parts = [
        str(block.get("text", ""))
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    ]
    return "\n".join(parts)


def _extract_gemini_text(data: dict[str, Any]) -> str:
    """Extract non-thought text parts from a Gemini / Vertex generateContent JSON payload."""
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    content = first.get("content") or {}
    parts = content.get("parts") or []
    texts: list[str] = []
    for part in parts:
        if isinstance(part, dict) and not part.get("thought") and part.get("text"):
            texts.append(str(part["text"]))
    return "".join(texts)


def _extract_bedrock_text(data: dict[str, Any]) -> str:
    """Extract assistant reply text from a boto3 bedrock-runtime converse() response."""
    output = data.get("output") or {}
    message = output.get("message") or {}
    blocks = message.get("content") or []
    parts = [
        str(block.get("text", ""))
        for block in blocks
        if isinstance(block, dict) and block.get("text")
    ]
    return "\n".join(parts)


def _resolve_max_points(question: dict[str, Any]) -> float:
    raw = question.get("effective_points")
    if raw is None:
        raw = question.get("default_points")
    if raw is None:
        diff = str(question.get("difficulty") or "medium").strip().lower()
        raw = _DIFFICULTY_DEFAULT_POINTS.get(diff, 10.0)
    try:
        val = float(raw)
        return val if val >= 0 else 0.0
    except (TypeError, ValueError):
        return 10.0


def _compact_results_for_summary(results: dict[str, Any]) -> dict[str, Any]:
    """Create a token-safe copy of interview results for summary generation."""
    compact: dict[str, Any] = {
        "final_score": results.get("final_score", 0),
        "max_score": results.get("max_score", 0),
        "score_percentage": results.get("score_percentage", 0),
        "total_questions": results.get("total_questions"),
        "attempted_questions": results.get("attempted_questions"),
        "duration_seconds": results.get("duration_seconds"),
    }
    answers_out: list[dict[str, Any]] = []
    for ans in results.get("answers") or []:
        if not isinstance(ans, dict):
            continue
        raw_text = str(
            ans.get("candidate_answer_text")
            or ans.get("candidate_answer")
            or ""
        )
        if len(raw_text) > 2500:
            raw_text = raw_text[:2500] + "\n... [truncated]"
        answers_out.append(
            {
                "question_text": str(ans.get("question_text") or ans.get("prompt") or "")[:1000],
                "question_format": ans.get("question_format") or ans.get("format"),
                "difficulty": ans.get("difficulty"),
                "candidate_answer": raw_text,
                "evaluation": ans.get("evaluation") or {},
            }
        )
    compact["answers"] = answers_out
    return compact


class LLMService:
    """Provider-agnostic AI evaluation service with isolated per-provider adapters."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def provider(self) -> str:
        return (self.settings.llm_provider or "none").strip().lower() or "none"

    def resolve_model_name(self) -> str:
        """Map Settings (llm_provider, llm_model) to a canonical provider-prefixed identifier."""
        provider = self.provider
        model = (self.settings.llm_model or "").strip()
        if not model:
            return ""
        if provider in _DISABLED_PROVIDERS or provider == "openai":
            return model

        prefix = _PROVIDER_PREFIX_MAP.get(provider)
        if not prefix:
            return model

        if model.startswith(f"{prefix}/"):
            return model
        if provider in _ALWAYS_PREFIX_PROVIDERS:
            return f"{prefix}/{model}"
        if "/" in model:
            return model
        return f"{prefix}/{model}"

    def _api_model_name(self) -> str:
        """Return the native model ID expected by the active provider's direct endpoint."""
        model = (self.settings.llm_model or "").strip()
        if not model:
            return ""
        prefixes = [self.provider]
        mapped = _PROVIDER_PREFIX_MAP.get(self.provider)
        if mapped and mapped not in prefixes:
            prefixes.append(mapped)
        if self.provider in {"openai_compatible", "custom"} and "openai" not in prefixes:
            prefixes.append("openai")
        for prefix in prefixes:
            tag = f"{prefix}/"
            if model.startswith(tag):
                return model[len(tag) :]
        return model

    def is_configured(self) -> bool:
        """Return True when the configured provider has enough settings to invoke an LLM."""
        provider = self.provider
        if provider in _DISABLED_PROVIDERS:
            return False
        if not (self.settings.llm_model or "").strip():
            return False
        if provider in _KEYLESS_PROVIDERS:
            return True
        if provider in {"openai_compatible", "custom"}:
            return bool(
                (self.settings.llm_api_key or "").strip()
                or (self.settings.llm_base_url or "").strip()
            )
        return bool((self.settings.llm_api_key or "").strip())

    async def _call_openai_chat(
        self,
        *,
        base_url: str,
        api_key: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        model = self._api_model_name()
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        is_reasoning = model.startswith(("o1", "o3", "o4"))
        if not is_reasoning:
            payload["temperature"] = temperature
        if max_tokens is not None:
            key = "max_completion_tokens" if is_reasoning else "max_tokens"
            payload[key] = max_tokens
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        data = await _post_json(url, headers=headers, payload=payload, timeout=timeout)
        return _extract_openai_text(data)

    async def _call_openai(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (self.settings.llm_base_url or "").strip() or "https://api.openai.com/v1"
        api_key = (self.settings.llm_api_key or "").strip()
        return await self._call_openai_chat(
            base_url=base_url,
            api_key=api_key,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    async def _call_openai_compatible(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (self.settings.llm_base_url or "").strip()
        if not base_url:
            raise RuntimeError("OpenAI-compatible provider requires LLM_BASE_URL.")
        # Local servers (vLLM, LM Studio, Ollama /v1) often require a non-empty Bearer value.
        api_key = (self.settings.llm_api_key or "").strip() or "local"
        return await self._call_openai_chat(
            base_url=base_url,
            api_key=api_key,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    async def _call_openai_vendor(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        default_base = _OPENAI_VENDOR_BASE_URLS[self.provider]
        base_url = (self.settings.llm_base_url or "").strip() or default_base
        api_key = (self.settings.llm_api_key or "").strip()
        return await self._call_openai_chat(
            base_url=base_url,
            api_key=api_key,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    async def _call_ollama(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (self.settings.llm_base_url or "").strip() or "http://localhost:11434"
        clean_base = base_url.rstrip("/")
        if clean_base.endswith("/v1"):
            api_key = (self.settings.llm_api_key or "").strip() or "ollama"
            return await self._call_openai_chat(
                base_url=clean_base,
                api_key=api_key,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
            )
        options: dict[str, Any] = {"temperature": temperature}
        if max_tokens is not None:
            options["num_predict"] = max_tokens
        payload: dict[str, Any] = {
            "model": self._api_model_name(),
            "messages": messages,
            "stream": False,
            "options": options,
        }
        headers = {"Content-Type": "application/json"}
        api_key = (self.settings.llm_api_key or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        data = await _post_json(
            f"{clean_base}/api/chat",
            headers=headers,
            payload=payload,
            timeout=timeout,
        )
        msg = data.get("message")
        if isinstance(msg, dict) and msg.get("content") is not None:
            return str(msg["content"])
        return _extract_openai_text(data)

    async def _call_anthropic(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (self.settings.llm_base_url or "").strip() or "https://api.anthropic.com"
        clean_base = base_url.rstrip("/")
        url = clean_base if clean_base.endswith("/v1/messages") else (
            f"{clean_base}/messages" if clean_base.endswith("/v1") else f"{clean_base}/v1/messages"
        )
        system_text, turns = _split_system_messages(messages)
        payload: dict[str, Any] = {
            "model": self._api_model_name(),
            "messages": turns,
            "max_tokens": max_tokens if max_tokens is not None else 4096,
            "temperature": temperature,
        }
        if system_text:
            payload["system"] = system_text
        headers = {
            "x-api-key": (self.settings.llm_api_key or "").strip(),
            "anthropic-version": _ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }
        data = await _post_json(url, headers=headers, payload=payload, timeout=timeout)
        return _extract_anthropic_text(data)

    def _build_gemini_payload(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
    ) -> dict[str, Any]:
        system_text, turns = _split_system_messages(messages)
        contents = [
            {
                "role": "model" if turn["role"] == "assistant" else "user",
                "parts": [{"text": turn["content"]}],
            }
            for turn in turns
        ]
        payload: dict[str, Any] = {"contents": contents}
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}
        gen_config: dict[str, Any] = {"temperature": temperature}
        if max_tokens is not None:
            gen_config["maxOutputTokens"] = max_tokens
        payload["generationConfig"] = gen_config
        return payload

    async def _call_gemini(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (
            (self.settings.llm_base_url or "").strip()
            or "https://generativelanguage.googleapis.com"
        ).rstrip("/")
        model = self._api_model_name()
        url = f"{base_url}/v1beta/models/{model}:generateContent"
        headers = {
            "x-goog-api-key": (self.settings.llm_api_key or "").strip(),
            "Content-Type": "application/json",
        }
        payload = self._build_gemini_payload(
            messages, temperature=temperature, max_tokens=max_tokens
        )
        data = await _post_json(url, headers=headers, payload=payload, timeout=timeout)
        return _extract_gemini_text(data)

    async def _call_vertex_ai(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        # Lazy-import Google auth only when vertex_ai is actively selected.
        import google.auth
        from google.auth.transport.requests import Request as GoogleAuthRequest

        def _get_token_and_project() -> tuple[str, str]:
            credentials, adc_project = google.auth.default(scopes=list(_VERTEX_SCOPES))
            credentials.refresh(GoogleAuthRequest())
            project_id = _resolve_vertex_project(
                adc_project or getattr(credentials, "quota_project_id", None),
                configured_project=getattr(self.settings, "vertexai_project", "") or "",
            )
            if not credentials.token:
                raise RuntimeError("Vertex AI ADC failed to issue an access token.")
            return credentials.token, project_id

        token, project_id = await asyncio.to_thread(_get_token_and_project)
        location = _resolve_vertex_location(
            configured_location=getattr(self.settings, "vertexai_location", "") or ""
        )
        model = self._api_model_name()
        custom_base = (self.settings.llm_base_url or "").strip().rstrip("/")
        if custom_base:
            url = (
                f"{custom_base}/v1/projects/{project_id}/locations/{location}"
                f"/publishers/google/models/{model}:generateContent"
            )
        else:
            host = (
                "aiplatform.googleapis.com"
                if location == "global"
                else f"{location}-aiplatform.googleapis.com"
            )
            url = (
                f"https://{host}/v1/projects/{project_id}/locations/{location}"
                f"/publishers/google/models/{model}:generateContent"
            )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        payload = self._build_gemini_payload(
            messages, temperature=temperature, max_tokens=max_tokens
        )
        data = await _post_json(url, headers=headers, payload=payload, timeout=timeout)
        return _extract_gemini_text(data)

    async def _call_azure(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (self.settings.llm_base_url or "").strip().rstrip("/")
        if not base_url:
            raise RuntimeError("Azure OpenAI requires LLM_BASE_URL.")
        deployment = self._api_model_name()
        url = f"{base_url}/openai/deployments/{deployment}/chat/completions"
        api_version = (
            (getattr(self.settings, "azure_api_version", "") or "").strip()
            or os.environ.get("AZURE_API_VERSION")
            or _AZURE_DEFAULT_API_VERSION
        ).strip()
        payload: dict[str, Any] = {
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        headers = {
            "api-key": (self.settings.llm_api_key or "").strip(),
            "Content-Type": "application/json",
        }
        data = await _post_json(
            url,
            headers=headers,
            payload=payload,
            timeout=timeout,
            params={"api-version": api_version},
        )
        return _extract_openai_text(data)

    async def _call_cohere(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        base_url = (self.settings.llm_base_url or "").strip() or "https://api.cohere.com"
        payload: dict[str, Any] = {
            "model": self._api_model_name(),
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        headers = {
            "Authorization": f"Bearer {(self.settings.llm_api_key or '').strip()}",
            "Content-Type": "application/json",
        }
        data = await _post_json(
            f"{base_url.rstrip('/')}/v2/chat",
            headers=headers,
            payload=payload,
            timeout=timeout,
        )
        msg = data.get("message") or {}
        blocks = msg.get("content") or []
        return "\n".join(
            str(b.get("text", ""))
            for b in blocks
            if isinstance(b, dict) and b.get("text")
        )

    async def _call_bedrock(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        timeout: int,
    ) -> str:
        # Lazy-import boto3 only when bedrock is actively selected.
        import boto3
        from botocore.config import Config as BotoConfig

        system_text, turns = _split_system_messages(messages)
        bedrock_messages = [
            {
                "role": "assistant" if turn["role"] == "assistant" else "user",
                "content": [{"text": turn["content"]}],
            }
            for turn in turns
        ]
        inference_cfg: dict[str, Any] = {"temperature": temperature}
        if max_tokens is not None:
            inference_cfg["maxTokens"] = max_tokens

        def _invoke() -> dict[str, Any]:
            region = (
                (getattr(self.settings, "aws_region", "") or "").strip()
                or os.environ.get("AWS_REGION")
                or os.environ.get("AWS_DEFAULT_REGION")
                or "us-east-1"
            )
            client_kwargs: dict[str, Any] = {
                "region_name": region,
                "config": BotoConfig(read_timeout=timeout, connect_timeout=min(timeout, 15)),
            }
            key_id = (getattr(self.settings, "aws_access_key_id", "") or "").strip()
            secret_key = (getattr(self.settings, "aws_secret_access_key", "") or "").strip()
            if key_id and secret_key:
                client_kwargs["aws_access_key_id"] = key_id
                client_kwargs["aws_secret_access_key"] = secret_key
            client = boto3.client("bedrock-runtime", **client_kwargs)
            converse_kwargs: dict[str, Any] = {
                "modelId": self._api_model_name(),
                "messages": bedrock_messages,
                "inferenceConfig": inference_cfg,
            }
            if system_text:
                converse_kwargs["system"] = [{"text": system_text}]
            return client.converse(**converse_kwargs)

        data = await asyncio.to_thread(_invoke)
        return _extract_bedrock_text(data)

    async def _complete(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        timeout: int = 60,
    ) -> str:
        """Dispatch strictly to the active provider adapter and leave all others inactive."""
        provider = self.provider
        if provider in _DISABLED_PROVIDERS:
            raise RuntimeError("LLM provider is disabled.")

        dispatch: dict[str, Callable[..., Coroutine[Any, Any, str]]] = {
            "openai": self._call_openai,
            "openai_compatible": self._call_openai_compatible,
            "custom": self._call_openai_compatible,
            "ollama": self._call_ollama,
            "anthropic": self._call_anthropic,
            "gemini": self._call_gemini,
            "google": self._call_gemini,
            "vertex_ai": self._call_vertex_ai,
            "vertex": self._call_vertex_ai,
            "azure": self._call_azure,
            "bedrock": self._call_bedrock,
            "cohere": self._call_cohere,
            **{name: self._call_openai_vendor for name in _OPENAI_VENDOR_BASE_URLS},
        }
        handler = dispatch.get(provider)
        if handler is None:
            raise ValueError(f"Unsupported LLM provider: '{provider}'.")
        return await handler(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    def _scrub_secret(self, text: str) -> str:
        api_key = (self.settings.llm_api_key or "").strip()
        if api_key and api_key in text:
            return text.replace(api_key, "[REDACTED]")
        return text

    async def score_answer(
        self,
        question: dict[str, Any],
        candidate_answer: str,
        role_title: str,
    ) -> dict[str, Any]:
        """Score a candidate's answer using the question's rubric and expected solution."""
        max_points = _resolve_max_points(question)
        q_format = str(
            question.get("format") or question.get("question_format") or "text"
        ).strip().lower()

        formatted_answer = (
            format_notebook_answer(candidate_answer)
            if q_format == "notebook"
            else (str(candidate_answer) if candidate_answer is not None else "")
        )

        if not formatted_answer or not formatted_answer.strip():
            return {
                "score": 0.0,
                "max_points": max_points,
                "correctness_pct": 0.0,
                "rubric_breakdown": [],
                "feedback": "No answer provided.",
                "needs_manual_review": False,
            }

        if not self.is_configured():
            return {
                "score": 0.0,
                "max_points": max_points,
                "correctness_pct": 0.0,
                "rubric_breakdown": [],
                "feedback": "Automated AI evaluation is not configured. Marked for Manual Review.",
                "needs_manual_review": True,
            }

        role = (role_title or "Candidate").strip()
        difficulty = str(question.get("difficulty") or "medium").strip().lower()
        prompt_text = str(question.get("prompt") or question.get("question_text") or "").strip()
        expected_answer = (
            question.get("effective_expected_answer")
            if question.get("effective_expected_answer") is not None
            else question.get("expected_answer", "")
        )
        rubric = (
            question.get("effective_rubric")
            if question.get("effective_rubric") is not None
            else (question.get("evaluation_rubric") or question.get("scoring_criteria") or "")
        )

        system_prompt = (
            f"You are an expert interviewer evaluating a candidate for the role of {role}. "
            "Grade strictly, fairly, and consistently against the provided rubric and expected answer. "
            "Respond ONLY with a valid JSON object matching the requested schema."
        )
        user_prompt = (
            f"Role: {role}\n"
            f"Question Format: {q_format}\n"
            f"Difficulty: {difficulty}\n"
            f"Maximum Points: {max_points:g}\n\n"
            f"Question:\n{prompt_text}\n\n"
            f"Expected Answer / Reference Approach:\n"
            f"{str(expected_answer).strip() or 'Not specified — evaluate against industry best practices for this role.'}\n\n"
            f"Evaluation Rubric:\n"
            f"{str(rubric).strip() or 'Assess correctness, depth of reasoning, clarity, and practical trade-offs.'}\n\n"
            f"Candidate Answer:\n{formatted_answer}\n\n"
            "Return STRICT JSON with exactly these keys:\n"
            f'- "score": number from 0 to {max_points:g}\n'
            '- "correctness_pct": number from 0 to 100\n'
            '- "rubric_breakdown": array of concise strings explaining how each rubric criterion was met or missed\n'
            '- "feedback": concise, constructive narrative feedback explaining the score and improvements\n'
        )

        try:
            content = await self._complete(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.0,
            )
            parsed = _extract_json_object(content)

            raw_score = float(parsed.get("score", 0.0))
            if not math.isfinite(raw_score):
                raise ValueError("Non-finite LLM score")
            clamped_score = round(max(0.0, min(max_points, raw_score)), 2)

            if parsed.get("correctness_pct") is not None:
                raw_pct = float(parsed["correctness_pct"])
                if not math.isfinite(raw_pct):
                    raw_pct = (clamped_score / max_points * 100.0) if max_points > 0 else 0.0
            else:
                raw_pct = (clamped_score / max_points * 100.0) if max_points > 0 else 0.0
            clamped_pct = round(max(0.0, min(100.0, raw_pct)), 1)

            raw_breakdown = parsed.get("rubric_breakdown")
            if isinstance(raw_breakdown, list):
                rubric_breakdown = [
                    str(item).strip() for item in raw_breakdown if str(item).strip()
                ]
            elif isinstance(raw_breakdown, str) and raw_breakdown.strip():
                rubric_breakdown = [raw_breakdown.strip()]
            else:
                rubric_breakdown = []

            feedback = str(parsed.get("feedback") or "").strip() or "Evaluated by AI."

            return {
                "score": clamped_score,
                "max_points": max_points,
                "correctness_pct": clamped_pct,
                "rubric_breakdown": rubric_breakdown,
                "feedback": feedback,
                "needs_manual_review": False,
            }
        except Exception as exc:
            logger.warning(
                "LLM score_answer failed (%s): %s",
                type(exc).__name__,
                self._scrub_secret(str(exc)),
            )
            return {
                "score": 0.0,
                "max_points": max_points,
                "correctness_pct": 0.0,
                "rubric_breakdown": [],
                "feedback": (
                    f"Automated evaluation unavailable ({type(exc).__name__}). "
                    "Marked for Manual Review."
                ),
                "needs_manual_review": True,
            }

    async def generate_summary(
        self,
        candidate_name: str,
        role_title: str,
        summary_dimensions: list[str],
        results: dict[str, Any],
    ) -> dict[str, Any]:
        """Generate a role-agnostic executive summary across template-defined dimensions."""
        dims = list(
            dict.fromkeys(
                str(d).strip() for d in (summary_dimensions or []) if str(d).strip()
            )
        )

        if not self.is_configured():
            return {
                "overall_feedback": "Automated AI summary is not configured. Marked for Manual Review.",
                "strengths": "Pending Manual Review.",
                "areas_of_opportunity": "Pending Manual Review.",
                "dimensions": {dim: "Pending Manual Review" for dim in dims},
            }

        role = (role_title or "Candidate").strip()
        candidate = (candidate_name or "Candidate").strip()
        compact_results = _compact_results_for_summary(results or {})

        if dims:
            dims_instruction = (
                '- "dimensions": JSON object mapping EACH of these exact keys to a concise rating/assessment string: '
                + json.dumps(dims)
            )
        else:
            dims_instruction = (
                '- "dimensions": JSON object of key competency ratings relevant to the role (or {} if none).'
            )

        system_prompt = (
            f"You are an expert hiring panel reviewer summarizing an interview for the role of {role}. "
            "Synthesize the candidate's overall performance objectively. "
            "Respond ONLY with a valid JSON object matching the requested schema."
        )
        user_prompt = (
            f"Candidate: {candidate}\n"
            f"Target Role: {role}\n\n"
            f"Interview Results:\n{json.dumps(compact_results, indent=2)}\n\n"
            "Return STRICT JSON with exactly these keys:\n"
            '- "overall_feedback": concise executive summary of overall performance\n'
            '- "strengths": key strengths demonstrated by the candidate\n'
            '- "areas_of_opportunity": concrete areas for improvement or follow-up\n'
            f"{dims_instruction}\n"
        )

        try:
            content = await self._complete(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.0,
            )
            parsed = _extract_json_object(content)

            overall = str(
                parsed.get("overall_feedback")
                or parsed.get("performance_feedback")
                or "N/A"
            ).strip()
            strengths = str(parsed.get("strengths") or "N/A").strip()
            areas = str(parsed.get("areas_of_opportunity") or "N/A").strip()

            raw_dims = parsed.get("dimensions")
            resolved_dims: dict[str, str] = {}
            if isinstance(raw_dims, dict):
                if dims:
                    for dim in dims:
                        val = raw_dims.get(dim)
                        resolved_dims[dim] = str(val).strip() if val is not None and str(val).strip() else "N/A"
                else:
                    for k, v in raw_dims.items():
                        key = str(k).strip()
                        if key:
                            resolved_dims[key] = str(v).strip() if v is not None else "N/A"
            else:
                resolved_dims = {dim: "N/A" for dim in dims}

            return {
                "overall_feedback": overall,
                "strengths": strengths,
                "areas_of_opportunity": areas,
                "dimensions": resolved_dims,
            }
        except Exception as exc:
            logger.warning(
                "LLM generate_summary failed (%s): %s",
                type(exc).__name__,
                self._scrub_secret(str(exc)),
            )
            return {
                "overall_feedback": (
                    f"Automated AI summary unavailable ({type(exc).__name__}). "
                    "Marked for Manual Review."
                ),
                "strengths": "Pending Manual Review.",
                "areas_of_opportunity": "Pending Manual Review.",
                "dimensions": {dim: "Pending Manual Review" for dim in dims},
            }

    async def test_connection(self) -> dict[str, Any]:
        """Verify live connectivity to the configured LLM provider."""
        provider = self.provider
        resolved_model = self.resolve_model_name() or (self.settings.llm_model or "").strip()

        if provider in _DISABLED_PROVIDERS:
            return {
                "ok": False,
                "provider": "none",
                "model": resolved_model,
                "detail": "LLM provider is set to 'none' (automated grading disabled).",
            }

        if not self.is_configured():
            return {
                "ok": False,
                "provider": provider,
                "model": resolved_model,
                "detail": f"Missing required API key, base URL, or model for provider '{provider}'.",
            }

        try:
            reply = (
                await self._complete(
                    messages=[{"role": "user", "content": "Reply with OK."}],
                    temperature=0.0,
                    max_tokens=256,
                    timeout=15,
                )
            ).strip()
            detail = f"Connection succeeded (reply: {reply[:40]})." if reply else "Connection succeeded."
            return {
                "ok": True,
                "provider": provider,
                "model": resolved_model,
                "detail": detail,
            }
        except Exception as exc:
            safe_err = self._scrub_secret(str(exc))
            return {
                "ok": False,
                "provider": provider,
                "model": resolved_model,
                "detail": f"{type(exc).__name__}: {safe_err}",
            }
