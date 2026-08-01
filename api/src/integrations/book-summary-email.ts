/**
 * Renders the daily book summary as an email (owner-approved design 2026-08-01).
 * Email-safe: table layout + inline styles only, so it holds up in Apple Mail,
 * Outlook and Gmail. Pure function of the structured report — the notification
 * queue stores the report as JSON and re-renders here at send time.
 */
import type { BookSummaryReport, SeriesLine, BroughtInLine } from './book-summary.js';

const GOLD = '#B4892B', GOLD_SOFT = '#F3E8CF', INK = '#1C1B18', MUT = '#8A8578',
  LINE = '#ECE9E1', BG = '#F5F3EE', CARD = '#FFFFFF', GREEN = '#1F8A54',
  RED = '#C0392B', RED_SOFT = '#FBECEA', BLUE = '#2C6E9B', BLUE_SOFT = '#E6F0F7';

const F = "-apple-system,Segoe UI,Roboto,Arial,sans-serif";

const inr = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const cr = (n: number) => (n / 1e7).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Cr';
const isRollover = (code: string) => /rollover/i.test(code);
const prettyName = (s: SeriesLine) => s.name.replace(/ Rollover/i, '').trim();
const initials = (nm: string) => nm.replace(/[()]/g, '').split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '–';
const niceDate = (ymd: string) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

function statCard(label: string, big: string, sub: string, accent = INK): string {
  return `
  <td width="33.33%" valign="top" style="padding:0 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${LINE};border-radius:12px;">
      <tr><td style="padding:16px 18px;">
        <div style="font:600 11px/1.4 ${F};letter-spacing:.06em;text-transform:uppercase;color:${MUT};">${label}</div>
        <div style="font:700 22px/1.25 ${F};color:${accent};margin-top:6px;">${big}</div>
        <div style="font:500 12px/1.4 ${F};color:${MUT};margin-top:3px;">${sub}</div>
      </td></tr>
    </table>
  </td>`;
}

function broughtInRows(list: BroughtInLine[]): string {
  if (!list.length) return `<tr><td style="padding:12px 4px;font:500 13px/1.4 ${F};color:${MUT};">No new investments today.</td></tr>`;
  return list.map((p) => {
    const tagColor = p.kind === 'agent' ? BLUE : p.kind === 'staff' ? GREEN : MUT;
    const tagBg = p.kind === 'agent' ? BLUE_SOFT : p.kind === 'staff' ? '#E7F5EE' : BG;
    return `
      <tr>
        <td width="34" valign="middle" style="padding:10px 0 10px 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" style="width:30px;height:30px;background:${GOLD_SOFT};border-radius:15px;font:700 11px/30px ${F};color:${GOLD};">${initials(p.name)}</td></tr></table>
        </td>
        <td valign="middle" style="padding:10px 10px;">
          <span style="font:700 13px/1.3 ${F};color:${INK};">${p.name}</span>
          <span style="font:600 9px/1 ${F};color:${tagColor};background:${tagBg};border-radius:4px;padding:2px 6px;margin-left:6px;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle;">${p.kind}</span>
        </td>
        <td align="right" valign="middle" style="padding:10px 4px 10px 0;white-space:nowrap;">
          <span style="font:700 13px/1.3 ${F};color:${INK};">${inr(p.amount)}</span>
          <span style="font:500 12px/1.3 ${F};color:${MUT};"> · ${p.count} app${p.count === 1 ? '' : 's'}</span>
        </td>
      </tr>`;
  }).join('');
}

function seriesRows(list: SeriesLine[]): string {
  const maxS = Math.max(1, ...list.map((s) => s.outstanding));
  return list.map((s, i) => {
    const red = s.redeemed_amount > 0;
    const pct = Math.max(4, Math.round((s.outstanding / maxS) * 100));
    const zebra = red ? RED_SOFT : (i % 2 ? '#FBFAF7' : CARD);
    const nameColor = red ? RED : INK;
    const amtColor = red ? RED : INK;
    const barColor = red ? RED : GOLD;
    return `<tr style="background:${zebra};">
      <td style="padding:11px 16px;border-bottom:1px solid ${LINE};">
        <span style="font:700 13px/1.3 ${F};color:${nameColor};">${prettyName(s)}</span>
        ${isRollover(s.code) ? `<span style="font:600 9px/1 ${F};color:${GOLD};background:${GOLD_SOFT};border-radius:4px;padding:2px 5px;margin-left:6px;vertical-align:middle;">ROLLOVER</span>` : ''}
        ${red ? `<div style="font:600 11px/1.3 ${F};color:${RED};margin-top:4px;">↓ Redeemed today ${inr(s.redeemed_amount)} · ${s.redeemed_count} app${s.redeemed_count === 1 ? '' : 's'}</div>` : ''}
      </td>
      <td align="center" style="padding:11px 8px;border-bottom:1px solid ${LINE};font:500 13px/1.3 ${F};color:${MUT};">${s.apps}</td>
      <td align="right" style="padding:11px 16px;border-bottom:1px solid ${LINE};white-space:nowrap;">
        <div style="font:700 13px/1.3 ${F};color:${amtColor};">${inr(s.outstanding)}</div>
        <div style="margin-top:5px;height:4px;background:${LINE};border-radius:3px;"><div style="height:4px;width:${pct}%;background:${barColor};border-radius:3px;"></div></div>
      </td>
    </tr>`;
  }).join('');
}

export function renderBookSummaryEmail(r: BookSummaryReport): { subject: string; text: string; html: string } {
  const nice = niceDate(r.report_date);
  const investedToday = r.physical.amount + r.funded.amount;
  const investedApps = r.physical.count + r.funded.count;
  const netKnown = r.net_change != null;
  const netUp = (r.net_change ?? 0) >= 0;
  const netStr = netKnown ? `${netUp ? '+' : '−'}${inr(Math.abs(r.net_change!)).slice(1)} vs yesterday` : 'First report';

  const subject = `Dhanam NCD daily book — ${nice} · ${inr(r.total_outstanding)} outstanding`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:${CARD};border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(28,27,24,.08);border:1px solid ${LINE};">

  <tr><td style="background:${INK};padding:22px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <div style="font:800 18px/1 ${F};letter-spacing:.18em;color:${GOLD};">DHANAM</div>
        <div style="font:500 12px/1.4 ${F};color:#B9B4A6;margin-top:5px;letter-spacing:.04em;">NCD · Daily Book Summary</div>
      </td>
      <td valign="middle" align="right">
        <div style="font:700 13px/1.3 ${F};color:#EFEADB;">${nice}</div>
        <div style="font:500 11px/1.3 ${F};color:#8F8B7E;margin-top:3px;">India · end of day</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:26px 28px 8px;">
    <div style="font:600 11px/1.4 ${F};letter-spacing:.08em;text-transform:uppercase;color:${MUT};">Total book outstanding</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr>
      <td valign="bottom"><span style="font:800 36px/1 ${F};color:${INK};">${inr(r.total_outstanding)}</span></td>
      <td valign="bottom" style="padding:0 0 4px 12px;"><span style="font:600 14px/1 ${F};color:${MUT};">${cr(r.total_outstanding)}</span></td>
    </tr></table>
    <div style="margin-top:12px;">
      <span style="display:inline-block;font:600 12px/1 ${F};color:${!netKnown ? MUT : netUp ? GREEN : RED};background:${!netKnown ? BG : netUp ? '#E7F5EE' : RED_SOFT};border-radius:20px;padding:6px 12px;">${netStr}</span>
      <span style="display:inline-block;font:600 12px/1 ${F};color:${INK};background:${BG};border-radius:20px;padding:6px 12px;margin-left:6px;">${r.active_apps} live investments</span>
    </div>
  </td></tr>

  <tr><td style="padding:20px 22px 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${statCard('Invested today', inr(investedToday), `${investedApps} application${investedApps === 1 ? '' : 's'}`, GREEN)}
      ${statCard('Physical · Online', `${r.physical.count} · ${r.funded.count}`, `${inr(r.physical.amount)} · ${inr(r.funded.amount)}`)}
      ${statCard('Redeemed today', inr(r.redemptions.amount), `${r.redemptions.count} application${r.redemptions.count === 1 ? '' : 's'}`, r.redemptions.amount > 0 ? RED : INK)}
    </tr></table>
  </td></tr>

  <tr><td style="padding:22px 28px 4px;">
    <div style="font:600 11px/1.4 ${F};letter-spacing:.08em;text-transform:uppercase;color:${MUT};">Brought in today${r.brought_in.length ? ` · ${r.brought_in.length} ${r.brought_in.length === 1 ? 'person' : 'people'}` : ''}</div>
  </td></tr>
  <tr><td style="padding:2px 28px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${LINE};border-radius:12px;">
      <tr><td style="padding:4px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${broughtInRows(r.brought_in)}</table></td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:22px 28px 8px;">
    <div style="font:600 11px/1.4 ${F};letter-spacing:.08em;text-transform:uppercase;color:${MUT};">Outstanding by series · ${r.by_series.length} active · newest first</div>
  </td></tr>
  <tr><td style="padding:0 20px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:12px;overflow:hidden;">
      <tr style="background:${BG};">
        <td style="padding:9px 16px;font:700 10px/1 ${F};letter-spacing:.06em;text-transform:uppercase;color:${MUT};">Series</td>
        <td align="center" style="padding:9px 8px;font:700 10px/1 ${F};letter-spacing:.06em;text-transform:uppercase;color:${MUT};">Apps</td>
        <td align="right" style="padding:9px 16px;font:700 10px/1 ${F};letter-spacing:.06em;text-transform:uppercase;color:${MUT};">Outstanding</td>
      </tr>
      ${seriesRows(r.by_series)}
      <tr style="background:${INK};">
        <td style="padding:12px 16px;font:800 13px/1 ${F};color:#EFEADB;">Total</td>
        <td align="center" style="padding:12px 8px;font:700 13px/1 ${F};color:#EFEADB;">${r.active_apps}</td>
        <td align="right" style="padding:12px 16px;font:800 13px/1 ${F};color:${GOLD};">${inr(r.total_outstanding)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:18px 28px 26px;">
    <div style="border-top:1px solid ${LINE};padding-top:16px;font:500 11px/1.6 ${F};color:${MUT};">
      Automated end-of-day report from the Dhanam NCD system.<br>
      Recipients are managed by the super-admin under Settings → Reports.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  // Plain-text fallback for non-HTML clients.
  const text = [
    `Dhanam NCD — Daily Book Summary (${nice})`,
    ``,
    `Total outstanding: ${inr(r.total_outstanding)} (${cr(r.total_outstanding)}) across ${r.active_apps} live investments`,
    netKnown ? `Net change: ${netStr}` : `Net change: first report`,
    ``,
    `Invested today: ${inr(investedToday)} (${investedApps} apps) — physical ${r.physical.count}/${inr(r.physical.amount)}, online ${r.funded.count}/${inr(r.funded.amount)}`,
    `Redeemed today: ${inr(r.redemptions.amount)} (${r.redemptions.count} apps)`,
    ``,
    `Brought in today:`,
    ...(r.brought_in.length ? r.brought_in.map((p) => `  ${p.name} (${p.kind}): ${inr(p.amount)} · ${p.count} app${p.count === 1 ? '' : 's'}`) : ['  No new investments today.']),
    ``,
    `Outstanding by series (newest first):`,
    ...r.by_series.map((s) => `  ${prettyName(s)}: ${s.apps} apps · ${inr(s.outstanding)}${s.redeemed_amount > 0 ? `  [Redeemed today ${inr(s.redeemed_amount)} · ${s.redeemed_count} app${s.redeemed_count === 1 ? '' : 's'}]` : ''}`),
  ].join('\n');

  return { subject, text, html };
}
