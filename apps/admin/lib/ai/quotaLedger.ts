// ---------------------------------------------------------------------------
// Gemini Multi-Project Quota Ledger & Scheduler (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Core Invariants:
//   1. Tracks quota, attempts, and health PER (projectKey, model) pair.
//   2. Rate limits and daily quotas apply per Google Cloud project and per model.
//   3. Enforces a conservative SAFETY BUDGET (e.g. 18 RPD) below the provider limit (20 RPD).
//   4. Never deliberately consumes the final request (safety margin of 2 reserved).
//   5. Fair distribution: prefers healthy projects with highest remaining budget.
//   6. Distinguishes infrastructure failures (503, 429, timeouts) from model uncertainty.
//   7. API keys remain strictly in memory closures — NEVER logged or exposed.
// ---------------------------------------------------------------------------

import { AI_CONFIG, MODERATION_MODELS } from './config';
import { calculatePacificMidnightReset, classifyGeminiError, GeminiErrorClassification } from './credentialPool';

export interface QuotaLedgerEntry {
  projectKey: string;           // Non-secret identifier e.g. "project-1"
  model: string;                // e.g. "gemini-3.5-flash"
  requestsToday: number;
  successfulRequests: number;
  failedRequests: number;
  count503: number;
  count429: number;
  countTimeout: number;
  lastRequestAt: number | null;
  cooldownUntil: number | null;  // Epoch ms
  dailyBudget: number;          // Conservative limit (e.g. 18)
  observedLimit: number | null;  // Provider limit (e.g. 20)
  healthStatus: 'HEALTHY' | 'COOLDOWN' | 'EXHAUSTED' | 'DISABLED';
  unavailableReason: string | null;
  activeInFlight: number;
}

export interface QuotaProjectSummary {
  projectKey: string;
  models: Record<string, {
    requestsToday: number;
    successfulRequests: number;
    failedRequests: number;
    count503: number;
    count429: number;
    countTimeout: number;
    dailyBudget: number;
    remainingBudget: number;
    healthStatus: string;
    cooldownUntil: string | null;
    cooldownRemainingHours: string | null;
  }>;
}

export interface QuotaLedgerSummaryReport {
  timestamp: string;
  projects: QuotaProjectSummary[];
  totalSafeRequestsAvailable: {
    primary: number;   // gemini-3.5-flash
    secondary: number; // gemini-3.7-flash
    tertiary: number;  // gemini-3.8-flash
  };
  totalRequestsTodayAllProjects: number;
  totalSuccessfulTodayAllProjects: number;
  total503AllProjects: number;
  total429AllProjects: number;
  totalTimeoutAllProjects: number;
  callsPerDecisionMetric: number | null;
}

export class GeminiQuotaLedger {
  #ledger = new Map<string, QuotaLedgerEntry>(); // key: `${projectKey}::${model}`
  #knownProjects = new Set<string>();
  #permanentlyDisabledProjects = new Set<string>();
  #permanentlyDisabledModels = new Set<string>();
  #totalDecisionsCount = 0;
  #totalGeminiCallsCount = 0;

  constructor() {
    this.initSlots(['project-1', 'project-2', 'project-3', 'project-4', 'project-5']);
  }

  /**
   * Initializes or updates project slot identifiers in the ledger.
   */
  public initSlots(projectKeys: string[]): void {
    const models = [
      MODERATION_MODELS.PRIMARY,
      MODERATION_MODELS.SECONDARY,
      MODERATION_MODELS.TERTIARY,
    ];

    for (const pKey of projectKeys) {
      this.#knownProjects.add(pKey);
      for (const model of models) {
        const key = `${pKey}::${model}`;
        if (!this.#ledger.has(key)) {
          this.#ledger.set(key, {
            projectKey: pKey,
            model,
            requestsToday: 0,
            successfulRequests: 0,
            failedRequests: 0,
            count503: 0,
            count429: 0,
            countTimeout: 0,
            lastRequestAt: null,
            cooldownUntil: null,
            dailyBudget: AI_CONFIG.quota.dailyBudgetPerModel,
            observedLimit: AI_CONFIG.quota.freeTierObservedLimit,
            healthStatus: 'HEALTHY',
            unavailableReason: null,
            activeInFlight: 0,
          });
        }
      }
    }
  }

  /**
   * Checks cooldown expiry and updates entry state.
   */
  #checkCooldownExpiry(entry: QuotaLedgerEntry, now = Date.now()): void {
    if (this.#permanentlyDisabledProjects.has(entry.projectKey)) {
      entry.healthStatus = 'DISABLED';
      entry.unavailableReason = 'Permanent authentication or permission failure';
      return;
    }

    if (this.#permanentlyDisabledModels.has(entry.model)) {
      entry.healthStatus = 'DISABLED';
      entry.unavailableReason = 'Model retired or not found (404)';
      return;
    }

    if (entry.cooldownUntil && now >= entry.cooldownUntil) {
      // Cooldown expired!
      entry.cooldownUntil = null;
      entry.unavailableReason = null;
      if (entry.requestsToday >= entry.dailyBudget) {
        // Daily quota reset
        entry.requestsToday = 0;
      }
      entry.healthStatus = 'HEALTHY';
    }
  }

  /**
   * Returns a specific ledger entry, updating cooldown if expired.
   */
  public getEntry(projectKey: string, model: string): QuotaLedgerEntry | undefined {
    const key = `${projectKey}::${model}`;
    const entry = this.#ledger.get(key);
    if (entry) {
      this.#checkCooldownExpiry(entry);
    }
    return entry;
  }

  /**
   * Checks if a project slot has available budget and is healthy for a model.
   */
  public isAvailable(projectKey: string, model: string, now = Date.now()): boolean {
    const entry = this.getEntry(projectKey, model);
    if (!entry) return false;
    this.#checkCooldownExpiry(entry, now);

    if (entry.healthStatus === 'DISABLED') return false;
    if (entry.healthStatus === 'EXHAUSTED') return false;
    if (entry.cooldownUntil && now < entry.cooldownUntil) return false;
    if (entry.requestsToday >= entry.dailyBudget) return false; // Enforce safety budget!

    return true;
  }

  /**
   * Selects the best project slot for a model using quota-aware scheduling:
   * 1. Healthy and within daily budget
   * 2. Highest remaining safety budget
   * 3. Lowest in-flight active requests
   * 4. Lowest total requests today (fair distribution across projects)
   */
  public selectBestProject(model: string, availableProjectKeys?: string[]): string | null {
    const now = Date.now();
    const candidateKeys = availableProjectKeys && availableProjectKeys.length > 0
      ? availableProjectKeys.filter((k) => this.#knownProjects.has(k))
      : Array.from(this.#knownProjects);

    const eligible: { key: string; remainingBudget: number; inFlight: number; requestsToday: number }[] = [];

    for (const pKey of candidateKeys) {
      if (this.isAvailable(pKey, model, now)) {
        const entry = this.getEntry(pKey, model)!;
        eligible.push({
          key: pKey,
          remainingBudget: Math.max(0, entry.dailyBudget - entry.requestsToday),
          inFlight: entry.activeInFlight,
          requestsToday: entry.requestsToday,
        });
      }
    }

    if (eligible.length === 0) return null;

    // Sort: highest remaining budget first, tiebreak with lowest in-flight, then lowest requestsToday
    eligible.sort((a, b) => {
      if (b.remainingBudget !== a.remainingBudget) {
        return b.remainingBudget - a.remainingBudget; // Most budget first
      }
      if (a.inFlight !== b.inFlight) {
        return a.inFlight - b.inFlight; // Least busy first
      }
      return a.requestsToday - b.requestsToday; // Fair distribution
    });

    return eligible[0].key;
  }

  /**
   * Records a request attempt about to be made.
   */
  public recordAttempt(projectKey: string, model: string): void {
    const entry = this.getEntry(projectKey, model);
    if (entry) {
      entry.requestsToday++;
      entry.activeInFlight++;
      entry.lastRequestAt = Date.now();
      this.#totalGeminiCallsCount++;
    }
  }

  /**
   * Records a successful request.
   */
  public recordSuccess(projectKey: string, model: string, _latencyMs?: number): void {
    const entry = this.getEntry(projectKey, model);
    if (entry) {
      entry.activeInFlight = Math.max(0, entry.activeInFlight - 1);
      entry.successfulRequests++;
      entry.healthStatus = 'HEALTHY';
    }
  }

  /**
   * Records a completed decision for calls-per-decision metric tracking.
   */
  public recordDecision(): void {
    this.#totalDecisionsCount++;
  }

  /**
   * Records a failure and updates health status / cooldowns accordingly.
   */
  public recordFailure(
    projectKey: string,
    model: string,
    error: unknown,
    classification?: GeminiErrorClassification
  ): void {
    const entry = this.getEntry(projectKey, model);
    if (!entry) return;

    entry.activeInFlight = Math.max(0, entry.activeInFlight - 1);
    entry.failedRequests++;

    const errClass = classification || classifyGeminiError(error);

    switch (errClass) {
      case 'DAILY_QUOTA_EXHAUSTED': {
        entry.count429++;
        entry.healthStatus = 'EXHAUSTED';
        const resetTime = calculatePacificMidnightReset();
        entry.cooldownUntil = resetTime;
        const hours = ((resetTime - Date.now()) / 3600000).toFixed(1);
        entry.unavailableReason = `Daily quota exhausted (cooldown for ~${hours}h until Pacific midnight)`;
        break;
      }

      case 'SERVICE_UNAVAILABLE': {
        entry.count503++;
        // Bounded cooldown: 60s temporary backoff so other healthy slots can be used
        entry.healthStatus = 'COOLDOWN';
        entry.cooldownUntil = Date.now() + 60_000;
        entry.unavailableReason = 'Transient 503 high demand (temporary 60s cooldown)';
        break;
      }

      case 'TIMEOUT': {
        entry.countTimeout++;
        // 30s temporary backoff on repeated timeout
        entry.healthStatus = 'COOLDOWN';
        entry.cooldownUntil = Date.now() + 30_000;
        entry.unavailableReason = 'Request deadline exceeded (temporary 30s cooldown)';
        break;
      }

      case 'AUTHENTICATION':
      case 'PERMISSION': {
        this.#permanentlyDisabledProjects.add(projectKey);
        entry.healthStatus = 'DISABLED';
        entry.unavailableReason = `Permanent credential failure (${errClass})`;
        break;
      }

      case 'MODEL_NOT_FOUND': {
        this.#permanentlyDisabledModels.add(model);
        entry.healthStatus = 'DISABLED';
        entry.unavailableReason = 'Model retired or not available (404)';
        break;
      }

      default:
        // Do not alter cooldown on unknown transient errors
        break;
    }
  }

  /**
   * Returns safe requests available right now for a given model.
   */
  public getSafeRequestsAvailable(model: string = MODERATION_MODELS.PRIMARY): number {
    const now = Date.now();
    let total = 0;
    for (const pKey of this.#knownProjects) {
      if (this.isAvailable(pKey, model, now)) {
        const entry = this.getEntry(pKey, model);
        if (entry) {
          total += Math.max(0, entry.dailyBudget - entry.requestsToday);
        }
      }
    }
    return total;
  }

  /**
   * Generates a sanitized summary report with ZERO secrets.
   */
  public getLedgerSummary(): QuotaLedgerSummaryReport {
    const now = Date.now();
    const projectsSummary: QuotaProjectSummary[] = [];

    for (const pKey of Array.from(this.#knownProjects).sort()) {
      const modelsData: QuotaProjectSummary['models'] = {};
      const models = [
        MODERATION_MODELS.PRIMARY,
        MODERATION_MODELS.SECONDARY,
        MODERATION_MODELS.TERTIARY,
      ];

      for (const m of models) {
        const entry = this.getEntry(pKey, m);
        if (entry) {
          this.#checkCooldownExpiry(entry, now);
          const remaining = Math.max(0, entry.dailyBudget - entry.requestsToday);
          const inCooldown = entry.cooldownUntil && entry.cooldownUntil > now;
          const remHours = inCooldown ? ((entry.cooldownUntil! - now) / 3600000).toFixed(1) : null;

          modelsData[m] = {
            requestsToday: entry.requestsToday,
            successfulRequests: entry.successfulRequests,
            failedRequests: entry.failedRequests,
            count503: entry.count503,
            count429: entry.count429,
            countTimeout: entry.countTimeout,
            dailyBudget: entry.dailyBudget,
            remainingBudget: remaining,
            healthStatus: entry.healthStatus,
            cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
            cooldownRemainingHours: remHours,
          };
        }
      }

      projectsSummary.push({
        projectKey: pKey,
        models: modelsData,
      });
    }

    let totToday = 0;
    let totSuccess = 0;
    let tot503 = 0;
    let tot429 = 0;
    let totTimeout = 0;

    for (const entry of this.#ledger.values()) {
      totToday += entry.requestsToday;
      totSuccess += entry.successfulRequests;
      tot503 += entry.count503;
      tot429 += entry.count429;
      totTimeout += entry.countTimeout;
    }

    const callsPerDecision = this.#totalDecisionsCount > 0
      ? parseFloat((this.#totalGeminiCallsCount / this.#totalDecisionsCount).toFixed(2))
      : null;

    return {
      timestamp: new Date().toISOString(),
      projects: projectsSummary,
      totalSafeRequestsAvailable: {
        primary: this.getSafeRequestsAvailable(MODERATION_MODELS.PRIMARY),
        secondary: this.getSafeRequestsAvailable(MODERATION_MODELS.SECONDARY),
        tertiary: this.getSafeRequestsAvailable(MODERATION_MODELS.TERTIARY),
      },
      totalRequestsTodayAllProjects: totToday,
      totalSuccessfulTodayAllProjects: totSuccess,
      total503AllProjects: tot503,
      total429AllProjects: tot429,
      totalTimeoutAllProjects: totTimeout,
      callsPerDecisionMetric: callsPerDecision,
    };
  }

  /**
   * Resets ledger stats (primarily for unit tests).
   */
  public reset(): void {
    this.#permanentlyDisabledProjects.clear();
    this.#permanentlyDisabledModels.clear();
    this.#totalDecisionsCount = 0;
    this.#totalGeminiCallsCount = 0;

    for (const entry of this.#ledger.values()) {
      entry.requestsToday = 0;
      entry.successfulRequests = 0;
      entry.failedRequests = 0;
      entry.count503 = 0;
      entry.count429 = 0;
      entry.countTimeout = 0;
      entry.lastRequestAt = null;
      entry.cooldownUntil = null;
      entry.healthStatus = 'HEALTHY';
      entry.unavailableReason = null;
      entry.activeInFlight = 0;
    }
  }
}

// Global Singleton Quota Ledger
export const geminiQuotaLedger = new GeminiQuotaLedger();
