import { useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bold,
  Code,
  Edit3,
  Eye,
  FileCode2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Quote,
} from 'lucide-react';
import { cn } from '../../lib/cn';

export interface MarkdownAnswerEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minRows?: number;
}

interface FormatAction {
  id: string;
  label: string;
  icon: typeof Bold;
  prefix: string;
  suffix?: string;
  placeholder: string;
  block?: boolean;
}

const FORMAT_ACTIONS: FormatAction[] = [
  { id: 'bold', label: 'Bold (Ctrl+B)', icon: Bold, prefix: '**', suffix: '**', placeholder: 'bold text' },
  { id: 'italic', label: 'Italic (Ctrl+I)', icon: Italic, prefix: '*', suffix: '*', placeholder: 'italic text' },
  { id: 'code', label: 'Inline Code', icon: Code, prefix: '`', suffix: '`', placeholder: 'code' },
  {
    id: 'codeblock',
    label: 'Code Block',
    icon: FileCode2,
    prefix: '```\n',
    suffix: '\n```',
    placeholder: '// paste code or pseudocode here',
    block: true,
  },
  { id: 'heading', label: 'Section Heading', icon: Heading3, prefix: '### ', placeholder: 'Section Title', block: true },
  { id: 'ul', label: 'Bullet List', icon: List, prefix: '- ', placeholder: 'Key point', block: true },
  { id: 'ol', label: 'Numbered List', icon: ListOrdered, prefix: '1. ', placeholder: 'First step', block: true },
  { id: 'quote', label: 'Blockquote', icon: Quote, prefix: '> ', placeholder: 'Callout or assumption', block: true },
];

export function MarkdownAnswerEditor({
  value,
  onChange,
  placeholder = 'Write a clear, structured response. Markdown formatting is supported…',
  disabled = false,
  minRows = 12,
}: MarkdownAnswerEditorProps) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stats = useMemo(() => {
    const trimmed = value.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const chars = value.length;
    return { words, chars };
  }, [value]);

  const applyFormat = (action: FormatAction) => {
    if (disabled) return;
    const el = textareaRef.current;
    if (!el) return;

    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);

    const needsLeadingNewline =
      action.block && before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    const inner = selected || action.placeholder;
    const suffix = action.suffix ?? '';
    const inserted = `${needsLeadingNewline}${action.prefix}${inner}${suffix}`;
    const nextValue = `${before}${inserted}${after}`;

    onChange(nextValue);

    const selectionStart = before.length + needsLeadingNewline.length + action.prefix.length;
    const selectionEnd = selectionStart + inner.length;

    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const isMod = event.ctrlKey || event.metaKey;
    if (isMod && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      applyFormat(FORMAT_ACTIONS[0]);
    } else if (isMod && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      applyFormat(FORMAT_ACTIONS[1]);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800/90 bg-surface-0/80 shadow-sm">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-surface-1/80 px-3 py-2">
        {/* Write / Preview Tabs */}
        <div
          role="tablist"
          aria-label="Editor mode"
          className="inline-flex rounded-lg border border-slate-800 bg-surface-0/90 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'write'}
            onClick={() => setMode('write')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
              mode === 'write'
                ? 'bg-indigo-600/90 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            )}
          >
            <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            onClick={() => setMode('preview')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
              mode === 'preview'
                ? 'bg-indigo-600/90 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            )}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </button>
        </div>

        {/* Formatting Controls */}
        {mode === 'write' && (
          <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="Markdown formatting">
            {FORMAT_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  title={action.label}
                  aria-label={action.label}
                  disabled={disabled}
                  onClick={() => applyFormat(action)}
                  className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40 focus-ring"
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Editor or Preview Surface */}
      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          rows={minRows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Long-form response editor"
          className={cn(
            'block w-full resize-y bg-transparent px-4 py-3.5 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500',
            'focus:outline-none custom-scrollbar min-h-[260px]'
          )}
        />
      ) : (
        <div className="min-h-[260px] px-5 py-4 custom-scrollbar overflow-y-auto">
          {value.trim() ? (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm italic text-slate-500">
              Nothing to preview yet. Switch to Write mode to compose your response.
            </p>
          )}
        </div>
      )}

      {/* Footer Word Count & Hint */}
      <div className="flex items-center justify-between gap-4 border-t border-slate-800/80 bg-surface-1/50 px-4 py-2 text-[11px] text-slate-400">
        <span>Markdown supported · Clear structure & trade-offs help reviewers</span>
        <div className="flex items-center gap-3 font-mono tabular-nums">
          <span>
            <strong className="font-semibold text-slate-200">{stats.words}</strong>{' '}
            {stats.words === 1 ? 'word' : 'words'}
          </span>
          <span className="text-slate-600">·</span>
          <span>
            <strong className="font-semibold text-slate-200">{stats.chars}</strong> chars
          </span>
        </div>
      </div>
    </div>
  );
}
