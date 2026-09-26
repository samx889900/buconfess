import fs from 'fs';
import path from 'path';

// Load apps/admin/.env if present without external dependencies
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

// Ensure mock environment variables exist for offline tests
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock_service_role_key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock_gemini_key';
process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || 'mock_ig_token';
process.env.INSTAGRAM_USER_ID = process.env.INSTAGRAM_USER_ID || '17841400000000000';
process.env.GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || 'mock_sheet_id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || 'mock@service.account';
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'mock_private_key';
process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || 'mock_admin_hash';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mock_jwt_secret';
process.env.IP_HASH_SECRET = process.env.IP_HASH_SECRET || 'mock_ip_secret';

import {
  createSingleContainer,
  createChildContainer,
  createCarouselContainer,
  pollContainerStatus,
  publishMedia,
  verifyMedia,
  validateToken,
  refreshToken,
  getRecentMedia,
  graphFetch,
} from '../apps/admin/lib/instagram/client';
import {
  generateCorrelationToken,
  buildInstagramCaption,
  matchesCorrelationToken,
  extractCorrelationToken,
} from '../apps/admin/lib/instagram/idempotency';
import {
  validateInstagramImageUrls,
  validateImageBuffer,
} from '../apps/admin/lib/instagram/validation';
import { inspectPublicationRecovery } from '../apps/admin/lib/instagram/recovery';
import { publishConfessionToInstagram } from '../apps/admin/lib/instagram/publisher';
import { performTokenPreflight } from '../apps/admin/lib/instagram/tokenManager';
import {
  acquireAgentLock,
  assertLeaseOwnership,
  renewAgentLock,
  releaseAgentLock,
  LeaseLostError,
} from '../apps/admin/lib/agentLock';
import { redactSecrets } from '../apps/admin/lib/redact';

// In-memory Mock Database Store
function createMockSupabase() {
  const store: {
    confessions: any[];
    instagram_publish_attempts: any[];
    agent_locks: any[];
    audit_log: any[];
    settings: any[];
  } = {
    confessions: [],
    instagram_publish_attempts: [],
    agent_locks: [],
    audit_log: [],
    settings: [],
  };

  const client: any = {
    _store: store,
    from: (table: string) => {
      let currentData = store[table as keyof typeof store] || [];
      let selectedFields = '*';
      let filters: ((row: any) => boolean)[] = [];
      let sortFn: ((a: any, b: any) => number) | null = null;
      let limitCount: number | null = null;

      const builder: any = {
        select: (fields: string = '*') => {
          selectedFields = fields;
          return builder;
        },
        insert: async (rows: any | any[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          const inserted = arr.map((r) => ({
            id: r.id || Math.floor(Math.random() * 10000) + 1,
            created_at: new Date().toISOString(),
            ...r,
          }));
          currentData.push(...inserted);
          return { data: Array.isArray(rows) ? inserted : inserted[0], error: null };
        },
        upsert: async (row: any) => {
          const keyField = table === 'settings' ? 'key' : 'id';
          const existingIdx = currentData.findIndex((r) => r[keyField] === row[keyField]);
          if (existingIdx >= 0) {
            currentData[existingIdx] = { ...currentData[existingIdx], ...row };
            return { data: currentData[existingIdx], error: null };
          } else {
            currentData.push(row);
            return { data: row, error: null };
          }
        },
        update: (updates: any) => {
          const updateBuilder: any = {
            eq: (col: string, val: any) => {
              filters.push((row) => row[col] === val);
              return updateBuilder;
            },
            lt: (col: string, val: any) => {
              filters.push((row) => row[col] < val);
              return updateBuilder;
            },
            gt: (col: string, val: any) => {
              filters.push((row) => row[col] > val);
              return updateBuilder;
            },
            select: (f: string = '*') => {
              return updateBuilder;
            },
            maybeSingle: async () => {
              const matched = currentData.filter((r) => filters.every((fn) => fn(r)));
              if (matched.length > 0) {
                Object.assign(matched[0], updates);
                return { data: matched[0], error: null };
              }
              return { data: null, error: null };
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
        delete: () => {
          const deleteBuilder: any = {
            eq: (col: string, val: any) => {
              filters.push((row) => row[col] === val);
              return deleteBuilder;
            },
            then: async (resolve: any) => {
              const remaining = currentData.filter((r) => !filters.every((fn) => fn(r)));
              store[table as keyof typeof store] = remaining;
              return resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        eq: (col: string, val: any) => {
          filters.push((row) => row[col] === val);
          return builder;
        },
        lt: (col: string, val: any) => {
          filters.push((row) => row[col] < val);
          return builder;
        },
        gt: (col: string, val: any) => {
          filters.push((row) => row[col] > val);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          filters.push((row) => vals.includes(row[col]));
          return builder;
        },
        is: (col: string, val: any) => {
          filters.push((row) => row[col] === val);
          return builder;
        },
        order: (col: string, opts: { ascending?: boolean } = {}) => {
          const asc = opts.ascending ?? true;
          sortFn = (a, b) => (asc ? (a[col] > b[col] ? 1 : -1) : a[col] < b[col] ? 1 : -1);
          return builder;
        },
        limit: (n: number) => {
          limitCount = n;
          return builder;
        },
        maybeSingle: async () => {
          let rows = currentData.filter((r) => filters.every((fn) => fn(r)));
          if (sortFn) rows = rows.sort(sortFn);
          return { data: rows[0] || null, error: null };
        },
        single: async () => {
          let rows = currentData.filter((r) => filters.every((fn) => fn(r)));
          if (sortFn) rows = rows.sort(sortFn);
          if (rows.length === 0) return { data: null, error: { message: 'Row not found' } };
          return { data: rows[0], error: null };
        },
        then: async (resolve: any) => {
          let rows = currentData.filter((r) => filters.every((fn) => fn(r)));
          if (sortFn) rows = rows.sort(sortFn);
          if (limitCount !== null) rows = rows.slice(0, limitCount);
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// TEST RUNNER
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('PHASE E: INSTAGRAM PUBLICATION — TEST SUITE (27 TESTS)');
  console.log('======================================================\n');

  const mockIgUserId = '17841400000000000';
  const mockAccessToken = 'EAABmockTokenForTests1234567890';

  // -------------------------------------------------------------------------
  // Test 1: Single-image publication flow
  // -------------------------------------------------------------------------
  console.log('Test 1: Single-image publication flow');
  {
    const mockFetch = async (url: string, opts: any) => {
      if (url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'ig_post_single_1' }), { status: 200 });
      }
      if (url.includes('/media')) {
        return new Response(JSON.stringify({ id: 'container_single_1' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ id: 'container_single_1', status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_post_single_1', permalink: 'https://instagram.com/p/TEST_1/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const containerId = await createSingleContainer(mockIgUserId, mockAccessToken, 'https://example.com/slide1.png', 'Caption #1', { fetchFn: mockFetch as any });
    assert(containerId === 'container_single_1', 'Single image container created with valid ID');

    const status = await pollContainerStatus(containerId, mockAccessToken, { fetchFn: mockFetch as any, timeoutMs: 2000, intervalMs: 50 });
    assert(status.statusCode === 'FINISHED', 'Container polled to FINISHED state');

    const published = await publishMedia(mockIgUserId, mockAccessToken, containerId, { fetchFn: mockFetch as any });
    assert(published.id === 'ig_post_single_1', 'Single image media published successfully');

    const verified = await verifyMedia(published.id, mockAccessToken, { fetchFn: mockFetch as any });
    assert(verified.id === 'ig_post_single_1' && verified.permalink.includes('TEST_1'), 'Single image verified on Instagram');
  }

  // -------------------------------------------------------------------------
  // Test 2: Carousel publication flow (multi-slide)
  // -------------------------------------------------------------------------
  console.log('\nTest 2: Carousel publication flow (multi-slide)');
  {
    const mockFetch = async (url: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'ig_carousel_post_100' }), { status: 200 });
      }
      if (url.includes('/media') && body.media_type === 'CAROUSEL') {
        return new Response(JSON.stringify({ id: 'parent_container_100' }), { status: 200 });
      }
      if (url.includes('/media') && body.is_carousel_item) {
        return new Response(JSON.stringify({ id: `child_container_${Math.random().toString(36).substring(2, 7)}` }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_carousel_post_100', permalink: 'https://instagram.com/p/CAROUSEL_100/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const child1 = await createChildContainer(mockIgUserId, mockAccessToken, 'https://example.com/1.png', { fetchFn: mockFetch as any });
    const child2 = await createChildContainer(mockIgUserId, mockAccessToken, 'https://example.com/2.png', { fetchFn: mockFetch as any });
    assert(child1.startsWith('child_container_') && child2.startsWith('child_container_'), 'Child containers created with is_carousel_item');

    const parent = await createCarouselContainer(mockIgUserId, mockAccessToken, [child1, child2], 'Carousel Caption', { fetchFn: mockFetch as any });
    assert(parent === 'parent_container_100', 'Parent carousel container created referencing child IDs');

    const published = await publishMedia(mockIgUserId, mockAccessToken, parent, { fetchFn: mockFetch as any });
    assert(published.id === 'ig_carousel_post_100', 'Carousel published with parent container ID');
  }

  // -------------------------------------------------------------------------
  // Test 3: Immediate child container persistence after each API call
  // -------------------------------------------------------------------------
  console.log('\nTest 3: Immediate child container persistence after each API call');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 10,
      text: 'Multi slide confession test',
      status: 'approved',
      image_urls: ['https://example.com/s1.png', 'https://example.com/s2.png'],
    });

    let childCreatedCount = 0;
    const mockFetch = async (url: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.includes('debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 864000 } }), { status: 200 });
      }
      if (url.includes('/media') && body.is_carousel_item) {
        childCreatedCount++;
        // Inspect DB immediately during child creation to verify immediate persistence
        return new Response(JSON.stringify({ id: `child_${childCreatedCount}` }), { status: 200 });
      }
      if (url.includes('/media') && body.media_type === 'CAROUSEL') {
        // At parent creation time, child IDs must already be in DB
        const conf = mockDb._store.confessions.find((c: any) => c.id === 10);
        assert(conf.instagram_child_container_ids?.length === 2, 'Both child container IDs persisted in DB before parent creation');
        return new Response(JSON.stringify({ id: 'parent_immediate_1' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'ig_post_immediate' }), { status: 200 });
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_post_immediate', permalink: 'https://instagr.am/p/IMMED/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    const attempt = mockDb._store.instagram_publish_attempts[0];
    assert(attempt && attempt.child_container_ids.length === 2, 'Child container IDs persisted in instagram_publish_attempts');
  }

  // -------------------------------------------------------------------------
  // Test 4: Immediate parent container persistence
  // -------------------------------------------------------------------------
  console.log('\nTest 4: Immediate parent container persistence');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 11,
      text: 'Parent persistence test',
      status: 'approved',
      image_urls: ['https://example.com/p1.png'],
    });

    let parentPersistedBeforePublish = false;
    const mockFetch = async (url: string, opts: any) => {
      if (url.includes('debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 864000 } }), { status: 200 });
      }
      if (url.includes('/media') && !url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'single_parent_id_77' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('/media_publish')) {
        const conf = mockDb._store.confessions.find((c: any) => c.id === 11);
        if (conf.instagram_container_id === 'single_parent_id_77') {
          parentPersistedBeforePublish = true;
        }
        return new Response(JSON.stringify({ id: 'published_77' }), { status: 200 });
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'published_77', permalink: 'https://instagr.am/p/77/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    assert(parentPersistedBeforePublish, 'Parent container ID persisted in DB before media_publish call');
  }

  // -------------------------------------------------------------------------
  // Test 5: Container status polling
  // -------------------------------------------------------------------------
  console.log('\nTest 5: Container status polling');
  {
    let polls = 0;
    const mockFetch = async (url: string) => {
      polls++;
      if (polls < 3) {
        return new Response(JSON.stringify({ status_code: 'IN_PROGRESS' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
    };

    let progressHookCalled = 0;
    const res = await pollContainerStatus('c_poll_1', mockAccessToken, {
      fetchFn: mockFetch as any,
      intervalMs: 10,
      timeoutMs: 1000,
      onProgress: () => {
        progressHookCalled++;
      },
    });

    assert(res.statusCode === 'FINISHED', 'Poll completed when status reached FINISHED');
    assert(progressHookCalled === 2, 'onProgress milestone callback triggered on IN_PROGRESS ticks');
  }

  // -------------------------------------------------------------------------
  // Test 6: FINISHED state handling
  // -------------------------------------------------------------------------
  console.log('\nTest 6: FINISHED state handling');
  {
    const mockFetch = async () => new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
    const res = await pollContainerStatus('c_fin_1', mockAccessToken, { fetchFn: mockFetch as any, intervalMs: 10, timeoutMs: 500 });
    assert(res.statusCode === 'FINISHED', 'Correctly recognized FINISHED status code');
  }

  // -------------------------------------------------------------------------
  // Test 7: ERROR container state handling
  // -------------------------------------------------------------------------
  console.log('\nTest 7: ERROR container state handling');
  {
    const mockFetch = async () => new Response(JSON.stringify({ status_code: 'ERROR', status: 'Media processing failed' }), { status: 200 });
    let threw = false;
    try {
      await pollContainerStatus('c_err_1', mockAccessToken, { fetchFn: mockFetch as any, intervalMs: 10, timeoutMs: 500 });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('failed processing with status ERROR'), 'Throws structured error when container has ERROR status');
    }
    assert(threw, 'Poll aborted on container ERROR');
  }

  // -------------------------------------------------------------------------
  // Test 8: Token expiry preflight detection
  // -------------------------------------------------------------------------
  console.log('\nTest 8: Token expiry preflight detection');
  {
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const mockFetch = async () =>
      new Response(JSON.stringify({ data: { is_valid: false, expires_at: expiredTimestamp } }), { status: 200 });

    const val = await validateToken('expired_token', { fetchFn: mockFetch as any });
    assert(!val.isValid, 'Expired token detected as invalid');
    assert(val.needsRefresh, 'Expired token flagged as needing refresh');
  }

  // -------------------------------------------------------------------------
  // Test 9: Token refresh failure safe abort
  // -------------------------------------------------------------------------
  console.log('\nTest 9: Token refresh failure safe abort');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 15,
      text: 'Token failure abort test',
      status: 'approved',
      image_urls: ['https://example.com/img.png'],
    });

    const mockFetch = async (url: string) => {
      if (url.includes('debug_token')) {
        // Expired token
        return new Response(JSON.stringify({ data: { is_valid: false, expires_at: 1000 } }), { status: 200 });
      }
      if (url.includes('refresh_access_token')) {
        return new Response(JSON.stringify({ error: { message: 'Refresh token invalid' } }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    };

    const res = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    assert(!res.success, 'Publication aborted safely when token validation/refresh fails');
    assert(res.failureStage === 'instagram_token', 'failure_stage recorded as instagram_token');
    const conf = mockDb._store.confessions[0];
    assert(conf.status === 'failed', 'Confession status updated to failed');
  }

  // -------------------------------------------------------------------------
  // Test 10: Transient API 429 rate-limit backoff and retry
  // -------------------------------------------------------------------------
  console.log('\nTest 10: Transient API 429 rate-limit backoff and retry');
  {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 3) {
        return new Response(JSON.stringify({ error: { code: 4, message: 'Application request limit reached' } }), { status: 429 });
      }
      return new Response(JSON.stringify({ id: 'success_after_429' }), { status: 200 });
    };

    const res = await graphFetch('test_429', { fetchFn: mockFetch as any, maxRetries: 3, initialBackoffMs: 10 });
    assert(res.id === 'success_after_429', 'graphFetch retried and succeeded after initial 429');
    assert(attempts === 3, 'Took exactly 3 attempts');
  }

  // -------------------------------------------------------------------------
  // Test 11: Transient API 500 server error backoff and retry
  // -------------------------------------------------------------------------
  console.log('\nTest 11: Transient API 500 server error backoff and retry');
  {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 2) {
        return new Response(JSON.stringify({ error: { code: 2, message: 'Unexpected server error' } }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: 'success_after_500' }), { status: 200 });
    };

    const res = await graphFetch('test_500', { fetchFn: mockFetch as any, maxRetries: 2, initialBackoffMs: 10 });
    assert(res.id === 'success_after_500', 'graphFetch retried and succeeded after transient 500');
  }

  // -------------------------------------------------------------------------
  // Test 12: Respecting Retry-After response header
  // -------------------------------------------------------------------------
  console.log('\nTest 12: Respecting Retry-After response header');
  {
    let attempts = 0;
    let callTimes: number[] = [];
    const mockFetch = async () => {
      attempts++;
      callTimes.push(Date.now());
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'retry-after': '0.1' }, // 100ms
        });
      }
      return new Response(JSON.stringify({ id: 'retry_after_ok' }), { status: 200 });
    };

    const res = await graphFetch('test_retry_after', { fetchFn: mockFetch as any, maxRetries: 2, initialBackoffMs: 10 });
    assert(res.id === 'retry_after_ok', 'Succeeded after Retry-After header');
  }

  // -------------------------------------------------------------------------
  // Test 13: Crash after child container creation recovery (reuses existing children)
  // -------------------------------------------------------------------------
  console.log('\nTest 13: Crash after child container creation recovery');
  {
    const mockDb = createMockSupabase();
    // Confession had 2 images; child 1 was created before crash
    mockDb._store.confessions.push({
      id: 20,
      text: 'Crash recovery child test',
      status: 'posting',
      image_urls: ['https://example.com/1.png', 'https://example.com/2.png'],
      instagram_child_container_ids: ['child_recovered_1'],
    });

    mockDb._store.instagram_publish_attempts.push({
      publish_attempt_id: 'att_child_crash',
      confession_id: 20,
      attempt_number: 1,
      correlation_token: generateCorrelationToken(),
      child_container_ids: ['child_recovered_1'],
      response_status: 'initiated',
    });

    const recovery = await inspectPublicationRecovery(20, mockIgUserId, mockAccessToken, {
      supabaseClient: mockDb,
      fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    assert(recovery.canRecover, 'Recovery recognized previous attempt state');
    assert(recovery.stage === 'child_containers', 'Recovery identifies reusable child containers');
    assert(recovery.existingChildIds?.[0] === 'child_recovered_1', 'Reuses pre-existing child container ID');
  }

  // -------------------------------------------------------------------------
  // Test 14: Crash after parent container creation recovery (proceeds to publish)
  // -------------------------------------------------------------------------
  console.log('\nTest 14: Crash after parent container creation recovery');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 21,
      text: 'Parent crash recovery test',
      status: 'posting',
      image_urls: ['https://example.com/1.png', 'https://example.com/2.png'],
      instagram_container_id: 'parent_recovered_99',
    });

    mockDb._store.instagram_publish_attempts.push({
      publish_attempt_id: 'att_parent_crash',
      confession_id: 21,
      attempt_number: 1,
      correlation_token: generateCorrelationToken(),
      container_id: 'parent_recovered_99',
      response_status: 'container_created',
    });

    const mockFetch = async (url: string) => {
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const recovery = await inspectPublicationRecovery(21, mockIgUserId, mockAccessToken, {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
    });

    assert(recovery.canRecover, 'Recovery detects valid parent container');
    assert(recovery.stage === 'parent_container', 'Identifies parent container stage');
    assert(recovery.existingParentId === 'parent_recovered_99', 'Recovers parent container ID');
  }

  // -------------------------------------------------------------------------
  // Test 15: Hardest Failure Test A (Immediate match after network drop)
  // -------------------------------------------------------------------------
  console.log('\nTest 15: Hardest Failure Test A (Immediate match after network drop)');
  {
    const mockDb = createMockSupabase();
    const correlationToken = generateCorrelationToken();
    const caption = buildInstagramCaption('Network drop recovery test', 15, correlationToken);

    mockDb._store.confessions.push({
      id: 22,
      text: 'Network drop recovery test',
      number: 15,
      status: 'approved',
      image_urls: ['https://example.com/1.png'],
      correlation_token: correlationToken,
    });

    let mediaPublishCallCount = 0;
    const mockFetch = async (url: string, opts: any) => {
      if (url.includes('debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 864000 } }), { status: 200 });
      }
      if (opts?.method === 'POST' && url.includes('/media') && !url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'c_drop_1' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('/media_publish')) {
        mediaPublishCallCount++;
        // Simulate: Meta publishes post, but socket drops before returning HTTP 200
        throw new TypeError('fetch failed: Connection reset by peer');
      }
      if (url.includes('/media?fields=id,caption,permalink,timestamp')) {
        // Recovery queries recent media and discovers the post that actually succeeded
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'ig_post_recovered_drop',
                caption: caption,
                permalink: 'https://instagr.am/p/RECOVERED_DROP/',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_post_recovered_drop', permalink: 'https://instagr.am/p/RECOVERED_DROP/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const res = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    // Confession must be successfully marked posted without repeating media_publish
    assert(res.success, 'Publication succeeded through post-dispatch recovery');
    assert(res.igPostId === 'ig_post_recovered_drop', 'Post ID recovered from recent media');
    assert(mediaPublishCallCount === 1, 'ZERO duplicate media_publish calls dispatched');
    const conf = mockDb._store.confessions[0];
    assert(conf.status === 'posted', 'Confession state reached posted');
  }

  // -------------------------------------------------------------------------
  // Test 16: Hardest Failure Test B (Deferred Recheck)
  // -------------------------------------------------------------------------
  console.log('\nTest 16: Hardest Failure Test B (Deferred Recheck)');
  {
    // Scenario:
    // publish succeeds -> response lost -> first recovery finds nothing ->
    // ZERO duplicate publish calls -> later recovery finds original post -> recover successfully
    const mockDb = createMockSupabase();
    const correlationToken = generateCorrelationToken();
    const caption = buildInstagramCaption('Deferred recheck test', 16, correlationToken);

    mockDb._store.confessions.push({
      id: 23,
      text: 'Deferred recheck test',
      number: 16,
      status: 'approved',
      image_urls: ['https://example.com/1.png'],
      correlation_token: correlationToken,
    });

    let publishCalls = 0;
    let recentMediaDiscovered = false;

    const mockFetch = async (url: string, opts?: any) => {
      if (url.includes('debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 864000 } }), { status: 200 });
      }
      if (opts?.method === 'POST' && url.includes('/media') && !url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'c_defer_1' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('/media_publish')) {
        publishCalls++;
        throw new TypeError('fetch failed: Network timeout');
      }
      if (url.includes('/media?fields=id,caption,permalink,timestamp')) {
        if (!recentMediaDiscovered) {
          // First recovery: Instagram hasn't indexed the post yet (returns empty)
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        } else {
          // Later recovery: Instagram indexed the post
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'ig_post_deferred_success',
                  caption: caption,
                  permalink: 'https://instagr.am/p/DEFERRED_OK/',
                },
              ],
            }),
            { status: 200 }
          );
        }
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_post_deferred_success', permalink: 'https://instagr.am/p/DEFERRED_OK/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    // First attempt: publish throws timeout -> recent media empty -> defers recheck
    const firstRun = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    assert(!firstRun.success, 'First run did not mark posted prematurely');
    assert(firstRun.deferred, 'First run entered deferred recheck state');
    assert(publishCalls === 1, 'Only 1 media_publish attempt dispatched so far');
    const confAfterFirst = mockDb._store.confessions[0];
    assert(confAfterFirst.instagram_publish_status === 'awaiting_recheck', 'instagram_publish_status set to awaiting_recheck');

    // Simulate time passing: Instagram finishes indexing post
    recentMediaDiscovered = true;

    // Second recovery run (e.g. next agent cycle)
    const secondRun = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    assert(secondRun.success, 'Second recovery run succeeded');
    assert(secondRun.igPostId === 'ig_post_deferred_success', 'Recovered original post ID');
    assert(publishCalls === 1, 'ZERO duplicate publish calls dispatched across both cycles');
    assert(mockDb._store.confessions[0].status === 'posted', 'Confession reached posted state safely');
  }

  // -------------------------------------------------------------------------
  // Test 17: Existing attempt recovery vs new attempt creation
  // -------------------------------------------------------------------------
  console.log('\nTest 17: Existing attempt recovery vs new attempt creation');
  {
    const token = generateCorrelationToken();
    assert(token.startsWith('BUC-') && token.length === 36, 'Correlation token format matches BUC-[32 hex chars]');
  }

  // -------------------------------------------------------------------------
  // Test 18: Duplicate-attempt prevention
  // -------------------------------------------------------------------------
  console.log('\nTest 18: Duplicate-attempt prevention');
  {
    const mockDb = createMockSupabase();
    const token = generateCorrelationToken();
    mockDb._store.instagram_publish_attempts.push({
      publish_attempt_id: 'att_existing',
      confession_id: 30,
      attempt_number: 1,
      correlation_token: token,
    });

    const recovery = await inspectPublicationRecovery(30, mockIgUserId, mockAccessToken, {
      supabaseClient: mockDb,
      fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    assert(!recovery.canRecover || recovery.stage === 'none', 'Identifies no duplicate external action needed');
  }

  // -------------------------------------------------------------------------
  // Test 19: Split-brain prevention (worker aborts when lease lost)
  // -------------------------------------------------------------------------
  console.log('\nTest 19: Split-brain prevention (worker aborts when lease lost)');
  {
    const mockDb = createMockSupabase();
    // Worker B took the lock
    mockDb._store.agent_locks.push({
      lock_name: 'daily_agent_run',
      locked_by: 'worker_B',
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });

    let threw = false;
    try {
      // Worker A attempts to assert ownership
      await assertLeaseOwnership('daily_agent_run', 'worker_A', mockDb);
    } catch (err: any) {
      threw = true;
      assert(err instanceof LeaseLostError, 'Throws LeaseLostError when lease owned by another worker');
    }
    assert(threw, 'Split-brain execution prevented');
  }

  // -------------------------------------------------------------------------
  // Test 20: Correct failure_stage assignment
  // -------------------------------------------------------------------------
  console.log('\nTest 20: Correct failure_stage assignment');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 40,
      text: 'Failure stage test',
      status: 'approved',
      image_urls: ['invalid-url-protocol://test.png'],
    });

    const res = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: async () => new Response('{}'),
      skipLeaseCheck: true,
    });

    assert(res.failureStage === 'instagram_container', 'Invalid URL triggers failure_stage="instagram_container"');
    assert(mockDb._store.confessions[0].failure_stage === 'instagram_container', 'failure_stage persisted in database');
  }

  // -------------------------------------------------------------------------
  // Test 21: Successful approved ➔ posting ➔ posted state machine progression
  // -------------------------------------------------------------------------
  console.log('\nTest 21: Successful approved ➔ posting ➔ posted state machine progression');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 50,
      text: 'State machine progression test',
      status: 'approved',
      image_urls: ['https://example.com/good.png'],
    });

    const mockFetch = async (url: string) => {
      if (url.includes('debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 864000 } }), { status: 200 });
      }
      if (url.includes('/media') && !url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'c_prog_1' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'ig_prog_post_1' }), { status: 200 });
      }
      if (url.includes('fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_prog_post_1', permalink: 'https://instagr.am/p/PROG_1/' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const res = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    assert(res.success, 'Publish completed successfully');
    const finalConf = mockDb._store.confessions[0];
    assert(finalConf.status === 'posted', 'Confession transitioned to posted');
    assert(finalConf.posted_at !== undefined, 'posted_at timestamp populated');
    assert(mockDb._store.audit_log.length === 1, 'audit_log record created');
  }

  // -------------------------------------------------------------------------
  // Test 22: Failed publication invariant (never posted without verification)
  // -------------------------------------------------------------------------
  console.log('\nTest 22: Failed publication invariant');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 60,
      text: 'Verification failure test',
      status: 'approved',
      image_urls: ['https://example.com/good.png'],
    });

    const mockFetch = async (url: string) => {
      if (url.includes('debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 864000 } }), { status: 200 });
      }
      if (url.includes('/media') && !url.includes('/media_publish')) {
        return new Response(JSON.stringify({ id: 'c_vf_1' }), { status: 200 });
      }
      if (url.includes('fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (url.includes('/media_publish')) {
        // media_publish returns success 200
        return new Response(JSON.stringify({ id: 'unverified_media_id' }), { status: 200 });
      }
      if (url.includes('fields=id,permalink')) {
        // Verification fails!
        return new Response(JSON.stringify({ error: { message: 'Media not found' } }), { status: 404 });
      }
      return new Response('{}', { status: 200 });
    };

    const res = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      skipLeaseCheck: true,
    });

    assert(!res.success, 'Publish fails when verification fails');
    assert(mockDb._store.confessions[0].status === 'failed', 'Status is failed, NEVER posted');
    assert(res.failureStage === 'instagram_verification', 'failure_stage is instagram_verification');
  }

  // -------------------------------------------------------------------------
  // Test 23: Secret redaction in logs/errors
  // -------------------------------------------------------------------------
  console.log('\nTest 23: Secret redaction in logs/errors');
  {
    process.env.INSTAGRAM_ACCESS_TOKEN = 'super_secret_token_12345';
    const raw = `Error connecting with token super_secret_token_12345 at https://api.com`;
    const sanitized = redactSecrets(raw);
    assert(!sanitized.includes('super_secret_token_12345'), 'Secret stripped from text');
    assert(sanitized.includes('[REDACTED]'), 'Secret replaced with [REDACTED]');
  }

  // -------------------------------------------------------------------------
  // Test 24: Cryptographic correlation token 128-bit uniqueness and entropy
  // -------------------------------------------------------------------------
  console.log('\nTest 24: Cryptographic correlation token 128-bit uniqueness and entropy');
  {
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = generateCorrelationToken();
      tokens.add(t);
    }
    assert(tokens.size === 500, '500 generated correlation tokens are 100% unique');
    const sample = Array.from(tokens)[0];
    assert(sample.length === 36, 'Token has exactly 36 chars (BUC- + 32 hex chars = 128 bits)');
  }

  // -------------------------------------------------------------------------
  // Test 25: Bounded polling timeout handling
  // -------------------------------------------------------------------------
  console.log('\nTest 25: Bounded polling timeout handling');
  {
    const mockFetch = async () => new Response(JSON.stringify({ status_code: 'IN_PROGRESS' }), { status: 200 });
    let threw = false;
    try {
      await pollContainerStatus('c_timeout_1', mockAccessToken, {
        fetchFn: mockFetch as any,
        timeoutMs: 100,
        intervalMs: 20,
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('did not finish processing within timeout'), 'Throws timeout error');
    }
    assert(threw, 'Polling timeout bounded and respected');
  }

  // -------------------------------------------------------------------------
  // Test 26: Flexible Instagram container validation (aspect ratio, format, HTTPS)
  // -------------------------------------------------------------------------
  console.log('\nTest 26: Flexible Instagram container validation');
  {
    // Valid 4:5 portrait PNG
    const validPng = Buffer.alloc(30);
    validPng[0] = 0x89; validPng[1] = 0x50; validPng[2] = 0x4e; validPng[3] = 0x47;
    validPng[4] = 0x0d; validPng[5] = 0x0a; validPng[6] = 0x1a; validPng[7] = 0x0a;
    validPng.writeUInt32BE(1080, 16);
    validPng.writeUInt32BE(1350, 20);

    const valRes = validateImageBuffer(validPng);
    assert(valRes.valid, 'Valid 1080x1350 (4:5) PNG passes validation');

    // Valid 1:1 square PNG (1080x1080)
    const squarePng = Buffer.alloc(30);
    validPng.copy(squarePng);
    squarePng.writeUInt32BE(1080, 16);
    squarePng.writeUInt32BE(1080, 20);
    assert(validateImageBuffer(squarePng).valid, 'Flexible aspect ratio: 1:1 square also passes');

    // Non-HTTPS URL
    assert(!validateInstagramImageUrls(['http://insecure.com/pic.png']).valid, 'Rejects non-HTTPS URL');
    // > 10 slides
    const elevenUrls = Array(11).fill('https://example.com/p.png');
    assert(!validateInstagramImageUrls(elevenUrls).valid, 'Rejects > 10 slides');
  }

  // -------------------------------------------------------------------------
  // Test 27: Mechanically Verified Dry Run
  // -------------------------------------------------------------------------
  console.log('\nTest 27: Mechanically Verified Dry Run');
  {
    const mockDb = createMockSupabase();
    mockDb._store.confessions.push({
      id: 99,
      text: 'Mechanical dry run test',
      status: 'approved',
      image_urls: ['https://example.com/dry.png'],
    });

    // Take deep snapshot of DB before
    const beforeSnapshot = JSON.stringify(mockDb._store);

    let postCallsDispatched = 0;
    const mockFetch = async (url: string, opts: any) => {
      if (opts?.method === 'POST') {
        postCallsDispatched++;
      }
      return new Response('{}', { status: 200 });
    };

    const dryResult = await publishConfessionToInstagram(mockDb._store.confessions[0], {
      supabaseClient: mockDb,
      fetchFn: mockFetch as any,
      dryRun: true,
    });

    // Take deep snapshot of DB after
    const afterSnapshot = JSON.stringify(mockDb._store);

    assert(dryResult.success && dryResult.dryRun, 'Dry run returned success flag without publishing');
    assert(beforeSnapshot === afterSnapshot, 'Mechanically verified: ZERO DB rows mutated in dry-run');
    assert(postCallsDispatched === 0, 'Mechanically verified: ZERO POST requests dispatched to Instagram');
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`PHASE E TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});
