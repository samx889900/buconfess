import { GoogleGenAI } from '@google/genai';
import {
  AI_CONFIG,
  MODERATION_MODELS,
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
import { getRuntimeSettings } from '../settings';
import {
  geminiCredentialPool,
  GeminiCredentialPool,
  classifyGeminiError,
} from './credentialPool';
import { geminiQuotaLedger } from './quotaLedger';

// ---------------------------------------------------------------------------
// Gemini Multi-Project Quota-Aware AI Moderator (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Architecture Principles:
//   1. PRIMARY MODEL: gemini-3.5-flash (High throughput, efficient classifier)
//   2. AMBIGUITY ESCALATION ONLY: gemini-3.7-flash (Invoked ONLY on genuine uncertainty: confidence < 0.6)
//   3. TERTIARY EXCEPTION ONLY: gemini-3.8-flash (Invoked ONLY if 3.7 remains genuinely uncertain)
//   4. NORMAL PATH: 1 confession -> 1 gemini-3.5-flash request -> Done!
//   5. A valid approved, rejected, or confident pending_review verdict STOPS immediately.
//   6. INFRASTRUCTURE FAILURES (503, 429, timeouts) DO NOT TRIGGER MODEL ESCALATION.
//      They trigger bounded slot retry (max 1) and failover to healthy project slots.
//   7. Target metric: gemini_calls_per_decision <= 1.1 on average.
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
 * Moderates a single confession text following the quota-aware hierarchy,
 * deterministic pre-filter, and semantic ambiguity escalation.
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

  // ── 0. Input Size & Sanity Pre-Filter ──
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return {
      verdict: 'rejected',
      decision_reason: 'Confession text cannot be empty or solely whitespace.',
      model_confidence: 1.0,
      matched_rules: ['EMPTY_INPUT'],
      policy_level: 4,
      flags: ['empty_submission'],
      model_id: 'deterministic_prefilter',
      model_version: 'v3.5',
      ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
      instruction_version: AI_CONFIG.versions.instructionVersion,
      prompt_hash: 'none',
      generation_config: {},
      fallback_used: false,
      deterministic_filter_used: true,
      telemetry: [],
    };
  }

  // ── 1. Deterministic Rule Pre-Filter ──
  if (!skipDeterministicRules) {
    const deterministic = checkDeterministicRules(trimmed);
    if (deterministic.matched && deterministic.moderation) {
      const promptHash = computePromptHash(buildModerationUserPrompt(trimmed));
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

  // ── 2. Resolve Credential Pool & Model Hierarchy ──
  const pool = options.credentialPool || geminiCredentialPool;
  if (!options.credentialPool) {
    pool.refreshFromEnv();
  }

  // Resolve Model Hierarchy: Primary (3.5) -> Secondary (3.7) -> Tertiary (3.8)
  let activeCascade: readonly string[] = AI_CONFIG.defaultCascade;
  if (options.modelCascade && options.modelCascade.length > 0) {
    activeCascade = options.modelCascade;
  } else {
    try {
      const runtimeSettings = await getRuntimeSettings();
      if (runtimeSettings.moderation_model_cascade) {
        const parsed = runtimeSettings.moderation_model_cascade
          .split(',')
          .map((s) => s.trim())
          .filter((m) => AI_CONFIG.allowedModels.includes(m as any));
        if (parsed.length > 0) {
          activeCascade = parsed;
        }
      }
    } catch {
      activeCascade = AI_CONFIG.defaultCascade;
    }
  }

  const userPrompt = buildModerationUserPrompt(trimmed);
  const promptHash = computePromptHash(userPrompt);

  // If mockClient is not provided, verify credential pool availability
  if (!mockClient) {
    const slots = pool.getSlots();
    if (slots.length === 0) {
      console.warn(`[MODERATION] confession_id=${confessionId} Zero Gemini API keys configured in pool — routing to pending_review`);
      return {
        verdict: 'pending_review',
        decision_reason: 'GEMINI_API_KEY not configured on server (routed to human review).',
        model_confidence: null,
        matched_rules: ['SYS_NO_API_KEY'],
        policy_level: null,
        flags: ['system_warning', 'needs_manual_review'],
        model_id: 'none',
        model_version: 'none',
        ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
        instruction_version: AI_CONFIG.versions.instructionVersion,
        prompt_hash: promptHash,
        generation_config: {},
        fallback_used: true,
        deterministic_filter_used: false,
        infrastructure_reason: 'Zero Gemini credentials discovered in environment',
        telemetry: [],
      };
    }
  }

  let lastError: Error | null = null;
  const telemetry: import('./schema').ModerationTelemetryEntry[] = [];

  // =========================================================================
  // PATH A: Mock Client Execution (Unit Testing / Diagnostics)
  // =========================================================================
  if (mockClient) {
    for (let modelIndex = 0; modelIndex < activeCascade.length; modelIndex++) {
      const modelName = activeCascade[modelIndex];
      const isPrimary = modelIndex === 0;
      let modelAttempt = 0;
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
          const rawText = typeof resp.text === 'function' ? resp.text() : resp.text || '';
          const latencyMs = Date.now() - attemptStartTime;

          const validation = validateModerationOutput(rawText);
          if (!validation.success || !validation.data) {
            telemetry.push({
              model: modelName,
              credential_slot: 'mock',
              attempt_number: modelAttempt + 1,
              error_class: 'INVALID_REQUEST',
              retry_count: modelAttempt,
              duration_ms: latencyMs,
              result: 'invalid_schema',
              timestamp: new Date().toISOString(),
            });
            if (modelAttempt === 0) {
              modelAttempt++;
              await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
              continue;
            }
            shouldCascade = true;
            break;
          }

          telemetry.push({
            model: modelName,
            credential_slot: 'mock',
            attempt_number: modelAttempt + 1,
            retry_count: modelAttempt,
            duration_ms: latencyMs,
            result: 'success',
            timestamp: new Date().toISOString(),
          });

          // Check semantic ambiguity escalation
          const conf = validation.data.model_confidence ?? 1.0;
          const isAmbiguous =
            validation.data.verdict === 'pending_review' &&
            conf < AI_CONFIG.quota.ambiguityConfidenceThreshold;

          if (isAmbiguous && modelIndex < activeCascade.length - 1) {
            // Escalate to next model
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
            fallback_used: !isPrimary,
            deterministic_filter_used: false,
            telemetry,
          };
        } catch (err: any) {
          const latencyMs = Date.now() - attemptStartTime;
          lastError = err instanceof Error ? err : new Error(String(err));
          const classification = classifyGeminiError(lastError);

          telemetry.push({
            model: modelName,
            credential_slot: 'mock',
            attempt_number: modelAttempt + 1,
            error_class: classification,
            retry_count: modelAttempt,
            duration_ms: latencyMs,
            result: 'failed',
            timestamp: new Date().toISOString(),
          });

          if (isDeterministicError(lastError)) {
            shouldCascade = true;
            break;
          } else if (modelAttempt === 0 && (is503Error(lastError) || isTimeoutError(lastError) || is429Error(lastError))) {
            modelAttempt++;
            await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
            continue;
          } else {
            shouldCascade = true;
            break;
          }
        }
      }
    }

    // Mock cascade exhausted
    return {
      verdict: 'pending_review',
      decision_reason: `AI moderation unavailable across all models: ${lastError?.message || 'Cascade exhausted'} (routed to human review).`,
      model_confidence: null,
      matched_rules: ['SYS_MODERATION_UNAVAILABLE'],
      policy_level: null,
      flags: ['ai_cascade_exhausted', 'needs_manual_review'],
      model_id: 'cascade_failed',
      model_version: 'none',
      ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
      instruction_version: AI_CONFIG.versions.instructionVersion,
      prompt_hash: promptHash,
      generation_config: AI_CONFIG.generationConfig,
      fallback_used: true,
      deterministic_filter_used: false,
      infrastructure_reason: 'Mock cascade exhausted',
      telemetry,
    };
  }

  // =========================================================================
  // PATH B: Live Quota-Aware Multi-Project Execution
  // =========================================================================
  // Strategy:
  //   1. Normal path: Evaluate Primary Model (gemini-3.5-flash).
  //   2. If Primary produces confident approved/rejected/pending_review -> DONE! (1 call).
  //   3. ONLY if Primary produces ambiguous pending_review (confidence < 0.6) -> Escalate to 3.7.
  //   4. Infrastructure failures (503/429/timeout) use bounded retries and project failover,
  //      NEVER triggering semantic model escalation.
  // =========================================================================

  for (let modelIndex = 0; modelIndex < activeCascade.length; modelIndex++) {
    const modelName = activeCascade[modelIndex];
    const isPrimary = modelIndex === 0;

    // Quota-aware project slot selection:
    // Try up to 2 distinct healthy project slots for this model (bounded failover)
    const MAX_PROJECT_FAILOVERS_PER_MODEL = 2;
    let projectAttemptCount = 0;
    let modelSuccess = false;
    let evaluatedResult: ModerationResult | null = null;
    const attemptedSlots = new Set<string>();

    while (projectAttemptCount < MAX_PROJECT_FAILOVERS_PER_MODEL) {
      // Lease best healthy slot with remaining daily budget for this model
      const available = pool.getAvailableSlots().filter((s) => !attemptedSlots.has(s.id));
      if (available.length === 0) {
        break; // No healthy slots left for this model
      }

      const bestSlotId = geminiQuotaLedger.selectBestProject(modelName, available.map((s) => s.id));
      if (!bestSlotId) {
        // No slots have available daily safety budget for this model
        break;
      }

      attemptedSlots.add(bestSlotId);
      const leased = pool.leaseSlot(bestSlotId, modelName);
      if (!leased) {
        continue;
      }

      projectAttemptCount++;
      const slotId = leased.id;
      const ai = new GoogleGenAI({ apiKey: leased.apiKey });

      // In-slot retry policy: max 1 retry for transient 503/timeout
      let slotAttempt = 0;
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
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} latency_ms=${latencyMs} result=invalid_schema error="${validation.error}"`
            );
            telemetry.push({
              model: modelName,
              credential_slot: slotId,
              attempt_number: slotAttempt + 1,
              error_class: 'INVALID_REQUEST',
              retry_count: slotAttempt,
              duration_ms: latencyMs,
              result: 'invalid_schema',
              timestamp: new Date().toISOString(),
            });

            if (slotAttempt === 0) {
              slotAttempt++;
              await sleepFn(AI_CONFIG.retryPolicy.baseDelayMs);
              continue;
            }
            pool.releaseSlot(slotId, { success: false, error: new Error(validation.error || 'Invalid JSON'), model: modelName });
            slotFinished = true;
            break;
          }

          // SUCCESSFUL EVALUATION!
          pool.releaseSlot(slotId, { success: true, model: modelName });
          geminiQuotaLedger.recordDecision();

          console.log(
            `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} latency_ms=${latencyMs} result=success verdict=${validation.data.verdict}`
          );

          telemetry.push({
            model: modelName,
            credential_slot: slotId,
            attempt_number: slotAttempt + 1,
            retry_count: slotAttempt,
            duration_ms: latencyMs,
            result: 'success',
            timestamp: new Date().toISOString(),
          });

          evaluatedResult = {
            ...validation.data,
            model_id: modelName,
            model_version: 'v3.5',
            ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
            instruction_version: AI_CONFIG.versions.instructionVersion,
            prompt_hash: promptHash,
            generation_config: AI_CONFIG.generationConfig,
            fallback_used: !isPrimary,
            deterministic_filter_used: false,
            telemetry,
          };

          modelSuccess = true;
          slotFinished = true;
          break;
        } catch (err) {
          const latencyMs = Date.now() - attemptStartTime;
          lastError = err instanceof Error ? err : new Error(String(err));
          const classification = classifyGeminiError(lastError);

          let httpStatus: number | undefined;
          if (typeof err === 'object' && err !== null) {
            const errObj = err as Record<string, unknown>;
            if (typeof errObj.status === 'number') httpStatus = errObj.status;
            else if (typeof errObj.code === 'number') httpStatus = errObj.code;
            else if (typeof errObj.statusCode === 'number') httpStatus = errObj.statusCode;
          }

          let outcomeTag: import('./schema').ModerationTelemetryEntry['result'] = 'failed';
          if (classification === 'MODEL_NOT_FOUND') outcomeTag = 'not_found';
          else if (classification === 'DAILY_QUOTA_EXHAUSTED' || classification === 'RATE_LIMIT_TRANSIENT')
            outcomeTag = 'rate_limited';
          else if (classification === 'SERVICE_UNAVAILABLE') outcomeTag = 'service_unavailable';
          else if (classification === 'AUTHENTICATION') outcomeTag = 'auth_error';
          else if (classification === 'PERMISSION') outcomeTag = 'permission_error';
          else if (classification === 'TIMEOUT') outcomeTag = 'timeout';

          telemetry.push({
            model: modelName,
            credential_slot: slotId,
            attempt_number: slotAttempt + 1,
            error_class: classification,
            http_status: httpStatus,
            retry_count: slotAttempt,
            duration_ms: latencyMs,
            result: outcomeTag,
            timestamp: new Date().toISOString(),
          });

          // Model not found (404) -> permanently disable model, break out to next model
          if (classification === 'MODEL_NOT_FOUND') {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} result=404_model_not_found action=disable_model error="${lastError.message}"`
            );
            pool.releaseSlot(slotId, { success: false, error: lastError, is404ModelNotFound: true, model: modelName });
            slotFinished = true;
            break;
          }

          // Daily Quota (429 RPD) -> mark slot exhausted until Pacific midnight, failover to next project slot
          if (classification === 'DAILY_QUOTA_EXHAUSTED') {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} result=daily_quota_exhausted action=failover_project error="${lastError.message}"`
            );
            pool.releaseSlot(slotId, { success: false, error: lastError, model: modelName });
            slotFinished = true;
            break;
          }

          // Permanent Auth/Permission failure -> disable project slot permanently
          if (classification === 'AUTHENTICATION' || classification === 'PERMISSION') {
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} result=${classification} action=disable_project error="${lastError.message}"`
            );
            pool.releaseSlot(slotId, { success: false, error: lastError, model: modelName });
            slotFinished = true;
            break;
          }

          // Transient conditions: 503 High Demand / Timeout / 429 RPM
          // Bounded retry: max 1 retry with backoff in same slot
          if (slotAttempt === 0) {
            slotAttempt++;
            let delayMs = AI_CONFIG.retryPolicy.baseDelayMs;
            if (classification === 'SERVICE_UNAVAILABLE') {
              delayMs = AI_CONFIG.retryPolicy.shortRetryDelay503Ms;
            } else if (classification === 'RATE_LIMIT_TRANSIENT') {
              const retryAfter = extractRetryAfterMs(lastError);
              if (retryAfter !== null && retryAfter > AI_CONFIG.retryPolicy.maxRetryAfterMs) {
                // Retry-After > 3s -> failover to next slot immediately
                pool.releaseSlot(slotId, { success: false, error: lastError, model: modelName });
                slotFinished = true;
                break;
              }
              delayMs = retryAfter ?? AI_CONFIG.retryPolicy.baseDelayMs;
            }
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} result=transient_${classification} action=retry delay_ms=${delayMs}`
            );
            await sleepFn(delayMs);
            continue;
          } else {
            // Retried once and still failed -> release slot with cooldown, try next slot
            console.warn(
              `[MODERATION] confession_id=${confessionId} model=${modelName} project=${slotId} result=retry_exhausted action=failover_project error="${lastError.message}"`
            );
            pool.releaseSlot(slotId, { success: false, error: lastError, model: modelName });
            slotFinished = true;
            break;
          }
        }
      }

      if (modelSuccess) {
        break; // Successfully evaluated on this model!
      }
    }

    // ── Evaluate Result & Semantic Escalation ──
    if (modelSuccess && evaluatedResult) {
      const conf = evaluatedResult.model_confidence ?? 1.0;
      const isAmbiguous =
        evaluatedResult.verdict === 'pending_review' &&
        conf < AI_CONFIG.quota.ambiguityConfidenceThreshold;

      if (!isAmbiguous) {
        // Normal confident decision (approved, rejected, or confident pending_review like #38)
        // SUCCESS! STOP IMMEDIATELY! Do NOT consume any other models.
        return evaluatedResult;
      }

      // Ambiguous content detected! Only escalate if a higher model exists in the hierarchy
      if (modelIndex < activeCascade.length - 1) {
        const nextModel = activeCascade[modelIndex + 1];
        console.log(
          `[MODERATION] confession_id=${confessionId} Semantic ambiguity detected on ${modelName} (confidence=${conf}) -> Escalating to ${nextModel}`
        );
        continue; // Proceed to next model in hierarchy for ambiguity resolution
      } else {
        // At the top of the hierarchy, preserve the ambiguity verdict as final
        return evaluatedResult;
      }
    }

    // ── INFRASTRUCTURE FAILURE SEPARATION (Requirement #3 & #21) ──
    // If the model failed due to infrastructure (503, 429, timeout, network failure),
    // DO NOT cascade to secondary or tertiary models.
    // Infrastructure conditions invoke quota scheduling / cooldowns, NOT semantic escalation.
    // Preserve quota: Stop immediately and route safely to pending_review.
    console.warn(
      `[MODERATION] confession_id=${confessionId} Model ${modelName} infrastructure failure. Preserving quota: DO NOT cascade to higher models.`
    );
    break;
  }

  // ── 3. All Model / Slot Paths Exhausted ──
  console.error(
    `[MODERATION] confession_id=${confessionId} All quota and models exhausted. Routing safely to pending_review.`,
    lastError
  );

  const failureSummaries = new Map<string, string>();
  for (const t of telemetry) {
    if (t.result !== 'success') {
      const desc = t.error_class || t.result;
      failureSummaries.set(t.model, desc);
    }
  }
  const infraReason = Array.from(failureSummaries.entries())
    .map(([m, r]) => `${m.replace('gemini-', '')}: ${r}`)
    .join(', ');

  return {
    verdict: 'pending_review',
    decision_reason: `AI moderation unavailable across all models: ${lastError?.message || 'Cascade exhausted'} (routed to human review).`,
    model_confidence: null,
    matched_rules: ['SYS_MODERATION_UNAVAILABLE'],
    policy_level: null,
    flags: ['ai_cascade_exhausted', 'needs_manual_review'],
    model_id: 'cascade_failed',
    model_version: 'none',
    ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
    instruction_version: AI_CONFIG.versions.instructionVersion,
    prompt_hash: promptHash,
    generation_config: AI_CONFIG.generationConfig,
    fallback_used: true,
    deterministic_filter_used: false,
    infrastructure_reason: infraReason || 'Cascade exhausted across all models and credentials',
    telemetry,
  };
}
