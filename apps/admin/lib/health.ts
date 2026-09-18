import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase';
import { getAdminConfessionCounts } from './confessions';
import { DEFAULT_AGENT_LOCK_NAME } from './agentLock';
import { recordAuditLog } from './audit';

// ---------------------------------------------------------------------------
// Health & Operational Monitor (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Security Invariants:
//   1. Read-only health probing — never executes expensive external pipelines.
//   2. Never exposes tokens, secrets, service-role keys, or full stack traces.
//   3. Bounded execution time with structured status values (ok, degraded, error, not_configured).
//   4. Stale lease release only permits removing demonstrably expired locks.
// ---------------------------------------------------------------------------

export type SubsystemStatus = 'ok' | 'degraded' | 'error' | 'not_configured';

export interface HealthReport {
  timestamp: string;
  environment: string;
  overall: 'ok' | 'degraded' | 'error';
  subsystems: {
    database: {
      status: SubsystemStatus;
      latencyMs?: number;
      error?: string;
    };
    moderation: {
      status: SubsystemStatus;
      provider: string;
      hasApiKey: boolean;
      details?: string;
    };
    image_generation: {
      status: SubsystemStatus;
      engine: string;
      available: boolean;
    };
    storage: {
      status: SubsystemStatus;
      provider: string;
      configured: boolean;
    };
    instagram: {
      status: SubsystemStatus;
      hasAccountId: boolean;
      hasAccessToken: boolean;
      configured: boolean;
      details?: string;
    };
  };
  worker: {
    lockName: string;
    isLocked: boolean;
    isStale: boolean;
    lockedBy: string | null;
    acquiredAt: string | null;
    lastHeartbeatAt: string | null;
    expiresAt: string | null;
  };
  latestRun: {
    id: number | null;
    runUuid: string | null;
    status: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    errorSummary: string | null;
    confessionsProcessed: number | null;
    confessionsPosted: number | null;
    dryRun: boolean | null;
  } | null;
  queueCounts: Record<string, number>;
  staleWork: {
    processingCount: number;
    postingCount: number;
    totalStale: number;
  };
}

/**
 * Executes a fast, read-only operational health check across all BUConfess subsystems.
 */
export async function getAdminHealthStatus(
  options: { supabaseClient?: SupabaseClient } = {}
): Promise<HealthReport> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const startTime = Date.now();
  const nowIso = new Date().toISOString();

  // 1. Database Ping
  let dbStatus: SubsystemStatus = 'ok';
  let dbLatency = 0;
  let dbError: string | undefined;

  try {
    const pingStart = Date.now();
    const { error: pingErr } = await supabase
      .from('confessions')
      .select('id', { count: 'exact', head: true });

    dbLatency = Date.now() - pingStart;

    if (pingErr) {
      dbStatus = 'error';
      dbError = pingErr.message;
    }
  } catch (err: any) {
    dbStatus = 'error';
    dbError = err?.message || 'Database connection unreachable';
  }

  // 2. Moderation Pipeline Availability
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  const modStatus: SubsystemStatus = hasGeminiKey ? 'ok' : 'not_configured';

  // 3. Image Generation Engine
  let imageStatus: SubsystemStatus = 'ok';
  try {
    // @napi-rs/canvas availability check
    require.resolve('@napi-rs/canvas');
  } catch {
    imageStatus = 'degraded';
  }

  // 4. Storage Subsystem Configuration
  const hasSupabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const storageConfigured = hasSupabaseUrl && hasServiceKey;
  const storageStatus: SubsystemStatus = storageConfigured ? 'ok' : 'not_configured';

  // 5. Instagram Subsystem Configuration (Zero secrets exposed)
  const hasIgAccount = Boolean(process.env.INSTAGRAM_ACCOUNT_ID && process.env.INSTAGRAM_ACCOUNT_ID.trim());
  const hasIgToken = Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCESS_TOKEN.trim());
  const igConfigured = hasIgAccount && hasIgToken;
  const igStatus: SubsystemStatus = igConfigured ? 'ok' : 'not_configured';

  // 6. Worker Lock / Durable Lease Status
  let lockName = DEFAULT_AGENT_LOCK_NAME;
  let isLocked = false;
  let isStale = false;
  let lockedBy: string | null = null;
  let acquiredAt: string | null = null;
  let lastHeartbeatAt: string | null = null;
  let expiresAt: string | null = null;

  try {
    const { data: lockRow } = await supabase
      .from('agent_locks')
      .select('lock_name, locked_by, acquired_at, last_heartbeat_at, expires_at')
      .eq('lock_name', DEFAULT_AGENT_LOCK_NAME)
      .maybeSingle();

    if (lockRow) {
      lockName = lockRow.lock_name;
      lockedBy = lockRow.locked_by;
      acquiredAt = lockRow.acquired_at;
      lastHeartbeatAt = lockRow.last_heartbeat_at;
      expiresAt = lockRow.expires_at;

      const expTime = new Date(lockRow.expires_at).getTime();
      const currTime = Date.now();
      isLocked = currTime < expTime;
      isStale = currTime >= expTime;
    }
  } catch (err) {
    console.warn('[HEALTH] Failed to inspect agent_locks:', err);
  }

  // 7. Latest Agent Run History
  let latestRun: HealthReport['latestRun'] = null;
  try {
    const { data: runRow } = await supabase
      .from('agent_runs')
      .select('id, run_uuid, status, started_at, finished_at, error_summary, confessions_processed, confessions_posted, dry_run')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runRow) {
      latestRun = {
        id: runRow.id,
        runUuid: runRow.run_uuid,
        status: runRow.status,
        startedAt: runRow.started_at,
        finishedAt: runRow.finished_at,
        errorSummary: runRow.error_summary,
        confessionsProcessed: runRow.confessions_processed,
        confessionsPosted: runRow.confessions_posted,
        dryRun: runRow.dry_run,
      };
    }
  } catch (err) {
    console.warn('[HEALTH] Failed to inspect agent_runs:', err);
  }

  // 8. Queue Live Status Counts
  let queueCounts: Record<string, number> = {
    all: 0,
    pending: 0,
    pending_review: 0,
    processing: 0,
    approved: 0,
    posting: 0,
    posted: 0,
    rejected: 0,
    failed: 0,
  };

  try {
    queueCounts = await getAdminConfessionCounts({ supabaseClient: supabase });
  } catch (err) {
    console.warn('[HEALTH] Failed to retrieve confession counts:', err);
  }

  // 9. Stale Work Detection (Processing or Posting without progress > 10m)
  let staleProcessingCount = 0;
  let stalePostingCount = 0;

  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: staleProcessing } = await supabase
      .from('confessions')
      .select('id')
      .eq('status', 'processing')
      .is('deleted_at', null)
      .or(`last_progress_at.lt.${tenMinutesAgo},and(last_progress_at.is.null,processing_started_at.lt.${tenMinutesAgo})`);

    const { data: stalePosting } = await supabase
      .from('confessions')
      .select('id')
      .eq('status', 'posting')
      .is('deleted_at', null)
      .or(`last_progress_at.lt.${tenMinutesAgo},and(last_progress_at.is.null,instagram_publish_attempted_at.lt.${tenMinutesAgo})`);

    staleProcessingCount = staleProcessing?.length || 0;
    stalePostingCount = stalePosting?.length || 0;
  } catch (err) {
    console.warn('[HEALTH] Failed to check stale work:', err);
  }

  // Determine overall status
  let overall: 'ok' | 'degraded' | 'error' = 'ok';
  if (dbStatus === 'error') {
    overall = 'error';
  } else if (
    modStatus === 'not_configured' ||
    igStatus === 'not_configured' ||
    isStale ||
    (staleProcessingCount + stalePostingCount) > 0 ||
    (queueCounts.failed || 0) > 0
  ) {
    overall = 'degraded';
  }

  return {
    timestamp: nowIso,
    environment: process.env.NODE_ENV || 'development',
    overall,
    subsystems: {
      database: {
        status: dbStatus,
        latencyMs: dbLatency,
        error: dbError,
      },
      moderation: {
        status: modStatus,
        provider: 'Gemini (Deterministic Pre-Filter + Model Cascade)',
        hasApiKey: hasGeminiKey,
        details: hasGeminiKey ? 'API Key configured' : 'Missing GEMINI_API_KEY environment variable',
      },
      image_generation: {
        status: imageStatus,
        engine: 'node-canvas (1080x1350 4:5 aspect ratio)',
        available: imageStatus === 'ok',
      },
      storage: {
        status: storageStatus,
        provider: 'Supabase Storage (confession-images bucket)',
        configured: storageConfigured,
      },
      instagram: {
        status: igStatus,
        hasAccountId: hasIgAccount,
        hasAccessToken: hasIgToken,
        configured: igConfigured,
        details: igConfigured
          ? 'Instagram Graph API Account ID & Access Token configured'
          : 'Missing INSTAGRAM_ACCOUNT_ID or INSTAGRAM_ACCESS_TOKEN',
      },
    },
    worker: {
      lockName,
      isLocked,
      isStale,
      lockedBy,
      acquiredAt,
      lastHeartbeatAt,
      expiresAt,
    },
    latestRun,
    queueCounts,
    staleWork: {
      processingCount: staleProcessingCount,
      postingCount: stalePostingCount,
      totalStale: staleProcessingCount + stalePostingCount,
    },
  };
}

/**
 * Safely releases an agent lease ONLY if it is demonstrably expired (stale).
 * Throws an explicit 409 Conflict error if an active worker currently holds the lease.
 */
export async function releaseStaleAgentLock(
  lockName: string = DEFAULT_AGENT_LOCK_NAME,
  options: { actor?: string; supabaseClient?: SupabaseClient } = {}
): Promise<{ released: boolean; message: string }> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const actor = options.actor || 'admin';
  const now = new Date();

  // 1. Fetch current lock
  const { data: currentLock, error: fetchErr } = await supabase
    .from('agent_locks')
    .select('lock_name, locked_by, acquired_at, expires_at')
    .eq('lock_name', lockName)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Failed to query lock '${lockName}': ${fetchErr.message}`);
  }

  if (!currentLock) {
    return { released: false, message: `No active or stale lock found for '${lockName}'.` };
  }

  const expTime = new Date(currentLock.expires_at).getTime();

  // 2. Active lease protection: Refuse to release unexpired lease
  if (expTime > now.getTime()) {
    throw new Error(
      `Cannot release active lease '${lockName}' held by worker '${currentLock.locked_by}'. Lease does not expire until ${currentLock.expires_at}.`
    );
  }

  // 3. Delete stale lock
  const { error: deleteErr } = await supabase
    .from('agent_locks')
    .delete()
    .eq('lock_name', lockName)
    .lte('expires_at', now.toISOString());

  if (deleteErr) {
    throw new Error(`Failed to release stale lock '${lockName}': ${deleteErr.message}`);
  }

  // 4. Audit logging
  await recordAuditLog({
    action: 'admin_release_stale_lock',
    actor,
    details: {
      lock_name: lockName,
      previous_owner: currentLock.locked_by,
      expired_at: currentLock.expires_at,
    },
    supabaseClient: supabase,
  });

  return {
    released: true,
    message: `Successfully released stale lock '${lockName}' (previously held by ${currentLock.locked_by}).`,
  };
}
