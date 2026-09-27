import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moderateConfession } from '../apps/admin/lib/ai/moderator';
import { AI_CONFIG, ALLOWED_GEMINI_MODELS, MODERATION_MODELS } from '../apps/admin/lib/ai/config';
import { validateSettingValue, SETTINGS_ALLOWLIST } from '../apps/admin/lib/settings';

const VALID_APPROVAL_JSON = JSON.stringify({
  verdict: 'approved',
  decision_reason: 'Harmless college confession',
  model_confidence: 0.95,
  matched_rules: ['NONE'],
  policy_level: 5,
  flags: ['campus_life'],
});

const VALID_REJECTION_JSON = JSON.stringify({
  verdict: 'rejected',
  decision_reason: 'Contains explicit hate speech',
  model_confidence: 0.98,
  matched_rules: ['L1_HATE_SPEECH'],
  policy_level: 1,
  flags: ['hate_speech'],
});

const CONFIDENT_PENDING_REVIEW_JSON = JSON.stringify({
  verdict: 'pending_review',
  decision_reason: 'Confession contains full student name raising privacy concerns',
  model_confidence: 0.85,
  matched_rules: ['L4_PRIVACY_NAMED_STUDENT'],
  policy_level: 4,
  flags: ['privacy_concern'],
});

const AMBIGUOUS_PENDING_REVIEW_JSON = JSON.stringify({
  verdict: 'pending_review',
  decision_reason: 'Unclear context whether mention is derogatory',
  model_confidence: 0.50,
  matched_rules: ['AMBIGUOUS_CONTEXT'],
  policy_level: 4,
  flags: ['ambiguity'],
});

describe('Gemini Moderation Hierarchy (3.5 Primary -> 3.7 Ambiguity -> 3.8 Tertiary)', () => {
  // Test 1: 3.5 succeeds with approval -> only 3.5 called (1 request!)
  it('1. 3.5 succeeds with approval -> only 3.5 called (1 request)', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Loving the campus sunset!', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.5-flash');
    assert.equal(res.fallback_used, false);
    assert.deepEqual(calledModels, ['gemini-3.5-flash']);
  });

  // Test 2: 3.5 succeeds with rejection -> only 3.5 called (1 request!)
  it('2. 3.5 succeeds with rejection -> only 3.5 called (1 request)', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        return { text: VALID_REJECTION_JSON };
      },
    };

    const res = await moderateConfession('Hate speech submission', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'rejected');
    assert.equal(res.model_id, 'gemini-3.5-flash');
    assert.equal(res.fallback_used, false);
    assert.deepEqual(calledModels, ['gemini-3.5-flash']);
  });

  // Test 3: 3.5 succeeds with confident pending_review (e.g. #38) -> only 3.5 called, STOP immediately!
  it('3. 3.5 succeeds with confident pending_review -> only 3.5 called (no escalation)', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        return { text: CONFIDENT_PENDING_REVIEW_JSON };
      },
    };

    const res = await moderateConfession('Confession mentioning student Rahul Sharma from CSE dept', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'pending_review');
    assert.equal(res.model_id, 'gemini-3.5-flash');
    assert.equal(res.fallback_used, false);
    // Confident pending_review is success — does NOT escalate!
    assert.deepEqual(calledModels, ['gemini-3.5-flash']);
  });

  // Test 4: 3.5 returns ambiguous pending_review (confidence < 0.6) -> escalates to 3.7
  it('4. 3.5 ambiguous pending_review -> escalates to 3.7 for ambiguity resolution', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.5-flash') {
          return { text: AMBIGUOUS_PENDING_REVIEW_JSON };
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Subtle inside joke about professor', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.equal(res.fallback_used, true);
    assert.deepEqual(calledModels, ['gemini-3.5-flash', 'gemini-3.7-flash']);
  });

  // Test 5: 3.5 ambiguous -> 3.7 ambiguous -> escalates to 3.8
  it('5. 3.5 ambiguous -> 3.7 ambiguous -> escalates to 3.8 tertiary', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.5-flash' || params.model === 'gemini-3.7-flash') {
          return { text: AMBIGUOUS_PENDING_REVIEW_JSON };
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Complex borderline confession', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.8-flash');
    assert.equal(res.fallback_used, true);
    assert.deepEqual(calledModels, [
      'gemini-3.5-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
    ]);
  });

  // Test 6: 3.5 fails with 503 -> retried once on 3.5 -> falls back to 3.7
  it('6. 3.5 fails with 503 -> bounded retry -> falls back to 3.7', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.5-flash') {
          const err = new Error('503 Service Unavailable');
          (err as any).status = 503;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Exam study group today', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.equal(res.fallback_used, true);
    // 3.5 retries once (503), then falls back to 3.7
    assert.deepEqual(calledModels, [
      'gemini-3.5-flash',
      'gemini-3.5-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 7: 3.5 fails with 429 -> bounded retry -> falls back to 3.7
  it('7. 3.5 fails with 429 -> bounded retry -> falls back to 3.7', async () => {
    const attempts: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        attempts.push(params.model);
        if (params.model === 'gemini-3.5-flash') {
          const err = new Error('429 Rate limit exceeded');
          (err as any).status = 429;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Midterms done!', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.equal(res.fallback_used, true);
    assert.deepEqual(attempts, [
      'gemini-3.5-flash',
      'gemini-3.5-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 8: 3.5 fails with 404 (model not found) -> immediately cascades to 3.7 (0 retries)
  it('8. 3.5 model-not-found 404 -> immediately proceeds to 3.7 without retrying 404', async () => {
    const attempts: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        attempts.push(params.model);
        if (params.model === 'gemini-3.5-flash') {
          const err = new Error('404 Model models/gemini-3.5-flash not found');
          (err as any).status = 404;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Campus festival next week', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    // Exactly 1 attempt on 3.5 (0 retries on 404), immediately to 3.7
    assert.deepEqual(attempts, [
      'gemini-3.5-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 9: malformed JSON from 3.5 -> retries once -> falls back to 3.7
  it('9. malformed response from 3.5 -> retry -> falls back to 3.7', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.5-flash') {
          return { text: 'Not valid JSON at all!' };
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Great sports day', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.equal(res.fallback_used, true);
    assert.ok(calledModels.includes('gemini-3.7-flash'));
  });

  // Test 10: all 3 models fail -> safe pending_review
  it('10. all 3 models fail -> safe pending_review (cascade_failed)', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        const err = new Error('503 Service Unavailable');
        (err as any).status = 503;
        throw err;
      },
    };

    const res = await moderateConfession('Can someone share the timetable?', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'pending_review');
    assert.equal(res.model_id, 'cascade_failed');
    assert.ok(res.flags.includes('ai_cascade_exhausted'));
    assert.ok(res.flags.includes('needs_manual_review'));
  });

  // Test 11: configured cascade order is preserved
  it('11. configured cascade order is preserved (3.5 -> 3.7 -> 3.8)', () => {
    assert.deepEqual(AI_CONFIG.defaultCascade, [
      'gemini-3.5-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
    ]);
    for (const model of AI_CONFIG.defaultCascade) {
      assert.ok(
        (ALLOWED_GEMINI_MODELS as readonly string[]).includes(model),
        `Model ${model} must be in allowlist`
      );
    }
  });

  // Test 12: arbitrary/unallowlisted model names are rejected
  it('12. arbitrary/unallowlisted model names are rejected', () => {
    const def = SETTINGS_ALLOWLIST.moderation_model_cascade;

    // Valid cascade passes
    const valid = validateSettingValue(
      def,
      'gemini-3.5-flash,gemini-3.7-flash,gemini-3.8-flash'
    );
    assert.equal(valid, 'gemini-3.5-flash,gemini-3.7-flash,gemini-3.8-flash');

    // Arbitrary unallowlisted model name is rejected
    assert.throws(
      () => validateSettingValue(def, 'gemini-custom-arbitrary-model'),
      (err: Error) => {
        assert.match(err.message, /not in the allowed Gemini models allowlist/);
        return true;
      }
    );

    // Old models not in allowlist (e.g. gemini-2.5-flash, gemini-1.5-flash) rejected
    assert.throws(
      () => validateSettingValue(def, 'gemini-2.5-flash'),
      (err: Error) => {
        assert.match(err.message, /not in the allowed Gemini models allowlist/);
        return true;
      }
    );
  });
});
