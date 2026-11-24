import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Clock,
  Code2,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  ListChecks,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  TerminalSquare,
  X,
  XCircle,
} from 'lucide-react';
import { api, ApiError, triggerBlobDownload } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  DeliveryLogEntry,
  EvaluatedAnswer,
  QuestionDifficulty,
  QuestionFormat,
  Submission,
  SubmissionStatus,
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
  Input,
  Spinner,
  Textarea,
  useToast,
  type BadgeVariant,
} from '../../components/ui';
import {
  parseNotebookValue,
  type NotebookCell,
} from '../../components/candidate/NotebookWorkspace';
import { useAdminContext } from './AdminLayout';

// ---------------------------------------------------------------------------
// Formatting & Metadata Helpers
// ---------------------------------------------------------------------------

const STATUS_META: Record<SubmissionStatus, { label: string; badge: BadgeVariant }> = {
  completed: { label: 'Completed', badge: 'emerald' },
  needs_review: { label: 'Needs Review', badge: 'amber' },
  failed: { label: 'Failed', badge: 'rose' },
  evaluating: { label: 'Evaluating', badge: 'cyan' },
  in_progress: { label: 'In Progress', badge: 'indigo' },
};

const FORMAT_META: Record<
  QuestionFormat,
  { label: string; badge: BadgeVariant; icon: typeof ListChecks }
> = {
  mcq: { label: 'MCQ', badge: 'indigo', icon: ListChecks },
  text: { label: 'Text', badge: 'slate', icon: FileText },
  code: { label: 'Code', badge: 'cyan', icon: Code2 },
  notebook: { label: 'Notebook', badge: 'emerald', icon: TerminalSquare },
};

const DIFFICULTY_META: Record<QuestionDifficulty, { label: string; badge: BadgeVariant }> = {
  easy: { label: 'Easy', badge: 'emerald' },
  medium: { label: 'Medium', badge: 'amber' },
  hard: { label: 'Hard', badge: 'rose' },
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scoreBadgeVariant(pct: number | null): BadgeVariant {
  if (pct === null) return 'slate';
  if (pct >= 75) return 'emerald';
  if (pct >= 50) return 'amber';
  return 'rose';
}

function safeFileSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'candidate'
  );
}

/**
 * Collapse delivery_log into the latest entry per sink (for compact table pills).
 */
function summarizeLatestSinks(log: DeliveryLogEntry[]): DeliveryLogEntry[] {
  const bySink = new Map<string, DeliveryLogEntry>();
  for (const entry of log) {
    if (!entry || !entry.sink) continue;
    // Prefer storage/notify over backup if both share the same sink name
    const key = `${entry.phase ?? 'delivery'}:${entry.sink}`;
    bySink.set(key, entry);
  }
  // Deduplicate by sink name keeping final delivery phase (storage/notify over backup)
  const finalBySink = new Map<string, DeliveryLogEntry>();
  for (const entry of bySink.values()) {
    const existing = finalBySink.get(entry.sink);
    if (!existing || existing.phase === 'backup' || entry.redeliver) {
      finalBySink.set(entry.sink, entry);
    }
  }
  return Array.from(finalBySink.values());
}

// ---------------------------------------------------------------------------
// XSS-Safe HTML Output Renderer for Notebook DataFrame Outputs
// ---------------------------------------------------------------------------

const ALLOWED_HTML_TAGS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'div',
  'span',
  'p',
  'pre',
  'code',
  'strong',
  'em',
  'b',
  'i',
  'ul',
  'ol',
  'li',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'sup',
  'sub',
]);
const ALLOWED_HTML_ATTRS = new Set(['colspan', 'rowspan', 'scope', 'align', 'border']);

function sanitizeHtmlNodes(rawHtml: string, targetDoc: Document): Node[] {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawHtml, 'text/html');

  const cloneSafe = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      return targetDoc.createTextNode(node.textContent ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      return null;
    }
    if (!ALLOWED_HTML_TAGS.has(tag)) {
      const frag = targetDoc.createDocumentFragment();
      el.childNodes.forEach((child) => {
        const safeChild = cloneSafe(child);
        if (safeChild) frag.appendChild(safeChild);
      });
      return frag;
    }
    const cleanEl = targetDoc.createElement(tag);
    for (const attr of Array.from(el.attributes)) {
      if (ALLOWED_HTML_ATTRS.has(attr.name.toLowerCase())) {
        cleanEl.setAttribute(attr.name.toLowerCase(), attr.value);
      }
    }
    el.childNodes.forEach((child) => {
      const safeChild = cloneSafe(child);
      if (safeChild) cleanEl.appendChild(safeChild);
    });
    return cleanEl;
  };

  const result: Node[] = [];
  parsed.body.childNodes.forEach((child) => {
    const safeChild = cloneSafe(child);
    if (safeChild) result.push(safeChild);
  });
  return result;
}

function SafeNotebookHtml({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.textContent = '';

    const setHtmlFn = (host as unknown as { setHTML?: (input: string) => void }).setHTML;
    if (typeof setHtmlFn === 'function') {
      try {
        setHtmlFn.call(host, html);
        return;
      } catch {
        // Fallback below
      }
    }

    const nodes = sanitizeHtmlNodes(html, host.ownerDocument);
    for (const node of nodes) {
      host.appendChild(node);
    }
  }, [html]);

  return <div ref={hostRef} className="notebook-html-output overflow-x-auto" />;
}

// ---------------------------------------------------------------------------
// Notebook & Answer Renderers
// ---------------------------------------------------------------------------

function extractNotebookCells(answer: EvaluatedAnswer): NotebookCell[] | null {
  const raw = answer.candidate_answer ?? answer.answer;
  if (!raw) return null;

  let serialized: string | null = null;
  if (typeof raw === 'string') {
    serialized = raw;
  } else if (typeof raw === 'object') {
    try {
      serialized = JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  if (!serialized || !serialized.trim()) return null;
  const cells = parseNotebookValue(serialized, null);
  return cells.length > 0 ? cells : null;
}

function CandidateAnswerViewer({ item }: { item: EvaluatedAnswer }) {
  const format = item.question_format ?? 'text';
  const rawAnswer = item.candidate_answer ?? item.answer;

  if (format === 'notebook') {
    const cells = extractNotebookCells(item);
    if (cells && cells.some((c) => c.source.trim() || c.stdout || c.html || c.image_png_base64 || c.error)) {
      return (
        <div className="space-y-3">
          {cells.map((cell, idx) => (
            <div
              key={cell.id || idx}
              className="rounded-lg border border-slate-800/90 bg-surface-0/90 overflow-hidden"
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 bg-surface-2/60 px-3 py-1.5 text-[11px]">
                <span className="font-mono font-medium text-slate-300">
                  {cell.type === 'markdown'
                    ? `Cell ${idx + 1} · Markdown`
                    : `In [${cell.execution_count ?? ' '}]:`}
                </span>
                {cell.duration_ms !== null && (
                  <span className="font-mono text-slate-500">{cell.duration_ms}ms</span>
                )}
              </div>

              {cell.type === 'markdown' ? (
                <div className="markdown-body p-3">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {cell.source || '*Empty markdown cell*'}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="overflow-x-auto p-3 text-xs leading-relaxed text-slate-200 custom-scrollbar">
                  <code>{cell.source || '# (empty code cell)'}</code>
                </pre>
              )}

              {(cell.stdout || cell.stderr || cell.error || cell.html || cell.image_png_base64) && (
                <div className="border-t border-slate-800/80 bg-surface-1/70 p-3 space-y-2.5">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    Output
                  </p>
                  {cell.stdout && (
                    <pre className="overflow-x-auto rounded-md bg-surface-0/90 p-2.5 text-xs text-emerald-200 border border-slate-800/80 custom-scrollbar">
                      <code>{cell.stdout}</code>
                    </pre>
                  )}
                  {cell.stderr && (
                    <pre className="overflow-x-auto rounded-md bg-amber-950/30 p-2.5 text-xs text-amber-200 border border-amber-500/25 custom-scrollbar">
                      <code>{cell.stderr}</code>
                    </pre>
                  )}
                  {cell.error && (
                    <pre className="overflow-x-auto rounded-md bg-rose-950/40 p-2.5 text-xs text-rose-200 border border-rose-500/30 custom-scrollbar">
                      <code>{cell.error}</code>
                    </pre>
                  )}
                  {cell.html && <SafeNotebookHtml html={cell.html} />}
                  {cell.image_png_base64 && (
                    <div className="rounded-lg border border-slate-800 bg-white/95 p-2 inline-block max-w-full">
                      <img
                        src={`data:image/png;base64,${cell.image_png_base64}`}
                        alt={`Notebook cell ${idx + 1} plot output`}
                        className="max-h-80 w-auto object-contain"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }
  }

  if (format === 'mcq' && Array.isArray(item.options) && item.options.length > 0) {
    const selectedIndices = new Set<number>(
      Array.isArray(rawAnswer)
        ? rawAnswer.map(Number).filter((n) => Number.isInteger(n))
        : typeof rawAnswer === 'number'
          ? [rawAnswer]
          : []
    );

    return (
      <div className="space-y-1.5">
        {item.options.map((opt, idx) => {
          const isPicked = selectedIndices.has(idx);
          return (
            <div
              key={idx}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs',
                isPicked
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                  : 'border-slate-800/80 bg-surface-0/50 text-slate-400'
              )}
            >
              <span className="font-mono text-[11px] font-semibold shrink-0 mt-0.5">
                {String.fromCharCode(65 + idx)}.
              </span>
              <span className="flex-1">{opt}</span>
              {isPicked && (
                <Badge variant="indigo" size="sm">
                  Selected
                </Badge>
              )}
            </div>
          );
        })}
        {selectedIndices.size === 0 && (
          <p className="text-xs italic text-slate-500">No option selected.</p>
        )}
      </div>
    );
  }

  const displayText =
    item.candidate_answer_text ||
    (typeof rawAnswer === 'string'
      ? rawAnswer
      : rawAnswer !== undefined && rawAnswer !== null
        ? JSON.stringify(rawAnswer, null, 2)
        : '');

  if (!displayText.trim()) {
    return (
      <p className="rounded-lg border border-dashed border-slate-800 bg-surface-0/50 px-3 py-3 text-xs italic text-slate-500">
        No response submitted for this question.
      </p>
    );
  }

  if (format === 'code') {
    return (
      <pre className="overflow-x-auto rounded-lg border border-slate-800/90 bg-surface-0/95 p-3.5 text-xs leading-relaxed text-slate-200 custom-scrollbar">
        <code>{displayText}</code>
      </pre>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800/90 bg-surface-0/80 p-3.5 text-xs leading-relaxed text-slate-200 whitespace-pre-wrap">
      {displayText}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-Question Grading Card
// ---------------------------------------------------------------------------

interface QuestionReviewCardProps {
  item: EvaluatedAnswer;
  index: number;
  submissionId: string;
  readOnly: boolean;
  onSubmissionUpdated: (updated: Submission) => void;
}

function QuestionReviewCard({
  item,
  index,
  submissionId,
  readOnly,
  onSubmissionUpdated,
}: QuestionReviewCardProps) {
  const { toast } = useToast();
  const evaluation = item.evaluation;
  const maxPoints = evaluation?.max_points ?? 0;
  const currentScore = evaluation?.score ?? 0;

  const [editing, setEditing] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [scoreInput, setScoreInput] = useState(String(currentScore));
  const [feedbackInput, setFeedbackInput] = useState(evaluation?.feedback ?? '');
  const [rubricInput, setRubricInput] = useState(
    (evaluation?.rubric_breakdown ?? []).join('\n')
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setScoreInput(String(evaluation?.score ?? 0));
    setFeedbackInput(evaluation?.feedback ?? '');
    setRubricInput((evaluation?.rubric_breakdown ?? []).join('\n'));
  }, [evaluation?.score, evaluation?.feedback, evaluation?.rubric_breakdown]);

  const fmtMeta = FORMAT_META[item.question_format ?? 'text'];
  const diffMeta = DIFFICULTY_META[item.difficulty ?? 'medium'];
  const FmtIcon = fmtMeta.icon;

  const parsedScore = Number(scoreInput);
  const previewPct =
    Number.isFinite(parsedScore) && maxPoints > 0
      ? Math.round((Math.max(0, Math.min(maxPoints, parsedScore)) / maxPoints) * 1000) / 10
      : 0;

  const handleSaveGrade = async () => {
    if (readOnly) return;
    setSaveError(null);
    const numScore = Number(scoreInput);
    if (!Number.isFinite(numScore) || numScore < 0 || numScore > maxPoints) {
      setSaveError(`Score must be between 0 and ${maxPoints}.`);
      return;
    }

    const rubricLines = rubricInput
      .split('\n')
      .map((line) => line.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean);

    setSaving(true);
    try {
      const updated = await api.admin.overrideGrade(submissionId, {
        question_id: item.question_id,
        score: numScore,
        feedback: feedbackInput.trim(),
        rubric_breakdown: rubricLines,
      });
      onSubmissionUpdated(updated);
      setEditing(false);
      toast({
        variant: 'success',
        title: 'Grade updated',
        description: `Q${index + 1} updated to ${numScore} / ${maxPoints} pts. Total score & PDF refreshed.`,
      });
    } catch (err: unknown) {
      setSaveError(err instanceof ApiError ? err.detail : 'Failed to save grade override.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      className={cn(
        evaluation?.needs_manual_review && 'border-amber-500/40',
        evaluation?.manually_overridden && 'border-cyan-500/35'
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-md bg-slate-800 px-1.5 font-mono text-xs font-semibold text-slate-300">
                Q{index + 1}
              </span>
              <h3 className="text-sm font-semibold text-slate-100">
                {item.title || `Question #${item.question_id}`}
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={fmtMeta.badge} size="sm">
                <FmtIcon className="h-3 w-3" aria-hidden="true" />
                {fmtMeta.label}
              </Badge>
              <Badge variant={diffMeta.badge} size="sm">
                {diffMeta.label}
              </Badge>
              {evaluation?.needs_manual_review && (
                <Badge variant="amber" size="sm" dot>
                  Pending Manual Review
                </Badge>
              )}
              {evaluation?.manually_overridden && (
                <Badge variant="cyan" size="sm">
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  Manually Graded
                </Badge>
              )}
              {(item.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-400"
                >
                  #{t}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {evaluation && (
              <Badge variant={scoreBadgeVariant(evaluation.correctness_pct)} size="md">
                {evaluation.score} / {evaluation.max_points} pts ({evaluation.correctness_pct}%)
              </Badge>
            )}
            {!readOnly && evaluation && (
              <Button
                variant={editing ? 'secondary' : 'outline'}
                size="sm"
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => {
                  setEditing((prev) => !prev);
                  setSaveError(null);
                }}
              >
                {editing ? 'Close Editor' : 'Edit Score / Feedback'}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Question Prompt */}
        {item.question_text && (
          <div className="rounded-lg border border-slate-800/80 bg-surface-0/50 p-3.5">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Question Prompt
            </p>
            <div className="markdown-body text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.question_text}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Candidate Answer */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Candidate Answer
          </p>
          <CandidateAnswerViewer item={item} />
        </div>

        {/* Collapsible Expected Answer & Rubric Reference */}
        {(item.expected_answer || item.scoring_criteria) && (
          <div className="rounded-lg border border-slate-800/80 bg-surface-0/40">
            <button
              type="button"
              aria-expanded={showReference}
              onClick={() => setShowReference((prev) => !prev)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:text-white focus-ring rounded-lg"
            >
              <span>Expected Answer & Interviewer Rubric</span>
              {showReference ? (
                <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
              )}
            </button>
            {showReference && (
              <div className="grid grid-cols-1 gap-4 border-t border-slate-800/80 p-3.5 md:grid-cols-2">
                {item.expected_answer && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-emerald-300">Expected Answer</p>
                    <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                      {item.expected_answer}
                    </p>
                  </div>
                )}
                {item.scoring_criteria && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-indigo-300">Evaluation Rubric</p>
                    <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                      {item.scoring_criteria}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Current Evaluation Feedback & Rubric Breakdown */}
        {evaluation && (
          <div className="rounded-xl border border-slate-800/90 bg-surface-2/40 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-200">
                {evaluation.manually_overridden ? 'Reviewer Evaluation' : 'AI Evaluation'}
              </p>
              <span className="font-mono text-xs text-slate-400">
                {evaluation.score} / {evaluation.max_points} pts ({evaluation.correctness_pct}%)
              </span>
            </div>

            {evaluation.feedback && (
              <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                {evaluation.feedback}
              </p>
            )}

            {evaluation.rubric_breakdown && evaluation.rubric_breakdown.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-slate-800/70">
                <p className="text-[11px] font-medium text-slate-400">Rubric Breakdown</p>
                <ul className="list-disc pl-5 space-y-1 text-xs text-slate-300">
                  {evaluation.rubric_breakdown.map((bullet, bIdx) => (
                    <li key={bIdx}>{bullet}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Inline Manual Grade Override Editor */}
        {editing && !readOnly && evaluation && (
          <div className="rounded-xl border border-indigo-500/40 bg-indigo-950/20 p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-indigo-200">
                Manual Score & Feedback Override
              </p>
              <Badge variant="indigo" size="sm">
                Preview: {previewPct}%
              </Badge>
            </div>

            {saveError && <Alert variant="error">{saveError}</Alert>}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input
                label={`Score (0 – ${maxPoints})`}
                type="number"
                min={0}
                max={maxPoints}
                step={0.5}
                disabled={saving}
                value={scoreInput}
                onChange={(e) => setScoreInput(e.target.value)}
              />
            </div>

            <Textarea
              label="Feedback / Justification"
              rows={3}
              disabled={saving}
              value={feedbackInput}
              onChange={(e) => setFeedbackInput(e.target.value)}
              placeholder="Explain why this score was awarded…"
            />

            <Textarea
              label="Rubric Breakdown (one item per line)"
              rows={3}
              disabled={saving}
              value={rubricInput}
              onChange={(e) => setRubricInput(e.target.value)}
              placeholder="e.g., 8/8 pts: Handled edge cases cleanly"
            />

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                leftIcon={<Save className="h-3.5 w-3.5" />}
                onClick={() => void handleSaveGrade()}
              >
                Save Grade
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ResultsPage Component
// ---------------------------------------------------------------------------

export function ResultsPage() {
  const { readOnly } = useAdminContext();
  const { toast } = useToast();

  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SubmissionStatus | 'all'>('all');

  // Detail inspector state
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [regeneratingPdf, setRegeneratingPdf] = useState(false);
  const [redelivering, setRedelivering] = useState(false);

  const tableCaptionId = useId();

  const loadResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.admin.listResults();
      setSubmissions(list);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.detail : 'Failed to load candidate results.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadResults();
  }, [loadResults]);

  const handleSelectSubmission = async (sub: Submission) => {
    setSelectedSubmission(sub);
    setDetailLoading(true);
    try {
      const fresh = await api.admin.getResult(sub.id);
      setSelectedSubmission(fresh);
      setSubmissions((prev) => prev.map((s) => (s.id === fresh.id ? fresh : s)));
    } catch {
      // Keep list snapshot if detail fetch fails
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSubmissionUpdated = (updated: Submission) => {
    setSelectedSubmission(updated);
    setSubmissions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  };

  const handleDownloadPdf = async (sub: Submission) => {
    setDownloadingPdf(true);
    try {
      const blob = await api.admin.fetchResultPdfBlob(sub.id);
      triggerBlobDownload(blob, `${safeFileSlug(sub.candidate_name)}_report.pdf`);
      toast({
        variant: 'success',
        title: 'PDF downloaded',
        description: `${sub.candidate_name} interview report`,
      });
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'PDF download failed',
        description: err instanceof ApiError ? err.detail : 'Unable to fetch PDF report.',
      });
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleRegeneratePdf = async (sub: Submission) => {
    if (readOnly) return;
    setRegeneratingPdf(true);
    try {
      const res = await api.admin.regenerateResultPdf(sub.id);
      const sizeKb = Math.max(1, Math.round(res.size_bytes / 1024));
      toast({
        variant: 'success',
        title: 'PDF regenerated',
        description: `Fresh report rendered (${sizeKb} KB).`,
      });
      if (res.pdf_path) {
        handleSubmissionUpdated({ ...sub, pdf_path: res.pdf_path });
      }
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'PDF regeneration failed',
        description: err instanceof ApiError ? err.detail : 'Unable to regenerate PDF.',
      });
    } finally {
      setRegeneratingPdf(false);
    }
  };

  const handleRedeliver = async (sub: Submission) => {
    if (readOnly) return;
    setRedelivering(true);
    try {
      const res = await api.admin.redeliverResult(sub.id);
      const allOutcomes = [
        ...(res.delivery.storage ?? []),
        ...(res.delivery.notifications ?? []),
      ];
      const okCount = allOutcomes.filter((o) => o.ok).length;
      const failCount = allOutcomes.length - okCount;
      handleSubmissionUpdated({
        ...sub,
        delivery_log: res.delivery_log,
        pdf_path: res.delivery.local_pdf_path ?? sub.pdf_path,
      });
      toast({
        variant: failCount > 0 ? 'warning' : 'success',
        title: 'Re-delivery finished',
        description:
          allOutcomes.length === 0
            ? 'No storage or notification sinks are enabled.'
            : `${okCount} succeeded, ${failCount} failed across configured sinks.`,
      });
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Re-delivery failed',
        description: err instanceof ApiError ? err.detail : 'Unable to re-deliver report.',
      });
    } finally {
      setRedelivering(false);
    }
  };

  const filteredSubmissions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return submissions.filter((sub) => {
      if (statusFilter !== 'all' && sub.status !== statusFilter) return false;
      if (!q) return true;
      return (
        sub.candidate_name.toLowerCase().includes(q) ||
        (sub.candidate_email ?? '').toLowerCase().includes(q) ||
        sub.template_name.toLowerCase().includes(q) ||
        sub.role_title.toLowerCase().includes(q) ||
        sub.id.toLowerCase().includes(q)
      );
    });
  }, [submissions, search, statusFilter]);

  const kpis = useMemo(() => {
    const completed = submissions.filter((s) => s.status === 'completed').length;
    const needsReview = submissions.filter((s) => s.status === 'needs_review').length;
    const scored = submissions.filter((s) => s.score_percentage !== null);
    const avgPct =
      scored.length > 0
        ? Math.round(
            (scored.reduce((sum, s) => sum + (s.score_percentage ?? 0), 0) / scored.length) * 10
          ) / 10
        : null;
    return { total: submissions.length, completed, needsReview, avgPct };
  }, [submissions]);

  // -------------------------------------------------------------------------
  // Detail Inspector View
  // -------------------------------------------------------------------------
  if (selectedSubmission) {
    const sub = selectedSubmission;
    const statusMeta = STATUS_META[sub.status] ?? STATUS_META.completed;
    const summaryDims = Object.entries(sub.summary?.dimensions ?? {});

    return (
      <div className="space-y-6 animate-fade-in">
        {/* Back + Action Bar */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setSelectedSubmission(null)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-indigo-300 transition-colors focus-ring rounded"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to All Results
            </button>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight text-slate-100">
                {sub.candidate_name}
              </h1>
              <Badge variant={statusMeta.badge} size="md" dot>
                {statusMeta.label}
              </Badge>
              {detailLoading && <Spinner size="xs" label="Refreshing submission" />}
            </div>
            <p className="text-xs text-slate-400">
              {sub.candidate_email ? `${sub.candidate_email} · ` : ''}
              {sub.role_title} ({sub.template_name}) · Submitted {formatTimestamp(sub.submitted_at)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={downloadingPdf}
              leftIcon={<Download className="h-3.5 w-3.5" />}
              onClick={() => void handleDownloadPdf(sub)}
            >
              Download PDF
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={regeneratingPdf}
              disabled={readOnly}
              leftIcon={<FileCheck2 className="h-3.5 w-3.5" />}
              onClick={() => void handleRegeneratePdf(sub)}
              title={readOnly ? 'Disabled in read-only mode' : 'Re-render PDF from latest grades'}
            >
              Regenerate PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={redelivering}
              disabled={readOnly}
              leftIcon={<Send className="h-3.5 w-3.5" />}
              onClick={() => void handleRedeliver(sub)}
              title={readOnly ? 'Disabled in read-only mode' : 'Push report to configured sinks'}
            >
              Re-deliver to Sinks
            </Button>
          </div>
        </div>

        {/* Score & Metadata Overview Strip */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card>
            <CardContent className="py-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">Total Score</p>
              <p className="mt-1 text-xl font-bold text-slate-100">
                {sub.final_score !== null && sub.max_score !== null
                  ? `${sub.final_score} / ${sub.max_score}`
                  : '—'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">Percentage</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xl font-bold text-slate-100">
                  {sub.score_percentage !== null ? `${sub.score_percentage}%` : '—'}
                </span>
                {sub.score_percentage !== null && (
                  <Badge variant={scoreBadgeVariant(sub.score_percentage)} size="sm">
                    {sub.score_percentage >= 75
                      ? 'Strong'
                      : sub.score_percentage >= 50
                        ? 'Moderate'
                        : 'Below Target'}
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">Duration</p>
              <p className="mt-1 inline-flex items-center gap-1.5 text-xl font-bold text-slate-100">
                <Clock className="h-4 w-4 text-slate-400" aria-hidden="true" />
                {formatDuration(sub.duration_seconds)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3.5">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">Questions</p>
              <p className="mt-1 text-xl font-bold text-slate-100">{sub.answers.length}</p>
            </CardContent>
          </Card>
        </div>

        {/* AI Overall Summary & Custom Dimensions */}
        {sub.summary && (
          <Card>
            <CardHeader>
              <CardTitle>AI Overall Summary</CardTitle>
              <CardDescription>
                Holistic evaluation across overall performance and template summary dimensions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {sub.summary.overall_feedback && (
                <div className="rounded-lg border border-slate-800/80 bg-surface-0/70 p-3.5 text-xs leading-relaxed text-slate-200 whitespace-pre-wrap">
                  {sub.summary.overall_feedback}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {sub.summary.strengths && (
                  <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5 space-y-1.5">
                    <p className="text-xs font-semibold text-emerald-300">Key Strengths</p>
                    <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                      {sub.summary.strengths}
                    </p>
                  </div>
                )}
                {sub.summary.areas_of_opportunity && (
                  <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3.5 space-y-1.5">
                    <p className="text-xs font-semibold text-amber-300">Areas of Opportunity</p>
                    <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                      {sub.summary.areas_of_opportunity}
                    </p>
                  </div>
                )}
              </div>

              {summaryDims.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-slate-800/80">
                  <p className="text-xs font-semibold text-slate-300">Custom Evaluation Dimensions</p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {summaryDims.map(([dimName, dimFeedback]) => (
                      <div
                        key={dimName}
                        className="rounded-lg border border-slate-800/90 bg-surface-0/60 p-3 space-y-1"
                      >
                        <p className="text-xs font-semibold text-cyan-300">{dimName}</p>
                        <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                          {dimFeedback}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Per-Question Answers & Manual Grading */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-100">
              Question-by-Question Review ({sub.answers.length})
            </h2>
            {sub.status === 'needs_review' && (
              <Badge variant="amber" size="md" dot>
                Manual review required
              </Badge>
            )}
          </div>

          {sub.answers.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-xs text-slate-400">
                No evaluated answers recorded on this submission.
              </CardContent>
            </Card>
          ) : (
            sub.answers.map((ans, idx) => (
              <QuestionReviewCard
                key={`${ans.question_id}-${idx}`}
                item={ans}
                index={idx}
                submissionId={sub.id}
                readOnly={readOnly}
                onSubmissionUpdated={handleSubmissionUpdated}
              />
            ))
          )}
        </div>

        {/* Delivery Log Card */}
        <Card>
          <CardHeader>
            <CardTitle>Sink Delivery Log</CardTitle>
            <CardDescription>
              Audit trail of raw backups, storage uploads, and notification dispatches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sub.delivery_log.length === 0 ? (
              <p className="text-xs text-slate-400">No delivery events logged yet.</p>
            ) : (
              <div className="space-y-2">
                {sub.delivery_log.map((entry, idx) => (
                  <div
                    key={`${entry.sink}-${entry.timestamp ?? idx}-${idx}`}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-lg border px-3.5 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between',
                      entry.ok
                        ? 'border-slate-800/90 bg-surface-0/60'
                        : 'border-rose-500/35 bg-rose-500/5'
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      {entry.ok ? (
                        <CheckCircle2
                          className="h-4 w-4 shrink-0 text-emerald-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                      )}
                      <span className="font-mono font-semibold text-slate-100">{entry.sink}</span>
                      {entry.phase && (
                        <Badge variant="slate" size="sm">
                          {entry.phase}
                        </Badge>
                      )}
                      {entry.redeliver && (
                        <Badge variant="indigo" size="sm">
                          Re-delivered
                        </Badge>
                      )}
                      {entry.error && <span className="text-rose-300">{entry.error}</span>}
                      {entry.detail && !entry.error && (
                        <span className="text-slate-400">{entry.detail}</span>
                      )}
                      {entry.uri && (
                        <code className="truncate max-w-md text-[11px] text-slate-400">
                          {entry.uri}
                        </code>
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0 text-[11px] text-slate-500">
                      {entry.url && /^https?:\/\//i.test(entry.url) && (
                        <a
                          href={entry.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                        >
                          Open
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      )}
                      {entry.timestamp && <span>{formatTimestamp(entry.timestamp)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Submissions List View
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Candidate Results</h1>
            <Badge variant="indigo" size="md">
              {submissions.length} {submissions.length === 1 ? 'submission' : 'submissions'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Inspect candidate answers and notebook outputs, override scores manually, regenerate
            PDFs, and monitor sink delivery status.
          </p>
        </div>

        <Button
          variant="secondary"
          size="md"
          loading={loading}
          leftIcon={<RefreshCw className="h-4 w-4" />}
          onClick={() => void loadResults()}
        >
          Refresh
        </Button>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardContent className="py-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Total Sessions</p>
            <p className="mt-1 text-xl font-bold text-slate-100">{kpis.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Completed</p>
            <p className="mt-1 text-xl font-bold text-emerald-300">{kpis.completed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Needs Review</p>
            <p className="mt-1 text-xl font-bold text-amber-300">{kpis.needsReview}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Average Score</p>
            <p className="mt-1 text-xl font-bold text-cyan-300">
              {kpis.avgPct !== null ? `${kpis.avgPct}%` : '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search & Status Filters */}
      <Card>
        <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between py-3.5">
          <div className="relative flex-1 max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by candidate, email, role, or template…"
              aria-label="Search candidate submissions"
              className="w-full rounded-lg bg-surface-0/90 border border-slate-700/80 pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
            />
          </div>

          <div
            role="group"
            aria-label="Filter submissions by status"
            className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-surface-0/80 p-1"
          >
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'completed', label: 'Completed' },
                { id: 'needs_review', label: 'Needs Review' },
                { id: 'failed', label: 'Failed' },
                { id: 'in_progress', label: 'In Progress' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={statusFilter === opt.id}
                onClick={() => setStatusFilter(opt.id)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
                  statusFilter === opt.id
                    ? 'bg-indigo-600/90 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="error" title="Could not load results">
          {error}
        </Alert>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20">
          <Spinner size="lg" label="Loading submissions" />
          <p className="text-sm text-slate-400">Loading candidate submissions…</p>
        </div>
      ) : filteredSubmissions.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <EmptyState
              icon={<ClipboardCheck className="h-6 w-6" />}
              title={submissions.length === 0 ? 'No submissions yet' : 'No matching submissions'}
              description={
                submissions.length === 0
                  ? 'Completed and in-progress candidate assessments will appear here for review, grading, and PDF download.'
                  : 'Try clearing your search term or switching the status filter.'
              }
              action={
                search || statusFilter !== 'all' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSearch('');
                      setStatusFilter('all');
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
        <Card className="overflow-hidden">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={tableCaptionId}
            className="overflow-x-auto max-h-[70vh] custom-scrollbar focus-ring"
          >
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              <caption id={tableCaptionId} className="sr-only">
                Candidate interview submissions list
              </caption>
              <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur-sm text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold whitespace-nowrap"
                  >
                    Candidate
                  </th>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold whitespace-nowrap"
                  >
                    Template & Role
                  </th>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold whitespace-nowrap"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold whitespace-nowrap"
                  >
                    Score
                  </th>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold whitespace-nowrap"
                  >
                    Duration
                  </th>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold whitespace-nowrap"
                  >
                    Delivery Sinks
                  </th>
                  <th
                    scope="col"
                    className="border-b border-slate-800 px-4 py-3 font-semibold text-right whitespace-nowrap"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredSubmissions.map((sub) => {
                  const statusMeta = STATUS_META[sub.status] ?? STATUS_META.completed;
                  const sinkSummary = summarizeLatestSinks(sub.delivery_log ?? []);

                  return (
                    <tr
                      key={sub.id}
                      onClick={() => void handleSelectSubmission(sub)}
                      className="cursor-pointer transition-colors hover:bg-indigo-500/5"
                    >
                      <th
                        scope="row"
                        className="px-4 py-3.5 font-normal align-top whitespace-nowrap"
                      >
                        <p className="font-semibold text-slate-100">{sub.candidate_name}</p>
                        <p className="text-[11px] text-slate-400">
                          {sub.candidate_email || formatTimestamp(sub.submitted_at ?? sub.started_at)}
                        </p>
                      </th>
                      <td className="px-4 py-3.5 align-top">
                        <p className="font-medium text-slate-200">{sub.role_title}</p>
                        <p className="text-[11px] text-slate-400">{sub.template_name}</p>
                      </td>
                      <td className="px-4 py-3.5 align-top whitespace-nowrap">
                        <Badge variant={statusMeta.badge} size="sm" dot>
                          {statusMeta.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3.5 align-top whitespace-nowrap">
                        {sub.score_percentage !== null ? (
                          <div className="space-y-0.5">
                            <Badge variant={scoreBadgeVariant(sub.score_percentage)} size="sm">
                              {sub.score_percentage}%
                            </Badge>
                            {sub.final_score !== null && sub.max_score !== null && (
                              <p className="font-mono text-[11px] text-slate-400">
                                {sub.final_score} / {sub.max_score} pts
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 align-top whitespace-nowrap font-mono text-slate-300">
                        {formatDuration(sub.duration_seconds)}
                      </td>
                      <td className="px-4 py-3.5 align-top">
                        {sinkSummary.length === 0 ? (
                          <span className="text-[11px] text-slate-500">None</span>
                        ) : (
                          <div className="flex flex-wrap gap-1 max-w-[220px]">
                            {sinkSummary.map((entry) => (
                              <span
                                key={entry.sink}
                                title={
                                  entry.ok
                                    ? `${entry.sink}: OK${entry.uri ? ` (${entry.uri})` : ''}`
                                    : `${entry.sink}: ${entry.error ?? 'Failed'}`
                                }
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium',
                                  entry.ok
                                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                                    : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                                )}
                              >
                                {entry.ok ? (
                                  <Check className="h-2.5 w-2.5" aria-hidden="true" />
                                ) : (
                                  <X className="h-2.5 w-2.5" aria-hidden="true" />
                                )}
                                {entry.sink}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-4 py-3.5 align-top text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleSelectSubmission(sub)}
                          >
                            Inspect
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Download PDF report for ${sub.candidate_name}`}
                            title="Download PDF"
                            onClick={() => void handleDownloadPdf(sub)}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

export default ResultsPage;
