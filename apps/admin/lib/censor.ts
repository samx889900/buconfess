// ---------------------------------------------------------------------------
// Deterministic Abuse Term Censoring (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Censors known abuse terms in confession text before rendering/publishing.
// IMPORTANT: Only the rendered/published text is censored.
// The original raw confession is preserved in the database for admin/audit.
//
// Design:
//   - Case-insensitive matching
//   - Word-boundary-aware to avoid accidental substring replacement
//   - Preserves first and last character, replaces middle with asterisks
//   - Handles common punctuation/spacing variants
//   - Supports Hinglish/English abuse terms
// ---------------------------------------------------------------------------

interface AbusePattern {
  /** Regex pattern (case-insensitive, word-boundary-aware) */
  pattern: RegExp;
  /** Function that produces the censored replacement */
  replacer: (matched: string) => string;
}

/**
 * Censors a matched word: keeps first and last character, replaces middle with asterisks.
 * For 2-char words: first char + asterisk.
 * For 1-char words: returns asterisk.
 */
function censorWord(word: string): string {
  if (word.length <= 1) return '*';
  if (word.length === 2) return word[0] + '*';
  const middle = '*'.repeat(word.length - 2);
  return word[0] + middle + word[word.length - 1];
}

// ---------------------------------------------------------------------------
// Abuse Terms Registry
// ---------------------------------------------------------------------------
// Each entry uses word-boundary matching (\b) to prevent accidental censoring
// of innocent words. Patterns use [\s.\-_]* to handle common evasion tactics
// like "b h e n c h o d" or "b.c" etc.
//
// IMPORTANT: These patterns are carefully designed:
// - "bc" matches only standalone "bc" (not "abc", "because", etc.)
// - Longer terms match with optional spacing/punctuation between chars
// ---------------------------------------------------------------------------

const ABUSE_PATTERNS: AbusePattern[] = [
  // --- "bc" / "b c" (Hinglish abbreviation) ---
  {
    pattern: /\b(b[\s.\-_]*c)\b/gi,
    replacer: (m) => m[0] + '*',
  },
  // --- "mc" / "m c" (Hinglish abbreviation) ---
  {
    pattern: /\b(m[\s.\-_]*c)\b/gi,
    replacer: (m) => m[0] + '*',
  },
  // --- bhenchod / bhen chod and common variants ---
  {
    pattern: /\b(b[\s.\-_]*h[\s.\-_]*e[\s.\-_]*n[\s.\-_]*c[\s.\-_]*h[\s.\-_]*o[\s.\-_]*d(?:[\s.\-_]*i)?)\b/gi,
    replacer: (m) => {
      const clean = m.replace(/[\s.\-_]/g, '');
      return clean[0] + '*****' + clean[clean.length - 1];
    },
  },
  // --- madarchod / madar chod and common variants ---
  {
    pattern: /\b(m[\s.\-_]*a[\s.\-_]*d[\s.\-_]*a[\s.\-_]*r[\s.\-_]*c[\s.\-_]*h[\s.\-_]*o[\s.\-_]*d(?:[\s.\-_]*i)?)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- chutiya / chutiy and variants ---
  {
    pattern: /\b(c[\s.\-_]*h[\s.\-_]*u[\s.\-_]*t[\s.\-_]*i[\s.\-_]*y[\s.\-_]*(?:a|e|o|aa)?)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- gaand / gand ---
  {
    pattern: /\b(g[\s.\-_]*a[\s.\-_]*a?[\s.\-_]*n[\s.\-_]*d)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- lodu / laude / loda ---
  {
    pattern: /\b(l[\s.\-_]*(?:o[\s.\-_]*d[\s.\-_]*(?:u|e|a)|a[\s.\-_]*u[\s.\-_]*d[\s.\-_]*(?:e|a)))\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- randi ---
  {
    pattern: /\b(r[\s.\-_]*a[\s.\-_]*n[\s.\-_]*d[\s.\-_]*i)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- harami ---
  {
    pattern: /\b(h[\s.\-_]*a[\s.\-_]*r[\s.\-_]*a[\s.\-_]*m[\s.\-_]*i)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- "fuck" and variants ---
  {
    pattern: /\b(f[\s.\-_]*u[\s.\-_]*c[\s.\-_]*k(?:[\s.\-_]*(?:e[\s.\-_]*r|i[\s.\-_]*n[\s.\-_]*g|e[\s.\-_]*d))?)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- "shit" ---
  {
    pattern: /\b(s[\s.\-_]*h[\s.\-_]*i[\s.\-_]*t(?:[\s.\-_]*(?:t[\s.\-_]*y|t[\s.\-_]*e[\s.\-_]*r))?)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- "bitch" ---
  {
    pattern: /\b(b[\s.\-_]*i[\s.\-_]*t[\s.\-_]*c[\s.\-_]*h(?:[\s.\-_]*(?:e[\s.\-_]*s))?)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- "asshole" ---
  {
    pattern: /\b(a[\s.\-_]*s[\s.\-_]*s[\s.\-_]*h[\s.\-_]*o[\s.\-_]*l[\s.\-_]*e)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
  // --- "bsdk" (Hinglish abbreviation) ---
  {
    pattern: /\b(b[\s.\-_]*s[\s.\-_]*d[\s.\-_]*k)\b/gi,
    replacer: (m) => censorWord(m.replace(/[\s.\-_]/g, '')),
  },
];

/**
 * Applies deterministic abuse-term censoring to confession text.
 * Returns the censored text suitable for rendering/publishing.
 *
 * The original raw text should be preserved in the database for admin/audit.
 */
export function censorAbuseTerms(text: string): string {
  let result = text;
  for (const { pattern, replacer } of ABUSE_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => replacer(match));
  }
  return result;
}
