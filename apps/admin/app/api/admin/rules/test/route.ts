import { NextRequest, NextResponse } from 'next/server';
import { evaluateRulesPlayground } from '@/lib/ai/playground';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = typeof body?.text === 'string' ? body.text : '';

    if (!text.trim()) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Text input is required for rules playground testing.' },
        { status: 400 }
      );
    }

    const result = evaluateRulesPlayground(text);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[RULES PLAYGROUND API] Evaluation error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error?.message || 'Failed to simulate rules' },
      { status: 500 }
    );
  }
}
