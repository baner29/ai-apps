import React, { useState } from 'react';
import { Check, Copy, Heart } from 'lucide-react';
import { GeneratedHashtagPackage } from '../types/hashtag';

interface HashtagResultCardProps {
  pkg: GeneratedHashtagPackage;
  isShortlisted: boolean;
  onToggleShortlist: (hashtag: string) => void;
}

export const HashtagResultCard: React.FC<HashtagResultCardProps> = ({
  pkg,
  isShortlisted,
  onToggleShortlist,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(pkg.primary_hashtag);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const hasHoverDetails = Boolean(
    pkg.hindi_devanagari_draft ||
      pkg.hinglish_translation ||
      pkg.meaning_hook_used ||
      pkg.quality_score
  );

  return (
    <div className="relative rounded-2xl bg-[#FFFEFA] border border-[#E8DEC8] p-5 shadow-editorial hover:border-[#D99B26] transition-all duration-200 flex items-center justify-between gap-4">
      {/* Hashtag with Hover Tooltip for Hinglish Meaning & Name/Sub-Word Formula */}
      <div className="min-w-0 flex-1">
        <div className="relative inline-block group max-w-full" tabIndex={0}>
          <h3
            onClick={handleCopy}
            className="font-serif text-2xl sm:text-3xl font-bold text-[#7A1C24] tracking-tight break-words leading-tight cursor-pointer border-b-2 border-dotted border-[#D99B26]/60 hover:text-[#581218] hover:border-[#7A1C24] transition-colors inline"
          >
            {pkg.primary_hashtag}
          </h3>

          {/* Hover Popover: Hindi / Hinglish Meaning, Name/Sub-Word Formula & Quality Score */}
          {hasHoverDetails && (
            <div
              role="tooltip"
              className="pointer-events-none invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-all duration-200 absolute left-0 bottom-full mb-2.5 z-50 w-72 sm:w-80 rounded-2xl bg-[#FFFEFA] border border-[#D99B26]/70 p-4 shadow-xl text-left space-y-2.5"
            >
              {(pkg.hindi_devanagari_draft || pkg.hinglish_translation) && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#7A1C24] mb-0.5">
                    Hindi &amp; Hinglish Meaning
                  </div>
                  {pkg.hindi_devanagari_draft && (
                    <p className="text-xs font-semibold text-[#7A1C24] leading-snug mb-1">
                      {pkg.hindi_devanagari_draft}
                    </p>
                  )}
                  {pkg.hinglish_translation && (
                    <p className="text-xs font-medium text-[#1F1A1C] leading-snug">
                      {pkg.hinglish_translation}
                    </p>
                  )}
                </div>
              )}

              {pkg.meaning_hook_used && (
                <div
                  className={
                    pkg.hindi_devanagari_draft || pkg.hinglish_translation
                      ? 'pt-2 border-t border-[#E8DEC8]'
                      : ''
                  }
                >
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#8A5D0B] mb-0.5">
                    Name / Sub-Word Formula
                  </div>
                  <p className="text-xs font-semibold text-[#5A4E52] leading-snug">
                    {pkg.meaning_hook_used}
                  </p>
                </div>
              )}

              {pkg.quality_score && (
                <div
                  className={
                    pkg.hindi_devanagari_draft ||
                    pkg.hinglish_translation ||
                    pkg.meaning_hook_used
                      ? 'pt-2 border-t border-[#E8DEC8]'
                      : ''
                  }
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#7A1C24]">
                      Quality Score
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-[#FCF5E5] text-[#8A5D0B] text-[10px] font-bold border border-[#D99B26]/40">
                      {pkg.quality_score.overall_score.toFixed(1)} / 10
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-[#5A4E52]">
                    <span>Virality: <strong>{pkg.quality_score.virality}/10</strong></span>
                    <span>Uniqueness: <strong>{pkg.quality_score.uniqueness}/10</strong></span>
                    <span>Grammar: <strong>{pkg.quality_score.grammar_correctness}/10</strong></span>
                    <span>Hinglish: <strong>{pkg.quality_score.hinglish_usage}/10</strong></span>
                    <span className="col-span-2">Name Presence: <strong>{pkg.quality_score.name_presence}/10</strong></span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Event Pills */}
        {pkg.recommended_events && pkg.recommended_events.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            {pkg.recommended_events.slice(0, 3).map((ev) => (
              <span
                key={ev}
                className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[#F7F2E7] text-[#5A4E52] border border-[#E8DEC8]"
              >
                {ev}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Copy & Shortlist Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleCopy}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all border ${
            copied
              ? 'bg-emerald-700 text-white border-emerald-700 shadow-sm'
              : 'bg-[#7A1C24] text-[#FDFBF7] border-[#7A1C24] hover:bg-[#581218]'
          }`}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              Copy
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => onToggleShortlist(pkg.primary_hashtag)}
          aria-label="Save to Shortlist"
          title={isShortlisted ? 'Remove from Shortlist' : 'Save to Shortlist'}
          className={`p-2 rounded-xl border transition-all ${
            isShortlisted
              ? 'bg-[#7A1C24]/10 border-[#7A1C24] text-[#7A1C24]'
              : 'bg-[#FDFBF7] border-[#E8DEC8] text-[#85767B] hover:text-[#7A1C24] hover:border-[#7A1C24]/40'
          }`}
        >
          <Heart className={`w-4 h-4 ${isShortlisted ? 'fill-[#7A1C24]' : ''}`} />
        </button>
      </div>
    </div>
  );
};
