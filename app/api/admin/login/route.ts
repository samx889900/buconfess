import { NextRequest, NextResponse } from 'next/server';
import { signToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const envUser = process.env.ADMIN_USERNAME || 'admin';
  const envPass = process.env.ADMIN_PASSWORD || 'admin123';
  
  if (username !== envUser || password !== envPass) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
  
  const token = signToken({ id: 1, username });
  const res = NextResponse.json({ success: true });
  res.cookies.set('admin_token', token, { httpOnly: true, maxAge: 60 * 60 * 24 * 7, path: '/', sameSite: 'lax' });
  return res;
}
