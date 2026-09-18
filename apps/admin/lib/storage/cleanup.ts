import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { BUCKET_NAME, deleteConfessionImages } from './storageService';

// ---------------------------------------------------------------------------
// Storage Retention & Cleanup Service (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Enforces 7-day image retention policy and emergency storage threshold cleanup.
// CRITICAL SAFETY GUARANTEE:
//   Never deletes images belonging to:
//     - approved confessions waiting to post
//     - posting confessions (active publication in flight)
//     - processing / pending confessions
//     - recoverable failed confessions
// ---------------------------------------------------------------------------

export const RETENTION_DAYS = 30;
export const STORAGE_WARNING_THRESHOLD_PERCENT = 70;
export const STORAGE_CRITICAL_THRESHOLD_PERCENT = 90;

export interface CleanupReport {
  confessionsExamined: number;
  confessionsCleaned: number;
  protectedSkipped: number;
  cleanedConfessionIds: number[];
  emergencyMode: boolean;
}

/**
 * Checks if a confession status is protected against image deletion.
 */
export function isConfessionProtected(status: string): boolean {
  const protectedStatuses = new Set([
    'approved',
    'posting',
    'processing',
    'pending',
    'pending_review',
    'failed', // Retain for recovery/debugging
  ]);

  return protectedStatuses.has(status);
}

/**
 * Executes retention cleanup. Only deletes images from posted confessions
 * whose posted_at is older than RETENTION_DAYS (or emergency threshold).
 */
export async function runStorageRetentionCleanup(
  options: {
    supabaseClient?: SupabaseClient;
    retentionDays?: number;
    emergencyCleanup?: boolean;
    batchLimit?: number;
  } = {}
): Promise<CleanupReport> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const retentionDays = options.retentionDays ?? RETENTION_DAYS;
  const isEmergency = options.emergencyCleanup ?? false;
  const batchLimit = options.batchLimit ?? 50;

  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Query posted confessions older than retention cutoff (or oldest posted in emergency)
  let query = supabase
    .from('confessions')
    .select('id, status, posted_at, image_urls')
    .eq('status', 'posted')
    .not('image_urls', 'is', null)
    .order('posted_at', { ascending: true })
    .limit(batchLimit);

  if (!isEmergency) {
    query = query.lt('posted_at', cutoffDate);
  }

  const { data: eligible, error } = await query;
  if (error) {
    console.error('[CLEANUP] Failed to query cleanup candidates:', error.message);
    throw new Error(`Cleanup query failed: ${error.message}`);
  }

  const candidates = eligible || [];
  let confessionsCleaned = 0;
  let protectedSkipped = 0;
  const cleanedConfessionIds: number[] = [];

  for (const item of candidates) {
    // Extra safety guard against deleting protected states
    if (isConfessionProtected(item.status)) {
      protectedSkipped++;
      continue;
    }

    try {
      await deleteConfessionImages(supabase, item.id);

      // Clear image_urls in DB to mark assets purged
      await supabase
        .from('confessions')
        .update({
          image_urls: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      confessionsCleaned++;
      cleanedConfessionIds.push(item.id);
    } catch (cleanErr) {
      console.error(`[CLEANUP] Failed to clean images for confession #${item.id}:`, cleanErr);
    }
  }

  // Audit log the cleanup run
  if (confessionsCleaned > 0) {
    await supabase.from('audit_log').insert({
      action: 'storage_cleanup',
      actor: 'system',
      details: {
        cleaned_count: confessionsCleaned,
        retention_days: retentionDays,
        emergency_mode: isEmergency,
        cleaned_ids: cleanedConfessionIds,
      },
    });
  }

  return {
    confessionsExamined: candidates.length,
    confessionsCleaned,
    protectedSkipped,
    cleanedConfessionIds,
    emergencyMode: isEmergency,
  };
}
