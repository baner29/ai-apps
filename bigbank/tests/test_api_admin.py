"""Tests for the Admin FastAPI router, mode/auth gating, manual grading, settings & deploy."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Settings


def test_candidate_mode_hides_admin_and_enforces_readonly_with_password(tmp_path: Path):
    app_closed = create_app(
        Settings(
            app_mode="candidate",
            bundle_path=str(tmp_path / "b.db"),
            runtime_db_path=str(tmp_path / "r.db"),
            admin_password="",
        )
    )
    c_closed = TestClient(app_closed)
    assert c_closed.get("/api/admin/questions").status_code == 404
    assert c_closed.get("/api/admin/status").status_code == 404
    assert c_closed.get("/admin").status_code == 404
    assert c_closed.get("/admin/questions").status_code == 404

    app_ro = create_app(
        Settings(
            app_mode="candidate",
            bundle_path=str(tmp_path / "b2.db"),
            runtime_db_path=str(tmp_path / "r2.db"),
            admin_password="pw123",
        )
    )
    c_ro = TestClient(app_ro)
    status_before = c_ro.get("/api/admin/status").json()
    assert status_before["mode"] == "candidate"
    assert status_before["read_only"] is True
    assert status_before["auth_required"] is True
    assert status_before["authenticated"] is False

    assert c_ro.get("/api/admin/questions").status_code == 401
    assert c_ro.post("/api/admin/auth/login", json={"password": "wrong"}).status_code == 401

    tok = c_ro.post("/api/admin/auth/login", json={"password": "pw123"}).json()["token"]
    hdr = {"Authorization": f"Bearer {tok}"}

    status_after = c_ro.get("/api/admin/status", headers=hdr).json()
    assert status_after["authenticated"] is True

    assert c_ro.get("/api/admin/questions", headers=hdr).status_code == 200
    assert (
        c_ro.post(
            "/api/admin/questions",
            headers=hdr,
            json={"prompt": "No", "format": "text", "difficulty": "easy", "default_points": 10},
        ).status_code
        == 403
    )
    assert c_ro.put("/api/admin/settings", headers=hdr, json={"app_title": "Nope"}).status_code == 403
    assert c_ro.post("/api/admin/deploy/bundle", headers=hdr).status_code == 403


def test_manual_grade_override_recalculates_score_and_regenerates_pdf(tmp_path: Path):
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            llm_provider="none",
            storage_sinks="local",
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q = c.post(
        "/api/admin/questions",
        json={
            "prompt": "Design",
            "format": "text",
            "difficulty": "hard",
            "default_points": 30,
            "tags": ["arch"],
        },
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "arch",
            "name": "Arch",
            "role_title": "Architect",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "allow_code_execution": False,
            "allow_package_install": False,
            "access_code": "a1",
            "summary_dimensions": ["Design"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )
    login = c.post(
        "/api/public/login",
        json={"slug": "arch", "candidate_name": "Pat", "access_code": "a1"},
    ).json()
    c.post(
        "/api/public/finish",
        json={
            "session_token": login["session_token"],
            "candidate_name": "Pat",
            "slug": "arch",
            "answers": [{"question_id": q["id"], "answer": "Microservices"}],
        },
    )
    sub_id = c.get("/api/admin/results").json()[0]["id"]
    patched_resp = c.patch(
        f"/api/admin/results/{sub_id}/grade",
        json={"question_id": q["id"], "score": 27, "feedback": "Strong breakdown"},
    )
    assert patched_resp.status_code == 200
    patched = patched_resp.json()
    assert patched["final_score"] == 27 and patched["score_percentage"] == 90.0
    assert patched["status"] == "completed"

    pdf_resp = c.get(f"/api/admin/results/{sub_id}/pdf")
    assert pdf_resp.status_code == 200 and pdf_resp.content.startswith(b"%PDF")

    regen_resp = c.post(f"/api/admin/results/{sub_id}/regenerate-pdf")
    assert regen_resp.status_code == 200 and regen_resp.json()["ok"] is True

    redeliver_resp = c.post(f"/api/admin/results/{sub_id}/redeliver")
    assert redeliver_resp.status_code == 200 and redeliver_resp.json()["ok"] is True


def test_admin_crud_bulk_import_export_settings_and_deploy_bundle(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("APP_TITLE", "BigBank")
    env_file = tmp_path / ".env"
    bundle_file = tmp_path / "bundle" / "interview.db"
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            bundle_path=str(bundle_file),
            local_reports_dir=str(tmp_path / "reports"),
            llm_provider="none",
            llm_api_key="super-secret-llm-key",
            storage_sinks="local",
            auto_seed_examples=False,
        ),
        env_path=env_file,
    )
    c = TestClient(app)

    # Sample download
    sample_resp = c.get("/api/admin/questions/sample", params={"format": "yaml"})
    assert sample_resp.status_code == 200
    assert "questions:" in sample_resp.text

    # Bulk import preview & commit
    yaml_payload = (
        "questions:\n"
        "  - external_key: q-1\n"
        "    title: Window Fn\n"
        "    prompt: Explain RANK vs DENSE_RANK\n"
        "    format: text\n"
        "    difficulty: medium\n"
        "    tags: [sql, analytics]\n"
        "    default_points: 15\n"
    ).encode("utf-8")

    prev = c.post(
        "/api/admin/questions/import/preview",
        files={"file": ("batch.yaml", yaml_payload, "application/x-yaml")},
    )
    assert prev.status_code == 200
    assert prev.json()["new_count"] == 1
    assert prev.json()["invalid_count"] == 0

    comm = c.post(
        "/api/admin/questions/import/commit",
        files={"file": ("batch.yaml", yaml_payload, "application/x-yaml")},
        data={"duplicate_strategy": "skip"},
    )
    assert comm.status_code == 200
    assert comm.json()["created"] == 1

    # Export JSON
    exp = c.get("/api/admin/questions/export", params={"format": "json"})
    assert exp.status_code == 200
    assert len(exp.json()["questions"]) == 1

    # Tags
    tags = c.get("/api/admin/tags").json()
    tag_names = [t["name"] for t in tags]
    assert "sql" in tag_names and "analytics" in tag_names

    # Template create, clone, preview
    q_id = c.get("/api/admin/questions").json()[0]["id"]
    tpl = c.post(
        "/api/admin/templates",
        json={
            "slug": "sql-screen",
            "name": "SQL Screen",
            "role_title": "Analytics Engineer",
            "selection_mode": "curated",
            "timer_minutes": 40,
            "open_book_policy": "none",
            "summary_dimensions": ["SQL"],
            "is_default": True,
            "questions": [{"question_id": q_id, "position": 0, "points_override": 25}],
        },
    ).json()

    preview = c.get(f"/api/admin/templates/{tpl['id']}/preview").json()
    assert preview["total_points"] == 25

    cloned = c.post(
        f"/api/admin/templates/{tpl['id']}/clone",
        json={"slug": "sql-screen-v2", "name": "SQL Screen V2"},
    ).json()
    assert cloned["slug"] == "sql-screen-v2"

    # Settings masked + update preserves existing secret if left blank
    masked = c.get("/api/admin/settings").json()
    assert masked["llm_api_key"] == ""
    assert masked["llm_api_key_set"] is True

    updated_settings = c.put(
        "/api/admin/settings",
        json={"app_title": "Custom Interview Portal", "llm_api_key": ""},
    ).json()
    assert updated_settings["app_title"] == "Custom Interview Portal"
    assert updated_settings["llm_api_key_set"] is True

    # Test sink
    sink_test = c.post("/api/admin/settings/test", json={"target": "local"}).json()
    assert sink_test["ok"] is True

    # Deploy readiness & bundle
    readiness_before = c.get("/api/admin/deploy/status").json()
    assert readiness_before["bundle_exists"] is False

    bundle_resp = c.post(
        "/api/admin/deploy/bundle",
        json={"template_slugs": ["sql-screen"]},
    )
    assert bundle_resp.status_code == 200
    assert bundle_resp.json()["templates_count"] == 1
    assert bundle_file.is_file()

    readiness_after = c.get("/api/admin/deploy/status").json()
    assert readiness_after["bundle_exists"] is True


def test_auto_seed_examples_on_first_boot_in_local_mode(tmp_path: Path):
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "seeded.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            auto_seed_examples=True,
        )
    )
    c = TestClient(app)
    questions = c.get("/api/admin/questions").json()
    templates = c.get("/api/admin/templates").json()
    assert len(questions) >= 10
    assert len(templates) >= 4


def test_spa_serving_fallback_and_admin_spa_gating(tmp_path: Path):
    spa_dir = tmp_path / "static_spa"
    spa_dir.mkdir()
    (spa_dir / "index.html").write_text("<html><body>SPA_INDEX</body></html>", encoding="utf-8")
    (spa_dir / "app.js").write_text("console.log('spa');", encoding="utf-8")

    with patch("backend.app._SPA_CANDIDATE_DIRS", (spa_dir,)):
        app_candidate_closed = create_app(
            Settings(
                app_mode="candidate",
                bundle_path=str(tmp_path / "b.db"),
                runtime_db_path=str(tmp_path / "r.db"),
                admin_password="",
            )
        )
        c_closed = TestClient(app_candidate_closed)
        assert c_closed.get("/").status_code == 200
        assert "SPA_INDEX" in c_closed.get("/").text
        assert "SPA_INDEX" in c_closed.get("/i/data-engineer").text
        assert "console.log('spa')" in c_closed.get("/app.js").text
        assert c_closed.get("/admin").status_code == 404
        assert c_closed.get("/admin/results").status_code == 404
        assert c_closed.get("/api/nonexistent").status_code == 404

        app_candidate_pw = create_app(
            Settings(
                app_mode="candidate",
                bundle_path=str(tmp_path / "b2.db"),
                runtime_db_path=str(tmp_path / "r2.db"),
                admin_password="secret",
            )
        )
        c_pw = TestClient(app_candidate_pw)
        assert c_pw.get("/admin").status_code == 200
        assert "SPA_INDEX" in c_pw.get("/admin").text


def test_admin_status_exempt_from_read_auth_when_password_set(tmp_path: Path):
    """Regression test: GET /api/admin/status returns 200 (never 401) when ADMIN_PASSWORD is set."""
    for mode, expected_ro in (("local", False), ("candidate", True)):
        app = create_app(
            Settings(
                app_mode=mode,
                database_path=str(tmp_path / f"{mode}.db"),
                bundle_path=str(tmp_path / f"{mode}_bundle.db"),
                runtime_db_path=str(tmp_path / f"{mode}_runtime.db"),
                admin_password="admin-secret-pw",
                auto_seed_examples=False,
            )
        )
        c = TestClient(app)

        # Unauthenticated status check must succeed with 200 and authenticated=False
        resp_unauth = c.get("/api/admin/status")
        assert resp_unauth.status_code == 200
        body = resp_unauth.json()
        assert body["mode"] == mode
        assert body["read_only"] is expected_ro
        assert body["auth_required"] is True
        assert body["authenticated"] is False

        # Invalid Bearer token still returns 200 with authenticated=False
        resp_bad = c.get("/api/admin/status", headers={"Authorization": "Bearer forged.token"})
        assert resp_bad.status_code == 200
        assert resp_bad.json()["authenticated"] is False

        # Login succeeds and status reports authenticated=True
        tok = c.post("/api/admin/auth/login", json={"password": "admin-secret-pw"}).json()["token"]
        resp_auth = c.get("/api/admin/status", headers={"Authorization": f"Bearer {tok}"})
        assert resp_auth.status_code == 200
        assert resp_auth.json()["authenticated"] is True


def test_admin_settings_rejects_disallowed_and_system_env_keys(tmp_path: Path):
    """Regression test: PUT /api/admin/settings rejects unknown/system keys like PATH or APP_MODE with HTTP 400."""
    env_file = tmp_path / ".env"
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            auto_seed_examples=False,
        ),
        env_path=env_file,
    )
    c = TestClient(app)

    for forbidden_payload in (
        {"PATH": "/malicious/bin"},
        {"APP_MODE": "candidate"},
        {"DATABASE_PATH": "/tmp/hijack.db"},
        {"RUNTIME_DB_PATH": "/tmp/hijack_runtime.db"},
        {"SANDBOX_OS_USER": "root"},
        {"UNKNOWN_ARBITRARY_KEY": "value"},
        {"app_title": "Valid", "LD_PRELOAD": "/tmp/evil.so"},
        {"clear_secrets": ["PATH"]},
    ):
        resp = c.put("/api/admin/settings", json=forbidden_payload)
        assert resp.status_code == 400, f"Expected 400 for {forbidden_payload}, got {resp.status_code}"

    assert not env_file.exists()


def test_candidate_mode_allows_authenticated_settings_test(tmp_path: Path):
    """Regression test: read-only candidate mode allows authenticated POST /api/admin/settings/test."""
    app = create_app(
        Settings(
            app_mode="candidate",
            bundle_path=str(tmp_path / "b.db"),
            runtime_db_path=str(tmp_path / "r.db"),
            local_reports_dir=str(tmp_path / "reports"),
            admin_password="readonly-admin-pass",
        )
    )
    c = TestClient(app)

    # Unauthenticated request is rejected with 401
    assert c.post("/api/admin/settings/test", json={"target": "local"}).status_code == 401

    # Authenticated read-only admin succeeds (not 403)
    tok = c.post("/api/admin/auth/login", json={"password": "readonly-admin-pass"}).json()["token"]
    resp = c.post(
        "/api/admin/settings/test",
        json={"target": "local"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_candidate_mode_emits_startup_warning_without_external_sinks(tmp_path: Path, caplog):
    """Regression test: APP_MODE=candidate without external sinks logs a prominent warning."""
    import logging

    with caplog.at_level(logging.WARNING, logger="backend.app"):
        create_app(
            Settings(
                app_mode="candidate",
                bundle_path=str(tmp_path / "warn_b.db"),
                runtime_db_path=str(tmp_path / "warn_r.db"),
                storage_sinks="local",
                notify_sinks="",
            )
        )
    assert any(
        "ephemeral" in rec.message.lower() and "candidate" in rec.message.lower()
        for rec in caplog.records
    )

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="backend.app"):
        create_app(
            Settings(
                app_mode="candidate",
                bundle_path=str(tmp_path / "ok_b.db"),
                runtime_db_path=str(tmp_path / "ok_r.db"),
                storage_sinks="s3",
                s3_bucket="prod-reports",
                notify_sinks="",
            )
        )
    assert not any("ephemeral" in rec.message.lower() for rec in caplog.records)


def test_pdf_path_containment_and_case_insensitive_clear_secrets(tmp_path: Path):
    """Regression test: pdf_path outside local_reports_dir regenerates PDF; CLEAR_SECRETS works case-insensitively."""
    reports_dir = tmp_path / "reports"
    reports_dir.mkdir()
    outside_secret = tmp_path / "secret.txt"
    outside_secret.write_bytes(b"SECRET_NON_PDF_DATA")

    env_file = tmp_path / ".env"
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(reports_dir),
            llm_api_key="sk-secret-value",
            auto_seed_examples=False,
        ),
        env_path=env_file,
    )
    c = TestClient(app)

    # Create submission with pdf_path pointing outside reports_dir
    app.state.ctx.repo.create_submission(
        {
            "id": "sub-outside-pdf",
            "template_id": None,
            "template_name": "Core",
            "role_title": "Engineer",
            "candidate_name": "Jordan",
            "status": "completed",
            "final_score": 10.0,
            "max_score": 10.0,
            "score_percentage": 100.0,
            "pdf_path": str(outside_secret),
        }
    )

    pdf_resp = c.get("/api/admin/results/sub-outside-pdf/pdf")
    assert pdf_resp.status_code == 200
    assert pdf_resp.content != b"SECRET_NON_PDF_DATA"
    assert pdf_resp.content.startswith(b"%PDF")

    # Case-insensitive CLEAR_SECRETS clears the stored secret
    assert c.get("/api/admin/settings").json()["llm_api_key_set"] is True
    cleared = c.put(
        "/api/admin/settings",
        json={"CLEAR_SECRETS": ["LLM_API_KEY"], "llm_api_key": ""},
    )
    assert cleared.status_code == 200
    assert cleared.json()["llm_api_key_set"] is False



