import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { getRecentMedia, pollContainerStatus } from './client';
import { matchesCorrelationToken } from './idempotency';
import { RECOVERY_CONFIG } from './config';
import { RecoveryCheckResult } from './types';
import { redactSecrets } from '../redact';

// ---------------------------------------------------------------------------
// Instagram Publication Recovery Engine (BU Confessions v3.4 — Phase E)
// ---------------------------------------------------------------------------
// Evaluates in-flight or interrupted publication attempts and determines:
//   1. Did an ambiguous media_publish request actually succeed on Instagram?
//   2. Can an existing FINISHED parent or child container be reused?
//   3. Does an ambiguous failure need a deferred recheck to prevent duplicate posting?
// ---------------------------------------------------------------------------

export interface RecoveryOptions {
  supabaseClient?: SupabaseClient;
  fetchFn?: typeof fetch;
  /** Force immediate re-evaluation without deferral in test suites */
  skipDeferral?: boolean;
}

/**
 * Inspects a confession's previous publication attempt and container state
 * to safely resume or recover without creating duplicate Instagram posts.
 */
export async function inspectPublicationRecovery(
  confessionId: number,
  igUserId: string,
  accessToken: string,
  options: RecoveryOptions = {}
): Promise<RecoveryCheckResult> {
  const supabase = options.supabaseClient || getSupabaseAdmin();

  // 1. Fetch the latest publish attempt record
  const { data: attempt, error: attemptError } = await supabase
    .from('instagram_publish_attempts')
    .select('*')
    .eq('confession_id', confessionId)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (attemptError || !attempt) {
    return { canRecover: false, stage: 'none', reason: 'No prior publish attempt found.' };
  }

  const correlationToken = attempt.correlation_token;

  // 2. Stage D Check: Inspect recent media on Instagram account for correlation token
  if (correlationToken) {
    try {
      const recentPosts = await getRecentMedia(
        igUserId,
        accessToken,
        RECOVERY_CONFIG.recentMediaLimit,
        { fetchFn: options.fetchFn }
      );

      const matchingPosts = recentPosts.filter((post) =>
        matchesCorrelationToken(post.caption, correlationToken)
      );

      if (matchingPosts.length === 1) {
        const post = matchingPosts[0];
        console.log(
          redactSecrets(
            `[RECOVERY] Discovered existing post #${post.id} matching token ${correlationToken}. Recovering post ID without republishing!`
          )
        );

        return {
          canRecover: true,
          stage: 'already_published',
          recoveredPostId: post.id,
          recoveredPermalink: post.permalink,
          reason: 'Post was already published to Instagram prior to crash.',
        };
      }

      if (matchingPosts.length > 1) {
        const errorMsg = redactSecrets(
          `[RECOVERY ANOMALY] Found ${matchingPosts.length} posts matching correlation token ${correlationToken}! Halting publish to prevent further duplicates.`
        );
        console.error(errorMsg);
        return {
          canRecover: false,
          stage: 'anomaly',
          reason: 'Multiple posts match the correlation token. Manual administrative review required.',
        };
      }

      // 3. 0 matching posts found:
      // If the attempt previously failed with an ambiguous transport error, check deferral contract!
      if (
        (attempt.response_status === 'ambiguous_failure' || attempt.response_status === 'publishing') &&
        !options.skipDeferral
      ) {
        // Query confession's current status and retry time
        const { data: confRow } = await supabase
          .from('confessions')
          .select('instagram_publish_status, next_retry_at')
          .eq('id', confessionId)
          .single();

        const isAlreadyDeferred = confRow?.instagram_publish_status === 'awaiting_recheck';
        const nextRetryAt = confRow?.next_retry_at ? new Date(confRow.next_retry_at).getTime() : 0;
        const now = Date.now();

        // If not yet deferred, or if deferral delay hasn't expired yet:
        if (!isAlreadyDeferred || now < nextRetryAt) {
          const deferUntil = new Date(now + RECOVERY_CONFIG.ambiguousRecheckDelayMinutes * 60 * 1000).toISOString();

          // Mark deferred in DB
          await supabase
            .from('confessions')
            .update({
              status: 'posting',
              instagram_publish_status: 'awaiting_recheck',
              failure_stage: 'instagram_publish',
              last_error:
                'Ambiguous media_publish transport failure. Deferred recheck scheduled to ensure Instagram has time to index post without duplicate publishing.',
              next_retry_at: deferUntil,
              last_progress_at: new Date().toISOString(),
            })
            .eq('id', confessionId);

          await supabase
            .from('instagram_publish_attempts')
            .update({ response_status: 'awaiting_recheck' })
            .eq('publish_attempt_id', attempt.publish_attempt_id);

          return {
            canRecover: false,
            stage: 'deferred_recheck',
            reason:
              'Ambiguous media_publish response; deferred for secondary recheck to prevent duplicate posting.',
          };
        }
      }
    } catch (err) {
      console.warn(
        redactSecrets(
          `[RECOVERY] Failed to query recent Instagram media: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  }

  // 4. Stage C Check: Check if parent container was already created and is FINISHED
  if (attempt.container_id) {
    try {
      const containerStatus = await pollContainerStatus(attempt.container_id, accessToken, {
        timeoutMs: 5000,
        intervalMs: 1000,
        fetchFn: options.fetchFn,
      });

      if (containerStatus.statusCode === 'FINISHED') {
        return {
          canRecover: true,
          stage: 'parent_container',
          existingParentId: attempt.container_id,
          reason: 'Parent container exists and is in FINISHED state.',
        };
      }
    } catch {
      // Container may have expired or failed; fallback to checking children
    }
  }

  // 5. Stage B Check: Check if child containers exist and are valid
  const rawChildren = attempt.child_container_ids;
  const childIds: string[] = Array.isArray(rawChildren)
    ? (rawChildren as string[])
    : typeof rawChildren === 'string'
    ? JSON.parse(rawChildren)
    : [];

  if (childIds.length > 0) {
    return {
      canRecover: true,
      stage: 'child_containers',
      existingChildIds: childIds,
      reason: `${childIds.length} child container(s) found from previous attempt.`,
    };
  }

  return { canRecover: false, stage: 'none', reason: 'No reusable state found.' };
}
