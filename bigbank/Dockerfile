# =============================================================================
# Stage 1: Build React + TypeScript + Vite SPA
# =============================================================================
FROM node:20-slim AS frontend-builder

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# =============================================================================
# Stage 2: Hardened Python Runtime with OS-User Sandbox Privilege Drop
# =============================================================================
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Set --build-arg INSTALL_CLOUD_SDKS=false for a smaller image when using only
# local disk, SMTP, Slack, Teams, or generic webhooks (zero cloud SDKs).
ARG INSTALL_CLOUD_SDKS=true

COPY requirements.txt requirements-cloud.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$INSTALL_CLOUD_SDKS" = "true" ]; then \
         pip install --no-cache-dir -r requirements-cloud.txt; \
       fi

# Create a dedicated, unprivileged OS user (`sandbox`) for candidate Python
# notebook kernels and `%pip install` subprocesses.
RUN groupadd --system sandbox \
    && useradd --system --gid sandbox --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox

# Copy backend source, compiled SPA, starter examples, and optional candidate bundle.
# `bundle/.gitkeep` ensures `COPY bundle/` always succeeds even before packaging.
COPY backend/ /app/backend/
COPY --from=frontend-builder /frontend/dist/ /app/backend/static_spa/
COPY examples/ /app/examples/
COPY bundle/ /app/bundle/

# Privilege-drop filesystem isolation model (matches backend/services/notebook_kernel.py
# and backend/services/package_guard.py):
#   1. The FastAPI parent process runs as UID 0 (`root`) inside the container so
#      `resolve_sandbox_user()` (`os.geteuid() == 0`) can `os.chown()` per-session
#      `/tmp/sandbox_<session>` directories to `sandbox:sandbox` and spawn every
#      candidate Python worker & `pip` subprocess with `subprocess.Popen(..., user="sandbox")`.
#   2. `/app/backend`, `/app/bundle`, `/app/data`, and `/app/examples` are owned by
#      `root:root` with `0700` on directories and `0600` on files, and uvicorn starts
#      under `umask 077` (so `/tmp/runtime.db` is created `0600 root:root`).
#   3. Consequently, candidate code running as `sandbox` cannot read `bundle/interview.db`
#      (expected answers & rubrics), `/app/examples/` (starter answers & rubrics),
#      `/app/backend/`, `/app/data/`, `/tmp/runtime.db`, or `/proc/1/environ`
#      (LLM/cloud/admin secrets), while still reading system Python libraries
#      (`0755`/`0644`) and its own `/tmp/sandbox_<session>` workspace.
RUN mkdir -p /app/data /app/bundle \
    && chown -R root:root /app/backend /app/bundle /app/data /app/examples \
    && find /app/backend /app/bundle /app/data /app/examples -type d -exec chmod 700 {} + \
    && find /app/backend /app/bundle /app/data /app/examples -type f -exec chmod 600 {} +

ENV APP_MODE=candidate \
    SANDBOX_OS_USER=sandbox \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8080\")}/health', timeout=3)" || exit 1

CMD ["sh", "-c", "umask 077 && exec uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
