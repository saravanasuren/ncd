import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS, isRole } from '@new-wealth/shared';
import { api } from '../api/client.js';

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  role: string;
  branch_id: number | null;
  is_active: boolean;
}

/** Admin → Users (docs/05 §21). List view; create/edit modal lands next. */
export function UsersPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ rows: UserRow[] }>('/api/users'),
  });

  if (isLoading) return <div className="text-text-muted">Loading users…</div>;
  if (error) return <div className="text-danger">Failed to load users.</div>;

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Users</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Staff, agents and portal accounts.</p>
      <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-text-label border-b border-border">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Email</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data!.rows.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2.5 font-medium">{u.full_name}</td>
                <td className="px-4 py-2.5 text-text-muted">{u.email}</td>
                <td className="px-4 py-2.5">{isRole(u.role) ? ROLE_LABELS[u.role] : u.role}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs rounded px-1.5 py-0.5 ${u.is_active ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--danger-bg)] text-danger'}`}>
                    {u.is_active ? 'Active' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
            {data!.rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-text-muted">No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
