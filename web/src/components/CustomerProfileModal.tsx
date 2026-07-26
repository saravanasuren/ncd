import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

/** Full customer profile popup — opened by clicking a customer name in any
 * expandable drilldown (Segments, Dashboard drills). Shared so every entry
 * point shows the exact same thing, not a teaser. */
export function CustomerProfileModal({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-profile', id],
    queryFn: () => api.get<any>(`/api/customers/${id}`),
  });
  const c = data?.customer;
  const apps: any[] = data?.applications ?? [];
  const banks: any[] = data?.bankAccounts ?? [];
  const noms: any[] = data?.nominees ?? [];
  const joints: any[] = data?.jointHolders ?? [];
  const docs: any[] = data?.documents ?? [];
  const h3 = 'text-xs font-semibold text-text-label uppercase tracking-wide mb-2';
  const dmy = (v: unknown) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : null; };
  const age = (v: unknown) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return null;
    const d = new Date(`${m[0]}T00:00:00`), n = new Date(); let a = n.getFullYear() - d.getFullYear();
    if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
    return a >= 0 && a < 130 ? a : null; };
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <>
      <h3 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">{title}</h3>
      <dl className="grid grid-cols-[max-content_1fr] sm:grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1.5 text-sm bg-bg rounded p-3 mb-4">{children}</dl>
    </>
  );
  const invested = apps.reduce((s, a) => s + Number(a.amount ?? 0), 0);
  const live = apps.reduce((s, a) => s + Number(a.outstanding ?? 0), 0);
  const Field = ({ label, value }: { label: string; value: unknown }) => (
    <span className="contents">
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 font-medium break-words">{value == null || value === '' ? '—' : String(value)}</dd>
    </span>
  );

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border sticky top-0 bg-surface">
          <div>
            <h2 className="text-base font-bold m-0">{c?.full_name ?? name}</h2>
            <div className="text-xs text-text-muted mt-0.5 font-mono">{c?.customer_code ?? ''}</div>
          </div>
          <a href={`/app/customers/${id}`} target="_blank" rel="noreferrer"
             className="text-xs text-primary hover:underline ml-auto mr-3 no-underline">Open full record ↗</a>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none" aria-label="Close">✕</button>
        </div>
        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {isLoading ? <div className="text-sm text-text-muted">Loading…</div>
            : error ? <div className="text-sm text-danger">Couldn't load this customer (they may be outside your scope).</div>
            : (
            <>
              {/* The whole profile, not a teaser — this endpoint already returns
                  every field, bank accounts, demat, nominees and documents. */}
              <Section title="Personal">
                <Field label="Phone" value={c?.phone} />
                <Field label="Alt. phone" value={c?.phone_secondary} />
                <Field label="Email" value={c?.email} />
                <Field label="PAN" value={c?.pan} />
                <Field label="Aadhaar" value={c?.aadhaar_last ? `xxxx xxxx ${c.aadhaar_last}` : c?.aadhaar} />
                <Field label="Date of birth" value={dmy(c?.dob)} />
                <Field label="Age" value={age(c?.dob)} />
                <Field label="Gender" value={c?.gender} />
                <Field label="Father / spouse" value={c?.father_name} />
                <Field label="Occupation" value={c?.occupation} />
                <Field label="Category" value={c?.investor_category} />
                <Field label="NRI" value={c?.is_nri ? 'Yes' : 'No'} />
              </Section>
              <Section title="Address">
                <Field label="Address" value={c?.address} />
                <Field label="City" value={c?.city} />
                <Field label="District" value={c?.district} />
                <Field label="State" value={c?.state} />
                <Field label="Pincode" value={c?.pincode} />
              </Section>
              <Section title="Status & attribution">
                <Field label="KYC" value={c?.kyc_status} />
                <Field label="Record status" value={c?.creation_status} />
                <Field label="Active" value={c?.is_active ? 'Yes' : 'No'} />
                <Field label="Enrolled by" value={c?.enrolled_by_name
                  ? `${c.enrolled_by_name}${c.enrolled_by_kind === 'agent' ? ` (agent${c.enrolled_by_agent_code ? ' ' + c.enrolled_by_agent_code : ''})` : ' (staff)'}` : null} />
                <Field label="Referred by" value={c?.referred_by_text} />
                <Field label="CKYC no." value={c?.ckyc_number} />
                <Field label="TDS applicable" value={c?.tds_applicable === false ? 'No' : 'Yes'} />
                <Field label="Tax form" value={c?.tax_form} />
              </Section>
              {(c?.demat_dp_id || c?.demat_client_id) && (
                <Section title="Demat">
                  <Field label="Depository" value={c?.depository} />
                  <Field label="DP ID" value={c?.demat_dp_id} />
                  <Field label="Client ID" value={c?.demat_client_id} />
                </Section>
              )}
              {banks.length > 0 && (
                <>
                  <h3 className={h3}>Bank accounts</h3>
                  <div className="text-xs mb-4">
                    {banks.map((b: any) => (
                      <div key={b.id} className="flex flex-wrap gap-x-3 items-center border-b border-border/60 last:border-0 py-1.5">
                        <span className="font-mono">{b.account_number}</span>
                        <span className="font-mono text-text-muted">{b.ifsc}</span>
                        <span className="text-text-muted">{[b.bank_name, b.branch_name].filter(Boolean).join(' · ') || '—'}</span>
                        {b.holder_name && <span className="text-text-muted">{b.holder_name}</span>}
                        {b.is_active && <span className="rounded px-1.5 py-0.5 bg-[color:var(--success-bg)] text-success">Active</span>}
                        {b.penny_drop_status && <span className="rounded px-1.5 py-0.5 bg-bg">{b.penny_drop_status}</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {(noms.length > 0 || joints.length > 0) && (
                <>
                  <h3 className={h3}>Nominees &amp; joint holders</h3>
                  <div className="text-xs mb-4">
                    {noms.map((n: any) => (
                      <div key={`n${n.id}`} className="flex flex-wrap gap-x-3 border-b border-border/60 last:border-0 py-1.5">
                        <span className="font-medium">{n.full_name}</span>
                        <span className="text-text-muted">nominee{n.relationship ? ` · ${n.relationship}` : ''}{n.share_pct != null ? ` · ${n.share_pct}%` : ''}</span>
                      </div>
                    ))}
                    {joints.map((j: any) => (
                      <div key={`j${j.id}`} className="flex flex-wrap gap-x-3 border-b border-border/60 last:border-0 py-1.5">
                        <span className="font-medium">{j.full_name}</span>
                        <span className="text-text-muted">joint holder{j.relationship ? ` · ${j.relationship}` : ''}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {docs.length > 0 && (
                <>
                  <h3 className={h3}>KYC documents</h3>
                  <div className="text-xs mb-4 flex flex-wrap gap-x-4 gap-y-1">
                    {docs.map((d: any) => (
                      <span key={d.id} className="text-text-muted">{d.doc_type}{d.origin ? ` (${d.origin})` : ''}</span>
                    ))}
                  </div>
                </>
              )}
              <div className="flex gap-3 mb-3 text-sm">
                <div className="flex-1 bg-bg rounded p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Invested</div>
                  <div className="mono font-bold">{formatINR(invested)}</div>
                </div>
                <div className="flex-1 bg-bg rounded p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Outstanding</div>
                  <div className="mono font-bold text-primary">{formatINR(live)}</div>
                </div>
                <div className="flex-1 bg-bg rounded p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Investments</div>
                  <div className="mono font-bold">{apps.length}</div>
                </div>
              </div>
              <h3 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Investments</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-text-muted border-b border-border">
                    <th className="py-1 pr-3 font-medium">App no.</th>
                    <th className="py-1 pr-3 font-medium">Series</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Received</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id} className="border-b border-border/60 last:border-0">
                      <td className="py-1 pr-3 font-mono">{a.application_no}</td>
                      <td className="py-1 pr-3">{a.series_code}</td>
                      <td className="py-1 pr-3">{a.status}</td>
                      <td className="py-1 pr-3">{a.date_money_received ? String(a.date_money_received).slice(0, 10) : '—'}</td>
                      <td className="py-1 text-right mono">{formatINR(a.amount)}</td>
                    </tr>
                  ))}
                  {apps.length === 0 && <tr><td colSpan={5} className="py-2 text-center text-text-muted">No investments.</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
