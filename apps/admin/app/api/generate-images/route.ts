import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { splitTextIntoParts } from '@/lib/imageGenerator';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAdminConfessionById, updateAdminConfession } from '@/lib/confessions';
import { ensureConfessionNumber } from '@/lib/canvas/pipeline';

export async function POST(req: NextRequest) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: rawId } = await req.json();
    const id = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid confession ID' }, { status: 400 });
    }

    const confession = await getAdminConfessionById(id);
    if (!confession) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const supabase = getSupabaseAdmin();

    // Ensure confession number is atomically assigned via Postgres sequence
    // Invariant: Do NOT reintroduce MAX(number)+1. Must use allocate_confession_number.
    const confessionNumber = await ensureConfessionNumber(
      supabase,
      confession.id,
      confession.number
    );

    const parts = splitTextIntoParts(confession.text || '');
    const imageUrls = parts.map((_, index) => `/api/image/${id}/${index}`);

    await updateAdminConfession(confession.id, {
      parts,
      image_urls: imageUrls,
      status: 'approved',
    });

    return NextResponse.json({
      success: true,
      parts,
      imageUrls,
      confessionNumber,
    });
  } catch (e) {
    console.error('Error generating images:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
