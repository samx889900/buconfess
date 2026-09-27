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

  // 1. Fetch all confessions summary
  const { data: allConfessions, error: confError } = await supabase
    .from('confessions')
    .select('id, status, number, ai_verdict, decision_reason, created_at')
    .order('id', { ascending: true });

  if (confError || !allConfessions) {
    throw new Error(`Failed to query confessions: ${confError?.message}`);
  }

  const counts: Record<string, number> = {
    pending: 0,
    processing: 0,
    approved: 0,
    posting: 0,
    posted: 0,
    rejected: 0,
    pending_review: 0,
    failed: 0,
  };

  const pendingReviewIds: number[] = [];
  let highestNumber = 0;

  for (const c of allConfessions) {
    counts[c.status] = (counts[c.status] || 0) + 1;
    if (c.status === 'pending_review') {
      pendingReviewIds.push(c.id);
    }
    if (typeof c.number === 'number' && c.number > highestNumber) {
      highestNumber = c.number;
    }
  }

  // 2. Active agent locks
  const { data: locks, error: lockErr } = await supabase
    .from('agent_locks')
    .select('*')
    .gt('expires_at', new Date().toISOString());

  // 3. daily_posting_runs count
  const { count: dailyRunsCount, error: runsErr } = await supabase
    .from('daily_posting_runs')
    .select('*', { count: 'exact', head: true });

  // 4. publish attempts count
  const { count: publishAttemptsCount, error: pubErr } = await supabase
    .from('instagram_publish_attempts')
    .select('*', { count: 'exact', head: true });

  const snapshot = {
    timestamp: new Date().toISOString(),
    total_confessions: allConfessions.length,
    counts,
    highest_publication_number: highestNumber,
    active_agent_locks: locks?.length || 0,
    daily_posting_runs_count: dailyRunsCount || 0,
    instagram_publish_attempts_count: publishAttemptsCount || 0,
    pending_review_count: pendingReviewIds.length,
    pending_review_ids: pendingReviewIds,
  };

  const outPath = path.resolve('backlog-current-snapshot.json');
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log('=== CURRENT PRODUCTION SNAPSHOT ===');
  console.log(`Timestamp:                  ${snapshot.timestamp}`);
  console.log(`Total Confessions:          ${snapshot.total_confessions}`);
  console.log(`Status breakdown:`);
  console.log(`  pending:                  ${counts.pending}`);
  console.log(`  processing:               ${counts.processing}`);
  console.log(`  approved:                 ${counts.approved}`);
  console.log(`  posting:                  ${counts.posting}`);
  console.log(`  posted:                   ${counts.posted}`);
  console.log(`  rejected:                 ${counts.rejected}`);
  console.log(`  pending_review:           ${counts.pending_review}`);
  console.log(`  failed:                   ${counts.failed}`);
  console.log(`Highest Publication Number: #${highestNumber}`);
  console.log(`Active Agent Locks:         ${snapshot.active_agent_locks}`);
  console.log(`Daily Posting Runs:         ${snapshot.daily_posting_runs_count}`);
  console.log(`Instagram Publish Attempts: ${snapshot.instagram_publish_attempts_count}`);
  console.log(`Pending Review IDs (${pendingReviewIds.length}):`);
  console.log(`  ${JSON.stringify(pendingReviewIds)}`);
  console.log(`Snapshot saved to: ${outPath}`);
}

main().catch(console.error);
