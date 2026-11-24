import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Bell,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  HardDrive,
  KeyRound,
  Lock,
  PlugZap,
  RotateCcw,
  Save,
  Shield,
  Sliders,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  MaskedSettings,
  SecretSettingField,
  SettingsUpdatePayload,
  TestSettingResponse,
} from '../../types/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../../components/ui';
import { useAdminContext } from './AdminLayout';
import { copyTextToClipboard } from './TemplatesPage';

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

type SettingsTabId = 'ai' | 'storage' | 'notify' | 'sandbox' | 'general';

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string; icon: typeof Bot }> = [
  { id: 'ai', label: 'AI Provider', icon: Bot },
  { id: 'storage', label: 'Storage Sinks', icon: HardDrive },
  { id: 'notify', label: 'Notification Sinks', icon: Bell },
  { id: 'sandbox', label: 'Notebook Sandbox', icon: Shield },
  { id: 'general', label: 'General & Access', icon: Sliders },
];

const LLM_PROVIDERS = [
  { value: 'none', label: 'None (Manual Review Fallback)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'gemini', label: 'Google Gemini (API Key)' },
  { value: 'vertex_ai', label: 'Google Vertex AI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'bedrock', label: 'AWS Bedrock' },
  { value: 'ollama', label: 'Ollama (Local / Self-Hosted)' },
  { value: 'openai_compatible', label: 'OpenAI-Compatible (vLLM / LiteLLM Proxy)' },
] as const;

const MODEL_PLACEHOLDERS: Record<string, string> = {
  none: 'gpt-4o-mini',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-pro',
  vertex_ai: 'gemini-2.5-pro',
  azure: '<deployment-name>',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  ollama: 'llama3.1',
  openai_compatible: '<model-name>',
};

const STORAGE_SINK_OPTIONS = [
  { id: 'local', label: 'Local Disk', desc: 'Save PDF & JSON reports locally (great for dev).' },
  { id: 's3', label: 'Amazon S3 / R2 / MinIO', desc: 'S3-compatible object storage via boto3.' },
  { id: 'gcs', label: 'Google Cloud Storage', desc: 'GCS bucket via ADC or service account.' },
  { id: 'azure_blob', label: 'Azure Blob Storage', desc: 'Azure container via conn string or Managed Identity.' },
] as const;

const NOTIFY_SINK_OPTIONS = [
  { id: 'smtp', label: 'SMTP Email', desc: 'Emails summary + attaches PDF directly.' },
  { id: 'slack', label: 'Slack', desc: 'Webhook summary or Bot token PDF upload.' },
  { id: 'teams', label: 'Microsoft Teams', desc: 'Adaptive Card with score & report links.' },
  { id: 'webhook', label: 'Generic Webhook', desc: 'Signed HTTP POST with JSON (+ optional PDF).' },
] as const;

function parseCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function toggleCsvItem(raw: string, item: string): string {
  const list = parseCsvList(raw);
  const exists = list.includes(item);
  const next = exists ? list.filter((x) => x !== item) : [...list, item];
  return next.join(',');
}

// ---------------------------------------------------------------------------
// Masked Secret Field Sub-Component
// ---------------------------------------------------------------------------

interface SecretInputProps {
  field: SecretSettingField;
  label: string;
  isSet: boolean;
  maskedPreview: string;
  draftValue: string;
  markedForClear: boolean;
  disabled: boolean;
  placeholder?: string;
  hint?: string;
  onDraftChange: (val: string) => void;
  onToggleClear: () => void;
}

function SecretInput({
  label,
  isSet,
  maskedPreview,
  draftValue,
  markedForClear,
  disabled,
  placeholder,
  hint,
  onDraftChange,
  onToggleClear,
}: SecretInputProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-300">{label}</span>
          {markedForClear ? (
            <Badge variant="rose" size="sm">
              Will be cleared on save
            </Badge>
          ) : draftValue.trim() ? (
            <Badge variant="cyan" size="sm">
              New value staged
            </Badge>
          ) : isSet ? (
            <Badge variant="emerald" size="sm">
              <KeyRound className="h-2.5 w-2.5" aria-hidden="true" />
              Configured ({maskedPreview || '••••'})
            </Badge>
          ) : (
            <Badge variant="slate" size="sm">
              Not set
            </Badge>
          )}
        </div>

        {isSet && !disabled && (
          <button
            type="button"
            onClick={onToggleClear}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-ring',
              markedForClear
                ? 'text-cyan-300 hover:text-cyan-200'
                : 'text-rose-400 hover:text-rose-300'
            )}
          >
            {markedForClear ? (
              <>
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Keep existing
              </>
            ) : (
              <>
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Clear secret
              </>
            )}
          </button>
        )}
      </div>

      <Input
        type="password"
        autoComplete="new-password"
        disabled={disabled || markedForClear}
        aria-label={label}
        value={draftValue}
        placeholder={
          markedForClear
            ? 'Secret will be cleared when you save'
            : isSet
              ? 'Leave blank to keep existing secret, or type to replace…'
              : placeholder ?? 'Enter secret value…'
        }
        hint={hint}
        onChange={(e) => onDraftChange(e.target.value)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test Connection Inline Badge / Button
// ---------------------------------------------------------------------------

interface TestConnectionBarProps {
  target: string;
  label?: string;
  testingTarget: string | null;
  result: TestSettingResponse | undefined;
  onTest: (target: string) => void;
}

function TestConnectionBar({
  target,
  label = 'Test Connection',
  testingTarget,
  result,
  onTest,
}: TestConnectionBarProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={testingTarget === target}
          disabled={testingTarget !== null && testingTarget !== target}
          leftIcon={<PlugZap className="h-3.5 w-3.5" />}
          onClick={() => onTest(target)}
          title={`Test ${target} connection using active settings`}
        >
          {label}
        </Button>
        {result && (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-xs',
              result.ok ? 'text-emerald-300' : 'text-rose-300'
            )}
          >
            {result.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{result.detail}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsPage Component
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const { readOnly, refreshStatus } = useAdminContext();
  const { toast } = useToast();

  const [serverSettings, setServerSettings] = useState<MaskedSettings | null>(null);
  const [form, setForm] = useState<MaskedSettings | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Partial<Record<SecretSettingField, string>>>({});
  const [clearSecrets, setClearSecrets] = useState<Set<SecretSettingField>>(new Set());
  const [awsAccessKeyIdDraft, setAwsAccessKeyIdDraft] = useState('');
  const [clearAwsAccessKeyId, setClearAwsAccessKeyId] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [activeTab, setActiveTab] = useState<SettingsTabId>('ai');
  const [testingTarget, setTestingTarget] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestSettingResponse>>({});
  const [copiedEnv, setCopiedEnv] = useState(false);

  const tabIdPrefix = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.admin.getSettings();
      setServerSettings(data);
      setForm(data);
      setSecretDrafts({});
      setClearSecrets(new Set());
      setAwsAccessKeyIdDraft('');
      setClearAwsAccessKeyId(false);
    } catch (err: unknown) {
      setLoadError(err instanceof ApiError ? err.detail : 'Failed to load platform settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateField = <K extends keyof MaskedSettings>(key: K, value: MaskedSettings[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const updateSecretDraft = (field: SecretSettingField, val: string) => {
    setSecretDrafts((prev) => ({ ...prev, [field]: val }));
    if (val.trim()) {
      setClearSecrets((prev) => {
        if (!prev.has(field)) return prev;
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
    }
  };

  const toggleClearSecret = (field: SecretSettingField) => {
    setClearSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
        setSecretDrafts((drafts) => ({ ...drafts, [field]: '' }));
      }
      return next;
    });
  };

  // Keyboard navigation for accessible tablist (selection follows focus)
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % SETTINGS_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_TABS.length - 1;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      const nextTab = SETTINGS_TABS[nextIndex];
      setActiveTab(nextTab.id);
      const btn = tabRefs.current[nextIndex];
      btn?.focus();
      btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const handleSave = async () => {
    if (!form || readOnly) return;
    setSaving(true);
    try {
      const payload: SettingsUpdatePayload = {
        app_title: form.app_title,
        auto_seed_examples: form.auto_seed_examples,
        access_code: form.access_code,
        llm_provider: form.llm_provider,
        llm_model: form.llm_model,
        llm_base_url: form.llm_base_url,
        vertexai_project: form.vertexai_project,
        vertexai_location: form.vertexai_location,
        azure_api_version: form.azure_api_version,
        aws_region: form.aws_region,
        storage_sinks: form.storage_sinks,
        local_reports_dir: form.local_reports_dir,
        s3_bucket: form.s3_bucket,
        s3_prefix: form.s3_prefix,
        s3_region: form.s3_region,
        s3_endpoint_url: form.s3_endpoint_url,
        gcs_bucket: form.gcs_bucket,
        gcs_prefix: form.gcs_prefix,
        azure_storage_account_url: form.azure_storage_account_url,
        azure_storage_container: form.azure_storage_container,
        azure_storage_prefix: form.azure_storage_prefix,
        storage_presigned_urls: form.storage_presigned_urls,
        storage_presigned_ttl_seconds: Math.max(60, Number(form.storage_presigned_ttl_seconds) || 604800),
        notify_sinks: form.notify_sinks,
        smtp_host: form.smtp_host,
        smtp_port: Math.max(1, Number(form.smtp_port) || 587),
        smtp_user: form.smtp_user,
        smtp_from: form.smtp_from,
        smtp_to: form.smtp_to,
        smtp_use_tls: form.smtp_use_tls,
        slack_webhook_url: form.slack_webhook_url,
        slack_channel_id: form.slack_channel_id,
        teams_webhook_url: form.teams_webhook_url,
        webhook_url: form.webhook_url,
        webhook_include_pdf_base64: form.webhook_include_pdf_base64,
        sandbox_max_package_mb: Math.max(1, Number(form.sandbox_max_package_mb) || 25),
        sandbox_max_disk_mb: Math.max(10, Number(form.sandbox_max_disk_mb) || 150),
        sandbox_cell_timeout_seconds: Math.max(1, Number(form.sandbox_cell_timeout_seconds) || 15),
        sandbox_max_memory_mb: Math.max(64, Number(form.sandbox_max_memory_mb) || 512),
        sandbox_idle_timeout_minutes: Math.max(1, Number(form.sandbox_idle_timeout_minutes) || 15),
        sandbox_banned_packages: form.sandbox_banned_packages,
      };

      // Only send AWS_ACCESS_KEY_ID when explicitly entered or explicitly cleared
      // (backend get_masked_settings does not echo aws_access_key_id back on read).
      if (clearAwsAccessKeyId) {
        payload.aws_access_key_id = '';
      } else if (awsAccessKeyIdDraft.trim()) {
        payload.aws_access_key_id = awsAccessKeyIdDraft.trim();
      }

      // Attach non-empty secret drafts, and explicitly include '' for cleared secrets
      // so backend update_admin_settings visits the field in payload.items() and clears it.
      const secretFields: SecretSettingField[] = [
        'admin_password',
        'llm_api_key',
        'smtp_password',
        'slack_bot_token',
        'webhook_secret',
        'azure_storage_connection_string',
        'aws_secret_access_key',
      ];
      for (const sf of secretFields) {
        if (clearSecrets.has(sf)) {
          payload[sf] = '';
        } else {
          const draft = (secretDrafts[sf] ?? '').trim();
          if (draft) {
            payload[sf] = draft;
          }
        }
      }
      if (clearSecrets.size > 0) {
        payload.clear_secrets = Array.from(clearSecrets);
      }

      const updated = await api.admin.updateSettings(payload);
      setServerSettings(updated);
      setForm(updated);
      setSecretDrafts({});
      setClearSecrets(new Set());
      setAwsAccessKeyIdDraft('');
      setClearAwsAccessKeyId(false);
      toast({
        variant: 'success',
        title: 'Settings saved to local .env',
        description: 'Runtime configuration has been hot-reloaded.',
      });
      await refreshStatus();
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Failed to save settings',
        description: err instanceof ApiError ? err.detail : 'Unable to persist settings.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTestTarget = async (target: string) => {
    setTestingTarget(target);
    try {
      const res = await api.admin.testSetting(target);
      setTestResults((prev) => ({ ...prev, [target]: res }));
      toast({
        variant: res.ok ? 'success' : 'error',
        title: res.ok ? `${target.toUpperCase()} connection succeeded` : `${target.toUpperCase()} test failed`,
        description: res.detail,
      });
    } catch (err: unknown) {
      const detail = err instanceof ApiError ? err.detail : 'Connection test failed.';
      setTestResults((prev) => ({ ...prev, [target]: { ok: false, detail, sink: target } }));
      toast({ variant: 'error', title: `${target.toUpperCase()} test failed`, description: detail });
    } finally {
      setTestingTarget(null);
    }
  };

  // Safe Deployment .env Snippet Generator (NEVER leaks actual secret values)
  const deploymentEnvSnippet = useMemo(() => {
    if (!form) return '';
    const storageList = parseCsvList(form.storage_sinks).filter((s) => s !== 'local');
    const notifyList = parseCsvList(form.notify_sinks);
    const lines: string[] = [
      '# Deployment environment variables (secrets replaced with safe placeholders)',
      'APP_MODE=candidate',
      `APP_TITLE="${form.app_title.replace(/"/g, '\\"')}"`,
      '# ADMIN_PASSWORD=<OPTIONAL_READONLY_ADMIN_PASSWORD>',
    ];
    if (form.access_code.trim()) {
      lines.push(`ACCESS_CODE="${form.access_code.trim().replace(/"/g, '\\"')}"`);
    }

    lines.push('', '# AI Grading Provider');
    lines.push(`LLM_PROVIDER=${form.llm_provider}`);
    if (form.llm_provider !== 'none') {
      lines.push(`LLM_MODEL=${form.llm_model}`);
      if (form.llm_provider === 'vertex_ai') {
        if (form.vertexai_project.trim()) {
          lines.push(`VERTEXAI_PROJECT=${form.vertexai_project.trim()}`);
        }
        lines.push(`VERTEXAI_LOCATION=${form.vertexai_location.trim() || 'us-central1'}`);
        if (form.llm_base_url.trim()) {
          lines.push(`LLM_BASE_URL=${form.llm_base_url.trim()}`);
        }
      } else if (form.llm_provider === 'bedrock') {
        lines.push(`AWS_REGION=${form.aws_region.trim() || 'us-east-1'}`);
        lines.push('# AWS_ACCESS_KEY_ID=<OPTIONAL_IF_NOT_USING_IAM_ROLE>');
        lines.push('# AWS_SECRET_ACCESS_KEY=<OPTIONAL_IF_NOT_USING_IAM_ROLE>');
      } else if (form.llm_provider === 'azure') {
        lines.push(`LLM_BASE_URL=${form.llm_base_url.trim() || 'https://<your-resource>.openai.azure.com'}`);
        lines.push(`AZURE_API_VERSION=${form.azure_api_version.trim() || '2024-06-01'}`);
        lines.push('LLM_API_KEY=<YOUR_AZURE_OPENAI_API_KEY>');
      } else if (form.llm_provider === 'ollama') {
        lines.push(`LLM_BASE_URL=${form.llm_base_url.trim() || 'http://localhost:11434'}`);
      } else if (form.llm_provider === 'openai_compatible') {
        lines.push(`LLM_BASE_URL=${form.llm_base_url.trim() || 'http://localhost:8000/v1'}`);
        lines.push('# LLM_API_KEY=<OPTIONAL_ENDPOINT_API_KEY>');
      } else {
        lines.push('LLM_API_KEY=<YOUR_LLM_API_KEY>');
        if (form.llm_base_url.trim()) {
          lines.push(`LLM_BASE_URL=${form.llm_base_url.trim()}`);
        }
      }
    }

    lines.push('', '# Storage Sinks');
    lines.push(`STORAGE_SINKS=${storageList.join(',')}`);
    if (storageList.includes('s3')) {
      lines.push(`S3_BUCKET=${form.s3_bucket || '<YOUR_S3_BUCKET>'}`);
      lines.push(`S3_PREFIX=${form.s3_prefix || 'interviews'}`);
      lines.push(`S3_REGION=${form.s3_region || 'us-east-1'}`);
      if (form.s3_endpoint_url.trim()) {
        lines.push(`S3_ENDPOINT_URL=${form.s3_endpoint_url.trim()}`);
      }
      lines.push('AWS_ACCESS_KEY_ID=<YOUR_AWS_ACCESS_KEY_ID>');
      lines.push('AWS_SECRET_ACCESS_KEY=<YOUR_AWS_SECRET_ACCESS_KEY>');
    }
    if (storageList.includes('gcs')) {
      lines.push(`GCS_BUCKET=${form.gcs_bucket || '<YOUR_GCS_BUCKET>'}`);
      lines.push(`GCS_PREFIX=${form.gcs_prefix || 'interviews'}`);
    }
    if (storageList.includes('azure_blob')) {
      lines.push('AZURE_STORAGE_CONNECTION_STRING=<YOUR_AZURE_CONNECTION_STRING>');
      if (form.azure_storage_account_url.trim()) {
        lines.push(`AZURE_STORAGE_ACCOUNT_URL=${form.azure_storage_account_url.trim()}`);
      }
      lines.push(`AZURE_STORAGE_CONTAINER=${form.azure_storage_container || '<YOUR_CONTAINER>'}`);
      lines.push(`AZURE_STORAGE_PREFIX=${form.azure_storage_prefix || 'interviews'}`);
    }
    if (form.storage_presigned_urls) {
      lines.push('STORAGE_PRESIGNED_URLS=true');
      lines.push(`STORAGE_PRESIGNED_TTL_SECONDS=${form.storage_presigned_ttl_seconds}`);
    }

    lines.push('', '# Notification Sinks');
    lines.push(`NOTIFY_SINKS=${notifyList.join(',')}`);
    if (notifyList.includes('smtp')) {
      lines.push(`SMTP_HOST=${form.smtp_host || '<YOUR_SMTP_HOST>'}`);
      lines.push(`SMTP_PORT=${form.smtp_port}`);
      lines.push(`SMTP_USER=${form.smtp_user || '<YOUR_SMTP_USER>'}`);
      lines.push('SMTP_PASSWORD=<YOUR_SMTP_PASSWORD>');
      lines.push(`SMTP_FROM=${form.smtp_from || '<FROM_EMAIL>'}`);
      lines.push(`SMTP_TO=${form.smtp_to || '<HIRING_TEAM_EMAIL>'}`);
      lines.push(`SMTP_USE_TLS=${form.smtp_use_tls ? 'true' : 'false'}`);
    }
    if (notifyList.includes('slack')) {
      lines.push('SLACK_WEBHOOK_URL=<YOUR_SLACK_WEBHOOK_URL>');
      if (form.slack_channel_id.trim() || serverSettings?.slack_bot_token_set) {
        lines.push('SLACK_BOT_TOKEN=<YOUR_SLACK_BOT_TOKEN>');
        lines.push(`SLACK_CHANNEL_ID=${form.slack_channel_id || '<CHANNEL_ID>'}`);
      }
    }
    if (notifyList.includes('teams')) {
      lines.push('TEAMS_WEBHOOK_URL=<YOUR_TEAMS_WEBHOOK_URL>');
    }
    if (notifyList.includes('webhook')) {
      lines.push(`WEBHOOK_URL=${form.webhook_url || '<YOUR_WEBHOOK_URL>'}`);
      lines.push('WEBHOOK_SECRET=<YOUR_WEBHOOK_HMAC_SECRET>');
      lines.push(`WEBHOOK_INCLUDE_PDF_BASE64=${form.webhook_include_pdf_base64 ? 'true' : 'false'}`);
    }

    lines.push('', '# Notebook Sandbox Guardrails');
    lines.push(`SANDBOX_MAX_PACKAGE_MB=${form.sandbox_max_package_mb}`);
    lines.push(`SANDBOX_MAX_DISK_MB=${form.sandbox_max_disk_mb}`);
    lines.push(`SANDBOX_CELL_TIMEOUT_SECONDS=${form.sandbox_cell_timeout_seconds}`);
    lines.push(`SANDBOX_MAX_MEMORY_MB=${form.sandbox_max_memory_mb}`);
    lines.push(`SANDBOX_IDLE_TIMEOUT_MINUTES=${form.sandbox_idle_timeout_minutes}`);
    if (form.sandbox_banned_packages.trim()) {
      lines.push(`SANDBOX_BANNED_PACKAGES="${form.sandbox_banned_packages.trim()}"`);
    }

    return lines.join('\n');
  }, [form, serverSettings?.slack_bot_token_set]);

  const handleCopySnippet = async () => {
    const ok = await copyTextToClipboard(deploymentEnvSnippet);
    if (ok) {
      setCopiedEnv(true);
      toast({
        variant: 'success',
        title: 'Deployment .env snippet copied',
        description: 'All secret fields use safe placeholders.',
      });
      window.setTimeout(() => setCopiedEnv(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24">
        <Spinner size="lg" label="Loading platform settings" />
        <p className="text-sm text-slate-400">Loading platform settings…</p>
      </div>
    );
  }

  if (loadError || !form || !serverSettings) {
    return (
      <Alert variant="error" title="Could not load settings">
        <div className="flex items-center justify-between gap-3">
          <span>{loadError ?? 'Unexpected error loading settings.'}</span>
          <Button variant="secondary" size="sm" onClick={() => void loadSettings()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  const enabledStorageSinks = new Set(parseCsvList(form.storage_sinks));
  const enabledNotifySinks = new Set(parseCsvList(form.notify_sinks));

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            Integrations & Settings
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Configure your AI grading provider, cloud storage and notification sinks, and notebook
            sandbox limits. Secrets are masked and never stored in SQLite.
          </p>
        </div>

        <Button
          variant="primary"
          size="md"
          loading={saving}
          disabled={readOnly}
          leftIcon={readOnly ? <Lock className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          onClick={() => void handleSave()}
          title={readOnly ? 'Saving to .env is disabled in candidate mode' : 'Write settings to local .env'}
        >
          Save to local .env
        </Button>
      </div>

      {/* Accessible Single-Row Horizontal Tablist */}
      <div className="border-b border-slate-800/90">
        <div
          role="tablist"
          aria-label="Platform settings sections"
          className="flex items-center gap-1 overflow-x-auto custom-scrollbar"
        >
          {SETTINGS_TABS.map((tab, idx) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            const tabElId = `${tabIdPrefix}-tab-${tab.id}`;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                id={tabElId}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                className={cn(
                  'relative flex-none inline-flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors focus-ring',
                  selected
                    ? 'text-indigo-300 after:content-[""] after:absolute after:inset-x-0 after:bottom-0 after:border-b-[3px] after:border-indigo-500'
                    : 'text-slate-400 hover:text-slate-100'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: AI Provider */}
      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-ai`}
        hidden={activeTab !== 'ai'}
      >
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle>Provider-Agnostic AI Grader</CardTitle>
                  <CardDescription>
                    Only the selected LLM provider adapter is invoked; all other providers remain
                    inactive. Choose None for deterministic MCQ grading + manual review fallback.
                  </CardDescription>
                </div>
                <Badge variant={form.llm_provider === 'none' ? 'amber' : 'emerald'} size="md" dot>
                  {form.llm_provider === 'none' ? 'Manual Fallback' : form.llm_provider}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Select
                  label="LLM Provider (LLM_PROVIDER)"
                  disabled={readOnly}
                  value={form.llm_provider}
                  onChange={(e) => updateField('llm_provider', e.target.value)}
                >
                  {LLM_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>

                {form.llm_provider !== 'none' && (
                  <Input
                    label={
                      form.llm_provider === 'azure'
                        ? 'Deployment Name (LLM_MODEL)'
                        : form.llm_provider === 'bedrock'
                          ? 'Bedrock Model ID (LLM_MODEL)'
                          : 'Model Name (LLM_MODEL)'
                    }
                    disabled={readOnly}
                    value={form.llm_model}
                    onChange={(e) => updateField('llm_model', e.target.value)}
                    placeholder={MODEL_PLACEHOLDERS[form.llm_provider] ?? 'gpt-4o-mini'}
                    hint={
                      form.llm_provider === 'azure'
                        ? 'Your Azure OpenAI deployment name.'
                        : form.llm_provider === 'bedrock'
                          ? 'AWS Bedrock model identifier (e.g., anthropic.claude-3-5-sonnet-20241022-v2:0).'
                          : 'Enter the native model ID for the selected provider.'
                    }
                  />
                )}
              </div>

              {form.llm_provider === 'none' && (
                <Alert variant="info" title="Automated AI Grading Disabled">
                  Multiple-choice questions still grade automatically. Open-ended, code, and
                  notebook responses will be marked for manual review in Admin Studio.
                </Alert>
              )}

              {form.llm_provider === 'vertex_ai' && (
                <>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Input
                      label="GCP Project ID (VERTEXAI_PROJECT)"
                      disabled={readOnly}
                      value={form.vertexai_project}
                      onChange={(e) => updateField('vertexai_project', e.target.value)}
                      placeholder="e.g., my-gcp-project-id"
                      hint="Required unless Application Default Credentials (gcloud ADC) provide a default project."
                    />
                    <Input
                      label="Vertex AI Location / Region (VERTEXAI_LOCATION)"
                      disabled={readOnly}
                      value={form.vertexai_location}
                      onChange={(e) => updateField('vertexai_location', e.target.value)}
                      placeholder="e.g., global or us-central1"
                      hint="Use 'global' for Gemini 3.x / preview models, or a region such as 'us-central1'."
                    />
                  </div>
                  <Input
                    label="Custom Vertex Endpoint URL (LLM_BASE_URL — Optional)"
                    disabled={readOnly}
                    value={form.llm_base_url}
                    onChange={(e) => updateField('llm_base_url', e.target.value)}
                    placeholder="Leave blank to use standard Google Vertex AI endpoints"
                    hint="Optional. Only needed for private VPC or custom proxy endpoints. Uses Google Cloud ADC / Workload Identity (no API key required)."
                  />
                </>
              )}

              {form.llm_provider === 'azure' && (
                <>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Input
                      label="Azure Endpoint URL (LLM_BASE_URL)"
                      disabled={readOnly}
                      value={form.llm_base_url}
                      onChange={(e) => updateField('llm_base_url', e.target.value)}
                      placeholder="https://your-resource.openai.azure.com"
                      hint="Required. Your Azure OpenAI resource endpoint."
                    />
                    <Input
                      label="Azure API Version (AZURE_API_VERSION)"
                      disabled={readOnly}
                      value={form.azure_api_version}
                      onChange={(e) => updateField('azure_api_version', e.target.value)}
                      placeholder="2024-06-01"
                      hint="Azure OpenAI REST API version query parameter."
                    />
                  </div>
                  <SecretInput
                    field="llm_api_key"
                    label="Azure OpenAI API Key (LLM_API_KEY)"
                    isSet={serverSettings.llm_api_key_set}
                    maskedPreview={serverSettings.llm_api_key}
                    draftValue={secretDrafts.llm_api_key ?? ''}
                    markedForClear={clearSecrets.has('llm_api_key')}
                    disabled={readOnly}
                    placeholder="Enter Azure OpenAI key…"
                    hint="Stored only in local .env (never in SQLite or deployment bundles). Save before testing new credentials."
                    onDraftChange={(val) => updateSecretDraft('llm_api_key', val)}
                    onToggleClear={() => toggleClearSecret('llm_api_key')}
                  />
                </>
              )}

              {form.llm_provider === 'bedrock' && (
                <>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Input
                      label="AWS Region (AWS_REGION)"
                      disabled={readOnly}
                      value={form.aws_region}
                      onChange={(e) => updateField('aws_region', e.target.value)}
                      placeholder="us-east-1"
                      hint="AWS region where your Bedrock model is enabled."
                    />
                    <Input
                      label="AWS Access Key ID (AWS_ACCESS_KEY_ID — Optional)"
                      disabled={readOnly || clearAwsAccessKeyId}
                      value={awsAccessKeyIdDraft}
                      onChange={(e) => {
                        setAwsAccessKeyIdDraft(e.target.value);
                        if (e.target.value.trim() && clearAwsAccessKeyId) {
                          setClearAwsAccessKeyId(false);
                        }
                      }}
                      placeholder="Leave blank to use IAM Role / AWS profile"
                      hint="Optional when running with an IAM Role or local AWS CLI credentials."
                    />
                  </div>
                  <SecretInput
                    field="aws_secret_access_key"
                    label="AWS Secret Access Key (AWS_SECRET_ACCESS_KEY — Optional)"
                    isSet={serverSettings.aws_secret_access_key_set}
                    maskedPreview={serverSettings.aws_secret_access_key}
                    draftValue={secretDrafts.aws_secret_access_key ?? ''}
                    markedForClear={clearSecrets.has('aws_secret_access_key')}
                    disabled={readOnly}
                    placeholder="Leave blank to use IAM Role / AWS profile"
                    hint="Stored only in local .env. Shared with AWS S3 storage if configured. Save before testing."
                    onDraftChange={(val) => updateSecretDraft('aws_secret_access_key', val)}
                    onToggleClear={() => toggleClearSecret('aws_secret_access_key')}
                  />
                </>
              )}

              {form.llm_provider === 'ollama' && (
                <>
                  <Input
                    label="Ollama Base URL (LLM_BASE_URL)"
                    disabled={readOnly}
                    value={form.llm_base_url}
                    onChange={(e) => updateField('llm_base_url', e.target.value)}
                    placeholder="http://localhost:11434"
                    hint="Defaults to http://localhost:11434 when left blank."
                  />
                  <SecretInput
                    field="llm_api_key"
                    label="Bearer Token (LLM_API_KEY — Optional)"
                    isSet={serverSettings.llm_api_key_set}
                    maskedPreview={serverSettings.llm_api_key}
                    draftValue={secretDrafts.llm_api_key ?? ''}
                    markedForClear={clearSecrets.has('llm_api_key')}
                    disabled={readOnly}
                    placeholder="Leave blank for local Ollama"
                    hint="Only required if your Ollama server sits behind an authenticating proxy."
                    onDraftChange={(val) => updateSecretDraft('llm_api_key', val)}
                    onToggleClear={() => toggleClearSecret('llm_api_key')}
                  />
                </>
              )}

              {form.llm_provider === 'openai_compatible' && (
                <>
                  <Input
                    label="Endpoint Base URL (LLM_BASE_URL)"
                    disabled={readOnly}
                    value={form.llm_base_url}
                    onChange={(e) => updateField('llm_base_url', e.target.value)}
                    placeholder="e.g., http://localhost:8000/v1"
                    hint="Required. Base URL exposing the OpenAI-compatible /chat/completions endpoint (vLLM, LM Studio, OpenRouter, etc.)."
                  />
                  <SecretInput
                    field="llm_api_key"
                    label="API Key (LLM_API_KEY — Optional)"
                    isSet={serverSettings.llm_api_key_set}
                    maskedPreview={serverSettings.llm_api_key}
                    draftValue={secretDrafts.llm_api_key ?? ''}
                    markedForClear={clearSecrets.has('llm_api_key')}
                    disabled={readOnly}
                    placeholder="Optional for local servers; required for hosted proxies"
                    hint="Stored only in local .env (never in SQLite or deployment bundles). Save before testing new credentials."
                    onDraftChange={(val) => updateSecretDraft('llm_api_key', val)}
                    onToggleClear={() => toggleClearSecret('llm_api_key')}
                  />
                </>
              )}

              {(form.llm_provider === 'openai' ||
                form.llm_provider === 'anthropic' ||
                form.llm_provider === 'gemini') && (
                <>
                  <SecretInput
                    field="llm_api_key"
                    label={
                      form.llm_provider === 'openai'
                        ? 'OpenAI API Key (LLM_API_KEY)'
                        : form.llm_provider === 'anthropic'
                          ? 'Anthropic API Key (LLM_API_KEY)'
                          : 'Google AI API Key (LLM_API_KEY)'
                    }
                    isSet={serverSettings.llm_api_key_set}
                    maskedPreview={serverSettings.llm_api_key}
                    draftValue={secretDrafts.llm_api_key ?? ''}
                    markedForClear={clearSecrets.has('llm_api_key')}
                    disabled={readOnly}
                    placeholder={
                      form.llm_provider === 'openai'
                        ? 'sk-...'
                        : form.llm_provider === 'anthropic'
                          ? 'sk-ant-...'
                          : 'AIza...'
                    }
                    hint="Stored only in local .env (never in SQLite or deployment bundles). Save before testing new credentials."
                    onDraftChange={(val) => updateSecretDraft('llm_api_key', val)}
                    onToggleClear={() => toggleClearSecret('llm_api_key')}
                  />
                  <Input
                    label="Custom Base URL (LLM_BASE_URL — Optional)"
                    disabled={readOnly}
                    value={form.llm_base_url}
                    onChange={(e) => updateField('llm_base_url', e.target.value)}
                    placeholder={
                      form.llm_provider === 'openai'
                        ? 'https://api.openai.com/v1'
                        : form.llm_provider === 'anthropic'
                          ? 'https://api.anthropic.com'
                          : 'https://generativelanguage.googleapis.com'
                    }
                    hint="Optional. Leave blank to use the official provider API endpoint."
                  />
                </>
              )}

              {form.llm_provider !== 'none' && (
                <div className="pt-2 border-t border-slate-800/80">
                  <TestConnectionBar
                    target="llm"
                    label="Test LLM Connection"
                    testingTarget={testingTarget}
                    result={testResults.llm}
                    onTest={(t) => void handleTestTarget(t)}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* TAB 2: Storage Sinks */}
      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-storage`}
        hidden={activeTab !== 'storage'}
      >
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Enabled Storage Sinks (STORAGE_SINKS)</CardTitle>
              <CardDescription>
                Enable one or more artifact stores for raw backups, JSON evaluations, and PDF
                reports.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {STORAGE_SINK_OPTIONS.map((opt) => {
                const checked = enabledStorageSinks.has(opt.id);
                return (
                  <label
                    key={opt.id}
                    className={cn(
                      'flex items-start gap-2.5 rounded-xl border p-3.5 text-xs transition-colors',
                      checked
                        ? 'border-indigo-500/60 bg-indigo-500/10'
                        : 'border-slate-800 bg-surface-0/60 hover:border-slate-700',
                      readOnly ? 'opacity-65 cursor-not-allowed' : 'cursor-pointer'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={readOnly}
                      onChange={() =>
                        updateField('storage_sinks', toggleCsvItem(form.storage_sinks, opt.id))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500"
                    />
                    <div className="space-y-0.5">
                      <p className="font-semibold text-slate-100">{opt.label}</p>
                      <p className="text-[11px] text-slate-400 leading-snug">{opt.desc}</p>
                    </div>
                  </label>
                );
              })}
            </CardContent>
          </Card>

          {/* Local Storage */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Local Disk Storage</CardTitle>
                <Badge variant={enabledStorageSinks.has('local') ? 'emerald' : 'slate'} size="sm">
                  {enabledStorageSinks.has('local') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="Local Reports Directory (LOCAL_REPORTS_DIR)"
                disabled={readOnly}
                value={form.local_reports_dir}
                onChange={(e) => updateField('local_reports_dir', e.target.value)}
                placeholder="data/reports"
              />
              <TestConnectionBar
                target="local"
                label="Test Local Write"
                testingTarget={testingTarget}
                result={testResults.local}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Amazon S3 / Compatible */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Amazon S3 / S3-Compatible (R2, MinIO, Spaces)</CardTitle>
                <Badge variant={enabledStorageSinks.has('s3') ? 'emerald' : 'slate'} size="sm">
                  {enabledStorageSinks.has('s3') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Input
                  label="S3 Bucket (S3_BUCKET)"
                  disabled={readOnly}
                  value={form.s3_bucket}
                  onChange={(e) => updateField('s3_bucket', e.target.value)}
                  placeholder="my-interview-reports"
                />
                <Input
                  label="Key Prefix (S3_PREFIX)"
                  disabled={readOnly}
                  value={form.s3_prefix}
                  onChange={(e) => updateField('s3_prefix', e.target.value)}
                  placeholder="interviews"
                />
                <Input
                  label="Region (S3_REGION)"
                  disabled={readOnly}
                  value={form.s3_region}
                  onChange={(e) => updateField('s3_region', e.target.value)}
                  placeholder="us-east-1"
                />
                <Input
                  label="Custom Endpoint URL (S3_ENDPOINT_URL — Optional)"
                  disabled={readOnly}
                  value={form.s3_endpoint_url}
                  onChange={(e) => updateField('s3_endpoint_url', e.target.value)}
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                />
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-300">
                        AWS Access Key ID (Optional if using IAM role)
                      </span>
                      {clearAwsAccessKeyId ? (
                        <Badge variant="rose" size="sm">
                          Will be cleared on save
                        </Badge>
                      ) : awsAccessKeyIdDraft.trim() ? (
                        <Badge variant="cyan" size="sm">
                          New value staged
                        </Badge>
                      ) : null}
                    </div>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => {
                          setClearAwsAccessKeyId((prev) => {
                            const next = !prev;
                            if (next) setAwsAccessKeyIdDraft('');
                            return next;
                          });
                        }}
                        className={cn(
                          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-ring',
                          clearAwsAccessKeyId
                            ? 'text-cyan-300 hover:text-cyan-200'
                            : 'text-rose-400 hover:text-rose-300'
                        )}
                      >
                        {clearAwsAccessKeyId ? (
                          <>
                            <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            Keep existing
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                            Clear key
                          </>
                        )}
                      </button>
                    )}
                  </div>
                  <Input
                    aria-label="AWS Access Key ID"
                    disabled={readOnly || clearAwsAccessKeyId}
                    value={awsAccessKeyIdDraft}
                    onChange={(e) => {
                      setAwsAccessKeyIdDraft(e.target.value);
                      if (e.target.value.trim() && clearAwsAccessKeyId) {
                        setClearAwsAccessKeyId(false);
                      }
                    }}
                    placeholder={
                      clearAwsAccessKeyId
                        ? 'Key will be cleared when you save'
                        : 'Leave blank to keep existing key, or enter AKIA…'
                    }
                  />
                </div>
              </div>

              <SecretInput
                field="aws_secret_access_key"
                label="AWS Secret Access Key (AWS_SECRET_ACCESS_KEY)"
                isSet={serverSettings.aws_secret_access_key_set}
                maskedPreview={serverSettings.aws_secret_access_key}
                draftValue={secretDrafts.aws_secret_access_key ?? ''}
                markedForClear={clearSecrets.has('aws_secret_access_key')}
                disabled={readOnly}
                onDraftChange={(val) => updateSecretDraft('aws_secret_access_key', val)}
                onToggleClear={() => toggleClearSecret('aws_secret_access_key')}
              />

              <TestConnectionBar
                target="s3"
                label="Test S3 Connection"
                testingTarget={testingTarget}
                result={testResults.s3}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Google Cloud Storage */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Google Cloud Storage (GCS)</CardTitle>
                <Badge variant={enabledStorageSinks.has('gcs') ? 'emerald' : 'slate'} size="sm">
                  {enabledStorageSinks.has('gcs') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Input
                  label="GCS Bucket (GCS_BUCKET)"
                  disabled={readOnly}
                  value={form.gcs_bucket}
                  onChange={(e) => updateField('gcs_bucket', e.target.value)}
                  placeholder="my-gcs-interview-bucket"
                  hint="Uses Application Default Credentials (ADC) or Cloud Run service account."
                />
                <Input
                  label="Object Prefix (GCS_PREFIX)"
                  disabled={readOnly}
                  value={form.gcs_prefix}
                  onChange={(e) => updateField('gcs_prefix', e.target.value)}
                  placeholder="interviews"
                />
              </div>
              <TestConnectionBar
                target="gcs"
                label="Test GCS Connection"
                testingTarget={testingTarget}
                result={testResults.gcs}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Azure Blob Storage */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Azure Blob Storage</CardTitle>
                <Badge
                  variant={enabledStorageSinks.has('azure_blob') ? 'emerald' : 'slate'}
                  size="sm"
                >
                  {enabledStorageSinks.has('azure_blob') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <SecretInput
                field="azure_storage_connection_string"
                label="Connection String (AZURE_STORAGE_CONNECTION_STRING)"
                isSet={serverSettings.azure_storage_connection_string_set}
                maskedPreview={serverSettings.azure_storage_connection_string}
                draftValue={secretDrafts.azure_storage_connection_string ?? ''}
                markedForClear={clearSecrets.has('azure_storage_connection_string')}
                disabled={readOnly}
                placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=..."
                onDraftChange={(val) => updateSecretDraft('azure_storage_connection_string', val)}
                onToggleClear={() => toggleClearSecret('azure_storage_connection_string')}
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Input
                  label="Account URL (Managed Identity)"
                  disabled={readOnly}
                  value={form.azure_storage_account_url}
                  onChange={(e) => updateField('azure_storage_account_url', e.target.value)}
                  placeholder="https://<account>.blob.core.windows.net"
                />
                <Input
                  label="Container Name"
                  disabled={readOnly}
                  value={form.azure_storage_container}
                  onChange={(e) => updateField('azure_storage_container', e.target.value)}
                  placeholder="interviews"
                />
                <Input
                  label="Blob Prefix"
                  disabled={readOnly}
                  value={form.azure_storage_prefix}
                  onChange={(e) => updateField('azure_storage_prefix', e.target.value)}
                  placeholder="interviews"
                />
              </div>
              <TestConnectionBar
                target="azure_blob"
                label="Test Azure Blob Connection"
                testingTarget={testingTarget}
                result={testResults.azure_blob}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Presigned URLs */}
          <Card>
            <CardHeader>
              <CardTitle>Notification Report Link Options</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2 items-center">
              <label
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border border-slate-800/90 bg-surface-0/60 p-3.5 text-xs',
                  readOnly ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
                )}
              >
                <input
                  type="checkbox"
                  checked={form.storage_presigned_urls}
                  disabled={readOnly}
                  onChange={(e) => updateField('storage_presigned_urls', e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500"
                />
                <div>
                  <p className="font-medium text-slate-200">
                    Generate Expiring Presigned URLs (STORAGE_PRESIGNED_URLS)
                  </p>
                  <p className="text-[11px] text-slate-400">
                    When disabled, notifications include raw cloud URIs and console links with zero
                    signing permissions required.
                  </p>
                </div>
              </label>

              <Input
                label="Presigned URL TTL (Seconds)"
                type="number"
                min={60}
                max={2592000}
                disabled={readOnly || !form.storage_presigned_urls}
                value={String(form.storage_presigned_ttl_seconds)}
                onChange={(e) =>
                  updateField('storage_presigned_ttl_seconds', Number(e.target.value) || 604800)
                }
                hint="Default: 604800 (7 days)"
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* TAB 3: Notification Sinks */}
      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-notify`}
        hidden={activeTab !== 'notify'}
      >
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Enabled Notification Sinks (NOTIFY_SINKS)</CardTitle>
              <CardDescription>
                Push candidate scores, summaries, and PDF reports to your hiring team automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {NOTIFY_SINK_OPTIONS.map((opt) => {
                const checked = enabledNotifySinks.has(opt.id);
                return (
                  <label
                    key={opt.id}
                    className={cn(
                      'flex items-start gap-2.5 rounded-xl border p-3.5 text-xs transition-colors',
                      checked
                        ? 'border-cyan-500/60 bg-cyan-500/10'
                        : 'border-slate-800 bg-surface-0/60 hover:border-slate-700',
                      readOnly ? 'opacity-65 cursor-not-allowed' : 'cursor-pointer'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={readOnly}
                      onChange={() =>
                        updateField('notify_sinks', toggleCsvItem(form.notify_sinks, opt.id))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-cyan-500"
                    />
                    <div className="space-y-0.5">
                      <p className="font-semibold text-slate-100">{opt.label}</p>
                      <p className="text-[11px] text-slate-400 leading-snug">{opt.desc}</p>
                    </div>
                  </label>
                );
              })}
            </CardContent>
          </Card>

          {/* SMTP */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>SMTP Email (Direct PDF Attachment)</CardTitle>
                <Badge variant={enabledNotifySinks.has('smtp') ? 'emerald' : 'slate'} size="sm">
                  {enabledNotifySinks.has('smtp') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Input
                  label="SMTP Host (SMTP_HOST)"
                  disabled={readOnly}
                  value={form.smtp_host}
                  onChange={(e) => updateField('smtp_host', e.target.value)}
                  placeholder="smtp.sendgrid.net"
                />
                <Input
                  label="SMTP Port (SMTP_PORT)"
                  type="number"
                  disabled={readOnly}
                  value={String(form.smtp_port)}
                  onChange={(e) => updateField('smtp_port', Number(e.target.value) || 587)}
                />
                <Input
                  label="SMTP Username (SMTP_USER)"
                  disabled={readOnly}
                  value={form.smtp_user}
                  onChange={(e) => updateField('smtp_user', e.target.value)}
                  placeholder="apikey or user@domain.com"
                />
                <Input
                  label="From Address (SMTP_FROM)"
                  disabled={readOnly}
                  value={form.smtp_from}
                  onChange={(e) => updateField('smtp_from', e.target.value)}
                  placeholder="interviews@yourdomain.com"
                />
                <Input
                  label="Recipient(s) (SMTP_TO)"
                  disabled={readOnly}
                  value={form.smtp_to}
                  onChange={(e) => updateField('smtp_to', e.target.value)}
                  placeholder="hiring@yourdomain.com, lead@yourdomain.com"
                />
                <label className="flex items-center gap-2.5 self-end pb-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.smtp_use_tls}
                    disabled={readOnly}
                    onChange={(e) => updateField('smtp_use_tls', e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500"
                  />
                  Use STARTTLS (SMTP_USE_TLS)
                </label>
              </div>

              <SecretInput
                field="smtp_password"
                label="SMTP Password (SMTP_PASSWORD)"
                isSet={serverSettings.smtp_password_set}
                maskedPreview={serverSettings.smtp_password}
                draftValue={secretDrafts.smtp_password ?? ''}
                markedForClear={clearSecrets.has('smtp_password')}
                disabled={readOnly}
                onDraftChange={(val) => updateSecretDraft('smtp_password', val)}
                onToggleClear={() => toggleClearSecret('smtp_password')}
              />

              <TestConnectionBar
                target="smtp"
                label="Test SMTP Connection"
                testingTarget={testingTarget}
                result={testResults.smtp}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Slack */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Slack</CardTitle>
                <Badge variant={enabledNotifySinks.has('slack') ? 'emerald' : 'slate'} size="sm">
                  {enabledNotifySinks.has('slack') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Input
                  label="Incoming Webhook URL (SLACK_WEBHOOK_URL)"
                  disabled={readOnly}
                  value={form.slack_webhook_url}
                  onChange={(e) => updateField('slack_webhook_url', e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                />
                <Input
                  label="Channel ID for PDF Uploads (SLACK_CHANNEL_ID)"
                  disabled={readOnly}
                  value={form.slack_channel_id}
                  onChange={(e) => updateField('slack_channel_id', e.target.value)}
                  placeholder="C0123456789"
                />
              </div>

              <SecretInput
                field="slack_bot_token"
                label="Slack Bot Token (SLACK_BOT_TOKEN — optional for direct PDF upload)"
                isSet={serverSettings.slack_bot_token_set}
                maskedPreview={serverSettings.slack_bot_token}
                draftValue={secretDrafts.slack_bot_token ?? ''}
                markedForClear={clearSecrets.has('slack_bot_token')}
                disabled={readOnly}
                placeholder="xoxb-..."
                onDraftChange={(val) => updateSecretDraft('slack_bot_token', val)}
                onToggleClear={() => toggleClearSecret('slack_bot_token')}
              />

              <TestConnectionBar
                target="slack"
                label="Test Slack"
                testingTarget={testingTarget}
                result={testResults.slack}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Microsoft Teams */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Microsoft Teams</CardTitle>
                <Badge variant={enabledNotifySinks.has('teams') ? 'emerald' : 'slate'} size="sm">
                  {enabledNotifySinks.has('teams') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="Teams Incoming Webhook / Workflow URL (TEAMS_WEBHOOK_URL)"
                disabled={readOnly}
                value={form.teams_webhook_url}
                onChange={(e) => updateField('teams_webhook_url', e.target.value)}
                placeholder="https://..."
              />
              <TestConnectionBar
                target="teams"
                label="Test Teams Webhook"
                testingTarget={testingTarget}
                result={testResults.teams}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>

          {/* Generic Webhook */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Generic HTTP Webhook</CardTitle>
                <Badge variant={enabledNotifySinks.has('webhook') ? 'emerald' : 'slate'} size="sm">
                  {enabledNotifySinks.has('webhook') ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="Webhook Endpoint URL (WEBHOOK_URL)"
                disabled={readOnly}
                value={form.webhook_url}
                onChange={(e) => updateField('webhook_url', e.target.value)}
                placeholder="https://api.example.com/interview-webhooks"
              />
              <SecretInput
                field="webhook_secret"
                label="HMAC-SHA256 Signing Secret (WEBHOOK_SECRET — Optional)"
                isSet={serverSettings.webhook_secret_set}
                maskedPreview={serverSettings.webhook_secret}
                draftValue={secretDrafts.webhook_secret ?? ''}
                markedForClear={clearSecrets.has('webhook_secret')}
                disabled={readOnly}
                onDraftChange={(val) => updateSecretDraft('webhook_secret', val)}
                onToggleClear={() => toggleClearSecret('webhook_secret')}
              />
              <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.webhook_include_pdf_base64}
                  disabled={readOnly}
                  onChange={(e) => updateField('webhook_include_pdf_base64', e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500"
                />
                Include Base64-encoded PDF inside webhook JSON payload (WEBHOOK_INCLUDE_PDF_BASE64)
              </label>
              <TestConnectionBar
                target="webhook"
                label="Test Generic Webhook"
                testingTarget={testingTarget}
                result={testResults.webhook}
                onTest={(t) => void handleTestTarget(t)}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* TAB 4: Notebook Sandbox Guardrails */}
      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-sandbox`}
        hidden={activeTab !== 'sandbox'}
      >
        <Card>
          <CardHeader>
            <CardTitle>Notebook Sandbox Security & Resource Guardrails</CardTitle>
            <CardDescription>
              Protect serverless containers from oversized package installs, runaway loops, and
              excessive memory/disk consumption during interactive Python notebook interviews.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Input
                label="Max Package Size (MB)"
                type="number"
                min={1}
                max={500}
                disabled={readOnly}
                value={String(form.sandbox_max_package_mb)}
                onChange={(e) =>
                  updateField('sandbox_max_package_mb', Number(e.target.value) || 25)
                }
                hint="SANDBOX_MAX_PACKAGE_MB (checked against PyPI before pip runs)"
              />
              <Input
                label="Max Disk Per Session (MB)"
                type="number"
                min={10}
                max={2048}
                disabled={readOnly}
                value={String(form.sandbox_max_disk_mb)}
                onChange={(e) => updateField('sandbox_max_disk_mb', Number(e.target.value) || 150)}
                hint="SANDBOX_MAX_DISK_MB"
              />
              <Input
                label="Cell Execution Timeout (Seconds)"
                type="number"
                min={1}
                max={120}
                disabled={readOnly}
                value={String(form.sandbox_cell_timeout_seconds)}
                onChange={(e) =>
                  updateField('sandbox_cell_timeout_seconds', Number(e.target.value) || 15)
                }
                hint="SANDBOX_CELL_TIMEOUT_SECONDS"
              />
              <Input
                label="Max Kernel Memory (MB)"
                type="number"
                min={64}
                max={4096}
                disabled={readOnly}
                value={String(form.sandbox_max_memory_mb)}
                onChange={(e) =>
                  updateField('sandbox_max_memory_mb', Number(e.target.value) || 512)
                }
                hint="SANDBOX_MAX_MEMORY_MB"
              />
              <Input
                label="Idle Kernel Timeout (Minutes)"
                type="number"
                min={1}
                max={120}
                disabled={readOnly}
                value={String(form.sandbox_idle_timeout_minutes)}
                onChange={(e) =>
                  updateField('sandbox_idle_timeout_minutes', Number(e.target.value) || 15)
                }
                hint="SANDBOX_IDLE_TIMEOUT_MINUTES"
              />
            </div>

            <Textarea
              label="Banned PyPI Packages (SANDBOX_BANNED_PACKAGES — comma-separated)"
              rows={4}
              disabled={readOnly}
              value={form.sandbox_banned_packages}
              onChange={(e) => updateField('sandbox_banned_packages', e.target.value)}
              hint="Heavy ML/GPU/native packages rejected immediately before pip executes."
            />
          </CardContent>
        </Card>
      </div>

      {/* TAB 5: General & Access */}
      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-general`}
        hidden={activeTab !== 'general'}
      >
        <Card>
          <CardHeader>
            <CardTitle>Platform Identity & Access Controls</CardTitle>
            <CardDescription>
              Customize the portal title, global candidate access code override, and optional admin
              password.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                label="Application Title (APP_TITLE)"
                disabled={readOnly}
                value={form.app_title}
                onChange={(e) => updateField('app_title', e.target.value)}
              />
              <Input
                label="Global Access Code Override (ACCESS_CODE)"
                disabled={readOnly}
                value={form.access_code}
                onChange={(e) => updateField('access_code', e.target.value)}
                placeholder="Optional global override"
              />
            </div>

            <SecretInput
              field="admin_password"
              label="Admin Password (ADMIN_PASSWORD)"
              isSet={serverSettings.admin_password_set}
              maskedPreview={serverSettings.admin_password}
              draftValue={secretDrafts.admin_password ?? ''}
              markedForClear={clearSecrets.has('admin_password')}
              disabled={readOnly}
              hint="When set in candidate mode, enables read-only authenticated access to /admin."
              onDraftChange={(val) => updateSecretDraft('admin_password', val)}
              onToggleClear={() => toggleClearSecret('admin_password')}
            />

            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={form.auto_seed_examples}
                disabled={readOnly}
                onChange={(e) => updateField('auto_seed_examples', e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500"
              />
              Auto-seed starter example questions & templates when local database is empty
            </label>

            <div className="grid grid-cols-1 gap-3 pt-3 border-t border-slate-800/80 sm:grid-cols-3 text-xs">
              <div className="rounded-lg border border-slate-800 bg-surface-0/60 px-3 py-2">
                <p className="text-[11px] text-slate-500">Runtime Mode</p>
                <p className="mt-0.5 font-mono text-slate-200">{form.app_mode}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-surface-0/60 px-3 py-2">
                <p className="text-[11px] text-slate-500">Database Path</p>
                <p className="mt-0.5 font-mono text-slate-200 truncate">{form.database_path}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-surface-0/60 px-3 py-2">
                <p className="text-[11px] text-slate-500">Bundle Path</p>
                <p className="mt-0.5 font-mono text-slate-200 truncate">{form.bundle_path}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Copyable Deployment .env Snippet Generator */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Deployment `.env` Snippet</CardTitle>
              <CardDescription>
                Copy-ready environment configuration for your cloud runtime. Actual secrets are
                never exposed here — inject them via your cloud secret manager.
              </CardDescription>
            </div>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={
                copiedEnv ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )
              }
              onClick={() => void handleCopySnippet()}
            >
              {copiedEnv ? 'Copied!' : 'Copy Snippet'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <pre className="max-h-72 overflow-auto rounded-xl border border-slate-800/90 bg-surface-0/95 p-4 text-xs leading-relaxed text-cyan-200/90 custom-scrollbar">
            <code>{deploymentEnvSnippet}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsPage;
