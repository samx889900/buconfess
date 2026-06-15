import { NextRequest, NextResponse } from 'next/server';
import { generateConfessionImage, splitTextIntoParts } from '@/lib/imageGenerator';
import { getGoogleSheet } from '@/lib/googleSheets';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; part: string }> }
) {
  const { id: idStr, part: partStr } = await params;
  let partStrClean = partStr;
  if (partStrClean.endsWith('.jpg')) partStrClean = partStrClean.replace('.jpg', '');
  if (partStrClean.endsWith('.png')) partStrClean = partStrClean.replace('.png', '');
  const partIndex = parseInt(partStrClean);

  const doc = await getGoogleSheet();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  
  const confessionRow = rows.find(row => row.get('id') === idStr);
  if (!confessionRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const partsStr = confessionRow.get('parts');
  const text = confessionRow.get('text') || '';
  const parts = partsStr ? JSON.parse(partsStr) : splitTextIntoParts(text);
  
  if (partIndex < 0 || partIndex >= parts.length) {
    return NextResponse.json({ error: 'Part not found' }, { status: 404 });
  }

  const number = confessionRow.get('number') ? parseInt(confessionRow.get('number')) : parseInt(idStr);

  return generateConfessionImage(
    parts[partIndex],
    number,
    partIndex,
    parts.length
  );
}