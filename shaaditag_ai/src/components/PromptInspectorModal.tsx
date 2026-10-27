import React from 'react';
import { X, Sparkles, Database, FileCode } from 'lucide-react';
import { RetrievedExampleMatch } from '../types/hashtag';

interface PromptInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemPrompt: string;
  retrievedExamples: RetrievedExampleMatch[];
}

export const PromptInspectorModal: React.FC<PromptInspectorModalProps> = ({
  isOpen,
  onClose,
  systemPrompt,
  retrievedExamples,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-3xl bg-[#FFFEFA] border border-[#E8DEC8] shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="bg-[#7A1C24] text-[#FDFBF7] px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Database className="w-5 h-5 text-[#F4DCA9]" />
            <div>
              <h3 className="font-serif text-xl font-bold">
                System Prompt &amp; Dynamic Few-Shot CoT Context Inspector
              </h3>
              <p className="text-xs text-[#FDFBF7]/80">
                Grounded in <code className="font-mono">indian_wedding_hashtags_template.json</code>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-xs">
          {/* Dynamically Retrieved Examples */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-[#D99B26]" />
              <h4 className="font-serif text-lg font-bold text-[#7A1C24]">
                Dynamically Retrieved Few-Shot Examples ({retrievedExamples.length} Selected)
              </h4>
            </div>
            <p className="text-[#5A4E52] mb-3">
              Before calling the LLM, ShaadiTag AI scores all 50 training examples against your couple’s names, surnames, suffixes, cultural roots, and vibe—selecting the top 8–10 most relevant examples plus 2 top examples from each of the 5 creative categories.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {retrievedExamples.map((item) => (
                <div
                  key={item.example.id}
                  className="p-3.5 rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-serif font-bold text-base text-[#7A1C24]">
                      {item.example.target_output.primary_hashtag}
                    </span>
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-[#F9ECEE] text-[#7A1C24] font-semibold">
                      Ex #{item.example.id} · Score {item.score}
                    </span>
                  </div>
                  <div className="text-[11px] font-semibold text-[#1F1A1C]">
                    {item.example.input_context.bride.first_name}{' '}
                    {item.example.input_context.bride.last_name} &amp;{' '}
                    {item.example.input_context.groom.first_name}{' '}
                    {item.example.input_context.groom.last_name}
                  </div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {item.match_reasons.map((r) => (
                      <span
                        key={r}
                        className="px-2 py-0.5 rounded-md bg-[#FCF5E5] text-[#8A5D0B] border border-[#D99B26]/30 text-[10px] font-medium"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* System Prompt Injection */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <FileCode className="w-4 h-4 text-[#7A1C24]" />
              <h4 className="font-serif text-lg font-bold text-[#7A1C24]">
                Injected System Prompt (`llm_system_prompt_template` + `creative_reasoning_taxonomy`)
              </h4>
            </div>
            <pre className="p-4 rounded-2xl bg-[#1F1A1C] text-[#FDFBF7] font-mono text-[11px] whitespace-pre-wrap leading-relaxed overflow-x-auto">
              {systemPrompt}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-[#F7F2E7] border-t border-[#E8DEC8] flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-[#7A1C24] text-white"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
};
