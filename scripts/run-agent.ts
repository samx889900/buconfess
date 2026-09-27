#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// run-agent.ts — BU Confessions v3.4 Daily Agent Runner
// ---------------------------------------------------------------------------
// Main scheduled agent executing:
//   1. Preflight token validation & lease acquisition (agent_locks)
//   2. Background heartbeat timer (renew lease every 2 minutes)
//   3. 25-minute runtime budget guard
//   4. Phase C: AI Moderation Pipeline (Gemini 3.8 -> 3.7 -> 3.6 -> pending_review)
//   5. Phase D: Canvas Image Generation & Supabase Storage
//   6. Phase E: Instagram Publication, Idempotency & Recovery
//   7. True side-effect-free dry-run mode generating dry-run-report.json
//   8. Clean lease release and audit recording
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';

// Load apps/admin/.env if running locally from root
try {
  const envPath = path.join(process.cwd(), 'apps', 'admin', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        const val = v.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

import { SupabaseClient } from '@supabase/supabase-js';
import { getEligiblePendingConfessions, processConfessionModeration } from '../apps/admin/lib/moderationPipeline';
import { generateAndStoreConfessionImages } from '../apps/admin/lib/canvas/pipeline';
import { publishConfessionToInstagram } from '../apps/admin/lib/instagram/publisher';
import { performTokenPreflight } from '../apps/admin/lib/instagram/tokenManager';
import {
  acquireAgentLock,
  renewAgentLock,
  releaseAgentLock,
  DEFAULT_AGENT_LOCK_NAME,
} from '../apps/admin/lib/agentLock';
import { getSupabaseAdmin } from '../apps/admin/lib/supabase';
import { redactSecrets } from '../apps/admin/lib/redact';
import {
  getRuntimeSettings,
  getTodayPostedCount,
  RuntimeSettings,
} from '../apps/admin/lib/settings';
import {
  evaluatePostingWindow,
  claimDailyPostingSlot,
  finalizeDailyPostingSlot,
} from '../apps/admin/lib/schedule';
import { syncConfessionToSheets } from '../apps/admin/lib/sheets/syncService';

/** Maximum execution budget before graceful shutdown (25 minutes) */
const MAX_RUNTIME_MS = 25 * 60 * 1000;

export async function getEligibleApprovedConfessions(
  limit: number = 50,
  supabase: SupabaseClient,
  excludeIds?: number[]
) {
  let filterBuilder = supabase
    .from('confessions')
    .select('*')
    .in('status', ['approved', 'posting'])
    .is('deleted_at', null);

  if (excludeIds && excludeIds.length > 0) {
    filterBuilder = filterBuilder.not('id', 'in', `(${excludeIds.join(',')})`);
  }

  const { data, error } = await filterBuilder
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error || !data) return [];

  const now = Date.now();
  return data.filter((item) => {
    if (excludeIds && excludeIds.includes(item.id)) {
      return false;
    }
    // Filter out items in awaiting_recheck if their deferral window has not elapsed
    if (item.next_retry_at && new Date(item.next_retry_at).getTime() > now) {
      return false;
    }
    return true;
  });
}

export interface RunAgentOptions {
  supabaseClient?: SupabaseClient;
  dryRun?: boolean;
  forceRun?: boolean;
  skipScheduleCheck?: boolean;
  settingsOverride?: Partial<RuntimeSettings>;
  sleepFn?: (ms: number) => Promise<void>;
  runUuid?: string;
  skipLock?: boolean;
}

export interface RunAgentResult {
  success: boolean;
  runUuid: string;
  dryRun: boolean;
  moderatedCount: number;
  approvedCount: number;
  rejectedCount: number;
  pendingReviewCount: number;
  postedCount: number;
  failedPostingCount: number;
  postingSkippedReason?: string;
  quotaReached?: boolean;
}

export async function runAgent(options: RunAgentOptions = {}): Promise<RunAgentResult> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const startTime = Date.now();

  // 0. Load centralized runtime settings and resolve overrides
  const baseSettings = await getRuntimeSettings({ supabaseClient: supabase });
  const settings: RuntimeSettings = {
    ...baseSettings,
    ...options.settingsOverride,
  };

  // Precedence Rule 2: CLI / ENV dry-run always forces dry_run_mode = true
  const isDryRun = Boolean(
    options.dryRun ??
      (process.env.DRY_RUN === 'true' ||
        (typeof process !== 'undefined' && process.argv && process.argv.includes('--dry-run')) ||
        settings.dry_run_mode)
  );

  const runUuid = options.runUuid || `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  console.log(`[AGENT] Starting BU Confessions v3.4 Daily Agent (dry_run: ${isDryRun}, run_uuid: ${runUuid})...`);

  // Lease parameters (inequality: heartbeat_timeout_sec <= floor(stale_lease_threshold_sec / 2))
  const leaseTtlMinutes = Math.max(1, Math.round(settings.stale_lease_threshold_sec / 60));
  const heartbeatIntervalMs = settings.heartbeat_timeout_sec * 1000;

  // 1. Acquire durable agent lock (unless dry-run or skipLock)
  if (!isDryRun && !options.skipLock) {
    const lock = await acquireAgentLock(DEFAULT_AGENT_LOCK_NAME, runUuid, leaseTtlMinutes, supabase);
    if (!lock.acquired) {
      console.warn(`[AGENT] Another agent run is currently holding lock '${DEFAULT_AGENT_LOCK_NAME}' (held by: ${lock.lockedBy}). Exiting 0.`);
      return {
        success: false,
        runUuid,
        dryRun: isDryRun,
        moderatedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        pendingReviewCount: 0,
        postedCount: 0,
        failedPostingCount: 0,
        postingSkippedReason: `lock_held_by_${lock.lockedBy}`,
      };
    }
    console.log(`[AGENT] Acquired agent lock '${DEFAULT_AGENT_LOCK_NAME}' (run_uuid: ${runUuid}, ttl: ${leaseTtlMinutes}m).`);
  }

  // 2. Start heartbeat timer
  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (!isDryRun && !options.skipLock) {
    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await renewAgentLock(DEFAULT_AGENT_LOCK_NAME, runUuid, leaseTtlMinutes, supabase);
        if (!renewed) {
          console.warn('[AGENT HEARTBEAT] Failed to renew lock lease.');
        }
      } catch (hbErr) {
        console.warn('[AGENT HEARTBEAT] Error renewing lease:', hbErr);
      }
    }, heartbeatIntervalMs);
  }

  // 3. Create agent_runs record (strictly skipped in dry-run)
  let runId: number | undefined;
  if (!isDryRun && !options.skipLock) {
    const { data: runRecord } = await supabase
      .from('agent_runs')
      .insert({
        run_uuid: runUuid,
        status: 'running',
        dry_run: isDryRun,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    runId = runRecord?.id;
  }

  const dryRunReport: Record<string, unknown> = {
    runUuid,
    dryRun: isDryRun,
    startedAt: new Date().toISOString(),
    moderation: [],
    publications: [],
  };

  let moderatedCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let pendingReviewCount = 0;
  let postedCount = 0;
  let failedPostingCount = 0;
  let postingSkippedReason: string | undefined;
  let quotaReached = false;
  let slotRunId: number | undefined;

  try {
    // 4. Token Preflight check before starting work
    if (!isDryRun) {
      const preflight = await performTokenPreflight({ supabaseClient: supabase });
      if (!preflight.isValid) {
        console.error(redactSecrets(`[AGENT] Aborting run: Instagram access token preflight failed: ${preflight.error}`));
        throw new Error(`Token preflight failed: ${preflight.error}`);
      }
      console.log('[AGENT] Instagram access token preflight verified successfully.');
    }

    // ── Master Switch: posting_enabled ──
    if (!settings.posting_enabled) {
      postingSkippedReason = 'posting_disabled';
      console.log('[AGENT] posting_enabled is false — skipping automated publication. Approved confessions remain untouched.');
      return {
        success: true,
        runUuid,
        dryRun: isDryRun,
        moderatedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        pendingReviewCount: 0,
        postedCount: 0,
        failedPostingCount: 0,
        postingSkippedReason: 'posting_disabled',
      };
    }

    // ── Schedule Window Pre-Check (Scheduled Invocations) ──
    // Manual diagnostic / force execution requires an explicit flag:
    //   1. options.forceRun === true
    //   2. process.env.FORCE_RUN === 'true' (e.g. workflow_dispatch input force_run: true)
    //   3. CLI args: --force, --force-run, --manual
    // Note: workflow_dispatch alone does NOT bypass the window unless force_run (FORCE_RUN=true) is explicitly provided.
    const forceRun = Boolean(
      options.forceRun ??
        (process.env.FORCE_RUN === 'true' ||
          (typeof process !== 'undefined' &&
            process.argv &&
            (process.argv.includes('--force') || process.argv.includes('--force-run') || process.argv.includes('--manual'))))
    );

    const skipScheduleCheck = Boolean(options.skipScheduleCheck || options.skipLock);

    const windowCheck = evaluatePostingWindow(
      new Date(),
      settings.daily_posting_times,
      settings.posting_timezone
    );

    // If scheduled invocation is outside all valid posting windows, exit cleanly:
    // Do NOT claim slot, do NOT moderate confessions, do NOT consume Gemini quota, do NOT publish.
    if (!isDryRun && !forceRun && !skipScheduleCheck && !windowCheck.isWithinWindow) {
      postingSkippedReason = 'outside_schedule_window';
      console.log(`[SCHEDULE] ${windowCheck.reason} Scheduled run is outside valid slot window. Halting execution cleanly (zero moderation, zero publishing).`);
      return {
        success: true,
        runUuid,
        dryRun: isDryRun,
        moderatedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        pendingReviewCount: 0,
        postedCount: 0,
        failedPostingCount: 0,
        postingSkippedReason: 'outside_schedule_window',
      };
    }

    // ── Phase C: AI Moderation Pipeline (Queue Draining) ──
    const processedPendingIds = new Set<number>();
    while (true) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.warn('[AGENT] Approaching 25-minute runtime budget. Halting new moderation.');
        break;
      }

      const pendingBatchLimit = Math.min(100, Math.max(1, settings.max_per_batch));
      const pendingList = await getEligiblePendingConfessions(pendingBatchLimit, supabase);
      const unhandledPending = pendingList.filter((c) => !processedPendingIds.has(c.id));

      if (unhandledPending.length === 0) break;

      console.log(`[AGENT] Found ${unhandledPending.length} pending confession(s) to moderate (batch limit: ${pendingBatchLimit}).`);

      for (const confession of unhandledPending) {
        processedPendingIds.add(confession.id);

        if (Date.now() - startTime > MAX_RUNTIME_MS) {
          console.warn('[AGENT] Approaching 25-minute runtime budget. Halting new moderation.');
          break;
        }

        console.log(`[AGENT] Moderating confession #${confession.id}...`);
        try {
          if (isDryRun) {
            const textContent = confession.confession_text || confession.text || '';
            (dryRunReport.moderation as unknown[]).push({
              confessionId: confession.id,
              action: 'would_moderate',
              textSnippet: textContent.slice(0, 50),
            });
            moderatedCount++;
            approvedCount++;
          } else {
            const modRes = await processConfessionModeration(confession, { supabaseClient: supabase });
            moderatedCount++;
            if (modRes.newStatus === 'approved') approvedCount++;
            else if (modRes.newStatus === 'rejected') rejectedCount++;
            else if (modRes.newStatus === 'pending_review') pendingReviewCount++;
          }
        } catch (modErr) {
          console.error(`[AGENT] Failed to moderate confession #${confession.id}:`, modErr);
        }
      }
    }

    // ── Phase D & E: Image Generation & Instagram Publication (Queue Draining) ──
    slotRunId = undefined;

    if (!settings.posting_enabled) {
      postingSkippedReason = 'posting_disabled';
      console.log('[AGENT] posting_enabled is false — skipping automated publication. Approved confessions remain untouched.');
    } else if (!settings.auto_publish_approved) {
      postingSkippedReason = 'auto_publish_disabled';
      console.log('[AGENT] auto_publish_approved is false — skipping automated publication of approved confessions.');
    } else {
      if (!isDryRun && !skipScheduleCheck) {
        const isWorkflowDispatch = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
        const isCli =
          typeof process !== 'undefined' &&
          process.argv &&
          (process.argv.includes('--force') || process.argv.includes('--manual') || process.argv.includes('--force-run'));
        const triggerSource = forceRun
          ? (isCli ? 'cli' : 'manual_dispatch')
          : (isWorkflowDispatch ? 'manual_dispatch' : 'scheduled');
        const claim = await claimDailyPostingSlot(
          windowCheck.postingDate,
          windowCheck.scheduleSlot,
          triggerSource,
          supabase
        );

        if (!claim.claimed) {
          postingSkippedReason = 'slot_already_claimed';
          console.log(`[SCHEDULE] ${claim.reason} Skipping publication.`);
        } else {
          slotRunId = claim.slotRunId;
          console.log(
            `[AGENT] Claimed daily posting slot (${windowCheck.postingDate}, ${windowCheck.scheduleSlot}, slotRunId: ${slotRunId}). Starting queue draining...`
          );
        }
      } else {
        // Dry-run mode: Never claim production slot, but simulate publication
        console.log(`[AGENT (DRY RUN)] Starting queue draining simulation. Slot remains unconsumed.`);
      }
    }

    // Queue Draining Loop: drain eligible confessions subject to safety & daily limits
    if (!postingSkippedReason) {
      let continueDraining = true;
      const processedApprovedIds = new Set<number>();
      let batchNumber = 0;

      while (continueDraining) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) {
          console.warn('[AGENT] Approaching 25-minute runtime budget. Safely halting queue draining. Remaining confessions remain eligible.');
          postingSkippedReason = postingSkippedReason || 'runtime_budget_exhausted';
          break;
        }

        // Re-read settings dynamically
        const currentSettings = await getRuntimeSettings({ supabaseClient: supabase, forceFresh: true });
        const effectiveSettings: RuntimeSettings = {
          ...currentSettings,
          ...options.settingsOverride,
        };

        if (!effectiveSettings.posting_enabled) {
          console.log('[AGENT] posting_enabled is false — halting queue draining safely.');
          postingSkippedReason = 'posting_disabled';
          break;
        }

        // Check durable daily posting quota (resets midnight IST)
        const currentTodayPosted = isDryRun ? postedCount : await getTodayPostedCount(supabase);
        if (currentTodayPosted >= effectiveSettings.max_daily_posts) {
          console.warn(
            `[AGENT] Daily posting quota reached (${currentTodayPosted}/${effectiveSettings.max_daily_posts} posted today in IST). Halting queue draining.`
          );
          quotaReached = true;
          break;
        }

        // Check per-slot quota (applies during scheduled slots, or when explicitly specified in settingsOverride)
        const applySlotQuota = !skipScheduleCheck || options.settingsOverride?.posts_per_slot !== undefined;
        const slotPostedCount = postedCount; // posts in THIS slot run
        if (applySlotQuota && slotPostedCount >= effectiveSettings.posts_per_slot) {
          console.log(
            `[AGENT] Per-slot quota reached (${slotPostedCount}/${effectiveSettings.posts_per_slot}). Halting queue draining for this slot.`
          );
          break;
        }

        const remainingDailyQuota = effectiveSettings.max_daily_posts - currentTodayPosted;
        const remainingSlotQuota = applySlotQuota
          ? effectiveSettings.posts_per_slot - slotPostedCount
          : remainingDailyQuota;
        const remainingQuota = Math.min(remainingDailyQuota, remainingSlotQuota);
        const currentBatchLimit = Math.min(
          Math.max(1, effectiveSettings.max_per_batch),
          remainingQuota
        );

        // Re-query database for remaining eligible work
        const excludeIds = Array.from(processedApprovedIds);
        const batch = await getEligibleApprovedConfessions(currentBatchLimit, supabase, excludeIds);

        if (batch.length === 0) {
          console.log(`[AGENT] Queue empty — no more eligible approved confessions to post. Completed draining.`);
          break;
        }

        batchNumber++;
        console.log(
          `[AGENT] Draining batch #${batchNumber} (${batch.length} confession(s), batch limit: ${currentBatchLimit}, remaining daily quota: ${remainingQuota})...`
        );

        for (let i = 0; i < batch.length; i++) {
          const confession = batch[i];
          processedApprovedIds.add(confession.id);

          if (Date.now() - startTime > MAX_RUNTIME_MS) {
            console.warn('[AGENT] Approaching 25-minute runtime budget. Halting further publications.');
            postingSkippedReason = postingSkippedReason || 'runtime_budget_exhausted';
            continueDraining = false;
            break;
          }

          // Check quota again before processing individual confession
          const countNow = isDryRun ? postedCount : await getTodayPostedCount(supabase);
          if (countNow >= effectiveSettings.max_daily_posts) {
            console.warn(`[AGENT] Daily posting quota reached (${countNow}/${effectiveSettings.max_daily_posts}). Halting.`);
            quotaReached = true;
            continueDraining = false;
            break;
          }

          console.log(`[AGENT] Processing publication for confession #${confession.id}...`);
          try {
            let currentConfession = {
              ...confession,
              text: confession.text || ((confession as unknown as Record<string, unknown>).confession_text as string) || '',
            };

            // Phase D: Check if images exist in storage; generate if missing
            const existingUrls = currentConfession.image_urls as string[] | undefined;
            if (!existingUrls || existingUrls.length === 0) {
              console.log(`[AGENT] Generating images for confession #${confession.id} (max_slide_count: ${effectiveSettings.max_slide_count})...`);
              if (!isDryRun) {
                const imgRes = await generateAndStoreConfessionImages(currentConfession, {
                  supabaseClient: supabase,
                  maxSlides: effectiveSettings.max_slide_count,
                });
                if (!imgRes.success) {
                  console.error(`[AGENT] Image generation failed for #${confession.id}: ${imgRes.error}`);
                  failedPostingCount++;
                  continue; // Failure isolation: proceed to next confession
                }
                currentConfession = {
                  ...currentConfession,
                  number: imgRes.confessionNumber,
                  parts: imgRes.parts,
                  image_urls: imgRes.imageUrls,
                };
              }
            }

            // Phase E: Instagram publication
            const pubResult = await publishConfessionToInstagram(currentConfession, {
              supabaseClient: supabase,
              runUuid,
              dryRun: isDryRun,
              skipLeaseCheck: Boolean(options.skipLock),
            });

            if (isDryRun) {
              (dryRunReport.publications as unknown[]).push(pubResult);
              postedCount++;
            } else if (pubResult.success) {
              postedCount++;
              console.log(`[AGENT] Successfully posted confession #${confession.id} to Instagram (${pubResult.igPermalink}).`);

              // Secondary Google Sheets Sync (Strictly non-blocking, fail-safe)
              if (effectiveSettings.sheets_sync_enabled) {
                try {
                  await syncConfessionToSheets(
                    {
                      id: confession.id,
                      number: currentConfession.number,
                      text: currentConfession.text,
                      status: 'posted',
                      ig_post_id: pubResult.igPostId,
                      ig_permalink: pubResult.igPermalink,
                      posted_at: new Date().toISOString(),
                      created_at: confession.created_at,
                    },
                    { supabaseClient: supabase }
                  );
                } catch (sheetsErr) {
                  console.warn(`[AGENT] Secondary Google Sheets sync failed for #${confession.id} (non-blocking):`, sheetsErr);
                }
              }
            } else if (pubResult.deferred) {
              console.log(`[AGENT] Publication for #${confession.id} deferred for recheck: ${pubResult.error}`);
            } else {
              failedPostingCount++;
              console.error(`[AGENT] Publication failed for #${confession.id}: ${pubResult.error}`);

              // Check if Instagram returned a platform rate limit
              const errStr = (pubResult.error || '').toLowerCase();
              const isRateLimit =
                errStr.includes('rate limit') ||
                errStr.includes('request limit') ||
                errStr.includes('exceeded the rate limit') ||
                errStr.includes('429') ||
                errStr.includes('2207042') ||
                errStr.includes('[4]') ||
                errStr.includes('[17]') ||
                errStr.includes('[32]') ||
                errStr.includes('[613]');

              if (isRateLimit) {
                console.warn(
                  `[AGENT] Instagram platform rate limit encountered on confession #${confession.id}. Halting queue draining safely to protect account quota.`
                );
                postingSkippedReason = 'rate_limit_exceeded';
                continueDraining = false;
                break;
              }
            }

            // Apply pacing delay between consecutive posts
            const isLastInBatch = batch.indexOf(confession) === batch.length - 1;
            if (effectiveSettings.min_delay_between_posts_sec > 0) {
              const delayMs = effectiveSettings.min_delay_between_posts_sec * 1000;
              if (options.sleepFn) {
                if (!isLastInBatch) {
                  await options.sleepFn(delayMs);
                }
              } else if (!isDryRun && !isLastInBatch && pubResult.success) {
                console.log(`[AGENT] Pacing delay: waiting ${effectiveSettings.min_delay_between_posts_sec}s before next post...`);
                await new Promise((r) => setTimeout(r, delayMs));
              } else if (isDryRun && !isLastInBatch) {
                console.log(`[AGENT (DRY RUN)] Pacing delay: simulated ${effectiveSettings.min_delay_between_posts_sec}s delay between posts.`);
              }
            }
          } catch (pubErr) {
            failedPostingCount++;
            console.error(`[AGENT] Exception publishing confession #${confession.id}:`, pubErr);
            const errStr = pubErr instanceof Error ? pubErr.message.toLowerCase() : String(pubErr).toLowerCase();
            if (errStr.includes('rate limit') || errStr.includes('429') || errStr.includes('2207042')) {
              postingSkippedReason = 'rate_limit_exceeded';
              continueDraining = false;
              break;
            }
          }
        }
      }
    }

    // Write dry-run report artifact if in dry-run mode
    if (isDryRun) {
      dryRunReport.finishedAt = new Date().toISOString();
      dryRunReport.summary = {
        moderated: moderatedCount,
        approved: approvedCount,
        posted: postedCount,
      };
      const reportPath = path.join(process.cwd(), 'apps', 'admin', 'dry-run-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(dryRunReport, null, 2));
      console.log(`[AGENT (DRY RUN)] Report artifact written to ${reportPath}`);
    }

    // 5. Update agent_runs record (strictly skipped in dry-run)
    if (runId) {
      await supabase
        .from('agent_runs')
        .update({
          status: 'completed',
          finished_at: new Date().toISOString(),
          confessions_processed: moderatedCount + postedCount,
          confessions_posted: postedCount,
          confessions_rejected: rejectedCount,
          confessions_pending_review: pendingReviewCount,
          confessions_failed: failedPostingCount,
          metadata: {
            approved: approvedCount,
            rejected: rejectedCount,
            pending_review: pendingReviewCount,
            posted: postedCount,
            failed_posting: failedPostingCount,
          },
        })
        .eq('id', runId);
    }

    if (slotRunId) {
      await finalizeDailyPostingSlot(slotRunId, postedCount, supabase);
    }

    console.log('[AGENT] Execution completed successfully:', {
      moderated: moderatedCount,
      approved: approvedCount,
      posted: postedCount,
      failed_posting: failedPostingCount,
    });

    return {
      success: true,
      runUuid,
      dryRun: isDryRun,
      moderatedCount,
      approvedCount,
      rejectedCount,
      pendingReviewCount,
      postedCount,
      failedPostingCount,
      postingSkippedReason,
      quotaReached,
    };
  } catch (fatalErr) {
    console.error('[AGENT] Fatal agent error:', fatalErr);
    if (runId) {
      await supabase
        .from('agent_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_summary: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
        })
        .eq('id', runId);
    }

    if (slotRunId) {
      await finalizeDailyPostingSlot(
        slotRunId,
        postedCount,
        supabase,
        fatalErr instanceof Error ? fatalErr.message : String(fatalErr)
      );
    }

    return {
      success: false,
      runUuid,
      dryRun: isDryRun,
      moderatedCount,
      approvedCount,
      rejectedCount,
      pendingReviewCount,
      postedCount,
      failedPostingCount,
      postingSkippedReason,
      quotaReached,
    };
  } finally {
    // 6. Cleanup heartbeat and release lock
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (!isDryRun && !options.skipLock) {
      await releaseAgentLock(DEFAULT_AGENT_LOCK_NAME, runUuid, supabase);
      console.log(`[AGENT] Released agent lock '${DEFAULT_AGENT_LOCK_NAME}'.`);
    }
  }
}

async function main() {
  const result = await runAgent();
  if (!result.success) {
    process.exit(1);
  }
}

// Execute if invoked directly
if (process.argv[1]?.includes('run-agent')) {
  main().catch((err) => {
    console.error('Fatal crash:', err);
    process.exit(1);
  });
}
