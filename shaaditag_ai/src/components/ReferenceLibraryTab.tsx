import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  Filter,
  Heart,
  Search,
  Sparkles,
  ArrowUpRight,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { dataset } from '../services/fewShotRetriever';
import {
  CREATIVE_ARCHETYPES,
  CreativeArchetypeCategory,
  TrainingExample,
} from '../types/hashtag';
import {
  auditHashtagLength,
  auditLowercaseTrap,
  getInstagramTagUrl,
} from '../utils/usabilityAuditor';

interface ReferenceLibraryTabProps {
  shortlist: string[];
  onToggleShortlist: (hashtag: string) => void;
  onLoadExampleIntoStudio: (example: TrainingExample) => void;
}

export const ReferenceLibraryTab: React.FC<ReferenceLibraryTabProps> = ({
  shortlist,
  onToggleShortlist,
  onLoadExampleIntoStudio,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [copiedTag, setCopiedTag] = useState<string | null>(null);

  const filteredExamples = useMemo(() => {
    return dataset.training_examples.filter((ex) => {
      if (selectedCategory !== 'ALL' && ex.category !== selectedCategory) {
        return false;
      }
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const hay = [
        ex.target_output.primary_hashtag,
        ...ex.target_output.companion_variations,
        ex.target_output.reusable_pattern_schema,
        ex.input_context.bride.first_name,
        ex.input_context.bride.last_name,
        ex.input_context.bride.nickname,
        ex.input_context.bride.cultural_roots,
        ex.input_context.groom.first_name,
        ex.input_context.groom.last_name,
        ex.input_context.groom.nickname,
        ex.input_context.groom.cultural_roots,
        ex.input_context.couple_story_and_vibe,
        ex.creative_chain_of_thought.phonetic_and_lexical_hooks,
        ex.creative_chain_of_thought.cultural_or_emotional_anchor,
        ex.creative_chain_of_thought.transformation_logic,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [searchQuery, selectedCategory]);

  const handleCopy = (tag: string) => {
    navigator.clipboard.writeText(tag);
    setCopiedTag(tag);
    setTimeout(() => setCopiedTag(null), 1600);
  };

  return (
    <div className="space-y-6">
      {/* Header & Philosophy Banner */}
      <div className="rounded-3xl bg-[#FFFEFA] border border-[#E8DEC8] p-6 sm:p-8 shadow-editorial">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-[#E8DEC8] pb-5">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-[#7A1C24] mb-1">
              <BookOpen className="w-4 h-4 text-[#D99B26]" />
              Golden Reference Library · 50 Curated Chain-of-Thought Examples
            </div>
            <h2 className="font-serif text-2xl sm:text-3xl font-bold text-[#1F1A1C]">
              {dataset.dataset_metadata.title}
            </h2>
            <p className="text-xs sm:text-sm text-[#5A4E52] mt-1 max-w-3xl">
              {dataset.dataset_metadata.core_design_philosophy}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="px-4 py-2.5 rounded-2xl bg-[#F9ECEE] border border-[#7A1C24]/20 text-center">
              <div className="font-serif text-2xl font-bold text-[#7A1C24]">
                {filteredExamples.length} / {dataset.training_examples.length}
              </div>
              <div className="text-[11px] font-semibold text-[#5A4E52]">Examples Shown</div>
            </div>
          </div>
        </div>

        {/* Search & Category Filter Controls */}
        <div className="mt-5 flex flex-col md:flex-row gap-4 items-stretch md:items-center justify-between">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[#85767B] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, surname (Patel, Gill, Singh, Sharma), hashtag (#Nibaha, #TuBeerMaiChakna), or cultural root..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#FDFBF7] border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
            <Filter className="w-4 h-4 text-[#7A1C24] shrink-0" />
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap border transition-all ${
                selectedCategory === 'ALL'
                  ? 'bg-[#7A1C24] text-white border-[#7A1C24]'
                  : 'bg-[#FDFBF7] text-[#5A4E52] border-[#E8DEC8] hover:border-[#D99B26]'
              }`}
            >
              All 5 Archetypes (50)
            </button>
            {CREATIVE_ARCHETYPES.map((arch) => (
              <button
                key={arch.id}
                type="button"
                onClick={() => setSelectedCategory(arch.id)}
                className={`px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap border transition-all ${
                  selectedCategory === arch.id
                    ? 'bg-[#7A1C24] text-white border-[#7A1C24]'
                    : 'bg-[#FDFBF7] text-[#5A4E52] border-[#E8DEC8] hover:border-[#D99B26]'
                }`}
              >
                {arch.shortTitle}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid of Curated Examples */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {filteredExamples.map((ex) => {
          const arch =
            CREATIVE_ARCHETYPES.find((a) => a.id === ex.category) || CREATIVE_ARCHETYPES[0];
          const isShortlisted = shortlist.includes(ex.target_output.primary_hashtag);
          const lowerAudit = auditLowercaseTrap(ex.target_output.primary_hashtag);
          const lenAudit = auditHashtagLength(ex.target_output.primary_hashtag);

          return (
            <div
              key={ex.id}
              className="rounded-2xl bg-[#FFFEFA] border border-[#E8DEC8] p-6 shadow-editorial flex flex-col justify-between space-y-4"
            >
              <div>
                {/* Top Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-[#7A1C24] text-[#FDFBF7]">
                      #{ex.id}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${arch.badgeColor}`}
                    >
                      <Sparkles className="w-3 h-3" />
                      {arch.shortTitle}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onLoadExampleIntoStudio(ex)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#FCF5E5] text-[#8A5D0B] border border-[#D99B26]/40 hover:bg-[#D99B26]/25 transition-colors"
                  >
                    <span>Load Couple in Studio</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Couple Names & Roots */}
                <div className="p-3 rounded-xl bg-[#FDFBF7] border border-[#E8DEC8] mb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-bold text-[#1F1A1C]">
                      {ex.input_context.bride.first_name} {ex.input_context.bride.last_name}{' '}
                      <span className="text-[#85767B] font-normal">
                        ({ex.input_context.bride.nickname})
                      </span>{' '}
                      <span className="text-[#7A1C24] mx-1">&amp;</span>{' '}
                      {ex.input_context.groom.first_name} {ex.input_context.groom.last_name}{' '}
                      <span className="text-[#85767B] font-normal">
                        ({ex.input_context.groom.nickname})
                      </span>
                    </div>
                    <div className="text-[11px] font-medium text-[#5A4E52]">
                      {ex.input_context.bride.cultural_roots} × {ex.input_context.groom.cultural_roots}
                    </div>
                  </div>
                  <p className="text-xs text-[#5A4E52] mt-1">
                    {ex.input_context.couple_story_and_vibe}
                  </p>
                </div>

                {/* Primary Hashtag + Actions */}
                <div className="flex items-center justify-between gap-3 my-3">
                  <h3 className="font-serif text-2xl sm:text-3xl font-bold text-[#7A1C24]">
                    {ex.target_output.primary_hashtag}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopy(ex.target_output.primary_hashtag)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[#7A1C24] text-white hover:bg-[#581218]"
                    >
                      {copiedTag === ex.target_output.primary_hashtag ? (
                        <>
                          <Check className="w-3.5 h-3.5" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" /> Copy
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleShortlist(ex.target_output.primary_hashtag)}
                      className={`p-1.5 rounded-xl border ${
                        isShortlisted
                          ? 'bg-[#7A1C24]/10 border-[#7A1C24] text-[#7A1C24]'
                          : 'bg-[#FDFBF7] border-[#E8DEC8] text-[#85767B]'
                      }`}
                    >
                      <Heart className={`w-4 h-4 ${isShortlisted ? 'fill-[#7A1C24]' : ''}`} />
                    </button>
                  </div>
                </div>

                {/* Companion Variations */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {ex.target_output.companion_variations.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => handleCopy(v)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#FDFBF7] border border-[#E8DEC8] text-[#1F1A1C] hover:border-[#D99B26]"
                    >
                      <span>{v}</span>
                      <Copy className="w-3 h-3 text-[#85767B]" />
                    </button>
                  ))}
                </div>

                {/* Reusable Pattern Schema */}
                <div className="p-2.5 rounded-xl bg-[#FCF5E5]/70 border border-[#D99B26]/30 text-xs mb-3">
                  <span className="font-bold text-[#8A5D0B]">Reusable Pattern Schema: </span>
                  <span className="font-mono text-[11px] text-[#1F1A1C]">
                    {ex.target_output.reusable_pattern_schema}
                  </span>
                </div>

                {/* Chain of Thought Breakdown */}
                <div className="space-y-1.5 text-xs bg-[#FDFBF7] p-3.5 rounded-xl border border-[#E8DEC8]">
                  <div>
                    <span className="font-semibold text-[#7A1C24]">Phonetic & Lexical Hooks: </span>
                    <span className="text-[#5A4E52]">
                      {ex.creative_chain_of_thought.phonetic_and_lexical_hooks}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#7A1C24]">Cultural Anchor: </span>
                    <span className="text-[#5A4E52]">
                      {ex.creative_chain_of_thought.cultural_or_emotional_anchor}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#7A1C24]">Transformation Logic: </span>
                    <span className="text-[#5A4E52]">
                      {ex.creative_chain_of_thought.transformation_logic}
                    </span>
                  </div>
                </div>
              </div>

              {/* Contrastive Quality Footer */}
              <div className="pt-3 border-t border-[#E8DEC8] space-y-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 text-red-800 border border-red-200 font-mono text-[11px] line-through">
                    <XCircle className="w-3 h-3 text-red-600" />
                    {ex.contrastive_evaluation.naive_concatenation_rejected}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-mono text-[11px] line-through">
                    <XCircle className="w-3 h-3 text-amber-600" />
                    {ex.contrastive_evaluation.shallow_wordplay_rejected}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono text-[11px] font-bold">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    {lowerAudit.lowercaseTag} ({lenAudit.charCount}c)
                  </span>
                  <a
                    href={getInstagramTagUrl(ex.target_output.primary_hashtag)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-[#7A1C24] hover:underline"
                  >
                    Instagram <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <p className="text-[#5A4E52] text-[11px]">
                  <strong className="text-[#7A1C24]">Why it wins:</strong>{' '}
                  {ex.contrastive_evaluation.why_creative_choice_wins}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
