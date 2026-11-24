# BigBank - An open source interview taking platform

**BigBank - Interview Platform** is an open-source, cloud-agnostic tool for technical and case-study interviews.
Teams create custom interviews in the local **BigBank** Admin Studio, package a read-only candidate bundle, and deploy the container to any cloud host.

---

## Demo

**Candidate interview** — starting an assessment, answering a multiple-choice question, a long-form design question and a Python notebook question, then submitting.

![Candidate interview demo](demo/candidate-interview.gif)

**Admin Studio** — the submitted assessment arriving in the results view.

![Admin Studio demo](demo/admin-studio.gif)

**Question bank upload** — bulk upload of a question bank file, with a preview of new, duplicate and invalid items before the import.

![Question bank upload demo](demo/question-bank-upload.gif)

---

## Why Use This Platform

Enterprise hiring teams often pay high fees for rigid third-party tools that hide how scores are calculated. This platform gives your team full control:

- **Flexibility:** Assess any role, such as Data Engineering, AI Engineering, Software Engineering, or Product Management. Use multiple-choice questions (`mcq`), written answers (`text`), code editors (`code`), or live Python notebooks (`notebook`).
- **Transparency:** Each question has an expected answer and a grading rubric. The AI evaluator explains the score for each question. Interviewers can review, change, or manually grade any answer and create a new PDF report.
- **Adaptability:** Do not lock your team to one cloud or AI vendor. Use any supported AI provider (`openai`, `anthropic`, `gemini`, `vertex_ai`, `azure`, `bedrock`, `ollama`, or `openai_compatible`), or set `LLM_PROVIDER=none` for manual grading. Store reports in `local`, `s3`, `gcs`, or `azure_blob`, and send alerts through `smtp`, `slack`, `teams`, or `webhook`.

---

## Table of Contents

- [Demo](#demo)
- [Core Features](#core-features)
- [System Architecture](#system-architecture)
- [Quick Start for Local Authoring](#quick-start-for-local-authoring)
- [CLI Commands](#cli-commands)
- [Bulk YAML and JSON Question Import](#bulk-yaml-and-json-question-import)
- [Interactive Python Notebook and Security Controls](#interactive-python-notebook-and-security-controls)
- [AI Grading Providers](#ai-grading-providers)
- [Report Storage and Notification Sinks](#report-storage-and-notification-sinks)
- [Deployment with Docker and Cloud Hosts](#deployment-with-docker-and-cloud-hosts)
- [Environment Variables](#environment-variables)
- [Technology Stack and Routes](#technology-stack-and-routes)
- [Development and Testing](#development-and-testing)

---

## Core Features

### Admin Studio (`/admin`)

- **Question Bank (`/admin/questions`):** Create, edit, search, and delete `mcq`, `text`, `code`, and `notebook` questions. Filter questions by tags, format, and difficulty (`easy`, `medium`, `hard`). Set default points, starter code, expected answers, and grading rubrics.
- **Bulk Import and Export:** Upload `.yaml`, `.yml`, or `.json` files to add or update many questions at one time. Preview new, duplicate, and invalid items before you save changes to the database. Export questions to YAML or JSON.
- **Template Composer (`/admin/templates`):** Create named interview templates with unique candidate URLs (`/i/<slug>`). Select **Curated** mode to order questions with drag-and-drop and override points, expected answers, or rubrics. Select **Random Pool** mode to draw questions by tag and difficulty count. Set the timer, access code, open-book search rule (`none`, `medium_hard`, or `all`), and custom PDF summary sections.
- **Results and Manual Grading (`/admin/results`):** View completed and pending submissions. Edit the score or feedback for any question, recalculate the total score, create a new PDF report, download the PDF, or send the report to delivery sinks again.
- **Settings and Connection Tests (`/admin/settings`):** Edit AI provider, storage, notification, and sandbox settings in the local `.env` file. Secret values stay masked in the UI. Test each integration from the settings page.
- **Deployment Packager (`/admin/deploy`):** Select all templates or specific templates to export into a clean `bundle/interview.db` file with no candidate data or secrets. Check deployment readiness and copy container commands.

### Candidate Portal (`/` and `/i/<slug>`)

- **Simple Login:** Candidates enter their full name, optional email address, and the access code. The server issues a signed session token for progress saves, notebook runs, and final submission.
- **Multi-Cell Python Notebook:** Candidates run Python code in an isolated kernel with `pandas`, `numpy`, and `matplotlib` installed. The notebook shows `stdout`, `stderr`, HTML tables, and PNG charts inline. Candidates can restart the kernel or install allowed Python packages when the template permits it.
- **Open-Book Web Search:** When the template allows web search (`medium_hard` or `all`), candidates see a search panel with quick chips from the question tags. An SSRF-safe proxy lets candidates preview documentation pages safely.
- **Safe Serverless Submission:** When a candidate submits (`/api/public/finish`), the server saves a raw JSON backup, grades answers in parallel, builds the PDF report, sends the report to all enabled sinks, and cleans up the Python kernel within the active HTTP request.

---

## System Architecture

```text
LOCAL AUTHORING MODE (APP_MODE=local)              CANDIDATE MODE (APP_MODE=candidate)
=====================================              ===================================
Admin Studio (/admin) + Preview (/)                Candidate Portal (/ and /i/<slug>)
          │                                        (/admin returns HTTP 404 unless ADMIN_PASSWORD is set)
          ▼                                                          │
   FastAPI Backend ──► data/interview.db (RW)                        ▼
          │                                                   FastAPI Backend (UID 0 parent)
          │  python -m backend.cli package                           ├──► bundle/interview.db (RO, 0600)
          │  (removes submissions and PII)                           ├──► /tmp/runtime.db (RW, 0600)
          └──────────────────────► bundle/interview.db               ├──► Notebook Worker (UID sandbox)
                                                                     │      └─ /tmp/sandbox_<session> (0700)
                                                                     ├──► Isolated LLM Adapter (selected provider or none)
                                                                     ├──► Storage Sinks (S3/GCS/Azure/Local)
                                                                     └──► Notify Sinks (SMTP/Slack/Teams/Webhook)
```

---

## Quick Start for Local Authoring

### Prerequisites

- **Python 3.11 or newer**
- **Node.js 20 or newer**

### Step 1: Install Backend Dependencies

1. Clone the repository and open the project directory.

```bash
git clone <your-repo-url>
cd <your-repo-directory>
```

2. Create and activate a Python virtual environment.

```bash
python -m venv venv
# Linux / macOS:
source venv/bin/activate
# Windows PowerShell:
.\venv\Scripts\Activate.ps1
```

3. Install the core Python packages (no cloud SDKs are required).

```bash
pip install -r requirements.txt
```

4. Optional: Install the AWS S3, Google Cloud Storage, and Azure Blob SDKs if you use cloud storage sinks.

```bash
pip install -r requirements-cloud.txt
```

5. Copy the example environment file to `.env`.

```bash
cp .env.example .env
```

### Step 2: Build the Frontend

1. Open the `frontend` directory, install packages, and build the static bundle.

```bash
cd frontend
npm ci
npm run build
cd ..
```

FastAPI serves the compiled frontend automatically from `backend/static_spa/` in Docker or from `frontend/dist/` locally.

### Step 3: Start the Server

Run the FastAPI server on port `8080`:

```bash
uvicorn backend.app:app --host 0.0.0.0 --port 8080 --reload
```

On the first start in `APP_MODE=local` (with `AUTO_SEED_EXAMPLES=true`), the server loads starter questions from `examples/starter_questions.yaml` and creates four sample templates (`data-engineer`, `ai-engineer`, `software-engineer`, and `product-manager`).

Open these URLs in your browser:

- **Candidate Portal:** `http://localhost:8080/` (or `http://localhost:8080/i/data-engineer`)
- **Admin Studio:** `http://localhost:8080/admin`
- **Health Check:** `http://localhost:8080/health`

> **Tip for Frontend Development:** Run `uvicorn backend.app:app --reload --port 8080` in one terminal. Run `cd frontend && npm run dev` in a second terminal to use Vite hot-reload on `http://localhost:5173`.

---

## CLI Commands

Use the CLI module for seeding, packaging, and sink tests:

```bash
# Load starter questions and sample templates into data/interview.db
python -m backend.cli seed

# Load a custom YAML or JSON file and overwrite duplicate questions
python -m backend.cli seed --file path/to/questions.yaml --duplicate-strategy overwrite

# Build a read-only SQLite bundle with no candidate submissions or secrets
python -m backend.cli package

# Build a bundle for specific template slugs only
python -m backend.cli package --templates data-engineer,ai-engineer --output bundle/interview.db

# Test all enabled storage and notification sinks
python -m backend.cli check-sinks

# Test specific sinks
python -m backend.cli check-sinks --sink s3,slack
```

---

## Bulk YAML and JSON Question Import

Upload `.yaml`, `.yml`, or `.json` files in **Admin Studio -> Questions -> Bulk Import**. You can also pass a file to `python -m backend.cli seed --file ...`.

### Standard Schema (YAML or JSON)

See [examples/starter_questions.yaml](examples/starter_questions.yaml) and [examples/starter_questions.json](examples/starter_questions.json) for complete examples across multiple roles.

```yaml
questions:
  - external_key: de-sql-window-01
    title: SQL Window Functions vs GROUP BY
    prompt: >-
      Which statement describes the difference between a SQL window
      function (`OVER (...)`) and a `GROUP BY` aggregation?
    format: mcq                  # mcq | text | code | notebook
    difficulty: easy             # easy | medium | hard
    tags: [data-engineering, sql]
    options:
      - Window functions keep individual rows; GROUP BY groups rows together.
      - Window functions only work on indexed integer columns.
      - Window functions run before WHERE.
      - Window functions cannot use SUM or AVG.
    answer_indices: [0]          # zero-based index list; use [0, 2] for multi-select
    default_points: 10
    expected_answer: Window functions keep row granularity across partitions.
    evaluation_rubric: 10 pts for selecting option 0.
    active: true

  - external_key: de-pandas-agg-03
    title: Sessionize Events and Compute Rolling Revenue
    prompt: Remove duplicate events by latest `ingested_at` and group into 30-minute user sessions.
    format: notebook             # Interactive multi-cell Python notebook
    difficulty: hard
    tags: [data-engineering, python, pandas]
    code_language: python
    starter_code: |
      import pandas as pd
      events = pd.DataFrame([...])
      events
    allow_execution: true
    default_points: 30
    expected_answer: Sort by ingested_at, drop duplicates, compute time diff > 30m, use cumsum.
    evaluation_rubric: |
      - 10 pts: Correct deduplication
      - 12 pts: Correct 30-minute session groups
      - 8 pts: Verified summary output
    active: true
```

### Legacy Flat JSON Support

The importer also accepts flat JSON arrays that use legacy field names (`id`, `type`, `question`, `category`, `answer_index`, `explanation`):

- `type: "mcq"` maps to `format: "mcq"`, and `answer_index` (`0`, `[0, 2]`, or `"0,2"`) maps to `answer_indices`.
- `type: "text"` maps to `format: "text"` (or `"notebook"` when `category` is Python).
- `category: "SQL"` maps to `tags: ["sql"]`.
- `explanation` maps to `expected_answer` and `evaluation_rubric`.

When `skip_invalid` is off, the importer rejects the entire batch if any row has an error. No partial data is written to the database.

---

## Interactive Python Notebook and Security Controls

When a template sets `allow_code_execution: true`, `notebook` questions run in an isolated per-session Python subprocess (`backend/services/notebook_kernel.py` and `backend/services/package_guard.py`):

1. **OS-User Isolation (Linux and Docker):** The FastAPI process starts notebook workers and `pip install` processes as the unprivileged `sandbox` user (`SANDBOX_OS_USER=sandbox`). Application code (`/app/backend`), starter examples (`/app/examples`), the catalog database (`/app/bundle/interview.db`), and runtime data (`/app/data`, `/tmp/runtime.db`) use `0700` or `0600` permissions owned by `root`, so `sandbox` cannot read them.
2. **Scrubbed Process Environment:** Subprocesses receive only an allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `PYTHONPATH`, `MPLBACKEND=Agg`, `PYTHONNOUSERSITE=1`). API keys, cloud credentials, SMTP passwords, and `ADMIN_PASSWORD` are removed.
3. **Session Directory Isolation:** Each session runs inside `/tmp/sandbox_<session_id>` with symlink and path-traversal checks. The server deletes this directory when the candidate submits or when the idle timer (`SANDBOX_IDLE_TIMEOUT_MINUTES`) expires.
4. **Time and Memory Limits:** Each cell enforces a timeout (`SANDBOX_CELL_TIMEOUT_SECONDS`, default `15` seconds) with process-group termination, and a virtual memory limit on POSIX (`SANDBOX_MAX_MEMORY_MB`, default `512` MB).
5. **Controlled Package Installation:** Package installation is off by default (`allow_package_install: false`). When enabled, `PackageGuard` enforces these rules:
   - Accepts only standard PyPI package names and version specifiers (blocks flags such as `--index-url`, URLs, `git+` references, local paths, and `.whl` files).
   - Blocks banned heavy packages in both direct and transitive dependencies (`SANDBOX_BANNED_PACKAGES`, such as `torch`, `tensorflow`, `jax`, `transformers`, and `pyspark`).
   - Checks PyPI package size before download (`SANDBOX_MAX_PACKAGE_MB`, default `25` MB).
   - Rejects symlinks and enforces a per-session disk cap (`SANDBOX_MAX_DISK_MB`, default `150` MB) with automatic rollback on failure.

---

## AI Grading Providers

The evaluator (`backend/services/llm.py`) uses isolated direct adapters for each provider. Only the selected provider runs; all other providers stay disabled. Set `LLM_PROVIDER`, `LLM_MODEL`, and credentials as needed:

| `LLM_PROVIDER` | Example `LLM_MODEL` | Required Configuration |
|---|---|---|
| `none` | *(none)* | No AI calls. MCQs grade automatically; open-ended answers wait for manual grading in Admin Studio. |
| `openai` | `gpt-4o-mini` | `LLM_API_KEY` |
| `anthropic` | `claude-3-5-sonnet-20241022` | `LLM_API_KEY` |
| `gemini` | `gemini-2.5-pro` | `LLM_API_KEY` |
| `vertex_ai` | `gemini-2.5-pro` | Google Cloud ADC or Workload Identity (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| `azure` | `gpt-4o-mini` | `LLM_API_KEY` and `LLM_BASE_URL` |
| `bedrock` | `anthropic.claude-3-5-sonnet-20241022-v2:0` | AWS IAM Role or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` |
| `ollama` | `llama3.1` | `LLM_BASE_URL=http://localhost:11434` (no API key required) |
| `openai_compatible` | `qwen2.5-coder:32b` | `LLM_BASE_URL` (and optional `LLM_API_KEY`) for vLLM, LiteLLM Proxy, OpenRouter, or Groq |

---

## Report Storage and Notification Sinks

Enable one or more sinks with comma-separated lists. Each sink runs independently during `/api/public/finish`. If one sink fails, the other sinks still run, and the server saves the status of each sink in `delivery_log`.

### Storage Sinks (`STORAGE_SINKS`)

- `local` — Saves the PDF report and raw JSON backup to `LOCAL_REPORTS_DIR` (default `data/reports`).
- `s3` — Uploads to AWS S3 or an S3-compatible store (Cloudflare R2, MinIO, DigitalOcean Spaces) via `S3_ENDPOINT_URL`. Imports `boto3` only when used.
- `gcs` — Uploads to Google Cloud Storage via ADC or Workload Identity. Imports `google-cloud-storage` only when used.
- `azure_blob` — Uploads to Azure Blob Storage via `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_ACCOUNT_URL`. Imports `azure-storage-blob` and `azure-identity` only when used.
- Set `STORAGE_PRESIGNED_URLS=true` to include expiring download links (`STORAGE_PRESIGNED_TTL_SECONDS`, default `604800` seconds) in notifications.

### Notification Sinks (`NOTIFY_SINKS`)

- `smtp` — Sends an HTML summary email with the PDF report attached. Uses verified TLS (`ssl.create_default_context()`).
- `slack` — Posts to `SLACK_WEBHOOK_URL`, or uses `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` to upload the PDF file directly.
- `teams` — Posts a Microsoft Teams Adaptive Card to `TEAMS_WEBHOOK_URL`.
- `webhook` — Sends an HTTP POST JSON payload to `WEBHOOK_URL` with an optional HMAC-SHA256 `X-Signature-256` header (`WEBHOOK_SECRET`) and optional `pdf_base64` (`WEBHOOK_INCLUDE_PDF_BASE64=true`).

---

## Deployment with Docker and Cloud Hosts

1. Package your authored questions and templates into `bundle/interview.db`:

```bash
# 1. Package your authored questions and templates into bundle/interview.db
python -m backend.cli package

# 2. Build the multi-stage container image
docker build -t bigbank:latest .

# 3. Run locally with Docker Compose (Local Authoring Studio on port 8080)
docker compose up --build

# Or preview Candidate Mode on port 8081
docker compose --profile candidate up --build
```

For full deployment instructions for **Docker**, **Google Cloud Run**, **AWS App Runner**, **Azure Container Apps**, **Fly.io**, and **Kubernetes**, see [deploy/README.md](deploy/README.md).

---

## Environment Variables

Copy `.env.example` to `.env` for local authoring, or pass these variables through your cloud host's secret manager.

| Variable | Default | Description |
|---|---|---|
| `APP_MODE` | `local` | `local` (read-write DB and Admin Studio) or `candidate` (read-only bundle and locked Admin) |
| `APP_TITLE` | `BigBank` | Brand name shown in the web UI and notifications |
| `ADMIN_PASSWORD` | `""` | Optional password; in `candidate` mode, enables read-only Admin access |
| `ACCESS_CODE` | `""` | Optional runtime override for candidate login access codes |
| `DATABASE_PATH` | `data/interview.db` | Authoring SQLite database path (`local` mode) |
| `BUNDLE_PATH` | `bundle/interview.db` | Packaged read-only SQLite bundle path (`candidate` mode) |
| `RUNTIME_DB_PATH` | `/tmp/runtime.db` | Ephemeral runtime session database path (`candidate` mode) |
| `AUTO_SEED_EXAMPLES` | `true` | Seed starter questions when the local database is empty |
| `LLM_PROVIDER` | `none` | `none`, `openai`, `anthropic`, `gemini`, `vertex_ai`, `azure`, `bedrock`, `ollama`, `openai_compatible` |
| `LLM_MODEL` | `gpt-4o-mini` | Model ID for the selected AI provider |
| `LLM_API_KEY` | `""` | API key for the AI provider (masked in Admin Settings) |
| `LLM_BASE_URL` | `""` | Custom endpoint URL for Ollama, Azure, or OpenAI-compatible servers |
| `STORAGE_SINKS` | `local` | Comma-separated list: `local`, `s3`, `gcs`, `azure_blob` |
| `LOCAL_REPORTS_DIR` | `data/reports` | Output folder for the `local` storage sink |
| `S3_BUCKET` / `S3_PREFIX` / `S3_REGION` / `S3_ENDPOINT_URL` | `""` / `interviews` / `us-east-1` / `""` | S3 and S3-compatible storage settings |
| `GCS_BUCKET` / `GCS_PREFIX` | `""` / `interviews` | Google Cloud Storage bucket and prefix |
| `AZURE_STORAGE_CONNECTION_STRING` / `AZURE_STORAGE_ACCOUNT_URL` / `AZURE_STORAGE_CONTAINER` / `AZURE_STORAGE_PREFIX` | `""` / `""` / `""` / `interviews` | Azure Blob Storage settings |
| `STORAGE_PRESIGNED_URLS` / `STORAGE_PRESIGNED_TTL_SECONDS` | `false` / `604800` | Include expiring signed download URLs in notifications |
| `NOTIFY_SINKS` | `""` | Comma-separated list: `smtp`, `slack`, `teams`, `webhook` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `SMTP_TO` / `SMTP_USE_TLS` | `""` / `587` / ... / `true` | SMTP email settings |
| `SLACK_WEBHOOK_URL` / `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` | `""` | Slack webhook or Bot API settings |
| `TEAMS_WEBHOOK_URL` | `""` | Microsoft Teams webhook URL |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` / `WEBHOOK_INCLUDE_PDF_BASE64` | `""` / `""` / `false` | Generic JSON webhook settings |
| `SANDBOX_MAX_PACKAGE_MB` | `25` | Maximum PyPI package size for `pip install` |
| `SANDBOX_MAX_DISK_MB` | `150` | Maximum total package disk usage per session |
| `SANDBOX_CELL_TIMEOUT_SECONDS` | `15` | Timeout for each notebook cell run |
| `SANDBOX_MAX_MEMORY_MB` | `512` | Virtual memory limit for the Python worker (`RLIMIT_AS` on Linux/macOS) |
| `SANDBOX_IDLE_TIMEOUT_MINUTES` | `15` | Idle time before a kernel is stopped and cleaned up |
| `SANDBOX_OS_USER` | `""` (`sandbox` in Docker) | POSIX user for subprocess privilege drop |
| `SANDBOX_BANNED_PACKAGES` | *(heavy ML/GPU list)* | Comma-separated list of blocked Python packages |

---

## Technology Stack and Routes

| Layer | Technology |
|---|---|
| **Backend** | FastAPI, Pydantic v2, SQLite, fpdf2, httpx, BeautifulSoup4 |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, Monaco Editor, `@dnd-kit`, `react-markdown`, Lucide icons |
| **Notebook Runtime** | Isolated Python 3.11 subprocess worker (`pandas`, `numpy`, `matplotlib`) |
| **Container** | Multi-stage Docker (`node:20-slim` and `python:3.11-slim`) with `sandbox` OS-user isolation |

### Main Routes

- **Frontend UI:** `/` (default Candidate Portal), `/i/<slug>` (template Candidate Portal), `/admin` (Admin Studio)
- **System:** `GET /health`
- **Public API (`/api/public/*`):** `templates/default`, `templates/{slug}`, `login`, `progress`, `finish`, `notebook/execute`, `notebook/install`, `notebook/restart`, `search`, `proxy`
- **Admin API (`/api/admin/*`):** `status`, `auth/login`, `questions/*`, `tags`, `templates/*`, `results/*`, `settings/*`, `deploy/*`

---

## Development and Testing

Run the backend test suite:

```bash
pytest tests/ -v
```

Type-check and build the frontend:

```bash
cd frontend
npx tsc --noEmit
npm run build
```
