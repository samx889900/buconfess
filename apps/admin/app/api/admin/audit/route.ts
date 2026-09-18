import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuditLogs } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const page = searchParams.get('page') ? parseInt(searchParams.get('page')!, 10) : 1;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : 25;
    const action = searchParams.get('action') || undefined;
    const confessionIdParam = searchParams.get('confessionId');
    const confessionId = confessionIdParam ? parseInt(confessionIdParam, 10) : undefined;
    const actor = searchParams.get('actor') || undefined;

    const result = await getAdminAuditLogs({
      page,
      limit,
      action,
      confessionId: isNaN(confessionId as number) ? undefined : confessionId,
      actor,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[AUDIT API] Failed to fetch audit logs:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error?.message || 'Failed to fetch audit records' },
      { status: 500 }
    );
  }
}
