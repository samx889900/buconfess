import { NextRequest, NextResponse } from 'next/server';
import { getAdminSettings, updateAdminSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const settings = await getAdminSettings();
    return NextResponse.json({ settings });
  } catch (error: any) {
    console.error('[SETTINGS API] Failed to fetch settings:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error?.message || 'Failed to fetch settings' },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { key, value } = body;

    if (!key || typeof key !== 'string') {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Setting key is required and must be a string' },
        { status: 400 }
      );
    }

    if (value === undefined) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Setting value is required' },
        { status: 400 }
      );
    }

    const updated = await updateAdminSetting(key, value, { actor: 'admin' });
    return NextResponse.json({ success: true, setting: updated });
  } catch (error: any) {
    console.error('[SETTINGS API] Failed to update setting:', error);
    return NextResponse.json(
      { error: 'Bad Request', message: error?.message || 'Failed to update setting' },
      { status: 400 }
    );
  }
}
