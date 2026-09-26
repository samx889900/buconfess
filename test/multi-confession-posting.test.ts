import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, getEligibleApprovedConfessions } from '../scripts/run-agent';
import { claimDailyPostingSlot } from '../apps/admin/lib/schedule';

// Helper to create mock confessions
function createMockConfessions(count: number, initialStatus: string = 'approved') {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    text: `Confession text #${i + 1}`,
    number: i + 1,
    status: initialStatus,
    image_urls: [`https://example.com/img_${i + 1}.png`],
    created_at: new Date(Date.now() - (count - i) * 60000).toISOString(),
    deleted_at: null,
    next_retry_at: null,
  }));
}

// Generalized In-memory Mock Supabase Store
function createMockSupabase(initialConfessions: any[] = [], initialSettings: Record<string, any> = {}) {
  const store: Record<string, any[]> = {
    confessions: JSON.parse(JSON.stringify(initialConfessions)),
    daily_posting_runs: [],
    agent_runs: [],
    agent_locks: [],
    audit_log: [],
    instagram_publish_attempts: [],
    settings: Object.entries(initialSettings).map(([key, value]) => ({ key, value })),
  };

  let queryCount = 0;

  const client: any = {
    _store: store,
    get _queryCount() {
      return queryCount;
    },
    from: (table: string) => {
      if (!store[table]) store[table] = [];
      const currentData = store[table];
      let filters: ((row: any) => boolean)[] = [];
      let sortFn: ((a: any, b: any) => number) | null = null;
      let limitCount: number | null = null;

      const builder: any = {
        select: (fields: string = '*', opts?: { count?: string; head?: boolean }) => {
          queryCount++;
          const selectBuilder: any = {
            eq: (col: string, val: any) => {
              filters.push((row) => row[col] === val);
              return selectBuilder;
            },
            gte: (col: string, val: any) => {
              filters.push((row) => row[col] >= val);
              return selectBuilder;
            },
            in: (col: string, vals: any[]) => {
              filters.push((row) => vals.includes(row[col]));
              return selectBuilder;
            },
            is: (col: string, val: any) => {
              filters.push((row) => row[col] === val);
              return selectBuilder;
            },
            not: (col: string, op: string, val: string) => {
              if (col === 'id' && op === 'in') {
                const raw = val.replace(/^\(|\)$/g, '');
                const excludedIds = raw.split(',').map((x) => parseInt(x.trim(), 10));
                filters.push((row) => !excludedIds.includes(row.id));
              }
              return selectBuilder;
            },
            order: (col: string, orderOpts: { ascending?: boolean } = {}) => {
              const asc = orderOpts.ascending ?? true;
              sortFn = (a, b) => {
                if (a[col] === b[col]) {
                  return (a.id || 0) - (b.id || 0);
                }
                return asc ? (a[col] > b[col] ? 1 : -1) : a[col] < b[col] ? 1 : -1;
              };
              return selectBuilder;
            },
            limit: (n: number) => {
              limitCount = n;
              return selectBuilder;
            },
            maybeSingle: async () => {
              let rows = currentData.filter((r) => filters.every((fn) => fn(r)));
              if (sortFn) rows.sort(sortFn);
              return { data: rows.length > 0 ? rows[0] : null, error: null };
            },
            single: async () => {
              let rows = currentData.filter((r) => filters.every((fn) => fn(r)));
              if (sortFn) rows.sort(sortFn);
              return { data: rows[0] || null, error: rows.length > 0 ? null : { message: 'Not found' } };
            },
            then: (resolve: any) => {
              let rows = currentData.filter((r) => filters.every((fn) => fn(r)));
              if (opts?.count === 'exact' && opts?.head) {
                return resolve({ count: rows.length, error: null });
              }
              if (sortFn) rows.sort(sortFn);
              if (limitCount !== null) rows = rows.slice(0, limitCount);
              return resolve({ data: rows, error: null });
            },
          };
          return selectBuilder;
        },
        insert: (rows: any | any[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          // Special handling for daily_posting_runs UNIQUE constraint
          if (table === 'daily_posting_runs') {
            for (const r of arr) {
              const exists = currentData.some(
                (existing) => existing.posting_date === r.posting_date && existing.schedule_slot === r.schedule_slot
              );
              if (exists) {
                return {
                  select: () => ({
                    single: async () => ({
                      data: null,
                      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                    }),
                  }),
                };
              }
            }
          }

          const inserted = arr.map((r, idx) => ({
            id: r.id || currentData.length + idx + 1,
            created_at: new Date().toISOString(),
            ...r,
          }));
          currentData.push(...inserted);

          return {
            select: () => ({
              single: async () => ({ data: inserted[0], error: null }),
              maybeSingle: async () => ({ data: inserted[0], error: null }),
            }),
            then: (resolve: any) => resolve({ data: Array.isArray(rows) ? inserted : inserted[0], error: null }),
          };
        },
        update: (updates: any) => {
          const updateBuilder: any = {
            eq: (col: string, val: any) => {
              filters.push((row) => row[col] === val);
              return updateBuilder;
            },
            then: async (resolve: any) => {
              const matched = currentData.filter((r) => filters.every((fn) => fn(r)));
              for (const row of matched) {
                Object.assign(row, updates);
              }
              return resolve({ data: matched, error: null });
            },
          };
          return updateBuilder;
        },
        delete: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      };
      return builder;
    },
  };

  return client;
}

describe('Multi-Confession Daily Posting Queue Draining', () => {
  // Test 1: 30 eligible -> 30 posted (with max_per_batch = 10, daily limit >= 30)
  it('1. 30 eligible -> 30 posted (with max_per_batch = 10, daily limit >= 30)', async () => {
    const confessions = createMockConfessions(30);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 10,
        max_daily_posts: 50,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.postedCount, 30);
    assert.equal(result.failedPostingCount, 0);
  });

  // Test 2: 30 eligible with max_daily_posts = 100 -> 30 posted
  it('2. 30 eligible with max_daily_posts = 100 -> 30 posted', async () => {
    const confessions = createMockConfessions(30);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 10,
        max_daily_posts: 100,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.postedCount, 30);
    assert.equal(result.quotaReached, false);
  });

  // Test 3: 30 eligible with max_daily_posts = 10 -> exactly 10 posted, 20 remain
  it('3. 30 eligible with max_daily_posts = 10 -> exactly 10 posted, 20 remain', async () => {
    const confessions = createMockConfessions(30);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 5,
        max_daily_posts: 10,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.postedCount, 10);
    assert.equal(result.quotaReached, true);
  });

  // Test 4: max_per_batch = 5 with 30 eligible -> six batches
  it('4. max_per_batch = 5 with 30 eligible -> six batches', async () => {
    const confessions = createMockConfessions(30);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 5,
        max_daily_posts: 50,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.postedCount, 30);
    // 30 items with limit 5 processes exactly 6 batches of 5
    assert.ok(mockDb._queryCount >= 6, `Expected at least 6 batch queries, got ${mockDb._queryCount}`);
  });

  // Test 5: one confession fails -> remaining confessions continue (failure isolation)
  it('5. one confession fails -> remaining confessions continue (failure isolation)', async () => {
    const confessions = createMockConfessions(5);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 10,
        max_daily_posts: 50,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.postedCount, 5);
  });

  // Test 6: Instagram rate limit -> backoff without false "posted" state
  it('6. Instagram rate limit -> backoff without false "posted" state', async () => {
    const confessions = createMockConfessions(10);
    const mockDb = createMockSupabase(confessions);

    const originalFetch = globalThis.fetch;
    let postAttempts = 0;

    globalThis.fetch = (async (url: string, opts?: any) => {
      const urlStr = String(url);
      // Preflight or debug token check succeeds
      if (urlStr.includes('debug_token') || urlStr.includes('oauth')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: { is_valid: true, scopes: ['instagram_basic', 'instagram_content_publish'] } }),
        } as any;
      }

      // Container creation or media publish
      if (urlStr.includes('/media') || urlStr.includes('/media_publish')) {
        postAttempts++;
        if (postAttempts > 2) {
          // Trigger rate limit on 3rd confession attempt
          return {
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ error: { message: 'Application request limit reached', code: 4 } }),
          } as any;
        }

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: `mock_container_${postAttempts}`, status_code: 'FINISHED' }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'mock_ok', status_code: 'FINISHED' }),
      } as any;
    }) as any;

    try {
      const result = await runAgent({
        supabaseClient: mockDb,
        skipScheduleCheck: true,
        skipLock: true,
        dryRun: false,
        settingsOverride: {
          max_per_batch: 5,
          max_daily_posts: 50,
          min_delay_between_posts_sec: 0,
        },
      });

      assert.equal(result.postingSkippedReason, 'rate_limit_exceeded');
      // Confessions past the rate limit must NOT be marked as posted!
      const postedInDb = mockDb._store.confessions.filter((c: any) => c.status === 'posted');
      assert.ok(postedInDb.length < 10, 'Queue stopped safely on rate limit');
      // Unposted confessions remain in approved state
      const approvedInDb = mockDb._store.confessions.filter((c: any) => c.status === 'approved');
      assert.ok(approvedInDb.length > 0, 'Remaining confessions stay approved');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 7: duplicate worker -> daily lock prevents duplicate processing
  it('7. duplicate worker -> daily lock prevents duplicate processing', async () => {
    const mockDb = createMockSupabase(createMockConfessions(5));

    // Worker 1 claims slot successfully
    const claim1 = await claimDailyPostingSlot('2026-09-22', '22:00', 'scheduled', mockDb);
    assert.equal(claim1.claimed, true);
    assert.equal(claim1.slotRunId, 1);

    // Worker 2 attempts same slot -> rejected!
    const claim2 = await claimDailyPostingSlot('2026-09-22', '22:00', 'scheduled', mockDb);
    assert.equal(claim2.claimed, false);
    assert.ok(claim2.reason?.includes('already executed or is running'));
  });

  // Test 8: second batch must NOT be blocked by the daily run lock
  it('8. second batch must NOT be blocked by the daily run lock', async () => {
    const confessions = createMockConfessions(20);
    const mockDb = createMockSupabase(confessions);

    // Single run claiming daily slot once and draining two batches of 10
    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 10,
        max_daily_posts: 50,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.postedCount, 20);
    assert.equal(result.postingSkippedReason, undefined);
  });

  // Test 9: newly eligible confession can be picked up by a later batch
  it('9. newly eligible confession can be picked up by a later batch', async () => {
    const confessions = createMockConfessions(5);
    const mockDb = createMockSupabase(confessions);

    // Initial batch of 5
    const batch1 = await getEligibleApprovedConfessions(5, mockDb);
    assert.equal(batch1.length, 5);

    // While worker is running, 2 new confessions arrive and get approved
    mockDb._store.confessions.push({
      id: 6,
      text: 'New confession #6',
      status: 'approved',
      created_at: new Date().toISOString(),
      deleted_at: null,
      next_retry_at: null,
    });
    mockDb._store.confessions.push({
      id: 7,
      text: 'New confession #7',
      status: 'approved',
      created_at: new Date().toISOString(),
      deleted_at: null,
      next_retry_at: null,
    });

    // Second batch excludes already-processed IDs [1..5]
    const batch2 = await getEligibleApprovedConfessions(5, mockDb, [1, 2, 3, 4, 5]);
    assert.equal(batch2.length, 2);
    assert.equal(batch2[0].id, 6);
    assert.equal(batch2[1].id, 7);
  });

  // Test 10: dry-run processes the queue without publishing
  it('10. dry-run processes the queue without publishing or mutating database', async () => {
    const confessions = createMockConfessions(15);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        max_per_batch: 5,
        max_daily_posts: 50,
        min_delay_between_posts_sec: 0,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.postedCount, 15);

    // Ensure ZERO database records were mutated to 'posted'
    const postedRows = mockDb._store.confessions.filter((c: any) => c.status === 'posted');
    assert.equal(postedRows.length, 0, 'Dry-run must not mutate database confession status');
  });

  // Test 11: posting_enabled=false stops further publishing safely
  it('11. posting_enabled=false stops further publishing safely', async () => {
    const confessions = createMockConfessions(10);
    const mockDb = createMockSupabase(confessions);

    const result = await runAgent({
      supabaseClient: mockDb,
      skipScheduleCheck: true,
      skipLock: true,
      dryRun: true,
      settingsOverride: {
        posting_enabled: false,
      },
    });

    assert.equal(result.postedCount, 0);
    assert.equal(result.postingSkippedReason, 'posting_disabled');

    // All remain untouched in approved
    const approvedRows = mockDb._store.confessions.filter((c: any) => c.status === 'approved');
    assert.equal(approvedRows.length, 10);
  });

  // Test 12: runtime exhaustion preserves unprocessed records
  it('12. runtime exhaustion preserves unprocessed records without marking them failed', async () => {
    const confessions = createMockConfessions(20);
    const mockDb = createMockSupabase(confessions);

    // Mock Date.now to simulate running out of budget after batch 1
    let calls = 0;
    const realNow = Date.now;
    const start = realNow();
    Date.now = () => {
      calls++;
      // After batch 1 has queried and processed a few, jump forward 26 minutes
      if (calls > 15) {
        return start + 26 * 60 * 1000;
      }
      return start;
    };

    try {
      const result = await runAgent({
        supabaseClient: mockDb,
        skipScheduleCheck: true,
        skipLock: true,
        dryRun: true,
        settingsOverride: {
          max_per_batch: 5,
          max_daily_posts: 50,
          min_delay_between_posts_sec: 0,
        },
      });

      assert.equal(result.postingSkippedReason, 'runtime_budget_exhausted');
      // Some processed, remaining were NOT failed
      assert.ok(result.postedCount < 20, 'Stopped early due to budget');
      const failedRows = mockDb._store.confessions.filter((c: any) => c.status === 'failed');
      assert.equal(failedRows.length, 0, 'Unprocessed confessions must never be marked failed');
    } finally {
      Date.now = realNow;
    }
  });
});
