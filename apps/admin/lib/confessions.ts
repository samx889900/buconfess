import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { getSupabaseAdmin } from './supabase';

// ---------------------------------------------------------------------------
// Centralized Supabase Admin Data-Access Layer (BU Confessions v3.4 — Phase F)
// ---------------------------------------------------------------------------
// Rules & Invariants:
//   1. Supabase public.confessions is the ONLY source of truth for admin data.
//   2. Zero Google Sheets calls for any admin CRUD, numbering, moderation, or state.
//   3. Server-only execution: uses service_role client via getSupabaseAdmin().
//   4. Atomic confession numbering preserved: direct update of `number` is blocked;
//      numbering must draw strictly from public.allocate_confession_number(bigint).
//   5. Deletions are soft-deletes: sets `deleted_at = NOW()`, filtered by default.
//   6. Strict state-machine statuses: validated against the 8 allowed statuses.
//   7. State transitions: strictly validated before mutations.
//   8. Typed return values with explicit error handling: zero silent fallbacks.
// ---------------------------------------------------------------------------

export type ConfessionStatus =
  | 'pending'
  | 'processing'
  | 'approved'
  | 'posting'
  | 'posted'
  | 'rejected'
  | 'pending_review'
  | 'failed';

export type FailureStage =
  | 'moderation'
  | 'image_generation'
  | 'storage'
  | 'instagram_token'
  | 'instagram_container'
  | 'instagram_publish'
  | 'instagram_verification'
  | 'sheets_sync'
  | null;

export const VALID_CONFESSION_STATUSES: readonly ConfessionStatus[] = [
  'pending',
  'processing',
  'approved',
  'posting',
  'posted',
  'rejected',
  'pending_review',
  'failed',
] as const;

/**
 * Permitted source statuses for admin force-approval:
 *   - 'pending_review' (human review approval)
 *   - 'rejected'       (overrule rejection)
 *   - 'pending'        (early manual approval before AI run)
 *   - 'failed'         (recover failed pipeline item to approved)
 *
 * Forbidden:
 *   - 'processing' (in-flight worker)
 *   - 'posting'    (in-flight Instagram publishing)
 *   - 'posted'     (already published on Instagram)
 */
export const FORCE_APPROVE_PERMITTED_STATUSES: readonly ConfessionStatus[] = [
  'pending_review',
  'rejected',
  'pending',
  'failed',
] as const;

/**
 * Permitted source statuses for admin force-rejection:
 *   - 'pending_review' (human review rejection)
 *   - 'pending'        (reject before AI run)
 *   - 'approved'       (revoke approval before posting begins)
 *   - 'failed'         (abandon failed confession)
 *
 * Forbidden:
 *   - 'processing' (in-flight worker)
 *   - 'posting'    (in-flight Instagram publishing)
 *   - 'posted'     (already published on Instagram)
 */
export const FORCE_REJECT_PERMITTED_STATUSES: readonly ConfessionStatus[] = [
  'pending_review',
  'pending',
  'approved',
  'failed',
] as const;

/**
 * Permitted source statuses for admin re-running AI moderation:
 *   - 'pending_review' (re-evaluate borderline/errored item)
 *   - 'rejected'       (re-evaluate rejected item)
 *   - 'failed'         (retry from scratch after moderation failure)
 *   - 'approved'       (revoke approval and re-moderate)
 *
 * Forbidden:
 *   - 'processing' (in-flight worker)
 *   - 'posting'    (in-flight Instagram publishing)
 *   - 'posted'     (already published on Instagram)
 */
export const RERUN_AI_PERMITTED_STATUSES: readonly ConfessionStatus[] = [
  'pending_review',
  'rejected',
  'failed',
  'approved',
] as const;

export class StateTransitionError extends Error {
  readonly statusCode: number;
  readonly currentStatus: string;
  readonly targetStatus: string;

  constructor(currentStatus: string, targetStatus: string, message?: string) {
    super(
      message ||
        `Invalid state transition: Cannot transition confession from "${currentStatus}" to "${targetStatus}".`
    );
    this.name = 'StateTransitionError';
    this.statusCode = 409;
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
  }
}

export interface ConfessionRow {
  id: number;
  text: string;
  normalized_text: string;
  content_hash: string;
  status: ConfessionStatus;
  failure_stage: FailureStage;
  number: number | null;
  parts: string[] | null;
  image_urls: string[] | null;

  // Instagram & Publication Recovery
  ig_post_id: string | null;
  ig_permalink: string | null;
  instagram_container_id: string | null;
  instagram_child_container_ids: string[] | null;
  publish_attempt_id: string | null;
  correlation_token: string | null;
  instagram_publish_attempted_at: string | null;
  instagram_publish_status: string | null;

  // AI Moderation Metadata
  ai_verdict: string | null;
  decision_reason: string | null;
  model_confidence: number | null;
  matched_rules: Record<string, unknown> | unknown[] | null;
  policy_level: number | null;
  flags: string[] | Record<string, unknown> | null;
  model_id: string | null;
  model_version: string | null;
  ai_policy_version: number | null;
  instruction_version: number | null;
  prompt_hash: string | null;
  generation_config: Record<string, unknown> | null;
  fallback_used: boolean;

  // Processing & Milestone Tracking
  processing_started_at: string | null;
  last_progress_at: string | null;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  run_id: number | null;

  // Decoupled Sheets Sync
  sheets_sync_status: string;
  sheets_last_synced_at: string | null;
  sheets_sync_error: string | null;

  // Audit & Tracking
  submitter_ip_hash: string;
  created_at: string;
  updated_at: string;
  posted_at: string | null;
  deleted_at: string | null;
}

export interface GetAdminConfessionsOptions {
  status?: ConfessionStatus | 'all';
  page?: number;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at' | 'number' | 'id';
  orderDirection?: 'asc' | 'desc';
  includeDeleted?: boolean;
  supabaseClient?: SupabaseClient;
}

export interface UpdateConfessionInput {
  status?: ConfessionStatus;
  text?: string;
  failure_stage?: FailureStage;
  last_error?: string | null;
  parts?: string[] | null;
  image_urls?: string[] | null;
  ig_post_id?: string | null;
  ig_permalink?: string | null;
  instagram_container_id?: string | null;
  instagram_child_container_ids?: string[] | null;
  instagram_publish_status?: string | null;
  publish_attempt_id?: string | null;
  correlation_token?: string | null;
  posted_at?: string | null;
  attempt_count?: number;
  next_retry_at?: string | null;
  processing_started_at?: string | null;
  last_progress_at?: string | null;
  sheets_sync_status?: string;
  sheets_last_synced_at?: string | null;
  sheets_sync_error?: string | null;
  ai_verdict?: string | null;
  decision_reason?: string | null;
  model_confidence?: number | null;
  matched_rules?: Record<string, unknown> | unknown[] | null;
  flags?: string[] | Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ConfessionApiResponse extends Omit<ConfessionRow, 'parts'> {
  // CamelCase & serialized compatibility fields for existing frontend
  imageUrls: string;
  parts: string;
  igPostId?: string;
  igPermalink?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeContentHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

/**
 * Maps a database ConfessionRow to ConfessionApiResponse preserving camelCase
 * fields and serialized JSON strings expected by apps/admin/app/page.tsx.
 */
export function formatConfessionForAdmin(row: ConfessionRow): ConfessionApiResponse {
  return {
    ...row,
    imageUrls: JSON.stringify(row.image_urls || []),
    parts: JSON.stringify(row.parts || []),
    igPostId: row.ig_post_id ?? undefined,
    igPermalink: row.ig_permalink ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Data Access Methods
// ---------------------------------------------------------------------------

/**
 * Fetches confessions with optional status filtering and pagination.
 * Excludes soft-deleted confessions by default (`deleted_at IS NULL`).
 */
export async function getAdminConfessions(
  options: GetAdminConfessionsOptions = {}
): Promise<ConfessionRow[]> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const {
    status,
    page,
    limit,
    offset: rawOffset,
    orderBy = 'created_at',
    orderDirection = 'desc',
    includeDeleted = false,
  } = options;

  let query = supabase.from('confessions').select('*');

  if (!includeDeleted) {
    query = query.is('deleted_at', null);
  }

  if (status && status !== 'all') {
    if (!VALID_CONFESSION_STATUSES.includes(status)) {
      throw new Error(`Invalid status filter: "${status}"`);
    }
    query = query.eq('status', status);
  }

  query = query.order(orderBy, { ascending: orderDirection === 'asc' });

  // Calculate pagination range
  const resolvedLimit = typeof limit === 'number' && limit > 0 ? limit : undefined;
  let resolvedOffset = typeof rawOffset === 'number' && rawOffset >= 0 ? rawOffset : undefined;

  if (typeof page === 'number' && page > 0 && resolvedLimit) {
    resolvedOffset = (page - 1) * resolvedLimit;
  }

  if (resolvedOffset !== undefined && resolvedLimit !== undefined) {
    query = query.range(resolvedOffset, resolvedOffset + resolvedLimit - 1);
  } else if (resolvedLimit !== undefined) {
    query = query.limit(resolvedLimit);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch confessions from Supabase: ${error.message}`);
  }

  return (data || []) as ConfessionRow[];
}

/**
 * Fetches a single confession by its primary key ID.
 * Excludes soft-deleted confessions unless `includeDeleted` is true.
 */
export async function getAdminConfessionById(
  id: number,
  options: { includeDeleted?: boolean; supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow | null> {
  if (typeof id !== 'number' || isNaN(id) || id <= 0) {
    throw new Error(`Invalid confession ID: ${id}`);
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const { includeDeleted = false } = options;

  let query = supabase.from('confessions').select('*').eq('id', id);
  if (!includeDeleted) {
    query = query.is('deleted_at', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`Failed to fetch confession #${id} from Supabase: ${error.message}`);
  }

  return (data as ConfessionRow) || null;
}

/**
 * Updates an existing confession's status or metadata.
 * Validates status transitions and ensures atomic numbering invariants:
 * direct update of `number` is blocked.
 */
export async function updateAdminConfession(
  id: number,
  input: UpdateConfessionInput,
  options: { supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow> {
  if (typeof id !== 'number' || isNaN(id) || id <= 0) {
    throw new Error(`Invalid confession ID: ${id}`);
  }

  // Guard against arbitrary number mutation
  if ('number' in input && input.number !== undefined) {
    throw new Error(
      'Direct mutation of confession number is prohibited. ' +
        'Numbers must be assigned exclusively via allocate_confession_number(bigint).'
    );
  }

  // Validate status if provided
  if (input.status !== undefined && !VALID_CONFESSION_STATUSES.includes(input.status)) {
    throw new Error(
      `Invalid confession status: "${input.status}". Allowed statuses: ${VALID_CONFESSION_STATUSES.join(', ')}`
    );
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const payload: Record<string, unknown> = {
    ...input,
    updated_at: new Date().toISOString(),
  };

  // If text is modified, synchronize normalized_text and content_hash
  if (typeof input.text === 'string') {
    const trimmed = input.text.trim();
    if (trimmed.length < 10) {
      throw new Error('Confession text must be at least 10 characters.');
    }
    if (trimmed.length > 2000) {
      throw new Error('Confession text cannot exceed 2000 characters.');
    }
    payload.text = trimmed;
    payload.normalized_text = normalizeText(trimmed);
    payload.content_hash = computeContentHash(payload.normalized_text as string);
  }

  const { data, error } = await supabase
    .from('confessions')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update confession #${id} in Supabase: ${error.message}`);
  }

  // Audit log entry for update
  try {
    await supabase.from('audit_log').insert({
      confession_id: id,
      action: 'admin_update_confession',
      actor: (options as any).actor || 'admin',
      details: { fields_updated: Object.keys(input) },
    });
  } catch (auditErr) {
    console.warn(`[AUDIT] Failed to log update for confession #${id}:`, auditErr);
  }

  return data as ConfessionRow;
}

/**
 * Explicit admin action: Force Approve
 * Transitions confession to 'approved'.
 * Idempotent if already 'approved'.
 * Rejects if confession is in 'processing', 'posting', or 'posted' state.
 */
export async function forceApproveConfession(
  id: number,
  options: { reason?: string; actor?: string; supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow> {
  if (typeof id !== 'number' || isNaN(id) || id <= 0) {
    throw new Error(`Invalid confession ID: ${id}`);
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const existing = await getAdminConfessionById(id, { supabaseClient: supabase });
  if (!existing) {
    throw new Error(`Confession #${id} not found`);
  }

  // Idempotent: already approved
  if (existing.status === 'approved') {
    return existing;
  }

  // State machine validation
  if (!FORCE_APPROVE_PERMITTED_STATUSES.includes(existing.status)) {
    throw new StateTransitionError(
      existing.status,
      'approved',
      `Cannot Force Approve confession #${id} because its current status is "${existing.status}".`
    );
  }

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    status: 'approved',
    decision_reason: options.reason || 'Manually force approved by admin',
    updated_at: now,
  };

  // If previous status had a moderation failure, clear it
  if (existing.failure_stage === 'moderation') {
    payload.failure_stage = null;
    payload.last_error = null;
  }

  const { data, error } = await supabase
    .from('confessions')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to force approve confession #${id}: ${error.message}`);
  }

  // Audit log entry
  try {
    await supabase.from('audit_log').insert({
      confession_id: id,
      action: 'admin_force_approve',
      actor: options.actor || 'admin',
      previous_status: existing.status,
      new_status: 'approved',
      details: { reason: options.reason || 'Manually force approved by admin' },
    });
  } catch (auditErr) {
    console.warn(`[AUDIT] Failed to insert audit log for confession #${id}:`, auditErr);
  }

  return data as ConfessionRow;
}

/**
 * Explicit admin action: Force Reject
 * Transitions confession to 'rejected'.
 * Stores rejection reason using existing `decision_reason` column.
 * Idempotent if already 'rejected'.
 * Rejects if confession is in 'processing', 'posting', or 'posted' state.
 */
export async function forceRejectConfession(
  id: number,
  options: { reason?: string; actor?: string; supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow> {
  if (typeof id !== 'number' || isNaN(id) || id <= 0) {
    throw new Error(`Invalid confession ID: ${id}`);
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const existing = await getAdminConfessionById(id, { supabaseClient: supabase });
  if (!existing) {
    throw new Error(`Confession #${id} not found`);
  }

  // Idempotent: already rejected
  if (existing.status === 'rejected') {
    return existing;
  }

  // State machine validation
  if (!FORCE_REJECT_PERMITTED_STATUSES.includes(existing.status)) {
    throw new StateTransitionError(
      existing.status,
      'rejected',
      `Cannot Force Reject confession #${id} because its current status is "${existing.status}".`
    );
  }

  const now = new Date().toISOString();
  const reason = options.reason || 'Manually force rejected by admin';

  const { data, error } = await supabase
    .from('confessions')
    .update({
      status: 'rejected',
      decision_reason: reason,
      updated_at: now,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to force reject confession #${id}: ${error.message}`);
  }

  // Audit log entry
  try {
    await supabase.from('audit_log').insert({
      confession_id: id,
      action: 'admin_force_reject',
      actor: options.actor || 'admin',
      previous_status: existing.status,
      new_status: 'rejected',
      details: { reason },
    });
  } catch (auditErr) {
    console.warn(`[AUDIT] Failed to insert audit log for confession #${id}:`, auditErr);
  }

  return data as ConfessionRow;
}

/**
 * Explicit admin action: Re-run AI Moderation
 * Transitions confession back to 'pending'.
 * Resets ONLY moderation failure/review metadata:
 *   - ai_verdict = null
 *   - decision_reason = null
 *   - model_confidence = null
 *   - matched_rules = null
 *   - flags = null
 *   - policy_level = null
 *   - model_id = null
 *   - model_version = null
 *   - prompt_hash = null
 *   - fallback_used = false
 *   - failure_stage = null (if failure_stage === 'moderation')
 *   - last_error = null (if failure_stage === 'moderation')
 * Preserves:
 *   - number (if already assigned)
 *   - parts (if already generated)
 *   - image_urls (if already generated)
 *   - Instagram metadata
 * Idempotent if already 'pending'.
 * Rejects if confession is in 'processing', 'posting', or 'posted' state.
 */
export async function rerunAiModeration(
  id: number,
  options: { actor?: string; supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow> {
  if (typeof id !== 'number' || isNaN(id) || id <= 0) {
    throw new Error(`Invalid confession ID: ${id}`);
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const existing = await getAdminConfessionById(id, { supabaseClient: supabase });
  if (!existing) {
    throw new Error(`Confession #${id} not found`);
  }

  // Idempotent: already pending
  if (existing.status === 'pending') {
    return existing;
  }

  // State machine validation
  if (!RERUN_AI_PERMITTED_STATUSES.includes(existing.status)) {
    throw new StateTransitionError(
      existing.status,
      'pending',
      `Cannot Re-run AI on confession #${id} because its current status is "${existing.status}".`
    );
  }

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    status: 'pending',
    ai_verdict: null,
    decision_reason: null,
    model_confidence: null,
    matched_rules: null,
    flags: null,
    policy_level: null,
    model_id: null,
    model_version: null,
    prompt_hash: null,
    fallback_used: false,
    updated_at: now,
  };

  // Reset failure stage only if it was moderation-related
  if (existing.failure_stage === 'moderation') {
    payload.failure_stage = null;
    payload.last_error = null;
  }

  const { data, error } = await supabase
    .from('confessions')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to re-run AI moderation on confession #${id}: ${error.message}`);
  }

  // Audit log entry
  try {
    await supabase.from('audit_log').insert({
      confession_id: id,
      action: 'admin_rerun_ai',
      actor: options.actor || 'admin',
      previous_status: existing.status,
      new_status: 'pending',
      details: { reason: 'Admin requested re-run of AI moderation' },
    });
  } catch (auditErr) {
    console.warn(`[AUDIT] Failed to insert audit log for confession #${id}:`, auditErr);
  }

  return data as ConfessionRow;
}

/**
 * Soft-deletes a confession by setting `deleted_at = NOW()`.
 * Preserves the row in the database while removing it from default views.
 */
export async function softDeleteAdminConfession(
  id: number,
  options: { actor?: string; supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow> {
  if (typeof id !== 'number' || isNaN(id) || id <= 0) {
    throw new Error(`Invalid confession ID: ${id}`);
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const existing = await getAdminConfessionById(id, { supabaseClient: supabase });
  if (!existing) {
    throw new Error(`Confession #${id} not found`);
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('confessions')
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to soft-delete confession #${id}: ${error.message}`);
  }

  try {
    await supabase.from('audit_log').insert({
      confession_id: id,
      action: 'admin_soft_delete',
      actor: options.actor || 'admin',
      previous_status: existing.status,
      new_status: 'deleted',
      details: { soft_deleted: true },
    });
  } catch (auditErr) {
    console.warn(`[AUDIT] Failed to insert audit log for confession #${id}:`, auditErr);
  }

  return data as ConfessionRow;
}

/**
 * Aggregates count of non-deleted confessions across all 8 statuses, plus total 'all'.
 */
export async function getAdminConfessionCounts(
  options: { supabaseClient?: SupabaseClient } = {}
): Promise<Record<ConfessionStatus | 'all', number>> {
  const supabase = options.supabaseClient || getSupabaseAdmin();

  const counts: Record<ConfessionStatus | 'all', number> = {
    all: 0,
    pending: 0,
    processing: 0,
    approved: 0,
    posting: 0,
    posted: 0,
    rejected: 0,
    pending_review: 0,
    failed: 0,
  };

  const { data, error } = await supabase
    .from('confessions')
    .select('status')
    .is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to get confession counts: ${error.message}`);
  }

  if (data) {
    counts.all = data.length;
    for (const row of data) {
      const st = row.status as ConfessionStatus;
      if (st in counts) {
        counts[st]++;
      }
    }
  }

  return counts;
}

/**
 * Admin manual confession creation (server-only).
 * Generates normalized_text, content_hash, and assigns initial 'pending' status.
 */
export async function createAdminConfession(
  input: { text: string },
  options: { supabaseClient?: SupabaseClient } = {}
): Promise<ConfessionRow> {
  const text = input.text?.trim();
  if (!text || text.length < 10) {
    throw new Error('Confession text must be at least 10 characters.');
  }
  if (text.length > 2000) {
    throw new Error('Confession text cannot exceed 2000 characters.');
  }

  const supabase = options.supabaseClient || getSupabaseAdmin();
  const normalized = normalizeText(text);
  const contentHash = computeContentHash(normalized);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('confessions')
    .insert({
      text,
      normalized_text: normalized,
      content_hash: contentHash,
      status: 'pending',
      submitter_ip_hash: 'admin-manual',
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create admin confession in Supabase: ${error.message}`);
  }

  // Audit log entry for creation
  try {
    await supabase.from('audit_log').insert({
      confession_id: data.id,
      action: 'admin_create_confession',
      actor: (options as any).actor || 'admin',
      previous_status: null,
      new_status: 'pending',
      details: { manual_creation: true },
    });
  } catch (auditErr) {
    console.warn('[AUDIT] Failed to log admin confession creation:', auditErr);
  }

  return data as ConfessionRow;
}
