/** Users & branches admin service (docs/04 §2). */
import bcrypt from 'bcryptjs';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { isRole, type Role } from '@new-wealth/shared';

export interface UserListRow {
  id: number;
  email: string;
  full_name: string;
  role: string;
  branch_id: number | null;
  is_active: boolean;
}

export async function listUsers(db: Db): Promise<UserListRow[]> {
  const { rows } = await db.query<UserListRow & { role_name: string }>(
    `SELECT u.id, u.email, u.full_name, r.name AS role, u.branch_id, u.is_active
     FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.full_name`
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), branch_id: r.branch_id != null ? Number(r.branch_id) : null }));
}

export interface BranchRow {
  id: number;
  code: string;
  name: string;
}

export async function listBranches(db: Db): Promise<BranchRow[]> {
  const { rows } = await db.query<BranchRow>('SELECT id, code, name FROM branches ORDER BY name');
  return rows.map((b) => ({ ...b, id: Number(b.id) }));
}

async function roleId(db: Db, role: Role): Promise<number> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [role]);
  if (!rows[0]) throw errors.badRequest('Unknown role');
  return Number(rows[0].id);
}

export interface CreateUserInput {
  email: string;
  full_name: string;
  role: string;
  password: string;
  branch_id?: number | null;
  reports_to_user_id?: number | null;
}

export async function createUser(db: Db, actor: AuthUser, input: CreateUserInput): Promise<{ id: number }> {
  if (!isRole(input.role)) throw errors.badRequest('Unknown role');
  const rid = await roleId(db, input.role);
  const hash = await bcrypt.hash(input.password, 10);
  return db.withTx(async (tx) => {
    const existing = await tx.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
    if (existing.rowCount) throw errors.conflict('Email already in use');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role_id, branch_id, reports_to_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.email, hash, input.full_name, rid, input.branch_id ?? null, input.reports_to_user_id ?? null]
    );
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'user.create', entityType: 'users', entityId: id, after: { email: input.email, role: input.role } });
    return { id };
  });
}

export interface UpdateUserInput {
  full_name?: string;
  role?: string;
  branch_id?: number | null;
  reports_to_user_id?: number | null;
  is_active?: boolean;
  password?: string;
}

export async function updateUser(db: Db, actor: AuthUser, id: number, input: UpdateUserInput): Promise<void> {
  await db.withTx(async (tx) => {
    const cur = await tx.query<Record<string, unknown>>('SELECT * FROM users WHERE id = $1', [id]);
    if (!cur.rows[0]) throw errors.notFound('User not found');
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    if (input.full_name !== undefined) { sets.push(`full_name = $${++p}`); params.push(input.full_name); }
    if (input.role !== undefined) {
      if (!isRole(input.role)) throw errors.badRequest('Unknown role');
      sets.push(`role_id = $${++p}`); params.push(await roleId(tx, input.role));
    }
    if (input.branch_id !== undefined) { sets.push(`branch_id = $${++p}`); params.push(input.branch_id); }
    if (input.reports_to_user_id !== undefined) {
      if (input.reports_to_user_id === id) throw errors.badRequest('User cannot report to themselves');
      sets.push(`reports_to_user_id = $${++p}`); params.push(input.reports_to_user_id);
    }
    if (input.is_active !== undefined) { sets.push(`is_active = $${++p}`); params.push(input.is_active); }
    if (input.password) { sets.push(`password_hash = $${++p}`); params.push(await bcrypt.hash(input.password, 10)); }
    if (!sets.length) return;
    sets.push(`updated_at = now()`);
    params.push(id);
    await tx.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${++p}`, params);
    await writeAudit(tx, { actorId: actor.id, action: 'user.update', entityType: 'users', entityId: id, before: cur.rows[0], after: input });
  });
}

export async function setUserBranches(db: Db, actor: AuthUser, id: number, branchIds: number[]): Promise<void> {
  await db.withTx(async (tx) => {
    await tx.query('DELETE FROM user_branches WHERE user_id = $1', [id]);
    for (const b of branchIds) {
      await tx.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, b]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'user.set-branches', entityType: 'users', entityId: id, after: { branchIds } });
  });
}

export async function deleteUser(db: Db, actor: AuthUser, id: number): Promise<void> {
  await db.withTx(async (tx) => {
    const cur = await tx.query('SELECT email FROM users WHERE id = $1', [id]);
    if (!cur.rowCount) throw errors.notFound('User not found');
    await tx.query('DELETE FROM users WHERE id = $1', [id]);
    await writeAudit(tx, { actorId: actor.id, action: 'user.delete', entityType: 'users', entityId: id, before: cur.rows[0] });
  });
}
