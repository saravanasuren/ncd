import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';

/** Request a password-reset email. Always shows the same confirmation so it
 * never reveals whether an email is registered. */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
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
          <p className="text-xs text-text-muted mt-3">Reset your password.</p>
        </div>
        {sent ? (
          <div className="text-sm text-text-label">
            If an account exists for <span className="font-semibold">{email}</span>, a reset link is on its way. It expires in 60 minutes.
            <div className="mt-4 text-center"><Link to="/login" className="text-xs text-primary hover:underline">Back to sign in</Link></div>
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            <label className="block text-xs font-semibold text-text-label mb-1.5" htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email}
              onChange={(e) => setEmail(e.target.value)} required autoFocus className={input} />
            <button type="submit" disabled={busy || !email}
              className="w-full mt-5 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white border-0 rounded py-2.5 text-sm font-semibold cursor-pointer">
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            {error && <div className="mt-3.5 px-2.5 py-2 bg-[color:var(--danger-bg)] border border-[#f2c2c2] text-danger rounded text-xs">{error}</div>}
            <div className="mt-3.5 text-center"><Link to="/login" className="text-xs text-primary hover:underline">Back to sign in</Link></div>
          </form>
        )}
      </div>
    </div>
  );
}
