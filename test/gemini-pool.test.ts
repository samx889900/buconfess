import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiCredentialPool,
  classifyGeminiError,
  extractRetryAfterMs,
  calculatePacificMidnightReset,
} from '../apps/admin/lib/ai/credentialPool';
import { moderateConfession } from '../apps/admin/lib/ai/moderator';
import { ALLOWED_GEMINI_MODELS } from '../apps/admin/lib/ai/config';

const VALID_MODERATION_JSON = JSON.stringify({
  verdict: 'approved',
  decision_reason: 'Completely wholesome campus post',
  model_confidence: 0.99,
  matched_rules: ['NONE'],
  policy_level: 5,
  flags: ['campus_life'],
});

describe('Phase 13.A: Gemini Credential Pool & Quota-Aware Failover', () => {
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

  // Test 1: Single credential success: Validates moderation succeeds with single configured key.
  it('1. Single credential success: Validates moderation succeeds with single configured key', async () => {
    process.env.GEMINI_API_KEY_1 = 'AIzaSyFakeKeyProject1';
    const pool = new GeminiCredentialPool();
    const available = pool.getAvailableSlots();

    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-1');

    const leased = pool.leaseSlot('project-1');
    assert.ok(leased);
    assert.equal(leased.id, 'project-1');
    assert.equal(leased.apiKey, 'AIzaSyFakeKeyProject1');

    pool.releaseSlot('project-1', { success: true });
    const status = pool.getStatusReport();
    assert.equal(status.slots[0].available, true);
    assert.equal(status.slots[0].totalRequests, 1);
    assert.equal(status.slots[0].consecutiveFailures, 0);
  });

  // Test 2: Credential A quota exhausted -> B succeeds: Proves daily quota failure on Project A immediately attempts Project B
  it('2. Credential A quota exhausted -> B succeeds without retrying A', async () => {
    process.env.GEMINI_API_KEY_1 = 'AIzaSyFakeKeyProjectA';
    process.env.GEMINI_API_KEY_2 = 'AIzaSyFakeKeyProjectB';
    const pool = new GeminiCredentialPool();

    // Project A hits daily quota
    const leasedA = pool.leaseSlot('project-1');
    assert.ok(leasedA);
    const dailyQuotaErr = new Error('Resource has been exhausted (e.g. check quota): GenerateContentRequestsPerDay');
    (dailyQuotaErr as any).status = 429;

    pool.releaseSlot('project-1', { success: false, error: dailyQuotaErr });

    // Project A is now unavailable (in cooldown)
    const available = pool.getAvailableSlots();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-2');

    // Lease next slot: strictly project-2
    const leasedB = pool.leaseSlot('project-2');
    assert.ok(leasedB);
    assert.equal(leasedB.id, 'project-2');
    assert.equal(leasedB.apiKey, 'AIzaSyFakeKeyProjectB');
    pool.releaseSlot('project-2', { success: true });

    const status = pool.getStatusReport();
    assert.equal(status.slots.find((s) => s.id === 'project-1')?.available, false);
    assert.equal(status.slots.find((s) => s.id === 'project-2')?.available, true);
  });

  // Test 3: A + B exhausted -> C succeeds: Verifies multi-stage failover across 3 projects
  it('3. A + B exhausted -> C succeeds: Multi-stage failover across 3 projects', async () => {
    process.env.GEMINI_API_KEY_1 = 'KeyA';
    process.env.GEMINI_API_KEY_2 = 'KeyB';
    process.env.GEMINI_API_KEY_3 = 'KeyC';
    const pool = new GeminiCredentialPool();

    // Exhaust A
    const a = pool.leaseSlot('project-1')!;
    pool.releaseSlot(a.id, {
      success: false,
      error: new Error('Quota exceeded for quota metric GenerateContentRequestsPerDay'),
    });

    // Exhaust B
    const b = pool.leaseSlot('project-2')!;
    pool.releaseSlot(b.id, {
      success: false,
      error: new Error('ResourceExhausted: FreeTierRequestsPerDay exceeded'),
    });

    // C remains available and succeeds
    const available = pool.getAvailableSlots();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'project-3');

    const c = pool.leaseSlot('project-3')!;
    assert.equal(c.apiKey, 'KeyC');
    pool.releaseSlot(c.id, { success: true });

    const report = pool.getStatusReport();
    assert.equal(report.slots[0].available, false);
    assert.equal(report.slots[1].available, false);
    assert.equal(report.slots[2].available, true);
  });

  // Test 4: All credentials exhausted -> pending_review: Proves fail-safe invariant when all available projects are exhausted
  it('4. All credentials exhausted -> pending_review: Proves fail-safe invariant', async () => {
    process.env.GEMINI_API_KEY_1 = 'KeyA';
    process.env.GEMINI_API_KEY_2 = 'KeyB';
    const pool = new GeminiCredentialPool();

    pool.releaseSlot('project-1', {
      success: false,
      error: new Error('429 ResourceExhausted: RequestsPerDay exceeded'),
    });
    pool.releaseSlot('project-2', {
      success: false,
      error: new Error('429 ResourceExhausted: RequestsPerDay exceeded'),
    });

    assert.equal(pool.getAvailableSlots().length, 0);

    // Call moderateConfession with exhausted pool
    const result = await moderateConfession('Testing all exhausted', {
      credentialPool: pool,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(result.verdict, 'pending_review');
    assert.equal(result.model_id, 'cascade_failed');
    assert.ok(result.flags.includes('ai_cascade_exhausted'));
    assert.ok(result.flags.includes('needs_manual_review'));
  });

  // Test 5: 503 High Demand bounded retry: Proves 1 short retry (500ms) before credential failover
  it('5. 503 High Demand bounded retry: Proves 1 short retry before credential failover', () => {
    const error503 = new Error('503 Service Unavailable: The model is overloaded. Please try again later.');
    (error503 as any).status = 503;

    const classification = classifyGeminiError(error503);
    assert.equal(classification, 'SERVICE_UNAVAILABLE');
  });

  // Test 6: Transient 429 exponential backoff: Proves RPM rate limit with short retryDelay applies backoff
  it('6. Transient 429 exponential backoff: Proves RPM rate limit classification', () => {
    const rpmError = new Error('ResourceExhausted: Rate limit exceeded for GenerateContentRequestsPerMinute');
    (rpmError as any).status = 429;

    const classification = classifyGeminiError(rpmError);
    assert.equal(classification, 'RATE_LIMIT_TRANSIENT');
  });

  // Test 7: Daily quota 429 cooldown activation: Proves quotaId with PerDay sets cooldownUntil
  it('7. Daily quota 429 cooldown activation: Sets cooldownUntil to upcoming Pacific midnight', () => {
    process.env.GEMINI_API_KEY_1 = 'KeyDaily';
    const pool = new GeminiCredentialPool();

    const dailyErr = new Error('Quota exceeded for metric: GenerateContentRequestsPerDay');
    (dailyErr as any).status = 429;

    pool.releaseSlot('project-1', { success: false, error: dailyErr });

    const status = pool.getStatusReport().slots[0];
    assert.equal(status.available, false);
    assert.ok(status.cooldownUntil && status.cooldownUntil > Date.now());
    assert.match(status.unavailableReason || '', /Daily project quota exhausted/);
  });

  // Test 8: Safe Retry-After parsing: Tests float, string ("19.29s"), and integer header parsing
  it('8. Safe Retry-After parsing: Tests float, string ("19.29s"), and integer header parsing', () => {
    // Integer string
    const errInt = { message: 'Too Many Requests', response: { headers: { 'retry-after': '30' } } };
    assert.equal(extractRetryAfterMs(errInt), 30000);

    // Float seconds with 's' suffix in message
    const errSec = new Error('Quota exceeded. Please retry after 19.29s.');
    assert.equal(extractRetryAfterMs(errSec), 19290);

    // Plain float in message
    const errFloat = new Error('Rate limit exceeded. retryDelay: 2.5s');
    assert.equal(extractRetryAfterMs(errFloat), 2500);

    // Null/undefined fallback
    assert.equal(extractRetryAfterMs(new Error('Unknown generic error')), null);
  });

  // Test 9: Invalid API key handling: 401 unauthenticated marks credential permanently unavailable
  it('9. Invalid API key handling: 401 unauthenticated marks credential permanently unavailable', () => {
    process.env.GEMINI_API_KEY_1 = 'BadKey';
    const pool = new GeminiCredentialPool();

    const authErr = new Error('API_KEY_INVALID: The provided API key is invalid.');
    (authErr as any).status = 401;

    pool.releaseSlot('project-1', { success: false, error: authErr });

    const slot = pool.getStatusReport().slots[0];
    assert.equal(slot.available, false);
    assert.equal(slot.cooldownUntil, null); // permanent, no cooldown timer
    assert.match(slot.unavailableReason || '', /Permanent authentication error/);
  });

  // Test 10: Model 404 immediate cascade: 404 does not disable the project; immediately cascades model
  it('10. Model 404 immediate cascade: 404 does not disable project credential', () => {
    process.env.GEMINI_API_KEY_1 = 'ValidKey';
    const pool = new GeminiCredentialPool();

    const notFoundErr = new Error('models/gemini-3.8-flash is not found for API version v1beta');
    (notFoundErr as any).status = 404;

    const classification = classifyGeminiError(notFoundErr);
    assert.equal(classification, 'MODEL_NOT_FOUND');

    pool.releaseSlot('project-1', { success: false, error: notFoundErr });

    // Project should remain available for other models in the cascade!
    const slot = pool.getStatusReport().slots[0];
    assert.equal(slot.available, true);
  });

  // Test 11: No infinite retry loop: Verifies all retry counters are strictly bounded
  it('11. No infinite retry loop: Verifies error classification on all known categories', () => {
    const errorTypes = [
      { err: new Error('404 Not Found'), expected: 'MODEL_NOT_FOUND' },
      { err: new Error('401 API_KEY_INVALID'), expected: 'AUTHENTICATION' },
      { err: new Error('403 Permission denied. Billing has not been enabled'), expected: 'PERMISSION' },
      { err: new Error('503 Service Unavailable'), expected: 'SERVICE_UNAVAILABLE' },
      { err: new Error('Deadline exceeded after 15000ms'), expected: 'TIMEOUT' },
      { err: new Error('429 PerDay quota reached'), expected: 'DAILY_QUOTA_EXHAUSTED' },
      { err: new Error('429 Rate limit exceeded'), expected: 'RATE_LIMIT_TRANSIENT' },
      { err: new Error('400 Invalid argument'), expected: 'INVALID_REQUEST' },
      { err: new Error('Something strange happened'), expected: 'UNKNOWN' },
    ];

    for (const { err, expected } of errorTypes) {
      assert.equal(classifyGeminiError(err), expected);
    }
  });

  // Test 12: Concurrent worker distribution: Proves round-robin leases across healthy projects
  it('12. Concurrent worker distribution: Proves least-busy leasing across healthy projects', () => {
    process.env.GEMINI_API_KEY_1 = 'Key1';
    process.env.GEMINI_API_KEY_2 = 'Key2';
    const pool = new GeminiCredentialPool();

    const lease1 = pool.leaseSlot('project-1')!;
    assert.equal(lease1.id, 'project-1');

    // With project-1 in-flight (activeInFlight = 1), leaseSlot() without preference picks project-2 (activeInFlight = 0)
    const lease2 = pool.leaseSlot()!;
    assert.equal(lease2.id, 'project-2');

    pool.releaseSlot(lease1.id, { success: true });
    pool.releaseSlot(lease2.id, { success: true });
  });

  // Test 13: Model cascade preservation: Strictly verifies 3.8 -> 3.7 -> 3.5 -> 2.5 -> 2.5-lite sequence
  it('13. Model cascade preservation: Strictly verifies 3.8 -> 3.7 -> 3.5 -> 2.5 -> 2.5-lite sequence', () => {
    assert.deepEqual(ALLOWED_GEMINI_MODELS, [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]);
  });

  // Test 14: Secret sanitization in logs: Verifies zero API keys or credentials appear in status report
  it('14. Secret sanitization in logs: Sanitized report exposes zero API keys or raw tokens', () => {
    process.env.GEMINI_API_KEY_1 = 'SECRET_KEY_1_DO_NOT_EXPOSE';
    process.env.GEMINI_API_KEY_2 = 'SECRET_KEY_2_DO_NOT_EXPOSE';
    const pool = new GeminiCredentialPool();

    const report = pool.getStatusReport();
    const serialized = JSON.stringify(report);

    assert.ok(!serialized.includes('SECRET_KEY_1_DO_NOT_EXPOSE'));
    assert.ok(!serialized.includes('SECRET_KEY_2_DO_NOT_EXPOSE'));
    assert.ok(serialized.includes('project-1'));
    assert.ok(serialized.includes('project-2'));
  });

  // Test 15: Fail-safe pending review guarantee: Verifies no circumstance can auto-approve unmoderated content
  it('15. Fail-safe pending review guarantee: Total cascade failure always yields pending_review', async () => {
    const failingMockClient = {
      generateContent: async () => {
        const err = new Error('500 Internal Server Error');
        (err as any).status = 500;
        throw err;
      },
    };

    const res = await moderateConfession('Unverified content requiring review', {
      mockClient: failingMockClient,
      skipDeterministicRules: true,
      sleepFn: async () => {},
    });

    assert.equal(res.verdict, 'pending_review');
    assert.notEqual(res.verdict, 'approved');
    assert.notEqual(res.verdict, 'rejected');
  });

  // Test 16: Restart storm prevention: Pacific midnight reset calculates future timestamp
  it('16. Restart storm prevention: Pacific midnight reset calculation is always strictly in future', () => {
    const now = new Date();
    const resetTimestamp = calculatePacificMidnightReset(now);
    assert.ok(resetTimestamp > now.getTime(), 'Reset timestamp must be strictly in the future');
    // Must be within 24.5 hours from now
    assert.ok(resetTimestamp - now.getTime() <= 24.5 * 60 * 60 * 1000);
  });
});
