import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import {
  forceApproveConfession,
  formatConfessionForAdmin,
  StateTransitionError,
} from '@/lib/confessions';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: idStr } = await params;
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid confession ID' }, { status: 400 });
    }

    let reason: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body.reason === 'string') {
        reason = body.reason.trim();
      }
    } catch {
      // Body is optional
    }

    const approved = await forceApproveConfession(id, { reason, actor: 'admin' });
    return NextResponse.json({
      success: true,
      confession: formatConfessionForAdmin(approved),
    });
  } catch (e) {
    if (e instanceof StateTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    const message = e instanceof Error ? e.message : 'Server error';
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error('Error in force approve route:', e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
