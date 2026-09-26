import { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

import {
  getAdminConfessions,
  getAdminConfessionById,
  getAdminConfessionCounts,
  forceApproveConfession,
  forceRejectConfession,
  rerunAiModeration,
  softDeleteAdminConfession,
  StateTransitionError,
  VALID_CONFESSION_STATUSES,
  FORCE_APPROVE_PERMITTED_STATUSES,
  FORCE_REJECT_PERMITTED_STATUSES,
  RERUN_AI_PERMITTED_STATUSES,
  ConfessionRow,
  ConfessionStatus,
} from '../apps/admin/lib/confessions';
import { getSupabaseAdmin } from '../apps/admin/lib/supabase';
import { middleware } from '../apps/admin/middleware';

// ---------------------------------------------------------------------------
// Load apps/admin/.env if present
// ---------------------------------------------------------------------------
try {
  const envPath = path.join(process.cwd(), 'apps', 'admin', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        const val = v.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn('Could not load .env file:', e);
}

import { signToken } from '../apps/admin/lib/auth';

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-key-for-admin-security-suite-12345';
}

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: unknown) {
  if (condition) {
    passedCount++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failedCount++;
    console.error(`  ❌ [FAIL] ${testName}`, detail || '');
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase Builder
// ---------------------------------------------------------------------------
function createMockSupabase(initialRow: Partial<ConfessionRow> | null = null, mockError: any = null) {
  let currentRow: Partial<ConfessionRow> | null = initialRow ? { ...initialRow } : null;
  const auditLogs: any[] = [];
  const queryState: any = {
    action: null as string | null,
    payload: null as any,
    filters: [] as { col: string; val: any }[],
    rangeVal: null as [number, number] | null,
    limitVal: null as number | null,
  };

  const builder: any = {
    select: () => {
      if (!queryState.action) queryState.action = 'select';
      return builder;
    },
    insert: (p: any) => {
      queryState.action = 'insert';
      queryState.payload = p;
      if (Array.isArray(p)) {
        auditLogs.push(...p);
      } else {
        auditLogs.push(p);
      }
      return builder;
    },
    update: (p: any) => {
      queryState.action = 'update';
      queryState.payload = p;
      if (currentRow) {
        currentRow = { ...currentRow, ...p };
      }
      return builder;
    },
    eq: (col: string, val: any) => {
      queryState.filters.push({ col, val });
      return builder;
    },
    is: (col: string, val: any) => {
      queryState.filters.push({ col, val });
      return builder;
    },
    order: () => builder,
    limit: (n: number) => {
      queryState.limitVal = n;
      return builder;
    },
    range: (from: number, to: number) => {
      queryState.rangeVal = [from, to];
      return builder;
    },
    single: async () => {
      if (mockError) return { data: null, error: mockError };
      return { data: currentRow, error: null };
    },
    maybeSingle: async () => {
      if (mockError) return { data: null, error: mockError };
      return { data: currentRow, error: null };
    },
    then: (resolve: (val: any) => void) => {
      if (mockError) {
        resolve({ data: null, error: mockError });
      } else {
        resolve({ data: currentRow ? [currentRow] : [], error: null });
      }
    },
  };

  const mockClient = {
    from: (_table: string) => builder,
    _getCurrentRow: () => currentRow,
    _getAuditLogs: () => auditLogs,
    _queryState: queryState,
  } as unknown as SupabaseClient & {
    _getCurrentRow: () => Partial<ConfessionRow> | null;
    _getAuditLogs: () => any[];
    _queryState: any;
  };

  return { mockClient, queryState, getRow: () => currentRow, getAuditLogs: () => auditLogs };
}

// ---------------------------------------------------------------------------
// Main Test Runner
// ---------------------------------------------------------------------------
async function runAllTests() {
  console.log('================================================================');
  console.log('PHASE F STEP 3: MODERATION & REVIEW QUEUE TEST SUITE');
  console.log('================================================================\n');

  // =========================================================================
  // Section A: Queue / Filtering
  // =========================================================================
  console.log('--- Section A: Queue & Filtering ---');

  assert(
    VALID_CONFESSION_STATUSES.length === 8,
    'Recognizes exactly 8 state-machine statuses'
  );

  const expectedStatuses = [
    'pending',
    'pending_review',
    'processing',
    'approved',
    'posting',
    'posted',
    'rejected',
    'failed',
  ];
  for (const st of expectedStatuses) {
    assert(
      VALID_CONFESSION_STATUSES.includes(st as ConfessionStatus),
      `Status "${st}" is a valid state-machine status`
    );
  }

  // Test pagination calculation
  {
    const { mockClient, queryState } = createMockSupabase();
    await getAdminConfessions({
      status: 'pending',
      page: 2,
      limit: 20,
      supabaseClient: mockClient,
    });
    assert(queryState.rangeVal !== null, 'Pagination computes range');
    assert(queryState.rangeVal[0] === 20, 'Page 2 starts at offset 20 (limit 20)');
    assert(queryState.rangeVal[1] === 39, 'Page 2 ends at offset 39 (limit 20)');
  }

  // Test soft-delete exclusion by default
  {
    const { mockClient, queryState } = createMockSupabase();
    await getAdminConfessions({
      status: 'all',
      supabaseClient: mockClient,
    });
    assert(
      queryState.filters.some((f: any) => f.col === 'deleted_at' && f.val === null),
      'Excludes soft-deleted records by default (deleted_at IS NULL)'
    );
  }

  // =========================================================================
  // Section B: Force Approve
  // =========================================================================
  console.log('\n--- Section B: Force Approve ---');

  // Valid transitions to approved
  for (const sourceStatus of FORCE_APPROVE_PERMITTED_STATUSES) {
    const { mockClient, getRow, getAuditLogs } = createMockSupabase({
      id: 50,
      text: 'Test confession',
      status: sourceStatus,
      number: null,
      failure_stage: sourceStatus === 'failed' ? 'moderation' : null,
      last_error: sourceStatus === 'failed' ? 'AI timeout' : null,
    });

    const result = await forceApproveConfession(50, {
      reason: 'Manual override',
      actor: 'admin',
      supabaseClient: mockClient,
    });

    assert(result.status === 'approved', `Force Approve succeeds from "${sourceStatus}"`);
    assert(getRow()?.status === 'approved', `State updated to approved in DB from "${sourceStatus}"`);
    assert(getRow()?.number === null, 'Number is untouched and not assigned prematurely');
    if (sourceStatus === 'failed') {
      assert(getRow()?.failure_stage === null, 'Clears previous moderation failure_stage');
      assert(getRow()?.last_error === null, 'Clears previous moderation last_error');
    }
    assert(getAuditLogs().some((l) => l.action === 'admin_force_approve'), 'Creates audit_log record');
  }

  // Idempotent: already approved
  {
    const { mockClient, getRow } = createMockSupabase({
      id: 50,
      text: 'Test confession',
      status: 'approved',
      number: 5,
    });
    const result = await forceApproveConfession(50, { supabaseClient: mockClient });
    assert(result.status === 'approved', 'Already approved confession resolves idempotently');
    assert(getRow()?.status === 'approved', 'Status remains approved');
  }

  // Invalid transitions rejected with 409 StateTransitionError
  const forbiddenFromApprove = ['processing', 'posting', 'posted'];
  for (const st of forbiddenFromApprove) {
    const { mockClient } = createMockSupabase({
      id: 50,
      text: 'Active confession',
      status: st as ConfessionStatus,
    });
    let threw = false;
    try {
      await forceApproveConfession(50, { supabaseClient: mockClient });
    } catch (e) {
      threw = true;
      assert(e instanceof StateTransitionError, `Rejects Force Approve from "${st}" with StateTransitionError`);
      assert((e as StateTransitionError).statusCode === 409, 'Error statusCode is 409 Conflict');
    }
    assert(threw, `Forbidden Force Approve from "${st}" throws error`);
  }

  // =========================================================================
  // Section C: Force Reject
  // =========================================================================
  console.log('\n--- Section C: Force Reject ---');

  // Valid transitions to rejected
  for (const sourceStatus of FORCE_REJECT_PERMITTED_STATUSES) {
    const { mockClient, getRow, getAuditLogs } = createMockSupabase({
      id: 60,
      text: 'Rejected candidate',
      status: sourceStatus,
      number: null,
    });

    const result = await forceRejectConfession(60, {
      reason: 'Harassment detected by human review',
      actor: 'admin',
      supabaseClient: mockClient,
    });

    assert(result.status === 'rejected', `Force Reject succeeds from "${sourceStatus}"`);
    assert(getRow()?.status === 'rejected', `State updated to rejected in DB from "${sourceStatus}"`);
    assert(
      getRow()?.decision_reason === 'Harassment detected by human review',
      'Stores rejection reason in existing decision_reason column'
    );
    assert(getRow()?.deleted_at === undefined || getRow()?.deleted_at === null, 'Confession is NOT physically or soft-deleted');
    assert(getAuditLogs().some((l) => l.action === 'admin_force_reject'), 'Creates audit_log record for rejection');
  }

  // Idempotent: already rejected
  {
    const { mockClient, getRow } = createMockSupabase({
      id: 60,
      text: 'Already rejected',
      status: 'rejected',
    });
    const result = await forceRejectConfession(60, { supabaseClient: mockClient });
    assert(result.status === 'rejected', 'Already rejected confession resolves idempotently');
    assert(getRow()?.status === 'rejected', 'Status remains rejected');
  }

  // Forbidden Force Reject transitions
  const forbiddenFromReject = ['processing', 'posting', 'posted'];
  for (const st of forbiddenFromReject) {
    const { mockClient } = createMockSupabase({
      id: 60,
      text: 'Active confession',
      status: st as ConfessionStatus,
    });
    let threw = false;
    try {
      await forceRejectConfession(60, { supabaseClient: mockClient });
    } catch (e) {
      threw = true;
      assert(e instanceof StateTransitionError, `Rejects Force Reject from "${st}" with 409 StateTransitionError`);
    }
    assert(threw, `Forbidden Force Reject from "${st}" throws error`);
  }

  // =========================================================================
  // Section D: Re-run AI Moderation
  // =========================================================================
  console.log('\n--- Section D: Re-run AI Moderation ---');

  // Valid transitions to pending
  for (const sourceStatus of RERUN_AI_PERMITTED_STATUSES) {
    const { mockClient, getRow, getAuditLogs } = createMockSupabase({
      id: 70,
      text: 'Borderline confession to re-run',
      status: sourceStatus,
      number: 8,
      parts: ['Part 1', 'Part 2'],
      image_urls: ['/image/1.png', '/image/2.png'],
      ig_post_id: null,
      ai_verdict: 'pending_review',
      decision_reason: 'Borderline profanity',
      model_confidence: 0.65,
      matched_rules: ['L3_BORDERLINE'],
      flags: ['ambiguous'],
      policy_level: 3,
      model_id: 'gemini-3.8-flash',
      failure_stage: 'moderation',
      last_error: 'Timeout',
    });

    const result = await rerunAiModeration(70, {
      actor: 'admin',
      supabaseClient: mockClient,
    });

    assert(result.status === 'pending', `Re-run AI transitions from "${sourceStatus}" to "pending"`);
    assert(getRow()?.status === 'pending', 'DB status updated to pending');
    assert(getRow()?.ai_verdict === null, 'ai_verdict reset to null');
    assert(getRow()?.decision_reason === null, 'decision_reason reset to null');
    assert(getRow()?.model_confidence === null, 'model_confidence reset to null');
    assert(getRow()?.matched_rules === null, 'matched_rules reset to null');
    assert(getRow()?.flags === null, 'flags reset to null');
    assert(getRow()?.policy_level === null, 'policy_level reset to null');
    assert(getRow()?.failure_stage === null, 'failure_stage reset to null');
    assert(getRow()?.last_error === null, 'last_error reset to null');

    // Invariant: MUST NOT erase numbering or image history
    assert(getRow()?.number === 8, 'Preserves existing confession number');
    assert(Array.isArray(getRow()?.parts) && getRow()?.parts?.length === 2, 'Preserves slide parts');
    assert(Array.isArray(getRow()?.image_urls) && getRow()?.image_urls?.length === 2, 'Preserves generated image_urls');

    assert(getAuditLogs().some((l) => l.action === 'admin_rerun_ai'), 'Creates audit_log record for re-run');
  }

  // Idempotent: already pending
  {
    const { mockClient, getRow } = createMockSupabase({
      id: 70,
      text: 'Pending confession',
      status: 'pending',
    });
    const result = await rerunAiModeration(70, { supabaseClient: mockClient });
    assert(result.status === 'pending', 'Already pending confession resolves idempotently');
    assert(getRow()?.status === 'pending', 'Status remains pending');
  }

  // Forbidden Re-run AI transitions
  const forbiddenFromRerun = ['processing', 'posting', 'posted'];
  for (const st of forbiddenFromRerun) {
    const { mockClient } = createMockSupabase({
      id: 70,
      text: 'Active confession',
      status: st as ConfessionStatus,
    });
    let threw = false;
    try {
      await rerunAiModeration(70, { supabaseClient: mockClient });
    } catch (e) {
      threw = true;
      assert(e instanceof StateTransitionError, `Rejects Re-run AI from "${st}" with 409 StateTransitionError`);
    }
    assert(threw, `Forbidden Re-run AI from "${st}" throws error`);
  }

  // =========================================================================
  // Section E: Security & Anti-CSRF
  // =========================================================================
  console.log('\n--- Section E: Security & Anti-CSRF ---');

  const validToken = signToken({ role: 'admin', username: 'admin' });

  const actionEndpoints = [
    '/api/confessions/50/approve',
    '/api/confessions/50/reject',
    '/api/confessions/50/re-moderate',
  ];

  for (const endpoint of actionEndpoints) {
    // 1. Unauthenticated mutation rejected with 401
    {
      const req = new NextRequest(`http://localhost:3000${endpoint}`, {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:3000',
          'X-Admin-Action': '1',
        },
      });
      const res = await middleware(req);
      assert(res.status === 401, `Unauthenticated POST ${endpoint} returns 401`);
    }

    // 2. CSRF missing header rejected with 403
    {
      const req = new NextRequest(`http://localhost:3000${endpoint}`, {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:3000',
          Cookie: `admin_token=${validToken}`,
        },
      });
      const res = await middleware(req);
      assert(res.status === 403, `POST ${endpoint} missing CSRF header returns 403`);
    }

    // 3. Cross-origin mutation rejected with 403
    {
      const req = new NextRequest(`http://localhost:3000${endpoint}`, {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'https://evil-attacker.com',
          'X-Admin-Action': '1',
          Cookie: `admin_token=${validToken}`,
        },
      });
      const res = await middleware(req);
      assert(res.status === 403, `Cross-origin POST ${endpoint} returns 403`);
    }

    // 4. Sec-Fetch-Site: same-origin ALONE rejected with 403
    {
      const req = new NextRequest(`http://localhost:3000${endpoint}`, {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:3000',
          'Sec-Fetch-Site': 'same-origin',
          Cookie: `admin_token=${validToken}`,
        },
      });
      const res = await middleware(req);
      assert(res.status === 403, `POST ${endpoint} with Sec-Fetch-Site alone returns 403`);
    }

    // 5. Valid authenticated mutation with X-Admin-Action: 1 passes middleware
    {
      const req = new NextRequest(`http://localhost:3000${endpoint}`, {
        method: 'POST',
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:3000',
          'X-Admin-Action': '1',
          Cookie: `admin_token=${validToken}`,
        },
      });
      const res = await middleware(req);
      assert(res.status === 200, `Valid CSRF-protected POST ${endpoint} passes middleware (200)`);
    }
  }

  // =========================================================================
  // Section F: Concurrent / Repeated Actions
  // =========================================================================
  console.log('\n--- Section F: Duplicate & Concurrent Actions ---');

  // Repeated approval is idempotent and safe
  {
    const { mockClient } = createMockSupabase({
      id: 80,
      text: 'Idempotency test',
      status: 'pending_review',
    });

    const first = await forceApproveConfession(80, { supabaseClient: mockClient });
    const second = await forceApproveConfession(80, { supabaseClient: mockClient });
    assert(first.status === 'approved', 'First approval sets approved');
    assert(second.status === 'approved', 'Second approval returns approved safely');
  }

  // Repeated rejection is idempotent and safe
  {
    const { mockClient } = createMockSupabase({
      id: 81,
      text: 'Idempotency reject test',
      status: 'pending_review',
    });

    const first = await forceRejectConfession(81, { reason: 'Test reason', supabaseClient: mockClient });
    const second = await forceRejectConfession(81, { reason: 'Test reason', supabaseClient: mockClient });
    assert(first.status === 'rejected', 'First rejection sets rejected');
    assert(second.status === 'rejected', 'Second rejection returns rejected safely');
  }

  // Repeated re-run is idempotent and safe
  {
    const { mockClient } = createMockSupabase({
      id: 82,
      text: 'Idempotency re-run test',
      status: 'rejected',
    });

    const first = await rerunAiModeration(82, { supabaseClient: mockClient });
    const second = await rerunAiModeration(82, { supabaseClient: mockClient });
    assert(first.status === 'pending', 'First re-run sets pending');
    assert(second.status === 'pending', 'Second re-run returns pending safely');
  }

  // =========================================================================
  // Section G: Live Production Read-Only Safety Check
  // =========================================================================
  console.log('\n--- Section G: Read-Only Production Verification ---');
  {
    const supabase = getSupabaseAdmin();

    const row2 = await getAdminConfessionById(2, { supabaseClient: supabase });
    assert(row2?.id === 2, 'Confession #2 exists');
    assert(row2?.number === 2, 'Confession #2 number is strictly #2');
    assert(row2?.status === 'posted', 'Confession #2 status is strictly "posted"');

    const row3 = await getAdminConfessionById(3, { supabaseClient: supabase });
    assert(row3?.id === 3, 'Confession #3 exists');
    assert(row3?.number === null, 'Confession #3 number is strictly NULL');
    assert(row3?.status === 'rejected', 'Confession #3 status is strictly "rejected"');

    const row4 = await getAdminConfessionById(4, { supabaseClient: supabase });
    assert(row4?.id === 4, 'Confession #4 exists');
    assert(row4?.number === 1, 'Confession #4 number is strictly #1');
    assert(row4?.status === 'posted', 'Confession #4 status is strictly "posted"');
    assert(row4?.ig_post_id === '18123513856858171', 'Confession #4 ig_post_id preserved');

    const row5 = await getAdminConfessionById(5, { supabaseClient: supabase });
    assert(row5?.id === 5, 'Confession #5 exists');
    assert(row5?.number === 3, 'Confession #5 number is strictly #3');
    assert(row5?.status === 'posted', 'Confession #5 status is strictly "posted"');
    assert(row5?.ig_post_id === '18145893250562599', 'Confession #5 ig_post_id preserved');

    // MAX(number) check
    const { data: maxRows } = await supabase
      .from('confessions')
      .select('number')
      .not('number', 'is', null)
      .order('number', { ascending: false })
      .limit(1);

    const maxNumber = maxRows && maxRows.length > 0 ? maxRows[0].number : null;
    assert(typeof maxNumber === 'number' && maxNumber >= 3, 'MAX(confessions.number) in production database is valid');

    // Verify counts endpoint logic matches live data
    const counts = await getAdminConfessionCounts({ supabaseClient: supabase });
    assert(counts.all >= 3, 'Live count has at least 3 confessions');
    assert(counts.posted >= 3, 'Live count shows posted confessions');
  }

  console.log('\n================================================================');
  console.log(`PHASE F STEP 3 TESTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
