"""Tests for pluggable storage, notification sinks, and DeliveryOrchestrator."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.config import Settings
from backend.services.delivery.orchestrator import DeliveryOrchestrator


def test_local_sink_saves_pdf_and_json(tmp_path):
    settings = Settings(
        storage_sinks="local",
        notify_sinks="",
        local_reports_dir=str(tmp_path),
    )
    orch = DeliveryOrchestrator(settings)
    out = asyncio.run(
        orch.deliver_report(
            "Jane Doe",
            {"candidate_name": "Jane Doe", "final_score": 80, "max_score": 100},
            b"%PDF-1.4 test",
        )
    )
    assert out["storage"][0]["ok"] is True
    assert out["local_pdf_path"] is not None
    assert (
        (tmp_path / out["local_pdf_path"].split("/")[-1]).exists()
        or len(list(tmp_path.glob("*.pdf"))) == 1
    )
    json_files = list(tmp_path.glob("*.json"))
    assert len(json_files) == 1
    saved_payload = json.loads(json_files[0].read_text(encoding="utf-8"))
    assert saved_payload["candidate_name"] == "Jane Doe"
    assert saved_payload["final_score"] == 80


def test_partial_sink_failure_is_isolated(tmp_path):
    settings = Settings(
        storage_sinks="local",
        notify_sinks="slack,webhook",
        local_reports_dir=str(tmp_path),
        slack_webhook_url="https://hooks.slack.com/bad",
        webhook_url="https://example.com/hook",
        webhook_secret="topsecret",
        webhook_include_pdf_base64=True,
    )
    orch = DeliveryOrchestrator(settings)
    captured = {}

    async def fake_post(self, url, **kwargs):
        resp = MagicMock()
        if "slack" in url:
            resp.status_code = 500
            resp.text = "Slack down"
            return resp
        captured["headers"] = kwargs.get("headers", {})
        captured["content"] = kwargs.get("content")
        resp.status_code = 200
        resp.text = "ok"
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        out = asyncio.run(
            orch.deliver_report(
                "Alex",
                {"candidate_name": "Alex", "final_score": 10, "max_score": 20},
                b"%PDF-mock",
            )
        )
    assert out["storage"][0]["ok"] is True
    statuses = {n["sink"]: n["ok"] for n in out["notifications"]}
    assert statuses == {"slack": False, "webhook": True}
    expected_sig = (
        "sha256="
        + hmac.new(b"topsecret", captured["content"], hashlib.sha256).hexdigest()
    )
    assert captured["headers"]["X-Signature-256"] == expected_sig
    body = json.loads(captured["content"].decode())
    assert "pdf_base64" in body
    assert base64.b64decode(body["pdf_base64"]) == b"%PDF-mock"


def test_smtp_attaches_pdf_directly(tmp_path):
    settings = Settings(
        storage_sinks="",
        notify_sinks="smtp",
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_from="bot@example.com",
        smtp_to="hr@example.com",
    )
    orch = DeliveryOrchestrator(settings)
    sent_messages = []
    with patch("smtplib.SMTP") as mock_smtp:
        inst = mock_smtp.return_value.__enter__.return_value
        inst.send_message.side_effect = lambda msg: sent_messages.append(msg)
        out = asyncio.run(
            orch.deliver_report(
                "Sam",
                {
                    "candidate_name": "Sam",
                    "role_title": "SWE",
                    "final_score": 90,
                    "max_score": 100,
                },
                b"%PDF-attach",
            )
        )
    assert out["notifications"][0]["ok"] is True
    attachments = [p for p in sent_messages[0].iter_attachments()]
    assert len(attachments) == 1 and attachments[0].get_content_type() == "application/pdf"


def test_has_external_sinks():
    assert DeliveryOrchestrator(Settings(storage_sinks="local", notify_sinks="")).has_external_sinks() is False
    assert DeliveryOrchestrator(Settings(storage_sinks="", notify_sinks="")).has_external_sinks() is False
    assert DeliveryOrchestrator(Settings(storage_sinks="local,s3", notify_sinks="")).has_external_sinks() is True
    assert DeliveryOrchestrator(Settings(storage_sinks="local", notify_sinks="slack")).has_external_sinks() is True


def test_save_raw_backup_local_and_partial_cloud_failure(tmp_path):
    settings = Settings(
        storage_sinks="local,s3",
        notify_sinks="",
        local_reports_dir=str(tmp_path),
        s3_bucket="",  # misconfigured S3 should fail without blocking local
    )
    orch = DeliveryOrchestrator(settings)
    results = asyncio.run(
        orch.save_raw_backup("Dana Smith", {"candidate_name": "Dana Smith", "answers": {"1": "42"}})
    )
    by_sink = {r["sink"]: r for r in results}
    assert by_sink["local"]["ok"] is True
    assert by_sink["s3"]["ok"] is False
    assert by_sink["s3"]["error"]
    backup_path = Path(by_sink["local"]["uri"])
    assert backup_path.exists()
    assert json.loads(backup_path.read_text(encoding="utf-8"))["answers"] == {"1": "42"}


def test_zero_cloud_lock_in_missing_sdks_return_clear_errors(monkeypatch):
    # Ensure cloud SDKs are not required at import time and fail cleanly when absent
    for mod_name in ("boto3", "google.cloud.storage", "azure.storage.blob"):
        monkeypatch.setitem(sys.modules, mod_name, None)

    settings = Settings(
        storage_sinks="s3,gcs,azure",
        notify_sinks="",
        s3_bucket="my-bucket",
        gcs_bucket="my-gcs-bucket",
        azure_storage_connection_string="DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=abc;EndpointSuffix=core.windows.net",
        azure_storage_container="interviews",
    )
    orch = DeliveryOrchestrator(settings)
    out = asyncio.run(
        orch.deliver_report("Taylor", {"final_score": 5, "max_score": 10}, b"%PDF-1.4")
    )
    by_sink = {r["sink"]: r for r in out["storage"]}
    assert by_sink["s3"]["ok"] is False and "boto3" in by_sink["s3"]["error"].lower()
    assert by_sink["gcs"]["ok"] is False and "google-cloud-storage" in by_sink["gcs"]["error"].lower()
    assert by_sink["azure"]["ok"] is False and "azure-storage-blob" in by_sink["azure"]["error"].lower()
    assert out["local_pdf_path"] is None


def test_s3_sink_console_url_and_presigned_fallback(monkeypatch):
    mock_client = MagicMock()
    mock_client.generate_presigned_url.return_value = "https://signed.example.com/report.pdf"
    fake_boto3 = types.SimpleNamespace(client=MagicMock(return_value=mock_client))
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)

    # Default: console URL + s3:// URI
    s_default = Settings(
        storage_sinks="s3",
        notify_sinks="",
        s3_bucket="eval-bucket",
        s3_prefix="interviews",
        s3_region="us-west-2",
        storage_presigned_urls=False,
    )
    out_default = asyncio.run(
        DeliveryOrchestrator(s_default).deliver_report("Kim Lee", {"final_score": 10, "max_score": 10}, b"%PDF")
    )
    res_default = out_default["storage"][0]
    assert res_default["ok"] is True
    assert res_default["uri"].startswith("s3://eval-bucket/interviews/")
    assert "s3.console.aws.amazon.com" in res_default["url"]
    assert mock_client.put_object.call_count == 2  # PDF + JSON

    # Presigned enabled: returns presigned URL
    s_presigned = Settings(
        storage_sinks="s3",
        notify_sinks="",
        s3_bucket="eval-bucket",
        storage_presigned_urls=True,
        storage_presigned_ttl_seconds=3600,
    )
    out_presigned = asyncio.run(
        DeliveryOrchestrator(s_presigned).deliver_report("Kim Lee", {"final_score": 10, "max_score": 10}, b"%PDF")
    )
    assert out_presigned["storage"][0]["url"] == "https://signed.example.com/report.pdf"

    # Presigned signing failure falls back to raw URI
    mock_client.generate_presigned_url.side_effect = RuntimeError("signing failed")
    out_fallback = asyncio.run(
        DeliveryOrchestrator(s_presigned).deliver_report("Kim Lee", {"final_score": 10, "max_score": 10}, b"%PDF")
    )
    res_fallback = out_fallback["storage"][0]
    assert res_fallback["ok"] is True
    assert res_fallback["url"] == res_fallback["uri"]


def test_gcs_sink_console_url_and_presigned_fallback(monkeypatch):
    mock_blob = MagicMock()
    mock_blob.generate_signed_url.side_effect = RuntimeError("no private key on ADC")
    mock_bucket = MagicMock()
    mock_bucket.blob.return_value = mock_blob
    mock_client = MagicMock()
    mock_client.bucket.return_value = mock_bucket

    fake_gcs_storage = types.SimpleNamespace(Client=MagicMock(return_value=mock_client))
    fake_google_cloud = types.ModuleType("google.cloud")
    fake_google_cloud.storage = fake_gcs_storage
    fake_google = types.ModuleType("google")
    fake_google.cloud = fake_google_cloud

    monkeypatch.setitem(sys.modules, "google", fake_google)
    monkeypatch.setitem(sys.modules, "google.cloud", fake_google_cloud)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", fake_gcs_storage)

    settings = Settings(
        storage_sinks="gcs",
        notify_sinks="",
        gcs_bucket="gcs-eval-bucket",
        gcs_prefix="runs",
        storage_presigned_urls=True,
    )
    out = asyncio.run(
        DeliveryOrchestrator(settings).deliver_report("Pat", {"final_score": 7, "max_score": 10}, b"%PDF")
    )
    res = out["storage"][0]
    assert res["ok"] is True
    assert res["uri"].startswith("gs://gcs-eval-bucket/runs/")
    assert res["url"] == res["uri"]  # fell back to URI on signing error
    assert mock_blob.upload_from_string.call_count == 2


def test_azure_sink_uploads_and_returns_blob_url(monkeypatch):
    uploaded = []

    class FakeBlobClient:
        def __init__(self, key):
            self.key = key
            self.url = f"https://demoacct.blob.core.windows.net/reports/{key}"

        def upload_blob(self, data, overwrite=True, content_settings=None):
            uploaded.append((self.key, data, content_settings))

    class FakeContainerClient:
        def get_blob_client(self, key):
            return FakeBlobClient(key)

        def exists(self):
            return True

    class FakeBlobServiceClient:
        credential = None

        @classmethod
        def from_connection_string(cls, conn_str):
            return cls()

        def get_container_client(self, container):
            return FakeContainerClient()

    class FakeContentSettings:
        def __init__(self, content_type=None):
            self.content_type = content_type

    fake_azure_blob = types.ModuleType("azure.storage.blob")
    fake_azure_blob.BlobServiceClient = FakeBlobServiceClient
    fake_azure_blob.ContentSettings = FakeContentSettings
    fake_azure_storage = types.ModuleType("azure.storage")
    fake_azure_storage.blob = fake_azure_blob
    fake_azure = types.ModuleType("azure")
    fake_azure.storage = fake_azure_storage

    monkeypatch.setitem(sys.modules, "azure", fake_azure)
    monkeypatch.setitem(sys.modules, "azure.storage", fake_azure_storage)
    monkeypatch.setitem(sys.modules, "azure.storage.blob", fake_azure_blob)

    settings = Settings(
        storage_sinks="azure",
        notify_sinks="",
        azure_storage_connection_string="DefaultEndpointsProtocol=https;AccountName=demoacct;AccountKey=ZmFrZQ==;EndpointSuffix=core.windows.net",
        azure_storage_container="reports",
        azure_storage_prefix="interviews",
    )
    out = asyncio.run(
        DeliveryOrchestrator(settings).deliver_report("Robin", {"final_score": 8, "max_score": 10}, b"%PDF")
    )
    res = out["storage"][0]
    assert res["ok"] is True
    assert res["uri"].startswith("https://demoacct.blob.core.windows.net/reports/interviews/")
    assert res["url"] == res["uri"]
    assert len(uploaded) == 2


def test_teams_and_webhook_without_secret(tmp_path):
    settings = Settings(
        storage_sinks="local",
        notify_sinks="teams,webhook",
        local_reports_dir=str(tmp_path),
        teams_webhook_url="https://outlook.office.com/webhook/demo",
        webhook_url="https://hooks.example.com/events",
        webhook_secret="",
        webhook_include_pdf_base64=False,
    )
    orch = DeliveryOrchestrator(settings)
    calls = []

    async def fake_post(self, url, **kwargs):
        calls.append((url, kwargs))
        resp = MagicMock()
        resp.status_code = 200
        resp.text = "ok"
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        out = asyncio.run(
            orch.deliver_report(
                "Morgan",
                {"candidate_name": "Morgan", "role_title": "Data Eng", "final_score": 75, "max_score": 100},
                b"%PDF-1.4",
            )
        )

    statuses = {n["sink"]: n["ok"] for n in out["notifications"]}
    assert statuses == {"teams": True, "webhook": True}

    webhook_call = next(kw for url, kw in calls if "hooks.example.com" in url)
    assert "X-Signature-256" not in webhook_call.get("headers", {})
    payload = json.loads(webhook_call["content"].decode())
    assert "pdf_base64" not in payload
    assert payload["storage"][0]["sink"] == "local"

    teams_call = next(kw for url, kw in calls if "outlook.office.com" in url)
    assert teams_call["json"]["type"] == "message"


def test_sink_connectivity_checks(tmp_path):
    settings = Settings(
        storage_sinks="local",
        notify_sinks="webhook",
        local_reports_dir=str(tmp_path),
        webhook_url="https://hooks.example.com/test",
    )
    orch = DeliveryOrchestrator(settings)

    local_res = asyncio.run(orch.test_sink("local"))
    assert local_res["sink"] == "local" and local_res["ok"] is True

    async def fake_post(self, url, **kwargs):
        resp = MagicMock()
        resp.status_code = 204
        resp.text = ""
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        hook_res = asyncio.run(orch.test_sink("webhook"))
    assert hook_res["sink"] == "webhook" and hook_res["ok"] is True

    unknown_res = asyncio.run(orch.test_sink("carrier_pigeon"))
    assert unknown_res["sink"] == "carrier_pigeon" and unknown_res["ok"] is False


def test_smtp_sanitizes_headers_and_tests_connection():
    settings = Settings(
        storage_sinks="",
        notify_sinks="smtp",
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_from="bot@example.com",
        smtp_to="hr@example.com, lead@example.com",
        smtp_user="bot",
        smtp_password="pw",
    )
    orch = DeliveryOrchestrator(settings)
    sent = []
    with patch("smtplib.SMTP") as mock_smtp:
        inst = mock_smtp.return_value.__enter__.return_value
        inst.send_message.side_effect = lambda msg: sent.append(msg)
        out = asyncio.run(
            orch.deliver_report(
                "Evil\r\nBcc: attacker@example.com",
                {"candidate_name": "Evil\r\nName", "role_title": "Eng\nLead", "final_score": 10, "max_score": 10},
                b"%PDF-1.4",
            )
        )
        test_res = asyncio.run(orch.test_sink("smtp"))

    assert out["notifications"][0]["ok"] is True
    assert "\r" not in sent[0]["Subject"] and "\n" not in sent[0]["Subject"]
    assert test_res["ok"] is True
    inst.noop.assert_called_once()


def test_slack_bot_token_mode_posts_message_and_uploads_pdf():
    settings = Settings(
        storage_sinks="",
        notify_sinks="slack",
        slack_bot_token="xoxb-test-token",
        slack_channel_id="C12345",
    )
    orch = DeliveryOrchestrator(settings)
    urls_called = []

    async def fake_post(self, url, **kwargs):
        urls_called.append(url)
        resp = MagicMock()
        resp.status_code = 200
        resp.text = "ok"
        if url.endswith("/chat.postMessage"):
            resp.json.return_value = {"ok": True, "ts": "123"}
        elif url.endswith("/files.getUploadURLExternal"):
            resp.json.return_value = {"ok": True, "upload_url": "https://files.slack.com/upload/v1/abc", "file_id": "F123"}
        elif url.endswith("/files.completeUploadExternal"):
            resp.json.return_value = {"ok": True}
        elif url.endswith("/auth.test"):
            resp.json.return_value = {"ok": True}
        else:
            resp.json.return_value = {"ok": True}
        return resp

    with patch("httpx.AsyncClient.post", new=fake_post):
        out = asyncio.run(
            orch.deliver_report("Alex", {"final_score": 9, "max_score": 10}, b"%PDF-slack")
        )
        check = asyncio.run(orch.test_sink("slack"))

    assert out["notifications"][0]["ok"] is True
    assert "PDF uploaded" in out["notifications"][0]["detail"]
    assert any(u.endswith("/chat.postMessage") for u in urls_called)
    assert any(u.endswith("/files.completeUploadExternal") for u in urls_called)
    assert check["ok"] is True


def test_overall_feedback_summary_appears_in_smtp_slack_and_teams():
    """Regression test: LLM generate_summary's overall_feedback key reaches SMTP, Slack, and Teams."""
    settings = Settings(
        storage_sinks="",
        notify_sinks="smtp,slack,teams",
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_from="bot@example.com",
        smtp_to="hr@example.com",
        slack_webhook_url="https://hooks.slack.com/services/T/B/X",
        teams_webhook_url="https://outlook.office.com/webhook/demo",
    )
    orch = DeliveryOrchestrator(settings)
    feedback_text = "Candidate showed strong distributed systems design and clean SQL reasoning."
    sent_emails = []
    webhook_calls = []

    async def fake_post(self, url, **kwargs):
        webhook_calls.append((url, kwargs))
        resp = MagicMock()
        resp.status_code = 200
        resp.text = "ok"
        return resp

    with (
        patch("smtplib.SMTP") as mock_smtp,
        patch("httpx.AsyncClient.post", new=fake_post),
    ):
        inst = mock_smtp.return_value.__enter__.return_value
        inst.send_message.side_effect = lambda msg: sent_emails.append(msg)
        out = asyncio.run(
            orch.deliver_report(
                "Avery Chen",
                {
                    "candidate_name": "Avery Chen",
                    "role_title": "Staff Engineer",
                    "final_score": 46,
                    "max_score": 50,
                    "summary": {"overall_feedback": feedback_text},
                },
                b"%PDF-1.4",
            )
        )

    assert all(n["ok"] is True for n in out["notifications"])

    # SMTP body contains overall_feedback
    email_body = sent_emails[0].get_body(preferencelist=("plain",)).get_content()
    assert feedback_text in email_body

    # Slack payload contains overall_feedback
    slack_payload = next(kw["json"] for url, kw in webhook_calls if "hooks.slack.com" in url)
    assert feedback_text in json.dumps(slack_payload)

    # Teams Adaptive Card payload contains overall_feedback
    teams_payload = next(kw["json"] for url, kw in webhook_calls if "outlook.office.com" in url)
    assert feedback_text in json.dumps(teams_payload)


def test_smtp_tls_passes_verified_ssl_context():
    """Regression test: SMTP STARTTLS (587) and SMTP_SSL (465) pass a default verified SSLContext."""
    import ssl

    settings_587 = Settings(
        storage_sinks="",
        notify_sinks="smtp",
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_use_tls=True,
        smtp_from="bot@example.com",
        smtp_to="hr@example.com",
    )
    with patch("smtplib.SMTP") as mock_smtp:
        inst = mock_smtp.return_value.__enter__.return_value
        res = asyncio.run(DeliveryOrchestrator(settings_587).test_sink("smtp"))
    assert res["ok"] is True
    inst.starttls.assert_called_once()
    ctx_587 = inst.starttls.call_args.kwargs.get("context")
    assert isinstance(ctx_587, ssl.SSLContext)
    assert ctx_587.check_hostname is True
    assert ctx_587.verify_mode == ssl.CERT_REQUIRED

    settings_465 = Settings(
        storage_sinks="",
        notify_sinks="smtp",
        smtp_host="smtp.example.com",
        smtp_port=465,
        smtp_use_tls=True,
        smtp_from="bot@example.com",
        smtp_to="hr@example.com",
    )
    with patch("smtplib.SMTP_SSL") as mock_smtp_ssl:
        res_ssl = asyncio.run(DeliveryOrchestrator(settings_465).test_sink("smtp"))
    assert res_ssl["ok"] is True
    mock_smtp_ssl.assert_called_once()
    ctx_465 = mock_smtp_ssl.call_args.kwargs.get("context")
    assert isinstance(ctx_465, ssl.SSLContext)
    assert ctx_465.check_hostname is True
    assert ctx_465.verify_mode == ssl.CERT_REQUIRED


