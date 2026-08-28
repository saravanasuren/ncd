import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR, payoutRupees } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { useConfirm } from '../components/Confirm.js';

interface LastInterestSummary {
  batch_no: string; payout_date: string;
  customers: number; investments: number; gross: number; tds: number; net: number;
  outstanding: number;
  /** Money in / out since that batch — a record of the period, not a bridge
   *  between the two columns (see BatchComparison's note). */
  movement: {
    since: string;
    added: { customers: number; investments: number; amount: number };
    redeemed: { customers: number; redemptions: number; amount: number };
  };
}

/** Last paid batch vs the batch about to be cut — each metric coloured green
 *  when this batch is higher, red when lower, muted when unchanged. */
function BatchComparison({ last, now }: {
  last: LastInterestSummary;
  now: { customers: number; investments: number; gross: number; tds: number; net: number; outstanding: number };
}) {
  const m = last.movement;
  // Added/Redeemed are only meaningful for Customers and Outstanding. Gross, TDS
  // and Net are interest EARNED, not money in or out — inventing a figure for
  // them would put a different kind of number in the same column (owner
  // 2026-08-27: leave them blank).
  const rows: Array<{ label: string; last: number; now: number; money?: boolean;
                      added?: number; redeemed?: number }> = [
    { label: 'Customers', last: last.customers, now: now.customers,
      added: m?.added.customers, redeemed: m?.redeemed.customers },
    // No Investments row (owner 2026-08-19). Outstanding already says how much
    // principal each batch earned on, which is the number that explains gross;
    // a count of investments moved with it and added nothing.
    // The principal each batch's interest was earned on (owner 2026-08-16).
    // Placed ABOVE Gross because it is the explanation for it: gross can fall
    // while customers rise, and this is the row that says why.
    { label: 'Outstanding', last: last.outstanding, now: now.outstanding, money: true,
      added: m?.added.amount, redeemed: m?.redeemed.amount },
    { label: 'Gross', last: last.gross, now: now.gross, money: true },
    { label: 'TDS', last: last.tds, now: now.tds, money: true },
    { label: 'Net', last: last.net, now: now.net, money: true },
  ];
  const fmt = (v: number, money?: boolean) => (money ? formatINR(v) : String(v));
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="text-[11px] font-semibold text-text-label uppercase tracking-wide mb-2">
        vs last paid batch — <span className="mono">{last.batch_no}</span> · {last.payout_date}
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs w-full max-w-[760px]">
          <thead>
            <tr className="text-text-muted">
              <th className="font-medium py-1 pr-4 text-left"></th>
              <th className="font-medium py-1 pr-4 text-right">Last batch</th>
              <th className="font-medium py-1 pr-4 text-right">Added</th>
              <th className="font-medium py-1 pr-4 text-right">Redeemed</th>
              <th className="font-medium py-1 pr-4 text-right">This batch</th>
              <th className="font-medium py-1 text-right">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = r.now - r.last;
              const color = d > 0 ? 'text-success' : d < 0 ? 'text-danger' : 'text-text-muted';
              const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
              const pct = r.last !== 0 ? Math.round((d / r.last) * 100) : null;
              return (
                <tr key={r.label} className="border-t border-border/60">
                  <td className="py-1 pr-4 text-text-label">{r.label}</td>
                  <td className="py-1 pr-4 text-right mono text-text-muted">{fmt(r.last, r.money)}</td>
                  <td className="py-1 pr-4 text-right mono text-success">
                    {r.added === undefined ? <span className="text-text-muted">—</span>
                      : r.added === 0 ? '0' : `+${fmt(r.added, r.money)}`}
                  </td>
                  <td className="py-1 pr-4 text-right mono text-danger">
                    {r.redeemed === undefined ? <span className="text-text-muted">—</span>
                      : r.redeemed === 0 ? '0' : `−${fmt(r.redeemed, r.money)}`}
                  </td>
                  <td className="py-1 pr-4 text-right mono font-semibold">{fmt(r.now, r.money)}</td>
                  <td className={`py-1 text-right mono ${color}`}>
                    {arrow}{' '}{d === 0 ? '0' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d), r.money)}`}
                    {pct !== null && d !== 0 ? ` (${d > 0 ? '+' : '−'}${Math.abs(pct)}%)` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {m && (
          <div className="text-[11px] text-text-muted mt-1.5 max-w-[760px]">
            Added / Redeemed is the movement since {m.since} — {m.added.investments} investment(s)
            in, {m.redeemed.redemptions} redemption(s) out. They record the period; they do not add
            up from Last batch to This batch, because Last batch shows each line's outstanding as it
            stands today, so redeemed money has already dropped out of it.
          </div>
        )}
      </div>
    </div>
  );
}

/** One investment whose accrual start disagrees with its money-received date. */
type DateHealthRow = {
  application_id: number; application_no: string; customer_name: string;
  issue: 'no_line_date' | 'interest_start_mismatch' | 'line_before_money';
  accrual_start: string | null; expected_start: string | null;
  days_wrong: number; rupees: number; tranches: number;
};

/**
 * The warning shown above the payout controls when an investment's accrual start
 * disagrees with the day its money arrived (owner 2026-08-26, after finding two
 * of these by eye on a sheet: "from the system i should not see anything like
 * what just happened").
 *
 * Deliberately does NOT disable any download — the owner chose warn-don't-block
 * so a false positive can never hold up a whole month's payout. It names each
 * one, both dates and the rupee effect, because "something looks wrong" without
 * the number is not actionable.
 */
function DateHealthBanner({ rows }: { rows: DateHealthRow[] }) {
  if (!rows.length) return null;
  const over = rows.filter((r) => r.rupees > 0).reduce((s, r) => s + r.rupees, 0);
  const under = rows.filter((r) => r.rupees < 0).reduce((s, r) => s + r.rupees, 0);
  return (
    <div className="mb-4 rounded border border-[color:var(--danger-bg)] bg-[color:var(--danger-bg)] p-3">
      <div className="text-sm font-semibold text-danger">
        ⚠️ {rows.length} investment{rows.length > 1 ? 's' : ''} may start earning on the wrong day
      </div>
      <p className="text-xs text-text-muted mt-1 mb-2">
        The interest below is worked out from these dates. Check them before you mark this date paid —
        nothing here stops you downloading or running the payout.
        {over > 0 && <> Over-paying by about <span className="mono">₹{over.toLocaleString('en-IN')}</span>.</>}
        {under < 0 && <> Under-paying by about <span className="mono">₹{Math.abs(under).toLocaleString('en-IN')}</span>.</>}
      </p>
      <table className="w-full text-xs">
        <thead className="text-text-label">
          <tr className="text-left">
            <th className="py-1 pr-3 font-medium">Customer</th>
            <th className="py-1 pr-3 font-medium">Investment</th>
            <th className="py-1 pr-3 font-medium">Earning from</th>
            <th className="py-1 pr-3 font-medium">Money received</th>
            <th className="py-1 pr-3 font-medium text-right">Days</th>
            <th className="py-1 font-medium text-right">Effect</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.application_id + '-' + r.application_no} className="border-t border-border">
              <td className="py-1 pr-3">{r.customer_name}</td>
              <td className="py-1 pr-3">
                <Link to={`/app/applications/${r.application_id}`} className="mono text-primary hover:underline">{r.application_no}</Link>
                {r.tranches > 1 && <span className="ml-1 text-text-muted">({r.tranches} credits)</span>}
              </td>
              <td className="py-1 pr-3 mono">{r.accrual_start ?? '—'}</td>
              <td className="py-1 pr-3 mono">{r.expected_start ?? '—'}</td>
              <td className="py-1 pr-3 text-right mono">{r.days_wrong > 0 ? `${r.days_wrong} early` : r.days_wrong < 0 ? `${Math.abs(r.days_wrong)} late` : '—'}</td>
              <td className="py-1 text-right mono">{r.rupees === 0 ? '—' : `${r.rupees > 0 ? '+' : '−'}₹${Math.abs(r.rupees).toLocaleString('en-IN')}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PayoutsPage() {
  const qc = useQueryClient();
  const { confirm, promptText } = useConfirm();
  const { can } = useAuth();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState('');
  // In-page confirmation for "Mark as paid" — see the panel below.
  const [confirming, setConfirming] = useState(false);

  const preview = useQuery({ queryKey: ['payout-preview', date], queryFn: () => api.get<any>(`/api/payouts/preview?date=${date}`) });
  const lastBatch = useQuery({ queryKey: ['payout-last-interest'], queryFn: () => api.get<{ summary: LastInterestSummary | null }>('/api/payouts/last-interest-summary') });
  const batches = useQuery({ queryKey: ['payout-batches'], queryFn: () => api.get<{ rows: any[] }>('/api/payouts') });
  // Investments whose accrual start disagrees with the day their money arrived.
  // Warning only (owner 2026-08-26) — a false positive must never be able to
  // hold up a month's payout, so nothing here disables a download.
  const dateHealth = useQuery({ queryKey: ['payout-date-health'], queryFn: () => api.get<{ rows: DateHealthRow[] }>('/api/payouts/date-health') });
  const statements = useQuery({ queryKey: ['bank-statements'], queryFn: () => api.get<{ rows: any[] }>('/api/bank-statements') });

  const create = useMutation({ mutationFn: () => api.post('/api/payouts', { payout_date: date }), onSuccess: () => { setConfirming(false); setMsg('Sent to the approvals queue — a checker confirms it, which settles the period and resets interest.'); qc.invalidateQueries({ queryKey: ['payout-batches'] }); qc.invalidateQueries({ queryKey: ['payout-preview', date] }); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });
  const markPaid = useMutation({ mutationFn: (batchId: number) => api.post(`/api/payouts/${batchId}/mark-paid`, {}), onSuccess: () => { setMsg('Sent to the approvals queue — a checker confirms the payment, which settles the period.'); qc.invalidateQueries({ queryKey: ['payout-batches'] }); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => api.post(`/api/payouts/${id}/cancel`, { reason }),
    onSuccess: (r: any) => { setMsg(`Batch cancelled — ${r.rows_released} row(s) released back to the un-batched pool.`); qc.invalidateQueries({ queryKey: ['payout-batches'] }); qc.invalidateQueries({ queryKey: ['payout-preview', date] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  // Queues; the server sends them at a paced rate over the next few minutes.
  // Anyone who already has theirs is skipped, so this doubles as "send to the
  // ones who missed out".
  const notifyWa = useMutation({
    mutationFn: (batchId: number) => api.post<{ queued: number; skipped: number; already_sent: number; total: number }>(`/api/payouts/${batchId}/whatsapp-interest`, {}),
    onSuccess: (r, batchId) => {
      setMsg(r.queued === 0
        ? `Nothing to send — ${r.already_sent} investment(s) already done${r.skipped ? `, ${r.skipped} have no phone number on file` : ''}.`
        : `${r.queued} message(s) queued, one per investment — they go out over the next few minutes. ${r.already_sent} already had theirs${r.skipped ? `, ${r.skipped} have no phone number on file` : ''}. Open "Delivery" to watch.`);
      setWaBatch(batchId);
      qc.invalidateQueries({ queryKey: ['wa-status', batchId] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  // Which batch's delivery report is open, if any.
  const [waBatch, setWaBatch] = useState<number | null>(null);

  const [stmt, setStmt] = useState('');
  const matchStmt = useMutation({
    mutationFn: async () => {
      const lines = stmt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [value_date, amount, utr] = l.split(',').map((x) => x.trim());
        return { value_date: value_date!, amount: Number(amount), utr: utr || undefined };
      });
      const up = await api.post<{ statement_id: number }>('/api/bank-statements', { source_bank: 'Federal', lines });
      return api.post<{ matched: number; unmatched: number }>(`/api/bank-statements/${up.statement_id}/run-match`, {});
    },
    onSuccess: (r) => { setMsg(`Statement matched: ${r.matched} paid, ${r.unmatched} unmatched.`); setStmt(''); qc.invalidateQueries({ queryKey: ['payout-batches'] }); qc.invalidateQueries({ queryKey: ['bank-statements'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  /**
   * Totals stated exactly as the summary sheet and the NEFT file state them —
   * the SAME payoutRupees() helper builds all three, so the screen, the
   * paperwork and the bank can never quote different money.
   *
   * Deliberately computed here rather than in previewDue: that function's
   * `totals` are also written to payout_batches.total_gross/total_net when a
   * batch is claimed, and those stored money records must not move.
   */
  const sheetTotals = ((preview.data?.rows ?? []) as any[]).reduce(
    (a, row) => {
      const m = payoutRupees(row);
      return {
        gross: a.gross + m.gross,
        tds: a.tds + m.tds,
        net: a.net + m.net,
        addition: a.addition + m.addition,
        deduction: a.deduction + m.deduction,
        total: a.total + m.total,
      };
    },
    { gross: 0, tds: 0, net: 0, addition: 0, deduction: 0, total: 0 },
  );

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Interest payouts (NEFT)</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Download the NEFT sheet for any date, as often as you like — it shows each investment's interest accrued since it was last paid, up to that date. Nothing is recorded by downloading. Only when you mark a date as paid does it go to a checker; on approval that period is settled and interest starts fresh.</p>
      <DateHealthBanner rows={dateHealth.data?.rows ?? []} />
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-text-label">Up to date</label>
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setConfirming(false); }} className="px-2.5 py-1.5 text-sm border border-border-strong rounded" />
        <a href={`/api/payouts/sheet.xlsx?date=${date}`}
           className={`text-xs border border-border-strong rounded px-3 py-1.5 no-underline ${!preview.data || preview.data.count === 0 ? 'pointer-events-none opacity-40' : 'hover:bg-bg'}`}>↓ NEFT sheet</a>
        {/* The human companion to the bank file — same pair wealth produced. */}
        <a href={`/api/payouts/preview.summary.xlsx?date=${date}`}
           className={`text-xs border border-border-strong rounded px-3 py-1.5 no-underline ${!preview.data || preview.data.count === 0 ? 'pointer-events-none opacity-40' : 'hover:bg-bg'}`}>↓ Summary sheet</a>
        <a href={`/api/payouts/preview.pdf?date=${date}`}
           className={`text-xs border border-border-strong rounded px-3 py-1.5 no-underline ${!preview.data || preview.data.count === 0 ? 'pointer-events-none opacity-40' : 'hover:bg-bg'}`}>↓ PDF</a>
        {/* Confirmed IN PAGE, not via window.confirm: browsers suppress repeated
            native dialogs ("Don't allow this page to create more dialogs"), and
            a suppressed confirm() returns false instantly — so the click did
            nothing at all, with no request, no error and no message. That is
            exactly how this button "stopped working" (owner 2026-07-28). An
            in-page panel cannot be suppressed, and it names the amount being
            claimed rather than just the date. */}
        <button disabled={!preview.data || preview.data.count === 0 || create.isPending}
          onClick={() => { setMsg(''); setConfirming(true); }}
          className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Mark as paid…</button>
      </div>
      {confirming && preview.data && (
        <div className="bg-surface border border-warn/40 rounded-lg shadow-card p-4 mb-4 text-sm">
          <div className="font-semibold mb-1">Confirm this payout has actually been made</div>
          <p className="text-text-muted text-xs mb-3 max-w-[70ch]">
            You are claiming that <span className="mono font-semibold">{formatINR(sheetTotals.total)}</span> across{' '}
            <span className="font-semibold">{preview.data.count}</span> investment{preview.data.count === 1 ? '' : 's'}, up to{' '}
            <span className="font-semibold">{date}</span>, has left the bank. This goes to a checker; on their approval the
            period is settled and interest starts fresh.
          </p>
          <div className="flex gap-2 items-center">
            <button disabled={create.isPending}
              onClick={() => { setMsg(''); create.mutate(); }}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
              {create.isPending ? 'Sending…' : 'Yes, it has been paid'}
            </button>
            <button onClick={() => setConfirming(false)} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}
      {preview.data && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5 text-sm">
          <span className="font-semibold">{preview.data.customers ?? 0}</span> customer{(preview.data.customers ?? 0) === 1 ? '' : 's'}
          {' '}(<span className="font-semibold">{preview.data.investments ?? preview.data.count}</span> investment{(preview.data.investments ?? preview.data.count) === 1 ? '' : 's'}) with interest accrued to this date · gross <span className="mono font-semibold">{formatINR(sheetTotals.gross)}</span> · TDS <span className="mono">−{formatINR(sheetTotals.tds)}</span> · net <span className="mono font-semibold">{formatINR(sheetTotals.net)}</span>
          {(sheetTotals.addition > 0 || sheetTotals.deduction > 0) && (
            <span className="text-text-muted"> · additions <span className="mono">+{formatINR(sheetTotals.addition)}</span> · deductions <span className="mono">−{formatINR(sheetTotals.deduction)}</span> · payable <span className="mono font-semibold">{formatINR(sheetTotals.total)}</span></span>
          )}
          {/* Say WHY the downloads are greyed out, instead of leaving dead buttons. */}
          {preview.data.count === 0 && (
            <div className="text-xs text-warn mt-1.5">
              Nothing to download for this date: every investment is already settled to it or beyond.
              Interest accrues from the last paid date — pick a later date to see it.
            </div>
          )}
          {/* Last batch vs this one — so the person cutting the batch can sanity-
              check the movement before claiming it (owner 2026-08-10). */}
          {lastBatch.data?.summary && preview.data.count > 0 && (
            <BatchComparison
              last={lastBatch.data.summary}
              // Net here is the PAYABLE (net ± one-time adjustments = sheetTotals.total),
              // not gross−TDS, so a one-time adjustment moves this row (owner 2026-08-28).
              // The Last batch column already reads payable — its stored net_amount is
              // written as net±adjustments — so both sides now measure the same thing.
              now={{ customers: preview.data.customers ?? 0, investments: preview.data.investments ?? preview.data.count,
                     gross: sheetTotals.gross, tds: sheetTotals.tds, net: sheetTotals.total,
                     outstanding: Number(preview.data.totals?.outstanding ?? 0) }}
            />
          )}
        </div>
      )}
      {can('payouts:adjust') && <AdjustmentsCard onMsg={setMsg} />}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Recent batches</h2>
      {(() => {
        const columns: Column<any>[] = [
          { key: 'batch_no', header: 'Batch', tdClassName: 'font-mono text-xs' },
          { key: 'payout_date', header: 'Date', tdClassName: 'text-text-muted' },
          { key: 'total_net', header: 'Net', align: 'right', value: (b) => Number(b.total_net), render: (b) => <span className="mono">{formatINR(b.total_net)}</span> },
          { key: 'status', header: 'Status', render: (b) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{b.status}</span> },
          { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
            render: (b) => (
              <span className="inline-flex gap-2 justify-end">
                <a href={`/api/payouts/${b.id}/download.xlsx`} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ NEFT sheet</a>
                <a href={`/api/payouts/${b.id}/summary.xlsx`} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ Summary sheet</a>
                <a href={`/api/payouts/${b.id}/summary.pdf`} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ PDF</a>
                {b.status !== 'Paid' && b.status !== 'Cancelled' && (
                  <button onClick={async () => {
                    const reason = await promptText({
                      title: `Cancel batch ${b.batch_no}?`,
                      body: 'Its rows go back to the un-batched pool and can be re-batched. No money moves.',
                      label: 'Reason', confirmLabel: 'Cancel batch', cancelLabel: 'Keep batch', danger: true,
                    });
                    if (reason) cancel.mutate({ id: b.id, reason });
                  }} className="text-xs border border-border text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">Cancel batch</button>
                )}
                {b.status === 'PendingChecker' && <span className="text-xs text-text-muted italic">awaiting checker</span>}
                {b.status === 'Paid' && (
                  <>
                    <button onClick={() => { setMsg(''); setWaBatch(waBatch === b.id ? null : b.id); }}
                      className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">✉ Delivery</button>
                    <button disabled={notifyWa.isPending}
                      onClick={async () => {
                        if (await confirm({
                          title: `Send interest-credit WhatsApp for ${b.batch_no}?`,
                          body: 'One message per investment, to everyone who has not already had theirs. A customer with several debentures gets one message each. Nobody is messaged twice.',
                          confirmLabel: 'Send messages',
                        })) { setMsg(''); notifyWa.mutate(b.id); }
                      }}
                      className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40">📲 Notify customers</button>
                  </>
                )}
              </span>
            ) },
        ];
        return <DataTable columns={columns} rows={batches.data?.rows ?? []} rowKey={(b) => b.id} defaultSort={{ key: 'batch_no', dir: 'desc' }} empty="No batches yet." />;
      })()}

      {waBatch != null && <WhatsappDelivery batchId={waBatch} onClose={() => setWaBatch(null)} />}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mt-6 mb-2">Reconcile a bank statement</h2>
      <div className="bg-surface border border-border rounded-lg shadow-card p-4">
        <p className="text-xs text-text-muted mb-2">Paste statement lines, one per line: <span className="mono">value_date, amount, utr</span> (UTR optional). Matching lines mark payouts Paid.</p>
        <textarea className="w-full h-24 px-2.5 py-2 text-sm border border-border-strong rounded font-mono outline-none focus:border-primary"
          placeholder={'2026-08-29, 4931.51, FDRLUTR001\n2026-08-29, 5095.89, FDRLUTR002'} value={stmt} onChange={(e) => setStmt(e.target.value)} />
        <button disabled={!stmt.trim() || matchStmt.isPending} onClick={() => { setMsg(''); matchStmt.mutate(); }}
          className="mt-2 text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Upload & match</button>
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mt-6 mb-2">Uploaded statements</h2>
      {(() => {
        const cols: Column<any>[] = [
          { key: 'id', header: '#', tdClassName: 'font-mono text-xs' },
          { key: 'source_bank', header: 'Bank' },
          { key: 'line_count', header: 'Lines', align: 'right' },
          { key: 'matched_count', header: 'Matched', align: 'right',
            render: (s) => <span className={Number(s.matched_count) === Number(s.line_count) ? 'text-success' : ''}>{s.matched_count}</span> },
          { key: 'created_at', header: 'Uploaded', render: (s) => <span className="mono text-xs">{String(s.created_at).slice(0, 16).replace('T', ' ')}</span> },
        ];
        return <DataTable columns={cols} rows={statements.data?.rows ?? []} rowKey={(s) => s.id} defaultSort={{ key: 'id', dir: 'desc' }} empty="No statements uploaded yet." />;
      })()}
    </div>
  );
}

/**
 * One-time payout adjustments (owner 2026-07-23): pick a customer, pick one of
 * their investments, add or deduct a rupee amount from its NEXT interest payout,
 * with a mandatory narration. Goes to Admin/CXO for approval; once the next
 * batch settles it, it's consumed and never applies again.
 */
function AdjustmentsCard({ onMsg }: { onMsg: (m: string) => void }) {
  const { confirm } = useConfirm();
  const qc = useQueryClient();
  const inp = 'px-2.5 py-1.5 text-xs border border-border-strong rounded outline-none focus:border-primary';
  const [custQ, setCustQ] = useState('');
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(null);
  const [appId, setAppId] = useState('');
  const [kind, setKind] = useState<'Addition' | 'Deduction'>('Addition');
  const [amount, setAmount] = useState('');
  const [narration, setNarration] = useState('');

  const search = useQuery({
    queryKey: ['adj-cust-search', custQ],
    queryFn: () => api.get<{ customers: { id: number; full_name: string; customer_code: string }[] }>(`/api/dashboard/search?q=${encodeURIComponent(custQ)}`),
    enabled: custQ.trim().length >= 2 && !customer,
  });
  const detail = useQuery({
    queryKey: ['adj-cust-apps', customer?.id],
    queryFn: () => api.get<any>(`/api/customers/${customer!.id}`),
    enabled: !!customer,
  });
  const list = useQuery({ queryKey: ['payout-adjustments'], queryFn: () => api.get<{ rows: any[] }>('/api/payouts/adjustments') });

  const reset = () => { setAppId(''); setKind('Addition'); setAmount(''); setNarration(''); };
  const submit = useMutation({
    mutationFn: () => api.post('/api/payouts/adjustments', {
      application_id: Number(appId), kind, amount: Number(amount), narration: narration.trim(),
    }),
    onSuccess: (r: any) => {
      onMsg(`${kind} of ${formatINR(Number(amount))} sent for approval (${r.request_no}) — an Admin/CXO confirms it, then it rides on the next interest payout.`);
      reset(); qc.invalidateQueries({ queryKey: ['payout-adjustments'] });
    },
    onError: (e) => onMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  const cancelAdj = useMutation({
    mutationFn: (id: number) => api.post(`/api/payouts/adjustments/${id}/cancel`, {}),
    onSuccess: () => { onMsg('Adjustment cancelled.'); qc.invalidateQueries({ queryKey: ['payout-adjustments'] }); qc.invalidateQueries({ queryKey: ['payout-preview'] }); },
    onError: (e) => onMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  // Adjustments ride on interest: a live investment, OR a REDEEMED one whose
  // final broken-period interest is still to be paid this cut-off (owner
  // 2026-08-27) — it drops off again once that slice is settled.
  const liveApps = ((detail.data?.applications ?? []) as any[]).filter((a) => Number(a.outstanding ?? 0) > 0 || a.has_pending_payout);
  const statusChip: Record<string, string> = {
    PendingApproval: 'text-warn', Approved: 'text-success', Consumed: 'text-text-muted',
  };

  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2.5">
        One-time adjustments <span className="normal-case font-normal text-text-muted">— add to or deduct from an investment's next interest payout · Admin/CXO approves</span>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        {customer ? (
          <span className="text-xs bg-bg rounded px-2 py-1.5">
            {customer.name}
            <button className="text-text-muted hover:text-danger ml-1.5" onClick={() => { setCustomer(null); setCustQ(''); reset(); }}>×</button>
          </span>
        ) : (
          <span className="relative">
            <input className={`${inp} w-64`} placeholder="Search customer (name / phone / PAN)…" value={custQ} onChange={(e) => setCustQ(e.target.value)} />
            {(search.data?.customers ?? []).length > 0 && (
              <span className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded shadow-card z-10 block max-h-48 overflow-auto">
                {search.data!.customers.map((c) => (
                  <button key={c.id} className="block w-full text-left px-2.5 py-1.5 text-xs hover:bg-bg"
                    onClick={() => { setCustomer({ id: c.id, name: c.full_name }); setCustQ(''); }}>
                    {c.full_name} <span className="text-text-muted">({c.customer_code})</span>
                  </button>
                ))}
              </span>
            )}
          </span>
        )}

        {customer && (
          <>
            <select className={inp} value={appId} onChange={(e) => setAppId(e.target.value)}>
              <option value="">Investment…</option>
              {liveApps.map((a: any) => (
                <option key={a.id} value={a.id}>{a.application_no} · {a.series_code ?? ''} · {formatINR(Number(a.amount ?? 0))}{Number(a.outstanding ?? 0) === 0 ? ' · redeemed (final interest)' : ''}</option>
              ))}
            </select>
            <select className={inp} value={kind} onChange={(e) => setKind(e.target.value as 'Addition' | 'Deduction')}>
              <option value="Addition">Addition (+)</option>
              <option value="Deduction">Deduction (−)</option>
            </select>
            <input className={`${inp} w-32`} type="number" min="0.01" step="0.01" placeholder="Amount ₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <input className={`${inp} w-72`} placeholder="Narration — reason for this adjustment (required)" value={narration} onChange={(e) => setNarration(e.target.value)} />
            <button
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover"
              disabled={!appId || !(Number(amount) > 0) || narration.trim().length < 3 || submit.isPending}
              onClick={() => submit.mutate()}>
              Send for approval
            </button>
          </>
        )}
      </div>

      {(list.data?.rows ?? []).length > 0 && (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-text-label uppercase tracking-wide border-b border-border">
                <th className="py-1.5 pr-3">Customer</th>
                <th className="py-1.5 pr-3">Investment</th>
                <th className="py-1.5 pr-3">Kind</th>
                <th className="py-1.5 pr-3 text-right">Amount</th>
                <th className="py-1.5 pr-3">Narration</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {list.data!.rows.map((r: any) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-3">{r.customer_name} <span className="text-text-muted">({r.customer_code})</span></td>
                  <td className="py-1.5 pr-3 font-mono">{r.application_no}</td>
                  <td className="py-1.5 pr-3">{r.kind === 'Addition' ? '+' : '−'} {r.kind}</td>
                  <td className="py-1.5 pr-3 text-right mono">{formatINR(Number(r.amount))}</td>
                  <td className="py-1.5 pr-3 max-w-[280px] truncate" title={r.narration}>{r.narration}</td>
                  <td className={`py-1.5 pr-3 ${statusChip[r.status] ?? ''}`}>{r.status === 'PendingApproval' ? 'Awaiting Admin/CXO' : r.status}</td>
                  <td className="py-1.5 pr-3 text-right">
                    {(r.status === 'PendingApproval' || r.status === 'Approved') && (
                      <button className="text-danger hover:underline" onClick={async () => { if (await confirm({ title: `Cancel this ${r.kind.toLowerCase()}?`, body: `${formatINR(Number(r.amount))} on ${r.application_no}. It will no longer apply to the next payout.`, confirmLabel: 'Cancel it', danger: true })) cancelAdj.mutate(r.id); }}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Who has actually been told about a settled batch — the question the platform
 * could not answer on 28 Jul 2026, when 275 of 384 customers silently got
 * nothing and the only clue was the owner's hunch.
 *
 * Rows are the interest payments the batch MADE — one per investment, since
 * 2026-07-29 — not the messages sent, so an investment nobody could message
 * shows as a gap instead of disappearing from both sides of the count.
 */
function WhatsappDelivery({ batchId, onClose }: { batchId: number; onClose: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ['wa-status', batchId],
    queryFn: () => api.get<any>(`/api/payouts/${batchId}/whatsapp-status`),
    // Sends trickle out over minutes, so the panel keeps itself current while
    // anything is still in flight, then stops polling.
    refetchInterval: (query) => (((query.state.data as any)?.sending ?? 0) > 0 ? 10_000 : false),
  });
  const d = q.data;
  const chip = (n: number, label: string, cls: string) => (
    <span className={`text-xs rounded px-2 py-1 ${cls}`}><span className="font-semibold mono">{n}</span> {label}</span>
  );
  const stateClass: Record<string, string> = {
    Sent: 'text-ok', Sending: 'text-primary', Failed: 'text-danger',
    NotSent: 'text-text-muted', NoPhone: 'text-warn',
  };
  const stateLabel: Record<string, string> = {
    Sent: 'delivered', Sending: 'on its way', Failed: 'failed',
    NotSent: 'not sent', NoPhone: 'no phone number',
  };
  const rows: any[] = d?.rows ?? [];
  const missed = rows.filter((r) => r.state !== 'Sent');
  const shown = showAll ? rows : missed;

  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-text-label uppercase tracking-wide">
          WhatsApp delivery{d ? ` · ${d.batch_no}` : ''}
        </span>
        <button onClick={onClose} className="ml-auto text-xs text-text-muted hover:text-text">close</button>
      </div>

      {q.isLoading && <div className="text-sm text-text-muted">Loading…</div>}
      {q.error && <div className="text-sm text-danger">Could not load the delivery report.</div>}

      {d && (
        <>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            {chip(d.sent, 'delivered', 'bg-[color:var(--ok-bg)] text-ok')}
            {d.sending > 0 && chip(d.sending, 'on the way', 'bg-bg text-primary')}
            {d.failed > 0 && chip(d.failed, 'failed', 'bg-[color:var(--danger-bg)] text-danger')}
            {d.not_sent > 0 && chip(d.not_sent, 'never sent', 'bg-bg text-text-muted')}
            {d.no_phone > 0 && chip(d.no_phone, 'no phone number', 'bg-[color:var(--warn-bg)] text-warn')}
            <span className="text-xs text-text-muted">
              of {d.total} interest payment{d.total === 1 ? '' : 's'} to {d.customers} customer{d.customers === 1 ? '' : 's'}
            </span>
          </div>

          {d.sending > 0 && (
            <p className="text-xs text-text-muted mb-2">
              Still going out. Messages are paced so the provider does not start refusing them, so this takes a few minutes — this panel refreshes itself.
            </p>
          )}
          {d.no_phone > 0 && (
            <p className="text-xs text-warn mb-2">
              {d.no_phone} payment{d.no_phone === 1 ? '' : 's'} cannot be messaged — no phone number on the customer's file.
            </p>
          )}

          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-text-muted">
              {showAll ? `All ${rows.length}` : `${missed.length} that have not been told`}
            </span>
            <button onClick={() => setShowAll(!showAll)} className="text-xs text-primary hover:underline">
              {showAll ? 'show only the gaps' : 'show everyone'}
            </button>
          </div>

          <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-border rounded">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-bg">
                <tr className="text-left text-xs text-text-label">
                  <th className="py-1.5 px-3">Customer</th>
                  <th className="py-1.5 px-3">Investment</th>
                  <th className="py-1.5 px-3">Phone</th>
                  <th className="py-1.5 px-3 text-right">Interest</th>
                  <th className="py-1.5 px-3">Status</th>
                  <th className="py-1.5 px-3">Detail</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.application_id} className="border-t border-border">
                    <td className="py-1.5 px-3">{r.full_name}</td>
                    <td className="py-1.5 px-3 mono text-xs">{r.application_no}</td>
                    <td className="py-1.5 px-3 mono text-xs">{r.phone ?? '—'}</td>
                    <td className="py-1.5 px-3 text-right mono">{formatINR(r.amount)}</td>
                    <td className={`py-1.5 px-3 text-xs ${stateClass[r.state] ?? ''}`}>{stateLabel[r.state] ?? r.state}</td>
                    <td className="py-1.5 px-3 text-xs text-text-muted max-w-[340px] truncate" title={r.error ?? ''}>
                      {r.state === 'Sent'
                        ? (r.clubbed ? 'covered by the older combined message' : (r.sent_at ? String(r.sent_at).slice(0, 16).replace('T', ' ') : ''))
                        : r.state === 'NoPhone' ? 'add a phone number to the customer'
                        : (r.error ?? '')}
                    </td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr><td colSpan={6} className="py-6 text-center text-text-muted">
                    {showAll ? 'Nothing was paid in this batch.' : 'Every investment in this batch has had its message.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
