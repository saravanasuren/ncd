import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, STAFF_ROLES, isRole } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

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

const EMPTY_FORM = { full_name: '', email: '', password: '', role: '', branch_id: '', reports_to_user_id: '' };

interface EditState {
  id: number;
  full_name: string;
  role: string;
  branch_id: string;
  is_active: boolean;
  password: string; // blank = keep current
}

/** Admin → Users (docs/05 §21). */
export function UsersPage() {
  const qc = useQueryClient();
  const { can, user: me } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [edit, setEdit] = useState<EditState | null>(null);
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
        reports_to_user_id: form.reports_to_user_id ? Number(form.reports_to_user_id) : null,
      }),
    onSuccess: () => { setForm(EMPTY_FORM); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to create user'),
  });

  const update = useMutation({
    mutationFn: (e: EditState) =>
      api.put(`/api/users/${e.id}`, {
        full_name: e.full_name,
        role: e.role,
        branch_id: e.branch_id ? Number(e.branch_id) : null,
        is_active: e.is_active,
        ...(e.password ? { password: e.password } : {}),
      }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to update user'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to delete user'),
  });

  if (isLoading) return <div className="text-text-muted">Loading users…</div>;
  if (error) return <div className="text-danger">Failed to load users.</div>;

  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const ready = form.full_name && form.email && form.password.length >= 8 && form.role;

  // Columns close over edit state + mutations; each cell renders its edit control when the row is being edited.
  const columns: Column<UserRow>[] = [
    { key: 'full_name', header: 'Name', tdClassName: 'font-medium',
      render: (u) => edit?.id === u.id
        ? <input className={inp} value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} />
        : u.full_name },
    { key: 'email', header: 'Email', tdClassName: 'text-text-muted' },
    { key: 'role', header: 'Role', value: (u) => (isRole(u.role) ? ROLE_LABELS[u.role] : u.role),
      render: (u) => edit?.id === u.id
        ? <select className={inp} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
            {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        : (isRole(u.role) ? ROLE_LABELS[u.role] : u.role) },
    { key: 'branch', header: 'Branch', tdClassName: 'text-text-muted', value: (u) => branchLabel(u.branch_id),
      render: (u) => edit?.id === u.id
        ? <select className={inp} value={edit.branch_id} onChange={(e) => setEdit({ ...edit, branch_id: e.target.value })}>
            <option value="">No branch</option>
            {branches?.rows.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        : branchLabel(u.branch_id) },
    { key: 'status', header: 'Status', value: (u) => (u.is_active ? 'Active' : 'Disabled'),
      render: (u) => edit?.id === u.id
        ? <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={edit.is_active} disabled={u.id === me?.id}
              onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />
            Active
          </label>
        : <span className={`text-xs rounded px-1.5 py-0.5 ${u.is_active ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--danger-bg)] text-danger'}`}>
            {u.is_active ? 'Active' : 'Disabled'}
          </span> },
    { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
      render: (u) => edit?.id === u.id ? (
        <span className="inline-flex items-center gap-1.5 justify-end">
          <input className={`${inp} w-36`} type="password" placeholder="New password" autoComplete="new-password"
            value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
          <button
            disabled={!edit.full_name || (edit.password !== '' && edit.password.length < 8) || update.isPending}
            onClick={() => { setErr(''); update.mutate(edit); }}
            className="text-xs bg-primary text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Save</button>
          <button onClick={() => setEdit(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2.5 justify-end">
          {can('users:manage') && (
            <button
              onClick={() => { setErr(''); setEdit({ id: u.id, full_name: u.full_name, role: u.role, branch_id: u.branch_id != null ? String(u.branch_id) : '', is_active: u.is_active, password: '' }); }}
              className="text-xs text-primary hover:underline">Edit</button>
          )}
          {can('users:delete') && u.id !== me?.id && (
            <button
              onClick={() => {
                setErr('');
                if (window.confirm(`Permanently delete ${u.full_name} (${u.email})? Prefer disabling unless the account was created in error.`)) remove.mutate(u.id);
              }}
              className="text-xs text-danger hover:underline">Delete</button>
          )}
        </span>
      ) },
  ];

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
            <select className={inp} title="Reports to" value={form.reports_to_user_id} onChange={(e) => setForm({ ...form, reports_to_user_id: e.target.value })}>
              <option value="">Reports to…</option>
              {data?.rows.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            <button disabled={!ready || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
              className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">
              + Add user
            </button>
          </div>
          {err && <div className="text-xs text-danger mt-2">{err}</div>}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={data!.rows}
        rowKey={(u) => u.id}
        defaultSort={{ key: 'full_name', dir: 'asc' }}
        empty="No users yet."
      />
    </div>
  );
}
