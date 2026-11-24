import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  Edit3,
  Eraser,
  FileText,
  Maximize2,
  Minimize2,
  Package,
  Play,
  PlayCircle,
  Plus,
  RotateCw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Alert, Badge, Button, Spinner, useToast } from '../ui';

export interface NotebookCell {
  id: string;
  type: 'code' | 'markdown';
  source: string;
  stdout: string;
  stderr: string;
  html: string | null;
  image_png_base64: string | null;
  error: string | null;
  execution_count: number | null;
  duration_ms: number | null;
  running?: boolean;
}

export interface InstalledPackageInfo {
  name: string;
  sizeMb?: number;
}

export interface NotebookWorkspaceProps {
  value: string;
  onChange: (serialized: string) => void;
  starterCode?: string | null;
  sessionToken?: string;
  allowExecution: boolean;
  allowPackageInstall: boolean;
  pythonVersion?: string;
  previewMode?: boolean;
  disabled?: boolean;
  installedPackages?: InstalledPackageInfo[];
  onPackageInstalled?: (pkg: InstalledPackageInfo) => void;
}

type KernelState = 'idle' | 'running' | 'restarting' | 'disabled' | 'preview';

let cellIdCounter = 0;
function nextCellId(): string {
  cellIdCounter += 1;
  return `cell-${Date.now().toString(36)}-${cellIdCounter}`;
}

function createEmptyCell(type: 'code' | 'markdown' = 'code', source = ''): NotebookCell {
  return {
    id: nextCellId(),
    type,
    source,
    stdout: '',
    stderr: '',
    html: null,
    image_png_base64: null,
    error: null,
    execution_count: null,
    duration_ms: null,
    running: false,
  };
}

function normalizeRawCell(raw: unknown): NotebookCell | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawType = String(obj.type ?? obj.cell_type ?? 'code').toLowerCase();
  const type: 'code' | 'markdown' = rawType === 'markdown' ? 'markdown' : 'code';

  let source = '';
  if (typeof obj.source === 'string') {
    source = obj.source;
  } else if (Array.isArray(obj.source)) {
    source = obj.source.map((s) => String(s)).join('');
  }

  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : nextCellId(),
    type,
    source,
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
    html: typeof obj.html === 'string' && obj.html ? obj.html : null,
    image_png_base64:
      typeof obj.image_png_base64 === 'string' && obj.image_png_base64
        ? obj.image_png_base64
        : null,
    error: typeof obj.error === 'string' && obj.error ? obj.error : null,
    execution_count:
      typeof obj.execution_count === 'number' && Number.isFinite(obj.execution_count)
        ? obj.execution_count
        : null,
    duration_ms:
      typeof obj.duration_ms === 'number' && Number.isFinite(obj.duration_ms)
        ? obj.duration_ms
        : null,
    running: false,
  };
}

export function parseNotebookValue(
  rawValue: string | null | undefined,
  starterCode?: string | null
): NotebookCell[] {
  const candidates = [rawValue, starterCode];

  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue;
    const trimmed = candidate.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const rawList =
          Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cells?: unknown }).cells)
              ? (parsed as { cells: unknown[] }).cells
              : null;

        if (rawList && rawList.length > 0) {
          const normalized = rawList
            .map(normalizeRawCell)
            .filter((cell): cell is NotebookCell => cell !== null);
          if (normalized.length > 0) {
            return normalized;
          }
        }
      } catch {
        // Fall through and treat as plain Python starter source
      }
    }

    return [createEmptyCell('code', candidate)];
  }

  return [createEmptyCell('code', '')];
}

export function serializeNotebookCells(cells: NotebookCell[]): string {
  const payload = {
    cells: cells.map((cell) => ({
      id: cell.id,
      type: cell.type,
      source: cell.source,
      stdout: cell.stdout,
      stderr: cell.stderr,
      html: cell.html,
      image_png_base64: cell.image_png_base64,
      ...(cell.image_png_base64 ? { images: ['plot.png'] } : {}),
      error: cell.error,
      execution_count: cell.execution_count,
      duration_ms: cell.duration_ms,
    })),
  };
  return JSON.stringify(payload);
}

export function hasNotebookContent(rawValue: unknown): boolean {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return false;
  const cells = parseNotebookValue(rawValue, null);
  return cells.some((c) => c.source.trim().length > 0);
}

// ---------------------------------------------------------------------------
// XSS-safe HTML Table / DataFrame Output Renderer
// Uses native Sanitizer API (`Element.prototype.setHTML`) when available, with
// a strict DOMParser allowlist fallback for browsers without Sanitizer API.
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

function sanitizeHtmlToNodes(rawHtml: string, targetDoc: Document): Node[] {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawHtml, 'text/html');

  const cloneSafeNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      return targetDoc.createTextNode(node.textContent ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_HTML_TAGS.has(tag)) {
      return null;
    }

    const cleanEl = targetDoc.createElement(tag);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (ALLOWED_HTML_ATTRS.has(name)) {
        cleanEl.setAttribute(name, attr.value);
      }
    }

    for (const child of Array.from(el.childNodes)) {
      const safeChild = cloneSafeNode(child);
      if (safeChild) {
        cleanEl.appendChild(safeChild);
      }
    }
    return cleanEl;
  };

  const result: Node[] = [];
  for (const child of Array.from(parsed.body.childNodes)) {
    const safeChild = cloneSafeNode(child);
    if (safeChild) {
      result.push(safeChild);
    }
  }
  return result;
}

function SanitizedHtmlOutput({ html }: { html: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const nativeSetHTML = (
      container as HTMLDivElement & {
        setHTML?: (
          input: string,
          options?: { sanitizer?: { elements?: string[]; attributes?: string[] } }
        ) => void;
      }
    ).setHTML;

    let usedNative = false;
    if (typeof nativeSetHTML === 'function') {
      try {
        nativeSetHTML.call(container, html, {
          sanitizer: {
            elements: Array.from(ALLOWED_HTML_TAGS),
            attributes: Array.from(ALLOWED_HTML_ATTRS),
          },
        });
        usedNative = true;
      } catch {
        usedNative = false;
      }
    }
    if (!usedNative) {
      const safeNodes = sanitizeHtmlToNodes(html, container.ownerDocument);
      container.replaceChildren(...safeNodes);
    }
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="notebook-html-output overflow-x-auto custom-scrollbar"
    />
  );
}

// ---------------------------------------------------------------------------
// Individual Notebook Cell Card
// ---------------------------------------------------------------------------

interface NotebookCellRowProps {
  cell: NotebookCell;
  index: number;
  total: number;
  isActive: boolean;
  allowExecution: boolean;
  disabled: boolean;
  onSelect: () => void;
  onChangeSource: (source: string) => void;
  onRunAndAdvance: (advance: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onInsertBelow: () => void;
  onClearOutput: () => void;
  onDelete: () => void;
  registerFocus: (cellId: string, focusFn: () => void) => void;
}

function NotebookCellRow({
  cell,
  index,
  total,
  isActive,
  allowExecution,
  disabled,
  onSelect,
  onChangeSource,
  onRunAndAdvance,
  onMoveUp,
  onMoveDown,
  onInsertBelow,
  onClearOutput,
  onDelete,
  registerFocus,
}: NotebookCellRowProps) {
  const [editingMarkdown, setEditingMarkdown] = useState(
    cell.type === 'markdown' && cell.source.trim().length === 0
  );
  const [expandedPlot, setExpandedPlot] = useState(false);

  const runRef = useRef(onRunAndAdvance);
  runRef.current = onRunAndAdvance;

  const mdTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (cell.type === 'markdown') {
      registerFocus(cell.id, () => {
        setEditingMarkdown(true);
        window.requestAnimationFrame(() => mdTextareaRef.current?.focus());
      });
    }
  }, [cell.id, cell.type, registerFocus]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    registerFocus(cell.id, () => {
      editor.focus();
    });

    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      runRef.current(true);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      runRef.current(false);
    });
  };

  const lineCount = Math.max(2, cell.source.split('\n').length);
  const editorHeight = Math.min(420, Math.max(82, lineCount * 20 + 28));

  const hasOutputs = Boolean(
    cell.stdout || cell.stderr || cell.html || cell.image_png_base64 || cell.error
  );

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group rounded-xl border transition-all duration-150 overflow-hidden',
        isActive
          ? 'border-indigo-500/60 bg-surface-1/95 shadow-glow-indigo'
          : 'border-slate-800/90 bg-surface-1/75 hover:border-slate-700/90'
      )}
    >
      {/* Cell Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 bg-surface-0/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          {cell.type === 'code' ? (
            <span
              className={cn(
                'inline-flex min-w-[54px] items-center justify-center rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold',
                cell.running
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/35'
                  : cell.error
                    ? 'bg-rose-500/15 text-rose-300 border border-rose-500/35'
                    : cell.execution_count !== null
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : 'bg-slate-800/80 text-slate-400 border border-slate-700/70'
              )}
            >
              {cell.running
                ? 'In [*]'
                : cell.execution_count !== null
                  ? `In [${cell.execution_count}]`
                  : 'In [ ]'}
            </span>
          ) : (
            <span className="inline-flex min-w-[54px] items-center justify-center rounded-md bg-indigo-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-indigo-300 border border-indigo-500/30">
              MD
            </span>
          )}

          <span className="text-[11px] font-medium text-slate-400">
            Cell {index + 1} · {cell.type === 'code' ? 'Python' : 'Markdown'}
          </span>

          {cell.duration_ms !== null && !cell.running && (
            <span className="font-mono text-[10px] text-slate-500">{cell.duration_ms} ms</span>
          )}
        </div>

        {/* Cell Controls */}
        <div className="flex items-center gap-1">
          {cell.type === 'code' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || cell.running || !allowExecution}
              onClick={(e) => {
                e.stopPropagation();
                onRunAndAdvance(false);
              }}
              title={allowExecution ? 'Run cell (Shift+Enter)' : 'Execution disabled'}
              leftIcon={
                cell.running ? (
                  <Spinner size="xs" />
                ) : (
                  <Play className="h-3.5 w-3.5 text-emerald-400 fill-emerald-400/30" />
                )
              }
              className="h-7 px-2 text-xs text-slate-200 hover:bg-emerald-500/15 hover:text-emerald-200"
            >
              {cell.running ? 'Running…' : 'Run'}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                setEditingMarkdown((prev) => !prev);
              }}
              leftIcon={
                editingMarkdown ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Edit3 className="h-3.5 w-3.5 text-indigo-400" />
                )
              }
              className="h-7 px-2 text-xs text-slate-200"
            >
              {editingMarkdown ? 'Render' : 'Edit'}
            </Button>
          )}

          {hasOutputs && (
            <button
              type="button"
              disabled={disabled || cell.running}
              onClick={(e) => {
                e.stopPropagation();
                onClearOutput();
              }}
              title="Clear cell output"
              aria-label="Clear cell output"
              className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-35 focus-ring"
            >
              <Eraser className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            disabled={disabled || index === 0}
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
            title="Move cell up"
            aria-label="Move cell up"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 focus-ring"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={disabled || index === total - 1}
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
            title="Move cell down"
            aria-label="Move cell down"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 focus-ring"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onInsertBelow();
            }}
            title="Insert code cell below"
            aria-label="Insert code cell below"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-30 focus-ring"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={disabled || cell.running}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete cell"
            aria-label="Delete cell"
            className="rounded-md p-1 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-30 focus-ring"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Cell Body */}
      {cell.type === 'code' ? (
        <div style={{ height: `${editorHeight}px` }} className="w-full bg-[#1e1e1e]">
          <Editor
            height="100%"
            language="python"
            theme="vs-dark"
            value={cell.source}
            onChange={(next) => onChangeSource(next ?? '')}
            onMount={handleEditorMount}
            loading={
              <div className="flex h-full items-center justify-center gap-2 bg-surface-0 text-xs text-slate-400">
                <Spinner size="xs" />
                Loading editor…
              </div>
            }
            options={{
              readOnly: disabled,
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 20,
              fontFamily:
                "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              tabSize: 4,
              insertSpaces: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              scrollbar: { alwaysConsumeMouseWheel: false },
              wordWrap: 'on',
              padding: { top: 10, bottom: 10 },
              lineNumbersMinChars: 3,
              folding: false,
              renderLineHighlight: 'line',
            }}
          />
        </div>
      ) : editingMarkdown ? (
        <div className="bg-surface-0/70 p-3">
          <textarea
            ref={mdTextareaRef}
            rows={Math.max(3, Math.min(12, cell.source.split('\n').length + 1))}
            value={cell.source}
            disabled={disabled}
            onChange={(e) => onChangeSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.shiftKey && e.key === 'Enter') {
                e.preventDefault();
                setEditingMarkdown(false);
                onRunAndAdvance(true);
              }
            }}
            placeholder="Write notes, explanations, or math assumptions in Markdown… (Shift+Enter to render)"
            className="w-full resize-y rounded-lg border border-slate-800 bg-surface-1/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none custom-scrollbar"
          />
          <p className="mt-1.5 text-[11px] text-slate-500">
            Press <kbd className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-300">Shift+Enter</kbd> to render Markdown.
          </p>
        </div>
      ) : (
        <div
          onDoubleClick={() => !disabled && setEditingMarkdown(true)}
          className="cursor-text bg-surface-0/40 px-4 py-3.5"
          title="Double-click to edit Markdown"
        >
          {cell.source.trim() ? (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{cell.source}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-xs italic text-slate-500">
              Empty Markdown cell — double-click or click Edit to write notes.
            </p>
          )}
        </div>
      )}

      {/* Per-Cell Outputs */}
      {cell.type === 'code' && hasOutputs && (
        <div className="space-y-2.5 border-t border-slate-800/90 bg-surface-0/90 px-4 py-3">
          {cell.stdout && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-200 custom-scrollbar">
              {cell.stdout}
            </pre>
          )}

          {cell.html && <SanitizedHtmlOutput html={cell.html} />}

          {cell.image_png_base64 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-400">Rendered Plot</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedPlot((prev) => !prev);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200 focus-ring"
                >
                  {expandedPlot ? (
                    <>
                      <Minimize2 className="h-3 w-3" /> Fit
                    </>
                  ) : (
                    <>
                      <Maximize2 className="h-3 w-3" /> Expand
                    </>
                  )}
                </button>
              </div>
              <div className="inline-block max-w-full overflow-x-auto rounded-lg border border-slate-700/80 bg-white p-2.5 shadow-sm">
                <img
                  src={`data:image/png;base64,${cell.image_png_base64}`}
                  alt={`Output plot for cell ${index + 1}`}
                  className={cn(
                    'block h-auto rounded',
                    expandedPlot ? 'max-w-none' : 'max-w-full max-h-[420px]'
                  )}
                />
              </div>
            </div>
          )}

          {cell.stderr && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 font-mono text-xs leading-relaxed text-amber-200 custom-scrollbar">
              {cell.stderr}
            </pre>
          )}

          {cell.error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/35 bg-rose-500/10 p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-rose-400" aria-hidden="true" />
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-rose-200 custom-scrollbar">
                {cell.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Multi-Cell Notebook Workspace
// ---------------------------------------------------------------------------

export function NotebookWorkspace({
  value,
  onChange,
  starterCode,
  sessionToken,
  allowExecution,
  allowPackageInstall,
  pythonVersion = '3.11',
  previewMode = false,
  disabled = false,
  installedPackages = [],
  onPackageInstalled,
}: NotebookWorkspaceProps) {
  const { toast } = useToast();
  const [cells, setCells] = useState<NotebookCell[]>(() =>
    parseNotebookValue(value, starterCode)
  );
  const [activeCellId, setActiveCellId] = useState<string>(() => cells[0]?.id ?? '');
  const [runningAll, setRunningAll] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Package installer state
  const [pkgInput, setPkgInput] = useState('');
  const [installingPkg, setInstallingPkg] = useState(false);
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [localInstalled, setLocalInstalled] = useState<InstalledPackageInfo[]>(installedPackages);

  useEffect(() => {
    setLocalInstalled(installedPackages);
  }, [installedPackages]);

  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  const focusMapRef = useRef<Map<string, () => void>>(new Map());
  const registerFocus = useCallback((cellId: string, focusFn: () => void) => {
    focusMapRef.current.set(cellId, focusFn);
  }, []);

  const commitCells = useCallback(
    (updater: (prev: NotebookCell[]) => NotebookCell[]) => {
      const next = updater(cellsRef.current);
      cellsRef.current = next;
      setCells(next);
      onChange(serializeNotebookCells(next));
    },
    [onChange]
  );

  // Ensure initial starter cells are persisted to parent state if value was empty
  useEffect(() => {
    if (!value && cellsRef.current.length > 0) {
      onChange(serializeNotebookCells(cellsRef.current));
    }
    // Only on mount for this question instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canRunKernel = allowExecution && Boolean(sessionToken) && !disabled;
  const anyCellRunning = cells.some((c) => c.running);

  const kernelState: KernelState = !allowExecution
    ? 'disabled'
    : previewMode && !sessionToken
      ? 'preview'
      : restarting
        ? 'restarting'
        : anyCellRunning || runningAll
          ? 'running'
          : 'idle';

  const focusCell = useCallback((cellId: string) => {
    setActiveCellId(cellId);
    window.requestAnimationFrame(() => {
      focusMapRef.current.get(cellId)?.();
    });
  }, []);

  const addCell = useCallback(
    (type: 'code' | 'markdown', afterIndex?: number) => {
      const created = createEmptyCell(type, '');
      commitCells((prev) => {
        const insertAt =
          afterIndex !== undefined && afterIndex >= 0 && afterIndex < prev.length
            ? afterIndex + 1
            : prev.length;
        const next = [...prev];
        next.splice(insertAt, 0, created);
        return next;
      });
      focusCell(created.id);
      return created.id;
    },
    [commitCells, focusCell]
  );

  const moveCell = useCallback(
    (index: number, delta: -1 | 1) => {
      commitCells((prev) => {
        const target = index + delta;
        if (target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        return next;
      });
    },
    [commitCells]
  );

  const deleteCell = useCallback(
    (cellId: string) => {
      const filtered = cellsRef.current.filter((c) => c.id !== cellId);
      let nextCells: NotebookCell[];
      let nextActiveId: string | null = null;

      if (filtered.length === 0) {
        const fallback = createEmptyCell('code', '');
        nextCells = [fallback];
        nextActiveId = fallback.id;
      } else {
        nextCells = filtered;
        if (activeCellId === cellId) {
          nextActiveId = filtered[0].id;
        }
      }

      commitCells(() => nextCells);
      if (nextActiveId !== null) {
        setActiveCellId(nextActiveId);
      }
    },
    [activeCellId, commitCells]
  );

  const clearCellOutput = useCallback(
    (cellId: string) => {
      commitCells((prev) =>
        prev.map((c) =>
          c.id === cellId
            ? {
                ...c,
                stdout: '',
                stderr: '',
                html: null,
                image_png_base64: null,
                error: null,
                duration_ms: null,
              }
            : c
        )
      );
    },
    [commitCells]
  );

  const executeSingleCell = useCallback(
    async (cellId: string): Promise<boolean> => {
      const target = cellsRef.current.find((c) => c.id === cellId);
      if (!target || target.type !== 'code') return true;

      if (!allowExecution) {
        toast({
          title: 'Sandbox execution disabled',
          description: 'Code execution is turned off for this assessment. Your code will still be saved and graded.',
          variant: 'info',
        });
        return false;
      }

      if (!sessionToken) {
        toast({
          title: 'Preview Mode',
          description: 'Live Python kernel execution is active during real candidate sessions.',
          variant: 'info',
        });
        return false;
      }

      const runningNext = cellsRef.current.map((c) =>
        c.id === cellId ? { ...c, running: true, error: null } : c
      );
      cellsRef.current = runningNext;
      setCells(runningNext);

      try {
        const res = await api.public.executeNotebook({
          session_token: sessionToken,
          code: target.source,
        });

        commitCells((prev) =>
          prev.map((c) =>
            c.id === cellId
              ? {
                  ...c,
                  running: false,
                  execution_count: res.execution_count,
                  stdout: res.stdout || '',
                  stderr: res.stderr || '',
                  html: res.html || null,
                  image_png_base64: res.image_png_base64 || null,
                  error: res.error || null,
                  duration_ms: res.duration_ms,
                }
              : c
          )
        );
        return res.ok && !res.error;
      } catch (err: unknown) {
        const detail =
          err instanceof ApiError ? err.detail : 'Failed to execute cell on notebook kernel.';
        commitCells((prev) =>
          prev.map((c) =>
            c.id === cellId
              ? {
                  ...c,
                  running: false,
                  error: detail,
                }
              : c
          )
        );
        return false;
      }
    },
    [allowExecution, sessionToken, commitCells, toast]
  );

  const handleRunAndAdvance = useCallback(
    async (cellId: string, advance: boolean) => {
      const currentList = cellsRef.current;
      const idx = currentList.findIndex((c) => c.id === cellId);
      const cell = currentList[idx];
      if (!cell) return;

      if (cell.type === 'code') {
        await executeSingleCell(cellId);
      }

      if (advance) {
        const updatedList = cellsRef.current;
        const currentIdx = updatedList.findIndex((c) => c.id === cellId);
        if (currentIdx >= 0 && currentIdx + 1 < updatedList.length) {
          focusCell(updatedList[currentIdx + 1].id);
        } else if (cell.source.trim().length > 0 && !disabled) {
          addCell('code', currentIdx);
        }
      }
    },
    [executeSingleCell, focusCell, addCell, disabled]
  );

  const handleRunAll = async () => {
    if (runningAll || restarting || disabled) return;
    if (!canRunKernel) {
      await executeSingleCell(cellsRef.current.find((c) => c.type === 'code')?.id ?? '');
      return;
    }

    setRunningAll(true);
    try {
      const codeCells = cellsRef.current.filter((c) => c.type === 'code');
      for (let i = 0; i < codeCells.length; i += 1) {
        const ok = await executeSingleCell(codeCells[i].id);
        if (!ok) {
          toast({
            title: 'Run All stopped on error',
            description: `Execution halted at code cell #${i + 1}. Fix the error and run again.`,
            variant: 'warning',
          });
          break;
        }
      }
    } finally {
      setRunningAll(false);
    }
  };

  const handleRestartKernel = async () => {
    if (restarting || disabled) return;
    if (!allowExecution || !sessionToken) {
      toast({
        title: previewMode ? 'Preview Mode' : 'Execution Disabled',
        description: previewMode
          ? 'Kernel restart is available during live candidate sessions.'
          : 'Code execution is disabled for this template.',
        variant: 'info',
      });
      return;
    }

    setRestarting(true);
    try {
      await api.public.restartNotebook({ session_token: sessionToken });
      commitCells((prev) =>
        prev.map((c) => ({
          ...c,
          execution_count: null,
          running: false,
        }))
      );
      toast({
        title: 'Kernel restarted',
        description: 'Python memory and variables have been reset cleanly.',
        variant: 'success',
      });
    } catch (err: unknown) {
      toast({
        title: 'Kernel restart failed',
        description: err instanceof ApiError ? err.detail : 'Unable to restart Python kernel.',
        variant: 'error',
      });
    } finally {
      setRestarting(false);
    }
  };

  const handleInstallPackage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const spec = pkgInput.trim();
    if (!spec || installingPkg || disabled) return;

    setPkgError(null);

    if (!sessionToken) {
      setPkgError('Package installation is only active during live candidate sessions.');
      return;
    }

    setInstallingPkg(true);
    try {
      const res = await api.public.installNotebookPackage({
        session_token: sessionToken,
        package: spec,
      });

      if (!res.ok) {
        setPkgError(res.error || res.output || `Could not install "${spec}".`);
        return;
      }

      const installedEntry: InstalledPackageInfo = {
        name: res.package || spec,
        sizeMb: res.size_mb > 0 ? res.size_mb : undefined,
      };

      setLocalInstalled((prev) => {
        const exists = prev.some(
          (item) => item.name.toLowerCase() === installedEntry.name.toLowerCase()
        );
        return exists ? prev : [...prev, installedEntry];
      });
      onPackageInstalled?.(installedEntry);
      setPkgInput('');
      toast({
        title: `Installed ${installedEntry.name}`,
        description:
          installedEntry.sizeMb !== undefined
            ? `Package installed (${installedEntry.sizeMb.toFixed(1)} MB) and ready to import.`
            : 'Package installed and ready to import in your notebook cells.',
        variant: 'success',
      });
    } catch (err: unknown) {
      setPkgError(
        err instanceof ApiError ? err.detail : `Package installation failed for "${spec}".`
      );
    } finally {
      setInstallingPkg(false);
    }
  };

  const kernelBadge = (() => {
    switch (kernelState) {
      case 'running':
        return (
          <Badge variant="amber" dot className="animate-pulse">
            Running
          </Badge>
        );
      case 'restarting':
        return (
          <Badge variant="cyan" dot className="animate-pulse">
            Restarting…
          </Badge>
        );
      case 'disabled':
        return (
          <Badge variant="slate" dot>
            Execution Disabled
          </Badge>
        );
      case 'preview':
        return (
          <Badge variant="indigo" dot>
            Preview Kernel
          </Badge>
        );
      case 'idle':
      default:
        return (
          <Badge variant="emerald" dot>
            Kernel Idle
          </Badge>
        );
    }
  })();

  return (
    <div className="space-y-3">
      {/* Top Notebook Toolbar */}
      <div className="rounded-xl border border-slate-800/90 bg-surface-1/90 shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5">
          {/* Left: Kernel Status & Python Runtime */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              <Terminal className="h-4 w-4 text-cyan-400" aria-hidden="true" />
              Python Notebook
            </div>
            <Badge variant="cyan" size="sm">
              Python {pythonVersion}
            </Badge>
            {kernelBadge}
          </div>

          {/* Right: Cell & Kernel Actions */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              leftIcon={<Code2 className="h-3.5 w-3.5 text-cyan-400" />}
              onClick={() => addCell('code')}
            >
              + Code
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              leftIcon={<FileText className="h-3.5 w-3.5 text-indigo-400" />}
              onClick={() => addCell('markdown')}
            >
              + Markdown
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || !allowExecution || restarting}
              loading={runningAll}
              leftIcon={<PlayCircle className="h-3.5 w-3.5" />}
              onClick={handleRunAll}
            >
              Run All
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !allowExecution || runningAll}
              loading={restarting}
              leftIcon={<RotateCw className="h-3.5 w-3.5" />}
              onClick={handleRestartKernel}
            >
              Restart Kernel
            </Button>
          </div>
        </div>

        {/* Conditional Package Manager Bar */}
        {allowExecution && allowPackageInstall && (
          <div className="border-t border-slate-800/80 bg-surface-0/65 px-3.5 py-2.5 space-y-2.5">
            <form
              onSubmit={handleInstallPackage}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300 shrink-0">
                <Package className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                Install Package
              </div>
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="text"
                  value={pkgInput}
                  onChange={(e) => {
                    setPkgInput(e.target.value);
                    if (pkgError) setPkgError(null);
                  }}
                  disabled={disabled || installingPkg}
                  placeholder="PyPI package name (e.g. tabulate, scipy, scikit-learn) or use %pip install in a cell"
                  aria-label="PyPI package name"
                  className="h-8 flex-1 rounded-lg border border-slate-700/80 bg-surface-1 px-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 disabled:opacity-50"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  loading={installingPkg}
                  disabled={disabled || !pkgInput.trim()}
                >
                  {installingPkg ? 'Installing…' : 'Install'}
                </Button>
              </div>
            </form>

            {pkgError && (
              <Alert
                variant="error"
                title="Package Install Rejected"
                onDismiss={() => setPkgError(null)}
              >
                {pkgError}
              </Alert>
            )}

            {localInstalled.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-400 mr-1">Installed:</span>
                {localInstalled.map((pkg) => (
                  <Badge key={pkg.name} variant="emerald" size="sm">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    <span className="font-mono">{pkg.name}</span>
                    {pkg.sizeMb !== undefined && (
                      <span className="opacity-75">({pkg.sizeMb.toFixed(1)} MB)</span>
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Keyboard Shortcut Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-slate-400">
        <span>
          <kbd className="rounded bg-slate-800/90 border border-slate-700/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
            Shift+Enter
          </kbd>{' '}
          run cell & advance ·{' '}
          <kbd className="rounded bg-slate-800/90 border border-slate-700/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
            Ctrl+Enter
          </kbd>{' '}
          run cell in place
        </span>
        <span className="font-mono text-slate-500">
          {cells.length} {cells.length === 1 ? 'cell' : 'cells'}
        </span>
      </div>

      {/* Ordered Cells */}
      <div className="space-y-3">
        {cells.map((cell, idx) => (
          <NotebookCellRow
            key={cell.id}
            cell={cell}
            index={idx}
            total={cells.length}
            isActive={activeCellId === cell.id}
            allowExecution={allowExecution}
            disabled={disabled}
            onSelect={() => setActiveCellId(cell.id)}
            onChangeSource={(source) =>
              commitCells((prev) =>
                prev.map((c) => (c.id === cell.id ? { ...c, source } : c))
              )
            }
            onRunAndAdvance={(advance) => {
              void handleRunAndAdvance(cell.id, advance);
            }}
            onMoveUp={() => moveCell(idx, -1)}
            onMoveDown={() => moveCell(idx, 1)}
            onInsertBelow={() => addCell('code', idx)}
            onClearOutput={() => clearCellOutput(cell.id)}
            onDelete={() => deleteCell(cell.id)}
            registerFocus={registerFocus}
          />
        ))}
      </div>

      {/* Quick Bottom Add Bar */}
      <div className="flex items-center justify-center gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => addCell('code')}
          className="text-slate-400 hover:text-slate-100"
        >
          Add Code Cell
        </Button>
        <span className="text-slate-700">·</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => addCell('markdown')}
          className="text-slate-400 hover:text-slate-100"
        >
          Add Markdown Cell
        </Button>
      </div>
    </div>
  );
}
