import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { CoupleInputFormCard } from './components/CoupleInputFormCard';
import { HashtagResultCard } from './components/HashtagResultCard';
import { HoverableName } from './components/NameMeaningBanner';
import { generateWeddingHashtags } from './services/llmService';
import {
  CoupleInputForm,
  CoupleSemanticAnalysis,
  GeneratedHashtagPackage,
  LLMSettings,
} from './types/hashtag';

const INITIAL_FORM: CoupleInputForm = {
  bride: {
    first_name: '',
    last_name: '',
    nickname: '',
    cultural_roots: 'North Indian / Hindi-speaking',
    name_language: 'Hindi',
  },
  groom: {
    first_name: '',
    last_name: '',
    nickname: '',
    cultural_roots: 'North Indian / Hindi-speaking',
    name_language: 'Hindi',
  },
  surname_strategy: 'bride_takes_groom',
  how_they_met: [],
  shared_obsessions: [],
  personality_dynamic: [],
  couple_story_and_vibe: '',
  target_events: ['All Events'],
  vibe_slider: 0,
};

export function App() {
  const [form, setForm] = useState<CoupleInputForm>(INITIAL_FORM);

  const [settings, setSettings] = useState<LLMSettings>({
    mode: 'vertex_or_api',
    useVertexAI: true,
    vertexProject: 'gemini-enterprise-app-508802',
    vertexLocation: 'global',
    model: 'gemini-3.8-flash',
    apiKey: '',
  });

  const [semanticAnalysis, setSemanticAnalysis] = useState<CoupleSemanticAnalysis | null>(null);
  const [packages, setPackages] = useState<GeneratedHashtagPackage[]>([]);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const [shortlist, setShortlist] = useState<string[]>([]);
  const [copiedShortlist, setCopiedShortlist] = useState<boolean>(false);

  const runGeneration = async (
    targetForm: CoupleInputForm,
    customSemantics?: CoupleSemanticAnalysis
  ) => {
    setIsGenerating(true);
    setGenerationError(null);
    try {
      const response = await generateWeddingHashtags(targetForm, settings, customSemantics);
      setPackages(response.packages);
      setSemanticAnalysis(response.semanticAnalysis);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to generate hashtags. Please try again.';
      setGenerationError(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg) {
          setSettings((prev) => ({
            ...prev,
            useVertexAI: true,
            vertexProject: cfg.vertexProject || prev.vertexProject,
            vertexLocation: cfg.vertexLocation || prev.vertexLocation,
            model: cfg.model || prev.model,
          }));
        }
      })
      .catch(() => {
        // Ignore config fetch error
      });
  }, []);

  const toggleShortlist = (hashtag: string) => {
    setShortlist((prev) =>
      prev.includes(hashtag) ? prev.filter((h) => h !== hashtag) : [...prev, hashtag]
    );
  };

  const copyAllShortlisted = () => {
    if (shortlist.length === 0) return;
    navigator.clipboard.writeText(shortlist.join('  '));
    setCopiedShortlist(true);
    setTimeout(() => setCopiedShortlist(false), 1800);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#FDFBF7] text-[#1F1A1C]">
      {/* Decorative Festive Top Border */}
      <div className="h-1.5 w-full bg-gradient-to-r from-[#7A1C24] via-[#D99B26] to-[#7A1C24]" />

      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#FDFBF7]/95 backdrop-blur-md border-b border-[#E8DEC8]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#7A1C24] to-[#581218] text-[#F4DCA9] flex items-center justify-center shadow-md border border-[#D99B26]/40">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl font-bold text-[#7A1C24] tracking-tight leading-none">
                ShaadiTag AI
              </h1>
              <p className="text-xs text-[#5A4E52] mt-0.5">
                Personalized Indian Wedding Hashtags
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Couple Input Form */}
        <CoupleInputFormCard
          form={form}
          onChange={setForm}
          onSubmit={() => runGeneration(form)}
          isGenerating={isGenerating}
          semanticAnalysis={semanticAnalysis}
        />

        {/* Shortlist Bar */}
        {shortlist.length > 0 && (
          <div className="rounded-2xl bg-gradient-to-r from-[#F9ECEE] via-[#FFFEFA] to-[#FCF5E5] border border-[#D99B26]/40 p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#7A1C24] mr-1">
                <Heart className="w-4 h-4 fill-[#7A1C24] text-[#7A1C24]" />
                Shortlist ({shortlist.length}):
              </span>
              {shortlist.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white border border-[#E8DEC8] text-xs font-serif font-bold text-[#7A1C24]"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => toggleShortlist(tag)}
                    className="text-[#85767B] hover:text-red-600"
                    title="Remove from shortlist"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyAllShortlisted}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[#7A1C24] text-white hover:bg-[#581218]"
              >
                {copiedShortlist ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Copied All
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy Shortlist
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShortlist([])}
                className="p-1.5 rounded-xl text-[#85767B] hover:text-red-700 hover:bg-red-50 transition-colors"
                title="Clear shortlist"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {generationError && (
          <div className="rounded-2xl bg-red-50 border border-red-300 p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-serif text-base font-bold text-red-900">
                  Unable to Generate Hashtags
                </h4>
                <p className="text-xs text-red-800 mt-1">{generationError}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => runGeneration(form)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-[#7A1C24] text-white hover:bg-[#581218] shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Try Again</span>
            </button>
          </div>
        )}

        {/* Loading State */}
        {isGenerating && (
          <div className="rounded-3xl bg-[#FFFEFA] border border-[#D99B26]/50 p-10 text-center shadow-editorial space-y-2.5">
            <Loader2 className="w-7 h-7 text-[#7A1C24] animate-spin mx-auto" />
            <h3 className="font-serif text-2xl font-bold text-[#7A1C24]">
              Crafting Hashtags for {form.bride.first_name || 'Bride'} &amp;{' '}
              {form.groom.first_name || 'Groom'}...
            </h3>
            <p className="text-xs sm:text-sm text-[#5A4E52]">
              Creating personalized wedding hashtags for your celebration...
            </p>
          </div>
        )}

        {/* Generated Hashtags Section */}
        {packages.length > 0 && (
          <section className="space-y-6">
            <div className="border-b border-[#E8DEC8] pb-4 flex flex-col sm:flex-row sm:items-end justify-between gap-2">
              <div>
                <h2 className="font-serif text-3xl sm:text-4xl font-bold text-[#1F1A1C]">
                  Hashtags for{' '}
                  <HoverableName
                    name={form.bride.first_name || 'Bride'}
                    meaning={semanticAnalysis?.bride_meaning}
                    splitWordCombinations={semanticAnalysis?.split_word_combinations}
                    variant="bride"
                  />{' '}
                  &amp;{' '}
                  <HoverableName
                    name={form.groom.first_name || 'Groom'}
                    meaning={semanticAnalysis?.groom_meaning}
                    splitWordCombinations={semanticAnalysis?.split_word_combinations}
                    variant="groom"
                  />
                </h2>
                <p className="text-xs sm:text-sm text-[#5A4E52] mt-1">
                  Hover over a name for its meaning &amp; sub-words, or hover over any hashtag for its Hinglish meaning &amp; formula.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {packages.map((pkg) => (
                <HashtagResultCard
                  key={pkg.id}
                  pkg={pkg}
                  isShortlisted={shortlist.includes(pkg.primary_hashtag)}
                  onToggleShortlist={toggleShortlist}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-[#E8DEC8] bg-[#F7F2E7] py-5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-center gap-2 text-xs text-[#5A4E52]">
          <Sparkles className="w-3.5 h-3.5 text-[#7A1C24]" />
          <span className="font-serif font-bold text-sm text-[#7A1C24]">ShaadiTag AI</span>
          <span>— Personalized Indian Wedding Hashtags</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
