import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import {
  getAdminConfessionById,
  updateAdminConfession,
  softDeleteAdminConfession,
  forceApproveConfession,
  forceRejectConfession,
  rerunAiModeration,
  formatConfessionForAdmin,
  ConfessionStatus,
  VALID_CONFESSION_STATUSES,
  StateTransitionError,
} from '@/lib/confessions';

export async function PATCH(
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

    const existing = await getAdminConfessionById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Confession not found' }, { status: 404 });
    }

    const body = await req.json();

    // If status transition is requested, validate through state machine actions
    if (typeof body.status === 'string') {
      const targetStatus = body.status as ConfessionStatus;
      if (!VALID_CONFESSION_STATUSES.includes(targetStatus)) {
        return NextResponse.json(
          {
            error: `Invalid status: "${body.status}". Allowed: ${VALID_CONFESSION_STATUSES.join(', ')}`,
          },
          { status: 400 }
        );
      }

      if (targetStatus === 'approved') {
        const approved = await forceApproveConfession(id, { reason: body.reason, actor: 'admin' });
        return NextResponse.json(formatConfessionForAdmin(approved));
      } else if (targetStatus === 'rejected') {
        const rejected = await forceRejectConfession(id, { reason: body.reason, actor: 'admin' });
        return NextResponse.json(formatConfessionForAdmin(rejected));
      } else if (targetStatus === 'pending') {
        const reset = await rerunAiModeration(id, { actor: 'admin' });
        return NextResponse.json(formatConfessionForAdmin(reset));
      } else {
        return NextResponse.json(
          {
            error: `Direct transition to "${targetStatus}" via PATCH is prohibited. Status changes must follow moderation lifecycle.`,
          },
          { status: 400 }
        );
      }
    }

    // Otherwise, text or non-status updates
    const updateInput: { text?: string } = {};
    if (typeof body.text === 'string') {
      updateInput.text = body.text;
    }

    const updated = await updateAdminConfession(id, updateInput);
    const formatted = formatConfessionForAdmin(updated);

    return NextResponse.json(formatted);
  } catch (e) {
    if (e instanceof StateTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('Error updating confession:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
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

    const existing = await getAdminConfessionById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Confession not found' }, { status: 404 });
    }

    await softDeleteAdminConfession(id, { actor: 'admin' });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('Error deleting confession:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
