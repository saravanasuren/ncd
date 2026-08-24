/**
 * WhatsApp template config resolver (owner 2026-08-25): Settings drive which
 * approved template each message uses, whether it is on, and which field feeds
 * each {{n}}. This pins the mapping — the wording itself stays in WappCloud.
 */
import { describe, it, expect } from 'vitest';
import { resolveWhatsapp } from '../src/modules/notifications/whatsappConfig.js';
import { whatsappSettingKey } from '@new-wealth/shared';

describe('resolveWhatsapp', () => {
  it('uses the registry defaults when nothing is stored', () => {
    const r = resolveWhatsapp({}, 'interest_paid',
      { name: 'Asha', amount: '3,058', month: 'August', date: '2026-08-28', application_no: 'APP-1' })!;
    expect(r.enabled).toBe(true);
    expect(r.name).toBe('ncd_interest_final');
    expect(r.variables).toEqual({ '1': 'Asha', '2': '3,058', '3': 'August', '4': '2026-08-28' });
  });

  it('honours a stored custom template name and a reordered variable mapping', () => {
    const settings = { [whatsappSettingKey('interest_paid')]: { template_name: 'ncd_int_v2', enabled: true, variables: ['amount', 'name'] } };
    const r = resolveWhatsapp(settings, 'interest_paid', { name: 'Asha', amount: '3,058' })!;
    expect(r.name).toBe('ncd_int_v2');
    expect(r.variables).toEqual({ '1': '3,058', '2': 'Asha' });   // {{1}}=amount, {{2}}=name
  });

  it('reports disabled when the type is turned off', () => {
    const settings = { [whatsappSettingKey('acknowledgment')]: { template_name: 'ncd_akn', enabled: false, variables: ['name'] } };
    expect(resolveWhatsapp(settings, 'acknowledgment', { name: 'X' })!.enabled).toBe(false);
  });

  it('attaches the PDF document header for the acknowledgement', () => {
    const r = resolveWhatsapp({}, 'acknowledgment', { name: 'X', documentUrl: 'https://x/y.pdf', documentName: 'Ack.pdf' })!;
    expect(r.document).toEqual({ url: 'https://x/y.pdf', filename: 'Ack.pdf' });
  });

  it('drops a mapped field that is not valid for the type, rather than sending junk', () => {
    const settings = { [whatsappSettingKey('portal_otp')]: { template_name: 'otp', enabled: true, variables: ['otp', 'name'] } };
    const r = resolveWhatsapp(settings, 'portal_otp', { otp: '123' })!;
    expect(r.variables).toEqual({ '1': '123' });   // 'name' is not a portal_otp field → skipped
  });

  it('returns null for a template that is not a WhatsApp type', () => {
    expect(resolveWhatsapp({}, 'password_reset_email', {})).toBeNull();
  });
});
