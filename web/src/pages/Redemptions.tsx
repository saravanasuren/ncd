import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useState } from 'react';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';
import { redemptionTypeLabel } from '../labels.js';

interface Redemption {
  id: number; redemption_no: string; type: string; status: string; source: string;
  requested_by_customer: boolean; principal: string; penalty: string; net_payment: string;
  application_no: string; customer_name: string; approval_request_id: number | null;
  redemption_date: string | null;
  /** When the payment instruction was released, and by whom. Set means the
   *  NEFT sheet for this redemption has already gone out once. */
  neft_downloaded_at: string | null; neft_downloaded_by: string | null; neft_download_count: number;
}

type RedTab = 'all' | 'premature' | 'maturity';
const redMatch = (tab: RedTab, t: string) => tab === 'all' ? true : t === tab;

const pill: Record<string, string> = {
  Approved: 'bg-[color:var(--success-bg)] text-success',
  Requested: 'bg-[color:var(--warn-bg)] text-warn',
};

/**
 * Download a NEFT sheet.
 *
 * Fetches rather than linking, because a refusal is now a NORMAL outcome
 * (owner 2026-10-16: one copy per redemption). A bare <a href> would open a
 * tab of raw JSON; here the server's sentence — who downloaded it and when —
 * lands next to the button that was clicked.
 */
function NeftDownload({ href, fileStem, label, title, reissue, onDone }: {
  href: string; fileStem: string; label: string; title: string; reissue?: boolean; onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setErr(''); setBusy(true);
    try {
      const blob = await api.blob(href);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${fileStem}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onDone?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not download the NEFT sheet.');
    } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" onClick={go} disabled={busy} title={title}
        className={reissue
          ? 'text-xs text-warn hover:underline whitespace-nowrap disabled:opacity-50'
          : 'text-xs text-primary hover:underline whitespace-nowrap disabled:opacity-50'}>
        {busy ? 'Preparing…' : label}
      </button>
      {err && <span role="alert" className="text-[11px] text-danger text-right max-w-xs normal-case font-normal">{err}</span>}
    </span>
  );
}

const makeColumns = (canDownload: boolean, isSuperAdmin: boolean, refresh: () => void): Column<Redemption>[] => [
  { key: 'redemption_no', header: 'Ref', tdClassName: 'font-mono text-xs whitespace-nowrap' },
  { key: 'redemption_date', header: 'Date', tdClassName: 'whitespace-nowrap',
    value: (r) => r.redemption_date ?? '',
    render: (r) => r.redemption_date ? <span className="mono text-xs">{String(r.redemption_date).slice(0, 10)}</span> : '—' },
  { key: 'customer_name', header: 'Customer' },
  { key: 'type', header: 'Type', value: (r) => redemptionTypeLabel(r.type), render: (r) => redemptionTypeLabel(r.type) },
  { key: 'net_payment', header: 'Net', align: 'right',
    value: (r) => Number(r.net_payment), render: (r) => <span className="mono">{formatINR(r.net_payment)}</span> },
  { key: 'status', header: 'Status',
    render: (r) => <span className={`text-xs rounded px-1.5 py-0.5 ${pill[r.status] ?? 'bg-bg'}`}>{r.status}</span> },
  ...(canDownload ? [{
    key: 'actions', header: '', sortable: false, filterable: false, align: 'right' as const,
    // One copy per redemption. Once it has gone out the row SAYS so — with the
    // date and the person — rather than silently losing its button, which would
    // read as a permissions glitch. Only Super Admin is offered it again.
    render: (r: Redemption) => {
      // A payment instruction exists only while there is a payment to make.
      // Paid / Rejected / Cancelled / Requested get no button at all — the
      // Status column beside this already says which, so repeating it here
      // would be noise.
      if (r.status !== 'Approved') return <span className="text-xs text-text-muted">—</span>;
      const issued = !!r.neft_downloaded_at;
      if (issued && !isSuperAdmin) {
        return (
          <span className="text-xs text-text-muted whitespace-nowrap"
            title={`Released on ${String(r.neft_downloaded_at).slice(0, 10)}${r.neft_downloaded_by ? ` by ${r.neft_downloaded_by}` : ''}. Ask a Super Admin if the file was lost.`}>
            ✓ issued {String(r.neft_downloaded_at).slice(0, 10)}
          </span>
        );
      }
      return (
        <NeftDownload href={`/api/redemptions/${r.id}/neft.xlsx`} fileStem={`redemption-neft-${r.id}`}
          label={issued ? '↓ re-issue' : '↓ NEFT'} reissue={issued} onDone={refresh}
          title={issued
            ? `Already released on ${String(r.neft_downloaded_at).slice(0, 10)}${r.neft_downloaded_by ? ` by ${r.neft_downloaded_by}` : ''}. Downloading again is recorded against your name.`
            : "Download this customer's NEFT sheet — it can only be taken once"} />
      );
    },
  }] : []),
];

export function RedemptionsPage() {
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<RedTab>('all');
  const { data, isLoading, error } = useQuery({ queryKey: ['redemptions'], queryFn: () => api.get<{ rows: Redemption[] }>('/api/redemptions') });

  const submit = useMutation({
    mutationFn: (id: number) => api.post(`/api/redemptions/${id}/submit-for-approval`),
    onSuccess: () => { setMsg('Sent to the approvals queue (needs two checkers).'); qc.invalidateQueries({ queryKey: ['redemptions'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load redemptions.</div>;
  const requests = data!.rows.filter((r) => r.status === 'Requested' && !r.approval_request_id);
  const rest = data!.rows.filter((r) => !(r.status === 'Requested' && !r.approval_request_id));

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight m-0">Redemptions</h1>
          <p className="text-sm text-text-muted mt-1">Customer/app requests waiting to be processed, plus recent redemptions. To initiate a premature or maturity redemption, open the investment under Applications and use its lifecycle actions.</p>
        </div>
        <div className="flex gap-2">
          <a href="/api/redemptions/report.xlsx" className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ Report</a>
        </div>
      </div>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}

      {requests.length > 0 && (
        <>
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Requests awaiting processing</h2>
          <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border mb-6">
            {requests.map((r) => (
              <div key={r.id} className="p-4 flex items-center gap-4 text-sm">
                <div className="flex-1">
                  <div className="font-semibold">{r.customer_name} <span className="font-mono text-xs text-text-muted">{r.application_no}</span></div>
                  <div className="text-xs text-text-muted">Net {formatINR(r.net_payment)} · penalty {formatINR(r.penalty)} · from {r.source}{r.requested_by_customer ? ' (customer)' : ''}</div>
                </div>
                {can('redemptions:initiate') && (
                  <button disabled={submit.isPending} onClick={() => { setMsg(''); submit.mutate(r.id); }}
                    className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
                    {submit.isPending ? 'Sending…' : 'Send for approval'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">All redemptions</h2>
      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: rest.length },
          { key: 'premature', label: 'Premature', count: rest.filter((r) => r.type === 'premature').length },
          { key: 'maturity', label: 'Maturity', count: rest.filter((r) => r.type === 'maturity').length },
        ] as TabDef<RedTab>[]}
        active={tab}
        onChange={setTab}
      />
      <DataTable
        columns={makeColumns(can('redemptions:initiate'), user?.role === 'super_admin', () => qc.invalidateQueries({ queryKey: ['redemptions'] }))}
        rows={rest.filter((r) => redMatch(tab, r.type))}
        rowKey={(r) => r.id}
        defaultSort={{ key: 'redemption_date', dir: 'desc' }}
        empty="No redemptions in this view."
      />
    </div>
  );
}
