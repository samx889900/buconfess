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

---

## Phase 11: Gemini Multi-Project Credential Pool & Quota-Aware Failover

### 1. Architectural Goal & Context
Google Cloud enforces Gemini API rate limits and quotas **per Google Cloud Project**, not per API key. Multiple API keys pointing to the same Google Cloud project share the identical quota pool.
To achieve genuine multi-project resilience, BUConfess supports 3–4 independently configured Gemini credentials backed by distinct, legitimately authorized Google Cloud projects:
* `GEMINI_API_KEY_1` ➔ Google Cloud Project A
* `GEMINI_API_KEY_2` ➔ Google Cloud Project B
* `GEMINI_API_KEY_3` ➔ Google Cloud Project C
* `GEMINI_API_KEY_4` ➔ Google Cloud Project D
* *Backward Compatibility:* If only `GEMINI_API_KEY` is present, it is mapped to `project-1` transparently.

> [!SECURITY]
> **Credential Protection Invariants:**
> - API keys are NEVER exposed to the browser.
> - API keys are NEVER logged or printed to console.
> - API keys are NEVER stored in the database.
> - API keys are strictly loaded from environment/GitHub Actions secrets into private memory closures.

### 2. Runtime Credential Pool Abstraction
A dedicated singleton abstraction (`apps/admin/lib/ai/credentialPool.ts`) manages project-level health, in-flight tracking, and cooldown states:
```ts
export type GeminiErrorClassification =
  | 'AUTHENTICATION'          // 401 / Invalid API key
  | 'PERMISSION'              // 403 / Billing disabled / API not enabled
  | 'MODEL_NOT_FOUND'        // 404 / Model retired or not found
  | 'INVALID_REQUEST'         // 400 / Bad request, malformed prompt
  | 'RATE_LIMIT_TRANSIENT'    // 429 RPM/TPM short-term throttling
  | 'DAILY_QUOTA_EXHAUSTED'   // 429 RPD daily requests exhausted (PerDay quotaId)
  | 'SERVICE_UNAVAILABLE'     // 503 Overloaded, high demand
  | 'TIMEOUT'                 // Request deadline exceeded (10s)
  | 'UNKNOWN';

export interface CredentialPoolSlot {
  id: string;                 // Non-secret identifier e.g. "project-1"
  available: boolean;
  unavailableReason: string | null;
  cooldownUntil: number | null; // Epoch milliseconds
  lastErrorType: GeminiErrorClassification | null;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  activeInFlight: number;
  totalRequests: number;
}
```

### 3. Error Classification Engine
All errors from `@google/genai` are mapped through `classifyGeminiError(error)`:
1. **`AUTHENTICATION` (401):** Marks credential permanently unavailable for the process lifetime.
2. **`PERMISSION` (403):** Marks credential unavailable for the process lifetime (avoids spamming disabled billing projects).
3. **`MODEL_NOT_FOUND` (404):** Does NOT disable the credential; indicates the model is unavailable on this SDK/API. Cascades immediately to the next model.
4. **`INVALID_REQUEST` (400):** Non-retryable input failure.
5. **`RATE_LIMIT_TRANSIENT` (429):** Short-term throttling (e.g. `retryDelay < 60s` or RPM/TPM violations). Bounded exponential backoff with jitter (max 1 retry up to 3s). If still failing, failover to next project.
6. **`DAILY_QUOTA_EXHAUSTED` (429):** Error message or `QuotaFailure.violations.quotaId` contains `PerDay` or indicates daily exhaustion. Sets `cooldownUntil` to next reset (midnight Pacific Time or 12h cooldown), marks `available = false`, and **immediately fails over to the next project without retrying the exhausted project**.
7. **`SERVICE_UNAVAILABLE` (503):** Bounded 1 short retry (500ms); if persistent, failover to next project.
8. **`TIMEOUT` (10s):** Bounded 1 retry; if persistent, failover to next project.

### 4. Smart Model Cascade × Credential Matrix
The exact allowlisted model cascade order is strictly preserved:
`gemini-3.8-flash ➔ gemini-3.7-flash ➔ gemini-3.5-flash ➔ gemini-2.5-flash ➔ gemini-2.5-flash-lite ➔ pending_review`

Credential failover operates **within** each model step before falling back to the next model:
```
For each Model M in Cascade:
  AvailableCredentials = pool.getAvailableCredentials()
  If AvailableCredentials is empty:
    Continue to Model M+1

  For each Credential C in AvailableCredentials:
    1. Lease Credential C (round-robin / least-busy)
    2. Execute Model M using Credential C (10s timeout)
    3. Evaluate Result:
       - SUCCESS ➔ Return verdict, update stats, STOP cascade immediately.
       - DAILY_QUOTA_EXHAUSTED ➔ Mark C in daily cooldown, failover immediately to next Credential on Model M.
       - TRANSIENT (503 / RPM 429 / Timeout) ➔ Bounded retry; if still failing, failover to next Credential on Model M.
       - MODEL_NOT_FOUND (404) ➔ Model unavailable on all projects; break credential loop, proceed to Model M+1.
       - AUTH / PERM ➔ Mark C permanently unavailable, failover to next Credential on Model M.

If all models fail across all credentials:
  ➔ Return verdict: 'pending_review' (Fail-Safe Invariant: Never auto-approve or auto-publish unmoderated content)
```

### 5. Concurrency & Anti-Hammering Protection
* **Round-Robin Leasing:** Multi-confession queue draining distributes consecutive moderation requests across healthy projects in rotation (`project-1 ➔ project-2 ➔ project-3 ➔ ...`).
* **Active In-Flight Tracking:** Prevents concurrent promises from overwhelming a single project's RPM limit.

---

## Phase 12: Multi-Slot Agent Scheduling — Every 6 Hours

### 1. Requirement & Schedule Specification
BUConfess operates on a multi-slot schedule running **every 6 hours**, providing **4 scheduled agent opportunities per day**:

| Slot | Scheduled Time (Asia/Kolkata) | UTC Equivalent | Purpose & Role |
| :---: | :---: | :---: | :--- |
| **Slot 1** | **00:00 IST** (Midnight) | 18:30 UTC (prev. day) | Midnight calendar boundary / first daily processing slot; clears late-night confessions submitted during peak evening hours |
| **Slot 2** | **06:00 IST** (Morning) | 00:30 UTC | Morning confession intake, early campus announcement queue |
| **Slot 3** | **12:00 IST** (Noon) | 06:30 UTC | Mid-day backlog clearance, lunch-hour queue draining |
| **Slot 4** | **18:00 IST** (Evening) | 12:30 UTC | Peak evening campus posting & moderation |

* **Timezone:** `Asia/Kolkata` (Indian Standard Time, IST).
* **Core Distinction:** This represents **4 scheduled agent execution opportunities**, NOT 4 independent daily publication quotas.

### 2. Complete 12-Step Queue-Draining Workflow Per Slot
Each scheduled slot triggers a complete, autonomous agent lifecycle rather than merely publishing a fixed batch of confessions:
1. **Acquire durable agent lock:** Distributed lease in `agent_locks` with a 2-minute heartbeat to guarantee single-runner execution.
2. **Evaluate schedule slot window & determine whether this slot has already been executed:**
   - For scheduled runs, check whether current time is within `[targetTime - 5m, targetTime + 25m]` for any configured slot (`00:00, 06:00, 12:00, 18:00 IST`).
   - If outside every valid slot window: exit safely with a skipped status (`postingSkippedReason = 'outside_schedule_window'`). Do NOT claim a slot, and do NOT perform scheduled queue moderation, preventing accidental Gemini quota consumption from delayed or spurious invocations.
   - If inside a valid window: atomically claim `(posting_date, schedule_slot)` in `daily_posting_runs`. If already claimed or running, abort cleanly without duplicate processing (`postingSkippedReason = 'slot_already_claimed'`).
3. **Read current runtime settings:** Fetch dynamic configuration from Supabase `settings` table (`posting_enabled`, `max_daily_posts`, `posts_per_slot`, `max_per_batch`, etc.).
4. **Moderate eligible pending confessions:** Drain pending confessions through the Gemini Multi-Project Credential Pool (Phase C).
5. **Process approved confessions:** Select eligible approved confessions in FIFO order (`ORDER BY created_at ASC`), respecting per-slot and daily quotas.
6. **Generate images:** Render canvas slides with Noto Color Emoji fallback and upload to Supabase storage.
7. **Publish eligible posts:** Create Instagram container(s), write pre-API attempt record, dispatch publication, and observe `min_delay_between_posts_sec`.
8. **Verify publication:** Query Instagram Graph API for live status and permalink verification.
9. **Perform decoupled Google Sheets synchronization:** Synchronize posted confession records to the external Google Sheet asynchronously without blocking confession status.
10. **Continue draining eligible work until a safe stopping condition:** Loop in batches of `max_per_batch` until:
    - Queue is exhausted (no more eligible pending or approved confessions).
    - Current slot publication cap is reached (`slotCount >= posts_per_slot`).
    - Global daily publication cap is reached (`todayCount >= max_daily_posts`).
    - Agent approaches the 25-minute runtime safety budget (`MAX_RUNTIME_MS`).
    - Quota cooldown / emergency halt triggered.
11. **Record slot completion:** Finalize the row in `daily_posting_runs` with `status: 'completed'` (or `'failed'`), `published_count`, `completed_at`, and error diagnostics if any.
12. **Release durable lock:** Clear active lease in `agent_locks` and terminate runner process cleanly with exit code 0.

### 3. Separation of Batch, Slot, and Daily Limits

The architecture strictly distinguishes three distinct operational boundaries:

```
┌────────────────────────────────────────────────────────────────────────┐
│  max_daily_posts = 30 (Hard Global Calendar-Day Cap (00:00–23:59 IST)) │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  posts_per_slot = 8  (Per-Slot Allocation Cap)                   │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │  max_per_batch = 10  (DB Query Chunk Size)                 │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **`max_per_batch` (Default: 10):**
   - Purely a database chunking and memory efficiency parameter.
   - **Critical Invariant:** Hitting `max_per_batch` MUST NOT terminate the agent run. The worker drains the queue in consecutive batches until a real stopping condition is reached.
2. **`posts_per_slot` (Proposed Default: 8):**
   - The maximum number of confessions that can be published during a single 6-hour slot.
   - Provides a theoretical maximum of `8 × 4 = 32` publications per day.
   - Fully configurable at runtime via the Admin Settings dashboard.
3. **`max_daily_posts` (Hard Cap: 30):**
   - The global hard ceiling on Instagram posts across the entire calendar day (resets midnight IST).
   - **Global Cross-Slot Enforcement:**
     - Slot 1 (00:00): Publishes up to 8 posts (Total today: 8, Remaining daily: 22)
     - Slot 2 (06:00): Publishes up to 8 posts (Total today: 16, Remaining daily: 14)
     - Slot 3 (12:00): Publishes up to 8 posts (Total today: 24, Remaining daily: 6)
     - Slot 4 (18:00): Publishes up to **6 posts** (Capped at `min(8, 30 - 24) = 6`). Total today: 30.
     - The fourth slot NEVER exceeds the 30-post daily ceiling.

### 4. Durable Slot Identity & Duplicate Invocation Protection
* **Durable Unique Key:** The database enforces `CONSTRAINT daily_posting_runs_date_slot_key UNIQUE (posting_date, schedule_slot)`.
  - Four distinct slot identities per date: `(2026-09-27, '00:00')`, `(2026-09-27, '06:00')`, `(2026-09-27, '12:00')`, `(2026-09-27, '18:00')`.
* **Atomic Claim Invariant:** When an agent begins Phase D, it performs an atomic INSERT into `daily_posting_runs`. If GitHub Actions invokes the same slot twice (due to retry, delayed runner, duplicate heartbeat, or manual trigger), the second attempt hits PostgreSQL error `23505` (unique violation) and gracefully aborts publishing with `postingSkippedReason = 'slot_already_claimed'`.
* **Zero Cross-Slot Pollution:** A failure in Slot 2 (`status = 'failed'`) does not block Slot 3 from executing independently at 12:00. Each slot has its own row and state.
* **Failure Recording:** If a catastrophic error occurs during slot processing, `finalizeDailyPostingSlot(slotRunId, postedCount, supabase, errorMessage)` records `status = 'failed'`, records the exact error stack, and preserves `published_count` so daily quota accounting remains 100% accurate.

### 5. GitHub Actions Heartbeat & Window Calculation
* **Workflow Cron:**
  `.github/workflows/daily-post.yml`:
  ```yaml
  on:
    schedule:
      - cron: '30 18,0,6,12 * * *'
  ```
  - `18:30 UTC` ➔ `00:00 IST` (Slot 1 — Midnight)
  - `00:30 UTC` ➔ `06:00 IST` (Slot 2 — Morning)
  - `06:30 UTC` ➔ `12:00 IST` (Slot 3 — Midday)
  - `12:30 UTC` ➔ `18:00 IST` (Slot 4 — Evening)
* **Deterministic Window Calculation ([schedule.ts](file:///c:/Users/vikra/Downloads/Projects/buconfess/apps/admin/lib/schedule.ts)):**
  - Evaluated in `Asia/Kolkata` with a 30-minute matching window: `[target - 5 minutes, target + 25 minutes]`.
  - Slot 00:00: `23:55 – 00:25 IST`.
  - Slot 06:00: `05:55 – 06:25 IST`.
  - Slot 12:00: `11:55 – 12:25 IST`.
  - Slot 18:00: `17:55 – 18:25 IST`.
  - **Runner Delay Tolerance:** GitHub Actions free runners occasionally queue before spinning up. The +25 minute window ensures that even a 20-minute runner startup delay still executes within the legitimate slot window.
  - **Midnight Date Rollover Normalization:** When the 00:00 slot is triggered slightly early (e.g. at 23:55–23:59 IST on day $D$), the calendar date in IST is still day $D$. The scheduler normalizes `postingDate` to day $D+1$ when matching the upcoming `00:00` slot so that the run is correctly attributed to the new calendar day's 00:00 slot.
  - **Outside-Window Safety (Scheduled Invocations):** If a SCHEDULED invocation runs outside every valid slot window (e.g. at 03:00 IST due to delayed runner or transient scheduler event):
    - Do not claim a scheduled posting slot.
    - Do not perform scheduled queue moderation merely because the workflow was invoked.
    - Exit safely with a skipped status (`postingSkippedReason = 'outside_schedule_window'`).
    - This strictly prevents accidental Gemini quota consumption from duplicate, delayed, or spurious workflow invocations outside a legitimate slot.
    - *Separation of Concerns:* If a separately authorized manual/admin diagnostic invocation exists (e.g. `workflow_dispatch` with administrative flags), it may explicitly execute moderation according to its own administrative parameters, completely decoupled from scheduled execution.

### 6. Backlog Latency Reduction
* **Target Backlog Latency:** Approximately ≤6 hours when scheduled execution, moderation capacity, and publication capacity are available.
* **Frequency vs. Guarantee:** While the four-slot schedule dramatically improves opportunity frequency compared to a single daily run (where a confession submitted at 19:30 IST waited ~23.5 hours for the next 19:00 run), it does NOT guarantee processing within 6 hours.
* **Potential Latency Blockers:**
  - Gemini daily quota exhaustion across projects (RPD).
  - All credential projects unavailable or in cooldown.
  - Flagging for manual human admin review (`pending_review`).
  - Reaching the global daily publication ceiling (`max_daily_posts = 30`).
  - Reaching the per-slot publication limit (`posts_per_slot = 8`).
  - Instagram API outage, transient network failure, or platform rate limiting.
  - Exceptionally large confession queues exceeding the 25-minute runtime safety budget.

### 7. Dry-Run Mode Invariants
* Dry-run mode (`--dry-run` or `DRY_RUN=true`) evaluates all four slots, tests queue draining, validates Gemini moderation, and simulates Instagram containers.
* **Safety Invariant:** Dry runs **never** insert or mutate records in `daily_posting_runs`, never claim slots, never draw sequence numbers, and never publish to Instagram.

### 8. Admin Dashboard Observability
The Admin Dashboard (`apps/admin`) exposes real-time slot and capacity telemetry:
* **Schedule Banner:** Shows active schedule (`00:00, 06:00, 12:00, 18:00 Asia/Kolkata`).
* **Slot Telemetry Panel:**
  - Active / Current slot window status.
  - Next scheduled slot time.
  - Last completed slot and outcome (`completed` / `failed` / `recovered`).
  - Today's published count and remaining capacity (`X / 30 posted, 30 - X remaining`).
  - Current slot publication count and remaining slot capacity (`Y / 8 posted, 8 - Y remaining`).
  - Active agent worker lock status (`agent_locks` holder, lease start, and heartbeat expiry).
  - Failed/recovered slot diagnostics (error messages, retry count, affected records).
  - Gemini credential pool health breakdown per project (`project-1: available`, `project-2: daily_quota cooldown (3h left)`).
  - **Zero Secret Exposure:** Strictly displays masked project handles (`project-1`, `project-2`); never displays API keys, headers, or raw tokens.

### 9. Database & Settings Specification (Zero Schema Migrations)
* **Pre-Existing Infrastructure:** The table `public.daily_posting_runs` created in `003_v35_production_upgrade.sql` already provides the necessary schema:
  - `posting_date date NOT NULL`
  - `schedule_slot text NOT NULL`
  - `CONSTRAINT daily_posting_runs_date_slot_key UNIQUE (posting_date, schedule_slot)`
  - `status text NOT NULL DEFAULT 'running'` (check: `status IN ('running', 'completed', 'failed')`)
  - `trigger_source text NOT NULL DEFAULT 'scheduled'`
  - `started_at timestamptz NOT NULL`
  - `completed_at timestamptz`
  - `published_count integer DEFAULT 0`
  - `error_message text`
* **Zero Schema Migrations Required:** Because `daily_posting_runs` already natively supports arbitrary slot identifiers (e.g. `'00:00'`, `'06:00'`, `'12:00'`, `'18:00'`), NO new database tables, columns, or migration files are required.
* **Settings Seed Defaults:** The only database updates needed are default value updates in the existing `settings` table:
  - `daily_posting_times`: update default value from `'20:00,22:00'` to `'00:00,06:00,12:00,18:00'`.
  - `posts_per_slot`: update default value from `15` to `8`.
  - `max_daily_posts`: remains `30` (strict hard cap).
  - `timezone`: remains `'Asia/Kolkata'`.

### 10. Deep Architectural Interaction: Multi-Slot Scheduling × Gemini Multi-Project Failover

The Multi-Slot Scheduler (Component B) and the Gemini Multi-Project Credential Pool (Component A) are tightly integrated through durable, non-interfering invariants:

```
┌────────────────────────────────────────────────────────────────────────┐
│               COMPONENT B: 6-HOUR MULTI-SLOT SCHEDULER                 │
│         (00:00 IST ➔ 06:00 IST ➔ 12:00 IST ➔ 18:00 IST)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ triggers 4x daily
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             PHASE C: MODERATION WORKER (QUEUE DRAINING)                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ leases credentials per request
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             COMPONENT A: GEMINI MULTI-PROJECT CREDENTIAL POOL          │
│    Project 1 (Cloud A) ➔ Project 2 (Cloud B) ➔ Project 3 (Cloud C)     │
│                                                                        │
│   Cascade: 3.8 Flash ➔ 3.7 Flash ➔ 3.5 Flash ➔ 2.5 Flash ➔ 2.5 Lite   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
           ┌────────────────────────┴────────────────────────┐
           ▼                                                 ▼
   [Quota Available]                             [All Quotas Exhausted]
Moderate ➔ Approved / Rejected             Status = 'pending_review'
Proceed to Phase D & E                     HALT Moderation for this Slot
(Subject to 8/slot, 30/day)                NO auto-approval. NO bypass.
                                           Next slot (in 6h) retries.
```

1. **Strict Model Cascade Preservation:**
   The allowlisted sequence `3.8 Flash ➔ 3.7 Flash ➔ 3.5 Flash ➔ 2.5 Flash ➔ 2.5 Flash Lite ➔ pending_review` remains immutable. Component B never skips or alters this hierarchy.
2. **Intra-Model Credential Failover:**
   Credential pool rotation occurs *within* each model step. If Project A encounters a 429 daily quota on `gemini-3.8-flash`, Project B is immediately attempted on `gemini-3.8-flash` before cascading down to `gemini-3.7-flash`.
3. **Cross-Slot Cooldown Persistence:**
   - When a project encounters a daily quota error (`DAILY_QUOTA_EXHAUSTED`), its slot enters cooldown until Google's Pacific midnight quota reset (`cooldownUntil`).
   - If Project A enters daily cooldown at 00:30 IST during Slot 1, Slot 2 (06:00 IST) and Slot 3 (12:00 IST) inspect the pool, observe that Project A is still cooled down, and automatically skip Project A, routing moderation to Project B and Project C.
   - When the Pacific reset occurs (~12:30 or 13:30 IST), Project A automatically reactivates for Slot 4 (18:00 IST).
4. **Complete Fail-Safe Guarantee:**
   If all configured Google Cloud projects exhaust their quotas during a slot:
   - Moderation halts safely.
   - Unmoderated records remain strictly `pending_review`.
   - Under ZERO circumstances are confessions auto-approved or posted without AI verification.
   - Slot publishing still proceeds for *previously approved* confessions (up to limits).
5. **Backlog Latency Improvement:**
   The 6-hour interval targets approximately ≤6 hours latency when execution, moderation, and publishing capacity are available. Records flagged `pending_review` due to transient upstream 503 or transient rate limits in Slot 1 can be cleanly re-evaluated in Slot 2.
6. **Decoupled Quota Accounting:**
   Gemini API quotas, Instagram publishing quotas, and database batch limits operate on completely separate accounting planes. Running 4 agent opportunities per day distributes moderation and publication smoothly without increasing Instagram risk.

---

## Phase 13: Comprehensive Master Test Plan

The implementation plan mandates **38 automated unit & integration tests** executed via Node test runner (`npm test`):

### A. Gemini Credential Pool & Failover Tests (16 Tests)
1. **Single credential success:** Validates moderation succeeds with single configured key.
2. **Credential A quota exhausted ➔ B succeeds:** Proves daily quota failure on Project A immediately attempts Project B on the same model without retrying A.
3. **A + B exhausted ➔ C succeeds:** Verifies multi-stage failover across 3 projects.
4. **All credentials exhausted ➔ `pending_review`:** Proves fail-safe invariant when all available projects are exhausted.
5. **503 High Demand bounded retry:** Proves 1 short retry (500ms) before credential failover.
6. **Transient 429 exponential backoff:** Proves RPM rate limit with short `retryDelay` applies jittered backoff.
7. **Daily quota 429 cooldown activation:** Proves `quotaId` with `PerDay` sets `cooldownUntil` and disables credential.
8. **Safe `Retry-After` parsing:** Tests float, string (`"19.29s"`), and integer header parsing.
9. **Invalid API key handling:** 401 unauthenticated marks credential permanently unavailable for process life.
10. **Model 404 immediate cascade:** 404 does not disable the project; immediately falls through to next model in cascade.
11. **No infinite retry loop:** Verifies all retry counters are strictly bounded.
12. **Concurrent worker distribution:** Proves consecutive requests distribute across healthy projects without collision.
13. **Model cascade preservation:** Strictly verifies `3.8 ➔ 3.7 ➔ 3.5 ➔ 2.5 ➔ 2.5-lite` sequence.
14. **Secret sanitization in logs:** Verifies zero API keys or credentials appear in console logs, audit logs, or error strings.
15. **Fail-safe pending review guarantee:** Verifies no circumstance can auto-approve or auto-publish unmoderated content.
16. **Restart storm prevention:** Verifies process restart does not trigger immediate retry storm on known exhausted projects.

### B. Multi-Slot Scheduling Tests (22 Tests)
1. **Four slot recognition:** `evaluatePostingWindow` correctly recognizes `00:00`, `06:00`, `12:00`, and `18:00`.
2. **Timezone fidelity:** Validates evaluation strictly respects `Asia/Kolkata` regardless of machine local timezone.
3. **00:00 slot window:** Tests 23:55 to 00:25 IST window and midnight date rollover.
4. **06:00 slot window:** Tests 05:55 to 06:25 IST window.
5. **12:00 slot window:** Tests 11:55 to 12:25 IST window.
6. **18:00 slot window:** Tests 17:55 to 18:25 IST window.
7. **Slot uniqueness constraint:** Database constraint prevents duplicate claims for the same slot.
8. **Duplicate invocation protection:** Second runner within the same window safely exits without duplicate work.
9. **Delayed runner tolerance:** Runner delayed by 15 minutes inside window successfully claims slot.
10. **Outside window handling:** Verifies that a scheduled invocation outside a valid slot window does not claim a slot, does not moderate queued confessions, does not consume Gemini quota, does not publish, and exits cleanly with `postingSkippedReason = 'outside_schedule_window'`. Also verifies that only an explicitly authorized manual/admin diagnostic invocation may bypass the scheduled-window restriction.
11. **Batch limit vs. run completion:** Confirms `max_per_batch` does not terminate the run; queue drains fully.
12. **Per-slot limit enforcement:** Confirms slot stops publishing once `posts_per_slot` is reached.
13. **Global daily limit enforcement:** Confirms all 4 slots combined cannot exceed `max_daily_posts = 30`.
14. **Cross-slot quota capping:** Slot 4 caps at `min(posts_per_slot, remainingDailyQuota)` (e.g. 6 posts).
15. **Posting disabled operational switch:** When `posting_enabled = false`, publishing is skipped cleanly.
16. **Gemini failure isolation:** Total Gemini failure does not corrupt or abort the posting slot.
17. **Instagram failure isolation:** Platform rate limits or outages safely pause queue draining without slot corruption.
18. **Durable lock mutual exclusion:** Concurrency lock prevents parallel workers from running the same slot.
19. **Dry run non-mutation guarantee:** Dry-run executes all 4 slots with zero database or Instagram mutations.
20. **Slot failure independence:** Failed Slot 2 does not block Slot 3 from running independently.
21. **Scheduling + Gemini failover integration:** Proves multi-project failover works seamlessly within scheduled slots.
22. **Cooldown survival across slots:** Credential marked in daily cooldown during Slot 1 remains in cooldown during Slot 2 until reset time.
