// ---------------------------------------------------------------------------
// Instagram Graph API Configuration (BU Confessions v3.4 — Phase E)
// ---------------------------------------------------------------------------
// Meta Graph API v20.0 is deprecated in late September 2026.
// Active supported versions: v22.0 through v26.0.
// Default is set to v22.0, configurable via INSTAGRAM_GRAPH_API_VERSION.
// ---------------------------------------------------------------------------

export const DEFAULT_GRAPH_API_VERSION = 'v22.0';
export const GRAPH_API_VERSION = process.env.INSTAGRAM_GRAPH_API_VERSION || DEFAULT_GRAPH_API_VERSION;
export const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Maximum container poll timeout in ms (default 90s) */
export const DEFAULT_CONTAINER_POLL_TIMEOUT_MS = 90_000;
/** Polling interval in ms (default 3s) */
export const DEFAULT_CONTAINER_POLL_INTERVAL_MS = 3_000;

/** Instagram Container Constraints */
export const INSTAGRAM_LIMITS = {
  minSlides: 1,
  maxSlides: 10,
  minWidth: 320,
  maxWidth: 1440,
  minAspectRatio: 0.8, // 4:5 portrait
  maxAspectRatio: 1.91, // 1.91:1 landscape
  maxCaptionLength: 2200,
  /** Safe budget reserving room for hashtags, bio prompt, and correlation token */
  safeCaptionBudget: 2100,
  supportedMimeTypes: ['image/png', 'image/jpeg'],
} as const;

/** Recovery & Idempotency Constraints */
export const RECOVERY_CONFIG = {
  /** How many recent media items to query for correlation token discovery */
  recentMediaLimit: 15,
  /** Delay (ms) before initial ambiguous recovery inspection */
  ambiguousInitialBackoffMs: 5_000,
  /** Minutes to defer recheck when initial inspection yields 0 matches */
  ambiguousRecheckDelayMinutes: 5,
  /** Expiration buffer (days) to trigger automatic token refresh */
  tokenRefreshThresholdDays: 7,
} as const;
