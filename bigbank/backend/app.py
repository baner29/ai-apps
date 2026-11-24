"""FastAPI application factory, router wiring, auto-seeding, and SPA static serving."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from backend.cli import seed_starter_data
from backend.config import Settings, get_settings
from backend.db.database import DatabaseManager
from backend.db.repository import InterviewRepository
from backend.routers import AppContext
from backend.routers.admin import router as admin_router
from backend.routers.public import router as public_router
from backend.services.delivery.orchestrator import DeliveryOrchestrator
from backend.services.notebook_kernel import NotebookKernelManager

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BACKEND_DIR.parent
_SPA_CANDIDATE_DIRS: tuple[Path, ...] = (
    _BACKEND_DIR / "static_spa",
    _REPO_ROOT / "frontend" / "dist",
)
_REAPER_INTERVAL_SECONDS = 60


def _resolve_spa_dir() -> Path | None:
    """Return the first compiled SPA directory containing index.html, if present."""
    for candidate in _SPA_CANDIDATE_DIRS:
        if (candidate / "index.html").is_file():
            return candidate.resolve()
    return None


def _is_admin_spa_path(full_path: str) -> bool:
    cleaned = (full_path or "").strip("/").lower()
    return cleaned == "admin" or cleaned.startswith("admin/")


def _bootstrap_database(settings: Settings) -> tuple[DatabaseManager, InterviewRepository]:
    """Initialize split-DB SQLite manager and optionally seed starter examples in local mode."""
    catalog_path = settings.effective_catalog_path
    runtime_path = settings.effective_runtime_path
    catalog_read_only = settings.is_candidate_mode

    if catalog_read_only and not catalog_path.exists():
        # Ensure candidate-mode boots cleanly even if no bundle file was pre-created yet.
        try:
            DatabaseManager(catalog_path, runtime_path, catalog_read_only=False).init_schemas()
        except Exception as exc:
            logger.warning(
                "Candidate catalog bundle '%s' does not exist and could not be initialized: %s",
                catalog_path,
                exc,
            )

    db = DatabaseManager(
        catalog_path=catalog_path,
        runtime_path=runtime_path,
        catalog_read_only=catalog_read_only,
    )
    db.init_schemas()
    repo = InterviewRepository(db)

    if not catalog_read_only and settings.auto_seed_examples:
        try:
            if not repo.list_questions() and not repo.list_templates():
                seed_result = seed_starter_data(repo)
                logger.info(
                    "Auto-seeded %d starter question(s) and %d template(s).",
                    seed_result.get("created", 0),
                    seed_result.get("templates_created", 0),
                )
        except Exception as exc:
            logger.warning("Auto-seeding starter examples skipped: %s", exc)

    return db, repo


def create_app(
    settings: Settings | None = None,
    *,
    env_path: Path | None = None,
) -> FastAPI:
    """Create and configure the BigBank - An open source interview taking platform FastAPI application."""
    effective_settings = settings if settings is not None else get_settings()
    db, repo = _bootstrap_database(effective_settings)
    kernel_manager = NotebookKernelManager(effective_settings)
    ctx = AppContext(
        settings=effective_settings,
        db=db,
        repo=repo,
        kernel_manager=kernel_manager,
        env_path=env_path,
    )

    if (
        effective_settings.is_candidate_mode
        and not DeliveryOrchestrator(effective_settings).has_external_sinks()
    ):
        logger.warning(
            "APP_MODE=candidate started without any external storage or notification sinks "
            "(STORAGE_SINKS='%s', NOTIFY_SINKS='%s'). Local disk writes are ephemeral in "
            "serverless containers — configure an external sink (s3, gcs, azure_blob, smtp, "
            "slack, teams, or webhook) to prevent losing candidate reports.",
            effective_settings.storage_sinks,
            effective_settings.notify_sinks,
        )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        stop_event = asyncio.Event()

        async def _reaper_loop() -> None:
            while not stop_event.is_set():
                try:
                    await asyncio.wait_for(
                        stop_event.wait(), timeout=_REAPER_INTERVAL_SECONDS
                    )
                except asyncio.TimeoutError:
                    try:
                        ctx.kernel_manager.reap_idle_kernels()
                    except Exception:
                        logger.exception("Idle kernel reaper iteration failed")

        reaper_task = asyncio.create_task(_reaper_loop())
        try:
            yield
        finally:
            stop_event.set()
            reaper_task.cancel()
            try:
                await reaper_task
            except asyncio.CancelledError:
                pass
            ctx.kernel_manager.shutdown_all()

    app = FastAPI(
        title=effective_settings.app_title or "BigBank",
        description="BigBank - An open source interview taking platform",
        lifespan=lifespan,
    )
    app.state.ctx = ctx

    @app.get("/health", tags=["system"])
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "mode": "candidate" if ctx.settings.is_candidate_mode else "local",
            "app_title": ctx.settings.app_title,
        }

    app.include_router(public_router)
    app.include_router(admin_router)

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def api_not_found(path: str) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": f"API endpoint '/api/{path}' not found."})

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if (
            _is_admin_spa_path(full_path)
            and ctx.settings.is_candidate_mode
            and not (ctx.settings.admin_password or "").strip()
        ):
            raise HTTPException(status_code=404, detail="Not found")

        spa_dir = _resolve_spa_dir()
        if spa_dir is None:
            if _is_admin_spa_path(full_path):
                return JSONResponse(
                    status_code=200,
                    content={
                        "message": "Frontend SPA not built yet. Run `npm run build` in frontend/.",
                        "path": f"/{full_path}",
                    },
                )
            return JSONResponse(
                status_code=200,
                content={
                    "app_title": ctx.settings.app_title,
                    "mode": "candidate" if ctx.settings.is_candidate_mode else "local",
                    "message": "Backend API is running. Build frontend SPA to serve UI.",
                },
            )

        cleaned = full_path.lstrip("/")
        if cleaned:
            candidate_file = (spa_dir / cleaned).resolve()
            if (
                candidate_file.is_relative_to(spa_dir)
                and candidate_file.is_file()
            ):
                return FileResponse(candidate_file)

        return FileResponse(spa_dir / "index.html")

    return app


app = create_app()
