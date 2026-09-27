import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Parse apps/admin/.env if not already loaded into process.env
const envPath = resolve(process.cwd(), 'apps/admin/.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
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
import { getRuntimeSettings } from '../apps/admin/lib/settings';

async function runProductionPreflight() {
  console.log('=== BUCONFESS v3.5 READ-ONLY PRODUCTION PREFLIGHT ===');
  console.log('Timestamp:', new Date().toISOString());

  // 1. Secrets Preflight (Existence & Non-empty check only — ZERO values exposed)
  console.log('\n--- 1. Secrets Preflight (Existence Verification) ---');
  const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'INSTAGRAM_ACCOUNT_ID',
    'INSTAGRAM_ACCESS_TOKEN',
    'ADMIN_PASSWORD_HASH',
    'JWT_SECRET',
  ];

  for (const v of requiredEnvVars) {
    const val = process.env[v];
    const exists = Boolean(val && val.trim().length > 0);
    console.log(`  ${v}: ${exists ? 'PRESENT (configured)' : 'MISSING'}`);
  }

  // Gemini keys
  const geminiSingle = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  console.log(`  GEMINI_API_KEY (legacy/default): ${geminiSingle ? 'PRESENT' : 'NOT_SET'}`);
  for (let i = 1; i <= 4; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    const exists = Boolean(k && k.trim().length > 0);
    console.log(`  GEMINI_API_KEY_${i}: ${exists ? 'PRESENT' : 'NOT_SET'}`);
  }

  const supabase = getSupabaseAdmin();

  // 2. Schema & Tables Verification
  console.log('\n--- 2. Database Schema & Tables Verification ---');
  const tables = [
    'confessions',
    'settings',
    'agent_locks',
    'agent_runs',
    'daily_posting_runs',
    'audit_log',
    'instagram_publish_attempts',
  ];

  for (const t of tables) {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`  ❌ Table '${t}': ERROR (${error.message})`);
    } else {
      console.log(`  ✅ Table '${t}': ACCESSIBLE (${count ?? 0} records)`);
    }
  }

  // 3. Current Confession Queue States
  console.log('\n--- 3. Confession Queue State Breakdown ---');
  const statuses = ['pending', 'processing', 'approved', 'posting', 'posted', 'rejected', 'pending_review', 'failed'];
  for (const s of statuses) {
    const { count } = await supabase
      .from('confessions')
      .select('id', { count: 'exact', head: true })
      .eq('status', s)
      .is('deleted_at', null);
    console.log(`  status='${s}': ${count ?? 0}`);
  }

  // 4. Confession #101 Verification
  console.log('\n--- 4. Confession #101 State Reconciliation ---');
  const { data: c101, error: c101Err } = await supabase
    .from('confessions')
    .select('id, number, status, ai_verdict, decision_reason, posted_at, created_at')
    .eq('id', 101)
    .maybeSingle();

  if (c101Err || !c101) {
    console.log('  Confession #101:', c101Err?.message || 'NOT FOUND');
  } else {
    console.log(`  Confession #101: status='${c101.status}', number=${c101.number}, ai_verdict='${c101.ai_verdict}', decision_reason="${c101.decision_reason}"`);
  }

  // 5. Settings Table Verification
  console.log('\n--- 5. Runtime Settings Verification ---');
  const settings = await getRuntimeSettings({ supabaseClient: supabase, forceFresh: true });
  console.log('  posting_enabled:', settings.posting_enabled);
  console.log('  auto_publish_approved:', settings.auto_publish_approved);
  console.log('  dry_run_mode:', settings.dry_run_mode);
  console.log('  daily_posting_times:', settings.daily_posting_times);
  console.log('  posts_per_slot:', settings.posts_per_slot);
  console.log('  max_daily_posts:', settings.max_daily_posts);
  console.log('  max_per_batch:', settings.max_per_batch);
  console.log('  posting_timezone:', settings.posting_timezone);

  // 6. Active Concurrency Locks
  console.log('\n--- 6. Active Agent Locks ---');
  const { data: locks } = await supabase.from('agent_locks').select('*');
  if (!locks || locks.length === 0) {
    console.log('  Zero active locks (IDLE)');
  } else {
    for (const l of locks) {
      console.log(`  Lock: name='${l.lock_name}', holder='${l.locked_by}', expires_at=${l.expires_at}`);
    }
  }

  // 7. Highest Publication Number
  console.log('\n--- 7. Publication Sequence Status ---');
  const { data: highestNumRecord } = await supabase
    .from('confessions')
    .select('number')
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(`  Highest assigned publication number: #${highestNumRecord?.number ?? 'none'}`);

  console.log('\n=== PREFLIGHT COMPLETE (Zero Mutations Performed) ===\n');
}

runProductionPreflight().catch((err) => {
  console.error('Preflight error:', err);
  process.exit(1);
});
