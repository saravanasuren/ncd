import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

interface Row {
  customer_code: string; full_name: string; pan: string | null; aadhaar: string | null;
  phone: string | null; address: string | null;
  application_no: string; amount: number; status: string; outstanding: number;
  date_money_received: string | null;
}

/** Pick a series → every investment in it, one row each, with the customer's
 *  complete details. The on-screen table is a compact preview; the Excel carries
 *  the full detail (PAN, Aadhaar, address, phone, nominee, bank, demat, terms).
 *  See book.seriesWiseReport. */
export function SeriesWiseReportPage() {
  const seriesQ = useQuery({
    queryKey: ['series'],
    queryFn: () => api.get<{ rows: { id: number; code: string; name?: string }[] }>('/api/series'),
  });
  const [seriesId, setSeriesId] = useState('');
  const rep = useQuery({
    queryKey: ['series-wise', seriesId],
    queryFn: () => api.get<{ series_code: string; series_name: string; rows: Row[]; count: number; grand_total: number; outstanding_total: number }>(`/api/reports/series-wise?series_id=${seriesId}`),
    enabled: !!seriesId,
  });

  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold mb-1">Series-wise report</h1>
      <p className="text-sm text-text-muted mb-4">
        Pick a series to list every investment in it — one row per investment, with the customer’s complete
        details. The Excel carries the full detail: PAN, Aadhaar, address, phone, nominee, bank and demat, plus
        each investment’s amount, rate, tenure, dates, status and outstanding. Includes all investments ever
        booked in the series.
      </p>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select className="px-3 py-2 border border-border-strong rounded text-sm min-w-[16rem] outline-none focus:border-primary"
          value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
          <option value="">Select a series…</option>
          {(seriesQ.data?.rows ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.code}{s.name ? ` — ${s.name}` : ''}</option>
          ))}
        </select>
        {seriesId && rep.data && rep.data.rows.length > 0 && (
          <a href={`/api/reports/series-wise.xlsx?series_id=${seriesId}`}
            className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold no-underline inline-block">↓ Excel (full details)</a>
        )}
      </div>

      {!seriesId && <div className="text-sm text-text-muted">Choose a series to see its investments.</div>}
      {seriesId && rep.isLoading && <div className="text-sm text-text-muted">Loading…</div>}
      {rep.error && <div className="text-sm text-danger">Failed to load this series.</div>}

      {seriesId && rep.data && (
        <>
          <div className="text-xs text-text-muted mb-2">
            {rep.data.count} investment{rep.data.count === 1 ? '' : 's'} · total{' '}
            <span className="font-semibold text-text">{formatINR(rep.data.grand_total)}</span> · outstanding{' '}
            <span className="font-semibold text-text">{formatINR(rep.data.outstanding_total)}</span>
          </div>
          <div className="overflow-x-auto bg-surface border border-border rounded-lg shadow-card">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>#</th><th className={th}>Customer</th><th className={th}>PAN</th><th className={th}>Phone</th>
                  <th className={th}>Application No</th><th className={`${th} text-right`}>Amount</th>
                  <th className={th}>Status</th><th className={`${th} text-right`}>Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {rep.data.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-bg">
                    <td className={`${td} text-text-muted`}>{i + 1}</td>
                    <td className={`${td} font-medium`}>{r.full_name} <span className="text-text-muted font-mono text-xs">{r.customer_code}</span></td>
                    <td className={`${td} font-mono text-xs`}>{r.pan ?? '—'}</td>
                    <td className={`${td} font-mono text-xs`}>{r.phone ?? '—'}</td>
                    <td className={`${td} font-mono text-xs`}>{r.application_no}</td>
                    <td className={`${td} text-right mono`}>{formatINR(r.amount)}</td>
                    <td className={td}>{r.status}</td>
                    <td className={`${td} text-right mono`}>{formatINR(r.outstanding)}</td>
                  </tr>
                ))}
                {rep.data.rows.length === 0 && (
                  <tr><td className={`${td} text-text-muted`} colSpan={8}>No investments in this series.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-text-muted mt-2">The preview shows key columns only — the Excel has the complete PAN / Aadhaar / address / nominee / bank / demat detail. It carries full Aadhaar, so handle the file accordingly.</p>
        </>
      )}
    </div>
  );
}
