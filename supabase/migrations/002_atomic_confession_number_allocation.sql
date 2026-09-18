-- ============================================================================
-- BU Confessions v3.4 — Migration 002: Atomic Confession Number Allocation
-- ============================================================================
-- Invariants:
--   1. Strict Uniqueness: confessions.number is unique (enforced by confessions_number_key).
--   2. Monotonic Allocation: Successful sequence allocations draw strictly increasing values
--      from confession_number_seq. Sequence allocation order is monotonic, but transaction commit
--      order is not guaranteed to match sequence allocation order.
--   3. Non-Transactional Sequence Semantics: PostgreSQL sequences are intentionally
--      non-transactional to maximize concurrency. Calling nextval() advances the sequence
--      immediately without holding table-wide locks and does not roll back if an outer
--      transaction aborts. Gaps resulting from aborted transactions or downstream failure
--      stages are expected and acceptable. Numbering is monotonic across successful
--      allocations, not guaranteed to be contiguous or gapless.
--   4. Zero Phantom Numbers & Persisted vs. Consumed Sequence Values:
--      A sequence value consumed by an aborted transaction is discarded as a sequence gap;
--      it is never assigned to any confession and does not represent a valid confession number.
--      A confession number is only valid, recognized, and returned to callers if the atomic
--      transaction successfully commits and persists the value to public.confessions.number.
--      If the update or transaction fails, the transaction aborts, no confession number is
--      assigned or returned, and zero phantom numbers can be rendered or published.
--   5. Concurrency Safety: Target confession row is locked FOR UPDATE; sequence draw is atomic.
--      Concurrent callers cannot produce duplicate numbers or race on the same confession.
-- ============================================================================

-- 1. Synchronize sequence with current MAX(number)
SELECT setval(
  'public.confession_number_seq',
  COALESCE((SELECT MAX(number) FROM public.confessions), 1),
  (SELECT MAX(number) IS NOT NULL FROM public.confessions)
);

-- 2. Create the server-only atomic allocator function
CREATE OR REPLACE FUNCTION public.allocate_confession_number(p_confession_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing_number integer;
  v_new_number integer;
BEGIN
  -- Row-level lock to prevent concurrent allocation attempts on the same confession row
  SELECT number INTO v_existing_number
  FROM public.confessions
  WHERE id = p_confession_id
  FOR UPDATE;

  -- 1. Check existence
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFESSION_NOT_FOUND: Confession with id % does not exist', p_confession_id
      USING ERRCODE = 'P0002'; -- no_data_found
  END IF;

  -- 2. Check if already numbered (prevent re-allocation/overwriting)
  IF v_existing_number IS NOT NULL THEN
    RAISE EXCEPTION 'CONFESSION_ALREADY_NUMBERED: Confession with id % already has number %', p_confession_id, v_existing_number
      USING ERRCODE = 'P1001'; -- application-defined SQLSTATE
  END IF;

  -- 3. Draw next monotonic number from sequence
  v_new_number := nextval('public.confession_number_seq');

  -- 4. Persist immediately in the same transaction
  UPDATE public.confessions
  SET number = v_new_number,
      updated_at = pg_catalog.now()
  WHERE id = p_confession_id;

  RETURN v_new_number;
END;
$$;

-- 3. Restrict permissions: service_role ONLY
REVOKE ALL ON FUNCTION public.allocate_confession_number(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_confession_number(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_confession_number(bigint) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.allocate_confession_number(bigint) TO service_role;

COMMENT ON FUNCTION public.allocate_confession_number(bigint) IS
  'Atomically draws next sequence value from confession_number_seq and updates confessions.number in a single transaction. Service-role only.';
