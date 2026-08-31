/**
 * The customers holding one series — the drill-down behind a series name on the
 * Allotments page (owner 2026-08-28).
 *
 * One row per PERSON, because that is what a consolidated bond covers: someone
 * holding three investments in a series gets one bond, not three. A row with
 * several investments expands to show them; the name itself is a separate click
 * that opens the customer's profile, so the two never fight over one target.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useConfirm } from '../components/Confirm.js';

interface Investment {
  application_id: number; application_no: string;
  amount: string; status: string; allotment_date: string | null;
}
interface CustomerRow {
  customer_id: number; customer_code: string; full_name: string;
  referred_by: string | null;
  investment_count: number; total_amount: string;
  has_bond: boolean; bond_serial_no: string | null;
  investments: Investment[];
}
interface Payload {
  series: { id: number; code: string; name: string };
  rows: CustomerRow[];
  /** How many of these people have no certificate number yet — the number a
   *  bulk download would permanently mint. */
  without_bond: number;
}

export default function SeriesCustomers() {
  const { seriesId } = useParams();
  const { confirm } = useConfirm();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState('');

  const q = useQuery({
    queryKey: ['series-customers', seriesId],
    queryFn: () => api.get<Payload>(`/api/allotments/series/${seriesId}/customers`),
  });

  const toggle = (id: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (q.isLoading) return <div className="text-text-muted">Loading…</div>;
  if (q.error || !q.data) return <div className="text-danger">Failed to load the series.</div>;
  const { series, rows, without_bond } = q.data;
  const total = rows.reduce((sum, r) => sum + Number(r.total_amount), 0);
  const investments = rows.reduce((sum, r) => sum + r.investment_count, 0);

  const downloadAll = async () => {
    setMsg('');
    // Producing a bond MINTS a permanent certificate number. Say how many before
    // the click, not after — the numbers are never reused, so a mis-click on the
    // wrong series consumes a block of them for good.
    const ok = await confirm({
      title: `Download all ${rows.length} bonds for ${series.code}?`,
      body: without_bond > 0
        ? `${without_bond} of these customers have no certificate number yet. Downloading issues one to each of them permanently — numbers are never reused. The other ${rows.length - without_bond} keep the number they already have.`
        : 'Every customer here already has a certificate number, so nothing new is issued.',
      confirmLabel: 'Download',
    });
    if (!ok) return;
    window.open(`/api/reports/consolidated-bonds/series/${series.id}.pdf`, '_blank');
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Link to="/app/allotments" className="text-xs text-primary hover:underline">← Allotments</Link>
      </div>
      <h1 className="text-xl font-semibold mb-1">{series.name} <span className="text-text-muted font-normal">· {series.code}</span></h1>
      <p className="text-sm text-text-muted mb-4">
        {rows.length} customer{rows.length === 1 ? '' : 's'} · {investments} investment{investments === 1 ? '' : 's'} · {formatINR(total)}
      </p>

      <div className="flex items-center gap-2 mb-3">
        <button onClick={downloadAll} disabled={!rows.length}
          className="text-xs bg-primary hover:bg-primary-hover text-white rounded px-3 py-1.5 disabled:opacity-40">
          ⬇ Download all bonds
        </button>
        {without_bond > 0 && (
          <span className="text-xs text-text-muted">
            {without_bond} of {rows.length} would be issued a new certificate number
          </span>
        )}
      </div>
      {msg && <div className="text-xs text-danger mb-2">{msg}</div>}

      <div className="overflow-x-auto border border-border rounded">
        <table className="text-sm w-full">
          <thead>
            <tr className="text-text-muted text-xs border-b border-border">
              <th className="font-medium text-left py-2 px-3">Customer</th>
              <th className="font-medium text-left py-2 px-3">Referred by</th>
              <th className="font-medium text-right py-2 px-3">Investments</th>
              <th className="font-medium text-right py-2 px-3">Amount</th>
              <th className="font-medium text-left py-2 px-3">Certificate</th>
              <th className="font-medium text-right py-2 px-3">Bond</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const many = r.investment_count > 1;
              const isOpen = open.has(r.customer_id);
              return (
                <tr key={r.customer_id} className="border-b border-border/60 align-top">
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-1.5">
                      {/* The expander is its own target, so clicking the NAME can
                          mean "open the profile" without ambiguity. */}
                      {many ? (
                        <button onClick={() => toggle(r.customer_id)}
                          aria-expanded={isOpen}
                          className="text-xs text-text-muted hover:text-text w-4"
                          title={isOpen ? 'Hide the investments' : `Show the ${r.investment_count} investments`}>
                          {isOpen ? '▾' : '▸'}
                        </button>
                      ) : <span className="w-4 inline-block" />}
                      <Link to={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">
                        {r.full_name}
                      </Link>
                      <span className="text-xs text-text-muted mono">{r.customer_code}</span>
                      {many && <span className="text-xs text-text-muted">· {r.investment_count}</span>}
                    </div>
                    {isOpen && (
                      <div className="mt-1.5 ml-5 flex flex-col gap-1">
                        {r.investments.map((inv) => (
                          <Link key={inv.application_id} to={`/app/applications/${inv.application_id}`}
                            className="text-xs text-text-muted hover:text-primary hover:underline">
                            <span className="mono">{inv.application_no}</span>
                            {' · '}{formatINR(inv.amount)}
                            {' · '}{inv.status}
                            {inv.allotment_date ? ` · allotted ${String(inv.allotment_date).slice(0, 10)}` : ''}
                          </Link>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-3 text-text-muted">{r.referred_by ?? '—'}</td>
                  <td className="py-2 px-3 text-right mono">{r.investment_count}</td>
                  <td className="py-2 px-3 text-right mono">{formatINR(r.total_amount)}</td>
                  <td className="py-2 px-3">
                    {r.bond_serial_no
                      ? <span className="text-xs mono">{r.bond_serial_no}</span>
                      : <span className="text-xs text-text-muted">not issued</span>}
                  </td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">
                    <a href={`/api/reports/consolidated-bond/${r.customer_id}/${series.id}.pdf`}
                      target="_blank" rel="noreferrer"
                      className="text-xs border border-border rounded px-2 py-1 hover:bg-bg"
                      title={r.has_bond ? `Download ${r.bond_serial_no}` : 'Downloading issues a certificate number'}>
                      ⬇ Bond
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="text-sm text-text-muted p-4">No issued investments in this series yet.</div>}
      </div>
    </div>
  );
}
