import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.js';
import { ApiError } from '../api/client.js';

/** Sign-in card — styled per the reference site (docs/05 §1). */
export function LoginPage() {
  const nav = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      nav('/app/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  const input =
    'w-full px-2.5 py-2 text-sm border border-border-strong rounded outline-none focus:border-primary focus:ring-2 focus:ring-[color:var(--primary-ring)]';

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[340px] bg-surface border border-border rounded-lg shadow-card p-7 m-4">
        <div className="flex flex-col items-center text-center mb-5">
          <img src="/dhanam-logo.png" alt="Dhanam Investment and Finance" className="w-40 h-auto" />
          <p className="text-xs text-text-muted mt-3">Sign in to the NCD platform.</p>
        </div>
        <form onSubmit={onSubmit}>
          <label className="block text-xs font-semibold text-text-label mt-3.5 mb-1.5" htmlFor="email">
            Email or mobile
          </label>
          <input id="email" type="text" autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)} required autoFocus className={input} />
          <label className="block text-xs font-semibold text-text-label mt-3.5 mb-1.5" htmlFor="password">
            Password
          </label>
          <input id="password" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required className={input} />
          <button type="submit" disabled={busy}
            className="w-full mt-5 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white border-0 rounded py-2.5 text-sm font-semibold cursor-pointer">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && (
            <div className="mt-3.5 px-2.5 py-2 bg-[color:var(--danger-bg)] border border-[#f2c2c2] text-danger rounded text-xs">
              {error}
            </div>
          )}
          <div className="mt-3.5 text-center flex items-center justify-center gap-3">
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">Forgot password?</Link>
            <span className="text-border">·</span>
            <Link to="/signup" className="text-xs text-primary hover:underline">Sign up</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
