import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Code2,
  Database,
  Download,
  Eye,
  FileCode,
  FileJson,
  FileText,
  Filter,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tag,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, ApiError, triggerBlobDownload } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  ExportFormat,
  ImportCommitResponse,
  Question,
  QuestionDifficulty,
  QuestionFormat,
  TagMatchMode,
  TagSummary,
} from '../../types/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Modal,
  Spinner,
  useToast,
  type BadgeVariant,
} from '../../components/ui';
import { BulkImportModal } from '../../components/admin/BulkImportModal';
import { QuestionEditorModal } from '../../components/admin/QuestionEditorModal';
import { useAdminContext } from './AdminLayout';

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

function stripMarkdownPreview(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#>*_~[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function QuestionsPage() {
  const { readOnly } = useAdminContext();
  const { toast } = useToast();

  // Data state
  const [questions, setQuestions] = useState<Question[]>([]);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<TagMatchMode>('any');
  const [formatFilter, setFormatFilter] = useState<QuestionFormat | ''>('');
  const [difficultyFilter, setDifficultyFilter] = useState<QuestionDifficulty | ''>('');
  const [activeOnly, setActiveOnly] = useState(false);

  // Action / modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deletingQuestion, setDeletingQuestion] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());

  // Export dropdown state
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const tableCaptionId = useId();
  const searchInputId = useId();

  // Debounce search text
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Close export dropdown on outside click or Escape
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [exportMenuOpen]);

  const fetchTags = useCallback(async () => {
    try {
      const data = await api.admin.listTags();
      setTags(data);
    } catch {
      // Tag load failure is non-fatal; questions fetch surfaces main errors
    }
  }, []);

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.admin.listQuestions({
        search: debouncedSearch || undefined,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
        tag_match: tagMatch,
        format: formatFilter || undefined,
        difficulty: difficultyFilter || undefined,
        active_only: activeOnly || undefined,
      });
      setQuestions(data);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.detail : 'Failed to load questions from catalog.');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, selectedTags, tagMatch, formatFilter, difficultyFilter, activeOnly]);

  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    void fetchQuestions();
  }, [fetchQuestions]);

  const hasActiveFilters = Boolean(
    debouncedSearch || selectedTags.length > 0 || formatFilter || difficultyFilter || activeOnly
  );

  const resetFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setSelectedTags([]);
    setTagMatch('any');
    setFormatFilter('');
    setDifficultyFilter('');
    setActiveOnly(false);
  };

  const toggleTagFilter = (tagName: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagName) ? prev.filter((t) => t !== tagName) : [...prev, tagName]
    );
  };

  const handleOpenCreate = () => {
    setEditingQuestion(null);
    setEditorOpen(true);
  };

  const handleOpenEdit = (question: Question) => {
    setEditingQuestion(question);
    setEditorOpen(true);
  };

  const handleQuestionSaved = (saved: Question, isNew: boolean) => {
    toast({
      variant: 'success',
      title: isNew ? 'Question created' : 'Question updated',
      description: saved.title,
    });
    void fetchQuestions();
    void fetchTags();
  };

  const handleToggleActive = async (question: Question) => {
    if (readOnly || togglingIds.has(question.id)) return;
    const nextActive = !question.active;

    setTogglingIds((prev) => new Set(prev).add(question.id));
    setQuestions((prev) =>
      prev.map((q) => (q.id === question.id ? { ...q, active: nextActive } : q))
    );

    try {
      await api.admin.updateQuestion(question.id, { active: nextActive });
      toast({
        variant: 'info',
        title: nextActive ? 'Question activated' : 'Question deactivated',
        description: question.title,
      });
      if (activeOnly && !nextActive) {
        setQuestions((prev) => prev.filter((q) => q.id !== question.id));
      }
    } catch (err: unknown) {
      // Revert optimistic update
      setQuestions((prev) =>
        prev.map((q) => (q.id === question.id ? { ...q, active: question.active } : q))
      );
      toast({
        variant: 'error',
        title: 'Failed to update status',
        description: err instanceof ApiError ? err.detail : 'Please try again.',
      });
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(question.id);
        return next;
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingQuestion || readOnly) return;
    setDeleting(true);
    try {
      await api.admin.deleteQuestion(deletingQuestion.id);
      toast({
        variant: 'success',
        title: 'Question deleted',
        description: deletingQuestion.title,
      });
      setDeletingQuestion(null);
      await Promise.all([fetchQuestions(), fetchTags()]);
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Delete failed',
        description: err instanceof ApiError ? err.detail : 'Unable to delete question.',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = async (format: ExportFormat, scopedToTags: boolean) => {
    setExportMenuOpen(false);
    setExportingFormat(format);
    try {
      const tagFilter = scopedToTags && selectedTags.length > 0 ? selectedTags : undefined;
      const blob = await api.admin.exportQuestions({ format, tags: tagFilter });
      const suffix = tagFilter ? `_filtered` : '';
      triggerBlobDownload(blob, `questions_export${suffix}.${format}`);
      toast({
        variant: 'success',
        title: `Exported ${format.toUpperCase()}`,
        description: tagFilter
          ? `Filtered by tags: ${tagFilter.join(', ')}`
          : 'Full question bank exported.',
      });
    } catch (err: unknown) {
      toast({
        variant: 'error',
        title: 'Export failed',
        description: err instanceof ApiError ? err.detail : 'Unable to export questions.',
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const handleImportCompleted = (summary: ImportCommitResponse) => {
    const parts: string[] = [];
    if (summary.created > 0) parts.push(`${summary.created} created`);
    if (summary.updated > 0) parts.push(`${summary.updated} updated`);
    if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
    toast({
      variant: 'success',
      title: 'Bulk import committed',
      description: parts.length > 0 ? parts.join(' · ') : 'Import completed with 0 changes.',
    });
    void fetchQuestions();
    void fetchTags();
  };

  const stats = useMemo(() => {
    let active = 0;
    const byFormat: Record<QuestionFormat, number> = { mcq: 0, text: 0, code: 0, notebook: 0 };
    for (const q of questions) {
      if (q.active) active += 1;
      byFormat[q.format] = (byFormat[q.format] ?? 0) + 1;
    }
    return { total: questions.length, active, byFormat };
  }, [questions]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Question Bank</h1>
            <Badge variant="indigo" size="md">
              {stats.total} {stats.total === 1 ? 'question' : 'questions'}
            </Badge>
          </div>
          <p className="text-sm text-slate-400">
            Author, tag, and organize reusable MCQ, Text, Code, and Python Notebook questions.
          </p>
        </div>

        {/* Action Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Export Dropdown */}
          <div ref={exportMenuRef} className="relative">
            <Button
              variant="outline"
              size="md"
              loading={exportingFormat !== null}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              leftIcon={<Download className="h-4 w-4" />}
              rightIcon={<ChevronDown className="h-3.5 w-3.5 opacity-75" />}
              onClick={() => setExportMenuOpen((prev) => !prev)}
            >
              Export
            </Button>

            {exportMenuOpen && (
              <div
                role="menu"
                aria-label="Export questions"
                className="absolute right-0 z-30 mt-1.5 w-60 rounded-xl border border-slate-700/90 bg-surface-1/95 p-1.5 shadow-xl shadow-black/60 backdrop-blur-md animate-fade-in"
              >
                <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {selectedTags.length > 0 ? 'Filtered by Active Tags' : 'Entire Question Bank'}
                </p>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExport('yaml', selectedTags.length > 0)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800/80 transition-colors focus-ring"
                >
                  <FileCode className="h-4 w-4 text-cyan-400 shrink-0" aria-hidden="true" />
                  <div>
                    <span className="block">Export YAML (.yaml)</span>
                    <span className="block text-[11px] text-slate-400">
                      Human-readable canonical format
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExport('json', selectedTags.length > 0)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800/80 transition-colors focus-ring"
                >
                  <FileJson className="h-4 w-4 text-indigo-400 shrink-0" aria-hidden="true" />
                  <div>
                    <span className="block">Export JSON (.json)</span>
                    <span className="block text-[11px] text-slate-400">
                      Structured JSON bundle
                    </span>
                  </div>
                </button>

                {selectedTags.length > 0 && (
                  <>
                    <div className="my-1 border-t border-slate-800" />
                    <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Unfiltered Full Catalog
                    </p>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleExport('yaml', false)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/80 transition-colors focus-ring"
                    >
                      <FileCode className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                      All Questions (YAML)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleExport('json', false)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/80 transition-colors focus-ring"
                    >
                      <FileJson className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                      All Questions (JSON)
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <Button
            variant="secondary"
            size="md"
            disabled={readOnly}
            title={readOnly ? 'Disabled in read-only candidate mode' : 'Bulk upload JSON or YAML'}
            leftIcon={<Upload className="h-4 w-4" />}
            onClick={() => setImportOpen(true)}
          >
            Bulk Upload
          </Button>

          <Button
            variant="primary"
            size="md"
            disabled={readOnly}
            title={readOnly ? 'Disabled in read-only candidate mode' : 'Create a new question'}
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={handleOpenCreate}
          >
            New Question
          </Button>
        </div>
      </div>

      {/* Compact Format Mix Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        <div className="rounded-xl border border-slate-800/80 bg-surface-1/75 px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-slate-400">Active / Shown</p>
          <p className="mt-0.5 font-mono text-lg font-semibold text-slate-100">
            {stats.active}
            <span className="text-xs font-normal text-slate-500"> / {stats.total}</span>
          </p>
        </div>
        {(Object.keys(FORMAT_META) as QuestionFormat[]).map((fmt) => {
          const meta = FORMAT_META[fmt];
          const Icon = meta.icon;
          const isFiltered = formatFilter === fmt;
          return (
            <button
              key={fmt}
              type="button"
              onClick={() => setFormatFilter((prev) => (prev === fmt ? '' : fmt))}
              className={cn(
                'rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-ring',
                isFiltered
                  ? 'border-indigo-500/60 bg-indigo-500/15'
                  : 'border-slate-800/80 bg-surface-1/75 hover:border-slate-700'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] font-medium text-slate-400">{meta.label}</span>
                <Icon className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
              </div>
              <p className="mt-0.5 font-mono text-lg font-semibold text-slate-100">
                {stats.byFormat[fmt]}
              </p>
            </button>
          );
        })}
      </div>

      {/* Search & Filter Panel */}
      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <search>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
              {/* Search Box */}
              <div className="md:col-span-5 relative">
                <label htmlFor={searchInputId} className="sr-only">
                  Search questions by title, prompt, or external key
                </label>
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  id={searchInputId}
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search title, prompt, or external key…"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="w-full rounded-lg bg-surface-0/90 border border-slate-700/80 pl-9 pr-8 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition-colors hover:border-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-100 focus-ring"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* Format Filter */}
              <div className="md:col-span-2">
                <select
                  aria-label="Filter by format"
                  value={formatFilter}
                  onChange={(e) => setFormatFilter(e.target.value as QuestionFormat | '')}
                  className="w-full rounded-lg bg-surface-0 border border-slate-700/80 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
                >
                  <option value="">All Formats</option>
                  <option value="mcq">MCQ</option>
                  <option value="text">Text</option>
                  <option value="code">Code</option>
                  <option value="notebook">Notebook</option>
                </select>
              </div>

              {/* Difficulty Filter */}
              <div className="md:col-span-2">
                <select
                  aria-label="Filter by difficulty"
                  value={difficultyFilter}
                  onChange={(e) => setDifficultyFilter(e.target.value as QuestionDifficulty | '')}
                  className="w-full rounded-lg bg-surface-0 border border-slate-700/80 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
                >
                  <option value="">All Difficulties</option>
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </div>

              {/* Active Only & Reset */}
              <div className="md:col-span-3 flex items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={activeOnly}
                    onChange={(e) => setActiveOnly(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500 focus:ring-indigo-500/40"
                  />
                  Active only
                </label>

                {hasActiveFilters && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                    onClick={resetFilters}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          </search>

          {/* Multi-Tag Filter Bar */}
          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-3.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400 mr-1">
                <Filter className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Tags:</span>
              </div>

              {selectedTags.length > 1 && (
                <div
                  role="group"
                  aria-label="Tag match mode"
                  className="inline-flex rounded-lg border border-slate-700/80 bg-surface-0 p-0.5 text-[11px] mr-1"
                >
                  <button
                    type="button"
                    aria-pressed={tagMatch === 'any'}
                    onClick={() => setTagMatch('any')}
                    className={cn(
                      'rounded-md px-2 py-0.5 font-medium transition-colors focus-ring',
                      tagMatch === 'any'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    Match Any
                  </button>
                  <button
                    type="button"
                    aria-pressed={tagMatch === 'all'}
                    onClick={() => setTagMatch('all')}
                    className={cn(
                      'rounded-md px-2 py-0.5 font-medium transition-colors focus-ring',
                      tagMatch === 'all'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    Match All
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5 flex-1">
                {tags.map((tag) => {
                  const active = selectedTags.includes(tag.name);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleTagFilter(tag.name)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
                        active
                          ? 'border-indigo-400/70 bg-indigo-500/20 text-indigo-200'
                          : 'border-slate-800 bg-surface-0/70 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                      )}
                    >
                      <Tag className="h-3 w-3 opacity-75" aria-hidden="true" />
                      <span>{tag.name}</span>
                      <span
                        className={cn(
                          'font-mono text-[10px]',
                          active ? 'text-indigo-300' : 'text-slate-500'
                        )}
                      >
                        {tag.question_count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {selectedTags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedTags([])}
                  className="text-xs font-medium text-slate-400 hover:text-slate-200 underline underline-offset-2 focus-ring rounded px-1"
                >
                  Clear tags
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Error Alert */}
      {error && (
        <Alert variant="error" title="Could not load Question Bank">
          <div className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={() => void fetchQuestions()}>
              Retry
            </Button>
          </div>
        </Alert>
      )}

      {/* Question Table / Loading / Empty State */}
      {loading ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
            <Spinner size="lg" label="Loading questions" />
            <p className="text-sm text-slate-400">Loading question bank…</p>
          </CardContent>
        </Card>
      ) : questions.length === 0 ? (
        <EmptyState
          icon={<Database className="h-5 w-5" />}
          title={hasActiveFilters ? 'No matching questions' : 'Your Question Bank is empty'}
          description={
            hasActiveFilters
              ? 'Try broadening your search query, removing a tag filter, or resetting filters.'
              : 'Create your first question manually or bulk-import a starter YAML/JSON question bank.'
          }
          action={
            hasActiveFilters ? (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={resetFilters}
              >
                Reset All Filters
              </Button>
            ) : !readOnly ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Plus className="h-4 w-4" />}
                  onClick={handleOpenCreate}
                >
                  Create Question
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Upload className="h-4 w-4" />}
                  onClick={() => setImportOpen(true)}
                >
                  Bulk Import YAML / JSON
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={tableCaptionId}
            className="overflow-x-auto max-h-[calc(100vh-22rem)] min-h-[320px] custom-scrollbar focus-ring"
          >
            <table className="w-full border-collapse text-left text-sm">
              <caption id={tableCaptionId} className="sr-only">
                Question Bank catalog listing {questions.length} questions
              </caption>
              <thead className="sticky top-0 z-10 border-b border-slate-800/90 bg-surface-2/95 backdrop-blur-sm text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 min-w-[280px]">
                    Question
                  </th>
                  <th scope="col" className="px-4 py-3 w-32">
                    Format
                  </th>
                  <th scope="col" className="px-4 py-3 w-28">
                    Difficulty
                  </th>
                  <th scope="col" className="px-4 py-3 min-w-[180px]">
                    Tags
                  </th>
                  <th scope="col" className="px-4 py-3 w-20 text-right">
                    Points
                  </th>
                  <th scope="col" className="px-4 py-3 w-24 text-center">
                    Active
                  </th>
                  <th scope="col" className="px-4 py-3 w-28 text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {questions.map((q) => {
                  const fmtMeta = FORMAT_META[q.format] ?? FORMAT_META.text;
                  const FmtIcon = fmtMeta.icon;
                  const diffMeta = DIFFICULTY_META[q.difficulty] ?? DIFFICULTY_META.medium;
                  const isToggling = togglingIds.has(q.id);
                  const previewSnippet = stripMarkdownPreview(q.prompt);

                  return (
                    <tr
                      key={q.id}
                      className={cn(
                        'group transition-colors hover:bg-slate-800/35',
                        !q.active && 'opacity-65'
                      )}
                    >
                      <th scope="row" className="px-4 py-3.5 font-normal align-top">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleOpenEdit(q)}
                              className="text-left text-sm font-semibold text-slate-100 hover:text-indigo-300 transition-colors focus-ring rounded"
                            >
                              {q.title}
                            </button>
                            {q.external_key && (
                              <span className="rounded bg-slate-800/90 border border-slate-700/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                                {q.external_key}
                              </span>
                            )}
                          </div>
                          {previewSnippet && (
                            <p className="line-clamp-1 text-xs text-slate-400 max-w-xl">
                              {previewSnippet}
                            </p>
                          )}
                        </div>
                      </th>

                      <td className="px-4 py-3.5 align-top">
                        <div className="flex flex-col items-start gap-1">
                          <Badge variant={fmtMeta.badge} size="sm">
                            <FmtIcon className="h-3 w-3" aria-hidden="true" />
                            {fmtMeta.label}
                          </Badge>
                          {q.format === 'code' && q.code_language && (
                            <span className="font-mono text-[10px] text-slate-500 pl-1">
                              {q.code_language}
                            </span>
                          )}
                          {q.format === 'mcq' && q.answer_indices.length > 1 && (
                            <span className="text-[10px] text-slate-500 pl-1">Multi-select</span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 align-top">
                        <Badge variant={diffMeta.badge} dot size="sm">
                          {diffMeta.label}
                        </Badge>
                      </td>

                      <td className="px-4 py-3.5 align-top">
                        {q.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {q.tags.map((tag) => {
                              const isSelected = selectedTags.includes(tag);
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => toggleTagFilter(tag)}
                                  title={`Filter by tag "${tag}"`}
                                  className={cn(
                                    'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors focus-ring',
                                    isSelected
                                      ? 'border-indigo-400/70 bg-indigo-500/20 text-indigo-200'
                                      : 'border-slate-700/70 bg-surface-0/80 text-slate-300 hover:border-indigo-500/50 hover:text-indigo-200'
                                  )}
                                >
                                  {tag}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>

                      <td className="px-4 py-3.5 align-top text-right font-mono text-xs font-semibold text-slate-200 tabular-nums">
                        {q.default_points} <span className="font-normal text-slate-500">pts</span>
                      </td>

                      <td className="px-4 py-3.5 align-top text-center">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={q.active}
                          aria-label={`${q.active ? 'Deactivate' : 'Activate'} ${q.title}`}
                          disabled={readOnly || isToggling}
                          onClick={() => void handleToggleActive(q)}
                          className={cn(
                            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-ring',
                            q.active
                              ? 'border-emerald-500/50 bg-emerald-500/30'
                              : 'border-slate-700 bg-slate-800',
                            (readOnly || isToggling) && 'opacity-50 cursor-not-allowed'
                          )}
                        >
                          <span
                            className={cn(
                              'inline-block h-3.5 w-3.5 transform rounded-full transition-transform',
                              q.active
                                ? 'translate-x-4 bg-emerald-400'
                                : 'translate-x-0.5 bg-slate-400'
                            )}
                          />
                        </button>
                      </td>

                      <td className="px-4 py-3.5 align-top text-right">
                        <div className="inline-flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => handleOpenEdit(q)}
                            aria-label={readOnly ? `Inspect ${q.title}` : `Edit ${q.title}`}
                            title={readOnly ? 'Inspect question' : 'Edit question'}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-indigo-300 transition-colors focus-ring"
                          >
                            {readOnly ? (
                              <Eye className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>

                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => setDeletingQuestion(q)}
                              aria-label={`Delete ${q.title}`}
                              title="Delete question"
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400 transition-colors focus-ring"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
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

      {/* Question Editor Modal */}
      <QuestionEditorModal
        open={editorOpen}
        question={editingQuestion}
        availableTags={tags}
        readOnly={readOnly}
        onClose={() => setEditorOpen(false)}
        onSaved={handleQuestionSaved}
      />

      {/* Bulk JSON/YAML Import Modal */}
      <BulkImportModal
        open={importOpen}
        readOnly={readOnly}
        onClose={() => setImportOpen(false)}
        onImported={handleImportCompleted}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        open={Boolean(deletingQuestion)}
        onClose={() => {
          if (!deleting) setDeletingQuestion(null);
        }}
        dismissible={!deleting}
        title="Delete Question"
        description="This action permanently removes the question from the catalog and any templates referencing it."
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeletingQuestion(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => void handleConfirmDelete()}
            >
              Delete Question
            </Button>
          </>
        }
      >
        {deletingQuestion && (
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-800 bg-surface-0/70 p-3.5">
              <p className="text-sm font-semibold text-slate-100">{deletingQuestion.title}</p>
              {deletingQuestion.external_key && (
                <p className="mt-1 font-mono text-xs text-slate-400">
                  {deletingQuestion.external_key}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant={FORMAT_META[deletingQuestion.format].badge} size="sm">
                  {FORMAT_META[deletingQuestion.format].label}
                </Badge>
                <Badge variant={DIFFICULTY_META[deletingQuestion.difficulty].badge} size="sm">
                  {DIFFICULTY_META[deletingQuestion.difficulty].label}
                </Badge>
                <Badge variant="slate" size="sm">
                  {deletingQuestion.default_points} pts
                </Badge>
              </div>
            </div>
            <p className="text-xs text-slate-400">
              Are you sure you want to permanently delete this question?
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
