import fs from 'fs';
import path from 'path';

// Parse apps/admin/.env if present
const envPath = path.resolve('apps/admin/.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
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
import { buildModerationUserPrompt, computePromptHash, SYSTEM_MODERATION_INSTRUCTION } from '../apps/admin/lib/ai/prompt';
import { checkDeterministicRules } from '../apps/admin/lib/ai/rules';
import { AI_CONFIG, MODERATION_MODELS } from '../apps/admin/lib/ai/config';
import { geminiQuotaLedger } from '../apps/admin/lib/ai/quotaLedger';

async function main() {
  console.log('====================================================');
  console.log('      BUCONFESS BACKLOG RE-MODERATION DRY-RUN       ');
  console.log('====================================================\n');

  const supabase = getSupabaseAdmin();

  // Load current snapshot
  const snapshotPath = path.resolve('backlog-current-snapshot.json');
  if (!fs.existsSync(snapshotPath)) {
    throw new Error('backlog-current-snapshot.json not found!');
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  const pendingIds: number[] = snapshot.pending_review_ids;

  console.log(`Discovered ${pendingIds.length} pending_review records in database.`);

  // Sample 5 eligible records (skipping #38 which is human review)
  const sampleIds = pendingIds.filter((id) => id !== 38).slice(0, 5);
  console.log(`Sample set for dry-run verification (5 records): ${JSON.stringify(sampleIds)}\n`);

  let totalExpectedCalls = 0;

  for (const id of sampleIds) {
    const { data: record, error } = await supabase
      .from('confessions')
      .select('id, text, status, ai_verdict, decision_reason, number')
      .eq('id', id)
      .single();

    if (error || !record) {
      console.warn(`Record #${id} not found: ${error?.message}`);
      continue;
    }

    console.log(`----------------------------------------------------`);
    console.log(`Confession #${record.id} [Current status: ${record.status}, Current number: ${record.number ?? 'none'}]`);
    console.log(`Text snippet: "${record.text.slice(0, 80).replace(/\n/g, ' ')}..."`);

    // Deterministic pre-filter
    const deterministic = checkDeterministicRules(record.text);
    if (deterministic.matched) {
      console.log(`• Deterministic Rule Matched: ${deterministic.rule}`);
      console.log(`• Expected Verdict:           ${deterministic.moderation?.verdict}`);
      console.log(`• Expected Gemini Calls:      0 (Deterministic filter handles locally)`);
      continue;
    }

    // Build exact user prompt & prompt hash
    const userPrompt = buildModerationUserPrompt(record.text);
    const promptHash = computePromptHash(userPrompt);

    console.log(`• Deterministic Pre-filter:   PASS (Eligible for AI moderation)`);
    console.log(`• Input Length:               ${record.text.length} chars (Normalized & clamped <= 2000 chars)`);
    console.log(`• Prompt Hash (SHA-256):      ${promptHash.slice(0, 16)}...`);
    console.log(`• Target Primary Model:       ${MODERATION_MODELS.PRIMARY}`);
    console.log(`• Ambiguity Escalation Model: ${MODERATION_MODELS.SECONDARY} (Only if confidence < 0.6)`);
    console.log(`• System Instruction Length:  ${SYSTEM_MODERATION_INSTRUCTION.length} chars`);
    console.log(`• Expected Gemini Calls:      1 call (to ${MODERATION_MODELS.PRIMARY})`);
    totalExpectedCalls += 1;
  }

  console.log(`\n====================================================`);
  console.log('DRY-RUN ACCOUNTING & SAFETY CONFIRMATION:');
  console.log(`• Total Sample Confessions Inspected: ${sampleIds.length}`);
  console.log(`• Total Expected Gemini Requests:    ${totalExpectedCalls}`);
  console.log(`• Expected Gemini Calls Per Decision: ${(totalExpectedCalls / sampleIds.length).toFixed(2)} (Target: <= 1.1)`);
  console.log(`• Database Mutations Performed:       0 (Strictly read-only)`);
  console.log(`• Publication Numbers Allocated:      0`);
  console.log(`• Instagram Posts Published:          0`);
  console.log(`• Daily Posting Runs Created:         0`);
  console.log(`• Current Highest Publication Number: #${snapshot.highest_publication_number} (Unchanged)`);
  console.log(`• Human Review Case #38:              Preserved and excluded from batch`);
  console.log(`====================================================\n`);
}

main().catch(console.error);
