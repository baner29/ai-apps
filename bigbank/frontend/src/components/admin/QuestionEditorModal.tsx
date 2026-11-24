import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown,
  ArrowUp,
  Bold,
  CheckCircle2,
  Code,
  Code2,
  Edit3,
  Eye,
  FileCode2,
  FileText,
  Italic,
  List,
  ListChecks,
  Plus,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  Question,
  QuestionCreatePayload,
  QuestionDifficulty,
  QuestionFormat,
  TagSummary,
} from '../../types/api';
import {
  Alert,
  Badge,
  Button,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '../ui';
import { TagInput } from './TagInput';

export interface QuestionEditorModalProps {
  open: boolean;
  question: Question | null;
  availableTags: TagSummary[];
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (saved: Question, isNew: boolean) => void;
}

const FORMAT_OPTIONS: Array<{
  value: QuestionFormat;
  label: string;
  description: string;
  icon: typeof ListChecks;
}> = [
  {
    value: 'mcq',
    label: 'Multiple Choice',
    description: 'Single or multi-select auto-graded',
    icon: ListChecks,
  },
  {
    value: 'text',
    label: 'Long-Form Text',
    description: 'Markdown essay or architecture case',
    icon: FileText,
  },
  {
    value: 'code',
    label: 'Code Editor',
    description: 'Syntax-highlighted Monaco editor',
    icon: Code2,
  },
  {
    value: 'notebook',
    label: 'Python Notebook',
    description: 'Multi-cell live Python kernel',
    icon: TerminalSquare,
  },
];

const CODE_LANGUAGES: Array<{ value: string; label: string; monaco: string }> = [
  { value: 'python', label: 'Python', monaco: 'python' },
  { value: 'sql', label: 'SQL', monaco: 'sql' },
  { value: 'postgresql', label: 'PostgreSQL', monaco: 'pgsql' },
  { value: 'javascript', label: 'JavaScript', monaco: 'javascript' },
  { value: 'typescript', label: 'TypeScript', monaco: 'typescript' },
  { value: 'java', label: 'Java', monaco: 'java' },
  { value: 'go', label: 'Go', monaco: 'go' },
  { value: 'rust', label: 'Rust', monaco: 'rust' },
  { value: 'cpp', label: 'C++', monaco: 'cpp' },
  { value: 'csharp', label: 'C#', monaco: 'csharp' },
  { value: 'scala', label: 'Scala', monaco: 'scala' },
  { value: 'bash', label: 'Bash / Shell', monaco: 'shell' },
  { value: 'yaml', label: 'YAML', monaco: 'yaml' },
  { value: 'json', label: 'JSON', monaco: 'json' },
  { value: 'hcl', label: 'Terraform (HCL)', monaco: 'hcl' },
  { value: 'dockerfile', label: 'Dockerfile', monaco: 'dockerfile' },
  { value: 'plaintext', label: 'Plain Text', monaco: 'plaintext' },
];

const KNOWN_LANGUAGE_VALUES = new Set(CODE_LANGUAGES.map((l) => l.value));

function resolveMonacoLanguage(lang: string): string {
  const match = CODE_LANGUAGES.find((item) => item.value === lang.toLowerCase());
  return match ? match.monaco : 'plaintext';
}

function formatLetter(idx: number): string {
  return String.fromCharCode(65 + idx);
}

interface FormState {
  title: string;
  externalKey: string;
  format: QuestionFormat;
  difficulty: QuestionDifficulty;
  defaultPoints: string;
  active: boolean;
  tags: string[];
  prompt: string;
  options: string[];
  answerIndices: number[];
  multiSelect: boolean;
  codeLanguage: string;
  customLanguage: string;
  starterCode: string;
  allowExecution: boolean;
  expectedAnswer: string;
  evaluationRubric: string;
}

function buildInitialState(question: Question | null): FormState {
  if (!question) {
    return {
      title: '',
      externalKey: '',
      format: 'text',
      difficulty: 'medium',
      defaultPoints: '10',
      active: true,
      tags: [],
      prompt: '',
      options: ['', '', '', ''],
      answerIndices: [0],
      multiSelect: false,
      codeLanguage: 'python',
      customLanguage: '',
      starterCode: '',
      allowExecution: false,
      expectedAnswer: '',
      evaluationRubric: '',
    };
  }

  const rawLang = (question.code_language ?? '').trim().toLowerCase();
  const isKnownLang = !rawLang || KNOWN_LANGUAGE_VALUES.has(rawLang);
  const options =
    question.options && question.options.length >= 2
      ? [...question.options]
      : ['', '', '', ''];
  const answerIndices =
    question.answer_indices && question.answer_indices.length > 0
      ? [...question.answer_indices].sort((a, b) => a - b)
      : [0];

  return {
    title: question.title ?? '',
    externalKey: question.external_key ?? '',
    format: question.format,
    difficulty: question.difficulty,
    defaultPoints: String(question.default_points ?? 10),
    active: Boolean(question.active),
    tags: [...(question.tags ?? [])],
    prompt: question.prompt ?? '',
    options,
    answerIndices,
    multiSelect: answerIndices.length > 1,
    codeLanguage: isKnownLang ? rawLang || 'python' : '__custom__',
    customLanguage: isKnownLang ? '' : question.code_language ?? '',
    starterCode: question.starter_code ?? '',
    allowExecution: Boolean(question.allow_execution),
    expectedAnswer: question.expected_answer ?? '',
    evaluationRubric: question.evaluation_rubric ?? '',
  };
}

export function QuestionEditorModal({
  open,
  question,
  availableTags,
  readOnly = false,
  onClose,
  onSaved,
}: QuestionEditorModalProps) {
  const [form, setForm] = useState<FormState>(() => buildInitialState(question));
  const [promptTab, setPromptTab] = useState<'write' | 'preview'>('write');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const formId = useId();
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const errorAlertRef = useRef<HTMLDivElement>(null);

  const isEdit = Boolean(question);

  useEffect(() => {
    if (open) {
      setForm(buildInitialState(question));
      setPromptTab('write');
      setError(null);
      setSaving(false);
    }
  }, [open, question]);

  const effectiveCodeLanguage = useMemo(() => {
    if (form.format === 'notebook') return 'python';
    if (form.codeLanguage === '__custom__') {
      return form.customLanguage.trim() || 'plaintext';
    }
    return form.codeLanguage || 'python';
  }, [form.format, form.codeLanguage, form.customLanguage]);

  const handleFormatChange = (nextFormat: QuestionFormat) => {
    if (readOnly) return;
    setForm((prev) => {
      const next: FormState = { ...prev, format: nextFormat };
      if (nextFormat === 'notebook') {
        next.codeLanguage = 'python';
        next.allowExecution = true;
      } else if (nextFormat === 'code') {
        if (!prev.codeLanguage) next.codeLanguage = 'python';
        if (prev.format === 'notebook') next.allowExecution = false;
      } else if (nextFormat === 'mcq' && prev.options.length < 2) {
        next.options = ['', '', '', ''];
        next.answerIndices = [0];
      }
      return next;
    });
    if (error) setError(null);
  };

  const applyPromptMarkdown = (prefix: string, suffix = '', placeholder = 'text') => {
    if (readOnly) return;
    const el = promptTextareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? form.prompt.length;
    const end = el.selectionEnd ?? form.prompt.length;
    const selected = form.prompt.slice(start, end);
    const before = form.prompt.slice(0, start);
    const after = form.prompt.slice(end);
    const inner = selected || placeholder;
    const nextPrompt = `${before}${prefix}${inner}${suffix}${after}`;
    setForm((prev) => ({ ...prev, prompt: nextPrompt }));
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, start + prefix.length + inner.length);
    });
  };

  const toggleAnswerIndex = (idx: number) => {
    if (readOnly) return;
    setForm((prev) => {
      if (!prev.multiSelect) {
        return { ...prev, answerIndices: [idx] };
      }
      const exists = prev.answerIndices.includes(idx);
      const next = exists
        ? prev.answerIndices.filter((i) => i !== idx)
        : [...prev.answerIndices, idx].sort((a, b) => a - b);
      return { ...prev, answerIndices: next };
    });
    if (error) setError(null);
  };

  const handleOptionChange = (idx: number, val: string) => {
    setForm((prev) => {
      const nextOptions = [...prev.options];
      nextOptions[idx] = val;
      return { ...prev, options: nextOptions };
    });
    if (error) setError(null);
  };

  const handleAddOption = () => {
    if (readOnly) return;
    setForm((prev) => ({ ...prev, options: [...prev.options, ''] }));
  };

  const handleRemoveOption = (idx: number) => {
    if (readOnly || form.options.length <= 2) return;
    setForm((prev) => {
      const nextOptions = prev.options.filter((_, i) => i !== idx);
      const nextAnswers = prev.answerIndices
        .filter((ansIdx) => ansIdx !== idx)
        .map((ansIdx) => (ansIdx > idx ? ansIdx - 1 : ansIdx));
      return {
        ...prev,
        options: nextOptions,
        answerIndices: nextAnswers.length > 0 ? nextAnswers : [0],
      };
    });
  };

  const handleMoveOption = (idx: number, direction: -1 | 1) => {
    if (readOnly) return;
    const target = idx + direction;
    if (target < 0 || target >= form.options.length) return;
    setForm((prev) => {
      const nextOptions = [...prev.options];
      [nextOptions[idx], nextOptions[target]] = [nextOptions[target], nextOptions[idx]];
      const nextAnswers = prev.answerIndices
        .map((ansIdx) => {
          if (ansIdx === idx) return target;
          if (ansIdx === target) return idx;
          return ansIdx;
        })
        .sort((a, b) => a - b);
      return { ...prev, options: nextOptions, answerIndices: nextAnswers };
    });
  };

  const handleMultiSelectToggle = (multi: boolean) => {
    if (readOnly) return;
    setForm((prev) => ({
      ...prev,
      multiSelect: multi,
      answerIndices: !multi && prev.answerIndices.length > 1 ? [prev.answerIndices[0]] : prev.answerIndices,
    }));
  };

  const validateAndBuildPayload = (): QuestionCreatePayload | null => {
    const prompt = form.prompt.trim();
    if (!prompt) {
      setError('Question prompt is required.');
      return null;
    }

    const parsedPoints = Number.parseInt(form.defaultPoints, 10);
    if (!Number.isFinite(parsedPoints) || parsedPoints <= 0) {
      setError('Default points must be a positive whole number.');
      return null;
    }

    let options: string[] | null = null;
    let answerIndices: number[] | null = null;

    if (form.format === 'mcq') {
      const cleanedWithOrigIdx = form.options.map((opt, idx) => ({
        text: opt.trim(),
        origIdx: idx,
      }));
      const nonEmpty = cleanedWithOrigIdx.filter((o) => o.text.length > 0);
      if (nonEmpty.length < 2) {
        setError('Multiple-choice questions require at least 2 non-empty options.');
        return null;
      }
      const indexRemap = new Map<number, number>();
      nonEmpty.forEach((item, newIdx) => indexRemap.set(item.origIdx, newIdx));

      const remappedAnswers = form.answerIndices
        .map((origIdx) => indexRemap.get(origIdx))
        .filter((mapped): mapped is number => mapped !== undefined)
        .sort((a, b) => a - b);

      if (remappedAnswers.length === 0) {
        setError('Select at least one non-empty option as the correct answer.');
        return null;
      }

      options = nonEmpty.map((o) => o.text);
      answerIndices = Array.from(new Set(remappedAnswers));
    }

    const payload: QuestionCreatePayload = {
      title: form.title.trim() || null,
      external_key: form.externalKey.trim() || null,
      prompt,
      format: form.format,
      difficulty: form.difficulty,
      default_points: parsedPoints,
      active: form.active,
      tags: form.tags,
      options: form.format === 'mcq' ? options : [],
      answer_indices: form.format === 'mcq' ? answerIndices : [],
      code_language:
        form.format === 'code' || form.format === 'notebook' ? effectiveCodeLanguage : null,
      starter_code:
        form.format === 'code' || form.format === 'notebook' ? form.starterCode : null,
      allow_execution:
        form.format === 'notebook'
          ? form.allowExecution
          : form.format === 'code'
            ? form.allowExecution
            : false,
      expected_answer: form.expectedAnswer,
      evaluation_rubric: form.evaluationRubric,
    };

    return payload;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) return;

    setError(null);
    const payload = validateAndBuildPayload();
    if (!payload) {
      window.requestAnimationFrame(() => {
        errorAlertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      return;
    }

    setSaving(true);
    try {
      const saved = isEdit && question
        ? await api.admin.updateQuestion(question.id, payload)
        : await api.admin.createQuestion(payload);
      onSaved(saved, !isEdit);
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.detail : 'Failed to save question. Please try again.'
      );
      window.requestAnimationFrame(() => {
        errorAlertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } finally {
      setSaving(false);
    }
  };

  const modalTitle = readOnly
    ? 'Inspect Question'
    : isEdit
      ? `Edit Question #${question?.id}`
      : 'New Question';

  const modalDescription = readOnly
    ? 'Read-only view of question configuration, expected answer, and evaluation rubric.'
    : 'Configure prompt, format-specific settings, tags, expected answer, and AI grading rubric.';

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={modalTitle}
      description={modalDescription}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button type="submit" form={formId} variant="primary" loading={saving}>
              {isEdit ? 'Save Changes' : 'Create Question'}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-6" noValidate>
        {error && (
          <div ref={errorAlertRef}>
            <Alert variant="error" title="Validation Error">
              {error}
            </Alert>
          </div>
        )}

        {/* Format Selector */}
        <fieldset className="space-y-2" disabled={readOnly}>
          <legend className="text-xs font-medium text-slate-300">Question Format</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {FORMAT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const selected = form.format === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={selected}
                  onClick={() => handleFormatChange(opt.value)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all focus-ring',
                    selected
                      ? 'border-indigo-500/70 bg-indigo-500/15 text-slate-100 shadow-sm shadow-indigo-950/50'
                      : 'border-slate-800 bg-surface-0/70 text-slate-400 hover:border-slate-700 hover:text-slate-200',
                    readOnly && 'cursor-not-allowed opacity-75'
                  )}
                >
                  <div
                    className={cn(
                      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                      selected
                        ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-300'
                        : 'bg-slate-800/80 border-slate-700/70 text-slate-400'
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold leading-tight text-slate-100">
                      {opt.label}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
                      {opt.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Core Metadata Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-7">
            <Input
              label="Title"
              name="title"
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="e.g., RAG Chunking Tradeoffs (auto-derived from prompt if blank)"
              disabled={readOnly}
            />
          </div>
          <div className="sm:col-span-5">
            <Input
              label="External Key (Optional)"
              name="external_key"
              value={form.externalKey}
              onChange={(e) => setForm((prev) => ({ ...prev, externalKey: e.target.value }))}
              placeholder="e.g., ai-rag-chunking-01"
              hint="Stable slug used for deduplication during YAML/JSON imports."
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={readOnly}
            />
          </div>

          <div className="sm:col-span-4">
            <Select
              label="Difficulty"
              name="difficulty"
              value={form.difficulty}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, difficulty: e.target.value as QuestionDifficulty }))
              }
              disabled={readOnly}
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </Select>
          </div>

          <div className="sm:col-span-4">
            <Input
              label="Default Points *"
              name="default_points"
              type="number"
              min={1}
              max={1000}
              required
              value={form.defaultPoints}
              onChange={(e) => setForm((prev) => ({ ...prev, defaultPoints: e.target.value }))}
              disabled={readOnly}
            />
          </div>

          <div className="sm:col-span-4 flex items-end pb-2">
            <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                name="active"
                checked={form.active}
                onChange={(e) => setForm((prev) => ({ ...prev, active: e.target.checked }))}
                disabled={readOnly}
                className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-indigo-500 focus:ring-indigo-500/40"
              />
              <div>
                <span className="block text-xs font-medium text-slate-200">Active in Bank</span>
                <span className="block text-[11px] text-slate-400">
                  Eligible for random-pool templates
                </span>
              </div>
            </label>
          </div>
        </div>

        {/* Tags */}
        <TagInput
          label="Tags"
          value={form.tags}
          onChange={(tags) => setForm((prev) => ({ ...prev, tags }))}
          availableTags={availableTags}
          disabled={readOnly}
          hint="Press Enter or comma to add tags. Used for filtering, random-pool rules, and candidate quick-search chips."
        />

        {/* Markdown Prompt with Live Preview */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`${formId}-prompt`}
              className="block text-xs font-medium text-slate-300"
            >
              Question Prompt (Markdown) <span aria-hidden="true" className="text-rose-400">*</span>
            </label>
            <div
              role="tablist"
              aria-label="Prompt editor view"
              className="inline-flex rounded-lg border border-slate-800 bg-surface-0/90 p-0.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={promptTab === 'write'}
                onClick={() => setPromptTab('write')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
                  promptTab === 'write'
                    ? 'bg-indigo-600/90 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                <Edit3 className="h-3 w-3" aria-hidden="true" />
                Write
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={promptTab === 'preview'}
                onClick={() => setPromptTab('preview')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
                  promptTab === 'preview'
                    ? 'bg-indigo-600/90 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                <Eye className="h-3 w-3" aria-hidden="true" />
                Preview
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-700/80 bg-surface-0/90 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 transition-colors">
            {promptTab === 'write' && !readOnly && (
              <div className="flex items-center gap-1 border-b border-slate-800/90 bg-surface-1/70 px-2.5 py-1.5">
                <button
                  type="button"
                  title="Bold"
                  aria-label="Insert bold text"
                  onClick={() => applyPromptMarkdown('**', '**', 'bold')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
                >
                  <Bold className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title="Italic"
                  aria-label="Insert italic text"
                  onClick={() => applyPromptMarkdown('*', '*', 'italic')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
                >
                  <Italic className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title="Inline Code"
                  aria-label="Insert inline code"
                  onClick={() => applyPromptMarkdown('`', '`', 'code')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
                >
                  <Code className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title="Code Block"
                  aria-label="Insert code block"
                  onClick={() => applyPromptMarkdown('\n```python\n', '\n```\n', '# snippet')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
                >
                  <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title="Bullet List"
                  aria-label="Insert bullet list"
                  onClick={() => applyPromptMarkdown('\n- ', '', 'Requirement')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
                >
                  <List className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}

            {promptTab === 'write' ? (
              <textarea
                ref={promptTextareaRef}
                id={`${formId}-prompt`}
                name="prompt"
                rows={6}
                required
                disabled={readOnly}
                value={form.prompt}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, prompt: e.target.value }));
                  if (error) setError(null);
                }}
                placeholder="Write the full question statement in Markdown (tables, code blocks, and bullet lists are supported)…"
                className="block w-full resize-y bg-transparent px-3.5 py-3 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500 focus:outline-none custom-scrollbar disabled:opacity-60"
              />
            ) : (
              <div className="min-h-[156px] max-h-[280px] overflow-y-auto px-4 py-3.5 custom-scrollbar">
                {form.prompt.trim() ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{form.prompt}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-xs italic text-slate-500">
                    Nothing to preview yet. Switch to Write to compose the question prompt.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Format-Specific Section */}
        {form.format === 'mcq' && (
          <fieldset className="space-y-3 rounded-xl border border-slate-800/90 bg-surface-0/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <legend className="text-xs font-semibold text-slate-200">
                  Multiple-Choice Options & Correct Answer(s)
                </legend>
                <p className="text-[11px] text-slate-400">
                  Mark the correct option(s). Multi-select questions require exact-set matching.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <div
                  role="group"
                  aria-label="Selection mode"
                  className="inline-flex rounded-lg border border-slate-800 bg-surface-1 p-0.5 text-xs"
                >
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-pressed={!form.multiSelect}
                    onClick={() => handleMultiSelectToggle(false)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors focus-ring',
                      !form.multiSelect
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    Single-Select
                  </button>
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-pressed={form.multiSelect}
                    onClick={() => handleMultiSelectToggle(true)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors focus-ring',
                      form.multiSelect
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    Multi-Select
                  </button>
                </div>

                {form.answerIndices.length > 0 && (
                  <Badge variant="emerald" size="sm">
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    Correct: {form.answerIndices.map(formatLetter).join(', ')}
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {form.options.map((opt, idx) => {
                const isCorrect = form.answerIndices.includes(idx);
                return (
                  <div
                    key={idx}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                      isCorrect
                        ? 'border-emerald-500/45 bg-emerald-500/10'
                        : 'border-slate-800 bg-surface-1/70'
                    )}
                  >
                    <input
                      type={form.multiSelect ? 'checkbox' : 'radio'}
                      name={`${formId}-correct-option`}
                      checked={isCorrect}
                      disabled={readOnly}
                      onChange={() => toggleAnswerIndex(idx)}
                      aria-label={`Mark option ${formatLetter(idx)} as correct`}
                      className="h-4 w-4 shrink-0 border-slate-600 bg-surface-0 text-emerald-500 focus:ring-emerald-500/40"
                    />
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-xs font-semibold',
                        isCorrect
                          ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/40'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      )}
                    >
                      {formatLetter(idx)}
                    </span>
                    <input
                      type="text"
                      value={opt}
                      disabled={readOnly}
                      onChange={(e) => handleOptionChange(idx, e.target.value)}
                      placeholder={`Option ${formatLetter(idx)} text…`}
                      aria-label={`Option ${formatLetter(idx)}`}
                      className="flex-1 min-w-0 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-60"
                    />
                    {!readOnly && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleMoveOption(idx, -1)}
                          disabled={idx === 0}
                          aria-label={`Move option ${formatLetter(idx)} up`}
                          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 focus-ring"
                        >
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveOption(idx, 1)}
                          disabled={idx === form.options.length - 1}
                          aria-label={`Move option ${formatLetter(idx)} down`}
                          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 focus-ring"
                        >
                          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveOption(idx)}
                          disabled={form.options.length <= 2}
                          aria-label={`Remove option ${formatLetter(idx)}`}
                          className="rounded p-1 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-30 focus-ring"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={handleAddOption}
              >
                Add Option
              </Button>
            )}
          </fieldset>
        )}

        {(form.format === 'code' || form.format === 'notebook') && (
          <div className="space-y-3 rounded-xl border border-slate-800/90 bg-surface-0/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-slate-200">
                  {form.format === 'notebook'
                    ? 'Python Notebook Sandbox Configuration'
                    : 'Code Editor Configuration'}
                </h3>
                <p className="text-[11px] text-slate-400">
                  {form.format === 'notebook'
                    ? 'Starter code pre-populates the candidate’s first executable Python cell.'
                    : 'Choose syntax highlighting language and optional starter code scaffold.'}
                </p>
              </div>
              {form.format === 'notebook' && (
                <Badge variant="cyan" size="sm">
                  Python 3 Kernel
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              {form.format === 'code' && (
                <>
                  <div className="sm:col-span-5">
                    <Select
                      label="Programming Language"
                      name="code_language"
                      value={form.codeLanguage}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, codeLanguage: e.target.value }))
                      }
                      disabled={readOnly}
                    >
                      {CODE_LANGUAGES.map((lang) => (
                        <option key={lang.value} value={lang.value}>
                          {lang.label}
                        </option>
                      ))}
                      <option value="__custom__">Other / Custom…</option>
                    </Select>
                  </div>

                  {form.codeLanguage === '__custom__' && (
                    <div className="sm:col-span-4">
                      <Input
                        label="Custom Language"
                        value={form.customLanguage}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, customLanguage: e.target.value }))
                        }
                        placeholder="e.g., pyspark, kotlin, r"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        disabled={readOnly}
                      />
                    </div>
                  )}
                </>
              )}

              <div
                className={cn(
                  'pb-1.5',
                  form.format === 'notebook' ? 'sm:col-span-12' : 'sm:col-span-7'
                )}
              >
                <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    name="allow_execution"
                    checked={form.allowExecution}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, allowExecution: e.target.checked }))
                    }
                    disabled={readOnly}
                    className="h-4 w-4 rounded border-slate-600 bg-surface-0 text-cyan-500 focus:ring-cyan-500/40"
                  />
                  <div>
                    <span className="block text-xs font-medium text-slate-200">
                      Allow live code execution
                    </span>
                    <span className="block text-[11px] text-slate-400">
                      {form.format === 'notebook'
                        ? 'Enables candidate cell execution in the isolated sandbox kernel (when permitted by template).'
                        : 'Optional flag indicating this coding question permits sandbox execution.'}
                    </span>
                  </div>
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">Starter Code (Optional)</span>
                <span className="font-mono text-[11px] text-slate-400">
                  {effectiveCodeLanguage}
                </span>
              </div>
              <div className="h-[220px] overflow-hidden rounded-lg border border-slate-700/80 bg-[#1e1e1e]">
                <Editor
                  height="100%"
                  language={resolveMonacoLanguage(effectiveCodeLanguage)}
                  theme="vs-dark"
                  value={form.starterCode}
                  onChange={(val) =>
                    setForm((prev) => ({ ...prev, starterCode: val ?? '' }))
                  }
                  loading={
                    <div className="flex h-full items-center justify-center gap-2 bg-surface-0 text-xs text-slate-400">
                      <Spinner size="xs" />
                      Loading code editor…
                    </div>
                  }
                  options={{
                    readOnly,
                    minimap: { enabled: false },
                    fontSize: 12.5,
                    lineHeight: 19,
                    tabSize: 4,
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    padding: { top: 10, bottom: 10 },
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Expected Answer & Evaluation Rubric */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Textarea
            label="Expected Answer / Reference Solution"
            name="expected_answer"
            rows={5}
            disabled={readOnly}
            value={form.expectedAnswer}
            onChange={(e) => setForm((prev) => ({ ...prev, expectedAnswer: e.target.value }))}
            placeholder="Key concepts, exact solution, or reference implementation used by AI & human evaluators…"
            hint="Never exposed to candidates; can be overridden per interview template."
          />

          <Textarea
            label="Evaluation Rubric / Scoring Breakdown"
            name="evaluation_rubric"
            rows={5}
            disabled={readOnly}
            value={form.evaluationRubric}
            onChange={(e) => setForm((prev) => ({ ...prev, evaluationRubric: e.target.value }))}
            placeholder={
              '- 5 pts: Explains core tradeoff accurately\n- 3 pts: Addresses edge cases & failure modes\n- 2 pts: Concrete metrics or verification steps'
            }
            hint="Guides deterministic rubric justifications in AI grading and PDF reports."
          />
        </div>
      </form>
    </Modal>
  );
}
