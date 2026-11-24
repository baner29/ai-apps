"""Admin portal FastAPI router (/api/admin/*) with mode/auth gating and manual grading."""

from __future__ import annotations

import asyncio
import hmac
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.config import (
    SECRET_SETTING_FIELDS,
    Settings,
    get_masked_settings,
    save_local_env,
)
from backend.routers import AppContext, get_ctx
from backend.services.delivery.orchestrator import DeliveryOrchestrator
from backend.services.delivery.storage import build_artifact_stem, sanitize_candidate_slug
from backend.services.import_export import (
    VALID_DIFFICULTIES,
    VALID_FORMATS,
    commit_import,
    export_questions,
    get_sample_import_template,
    preview_import,
)
from backend.services.llm import LLMService
from backend.services.packager import build_deployment_bundle, get_deploy_readiness
from backend.services.pdf_report import generate_interview_pdf

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

_VALID_SELECTION_MODES = frozenset({"curated", "random_pool"})
_VALID_OPEN_BOOK_POLICIES = frozenset({"none", "medium_hard", "all"})
_EXTRA_ENV_SETTINGS = frozenset({"aws_access_key_id", "aws_secret_access_key"})
_EXTRA_SECRET_FIELDS = frozenset({"aws_secret_access_key"})
_ALL_SECRET_FIELDS = frozenset(SECRET_SETTING_FIELDS) | _EXTRA_SECRET_FIELDS
_WRITABLE_SETTINGS_ALLOWLIST: frozenset[str] = frozenset(
    {
        # Branding & access
        "admin_password",
        "app_title",
        "auto_seed_examples",
        "access_code",
        # Provider-agnostic LLM
        "llm_provider",
        "llm_model",
        "llm_api_key",
        "llm_base_url",
        "vertexai_project",
        "vertexai_location",
        "azure_api_version",
        "aws_region",
        # Storage sinks
        "storage_sinks",
        "local_reports_dir",
        "s3_bucket",
        "s3_prefix",
        "s3_region",
        "s3_endpoint_url",
        "aws_access_key_id",
        "aws_secret_access_key",
        "gcs_bucket",
        "gcs_prefix",
        "azure_storage_connection_string",
        "azure_storage_account_url",
        "azure_storage_container",
        "azure_storage_prefix",
        "storage_presigned_urls",
        "storage_presigned_ttl_seconds",
        # Notification sinks
        "notify_sinks",
        "smtp_host",
        "smtp_port",
        "smtp_user",
        "smtp_password",
        "smtp_from",
        "smtp_to",
        "smtp_use_tls",
        "slack_webhook_url",
        "slack_bot_token",
        "slack_channel_id",
        "teams_webhook_url",
        "webhook_url",
        "webhook_secret",
        "webhook_include_pdf_base64",
        # Notebook sandbox guardrails
        "sandbox_max_package_mb",
        "sandbox_max_disk_mb",
        "sandbox_cell_timeout_seconds",
        "sandbox_max_memory_mb",
        "sandbox_idle_timeout_minutes",
        "sandbox_banned_packages",
    }
)


# ---------------------------------------------------------------------------
# Auth & Mode Gating Dependencies
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_bearer_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization") or ""
    if auth_header.lower().startswith("bearer "):
        tok = auth_header[7:].strip()
        if tok:
            return tok
    cookie_tok = request.cookies.get("admin_token")
    return cookie_tok.strip() if cookie_tok else None


def require_admin_enabled(ctx: AppContext = Depends(get_ctx)) -> AppContext:
    """Return 404 for all /api/admin/* endpoints in candidate mode when ADMIN_PASSWORD is empty."""
    if ctx.settings.is_candidate_mode and not (ctx.settings.admin_password or "").strip():
        raise HTTPException(status_code=404, detail="Not found")
    return ctx


def require_admin_read(
    request: Request, ctx: AppContext = Depends(require_admin_enabled)
) -> AppContext:
    """Enforce admin authentication when ADMIN_PASSWORD is set."""
    if (ctx.settings.admin_password or "").strip():
        token = _extract_bearer_token(request)
        if not ctx.verify_admin_token(token):
            raise HTTPException(
                status_code=401,
                detail="Admin authentication required.",
                headers={"WWW-Authenticate": "Bearer"},
            )
    return ctx


def require_admin_write(ctx: AppContext = Depends(require_admin_read)) -> AppContext:
    """Enforce strictly read-only admin portal in candidate mode."""
    if ctx.settings.is_candidate_mode:
        raise HTTPException(
            status_code=403,
            detail="Admin portal is read-only in candidate mode.",
        )
    return ctx


# ---------------------------------------------------------------------------
# Request Schemas
# ---------------------------------------------------------------------------


class AdminLoginRequest(BaseModel):
    password: str = Field(..., min_length=1)


class QuestionPayload(BaseModel):
    external_key: str | None = None
    title: str | None = None
    prompt: str = Field(..., min_length=1)
    format: str = Field(default="text")
    difficulty: str = Field(default="medium")
    options: list[str] | None = None
    answer_indices: list[int] | None = None
    code_language: str | None = None
    starter_code: str | list[Any] | dict[str, Any] | None = None
    allow_execution: bool | None = None
    expected_answer: str = Field(default="")
    evaluation_rubric: str = Field(default="")
    default_points: int = Field(default=10, gt=0)
    active: bool = Field(default=True)
    tags: list[str] = Field(default_factory=list)


class QuestionUpdatePayload(BaseModel):
    external_key: str | None = None
    title: str | None = None
    prompt: str | None = None
    format: str | None = None
    difficulty: str | None = None
    options: list[str] | None = None
    answer_indices: list[int] | None = None
    code_language: str | None = None
    starter_code: str | list[Any] | dict[str, Any] | None = None
    allow_execution: bool | None = None
    expected_answer: str | None = None
    evaluation_rubric: str | None = None
    default_points: int | None = Field(default=None, gt=0)
    active: bool | None = None
    tags: list[str] | None = None


class TemplateQuestionItem(BaseModel):
    question_id: int
    position: int = 0
    points_override: int | None = Field(default=None, gt=0)
    expected_answer_override: str | None = None
    rubric_override: str | None = None


class TemplatePayload(BaseModel):
    slug: str = Field(..., min_length=1, max_length=120)
    name: str = Field(..., min_length=1, max_length=200)
    role_title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="")
    selection_mode: str = Field(default="curated")
    random_rules: dict[str, Any] | None = None
    timer_minutes: int = Field(default=45, gt=0)
    open_book_policy: str = Field(default="none")
    allow_code_execution: bool = Field(default=True)
    allow_package_install: bool = Field(default=False)
    access_code: str = Field(default="")
    summary_dimensions: list[str] = Field(default_factory=list)
    is_default: bool = Field(default=False)
    questions: list[TemplateQuestionItem] = Field(default_factory=list)


class TemplateUpdatePayload(BaseModel):
    slug: str | None = Field(default=None, min_length=1, max_length=120)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    role_title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    selection_mode: str | None = None
    random_rules: dict[str, Any] | None = None
    timer_minutes: int | None = Field(default=None, gt=0)
    open_book_policy: str | None = None
    allow_code_execution: bool | None = None
    allow_package_install: bool | None = None
    access_code: str | None = None
    summary_dimensions: list[str] | None = None
    is_default: bool | None = None
    questions: list[TemplateQuestionItem] | None = None


class TemplateClonePayload(BaseModel):
    slug: str | None = None
    name: str | None = None


class ManualGradePayload(BaseModel):
    question_id: int
    score: float
    feedback: str | None = None
    rubric_breakdown: list[str] | None = None


class TestSettingPayload(BaseModel):
    target: str = Field(..., min_length=1)


class DeployBundlePayload(BaseModel):
    template_slugs: list[str] | None = None
    output_path: str | None = None


# ---------------------------------------------------------------------------
# Validation Helpers
# ---------------------------------------------------------------------------


def _validate_question_fields(
    fmt: str,
    difficulty: str,
    options: list[str] | None,
    answer_indices: list[int] | None,
) -> None:
    if fmt not in VALID_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid format '{fmt}'. Must be one of: {', '.join(sorted(VALID_FORMATS))}.",
        )
    if difficulty not in VALID_DIFFICULTIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid difficulty '{difficulty}'. Must be one of: {', '.join(sorted(VALID_DIFFICULTIES))}.",
        )
    if fmt == "mcq":
        opts = options or []
        if len(opts) < 2:
            raise HTTPException(
                status_code=400, detail="MCQ questions require at least 2 options."
            )
        indices = answer_indices or []
        if not indices:
            raise HTTPException(
                status_code=400,
                detail="MCQ questions require at least one valid answer index.",
            )
        for idx in indices:
            if idx < 0 or idx >= len(opts):
                raise HTTPException(
                    status_code=400,
                    detail=f"MCQ answer index {idx} is out of bounds for {len(opts)} options.",
                )


def _validate_template_fields(
    selection_mode: str | None, open_book_policy: str | None
) -> None:
    if selection_mode is not None and selection_mode not in _VALID_SELECTION_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid selection_mode '{selection_mode}'. Must be 'curated' or 'random_pool'.",
        )
    if open_book_policy is not None and open_book_policy not in _VALID_OPEN_BOOK_POLICIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid open_book_policy '{open_book_policy}'. Must be 'none', 'medium_hard', or 'all'.",
        )


def _split_tags_query(tags_param: str | None) -> list[str] | None:
    if not tags_param:
        return None
    parsed = [t.strip() for t in tags_param.split(",") if t.strip()]
    return parsed or None


async def _extract_import_upload(
    request: Request,
) -> tuple[bytes, str, str, bool]:
    """Read raw import bytes, filename, duplicate_strategy, and skip_invalid from multipart or JSON."""
    content_type = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in content_type:
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(status_code=400, detail="Missing uploaded 'file' field.")
        raw_bytes = await upload.read()
        filename = getattr(upload, "filename", None) or "import.yaml"
        dup_strategy = str(form.get("duplicate_strategy") or "skip").strip().lower()
        raw_skip = str(form.get("skip_invalid") or "false").strip().lower()
        skip_invalid = raw_skip in {"1", "true", "yes"}
        return raw_bytes, filename, dup_strategy, skip_invalid

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Expected multipart file upload or JSON payload with 'content'.",
        ) from exc

    if not isinstance(body, dict) or "content" not in body:
        raise HTTPException(
            status_code=400, detail="JSON payload must include 'content'."
        )
    content = body["content"]
    raw_bytes = (
        content.encode("utf-8")
        if isinstance(content, str)
        else str(content).encode("utf-8")
    )
    filename = str(body.get("filename") or "import.yaml")
    dup_strategy = str(body.get("duplicate_strategy") or "skip").strip().lower()
    skip_invalid = bool(body.get("skip_invalid", False))
    return raw_bytes, filename, dup_strategy, skip_invalid


def _write_local_pdf(
    ctx: AppContext, sub: dict[str, Any], pdf_bytes: bytes
) -> str | None:
    """Persist regenerated PDF to existing local pdf_path or local_reports_dir."""
    existing_path = sub.get("pdf_path")
    if existing_path:
        target = Path(existing_path)
    elif "local" in ctx.settings.storage_sink_list or not ctx.settings.is_candidate_mode:
        reports_dir = Path(ctx.settings.local_reports_dir or "data/reports")
        stem = build_artifact_stem(sub.get("candidate_name") or "candidate")
        target = reports_dir / f"{stem}.pdf"
    else:
        return None

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(pdf_bytes)
    return target.resolve().as_posix()


# ---------------------------------------------------------------------------
# Status & Authentication
# ---------------------------------------------------------------------------


@router.get("/status")
async def admin_status(
    request: Request, ctx: AppContext = Depends(require_admin_enabled)
) -> dict[str, Any]:
    auth_required = bool((ctx.settings.admin_password or "").strip())
    if not auth_required:
        authenticated = True
    else:
        token = _extract_bearer_token(request)
        authenticated = ctx.verify_admin_token(token)

    return {
        "mode": "candidate" if ctx.settings.is_candidate_mode else "local",
        "read_only": ctx.settings.is_candidate_mode,
        "auth_required": auth_required,
        "authenticated": authenticated,
        "app_title": ctx.settings.app_title,
    }


@router.post("/auth/login")
async def admin_login(
    payload: AdminLoginRequest, ctx: AppContext = Depends(require_admin_enabled)
) -> dict[str, Any]:
    configured_pw = (ctx.settings.admin_password or "").strip()
    if not configured_pw:
        return {
            "token": "",
            "authenticated": True,
            "mode": "candidate" if ctx.settings.is_candidate_mode else "local",
            "read_only": ctx.settings.is_candidate_mode,
        }

    if not hmac.compare_digest(payload.password, configured_pw):
        raise HTTPException(status_code=401, detail="Invalid admin password.")

    token = ctx.issue_admin_token()
    return {
        "token": token,
        "authenticated": True,
        "mode": "candidate" if ctx.settings.is_candidate_mode else "local",
        "read_only": ctx.settings.is_candidate_mode,
    }


# ---------------------------------------------------------------------------
# Bulk Import / Export & Sample Download (registered before /questions/{id})
# ---------------------------------------------------------------------------


@router.post("/questions/import/preview")
async def admin_import_preview(
    request: Request, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    raw_bytes, filename, _, _ = await _extract_import_upload(request)
    try:
        return preview_import(ctx.repo, raw_bytes, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/questions/import/commit")
async def admin_import_commit(
    request: Request, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    raw_bytes, filename, dup_strategy, skip_invalid = await _extract_import_upload(request)
    try:
        return commit_import(
            ctx.repo,
            raw_bytes,
            filename,
            duplicate_strategy=dup_strategy,
            skip_invalid=skip_invalid,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/questions/export")
async def admin_export_questions(
    format: str = Query(default="yaml"),
    tags: str | None = Query(default=None),
    template_id: int | None = Query(default=None),
    ctx: AppContext = Depends(require_admin_read),
) -> Response:
    try:
        content, media_type = export_questions(
            ctx.repo,
            fmt=format,
            tags=_split_tags_query(tags),
            template_id=template_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    ext = "json" if format.strip().lower() == "json" else "yaml"
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="questions_export.{ext}"'
        },
    )


@router.get("/questions/sample")
async def admin_sample_questions(
    format: str = Query(default="yaml"),
    ctx: AppContext = Depends(require_admin_read),
) -> Response:
    try:
        content, media_type = get_sample_import_template(fmt=format)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    ext = "json" if format.strip().lower() == "json" else "yaml"
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="sample_questions.{ext}"'
        },
    )


# ---------------------------------------------------------------------------
# Questions & Tags CRUD
# ---------------------------------------------------------------------------


@router.get("/questions")
async def list_questions(
    search: str | None = Query(default=None),
    tags: str | None = Query(default=None),
    tag_match: str = Query(default="any"),
    format: str | None = Query(default=None),
    difficulty: str | None = Query(default=None),
    active_only: bool = Query(default=False),
    ctx: AppContext = Depends(require_admin_read),
) -> list[dict[str, Any]]:
    return ctx.repo.list_questions(
        search=search,
        tags=_split_tags_query(tags),
        tag_match=tag_match,
        fmt=format,
        difficulty=difficulty,
        active_only=active_only,
    )


@router.get("/questions/{question_id}")
async def get_question(
    question_id: int, ctx: AppContext = Depends(require_admin_read)
) -> dict[str, Any]:
    q = ctx.repo.get_question(question_id)
    if q is None:
        raise HTTPException(status_code=404, detail="Question not found.")
    return q


@router.post("/questions")
async def create_question(
    payload: QuestionPayload, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    fmt = payload.format.strip().lower()
    diff = payload.difficulty.strip().lower()
    _validate_question_fields(fmt, diff, payload.options, payload.answer_indices)
    data = payload.model_dump()
    data["format"] = fmt
    data["difficulty"] = diff
    try:
        return ctx.repo.create_question(data)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.put("/questions/{question_id}")
async def update_question(
    question_id: int,
    payload: QuestionUpdatePayload,
    ctx: AppContext = Depends(require_admin_write),
) -> dict[str, Any]:
    existing = ctx.repo.get_question(question_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Question not found.")

    update_data = payload.model_dump(exclude_unset=True)
    fmt = (update_data.get("format") or existing["format"]).strip().lower()
    diff = (update_data.get("difficulty") or existing["difficulty"]).strip().lower()
    opts = update_data.get("options") if "options" in update_data else existing["options"]
    ans_idx = (
        update_data.get("answer_indices")
        if "answer_indices" in update_data
        else existing["answer_indices"]
    )
    _validate_question_fields(fmt, diff, opts, ans_idx)

    if "format" in update_data:
        update_data["format"] = fmt
    if "difficulty" in update_data:
        update_data["difficulty"] = diff

    try:
        updated = ctx.repo.update_question(question_id, update_data)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if updated is None:
        raise HTTPException(status_code=404, detail="Question not found.")
    return updated


@router.delete("/questions/{question_id}")
async def delete_question(
    question_id: int, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    deleted = ctx.repo.delete_question(question_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Question not found.")
    return {"deleted": True, "id": question_id}


@router.get("/tags")
async def list_tags(ctx: AppContext = Depends(require_admin_read)) -> list[dict[str, Any]]:
    return ctx.repo.list_tags()


# ---------------------------------------------------------------------------
# Templates CRUD, Clone & Preview
# ---------------------------------------------------------------------------


@router.get("/templates")
async def list_templates(
    ctx: AppContext = Depends(require_admin_read),
) -> list[dict[str, Any]]:
    return ctx.repo.list_templates()


@router.get("/templates/{template_id}")
async def get_template(
    template_id: int, ctx: AppContext = Depends(require_admin_read)
) -> dict[str, Any]:
    tpl = ctx.repo.get_template(template_id)
    if tpl is None:
        raise HTTPException(status_code=404, detail="Template not found.")
    return tpl


@router.post("/templates")
async def create_template(
    payload: TemplatePayload, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    sel_mode = payload.selection_mode.strip().lower()
    ob_policy = payload.open_book_policy.strip().lower()
    _validate_template_fields(sel_mode, ob_policy)

    data = payload.model_dump()
    data["selection_mode"] = sel_mode
    data["open_book_policy"] = ob_policy
    try:
        return ctx.repo.create_template(data)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.put("/templates/{template_id}")
async def update_template(
    template_id: int,
    payload: TemplateUpdatePayload,
    ctx: AppContext = Depends(require_admin_write),
) -> dict[str, Any]:
    update_data = payload.model_dump(exclude_unset=True)
    sel_mode = (
        update_data["selection_mode"].strip().lower()
        if update_data.get("selection_mode") is not None
        else None
    )
    ob_policy = (
        update_data["open_book_policy"].strip().lower()
        if update_data.get("open_book_policy") is not None
        else None
    )
    _validate_template_fields(sel_mode, ob_policy)
    if sel_mode is not None:
        update_data["selection_mode"] = sel_mode
    if ob_policy is not None:
        update_data["open_book_policy"] = ob_policy

    try:
        updated = ctx.repo.update_template(template_id, update_data)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if updated is None:
        raise HTTPException(status_code=404, detail="Template not found.")
    return updated


@router.delete("/templates/{template_id}")
async def delete_template(
    template_id: int, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    deleted = ctx.repo.delete_template(template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Template not found.")
    return {"deleted": True, "id": template_id}


@router.post("/templates/{template_id}/clone")
async def clone_template(
    template_id: int,
    payload: TemplateClonePayload | None = None,
    ctx: AppContext = Depends(require_admin_write),
) -> dict[str, Any]:
    src = ctx.repo.get_template(template_id)
    if src is None:
        raise HTTPException(status_code=404, detail="Template not found.")

    body = payload or TemplateClonePayload()
    new_slug = (body.slug or "").strip()
    if not new_slug:
        base_slug = f"{src['slug']}-copy"
        candidate_slug = base_slug
        suffix = 2
        while ctx.repo.get_template_by_slug(candidate_slug) is not None:
            candidate_slug = f"{base_slug}-{suffix}"
            suffix += 1
        new_slug = candidate_slug
    new_name = (body.name or "").strip() or f"{src['name']} (Copy)"

    try:
        return ctx.repo.clone_template(template_id, new_slug=new_slug, new_name=new_name)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.api_route("/templates/{template_id}/preview", methods=["GET", "POST"])
async def preview_template(
    template_id: int, ctx: AppContext = Depends(require_admin_read)
) -> dict[str, Any]:
    tpl = ctx.repo.get_template(template_id)
    if tpl is None:
        raise HTTPException(status_code=404, detail="Template not found.")
    resolved = ctx.repo.resolve_template_questions(template_id)
    total_points = sum(int(q.get("effective_points", q.get("default_points", 0))) for q in resolved)
    return {
        "template": tpl,
        "questions": resolved,
        "question_count": len(resolved),
        "total_points": total_points,
    }


# ---------------------------------------------------------------------------
# Results, Manual Grading, PDF Regeneration & Redelivery
# ---------------------------------------------------------------------------


@router.get("/results")
async def list_results(
    ctx: AppContext = Depends(require_admin_read),
) -> list[dict[str, Any]]:
    return ctx.repo.list_submissions()


@router.get("/results/{submission_id}")
async def get_result(
    submission_id: str, ctx: AppContext = Depends(require_admin_read)
) -> dict[str, Any]:
    sub = ctx.repo.get_submission(submission_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="Submission not found.")
    return sub


@router.patch("/results/{submission_id}/grade")
async def override_question_grade(
    submission_id: str,
    payload: ManualGradePayload,
    ctx: AppContext = Depends(require_admin_write),
) -> dict[str, Any]:
    sub = ctx.repo.get_submission(submission_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="Submission not found.")

    answers: list[dict[str, Any]] = list(sub.get("answers") or [])
    target_ans: dict[str, Any] | None = None
    for ans in answers:
        if isinstance(ans, dict) and int(ans.get("question_id", -1)) == payload.question_id:
            target_ans = ans
            break

    if target_ans is None:
        raise HTTPException(
            status_code=404,
            detail=f"Question {payload.question_id} not found in submission.",
        )

    evaluation = dict(target_ans.get("evaluation") or {})
    max_points = float(evaluation.get("max_points") or 0.0)
    if payload.score < 0 or payload.score > max_points:
        raise HTTPException(
            status_code=400,
            detail=f"Score must be between 0 and {max_points:g}.",
        )

    new_score = round(float(payload.score), 2)
    evaluation["score"] = new_score
    evaluation["max_points"] = max_points
    evaluation["correctness_pct"] = (
        round((new_score / max_points) * 100.0, 1) if max_points > 0 else 0.0
    )
    if payload.feedback is not None:
        evaluation["feedback"] = payload.feedback
    if payload.rubric_breakdown is not None:
        evaluation["rubric_breakdown"] = payload.rubric_breakdown
    evaluation["manually_overridden"] = True
    evaluation["needs_manual_review"] = False
    target_ans["evaluation"] = evaluation

    final_score = round(
        sum(float((a.get("evaluation") or {}).get("score") or 0.0) for a in answers if isinstance(a, dict)),
        2,
    )
    max_score = round(
        sum(float((a.get("evaluation") or {}).get("max_points") or 0.0) for a in answers if isinstance(a, dict)),
        2,
    )
    score_percentage = (
        round((final_score / max_score) * 100.0, 1) if max_score > 0 else 0.0
    )
    any_pending = any(
        bool((a.get("evaluation") or {}).get("needs_manual_review"))
        for a in answers
        if isinstance(a, dict)
    )
    new_status = "needs_review" if any_pending else "completed"

    updated_sub = ctx.repo.update_submission(
        submission_id,
        {
            "status": new_status,
            "final_score": final_score,
            "max_score": max_score,
            "score_percentage": score_percentage,
            "answers": answers,
        },
    )
    assert updated_sub is not None

    # Regenerate local PDF so subsequent downloads reflect the manual override immediately
    pdf_bytes = await asyncio.to_thread(generate_interview_pdf, updated_sub)
    pdf_path = _write_local_pdf(ctx, updated_sub, pdf_bytes)
    if pdf_path and pdf_path != updated_sub.get("pdf_path"):
        updated_sub = ctx.repo.update_submission(submission_id, {"pdf_path": pdf_path}) or updated_sub

    return updated_sub


@router.post("/results/{submission_id}/regenerate-pdf")
async def regenerate_result_pdf(
    submission_id: str, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    sub = ctx.repo.get_submission(submission_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="Submission not found.")

    pdf_bytes = await asyncio.to_thread(generate_interview_pdf, sub)
    pdf_path = _write_local_pdf(ctx, sub, pdf_bytes)
    if pdf_path:
        ctx.repo.update_submission(submission_id, {"pdf_path": pdf_path})

    return {
        "ok": True,
        "submission_id": submission_id,
        "pdf_path": pdf_path,
        "size_bytes": len(pdf_bytes),
    }


@router.post("/results/{submission_id}/redeliver")
async def redeliver_result(
    submission_id: str, ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    sub = ctx.repo.get_submission(submission_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="Submission not found.")

    pdf_bytes = await asyncio.to_thread(generate_interview_pdf, sub)
    orchestrator = DeliveryOrchestrator(ctx.settings)
    outcome = await orchestrator.deliver_report(sub["candidate_name"], sub, pdf_bytes)

    ts = _utc_now()
    existing_log = list(sub.get("delivery_log") or [])
    for entry in outcome.get("storage") or []:
        existing_log.append({**entry, "phase": "storage", "redeliver": True, "timestamp": ts})
    for entry in outcome.get("notifications") or []:
        existing_log.append({**entry, "phase": "notify", "redeliver": True, "timestamp": ts})

    update_fields: dict[str, Any] = {"delivery_log": existing_log}
    if outcome.get("local_pdf_path"):
        update_fields["pdf_path"] = outcome["local_pdf_path"]
    ctx.repo.update_submission(submission_id, update_fields)

    return {
        "ok": True,
        "delivery": outcome,
        "delivery_log": existing_log,
    }


@router.get("/results/{submission_id}/pdf")
async def download_result_pdf(
    submission_id: str, ctx: AppContext = Depends(require_admin_read)
) -> Response:
    sub = ctx.repo.get_submission(submission_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="Submission not found.")

    pdf_bytes: bytes | None = None
    pdf_path = sub.get("pdf_path")
    if pdf_path:
        try:
            reports_root = Path(ctx.settings.local_reports_dir or "data/reports").resolve()
            resolved_pdf = Path(pdf_path).resolve()
            if resolved_pdf.is_relative_to(reports_root) and resolved_pdf.is_file():
                pdf_bytes = resolved_pdf.read_bytes()
        except (OSError, ValueError):
            pdf_bytes = None
    if pdf_bytes is None:
        pdf_bytes = await asyncio.to_thread(generate_interview_pdf, sub)

    safe_name = sanitize_candidate_slug(sub.get("candidate_name") or "candidate")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}_report.pdf"'
        },
    )


# ---------------------------------------------------------------------------
# Settings (Masked Read, Local-Only Persistence, Live Test)
# ---------------------------------------------------------------------------


@router.get("/settings")
async def get_admin_settings(
    ctx: AppContext = Depends(require_admin_read),
) -> dict[str, Any]:
    return get_masked_settings(ctx.settings)


@router.put("/settings")
async def update_admin_settings(
    payload: dict[str, Any], ctx: AppContext = Depends(require_admin_write)
) -> dict[str, Any]:
    disallowed_keys = sorted(
        {
            str(key)
            for key in payload.keys()
            if str(key).strip().lower() not in _WRITABLE_SETTINGS_ALLOWLIST
            and str(key).strip().lower() != "clear_secrets"
        }
    )
    if disallowed_keys:
        raise HTTPException(
            status_code=400,
            detail=f"Disallowed or unknown setting key(s): {', '.join(disallowed_keys)}",
        )

    raw_clear = None
    for k, v in payload.items():
        if str(k).strip().lower() == "clear_secrets":
            raw_clear = v
            break
    if raw_clear is not None and not isinstance(raw_clear, list):
        raise HTTPException(
            status_code=400, detail="'clear_secrets' must be a list of secret field names."
        )
    clear_secrets = (
        {str(f).strip().lower() for f in raw_clear}
        if isinstance(raw_clear, list)
        else set()
    )
    invalid_clears = sorted(clear_secrets - _ALL_SECRET_FIELDS)
    if invalid_clears:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid field(s) in clear_secrets: {', '.join(invalid_clears)}",
        )

    merged = ctx.settings.model_dump()
    env_updates: dict[str, str] = {}

    for key, val in payload.items():
        field = str(key).strip().lower()
        if field == "clear_secrets":
            continue

        # Secret fields: blank input preserves existing secret unless explicitly cleared
        if field in _ALL_SECRET_FIELDS:
            if field in clear_secrets:
                cleaned_secret = ""
            elif val is None or (isinstance(val, str) and not val.strip()):
                continue
            else:
                cleaned_secret = str(val)

            env_updates[field.upper()] = cleaned_secret
            if field in Settings.model_fields:
                merged[field] = cleaned_secret
            continue

        if field in _EXTRA_ENV_SETTINGS:
            env_updates[field.upper()] = "" if val is None else str(val)
            continue

        if val is None:
            continue
        merged[field] = val
        if isinstance(val, bool):
            env_updates[field.upper()] = "true" if val else "false"
        else:
            env_updates[field.upper()] = str(val)

    try:
        new_settings = Settings(**merged)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid settings: {exc}") from exc

    if env_updates:
        save_local_env(env_updates, env_path=ctx.env_path)

    ctx.settings = new_settings
    ctx.kernel_manager.settings = new_settings
    ctx.kernel_manager.package_guard.settings = new_settings
    return get_masked_settings(ctx.settings)


@router.post("/settings/test")
async def test_admin_setting(
    payload: TestSettingPayload, ctx: AppContext = Depends(require_admin_read)
) -> dict[str, Any]:
    target = payload.target.strip().lower()
    if target == "llm":
        return await LLMService(ctx.settings).test_connection()
    return await DeliveryOrchestrator(ctx.settings).test_sink(target)


# ---------------------------------------------------------------------------
# Deployment Readiness & Bundle Packager
# ---------------------------------------------------------------------------


@router.get("/deploy/status")
async def deploy_status(
    ctx: AppContext = Depends(require_admin_read),
) -> dict[str, Any]:
    return get_deploy_readiness(ctx.settings, Path(ctx.settings.bundle_path))


@router.post("/deploy/bundle")
async def deploy_bundle(
    payload: DeployBundlePayload | None = None,
    ctx: AppContext = Depends(require_admin_write),
) -> dict[str, Any]:
    body = payload or DeployBundlePayload()
    out_path = Path(body.output_path or ctx.settings.bundle_path)
    try:
        summary = build_deployment_bundle(
            ctx.repo, out_path, template_slugs=body.template_slugs
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    readiness = get_deploy_readiness(ctx.settings, out_path)
    return {**summary, "readiness": readiness}
