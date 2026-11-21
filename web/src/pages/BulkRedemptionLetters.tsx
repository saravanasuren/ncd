import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

/**
 * Bulk Redemption Letter Generation.
 *
 * Upload a sheet, check the preview, generate one letter per row. The letters
 * are written BY the holder — they ask the Board to redeem and the holder signs
 * at the foot — so what comes out is for printing and signature, not for
 * issuing to anyone.
 *
 * Deliberately standalone: it starts no redemption, needs no approval and
 * changes nothing in the book. The customer-page redemption flow is untouched.
 */

interface PreviewRow {
  row_no: number;
  letter_date: string;
  letter_date_display: string;
  holder_name: string;
  series: string;
  debentures: string;
  amount: number;
  bank_name: string;
  account_holder_name: string;
  account_no: string;
  ifsc: string;
  customer_code: string;
  errors: string[];
  cautions: string[];
  addressed_to: string;
  /** Which document this row produces, from its date against the cut-off. */
  letter_kind: 'request' | 'consent';
  /** Consent particulars that will print empty — neither typed nor found. */
  blank_particulars: string[];
  filename: string;
}

interface Preview {
  rows: PreviewRow[];
  header_errors: string[];
  summary: {
    total: number; ready: number; with_errors: number; with_cautions: number;
    total_amount: number; by_company: { company: string; count: number }[];
  };
}

const fileToBase64 = (file: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = () => rej(new Error('Could not read the file'));
  r.readAsDataURL(file);
});

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke a tick later: Safari aborts the download if the URL dies first.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type Filter = 'all' | 'ready' | 'errors' | 'cautions';

export function BulkRedemptionLettersPage() {
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [payload, setPayload] = useState<{ filename: string; data_base64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setPreview(null); setPayload(null); setMsg(''); setErr(''); setFilter('all'); };

  const template = useMutation({
    mutationFn: async () => api.blob('/api/bulk-redemption-letters/template.xlsx'),
    onSuccess: (b) => saveBlob(b, 'redemption-letters-template.xlsx'),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not download the template'),
  });

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const body = { filename: f.name, data_base64: await fileToBase64(f) };
      setPayload(body);
      return api.post<Preview>('/api/bulk-redemption-letters/preview', body);
    },
    onSuccess: (p) => {
      setPreview(p);
      setErr('');
      setMsg(p.header_errors.length ? '' : `Read ${p.summary.total} record${p.summary.total === 1 ? '' : 's'}.`);
      setFilter(p.summary.with_errors ? 'errors' : 'all');
    },
    onError: (e) => {
      setPreview(null);
      setErr(e instanceof ApiError ? e.message : 'Could not read that file');
    },
  });

  const generate = useMutation({
    mutationFn: async () => {
      if (!payload) throw new Error('Upload a file first');
      return api.postBlob('/api/bulk-redemption-letters/generate', payload);
    },
    onSuccess: ({ blob, headers }) => {
      const made = headers.get('X-Letters-Generated') ?? '?';
      const failed = Number(headers.get('X-Letters-Failed') ?? 0);
      saveBlob(blob, 'redemption-letters.zip');
      setErr('');
      setMsg(`${made} letter${made === '1' ? '' : 's'} downloaded as redemption-letters.zip`
        + (failed ? ` — ${failed} record${failed === 1 ? '' : 's'} skipped, listed below.` : '.'));
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not generate the letters'),
  });

  const one = useMutation({
    mutationFn: async (row: PreviewRow) => {
      if (!payload) throw new Error('Upload a file first');
      const r = await api.postBlob('/api/bulk-redemption-letters/letter', { ...payload, row_no: row.row_no });
      return { blob: r.blob, filename: row.filename };
    },
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not generate that letter'),
  });

  const downloadErrors = () => {
    if (!preview) return;
    const bad = preview.rows.filter((r) => r.errors.length);
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ['Row,Name,What to fix']
      .concat(bad.map((r) => [r.row_no, esc(r.holder_name), esc(r.errors.join('; '))].join(',')))
      .join('\n');
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'redemption-letter-errors.csv');
  };

  const rows = preview?.rows ?? [];
  const shown = rows.filter((r) => filter === 'all' ? true
    : filter === 'ready' ? !r.errors.length
      : filter === 'errors' ? r.errors.length > 0
        : r.cautions.length > 0 && !r.errors.length);

  const s = preview?.summary;
  const blocked = !!preview?.header_errors.length;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Bulk Redemption Letter Generation</h1>
      <p className="text-sm text-text-muted mb-4 max-w-3xl">
        Produces one redemption request letter per row of a spreadsheet, ready to print and sign.
        The letter is the <strong>holder&apos;s</strong> request to the Board, so the customer signs it.
        This tool only makes documents — it does not start a redemption, does not need an approval
        and changes nothing in the book.
      </p>

      {/* ── Step 1: the template ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface p-4 mb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-medium">1. Start from the template</div>
            <div className="text-sm text-text-muted">
              Ten columns, one row per letter, with a tab explaining each one.
            </div>
          </div>
          <button onClick={() => template.mutate()} disabled={template.isPending}
            className="px-3 py-2 rounded-md border border-border hover:bg-bg text-sm whitespace-nowrap">
            {template.isPending ? 'Preparing…' : '⬇ Download template'}
          </button>
        </div>
      </div>

      {/* ── Step 2: upload ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface p-4 mb-3">
        <div className="font-medium mb-1">2. Upload the filled sheet</div>
        <div className="text-sm text-text-muted mb-3">.xlsx or .csv — nothing is generated until you check the preview.</div>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept=".xlsx,.csv" className="text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              reset();
              setFile(f ?? null);
              if (f) upload.mutate(f);
            }} />
          {upload.isPending && <span className="text-sm text-text-muted">Reading…</span>}
          {file && !upload.isPending && (
            <button className="text-sm text-primary hover:underline"
              onClick={() => { reset(); setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {err && <div className="mb-3 rounded-md bg-[color:var(--danger-bg)] text-danger px-3 py-2 text-sm">{err}</div>}
      {msg && <div className="mb-3 rounded-md bg-[color:var(--success-bg)] text-success px-3 py-2 text-sm">{msg}</div>}

      {blocked && (
        <div className="mb-3 rounded-md bg-[color:var(--danger-bg)] text-danger px-3 py-2 text-sm">
          <div className="font-medium mb-1">This file cannot be read:</div>
          <ul className="list-disc ml-5">
            {preview!.header_errors.map((h) => <li key={h}>{h}</li>)}
          </ul>
          <div className="mt-1">Start from the template above — the column names have to match.</div>
        </div>
      )}

      {/* ── Step 3: preview + generate ─────────────────────────────────────── */}
      {preview && !blocked && s && (
        <>
          <div className="rounded-lg border border-border bg-surface p-4 mb-3">
            <div className="font-medium mb-3">3. Check, then generate</div>

            <div className="flex flex-wrap gap-4 mb-3 text-sm">
              <Stat label="Records" value={String(s.total)} />
              <Stat label="Ready" value={String(s.ready)} tone={s.ready ? 'good' : undefined} />
              <Stat label="To fix" value={String(s.with_errors)} tone={s.with_errors ? 'bad' : undefined} />
              <Stat label="Worth a look" value={String(s.with_cautions)} tone={s.with_cautions ? 'warn' : undefined} />
              <Stat label="Total amount" value={formatINR(s.total_amount)} />
            </div>

            {/* Which company each batch is addressed to — a wrong date column shows up here first. */}
            <div className="text-sm mb-3">
              <span className="text-text-muted">Addressed to: </span>
              {s.by_company.map((c, i) => (
                <span key={c.company}>
                  {i > 0 && <span className="text-text-muted"> · </span>}
                  <strong>{c.company}</strong> <span className="text-text-muted">({c.count})</span>
                </span>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => generate.mutate()} disabled={generate.isPending || !s.ready}
                className="px-4 py-2 rounded-md bg-primary text-white text-sm disabled:opacity-50">
                {generate.isPending ? 'Generating…'
                  : `Generate ${s.ready} letter${s.ready === 1 ? '' : 's'}`}
              </button>
              {s.with_errors > 0 && (
                <button onClick={downloadErrors}
                  className="px-3 py-2 rounded-md border border-border hover:bg-bg text-sm">
                  ⬇ Error report ({s.with_errors})
                </button>
              )}
              {!s.ready && <span className="text-sm text-danger">Every record needs a fix first.</span>}
              {s.ready > 0 && s.with_errors > 0 && (
                <span className="text-sm text-text-muted">
                  The {s.with_errors} with errors will be skipped.
                </span>
              )}
            </div>
          </div>

          <div className="flex gap-1 mb-2 text-sm">
            {([
              ['all', `All (${s.total})`],
              ['ready', `Ready (${s.ready})`],
              ['errors', `To fix (${s.with_errors})`],
              ['cautions', `Worth a look (${s.with_cautions})`],
            ] as [Filter, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-md border ${filter === k
                  ? 'border-primary text-primary bg-[color:var(--primary-bg)]'
                  : 'border-border hover:bg-bg'}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-bg text-text-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Row</th>
                  <th className="text-left px-3 py-2 font-medium">Holder</th>
                  <th className="text-left px-3 py-2 font-medium">Letter date</th>
                  <th className="text-left px-3 py-2 font-medium">Letter</th>
                  <th className="text-left px-3 py-2 font-medium">Addressed to</th>
                  <th className="text-left px-3 py-2 font-medium">Series</th>
                  <th className="text-right px-3 py-2 font-medium">Debentures</th>
                  <th className="text-right px-3 py-2 font-medium">Amount</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.row_no} className="border-t border-border align-top">
                    <td className="px-3 py-2 text-text-muted">{r.row_no}</td>
                    <td className="px-3 py-2">
                      {r.holder_name || <span className="text-text-muted">—</span>}
                      {r.customer_code && <div className="text-xs text-text-muted">{r.customer_code}</div>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.letter_date_display || <span className="text-danger">—</span>}
                    </td>
                    {/* WHICH DOCUMENT, before anything is generated. A file
                        can mix the two, and the difference matters: one is a
                        request, the other waives the 2% premium and all
                        further claims. Nobody should find that out from the
                        zip. */}
                    <td className="px-3 py-2">
                      {r.letter_kind === 'consent' ? (
                        <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn whitespace-nowrap"
                          title={r.blank_particulars.length
                            ? `Consent for Premature Redemption. Printing blank: ${r.blank_particulars.join(', ')}`
                            : 'Consent for Premature Redemption — every particular filled'}>
                          Consent{r.blank_particulars.length ? ` · ${r.blank_particulars.length} blank` : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-text-muted whitespace-nowrap">Request</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.addressed_to}</td>
                    <td className="px-3 py-2">{r.series}</td>
                    <td className="px-3 py-2 text-right">{r.debentures}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {r.errors.length && !r.amount ? '—' : formatINR(r.amount)}
                    </td>
                    <td className="px-3 py-2">
                      {r.errors.length > 0 ? (
                        <ul className="text-danger list-disc ml-4">
                          {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      ) : r.cautions.length > 0 ? (
                        <ul className="text-warn list-disc ml-4">
                          {r.cautions.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      ) : <span className="text-success">Ready</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button disabled={!!r.errors.length || one.isPending}
                        onClick={() => one.mutate(r)}
                        className="text-primary hover:underline disabled:opacity-40 disabled:no-underline whitespace-nowrap">
                        ⬇ PDF
                      </button>
                    </td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-text-muted">Nothing in this view.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn' }) {
  const color = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warn' : '';
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
