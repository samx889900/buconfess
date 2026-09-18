// ---------------------------------------------------------------------------
// Moderation Hierarchy & Deterministic Rule Engine (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Implements the 5-level moderation policy hierarchy:
//   L1: Hard Safety (Self-harm, violence, hate speech, illegal acts)
//   L2: Privacy / PII (Phone numbers, emails, room numbers + names, doxxing)
//   L3: Platform Policy (Harassment, targeted bullying, defamation, impersonation)
//   L4: Admin Rules (Commercial ads, spam, exam cheating services)
//   L5: Classification & Campus Life (Harmless crushes, rants, humor)
//
// Deterministic rules run before calling Gemini models to catch unambiguous
// violations immediately and reduce unnecessary API calls.
// ---------------------------------------------------------------------------

import { ModerationOutput } from './schema';

export interface PolicyLevelDefinition {
  level: number;
  name: string;
  description: string;
  defaultVerdictOnMatch: 'rejected' | 'pending_review';
}

export const POLICY_HIERARCHY: Record<number, PolicyLevelDefinition> = {
  1: {
    level: 1,
    name: 'Hard Safety',
    description: 'Imminent self-harm, suicide, physical violence threats, hate speech, severe abuse',
    defaultVerdictOnMatch: 'rejected',
  },
  2: {
    level: 2,
    name: 'Privacy & PII',
    description: 'Direct phone numbers, personal email addresses, doxxing, room + full name combinations',
    defaultVerdictOnMatch: 'rejected',
  },
  3: {
    level: 3,
    name: 'Platform Policy',
    description: 'Targeted bullying, persistent harassment, defamation of named students/faculty, impersonation',
    defaultVerdictOnMatch: 'rejected',
  },
  4: {
    level: 4,
    name: 'Admin & Campus Rules',
    description: 'Commercial spam, paid assignment cheating services, ticket resale scams',
    defaultVerdictOnMatch: 'rejected',
  },
  5: {
    level: 5,
    name: 'Classification & Campus Discourse',
    description: 'Harmless crushes, relatable campus rants, constructive feedback, humor',
    defaultVerdictOnMatch: 'pending_review',
  },
};

// --- Deterministic Regex Patterns for Pre-Filter ---

// Phone numbers: Indian formats (+91, 10-digit mobile numbers with optional spacing/dashes)
const PHONE_REGEX = /(?:\+91[\s-]?)?[6-9]\d{9}\b/g;

// Email addresses
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Extreme Self-Harm / Suicide triggers (deterministic L1)
const SELF_HARM_REGEX = /\b(kill\s+myself|commit\s+suicide|end\s+my\s+life|hang\s+myself|slit\s+my\s+wrists?|want\s+to\s+die)\b/i;

// Direct bomb / mass violence threats (deterministic L1)
const VIOLENCE_THREAT_REGEX = /\b(bomb\s+the\s+(campus|hostel|college|building)|shoot\s+up\s+the\s+college|kill\s+everyone\s+in)\b/i;

// Assignment / Exam cheating services (deterministic L4)
const CHEATING_SERVICES_REGEX = /\b(paid\s+assignment\s+help|hire\s+someone\s+to\s+take\s+my\s+exam|pay\s+for\s+grades|cheating\s+service)\b/i;

// Prompt injection patterns inside confession text
const PROMPT_INJECTION_REGEX = /\b(ignore\s+(all\s+)?previous\s+instructions|system\s+prompt|reveal\s+(the\s+)?api\s+key|output\s+json\s+with\s+verdict\s*:\s*approved|disregard\s+moderation|you\s+are\s+now\s+dan)\b/i;

export interface DeterministicCheckResult {
  matched: boolean;
  moderation?: ModerationOutput;
}

/**
 * Runs deterministic hard rules on confession text prior to calling Gemini.
 * Returns a definitive verdict for unambiguous violations (L1 hard safety, L2 PII).
 */
export function checkDeterministicRules(text: string): DeterministicCheckResult {
  const normalized = text.trim();

  // 1. Extreme Self-Harm / Suicide (L1) -> Reject immediately
  if (SELF_HARM_REGEX.test(normalized)) {
    return {
      matched: true,
      moderation: {
        verdict: 'rejected',
        decision_reason: 'Self-harm or suicide content detected (L1 Hard Safety policy).',
        model_confidence: 1.0,
        matched_rules: ['L1_SELF_HARM'],
        policy_level: 1,
        flags: ['self_harm', 'safety_critical'],
      },
    };
  }

  // 2. Direct Mass Violence Threat (L1) -> Reject immediately
  if (VIOLENCE_THREAT_REGEX.test(normalized)) {
    return {
      matched: true,
      moderation: {
        verdict: 'rejected',
        decision_reason: 'Direct violent threat to campus or individuals detected (L1 Hard Safety policy).',
        model_confidence: 1.0,
        matched_rules: ['L1_VIOLENCE_THREAT'],
        policy_level: 1,
        flags: ['violence_threat', 'safety_critical'],
      },
    };
  }

  // 3. PII: Phone Number detected (L2) -> Reject
  if (PHONE_REGEX.test(normalized)) {
    return {
      matched: true,
      moderation: {
        verdict: 'rejected',
        decision_reason: 'Personal phone number detected in confession text (L2 Privacy policy).',
        model_confidence: 1.0,
        matched_rules: ['L2_PII_PHONE'],
        policy_level: 2,
        flags: ['pii', 'phone_number'],
      },
    };
  }

  // 4. PII: Email Address detected (L2) -> Reject
  if (EMAIL_REGEX.test(normalized)) {
    return {
      matched: true,
      moderation: {
        verdict: 'rejected',
        decision_reason: 'Personal email address detected in confession text (L2 Privacy policy).',
        model_confidence: 1.0,
        matched_rules: ['L2_PII_EMAIL'],
        policy_level: 2,
        flags: ['pii', 'email_address'],
      },
    };
  }

  // 5. Commercial Cheating Service (L4) -> Reject
  if (CHEATING_SERVICES_REGEX.test(normalized)) {
    return {
      matched: true,
      moderation: {
        verdict: 'rejected',
        decision_reason: 'Commercial academic dishonesty or exam cheating solicitation detected (L4 Admin policy).',
        model_confidence: 1.0,
        matched_rules: ['L4_ACADEMIC_CHEATING'],
        policy_level: 4,
        flags: ['spam', 'academic_dishonesty'],
      },
    };
  }

  // 6. Blatant Prompt Injection Attempt -> route to pending_review or reject
  if (PROMPT_INJECTION_REGEX.test(normalized)) {
    return {
      matched: true,
      moderation: {
        verdict: 'pending_review',
        decision_reason: 'Prompt injection attempt detected inside submission text (routed to human review).',
        model_confidence: 0.95,
        matched_rules: ['L3_PROMPT_INJECTION'],
        policy_level: 3,
        flags: ['prompt_injection', 'adversarial_input'],
      },
    };
  }

  // No deterministic rule matched; proceed to AI model cascade
  return { matched: false };
}
