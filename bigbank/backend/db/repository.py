"""Repository layer for questions, tags, templates, and submissions."""

from __future__ import annotations

import json
import random
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from backend.db.database import DatabaseManager


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_tags(tags: list[str] | None) -> list[str]:
    if not tags:
        return []
    normalized: set[str] = set()
    for raw in tags:
        if raw is None:
            continue
        cleaned = str(raw).strip().lower()
        if cleaned:
            normalized.add(cleaned)
    return sorted(normalized)


def _derive_title(prompt: str) -> str:
    for line in (prompt or "").splitlines():
        cleaned = line.strip().lstrip("#").strip()
        if cleaned:
            return cleaned[:80]
    return "Untitled Question"


def _to_json_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value)


def _parse_json(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


class InterviewRepository:
    """Data-access layer operating across split catalog and runtime SQLite databases."""

    def __init__(self, db: DatabaseManager) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # Internal hydration helpers
    # ------------------------------------------------------------------

    def _fetch_tags_map(
        self, conn: sqlite3.Connection, question_ids: list[int]
    ) -> dict[int, list[str]]:
        if not question_ids:
            return {}
        placeholders = ",".join("?" for _ in question_ids)
        rows = conn.execute(
            f"""
            SELECT qt.question_id, t.name
            FROM question_tags qt
            JOIN tags t ON t.id = qt.tag_id
            WHERE qt.question_id IN ({placeholders})
            ORDER BY t.name ASC
            """,
            question_ids,
        ).fetchall()
        tags_map: dict[int, list[str]] = {qid: [] for qid in question_ids}
        for row in rows:
            tags_map[row["question_id"]].append(row["name"])
        return tags_map

    def _row_to_question(self, row: sqlite3.Row, tags: list[str]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "external_key": row["external_key"],
            "title": row["title"],
            "prompt": row["prompt"],
            "format": row["format"],
            "difficulty": row["difficulty"],
            "options": _parse_json(row["options_json"], []),
            "answer_indices": _parse_json(row["answer_indices_json"], []),
            "code_language": row["code_language"],
            "starter_code": row["starter_code"],
            "allow_execution": bool(row["allow_execution"]),
            "expected_answer": row["expected_answer"] or "",
            "evaluation_rubric": row["evaluation_rubric"] or "",
            "default_points": row["default_points"],
            "active": bool(row["active"]),
            "tags": tags,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _sync_question_tags(
        self, conn: sqlite3.Connection, question_id: int, tags: list[str]
    ) -> None:
        norm_tags = _normalize_tags(tags)
        conn.execute("DELETE FROM question_tags WHERE question_id = ?", (question_id,))
        for tag_name in norm_tags:
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,))
            tag_row = conn.execute(
                "SELECT id FROM tags WHERE name = ?", (tag_name,)
            ).fetchone()
            conn.execute(
                "INSERT OR IGNORE INTO question_tags (question_id, tag_id) VALUES (?, ?)",
                (question_id, tag_row["id"]),
            )

    def _hydrate_template(
        self, conn: sqlite3.Connection, row: sqlite3.Row
    ) -> dict[str, Any]:
        tq_rows = conn.execute(
            """
            SELECT id, question_id, position, points_override,
                   expected_answer_override, rubric_override
            FROM template_questions
            WHERE template_id = ?
            ORDER BY position ASC, id ASC
            """,
            (row["id"],),
        ).fetchall()
        questions = [
            {
                "id": tq["id"],
                "question_id": tq["question_id"],
                "position": tq["position"],
                "points_override": tq["points_override"],
                "expected_answer_override": tq["expected_answer_override"],
                "rubric_override": tq["rubric_override"],
            }
            for tq in tq_rows
        ]
        return {
            "id": row["id"],
            "slug": row["slug"],
            "name": row["name"],
            "role_title": row["role_title"],
            "description": row["description"] or "",
            "selection_mode": row["selection_mode"],
            "random_rules": _parse_json(row["random_rules_json"], None),
            "timer_minutes": row["timer_minutes"],
            "open_book_policy": row["open_book_policy"],
            "allow_code_execution": bool(row["allow_code_execution"]),
            "allow_package_install": bool(row["allow_package_install"]),
            "access_code": row["access_code"] or "",
            "summary_dimensions": _parse_json(row["summary_dimensions_json"], []),
            "is_default": bool(row["is_default"]),
            "questions": questions,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _replace_template_questions(
        self, conn: sqlite3.Connection, template_id: int, items: list[dict[str, Any]]
    ) -> None:
        conn.execute(
            "DELETE FROM template_questions WHERE template_id = ?", (template_id,)
        )
        for idx, item in enumerate(items):
            conn.execute(
                """
                INSERT INTO template_questions (
                    template_id, question_id, position,
                    points_override, expected_answer_override, rubric_override
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    template_id,
                    int(item["question_id"]),
                    int(item.get("position", idx)),
                    item.get("points_override"),
                    item.get("expected_answer_override"),
                    item.get("rubric_override"),
                ),
            )

    def _row_to_submission(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "template_id": row["template_id"],
            "template_name": row["template_name"],
            "role_title": row["role_title"],
            "candidate_name": row["candidate_name"],
            "candidate_email": row["candidate_email"],
            "status": row["status"],
            "started_at": row["started_at"],
            "submitted_at": row["submitted_at"],
            "duration_seconds": row["duration_seconds"],
            "final_score": row["final_score"],
            "max_score": row["max_score"],
            "score_percentage": row["score_percentage"],
            "answers": _parse_json(row["answers_json"], []),
            "summary": _parse_json(row["summary_json"], None),
            "delivery_log": _parse_json(row["delivery_log_json"], []),
            "pdf_path": row["pdf_path"],
        }

    # ------------------------------------------------------------------
    # Questions & Tags
    # ------------------------------------------------------------------

    def create_question(self, data: dict[str, Any]) -> dict[str, Any]:
        now = _utc_now()
        fmt = data.get("format", "text")
        prompt = data["prompt"]
        title = (data.get("title") or "").strip() or _derive_title(prompt)
        external_key = data.get("external_key")
        if external_key is not None:
            external_key = str(external_key).strip() or None

        options_json = (
            _to_json_str(data["options"])
            if "options" in data and data["options"] is not None
            else data.get("options_json")
        )
        answer_indices_json = (
            _to_json_str(data["answer_indices"])
            if "answer_indices" in data and data["answer_indices"] is not None
            else data.get("answer_indices_json")
        )
        code_language = data.get("code_language")
        if not code_language and fmt == "notebook":
            code_language = "python"

        starter_code = data.get("starter_code")
        if isinstance(starter_code, (list, dict)):
            starter_code = json.dumps(starter_code)

        if "allow_execution" in data and data["allow_execution"] is not None:
            allow_execution = 1 if data["allow_execution"] else 0
        else:
            allow_execution = 1 if fmt == "notebook" else 0

        with self.db.catalog_conn() as conn:
            cur = conn.execute(
                """
                INSERT INTO questions (
                    external_key, title, prompt, format, difficulty,
                    options_json, answer_indices_json, code_language,
                    starter_code, allow_execution, expected_answer,
                    evaluation_rubric, default_points, active,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    external_key,
                    title,
                    prompt,
                    fmt,
                    data.get("difficulty", "medium"),
                    options_json,
                    answer_indices_json,
                    code_language,
                    starter_code,
                    allow_execution,
                    data.get("expected_answer", "") or "",
                    data.get("evaluation_rubric", "") or "",
                    int(data.get("default_points", 10)),
                    1 if data.get("active", True) else 0,
                    now,
                    now,
                ),
            )
            qid = cur.lastrowid
            assert qid is not None
            self._sync_question_tags(conn, qid, data.get("tags") or [])
            row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
            tags_map = self._fetch_tags_map(conn, [qid])
            return self._row_to_question(row, tags_map[qid])

    def update_question(self, qid: int, data: dict[str, Any]) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            existing = conn.execute(
                "SELECT * FROM questions WHERE id = ?", (qid,)
            ).fetchone()
            if existing is None:
                return None

            prompt = (
                data["prompt"]
                if data.get("prompt") is not None
                else existing["prompt"]
            )
            title = (
                (data["title"].strip() or _derive_title(prompt))
                if data.get("title") is not None
                else existing["title"]
            )
            external_key = existing["external_key"]
            if "external_key" in data:
                ek = data["external_key"]
                external_key = str(ek).strip() or None if ek is not None else None

            fmt = (
                data["format"]
                if data.get("format") is not None
                else existing["format"]
            )
            difficulty = (
                data["difficulty"]
                if data.get("difficulty") is not None
                else existing["difficulty"]
            )

            options_json = existing["options_json"]
            if "options" in data:
                options_json = _to_json_str(data["options"])
            elif "options_json" in data:
                options_json = data["options_json"]

            answer_indices_json = existing["answer_indices_json"]
            if "answer_indices" in data:
                answer_indices_json = _to_json_str(data["answer_indices"])
            elif "answer_indices_json" in data:
                answer_indices_json = data["answer_indices_json"]

            code_language = (
                data["code_language"]
                if "code_language" in data
                else existing["code_language"]
            )
            starter_code = (
                json.dumps(data["starter_code"])
                if "starter_code" in data and isinstance(data["starter_code"], (list, dict))
                else data.get("starter_code", existing["starter_code"])
            )
            allow_execution = (
                (1 if data["allow_execution"] else 0)
                if data.get("allow_execution") is not None
                else existing["allow_execution"]
            )
            expected_answer = (
                data["expected_answer"]
                if data.get("expected_answer") is not None
                else existing["expected_answer"]
            )
            evaluation_rubric = (
                data["evaluation_rubric"]
                if data.get("evaluation_rubric") is not None
                else existing["evaluation_rubric"]
            )
            default_points = (
                int(data["default_points"])
                if data.get("default_points") is not None
                else existing["default_points"]
            )
            active = (
                (1 if data["active"] else 0)
                if data.get("active") is not None
                else existing["active"]
            )

            conn.execute(
                """
                UPDATE questions
                SET external_key = ?, title = ?, prompt = ?, format = ?,
                    difficulty = ?, options_json = ?, answer_indices_json = ?,
                    code_language = ?, starter_code = ?, allow_execution = ?,
                    expected_answer = ?, evaluation_rubric = ?, default_points = ?,
                    active = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    external_key,
                    title,
                    prompt,
                    fmt,
                    difficulty,
                    options_json,
                    answer_indices_json,
                    code_language,
                    starter_code,
                    allow_execution,
                    expected_answer,
                    evaluation_rubric,
                    default_points,
                    active,
                    _utc_now(),
                    qid,
                ),
            )
            if data.get("tags") is not None:
                self._sync_question_tags(conn, qid, data["tags"])

            row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
            tags_map = self._fetch_tags_map(conn, [qid])
            return self._row_to_question(row, tags_map[qid])

    def delete_question(self, qid: int) -> bool:
        with self.db.catalog_conn() as conn:
            cur = conn.execute("DELETE FROM questions WHERE id = ?", (qid,))
            return cur.rowcount > 0

    def get_question(self, qid: int) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
            if row is None:
                return None
            tags_map = self._fetch_tags_map(conn, [qid])
            return self._row_to_question(row, tags_map[qid])

    def get_question_by_external_key(self, external_key: str) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            row = conn.execute(
                "SELECT * FROM questions WHERE external_key = ?", (external_key,)
            ).fetchone()
            if row is None:
                return None
            tags_map = self._fetch_tags_map(conn, [row["id"]])
            return self._row_to_question(row, tags_map[row["id"]])

    def list_questions(
        self,
        search: str | None = None,
        tags: list[str] | None = None,
        tag_match: str = "any",
        fmt: str | None = None,
        difficulty: str | None = None,
        active_only: bool = False,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []

        if active_only:
            clauses.append("q.active = 1")
        if fmt:
            clauses.append("q.format = ?")
            params.append(fmt)
        if difficulty:
            clauses.append("q.difficulty = ?")
            params.append(difficulty)
        if search and search.strip():
            like_term = f"%{search.strip().lower()}%"
            clauses.append(
                "(LOWER(q.title) LIKE ? OR LOWER(q.prompt) LIKE ? OR LOWER(COALESCE(q.external_key, '')) LIKE ?)"
            )
            params.extend([like_term, like_term, like_term])

        norm_tags = _normalize_tags(tags)
        if norm_tags:
            placeholders = ",".join("?" for _ in norm_tags)
            if tag_match == "all":
                clauses.append(
                    f"""
                    q.id IN (
                        SELECT qt.question_id
                        FROM question_tags qt
                        JOIN tags t ON t.id = qt.tag_id
                        WHERE t.name IN ({placeholders})
                        GROUP BY qt.question_id
                        HAVING COUNT(DISTINCT t.name) = ?
                    )
                    """
                )
                params.extend(norm_tags)
                params.append(len(norm_tags))
            else:
                clauses.append(
                    f"""
                    q.id IN (
                        SELECT qt.question_id
                        FROM question_tags qt
                        JOIN tags t ON t.id = qt.tag_id
                        WHERE t.name IN ({placeholders})
                    )
                    """
                )
                params.extend(norm_tags)

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT q.* FROM questions q {where_sql} ORDER BY q.id ASC"

        with self.db.catalog_conn() as conn:
            rows = conn.execute(sql, params).fetchall()
            qids = [r["id"] for r in rows]
            tags_map = self._fetch_tags_map(conn, qids)
            return [self._row_to_question(r, tags_map[r["id"]]) for r in rows]

    def list_tags(self) -> list[dict[str, Any]]:
        with self.db.catalog_conn() as conn:
            rows = conn.execute(
                """
                SELECT t.id, t.name, COUNT(qt.question_id) AS question_count
                FROM tags t
                LEFT JOIN question_tags qt ON qt.tag_id = t.id
                GROUP BY t.id, t.name
                ORDER BY t.name ASC
                """
            ).fetchall()
            return [
                {
                    "id": r["id"],
                    "name": r["name"],
                    "question_count": r["question_count"],
                }
                for r in rows
            ]

    # ------------------------------------------------------------------
    # Templates
    # ------------------------------------------------------------------

    def create_template(self, data: dict[str, Any]) -> dict[str, Any]:
        now = _utc_now()
        is_default = 1 if data.get("is_default", False) else 0
        random_rules_json = (
            _to_json_str(data["random_rules"])
            if "random_rules" in data and data["random_rules"] is not None
            else data.get("random_rules_json")
        )
        summary_dimensions_json = (
            _to_json_str(data["summary_dimensions"])
            if "summary_dimensions" in data and data["summary_dimensions"] is not None
            else (data.get("summary_dimensions_json") or "[]")
        )

        with self.db.catalog_conn() as conn:
            if is_default:
                conn.execute("UPDATE templates SET is_default = 0 WHERE is_default = 1")
            cur = conn.execute(
                """
                INSERT INTO templates (
                    slug, name, role_title, description, selection_mode,
                    random_rules_json, timer_minutes, open_book_policy,
                    allow_code_execution, allow_package_install, access_code,
                    summary_dimensions_json, is_default, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data["slug"].strip(),
                    data["name"].strip(),
                    data["role_title"].strip(),
                    data.get("description", "") or "",
                    data.get("selection_mode", "curated"),
                    random_rules_json,
                    int(data.get("timer_minutes", 45)),
                    data.get("open_book_policy", "none"),
                    1 if data.get("allow_code_execution", True) else 0,
                    1 if data.get("allow_package_install", False) else 0,
                    data.get("access_code", "") or "",
                    summary_dimensions_json,
                    is_default,
                    now,
                    now,
                ),
            )
            tid = cur.lastrowid
            assert tid is not None
            if data.get("questions"):
                self._replace_template_questions(conn, tid, data["questions"])
            row = conn.execute("SELECT * FROM templates WHERE id = ?", (tid,)).fetchone()
            return self._hydrate_template(conn, row)

    def update_template(self, tid: int, data: dict[str, Any]) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            existing = conn.execute(
                "SELECT * FROM templates WHERE id = ?", (tid,)
            ).fetchone()
            if existing is None:
                return None

            is_default = (
                (1 if data["is_default"] else 0)
                if "is_default" in data and data["is_default"] is not None
                else existing["is_default"]
            )
            if is_default:
                conn.execute(
                    "UPDATE templates SET is_default = 0 WHERE id != ? AND is_default = 1",
                    (tid,),
                )

            random_rules_json = existing["random_rules_json"]
            if "random_rules" in data:
                random_rules_json = _to_json_str(data["random_rules"])
            elif "random_rules_json" in data:
                random_rules_json = data["random_rules_json"]

            summary_dimensions_json = existing["summary_dimensions_json"]
            if data.get("summary_dimensions") is not None:
                summary_dimensions_json = _to_json_str(data["summary_dimensions"]) or "[]"
            elif data.get("summary_dimensions_json") is not None:
                summary_dimensions_json = data["summary_dimensions_json"] or "[]"

            conn.execute(
                """
                UPDATE templates
                SET slug = ?, name = ?, role_title = ?, description = ?,
                    selection_mode = ?, random_rules_json = ?, timer_minutes = ?,
                    open_book_policy = ?, allow_code_execution = ?,
                    allow_package_install = ?, access_code = ?,
                    summary_dimensions_json = ?, is_default = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    data["slug"].strip()
                    if data.get("slug") is not None
                    else existing["slug"],
                    data["name"].strip()
                    if data.get("name") is not None
                    else existing["name"],
                    data["role_title"].strip()
                    if data.get("role_title") is not None
                    else existing["role_title"],
                    data["description"]
                    if data.get("description") is not None
                    else existing["description"],
                    data["selection_mode"]
                    if data.get("selection_mode") is not None
                    else existing["selection_mode"],
                    random_rules_json,
                    int(data["timer_minutes"])
                    if data.get("timer_minutes") is not None
                    else existing["timer_minutes"],
                    data["open_book_policy"]
                    if data.get("open_book_policy") is not None
                    else existing["open_book_policy"],
                    (1 if data["allow_code_execution"] else 0)
                    if data.get("allow_code_execution") is not None
                    else existing["allow_code_execution"],
                    (1 if data["allow_package_install"] else 0)
                    if data.get("allow_package_install") is not None
                    else existing["allow_package_install"],
                    data["access_code"]
                    if data.get("access_code") is not None
                    else existing["access_code"],
                    summary_dimensions_json,
                    is_default,
                    _utc_now(),
                    tid,
                ),
            )
            if "questions" in data and data["questions"] is not None:
                self._replace_template_questions(conn, tid, data["questions"])

            row = conn.execute("SELECT * FROM templates WHERE id = ?", (tid,)).fetchone()
            return self._hydrate_template(conn, row)

    def delete_template(self, tid: int) -> bool:
        with self.db.catalog_conn() as conn:
            cur = conn.execute("DELETE FROM templates WHERE id = ?", (tid,))
            return cur.rowcount > 0

    def clone_template(self, tid: int, new_slug: str, new_name: str) -> dict[str, Any]:
        src = self.get_template(tid)
        if src is None:
            raise ValueError(f"Template {tid} not found")
        payload = {
            "slug": new_slug,
            "name": new_name,
            "role_title": src["role_title"],
            "description": src["description"],
            "selection_mode": src["selection_mode"],
            "random_rules": src["random_rules"],
            "timer_minutes": src["timer_minutes"],
            "open_book_policy": src["open_book_policy"],
            "allow_code_execution": src["allow_code_execution"],
            "allow_package_install": src["allow_package_install"],
            "access_code": src["access_code"],
            "summary_dimensions": src["summary_dimensions"],
            "is_default": False,
            "questions": [
                {
                    "question_id": q["question_id"],
                    "position": q["position"],
                    "points_override": q["points_override"],
                    "expected_answer_override": q["expected_answer_override"],
                    "rubric_override": q["rubric_override"],
                }
                for q in src["questions"]
            ],
        }
        return self.create_template(payload)

    def get_template(self, tid: int) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            row = conn.execute("SELECT * FROM templates WHERE id = ?", (tid,)).fetchone()
            if row is None:
                return None
            return self._hydrate_template(conn, row)

    def get_template_by_slug(self, slug: str) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            row = conn.execute(
                "SELECT * FROM templates WHERE slug = ?", (slug,)
            ).fetchone()
            if row is None:
                return None
            return self._hydrate_template(conn, row)

    def get_default_template(self) -> dict[str, Any] | None:
        with self.db.catalog_conn() as conn:
            row = conn.execute(
                "SELECT * FROM templates ORDER BY is_default DESC, id ASC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            return self._hydrate_template(conn, row)

    def list_templates(self) -> list[dict[str, Any]]:
        with self.db.catalog_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM templates ORDER BY is_default DESC, id ASC"
            ).fetchall()
            return [self._hydrate_template(conn, r) for r in rows]

    def resolve_template_questions(self, template_id: int) -> list[dict[str, Any]]:
        """Resolve ordered question payloads with effective overrides for a template."""
        tpl = self.get_template(template_id)
        if tpl is None:
            raise ValueError(f"Template {template_id} not found")

        if tpl["selection_mode"] == "curated":
            with self.db.catalog_conn() as conn:
                rows = conn.execute(
                    """
                    SELECT q.*, tq.position AS tq_position,
                           tq.points_override,
                           tq.expected_answer_override,
                           tq.rubric_override
                    FROM template_questions tq
                    JOIN questions q ON q.id = tq.question_id
                    WHERE tq.template_id = ?
                    ORDER BY tq.position ASC, tq.id ASC
                    """,
                    (template_id,),
                ).fetchall()
                qids = [r["id"] for r in rows]
                tags_map = self._fetch_tags_map(conn, qids)
                resolved: list[dict[str, Any]] = []
                for row in rows:
                    q = self._row_to_question(row, tags_map[row["id"]])
                    q["position"] = row["tq_position"]
                    q["points_override"] = row["points_override"]
                    q["expected_answer_override"] = row["expected_answer_override"]
                    q["rubric_override"] = row["rubric_override"]
                    q["effective_points"] = (
                        row["points_override"]
                        if row["points_override"] is not None
                        else q["default_points"]
                    )
                    q["effective_expected_answer"] = (
                        row["expected_answer_override"]
                        if row["expected_answer_override"] is not None
                        else q["expected_answer"]
                    )
                    q["effective_rubric"] = (
                        row["rubric_override"]
                        if row["rubric_override"] is not None
                        else q["evaluation_rubric"]
                    )
                    resolved.append(q)
                return resolved

        # random_pool mode
        rules = tpl.get("random_rules") or {}
        tags = rules.get("tags") or None
        match = rules.get("match", "any")
        total = rules.get("total")
        difficulty_counts = rules.get("difficulty_counts") or {}

        pool = self.list_questions(tags=tags, tag_match=match, active_only=True)
        selected: list[dict[str, Any]] = []

        positive_diff_counts = {
            k: int(v) for k, v in difficulty_counts.items() if v and int(v) > 0
        }
        if positive_diff_counts:
            by_diff: dict[str, list[dict[str, Any]]] = {}
            for q in pool:
                by_diff.setdefault(q["difficulty"], []).append(q)

            ordered_diffs = ["easy", "medium", "hard"] + [
                d for d in positive_diff_counts if d not in {"easy", "medium", "hard"}
            ]
            for diff in ordered_diffs:
                want = positive_diff_counts.get(diff, 0)
                if want <= 0:
                    continue
                bucket = list(by_diff.get(diff, []))
                random.shuffle(bucket)
                selected.extend(bucket[: min(want, len(bucket))])

            if total is not None and int(total) > 0:
                selected = selected[: int(total)]
        else:
            shuffled = list(pool)
            random.shuffle(shuffled)
            if total is not None and int(total) > 0:
                selected = shuffled[: min(int(total), len(shuffled))]
            else:
                selected = shuffled

        for idx, q in enumerate(selected):
            q["position"] = idx
            q["points_override"] = None
            q["expected_answer_override"] = None
            q["rubric_override"] = None
            q["effective_points"] = q["default_points"]
            q["effective_expected_answer"] = q["expected_answer"]
            q["effective_rubric"] = q["evaluation_rubric"]
        return selected

    # ------------------------------------------------------------------
    # Submissions (Runtime DB)
    # ------------------------------------------------------------------

    def create_submission(self, data: dict[str, Any]) -> dict[str, Any]:
        sub_id = str(data.get("id") or uuid.uuid4())
        answers_json = (
            _to_json_str(data["answers"])
            if "answers" in data
            else data.get("answers_json")
        )
        summary_json = (
            _to_json_str(data["summary"])
            if "summary" in data
            else data.get("summary_json")
        )
        delivery_log_json = (
            _to_json_str(data["delivery_log"])
            if "delivery_log" in data
            else data.get("delivery_log_json")
        )

        with self.db.runtime_conn() as conn:
            conn.execute(
                """
                INSERT INTO submissions (
                    id, template_id, template_name, role_title,
                    candidate_name, candidate_email, status,
                    started_at, submitted_at, duration_seconds,
                    final_score, max_score, score_percentage,
                    answers_json, summary_json, delivery_log_json, pdf_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sub_id,
                    data.get("template_id"),
                    data.get("template_name", "") or "",
                    data.get("role_title", "") or "",
                    data["candidate_name"],
                    data.get("candidate_email"),
                    data.get("status", "in_progress"),
                    data.get("started_at") or _utc_now(),
                    data.get("submitted_at"),
                    data.get("duration_seconds"),
                    data.get("final_score"),
                    data.get("max_score"),
                    data.get("score_percentage"),
                    answers_json,
                    summary_json,
                    delivery_log_json,
                    data.get("pdf_path"),
                ),
            )
            row = conn.execute(
                "SELECT * FROM submissions WHERE id = ?", (sub_id,)
            ).fetchone()
            return self._row_to_submission(row)

    def update_submission(
        self, sub_id: str, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self.db.runtime_conn() as conn:
            existing = conn.execute(
                "SELECT * FROM submissions WHERE id = ?", (sub_id,)
            ).fetchone()
            if existing is None:
                return None

            answers_json = existing["answers_json"]
            if "answers" in data:
                answers_json = _to_json_str(data["answers"])
            elif "answers_json" in data:
                answers_json = data["answers_json"]

            summary_json = existing["summary_json"]
            if "summary" in data:
                summary_json = _to_json_str(data["summary"])
            elif "summary_json" in data:
                summary_json = data["summary_json"]

            delivery_log_json = existing["delivery_log_json"]
            if "delivery_log" in data:
                delivery_log_json = _to_json_str(data["delivery_log"])
            elif "delivery_log_json" in data:
                delivery_log_json = data["delivery_log_json"]

            conn.execute(
                """
                UPDATE submissions
                SET template_id = ?, template_name = ?, role_title = ?,
                    candidate_name = ?, candidate_email = ?, status = ?,
                    started_at = ?, submitted_at = ?, duration_seconds = ?,
                    final_score = ?, max_score = ?, score_percentage = ?,
                    answers_json = ?, summary_json = ?, delivery_log_json = ?,
                    pdf_path = ?
                WHERE id = ?
                """,
                (
                    data.get("template_id", existing["template_id"]),
                    data["template_name"]
                    if data.get("template_name") is not None
                    else existing["template_name"],
                    data["role_title"]
                    if data.get("role_title") is not None
                    else existing["role_title"],
                    data["candidate_name"]
                    if data.get("candidate_name") is not None
                    else existing["candidate_name"],
                    data.get("candidate_email", existing["candidate_email"]),
                    data["status"]
                    if data.get("status") is not None
                    else existing["status"],
                    data.get("started_at", existing["started_at"]),
                    data.get("submitted_at", existing["submitted_at"]),
                    data.get("duration_seconds", existing["duration_seconds"]),
                    data.get("final_score", existing["final_score"]),
                    data.get("max_score", existing["max_score"]),
                    data.get("score_percentage", existing["score_percentage"]),
                    answers_json,
                    summary_json,
                    delivery_log_json,
                    data.get("pdf_path", existing["pdf_path"]),
                    sub_id,
                ),
            )
            row = conn.execute(
                "SELECT * FROM submissions WHERE id = ?", (sub_id,)
            ).fetchone()
            return self._row_to_submission(row)

    def get_submission(self, sub_id: str) -> dict[str, Any] | None:
        with self.db.runtime_conn() as conn:
            row = conn.execute(
                "SELECT * FROM submissions WHERE id = ?", (sub_id,)
            ).fetchone()
            if row is None:
                return None
            return self._row_to_submission(row)

    def list_submissions(self) -> list[dict[str, Any]]:
        with self.db.runtime_conn() as conn:
            rows = conn.execute(
                """
                SELECT * FROM submissions
                ORDER BY COALESCE(submitted_at, started_at) DESC, id DESC
                """
            ).fetchall()
            return [self._row_to_submission(r) for r in rows]
