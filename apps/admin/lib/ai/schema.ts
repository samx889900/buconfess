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
export const ModerationOutputSchema = z.object({
  verdict: ModerationVerdictEnum,
  decision_reason: z
    .string()
    .min(1)
    .max(300, 'Decision reason must be concise (max 300 chars)')
    .describe('Concise factual reason for the decision without chain-of-thought'),
  model_confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Model-reported confidence score (metadata only, not calibrated probability)'),
  matched_rules: z
    .array(z.string().min(1).max(50))
    .min(1, 'Must include at least one matched rule code (or NONE)')
    .describe('Policy rule codes matched (e.g. L1_THREAT, L2_PII_PHONE, NONE)'),
  policy_level: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('Highest policy hierarchy level evaluated (1=Hard Safety to 5=Campus Life)'),
  flags: z
    .array(z.string().min(1).max(50))
    .describe('Content categorization tags e.g. ["pii", "crush", "rant", "profanity"]'),
});

export type ModerationOutput = z.infer<typeof ModerationOutputSchema>;

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
