# BU Confessions — Full Automation & Admin Redesign (v3.4)

Automate the entire confession pipeline with AI moderation, durable 8-status state management with milestone-based progress tracking, Instagram publication recovery with pre-API attempt persistence, decoupled Google Sheets synchronization, and a redesigned admin dashboard.

Runs daily at 7:00 PM IST with zero-cost free-tier target architecture, robust heartbeat concurrency locking, strict secrets isolation, and true side-effect-free dry runs.

---

## Core Architecture Principle

```
                    ┌───────────────────────────┐
                    │    Supabase (PostgreSQL)  │
                    │      SOURCE OF TRUTH      │
                    └─────────────┬─────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ↓                       ↓                       ↓
     Confession Agent         Admin Dashboard        Public API
   (GitHub Actions Cron)    (Vercel Admin Next.js)  (Vercel Public)
          │                       │                       │
     Moderation                   │                 Accepts text only
    (Gemini 3.8)                  │                 (Server generates
          │                       │                  all metadata)
     ┌────┴────┐                  │
     ↓         ↓                  │
   Reject   Approved              │
               │                  │
               ↓                  │
            Posting               │
     ┌─────────┴─────────┐        │
     │ 1. Assign Number  │        │
     │ 2. Generate Image │        │
     │ 3. Storage Upload │        │
     │ 4. Persist Attempt│        │
     │    (Pre-API Lock) │        │
     │ 5. IG Containers  │        │
     │ 6. Dispatch Post  │        │
     │ 7. Verify & Finish│        │
     └─────────┬─────────┘        │
               │                  │
               ↓                  │
            Posted ───────────────┼───► Durable Sheets Sync Worker
                                  │     (Never blocks confession status)
                                  ↓
                             Email Digest
                            (Non-blocking)
```

> [!IMPORTANT]
> **Supabase is the sole source of truth.** All business logic reads from and writes to Supabase. Google Sheets is a decoupled, synchronized external copy for backup/audit. Sheets sync failures never mark confessions as failed or block Instagram posting. Public users interact only with the public Next.js API, which writes directly to Supabase with zero Google Sheets dependencies.

---

## Free-Tier Target Architecture ($0 Cost Goal)

All components MUST remain usable without paid infrastructure. Exact quotas and rate limits are subject to current provider policies and must be verified against current documentation before deployment. The application embeds quota-aware failure handling, backoff, and fallbacks throughout:

| Component | Target Platform | Free-Tier Scope & Sizing | Daily Workload Profile |
|-----------|-----------------|--------------------------|------------------------|
| **Public App & Admin UI** | Vercel (Hobby) | Bandwidth & serverless execution | ~50 submissions, admin monitoring |
| **Database & Storage** | Supabase (Free Tier) | PostgreSQL DB, Storage, connection pool | Curated approved posts; images auto-cleaned |
| **Scheduled Agent** | GitHub Actions | Monthly Linux runner minutes | ~15 min/day = ~450 min/month |
| **AI Moderation** | Google Gemini API | Free Tier (model/project RPM & RPD limits) | ~50 req/day + regex pre-filter |
| **Email Digests** | Resend | Free Tier (daily/monthly email caps) | 1 digest email/day |
| **Social Publishing** | Instagram Graph API | Meta for Developers API | Curated approved posts (~10–25/day); clean feed |
| **External Backup** | Google Sheets API | Google Cloud Free Service Account | Decoupled background sync |

> [!NOTE]
> **Daily Posting Volume & Feed Quality**: While ~50 submissions/day is an expected incoming benchmark, the pipeline is intentionally designed to curate feed quality rather than spamming Instagram. Between regex pre-filters (PII/spam), Gemini AI moderation, and human reviews for borderline items, the actual volume of posted confessions is typically ~10–25 posts/day, keeping the university confession page clean, aesthetic, and engaging.

---

## AI Moderation Architecture (Gemini 3.8 Flash Hierarchy)

```
                       CONFESSION SUBMISSION
                                │
                                ▼
                       Regex Pre-Filter
                       /              \
               PII / Spam found       Clean
                      │                 │
                      ▼                 ▼
                   REJECT        Gemini 3.8 Flash
               (Zero AI quota)   (Primary Model)
                                        │
                             ┌──────────┴──────────┐
                             │                     │
                          Success            Retryable Error
                             │            (429, 5xx, timeout,
                             ▼            with jitter & Retry-After)
                          Verdict                  │
                                                   ▼
                                            Gemini 3.7 Flash
                                            (First Fallback)
                                                   │
                                        ┌──────────┴──────────┐
                                        │                     │
                                     Success            Retryable Error
                                        │                     │
                                        ▼                     ▼
                                     Verdict           Gemini 3.6 Flash
                                                       (Last Resort)
                                                              │
                                                   ┌──────────┴──────────┐
                                                   │                     │
                                                Success                Error
                                                   │                     │
                                                   ▼                     ▼
                                                Verdict           PENDING_REVIEW
                                                                 (Needs Human Admin)
```

---

## Summary of All Architectural Decisions (v3.4)

| Area | Final v3.4 Specification |
|------|--------------------------|
| **Implementation Order** | Structured foundations-first: Phase A (Foundation) → Phase B (Public Submission) → Phase C (AI Moderation) → Phase D (Images & Instagram) → Phase E (Agent) → Phase F (Admin Dashboard) → Phase G (Production Testing) |
| **Primary AI Model** | `gemini-3.8-flash` via official modern `@google/genai` SDK |
| **AI Fallbacks** | `gemini-3.7-flash` → `gemini-3.6-flash` → `pending_review` |
| **Free Tier Handling** | Quota is model/project dependent; application handles RPM/RPD/429 with backoff + jitter + fallback |
| **AI Confidence** | Formally documented as `model_confidence` (model self-reported signal, not mathematical probability) |
| **AI Auditability** | No internal chain-of-thought stored; records `decision_reason`, `matched_rules`, `policy_level`, `flags`, `model_id`, `model_version`, `instruction_version`, `prompt_hash`, `generation_config`, `fallback_used` |
| **Output Validation** | Strict Zod schema parsing; retries once on malformed JSON; routes to `pending_review` if invalid |
| **State Machine** | 8 distinct statuses: `pending`, `processing`, `approved`, `posting`, `posted`, `rejected`, `pending_review`, `failed` |
| **Posting Scope** | `approved` = moderation passed, ready for execution; `posting` represents all post-approval execution (image generation, storage upload, container creation, publication, verification) |
| **Milestone Tracking** | `last_progress_at timestamptz` updated after every major execution step; decouples claim timeout (`stale_claim_timeout_minutes`) from progress timeout (`stale_progress_timeout_minutes`) |
| **Failure Staging** | `failure_stage` tracks exact failure point (`moderation`, `image_generation`, `storage`, `instagram_token`, `instagram_container`, `instagram_publish`, `instagram_verification`, `sheets_sync`) to govern recovery routes |
| **Pre-API Persistence** | Every Instagram publication attempt and correlation token is written to Supabase **BEFORE** making any external calls to Instagram |
| **Number Idempotency** | Confession number assigned via Postgres sequence `nextval('confession_number_seq')` upon entering live execution; **never reassigned** on retry |
| **Dry Run Mode** | True side-effect-free: preview numbers (`#DRY-RUN`), in-memory images, zero DB mutations, zero prod storage uploads, zero prod audit logs, zero prod emails; exports `dry-run-report.json` as GitHub Actions artifact |
| **Instagram Idempotency** | At-least-once execution with publication recovery; uses `publish_attempt_id` (UUID) + high-entropy `correlation_token` (e.g. `BUC-7f3a91c2e4b8`) |
| **Public Caption Safety** | Correlation token is publicly visible on Instagram; strictly contains NO database IDs, NO confession IDs, NO user info, NO secrets, and NO internal details |
| **Carousel Recovery** | Persists `instagram_child_container_ids jsonb` and logs to `instagram_publish_attempts` table (keyed by `publish_attempt_id uuid PK`) |
| **Token Maintenance** | Validates & refreshes token BEFORE posting starts; reads exact `expires_at` from Meta response; on failure sets `failure_stage = 'instagram_token'`, aborts posting, and alerts admin |
| **Concurrency Protection** | GitHub Actions concurrency group + connection-pool-safe durable database lease (`agent_locks` table) with atomic `RETURNING` verification and 3-minute heartbeat |
| **Runtime Budget** | Agent enforces a maximum execution budget of 25 minutes (clean shutdown before the 30-minute GitHub Actions timeout) |
| **Sheets Sync Decoupling** | Sheets sync is durable background task (`sheets_sync_status = 'pending'`); Sheets failures never fail confession or block posting |
| **Public App Attack Surface** | `apps/public` completely stripped of Google credentials and dependencies; accepts `{ text }` only; server generates all metadata |
| **IP Hashing** | Uses `HMAC-SHA256(IP_HASH_SECRET, ip)` to prevent rainbow table attacks |
| **Rate Limiting** | Single atomic Postgres function (`check_and_increment_rate_limit`) with index on `reset_at`, preventing multi-instance serverless race conditions |
| **Admin Authentication** | `ADMIN_PASSWORD_HASH` using bcrypt (cost factor 10); plaintext admin password completely eliminated |
| **Secrets Isolation** | `apps/admin/lib/secrets.ts` centralizes all secret loading; Supabase `settings` table is configuration-only; central `redactSecrets()` sanitizes logs and emails |
| **Settings Security** | Strict allowlist with Zod validation; enforces `storage_warning_threshold < storage_critical_threshold` and `default max_per_batch = 50` (range 1–100) |
| **Storage Protection** | Storage cleanup strictly protects images for confessions in `approved`, `posting`, or `failed` (under recovery); respects `emergency_keep_percentage` safety floor |
| **Admin Overrides** | Explicit separate actions: `Force Approve` (`approved`), `Force Reject` (`rejected`), `Re-run AI` (`pending`), `Convert to Rule` |
| **Bulk Actions** | 2-step confirmation with affected record count; "Delete All" uses soft-delete (`deleted_at`) |
| **FIFO Order** | FIFO among eligible items (`ORDER BY created_at ASC` within actionable statuses); `pending_review` never blocks newer approved confessions |
| **Log Retention** | Automatic 365-day retention on `audit_log`, 180-day on `error_log`, `agent_runs`, and `digest_history` |

---

## Detailed Implementation Phases (Phases A through G)

---

### Phase A: Foundation & Database Infrastructure

Build the core database foundations, constraints, sequences, tables, and secrets abstraction first.

#### 1. Database Schema & Tables

##### `confessions` — Core Data Table
```sql
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
```

##### `instagram_publish_attempts` — Pre-API Persistence & Recovery Table
```sql
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
```

##### `agent_locks` — Durable Concurrency Lease Table
```sql
CREATE TABLE agent_locks (
  lock_name text PRIMARY KEY,
  locked_by text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT NOW(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL
);
```

##### `rate_limits` — Atomic Distributed Serverless Rate Limiter
```sql
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 1,
  reset_at timestamptz NOT NULL
);
```

##### `agent_runs`, `audit_log`, `settings`, `error_log`, `digest_history`
Defined with strict schemas, allowlists, and retention indices.

#### 2. Atomic Rate Limit Postgres Function
```sql
CREATE OR REPLACE FUNCTION check_and_increment_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) RETURNS jsonb AS $$
DECLARE
  v_now timestamptz := NOW();
  v_row rate_limits%ROWTYPE;
BEGIN
  INSERT INTO rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_now + (p_window_seconds || ' seconds')::interval)
  ON CONFLICT (key) DO UPDATE
  SET count = CASE
        WHEN rate_limits.reset_at < v_now THEN 1
        ELSE rate_limits.count + 1
      END,
      reset_at = CASE
        WHEN rate_limits.reset_at < v_now THEN v_now + (p_window_seconds || ' seconds')::interval
        ELSE rate_limits.reset_at
      END
  RETURNING * INTO v_row;

  IF v_row.count <= p_limit THEN
    RETURN jsonb_build_object('allowed', true, 'remaining', p_limit - v_row.count, 'reset_at', v_row.reset_at);
  ELSE
    RETURN jsonb_build_object('allowed', false, 'remaining', 0, 'reset_at', v_row.reset_at);
  END IF;
END;
$$ LANGUAGE plpgsql;
```

#### 3. Database Sequences, Constraints & Indexes
```sql
CREATE SEQUENCE confession_number_seq START WITH 1 INCREMENT BY 1;

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

CREATE INDEX idx_confessions_status_created ON confessions(status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_confessions_content_hash_created ON confessions(content_hash, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_confessions_next_retry ON confessions(next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX idx_confessions_processing_started ON confessions(processing_started_at) WHERE processing_started_at IS NOT NULL;
CREATE INDEX idx_confessions_last_progress ON confessions(last_progress_at) WHERE last_progress_at IS NOT NULL;
CREATE INDEX idx_audit_log_confession_created ON audit_log(confession_id, created_at);
CREATE INDEX idx_error_log_status_created ON error_log(status, created_at);
CREATE INDEX idx_publish_attempts_confession ON instagram_publish_attempts(confession_id, attempt_number);
CREATE INDEX idx_rate_limits_reset_at ON rate_limits(reset_at);
```

#### 4. Safe Sequence Migration Script (`scripts/migrate-sheets-to-supabase.ts`)
- Preserves historical IDs, text, numbers, statuses, and post IDs.
- Safely resets sequences with empty-table handling:
  ```sql
  SELECT setval(pg_get_serial_sequence('confessions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM confessions;
  SELECT setval('confession_number_seq', COALESCE(MAX(number), 1), MAX(number) IS NOT NULL) FROM confessions;
  ```

#### 5. Environment & Secrets Abstraction (`apps/admin/lib/secrets.ts`, `apps/admin/lib/redact.ts`)
- Strongly typed secrets loading from `process.env`.
- Central `redactSecrets()` utility sanitizing logs and emails.
- Admin auth using `ADMIN_PASSWORD_HASH` (bcrypt).

---

### Phase B: Public Submission API & Hardening

Secure the public submission intake before building AI or admin tooling.

#### 1. Strip Public App Dependencies
- Remove `google-spreadsheet` and `google-auth-library` from `apps/public/package.json`.

#### 2. Public Submission Endpoint (`apps/public/app/api/confessions/route.ts`)
- Accepts strictly `{ "text": string }` (10–2,000 characters).
- Rejects any client-submitted internal fields (`status`, `number`, `created_at`, AI verdict, etc.).
- Normalizes text: lowercases, collapses whitespace, strips zero-width spaces.
- Content hash: computes SHA-256 for exact duplicate detection.
- Submitter IP: computes `HMAC-SHA256(IP_HASH_SECRET, ip)` (anti-rainbow table).
- Rate limiting: calls Postgres RPC `check_and_increment_rate_limit(submitter_ip_hash, 3, 3600)`.
- Cooldown: verifies 60s since last submission from same IP hash.
- Honeypot check + submission timing (<2s = bot rejected).
- Inserts into Supabase with `status = 'pending'`, `sheets_sync_status = 'pending'`.

---

### Phase C: AI Moderation Pipeline (Gemini 3.8 Flash Hierarchy)

#### 1. Centralized Model Hierarchy (`apps/admin/lib/aiConfig.ts`)
```ts
export const AI_MODELS = {
  primary: 'gemini-3.8-flash',
  fallback1: 'gemini-3.7-flash',
  fallback2: 'gemini-3.6-flash',
} as const;
```

#### 2. Regex Pre-Filter
- Fast regex matching for phone numbers (`\b[6-9]\d{9}\b`, `\+91\s?\d{10}`) and email addresses.
- Rejects immediately with zero AI quota consumption (documented platform privacy policy).

#### 3. AI Moderation Engine (`apps/admin/lib/aiModerator.ts`)
- Uses modern `@google/genai` SDK.
- Classifies errors:
  - Retryable (429, 5xx, timeout): pauses with jitter and `Retry-After` header, retries up to 2x before model fallback (`3.8 → 3.7 → 3.6`).
  - Client errors (400, bad prompt): throws immediately.
- Multi-factor `pending_review` routing:
  - `model_confidence < 0.7`
  - Zod parsing fails after retry
  - Ambiguous policy conflict (e.g. potential PII or borderline harassment) detected even if confidence is high.
- Zod structured output validation.
- Records full audit metadata: `decision_reason`, `model_confidence`, `matched_rules`, `policy_level`, `flags`, `model_id`, `model_version`, `ai_policy_version`, `instruction_version`, `prompt_hash`, `generation_config`, `fallback_used`. (No internal chain-of-thought stored).

---

### Phase D: Image Generation & Instagram Pipeline

#### 1. Image Generator & Protected Storage (`apps/admin/lib/imageStorage.ts`)
- Canvas rendering with `@napi-rs/canvas`.
- Uploads images to Supabase bucket `confession-images` at `{confession_id}/{part_index}.png`.
- Protected cleanup algorithm: never touches images for `approved`, `posting`, or recoverable `failed` confessions; enforces `emergency_keep_percentage` (default 50%) safety floor.

#### 2. Pre-API Attempt Persistence Rule (`apps/admin/lib/instagramPoster.ts`)
- Before dispatching ANY HTTP request to Instagram Graph API:
  1. Generate `publish_attempt_id` (UUID) and high-entropy `correlation_token`:
     `"BUC-" + publish_attempt_id.replace(/-/g, '').slice(0, 12)`
  2. Transactionally insert into `instagram_publish_attempts`.
  3. Update `confessions` with `publish_attempt_id`, `correlation_token`, `instagram_publish_status = 'attempt_persisted'`, `last_progress_at = NOW()`.
  4. Only after DB commit succeeds -> call Instagram API.

#### 3. Instagram Recovery Workflow
- Check existing `correlation_token` on Instagram account recent media before attempting publish.
- If post found on Instagram matching the correlation token:
  - Recover published ID as `ig_post_id`.
  - Set `status = 'posted'`, `instagram_publish_status = 'published'`, `recovered = true`.
  - Skip duplicate publish call cleanly!

#### 4. Carousel & Publishing Flow
- Persist `instagram_child_container_ids jsonb`.
- Create parent carousel container with caption metadata containing confession text + correlation token (clean public metadata, no sensitive IDs).
- Verify publication via `GET /{published_id}`.
- Transition `status = 'posted'`, `posted_at = NOW()`.

---

### Phase E: Confession Agent & Execution Engine

#### 1. Concurrency Protection & Heartbeat (`apps/admin/lib/confessionAgent.ts`)
- Acquire durable database lease using atomic upsert with `RETURNING locked_by`:
  ```sql
  INSERT INTO agent_locks (lock_name, locked_by, acquired_at, last_heartbeat_at, expires_at)
  VALUES ('buconfess_daily_agent', run_uuid, NOW(), NOW(), NOW() + INTERVAL '10 minutes')
  ON CONFLICT (lock_name) DO UPDATE
  SET locked_by = run_uuid, acquired_at = NOW(), last_heartbeat_at = NOW(), expires_at = NOW() + INTERVAL '10 minutes'
  WHERE agent_locks.expires_at < NOW()
  RETURNING locked_by;
  ```
- If returned row does not match `run_uuid`: log "Agent already running — skipped", record `status = 'skipped'`, exit 0.
- Background heartbeat timer updates `last_heartbeat_at = NOW()`, `expires_at = NOW() + INTERVAL '10 minutes'` every 3 minutes.

#### 2. Pre-Flight Token Validation
- Inspect `instagram_token_expires_at`.
- If expiring within 7 days: exchange for long-lived token via Meta Graph API; read exact `expires_at`.
- If refresh fails: set `failure_stage = 'instagram_token'`, abort posting run, notify admin.

#### 3. Milestone Progress Tracking & Safe Stale Recovery
- Update `last_progress_at = NOW()` after every major checkpoint:
  `image_generation_started`, `image_generation_completed`, `storage_uploaded`, `child_containers_created`, `parent_container_created`, `publish_dispatched`, `verification_completed`.
- Stale detection logic separates:
  - `stale_claim_timeout_minutes` (default 10m): worker claimed confession but never made any progress.
  - `stale_progress_timeout_minutes` (default 10m): worker stopped progressing mid-flight.
- Re-enqueues without double-incrementing `attempt_count`.

#### 4. Execution Loop & 25-Minute Runtime Budget
- Hard budget: 25 minutes. If exceeded, stop claiming new confessions, complete in-flight work cleanly, release lease, exit 0.
- Live execution: assigns permanent `confession_number_seq` (never reassigned).
- Dry Run mode: uses `#DRY-RUN` preview number, in-memory images, zero DB mutations, zero prod storage uploads, zero prod audit logs; serializes results into `dry-run-report.json` for GitHub Actions artifact upload.

#### 5. Decoupled Housekeeping & Resend Digest
- Reconcile pending/failed Sheets rows. Sheets failure never causes confession to fail.
- Send Resend HTML digest (non-blocking).
- Prune expired logs (365d audit, 180d errors/runs, rate limits).

---

### Phase F: Admin Dashboard Overhaul

#### 1. Dashboard Layout & Live Heartbeat
- Top bar with live agent status:
  `[Agent Status: RUNNING • Heartbeat: 14s ago • Lease expires: 8m 46s]`
- Status count bar with 8 states:
  `Pending Review (4) │ Failed (2) │ Posting (1) │ Processing (1) │ Pending (17)`

#### 2. Confession Queue
- Filter bar: `All (43) | Pending (17) | Processing (1) | Approved (3) | Posting (1) | Posted (12) | Pending Review (4) | Rejected (3) | Failed (2)`
- Card view displaying `failure_stage`, attempt count, and last progress timestamp.
- Explicit disambiguated actions:
  - `Force Approve` → sets `status = 'approved'`
  - `Force Reject` → sets `status = 'rejected'`
  - `Re-run AI` → sets `status = 'pending'`
  - `Convert to Rule` → opens policy rule editor
- Bulk action protection: 2-step modal confirmation with affected count; soft-delete for Delete All.

#### 3. Moderation Playground & Rules Manager
- Tests text against `gemini-3.8-flash` (default), `gemini-3.7-flash`, or `gemini-3.6-flash`.
- Displays structured verdict, decision reason, confidence, and matched policy level without persistence.
- Rules manager with policy hierarchy validation (blocks weakening Level 1 or Level 2 safety/privacy rules).

#### 4. Settings Panel (Strict Allowlist)
- Validates allowlist: `posting_enabled`, `max_per_batch` (default 50, range 1–100), `image_retention_days`, `storage_warning_threshold`, `storage_critical_threshold`, `emergency_keep_percentage`, `max_retry_attempts`, `stale_claim_timeout_minutes`, `stale_progress_timeout_minutes`, `posting_delay_seconds`, `duplicate_window_hours`, `digest_email`.
- Enforces `storage_warning_threshold < storage_critical_threshold`.

---

### Phase G: Production Testing & Verification Plan

#### 1. Automated Unit & Integration Tests
| Test Case | Category | Expected Result |
|-----------|----------|-----------------|
| "I love the library coffee at night" | Moderation | ✅ Approve (Level 5) via `gemini-3.8-flash` |
| "Rahul from CSE 3rd year room 405 is a cheat" | Moderation | ❌ Reject (Level 2 — PII) |
| "Call 9876543210 for exam help" | Moderation | ❌ Reject via Regex Pre-filter (0 AI quota used) |
| Simulated 429 on Gemini 3.8 | Fallback | ✅ Jittered backoff, seamless fallback to `gemini-3.7-flash` |
| Malformed Gemini JSON response | Schema | ✅ Retries once; sets `pending_review` if invalid |
| Ambiguous PII conflict with high confidence | Policy Conflict | ⚠️ Routes to `pending_review` |
| Duplicate submission within window | Abuse | ❌ Reject via `content_hash` match |
| Submission in <2 seconds | Bot Protection | ❌ Reject via honeypot / timing check |
| 4th submission in 1 hour from same IP | Rate Limit | ❌ Reject via atomic Postgres function |

#### 2. State Machine & Disaster Recovery Tests
| Scenario | Expected Result |
|----------|-----------------|
| Crash after Instagram publish before `ig_post_id` saved | Pre-API persisted attempt + correlation token enables recovery from Instagram API → sets `status = 'posted'` without duplicate posting |
| Process killed mid-carousel creation | Recovers existing child containers from `instagram_child_container_ids` without creating duplicates |
| Two concurrent triggers (cron + manual) | Lock lease blocks second run; logs "Agent already running — skipped", exits 0 |
| Instagram token expiring in 3 days | Refreshes token via Meta API; stores exact `expires_at` |
| Instagram token expired & unrefreshable | Sets `failure_stage = 'instagram_token'`, aborts before posting, alerts admin |
| Google Sheets API offline | Confessions post to Instagram successfully; `sheets_sync_status = 'failed'`; reconciles on next run |
| Resend email API outage | Run finishes with status `completed`; error logged in `error_log` |
| Dry Run execution | Validates moderation & in-memory images; sequences & production tables completely untouched; outputs artifact |

---

## Phase 10: GitHub Actions Scheduling & Concurrency

#### `.github/workflows/daily-post.yml`
```yaml
name: Daily Confession Posting
on:
  schedule:
    - cron: '0 19 * * *'
      timezone: 'Asia/Kolkata'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Execute dry run without publishing or modifying database'
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: bu-confessions-agent
  cancel-in-progress: false

jobs:
  post-confessions:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: cd apps/admin && npm ci
      - run: cd apps/admin && npx tsx scripts/run-agent.ts
        env:
          DRY_RUN: ${{ inputs.dry_run || 'false' }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          INSTAGRAM_ACCESS_TOKEN: ${{ secrets.INSTAGRAM_ACCESS_TOKEN }}
          INSTAGRAM_USER_ID: ${{ secrets.INSTAGRAM_USER_ID }}
          GOOGLE_SHEET_ID: ${{ secrets.GOOGLE_SHEET_ID }}
          GOOGLE_SERVICE_ACCOUNT_EMAIL: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_EMAIL }}
          GOOGLE_PRIVATE_KEY: ${{ secrets.GOOGLE_PRIVATE_KEY }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          DIGEST_EMAIL: ${{ secrets.DIGEST_EMAIL }}
          ADMIN_PASSWORD_HASH: ${{ secrets.ADMIN_PASSWORD_HASH }}
          JWT_SECRET: ${{ secrets.JWT_SECRET }}
          IP_HASH_SECRET: ${{ secrets.IP_HASH_SECRET }}

      - name: Upload Dry Run Report Artifact
        if: ${{ inputs.dry_run == true || inputs.dry_run == 'true' }}
        uses: actions/upload-artifact@v4
        with:
          name: dry-run-report
          path: apps/admin/dry-run-report.json
          retention-days: 7
```

---

## Required Dependencies & Environment Variables

#### `apps/admin/package.json`
- `@google/genai` (modern official Google GenAI SDK)
- `@supabase/supabase-js`
- `resend` + `@react-email/components`
- `zod`
- `bcryptjs` + `@types/bcryptjs`
- `tsx`
- `google-spreadsheet`, `google-auth-library` (for admin Sheets sync)
- `@napi-rs/canvas` (image generation)
- `jsonwebtoken`, `cookie`

#### `apps/public/package.json`
- `@supabase/supabase-js`
- `zod`
*(Completely stripped of `google-spreadsheet` and `google-auth-library`)*

#### Environment Variables
```env
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=          # Admin / GitHub Actions ONLY
NEXT_PUBLIC_SUPABASE_ANON_KEY=      # Public app ONLY

# Google Gemini
GEMINI_API_KEY=

# Instagram Graph API
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_USER_ID=
IG_CAPTION_PREFIX=
IG_HANDLE=

# Google Sheets (Admin Sync Only)
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=

# Email
RESEND_API_KEY=
DIGEST_EMAIL=

# Admin Authentication & Security
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=                # bcrypt hash (cost 10), NEVER plaintext
JWT_SECRET=
IP_HASH_SECRET=                     # Secret salt for HMAC-SHA256 IP hashing

# GitHub Actions Trigger (Fine-grained PAT with Actions:write permission ONLY)
GITHUB_TOKEN=
GITHUB_REPO=                        # owner/repo format
```
