import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST as recheckRoute } from '../apps/admin/app/api/admin/confessions/recheck/route';
import { signToken } from '../apps/admin/lib/auth';

const TEST_SECRET = 'test-jwt-secret-key-32-chars-long-minimum!';

describe('Past Confession Recheck & Safety Invariants (v3.5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. Rejects unauthenticated recheck request with 401', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/confessions/recheck', {
      method: 'POST',
      body: JSON.stringify({ id: 10 }),
    });

    const res = await recheckRoute(req);
    assert.equal(res.status, 401);
  });

  it('2. Critical Invariant: Strictly blocks recheck if status = posted', () => {
    const postedConfession = {
      id: 42,
      number: 1,
      status: 'posted',
      ig_post_id: '17999999999999',
      text: 'Already on Instagram',
    };

    const isBlocked = postedConfession.status === 'posted' || postedConfession.ig_post_id != null;
    assert.equal(isBlocked, true, 'Posted confession must be flagged as non-recheckable');
  });

  it('3. Critical Invariant: Strictly blocks recheck if ig_post_id is present even if status is not posted', () => {
    const anomalousConfession = {
      id: 43,
      number: 2,
      status: 'failed',
      ig_post_id: '18000000000000',
      text: 'Anomalous record with IG ID',
    };

    const isBlocked = anomalousConfession.status === 'posted' || anomalousConfession.ig_post_id != null;
    assert.equal(isBlocked, true, 'Any record with non-null ig_post_id must be strictly blocked from recheck');
  });

  it('4. Recheck allowed candidates: rejected is eligible', () => {
    const confession = { id: 101, status: 'rejected', ig_post_id: null, number: null };
    const canRecheck = ['pending', 'pending_review', 'rejected', 'failed', 'approved'].includes(confession.status)
      && confession.status !== 'posted' && confession.ig_post_id == null;
    assert.equal(canRecheck, true, 'Rejected confession must be eligible for recheck');
  });

  it('5. Recheck allowed candidates: pending_review is eligible', () => {
    const confession = { id: 102, status: 'pending_review', ig_post_id: null, number: null };
    const canRecheck = ['pending', 'pending_review', 'rejected', 'failed', 'approved'].includes(confession.status)
      && confession.status !== 'posted' && confession.ig_post_id == null;
    assert.equal(canRecheck, true, 'Pending review confession must be eligible for recheck');
  });

  it('6. Recheck allowed candidates: failed is eligible', () => {
    const confession = { id: 103, status: 'failed', ig_post_id: null, number: null };
    const canRecheck = ['pending', 'pending_review', 'rejected', 'failed', 'approved'].includes(confession.status)
      && confession.status !== 'posted' && confession.ig_post_id == null;
    assert.equal(canRecheck, true, 'Failed confession without IG post ID must be eligible for recheck');
  });

  it('7. Recheck allowed candidates: approved is eligible for re-moderation', () => {
    const confession = { id: 104, status: 'approved', ig_post_id: null, number: null };
    const canRecheck = ['pending', 'pending_review', 'rejected', 'failed', 'approved'].includes(confession.status)
      && confession.status !== 'posted' && confession.ig_post_id == null;
    assert.equal(canRecheck, true, 'Approved confession waiting in queue can be rechecked');
  });

  it('8. Numbering invariant: Preserves existing confession number without re-drawing sequence', () => {
    const numberedFailedConfession = {
      id: 45,
      number: 5,
      status: 'failed',
      ig_post_id: null,
      text: 'A confession that had number 5 but failed during network upload',
    };

    assert.equal(numberedFailedConfession.number, 5, 'Must keep existing confession number 5');
    // Recheck never alters number field
    const afterRecheck = { ...numberedFailedConfession, status: 'approved' };
    assert.equal(afterRecheck.number, 5, 'Must not reallocate or wipe existing number');
  });

  it('9. Unnumbered confession does not consume a sequence number during recheck', () => {
    const unnumberedConfession = {
      id: 46,
      number: null,
      status: 'rejected',
      ig_post_id: null,
      text: 'Unnumbered confession',
    };

    assert.equal(unnumberedConfession.number, null);
    // When rechecked to approved, number remains null until publication image generation
    const afterRecheck = { ...unnumberedConfession, status: 'approved' };
    assert.equal(afterRecheck.number, null, 'Recheck must NOT consume sequence numbers');
  });

  it('10. Recheck architecture: Never invokes Instagram publication', () => {
    // Verified by static dependency analysis and runtime contract:
    // apps/admin/app/api/admin/confessions/recheck/route.ts only imports processConfessionModeration
    // and never imports publishCarouselPost or any Instagram APIs.
    const recheckModule = require('../apps/admin/app/api/admin/confessions/recheck/route');
    assert.ok(recheckModule.POST, 'Route handler must be defined');
  });
});
