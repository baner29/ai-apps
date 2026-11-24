/**
 * Canonical TypeScript interfaces matching the FastAPI backend schemas verbatim
 * (backend/routers/public.py, backend/routers/admin.py, backend/db/repository.py,
 * backend/config.py, backend/services/*).
 */

// ---------------------------------------------------------------------------
// Shared Primitives & Enums
// ---------------------------------------------------------------------------

export type AppMode = 'local' | 'candidate';
export type QuestionFormat = 'mcq' | 'text' | 'code' | 'notebook';
export type QuestionDifficulty = 'easy' | 'medium' | 'hard';
export type SelectionMode = 'curated' | 'random_pool';
export type OpenBookPolicy = 'none' | 'medium_hard' | 'all';
export type TagMatchMode = 'any' | 'all';
export type DuplicateStrategy = 'skip' | 'overwrite';
export type ExportFormat = 'yaml' | 'json';
export type SubmissionStatus =
  | 'in_progress'
  | 'evaluating'
  | 'completed'
  | 'needs_review'
  | 'failed';

export interface HealthResponse {
  status: string;
  mode: AppMode;
  app_title: string;
}

export interface DeleteResponse {
  deleted: boolean;
  id: number;
}

// ---------------------------------------------------------------------------
// Questions & Tags (Admin Catalog)
// ---------------------------------------------------------------------------

export interface Question {
  id: number;
  external_key: string | null;
  title: string;
  prompt: string;
  format: QuestionFormat;
  difficulty: QuestionDifficulty;
  options: string[];
  answer_indices: number[];
  code_language: string | null;
  starter_code: string | null;
  allow_execution: boolean;
  expected_answer: string;
  evaluation_rubric: string;
  default_points: number;
  active: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface QuestionCreatePayload {
  external_key?: string | null;
  title?: string | null;
  prompt: string;
  format?: QuestionFormat;
  difficulty?: QuestionDifficulty;
  options?: string[] | null;
  answer_indices?: number[] | null;
  code_language?: string | null;
  starter_code?: string | unknown[] | Record<string, unknown> | null;
  allow_execution?: boolean | null;
  expected_answer?: string;
  evaluation_rubric?: string;
  default_points?: number;
  active?: boolean;
  tags?: string[];
}

export type QuestionUpdatePayload = Partial<QuestionCreatePayload>;

export interface QuestionListParams {
  search?: string;
  tags?: string[];
  tag_match?: TagMatchMode;
  format?: QuestionFormat | '';
  difficulty?: QuestionDifficulty | '';
  active_only?: boolean;
}

export interface TagSummary {
  id: number;
  name: string;
  question_count: number;
}

// ---------------------------------------------------------------------------
// Templates & Per-Template Question Overrides
// ---------------------------------------------------------------------------

export interface TemplateRandomRules {
  tags?: string[];
  match?: TagMatchMode;
  total?: number | null;
  difficulty_counts?: Partial<Record<QuestionDifficulty, number>>;
}

export interface TemplateQuestionOverride {
  id?: number;
  question_id: number;
  position: number;
  points_override: number | null;
  expected_answer_override: string | null;
  rubric_override: string | null;
}

export interface Template {
  id: number;
  slug: string;
  name: string;
  role_title: string;
  description: string;
  selection_mode: SelectionMode;
  random_rules: TemplateRandomRules | null;
  timer_minutes: number;
  open_book_policy: OpenBookPolicy;
  allow_code_execution: boolean;
  allow_package_install: boolean;
  access_code: string;
  summary_dimensions: string[];
  is_default: boolean;
  questions: TemplateQuestionOverride[];
  created_at: string;
  updated_at: string;
}

export interface TemplateCreatePayload {
  slug: string;
  name: string;
  role_title: string;
  description?: string;
  selection_mode?: SelectionMode;
  random_rules?: TemplateRandomRules | null;
  timer_minutes?: number;
  open_book_policy?: OpenBookPolicy;
  allow_code_execution?: boolean;
  allow_package_install?: boolean;
  access_code?: string;
  summary_dimensions?: string[];
  is_default?: boolean;
  questions?: Array<{
    question_id: number;
    position?: number;
    points_override?: number | null;
    expected_answer_override?: string | null;
    rubric_override?: string | null;
  }>;
}

export type TemplateUpdatePayload = Partial<TemplateCreatePayload>;

export interface TemplateClonePayload {
  slug?: string | null;
  name?: string | null;
}

export interface ResolvedTemplateQuestion extends Question {
  position: number;
  points_override: number | null;
  expected_answer_override: string | null;
  rubric_override: string | null;
  effective_points: number;
  effective_expected_answer: string;
  effective_rubric: string;
}

export interface TemplatePreviewResponse {
  template: Template;
  questions: ResolvedTemplateQuestion[];
  question_count: number;
  total_points: number;
}

// ---------------------------------------------------------------------------
// Bulk Import / Export
// ---------------------------------------------------------------------------

export interface ImportNormalizedQuestion {
  external_key: string | null;
  title: string;
  prompt: string;
  format: QuestionFormat;
  difficulty: QuestionDifficulty;
  options: string[];
  answer_indices: number[];
  code_language: string | null;
  starter_code: string | unknown[] | Record<string, unknown> | null;
  allow_execution: boolean;
  expected_answer: string;
  evaluation_rubric: string;
  default_points: number;
  active: boolean;
  tags: string[];
}

export interface ImportErrorItem {
  index: number;
  external_key: string | null;
  title: string;
  error: string;
}

export type ImportItemStatus = 'new' | 'duplicate' | 'invalid';
export type ImportMatchReason =
  | 'external_key'
  | 'prompt'
  | 'in_batch_external_key'
  | 'in_batch_prompt'
  | null;

export interface ImportPreviewItem {
  index: number;
  status: ImportItemStatus;
  match_reason: ImportMatchReason;
  existing_id: number | null;
  question: ImportNormalizedQuestion | null;
  errors: string[];
}

export interface ImportPreviewResponse {
  valid_count: number;
  new_count: number;
  duplicate_count: number;
  invalid_count: number;
  items: ImportPreviewItem[];
  errors: ImportErrorItem[];
}

export interface ImportCommitResponse {
  created: number;
  updated: number;
  skipped: number;
  errors: ImportErrorItem[];
}

// ---------------------------------------------------------------------------
// Submissions, Evaluations, Manual Grading & Delivery
// ---------------------------------------------------------------------------

export interface AnswerEvaluation {
  score: number;
  max_points: number;
  correctness_pct: number;
  rubric_breakdown: string[];
  feedback: string;
  needs_manual_review: boolean;
  manually_overridden?: boolean;
}

export interface EvaluatedAnswer {
  question_id: number;
  title?: string;
  question_text?: string;
  question_format?: QuestionFormat;
  difficulty?: QuestionDifficulty;
  tags?: string[];
  options?: string[];
  expected_answer?: string;
  scoring_criteria?: string;
  candidate_answer?: unknown;
  candidate_answer_text?: string;
  attempted?: boolean;
  evaluation?: AnswerEvaluation;
  // In-progress drafts may store raw AnswerItem shape
  answer?: unknown;
}

export interface SubmissionSummary {
  overall_feedback: string;
  strengths: string;
  areas_of_opportunity: string;
  dimensions: Record<string, string>;
}

export interface DeliveryLogEntry {
  sink: string;
  ok: boolean;
  phase?: 'backup' | 'storage' | 'notify';
  redeliver?: boolean;
  timestamp?: string;
  uri?: string | null;
  url?: string | null;
  detail?: string | null;
  error?: string | null;
}

export interface Submission {
  id: string;
  template_id: number | null;
  template_name: string;
  role_title: string;
  candidate_name: string;
  candidate_email: string | null;
  status: SubmissionStatus;
  started_at: string;
  submitted_at: string | null;
  duration_seconds: number | null;
  final_score: number | null;
  max_score: number | null;
  score_percentage: number | null;
  answers: EvaluatedAnswer[];
  summary: SubmissionSummary | null;
  delivery_log: DeliveryLogEntry[];
  pdf_path: string | null;
}

export interface ManualGradePayload {
  question_id: number;
  score: number;
  feedback?: string | null;
  rubric_breakdown?: string[] | null;
}

export interface RegeneratePdfResponse {
  ok: boolean;
  submission_id: string;
  pdf_path: string | null;
  size_bytes: number;
}

export interface DeliveryOutcome {
  storage: Array<{
    sink: string;
    ok: boolean;
    uri: string | null;
    url: string | null;
    error: string | null;
  }>;
  notifications: Array<{
    sink: string;
    ok: boolean;
    detail: string | null;
    error: string | null;
  }>;
  local_pdf_path: string | null;
}

export interface RedeliverResponse {
  ok: boolean;
  delivery: DeliveryOutcome;
  delivery_log: DeliveryLogEntry[];
}

// ---------------------------------------------------------------------------
// Public Candidate Portal
// ---------------------------------------------------------------------------

export interface PublicTemplateMetadata {
  id: number;
  slug: string;
  name: string;
  role_title: string;
  description: string;
  timer_minutes: number;
  open_book_policy: OpenBookPolicy;
  allow_code_execution: boolean;
  allow_package_install: boolean;
  requires_access_code: boolean;
  question_count: number;
  app_title: string;
}

export interface CandidateQuestion {
  id: number;
  title: string;
  prompt: string;
  format: QuestionFormat;
  difficulty: QuestionDifficulty;
  options: string[];
  multi_select: boolean;
  code_language: string | null;
  starter_code: string | null;
  allow_execution: boolean;
  points: number;
  tags: string[];
  position: number;
  open_book_allowed: boolean;
}

export interface PublicLoginRequest {
  candidate_name: string;
  candidate_email?: string | null;
  access_code?: string;
  slug?: string | null;
}

export interface PublicLoginResponse {
  session_token: string;
  candidate_name: string;
  candidate_email: string | null;
  template: PublicTemplateMetadata;
  questions: CandidateQuestion[];
  python_version: string;
}

export interface AnswerItem {
  question_id: number;
  answer: unknown;
}

export interface ProgressRequest {
  session_token: string;
  answers: AnswerItem[] | Record<string, unknown>;
  candidate_name?: string | null;
}

export interface ProgressResponse {
  ok: boolean;
  saved_at: string;
}

export interface FinishRequest {
  session_token: string;
  candidate_name?: string | null;
  candidate_email?: string | null;
  slug?: string | null;
  answers: AnswerItem[];
  duration_seconds?: number | null;
}

export interface FinishResponse {
  status: 'submitted';
  submission_id: string;
  candidate_name: string;
  submitted_at: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Notebook Sandbox & Open-Book Search
// ---------------------------------------------------------------------------

export interface NotebookExecuteRequest {
  session_token: string;
  code: string;
}

export interface NotebookExecResult {
  ok: boolean;
  execution_count: number;
  stdout: string;
  stderr: string;
  html: string | null;
  image_png_base64: string | null;
  error: string | null;
  duration_ms: number;
}

export interface NotebookInstallRequest {
  session_token: string;
  package?: string | null;
  spec?: string | null;
}

export interface NotebookInstallResult {
  ok: boolean;
  package: string;
  size_mb: number;
  output: string;
  error: string | null;
}

export interface NotebookRestartRequest {
  session_token: string;
}

export interface NotebookRestartResult {
  ok: boolean;
  session_id: string;
  restarted: boolean;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResultItem[];
  search_url: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Admin Auth, Settings & Deployment
// ---------------------------------------------------------------------------

export interface AdminStatus {
  mode: AppMode;
  read_only: boolean;
  auth_required: boolean;
  authenticated: boolean;
  app_title: string;
}

export interface AdminLoginRequest {
  password: string;
}

export interface AdminLoginResponse {
  token: string;
  authenticated: boolean;
  mode: AppMode;
  read_only: boolean;
}

export type SecretSettingField =
  | 'admin_password'
  | 'llm_api_key'
  | 'smtp_password'
  | 'slack_bot_token'
  | 'webhook_secret'
  | 'azure_storage_connection_string'
  | 'aws_secret_access_key';

export interface MaskedSettings {
  // Runtime mode & access
  app_mode: AppMode;
  admin_password: string;
  admin_password_set: boolean;
  app_title: string;
  database_path: string;
  bundle_path: string;
  runtime_db_path: string;
  auto_seed_examples: boolean;
  access_code: string;

  // Provider-agnostic LLM
  llm_provider: string;
  llm_model: string;
  llm_api_key: string;
  llm_api_key_set: boolean;
  llm_base_url: string;
  vertexai_project: string;
  vertexai_location: string;
  azure_api_version: string;
  aws_region: string;

  // Storage sinks
  storage_sinks: string;
  local_reports_dir: string;
  s3_bucket: string;
  s3_prefix: string;
  s3_region: string;
  s3_endpoint_url: string;
  aws_access_key_id?: string;
  aws_secret_access_key: string;
  aws_secret_access_key_set: boolean;
  gcs_bucket: string;
  gcs_prefix: string;
  azure_storage_connection_string: string;
  azure_storage_connection_string_set: boolean;
  azure_storage_account_url: string;
  azure_storage_container: string;
  azure_storage_prefix: string;
  storage_presigned_urls: boolean;
  storage_presigned_ttl_seconds: number;

  // Notification sinks
  notify_sinks: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  smtp_password_set: boolean;
  smtp_from: string;
  smtp_to: string;
  smtp_use_tls: boolean;
  slack_webhook_url: string;
  slack_bot_token: string;
  slack_bot_token_set: boolean;
  slack_channel_id: string;
  teams_webhook_url: string;
  webhook_url: string;
  webhook_secret: string;
  webhook_secret_set: boolean;
  webhook_include_pdf_base64: boolean;

  // Notebook sandbox guardrails
  sandbox_max_package_mb: number;
  sandbox_max_disk_mb: number;
  sandbox_cell_timeout_seconds: number;
  sandbox_max_memory_mb: number;
  sandbox_idle_timeout_minutes: number;
  sandbox_os_user: string;
  sandbox_banned_packages: string;
}

export interface SettingsUpdatePayload
  extends Partial<
    Omit<
      MaskedSettings,
      | 'app_mode'
      | 'database_path'
      | 'bundle_path'
      | 'runtime_db_path'
      | 'sandbox_os_user'
      | 'admin_password_set'
      | 'llm_api_key_set'
      | 'smtp_password_set'
      | 'slack_bot_token_set'
      | 'webhook_secret_set'
      | 'azure_storage_connection_string_set'
      | 'aws_secret_access_key_set'
    >
  > {
  clear_secrets?: SecretSettingField[];
}

export interface TestSettingPayload {
  target: string;
}

export interface TestSettingResponse {
  ok: boolean;
  detail: string;
  sink?: string;
  provider?: string;
  model?: string;
}

export interface DeploySnippets {
  docker: string;
  cloud_run: string;
  aws_app_runner: string;
  azure_container_apps: string;
  fly_io: string;
}

export interface DeployStatus {
  bundle_exists: boolean;
  has_external_sink: boolean;
  llm_configured: boolean;
  warnings: string[];
  snippets: DeploySnippets;
}

export interface DeployBundlePayload {
  template_slugs?: string[] | null;
  output_path?: string | null;
}

export interface DeployBundleResponse {
  output_path: string;
  templates_count: number;
  questions_count: number;
  tags_count: number;
  size_bytes: number;
  template_slugs: string[];
  readiness: DeployStatus;
}
