export interface LowercaseAuditResult {
  lowercaseTag: string;
  passed: boolean;
  warningReason?: string;
}

export interface LengthAuditResult {
  charCount: number;
  status: 'optimal' | 'acceptable' | 'long';
  label: string;
}

const AWKWARD_LOWERCASE_SUBSTRINGS = [
  'anus',
  'arse',
  'assh',
  'shit',
  'fuck',
  'crap',
  'piss',
  'dick',
  'cock',
  'boob',
  'slut',
  'whore',
  'fart',
  'poop',
];

export function auditLowercaseTrap(hashtag: string): LowercaseAuditResult {
  const clean = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  const lower = clean.toLowerCase();
  const body = lower.slice(1);

  for (const trap of AWKWARD_LOWERCASE_SUBSTRINGS) {
    if (body.includes(trap)) {
      return {
        lowercaseTag: lower,
        passed: false,
        warningReason: `Contains unintended word "${trap}" in lowercase (${lower}). Insert a ritual or verb separator!`,
      };
    }
  }

  return {
    lowercaseTag: lower,
    passed: true,
  };
}

export function auditHashtagLength(hashtag: string): LengthAuditResult {
  const clean = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  const len = clean.length;

  if (len <= 20) {
    return {
      charCount: len,
      status: 'optimal',
      label: `${len} chars · Easy for guests to type`,
    };
  }
  if (len <= 22) {
    return {
      charCount: len,
      status: 'acceptable',
      label: `${len} chars · Within 22-char budget`,
    };
  }
  return {
    charCount: len,
    status: 'long',
    label: `${len} chars · Consider shortening for mobile guests`,
  };
}

export function getInstagramTagUrl(hashtag: string): string {
  const tagWithoutHash = hashtag.replace(/^#+/, '').trim();
  return `https://www.instagram.com/explore/tags/${encodeURIComponent(tagWithoutHash)}/`;
}
