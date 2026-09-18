import { NextRequest, NextResponse } from 'next/server';
import { getSupabasePublic } from '@/lib/supabase';
import { createHash, createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Public Confession Submission API (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Accepts { text } from anonymous users.
// All security fields (hash, IP HMAC, status, timestamps) are generated server-side.
// Uses the anon/public Supabase client — respects RLS (INSERT only).
// Rate limiting, cooldown, and duplicate detection use atomic Postgres RPC:
// check_and_increment_rate_limit().
// ---------------------------------------------------------------------------

// --- Security & Validation Constants ---
const MIN_TEXT_LENGTH = 10;
const MAX_TEXT_LENGTH = 2000;
const RATE_LIMIT_MAX = 3;                  // max 3 submissions per hour per IP
const RATE_LIMIT_WINDOW_SECONDS = 3600;     // 1 hour window
const COOLDOWN_SECONDS = 60;               // 60s cooldown between submissions
const MIN_SUBMISSION_TIME_MS = 2000;        // reject submissions faster than 2s (bot timing)
const DUPLICATE_WINDOW_HOURS = 24;         // duplicate detection window (24h)

// --- Helper Functions ---

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width characters
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .trim();
}

function computeContentHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

function computeIpHash(ip: string): string {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret) {
    // Fallback in dev if IP_HASH_SECRET is not set
    return createHash('sha256').update(ip).digest('hex');
  }
  return createHmac('sha256', secret).update(ip).digest('hex');
}

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }
  return '127.0.0.1';
}

// --- Main Handler ---

export async function POST(req: NextRequest) {
  try {
    // ── 1. Parse JSON body ──
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Invalid request format' },
        { status: 400 }
      );
    }

    const payload = body as Record<string, unknown>;

    // ── 2. Honeypot check (anti-bot) ──
    // If hidden honeypot field has any value, silently return success without persisting
    if (
      payload._hp_field &&
      typeof payload._hp_field === 'string' &&
      payload._hp_field.trim().length > 0
    ) {
      return NextResponse.json({ success: true });
    }

    // ── 3. Timing check (anti-bot) ──
    // Submissions completed unrealistically fast (< 2 seconds) are rejected silently
    if (payload._submit_ts && typeof payload._submit_ts === 'number') {
      const elapsed = Date.now() - payload._submit_ts;
      if (elapsed < MIN_SUBMISSION_TIME_MS) {
        return NextResponse.json({ success: true });
      }
    }

    // ── 4. Input validation ──
    const rawText = payload.text;
    if (!rawText || typeof rawText !== 'string') {
      return NextResponse.json(
        { error: 'Text is required' },
        { status: 400 }
      );
    }

    const trimmedText = rawText.trim();
    if (trimmedText.length === 0) {
      return NextResponse.json(
        { error: 'Confession cannot be empty or whitespace-only' },
        { status: 400 }
      );
    }

    if (trimmedText.length < MIN_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Confession must be at least ${MIN_TEXT_LENGTH} characters` },
        { status: 400 }
      );
    }

    if (trimmedText.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Confession must be under ${MAX_TEXT_LENGTH} characters` },
        { status: 400 }
      );
    }

    // ── 5. Server-side field generation ──
    const normalizedText = normalizeText(trimmedText);
    const contentHash = computeContentHash(normalizedText);
    const clientIp = getClientIp(req);
    const ipHash = computeIpHash(clientIp);
    const now = new Date().toISOString();

    const supabase = getSupabasePublic();

    // ── 6. Cooldown check (atomic Postgres RPC) ──
    const { data: cooldownResult, error: cooldownError } = await supabase.rpc(
      'check_and_increment_rate_limit',
      {
        p_key: `cooldown:${ipHash}`,
        p_limit: 1,
        p_window_seconds: COOLDOWN_SECONDS,
      }
    );

    if (cooldownError) {
      console.error('[SUBMISSION] Cooldown RPC error:', cooldownError.message);
    } else if (cooldownResult && !cooldownResult.allowed) {
      return NextResponse.json(
        { error: 'Please wait a moment before submitting again.' },
        { status: 429 }
      );
    }

    // ── 7. Hourly rate limiting (atomic Postgres RPC) ──
    const { data: rateResult, error: rateError } = await supabase.rpc(
      'check_and_increment_rate_limit',
      {
        p_key: `submission:${ipHash}`,
        p_limit: RATE_LIMIT_MAX,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      }
    );

    if (rateError) {
      console.error('[SUBMISSION] Rate limit RPC error:', rateError.message);
    } else if (rateResult && !rateResult.allowed) {
      return NextResponse.json(
        {
          error:
            'You have reached the limit of 3 confessions per hour. Please try again later.',
        },
        { status: 429 }
      );
    }

    // ── 8. Duplicate detection within window (atomic Postgres RPC) ──
    const { data: duplicateResult, error: duplicateError } = await supabase.rpc(
      'check_and_increment_rate_limit',
      {
        p_key: `content:${contentHash}`,
        p_limit: 1,
        p_window_seconds: DUPLICATE_WINDOW_HOURS * 3600,
      }
    );

    if (duplicateError) {
      console.error('[SUBMISSION] Duplicate RPC error:', duplicateError.message);
    } else if (duplicateResult && !duplicateResult.allowed) {
      return NextResponse.json(
        { error: 'This confession has already been submitted.' },
        { status: 409 }
      );
    }

    // ── 9. Insert into Supabase (INSERT only, respecting RLS) ──
    // NOTE: We do NOT use .select() here because the RLS policy only allows anon
    // to INSERT, not SELECT. PostgREST evaluates SELECT permissions when returning
    // data. Omitting .select() sends `Prefer: return=minimal` which succeeds.
    const { error: insertError } = await supabase
      .from('confessions')
      .insert({
        text: trimmedText,
        normalized_text: normalizedText,
        content_hash: contentHash,
        status: 'pending',
        submitter_ip_hash: ipHash,
        sheets_sync_status: 'pending',
        created_at: now,
        updated_at: now,
      });

    if (insertError) {
      console.error('[SUBMISSION] Supabase insert error:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to submit confession. Please try again.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Confession submitted successfully',
    });
  } catch (error) {
    console.error('[SUBMISSION] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Server error' },
      { status: 500 }
    );
  }
}
