import crypto from 'crypto';
import { INSTAGRAM_LIMITS } from './config';

// ---------------------------------------------------------------------------
// Correlation Token & Caption Idempotency Contract (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Guarantees:
//   1. 128-bit cryptographic entropy per attempt (`BUC-` + 32 hex chars)
//   2. Deterministic caption formatting reserving budget so token is never truncated
//   3. Exact regex contract for matching published posts during recovery
//   4. Zero internal database IDs, secrets, or student PII in public caption
// ---------------------------------------------------------------------------

export function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a cryptographically random, high-entropy correlation token (128 bits).
 * Example: "BUC-4f9a1c8e2b7d503f9e8a1d4b6c3e7f2a"
 */
export function generateCorrelationToken(): string {
  return `BUC-${crypto.randomBytes(16).toString('hex')}`;
}

export function normalizeHandle(handle?: string): string {
  if (!handle) return '@bu.confess';
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/**
 * Formats a clean, compliant Instagram caption with guaranteed budget preservation
 * for the correlation token.
 */
export function buildInstagramCaption(
  confessionText: string,
  confessionNumber: number | null,
  correlationToken: string,
  handle: string = 'bu.confess'
): string {
  const prefix = (process.env.IG_CAPTION_PREFIX || 'BU Confession').trim();
  const header = confessionNumber ? `${prefix} #${confessionNumber}` : prefix;
  const footer = [
    'DM or visit the link in bio to submit yours!',
    normalizeHandle(handle),
    '#buconfess',
    `ref: ${correlationToken}`,
  ].join('\n\n');

  // Instagram total caption limit is 2,200 chars. We reserve safe budget of 2,100 chars
  // to ensure Instagram never silently cuts off the footer or token.
  const overhead = header.length + footer.length + 8; // account for newlines
  const maxBodyLength = Math.max(100, INSTAGRAM_LIMITS.safeCaptionBudget - overhead);

  let cleanBody = confessionText.trim();
  if (cleanBody.length > maxBodyLength) {
    cleanBody = `${cleanBody.slice(0, maxBodyLength - 3)}...`;
  }

  return `${header}\n\n${cleanBody}\n\n${footer}`;
}

/**
 * Checks if a caption contains the exact correlation token.
 */
export function matchesCorrelationToken(caption: string | undefined, token: string): boolean {
  if (!caption || !token) return false;
  const regex = new RegExp(`\\bref:\\s*${escapeRegex(token)}\\b`);
  return regex.test(caption);
}

/**
 * Extracts the correlation token from a caption if present.
 */
export function extractCorrelationToken(caption: string | undefined): string | null {
  if (!caption) return null;
  const match = caption.match(/\bref:\s*(BUC-[a-f0-9]{32})\b/);
  return match ? match[1] : null;
}
