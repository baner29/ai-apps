import {
  CoupleInputForm,
  CoupleSemanticAnalysis,
  CREATIVE_ARCHETYPES,
  CreativeArchetypeCategory,
  GeneratedHashtagPackage,
  LLMSettings,
  RetrievedExampleMatch,
} from '../types/hashtag';
import {
  buildFewShotUserPrompt,
  buildSystemPromptWithTaxonomy,
  retrieveDynamicFewShotExamples,
} from './fewShotRetriever';
import { fetchCoupleNameMeanings } from './nameMeaningService';

export interface GenerationResponse {
  packages: GeneratedHashtagPackage[];
  retrievedExamples: RetrievedExampleMatch[];
  semanticAnalysis: CoupleSemanticAnalysis;
  systemPromptUsed: string;
  userPromptUsed: string;
  source: 'vertex_ai' | 'gemini_api';
  modelUsed: string;
}

const VALID_CATEGORIES = CREATIVE_ARCHETYPES.map((a) => a.id);

function normalizeCategory(cat: string): CreativeArchetypeCategory {
  const found = VALID_CATEGORIES.find(
    (c) => c.toLowerCase() === (cat || '').trim().toLowerCase()
  );
  if (found) return found;
  const lower = (cat || '').toLowerCase();
  if (lower.includes('bilingual') || lower.includes('semantic') || lower.includes('portmanteau')) {
    return 'Bilingual Semantic Portmanteaus & Meaningful Word-Bridges';
  }
  if (lower.includes('phonetic') || lower.includes('idiom') || lower.includes('pop')) {
    return 'Phonetic Idiom & Pop-Culture Subversions';
  }
  if (lower.includes('surname') || lower.includes('identity') || lower.includes('double')) {
    return 'Surname & Identity Double-Entendres';
  }
  if (lower.includes('bollywood') || lower.includes('filmy')) {
    return 'Bollywood & Filmy Narrative Mashups';
  }
  return 'Story-Driven, Cross-Cultural & Ritual Action Tags';
}

function sanitizeHashtag(tag: string): string {
  const trimmed = (tag || '').trim().replace(/\s+/g, '');
  if (!trimmed) return '#ShaadiTag2026';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

export async function generateWeddingHashtags(
  form: CoupleInputForm,
  settings: LLMSettings,
  customSemantics?: CoupleSemanticAnalysis
): Promise<GenerationResponse> {
  // STEP 1: Understand the Top 3 Meanings & Sub-Word Splits of Bride & Groom Names via Vertex AI + Google Search Grounding
  const semanticAnalysis =
    customSemantics || (await fetchCoupleNameMeanings(form, settings));

  // STEP 2: Retrieve Dynamic Few-Shot CoT Examples & Inject Step 1 Meanings into Vertex AI Prompt
  const { combinedPromptExamples } = retrieveDynamicFewShotExamples(form);
  const systemPrompt = buildSystemPromptWithTaxonomy();
  const userPrompt = buildFewShotUserPrompt(form, combinedPromptExamples, semanticAnalysis);

  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemPrompt,
      userPrompt,
      coupleForm: form,
      semanticAnalysis,
      settings: {
        useVertexAI: true,
        vertexProject: settings.vertexProject,
        vertexLocation: 'global',
        model: 'gemini-3.8-flash',
        apiKey: settings.apiKey,
      },
    }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(
      errData.error || `Failed to generate hashtags (HTTP ${resp.status})`
    );
  }

  const data = await resp.json();
  if (!Array.isArray(data.packages) || data.packages.length === 0) {
    throw new Error('No hashtags were returned. Please try again.');
  }

  const formatted: GeneratedHashtagPackage[] = data.packages.map(
    (pkg: Record<string, unknown>, idx: number) => ({
      id: `hashtag-${idx}-${Date.now()}`,
      category: normalizeCategory(String(pkg.category || '')),
      hindi_devanagari_draft: pkg.hindi_devanagari_draft
        ? String(pkg.hindi_devanagari_draft)
        : undefined,
      grammar_and_name_audit: pkg.grammar_and_name_audit
        ? String(pkg.grammar_and_name_audit)
        : undefined,
      primary_hashtag: sanitizeHashtag(String(pkg.primary_hashtag || '')),
      companion_variations: Array.isArray(pkg.companion_variations)
        ? pkg.companion_variations.map((v: unknown) => sanitizeHashtag(String(v)))
        : [],
      recommended_events:
        Array.isArray(pkg.recommended_events) && pkg.recommended_events.length > 0
          ? pkg.recommended_events.map(String)
          : form.target_events.slice(0, 2),
      reusable_pattern_schema: String(pkg.reusable_pattern_schema || ''),
      meaning_hook_used: String(
        pkg.meaning_hook_used ||
          `${form.bride.first_name} + ${form.groom.first_name}`
      ),
      hinglish_translation: pkg.hinglish_translation
        ? String(pkg.hinglish_translation)
        : undefined,
      language_style:
        pkg.language_style === 'Hinglish + English' ||
        pkg.language_style === 'English Wordplay'
          ? pkg.language_style
          : 'Transliterated Hinglish',
      quality_score: pkg.quality_score
        ? (pkg.quality_score as GeneratedHashtagPackage['quality_score'])
        : undefined,
      creative_chain_of_thought: {
        phonetic_and_lexical_hooks: String(
          (pkg.creative_chain_of_thought as Record<string, unknown>)
            ?.phonetic_and_lexical_hooks || ''
        ),
        cultural_or_emotional_anchor: String(
          (pkg.creative_chain_of_thought as Record<string, unknown>)
            ?.cultural_or_emotional_anchor || ''
        ),
        transformation_logic: String(
          (pkg.creative_chain_of_thought as Record<string, unknown>)
            ?.transformation_logic || ''
        ),
        readability_and_trap_check: String(
          (pkg.creative_chain_of_thought as Record<string, unknown>)
            ?.readability_and_trap_check || ''
        ),
      },
      contrastive_evaluation: {
        naive_concatenation_rejected: sanitizeHashtag(
          String(
            (pkg.contrastive_evaluation as Record<string, unknown>)
              ?.naive_concatenation_rejected ||
              `#${form.groom.first_name}Weds${form.bride.first_name}`
          )
        ),
        shallow_wordplay_rejected: sanitizeHashtag(
          String(
            (pkg.contrastive_evaluation as Record<string, unknown>)
              ?.shallow_wordplay_rejected ||
              `#${form.groom.first_name.slice(0, 3)}${form.bride.first_name.slice(0, 3)}2026`
          )
        ),
        why_creative_choice_wins: String(
          (pkg.contrastive_evaluation as Record<string, unknown>)
            ?.why_creative_choice_wins || ''
        ),
      },
    })
  );

  return {
    packages: formatted,
    retrievedExamples: combinedPromptExamples,
    semanticAnalysis: data.semanticAnalysis || semanticAnalysis,
    systemPromptUsed: systemPrompt,
    userPromptUsed: userPrompt,
    source: data.source === 'gemini_api' ? 'gemini_api' : 'vertex_ai',
    modelUsed: data.modelUsed || 'gemini-3.8-flash',
  };
}
