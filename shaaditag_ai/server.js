import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '2mb' }));

// Support both GOOGLE_GENAI_USE_VERTEXAI=True and OOGLE_GENAI_USE_VERTEXAI=True
const envVertexFlag =
  process.env.GOOGLE_GENAI_USE_VERTEXAI ||
  process.env.OOGLE_GENAI_USE_VERTEXAI ||
  'True';

const DEFAULT_USE_VERTEX =
  String(envVertexFlag).toLowerCase() === 'true' || String(envVertexFlag) === '1';
const DEFAULT_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  'gemini-enterprise-app-508802';
const DEFAULT_LOCATION = 'global';
const DEFAULT_MODEL = 'gemini-3.8-flash';

// Cache gcloud access token for 40 minutes to avoid spawning gcloud on every request
let cachedGcloudToken = null;
let cachedTokenTimestamp = 0;
const TOKEN_TTL_MS = 40 * 60 * 1000;

function getGcloudAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedGcloudToken && now - cachedTokenTimestamp < TOKEN_TTL_MS) {
    return cachedGcloudToken;
  }
  try {
    const token = execSync('gcloud auth print-access-token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token && token.length > 20) {
      cachedGcloudToken = token;
      cachedTokenTimestamp = now;
      return token;
    }
  } catch {
    // On Cloud Run or environments without gcloud CLI, return null so standard ADC is used
  }
  return null;
}

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING },
      hindi_devanagari_draft: {
        type: Type.STRING,
        description:
          'Step 1: Compose the complete, natural, grammatically sound Hindi sentence in Devanagari script first before converting to Hinglish.',
      },
      grammar_and_name_audit: {
        type: Type.STRING,
        description:
          'Step 2: Verify that (a) the Hindi sentence has valid verb-tense agreement with no conflicting auxiliary verbs when a name/surname is used as a phonetic verb pun, and (b) the couple’s actual provided name(s), sub-words, or split-words are directly embedded in the phrase.',
      },
      primary_hashtag: {
        type: Type.STRING,
        description:
          'Step 3: Direct PascalCase Hinglish transliteration of the verified hindi_devanagari_draft with the couple’s name/sub-word/split-word spelling preserved.',
      },
      recommended_events: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      meaning_hook_used: { type: Type.STRING },
      hinglish_translation: { type: Type.STRING },
      language_style: { type: Type.STRING },
    },
    required: [
      'category',
      'hindi_devanagari_draft',
      'grammar_and_name_audit',
      'primary_hashtag',
      'recommended_events',
      'hinglish_translation',
      'language_style',
      'meaning_hook_used',
    ],
  },
};

const JUDGE_RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      primary_hashtag: { type: Type.STRING },
      virality: {
        type: Type.NUMBER,
        description: '0-10 score for catchiness, wedding appeal, memorability, and social shareability.',
      },
      uniqueness: {
        type: Type.NUMBER,
        description: '0-10 score for originality and bespoke creativity vs cliché templates.',
      },
      grammar_correctness: {
        type: Type.NUMBER,
        description:
          '0-10 score for 100% natural Hindi grammar and verb-tense consistency. Score <= 2 if continuous verb pun clashes with a past-tense auxiliary verb.',
      },
      hinglish_usage: {
        type: Type.NUMBER,
        description: '0-10 score for natural, authentic Hinglish flow and readability.',
      },
      name_presence: {
        type: Type.NUMBER,
        description:
          '0-10 score for explicit inclusion of Bride & Groom names, sub-words, or valid split-word fusion. Score 0 if couple names are missing or if an unprovided nickname was invented.',
      },
      judge_verdict: {
        type: Type.STRING,
        description: 'Brief 1-sentence evaluation of why this hashtag succeeded or failed.',
      },
    },
    required: [
      'primary_hashtag',
      'virality',
      'uniqueness',
      'grammar_correctness',
      'hinglish_usage',
      'name_presence',
      'judge_verdict',
    ],
  },
};

function createGenAIClient(settings = {}, forceTokenRefresh = false) {
  const project = settings.vertexProject || DEFAULT_PROJECT;
  const location = 'global';
  const requestedModel = 'gemini-3.8-flash';
  const apiKey = settings.apiKey || process.env.GEMINI_API_KEY || '';

  if (apiKey && settings.useVertexAI === false) {
    return {
      aiClient: new GoogleGenAI({ apiKey }),
      source: 'gemini_api',
      requestedModel,
    };
  }

  const gcloudToken = getGcloudAccessToken(forceTokenRefresh);
  const googleAuthOptions = gcloudToken
    ? {
        authClient: {
          getAccessToken: async () => ({ token: getGcloudAccessToken(false) || gcloudToken }),
          getRequestHeaders: async () =>
            new Headers({
              Authorization: `Bearer ${getGcloudAccessToken(false) || gcloudToken}`,
            }),
        },
      }
    : undefined;

  const aiClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    ...(googleAuthOptions ? { googleAuthOptions } : {}),
  });

  return { aiClient, source: 'vertex_ai', requestedModel };
}

async function callVertexWithModelFallback(settings, generateFn) {
  let clientInfo = createGenAIClient(settings, false);
  const targetModel = 'gemini-3.8-flash';

  try {
    const response = await generateFn(clientInfo.aiClient, targetModel);
    return { response, source: clientInfo.source, modelUsed: targetModel };
  } catch (err) {
    const msg = String(err?.message || err || '');
    // If token expired, force refresh token and retry with gemini-3.8-flash
    if (msg.includes('401') || msg.includes('UNAUTHENTICATED') || msg.includes('invalid_grant')) {
      clientInfo = createGenAIClient(settings, true);
      const response = await generateFn(clientInfo.aiClient, targetModel);
      return { response, source: clientInfo.source, modelUsed: targetModel };
    }
    throw err;
  }
}

/**
 * GET /api/config
 * Returns current Vertex AI & model configuration
 */
app.get('/api/config', (_req, res) => {
  res.json({
    useVertexAI: true,
    GOOGLE_GENAI_USE_VERTEXAI: 'True',
    OOGLE_GENAI_USE_VERTEXAI: 'True',
    vertexProject: DEFAULT_PROJECT,
    vertexLocation: DEFAULT_LOCATION,
    model: DEFAULT_MODEL,
    hasServerApiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

/**
 * POST /api/name-meanings
 * Step 1 of the Pipeline: Uses Vertex AI with Google Search Grounding (`tools: [{ googleSearch: {} }]`)
 * to discover the Top 3 Meanings of the Bride's and Groom's names in their selected language,
 * decompose each name into 2 sub-words/syllables, and brainstorm creative Hinglish bridges for THIS couple.
 */
app.post('/api/name-meanings', async (req, res) => {
  try {
    const { bride = {}, groom = {}, context = {}, settings = {} } = req.body || {};
    const brideName = String(bride.name || '').trim();
    const brideLastName = String(bride.last_name || '').trim();
    const brideLang = String(bride.language || 'Hindi').trim();
    const groomName = String(groom.name || '').trim();
    const groomLastName = String(groom.last_name || '').trim();
    const groomLang = String(groom.language || 'Hindi').trim();

    if (!brideName || !groomName) {
      return res.status(400).json({ error: 'Both bride.name and groom.name are required.' });
    }

    const brideSearchQuery = `meaning of this ${brideLang.toLowerCase()} name '${brideName.toLowerCase()}'`;
    const groomSearchQuery = `meaning of this ${groomLang.toLowerCase()} name '${groomName.toLowerCase()}'`;
    const lastNamesContext =
      brideLastName || groomLastName
        ? `\nOptional Last Names / Surnames: Bride Last Name = "${brideLastName || 'None'}", Groom Last Name = "${groomLastName || 'None'}".`
        : '';

    const coupleContextNotes = [
      Array.isArray(context.how_they_met) && context.how_they_met.length > 0
        ? `How They Met: ${context.how_they_met.join(', ')}`
        : '',
      Array.isArray(context.shared_obsessions) && context.shared_obsessions.length > 0
        ? `Shared Interests: ${context.shared_obsessions.join(', ')}`
        : '',
      Array.isArray(context.personality_dynamic) && context.personality_dynamic.length > 0
        ? `Personality: ${context.personality_dynamic.join(', ')}`
        : '',
      context.couple_story_and_vibe
        ? `About the Couple / Custom Story: ${context.couple_story_and_vibe}`
        : '',
      Array.isArray(context.target_events) && context.target_events.length > 0
        ? `Wedding Events: ${context.target_events.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' | ');

    const searchAndDecomposePrompt = `You are an expert Indian linguist, Sanskrit/Hindi/Regional etymologist, and creative wedding copywriter.

Perform a Google Search to find the accurate meanings of these two names in their specified languages:
1. Bride First Name: "${brideName}" (Language: ${brideLang}) -> Search intent: "${brideSearchQuery}"
2. Groom First Name: "${groomName}" (Language: ${groomLang}) -> Search intent: "${groomSearchQuery}"${lastNamesContext}
${coupleContextNotes ? `Couple Context: ${coupleContextNotes}` : ''}

Then analyze the two names ("${brideName}" and "${groomName}", plus any provided last names) using these linguistic steps:
STEP A — Top 3 Meanings (from Google Search):
Find the top 3 real etymological/cultural meanings for "${brideName}" in ${brideLang} and for "${groomName}" in ${groomLang}.
Remember: The meanings are for CONTEXT so we can build meaningful, auspicious Hindi sentences around the actual names — NEVER replace the names with synonyms!

STEP B — Sub-Word & Syllable Decomposition:
Split "${brideName}" into 2 sub-words/syllables (First Half & Second Half), and split "${groomName}" into 2 sub-words/syllables (First Half & Second Half).
- Check if either sub-word (or the full first/last name) has a direct meaning in Hindi/Sanskrit/Urdu/Punjabi/regional language, or sounds phonetically like a real Hindi word/verb.
- Overlapping Syllable Rule for short names: If splitting a name leaves only 1 trailing letter, include the preceding consonant to form a 2-letter overlapping syllable.

STEP C — Mandatory 4-Way Split-Word Matrix Evaluation ("split_word_combinations"):
Take the First Half and Second Half of Bride ("${brideName}") and the First Half and Second Half of Groom ("${groomName}")—also testing slight 2-to-3 letter syllable boundary shifts if that forms a cleaner Hindi word—and evaluate ALL 4 cross-half combinations:
1. "bride_first_groom_first": First Half of "${brideName}" + First Half of "${groomName}"
2. "bride_first_groom_second": First Half of "${brideName}" + Second Half of "${groomName}"
3. "groom_first_bride_first": First Half of "${groomName}" + First Half of "${brideName}"
4. "groom_first_bride_second": First Half of "${groomName}" + Second Half of "${brideName}"
For EACH of the 4 combinations, check whether the combined word forms (or sounds phonetically like) a REAL Hindi / Hinglish / Urdu / Sanskrit word with a clear meaning (for example: "Man"+"Nat"="Mannat" [wish], "Ban"+"dhan"="Bandhan" [bond], "Dil"+"Bar"="Dilbar" [sweetheart], "Sa"+"nam"="Sanam" [beloved], "So"+"ti"="Soti" [sleeping]).
If a combination forms a meaningful Hinglish word, set "is_meaningful_hinglish_word": true, provide its Devanagari Hindi word and meaning, and craft a Hindi-first Hinglish hashtag around it in "suggested_hashtag"!

STEP D — 3 Bespoke Hindi-First Transliterated Hinglish Ideas for "${brideName}" & "${groomName}":
Invent 3 completely original Transliterated Hinglish hashtag concepts specifically for "${brideName}" and "${groomName}" using a strict **Hindi-First Workflow**:
- First compose the complete, natural, grammatically valid Hindi sentence in Devanagari script.
- Check what makes a **GOOD** vs **BAD** hashtag:
  * GOOD: Meaningful split-words (from Step C) or both names/sub-words woven naturally into an auspicious, celebratory, or romantic Hindi phrase where every word agrees in grammar, gender, and verb tense.
  * GOOD: If a first name or last name sounds phonetically like a Hindi verb or phrase, it replaces ONLY that exact grammatical slot in a valid Hindi sentence without adding conflicting auxiliary verbs.
  * BAD (NEVER DO THIS): Combining a continuous/progressive verb pun with a conflicting past-tense auxiliary verb in the same clause, or writing broken Hindi grammar that no native speaker would say.
  * BAD (NEVER DO THIS): Generic story/location phrases that omit the couple's actual names, or inventing random nicknames not provided.

Return ONLY a valid JSON object matching this exact structure (no markdown code fences around it if possible, just pure JSON):
{
  "bride": {
    "top_3_meanings": ["meaning 1", "meaning 2", "meaning 3"],
    "native_synonyms": ["root/word 1", "word 2", "word 3"],
    "english_keywords": ["keyword 1", "keyword 2", "keyword 3"],
    "poetic_archetype": "short poetic title for ${brideName}",
    "etymology_note": "1-sentence origin summary from Google Search",
    "hinglish_action_verbs": ["HindiVerb1", "HindiVerb2", "HindiVerb3"],
    "subword_parts": [
      {
        "part": "FirstHalfOf${brideName}",
        "devanagari": "देवनागरी",
        "hindi_meaning": "What this sub-word means in Hindi/regional language",
        "is_overlapping": false,
        "can_stand_alone": true
      },
      {
        "part": "SecondHalfOf${brideName}",
        "devanagari": "देवनागरी",
        "hindi_meaning": "What this second sub-word means (or note that it is a syllable for cross-name fusion)",
        "is_overlapping": false,
        "can_stand_alone": false
      }
    ]
  },
  "groom": {
    "top_3_meanings": ["meaning 1", "meaning 2", "meaning 3"],
    "native_synonyms": ["root/word 1", "word 2", "word 3"],
    "english_keywords": ["keyword 1", "keyword 2", "keyword 3"],
    "poetic_archetype": "short poetic title for ${groomName}",
    "etymology_note": "1-sentence origin summary from Google Search",
    "hinglish_action_verbs": ["HindiVerb1", "HindiVerb2", "HindiVerb3"],
    "subword_parts": [
      {
        "part": "FirstHalfOf${groomName}",
        "devanagari": "देवनागरी",
        "hindi_meaning": "What this sub-word means in Hindi/regional language",
        "is_overlapping": false,
        "can_stand_alone": true
      },
      {
        "part": "SecondHalfOf${groomName}",
        "devanagari": "देवनागरी",
        "hindi_meaning": "What this second sub-word means (or note that it is a syllable for cross-name fusion)",
        "is_overlapping": false,
        "can_stand_alone": false
      }
    ]
  },
  "split_word_combinations": [
    {
      "pairing_type": "bride_first_groom_first",
      "formula": "FirstHalf(${brideName}) + FirstHalf(${groomName})",
      "combined_word": "CombinedWord1",
      "is_meaningful_hinglish_word": true,
      "hindi_devanagari": "देवनागरी",
      "hinglish_meaning": "Meaning in Hindi/Hinglish if it forms a real word, or phonetic portmanteau note",
      "suggested_hashtag": "#HindiFirstHashtagUsingCombinedWord1"
    },
    {
      "pairing_type": "bride_first_groom_second",
      "formula": "FirstHalf(${brideName}) + SecondHalf(${groomName})",
      "combined_word": "CombinedWord2",
      "is_meaningful_hinglish_word": false,
      "hindi_devanagari": "देवनागरी",
      "hinglish_meaning": "Meaning in Hindi/Hinglish if it forms a real word, or phonetic portmanteau note",
      "suggested_hashtag": "#HindiFirstHashtagUsingCombinedWord2"
    },
    {
      "pairing_type": "groom_first_bride_first",
      "formula": "FirstHalf(${groomName}) + FirstHalf(${brideName})",
      "combined_word": "CombinedWord3",
      "is_meaningful_hinglish_word": false,
      "hindi_devanagari": "देवनागरी",
      "hinglish_meaning": "Meaning in Hindi/Hinglish if it forms a real word, or phonetic portmanteau note",
      "suggested_hashtag": "#HindiFirstHashtagUsingCombinedWord3"
    },
    {
      "pairing_type": "groom_first_bride_second",
      "formula": "FirstHalf(${groomName}) + SecondHalf(${brideName})",
      "combined_word": "CombinedWord4",
      "is_meaningful_hinglish_word": true,
      "hindi_devanagari": "देवनागरी",
      "hinglish_meaning": "Meaning in Hindi/Hinglish if it forms a real word, or phonetic portmanteau note",
      "suggested_hashtag": "#HindiFirstHashtagUsingCombinedWord4"
    }
  ],
  "combined_theme": "1-line summary of how ${brideName} and ${groomName}'s meanings and split-words connect",
  "cross_subword_fusions": [
    {
      "combined_word": "ShortLabel1",
      "formula": "How ${brideName} & ${groomName} or their sub-words combine",
      "hindi_meaning": "Hindi sentence + English translation of this concept",
      "example_hinglish_tag": "#OriginalHinglishTag1"
    },
    {
      "combined_word": "ShortLabel2",
      "formula": "Sub-word formula for ${brideName} & ${groomName}",
      "hindi_meaning": "Hindi sentence + English translation of this concept",
      "example_hinglish_tag": "#OriginalHinglishTag2"
    },
    {
      "combined_word": "ShortLabel3",
      "formula": "Cross-syllable fusion for ${brideName} & ${groomName}",
      "hindi_meaning": "Hindi sentence + English translation of this concept",
      "example_hinglish_tag": "#OriginalHinglishTag3"
    }
  ],
  "semantic_bridges": [
    "Bridge 1 description",
    "Bridge 2 description",
    "Bridge 3 description"
  ]
}`;

    const { response } = await callVertexWithModelFallback(settings, (aiClient, model) =>
      aiClient.models.generateContent({
        model,
        contents: searchAndDecomposePrompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.7,
        },
      })
    );

    const rawText = response?.text || '';
    const cleanedText = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Vertex AI did not return structured JSON for name meanings.');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const groundingChunks =
      response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const snippets = groundingChunks
      .map((c) => c?.web?.title || c?.web?.uri)
      .filter(Boolean)
      .slice(0, 4);

    const brideMeaning = {
      name: brideName,
      language: brideLang,
      google_search_query: brideSearchQuery,
      top_3_meanings:
        Array.isArray(parsed.bride?.top_3_meanings) && parsed.bride.top_3_meanings.length >= 3
          ? parsed.bride.top_3_meanings.slice(0, 3)
          : [
              parsed.bride?.top_3_meanings?.[0] || `${brideName} (${brideLang} Etymology)`,
              parsed.bride?.top_3_meanings?.[1] || `Radiant Grace & Auspicious Spirit`,
              parsed.bride?.top_3_meanings?.[2] || `Beloved Companion`,
            ],
      native_synonyms: parsed.bride?.native_synonyms || [brideName],
      english_keywords: parsed.bride?.english_keywords || ['Grace', 'Light', 'Love'],
      poetic_archetype: parsed.bride?.poetic_archetype || `${brideName}`,
      etymology_note:
        parsed.bride?.etymology_note ||
        `Discovered via Vertex AI Google Search Grounding for "${brideSearchQuery}".`,
      subword_parts: Array.isArray(parsed.bride?.subword_parts) ? parsed.bride.subword_parts : [],
      hinglish_action_verbs: Array.isArray(parsed.bride?.hinglish_action_verbs)
        ? parsed.bride.hinglish_action_verbs
        : [],
      search_snippets: snippets,
      source: 'google_search_gemini',
    };

    const groomMeaning = {
      name: groomName,
      language: groomLang,
      google_search_query: groomSearchQuery,
      top_3_meanings:
        Array.isArray(parsed.groom?.top_3_meanings) && parsed.groom.top_3_meanings.length >= 3
          ? parsed.groom.top_3_meanings.slice(0, 3)
          : [
              parsed.groom?.top_3_meanings?.[0] || `${groomName} (${groomLang} Etymology)`,
              parsed.groom?.top_3_meanings?.[1] || `Noble Strength & Devotion`,
              parsed.groom?.top_3_meanings?.[2] || `Beloved Soulmate`,
            ],
      native_synonyms: parsed.groom?.native_synonyms || [groomName],
      english_keywords: parsed.groom?.english_keywords || ['Strength', 'Soul', 'Love'],
      poetic_archetype: parsed.groom?.poetic_archetype || `${groomName}`,
      etymology_note:
        parsed.groom?.etymology_note ||
        `Discovered via Vertex AI Google Search Grounding for "${groomSearchQuery}".`,
      subword_parts: Array.isArray(parsed.groom?.subword_parts) ? parsed.groom.subword_parts : [],
      hinglish_action_verbs: Array.isArray(parsed.groom?.hinglish_action_verbs)
        ? parsed.groom.hinglish_action_verbs
        : [],
      search_snippets: snippets,
      source: 'google_search_gemini',
    };

    return res.json({
      bride_meaning: brideMeaning,
      groom_meaning: groomMeaning,
      split_word_combinations: Array.isArray(parsed.split_word_combinations)
        ? parsed.split_word_combinations
        : [],
      combined_theme:
        parsed.combined_theme ||
        `${brideName} (${brideMeaning.top_3_meanings[0]}) × ${groomName} (${groomMeaning.top_3_meanings[0]})`,
      cross_subword_fusions: Array.isArray(parsed.cross_subword_fusions)
        ? parsed.cross_subword_fusions
        : [],
      semantic_bridges: Array.isArray(parsed.semantic_bridges) ? parsed.semantic_bridges : [],
    });
  } catch (error) {
    console.error('[ShaadiTag AI Server] Vertex AI Name Meaning error:', error?.message || error);
    return res.status(500).json({
      error: error?.message || 'Vertex AI failed to resolve name meanings via Google Search.',
    });
  }
});

/**
 * Helper: Second LLM Call (Judge / Scorer LLM)
 * Evaluates all 30+ generated hashtags on:
 * 1. virality (0-10)
 * 2. uniqueness (0-10)
 * 3. grammar_correctness (0-10)
 * 4. hinglish_usage (0-10)
 * 5. name_presence (0-10)
 */
async function scoreAndRankHashtagsWithJudgeLLM({
  candidates,
  coupleForm = {},
  semanticAnalysis = {},
  settings = {},
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  // Deduplicate candidates by normalized hashtag
  const seen = new Set();
  const uniqueCandidates = [];
  for (const item of candidates) {
    const key = String(item?.primary_hashtag || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(item);
  }

  const brideFirst = String(coupleForm?.bride?.first_name || semanticAnalysis?.bride_meaning?.name || '').trim();
  const brideLast = String(coupleForm?.bride?.last_name || '').trim();
  const brideNick = String(coupleForm?.bride?.nickname || '').trim();
  const groomFirst = String(coupleForm?.groom?.first_name || semanticAnalysis?.groom_meaning?.name || '').trim();
  const groomLast = String(coupleForm?.groom?.last_name || '').trim();
  const groomNick = String(coupleForm?.groom?.nickname || '').trim();

  const splitWordsSummary = Array.isArray(semanticAnalysis?.split_word_combinations)
    ? semanticAnalysis.split_word_combinations
        .map(
          (sw) =>
            `${sw.combined_word} (${sw.formula} -> Meaningful: ${sw.is_meaningful_hinglish_word ? 'YES' : 'NO'}, Meaning: ${sw.hinglish_meaning})`
        )
        .join('; ')
    : 'None';

  const judgeSystemInstruction = `You are a strict, expert Indian Wedding Copywriting Judge and Hindi/Hinglish Linguist.
Your job is to evaluate and score each generated wedding hashtag across 5 exact criteria on a 0 to 10 scale:
1. "virality" (0-10): How catchy, punchy, memorable, and wedding-ready is this hashtag when spoken aloud or printed on Sangeet backdrops?
2. "uniqueness" (0-10): How creative and bespoke is this hashtag compared to generic templates? (Reward clever split-words, dual-name meaning harmony, and personalized story/event hooks).
3. "grammar_correctness" (0-10): Is the underlying Hindi sentence ("hindi_devanagari_draft") 100% grammatically valid and natural in Hindi?
   - STRICT PENALTY: If a name or surname is used as a phonetic verb pun (e.g., sounding like a continuous verb) AND is combined with a conflicting past-tense auxiliary verb in the same clause, or if no native Hindi speaker would ever say that sentence, score "grammar_correctness" <= 2!
4. "hinglish_usage" (0-10): Does the Hinglish transliteration flow naturally and read effortlessly in Roman script?
5. "name_presence" (0-10): Does the hashtag explicitly contain the Bride's and/or Groom's provided First Name, Last Name, provided Nickname, sub-word, or valid 4-way split-word?
   - Score 9-10 if BOTH partners' names/sub-words or a valid split-word uniting both names are present.
   - Score 6-8 if only one partner's name or shared surname is present.
   - STRICT PENALTY (Score 0): If NEITHER partner's name/sub-word/split-word is present (e.g., a generic story/venue tag without names), OR if the tag invents a random nickname that was NOT provided by the user!`;

  const judgeUserPrompt = `Score the following ${uniqueCandidates.length} candidate wedding hashtags for this couple:
- Bride: First Name = "${brideFirst}", Last Name = "${brideLast}", Provided Nickname = "${brideNick || 'NONE'}"
- Groom: First Name = "${groomFirst}", Last Name = "${groomLast}", Provided Nickname = "${groomNick || 'NONE'}"
- Valid Split-Word Combinations: ${splitWordsSummary}
- Selected Parameters:
  • How They Met: ${(coupleForm?.how_they_met || []).join(', ') || 'None'}
  • Shared Interests: ${(coupleForm?.shared_obsessions || []).join(', ') || 'None'}
  • Personality: ${(coupleForm?.personality_dynamic || []).join(', ') || 'None'}
  • Custom Story: ${coupleForm?.couple_story_and_vibe || 'None'}
  • Target Events: ${(coupleForm?.target_events || []).join(', ') || 'All Events'}

Candidates to evaluate:
${JSON.stringify(
  uniqueCandidates.map((c) => ({
    primary_hashtag: c.primary_hashtag,
    hindi_devanagari_draft: c.hindi_devanagari_draft,
    hinglish_translation: c.hinglish_translation,
    meaning_hook_used: c.meaning_hook_used,
  })),
  null,
  2
)}`;

  try {
    const { response } = await callVertexWithModelFallback(settings, (aiClient, model) =>
      aiClient.models.generateContent({
        model,
        contents: judgeUserPrompt,
        config: {
          systemInstruction: judgeSystemInstruction,
          responseMimeType: 'application/json',
          responseSchema: JUDGE_RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      })
    );

    const rawScores = JSON.parse(response?.text || '[]');
    const scoreMap = new Map();
    if (Array.isArray(rawScores)) {
      for (const s of rawScores) {
        const key = String(s?.primary_hashtag || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '');
        if (key) {
          scoreMap.set(key, s);
        }
      }
    }

    const scoredCandidates = uniqueCandidates.map((pkg) => {
      const key = String(pkg?.primary_hashtag || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
      const s = scoreMap.get(key) || {
        virality: 7.5,
        uniqueness: 7.5,
        grammar_correctness: 7.5,
        hinglish_usage: 7.5,
        name_presence: 7.5,
        judge_verdict: 'Evaluated candidate.',
      };

      const virality = Number(s.virality ?? 7.5);
      const uniqueness = Number(s.uniqueness ?? 7.5);
      const grammar_correctness = Number(s.grammar_correctness ?? 7.5);
      const hinglish_usage = Number(s.hinglish_usage ?? 7.5);
      const name_presence = Number(s.name_presence ?? 7.5);

      let overall_score =
        Math.round(
          (grammar_correctness * 0.3 +
            name_presence * 0.25 +
            hinglish_usage * 0.2 +
            virality * 0.15 +
            uniqueness * 0.1) *
            10
        ) / 10;

      // Disqualify/heavily penalize broken grammar or missing couple names
      if (grammar_correctness < 5 || name_presence < 5) {
        overall_score = Math.min(overall_score, 3.0);
      }

      return {
        ...pkg,
        quality_score: {
          virality,
          uniqueness,
          grammar_correctness,
          hinglish_usage,
          name_presence,
          overall_score,
          judge_verdict: String(s.judge_verdict || ''),
        },
      };
    });

    // Sort by overall_score descending
    scoredCandidates.sort(
      (a, b) => (b.quality_score?.overall_score || 0) - (a.quality_score?.overall_score || 0)
    );

    // Filter out candidates that failed grammar or name presence
    const passing = scoredCandidates.filter(
      (c) =>
        (c.quality_score?.grammar_correctness ?? 0) >= 6 &&
        (c.quality_score?.name_presence ?? 0) >= 6
    );

    const pool = passing.length >= 10 ? passing : scoredCandidates;
    return pool.slice(0, 15);
  } catch (judgeErr) {
    console.warn(
      '[ShaadiTag AI Server] Judge LLM scoring fallback:',
      judgeErr?.message || judgeErr
    );
    return uniqueCandidates.slice(0, 15);
  }
}

/**
 * POST /api/generate
 * Step 2A: Generator LLM creates at least 30 candidate hashtags behind the scenes.
 * Step 2B: Judge/Scorer LLM evaluates all 30+ candidates on Virality, Uniqueness,
 *          Grammar Correctness, Hinglish Usage, and Name Presence, returning the top-scored hashtags.
 */
app.post('/api/generate', async (req, res) => {
  try {
    const {
      systemPrompt,
      userPrompt,
      coupleForm = {},
      semanticAnalysis,
      settings = {},
    } = req.body || {};

    if (!systemPrompt || !userPrompt) {
      return res.status(400).json({
        error: 'Both systemPrompt and userPrompt are required.',
      });
    }

    // LLM Call 1: Generate 30+ candidate hashtags
    const { response, source, modelUsed } = await callVertexWithModelFallback(
      settings,
      (aiClient, model) =>
        aiClient.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.9,
          },
        })
    );

    const rawText = response?.text || '[]';
    const parsedPackages = JSON.parse(rawText);

    // LLM Call 2: Score all 30+ generated hashtags with Judge LLM and return the top-ranked results
    const topScoredPackages = await scoreAndRankHashtagsWithJudgeLLM({
      candidates: parsedPackages,
      coupleForm,
      semanticAnalysis,
      settings,
    });

    return res.json({
      packages: topScoredPackages,
      totalGeneratedBehindScenes: Array.isArray(parsedPackages) ? parsedPackages.length : 0,
      semanticAnalysis,
      source,
      modelUsed,
    });
  } catch (error) {
    console.error('[ShaadiTag AI Server] Vertex AI Generation error:', error?.message || error);
    return res.status(500).json({
      error: error?.message || 'Vertex AI endpoint error',
    });
  }
});

// Serve static Vite build in production / Cloud Run
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      res
        .status(200)
        .send(
          'ShaadiTag AI backend is running on Vertex AI. Run `npm run build` to serve the frontend bundle.'
        );
    }
  });
});

app.listen(PORT, () => {
  console.log(
    `✨ ShaadiTag AI Server (Vertex AI Only) listening on http://localhost:${PORT} | Project=${DEFAULT_PROJECT} | Location=${DEFAULT_LOCATION}`
  );
});
