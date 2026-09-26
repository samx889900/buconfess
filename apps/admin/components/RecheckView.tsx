'use client';
import { useState, useEffect, useCallback } from 'react';

interface RecheckItem {
  id: number;
  text: string;
  status: string;
  number?: number | null;
  decision_reason?: string | null;
  last_error?: string | null;
  created_at: string;
}

export default function RecheckView() {
  const [items, setItems] = useState<RecheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [lastResults, setLastResults] = useState<any | null>(null);

  const fetchRecheckable = useCallback(async () => {
    setLoading(true);
    try {
      // Query confessions in non-posted states eligible for recheck
      const res = await fetch(`/api/confessions?status=${filterStatus === 'all' ? 'all' : filterStatus}&limit=50`);
      if (res.ok) {
        const data = await res.json();
        const eligible = (Array.isArray(data) ? data : []).filter(
          (c: any) => ['rejected', 'pending_review', 'failed'].includes(c.status)
        );
        setItems(eligible);
        setSelectedIds(new Set());
      } else {
        setMsg({ text: 'Failed to load recheckable confessions', isError: true });
      }
    } catch {
      setMsg({ text: 'Network error fetching confessions', isError: true });
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    fetchRecheckable();
  }, [fetchRecheckable]);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((c) => c.id)));
    }
  };

  const executeRecheck = async () => {
    if (selectedIds.size === 0) return;
    setProcessing(true);
    setMsg(null);
    setLastResults(null);

    try {
      const res = await fetch('/api/admin/confessions/recheck', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });

      const data = await res.json();
      if (res.ok) {
        setLastResults(data);
        setMsg({
          text: `✅ Recheck completed: ${data.approved} approved, ${data.rejected} rejected, ${data.pendingReview} pending review (${data.blocked} blocked)`,
          isError: false,
        });
        fetchRecheckable();
      } else {
        setMsg({ text: `❌ Recheck failed: ${data.error}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error during recheck execution', isError: true });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: '800', margin: '0 0 4px 0' }}>🔁 Past Confession Recheck</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>
            Re-evaluate rejected, failed, or pending-review confessions with current AI moderation rules.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={fetchRecheckable}
            disabled={loading || processing}
            style={{ background: '#1a1a1a', border: '1px solid #333', color: '#ddd', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
          >
            🔄 Refresh
          </button>
          <button
            onClick={executeRecheck}
            disabled={selectedIds.size === 0 || processing}
            style={{
              background: selectedIds.size > 0 && !processing ? '#6366f1' : '#262626',
              color: selectedIds.size > 0 && !processing ? '#fff' : '#666',
              border: 'none',
              borderRadius: '8px',
              padding: '8px 18px',
              cursor: selectedIds.size > 0 && !processing ? 'pointer' : 'not-allowed',
              fontSize: '13px',
              fontWeight: '700',
            }}
          >
            {processing ? 'Rechecking...' : `Recheck Selected (${selectedIds.size})`}
          </button>
        </div>
      </div>

      {/* Safety Notice Banner */}
      <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: '10px', padding: '14px 18px', marginBottom: '20px', fontSize: '13px', color: '#93c5fd' }}>
        🛡️ <strong>Safety Invariants:</strong> Posted confessions cannot be rechecked. Recheck never calls Instagram directly; newly approved confessions enter the normal publication queue.
      </div>

      {msg && (
        <div style={{ padding: '12px 18px', background: msg.isError ? '#450a0a' : '#052e16', border: `1px solid ${msg.isError ? '#dc2626' : '#16a34a'}`, borderRadius: '8px', color: msg.isError ? '#fca5a5' : '#86efac', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px' }}>&times;</button>
        </div>
      )}

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {[
          { key: 'all', label: 'All Eligible' },
          { key: 'rejected', label: 'Rejected' },
          { key: 'pending_review', label: 'Pending Review' },
          { key: 'failed', label: 'Failed' },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setFilterStatus(f.key)}
            style={{
              background: filterStatus === f.key ? '#6366f1' : '#141414',
              color: filterStatus === f.key ? '#fff' : '#888',
              border: `1px solid ${filterStatus === f.key ? '#6366f1' : '#282828'}`,
              borderRadius: '6px',
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table List */}
      {loading ? (
        <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
          <div>⏳ Loading confessions...</div>
        </div>
      ) : items.length === 0 ? (
        <div style={{ background: '#111', border: '1px dashed #333', borderRadius: '12px', padding: '40px', textAlign: 'center', color: '#888' }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>📭</div>
          <p style={{ margin: 0 }}>No recheckable confessions found for filter &quot;{filterStatus}&quot;.</p>
        </div>
      ) : (
        <div style={{ background: '#141414', border: '1px solid #262626', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', background: '#181818', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="checkbox"
              checked={selectedIds.size === items.length && items.length > 0}
              onChange={toggleSelectAll}
              style={{ cursor: 'pointer', width: '16px', height: '16px' }}
            />
            <span style={{ fontSize: '12px', color: '#aaa', fontWeight: '600' }}>
              Select All ({items.length})
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {items.map((item) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <div
                  key={item.id}
                  onClick={() => toggleSelect(item.id)}
                  style={{
                    padding: '16px 18px',
                    borderBottom: '1px solid #202020',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                    transition: 'background 0.1s ease',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(item.id)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ cursor: 'pointer', width: '16px', height: '16px', marginTop: '4px' }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontWeight: '700', fontSize: '14px', color: '#fff' }}>
                        ID #{item.id} {item.number ? `(Number: #${item.number})` : ''}
                      </span>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: '700',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          background: item.status === 'rejected' ? '#4c0519' : item.status === 'pending_review' ? '#451a03' : '#450a0a',
                          color: item.status === 'rejected' ? '#fda4af' : item.status === 'pending_review' ? '#fcd34d' : '#fca5a5',
                          textTransform: 'uppercase',
                        }}
                      >
                        {item.status}
                      </span>
                      <span style={{ color: '#666', fontSize: '11px' }}>
                        {new Date(item.created_at).toLocaleDateString('en-IN')}
                      </span>
                    </div>
                    <p style={{ color: '#ccc', margin: '0 0 6px 0', fontSize: '13px', lineHeight: '1.5' }}>
                      {item.text}
                    </p>
                    {(item.decision_reason || item.last_error) && (
                      <p style={{ color: '#888', margin: 0, fontSize: '12px', fontStyle: 'italic' }}>
                        Reason: {item.decision_reason || item.last_error}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
