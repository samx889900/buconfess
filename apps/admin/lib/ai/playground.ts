// ---------------------------------------------------------------------------
// Moderation Rules Playground (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Security Invariants:
//   1. Strictly dry-run simulation — zero DB mutations, zero production effects.
//   2. Never calls external Meta/Instagram APIs, storage, or image generation.
//   3. Uses deterministic rules engine without triggering paid/external LLMs.
//   4. Returns structured simulation breakdown with active policy hierarchy.
// ---------------------------------------------------------------------------

import { checkDeterministicRules, POLICY_HIERARCHY, PolicyLevelDefinition } from './rules';

export interface PlaygroundResult {
  isSimulation: true;
  inputText: string;
  charCount: number;
  deterministicMatched: boolean;
  verdict: 'approved' | 'rejected' | 'pending_review' | 'pass_to_ai';
  ruleIds: string[];
  flags: string[];
  policyLevel: number | null;
  policyName: string | null;
  decisionReason: string;
  confidence: number;
  stages: {
    stage: string;
    status: 'MATCHED' | 'PASSED' | 'SKIPPED' | 'SIMULATED';
    summary: string;
  }[];
  policyHierarchy: Record<number, PolicyLevelDefinition>;
}

/**
 * Runs a deterministic simulation of BUConfess moderation rules against sample text.
 * Zero database writes, zero external API calls.
 */
export function evaluateRulesPlayground(rawText: string): PlaygroundResult {
  const text = (rawText || '').trim();
  const check = checkDeterministicRules(text);

  if (check.matched && check.moderation) {
    const mod = check.moderation;
    const policyDef = mod.policy_level ? POLICY_HIERARCHY[mod.policy_level] : undefined;

    return {
      isSimulation: true,
      inputText: text,
      charCount: text.length,
      deterministicMatched: true,
      verdict: mod.verdict,
      ruleIds: mod.matched_rules || [],
      flags: mod.flags || [],
      policyLevel: mod.policy_level || null,
      policyName: policyDef?.name || null,
      decisionReason: mod.decision_reason || 'Matched deterministic rule.',
      confidence: mod.model_confidence || 1.0,
      stages: [
        {
          stage: 'Stage 1: Deterministic Pre-Filter',
          status: 'MATCHED',
          summary: `Caught by rule(s): ${(mod.matched_rules || []).join(', ')} (Policy Level ${mod.policy_level}: ${policyDef?.name || 'Unknown'})`,
        },
        {
          stage: 'Stage 2: Gemini AI Model Cascade',
          status: 'SKIPPED',
          summary: 'External model cascade skipped because deterministic rule returned definitive verdict.',
        },
      ],
      policyHierarchy: POLICY_HIERARCHY,
    };
  }

  // Did not match deterministic filters — in production, this would proceed to Gemini cascade
  return {
    isSimulation: true,
    inputText: text,
    charCount: text.length,
    deterministicMatched: false,
    verdict: 'pass_to_ai',
    ruleIds: [],
    flags: [],
    policyLevel: null,
    policyName: null,
    decisionReason:
      'Passed deterministic pre-filter. In production, this text would proceed to Gemini 3.8/3.7/3.6 model cascade for contextual policy evaluation.',
    confidence: 1.0,
    stages: [
      {
        stage: 'Stage 1: Deterministic Pre-Filter',
        status: 'PASSED',
        summary: 'No hard safety (L1), PII (L2), cheating (L4), or injection (L3) regex patterns detected.',
      },
      {
        stage: 'Stage 2: Gemini AI Model Cascade',
        status: 'SIMULATED',
        summary: 'Eligible for contextual evaluation by Gemini model cascade.',
      },
    ],
    policyHierarchy: POLICY_HIERARCHY,
  };
}
