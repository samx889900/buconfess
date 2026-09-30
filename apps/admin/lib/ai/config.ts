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

export const MODERATION_MODELS = {
  PRIMARY: 'gemini-3.5-flash',
  SECONDARY: 'gemini-3.7-flash',
  TERTIARY: 'gemini-3.8-flash',
} as const;

export const ALLOWED_GEMINI_MODELS = [
  MODERATION_MODELS.PRIMARY,
  MODERATION_MODELS.SECONDARY,
  MODERATION_MODELS.TERTIARY,
] as const;

export type AllowedGeminiModel = typeof ALLOWED_GEMINI_MODELS[number];

export const DEFAULT_CASCADE: AllowedGeminiModel[] = [
  MODERATION_MODELS.PRIMARY,
  MODERATION_MODELS.SECONDARY,
  MODERATION_MODELS.TERTIARY,
];

export const AI_CONFIG = {
  // Allowlist and Default Cascade Order
  models: MODERATION_MODELS,
  allowedModels: ALLOWED_GEMINI_MODELS,
  defaultCascade: DEFAULT_CASCADE,

  // Quota & Request Budgeting Configuration (BU Confessions v3.5)
  // Maintains a conservative safety budget below provider free-tier limits (20 RPD)
  quota: {
    freeTierObservedLimit: 20, // Free tier RPD per model per project
    safetyMargin: 2,           // Reserve 2 requests safety margin per project
    dailyBudgetPerModel: 18,   // 20 - 2 = 18 requests max per model per project per day
    ambiguityConfidenceThreshold: 0.6, // Only confidence < 0.6 triggers semantic escalation
  },

  // Bounded Retry & Backoff Configuration
  retryPolicy: {
    timeoutMs: 45000,              // 45s timeout per attempt (allows cold-start TLS & generation)
    maxRetriesForTimeout: 1,       // timeout -> max 1 retry -> failover project
    maxRetriesFor503: 1,           // 503 -> max 1 short retry -> mark project cooldown
    shortRetryDelay503Ms: 500,     // 500ms short backoff on 503
    maxRetriesFor429: 1,           // 429 RPM -> max 1 retry with bounded Retry-After
    maxRetryAfterMs: 3000,         // strict 3s upper bound on Retry-After
    baseDelayMs: 500,
    maxDelayMs: 3000,
    jitterFactor: 0.2,
  },

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

  // Retryable keywords
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

  // Retryable status codes
  retryableStatusCodes: new Set([429, 500, 502, 503, 504]),

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
    'not found',
    'not_found',
    'no longer available',
    'model unavailable',
    'model not found',
    '400',
    '401',
    '403',
    '404',
  ],
};

/**
 * Checks if an error is a timeout.
 */
export function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('timeout') || msg.includes('deadline exceeded') || msg.includes('etimedout');
}

/**
 * Checks if an error is a 503 / Service Unavailable / High demand error.
 */
export function is503Error(error: unknown): boolean {
  if (!error) return false;
  const errObj = error as Record<string, unknown>;
  if (errObj.status === 503) return true;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('503') || msg.includes('unavailable') || msg.includes('overloaded') || msg.includes('high demand');
}

/**
 * Checks if an error is a 429 / Rate Limit error.
 */
export function is429Error(error: unknown): boolean {
  if (!error) return false;
  const errObj = error as Record<string, unknown>;
  if (errObj.status === 429) return true;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('resource exhausted') || msg.includes('quota');
}

/**
 * Checks if an error is deterministic (non-retryable 400/401/403/syntax error).
 */
export function isDeterministicError(error: unknown): boolean {
  if (!error) return false;
  const errObj = error as Record<string, unknown>;
  const status = typeof errObj.status === 'number' ? errObj.status : undefined;
  if (status && [400, 401, 403, 404].includes(status)) {
    return true;
  }
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  for (const det of AI_CONFIG.deterministicErrorKeywords) {
    if (msg.includes(det)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts Retry-After delay in milliseconds from an error object or headers.
 */
export function extractRetryAfterMs(error: unknown): number | null {
  if (!error) return null;
  const errObj = error as Record<string, unknown>;

  // 1. Direct property: errObj.retryAfter
  if (errObj.retryAfter !== undefined && errObj.retryAfter !== null) {
    const s = typeof errObj.retryAfter === 'number' ? errObj.retryAfter : parseFloat(String(errObj.retryAfter));
    if (!isNaN(s) && s > 0) return Math.floor(s * 1000);
  }

  // 2. Check headers on errObj or errObj.response
  const headersObj = errObj.headers || (errObj.response && (errObj.response as any).headers);
  if (headersObj) {
    let rawHeader: unknown;
    if (typeof (headersObj as any).get === 'function') {
      rawHeader = (headersObj as any).get('retry-after');
    } else if (typeof headersObj === 'object') {
      rawHeader = (headersObj as any)['retry-after'] || (headersObj as any)['Retry-After'];
    }

    if (rawHeader !== undefined && rawHeader !== null) {
      const s = typeof rawHeader === 'number' ? rawHeader : parseFloat(String(rawHeader));
      if (!isNaN(s) && s > 0) return Math.floor(s * 1000);
    }
  }

  // 3. Parse from error message e.g. "retry after 19.29s" or "retryDelay: 2.5s"
  const msg = errObj.message ? String(errObj.message) : String(error);
  const match = msg.match(/retry\s*(?:after|delay)?[:\s]+([0-9]+(?:\.[0-9]+)?)\s*s?/i);
  if (match && match[1]) {
    const s = parseFloat(match[1]);
    if (!isNaN(s) && s > 0) {
      return Math.floor(s * 1000);
    }
  }

  return null;
}

/**
 * Checks if an error is retryable based on status code or message.
 */
export function isRetryableAiError(error: unknown): boolean {
  if (!error) return false;
  if (isDeterministicError(error)) return false;

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
      return Math.min(seconds * 1000, AI_CONFIG.retryPolicy.maxRetryAfterMs);
    }
  }

  const { baseDelayMs, maxDelayMs, jitterFactor } = AI_CONFIG.retryPolicy;
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = exponential * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(100, Math.floor(exponential + jitter));
}
