import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import {
  getAdminConfessions,
  createAdminConfession,
  formatConfessionForAdmin,
  ConfessionStatus,
  VALID_CONFESSION_STATUSES,
} from '@/lib/confessions';

export async function POST(req: NextRequest) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const text = body?.text;
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }
    if (text.trim().length < 10) {
      return NextResponse.json({ error: 'Confession too short' }, { status: 400 });
    }
    if (text.length > 2000) {
      return NextResponse.json({ error: 'Confession too long' }, { status: 400 });
    }

    const created = await createAdminConfession({ text: text.trim() });
    return NextResponse.json({ success: true, id: created.id });
  } catch (e) {
    console.error('Error creating confession:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get('status') || 'pending';

    let statusFilter: ConfessionStatus | 'all';
    if (statusParam === 'all') {
      statusFilter = 'all';
    } else if (VALID_CONFESSION_STATUSES.includes(statusParam as ConfessionStatus)) {
      statusFilter = statusParam as ConfessionStatus;
    } else {
      statusFilter = 'pending';
    }

    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const page = pageParam ? parseInt(pageParam, 10) : undefined;
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : undefined;

    const confessions = await getAdminConfessions({
      status: statusFilter,
      page: page && page > 0 ? page : undefined,
      limit: limit && limit > 0 ? limit : undefined,
    });
    return NextResponse.json(confessions.map(formatConfessionForAdmin));
  } catch (e) {
    console.error('Error fetching confessions:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
