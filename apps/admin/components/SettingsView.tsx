'use client';
import { useState, useEffect, useCallback } from 'react';

interface SettingItem {
  key: string;
  value: any;
  type: 'boolean' | 'number' | 'string';
  defaultValue: any;
  description: string;
  min?: number;
  max?: number;
  allowedValues?: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export default function SettingsView() {
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, any>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ setting: SettingItem; newValue: any } | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch operational settings`);
      const json = await res.json();
      setSettings(json.settings || []);

      const initial: Record<string, any> = {};
      for (const s of json.settings || []) {
        initial[s.key] = s.value;
      }
      setEditValues(initial);
    } catch (err: any) {
      setError(err?.message || 'Network error fetching settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleValueChange = (key: string, val: any) => {
    setEditValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleSaveClick = (setting: SettingItem) => {
    const newValue = editValues[setting.key];
    setPendingConfirm({ setting, newValue });
  };

  const executeSave = async () => {
    if (!pendingConfirm) return;
    const { setting, newValue } = pendingConfirm;

    setSavingKey(setting.key);
    setMsg(null);
    setPendingConfirm(null);

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Action': '1',
        },
        body: JSON.stringify({
          key: setting.key,
          value: newValue,
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setMsg({ text: `✅ Setting '${setting.key}' updated successfully!`, isError: false });
        fetchSettings();
      } else {
        setMsg({ text: `❌ Error: ${json.message || json.error}`, isError: true });
      }
    } catch (err: any) {
      setMsg({ text: `❌ Network error: ${err?.message}`, isError: true });
    } finally {
      setSavingKey(null);
    }
  };

  if (loading && settings.length === 0) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
        <p>Loading allowlisted operational settings...</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: '800', margin: '0 0 4px 0' }}>⚙️ Operational Settings</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>
            Strictly allowlisted operational parameters. Credentials and secrets are intentionally excluded.
          </p>
        </div>
        <button
          onClick={fetchSettings}
          disabled={loading}
          style={{ background: '#1a1a1a', border: '1px solid #333', color: '#ddd', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
        >
          {loading ? 'Refreshing...' : '🔄 Refresh Settings'}
        </button>
      </div>

      {msg && (
        <div style={{ padding: '12px 18px', background: msg.isError ? '#450a0a' : '#052e16', border: `1px solid ${msg.isError ? '#dc2626' : '#16a34a'}`, borderRadius: '8px', color: msg.isError ? '#fca5a5' : '#86efac', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px' }}>&times;</button>
        </div>
      )}

      {error && (
        <div style={{ padding: '16px', background: '#450a0a', border: '1px solid #dc2626', borderRadius: '8px', color: '#fca5a5', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      {/* Settings Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {settings.map((s) => {
          const currentVal = editValues[s.key] !== undefined ? editValues[s.key] : s.value;
          const isDirty = String(currentVal) !== String(s.value);
          const isSaving = savingKey === s.key;

          return (
            <div
              key={s.key}
              style={{
                background: '#141414',
                border: `1px solid ${isDirty ? '#6366f1' : '#262626'}`,
                borderRadius: '12px',
                padding: '20px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '16px',
                transition: 'border 0.15s ease',
              }}
            >
              <div style={{ flex: '1 1 340px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                  <code style={{ fontSize: '14px', fontWeight: '800', color: '#e0e7ff', background: '#1e1b4b', padding: '2px 8px', borderRadius: '6px' }}>
                    {s.key}
                  </code>
                  <span style={{ fontSize: '11px', color: '#888', background: '#222', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase' }}>
                    {s.type}
                  </span>
                  {s.min !== undefined && s.max !== undefined && (
                    <span style={{ fontSize: '11px', color: '#777' }}>
                      (range: {s.min}–{s.max})
                    </span>
                  )}
                </div>
                <p style={{ margin: '0 0 6px 0', fontSize: '13px', color: '#aaa', lineHeight: 1.4 }}>
                  {s.description}
                </p>
                <div style={{ fontSize: '11px', color: '#666' }}>
                  Default: <code>{String(s.defaultValue)}</code>
                  {s.updatedAt && (
                    <span style={{ marginLeft: '12px' }}>
                      Updated: {new Date(s.updatedAt).toLocaleString()} by {s.updatedBy || 'system'}
                    </span>
                  )}
                </div>
              </div>

              {/* Control Input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {s.type === 'boolean' ? (
                  <button
                    onClick={() => handleValueChange(s.key, !currentVal)}
                    style={{
                      background: currentVal ? '#064e3b' : '#262626',
                      color: currentVal ? '#6ee7b7' : '#888',
                      border: `1px solid ${currentVal ? '#059669' : '#404040'}`,
                      borderRadius: '8px',
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                    }}
                  >
                    {currentVal ? '✅ ACTIVE (TRUE)' : '⏸️ PAUSED (FALSE)'}
                  </button>
                ) : s.type === 'number' ? (
                  <input
                    type="number"
                    min={s.min}
                    max={s.max}
                    value={currentVal}
                    onChange={(e) => handleValueChange(s.key, Number(e.target.value))}
                    style={{
                      background: '#0d0d0d',
                      border: '1px solid #333',
                      color: '#fff',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      fontSize: '14px',
                      width: '100px',
                      textAlign: 'center',
                    }}
                  />
                ) : (
                  <input
                    type="text"
                    value={currentVal}
                    onChange={(e) => handleValueChange(s.key, e.target.value)}
                    style={{
                      background: '#0d0d0d',
                      border: '1px solid #333',
                      color: '#fff',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      fontSize: '14px',
                      width: '180px',
                    }}
                  />
                )}

                <button
                  onClick={() => handleSaveClick(s)}
                  disabled={!isDirty || isSaving}
                  style={{
                    background: isDirty ? '#6366f1' : '#1f2937',
                    color: isDirty ? '#fff' : '#6b7280',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '8px 16px',
                    fontWeight: '700',
                    fontSize: '13px',
                    cursor: isDirty && !isSaving ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirmation Modal */}
      {pendingConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '20px' }}>
          <div style={{ background: '#141414', border: '1px solid #333', borderRadius: '16px', width: '460px', maxWidth: '100%', padding: '24px', boxShadow: '0 25px 50px rgba(0,0,0,0.9)' }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', fontWeight: '800', color: '#fff' }}>
              Confirm Setting Change
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#aaa', lineHeight: 1.5 }}>
              Are you sure you want to update operational parameter <strong style={{ color: '#6366f1' }}>{pendingConfirm.setting.key}</strong>?
            </p>

            <div style={{ background: '#0d0d0d', border: '1px solid #242424', borderRadius: '10px', padding: '14px', marginBottom: '20px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: '#777' }}>Previous Value:</span>
                <code style={{ color: '#ef4444' }}>{String(pendingConfirm.setting.value)}</code>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#777' }}>New Value:</span>
                <code style={{ color: '#6ee7b7', fontWeight: '700' }}>{String(pendingConfirm.newValue)}</code>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setPendingConfirm(null)}
                style={{ background: 'transparent', border: '1px solid #444', color: '#bbb', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
              >
                Cancel
              </button>
              <button
                onClick={executeSave}
                style={{ background: '#6366f1', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '700' }}
              >
                Confirm Update
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
