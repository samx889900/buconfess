import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { getGoogleSheet } from '@/lib/googleSheets';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const { id } = await params;
    const body = await req.json();
    
    const doc = await getGoogleSheet();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    const rowToUpdate = rows.find(row => row.get('id') === id);
    if (!rowToUpdate) {
      return NextResponse.json({ error: 'Confession not found' }, { status: 404 });
    }
    
    if (typeof body.status === 'string') rowToUpdate.set('status', body.status);
    if (typeof body.text === 'string') rowToUpdate.set('text', body.text);
    rowToUpdate.set('updatedAt', new Date().toISOString());
    
    await rowToUpdate.save();
    
    return NextResponse.json({ 
      id: parseInt(rowToUpdate.get('id')),
      text: rowToUpdate.get('text'),
      status: rowToUpdate.get('status')
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const isAdmin = await getAdminFromRequest();
    if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const { id } = await params;
    
    const doc = await getGoogleSheet();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    const rowToDelete = rows.find(row => row.get('id') === id);
    if (!rowToDelete) {
      return NextResponse.json({ error: 'Confession not found' }, { status: 404 });
    }
    
    await rowToDelete.delete();
    
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
