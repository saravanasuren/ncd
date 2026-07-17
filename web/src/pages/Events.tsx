import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface EventRow {
  id: number;
  ref: string;
  status: string;
  created_at: string;
}

const columns: Column<EventRow>[] = [
  { key: 'ref', header: 'Ref', tdClassName: 'font-mono text-xs' },
  { key: 'status', header: 'Status', render: (r) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.status}</span> },
  { key: 'created_at', header: 'Created', value: (r) => r.created_at, render: (r) => <span className="text-text-muted text-xs">{String(r.created_at).slice(0, 10)}</span> },
];

function EventTable({ title, rows }: { title: string; rows: EventRow[] }) {
  return (
    <div className="mb-6">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">{title}</h2>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: 'created_at', dir: 'desc' }} empty="None yet." />
    </div>
  );
}

/** NCD events register (docs/00 §6). Initiation lives on the application page. */
export function EventsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['ncd-events'],
    queryFn: () => api.get<{ rollovers: EventRow[]; transfers: EventRow[]; transformations: EventRow[] }>('/api/ncd-events'),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load NCD events.</div>;
  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">NCD Events</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">
        Rollovers, holder transfers and transformations. Initiate them from the investment's application page (Applications → open one → lifecycle actions).
      </p>
      <EventTable title="Rollovers" rows={data!.rollovers} />
      <EventTable title="Holder transfers" rows={data!.transfers} />
      <EventTable title="Transformations (deceased → nominee)" rows={data!.transformations} />
    </div>
  );
}
