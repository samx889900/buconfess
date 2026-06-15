'use client';
import { useState, useEffect, useCallback } from 'react';

type Confession = {
  id: number;
  text: string;
  status: string;
  number?: number;
  parts: string;
  imageUrls: string;
  igPostId?: string;
  igPermalink?: string;
  createdAt: string;
};

export default function AdminPage() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [confessions, setConfessions] = useState<Confession[]>([]);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [previewConfession, setPreviewConfession] = useState<Confession | null>(null);

  // Check if admin is already logged in (JWT cookie persists across refreshes)
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/admin/me');
        if (res.ok) {
          setLoggedIn(true);
        }
      } catch {
        // Not logged in
      }
      setCheckingAuth(false);
    };
    checkAuth();
  }, []);

  const fetchConfessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/confessions?status=' + statusFilter);
      if (res.ok) setConfessions(await res.json());
      else if (res.status === 401) {
        setLoggedIn(false);
      }
    } catch {
      // Network error
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    if (loggedIn) fetchConfessions();
  }, [loggedIn, fetchConfessions]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) { setLoggedIn(true); setLoginError(''); }
    else { const d = await res.json(); setLoginError(d.error || 'Login failed'); }
  };

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    setLoggedIn(false);
    setConfessions([]);
  };

  const approveAndPreview = async (c: Confession) => {
    setActionLoading(c.id); setMsg('');
    try {
      const res = await fetch('/api/generate-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id }),
      });
      const data = await res.json();
      if (res.ok) { 
        setMsg('✅ Images generated for #' + data.confessionNumber); 
        setPreviewConfession({
          ...c,
          status: 'approved',
          number: data.confessionNumber,
          imageUrls: JSON.stringify(data.imageUrls)
        });
        fetchConfessions(); 
      }
      else setMsg('Error: ' + data.error);
    } catch {
      setMsg('Error: Network error while generating images');
    }
    setActionLoading(null);
  };

  const handleModalPost = async (id: number) => {
    await postToInstagram(id);
    setPreviewConfession(null);
  };

  const generateImages = async (id: number) => {
    setActionLoading(id); setMsg('');
    try {
      const res = await fetch('/api/generate-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (res.ok) { setMsg('✅ Images generated for #' + data.confessionNumber); fetchConfessions(); }
      else setMsg('Error: ' + data.error);
    } catch {
      setMsg('Error: Network error while generating images');
    }
    setActionLoading(null);
  };

  const postToInstagram = async (id: number) => {
    setActionLoading(id); setMsg('');
    try {
      const res = await fetch('/api/post-to-instagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (res.ok) {
        const permalink = data.igPermalink ? ` — ${data.igPermalink}` : '';
        setMsg(`✅ Posted to Instagram! Post ID: ${data.igPostId}${permalink}`);
        fetchConfessions();
      }
      else setMsg('Error: ' + data.error);
    } catch {
      setMsg('Error: Network error while posting to Instagram');
    }
    setActionLoading(null);
  };

  const deleteConfession = async (id: number) => {
    if (!confirm('Delete this confession?')) return;
    setActionLoading(id);
    await fetch('/api/confessions/' + id, { method: 'DELETE' });
    fetchConfessions();
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

  const s: Record<string, any> = {
    page: { minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'Inter,sans-serif' },
    nav: { background: '#111', borderBottom: '1px solid #222', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    logo: { fontSize: '18px', fontWeight: '700', color: '#6366f1' },
    main: { maxWidth: '1100px', margin: '0 auto', padding: '24px' },
    card: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '12px', padding: '20px', marginBottom: '16px' },
    badge: (st: string) => ({ display: 'inline-block', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: '700', background: st === 'posted' ? '#16a34a22' : st === 'approved' ? '#d97706' + '22' : '#6366f122', color: st === 'posted' ? '#4ade80' : st === 'approved' ? '#fbbf24' : '#818cf8' }),
    btn: (col: string, dis = false) => ({ background: dis ? '#333' : col, color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 16px', cursor: dis ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: '600', opacity: dis ? 0.6 : 1, transition: 'opacity 0.2s' }),
  };

  // Show loading spinner while checking auth
  if (checkingAuth) {
    return (
      <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px', animation: 'spin 1s linear infinite' }}>⏳</div>
          <p style={{ color: '#666' }}>Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '360px', background: '#111', borderRadius: '16px', padding: '32px', border: '1px solid #222' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', gap: '12px' }}>
            <img src="/logo.png" alt="Logo" style={{ width: '32px', height: '32px', borderRadius: '8px', objectFit: 'cover' }} />
            <h1 style={{ color: '#6366f1', fontSize: '22px', fontWeight: '800', margin: 0 }}>BU Confessions Admin</h1>
          </div>
          <form onSubmit={login}>
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username"
              style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', color: '#fff', marginBottom: '12px', fontSize: '15px' }} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
              style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', color: '#fff', marginBottom: '16px', fontSize: '15px' }} />
            {loginError && <p style={{ color: '#ef4444', marginBottom: '12px', fontSize: '13px' }}>{loginError}</p>}
            <button type="submit" style={{ width: '100%', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontWeight: '700', cursor: 'pointer', fontSize: '15px' }}>Login</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <nav style={s.nav}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <img src="/logo.png" alt="Logo" style={{ width: '28px', height: '28px', borderRadius: '6px', objectFit: 'cover' }} />
          <span style={s.logo}>BU Confessions Admin</span>
        </div>
        <button onClick={logout} style={{ background: 'transparent', border: '1px solid #444', color: '#aaa', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer' }}>Logout</button>
      </nav>
      <div style={s.main}>
        {msg && <div style={{ background: msg.startsWith('Error') ? '#450a0a' : '#052e16', border: '1px solid ' + (msg.startsWith('Error') ? '#7f1d1d' : '#14532d'), borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', color: msg.startsWith('Error') ? '#fca5a5' : '#86efac', fontSize: '14px' }}>{msg}</div>}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
          {['pending', 'approved', 'posted'].map(st => (
            <button key={st} onClick={() => setStatusFilter(st)}
              style={{ background: statusFilter === st ? '#6366f1' : '#1a1a1a', color: statusFilter === st ? '#fff' : '#aaa', border: '1px solid ' + (statusFilter === st ? '#6366f1' : '#333'), borderRadius: '8px', padding: '8px 20px', cursor: 'pointer', fontWeight: '600', textTransform: 'capitalize' as const }}>
              {st}
            </button>
          ))}
          <button onClick={fetchConfessions} style={{ background: '#1a1a1a', color: '#aaa', border: '1px solid #333', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', marginLeft: 'auto' }}>Refresh</button>
        </div>
        {loading ? <p style={{ color: '#666' }}>Loading...</p> : confessions.length === 0 ? <p style={{ color: '#666' }}>No confessions found.</p> : (
          confessions.map(c => {
            const images: string[] = JSON.parse(c.imageUrls || '[]');
            const isLoading = actionLoading === c.id;
            return (
              <div key={c.id} style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: '#666', fontSize: '13px' }}>#{c.number || c.id}</span>
                    <span style={s.badge(c.status)}>{c.status}</span>
                    {c.igPostId && <span style={{ color: '#4ade80', fontSize: '11px' }}>IG: {c.igPostId}</span>}
                    {c.igPermalink && (
                      <a href={c.igPermalink} target="_blank" rel="noreferrer" style={{ color: '#93c5fd', fontSize: '11px' }}>
                        View post ↗
                      </a>
                    )}
                  </div>
                  <span style={{ color: '#555', fontSize: '12px', whiteSpace: 'nowrap' }}>{new Date(c.createdAt).toLocaleString('en-IN')}</span>
                </div>
                <p style={{ color: '#ddd', lineHeight: '1.6', marginBottom: '16px', fontSize: '15px', whiteSpace: 'pre-wrap' }}>{c.text}</p>
                {images.length > 0 && (
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '4px' }}>
                    {images.map((url: string, i: number) => (
                      <img key={i} src={url} alt={'Part ' + (i + 1)} style={{ width: '120px', height: '120px', borderRadius: '8px', objectFit: 'cover', border: '1px solid #333', flexShrink: 0 }} />
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {c.status === 'pending' && (
                    <button onClick={() => approveAndPreview(c)} disabled={isLoading} style={s.btn('#6366f1', isLoading)}>
                      {isLoading ? 'Processing...' : '🚀 Approve & Generate Images'}
                    </button>
                  )}
                  {c.status === 'approved' && (
                    <button onClick={() => setPreviewConfession(c)} disabled={isLoading} style={s.btn('#16a34a', isLoading)}>
                      {isLoading ? 'Loading...' : '📸 Preview & Post to Instagram'}
                    </button>
                  )}
                  {c.status === 'approved' && (
                    <button onClick={() => generateImages(c.id)} disabled={isLoading} style={s.btn('#d97706', isLoading)}>
                      🔄 Regenerate Images
                    </button>
                  )}
                  {images.length > 0 && (
                    <button onClick={() => downloadImages(c)} style={s.btn('#3b82f6', false)}>
                      ⬇ Download All
                    </button>
                  )}
                  <button onClick={() => deleteConfession(c.id)} disabled={isLoading} style={s.btn('#7f1d1d', isLoading)}>🗑 Delete</button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Image Preview Modal */}
      {previewConfession && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: '16px', padding: '24px', maxWidth: '800px', width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 'bold' }}>Confession #{previewConfession.number || previewConfession.id} Preview</h2>
              <button onClick={() => setPreviewConfession(null)} style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: '28px', cursor: 'pointer', lineHeight: '1' }}>&times;</button>
            </div>
            
            <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', overflowX: 'auto', paddingBottom: '12px' }}>
              {JSON.parse(previewConfession.imageUrls || '[]').map((url: string, i: number) => (
                <img key={i} src={url} alt={'Part ' + (i + 1)} style={{ width: '320px', height: '320px', borderRadius: '12px', objectFit: 'cover', border: '1px solid #444', flexShrink: 0 }} />
              ))}
            </div>
            
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => setPreviewConfession(null)} disabled={actionLoading === previewConfession.id} style={s.btn('#333', actionLoading === previewConfession.id)}>Cancel</button>
              <button onClick={() => handleModalPost(previewConfession.id)} disabled={actionLoading === previewConfession.id} style={s.btn('#6366f1', actionLoading === previewConfession.id)}>
                {actionLoading === previewConfession.id ? 'Posting...' : '🚀 Post to Instagram'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
