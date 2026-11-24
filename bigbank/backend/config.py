"""Environment-backed application configuration, .env persistence, and secret masking."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from dotenv import load_dotenv, set_key
from pydantic import BaseModel, Field

DEFAULT_SANDBOX_BANNED_PACKAGES = (
    "torch,torchvision,torchaudio,tensorflow,tensorflow-cpu,tf-nightly,"
    "jax,jaxlib,keras,transformers,diffusers,accelerate,vllm,llama-cpp-python,"
    "mxnet,paddlepaddle,cupy,triton,onnxruntime,opencv-python,"
    "opencv-contrib-python,scipy,catboost,xgboost,lightgbm,pyspark,dask,ray"
)

SECRET_SETTING_FIELDS: tuple[str, ...] = (
    "admin_password",
    "llm_api_key",
    "smtp_password",
    "slack_bot_token",
    "webhook_secret",
    "azure_storage_connection_string",
)


def _default_runtime_db_path() -> str:
    if os.name == "nt":
        return str(Path(tempfile.gettempdir()) / "runtime.db")
    return "/tmp/runtime.db"


def _env_str(name: str, default: str) -> str:
    if name in os.environ:
        return os.environ[name]
    return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    lowered = raw.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


class Settings(BaseModel):
    """Typed runtime configuration loaded from environment variables."""

    # Runtime mode & access
    app_mode: str = "local"
    admin_password: str = ""
    app_title: str = "BigBank"
    database_path: str = "data/interview.db"
    bundle_path: str = "bundle/interview.db"
    runtime_db_path: str = Field(default_factory=_default_runtime_db_path)
    auto_seed_examples: bool = True
    access_code: str = ""

    # Provider-agnostic LLM
    llm_provider: str = "none"
    llm_model: str = "gpt-4o-mini"
    llm_api_key: str = ""
    llm_base_url: str = ""
    vertexai_project: str = ""
    vertexai_location: str = ""
    azure_api_version: str = "2024-06-01"
    aws_region: str = ""

    # Storage sinks
    storage_sinks: str = "local"
    local_reports_dir: str = "data/reports"
    s3_bucket: str = ""
    s3_prefix: str = "interviews"
    s3_region: str = "us-east-1"
    s3_endpoint_url: str = ""
    gcs_bucket: str = ""
    gcs_prefix: str = "interviews"
    azure_storage_connection_string: str = ""
    azure_storage_account_url: str = ""
    azure_storage_container: str = ""
    azure_storage_prefix: str = "interviews"
    storage_presigned_urls: bool = False
    storage_presigned_ttl_seconds: int = 604800

    # Notification sinks
    notify_sinks: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_to: str = ""
    smtp_use_tls: bool = True
    slack_webhook_url: str = ""
    slack_bot_token: str = ""
    slack_channel_id: str = ""
    teams_webhook_url: str = ""
    webhook_url: str = ""
    webhook_secret: str = ""
    webhook_include_pdf_base64: bool = False

    # Notebook sandbox guardrails
    sandbox_max_package_mb: int = 25
    sandbox_max_disk_mb: int = 150
    sandbox_cell_timeout_seconds: int = 15
    sandbox_max_memory_mb: int = 512
    sandbox_idle_timeout_minutes: int = 15
    sandbox_os_user: str = ""
    sandbox_banned_packages: str = DEFAULT_SANDBOX_BANNED_PACKAGES

    @classmethod
    def from_env(cls) -> "Settings":
        runtime_default = _default_runtime_db_path()
        runtime_raw = os.environ.get("RUNTIME_DB_PATH", "").strip()
        return cls(
            app_mode=_env_str("APP_MODE", "local").strip().lower() or "local",
            admin_password=_env_str("ADMIN_PASSWORD", ""),
            app_title=_env_str("APP_TITLE", "BigBank"),
            database_path=_env_str("DATABASE_PATH", "data/interview.db"),
            bundle_path=_env_str("BUNDLE_PATH", "bundle/interview.db"),
            runtime_db_path=runtime_raw or runtime_default,
            auto_seed_examples=_env_bool("AUTO_SEED_EXAMPLES", True),
            access_code=_env_str("ACCESS_CODE", ""),
            llm_provider=_env_str("LLM_PROVIDER", "none").strip().lower() or "none",
            llm_model=_env_str("LLM_MODEL", "gpt-4o-mini"),
            llm_api_key=_env_str("LLM_API_KEY", ""),
            llm_base_url=_env_str("LLM_BASE_URL", ""),
            vertexai_project=(
                _env_str("VERTEXAI_PROJECT", "").strip()
                or (
                    ""
                    if _env_str("GOOGLE_CLOUD_PROJECT", "").strip().lower()
                    in {"", "your-gcp-project-id", "your-project-id", "my-gcp-project", "project-id", "<project-id>"}
                    else _env_str("GOOGLE_CLOUD_PROJECT", "").strip()
                )
            ),
            vertexai_location=(
                _env_str("VERTEXAI_LOCATION", "").strip()
                or _env_str("GOOGLE_CLOUD_LOCATION", "").strip()
                or _env_str("GOOGLE_CLOUD_REGION", "").strip()
            ),
            azure_api_version=_env_str("AZURE_API_VERSION", "2024-06-01").strip() or "2024-06-01",
            aws_region=(
                _env_str("AWS_REGION", "").strip()
                or _env_str("AWS_DEFAULT_REGION", "").strip()
            ),
            storage_sinks=_env_str("STORAGE_SINKS", "local"),
            local_reports_dir=_env_str("LOCAL_REPORTS_DIR", "data/reports"),
            s3_bucket=_env_str("S3_BUCKET", ""),
            s3_prefix=_env_str("S3_PREFIX", "interviews"),
            s3_region=_env_str("S3_REGION", "us-east-1"),
            s3_endpoint_url=_env_str("S3_ENDPOINT_URL", ""),
            gcs_bucket=_env_str("GCS_BUCKET", ""),
            gcs_prefix=_env_str("GCS_PREFIX", "interviews"),
            azure_storage_connection_string=_env_str("AZURE_STORAGE_CONNECTION_STRING", ""),
            azure_storage_account_url=_env_str("AZURE_STORAGE_ACCOUNT_URL", ""),
            azure_storage_container=_env_str("AZURE_STORAGE_CONTAINER", ""),
            azure_storage_prefix=_env_str("AZURE_STORAGE_PREFIX", "interviews"),
            storage_presigned_urls=_env_bool("STORAGE_PRESIGNED_URLS", False),
            storage_presigned_ttl_seconds=_env_int("STORAGE_PRESIGNED_TTL_SECONDS", 604800),
            notify_sinks=_env_str("NOTIFY_SINKS", ""),
            smtp_host=_env_str("SMTP_HOST", ""),
            smtp_port=_env_int("SMTP_PORT", 587),
            smtp_user=_env_str("SMTP_USER", ""),
            smtp_password=_env_str("SMTP_PASSWORD", ""),
            smtp_from=_env_str("SMTP_FROM", ""),
            smtp_to=_env_str("SMTP_TO", ""),
            smtp_use_tls=_env_bool("SMTP_USE_TLS", True),
            slack_webhook_url=_env_str("SLACK_WEBHOOK_URL", ""),
            slack_bot_token=_env_str("SLACK_BOT_TOKEN", ""),
            slack_channel_id=_env_str("SLACK_CHANNEL_ID", ""),
            teams_webhook_url=_env_str("TEAMS_WEBHOOK_URL", ""),
            webhook_url=_env_str("WEBHOOK_URL", ""),
            webhook_secret=_env_str("WEBHOOK_SECRET", ""),
            webhook_include_pdf_base64=_env_bool("WEBHOOK_INCLUDE_PDF_BASE64", False),
            sandbox_max_package_mb=_env_int("SANDBOX_MAX_PACKAGE_MB", 25),
            sandbox_max_disk_mb=_env_int("SANDBOX_MAX_DISK_MB", 150),
            sandbox_cell_timeout_seconds=_env_int("SANDBOX_CELL_TIMEOUT_SECONDS", 15),
            sandbox_max_memory_mb=_env_int("SANDBOX_MAX_MEMORY_MB", 512),
            sandbox_idle_timeout_minutes=_env_int("SANDBOX_IDLE_TIMEOUT_MINUTES", 15),
            sandbox_os_user=_env_str("SANDBOX_OS_USER", ""),
            sandbox_banned_packages=_env_str(
                "SANDBOX_BANNED_PACKAGES", DEFAULT_SANDBOX_BANNED_PACKAGES
            ),
        )

    @property
    def is_candidate_mode(self) -> bool:
        return self.app_mode.strip().lower() == "candidate"

    @property
    def effective_catalog_path(self) -> Path:
        return Path(self.bundle_path if self.is_candidate_mode else self.database_path)

    @property
    def effective_runtime_path(self) -> Path:
        return Path(self.runtime_db_path if self.is_candidate_mode else self.database_path)

    @property
    def storage_sink_list(self) -> list[str]:
        return [s.strip().lower() for s in self.storage_sinks.split(",") if s.strip()]

    @property
    def notify_sink_list(self) -> list[str]:
        return [s.strip().lower() for s in self.notify_sinks.split(",") if s.strip()]

    @property
    def banned_package_set(self) -> set[str]:
        return {
            p.strip().lower().replace("_", "-")
            for p in self.sandbox_banned_packages.split(",")
            if p.strip()
        }


_cached_settings: Settings | None = None


def get_settings() -> Settings:
    """Return cached runtime Settings, loading `.env` on first access."""
    global _cached_settings
    if _cached_settings is None:
        default_env = Path(".env")
        if default_env.exists():
            load_dotenv(default_env, override=False)
        _cached_settings = Settings.from_env()
    return _cached_settings


def reload_settings(env_path: Path | None = None) -> Settings:
    """Reload Settings from environment (and optional `.env` file)."""
    global _cached_settings
    if env_path is not None and Path(env_path).exists():
        load_dotenv(Path(env_path), override=True)
    elif Path(".env").exists():
        load_dotenv(Path(".env"), override=False)
    _cached_settings = Settings.from_env()
    return _cached_settings


def save_local_env(updates: dict[str, str], env_path: Path | None = None) -> Settings:
    """Persist key/value updates to a local `.env` file and hot-reload Settings."""
    target = Path(env_path) if env_path is not None else Path(".env")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_text("", encoding="utf-8")

    for raw_key, raw_value in updates.items():
        key = raw_key.strip().upper()
        if not key:
            continue
        value = "" if raw_value is None else str(raw_value)
        set_key(str(target), key, value, quote_mode="auto")
        os.environ[key] = value

    return reload_settings(target)


def get_masked_settings(settings: Settings) -> dict[str, Any]:
    """Return a JSON-safe settings dict with all secrets stripped and boolean *_set flags."""
    data = settings.model_dump()
    for field_name in SECRET_SETTING_FIELDS:
        raw_val = getattr(settings, field_name, "") or ""
        data[field_name] = ""
        data[f"{field_name}_set"] = bool(raw_val.strip())

    aws_secret = os.environ.get("AWS_SECRET_ACCESS_KEY", "") or ""
    data["aws_secret_access_key"] = ""
    data["aws_secret_access_key_set"] = bool(aws_secret.strip())
    return data
