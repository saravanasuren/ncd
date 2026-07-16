import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';

/** Customer portal OTP login (docs/06 §5). */
export function PortalLogin() {
  const nav = useNavigate();
  const [step, setStep] = useState<'id' | 'otp'>('id');
  const [identifier, setIdentifier] = useState('');
  const [otp, setOtp] = useState('');
  const [dest, setDest] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const input = 'w-full px-2.5 py-2 text-sm border border-border-strong rounded outline-none focus:border-primary focus:ring-2 focus:ring-[color:var(--primary-ring)]';

  async function request() {
    setErr(''); setBusy(true);
    try { const r = await api.post<{ destination: string }>('/api/portal/otp/request', { identifier }); setDest(r.destination); setStep('otp'); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  async function verify() {
    setErr(''); setBusy(true);
    try { await api.post('/api/portal/otp/verify', { identifier, otp }); nav('/portal/home'); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Invalid code'); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[340px] bg-surface border border-border border-t-4 border-t-primary rounded-lg shadow-card p-7 m-4">
        <div className="flex flex-col items-center text-center mb-5">
          <img src="/dhanam-logo.png" alt="Dhanam" className="w-40 h-auto" />
          <p className="text-xs text-text-muted mt-3">Investor portal</p>
        </div>
        {step === 'id' ? (
          <>
            <label className="block text-xs font-semibold text-text-label mb-1.5">Phone, email or customer code</label>
            <input className={input} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus />
            <button disabled={identifier.length < 3 || busy} onClick={request}
              className="w-full mt-5 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white rounded py-2.5 text-sm font-semibold">
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted mb-3">We sent a code to {dest}.</p>
            <label className="block text-xs font-semibold text-text-label mb-1.5">One-time code</label>
            <input className={input} value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoFocus />
            <button disabled={otp.length < 4 || busy} onClick={verify}
              className="w-full mt-5 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white rounded py-2.5 text-sm font-semibold">
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button onClick={() => setStep('id')} className="w-full mt-2 text-xs text-text-muted hover:text-primary">← Use a different ID</button>
          </>
        )}
        {err && <div className="mt-3.5 px-2.5 py-2 bg-[color:var(--danger-bg)] border border-[#f2c2c2] text-danger rounded text-xs">{err}</div>}
      </div>
    </div>
  );
}
