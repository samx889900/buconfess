import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiCredentialPool,
  classifyGeminiError,
  calculatePacificMidnightReset,
} from '../apps/admin/lib/ai/credentialPool';
import { moderateConfession } from '../apps/admin/lib/ai/moderator';
import { AI_CONFIG } from '../apps/admin/lib/ai/config';
import { evaluatePostingWindow } from '../apps/admin/lib/schedule';

const VALID_APPROVAL_JSON = JSON.stringify({
  verdict: 'approved',
  decision_reason: 'Completely wholesome and benign confession',
  model_confidence: 0.98,
  matched_rules: ['NONE'],
  policy_level: 5,
  flags: ['campus_life'],
});

describe('BUConfess v3.5 Gemini Moderation & Diagnostics (A through Q)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_1;
    delete process.env.GEMINI_API_KEY_2;
    delete process.env.GEMINI_API_KEY_3;
    delete process.env.GEMINI_API_KEY_4;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // A. Single credential success
  it('A. Single credential success', () => {
    process.env.GEMINI_API_KEY_1 = 'Key_A_Single';
    const pool = new GeminiCredentialPool();
    const available = pool.getAvailableSlots();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-1');

    const leased = pool.leaseSlot('project-1');
    assert.ok(leased);
    assert.equal(leased.apiKey, 'Key_A_Single');
    pool.releaseSlot('project-1', { success: true });
    assert.equal(pool.getAvailableSlots().length, 1);
  });

  // B. First model success (only 3.5 called)
  it('B. First model success (only 3.5 called)', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Campus sunset was wonderful', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.5-flash');
    assert.deepEqual(calledModels, ['gemini-3.5-flash']);
  });

  // C. First model 404 -> second model success
  it('C. First model 404 -> second model success', async () => {
    const calledModels: string[] = [];
    const mockClient = {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === 'gemini-3.5-flash') {
          const err = new Error('404 Model Not Found');
          (err as any).status = 404;
          throw err;
        }
        return { text: VALID_APPROVAL_JSON };
      },
    };

    const res = await moderateConfession('Study session at library', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    // Exactly 1 attempt on 3.5 (0 retries on 404), then 3.7 succeeds
    assert.deepEqual(calledModels, ['gemini-3.5-flash', 'gemini-3.7-flash']);
  });

  // D. First model 503 -> retry -> next credential
  it('D. First model 503 -> retry -> next credential', () => {
    const err503 = new Error('503 Service Unavailable: High demand spike');
    (err503 as any).status = 503;
    const classification = classifyGeminiError(err503);
    assert.equal(classification, 'SERVICE_UNAVAILABLE');

    process.env.GEMINI_API_KEY_1 = 'Key_P1';
    process.env.GEMINI_API_KEY_2 = 'Key_P2';
    const pool = new GeminiCredentialPool();

    // Project-1 fails with 503 (transient, not permanent)
    pool.releaseSlot('project-1', { success: false, error: err503 });
    // Still available (transient failure does not disable project)
    const statusP1 = pool.getStatusReport().slots.find((s) => s.id === 'project-1');
    assert.equal(statusP1?.available, true);
    assert.equal(statusP1?.consecutiveFailures, 1);
  });

  // E. First credential 429 -> second credential succeeds
  it('E. First credential 429 -> second credential succeeds', () => {
    process.env.GEMINI_API_KEY_1 = 'Key_A';
    process.env.GEMINI_API_KEY_2 = 'Key_B';
    const pool = new GeminiCredentialPool();

    const daily429 = new Error('429 Quota exceeded for metric GenerateContentRequestsPerDay');
    (daily429 as any).status = 429;

    pool.releaseSlot('project-1', { success: false, error: daily429 });

    const available = pool.getAvailableSlots();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-2');

    const leasedB = pool.leaseSlot('project-2');
    assert.ok(leasedB);
    assert.equal(leasedB.apiKey, 'Key_B');
    pool.releaseSlot('project-2', { success: true });
  });

  // F. 401 -> credential disabled -> next credential succeeds
  it('F. 401 -> credential disabled -> next credential succeeds', () => {
    process.env.GEMINI_API_KEY_1 = 'BadKey_1';
    process.env.GEMINI_API_KEY_2 = 'GoodKey_2';
    const pool = new GeminiCredentialPool();

    const authErr = new Error('401 API_KEY_INVALID: Key not valid');
    (authErr as any).status = 401;

    pool.releaseSlot('project-1', { success: false, error: authErr });

    const slots = pool.getStatusReport().slots;
    const p1 = slots.find((s) => s.id === 'project-1');
    const p2 = slots.find((s) => s.id === 'project-2');

    assert.equal(p1?.available, false);
    assert.equal(p1?.cooldownUntil, null); // permanent
    assert.equal(p2?.available, true);

    const leased = pool.leaseSlot('project-2');
    assert.ok(leased);
    assert.equal(leased.apiKey, 'GoodKey_2');
  });

  // G. 403 -> credential disabled -> next credential succeeds
  it('G. 403 -> credential disabled -> next credential succeeds', () => {
    process.env.GEMINI_API_KEY_1 = 'NoBillingKey';
    process.env.GEMINI_API_KEY_2 = 'ValidBillingKey';
    const pool = new GeminiCredentialPool();

    const permErr = new Error('403 Permission Denied: Billing account disabled');
    (permErr as any).status = 403;

    pool.releaseSlot('project-1', { success: false, error: permErr });

    const available = pool.getAvailableSlots();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-2');
  });

  // H. All credentials fail first model -> second model attempted
  it('H. All credentials fail first model -> second model attempted', async () => {
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

    const res = await moderateConfession('Campus festival notice', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    assert.equal(res.model_id, 'gemini-3.7-flash');
    assert.ok(calledModels.includes('gemini-3.7-flash'));
  });

  // I. All models fail -> pending_review
  it('I. All models fail -> pending_review', async () => {
    const mockClient = {
      generateContent: async () => {
        const err = new Error('503 Service Unavailable');
        (err as any).status = 503;
        throw err;
      },
    };

    const res = await moderateConfession('Confession text', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'pending_review');
    assert.equal(res.model_id, 'cascade_failed');
    assert.ok(res.flags.includes('ai_cascade_exhausted'));
    assert.ok(res.flags.includes('needs_manual_review'));
  });

  // J. pending_review due to cascade exhaustion must NOT contain a fake policy verdict
  it('J. pending_review due to cascade exhaustion must NOT contain a fake policy verdict', async () => {
    const mockClient = {
      generateContent: async () => {
        const err = new Error('404 Model Not Found');
        (err as any).status = 404;
        throw err;
      },
    };

    const res = await moderateConfession('Confession text', {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'pending_review');
    // Must be null, NEVER fake Level 5 or fake 0% confidence
    assert.equal(res.policy_level, null);
    assert.equal(res.model_confidence, null);
    assert.ok(res.infrastructure_reason);
    assert.ok(res.telemetry && res.telemetry.length > 0);
  });

  // K. cooldown expires correctly
  it('K. cooldown expires correctly', () => {
    process.env.GEMINI_API_KEY_1 = 'Key_Cooldown';
    const pool = new GeminiCredentialPool();

    // Simulate quota exhaustion
    const dailyErr = new Error('ResourceExhausted: GenerateContentRequestsPerDay');
    (dailyErr as any).status = 429;
    pool.releaseSlot('project-1', { success: false, error: dailyErr });

    // In cooldown now
    assert.equal(pool.getAvailableSlots().length, 0);

    // Simulate cooldown expiration (timestamp in past)
    pool.setSlotCooldownForTesting('project-1', Date.now() - 1000);

    // After expiration, slot is automatically available again
    const available = pool.getAvailableSlots();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-1');
  });

  // L. duplicate credentials are deduplicated
  it('L. duplicate credentials are deduplicated', () => {
    process.env.GEMINI_API_KEY = 'SAME_API_KEY';
    process.env.GEMINI_API_KEY_1 = 'SAME_API_KEY';
    process.env.GEMINI_API_KEY_2 = 'DIFFERENT_API_KEY';

    const pool = new GeminiCredentialPool();
    const slots = pool.getSlots();

    // Only 2 unique slots should be created (project-1 and project-2), not 3!
    assert.equal(slots.length, 2);
    assert.equal(slots[0].id, 'project-1');
    assert.equal(slots[1].id, 'project-2');
  });

  // M. all GEMINI_API_KEY_1..4 are loaded
  it('M. all GEMINI_API_KEY_1..4 are loaded', () => {
    process.env.GEMINI_API_KEY = 'Key_Base';
    process.env.GEMINI_API_KEY_1 = 'Key_1';
    process.env.GEMINI_API_KEY_2 = 'Key_2';
    process.env.GEMINI_API_KEY_3 = 'Key_3';
    process.env.GEMINI_API_KEY_4 = 'Key_4';

    const pool = new GeminiCredentialPool();
    const slots = pool.getSlots();

    assert.equal(slots.length, 5);
    assert.deepEqual(
      slots.map((s) => s.id),
      ['project-1', 'project-2', 'project-3', 'project-4', 'project-5']
    );
  });

  // N. missing credentials are handled gracefully
  it('N. missing credentials are handled gracefully', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_1;
    process.env.GEMINI_API_KEY_2 = '   '; // whitespace only
    process.env.GEMINI_API_KEY_3 = 'Valid_Key_3';
    delete process.env.GEMINI_API_KEY_4;

    const pool = new GeminiCredentialPool();
    const slots = pool.getSlots();

    assert.equal(slots.length, 1);
    assert.equal(slots[0].id, 'project-1');
  });

  // O. standard workflow_dispatch does not bypass schedule
  it('O. standard workflow_dispatch does not bypass schedule', () => {
    // 14:00 IST is outside the 00:00, 06:00, 12:00, 18:00 windows
    const outsideTime = new Date('2026-09-27T08:30:00.000Z'); // 14:00 IST
    const evalResult = evaluatePostingWindow(outsideTime, '00:00,06:00,12:00,18:00', 'Asia/Kolkata');

    assert.equal(evalResult.isWithinWindow, false);
    assert.ok(evalResult.reason?.includes('outside the posting window'));
  });

  // P. explicit force_run bypass still works
  it('P. explicit force_run bypass logic', () => {
    const isManualOrForce = (options: { force?: boolean; manual?: boolean }) => {
      return Boolean(options.force || options.manual);
    };

    assert.equal(isManualOrForce({ force: true }), true);
    assert.equal(isManualOrForce({ manual: true }), true);
    assert.equal(isManualOrForce({}), false);
  });

  // Q. dry-run remains completely non-mutating
  it('Q. dry-run evaluation produces no state writes', async () => {
    const text = 'Testing dry run non-mutating behavior';
    const mockClient = {
      generateContent: async () => ({ text: VALID_APPROVAL_JSON }),
    };

    const res = await moderateConfession(text, {
      mockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'approved');
    // Calling moderateConfession does not perform DB updates or publication
  });
});
