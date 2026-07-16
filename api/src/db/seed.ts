/**
 * Seed — roles, permission matrix, settings defaults, company profile,
 * branches, TDS rules, the admin user, and a SYNTHETIC demo book (never real
 * customer data). Idempotent. Run: `npm run seed` (after migrate).
 */
import bcrypt from 'bcryptjs';
import type { Db } from './types.js';
import { migrate } from './migrate.js';
import {
  ROLES,
  ROLE_LABELS,
  ROLE_LEVEL,
  DEFAULT_ROLE_PERMISSIONS,
  SETTINGS_CATALOG,
} from '@new-wealth/shared';
import { config } from '../config.js';

const ROLE_IDS: Record<string, number> = Object.fromEntries(ROLES.map((r, i) => [r, i + 1]));

export async function seed(db: Db): Promise<void> {
  await migrate(db);

  // Roles
  for (const role of ROLES) {
    await db.query(
      `INSERT INTO roles (id, name, label, level) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET label = $3, level = $4`,
      [ROLE_IDS[role], role, ROLE_LABELS[role], ROLE_LEVEL[role]]
    );
  }

  // Role → permissions (reset to catalog each seed so edits in code propagate)
  for (const role of ROLES) {
    const roleId = ROLE_IDS[role];
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    for (const perm of DEFAULT_ROLE_PERMISSIONS[role]) {
      await db.query(
        'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [roleId, perm]
      );
    }
  }

  // Settings defaults (don't clobber values an admin already changed)
  for (const def of SETTINGS_CATALOG) {
    await db.query(
      `INSERT INTO app_settings (key, value, group_name, label, description, editable_by)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
      [def.key, JSON.stringify(def.default), def.group, def.label, def.description, def.editableBy]
    );
  }

  // Company profile singleton
  await db.query(
    `INSERT INTO company_profile (id, legal_name, former_legal_name, short_name, tan, tan_holder_name, tan_amendment_pending, signatory_name, signatory_designation)
     VALUES (1, 'Dhanam Investment and Finance Private Limited', 'Kiara Microcredit Private Limited', 'Dhanam', NULL, 'Kiara Microcredit Private Limited', TRUE, 'Saravana Suren S', 'CEO')
     ON CONFLICT (id) DO NOTHING`
  );

  // Branches (synthetic)
  const branches: [string, string, string, string][] = [
    ['HO', 'Head Office', 'Coimbatore', 'Coimbatore'],
    ['ERD', 'Erode', 'Erode', 'Erode'],
    ['SLM', 'Salem', 'Salem', 'Salem'],
  ];
  for (const [code, name, city, district] of branches) {
    await db.query(
      `INSERT INTO branches (code, name, city, district, state) VALUES ($1,$2,$3,$4,'Tamil Nadu')
       ON CONFLICT (code) DO NOTHING`,
      [code, name, city, district]
    );
  }

  // TDS rules
  await db.query(
    `INSERT INTO tds_rules (name, kind, rate_pct) VALUES ('Standard 10%', 'standard', 10)
     ON CONFLICT DO NOTHING`
  );

  // Admin user (super_admin)
  const adminHash = await bcrypt.hash(config.SEED_ADMIN_PASSWORD, 10);
  await db.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, is_active)
     VALUES ($1,$2,'System Administrator',$3,TRUE)
     ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
    [config.SEED_ADMIN_EMAIL, adminHash, ROLE_IDS['super_admin']]
  );

  // Synthetic demo staff — one per role, dev password 'Demo_1234'. NOT real people.
  if (config.NODE_ENV !== 'production') {
    const demoHash = await bcrypt.hash('Demo_1234', 10);
    const hoId = (await db.query<{ id: string }>('SELECT id FROM branches WHERE code = $1', ['HO'])).rows[0]!.id;
    const demo: [string, string, string][] = [
      ['admin@demo.local', 'Demo Admin', 'admin'],
      ['cxo@demo.local', 'Demo CXO', 'cxo'],
      ['ncd@demo.local', 'Demo NCD Manager', 'ncd_manager'],
      ['bm@demo.local', 'Demo Branch Manager', 'branch_manager'],
      ['staff@demo.local', 'Demo Branch Staff', 'branch_staff'],
      ['agent@demo.local', 'Demo Agent', 'agent'],
    ];
    for (const [email, name, role] of demo) {
      await db.query(
        `INSERT INTO users (email, password_hash, full_name, role_id, branch_id, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT (email) DO NOTHING`,
        [email, demoHash, name, ROLE_IDS[role], role === 'agent' ? null : hoId]
      );
    }
    // Link the demo agent to an agents row
    const agentUser = (await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', ['agent@demo.local'])).rows[0];
    if (agentUser) {
      await db.query(
        `INSERT INTO agents (user_id, agent_code, full_name, source) VALUES ($1,'AG-DEMO','Demo Agent','manual')
         ON CONFLICT (agent_code) DO NOTHING`,
        [agentUser.id]
      );
    }
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import('./index.js');
  const db = getDb();
  await seed(db);
  console.log('[seed] done');
  await db.close();
}
