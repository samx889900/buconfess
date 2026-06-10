import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminFromRequest } from '@/lib/auth';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const isAdmin = await getAdminFromRequest();
  if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const numId = parseInt(id);
  const body = await req.json();
  // Only allow whitelisted fields to prevent arbitrary data injection
  const allowed: Record<string, unknown> = {};
  if (typeof body.status === 'string') allowed.status = body.status;
  if (typeof body.text === 'string') allowed.text = body.text;
  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  const confession = await prisma.confession.update({ where: { id: numId }, data: allowed });
  return NextResponse.json(confession);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const isAdmin = await getAdminFromRequest();
  if (!isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const numId = parseInt(id);
  await prisma.confession.delete({ where: { id: numId } });
  return NextResponse.json({ ok: true });
}
