import { NextRequest, NextResponse } from 'next/server';
import { releaseStaleAgentLock } from '@/lib/health';
import { DEFAULT_AGENT_LOCK_NAME } from '@/lib/agentLock';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let lockName = DEFAULT_AGENT_LOCK_NAME;
    try {
      const body = await req.json();
      if (body?.lockName && typeof body.lockName === 'string') {
        lockName = body.lockName.trim();
      }
    } catch {
      // Body is optional; default lockName will be used
    }

    const result = await releaseStaleAgentLock(lockName, { actor: 'admin' });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[LEASE CONTROL API] Stale lease release failed:', error);
    // If it's an active lease conflict, return 409 Conflict
    const isConflict = error?.message?.includes('Cannot release active lease');
    return NextResponse.json(
      { error: isConflict ? 'Conflict' : 'Internal Server Error', message: error?.message || 'Failed to release lease' },
      { status: isConflict ? 409 : 500 }
    );
  }
}
