"""Shared application context and authentication helpers for FastAPI routers."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import Request

from backend.config import Settings
from backend.db.database import DatabaseManager
from backend.db.repository import InterviewRepository
from backend.services.notebook_kernel import NotebookKernelManager

ADMIN_TOKEN_TTL_SECONDS = 86_400  # 24 hours
CANDIDATE_TOKEN_DEFAULT_TTL_SECONDS = 86_400  # 24 hours


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(encoded: str) -> bytes:
    padding = "=" * (-len(encoded) % 4)
    return base64.urlsafe_b64decode(encoded + padding)


class AppContext:
    """Per-app runtime container holding settings, database, repo, kernel manager, and sessions."""

    def __init__(
        self,
        settings: Settings,
        db: DatabaseManager,
        repo: InterviewRepository,
        kernel_manager: NotebookKernelManager,
        env_path: Path | None = None,
    ) -> None:
        self.settings = settings
        self.db = db
        self.repo = repo
        self.kernel_manager = kernel_manager
        self.env_path = env_path
        self.active_sessions: dict[str, dict[str, Any]] = {}
        self._signing_secret: bytes = secrets.token_bytes(32)
        self._session_signing_secret: bytes = self._derive_session_secret(settings)

    @staticmethod
    def _derive_session_secret(settings: Settings) -> bytes:
        """Derive a deterministic HMAC key when a deployment secret exists (survives serverless cold starts)."""
        seed_material = (
            os.environ.get("SESSION_SECRET", "").strip()
            or (settings.admin_password or "").strip()
            or (settings.access_code or "").strip()
            or (settings.llm_api_key or "").strip()
        )
        if seed_material:
            return hashlib.sha256(
                f"candidate-session-v1:{seed_material}".encode("utf-8")
            ).digest()
        return secrets.token_bytes(32)

    def _password_digest(self) -> str:
        return hashlib.sha256(
            (self.settings.admin_password or "").encode("utf-8")
        ).hexdigest()[:24]

    def issue_admin_token(self) -> str:
        """Issue an HMAC-SHA256 signed bearer token bound to the active ADMIN_PASSWORD."""
        now = int(time.time())
        payload = {
            "sub": "admin",
            "iat": now,
            "exp": now + ADMIN_TOKEN_TTL_SECONDS,
            "pw": self._password_digest(),
        }
        payload_b64 = _b64url_encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        )
        sig = hmac.new(
            self._signing_secret, payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        return f"{payload_b64}.{_b64url_encode(sig)}"

    def verify_admin_token(self, token: str | None) -> bool:
        """Verify admin token signature, expiration, and password binding."""
        if not token or "." not in token:
            return False
        parts = token.split(".", 1)
        if len(parts) != 2:
            return False
        payload_b64, sig_b64 = parts
        try:
            expected_sig = hmac.new(
                self._signing_secret, payload_b64.encode("ascii"), hashlib.sha256
            ).digest()
            provided_sig = _b64url_decode(sig_b64)
            if not hmac.compare_digest(expected_sig, provided_sig):
                return False
            payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        except Exception:
            return False

        if not isinstance(payload, dict) or payload.get("sub") != "admin":
            return False
        if int(payload.get("exp", 0)) < int(time.time()):
            return False
        if not hmac.compare_digest(str(payload.get("pw", "")), self._password_digest()):
            return False
        return True

    def issue_candidate_token(
        self,
        *,
        session_id: str,
        template_slug: str,
        candidate_name: str,
        candidate_email: str | None = None,
        allow_code_execution: bool = True,
        allow_package_install: bool = False,
        open_book_policy: str = "none",
        timer_minutes: int = 45,
    ) -> str:
        """Issue an HMAC-SHA256 signed candidate session token encoding execution permissions."""
        now = int(time.time())
        ttl = max(int(timer_minutes or 45) * 60 + 3600, CANDIDATE_TOKEN_DEFAULT_TTL_SECONDS)
        payload = {
            "sub": "candidate",
            "session_id": session_id,
            "template_slug": template_slug,
            "candidate_name": candidate_name,
            "candidate_email": candidate_email,
            "allow_code_execution": bool(allow_code_execution),
            "allow_package_install": bool(allow_package_install),
            "open_book_policy": (open_book_policy or "none").strip().lower(),
            "issued_at": now,
            "exp": now + ttl,
        }
        payload_b64 = _b64url_encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        )
        sig = hmac.new(
            self._session_signing_secret, payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        return f"{payload_b64}.{_b64url_encode(sig)}"

    def verify_candidate_token(self, token: str | None) -> dict[str, Any] | None:
        """Verify HMAC-SHA256 signature and expiration of a candidate session token."""
        if not token or not isinstance(token, str) or "." not in token:
            return None
        parts = token.split(".", 1)
        if len(parts) != 2 or not parts[0] or not parts[1]:
            return None
        payload_b64, sig_b64 = parts
        try:
            expected_sig = hmac.new(
                self._session_signing_secret, payload_b64.encode("ascii"), hashlib.sha256
            ).digest()
            provided_sig = _b64url_decode(sig_b64)
            if not hmac.compare_digest(expected_sig, provided_sig):
                return None
            payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        except Exception:
            return None

        if not isinstance(payload, dict) or payload.get("sub") != "candidate":
            return None
        session_id = payload.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            return None
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload


def get_ctx(request: Request) -> AppContext:
    """FastAPI dependency returning the app's runtime context."""
    return request.app.state.ctx
