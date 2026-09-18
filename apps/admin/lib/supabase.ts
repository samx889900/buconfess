import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase Client Factory
// ---------------------------------------------------------------------------
// Two clients are exposed:
//   1. `supabaseAdmin`  — uses the service_role key. Bypasses RLS.
//                         For use in API routes, agent scripts, and admin ops.
//   2. `supabasePublic` — uses the anon key. Respects RLS.
//                         For use in the public submission API.
// ---------------------------------------------------------------------------

let _adminClient: SupabaseClient | null = null;
let _publicClient: SupabaseClient | null = null;

/**
 * Returns a Supabase client configured with the **service_role** key.
 * Bypasses Row Level Security — use only in server-side admin/agent code.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (_adminClient) return _adminClient;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.'
    );
  }

  _adminClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _adminClient;
}

/**
 * Returns a Supabase client configured with the **anon** key.
 * Respects Row Level Security — safe for public-facing API routes.
 */
export function getSupabasePublic(): SupabaseClient {
  if (_publicClient) return _publicClient;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.'
    );
  }

  _publicClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _publicClient;
}
