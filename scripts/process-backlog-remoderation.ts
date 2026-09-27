import fs from 'fs';
import path from 'path';

// Parse apps/admin/.env if not already loaded into process.env
const envPath = path.resolve(process.cwd(), 'apps/admin/.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) {
        process.env[k] = v;
      }
    }
  }
}

import { getSupabaseAdmin } from '../apps/admin/lib/supabase';
import { rerunAiModeration } from '../apps/admin/lib/confessions';
import { processConfessionModeration } from '../apps/admin/lib/moderationPipeline';
import { geminiCredentialPool } from '../apps/admin/lib/ai/credentialPool';
import { geminiQuotaLedger } from '../apps/admin/lib/ai/quotaLedger';
import { MODERATION_MODELS } from '../apps/admin/lib/ai/config';

interface ModerationResultSummary {
  id: number;
  previous_status: string;
  new_status: string;
  model_id: string;
  project_id: string;
  policy_level: number | null;
  model_confidence: number | null;
  decision_reason: string;
  gemini_calls: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('====================================================');
  console.log('    BUCONFESS PRODUCTION BACKLOG RE-MODERATION     ');
  console.log('====================================================\n');

  const supabase = getSupabaseAdmin();

  // ── Step 0: Pre-run Invariant Snapshots ──
  console.log('AUDIT CHECK 0: Pre-run Safety Snapshots');
  console.log('---------------------------------------');
  const { data: highestNumBefore } = await supabase
    .from('confessions')
    .select('number')
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: igAttemptsBefore } = await supabase
    .from('instagram_publish_attempts')
    .select('id', { count: 'exact', head: true });

  const { count: dailyRunsBefore } = await supabase
    .from('daily_posting_runs')
    .select('id', { count: 'exact', head: true });

  const { count: activeLocksBefore } = await supabase
    .from('agent_locks')
    .select('id', { count: 'exact', head: true })
    .gt('expires_at', new Date().toISOString());

  console.log(`• Starting Highest Publication Number: #${highestNumBefore?.number ?? 60}`);
  console.log(`• Starting Instagram Publish Attempts: ${igAttemptsBefore ?? 60}`);
  console.log(`• Starting Daily Posting Runs:         ${dailyRunsBefore ?? 1}`);
  console.log(`• Starting Active Agent Locks:         ${activeLocksBefore ?? 0}\n`);

  // Query live pending_review records from database
  const { data: pendingRecords, error: pendingErr } = await supabase
    .from('confessions')
    .select('id, status, text, ai_verdict, decision_reason, model_id, policy_level, model_confidence')
    .eq('status', 'pending_review')
    .order('id', { ascending: true });

  if (pendingErr || !pendingRecords) {
    throw new Error(`Failed to query pending_review confessions: ${pendingErr?.message}`);
  }

  const targetIds: number[] = pendingRecords.map((r) => r.id);
  console.log(`Discovered ${targetIds.length} live pending_review confessions in database.`);
  console.log(`Target IDs: ${JSON.stringify(targetIds)}\n`);

  const results: ModerationResultSummary[] = [];
  const modelUsage: Record<string, number> = {};
  const slotUsage: Record<string, number> = {};

  let approvedCount = 0;
  let rejectedCount = 0;
  let humanReviewPreservedCount = 0;
  let infrastructureFailureCount = 0;
  let skippedCount = 0;

  let totalGeminiApiCalls = 0;
  let maxCallsSingleConfession = 0;

  const failureCounts: Record<string, number> = {
    '503': 0,
    '429': 0,
    '401_403': 0,
    '404': 0,
    timeout: 0,
    other: 0,
  };

  const BATCH_SIZE = 5;
  const totalBatches = Math.ceil(targetIds.length / BATCH_SIZE);

  for (let b = 0; b < totalBatches; b++) {
    const batchIds = targetIds.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    console.log(`\n----------------------------------------------------`);
    console.log(`--- Processing Batch ${b + 1}/${totalBatches} (${batchIds.length} confessions: ${JSON.stringify(batchIds)}) ---`);
    console.log(`----------------------------------------------------`);

    for (const id of batchIds) {
      // 1. Re-read current record state from DB (Idempotency requirement #14)
      const { data: currentRecord, error: fetchErr } = await supabase
        .from('confessions')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchErr || !currentRecord) {
        console.warn(`[WARN] Confession #${id} not found in database or fetch error: ${fetchErr?.message}`);
        continue;
      }

      if (currentRecord.status !== 'pending_review') {
        console.log(`[SKIP] Confession #${id} is currently '${currentRecord.status}' (not pending_review). Skipping.`);
        skippedCount++;
        continue;
      }

      // 2. Check for human-review cases (Requirement #15: #38 must be preserved)
      const isNamedCase38 = currentRecord.id === 38;
      const isLegitimateHumanReview =
        currentRecord.ai_verdict === 'pending_review' &&
        currentRecord.model_id &&
        !['cascade_failed', 'none', 'pipeline_error'].includes(currentRecord.model_id);

      if (isNamedCase38 || isLegitimateHumanReview) {
        console.log(`[PRESERVE HUMAN REVIEW] Confession #${id} is an intentional human-review case evaluated by ${currentRecord.model_id} (Reason: "${currentRecord.decision_reason}"). Preserving.`);
        humanReviewPreservedCount++;
        results.push({
          id,
          previous_status: 'pending_review',
          new_status: 'pending_review',
          model_id: currentRecord.model_id,
          project_id: 'human_review_preserved',
          policy_level: currentRecord.policy_level,
          model_confidence: currentRecord.model_confidence,
          decision_reason: currentRecord.decision_reason,
          gemini_calls: 0,
        });
        continue;
      }

      // Check remaining internal safety budget before calling Gemini (Requirement #18: Stop Condition)
      const safeAvailable = geminiQuotaLedger.getSafeRequestsAvailable(MODERATION_MODELS.PRIMARY);
      if (safeAvailable <= 0) {
        console.error(`[STOP CONDITION] Primary model ${MODERATION_MODELS.PRIMARY} has 0 remaining internal safety budget across all project slots!`);
        break;
      }

      console.log(`\n[START] Processing Confession #${id}...`);
      console.log(`  Snippet: "${currentRecord.text.slice(0, 60).replace(/\n/g, ' ')}..."`);

      try {
        // Step A: Reset to pending via rerunAiModeration
        await rerunAiModeration(id, {
          actor: 'admin_backlog_remoderation',
          supabaseClient: supabase,
        });

        // Step B: Fetch the reset record
        const { data: resetRecord, error: resetFetchErr } = await supabase
          .from('confessions')
          .select('*')
          .eq('id', id)
          .single();

        if (resetFetchErr || !resetRecord) {
          throw new Error(`Failed to fetch reset confession #${id}: ${resetFetchErr?.message}`);
        }

        // Step C: Run canonical processConfessionModeration
        const modResult = await processConfessionModeration(resetRecord, {
          supabaseClient: supabase,
          confessionId: id,
        });

        // Fetch finalized DB record
        const { data: finalRecord } = await supabase
          .from('confessions')
          .select('*')
          .eq('id', id)
          .single();

        const newStatus = finalRecord?.status || modResult.newStatus;
        const modelId = finalRecord?.model_id || modResult.moderationResult.model_id;
        const policyLevel = finalRecord?.policy_level ?? modResult.moderationResult.policy_level;
        const confidence = finalRecord?.model_confidence ?? modResult.moderationResult.model_confidence;
        const reason = finalRecord?.decision_reason || modResult.moderationResult.decision_reason;

        // Telemetry analysis
        const telemetry = modResult.moderationResult.telemetry || [];
        const callsCount = telemetry.length > 0 ? telemetry.length : 1;
        totalGeminiApiCalls += callsCount;
        if (callsCount > maxCallsSingleConfession) {
          maxCallsSingleConfession = callsCount;
        }

        for (const t of telemetry) {
          if (t.result === 'service_unavailable') failureCounts['503']++;
          else if (t.result === 'rate_limited') failureCounts['429']++;
          else if (t.result === 'not_found') failureCounts['404']++;
          else if (t.result === 'auth_error' || t.result === 'permission_error') failureCounts['401_403']++;
          else if (t.result === 'timeout') failureCounts.timeout++;
        }

        const projectId = telemetry[0]?.credential_slot || 'project-default';

        console.log(`  ✅ Confession #${id} evaluated:`);
        console.log(`     Verdict:      ${newStatus.toUpperCase()}`);
        console.log(`     Model:        ${modelId}`);
        console.log(`     Project Slot: ${projectId}`);
        console.log(`     Policy Level: ${policyLevel}`);
        console.log(`     Confidence:   ${confidence !== null ? `${(confidence * 100).toFixed(0)}%` : 'null'}`);
        console.log(`     Reason:       "${reason}"`);
        console.log(`     Gemini Calls: ${callsCount} call(s)`);

        if (newStatus === 'approved') approvedCount++;
        else if (newStatus === 'rejected') rejectedCount++;
        else {
          infrastructureFailureCount++;
        }

        if (modelId) {
          modelUsage[modelId] = (modelUsage[modelId] || 0) + 1;
        }
        if (projectId) {
          slotUsage[projectId] = (slotUsage[projectId] || 0) + 1;
        }

        results.push({
          id,
          previous_status: 'pending_review',
          new_status: newStatus,
          model_id: modelId,
          project_id: projectId,
          policy_level: policyLevel,
          model_confidence: confidence,
          decision_reason: reason,
          gemini_calls: callsCount,
        });
      } catch (err: any) {
        console.error(`  ❌ Error processing confession #${id}:`, err?.message || err);
        infrastructureFailureCount++;
        failureCounts.other = (failureCounts.other || 0) + 1;

        results.push({
          id,
          previous_status: 'pending_review',
          new_status: 'pending_review',
          model_id: 'error',
          project_id: 'error',
          policy_level: null,
          model_confidence: null,
          decision_reason: `Moderation failure: ${err?.message || String(err)}`,
          error: err?.message || String(err),
          gemini_calls: 1,
        });
      }

      // Conservative 2.5s pacing between confessions (Requirement #17)
      await sleep(2500);
    }

    // Batch progress
    const evaluatedSoFar = approvedCount + rejectedCount + infrastructureFailureCount;
    const avgCallsSoFar = evaluatedSoFar > 0 ? (totalGeminiApiCalls / evaluatedSoFar).toFixed(2) : '1.0';
    console.log(`\n====================================================`);
    console.log(`BATCH ${b + 1}/${totalBatches} PROGRESS:`);
    console.log(`  Decisions Evaluated:       ${evaluatedSoFar}`);
    console.log(`  Approved:                  ${approvedCount}`);
    console.log(`  Rejected:                  ${rejectedCount}`);
    console.log(`  Human Review Preserved:    ${humanReviewPreservedCount}`);
    console.log(`  Infra Failures:            ${infrastructureFailureCount}`);
    console.log(`  Total Gemini Calls:        ${totalGeminiApiCalls}`);
    console.log(`  Calls/Decision Metric:     ${avgCallsSoFar} (Target <= 1.1)`);
    console.log(`====================================================\n`);

    // Check healthy slots
    const healthySlots = geminiCredentialPool.getAvailableSlots().length;
    if (healthySlots === 0) {
      console.error(`[STOP CONDITION] All Gemini credential slots are exhausted or in cooldown! STOPPING.`);
      break;
    }

    // Inter-batch delay
    await sleep(2000);
  }

  // ── Step 4: Post-Run Safety Snapshots & Verification ──
  const { data: highestNumAfter } = await supabase
    .from('confessions')
    .select('number')
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: igAttemptsAfter } = await supabase
    .from('instagram_publish_attempts')
    .select('id', { count: 'exact', head: true });

  const { count: dailyRunsAfter } = await supabase
    .from('daily_posting_runs')
    .select('id', { count: 'exact', head: true });

  const { count: activeLocksAfter } = await supabase
    .from('agent_locks')
    .select('id', { count: 'exact', head: true })
    .gt('expires_at', new Date().toISOString());

  const numDiff = (highestNumAfter?.number ?? 60) - (highestNumBefore?.number ?? 60);
  const igDiff = (igAttemptsAfter ?? 60) - (igAttemptsBefore ?? 60);
  const runsDiff = (dailyRunsAfter ?? 1) - (dailyRunsBefore ?? 1);

  const successfulDecisions = approvedCount + rejectedCount;
  const avgCallsPerDecision = successfulDecisions > 0 ? parseFloat((totalGeminiApiCalls / successfulDecisions).toFixed(2)) : 1.0;

  // Save full results artifact
  const outResultsPath = path.resolve('backlog-remoderation-results.json');
  fs.writeFileSync(
    outResultsPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total_targeted: targetIds.length,
        processed: results.length,
        approved: approvedCount,
        rejected: rejectedCount,
        human_review_preserved: humanReviewPreservedCount,
        infrastructure_failures: infrastructureFailureCount,
        total_gemini_api_calls: totalGeminiApiCalls,
        gemini_calls_per_decision: avgCallsPerDecision,
        max_calls_single_confession: maxCallsSingleConfession,
        model_usage: modelUsage,
        slot_usage: slotUsage,
        failure_counts: failureCounts,
        side_effects: {
          highest_publication_number: highestNumAfter?.number ?? 60,
          publication_numbers_allocated: numDiff,
          instagram_posts_published: igDiff,
          daily_posting_runs_created: runsDiff,
          active_agent_locks: activeLocksAfter ?? 0,
        },
        results,
      },
      null,
      2
    )
  );

  console.log('\n====================================================');
  console.log('       BUCONFESS BACKLOG RUN SUMMARY REPORT         ');
  console.log('====================================================');
  console.log(`1. Total Records Attempted:             ${targetIds.length}`);
  console.log(`2. Successful Gemini Decisions:         ${successfulDecisions}`);
  console.log(`3. Approved:                            ${approvedCount}`);
  console.log(`4. Rejected:                            ${rejectedCount}`);
  console.log(`5. Preserved for Human Review:          ${humanReviewPreservedCount}`);
  console.log(`6. Infrastructure Failures:             ${infrastructureFailureCount}`);
  console.log(`7. HTTP 503 Count:                      ${failureCounts['503']}`);
  console.log(`8. HTTP 429 Count:                      ${failureCounts['429']}`);
  console.log(`9. HTTP 404 Count:                      ${failureCounts['404']}`);
  console.log(`10. HTTP 401/403 Count:                 ${failureCounts['401_403']}`);
  console.log(`11. Timeout Count:                      ${failureCounts.timeout}`);
  console.log(`12. Total Gemini API Calls:             ${totalGeminiApiCalls}`);
  console.log(`13. Average Calls Per Decision:         ${avgCallsPerDecision} (Target <= 1.1)`);
  console.log(`14. Max Calls for Any Confession:       ${maxCallsSingleConfession}`);
  console.log(`15. Publication Numbers Allocated:      ${numDiff} (MUST BE 0)`);
  console.log(`16. Instagram Posts Created:            ${igDiff} (MUST BE 0)`);
  console.log(`17. Daily Posting Runs Created:         ${runsDiff} (MUST BE 0)`);
  console.log(`18. Active Agent Locks:                 ${activeLocksAfter ?? 0}`);
  console.log('====================================================\n');
  console.log(`Detailed results saved to: ${outResultsPath}\n`);
}

main().catch(console.error);
