-- ============================================================================
-- BU Confessions v3.4 — Full Database Schema
-- ============================================================================
-- This migration creates the entire foundation:
--   • confessions (core data with 8-status state machine)
--   • instagram_publish_attempts (pre-API persistence & recovery)
--   • agent_locks (durable concurrency lease)
--   • rate_limits (atomic distributed rate limiter)
--   • agent_runs (execution history)
--   • audit_log (admin action audit trail)
--   • settings (admin-configurable allowlist settings)
--   • error_log (structured error tracking)
--   • digest_history (email digest records)
--   • confession_number_seq (idempotent numbering sequence)
--   • check_and_increment_rate_limit() Postgres function
--   • All constraints, indexes, and triggers
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. SEQUENCES
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS confession_number_seq START WITH 1 INCREMENT BY 1;

-- ============================================================================
-- 2. CORE TABLES
-- ============================================================================

-- ---------------------------------------------------------------------------
-- confessions — Core Data Table (8-status state machine)
-- ---------------------------------------------------------------------------
CREATE TABLE confessions (
  id serial PRIMARY KEY,
  text text NOT NULL,
  normalized_text text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  failure_stage text,
  number integer UNIQUE,
  parts jsonb,
  image_urls jsonb,

  -- Instagram & Publication Recovery
  ig_post_id text UNIQUE,
  ig_permalink text,
  instagram_container_id text,
  instagram_child_container_ids jsonb,
  publish_attempt_id uuid UNIQUE,
  correlation_token text UNIQUE,
  instagram_publish_attempted_at timestamptz,
  instagram_publish_status text DEFAULT 'idle',

  -- AI Moderation Metadata
  ai_verdict text,
  decision_reason text,
  model_confidence float,
  matched_rules jsonb,
  policy_level integer,
  flags jsonb,
  model_id text,
  model_version text,
  ai_policy_version integer,
  instruction_version integer,
  prompt_hash text,
  generation_config jsonb,
  fallback_used boolean DEFAULT false,

  -- Processing & Milestone Tracking
  processing_started_at timestamptz,
  last_progress_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  next_retry_at timestamptz,
  run_id integer,

  -- Decoupled Sheets Sync
  sheets_sync_status text NOT NULL DEFAULT 'pending',
  sheets_last_synced_at timestamptz,
  sheets_sync_error text,

  -- Audit & Tracking
  submitter_ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  posted_at timestamptz,
  deleted_at timestamptz
);

-- ---------------------------------------------------------------------------
-- instagram_publish_attempts — Pre-API Persistence & Recovery
-- ---------------------------------------------------------------------------
CREATE TABLE instagram_publish_attempts (
  publish_attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  confession_id integer NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  correlation_token text NOT NULL UNIQUE,
  container_id text,
  child_container_ids jsonb,
  publish_attempted_at timestamptz NOT NULL DEFAULT NOW(),
  response_status text,
  recovered boolean NOT NULL DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- agent_locks — Durable Concurrency Lease
-- ---------------------------------------------------------------------------
CREATE TABLE agent_locks (
  lock_name text PRIMARY KEY,
  locked_by text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT NOW(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- rate_limits — Atomic Distributed Serverless Rate Limiter
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 1,
  reset_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- agent_runs — Execution History
-- ---------------------------------------------------------------------------
CREATE TABLE agent_runs (
  id serial PRIMARY KEY,
  run_uuid text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT NOW(),
  finished_at timestamptz,
  confessions_processed integer DEFAULT 0,
  confessions_posted integer DEFAULT 0,
  confessions_rejected integer DEFAULT 0,
  confessions_failed integer DEFAULT 0,
  confessions_pending_review integer DEFAULT 0,
  dry_run boolean NOT NULL DEFAULT false,
  error_summary text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- audit_log — Admin Action Audit Trail
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id serial PRIMARY KEY,
  confession_id integer REFERENCES confessions(id) ON DELETE SET NULL,
  action text NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  details jsonb,
  previous_status text,
  new_status text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- settings — Admin-Configurable Settings (Strict Allowlist)
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text NOT NULL DEFAULT 'system'
);

-- Seed default settings
INSERT INTO settings (key, value, description) VALUES
  ('posting_enabled', 'true', 'Master switch for automated posting'),
  ('max_per_batch', '50', 'Maximum confessions to process per agent run (range: 1-100)'),
  ('image_retention_days', '7', 'Days to keep confession images in storage'),
  ('storage_warning_threshold', '70', 'Storage usage percentage to trigger warning (must be < critical)'),
  ('storage_critical_threshold', '90', 'Storage usage percentage to trigger emergency cleanup'),
  ('emergency_keep_percentage', '50', 'Minimum percentage of images to retain during emergency cleanup'),
  ('max_retry_attempts', '3', 'Maximum retry attempts for failed confessions'),
  ('stale_claim_timeout_minutes', '10', 'Minutes before a claimed-but-no-progress confession is reclaimed'),
  ('stale_progress_timeout_minutes', '10', 'Minutes since last progress before a confession is considered stale'),
  ('posting_delay_seconds', '5', 'Delay between posting individual confessions to Instagram'),
  ('duplicate_window_hours', '24', 'Hours within which duplicate content_hash submissions are rejected')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- error_log — Structured Error Tracking
-- ---------------------------------------------------------------------------
CREATE TABLE error_log (
  id serial PRIMARY KEY,
  confession_id integer REFERENCES confessions(id) ON DELETE SET NULL,
  run_id integer REFERENCES agent_runs(id) ON DELETE SET NULL,
  error_type text NOT NULL,
  error_message text NOT NULL,
  stack_trace text,
  context jsonb,
  status text NOT NULL DEFAULT 'new',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- digest_history — Email Digest Records
-- ---------------------------------------------------------------------------
CREATE TABLE digest_history (
  id serial PRIMARY KEY,
  run_id integer REFERENCES agent_runs(id) ON DELETE SET NULL,
  email_to text NOT NULL,
  subject text NOT NULL,
  summary jsonb NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT NOW(),
  resend_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- 3. CONSTRAINTS
-- ============================================================================

ALTER TABLE confessions
  ADD CONSTRAINT check_confessions_status
    CHECK (status IN ('pending', 'processing', 'approved', 'posting', 'posted', 'rejected', 'pending_review', 'failed')),
  ADD CONSTRAINT check_confessions_failure_stage
    CHECK (failure_stage IS NULL OR failure_stage IN ('moderation', 'image_generation', 'storage', 'instagram_token', 'instagram_container', 'instagram_publish', 'instagram_verification', 'sheets_sync')),
  ADD CONSTRAINT check_confessions_confidence
    CHECK (model_confidence IS NULL OR (model_confidence >= 0.0 AND model_confidence <= 1.0)),
  ADD CONSTRAINT check_confessions_attempt_count
    CHECK (attempt_count >= 0);

ALTER TABLE agent_runs
  ADD CONSTRAINT check_agent_runs_status
    CHECK (status IN ('running', 'completed', 'failed', 'dry_run', 'skipped'));

ALTER TABLE error_log
  ADD CONSTRAINT check_error_log_status
    CHECK (status IN ('new', 'acknowledged', 'resolved'));


-- ============================================================================
-- 4. INDEXES
-- ============================================================================

-- confessions: Optimized for agent queries (status-based, FIFO, recovery)
CREATE INDEX idx_confessions_status_created ON confessions(status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_confessions_content_hash_created ON confessions(content_hash, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_confessions_next_retry ON confessions(next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX idx_confessions_processing_started ON confessions(processing_started_at) WHERE processing_started_at IS NOT NULL;
CREATE INDEX idx_confessions_last_progress ON confessions(last_progress_at) WHERE last_progress_at IS NOT NULL;
CREATE INDEX idx_confessions_sheets_sync ON confessions(sheets_sync_status) WHERE sheets_sync_status != 'synced';

-- audit_log & error_log
CREATE INDEX idx_audit_log_confession_created ON audit_log(confession_id, created_at);
CREATE INDEX idx_error_log_status_created ON error_log(status, created_at);

-- instagram_publish_attempts
CREATE INDEX idx_publish_attempts_confession ON instagram_publish_attempts(confession_id, attempt_number);

-- rate_limits: For cleanup of expired entries
CREATE INDEX idx_rate_limits_reset_at ON rate_limits(reset_at);

-- agent_runs: For log retention cleanup
CREATE INDEX idx_agent_runs_created ON agent_runs(created_at);

-- digest_history: For retention cleanup
CREATE INDEX idx_digest_history_created ON digest_history(created_at);


-- ============================================================================
-- 5. TRIGGERS
-- ============================================================================

-- Auto-update `updated_at` on confessions
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_confessions_updated_at
  BEFORE UPDATE ON confessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================================================
-- 6. POSTGRES FUNCTIONS
-- ============================================================================

-- Atomic rate limiting
CREATE OR REPLACE FUNCTION check_and_increment_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := NOW();
  v_row rate_limits%ROWTYPE;
BEGIN
  -- Basic sanity limits
  IF p_limit <= 0 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid rate limit';
  END IF;

  IF p_window_seconds <= 0 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid rate-limit window';
  END IF;

  INSERT INTO rate_limits (key, count, reset_at)
  VALUES (
    p_key,
    1,
    v_now + (p_window_seconds || ' seconds')::interval
  )
  ON CONFLICT (key) DO UPDATE
  SET
    count = CASE
      WHEN rate_limits.reset_at < v_now THEN 1
      ELSE rate_limits.count + 1
    END,
    reset_at = CASE
      WHEN rate_limits.reset_at < v_now
        THEN v_now + (p_window_seconds || ' seconds')::interval
      ELSE rate_limits.reset_at
    END
  RETURNING * INTO v_row;

  IF v_row.count <= p_limit THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'remaining', p_limit - v_row.count,
      'reset_at', v_row.reset_at
    );
  ELSE
    RETURN jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'reset_at', v_row.reset_at
    );
  END IF;
END;
$$;

-- Only the public API role and backend service role can execute the function.
REVOKE EXECUTE ON FUNCTION check_and_increment_rate_limit(text, integer, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION check_and_increment_rate_limit(text, integer, integer)
TO anon;

GRANT EXECUTE ON FUNCTION check_and_increment_rate_limit(text, integer, integer)
TO service_role;


-- ============================================================================
-- 7. ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE confessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_publish_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE digest_history ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS.
-- Public (anon) users can only insert confessions and read rate limits.
-- All other operations require the service_role key.

-- confessions: anon can INSERT (submit), service_role can do everything
CREATE POLICY "anon_insert_confessions" ON confessions
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "service_role_all_confessions" ON confessions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- rate_limits: anon can call the RPC function (which runs as definer),
-- but direct table access is service_role only
CREATE POLICY "service_role_all_rate_limits" ON rate_limits
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- All other tables: service_role only
CREATE POLICY "service_role_all_publish_attempts" ON instagram_publish_attempts
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_agent_locks" ON agent_locks
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_agent_runs" ON agent_runs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_audit_log" ON audit_log
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_settings" ON settings
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_error_log" ON error_log
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_digest_history" ON digest_history
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
