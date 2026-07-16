import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, STAFF_ROLES, isRole } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  role: string;
  branch_id: number | null;
  is_active: boolean;
}

interface BranchRow {
  id: number;
  code: string;
  name: string;
}

const EMPTY_FORM = { full_name: '', email: '', password: '', role: '', branch_id: '' };

/** Admin → Users (docs/05 §21). */
export function UsersPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [err, setErr] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ rows: UserRow[] }>('/api/users'),
  });
  const { data: branches } = useQuery({
    queryKey: ['users', 'branches'],
    queryFn: () => api.get<{ rows: BranchRow[] }>('/api/users/branches'),
  });
  const branchLabel = (id: number | null) =>
    id == null ? '—' : (branches?.rows.find((b) => b.id === id)?.name ?? `#${id}`);

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/users', {
        full_name: form.full_name,
        email: form.email,
        password: form.password,
        role: form.role,
        branch_id: form.branch_id ? Number(form.branch_id) : null,
      }),
    onSuccess: () => { setForm(EMPTY_FORM); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to create user'),
  });

  if (isLoading) return <div className="text-text-muted">Loading users…</div>;
  if (error) return <div className="text-danger">Failed to load users.</div>;

  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const ready = form.full_name && form.email && form.password.length >= 8 && form.role;

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Users</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Staff, agents and portal accounts.</p>

      {can('users:manage') && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
          <div className="flex flex-wrap gap-2 items-end">
            <input className={inp} placeholder="Full name" value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <input className={inp} type="email" placeholder="Email" value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input className={inp} type="password" placeholder="Password (min 8)" value={form.password}
              autoComplete="new-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <select className={inp} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="">Role…</option>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <select className={inp} value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
              <option value="">No branch</option>
              {branches?.rows.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button disabled={!ready || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
              className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">
              + Add user
            </button>
          </div>
          {err && <div className="text-xs text-danger mt-2">{err}</div>}
        </div>
      )}

      <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-text-label border-b border-border">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Email</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Branch</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data!.rows.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2.5 font-medium">{u.full_name}</td>
                <td className="px-4 py-2.5 text-text-muted">{u.email}</td>
                <td className="px-4 py-2.5">{isRole(u.role) ? ROLE_LABELS[u.role] : u.role}</td>
                <td className="px-4 py-2.5 text-text-muted">{branchLabel(u.branch_id)}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs rounded px-1.5 py-0.5 ${u.is_active ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--danger-bg)] text-danger'}`}>
                    {u.is_active ? 'Active' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
            {data!.rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-text-muted">No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
