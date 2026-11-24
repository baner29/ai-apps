"""DeliveryOrchestrator coordinating concurrent storage fan-out and notification dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from backend.config import Settings
from backend.services.delivery.notify import NotifyResult, build_notify_adapter
from backend.services.delivery.storage import (
    StorageResult,
    build_artifact_stem,
    build_storage_adapter,
    normalize_storage_sink_name,
)

logger = logging.getLogger(__name__)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


class DeliveryOrchestrator:
    """Fan out raw backups, final reports, and notifications across pluggable sinks."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _storage_sinks(self) -> list[str]:
        return _dedupe(
            [normalize_storage_sink_name(s) for s in self.settings.storage_sink_list]
        )

    def _notify_sinks(self) -> list[str]:
        return _dedupe(self.settings.notify_sink_list)

    def has_external_sinks(self) -> bool:
        """Return True if any non-local storage sink or notification sink is configured."""
        external_storage = [s for s in self._storage_sinks() if s != "local"]
        return bool(external_storage or self._notify_sinks())

    async def save_raw_backup(
        self, candidate_name: str, backup_data: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Persist raw candidate submission backup concurrently to all enabled storage sinks."""
        sinks = self._storage_sinks()
        if not sinks:
            return []

        stem = build_artifact_stem(candidate_name)
        filename = f"{stem}_raw_backup.json"
        backup_bytes = json.dumps(backup_data, indent=2, default=str).encode("utf-8")

        async def _run_one(sink_name: str) -> StorageResult:
            adapter = build_storage_adapter(sink_name, self.settings)
            if adapter is None:
                return StorageResult(
                    sink=sink_name,
                    ok=False,
                    error=f"Unknown storage sink: {sink_name}",
                )
            return await adapter.upload_backup(filename, backup_bytes)

        raw_outcomes = await asyncio.gather(
            *(_run_one(sink) for sink in sinks),
            return_exceptions=True,
        )

        results: list[StorageResult] = []
        for sink_name, outcome in zip(sinks, raw_outcomes):
            if isinstance(outcome, BaseException):
                if not isinstance(outcome, Exception):
                    raise outcome
                logger.exception("Unhandled error in storage backup sink '%s'", sink_name)
                results.append(
                    StorageResult(sink=sink_name, ok=False, error=str(outcome))
                )
            else:
                results.append(outcome)

        # A failed backup must be visible in the platform logs (for example
        # Cloud Run), not only in the submission's delivery log: a missing
        # bucket name, a missing SDK, or a 403 permission error otherwise
        # surfaces as a silently empty bucket while /finish returns 200.
        for result in results:
            if not result.ok:
                logger.error(
                    "Raw backup to storage sink '%s' failed: %s",
                    result.sink,
                    result.error or "unknown error",
                )

        return [r.to_dict() for r in results]

    async def deliver_report(
        self, candidate_name: str, results: dict[str, Any], pdf_bytes: bytes
    ) -> dict[str, Any]:
        """Persist PDF + JSON report to storage sinks, then fan out to notification sinks."""
        stem = build_artifact_stem(candidate_name)
        pdf_filename = f"{stem}.pdf"
        results_json_bytes = json.dumps(results, indent=2, default=str).encode("utf-8")

        # Phase 1: Concurrent storage persistence
        storage_sinks = self._storage_sinks()
        storage_results: list[StorageResult] = []
        if storage_sinks:

            async def _run_storage(sink_name: str) -> StorageResult:
                adapter = build_storage_adapter(sink_name, self.settings)
                if adapter is None:
                    return StorageResult(
                        sink=sink_name,
                        ok=False,
                        error=f"Unknown storage sink: {sink_name}",
                    )
                return await adapter.upload_report(stem, pdf_bytes, results_json_bytes)

            raw_storage = await asyncio.gather(
                *(_run_storage(sink) for sink in storage_sinks),
                return_exceptions=True,
            )
            for sink_name, outcome in zip(storage_sinks, raw_storage):
                if isinstance(outcome, BaseException):
                    if not isinstance(outcome, Exception):
                        raise outcome
                    logger.exception("Unhandled error in storage sink '%s'", sink_name)
                    storage_results.append(
                        StorageResult(sink=sink_name, ok=False, error=str(outcome))
                    )
                else:
                    storage_results.append(outcome)

        for result in storage_results:
            if not result.ok:
                logger.error(
                    "Report storage to sink '%s' failed: %s",
                    result.sink,
                    result.error or "unknown error",
                )

        local_pdf_path: str | None = None
        for sr in storage_results:
            if sr.sink == "local" and sr.ok and sr.uri:
                local_pdf_path = sr.uri
                break

        # Phase 2: Concurrent notification dispatch with storage links/URIs
        notify_sinks = self._notify_sinks()
        notify_results: list[NotifyResult] = []
        if notify_sinks:

            async def _run_notify(sink_name: str) -> NotifyResult:
                adapter = build_notify_adapter(sink_name, self.settings)
                if adapter is None:
                    return NotifyResult(
                        sink=sink_name,
                        ok=False,
                        error=f"Unknown notification sink: {sink_name}",
                    )
                return await adapter.notify(
                    candidate_name=candidate_name,
                    results=results,
                    pdf_bytes=pdf_bytes,
                    pdf_filename=pdf_filename,
                    storage_results=storage_results,
                )

            raw_notify = await asyncio.gather(
                *(_run_notify(sink) for sink in notify_sinks),
                return_exceptions=True,
            )
            for sink_name, outcome in zip(notify_sinks, raw_notify):
                if isinstance(outcome, BaseException):
                    if not isinstance(outcome, Exception):
                        raise outcome
                    logger.exception("Unhandled error in notification sink '%s'", sink_name)
                    notify_results.append(
                        NotifyResult(sink=sink_name, ok=False, error=str(outcome))
                    )
                else:
                    notify_results.append(outcome)

        return {
            "storage": [r.to_dict() for r in storage_results],
            "notifications": [r.to_dict() for r in notify_results],
            "local_pdf_path": local_pdf_path,
        }

    async def test_sink(self, sink_name: str) -> dict[str, Any]:
        """Run a connectivity/write check against a single storage or notification sink."""
        cleaned = (sink_name or "").strip().lower()
        if not cleaned:
            return {"sink": "", "ok": False, "detail": "Sink name is required."}

        storage_adapter = build_storage_adapter(cleaned, self.settings)
        if storage_adapter is not None:
            try:
                res = await storage_adapter.test_connection()
                return {
                    "sink": str(res.get("sink") or normalize_storage_sink_name(cleaned)),
                    "ok": bool(res.get("ok")),
                    "detail": str(res.get("detail") or ""),
                }
            except Exception as exc:
                return {"sink": cleaned, "ok": False, "detail": str(exc)}

        notify_adapter = build_notify_adapter(cleaned, self.settings)
        if notify_adapter is not None:
            try:
                res = await notify_adapter.test_connection()
                return {
                    "sink": str(res.get("sink") or cleaned),
                    "ok": bool(res.get("ok")),
                    "detail": str(res.get("detail") or ""),
                }
            except Exception as exc:
                return {"sink": cleaned, "ok": False, "detail": str(exc)}

        return {"sink": cleaned, "ok": False, "detail": f"Unknown sink: {cleaned}"}
