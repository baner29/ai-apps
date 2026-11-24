"""Pluggable storage adapters (local, S3/R2/MinIO, GCS, Azure Blob) with lazy cloud SDK imports."""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from backend.config import Settings

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-zA-Z0-9_-]+")
_MULTI_UNDERSCORE_RE = re.compile(r"_+")


@dataclass
class StorageResult:
    """Outcome of persisting an interview artifact to a single storage sink."""

    sink: str
    ok: bool
    uri: str | None = None
    url: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "sink": self.sink,
            "ok": self.ok,
            "uri": self.uri,
            "url": self.url,
            "error": self.error,
        }


def sanitize_candidate_slug(candidate_name: str) -> str:
    """Return a filesystem- and object-key-safe slug for a candidate name."""
    raw = (candidate_name or "").strip()
    slug = _SLUG_RE.sub("_", raw)
    slug = _MULTI_UNDERSCORE_RE.sub("_", slug).strip("_-")
    if not slug:
        return "candidate"
    return slug[:64]


def build_artifact_stem(candidate_name: str) -> str:
    """Build a unique timestamped filename stem for a candidate's artifacts."""
    slug = sanitize_candidate_slug(candidate_name)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    short_id = uuid.uuid4().hex[:6]
    return f"{slug}_{ts}_{short_id}"


def _join_prefix(prefix: str, *parts: str) -> str:
    segments = [p.strip("/") for p in (prefix, *parts) if p and p.strip("/")]
    return "/".join(segments)


def normalize_storage_sink_name(name: str) -> str:
    cleaned = (name or "").strip().lower()
    if cleaned in {"azure_blob", "azure-blob", "azureblob"}:
        return "azure"
    return cleaned


def _parse_azure_conn_str(conn_str: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for segment in conn_str.split(";"):
        if "=" in segment:
            k, v = segment.split("=", 1)
            parsed[k.strip()] = v.strip()
    return parsed


class LocalStorageAdapter:
    """Persist PDF reports, JSON evaluations, and raw backups to local disk."""

    sink_name = "local"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def base_dir(self) -> Path:
        return Path(self.settings.local_reports_dir or "data/reports")

    async def upload_report(
        self, stem: str, pdf_bytes: bytes, results_json_bytes: bytes
    ) -> StorageResult:
        def _write() -> StorageResult:
            target_dir = self.base_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            pdf_path = target_dir / f"{stem}.pdf"
            json_path = target_dir / f"{stem}.json"
            pdf_path.write_bytes(pdf_bytes)
            json_path.write_bytes(results_json_bytes)
            resolved_pdf = pdf_path.resolve().as_posix()
            return StorageResult(
                sink=self.sink_name,
                ok=True,
                uri=resolved_pdf,
                url=None,
                error=None,
            )

        try:
            return await asyncio.to_thread(_write)
        except Exception as exc:
            logger.exception("Local storage upload_report failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def upload_backup(
        self, filename: str, backup_json_bytes: bytes
    ) -> StorageResult:
        def _write() -> StorageResult:
            backup_dir = self.base_dir / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup_path = backup_dir / filename
            backup_path.write_bytes(backup_json_bytes)
            return StorageResult(
                sink=self.sink_name,
                ok=True,
                uri=backup_path.resolve().as_posix(),
                url=None,
                error=None,
            )

        try:
            return await asyncio.to_thread(_write)
        except Exception as exc:
            logger.exception("Local storage upload_backup failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        def _probe() -> dict[str, Any]:
            target_dir = self.base_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            probe_file = target_dir / f".probe_{uuid.uuid4().hex[:8]}"
            probe_file.write_bytes(b"ok")
            probe_file.unlink(missing_ok=True)
            return {
                "sink": self.sink_name,
                "ok": True,
                "detail": f"Writable directory: {target_dir.resolve().as_posix()}",
            }

        try:
            return await asyncio.to_thread(_probe)
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


class S3StorageAdapter:
    """Persist artifacts to AWS S3 or S3-compatible object storage (R2, MinIO, Spaces)."""

    sink_name = "s3"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _build_client(self) -> tuple[Any, str | None]:
        bucket = self.settings.s3_bucket.strip()
        if not bucket:
            return None, "S3_BUCKET is not configured."
        try:
            import boto3
        except ImportError:
            return (
                None,
                "Optional dependency 'boto3' is not installed. Install it with: pip install boto3",
            )
        kwargs: dict[str, Any] = {}
        if self.settings.s3_region.strip():
            kwargs["region_name"] = self.settings.s3_region.strip()
        if self.settings.s3_endpoint_url.strip():
            kwargs["endpoint_url"] = self.settings.s3_endpoint_url.strip()
        return boto3.client("s3", **kwargs), None

    def _console_url(self, bucket: str, key: str) -> str:
        endpoint = self.settings.s3_endpoint_url.strip()
        if endpoint:
            return f"{endpoint.rstrip('/')}/{bucket}/{quote(key, safe='/')}"
        region = self.settings.s3_region.strip() or "us-east-1"
        return (
            f"https://s3.console.aws.amazon.com/s3/object/{bucket}"
            f"?region={quote(region, safe='')}&prefix={quote(key, safe='')}"
        )

    async def upload_report(
        self, stem: str, pdf_bytes: bytes, results_json_bytes: bytes
    ) -> StorageResult:
        def _upload() -> StorageResult:
            client, err = self._build_client()
            if err:
                return StorageResult(sink=self.sink_name, ok=False, error=err)

            bucket = self.settings.s3_bucket.strip()
            prefix = self.settings.s3_prefix.strip()
            pdf_key = _join_prefix(prefix, "reports", f"{stem}.pdf")
            json_key = _join_prefix(prefix, "reports", f"{stem}.json")

            client.put_object(
                Bucket=bucket,
                Key=pdf_key,
                Body=pdf_bytes,
                ContentType="application/pdf",
            )
            client.put_object(
                Bucket=bucket,
                Key=json_key,
                Body=results_json_bytes,
                ContentType="application/json",
            )

            uri = f"s3://{bucket}/{pdf_key}"
            if self.settings.storage_presigned_urls:
                ttl = max(60, int(self.settings.storage_presigned_ttl_seconds))
                try:
                    url = client.generate_presigned_url(
                        "get_object",
                        Params={"Bucket": bucket, "Key": pdf_key},
                        ExpiresIn=ttl,
                    )
                except Exception as exc:
                    logger.warning("S3 presigned URL signing failed; falling back to URI: %s", exc)
                    url = uri
            else:
                url = self._console_url(bucket, pdf_key)

            return StorageResult(sink=self.sink_name, ok=True, uri=uri, url=url)

        try:
            return await asyncio.to_thread(_upload)
        except Exception as exc:
            logger.exception("S3 storage upload_report failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def upload_backup(
        self, filename: str, backup_json_bytes: bytes
    ) -> StorageResult:
        def _upload() -> StorageResult:
            client, err = self._build_client()
            if err:
                return StorageResult(sink=self.sink_name, ok=False, error=err)

            bucket = self.settings.s3_bucket.strip()
            prefix = self.settings.s3_prefix.strip()
            key = _join_prefix(prefix, "backups", filename)
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=backup_json_bytes,
                ContentType="application/json",
            )
            uri = f"s3://{bucket}/{key}"
            return StorageResult(
                sink=self.sink_name,
                ok=True,
                uri=uri,
                url=self._console_url(bucket, key),
            )

        try:
            return await asyncio.to_thread(_upload)
        except Exception as exc:
            logger.exception("S3 storage upload_backup failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        def _probe() -> dict[str, Any]:
            client, err = self._build_client()
            if err:
                return {"sink": self.sink_name, "ok": False, "detail": err}
            bucket = self.settings.s3_bucket.strip()
            client.head_bucket(Bucket=bucket)
            return {
                "sink": self.sink_name,
                "ok": True,
                "detail": f"Accessible S3 bucket: s3://{bucket}",
            }

        try:
            return await asyncio.to_thread(_probe)
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


class GCSStorageAdapter:
    """Persist artifacts to Google Cloud Storage with lazy SDK import."""

    sink_name = "gcs"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _build_client(self) -> tuple[Any, str | None]:
        bucket = self.settings.gcs_bucket.strip()
        if not bucket:
            return None, "GCS_BUCKET is not configured."
        try:
            from google.cloud import storage as gcs_storage
        except ImportError:
            return (
                None,
                "Optional dependency 'google-cloud-storage' is not installed. "
                "Install it with: pip install google-cloud-storage",
            )
        return gcs_storage.Client(), None

    @staticmethod
    def _console_url(bucket: str, key: str) -> str:
        return f"https://console.cloud.google.com/storage/browser/_details/{bucket}/{quote(key)}"

    async def upload_report(
        self, stem: str, pdf_bytes: bytes, results_json_bytes: bytes
    ) -> StorageResult:
        def _upload() -> StorageResult:
            client, err = self._build_client()
            if err:
                return StorageResult(sink=self.sink_name, ok=False, error=err)

            bucket_name = self.settings.gcs_bucket.strip()
            prefix = self.settings.gcs_prefix.strip()
            pdf_key = _join_prefix(prefix, "reports", f"{stem}.pdf")
            json_key = _join_prefix(prefix, "reports", f"{stem}.json")

            bucket = client.bucket(bucket_name)
            pdf_blob = bucket.blob(pdf_key)
            pdf_blob.upload_from_string(pdf_bytes, content_type="application/pdf")

            json_blob = bucket.blob(json_key)
            json_blob.upload_from_string(results_json_bytes, content_type="application/json")

            uri = f"gs://{bucket_name}/{pdf_key}"
            if self.settings.storage_presigned_urls:
                ttl = max(60, int(self.settings.storage_presigned_ttl_seconds))
                try:
                    url = pdf_blob.generate_signed_url(
                        version="v4",
                        expiration=timedelta(seconds=ttl),
                        method="GET",
                    )
                except Exception as exc:
                    logger.warning("GCS signed URL generation failed; falling back to URI: %s", exc)
                    url = uri
            else:
                url = self._console_url(bucket_name, pdf_key)

            return StorageResult(sink=self.sink_name, ok=True, uri=uri, url=url)

        try:
            return await asyncio.to_thread(_upload)
        except Exception as exc:
            logger.exception("GCS storage upload_report failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def upload_backup(
        self, filename: str, backup_json_bytes: bytes
    ) -> StorageResult:
        def _upload() -> StorageResult:
            client, err = self._build_client()
            if err:
                return StorageResult(sink=self.sink_name, ok=False, error=err)

            bucket_name = self.settings.gcs_bucket.strip()
            prefix = self.settings.gcs_prefix.strip()
            key = _join_prefix(prefix, "backups", filename)

            bucket = client.bucket(bucket_name)
            blob = bucket.blob(key)
            blob.upload_from_string(backup_json_bytes, content_type="application/json")

            uri = f"gs://{bucket_name}/{key}"
            return StorageResult(
                sink=self.sink_name,
                ok=True,
                uri=uri,
                url=self._console_url(bucket_name, key),
            )

        try:
            return await asyncio.to_thread(_upload)
        except Exception as exc:
            logger.exception("GCS storage upload_backup failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        def _probe() -> dict[str, Any]:
            client, err = self._build_client()
            if err:
                return {"sink": self.sink_name, "ok": False, "detail": err}
            bucket_name = self.settings.gcs_bucket.strip()
            exists = client.bucket(bucket_name).exists()
            if not exists:
                return {
                    "sink": self.sink_name,
                    "ok": False,
                    "detail": f"GCS bucket not found: gs://{bucket_name}",
                }
            return {
                "sink": self.sink_name,
                "ok": True,
                "detail": f"Accessible GCS bucket: gs://{bucket_name}",
            }

        try:
            return await asyncio.to_thread(_probe)
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


class AzureBlobStorageAdapter:
    """Persist artifacts to Azure Blob Storage with lazy SDK import."""

    sink_name = "azure"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _build_clients(self) -> tuple[Any, Any, Any, str | None]:
        container = self.settings.azure_storage_container.strip()
        conn_str = self.settings.azure_storage_connection_string.strip()
        account_url = self.settings.azure_storage_account_url.strip()

        if not container:
            return None, None, None, "AZURE_STORAGE_CONTAINER is not configured."
        if not conn_str and not account_url:
            return (
                None,
                None,
                None,
                "Either AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_URL must be configured.",
            )

        try:
            from azure.storage.blob import BlobServiceClient, ContentSettings
        except ImportError:
            return (
                None,
                None,
                None,
                "Optional dependency 'azure-storage-blob' is not installed. "
                "Install it with: pip install azure-storage-blob",
            )

        if conn_str:
            service_client = BlobServiceClient.from_connection_string(conn_str)
        else:
            credential = None
            try:
                from azure.identity import DefaultAzureCredential

                credential = DefaultAzureCredential()
            except ImportError:
                credential = None
            service_client = BlobServiceClient(account_url=account_url, credential=credential)

        container_client = service_client.get_container_client(container)
        return service_client, container_client, ContentSettings, None

    def _generate_sas_url(
        self, service_client: Any, container: str, blob_key: str, base_url: str
    ) -> str:
        from azure.storage.blob import BlobSasPermissions, generate_blob_sas

        conn_parts = _parse_azure_conn_str(self.settings.azure_storage_connection_string.strip())
        account_name = conn_parts.get("AccountName") or getattr(
            service_client, "account_name", None
        )
        account_key = conn_parts.get("AccountKey") or getattr(
            getattr(service_client, "credential", None), "account_key", None
        )
        if not account_name or not account_key:
            raise RuntimeError("Account key unavailable for Azure Blob SAS signing")

        ttl = max(60, int(self.settings.storage_presigned_ttl_seconds))
        sas_token = generate_blob_sas(
            account_name=account_name,
            container_name=container,
            blob_name=blob_key,
            account_key=account_key,
            permission=BlobSasPermissions(read=True),
            expiry=datetime.now(timezone.utc) + timedelta(seconds=ttl),
        )
        clean_base = base_url.split("?", 1)[0]
        return f"{clean_base}?{sas_token}"

    async def upload_report(
        self, stem: str, pdf_bytes: bytes, results_json_bytes: bytes
    ) -> StorageResult:
        def _upload() -> StorageResult:
            service_client, container_client, ContentSettings, err = self._build_clients()
            if err:
                return StorageResult(sink=self.sink_name, ok=False, error=err)

            container = self.settings.azure_storage_container.strip()
            prefix = self.settings.azure_storage_prefix.strip()
            pdf_key = _join_prefix(prefix, "reports", f"{stem}.pdf")
            json_key = _join_prefix(prefix, "reports", f"{stem}.json")

            pdf_blob = container_client.get_blob_client(pdf_key)
            pdf_blob.upload_blob(
                pdf_bytes,
                overwrite=True,
                content_settings=ContentSettings(content_type="application/pdf"),
            )

            json_blob = container_client.get_blob_client(json_key)
            json_blob.upload_blob(
                results_json_bytes,
                overwrite=True,
                content_settings=ContentSettings(content_type="application/json"),
            )

            uri = str(pdf_blob.url)
            if self.settings.storage_presigned_urls:
                try:
                    url = self._generate_sas_url(service_client, container, pdf_key, uri)
                except Exception as exc:
                    logger.warning("Azure SAS URL signing failed; falling back to URI: %s", exc)
                    url = uri
            else:
                url = uri

            return StorageResult(sink=self.sink_name, ok=True, uri=uri, url=url)

        try:
            return await asyncio.to_thread(_upload)
        except Exception as exc:
            logger.exception("Azure storage upload_report failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def upload_backup(
        self, filename: str, backup_json_bytes: bytes
    ) -> StorageResult:
        def _upload() -> StorageResult:
            _, container_client, ContentSettings, err = self._build_clients()
            if err:
                return StorageResult(sink=self.sink_name, ok=False, error=err)

            prefix = self.settings.azure_storage_prefix.strip()
            key = _join_prefix(prefix, "backups", filename)
            blob = container_client.get_blob_client(key)
            blob.upload_blob(
                backup_json_bytes,
                overwrite=True,
                content_settings=ContentSettings(content_type="application/json"),
            )
            uri = str(blob.url)
            return StorageResult(sink=self.sink_name, ok=True, uri=uri, url=uri)

        try:
            return await asyncio.to_thread(_upload)
        except Exception as exc:
            logger.exception("Azure storage upload_backup failed")
            return StorageResult(sink=self.sink_name, ok=False, error=str(exc))

    async def test_connection(self) -> dict[str, Any]:
        def _probe() -> dict[str, Any]:
            _, container_client, _, err = self._build_clients()
            if err:
                return {"sink": self.sink_name, "ok": False, "detail": err}
            exists = container_client.exists()
            container = self.settings.azure_storage_container.strip()
            if not exists:
                return {
                    "sink": self.sink_name,
                    "ok": False,
                    "detail": f"Azure container not found: {container}",
                }
            return {
                "sink": self.sink_name,
                "ok": True,
                "detail": f"Accessible Azure container: {container}",
            }

        try:
            return await asyncio.to_thread(_probe)
        except Exception as exc:
            return {"sink": self.sink_name, "ok": False, "detail": str(exc)}


STORAGE_ADAPTER_MAP = {
    "local": LocalStorageAdapter,
    "s3": S3StorageAdapter,
    "gcs": GCSStorageAdapter,
    "azure": AzureBlobStorageAdapter,
}


def build_storage_adapter(sink_name: str, settings: Settings) -> Any | None:
    canonical = normalize_storage_sink_name(sink_name)
    adapter_cls = STORAGE_ADAPTER_MAP.get(canonical)
    if adapter_cls is None:
        return None
    return adapter_cls(settings)
