import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { retryPendingSheetsSync } from '@/lib/sheets/syncService';
import { recordAuditLog } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const isAdmin = await getAdminFromRequest(req);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await retryPendingSheetsSync(25);

    try {
      await recordAuditLog({
        action: 'admin_retry_sheets_sync',
        actor: 'admin',
        details: result,
      });
    } catch {}

    return NextResponse.json({
      success: true,
      message: `Sheets sync retry completed: ${result.synced} synced, ${result.failed} failed out of ${result.processed} processed.`,
      ...result,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[API_SHEETS_RETRY] Failed to retry sheets sync:', errorMsg);
    return NextResponse.json(
      { error: `Sheets sync retry failed: ${errorMsg}` },
      { status: 500 }
    );
  }
}
