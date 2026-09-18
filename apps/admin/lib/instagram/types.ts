import { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Instagram Graph API Types (BU Confessions v3.4 — Phase E)
// ---------------------------------------------------------------------------

export type ContainerStatusCode = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'PUBLISHED' | 'EXPIRED';

export interface GraphApiErrorDetail {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export interface GraphApiResponse<T = Record<string, unknown>> {
  id?: string;
  permalink?: string;
  status_code?: ContainerStatusCode;
  status?: string;
  error?: GraphApiErrorDetail;
  data?: T;
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
  };
  [key: string]: any;
}

export interface ContainerStatusResponse {
  id: string;
  statusCode: ContainerStatusCode;
  status?: string;
  errorMessage?: string;
}

export interface RecentMediaItem {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
}

export interface TokenValidationResult {
  isValid: boolean;
  expiresAt?: string;
  expiresInSeconds?: number;
  needsRefresh: boolean;
  scopes?: string[];
  error?: string;
}

export interface StoredTokenMetadata {
  accessToken: string;
  expiresAt: string;
  refreshedAt: string;
}

export interface PublishAttemptRecord {
  publish_attempt_id: string;
  confession_id: number;
  attempt_number: number;
  correlation_token: string;
  container_id?: string | null;
  child_container_ids?: string[] | null;
  publish_attempted_at: string;
  response_status?: string | null;
  recovered: boolean;
  error_message?: string | null;
}

export interface PublishOptions {
  supabaseClient?: SupabaseClient;
  dryRun?: boolean;
  runUuid?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  /** Skip lease assertion in standalone tests */
  skipLeaseCheck?: boolean;
}

export interface PublishResult {
  success: boolean;
  confessionId: number;
  confessionNumber?: number | null;
  igPostId?: string;
  igPermalink?: string;
  containerId?: string;
  childContainerIds?: string[];
  recovered?: boolean;
  deferred?: boolean;
  dryRun?: boolean;
  failureStage?: string;
  error?: string;
}

export interface RecoveryCheckResult {
  canRecover: boolean;
  stage: 'none' | 'child_containers' | 'parent_container' | 'already_published' | 'deferred_recheck' | 'anomaly';
  recoveredPostId?: string;
  recoveredPermalink?: string;
  existingChildIds?: string[];
  existingParentId?: string;
  reason: string;
}
