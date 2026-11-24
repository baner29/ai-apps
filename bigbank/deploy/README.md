# Deployment Guide — BigBank - An open source interview taking platform

Deploy **BigBank - Interview Platform** anywhere that runs a standard OCI container — with zero cloud lock-in, immutable candidate bundles, and isolated Python notebook sandboxes.

---

## Table of Contents

- [1. Pre-Deploy Workflow: Build a Candidate Bundle](#1-pre-deploy-workflow-build-a-candidate-bundle)
- [2. Container Security & Privilege-Drop Model](#2-container-security--privilege-drop-model)
- [3. Docker & Docker Compose](#3-docker--docker-compose)
- [4. Google Cloud Run](#4-google-cloud-run)
- [5. AWS App Runner](#5-aws-app-runner)
- [6. Azure Container Apps](#6-azure-container-apps)
- [7. Fly.io](#7-flyio)
- [8. Kubernetes](#8-kubernetes)
- [9. Verifying Sinks & Health](#9-verifying-sinks--health)

---

## 1. Pre-Deploy Workflow: Build a Candidate Bundle

Author questions and interview templates locally in **Admin Studio** (`APP_MODE=local`, stored in `data/interview.db`), then package a stripped, PII-free SQLite bundle for production:

```bash
# Package all templates into bundle/interview.db
python -m backend.cli package

# Or package only selected template slugs
python -m backend.cli package --templates data-engineer,ai-engineer --output bundle/interview.db
```

You can also generate `bundle/interview.db` directly from **Admin Studio -> Deploy**.

What packaging guarantees:
- **Zero candidate PII:** Submissions, answers, grades, and delivery logs are excluded from `bundle/interview.db`.
- **Read-only catalog in production:** Under `APP_MODE=candidate`, the app opens `bundle/interview.db` in SQLite read-only mode (`mode=ro`) and stores ephemeral in-progress session state in `RUNTIME_DB_PATH` (`/tmp/runtime.db`).
- **Locked admin surface:** Under `APP_MODE=candidate`, `/admin` and `/api/admin/*` return `HTTP 404` unless `ADMIN_PASSWORD` is explicitly set (in which case Admin Studio is password-protected and strictly read-only).
- **Important:** Configure at least one durable external storage or notification sink (`s3`, `gcs`, `azure_blob`, `smtp`, `slack`, `teams`, or `webhook`) before deploying to ephemeral/serverless containers.

---

## 2. Container Security & Privilege-Drop Model

The multi-stage `Dockerfile` is hardened to match `backend/services/notebook_kernel.py` and `backend/services/package_guard.py`:

| Layer | Mechanism | Protection |
|---|---|---|
| **Process Isolation** | FastAPI (`uvicorn`) runs as container UID `0` (`root`); every candidate Python notebook worker and `%pip install` subprocess drops privileges via `subprocess.Popen(..., user="sandbox")`. | `resolve_sandbox_user()` checks `os.geteuid() == 0` so `_prepare_session_dirs()` can `os.chown()` `/tmp/sandbox_<session>` to `sandbox:sandbox` (`0700`) and drop kernel privileges to the unprivileged `sandbox` OS user (`nologin`, no home dir). |
| **Filesystem Isolation** | `/app/backend`, `/app/bundle`, `/app/data`, and `/app/examples` are `root:root` with `0700` (directories) and `0600` (files); `uvicorn` starts with `umask 077` so `/tmp/runtime.db` is created `0600 root:root`. | Candidate code running as `sandbox` receives `PermissionError` (`EACCES`) if it tries to read `bundle/interview.db`, `/app/examples/` (starter answers & rubrics), `/app/backend/`, `/app/data/`, or `/tmp/runtime.db`. |
| **Secret Isolation** | Scrubbed allowlist environment (`build_scrubbed_env`) passed to every kernel/`pip` subprocess; `/proc/1/environ` is `0400 root:root`. | `os.environ` inside a candidate notebook contains zero LLM, cloud, SMTP, webhook, or admin secrets. |
| **Package & Resource Guardrails** | PEP 508 spec validation, banlist (direct + transitive), PyPI size check, symlink rejection, per-session disk budget, `RLIMIT_AS` memory limit, cell execution timeout, idle reaper. | Blocks `git+`, URLs, pip flags, oversized ML wheels (`torch`, `tensorflow`, etc.), and runaway loops/memory bombs. |
| **SSRF Protection** | `/api/public/proxy` validates `http`/`https`, resolves DNS before every request and redirect hop, and blocks loopback, RFC1918, link-local/cloud metadata (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), and IPv6 private/ULA ranges. | Prevents candidates using open-book search from hitting cloud metadata endpoints or internal services. |

### Production Hardening Notes

- **Bake `bundle/interview.db` into the image** (`docker build`) rather than host bind-mounting it in production so the image's `0700`/`0600 root:root` permissions are preserved automatically.
- **Linux capabilities (Docker/Kubernetes):** Because the parent process transitions child subprocesses from UID `0` to `sandbox`, creates/chowns/removes `sandbox`-owned `0700` temp directories, and signals `sandbox` process groups on timeout, dropping all capabilities requires adding back `SETUID`, `SETGID`, `CHOWN`, `FOWNER`, `DAC_OVERRIDE`, and `KILL`.
- **Strict non-root clusters (`runAsNonRoot: true`):** If your cluster policy forbids UID `0` containers, disable live Python execution (`allow_code_execution: false` on your templates) and build a variant image running as a single non-root user.
- **Serverless-safe submission:** `/api/public/finish` completes raw backup, parallel LLM evaluation, PDF rendering, multi-sink fan-out, and kernel cleanup **inside the active HTTP request** (no fire-and-forget background threads that serverless platforms freeze after responding). Set your platform's HTTP request timeout to **120–300 seconds**.

---

## 3. Docker & Docker Compose

### Build the Production Image

```bash
# Default build (includes AWS S3, GCS, and Azure Blob SDKs from requirements-cloud.txt)
docker build -t bigbank:latest .

# Minimal image without cloud storage SDKs (for local/SMTP/Slack/Teams/Webhook deployments)
docker build --build-arg INSTALL_CLOUD_SDKS=false -t bigbank:slim .
```

### Run Standalone Candidate Container

```bash
docker run --rm -p 8080:8080 \
  -e APP_MODE=candidate \
  -e APP_TITLE="BigBank" \
  -e LLM_PROVIDER=openai \
  -e LLM_MODEL=gpt-4o-mini \
  -e LLM_API_KEY="$OPENAI_API_KEY" \
  -e STORAGE_SINKS=s3 \
  -e S3_BUCKET=my-interview-reports \
  -e S3_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  -e NOTIFY_SINKS=slack \
  -e SLACK_WEBHOOK_URL="$SLACK_WEBHOOK_URL" \
  bigbank:latest
```

### Docker Compose (Local Authoring & Candidate Preview)

```bash
# Start Local Authoring Studio (http://localhost:8080 and http://localhost:8080/admin)
docker compose up --build

# Preview locked Candidate Mode (http://localhost:8081) after generating bundle/interview.db
docker compose --profile candidate up --build
```

---

## 4. Google Cloud Run

Cloud Run works seamlessly with **Google Cloud Storage (`gcs`)** and **Vertex AI (`vertex_ai`)** or **Gemini API (`gemini`)** using Workload Identity (no static JSON keys required).

### Prerequisites

Grant the Cloud Run runtime service account:
- `roles/storage.objectAdmin` on your target GCS bucket
- `roles/aiplatform.user` (only if using `LLM_PROVIDER=vertex_ai`)
- `roles/secretmanager.secretAccessor` (if injecting API keys / SMTP / Slack secrets via `--set-secrets`)

### Build & Deploy

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export REPO="interview-platform"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/app:latest"

# 1. Package your latest interview bundle
python -m backend.cli package

# 2. Create Artifact Registry repository (once)
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID"

# 3. Build and push image
gcloud builds submit --tag "$IMAGE" --project="$PROJECT_ID"

# 4. Deploy to Cloud Run
gcloud run deploy interview-platform \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --timeout=300 \
  --concurrency=20 \
  --min-instances=0 \
  --max-instances=5 \
  --set-env-vars="^|^APP_MODE=candidate|STORAGE_SINKS=gcs|GCS_BUCKET=your-reports-bucket|GCS_PREFIX=interviews|LLM_PROVIDER=vertex_ai|LLM_MODEL=gemini-2.5-pro|VERTEXAI_PROJECT=${PROJECT_ID}|VERTEXAI_LOCATION=${REGION}"
```

> **Tip:** Allocate at least **2 GiB RAM** when notebook code execution (`pandas`, `numpy`, `matplotlib`) is enabled. For OpenAI/Anthropic/Gemini API keys or SMTP passwords, bind them via `--set-secrets="LLM_API_KEY=llm-api-key:latest"`.

---

## 5. AWS App Runner

AWS App Runner pulls your image from Amazon ECR and uses an IAM **Instance Role** for passwordless **Amazon S3 (`s3`)** and **Amazon Bedrock (`bedrock`)** access.

### 1. Build & Push to Amazon ECR

```bash
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export ECR_REPO="bigbank"
export IMAGE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest"

# Package bundle
python -m backend.cli package

# Create ECR repository (once)
aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION"

# Authenticate, build, and push
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker build -t "$IMAGE" .
docker push "$IMAGE"
```

### 2. Configure App Runner Service

Create an App Runner service (via AWS Console or `aws apprunner create-service`) with:
- **Source:** Container registry (Amazon ECR) -> `$IMAGE`
- **Port:** `8080`
- **CPU / Memory:** `1 vCPU / 2 GB` (or `2 vCPU / 4 GB` for concurrent notebook sessions)
- **Health Check:** HTTP `GET /health`
- **Instance Role Permissions:**
  - `s3:ListBucket` on `arn:aws:s3:::your-reports-bucket`
  - `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::your-reports-bucket/*`
  - `bedrock:InvokeModel` (optional, if using `LLM_PROVIDER=bedrock`)
- **Runtime Environment Variables / Secrets Manager:**
  ```text
  APP_MODE=candidate
  STORAGE_SINKS=s3
  S3_BUCKET=your-reports-bucket
  S3_PREFIX=interviews
  S3_REGION=us-east-1
  LLM_PROVIDER=bedrock
  LLM_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
  NOTIFY_SINKS=slack
  SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
  ```

---

## 6. Azure Container Apps

Azure Container Apps supports **Azure Blob Storage (`azure_blob`)** via Managed Identity (`DefaultAzureCredential` + `AZURE_STORAGE_ACCOUNT_URL`) or a connection string (`AZURE_STORAGE_CONNECTION_STRING`), plus **Azure OpenAI (`azure`)**.

### Build & Deploy

```bash
export RESOURCE_GROUP="rg-interview-platform"
export LOCATION="eastus"
export ACR_NAME="acrinterviewplatform"
export APP_NAME="interview-platform"

# 1. Package bundle
python -m backend.cli package

# 2. Build image directly in Azure Container Registry
az acr build --registry "$ACR_NAME" --image "${APP_NAME}:latest" .

# 3. Create or update Container App
az containerapp up \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --image "${ACR_NAME}.azurecr.io/${APP_NAME}:latest" \
  --ingress external \
  --target-port 8080

# 4. Create Container App secret before referencing it in environment variables
az containerapp secret set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --secrets llm-api-key="<YOUR_AZURE_OPENAI_API_KEY>"

# 5. Bind environment variables (including secretref) and size container for notebook workloads (1 CPU / 2 GiB)
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --cpu 1.0 \
  --memory 2.0Gi \
  --set-env-vars \
    APP_MODE=candidate \
    STORAGE_SINKS=azure_blob \
    AZURE_STORAGE_ACCOUNT_URL="https://yourstorageaccount.blob.core.windows.net" \
    AZURE_STORAGE_CONTAINER=interviews \
    LLM_PROVIDER=azure \
    LLM_MODEL=gpt-4o-mini \
    LLM_BASE_URL="https://your-openai-resource.openai.azure.com" \
    LLM_API_KEY="secretref:llm-api-key"
```

Assign the Container App's System-Assigned Managed Identity the **Storage Blob Data Contributor** role on your Azure Storage Account when using `AZURE_STORAGE_ACCOUNT_URL`.

---

## 7. Fly.io

Fly.io runs the same `Dockerfile` globally with built-in TLS and zero-config private networking.

### 1. Minimal `fly.toml`

```toml
app = "your-interview-platform"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  APP_MODE = "candidate"
  PORT = "8080"
  SANDBOX_OS_USER = "sandbox"
  STORAGE_SINKS = "s3"
  S3_BUCKET = "your-r2-or-s3-bucket"
  S3_ENDPOINT_URL = "https://<account-id>.r2.cloudflarestorage.com"
  LLM_PROVIDER = "openai"
  LLM_MODEL = "gpt-4o-mini"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    grace_period = "15s"
    interval = "30s"
    method = "GET"
    timeout = "5s"
    path = "/health"

[[vm]]
  cpu_kind = "shared"
  cpus = 2
  memory_mb = 2048
```

### 2. Set Secrets & Deploy

```bash
python -m backend.cli package

fly secrets set \
  LLM_API_KEY="sk-..." \
  AWS_ACCESS_KEY_ID="..." \
  AWS_SECRET_ACCESS_KEY="..." \
  SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."

fly deploy
```

---

## 8. Kubernetes

Below is a production-ready Deployment and Service manifest. Store API keys, storage credentials, and webhook URLs in a Kubernetes `Secret` (or External Secrets Operator).

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: interview-platform
  labels:
    app: interview-platform
spec:
  replicas: 2
  selector:
    matchLabels:
      app: interview-platform
  template:
    metadata:
      labels:
        app: interview-platform
    spec:
      containers:
        - name: interview-platform
          image: ghcr.io/your-org/bigbank:latest
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          env:
            - name: APP_MODE
              value: "candidate"
            - name: PORT
              value: "8080"
            - name: SANDBOX_OS_USER
              value: "sandbox"
            - name: STORAGE_SINKS
              value: "s3"
            - name: S3_BUCKET
              value: "your-reports-bucket"
            - name: NOTIFY_SINKS
              value: "slack"
            - name: LLM_PROVIDER
              value: "openai"
            - name: LLM_MODEL
              value: "gpt-4o-mini"
          envFrom:
            - secretRef:
                name: interview-platform-secrets
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
              add:
                - SETUID
                - SETGID
                - CHOWN
                - FOWNER
                - DAC_OVERRIDE
                - KILL
          volumeMounts:
            - name: sandbox-tmp
              mountPath: /tmp
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 15
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 30
      volumes:
        - name: sandbox-tmp
          emptyDir:
            sizeLimit: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: interview-platform
spec:
  selector:
    app: interview-platform
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
  type: ClusterIP
```

> **Note on Sticky Sessions:** Interactive Python notebooks keep stateful kernel subprocesses in memory per container instance (`session_id`). If running `replicas > 1`, configure session affinity / sticky cookies on your Ingress controller (e.g., NGINX `nginx.ingress.kubernetes.io/affinity: "cookie"`), or run `replicas: 1` per assessment event.

---

## 9. Verifying Sinks & Health

Before sending an interview link to candidates:

1. **Test delivery sinks locally or inside the container:**
   ```bash
   python -m backend.cli check-sinks
   # Or test specific sinks:
   python -m backend.cli check-sinks --sink s3,slack
   ```
2. **Verify the health endpoint:**
   ```bash
   curl -s https://your-deployment-url/health
   # Expected: {"status":"ok","mode":"candidate","app_title":"..."}
   ```
3. **Verify Admin Studio lockdown (when `ADMIN_PASSWORD` is unset):**
   ```bash
   curl -i https://your-deployment-url/api/admin/status
   # Expected: HTTP 404
   ```
4. **Verify candidate template resolution:**
   ```bash
   curl -s https://your-deployment-url/api/public/templates/default
   ```
