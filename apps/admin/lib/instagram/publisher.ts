import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { getSecrets } from '../secrets';
import {
  createChildContainer,
  createCarouselContainer,
  createSingleContainer,
  pollContainerStatus,
  publishMedia,
  verifyMedia,
  getRecentMedia,
} from './client';
import { performTokenPreflight } from './tokenManager';
import {
  buildInstagramCaption,
  generateCorrelationToken,
  matchesCorrelationToken,
} from './idempotency';
import { validateInstagramImageUrls } from './validation';
import { inspectPublicationRecovery } from './recovery';
import { assertLeaseOwnership, DEFAULT_AGENT_LOCK_NAME } from '../agentLock';
import { PublishOptions, PublishResult } from './types';
import { redactSecrets } from '../redact';
import { RECOVERY_CONFIG } from './config';

// ---------------------------------------------------------------------------
// Instagram Publication Orchestrator (BU Confessions v3.4 — Phase E)
// ---------------------------------------------------------------------------
// Invariants enforced:
//   1. Lease ownership asserted before every mutation & external API call
//   2. Pre-API persistence in instagram_publish_attempts BEFORE Instagram calls
//   3. Immediate persistence of child and parent container IDs (zero batching)
//   4. Ambiguous publish transport failures trigger deferred recheck recovery
//   5. posted = publication verified on Instagram (cannot be bypassed)
// ---------------------------------------------------------------------------

export interface ConfessionPublishInput {
  id: number;
  text: string;
  number?: number | null;
  status: string;
  parts?: string[] | null;
  image_urls?: string[] | null;
  publish_attempt_id?: string | null;
  correlation_token?: string | null;
  attempt_count?: number;
}

export async function publishConfessionToInstagram(
  confession: ConfessionPublishInput,
  options: PublishOptions = {}
): Promise<PublishResult> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const runUuid = options.runUuid || 'agent_runner';
  const isDryRun = Boolean(options.dryRun);

  // 1. Lease assertion (split-brain guard)
  if (!options.skipLeaseCheck && !isDryRun) {
    await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);
  }

  const secrets = getSecrets();
  const igUserId = secrets.instagramUserId;

  // 2. Dry run handling — zero DB mutations, zero Instagram POST requests
  if (isDryRun) {
    console.log(`[INSTAGRAM PUBLISHER (DRY RUN)] Simulating publication for confession #${confession.id}...`);
    const urls = confession.image_urls || [];
    const validation = validateInstagramImageUrls(urls.length > 0 ? urls : ['https://example.com/dry_run.png']);
    if (!validation.valid) {
      return {
        success: false,
        confessionId: confession.id,
        dryRun: true,
        error: validation.error,
        failureStage: 'instagram_container',
      };
    }

    const mockToken = generateCorrelationToken();
    const mockCaption = buildInstagramCaption(confession.text, confession.number || 1, mockToken);

    return {
      success: true,
      confessionId: confession.id,
      confessionNumber: confession.number || 1,
      igPostId: 'dry_run_post_1234567890',
      igPermalink: 'https://www.instagram.com/p/dry_run_preview/',
      containerId: 'dry_run_container_9999',
      childContainerIds: urls.length > 1 ? urls.map((_, i) => `dry_run_child_${i}`) : undefined,
      dryRun: true,
    };
  }

  // 3. Token preflight & resolution
  const preflight = await performTokenPreflight({
    supabaseClient: supabase,
    fetchFn: options.fetchFn,
  });

  if (!preflight.isValid) {
    const errorMsg = preflight.error || 'Instagram access token is invalid or expired.';
    await supabase
      .from('confessions')
      .update({
        status: 'failed',
        failure_stage: 'instagram_token',
        last_error: errorMsg,
        last_progress_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      success: false,
      confessionId: confession.id,
      failureStage: 'instagram_token',
      error: errorMsg,
    };
  }

  const accessToken = preflight.activeToken;

  // 4. Image URL validation
  const imageUrls = confession.image_urls || [];
  const urlValidation = validateInstagramImageUrls(imageUrls);
  if (!urlValidation.valid) {
    const errorMsg = urlValidation.error || 'Invalid confession image URLs.';
    await supabase
      .from('confessions')
      .update({
        status: 'failed',
        failure_stage: 'instagram_container',
        last_error: errorMsg,
        last_progress_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      success: false,
      confessionId: confession.id,
      failureStage: 'instagram_container',
      error: errorMsg,
    };
  }

  // 5. Recovery check
  const recovery = await inspectPublicationRecovery(confession.id, igUserId, accessToken, {
    supabaseClient: supabase,
    fetchFn: options.fetchFn,
  });

  // Stage D recovered: Post already published on Instagram prior to crash
  if (recovery.stage === 'already_published' && recovery.recoveredPostId) {
    console.log(`[INSTAGRAM PUBLISHER] Recovered existing post #${recovery.recoveredPostId} for confession #${confession.id}.`);
    
    // Verify recovered media
    const verified = await verifyMedia(recovery.recoveredPostId, accessToken, { fetchFn: options.fetchFn });

    const now = new Date().toISOString();
    await supabase
      .from('confessions')
      .update({
        status: 'posted',
        posted_at: now,
        ig_post_id: verified.id,
        ig_permalink: verified.permalink,
        instagram_publish_status: 'published',
        failure_stage: null,
        last_progress_at: now,
      })
      .eq('id', confession.id);

    await supabase
      .from('instagram_publish_attempts')
      .update({ response_status: 'published', recovered: true })
      .eq('confession_id', confession.id)
      .eq('response_status', 'publishing');

    return {
      success: true,
      confessionId: confession.id,
      confessionNumber: confession.number,
      igPostId: verified.id,
      igPermalink: verified.permalink,
      recovered: true,
    };
  }

  // Deferred recheck: Ambiguous failure awaiting secondary inspection
  if (recovery.stage === 'deferred_recheck') {
    return {
      success: false,
      confessionId: confession.id,
      deferred: true,
      error: recovery.reason,
      failureStage: 'instagram_publish',
    };
  }

  // Anomaly: Multiple posts match token
  if (recovery.stage === 'anomaly') {
    await supabase
      .from('confessions')
      .update({
        status: 'failed',
        failure_stage: 'instagram_publish',
        last_error: recovery.reason,
        last_progress_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      success: false,
      confessionId: confession.id,
      error: recovery.reason,
      failureStage: 'instagram_publish',
    };
  }

  // 6. Pre-API attempt persistence & atomic transition: approved ➔ posting
  if (!options.skipLeaseCheck) {
    await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);
  }

  const publishAttemptId = confession.publish_attempt_id || crypto.randomUUID();
  const correlationToken = confession.correlation_token || generateCorrelationToken();
  const attemptNumber = (confession.attempt_count || 0) + 1;
  const now = new Date().toISOString();

  // Insert into instagram_publish_attempts BEFORE any external call
  const { error: attemptInsertError } = await supabase.from('instagram_publish_attempts').insert({
    publish_attempt_id: publishAttemptId,
    confession_id: confession.id,
    attempt_number: attemptNumber,
    correlation_token: correlationToken,
    publish_attempted_at: now,
    response_status: 'initiated',
    recovered: false,
  });

  if (attemptInsertError) {
    throw new Error(`Failed to persist publish attempt: ${attemptInsertError.message}`);
  }

  // Update confession status: approved ➔ posting
  await supabase
    .from('confessions')
    .update({
      status: 'posting',
      publish_attempt_id: publishAttemptId,
      correlation_token: correlationToken,
      instagram_publish_attempted_at: now,
      instagram_publish_status: 'publishing',
      attempt_count: attemptNumber,
      last_progress_at: now,
    })
    .eq('id', confession.id);

  const caption = buildInstagramCaption(confession.text, confession.number || null, correlationToken);

  let targetPublishContainerId: string;
  let childIds: string[] = [];

  try {
    // 7. Container Creation (Single image vs Carousel)
    if (imageUrls.length === 1) {
      // Single Image Flow
      if (recovery.existingParentId) {
        targetPublishContainerId = recovery.existingParentId;
      } else {
        if (!options.skipLeaseCheck) await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);
        
        targetPublishContainerId = await createSingleContainer(
          igUserId,
          accessToken,
          imageUrls[0],
          caption,
          { fetchFn: options.fetchFn }
        );

        // Immediate persistence of container ID
        await supabase
          .from('confessions')
          .update({
            instagram_container_id: targetPublishContainerId,
            instagram_publish_status: 'container_created',
            last_progress_at: new Date().toISOString(),
          })
          .eq('id', confession.id);

        await supabase
          .from('instagram_publish_attempts')
          .update({ container_id: targetPublishContainerId })
          .eq('publish_attempt_id', publishAttemptId);

        // Poll until FINISHED
        await pollContainerStatus(targetPublishContainerId, accessToken, {
          fetchFn: options.fetchFn,
          timeoutMs: options.pollTimeoutMs,
          intervalMs: options.pollIntervalMs,
          onProgress: async () => {
            await supabase
              .from('confessions')
              .update({ last_progress_at: new Date().toISOString() })
              .eq('id', confession.id);
          },
        });
      }
    } else {
      // Carousel Flow (>= 2 images)
      if (recovery.existingParentId) {
        targetPublishContainerId = recovery.existingParentId;
      } else {
        // Reuse recovered child container IDs if available
        childIds = recovery.existingChildIds || [];

        // Create any missing child containers
        for (let i = childIds.length; i < imageUrls.length; i++) {
          if (!options.skipLeaseCheck) await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);

          const childId = await createChildContainer(igUserId, accessToken, imageUrls[i], {
            fetchFn: options.fetchFn,
          });

          childIds.push(childId);

          // Immediate persistence of child IDs after EACH API call
          await supabase
            .from('confessions')
            .update({
              instagram_child_container_ids: childIds,
              last_progress_at: new Date().toISOString(),
            })
            .eq('id', confession.id);

          await supabase
            .from('instagram_publish_attempts')
            .update({ child_container_ids: childIds })
            .eq('publish_attempt_id', publishAttemptId);
        }

        // Wait for all children to reach FINISHED
        for (const childId of childIds) {
          await pollContainerStatus(childId, accessToken, {
            fetchFn: options.fetchFn,
            timeoutMs: options.pollTimeoutMs,
            intervalMs: options.pollIntervalMs,
          });
        }

        // Create Parent Carousel Container
        if (!options.skipLeaseCheck) await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);

        targetPublishContainerId = await createCarouselContainer(
          igUserId,
          accessToken,
          childIds,
          caption,
          { fetchFn: options.fetchFn }
        );

        // Immediate persistence of parent container ID
        await supabase
          .from('confessions')
          .update({
            instagram_container_id: targetPublishContainerId,
            instagram_publish_status: 'container_created',
            last_progress_at: new Date().toISOString(),
          })
          .eq('id', confession.id);

        await supabase
          .from('instagram_publish_attempts')
          .update({ container_id: targetPublishContainerId })
          .eq('publish_attempt_id', publishAttemptId);

        // Poll parent container until FINISHED
        await pollContainerStatus(targetPublishContainerId, accessToken, {
          fetchFn: options.fetchFn,
          timeoutMs: options.pollTimeoutMs,
          intervalMs: options.pollIntervalMs,
          onProgress: async () => {
            await supabase
              .from('confessions')
              .update({ last_progress_at: new Date().toISOString() })
              .eq('id', confession.id);
          },
        });
      }
    }
  } catch (containerErr: unknown) {
    const errorMsg = containerErr instanceof Error ? containerErr.message : String(containerErr);
    console.error(redactSecrets(`[INSTAGRAM PUBLISHER] Container error for #${confession.id}: ${errorMsg}`));

    await supabase
      .from('confessions')
      .update({
        status: 'failed',
        failure_stage: 'instagram_container',
        last_error: redactSecrets(errorMsg),
        last_progress_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    await supabase
      .from('instagram_publish_attempts')
      .update({ error_message: redactSecrets(errorMsg), response_status: 'failed' })
      .eq('publish_attempt_id', publishAttemptId);

    return {
      success: false,
      confessionId: confession.id,
      failureStage: 'instagram_container',
      error: redactSecrets(errorMsg),
    };
  }

  // 8. Publish Dispatch & Ambiguous Transport Recovery
  let publishedMediaId: string | null = null;
  let isRecoveredAfterAmbiguousDrop = false;

  try {
    if (!options.skipLeaseCheck) await assertLeaseOwnership(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);

    await supabase
      .from('instagram_publish_attempts')
      .update({ response_status: 'publishing' })
      .eq('publish_attempt_id', publishAttemptId);

    const publishRes = await publishMedia(igUserId, accessToken, targetPublishContainerId, {
      fetchFn: options.fetchFn,
      maxRetries: 0, // NEVER blindly retry media_publish on network timeout!
    });

    publishedMediaId = publishRes.id;
  } catch (publishErr: unknown) {
    const errorMsg = publishErr instanceof Error ? publishErr.message : String(publishErr);
    console.warn(
      redactSecrets(
        `[INSTAGRAM PUBLISHER] Ambiguous publish failure on #${confession.id}: ${errorMsg}. Entering ambiguous recovery protocol...`
      )
    );

    // Record ambiguous failure in attempt record
    await supabase
      .from('instagram_publish_attempts')
      .update({ response_status: 'ambiguous_failure', error_message: redactSecrets(errorMsg) })
      .eq('publish_attempt_id', publishAttemptId);

    // Check recent media before deciding to republish
    try {
      const recentPosts = await getRecentMedia(
        igUserId,
        accessToken,
        RECOVERY_CONFIG.recentMediaLimit,
        { fetchFn: options.fetchFn }
      );

      const matching = recentPosts.filter((p) => matchesCorrelationToken(p.caption, correlationToken));

      if (matching.length === 1) {
        console.log(`[INSTAGRAM PUBLISHER] Found published post #${matching[0].id} despite publish transport drop!`);
        publishedMediaId = matching[0].id;
        isRecoveredAfterAmbiguousDrop = true;
      } else {
        // Zero matches or multiple matches: DEFER RECHECK to prevent duplicate publish
        const deferUntil = new Date(
          Date.now() + RECOVERY_CONFIG.ambiguousRecheckDelayMinutes * 60 * 1000
        ).toISOString();

        await supabase
          .from('confessions')
          .update({
            status: 'posting',
            instagram_publish_status: 'awaiting_recheck',
            failure_stage: 'instagram_publish',
            last_error: redactSecrets(`Ambiguous publish transport error: ${errorMsg}. Deferred recheck scheduled.`),
            next_retry_at: deferUntil,
            last_progress_at: new Date().toISOString(),
          })
          .eq('id', confession.id);

        return {
          success: false,
          confessionId: confession.id,
          deferred: true,
          error: redactSecrets(`Ambiguous transport error: ${errorMsg}. Scheduled deferred recheck.`),
          failureStage: 'instagram_publish',
        };
      }
    } catch {
      // If querying recent media also failed, defer recheck safely
      await supabase
        .from('confessions')
        .update({
          status: 'posting',
          instagram_publish_status: 'awaiting_recheck',
          failure_stage: 'instagram_publish',
          last_error: redactSecrets(`Publish failed ambiguously: ${errorMsg}`),
          last_progress_at: new Date().toISOString(),
        })
        .eq('id', confession.id);

      return {
        success: false,
        confessionId: confession.id,
        deferred: true,
        error: redactSecrets(errorMsg),
        failureStage: 'instagram_publish',
      };
    }
  }

  // 9. Mandatory Verification Step
  if (!publishedMediaId) {
    await supabase
      .from('confessions')
      .update({
        status: 'failed',
        failure_stage: 'instagram_publish',
        last_error: 'No media ID obtained from Instagram publish.',
        last_progress_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      success: false,
      confessionId: confession.id,
      failureStage: 'instagram_publish',
      error: 'No media ID obtained from Instagram publish.',
    };
  }

  try {
    const verified = await verifyMedia(publishedMediaId, accessToken, { fetchFn: options.fetchFn });

    // 10. Final Transition: posted
    const completedAt = new Date().toISOString();
    await supabase
      .from('confessions')
      .update({
        status: 'posted',
        posted_at: completedAt,
        ig_post_id: verified.id,
        ig_permalink: verified.permalink,
        instagram_publish_status: 'published',
        failure_stage: null,
        last_progress_at: completedAt,
      })
      .eq('id', confession.id);

    await supabase
      .from('instagram_publish_attempts')
      .update({ response_status: 'published', recovered: isRecoveredAfterAmbiguousDrop })
      .eq('publish_attempt_id', publishAttemptId);

    // Audit log entry
    await supabase.from('audit_log').insert({
      confession_id: confession.id,
      action: 'instagram_publish',
      actor: 'instagram_publisher',
      previous_status: 'posting',
      new_status: 'posted',
      details: {
        ig_post_id: verified.id,
        ig_permalink: verified.permalink,
        publish_attempt_id: publishAttemptId,
        correlation_token: correlationToken,
      },
    });

    return {
      success: true,
      confessionId: confession.id,
      confessionNumber: confession.number,
      igPostId: verified.id,
      igPermalink: verified.permalink,
      containerId: targetPublishContainerId,
      childContainerIds: childIds.length > 0 ? childIds : undefined,
      recovered: isRecoveredAfterAmbiguousDrop,
    };
  } catch (verifyErr: unknown) {
    const errorMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    console.error(redactSecrets(`[INSTAGRAM PUBLISHER] Verification error for #${confession.id}: ${errorMsg}`));

    await supabase
      .from('confessions')
      .update({
        status: 'failed',
        failure_stage: 'instagram_verification',
        last_error: redactSecrets(errorMsg),
        last_progress_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      success: false,
      confessionId: confession.id,
      failureStage: 'instagram_verification',
      error: redactSecrets(errorMsg),
    };
  }
}
