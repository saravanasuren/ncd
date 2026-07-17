import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** Investor portal home — holdings, payouts, documents (docs/06 §5). */
export function PortalHome() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const holdings = useQuery({ queryKey: ['p-holdings'], queryFn: () => api.get<any>('/api/portal/holdings') });
  const payouts = useQuery({ queryKey: ['p-payouts'], queryFn: () => api.get<any>('/api/portal/payouts') });
  const docs = useQuery({ queryKey: ['p-docs'], queryFn: () => api.get<any>('/api/portal/documents') });

  const requestRedemption = useMutation({
    mutationFn: (applicationNo: string) => api.post('/api/portal/redemption-request', { application_no: applicationNo, reason: 'Requested via portal' }),
    onSuccess: () => { setMsg('Redemption requested — our team will process it shortly.'); qc.invalidateQueries({ queryKey: ['p-holdings'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Could not request redemption'),
  });

  return (
    <div className="min-h-screen bg-bg">
      <header className="h-16 bg-[color:var(--sidebar-bg)] flex items-center px-6">
        <img src="/dhanam-logo.png" alt="Dhanam" className="h-10 w-auto bg-white/90 rounded px-2 py-1" />
        <div className="ml-auto flex items-center gap-3 text-white">
          <span className="text-sm">{user?.fullName}</span>
          <button onClick={async () => { await logout(); nav('/portal'); }} className="text-xs border border-white/30 rounded px-2 py-1 hover:bg-white/10">Sign out</button>
        </div>
      </header>
      <main className="w-full mx-auto p-6">
        <h1 className="text-xl font-bold tracking-tight m-0">Your investments</h1>

        <div className="grid grid-cols-2 gap-3 my-5">
          <Tile label="Total invested" value={formatINR(holdings.data?.total_invested ?? 0)} primary />
          <Tile label="Interest received" value={formatINR(payouts.data?.collected_to_date ?? 0)} />
        </div>

        <Card title="Holdings">
          {msg && <div className="px-4 py-2 text-xs text-primary border-b border-border">{msg}</div>}
          {(holdings.data?.holdings ?? []).length === 0 ? (
            <div className="p-5 text-center text-text-muted text-sm">No active investments.</div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
                <th className="px-4 py-2">Application</th><th className="px-4 py-2">Series</th>
                <th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Maturity</th><th className="px-4 py-2"></th></tr></thead>
              <tbody className="divide-y divide-border">
                {(holdings.data?.holdings ?? []).map((h: any) => (
                  <tr key={h.application_no}>
                    <td className="px-4 py-1.5 font-mono text-xs">{h.application_no}</td>
                    <td className="px-4 py-1.5">{h.series_code}</td>
                    <td className="px-4 py-1.5 text-right mono">{formatINR(h.total_amount)}</td>
                    <td className="px-4 py-1.5">{h.maturity_date ?? '—'}</td>
                    <td className="px-4 py-1.5 text-right">
                      {h.status === 'Active' && (
                        <button disabled={requestRedemption.isPending} onClick={() => { setMsg(''); requestRedemption.mutate(h.application_no); }}
                          className="text-xs text-primary hover:underline disabled:opacity-50">Request redemption</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent payouts">
          <Rows head={['Date', 'Type', 'Amount', 'Status']}
            rows={(payouts.data?.rows ?? []).slice(0, 15).map((p: any) => [p.due_date, p.due_type, formatINR(p.net_amount), p.status])} money={[2]} />
        </Card>

        <Card title="Documents">
          <ul className="divide-y divide-border">
            {(docs.data?.documents ?? []).map((d: any) => (
              <li key={d.id} className="px-4 py-2.5 text-sm flex items-center"><span>{d.label}</span><span className="ml-auto text-xs text-text-muted">{d.id}</span></li>
            ))}
          </ul>
        </Card>
      </main>
    </div>
  );
}

function Tile({ label, value, primary }: { label: string; value: string; primary?: boolean }) {
  return (
    <div className={`bg-surface border rounded-lg shadow-card p-4 ${primary ? 'border-primary' : 'border-border'}`}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-lg font-bold mono ${primary ? 'text-primary' : ''}`}>{value}</div>
    </div>
  );
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}
function Rows({ head, rows, money = [] }: { head: string[]; rows: string[][]; money?: number[] }) {
  if (rows.length === 0) return <div className="p-5 text-center text-text-muted text-sm">Nothing yet.</div>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
        {head.map((h, i) => <th key={i} className={`px-4 py-2 ${money.includes(i) ? 'text-right' : ''}`}>{h}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-border">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`px-4 py-1.5 ${money.includes(j) ? 'text-right mono' : ''}`}>{c}</td>)}</tr>)}
      </tbody>
    </table>
  );
}
