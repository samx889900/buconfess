import { NextResponse } from 'next/server';
import { getAdminHealthStatus } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const health = await getAdminHealthStatus();
    return NextResponse.json(health);
  } catch (error: any) {
    console.error('[HEALTH API] Unexpected health check failure:', error);
    return NextResponse.json(
      {
        timestamp: new Date().toISOString(),
        overall: 'error',
        error: error?.message || 'Failed to execute health check',
      },
      { status: 500 }
    );
  }
}
