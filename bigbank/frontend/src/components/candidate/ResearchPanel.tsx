import { useMemo, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ExternalLink,
  Globe,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { SearchResultItem } from '../../types/api';
import { Alert, Badge, Button, Spinner } from '../ui';

export interface ResearchPanelProps {
  tags: string[];
  sessionToken?: string;
  previewMode?: boolean;
  onClose?: () => void;
}

function buildQuickChips(tags: string[]): Array<{ label: string; query: string }> {
  const cleaned = Array.from(
    new Set(
      tags
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    )
  ).slice(0, 5);

  const chips = cleaned.map((tag) => ({
    label: tag,
    query: `${tag.replace(/[-_]+/g, ' ')} documentation`,
  }));

  if (cleaned.length >= 2) {
    chips.push({
      label: `${cleaned[0]} + ${cleaned[1]}`,
      query: `${cleaned[0].replace(/[-_]+/g, ' ')} ${cleaned[1].replace(/[-_]+/g, ' ')} reference`,
    });
  }

  return chips.slice(0, 6);
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function ResearchPanel({
  tags,
  sessionToken,
  previewMode = false,
  onClose,
}: ResearchPanelProps) {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [fallbackSearchUrl, setFallbackSearchUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<SearchResultItem | null>(null);

  const quickChips = useMemo(() => buildQuickChips(tags), [tags]);

  const executeSearch = async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;

    setQuery(trimmed);
    setActiveQuery(trimmed);
    setPreviewItem(null);
    setLoading(true);
    setError(null);

    try {
      const res = await api.public.search(trimmed, sessionToken);
      setResults(res.results ?? []);
      setFallbackSearchUrl(res.search_url || null);
      if (res.error) {
        setError(res.error);
      }
    } catch (err: unknown) {
      setResults([]);
      setError(
        err instanceof ApiError
          ? err.detail
          : 'Unable to reach search service right now. Try opening in a new tab.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeSearch(query);
  };

  return (
    <aside
      aria-label="Open-Book Research Panel"
      className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-800/90 bg-surface-1/95 shadow-glass"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/90 bg-surface-0/70 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-semibold tracking-tight text-slate-100 truncate">
              Open-Book Reference
            </h2>
            <p className="text-[11px] text-slate-400 truncate">
              {previewMode ? 'Live documentation search (Preview)' : 'Built-in documentation search'}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close research panel"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Inline Proxied Page Preview */}
      {previewItem ? (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 bg-surface-0/50 px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}
              onClick={() => setPreviewItem(null)}
              className="h-7 px-2 text-xs"
            >
              Results
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">
              {extractDomain(previewItem.url)}
            </span>
            <a
              href={previewItem.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700/80 bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:bg-slate-700 hover:text-cyan-200 focus-ring"
            >
              Open tab
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>

          <div className="relative flex-1 min-h-[420px] bg-white">
            {/* Opaque sandbox (no allow-same-origin, no allow-scripts) prevents XSS against SPA */}
            <iframe
              title={previewItem.title}
              src={api.public.getProxyUrl(previewItem.url, sessionToken)}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0"
            />
          </div>

          <div className="border-t border-slate-800/80 bg-surface-0/80 px-3 py-2 text-[11px] text-slate-400 flex items-center justify-between gap-2">
            <span className="truncate">Static preview via SSRF-hardened proxy.</span>
            <a
              href={previewItem.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
            >
              Not loading? Open in new tab
            </a>
          </div>
        </div>
      ) : (
        /* Search & Results View */
        <div className="flex flex-1 flex-col min-h-0">
          {/* Search Input & Tag Quick-Chips */}
          <div className="space-y-3 border-b border-slate-800/80 p-3.5">
            <form onSubmit={handleSubmit} className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search docs, syntax, or concepts…"
                  aria-label="Search open-book documentation"
                  className="h-9 w-full rounded-lg border border-slate-700/80 bg-surface-0/90 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25"
                />
              </div>
              <Button type="submit" variant="primary" size="sm" loading={loading} className="h-9">
                Search
              </Button>
            </form>

            {quickChips.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <Sparkles className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                  Quick Topic Searches
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {quickChips.map((chip) => (
                    <button
                      key={chip.label}
                      type="button"
                      onClick={() => void executeSearch(chip.query)}
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-800/70 px-2.5 py-1 text-[11px] font-medium text-slate-200 transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/15 hover:text-cyan-200 focus-ring"
                    >
                      <Search className="h-2.5 w-2.5 text-slate-400" aria-hidden="true" />
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Results List */}
          <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5 custom-scrollbar min-h-[320px]">
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-xs text-slate-400">
                <Spinner size="md" label="Searching documentation" />
                <span>Searching for &ldquo;{activeQuery}&rdquo;…</span>
              </div>
            ) : error ? (
              <div className="space-y-3">
                <Alert variant="warning" title="Search Notice">
                  {error}
                </Alert>
                {fallbackSearchUrl && (
                  <a
                    href={fallbackSearchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-medium text-cyan-300 hover:bg-slate-700"
                  >
                    Search externally on DuckDuckGo
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            ) : results.length > 0 ? (
              <>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>
                    {results.length} results for{' '}
                    <strong className="text-slate-200">&ldquo;{activeQuery}&rdquo;</strong>
                  </span>
                  {fallbackSearchUrl && (
                    <a
                      href={fallbackSearchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                    >
                      More
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>

                {results.map((item, idx) => (
                  <article
                    key={`${item.url}-${idx}`}
                    className="rounded-xl border border-slate-800/90 bg-surface-0/75 p-3 space-y-2 transition-colors hover:border-slate-700"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewItem(item)}
                        className="text-left text-xs font-semibold leading-snug text-indigo-300 hover:text-indigo-200 hover:underline focus-ring rounded"
                      >
                        {item.title}
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Badge variant="slate" size="sm" className="max-w-full truncate font-mono">
                        <Globe className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{extractDomain(item.url)}</span>
                      </Badge>
                    </div>

                    {item.snippet && (
                      <p className="text-[11px] leading-relaxed text-slate-400 line-clamp-3">
                        {item.snippet}
                      </p>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPreviewItem(item)}
                        className="h-7 px-2.5 text-[11px]"
                      >
                        Inline Preview
                      </Button>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-slate-400 hover:bg-slate-800 hover:text-cyan-300 focus-ring"
                      >
                        Open in new tab
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    </div>
                  </article>
                ))}
              </>
            ) : activeQuery ? (
              <div className="py-12 text-center space-y-2">
                <p className="text-xs font-medium text-slate-300">
                  No results found for &ldquo;{activeQuery}&rdquo;
                </p>
                <p className="text-[11px] text-slate-500">
                  Try broader keywords or open search in a new tab.
                </p>
                {fallbackSearchUrl && (
                  <a
                    href={fallbackSearchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300"
                  >
                    Open DuckDuckGo
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800/80 border border-slate-700/70 text-cyan-400">
                  <Search className="h-4 w-4" aria-hidden="true" />
                </div>
                <p className="text-xs font-medium text-slate-200">
                  Reference documentation allowed
                </p>
                <p className="max-w-[240px] text-[11px] leading-relaxed text-slate-400">
                  Click a topic chip above or enter any query to browse documentation without leaving your workspace.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
