import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

interface AppRow {
  id: number; application_no: string; status: string; total_amount: string;
  customer_name: string; customer_code: string; series_code: string; maturity_date: string | null;
}

type AppTab = 'all' | 'active' | 'pending' | 'redeemed';
const APP_PENDING = new Set(['Draft', 'PendingApproval', 'PendingFundVerification', 'PendingEsign', 'PendingAllotment', 'PendingActivation']);
const APP_REDEEMED = new Set(['Redeemed', 'Matured', 'PrematureWithdrawn', 'RolledOver', 'Transferred']);
const appMatch = (tab: AppTab, s: string) =>
  tab === 'all' ? true : tab === 'active' ? s === 'Active' : tab === 'pending' ? APP_PENDING.has(s) : APP_REDEEMED.has(s);

const pill: Record<string, string> = {
  Active: 'bg-[color:var(--success-bg)] text-success',
  Redeemed: 'bg-bg text-text-muted',
  PendingActivation: 'bg-[color:var(--warn-bg)] text-warn',
  PendingAllotment: 'bg-[color:var(--warn-bg)] text-warn',
  PendingFundVerification: 'bg-[color:var(--warn-bg)] text-warn',
  PendingEsign: 'bg-[color:var(--warn-bg)] text-warn',
};

const columns: Column<AppRow>[] = [
  { key: 'application_no', header: 'App No.', tdClassName: 'font-mono text-xs',
    render: (a) => <Link to={`/app/applications/${a.id}`} className="text-primary hover:underline">{a.application_no}</Link> },
  { key: 'customer_name', header: 'Customer' },
  { key: 'series_code', header: 'Series' },
  { key: 'total_amount', header: 'Amount', align: 'right',
    value: (a) => Number(a.total_amount), render: (a) => <span className="mono">{formatINR(a.total_amount)}</span> },
  { key: 'status', header: 'Status',
    render: (a) => <span className={`text-xs rounded px-1.5 py-0.5 ${pill[a.status] ?? 'bg-bg'}`}>{a.status}</span> },
];

export function ApplicationsPage() {
  const [tab, setTab] = useState<AppTab>('active');
  const { data, isLoading, error } = useQuery({ queryKey: ['applications'], queryFn: () => api.get<{ rows: AppRow[] }>('/api/applications') });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load applications.</div>;
  const rows = data!.rows;
  const tabs: TabDef<AppTab>[] = [
    { key: 'active', label: 'Active', count: rows.filter((r) => appMatch('active', r.status)).length },
    { key: 'pending', label: 'Pending', count: rows.filter((r) => appMatch('pending', r.status)).length },
    { key: 'redeemed', label: 'Redeemed', count: rows.filter((r) => appMatch('redeemed', r.status)).length },
    { key: 'all', label: 'All', count: rows.length },
  ];
  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Applications</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">NCD investments in your scope.</p>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      <DataTable
        columns={columns}
        rows={rows.filter((r) => appMatch(tab, r.status))}
        rowKey={(a) => a.id}
        defaultSort={{ key: 'application_no', dir: 'desc' }}
        empty="No applications in this view."
      />
    </div>
  );
}
