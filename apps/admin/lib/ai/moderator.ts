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
import {
  geminiCredentialPool,
  GeminiCredentialPool,
  classifyGeminiError,
} from './credentialPool';

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
  /** Optional credential pool override for testing multi-project failover */
  credentialPool?: GeminiCredentialPool;
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

  // ── 2. Resolve Credential Pool & Model Cascade ──
  const pool = options.credentialPool || geminiCredentialPool;

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

  // If mockClient is not provided, verify credential pool availability
  if (!mockClient) {
    const slots = pool.getSlots();
    if (slots.length === 0) {
      console.warn(`[MODERATION] confession_id=${confessionId} Zero Gemini API keys configured in pool — routing to pending_review`);
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
  }

  let lastError: Error | null = null;

  // ── 4. Execute Model Cascade ──
  for (let modelIndex = 0; modelIndex < activeCascade.length; modelIndex++) {
    const modelName = activeCascade[modelIndex];
    const isPrimary = modelIndex === 0;
    const fallbackUsed = !isPrimary;

    // Path A: Mock client for isolated unit testing
    if (mockClient) {
      let modelAttempt = 0;
      let rawResponseText = '';
      let shouldCascade = false;

      while (!shouldCascade) {
        const attemptStartTime = Date.now();
        try {
          const resp = await mockClient.generateContent({
            model: modelName,
            contents: userPrompt,
            config: {
              systemInstruction: SYSTEM_MODERATION_INSTRUCTION,
              ...AI_CONFIG.generationConfig,
            },
          });
          rawResponseText = typeof resp.text === 'function' ? resp.text() : resp.text || '';
          const latencyMs = Date.now() - attemptStartTime;

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
            shouldCascade = true;
            break;
          }

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

          if (isDeterministicError(lastError)) {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} attempt=${modelAttempt + 1} latency_ms=${latencyMs} result=deterministic_error action=cascade error="${lastError.message}"`
            );
            shouldCascade = true;
            break;
          } else if (isTimeoutError(lastError)) {
            if (modelAttempt < AI_CONFIG.retryPolicy.maxRetriesForTimeout) {
              modelAttempt++;
              await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
              continue;
            }
            shouldCascade = true;
            break;
          } else if (is503Error(lastError)) {
            if (modelAttempt < AI_CONFIG.retryPolicy.maxRetriesFor503) {
              modelAttempt++;
              await sleepFn(AI_CONFIG.retryPolicy.shortRetryDelay503Ms);
              continue;
            }
            shouldCascade = true;
            break;
          } else if (is429Error(lastError)) {
            const retryAfterMs = extractRetryAfterMs(lastError);
            if (retryAfterMs !== null && retryAfterMs > AI_CONFIG.retryPolicy.maxRetryAfterMs) {
              shouldCascade = true;
              break;
            }
            if (modelAttempt < AI_CONFIG.retryPolicy.maxRetriesFor429) {
              const delay = retryAfterMs !== null ? retryAfterMs : AI_CONFIG.retryPolicy.baseDelayMs;
              modelAttempt++;
              await sleepFn(delay);
              continue;
            }
            shouldCascade = true;
            break;
          } else if (isRetryableAiError(lastError) && modelAttempt < 1) {
            modelAttempt++;
            await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
            continue;
          } else {
            shouldCascade = true;
            break;
          }
        }
      }

      if (!shouldCascade) {
        // If not cascaded and didn't return, model finished
        continue;
      }
      continue;
    }

    // Path B: Live multi-project credential pool execution
    const availableSlots = pool.getAvailableSlots();
    if (availableSlots.length === 0) {
      console.warn(
        `[MODERATION] confession_id=${confessionId} All Gemini project credentials are in cooldown or unavailable.`
      );
      break;
    }

    let modelUnsupportedAcrossAllProjects = false;

    for (const slot of availableSlots) {
      const leased = pool.leaseSlot(slot.id);
      if (!leased) continue;

      const ai = new GoogleGenAI({ apiKey: leased.apiKey });
      let modelAttempt = 0;
      let slotFinished = false;

      while (!slotFinished) {
        const attemptStartTime = Date.now();
        try {
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
          const rawResponseText = response.text
            ? typeof response.text === 'function'
              ? (response.text as () => string)()
              : response.text
            : '';

          const latencyMs = Date.now() - attemptStartTime;

          // Validate Structured JSON
          const validation = validateModerationOutput(rawResponseText);
          if (!validation.success || !validation.data) {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} latency_ms=${latencyMs} result=invalid_schema error="${validation.error}"`
            );
            if (modelAttempt === 0) {
              modelAttempt++;
              await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
              continue;
            }
            pool.releaseSlot(slot.id, { success: false, error: new Error(validation.error || 'Invalid JSON') });
            slotFinished = true;
            break;
          }

          // Successful moderation!
          pool.releaseSlot(slot.id, { success: true });
          console.log(
            `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} latency_ms=${latencyMs} result=success verdict=${validation.data.verdict}`
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
          const classification = classifyGeminiError(lastError);

          // 404: Model not found on Google's API -> cascade model immediately across all projects
          if (classification === 'MODEL_NOT_FOUND') {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} result=404_model_not_found action=cascade_model error="${lastError.message}"`
            );
            pool.releaseSlot(slot.id, { success: false, error: lastError });
            modelUnsupportedAcrossAllProjects = true;
            slotFinished = true;
            break;
          }

          // Daily quota exhausted (429 RPD): project enters cooldown, failover immediately to next project on same model
          if (classification === 'DAILY_QUOTA_EXHAUSTED') {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} result=daily_quota_exhausted action=failover_project error="${lastError.message}"`
            );
            pool.releaseSlot(slot.id, { success: false, error: lastError });
            slotFinished = true;
            break;
          }

          // Authentication or Permission failure: permanent project error, failover to next project on same model
          if (classification === 'AUTHENTICATION' || classification === 'PERMISSION') {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} result=${classification} action=failover_project error="${lastError.message}"`
            );
            pool.releaseSlot(slot.id, { success: false, error: lastError });
            slotFinished = true;
            break;
          }

          // Transient errors (503 / 429 RPM / Timeout): max 1 short retry before failing over
          if (modelAttempt === 0) {
            modelAttempt++;
            let delayMs = AI_CONFIG.retryPolicy.baseDelayMs;
            if (classification === 'SERVICE_UNAVAILABLE') {
              delayMs = AI_CONFIG.retryPolicy.shortRetryDelay503Ms;
            } else if (classification === 'RATE_LIMIT_TRANSIENT') {
              const retryAfter = extractRetryAfterMs(lastError);
              if (retryAfter !== null && retryAfter > AI_CONFIG.retryPolicy.maxRetryAfterMs) {
                // Retry-After > 3s: failover to next credential immediately
                pool.releaseSlot(slot.id, { success: false, error: lastError });
                slotFinished = true;
                break;
              }
              delayMs = retryAfter ?? AI_CONFIG.retryPolicy.baseDelayMs;
            }
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} result=transient_${classification} action=retry delay_ms=${delayMs}`
            );
            await sleepFn(delayMs);
            continue;
          } else {
            // Retries exhausted for this project on this model: failover to next project
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slot.id} result=retry_exhausted action=failover_project error="${lastError.message}"`
            );
            pool.releaseSlot(slot.id, { success: false, error: lastError });
            slotFinished = true;
            break;
          }
        }
      }

      if (modelUnsupportedAcrossAllProjects) {
        break; // cascade to next model in activeCascade
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
