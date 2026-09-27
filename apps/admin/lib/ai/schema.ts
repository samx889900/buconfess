import { z } from 'zod';

// ---------------------------------------------------------------------------
// Moderation Structured Output Schema (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Validates Gemini structured output using Zod.
// Strictly strips/rejects any hidden reasoning or chain-of-thought.
// Model confidence is stored purely as model-reported metadata.
// ---------------------------------------------------------------------------

export const ModerationVerdictEnum = z.enum(['approved', 'rejected', 'pending_review']);
export type ModerationVerdict = z.infer<typeof ModerationVerdictEnum>;

/**
 * Strict Zod schema for structured output from Gemini moderation.
 */
export const ModerationOutputSchema = z
  .object({
    verdict: ModerationVerdictEnum,
    decision_reason: z.string().max(300).optional(),
    reason: z.string().max(300).optional(),
    model_confidence: z.number().min(0).max(1).nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    matched_rules: z.array(z.string().min(1).max(50)).optional(),
    policy_level: z.number().int().min(1).max(5).nullable().optional(),
    policyLevel: z.number().int().min(1).max(5).nullable().optional(),
    flags: z.array(z.string().min(1).max(50)).optional(),
  })
  .transform((data) => ({
    verdict: data.verdict,
    decision_reason: (data.decision_reason || data.reason || 'Evaluated by moderation policy').slice(0, 300),
    model_confidence: data.model_confidence ?? data.confidence ?? null,
    matched_rules: data.matched_rules && data.matched_rules.length > 0
      ? data.matched_rules
      : (data.verdict === 'approved' ? ['NONE'] : ['POLICY_VIOLATION']),
    policy_level: (data.policy_level ?? data.policyLevel ?? (data.verdict === 'approved' ? 5 : 2)) as number | null,
    flags: data.flags || [],
  }));

export type ModerationOutput = z.infer<typeof ModerationOutputSchema>;

/**
 * Sanitized telemetry entry for a single model x credential attempt.
 * NEVER includes secrets, API keys, or raw headers.
 */
export interface ModerationTelemetryEntry {
  model: string;
  credential_slot: string;
  attempt_number: number;
  error_class?: string;
  http_status?: number;
  retry_count: number;
  duration_ms: number;
  result:
    | 'success'
    | 'failed'
    | 'rate_limited'
    | 'service_unavailable'
    | 'not_found'
    | 'auth_error'
    | 'permission_error'
    | 'timeout'
    | 'invalid_schema';
  timestamp: string;
}

/**
 * Full moderation result including audit & execution metadata.
 */
export interface ModerationResult extends ModerationOutput {
  model_id: string;
  model_version: string;
  ai_policy_version: number;
  instruction_version: number;
  prompt_hash: string;
  generation_config: Record<string, unknown>;
  fallback_used: boolean;
  deterministic_filter_used: boolean;
  infrastructure_reason?: string;
  telemetry?: ModerationTelemetryEntry[];
}

/**
 * Validates and sanitizes a raw JSON string or object against ModerationOutputSchema.
 * Rejects CoT fields and ensures schema conformance.
 */
export function validateModerationOutput(raw: unknown): {
  success: boolean;
  data?: ModerationOutput;
  error?: string;
} {
  try {
    let parsed = raw;
    if (typeof raw === 'string') {
      // Clean possible markdown code fences (```json ... ```)
      const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
      parsed = JSON.parse(cleaned);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { success: false, error: 'Output is not a valid JSON object' };
    }

    // Explicitly reject any fields resembling chain-of-thought or reasoning
    const obj = parsed as Record<string, unknown>;
    const forbiddenKeys = ['reasoning', 'thought', 'thoughts', 'chain_of_thought', 'cot', 'analysis'];
    for (const key of forbiddenKeys) {
      if (key in obj) {
        // Delete CoT field before storing
        delete obj[key];
      }
    }

    const result = ModerationOutputSchema.safeParse(obj);
    if (!result.success) {
      return {
        success: false,
        error: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      };
    }

    return { success: true, data: result.data };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'JSON parse failure',
    };
  }
}
