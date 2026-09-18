import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import {
  rerunAiModeration,
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

    const updated = await rerunAiModeration(id, { actor: 'admin' });
    return NextResponse.json({
      success: true,
      confession: formatConfessionForAdmin(updated),
    });
  } catch (e) {
    if (e instanceof StateTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    const message = e instanceof Error ? e.message : 'Server error';
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error('Error in re-run AI route:', e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
