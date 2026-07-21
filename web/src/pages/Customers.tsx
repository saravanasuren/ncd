import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';
import { CustomerWizard } from '../components/CustomerWizard.js';
import { statusLabel } from '../labels.js';

type CustTab = 'all' | 'approved' | 'pending' | 'draft';
const custMatch = (tab: CustTab, s: string) =>
  tab === 'all' ? true : tab === 'approved' ? s === 'Approved' : tab === 'pending' ? s === 'PendingApproval' : s === 'Draft';

interface CustomerRow {
  id: number;
  customer_code: string;
  full_name: string;
  phone: string | null;
  district: string | null;
  kyc_status: string;
  creation_status: string;
  is_active: boolean;
}

// The list endpoint may return a bare array or {rows,total,truncated}. Handle both.
type CustomerListResp = { rows: CustomerRow[]; total?: number; truncated?: boolean } | CustomerRow[];

const statusPill: Record<string, string> = {
  Approved: 'bg-[color:var(--success-bg)] text-success',
  PendingApproval: 'bg-[color:var(--warn-bg)] text-warn',
  Draft: 'bg-bg text-text-muted',
};

const columns: Column<CustomerRow>[] = [
  { key: 'customer_code', header: 'Code', tdClassName: 'font-mono text-xs' },
  { key: 'full_name', header: 'Name', tdClassName: 'font-medium',
    render: (c) => <Link to={`/app/customers/${c.id}`} className="text-primary hover:underline">{c.full_name}</Link> },
  { key: 'district', header: 'District', value: (c) => c.district ?? '', render: (c) => c.district ?? '—' },
  { key: 'kyc_status', header: 'KYC', tdClassName: 'text-text-muted' },
  { key: 'creation_status', header: 'Status', value: (c) => statusLabel(c.creation_status),
    render: (c) => <span className={`text-xs rounded px-1.5 py-0.5 ${statusPill[c.creation_status] ?? 'bg-bg'}`}>{statusLabel(c.creation_status)}</span> },
];

export function CustomersPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<CustTab>('approved');
  const [enrolling, setEnrolling] = useState(false);
  const query = q.trim();
  const { data, isLoading, error } = useQuery({
    queryKey: ['customers', query],
    queryFn: () => api.get<CustomerListResp>(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  });
  if (error) return <div className="text-danger">Failed to load customers.</div>;
  const rows = Array.isArray(data) ? data : (data?.rows ?? []);
  const truncated = !!data && !Array.isArray(data) && data.truncated === true;
  const total = !Array.isArray(data) && data?.total != null ? data.total : rows.length;
  const tabs: TabDef<CustTab>[] = [
    { key: 'approved', label: 'Approved', count: rows.filter((r) => custMatch('approved', r.creation_status)).length },
    { key: 'pending', label: 'Pending approval', count: rows.filter((r) => custMatch('pending', r.creation_status)).length },
    { key: 'draft', label: 'Draft', count: rows.filter((r) => custMatch('draft', r.creation_status)).length },
    { key: 'all', label: 'All', count: rows.length },
  ];

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight m-0">Customers</h1>
          <p className="text-sm text-text-muted mt-1">Enrolled investors in your scope.</p>
        </div>
        {can('customers:create') && (
          <button onClick={() => setEnrolling(true)} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">+ Create Customer</button>
        )}
      </div>

      {enrolling && <CustomerWizard onClose={() => setEnrolling(false)} />}

      <input
        className="w-full max-w-md px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary mb-4"
        placeholder="Search name, PAN, phone, code, email…"
        value={q} onChange={(e) => setQ(e.target.value)}
      />

      {truncated && (
        <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
          Showing first {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} — refine your search to see the rest.
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {isLoading ? <div className="text-text-muted">Loading customers…</div> : (
        <DataTable
          columns={columns}
          rows={rows.filter((c) => custMatch(tab, c.creation_status))}
          rowKey={(c) => c.id}
          defaultSort={{ key: 'customer_code', dir: 'desc' }}
          empty={query ? 'No matches.' : 'No customers in this view.'}
        />
      )}
    </div>
  );
}
