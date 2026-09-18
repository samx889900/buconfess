import { NextRequest, NextResponse } from 'next/server';
import { signToken, verifyAdminCredentials } from '../../../../lib/auth';
import { recordAuditLog } from '../../../../lib/audit';

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password are required' },
        { status: 400 }
      );
    }

    const isValid = await verifyAdminCredentials(username, password);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    const token = signToken({ id: 1, username });
    const res = NextResponse.json({ success: true });
    res.cookies.set('admin_token', token, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });

    try {
      await recordAuditLog({
        action: 'admin_login',
        actor: username,
        details: { user_agent: req.headers.get('user-agent') || 'unknown' },
      });
    } catch (auditErr) {
      console.warn('[AUDIT] Failed to record login audit:', auditErr);
    }

    return res;
  } catch (error) {
    console.error('[LOGIN] Authentication error:', error);
    return NextResponse.json(
      { error: 'Authentication failed' },
      { status: 500 }
    );
  }
}
