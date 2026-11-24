/**
 * API client for the BigBank FastAPI backend.
 *
 * - Admin endpoints live under `/api/admin` and use a bearer token issued by
 *   `POST /api/admin/auth/login` (stored in localStorage). In local mode with
 *   no admin password configured, the backend issues an empty token and the
 *   studio is open.
 * - Candidate endpoints live under `/api/public`; the signed session token is
 *   carried inside request bodies / query params, per the backend contract.
 */
import type {
  AdminLoginResponse,
  AdminStatus,
  DeleteResponse,
  DeployBundlePayload,
  DeployBundleResponse,
  DeployStatus,
  DuplicateStrategy,
  ExportFormat,
  FinishRequest,
  FinishResponse,
  ImportCommitResponse,
  ImportPreviewResponse,
  ManualGradePayload,
  MaskedSettings,
  NotebookExecResult,
  NotebookExecuteRequest,
  NotebookInstallRequest,
  NotebookInstallResult,
  NotebookRestartRequest,
  NotebookRestartResult,
  ProgressRequest,
  ProgressResponse,
  PublicLoginRequest,
  PublicLoginResponse,
  PublicTemplateMetadata,
  Question,
  QuestionCreatePayload,
  QuestionListParams,
  QuestionUpdatePayload,
  RedeliverResponse,
  RegeneratePdfResponse,
  SearchResponse,
  SettingsUpdatePayload,
  Submission,
  SubmissionSummary,
  TagSummary,
  Template,
  TemplateClonePayload,
  TemplateCreatePayload,
  TemplatePreviewResponse,
  TemplateUpdatePayload,
  TestSettingResponse,
} from '../types/api';

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

const ADMIN_TOKEN_KEY = 'bigbank_admin_token';
const CANDIDATE_TOKEN_KEY = 'bigbank_candidate_token';

let adminTokenMemory: string | null = null;
let candidateTokenMemory: string | null = null;

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode); in-memory copy still works
  }
}

function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getAdminToken(): string | null {
  if (adminTokenMemory) return adminTokenMemory;
  adminTokenMemory = storageGet(ADMIN_TOKEN_KEY);
  return adminTokenMemory;
}

export function setAdminToken(token: string | null): void {
  adminTokenMemory = token || null;
  if (token) storageSet(ADMIN_TOKEN_KEY, token);
  else storageRemove(ADMIN_TOKEN_KEY);
}

export function getCandidateToken(): string | null {
  if (candidateTokenMemory) return candidateTokenMemory;
  candidateTokenMemory = storageGet(CANDIDATE_TOKEN_KEY);
  return candidateTokenMemory;
}

export function setCandidateToken(token: string): void {
  candidateTokenMemory = token;
  storageSet(CANDIDATE_TOKEN_KEY, token);
}

export function clearCandidateToken(): void {
  candidateTokenMemory = null;
  storageRemove(CANDIDATE_TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function parseError(response: Response): Promise<ApiError> {
  let detail = `Request failed with status ${response.status}.`;
  try {
    const body = await response.json();
    if (body && typeof body.detail === 'string') {
      detail = body.detail;
    } else if (body && body.detail !== undefined) {
      detail = JSON.stringify(body.detail);
    } else if (body && typeof body.message === 'string') {
      detail = body.message;
    }
  } catch {
    try {
      const text = await response.text();
      if (text) detail = text;
    } catch {
      // keep default detail
    }
  }
  return new ApiError(response.status, detail);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  admin?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.admin) {
    const token = getAdminToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (options.admin) {
    const token = getAdminToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(path, { method: options.method ?? 'GET', headers });
  if (!response.ok) throw await parseError(response);
  return response.blob();
}

async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getAdminToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(path, { method: 'POST', headers, body: form });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export interface ExportQuestionsParams {
  format: ExportFormat;
  tags?: string[];
  template_id?: number;
}

export interface CommitImportOptions {
  duplicate_strategy?: DuplicateStrategy;
  skip_invalid?: boolean;
}

const admin = {
  async getStatus(): Promise<AdminStatus> {
    return request<AdminStatus>('/api/admin/status', { admin: true });
  },

  async login(password: string): Promise<AdminLoginResponse> {
    const res = await request<AdminLoginResponse>('/api/admin/auth/login', {
      method: 'POST',
      body: { password },
    });
    setAdminToken(res.token || null);
    return res;
  },

  logout(): void {
    setAdminToken(null);
  },

  async listQuestions(params: QuestionListParams = {}): Promise<Question[]> {
    const query = buildQuery({
      search: params.search,
      tags: params.tags && params.tags.length ? params.tags.join(',') : undefined,
      tag_match: params.tag_match,
      format: params.format || undefined,
      difficulty: params.difficulty || undefined,
      active_only: params.active_only,
    });
    return request<Question[]>(`/api/admin/questions${query}`, { admin: true });
  },

  async createQuestion(payload: QuestionCreatePayload): Promise<Question> {
    return request<Question>('/api/admin/questions', {
      method: 'POST',
      body: payload,
      admin: true,
    });
  },

  async updateQuestion(id: number, payload: QuestionUpdatePayload): Promise<Question> {
    return request<Question>(`/api/admin/questions/${id}`, {
      method: 'PUT',
      body: payload,
      admin: true,
    });
  },

  async deleteQuestion(id: number): Promise<DeleteResponse> {
    return request<DeleteResponse>(`/api/admin/questions/${id}`, {
      method: 'DELETE',
      admin: true,
    });
  },

  async listTags(): Promise<TagSummary[]> {
    return request<TagSummary[]>('/api/admin/tags', { admin: true });
  },

  async previewImportFile(file: File): Promise<ImportPreviewResponse> {
    const form = new FormData();
    form.append('file', file);
    return requestForm<ImportPreviewResponse>('/api/admin/questions/import/preview', form);
  },

  async commitImportFile(
    file: File,
    options: CommitImportOptions = {},
  ): Promise<ImportCommitResponse> {
    const form = new FormData();
    form.append('file', file);
    form.append('duplicate_strategy', options.duplicate_strategy ?? 'skip');
    form.append('skip_invalid', String(options.skip_invalid ?? false));
    return requestForm<ImportCommitResponse>('/api/admin/questions/import/commit', form);
  },

  async exportQuestions(params: ExportQuestionsParams): Promise<Blob> {
    const query = buildQuery({
      format: params.format,
      tags: params.tags && params.tags.length ? params.tags.join(',') : undefined,
      template_id: params.template_id,
    });
    return requestBlob(`/api/admin/questions/export${query}`, { admin: true });
  },

  async downloadSampleQuestions(format: ExportFormat): Promise<Blob> {
    return requestBlob(`/api/admin/questions/sample${buildQuery({ format })}`, {
      admin: true,
    });
  },

  async listTemplates(): Promise<Template[]> {
    return request<Template[]>('/api/admin/templates', { admin: true });
  },

  async getTemplate(id: number): Promise<Template> {
    return request<Template>(`/api/admin/templates/${id}`, { admin: true });
  },

  async createTemplate(payload: TemplateCreatePayload): Promise<Template> {
    return request<Template>('/api/admin/templates', {
      method: 'POST',
      body: payload,
      admin: true,
    });
  },

  async updateTemplate(id: number, payload: TemplateUpdatePayload): Promise<Template> {
    return request<Template>(`/api/admin/templates/${id}`, {
      method: 'PUT',
      body: payload,
      admin: true,
    });
  },

  async deleteTemplate(id: number): Promise<DeleteResponse> {
    return request<DeleteResponse>(`/api/admin/templates/${id}`, {
      method: 'DELETE',
      admin: true,
    });
  },

  async cloneTemplate(id: number, payload: TemplateClonePayload = {}): Promise<Template> {
    return request<Template>(`/api/admin/templates/${id}/clone`, {
      method: 'POST',
      body: payload,
      admin: true,
    });
  },

  async previewTemplate(id: number): Promise<TemplatePreviewResponse> {
    return request<TemplatePreviewResponse>(`/api/admin/templates/${id}/preview`, {
      method: 'POST',
      body: {},
      admin: true,
    });
  },

  async listResults(): Promise<SubmissionSummary[]> {
    return request<SubmissionSummary[]>('/api/admin/results', { admin: true });
  },

  async getResult(id: string | number): Promise<Submission> {
    return request<Submission>(`/api/admin/results/${id}`, { admin: true });
  },

  async overrideGrade(
    id: string | number,
    payload: ManualGradePayload,
  ): Promise<Submission> {
    return request<Submission>(`/api/admin/results/${id}/grade`, {
      method: 'PATCH',
      body: payload,
      admin: true,
    });
  },

  async regenerateResultPdf(id: string | number): Promise<RegeneratePdfResponse> {
    return request<RegeneratePdfResponse>(`/api/admin/results/${id}/regenerate-pdf`, {
      method: 'POST',
      body: {},
      admin: true,
    });
  },

  async redeliverResult(id: string | number): Promise<RedeliverResponse> {
    return request<RedeliverResponse>(`/api/admin/results/${id}/redeliver`, {
      method: 'POST',
      body: {},
      admin: true,
    });
  },

  async fetchResultPdfBlob(id: string | number): Promise<Blob> {
    return requestBlob(`/api/admin/results/${id}/pdf`, { admin: true });
  },

  async getSettings(): Promise<MaskedSettings> {
    return request<MaskedSettings>('/api/admin/settings', { admin: true });
  },

  async updateSettings(payload: SettingsUpdatePayload): Promise<MaskedSettings> {
    return request<MaskedSettings>('/api/admin/settings', {
      method: 'PUT',
      body: payload,
      admin: true,
    });
  },

  async testSetting(target: string): Promise<TestSettingResponse> {
    return request<TestSettingResponse>('/api/admin/settings/test', {
      method: 'POST',
      body: { target },
      admin: true,
    });
  },

  async getDeployStatus(): Promise<DeployStatus> {
    return request<DeployStatus>('/api/admin/deploy/status', { admin: true });
  },

  async buildDeployBundle(payload: DeployBundlePayload = {}): Promise<DeployBundleResponse> {
    return request<DeployBundleResponse>('/api/admin/deploy/bundle', {
      method: 'POST',
      body: payload,
      admin: true,
    });
  },
};

// ---------------------------------------------------------------------------
// Public (candidate) API
// ---------------------------------------------------------------------------

const publicApi = {
  async getDefaultTemplate(): Promise<PublicTemplateMetadata> {
    return request<PublicTemplateMetadata>('/api/public/templates/default');
  },

  async getTemplateBySlug(slug: string): Promise<PublicTemplateMetadata> {
    return request<PublicTemplateMetadata>(
      `/api/public/templates/${encodeURIComponent(slug)}`,
    );
  },

  async login(payload: PublicLoginRequest): Promise<PublicLoginResponse> {
    const res = await request<PublicLoginResponse>('/api/public/login', {
      method: 'POST',
      body: payload,
    });
    if (res.session_token) setCandidateToken(res.session_token);
    return res;
  },

  async saveProgress(payload: ProgressRequest): Promise<ProgressResponse> {
    return request<ProgressResponse>('/api/public/progress', {
      method: 'POST',
      body: payload,
    });
  },

  async finish(payload: FinishRequest): Promise<FinishResponse> {
    return request<FinishResponse>('/api/public/finish', {
      method: 'POST',
      body: payload,
    });
  },

  async executeNotebook(payload: NotebookExecuteRequest): Promise<NotebookExecResult> {
    return request<NotebookExecResult>('/api/public/notebook/execute', {
      method: 'POST',
      body: payload,
    });
  },

  async installNotebookPackage(
    payload: NotebookInstallRequest,
  ): Promise<NotebookInstallResult> {
    return request<NotebookInstallResult>('/api/public/notebook/install', {
      method: 'POST',
      body: payload,
    });
  },

  async restartNotebook(payload: NotebookRestartRequest): Promise<NotebookRestartResult> {
    return request<NotebookRestartResult>('/api/public/notebook/restart', {
      method: 'POST',
      body: payload,
    });
  },

  async search(q: string, sessionToken?: string | null): Promise<SearchResponse> {
    const query = buildQuery({
      q,
      session_token: sessionToken ?? getCandidateToken() ?? undefined,
    });
    return request<SearchResponse>(`/api/public/search${query}`);
  },

  getProxyUrl(url: string, sessionToken?: string | null): string {
    const query = buildQuery({
      url,
      session_token: sessionToken ?? getCandidateToken() ?? undefined,
    });
    return `/api/public/proxy${query}`;
  },
};

export const api = {
  admin,
  public: publicApi,
};

export default api;
