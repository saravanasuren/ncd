/** Settings registry service (docs/07). */
import type { Db } from '../../db/types.js';
import { SETTINGS_CATALOG, type SettingDef } from '@new-wealth/shared';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

const CATALOG_BY_KEY = new Map<string, SettingDef>(SETTINGS_CATALOG.map((s) => [s.key, s]));

export interface SettingView extends SettingDef {
  value: unknown;
}

/** All settings, current value merged with catalog metadata, grouped. */
export async function listSettings(db: Db): Promise<Record<string, SettingView[]>> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings'
  );
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const grouped: Record<string, SettingView[]> = {};
  for (const def of SETTINGS_CATALOG) {
    const view: SettingView = { ...def, value: stored.has(def.key) ? stored.get(def.key) : def.default };
    (grouped[def.group] ??= []).push(view);
  }
  return grouped;
}

/** Raw key→value map (used by other modules to read config). */
export async function getSettingsMap(db: Db): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
  const map: Record<string, unknown> = {};
  for (const def of SETTINGS_CATALOG) map[def.key] = def.default;
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function canEdit(def: SettingDef, role: string): boolean {
  if (role === 'super_admin') return true;
  if (def.editableBy === 'super_admin') return false;
  if (def.editableBy === 'admin') return role === 'admin';
  if (def.editableBy === 'workflow') return role === 'admin' || role === 'ncd_manager';
  return false;
}

function validateValue(def: SettingDef, value: unknown): void {
  switch (def.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw errors.badRequest('Expected a number');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw errors.badRequest('Expected a boolean');
      break;
    case 'string':
    case 'date':
      if (typeof value !== 'string') throw errors.badRequest('Expected a string');
      break;
    case 'enum':
      if (typeof value !== 'string' || !(def.options ?? []).includes(value))
        throw errors.badRequest(`Must be one of: ${(def.options ?? []).join(', ')}`);
      break;
    case 'rate': {
      const v = value as { mode?: string; value?: unknown };
      if (!v || (v.mode !== 'pct' && v.mode !== 'flat') || typeof v.value !== 'number')
        throw errors.badRequest('Expected { mode: "pct"|"flat", value: number }');
      break;
    }
    case 'list':
      if (!Array.isArray(value)) throw errors.badRequest('Expected a list');
      break;
    case 'json':
      break;
  }
}

export async function updateSetting(
  db: Db,
  actor: AuthUser,
  key: string,
  value: unknown
): Promise<SettingView> {
  const def = CATALOG_BY_KEY.get(key);
  if (!def) throw errors.notFound('Unknown setting');
  if (!canEdit(def, actor.role)) throw errors.forbidden('Not allowed to edit this setting');
  validateValue(def, value);

  return db.withTx(async (tx) => {
    const prev = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
    const before = prev.rows[0]?.value ?? def.default;
    await tx.query(
      `INSERT INTO app_settings (key, value, group_name, label, description, editable_by, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $7, updated_at = now()`,
      [key, JSON.stringify(value), def.group, def.label, def.description, def.editableBy, actor.id]
    );
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'setting.update',
      entityType: 'app_settings',
      entityId: key,
      before,
      after: value,
    });
    return { ...def, value };
  });
}
