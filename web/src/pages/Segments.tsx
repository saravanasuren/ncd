import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

type Seg = 'customer' | 'district' | 'agent' | 'staff';
const TABS: { key: Seg; label: string }[] = [
  { key: 'customer', label: 'Customer-wise' },
  { key: 'district', label: 'District-wise' },
  { key: 'agent', label: 'Agent-wise' },
  { key: 'staff', label: 'Staff-wise' },
];

export function SegmentsPage() {
  const [tab, setTab] = useState<Seg>('customer');
  const { data, isLoading } = useQuery({ queryKey: ['segment', tab], queryFn: () => api.get<{ rows: any[] }>(`/api/reports/segments/${tab}`) });

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Segments</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">The book sliced by customer, district, agent and staff.</p>
      <div className="flex gap-1 mb-4 border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === t.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-text-muted hover:text-text'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {isLoading ? <div className="text-text-muted">Loading…</div> : <SegTable seg={tab} rows={data!.rows} />}
    </div>
  );
}

function SegTable({ seg, rows }: { seg: Seg; rows: any[] }) {
  if (rows.length === 0) return <div className="bg-surface border border-border rounded-lg p-6 text-center text-text-muted">No data.</div>;
  const cfg: Record<Seg, { head: string[]; cells: (r: any) => string[]; money: number[] }> = {
    customer: { head: ['Code', 'Customer', 'District', 'Sourced by', 'NCDs', 'Outstanding'], cells: (r) => [r.customer_code, r.customer, r.district ?? '—', r.sourced_by, String(r.ncds), formatINR(r.outstanding)], money: [5] },
    district: { head: ['District', 'Investors', 'Amount'], cells: (r) => [r.district, String(r.investors), formatINR(r.amount)], money: [2] },
    agent: { head: ['Agent', 'Customer', 'Amount'], cells: (r) => [r.agent, r.customer, formatINR(r.amount)], money: [2] },
    staff: { head: ['Staff', 'Customer', 'Amount'], cells: (r) => [r.staff, r.customer, formatINR(r.amount)], money: [2] },
  };
  const c = cfg[seg];
  const columns: Column<any>[] = c.head.map((h, i) => ({
    key: String(i),
    header: h,
    align: c.money.includes(i) ? 'right' : 'left',
    value: (r) => c.cells(r)[i] ?? '',
    render: (r) => c.money.includes(i) ? <span className="mono">{c.cells(r)[i]}</span> : c.cells(r)[i],
  }));
  const moneyCol = c.money[c.money.length - 1];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => c.cells(r).join('|')}
      defaultSort={moneyCol != null ? { key: String(moneyCol), dir: 'desc' } : undefined}
      empty="No data."
    />
  );
}
