import rawDataset from '../data/indian_wedding_hashtags_template.json';
import {
  CoupleInputForm,
  CoupleSemanticAnalysis,
  CREATIVE_ARCHETYPES,
  CreativeArchetypeCategory,
  DatasetSchema,
  RetrievedExampleMatch,
  TrainingExample,
} from '../types/hashtag';

export const dataset = rawDataset as unknown as DatasetSchema;

function normalize(str: string): string {
  return (str || '').trim().toLowerCase();
}

function getCommonSuffix(nameA: string, nameB: string): string | null {
  const suffixes = ['preet', 'deep', 'jeet', 'inder', 'leen', 'neet', 'ika', 'isha', 'ya', 'ia'];
  const a = normalize(nameA);
  const b = normalize(nameB);
  for (const s of suffixes) {
    if (a.endsWith(s) && b.endsWith(s) && a !== b) {
      return `-${s}`;
    }
  }
  return null;
}

export function retrieveDynamicFewShotExamples(
  form: CoupleInputForm
): {
  topRelevant: RetrievedExampleMatch[];
  categoryRepresentatives: Record<CreativeArchetypeCategory, RetrievedExampleMatch[]>;
  combinedPromptExamples: RetrievedExampleMatch[];
} {
  const bFirst = normalize(form.bride.first_name);
  const bLast = normalize(form.bride.last_name);
  const bRoots = normalize(form.bride.cultural_roots);

  const gFirst = normalize(form.groom.first_name);
  const gLast = normalize(form.groom.last_name);
  const gRoots = normalize(form.groom.cultural_roots);

  const storyText = normalize(
    [
      form.couple_story_and_vibe,
      ...form.how_they_met,
      ...form.shared_obsessions,
      ...form.personality_dynamic,
      ...form.target_events,
    ].join(' ')
  );

  const sharedSuffix = getCommonSuffix(bFirst, gFirst);
  const sameInitial = bFirst && gFirst && bFirst[0] === gFirst[0] ? bFirst[0].toUpperCase() : null;
  const isSharedSurname =
    form.surname_strategy === 'shared_surname' || (bLast && gLast && bLast === gLast);
  const isCrossCultural =
    bRoots && gRoots && bRoots.split('/')[0].trim() !== gRoots.split('/')[0].trim();

  const scored: RetrievedExampleMatch[] = dataset.training_examples.map((ex: TrainingExample) => {
    let score = 0;
    const reasons: string[] = [];

    const exBFirst = normalize(ex.input_context.bride.first_name);
    const exBLast = normalize(ex.input_context.bride.last_name);
    const exBRoots = normalize(ex.input_context.bride.cultural_roots);

    const exGFirst = normalize(ex.input_context.groom.first_name);
    const exGLast = normalize(ex.input_context.groom.last_name);
    const exGRoots = normalize(ex.input_context.groom.cultural_roots);

    const exStory = normalize(ex.input_context.couple_story_and_vibe);
    const exPattern = normalize(ex.target_output.reusable_pattern_schema);

    if (bFirst && (exBFirst === bFirst || exGFirst === bFirst)) {
      score += 45;
      reasons.push(`Exact first-name match (${form.bride.first_name})`);
    }
    if (gFirst && (exGFirst === gFirst || exBFirst === gFirst)) {
      score += 45;
      reasons.push(`Exact first-name match (${form.groom.first_name})`);
    }
    if (bLast && (exBLast === bLast || exGLast === bLast)) {
      score += 35;
      reasons.push(`Shared surname hook (${form.bride.last_name})`);
    }
    if (gLast && (exGLast === gLast || exBLast === gLast)) {
      score += 35;
      reasons.push(`Shared surname hook (${form.groom.last_name})`);
    }

    if (isSharedSurname && exBLast === exGLast) {
      score += 30;
      reasons.push(
        `Shared surname strategy (${ex.input_context.bride.last_name} weds ${ex.input_context.groom.last_name})`
      );
    }

    if (sharedSuffix && exPattern.includes(sharedSuffix)) {
      score += 30;
      reasons.push(`Shared name suffix pattern (${sharedSuffix})`);
    }
    if (
      bFirst.length >= 3 &&
      exBFirst.length >= 3 &&
      (bFirst.slice(0, 3) === exBFirst.slice(0, 3) || bFirst.slice(-3) === exBFirst.slice(-3)) &&
      bFirst !== exBFirst
    ) {
      score += 18;
      reasons.push(`Bride phonetic syllable similarity (${ex.input_context.bride.first_name})`);
    }
    if (
      gFirst.length >= 3 &&
      exGFirst.length >= 3 &&
      (gFirst.slice(0, 3) === exGFirst.slice(0, 3) || gFirst.slice(-3) === exGFirst.slice(-3)) &&
      gFirst !== exGFirst
    ) {
      score += 18;
      reasons.push(`Groom phonetic syllable similarity (${ex.input_context.groom.first_name})`);
    }

    if (sameInitial && exBFirst[0] === exGFirst[0] && exBFirst[0] === sameInitial.toLowerCase()) {
      score += 22;
      reasons.push(`Shared ${sameInitial}-initial alliteration bridge`);
    }

    const rootTokens = [
      'punjabi',
      'sikh',
      'gujarati',
      'marwari',
      'rajasthani',
      'south indian',
      'tamil',
      'telugu',
      'malayali',
      'kannada',
      'maharashtrian',
      'bengali',
      'urdu',
      'muslim',
      'sindhi',
    ];
    for (const token of rootTokens) {
      if (
        (bRoots.includes(token) || gRoots.includes(token)) &&
        (exBRoots.includes(token) || exGRoots.includes(token))
      ) {
        score += 12;
        reasons.push(`Cultural roots match (${token})`);
        break;
      }
    }

    if (
      isCrossCultural &&
      (exStory.includes('cross-cultural') ||
        exPattern.includes('inter-state') ||
        exBRoots !== exGRoots)
    ) {
      score += 14;
      reasons.push('Cross-cultural fusion dynamic');
    }

    // Score matches against How They Met, Shared Interests, Personality, Story & Events
    if (storyText) {
      const storyWords = storyText
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4);
      for (const word of storyWords) {
        if (exStory.includes(word) || exPattern.includes(word)) {
          score += 10;
          reasons.push(`Story/interest match (${word})`);
          break;
        }
      }
    }

    if (reasons.length === 0) {
      reasons.push(`Archetype benchmark (${ex.category})`);
    }

    return {
      example: ex,
      score,
      match_reasons: Array.from(new Set(reasons)),
    };
  });

  // Sort all 50 reference examples by relevance score descending
  const sortedAll = [...scored].sort((a, b) => b.score - a.score);

  const topRelevant = sortedAll.slice(0, 10);

  const categoryRepresentatives = {} as Record<CreativeArchetypeCategory, RetrievedExampleMatch[]>;
  for (const arch of CREATIVE_ARCHETYPES) {
    const catMatches = sortedAll.filter((m) => m.example.category === arch.id);
    categoryRepresentatives[arch.id] = catMatches;
  }

  // Pass ALL 50 reference examples in combinedPromptExamples
  return {
    topRelevant,
    categoryRepresentatives,
    combinedPromptExamples: sortedAll,
  };
}

function splitIntoTwoHalves(
  name: string,
  subwordParts?: { part: string }[]
): { firstHalf: string; secondHalf: string } {
  const clean = (name || '').trim();
  if (subwordParts && subwordParts.length >= 2 && subwordParts[0].part && subwordParts[1].part) {
    return {
      firstHalf: subwordParts[0].part.trim(),
      secondHalf: subwordParts[1].part.trim(),
    };
  }
  if (clean.length <= 3) {
    return {
      firstHalf: clean.slice(0, 2),
      secondHalf: clean.slice(1),
    };
  }
  const mid = Math.ceil(clean.length / 2);
  return {
    firstHalf: clean.slice(0, mid),
    secondHalf: clean.slice(mid),
  };
}

export function buildSystemPromptWithTaxonomy(): string {
  const tax = dataset.creative_reasoning_taxonomy;
  return `${dataset.llm_system_prompt_template}

=== CORE DESIGN PHILOSOPHY ===
${dataset.dataset_metadata.core_design_philosophy}

=== MANDATORY HINDI-FIRST GENERATION WORKFLOW (CRITICAL FOR GRAMMAR & NATURAL FLOW) ===
For EVERY hashtag you generate, you MUST follow this exact two-stage linguistic process:
1. STAGE 1 — Compose in Pure Hindi (Devanagari) First:
   - First construct the complete wedding phrase or sentence in natural, idiomatic Hindi (Devanagari script).
   - Say the Hindi sentence aloud mentally as a native Hindi speaker to verify that the word order, postpositions (का/के/की, में, से, संग), gender agreement, and verb tenses are 100% grammatically correct.
2. STAGE 2 — Convert the Verified Hindi Phrase into a Hinglish Hashtag:
   - Only AFTER confirming the Hindi sentence is grammatically sound and natural, transliterate it into Roman Hinglish (CamelCase) and embed the exact spelling of the Bride's and Groom's names, sub-words, split-words, or surnames.

=== MANDATORY SPLIT-WORD HASHTAG METHODOLOGY & FEW-SHOT EXAMPLES ===
What is a "Split-Word" in Indian Wedding Hashtags?
- Take the Bride's First Name and split it into two halves: [Bride_Half1] + [Bride_Half2]. (You may also test natural syllable splits such as 2-letter/3-letter prefix + remaining suffix).
- Take the Groom's First Name and split it into two halves: [Groom_Half1] + [Groom_Half2].
- Test all 4 cross-half combinations to see if any combination forms (or sounds phonetically like) a REAL Hindi / Hinglish / Urdu / Sanskrit word with a clear meaning:
  1. [Bride_Half1] + [Groom_Half1] (First half of Bride + First half of Groom)
  2. [Bride_Half1] + [Groom_Half2] (First half of Bride + Second half of Groom)
  3. [Groom_Half1] + [Bride_Half1] (First half of Groom + First half of Bride)
  4. [Groom_Half1] + [Bride_Half2] (First half of Groom + Second half of Bride)
- If ANY of these combinations forms a meaningful Hinglish word, you MUST generate hashtags centered around that split-word in a grammatically valid Hindi sentence!

FEW-SHOT EXAMPLES OF SPLIT-WORD HASHTAGS (Study the Reasoning — Do NOT copy for unrelated names):
• Split-Word Example 1 (Combo 1: First Half of Bride + First Half of Groom):
  - Bride: "Manisha" -> Split: "Man" (1st half) + "isha" (2nd half)
  - Groom: "Natesh" -> Split: "Nat" (1st half) + "esh" (2nd half)
  - 4-Way Check: "Man" + "Nat" = "Mannat" (मन्नत = Sacred wish / answered prayer in Hindi/Urdu!).
  - Hindi-First Draft: "पूरी हुई हमारी मन्नत" / "मनीषा और नतेश की मन्नत"
  - Resulting Split-Word Hashtags: #PuriHuiHamariMannat, #ManishaNateshKiMannat

• Split-Word Example 2 (Combo 2: First Half of Bride + Second Half of Groom):
  - Bride: "Bandana" -> Split: "Ban" (1st half) + "dana" (2nd half)
  - Groom: "Vardhan" -> Split: "Var" (1st half) + "dhan" (2nd half)
  - 4-Way Check: "Ban" + "dhan" = "Bandhan" (बंधन = Sacred bond of marriage in Hindi!).
  - Hindi-First Draft: "प्यार का पावन बंधन" / "जनम जनम का बंधन"
  - Resulting Split-Word Hashtags: #PyaarKaPaawanBandhan, #JanamJanamKaBanDhan

• Split-Word Example 3 (Combo 3: First Half of Groom + First Half of Bride):
  - Bride: "Barsha" -> Split: "Bar" (1st half) + "sha" (2nd half)
  - Groom: "Dilip" -> Split: "Dil" (1st half) + "ip" (2nd half)
  - 4-Way Check: "Dil" + "Bar" = "Dilbar" (दिलबर = Beloved sweetheart in Hindi/Urdu!).
  - Hindi-First Draft: "मिल गए दो दिलबर" / "दिलिप की दिलबर बरषा"
  - Resulting Split-Word Hashtags: #MilGayeDoDilbar, #DilipKiDilBar

• Split-Word Example 4 (Combo 4: First Half of Groom + Second Half of Bride):
  - Bride: "Poonam" -> Split: "Poo" (1st half) + "nam" (2nd half)
  - Groom: "Sanat" -> Split: "Sa" (1st half) + "nat" (2nd half)
  - 4-Way Check: "Sa" + "nam" = "Sanam" (सनम = Beloved soulmate in Hindi/Urdu!).
  - (Another Combo 4 illustration: Groom "Sourabh" ["Sou"/"So" + "rabh"] & Bride "Jyoti" ["Jyo" + "ti"] -> "So" + "ti" = "Soti" [सोती = sleeping] -> "सौरभ की ज्योति नहीं सोती" -> #SourabhKiJyotiNahiSoti).
  - Hindi-First Draft: "सात जन्मों के सनम"
  - Resulting Split-Word Hashtags: #SaatJanmonKeSanam, #MilGayeDoSanam

=== STRICT GUIDELINES: WHAT MAKES A GOOD ANSWER VS. A BAD ANSWER ===

✅ WHAT MAKES A GOOD ANSWER (Follow These Patterns):
1. Meaningful Split-Word Fusion:
   - Combining a half of the Bride's name and a half of the Groom's name into a real Hinglish word (like Mannat, Bandhan, Dilbar, Sanam, Milan, Raha, Nibaha, etc.) and building a natural Hindi sentence around it.
2. Dual-Name Semantic & Auspicious Harmony:
   - When the Bride's name/sub-word and/or Groom's name/sub-word are real Hindi/Sanskrit/Urdu/regional words (such as words meaning auspicious, divine, sacred light, love, joy, promise, soul, etc.), weave both partners' names/sub-words into a classic, meaningful Hindi wedding blessing or celebratory phrase (using natural connectors like Mangal, Milan, Sangam, Bandhan, Saath, Pyaar, Ishq, Ki/Ke/Ka).
3. Grammatically Exact Phonetic Substitution:
   - When a partner's name, sub-word, or surname sounds phonetically like a Hindi word or verb phrase, identify the ENTIRE Hindi grammatical unit it sounds like and replace that entire unit cleanly without conflicting auxiliary verbs.
4. Parameter-Controlled Personalization With Names Included:
   - Actively weave the user's selected "How They Met", "Shared Interests", "Personality", "About the Couple / Custom Story", "Wedding Events", and "Vibe & Tone" into the hashtags while ALWAYS embedding the Bride's and/or Groom's actual names or split-words in the tag.

❌ WHAT MAKES A BAD ANSWER (Strictly Forbidden — Never Output These):
1. Broken Hindi Grammar or Verb-Tense Collisions (REJECT):
   - NEVER combine two conflicting verb tenses or leave a dangling auxiliary verb when doing a phonetic pun! For instance, if a name/surname phonetically represents a continuous verb phrase, do NOT place a past-tense auxiliary verb immediately after it. Read the underlying Hindi sentence WITHOUT the pun first—if a native speaker would never say that Hindi sentence because two verbs/tenses clash, reject or fix it immediately.
2. Generic Story/Event Hashtags Without the Couple's Names (REJECT):
   - NEVER output a hashtag that only describes how they met, their school/college, their hobbies, or the wedding venue without including the Bride's or Groom's actual name, sub-word, split-word, or surname. A tag with zero couple names is unusable.
3. Hallucinated Nicknames or Synonym Replacements (REJECT):
   - If the user did NOT provide a nickname for the Bride or Groom, NEVER invent a random nickname (such as "Sunny", "Raju", "Poo", "Chintu", etc.) that does not exist in their input! Only use the exact First Name, Last Name, and Nickname provided by the user, or direct sub-words/split-words extracted from the letters of their given names.
   - NEVER replace a partner's name with an external dictionary synonym.
4. Random Unconnected Words Tacked Onto Names (REJECT):
   - NEVER simply concatenate the couple's names with random party/drinking nouns or slang words that have no grammatical or semantic relationship to the names.

=== 5-PILLAR CREATIVE REASONING TAXONOMY ===
1. Bilingual Semantic Synthesis:
   - Definition: ${tax['1_bilingual_semantic_synthesis'].definition}
   - Why It Beats Mere Wordplay: ${tax['1_bilingual_semantic_synthesis'].why_it_beats_mere_wordplay}

2. Narrative & Personality Anchoring:
   - Definition: ${tax['2_narrative_and_personality_anchoring'].definition}
   - Why It Beats Mere Wordplay: ${tax['2_narrative_and_personality_anchoring'].why_it_beats_mere_wordplay}

3. Phonetic Climax Subversion:
   - Definition: ${tax['3_phonetic_climax_subversion'].definition}
   - Why It Beats Mere Wordplay: ${tax['3_phonetic_climax_subversion'].why_it_beats_mere_wordplay}

4. Cultural & Ritual Contextualization:
   - Definition: ${tax['4_cultural_and_ritual_contextualization'].definition}
   - Why It Beats Mere Wordplay: ${tax['4_cultural_and_ritual_contextualization'].why_it_beats_mere_wordplay}

5. Safety & Usability Guardrails:
   - Lowercase Trap Check: ${tax['5_safety_and_usability_guardrails'].lowercase_trap_check}
   - Father-in-Law & Emcee Test: ${tax['5_safety_and_usability_guardrails'].father_in_law_and_emcee_test}
   - Character Budget: ${tax['5_safety_and_usability_guardrails'].character_budget}`;
}

export function buildFewShotUserPrompt(
  form: CoupleInputForm,
  retrievedExamples: RetrievedExampleMatch[],
  semanticAnalysis?: CoupleSemanticAnalysis
): string {
  const vibeLabels = [
    'Poetic & Traditional (soulful Hindi/Urdu/Sanskrit meanings, auspicious blessings, sacred union, warm elder-approved romance)',
    'Witty & Punny (clever bilingual wordplay, smart split-words, surname & sub-word double-entendres)',
    'Filmy Bollywood (iconic movie hooks, dramatic Hindi dialogue twists, and romantic song phrases woven with the couple’s names)',
    'Unfiltered Party (high-energy festive Sangeet/Cocktail/Baraat celebration woven grammatically with the couple’s names)',
  ];

  const surnameStrategyDescriptions: Record<string, string> = {
    bride_takes_groom: `Bride (${form.bride.first_name} ${form.bride.last_name}) is taking Groom's surname (${form.groom.last_name}).`,
    keep_own: `Both partners keep their own surnames (${form.bride.last_name} & ${form.groom.last_name}) — focus on first-name/sub-word/split-word bridges and dual-name union.`,
    shared_surname: `Both partners share the surname "${form.groom.last_name || form.bride.last_name}" — you may use their shared surname ONLY if the resulting Hindi sentence is 100% grammatically valid, and prioritize blending their first names/sub-words/split-words (${form.bride.first_name} & ${form.groom.first_name}).`,
    first_names_only: `Focus strictly on First Names (${form.bride.first_name} & ${form.groom.first_name})${form.bride.nickname || form.groom.nickname ? ` and provided Nicknames (${form.bride.nickname || 'None'} & ${form.groom.nickname || 'None'})` : ''}.`,
  };

  const bHalves = splitIntoTwoHalves(
    form.bride.first_name,
    semanticAnalysis?.bride_meaning?.subword_parts
  );
  const gHalves = splitIntoTwoHalves(
    form.groom.first_name,
    semanticAnalysis?.groom_meaning?.subword_parts
  );

  const combo1 = `${bHalves.firstHalf}${gHalves.firstHalf.toLowerCase()}`;
  const combo2 = `${bHalves.firstHalf}${gHalves.secondHalf.toLowerCase()}`;
  const combo3 = `${gHalves.firstHalf}${bHalves.firstHalf.toLowerCase()}`;
  const combo4 = `${gHalves.firstHalf}${bHalves.secondHalf.toLowerCase()}`;

  // Pass all 50 reference examples from indian_wedding_hashtags_template.json
  const allExamples = (
    retrievedExamples.length >= dataset.training_examples.length
      ? retrievedExamples.map((m) => m.example)
      : dataset.training_examples
  ).map((ex) => ({
    id: ex.id,
    category: ex.category,
    input_context: ex.input_context,
    creative_chain_of_thought: ex.creative_chain_of_thought,
    target_output: ex.target_output,
    contrastive_evaluation: ex.contrastive_evaluation,
  }));

  const splitWordSection = `
=== 4-WAY SPLIT-WORD COMBINATION MATRIX FOR ${form.bride.first_name.toUpperCase()} & ${form.groom.first_name.toUpperCase()} ===
Bride Name Split: "${form.bride.first_name}" -> First Half = "${bHalves.firstHalf}", Second Half = "${bHalves.secondHalf}"
Groom Name Split: "${form.groom.first_name}" -> First Half = "${gHalves.firstHalf}", Second Half = "${gHalves.secondHalf}"
(Also check slight 2-letter / 3-letter syllable boundary adjustments of "${form.bride.first_name}" and "${form.groom.first_name}"!)

Test these 4 Cross-Half Combinations:
1. First Half of Bride + First Half of Groom ("${bHalves.firstHalf}" + "${gHalves.firstHalf}") = "${combo1}"
2. First Half of Bride + Second Half of Groom ("${bHalves.firstHalf}" + "${gHalves.secondHalf}") = "${combo2}"
3. First Half of Groom + First Half of Bride ("${gHalves.firstHalf}" + "${bHalves.firstHalf}") = "${combo3}"
4. First Half of Groom + Second Half of Bride ("${gHalves.firstHalf}" + "${bHalves.secondHalf}") = "${combo4}"
${
  semanticAnalysis?.split_word_combinations && semanticAnalysis.split_word_combinations.length > 0
    ? `\nStep 1 Linguistic Evaluation of Split-Word Combinations:\n${semanticAnalysis.split_word_combinations
        .map(
          (sw) =>
            `   • [${sw.formula}] -> "${sw.combined_word}" | Meaningful Hinglish Word: ${
              sw.is_meaningful_hinglish_word ? 'YES' : 'NO'
            } (${sw.hinglish_meaning})${
              sw.suggested_hashtag ? ` -> Example: ${sw.suggested_hashtag}` : ''
            }`
        )
        .join('\n')}`
    : ''
}
CRITICAL INSTRUCTION FOR SPLIT-WORDS:
- Check if ANY of the 4 combinations above (or a 2-to-3 letter syllable adjustment of them) forms or sounds phonetically like a real Hindi/Hinglish word with meaning.
- If YES, you MUST generate at least 6 to 8 hashtags in your 30-hashtag batch that use that meaningful split-word inside a grammatically natural Hindi-first sentence!
- Even if a combination is a pure portmanteau name-blend rather than a dictionary word, include a few catchy Hinglish wedding phrases built around the best-sounding split-word fusion of ${form.bride.first_name} & ${form.groom.first_name}.
`;

  const semanticSection = semanticAnalysis
    ? `
=== NAME MEANINGS & SUB-WORD DECOMPOSITION ===
1. Bride Name Analysis (${semanticAnalysis.bride_meaning.name} — Language: ${semanticAnalysis.bride_meaning.language}):
   • Discovered Meanings (Use as context; always keep ${semanticAnalysis.bride_meaning.name} or its sub-words/split-words in the hashtag):
     1) ${semanticAnalysis.bride_meaning.top_3_meanings[0]}
     2) ${semanticAnalysis.bride_meaning.top_3_meanings[1]}
     3) ${semanticAnalysis.bride_meaning.top_3_meanings[2]}
   • Sub-Word & Syllable Split of "${semanticAnalysis.bride_meaning.name}":
     ${(semanticAnalysis.bride_meaning.subword_parts || []).map((p) => `- "${p.part}" (${p.devanagari || ''}): ${p.hindi_meaning}`).join('\n     ')}

2. Groom Name Analysis (${semanticAnalysis.groom_meaning.name} — Language: ${semanticAnalysis.groom_meaning.language}):
   • Discovered Meanings (Use as context; always keep ${semanticAnalysis.groom_meaning.name} or its sub-words/split-words in the hashtag):
     1) ${semanticAnalysis.groom_meaning.top_3_meanings[0]}
     2) ${semanticAnalysis.groom_meaning.top_3_meanings[1]}
     3) ${semanticAnalysis.groom_meaning.top_3_meanings[2]}
   • Sub-Word & Syllable Split of "${semanticAnalysis.groom_meaning.name}":
     ${(semanticAnalysis.groom_meaning.subword_parts || []).map((p) => `- "${p.part}" (${p.devanagari || ''}): ${p.hindi_meaning}`).join('\n     ')}

3. Initial Hindi-First Sub-Word & Semantic Ideas for ${semanticAnalysis.bride_meaning.name} & ${semanticAnalysis.groom_meaning.name}:
   • ${(semanticAnalysis.cross_subword_fusions || []).map((f) => `${f.example_hinglish_tag} (${f.formula} -> ${f.hindi_meaning})`).join('\n   • ')}
   • ${semanticAnalysis.semantic_bridges.join('\n   • ')}
`
    : '';

  return `Generate AT LEAST 30 ORIGINAL, GRAMMATICALLY FLAWLESS Indian wedding hashtag packages (return 30 distinct items in the JSON array) for the following couple. A second Judge LLM will score all 30 candidates on Virality, Uniqueness, Grammar Correctness, Hinglish Usage, and Name Presence:

=== COUPLE INPUT CONTEXT & ACTIVE SELECTION PARAMETERS ===
- Bride:
  • First Name: ${form.bride.first_name} (Language: ${form.bride.name_language || 'Hindi'})
  • Last Name: ${form.bride.last_name}
  • Nickname: ${form.bride.nickname ? form.bride.nickname : 'NONE PROVIDED — DO NOT invent any random nickname; only use "' + form.bride.first_name + '", "' + form.bride.last_name + '", or sub-words/split-words of "' + form.bride.first_name + '"'}
  • Cultural Roots: ${form.bride.cultural_roots}
- Groom:
  • First Name: ${form.groom.first_name} (Language: ${form.groom.name_language || 'Hindi'})
  • Last Name: ${form.groom.last_name}
  • Nickname: ${form.groom.nickname ? form.groom.nickname : 'NONE PROVIDED — DO NOT invent any random nickname; only use "' + form.groom.first_name + '", "' + form.groom.last_name + '", or sub-words/split-words of "' + form.groom.first_name + '"'}
  • Cultural Roots: ${form.groom.cultural_roots}
- Surname Preference: ${surnameStrategyDescriptions[form.surname_strategy]}
- How They Met: ${form.how_they_met.length > 0 ? form.how_they_met.join(', ') : 'Not specified'}
- Shared Interests: ${form.shared_obsessions.length > 0 ? form.shared_obsessions.join(', ') : 'Not specified'}
- Personality Dynamic: ${form.personality_dynamic.length > 0 ? form.personality_dynamic.join(', ') : 'Not specified'}
- About the Couple / Custom Story (Open Text): ${form.couple_story_and_vibe ? form.couple_story_and_vibe : 'Not specified — focus on their names, meanings, split-words, and selected vibe.'}
- Target Wedding Events: ${form.target_events.join(', ') || 'All Events'}
- Desired Vibe & Tone (MUST CONTROL OVERALL TONE): ${vibeLabels[form.vibe_slider]}
${splitWordSection}${semanticSection}
=== HOW YOUR 30 GENERATED HASHTAGS MUST BE CONTROLLED BY THE PARAMETERS ABOVE ===
Distribute your 30 generated hashtags across these buckets while matching the Desired Vibe & Tone (${vibeLabels[form.vibe_slider]}):
1. Bucket 1 — Split-Word & Cross-Syllable Fusion Hashtags (6 to 8 hashtags):
   - Use the 4-way split-word combinations ([Bride_Half1 + Groom_Half1], [Bride_Half1 + Groom_Half2], [Groom_Half1 + Bride_Half1], [Groom_Half1 + Bride_Half2])—especially any combination that forms a real Hinglish word with meaning—inside a natural Hindi sentence.
2. Bucket 2 — Dual-Name Meaning & Auspicious Harmony Hashtags (6 to 8 hashtags):
   - Weave ${form.bride.first_name} and ${form.groom.first_name} (or their meaningful sub-words) into authentic Hindi wedding blessings and romantic phrases.
3. Bucket 3 — "How They Met", "Shared Interests", "Personality" & "About the Couple / Custom Story" Hashtags (6 to 8 hashtags):
   - If the user selected or typed anything in How They Met (${form.how_they_met.join(', ') || 'None'}), Shared Interests (${form.shared_obsessions.join(', ') || 'None'}), Personality (${form.personality_dynamic.join(', ') || 'None'}), or About the Couple (${form.couple_story_and_vibe || 'None'}), directly weave those themes into Hindi-first Hinglish hashtags that ALSO explicitly contain ${form.bride.first_name} and/or ${form.groom.first_name}'s names or split-words! (Never omit the couple's names!).
4. Bucket 4 — "Wedding Events" & "Vibe & Tone" Hashtags (5 to 6 hashtags):
   - Tailor hashtags specifically to the selected Wedding Events (${form.target_events.join(', ') || 'All Events'}) and Desired Vibe & Tone (${vibeLabels[form.vibe_slider]}), always embedding the couple's names.
5. Bucket 5 — Surname & Phonetic Wordplay Hashtags (4 to 5 hashtags):
   - Follow the Surname Preference (${surnameStrategyDescriptions[form.surname_strategy]}) with 100% grammatically accurate Hindi verb-tense agreement.

=== COMPLETE 50 REFERENCE EXAMPLES FROM DATASET (FOR CREATIVE REASONING & QUALITY BENCHMARKING) ===
Study all ${allExamples.length} reference examples below to understand how syllables, meanings, surnames, and Hindi/Hinglish wordplay are crafted. Do NOT copy these example hashtags literally—create bespoke hashtags for ${form.bride.first_name} & ${form.groom.first_name}:
${JSON.stringify(allExamples, null, 2)}

=== MANDATORY HINDI-FIRST GENERATION & SELF-CHECK INSTRUCTIONS (FOR ALL 30 CANDIDATES) ===
For EACH of the 30 hashtags you generate, you MUST execute these steps in order:
1. "hindi_devanagari_draft": Write the complete wedding phrase in pure Devanagari Hindi FIRST.
2. "grammar_and_name_audit": Audit your Devanagari Hindi phrase against these 4 strict rules before converting to Hinglish:
   - Rule A (Natural Hindi Grammar & Verb Tense): Is the Hindi sentence 100% grammatically correct? If a name or surname ("${form.bride.first_name}", "${form.groom.first_name}", "${form.bride.last_name}", "${form.groom.last_name}") is used phonetically in place of a Hindi verb or phrase, does it replace the ENTIRE verb phrase cleanly without leaving a conflicting tense word or auxiliary verb next to it? (Never mix continuous and past tense verbs in the same phrase!)
   - Rule B (Mandatory Couple Name / Split-Word Inclusion): Does the hashtag explicitly contain the Bride's and/or Groom's actual name, sub-word, valid split-word, or surname? (NEVER generate a generic story/event hashtag without their names!)
   - Rule C (No Hallucinated Nicknames): Did you use ONLY the names/sub-words/split-words/surnames actually provided in the input context (with zero invented pet names)?
   - Rule D (Meaningful Connection): Do all words in the phrase form a coherent, celebratory wedding expression or blessing that reflects their selected parameters?
3. "primary_hashtag": Transliterate the verified Hindi phrase into a clean CamelCase Hinglish hashtag (starting with "#") that preserves the recognizable spelling of ${form.bride.first_name} and ${form.groom.first_name}'s names/sub-words/split-words/surnames.
4. "hinglish_translation": Show the exact Devanagari Hindi phrase, its Roman Hinglish reading, and its clear English meaning.
5. "meaning_hook_used": Show the exact name/sub-word/split-word formula used (e.g., "Split-Word: [Bride_Half1] + [Groom_Half1] = [Word] -> [Meaning]" or "[Name 1] + [Connector] + [Name 2]").`;
}
