import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface CwApplication {
  application_no: string;
  series_code: string | null;
  amount: number;
  status: string;
  date_money_received: string | null;
}
interface CwCustomer {
  id: number;
  customer_code: string;
  full_name: string;
  dob: string | null;
  age: number | null;
  pan: string | null;
  phone: string | null;
  address: string;
  tds_status: string;
  total_invested: number;
  total_all_time: number;
  total_redeemed: number;
  applications: CwApplication[];
}

const CLOSED = new Set(['Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred']);
const dmy = (v: string | null) => {
  if (!v) return '—';
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
};

/** Ported from wealth's "Customer-wise report" — one row per customer with
 * DOB/PAN/address/TDS status and a total/all-time/redeemed money split; click
 * a row to see their individual investments (docs — see book.customerWiseReport). */
export function CustomerWiseReportPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-wise-report'],
    queryFn: () => api.get<{ customers: CwCustomer[]; count: number; grand_total: number; investments: number }>('/api/reports/customer-wise'),
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const columns: Column<CwCustomer>[] = [
    {
      key: 'full_name', header: 'Customer', value: (r) => r.full_name,
      render: (r) => (
        <button onClick={() => toggle(r.id)} className="inline-flex items-center gap-2 text-left hover:text-primary">
          <span className="w-4 h-4 inline-flex items-center justify-center rounded border border-border-strong text-[11px] leading-none text-text-muted shrink-0">
            {expanded.has(r.id) ? '−' : '+'}
          </span>
          <span>
            <span className="font-medium">{r.full_name}</span>
            <span className="block text-[10px] text-text-muted font-mono">{r.customer_code}</span>
          </span>
        </button>
      ),
    },
    { key: 'dob', header: 'DOB', value: (r) => r.dob ?? '', render: (r) => <span className="text-text-muted text-xs">{dmy(r.dob)}</span> },
    { key: 'age', header: 'Age', align: 'right', value: (r) => r.age ?? '', render: (r) => r.age ?? '—' },
    { key: 'pan', header: 'PAN', value: (r) => r.pan ?? '', tdClassName: 'font-mono text-xs', render: (r) => r.pan ?? '—' },
    {
      key: 'address', header: 'Address', value: (r) => r.address,
      render: (r) => <span className="text-xs text-text-muted block max-w-[240px] truncate" title={r.address}>{r.address || '—'}</span>,
    },
    { key: 'tds_status', header: 'TDS / Form 121', value: (r) => r.tds_status },
    {
      key: 'total_invested', header: 'Total investment', align: 'right', value: (r) => r.total_invested,
      render: (r) => (
        <span>
          <span className="mono font-semibold">{formatINR(r.total_invested)}</span>
          {r.total_all_time > r.total_invested && (
            <span className="block text-[10px] text-text-muted">all-time {formatINR(r.total_all_time)}</span>
          )}
        </span>
      ),
    },
    {
      key: 'total_redeemed', header: 'Redemption', align: 'right', value: (r) => r.total_redeemed,
      render: (r) => (r.total_redeemed > 0 ? <span className="mono">{formatINR(r.total_redeemed)}</span> : <span className="text-text-muted">—</span>),
    },
    { key: 'apps', header: 'Investments', align: 'right', sortable: false, filterable: false, value: (r) => r.applications.length },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Customer-wise report</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">
        One row per customer — click any row to see their individual investments.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-3">
          <Tile label="Customers" value={(data?.count ?? 0).toLocaleString('en-IN')} />
          <Tile label="Total investment" value={formatINR(data?.grand_total ?? 0)} />
          <Tile label="Investments" value={(data?.investments ?? 0).toLocaleString('en-IN')} />
        </div>
        <a href="/api/reports/customer-wise.xlsx" className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold no-underline inline-block">
          ↓ Download Excel
        </a>
      </div>

      {error ? (
        <div className="text-danger text-sm">Failed to load the report.</div>
      ) : isLoading ? (
        <div className="text-text-muted text-sm">Loading…</div>
      ) : (
        <DataTable
          columns={columns}
          rows={data!.customers}
          rowKey={(r) => r.id}
          defaultSort={{ key: 'total_invested', dir: 'desc' }}
          empty="No customers match."
          renderExpanded={(r) => (expanded.has(r.id) ? <AppsTable rows={r.applications} /> : null)}
        />
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-4 py-2.5 min-w-[140px]">
      <div className="text-[10px] text-text-label uppercase tracking-wide font-semibold">{label}</div>
      <div className="text-lg font-bold mono mt-0.5">{value}</div>
    </div>
  );
}

function AppsTable({ rows }: { rows: CwApplication[] }) {
  if (!rows.length) return <div className="text-xs text-text-muted px-4 py-2">No investments.</div>;
  return (
    <div className="bg-bg/60 px-4 py-2 border-l-2 border-primary/30">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-text-muted">
            <th className="py-1 pr-4 font-medium">Application</th>
            <th className="py-1 pr-4 font-medium">Series</th>
            <th className="py-1 pr-4 text-right font-medium">Amount</th>
            <th className="py-1 pr-4 font-medium">Status</th>
            <th className="py-1 font-medium">Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.application_no} className="border-t border-border/60">
              <td className="py-1 pr-4 font-mono">{a.application_no}</td>
              <td className="py-1 pr-4">{a.series_code ?? '—'}</td>
              <td className="py-1 pr-4 text-right mono font-semibold">{formatINR(a.amount)}</td>
              <td className="py-1 pr-4">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${CLOSED.has(a.status) ? 'bg-bg text-text-muted' : 'bg-[color:var(--success-bg)] text-success'}`}>
                  {a.status}
                </span>
              </td>
              <td className="py-1 text-text-muted">{dmy(a.date_money_received)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
