'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setLoginError('');

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        router.push(from);
        router.refresh();
      } else {
        const d = await res.json();
        setLoginError(d.error || 'Login failed');
      }
    } catch {
      setLoginError('Network error while logging in');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={login}>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        required
        autoComplete="username"
        style={{
          width: '100%',
          background: '#1a1a1a',
          border: '1px solid #333',
          borderRadius: '8px',
          padding: '10px 12px',
          color: '#fff',
          marginBottom: '12px',
          fontSize: '15px',
          boxSizing: 'border-box',
        }}
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        required
        autoComplete="current-password"
        style={{
          width: '100%',
          background: '#1a1a1a',
          border: '1px solid #333',
          borderRadius: '8px',
          padding: '10px 12px',
          color: '#fff',
          marginBottom: '16px',
          fontSize: '15px',
          boxSizing: 'border-box',
        }}
      />

      {loginError && (
        <p style={{ color: '#ef4444', marginBottom: '12px', fontSize: '13px' }}>
          {loginError}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        style={{
          width: '100%',
          background: loading ? '#4338ca' : '#6366f1',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          padding: '12px',
          fontWeight: '700',
          cursor: loading ? 'not-allowed' : 'pointer',
          fontSize: '15px',
        }}
      >
        {loading ? 'Logging in...' : 'Login'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        color: '#fff',
        fontFamily: 'Inter,sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '360px',
          background: '#111',
          borderRadius: '16px',
          padding: '32px',
          border: '1px solid #222',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '24px',
            gap: '12px',
          }}
        >
          <img
            src="/icon.png"
            alt="Logo"
            style={{ width: '32px', height: '32px', borderRadius: '8px', objectFit: 'cover' }}
          />
          <h1 style={{ color: '#6366f1', fontSize: '22px', fontWeight: '800', margin: 0 }}>
            BU Confessions Admin
          </h1>
        </div>

        <Suspense fallback={<p style={{ color: '#666', textAlign: 'center' }}>Loading form...</p>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
