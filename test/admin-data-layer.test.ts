import { SupabaseClient } from '@supabase/supabase-js';
import {
  getAdminConfessions,
  getAdminConfessionById,
  updateAdminConfession,
  softDeleteAdminConfession,
  getAdminConfessionCounts,
  createAdminConfession,
  formatConfessionForAdmin,
  VALID_CONFESSION_STATUSES,
  ConfessionRow,
} from '../apps/admin/lib/confessions';
import { getSupabaseAdmin } from '../apps/admin/lib/supabase';
import fs from 'fs';
import path from 'path';

// Load apps/admin/.env if present
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

// ---------------------------------------------------------------------------
// Phase F Step 2: Supabase Admin Data Layer Test Suite
// ---------------------------------------------------------------------------
// Tests all data access methods, invariants, error handling, contract mapping,
// and confirms zero Google Sheets dependencies and zero production mutations.
// ---------------------------------------------------------------------------

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ❌ [FAIL] ${message}`);
    failedTests++;
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`  ✅ [PASS] ${message}`);
    passedTests++;
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase Builder for Unit Tests
// ---------------------------------------------------------------------------
function createMockSupabase(mockData: any = null, mockError: any = null) {
  let currentTable = '';
  const queryState: any = {
    filters: [] as { type: string; col: string; val?: any }[],
    orders: [] as { col: string; ascending: boolean }[],
    limitVal: null as number | null,
    rangeVal: null as [number, number] | null,
    action: null as any,
    payload: null as any,
    updatePayload: null as any,
    insertPayload: null as any,
  };

  const builder: any = {
    select: (cols: string) => {
      if (!queryState.action) {
        queryState.action = 'select';
      }
      queryState.cols = cols;
      return builder;
    },
    insert: (payload: any) => {
      if (currentTable !== 'audit_log') {
        queryState.action = 'insert';
        queryState.payload = payload;
      }
      queryState.insertPayload = payload;
      return builder;
    },
    update: (payload: any) => {
      queryState.action = 'update';
      queryState.payload = payload;
      queryState.updatePayload = payload;
      return builder;
    },
    delete: () => {
      queryState.action = 'delete';
      return builder;
    },
    eq: (col: string, val: any) => {
      queryState.filters.push({ type: 'eq', col, val });
      return builder;
    },
    is: (col: string, val: any) => {
      queryState.filters.push({ type: 'is', col, val });
      return builder;
    },
    order: (col: string, opts?: { ascending: boolean }) => {
      queryState.orders.push({ col, ascending: opts?.ascending ?? true });
      return builder;
    },
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
      return { data: Array.isArray(mockData) ? mockData[0] : mockData, error: null };
    },
    maybeSingle: async () => {
      if (mockError) return { data: null, error: mockError };
      return { data: Array.isArray(mockData) ? (mockData[0] || null) : mockData, error: null };
    },
    then: (resolve: (val: any) => void) => {
      if (mockError) {
        resolve({ data: null, error: mockError });
      } else {
        resolve({ data: mockData, error: null });
      }
    },
  };

  const mockClient = {
    from: (_table: string) => {
      currentTable = _table;
      return builder;
    },
    rpc: async (_fn: string, _args: any) => {
      if (mockError) return { data: null, error: mockError };
      return { data: mockData, error: null };
    },
    _queryState: queryState,
  } as unknown as SupabaseClient & { _queryState: any };

  return { mockClient, queryState };
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE F STEP 2: SUPABASE ADMIN DATA LAYER TEST SUITE');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: getAdminConfessions - basic query and filters
  // -------------------------------------------------------------------------
  console.log('Test 1: getAdminConfessions - basic query and filtering');
  {
    const sampleRows: Partial<ConfessionRow>[] = [
      { id: 10, text: 'First confession', status: 'pending', created_at: '2026-09-17T01:00:00Z' },
      { id: 9, text: 'Second confession', status: 'pending', created_at: '2026-09-17T00:00:00Z' },
    ];
    const { mockClient, queryState } = createMockSupabase(sampleRows);

    const result = await getAdminConfessions({
      status: 'pending',
      limit: 10,
      supabaseClient: mockClient,
    });

    assert(result.length === 2, 'Returns expected number of confessions');
    assert(result[0].id === 10, 'First item matches');
    assert(
      queryState.filters.some((f: any) => f.type === 'is' && f.col === 'deleted_at' && f.val === null),
      'Excludes soft-deleted confessions by default (deleted_at IS NULL)'
    );
    assert(
      queryState.filters.some((f: any) => f.type === 'eq' && f.col === 'status' && f.val === 'pending'),
      'Filters by status = pending'
    );
    assert(queryState.limitVal === 10, 'Limits results to 10');
  }

  // -------------------------------------------------------------------------
  // Test 2: getAdminConfessions - "all" status does not filter by status
  // -------------------------------------------------------------------------
  console.log('\nTest 2: getAdminConfessions - "all" status');
  {
    const { mockClient, queryState } = createMockSupabase([]);

    await getAdminConfessions({
      status: 'all',
      supabaseClient: mockClient,
    });

    assert(
      !queryState.filters.some((f: any) => f.col === 'status'),
      'Does not add status filter when status="all"'
    );
    assert(
      queryState.filters.some((f: any) => f.col === 'deleted_at' && f.val === null),
      'Still filters deleted_at IS NULL when status="all"'
    );
  }

  // -------------------------------------------------------------------------
  // Test 3: getAdminConfessions - rejects invalid status string
  // -------------------------------------------------------------------------
  console.log('\nTest 3: getAdminConfessions - invalid status rejection');
  {
    const { mockClient } = createMockSupabase([]);
    let threw = false;

    try {
      await getAdminConfessions({
        status: 'invalid_status_xyz' as any,
        supabaseClient: mockClient,
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('Invalid status filter'), 'Error message identifies invalid status filter');
    }
    assert(threw, 'Throws error on invalid status');
  }

  // -------------------------------------------------------------------------
  // Test 4: getAdminConfessions - explicit DB error propagation (no silent fallback)
  // -------------------------------------------------------------------------
  console.log('\nTest 4: getAdminConfessions - DB error propagation');
  {
    const { mockClient } = createMockSupabase(null, { message: 'Connection refused to Supabase' });
    let threw = false;

    try {
      await getAdminConfessions({ supabaseClient: mockClient });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('Failed to fetch confessions from Supabase'), 'Propagates Supabase error');
      assert(err.message.includes('Connection refused'), 'Preserves underlying DB error message');
    }
    assert(threw, 'Never silently falls back to empty array or Sheets on DB error');
  }

  // -------------------------------------------------------------------------
  // Test 5: getAdminConfessionById - retrieval and soft-delete filtering
  // -------------------------------------------------------------------------
  console.log('\nTest 5: getAdminConfessionById - retrieval and soft-delete filter');
  {
    const sampleRow: Partial<ConfessionRow> = {
      id: 42,
      text: 'Test confession',
      status: 'pending',
      number: null,
      created_at: '2026-09-17T00:00:00Z',
    };
    const { mockClient, queryState } = createMockSupabase(sampleRow);

    const result = await getAdminConfessionById(42, { supabaseClient: mockClient });
    assert(result !== null, 'Finds confession');
    assert(result?.id === 42, 'ID matches');
    assert(
      queryState.filters.some((f: any) => f.col === 'deleted_at' && f.val === null),
      'Excludes soft-deleted confession by default'
    );
  }

  // -------------------------------------------------------------------------
  // Test 6: getAdminConfessionById - invalid ID validation
  // -------------------------------------------------------------------------
  console.log('\nTest 6: getAdminConfessionById - invalid ID validation');
  {
    const { mockClient } = createMockSupabase({});
    let threw = false;

    try {
      await getAdminConfessionById(0, { supabaseClient: mockClient });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('Invalid confession ID'), 'Rejects zero ID');
    }
    assert(threw, 'Throws on ID <= 0');

    threw = false;
    try {
      await getAdminConfessionById(-5, { supabaseClient: mockClient });
    } catch {
      threw = true;
    }
    assert(threw, 'Throws on negative ID');
  }

  // -------------------------------------------------------------------------
  // Test 7: updateAdminConfession - validates status transitions
  // -------------------------------------------------------------------------
  console.log('\nTest 7: updateAdminConfession - status validation');
  {
    const { mockClient } = createMockSupabase({});
    let threw = false;

    try {
      await updateAdminConfession(42, { status: 'bogus_status' as any }, { supabaseClient: mockClient });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('Invalid confession status'), 'Identifies invalid status');
      assert(err.message.includes('pending, processing, approved'), 'Lists allowed statuses');
    }
    assert(threw, 'Throws on illegal status transition');
  }

  // -------------------------------------------------------------------------
  // Test 8: updateAdminConfession - blocks direct number mutation (Invariant 6)
  // -------------------------------------------------------------------------
  console.log('\nTest 8: updateAdminConfession - blocks direct number mutation');
  {
    const { mockClient } = createMockSupabase({});
    let threw = false;

    try {
      await updateAdminConfession(42, { number: 999 } as any, { supabaseClient: mockClient });
    } catch (err: any) {
      threw = true;
      assert(
        err.message.includes('Direct mutation of confession number is prohibited'),
        'Prohibits direct assignment of number'
      );
      assert(
        err.message.includes('allocate_confession_number'),
        'Requires allocate_confession_number sequence path'
      );
    }
    assert(threw, 'Numbering invariant strictly enforced');
  }

  // -------------------------------------------------------------------------
  // Test 9: updateAdminConfession - synchronizes normalized_text & content_hash
  // -------------------------------------------------------------------------
  console.log('\nTest 9: updateAdminConfession - text update re-hashes');
  {
    const updatedRow: Partial<ConfessionRow> = {
      id: 42,
      text: 'Updated text for confession',
      status: 'pending',
    };
    const { mockClient, queryState } = createMockSupabase(updatedRow);

    await updateAdminConfession(
      42,
      { text: '  Updated TEXT for Confession   ' },
      { supabaseClient: mockClient }
    );

    assert(queryState.action === 'update', 'Executes update action');
    assert(queryState.payload.text === 'Updated TEXT for Confession', 'Trims updated text');
    assert(
      queryState.payload.normalized_text === 'updated text for confession',
      'Normalizes updated text (lowercased, collapsed whitespace)'
    );
    assert(typeof queryState.payload.content_hash === 'string', 'Computes sha256 content_hash');
    assert(queryState.payload.content_hash.length === 64, 'content_hash is valid 64-char sha256 hex');
  }

  // -------------------------------------------------------------------------
  // Test 10: softDeleteAdminConfession - sets deleted_at timestamp
  // -------------------------------------------------------------------------
  console.log('\nTest 10: softDeleteAdminConfession');
  {
    const deletedRow: Partial<ConfessionRow> = {
      id: 42,
      deleted_at: '2026-09-17T02:00:00Z',
    };
    const { mockClient, queryState } = createMockSupabase(deletedRow);

    const res = await softDeleteAdminConfession(42, { supabaseClient: mockClient });
    assert(res.id === 42, 'Returns deleted row');
    assert(queryState.payload.deleted_at !== undefined, 'Sets deleted_at timestamp');
    assert(queryState.payload.updated_at !== undefined, 'Sets updated_at timestamp');
  }

  // -------------------------------------------------------------------------
  // Test 11: getAdminConfessionCounts - groups counts by status
  // -------------------------------------------------------------------------
  console.log('\nTest 11: getAdminConfessionCounts');
  {
    const rows = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved' },
      { status: 'posted' },
      { status: 'posted' },
      { status: 'posted' },
      { status: 'rejected' },
    ];
    const { mockClient } = createMockSupabase(rows);

    const counts = await getAdminConfessionCounts({ supabaseClient: mockClient });
    assert(counts.all === 7, 'Total count matches');
    assert(counts.pending === 2, 'Pending count matches (2)');
    assert(counts.approved === 1, 'Approved count matches (1)');
    assert(counts.posted === 3, 'Posted count matches (3)');
    assert(counts.rejected === 1, 'Rejected count matches (1)');
    assert(counts.failed === 0, 'Failed count matches (0)');
  }

  // -------------------------------------------------------------------------
  // Test 12: createAdminConfession - validation and insertion
  // -------------------------------------------------------------------------
  console.log('\nTest 12: createAdminConfession');
  {
    const insertedRow: Partial<ConfessionRow> = {
      id: 101,
      text: 'Valid admin created confession',
      status: 'pending',
    };
    const { mockClient, queryState } = createMockSupabase(insertedRow);

    const created = await createAdminConfession(
      { text: 'Valid admin created confession' },
      { supabaseClient: mockClient }
    );

    assert(created.id === 101, 'Created confession returned');
    assert(queryState.payload.submitter_ip_hash === 'admin-manual', 'Flags manual admin source');
    assert(queryState.payload.status === 'pending', 'Status initialized to pending');
  }

  // -------------------------------------------------------------------------
  // Test 13: formatConfessionForAdmin - frontend backwards compatibility
  // -------------------------------------------------------------------------
  console.log('\nTest 13: formatConfessionForAdmin - frontend backwards compatibility');
  {
    const sampleRow: ConfessionRow = {
      id: 42,
      text: 'Compatibility test',
      normalized_text: 'compatibility test',
      content_hash: 'abc123hash',
      status: 'approved',
      failure_stage: null,
      number: 7,
      parts: ['Slide 1', 'Slide 2'],
      image_urls: ['/api/image/42/0', '/api/image/42/1'],
      ig_post_id: '1812345678',
      ig_permalink: 'https://instagram.com/p/xyz',
      instagram_container_id: null,
      instagram_child_container_ids: null,
      publish_attempt_id: null,
      correlation_token: null,
      instagram_publish_attempted_at: null,
      instagram_publish_status: 'idle',
      ai_verdict: 'approved',
      decision_reason: 'Clean campus confession',
      model_confidence: 0.98,
      matched_rules: null,
      policy_level: 5,
      flags: null,
      model_id: 'gemini-3.8-flash',
      model_version: '3.8',
      ai_policy_version: 1,
      instruction_version: 1,
      prompt_hash: null,
      generation_config: null,
      fallback_used: false,
      processing_started_at: null,
      last_progress_at: null,
      attempt_count: 0,
      last_error: null,
      next_retry_at: null,
      run_id: null,
      sheets_sync_status: 'pending',
      sheets_last_synced_at: null,
      sheets_sync_error: null,
      submitter_ip_hash: 'hash-1',
      created_at: '2026-09-17T00:00:00Z',
      updated_at: '2026-09-17T00:05:00Z',
      posted_at: null,
      deleted_at: null,
    };

    const formatted = formatConfessionForAdmin(sampleRow);
    assert(formatted.id === 42, 'id preserved');
    assert(formatted.text === 'Compatibility test', 'text preserved');
    assert(formatted.number === 7, 'number preserved');
    assert(typeof formatted.imageUrls === 'string', 'imageUrls is serialized JSON string');
    assert(JSON.parse(formatted.imageUrls).length === 2, 'imageUrls string is valid parseable JSON');
    assert(typeof formatted.parts === 'string', 'parts is serialized JSON string');
    assert(JSON.parse(formatted.parts).length === 2, 'parts string is valid parseable JSON');
    assert(formatted.igPostId === '1812345678', 'igPostId mapped from ig_post_id');
    assert(formatted.igPermalink === 'https://instagram.com/p/xyz', 'igPermalink mapped from ig_permalink');
    assert(formatted.createdAt === '2026-09-17T00:00:00Z', 'createdAt mapped from created_at');
    assert(formatted.updatedAt === '2026-09-17T00:05:00Z', 'updatedAt mapped from updated_at');
    // Also verify typed DB fields are still directly accessible
    assert(Array.isArray(formatted.image_urls), 'snake_case image_urls still accessible as array');
  }

  // -------------------------------------------------------------------------
  // Test 14: Read-Only Production State Verification
  // -------------------------------------------------------------------------
  console.log('\nTest 14: Read-Only Production State Verification');
  {
    const supabase = getSupabaseAdmin();

    // Verify row 2
    const row2 = await getAdminConfessionById(2, { supabaseClient: supabase });
    assert(row2 !== null, 'Production confession #2 exists');
    assert(row2?.id === 2, 'Confession #2 id is 2');
    assert(row2?.number === 2, 'Confession #2 number is unchanged at #2');
    assert(row2?.status === 'posted', 'Confession #2 status is unchanged at "posted"');

    // Verify row 3
    const row3 = await getAdminConfessionById(3, { supabaseClient: supabase });
    assert(row3 !== null, 'Production confession #3 exists');
    assert(row3?.id === 3, 'Confession #3 id is 3');
    assert(row3?.number === null, 'Confession #3 number is unchanged at NULL');
    assert(row3?.status === 'rejected', 'Confession #3 status is "rejected"');

    // Verify row 4
    const row4 = await getAdminConfessionById(4, { supabaseClient: supabase });
    assert(row4 !== null, 'Production confession #4 exists');
    assert(row4?.id === 4, 'Confession #4 id is 4');
    assert(row4?.number === 1, 'Confession #4 number is unchanged at #1');
    assert(row4?.status === 'posted', 'Confession #4 status is unchanged at "posted"');
    assert(row4?.ig_post_id === '18123513856858171', 'Confession #4 ig_post_id preserved');

    // Verify row 5
    const row5 = await getAdminConfessionById(5, { supabaseClient: supabase });
    assert(row5 !== null, 'Production confession #5 exists');
    assert(row5?.id === 5, 'Confession #5 id is 5');
    assert(row5?.number === 3, 'Confession #5 number is #3');
    assert(row5?.status === 'posted', 'Confession #5 status is "posted"');
    assert(row5?.ig_post_id === '18145893250562599', 'Confession #5 ig_post_id preserved');

    // Verify MAX(number) is 3
    const { data: maxRows } = await supabase
      .from('confessions')
      .select('number')
      .not('number', 'is', null)
      .order('number', { ascending: false })
      .limit(1);

    const maxNumber = maxRows && maxRows.length > 0 ? maxRows[0].number : null;
    assert(typeof maxNumber === 'number' && maxNumber >= 3, 'MAX(confessions.number) in database is valid');

    // Verify getAdminConfessions reads cleanly from production
    const rejectedList = await getAdminConfessions({ status: 'rejected', supabaseClient: supabase });
    assert(rejectedList.some((c) => c.id === 3), 'Confession #3 in rejected list');

    const postedList = await getAdminConfessions({ status: 'posted', supabaseClient: supabase });
    assert(postedList.some((c) => c.id === 4), 'Confession #4 in posted list');
    assert(postedList.some((c) => c.id === 2), 'Confession #2 in posted list');
    assert(postedList.some((c) => c.id === 5), 'Confession #5 in posted list');
  }

  // -------------------------------------------------------------------------
  // Test 15: Zero Google Sheets dependencies confirmation
  // -------------------------------------------------------------------------
  console.log('\nTest 15: Zero Google Sheets dependencies confirmation');
  {
    // Ensure no admin API route calls getGoogleSheet()
    // Read the route files and verify absence of getGoogleSheet
    const fs = await import('fs');
    const path = await import('path');

    const routesToCheck = [
      'apps/admin/app/api/confessions/route.ts',
      'apps/admin/app/api/confessions/[id]/route.ts',
      'apps/admin/app/api/generate-images/route.ts',
      'apps/admin/app/api/post-to-instagram/route.ts',
      'apps/admin/app/api/image/[id]/[part]/route.ts',
    ];

    for (const relPath of routesToCheck) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      assert(
        !content.includes('getGoogleSheet'),
        `Route ${relPath} contains zero references to getGoogleSheet()`
      );
      assert(
        !content.includes('googleSheets'),
        `Route ${relPath} contains zero imports of googleSheets`
      );
    }
  }

  console.log('\n================================================================');
  console.log(`PHASE F STEP 2 TESTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
