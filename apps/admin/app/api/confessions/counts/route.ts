import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { getAdminConfessionCounts } from '@/lib/confessions';

export async function GET(_req: NextRequest) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const counts = await getAdminConfessionCounts();
    return NextResponse.json({ success: true, counts });
  } catch (e) {
    console.error('Error fetching confession counts:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
