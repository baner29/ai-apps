"""SQLite DDL definitions split between catalog and runtime tables."""

CATALOG_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_key TEXT UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('mcq', 'text', 'code', 'notebook')),
    difficulty TEXT NOT NULL CHECK(difficulty IN ('easy', 'medium', 'hard')),
    options_json TEXT,
    answer_indices_json TEXT,
    code_language TEXT,
    starter_code TEXT,
    allow_execution INTEGER NOT NULL DEFAULT 0,
    expected_answer TEXT NOT NULL DEFAULT '',
    evaluation_rubric TEXT NOT NULL DEFAULT '',
    default_points INTEGER NOT NULL DEFAULT 10,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS question_tags (
    question_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (question_id, tag_id),
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role_title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    selection_mode TEXT NOT NULL CHECK(selection_mode IN ('curated', 'random_pool')),
    random_rules_json TEXT,
    timer_minutes INTEGER NOT NULL DEFAULT 45,
    open_book_policy TEXT NOT NULL DEFAULT 'none' CHECK(open_book_policy IN ('none', 'medium_hard', 'all')),
    allow_code_execution INTEGER NOT NULL DEFAULT 1,
    allow_package_install INTEGER NOT NULL DEFAULT 0,
    access_code TEXT NOT NULL DEFAULT '',
    summary_dimensions_json TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    points_override INTEGER,
    expected_answer_override TEXT,
    rubric_override TEXT,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_question_tags_tag_id ON question_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_template_questions_template_pos ON template_questions(template_id, position);
"""

RUNTIME_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    template_id INTEGER,
    template_name TEXT NOT NULL DEFAULT '',
    role_title TEXT NOT NULL DEFAULT '',
    candidate_name TEXT NOT NULL,
    candidate_email TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'evaluating', 'completed', 'needs_review', 'failed')),
    started_at TEXT,
    submitted_at TEXT,
    duration_seconds INTEGER,
    final_score REAL,
    max_score REAL,
    score_percentage REAL,
    answers_json TEXT,
    summary_json TEXT,
    delivery_log_json TEXT,
    pdf_path TEXT
);
"""
