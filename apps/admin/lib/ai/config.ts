// ---------------------------------------------------------------------------
// Centralized AI Configuration Module (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Configures the Gemini model cascade, retry policy, backoff with jitter,
// generation hyperparameters, and audit version identifiers.
// ---------------------------------------------------------------------------

export interface RetryPolicyConfig {
  /** Maximum retry attempts per model before escalating to the next model in cascade */
  maxRetriesPerModel: number;
  /** Base delay for exponential backoff in milliseconds */
  baseDelayMs: number;
  /** Maximum backoff delay in milliseconds */
  maxDelayMs: number;
  /** Jitter ratio (0.0 to 1.0) applied to backoff calculations */
  jitterFactor: number;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

export interface ModelCascadeConfig extends RetryPolicyConfig {
  /** Ordered list of models to try in sequence */
  cascade: readonly string[];
}

export interface GenerationConfig {
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens: number;
  responseMimeType: string;
}

export interface AiPolicyVersions {
  aiPolicyVersion: number;
  instructionVersion: number;
}

export const AI_CONFIG = {
  // Model Cascade: Primary -> Fallback -> Final Fallback
  models: {
    primary: 'gemini-3.8-flash',
    fallback: 'gemini-3.7-flash',
    finalFallback: 'gemini-3.6-flash',
  },

  // Cascade execution order
  cascadeOrder: [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
  ] as const,

  // Retry & Backoff Configuration
  retryPolicy: {
    maxRetriesPerModel: 2,
    baseDelayMs: 1000,       // 1 second base
    maxDelayMs: 8000,        // 8 seconds cap
    jitterFactor: 0.25,      // +/- 25% random jitter
    timeoutMs: 15000,        // 15s per attempt
  } satisfies RetryPolicyConfig,

  // Deterministic Moderation Generation Hyperparameters
  generationConfig: {
    temperature: 0.1,         // Low temperature for deterministic policy compliance
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',
  } satisfies GenerationConfig,

  // Policy & Instruction Audit Versions
  versions: {
    aiPolicyVersion: 1,
    instructionVersion: 1,
  } satisfies AiPolicyVersions,

  // Retryable HTTP status codes / errors
  retryableStatusCodes: new Set([429, 500, 502, 503, 504]),
  retryableErrorKeywords: [
    'rate limit',
    'resource exhausted',
    'quota',
    'overloaded',
    'unavailable',
    '503',
    '429',
    '500',
    '502',
    '504',
    'timeout',
    'deadline exceeded',
    'fetch failed',
    'econnreset',
    'etimedout',
  ],

  // Deterministic (non-retryable) errors — do not retry, fail or route immediately
  deterministicErrorKeywords: [
    'invalid argument',
    'invalid_argument',
    'bad request',
    'malformed',
    'syntax error',
    'unsupported field',
    'invalid api key',
    'permission denied',
    'unauthenticated',
  ],
};

/**
 * Checks if an error is retryable based on status code or message.
 */
export function isRetryableAiError(error: unknown): boolean {
  if (!error) return false;

  const errObj = error as Record<string, unknown>;
  const status = typeof errObj.status === 'number' ? errObj.status : undefined;
  if (status && AI_CONFIG.retryableStatusCodes.has(status)) {
    return true;
  }

  const message = (
    errObj.message ||
    errObj.statusText ||
    String(error)
  ).toString().toLowerCase();

  // Check deterministic keywords first
  for (const det of AI_CONFIG.deterministicErrorKeywords) {
    if (message.includes(det)) {
      return false;
    }
  }

  // Check retryable keywords
  for (const kw of AI_CONFIG.retryableErrorKeywords) {
    if (message.includes(kw)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates exponential backoff with jitter and optional Retry-After header respect.
 */
export function calculateBackoffMs(
  attempt: number,
  retryAfterHeader?: string | number | null
): number {
  if (retryAfterHeader) {
    const seconds = typeof retryAfterHeader === 'number'
      ? retryAfterHeader
      : parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, AI_CONFIG.retryPolicy.maxDelayMs);
    }
  }

  const { baseDelayMs, maxDelayMs, jitterFactor } = AI_CONFIG.retryPolicy;
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = exponential * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(100, Math.floor(exponential + jitter));
}
