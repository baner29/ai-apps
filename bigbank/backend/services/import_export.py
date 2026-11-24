"""Bulk JSON/YAML question importer, validator, exporter, and sample templates."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

from backend.db.repository import InterviewRepository

VALID_FORMATS: frozenset[str] = frozenset({"mcq", "text", "code", "notebook"})
VALID_DIFFICULTIES: frozenset[str] = frozenset({"easy", "medium", "hard"})
VALID_DUPLICATE_STRATEGIES: frozenset[str] = frozenset({"skip", "overwrite"})

_LEGACY_MCQ_TYPES: frozenset[str] = frozenset(
    {"mcq", "multiple_choice", "multi_choice", "multi_select"}
)
_LEGACY_CODE_TYPES: frozenset[str] = frozenset({"code", "coding"})

_EXAMPLES_DIR = Path(__file__).resolve().parent.parent.parent / "examples"

_SAMPLE_TEMPLATE_DATA: dict[str, Any] = {
    "questions": [
        {
            "external_key": "sample-mcq-01",
            "title": "SQL Window Functions",
            "prompt": "Which clause defines the partitioning and ordering for a SQL window function?",
            "format": "mcq",
            "difficulty": "easy",
            "tags": ["data-engineering", "sql"],
            "options": [
                "OVER (PARTITION BY ... ORDER BY ...)",
                "GROUP BY ... HAVING ...",
                "QUALIFY ... LIMIT ...",
                "WITHIN GROUP (...)",
            ],
            "answer_indices": [0],
            "default_points": 10,
            "expected_answer": "OVER (PARTITION BY ... ORDER BY ...) defines the window frame.",
            "evaluation_rubric": "10 pts for selecting the exact correct option.",
        },
        {
            "external_key": "sample-text-01",
            "title": "RAG Chunking Tradeoffs",
            "prompt": (
                "Compare fixed-size vs. semantic chunking for an enterprise RAG pipeline "
                "and propose how you would evaluate retrieval quality."
            ),
            "format": "text",
            "difficulty": "medium",
            "tags": ["ai-engineering", "llm", "architecture"],
            "default_points": 20,
            "expected_answer": (
                "Discuss chunk boundary preservation, overlap, latency/cost tradeoffs, "
                "and offline/online retrieval metrics such as recall@k, MRR, and faithfulness."
            ),
            "evaluation_rubric": (
                "- 8 pts: Explains tradeoffs between chunk size, context coherence, and noise\n"
                "- 7 pts: Proposes concrete retrieval and groundedness metrics\n"
                "- 5 pts: Addresses overlap, metadata filtering, or hybrid search"
            ),
        },
        {
            "external_key": "sample-code-01",
            "title": "LRU Cache Implementation",
            "prompt": (
                "Implement an `LRUCache` class supporting `get(key)` and `put(key, value)` "
                "in O(1) average time complexity."
            ),
            "format": "code",
            "difficulty": "medium",
            "tags": ["dsa", "software-engineering"],
            "code_language": "python",
            "starter_code": (
                "class LRUCache:\n"
                "    def __init__(self, capacity: int) -> None:\n"
                "        pass\n\n"
                "    def get(self, key: int) -> int:\n"
                "        pass\n\n"
                "    def put(self, key: int, value: int) -> None:\n"
                "        pass\n"
            ),
            "allow_execution": False,
            "default_points": 20,
            "expected_answer": (
                "Combine a hash map with a doubly linked list (or OrderedDict) to achieve "
                "O(1) lookup, promotion, and least-recently-used eviction."
            ),
            "evaluation_rubric": (
                "- 10 pts: Correct O(1) get and put behavior with eviction\n"
                "- 5 pts: Handles capacity edge cases and existing key updates\n"
                "- 5 pts: Clean code structure and complexity explanation"
            ),
        },
        {
            "external_key": "sample-notebook-01",
            "title": "Pandas Revenue Aggregation",
            "prompt": (
                "Using the provided pandas DataFrame, remove duplicate `order_id` rows "
                "(keeping the latest timestamp) and compute total revenue per `region`."
            ),
            "format": "notebook",
            "difficulty": "hard",
            "tags": ["data-engineering", "python", "pandas"],
            "code_language": "python",
            "starter_code": (
                "import pandas as pd\n\n"
                "orders = pd.DataFrame([\n"
                "    {'order_id': 1, 'region': 'NA', 'amount': 120.0, 'ts': '2025-01-01T10:00:00Z'},\n"
                "    {'order_id': 1, 'region': 'NA', 'amount': 125.0, 'ts': '2025-01-01T10:05:00Z'},\n"
                "    {'order_id': 2, 'region': 'EU', 'amount': 80.0, 'ts': '2025-01-01T11:00:00Z'},\n"
                "])\n"
                "orders\n"
            ),
            "allow_execution": True,
            "default_points": 30,
            "expected_answer": (
                "Parse `ts` as datetime, sort by `ts`, deduplicate on `order_id` keeping the "
                "last row, then group by `region` summing `amount`."
            ),
            "evaluation_rubric": (
                "- 12 pts: Proper timestamp sorting and deduplication keeping latest record\n"
                "- 10 pts: Accurate groupby aggregation and clean output\n"
                "- 8 pts: Edge-case handling (nulls, timezone-aware timestamps, verification)"
            ),
        },
    ]
}


def _normalize_prompt(prompt: str) -> str:
    return " ".join((prompt or "").strip().lower().split())


def _derive_title(prompt: str) -> str:
    for line in (prompt or "").splitlines():
        cleaned = line.strip().lstrip("#").strip()
        if cleaned:
            return cleaned[:80]
    return "Untitled Question"


def _slugify_category(value: str) -> str:
    return re.sub(r"[\s_/]+", "-", value.strip().lower()).strip("-")


def _parse_answer_indices(raw_value: Any) -> tuple[list[int], str | None]:
    if raw_value is None:
        return [], "Missing required field 'answer_indices' (or 'answer_index') for MCQ"
    if isinstance(raw_value, bool):
        return [], "Invalid answer_index: boolean value is not allowed"
    if isinstance(raw_value, int):
        return [raw_value], None
    if isinstance(raw_value, str):
        tokens = [tok.strip() for tok in raw_value.split(",") if tok.strip()]
        if not tokens:
            return [], "Invalid answer_index: must specify at least one index"
        parsed: list[int] = []
        for tok in tokens:
            try:
                parsed.append(int(tok))
            except ValueError:
                return [], f"Invalid answer_index '{tok}': must be an integer"
        return sorted(set(parsed)), None
    if isinstance(raw_value, list):
        if not raw_value:
            return [], "Invalid answer_indices: MCQ must include at least one answer_index"
        parsed_list: list[int] = []
        for item in raw_value:
            if isinstance(item, bool):
                return [], "Invalid answer_index: boolean value is not allowed"
            if isinstance(item, int):
                parsed_list.append(item)
            elif isinstance(item, str) and item.strip():
                try:
                    parsed_list.append(int(item.strip()))
                except ValueError:
                    return [], f"Invalid answer_index '{item}': must be an integer"
            else:
                return [], f"Invalid answer_index '{item}': must be an integer"
        return sorted(set(parsed_list)), None
    return [], "Invalid answer_indices: must be an integer, list of integers, or comma-separated string"


def _extract_tags(raw: dict[str, Any]) -> tuple[list[str], list[str], str | None]:
    """Return (normalized_tags, raw_category_tokens, optional_error)."""
    tags: set[str] = set()
    category_tokens: list[str] = []

    raw_tags = raw.get("tags")
    if raw_tags is not None:
        if isinstance(raw_tags, str):
            for part in raw_tags.split(","):
                cleaned = part.strip().lower()
                if cleaned:
                    tags.add(cleaned)
        elif isinstance(raw_tags, list):
            for entry in raw_tags:
                if entry is None:
                    continue
                cleaned = str(entry).strip().lower()
                if cleaned:
                    tags.add(cleaned)
        else:
            return [], [], "Field 'tags' must be a list of strings"

    raw_category = raw.get("category")
    if raw_category is not None:
        if isinstance(raw_category, str):
            for part in raw_category.split(","):
                if part.strip():
                    category_tokens.append(part.strip().lower())
                    slug = _slugify_category(part)
                    if slug:
                        tags.add(slug)
        elif isinstance(raw_category, list):
            for entry in raw_category:
                if entry is None:
                    continue
                text = str(entry).strip()
                if text:
                    category_tokens.append(text.lower())
                    slug = _slugify_category(text)
                    if slug:
                        tags.add(slug)

    return sorted(tags), category_tokens, None


def _normalize_and_validate_item(raw: Any) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(raw, dict):
        return None, ["Item must be a JSON/YAML object"]

    errors: list[str] = []

    raw_prompt = raw.get("prompt")
    if raw_prompt is None or (isinstance(raw_prompt, str) and not raw_prompt.strip()):
        raw_prompt = raw.get("question")
    if not isinstance(raw_prompt, str) or not raw_prompt.strip():
        errors.append("Missing required field 'prompt'")
        prompt = ""
    else:
        prompt = raw_prompt.strip()

    raw_title = raw.get("title")
    if isinstance(raw_title, str) and raw_title.strip():
        title = raw_title.strip()
    elif prompt:
        title = _derive_title(prompt)
    else:
        title = ""

    raw_external_key = raw.get("external_key")
    external_key = (
        str(raw_external_key).strip() or None
        if raw_external_key is not None
        else None
    )

    tags, category_tokens, tag_err = _extract_tags(raw)
    if tag_err:
        errors.append(tag_err)

    # Determine format (canonical 'format' or legacy 'type')
    raw_fmt = raw.get("format")
    raw_legacy_type = raw.get("type")
    if raw_fmt is not None and str(raw_fmt).strip():
        fmt = str(raw_fmt).strip().lower()
    elif raw_legacy_type is not None and str(raw_legacy_type).strip():
        legacy_type = str(raw_legacy_type).strip().lower()
        if legacy_type in _LEGACY_MCQ_TYPES:
            fmt = "mcq"
        elif legacy_type in _LEGACY_CODE_TYPES:
            fmt = "code"
        elif legacy_type == "notebook":
            fmt = "notebook"
        elif legacy_type == "text":
            is_python_category = any("python" in tok for tok in category_tokens)
            fmt = "notebook" if is_python_category else "text"
        else:
            fmt = legacy_type
    else:
        fmt = ""
        errors.append("Missing required field 'format'")

    if fmt and fmt not in VALID_FORMATS:
        errors.append(
            f"Invalid format '{fmt}'; must be one of: {', '.join(sorted(VALID_FORMATS))}"
        )

    # Validate difficulty
    raw_diff = raw.get("difficulty")
    if raw_diff is None or not str(raw_diff).strip():
        difficulty = ""
        errors.append("Missing required field 'difficulty'")
    else:
        difficulty = str(raw_diff).strip().lower()
        if difficulty not in VALID_DIFFICULTIES:
            errors.append(
                f"Invalid difficulty '{difficulty}'; must be one of: {', '.join(sorted(VALID_DIFFICULTIES))}"
            )

    # Validate MCQ options & answer_indices
    options: list[str] = []
    answer_indices: list[int] = []
    if fmt == "mcq":
        raw_options = raw.get("options")
        option_count = 0
        if not isinstance(raw_options, list):
            errors.append("MCQ questions require 'options' as a list of at least 2 strings")
        else:
            option_count = len(raw_options)
            for opt_idx, opt in enumerate(raw_options):
                if isinstance(opt, (dict, list)):
                    errors.append(
                        f"MCQ option at index {opt_idx} must be a scalar string/value"
                    )
                elif opt is None or not str(opt).strip():
                    errors.append(
                        f"MCQ option at index {opt_idx} cannot be empty or null"
                    )
                else:
                    options.append(str(opt).strip())
            if option_count < 2:
                errors.append("MCQ questions require at least 2 non-empty options")

        raw_ans = (
            raw["answer_indices"]
            if "answer_indices" in raw and raw["answer_indices"] is not None
            else raw.get("answer_index")
        )
        parsed_indices, ans_err = _parse_answer_indices(raw_ans)
        if ans_err:
            errors.append(ans_err)
        else:
            answer_indices = parsed_indices
            for idx in answer_indices:
                if idx < 0 or idx >= option_count:
                    errors.append(
                        f"Invalid answer_index {idx}: out of range for {option_count} options"
                    )

    # Points validation
    raw_points = raw.get("default_points", 10)
    if raw_points is None:
        default_points = 10
    elif isinstance(raw_points, (bool, float)):
        default_points = 10
        errors.append("Field 'default_points' must be a positive integer")
    else:
        try:
            default_points = int(raw_points)
            if default_points <= 0:
                errors.append("Field 'default_points' must be a positive integer")
        except (TypeError, ValueError):
            default_points = 10
            errors.append("Field 'default_points' must be a positive integer")

    # Code & notebook fields
    raw_lang = raw.get("code_language")
    if raw_lang is not None and str(raw_lang).strip():
        code_language: str | None = str(raw_lang).strip().lower()
    elif fmt == "notebook":
        code_language = "python"
    else:
        code_language = None

    starter_code = raw.get("starter_code")
    if starter_code is not None and not isinstance(starter_code, (str, list, dict)):
        errors.append("Field 'starter_code' must be a string or list of starter cells")

    raw_allow_exec = raw.get("allow_execution")
    if raw_allow_exec is None:
        allow_execution = fmt == "notebook"
    elif isinstance(raw_allow_exec, bool):
        allow_execution = raw_allow_exec
    else:
        allow_execution = str(raw_allow_exec).strip().lower() in {"1", "true", "yes"}

    explanation = str(raw.get("explanation") or "").strip()
    expected_answer = str(raw.get("expected_answer") or "").strip() or explanation
    evaluation_rubric = str(raw.get("evaluation_rubric") or "").strip() or explanation

    raw_active = raw.get("active", True)
    if isinstance(raw_active, bool):
        active = raw_active
    else:
        active = str(raw_active).strip().lower() not in {"0", "false", "no"}

    if errors:
        return None, errors

    normalized: dict[str, Any] = {
        "external_key": external_key,
        "title": title,
        "prompt": prompt,
        "format": fmt,
        "difficulty": difficulty,
        "options": options,
        "answer_indices": answer_indices,
        "code_language": code_language,
        "starter_code": starter_code,
        "allow_execution": allow_execution,
        "expected_answer": expected_answer,
        "evaluation_rubric": evaluation_rubric,
        "default_points": default_points,
        "active": active,
        "tags": tags,
    }
    return normalized, []


def parse_payload(raw_bytes: bytes, filename: str) -> list[dict[str, Any]]:
    """Parse canonical `{"questions": [...]}` YAML/JSON or legacy top-level `[...]` array."""
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Uploaded file must be UTF-8 encoded: {exc}") from exc

    if not text.strip():
        raise ValueError("Uploaded file is empty")

    suffix = Path(filename or "").suffix.lower()
    if suffix == ".json":
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON syntax: {exc}") from exc
    elif suffix in {".yaml", ".yml"}:
        try:
            parsed = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise ValueError(f"Invalid YAML syntax: {exc}") from exc
    else:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            try:
                parsed = yaml.safe_load(text)
            except yaml.YAMLError as exc:
                raise ValueError(f"Could not parse file as JSON or YAML: {exc}") from exc

    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict) and isinstance(parsed.get("questions"), list):
        return parsed["questions"]

    raise ValueError(
        "Payload must be an object containing a 'questions' list or a top-level list of questions"
    )


def preview_import(
    repo: InterviewRepository, raw_bytes: bytes, filename: str
) -> dict[str, Any]:
    """Validate and preview an import payload without modifying the database."""
    raw_items = parse_payload(raw_bytes, filename)
    existing_questions = repo.list_questions()

    by_key: dict[str, int] = {
        q["external_key"]: q["id"]
        for q in existing_questions
        if q.get("external_key")
    }
    by_prompt: dict[str, int] = {
        _normalize_prompt(q["prompt"]): q["id"]
        for q in existing_questions
        if q.get("prompt")
    }

    batch_keys: set[str] = set()
    batch_prompts: set[str] = set()

    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    valid_count = 0
    new_count = 0
    duplicate_count = 0
    invalid_count = 0

    for idx, raw in enumerate(raw_items):
        normalized, item_errors = _normalize_and_validate_item(raw)
        if item_errors or normalized is None:
            invalid_count += 1
            err_msg = "; ".join(item_errors)
            raw_key = raw.get("external_key") if isinstance(raw, dict) else None
            raw_title = (
                (raw.get("title") or raw.get("question") or raw.get("prompt"))
                if isinstance(raw, dict)
                else None
            )
            errors.append(
                {
                    "index": idx,
                    "external_key": raw_key,
                    "title": str(raw_title)[:80] if raw_title else "",
                    "error": err_msg,
                }
            )
            items.append(
                {
                    "index": idx,
                    "status": "invalid",
                    "match_reason": None,
                    "existing_id": None,
                    "question": None,
                    "errors": item_errors,
                }
            )
            continue

        valid_count += 1
        ek = normalized["external_key"]
        norm_prompt = _normalize_prompt(normalized["prompt"])

        existing_id: int | None = None
        match_reason: str | None = None
        if ek and ek in by_key:
            existing_id = by_key[ek]
            match_reason = "external_key"
        elif norm_prompt in by_prompt:
            existing_id = by_prompt[norm_prompt]
            match_reason = "prompt"
        elif ek and ek in batch_keys:
            match_reason = "in_batch_external_key"
        elif norm_prompt in batch_prompts:
            match_reason = "in_batch_prompt"

        if match_reason is not None:
            duplicate_count += 1
            status = "duplicate"
        else:
            new_count += 1
            status = "new"
            if ek:
                batch_keys.add(ek)
            batch_prompts.add(norm_prompt)

        items.append(
            {
                "index": idx,
                "status": status,
                "match_reason": match_reason,
                "existing_id": existing_id,
                "question": normalized,
                "errors": [],
            }
        )

    return {
        "valid_count": valid_count,
        "new_count": new_count,
        "duplicate_count": duplicate_count,
        "invalid_count": invalid_count,
        "items": items,
        "errors": errors,
    }


def commit_import(
    repo: InterviewRepository,
    raw_bytes: bytes,
    filename: str,
    duplicate_strategy: str = "skip",
    skip_invalid: bool = False,
) -> dict[str, Any]:
    """Commit validated questions into the catalog database."""
    strategy = (duplicate_strategy or "skip").strip().lower()
    if strategy not in VALID_DUPLICATE_STRATEGIES:
        raise ValueError(
            f"Invalid duplicate_strategy '{duplicate_strategy}'; must be 'skip' or 'overwrite'"
        )

    preview = preview_import(repo, raw_bytes, filename)
    if preview["invalid_count"] > 0 and not skip_invalid:
        return {
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "errors": preview["errors"],
        }

    existing_questions = repo.list_questions()
    by_key: dict[str, dict[str, Any]] = {
        q["external_key"]: q for q in existing_questions if q.get("external_key")
    }
    by_prompt: dict[str, dict[str, Any]] = {
        _normalize_prompt(q["prompt"]): q for q in existing_questions if q.get("prompt")
    }

    created = 0
    updated = 0
    skipped = 0

    for item in preview["items"]:
        if item["status"] == "invalid" or item["question"] is None:
            continue

        question = item["question"]
        ek = question["external_key"]
        norm_prompt = _normalize_prompt(question["prompt"])

        existing: dict[str, Any] | None = None
        if ek and ek in by_key:
            existing = by_key[ek]
        elif norm_prompt in by_prompt:
            existing = by_prompt[norm_prompt]

        if existing is not None:
            if strategy == "skip":
                skipped += 1
                continue

            update_payload = dict(question)
            if update_payload["external_key"] is None and existing.get("external_key"):
                update_payload["external_key"] = existing["external_key"]

            old_key = existing.get("external_key")
            old_prompt = _normalize_prompt(existing.get("prompt", ""))
            saved = repo.update_question(existing["id"], update_payload)
            if saved is not None:
                if old_key and old_key != saved.get("external_key"):
                    by_key.pop(old_key, None)
                if old_prompt and old_prompt != _normalize_prompt(saved["prompt"]):
                    by_prompt.pop(old_prompt, None)
                if saved.get("external_key"):
                    by_key[saved["external_key"]] = saved
                by_prompt[_normalize_prompt(saved["prompt"])] = saved
                updated += 1
        else:
            saved = repo.create_question(question)
            if saved.get("external_key"):
                by_key[saved["external_key"]] = saved
            by_prompt[_normalize_prompt(saved["prompt"])] = saved
            created += 1

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": preview["errors"],
    }


def _question_to_export_dict(q: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if q.get("external_key"):
        out["external_key"] = q["external_key"]
    out["title"] = q.get("title", "")
    out["prompt"] = q.get("prompt", "")
    out["format"] = q["format"]
    out["difficulty"] = q["difficulty"]
    out["tags"] = list(q.get("tags") or [])
    out["default_points"] = int(q.get("effective_points", q.get("default_points", 10)))

    if q["format"] == "mcq":
        out["options"] = list(q.get("options") or [])
        out["answer_indices"] = list(q.get("answer_indices") or [])
    if q.get("code_language"):
        out["code_language"] = q["code_language"]
    if q.get("starter_code"):
        out["starter_code"] = q["starter_code"]
    if q["format"] in {"code", "notebook"} or q.get("allow_execution"):
        out["allow_execution"] = bool(q.get("allow_execution", False))

    expected = q.get("effective_expected_answer", q.get("expected_answer", ""))
    rubric = q.get("effective_rubric", q.get("evaluation_rubric", ""))
    out["expected_answer"] = expected or ""
    out["evaluation_rubric"] = rubric or ""
    out["active"] = bool(q.get("active", True))
    return out


def _serialize_export(payload: dict[str, Any], fmt: str) -> tuple[str, str]:
    normalized_fmt = (fmt or "yaml").strip().lower()
    if normalized_fmt in {"yaml", "yml"}:
        content = yaml.safe_dump(
            payload, sort_keys=False, allow_unicode=True, width=100
        )
        return content, "application/x-yaml"
    if normalized_fmt == "json":
        content = json.dumps(payload, indent=2, ensure_ascii=False)
        return content, "application/json"
    raise ValueError(f"Unsupported export format '{fmt}'; must be 'yaml' or 'json'")


def export_questions(
    repo: InterviewRepository,
    fmt: str = "yaml",
    tags: list[str] | None = None,
    template_id: int | None = None,
) -> tuple[str, str]:
    """Export questions (optionally filtered by tags or resolved from a template) as YAML or JSON."""
    payload: dict[str, Any] = {}
    if template_id is not None:
        tpl = repo.get_template(template_id)
        if tpl is None:
            raise ValueError(f"Template {template_id} not found")
        questions = repo.resolve_template_questions(template_id)
        payload["template"] = {
            "slug": tpl["slug"],
            "name": tpl["name"],
            "role_title": tpl["role_title"],
            "selection_mode": tpl["selection_mode"],
            "timer_minutes": tpl["timer_minutes"],
            "open_book_policy": tpl["open_book_policy"],
            "summary_dimensions": tpl["summary_dimensions"],
        }
    else:
        questions = repo.list_questions(tags=tags)

    payload["questions"] = [_question_to_export_dict(q) for q in questions]
    return _serialize_export(payload, fmt)


def get_sample_import_template(fmt: str = "yaml") -> tuple[str, str]:
    """Return a clean sample import file (YAML or JSON) demonstrating all 4 question formats."""
    normalized_fmt = (fmt or "yaml").strip().lower()
    if normalized_fmt not in {"yaml", "yml", "json"}:
        raise ValueError(f"Unsupported sample format '{fmt}'; must be 'yaml' or 'json'")

    if normalized_fmt in {"yaml", "yml"}:
        starter_yaml = _EXAMPLES_DIR / "starter_questions.yaml"
        if starter_yaml.exists():
            return starter_yaml.read_text(encoding="utf-8"), "application/x-yaml"
        return _serialize_export(_SAMPLE_TEMPLATE_DATA, "yaml")

    starter_json = _EXAMPLES_DIR / "starter_questions.json"
    if starter_json.exists():
        return starter_json.read_text(encoding="utf-8"), "application/json"
    return _serialize_export(_SAMPLE_TEMPLATE_DATA, "json")
