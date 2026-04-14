// ============================================================
// SONAR v2.0 — Login Page
// ============================================================
// Minimal auth entry point using Supabase email magic link.
// Dashboard is currently public — login is used for admin access.
// ============================================================

'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail]     = useState('');
  const [status, setStatus]   = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
  const [errMsg, setErrMsg]   = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('loading');
    setErrMsg('');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus('error');
      setErrMsg(error.message);
    } else {
      setStatus('sent');
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4"
      style={{ background: '#0a0a0f', color: '#e8e8ef' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border p-8 flex flex-col gap-6"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        {/* Logo */}
        <div className="text-center">
          <span
            className="text-xl font-bold"
            style={{ fontFamily: 'var(--font-heading)', color: '#00e599' }}
          >
            SONAR
          </span>
          <p className="text-sm mt-1" style={{ color: '#6b6b80' }}>
            Admin access
          </p>
        </div>

        {status === 'sent' ? (
          <div className="text-center flex flex-col gap-3">
            <div className="text-3xl">✉</div>
            <p className="text-sm font-semibold" style={{ color: '#00e599' }}>
              Check your email
            </p>
            <p className="text-xs" style={{ color: '#6b6b80' }}>
              We sent a magic link to <strong>{email}</strong>.
              Click it to sign in.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="email"
                className="text-xs uppercase tracking-widest"
                style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1"
                style={{
                  background: '#0a0a0f',
                  border: '1px solid #1e1e2e',
                  color: '#e8e8ef',
                  fontFamily: 'var(--font-mono)',
                }}
              />
            </div>

            {status === 'error' && (
              <p className="text-xs rounded-lg px-3 py-2" style={{ background: '#ff475720', color: '#ff4757' }}>
                {errMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: '#00e599', color: '#0a0a0f' }}
            >
              {status === 'loading' ? 'Sending…' : 'Send Magic Link'}
            </button>
          </form>
        )}

        <p className="text-center text-xs" style={{ color: '#4b4b60' }}>
          Dashboard is public —{' '}
          <a href="/dashboard" style={{ color: '#6b6b80' }}>go back</a>
        </p>
      </div>
    </main>
  );
}
