"""Public candidate-facing FastAPI router (/api/public/*)."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import platform
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from backend.config import Settings
from backend.routers import AppContext, get_ctx
from backend.services.delivery.orchestrator import DeliveryOrchestrator
from backend.services.llm import LLMService, format_notebook_answer
from backend.services.pdf_report import generate_interview_pdf
from backend.services.search import fetch_proxied_url, search_duckduckgo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/public", tags=["public"])


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class PublicLoginRequest(BaseModel):
    candidate_name: str = Field(..., min_length=1, max_length=200)
    candidate_email: str | None = Field(default=None, max_length=254)
    access_code: str = Field(default="")
    slug: str | None = Field(default=None)


class AnswerItem(BaseModel):
    question_id: int
    answer: Any = None


class ProgressRequest(BaseModel):
    session_token: str = Field(default="")
    answers: list[AnswerItem] | dict[str, Any] = Field(default_factory=list)
    candidate_name: str | None = None


class FinishRequest(BaseModel):
    session_token: str = Field(default="")
    candidate_name: str | None = None
    candidate_email: str | None = None
    slug: str | None = None
    answers: list[AnswerItem] = Field(default_factory=list)
    duration_seconds: int | None = None


class NotebookExecuteRequest(BaseModel):
    session_token: str = Field(default="")
    code: str = Field(default="")


class NotebookInstallRequest(BaseModel):
    session_token: str = Field(default="")
    package: str | None = None
    spec: str | None = None


class NotebookRestartRequest(BaseModel):
    session_token: str = Field(default="")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _effective_access_code(tpl: dict[str, Any], settings: Settings) -> str:
    env_code = (settings.access_code or "").strip()
    if env_code:
        return env_code
    return (tpl.get("access_code") or "").strip()


def _estimate_template_question_count(ctx: AppContext, tpl: dict[str, Any]) -> int:
    if tpl.get("selection_mode") == "curated":
        return len(tpl.get("questions") or [])
    rules = tpl.get("random_rules") or {}
    tags = rules.get("tags") or None
    match = rules.get("match", "any")
    pool = ctx.repo.list_questions(tags=tags, tag_match=match, active_only=True)
    total = rules.get("total")
    diff_counts = rules.get("difficulty_counts") or {}
    pos_diffs = {k: int(v) for k, v in diff_counts.items() if v and int(v) > 0}
    if pos_diffs:
        by_diff: dict[str, int] = {}
        for q in pool:
            by_diff[q["difficulty"]] = by_diff.get(q["difficulty"], 0) + 1
        count = sum(min(want, by_diff.get(diff, 0)) for diff, want in pos_diffs.items())
        if total is not None and int(total) > 0:
            count = min(count, int(total))
        return count
    if total is not None and int(total) > 0:
        return min(int(total), len(pool))
    return len(pool)


def _safe_template_metadata(
    tpl: dict[str, Any],
    settings: Settings,
    question_count: int,
) -> dict[str, Any]:
    """Return candidate-safe template metadata without access codes, rubrics, or answers."""
    return {
        "id": tpl["id"],
        "slug": tpl["slug"],
        "name": tpl["name"],
        "role_title": tpl["role_title"],
        "description": tpl.get("description") or "",
        "timer_minutes": int(tpl.get("timer_minutes") or 45),
        "open_book_policy": tpl.get("open_book_policy") or "none",
        "allow_code_execution": bool(tpl.get("allow_code_execution", True)),
        "allow_package_install": bool(tpl.get("allow_package_install", False)),
        "requires_access_code": bool(_effective_access_code(tpl, settings)),
        "question_count": question_count,
        "app_title": settings.app_title,
    }


def _is_open_book_allowed(open_book_policy: str, difficulty: str) -> bool:
    policy = (open_book_policy or "none").strip().lower()
    if policy == "all":
        return True
    if policy == "medium_hard":
        return (difficulty or "").strip().lower() in {"medium", "hard"}
    return False


def _sanitize_question_for_candidate(
    q: dict[str, Any], open_book_policy: str
) -> dict[str, Any]:
    """Allow-list candidate-safe question fields; never leak answer_indices or rubrics."""
    answer_indices = q.get("answer_indices") or []
    points = (
        q.get("effective_points")
        if q.get("effective_points") is not None
        else q.get("default_points", 10)
    )
    return {
        "id": q["id"],
        "title": q.get("title") or "",
        "prompt": q["prompt"],
        "format": q["format"],
        "difficulty": q["difficulty"],
        "options": list(q.get("options") or []) if q["format"] == "mcq" else [],
        "multi_select": len(answer_indices) > 1 if q["format"] == "mcq" else False,
        "code_language": q.get("code_language"),
        "starter_code": q.get("starter_code"),
        "allow_execution": bool(q.get("allow_execution", False)),
        "points": int(points),
        "tags": list(q.get("tags") or []),
        "position": q.get("position", 0),
        "open_book_allowed": _is_open_book_allowed(open_book_policy, q["difficulty"]),
    }


def _parse_candidate_mcq_indices(raw_answer: Any) -> list[int]:
    """Parse candidate MCQ selections from int, string, comma-separated, or list."""
    if raw_answer is None or isinstance(raw_answer, bool):
        return []
    if isinstance(raw_answer, int):
        return [raw_answer]
    if isinstance(raw_answer, list):
        parsed: list[int] = []
        for item in raw_answer:
            if isinstance(item, bool):
                continue
            try:
                parsed.append(int(str(item).strip()))
            except (TypeError, ValueError):
                continue
        return sorted(set(parsed))
    if isinstance(raw_answer, str):
        text = raw_answer.strip()
        if not text:
            return []
        if text.startswith("["):
            try:
                arr = json.loads(text)
                if isinstance(arr, list):
                    return _parse_candidate_mcq_indices(arr)
            except json.JSONDecodeError:
                pass
        parsed_str: list[int] = []
        for tok in text.split(","):
            tok = tok.strip()
            if not tok:
                continue
            try:
                parsed_str.append(int(tok))
            except ValueError:
                continue
        return sorted(set(parsed_str))
    return []


def _format_mcq_choices(options: list[str], indices: list[int]) -> str:
    if not indices:
        return ""
    labels: list[str] = []
    for idx in indices:
        if 0 <= idx < len(options):
            labels.append(f"[{idx}] {options[idx]}")
        else:
            labels.append(f"[{idx}]")
    return "; ".join(labels)


def _grade_mcq_question(
    q: dict[str, Any], raw_answer: Any, max_points: float
) -> tuple[dict[str, Any], str, bool]:
    """Deterministically grade an MCQ response and return (evaluation, display_text, attempted)."""
    options = list(q.get("options") or [])
    expected_indices = sorted(
        {int(i) for i in (q.get("answer_indices") or []) if not isinstance(i, bool)}
    )
    selected_indices = _parse_candidate_mcq_indices(raw_answer)
    display_text = _format_mcq_choices(options, selected_indices)

    if not selected_indices:
        return (
            {
                "score": 0.0,
                "max_points": max_points,
                "correctness_pct": 0.0,
                "rubric_breakdown": ["No option selected."],
                "feedback": "No answer selected.",
                "needs_manual_review": False,
            },
            "",
            False,
        )

    if selected_indices == expected_indices:
        return (
            {
                "score": round(max_points, 2),
                "max_points": max_points,
                "correctness_pct": 100.0,
                "rubric_breakdown": ["Selected exact expected option(s)."],
                "feedback": "Correct answer.",
                "needs_manual_review": False,
            },
            display_text,
            True,
        )

    expected_display = _format_mcq_choices(options, expected_indices)
    return (
        {
            "score": 0.0,
            "max_points": max_points,
            "correctness_pct": 0.0,
            "rubric_breakdown": [
                f"Selected: {display_text}",
                f"Expected: {expected_display}",
            ],
            "feedback": f"Incorrect. Expected: {expected_display}.",
            "needs_manual_review": False,
        },
        display_text,
        True,
    )


def _compute_duration_seconds(
    started_at: str | None, submitted_at: str, explicit_duration: int | None
) -> int:
    if explicit_duration is not None and explicit_duration >= 0:
        return int(explicit_duration)
    if not started_at:
        return 0
    try:
        start_dt = datetime.fromisoformat(started_at)
        end_dt = datetime.fromisoformat(submitted_at)
        return max(0, int((end_dt - start_dt).total_seconds()))
    except (TypeError, ValueError):
        return 0


def _require_candidate_session(
    ctx: AppContext, session_token: str | None
) -> dict[str, Any]:
    """Verify HMAC-SHA256 signed candidate session_token or raise HTTP 401."""
    claims = ctx.verify_candidate_token((session_token or "").strip())
    if claims is None:
        raise HTTPException(
            status_code=401, detail="Invalid or expired session token."
        )
    return claims


def _resolve_template_for_claims(
    ctx: AppContext, claims: dict[str, Any]
) -> dict[str, Any] | None:
    """Resolve template metadata from active session or catalog DB for verified token claims."""
    session_id = str(claims["session_id"])
    session = ctx.active_sessions.get(session_id)
    if session is not None and session.get("template") is not None:
        return session["template"]
    slug = str(claims.get("template_slug") or "").strip()
    if slug:
        return ctx.repo.get_template_by_slug(slug)
    return None


def _effective_notebook_permissions(
    ctx: AppContext, claims: dict[str, Any]
) -> tuple[bool, bool]:
    """Return (allow_code_execution, allow_package_install) enforced from signed claims + catalog."""
    allow_exec = bool(claims.get("allow_code_execution", False))
    allow_pkg = bool(claims.get("allow_package_install", False))
    tpl = _resolve_template_for_claims(ctx, claims)
    if tpl is not None:
        allow_exec = allow_exec and bool(tpl.get("allow_code_execution", False))
        allow_pkg = allow_pkg and bool(tpl.get("allow_package_install", False))
    return allow_exec, allow_pkg


def _stringify_raw_answer(raw_answer: Any) -> str:
    if raw_answer is None:
        return ""
    if isinstance(raw_answer, str):
        return raw_answer
    return json.dumps(raw_answer, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Template discovery & Login
# ---------------------------------------------------------------------------


@router.get("/templates/default")
async def get_default_template(ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    tpl = ctx.repo.get_default_template()
    if tpl is None:
        raise HTTPException(status_code=404, detail="No interview template configured.")
    count = _estimate_template_question_count(ctx, tpl)
    return _safe_template_metadata(tpl, ctx.settings, count)


@router.get("/templates/{slug}")
async def get_template_by_slug(
    slug: str, ctx: AppContext = Depends(get_ctx)
) -> dict[str, Any]:
    tpl = ctx.repo.get_template_by_slug(slug)
    if tpl is None:
        raise HTTPException(status_code=404, detail=f"Template '{slug}' not found.")
    count = _estimate_template_question_count(ctx, tpl)
    return _safe_template_metadata(tpl, ctx.settings, count)


@router.post("/login")
async def candidate_login(
    payload: PublicLoginRequest, ctx: AppContext = Depends(get_ctx)
) -> dict[str, Any]:
    candidate_name = payload.candidate_name.strip()
    if not candidate_name:
        raise HTTPException(status_code=400, detail="Candidate name is required.")

    candidate_email = (payload.candidate_email or "").strip() or None

    if payload.slug and payload.slug.strip():
        tpl = ctx.repo.get_template_by_slug(payload.slug.strip())
        if tpl is None:
            raise HTTPException(
                status_code=404, detail=f"Template '{payload.slug.strip()}' not found."
            )
    else:
        tpl = ctx.repo.get_default_template()
        if tpl is None:
            raise HTTPException(status_code=404, detail="No interview template configured.")

    expected_code = _effective_access_code(tpl, ctx.settings)
    if expected_code:
        provided = (payload.access_code or "").strip()
        if not hmac.compare_digest(provided, expected_code):
            raise HTTPException(status_code=401, detail="Invalid access code.")

    resolved_questions = ctx.repo.resolve_template_questions(int(tpl["id"]))
    session_id = str(uuid.uuid4())
    started_at = _utc_now()
    open_book_policy = tpl.get("open_book_policy") or "none"

    session_token = ctx.issue_candidate_token(
        session_id=session_id,
        template_slug=tpl["slug"],
        candidate_name=candidate_name,
        candidate_email=candidate_email,
        allow_code_execution=bool(tpl.get("allow_code_execution", True)),
        allow_package_install=bool(tpl.get("allow_package_install", False)),
        open_book_policy=open_book_policy,
        timer_minutes=int(tpl.get("timer_minutes") or 45),
    )

    ctx.repo.create_submission(
        {
            "id": session_id,
            "template_id": tpl["id"],
            "template_name": tpl["name"],
            "role_title": tpl["role_title"],
            "candidate_name": candidate_name,
            "candidate_email": candidate_email,
            "status": "in_progress",
            "started_at": started_at,
            "answers": [],
        }
    )

    ctx.active_sessions[session_id] = {
        "session_id": session_id,
        "candidate_name": candidate_name,
        "candidate_email": candidate_email,
        "started_at": started_at,
        "template": tpl,
        "questions": resolved_questions,
    }

    safe_questions = [
        _sanitize_question_for_candidate(q, open_book_policy)
        for q in resolved_questions
    ]

    return {
        "session_token": session_token,
        "candidate_name": candidate_name,
        "candidate_email": candidate_email,
        "template": _safe_template_metadata(tpl, ctx.settings, len(resolved_questions)),
        "questions": safe_questions,
        "python_version": platform.python_version(),
    }


# ---------------------------------------------------------------------------
# Draft Progress & Serverless-Safe Synchronous Finish Pipeline
# ---------------------------------------------------------------------------


@router.post("/progress")
async def save_progress(
    payload: ProgressRequest, ctx: AppContext = Depends(get_ctx)
) -> dict[str, Any]:
    claims = _require_candidate_session(ctx, payload.session_token)
    session_id = str(claims["session_id"])

    serialized_answers = (
        [item.model_dump() for item in payload.answers]
        if isinstance(payload.answers, list)
        else payload.answers
    )

    sub = ctx.repo.get_submission(session_id)
    if sub is None:
        # Serverless cold-start recovery from verified signed session token
        tpl = _resolve_template_for_claims(ctx, claims)
        ctx.repo.create_submission(
            {
                "id": session_id,
                "template_id": tpl["id"] if tpl else None,
                "template_name": tpl["name"] if tpl else "",
                "role_title": tpl["role_title"] if tpl else "Candidate",
                "candidate_name": str(claims.get("candidate_name") or "Candidate"),
                "candidate_email": claims.get("candidate_email"),
                "status": "in_progress",
                "answers": serialized_answers,
            }
        )
        return {"ok": True, "saved_at": _utc_now()}

    if sub["status"] in {"completed", "needs_review"}:
        raise HTTPException(status_code=409, detail="Submission already finalized.")

    ctx.repo.update_submission(
        session_id,
        {"answers": serialized_answers},
    )
    return {"ok": True, "saved_at": _utc_now()}


@router.post("/finish")
async def finish_interview(
    payload: FinishRequest, ctx: AppContext = Depends(get_ctx)
) -> dict[str, Any]:
    """Serverless-safe synchronous finish pipeline: backup -> parallel grade -> summary -> PDF -> deliver -> cleanup."""
    claims = _require_candidate_session(ctx, payload.session_token)
    session_id = str(claims["session_id"])
    session = ctx.active_sessions.get(session_id)
    sub = ctx.repo.get_submission(session_id)

    # Idempotent receipt if already finalized (prevents double grading/delivery on network retry)
    if sub is not None and sub["status"] in {"completed", "needs_review"}:
        ctx.kernel_manager.cleanup_session(session_id)
        ctx.active_sessions.pop(session_id, None)
        return {
            "status": "submitted",
            "submission_id": session_id,
            "candidate_name": sub["candidate_name"],
            "submitted_at": sub.get("submitted_at") or _utc_now(),
            "message": "Your assessment has already been submitted. Thank you!",
        }

    # Resolve template metadata (from active session, persisted submission, signed claims, or slug)
    tpl: dict[str, Any] | None = session.get("template") if session else None
    if tpl is None and sub and sub.get("template_id") is not None:
        tpl = ctx.repo.get_template(int(sub["template_id"]))
    if tpl is None and claims.get("template_slug"):
        tpl = ctx.repo.get_template_by_slug(str(claims["template_slug"]).strip())
    if tpl is None and payload.slug:
        tpl = ctx.repo.get_template_by_slug(payload.slug.strip())
    if tpl is None:
        tpl = ctx.repo.get_default_template()

    candidate_name = (
        str(claims.get("candidate_name") or "").strip()
        or (payload.candidate_name or "").strip()
        or (session.get("candidate_name") if session else "")
        or (sub.get("candidate_name") if sub else "")
        or "Candidate"
    )
    candidate_email = (
        (str(claims.get("candidate_email") or "").strip() or None)
        or ((payload.candidate_email or "").strip() or None)
        or (session.get("candidate_email") if session else None)
        or (sub.get("candidate_email") if sub else None)
    )
    started_at = (
        (session.get("started_at") if session else None)
        or (sub.get("started_at") if sub else None)
        or _utc_now()
    )
    submitted_at = _utc_now()
    duration_seconds = _compute_duration_seconds(
        started_at, submitted_at, payload.duration_seconds
    )

    template_id = tpl["id"] if tpl else (sub.get("template_id") if sub else None)
    template_name = (
        tpl["name"] if tpl else (sub.get("template_name") if sub else "")
    )
    role_title = (
        tpl["role_title"] if tpl else (sub.get("role_title") if sub else "Candidate")
    )
    summary_dimensions = list(tpl.get("summary_dimensions") or []) if tpl else []

    # Ensure submission row exists in runtime DB and mark evaluating
    if sub is None:
        ctx.repo.create_submission(
            {
                "id": session_id,
                "template_id": template_id,
                "template_name": template_name,
                "role_title": role_title,
                "candidate_name": candidate_name,
                "candidate_email": candidate_email,
                "status": "evaluating",
                "started_at": started_at,
                "submitted_at": submitted_at,
                "duration_seconds": duration_seconds,
            }
        )
    else:
        ctx.repo.update_submission(
            session_id,
            {
                "status": "evaluating",
                "submitted_at": submitted_at,
                "duration_seconds": duration_seconds,
            },
        )

    # Resolve full internal question definitions (with answer keys & rubrics)
    if session is not None and session.get("questions"):
        resolved_questions: list[dict[str, Any]] = list(session["questions"])
    elif tpl is not None and tpl.get("selection_mode") == "curated":
        resolved_questions = ctx.repo.resolve_template_questions(int(tpl["id"]))
    else:
        resolved_questions = []
        for ans_item in payload.answers:
            q_obj = ctx.repo.get_question(ans_item.question_id)
            if q_obj is not None:
                q_obj["effective_points"] = q_obj["default_points"]
                q_obj["effective_expected_answer"] = q_obj["expected_answer"]
                q_obj["effective_rubric"] = q_obj["evaluation_rubric"]
                resolved_questions.append(q_obj)

    answer_map: dict[int, Any] = {
        int(item.question_id): item.answer for item in payload.answers
    }

    orchestrator = DeliveryOrchestrator(ctx.settings)
    llm_service = LLMService(ctx.settings)

    try:
        # 1. Immediate raw backup before LLM evaluation
        raw_backup_payload = {
            "submission_id": session_id,
            "candidate_name": candidate_name,
            "candidate_email": candidate_email,
            "template_id": template_id,
            "template_slug": tpl["slug"] if tpl else (claims.get("template_slug") or payload.slug),
            "template_name": template_name,
            "role_title": role_title,
            "started_at": started_at,
            "submitted_at": submitted_at,
            "duration_seconds": duration_seconds,
            "answers": [item.model_dump() for item in payload.answers],
        }
        backup_outcomes = await orchestrator.save_raw_backup(
            candidate_name, raw_backup_payload
        )

        # 2. Grade all questions concurrently (deterministic MCQ + parallel LLM)
        async def _evaluate_one(q: dict[str, Any]) -> dict[str, Any]:
            max_points = float(
                q["effective_points"]
                if q.get("effective_points") is not None
                else q.get("default_points", 10)
            )
            raw_ans = answer_map.get(q["id"])
            q_fmt = str(q.get("format") or "text").strip().lower()
            expected_answer = (
                q["effective_expected_answer"]
                if q.get("effective_expected_answer") is not None
                else q.get("expected_answer", "")
            )
            rubric = (
                q["effective_rubric"]
                if q.get("effective_rubric") is not None
                else q.get("evaluation_rubric", "")
            )

            if q_fmt == "mcq":
                evaluation, display_text, attempted = _grade_mcq_question(
                    q, raw_ans, max_points
                )
                expected_display = _format_mcq_choices(
                    list(q.get("options") or []),
                    list(q.get("answer_indices") or []),
                )
                if not expected_answer:
                    expected_answer = expected_display
                candidate_answer_raw = raw_ans
            else:
                ans_str = _stringify_raw_answer(raw_ans)
                display_text = (
                    format_notebook_answer(raw_ans)
                    if q_fmt == "notebook"
                    else ans_str
                )
                attempted = bool(display_text.strip())
                evaluation = await llm_service.score_answer(q, ans_str, role_title)
                candidate_answer_raw = raw_ans

            return {
                "question_id": q["id"],
                "title": q.get("title") or "",
                "question_text": q["prompt"],
                "question_format": q_fmt,
                "difficulty": q["difficulty"],
                "tags": list(q.get("tags") or []),
                "options": list(q.get("options") or []) if q_fmt == "mcq" else [],
                "expected_answer": expected_answer,
                "scoring_criteria": rubric,
                "candidate_answer": candidate_answer_raw,
                "candidate_answer_text": display_text,
                "attempted": attempted,
                "evaluation": evaluation,
            }

        evaluated_answers = list(
            await asyncio.gather(*(_evaluate_one(q) for q in resolved_questions))
        )

        # 3. Compute aggregate scores and status
        final_score = round(
            sum(float(a["evaluation"].get("score") or 0.0) for a in evaluated_answers),
            2,
        )
        max_score = round(
            sum(float(a["evaluation"].get("max_points") or 0.0) for a in evaluated_answers),
            2,
        )
        score_percentage = (
            round((final_score / max_score) * 100.0, 1) if max_score > 0 else 0.0
        )
        attempted_questions = sum(1 for a in evaluated_answers if a.get("attempted"))
        any_manual_review = any(
            bool(a["evaluation"].get("needs_manual_review")) for a in evaluated_answers
        )
        submission_status = "needs_review" if any_manual_review else "completed"

        results_payload: dict[str, Any] = {
            "id": session_id,
            "template_id": template_id,
            "template_name": template_name,
            "role_title": role_title,
            "candidate_name": candidate_name,
            "candidate_email": candidate_email,
            "status": submission_status,
            "started_at": started_at,
            "submitted_at": submitted_at,
            "duration_seconds": duration_seconds,
            "final_score": final_score,
            "max_score": max_score,
            "score_percentage": score_percentage,
            "total_questions": len(evaluated_answers),
            "attempted_questions": attempted_questions,
            "answers": evaluated_answers,
        }

        # 4. Generate executive summary
        summary = await llm_service.generate_summary(
            candidate_name=candidate_name,
            role_title=role_title,
            summary_dimensions=summary_dimensions,
            results=results_payload,
        )
        results_payload["summary"] = summary

        # 5. Render PDF report in worker thread (CPU-bound fpdf2)
        pdf_bytes = await asyncio.to_thread(generate_interview_pdf, results_payload)

        # 6. Deliver to all storage & notification sinks concurrently
        delivery_outcome = await orchestrator.deliver_report(
            candidate_name, results_payload, pdf_bytes
        )

        delivery_ts = _utc_now()
        delivery_log: list[dict[str, Any]] = []
        for entry in backup_outcomes:
            delivery_log.append({**entry, "phase": "backup", "timestamp": delivery_ts})
        for entry in delivery_outcome.get("storage") or []:
            delivery_log.append({**entry, "phase": "storage", "timestamp": delivery_ts})
        for entry in delivery_outcome.get("notifications") or []:
            delivery_log.append({**entry, "phase": "notify", "timestamp": delivery_ts})

        # 7. Persist finalized submission record
        ctx.repo.update_submission(
            session_id,
            {
                "candidate_name": candidate_name,
                "candidate_email": candidate_email,
                "status": submission_status,
                "submitted_at": submitted_at,
                "duration_seconds": duration_seconds,
                "final_score": final_score,
                "max_score": max_score,
                "score_percentage": score_percentage,
                "answers": evaluated_answers,
                "summary": summary,
                "delivery_log": delivery_log,
                "pdf_path": delivery_outcome.get("local_pdf_path"),
            },
        )
    except Exception:
        logger.exception("Unhandled error during interview finish pipeline")
        ctx.repo.update_submission(session_id, {"status": "failed"})
        raise
    finally:
        # 8. Synchronously clean up kernel subprocess & sandbox directory before returning
        ctx.kernel_manager.cleanup_session(session_id)
        ctx.active_sessions.pop(session_id, None)

    return {
        "status": "submitted",
        "submission_id": session_id,
        "candidate_name": candidate_name,
        "submitted_at": submitted_at,
        "message": "Your assessment has been submitted successfully. Thank you!",
    }


# ---------------------------------------------------------------------------
# Stateful Python Notebook Sandbox Endpoints
# ---------------------------------------------------------------------------


def _reject_if_finalized(ctx: AppContext, session_id: str) -> None:
    sub = ctx.repo.get_submission(session_id)
    if sub is not None and sub.get("status") in {"completed", "needs_review"}:
        raise HTTPException(status_code=409, detail="Submission already finalized.")


@router.post("/notebook/execute")
async def notebook_execute(
    payload: NotebookExecuteRequest, ctx: AppContext = Depends(get_ctx)
) -> dict[str, Any]:
    claims = _require_candidate_session(ctx, payload.session_token)
    session_id = str(claims["session_id"])
    _reject_if_finalized(ctx, session_id)
    allow_exec, allow_pkg = _effective_notebook_permissions(ctx, claims)
    if not allow_exec:
        raise HTTPException(
            status_code=403, detail="Code execution is disabled for this assessment."
        )
    return await ctx.kernel_manager.execute_cell(
        session_id, payload.code, allow_package_install=allow_pkg
    )


@router.post("/notebook/install")
async def notebook_install(
    payload: NotebookInstallRequest, ctx: AppContext = Depends(get_ctx)
) -> Response:
    claims = _require_candidate_session(ctx, payload.session_token)
    session_id = str(claims["session_id"])
    _reject_if_finalized(ctx, session_id)
    allow_exec, allow_pkg = _effective_notebook_permissions(ctx, claims)
    if not allow_exec or not allow_pkg:
        raise HTTPException(
            status_code=403,
            detail="Package installation is disabled for this assessment.",
        )

    pkg_spec = (payload.package or payload.spec or "").strip()
    if not pkg_spec:
        raise HTTPException(status_code=400, detail="Package name is required.")

    result = await ctx.kernel_manager.install_package(session_id, pkg_spec)
    status_code = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status_code, content=result)


@router.post("/notebook/restart")
async def notebook_restart(
    payload: NotebookRestartRequest, ctx: AppContext = Depends(get_ctx)
) -> dict[str, Any]:
    claims = _require_candidate_session(ctx, payload.session_token)
    session_id = str(claims["session_id"])
    _reject_if_finalized(ctx, session_id)
    allow_exec, _ = _effective_notebook_permissions(ctx, claims)
    if not allow_exec:
        raise HTTPException(
            status_code=403, detail="Code execution is disabled for this assessment."
        )
    return await ctx.kernel_manager.restart_kernel(session_id)


# ---------------------------------------------------------------------------
# Open-Book Search & SSRF-Hardened Web Proxy
# ---------------------------------------------------------------------------


def _enforce_open_book_if_session(ctx: AppContext, session_token: str | None) -> None:
    if not session_token:
        return
    claims = _require_candidate_session(ctx, session_token)
    policy = str(claims.get("open_book_policy") or "none").strip().lower()
    tpl = _resolve_template_for_claims(ctx, claims)
    if tpl is not None and (tpl.get("open_book_policy") or "none").strip().lower() == "none":
        policy = "none"
    if policy == "none":
        raise HTTPException(
            status_code=403,
            detail="Open-book web search is disabled for this assessment.",
        )


@router.get("/search")
async def open_book_search(
    q: str = Query(..., min_length=1),
    session_token: str | None = Query(default=None),
    ctx: AppContext = Depends(get_ctx),
) -> dict[str, Any]:
    _enforce_open_book_if_session(ctx, session_token)
    return await search_duckduckgo(q)


@router.get("/proxy")
async def open_book_proxy(
    url: str = Query(..., min_length=1),
    session_token: str | None = Query(default=None),
    ctx: AppContext = Depends(get_ctx),
) -> Response:
    _enforce_open_book_if_session(ctx, session_token)
    try:
        raw_bytes, content_type, status_code = await fetch_proxied_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Upstream fetch failed: {type(exc).__name__}"
        ) from exc

    return Response(
        content=raw_bytes,
        media_type=content_type,
        status_code=status_code,
        headers={"X-Content-Type-Options": "nosniff"},
    )
