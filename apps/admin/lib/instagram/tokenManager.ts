import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { getSecrets } from '../secrets';
import { validateToken, refreshToken } from './client';
import { StoredTokenMetadata, TokenValidationResult } from './types';
import { redactSecrets } from '../redact';

// ---------------------------------------------------------------------------
// Instagram Token Lifecycle & Security Manager (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Responsibilities:
//   1. Resolve active access token (from Supabase `settings` table or env fallback)
//   2. Validate expiration via Meta debug_token
//   3. Refresh token if within 7-day threshold (guarded by exclusive agent lock)
//   4. Persist refreshed token server-side into `settings.instagram_token_metadata`
//   5. Enforce strict server-only boundary: zero exposure to client/browser APIs
// ---------------------------------------------------------------------------

export const SETTINGS_KEY_TOKEN_METADATA = 'instagram_token_metadata';

/** Sensitive server-only settings keys that must never be returned to client */
export const SERVER_ONLY_SETTINGS_KEYS = new Set([SETTINGS_KEY_TOKEN_METADATA]);

export function isServerOnlySetting(key: string): boolean {
  return SERVER_ONLY_SETTINGS_KEYS.has(key);
}

/**
 * Retrieves the currently active Instagram access token.
 * Checks runtime metadata stored in Supabase `settings` first, falling back to
 * `INSTAGRAM_ACCESS_TOKEN` environment variable.
 */
export async function getActiveInstagramToken(
  supabase?: SupabaseClient
): Promise<{ token: string; source: 'settings' | 'env' }> {
  const client = supabase || getSupabaseAdmin();

  try {
    const { data, error } = await client
      .from('settings')
      .select('value')
      .eq('key', SETTINGS_KEY_TOKEN_METADATA)
      .maybeSingle();

    if (!error && data?.value) {
      const metadata = data.value as unknown as StoredTokenMetadata;
      if (metadata.accessToken && typeof metadata.accessToken === 'string') {
        return { token: metadata.accessToken, source: 'settings' };
      }
    }
  } catch {
    // If settings lookup fails, fallback to environment secrets
  }

  const secrets = getSecrets();
  return { token: secrets.instagramAccessToken, source: 'env' };
}

/**
 * Validates the current Instagram access token and refreshes it if expiring soon.
 * Server-only: tokens are never returned in plain text or logged.
 */
export async function performTokenPreflight(options: {
  supabaseClient?: SupabaseClient;
  fetchFn?: typeof fetch;
  appId?: string;
  appSecret?: string;
}): Promise<TokenValidationResult & { activeToken: string }> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const { token, source } = await getActiveInstagramToken(supabase);

  // 1. Validate token with Meta debug_token
  const validation = await validateToken(token, { fetchFn: options.fetchFn });

  if (!validation.isValid) {
    console.error(
      redactSecrets(`[TOKEN MANAGER] Preflight validation failed (source: ${source}): ${validation.error}`)
    );
    return { ...validation, activeToken: token };
  }

  // 2. If token is valid and doesn't need refresh, return immediately
  if (!validation.needsRefresh) {
    return { ...validation, activeToken: token };
  }

  // 3. Token is nearing expiration — attempt refresh
  console.log('[TOKEN MANAGER] Access token is near expiration threshold; attempting automatic refresh...');

  try {
    const refreshed = await refreshToken(token, options.appId, options.appSecret, {
      fetchFn: options.fetchFn,
    });

    const now = new Date();
    const expiresAt = refreshed.expiresInSeconds
      ? new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString()
      : new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(); // default 60d for long-lived token

    const metadata: StoredTokenMetadata = {
      accessToken: refreshed.accessToken,
      expiresAt,
      refreshedAt: now.toISOString(),
    };

    // 4. Persist refreshed token server-side into `settings`
    const { error: saveError } = await supabase
      .from('settings')
      .upsert({
        key: SETTINGS_KEY_TOKEN_METADATA,
        value: metadata as unknown as Record<string, unknown>,
        description: 'Server-only runtime Instagram access token metadata',
        updated_at: now.toISOString(),
        updated_by: 'token_manager',
      });

    if (saveError) {
      console.warn(
        redactSecrets(`[TOKEN MANAGER] Refreshed token but failed to persist to settings: ${saveError.message}`)
      );
    } else {
      console.log(`[TOKEN MANAGER] Refreshed Instagram token persisted successfully (expires: ${expiresAt}).`);
    }

    return {
      isValid: true,
      expiresAt,
      needsRefresh: false,
      activeToken: refreshed.accessToken,
    };
  } catch (refreshErr: unknown) {
    const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
    console.error(redactSecrets(`[TOKEN MANAGER] Token refresh attempt failed: ${msg}`));

    // If current token is still valid (just nearing expiry), we can still use it for this run
    return {
      ...validation,
      activeToken: token,
      error: redactSecrets(`Token refresh failed: ${msg}`),
    };
  }
}
