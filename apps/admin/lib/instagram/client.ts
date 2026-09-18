import {
  GRAPH_API_BASE_URL,
  DEFAULT_CONTAINER_POLL_INTERVAL_MS,
  DEFAULT_CONTAINER_POLL_TIMEOUT_MS,
  RECOVERY_CONFIG,
} from './config';
import {
  ContainerStatusResponse,
  GraphApiResponse,
  RecentMediaItem,
  TokenValidationResult,
} from './types';
import { redactSecrets } from '../redact';

// ---------------------------------------------------------------------------
// Instagram Graph API Client (BU Confessions v3.4 — Phase E)
// ---------------------------------------------------------------------------
// Features:
//   - Centralized Graph API endpoint calls
//   - Automatic secret redaction on URLs, headers, and errors
//   - Jittered exponential backoff retry on transient 429 / 5xx errors
//   - Respects Retry-After header
//   - Bounded status polling with milestone progress callbacks
//   - Injectable fetchFn for deterministic offline unit testing
// ---------------------------------------------------------------------------

export interface RequestOptions {
  fetchFn?: typeof fetch;
  maxRetries?: number;
  initialBackoffMs?: number;
}

export interface PollOptions extends RequestOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?: (containerId: string, elapsedMs: number) => Promise<void> | void;
}

/** Non-retryable Meta error codes */
const NON_RETRYABLE_CODES = new Set([
  190, // OAuthException (token expired / revoked)
  100, // Invalid parameter
  10, // Permission denied
  200, // Permission error
  368, // Blocked from performing action
]);

/**
 * Executes an HTTP request against the Meta Graph API with transient error
 * retry and comprehensive secret redaction.
 */
export async function graphFetch<T = Record<string, unknown>>(
  endpoint: string,
  options: RequestInit & RequestOptions = {}
): Promise<GraphApiResponse<T>> {
  const fetcher = options.fetchFn || fetch;
  const maxRetries = options.maxRetries ?? 3;
  const initialBackoff = options.initialBackoffMs ?? 500;

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${GRAPH_API_BASE_URL}/${endpoint.replace(/^\//, '')}`;

  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const response = await fetcher(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });

      const text = await response.text();
      let data: GraphApiResponse<T>;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: { message: `Non-JSON response (status ${response.status}): ${text.slice(0, 100)}` } };
      }

      // Check HTTP status or Meta error payload
      if (!response.ok || data.error) {
        const errorDetail = data.error || {};
        const code = errorDetail.code;
        const message = errorDetail.message || `Graph API error (HTTP ${response.status})`;

        // Check if explicitly non-retryable
        if (code && NON_RETRYABLE_CODES.has(code)) {
          const sanitized = redactSecrets(`Graph API non-retryable error [${code}]: ${message}`);
          throw new Error(sanitized);
        }

        // Check if retryable (429 rate limit or 5xx server error)
        const isTransient = response.status === 429 || response.status >= 500;
        if (isTransient && attempt <= maxRetries) {
          // Check Retry-After header
          const retryAfterHeader = response.headers.get('retry-after');
          let delayMs = initialBackoff * Math.pow(2, attempt - 1) + Math.random() * 200;

          if (retryAfterHeader) {
            const parsedSeconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
              delayMs = parsedSeconds * 1000;
            }
          }

          console.warn(
            redactSecrets(
              `[INSTAGRAM CLIENT] Transient error (${response.status}) on ${endpoint}. Retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${maxRetries})...`
            )
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        // Final failure after retries exhausted
        const sanitized = redactSecrets(
          `Graph API failure [HTTP ${response.status}${code ? ` / code ${code}` : ''}]: ${message}`
        );
        throw new Error(sanitized);
      }

      return data;
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);

      // If already categorized as non-retryable, re-throw immediately
      if (errMessage.includes('non-retryable')) {
        throw err;
      }

      // Check for network/timeout error
      if (attempt <= maxRetries) {
        const delayMs = initialBackoff * Math.pow(2, attempt - 1) + Math.random() * 200;
        console.warn(
          redactSecrets(
            `[INSTAGRAM CLIENT] Network/fetch error on ${endpoint}: ${errMessage}. Retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${maxRetries})...`
          )
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      throw new Error(redactSecrets(`Graph API transport failure: ${errMessage}`));
    }
  }

  throw new Error(redactSecrets(`Graph API retries exhausted for ${endpoint}`));
}

/**
 * Convenience wrapper for GET requests.
 */
export async function graphGet<T = Record<string, unknown>>(
  path: string,
  accessToken: string,
  options: RequestOptions = {}
): Promise<GraphApiResponse<T>> {
  const separator = path.includes('?') ? '&' : '?';
  const fullPath = `${path}${separator}access_token=${encodeURIComponent(accessToken)}`;
  return graphFetch<T>(fullPath, { method: 'GET', ...options });
}

/**
 * Convenience wrapper for POST requests.
 */
export async function graphPost<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  accessToken: string,
  options: RequestOptions = {}
): Promise<GraphApiResponse<T>> {
  return graphFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify({ ...body, access_token: accessToken }),
    ...options,
  });
}

/**
 * Validates access token and checks expiration using Meta debug_token endpoint.
 */
export async function validateToken(
  accessToken: string,
  options: RequestOptions = {}
): Promise<TokenValidationResult> {
  if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
    return { isValid: false, needsRefresh: false, error: 'Token string is empty or missing.' };
  }

  try {
    const data = await graphGet<{
      data?: {
        is_valid?: boolean;
        expires_at?: number;
        scopes?: string[];
        error?: { message?: string };
      };
    }>(`debug_token?input_token=${encodeURIComponent(accessToken)}`, accessToken, options);

    const info = data.data || data;
    const tokenData = (info as { data?: { is_valid?: boolean; expires_at?: number; scopes?: string[] } }).data || info;

    const isValid = Boolean((tokenData as { is_valid?: boolean }).is_valid ?? true);
    const expiresAtSeconds = (tokenData as { expires_at?: number }).expires_at;

    let expiresAtIso: string | undefined;
    let needsRefresh = false;

    if (expiresAtSeconds && expiresAtSeconds > 0) {
      expiresAtIso = new Date(expiresAtSeconds * 1000).toISOString();
      const nowMs = Date.now();
      const expiresMs = expiresAtSeconds * 1000;
      const msUntilExpiry = expiresMs - nowMs;
      const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);

      if (daysUntilExpiry <= 0) {
        return {
          isValid: false,
          expiresAt: expiresAtIso,
          expiresInSeconds: 0,
          needsRefresh: true,
          error: 'Access token is expired.',
        };
      }

      if (daysUntilExpiry <= RECOVERY_CONFIG.tokenRefreshThresholdDays) {
        needsRefresh = true;
      }
    }

    return {
      isValid,
      expiresAt: expiresAtIso,
      needsRefresh,
      scopes: (tokenData as { scopes?: string[] }).scopes,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isValid: false,
      needsRefresh: false,
      error: redactSecrets(`Token validation failed: ${msg}`),
    };
  }
}

/**
 * Exchanges a long-lived user/page token before expiry.
 */
export async function refreshToken(
  accessToken: string,
  appId?: string,
  appSecret?: string,
  options: RequestOptions = {}
): Promise<{ accessToken: string; expiresInSeconds?: number }> {
  // If app credentials are provided, use fb_exchange_token
  if (appId && appSecret) {
    const path = `oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(
      appId
    )}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(
      accessToken
    )}`;

    const data = await graphFetch<{ access_token?: string; expires_in?: number }>(path, options);
    if (!data.access_token) {
      throw new Error('Refresh response did not contain an access_token');
    }

    return {
      accessToken: data.access_token,
      expiresInSeconds: data.expires_in,
    };
  }

  // Otherwise, attempt Instagram User Token refresh endpoint
  const igRefreshUrl = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(
    accessToken
  )}`;

  const res = await graphFetch<{ access_token?: string; expires_in?: number }>(igRefreshUrl, options);
  if (!res.access_token) {
    throw new Error('Instagram refresh endpoint did not return an access_token');
  }

  return {
    accessToken: res.access_token,
    expiresInSeconds: res.expires_in,
  };
}

/**
 * Creates a single image container on Instagram.
 */
export async function createSingleContainer(
  igUserId: string,
  accessToken: string,
  imageUrl: string,
  caption: string,
  options: RequestOptions = {}
): Promise<string> {
  const data = await graphPost(
    `${igUserId}/media`,
    {
      image_url: imageUrl,
      caption,
    },
    accessToken,
    options
  );

  if (!data.id) {
    throw new Error('Single image container creation response did not include an ID.');
  }

  return data.id;
}

/**
 * Creates a carousel child image container (is_carousel_item = true).
 */
export async function createChildContainer(
  igUserId: string,
  accessToken: string,
  imageUrl: string,
  options: RequestOptions = {}
): Promise<string> {
  const data = await graphPost(
    `${igUserId}/media`,
    {
      image_url: imageUrl,
      is_carousel_item: true,
    },
    accessToken,
    options
  );

  if (!data.id) {
    throw new Error('Carousel child container creation response did not include an ID.');
  }

  return data.id;
}

/**
 * Creates a parent carousel container referencing children IDs.
 */
export async function createCarouselContainer(
  igUserId: string,
  accessToken: string,
  childContainerIds: string[],
  caption: string,
  options: RequestOptions = {}
): Promise<string> {
  if (!childContainerIds || childContainerIds.length < 2) {
    throw new Error(`Carousel requires at least 2 child container IDs (got ${childContainerIds?.length || 0}).`);
  }

  const data = await graphPost(
    `${igUserId}/media`,
    {
      media_type: 'CAROUSEL',
      children: childContainerIds,
      caption,
    },
    accessToken,
    options
  );

  if (!data.id) {
    throw new Error('Parent carousel container creation response did not include an ID.');
  }

  return data.id;
}

/**
 * Polls an Instagram media container until status reaches FINISHED or ERROR.
 */
export async function pollContainerStatus(
  containerId: string,
  accessToken: string,
  options: PollOptions = {}
): Promise<ContainerStatusResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTAINER_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_CONTAINER_POLL_INTERVAL_MS;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const data = await graphGet<{ status_code?: string; status?: string }>(
      `${containerId}?fields=status_code,status`,
      accessToken,
      options
    );

    const statusCode = data.status_code || 'IN_PROGRESS';

    if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') {
      return {
        id: containerId,
        statusCode: 'FINISHED',
        status: data.status,
      };
    }

    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      const errorMsg = redactSecrets(
        `Container ${containerId} failed processing with status ${statusCode}: ${data.status || 'unknown'}`
      );
      throw new Error(errorMsg);
    }

    // Still IN_PROGRESS — notify milestone hook
    const elapsedMs = Date.now() - startTime;
    if (options.onProgress) {
      await options.onProgress(containerId, elapsedMs);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    redactSecrets(`Container ${containerId} did not finish processing within timeout (${timeoutMs / 1000}s).`)
  );
}

/**
 * Dispatches the media_publish call to publish a container to Instagram.
 */
export async function publishMedia(
  igUserId: string,
  accessToken: string,
  containerId: string,
  options: RequestOptions = {}
): Promise<{ id: string }> {
  const data = await graphPost(
    `${igUserId}/media_publish`,
    { creation_id: containerId },
    accessToken,
    options
  );

  if (!data.id) {
    throw new Error('Instagram media_publish did not return a published media ID.');
  }

  return { id: data.id };
}

/**
 * Verifies that a published Instagram media object exists and fetches permalink.
 */
export async function verifyMedia(
  mediaId: string,
  accessToken: string,
  options: RequestOptions = {}
): Promise<{ id: string; permalink: string; timestamp?: string }> {
  const data = await graphGet<{ id?: string; permalink?: string; timestamp?: string }>(
    `${mediaId}?fields=id,permalink,timestamp`,
    accessToken,
    options
  );

  if (!data.id || !data.permalink) {
    throw new Error(
      redactSecrets(`Media verification failed: Instagram media ${mediaId} returned no permalink.`)
    );
  }

  return {
    id: data.id,
    permalink: data.permalink,
    timestamp: data.timestamp,
  };
}

/**
 * Retrieves the recent media posts for an Instagram user account.
 */
export async function getRecentMedia(
  igUserId: string,
  accessToken: string,
  limit: number = RECOVERY_CONFIG.recentMediaLimit,
  options: RequestOptions = {}
): Promise<RecentMediaItem[]> {
  const data = await graphGet<{
    data?: RecentMediaItem[];
  }>(`${igUserId}/media?fields=id,caption,permalink,timestamp&limit=${limit}`, accessToken, options);

  const items = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? (data as RecentMediaItem[]) : []);
  return items;
}
