"""End-to-end and security tests for the Public Candidate FastAPI router."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Settings
from backend.services.delivery.notify import NotifyResult


def test_candidate_end_to_end_finish_with_fallback_llm(tmp_path: Path):
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            llm_provider="none",
            storage_sinks="local",
            notify_sinks="",
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q_mcq = c.post(
        "/api/admin/questions",
        json={
            "prompt": "2+2?",
            "format": "mcq",
            "difficulty": "easy",
            "options": ["3", "4"],
            "answer_indices": [1],
            "default_points": 10,
            "tags": ["math"],
        },
    ).json()
    q_txt = c.post(
        "/api/admin/questions",
        json={
            "prompt": "Explain API",
            "format": "text",
            "difficulty": "medium",
            "default_points": 20,
            "tags": ["swe"],
        },
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "swe-1",
            "name": "SWE 1",
            "role_title": "Software Engineer",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "medium_hard",
            "allow_code_execution": True,
            "allow_package_install": False,
            "access_code": "join123",
            "summary_dimensions": ["Backend"],
            "is_default": True,
            "questions": [
                {"question_id": q_mcq["id"], "position": 0},
                {"question_id": q_txt["id"], "position": 1},
            ],
        },
    )

    login_resp = c.post(
        "/api/public/login",
        json={"slug": "swe-1", "candidate_name": "Taylor", "access_code": "join123"},
    )
    assert login_resp.status_code == 200
    login = login_resp.json()
    assert "answer_indices" not in login["questions"][0]
    assert "expected_answer" not in login["questions"][1]
    assert "evaluation_rubric" not in login["questions"][1]
    assert login["python_version"]

    fin = c.post(
        "/api/public/finish",
        json={
            "session_token": login["session_token"],
            "candidate_name": "Taylor",
            "slug": "swe-1",
            "answers": [
                {"question_id": q_mcq["id"], "answer": "1"},
                {"question_id": q_txt["id"], "answer": "REST over HTTP"},
            ],
        },
    )
    assert fin.status_code == 200 and fin.json()["status"] == "submitted"
    results = c.get("/api/admin/results").json()
    assert len(results) == 1
    assert results[0]["final_score"] == 10
    assert results[0]["status"] == "needs_review"


def test_public_template_metadata_strips_secrets_and_validates_access_code(tmp_path: Path):
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q = c.post(
        "/api/admin/questions",
        json={
            "prompt": "Secret question?",
            "format": "text",
            "difficulty": "easy",
            "default_points": 10,
            "expected_answer": "TOP_SECRET_ANSWER",
            "evaluation_rubric": "TOP_SECRET_RUBRIC",
        },
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "data-role",
            "name": "Data Role",
            "role_title": "Data Engineer",
            "selection_mode": "curated",
            "timer_minutes": 45,
            "open_book_policy": "medium_hard",
            "allow_code_execution": True,
            "allow_package_install": False,
            "access_code": "secret-pass",
            "summary_dimensions": ["SQL"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    default_tpl = c.get("/api/public/templates/default")
    assert default_tpl.status_code == 200
    body = default_tpl.json()
    assert body["slug"] == "data-role"
    assert body["requires_access_code"] is True
    assert "access_code" not in body
    assert "questions" not in body

    by_slug = c.get("/api/public/templates/data-role")
    assert by_slug.status_code == 200
    assert by_slug.json()["role_title"] == "Data Engineer"

    assert c.get("/api/public/templates/does-not-exist").status_code == 404

    bad_login = c.post(
        "/api/public/login",
        json={"slug": "data-role", "candidate_name": "Alex", "access_code": "wrong"},
    )
    assert bad_login.status_code == 401


def test_public_progress_and_finish_with_mocked_llm_and_partial_sink_failure(tmp_path: Path):
    """Review Focus #4: partial sink failure (Slack 500 while local succeeds) still completes and logs per-sink status."""
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            llm_provider="openai",
            llm_model="gpt-4o-mini",
            llm_api_key="test-key",
            storage_sinks="local",
            notify_sinks="slack",
            slack_webhook_url="https://hooks.slack.com/services/T000/B000/XXX",
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q = c.post(
        "/api/admin/questions",
        json={
            "prompt": "Explain idempotency in data pipelines",
            "format": "text",
            "difficulty": "medium",
            "default_points": 20,
            "tags": ["de"],
        },
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "de-test",
            "name": "DE Test",
            "role_title": "Data Engineer",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "all",
            "allow_code_execution": True,
            "allow_package_install": False,
            "access_code": "",
            "summary_dimensions": ["Pipelines"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    login = c.post("/api/public/login", json={"candidate_name": "Jordan"}).json()
    token = login["session_token"]

    prog = c.post(
        "/api/public/progress",
        json={
            "session_token": token,
            "answers": [{"question_id": q["id"], "answer": "Draft answer"}],
        },
    )
    assert prog.status_code == 200
    assert prog.json()["ok"] is True

    mock_score = AsyncMock(
        return_value={
            "score": 18.0,
            "max_points": 20.0,
            "correctness_pct": 90.0,
            "rubric_breakdown": ["Clear explanation of replay safety"],
            "feedback": "Very strong answer.",
            "needs_manual_review": False,
        }
    )
    mock_summary = AsyncMock(
        return_value={
            "overall_feedback": "Strong candidate.",
            "strengths": "Solid pipeline fundamentals.",
            "areas_of_opportunity": "Cover schema evolution.",
            "dimensions": {"Pipelines": "Strong"},
        }
    )

    # Simulate Slack returning HTTP 500 while local storage succeeds
    mock_slack_notify = AsyncMock(
        return_value=NotifyResult(
            sink="slack",
            ok=False,
            detail=None,
            error="Slack webhook returned HTTP 500",
        )
    )

    with (
        patch("backend.services.llm.LLMService.score_answer", mock_score),
        patch("backend.services.llm.LLMService.generate_summary", mock_summary),
        patch(
            "backend.services.delivery.notify.SlackNotifier.notify",
            mock_slack_notify,
        ),
        patch.object(app.state.ctx.kernel_manager, "cleanup_session") as mock_cleanup,
    ):
        fin = c.post(
            "/api/public/finish",
            json={
                "session_token": token,
                "candidate_name": "Jordan",
                "slug": "de-test",
                "answers": [
                    {
                        "question_id": q["id"],
                        "answer": "Use deterministic partition overwrites or MERGE keys.",
                    }
                ],
            },
        )

    assert fin.status_code == 200
    assert fin.json()["status"] == "submitted"
    mock_cleanup.assert_called_once_with(fin.json()["submission_id"])

    results = c.get("/api/admin/results").json()
    assert len(results) == 1
    sub = results[0]
    assert sub["final_score"] == 18.0
    assert sub["score_percentage"] == 90.0
    assert sub["status"] == "completed"
    assert sub["pdf_path"] is not None and Path(sub["pdf_path"]).is_file()

    delivery_log = sub["delivery_log"]
    local_storage_entries = [
        e for e in delivery_log if e.get("phase") == "storage" and e.get("sink") == "local"
    ]
    slack_entries = [
        e for e in delivery_log if e.get("phase") == "notify" and e.get("sink") == "slack"
    ]
    assert local_storage_entries and local_storage_entries[0]["ok"] is True
    assert slack_entries and slack_entries[0]["ok"] is False
    assert "500" in (slack_entries[0].get("error") or "")


def test_public_notebook_endpoints_and_template_policy_enforcement(tmp_path: Path):
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q = c.post(
        "/api/admin/questions",
        json={
            "prompt": "Compute sum",
            "format": "notebook",
            "difficulty": "easy",
            "default_points": 10,
        },
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "nb-restricted",
            "name": "NB Restricted",
            "role_title": "Data Scientist",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "allow_code_execution": True,
            "allow_package_install": False,
            "summary_dimensions": ["Python"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    login = c.post("/api/public/login", json={"candidate_name": "Sam"}).json()
    token = login["session_token"]

    try:
        exec_resp = c.post(
            "/api/public/notebook/execute",
            json={"session_token": token, "code": "x = 21 * 2\nprint(x)"},
        )
        assert exec_resp.status_code == 200
        assert exec_resp.json()["ok"] is True
        assert "42" in exec_resp.json()["stdout"]

        # Package install is disabled by template flag
        inst_resp = c.post(
            "/api/public/notebook/install",
            json={"session_token": token, "package": "tabulate"},
        )
        assert inst_resp.status_code == 403

        restart_resp = c.post(
            "/api/public/notebook/restart",
            json={"session_token": token},
        )
        assert restart_resp.status_code == 200
        assert restart_resp.json()["restarted"] is True
    finally:
        app.state.ctx.kernel_manager.shutdown_all()


def test_forged_and_missing_session_tokens_rejected_on_all_session_endpoints(tmp_path: Path):
    """Regression test: missing, forged, or tampered session_token rejected with 401 across all session routes."""
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q = c.post(
        "/api/admin/questions",
        json={"prompt": "Q1", "format": "notebook", "difficulty": "easy", "default_points": 10},
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "sec-tpl",
            "name": "Sec Tpl",
            "role_title": "Engineer",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "allow_code_execution": True,
            "allow_package_install": True,
            "summary_dimensions": ["Code"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    real_login = c.post("/api/public/login", json={"candidate_name": "Legit"}).json()
    real_token = real_login["session_token"]
    payload_part, sig_part = real_token.split(".", 1)
    tampered_token = f"{payload_part}.{'A' * len(sig_part)}"

    for bad_token in ("", "arbitrary-forged-token", "not.a.valid.token", tampered_token):
        assert (
            c.post("/api/public/notebook/execute", json={"session_token": bad_token, "code": "print(1)"}).status_code
            == 401
        )
        assert (
            c.post("/api/public/notebook/install", json={"session_token": bad_token, "package": "tabulate"}).status_code
            == 401
        )
        assert (
            c.post("/api/public/notebook/restart", json={"session_token": bad_token}).status_code
            == 401
        )
        assert (
            c.post("/api/public/progress", json={"session_token": bad_token, "answers": []}).status_code
            == 401
        )
        assert (
            c.post(
                "/api/public/finish",
                json={"session_token": bad_token, "slug": "sec-tpl", "candidate_name": "Attacker", "answers": []},
            ).status_code
            == 401
        )


def test_notebook_disabled_code_exec_and_cold_start_signed_token_enforcement(tmp_path: Path):
    """Regression test: allow_code_execution=False returns 403 and signed tokens survive cold starts."""
    db_file = str(tmp_path / "db.sqlite")
    reports_dir = str(tmp_path / "reports")
    common_kwargs = dict(
        app_mode="local",
        database_path=db_file,
        local_reports_dir=reports_dir,
        llm_provider="none",
        storage_sinks="local",
        access_code="cold-start-key",
        auto_seed_examples=False,
    )
    app1 = create_app(Settings(**common_kwargs))
    c1 = TestClient(app1)
    q = c1.post(
        "/api/admin/questions",
        json={"prompt": "Explain SQL", "format": "text", "difficulty": "easy", "default_points": 10},
    ).json()
    c1.post(
        "/api/admin/templates",
        json={
            "slug": "no-exec",
            "name": "No Exec",
            "role_title": "Analyst",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "allow_code_execution": False,
            "allow_package_install": False,
            "summary_dimensions": ["SQL"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    login = c1.post(
        "/api/public/login",
        json={"slug": "no-exec", "candidate_name": "Casey", "access_code": "cold-start-key"},
    )
    assert login.status_code == 200
    token = login.json()["session_token"]

    # Code execution & restart & install all rejected with 403 on allow_code_execution=False
    assert (
        c1.post("/api/public/notebook/execute", json={"session_token": token, "code": "1+1"}).status_code
        == 403
    )
    assert (
        c1.post("/api/public/notebook/restart", json={"session_token": token}).status_code
        == 403
    )
    assert (
        c1.post("/api/public/notebook/install", json={"session_token": token, "package": "tabulate"}).status_code
        == 403
    )

    # Simulate serverless cold start: fresh app instance with empty active_sessions
    app2 = create_app(Settings(**common_kwargs))
    assert app2.state.ctx.active_sessions == {}
    c2 = TestClient(app2)

    # Signed token still enforces allow_code_execution=False on cold instance
    assert (
        c2.post("/api/public/notebook/execute", json={"session_token": token, "code": "1+1"}).status_code
        == 403
    )
    # Signed token still works for progress & finish on cold instance
    assert (
        c2.post(
            "/api/public/progress",
            json={"session_token": token, "answers": [{"question_id": q["id"], "answer": "Draft"}]},
        ).status_code
        == 200
    )
    fin = c2.post(
        "/api/public/finish",
        json={"session_token": token, "answers": [{"question_id": q["id"], "answer": "Final"}]},
    )
    assert fin.status_code == 200 and fin.json()["status"] == "submitted"


def test_public_proxy_blocks_ssrf_and_search_endpoint(tmp_path: Path):
    """Review Focus #3: SSRF URLs rejected with 400/403 on /api/public/proxy."""
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "db.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)

    for bad_url in (
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8080/api/admin/questions",
        "file:///etc/passwd",
    ):
        resp = c.get("/api/public/proxy", params={"url": bad_url})
        assert resp.status_code in (400, 403), f"Expected 400/403 for {bad_url}, got {resp.status_code}"

    with patch(
        "backend.routers.public.search_duckduckgo",
        new=AsyncMock(
            return_value={
                "results": [{"title": "Pandas Docs", "url": "https://pandas.pydata.org", "snippet": "Docs"}],
                "search_url": "https://duckduckgo.com/?q=pandas",
                "error": None,
            }
        ),
    ):
        s_resp = c.get("/api/public/search", params={"q": "pandas"})
        assert s_resp.status_code == 200
        assert len(s_resp.json()["results"]) == 1


def test_runtime_access_code_env_overrides_template_baked_access_code(tmp_path: Path):
    """Regression test: runtime ACCESS_CODE env var takes precedence over template access_code."""
    db_path = tmp_path / "override.sqlite"
    setup_app = create_app(
        Settings(
            app_mode="local",
            database_path=str(db_path),
            local_reports_dir=str(tmp_path / "reports"),
            access_code="",
            auto_seed_examples=False,
        )
    )
    setup_client = TestClient(setup_app)
    q = setup_client.post(
        "/api/admin/questions",
        json={
            "prompt": "Warmup?",
            "format": "text",
            "difficulty": "easy",
            "default_points": 10,
        },
    ).json()
    setup_client.post(
        "/api/admin/templates",
        json={
            "slug": "baked-code-role",
            "name": "Baked Code Role",
            "role_title": "Engineer",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "access_code": "template-baked-code",
            "summary_dimensions": ["Core"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    # Boot with runtime ACCESS_CODE override
    override_app = create_app(
        Settings(
            app_mode="local",
            database_path=str(db_path),
            local_reports_dir=str(tmp_path / "reports"),
            access_code="runtime-override-code",
            auto_seed_examples=False,
        )
    )
    c = TestClient(override_app)

    # Baked template code must now be rejected
    bad = c.post(
        "/api/public/login",
        json={
            "slug": "baked-code-role",
            "candidate_name": "Riley",
            "access_code": "template-baked-code",
        },
    )
    assert bad.status_code == 401

    # Runtime override code must succeed
    good = c.post(
        "/api/public/login",
        json={
            "slug": "baked-code-role",
            "candidate_name": "Riley",
            "access_code": "runtime-override-code",
        },
    )
    assert good.status_code == 200


def test_finalized_session_rejects_notebook_endpoints_with_409(tmp_path: Path):
    """Regression test: finalized candidate sessions cannot execute, install, or restart kernels."""
    app = create_app(
        Settings(
            app_mode="local",
            database_path=str(tmp_path / "finalized_nb.sqlite"),
            local_reports_dir=str(tmp_path / "reports"),
            llm_provider="none",
            storage_sinks="local",
            notify_sinks="",
            auto_seed_examples=False,
        )
    )
    c = TestClient(app)
    q = c.post(
        "/api/admin/questions",
        json={
            "prompt": "2+2?",
            "format": "mcq",
            "difficulty": "easy",
            "options": ["3", "4"],
            "answer_indices": [1],
            "default_points": 10,
        },
    ).json()
    c.post(
        "/api/admin/templates",
        json={
            "slug": "nb-role",
            "name": "NB Role",
            "role_title": "Data Scientist",
            "selection_mode": "curated",
            "timer_minutes": 30,
            "open_book_policy": "none",
            "allow_code_execution": True,
            "allow_package_install": True,
            "summary_dimensions": ["Python"],
            "is_default": True,
            "questions": [{"question_id": q["id"], "position": 0}],
        },
    )

    login = c.post("/api/public/login", json={"slug": "nb-role", "candidate_name": "Sam"}).json()
    token = login["session_token"]

    fin = c.post(
        "/api/public/finish",
        json={
            "session_token": token,
            "answers": [{"question_id": q["id"], "answer": "1"}],
        },
    )
    assert fin.status_code == 200

    assert (
        c.post("/api/public/notebook/execute", json={"session_token": token, "code": "1+1"}).status_code
        == 409
    )
    assert (
        c.post("/api/public/notebook/install", json={"session_token": token, "package": "tabulate"}).status_code
        == 409
    )
    assert (
        c.post("/api/public/notebook/restart", json={"session_token": token}).status_code
        == 409
    )

