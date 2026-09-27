// ---------------------------------------------------------------------------
// Gemini Multi-Project Credential Pool & Quota-Aware Failover (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Invariants:
//   1. Supports 3–4 independently configured Google Cloud project credentials.
//   2. Rate limits and quotas apply per Google Cloud project, not per API key.
//   3. API keys are strictly kept in private memory closures — NEVER exposed to
//      browser, client, logs, errors, or database.
//   4. Classifies errors into 9 distinct categories.
//   5. Handles 429 RPD (Daily Quota) with automatic cooldown until Pacific midnight.
//   6. Distributes multi-confession moderation requests across healthy projects (least-busy / round-robin).
//   7. Preserves backward compatibility with single GEMINI_API_KEY.
// ---------------------------------------------------------------------------

export type GeminiErrorClassification =
  | 'AUTHENTICATION'          // 401 / Invalid API key
  | 'PERMISSION'              // 403 / Billing disabled / API not enabled
  | 'MODEL_NOT_FOUND'         // 404 / Model retired or not found
  | 'INVALID_REQUEST'         // 400 / Bad request, malformed prompt
  | 'RATE_LIMIT_TRANSIENT'    // 429 RPM/TPM short-term throttling
  | 'DAILY_QUOTA_EXHAUSTED'   // 429 RPD daily requests exhausted (PerDay quotaId)
  | 'SERVICE_UNAVAILABLE'     // 503 Overloaded, high demand
  | 'TIMEOUT'                 // Request deadline exceeded (10s)
  | 'UNKNOWN';

export interface CredentialPoolSlot {
  id: string;                 // Non-secret identifier e.g. "project-1"
  available: boolean;
  unavailableReason: string | null;
  cooldownUntil: number | null; // Epoch milliseconds
  lastErrorType: GeminiErrorClassification | null;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  activeInFlight: number;
  totalRequests: number;
}

export { extractRetryAfterMs } from './config';

export interface LeasedCredential {
  id: string;
  slot: CredentialPoolSlot;
  apiKey: string;
}

/**
 * Classifies an unknown error returned from @google/genai or fetch into
 * one of 9 standardized Gemini error categories.
 */
export function classifyGeminiError(error: unknown): GeminiErrorClassification {
  if (!error) return 'UNKNOWN';

  const errStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const lower = errStr.toLowerCase();

  // Extract HTTP status code if present
  let status: number | undefined;
  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.status === 'number') status = errObj.status;
    else if (typeof errObj.code === 'number') status = errObj.code;
    else if (typeof errObj.statusCode === 'number') status = errObj.statusCode;
    else if (typeof errObj.response === 'object' && errObj.response !== null) {
      const resp = errObj.response as Record<string, unknown>;
      if (typeof resp.status === 'number') status = resp.status;
    }
  }

  // 1. Model Not Found (404)
  if (
    status === 404 ||
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('is not found') ||
    lower.includes('model not found')
  ) {
    return 'MODEL_NOT_FOUND';
  }

  // 2. Authentication (401)
  if (
    status === 401 ||
    lower.includes('401') ||
    lower.includes('api_key_invalid') ||
    lower.includes('unauthenticated') ||
    lower.includes('invalid api key') ||
    lower.includes('api key not valid')
  ) {
    return 'AUTHENTICATION';
  }

  // 3. Permission (403)
  if (
    status === 403 ||
    lower.includes('403') ||
    lower.includes('permission_denied') ||
    lower.includes('billing has not been enabled') ||
    lower.includes('api not enabled') ||
    lower.includes('service disabled')
  ) {
    return 'PERMISSION';
  }

  // 4. Timeouts & Deadline Exceeded
  if (
    lower.includes('deadline exceeded') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted') ||
    lower.includes('aborterror')
  ) {
    return 'TIMEOUT';
  }

  // 5. Service Unavailable / High Demand (503)
  if (
    status === 503 ||
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('overloaded') ||
    lower.includes('high demand')
  ) {
    return 'SERVICE_UNAVAILABLE';
  }

  // 6. Rate Limit & Quota Exhaustion (429 / RESOURCE_EXHAUSTED)
  if (
    status === 429 ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('resourceexhausted') ||
    lower.includes('exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    // Check for daily quota exhaustion signals
    if (
      lower.includes('perday') ||
      lower.includes('per day') ||
      lower.includes('daily') ||
      lower.includes('per_day') ||
      lower.includes('day quota') ||
      lower.includes('requests per day') ||
      lower.includes('generate_content_requests_per_day') ||
      lower.includes('free_tier_requests_per_day')
    ) {
      return 'DAILY_QUOTA_EXHAUSTED';
    }

    return 'RATE_LIMIT_TRANSIENT';
  }

  // 7. Invalid Request (400)
  if (
    status === 400 ||
    lower.includes('400') ||
    lower.includes('invalid_argument') ||
    lower.includes('bad request')
  ) {
    return 'INVALID_REQUEST';
  }

  return 'UNKNOWN';
}

/**
 * Calculates the next epoch timestamp (ms) corresponding to Google's daily quota
 * reset at midnight Pacific Time (America/Los_Angeles).
 */
export function calculatePacificMidnightReset(now: Date = new Date()): number {
  try {
    // Format now in America/Los_Angeles
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const partMap: Record<string, string> = {};
    for (const p of parts) partMap[p.type] = p.value;

    const ptYear = parseInt(partMap.year, 10);
    const ptMonth = parseInt(partMap.month, 10);
    const ptDay = parseInt(partMap.day, 10);

    // Pacific midnight is upcoming midnight: tomorrow at 00:00:00 Pacific
    // Construct tomorrow in Pacific time
    const tomorrowPT = new Date(Date.UTC(ptYear, ptMonth - 1, ptDay + 1, 0, 0, 0));

    // To find UTC offset for Pacific time on tomorrowPT:
    // Determine whether tomorrowPT is PDT (UTC-7) or PST (UTC-8)
    const tzCheck = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short',
    }).format(tomorrowPT);

    const offsetHours = tzCheck.includes('PDT') ? 7 : 8;
    const pacificMidnightUtcMs = Date.UTC(ptYear, ptMonth - 1, ptDay + 1, offsetHours, 0, 0);

    // If for any reason calculation is in the past, add 24 hours
    if (pacificMidnightUtcMs <= now.getTime()) {
      return pacificMidnightUtcMs + 24 * 60 * 60 * 1000;
    }

    return pacificMidnightUtcMs;
  } catch {
    // Fallback: 12 hours from now
    return now.getTime() + 12 * 60 * 60 * 1000;
  }
}

/**
 * Manages runtime health, project-level quota tracking, least-busy leasing,
 * and failover across Google Cloud project credentials.
 */
export class GeminiCredentialPool {
  #credentials = new Map<string, string>(); // Private: ID -> API Key (Never exposed)
  #slots = new Map<string, CredentialPoolSlot>();
  #roundRobinIndex = 0;

  constructor() {
    this.refreshFromEnv();
  }

  /**
   * Refreshes credentials from environment variables:
   *   GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_API_KEY_3, GEMINI_API_KEY_4
   * With fallback to GEMINI_API_KEY (mapped to project-1).
   */
  public refreshFromEnv(): void {
    const loaded: { id: string; apiKey: string }[] = [];

    // Check GEMINI_API_KEY_1..4
    for (let i = 1; i <= 4; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`]?.trim();
      if (key) {
        loaded.push({ id: `project-${i}`, apiKey: key });
      }
    }

    // Fallback to GEMINI_API_KEY
    if (loaded.length === 0) {
      const defaultKey = process.env.GEMINI_API_KEY?.trim();
      if (defaultKey) {
        loaded.push({ id: 'project-1', apiKey: defaultKey });
      }
    }

    this.#credentials.clear();
    for (const cred of loaded) {
      this.#credentials.set(cred.id, cred.apiKey);
      if (!this.#slots.has(cred.id)) {
        this.#slots.set(cred.id, {
          id: cred.id,
          available: true,
          unavailableReason: null,
          cooldownUntil: null,
          lastErrorType: null,
          consecutiveFailures: 0,
          lastSuccessAt: null,
          activeInFlight: 0,
          totalRequests: 0,
        });
      }
    }
  }

  /**
   * Manually sets credentials (primarily for deterministic unit testing).
   */
  public setCredentials(creds: { id: string; apiKey: string }[]): void {
    this.#credentials.clear();
    this.#slots.clear();
    this.#roundRobinIndex = 0;

    for (const cred of creds) {
      this.#credentials.set(cred.id, cred.apiKey);
      this.#slots.set(cred.id, {
        id: cred.id,
        available: true,
        unavailableReason: null,
        cooldownUntil: null,
        lastErrorType: null,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        activeInFlight: 0,
        totalRequests: 0,
      });
    }
  }

  /**
   * Returns a sanitized array of all slots with zero secret exposure.
   */
  public getSlots(): CredentialPoolSlot[] {
    const now = Date.now();
    const result: CredentialPoolSlot[] = [];

    for (const slot of this.#slots.values()) {
      // Check cooldown expiry
      if (slot.cooldownUntil && now >= slot.cooldownUntil) {
        slot.available = true;
        slot.cooldownUntil = null;
        slot.unavailableReason = null;
        slot.consecutiveFailures = 0;
      }
      result.push({ ...slot });
    }

    return result;
  }

  /**
   * Returns available slots (available === true and not in cooldown).
   */
  public getAvailableSlots(): CredentialPoolSlot[] {
    return this.getSlots().filter((s) => s.available);
  }

  /**
   * Leases a credential slot for in-flight request processing.
   * Uses least-busy (minimum active in-flight), breaking ties with round-robin.
   */
  public leaseSlot(preferredId?: string): LeasedCredential | null {
    const available = this.getAvailableSlots();
    if (available.length === 0) return null;

    let selectedSlot: CredentialPoolSlot | undefined;

    if (preferredId) {
      selectedSlot = available.find((s) => s.id === preferredId);
    }

    if (!selectedSlot) {
      // Find slots with minimum active in-flight count
      const minInFlight = Math.min(...available.map((s) => s.activeInFlight));
      const leastBusy = available.filter((s) => s.activeInFlight === minInFlight);

      // Round-robin among least-busy
      const idx = this.#roundRobinIndex % leastBusy.length;
      selectedSlot = leastBusy[idx];
      this.#roundRobinIndex = (this.#roundRobinIndex + 1) % 1000;
    }

    const internalSlot = this.#slots.get(selectedSlot.id);
    const apiKey = this.#credentials.get(selectedSlot.id);

    if (!internalSlot || !apiKey) return null;

    internalSlot.activeInFlight++;
    internalSlot.totalRequests++;

    return {
      id: selectedSlot.id,
      slot: { ...internalSlot },
      apiKey,
    };
  }

  /**
   * Returns a sanitized report containing all slots with zero secrets.
   */
  public getStatusReport(): { slots: CredentialPoolSlot[] } {
    return { slots: this.getSlots() };
  }

  /**
   * Releases an in-flight slot lease and records outcome metrics and cooldown states.
   */
  public releaseSlot(
    slotId: string,
    result: { success: boolean; error?: unknown; is404ModelNotFound?: boolean }
  ): void {
    const slot = this.#slots.get(slotId);
    if (!slot) return;

    slot.activeInFlight = Math.max(0, slot.activeInFlight - 1);

    if (result.success) {
      slot.lastSuccessAt = Date.now();
      slot.consecutiveFailures = 0;
      slot.lastErrorType = null;
      return;
    }

    // Handle failure
    slot.consecutiveFailures++;
    const classification = classifyGeminiError(result.error);
    slot.lastErrorType = classification;

    if (classification === 'AUTHENTICATION') {
      slot.available = false;
      slot.unavailableReason = 'Permanent authentication error (401: Invalid API key)';
      console.warn(`[GEMINI POOL] Slot '${slotId}' disabled permanently: Invalid API key.`);
    } else if (classification === 'PERMISSION') {
      slot.available = false;
      slot.unavailableReason = 'Permanent permission error (403: Billing disabled or API not enabled)';
      console.warn(`[GEMINI POOL] Slot '${slotId}' disabled permanently: Billing/Permission error.`);
    } else if (classification === 'DAILY_QUOTA_EXHAUSTED') {
      const resetTime = calculatePacificMidnightReset();
      slot.available = false;
      slot.cooldownUntil = resetTime;
      const hoursRemaining = Math.max(0, (resetTime - Date.now()) / (1000 * 60 * 60)).toFixed(1);
      slot.unavailableReason = `Daily project quota exhausted (cooldown for ~${hoursRemaining}h until Pacific midnight)`;
      console.warn(
        `[GEMINI POOL] Slot '${slotId}' entered daily quota cooldown until Pacific midnight (~${hoursRemaining}h remaining).`
      );
    } else if (classification === 'MODEL_NOT_FOUND') {
      // 404 does NOT disable the project; indicates model is unsupported.
      // Do nothing to slot availability.
    }
  }

  /**
   * Resets all slots and cooldowns (for test harness reset).
   */
  public reset(): void {
    this.refreshFromEnv();
    for (const slot of this.#slots.values()) {
      slot.available = true;
      slot.unavailableReason = null;
      slot.cooldownUntil = null;
      slot.lastErrorType = null;
      slot.consecutiveFailures = 0;
      slot.lastSuccessAt = null;
      slot.activeInFlight = 0;
      slot.totalRequests = 0;
    }
    this.#roundRobinIndex = 0;
  }
}

// Global Singleton Instance
export const geminiCredentialPool = new GeminiCredentialPool();
