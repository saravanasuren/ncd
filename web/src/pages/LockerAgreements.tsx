import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';

interface Row {
  application_id: string;
  customer_name: string | null;
  customer_code: string | null;
  signed_at: string | null;
  /** 'CustomerSigned' = not sent yet; 'AwaitingCEO' = a link is already out. */
  status: string;
  /** Signed, but we never got the file — needs fetching, not another link. */
  final_copy_pending: boolean;
}

/** The "Locker agreements" queue: agreements the customer has e-signed, awaiting
 *  the company's authorised signatory (the CEO) to counter-sign the SAME
 *  document. Signing here texts the CEO a Digio link. */
export function LockerAgreementsPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const q = useQuery({
    queryKey: ['locker-agreements-awaiting-ceo'],
    queryFn: () => api.get<{ rows: Row[] }>('/api/lockers/agreements/awaiting-ceo'),
  });
  const sign = useMutation({
    mutationFn: (applicationId: string) =>
      api.post<{ sign_url: string | null; stub: boolean }>(`/api/lockers/applications/${encodeURIComponent(applicationId)}/agreement/ceo-esign-initiate`, {}),
    onSuccess: (r) => {
      setMsg(r.sign_url
        ? 'Signing link sent to the authorised signatory’s phone — open it to sign now.'
        : 'e-Sign requested (test mode — no live Digio configured).');
      if (r.sign_url) window.open(r.sign_url, '_blank', 'noopener');
      qc.invalidateQueries({ queryKey: ['locker-agreements-awaiting-ceo'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Could not start the signing.'),
  });
  const fetchCopy = useMutation({
    mutationFn: (applicationId: string) =>
      api.post<{ status: string }>(`/api/lockers/applications/${encodeURIComponent(applicationId)}/agreement/fetch-signed-copy`, {}),
    onSuccess: (r) => {
      setMsg(r.status === 'Signed'
        ? 'Signed copy fetched — the agreement is now complete.'
        : 'Signed copy fetched.');
      qc.invalidateQueries({ queryKey: ['locker-agreements-awaiting-ceo'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Could not fetch the signed copy.'),
  });

  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';
  const rows = q.data?.rows ?? [];

  return (
    <div className="max-w-5xl">
      <h1 className="text-lg font-semibold mb-1">Locker agreements</h1>
      <p className="text-sm text-text-muted mb-4">
        Agreements the customer has e-signed, waiting for the authorised signatory to counter-sign the same
        document. Sending texts them a Digio link; once they sign, the agreement is complete. A row stays
        here while that link is out, so it can always be re-sent.
      </p>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}
      {q.isLoading && <div className="text-sm text-text-muted">Loading…</div>}
      {q.error && <div className="text-sm text-danger">Failed to load the queue.</div>}

      {!q.isLoading && rows.length === 0 && (
        <div className="text-sm text-text-muted">Nothing waiting — every customer-signed agreement is fully signed.</div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto bg-surface border border-border rounded-lg shadow-card">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>Customer</th>
                <th className={th}>Application</th>
                <th className={th}>Customer signed</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.application_id} className="border-b border-border last:border-0 hover:bg-bg">
                  <td className={`${td} font-medium`}>
                    {r.customer_name ?? '—'} {r.customer_code && <span className="text-text-muted font-mono text-xs">{r.customer_code}</span>}
                  </td>
                  <td className={`${td} font-mono text-xs`}>{r.application_id}</td>
                  <td className={`${td} text-text-muted`}>{r.signed_at ? String(r.signed_at).slice(0, 10) : '—'}</td>
                  <td className={`${td} text-xs text-text-muted`}>
                    {r.final_copy_pending ? 'Signed — copy not fetched'
                      : r.status === 'AwaitingCEO' ? 'Link sent to signatory'
                      : 'Awaiting signatory'}
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <a href={`/api/lockers/applications/${encodeURIComponent(r.application_id)}/agreement/signed.pdf`}
                      target="_blank" rel="noreferrer"
                      className="text-xs text-text-muted hover:text-primary mr-3">View signed</a>
                    {r.final_copy_pending ? (
                      <button disabled={fetchCopy.isPending}
                        onClick={() => { setMsg(''); fetchCopy.mutate(r.application_id); }}
                        className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
                        Fetch signed copy
                      </button>
                    ) : (
                      <button disabled={sign.isPending}
                        onClick={() => { setMsg(''); sign.mutate(r.application_id); }}
                        className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
                        {r.status === 'AwaitingCEO' ? 'Re-send link' : 'CEO e-Sign'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
