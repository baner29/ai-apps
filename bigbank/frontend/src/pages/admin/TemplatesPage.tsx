import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Check,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  KeyRound,
  Layers,
  ListOrdered,
  Package,
  Pencil,
  Plus,
  Search,
  Shuffle,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  CandidateQuestion,
  OpenBookPolicy,
  PublicTemplateMetadata,
  Question,
  ResolvedTemplateQuestion,
  SelectionMode,
  Template,
} from '../../types/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Modal,
  Spinner,
  useToast,
} from '../../components/ui';
import { CandidateFlow } from '../candidate/CandidateFlow';
import { useAdminContext } from './AdminLayout';

// ---------------------------------------------------------------------------
// Shared Helpers (also reused by TemplateComposerPage for Live Preview)
// ---------------------------------------------------------------------------

export function slugifyTemplateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function isOpenBookAllowed(
  policy: OpenBookPolicy,
  difficulty: Question['difficulty']
): boolean {
  if (policy === 'all') return true;
  if (policy === 'medium_hard') {
    return difficulty === 'medium' || difficulty === 'hard';
  }
  return false;
}

export function mapResolvedToCandidateQuestions(
  questions: ResolvedTemplateQuestion[],
  openBookPolicy: OpenBookPolicy,
  allowCodeExecution: boolean
): CandidateQuestion[] {
  return questions.map((q, index) => ({
    id: q.id,
    title: q.title,
    prompt: q.prompt,
    format: q.format,
    difficulty: q.difficulty,
    options: q.options ?? [],
    multi_select: q.format === 'mcq' && (q.answer_indices?.length ?? 0) > 1,
    code_language: q.code_language,
    starter_code:
      typeof q.starter_code === 'string'
        ? q.starter_code
        : q.starter_code
          ? JSON.stringify(q.starter_code)
          : null,
    allow_execution: Boolean(allowCodeExecution && q.allow_execution),
    points: q.effective_points ?? q.points_override ?? q.default_points,
    tags: q.tags ?? [],
    position: q.position ?? index,
    open_book_allowed: isOpenBookAllowed(openBookPolicy, q.difficulty),
  }));
}

export function mapTemplateToPublicMetadata(
  template: Pick<
    Template,
    | 'id'
    | 'slug'
    | 'name'
    | 'role_title'
    | 'description'
    | 'timer_minutes'
    | 'open_book_policy'
    | 'allow_code_execution'
    | 'allow_package_install'
    | 'access_code'
  >,
  questionCount: number,
  appTitle: string
): PublicTemplateMetadata {
  return {
    id: template.id,
    slug: template.slug,
    name: template.name,
    role_title: template.role_title,
    description: template.description,
    timer_minutes: template.timer_minutes,
    open_book_policy: template.open_book_policy,
    allow_code_execution: template.allow_code_execution,
    allow_package_install: template.allow_package_install,
    requires_access_code: Boolean((template.access_code || '').trim()),
    question_count: questionCount,
    app_title: appTitle,
  };
}

export interface TemplatePreviewOverlayProps {
  open: boolean;
  template: PublicTemplateMetadata | null;
  questions: CandidateQuestion[];
  onClose: () => void;
}

/**
 * Full-screen overlay rendering the live CandidateFlow in previewMode.
 * Uses a fixed viewport layer rather than `<dialog>` so CandidateFlow's own
 * internal submission confirmation `<Modal>` can stack cleanly in the top layer.
 */
export function TemplatePreviewOverlay({
  open,
  template,
  questions,
  onClose,
}: TemplatePreviewOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open || !template) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Live Candidate Preview: ${template.name}`}
      className="fixed inset-0 z-50 overflow-y-auto bg-surface-0 custom-scrollbar"
    >
      <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-indigo-500/30 bg-indigo-950/90 px-4 py-2 backdrop-blur-md">
        <div className="flex items-center gap-2 text-xs text-indigo-200 min-w-0">
          <Eye className="h-3.5 w-3.5 shrink-0 text-indigo-300" aria-hidden="true" />
          <span className="font-semibold">Live Candidate Preview</span>
          <span className="text-indigo-300/80 hidden sm:inline truncate">
            — {template.name} ({questions.length}{' '}
            {questions.length === 1 ? 'question' : 'questions'}) · No data is saved or graded.
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<X className="h-3.5 w-3.5" />}
          onClick={onClose}
        >
          Exit Preview
        </Button>
      </div>

      <CandidateFlow
        previewMode
        previewTemplate={template}
        previewQuestions={questions}
        onExitPreview={onClose}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local Presentation Helpers
// ---------------------------------------------------------------------------

const OPEN_BOOK_LABELS: Record<OpenBookPolicy, string> = {
  none: 'Closed Book',
  medium_hard: 'Open Book (Med/Hard)',
  all: 'Open Book (All)',
};

function computeRandomPoolCount(template: Template, allQuestions: Question[]): {
  requested: number;
  available: number;
} {
  const rules = template.random_rules ?? {};
  const dc = rules.difficulty_counts ?? {};
  const requestedByDiff =
    (Number(dc.easy) || 0) + (Number(dc.medium) || 0) + (Number(dc.hard) || 0);
  const requested = requestedByDiff > 0 ? requestedByDiff : Number(rules.total) || 0;

  const ruleTags = (rules.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const matchMode = rules.match === 'all' ? 'all' : 'any';

  const matching = allQuestions.filter((q) => {
    if (!q.active) return false;
    if (ruleTags.length === 0) return true;
    const qTags = new Set(q.tags.map((t) => t.toLowerCase()));
    if (matchMode === 'all') {
      return ruleTags.every((t) => qTags.has(t));
    }
    return ruleTags.some((t) => qTags.has(t));
  });

  return { requested, available: matching.length };
}

// ---------------------------------------------------------------------------
// TemplatesPage Component
// ---------------------------------------------------------------------------

export function TemplatesPage() {
  const { status, readOnly } = useAdminContext();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [questionsById, setQuestionsById] = useState<Map<number, Question>>(new Map());
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [modeFilter, setModeFilter] = useState<SelectionMode | 'all'>('all');
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Live Preview state
  const [previewLoadingId, setPreviewLoadingId] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<{
    template: PublicTemplateMetadata;
    questions: CandidateQuestion[];
  } | null>(null);

  // Clone Modal state
  const [cloningTemplate, setCloningTemplate] = useState<Template | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneSlug, setCloneSlug] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  // Delete Modal state
  const [deletingTemplate, setDeletingTemplate] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tpls, qs] = await Promise.all([
        api.admin.listTemplates(),
        api.admin.listQuestions(),
      ]);
      setTemplates(tpls);
      setAllQuestions(qs);
      setQuestionsById(new Map(qs.map((q) => [q.id, q])));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.detail : 'Failed to load interview templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (modeFilter !== 'all' && tpl.selection_mode !== modeFilter) return false;
      if (!q) return true;
      return (
        tpl.name.toLowerCase().includes(q) ||
        tpl.role_title.toLowerCase().includes(q) ||
        tpl.slug.toLowerCase().includes(q) ||
        tpl.description.toLowerCase().includes(q)
      );
    });
  }, [templates, search, modeFilter]);

  const handleCopyCandidateLink = async (tpl: Template) => {
    const url = `${window.location.origin}/i/${tpl.slug}`;
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopiedId(tpl.id);
      toast({
        variant: 'success',
        title: 'Candidate link copied',
        description: url,
      });
      window.setTimeout(() => {
        setCopiedId((current) => (current === tpl.id ? null : current));
      }, 2000);
    } else {
      toast({
        variant: 'error',
        title: 'Copy failed',
        description: `Copy manually: /i/${tpl.slug}`,
      });
    }
  };

  const handleOpenPreview = async (tpl: Template) => {
    setPreviewLoadingId(tpl.id);
    try {
      const res = await api.admin.previewTemplate(tpl.id);
      if (res.questions.length === 0) {
        toast({
          variant: 'warning',
          title: 'Template has no resolved questions',
          description:
            tpl.selection_mode === 'curated'
              ? 'Add questions to this curated template before previewing.'
              : 'No active questions match this template’s random pool rules.',
        });
        return;
      }
      const mappedQuestions = mapResolvedToCandidateQuestions(
        res.questions,
        res.template.open_book_policy,
        res.template.allow_code_execution
      );
      const publicMeta = mapTemplateToPublicMetadata(
        res.template,
        mappedQuestions.length,
        status.app_title
      );
      setPreviewData({ template: publicMeta, questions: mappedQuestions });
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Preview failed',
        description: err instanceof ApiError ? err.detail : 'Unable to preview template.',
      });
    } finally {
      setPreviewLoadingId(null);
    }
  };

  const openCloneModal = (tpl: Template) => {
    setCloningTemplate(tpl);
    setCloneName(`${tpl.name} (Copy)`);
    setCloneSlug(`${tpl.slug}-copy`);
    setCloneError(null);
  };

  const handleConfirmClone = async () => {
    if (!cloningTemplate || readOnly) return;
    const trimmedName = cloneName.trim();
    const trimmedSlug = slugifyTemplateName(cloneSlug);
    if (!trimmedName) {
      setCloneError('Template name is required.');
      return;
    }
    if (!trimmedSlug) {
      setCloneError('A valid URL slug (letters, numbers, hyphens) is required.');
      return;
    }

    setCloning(true);
    setCloneError(null);
    try {
      const cloned = await api.admin.cloneTemplate(cloningTemplate.id, {
        name: trimmedName,
        slug: trimmedSlug,
      });
      toast({
        variant: 'success',
        title: 'Template cloned',
        description: `Created "${cloned.name}" (/i/${cloned.slug})`,
      });
      setCloningTemplate(null);
      await loadData();
    } catch (err: unknown) {
      setCloneError(err instanceof ApiError ? err.detail : 'Failed to clone template.');
    } finally {
      setCloning(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingTemplate || readOnly) return;
    setDeleting(true);
    try {
      await api.admin.deleteTemplate(deletingTemplate.id);
      toast({
        variant: 'success',
        title: 'Template deleted',
        description: deletingTemplate.name,
      });
      setDeletingTemplate(null);
      await loadData();
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Delete failed',
        description: err instanceof ApiError ? err.detail : 'Unable to delete template.',
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Interview Templates
            </h1>
            <Badge variant="indigo" size="md">
              {templates.length} {templates.length === 1 ? 'template' : 'templates'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Compose role-specific curated sequences or randomized pools with custom rubrics,
            timers, open-book policies, and sandbox rules.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            disabled={readOnly}
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => navigate('/admin/templates/new')}
            title={readOnly ? 'Disabled in read-only mode' : 'Create a new interview template'}
          >
            New Template
          </Button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between py-3.5">
          <div className="relative flex-1 max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by template name, role title, or slug…"
              aria-label="Search interview templates"
              className="w-full rounded-lg bg-surface-0/90 border border-slate-700/80 pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
            />
          </div>

          <div
            role="group"
            aria-label="Filter templates by selection mode"
            className="inline-flex items-center rounded-lg border border-slate-800 bg-surface-0/80 p-1 self-start sm:self-auto"
          >
            {(
              [
                { id: 'all', label: 'All Modes' },
                { id: 'curated', label: 'Curated' },
                { id: 'random_pool', label: 'Random Pool' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={modeFilter === opt.id}
                onClick={() => setModeFilter(opt.id)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors focus-ring',
                  modeFilter === opt.id
                    ? 'bg-indigo-600/90 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Main Content */}
      {error && (
        <Alert variant="error" title="Could not load templates">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={() => void loadData()}>
              Retry
            </Button>
          </div>
        </Alert>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20">
          <Spinner size="lg" label="Loading templates" />
          <p className="text-sm text-slate-400">Loading interview templates…</p>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <EmptyState
              icon={<Layers className="h-6 w-6" />}
              title={templates.length === 0 ? 'No interview templates yet' : 'No matching templates'}
              description={
                templates.length === 0
                  ? 'Create your first role template to assemble questions, set timers, and generate a candidate link.'
                  : 'Try clearing your search or switching the selection mode filter.'
              }
              action={
                templates.length === 0 && !readOnly ? (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Plus className="h-4 w-4" />}
                    onClick={() => navigate('/admin/templates/new')}
                  >
                    Create First Template
                  </Button>
                ) : search || modeFilter !== 'all' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSearch('');
                      setModeFilter('all');
                    }}
                  >
                    Reset Filters
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filteredTemplates.map((tpl) => {
            const isCurated = tpl.selection_mode === 'curated';
            const curatedCount = tpl.questions.length;
            const curatedPoints = tpl.questions.reduce((sum, item) => {
              const master = questionsById.get(item.question_id);
              const pts = item.points_override ?? master?.default_points ?? 0;
              return sum + pts;
            }, 0);
            const overrideCount = tpl.questions.filter(
              (item) =>
                item.points_override !== null ||
                Boolean(item.expected_answer_override) ||
                Boolean(item.rubric_override)
            ).length;
            const poolStats = !isCurated ? computeRandomPoolCount(tpl, allQuestions) : null;
            const hasPoolShortage =
              poolStats !== null && poolStats.requested > poolStats.available;
            const candidatePath = `/i/${tpl.slug}`;

            return (
              <Card
                key={tpl.id}
                className="flex flex-col justify-between transition-colors hover:border-slate-700/90"
              >
                <CardContent className="space-y-4">
                  {/* Top Row: Name, Role, Badges */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-100 truncate">
                          {tpl.name}
                        </h2>
                        {tpl.is_default && (
                          <Badge variant="amber" size="sm">
                            <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
                            Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs font-medium text-indigo-300/90">{tpl.role_title}</p>
                    </div>

                    <Badge variant={isCurated ? 'indigo' : 'cyan'} size="md">
                      {isCurated ? (
                        <>
                          <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
                          Curated
                        </>
                      ) : (
                        <>
                          <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
                          Random Pool
                        </>
                      )}
                    </Badge>
                  </div>

                  {/* Candidate URL Copy Strip */}
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800/90 bg-surface-0/80 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500 shrink-0">
                        Link
                      </span>
                      <code className="truncate text-xs text-cyan-300">{candidatePath}</code>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleCopyCandidateLink(tpl)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition-colors focus-ring"
                        aria-label={`Copy candidate link for ${tpl.name}`}
                      >
                        {copiedId === tpl.id ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                            <span className="text-emerald-300">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                      <Link
                        to={candidatePath}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-cyan-300 transition-colors focus-ring"
                        aria-label={`Open candidate portal for ${tpl.name} in new tab`}
                        title="Open candidate portal"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </div>
                  </div>

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="rounded-lg border border-slate-800/80 bg-surface-0/50 px-3 py-2">
                      <p className="text-[11px] text-slate-400">Questions</p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-100">
                        {isCurated ? curatedCount : poolStats?.requested ?? 0}
                        {!isCurated && poolStats && (
                          <span
                            className={cn(
                              'ml-1.5 text-[11px] font-normal',
                              hasPoolShortage ? 'text-amber-400' : 'text-slate-400'
                            )}
                          >
                            / {poolStats.available} pool
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="rounded-lg border border-slate-800/80 bg-surface-0/50 px-3 py-2">
                      <p className="text-[11px] text-slate-400">Total Points</p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-100">
                        {isCurated ? `${curatedPoints} pts` : 'Dynamic'}
                      </p>
                    </div>

                    <div className="rounded-lg border border-slate-800/80 bg-surface-0/50 px-3 py-2">
                      <p className="text-[11px] text-slate-400">Timer</p>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-sm font-semibold text-slate-100">
                        <Clock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                        {tpl.timer_minutes}m
                      </p>
                    </div>
                  </div>

                  {/* Capability & Policy Badges */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="slate" size="sm">
                      <BookOpen className="h-3 w-3" aria-hidden="true" />
                      {OPEN_BOOK_LABELS[tpl.open_book_policy]}
                    </Badge>
                    {tpl.allow_code_execution && (
                      <Badge variant="emerald" size="sm">
                        <Code2 className="h-3 w-3" aria-hidden="true" />
                        Code Exec
                      </Badge>
                    )}
                    {tpl.allow_package_install && (
                      <Badge variant="cyan" size="sm">
                        <Package className="h-3 w-3" aria-hidden="true" />
                        Pip Install
                      </Badge>
                    )}
                    {tpl.access_code.trim() && (
                      <Badge variant="amber" size="sm">
                        <KeyRound className="h-3 w-3" aria-hidden="true" />
                        Access Code
                      </Badge>
                    )}
                    {isCurated && overrideCount > 0 && (
                      <Badge variant="indigo" size="sm">
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                        {overrideCount} custom {overrideCount === 1 ? 'override' : 'overrides'}
                      </Badge>
                    )}
                    {hasPoolShortage && (
                      <Badge variant="rose" size="sm">
                        Pool shortage
                      </Badge>
                    )}
                  </div>

                  {/* Summary Dimensions Preview */}
                  {tpl.summary_dimensions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-800/70">
                      <span className="text-[11px] text-slate-500 mr-1">AI Dimensions:</span>
                      {tpl.summary_dimensions.map((dim) => (
                        <span
                          key={dim}
                          className="rounded-md bg-slate-800/80 px-2 py-0.5 text-[11px] text-slate-300"
                        >
                          {dim}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>

                {/* Actions Footer */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 bg-surface-0/40 px-5 py-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={previewLoadingId === tpl.id}
                    leftIcon={<Eye className="h-3.5 w-3.5" />}
                    onClick={() => void handleOpenPreview(tpl)}
                  >
                    Live Preview
                  </Button>

                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<Pencil className="h-3.5 w-3.5" />}
                      onClick={() => navigate(`/admin/templates/${tpl.id}`)}
                    >
                      {readOnly ? 'Inspect' : 'Edit'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={readOnly}
                      leftIcon={<Copy className="h-3.5 w-3.5" />}
                      onClick={() => openCloneModal(tpl)}
                      title={readOnly ? 'Disabled in read-only mode' : 'Clone template'}
                    >
                      Clone
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={readOnly}
                      onClick={() => setDeletingTemplate(tpl)}
                      className="text-slate-400 hover:text-rose-300 hover:bg-rose-500/10"
                      aria-label={`Delete template ${tpl.name}`}
                      title={readOnly ? 'Disabled in read-only mode' : 'Delete template'}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Clone Template Modal */}
      <Modal
        open={Boolean(cloningTemplate)}
        onClose={() => {
          if (!cloning) setCloningTemplate(null);
        }}
        dismissible={!cloning}
        title="Clone Interview Template"
        description={
          cloningTemplate
            ? `Create an independent copy of "${cloningTemplate.name}" including all curated question overrides and rules.`
            : undefined
        }
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={cloning}
              onClick={() => setCloningTemplate(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={cloning}
              leftIcon={<Copy className="h-3.5 w-3.5" />}
              onClick={() => void handleConfirmClone()}
            >
              Clone Template
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {cloneError && <Alert variant="error">{cloneError}</Alert>}
          <Input
            label="New Template Name"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            placeholder="e.g., Senior Data Engineer (L5)"
            disabled={cloning}
            autoFocus
          />
          <Input
            label="New URL Slug"
            value={cloneSlug}
            onChange={(e) => setCloneSlug(e.target.value)}
            placeholder="e.g., senior-data-engineer-l5"
            hint={`Candidate URL will be /i/${slugifyTemplateName(cloneSlug) || 'your-slug'}`}
            disabled={cloning}
          />
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={Boolean(deletingTemplate)}
        onClose={() => {
          if (!deleting) setDeletingTemplate(null);
        }}
        dismissible={!deleting}
        title="Delete Interview Template?"
        description="Existing candidate submissions are preserved, but the template configuration and candidate link will be removed."
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => setDeletingTemplate(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleting}
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => void handleConfirmDelete()}
            >
              Delete Template
            </Button>
          </>
        }
      >
        {deletingTemplate && (
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3.5 text-xs text-rose-200 space-y-1">
            <p className="font-semibold text-rose-100">{deletingTemplate.name}</p>
            <p className="font-mono text-rose-300/90">/i/{deletingTemplate.slug}</p>
          </div>
        )}
      </Modal>

      {/* Live Candidate Preview Full-Screen Overlay */}
      <TemplatePreviewOverlay
        open={Boolean(previewData)}
        template={previewData?.template ?? null}
        questions={previewData?.questions ?? []}
        onClose={() => setPreviewData(null)}
      />
    </div>
  );
}

export default TemplatesPage;
