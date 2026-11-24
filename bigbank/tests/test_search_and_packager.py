"""Tests for SSRF-hardened search/proxy, SQLite bundle packager, and CLI."""

from __future__ import annotations

import asyncio
import sqlite3
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.config import Settings
from backend.db.database import DatabaseManager
from backend.db.repository import InterviewRepository
from backend.services.packager import build_deployment_bundle, get_deploy_readiness
from backend.services.search import (
    MAX_PROXY_BYTES,
    fetch_proxied_url,
    search_duckduckgo,
    validate_public_url,
)


# ---------------------------------------------------------------------------
# Brief-pinned tests
# ---------------------------------------------------------------------------


def test_ssrf_guard_blocks_private_metadata_and_bad_schemes():
    for bad in [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8080/api/admin/questions",
        "http://10.0.0.5/internal",
        "http://192.168.1.1/",
        "file:///etc/passwd",
        "http://[::1]/secret",
    ]:
        with pytest.raises(ValueError):
            validate_public_url(bad)


def _make_stream_response(
    *,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
    chunks: list[bytes] | None = None,
    charset_encoding: str | None = "utf-8",
):
    """Build a fake httpx streaming response compatible with `async with client.stream(...)`."""
    chunk_list = chunks if chunks is not None else [b""]

    class _FakeStreamResp:
        def __init__(self) -> None:
            self.status_code = status_code
            self.headers = headers or {}
            self.charset_encoding = charset_encoding
            self.chunks_read = 0

        async def aiter_bytes(self):
            for chunk in chunk_list:
                self.chunks_read += 1
                yield chunk

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    return _FakeStreamResp()


def test_proxy_blocks_redirect_to_private_ip():
    redirect_resp = _make_stream_response(
        status_code=302,
        headers={"location": "http://169.254.169.254/latest/meta-data/"},
    )
    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        with patch("httpx.AsyncClient.stream", return_value=redirect_resp):
            with pytest.raises(ValueError):
                asyncio.run(fetch_proxied_url("https://example.com/start"))


def test_packager_strips_submissions_and_unused_questions(tmp_path):
    src_db = DatabaseManager(tmp_path / "src.db", tmp_path / "src.db")
    src_db.init_schemas()
    repo = InterviewRepository(src_db)
    q_keep = repo.create_question(
        {
            "prompt": "Keep",
            "format": "text",
            "difficulty": "easy",
            "default_points": 10,
            "tags": ["ai"],
        }
    )
    repo.create_question(
        {
            "prompt": "Drop",
            "format": "text",
            "difficulty": "easy",
            "default_points": 10,
            "tags": ["unused"],
        }
    )
    repo.create_template(
        {
            "slug": "ai-only",
            "name": "AI Only",
            "role_title": "AI Eng",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "allow_code_execution": False,
            "allow_package_install": False,
            "access_code": "code1",
            "summary_dimensions": ["AI"],
            "is_default": True,
            "questions": [{"question_id": q_keep["id"], "position": 0}],
        }
    )
    repo.create_submission(
        {
            "id": "local-pii",
            "template_id": 1,
            "template_name": "AI Only",
            "role_title": "AI Eng",
            "candidate_name": "Private Candidate",
            "status": "completed",
        }
    )

    out_path = tmp_path / "bundle" / "interview.db"
    summary = build_deployment_bundle(repo, out_path, template_slugs=["ai-only"])
    assert summary["templates_count"] == 1 and summary["questions_count"] == 1
    assert summary["tags_count"] == 1
    assert summary["template_slugs"] == ["ai-only"]
    assert summary["size_bytes"] > 0

    conn = sqlite3.connect(out_path)
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM submissions").fetchone()[0] == 0
    conn.close()


# ---------------------------------------------------------------------------
# Additional SSRF, Search & Proxy tests
# ---------------------------------------------------------------------------


def test_ssrf_guard_blocks_cgnat_ipv6_ula_localhost_and_dns_private():
    for bad in [
        "http://100.64.0.1/cgnat",
        "http://172.16.0.10/corp",
        "http://0.0.0.0/",
        "http://[fc00::1]/ula",
        "http://[fe80::1]/link-local",
        "http://[::ffff:169.254.169.254]/mapped",
        "http://localhost:8080/admin",
        "http://sub.localhost/admin",
        "ftp://example.com/file",
        "javascript:alert(1)",
        "",
    ]:
        with pytest.raises(ValueError):
            validate_public_url(bad)

    with patch("backend.services.search._resolve_ips", return_value=["10.20.30.40"]):
        with pytest.raises(ValueError):
            validate_public_url("https://internal.example.test/secret")

    with patch(
        "backend.services.search._resolve_ips",
        return_value=["93.184.216.34", "169.254.169.254"],
    ):
        with pytest.raises(ValueError):
            validate_public_url("https://dual-homed.example.test/")

    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        assert validate_public_url("https://example.com/docs") == "https://example.com/docs"


def test_proxy_follows_valid_redirect_injects_base_and_enforces_limits():
    redirect_resp = _make_stream_response(
        status_code=301,
        headers={"Location": "/docs/page.html"},
    )
    final_html = '<html><head><title>Docs</title></head><body><a href="ref.html">Ref</a></body></html>'
    ok_resp = _make_stream_response(
        status_code=200,
        headers={"Content-Type": "text/html; charset=utf-8"},
        chunks=[final_html.encode("utf-8")],
    )
    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        with patch(
            "httpx.AsyncClient.stream",
            side_effect=[redirect_resp, ok_resp],
        ):
            body, content_type, status_code = asyncio.run(
                fetch_proxied_url("https://example.com/start")
            )
    assert status_code == 200
    assert "text/html" in content_type
    decoded = body.decode("utf-8")
    assert '<base href="https://example.com/docs/page.html">' in decoded

    # Exceeding max 5 redirect hops must raise ValueError
    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        with patch(
            "httpx.AsyncClient.stream",
            side_effect=lambda *args, **kwargs: _make_stream_response(
                status_code=302,
                headers={"Location": "https://example.com/loop"},
            ),
        ):
            with pytest.raises(ValueError, match="redirect"):
                asyncio.run(fetch_proxied_url("https://example.com/loop"))

    # Exceeding 5 MB response cap (chunked streaming WITHOUT Content-Length) aborts early
    chunk_1mb = b"x" * (1024 * 1024)
    chunked_oversized_resp = _make_stream_response(
        status_code=200,
        headers={"Content-Type": "application/octet-stream"},
        chunks=[chunk_1mb] * 12,  # 12 MB total, no Content-Length header
    )
    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        with patch(
            "httpx.AsyncClient.stream",
            return_value=chunked_oversized_resp,
        ):
            with pytest.raises(ValueError, match="5 MB"):
                asyncio.run(fetch_proxied_url("https://example.com/huge-chunked.bin"))
    # Must abort immediately once 5 MB is exceeded without reading all 12 chunks
    assert chunked_oversized_resp.chunks_read <= 6

    # Exceeding 5 MB via Content-Length header aborts before reading any chunk
    oversized_header_resp = _make_stream_response(
        status_code=200,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(MAX_PROXY_BYTES + 100),
        },
        chunks=[b"small"],
    )
    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        with patch(
            "httpx.AsyncClient.stream",
            return_value=oversized_header_resp,
        ):
            with pytest.raises(ValueError, match="5 MB"):
                asyncio.run(fetch_proxied_url("https://example.com/huge-header.bin"))
    assert oversized_header_resp.chunks_read == 0

    # Binary content passes through untouched without <base href> injection
    png_bytes = b"\x89PNG\r\n\x1a\nfake"
    bin_resp = _make_stream_response(
        status_code=200,
        headers={"Content-Type": "image/png"},
        chunks=[png_bytes],
    )
    with patch("backend.services.search._resolve_ips", return_value=["93.184.216.34"]):
        with patch("httpx.AsyncClient.stream", return_value=bin_resp):
            body, ctype, status = asyncio.run(
                fetch_proxied_url("https://example.com/logo.png")
            )
    assert body == png_bytes
    assert ctype == "image/png"
    assert status == 200


def test_search_duckduckgo_parses_results_and_handles_errors():
    sample_html = """
    <html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&rut=abc">Python 3 Docs</a>
        <a class="result__snippet">Official Python documentation.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://pandas.pydata.org/docs/">Pandas Docs</a>
        <a class="result__snippet">Data analysis library.</a>
      </div>
    </body></html>
    """
    ok_resp = MagicMock(status_code=200, text=sample_html)
    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=ok_resp)):
        out = asyncio.run(search_duckduckgo("python pandas"))

    assert out["error"] is None
    assert "duckduckgo.com/?q=python+pandas" in out["search_url"]
    assert len(out["results"]) == 2
    assert out["results"][0]["title"] == "Python 3 Docs"
    assert out["results"][0]["url"] == "https://docs.python.org/3/"
    assert out["results"][0]["snippet"] == "Official Python documentation."

    # Network failure returns graceful error dict
    with patch(
        "httpx.AsyncClient.post",
        new=AsyncMock(side_effect=RuntimeError("network unreachable")),
    ):
        err_out = asyncio.run(search_duckduckgo("python"))
    assert err_out["results"] == []
    assert err_out["error"] is not None


# ---------------------------------------------------------------------------
# Packager (random_pool + deploy readiness) & CLI tests
# ---------------------------------------------------------------------------


def test_packager_bundles_random_pool_matching_active_questions(tmp_path):
    src_db = DatabaseManager(tmp_path / "src.db", tmp_path / "src.db")
    src_db.init_schemas()
    repo = InterviewRepository(src_db)

    repo.create_question(
        {
            "prompt": "Active SQL Q",
            "format": "text",
            "difficulty": "easy",
            "tags": ["sql", "de"],
            "active": True,
        }
    )
    repo.create_question(
        {
            "prompt": "Inactive SQL Q",
            "format": "text",
            "difficulty": "easy",
            "tags": ["sql"],
            "active": False,
        }
    )
    repo.create_question(
        {
            "prompt": "Unrelated PM Q",
            "format": "text",
            "difficulty": "medium",
            "tags": ["pm"],
            "active": True,
        }
    )
    repo.create_template(
        {
            "slug": "sql-pool",
            "name": "SQL Pool",
            "role_title": "Data Engineer",
            "selection_mode": "random_pool",
            "random_rules": {"tags": ["sql"], "match": "any", "total": 5},
            "timer_minutes": 45,
            "open_book_policy": "medium_hard",
            "summary_dimensions": ["SQL"],
            "is_default": True,
        }
    )

    out_path = tmp_path / "bundle" / "sql.db"
    summary = build_deployment_bundle(repo, out_path, template_slugs=["sql-pool"])
    assert summary["templates_count"] == 1
    assert summary["questions_count"] == 1
    assert summary["tags_count"] == 2  # sql, de

    # Verify bundled DB can be opened read-only and resolve template questions
    bundled_db = DatabaseManager(
        out_path, tmp_path / "runtime.db", catalog_read_only=True
    )
    bundled_db.init_schemas()
    bundled_repo = InterviewRepository(bundled_db)
    tpl = bundled_repo.get_template_by_slug("sql-pool")
    assert tpl is not None
    resolved = bundled_repo.resolve_template_questions(tpl["id"])
    assert len(resolved) == 1
    assert resolved[0]["prompt"] == "Active SQL Q"

    with pytest.raises(ValueError, match="not found"):
        build_deployment_bundle(repo, out_path, template_slugs=["does-not-exist"])


def test_get_deploy_readiness_warnings_and_secret_free_snippets(tmp_path):
    missing_bundle = tmp_path / "missing.db"
    settings = Settings(
        llm_provider="none",
        llm_api_key="super-secret-llm-key",
        admin_password="super-secret-admin-pw",
        storage_sinks="local",
        notify_sinks="",
    )
    readiness = get_deploy_readiness(settings, missing_bundle)
    assert readiness["bundle_exists"] is False
    assert readiness["has_external_sink"] is False
    assert readiness["llm_configured"] is False
    assert len(readiness["warnings"]) == 3
    assert set(readiness["snippets"].keys()) == {
        "docker",
        "cloud_run",
        "aws_app_runner",
        "azure_container_apps",
        "fly_io",
    }
    for snippet in readiness["snippets"].values():
        assert "super-secret-llm-key" not in snippet
        assert "super-secret-admin-pw" not in snippet

    # When bundle exists, external sink configured, and LLM configured -> zero warnings
    existing_bundle = tmp_path / "ready.db"
    existing_bundle.write_bytes(b"sqlite-placeholder")
    ready_settings = Settings(
        llm_provider="openai",
        llm_model="gpt-4o-mini",
        llm_api_key="sk-test-secret",
        storage_sinks="s3,gcs",
        notify_sinks="slack,smtp",
        s3_bucket="my-interview-reports",
    )
    ready = get_deploy_readiness(ready_settings, existing_bundle)
    assert ready["bundle_exists"] is True
    assert ready["has_external_sink"] is True
    assert ready["llm_configured"] is True
    assert ready["warnings"] == []
    for snippet in ready["snippets"].values():
        assert "sk-test-secret" not in snippet
    # Cloud Run snippet must use ^|^ delimiter so comma-separated sinks don't break gcloud
    assert '--set-env-vars "^|^APP_MODE=candidate|' in ready["snippets"]["cloud_run"]
    assert "|STORAGE_SINKS=s3,gcs|NOTIFY_SINKS=slack,smtp\"" in ready["snippets"]["cloud_run"]


def test_cli_seed_package_and_check_sinks(tmp_path, capsys):
    from backend import cli

    db_path = tmp_path / "interview.db"
    bundle_path = tmp_path / "bundle" / "interview.db"

    rc_seed = cli.main(["seed", "--db", str(db_path)])
    assert rc_seed == 0
    out_seed = capsys.readouterr().out
    assert "Seeded" in out_seed

    # Re-seeding is idempotent (0 newly created questions/templates)
    rc_reseed = cli.main(["seed", "--db", str(db_path)])
    assert rc_reseed == 0
    out_reseed = capsys.readouterr().out
    assert "0 created" in out_reseed and "0 template(s) created" in out_reseed

    rc_pkg = cli.main(
        [
            "package",
            "--db",
            str(db_path),
            "--templates",
            "data-engineer,ai-engineer",
            "--output",
            str(bundle_path),
        ]
    )
    assert rc_pkg == 0
    assert bundle_path.exists()
    out_pkg = capsys.readouterr().out
    assert "Bundle created" in out_pkg
    assert "2 templates" in out_pkg

    with patch(
        "backend.cli.get_settings",
        return_value=Settings(
            storage_sinks="local",
            local_reports_dir=str(tmp_path / "reports"),
            notify_sinks="",
        ),
    ):
        rc_check = cli.main(["check-sinks"])
    assert rc_check == 0
    out_check = capsys.readouterr().out
    assert "PASS" in out_check
