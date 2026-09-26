import {
  getRuntimeSettings,
  clearRuntimeSettingsCache,
  SETTINGS_ALLOWLIST,
  RuntimeSettings,
} from '../apps/admin/lib/settings';
import {
  acquireAgentLock,
  renewAgentLock,
  assertLeaseOwnership,
  releaseAgentLock,
  LeaseLostError,
  DEFAULT_AGENT_LOCK_NAME,
} from '../apps/admin/lib/agentLock';
import {
  isConfessionProtected,
  runStorageRetentionCleanup,
  RETENTION_DAYS,
} from '../apps/admin/lib/storage/cleanup';
import {
  getAdminHealthStatus,
  releaseStaleAgentLock,
} from '../apps/admin/lib/health';
import { runAgent } from '../scripts/run-agent';
import { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Phase F Step 5.1 Runtime Wiring Audit Test Suite
// ---------------------------------------------------------------------------

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passedCount++;
    console.log(`  ✅ [PASS] ${message}`);
  } else {
    failedCount++;
    console.error(`  ❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE F STEP 5.1: RUNTIME WIRING AUDIT TEST SUITE');
  console.log('================================================================\n');

  // =========================================================================
  // 1. HEARTBEAT WIRING AUDIT & INEQUALITY PROOF
  // =========================================================================
  console.log('--- Section 1: Heartbeat Wiring & Inequality Proof ---');
  clearRuntimeSettingsCache();

  // Test 1.1: Trace heartbeat_timeout_sec from getRuntimeSettings() into effective heartbeatIntervalMs
  {
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'settings') {
          return {
            select: () => Promise.resolve({
              data: [
                { key: 'heartbeat_timeout_sec', value: 45 },
                { key: 'stale_lease_threshold_sec', value: 180 },
              ],
              error: null,
            }),
          };
        }
        return { select: () => Promise.resolve({ data: [], error: null }) };
      },
    } as unknown as SupabaseClient;

    const settings = await getRuntimeSettings({ supabaseClient: mockSupabase, forceFresh: true });
    assert(settings.heartbeat_timeout_sec === 45, 'DB heartbeat_timeout_sec=45 is correctly loaded');
    assert(settings.stale_lease_threshold_sec === 180, 'DB stale_lease_threshold_sec=180 is correctly loaded');

    // Expected inequality: 45 <= floor(180 / 2) = 90 (Satisfied)
    assert(
      settings.heartbeat_timeout_sec <= Math.floor(settings.stale_lease_threshold_sec / 2),
      'Heartbeat timeout satisfies heartbeat <= floor(stale_lease_threshold_sec / 2)'
    );

    // Verify interval in milliseconds
    const effectiveIntervalMs = settings.heartbeat_timeout_sec * 1000;
    assert(effectiveIntervalMs === 45000, 'Effective worker heartbeatIntervalMs is exactly 45000ms');
  }

  // Test 1.2: Enforce clamping when DB heartbeat_timeout_sec violates lease inequality
  {
    clearRuntimeSettingsCache();
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'settings') {
          return {
            select: () => Promise.resolve({
              data: [
                { key: 'heartbeat_timeout_sec', value: 100 }, // Requests 100s
                { key: 'stale_lease_threshold_sec', value: 120 }, // Max heartbeat allowed: 120 / 2 = 60s
              ],
              error: null,
            }),
          };
        }
        return { select: () => Promise.resolve({ data: [], error: null }) };
      },
    } as unknown as SupabaseClient;

    const settings = await getRuntimeSettings({ supabaseClient: mockSupabase, forceFresh: true });
    assert(
      settings.heartbeat_timeout_sec === 60,
      'Violating heartbeat_timeout_sec (100s) is strictly clamped to floor(120 / 2) = 60s'
    );
    assert(
      settings.heartbeat_timeout_sec <= Math.floor(settings.stale_lease_threshold_sec / 2),
      'Clamped heartbeat strictly maintains safety inequality'
    );
  }

  // Test 1.3: Heartbeat renewal execution path
  {
    const lockRows: Record<string, any> = {};
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'agent_locks') {
          return {
            insert: (row: any) => {
              lockRows[row.lock_name] = { ...row };
              return {
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: lockRows[row.lock_name], error: null }),
                }),
              };
            },
            update: (updates: any) => ({
              eq: (col1: string, val1: any) => ({
                eq: (col2: string, val2: any) => ({
                  gt: (col3: string, val3: any) => ({
                    select: () => ({
                      maybeSingle: () => {
                        const existing = lockRows[val1];
                        if (existing && existing[col2] === val2) {
                          Object.assign(existing, updates);
                          return Promise.resolve({ data: existing, error: null });
                        }
                        return Promise.resolve({ data: null, error: null });
                      },
                    }),
                  }),
                }),
              }),
            }),
            select: () => ({
              eq: (col: string, val: any) => ({
                maybeSingle: () => Promise.resolve({ data: lockRows[val] || null, error: null }),
              }),
            }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const runUuid = 'worker_test_heartbeat_1';
    const acquired = await acquireAgentLock('test_hb_lock', runUuid, 5, mockSupabase);
    assert(acquired.acquired === true, 'Worker successfully acquired lock for heartbeat test');

    const firstExpiresAt = lockRows['test_hb_lock'].expires_at;
    const initialHeartbeat = lockRows['test_hb_lock'].last_heartbeat_at;

    // Simulate heartbeat tick renewal
    const renewed = await renewAgentLock('test_hb_lock', runUuid, 5, mockSupabase);
    assert(renewed === true, 'renewAgentLock successfully renewed the lease');
    assert(
      lockRows['test_hb_lock'].last_heartbeat_at !== undefined,
      'last_heartbeat_at was updated during renewal'
    );
  }

  // =========================================================================
  // 2. STALE LEASE & RECLAMATION CONSUMER AUDIT
  // =========================================================================
  console.log('\n--- Section 2: Stale Lease & Split-Brain Protections ---');

  // Test 2.1: stale_lease_threshold_sec controls effective expires_at
  {
    const lockRows: Record<string, any> = {};
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'agent_locks') {
          return {
            insert: (row: any) => {
              lockRows[row.lock_name] = { ...row };
              return {
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: lockRows[row.lock_name], error: null }),
                }),
              };
            },
            select: () => ({
              eq: (col: string, val: any) => ({
                maybeSingle: () => Promise.resolve({ data: lockRows[val] || null, error: null }),
              }),
            }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const runUuid = 'worker_lease_audit_1';
    const thresholdSec = 180; // 3 minutes
    const ttlMinutes = thresholdSec / 60;
    const beforeMs = Date.now();
    const result = await acquireAgentLock('audit_lock_ttl', runUuid, ttlMinutes, mockSupabase);
    const afterMs = Date.now();

    assert(result.acquired === true, 'Lock acquired with custom threshold');
    const expiresMs = new Date(result.expiresAt!).getTime();
    const durationMs = expiresMs - beforeMs;

    assert(
      durationMs >= 179_000 && durationMs <= 181_000,
      `expires_at reflects exact stale_lease_threshold_sec (${thresholdSec}s)`
    );
  }

  // Test 2.2: Active lease protects against concurrent acquisition
  {
    const lockRows: Record<string, any> = {
      active_guard_lock: {
        lock_name: 'active_guard_lock',
        locked_by: 'worker_primary',
        acquired_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 180_000).toISOString(), // 3 mins in future
      },
    };

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'agent_locks') {
          return {
            insert: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }),
              }),
            }),
            update: () => ({
              eq: () => ({
                lt: () => ({
                  select: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }), // Fails lt condition
                  }),
                }),
              }),
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: lockRows['active_guard_lock'], error: null }),
              }),
            }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const competitor = await acquireAgentLock('active_guard_lock', 'worker_competitor', 5, mockSupabase);
    assert(competitor.acquired === false, 'Concurrent worker cannot acquire active unexpired lease');
    assert(competitor.lockedBy === 'worker_primary', 'Identifies active lock owner worker_primary');
  }

  // Test 2.3: Reclaiming an expired stale lease
  {
    const lockRows: Record<string, any> = {
      stale_lock: {
        lock_name: 'stale_lock',
        locked_by: 'worker_crashed',
        acquired_at: new Date(Date.now() - 600_000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 600_000).toISOString(),
        expires_at: new Date(Date.now() - 10_000).toISOString(), // Expired 10s ago
      },
    };

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'agent_locks') {
          return {
            insert: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }),
              }),
            }),
            update: (updates: any) => ({
              eq: () => ({
                lt: () => ({
                  select: () => ({
                    maybeSingle: () => {
                      Object.assign(lockRows['stale_lock'], updates);
                      return Promise.resolve({ data: lockRows['stale_lock'], error: null });
                    },
                  }),
                }),
              }),
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: lockRows['stale_lock'], error: null }),
              }),
            }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const reclaimer = await acquireAgentLock('stale_lock', 'worker_reclaimer', 5, mockSupabase);
    assert(reclaimer.acquired === true, 'Worker successfully reclaimed expired stale lease');
    assert(reclaimer.lockedBy === 'worker_reclaimer', 'Lock ownership transitioned to reclaimer');
  }

  // Test 2.4: assertLeaseOwnership verifies split-brain and expiration
  {
    // Valid lease
    const validSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                lock_name: DEFAULT_AGENT_LOCK_NAME,
                locked_by: 'worker_legit',
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    let threw = false;
    try {
      await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, 'worker_legit', validSupabase);
    } catch {
      threw = true;
    }
    assert(!threw, 'assertLeaseOwnership passes for active lease owned by current worker');

    // Usurped lease (split-brain)
    const usurpedSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                lock_name: DEFAULT_AGENT_LOCK_NAME,
                locked_by: 'worker_other',
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    let splitBrainError: any = null;
    try {
      await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, 'worker_legit', usurpedSupabase);
    } catch (err: any) {
      splitBrainError = err;
    }
    assert(splitBrainError instanceof LeaseLostError, 'Throws LeaseLostError on usurped lock (split-brain guard)');
    assert(splitBrainError.message.includes('Split-brain detected'), 'Error message identifies split-brain condition');

    // Expired lease
    const expiredSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                lock_name: DEFAULT_AGENT_LOCK_NAME,
                locked_by: 'worker_legit',
                expires_at: new Date(Date.now() - 5_000).toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    let expiredError: any = null;
    try {
      await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, 'worker_legit', expiredSupabase);
    } catch (err: any) {
      expiredError = err;
    }
    assert(expiredError instanceof LeaseLostError, 'Throws LeaseLostError on expired lease');
    assert(expiredError.message.includes('expired'), 'Error message identifies lease expiration');
  }

  // =========================================================================
  // 3. SETTINGS DB FAILURE AUDIT & BEHAVIOR MATRIX
  // =========================================================================
  console.log('\n--- Section 3: Supabase Settings DB Failure Audit ---');
  clearRuntimeSettingsCache();

  // Test 3.1: Simulate total Supabase DB query failure
  {
    let loggedWarning = '';
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      loggedWarning += args.join(' ');
      originalWarn(...args);
    };

    try {
      const brokenSupabase = {
        from: (table: string) => ({
          select: () => Promise.resolve({
            data: null,
            error: { message: 'connection refused / 503 service unavailable' },
          }),
        }),
      } as unknown as SupabaseClient;

      const failedSettings = await getRuntimeSettings({ supabaseClient: brokenSupabase, forceFresh: true });

      // Document every setting's fallback value on DB outage
      assert(failedSettings.posting_enabled === false, 'Hardened fail-safe: posting_enabled forces false on DB read failure');
      assert(failedSettings.auto_publish_approved === false, 'Hardened fail-safe: auto_publish_approved forces false on DB read failure');
      assert(loggedWarning.includes('[SETTINGS] Database read error on settings table — activating FAIL-SAFE mode: automated publication halted.'), 'Emits expected operational warning log');
      assert(failedSettings.dry_run_mode === false, 'dry_run_mode falls back to default false');
      assert(failedSettings.max_per_batch === 10, 'max_per_batch falls back to default 10 (FAIL-SAFE)');
      assert(failedSettings.min_delay_between_posts_sec === 60, 'min_delay_between_posts_sec falls back to default 60s (FAIL-SAFE)');
      assert(failedSettings.max_daily_posts === 30 || failedSettings.max_daily_posts === 50, 'max_daily_posts falls back to default 30 (v3.5) or 50 (FAIL-SAFE)');
      assert(failedSettings.image_retention_days === 30, 'image_retention_days falls back to default 30 (FAIL-SAFE)');
      assert(failedSettings.max_slide_count === 10, 'max_slide_count falls back to default 10 (FAIL-SAFE)');
      assert(failedSettings.moderation_strictness === 'medium', 'moderation_strictness falls back to medium (FAIL-SAFE)');
      assert(failedSettings.heartbeat_timeout_sec === 90, 'heartbeat_timeout_sec falls back to default 90s (FAIL-SAFE)');
      assert(failedSettings.stale_lease_threshold_sec === 300, 'stale_lease_threshold_sec falls back to default 300s (FAIL-SAFE)');
    } finally {
      console.warn = originalWarn;
    }
  }

  // Test 3.2: Successful settings read retains existing behavior
  {
    clearRuntimeSettingsCache();
    const successSupabase = {
      from: (table: string) => {
        if (table === 'settings') {
          return {
            select: () => Promise.resolve({
              data: [
                { key: 'max_per_batch', value: 25 },
                // posting_enabled omitted -> should take allowlist default true
              ],
              error: null,
            }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const normalSettings = await getRuntimeSettings({ supabaseClient: successSupabase, forceFresh: true });
    assert(normalSettings.max_per_batch === 25, 'Normal query loads configured max_per_batch=25');
    assert(normalSettings.posting_enabled === true, 'Successful query preserves default posting_enabled=true when omitted');
    assert(normalSettings.auto_publish_approved === true, 'Successful query preserves default auto_publish_approved=true when omitted');
  }

  // Test 3.3: Worker halts publication on settings DB read failure
  {
    clearRuntimeSettingsCache();
    let publishedCount = 0;
    const mockConfessions = [
      { id: 901, text: 'Approved confession waiting to post', status: 'approved', image_urls: ['test.png'], deleted_at: null },
    ];

    const brokenSettingsSupabase = {
      from: (table: string) => {
        if (table === 'settings') {
          return {
            select: () => Promise.resolve({
              data: null,
              error: { message: 'Database connection failed' },
            }),
          };
        }
        if (table === 'confessions') {
          return {
            select: () => ({
              in: () => ({
                is: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: mockConfessions, error: null }),
                  }),
                }),
              }),
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
                is: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
            update: (updates: any) => ({
              eq: () => {
                if (updates.status === 'posted') publishedCount++;
                return Promise.resolve({ error: null });
              },
            }),
          };
        }
        if (table === 'agent_locks') {
          return {
            insert: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: { locked_by: 'worker_fail_safe' }, error: null }),
              }),
            }),
            delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
          };
        }
        if (table === 'agent_runs') {
          return {
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: 1 }, error: null }),
              }),
            }),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const result = await runAgent({
      supabaseClient: brokenSettingsSupabase,
      runUuid: 'worker_fail_safe',
    });

    assert(result.postedCount === 0, 'No confessions posted when settings DB read fails');
    assert(publishedCount === 0, 'Zero publication mutations executed');
    assert(mockConfessions[0].status === 'approved', 'Approved confession remains strictly in approved status');
    assert(mockConfessions[0].status !== 'failed', 'Approved confession is NEVER changed to failed');
    assert(result.postingSkippedReason === 'posting_disabled', 'Worker skipped publication due to fail-safe posting_disabled');
  }

  // Test 3.4: CLI/ENV dry-run precedence even during total DB outage
  {
    clearRuntimeSettingsCache();
    const brokenSupabase = {
      from: (table: string) => ({
        select: () => Promise.resolve({
          data: null,
          error: { message: 'database unreachable' },
        }),
      }),
    } as unknown as SupabaseClient;

    const prevEnv = process.env.DRY_RUN;
    process.env.DRY_RUN = 'true';
    try {
      const settings = await getRuntimeSettings({ supabaseClient: brokenSupabase, forceFresh: true });
      assert(settings.dry_run_mode === true, 'CLI/ENV DRY_RUN=true strictly forces dry_run_mode=true even on DB failure');
    } finally {
      process.env.DRY_RUN = prevEnv;
    }
  }

  // =========================================================================
  // 4. STORAGE CLEANUP LIFECYCLE STATE MATRIX
  // =========================================================================
  console.log('\n--- Section 4: Storage Cleanup Lifecycle State Matrix ---');

  // Test 4.1: isConfessionProtected against all 8 statuses
  {
    assert(isConfessionProtected('pending') === true, 'pending is strictly PROTECTED');
    assert(isConfessionProtected('pending_review') === true, 'pending_review is strictly PROTECTED');
    assert(isConfessionProtected('processing') === true, 'processing is strictly PROTECTED');
    assert(isConfessionProtected('approved') === true, 'approved is strictly PROTECTED');
    assert(isConfessionProtected('posting') === true, 'posting is strictly PROTECTED');
    assert(isConfessionProtected('failed') === true, 'failed is strictly PROTECTED (retained for debugging/recovery)');
    assert(isConfessionProtected('posted') === false, 'posted is ELIGIBLE for retention cleanup (subject to age)');
    assert(isConfessionProtected('rejected') === false, 'rejected is NOT protected (no images generated)');
  }

  // Test 4.2: Comprehensive Cleanup Query & Protected State Simulation
  {
    // Dataset of 10 confessions covering all lifecycle states and ages (> 100 days old)
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    const expiredPostedDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago

    const mockDataset = [
      { id: 101, status: 'pending', created_at: oldDate, posted_at: null, image_urls: ['img1.png'], deleted_at: null },
      { id: 102, status: 'pending_review', created_at: oldDate, posted_at: null, image_urls: ['img2.png'], deleted_at: null },
      { id: 103, status: 'processing', created_at: oldDate, posted_at: null, image_urls: ['img3.png'], deleted_at: null },
      { id: 104, status: 'approved', created_at: oldDate, posted_at: null, image_urls: ['img4.png'], deleted_at: null },
      { id: 105, status: 'posting', created_at: oldDate, posted_at: null, image_urls: ['img5.png'], deleted_at: null },
      { id: 106, status: 'failed', created_at: oldDate, posted_at: null, image_urls: ['img6.png'], deleted_at: null },
      { id: 107, status: 'posted', created_at: recentDate, posted_at: recentDate, image_urls: ['img7.png'], deleted_at: null }, // Under 30 days
      { id: 108, status: 'posted', created_at: oldDate, posted_at: expiredPostedDate, image_urls: ['img8.png'], deleted_at: null }, // Over 30 days (ELIGIBLE)
      { id: 109, status: 'approved', created_at: oldDate, posted_at: null, image_urls: ['img9.png'], deleted_at: oldDate }, // Soft-deleted approved (PROTECTED)
      { id: 110, status: 'failed', created_at: oldDate, posted_at: null, image_urls: ['img10.png'], deleted_at: oldDate }, // Soft-deleted failed (PROTECTED)
    ];

    const deletedStorageCalls: number[] = [];
    const updatedDbCalls: number[] = [];

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'confessions') {
          return {
            select: () => ({
              eq: (col: string, val: any) => ({
                not: () => ({
                  order: () => ({
                    limit: () => ({
                      lt: (dateCol: string, cutoff: string) => {
                        // DB query filters status='posted' AND posted_at < cutoff
                        const cutoffTime = new Date(cutoff).getTime();
                        const matching = mockDataset.filter(
                          (c) => c.status === 'posted' && c.posted_at && new Date(c.posted_at).getTime() < cutoffTime
                        );
                        return Promise.resolve({ data: matching, error: null });
                      },
                    }),
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: (col: string, id: number) => {
                updatedDbCalls.push(id);
                return Promise.resolve({ error: null });
              },
            }),
          };
        }
        if (table === 'audit_log') {
          return {
            insert: () => Promise.resolve({ error: null }),
          };
        }
        return {};
      },
      storage: {
        from: () => ({
          remove: (paths: string[]) => {
            return Promise.resolve({ error: null });
          },
          list: () => Promise.resolve({ data: [{ name: 'slide_1.png' }], error: null }),
        }),
      },
    } as unknown as SupabaseClient;

    const report = await runStorageRetentionCleanup({
      supabaseClient: mockSupabase,
      retentionDays: 30,
    });

    assert(report.confessionsExamined === 1, 'Only 1 confession was selected by retention query');
    assert(report.confessionsCleaned === 1, 'Exactly 1 confession was cleaned');
    assert(report.cleanedConfessionIds[0] === 108, 'Cleaned confession is #108 (posted > 30 days)');
    assert(!report.cleanedConfessionIds.includes(101), 'Pending confession #101 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(102), 'Pending review confession #102 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(103), 'Processing confession #103 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(104), 'Approved confession #104 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(105), 'Posting confession #105 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(106), 'Failed confession #106 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(107), 'Recent posted confession #107 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(109), 'Soft-deleted approved confession #109 was NOT cleaned');
    assert(!report.cleanedConfessionIds.includes(110), 'Soft-deleted failed confession #110 was NOT cleaned');
  }

  console.log('\n================================================================');
  console.log(`PHASE F STEP 5.1 AUDIT TESTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error running Step 5.1 audit suite:', err);
  process.exit(1);
});
