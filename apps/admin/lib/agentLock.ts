import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase';

// ---------------------------------------------------------------------------
// Durable Agent Concurrency Lease & Split-Brain Guard (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Guarantees:
//   1. Exactly one agent worker holds the lease at any time
//   2. Heartbeat renewal extends expires_at during active processing
//   3. assertLeaseOwnership() is called before every DB mutation and external call
//      preventing Worker A from publishing if lease expired and Worker B claimed it.
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_LOCK_NAME = 'daily_agent_run';
export const DEFAULT_LEASE_TTL_MINUTES = 10;

export class LeaseLostError extends Error {
  constructor(message: string = 'Agent lost lease ownership — aborting to prevent split-brain execution.') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export interface LockAcquireResult {
  acquired: boolean;
  lockedBy: string;
  expiresAt?: string;
  error?: string;
}

/**
 * Attempts to acquire the durable agent lock.
 * If the lock does not exist, inserts it.
 * If an expired lock exists (expires_at < NOW()), conditionally updates it.
 * If an active lock exists, returns acquired = false.
 */
export async function acquireAgentLock(
  lockName: string = DEFAULT_AGENT_LOCK_NAME,
  runUuid: string,
  ttlMinutes: number = DEFAULT_LEASE_TTL_MINUTES,
  client?: SupabaseClient
): Promise<LockAcquireResult> {
  const supabase = client || getSupabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  // 1. Try to insert a new lock row
  const { data: inserted, error: insertError } = await supabase
    .from('agent_locks')
    .insert({
      lock_name: lockName,
      locked_by: runUuid,
      acquired_at: nowIso,
      last_heartbeat_at: nowIso,
      expires_at: expiresAt,
    })
    .select('locked_by, expires_at')
    .maybeSingle();

  if (!insertError && inserted?.locked_by === runUuid) {
    return { acquired: true, lockedBy: runUuid, expiresAt };
  }

  // 2. Row exists — try conditional update if expired
  const { data: updated, error: updateError } = await supabase
    .from('agent_locks')
    .update({
      locked_by: runUuid,
      acquired_at: nowIso,
      last_heartbeat_at: nowIso,
      expires_at: expiresAt,
    })
    .eq('lock_name', lockName)
    .lt('expires_at', nowIso)
    .select('locked_by, expires_at')
    .maybeSingle();

  if (!updateError && updated?.locked_by === runUuid) {
    return { acquired: true, lockedBy: runUuid, expiresAt };
  }

  // 3. Lock is actively held by someone else
  const { data: currentLock } = await supabase
    .from('agent_locks')
    .select('locked_by, expires_at')
    .eq('lock_name', lockName)
    .maybeSingle();

  return {
    acquired: false,
    lockedBy: currentLock?.locked_by || 'unknown',
    expiresAt: currentLock?.expires_at,
  };
}

/**
 * Extends the lease expires_at timestamp while worker is actively running.
 */
export async function renewAgentLock(
  lockName: string = DEFAULT_AGENT_LOCK_NAME,
  runUuid: string,
  ttlMinutes: number = DEFAULT_LEASE_TTL_MINUTES,
  client?: SupabaseClient
): Promise<boolean> {
  const supabase = client || getSupabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('agent_locks')
    .update({
      last_heartbeat_at: nowIso,
      expires_at: expiresAt,
    })
    .eq('lock_name', lockName)
    .eq('locked_by', runUuid)
    .gt('expires_at', nowIso)
    .select('locked_by')
    .maybeSingle();

  return Boolean(!error && data?.locked_by === runUuid);
}

/**
 * Strictly verifies that the current worker still holds an active, unexpired lease.
 * Throws LeaseLostError if the lease has expired or was usurped by another process.
 */
export async function assertLeaseOwnership(
  lockName: string = DEFAULT_AGENT_LOCK_NAME,
  runUuid: string,
  client?: SupabaseClient
): Promise<void> {
  const supabase = client || getSupabaseAdmin();
  const { data, error } = await supabase
    .from('agent_locks')
    .select('locked_by, expires_at')
    .eq('lock_name', lockName)
    .maybeSingle();

  if (error || !data) {
    throw new LeaseLostError(`Agent lock '${lockName}' record not found or query failed: ${error?.message}`);
  }

  if (data.locked_by !== runUuid) {
    throw new LeaseLostError(
      `Split-brain detected: lock '${lockName}' is owned by '${data.locked_by}' (current worker: '${runUuid}').`
    );
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    throw new LeaseLostError(`Agent lock '${lockName}' expired at ${data.expires_at}.`);
  }
}

/**
 * Releases the agent lock upon successful or clean worker termination.
 */
export async function releaseAgentLock(
  lockName: string = DEFAULT_AGENT_LOCK_NAME,
  runUuid: string,
  client?: SupabaseClient
): Promise<void> {
  const supabase = client || getSupabaseAdmin();

  await supabase
    .from('agent_locks')
    .delete()
    .eq('lock_name', lockName)
    .eq('locked_by', runUuid);
}
