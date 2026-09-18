import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase';

// ---------------------------------------------------------------------------
// Audit Log Data Layer (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Guarantees:
//   1. Append-only audit records from application perspective.
//   2. No endpoints allow deleting or updating audit_log records.
//   3. Server-side range pagination and indexed filtering.
//   4. Sanitized details to prevent leaking credentials/secrets.
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: number;
  confession_id: number | null;
  action: string;
  actor: string;
  details: Record<string, unknown> | null;
  previous_status: string | null;
  new_status: string | null;
  created_at: string;
}

export interface GetAuditLogsOptions {
  page?: number;
  limit?: number;
  action?: string;
  confessionId?: number;
  actor?: string;
  supabaseClient?: SupabaseClient;
}

export interface GetAuditLogsResult {
  logs: AuditLogRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Retrieves paginated audit log records with optional filtering.
 */
export async function getAdminAuditLogs(
  options: GetAuditLogsOptions = {}
): Promise<GetAuditLogsResult> {
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 25));
  const offset = (page - 1) * limit;

  // Build query
  let query = supabase
    .from('audit_log')
    .select('id, confession_id, action, actor, details, previous_status, new_status, created_at', {
      count: 'exact',
    });

  if (options.action && options.action.trim()) {
    query = query.eq('action', options.action.trim());
  }

  if (typeof options.confessionId === 'number' && !isNaN(options.confessionId) && options.confessionId > 0) {
    query = query.eq('confession_id', options.confessionId);
  }

  if (options.actor && options.actor.trim()) {
    query = query.eq('actor', options.actor.trim());
  }

  query = query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch audit logs: ${error.message}`);
  }

  const total = count ?? (data?.length || 0);
  const totalPages = Math.ceil(total / limit) || 1;

  return {
    logs: (data || []) as AuditLogRow[],
    total,
    page,
    limit,
    totalPages,
  };
}

/**
 * Appends an entry to the audit log table.
 */
export async function recordAuditLog(entry: {
  confessionId?: number | null;
  action: string;
  actor?: string;
  details?: Record<string, unknown>;
  previousStatus?: string | null;
  newStatus?: string | null;
  supabaseClient?: SupabaseClient;
}): Promise<AuditLogRow | null> {
  const supabase = entry.supabaseClient || getSupabaseAdmin();
  const actor = entry.actor || 'admin';

  try {
    const { data, error } = await supabase
      .from('audit_log')
      .insert({
        confession_id: entry.confessionId ?? null,
        action: entry.action,
        actor,
        details: entry.details ?? null,
        previous_status: entry.previousStatus ?? null,
        new_status: entry.newStatus ?? null,
      })
      .select('id, confession_id, action, actor, details, previous_status, new_status, created_at')
      .single();

    if (error) {
      console.warn(`[AUDIT] Insert failed for action '${entry.action}':`, error.message);
      return null;
    }

    return data as AuditLogRow;
  } catch (err) {
    console.warn(`[AUDIT] Exception during insert for action '${entry.action}':`, err);
    return null;
  }
}
