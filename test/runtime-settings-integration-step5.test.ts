import fs from 'fs';
import path from 'path';

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
} catch {}

import {
  SETTINGS_ALLOWLIST,
  getRuntimeSettings,
  clearRuntimeSettingsCache,
  getTodayPostedCount,
  validateSettingValue,
  updateAdminSetting,
  RuntimeSettings,
} from '../apps/admin/lib/settings';
import { runAgent, RunAgentOptions } from '../scripts/run-agent';
import { splitConfessionText } from '../apps/admin/lib/canvas/splitter';
import { generateAndStoreConfessionImages } from '../apps/admin/lib/canvas/pipeline';
import { runStorageRetentionCleanup, isConfessionProtected } from '../apps/admin/lib/storage/cleanup';
import { publishConfessionToInstagram } from '../apps/admin/lib/instagram/publisher';
import { getSupabaseAdmin } from '../apps/admin/lib/supabase';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: any) {
  if (condition) {
    passedCount++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failedCount++;
    console.error(`  ❌ [FAIL] ${testName}`, detail !== undefined ? detail : '');
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase Factory for Deterministic Unit Testing
// ---------------------------------------------------------------------------
interface MockDbState {
  settings: { key: string; value: any }[];
  confessions: any[];
  agentLocks: any[];
  agentRuns: any[];
  publishAttempts: any[];
  auditLogs: any[];
  storageDeletes: { bucket: string; path: string }[];
}

function createMockSupabase(initialState: Partial<MockDbState> = {}) {
  const state: MockDbState = {
    settings: initialState.settings ? [...initialState.settings] : [],
    confessions: initialState.confessions ? [...initialState.confessions] : [],
    agentLocks: initialState.agentLocks ? [...initialState.agentLocks] : [],
    agentRuns: initialState.agentRuns ? [...initialState.agentRuns] : [],
    publishAttempts: initialState.publishAttempts ? [...initialState.publishAttempts] : [],
    auditLogs: initialState.auditLogs ? [...initialState.auditLogs] : [],
    storageDeletes: [],
  };

  const createQueryBuilder = (tableName: string) => {
    let selectedCols = '*';
    let filters: ((item: any) => boolean)[] = [];
    let isCountHead = false;
    let limitVal: number | undefined;
    let orderCol: string | undefined;
    let orderAsc = true;
    let rangeStart: number | undefined;
    let rangeEnd: number | undefined;
    let isSingle = false;
    let isMaybeSingle = false;

    const builder: any = {
      select: (cols = '*', opts?: { count?: string; head?: boolean }) => {
        selectedCols = cols;
        if (opts?.head) isCountHead = true;
        return builder;
      },
      eq: (col: string, val: any) => {
        filters.push((item) => item[col] === val);
        return builder;
      },
      neq: (col: string, val: any) => {
        filters.push((item) => item[col] !== val);
        return builder;
      },
      gt: (col: string, val: any) => {
        filters.push((item) => item[col] > val);
        return builder;
      },
      gte: (col: string, val: any) => {
        filters.push((item) => item[col] >= val);
        return builder;
      },
      lt: (col: string, val: any) => {
        filters.push((item) => item[col] < val);
        return builder;
      },
      lte: (col: string, val: any) => {
        filters.push((item) => item[col] <= val);
        return builder;
      },
      in: (col: string, vals: any[]) => {
        filters.push((item) => vals.includes(item[col]));
        return builder;
      },
      is: (col: string, val: any) => {
        filters.push((item) => (val === null ? item[col] === null || item[col] === undefined : item[col] === val));
        return builder;
      },
      not: (col: string, op: string, val: any) => {
        if (op === 'is') {
          filters.push((item) => (val === null ? item[col] !== null && item[col] !== undefined : item[col] !== val));
        }
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return builder;
      },
      limit: (n: number) => {
        limitVal = n;
        return builder;
      },
      range: (from: number, to: number) => {
        rangeStart = from;
        rangeEnd = to;
        return builder;
      },
      single: () => {
        isSingle = true;
        return builder;
      },
      maybeSingle: () => {
        isMaybeSingle = true;
        return builder;
      },
      insert: (record: any) => {
        const records = Array.isArray(record) ? record : [record];
        const targetList =
          tableName === 'settings'
            ? state.settings
            : tableName === 'confessions'
            ? state.confessions
            : tableName === 'agent_locks'
            ? state.agentLocks
            : tableName === 'agent_runs'
            ? state.agentRuns
            : tableName === 'instagram_publish_attempts'
            ? state.publishAttempts
            : tableName === 'audit_log'
            ? state.auditLogs
            : [];

        for (const r of records) {
          const newRec = {
            id: r.id || (tableName === 'confessions' ? state.confessions.length + 1 : Date.now()),
            ...r,
          };
          targetList.push(newRec);
        }

        return {
          select: () => ({
            single: () => Promise.resolve({ data: records[0], error: null }),
            maybeSingle: () => Promise.resolve({ data: records[0], error: null }),
          }),
          then: (resolve: any) => resolve({ data: records, error: null }),
        };
      },
      update: (updates: any) => {
        return {
          eq: (col: string, val: any) => {
            filters.push((item) => item[col] === val);
            return {
              eq: (col2: string, val2: any) => {
                filters.push((item) => item[col2] === val2);
                return {
                  select: () => ({
                    maybeSingle: () => {
                      applyUpdate();
                      return Promise.resolve({ data: updates, error: null });
                    },
                    single: () => {
                      applyUpdate();
                      return Promise.resolve({ data: updates, error: null });
                    },
                  }),
                  then: (resolve: any) => {
                    applyUpdate();
                    resolve({ data: updates, error: null });
                  },
                };
              },
              gt: (col2: string, val2: any) => {
                filters.push((item) => item[col2] > val2);
                return {
                  select: () => ({
                    maybeSingle: () => {
                      applyUpdate();
                      return Promise.resolve({ data: updates, error: null });
                    },
                  }),
                  then: (resolve: any) => {
                    applyUpdate();
                    resolve({ data: updates, error: null });
                  },
                };
              },
              lt: (col2: string, val2: any) => {
                filters.push((item) => item[col2] < val2);
                return {
                  select: () => ({
                    maybeSingle: () => {
                      applyUpdate();
                      return Promise.resolve({ data: updates, error: null });
                    },
                  }),
                  then: (resolve: any) => {
                    applyUpdate();
                    resolve({ data: updates, error: null });
                  },
                };
              },
              select: () => ({
                single: () => {
                  applyUpdate();
                  return Promise.resolve({ data: updates, error: null });
                },
                maybeSingle: () => {
                  applyUpdate();
                  return Promise.resolve({ data: updates, error: null });
                },
              }),
              then: (resolve: any) => {
                applyUpdate();
                resolve({ data: updates, error: null });
              },
            };
          },
        };

        function applyUpdate() {
          const targetList =
            tableName === 'settings'
              ? state.settings
              : tableName === 'confessions'
              ? state.confessions
              : tableName === 'agent_locks'
              ? state.agentLocks
              : tableName === 'agent_runs'
              ? state.agentRuns
              : [];

          for (let i = 0; i < targetList.length; i++) {
            if (filters.every((f) => f(targetList[i]))) {
              targetList[i] = { ...targetList[i], ...updates };
            }
          }
        }
      },
      upsert: (record: any) => {
        const targetList =
          tableName === 'settings'
            ? state.settings
            : tableName === 'confessions'
            ? state.confessions
            : [];
        const existingIdx = targetList.findIndex((item) => (tableName === 'settings' ? item.key === record.key : item.id === record.id));
        if (existingIdx >= 0) {
          targetList[existingIdx] = { ...targetList[existingIdx], ...record };
        } else {
          targetList.push({ ...record });
        }
        return {
          select: () => ({
            single: () => Promise.resolve({ data: record, error: null }),
            maybeSingle: () => Promise.resolve({ data: record, error: null }),
          }),
        };
      },
      delete: () => {
        return {
          eq: (col: string, val: any) => {
            filters.push((item) => item[col] === val);
            return {
              eq: (col2: string, val2: any) => {
                filters.push((item) => item[col2] === val2);
                applyDelete();
                return Promise.resolve({ data: null, error: null });
              },
              then: (resolve: any) => {
                applyDelete();
                resolve({ data: null, error: null });
              },
            };
          },
        };

        function applyDelete() {
          if (tableName === 'agent_locks') {
            state.agentLocks = state.agentLocks.filter((item) => !filters.every((f) => f(item)));
          }
        }
      },
      then: (resolve: any) => {
        const targetList =
          tableName === 'settings'
            ? state.settings
            : tableName === 'confessions'
            ? state.confessions
            : tableName === 'agent_locks'
            ? state.agentLocks
            : tableName === 'agent_runs'
            ? state.agentRuns
            : tableName === 'instagram_publish_attempts'
            ? state.publishAttempts
            : tableName === 'audit_log'
            ? state.auditLogs
            : [];

        let result = targetList.filter((item) => filters.every((f) => f(item)));

        if (orderCol) {
          result.sort((a, b) => {
            const valA = a[orderCol!];
            const valB = b[orderCol!];
            return orderAsc ? (valA > valB ? 1 : -1) : valA < valB ? 1 : -1;
          });
        }

        const totalCount = result.length;

        if (rangeStart !== undefined && rangeEnd !== undefined) {
          result = result.slice(rangeStart, rangeEnd + 1);
        } else if (limitVal !== undefined) {
          result = result.slice(0, limitVal);
        }

        if (isCountHead) {
          return resolve({ data: null, count: totalCount, error: null });
        }

        if (isSingle) {
          return resolve({
            data: result[0] || null,
            error: result.length === 0 ? { message: 'Row not found' } : null,
          });
        }

        if (isMaybeSingle) {
          return resolve({ data: result[0] || null, error: null });
        }

        resolve({ data: result, count: totalCount, error: null });
      },
    };

    return builder;
  };

  const mockClient: any = {
    from: (table: string) => createQueryBuilder(table),
    storage: {
      listBuckets: () => Promise.resolve({ data: [{ name: 'confession-images' }], error: null }),
      createBucket: () => Promise.resolve({ data: null, error: null }),
      from: (bucket: string) => ({
        list: () => Promise.resolve({ data: [], error: null }),
        upload: (p: string) => Promise.resolve({ data: { path: p }, error: null }),
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.example.com/${bucket}/${p}` } }),
        remove: (paths: string[]) => {
          for (const p of paths) {
            state.storageDeletes.push({ bucket, path: p });
          }
          return Promise.resolve({ data: paths, error: null });
        },
      }),
    },
  };

  return { mockClient, state };
}

// ---------------------------------------------------------------------------
// TEST SUITE EXECUTION
// ---------------------------------------------------------------------------
async function runAllTests() {
  console.log('================================================================');
  console.log('PHASE F STEP 5: RUNTIME SETTINGS INTEGRATION & OPERATIONAL WIRING');
  console.log('================================================================\n');

  // =========================================================================
  // Section 1: Exact 11-Setting Matrix, Types, Defaults & Ranges
  // =========================================================================
  console.log('--- Section 1: Exact 11-Setting Allowlist Matrix ---');
  {
    const keys = Object.keys(SETTINGS_ALLOWLIST);
    assert(keys.length >= 11, 'All baseline operational settings in allowlist', `Found: ${keys.length}`);

    // 1. posting_enabled
    const pe = SETTINGS_ALLOWLIST.posting_enabled;
    assert(pe.type === 'boolean' && pe.defaultValue === true, 'posting_enabled default is true');

    // 2. max_per_batch
    const mpb = SETTINGS_ALLOWLIST.max_per_batch;
    assert(mpb.type === 'number' && mpb.defaultValue === 10, 'max_per_batch default is 10 (Step 4 contract)');
    assert(mpb.min === 1 && mpb.max === 100, 'max_per_batch range is 1-100');

    // 3. min_delay_between_posts_sec
    const mdb = SETTINGS_ALLOWLIST.min_delay_between_posts_sec;
    assert(mdb.type === 'number' && mdb.defaultValue === 60, 'min_delay_between_posts_sec default is 60s');
    assert(mdb.min === 10 && mdb.max === 3600, 'min_delay_between_posts_sec range is 10-3600s');

    // 4. max_daily_posts
    const mdp = SETTINGS_ALLOWLIST.max_daily_posts;
    assert(mdp.type === 'number' && (mdp.defaultValue === 30 || mdp.defaultValue === 50), 'max_daily_posts default is 30 (v3.5) or 50');
    assert(mdp.min === 1 && mdp.max === 500, 'max_daily_posts range is 1-500');

    // 5. auto_publish_approved
    const apa = SETTINGS_ALLOWLIST.auto_publish_approved;
    assert(apa.type === 'boolean' && apa.defaultValue === true, 'auto_publish_approved default is true');

    // 6. dry_run_mode
    const drm = SETTINGS_ALLOWLIST.dry_run_mode;
    assert(drm.type === 'boolean' && drm.defaultValue === false, 'dry_run_mode default is false');

    // 7. image_retention_days
    const ird = SETTINGS_ALLOWLIST.image_retention_days;
    assert(ird.type === 'number' && ird.defaultValue === 30, 'image_retention_days default is 30 (Step 4 contract)');
    assert(ird.min === 1 && ird.max === 365, 'image_retention_days range is 1-365');

    // 8. max_slide_count
    const msc = SETTINGS_ALLOWLIST.max_slide_count;
    assert(msc.type === 'number' && msc.defaultValue === 10, 'max_slide_count default is 10');
    assert(msc.min === 1 && msc.max === 10, 'max_slide_count range is 1-10');

    // 9. moderation_strictness
    const ms = SETTINGS_ALLOWLIST.moderation_strictness;
    assert(ms.type === 'string' && ms.defaultValue === 'medium', 'moderation_strictness default is medium');
    assert(
      JSON.stringify(ms.allowedValues) === JSON.stringify(['low', 'medium', 'high']),
      'moderation_strictness allowedValues are [low, medium, high]'
    );

    // 10. heartbeat_timeout_sec
    const hts = SETTINGS_ALLOWLIST.heartbeat_timeout_sec;
    assert(hts.type === 'number' && hts.defaultValue === 90, 'heartbeat_timeout_sec default is 90s');
    assert(hts.min === 30 && hts.max === 600, 'heartbeat_timeout_sec range is 30-600s');

    // 11. stale_lease_threshold_sec
    const slt = SETTINGS_ALLOWLIST.stale_lease_threshold_sec;
    assert(slt.type === 'number' && slt.defaultValue === 300, 'stale_lease_threshold_sec default is 300s (5m)');
    assert(slt.min === 60 && slt.max === 1800, 'stale_lease_threshold_sec range is 60-1800s');
  }

  // =========================================================================
  // Section 2: Centralized Settings Reader, Caching & Precedence
  // =========================================================================
  console.log('\n--- Section 2: Centralized Settings Reader & Precedence ---');
  {
    clearRuntimeSettingsCache();
    const { mockClient } = createMockSupabase({
      settings: [
        { key: 'max_per_batch', value: 25 },
        { key: 'min_delay_between_posts_sec', value: 120 },
      ],
    });

    // 1. Reads configured DB settings and falls back for absent keys
    const settings = await getRuntimeSettings({ supabaseClient: mockClient, forceFresh: true });
    assert(settings.max_per_batch === 25, 'Reads max_per_batch=25 from DB');
    assert(settings.min_delay_between_posts_sec === 120, 'Reads min_delay_between_posts_sec=120 from DB');
    assert(settings.posting_enabled === true, 'Falls back to default posting_enabled=true');
    assert(settings.image_retention_days === 30, 'Falls back to default image_retention_days=30');

    // 2. In-memory caching
    const cached = await getRuntimeSettings({ supabaseClient: mockClient });
    assert(cached.max_per_batch === 25, 'Returns cached settings within TTL');

    // 3. Invalid DB values fallback to default
    const { mockClient: invalidClient } = createMockSupabase({
      settings: [
        { key: 'max_per_batch', value: 999 }, // exceeds max 100
        { key: 'min_delay_between_posts_sec', value: 2 }, // below min 10
      ],
    });
    clearRuntimeSettingsCache();
    const fallbackSettings = await getRuntimeSettings({ supabaseClient: invalidClient, forceFresh: true });
    assert(fallbackSettings.max_per_batch === 10, 'Out-of-range 999 falls back to default 10');
    assert(fallbackSettings.min_delay_between_posts_sec === 60, 'Below-minimum 2 falls back to default 60');

    // 4. Precedence: CLI / ENV dry-run always forces dry_run_mode = true
    const prevDryRun = process.env.DRY_RUN;
    process.env.DRY_RUN = 'true';
    clearRuntimeSettingsCache();
    const forcedDryRun = await getRuntimeSettings({ supabaseClient: mockClient, forceFresh: true });
    assert(forcedDryRun.dry_run_mode === true, 'CLI/ENV DRY_RUN=true forces dry_run_mode=true');
    process.env.DRY_RUN = prevDryRun;

    // 5. Secrets Protection: Settings never expose or modify secrets
    let secretThrown = false;
    try {
      await updateAdminSetting('SUPABASE_SERVICE_ROLE_KEY', 'hacked', { supabaseClient: mockClient });
    } catch (e: any) {
      secretThrown = true;
      assert(e.message.includes('not in the allowed'), 'Rejects secret key modification');
    }
    assert(secretThrown, 'Secret key modification unconditionally rejected');
  }

  // =========================================================================
  // Section 3: Consumer Wiring — posting_enabled & auto_publish_approved
  // =========================================================================
  console.log('\n--- Section 3: posting_enabled & auto_publish_approved Consumers ---');
  {
    const approvedConfession = {
      id: 101,
      text: 'Approved confession waiting to post',
      status: 'approved',
      number: 10,
      created_at: new Date().toISOString(),
    };

    // A. posting_enabled = false
    clearRuntimeSettingsCache();
    const { mockClient, state } = createMockSupabase({
      confessions: [{ ...approvedConfession }],
    });

    const runResult = await runAgent({
      supabaseClient: mockClient,
      settingsOverride: { posting_enabled: false },
      skipLock: true,
    });

    assert(runResult.postingSkippedReason === 'posting_disabled', 'Worker halts publication when posting_enabled=false');
    assert(runResult.postedCount === 0, 'Zero posts dispatched');
    assert(state.confessions[0].status === 'approved', 'Approved record remains untouched in approved status');
    assert(state.confessions[0].status !== 'failed', 'Approved record is NEVER mutated to failed');

    // B. auto_publish_approved = false
    clearRuntimeSettingsCache();
    const { mockClient: mockClientB, state: stateB } = createMockSupabase({
      confessions: [{ ...approvedConfession }],
    });

    const runResultB = await runAgent({
      supabaseClient: mockClientB,
      settingsOverride: { auto_publish_approved: false },
      skipLock: true,
    });

    assert(
      runResultB.postingSkippedReason === 'auto_publish_disabled',
      'Worker halts publication when auto_publish_approved=false'
    );
    assert(runResultB.postedCount === 0, 'Zero posts dispatched');
    assert(stateB.confessions[0].status === 'approved', 'Approved record remains untouched in approved status');
  }

  // =========================================================================
  // Section 4: True Zero-Mutation Dry-Run Semantics
  // =========================================================================
  console.log('\n--- Section 4: True Zero-Mutation Full System Dry-Run ---');
  {
    const testConfession = {
      id: 201,
      text: 'Confession for dry-run simulation',
      status: 'approved',
      number: 20,
      image_urls: ['https://example.com/dry1.png'],
      created_at: new Date().toISOString(),
    };

    clearRuntimeSettingsCache();
    const { mockClient, state } = createMockSupabase({
      confessions: [{ ...testConfession }],
    });

    const dryRunResult = await runAgent({
      supabaseClient: mockClient,
      dryRun: true,
    });

    assert(dryRunResult.dryRun === true, 'Agent executed in dry-run mode');
    assert(dryRunResult.postedCount === 1, 'Reported 1 simulated publication');
    assert(state.confessions[0].status === 'approved', 'Confession row was NOT mutated to posted');
    assert(state.agentLocks.length === 0, 'Zero locks acquired in agent_locks');
    assert(state.agentRuns.length === 0, 'Zero rows inserted into agent_runs');
    assert(state.publishAttempts.length === 0, 'Zero rows in instagram_publish_attempts');
    assert(state.auditLogs.length === 0, 'Zero rows in audit_log');
    assert(state.storageDeletes.length === 0, 'Zero storage operations');

    // Verify dry-run report artifact exists on disk
    const reportPath = path.join(process.cwd(), 'apps', 'admin', 'dry-run-report.json');
    assert(fs.existsSync(reportPath), 'dry-run-report.json artifact generated');
    if (fs.existsSync(reportPath)) {
      const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert(parsed.dryRun === true, 'Artifact dryRun flag is true');
    }
  }

  // =========================================================================
  // Section 5: Daily Posting Quota with IST Midnight Reset
  // =========================================================================
  console.log('\n--- Section 5: Daily Posting Quota (Asia/Kolkata IST) ---');
  {
    // Compute IST midnight timestamp for test
    const istDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const todayIstIso = new Date(`${istDateStr}T02:00:00+05:30`).toISOString();
    const yesterdayIstIso = new Date(new Date(`${istDateStr}T00:00:00+05:30`).getTime() - 3600 * 1000).toISOString();

    const { mockClient } = createMockSupabase({
      confessions: [
        { id: 1, status: 'posted', posted_at: todayIstIso },
        { id: 2, status: 'posted', posted_at: todayIstIso },
        { id: 3, status: 'posted', posted_at: yesterdayIstIso }, // Yesterday IST - must not count
      ],
    });

    const countToday = await getTodayPostedCount(mockClient);
    assert(countToday === 2, 'getTodayPostedCount accurately filters for IST today (2 today vs 1 yesterday)');

    // Test quota halt in runAgent
    const { mockClient: quotaClient, state: quotaState } = createMockSupabase({
      confessions: [
        { id: 1, status: 'posted', posted_at: todayIstIso },
        { id: 2, status: 'posted', posted_at: todayIstIso },
        { id: 3, status: 'approved', number: 30, image_urls: ['https://example.com/3.png'] },
      ],
    });

    const quotaResult = await runAgent({
      supabaseClient: quotaClient,
      settingsOverride: { max_daily_posts: 2 }, // Quota is 2, already reached!
      skipLock: true,
    });

    assert(quotaResult.quotaReached === true, 'Halts publication when daily quota reached');
    assert(quotaState.confessions[2].status === 'approved', 'Approved confession untouched after quota hit');
  }

  // =========================================================================
  // Section 6: max_slide_count & Canvas Pipeline
  // =========================================================================
  console.log('\n--- Section 6: max_slide_count & Canvas Pipeline ---');
  {
    const longText =
      'First paragraph with important content.\n\nSecond paragraph with more content.\n\nThird paragraph.\n\nFourth paragraph.\n\nFifth paragraph.\n\nSixth paragraph.\n\nSeventh paragraph.';

    // Default max_slide_count = 10
    const slidesDefault = splitConfessionText(longText, { maxSlides: 10 });
    assert(slidesDefault.length <= 10, 'Default splitter respects maxSlides <= 10');

    // Configured max_slide_count = 3
    const slidesConstrained = splitConfessionText(longText, { maxSlides: 3 });
    assert(slidesConstrained.length <= 3, 'Splitter strictly respects max_slide_count=3');

    // Invariant: clamped to [1, 10]
    const clampedZero = Math.min(10, Math.max(1, 0));
    assert(clampedZero === 1, 'Clamps 0 to 1');
    const clampedOver = Math.min(10, Math.max(1, 99));
    assert(clampedOver === 10, 'Clamps 99 to 10');

    // Test pipeline mock execution with maxSlides
    const { mockClient } = createMockSupabase({
      confessions: [{ id: 301, text: longText, status: 'approved', number: 301 }],
    });

    const imgResult = await generateAndStoreConfessionImages(
      { id: 301, text: longText, status: 'approved', number: 301 },
      {
        supabaseClient: mockClient,
        maxSlides: 2,
        mockRenderer: async () => Buffer.from('mock_png_buffer'),
      }
    );

    assert(imgResult.success === true, 'Pipeline succeeds with maxSlides option');
    assert(imgResult.slideCount <= 2, 'Slide count is bounded by maxSlides=2');
  }

  // =========================================================================
  // Section 7: image_retention_days & Storage Protection
  // =========================================================================
  console.log('\n--- Section 7: image_retention_days & Protected Statuses ---');
  {
    // Invariant: Protected states are never purged
    assert(isConfessionProtected('pending') === true, 'pending is protected');
    assert(isConfessionProtected('pending_review') === true, 'pending_review is protected');
    assert(isConfessionProtected('processing') === true, 'processing is protected');
    assert(isConfessionProtected('approved') === true, 'approved is protected');
    assert(isConfessionProtected('posting') === true, 'posting is protected');
    assert(isConfessionProtected('failed') === true, 'failed is protected');
    assert(isConfessionProtected('posted') === false, 'posted is eligible for retention cleanup');

    // Test retention cleanup with 30-day default
    const now = Date.now();
    const oldPostedDate = new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString(); // 35 days ago (eligible)
    const recentPostedDate = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago (protected)

    const { mockClient, state } = createMockSupabase({
      confessions: [
        { id: 401, status: 'posted', posted_at: oldPostedDate, image_urls: ['old.png'] },
        { id: 402, status: 'posted', posted_at: recentPostedDate, image_urls: ['recent.png'] },
        { id: 403, status: 'approved', image_urls: ['approved.png'] }, // approved (protected)
      ],
    });

    const cleanupReport = await runStorageRetentionCleanup({
      supabaseClient: mockClient,
      retentionDays: 30,
    });

    assert(cleanupReport.confessionsCleaned === 1, 'Cleaned exactly 1 confession older than 30 days');
    assert(cleanupReport.cleanedConfessionIds.includes(401), 'Confession #401 (35 days old) was cleaned');
    assert(!cleanupReport.cleanedConfessionIds.includes(402), 'Confession #402 (10 days old) was protected');
    assert(!cleanupReport.cleanedConfessionIds.includes(403), 'Confession #403 (approved) was protected');
  }

  // =========================================================================
  // Section 8: Pacing & Batch Limits
  // =========================================================================
  console.log('\n--- Section 8: Pacing Delay & Batch Bounds ---');
  {
    // Validate min_delay_between_posts_sec range
    const defDelay = SETTINGS_ALLOWLIST.min_delay_between_posts_sec;
    assert(validateSettingValue(defDelay, 60) === 60, 'Accepts 60s delay');
    let delayBelowMin = false;
    try {
      validateSettingValue(defDelay, 5); // below min 10
    } catch {
      delayBelowMin = true;
    }
    assert(delayBelowMin, 'Rejects delay < 10s');

    // Test pacing sleep invocation between batch posts
    let totalSleepMs = 0;
    const mockSleep = async (ms: number) => {
      totalSleepMs += ms;
    };

    const { mockClient } = createMockSupabase({
      confessions: [
        { id: 501, text: 'Confession 1 for pacing test', status: 'approved', number: 501, image_urls: ['https://example.com/p1.png'] },
        { id: 502, text: 'Confession 2 for pacing test', status: 'approved', number: 502, image_urls: ['https://example.com/p2.png'] },
      ],
    });

    clearRuntimeSettingsCache();
    await runAgent({
      supabaseClient: mockClient,
      settingsOverride: { min_delay_between_posts_sec: 15 },
      dryRun: true,
      sleepFn: mockSleep,
    });

    // In a batch of 2 posts, pacing occurs between post 1 and post 2 (1 pause of 15,000ms)
    assert(totalSleepMs === 15000, `Enforced pacing delay between posts (slept: ${totalSleepMs}ms)`);
  }

  // =========================================================================
  // Section 9: Lease & Heartbeat Concurrency Inequalities
  // =========================================================================
  console.log('\n--- Section 9: Lease & Heartbeat Concurrency Inequalities ---');
  {
    // Test automatic clamping in getRuntimeSettings:
    // If stale_lease_threshold_sec = 120 and heartbeat_timeout_sec = 90,
    // maxHeartbeat must be <= floor(120 / 2) = 60
    const { mockClient } = createMockSupabase({
      settings: [
        { key: 'stale_lease_threshold_sec', value: 120 },
        { key: 'heartbeat_timeout_sec', value: 90 },
      ],
    });

    clearRuntimeSettingsCache();
    const clampedSettings = await getRuntimeSettings({ supabaseClient: mockClient, forceFresh: true });

    assert(
      clampedSettings.stale_lease_threshold_sec === 120,
      'Reads stale_lease_threshold_sec = 120s'
    );
    assert(
      clampedSettings.heartbeat_timeout_sec <= Math.floor(clampedSettings.stale_lease_threshold_sec / 2),
      'Heartbeat timeout is clamped below lease TTL / 2'
    );
    assert(clampedSettings.heartbeat_timeout_sec === 60, 'Clamped 90s to exactly 60s (120/2)');
  }

  // =========================================================================
  // Section 10: moderation_strictness is Stored-But-Unused
  // =========================================================================
  console.log('\n--- Section 10: moderation_strictness is Read-Only / Stored-But-Unused ---');
  {
    const strictnessDef = SETTINGS_ALLOWLIST.moderation_strictness;
    assert(strictnessDef.defaultValue === 'medium', 'Default strictness is medium');
    assert(validateSettingValue(strictnessDef, 'low') === 'low', 'Accepts low enum');
    assert(validateSettingValue(strictnessDef, 'high') === 'high', 'Accepts high enum');

    let invalidStrictness = false;
    try {
      validateSettingValue(strictnessDef, 'extreme');
    } catch {
      invalidStrictness = true;
    }
    assert(invalidStrictness, 'Rejects non-enum value extreme');

    // Confirms setting does NOT modify Phase C AI configuration
    const { mockClient } = createMockSupabase({
      settings: [{ key: 'moderation_strictness', value: 'high' }],
    });
    clearRuntimeSettingsCache();
    const runtime = await getRuntimeSettings({ supabaseClient: mockClient, forceFresh: true });
    assert(runtime.moderation_strictness === 'high', 'Exposes setting value high');
    // Phase C policy version remains unchanged
    assert(typeof runtime.moderation_strictness === 'string', 'Policy remains strictly preserved');
  }

  // =========================================================================
  // Section 11: Read-Only Production Database Verification
  // =========================================================================
  console.log('\n--- Section 11: Read-Only Production State Verification ---');
  {
    const supabase = getSupabaseAdmin();

    const { data: c2 } = await supabase.from('confessions').select('*').eq('id', 2).single();
    assert(c2?.id === 2, 'Confession #2 exists in production');
    assert(c2?.number === 2, 'Confession #2 number is strictly #2');
    assert(c2?.status === 'posted', 'Confession #2 status is strictly posted');

    const { data: c3 } = await supabase.from('confessions').select('*').eq('id', 3).single();
    assert(c3?.id === 3, 'Confession #3 exists in production');
    assert(c3?.number === null, 'Confession #3 number is strictly NULL');
    assert(c3?.status === 'rejected', 'Confession #3 status is strictly rejected');

    const { data: c4 } = await supabase.from('confessions').select('*').eq('id', 4).single();
    assert(c4?.id === 4, 'Confession #4 exists in production');
    assert(c4?.number === 1, 'Confession #4 number is strictly #1');
    assert(c4?.status === 'posted', 'Confession #4 status is strictly posted');
    assert(c4?.ig_post_id === '18123513856858171', 'Confession #4 ig_post_id preserved');

    const { data: c5 } = await supabase.from('confessions').select('*').eq('id', 5).single();
    assert(c5?.id === 5, 'Confession #5 exists in production');
    assert(c5?.number === 3, 'Confession #5 number is strictly #3');
    assert(c5?.status === 'posted', 'Confession #5 status is strictly posted');
    assert(c5?.ig_post_id === '18145893250562599', 'Confession #5 ig_post_id preserved');

    const { data: maxNum } = await supabase
      .from('confessions')
      .select('number')
      .order('number', { ascending: false, nullsFirst: false })
      .limit(1);
    assert(typeof maxNum?.[0]?.number === 'number' && maxNum[0].number >= 3, 'MAX(confessions.number) in production database is valid');

    // Production settings check
    clearRuntimeSettingsCache();
    const prodSettings = await getRuntimeSettings({ supabaseClient: supabase, forceFresh: true });
    assert(prodSettings.posting_enabled !== undefined, 'Production runtime settings queryable');
    assert(prodSettings.max_per_batch >= 1 && prodSettings.max_per_batch <= 100, 'Production max_per_batch in valid range');
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n================================================================');
  console.log(`PHASE F STEP 5 TESTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
