import { NextResponse } from 'next/server';
import { recordAuditLog } from '../../../../lib/audit';

export async function POST() {
  const res = NextResponse.json({ success: true });

  // Explicitly evict the cookie with exact matching path, security, and expiry attributes
  res.cookies.set('admin_token', '', {
    httpOnly: true,
    maxAge: 0,
    expires: new Date(0),
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  try {
    await recordAuditLog({ action: 'admin_logout', actor: 'admin' });
  } catch (auditErr) {
    console.warn('[AUDIT] Failed to record logout audit:', auditErr);
  }

  return res;
}
