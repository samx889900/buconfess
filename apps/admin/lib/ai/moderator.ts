import { GoogleGenAI } from '@google/genai';
import {
  AI_CONFIG,
  isRetryableAiError,
  isDeterministicError,
  isTimeoutError,
  is503Error,
  is429Error,
  extractRetryAfterMs,
} from './config';
import { ModerationResult, validateModerationOutput } from './schema';
import { checkDeterministicRules } from './rules';
import { SYSTEM_MODERATION_INSTRUCTION, buildModerationUserPrompt, computePromptHash } from './prompt';
import { getSecrets } from '../secrets';
import { getRuntimeSettings } from '../settings';

// ---------------------------------------------------------------------------
// Gemini Model Cascade & AI Moderator (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Orchestrates content moderation across an allowlisted Gemini model cascade:
//   gemini-3.8-flash (Primary)
//       ↓ (503 / timeout / 429 / failure / 404)
//   gemini-3.7-flash (Fallback 1)
//       ↓ (503 / timeout / 429 / failure / 404)
//   gemini-3.5-flash (Fallback 2)
//       ↓ (503 / timeout / 429 / failure / 404)
//   gemini-2.5-flash (Fallback 3)
//       ↓ (503 / timeout / 429 / failure / 404)
//   gemini-2.5-flash-lite (Fallback 4)
//       ↓ (all fail)
//   pending_review (Never auto-reject solely due to AI provider failure)
// ---------------------------------------------------------------------------

export interface ModerateOptions {
  /** Override AI client for unit testing without live network calls */
  mockClient?: {
    generateContent: (params: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }) => Promise<{ text?: string | (() => string) }>;
  };
  /** Sleep implementation for testing backoff timing without delays */
  sleepFn?: (ms: number) => Promise<void>;
  /** Disable deterministic pre-filter for testing pure model calls */
  skipDeterministicRules?: boolean;
  /** Optional confession identifier for structured log telemetry */
  confessionId?: number | string;
  /** Optional explicit model cascade override */
  modelCascade?: readonly string[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Moderates a single confession text following the full hierarchy,
 * deterministic pre-filter, and Gemini model cascade.
 */
export async function moderateConfession(
  text: string,
  options: ModerateOptions = {}
): Promise<ModerationResult> {
  const {
    mockClient,
    sleepFn = defaultSleep,
    skipDeterministicRules = false,
    confessionId = 'unassigned',
  } = options;

  // ── 1. Deterministic Rule Pre-Filter ──
  if (!skipDeterministicRules) {
    const deterministic = checkDeterministicRules(text);
    if (deterministic.matched && deterministic.moderation) {
      const promptHash = computePromptHash(buildModerationUserPrompt(text));
      return {
        ...deterministic.moderation,
        model_id: 'deterministic_prefilter',
        model_version: 'v3.5',
        ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
        instruction_version: AI_CONFIG.versions.instructionVersion,
        prompt_hash: promptHash,
        generation_config: {},
        fallback_used: false,
        deterministic_filter_used: true,
      };
    }
  }

  // ── 2. Initialize Gemini Client ──
  let ai: GoogleGenAI | null = null;
  if (!mockClient) {
    let apiKey = '';
    try {
      apiKey = getSecrets().geminiApiKey;
    } catch {
      apiKey = process.env.GEMINI_API_KEY || '';
    }

    if (!apiKey) {
      console.warn(`[MODERATION] confession_id=${confessionId} GEMINI_API_KEY is not configured — routing to pending_review`);
      const promptHash = computePromptHash(buildModerationUserPrompt(text));
      return {
        verdict: 'pending_review',
        decision_reason: 'GEMINI_API_KEY not configured on server (routed to human review).',
        model_confidence: 0,
        matched_rules: ['SYS_NO_API_KEY'],
        policy_level: 5,
        flags: ['system_warning'],
        model_id: 'none',
        model_version: 'none',
        ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
        instruction_version: AI_CONFIG.versions.instructionVersion,
        prompt_hash: promptHash,
        generation_config: {},
        fallback_used: true,
        deterministic_filter_used: false,
      };
    }

    ai = new GoogleGenAI({ apiKey });
  }

  // ── 3. Resolve Model Cascade with Allowlist ──
  let configuredCascade: readonly string[] = AI_CONFIG.defaultCascade;
  if (options.modelCascade && options.modelCascade.length > 0) {
    configuredCascade = options.modelCascade;
  } else {
    try {
      const runtimeSettings = await getRuntimeSettings();
      if (runtimeSettings.moderation_model_cascade) {
        const parsed = runtimeSettings.moderation_model_cascade
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (parsed.length > 0) {
          configuredCascade = parsed;
        }
      }
    } catch {
      // Fallback to default cascade if settings cannot be read
      configuredCascade = AI_CONFIG.defaultCascade;
    }
  }

  // Strictly filter against allowed models
  const allowedSet = new Set<string>(AI_CONFIG.allowedModels);
  const unallowed = configuredCascade.filter((m) => !allowedSet.has(m));
  if (unallowed.length > 0) {
    console.warn(
      `[MODERATION] confession_id=${confessionId} Configured models not in allowlist rejected: [${unallowed.join(', ')}]`
    );
  }

  const activeCascade = configuredCascade.filter((m) => allowedSet.has(m));
  const userPrompt = buildModerationUserPrompt(text);
  const promptHash = computePromptHash(userPrompt);

  if (activeCascade.length === 0) {
    console.warn(
      `[MODERATION] confession_id=${confessionId} No valid allowlisted models in cascade — routing safely to pending_review`
    );
    return {
      verdict: 'pending_review',
      decision_reason: 'Configured model cascade contains no valid allowlisted models (routed to human review).',
      model_confidence: 0,
      matched_rules: ['SYS_EMPTY_MODEL_CASCADE'],
      policy_level: 5,
      flags: ['invalid_cascade_config', 'needs_manual_review'],
      model_id: 'none',
      model_version: 'none',
      ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
      instruction_version: AI_CONFIG.versions.instructionVersion,
      prompt_hash: promptHash,
      generation_config: {},
      fallback_used: true,
      deterministic_filter_used: false,
    };
  }

  let lastError: Error | null = null;

  // ── 4. Execute Model Cascade ──
  for (let modelIndex = 0; modelIndex < activeCascade.length; modelIndex++) {
    const modelName = activeCascade[modelIndex];
    const isPrimary = modelIndex === 0;
    const fallbackUsed = !isPrimary;
    let modelAttempt = 0;

    while (true) {
      const attemptStartTime = Date.now();
      try {
        let rawResponseText = '';

        if (mockClient) {
          const resp = await mockClient.generateContent({
            model: modelName,
            contents: userPrompt,
            config: {
              systemInstruction: SYSTEM_MODERATION_INSTRUCTION,
              ...AI_CONFIG.generationConfig,
            },
          });
          rawResponseText = typeof resp.text === 'function' ? resp.text() : resp.text || '';
        } else if (ai) {
          // Wrap API call with timeout
          const generatePromise = ai.models.generateContent({
            model: modelName,
            contents: userPrompt,
            config: {
              systemInstruction: SYSTEM_MODERATION_INSTRUCTION,
              ...AI_CONFIG.generationConfig,
            },
          });

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout after ${AI_CONFIG.retryPolicy.timeoutMs}ms`)),
              AI_CONFIG.retryPolicy.timeoutMs
            )
          );

          const response = await Promise.race([generatePromise, timeoutPromise]);
          rawResponseText = response.text
            ? typeof response.text === 'function'
              ? (response.text as () => string)()
              : response.text
            : '';
        }

        const latencyMs = Date.now() - attemptStartTime;

        // ── 5. Validate Structured JSON with Zod ──
        const validation = validateModerationOutput(rawResponseText);
        if (!validation.success || !validation.data) {
          console.warn(
            `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=invalid_schema action=${modelAttempt === 0 ? 'retry' : 'cascade'} error="${validation.error}"`
          );

          if (modelAttempt === 0) {
            modelAttempt++;
            await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
            continue;
          }
          break; // Cascade to next model
        }

        // Successfully validated structured response!
        console.log(
          `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=success action=return verdict=${validation.data.verdict}`
        );

        return {
          ...validation.data,
          model_id: modelName,
          model_version: 'v3.5',
          ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
          instruction_version: AI_CONFIG.versions.instructionVersion,
          prompt_hash: promptHash,
          generation_config: AI_CONFIG.generationConfig,
          fallback_used: fallbackUsed,
          deterministic_filter_used: false,
        };
      } catch (err) {
        const latencyMs = Date.now() - attemptStartTime;
        lastError = err instanceof Error ? err : new Error(String(err));

        // 1. Deterministic error (400, 401, 403, bad request, syntax): 0 retries -> cascade
        if (isDeterministicError(lastError)) {
          console.warn(
            `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=deterministic_error action=cascade error="${lastError.message}"`
          );
          break;
        } else if (isTimeoutError(lastError)) {
          // 2. Timeout error: max 1 retry -> fallback
          if (modelAttempt < AI_CONFIG.retryPolicy.maxRetriesForTimeout) {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=timeout action=retry error="${lastError.message}"`
            );
            modelAttempt++;
            await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
            continue;
          } else {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=timeout_exhausted action=cascade error="${lastError.message}"`
            );
            break;
          }
        } else if (is503Error(lastError)) {
          // 3. 503 Service Unavailable / High Demand: max 1 short retry (500ms) -> fallback
          if (modelAttempt < AI_CONFIG.retryPolicy.maxRetriesFor503) {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=503 action=short_retry delay_ms=${AI_CONFIG.retryPolicy.shortRetryDelay503Ms} error="${lastError.message}"`
            );
            modelAttempt++;
            await sleepFn(AI_CONFIG.retryPolicy.shortRetryDelay503Ms);
            continue;
          } else {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=503_exhausted action=cascade error="${lastError.message}"`
            );
            break;
          }
        } else if (is429Error(lastError)) {
          // 4. 429 Rate Limit: respect Retry-After with strict upper bound (3s max) -> fallback
          const retryAfterMs = extractRetryAfterMs(lastError);

          // If Retry-After exists and exceeds strict 3s bound, cascade immediately without waiting
          if (retryAfterMs !== null && retryAfterMs > AI_CONFIG.retryPolicy.maxRetryAfterMs) {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=429 action=retry_after_exceeded delay_ms=${retryAfterMs} > max=${AI_CONFIG.retryPolicy.maxRetryAfterMs} -> cascade`
            );
            break;
          }

          if (modelAttempt < AI_CONFIG.retryPolicy.maxRetriesFor429) {
            const delay = retryAfterMs !== null ? retryAfterMs : AI_CONFIG.retryPolicy.baseDelayMs;
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=429 action=retry delay_ms=${delay} error="${lastError.message}"`
            );
            modelAttempt++;
            await sleepFn(delay);
            continue;
          } else {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=429_exhausted action=cascade error="${lastError.message}"`
            );
            break;
          }
        } else if (isRetryableAiError(lastError) && modelAttempt < 1) {
          // 5. Other retryable errors (500/502/504/network): max 1 retry
          console.warn(
            `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=retryable_error action=retry error="${lastError.message}"`
          );
          modelAttempt++;
          await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
          continue;
        } else {
          console.warn(
            `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=unhandled_error action=cascade error="${lastError.message}"`
          );
          break;
        }
      }
    }
  }

  // ── 6. All Models in Cascade Exhausted ──
  // Fallback to pending_review — NEVER auto-reject solely due to AI provider failure
  console.error(
    `[MODERATION] confession_id=${confessionId} all models in cascade exhausted. Routing confession to pending_review.`,
    lastError
  );

  return {
    verdict: 'pending_review',
    decision_reason: `AI moderation unavailable across all models: ${lastError?.message || 'Cascade exhausted'} (routed to human review).`,
    model_confidence: 0,
    matched_rules: ['SYS_MODERATION_UNAVAILABLE'],
    policy_level: 5,
    flags: ['ai_cascade_exhausted', 'needs_manual_review'],
    model_id: 'cascade_failed',
    model_version: 'none',
    ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
    instruction_version: AI_CONFIG.versions.instructionVersion,
    prompt_hash: promptHash,
    generation_config: AI_CONFIG.generationConfig,
    fallback_used: true,
    deterministic_filter_used: false,
  };
}
