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

async function main() {
  const supabase = getSupabaseAdmin();
  const snapshotRaw = fs.readFileSync(path.resolve('backlog-initial-snapshot.json'), 'utf8');
  const snapshot = JSON.parse(snapshotRaw);
  const initialIds: number[] = snapshot.pending_review_ids;

  const { data: records, error } = await supabase
    .from('confessions')
    .select('id, status, ai_verdict, decision_reason, model_id, policy_level, model_confidence, number')
    .in('id', initialIds);

  if (error || !records) {
    console.error('Failed to fetch confessions:', error);
    process.exit(1);
  }

  const approved = records.filter((r) => r.status === 'approved');
  const rejected = records.filter((r) => r.status === 'rejected');
  const pendingReview = records.filter((r) => r.status === 'pending_review');
  const other = records.filter((r) => !['approved', 'rejected', 'pending_review'].includes(r.status));

  console.log('=== BACKLOG RECONCILIATION SUMMARY ===');
  console.log(`Initial pending_review targeted: ${initialIds.length}`);
  console.log(`Now Approved: ${approved.length} (IDs: ${approved.map((r) => r.id).join(', ')})`);
  console.log(`Now Rejected: ${rejected.length} (IDs: ${rejected.map((r) => r.id).join(', ')})`);
  console.log(`Still Pending Review: ${pendingReview.length} (IDs: ${pendingReview.map((r) => r.id).join(', ')})`);
  console.log(`Other Statuses: ${other.length}`);

  // Check specific records
  for (const id of [50, 131]) {
    const rec = records.find(r => r.id === id);
    console.log(`Specific Record #${id}:`, JSON.stringify(rec));
  }

  // Parse log for failure counts
  const logPath = 'C:/Users/vikra/.gemini/antigravity-ide/brain/3d8264e1-7b36-4ce7-9d03-476ab392c2e0/.system_generated/tasks/task-3789.log';
  if (fs.existsSync(logPath)) {
    const log = fs.readFileSync(logPath, 'utf8');
    const counts = {
      '503': (log.match(/503/g) || []).length,
      '429': (log.match(/429/g) || []).length,
      '401': (log.match(/401/g) || []).length,
      '403': (log.match(/403/g) || []).length,
      '404': (log.match(/404/g) || []).length,
      'Timeout': (log.match(/Timeout/g) || []).length,
      'Other': 0
    };
    console.log('\n--- HTTP ERROR STATUS / FAILURE COUNTS FROM LOG ---');
    console.log(JSON.stringify(counts, null, 2));
  }

  // Print sample verdicts
  console.log('\n--- SAMPLE VERDICTS ---');
  for (const r of [...approved.slice(0, 5), ...rejected.slice(0, 3), ...pendingReview.slice(0, 2)]) {
    console.log(
      `ID #${r.id} | Verdict: ${r.status} | Model: ${r.model_id} | Policy: ${r.policy_level} | Conf: ${r.model_confidence} | Reason: ${r.decision_reason}`
    );
  }
}

main().catch(console.error);
