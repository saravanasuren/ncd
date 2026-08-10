import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

interface Holder {
  full_name: string;
  pan: string | null;
  total_invested: number;
  investments: number;
  depository: string | null;   // NSDL | CDSL
  dp_id: string | null;
  client_id: string | null;
  is_dematerialised: boolean | null;
}

/** Select a series → its unique holders with PAN, total invested and demat
 *  details (NSDL/CDSL, DP ID, Client ID). Current holders only; "total invested"
 *  is the subscribed principal. See book.seriesHoldersReport. */
export function SeriesDematReportPage() {
  const seriesQ = useQuery({
    queryKey: ['series'],
    queryFn: () => api.get<{ rows: { id: number; code: string; name?: string }[] }>('/api/series'),
  });
  const [seriesId, setSeriesId] = useState('');
  const rep = useQuery({
    queryKey: ['series-holders', seriesId],
    queryFn: () => api.get<{ series_code: string; series_name: string; rows: Holder[]; count: number; grand_total: number; investments: number }>(`/api/reports/series-holders?series_id=${seriesId}`),
    enabled: !!seriesId,
  });

  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold mb-1">Series holders — demat report</h1>
      <p className="text-sm text-text-muted mb-4">
        Pick a series to list its unique holders with PAN, total amount invested, and demat details (NSDL/CDSL, DP ID, Client ID).
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
          <a href={`/api/reports/series-holders.xlsx?series_id=${seriesId}`}
            className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold no-underline inline-block">↓ Excel</a>
        )}
      </div>

      {!seriesId && <div className="text-sm text-text-muted">Choose a series to see its holders.</div>}
      {seriesId && rep.isLoading && <div className="text-sm text-text-muted">Loading…</div>}
      {rep.error && <div className="text-sm text-danger">Failed to load this series.</div>}

      {seriesId && rep.data && (
        <>
          <div className="text-xs text-text-muted mb-2">
            {rep.data.count} holder{rep.data.count === 1 ? '' : 's'} · {rep.data.investments} investments · total invested{' '}
            <span className="font-semibold text-text">{formatINR(rep.data.grand_total)}</span>
          </div>
          <div className="overflow-x-auto bg-surface border border-border rounded-lg shadow-card">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>#</th><th className={th}>Name</th><th className={th}>PAN</th>
                  <th className={`${th} text-right`}>Total Invested</th><th className={`${th} text-right`}>Investments</th>
                  <th className={th}>Depository</th><th className={th}>DP ID</th><th className={th}>Client ID</th>
                </tr>
              </thead>
              <tbody>
                {rep.data.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-bg">
                    <td className={`${td} text-text-muted`}>{i + 1}</td>
                    <td className={`${td} font-medium`}>{r.full_name}</td>
                    <td className={`${td} font-mono text-xs`}>{r.pan ?? '—'}</td>
                    <td className={`${td} text-right mono`}>{formatINR(r.total_invested)}</td>
                    <td className={`${td} text-right`}>{r.investments}</td>
                    <td className={td}>{r.depository ?? '—'}</td>
                    <td className={`${td} font-mono text-xs`}>{r.dp_id ?? '—'}</td>
                    <td className={`${td} font-mono text-xs`}>{r.client_id ?? '—'}</td>
                  </tr>
                ))}
                {rep.data.rows.length === 0 && (
                  <tr><td className={`${td} text-text-muted`} colSpan={8}>No current holders in this series.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
