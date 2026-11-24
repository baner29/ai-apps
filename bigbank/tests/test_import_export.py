import json
from pathlib import Path

import pytest
import yaml

from backend.db.database import DatabaseManager
from backend.db.repository import InterviewRepository
from backend.services.import_export import (
    commit_import,
    export_questions,
    get_sample_import_template,
    parse_payload,
    preview_import,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_canonical_yaml_preview_and_commit_skip_vs_overwrite(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)
    payload = yaml.safe_dump({
        "questions": [
            {
                "external_key": "ai-01",
                "title": "RAG",
                "prompt": "Explain RAG",
                "format": "text",
                "difficulty": "medium",
                "tags": ["ai-engineering"],
                "default_points": 20,
                "expected_answer": "Retrieve+Generate",
                "evaluation_rubric": "10 pts retrieval",
            },
            {
                "external_key": "py-nb-01",
                "title": "Pandas Agg",
                "prompt": "Aggregate df",
                "format": "notebook",
                "difficulty": "hard",
                "tags": ["data-engineering", "python"],
                "default_points": 30,
                "starter_code": "import pandas as pd\n",
            },
        ]
    }).encode()
    prev = preview_import(repo, payload, "bank.yaml")
    assert prev["new_count"] == 2 and prev["invalid_count"] == 0
    res1 = commit_import(repo, payload, "bank.yaml", duplicate_strategy="skip")
    assert res1["created"] == 2 and res1["skipped"] == 0
    # Re-import with updated title
    updated = yaml.safe_dump({
        "questions": [
            {
                "external_key": "ai-01",
                "title": "RAG v2",
                "prompt": "Explain RAG",
                "format": "text",
                "difficulty": "medium",
                "tags": ["ai-engineering"],
                "default_points": 25,
            }
        ]
    }).encode()
    res_skip = commit_import(repo, updated, "bank.yaml", duplicate_strategy="skip")
    assert res_skip["skipped"] == 1
    res_ow = commit_import(repo, updated, "bank.yaml", duplicate_strategy="overwrite")
    assert res_ow["updated"] == 1
    assert repo.list_questions(search="RAG v2")[0]["default_points"] == 25


def test_legacy_flat_json_and_mixed_invalid_rows(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)
    legacy = json.dumps([
        {
            "id": 1,
            "type": "mcq",
            "difficulty": "easy",
            "category": "SQL",
            "question": "What is CTE?",
            "options": ["Temp result", "Index"],
            "answer_index": 0,
            "explanation": "Common Table Expression",
        },
        {
            "id": 2,
            "type": "mcq",
            "difficulty": "easy",
            "category": "SQL",
            "question": "Broken MCQ",
            "options": ["Only one"],
            "answer_index": 5,
        },
    ]).encode()
    prev = preview_import(repo, legacy, "legacy.json")
    assert prev["valid_count"] == 1 and prev["invalid_count"] == 1
    assert any(
        "answer_index" in e["error"].lower() or "range" in e["error"].lower()
        for e in prev["errors"]
    )
    # Commit with skip_invalid=False must not partially insert
    res_strict = commit_import(
        repo, legacy, "legacy.json", duplicate_strategy="skip", skip_invalid=False
    )
    assert res_strict["created"] == 0 and len(repo.list_questions()) == 0
    res_lenient = commit_import(
        repo, legacy, "legacy.json", duplicate_strategy="skip", skip_invalid=True
    )
    assert res_lenient["created"] == 1
    q = repo.list_questions()[0]
    assert q["tags"] == ["sql"] and "Common Table Expression" in q["expected_answer"]


def test_legacy_python_maps_to_notebook_and_multiselect_answer_formats(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)
    legacy = json.dumps([
        {
            "id": 10,
            "type": "text",
            "difficulty": "hard",
            "category": "Python",
            "question": "Write a function to deduplicate rows in pandas.",
            "explanation": "Use drop_duplicates with subset and keep='last'.",
            "active": True,
        },
        {
            "id": 11,
            "type": "mcq",
            "difficulty": "medium",
            "category": "Data Engineering",
            "question": "Which formats are columnar?",
            "options": ["Parquet", "CSV", "ORC", "JSONL"],
            "answer_index": "0, 2",
            "explanation": "Parquet and ORC store values column-by-column.",
        },
        {
            "id": 12,
            "type": "mcq",
            "difficulty": "easy",
            "category": "SQL",
            "question": "Select valid JOIN types.",
            "options": ["INNER", "LEFT", "DIAGONAL"],
            "answer_index": [0, 1],
            "explanation": "INNER and LEFT are standard SQL joins.",
        },
    ]).encode()

    res = commit_import(repo, legacy, "legacy_bank.json", duplicate_strategy="skip")
    assert res["created"] == 3 and res["errors"] == []

    questions = repo.list_questions()
    py_q = next(q for q in questions if "pandas" in q["prompt"])
    assert py_q["format"] == "notebook"
    assert py_q["code_language"] == "python"
    assert py_q["allow_execution"] is True
    assert "drop_duplicates" in py_q["expected_answer"]
    assert "drop_duplicates" in py_q["evaluation_rubric"]

    multi_str_q = next(q for q in questions if "columnar" in q["prompt"])
    assert multi_str_q["answer_indices"] == [0, 2]
    assert multi_str_q["tags"] == ["data-engineering"]

    multi_list_q = next(q for q in questions if "JOIN" in q["prompt"])
    assert multi_list_q["answer_indices"] == [0, 1]


def test_duplicate_detection_by_prompt_and_within_batch(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)

    batch = yaml.safe_dump({
        "questions": [
            {
                "external_key": "dup-01",
                "title": "First",
                "prompt": "Explain   CAP   theorem.",
                "format": "text",
                "difficulty": "medium",
                "tags": ["distributed-systems"],
                "default_points": 15,
            },
            {
                "external_key": "dup-01",
                "title": "Second Same Key",
                "prompt": "Explain CAP theorem updated.",
                "format": "text",
                "difficulty": "hard",
                "tags": ["distributed-systems"],
                "default_points": 25,
            },
        ]
    }).encode()

    prev = preview_import(repo, batch, "dups.yaml")
    assert prev["new_count"] == 1
    assert prev["duplicate_count"] == 1
    assert prev["invalid_count"] == 0

    res_skip = commit_import(repo, batch, "dups.yaml", duplicate_strategy="skip")
    assert res_skip["created"] == 1 and res_skip["skipped"] == 1
    assert repo.list_questions()[0]["title"] == "First"

    # Re-import without external_key, matching by whitespace-normalized prompt
    prompt_dup = json.dumps({
        "questions": [
            {
                "title": "Prompt Match Overwrite",
                "prompt": "  explain cap theorem. ",
                "format": "text",
                "difficulty": "hard",
                "tags": ["distributed-systems", "architecture"],
                "default_points": 30,
            }
        ]
    }).encode()
    prev2 = preview_import(repo, prompt_dup, "prompt_dup.json")
    assert prev2["duplicate_count"] == 1 and prev2["new_count"] == 0

    res_ow = commit_import(repo, prompt_dup, "prompt_dup.json", duplicate_strategy="overwrite")
    assert res_ow["updated"] == 1
    updated = repo.list_questions()[0]
    assert updated["title"] == "Prompt Match Overwrite"
    assert updated["external_key"] == "dup-01"
    assert updated["default_points"] == 30


def test_parse_payload_errors_and_validation_edge_cases(tmp_path):
    with pytest.raises(ValueError):
        parse_payload(b"{not valid json", "broken.json")
    with pytest.raises(ValueError):
        parse_payload(b"just a plain string", "bad.yaml")
    with pytest.raises(ValueError):
        parse_payload(b'{"not_questions": []}', "missing_key.json")

    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)

    bad_rows = yaml.safe_dump({
        "questions": [
            {"title": "No prompt", "format": "text", "difficulty": "easy"},
            {"prompt": "Bad fmt", "format": "video", "difficulty": "easy"},
            {"prompt": "Bad diff", "format": "text", "difficulty": "extreme"},
            {"prompt": "Bad points", "format": "text", "difficulty": "easy", "default_points": -5},
            {
                "prompt": "Empty MCQ answer",
                "format": "mcq",
                "difficulty": "easy",
                "options": ["A", "B"],
                "answer_indices": [],
            },
        ]
    }).encode()

    prev = preview_import(repo, bad_rows, "bad.yaml")
    assert prev["invalid_count"] == 5
    assert prev["valid_count"] == 0
    assert len(prev["errors"]) == 5


def test_mcq_blank_or_none_options_rejected_without_index_shift(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)

    payload = yaml.safe_dump({
        "questions": [
            {
                "prompt": "Blank string option",
                "format": "mcq",
                "difficulty": "easy",
                "options": ["", "Correct", "Wrong"],
                "answer_indices": [1],
            },
            {
                "prompt": "Whitespace option",
                "format": "mcq",
                "difficulty": "easy",
                "options": ["   ", "Correct", "Wrong"],
                "answer_indices": [1],
            },
            {
                "prompt": "Null option",
                "format": "mcq",
                "difficulty": "easy",
                "options": [None, "Correct", "Wrong"],
                "answer_indices": [1],
            },
        ]
    }).encode()

    prev = preview_import(repo, payload, "blank_options.yaml")
    assert prev["invalid_count"] == 3
    assert prev["valid_count"] == 0
    assert len(prev["errors"]) == 3
    assert all("option" in e["error"].lower() for e in prev["errors"])

    res = commit_import(repo, payload, "blank_options.yaml", skip_invalid=False)
    assert res["created"] == 0
    assert len(repo.list_questions()) == 0


def test_export_questions_yaml_json_tag_filter_and_template_roundtrip(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)

    q1 = repo.create_question({
        "external_key": "exp-01",
        "title": "SQL Joins",
        "prompt": "Explain LEFT JOIN",
        "format": "text",
        "difficulty": "easy",
        "tags": ["data-engineering", "sql"],
        "default_points": 10,
        "expected_answer": "Returns all left rows",
        "evaluation_rubric": "5 pts semantics",
    })
    q2 = repo.create_question({
        "external_key": "exp-02",
        "title": "RAG Eval",
        "prompt": "Define faithfulness",
        "format": "text",
        "difficulty": "medium",
        "tags": ["ai-engineering"],
        "default_points": 20,
        "expected_answer": "Grounded in context",
        "evaluation_rubric": "10 pts clarity",
    })
    tpl = repo.create_template({
        "slug": "ai-focus",
        "name": "AI Focus",
        "role_title": "AI Engineer",
        "selection_mode": "curated",
        "questions": [
            {
                "question_id": q2["id"],
                "position": 0,
                "points_override": 35,
                "rubric_override": "Custom AI rubric",
            }
        ],
    })

    yaml_text, yaml_ct = export_questions(repo, fmt="yaml", tags=["ai-engineering"])
    assert "yaml" in yaml_ct
    parsed_yaml = yaml.safe_load(yaml_text)
    assert len(parsed_yaml["questions"]) == 1
    assert parsed_yaml["questions"][0]["external_key"] == "exp-02"

    json_text, json_ct = export_questions(repo, fmt="json")
    assert "json" in json_ct
    parsed_json = json.loads(json_text)
    assert len(parsed_json["questions"]) == 2

    tpl_yaml, _ = export_questions(repo, fmt="yaml", template_id=tpl["id"])
    parsed_tpl = yaml.safe_load(tpl_yaml)
    assert len(parsed_tpl["questions"]) == 1
    assert parsed_tpl["questions"][0]["default_points"] == 35
    assert parsed_tpl["questions"][0]["evaluation_rubric"] == "Custom AI rubric"

    # Round-trip re-import into a fresh database
    db2 = DatabaseManager(tmp_path / "db2.sqlite", tmp_path / "db2.sqlite")
    db2.init_schemas()
    repo2 = InterviewRepository(db2)
    res = commit_import(repo2, json_text.encode("utf-8"), "export.json")
    assert res["created"] == 2
    assert {q["external_key"] for q in repo2.list_questions()} == {"exp-01", "exp-02"}


def test_sample_templates_and_starter_question_banks(tmp_path):
    db = DatabaseManager(tmp_path / "db.sqlite", tmp_path / "db.sqlite")
    db.init_schemas()
    repo = InterviewRepository(db)

    for fmt in ("yaml", "json"):
        content, media_type = get_sample_import_template(fmt)
        assert fmt in media_type
        prev = preview_import(repo, content.encode("utf-8"), f"sample.{fmt}")
        assert prev["invalid_count"] == 0
        assert prev["valid_count"] >= 4
        sample_formats = {item["question"]["format"] for item in prev["items"]}
        assert sample_formats == {"mcq", "text", "code", "notebook"}

    yaml_path = REPO_ROOT / "examples" / "starter_questions.yaml"
    json_path = REPO_ROOT / "examples" / "starter_questions.json"
    assert yaml_path.exists()
    assert json_path.exists()

    yaml_bytes = yaml_path.read_bytes()
    json_bytes = json_path.read_bytes()

    prev_yaml = preview_import(repo, yaml_bytes, "starter_questions.yaml")
    assert prev_yaml["invalid_count"] == 0
    assert prev_yaml["valid_count"] == 12

    res = commit_import(repo, yaml_bytes, "starter_questions.yaml")
    assert res["created"] == 12 and res["errors"] == []

    all_q = repo.list_questions()
    assert len(all_q) == 12
    formats = {q["format"] for q in all_q}
    assert formats == {"mcq", "text", "code", "notebook"}

    all_tags = {tag for q in all_q for tag in q["tags"]}
    for domain in (
        "data-engineering",
        "ai-engineering",
        "software-engineering",
        "dsa",
        "product-management",
    ):
        assert domain in all_tags

    # JSON starter bank must match YAML starter bank identically (all 12 recognized as duplicates)
    prev_json = preview_import(repo, json_bytes, "starter_questions.json")
    assert prev_json["invalid_count"] == 0
    assert prev_json["valid_count"] == 12
    assert prev_json["duplicate_count"] == 12
