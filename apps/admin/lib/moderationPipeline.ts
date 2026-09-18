import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase';
import { moderateConfession, ModerateOptions } from './ai/moderator';
import { ModerationResult } from './ai/schema';

// ---------------------------------------------------------------------------
// Moderation Pipeline & Database State Machine (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Manages the state transition for confessions through AI moderation:
//   pending ➔ processing ➔ approved / rejected / pending_review / failed
//
// Audit metadata, failure_stage, progress timestamps, and audit_log
// are durably persisted in Supabase using the service-role client.
// ---------------------------------------------------------------------------

export interface ConfessionRecord {
  id: number;
  text: string;
  normalized_text: string;
  content_hash: string;
  status: string;
  attempt_count: number;
  created_at: string;
}

export interface PipelineModerationOptions extends ModerateOptions {
  supabaseClient?: SupabaseClient;
}

export interface ProcessConfessionResult {
  confessionId: number;
  previousStatus: string;
  newStatus: string;
  moderationResult: ModerationResult;
  success: boolean;
  error?: string;
}

/**
 * Claims and processes a single confession through the AI moderation pipeline.
 * Transitions state: pending ➔ processing ➔ approved/rejected/pending_review/failed.
 */
export async function processConfessionModeration(
  confession: ConfessionRecord,
  options: PipelineModerationOptions = {}
): Promise<ProcessConfessionResult> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const now = new Date().toISOString();

  // ── 1. Transition: pending ➔ processing ──
  const { error: claimError } = await supabase
    .from('confessions')
    .update({
      status: 'processing',
      processing_started_at: now,
      last_progress_at: now,
      attempt_count: (confession.attempt_count || 0) + 1,
      updated_at: now,
    })
    .eq('id', confession.id)
    .eq('status', 'pending');

  if (claimError) {
    console.error(`[PIPELINE] Failed to claim confession #${confession.id}:`, claimError.message);
    throw new Error(`Failed to claim confession: ${claimError.message}`);
  }

  // ── 2. Run Moderation ──
  let moderationResult: ModerationResult;
  try {
    moderationResult = await moderateConfession(confession.text, options);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[PIPELINE] Unexpected error in moderation for #${confession.id}:`, errorMsg);

    // Persist failure with failure_stage = 'moderation'
    await supabase
      .from('confessions')
      .update({
        status: 'pending_review', // Route to human review instead of losing confession
        failure_stage: 'moderation',
        last_error: errorMsg,
        last_progress_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    // Audit log failure
    await supabase.from('audit_log').insert({
      confession_id: confession.id,
      action: 'ai_moderation_error',
      actor: 'ai_agent',
      previous_status: 'processing',
      new_status: 'pending_review',
      details: { error: errorMsg, failure_stage: 'moderation' },
    });

    return {
      confessionId: confession.id,
      previousStatus: 'processing',
      newStatus: 'pending_review',
      moderationResult: {
        verdict: 'pending_review',
        decision_reason: `Moderation pipeline error: ${errorMsg}`,
        model_confidence: 0,
        matched_rules: ['SYS_PIPELINE_ERROR'],
        policy_level: 5,
        flags: ['pipeline_error'],
        model_id: 'pipeline_error',
        model_version: 'none',
        ai_policy_version: 1,
        instruction_version: 1,
        prompt_hash: 'none',
        generation_config: {},
        fallback_used: true,
        deterministic_filter_used: false,
      },
      success: false,
      error: errorMsg,
    };
  }

  // ── 3. Transition: processing ➔ approved / rejected / pending_review ──
  const finishTime = new Date().toISOString();
  const targetStatus = moderationResult.verdict;

  const { error: updateError } = await supabase
    .from('confessions')
    .update({
      status: targetStatus,
      ai_verdict: moderationResult.verdict,
      decision_reason: moderationResult.decision_reason,
      model_confidence: moderationResult.model_confidence,
      matched_rules: moderationResult.matched_rules,
      policy_level: moderationResult.policy_level,
      flags: moderationResult.flags,
      model_id: moderationResult.model_id,
      model_version: moderationResult.model_version,
      ai_policy_version: moderationResult.ai_policy_version,
      instruction_version: moderationResult.instruction_version,
      prompt_hash: moderationResult.prompt_hash,
      generation_config: moderationResult.generation_config,
      fallback_used: moderationResult.fallback_used,
      last_progress_at: finishTime,
      updated_at: finishTime,
      failure_stage: targetStatus === 'pending_review' ? 'moderation' : null,
    })
    .eq('id', confession.id);

  if (updateError) {
    console.error(`[PIPELINE] Failed to persist verdict for #${confession.id}:`, updateError.message);
    throw new Error(`Failed to update confession verdict: ${updateError.message}`);
  }

  // ── 4. Audit Log Entry ──
  await supabase.from('audit_log').insert({
    confession_id: confession.id,
    action: 'ai_moderation',
    actor: 'ai_agent',
    previous_status: 'processing',
    new_status: targetStatus,
    details: {
      model_id: moderationResult.model_id,
      verdict: moderationResult.verdict,
      decision_reason: moderationResult.decision_reason,
      model_confidence: moderationResult.model_confidence,
      matched_rules: moderationResult.matched_rules,
      policy_level: moderationResult.policy_level,
      fallback_used: moderationResult.fallback_used,
      deterministic_filter_used: moderationResult.deterministic_filter_used,
    },
  });

  return {
    confessionId: confession.id,
    previousStatus: 'processing',
    newStatus: targetStatus,
    moderationResult,
    success: true,
  };
}

/**
 * Fetches batch of pending confessions eligible for AI moderation (FIFO oldest first).
 */
export async function getEligiblePendingConfessions(
  limit: number = 50,
  supabaseClient?: SupabaseClient
): Promise<ConfessionRecord[]> {
  const supabase = supabaseClient || getSupabaseAdmin();

  const { data, error } = await supabase
    .from('confessions')
    .select('id, text, normalized_text, content_hash, status, attempt_count, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true }) // FIFO: oldest first
    .limit(limit);

  if (error) {
    console.error('[PIPELINE] Failed to query pending confessions:', error.message);
    throw new Error(`Failed to query pending confessions: ${error.message}`);
  }

  return (data || []) as ConfessionRecord[];
}
