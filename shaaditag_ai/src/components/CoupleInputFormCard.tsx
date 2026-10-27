import React, { useState } from 'react';
import {
  Users,
  HeartHandshake,
  Music,
  Sliders,
  Wand2,
  Flame,
  Plus,
} from 'lucide-react';
import {
  CULTURAL_ROOTS_OPTIONS,
  HOW_THEY_MET_CHIPS,
  PERSONALITY_DYNAMIC_CHIPS,
  SHARED_OBSESSIONS_CHIPS,
  TARGET_EVENT_OPTIONS,
  VIBE_SLIDER_LABELS,
} from '../data/presets';
import {
  CoupleInputForm,
  CoupleSemanticAnalysis,
  NAME_LANGUAGES,
  NameLanguage,
  SurnameStrategy,
  VibeToneLevel,
} from '../types/hashtag';
import { HoverableName } from './NameMeaningBanner';

interface CoupleInputFormCardProps {
  form: CoupleInputForm;
  onChange: (updated: CoupleInputForm) => void;
  onSubmit: () => void;
  isGenerating: boolean;
  semanticAnalysis?: CoupleSemanticAnalysis | null;
}

export const CoupleInputFormCard: React.FC<CoupleInputFormCardProps> = ({
  form,
  onChange,
  onSubmit,
  isGenerating,
  semanticAnalysis,
}) => {
  const [customHowMet, setCustomHowMet] = useState('');
  const [customInterest, setCustomInterest] = useState('');
  const [customPersonality, setCustomPersonality] = useState('');
  const [customEvent, setCustomEvent] = useState('');

  const updateBride = (field: keyof CoupleInputForm['bride'], value: string) => {
    onChange({
      ...form,
      bride: { ...form.bride, [field]: value },
    });
  };

  const updateGroom = (field: keyof CoupleInputForm['groom'], value: string) => {
    onChange({
      ...form,
      groom: { ...form.groom, [field]: value },
    });
  };

  const toggleChip = (
    listKey: 'how_they_met' | 'shared_obsessions' | 'personality_dynamic' | 'target_events',
    chip: string
  ) => {
    const current = form[listKey];
    const exists = current.includes(chip);
    const updated = exists ? current.filter((c) => c !== chip) : [...current, chip];
    onChange({
      ...form,
      [listKey]: updated,
    });
  };

  const addCustomChip = (
    listKey: 'how_they_met' | 'shared_obsessions' | 'personality_dynamic' | 'target_events',
    rawValue: string,
    clearFn: (val: string) => void
  ) => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    const current = form[listKey];
    if (!current.includes(trimmed)) {
      onChange({
        ...form,
        [listKey]: [...current, trimmed],
      });
    }
    clearFn('');
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  const surnameOptions: {
    id: SurnameStrategy;
    title: string;
  }[] = [
    {
      id: 'bride_takes_groom',
      title: "Bride takes Groom's surname",
    },
    {
      id: 'keep_own',
      title: 'Both keep own surnames',
    },
    {
      id: 'shared_surname',
      title: 'Shared surname already',
    },
    {
      id: 'first_names_only',
      title: 'First names & nicknames only',
    },
  ];

  const activeVibeMeta =
    VIBE_SLIDER_LABELS.find((v) => v.level === form.vibe_slider) || VIBE_SLIDER_LABELS[1];

  return (
    <form
      onSubmit={handleFormSubmit}
      className="rounded-3xl bg-[#FFFEFA] border border-[#E8DEC8] shadow-editorial p-6 sm:p-8 space-y-8"
    >
      {/* Bride & Groom Profiles */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bride Profile */}
        <div className="rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#E8DEC8] pb-3">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-[#7A1C24]/10 text-[#7A1C24] flex items-center justify-center font-serif font-bold text-lg">
                B
              </span>
              <h3 className="font-serif text-xl font-bold text-[#7A1C24]">
                Bride{' '}
                {form.bride.first_name.trim() && (
                  <>
                    ·{' '}
                    <HoverableName
                      name={form.bride.first_name}
                      meaning={semanticAnalysis?.bride_meaning}
                      splitWordCombinations={semanticAnalysis?.split_word_combinations}
                      variant="bride"
                    />
                  </>
                )}
              </h3>
            </div>
            {semanticAnalysis?.bride_meaning && (
              <span className="text-[11px] text-[#85767B]">
                Hover name for meaning
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                First Name <span className="text-[#7A1C24]">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Bride First Name"
                value={form.bride.first_name}
                onChange={(e) => updateBride('first_name', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Last Name <span className="text-[#7A1C24]">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Bride Last Name"
                value={form.bride.last_name}
                onChange={(e) => updateBride('last_name', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Nickname <span className="text-[#85767B] font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                placeholder="Nickname"
                value={form.bride.nickname}
                onChange={(e) => updateBride('nickname', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Name Language
              </label>
              <select
                value={form.bride.name_language || 'Hindi'}
                onChange={(e) =>
                  updateBride('name_language', e.target.value as NameLanguage)
                }
                className="w-full px-3 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              >
                {NAME_LANGUAGES.map((lang) => (
                  <option key={lang.id} value={lang.id}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Cultural Roots
              </label>
              <select
                value={form.bride.cultural_roots}
                onChange={(e) => updateBride('cultural_roots', e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              >
                {CULTURAL_ROOTS_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Groom Profile */}
        <div className="rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#E8DEC8] pb-3">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-[#D99B26]/20 text-[#8A5D0B] flex items-center justify-center font-serif font-bold text-lg">
                G
              </span>
              <h3 className="font-serif text-xl font-bold text-[#1F1A1C]">
                Groom{' '}
                {form.groom.first_name.trim() && (
                  <>
                    ·{' '}
                    <HoverableName
                      name={form.groom.first_name}
                      meaning={semanticAnalysis?.groom_meaning}
                      splitWordCombinations={semanticAnalysis?.split_word_combinations}
                      variant="groom"
                    />
                  </>
                )}
              </h3>
            </div>
            {semanticAnalysis?.groom_meaning && (
              <span className="text-[11px] text-[#85767B]">
                Hover name for meaning
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                First Name <span className="text-[#7A1C24]">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Groom First Name"
                value={form.groom.first_name}
                onChange={(e) => updateGroom('first_name', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Last Name <span className="text-[#7A1C24]">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Groom Last Name"
                value={form.groom.last_name}
                onChange={(e) => updateGroom('last_name', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Nickname <span className="text-[#85767B] font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                placeholder="Nickname"
                value={form.groom.nickname}
                onChange={(e) => updateGroom('nickname', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Name Language
              </label>
              <select
                value={form.groom.name_language || 'Hindi'}
                onChange={(e) =>
                  updateGroom('name_language', e.target.value as NameLanguage)
                }
                className="w-full px-3 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              >
                {NAME_LANGUAGES.map((lang) => (
                  <option key={lang.id} value={lang.id}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-[#1F1A1C] mb-1">
                Cultural Roots
              </label>
              <select
                value={form.groom.cultural_roots}
                onChange={(e) => updateGroom('cultural_roots', e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              >
                {CULTURAL_ROOTS_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Surname Preference */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[#7A1C24]" />
          <h4 className="font-serif text-lg font-bold text-[#1F1A1C]">Surname Preference</h4>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {surnameOptions.map((option) => {
            const active = form.surname_strategy === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onChange({ ...form, surname_strategy: option.id })}
                className={`text-left px-4 py-3 rounded-2xl border transition-all flex items-center justify-between gap-2 ${
                  active
                    ? 'bg-[#F9ECEE]/80 border-[#7A1C24] ring-2 ring-[#7A1C24]/15'
                    : 'bg-[#FDFBF7] border-[#E8DEC8] hover:border-[#D99B26]'
                }`}
              >
                <span className="text-xs font-semibold text-[#1F1A1C]">{option.title}</span>
                <span
                  className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                    active ? 'border-[#7A1C24] bg-[#7A1C24]' : 'border-[#85767B]'
                  }`}
                >
                  {active && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Couple Story & Vibe */}
      <div className="rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] p-5 space-y-5">
        <div className="flex items-center gap-2 border-b border-[#E8DEC8] pb-3">
          <HeartHandshake className="w-4 h-4 text-[#7A1C24]" />
          <h4 className="font-serif text-lg font-bold text-[#1F1A1C]">
            Couple Story &amp; Vibe
          </h4>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* How They Met */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-[#7A1C24]">
              How They Met
            </label>
            <div className="flex flex-wrap gap-1.5">
              {Array.from(new Set([...HOW_THEY_MET_CHIPS, ...form.how_they_met])).map((chip) => {
                const selected = form.how_they_met.includes(chip);
                return (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => toggleChip('how_they_met', chip)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                      selected
                        ? 'bg-[#7A1C24] text-[#FDFBF7] border-[#7A1C24]'
                        : 'bg-white text-[#1F1A1C] border-[#E8DEC8] hover:border-[#D99B26]'
                    }`}
                  >
                    {chip}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 pt-0.5">
              <input
                type="text"
                placeholder="Or type how you met..."
                value={customHowMet}
                onChange={(e) => setCustomHowMet(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomChip('how_they_met', customHowMet, setCustomHowMet);
                  }
                }}
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-white border border-[#E8DEC8] text-xs text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              />
              <button
                type="button"
                onClick={() => addCustomChip('how_they_met', customHowMet, setCustomHowMet)}
                className="px-2.5 py-1.5 rounded-xl bg-[#F7F2E7] hover:bg-[#E8DEC8] text-[#7A1C24] border border-[#E8DEC8] text-xs font-semibold inline-flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>

          {/* Shared Interests */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-[#7A1C24]">
              Shared Interests
            </label>
            <div className="flex flex-wrap gap-1.5">
              {Array.from(
                new Set([...SHARED_OBSESSIONS_CHIPS, ...form.shared_obsessions])
              ).map((chip) => {
                const selected = form.shared_obsessions.includes(chip);
                return (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => toggleChip('shared_obsessions', chip)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                      selected
                        ? 'bg-[#D99B26] text-[#1F1A1C] font-semibold border-[#B57D14]'
                        : 'bg-white text-[#1F1A1C] border-[#E8DEC8] hover:border-[#D99B26]'
                    }`}
                  >
                    {chip}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 pt-0.5">
              <input
                type="text"
                placeholder="Or type shared interest..."
                value={customInterest}
                onChange={(e) => setCustomInterest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomChip('shared_obsessions', customInterest, setCustomInterest);
                  }
                }}
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-white border border-[#E8DEC8] text-xs text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              />
              <button
                type="button"
                onClick={() => addCustomChip('shared_obsessions', customInterest, setCustomInterest)}
                className="px-2.5 py-1.5 rounded-xl bg-[#F7F2E7] hover:bg-[#E8DEC8] text-[#7A1C24] border border-[#E8DEC8] text-xs font-semibold inline-flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>

          {/* Personality Dynamic */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-[#7A1C24]">
              Personality
            </label>
            <div className="flex flex-wrap gap-1.5">
              {Array.from(
                new Set([...PERSONALITY_DYNAMIC_CHIPS, ...form.personality_dynamic])
              ).map((chip) => {
                const selected = form.personality_dynamic.includes(chip);
                return (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => toggleChip('personality_dynamic', chip)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                      selected
                        ? 'bg-[#7A1C24] text-[#FDFBF7] border-[#7A1C24]'
                        : 'bg-white text-[#1F1A1C] border-[#E8DEC8] hover:border-[#D99B26]'
                    }`}
                  >
                    {chip}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 pt-0.5">
              <input
                type="text"
                placeholder="Or type personality vibe..."
                value={customPersonality}
                onChange={(e) => setCustomPersonality(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomChip('personality_dynamic', customPersonality, setCustomPersonality);
                  }
                }}
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-white border border-[#E8DEC8] text-xs text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
              />
              <button
                type="button"
                onClick={() =>
                  addCustomChip('personality_dynamic', customPersonality, setCustomPersonality)
                }
                className="px-2.5 py-1.5 rounded-xl bg-[#F7F2E7] hover:bg-[#E8DEC8] text-[#7A1C24] border border-[#E8DEC8] text-xs font-semibold inline-flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Open Text Box for Custom Story */}
        <div>
          <label className="block text-xs font-semibold text-[#1F1A1C] mb-1.5">
            About the Couple / Custom Story{' '}
            <span className="text-[#85767B] font-normal">
              (Open text — type anything if the choices above don&apos;t match your story)
            </span>
          </label>
          <textarea
            rows={3}
            placeholder="Type your custom story, inside jokes, professions, cities, or how you met if the options above don't match..."
            value={form.couple_story_and_vibe}
            onChange={(e) => onChange({ ...form, couple_story_and_vibe: e.target.value })}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E8DEC8] text-sm text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24] focus:ring-2 focus:ring-[#7A1C24]/15"
          />
        </div>
      </div>

      {/* Wedding Events & Vibe Tone */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Wedding Functions */}
        <div className="rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Music className="w-4 h-4 text-[#7A1C24]" />
            <h4 className="font-serif text-lg font-bold text-[#1F1A1C]">
              Wedding Events
            </h4>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {Array.from(new Set([...TARGET_EVENT_OPTIONS, ...form.target_events])).map((ev) => {
              const selected = form.target_events.includes(ev);
              return (
                <button
                  key={ev}
                  type="button"
                  onClick={() => toggleChip('target_events', ev)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                    selected
                      ? 'bg-[#7A1C24] text-[#FDFBF7] border-[#7A1C24] shadow-sm'
                      : 'bg-white text-[#5A4E52] border-[#E8DEC8] hover:border-[#7A1C24]/50'
                  }`}
                >
                  {ev}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 pt-1">
            <input
              type="text"
              placeholder="Or add custom event..."
              value={customEvent}
              onChange={(e) => setCustomEvent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustomChip('target_events', customEvent, setCustomEvent);
                }
              }}
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-xl bg-white border border-[#E8DEC8] text-xs text-[#1F1A1C] focus:outline-none focus:border-[#7A1C24]"
            />
            <button
              type="button"
              onClick={() => addCustomChip('target_events', customEvent, setCustomEvent)}
              className="px-2.5 py-1.5 rounded-xl bg-[#F7F2E7] hover:bg-[#E8DEC8] text-[#7A1C24] border border-[#E8DEC8] text-xs font-semibold inline-flex items-center gap-1 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
        </div>

        {/* Vibe Slider */}
        <div className="rounded-2xl bg-[#FDFBF7] border border-[#E8DEC8] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-[#7A1C24]" />
              <h4 className="font-serif text-lg font-bold text-[#1F1A1C]">
                Vibe &amp; Tone
              </h4>
            </div>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#FCF5E5] text-[#8A5D0B] border border-[#D99B26]/40">
              <Flame className="w-3.5 h-3.5 text-[#D99B26]" />
              {activeVibeMeta.title}
            </span>
          </div>

          <div className="pt-2">
            <input
              type="range"
              min={0}
              max={3}
              step={1}
              value={form.vibe_slider}
              onChange={(e) =>
                onChange({
                  ...form,
                  vibe_slider: Number(e.target.value) as VibeToneLevel,
                })
              }
              className="w-full accent-[#7A1C24] cursor-pointer h-2 bg-[#E8DEC8] rounded-lg"
            />
            <div className="grid grid-cols-4 text-[10px] font-semibold text-[#5A4E52] mt-1.5">
              <span
                className={`text-left cursor-pointer ${
                  form.vibe_slider === 0 ? 'text-[#7A1C24] font-bold' : ''
                }`}
                onClick={() => onChange({ ...form, vibe_slider: 0 })}
              >
                Poetic &amp; Traditional
              </span>
              <span
                className={`text-center cursor-pointer ${
                  form.vibe_slider === 1 ? 'text-[#7A1C24] font-bold' : ''
                }`}
                onClick={() => onChange({ ...form, vibe_slider: 1 })}
              >
                Witty &amp; Punny
              </span>
              <span
                className={`text-center cursor-pointer ${
                  form.vibe_slider === 2 ? 'text-[#7A1C24] font-bold' : ''
                }`}
                onClick={() => onChange({ ...form, vibe_slider: 2 })}
              >
                Filmy Bollywood
              </span>
              <span
                className={`text-right cursor-pointer ${
                  form.vibe_slider === 3 ? 'text-[#7A1C24] font-bold' : ''
                }`}
                onClick={() => onChange({ ...form, vibe_slider: 3 })}
              >
                Unfiltered Party
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Submit Button */}
      <div className="pt-2 flex justify-end border-t border-[#E8DEC8]">
        <button
          type="submit"
          disabled={isGenerating}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-8 py-3.5 rounded-2xl font-serif text-lg font-bold bg-gradient-to-r from-[#7A1C24] via-[#8F222C] to-[#7A1C24] text-[#FDFBF7] shadow-lg hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-60 border border-[#D99B26]/40"
        >
          <Wand2 className={`w-5 h-5 text-[#F4DCA9] ${isGenerating ? 'animate-spin' : ''}`} />
          <span>{isGenerating ? 'Generating Hashtags...' : 'Generate Hashtags'}</span>
        </button>
      </div>
    </form>
  );
};
