import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moderateConfession } from '../apps/admin/lib/ai/moderator';
import { AI_CONFIG, ALLOWED_GEMINI_MODELS } from '../apps/admin/lib/ai/config';
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

describe('Gemini Moderation Model Cascade (3.8 -> 3.7 -> 3.5 -> 2.5 -> 2.5-lite -> pending_review)', () => {
  // Test 1: 3.8 succeeds -> only 3.8 called
  it('1. 3.8 succeeds -> only 3.8 called', async () => {
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
    assert.equal(res.model_id, 'gemini-3.8-flash');
    assert.equal(res.fallback_used, false);
    assert.deepEqual(calledModels, ['gemini-3.8-flash']);
  });

  // Test 2: 3.8 fails, 3.7 succeeds -> 3.8 then 3.7
  it('2. 3.8 fails, 3.7 succeeds -> 3.8 then 3.7', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
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
    // 3.8 retries once (503), then falls back to 3.7
    assert.deepEqual(calledModels, [
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 3: 3.8 + 3.7 fail, 3.5 succeeds -> 3.8 -> 3.7 -> 3.5
  it('3. 3.8 + 3.7 fail, 3.5 succeeds -> 3.8 -> 3.7 -> 3.5', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.8-flash' || params.model === 'gemini-3.7-flash') {
          const err = new Error('503 Service Unavailable');
          (err as any).status = 503;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Library AC is very cold', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.5-flash');
    assert.equal(res.fallback_used, true);
    assert.deepEqual(calledModels, [
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.7-flash',
      'gemini-3.5-flash',
    ]);
  });

  // Test 4: 3.8 + 3.7 + 3.5 fail, 2.5 succeeds -> 3.8 -> 3.7 -> 3.5 -> 2.5
  it('4. 3.8 + 3.7 + 3.5 fail, 2.5 succeeds -> 3.8 -> 3.7 -> 3.5 -> 2.5', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'].includes(params.model)) {
          const err = new Error('503 Service Unavailable');
          (err as any).status = 503;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Canteen samosas are fresh today', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-2.5-flash');
    assert.equal(res.fallback_used, true);
    assert.ok(calledModels.includes('gemini-2.5-flash'));
  });

  // Test 5: all primary models fail, 2.5-lite succeeds -> all five attempted in order
  it('5. all primary models fail, 2.5-lite succeeds -> all five attempted in order', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model !== 'gemini-2.5-flash-lite') {
          const err = new Error('404 Model Not Found');
          (err as any).status = 404;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Anyone have notes for physics?', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-2.5-flash-lite');
    assert.equal(res.fallback_used, true);
    // All 5 models attempted in exact order (deterministic 404 = 0 retries each)
    assert.deepEqual(calledModels, [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]);
  });

  // Test 6: all models fail -> pending_review
  it('6. all models fail -> pending_review', async () => {
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

  // Test 7: valid rejection from 3.8 -> do NOT call 3.7
  it('7. valid rejection from 3.8 -> do NOT call 3.7', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        return { text: VALID_REJECTION_JSON };
      },
    };

    const res = await moderateConfession('Abusive hate content', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'rejected');
    assert.equal(res.model_id, 'gemini-3.8-flash');
    assert.equal(res.fallback_used, false);
    // Valid rejection is a SUCCESS; do NOT call 3.7
    assert.deepEqual(calledModels, ['gemini-3.8-flash']);
  });

  // Test 8: valid approval from 3.8 -> do NOT call 3.7
  it('8. valid approval from 3.8 -> do NOT call 3.7', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Best cafeteria coffee!', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.8-flash');
    assert.deepEqual(calledModels, ['gemini-3.8-flash']);
  });

  // Test 9: malformed response from 3.8 -> fall back to 3.7
  it('9. malformed response from 3.8 -> fall back to 3.7', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
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

  // Test 10: HTTP 429 from 3.8 -> bounded retry/fallback
  it('10. HTTP 429 from 3.8 -> bounded retry/fallback', async () => {
    const attempts: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        attempts.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
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
    // 3.8 retried once for 429, then cascaded to 3.7
    assert.deepEqual(attempts, [
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 11: HTTP 5xx from 3.8 -> bounded retry/fallback
  it('11. HTTP 5xx from 3.8 -> bounded retry/fallback', async () => {
    const attempts: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        attempts.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          const err = new Error('500 Internal Server Error');
          (err as any).status = 500;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Finals week begins', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.equal(res.fallback_used, true);
    assert.deepEqual(attempts, [
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 12: model-not-found (404) from 3.8 -> immediately proceed to 3.7 (0 retries)
  it('12. model-not-found from 3.8 -> immediately proceed to 3.7', async () => {
    const attempts: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        attempts.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          const err = new Error('404 Model models/gemini-3.8-flash not found');
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
    // Exactly 1 attempt on 3.8 (0 retries on 404), immediately to 3.7
    assert.deepEqual(attempts, [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);
  });

  // Test 13: Zod validation failure -> proceed to next model
  it('13. Zod validation failure -> proceed to next model', async () => {
    const attempts: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        attempts.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          // Missing required fields (decision_reason, verdict invalid)
          return { text: JSON.stringify({ verdict: 'unknown_verdict' }) };
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Looking for room partner', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.equal(res.fallback_used, true);
    assert.ok(attempts.includes('gemini-3.7-flash'));
  });

  // Test 14: configured cascade order is preserved
  it('14. configured cascade order is preserved', () => {
    assert.deepEqual(AI_CONFIG.defaultCascade, [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]);
    for (const model of AI_CONFIG.defaultCascade) {
      assert.ok(
        (ALLOWED_GEMINI_MODELS as readonly string[]).includes(model),
        `Model ${model} must be in allowlist`
      );
    }
  });

  // Test 15: arbitrary/unallowlisted model names are rejected
  it('15. arbitrary/unallowlisted model names are rejected', () => {
    const def = SETTINGS_ALLOWLIST.moderation_model_cascade;

    // Valid cascade passes
    const valid = validateSettingValue(
      def,
      'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash'
    );
    assert.equal(valid, 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash');

    // Arbitrary unallowlisted model name is rejected
    assert.throws(
      () => validateSettingValue(def, 'gemini-custom-arbitrary-model'),
      (err: Error) => {
        assert.match(err.message, /not in the allowed Gemini models allowlist/);
        return true;
      }
    );

    // Old models not in allowlist (e.g. gemini-1.5-flash) rejected
    assert.throws(
      () => validateSettingValue(def, 'gemini-1.5-flash'),
      (err: Error) => {
        assert.match(err.message, /not in the allowed Gemini models allowlist/);
        return true;
      }
    );
  });
});
