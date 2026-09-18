'use client';
import { useState, useEffect, useCallback } from 'react';

interface AuditEntry {
  id: number;
  confession_id: number | null;
  action: string;
  actor: string;
  details: Record<string, any> | null;
  previous_status: string | null;
  new_status: string | null;
  created_at: string;
}

interface AuditResponse {
  logs: AuditEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'admin_force_approve', label: 'Force Approve' },
  { value: 'admin_force_reject', label: 'Force Reject' },
  { value: 'admin_rerun_ai', label: 'Re-run AI' },
  { value: 'admin_soft_delete', label: 'Soft Delete' },
  { value: 'admin_update_setting', label: 'Update Setting' },
  { value: 'admin_release_stale_lock', label: 'Release Stale Lock' },
  { value: 'admin_create_confession', label: 'Create Confession' },
  { value: 'admin_update_confession', label: 'Update Confession' },
  { value: 'admin_login', label: 'Admin Login' },
  { value: 'admin_logout', label: 'Admin Logout' },
];

export default function AuditView() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & pagination
  const [page, setPage] = useState(1);
  const [selectedAction, setSelectedAction] = useState('');
  const [filterConfessionId, setFilterConfessionId] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);

  const fetchAuditLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '25');
      if (selectedAction) params.set('action', selectedAction);
      if (filterConfessionId && !isNaN(parseInt(filterConfessionId, 10))) {
        params.set('confessionId', filterConfessionId.trim());
      }

      const res = await fetch(`/api/admin/audit?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to fetch audit logs`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err?.message || 'Network error fetching audit logs');
    } finally {
      setLoading(false);
    }
  }, [page, selectedAction, filterConfessionId]);

  useEffect(() => {
    fetchAuditLogs();
  }, [fetchAuditLogs]);

  const getActionBadge = (action: string) => {
    if (action.includes('approve')) return { bg: '#064e3b', color: '#6ee7b7', border: '#059669' };
    if (action.includes('reject')) return { bg: '#4c0519', color: '#fda4af', border: '#e11d48' };
    if (action.includes('rerun')) return { bg: '#312e81', color: '#a5b4fc', border: '#4338ca' };
    if (action.includes('delete')) return { bg: '#450a0a', color: '#fca5a5', border: '#dc2626' };
    if (action.includes('setting')) return { bg: '#164e63', color: '#67e8f9', border: '#0891b2' };
    if (action.includes('login') || action.includes('logout')) return { bg: '#1f2937', color: '#d1d5db', border: '#374151' };
    return { bg: '#141414', color: '#aaa', border: '#333' };
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: '800', margin: '0 0 4px 0' }}>📋 Administrative Audit Trail</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>
            Append-only, immutable record of all moderation and operational mutations.
          </p>
        </div>
        <button
          onClick={fetchAuditLogs}
          disabled={loading}
          style={{ background: '#1a1a1a', border: '1px solid #333', color: '#ddd', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
        >
          {loading ? 'Refreshing...' : '🔄 Refresh Logs'}
        </button>
      </div>

      {/* Filter Bar */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center', background: '#111', padding: '14px', borderRadius: '10px', border: '1px solid #222' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#777', marginBottom: '4px', textTransform: 'uppercase', fontWeight: '700' }}>
            Action Type
          </label>
          <select
            value={selectedAction}
            onChange={(e) => { setSelectedAction(e.target.value); setPage(1); }}
            style={{ background: '#1e1e1e', border: '1px solid #333', color: '#fff', padding: '6px 12px', borderRadius: '6px', fontSize: '13px' }}
          >
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#777', marginBottom: '4px', textTransform: 'uppercase', fontWeight: '700' }}>
            Confession ID
          </label>
          <input
            type="number"
            placeholder="e.g. 42"
            value={filterConfessionId}
            onChange={(e) => { setFilterConfessionId(e.target.value); setPage(1); }}
            style={{ background: '#1e1e1e', border: '1px solid #333', color: '#fff', padding: '6px 12px', borderRadius: '6px', fontSize: '13px', width: '120px' }}
          />
        </div>

        {(selectedAction || filterConfessionId) && (
          <button
            onClick={() => { setSelectedAction(''); setFilterConfessionId(''); setPage(1); }}
            style={{ alignSelf: 'flex-end', background: 'transparent', border: '1px solid #444', color: '#888', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: '16px', background: '#450a0a', border: '1px solid #dc2626', borderRadius: '8px', color: '#fca5a5', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#141414', border: '1px solid #242424', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: '#1a1a1a', borderBottom: '1px solid #282828', color: '#888', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.05em' }}>
              <th style={{ padding: '12px 16px' }}>Timestamp</th>
              <th style={{ padding: '12px 16px' }}>Action</th>
              <th style={{ padding: '12px 16px' }}>Confession</th>
              <th style={{ padding: '12px 16px' }}>Actor</th>
              <th style={{ padding: '12px 16px' }}>Status Change</th>
              <th style={{ padding: '12px 16px' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {loading && (!data || data.logs.length === 0) ? (
              <tr>
                <td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#666' }}>
                  Loading audit trail...
                </td>
              </tr>
            ) : !data || data.logs.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#666' }}>
                  No audit log records match the selected filters.
                </td>
              </tr>
            ) : (
              data.logs.map((entry) => {
                const badge = getActionBadge(entry.action);
                return (
                  <tr key={entry.id} style={{ borderBottom: '1px solid #1f1f1f' }}>
                    <td style={{ padding: '12px 16px', color: '#888', whiteSpace: 'nowrap' }}>
                      {new Date(entry.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, padding: '2px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: '700' }}>
                        {entry.action.replace(/^admin_/, '')}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      {entry.confession_id ? (
                        <span style={{ background: '#222', border: '1px solid #333', color: '#ddd', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '12px' }}>
                          #{entry.confession_id}
                        </span>
                      ) : (
                        <span style={{ color: '#555' }}>-</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', color: '#bbb' }}>
                      {entry.actor}
                    </td>
                    <td style={{ padding: '12px 16px', color: '#888' }}>
                      {entry.previous_status || entry.new_status ? (
                        <span>
                          <span style={{ color: '#999' }}>{entry.previous_status || 'none'}</span>
                          {' → '}
                          <strong style={{ color: '#6ee7b7' }}>{entry.new_status || 'none'}</strong>
                        </span>
                      ) : (
                        <span style={{ color: '#555' }}>-</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      {entry.details ? (
                        <button
                          onClick={() => setSelectedEntry(entry)}
                          style={{ background: '#1e1e1e', border: '1px solid #333', color: '#aaa', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}
                        >
                          View JSON
                        </button>
                      ) : (
                        <span style={{ color: '#555' }}>-</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Pagination Bar */}
        {data && data.totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: '#111', borderTop: '1px solid #222' }}>
            <span style={{ fontSize: '12px', color: '#888' }}>
              Showing {data.logs.length} of {data.total} entries (Page {data.page} of {data.totalPages})
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                style={{ background: '#1c1c1c', border: '1px solid #333', color: page <= 1 ? '#555' : '#ddd', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages || loading}
                style={{ background: '#1c1c1c', border: '1px solid #333', color: page >= data.totalPages ? '#555' : '#ddd', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', cursor: page >= data.totalPages ? 'not-allowed' : 'pointer' }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Details Modal */}
      {selectedEntry && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '20px' }}>
          <div style={{ background: '#141414', border: '1px solid #333', borderRadius: '14px', width: '560px', maxWidth: '100%', padding: '24px', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h4 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>
                Audit Record #{selectedEntry.id}: {selectedEntry.action}
              </h4>
              <button onClick={() => setSelectedEntry(null)} style={{ background: 'transparent', border: 'none', color: '#888', fontSize: '20px', cursor: 'pointer' }}>
                &times;
              </button>
            </div>
            <pre style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: '8px', padding: '14px', fontSize: '12px', color: '#a5b4fc', overflowX: 'auto', maxHeight: '360px' }}>
              {JSON.stringify(selectedEntry.details, null, 2)}
            </pre>
            <div style={{ marginTop: '16px', textAlign: 'right' }}>
              <button
                onClick={() => setSelectedEntry(null)}
                style={{ background: '#1f2937', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
