/**
 * regenerate-acknowledgements — rebuild the stored Acknowledgement PDF for one
 * or more applications after the record behind it changed.
 *
 * The acknowledgement is a SNAPSHOT: activate.ts renders it once when the money
 * lands and stores the file (migration 027_document_snapshots). It does not
 * follow later corrections, so after a holder swap, a scheme change or a date
 * edit, the stored PDF still shows the old facts while every screen shows the
 * new ones. That gap is what this script closes.
 *
 * The superseded file is NOT deleted. saveBuffer writes a new randomly-named
 * file and only the DB pointer moves, so what was previously issued stays on
 * disk as a record of what the customer may already hold.
 *
 * Usage on the box (DATABASE_URL comes from SSM, as in ops/deploy.sh):
 *
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   export SSM_PARAMETERS_PATH=/dhanam/newwealth/ SSM_REGION=ap-south-1
 *   export FILE_STORAGE_DIR=/var/lib/dhanam-newwealth
 *   node dist/scripts/regenerate-acknowledgements.js APP-2026-001274 APP-2026-001275
 *   node dist/scripts/regenerate-acknowledgements.js APP-2026-001274 --commit
 *
 * FILE_STORAGE_DIR is the trap: it is set in the systemd unit, NOT in api/.env,
 * so an ad-hoc run without it silently writes the PDFs into ./data/uploads next
 * to wherever you happened to be standing, and the app serves 404s for files
 * that exist on disk. That has happened before (Digio, 2026-10-08), so this
 * refuses to run rather than let it happen again.
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { acknowledgmentPdf } from '../modules/reports/forms/acknowledgment.js';
import { saveBuffer } from '../lib/storage.js';

type Row = { id: string; application_no: string; customer: string; path: string | null; generated_at: string | null };

async function main(): Promise<void> {
  const appNos = process.argv.slice(2).filter((a) => a.startsWith('APP-'));
  const commit = process.argv.includes('--commit');
  if (!appNos.length) {
    console.error('Pass one or more application numbers, e.g. APP-2026-001274');
    process.exit(1);
  }

  // See the header. Without this the files land somewhere the app cannot serve.
  if (!process.env.FILE_STORAGE_DIR) {
    console.error('FILE_STORAGE_DIR is not set. On the box it must be /var/lib/dhanam-newwealth —');
    console.error('it lives in the systemd unit, not api/.env, so an ad-hoc run has to set it:');
    console.error('  export FILE_STORAGE_DIR=/var/lib/dhanam-newwealth');
    process.exit(1);
  }

  await loadSecretsFromSsm();
  const db = createDb();

  const rows = (await db.query<Row>(
    `SELECT a.id, a.application_no, c.full_name AS customer,
            a.acknowledgment_pdf_path AS path, a.acknowledgment_generated_at::text AS generated_at
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE a.application_no = ANY($1)
      ORDER BY a.application_no`, [appNos])).rows;

  const missing = appNos.filter((n) => !rows.some((r) => r.application_no === n));
  if (missing.length) { console.error(`No such application(s): ${missing.join(', ')}`); process.exit(1); }

  for (const r of rows) {
    console.log(`[ack] ${r.application_no} — ${r.customer}`);
    console.log(`      current: ${r.path ?? '(none)'}${r.generated_at ? `  generated ${r.generated_at.slice(0, 19)}` : ''}`);
  }

  if (!commit) {
    console.log(`\n[ack] dry-run — re-run with --commit to regenerate ${rows.length} acknowledgement(s).`);
    return;
  }

  let done = 0;
  for (const r of rows) {
    const id = Number(r.id);
    // Rendered from live data, so it picks up the corrected holder and scheme.
    const pdf = await acknowledgmentPdf(db, id);
    const { path } = saveBuffer('acknowledgments', `acknowledgment-${id}.pdf`, pdf);
    await db.query(
      'UPDATE applications SET acknowledgment_pdf_path = $1, acknowledgment_generated_at = now() WHERE id = $2',
      [path, id]);
    console.log(`[ack] ${r.application_no}: ${r.path ?? '(none)'}  ->  ${path}  (${pdf.length} bytes)`);
    done += 1;
  }
  console.log(`\n[ack] regenerated ${done} acknowledgement(s). The superseded files are left on disk.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
