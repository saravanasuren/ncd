import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface EventRow {
  id: number;
  ref: string;
  status: string;
  created_at: string;
}

function EventTable({ title, rows }: { title: string; rows: EventRow[] }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card mb-6 overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">{title}</div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
          <th className="px-4 py-2">Ref</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Created</th></tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-1.5 font-mono text-xs">{r.ref}</td>
              <td className="px-4 py-1.5"><span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.status}</span></td>
              <td className="px-4 py-1.5 text-text-muted text-xs">{String(r.created_at).slice(0, 10)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-5 text-center text-text-muted">None yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** NCD events register (docs/00 §6). Initiation lives on the application page. */
export function EventsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['ncd-events'],
    queryFn: () => api.get<{ rollovers: EventRow[]; transfers: EventRow[]; transformations: EventRow[] }>('/api/ncd-events'),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  return (
    <div className="max-w-4xl">
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
