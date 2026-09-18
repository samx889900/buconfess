'use client';
import { useState, useEffect, useCallback } from 'react';

interface HealthData {
  timestamp: string;
  environment: string;
  overall: 'ok' | 'degraded' | 'error';
  subsystems: {
    database: { status: string; latencyMs?: number; error?: string };
    moderation: { status: string; provider: string; hasApiKey: boolean; details?: string };
    image_generation: { status: string; engine: string; available: boolean };
    storage: { status: string; provider: string; configured: boolean };
    instagram: { status: string; hasAccountId: boolean; hasAccessToken: boolean; configured: boolean; details?: string };
  };
  worker: {
    lockName: string;
    isLocked: boolean;
    isStale: boolean;
    lockedBy: string | null;
    acquiredAt: string | null;
    lastHeartbeatAt: string | null;
    expiresAt: string | null;
  };
  latestRun: {
    id: number | null;
    runUuid: string | null;
    status: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    errorSummary: string | null;
    confessionsProcessed: number | null;
    confessionsPosted: number | null;
    dryRun: boolean | null;
  } | null;
  queueCounts: Record<string, number>;
  staleWork: {
    processingCount: number;
    postingCount: number;
    totalStale: number;
  };
}

export default function HealthView() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/health');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to fetch health status`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err?.message || 'Network error fetching health report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const handleReleaseStaleLock = async () => {
    if (!window.confirm('Are you sure you want to release this stale lock? Only demonstrably expired leases can be released.')) {
      return;
    }
    setActionLoading(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/lease/release-stale', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
      });
      const result = await res.json();
      if (res.ok) {
        setMsg({ text: `✅ ${result.message}`, isError: false });
        fetchHealth();
      } else {
        setMsg({ text: `❌ Error: ${result.message || result.error}`, isError: true });
      }
    } catch (err: any) {
      setMsg({ text: `❌ Network error: ${err?.message}`, isError: true });
    } finally {
      setActionLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ok':
        return { bg: '#064e3b', color: '#6ee7b7', border: '#059669', label: 'OPERATIONAL' };
      case 'degraded':
        return { bg: '#451a03', color: '#fcd34d', border: '#b45309', label: 'DEGRADED' };
      case 'error':
        return { bg: '#450a0a', color: '#fca5a5', border: '#dc2626', label: 'ERROR' };
      case 'not_configured':
        return { bg: '#262626', color: '#a3a3a3', border: '#525252', label: 'NOT CONFIGURED' };
      default:
        return { bg: '#1f2937', color: '#9ca3af', border: '#374151', label: status.toUpperCase() };
    }
  };

  if (loading && !data) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
        <p>Loading system health telemetry...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px', background: '#450a0a', border: '1px solid #dc2626', borderRadius: '12px', color: '#fca5a5' }}>
        <h3>⚠️ Failed to Load System Health</h3>
        <p>{error}</p>
        <button
          onClick={fetchHealth}
          style={{ marginTop: '12px', background: '#dc2626', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const overallBadge = getStatusBadge(data.overall);

  return (
    <div>
      {/* Banner */}
      {msg && (
        <div style={{ padding: '12px 18px', background: msg.isError ? '#450a0a' : '#052e16', border: `1px solid ${msg.isError ? '#dc2626' : '#16a34a'}`, borderRadius: '8px', color: msg.isError ? '#fca5a5' : '#86efac', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px' }}>&times;</button>
        </div>
      )}

      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '800', margin: 0 }}>System Health & Heartbeat</h2>
          <span style={{ background: overallBadge.bg, color: overallBadge.color, border: `1px solid ${overallBadge.border}`, padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: '800', letterSpacing: '0.05em' }}>
            {overallBadge.label}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '12px', color: '#888' }}>
            Checked: {new Date(data.timestamp).toLocaleTimeString()}
          </span>
          <button
            onClick={fetchHealth}
            disabled={loading}
            style={{ background: '#1e1e1e', border: '1px solid #333', color: '#ddd', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
          >
            {loading ? 'Refreshing...' : '🔄 Re-check'}
          </button>
        </div>
      </div>

      {/* Stale Work Warning */}
      {data.staleWork.totalStale > 0 && (
        <div style={{ background: '#451a03', border: '1px solid #b45309', borderRadius: '10px', padding: '16px', marginBottom: '24px', color: '#fcd34d' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '15px' }}>⚠️ Stale Work Detected ({data.staleWork.totalStale} items)</h4>
          <p style={{ margin: 0, fontSize: '13px', color: '#fef3c7' }}>
            Found {data.staleWork.processingCount} processing and {data.staleWork.postingCount} posting confession(s) with no progress for &gt; 10 minutes. Check the moderation queue for stuck jobs.
          </p>
        </div>
      )}

      {/* Subsystem Health Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        {/* Database */}
        <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '12px', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontWeight: '700', fontSize: '14px' }}>🗄️ PostgreSQL (Supabase)</span>
            <span style={{ background: getStatusBadge(data.subsystems.database.status).bg, color: getStatusBadge(data.subsystems.database.status).color, border: `1px solid ${getStatusBadge(data.subsystems.database.status).border}`, padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800' }}>
              {data.subsystems.database.status.toUpperCase()}
            </span>
          </div>
          <p style={{ margin: '0 0 4px 0', fontSize: '12px', color: '#888' }}>
            Latency: <strong style={{ color: '#ddd' }}>{data.subsystems.database.latencyMs ?? 0}ms</strong>
          </p>
          {data.subsystems.database.error && (
            <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#ef4444' }}>{data.subsystems.database.error}</p>
          )}
        </div>

        {/* Moderation */}
        <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '12px', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontWeight: '700', fontSize: '14px' }}>🧠 Gemini AI Moderation</span>
            <span style={{ background: getStatusBadge(data.subsystems.moderation.status).bg, color: getStatusBadge(data.subsystems.moderation.status).color, border: `1px solid ${getStatusBadge(data.subsystems.moderation.status).border}`, padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800' }}>
              {data.subsystems.moderation.status.toUpperCase()}
            </span>
          </div>
          <p style={{ margin: '0 0 4px 0', fontSize: '12px', color: '#888' }}>
            API Key: <strong style={{ color: data.subsystems.moderation.hasApiKey ? '#6ee7b7' : '#fca5a5' }}>{data.subsystems.moderation.hasApiKey ? 'Configured' : 'Missing'}</strong>
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#666' }}>{data.subsystems.moderation.provider}</p>
        </div>

        {/* Image Generation */}
        <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '12px', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontWeight: '700', fontSize: '14px' }}>🎨 Image Generation</span>
            <span style={{ background: getStatusBadge(data.subsystems.image_generation.status).bg, color: getStatusBadge(data.subsystems.image_generation.status).color, border: `1px solid ${getStatusBadge(data.subsystems.image_generation.status).border}`, padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800' }}>
              {data.subsystems.image_generation.status.toUpperCase()}
            </span>
          </div>
          <p style={{ margin: '0 0 4px 0', fontSize: '12px', color: '#888' }}>
            Engine: <strong style={{ color: '#ddd' }}>node-canvas (1080x1350)</strong>
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#666' }}>Multi-slide automatic pagination ready</p>
        </div>

        {/* Storage */}
        <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '12px', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontWeight: '700', fontSize: '14px' }}>📦 Storage (S3 / Supabase)</span>
            <span style={{ background: getStatusBadge(data.subsystems.storage.status).bg, color: getStatusBadge(data.subsystems.storage.status).color, border: `1px solid ${getStatusBadge(data.subsystems.storage.status).border}`, padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800' }}>
              {data.subsystems.storage.status.toUpperCase()}
            </span>
          </div>
          <p style={{ margin: '0 0 4px 0', fontSize: '12px', color: '#888' }}>
            Bucket: <strong style={{ color: '#ddd' }}>confession-images</strong>
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#666' }}>Service-role credentials server-only</p>
        </div>

        {/* Instagram */}
        <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '12px', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontWeight: '700', fontSize: '14px' }}>📸 Instagram Graph API</span>
            <span style={{ background: getStatusBadge(data.subsystems.instagram.status).bg, color: getStatusBadge(data.subsystems.instagram.status).color, border: `1px solid ${getStatusBadge(data.subsystems.instagram.status).border}`, padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800' }}>
              {data.subsystems.instagram.status.toUpperCase()}
            </span>
          </div>
          <p style={{ margin: '0 0 4px 0', fontSize: '12px', color: '#888' }}>
            Account ID: <strong style={{ color: data.subsystems.instagram.hasAccountId ? '#6ee7b7' : '#fca5a5' }}>{data.subsystems.instagram.hasAccountId ? 'Set' : 'Missing'}</strong> | Token: <strong style={{ color: data.subsystems.instagram.hasAccessToken ? '#6ee7b7' : '#fca5a5' }}>{data.subsystems.instagram.hasAccessToken ? 'Set' : 'Missing'}</strong>
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#666' }}>{data.subsystems.instagram.details}</p>
        </div>
      </div>

      {/* Worker Lease & Heartbeat Section */}
      <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '14px', padding: '22px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: '800' }}>🛡️ Worker Concurrency Lease & Heartbeat</h3>
            <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>
              Durable Postgres lease (<code>agent_locks</code>) guarantees split-brain immunity during automated runs.
            </p>
          </div>
          {data.worker.isStale && (
            <button
              onClick={handleReleaseStaleLock}
              disabled={actionLoading}
              style={{ background: '#b45309', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}
            >
              {actionLoading ? 'Releasing...' : '🧹 Release Stale Lease'}
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', background: '#0d0d0d', padding: '16px', borderRadius: '10px', border: '1px solid #222' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#666', textTransform: 'uppercase', fontWeight: '700' }}>Lock Name</div>
            <div style={{ fontSize: '14px', fontWeight: '600', color: '#ddd', marginTop: '2px' }}>{data.worker.lockName}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#666', textTransform: 'uppercase', fontWeight: '700' }}>Status</div>
            <div style={{ fontSize: '14px', fontWeight: '700', marginTop: '2px', color: data.worker.isLocked ? '#6ee7b7' : '#9ca3af' }}>
              {data.worker.isLocked ? (data.worker.isStale ? '⚠️ EXPIRED (STALE)' : '🔒 ACTIVE LEASE') : '🟢 IDLE (UNLOCKED)'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#666', textTransform: 'uppercase', fontWeight: '700' }}>Current Owner</div>
            <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px', fontFamily: 'monospace' }}>
              {data.worker.lockedBy || 'None'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#666', textTransform: 'uppercase', fontWeight: '700' }}>Expires At</div>
            <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>
              {data.worker.expiresAt ? new Date(data.worker.expiresAt).toLocaleString() : 'N/A'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#666', textTransform: 'uppercase', fontWeight: '700' }}>Last Heartbeat</div>
            <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>
              {data.worker.lastHeartbeatAt ? new Date(data.worker.lastHeartbeatAt).toLocaleString() : 'N/A'}
            </div>
          </div>
        </div>
      </div>

      {/* Latest Agent Run */}
      {data.latestRun && (
        <div style={{ background: '#141414', border: '1px solid #282828', borderRadius: '14px', padding: '20px', marginBottom: '28px' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: '800' }}>⚡ Latest Agent Execution History</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', fontSize: '13px' }}>
            <div>
              <span style={{ color: '#666' }}>Run UUID:</span>{' '}
              <span style={{ fontFamily: 'monospace', color: '#ddd' }}>{data.latestRun.runUuid?.slice(0, 12)}...</span>
            </div>
            <div>
              <span style={{ color: '#666' }}>Status:</span>{' '}
              <strong style={{ color: data.latestRun.status === 'completed' ? '#6ee7b7' : '#fcd34d' }}>{data.latestRun.status}</strong>
            </div>
            <div>
              <span style={{ color: '#666' }}>Started:</span>{' '}
              <span style={{ color: '#ddd' }}>{data.latestRun.startedAt ? new Date(data.latestRun.startedAt).toLocaleTimeString() : 'N/A'}</span>
            </div>
            <div>
              <span style={{ color: '#666' }}>Processed:</span>{' '}
              <span style={{ color: '#ddd' }}>{data.latestRun.confessionsProcessed ?? 0}</span>
            </div>
            <div>
              <span style={{ color: '#666' }}>Posted:</span>{' '}
              <span style={{ color: '#ddd' }}>{data.latestRun.confessionsPosted ?? 0}</span>
            </div>
          </div>
          {data.latestRun.errorSummary && (
            <div style={{ marginTop: '10px', background: '#260a0a', border: '1px solid #7f1d1d', borderRadius: '8px', padding: '10px', fontSize: '12px', color: '#fca5a5' }}>
              Error Summary: {data.latestRun.errorSummary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
