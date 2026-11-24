"""Pluggable notification adapters: SMTP email, Slack, Microsoft Teams, and signed webhooks."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import smtplib
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any

import httpx

from backend.config import Settings
from backend.services.delivery.storage import StorageResult

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT_SECONDS = 15.0
_HEADER_UNSAFE_RE = re.compile(r"[\r\n]+")


def _clean_header(value: str) -> str:
    return _HEADER_UNSAFE_RE.sub(" ", value or "").strip()


@dataclass
class NotifyResult:
    """Outcome of dispatching a report notification to a single sink."""

    sink: str
    ok: bool
    detail: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "sink": self.sink,
            "ok": self.ok,
            "detail": self.detail,
            "error": self.error,
        }


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _format_num(value: float) -> str:
    if value.is_integer():
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _build_report_context(
    candidate_name: str,
    results: dict[str, Any],
    storage_results: list[StorageResult],
    app_title: str,
) -> dict[str, Any]:
    candidate = str(results.get("candidate_name") or candidate_name or "Candidate").strip()
    role_title = str(results.get("role_title") or "").strip()
    template_name = str(results.get("template_name") or "").strip()

    final_score = _safe_float(results.get("final_score"), 0.0)
    max_score = _safe_float(results.get("max_score"), 0.0)
    raw_pct = results.get("score_percentage")
    if raw_pct is not None and str(raw_pct).strip() != "":
        score_pct = _safe_float(raw_pct, 0.0)
    else:
        score_pct = (final_score / max_score * 100.0) if max_score > 0 else 0.0

    summary_obj = results.get("summary")
    overall_summary = ""
    recommendation = ""
    if isinstance(summary_obj, dict):
        overall_summary = str(
            summary_obj.get("overall_feedback")
            or summary_obj.get("overall_summary")
            or summary_obj.get("summary")
            or ""
        ).strip()
        recommendation = str(summary_obj.get("recommendation") or "").strip()
    elif isinstance(summary_obj, str):
        overall_summary = summary_obj.strip()
    if not overall_summary:
        fallback_summary = (
            results.get("overall_feedback") or results.get("overall_summary") or ""
        )
        overall_summary = str(fallback_summary).strip()

    healthy_links: list[dict[str, str]] = []
    for sr in storage_results:
        if not sr.ok:
            continue
        entry: dict[str, str] = {"sink": sr.sink}
        if sr.url:
            entry["url"] = sr.url
        if sr.uri:
            entry["uri"] = sr.uri
        if "url" in entry or "uri" in entry:
            healthy_links.append(entry)

    score_label = f"{_format_num(final_score)}/{_format_num(max_score)} ({score_pct:.1f}%)"
    return {
        "app_title": app_title or "BigBank",
        "candidate": candidate,
        "role_title": role_title,
        "template_name": template_name,
        "final_score": final_score,
        "max_score": max_score,
        "score_percentage": score_pct,
        "score_label": score_label,
        "overall_summary": overall_summary,
        "recommendation": recommendation,
        "storage_links": healthy_links,
    }


def _format_storage_lines(storage_links: list[dict[str, str]]) -> list[str]:
    lines: list[str] = []
    for item in storage_links:
        sink = item["sink"].upper()
        url = item.get("url")
        uri = item.get("uri")
        if url and uri and url != uri:
            lines.append(f"- {sink}: {url} ({uri})")
        elif url:
            lines.append(f"- {sink}: {url}")
        elif uri:
            lines.append(f"- {sink}: {uri}")
    return lines


class SMTPNotifier:
    """Send evaluation summary email with the PDF report attached directly."""

    sink_name = "smtp"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _validate(self) -> tuple[list[str], str | None]:
        if not self.settings.smtp_host.strip():
            return [], "SMTP_HOST is not configured."
        if not self.settings.smtp_from.strip():
            return [], "SMTP_FROM is not configured."
        recipients = [
            addr.strip()
            for addr in self.settings.smtp_to.split(",")
            if addr.strip()
        ]
        if not recipients:
            return [], "SMTP_TO is not configured."
        return recipients, None

    def _open_server(self):
        host = self.settings.smtp_host.strip()
        port = int(self.settings.smtp_port or 587)
        if port == 465 and self.settings.smtp_use_tls:
            return smtplib.SMTP_SSL(
                host, port, timeout=15, context=ssl.create_default_context()
            )
        return smtplib.SMTP(host, port, timeout=15)

    def _prepare_session(self, server: Any) -> None:
        port = int(self.settings.smtp_port or 587)
        if self.settings.smtp_use_tls and port != 465:
            server.starttls(context=ssl.create_default_context())
        if self.settings.smtp_user.strip():
            server.login(self.settings.smtp_user.strip(), self.settings.smtp_password)

    async def notify(
        self,
        candidate_name: str,
        results: dict[str, Any],
        pdf_bytes: bytes,
        pdf_filename: str,
        storage_results: list[StorageResult],
    ) -> NotifyResult:
        recipients, err = self._validate()
        if err:
            return NotifyResult(sink=self.sink_name, ok=False, error=err)

        ctx = _build_report_context(
            candidate_name, results, storage_results, self.settings.app_title
        )

        role_suffix = f" ({ctx['role_title']})" if ctx["role_title"] else ""
        subject = (
            f"[{ctx['app_title']}] Interview Report: "
            f"{ctx['candidate']}{role_suffix} - {ctx['score_label']}"
        )

        body_lines = [
            f"Interview evaluation report for {ctx['candidate']}.",
            "",
            f"Candidate: {ctx['candidate']}",
        ]
        if ctx["role_title"]:
            body_lines.append(f"Role: {ctx['role_title']}")
        if ctx["template_name"]:
            body_lines.append(f"Template: {ctx['template_name']}")
        body_lines.append(f"Score: {ctx['score_label']}")
        if ctx["recommendation"]:
            body_lines.append(f"Recommendation: {ctx['recommendation']}")
        if ctx["overall_summary"]:
            body_lines.extend(["", "Summary:", ctx["overall_summary"]])

        storage_lines = _format_storage_lines(ctx["storage_links"])
        if storage_lines:
            body_lines.extend(["", "Stored Artifacts:", *storage_lines])

        msg = EmailMessage()
        msg["Subject"] = _clean_header(subject)
        msg["From"] = _clean_header(self.settings.smtp_from)
        msg["To"] = _clean_header(", ".join(recipients))
        msg.set_content("\n".join(body_lines))

        if pdf_bytes:
            msg.add_attachment(
                pdf_bytes,
                maintype="application",
                subtype="pdf",
                filename=pdf_filename,
            )

        def _send() -> None:
            with self._open_server() as server:
                self._prepare_session(server)
                server.send_message(msg)

        try:
            await asyncio.to_thread(_send)
            return NotifyResult(
                sink=self.sink_name,
                ok=True,
                detail=f"Sent email to {', '.join(recipients)}",
            )
        except Exception as exc:
            logger.exception("SMTP notification failed")
            return NotifyResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        _, err = self._validate()
        if err:
            return {"sink": self.sink_name, "ok": False, "detail": err}

        def _probe() -> None:
            with self._open_server() as server:
                self._prepare_session(server)
                server.noop()

        try:
            await asyncio.to_thread(_probe)
            return {
                "sink": self.sink_name,
                "ok": True,
                "detail": (
                    f"Connected to SMTP server "
                    f"{self.settings.smtp_host.strip()}:{self.settings.smtp_port}"
                ),
            }
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


class SlackNotifier:
    """Dispatch notifications via Slack Bot API (with optional PDF upload) or Incoming Webhook."""

    sink_name = "slack"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def _use_bot_api(self) -> bool:
        return bool(
            self.settings.slack_bot_token.strip()
            and self.settings.slack_channel_id.strip()
        )

    def _build_blocks_and_text(self, ctx: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
        role_part = f" | {ctx['role_title']}" if ctx["role_title"] else ""
        fallback_text = (
            f"Interview Completed: {ctx['candidate']}{role_part} — Score: {ctx['score_label']}"
        )

        fields = [
            {"type": "mrkdwn", "text": f"*Candidate:*\n{ctx['candidate']}"},
            {"type": "mrkdwn", "text": f"*Score:*\n{ctx['score_label']}"},
        ]
        if ctx["role_title"]:
            fields.append({"type": "mrkdwn", "text": f"*Role:*\n{ctx['role_title']}"})
        if ctx["template_name"]:
            fields.append({"type": "mrkdwn", "text": f"*Template:*\n{ctx['template_name']}"})

        blocks: list[dict[str, Any]] = [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": f"Interview Report: {ctx['candidate']}"[:150],
                },
            },
            {"type": "section", "fields": fields},
        ]

        if ctx["overall_summary"]:
            blocks.append(
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Summary:*\n{ctx['overall_summary'][:2500]}",
                    },
                }
            )

        storage_lines = _format_storage_lines(ctx["storage_links"])
        if storage_lines:
            blocks.append(
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "*Stored Artifacts:*\n" + "\n".join(storage_lines),
                    },
                }
            )

        return fallback_text, blocks

    async def _send_via_bot_api(
        self,
        client: httpx.AsyncClient,
        fallback_text: str,
        blocks: list[dict[str, Any]],
        pdf_bytes: bytes,
        pdf_filename: str,
    ) -> NotifyResult:
        token = self.settings.slack_bot_token.strip()
        channel = self.settings.slack_channel_id.strip()
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.post(
            "https://slack.com/api/chat.postMessage",
            headers=headers,
            json={
                "channel": channel,
                "text": fallback_text,
                "blocks": blocks,
            },
        )
        if not (200 <= resp.status_code < 300):
            return NotifyResult(
                sink=self.sink_name,
                ok=False,
                error=f"Slack API HTTP {resp.status_code}: {resp.text[:300]}",
            )
        data = resp.json()
        if not data.get("ok"):
            return NotifyResult(
                sink=self.sink_name,
                ok=False,
                error=f"Slack chat.postMessage error: {data.get('error', 'unknown')}",
            )

        detail = f"Posted to Slack channel {channel}"
        if pdf_bytes:
            try:
                up_resp = await client.post(
                    "https://slack.com/api/files.getUploadURLExternal",
                    headers=headers,
                    data={"filename": pdf_filename, "length": str(len(pdf_bytes))},
                )
                up_data = up_resp.json() if 200 <= up_resp.status_code < 300 else {}
                upload_url = up_data.get("upload_url")
                file_id = up_data.get("file_id")
                if up_data.get("ok") and upload_url and file_id:
                    put_resp = await client.post(
                        upload_url,
                        content=pdf_bytes,
                        headers={"Content-Type": "application/pdf"},
                    )
                    if 200 <= put_resp.status_code < 300:
                        comp_resp = await client.post(
                            "https://slack.com/api/files.completeUploadExternal",
                            headers=headers,
                            json={
                                "files": [{"id": file_id, "title": pdf_filename}],
                                "channel_id": channel,
                            },
                        )
                        if (
                            200 <= comp_resp.status_code < 300
                            and comp_resp.json().get("ok")
                        ):
                            detail += " (PDF uploaded)"
            except Exception as exc:
                logger.warning("Slack PDF file upload skipped after message post: %s", exc)

        return NotifyResult(sink=self.sink_name, ok=True, detail=detail)

    async def notify(
        self,
        candidate_name: str,
        results: dict[str, Any],
        pdf_bytes: bytes,
        pdf_filename: str,
        storage_results: list[StorageResult],
    ) -> NotifyResult:
        ctx = _build_report_context(
            candidate_name, results, storage_results, self.settings.app_title
        )
        fallback_text, blocks = self._build_blocks_and_text(ctx)

        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                if self._use_bot_api:
                    return await self._send_via_bot_api(
                        client, fallback_text, blocks, pdf_bytes, pdf_filename
                    )

                webhook_url = self.settings.slack_webhook_url.strip()
                if not webhook_url:
                    return NotifyResult(
                        sink=self.sink_name,
                        ok=False,
                        error="Neither SLACK_WEBHOOK_URL nor SLACK_BOT_TOKEN+SLACK_CHANNEL_ID is configured.",
                    )

                resp = await client.post(
                    webhook_url,
                    json={"text": fallback_text, "blocks": blocks},
                )
                if 200 <= resp.status_code < 300:
                    return NotifyResult(
                        sink=self.sink_name,
                        ok=True,
                        detail=f"Slack webhook delivered (HTTP {resp.status_code})",
                    )
                return NotifyResult(
                    sink=self.sink_name,
                    ok=False,
                    error=f"Slack webhook HTTP {resp.status_code}: {resp.text[:300]}",
                )
        except Exception as exc:
            logger.exception("Slack notification failed")
            return NotifyResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                if self._use_bot_api:
                    resp = await client.post(
                        "https://slack.com/api/auth.test",
                        headers={
                            "Authorization": f"Bearer {self.settings.slack_bot_token.strip()}"
                        },
                    )
                    if 200 <= resp.status_code < 300:
                        data = resp.json()
                        if data.get("ok"):
                            return {
                                "sink": self.sink_name,
                                "ok": True,
                                "detail": "Slack bot token verified via auth.test",
                            }
                        return {
                            "sink": self.sink_name,
                            "ok": False,
                            "detail": f"Slack auth.test failed: {data.get('error', 'unknown')}",
                        }
                    return {
                        "sink": self.sink_name,
                        "ok": False,
                        "detail": f"Slack auth.test failed (HTTP {resp.status_code})",
                    }

                webhook_url = self.settings.slack_webhook_url.strip()
                if not webhook_url:
                    return {
                        "sink": self.sink_name,
                        "ok": False,
                        "detail": "Slack webhook URL or bot token is not configured.",
                    }

                resp = await client.post(
                    webhook_url,
                    json={
                        "text": f"[{self.settings.app_title}] Test notification from delivery settings."
                    },
                )
                if 200 <= resp.status_code < 300:
                    return {
                        "sink": self.sink_name,
                        "ok": True,
                        "detail": f"Slack webhook accepted test message (HTTP {resp.status_code})",
                    }
                return {
                    "sink": self.sink_name,
                    "ok": False,
                    "detail": f"Slack webhook returned HTTP {resp.status_code}: {resp.text[:200]}",
                }
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


class TeamsNotifier:
    """Dispatch Adaptive Card notifications to a Microsoft Teams Incoming Webhook / Workflow."""

    sink_name = "teams"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _build_card(self, ctx: dict[str, Any]) -> dict[str, Any]:
        facts = [
            {"title": "Candidate", "value": ctx["candidate"]},
            {"title": "Score", "value": ctx["score_label"]},
        ]
        if ctx["role_title"]:
            facts.append({"title": "Role", "value": ctx["role_title"]})
        if ctx["template_name"]:
            facts.append({"title": "Template", "value": ctx["template_name"]})
        if ctx["recommendation"]:
            facts.append({"title": "Recommendation", "value": ctx["recommendation"]})

        body: list[dict[str, Any]] = [
            {
                "type": "TextBlock",
                "size": "Large",
                "weight": "Bolder",
                "text": f"Interview Report: {ctx['candidate']}",
            },
            {"type": "FactSet", "facts": facts},
        ]
        if ctx["overall_summary"]:
            body.append(
                {
                    "type": "TextBlock",
                    "wrap": True,
                    "text": ctx["overall_summary"][:2500],
                }
            )
        storage_lines = _format_storage_lines(ctx["storage_links"])
        if storage_lines:
            body.append(
                {
                    "type": "TextBlock",
                    "wrap": True,
                    "text": "**Stored Artifacts**\n" + "\n".join(storage_lines),
                }
            )

        return {
            "type": "message",
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard",
                        "version": "1.4",
                        "body": body,
                    },
                }
            ],
        }

    async def notify(
        self,
        candidate_name: str,
        results: dict[str, Any],
        pdf_bytes: bytes,
        pdf_filename: str,
        storage_results: list[StorageResult],
    ) -> NotifyResult:
        webhook_url = self.settings.teams_webhook_url.strip()
        if not webhook_url:
            return NotifyResult(
                sink=self.sink_name,
                ok=False,
                error="TEAMS_WEBHOOK_URL is not configured.",
            )

        ctx = _build_report_context(
            candidate_name, results, storage_results, self.settings.app_title
        )
        payload = self._build_card(ctx)

        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                resp = await client.post(webhook_url, json=payload)
            if 200 <= resp.status_code < 300:
                return NotifyResult(
                    sink=self.sink_name,
                    ok=True,
                    detail=f"Teams webhook delivered (HTTP {resp.status_code})",
                )
            return NotifyResult(
                sink=self.sink_name,
                ok=False,
                error=f"Teams webhook HTTP {resp.status_code}: {resp.text[:300]}",
            )
        except Exception as exc:
            logger.exception("Teams notification failed")
            return NotifyResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        webhook_url = self.settings.teams_webhook_url.strip()
        if not webhook_url:
            return {
                "sink": self.sink_name,
                "ok": False,
                "detail": "TEAMS_WEBHOOK_URL is not configured.",
            }
        test_card = {
            "type": "message",
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard",
                        "version": "1.4",
                        "body": [
                            {
                                "type": "TextBlock",
                                "weight": "Bolder",
                                "text": f"[{self.settings.app_title}] Test notification.",
                            }
                        ],
                    },
                }
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                resp = await client.post(webhook_url, json=test_card)
            if 200 <= resp.status_code < 300:
                return {
                    "sink": self.sink_name,
                    "ok": True,
                    "detail": f"Teams webhook accepted test card (HTTP {resp.status_code})",
                }
            return {
                "sink": self.sink_name,
                "ok": False,
                "detail": f"Teams webhook returned HTTP {resp.status_code}: {resp.text[:200]}",
            }
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


class WebhookNotifier:
    """POST JSON evaluation payloads with optional HMAC-SHA256 signing and base64 PDF."""

    sink_name = "webhook"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _build_headers(self, body_bytes: bytes) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        secret = self.settings.webhook_secret.strip()
        if secret:
            sig = hmac.new(
                secret.encode("utf-8"),
                body_bytes,
                hashlib.sha256,
            ).hexdigest()
            headers["X-Signature-256"] = f"sha256={sig}"
        return headers

    async def notify(
        self,
        candidate_name: str,
        results: dict[str, Any],
        pdf_bytes: bytes,
        pdf_filename: str,
        storage_results: list[StorageResult],
    ) -> NotifyResult:
        url = self.settings.webhook_url.strip()
        if not url:
            return NotifyResult(
                sink=self.sink_name,
                ok=False,
                error="WEBHOOK_URL is not configured.",
            )

        ctx = _build_report_context(
            candidate_name, results, storage_results, self.settings.app_title
        )
        payload: dict[str, Any] = {
            "event": "interview.completed",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "candidate_name": ctx["candidate"],
            "role_title": ctx["role_title"],
            "template_name": ctx["template_name"],
            "final_score": ctx["final_score"],
            "max_score": ctx["max_score"],
            "score_percentage": round(ctx["score_percentage"], 2),
            "results": results,
            "storage": [sr.to_dict() for sr in storage_results],
        }
        if self.settings.webhook_include_pdf_base64 and pdf_bytes:
            payload["pdf_filename"] = pdf_filename
            payload["pdf_base64"] = base64.b64encode(pdf_bytes).decode("ascii")

        body_bytes = json.dumps(payload, default=str).encode("utf-8")
        headers = self._build_headers(body_bytes)

        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, content=body_bytes, headers=headers)
            if 200 <= resp.status_code < 300:
                return NotifyResult(
                    sink=self.sink_name,
                    ok=True,
                    detail=f"Webhook delivered (HTTP {resp.status_code})",
                )
            return NotifyResult(
                sink=self.sink_name,
                ok=False,
                error=f"Webhook HTTP {resp.status_code}: {resp.text[:300]}",
            )
        except Exception as exc:
            logger.exception("Webhook notification failed")
            return NotifyResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        url = self.settings.webhook_url.strip()
        if not url:
            return {
                "sink": self.sink_name,
                "ok": False,
                "detail": "WEBHOOK_URL is not configured.",
            }
        payload = {
            "event": "interview.test",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "app_title": self.settings.app_title,
        }
        body_bytes = json.dumps(payload).encode("utf-8")
        headers = self._build_headers(body_bytes)
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, content=body_bytes, headers=headers)
            if 200 <= resp.status_code < 300:
                return {
                    "sink": self.sink_name,
                    "ok": True,
                    "detail": f"Webhook accepted test payload (HTTP {resp.status_code})",
                }
            return {
                "sink": self.sink_name,
                "ok": False,
                "detail": f"Webhook returned HTTP {resp.status_code}: {resp.text[:200]}",
            }
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


NOTIFY_ADAPTER_MAP = {
    "smtp": SMTPNotifier,
    "slack": SlackNotifier,
    "teams": TeamsNotifier,
    "webhook": WebhookNotifier,
}


def build_notify_adapter(sink_name: str, settings: Settings) -> Any | None:
    cleaned = (sink_name or "").strip().lower()
    adapter_cls = NOTIFY_ADAPTER_MAP.get(cleaned)
    if adapter_cls is None:
        return None
    return adapter_cls(settings)
