/** Users repo — SQL only (docs/01 §3). */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import type { Permission, Role } from '@new-wealth/shared';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  full_name: string;
  role_name: string;
  is_active: boolean;
}

async function hydrate(db: Db, row: UserRow): Promise<AuthUser> {
  const perms = await db.query<{ permission: string }>(
    `SELECT rp.permission FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id WHERE r.name = $1`,
    [row.role_name]
  );
  const branches = await db.query<{ branch_id: string }>(
    'SELECT branch_id FROM user_branches WHERE user_id = $1',
    [row.id]
  );
  const agent = await db.query<{ id: string }>('SELECT id FROM agents WHERE user_id = $1', [row.id]);
  // Portal customers link back via customers.portal_user_id.
  let customerId: number | null = null;
  try {
    const cust = await db.query<{ id: string }>('SELECT id FROM customers WHERE portal_user_id = $1 LIMIT 1', [row.id]);
    customerId = cust.rows[0] ? Number(cust.rows[0].id) : null;
  } catch {
    customerId = null; // customers table may not exist yet (early migrations)
  }
  return {
    id: Number(row.id),
    email: row.email,
    fullName: row.full_name,
    role: row.role_name as Role,
    permissions: perms.rows.map((p) => p.permission as Permission),
    branchIds: branches.rows.map((b) => Number(b.branch_id)),
    agentId: agent.rows[0] ? Number(agent.rows[0].id) : null,
    customerId,
  };
}

export async function findByEmailWithSecret(
  db: Db,
  email: string
): Promise<{ user: AuthUser; passwordHash: string | null; isActive: boolean } | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.full_name, r.name AS role_name, u.is_active
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE lower(u.email) = lower($1)`,
    [email]
  );
  const row = rows[0];
  if (!row) return null;
  const user = await hydrate(db, row);
  return { user, passwordHash: row.password_hash, isActive: row.is_active };
}

/** Login lookup by email OR mobile (digits-only). Returns the verification
 * status too, so the auth layer can enforce the 30-day unverified block. */
export async function findByLoginWithSecret(
  db: Db,
  identifier: string
): Promise<{ user: AuthUser; passwordHash: string | null; isActive: boolean; isSelfSignup: boolean; verifiedAt: string | null; createdAt: string } | null> {
  const digits = identifier.replace(/\D/g, '');
  const { rows } = await db.query<UserRow & { is_self_signup: boolean; verified_at: string | null; created_at: string }>(
    `SELECT u.id, u.email, u.password_hash, u.full_name, r.name AS role_name, u.is_active,
            u.is_self_signup, u.verified_at, u.created_at
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE lower(u.email) = lower($1)
        OR ($2 <> '' AND regexp_replace(COALESCE(u.phone,''),'\\D','','g') = $2)
     ORDER BY (lower(u.email) = lower($1)) DESC
     LIMIT 1`,
    [identifier, digits]
  );
  const row = rows[0];
  if (!row) return null;
  const user = await hydrate(db, row);
  return { user, passwordHash: row.password_hash, isActive: row.is_active, isSelfSignup: row.is_self_signup, verifiedAt: row.verified_at, createdAt: row.created_at };
}

export async function findAuthUserById(db: Db, id: number): Promise<AuthUser | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.full_name, r.name AS role_name, u.is_active
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1 AND u.is_active = TRUE`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  return hydrate(db, row);
}
