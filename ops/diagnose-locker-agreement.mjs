#!/usr/bin/env node
/**
 * diagnose-locker-agreement — where does ONE locker agreement's signed PDF fail?
 *
 * STRICTLY READ-ONLY. It runs SELECTs, reads a file's first bytes, and makes GET
 * requests to Digio. It writes no database row, saves no file, calls no
 * completion path, and prints no credential.
 *
 *   cd ~/ncd/api
 *   set -a && . ./.env && set +a
 *   node ../ops/diagnose-locker-agreement.mjs <lockerhub_application_id>
 *
 * It answers, for that agreement, in order:
 *   1. What the locker_agreement_signings row(s) say — status, method and the
 *      saved signed_doc_path.
 *   2. Whether the file that path names EXISTS in the directory the running
 *      service reads (FILE_STORAGE_DIR from its systemd unit), and in the other
 *      places a shell script would have written it (<cwd>/data/uploads).
 *   3. Which directory the download reads, so "stored here, read there" is a
 *      fact and not a theory.
 *   4. The Digio request id(s) the fetch uses, what Digio says about each RIGHT
 *      NOW, and what its download endpoint actually returns (status, content
 *      type, first bytes) — without saving it.
 * and ends with one FAILURE POINT line.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { resolve, sep, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const head = (path) => {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(8); const n = readSync(fd, b, 0, 8, 0); return b.subarray(0, n).toString('latin1'); }
  finally { closeSync(fd); }
};

/** Is `rel` inside `root`, and if so is the file there? */
export function locate(root, rel) {
  const base = resolve(root);
  const full = resolve(base, rel);
  if (!full.startsWith(base + sep)) return { root, exists: false, note: 'path escapes this directory' };
  if (!existsSync(full)) return { root, full, exists: false };
  const st = statSync(full);
  return { root, full, exists: true, bytes: st.size, magic: head(full) };
}

/** Files in <root>/<subdir> that look like this signing's, whatever their random prefix. */
function lookalikes(root, rel, signingId) {
  try {
    const dir = resolve(root, dirname(rel));
    return readdirSync(dir).filter((f) => new RegExp(`-locker-agreement-(signed|final)-${signingId}\\.pdf$`).test(f)).map((f) => join(dir, f));
  } catch { return []; }
}

async function digioGet(cfg, path) {
  const auth = Buffer.from(`${cfg.id}:${cfg.secret}`).toString('base64');
  try {
    const r = await fetch(cfg.base + path, { headers: { Authorization: 'Basic ' + auth }, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
    return {
      status: r.status, type: r.headers.get('content-type'), bytes: buf.length, isPdf,
      // never print a whole body, and never a header
      body: isPdf ? null : buf.subarray(0, 240).toString('utf8').replace(/\s+/g, ' ').trim(),
      json: !isPdf && (r.headers.get('content-type') ?? '').includes('json') ? safeJson(buf.toString('utf8')) : null,
    };
  } catch (e) { return { status: null, error: e.message }; }
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * @param {{ db: { query: Function }, appId: string, serviceDir: string, otherDirs?: string[],
 *           digio?: { base: string, id: string, secret: string } | null }} p
 */
export async function diagnose({ db, appId: given, serviceDir, otherDirs = [], digio = null }) {
  const out = [];
  const say = (s = '') => out.push(s);
  let appId = String(given).trim();
  const result = { appId, failurePoint: null, signings: [], sessions: [] };

  // "APP-2026-01312" is the number people SEE; every route and table is keyed on
  // LockerHub's internal id ("mu5izyh19z2ssnr", the ?application_id= in the URL).
  if (/^APP-/i.test(appId)) {
    const hit = (await db.query('SELECT lockerhub_application_id FROM locker_applications WHERE application_no = $1', [appId])).rows;
    if (hit.length === 1) {
      say(`${appId} is the display number; its LockerHub application id is ${hit[0].lockerhub_application_id}`);
      appId = hit[0].lockerhub_application_id;
      result.appId = appId;
    } else {
      say(`${appId} looks like a display number, but ${hit.length ? `${hit.length} applications share it` : "NCD's index has no application with that number (it fills in when the page is opened or refreshed)"}.`);
      say('Use the id in the address bar instead:  …/locker-enrollment?application_id=<THIS>');
      result.failurePoint = 'NEEDS-ID: re-run with the application_id from the URL, not the APP- number.';
      say(''); say(`FAILURE POINT: ${result.failurePoint}`);
      return { ...result, text: out.join('\n') };
    }
  }

  say(`Agreement ${appId}`);
  say(`The service reads files from: ${serviceDir}`);
  say('');

  // 1 — the record
  const signings = (await db.query(
    `SELECT id, status, method, signed_doc_path, signed_doc_mime, signed_doc_filename, signed_doc_position,
            signed_at, esign_reference, created_at
       FROM locker_agreement_signings WHERE lockerhub_application_id = $1 ORDER BY id`, [appId])).rows;
  say(`1. locker_agreement_signings — ${signings.length} row(s)`);
  if (!signings.length) {
    say('   none. There is no signing record for this id (wrong id, or a LockerHub-only agreement).');
    result.failurePoint = 'NO-RECORD: NCD has no signing row for this application id.';
    say(''); say(`FAILURE POINT: ${result.failurePoint}`);
    return { ...result, text: out.join('\n') };
  }
  for (const s of signings) {
    say(`   #${s.id}  status=${s.status}  method=${s.method}  position=${s.signed_doc_position ?? '-'}  signed_at=${s.signed_at ?? '-'}`);
    say(`        signed_doc_path=${s.signed_doc_path ?? 'NULL'}  mime=${s.signed_doc_mime ?? 'NULL'}  filename=${s.signed_doc_filename ?? 'NULL'}`);
    say(`        esign_reference=${s.esign_reference ?? 'NULL'}`);
  }
  // the row the download reads: latest with a path (getSignedDocument), else the live one
  const live = [...signings].reverse().find((s) => s.status !== 'Cancelled' && s.status !== 'Rejected') ?? signings[signings.length - 1];
  const withPath = [...signings].reverse().find((s) => s.signed_doc_path);
  const target = withPath ?? live;
  result.signings = signings;

  // 2 + 3 — the file, and who reads where
  say('');
  say('2. Is the file there?');
  let fileVerdict;
  if (!target.signed_doc_path) {
    say('   signed_doc_path is NULL — no file reference was ever saved for this agreement.');
    fileVerdict = 'NO-REFERENCE';
  } else {
    const roots = [{ label: 'SERVICE dir (FILE_STORAGE_DIR)', root: serviceDir }, ...otherDirs.map((d) => ({ label: 'script default (<cwd>/data/uploads)', root: d }))];
    const seen = new Set();
    const hits = [];
    for (const r of roots) {
      const key = resolve(r.root); if (seen.has(key)) continue; seen.add(key);
      const f = locate(r.root, target.signed_doc_path);
      say(`   ${r.label}: ${r.root}`);
      if (f.exists) { say(`        FOUND  ${f.bytes} bytes, starts ${JSON.stringify(f.magic)}${f.magic.startsWith('%PDF-') ? '' : '  <-- NOT a PDF'}`); hits.push({ ...r, ...f }); }
      else {
        say(`        not found${f.note ? ` (${f.note})` : ''}`);
        const like = lookalikes(r.root, target.signed_doc_path, target.id);
        if (like.length) say(`        but similarly-named file(s) here: ${like.join(', ')}`);
      }
    }
    say('');
    say('3. Which directory does the download read?');
    say(`   The deployed download reads ONLY: ${serviceDir}`);
    const inService = hits.find((h) => resolve(h.root) === resolve(serviceDir));
    const elsewhere = hits.find((h) => resolve(h.root) !== resolve(serviceDir));
    if (inService) fileVerdict = inService.magic.startsWith('%PDF-') ? 'FILE-OK' : 'FILE-NOT-PDF';
    else if (elsewhere) fileVerdict = 'MISPLACED';
    else fileVerdict = 'FILE-MISSING';
    say(`   -> ${fileVerdict === 'FILE-OK' ? 'the file is in the directory the service reads.'
      : fileVerdict === 'MISPLACED' ? `the file exists, but in ${elsewhere.root} — NOT where the service reads.`
      : fileVerdict === 'FILE-NOT-PDF' ? 'the file is where the service reads it, but it is not a PDF.'
      : 'the reference is saved but the file is in none of these directories.'}`);
  }

  // 4 — Digio
  say('');
  say('4. Digio');
  const sessions = (await db.query(
    `SELECT id, locker_agreement_signing_id, document_type, signer_position, status, digio_request_id, signed_at, created_at
       FROM digio_signing_sessions WHERE locker_agreement_signing_id = ANY($1::bigint[]) ORDER BY id`,
    [signings.map((s) => Number(s.id))])).rows;
  result.sessions = sessions;
  if (!sessions.length) say('   no Digio sessions are linked to this agreement (a LockerHub-signed or synced row).');
  const probes = [];
  for (const s of sessions) {
    say(`   session #${s.id}  type=${s.document_type}  signer=${s.signer_position ?? '-'}  NCD status=${s.status}  digio_request_id=${s.digio_request_id ?? 'NULL'}`);
    if (!digio) { say('        (Digio credentials not available — live checks skipped)'); continue; }
    if (!s.digio_request_id) { say('        no request id to ask Digio about'); continue; }
    const st = await digioGet(digio, `/v2/client/document/${encodeURIComponent(s.digio_request_id)}`);
    const agreementStatus = st.json?.agreement_status ?? st.json?.status ?? null;
    say(`        Digio status  : HTTP ${st.status ?? 'ERR'}${st.error ? ` (${st.error})` : ''}  agreement_status=${agreementStatus ?? '?'}${st.status !== 200 && st.body ? `  ${st.body}` : ''}`);
    const dl = await digioGet(digio, `/v2/client/document/download?document_id=${encodeURIComponent(s.digio_request_id)}`);
    say(`        Digio download: HTTP ${dl.status ?? 'ERR'}${dl.error ? ` (${dl.error})` : ''}  content-type=${dl.type ?? '-'}  ${dl.bytes ?? 0} bytes  ${dl.isPdf ? 'IS A PDF' : `NOT a PDF${dl.body ? ` — starts: ${dl.body}` : ''}`}`);
    probes.push({ session: s, status: st, agreementStatus, download: dl });
  }
  result.probes = probes;

  // the verdict
  say('');
  const goodDownload = probes.find((p) => p.download.status === 200 && p.download.isPdf);
  const badDownload = probes.find((p) => !(p.download.status === 200 && p.download.isPdf));
  const unrecorded = sessions.length > 0 && !sessions.some((s) => s.status === 'signed');
  let fp;
  if (fileVerdict === 'MISPLACED') fp = 'STORED IN THE WRONG PLACE — the reference is saved and the file exists, but not in the directory the service reads.';
  else if (fileVerdict === 'FILE-OK') fp = 'THE FILE IS WHERE THE SERVICE READS IT — storage is not the failure; look at the request path (permissions, or the row the download picks).';
  else if (fileVerdict === 'FILE-NOT-PDF') fp = 'THE STORED FILE IS NOT A PDF — a bad download was saved as the signed copy.';
  else if (unrecorded) fp = `NO SIGNATURE RECORDED — no Digio session is marked signed in NCD${goodDownload ? '; Digio DOES hand over a PDF, so the completion was never recorded' : ''}.`;
  else if (fileVerdict === 'FILE-MISSING' && goodDownload) fp = 'REFERENCE SAVED, FILE MISSING EVERYWHERE — but Digio hands the PDF over now, so a re-fetch will recover it.';
  else if (fileVerdict === 'FILE-MISSING' || fileVerdict === 'NO-REFERENCE') {
    fp = badDownload
      ? `THE FILE WAS NEVER OBTAINED — Digio's download answers HTTP ${badDownload.download.status ?? 'ERR'}${badDownload.download.body ? ` (${badDownload.download.body})` : ''}. That call is what has to be fixed.`
      : 'THE FILE WAS NEVER OBTAINED and there was no Digio session to ask.';
  } else fp = 'undetermined';
  result.failurePoint = fp;
  say(`FAILURE POINT: ${fp}`);
  return { ...result, text: out.join('\n') };
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const appId = process.argv[2];
  if (!appId) { console.error('usage: node ../ops/diagnose-locker-agreement.mjs <lockerhub_application_id>   (run from ~/ncd/api)'); process.exit(2); }
  const dist = (p) => import(pathToFileURL(resolve('dist', p)).href);
  const { loadSecretsFromSsm } = await dist('secrets.js');
  await loadSecretsFromSsm();
  const { config } = await dist('config.js');
  const { createDb } = await dist('db/index.js');

  // What the RUNNING SERVICE uses — from its systemd unit, not from this shell.
  let serviceDir = process.env.FILE_STORAGE_DIR ?? '';
  let workDir = process.cwd();
  try {
    const props = execFileSync('systemctl', ['show', 'dhanam-newwealth', '--property=Environment,WorkingDirectory'], { encoding: 'utf8' });
    const env = /^Environment=(.*)$/m.exec(props)?.[1] ?? '';
    const m = /(?:^|\s)FILE_STORAGE_DIR=(\S+)/.exec(env);
    if (m) serviceDir = m[1];
    const wd = /^WorkingDirectory=(.*)$/m.exec(props)?.[1];
    if (wd) workDir = wd;
  } catch { /* not on the box, or no systemctl — fall back to this shell's environment */ }
  if (!serviceDir) { console.error('Could not determine the service\'s FILE_STORAGE_DIR (no systemctl, none in this shell). Set FILE_STORAGE_DIR and re-run.'); process.exit(2); }

  const otherDirs = [...new Set([resolve(workDir, 'data', 'uploads'), resolve(process.cwd(), 'data', 'uploads')])];
  const digio = config.DIGIO_CLIENT_ID && config.DIGIO_CLIENT_SECRET
    ? { base: config.DIGIO_BASE || 'https://api.digio.in', id: config.DIGIO_CLIENT_ID, secret: config.DIGIO_CLIENT_SECRET } : null;
  const db = createDb();
  try {
    const r = await diagnose({ db, appId, serviceDir, otherDirs, digio });
    console.log(r.text);
  } finally { await db.close?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
