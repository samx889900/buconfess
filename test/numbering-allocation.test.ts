import {
  ensureConfessionNumber,
  ConfessionAlreadyNumberedError,
} from '../apps/admin/lib/canvas/pipeline';

// ---------------------------------------------------------------------------
// test/numbering-allocation.test.ts
// Unit & Concurrency Test Suite for Atomic Confession Number Allocation
// ---------------------------------------------------------------------------
// Invariants verified:
//   1. First allocation after MAX(number)=1 draws #2
//   2. Monotonic allocation: second allocation draws #3
//   3. Concurrent allocations receive different numbers (zero duplicates)
//   4. Same-confession concurrent calls resolve safely without double allocation
//   5. Already-numbered confession cannot be reallocated (application-defined SQLSTATE P1001)
//   6. Nonexistent confession fails with P0002
//   7. Failed DB operation never returns a phantom number (consumed sequence values
//      from aborted transactions are discarded as gaps; confession numbers are only
//      valid and returned if successfully persisted in DB)
//   8. Sequence gap after transaction failure is handled safely
//   9. Unverified in-memory existingNumber is verified against DB authority
// ---------------------------------------------------------------------------

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

/**
 * Creates an in-memory PostgreSQL engine simulator modeling exact sequence,
 * row-level lock FOR UPDATE, and transaction abort semantics of allocate_confession_number.
 */
function createMockPostgresEngine(initialMaxNumber: number = 1) {
  let sequenceLastValue = initialMaxNumber;
  let sequenceIsCalled = initialMaxNumber > 0;

  // Table store: id -> { id, number }
  const store = new Map<number, { id: number; number: number | null }>();

  // Mutex for simulating PostgreSQL sequence / row lock
  let lockPromise = Promise.resolve();
  function acquireLock(): Promise<() => void> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = lockPromise.then(() => release);
    lockPromise = lockPromise.then(() => nextLock);
    return wait;
  }

  return {
    store,
    getSequenceState: () => ({ lastValue: sequenceLastValue, isCalled: sequenceIsCalled }),
    
    // Simulates the exact PL/pgSQL allocate_confession_number() function
    allocateConfessionNumberRpc: async (confessionId: number, options: { simulateAbortAfterDraw?: boolean } = {}) => {
      const release = await acquireLock();
      try {
        // 1. Check existence with row lock
        const row = store.get(confessionId);
        if (!row) {
          const err: any = new Error(`CONFESSION_NOT_FOUND: Confession with id ${confessionId} does not exist`);
          err.code = 'P0002';
          return { data: null, error: err };
        }

        // 2. Check if already numbered
        if (row.number !== null) {
          const err: any = new Error(`CONFESSION_ALREADY_NUMBERED: Confession with id ${confessionId} already has number ${row.number}`);
          err.code = 'P1001';
          return { data: null, error: err };
        }

        // 3. Atomically draw next value from sequence (non-transactional advance)
        if (sequenceIsCalled) {
          sequenceLastValue += 1;
        } else {
          sequenceIsCalled = true;
        }
        const drawnNumber = sequenceLastValue;

        // Simulate transaction abort AFTER sequence draw (e.g. network failure, constraint check)
        if (options.simulateAbortAfterDraw) {
          // Transaction aborts! Sequence remains advanced, row is NOT updated!
          const err: any = new Error('TRANSACTION_ABORTED: Simulated failure after sequence draw');
          err.code = '40001';
          return { data: null, error: err };
        }

        // 4. Update row
        row.number = drawnNumber;

        return { data: drawnNumber, error: null };
      } finally {
        release();
      }
    },

    // Mock Supabase client adapter
    createClientAdapter: () => {
      return {
        rpc: async (fnName: string, params: any) => {
          if (fnName === 'allocate_confession_number') {
            return mockEngine.allocateConfessionNumberRpc(params.p_confession_id);
          }
          return { data: null, error: { code: 'PGRST202', message: 'Function not found' } };
        },
        from: (table: string) => ({
          select: (cols: string) => ({
            eq: (col: string, val: any) => ({
              single: async () => {
                const row = store.get(val);
                return { data: row ? { ...row } : null, error: row ? null : { message: 'Not found' } };
              },
            }),
          }),
        }),
      };
    },
  };
}

let mockEngine = createMockPostgresEngine(1);

async function runTests() {
  console.log('\n================================================================');
  console.log('NUMBERING ALLOCATION — ATOMICITY & CONCURRENCY TEST SUITE');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: First allocation after MAX(number)=1 results in #2
  // -------------------------------------------------------------------------
  console.log('Test 1: First allocation after current MAX(number)=1 draws #2');
  {
    mockEngine = createMockPostgresEngine(1);
    const client = mockEngine.createClientAdapter();

    // Confession 2 has number: null
    mockEngine.store.set(2, { id: 2, number: null });

    const allocated = await ensureConfessionNumber(client as any, 2);
    assert(allocated === 2, 'Allocated number is exactly #2 (MAX=1 + 1)');
    assert(mockEngine.store.get(2)?.number === 2, 'Confession #2 has number=2 in DB store');
  }

  // -------------------------------------------------------------------------
  // TEST 2: Second allocation draws #3 (monotonic increase)
  // -------------------------------------------------------------------------
  console.log('\nTest 2: Second allocation draws #3 (monotonic increase)');
  {
    const client = mockEngine.createClientAdapter();

    // Confession 3 has number: null
    mockEngine.store.set(3, { id: 3, number: null });

    const allocated = await ensureConfessionNumber(client as any, 3);
    assert(allocated === 3, 'Allocated number is strictly monotonically increasing (#3)');
    assert(mockEngine.store.get(3)?.number === 3, 'Confession #3 has number=3 in DB store');
  }

  // -------------------------------------------------------------------------
  // TEST 3: Concurrent allocation for two different confessions
  // -------------------------------------------------------------------------
  console.log('\nTest 3: Concurrent allocations for two confessions receive unique numbers');
  {
    mockEngine = createMockPostgresEngine(10);
    const client = mockEngine.createClientAdapter();

    mockEngine.store.set(101, { id: 101, number: null });
    mockEngine.store.set(102, { id: 102, number: null });

    // Launch both allocations concurrently via Promise.all
    const [num101, num102] = await Promise.all([
      ensureConfessionNumber(client as any, 101),
      ensureConfessionNumber(client as any, 102),
    ]);

    assert(num101 !== num102, `Allocated numbers are unique (${num101} vs ${num102})`);
    assert(num101 === 11 || num101 === 12, 'First received valid sequence number');
    assert(num102 === 11 || num102 === 12, 'Second received valid sequence number');
    assert(new Set([num101, num102]).size === 2, 'Zero duplicate numbers produced under concurrency');

    // Multi-worker scale test: 10 concurrent allocations across 10 distinct confessions
    const multiIds = Array.from({ length: 10 }, (_, i) => 1000 + i);
    multiIds.forEach((id) => mockEngine.store.set(id, { id, number: null }));

    const multiAllocated = await Promise.all(
      multiIds.map((id) => ensureConfessionNumber(client as any, id))
    );

    const uniqueSet = new Set(multiAllocated);
    assert(uniqueSet.size === 10, 'All 10 concurrent allocations received completely unique numbers');
    assert(Math.min(...multiAllocated) === 13, 'First in batch started at #13');
    assert(Math.max(...multiAllocated) === 22, 'Last in batch ended at #22');
  }

  // -------------------------------------------------------------------------
  // TEST 4: Same-confession concurrent calls resolve safely without double allocation
  // -------------------------------------------------------------------------
  console.log('\nTest 4: Same-confession concurrent calls resolve safely without double allocation');
  {
    mockEngine = createMockPostgresEngine(20);
    const client = mockEngine.createClientAdapter();

    mockEngine.store.set(201, { id: 201, number: null });

    // Two workers attempt to allocate for the SAME confession 201 concurrently
    const [resA, resB] = await Promise.all([
      ensureConfessionNumber(client as any, 201),
      ensureConfessionNumber(client as any, 201),
    ]);

    assert(resA === resB, `Both concurrent callers received the exact same number (${resA})`);
    assert(resA === 21, 'Number allocated was #21');
    assert(mockEngine.getSequenceState().lastValue === 21, 'Sequence was drawn exactly once (no second draw)');

    // Multi-worker race: 5 workers simultaneously racing for unnumbered confession 202
    mockEngine.store.set(202, { id: 202, number: null });
    const raceResults = await Promise.all([
      ensureConfessionNumber(client as any, 202),
      ensureConfessionNumber(client as any, 202),
      ensureConfessionNumber(client as any, 202),
      ensureConfessionNumber(client as any, 202),
      ensureConfessionNumber(client as any, 202),
    ]);

    assert(raceResults.every((val) => val === 22), 'All 5 racing workers received exact same number #22');
    assert(mockEngine.getSequenceState().lastValue === 22, 'Sequence advanced exactly once for all 5 racing workers');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Already-numbered confession cannot be reallocated
  // -------------------------------------------------------------------------
  console.log('\nTest 5: Already-numbered confession cannot be reallocated (idempotency)');
  {
    mockEngine = createMockPostgresEngine(30);
    const client = mockEngine.createClientAdapter();

    // Confession 301 is already numbered with #30
    mockEngine.store.set(301, { id: 301, number: 30 });

    const numberBefore = mockEngine.getSequenceState().lastValue;
    const resultWithoutHint = await ensureConfessionNumber(client as any, 301);

    assert(resultWithoutHint === 30, 'Returns existing number 30 without reallocating');
    assert(mockEngine.getSequenceState().lastValue === numberBefore, 'Sequence was not advanced');

    // Calling with matching verified existingNumber
    const resultWithMatchingHint = await ensureConfessionNumber(client as any, 301, 30);
    assert(resultWithMatchingHint === 30, 'Verified existingNumber fast path returned #30');
    assert(mockEngine.getSequenceState().lastValue === numberBefore, 'Sequence was not advanced via verified fast path');

    // Verify ConfessionAlreadyNumberedError exposes application-defined SQLSTATE P1001
    const testErr = new ConfessionAlreadyNumberedError(301, 30);
    assert(testErr.code === 'P1001', 'ConfessionAlreadyNumberedError exposes application-defined SQLSTATE P1001');

    // Verify error code P1001 handling if DB row query fails or returns no number
    const p1001FailingClient = {
      rpc: async () => ({
        data: null,
        error: { code: 'P1001', message: 'CONFESSION_ALREADY_NUMBERED: Confession with id 302 already has number 30' },
      }),
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: { message: 'Row unavailable' } }),
          }),
        }),
      }),
    };

    let p1001Thrown: any = null;
    try {
      await ensureConfessionNumber(p1001FailingClient as any, 302);
    } catch (err: any) {
      p1001Thrown = err;
    }
    assert(p1001Thrown instanceof ConfessionAlreadyNumberedError, 'P1001 error throws ConfessionAlreadyNumberedError when row lookup fails');
    assert(p1001Thrown?.code === 'P1001', 'Thrown ConfessionAlreadyNumberedError code is exactly P1001');
  }

  // -------------------------------------------------------------------------
  // TEST 6: Nonexistent confession throws error
  // -------------------------------------------------------------------------
  console.log('\nTest 6: Nonexistent confession throws error (P0002)');
  {
    const client = mockEngine.createClientAdapter();

    let thrown = false;
    try {
      await ensureConfessionNumber(client as any, 999999);
    } catch (err: any) {
      thrown = true;
      assert(err.message.includes('CONFESSION_NOT_FOUND'), 'Propagates CONFESSION_NOT_FOUND error');
    }
    assert(thrown, 'Throws error when confession does not exist');
  }

  // -------------------------------------------------------------------------
  // TEST 7: Failed DB operation never returns a phantom number
  // -------------------------------------------------------------------------
  console.log('\nTest 7: Failed DB operation never returns a phantom number');
  {
    const failingClient = {
      rpc: async () => ({ data: null, error: { message: 'Database connection reset' } }),
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    };

    let thrown = false;
    try {
      await ensureConfessionNumber(failingClient as any, 401);
    } catch (err: any) {
      thrown = true;
      assert(err.message.includes('Database connection reset'), 'Propagates DB error');
    }
    assert(thrown, 'Throws exception instead of falling back to phantom number or confession.id');
  }

  // -------------------------------------------------------------------------
  // TEST 8: Sequence gap after transaction failure is handled safely
  // -------------------------------------------------------------------------
  console.log('\nTest 8: Sequence gap after transaction failure is handled safely');
  {
    mockEngine = createMockPostgresEngine(50);
    const client = mockEngine.createClientAdapter();

    mockEngine.store.set(501, { id: 501, number: null });
    mockEngine.store.set(502, { id: 502, number: null });

    // First attempt draws sequence 51, but transaction aborts!
    const abortRes = await mockEngine.allocateConfessionNumberRpc(501, { simulateAbortAfterDraw: true });
    assert(abortRes.error !== null, 'First transaction failed/aborted');
    assert(mockEngine.store.get(501)?.number === null, 'Confession 501 number was NOT updated');
    assert(mockEngine.getSequenceState().lastValue === 51, 'Sequence advanced to 51 despite abort (PostgreSQL sequence semantics)');

    // Second transaction succeeds with next monotonic number 52
    const successAlloc = await ensureConfessionNumber(client as any, 502);
    assert(successAlloc === 52, 'Next successful allocation receives #52 (gap of 51 is handled safely)');
    assert(mockEngine.store.get(502)?.number === 52, 'Confession 502 recorded #52 cleanly');

    // Multi-gap scenario: 3 consecutive transaction aborts create 3 gaps
    mockEngine.store.set(503, { id: 503, number: null });
    await mockEngine.allocateConfessionNumberRpc(503, { simulateAbortAfterDraw: true }); // draws 53, aborts
    await mockEngine.allocateConfessionNumberRpc(503, { simulateAbortAfterDraw: true }); // draws 54, aborts
    await mockEngine.allocateConfessionNumberRpc(503, { simulateAbortAfterDraw: true }); // draws 55, aborts
    assert(mockEngine.getSequenceState().lastValue === 55, 'Sequence reached 55 after 3 aborted transactions');

    // Next successful allocation receives #56
    const successAllocAfterMultiGap = await ensureConfessionNumber(client as any, 503);
    assert(successAllocAfterMultiGap === 56, 'Allocation after 3 gaps receives strictly monotonic #56');
    assert(mockEngine.store.get(503)?.number === 56, 'Confession 503 successfully recorded #56');
  }

  // -------------------------------------------------------------------------
  // TEST 9: Unverified in-memory existingNumber is validated against DB
  // -------------------------------------------------------------------------
  console.log('\nTest 9: Unverified in-memory existingNumber is validated against DB');
  {
    mockEngine = createMockPostgresEngine(60);
    const client = mockEngine.createClientAdapter();

    // Confession in DB has number: null
    mockEngine.store.set(601, { id: 601, number: null });

    // Case A: Caller passes in-memory existingNumber = 999 when DB is null
    const allocated = await ensureConfessionNumber(client as any, 601, 999);
    assert(allocated !== 999, 'Did NOT trust unverified existingNumber=999 blindly');
    assert(allocated === 61, 'Allocated authentic sequence number #61 from DB');
    assert(mockEngine.store.get(601)?.number === 61, 'Persisted authentic number in DB');

    // Case B: Caller passes in-memory existingNumber = 888 when DB already has 61
    const allocatedMismatched = await ensureConfessionNumber(client as any, 601, 888);
    assert(allocatedMismatched === 61, 'Mismatched unverified number #888 ignored; returned authentic #61 from DB');

    // Case C: Invalid existingNumber (negative, zero) ignored safely
    mockEngine.store.set(602, { id: 602, number: null });
    const allocatedNeg = await ensureConfessionNumber(client as any, 602, -5);
    assert(allocatedNeg === 62, 'Negative existingNumber ignored; allocated sequence #62');
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`NUMBERING ALLOCATION TESTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
