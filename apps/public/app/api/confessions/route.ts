import { NextRequest, NextResponse } from 'next/server';
import { getGoogleSheet } from '@/lib/googleSheets';
import { rateLimit } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== 'string') return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    if (text.trim().length < 10) return NextResponse.json({ error: 'Confession too short' }, { status: 400 });
    if (text.length > 2000) return NextResponse.json({ error: 'Confession too long' }, { status: 400 });

    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';

    // Rate Limiting
    const { success } = await rateLimit.limit(ip);
    if (!success) {
      return NextResponse.json(
        { error: 'You have reached the limit of 3 confessions per hour. Please try again later.' },
        { status: 429 }
      );
    }
    
    const doc = await getGoogleSheet();
    const sheet = doc.sheetsByIndex[0];
    
    // We need to generate an ID
    const rows = await sheet.getRows();
    const newId = rows.length > 0 ? parseInt(rows[rows.length - 1].get('id')) + 1 : 1;
    
    await sheet.addRow({
      id: newId.toString(),
      text: text.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return NextResponse.json({ success: true, id: newId });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
