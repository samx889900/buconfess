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

/** Maximum execution budget before graceful shutdown (25 minutes) */
const MAX_RUNTIME_MS = 25 * 60 * 1000;

export async function getEligibleApprovedConfessions(limit: number = 50, supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('confessions')
    .select('*')
    .in('status', ['approved', 'posting'])
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error || !data) return [];

  const now = Date.now();
  return data.filter((item) => {
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

    // ── Phase C: AI Moderation Pipeline ──
    const batchLimit = Math.min(100, Math.max(1, settings.max_per_batch));
    const pendingList = await getEligiblePendingConfessions(batchLimit, supabase);
    console.log(`[AGENT] Found ${pendingList.length} pending confession(s) to moderate (batch limit: ${batchLimit}).`);

    for (const confession of pendingList) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.warn('[AGENT] Approaching 25-minute runtime budget. Halting new moderation.');
        break;
      }

      console.log(`[AGENT] Moderating confession #${confession.id}...`);
      try {
        if (isDryRun) {
          (dryRunReport.moderation as unknown[]).push({
            confessionId: confession.id,
            action: 'would_moderate',
            textSnippet: confession.text.slice(0, 50),
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

    // ── Phase D & E: Image Generation & Instagram Publication ──
    let approvedList: any[] = [];
    if (!settings.posting_enabled) {
      postingSkippedReason = 'posting_disabled';
      console.log('[AGENT] posting_enabled is false — skipping automated publication. Approved confessions remain untouched.');
    } else if (!settings.auto_publish_approved) {
      postingSkippedReason = 'auto_publish_disabled';
      console.log('[AGENT] auto_publish_approved is false — skipping automated publication of approved confessions.');
    } else {
      approvedList = await getEligibleApprovedConfessions(batchLimit, supabase);
      console.log(`[AGENT] Found ${approvedList.length} approved/posting confession(s) for publication.`);
    }

    for (let i = 0; i < approvedList.length; i++) {
      const confession = approvedList[i];
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.warn('[AGENT] Approaching 25-minute runtime budget. Halting further publications.');
        break;
      }

      // Check durable daily posting quota (resets midnight IST)
      if (!isDryRun) {
        const todayPosted = await getTodayPostedCount(supabase);
        if (todayPosted >= settings.max_daily_posts) {
          console.warn(
            `[AGENT] Daily posting quota reached (${todayPosted}/${settings.max_daily_posts} posted today in IST). Halting new publications.`
          );
          quotaReached = true;
          break;
        }
      }

      console.log(`[AGENT] Processing publication for confession #${confession.id}...`);
      try {
        let currentConfession = confession;

        // Phase D: Check if images exist in storage; generate if missing
        const existingUrls = currentConfession.image_urls as string[] | undefined;
        if (!existingUrls || existingUrls.length === 0) {
          console.log(`[AGENT] Generating images for confession #${confession.id} (max_slide_count: ${settings.max_slide_count})...`);
          if (!isDryRun) {
            const imgRes = await generateAndStoreConfessionImages(currentConfession, {
              supabaseClient: supabase,
              maxSlides: settings.max_slide_count,
            });
            if (!imgRes.success) {
              console.error(`[AGENT] Image generation failed for #${confession.id}: ${imgRes.error}`);
              failedPostingCount++;
              continue;
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
        } else if (pubResult.deferred) {
          console.log(`[AGENT] Publication for #${confession.id} deferred for recheck: ${pubResult.error}`);
        } else {
          failedPostingCount++;
          console.error(`[AGENT] Publication failed for #${confession.id}: ${pubResult.error}`);
        }

        // Apply pacing delay between consecutive posts in batch
        if ((isDryRun || pubResult.success) && i < approvedList.length - 1 && settings.min_delay_between_posts_sec > 0) {
          const delayMs = settings.min_delay_between_posts_sec * 1000;
          console.log(`[AGENT] Pacing delay: waiting ${settings.min_delay_between_posts_sec}s before next post...`);
          const sleep = options.sleepFn || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
          await sleep(delayMs);
        }
      } catch (pubErr) {
        failedPostingCount++;
        console.error(`[AGENT] Exception publishing confession #${confession.id}:`, pubErr);
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
