"""SQLite candidate deployment bundle packager and cloud deployment readiness helpers."""

from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from backend.config import Settings
from backend.db.repository import InterviewRepository
from backend.db.schema import CATALOG_SCHEMA_SQL, RUNTIME_SCHEMA_SQL
from backend.services.delivery.orchestrator import DeliveryOrchestrator
from backend.services.llm import LLMService

_QUESTION_COLS: tuple[str, ...] = (
    "id",
    "external_key",
    "title",
    "prompt",
    "format",
    "difficulty",
    "options_json",
    "answer_indices_json",
    "code_language",
    "starter_code",
    "allow_execution",
    "expected_answer",
    "evaluation_rubric",
    "default_points",
    "active",
    "created_at",
    "updated_at",
)

_TAG_COLS: tuple[str, ...] = ("id", "name")

_QUESTION_TAG_COLS: tuple[str, ...] = ("question_id", "tag_id")

_TEMPLATE_COLS: tuple[str, ...] = (
    "id",
    "slug",
    "name",
    "role_title",
    "description",
    "selection_mode",
    "random_rules_json",
    "timer_minutes",
    "open_book_policy",
    "allow_code_execution",
    "allow_package_install",
    "access_code",
    "summary_dimensions_json",
    "is_default",
    "created_at",
    "updated_at",
)

_TEMPLATE_QUESTION_COLS: tuple[str, ...] = (
    "id",
    "template_id",
    "question_id",
    "position",
    "points_override",
    "expected_answer_override",
    "rubric_override",
)


def _insert_rows(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
    rows: list[sqlite3.Row],
) -> None:
    if not rows:
        return
    cols_sql = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO {table} ({cols_sql}) VALUES ({placeholders})"
    values = [tuple(row[col] for col in columns) for row in rows]
    conn.executemany(sql, values)


def build_deployment_bundle(
    source_repo: InterviewRepository,
    output_path: Path,
    template_slugs: list[str] | None = None,
) -> dict[str, Any]:
    """Build a stripped, PII-free SQLite bundle containing only selected templates & questions."""
    selected_templates: list[dict[str, Any]] = []
    if template_slugs is not None:
        cleaned_slugs: list[str] = []
        seen_slugs: set[str] = set()
        for raw in template_slugs:
            slug = (raw or "").strip()
            if slug and slug not in seen_slugs:
                seen_slugs.add(slug)
                cleaned_slugs.append(slug)
        if not cleaned_slugs:
            raise ValueError("At least one template slug must be provided")

        for slug in cleaned_slugs:
            tpl = source_repo.get_template_by_slug(slug)
            if tpl is None:
                raise ValueError(f"Template slug not found: '{slug}'")
            selected_templates.append(tpl)
    else:
        selected_templates = source_repo.list_templates()
        if not selected_templates:
            raise ValueError("No templates found in source database to bundle")

    needed_question_ids: set[int] = set()
    for tpl in selected_templates:
        if tpl["selection_mode"] == "curated":
            for item in tpl.get("questions") or []:
                needed_question_ids.add(int(item["question_id"]))
        else:
            rules = tpl.get("random_rules") or {}
            tags = rules.get("tags") or None
            match = rules.get("match", "any")
            pool = source_repo.list_questions(
                tags=tags, tag_match=match, active_only=True
            )
            for q in pool:
                needed_question_ids.add(int(q["id"]))

    template_ids = [int(t["id"]) for t in selected_templates]
    question_ids = sorted(needed_question_ids)

    with source_repo.db.catalog_conn() as src_conn:
        if question_ids:
            q_placeholders = ",".join("?" for _ in question_ids)
            question_rows = src_conn.execute(
                f"SELECT {', '.join(_QUESTION_COLS)} FROM questions "
                f"WHERE id IN ({q_placeholders}) ORDER BY id ASC",
                question_ids,
            ).fetchall()
            qt_rows = src_conn.execute(
                f"SELECT {', '.join(_QUESTION_TAG_COLS)} FROM question_tags "
                f"WHERE question_id IN ({q_placeholders}) "
                f"ORDER BY question_id ASC, tag_id ASC",
                question_ids,
            ).fetchall()
        else:
            question_rows = []
            qt_rows = []

        valid_question_ids = sorted({int(r["id"]) for r in question_rows})
        tag_ids = sorted({int(r["tag_id"]) for r in qt_rows})
        if tag_ids:
            t_placeholders = ",".join("?" for _ in tag_ids)
            tag_rows = src_conn.execute(
                f"SELECT {', '.join(_TAG_COLS)} FROM tags "
                f"WHERE id IN ({t_placeholders}) ORDER BY id ASC",
                tag_ids,
            ).fetchall()
        else:
            tag_rows = []

        tpl_placeholders = ",".join("?" for _ in template_ids)
        template_rows = src_conn.execute(
            f"SELECT {', '.join(_TEMPLATE_COLS)} FROM templates "
            f"WHERE id IN ({tpl_placeholders}) ORDER BY is_default DESC, id ASC",
            template_ids,
        ).fetchall()

        if valid_question_ids:
            vq_placeholders = ",".join("?" for _ in valid_question_ids)
            tq_rows = src_conn.execute(
                f"SELECT {', '.join(_TEMPLATE_QUESTION_COLS)} FROM template_questions "
                f"WHERE template_id IN ({tpl_placeholders}) "
                f"AND question_id IN ({vq_placeholders}) "
                f"ORDER BY template_id ASC, position ASC, id ASC",
                [*template_ids, *valid_question_ids],
            ).fetchall()
        else:
            tq_rows = []

    target_path = Path(output_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        prefix=".bundle_", suffix=".db.tmp", dir=str(target_path.parent)
    )
    os.close(fd)
    tmp_path = Path(tmp_name)

    try:
        dest_conn = sqlite3.connect(str(tmp_path))
        try:
            dest_conn.execute("PRAGMA foreign_keys = ON;")
            dest_conn.executescript(CATALOG_SCHEMA_SQL)
            dest_conn.executescript(RUNTIME_SCHEMA_SQL)

            _insert_rows(dest_conn, "questions", _QUESTION_COLS, question_rows)
            _insert_rows(dest_conn, "tags", _TAG_COLS, tag_rows)
            _insert_rows(dest_conn, "question_tags", _QUESTION_TAG_COLS, qt_rows)
            _insert_rows(dest_conn, "templates", _TEMPLATE_COLS, template_rows)
            _insert_rows(
                dest_conn, "template_questions", _TEMPLATE_QUESTION_COLS, tq_rows
            )
            dest_conn.commit()
            dest_conn.execute("VACUUM;")
        finally:
            dest_conn.close()

        os.replace(tmp_path, target_path)
    except Exception:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise

    return {
        "output_path": str(target_path),
        "templates_count": len(template_rows),
        "questions_count": len(question_rows),
        "tags_count": len(tag_rows),
        "size_bytes": target_path.stat().st_size,
        "template_slugs": [str(r["slug"]) for r in template_rows],
    }


def _build_deploy_snippets(settings: Settings, bundle_path: Path) -> dict[str, str]:
    """Generate copyable, secret-free cloud & container deployment snippets."""
    bundle_posix = bundle_path.as_posix()
    llm_provider = (settings.llm_provider or "openai").strip() or "openai"
    if llm_provider == "none":
        llm_provider = "openai"
    llm_model = (settings.llm_model or "gpt-4o-mini").strip() or "gpt-4o-mini"

    storage_sinks = (
        settings.storage_sinks.strip()
        if settings.storage_sinks.strip() and settings.storage_sinks.strip().lower() != "local"
        else "s3"
    )
    notify_sinks = settings.notify_sinks.strip() or "slack"

    # Provider- and storage-specific settings must travel with the deployment.
    # Without them the deployed app silently falls back to built-in defaults
    # (for example Vertex AI location "us-central1", or an empty GCS bucket),
    # even though they were configured in Admin Studio Settings.
    sink_set = {
        s.strip().lower() for s in storage_sinks.split(",") if s.strip()
    }
    extra_env: list[tuple[str, str]] = []
    if llm_provider == "vertex_ai":
        extra_env.append(
            (
                "VERTEXAI_PROJECT",
                settings.vertexai_project.strip() or "<YOUR_GCP_PROJECT_ID>",
            )
        )
        extra_env.append(
            (
                "VERTEXAI_LOCATION",
                settings.vertexai_location.strip() or "<YOUR_VERTEX_LOCATION>",
            )
        )
    if "gcs" in sink_set:
        extra_env.append(
            ("GCS_BUCKET", settings.gcs_bucket.strip() or "<YOUR_GCS_BUCKET>")
        )
        extra_env.append(("GCS_PREFIX", settings.gcs_prefix.strip() or "interviews"))
    if "s3" in sink_set:
        extra_env.append(
            ("S3_BUCKET", settings.s3_bucket.strip() or "<YOUR_S3_BUCKET>")
        )
        extra_env.append(("S3_PREFIX", settings.s3_prefix.strip() or "interviews"))
        extra_env.append(("S3_REGION", settings.s3_region.strip() or "us-east-1"))
        if settings.s3_endpoint_url.strip():
            extra_env.append(("S3_ENDPOINT_URL", settings.s3_endpoint_url.strip()))
    if sink_set & {"azure", "azure_blob", "azureblob"}:
        extra_env.append(
            (
                "AZURE_STORAGE_CONTAINER",
                settings.azure_storage_container.strip() or "<YOUR_AZURE_CONTAINER>",
            )
        )
        extra_env.append(
            (
                "AZURE_STORAGE_PREFIX",
                settings.azure_storage_prefix.strip() or "interviews",
            )
        )
        if settings.azure_storage_account_url.strip():
            extra_env.append(
                ("AZURE_STORAGE_ACCOUNT_URL", settings.azure_storage_account_url.strip())
            )

    # Vertex AI authenticates with the runtime identity (ADC / Workload
    # Identity), so no LLM_API_KEY secret is needed for it.
    needs_api_key = llm_provider != "vertex_ai"

    docker_lines = [
        "docker build -t bigbank:latest .",
        "docker run --rm -p 8080:8080 \\",
        "  -e APP_MODE=candidate \\",
        f"  -e BUNDLE_PATH={bundle_posix} \\",
        f"  -e LLM_PROVIDER={llm_provider} \\",
        f"  -e LLM_MODEL={llm_model} \\",
    ]
    if needs_api_key:
        docker_lines.append('  -e LLM_API_KEY="<YOUR_LLM_API_KEY>" \\')
    docker_lines += [f"  -e {key}={value} \\" for key, value in extra_env]
    docker_lines += [
        f"  -e STORAGE_SINKS={storage_sinks} \\",
        f"  -e NOTIFY_SINKS={notify_sinks} \\",
        "  bigbank:latest",
    ]
    docker_snippet = "\n".join(docker_lines)

    # IAM grants the runtime identity needs, printed ahead of the deploy
    # command so a missing permission is fixed before the first submission
    # rather than discovered from a silently empty bucket afterwards.
    iam_lines: list[str] = []
    if "gcs" in sink_set:
        bucket_name = settings.gcs_bucket.strip() or "<YOUR_GCS_BUCKET>"
        iam_lines += [
            "# 1. Grant the Cloud Run runtime service account write access to the bucket:",
            f"gcloud storage buckets add-iam-policy-binding gs://{bucket_name} \\",
            '  --member="serviceAccount:<YOUR_RUNTIME_SERVICE_ACCOUNT>" \\',
            '  --role="roles/storage.objectAdmin"',
            "",
        ]
    if llm_provider == "vertex_ai":
        project_id = settings.vertexai_project.strip() or "<YOUR_GCP_PROJECT_ID>"
        iam_lines += [
            "# Grant the Cloud Run runtime service account Vertex AI access:",
            f"gcloud projects add-iam-policy-binding {project_id} \\",
            '  --member="serviceAccount:<YOUR_RUNTIME_SERVICE_ACCOUNT>" \\',
            '  --role="roles/aiplatform.user"',
            "",
        ]
    deploy_step = "2" if "gcs" in sink_set else "1"

    extra_chain = "".join(f"{key}={value}|" for key, value in extra_env)
    cloud_run_lines = iam_lines + [
        f"# {deploy_step}. Deploy:",
        "gcloud run deploy bigbank \\",
        "  --source . \\",
        "  --region <YOUR_REGION> \\",
        "  --allow-unauthenticated \\",
        "  --port 8080 \\",
        f'  --set-env-vars "^|^APP_MODE=candidate|BUNDLE_PATH={bundle_posix}|'
        f"LLM_PROVIDER={llm_provider}|LLM_MODEL={llm_model}|"
        f"{extra_chain}"
        f'STORAGE_SINKS={storage_sinks}|NOTIFY_SINKS={notify_sinks}"' + (" \\" if needs_api_key else ""),
    ]
    if needs_api_key:
        cloud_run_lines.append(
            "  --set-secrets LLM_API_KEY=<YOUR_LLM_SECRET>:latest"
        )
    cloud_run_snippet = "\n".join(cloud_run_lines)

    app_runner_vars = [
        '          "APP_MODE": "candidate",',
        f'          "BUNDLE_PATH": "{bundle_posix}",',
        f'          "LLM_PROVIDER": "{llm_provider}",',
        f'          "LLM_MODEL": "{llm_model}",',
    ]
    app_runner_vars += [
        f'          "{key}": "{value}",' for key, value in extra_env
    ]
    app_runner_vars += [
        f'          "STORAGE_SINKS": "{storage_sinks}",',
        f'          "NOTIFY_SINKS": "{notify_sinks}"',
    ]
    aws_app_runner_snippet = "\n".join(
        [
            "# 1. Push image to ECR: <YOUR_ACCOUNT_ID>.dkr.ecr.<YOUR_REGION>.amazonaws.com/bigbank:latest",
            "# 2. Create or update App Runner service with candidate-mode env vars:",
            "aws apprunner create-service \\",
            "  --service-name bigbank \\",
            "  --source-configuration '{",
            '    "ImageRepository": {',
            '      "ImageIdentifier": "<YOUR_ECR_IMAGE_URI>",',
            '      "ImageRepositoryType": "ECR",',
            '      "ImageConfiguration": {',
            '        "Port": "8080",',
            '        "RuntimeEnvironmentVariables": {',
        ]
        + app_runner_vars
        + [
            "        }",
            "      }",
            "    }",
            "  }'",
        ]
    )

    azure_lines = [
        "az containerapp up \\",
        "  --name bigbank \\",
        "  --resource-group <YOUR_RESOURCE_GROUP> \\",
        "  --location <YOUR_LOCATION> \\",
        "  --source . \\",
        "  --ingress external \\",
        "  --target-port 8080 \\",
        "  --env-vars \\",
        "    APP_MODE=candidate \\",
        f"    BUNDLE_PATH={bundle_posix} \\",
        f"    LLM_PROVIDER={llm_provider} \\",
        f"    LLM_MODEL={llm_model} \\",
    ]
    azure_lines += [f"    {key}={value} \\" for key, value in extra_env]
    azure_lines += [
        f"    STORAGE_SINKS={storage_sinks} \\",
        f"    NOTIFY_SINKS={notify_sinks}" + (" \\" if needs_api_key else ""),
    ]
    if needs_api_key:
        azure_lines.append('    LLM_API_KEY="<YOUR_LLM_API_KEY>"')
    azure_container_apps_snippet = "\n".join(azure_lines)

    fly_lines = [
        "fly launch --no-deploy --name <YOUR_APP_NAME>",
        "fly secrets set \\",
    ]
    if needs_api_key:
        fly_lines.append('  LLM_API_KEY="<YOUR_LLM_API_KEY>" \\')
    fly_lines += [
        "  APP_MODE=candidate \\",
        f"  BUNDLE_PATH={bundle_posix} \\",
        f"  LLM_PROVIDER={llm_provider} \\",
        f"  LLM_MODEL={llm_model} \\",
    ]
    fly_lines += [f"  {key}={value} \\" for key, value in extra_env]
    fly_lines += [
        f"  STORAGE_SINKS={storage_sinks} \\",
        f"  NOTIFY_SINKS={notify_sinks}",
        "fly deploy",
    ]
    fly_io_snippet = "\n".join(fly_lines)

    return {
        "docker": docker_snippet,
        "cloud_run": cloud_run_snippet,
        "aws_app_runner": aws_app_runner_snippet,
        "azure_container_apps": azure_container_apps_snippet,
        "fly_io": fly_io_snippet,
    }


def get_deploy_readiness(settings: Settings, bundle_path: Path) -> dict[str, Any]:
    """Inspect candidate bundle, external sinks, and LLM config to report deploy readiness."""
    target = Path(bundle_path)
    bundle_exists = target.is_file() and target.stat().st_size > 0
    has_external_sink = DeliveryOrchestrator(settings).has_external_sinks()
    llm_configured = LLMService(settings).is_configured()

    warnings: list[str] = []
    if not bundle_exists:
        warnings.append(
            f"Candidate bundle not found at '{target.as_posix()}'. "
            "Run `python -m backend.cli package` or click 'Build Candidate Bundle' before deploying."
        )
    if not has_external_sink:
        warnings.append(
            "No external storage sink (S3, GCS, Azure Blob) or notification sink "
            "(SMTP, Slack, Teams, Webhook) is configured. Reports saved only to local container "
            "storage will be lost on restart or scale-to-zero."
        )
    if not llm_configured:
        warnings.append(
            "Automated LLM grading is not configured (LLM_PROVIDER is 'none' or missing credentials). "
            "Open-ended, code, and notebook answers will be marked for manual review."
        )

    return {
        "bundle_exists": bundle_exists,
        "has_external_sink": has_external_sink,
        "llm_configured": llm_configured,
        "warnings": warnings,
        "snippets": _build_deploy_snippets(settings, target),
    }
