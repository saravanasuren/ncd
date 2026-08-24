import { useState } from 'react';
import { useRecentSearches, RecentSearches } from '../components/RecentSearches.js';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';
import { CustomerWizard } from '../components/CustomerWizard.js';
import { statusLabel } from '../labels.js';

type CustTab = 'all' | 'approved' | 'pending' | 'draft' | 'inprogress';
const custMatch = (tab: CustTab, s: string) =>
  tab === 'all' ? true : tab === 'approved' ? s === 'Approved' : tab === 'pending' ? s === 'PendingApproval' : s === 'Draft';

// A half-finished enrolment, persisted server-side (owner 2026-08-22). A user
// sees their own; a super-admin sees every user's.
interface DraftRow { owner_user_id: number; owner_name: string | null; display_name: string | null; display_phone: string | null; updated_at: string; mine: boolean }

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
  const [focused, setFocused] = useState(false);
  const { recent, push: pushRecent, remove: removeRecent } = useRecentSearches('customers');
  const [tab, setTab] = useState<CustTab>('approved');
  const [enrolling, setEnrolling] = useState(false);
  const query = q.trim();
  const { data, isLoading, error } = useQuery({
    queryKey: ['customers', query],
    queryFn: () => api.get<CustomerListResp>(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  });
  const draftsQ = useQuery({
    queryKey: ['customer-drafts'],
    queryFn: () => api.get<{ all: boolean; rows: DraftRow[] }>('/api/customers/drafts'),
    enabled: can('customers:read'),
  });
  const drafts = draftsQ.data?.rows ?? [];
  if (error) return <div className="text-danger">Failed to load customers.</div>;
  const rows = Array.isArray(data) ? data : (data?.rows ?? []);
  const truncated = !!data && !Array.isArray(data) && data.truncated === true;
  const total = !Array.isArray(data) && data?.total != null ? data.total : rows.length;
  const tabs: TabDef<CustTab>[] = [
    { key: 'approved', label: 'Approved', count: rows.filter((r) => custMatch('approved', r.creation_status)).length },
    { key: 'pending', label: 'Pending approval', count: rows.filter((r) => custMatch('pending', r.creation_status)).length },
    { key: 'draft', label: 'Draft', count: rows.filter((r) => custMatch('draft', r.creation_status)).length },
    { key: 'inprogress', label: draftsQ.data?.all ? 'In progress (all users)' : 'In progress', count: drafts.length },
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

      <div className="relative w-full max-w-md mb-4">
        <input
          className="w-full px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary"
          placeholder="Search name, PAN, phone, code, email…"
          value={q} onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          // e.target.value (not q) avoids a stale closure; empty is ignored by push.
          onBlur={(e) => { setFocused(false); pushRecent(e.target.value); }}
        />
        {/* The list only appears on an empty, focused box, so clicking a recent
            term never double-records the previous partial. */}
        {focused && !q.trim() && (
          <RecentSearches items={recent} onPick={(t) => { setQ(t); pushRecent(t); }} onRemove={removeRecent} />
        )}
      </div>

      {truncated && (
        <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
          Showing first {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} — refine your search to see the rest.
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'inprogress' ? (
        <div className="overflow-x-auto bg-surface border border-border rounded-lg shadow-card">
          <p className="text-xs text-text-muted px-4 pt-3 m-0">
            {draftsQ.data?.all
              ? 'Half-finished customer enrolments across all users — not yet submitted.'
              : 'Your half-finished customer enrolments — not yet submitted.'}
          </p>
          <table className="w-full text-sm border-collapse mt-2">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 px-4 text-left text-xs font-semibold text-text-label uppercase tracking-wide">Name</th>
                <th className="py-2 px-4 text-left text-xs font-semibold text-text-label uppercase tracking-wide">Phone</th>
                <th className="py-2 px-4 text-left text-xs font-semibold text-text-label uppercase tracking-wide">Started by</th>
                <th className="py-2 px-4 text-left text-xs font-semibold text-text-label uppercase tracking-wide">Last edited</th>
                <th className="py-2 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr key={d.owner_user_id} className="border-b border-border last:border-0 hover:bg-bg">
                  <td className="py-2 px-4 font-medium">{d.display_name || <span className="text-text-muted">(no name yet)</span>}</td>
                  <td className="py-2 px-4 font-mono text-xs">{d.display_phone ?? '—'}</td>
                  <td className="py-2 px-4">{d.owner_name ?? '—'}{d.mine && <span className="text-xs text-text-muted"> · you</span>}</td>
                  <td className="py-2 px-4 text-xs text-text-muted">{String(d.updated_at).slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-2 px-4 text-right">
                    {d.mine && can('customers:create') && (
                      <button className="text-xs text-primary hover:underline" onClick={() => setEnrolling(true)}>Resume</button>
                    )}
                  </td>
                </tr>
              ))}
              {drafts.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-text-muted">No in-progress enrolments.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : isLoading ? <div className="text-text-muted">Loading customers…</div> : (
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
