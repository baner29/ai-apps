import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { fetchJob, sendFeedback, startGenerateJob } from './services/api';
import type { GenerateResponse, HashtagPackage, SplitWordHighlight } from './types/hashtag';

const LOADING_LINES = [
  'Finding the meanings in your names…',
  'Listening for words hidden between them…',
  'Composing phrases in Hindi first…',
  'Checking every tag carries your names…',
];

type Rating = 'like' | 'dislike';

function TagCard({
  pkg,
  rating,
  onRate,
}: {
  pkg: HashtagPackage;
  rating?: Rating;
  onRate: (pkg: HashtagPackage, rating: Rating) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pkg.primary_hashtag);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = pkg.primary_hashtag;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="animate-fadeIn rounded-2xl border border-[#7A1C24]/15 bg-white/70 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="break-all text-[17px] font-semibold leading-snug text-[#7A1C24]">
          {pkg.primary_hashtag}
        </p>
        <button
          onClick={copy}
          aria-label={`Copy ${pkg.primary_hashtag}`}
          className="mt-0.5 shrink-0 rounded-full border border-[#7A1C24]/20 p-1.5 text-[#7A1C24] transition hover:bg-[#7A1C24] hover:text-white"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {pkg.hinglish_translation && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-[#1F1A1C]/70">
          {pkg.hinglish_translation}
        </p>
      )}
      {pkg.companion_variations?.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {pkg.companion_variations.map((v) => (
            <span
              key={v}
              className="rounded-full bg-[#7A1C24]/5 px-2 py-0.5 text-[12px] text-[#7A1C24]/80"
            >
              {v}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 border-t border-[#7A1C24]/10 pt-2.5">
        <span className="text-[11.5px] text-[#1F1A1C]/45">Rate this tag</span>
        <button
          onClick={() => onRate(pkg, 'like')}
          aria-label={`Like ${pkg.primary_hashtag}`}
          className={`rounded-full border p-1.5 transition ${
            rating === 'like'
              ? 'border-emerald-700 bg-emerald-700 text-white'
              : 'border-[#7A1C24]/20 text-[#7A1C24]/70 hover:bg-emerald-700 hover:text-white'
          }`}
        >
          <ThumbsUp size={13} />
        </button>
        <button
          onClick={() => onRate(pkg, 'dislike')}
          aria-label={`Dislike ${pkg.primary_hashtag}`}
          className={`rounded-full border p-1.5 transition ${
            rating === 'dislike'
              ? 'border-[#7A1C24] bg-[#7A1C24] text-white'
              : 'border-[#7A1C24]/20 text-[#7A1C24]/70 hover:bg-[#7A1C24] hover:text-white'
          }`}
        >
          <ThumbsDown size={13} />
        </button>
        {rating && (
          <span className="text-[11.5px] text-[#1F1A1C]/45">Saved — tap again to undo</span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [brideName, setBrideName] = useState('');
  const [groomName, setGroomName] = useState('');
  const [brideNick, setBrideNick] = useState('');
  const [groomNick, setGroomNick] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingLine, setLoadingLine] = useState(0);
  const [error, setError] = useState('');
  const [packages, setPackages] = useState<HashtagPackage[]>([]);
  const [highlight, setHighlight] = useState<SplitWordHighlight | null>(null);
  const [hasResults, setHasResults] = useState(false);
  const [ratings, setRatings] = useState<Record<string, Rating>>(() => {
    try {
      return JSON.parse(localStorage.getItem('shaaditag:ratings') || '{}');
    } catch {
      return {};
    }
  });
  const timer = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const sessionIdRef = useRef('');
  if (!sessionIdRef.current) {
    let sid = '';
    try {
      sid = localStorage.getItem('shaaditag:session') || '';
      if (!sid) {
        sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('shaaditag:session', sid);
      }
    } catch {
      sid = 'anonymous';
    }
    sessionIdRef.current = sid;
  }

  useEffect(() => {
    if (loading) {
      setLoadingLine(0);
      timer.current = window.setInterval(
        () => setLoadingLine((n) => (n + 1) % LOADING_LINES.length),
        3200
      );
    }
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [loading]);

  const canGenerate =
    brideName.trim().length > 0 && groomName.trim().length > 0 && !loading;

  const ACTIVE_JOB_KEY = 'shaaditag:activeJob';

  const applyResult = (data: GenerateResponse, mode: 'fresh' | 'more') => {
    if (data.packages.length === 0) {
      throw new Error('No hashtags came back. Please try again.');
    }
    setPackages((prev) => (mode === 'more' ? [...prev, ...data.packages] : data.packages));
    if (mode === 'fresh') setHighlight(data.highlight);
    setHasResults(true);
  };

  const pollJob = async (jobId: string, mode: 'fresh' | 'more') => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setLoading(true);
    setError('');
    try {
      for (let i = 0; i < 160; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        let st;
        try {
          st = await fetchJob(jobId);
        } catch {
          continue; // a dropped poll is fine — the job lives on the server
        }
        if (st.status === 'running') continue;
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        if (st.status === 'error') throw new Error(st.error);
        applyResult(st, mode);
        return;
      }
      sessionStorage.removeItem(ACTIVE_JOB_KEY);
      throw new Error('Generation is taking unusually long. Please try again.');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      );
    } finally {
      pollingRef.current = false;
      setLoading(false);
    }
  };

  const run = async (exclude: string[]) => {
    setError('');
    try {
      const jobId = await startGenerateJob({
        brideName: brideName.trim(),
        groomName: groomName.trim(),
        brideNickname: brideNick.trim(),
        groomNickname: groomNick.trim(),
        exclude,
      });
      const mode: 'fresh' | 'more' = exclude.length ? 'more' : 'fresh';
      try {
        sessionStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ jobId, mode }));
      } catch {
        /* storage unavailable — polling still works for this visit */
      }
      void pollJob(jobId, mode);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      );
    }
  };

  // Reattach to an in-flight generation after navigation or a page reload.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const { jobId, mode } = JSON.parse(raw);
        if (jobId) void pollJob(jobId, mode === 'more' ? 'more' : 'fresh');
      }
    } catch {
      /* nothing to resume */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRate = (pkg: HashtagPackage, rating: Rating) => {
    const tag = pkg.primary_hashtag;
    const next: Rating | 'none' = ratings[tag] === rating ? 'none' : rating;
    setRatings((prev) => {
      const copy = { ...prev };
      if (next === 'none') delete copy[tag];
      else copy[tag] = next;
      try {
        localStorage.setItem('shaaditag:ratings', JSON.stringify(copy));
      } catch {
        /* ignore */
      }
      return copy;
    });
    void sendFeedback({
      sessionId: sessionIdRef.current,
      brideName: brideName.trim(),
      groomName: groomName.trim(),
      brideNickname: brideNick.trim(),
      groomNickname: groomNick.trim(),
      hashtag: tag,
      rating: next,
      category: pkg.category || '',
      hinglishTranslation: pkg.hinglish_translation || '',
      meaningHook: pkg.meaning_hook_used || '',
    });
  };

  const startOver = () => {
    try {
      sessionStorage.removeItem(ACTIVE_JOB_KEY);
    } catch {
      /* ignore */
    }
    setPackages([]);
    setHighlight(null);
    setHasResults(false);
    setError('');
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-5 pb-16 pt-14">
      <header className="text-center">
        <h1 className="font-serif text-[44px] font-semibold leading-none text-[#7A1C24]">
          ShaadiTag AI
        </h1>
        <p className="mt-3 text-[15px] text-[#1F1A1C]/70">
          Wedding hashtags that mean something — hidden inside your names.
        </p>
      </header>

      <form
        className="mt-10 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canGenerate) run([]);
        }}
      >
        <input
          value={brideName}
          onChange={(e) => setBrideName(e.target.value)}
          placeholder="Bride's name — e.g. Manisha Kapoor"
          autoComplete="off"
          className="w-full rounded-xl border border-[#7A1C24]/25 bg-white/80 px-4 py-3.5 text-[15px] outline-none transition placeholder:text-[#1F1A1C]/40 focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/20"
        />
        <input
          value={brideNick}
          onChange={(e) => setBrideNick(e.target.value)}
          placeholder="Bride's nickname (optional) — e.g. Shikhu"
          autoComplete="off"
          className="w-full rounded-xl border border-[#7A1C24]/15 bg-white/60 px-4 py-3 text-[14px] outline-none transition placeholder:text-[#1F1A1C]/40 focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/20"
        />
        <input
          value={groomName}
          onChange={(e) => setGroomName(e.target.value)}
          placeholder="Groom's name — e.g. Natesh Verma"
          autoComplete="off"
          className="w-full rounded-xl border border-[#7A1C24]/25 bg-white/80 px-4 py-3.5 text-[15px] outline-none transition placeholder:text-[#1F1A1C]/40 focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/20"
        />
        <input
          value={groomNick}
          onChange={(e) => setGroomNick(e.target.value)}
          placeholder="Groom's nickname (optional) — e.g. Lucky"
          autoComplete="off"
          className="w-full rounded-xl border border-[#7A1C24]/15 bg-white/60 px-4 py-3 text-[14px] outline-none transition placeholder:text-[#1F1A1C]/40 focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/20"
        />
        <button
          type="submit"
          disabled={!canGenerate}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#7A1C24] px-4 py-3.5 text-[15px] font-semibold text-[#FDFBF7] transition hover:bg-[#641720] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Sparkles size={17} />
          {hasResults ? 'Generate again' : 'Generate hashtags'}
        </button>
      </form>

      {loading && (
        <div className="mt-10 text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-[#7A1C24]/25 border-t-[#7A1C24]" />
          <p className="mt-4 text-[14px] text-[#1F1A1C]/60">
            {LOADING_LINES[loadingLine]}
          </p>
        </div>
      )}

      {error && !loading && (
        <div className="mt-8 rounded-xl border border-red-900/20 bg-red-50 px-4 py-3 text-center text-[14px] text-red-900">
          {error}
        </div>
      )}

      {highlight && hasResults && !loading && (
        <div className="animate-fadeIn mt-10 rounded-2xl bg-[#7A1C24] px-5 py-4 text-center text-[#FDFBF7]">
          <p className="text-[12px] uppercase tracking-[0.18em] text-[#FDFBF7]/70">
            A word hidden in your names
          </p>
          <p className="mt-1.5 font-serif text-[26px] font-semibold leading-tight">
            {highlight.word}
            {highlight.devanagari ? ` · ${highlight.devanagari}` : ''}
          </p>
          {highlight.meaning && (
            <p className="mt-1 text-[13.5px] text-[#FDFBF7]/85">
              {highlight.meaning}
            </p>
          )}
        </div>
      )}

      {hasResults && packages.length > 0 && (
        <>
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {packages.map((pkg) => (
              <TagCard key={pkg.primary_hashtag} pkg={pkg} rating={ratings[pkg.primary_hashtag]} onRate={onRate} />
            ))}
          </div>
          <div className="mt-8 flex items-center justify-center gap-3">
            <button
              onClick={() => run(packages.map((p) => p.primary_hashtag))}
              disabled={loading}
              className="flex items-center gap-2 rounded-full border border-[#7A1C24]/30 px-4 py-2 text-[13.5px] font-medium text-[#7A1C24] transition hover:bg-[#7A1C24] hover:text-white disabled:opacity-40"
            >
              <RefreshCw size={14} /> Generate more
            </button>
            <button
              onClick={startOver}
              disabled={loading}
              className="rounded-full px-4 py-2 text-[13.5px] text-[#1F1A1C]/55 transition hover:text-[#1F1A1C] disabled:opacity-40"
            >
              Start over
            </button>
          </div>
        </>
      )}

      <footer className="mt-auto pt-14 text-center text-[12px] text-[#1F1A1C]/40">
        Crafted with Vertex AI · Every tag is checked to carry your names
      </footer>
    </div>
  );
}
