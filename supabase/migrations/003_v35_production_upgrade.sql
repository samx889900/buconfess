-- ============================================================================
-- BU Confessions v3.5 — Migration 003: Production Reliability & Operations Upgrade
-- ============================================================================
-- Includes:
--   1. daily_posting_runs table: Prevents duplicate execution of daily posting slots
--      via strict UNIQUE (posting_date, schedule_slot) constraint.
--   2. sheets_sync_log table: Decoupled, independent Google Sheets sync retry tracking.
--   3. New operational settings seeds (model cascade, schedule, canvas typography).
-- ============================================================================

-- 1. Create daily_posting_runs table
CREATE TABLE IF NOT EXISTS public.daily_posting_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_date date NOT NULL,
  schedule_slot text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  completed_at timestamptz,
  published_count integer NOT NULL DEFAULT 0,
  error_message text,
  trigger_source text NOT NULL DEFAULT 'scheduled' CHECK (trigger_source IN ('scheduled', 'manual_dispatch', 'cli')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT daily_posting_runs_date_slot_key UNIQUE (posting_date, schedule_slot)
);

ALTER TABLE public.daily_posting_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_posting_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.daily_posting_runs TO service_role;

COMMENT ON TABLE public.daily_posting_runs IS
  'Durable record of daily posting run executions. Strict UNIQUE (posting_date, schedule_slot) prevents duplicate runs.';

-- 2. Create sheets_sync_log table
CREATE TABLE IF NOT EXISTS public.sheets_sync_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  confession_id bigint NOT NULL REFERENCES public.confessions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'synced', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT sheets_sync_log_confession_key UNIQUE (confession_id)
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_log_status ON public.sheets_sync_log(status);

ALTER TABLE public.sheets_sync_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sheets_sync_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sheets_sync_log TO service_role;

COMMENT ON TABLE public.sheets_sync_log IS
  'Secondary, non-blocking Google Sheets sync queue with independent retry tracking.';

-- 3. Seed new v3.5 operational settings into settings table
INSERT INTO public.settings (key, value, description)
VALUES
  (
    'moderation_model_cascade',
    '"gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3.5-flash,gemini-3.8-flash"'::jsonb,
    'Comma-separated Gemini model cascade order (must only contain allowlisted models)'
  ),
  (
    'daily_posting_time',
    '"22:00"'::jsonb,
    'Target daily posting time (HH:MM in posting_timezone, e.g. 22:00)'
  ),
  (
    'posting_timezone',
    '"Asia/Kolkata"'::jsonb,
    'IANA Timezone for posting schedule (e.g. Asia/Kolkata)'
  ),
  (
    'image_font_size',
    '34'::jsonb,
    'Body font size in px for rendered confession cards (default: 34)'
  ),
  (
    'image_line_height',
    '50'::jsonb,
    'Line height in px for rendered confession cards (default: 50)'
  ),
  (
    'sheets_sync_enabled',
    'true'::jsonb,
    'Enable secondary Google Sheets sync after successful Instagram publish'
  ),
  (
    'sheets_sync_max_retries',
    '3'::jsonb,
    'Maximum retries for failed secondary Google Sheets sync operations'
  )
ON CONFLICT (key) DO NOTHING;
