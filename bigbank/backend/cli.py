"""Command-line utilities for packaging candidate bundles, seeding examples, and checking sinks."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

from backend.config import get_settings
from backend.db.database import DatabaseManager
from backend.db.repository import InterviewRepository
from backend.services.delivery.orchestrator import DeliveryOrchestrator
from backend.services.import_export import commit_import
from backend.services.llm import LLMService
from backend.services.packager import build_deployment_bundle

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_STARTER_FILE = _REPO_ROOT / "examples" / "starter_questions.yaml"

_STARTER_TEMPLATES: tuple[dict[str, Any], ...] = (
    {
        "slug": "data-engineer",
        "name": "Data Engineer Assessment",
        "role_title": "Data Engineer",
        "description": "SQL, streaming/CDC architecture, and hands-on pandas notebook problem solving.",
        "selection_mode": "curated",
        "match_tags": ["data-engineering"],
        "timer_minutes": 45,
        "open_book_policy": "medium_hard",
        "allow_code_execution": True,
        "allow_package_install": False,
        "summary_dimensions": ["SQL & Data Modeling", "Pipeline Architecture", "Python & Pandas"],
        "is_default": True,
    },
    {
        "slug": "ai-engineer",
        "name": "AI / LLM Engineer Assessment",
        "role_title": "AI Engineer",
        "description": "RAG retrieval architecture, evaluation design, and hybrid ranking in Python.",
        "selection_mode": "curated",
        "match_tags": ["ai-engineering"],
        "timer_minutes": 45,
        "open_book_policy": "medium_hard",
        "allow_code_execution": True,
        "allow_package_install": False,
        "summary_dimensions": ["LLM & RAG Design", "Evaluation Rigor", "Applied Python"],
        "is_default": False,
    },
    {
        "slug": "software-engineer",
        "name": "Software Engineer Assessment",
        "role_title": "Software Engineer",
        "description": "API design, concurrency, and data structures & algorithms.",
        "selection_mode": "curated",
        "match_tags": ["software-engineering", "dsa"],
        "timer_minutes": 45,
        "open_book_policy": "none",
        "allow_code_execution": False,
        "allow_package_install": False,
        "summary_dimensions": ["Backend Systems", "Algorithms & Data Structures", "Code Quality"],
        "is_default": False,
    },
    {
        "slug": "product-manager",
        "name": "Product Manager Case Assessment",
        "role_title": "Product Manager",
        "description": "Experimentation metrics, guardrails, and B2B activation strategy.",
        "selection_mode": "curated",
        "match_tags": ["product-management"],
        "timer_minutes": 45,
        "open_book_policy": "all",
        "allow_code_execution": False,
        "allow_package_install": False,
        "summary_dimensions": ["Product Strategy", "Metrics & Experimentation", "Execution"],
        "is_default": False,
    },
)


def seed_starter_data(
    repo: InterviewRepository,
    file_path: Path | None = None,
    duplicate_strategy: str = "skip",
) -> dict[str, Any]:
    """Import starter questions and idempotently create default role templates."""
    source = Path(file_path) if file_path is not None else _DEFAULT_STARTER_FILE
    if not source.is_file():
        raise FileNotFoundError(f"Starter questions file not found: {source}")

    raw_bytes = source.read_bytes()
    import_result = commit_import(
        repo,
        raw_bytes,
        source.name,
        duplicate_strategy=duplicate_strategy,
    )

    templates_created = 0
    has_existing_default = any(t.get("is_default") for t in repo.list_templates())

    for spec in _STARTER_TEMPLATES:
        if repo.get_template_by_slug(spec["slug"]) is not None:
            continue
        matched = repo.list_questions(
            tags=spec["match_tags"], tag_match="any", active_only=True
        )
        if not matched:
            continue
        is_default = bool(spec["is_default"]) and not has_existing_default
        repo.create_template(
            {
                "slug": spec["slug"],
                "name": spec["name"],
                "role_title": spec["role_title"],
                "description": spec["description"],
                "selection_mode": spec["selection_mode"],
                "timer_minutes": spec["timer_minutes"],
                "open_book_policy": spec["open_book_policy"],
                "allow_code_execution": spec["allow_code_execution"],
                "allow_package_install": spec["allow_package_install"],
                "summary_dimensions": spec["summary_dimensions"],
                "is_default": is_default,
                "questions": [
                    {"question_id": q["id"], "position": idx}
                    for idx, q in enumerate(matched)
                ],
            }
        )
        if is_default:
            has_existing_default = True
        templates_created += 1

    # Fallback: if custom file had non-matching tags and DB has zero templates, create a generic pool.
    if not repo.list_templates() and repo.list_questions(active_only=True):
        repo.create_template(
            {
                "slug": "starter-interview",
                "name": "Starter Interview",
                "role_title": "Candidate",
                "description": "Default random pool generated from seeded questions.",
                "selection_mode": "random_pool",
                "random_rules": {"tags": [], "match": "any", "total": 10},
                "timer_minutes": 45,
                "open_book_policy": "medium_hard",
                "allow_code_execution": True,
                "allow_package_install": False,
                "summary_dimensions": ["Problem Solving", "Communication", "Technical Depth"],
                "is_default": True,
            }
        )
        templates_created += 1

    return {
        "file": str(source),
        "created": import_result["created"],
        "updated": import_result["updated"],
        "skipped": import_result["skipped"],
        "errors": import_result["errors"],
        "templates_created": templates_created,
    }


def _cmd_package(args: argparse.Namespace) -> int:
    settings = get_settings()
    db_path = Path(args.db or settings.database_path)
    output_path = Path(args.output or settings.bundle_path)

    if not db_path.is_file():
        print(f"Error: source database not found at '{db_path}'.", file=sys.stderr)
        return 1

    slugs: list[str] | None = None
    if args.templates:
        slugs = [s.strip() for s in args.templates.split(",") if s.strip()]

    db = DatabaseManager(db_path, db_path, catalog_read_only=True)
    repo = InterviewRepository(db)

    try:
        summary = build_deployment_bundle(repo, output_path, template_slugs=slugs)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    size_kb = summary["size_bytes"] / 1024.0
    print(
        f"Bundle created: {summary['output_path']} "
        f"({summary['templates_count']} templates, {summary['questions_count']} questions, "
        f"{summary['tags_count']} tags, {size_kb:.1f} KB)"
    )
    print(f"Included templates: {', '.join(summary['template_slugs'])}")
    return 0


def _cmd_seed(args: argparse.Namespace) -> int:
    settings = get_settings()
    db_path = Path(args.db or settings.database_path)
    file_path = Path(args.file) if args.file else _DEFAULT_STARTER_FILE

    db = DatabaseManager(db_path, db_path)
    db.init_schemas()
    repo = InterviewRepository(db)

    try:
        result = seed_starter_data(
            repo, file_path=file_path, duplicate_strategy=args.duplicate_strategy
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if result["errors"]:
        print(
            f"Seed aborted due to {len(result['errors'])} validation error(s):",
            file=sys.stderr,
        )
        for err in result["errors"]:
            print(f"  - item {err['index']}: {err['error']}", file=sys.stderr)
        return 1

    print(
        f"Seeded {db_path} from {result['file']}: "
        f"{result['created']} created, {result['updated']} updated, "
        f"{result['skipped']} skipped, {result['templates_created']} template(s) created."
    )
    return 0


def _cmd_check_sinks(args: argparse.Namespace) -> int:
    settings = get_settings()
    orchestrator = DeliveryOrchestrator(settings)
    llm_service = LLMService(settings)

    if args.sink:
        sinks = [s.strip().lower() for s in args.sink.split(",") if s.strip()]
    else:
        sinks = []
        for s in [*settings.storage_sink_list, *settings.notify_sink_list]:
            if s not in sinks:
                sinks.append(s)

    if not sinks:
        print("No storage or notification sinks configured.")
        print(
            f"External sinks configured: {orchestrator.has_external_sinks()} | "
            f"LLM configured: {llm_service.is_configured()}"
        )
        return 0

    async def _run_all() -> list[dict[str, Any]]:
        return [await orchestrator.test_sink(name) for name in sinks]

    outcomes = asyncio.run(_run_all())
    all_ok = True
    for res in outcomes:
        status = "PASS" if res["ok"] else "FAIL"
        if not res["ok"]:
            all_ok = False
        print(f"[{status}] {res['sink']}: {res['detail']}")

    print(
        f"Summary: external_sinks={orchestrator.has_external_sinks()}, "
        f"llm_configured={llm_service.is_configured()}"
    )
    return 0 if all_ok else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.cli",
        description="BigBank - Interview Platform administration CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    pkg = sub.add_parser(
        "package",
        help="Build a stripped, PII-free SQLite candidate deployment bundle.",
    )
    pkg.add_argument(
        "--templates",
        default=None,
        help="Comma-separated template slugs to include (default: all templates).",
    )
    pkg.add_argument(
        "--output",
        default=None,
        help="Output SQLite bundle path (default: BUNDLE_PATH / bundle/interview.db).",
    )
    pkg.add_argument(
        "--db",
        default=None,
        help="Source catalog SQLite database path (default: DATABASE_PATH / data/interview.db).",
    )
    pkg.set_defaults(func=_cmd_package)

    seed = sub.add_parser(
        "seed",
        help="Initialize database and seed starter questions and templates.",
    )
    seed.add_argument(
        "--file",
        default=None,
        help="Path to YAML/JSON questions file (default: examples/starter_questions.yaml).",
    )
    seed.add_argument(
        "--db",
        default=None,
        help="Target SQLite database path (default: DATABASE_PATH / data/interview.db).",
    )
    seed.add_argument(
        "--duplicate-strategy",
        choices=("skip", "overwrite"),
        default="skip",
        help="How to handle duplicate questions during seed (default: skip).",
    )
    seed.set_defaults(func=_cmd_seed)

    check = sub.add_parser(
        "check-sinks",
        help="Test configured storage and notification delivery sinks.",
    )
    check.add_argument(
        "--sink",
        default=None,
        help="Optional comma-separated sink names to test (default: all configured sinks).",
    )
    check.set_defaults(func=_cmd_check_sinks)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
