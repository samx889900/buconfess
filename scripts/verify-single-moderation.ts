import fs from 'fs';
import path from 'path';

// 1. Parse apps/admin/.env
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
import { updateAdminSetting, getRuntimeSettings } from '../apps/admin/lib/settings';
import { geminiCredentialPool } from '../apps/admin/lib/ai/credentialPool';
import { rerunAiModeration } from '../apps/admin/lib/confessions';
import { processConfessionModeration } from '../apps/admin/lib/moderationPipeline';

async function runControlledVerification() {
  console.log('==================================================');
  console.log(' BUCONFESS v3.5 CONTROLLED PRODUCTION VERIFICATION');
  console.log('==================================================\n');

  const supabase = getSupabaseAdmin();

  // ── STEP 1: Verify Database Cascade Setting ──
  console.log('STEP 1: Verify Database Cascade Setting');
  console.log('----------------------------------------');
  const targetCascade = 'gemini-3.5-flash,gemini-3.7-flash,gemini-3.8-flash';
  
  const currentSettings = await getRuntimeSettings({ supabaseClient: supabase, forceFresh: true });
  console.log('Current DB moderation_model_cascade:', currentSettings.moderation_model_cascade);

  if (currentSettings.moderation_model_cascade !== targetCascade) {
    console.log(`Updating DB setting from "${currentSettings.moderation_model_cascade}" to approved: "${targetCascade}"...`);
    await updateAdminSetting('moderation_model_cascade', targetCascade, {
      actor: 'admin_production_verification',
      supabaseClient: supabase,
    });
    console.log('✅ Setting updated successfully in database.');
  } else {
    console.log('✅ Setting already matches approved cascade.');
  }

  const verifiedSettings = await getRuntimeSettings({ supabaseClient: supabase, forceFresh: true });
  console.log('Sanitized verified value:', verifiedSettings.moderation_model_cascade, '\n');

  // ── STEP 2: Verify Credential Pool ──
  console.log('STEP 2: Verify Credential Pool');
  console.log('------------------------------');
  geminiCredentialPool.refreshFromEnv();
  const slots = geminiCredentialPool.getSlots();
  console.log(`Discovered ${slots.length} credential slot(s):`);
  for (const s of slots) {
    const health = s.available
      ? 'healthy'
      : s.cooldownUntil && s.cooldownUntil > Date.now()
        ? `in cooldown (~${Math.ceil((s.cooldownUntil - Date.now()) / 3600000)}h remaining)`
        : `unavailable (${s.unavailableReason || 'unknown'})`;
    console.log(`  ${s.id}: configured / ${health}`);
  }
  console.log();

  // ── Pre-test Audit Metrics ──
  const { count: pendingReviewCountBefore } = await supabase
    .from('confessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_review')
    .is('deleted_at', null);

  const { count: igAttemptsBefore } = await supabase
    .from('instagram_publish_attempts')
    .select('id', { count: 'exact', head: true });

  const { count: postingRunsBefore } = await supabase
    .from('daily_posting_runs')
    .select('id', { count: 'exact', head: true });

  const { data: highestNumBefore } = await supabase
    .from('confessions')
    .select('number')
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log(`Pre-test pending_review count: ${pendingReviewCountBefore}`);
  console.log(`Pre-test Instagram publish attempts: ${igAttemptsBefore}`);
  console.log(`Pre-test daily_posting_runs: ${postingRunsBefore}`);
  console.log(`Pre-test highest publication number: #${highestNumBefore?.number ?? 'none'}\n`);

  // ── STEP 3: Select Exactly ONE pending_review Confession ──
  console.log('STEP 3: Select Exactly ONE pending_review Confession');
  console.log('----------------------------------------------------');
  const { data: targetConfession, error: fetchErr } = await supabase
    .from('confessions')
    .select('*')
    .eq('status', 'pending_review')
    .neq('id', 38)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchErr || !targetConfession) {
    throw new Error(`Failed to find an eligible pending_review confession: ${fetchErr?.message || 'none found'}`);
  }

  console.log(`Selected Confession ID: #${targetConfession.id}`);
  console.log(`Previous Status: ${targetConfession.status}`);
  console.log(`Previous AI Verdict: ${targetConfession.ai_verdict}`);
  console.log(`Previous Reason: "${targetConfession.decision_reason}"`);
  console.log(`Snippet: "${targetConfession.text.slice(0, 80).replace(/\n/g, ' ')}..."\n`);

  // Run the normal "Re-run AI" pipeline path:
  // Step 3a: rerunAiModeration resets the confession to 'pending' state
  console.log(`Resetting Confession #${targetConfession.id} to 'pending' via rerunAiModeration...`);
  await rerunAiModeration(targetConfession.id, {
    actor: 'admin_production_verification',
    supabaseClient: supabase,
  });

  // Fetch the reset record
  const { data: resetRecord, error: resetFetchErr } = await supabase
    .from('confessions')
    .select('*')
    .eq('id', targetConfession.id)
    .single();

  if (resetFetchErr || !resetRecord) {
    throw new Error(`Failed to fetch reset confession #${targetConfession.id}`);
  }

  console.log(`Confession #${targetConfession.id} is now status='${resetRecord.status}'. Running processConfessionModeration...`);

  // Step 3b: Run actual processConfessionModeration
  const moderationOutput = await processConfessionModeration(resetRecord, {
    supabaseClient: supabase,
    confessionId: targetConfession.id,
  });

  // ── STEP 4: Verify The Result ──
  console.log('\nSTEP 4: Verify The Result');
  console.log('-------------------------');
  // Fetch fresh record from DB to confirm persistence
  const { data: updatedConfession } = await supabase
    .from('confessions')
    .select('*')
    .eq('id', targetConfession.id)
    .single();

  console.log(`Confession ID:   #${updatedConfession.id}`);
  console.log(`Previous status: pending_review`);
  console.log(`New status:      ${updatedConfession.status}`);
  console.log(`AI verdict:      ${updatedConfession.ai_verdict}`);
  console.log(`Model used:      ${updatedConfession.model_id}`);
  console.log(`Policy level:    ${updatedConfession.policy_level}`);
  console.log(`Confidence:      ${updatedConfession.model_confidence !== null ? `${(updatedConfession.model_confidence * 100).toFixed(0)}%` : 'null'}`);
  console.log(`Decision reason: "${updatedConfession.decision_reason}"`);

  console.log('\nGemini Telemetry Entries:');
  const telemetry = moderationOutput.moderationResult?.telemetry || [];
  if (telemetry.length === 0) {
    console.log('  (Deterministic pre-filter triggered or mock used)');
  } else {
    for (const t of telemetry) {
      console.log(`  - Model: ${t.model} | Credential: ${t.credential_slot} | Result: ${t.result} | HTTP Status: ${t.http_status ?? 'N/A'} | Retries: ${t.retry_count} | Latency: ${t.duration_ms}ms`);
    }
  }

  // ── STEP 5: Verify No Side Effects ──
  console.log('\nSTEP 5: Verify No Instagram Side Effects');
  console.log('----------------------------------------');
  const { count: igAttemptsAfter } = await supabase
    .from('instagram_publish_attempts')
    .select('id', { count: 'exact', head: true });

  const { count: postingRunsAfter } = await supabase
    .from('daily_posting_runs')
    .select('id', { count: 'exact', head: true });

  const { data: highestNumAfter } = await supabase
    .from('confessions')
    .select('number')
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const igDiff = (igAttemptsAfter ?? 0) - (igAttemptsBefore ?? 0);
  const runsDiff = (postingRunsAfter ?? 0) - (postingRunsBefore ?? 0);
  const numBefore = highestNumBefore?.number ?? 0;
  const numAfter = highestNumAfter?.number ?? 0;

  console.log(`Instagram publication attempts diff: ${igDiff} (must be 0)`);
  console.log(`Daily posting runs diff: ${runsDiff} (must be 0)`);
  console.log(`Highest publication number: #${numAfter} (before: #${numBefore}, diff: ${numAfter - numBefore})`);

  if (igDiff !== 0 || runsDiff !== 0 || numAfter !== numBefore) {
    console.error('❌ UNEXPECTED SIDE EFFECT DETECTED!');
  } else {
    console.log('✅ ZERO Instagram side effects. Zero numbers allocated. Zero posting runs created.');
  }

  // ── STEP 6: Verify Backlog Count ──
  console.log('\nSTEP 6: Verify Backlog Count');
  console.log('----------------------------');
  const { count: pendingReviewCountAfter } = await supabase
    .from('confessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_review')
    .is('deleted_at', null);

  console.log(`pending_review before: ${pendingReviewCountBefore}`);
  console.log(`pending_review after:  ${pendingReviewCountAfter}`);
  console.log(`Delta: ${pendingReviewCountAfter! - pendingReviewCountBefore!} (expected: -1 if resolved to approved/rejected)`);

  console.log('\n==================================================');
  console.log('     CONTROLLED VERIFICATION EXECUTION COMPLETE   ');
  console.log('==================================================\n');
}

runControlledVerification().catch((err) => {
  console.error('Controlled verification error:', err);
  process.exit(1);
});
