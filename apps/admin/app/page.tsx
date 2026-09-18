'use client';
import { useState, useEffect, useCallback } from 'react';
import HealthView from '@/components/HealthView';
import AuditView from '@/components/AuditView';
import PlaygroundView from '@/components/PlaygroundView';
import SettingsView from '@/components/SettingsView';

export type AdminNavTab = 'queue' | 'health' | 'audit' | 'playground' | 'settings';

export type ConfessionStatus =
  | 'pending'
  | 'pending_review'
  | 'processing'
  | 'approved'
  | 'posting'
  | 'posted'
  | 'rejected'
  | 'failed';

export interface Confession {
  id: number;
  text: string;
  status: ConfessionStatus;
  number?: number | null;
  failure_stage?: string | null;
  last_error?: string | null;
  attempt_count?: number;
  last_progress_at?: string | null;
  ai_verdict?: string | null;
  decision_reason?: string | null;
  model_confidence?: number | null;
  matched_rules?: string[] | Record<string, unknown> | null;
  policy_level?: number | null;
  flags?: string[] | null;
  parts: string;
  imageUrls: string;
  image_urls?: string[] | null;
  igPostId?: string | null;
  igPermalink?: string | null;
  createdAt: string;
  updatedAt: string;
  posted_at?: string | null;
}

type CountsMap = Record<string, number>;

type ConfirmationModalState =
  | { type: 'force_approve'; confession: Confession }
  | { type: 'force_reject'; confession: Confession }
  | { type: 'rerun_ai'; confession: Confession }
  | { type: 'delete'; confession: Confession }
  | null;

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'processing', label: 'Processing' },
  { key: 'posting', label: 'Posting' },
  { key: 'posted', label: 'Posted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'failed', label: 'Failed' },
];

const PAGE_LIMIT = 20;

export default function AdminPage() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [activeNavTab, setActiveNavTab] = useState<AdminNavTab>('queue');

  const [confessions, setConfessions] = useState<Confession[]>([]);
  const [statusFilter, setStatusFilter] = useState('pending_review');
  const [page, setPage] = useState(1);
  const [counts, setCounts] = useState<CountsMap>({});
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);

  // Modals
  const [previewConfession, setPreviewConfession] = useState<Confession | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmationModalState>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  // Check auth
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/admin/me');
        if (res.ok) {
          setLoggedIn(true);
        }
      } catch {
        // Unauthenticated
      }
      setCheckingAuth(false);
    };
    checkAuth();
  }, []);

  // Fetch counts
  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/confessions/counts');
      if (res.ok) {
        const data = await res.json();
        if (data.counts) {
          setCounts(data.counts);
        }
      }
    } catch {
      // Ignore count fetch errors
    }
  }, []);

  // Fetch confessions with filter & pagination
  const fetchConfessions = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        status: statusFilter,
        page: String(page),
        limit: String(PAGE_LIMIT),
      });
      const res = await fetch(`/api/confessions?${query.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setConfessions(Array.isArray(data) ? data : []);
      } else if (res.status === 401) {
        setLoggedIn(false);
      } else {
        const err = await res.json();
        setMsg({ text: `Failed to load confessions: ${err.error || 'Server error'}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error while fetching confessions', isError: true });
    }
    setLoading(false);
  }, [statusFilter, page]);

  useEffect(() => {
    if (loggedIn) {
      fetchConfessions();
      fetchCounts();
    }
  }, [loggedIn, fetchConfessions, fetchCounts]);

  const handleFilterChange = (newStatus: string) => {
    setStatusFilter(newStatus);
    setPage(1);
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        setLoggedIn(true);
        setLoginError('');
      } else {
        const d = await res.json();
        setLoginError(d.error || 'Login failed');
      }
    } catch {
      setLoginError('Network error during login');
    }
  };

  const logout = async () => {
    await fetch('/api/admin/logout', {
      method: 'POST',
      headers: { 'X-Admin-Action': '1' },
    });
    setLoggedIn(false);
    setConfessions([]);
  };

  // ---------------------------------------------------------------------------
  // Action Handlers
  // ---------------------------------------------------------------------------

  const handleForceApprove = async (confession: Confession) => {
    setActionLoading(confession.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/confessions/${confession.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ text: `✅ Confession #${confession.number || confession.id} force approved`, isError: false });
        fetchConfessions();
        fetchCounts();
      } else {
        setMsg({ text: `Approval Error: ${data.error || 'Failed to approve'}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error during approval', isError: true });
    }
    setActionLoading(null);
    setConfirmModal(null);
  };

  const handleForceReject = async (confession: Confession, reason: string) => {
    setActionLoading(confession.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/confessions/${confession.id}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ text: `❌ Confession #${confession.number || confession.id} force rejected`, isError: false });
        fetchConfessions();
        fetchCounts();
      } else {
        setMsg({ text: `Rejection Error: ${data.error || 'Failed to reject'}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error during rejection', isError: true });
    }
    setActionLoading(null);
    setConfirmModal(null);
    setRejectionReason('');
  };

  const handleRerunAi = async (confession: Confession) => {
    setActionLoading(confession.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/confessions/${confession.id}/re-moderate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ text: `🔄 Confession #${confession.number || confession.id} queued for fresh AI moderation (status: pending)`, isError: false });
        fetchConfessions();
        fetchCounts();
      } else {
        setMsg({ text: `Re-run Error: ${data.error || 'Failed to queue re-run'}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error during re-moderation', isError: true });
    }
    setActionLoading(null);
    setConfirmModal(null);
  };

  const handleDelete = async (confession: Confession) => {
    setActionLoading(confession.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/confessions/${confession.id}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Action': '1' },
      });
      if (res.ok) {
        setMsg({ text: `🗑 Confession #${confession.number || confession.id} soft-deleted`, isError: false });
        fetchConfessions();
        fetchCounts();
      } else {
        const data = await res.json();
        setMsg({ text: `Delete Error: ${data.error || 'Failed to delete'}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error during delete', isError: true });
    }
    setActionLoading(null);
    setConfirmModal(null);
  };

  const approveAndGenerateImages = async (c: Confession) => {
    setActionLoading(c.id);
    setMsg(null);
    try {
      const res = await fetch('/api/generate-images', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
        body: JSON.stringify({ id: c.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ text: `✅ Images generated for #${data.confessionNumber}`, isError: false });
        setPreviewConfession({
          ...c,
          status: 'approved',
          number: data.confessionNumber,
          imageUrls: JSON.stringify(data.imageUrls),
        });
        fetchConfessions();
        fetchCounts();
      } else {
        setMsg({ text: `Error: ${data.error}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error while generating images', isError: true });
    }
    setActionLoading(null);
  };

  const postToInstagram = async (id: number) => {
    setActionLoading(id);
    setMsg(null);
    try {
      const res = await fetch('/api/post-to-instagram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (res.ok) {
        const permalink = data.igPermalink ? ` — ${data.igPermalink}` : '';
        setMsg({ text: `✅ Posted to Instagram! Post ID: ${data.igPostId}${permalink}`, isError: false });
        fetchConfessions();
        fetchCounts();
      } else {
        setMsg({ text: `Instagram Post Error: ${data.error}`, isError: true });
      }
    } catch {
      setMsg({ text: 'Network error while posting to Instagram', isError: true });
    }
    setActionLoading(null);
  };

  const downloadImages = (c: Confession) => {
    const urls: string[] = JSON.parse(c.imageUrls || '[]');
    urls.forEach((url: string, i: number) => {
      const link = document.createElement('a');
      link.href = url;
      link.download = `confession-${c.number || c.id}-part-${i + 1}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  };

  // ---------------------------------------------------------------------------
  // Visual Design Tokens
  // ---------------------------------------------------------------------------
  const getStatusBadgeStyle = (st: string) => {
    switch (st) {
      case 'pending':
        return { bg: '#312e81', color: '#a5b4fc', border: '#4338ca', label: '⏳ Pending Moderation' };
      case 'pending_review':
        return { bg: '#451a03', color: '#fcd34d', border: '#b45309', label: '⚠️ Needs Review' };
      case 'processing':
        return { bg: '#1e3a8a', color: '#93c5fd', border: '#2563eb', label: '⚙️ Processing' };
      case 'approved':
        return { bg: '#064e3b', color: '#6ee7b7', border: '#059669', label: '✅ Approved' };
      case 'posting':
        return { bg: '#164e63', color: '#67e8f9', border: '#0891b2', label: '🚀 Posting' };
      case 'posted':
        return { bg: '#14532d', color: '#86efac', border: '#16a34a', label: '📸 Posted' };
      case 'rejected':
        return { bg: '#4c0519', color: '#fda4af', border: '#e11d48', label: '❌ Rejected' };
      case 'failed':
        return { bg: '#450a0a', color: '#fca5a5', border: '#dc2626', label: '💥 Failed' };
      default:
        return { bg: '#262626', color: '#d4d4d4', border: '#525252', label: st };
    }
  };

  if (checkingAuth) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
          <p style={{ color: '#888' }}>Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ width: '380px', background: '#111', borderRadius: '16px', padding: '32px', border: '1px solid #222', boxShadow: '0 20px 40px rgba(0,0,0,0.6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', gap: '12px' }}>
            <img src="/logo.png" alt="Logo" style={{ width: '32px', height: '32px', borderRadius: '8px', objectFit: 'cover' }} />
            <h1 style={{ color: '#6366f1', fontSize: '22px', fontWeight: '800', margin: 0 }}>BU Confessions</h1>
          </div>
          <p style={{ color: '#888', fontSize: '14px', textAlign: 'center', marginBottom: '20px' }}>Sign in to admin moderation queue</p>
          <form onSubmit={login}>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', color: '#fff', marginBottom: '12px', fontSize: '15px' }}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', color: '#fff', marginBottom: '16px', fontSize: '15px' }}
            />
            {loginError && <p style={{ color: '#ef4444', marginBottom: '12px', fontSize: '13px' }}>{loginError}</p>}
            <button
              type="submit"
              style={{ width: '100%', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontWeight: '700', cursor: 'pointer', fontSize: '15px' }}
            >
              Sign In
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'Inter,sans-serif' }}>
      {/* Top Navbar */}
      <nav style={{ background: '#111', borderBottom: '1px solid #222', padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="/logo.png" alt="Logo" style={{ width: '30px', height: '30px', borderRadius: '8px', objectFit: 'cover' }} />
          <span style={{ fontSize: '18px', fontWeight: '800', color: '#6366f1' }}>BU Confessions</span>
          <span style={{ background: '#222', border: '1px solid #333', color: '#aaa', padding: '2px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: '700' }}>Admin Queue v3.4</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={() => { fetchConfessions(); fetchCounts(); }}
            style={{ background: '#1a1a1a', border: '1px solid #333', color: '#ddd', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
          >
            🔄 Refresh
          </button>
          <button
            onClick={logout}
            style={{ background: 'transparent', border: '1px solid #444', color: '#aaa', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px' }}
          >
            Logout
          </button>
        </div>
      </nav>

      {/* Navigation Sub-Bar */}
      <div style={{ background: '#0d0d0d', borderBottom: '1px solid #1f1f1f', padding: '0 28px' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', gap: '4px', overflowX: 'auto' }}>
          {[
            { key: 'queue', label: 'Moderation Queue', icon: '📬', badge: counts.pending_review || 0 },
            { key: 'health', label: 'Health & Heartbeat', icon: '🛡️' },
            { key: 'audit', label: 'Audit Trail', icon: '📋' },
            { key: 'playground', label: 'Rules Playground', icon: '🧪' },
            { key: 'settings', label: 'Operational Settings', icon: '⚙️' },
          ].map((tab) => {
            const isActive = activeNavTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveNavTab(tab.key as AdminNavTab)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${isActive ? '#6366f1' : 'transparent'}`,
                  color: isActive ? '#fff' : '#888',
                  padding: '14px 16px',
                  fontWeight: isActive ? '700' : '500',
                  fontSize: '13px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s ease',
                }}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span
                    style={{
                      background: '#451a03',
                      color: '#fcd34d',
                      border: '1px solid #b45309',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      fontSize: '10px',
                      fontWeight: '800',
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Container */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '28px 20px' }}>
        {/* Banner Alert */}
        {msg && (
          <div
            style={{
              background: msg.isError ? '#450a0a' : '#052e16',
              border: `1px solid ${msg.isError ? '#dc2626' : '#16a34a'}`,
              borderRadius: '10px',
              padding: '14px 18px',
              marginBottom: '20px',
              color: msg.isError ? '#fca5a5' : '#86efac',
              fontSize: '14px',
              fontWeight: '500',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{msg.text}</span>
            <button
              onClick={() => setMsg(null)}
              style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}
            >
              &times;
            </button>
          </div>
        )}

        {/* Operational Views */}
        {activeNavTab === 'health' && <HealthView />}
        {activeNavTab === 'audit' && <AuditView />}
        {activeNavTab === 'playground' && <PlaygroundView />}
        {activeNavTab === 'settings' && <SettingsView />}

        {activeNavTab === 'queue' && (
          <>
            {/* Status Filter Bar with Live Counts */}
            <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {STATUS_FILTERS.map((f) => {
              const count = counts[f.key] ?? 0;
              const isSelected = statusFilter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => handleFilterChange(f.key)}
                  style={{
                    background: isSelected ? '#6366f1' : '#141414',
                    color: isSelected ? '#fff' : '#aaa',
                    border: `1px solid ${isSelected ? '#6366f1' : '#282828'}`,
                    borderRadius: '8px',
                    padding: '8px 14px',
                    cursor: 'pointer',
                    fontWeight: isSelected ? '700' : '500',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span>{f.label}</span>
                  <span
                    style={{
                      background: isSelected ? 'rgba(255,255,255,0.25)' : '#262626',
                      color: isSelected ? '#fff' : '#888',
                      padding: '1px 7px',
                      borderRadius: '12px',
                      fontSize: '11px',
                      fontWeight: '700',
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Confession Cards Queue */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#666' }}>
            <div style={{ fontSize: '28px', marginBottom: '12px' }}>⏳</div>
            <p>Loading queue...</p>
          </div>
        ) : confessions.length === 0 ? (
          <div style={{ background: '#111', border: '1px dashed #333', borderRadius: '12px', padding: '60px 20px', textAlign: 'center', color: '#777' }}>
            <div style={{ fontSize: '32px', marginBottom: '10px' }}>📭</div>
            <p style={{ fontSize: '15px', fontWeight: '600', color: '#bbb' }}>No confessions in this view</p>
            <p style={{ fontSize: '13px', marginTop: '4px' }}>There are currently no confessions matching the &quot;{statusFilter}&quot; filter.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {confessions.map((c) => {
              const badge = getStatusBadgeStyle(c.status);
              const isLoading = actionLoading === c.id;
              const images: string[] = JSON.parse(c.imageUrls || '[]');

              // Allowed transitions for this card
              const canForceApprove = ['pending_review', 'rejected', 'pending', 'failed'].includes(c.status);
              const canForceReject = ['pending_review', 'pending', 'approved', 'failed'].includes(c.status);
              const canRerunAi = ['pending_review', 'rejected', 'failed', 'approved'].includes(c.status);

              return (
                <div
                  key={c.id}
                  style={{
                    background: '#161616',
                    border: '1px solid #282828',
                    borderRadius: '12px',
                    padding: '22px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                  }}
                >
                  {/* Card Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '16px', fontWeight: '800', color: '#fff' }}>
                        {c.number ? `#${c.number}` : <span style={{ color: '#777', fontWeight: '600', fontSize: '14px' }}>Unassigned #</span>}
                      </span>
                      <span style={{ color: '#666', fontSize: '12px', fontFamily: 'monospace' }}>ID: {c.id}</span>
                      <span
                        style={{
                          background: badge.bg,
                          color: badge.color,
                          border: `1px solid ${badge.border}`,
                          padding: '3px 10px',
                          borderRadius: '16px',
                          fontSize: '11px',
                          fontWeight: '700',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                        }}
                      >
                        {badge.label}
                      </span>
                      {c.failure_stage && (
                        <span style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #991b1b', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: '700' }}>
                          Stage: {c.failure_stage}
                        </span>
                      )}
                      {c.attempt_count !== undefined && c.attempt_count > 0 && (
                        <span style={{ background: '#262626', color: '#bbb', padding: '2px 8px', borderRadius: '12px', fontSize: '11px' }}>
                          Attempts: {c.attempt_count}
                        </span>
                      )}
                      {c.igPostId && (
                        <span style={{ color: '#4ade80', fontSize: '12px', fontWeight: '600' }}>
                          IG: {c.igPostId}
                        </span>
                      )}
                      {c.igPermalink && (
                        <a
                          href={c.igPermalink}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#93c5fd', fontSize: '12px', textDecoration: 'none', borderBottom: '1px dotted #93c5fd' }}
                        >
                          View Post ↗
                        </a>
                      )}
                    </div>
                    <div style={{ color: '#666', fontSize: '12px', textAlign: 'right' }}>
                      <div>Created: {new Date(c.createdAt).toLocaleString('en-IN')}</div>
                      {c.updatedAt && c.updatedAt !== c.createdAt && (
                        <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>
                          Updated: {new Date(c.updatedAt).toLocaleString('en-IN')}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Confession Text Content */}
                  <div style={{ background: '#111', border: '1px solid #222', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
                    <p style={{ color: '#eee', lineHeight: '1.65', fontSize: '15px', whiteSpace: 'pre-wrap', margin: 0 }}>
                      {c.text}
                    </p>
                  </div>

                  {/* Moderation / Error Metadata Box */}
                  {(c.last_error || c.decision_reason || c.ai_verdict || c.model_confidence !== undefined) && (
                    <div
                      style={{
                        background: c.last_error ? '#2a0e0e' : '#1c1c1c',
                        border: `1px solid ${c.last_error ? '#7f1d1d' : '#333'}`,
                        borderRadius: '8px',
                        padding: '12px 14px',
                        marginBottom: '16px',
                        fontSize: '12px',
                      }}
                    >
                      {c.last_error && (
                        <div style={{ color: '#fca5a5', marginBottom: '6px', fontWeight: '600' }}>
                          ⚠️ Error: <span style={{ fontWeight: 'normal', color: '#fecaca' }}>{c.last_error}</span>
                        </div>
                      )}
                      {c.decision_reason && (
                        <div style={{ color: '#d4d4d4', marginBottom: '4px' }}>
                          <strong style={{ color: '#a3a3a3' }}>Reason:</strong> {c.decision_reason}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', color: '#888', marginTop: '6px' }}>
                        {c.ai_verdict && <span>AI Verdict: <strong style={{ color: '#ddd' }}>{c.ai_verdict}</strong></span>}
                        {c.policy_level !== undefined && c.policy_level !== null && (
                          <span>Policy Level: <strong style={{ color: '#ddd' }}>Level {c.policy_level}</strong></span>
                        )}
                        {typeof c.model_confidence === 'number' && (
                          <span>Confidence: <strong style={{ color: '#ddd' }}>{(c.model_confidence * 100).toFixed(0)}%</strong></span>
                        )}
                        {c.last_progress_at && (
                          <span>Last Progress: {new Date(c.last_progress_at).toLocaleTimeString('en-IN')}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Carousel Thumbnails */}
                  {images.length > 0 && (
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '6px' }}>
                      {images.map((url: string, i: number) => (
                        <img
                          key={i}
                          src={url}
                          alt={`Slide ${i + 1}`}
                          onClick={() => setPreviewConfession(c)}
                          style={{
                            width: '100px',
                            height: '100px',
                            borderRadius: '8px',
                            objectFit: 'cover',
                            border: '1px solid #333',
                            cursor: 'pointer',
                            flexShrink: 0,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Actions Toolbar */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {/* Moderation Actions */}
                    {canForceApprove && (
                      <button
                        onClick={() => setConfirmModal({ type: 'force_approve', confession: c })}
                        disabled={isLoading}
                        style={{
                          background: '#059669',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '7px 14px',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: isLoading ? 'not-allowed' : 'pointer',
                          opacity: isLoading ? 0.6 : 1,
                        }}
                      >
                        ✓ Force Approve
                      </button>
                    )}

                    {canForceReject && (
                      <button
                        onClick={() => setConfirmModal({ type: 'force_reject', confession: c })}
                        disabled={isLoading}
                        style={{
                          background: '#dc2626',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '7px 14px',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: isLoading ? 'not-allowed' : 'pointer',
                          opacity: isLoading ? 0.6 : 1,
                        }}
                      >
                        ✕ Force Reject
                      </button>
                    )}

                    {canRerunAi && (
                      <button
                        onClick={() => setConfirmModal({ type: 'rerun_ai', confession: c })}
                        disabled={isLoading}
                        style={{
                          background: '#4338ca',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '7px 14px',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: isLoading ? 'not-allowed' : 'pointer',
                          opacity: isLoading ? 0.6 : 1,
                        }}
                      >
                        🔄 Re-run AI
                      </button>
                    )}

                    {/* Operational Actions */}
                    {c.status === 'approved' && images.length === 0 && (
                      <button
                        onClick={() => approveAndGenerateImages(c)}
                        disabled={isLoading}
                        style={{
                          background: '#6366f1',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '7px 14px',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: isLoading ? 'not-allowed' : 'pointer',
                          opacity: isLoading ? 0.6 : 1,
                        }}
                      >
                        {isLoading ? 'Processing...' : '📸 Generate Images'}
                      </button>
                    )}

                    {c.status === 'approved' && images.length > 0 && (
                      <button
                        onClick={() => setPreviewConfession(c)}
                        disabled={isLoading}
                        style={{
                          background: '#16a34a',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '7px 14px',
                          fontSize: '13px',
                          fontWeight: '600',
                          cursor: isLoading ? 'not-allowed' : 'pointer',
                        }}
                      >
                        📸 Preview & Post
                      </button>
                    )}

                    {images.length > 0 && (
                      <button
                        onClick={() => downloadImages(c)}
                        style={{
                          background: '#262626',
                          color: '#ccc',
                          border: '1px solid #333',
                          borderRadius: '6px',
                          padding: '7px 12px',
                          fontSize: '13px',
                          cursor: 'pointer',
                        }}
                      >
                        ⬇ Download
                      </button>
                    )}

                    <button
                      onClick={() => setConfirmModal({ type: 'delete', confession: c })}
                      disabled={isLoading}
                      style={{
                        background: 'transparent',
                        color: '#ef4444',
                        border: '1px solid #7f1d1d',
                        borderRadius: '6px',
                        padding: '7px 12px',
                        fontSize: '13px',
                        cursor: isLoading ? 'not-allowed' : 'pointer',
                        marginLeft: 'auto',
                      }}
                    >
                      🗑 Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination Bar */}
        {confessions.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px', padding: '12px 0', borderTop: '1px solid #222' }}>
            <span style={{ color: '#777', fontSize: '13px' }}>
              Showing Page {page} ({confessions.length} items loaded)
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{
                  background: '#1a1a1a',
                  border: '1px solid #333',
                  color: page === 1 ? '#555' : '#ccc',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  cursor: page === 1 ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                }}
              >
                ← Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={confessions.length < PAGE_LIMIT}
                style={{
                  background: '#1a1a1a',
                  border: '1px solid #333',
                  color: confessions.length < PAGE_LIMIT ? '#555' : '#ccc',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  cursor: confessions.length < PAGE_LIMIT ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                }}
              >
                Next →
              </button>
            </div>
          </div>
        )}
        </>
        )}
      </main>

      {/* Confirmation Modal */}
      {confirmModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: '#1c1c1c', border: '1px solid #333', borderRadius: '14px', padding: '24px', maxWidth: '480px', width: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.7)' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '12px', color: '#fff' }}>
              {confirmModal.type === 'force_approve' && 'Confirm Force Approve'}
              {confirmModal.type === 'force_reject' && 'Confirm Force Reject'}
              {confirmModal.type === 'rerun_ai' && 'Confirm Re-run AI Moderation'}
              {confirmModal.type === 'delete' && 'Confirm Soft-Delete'}
            </h3>

            <p style={{ color: '#ccc', fontSize: '14px', lineHeight: '1.5', marginBottom: '16px' }}>
              {confirmModal.type === 'force_approve' &&
                `Are you sure you want to force-approve Confession #${confirmModal.confession.number || confirmModal.confession.id}? It will be queued for publication.`}
              {confirmModal.type === 'force_reject' &&
                `Are you sure you want to reject Confession #${confirmModal.confession.number || confirmModal.confession.id}? It will be moved to the rejected queue.`}
              {confirmModal.type === 'rerun_ai' &&
                `Are you sure you want to reset and re-run AI moderation on Confession #${confirmModal.confession.number || confirmModal.confession.id}? Previous AI verdicts and moderation flags will be cleared.`}
              {confirmModal.type === 'delete' &&
                `Are you sure you want to soft-delete Confession #${confirmModal.confession.number || confirmModal.confession.id}? It will be archived and removed from default views.`}
            </p>

            {confirmModal.type === 'force_reject' && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', color: '#aaa', fontSize: '12px', marginBottom: '6px' }}>
                  Rejection Reason (Optional):
                </label>
                <input
                  type="text"
                  placeholder="e.g. Violates campus privacy policy"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#111',
                    border: '1px solid #333',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    color: '#fff',
                    fontSize: '13px',
                  }}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setConfirmModal(null); setRejectionReason(''); }}
                style={{ background: '#262626', color: '#ccc', border: 'none', borderRadius: '6px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              {confirmModal.type === 'force_approve' && (
                <button
                  onClick={() => handleForceApprove(confirmModal.confession)}
                  style={{ background: '#059669', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}
                >
                  Confirm Approve
                </button>
              )}
              {confirmModal.type === 'force_reject' && (
                <button
                  onClick={() => handleForceReject(confirmModal.confession, rejectionReason)}
                  style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}
                >
                  Confirm Reject
                </button>
              )}
              {confirmModal.type === 'rerun_ai' && (
                <button
                  onClick={() => handleRerunAi(confirmModal.confession)}
                  style={{ background: '#4338ca', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}
                >
                  Confirm Re-run
                </button>
              )}
              {confirmModal.type === 'delete' && (
                <button
                  onClick={() => handleDelete(confirmModal.confession)}
                  style={{ background: '#991b1b', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}
                >
                  Confirm Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Image Preview / Instagram Publish Modal */}
      {previewConfession && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: '16px', padding: '24px', maxWidth: '800px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 'bold' }}>
                Confession #{previewConfession.number || previewConfession.id} Preview
              </h2>
              <button
                onClick={() => setPreviewConfession(null)}
                style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: '28px', cursor: 'pointer', lineHeight: 1 }}
              >
                &times;
              </button>
            </div>

            <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', overflowX: 'auto', paddingBottom: '12px' }}>
              {JSON.parse(previewConfession.imageUrls || '[]').map((url: string, i: number) => (
                <img
                  key={i}
                  src={url}
                  alt={`Slide ${i + 1}`}
                  style={{ width: '300px', height: '300px', borderRadius: '12px', objectFit: 'cover', border: '1px solid #444', flexShrink: 0 }}
                />
              ))}
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPreviewConfession(null)}
                style={{ background: '#333', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 18px', cursor: 'pointer' }}
              >
                Close
              </button>
              <button
                onClick={async () => {
                  await postToInstagram(previewConfession.id);
                  setPreviewConfession(null);
                }}
                disabled={actionLoading === previewConfession.id}
                style={{
                  background: '#6366f1',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '10px 20px',
                  fontWeight: '700',
                  cursor: actionLoading === previewConfession.id ? 'not-allowed' : 'pointer',
                  opacity: actionLoading === previewConfession.id ? 0.6 : 1,
                }}
              >
                {actionLoading === previewConfession.id ? 'Publishing...' : '🚀 Post to Instagram'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
