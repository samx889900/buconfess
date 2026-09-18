// ---------------------------------------------------------------------------
// Central Secret Redaction Utility
// ---------------------------------------------------------------------------
// Every log message, error report, email digest, and audit entry that might
// contain secret values MUST be passed through redactSecrets() before output.
// ---------------------------------------------------------------------------

import { getSecretEnvKeys } from './secrets';

/** Minimum length of a secret value to be considered for redaction. */
const MIN_SECRET_LENGTH = 6;

/** The replacement string used when a secret is found. */
const REDACTED = '[REDACTED]';

/**
 * Collects all non-empty secret values from the environment, sorted by
 * length descending so longer secrets are matched first (prevents partial
 * replacements when one secret is a substring of another).
 */
function getSecretValues(): string[] {
  const keys = getSecretEnvKeys();
  const values: string[] = [];

  for (const key of keys) {
    const value = process.env[key];
    if (value && value.length >= MIN_SECRET_LENGTH) {
      values.push(value);
    }
  }

  // Sort by length descending — match longer secrets first
  values.sort((a, b) => b.length - a.length);
  return values;
}

/**
 * Replaces any occurrence of known secret values in the input string
 * with `[REDACTED]`.
 *
 * @param input - The string that may contain secret values.
 * @returns A sanitized copy of the string with secrets removed.
 *
 * @example
 * ```ts
 * const safeLog = redactSecrets(`Token: ${accessToken} failed`);
 * console.log(safeLog); // "Token: [REDACTED] failed"
 * ```
 */
export function redactSecrets(input: string): string {
  if (!input) return input;

  let result = input;
  const secrets = getSecretValues();

  for (const secret of secrets) {
    // Use split+join for a global, non-regex replace that handles
    // special characters in secrets (like private keys with +, /, = etc.)
    while (result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }

  return result;
}

/**
 * Redacts secrets from an object by JSON-serializing, redacting, and
 * deserializing. Useful for sanitizing complex objects before logging.
 *
 * @param obj - Any JSON-serializable object.
 * @returns A deep copy with all secret values replaced.
 */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  try {
    const serialized = JSON.stringify(obj);
    const redacted = redactSecrets(serialized);
    return JSON.parse(redacted) as T;
  } catch {
    // If serialization fails, return the original — better than crashing
    return obj;
  }
}
