import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { splitTextIntoParts } from '@/lib/imageGenerator';
import { getGoogleSheet } from '@/lib/googleSheets';

export async function POST(req: NextRequest) {
  const isAdmin = await getAdminFromRequest();
  if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await req.json();
  
  const doc = await getGoogleSheet();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  
  const confessionRow = rows.find(row => row.get('id') === id.toString() || row.get('id') === id);
  if (!confessionRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let confessionNumber = confessionRow.get('number');
  if (!confessionNumber) {
    let maxNumber = 0;
    for (const row of rows) {
      const num = parseInt(row.get('number') || '0');
      if (num > maxNumber) maxNumber = num;
    }
    confessionNumber = maxNumber + 1;
    confessionRow.set('number', confessionNumber.toString());
  }

  const parts = splitTextIntoParts(confessionRow.get('text') || '');
  const imageUrls = parts.map((_, index) => `/api/image/${id}/${index}`);

  confessionRow.set('parts', JSON.stringify(parts));
  confessionRow.set('imageUrls', JSON.stringify(imageUrls));
  confessionRow.set('status', 'approved');
  confessionRow.set('updatedAt', new Date().toISOString());

  await confessionRow.save();

  return NextResponse.json({ success: true, parts, imageUrls, confessionNumber });
}
