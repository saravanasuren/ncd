import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';

/** Public self-service sign-up — Staff or Agent. Creates an unverified,
 * own-scope login; the account works immediately but shows as pending
 * verification until an Admin/CXO reviews it. */
export function SignupPage() {
  const [type, setType] = useState<'staff' | 'agent' | null>(null);
  const [f, setF] = useState({ full_name: '', employee_id: '', mobile: '', branch_id: '', password: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ mobile: string; agent_code?: string } | null>(null);

  const branches = useQuery({
    queryKey: ['signup-branches'],
    queryFn: () => api.get<{ rows: { id: number; code: string; name: string }[] }>('/api/auth/branches'),
    enabled: type === 'staff',
  });

  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));
  const input = 'w-full px-2.5 py-2 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const label = 'block text-xs font-semibold text-text-label mt-3 mb-1.5';

  const pwOk = f.password.length >= 8 && /[A-Za-z]/.test(f.password) && /[0-9]/.test(f.password);
  const mobileOk = f.mobile.replace(/\D/g, '').length === 10;

  async function submit() {
    setErr('');
    if (!mobileOk) { setErr('Enter a valid 10-digit mobile number.'); return; }
    if (!pwOk) { setErr('Password must be at least 8 characters and include a letter and a number.'); return; }
    if (f.password !== f.confirm) { setErr('Passwords do not match.'); return; }
    if (type === 'staff' && !f.full_name.trim()) { setErr('Name is required.'); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { type, mobile: f.mobile.replace(/\D/g, ''), password: f.password };
      if (type === 'staff') {
        body.full_name = f.full_name.trim();
        if (f.employee_id.trim()) body.employee_id = f.employee_id.trim();
        if (f.branch_id) body.branch_id = Number(f.branch_id);
      }
      const r = await api.post<{ mobile: string; agent_code?: string }>('/api/auth/signup', body);
      setDone({ mobile: r.mobile, agent_code: r.agent_code });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Sign up failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[380px] bg-surface border border-border rounded-lg shadow-card p-7 m-4">
        <div className="flex flex-col items-center text-center mb-4">
          <img src="/dhanam-logo.png" alt="Dhanam Investment and Finance" className="w-36 h-auto" />
          <p className="text-xs text-text-muted mt-3">Create your account.</p>
        </div>

        {done ? (
          <div className="text-center">
            <div className="text-success text-sm font-semibold mb-2">Account created ✓</div>
            <p className="text-xs text-text-muted">
              You can sign in now with your mobile <span className="font-mono">{done.mobile}</span> and the password you set.
              {done.agent_code && <> Your agent number is <span className="font-mono">{done.agent_code}</span>.</>}
            </p>
            <p className="text-xs text-text-muted mt-2">Your account is <strong>pending verification</strong> by an administrator.</p>
            <Link to="/login" className="inline-block mt-4 text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 no-underline">Go to sign in</Link>
          </div>
        ) : !type ? (
          <div className="space-y-2.5">
            <p className="text-xs text-text-muted text-center mb-1">I am signing up as…</p>
            <button onClick={() => setType('staff')} className="w-full border border-border-strong hover:border-primary rounded py-3 text-sm font-semibold">Staff</button>
            <button onClick={() => setType('agent')} className="w-full border border-border-strong hover:border-primary rounded py-3 text-sm font-semibold">Agent</button>
            <div className="text-center pt-2"><Link to="/login" className="text-xs text-primary hover:underline">Back to sign in</Link></div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="text-xs text-text-muted mb-1">Signing up as <strong className="capitalize text-text">{type}</strong> · <button type="button" onClick={() => setType(null)} className="text-primary hover:underline">change</button></div>

            {type === 'staff' && (
              <>
                <label className={label}>Employee ID</label>
                <input className={input} value={f.employee_id} onChange={(e) => set({ employee_id: e.target.value })} />
                <label className={label}>Name *</label>
                <input className={input} value={f.full_name} onChange={(e) => set({ full_name: e.target.value })} autoFocus />
                <label className={label}>Branch</label>
                <select className={input} value={f.branch_id} onChange={(e) => set({ branch_id: e.target.value })}>
                  <option value="">Select branch…</option>
                  {(branches.data?.rows ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </>
            )}

            <label className={label}>Official mobile number *</label>
            <input className={input} inputMode="numeric" maxLength={10} placeholder="10-digit mobile"
              value={f.mobile} onChange={(e) => set({ mobile: e.target.value.replace(/\D/g, '') })} autoFocus={type === 'agent'} />

            <label className={label}>Password *</label>
            <input type="password" className={input} value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
            <div className={`text-[11px] mt-1 ${f.password ? (pwOk ? 'text-success' : 'text-text-muted') : 'text-text-muted'}`}>
              At least 8 characters, with a letter and a number.
            </div>
            <label className={label}>Confirm password *</label>
            <input type="password" className={input} value={f.confirm} onChange={(e) => set({ confirm: e.target.value })} autoComplete="new-password" />

            {err && <div className="mt-3 px-2.5 py-2 bg-[color:var(--danger-bg)] border border-[#f2c2c2] text-danger rounded text-xs">{err}</div>}

            <button type="submit" disabled={busy}
              className="w-full mt-4 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white rounded py-2.5 text-sm font-semibold">
              {busy ? 'Creating…' : 'Sign up'}
            </button>
            <div className="text-center mt-3"><Link to="/login" className="text-xs text-primary hover:underline">Back to sign in</Link></div>
          </form>
        )}
      </div>
    </div>
  );
}
