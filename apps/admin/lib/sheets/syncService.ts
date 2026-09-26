import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { getGoogleSheet } from '../googleSheets';
import { getGoogleSheetsSecrets } from '../secrets';
import { ConfessionRow } from '../confessions';

// ---------------------------------------------------------------------------
// Secondary Google Sheets Sync Service (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Invariants:
//   1. Google Sheets is strictly secondary and never blocks the critical path.
//   2. If Sheets sync fails:
//      - Instagram remains posted.
//      - Supabase confession status remains 'posted'.
//      - sheets_sync_status is set to 'failed'.
//      - Zero rollback of posted state, zero duplicate Instagram publish.
//   3. Sync is completely idempotent (checks for existing Confession ID).
// ---------------------------------------------------------------------------

export interface SheetsSyncResult {
  success: boolean;
  confessionId: number;
  isExistingRow?: boolean;
  error?: string;
}

/**
 * Idempotently synchronizes a posted confession to Google Sheets.
 */
export async function syncConfessionToSheets(
  confession: {
    id: number;
    number?: number | null;
    text: string;
    status: string;
    ig_post_id?: string | null;
    ig_permalink?: string | null;
    posted_at?: string | null;
    created_at?: string;
  },
  options: {
    supabaseClient?: SupabaseClient;
    sheetDocMock?: any;
  } = {}
): Promise<SheetsSyncResult> {
  const supabase = options.supabaseClient || getSupabaseAdmin();

  // 1. Verify Google Sheets secrets are configured
  const secrets = getGoogleSheetsSecrets();
  if (!secrets && !options.sheetDocMock) {
    const errorMsg = 'Google Sheets credentials are not configured in server environment.';
    console.warn(`[SHEETS_SYNC] Confession #${confession.id}: ${errorMsg}`);

    await supabase
      .from('confessions')
      .update({
        sheets_sync_status: 'pending',
        sheets_sync_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      success: false,
      confessionId: confession.id,
      error: errorMsg,
    };
  }

  try {
    const doc = options.sheetDocMock || (await getGoogleSheet());
    const sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      throw new Error('Google Spreadsheet has no worksheets.');
    }

    // 2. Idempotency Check: search existing rows to prevent duplicate entries
    const rows = await sheet.getRows();
    let existingRow = rows.find((r: any) => {
      const idVal = r.get ? r.get('ID') || r.get('Confession ID') : r['ID'] || r['Confession ID'];
      return String(idVal) === String(confession.id);
    });

    const nowIso = new Date().toISOString();
    const rowPayload = {
      ID: confession.id,
      Number: confession.number ?? '',
      Status: confession.status,
      Confession: confession.text,
      'IG Post ID': confession.ig_post_id ?? '',
      'IG Link': confession.ig_permalink ?? '',
      'Posted At': confession.posted_at ?? '',
      'Created At': confession.created_at ?? '',
      'Last Synced': nowIso,
    };

    if (existingRow) {
      // Update existing row
      Object.assign(existingRow, rowPayload);
      if (typeof existingRow.save === 'function') {
        await existingRow.save();
      }
      console.log(`[SHEETS_SYNC] Confession #${confession.id} updated in Google Sheet (idempotent).`);
    } else {
      // Append new row
      await sheet.addRow(rowPayload);
      console.log(`[SHEETS_SYNC] Confession #${confession.id} appended to Google Sheet.`);
    }

    // 3. Mark Supabase confession as synced
    await supabase
      .from('confessions')
      .update({
        sheets_sync_status: 'synced',
        sheets_last_synced_at: nowIso,
        sheets_sync_error: null,
        updated_at: nowIso,
      })
      .eq('id', confession.id);

    // Update sheets_sync_log if table exists
    try {
      await supabase
        .from('sheets_sync_log')
        .upsert(
          {
            confession_id: confession.id,
            status: 'synced',
            synced_at: nowIso,
            updated_at: nowIso,
          },
          { onConflict: 'confession_id' }
        );
    } catch {}

    return {
      success: true,
      confessionId: confession.id,
      isExistingRow: !!existingRow,
    };
  } catch (syncErr) {
    const errorMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
    console.error(`[SHEETS_SYNC] Error syncing confession #${confession.id} to Google Sheets:`, errorMsg);

    // CRITICAL: Supabase status and Instagram post remain posted. Only sheets_sync_status is updated.
    await supabase
      .from('confessions')
      .update({
        sheets_sync_status: 'failed',
        sheets_sync_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    try {
      await supabase
        .from('sheets_sync_log')
        .upsert(
          {
            confession_id: confession.id,
            status: 'failed',
            last_error: errorMsg,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'confession_id' }
        );
    } catch {}

    return {
      success: false,
      confessionId: confession.id,
      error: errorMsg,
    };
  }
}

/**
 * Batch retry for confessions that are posted on Instagram but failed or pending Sheets sync.
 */
export async function retryPendingSheetsSync(
  limit: number = 20,
  options: {
    supabaseClient?: SupabaseClient;
    sheetDocMock?: any;
  } = {}
): Promise<{ processed: number; synced: number; failed: number }> {
  const supabase = options.supabaseClient || getSupabaseAdmin();

  // Find posted confessions whose sheets_sync_status is not 'synced'
  const { data: pendingRows, error } = await supabase
    .from('confessions')
    .select('id, number, text, status, ig_post_id, ig_permalink, posted_at, created_at')
    .eq('status', 'posted')
    .neq('sheets_sync_status', 'synced')
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .limit(limit);

  if (error || !pendingRows || pendingRows.length === 0) {
    return { processed: 0, synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;

  for (const row of pendingRows) {
    const res = await syncConfessionToSheets(row, options);
    if (res.success) synced++;
    else failed++;
  }

  return {
    processed: pendingRows.length,
    synced,
    failed,
  };
}
