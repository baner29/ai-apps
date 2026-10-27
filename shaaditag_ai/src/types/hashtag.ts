export type CreativeArchetypeCategory =
  | 'Bilingual Semantic Portmanteaus & Meaningful Word-Bridges'
  | 'Phonetic Idiom & Pop-Culture Subversions'
  | 'Surname & Identity Double-Entendres'
  | 'Bollywood & Filmy Narrative Mashups'
  | 'Story-Driven, Cross-Cultural & Ritual Action Tags';

export const CREATIVE_ARCHETYPES: {
  id: CreativeArchetypeCategory;
  shortTitle: string;
  taxonomyKey: string;
  badgeColor: string;
  description: string;
}[] = [
  {
    id: 'Bilingual Semantic Portmanteaus & Meaningful Word-Bridges',
    shortTitle: 'Bilingual Semantic Synthesis',
    taxonomyKey: '1_bilingual_semantic_synthesis',
    badgeColor: 'bg-[#7A1C24]/10 text-[#7A1C24] border-[#7A1C24]/25',
    description:
      'Finds real Hindi, Urdu, Punjabi, Gujarati, or Sanskrit words hidden inside the couple’s names (like #Nibaha or #SauMeinEk).',
  },
  {
    id: 'Phonetic Idiom & Pop-Culture Subversions',
    shortTitle: 'Phonetic Climax Subversion',
    taxonomyKey: '3_phonetic_climax_subversion',
    badgeColor: 'bg-[#D99B26]/15 text-[#8A5D0B] border-[#D99B26]/35',
    description:
      'Places a name or surname on the final stressed beat of a familiar English idiom or pop-culture phrase (like #RidhiSetGogna).',
  },
  {
    id: 'Surname & Identity Double-Entendres',
    shortTitle: 'Surname & Identity Wordplay',
    taxonomyKey: '2_narrative_and_personality_anchoring',
    badgeColor: 'bg-emerald-900/10 text-emerald-900 border-emerald-800/25',
    description:
      'Unlocks witty double meanings in maiden, married, or shared surnames (like #NoLongerSinghal, #HePutASinghOnIt, or #ALovePatel).',
  },
  {
    id: 'Bollywood & Filmy Narrative Mashups',
    shortTitle: 'Bollywood & Filmy Mashups',
    taxonomyKey: '3_phonetic_climax_subversion',
    badgeColor: 'bg-purple-900/10 text-purple-900 border-purple-800/25',
    description:
      'Swaps the couple’s syllables or surnames into iconic Bollywood movie titles and chartbuster hooks (like #GillTohPagalHai).',
  },
  {
    id: 'Story-Driven, Cross-Cultural & Ritual Action Tags',
    shortTitle: 'Story, Culture & Ritual Tags',
    taxonomyKey: '4_cultural_and_ritual_contextualization',
    badgeColor: 'bg-amber-900/10 text-amber-900 border-amber-800/25',
    description:
      'Weaves in Haldi, Mehendi, Sangeet, Pheras, regional food pairings, or relationship quirks (like #TuBeerMaiChakna or #PriyaPheraPuneet).',
  },
];

export type NameLanguage =
  | 'Hindi'
  | 'English'
  | 'Marathi'
  | 'Tamil'
  | 'Telugu'
  | 'Bengali'
  | 'Sanskrit'
  | 'Punjabi'
  | 'Gujarati'
  | 'Urdu';

export const NAME_LANGUAGES: {
  id: NameLanguage;
  label: string;
  searchHint: string;
}[] = [
  { id: 'Hindi', label: 'Hindi (हिन्दी)', searchHint: 'hindi' },
  { id: 'English', label: 'English', searchHint: 'english' },
  { id: 'Marathi', label: 'Marathi (मराठी)', searchHint: 'marathi' },
  { id: 'Tamil', label: 'Tamil (தமிழ்)', searchHint: 'tamil' },
  { id: 'Telugu', label: 'Telugu / Telegu (తెలుగు)', searchHint: 'telugu' },
  { id: 'Bengali', label: 'Bengali (বাংলা)', searchHint: 'bengali' },
  { id: 'Sanskrit', label: 'Sanskrit (संस्कृतम्)', searchHint: 'sanskrit' },
  { id: 'Punjabi', label: 'Punjabi (ਪੰਜਾਬੀ)', searchHint: 'punjabi' },
  { id: 'Gujarati', label: 'Gujarati (ગુજરાતી)', searchHint: 'gujarati' },
  { id: 'Urdu', label: 'Urdu (اردو)', searchHint: 'urdu' },
];

export interface PartnerProfile {
  first_name: string;
  last_name: string;
  nickname: string;
  cultural_roots: string;
  name_language?: NameLanguage;
}

export interface SubwordPart {
  part: string;
  hindi_meaning: string;
  devanagari?: string;
  is_overlapping?: boolean;
}

export interface CrossSubwordFusion {
  combined_word: string;
  formula: string;
  hindi_meaning: string;
  example_hinglish_tag: string;
}

export interface SplitWordCombination {
  pairing_type:
    | 'bride_first_groom_first'
    | 'bride_first_groom_second'
    | 'groom_first_bride_first'
    | 'groom_first_bride_second';
  formula: string;
  combined_word: string;
  is_meaningful_hinglish_word: boolean;
  hindi_devanagari?: string;
  hinglish_meaning: string;
  suggested_hashtag?: string;
}

export interface HashtagQualityScore {
  virality: number;
  uniqueness: number;
  grammar_correctness: number;
  hinglish_usage: number;
  name_presence: number;
  overall_score: number;
  judge_verdict?: string;
}

export interface NameMeaningResult {
  name: string;
  language: NameLanguage;
  google_search_query: string;
  top_3_meanings: [string, string, string];
  subword_parts?: SubwordPart[];
  hinglish_action_verbs?: string[];
  native_synonyms: string[];
  english_keywords: string[];
  poetic_archetype: string;
  etymology_note: string;
  search_snippets: string[];
  source: 'google_search_gemini' | 'live_web_search' | 'semantic_lexicon';
}

export interface CoupleSemanticAnalysis {
  bride_meaning: NameMeaningResult;
  groom_meaning: NameMeaningResult;
  split_word_combinations?: SplitWordCombination[];
  cross_subword_fusions?: CrossSubwordFusion[];
  semantic_bridges: string[];
  combined_theme: string;
}

export interface CreativeChainOfThought {
  phonetic_and_lexical_hooks: string;
  cultural_or_emotional_anchor: string;
  transformation_logic: string;
  readability_and_trap_check: string;
}

export interface ContrastiveEvaluation {
  naive_concatenation_rejected: string;
  shallow_wordplay_rejected: string;
  why_creative_choice_wins: string;
}

export interface TargetOutput {
  primary_hashtag: string;
  companion_variations: string[];
  reusable_pattern_schema: string;
}

export interface TrainingExample {
  id: number;
  category: CreativeArchetypeCategory;
  input_context: {
    bride: PartnerProfile;
    groom: PartnerProfile;
    couple_story_and_vibe: string;
  };
  creative_chain_of_thought: CreativeChainOfThought;
  target_output: TargetOutput;
  contrastive_evaluation: ContrastiveEvaluation;
  source_name?: string;
  source_url?: string;
}

export interface DatasetSchema {
  dataset_metadata: {
    title: string;
    version: string;
    total_training_examples: number;
    purpose: string;
    core_design_philosophy: string;
  };
  llm_system_prompt_template: string;
  creative_reasoning_taxonomy: {
    '1_bilingual_semantic_synthesis': { definition: string; why_it_beats_mere_wordplay: string };
    '2_narrative_and_personality_anchoring': { definition: string; why_it_beats_mere_wordplay: string };
    '3_phonetic_climax_subversion': { definition: string; why_it_beats_mere_wordplay: string };
    '4_cultural_and_ritual_contextualization': { definition: string; why_it_beats_mere_wordplay: string };
    '5_safety_and_usability_guardrails': {
      lowercase_trap_check: string;
      father_in_law_and_emcee_test: string;
      character_budget: string;
    };
  };
  training_examples: TrainingExample[];
}

export type SurnameStrategy =
  | 'bride_takes_groom'
  | 'keep_own'
  | 'shared_surname'
  | 'first_names_only';

export type VibeToneLevel = 0 | 1 | 2 | 3;

export interface CoupleInputForm {
  bride: PartnerProfile;
  groom: PartnerProfile;
  surname_strategy: SurnameStrategy;
  how_they_met: string[];
  shared_obsessions: string[];
  personality_dynamic: string[];
  couple_story_and_vibe: string;
  target_events: string[];
  vibe_slider: VibeToneLevel;
}

export interface GeneratedHashtagPackage {
  id: string;
  category: CreativeArchetypeCategory;
  hindi_devanagari_draft?: string;
  grammar_and_name_audit?: string;
  primary_hashtag: string;
  companion_variations: string[];
  recommended_events: string[];
  reusable_pattern_schema?: string;
  meaning_hook_used?: string;
  hinglish_translation?: string;
  language_style?: 'Transliterated Hinglish' | 'Hinglish + English' | 'English Wordplay';
  quality_score?: HashtagQualityScore;
  creative_chain_of_thought: CreativeChainOfThought;
  contrastive_evaluation: ContrastiveEvaluation;
}

export interface RetrievedExampleMatch {
  example: TrainingExample;
  score: number;
  match_reasons: string[];
}

export interface LLMSettings {
  mode: 'vertex_or_api' | 'local_pattern_engine';
  useVertexAI: boolean;
  vertexProject: string;
  vertexLocation: string;
  model: string;
  apiKey: string;
}
