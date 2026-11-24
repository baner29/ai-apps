import os
import sqlite3
from pathlib import Path
import pytest

import backend.config as config_module
from backend.config import Settings, get_settings, reload_settings, save_local_env, get_masked_settings
from backend.db.database import DatabaseManager
from backend.db.repository import InterviewRepository


@pytest.fixture(autouse=True)
def reset_settings_cache():
    orig_env = os.environ.copy()
    config_module._cached_settings = None
    yield
    for key in list(os.environ.keys()):
        if key not in orig_env:
            os.environ.pop(key, None)
    for key, value in orig_env.items():
        if os.environ.get(key) != value:
            os.environ[key] = value
    config_module._cached_settings = None


def test_question_crud_and_tag_filtering(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db", catalog_read_only=False)
    db.init_schemas()
    repo = InterviewRepository(db)
    q1 = repo.create_question({
        "title": "RAG Chunking", "prompt": "Explain chunking", "format": "text",
        "difficulty": "medium", "tags": ["AI-Engineering", "Data-Engineering"],
        "default_points": 20, "expected_answer": "Overlap + semantic", "evaluation_rubric": "10 pts tradeoffs"
    })
    q2 = repo.create_question({
        "title": "SQL Joins", "prompt": "Explain joins", "format": "mcq",
        "difficulty": "easy", "tags": ["data-engineering", "sql"],
        "options": ["A", "B"], "answer_indices": [0], "default_points": 10
    })
    assert sorted(q1["tags"]) == ["ai-engineering", "data-engineering"]
    assert len(repo.list_questions(tags=["ai-engineering"])) == 1
    assert len(repo.list_questions(tags=["ai-engineering", "data-engineering"], tag_match="all")) == 1
    assert len(repo.list_questions(tags=["data-engineering"])) == 2
    assert repo.delete_question(q2["id"]) is True


def test_curated_template_ordering_and_overrides(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db")
    db.init_schemas()
    repo = InterviewRepository(db)
    q1 = repo.create_question({"prompt": "Q1", "format": "text", "difficulty": "easy", "default_points": 10, "expected_answer": "Base1", "evaluation_rubric": "Rubric1", "tags": ["ai"]})
    q2 = repo.create_question({"prompt": "Q2", "format": "notebook", "difficulty": "hard", "default_points": 30, "expected_answer": "Base2", "evaluation_rubric": "Rubric2", "tags": ["de"]})
    tpl = repo.create_template({
        "slug": "ai-de-l4", "name": "AI DE L4", "role_title": "AI Data Engineer",
        "selection_mode": "curated", "timer_minutes": 45, "open_book_policy": "medium_hard",
        "allow_code_execution": True, "allow_package_install": True, "access_code": "secret1",
        "summary_dimensions": ["Data Pipelines", "LLM Systems"], "is_default": True,
        "questions": [
            {"question_id": q2["id"], "position": 0, "points_override": 40, "rubric_override": "Custom R2"},
            {"question_id": q1["id"], "position": 1, "expected_answer_override": "Custom A1"}
        ]
    })
    resolved = repo.resolve_template_questions(tpl["id"])
    assert [q["id"] for q in resolved] == [q2["id"], q1["id"]]
    assert resolved[0]["effective_points"] == 40
    assert resolved[0]["effective_rubric"] == "Custom R2"
    assert resolved[1]["effective_expected_answer"] == "Custom A1"


def test_random_pool_handles_undersized_pool_without_crashing(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db")
    db.init_schemas()
    repo = InterviewRepository(db)
    repo.create_question({"prompt": "Only 1 easy", "format": "text", "difficulty": "easy", "default_points": 10, "tags": ["pm"]})
    tpl = repo.create_template({
        "slug": "pm-rand", "name": "PM Random", "role_title": "Product Manager",
        "selection_mode": "random_pool", "timer_minutes": 30, "open_book_policy": "none",
        "allow_code_execution": False, "allow_package_install": False, "access_code": "pm1",
        "summary_dimensions": ["Product Sense"],
        "random_rules": {"tags": ["pm"], "match": "any", "total": 5, "difficulty_counts": {"easy": 3, "medium": 2, "hard": 0}}
    })
    resolved = repo.resolve_template_questions(tpl["id"])
    assert len(resolved) == 1


def test_candidate_mode_split_db_keeps_catalog_readonly(tmp_path):
    catalog = tmp_path / "bundle.db"
    runtime = tmp_path / "runtime.db"
    db_rw = DatabaseManager(catalog, catalog, catalog_read_only=False)
    db_rw.init_schemas()
    InterviewRepository(db_rw).create_question({"prompt": "Readonly Q", "format": "text", "difficulty": "easy", "default_points": 10, "tags": ["swe"]})

    db_ro = DatabaseManager(catalog, runtime, catalog_read_only=True)
    db_ro.init_schemas()
    repo_ro = InterviewRepository(db_ro)
    assert len(repo_ro.list_questions()) == 1
    with pytest.raises(sqlite3.OperationalError):
        repo_ro.create_question({"prompt": "Should fail", "format": "text", "difficulty": "easy", "default_points": 10})
    sub = repo_ro.create_submission({"id": "s1", "template_id": 1, "template_name": "T", "role_title": "R", "candidate_name": "Jane", "status": "in_progress"})
    assert repo_ro.get_submission("s1")["candidate_name"] == "Jane"


def test_save_local_env_and_masking(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    monkeypatch.setenv("LLM_PROVIDER", "none")
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LLM_API_KEY", "sk-secret-123456")
    s = save_local_env({"LLM_PROVIDER": "openai", "LLM_MODEL": "gpt-4o", "LLM_API_KEY": "sk-new-999999"}, env_file)
    assert s.llm_provider == "openai"
    masked = get_masked_settings(s)
    assert "sk-new-999999" not in str(masked)
    assert masked["llm_api_key_set"] is True


def test_question_update_search_filters_and_tags_list(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db")
    db.init_schemas()
    repo = InterviewRepository(db)

    q1 = repo.create_question({
        "prompt": "Build a streaming ETL pipeline with Kafka",
        "format": "code",
        "code_language": "python",
        "difficulty": "hard",
        "tags": ["Data-Engineering", "Streaming"],
        "default_points": 30,
    })
    assert q1["title"].startswith("Build a streaming ETL")

    updated = repo.update_question(q1["id"], {
        "title": "Kafka ETL",
        "tags": ["data-engineering", "kafka"],
        "active": False,
    })
    assert updated["title"] == "Kafka ETL"
    assert sorted(updated["tags"]) == ["data-engineering", "kafka"]
    assert updated["active"] is False

    assert len(repo.list_questions(active_only=True)) == 0
    assert len(repo.list_questions(search="Kafka", fmt="code", difficulty="hard")) == 1
    tag_names = {t["name"]: t["question_count"] for t in repo.list_tags()}
    assert tag_names["kafka"] == 1
    assert tag_names["data-engineering"] == 1


def test_template_default_switching_clone_update_and_delete(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db")
    db.init_schemas()
    repo = InterviewRepository(db)
    q1 = repo.create_question({"prompt": "Q1", "format": "text", "difficulty": "medium", "default_points": 15, "tags": ["swe"]})

    t1 = repo.create_template({
        "slug": "swe-l3", "name": "SWE L3", "role_title": "Software Engineer",
        "selection_mode": "curated", "is_default": True,
        "questions": [{"question_id": q1["id"], "position": 0, "points_override": 25}],
    })
    t2 = repo.create_template({
        "slug": "swe-l4", "name": "SWE L4", "role_title": "Senior SWE",
        "selection_mode": "curated", "is_default": True,
        "questions": [{"question_id": q1["id"], "position": 0}],
    })
    assert repo.get_default_template()["id"] == t2["id"]
    assert repo.get_template(t1["id"])["is_default"] is False
    assert repo.get_template_by_slug("swe-l4")["id"] == t2["id"]

    cloned = repo.clone_template(t1["id"], "swe-l3-copy", "SWE L3 Copy")
    assert cloned["slug"] == "swe-l3-copy"
    assert cloned["is_default"] is False
    assert len(cloned["questions"]) == 1
    assert cloned["questions"][0]["points_override"] == 25

    updated = repo.update_template(cloned["id"], {"name": "SWE L3 Renamed", "timer_minutes": 60})
    assert updated["name"] == "SWE L3 Renamed"
    assert updated["timer_minutes"] == 60
    assert repo.delete_template(cloned["id"]) is True
    assert repo.get_template(cloned["id"]) is None


def test_submission_lifecycle_crud(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db")
    db.init_schemas()
    repo = InterviewRepository(db)

    sub = repo.create_submission({
        "id": "sub-123",
        "template_id": 1,
        "template_name": "AI DE",
        "role_title": "AI Data Engineer",
        "candidate_name": "Alex Doe",
        "candidate_email": "alex@example.com",
        "status": "in_progress",
    })
    assert sub["id"] == "sub-123"
    assert sub["status"] == "in_progress"

    updated = repo.update_submission("sub-123", {
        "status": "completed",
        "final_score": 85.0,
        "max_score": 100.0,
        "score_percentage": 85.0,
        "answers": [{"question_id": 1, "score": 85.0}],
        "summary": {"overall_feedback": "Strong"},
        "delivery_log": [{"sink": "local", "status": "ok"}],
        "pdf_path": "data/reports/alex.pdf",
    })
    assert updated["status"] == "completed"
    assert updated["final_score"] == 85.0
    assert updated["answers"] == [{"question_id": 1, "score": 85.0}]
    assert updated["delivery_log"] == [{"sink": "local", "status": "ok"}]
    assert len(repo.list_submissions()) == 1


def test_settings_defaults_and_all_secrets_masked(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("APP_TITLE", raising=False)
    monkeypatch.delenv("APP_MODE", raising=False)
    monkeypatch.setenv("ADMIN_PASSWORD", "super-admin-pass")
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret-pw")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-secret-token")
    monkeypatch.setenv("WEBHOOK_SECRET", "whsec-secret")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", "DefaultEndpointsProtocol=https;AccountKey=secret;")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-secret-key-xyz")
    monkeypatch.setenv("LLM_API_KEY", "sk-secret-key-abc")

    s = reload_settings()
    assert isinstance(s, Settings)
    assert s.app_mode == "local"
    assert s.app_title == "BigBank"
    assert s.sandbox_max_package_mb == 25
    assert "torch" in s.banned_package_set

    masked = get_masked_settings(s)
    masked_str = str(masked)
    for secret in [
        "super-admin-pass",
        "smtp-secret-pw",
        "xoxb-secret-token",
        "whsec-secret",
        "AccountKey=secret",
        "aws-secret-key-xyz",
        "sk-secret-key-abc",
    ]:
        assert secret not in masked_str

    assert masked["admin_password_set"] is True
    assert masked["smtp_password_set"] is True
    assert masked["slack_bot_token_set"] is True
    assert masked["webhook_secret_set"] is True
    assert masked["azure_storage_connection_string_set"] is True
    assert masked["aws_secret_access_key_set"] is True
    assert masked["llm_api_key_set"] is True


def test_partial_updates_ignore_none_for_non_nullable_fields(tmp_path):
    db = DatabaseManager(tmp_path / "interview.db", tmp_path / "interview.db")
    db.init_schemas()
    repo = InterviewRepository(db)

    q = repo.create_question({
        "title": "Original Title",
        "prompt": "Original Prompt",
        "format": "notebook",
        "difficulty": "hard",
        "expected_answer": "Expected",
        "evaluation_rubric": "Rubric",
        "default_points": 25,
        "allow_execution": True,
        "active": True,
        "tags": ["python", "de"],
    })
    q_updated = repo.update_question(q["id"], {
        "title": None,
        "prompt": None,
        "format": None,
        "difficulty": None,
        "expected_answer": None,
        "evaluation_rubric": None,
        "default_points": None,
        "allow_execution": None,
        "active": None,
        "tags": None,
    })
    assert q_updated["title"] == "Original Title"
    assert q_updated["prompt"] == "Original Prompt"
    assert q_updated["format"] == "notebook"
    assert q_updated["difficulty"] == "hard"
    assert q_updated["expected_answer"] == "Expected"
    assert q_updated["evaluation_rubric"] == "Rubric"
    assert q_updated["default_points"] == 25
    assert q_updated["allow_execution"] is True
    assert q_updated["active"] is True
    assert sorted(q_updated["tags"]) == ["de", "python"]

    tpl = repo.create_template({
        "slug": "ai-eng",
        "name": "AI Engineer",
        "role_title": "AI Engineer",
        "description": "Instructions",
        "selection_mode": "curated",
        "timer_minutes": 45,
        "open_book_policy": "all",
        "allow_code_execution": True,
        "allow_package_install": True,
        "access_code": "code123",
        "summary_dimensions": ["LLM", "Systems"],
        "is_default": True,
    })
    tpl_updated = repo.update_template(tpl["id"], {
        "slug": None,
        "name": None,
        "role_title": None,
        "description": None,
        "selection_mode": None,
        "timer_minutes": None,
        "open_book_policy": None,
        "allow_code_execution": None,
        "allow_package_install": None,
        "access_code": None,
        "summary_dimensions": None,
        "is_default": None,
    })
    assert tpl_updated["slug"] == "ai-eng"
    assert tpl_updated["name"] == "AI Engineer"
    assert tpl_updated["role_title"] == "AI Engineer"
    assert tpl_updated["description"] == "Instructions"
    assert tpl_updated["selection_mode"] == "curated"
    assert tpl_updated["timer_minutes"] == 45
    assert tpl_updated["open_book_policy"] == "all"
    assert tpl_updated["allow_code_execution"] is True
    assert tpl_updated["allow_package_install"] is True
    assert tpl_updated["access_code"] == "code123"
    assert tpl_updated["summary_dimensions"] == ["LLM", "Systems"]
    assert tpl_updated["is_default"] is True

    sub = repo.create_submission({
        "id": "sub-none-test",
        "template_id": tpl["id"],
        "template_name": "AI Engineer",
        "role_title": "AI Engineer",
        "candidate_name": "Sam",
        "status": "in_progress",
    })
    sub_updated = repo.update_submission(sub["id"], {
        "template_name": None,
        "role_title": None,
        "candidate_name": None,
        "status": None,
        "final_score": 42.0,
    })
    assert sub_updated["template_name"] == "AI Engineer"
    assert sub_updated["role_title"] == "AI Engineer"
    assert sub_updated["candidate_name"] == "Sam"
    assert sub_updated["status"] == "in_progress"
    assert sub_updated["final_score"] == 42.0


def test_env_and_settings_cache_not_polluted_by_previous_tests(tmp_path, monkeypatch):
    # Verifies monkeypatch + autouse cache reset prevented leakage from earlier tests
    assert os.environ.get("LLM_PROVIDER") != "openai"
    assert os.environ.get("LLM_MODEL") != "gpt-4o"
    assert os.environ.get("ADMIN_PASSWORD") != "super-admin-pass"
    assert os.environ.get("LLM_API_KEY") != "sk-secret-key-abc"
    assert config_module._cached_settings is None
    monkeypatch.chdir(tmp_path)
    for key in ("LLM_PROVIDER", "LLM_MODEL", "ADMIN_PASSWORD", "APP_TITLE"):
        monkeypatch.delenv(key, raising=False)
    fresh = get_settings()
    assert fresh.llm_provider == "none"
    assert fresh.admin_password == ""
    assert fresh.app_title == "BigBank"
