import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase Public Client
// ---------------------------------------------------------------------------
// Uses the anon key — respects Row Level Security.
// Only used for public submission API.
// ---------------------------------------------------------------------------

let _client: SupabaseClient | null = null;

export function getSupabasePublic(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.'
    );
  }

  _client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}
