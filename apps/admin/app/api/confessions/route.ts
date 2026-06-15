import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { getGoogleSheet } from '@/lib/googleSheets';

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== 'string') return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    if (text.trim().length < 10) return NextResponse.json({ error: 'Confession too short' }, { status: 400 });
    if (text.length > 2000) return NextResponse.json({ error: 'Confession too long' }, { status: 400 });
    
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

export async function GET(req: NextRequest) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || 'pending';
    
    const doc = await getGoogleSheet();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    // Parse rows into objects
    const confessions = rows
      .map(row => ({
        id: parseInt(row.get('id') || '0'),
        text: row.get('text') || '',
        status: row.get('status') || 'pending',
        createdAt: row.get('createdAt') || '',
        updatedAt: row.get('updatedAt') || ''
      }))
      .filter(c => c.status === status)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
    return NextResponse.json(confessions);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
