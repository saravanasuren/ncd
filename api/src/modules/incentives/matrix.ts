/** Read the incentive matrix from settings (docs/07). Falls back to the
 * production defaults so pre-seed DBs still work. */
import type { Db } from '../../db/types.js';
import { DEFAULT_MATRIX, MATRIX_SETTING_KEYS, type IncentiveMatrix, type RateSpec } from '../../lib/incentive.js';
import { getSettingsMap } from '../settings/service.js';

function asRate(v: unknown, fallback: RateSpec): RateSpec {
  const r = v as { mode?: string; value?: unknown } | undefined;
  if (r && (r.mode === 'pct' || r.mode === 'flat') && typeof r.value === 'number') return { mode: r.mode, value: r.value };
  return fallback;
}

export async function getMatrix(db: Db): Promise<IncentiveMatrix> {
  const s = await getSettingsMap(db);
  return {
    selfSourced: asRate(s[MATRIX_SETTING_KEYS.selfSourced], DEFAULT_MATRIX.selfSourced),
    existingWithReferrer: asRate(s[MATRIX_SETTING_KEYS.existingWithReferrer], DEFAULT_MATRIX.existingWithReferrer),
    newWithReferrer: asRate(s[MATRIX_SETTING_KEYS.newWithReferrer], DEFAULT_MATRIX.newWithReferrer),
    referrerNewCustomer: asRate(s[MATRIX_SETTING_KEYS.referrerNewCustomer], DEFAULT_MATRIX.referrerNewCustomer),
    referrerExistingCustomer: asRate(s[MATRIX_SETTING_KEYS.referrerExistingCustomer], DEFAULT_MATRIX.referrerExistingCustomer),
  };
}
