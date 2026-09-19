import { useState } from 'react';
import { api, ApiError } from '../api/client.js';

/**
 * View / download a locker's signed agreement.
 *
 * Both buttons call the ONE server-side resolver
 * (GET /api/lockers/applications/:id/agreement/signed.pdf) — our own copy, one
 * fetched from Digio on demand, or LockerHub's PDF for an agreement they signed.
 * Nothing here decides which; there is deliberately no second download flow.
 *
 * It fetches rather than linking, for two reasons a bare <a href> cannot meet:
 * a failure lands HERE as a sentence a person can act on ("the signed copy has
 * not reached NCD yet…"), instead of a new tab of raw JSON; and an expired
 * 15-minute session is refreshed (api.blob) instead of failing silently.
 *
 * Authorization is the server's: lockers:enroll for the route, and a branch
 * user reaches only their own branch's agreements. This component only reports
 * what the server said.
 */
export function SignedAgreementActions({
  applicationId, fileStem, className,
}: { applicationId: string; fileStem: string; className: string }) {
  const [busy, setBusy] = useState<'view' | 'download' | null>(null);
  const [err, setErr] = useState('');

  const fetchPdf = () =>
    api.blob(`/api/lockers/applications/${encodeURIComponent(applicationId)}/agreement/signed.pdf`);

  async function view() {
    setErr(''); setBusy('view');
    // Open the tab NOW, inside the click, and point it at the file afterwards —
    // a window opened after an await can be blocked as a popup.
    const tab = window.open('', '_blank');
    try {
      const blob = await fetchPdf();
      const href = URL.createObjectURL(blob);
      if (tab) tab.location.href = href;
      else window.location.assign(href);
      // The tab needs the URL for as long as it is open; release it later.
      setTimeout(() => URL.revokeObjectURL(href), 10 * 60_000);
    } catch (e) {
      tab?.close();
      setErr(e instanceof ApiError ? e.message : 'Could not open the signed agreement.');
    } finally { setBusy(null); }
  }

  async function download() {
    setErr(''); setBusy('download');
    try {
      const blob = await fetchPdf();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = `${fileStem}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not download the signed agreement.');
    } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={className} disabled={busy !== null} onClick={view}>
          {busy === 'view' ? 'Opening…' : 'View signed agreement'}
        </button>
        <button type="button" className={className} disabled={busy !== null} onClick={download}>
          {busy === 'download' ? 'Downloading…' : '↓ Download'}
        </button>
      </div>
      {err && <div role="alert" className="text-xs text-danger">{err}</div>}
    </div>
  );
}
