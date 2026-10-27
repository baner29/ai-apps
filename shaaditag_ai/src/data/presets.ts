import { CoupleInputForm } from '../types/hashtag';

export interface SampleCouplePreset {
  id: string;
  label: string;
  subtitle: string;
  highlightTag: string;
  exampleId: number;
  form: CoupleInputForm;
}

export const SAMPLE_COUPLE_PRESETS: SampleCouplePreset[] = [
  {
    id: 'jyoti-sourabh',
    label: 'Jyoti & Sourabh — Hinglish Sub-Word & Meaning',
    subtitle: 'Splits Sourabh (Sou=100 + Rabh=God) & Jyoti (Jyot=Flame + ti) into #JyotJaliSourabhKGharMe & #SouJyotKhushiK',
    highlightTag: '#JyotJaliSourabhKGharMe',
    exampleId: 2,
    form: {
      bride: {
        first_name: 'Jyoti',
        last_name: 'Sharma',
        nickname: 'Jyo',
        cultural_roots: 'North Indian / Hindi-speaking',
        name_language: 'Hindi',
      },
      groom: {
        first_name: 'Sourabh',
        last_name: 'Verma',
        nickname: 'Sou',
        cultural_roots: 'North Indian / Hindi-speaking',
        name_language: 'Hindi',
      },
      surname_strategy: 'bride_takes_groom',
      how_they_met: ['College Besties'],
      shared_obsessions: ['90s Bollywood', 'Chai & Street Food', 'Travel'],
      personality_dynamic: ['Hopeless Romantics', 'Jokester & Calm Anchor'],
      couple_story_and_vibe:
        'College sweethearts celebrating a warm, joyful wedding with family and friends.',
      target_events: ['All Events', 'Haldi', 'Sangeet', 'Pheras/Anand Karaj/Nikah'],
      vibe_slider: 0,
    },
  },
  {
    id: 'subaha-nitin',
    label: 'Subaha & Nitin — Semantic Word-Bridge',
    subtitle: 'Fuses "Ni" + "baha" into #Nibaha (fulfilling vows)',
    highlightTag: '#Nibaha',
    exampleId: 1,
    form: {
      bride: {
        first_name: 'Subaha',
        last_name: 'Khan',
        nickname: 'Subu',
        cultural_roots: 'North Indian / Urdu-speaking',
        name_language: 'Hindi',
      },
      groom: {
        first_name: 'Nitin',
        last_name: 'Verma',
        nickname: 'Nitu',
        cultural_roots: 'North Indian / Hindi-speaking',
        name_language: 'Hindi',
      },
      surname_strategy: 'keep_own',
      how_they_met: ['Long-Distance/NRI', 'College Besties'],
      shared_obsessions: ['90s Bollywood', 'Travel'],
      personality_dynamic: ['Hopeless Romantics'],
      couple_story_and_vibe:
        'Long-term couple who stood by each other through thick and thin before tying the knot in an emotional cross-cultural ceremony.',
      target_events: ['All Events', 'Nikah', 'Sangeet', 'Pheras/Anand Karaj/Nikah'],
      vibe_slider: 0,
    },
  },
  {
    id: 'ridhima-kunal',
    label: 'Ridhima & Kunal Gogna — Idiom Pun',
    subtitle: 'Subverts "Ready, Set, Go!" into #RidhiSetGogna',
    highlightTag: '#RidhiSetGogna',
    exampleId: 12,
    form: {
      bride: {
        first_name: 'Ridhima',
        last_name: 'Chopra',
        nickname: 'Ridhi',
        cultural_roots: 'Punjabi',
        name_language: 'Hindi',
      },
      groom: {
        first_name: 'Kunal',
        last_name: 'Gogna',
        nickname: 'Kunu',
        cultural_roots: 'Punjabi',
        name_language: 'Hindi',
      },
      surname_strategy: 'bride_takes_groom',
      how_they_met: ['Childhood Friends'],
      shared_obsessions: ['Travel', '90s Bollywood'],
      personality_dynamic: ['Dance-Floor Competitors'],
      couple_story_and_vibe:
        'High-energy couple who love travel, adventure, and action-packed celebrations.',
      target_events: ['All Events', 'Roka/Engagement', 'Sangeet', 'Baraat'],
      vibe_slider: 1,
    },
  },
  {
    id: 'charvi-ranbir',
    label: 'Charvi & Ranbir — Foodie/Party Vibe',
    subtitle: 'Maps "-bir" (Beer) & "Cha-" (Chakna) into #TuBeerMaiChakna',
    highlightTag: '#TuBeerMaiChakna',
    exampleId: 41,
    form: {
      bride: {
        first_name: 'Charvi',
        last_name: 'Sood',
        nickname: 'Chakna / Charu',
        cultural_roots: 'Punjabi / Delhi',
        name_language: 'Hindi',
      },
      groom: {
        first_name: 'Ranbir',
        last_name: 'Bedi',
        nickname: 'Beer / Bir',
        cultural_roots: 'Punjabi',
        name_language: 'Hindi',
      },
      surname_strategy: 'bride_takes_groom',
      how_they_met: ['Dating App'],
      shared_obsessions: ['Craft Beer & Chakna', 'Foodies'],
      personality_dynamic: ['Chill vs. Energetic', 'Dance-Floor Competitors'],
      couple_story_and_vibe:
        'Party-loving foodie couple who bonded over craft beer and bar snacks on their first date.',
      target_events: ['Cocktail Party', 'Sangeet', 'Haldi', 'All Events'],
      vibe_slider: 3,
    },
  },
];

export const CULTURAL_ROOTS_OPTIONS = [
  'Punjabi',
  'Punjabi Sikh',
  'Punjabi / Delhi',
  'Gujarati',
  'Marwari / Rajasthani',
  'North Indian / Hindi-speaking',
  'North Indian / Urdu-speaking',
  'South Indian / Tamil',
  'South Indian / Telugu',
  'South Indian / Malayali',
  'South Indian / Kannada',
  'Konkani / South Indian',
  'Maharashtrian',
  'Bengali',
  'Sindhi / Punjabi',
  'Hyderabadi / Lucknowi Muslim',
  'Kashmiri',
  'Baniya / Agarwal',
];

export const HOW_THEY_MET_CHIPS = [
  'Dating App',
  'College Besties',
  'Childhood Friends',
  'Long-Distance/NRI',
  'Arranged-to-Love',
  'High-School Sweethearts',
  'Family Introduction',
];

export const SHARED_OBSESSIONS_CHIPS = [
  '90s Bollywood',
  'Craft Beer & Chakna',
  'Netflix',
  'Travel',
  'Foodies',
  'Chai & Street Food',
  'Photography & Aesthetics',
];

export const PERSONALITY_DYNAMIC_CHIPS = [
  'Chill vs. Energetic',
  'Dance-Floor Competitors',
  'Hopeless Romantics',
  'Jokester & Calm Anchor',
  'Total Siyapa / Chaos Lovers',
];

export const TARGET_EVENT_OPTIONS = [
  'All Events',
  'Roka/Engagement',
  'Haldi',
  'Mehendi',
  'Sangeet',
  'Cocktail Party',
  'Baraat',
  'Pheras/Anand Karaj/Nikah',
];

export const VIBE_SLIDER_LABELS: {
  level: 0 | 1 | 2 | 3;
  title: string;
  subtitle: string;
  tagExample: string;
}[] = [
  {
    level: 0,
    title: 'Poetic & Traditional',
    subtitle: 'Soulful Hindi/Urdu/Sanskrit meanings & elder-approved grace',
    tagExample: '#Nibaha · #DoDilSameRuh',
  },
  {
    level: 1,
    title: 'Witty & Punny',
    subtitle: 'Crisp English idioms, surname double-entendres & clever hooks',
    tagExample: '#RidhiSetGogna · #NoLongerSinghal',
  },
  {
    level: 2,
    title: 'Filmy Bollywood',
    subtitle: 'Iconic 90s/2000s movie titles, Sangeet drama & chartbuster hooks',
    tagExample: '#GillTohPagalHai · #RabNeBanaDiRiya',
  },
  {
    level: 3,
    title: 'Unfiltered Party',
    subtitle: 'High-energy Cocktail, Baraat & after-party banter for the squad',
    tagExample: '#TuBeerMaiChakna · #TotalSiyaPa',
  },
];
