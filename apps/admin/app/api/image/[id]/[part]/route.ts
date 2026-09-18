import { NextRequest, NextResponse } from 'next/server';
import { generateConfessionImage, splitTextIntoParts } from '@/lib/imageGenerator';
import { getAdminConfessionById } from '@/lib/confessions';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; part: string }> }
) {
  try {
    const { id: idStr, part: partStr } = await params;
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid confession ID' }, { status: 400 });
    }

    let partStrClean = partStr;
    if (partStrClean.endsWith('.jpg')) partStrClean = partStrClean.replace('.jpg', '');
    if (partStrClean.endsWith('.png')) partStrClean = partStrClean.replace('.png', '');
    const partIndex = parseInt(partStrClean, 10);

    const confession = await getAdminConfessionById(id);
    if (!confession) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const parts =
      confession.parts && confession.parts.length > 0
        ? confession.parts
        : splitTextIntoParts(confession.text || '');

    if (isNaN(partIndex) || partIndex < 0 || partIndex >= parts.length) {
      return NextResponse.json({ error: 'Part not found' }, { status: 404 });
    }

    const number = confession.number ?? id;
    const createdAt = confession.created_at || '';

    return generateConfessionImage(
      parts[partIndex],
      number,
      partIndex,
      parts.length,
      createdAt
    );
  } catch (e) {
    console.error('Error generating confession image:', e);
    const message = e instanceof Error ? e.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}