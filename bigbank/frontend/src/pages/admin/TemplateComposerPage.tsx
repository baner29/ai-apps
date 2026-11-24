import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Eye,
  FileText,
  GripVertical,
  ListChecks,
  ListOrdered,
  Plus,
  RotateCcw,
  Save,
  Search,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
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
  QuestionDifficulty,
  QuestionFormat,
  ResolvedTemplateQuestion,
  SelectionMode,
  TagMatchMode,
  TagSummary,
  TemplateCreatePayload,
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
  Select,
  Spinner,
  Textarea,
  useToast,
  type BadgeVariant,
} from '../../components/ui';
import { TagInput } from '../../components/admin/TagInput';
import { useAdminContext } from './AdminLayout';
import {
  mapResolvedToCandidateQuestions,
  mapTemplateToPublicMetadata,
  slugifyTemplateName,
  TemplatePreviewOverlay,
} from './TemplatesPage';

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

interface CuratedEntry {
  question_id: number;
  points_override: number | null;
  expected_answer_override: string | null;
  rubric_override: string | null;
}

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

const SUGGESTED_DIMENSIONS = [
  'Technical Depth',
  'Problem Solving',
  'System Architecture',
  'Code Quality & Testing',
  'Communication & Clarity',
  'Data Modeling & SQL',
  'AI / ML Rigor',
  'Product Thinking',
];

const DEFAULT_SUMMARY_DIMENSIONS = [
  'Technical Depth',
  'Problem Solving',
  'Communication & Clarity',
];

// ---------------------------------------------------------------------------
// Sortable Curated Question Item
// ---------------------------------------------------------------------------

interface SortableQuestionRowProps {
  entry: CuratedEntry;
  question: Question | undefined;
  index: number;
  totalCount: number;
  expanded: boolean;
  readOnly: boolean;
  onToggleExpand: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onChangeOverride: (patch: Partial<CuratedEntry>) => void;
}

function SortableQuestionRow({
  entry,
  question,
  index,
  totalCount,
  expanded,
  readOnly,
  onToggleExpand,
  onMoveUp,
  onMoveDown,
  onRemove,
  onChangeOverride,
}: SortableQuestionRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.question_id, disabled: readOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const fmtMeta = question ? FORMAT_META[question.format] : FORMAT_META.text;
  const diffMeta = question ? DIFFICULTY_META[question.difficulty] : DIFFICULTY_META.medium;
  const FmtIcon = fmtMeta.icon;

  const hasPointsOverride = entry.points_override !== null;
  const hasAnswerOverride =
    entry.expected_answer_override !== null && entry.expected_answer_override.trim().length > 0;
  const hasRubricOverride =
    entry.rubric_override !== null && entry.rubric_override.trim().length > 0;
  const overrideCount =
    (hasPointsOverride ? 1 : 0) + (hasAnswerOverride ? 1 : 0) + (hasRubricOverride ? 1 : 0);

  const effectivePoints = entry.points_override ?? question?.default_points ?? 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-xl border bg-surface-0/85 transition-colors',
        isDragging
          ? 'z-30 border-indigo-500/80 bg-surface-2/95 shadow-2xl shadow-indigo-950/60 ring-2 ring-indigo-500/30'
          : overrideCount > 0
            ? 'border-indigo-500/35 hover:border-indigo-500/55'
            : 'border-slate-800/90 hover:border-slate-700/90'
      )}
    >
      {/* Main Row */}
      <div className="flex items-start gap-2.5 p-3">
        {/* Drag Handle */}
        <button
          type="button"
          disabled={readOnly}
          aria-label={`Drag to reorder question ${index + 1}: ${question?.title ?? `#${entry.question_id}`}`}
          className={cn(
            'mt-0.5 rounded-md p-1 text-slate-500 transition-colors focus-ring',
            readOnly
              ? 'opacity-40 cursor-not-allowed'
              : 'cursor-grab active:cursor-grabbing hover:bg-slate-800 hover:text-slate-200'
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>

        {/* Position Badge */}
        <span className="mt-0.5 inline-flex h-6 min-w-[26px] items-center justify-center rounded-md bg-slate-800/90 px-1.5 font-mono text-[11px] font-semibold text-slate-300 shrink-0">
          #{index + 1}
        </span>

        {/* Question Summary */}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-slate-100 truncate">
              {question?.title ?? `Question #${entry.question_id}`}
            </p>
            {question && !question.active && (
              <Badge variant="rose" size="sm">
                Inactive
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={fmtMeta.badge} size="sm">
              <FmtIcon className="h-3 w-3" aria-hidden="true" />
              {fmtMeta.label}
            </Badge>
            <Badge variant={diffMeta.badge} size="sm">
              {diffMeta.label}
            </Badge>
            <Badge variant={hasPointsOverride ? 'cyan' : 'slate'} size="sm">
              {effectivePoints} pts{hasPointsOverride ? ' (override)' : ''}
            </Badge>
            {overrideCount > 0 && (
              <Badge variant="indigo" size="sm">
                <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
              </Badge>
            )}
          </div>
        </div>

        {/* Row Controls */}
        <div className="flex items-center gap-1 shrink-0">
          {!readOnly && (
            <div className="hidden sm:flex items-center">
              <button
                type="button"
                disabled={index === 0}
                onClick={onMoveUp}
                aria-label="Move question up"
                title="Move up"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-30 disabled:pointer-events-none focus-ring"
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={index === totalCount - 1}
                onClick={onMoveDown}
                aria-label="Move question down"
                title="Move down"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-30 disabled:pointer-events-none focus-ring"
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggleExpand}
            className={cn(
              'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus-ring',
              expanded || overrideCount > 0
                ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25'
                : 'border-slate-700/80 bg-slate-800/60 text-slate-300 hover:bg-slate-800 hover:text-white'
            )}
          >
            <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
            <span className="hidden sm:inline">Customize</span>
            {expanded ? (
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            )}
          </button>

          {!readOnly && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${question?.title ?? 'question'} from template`}
              title="Remove from sequence"
              className="rounded-md p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300 transition-colors focus-ring"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Expandable Per-Question Override Drawer */}
      {expanded && (
        <div className="border-t border-slate-800/90 bg-surface-1/80 px-4 py-3.5 space-y-4 rounded-b-xl">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-400">
              Overrides apply <strong className="text-slate-200">only to this template</strong> and
              never alter the master question bank. Leave blank to inherit master values.
            </p>
            {overrideCount > 0 && !readOnly && (
              <button
                type="button"
                onClick={() =>
                  onChangeOverride({
                    points_override: null,
                    expected_answer_override: null,
                    rubric_override: null,
                  })
                }
                className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300 hover:text-amber-200 focus-ring rounded px-1.5 py-0.5"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Reset all overrides
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              label="Weightage / Points Override"
              type="number"
              min={1}
              max={500}
              disabled={readOnly}
              value={entry.points_override === null ? '' : String(entry.points_override)}
              placeholder={`Master: ${question?.default_points ?? 10} pts`}
              hint="Clear to inherit master points"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) {
                  onChangeOverride({ points_override: null });
                } else {
                  const num = Math.max(1, Math.round(Number(raw)));
                  if (Number.isFinite(num)) {
                    onChangeOverride({ points_override: num });
                  }
                }
              }}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">Expected Answer Override</span>
              {!readOnly && question?.expected_answer && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onChangeOverride({ expected_answer_override: question.expected_answer })
                    }
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 focus-ring rounded px-1"
                  >
                    Copy master
                  </button>
                  {hasAnswerOverride && (
                    <button
                      type="button"
                      onClick={() => onChangeOverride({ expected_answer_override: null })}
                      className="text-[11px] text-slate-400 hover:text-slate-200 focus-ring rounded px-1"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
            <Textarea
              rows={3}
              disabled={readOnly}
              aria-label="Expected Answer Override"
              value={entry.expected_answer_override ?? ''}
              placeholder={
                question?.expected_answer
                  ? `Inheriting master: ${question.expected_answer.slice(0, 140)}${question.expected_answer.length > 140 ? '…' : ''}`
                  : 'Optional template-specific reference answer…'
              }
              onChange={(e) =>
                onChangeOverride({
                  expected_answer_override: e.target.value ? e.target.value : null,
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">Evaluation Rubric Override</span>
              {!readOnly && question?.evaluation_rubric && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onChangeOverride({ rubric_override: question.evaluation_rubric })
                    }
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 focus-ring rounded px-1"
                  >
                    Copy master
                  </button>
                  {hasRubricOverride && (
                    <button
                      type="button"
                      onClick={() => onChangeOverride({ rubric_override: null })}
                      className="text-[11px] text-slate-400 hover:text-slate-200 focus-ring rounded px-1"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
            <Textarea
              rows={3}
              disabled={readOnly}
              aria-label="Evaluation Rubric Override"
              value={entry.rubric_override ?? ''}
              placeholder={
                question?.evaluation_rubric
                  ? `Inheriting master: ${question.evaluation_rubric.slice(0, 140)}${question.evaluation_rubric.length > 140 ? '…' : ''}`
                  : 'Optional template-specific rubric criteria…'
              }
              onChange={(e) =>
                onChangeOverride({
                  rubric_override: e.target.value ? e.target.value : null,
                })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplateComposerPage Component
// ---------------------------------------------------------------------------

export function TemplateComposerPage() {
  const { id } = useParams<{ id?: string }>();
  const isEditing = Boolean(id);
  const templateId = id ? Number(id) : null;

  const { status, readOnly } = useAdminContext();
  const { toast } = useToast();
  const navigate = useNavigate();

  // Catalog data
  const [bankQuestions, setBankQuestions] = useState<Question[]>([]);
  const [availableTags, setAvailableTags] = useState<TagSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Template Settings form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [roleTitle, setRoleTitle] = useState('');
  const [description, setDescription] = useState('');
  const [timerMinutes, setTimerMinutes] = useState(45);
  const [accessCode, setAccessCode] = useState('');
  const [openBookPolicy, setOpenBookPolicy] = useState<OpenBookPolicy>('none');
  const [allowCodeExecution, setAllowCodeExecution] = useState(true);
  const [allowPackageInstall, setAllowPackageInstall] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [summaryDimensions, setSummaryDimensions] = useState<string[]>(DEFAULT_SUMMARY_DIMENSIONS);
  const [dimensionInput, setDimensionInput] = useState('');

  // Selection mode
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('curated');

  // Curated mode state
  const [curatedItems, setCuratedItems] = useState<CuratedEntry[]>([]);
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Set<number>>(new Set());

  // Bank pane filters (Curated mode left pane)
  const [bankSearch, setBankSearch] = useState('');
  const [bankTags, setBankTags] = useState<string[]>([]);
  const [bankFormat, setBankFormat] = useState<QuestionFormat | ''>('');
  const [bankDifficulty, setBankDifficulty] = useState<QuestionDifficulty | ''>('');
  const [bankActiveOnly, setBankActiveOnly] = useState(true);

  // Random pool mode state
  const [poolTags, setPoolTags] = useState<string[]>([]);
  const [poolMatch, setPoolMatch] = useState<TagMatchMode>('any');
  const [poolEasy, setPoolEasy] = useState(2);
  const [poolMedium, setPoolMedium] = useState(2);
  const [poolHard, setPoolHard] = useState(1);

  // Save & Preview state
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    template: PublicTemplateMetadata;
    questions: CandidateQuestion[];
  } | null>(null);

  const dimensionInputId = useId();

  // Sensors for @dnd-kit
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const loadComposerData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    if (isEditing && (!templateId || !Number.isFinite(templateId))) {
      setLoadError('Invalid template ID in URL.');
      setLoading(false);
      return;
    }
    try {
      const [qs, tags, tpl] = await Promise.all([
        api.admin.listQuestions(),
        api.admin.listTags(),
        isEditing && templateId
          ? api.admin.getTemplate(templateId)
          : Promise.resolve(null),
      ]);

      setBankQuestions(qs);
      setAvailableTags(tags);

      if (tpl) {
        setName(tpl.name);
        setSlug(tpl.slug);
        setSlugManuallyEdited(true);
        setRoleTitle(tpl.role_title);
        setDescription(tpl.description ?? '');
        setTimerMinutes(tpl.timer_minutes);
        setAccessCode(tpl.access_code ?? '');
        setOpenBookPolicy(tpl.open_book_policy);
        setAllowCodeExecution(tpl.allow_code_execution);
        setAllowPackageInstall(tpl.allow_package_install);
        setIsDefault(tpl.is_default);
        setSummaryDimensions(
          tpl.summary_dimensions && tpl.summary_dimensions.length > 0
            ? tpl.summary_dimensions
            : []
        );
        setSelectionMode(tpl.selection_mode);

        const sortedCurated = [...(tpl.questions ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((q) => ({
            question_id: q.question_id,
            points_override: q.points_override,
            expected_answer_override: q.expected_answer_override,
            rubric_override: q.rubric_override,
          }));
        setCuratedItems(sortedCurated);

        if (tpl.random_rules) {
          setPoolTags(tpl.random_rules.tags ?? []);
          setPoolMatch(tpl.random_rules.match === 'all' ? 'all' : 'any');
          const dc = tpl.random_rules.difficulty_counts ?? {};
          setPoolEasy(Math.max(0, Number(dc.easy ?? 0)));
          setPoolMedium(Math.max(0, Number(dc.medium ?? 0)));
          setPoolHard(Math.max(0, Number(dc.hard ?? 0)));
        }
      }
    } catch (err: unknown) {
      setLoadError(
        err instanceof ApiError ? err.detail : 'Failed to load template composer data.'
      );
    } finally {
      setLoading(false);
    }
  }, [isEditing, templateId]);

  useEffect(() => {
    void loadComposerData();
  }, [loadComposerData]);

  const questionsById = useMemo(
    () => new Map(bankQuestions.map((q) => [q.id, q])),
    [bankQuestions]
  );

  const curatedIdSet = useMemo(
    () => new Set(curatedItems.map((item) => item.question_id)),
    [curatedItems]
  );

  // Filtered Bank Questions (Curated Mode Left Pane)
  const filteredBankQuestions = useMemo(() => {
    const qLower = bankSearch.trim().toLowerCase();
    const filterTagLower = bankTags.map((t) => t.toLowerCase());
    return bankQuestions.filter((q) => {
      if (bankActiveOnly && !q.active) return false;
      if (bankFormat && q.format !== bankFormat) return false;
      if (bankDifficulty && q.difficulty !== bankDifficulty) return false;
      if (filterTagLower.length > 0) {
        const qTagSet = new Set(q.tags.map((t) => t.toLowerCase()));
        if (!filterTagLower.some((t) => qTagSet.has(t))) return false;
      }
      if (qLower) {
        const inTitle = q.title.toLowerCase().includes(qLower);
        const inPrompt = q.prompt.toLowerCase().includes(qLower);
        const inTags = q.tags.some((t) => t.toLowerCase().includes(qLower));
        if (!inTitle && !inPrompt && !inTags) return false;
      }
      return true;
    });
  }, [bankQuestions, bankActiveOnly, bankFormat, bankDifficulty, bankTags, bankSearch]);

  // Live Curated Stats (Total points + Easy/Medium/Hard difficulty mix)
  const curatedStats = useMemo(() => {
    let totalPoints = 0;
    const counts: Record<QuestionDifficulty, number> = { easy: 0, medium: 0, hard: 0 };
    for (const item of curatedItems) {
      const q = questionsById.get(item.question_id);
      totalPoints += item.points_override ?? q?.default_points ?? 0;
      if (q) {
        counts[q.difficulty] += 1;
      }
    }
    return { totalPoints, counts, totalCount: curatedItems.length };
  }, [curatedItems, questionsById]);

  // Live Random Pool Matching Stats
  const randomPoolStats = useMemo(() => {
    const normTags = poolTags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    const matching = bankQuestions.filter((q) => {
      if (!q.active) return false;
      if (normTags.length === 0) return true;
      const qTags = new Set(q.tags.map((t) => t.toLowerCase()));
      return poolMatch === 'all'
        ? normTags.every((t) => qTags.has(t))
        : normTags.some((t) => qTags.has(t));
    });

    const byDifficulty: Record<QuestionDifficulty, Question[]> = {
      easy: [],
      medium: [],
      hard: [],
    };
    for (const q of matching) {
      byDifficulty[q.difficulty].push(q);
    }

    const requestedTotal = poolEasy + poolMedium + poolHard;
    const shortages: string[] = [];
    if (poolEasy > byDifficulty.easy.length) {
      shortages.push(`Easy: requested ${poolEasy}, only ${byDifficulty.easy.length} available`);
    }
    if (poolMedium > byDifficulty.medium.length) {
      shortages.push(`Medium: requested ${poolMedium}, only ${byDifficulty.medium.length} available`);
    }
    if (poolHard > byDifficulty.hard.length) {
      shortages.push(`Hard: requested ${poolHard}, only ${byDifficulty.hard.length} available`);
    }

    return {
      matching,
      byDifficulty,
      requestedTotal,
      shortages,
    };
  }, [bankQuestions, poolTags, poolMatch, poolEasy, poolMedium, poolHard]);

  // Handlers
  const handleNameChange = (nextName: string) => {
    setName(nextName);
    if (!isEditing && !slugManuallyEdited) {
      setSlug(slugifyTemplateName(nextName));
    }
  };

  const handleAddDimension = (raw?: string) => {
    const cleaned = (raw ?? dimensionInput).trim();
    if (!cleaned || readOnly) return;
    if (!summaryDimensions.some((d) => d.toLowerCase() === cleaned.toLowerCase())) {
      setSummaryDimensions((prev) => [...prev, cleaned]);
    }
    if (raw === undefined) {
      setDimensionInput('');
    }
  };

  const handleDimensionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      handleAddDimension();
    }
  };

  const handleAddQuestion = (question: Question) => {
    if (readOnly || curatedIdSet.has(question.id)) return;
    setCuratedItems((prev) => [
      ...prev,
      {
        question_id: question.id,
        points_override: null,
        expected_answer_override: null,
        rubric_override: null,
      },
    ]);
  };

  const handleRemoveQuestion = (questionId: number) => {
    if (readOnly) return;
    setCuratedItems((prev) => prev.filter((item) => item.question_id !== questionId));
    setExpandedQuestionIds((prev) => {
      const next = new Set(prev);
      next.delete(questionId);
      return next;
    });
  };

  const handleMoveQuestion = (fromIndex: number, toIndex: number) => {
    if (readOnly) return;
    setCuratedItems((prev) => {
      if (toIndex < 0 || toIndex >= prev.length) return prev;
      return arrayMove(prev, fromIndex, toIndex);
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (readOnly) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setCuratedItems((prev) => {
      const oldIndex = prev.findIndex((item) => item.question_id === Number(active.id));
      const newIndex = prev.findIndex((item) => item.question_id === Number(over.id));
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleUpdateOverride = (questionId: number, patch: Partial<CuratedEntry>) => {
    if (readOnly) return;
    setCuratedItems((prev) =>
      prev.map((item) =>
        item.question_id === questionId ? { ...item, ...patch } : item
      )
    );
  };

  const toggleExpandQuestion = (questionId: number) => {
    setExpandedQuestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return next;
    });
  };

  // Live Preview directly from current composer state (works before saving too!)
  const handleLivePreview = () => {
    let resolved: ResolvedTemplateQuestion[] = [];

    if (selectionMode === 'curated') {
      resolved = curatedItems
        .map((entry, idx) => {
          const master = questionsById.get(entry.question_id);
          if (!master) return null;
          return {
            ...master,
            position: idx,
            points_override: entry.points_override,
            expected_answer_override: entry.expected_answer_override,
            rubric_override: entry.rubric_override,
            effective_points: entry.points_override ?? master.default_points,
            effective_expected_answer:
              entry.expected_answer_override ?? master.expected_answer,
            effective_rubric: entry.rubric_override ?? master.evaluation_rubric,
          } satisfies ResolvedTemplateQuestion;
        })
        .filter((item): item is ResolvedTemplateQuestion => item !== null);
    } else {
      const picked: Question[] = [
        ...randomPoolStats.byDifficulty.easy.slice(0, poolEasy),
        ...randomPoolStats.byDifficulty.medium.slice(0, poolMedium),
        ...randomPoolStats.byDifficulty.hard.slice(0, poolHard),
      ];
      resolved = picked.map((q, idx) => ({
        ...q,
        position: idx,
        points_override: null,
        expected_answer_override: null,
        rubric_override: null,
        effective_points: q.default_points,
        effective_expected_answer: q.expected_answer,
        effective_rubric: q.evaluation_rubric,
      }));
    }

    if (resolved.length === 0) {
      toast({
        variant: 'warning',
        title: 'No questions to preview',
        description:
          selectionMode === 'curated'
            ? 'Add at least one question to the curated sequence first.'
            : 'Configure counts and tags that match at least one active question.',
      });
      return;
    }

    const mappedQuestions = mapResolvedToCandidateQuestions(
      resolved,
      openBookPolicy,
      allowCodeExecution
    );
    const meta = mapTemplateToPublicMetadata(
      {
        id: templateId ?? 0,
        slug: slugifyTemplateName(slug) || 'preview-template',
        name: name.trim() || 'Untitled Template',
        role_title: roleTitle.trim() || 'Technical Assessment',
        description,
        timer_minutes: Math.max(1, Number(timerMinutes) || 45),
        open_book_policy: openBookPolicy,
        allow_code_execution: allowCodeExecution,
        allow_package_install: allowPackageInstall,
        access_code: accessCode,
      },
      mappedQuestions.length,
      status.app_title
    );

    setPreviewData({ template: meta, questions: mappedQuestions });
  };

  const handleSave = async () => {
    if (readOnly) return;
    setFormError(null);

    const trimmedName = name.trim();
    const cleanedSlug = slugifyTemplateName(slug);
    const trimmedRole = roleTitle.trim();
    const safeTimer = Math.round(Number(timerMinutes));

    if (!trimmedName) {
      setFormError('Template name is required.');
      return;
    }
    if (!cleanedSlug) {
      setFormError('A valid URL slug (letters, numbers, hyphens) is required.');
      return;
    }
    if (!trimmedRole) {
      setFormError('Role title is required.');
      return;
    }
    if (!Number.isFinite(safeTimer) || safeTimer < 1) {
      setFormError('Timer duration must be at least 1 minute.');
      return;
    }

    const payload: TemplateCreatePayload = {
      name: trimmedName,
      slug: cleanedSlug,
      role_title: trimmedRole,
      description: description.trim(),
      selection_mode: selectionMode,
      timer_minutes: safeTimer,
      open_book_policy: openBookPolicy,
      allow_code_execution: allowCodeExecution,
      allow_package_install: allowPackageInstall,
      access_code: accessCode.trim(),
      summary_dimensions: summaryDimensions,
      is_default: isDefault,
      random_rules:
        selectionMode === 'random_pool'
          ? {
              tags: poolTags,
              match: poolMatch,
              total: poolEasy + poolMedium + poolHard,
              difficulty_counts: {
                easy: poolEasy,
                medium: poolMedium,
                hard: poolHard,
              },
            }
          : null,
      questions:
        selectionMode === 'curated'
          ? curatedItems.map((item, idx) => ({
              question_id: item.question_id,
              position: idx,
              points_override: item.points_override,
              expected_answer_override: item.expected_answer_override,
              rubric_override: item.rubric_override,
            }))
          : [],
    };

    setSaving(true);
    try {
      const saved =
        isEditing && templateId
          ? await api.admin.updateTemplate(templateId, payload)
          : await api.admin.createTemplate(payload);

      toast({
        variant: 'success',
        title: isEditing ? 'Template updated' : 'Template created',
        description: `${saved.name} (/i/${saved.slug})`,
      });
      navigate('/admin/templates');
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.detail : 'Failed to save template.';
      setFormError(msg);
      toast({ variant: 'error', title: 'Save failed', description: msg });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24">
        <Spinner size="lg" label="Loading template composer" />
        <p className="text-sm text-slate-400">Loading template composer…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <Link
          to="/admin/templates"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to Templates
        </Link>
        <Alert variant="error" title="Unable to load template">
          {loadError}
        </Alert>
      </div>
    );
  }

  const easyPct =
    curatedStats.totalCount > 0
      ? Math.round((curatedStats.counts.easy / curatedStats.totalCount) * 100)
      : 0;
  const medPct =
    curatedStats.totalCount > 0
      ? Math.round((curatedStats.counts.medium / curatedStats.totalCount) * 100)
      : 0;
  const hardPct =
    curatedStats.totalCount > 0
      ? Math.max(0, 100 - easyPct - medPct)
      : 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Action Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Link
            to="/admin/templates"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-indigo-300 transition-colors focus-ring rounded"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            All Interview Templates
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            {isEditing ? `Edit Template: ${name || 'Untitled'}` : 'New Interview Template'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            leftIcon={<Eye className="h-4 w-4" />}
            onClick={handleLivePreview}
          >
            Live Preview
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={saving}
            disabled={readOnly}
            leftIcon={<Save className="h-4 w-4" />}
            onClick={() => void handleSave()}
            title={readOnly ? 'Disabled in read-only mode' : 'Save template'}
          >
            {isEditing ? 'Save Changes' : 'Create Template'}
          </Button>
        </div>
      </div>

      {formError && (
        <Alert variant="error" title="Please check template configuration">
          {formError}
        </Alert>
      )}

      {/* Template Settings Card */}
      <Card>
        <CardHeader>
          <CardTitle>Template Settings & Candidate Policies</CardTitle>
          <CardDescription>
            Configure the candidate URL, role framing, time limit, open-book search rules,
            sandbox permissions, and AI evaluation summary dimensions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Input
              label="Template Name"
              required
              disabled={readOnly}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g., AI Data Engineer (L4)"
            />
            <Input
              label="URL Slug"
              required
              disabled={readOnly}
              value={slug}
              onChange={(e) => {
                setSlugManuallyEdited(true);
                setSlug(e.target.value);
              }}
              placeholder="ai-data-engineer-l4"
              hint={`Candidate URL: /i/${slugifyTemplateName(slug) || 'your-slug'}`}
            />
            <Input
              label="Role Title (shown to candidates)"
              required
              disabled={readOnly}
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              placeholder="e.g., Senior AI & Data Engineer"
            />
          </div>

          <Textarea
            label="Candidate Instructions"
            rows={3}
            disabled={readOnly}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Welcome candidates, outline expectations, and explain any role-specific guidance…"
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              label="Timer Duration (Minutes)"
              type="number"
              min={1}
              max={480}
              disabled={readOnly}
              value={String(timerMinutes)}
              onChange={(e) => setTimerMinutes(Math.max(1, Number(e.target.value) || 1))}
            />
            <Input
              label="Access Code (Optional)"
              disabled={readOnly}
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              placeholder="Leave blank for open access"
              hint="Candidates must enter this code before starting."
            />
            <Select
              label="Open-Book Research Policy"
              disabled={readOnly}
              value={openBookPolicy}
              onChange={(e) => setOpenBookPolicy(e.target.value as OpenBookPolicy)}
            >
              <option value="none">Closed Book (Disabled)</option>
              <option value="medium_hard">Medium & Hard Questions Only</option>
              <option value="all">Open Book (All Questions)</option>
            </Select>
          </div>

          {/* Toggle Checkboxes */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 pt-1">
            <label
              className={cn(
                'flex items-start gap-2.5 rounded-lg border border-slate-800/90 bg-surface-0/60 p-3 text-xs transition-colors',
                readOnly ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-slate-700'
              )}
            >
              <input
                type="checkbox"
                checked={allowCodeExecution}
                disabled={readOnly}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setAllowCodeExecution(enabled);
                  if (!enabled) {
                    setAllowPackageInstall(false);
                  }
                }}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
              />
              <div>
                <p className="font-medium text-slate-200">Allow Code Execution</p>
                <p className="text-[11px] text-slate-400">
                  Enable live Python notebook kernel execution for notebook questions.
                </p>
              </div>
            </label>

            <label
              className={cn(
                'flex items-start gap-2.5 rounded-lg border border-slate-800/90 bg-surface-0/60 p-3 text-xs transition-colors',
                readOnly || !allowCodeExecution
                  ? 'opacity-60 cursor-not-allowed'
                  : 'cursor-pointer hover:border-slate-700'
              )}
            >
              <input
                type="checkbox"
                checked={allowPackageInstall}
                disabled={readOnly || !allowCodeExecution}
                onChange={(e) => setAllowPackageInstall(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
              />
              <div>
                <p className="font-medium text-slate-200">Allow Package Install</p>
                <p className="text-[11px] text-slate-400">
                  Allow guarded PyPI installs inside the isolated candidate sandbox.
                </p>
              </div>
            </label>

            <label
              className={cn(
                'flex items-start gap-2.5 rounded-lg border border-slate-800/90 bg-surface-0/60 p-3 text-xs transition-colors',
                readOnly ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-slate-700'
              )}
            >
              <input
                type="checkbox"
                checked={isDefault}
                disabled={readOnly}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
              />
              <div>
                <p className="font-medium text-slate-200">Set as Default Template</p>
                <p className="text-[11px] text-slate-400">
                  Served automatically at the root candidate URL (<code>/</code>).
                </p>
              </div>
            </label>
          </div>

          {/* Custom AI Summary Dimensions Chip Editor */}
          <div className="space-y-2 pt-2 border-t border-slate-800/80">
            <label
              htmlFor={dimensionInputId}
              className="block text-xs font-medium text-slate-300"
            >
              Custom AI Summary Dimensions
            </label>
            <p className="text-[11px] text-slate-400">
              Define the evaluation pillars the AI grader summarizes in the candidate report and
              PDF.
            </p>

            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-700/80 bg-surface-0/90 px-2.5 py-2 min-h-[42px]">
              {summaryDimensions.map((dim) => (
                <span
                  key={dim}
                  className="inline-flex items-center gap-1 rounded-full border border-cyan-500/35 bg-cyan-500/15 px-2.5 py-0.5 text-xs font-medium text-cyan-200"
                >
                  <span>{dim}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() =>
                        setSummaryDimensions((prev) => prev.filter((item) => item !== dim))
                      }
                      aria-label={`Remove dimension ${dim}`}
                      className="rounded-full p-0.5 text-cyan-300 hover:bg-cyan-500/30 hover:text-white focus-ring"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </span>
              ))}

              {!readOnly && (
                <div className="flex flex-1 items-center gap-1.5 min-w-[180px]">
                  <input
                    id={dimensionInputId}
                    type="text"
                    value={dimensionInput}
                    onChange={(e) => setDimensionInput(e.target.value)}
                    onKeyDown={handleDimensionKeyDown}
                    placeholder="Add dimension (Enter)…"
                    className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!dimensionInput.trim()}
                    onClick={() => handleAddDimension()}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>

            {!readOnly && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-[11px] text-slate-500">Quick add:</span>
                {SUGGESTED_DIMENSIONS.filter(
                  (d) => !summaryDimensions.some((curr) => curr.toLowerCase() === d.toLowerCase())
                ).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleAddDimension(preset)}
                    className="rounded-full border border-slate-700/80 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200 transition-colors focus-ring"
                  >
                    + {preset}
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Mutually Exclusive Selection Mode Switcher */}
      <Card>
        <CardHeader>
          <CardTitle>Question Selection Mode</CardTitle>
          <CardDescription>
            Choose whether every candidate receives an exact hand-picked sequence or a fresh
            randomized draw from tagged questions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label="Question selection mode"
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={selectionMode === 'curated'}
              disabled={readOnly}
              onClick={() => setSelectionMode('curated')}
              className={cn(
                'flex items-start gap-3.5 rounded-xl border p-4 text-left transition-all focus-ring',
                selectionMode === 'curated'
                  ? 'border-indigo-500/80 bg-indigo-500/12 ring-2 ring-indigo-500/20'
                  : 'border-slate-800 bg-surface-0/70 hover:border-slate-700',
                readOnly && 'cursor-not-allowed opacity-75'
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                  selectionMode === 'curated'
                    ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-300'
                    : 'border-slate-700 bg-slate-800/80 text-slate-400'
                )}
              >
                <ListOrdered className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-100">Curated Sequence</span>
                  {selectionMode === 'curated' && (
                    <Badge variant="indigo" size="sm">
                      Selected
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Hand-pick questions from the shared bank, drag-and-drop exact ordering, and
                  customize per-question weightage, expected answers, and rubrics.
                </p>
              </div>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={selectionMode === 'random_pool'}
              disabled={readOnly}
              onClick={() => setSelectionMode('random_pool')}
              className={cn(
                'flex items-start gap-3.5 rounded-xl border p-4 text-left transition-all focus-ring',
                selectionMode === 'random_pool'
                  ? 'border-cyan-500/80 bg-cyan-500/12 ring-2 ring-cyan-500/20'
                  : 'border-slate-800 bg-surface-0/70 hover:border-slate-700',
                readOnly && 'cursor-not-allowed opacity-75'
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                  selectionMode === 'random_pool'
                    ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-300'
                    : 'border-slate-700 bg-slate-800/80 text-slate-400'
                )}
              >
                <Shuffle className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-100">Randomized Pool</span>
                  {selectionMode === 'random_pool' && (
                    <Badge variant="cyan" size="sm">
                      Selected
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Automatically sample active questions matching selected tags and Easy / Medium /
                  Hard quotas each time a candidate starts.
                </p>
              </div>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* CURATED MODE: Split-Screen Builder */}
      {selectionMode === 'curated' ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 items-start">
          {/* Left Pane: Shared Question Bank */}
          <Card className="xl:col-span-5 flex flex-col">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle>Shared Question Bank</CardTitle>
                  <CardDescription>
                    Filter and add questions to this template’s curated sequence.
                  </CardDescription>
                </div>
                <Badge variant="slate" size="sm">
                  {filteredBankQuestions.length} shown
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="space-y-3.5">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={bankSearch}
                  onChange={(e) => setBankSearch(e.target.value)}
                  placeholder="Search bank by title, prompt, or tag…"
                  aria-label="Search shared question bank"
                  className="w-full rounded-lg bg-surface-0/90 border border-slate-700/80 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
                />
              </div>

              <TagInput
                value={bankTags}
                onChange={setBankTags}
                availableTags={availableTags}
                placeholder="Filter by tags…"
              />

              <div className="grid grid-cols-2 gap-2">
                <Select
                  aria-label="Filter bank by format"
                  value={bankFormat}
                  onChange={(e) => setBankFormat(e.target.value as QuestionFormat | '')}
                >
                  <option value="">All Formats</option>
                  <option value="mcq">MCQ</option>
                  <option value="text">Text</option>
                  <option value="code">Code</option>
                  <option value="notebook">Notebook</option>
                </Select>

                <Select
                  aria-label="Filter bank by difficulty"
                  value={bankDifficulty}
                  onChange={(e) => setBankDifficulty(e.target.value as QuestionDifficulty | '')}
                >
                  <option value="">All Difficulties</option>
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </Select>
              </div>

              <div className="flex items-center justify-between text-xs">
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bankActiveOnly}
                    onChange={(e) => setBankActiveOnly(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-600 bg-surface-0 text-indigo-500"
                  />
                  Active questions only
                </label>
                {(bankSearch || bankTags.length > 0 || bankFormat || bankDifficulty) && (
                  <button
                    type="button"
                    onClick={() => {
                      setBankSearch('');
                      setBankTags([]);
                      setBankFormat('');
                      setBankDifficulty('');
                    }}
                    className="text-indigo-400 hover:text-indigo-300 font-medium"
                  >
                    Clear filters
                  </button>
                )}
              </div>

              {/* Scrollable Bank List */}
              <div className="max-h-[580px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                {filteredBankQuestions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-800 py-10 text-center text-xs text-slate-400">
                    No bank questions match your current filters.
                  </div>
                ) : (
                  filteredBankQuestions.map((q) => {
                    const alreadyAdded = curatedIdSet.has(q.id);
                    const fmtMeta = FORMAT_META[q.format];
                    const diffMeta = DIFFICULTY_META[q.difficulty];
                    const FmtIcon = fmtMeta.icon;

                    return (
                      <div
                        key={q.id}
                        className={cn(
                          'flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors',
                          alreadyAdded
                            ? 'border-emerald-500/25 bg-emerald-500/5 opacity-80'
                            : 'border-slate-800/90 bg-surface-0/70 hover:border-slate-700'
                        )}
                      >
                        <div className="min-w-0 space-y-1.5">
                          <p className="text-xs font-medium text-slate-100 leading-snug">
                            {q.title}
                          </p>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant={fmtMeta.badge} size="sm">
                              <FmtIcon className="h-2.5 w-2.5" aria-hidden="true" />
                              {fmtMeta.label}
                            </Badge>
                            <Badge variant={diffMeta.badge} size="sm">
                              {diffMeta.label}
                            </Badge>
                            <Badge variant="slate" size="sm">
                              {q.default_points} pts
                            </Badge>
                          </div>
                          {q.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {q.tags.slice(0, 4).map((t) => (
                                <span
                                  key={t}
                                  className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-slate-400"
                                >
                                  #{t}
                                </span>
                              ))}
                              {q.tags.length > 4 && (
                                <span className="text-[10px] text-slate-500">
                                  +{q.tags.length - 4}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="shrink-0">
                          {alreadyAdded ? (
                            <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                              <Check className="h-3 w-3" aria-hidden="true" />
                              Added
                            </span>
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={readOnly}
                              leftIcon={<Plus className="h-3.5 w-3.5" />}
                              onClick={() => handleAddQuestion(q)}
                            >
                              Add
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          {/* Right Pane: Ordered Interview Sequence with Drag & Drop */}
          <Card className="xl:col-span-7">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle>Ordered Interview Sequence</CardTitle>
                  <CardDescription>
                    Drag handles to reorder questions, or expand Customize to set template-specific
                    points, expected answers, and rubrics.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="indigo" size="md">
                    {curatedStats.totalCount}{' '}
                    {curatedStats.totalCount === 1 ? 'question' : 'questions'}
                  </Badge>
                  <Badge variant="cyan" size="md">
                    {curatedStats.totalPoints} total pts
                  </Badge>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Live Difficulty Mix Bar */}
              <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-slate-300">Difficulty Mix</span>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-emerald-300">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      Easy: <strong>{curatedStats.counts.easy}</strong> ({easyPct}%)
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-amber-300">
                      <span className="h-2 w-2 rounded-full bg-amber-400" />
                      Medium: <strong>{curatedStats.counts.medium}</strong> ({medPct}%)
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-rose-300">
                      <span className="h-2 w-2 rounded-full bg-rose-400" />
                      Hard: <strong>{curatedStats.counts.hard}</strong> ({hardPct}%)
                    </span>
                  </div>
                </div>

                <div
                  className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800/90"
                  aria-label="Difficulty distribution bar"
                >
                  {curatedStats.totalCount > 0 && (
                    <>
                      {curatedStats.counts.easy > 0 && (
                        <div
                          className="h-full bg-emerald-500 transition-all duration-300"
                          style={{ width: `${easyPct}%` }}
                        />
                      )}
                      {curatedStats.counts.medium > 0 && (
                        <div
                          className="h-full bg-amber-500 transition-all duration-300"
                          style={{ width: `${medPct}%` }}
                        />
                      )}
                      {curatedStats.counts.hard > 0 && (
                        <div
                          className="h-full bg-rose-500 transition-all duration-300"
                          style={{ width: `${hardPct}%` }}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Sortable Sequence List */}
              {curatedItems.length === 0 ? (
                <EmptyState
                  icon={<ListOrdered className="h-6 w-6" />}
                  title="No questions in sequence yet"
                  description="Click + Add on questions from the Shared Question Bank on the left to build your assessment sequence."
                />
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={curatedItems.map((item) => item.question_id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2.5">
                      {curatedItems.map((entry, idx) => (
                        <SortableQuestionRow
                          key={entry.question_id}
                          entry={entry}
                          question={questionsById.get(entry.question_id)}
                          index={idx}
                          totalCount={curatedItems.length}
                          expanded={expandedQuestionIds.has(entry.question_id)}
                          readOnly={readOnly}
                          onToggleExpand={() => toggleExpandQuestion(entry.question_id)}
                          onMoveUp={() => handleMoveQuestion(idx, idx - 1)}
                          onMoveDown={() => handleMoveQuestion(idx, idx + 1)}
                          onRemove={() => handleRemoveQuestion(entry.question_id)}
                          onChangeOverride={(patch) =>
                            handleUpdateOverride(entry.question_id, patch)
                          }
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        /* RANDOMIZED POOL MODE */
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Randomized Pool Rules</CardTitle>
                <CardDescription>
                  Select domain/skill tags and Easy / Medium / Hard question counts drawn per
                  candidate session.
                </CardDescription>
              </div>
              <Badge
                variant={randomPoolStats.shortages.length > 0 ? 'amber' : 'cyan'}
                size="md"
              >
                {randomPoolStats.matching.length} active matching in bank
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 items-end">
              <div className="lg:col-span-9">
                <TagInput
                  label="Filter Pool by Domain / Skill Tags"
                  value={poolTags}
                  onChange={setPoolTags}
                  availableTags={availableTags}
                  disabled={readOnly}
                  placeholder="Leave empty to sample from all active questions…"
                />
              </div>

              <div className="lg:col-span-3 space-y-1.5">
                <span className="block text-xs font-medium text-slate-300">Tag Match Mode</span>
                <div
                  role="group"
                  aria-label="Random pool tag match mode"
                  className="grid grid-cols-2 rounded-lg border border-slate-700/80 bg-surface-0/90 p-1"
                >
                  {(['any', 'all'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={readOnly}
                      aria-pressed={poolMatch === mode}
                      onClick={() => setPoolMatch(mode)}
                      className={cn(
                        'rounded-md py-1.5 text-xs font-medium transition-colors focus-ring',
                        poolMatch === mode
                          ? 'bg-cyan-600/90 text-white'
                          : 'text-slate-400 hover:text-slate-200',
                        readOnly && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      Match {mode === 'any' ? 'ANY' : 'ALL'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Difficulty Quotas + Live Availability */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {(
                [
                  {
                    key: 'easy',
                    label: 'Easy Questions',
                    value: poolEasy,
                    setter: setPoolEasy,
                    available: randomPoolStats.byDifficulty.easy.length,
                    color: 'emerald',
                  },
                  {
                    key: 'medium',
                    label: 'Medium Questions',
                    value: poolMedium,
                    setter: setPoolMedium,
                    available: randomPoolStats.byDifficulty.medium.length,
                    color: 'amber',
                  },
                  {
                    key: 'hard',
                    label: 'Hard Questions',
                    value: poolHard,
                    setter: setPoolHard,
                    available: randomPoolStats.byDifficulty.hard.length,
                    color: 'rose',
                  },
                ] as const
              ).map((tier) => {
                const isShort = tier.value > tier.available;
                return (
                  <div
                    key={tier.key}
                    className={cn(
                      'rounded-xl border p-4 space-y-3',
                      isShort
                        ? 'border-amber-500/45 bg-amber-500/5'
                        : 'border-slate-800/90 bg-surface-0/60'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={tier.color} size="sm">
                        {tier.label}
                      </Badge>
                      <span
                        className={cn(
                          'font-mono text-xs',
                          isShort ? 'text-amber-300 font-semibold' : 'text-slate-400'
                        )}
                      >
                        {tier.available} available
                      </span>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      disabled={readOnly}
                      aria-label={tier.label}
                      value={String(tier.value)}
                      onChange={(e) =>
                        tier.setter(Math.max(0, Math.round(Number(e.target.value) || 0)))
                      }
                    />
                  </div>
                );
              })}
            </div>

            {/* Live Pool Summary & Shortage Warnings */}
            {randomPoolStats.shortages.length > 0 && (
              <Alert variant="warning" title="Matching Pool Shortage Detected">
                <p className="mb-1.5">
                  Fewer active questions match your tags than requested. Candidates will safely
                  receive all available matching questions without crashing:
                </p>
                <ul className="list-disc pl-5 space-y-0.5 text-xs">
                  {randomPoolStats.shortages.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {randomPoolStats.requestedTotal === 0 && (
              <Alert variant="warning" title="Zero Questions Requested">
                Set at least one Easy, Medium, or Hard question count greater than 0.
              </Alert>
            )}

            {/* Live Pool Counter Summary Box */}
            <div className="rounded-xl border border-slate-800/90 bg-surface-0/70 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {randomPoolStats.shortages.length > 0 ? (
                    <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  ) : (
                    <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                  )}
                  <p className="text-sm font-medium text-slate-200">
                    Drawing{' '}
                    <strong>
                      {Math.min(poolEasy, randomPoolStats.byDifficulty.easy.length) +
                        Math.min(poolMedium, randomPoolStats.byDifficulty.medium.length) +
                        Math.min(poolHard, randomPoolStats.byDifficulty.hard.length)}
                    </strong>{' '}
                    of <strong>{randomPoolStats.requestedTotal}</strong> requested from{' '}
                    <strong>{randomPoolStats.matching.length}</strong> matching active questions
                  </p>
                </div>
              </div>

              {randomPoolStats.matching.length > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                    Sample Matching Pool Questions
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                    {randomPoolStats.matching.slice(0, 6).map((q) => (
                      <div
                        key={q.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-surface-1/80 px-2.5 py-1.5 text-xs border border-slate-800/70"
                      >
                        <span className="truncate text-slate-200">{q.title}</span>
                        <Badge variant={DIFFICULTY_META[q.difficulty].badge} size="sm">
                          {DIFFICULTY_META[q.difficulty].label}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  {randomPoolStats.matching.length > 6 && (
                    <p className="text-[11px] text-slate-500">
                      + {randomPoolStats.matching.length - 6} more matching questions in pool
                    </p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bottom Sticky Save Bar */}
      <div className="flex items-center justify-end gap-2.5 pt-2">
        <Button variant="ghost" size="md" onClick={() => navigate('/admin/templates')}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="md"
          leftIcon={<Eye className="h-4 w-4" />}
          onClick={handleLivePreview}
        >
          Live Preview
        </Button>
        <Button
          variant="primary"
          size="md"
          loading={saving}
          disabled={readOnly}
          leftIcon={<Save className="h-4 w-4" />}
          onClick={() => void handleSave()}
        >
          {isEditing ? 'Save Changes' : 'Create Template'}
        </Button>
      </div>

      {/* Live Preview Overlay */}
      <TemplatePreviewOverlay
        open={Boolean(previewData)}
        template={previewData?.template ?? null}
        questions={previewData?.questions ?? []}
        onClose={() => setPreviewData(null)}
      />
    </div>
  );
}

export default TemplateComposerPage;
