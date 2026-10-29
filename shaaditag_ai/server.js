import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { createHash } from 'node:crypto';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import fs from 'fs';

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
  'banercorp-web';
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

function createGenAIClient(settings = {}, forceTokenRefresh = false) {
  const project = settings.vertexProject || DEFAULT_PROJECT;
  const location = 'global';
  const requestedModel = 'gemini-3.8-flash';
  // Vertex AI only: authentication is via Application Default Credentials
  // (the Cloud Run service account). No API-key or local fallback path.
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

async function callVertexWithAuthRetry(settings, generateFn) {
  const targetModel = 'gemini-3.8-flash';
  const backoffMs = [0, 5000, 15000, 30000];
  let lastErr = null;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
    let clientInfo = createGenAIClient(settings, false);
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
      lastErr = err;
      const retryable =
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('fetch failed') ||
        msg.includes('overloaded');
      if (!retryable) throw err;
      console.error(
        '[ShaadiTag AI Server] Vertex retryable error (attempt ' + (attempt + 1) + '):',
        msg.slice(0, 200)
      );
    }
  }
  throw lastErr;
}

app.get('/api/config', (_req, res) => {
  res.json({
    useVertexAI: true,
    GOOGLE_GENAI_USE_VERTEXAI: 'True',
    OOGLE_GENAI_USE_VERTEXAI: 'True',
    vertexProject: DEFAULT_PROJECT,
    vertexLocation: DEFAULT_LOCATION,
    model: DEFAULT_MODEL,
  });
});

const semanticsCache = new Map();

function cleanFragments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && f.fragment && Array.isArray(f.readings) && f.readings.length > 0)
    .filter((f) => String(f.wedding_fit || 'good').toLowerCase() !== 'poor')
    .slice(0, 6)
    .map((f) => ({
      fragment: String(f.fragment).replace(/[^A-Za-z]/g, ''),
      readings: f.readings.slice(0, 3).map((r) => ({
        type: String(r?.type || ''),
        word: String(r?.word || ''),
        meaning: String(r?.meaning || ''),
      })),
    }))
    .filter((f) => f.fragment.length >= 2);
}

async function fetchNameMeanings({ bride = {}, groom = {}, context = {} }) {
  const cacheKey = [bride?.name, bride?.last_name, bride?.language, bride?.nickname, groom?.name, groom?.last_name, groom?.language, groom?.nickname]
    .join('|')
    .toLowerCase();
  const cachedSemantics = semanticsCache.get(cacheKey);
  if (cachedSemantics && Date.now() - cachedSemantics.at < 3600000) {
    return cachedSemantics.data;
  }
  const settings = {};
  try {
    const brideName = String(bride.name || '').trim();
    const brideLastName = String(bride.last_name || '').trim();
    const brideLang = String(bride.language || 'Hindi').trim();
    const groomName = String(groom.name || '').trim();
    const groomLastName = String(groom.last_name || '').trim();
    const groomLang = String(groom.language || 'Hindi').trim();
    const brideNick = String(bride.nickname || '').trim();
    const groomNick = String(groom.nickname || '').trim();

    if (!brideName || !groomName) {
      throw new Error('Both bride.name and groom.name are required.');
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
For EACH of the 4 combinations, check whether the combined word forms (or sounds phonetically like) a REAL Hindi / Hinglish / Urdu / Sanskrit word with a clear meaning (for example: "Man"+"Nat"="Mannat" [wish], "Ban"+"dhan"="Bandhan" [bond], "Dil"+"Bar"="Dilbar" [sweetheart], "Sa"+"nam"="Sanam" [beloved]).
If a combination forms a meaningful Hinglish word, set "is_meaningful_hinglish_word": true, provide its Devanagari Hindi word and meaning, and craft a Hindi-first Hinglish hashtag around it in "suggested_hashtag"!
STRICT — what counts as meaningful:
- The combined form must be ONE common Hindi/Urdu/Sanskrit word in everyday use — a noun or adjective with an evocative meaning (Mannat = a vow/wish, Bandhan = bond, Sanam = beloved, Dilbar = sweetheart).
- It must NOT be a person's name, or merely sound like one. Fusions like "Manesh", "Natesha" or "Priyank" are names, not words — set false.
- It must NOT be a mundane verb phrase, everyday instruction fragment, or mundane state/activity word (for example "abhi kha" = eat right now, "soti" = sleeping) — set false, even though the Hindi is real.
When in doubt, set false. A false negative is far better than a false positive.

STEP D — 3 Bespoke Hindi-First Transliterated Hinglish Ideas for "${brideName}" & "${groomName}":
Invent 3 completely original Transliterated Hinglish hashtag concepts specifically for "${brideName}" and "${groomName}" using a strict **Hindi-First Workflow**:
- First compose the complete, natural, grammatically valid Hindi sentence in Devanagari script.
- Check what makes a **GOOD** vs **BAD** hashtag:
  * GOOD: Meaningful split-words (from Step C) or both names/sub-words woven naturally into an auspicious, celebratory, or romantic Hindi phrase where every word agrees in grammar, gender, and verb tense.
  * GOOD: If a first name or last name sounds phonetically like a Hindi verb or phrase, it replaces ONLY that exact grammatical slot in a valid Hindi sentence without adding conflicting auxiliary verbs.
  * BAD (NEVER DO THIS): Combining a continuous/progressive verb pun with a conflicting past-tense auxiliary verb in the same clause, or writing broken Hindi grammar that no native speaker would say.
  * BAD (NEVER DO THIS): Generic story/location phrases that omit the couple's actual names, or inventing random nicknames not provided.

STEP E — Fragment Mining (the raw material for great hashtags):
For EACH partner — and for their nickname, if one is provided (Bride nickname: "${brideNick || 'none'}", Groom nickname: "${groomNick || 'none'}") — list every usable fragment: syllable-boundary prefixes and suffixes of 2 or more letters, the name with its trailing vowel dropped (Jyoti -> Jyot), and the halves from Step B. For each fragment, report every way it reads as a REAL word:
- type "hindi": it is a Hindi/Urdu word (Jyot = flame; Rabh, read as Rab = God)
- type "english": it is, or sounds exactly like, an English word (Sou -> "So"; a nickname like Lucky -> "lucky")
- type "number": it is a number or quantity word (Sou/Sau = hundred)
- type "phrase": it completes a famous idiom, song or film line (Rabh -> "Rab Ne Bana Di Jodi")
Set "wedding_fit": "good" only when the reading is auspicious, romantic or celebratory; "poor" for mundane, negative or comic readings (sleeping, eating, crying) — poor fragments get discarded, so be honest.
Return at most 6 fragments per partner, best readings first. Omit fragments that have no real-word reading at all.

Return ONLY a valid JSON object matching this exact structure (no markdown code fences, just pure JSON). Be concise: each meaning 2-5 words, each hindi_meaning under 8 words:
{
  "bride": {
    "top_3_meanings": ["meaning 1", "meaning 2", "meaning 3"],
    "subword_parts": [
      { "part": "FirstHalf", "devanagari": "देवनागरी", "hindi_meaning": "meaning of this sub-word", "can_stand_alone": true },
      { "part": "SecondHalf", "devanagari": "देवनागरी", "hindi_meaning": "meaning of this sub-word", "can_stand_alone": false }
    ],
    "fragments": [
      { "fragment": "Frag1", "readings": [ { "type": "hindi", "word": "Word", "meaning": "what it means" } ], "wedding_fit": "good" },
      { "fragment": "Frag2", "readings": [ { "type": "english", "word": "Word", "meaning": "what it means" } ], "wedding_fit": "good" }
    ]
  },
  "groom": {
    "top_3_meanings": ["meaning 1", "meaning 2", "meaning 3"],
    "subword_parts": [
      { "part": "FirstHalf", "devanagari": "देवनागरी", "hindi_meaning": "meaning of this sub-word", "can_stand_alone": true },
      { "part": "SecondHalf", "devanagari": "देवनागरी", "hindi_meaning": "meaning of this sub-word", "can_stand_alone": false }
    ],
    "fragments": [
      { "fragment": "Frag1", "readings": [ { "type": "hindi", "word": "Word", "meaning": "what it means" } ], "wedding_fit": "good" },
      { "fragment": "Frag2", "readings": [ { "type": "english", "word": "Word", "meaning": "what it means" } ], "wedding_fit": "good" }
    ]
  },
  "split_word_combinations": [
    { "pairing_type": "bride_first_groom_first", "formula": "FirstHalf(Bride) + FirstHalf(Groom)", "combined_word": "Word1", "is_meaningful_hinglish_word": true, "hindi_devanagari": "देवनागरी", "hinglish_meaning": "meaning or phonetic note", "suggested_hashtag": "#Tag1" },
    { "pairing_type": "bride_first_groom_second", "formula": "FirstHalf(Bride) + SecondHalf(Groom)", "combined_word": "Word2", "is_meaningful_hinglish_word": false, "hindi_devanagari": "देवनागरी", "hinglish_meaning": "meaning or phonetic note", "suggested_hashtag": "#Tag2" },
    { "pairing_type": "groom_first_bride_first", "formula": "FirstHalf(Groom) + FirstHalf(Bride)", "combined_word": "Word3", "is_meaningful_hinglish_word": false, "hindi_devanagari": "देवनागरी", "hinglish_meaning": "meaning or phonetic note", "suggested_hashtag": "#Tag3" },
    { "pairing_type": "groom_first_bride_second", "formula": "FirstHalf(Groom) + SecondHalf(Bride)", "combined_word": "Word4", "is_meaningful_hinglish_word": true, "hindi_devanagari": "देवनागरी", "hinglish_meaning": "meaning or phonetic note", "suggested_hashtag": "#Tag4" }
  ],
  "cross_subword_fusions": [
    { "combined_word": "Label1", "formula": "how the names/sub-words combine", "hindi_meaning": "Hindi sentence + English translation", "example_hinglish_tag": "#Tag1" },
    { "combined_word": "Label2", "formula": "how the names/sub-words combine", "hindi_meaning": "Hindi sentence + English translation", "example_hinglish_tag": "#Tag2" },
    { "combined_word": "Label3", "formula": "how the names/sub-words combine", "hindi_meaning": "Hindi sentence + English translation", "example_hinglish_tag": "#Tag3" }
  ],
  "semantic_bridges": ["bridge 1", "bridge 2", "bridge 3"]
}`;

    let parsed = null;
    let response = null;
    let lastParseError = null;
    for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
      const strictNote =
        '\n\nSTRICT FORMAT REMINDER: Output ONE valid JSON object and nothing else. No prose before or after, no markdown fences, and never use a double-quote character inside a string value (use single quotes instead).';
      const promptForAttempt =
        attempt === 0
          ? searchAndDecomposePrompt
          : attempt === 1
            ? searchAndDecomposePrompt + strictNote
            : searchAndDecomposePrompt +
              strictNote +
              '\n\nIMPORTANT: Do NOT use web search this time. Answer from your own knowledge of these names.';
      let attemptResponse;
      try {
        ({ response: attemptResponse } = await callVertexWithAuthRetry(settings, (aiClient, model) =>
          aiClient.models.generateContent({
            model,
            contents: promptForAttempt,
            config: {
              ...(attempt < 2 ? { tools: [{ googleSearch: {} }] } : {}),
              temperature: attempt === 0 ? 0.5 : 0.3,
              maxOutputTokens: 8192,
            },
          })
        ));
      } catch (callErr) {
        lastParseError = callErr;
        console.error(
          '[ShaadiTag AI Server] Meanings call failed (attempt ' + (attempt + 1) + '):',
          String(callErr?.message || callErr).slice(0, 200)
        );
        continue;
      }
      response = attemptResponse;
      const rawText = attemptResponse?.text || '';
      const jsonText = extractJsonObject(rawText);
      if (!jsonText) {
        lastParseError = new Error('Vertex AI did not return a JSON object for name meanings.');
        console.error('[ShaadiTag AI Server] Meanings raw output (no JSON found):', rawText.slice(0, 1200));
        continue;
      }
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseErr) {
        lastParseError = parseErr;
        console.error(
          '[ShaadiTag AI Server] Meanings JSON parse failed:',
          parseErr?.message,
          '| raw excerpt:',
          jsonText.slice(0, 1200)
        );
      }
    }
    if (!parsed) throw lastParseError || new Error('Vertex AI returned unparseable JSON for name meanings.');

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

    const semanticsResult = {
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
      bride_fragments: cleanFragments(parsed.bride?.fragments),
      groom_fragments: cleanFragments(parsed.groom?.fragments),
    };
    semanticsCache.set(cacheKey, { at: Date.now(), data: semanticsResult });
    return semanticsResult;
  } catch (error) {
    console.error('[ShaadiTag AI Server] Vertex AI Name Meaning error:', error?.message || error);
    throw error;
  }
}



function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ============================================================================
// ShaadiTag AI v2 — minimalist pipeline (no LLM judge):
//   1) Vertex AI name meanings + split-word evaluation (fetchNameMeanings)
//   2) One lean Vertex generation call (Hindi-first, slim few-shot)
//   3) Deterministic code gates: name presence, length, lowercase trap, dedup
//   4) Deterministic ranking: real split-words > both names > one name > sub-word
// ============================================================================

const DATASET = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'src/data/indian_wedding_hashtags_template.json'),
    'utf8'
  )
);

const GENERATION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING },
      hindi_devanagari_draft: {
        type: Type.STRING,
        description:
          'Step 1: Compose the complete, natural, grammatically sound Hindi wedding phrase in Devanagari FIRST.',
      },
      primary_hashtag: {
        type: Type.STRING,
        description:
          'Step 2: CamelCase Hinglish transliteration of the Hindi draft, preserving the exact spelling of the couple name material used.',
      },
      meaning_hook_used: {
        type: Type.STRING,
        description:
          'One line naming the exact name material used, e.g. "Split-word: Man + Nat = Mannat (sacred wish)" or "Both full names woven into a blessing".',
      },
      hinglish_translation: {
        type: Type.STRING,
        description: 'One line: the English meaning of the phrase.',
      },
      companion_variations: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Up to 2 shorter companion hashtags using the same hook.',
      },
    },
    required: [
      'category',
      'hindi_devanagari_draft',
      'primary_hashtag',
      'meaning_hook_used',
      'hinglish_translation',
    ],
  },
};

const SYSTEM_PROMPT_V2 = `You are ShaadiTag AI, an expert creator of Indian wedding hashtags that sound meaningful and human — never random words arranged around two names.

METHOD (follow for every hashtag):
1. Hindi-first: compose the complete phrase as a natural Hindi sentence first (Devanagari), the way a native speaker would actually say it at a wedding — correct word order, postpositions, gender and verb tense. Only then transliterate it to CamelCase Hinglish.
2. The phrase must MEAN something complete: a blessing, a vow, a celebration line, or a witty remark a family would happily print on a wedding backdrop.

NAME RULES (strict):
- Use ONLY the couple's provided first names, last names, and exact sub-words / split-words of those names. Use nicknames ONLY when the couple provides them — never invent one. Never replace a name with a synonym or a different word.
- Every hashtag must contain at least one partner's name, surname, sub-word, or a validated split-word fusion of both names. A tag about the event/story with no name material is useless — never output one.
- Prefer, in order: (a) a real phrase built on a split-word fusion that forms a REAL Hindi/Urdu/Sanskrit word, (b) a sentence-style phrase built on a provided nickname (gold when the nickname is also a real word with a double meaning) or on a name's meaning, (c) one full name inside a real phrase, (d) both full names — only inside a real phrase, never as a bare name join. The couple HATES hashtags that merely glue names or surnames together (Name+Sang+Name, surname mashups, Name+Ka+Name possessives) — never produce those.

SPLIT-WORD METHOD:
Split each first name into two halves and test the 4 cross combinations for a real word:
- Manisha (Man+isha) + Natesh (Nat+esh): Man+Nat = Mannat (a sacred wish) -> #PuriHuiHamariMannat
- Bandana (Ban+dana) + Vardhan (Var+dhan): Ban+dhan = Bandhan (the sacred bond) -> #JanamJanamKaBandhan
- Barsha (Bar+sha) + Dilip (Dil+ip): Dil+Bar = Dilbar (beloved) -> #MilGayeDoDilbar
- Poonam (Poo+nam) + Sanat (Sa+nat): Sa+nam = Sanam (beloved) -> #SaatJanmonKeSanam
Only build split-word tags on combinations confirmed meaningful in the data given to you, or on fusions that genuinely read as a word — do not force a portmanteau that means nothing.

CREATIVE ARCHETYPES (cover at least 3 when material allows; never force a category that has no real material):
1. Bilingual Semantic Portmanteaus & Meaningful Word-Bridges — real words hidden inside the names.
2. Phonetic Idiom & Pop-Culture Subversions — a name placed on the stressed beat of a familiar idiom or hook, grammatically intact.
3. Fragment Hooks & Cross-Language Wordplay — name fragments that are real words in Hindi/Urdu, in English sound (Sou = So), or as numbers (Sou/Sau = hundred), placed inside real phrases.
4. Bollywood & Filmy Narrative Mashups — iconic filmy lines reworked around the names.
5. Story-Driven, Cross-Cultural & Ritual Action Tags — blessings and ritual phrases (pheras, saath, sangam, bandhan) carrying the names.

GUARDRAILS:
- CamelCase, no spaces or punctuation inside the hashtag. Target 22 characters or fewer (hard max 26).
- Must read cleanly aloud (a DJ/emcee test) and must not form an unintended word when written all-lowercase.
- No broken Hindi: if a name is used as a phonetic verb pun, it must replace the whole verb phrase cleanly — never clash a continuous-tense pun with a past-tense auxiliary.`;

function parseFullName(full) {
  const parts = String(full || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

function nameHalves(name, subwordParts) {
  if (
    subwordParts &&
    subwordParts.length >= 2 &&
    subwordParts[0].part &&
    subwordParts[1].part
  ) {
    return [subwordParts[0].part.trim(), subwordParts[1].part.trim()];
  }
  const clean = (name || '').trim();
  if (clean.length <= 3) return [clean.slice(0, 2), clean.slice(1)];
  const mid = Math.ceil(clean.length / 2);
  return [clean.slice(0, mid), clean.slice(mid)];
}

// All name fragments a hashtag may legitimately contain (lowercase, len >= 3).
function fragmentSet(person, subwordParts) {
  const frags = new Set();
  const add = (s) => {
    const t = String(s || '').trim().toLowerCase();
    if (t.length >= 3) frags.add(t);
  };
  add(person.first);
  add(person.last);
  const [h1, h2] = nameHalves(person.first, subwordParts);
  add(h1);
  add(h2);
  // Only validated material gates a tag: full names, surnames, the canonical
  // halves, and the linguist pass's sub-word parts. Arbitrary boundary slices
  // (e.g. "sha" from Manisha) are too weak — they let generic tags through.
  (subwordParts || []).forEach((p) => add(p.part));
  return frags;
}

const LOWERCASE_TRAPS = [
  'anus', 'arse', 'assh', 'shit', 'fuck', 'crap', 'piss',
  'dick', 'cock', 'boob', 'slut', 'whore', 'fart', 'poop',
];

function cleanTag(raw) {
  let t = String(raw || '').trim().replace(/\s+/g, '');
  if (!t.startsWith('#')) t = `#${t}`;
  return `#${t.slice(1).replace(/[^A-Za-z0-9]/g, '')}`;
}

const CONNECTOR_WORDS = new Set([
  'sang', 'sangam', 'ka', 'ki', 'ko', 'se', 'mila', 'mili', 'mile', 'weds', 'wed',
  'and', 'the', 'hue', 'hui', 'hain', 'do', 'ek', 'aur', 'with',
]);
// Real Hindi/Urdu words that happen to be prefixes of common names — exempt
// from the invented-pseudo-word rule below.
const PREFIX_EXCEPTION_WORDS = new Set([
  'mann', 'dil', 'jaan', 'ishq', 'prem', 'pyaar', 'pyar', 'saath', 'jeet',
  'preet', 'deep', 'raja', 'rani', 'shaan', 'noor', 'chand', 'sagar', 'amar',
]);

function tagTokens(body) {
  return body
    .split(/(?<=[a-z0-9])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

// Taste rules from the couple's own feedback: no surname glue, no names-only
// joins, no invented pseudo-words. Returns true when the tag must be rejected.
function failsHardRules(body, ctx) {
  const tokens = tagTokens(body);
  const surnameHit = (surname) => {
    if (!surname || surname.length < 3) return false;
    return tokens.some(
      (t) => t === surname || (surname.length >= 4 && t.startsWith(surname))
    );
  };
  if (surnameHit(ctx.brideLast) || surnameHit(ctx.groomLast)) return true;
  if (
    tokens.length >= 2 &&
    tokens.every((t) => ctx.nameTokens.has(t) || CONNECTOR_WORDS.has(t))
  ) {
    return true;
  }
  // Near-name tokens are invented material: "Natesha" (Natesh + a) and
  // "Manesh" are not real words, even when a name fragment matches them.
  // Exempt: the exact names, provided nicknames, and validated split-words
  // (Bandhan sits at edit distance 2 from Vardhan and is a real word).
  const comboWords = new Set(ctx.meaningfulCombos.map((c) => c.word));
  // Hindi transliteration variants of the name itself (Sourabh/Saurabh,
  // ou/au are the same vowel) are the name, not an imitation of it.
  const canon = (w) => w.replace(/ou/g, 'o').replace(/au/g, 'o');
  const canonNames = new Set([...ctx.nameTokens].map(canon));
  for (const t of tokens) {
    if (t.length >= 5 && !ctx.nameTokens.has(t) && !comboWords.has(t) && !canonNames.has(canon(t))) {
      for (const n of ctx.fullFirsts) {
        if (editDistance(t, n) <= 2) return true;
      }
    }
  }
  for (const t of tokens) {
    if (t.length >= 5 && !ctx.allFrags.has(t) && !PREFIX_EXCEPTION_WORDS.has(t)) {
      if (ctx.fullFirsts.some((n) => n.length > t.length && n.startsWith(t))) {
        return true;
      }
      // Near-name pseudo-words: a token that closely imitates a first name
      // without being it or validated material (e.g. "Vardana" aping Vardhan)
      // is invented material — reject. Validated split-words (Bandhan) are in
      // allFrags and never reach this check.
      for (const n of ctx.fullFirsts) {
        if (
          Math.abs(n.length - t.length) <= 2 &&
          t.slice(0, 4) === n.slice(0, 4) &&
          editDistance(t, n) <= 3
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function buildGateContext(bride, groom, semantics, nicknames = {}) {
  const meaningfulCombos = (semantics.split_word_combinations || [])
    .filter((sw) => sw.is_meaningful_hinglish_word && sw.combined_word)
    .map((sw) => ({
      word: String(sw.combined_word).toLowerCase().replace(/[^a-z0-9]/g, ''),
      raw: sw,
    }))
    .filter((c) => c.word.length >= 4);
  const brideFrags = fragmentSet(bride, semantics.bride_meaning?.subword_parts);
  const groomFrags = fragmentSet(groom, semantics.groom_meaning?.subword_parts);
  const brideNick = String(nicknames.bride || '').trim().toLowerCase();
  const groomNick = String(nicknames.groom || '').trim().toLowerCase();
  if (brideNick.length >= 3) brideFrags.add(brideNick);
  if (groomNick.length >= 3) groomFrags.add(groomNick);
  for (const f of semantics.bride_fragments || []) {
    const t = String(f?.fragment || '').trim().toLowerCase();
    if (t.length >= 2) brideFrags.add(t);
  }
  for (const f of semantics.groom_fragments || []) {
    const t = String(f?.fragment || '').trim().toLowerCase();
    if (t.length >= 2) groomFrags.add(t);
  }
  const brideFirst = (bride.first || '').toLowerCase();
  const groomFirst = (groom.first || '').toLowerCase();
  const allFrags = new Set([
    ...brideFrags,
    ...groomFrags,
    ...meaningfulCombos.map((c) => c.word),
  ]);
  return {
    brideFrags,
    groomFrags,
    brideFirst,
    groomFirst,
    brideNick,
    groomNick,
    brideLast: (bride.last || '').toLowerCase(),
    groomLast: (groom.last || '').toLowerCase(),
    nameTokens: new Set([brideFirst, groomFirst, brideNick, groomNick].filter(Boolean)),
    fullFirsts: [brideFirst, groomFirst].filter(Boolean),
    allFrags,
    meaningfulCombos,
  };
}

// Returns { ok, score, coreKey, pkg } — deterministic quality gate + rank score.
function gateCandidate(pkg, ctx) {
  const tag = cleanTag(pkg.primary_hashtag);
  const body = tag.slice(1);
  const lower = body.toLowerCase();
  if (body.length < 4 || body.length > 26) return { ok: false };
  for (const trap of LOWERCASE_TRAPS) {
    if (lower.includes(trap)) return { ok: false };
  }
  if (failsHardRules(body, ctx)) return { ok: false };
  const tokens = tagTokens(body);
  const camelWords = tokens;
  const fragHit = (f) =>
    f.length >= 4 ? lower.includes(f) : camelWords.some((w) => w.startsWith(f));
  const brideHits = [...ctx.brideFrags].filter(fragHit);
  const groomHits = [...ctx.groomFrags].filter(fragHit);
  const comboHit = ctx.meaningfulCombos.find((c) => lower.includes(c.word));
  if (!comboHit && brideHits.length === 0 && groomHits.length === 0) {
    return { ok: false };
  }
  let score = 0;
  let coreKey = '';
  if (comboHit) {
    score += 60;
    coreKey = `combo:${comboHit.word}`;
  }
  const hasBrideFirst = ctx.brideFirst && lower.includes(ctx.brideFirst);
  const hasGroomFirst = ctx.groomFirst && lower.includes(ctx.groomFirst);
  const hasBrideNick = ctx.brideNick && tokens.includes(ctx.brideNick);
  const hasGroomNick = ctx.groomNick && tokens.includes(ctx.groomNick);
  const nonNameTokens = tokens.filter(
    (t) => !ctx.nameTokens.has(t) && !CONNECTOR_WORDS.has(t)
  );
  // Sentence-style nickname phrase (e.g. ShikhuGotLucky) — the couple's favourite.
  if ((hasBrideNick || hasGroomNick) && tokens.length >= 3) score += 25;
  // A real phrase carries at least two words that are not names or connectors.
  if (nonNameTokens.length >= 2) score += 20;
  if (hasBrideFirst && hasGroomFirst && !comboHit) score -= 30;
  else if (!comboHit && (hasBrideFirst || hasGroomFirst || hasBrideNick || hasGroomNick)) score += 15;
  else if (!comboHit) score += 10;
  if (body.length >= 8 && body.length <= 20) score += 5;
  if (!coreKey) {
    const longest = [...brideHits, ...groomHits].sort((a, b) => b.length - a.length)[0];
    coreKey = `frag:${longest || lower.slice(0, 8)}`;
  }
  const brideSide = Boolean(comboHit) || brideHits.length > 0;
  const groomSide = Boolean(comboHit) || groomHits.length > 0;
  const bothSides = brideSide && groomSide;
  if (bothSides) score += 15;
  const companions = Array.isArray(pkg.companion_variations)
    ? pkg.companion_variations
        .map((v) => cleanTag(v))
        .filter((v) => {
          const b = v.slice(1).toLowerCase();
          return (
            v.slice(1).length >= 4 &&
            v.slice(1).length <= 26 &&
            !failsHardRules(v.slice(1), ctx) &&
            !LOWERCASE_TRAPS.some((t) => b.includes(t)) &&
            (ctx.meaningfulCombos.some((c) => b.includes(c.word)) ||
              [...ctx.brideFrags].some((f) =>
                f.length >= 4
                  ? b.includes(f)
                  : v.slice(1).split(/(?<=[a-z0-9])(?=[A-Z])/).some((w) => w.toLowerCase().startsWith(f))
              ) ||
              [...ctx.groomFrags].some((f) =>
                f.length >= 4
                  ? b.includes(f)
                  : v.slice(1).split(/(?<=[a-z0-9])(?=[A-Z])/).some((w) => w.toLowerCase().startsWith(f))
              ))
          );
        })
        .slice(0, 2)
    : [];
  return {
    ok: true,
    score,
    bothSides,
    coreKey,
    pkg: {
      category: String(pkg.category || ''),
      hindi_devanagari_draft: String(pkg.hindi_devanagari_draft || ''),
      primary_hashtag: tag,
      meaning_hook_used: String(pkg.meaning_hook_used || ''),
      hinglish_translation: String(pkg.hinglish_translation || ''),
      companion_variations: companions,
    },
  };
}

function applyGates(candidates, ctx, exclude) {
  const excludeSet = new Set(
    (exclude || []).map((t) => cleanTag(t).toLowerCase())
  );
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    const g = gateCandidate(c, ctx);
    if (!g.ok) continue;
    const key = g.pkg.primary_hashtag.toLowerCase();
    if (seen.has(key) || excludeSet.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  // Near-duplicate control: at most 2 tags per core hook.
  const coreCount = new Map();
  return out.filter((g) => {
    const n = (coreCount.get(g.coreKey) || 0) + 1;
    coreCount.set(g.coreKey, n);
    return n <= 2;
  });
}

function rankAndPick(gated, limit = 12) {
  const sorted = [...gated].sort((a, b) => b.score - a.score);
  const byCat = new Map();
  for (const g of sorted) {
    const c = g.pkg.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(g);
  }
  const picked = [];
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const list of byCat.values()) {
      if (list.length && picked.length < limit) {
        picked.push(list.shift());
        progressed = true;
      }
    }
  }
  return picked.map((g) => g.pkg);
}

const NAME_SUFFIXES = ['preet', 'deep', 'jeet', 'inder', 'leen', 'neet', 'ika', 'isha'];

function pickExamples(bride, groom) {
  const bf = (bride.first || '').toLowerCase();
  const gf = (groom.first || '').toLowerCase();
  const bl = (bride.last || '').toLowerCase();
  const gl = (groom.last || '').toLowerCase();
  const scored = DATASET.training_examples
    .map((ex) => {
      let s = 0;
      const ebf = (ex.input_context.bride.first_name || '').toLowerCase();
      const egf = (ex.input_context.groom.first_name || '').toLowerCase();
      const ebl = (ex.input_context.bride.last_name || '').toLowerCase();
      const egl = (ex.input_context.groom.last_name || '').toLowerCase();
      if (bf && (ebf === bf || egf === bf)) s += 45;
      if (gf && (egf === gf || ebf === gf)) s += 45;
      if (bl && (ebl === bl || egl === bl)) s += 35;
      if (gl && (egl === gl || ebl === gl)) s += 35;
      for (const suf of NAME_SUFFIXES) {
        if (bf.endsWith(suf) && gf.endsWith(suf) && bf !== gf) {
          if ((ex.target_output.reusable_pattern_schema || '').toLowerCase().includes(suf)) s += 25;
        }
      }
      if (bf && gf && bf[0] === gf[0] && ebf && egf && ebf[0] === egf[0] && ebf[0] === bf[0]) s += 15;
      return { ex, s };
    })
    .sort((a, b) => b.s - a.s);
  const picked = [];
  const seenCat = new Set();
  for (const { ex } of scored) {
    if (picked.length >= 6) break;
    if (!seenCat.has(ex.category)) {
      picked.push(ex);
      seenCat.add(ex.category);
    }
  }
  for (const { ex } of scored) {
    if (picked.length >= 10) break;
    if (!picked.includes(ex)) picked.push(ex);
  }
  return picked;
}

function slimExample(ex) {
  const c = ex.input_context;
  const t = ex.target_output;
  const comp = (t.companion_variations || []).slice(0, 2).join(', ');
  return `- [${ex.category}] ${c.bride.first_name} ${c.bride.last_name || ''} & ${c.groom.first_name} ${c.groom.last_name || ''} -> ${t.primary_hashtag}${comp ? ` (also: ${comp})` : ''} — pattern: ${t.reusable_pattern_schema}`;
}

function buildGeneratePrompt({ bride, groom, nicknames = {}, semantics, examples, exclude, retryNote }) {
  const bm = semantics.bride_meaning;
  const gm = semantics.groom_meaning;
  const hookLines = (frags) =>
    (frags || [])
      .map((f) => {
        const rs = (f.readings || [])
          .map((r) => `${r.type}: "${r.word}" (${r.meaning})`)
          .join('; ');
        return `  - "${f.fragment}" -> ${rs}`;
      })
      .join('\n');
  const brideHooks = hookLines(semantics.bride_fragments);
  const groomHooks = hookLines(semantics.groom_fragments);
  const validCombos = (semantics.split_word_combinations || [])
    .filter((sw) => sw.is_meaningful_hinglish_word && sw.combined_word)
    .map((sw) => `  - "${sw.combined_word}" (${sw.formula}) — ${sw.hinglish_meaning || ''}`)
    .join('\n');
  return `Create wedding hashtags for this couple using the FRAGMENT-HOOK ALGORITHM.

COUPLE:
- Bride: ${bride.first}${bride.last ? ` ${bride.last}` : ''}${nicknames.bride ? ` (nickname: ${nicknames.bride})` : ''} — name meanings: ${(bm?.top_3_meanings || []).join('; ')}
- Groom: ${groom.first}${groom.last ? ` ${groom.last}` : ''}${nicknames.groom ? ` (nickname: ${nicknames.groom})` : ''} — name meanings: ${(gm?.top_3_meanings || []).join('; ')}

FRAGMENT HOOKS — every usable piece of their names, with what each piece really is. This is your raw material:
Bride hooks:
${brideHooks || '  - (none mined — use her full name, nickname and meanings)'}
Groom hooks:
${groomHooks || '  - (none mined — use his full name, nickname and meanings)'}
${validCombos ? `\nVALIDATED SPLIT-WORDS (fusions of both names that are real common words):\n${validCombos}` : ''}

THE ALGORITHM — follow it exactly:
1. Start from the hooks, not the full names. A hook is a fragment that IS a real word in some register: a Hindi/Urdu word, an English sound-alike, a number word, or part of a famous phrase. The best hashtags place hooks inside real phrases where the hook's real-word meaning does the work.
2. EVERY hashtag must represent BOTH partners — each at least once, via a hook fragment, a nickname, a full name, or a validated split-word (a split-word contains both partners).
3. Every content word in a hashtag must trace to something real: a hook or one of its readings, a partner's documented name meaning (attached to that same partner), or ordinary wedding vocabulary (pyaar, ishq, khushi, khushiyan, bandhan, shaadi, dil, jaan, kismat, dua, safar, ghar, milan, sangam-as-a-word). NEVER import a random poetic word that traces to nothing — that is how bad tags are born.
4. Phrase frames that work (adapt freely, invent more in the same spirit):
   - English sentence on an English-reading hook: "Sou" sounds like "So" -> #SouInLoveWithJyoti
   - Number play: Ek (one) + Jyot (flame) + Sou (hundred) + Khushiyan (joys) -> #EkJyotSouKhushiyan, "one flame, a hundred joys"
   - Famous-line graft: Rabh reads as Rab (God) -> #RabhNeBanaDiJyoti, from "Rab Ne Bana Di Jodi"
   - Hook as a common noun in a real sentence: #JyotJaliSaurabhKGharMe, "the flame lit up in Saurabh's home"
   - Lifetimes frame: #SouJanmoKiJyoti, "the light of a hundred lifetimes"
   - Hindi-first blessing on a validated split-word: #PuriHuiMannat, #JanamJanamKaBandhan, #PaawanBandhan
   - Nickname as a real word in a sentence: #ShikhuGotLucky (Lucky is the groom's nickname AND the English word)
5. Grammar must be real — a native speaker reads the phrase aloud and nods. No glued name-pairs, no bare possessives, no surname building blocks, no invented words, no mundane hooks (sleeping, eating).

WORKED EXAMPLES — the couple's own verdicts on a real couple, Jyoti (nickname Rani) & Sourabh:
GOOD: #SouInLoveWithJyoti (the best one — fragment "Sou" becomes the English word "So"), #EkJyotSouKhushiyan, #RabhNeBanaDiJyoti, #JyotJaliSaurabhKGharMe, #SouJanmoKiJyoti. Every one carries BOTH partners through hooks whose meanings do real work.
BAD: #SotiPreetJagaDi ("preet" traces to nothing; "soti" means sleeping — a useless hook), #MahakUthiJyoti ("mahak" traces to nothing; groom missing), #JagmagHuiJyoti (generic sparkle template anyone could generate; groom missing), #SourabhKiKhushbu (a bare possessive that says nothing).
ALSO REJECTED, from other couples: #NateshSangManisha, #KapoorVermaSangam, #ManishaKaNatesh, #VermaGharChaliKapoor, #DoRoyEkHue, #MilaDuaKoVardana, #ManKoBhaayeManesh, #SundarHaiNatesha (name/surname glue, counting jokes, invented pseudo-words, fusions that merely sound like a person's name).

TASK: Generate exactly 18 hashtag packages following the algorithm. Rules:
- Both partners in every tag (rule 2). At most 2 tags may use both FULL first names; prefer hooks.
- If any fragment has an "english" reading, at least 3 tags must exploit English-reading hooks in English sentences.
- If a nickname is itself a real word (hindi or english reading), at least 2 tags must build on it.
- Build split-word tags ONLY on the validated split-words listed above.
- Follow the Hindi-first method for Hindi phrases: Devanagari draft first, then the CamelCase hashtag.
${exclude && exclude.length ? `\nDo NOT repeat or closely imitate these already-shown hashtags: ${exclude.join(', ')}` : ''}${retryNote ? `\nIMPORTANT: ${retryNote}` : ''}`;
}

async function generateCandidates(args) {
  const prompt = buildGeneratePrompt(args);
  // Routed through the same backoff-retry wrapper as the meanings call —
  // a bare 429 here used to kill the whole request (seen live 2026-10-27).
  const { response } = await callVertexWithAuthRetry({}, (aiClient, model) =>
    aiClient.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_PROMPT_V2,
        responseMimeType: 'application/json',
        responseSchema: GENERATION_SCHEMA,
        temperature: 0.75,
        maxOutputTokens: 8192,
      },
    })
  );
  try {
    const parsed = JSON.parse(response?.text || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * POST /api/name-meanings — kept for compatibility/testing.
 */
app.post('/api/name-meanings', async (req, res) => {
  try {
    const { bride = {}, groom = {}, context = {} } = req.body || {};
    const data = await fetchNameMeanings({ bride, groom, context });
    return res.json(data);
  } catch (error) {
    console.error('[ShaadiTag AI Server] Name Meaning error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Vertex AI failed.' });
  }
});

// ---------------------------------------------------------------------------
// Feedback storage (Firestore) — like/dislike ratings become the knowledge
// base for future prompt tuning / training. Lazy + failure-tolerant: if
// Firestore is unavailable the endpoint reports 503 and the app carries on.
// ---------------------------------------------------------------------------
let firestoreDb = null;
let firestoreTried = false;
function getFirestore() {
  if (firestoreTried) return firestoreDb;
  firestoreTried = true;
  try {
    firestoreDb = new Firestore({ projectId: DEFAULT_PROJECT });
  } catch (e) {
    console.error('[ShaadiTag AI Server] Firestore init failed:', e?.message || e);
    firestoreDb = null;
  }
  return firestoreDb;
}

app.post('/api/feedback', async (req, res) => {
  try {
    const {
      sessionId = '',
      brideName = '',
      groomName = '',
      brideNickname = '',
      groomNickname = '',
      hashtag = '',
      rating = '',
      category = '',
      hinglishTranslation = '',
      meaningHook = '',
    } = req.body || {};
    const tag = cleanTag(hashtag);
    if (!tag || !['like', 'dislike', 'none'].includes(rating)) {
      return res.status(400).json({ error: 'A hashtag and a valid rating are required.' });
    }
    const db = getFirestore();
    if (!db) return res.status(503).json({ error: 'Feedback storage is unavailable.' });
    const docId = createHash('sha256')
      .update(`${sessionId}|${brideName}|${groomName}|${tag}`.toLowerCase())
      .digest('hex')
      .slice(0, 32);
    const ref = db.collection('hashtag_feedback').doc(docId);
    if (rating === 'none') {
      await ref.delete();
    } else {
      const snap = await ref.get();
      await ref.set({
        sessionId: String(sessionId).slice(0, 64),
        brideName: String(brideName).slice(0, 80),
        groomName: String(groomName).slice(0, 80),
        brideNickname: String(brideNickname).slice(0, 40),
        groomNickname: String(groomNickname).slice(0, 40),
        hashtag: tag,
        rating,
        category: String(category).slice(0, 80),
        hinglishTranslation: String(hinglishTranslation).slice(0, 300),
        meaningHook: String(meaningHook).slice(0, 300),
        createdAt: snap.exists ? snap.get('createdAt') : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    console.log(`[ShaadiTag AI Server] Feedback stored: ${tag} = ${rating} (doc ${docId})`);
    return res.json({ ok: true });
  } catch (error) {
    console.error('[ShaadiTag AI Server] Feedback error:', error?.message || error);
    return res.status(500).json({ error: 'Could not save feedback.' });
  }
});

/**
 * POST /api/generate — starts an async generation job (v4).
 * Body: { brideName, groomName, brideNickname?, groomNickname?, exclude?: string[] }
 * Returns 202 { jobId, status: 'running' }; poll GET /api/generate/:jobId.
 * Jobs live in memory for 30 minutes so a client that navigates away, locks
 * the phone, or reloads reattaches to the finished result instead of failing.
 */
const jobs = new Map();
function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > 30 * 60000) jobs.delete(id);
  }
}

app.post('/api/generate', (req, res) => {
  const {
    brideName = '',
    groomName = '',
    brideNickname = '',
    groomNickname = '',
    exclude = [],
  } = req.body || {};
  if (!parseFullName(brideName).first || !parseFullName(groomName).first) {
    return res.status(400).json({ error: 'Both brideName and groomName are required.' });
  }
  pruneJobs();
  const jobId = createHash('sha256')
    .update(`${Date.now()}|${Math.random()}|${brideName}|${groomName}`)
    .digest('hex')
    .slice(0, 16);
  const job = { status: 'running', createdAt: Date.now(), result: null, error: null };
  jobs.set(jobId, job);
  runGeneration({ brideName, groomName, brideNickname, groomNickname, exclude })
    .then((result) => {
      job.status = 'done';
      job.result = result;
    })
    .catch((error) => {
      console.error('[ShaadiTag AI Server] Generation error:', error?.message || error);
      job.status = 'error';
      job.error = error?.message || 'Vertex AI endpoint error';
    });
  return res.status(202).json({ jobId, status: 'running' });
});

app.get('/api/generate/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'That generation has expired. Please run it again.' });
  }
  if (job.status === 'running') return res.json({ status: 'running' });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });
  return res.json({ status: 'done', ...job.result });
});

async function runGeneration({ brideName = '', groomName = '', brideNickname = '', groomNickname = '', exclude = [] }) {
    const bride = parseFullName(brideName);
    const groom = parseFullName(groomName);
    const cleanNick = (v) => String(v || '').replace(/[^A-Za-z]/g, '');
    const nicknames = {
      bride: cleanNick(brideNickname),
      groom: cleanNick(groomNickname),
    };

    const startedAt = Date.now();
    const semantics = await fetchNameMeanings({
      bride: { name: bride.first, last_name: bride.last, language: 'Hindi', nickname: nicknames.bride },
      groom: { name: groom.first, last_name: groom.last, language: 'Hindi', nickname: nicknames.groom },
      context: {},
    });

    const ctx = buildGateContext(bride, groom, semantics, nicknames);
    const examples = pickExamples(bride, groom);

    let candidates = await generateCandidates({
      bride, groom, nicknames, semantics, examples, exclude,
    });
    let gated = applyGates(candidates, ctx, exclude);

    if (gated.length < 8 && Date.now() - startedAt < 180000) {
      const retryNote =
        'A previous attempt produced too few quality hashtags. Produce phrase-style tags built on the hidden split-word (marked YES), on name meanings, or on the nicknames — real phrases and sentences. Never name-glue joins: no Name+Sang+Name, no surname mashups, no Name+Ka+Name possessives, no invented pseudo-words.';
      const more = await generateCandidates({
        bride, groom, nicknames, semantics, examples,
        exclude: [...exclude, ...gated.map((g) => g.pkg.primary_hashtag)],
        retryNote,
      });
      gated = applyGates([...candidates, ...more], ctx, exclude);
    }

    const packages = [
      ...rankAndPick(gated.filter((g) => g.bothSides), 12),
      ...rankAndPick(gated.filter((g) => !g.bothSides), 12),
    ].slice(0, 12);
    if (packages.length === 0) {
      throw new Error('Generation produced no hashtags that passed the name checks. Please try again.');
    }

    const HIGHLIGHT_KEYWORDS = [
      'wish', 'prayer', 'bond', 'love', 'beloved', 'vow', 'blessing', 'union',
      'sacred', 'promise', 'soulmate', 'heart', 'eternal', 'destiny', 'grace',
      'dream', 'flame', 'light', 'star', 'moon', 'divine', 'forever', 'royal',
    ];
    const hl = (semantics.split_word_combinations || [])
      .filter((sw) => sw.is_meaningful_hinglish_word)
      .map((sw, i) => {
        const text = `${sw.combined_word || ''} ${sw.hinglish_meaning || ''}`.toLowerCase();
        const score = HIGHLIGHT_KEYWORDS.reduce(
          (acc, k) => acc + (text.includes(k) ? 1 : 0),
          0
        );
        return { sw, score, i };
      })
      .sort((a, b) => b.score - a.score || a.i - b.i)[0]?.sw;
    return {
      packages,
      highlight: hl
        ? {
            word: hl.combined_word,
            devanagari: hl.hindi_devanagari || '',
            meaning: hl.hinglish_meaning || '',
            formula: hl.formula || '',
          }
        : null,
      source: 'vertex_ai',
      modelUsed: DEFAULT_MODEL,
    };
}

// Exposed for local gate/ranking tests only.
export const _test = {
  parseFullName,
  fragmentSet,
  cleanTag,
  buildGateContext,
  gateCandidate,
  applyGates,
  rankAndPick,
  pickExamples,
};

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
