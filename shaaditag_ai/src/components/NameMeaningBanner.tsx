import React from 'react';
import { NameMeaningResult, SplitWordCombination } from '../types/hashtag';

interface HoverableNameProps {
  name: string;
  meaning?: NameMeaningResult | null;
  splitWordCombinations?: SplitWordCombination[];
  variant?: 'bride' | 'groom';
  className?: string;
}

export const HoverableName: React.FC<HoverableNameProps> = ({
  name,
  meaning,
  splitWordCombinations,
  variant = 'bride',
  className = '',
}) => {
  const displayName = (name || '').trim() || (variant === 'bride' ? 'Bride' : 'Groom');
  const hasMeaning =
    meaning &&
    meaning.name.trim().toLowerCase() === displayName.toLowerCase();

  return (
    <span className={`relative inline-block group ${className}`} tabIndex={0}>
      <span
        className={`cursor-help border-b-2 border-dotted transition-colors ${
          variant === 'bride'
            ? 'text-[#7A1C24] border-[#7A1C24]/50 hover:border-[#7A1C24]'
            : 'text-[#8A5D0B] border-[#D99B26] hover:border-[#8A5D0B]'
        }`}
      >
        {displayName}
      </span>

      {/* Hover Tooltip: Name Meaning, Sub-Words & Split-Word Blends */}
      <div
        role="tooltip"
        className="pointer-events-none invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-all duration-200 absolute left-0 top-full mt-2 z-50 w-72 sm:w-80 rounded-2xl bg-[#FFFEFA] border border-[#D99B26]/60 p-4 shadow-xl text-left font-sans font-normal normal-case tracking-normal"
      >
        <div className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-[#E8DEC8]">
          <span className="font-serif text-lg font-bold text-[#7A1C24]">
            {displayName}
          </span>
          {hasMeaning && meaning?.language && (
            <span className="px-2 py-0.5 rounded-md bg-[#FCF5E5] text-[#8A5D0B] text-[11px] font-semibold border border-[#D99B26]/30">
              {meaning.language}
            </span>
          )}
        </div>

        {hasMeaning && meaning ? (
          <div className="space-y-3 text-xs">
            {/* Name Meanings */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#85767B] mb-1">
                Meaning
              </div>
              <ul className="space-y-1 text-[#1F1A1C]">
                {meaning.top_3_meanings.filter(Boolean).map((m, idx) => (
                  <li key={idx} className="flex items-start gap-1.5 leading-snug">
                    <span className="text-[#D99B26] font-bold">•</span>
                    <span className="font-medium">{m}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Sub-Words */}
            {meaning.subword_parts && meaning.subword_parts.length > 0 && (
              <div className="pt-2 border-t border-[#E8DEC8]/80">
                <div className="text-[10px] font-bold uppercase tracking-wider text-[#85767B] mb-1.5">
                  Sub-Words
                </div>
                <div className="space-y-1.5">
                  {meaning.subword_parts.map((sub, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-1.5 bg-[#FDFBF7] px-2.5 py-1.5 rounded-lg border border-[#E8DEC8]"
                    >
                      <span className="px-1.5 py-0.5 rounded bg-[#7A1C24] text-white font-mono font-bold text-[11px]">
                        {sub.part}
                      </span>
                      {sub.devanagari && (
                        <span className="text-[#8A5D0B] font-semibold text-[11px]">
                          ({sub.devanagari})
                        </span>
                      )}
                      <span className="text-[#5A4E52] text-[11px] leading-snug">
                        — {sub.hindi_meaning}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Split-Word Combinations */}
            {splitWordCombinations && splitWordCombinations.length > 0 && (
              <div className="pt-2 border-t border-[#E8DEC8]/80">
                <div className="text-[10px] font-bold uppercase tracking-wider text-[#85767B] mb-1.5">
                  Split-Word Blends (Bride × Groom)
                </div>
                <div className="space-y-1.5">
                  {splitWordCombinations.map((combo, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${
                        combo.is_meaningful_hinglish_word
                          ? 'bg-[#FCF5E5]/80 border-[#D99B26]/60'
                          : 'bg-[#FDFBF7] border-[#E8DEC8]'
                      }`}
                    >
                      <span className="px-1.5 py-0.5 rounded bg-[#8A5D0B] text-white font-mono font-bold text-[11px]">
                        {combo.combined_word}
                      </span>
                      {combo.hindi_devanagari && (
                        <span className="text-[#7A1C24] font-semibold text-[11px]">
                          ({combo.hindi_devanagari})
                        </span>
                      )}
                      <span className="text-[#5A4E52] text-[11px] leading-snug">
                        — {combo.hinglish_meaning}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-[#5A4E52]">
            Generate hashtags to view the meaning and sub-words for {displayName}.
          </p>
        )}
      </div>
    </span>
  );
};
