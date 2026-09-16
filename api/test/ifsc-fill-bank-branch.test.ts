/**
 * Bank and branch are filled from the IFSC when the caller did not send them.
 *
 * Both consoles look the IFSC up in the BROWSER and post the result — but only
 * if that lookup beat the save. It is a 400 ms debounce plus a call to an
 * external directory, so staff who type the IFSC and save quickly sent nothing,
 * the account was stored with both fields blank, and nothing ever filled them.
 * 74 accounts went in that way, 17 of them in one month, and the printed
 * application form shows the two fields empty.
 *
 * The rules that matter, all pinned below: a value the CALLER supplied always
 * wins, a directory that is down or does not know the code never blocks the
 * save, and nothing already stored is blanked.
 */
import { describe, it, expect } from 'vitest';
import { fillBankBranchFromIfsc } from '../src/integrations/ifsc.js';

/** The directory's shape, without the network. */
const directory = (body: Record<string, unknown> | null, ok = true) =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

const SBI = { BANK: 'State Bank of India', BRANCH: 'GANAPATHY', CITY: 'COIMBATORE', STATE: 'TAMIL NADU' };

describe('filling bank and branch from the IFSC', () => {
  it('fills all three when the caller sent none', async () => {
    const r = await fillBankBranchFromIfsc('SBIN0000831',
      { bank_name: undefined, branch_name: undefined, branch_city: undefined }, directory(SBI));
    expect(r.bank_name).toBe('State Bank of India');
    expect(r.branch_name).toBe('GANAPATHY');
    expect(r.branch_city).toBe('COIMBATORE');
  });

  it('never overrules what the caller supplied', async () => {
    const r = await fillBankBranchFromIfsc('SBIN0000831',
      { bank_name: 'SBI (as the customer writes it)', branch_name: undefined, branch_city: undefined }, directory(SBI));
    // Staff correcting a wrong directory entry must not be overwritten...
    expect(r.bank_name).toBe('SBI (as the customer writes it)');
    // ...while the field they left empty is still filled.
    expect(r.branch_name).toBe('GANAPATHY');
  });

  it('treats blanks and whitespace as missing, not as a supplied value', async () => {
    const r = await fillBankBranchFromIfsc('SBIN0000831',
      { bank_name: '', branch_name: '   ', branch_city: null }, directory(SBI));
    expect(r.bank_name).toBe('State Bank of India');
    expect(r.branch_name).toBe('GANAPATHY');
    expect(r.branch_city).toBe('COIMBATORE');
  });

  it('does not call the directory at all when nothing is missing', async () => {
    let called = 0;
    const counting = (async () => { called++; return { ok: true, json: async () => SBI }; }) as unknown as typeof fetch;
    const r = await fillBankBranchFromIfsc('SBIN0000831',
      { bank_name: 'A', branch_name: 'B', branch_city: 'C' }, counting);
    expect(called).toBe(0);
    expect(r).toEqual({ bank_name: 'A', branch_name: 'B', branch_city: 'C' });
  });

  it('hands the input straight back when the directory is down — saving must not depend on it', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const input = { bank_name: undefined, branch_name: undefined, branch_city: undefined };
    await expect(fillBankBranchFromIfsc('SBIN0000831', input, down)).resolves.toEqual(input);

    const notOk = await fillBankBranchFromIfsc('SBIN0000831', { bank_name: undefined }, directory(null, false));
    expect(notOk.bank_name).toBeUndefined();
  });

  it('leaves an unknown or malformed code alone rather than blanking anything', async () => {
    // Unknown to the directory (no BANK in the payload).
    const unknown = await fillBankBranchFromIfsc('ZZZZ0999999', { bank_name: undefined }, directory({}));
    expect(unknown.bank_name).toBeUndefined();
    // Not an IFSC at all — lookupIfsc refuses before any network call.
    let called = 0;
    const counting = (async () => { called++; return { ok: true, json: async () => SBI }; }) as unknown as typeof fetch;
    const bad = await fillBankBranchFromIfsc('not-an-ifsc', { bank_name: undefined }, counting);
    expect(called).toBe(0);
    expect(bad.bank_name).toBeUndefined();
  });
});
