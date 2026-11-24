import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Plus, Tag, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { TagSummary } from '../../types/api';

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  availableTags?: Array<TagSummary | string>;
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

interface NormalizedSuggestion {
  name: string;
  count?: number;
}

function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/,+/g, '');
}

export function TagInput({
  value,
  onChange,
  availableTags = [],
  label,
  hint,
  error,
  placeholder = 'Add tag (Enter or comma)…',
  disabled = false,
  id,
  className,
}: TagInputProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const autoId = useId();
  const fieldId = id ?? autoId;
  const listboxId = `${fieldId}-listbox`;
  const descId = error || hint ? `${fieldId}-desc` : undefined;

  const selectedSet = useMemo(() => new Set(value.map((t) => t.toLowerCase())), [value]);

  const normalizedPool = useMemo<NormalizedSuggestion[]>(() => {
    const map = new Map<string, NormalizedSuggestion>();
    for (const item of availableTags) {
      if (typeof item === 'string') {
        const name = normalizeTag(item);
        if (name && !map.has(name)) {
          map.set(name, { name });
        }
      } else {
        const name = normalizeTag(item.name);
        if (name) {
          map.set(name, { name, count: item.question_count });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [availableTags]);

  const suggestions = useMemo(() => {
    const q = normalizeTag(query);
    return normalizedPool
      .filter((item) => !selectedSet.has(item.name))
      .filter((item) => (!q ? true : item.name.includes(q)))
      .slice(0, 12);
  }, [normalizedPool, selectedSet, query]);

  const normalizedQuery = normalizeTag(query);
  const canCreateNew =
    Boolean(normalizedQuery) &&
    !selectedSet.has(normalizedQuery) &&
    !suggestions.some((s) => s.name === normalizedQuery);

  const totalOptions = suggestions.length + (canCreateNew ? 1 : 0);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const addTags = (rawTags: string[]) => {
    if (disabled) return;
    const next = [...value];
    const existing = new Set(next.map((t) => t.toLowerCase()));
    let changed = false;

    for (const raw of rawTags) {
      const cleaned = normalizeTag(raw);
      if (cleaned && !existing.has(cleaned)) {
        next.push(cleaned);
        existing.add(cleaned);
        changed = true;
      }
    }
    if (changed) {
      onChange(next);
    }
    setQuery('');
  };

  const removeTag = (tagToRemove: string) => {
    if (disabled) return;
    onChange(value.filter((tag) => tag !== tagToRemove));
  };

  const commitCurrentOrHighlighted = () => {
    if (open && totalOptions > 0) {
      if (activeIndex < suggestions.length) {
        addTags([suggestions[activeIndex].name]);
        return;
      }
      if (canCreateNew && activeIndex === suggestions.length) {
        addTags([normalizedQuery]);
        return;
      }
    }
    if (normalizedQuery) {
      addTags([normalizedQuery]);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.nativeEvent.isComposing) return;

    if (event.key === ',') {
      event.preventDefault();
      if (normalizedQuery) {
        addTags([normalizedQuery]);
      }
      return;
    }

    if (event.key === 'Enter') {
      if (query.trim() || (open && totalOptions > 0)) {
        event.preventDefault();
        commitCurrentOrHighlighted();
      }
      return;
    }

    if (event.key === 'Backspace' && !query && value.length > 0) {
      event.preventDefault();
      removeTag(value[value.length - 1]);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else if (totalOptions > 0) {
        setActiveIndex((prev) => (prev + 1) % totalOptions);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open && totalOptions > 0) {
        setActiveIndex((prev) => (prev - 1 + totalOptions) % totalOptions);
      }
      return;
    }

    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (pasted.includes(',') || pasted.includes('\n')) {
      event.preventDefault();
      const parts = pasted.split(/[,\n]+/);
      addTags(parts);
    }
  };

  const showDropdown = open && !disabled && totalOptions > 0;

  return (
    <div ref={containerRef} className={cn('space-y-1.5 relative', className)}>
      {label && (
        <label htmlFor={fieldId} className="block text-xs font-medium text-slate-300">
          {label}
        </label>
      )}

      <div
        onClick={() => {
          if (!disabled) {
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-0/90 border px-2.5 py-2 min-h-[42px] transition-colors',
          error
            ? 'border-rose-500/80 focus-within:border-rose-500 focus-within:ring-2 focus-within:ring-rose-500/25'
            : 'border-slate-700/80 hover:border-slate-600/90 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/25',
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-text'
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 border border-indigo-500/35 px-2.5 py-0.5 text-xs font-medium text-indigo-200"
          >
            <Tag className="h-3 w-3 text-indigo-400" aria-hidden="true" />
            <span>{tag}</span>
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(tag);
                }}
                aria-label={`Remove tag ${tag}`}
                className="ml-0.5 rounded-full p-0.5 text-indigo-300 hover:bg-indigo-500/30 hover:text-white transition-colors focus-ring"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}

        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={showDropdown ? listboxId : undefined}
          aria-autocomplete="list"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={descId}
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            const val = e.target.value;
            if (val.includes(',')) {
              const parts = val.split(',');
              const trailing = parts.pop() ?? '';
              addTags(parts);
              setQuery(trailing);
            } else {
              setQuery(val);
            }
            if (!open) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={value.length === 0 ? placeholder : 'Add another tag…'}
          className="flex-1 min-w-[140px] bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:cursor-not-allowed"
        />
      </div>

      {/* Autocomplete Suggestions Dropdown */}
      {showDropdown && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Tag suggestions"
          className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-700/90 bg-surface-1/95 p-1.5 shadow-xl shadow-black/60 backdrop-blur-md custom-scrollbar"
        >
          {suggestions.map((suggestion, idx) => {
            const isHighlighted = idx === activeIndex;
            return (
              <li
                key={suggestion.name}
                role="option"
                aria-selected={isHighlighted}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addTags([suggestion.name]);
                }}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs cursor-pointer transition-colors',
                  isHighlighted
                    ? 'bg-indigo-500/20 text-indigo-200'
                    : 'text-slate-300 hover:bg-slate-800/80'
                )}
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <Tag className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                  {suggestion.name}
                </span>
                {suggestion.count !== undefined && (
                  <span className="font-mono text-[11px] text-slate-400">
                    {suggestion.count} {suggestion.count === 1 ? 'q' : 'qs'}
                  </span>
                )}
              </li>
            );
          })}

          {canCreateNew && (
            <li
              role="option"
              aria-selected={activeIndex === suggestions.length}
              onMouseEnter={() => setActiveIndex(suggestions.length)}
              onMouseDown={(e) => {
                e.preventDefault();
                addTags([normalizedQuery]);
              }}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs cursor-pointer transition-colors',
                suggestions.length > 0 && 'mt-1 border-t border-slate-800/90 pt-2',
                activeIndex === suggestions.length
                  ? 'bg-cyan-500/20 text-cyan-200'
                  : 'text-cyan-300 hover:bg-slate-800/80'
              )}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Create new tag <strong className="font-mono">"{normalizedQuery}"</strong>
              </span>
            </li>
          )}
        </ul>
      )}

      {error ? (
        <p id={descId} className="text-xs text-rose-400">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="text-xs text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
