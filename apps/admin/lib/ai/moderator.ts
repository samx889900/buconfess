import { GoogleGenAI } from '@google/genai';
import { AI_CONFIG, isRetryableAiError, calculateBackoffMs } from './config';
import { ModerationResult, validateModerationOutput } from './schema';
import { checkDeterministicRules } from './rules';
import { SYSTEM_MODERATION_INSTRUCTION, buildModerationUserPrompt, computePromptHash } from './prompt';
import { getSecrets } from '../secrets';

// ---------------------------------------------------------------------------
// Gemini Model Cascade & AI Moderator (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Orchestrates content moderation across the Gemini model cascade:
//   gemini-3.8-flash (Primary)
//       ↓ (429 / 500 / 503 / timeout)
//   gemini-3.7-flash (Fallback)
//       ↓ (429 / 500 / 503 / timeout)
//   gemini-3.6-flash (Final Fallback)
//       ↓ (all fail)
//   pending_review (Never silently reject on infrastructure error)
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
  const { mockClient, sleepFn = defaultSleep, skipDeterministicRules = false } = options;

  // ── 1. Deterministic Rule Pre-Filter ──
  if (!skipDeterministicRules) {
    const deterministic = checkDeterministicRules(text);
    if (deterministic.matched && deterministic.moderation) {
      const promptHash = computePromptHash(buildModerationUserPrompt(text));
      return {
        ...deterministic.moderation,
        model_id: 'deterministic_prefilter',
        model_version: 'v3.4',
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
    let apiKey: string;
    try {
      apiKey = getSecrets().geminiApiKey;
    } catch {
      apiKey = process.env.GEMINI_API_KEY || '';
    }

    if (!apiKey) {
      console.warn('[MODERATION] GEMINI_API_KEY is not configured — routing to pending_review');
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

  const userPrompt = buildModerationUserPrompt(text);
  const promptHash = computePromptHash(userPrompt);

  let lastError: Error | null = null;

  // ── 3. Execute Model Cascade ──
  for (let modelIndex = 0; modelIndex < AI_CONFIG.cascadeOrder.length; modelIndex++) {
    const modelName = AI_CONFIG.cascadeOrder[modelIndex];
    const isPrimary = modelIndex === 0;
    const fallbackUsed = !isPrimary;

    // Retry loop per model
    for (let attempt = 0; attempt <= AI_CONFIG.retryPolicy.maxRetriesPerModel; attempt++) {
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
          rawResponseText = response.text ? (typeof response.text === 'function' ? (response.text as () => string)() : response.text) : '';
        }

        // ── 4. Validate Structured JSON with Zod ──
        const validation = validateModerationOutput(rawResponseText);
        if (!validation.success || !validation.data) {
          // Schema validation failure
          console.warn(`[MODERATION] Model ${modelName} returned invalid schema: ${validation.error}`);

          // If attempt 0, retry once for invalid schema on same model
          if (attempt === 0) {
            await sleepFn(calculateBackoffMs(attempt));
            continue;
          }

          // Otherwise, proceed to next model in cascade
          break;
        }

        // Successfully validated structured response!
        return {
          ...validation.data,
          model_id: modelName,
          model_version: 'v3.4',
          ai_policy_version: AI_CONFIG.versions.aiPolicyVersion,
          instruction_version: AI_CONFIG.versions.instructionVersion,
          prompt_hash: promptHash,
          generation_config: AI_CONFIG.generationConfig,
          fallback_used: fallbackUsed,
          deterministic_filter_used: false,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable = isRetryableAiError(lastError);

        console.warn(
          `[MODERATION] Model ${modelName} attempt ${attempt + 1}/${AI_CONFIG.retryPolicy.maxRetriesPerModel + 1} failed: ${lastError.message} (retryable: ${retryable})`
        );

        if (!retryable) {
          // Non-retryable error (e.g. invalid request format, bad prompt)
          // Do not attempt retry on same model; break to cascade or fail
          break;
        }

        if (attempt < AI_CONFIG.retryPolicy.maxRetriesPerModel) {
          const delay = calculateBackoffMs(attempt);
          await sleepFn(delay);
        }
      }
    }

    console.warn(`[MODERATION] Model ${modelName} exhausted. Cascading to next fallback...`);
  }

  // ── 5. All Models in Cascade Exhausted ──
  // Fallback to pending_review — NEVER silently reject due to AI/network downtime
  console.error('[MODERATION] All models in cascade failed. Routing confession to pending_review.', lastError);

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
