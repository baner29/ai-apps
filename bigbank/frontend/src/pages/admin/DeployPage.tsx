import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Layers,
  Lock,
  PackageCheck,
  RefreshCw,
  Rocket,
  Settings,
  Star,
  Tag,
  Terminal,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  DeployBundleResponse,
  DeploySnippets,
  DeployStatus,
  Template,
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
  EmptyState,
  Spinner,
  useToast,
} from '../../components/ui';
import { useAdminContext } from './AdminLayout';
import { copyTextToClipboard } from './TemplatesPage';

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

type PlatformTabId = keyof DeploySnippets;

const PLATFORM_TABS: Array<{ id: PlatformTabId; label: string; subtitle: string }> = [
  {
    id: 'docker',
    label: 'Docker',
    subtitle: 'Build and run the self-contained candidate container anywhere Docker runs.',
  },
  {
    id: 'cloud_run',
    label: 'Google Cloud Run',
    subtitle: 'Serverless scale-to-zero deployment with Secret Manager or env vars.',
  },
  {
    id: 'aws_app_runner',
    label: 'AWS App Runner',
    subtitle: 'Push image to ECR and deploy a managed HTTPS App Runner service.',
  },
  {
    id: 'azure_container_apps',
    label: 'Azure Container Apps',
    subtitle: 'Deploy to Azure Container Apps with Managed Identity or env secrets.',
  },
  {
    id: 'fly_io',
    label: 'Fly.io',
    subtitle: 'Deploy globally on Fly.io machines with `fly secrets set`.',
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// DeployPage Component
// ---------------------------------------------------------------------------

export function DeployPage() {
  const { readOnly } = useAdminContext();
  const { toast } = useToast();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Bundle selection state
  const [bundleMode, setBundleMode] = useState<'all' | 'selected'>('all');
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [building, setBuilding] = useState(false);
  const [bundleResult, setBundleResult] = useState<DeployBundleResponse | null>(null);

  // Snippet tabs state
  const [activePlatform, setActivePlatform] = useState<PlatformTabId>('docker');
  const [copiedPlatform, setCopiedPlatform] = useState<PlatformTabId | null>(null);

  const tabIdPrefix = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [tpls, status] = await Promise.all([
        api.admin.listTemplates(),
        api.admin.getDeployStatus(),
      ]);
      setTemplates(tpls);
      setDeployStatus(status);
      setSelectedSlugs((prev) => {
        if (prev.size > 0) return prev;
        const defaults = tpls.filter((t) => t.is_default).map((t) => t.slug);
        return new Set(defaults.length > 0 ? defaults : tpls.slice(0, 1).map((t) => t.slug));
      });
    } catch (err: unknown) {
      setLoadError(
        err instanceof ApiError ? err.detail : 'Failed to load deployment readiness status.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const toggleSlug = (slug: string) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  };

  const handleBuildBundle = async () => {
    if (readOnly) return;
    if (bundleMode === 'selected' && selectedSlugs.size === 0) {
      toast({
        variant: 'warning',
        title: 'No templates selected',
        description: 'Select at least one template or choose "All Templates".',
      });
      return;
    }

    setBuilding(true);
    try {
      const res = await api.admin.buildDeployBundle({
        template_slugs: bundleMode === 'all' ? null : Array.from(selectedSlugs),
      });
      setBundleResult(res);
      setDeployStatus(res.readiness);
      toast({
        variant: 'success',
        title: 'Deployment bundle built',
        description: `${res.templates_count} template(s), ${res.questions_count} question(s) (${formatBytes(res.size_bytes)})`,
      });
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Bundle build failed',
        description: err instanceof ApiError ? err.detail : 'Unable to build deployment bundle.',
      });
    } finally {
      setBuilding(false);
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % PLATFORM_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + PLATFORM_TABS.length) % PLATFORM_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = PLATFORM_TABS.length - 1;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      const nextTab = PLATFORM_TABS[nextIndex];
      setActivePlatform(nextTab.id);
      const btn = tabRefs.current[nextIndex];
      btn?.focus();
      btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const handleCopySnippet = async (platform: PlatformTabId, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedPlatform(platform);
      toast({
        variant: 'success',
        title: 'Deploy command copied',
        description: PLATFORM_TABS.find((t) => t.id === platform)?.label,
      });
      window.setTimeout(() => {
        setCopiedPlatform((curr) => (curr === platform ? null : curr));
      }, 2000);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24">
        <Spinner size="lg" label="Loading deployment status" />
        <p className="text-sm text-slate-400">Checking deployment readiness…</p>
      </div>
    );
  }

  if (loadError || !deployStatus) {
    return (
      <Alert variant="error" title="Could not load deployment status">
        <div className="flex items-center justify-between gap-3">
          <span>{loadError ?? 'Unexpected error loading deployment status.'}</span>
          <Button variant="secondary" size="sm" onClick={() => void loadData()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Package & Deploy</h1>
          <p className="mt-1 text-sm text-slate-400">
            Build a clean, stripped candidate SQLite bundle with zero PII or API keys, verify cloud
            readiness, and deploy the container anywhere.
          </p>
        </div>

        <Button
          variant="secondary"
          size="md"
          leftIcon={<RefreshCw className="h-4 w-4" />}
          onClick={() => void loadData()}
        >
          Refresh Checks
        </Button>
      </div>

      {/* Pre-Flight Readiness Checklist */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Pre-Flight Readiness Checklist</CardTitle>
              <CardDescription>
                Verify bundle artifacts, external delivery sinks, and LLM provider configuration
                before pushing to serverless production.
              </CardDescription>
            </div>
            <Badge
              variant={deployStatus.warnings.length === 0 ? 'emerald' : 'amber'}
              size="md"
              dot
            >
              {deployStatus.warnings.length === 0
                ? 'Ready to Deploy'
                : `${deployStatus.warnings.length} ${deployStatus.warnings.length === 1 ? 'Warning' : 'Warnings'}`}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {/* Check 1: Bundle */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border p-4',
                deployStatus.bundle_exists
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-amber-500/35 bg-amber-500/5'
              )}
            >
              {deployStatus.bundle_exists ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" aria-hidden="true" />
              )}
              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-100">Stripped SQLite Bundle</p>
                <p className="text-[11px] text-slate-400">
                  {deployStatus.bundle_exists
                    ? 'bundle/interview.db exists and is ready to copy into Docker.'
                    : 'Not built yet — click Build Deployment Bundle below.'}
                </p>
              </div>
            </div>

            {/* Check 2: External Sinks */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border p-4',
                deployStatus.has_external_sink
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-rose-500/35 bg-rose-500/5'
              )}
            >
              {deployStatus.has_external_sink ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" aria-hidden="true" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0 text-rose-400 mt-0.5" aria-hidden="true" />
              )}
              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-100">External Delivery Sink</p>
                <p className="text-[11px] text-slate-400">
                  {deployStatus.has_external_sink
                    ? 'At least one external storage or notification sink is enabled.'
                    : 'No cloud storage or push sink configured (ephemeral containers lose local files).'}
                </p>
              </div>
            </div>

            {/* Check 3: LLM */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border p-4',
                deployStatus.llm_configured
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-amber-500/35 bg-amber-500/5'
              )}
            >
              {deployStatus.llm_configured ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" aria-hidden="true" />
              )}
              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-100">AI Grading Provider</p>
                <p className="text-[11px] text-slate-400">
                  {deployStatus.llm_configured
                    ? 'LLM provider is configured for automatic rubric grading.'
                    : 'Running in manual-review fallback mode (MCQs still auto-grade).'}
                </p>
              </div>
            </div>
          </div>

          {deployStatus.warnings.length > 0 && (
            <Alert variant="warning" title="Pre-Flight Warnings">
              <div className="space-y-2">
                <ul className="list-disc pl-5 space-y-1 text-xs">
                  {deployStatus.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
                <div className="pt-1">
                  <Link
                    to="/admin/settings"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-200 underline underline-offset-2 hover:text-white"
                  >
                    <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                    Review Integrations & Settings
                  </Link>
                </div>
              </div>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Bundle Packager Card */}
      <Card>
        <CardHeader>
          <CardTitle>Build Deployment Bundle</CardTitle>
          <CardDescription>
            Packages only the selected template(s), their referenced tags, and referenced questions
            into a read-only SQLite bundle (<code>bundle/interview.db</code>) with zero local
            candidate submissions and zero secrets.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {templates.length === 0 ? (
            <EmptyState
              icon={<Layers className="h-6 w-6" />}
              title="No interview templates available"
              description="Create at least one interview template before packaging a deployment bundle."
              action={
                <Link to="/admin/templates/new">
                  <Button variant="primary" size="sm">
                    Create Template
                  </Button>
                </Link>
              }
            />
          ) : (
            <>
              {/* All vs Selected Radio Toggle */}
              <div
                role="radiogroup"
                aria-label="Template bundle scope"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={bundleMode === 'all'}
                  disabled={readOnly}
                  onClick={() => setBundleMode('all')}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all focus-ring',
                    bundleMode === 'all'
                      ? 'border-indigo-500/80 bg-indigo-500/12 ring-2 ring-indigo-500/20'
                      : 'border-slate-800 bg-surface-0/70 hover:border-slate-700',
                    readOnly && 'opacity-65 cursor-not-allowed'
                  )}
                >
                  <Box className="h-4 w-4 mt-0.5 text-indigo-400 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-semibold text-slate-100">
                      All Templates ({templates.length})
                    </p>
                    <p className="text-xs text-slate-400">
                      Include every interview template and its referenced questions.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={bundleMode === 'selected'}
                  disabled={readOnly}
                  onClick={() => setBundleMode('selected')}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all focus-ring',
                    bundleMode === 'selected'
                      ? 'border-cyan-500/80 bg-cyan-500/12 ring-2 ring-cyan-500/20'
                      : 'border-slate-800 bg-surface-0/70 hover:border-slate-700',
                    readOnly && 'opacity-65 cursor-not-allowed'
                  )}
                >
                  <Layers className="h-4 w-4 mt-0.5 text-cyan-400 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-semibold text-slate-100">Selected Template(s)</p>
                    <p className="text-xs text-slate-400">
                      Ship a minimal single-role or multi-role container bundle.
                    </p>
                  </div>
                </button>
              </div>

              {/* Template Checkboxes when Selected Mode */}
              {bundleMode === 'selected' && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">
                      Choose templates to include ({selectedSlugs.size} of {templates.length}{' '}
                      selected)
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => setSelectedSlugs(new Set(templates.map((t) => t.slug)))}
                        className="text-cyan-400 hover:text-cyan-300 font-medium disabled:opacity-50"
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => setSelectedSlugs(new Set())}
                        className="text-slate-400 hover:text-slate-200 font-medium disabled:opacity-50"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {templates.map((tpl) => {
                      const checked = selectedSlugs.has(tpl.slug);
                      return (
                        <label
                          key={tpl.id}
                          className={cn(
                            'flex items-start gap-3 rounded-xl border p-3 text-xs transition-colors',
                            checked
                              ? 'border-cyan-500/50 bg-cyan-500/10'
                              : 'border-slate-800 bg-surface-0/60 hover:border-slate-700',
                            readOnly ? 'opacity-65 cursor-not-allowed' : 'cursor-pointer'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly}
                            onChange={() => toggleSlug(tpl.slug)}
                            className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-cyan-500"
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold text-slate-100 truncate">
                                {tpl.name}
                              </span>
                              {tpl.is_default && (
                                <Badge variant="amber" size="sm">
                                  <Star className="h-2.5 w-2.5 fill-amber-400" aria-hidden="true" />
                                  Default
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 truncate">
                              {tpl.role_title} · <code className="text-cyan-300">/i/{tpl.slug}</code>
                            </p>
                          </div>
                          <Badge
                            variant={tpl.selection_mode === 'curated' ? 'indigo' : 'cyan'}
                            size="sm"
                          >
                            {tpl.selection_mode === 'curated' ? 'Curated' : 'Random'}
                          </Badge>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Build Action */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <p className="text-xs text-slate-400">
                  CLI equivalent:{' '}
                  <code className="rounded bg-surface-0 px-2 py-0.5 text-cyan-300 border border-slate-800">
                    python -m backend.cli package
                    {bundleMode === 'selected' && selectedSlugs.size > 0
                      ? ` --templates ${Array.from(selectedSlugs).join(',')}`
                      : ''}
                  </code>
                </p>

                <Button
                  variant="primary"
                  size="md"
                  loading={building}
                  disabled={readOnly || (bundleMode === 'selected' && selectedSlugs.size === 0)}
                  leftIcon={readOnly ? <Lock className="h-4 w-4" /> : <Rocket className="h-4 w-4" />}
                  onClick={() => void handleBuildBundle()}
                  title={
                    readOnly
                      ? 'Bundle building is disabled in read-only candidate mode'
                      : 'Build stripped SQLite deployment bundle'
                  }
                >
                  Build Deployment Bundle
                </Button>
              </div>
            </>
          )}

          {/* Bundle Build Result Summary */}
          {bundleResult && (
            <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/5 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-emerald-300">
                  <PackageCheck className="h-5 w-5" aria-hidden="true" />
                  <p className="text-sm font-semibold">Bundle Created Successfully</p>
                </div>
                <code className="rounded bg-surface-0/90 px-2.5 py-1 text-xs text-emerald-200 border border-emerald-500/25">
                  {bundleResult.output_path}
                </code>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-lg border border-slate-800/80 bg-surface-0/70 px-3 py-2">
                  <p className="text-[11px] text-slate-400">Templates</p>
                  <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-100">
                    <Layers className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                    {bundleResult.templates_count}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-surface-0/70 px-3 py-2">
                  <p className="text-[11px] text-slate-400">Questions</p>
                  <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-100">
                    <Database className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                    {bundleResult.questions_count}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-surface-0/70 px-3 py-2">
                  <p className="text-[11px] text-slate-400">Tags</p>
                  <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-100">
                    <Tag className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    {bundleResult.tags_count}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-surface-0/70 px-3 py-2">
                  <p className="text-[11px] text-slate-400">Bundle Size</p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-100 font-mono">
                    {formatBytes(bundleResult.size_bytes)}
                  </p>
                </div>
              </div>

              {bundleResult.template_slugs.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-slate-400 mr-1">Included candidate URLs:</span>
                  {bundleResult.template_slugs.map((slug) => (
                    <Badge key={slug} variant="cyan" size="sm">
                      /i/{slug}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cloud & Container Deploy Snippets (Accessible Tabs) */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-indigo-400" aria-hidden="true" />
            <div>
              <CardTitle>Cloud & Container Deployment Snippets</CardTitle>
              <CardDescription>
                Deploy the exact same multi-stage Docker container to any cloud or serverless host.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Single-Row Scrollable Accessible Tablist */}
          <div className="border-b border-slate-800/90">
            <div
              role="tablist"
              aria-label="Deployment platform snippets"
              className="flex items-center gap-1 overflow-x-auto custom-scrollbar"
            >
              {PLATFORM_TABS.map((tab, idx) => {
                const selected = activePlatform === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(el) => {
                      tabRefs.current[idx] = el;
                    }}
                    id={`${tabIdPrefix}-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActivePlatform(tab.id)}
                    onKeyDown={(e) => handleTabKeyDown(e, idx)}
                    className={cn(
                      'relative flex-none inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-medium whitespace-nowrap transition-colors focus-ring',
                      selected
                        ? 'text-indigo-300 after:content-[""] after:absolute after:inset-x-0 after:bottom-0 after:border-b-[3px] after:border-indigo-500'
                        : 'text-slate-400 hover:text-slate-100'
                    )}
                  >
                    <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab Panels */}
          <div>
            {PLATFORM_TABS.map((tab) => {
              const isSelected = activePlatform === tab.id;
              const snippetText = deployStatus.snippets[tab.id] || '';
              return (
                <div
                  key={tab.id}
                  role="tabpanel"
                  aria-labelledby={`${tabIdPrefix}-tab-${tab.id}`}
                  hidden={!isSelected}
                >
                  <div className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs text-slate-400">{tab.subtitle}</p>
                      <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={
                          copiedPlatform === tab.id ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )
                        }
                        onClick={() => void handleCopySnippet(tab.id, snippetText)}
                      >
                        {copiedPlatform === tab.id ? 'Copied!' : 'Copy Commands'}
                      </Button>
                    </div>

                    <pre className="overflow-x-auto rounded-xl border border-slate-800/90 bg-surface-0/95 p-4 text-xs leading-relaxed text-slate-200 custom-scrollbar">
                      <code>{snippetText}</code>
                    </pre>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default DeployPage;
