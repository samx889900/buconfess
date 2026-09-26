import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '../../../../../lib/auth';
import { getSupabaseAdmin } from '../../../../../lib/supabase';
import { getAdminConfessionById } from '../../../../../lib/confessions';
import { processConfessionModeration } from '../../../../../lib/moderationPipeline';
import { recordAuditLog } from '../../../../../lib/audit';

// ---------------------------------------------------------------------------
// Past Confession Recheck Endpoint (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Safety Invariants:
//   1. If status = 'posted' OR ig_post_id IS NOT NULL, recheck MUST be blocked.
//   2. Recheck NEVER calls Instagram directly or dispatches posts.
//   3. Flow: old confession -> AI moderation -> approved -> normal publication queue.
//   4. Never allocates a new confession number to an already-numbered confession.
//   5. Supports multi-select batch recheck via `{ ids: number[] }`.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const isAdmin = await getAdminFromRequest(req);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  const rawIds = Array.isArray(body.ids)
    ? body.ids
    : typeof body.id === 'number'
    ? [body.id]
    : [];

  const ids = rawIds
    .map((x: any) => parseInt(String(x), 10))
    .filter((n: number) => !isNaN(n) && n > 0);

  if (ids.length === 0) {
    return NextResponse.json(
      { error: 'No valid confession IDs provided. Specify "ids" array or "id" number.' },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const results: Array<{
    id: number;
    success: boolean;
    previousStatus?: string;
    newStatus?: string;
    aiVerdict?: string;
    blockedReason?: string;
    error?: string;
  }> = [];

  let approvedCount = 0;
  let rejectedCount = 0;
  let pendingReviewCount = 0;
  let blockedCount = 0;
  let errorCount = 0;

  for (const id of ids) {
    try {
      const confession = await getAdminConfessionById(id, { supabaseClient: supabase });
      if (!confession) {
        results.push({
          id,
          success: false,
          error: `Confession #${id} not found`,
        });
        errorCount++;
        continue;
      }

      // ── CRITICAL SAFETY INVARIANT 1 ──
      // If already posted or has Instagram post ID, recheck is strictly forbidden!
      if (confession.status === 'posted' || confession.ig_post_id != null) {
        console.warn(`[RECHECK_BLOCKED] Confession #${id} has already been posted to Instagram (status: ${confession.status}, ig_post_id: ${confession.ig_post_id}). Recheck rejected.`);
        results.push({
          id,
          success: false,
          previousStatus: confession.status,
          blockedReason: `Confession #${id} is already posted on Instagram (ig_post_id: ${confession.ig_post_id || 'present'}). Recheck prohibited.`,
        });
        blockedCount++;
        continue;
      }

      // Only confessions in pending, pending_review, rejected, or failed may be rechecked
      const recheckableStatuses = ['pending', 'pending_review', 'rejected', 'failed', 'approved'];
      if (!recheckableStatuses.includes(confession.status)) {
        results.push({
          id,
          success: false,
          previousStatus: confession.status,
          blockedReason: `Cannot recheck confession #${id} with status "${confession.status}".`,
        });
        blockedCount++;
        continue;
      }

      // Execute AI moderation (respects allowlisted cascade & bounded retries)
      const previousStatus = confession.status;
      const modResult = await processConfessionModeration(confession, { supabaseClient: supabase });

      if (modResult.newStatus === 'approved') approvedCount++;
      else if (modResult.newStatus === 'rejected') rejectedCount++;
      else if (modResult.newStatus === 'pending_review') pendingReviewCount++;

      // Audit trail
      try {
        await recordAuditLog({
          confessionId: id,
          action: 'admin_recheck_confession',
          actor: 'admin',
          previousStatus: previousStatus,
          newStatus: modResult.newStatus,
          details: {
            ai_verdict: modResult.moderationResult?.verdict,
            decision_reason: modResult.moderationResult?.decision_reason,
            model_id: modResult.moderationResult?.model_id,
            recheck: true,
          },
        });
      } catch (auditErr) {
        console.warn(`[AUDIT] Recheck audit error for #${id}:`, auditErr);
      }

      results.push({
        id,
        success: true,
        previousStatus,
        newStatus: modResult.newStatus,
        aiVerdict: modResult.moderationResult?.verdict,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[RECHECK] Error rechecking confession #${id}:`, errorMsg);
      results.push({
        id,
        success: false,
        error: errorMsg,
      });
      errorCount++;
    }
  }

  return NextResponse.json({
    success: errorCount === 0 && blockedCount === 0,
    totalRequested: ids.length,
    processed: results.length,
    approved: approvedCount,
    rejected: rejectedCount,
    pendingReview: pendingReviewCount,
    blocked: blockedCount,
    errors: errorCount,
    results,
  });
}
