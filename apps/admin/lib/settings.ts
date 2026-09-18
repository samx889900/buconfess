import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase';

// ---------------------------------------------------------------------------
// Typed Allowlist Settings (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Security Invariants:
//   1. Only explicitly allowlisted operational keys may be queried or updated.
//   2. Credentials, tokens, keys, and secrets are strictly forbidden.
//   3. All values are type-checked and range-checked before persistence.
//   4. Every modification generates an audit_log record.
// ---------------------------------------------------------------------------

export type SettingType = 'boolean' | 'number' | 'string';

export interface SettingDefinition<T = unknown> {
  key: string;
  type: SettingType;
  defaultValue: T;
  description: string;
  min?: number;
  max?: number;
  allowedValues?: string[];
}

export const SETTINGS_ALLOWLIST: Record<string, SettingDefinition> = {
  posting_enabled: {
    key: 'posting_enabled',
    type: 'boolean',
    defaultValue: true,
    description: 'Master operational switch for automated Instagram posting (pauses/resumes worker)',
  },
  max_per_batch: {
    key: 'max_per_batch',
    type: 'number',
    defaultValue: 10,
    min: 1,
    max: 100,
    description: 'Maximum confessions to process per automated agent run (range: 1–100)',
  },
  min_delay_between_posts_sec: {
    key: 'min_delay_between_posts_sec',
    type: 'number',
    defaultValue: 60,
    min: 10,
    max: 3600,
    description: 'Minimum delay in seconds between consecutive Instagram posts (range: 10–3600s)',
  },
  max_daily_posts: {
    key: 'max_daily_posts',
    type: 'number',
    defaultValue: 50,
    min: 1,
    max: 500,
    description: 'Maximum confessions allowed to be published per day (resets midnight IST, range: 1–500)',
  },
  auto_publish_approved: {
    key: 'auto_publish_approved',
    type: 'boolean',
    defaultValue: true,
    description: 'Whether approved confessions are automatically published by the worker',
  },
  dry_run_mode: {
    key: 'dry_run_mode',
    type: 'boolean',
    defaultValue: false,
    description: 'Execute agent runs in simulation mode without mutating database or dispatching Instagram posts',
  },
  image_retention_days: {
    key: 'image_retention_days',
    type: 'number',
    defaultValue: 30,
    min: 1,
    max: 365,
    description: 'Days to keep rendered confession images in storage before retention cleanup (range: 1–365)',
  },
  max_slide_count: {
    key: 'max_slide_count',
    type: 'number',
    defaultValue: 10,
    min: 1,
    max: 10,
    description: 'Maximum carousel slides rendered per confession card (range: 1–10)',
  },
  moderation_strictness: {
    key: 'moderation_strictness',
    type: 'string',
    defaultValue: 'medium',
    allowedValues: ['low', 'medium', 'high'],
    description: 'Moderation strictness preset (Read-only / Phase C policy is frozen)',
  },
  heartbeat_timeout_sec: {
    key: 'heartbeat_timeout_sec',
    type: 'number',
    defaultValue: 90,
    min: 30,
    max: 600,
    description: 'Interval in seconds between worker heartbeat lease renewals (range: 30–600s)',
  },
  stale_lease_threshold_sec: {
    key: 'stale_lease_threshold_sec',
    type: 'number',
    defaultValue: 300,
    min: 60,
    max: 1800,
    description: 'Lease TTL in seconds after which an unrenewed worker lease is considered stale (range: 60–1800s)',
  },
};

export interface SettingItem<T = unknown> {
  key: string;
  value: T;
  type: SettingType;
  defaultValue: T;
  description: string;
  min?: number;
  max?: number;
  allowedValues?: string[];
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Validates whether a value conforms to a setting's type and range constraints.
 * Throws an explicit descriptive Error if invalid.
 */
export function validateSettingValue(def: SettingDefinition, rawValue: unknown): unknown {
  if (rawValue === undefined || rawValue === null) {
    throw new Error(`Value for setting '${def.key}' cannot be null or undefined.`);
  }

  if (def.type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (rawValue === 'true' || rawValue === '1' || rawValue === 1) return true;
    if (rawValue === 'false' || rawValue === '0' || rawValue === 0) return false;
    throw new Error(`Setting '${def.key}' expects a boolean, received: ${typeof rawValue}`);
  }

  if (def.type === 'number') {
    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (isNaN(num) || !isFinite(num)) {
      throw new Error(`Setting '${def.key}' expects a valid number, received: ${String(rawValue)}`);
    }
    if (def.min !== undefined && num < def.min) {
      throw new Error(`Setting '${def.key}' minimum allowed value is ${def.min} (received: ${num})`);
    }
    if (def.max !== undefined && num > def.max) {
      throw new Error(`Setting '${def.key}' maximum allowed value is ${def.max} (received: ${num})`);
    }
    return num;
  }

  if (def.type === 'string') {
    if (typeof rawValue !== 'string') {
      throw new Error(`Setting '${def.key}' expects a string, received: ${typeof rawValue}`);
    }
    if (def.allowedValues && !def.allowedValues.includes(rawValue)) {
      throw new Error(
        `Setting '${def.key}' must be one of [${def.allowedValues.join(', ')}], received: ${rawValue}`
      );
    }
    return rawValue;
  }

  throw new Error(`Unsupported setting type: ${def.type}`);
}

/**
 * Retrieves all allowlisted operational settings from Supabase, merged with defaults.
 * Excludes any internal secrets or non-allowlisted records.
 */
export async function getAdminSettings(
  options: { supabaseClient?: SupabaseClient } = {}
): Promise<SettingItem[]> {
  const supabase = options.supabaseClient || getSupabaseAdmin();

  const { data: rows, error } = await supabase
    .from('settings')
    .select('key, value, description, updated_at, updated_by');

  if (error) {
    throw new Error(`Failed to fetch settings from Supabase: ${error.message}`);
  }

  const dbMap = new Map<string, { value: unknown; updatedAt?: string; updatedBy?: string }>();
  if (rows) {
    for (const r of rows) {
      dbMap.set(r.key, {
        value: r.value,
        updatedAt: r.updated_at,
        updatedBy: r.updated_by,
      });
    }
  }

  const result: SettingItem[] = [];
  for (const [key, def] of Object.entries(SETTINGS_ALLOWLIST)) {
    const dbEntry = dbMap.get(key);
    let resolvedValue = def.defaultValue;

    if (dbEntry && dbEntry.value !== undefined && dbEntry.value !== null) {
      try {
        resolvedValue = validateSettingValue(def, dbEntry.value);
      } catch {
        resolvedValue = def.defaultValue;
      }
    }

    result.push({
      key,
      value: resolvedValue,
      type: def.type,
      defaultValue: def.defaultValue,
      description: def.description,
      min: def.min,
      max: def.max,
      allowedValues: def.allowedValues,
      updatedAt: dbEntry?.updatedAt,
      updatedBy: dbEntry?.updatedBy,
    });
  }

  return result;
}

/**
 * Updates an allowlisted operational setting, creates an audit log entry, and persists it.
 */
export async function updateAdminSetting(
  key: string,
  rawValue: unknown,
  options: { actor?: string; supabaseClient?: SupabaseClient } = {}
): Promise<SettingItem> {
  // 1. Prohibit unknown or sensitive keys
  const def = SETTINGS_ALLOWLIST[key];
  if (!def) {
    throw new Error(
      `Setting '${key}' is not in the allowed operational settings list. Modification prohibited.`
    );
  }

  // Double-check against secret names
  const lowerKey = key.toLowerCase();
  if (
    lowerKey.includes('secret') ||
    lowerKey.includes('token') ||
    lowerKey.includes('key') ||
    lowerKey.includes('password')
  ) {
    throw new Error(`Cannot modify sensitive key '${key}' via public settings API.`);
  }

  // 2. Validate value against constraints
  const validatedValue = validateSettingValue(def, rawValue);

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const actor = options.actor || 'admin';
  const now = new Date().toISOString();

  // 3. Fetch previous value for audit logging
  let previousValue: unknown = def.defaultValue;
  const { data: prevRow } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (prevRow?.value !== undefined) {
    previousValue = prevRow.value;
  }

  // 4. Upsert setting
  const { data, error } = await supabase
    .from('settings')
    .upsert({
      key,
      value: validatedValue,
      description: def.description,
      updated_at: now,
      updated_by: actor,
    })
    .select('key, value, description, updated_at, updated_by')
    .single();

  if (error) {
    throw new Error(`Failed to update setting '${key}': ${error.message}`);
  }

  // 5. Create audit log entry
  try {
    await supabase.from('audit_log').insert({
      action: 'admin_update_setting',
      actor,
      details: {
        setting_key: key,
        previous_value: previousValue,
        new_value: validatedValue,
      },
    });
  } catch (auditErr) {
    console.warn(`[AUDIT] Failed to log setting update for '${key}':`, auditErr);
  }

  // Invalidate cache upon successful setting mutation
  clearRuntimeSettingsCache();

  return {
    key: data.key,
    value: data.value,
    type: def.type,
    defaultValue: def.defaultValue,
    description: def.description,
    min: def.min,
    max: def.max,
    allowedValues: def.allowedValues,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by,
  };
}

// ---------------------------------------------------------------------------
// Centralized Server-Side Runtime Settings Reader (BU Confessions v3.4)
// ---------------------------------------------------------------------------

export interface RuntimeSettings {
  posting_enabled: boolean;
  max_per_batch: number;
  min_delay_between_posts_sec: number;
  max_daily_posts: number;
  auto_publish_approved: boolean;
  dry_run_mode: boolean;
  image_retention_days: number;
  max_slide_count: number;
  moderation_strictness: 'low' | 'medium' | 'high';
  heartbeat_timeout_sec: number;
  stale_lease_threshold_sec: number;
}

let _cachedRuntimeSettings: RuntimeSettings | null = null;
let _cacheExpiresAt = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

/**
 * Clears the in-memory settings cache. Used during testing and upon mutations.
 */
export function clearRuntimeSettingsCache(): void {
  _cachedRuntimeSettings = null;
  _cacheExpiresAt = 0;
}

/**
 * Obtains validated, strongly-typed operational settings with fallback to defaults.
 * Sourced server-side from Supabase with bounded query and 10s caching.
 */
export async function getRuntimeSettings(
  options: {
    supabaseClient?: SupabaseClient;
    forceFresh?: boolean;
  } = {}
): Promise<RuntimeSettings> {
  const now = Date.now();
  if (!options.forceFresh && _cachedRuntimeSettings && now < _cacheExpiresAt) {
    return { ..._cachedRuntimeSettings };
  }

  // Base defaults from allowlist definition
  const settings: RuntimeSettings = {
    posting_enabled: SETTINGS_ALLOWLIST.posting_enabled.defaultValue as boolean,
    max_per_batch: SETTINGS_ALLOWLIST.max_per_batch.defaultValue as number,
    min_delay_between_posts_sec: SETTINGS_ALLOWLIST.min_delay_between_posts_sec.defaultValue as number,
    max_daily_posts: SETTINGS_ALLOWLIST.max_daily_posts.defaultValue as number,
    auto_publish_approved: SETTINGS_ALLOWLIST.auto_publish_approved.defaultValue as boolean,
    dry_run_mode: SETTINGS_ALLOWLIST.dry_run_mode.defaultValue as boolean,
    image_retention_days: SETTINGS_ALLOWLIST.image_retention_days.defaultValue as number,
    max_slide_count: SETTINGS_ALLOWLIST.max_slide_count.defaultValue as number,
    moderation_strictness: SETTINGS_ALLOWLIST.moderation_strictness.defaultValue as 'low' | 'medium' | 'high',
    heartbeat_timeout_sec: SETTINGS_ALLOWLIST.heartbeat_timeout_sec.defaultValue as number,
    stale_lease_threshold_sec: SETTINGS_ALLOWLIST.stale_lease_threshold_sec.defaultValue as number,
  };

  try {
    const supabase = options.supabaseClient || getSupabaseAdmin();
    const { data: rows, error } = await supabase
      .from('settings')
      .select('key, value');

    if (!error && rows) {
      const dbMap = new Map<string, unknown>();
      for (const row of rows) {
        dbMap.set(row.key, row.value);
      }

      for (const [k, def] of Object.entries(SETTINGS_ALLOWLIST)) {
        const raw = dbMap.get(k);
        if (raw !== undefined && raw !== null) {
          try {
            (settings as any)[k] = validateSettingValue(def, raw);
          } catch {
            // Keep allowlist default if individual row value is invalid
          }
        }
      }
    } else if (error) {
      console.warn(
        '[SETTINGS] Database read error on settings table — activating FAIL-SAFE mode: automated publication halted.',
        error.message
      );
      settings.posting_enabled = false;
      settings.auto_publish_approved = false;
    }
  } catch (err) {
    console.warn(
      '[SETTINGS] Database read error on settings table — activating FAIL-SAFE mode: automated publication halted.',
      err
    );
    settings.posting_enabled = false;
    settings.auto_publish_approved = false;
  }

  // Precedence Rule 2: CLI / ENV dry-run always forces dry_run_mode = true
  if (
    process.env.DRY_RUN === 'true' ||
    (typeof process !== 'undefined' && process.argv && process.argv.includes('--dry-run'))
  ) {
    settings.dry_run_mode = true;
  }

  // Invariant clamping: max_slide_count must be in [1, 10]
  settings.max_slide_count = Math.min(10, Math.max(1, settings.max_slide_count));

  // Invariant clamping: max_per_batch must be in [1, 100]
  settings.max_per_batch = Math.min(100, Math.max(1, settings.max_per_batch));

  // Invariant clamping: min_delay_between_posts_sec must be in [10, 3600]
  settings.min_delay_between_posts_sec = Math.min(3600, Math.max(10, settings.min_delay_between_posts_sec));

  // Lease safety inequality: heartbeat_timeout_sec <= floor(stale_lease_threshold_sec / 2)
  const leaseTtlSec = Math.max(60, settings.stale_lease_threshold_sec);
  const maxHeartbeatSec = Math.floor(leaseTtlSec / 2);
  settings.heartbeat_timeout_sec = Math.min(settings.heartbeat_timeout_sec, maxHeartbeatSec);

  _cachedRuntimeSettings = { ...settings };
  _cacheExpiresAt = now + CACHE_TTL_MS;

  return settings;
}

/**
 * Queries the durable database count of confessions posted today in IST (Asia/Kolkata).
 * Midnight is calculated as 00:00:00 IST of the current day.
 */
export async function getTodayPostedCount(supabaseClient?: SupabaseClient): Promise<number> {
  const supabase = supabaseClient || getSupabaseAdmin();
  const istDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const startOfDayIst = new Date(`${istDateStr}T00:00:00+05:30`).toISOString();

  const { count, error } = await supabase
    .from('confessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'posted')
    .gte('posted_at', startOfDayIst);

  if (error) {
    console.error('[SETTINGS] Failed to query today posted count:', error.message);
    return 0;
  }

  return count || 0;
}

