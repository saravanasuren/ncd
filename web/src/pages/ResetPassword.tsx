import { useState, type FormEvent } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';

/** Set a new password from a reset-link token. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => nav('/login'), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally { setBusy(false); }
  }

  const input = 'w-full px-2.5 py-2 text-sm border border-border-strong rounded outline-none focus:border-primary focus:ring-2 focus:ring-[color:var(--primary-ring)]';

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[340px] bg-surface border border-border rounded-lg shadow-card p-7 m-4">
        <div className="flex flex-col items-center text-center mb-5">
          <img src="/dhanam-logo.png" alt="Dhanam Investment and Finance" className="w-40 h-auto" />
          <p className="text-xs text-text-muted mt-3">Choose a new password.</p>
        </div>
        {!token ? (
          <div className="text-sm text-danger">This reset link is missing its token. <Link to="/forgot-password" className="text-primary hover:underline">Request a new one</Link>.</div>
        ) : done ? (
          <div className="text-sm text-success">Password updated. Redirecting to sign in…</div>
        ) : (
          <form onSubmit={onSubmit}>
            <label className="block text-xs font-semibold text-text-label mb-1.5" htmlFor="pw">New password</label>
            <input id="pw" type="password" autoComplete="new-password" value={password}
              onChange={(e) => setPassword(e.target.value)} required autoFocus className={input} />
            <label className="block text-xs font-semibold text-text-label mt-3.5 mb-1.5" htmlFor="pw2">Confirm password</label>
            <input id="pw2" type="password" autoComplete="new-password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} required className={input} />
            <button type="submit" disabled={busy}
              className="w-full mt-5 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white border-0 rounded py-2.5 text-sm font-semibold cursor-pointer">
              {busy ? 'Saving…' : 'Set new password'}
            </button>
            {error && <div className="mt-3.5 px-2.5 py-2 bg-[color:var(--danger-bg)] border border-[#f2c2c2] text-danger rounded text-xs">{error}</div>}
          </form>
        )}
      </div>
    </div>
  );
}
