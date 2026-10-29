export interface HashtagPackage {
  category: string;
  primary_hashtag: string;
  companion_variations: string[];
  hindi_devanagari_draft: string;
  meaning_hook_used: string;
  hinglish_translation: string;
}

export interface SplitWordHighlight {
  word: string;
  devanagari: string;
  meaning: string;
  formula: string;
}

export interface GenerateResponse {
  packages: HashtagPackage[];
  highlight: SplitWordHighlight | null;
  modelUsed: string;
}
