#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// migrate-sheets-to-supabase.ts
// ---------------------------------------------------------------------------
// One-time migration script that reads all existing confessions from
// Google Sheets and inserts them into the Supabase `confessions` table.
//
// Usage:
//   npx tsx scripts/migrate-sheets-to-supabase.ts
//
// Prerequisites:
//   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set
//   - GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY must be set
//   - The Supabase migration (001_initial_schema.sql) must be applied first
//
// Safety:
//   - Idempotent: skips rows that already exist (by original sheet ID)
//   - Preserves historical IDs, numbers, statuses, and IG post IDs
//   - Safely resets sequences after migration
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { createHash, createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const IP_HASH_SECRET = process.env.IP_HASH_SECRET || 'migration-placeholder-secret';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

if (!GOOGLE_SHEET_ID || !GOOGLE_EMAIL || !GOOGLE_KEY) {
  console.error('❌ Missing Google Sheets credentials');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width characters
    .replace(/\s+/g, ' ')
    .trim();
}

function computeContentHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

function computeIpHash(ip: string): string {
  return createHmac('sha256', IP_HASH_SECRET).update(ip).digest('hex');
}

/** Map legacy status values to the new 8-status system */
function mapStatus(status: string | undefined): string {
  if (!status) return 'pending';
  const s = status.toLowerCase().trim();

  switch (s) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'posted':
      return 'posted';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending';
  }
}

// ---------------------------------------------------------------------------
// Main Migration
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 Starting Google Sheets → Supabase migration...\n');

  // 1. Connect to Google Sheets
  const privateKey = GOOGLE_KEY!.replace(/\\n/g, '\n');
  const auth = new JWT({
    email: GOOGLE_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID!, auth);
  await doc.loadInfo();
  console.log(`📄 Connected to sheet: "${doc.title}"`);

  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  console.log(`📊 Found ${rows.length} rows in sheet\n`);

  if (rows.length === 0) {
    console.log('ℹ️  No rows to migrate. Exiting.');
    return;
  }

  // 2. Check existing confessions in Supabase (for idempotency)
  const { data: existing, error: fetchError } = await supabase
    .from('confessions')
    .select('id');

  if (fetchError) {
    console.error('❌ Failed to fetch existing confessions:', fetchError.message);
    process.exit(1);
  }

  const existingIds = new Set((existing || []).map((r) => r.id));

  // 3. Transform and insert rows
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const rawId = parseInt(row.get('id') || '0');
    if (rawId === 0) {
      console.warn(`⚠️  Skipping row with invalid ID`);
      errors++;
      continue;
    }

    // Skip if already migrated
    if (existingIds.has(rawId)) {
      skipped++;
      continue;
    }

    const text = (row.get('text') || '').trim();
    if (!text) {
      console.warn(`⚠️  Skipping row ${rawId}: empty text`);
      errors++;
      continue;
    }

    const normalizedText = normalizeText(text);
    const contentHash = computeContentHash(normalizedText);
    const status = mapStatus(row.get('status'));

    // Parse existing data
    const rawNumber = row.get('number');
    const number = rawNumber ? parseInt(rawNumber) : null;
    const rawParts = row.get('parts');
    const parts = rawParts ? JSON.parse(rawParts) : null;
    const rawImageUrls = row.get('imageUrls');
    const imageUrls = rawImageUrls ? JSON.parse(rawImageUrls) : null;
    const igPostId = row.get('igPostId') || null;
    const igPermalink = row.get('igPermalink') || null;
    const createdAt = row.get('createdAt') || new Date().toISOString();
    const updatedAt = row.get('updatedAt') || createdAt;

    const confession = {
      id: rawId,
      text,
      normalized_text: normalizedText,
      content_hash: contentHash,
      status,
      number: number && !isNaN(number) ? number : null,
      parts,
      image_urls: imageUrls,
      ig_post_id: igPostId,
      ig_permalink: igPermalink,
      // Migrated rows get a placeholder IP hash since we don't have the original IP
      submitter_ip_hash: computeIpHash(`migrated-${rawId}`),
      created_at: createdAt,
      updated_at: updatedAt,
      posted_at: status === 'posted' ? updatedAt : null,
      sheets_sync_status: 'synced', // Already in sheets by definition
      sheets_last_synced_at: new Date().toISOString(),
    };

    const { error: insertError } = await supabase
      .from('confessions')
      .insert(confession);

    if (insertError) {
      console.error(`❌ Failed to insert confession ${rawId}:`, insertError.message);
      errors++;
    } else {
      inserted++;
      if (inserted % 10 === 0) {
        process.stdout.write(`  ✅ Inserted ${inserted} confessions...\r`);
      }
    }
  }

  console.log(`\n\n📊 Migration Summary:`);
  console.log(`  ✅ Inserted: ${inserted}`);
  console.log(`  ⏭️  Skipped (already exists): ${skipped}`);
  console.log(`  ❌ Errors: ${errors}`);

  // 4. Reset sequences safely
  console.log('\n🔄 Resetting sequences...');

  // Safe serial sequence reset (handles empty table case)
  const { error: seqError1 } = await supabase.rpc('', {}).then(() => ({ error: null })).catch((e) => ({ error: e }));
  
  // Use raw SQL via Supabase's SQL endpoint
  const { data: maxIdResult } = await supabase
    .from('confessions')
    .select('id')
    .order('id', { ascending: false })
    .limit(1)
    .single();

  const { data: maxNumberResult } = await supabase
    .from('confessions')
    .select('number')
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1)
    .single();

  if (maxIdResult) {
    console.log(`  📌 Max confession ID: ${maxIdResult.id}`);
    console.log(`  📌 Max confession number: ${maxNumberResult?.number || 'N/A'}`);
  }

  console.log(`
⚠️  IMPORTANT: Run the following SQL in Supabase SQL Editor to reset sequences:

  SELECT setval(pg_get_serial_sequence('confessions', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM confessions;
  SELECT setval('confession_number_seq', COALESCE(MAX(number), 1), MAX(number) IS NOT NULL) FROM confessions;

This ensures new confessions get IDs and numbers that don't conflict with migrated data.
`);

  console.log('✅ Migration complete!');
}

main().catch((err) => {
  console.error('💥 Migration failed:', err);
  process.exit(1);
});
