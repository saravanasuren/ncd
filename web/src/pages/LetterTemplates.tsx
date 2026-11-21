import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';

/**
 * Redemption letter configuration (owner 2026-11-21).
 *
 * Which letter a date produces, and what it says, used to live in three
 * places: two settings and a constant shared with the bond certificates.
 * Moving the middle boundary meant a release. This screen is all four ranges
 * in one list, in date order, so the sequence is readable at a glance instead
 * of being three independent comparisons.
 *
 * NOTHING HERE IS DESTRUCTIVE. The four letters live in code; this screen
 * saves OVERRIDES on top of them, so Reset is always a way back and a range
 * that matches nothing falls through to the built-in letter rather than
 * printing blank.
 */

interface Template {
  slug: string;
  kind: 'request' | 'consent';
  label: string;
  valid_from: string | null;
  valid_to: string | null;
  legal_name: string;
  formerly: string;
  off_address: string[];
  corp_office: string[];
  body: Record<string, string>;
  sort_order: number;
  enabled: boolean;
  customised: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

const inp = 'px-2.5 py-1.5 text-xs border border-border-strong rounded outline-none focus:border-primary w-full';
const btn = 'text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40';
const go = 'text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover';

const pretty = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getUTCDate()).padStart(2, '0')}-${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${d.getUTCFullYear()}`;
};

/** "from the beginning" / "18-Aug-2025 to 28-Sep-2026" / "from 01-Nov-2026" */
function rangeLabel(t: Template): string {
  const a = pretty(t.valid_from), b = pretty(t.valid_to);
  if (!a && !b) return 'every date';
  if (!a) return `up to ${b}`;
  if (!b) return `from ${a}`;
  return `${a} to ${b}`;
}

export function LetterTemplatesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Template>>({});
  const [err, setErr] = useState<string | null>(null);
  const [checkDate, setCheckDate] = useState('');

  const q = useQuery({
    queryKey: ['letter-templates'],
    queryFn: () => api.get<{ templates: Template[]; warnings: string[] }>('/api/letter-templates'),
  });

  const check = useQuery({
    queryKey: ['letter-resolve', checkDate],
    queryFn: () => api.get<{ template: Template | null }>(`/api/letter-templates/resolve/${checkDate}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(checkDate),
  });

  const done = () => { setOpen(null); setDraft({}); setErr(null); qc.invalidateQueries({ queryKey: ['letter-templates'] }); qc.invalidateQueries({ queryKey: ['letter-resolve'] }); };
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : String(e));

  const save = useMutation({
    mutationFn: (v: { slug: string; patch: Partial<Template> }) =>
      api.put(`/api/letter-templates/${v.slug}`, v.patch),
    onSuccess: done, onError: fail,
  });
  const reset = useMutation({
    mutationFn: (slug: string) => api.del(`/api/letter-templates/${slug}`),
    onSuccess: done, onError: fail,
  });

  const templates = q.data?.templates ?? [];
  const warnings = q.data?.warnings ?? [];

  const edit = (t: Template) => { setOpen(t.slug); setErr(null); setDraft({ ...t }); };
  const field = <K extends keyof Template>(k: K, v: Template[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-lg font-semibold mb-1">Redemption letters</h1>
      <p className="text-xs text-text-muted mb-4 max-w-3xl">
        Which letter a redemption date produces, and what it says. The ranges run in date order and
        should join up with no gaps. Nothing here is permanent — every letter has a built-in version,
        and <b>Reset</b> puts it back exactly as it ships.
      </p>

      {warnings.length > 0 && (
        <div className="mb-4 rounded px-3 py-2 text-xs bg-[color:var(--warn-bg)] text-warn">
          {warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}
      {err && <div className="mb-4 border border-danger rounded px-3 py-2 text-xs text-danger">{err}</div>}

      {/* Answer the question the screen exists for, without uploading a sheet. */}
      <div className="mb-5 flex items-center gap-2 text-xs">
        <span className="text-text-muted">Which letter would a redemption dated</span>
        <input className={`${inp} w-36`} type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} />
        <span className="text-text-muted">produce?</span>
        {check.data && (
          <span className="font-medium">
            {check.data.template
              ? `${check.data.template.label}${check.data.template.legal_name ? ` — ${check.data.template.legal_name}` : ''}`
              : 'nothing configured — the built-in letter'}
          </span>
        )}
      </div>

      {q.isLoading && <div className="text-xs text-text-muted">Loading…</div>}

      <div className="space-y-2">
        {templates.map((t) => (
          <div key={t.slug} className="bg-surface border border-border rounded-lg shadow-card">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {t.label}
                  {!t.enabled && <span className="ml-2 text-xs text-text-muted">(off)</span>}
                  {t.customised && <span className="ml-2 text-xs text-primary">edited</span>}
                </div>
                <div className="text-xs text-text-muted truncate">
                  {rangeLabel(t)}
                  {t.legal_name ? ` · ${t.legal_name}` : ''}
                  {t.kind === 'consent' ? ' · consent letter' : ' · request letter'}
                </div>
              </div>
              <button className={btn} onClick={() => (open === t.slug ? setOpen(null) : edit(t))}>
                {open === t.slug ? 'Close' : 'Edit'}
              </button>
              {t.customised && (
                <button className={btn} disabled={reset.isPending}
                  title="Discard your changes and go back to the built-in letter"
                  onClick={() => reset.mutate(t.slug)}>Reset</button>
              )}
            </div>

            {open === t.slug && (
              <div className="border-t border-border px-4 py-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs">
                    <span className="text-text-muted">Applies from</span>
                    <input className={inp} type="date" value={draft.valid_from ?? ''}
                      onChange={(e) => field('valid_from', (e.target.value || null) as never)} />
                    <span className="text-text-muted">Blank means from the beginning.</span>
                  </label>
                  <label className="text-xs">
                    <span className="text-text-muted">Applies to (inclusive)</span>
                    <input className={inp} type="date" value={draft.valid_to ?? ''}
                      onChange={(e) => field('valid_to', (e.target.value || null) as never)} />
                    <span className="text-text-muted">Blank means open-ended.</span>
                  </label>
                </div>

                <label className="text-xs block">
                  <span className="text-text-muted">Name on this letter</span>
                  <input className={inp} value={draft.label ?? ''}
                    onChange={(e) => field('label', e.target.value as never)} />
                </label>

                <label className="text-xs block">
                  <span className="text-text-muted">Company named on the letter</span>
                  <input className={inp} value={draft.legal_name ?? ''}
                    onChange={(e) => field('legal_name', e.target.value as never)} />
                </label>

                <label className="text-xs block">
                  <span className="text-text-muted">"Formerly" line (blank to leave it off)</span>
                  <input className={inp} value={draft.formerly ?? ''}
                    onChange={(e) => field('formerly', e.target.value as never)} />
                </label>

                {draft.kind === 'request' && (
                  <>
                    <label className="text-xs block">
                      <span className="text-text-muted">Registered office — one line each</span>
                      <textarea className={`${inp} font-mono`} rows={3}
                        value={(draft.off_address ?? []).join('\n')}
                        onChange={(e) => field('off_address', e.target.value.split('\n') as never)} />
                    </label>
                    <label className="text-xs block">
                      <span className="text-text-muted">Corporate office — one line each, blank for none</span>
                      <textarea className={`${inp} font-mono`} rows={3}
                        value={(draft.corp_office ?? []).join('\n')}
                        onChange={(e) => field('corp_office', e.target.value.split('\n').filter((l, i, a) => l.trim() !== '' || i < a.length - 1) as never)} />
                    </label>
                  </>
                )}

                <label className="text-xs flex items-center gap-2">
                  <input type="checkbox" checked={draft.enabled ?? true}
                    onChange={(e) => field('enabled', e.target.checked as never)} />
                  <span>In use. Turn this off and dates in its range fall to the next letter that covers them.</span>
                </label>

                <div className="flex gap-2 pt-1">
                  <button className={go} disabled={save.isPending}
                    onClick={() => save.mutate({
                      slug: t.slug,
                      patch: {
                        label: draft.label, valid_from: draft.valid_from ?? null,
                        valid_to: draft.valid_to ?? null, legal_name: draft.legal_name,
                        formerly: draft.formerly,
                        off_address: (draft.off_address ?? []).filter((l) => l.trim() !== ''),
                        corp_office: (draft.corp_office ?? []).filter((l) => l.trim() !== ''),
                        enabled: draft.enabled,
                      },
                    })}>Save</button>
                  <button className={btn} onClick={() => setOpen(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
