import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Sign-in card — styled per the reference site (docs/05 §1). Wires to
 * POST /api/auth/login in Phase 2; for now it navigates to the shell so the
 * scaffold is demoable.
 */
export function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    // Phase 2: real POST /api/auth/login. Phase 0 stub → go to shell.
    nav('/app/dashboard');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[340px] bg-surface border border-border rounded-lg shadow-card p-7 m-4">
        <h1 className="text-lg font-bold text-primary tracking-tight m-0">Dhanam NCD</h1>
        <p className="text-xs text-text-muted mt-1 mb-5">Sign in to the NCD platform.</p>
        <form onSubmit={onSubmit}>
          <label className="block text-xs font-semibold text-text-label mt-3.5 mb-1.5" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="w-full px-2.5 py-2 text-sm border border-border-strong rounded outline-none focus:border-primary focus:ring-2 focus:ring-[color:var(--primary-ring)]"
          />
          <label
            className="block text-xs font-semibold text-text-label mt-3.5 mb-1.5"
            htmlFor="password"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full px-2.5 py-2 text-sm border border-border-strong rounded outline-none focus:border-primary focus:ring-2 focus:ring-[color:var(--primary-ring)]"
          />
          <button
            type="submit"
            className="w-full mt-5 bg-primary hover:bg-primary-hover text-white border-0 rounded py-2.5 text-sm font-semibold cursor-pointer"
          >
            Sign in
          </button>
          {error && (
            <div className="mt-3.5 px-2.5 py-2 bg-[color:var(--danger-bg)] border border-[#f2c2c2] text-danger rounded text-xs">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
