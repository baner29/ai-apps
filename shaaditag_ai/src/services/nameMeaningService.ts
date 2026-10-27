import {
  CoupleInputForm,
  CoupleSemanticAnalysis,
  LLMSettings,
  NameLanguage,
} from '../types/hashtag';

export function buildGoogleSearchQuery(name: string, language: NameLanguage = 'Hindi'): string {
  const cleanName = (name || '').trim().toLowerCase() || 'name';
  const cleanLang = (language || 'Hindi').trim().toLowerCase();
  return `meaning of this ${cleanLang} name '${cleanName}'`;
}

/**
 * Step 1: Calls the Vertex AI + Google Search Grounding endpoint (`/api/name-meanings`)
 * to discover the Top 3 Meanings of the Bride's and Groom's names in their selected language,
 * decompose each name into 2 sub-words/syllables, and brainstorm bespoke Transliterated Hinglish bridges.
 */
export async function fetchCoupleNameMeanings(
  form: CoupleInputForm,
  settings?: LLMSettings
): Promise<CoupleSemanticAnalysis> {
  const brideLang: NameLanguage = form.bride.name_language || 'Hindi';
  const groomLang: NameLanguage = form.groom.name_language || 'Hindi';

  const resp = await fetch('/api/name-meanings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bride: {
        name: form.bride.first_name,
        last_name: form.bride.last_name,
        nickname: form.bride.nickname,
        language: brideLang,
        cultural_roots: form.bride.cultural_roots,
      },
      groom: {
        name: form.groom.first_name,
        last_name: form.groom.last_name,
        nickname: form.groom.nickname,
        language: groomLang,
        cultural_roots: form.groom.cultural_roots,
      },
      context: {
        surname_strategy: form.surname_strategy,
        how_they_met: form.how_they_met,
        shared_obsessions: form.shared_obsessions,
        personality_dynamic: form.personality_dynamic,
        couple_story_and_vibe: form.couple_story_and_vibe,
        target_events: form.target_events,
        vibe_slider: form.vibe_slider,
      },
      settings: settings
        ? {
            useVertexAI: true,
            vertexProject: settings.vertexProject,
            vertexLocation: 'global',
            model: 'gemini-3.8-flash',
          }
        : undefined,
    }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(
      errData.error || `Name meaning lookup failed with status ${resp.status}`
    );
  }

  const data = await resp.json();
  return {
    bride_meaning: data.bride_meaning,
    groom_meaning: data.groom_meaning,
    split_word_combinations: Array.isArray(data.split_word_combinations)
      ? data.split_word_combinations
      : [],
    semantic_bridges: Array.isArray(data.semantic_bridges) ? data.semantic_bridges : [],
    cross_subword_fusions: Array.isArray(data.cross_subword_fusions)
      ? data.cross_subword_fusions
      : [],
    combined_theme:
      data.combined_theme ||
      `${form.bride.first_name} & ${form.groom.first_name}`,
  };
}
