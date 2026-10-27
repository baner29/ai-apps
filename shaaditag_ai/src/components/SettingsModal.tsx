import React from 'react';
import { X, Cpu, Cloud, CheckCircle2 } from 'lucide-react';
import { LLMSettings } from '../types/hashtag';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LLMSettings;
  onUpdateSettings: (updated: LLMSettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl rounded-3xl bg-[#FFFEFA] border border-[#E8DEC8] shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="bg-[#7A1C24] text-[#FDFBF7] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-[#F4DCA9]" />
            <div>
              <h3 className="font-serif text-xl font-bold">
                Vertex AI Engine Configuration
              </h3>
              <p className="text-xs text-[#FDFBF7]/80">
                100% Live Vertex AI + Google Search Grounding (No Hardcoded Backup)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 text-sm">
          <div className="p-4 rounded-2xl bg-[#F9ECEE] border border-[#7A1C24] flex items-start gap-3">
            <Cloud className="w-5 h-5 text-[#7A1C24] shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-[#1F1A1C] flex items-center gap-1.5">
                <span>Live Vertex AI Only Mode Active</span>
                <CheckCircle2 className="w-4 h-4 text-[#7A1C24]" />
              </div>
              <p className="text-xs text-[#5A4E52] mt-1 leading-relaxed">
                All hashtag generation and Google Search name-meaning lookups run strictly on{' '}
                <strong>Google Cloud Vertex AI</strong> (<code className="font-mono">GOOGLE_GENAI_USE_VERTEXAI=True</code>).
                The local pattern backup has been removed so every couple receives 100% bespoke LLM-crafted hashtags.
              </p>
            </div>
          </div>

          {/* Vertex AI Configuration */}
          <div className="rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold uppercase tracking-wider text-[#7A1C24]">
                Vertex AI Environment
              </div>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold">
                GOOGLE_GENAI_USE_VERTEXAI=True
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                  Model Name
                </label>
                <input
                  type="text"
                  value={settings.model}
                  onChange={(e) => onUpdateSettings({ ...settings, model: e.target.value })}
                  placeholder="gemini-3.8-flash"
                  className="w-full px-3 py-2 rounded-xl bg-white border border-[#E8DEC8] font-mono text-xs text-[#1F1A1C]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                  GCP Project ID
                </label>
                <input
                  type="text"
                  value={settings.vertexProject}
                  onChange={(e) => onUpdateSettings({ ...settings, vertexProject: e.target.value })}
                  placeholder="gemini-enterprise-app-508802"
                  className="w-full px-3 py-2 rounded-xl bg-white border border-[#E8DEC8] font-mono text-xs text-[#1F1A1C]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                  Vertex Location
                </label>
                <input
                  type="text"
                  value={settings.vertexLocation}
                  onChange={(e) =>
                    onUpdateSettings({ ...settings, vertexLocation: e.target.value })
                  }
                  placeholder="global"
                  className="w-full px-3 py-2 rounded-xl bg-white border border-[#E8DEC8] font-mono text-xs text-[#1F1A1C]"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-[#F7F2E7] border-t border-[#E8DEC8] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-[#7A1C24] text-white hover:bg-[#581218] transition-colors"
          >
            Save &amp; Close
          </button>
        </div>
      </div>
    </div>
  );
};
