/**
 * Crash-alert emails must explain themselves (owner 2026-08-28, after receiving
 * "[NCD] Uncaught exception — terminating connection due to administrator
 * command" and having to ask what it meant: "explain it in the mail itself
 * clearly so that i understand it and will not ask u again").
 *
 * The bar is not "has some words". It is:
 *  · a recognised error says what happened in the owner's language, and whether
 *    it needs them;
 *  · an UNRECOGNISED error admits it does not know, rather than inventing a
 *    reassurance — a confident wrong diagnosis is worse than none, because it
 *    invites the wrong action;
 *  · no jargon leaks into the plain-English half.
 */
import { describe, it, expect } from 'vitest';
import { explainInPlainWords } from '../src/lib/alerts.js';

/** The words that made the original mail unreadable to a non-engineer. */
const JARGON = [
  'pg-protocol', 'parseErrorMessage', 'uncaughtException', 'stack', 'socket',
  'node_modules', 'TCP', 'ECONNREFUSED', 'promise', 'EventEmitter',
];

describe('crash alerts explain themselves', () => {
  it('the exact error the owner received is explained without jargon', () => {
    const e = explainInPlainWords(
      'error: terminating connection due to administrator command\n    at parseErrorMessage (/home/ubuntu/ncd/node_modules/pg-protocol/dist/parser.js:305:11)');
    // Says the database restarted, in plain words.
    expect(e.what.toLowerCase()).toContain('database was restarted');
    // Says it is routine and not a data problem — the two things the owner asked.
    expect(e.what.toLowerCase()).toMatch(/security updates|routine/);
    expect(e.action.toLowerCase()).toContain('nothing');
    for (const j of JARGON) {
      expect(`${e.what} ${e.action}`.toLowerCase()).not.toContain(j.toLowerCase());
    }
  });

  it('a database that is genuinely unreachable is NOT described as routine', () => {
    const e = explainInPlainWords('Error: connect ECONNREFUSED 127.0.0.1:5432');
    expect(e.what.toLowerCase()).toContain('could not reach the database');
    // This one must escalate — the opposite of the restart case.
    expect(e.action.toLowerCase()).toMatch(/now|engineer/);
    expect(e.action.toLowerCase()).not.toContain('normally nothing');
  });

  it('disk full says it will not fix itself', () => {
    const e = explainInPlainWords('Error: ENOSPC: no space left on device, write');
    expect(e.what.toLowerCase()).toContain('disk space');
    expect(e.action.toLowerCase()).toContain('does not recover on its own');
  });

  it('out of memory tells them to check the job that was running', () => {
    const e = explainInPlainWords('FATAL ERROR: JavaScript heap out of memory');
    expect(e.what.toLowerCase()).toContain('ran out of memory');
    expect(e.action.toLowerCase()).toMatch(/payout|report/);
  });

  it('an UNRECOGNISED error admits it does not know, and never reassures', () => {
    const e = explainInPlainWords('TypeError: Cannot read properties of undefined (reading "foo")');
    expect(e.what.toLowerCase()).toMatch(/not a pattern|no plain-english explanation/);
    // The dangerous failure mode: telling the owner nothing is wrong when we
    // have no idea. It must route to a human instead.
    expect(e.action.toLowerCase()).toContain('engineer');
    expect(e.action.toLowerCase()).not.toMatch(/nothing|no action|safe to ignore/);
  });

  it('every branch returns something usable — never blank', () => {
    for (const sample of [
      'terminating connection due to administrator command',
      'connect ECONNREFUSED', 'sorry, too many clients already',
      'ENOSPC: no space left on device', 'JavaScript heap out of memory',
      'something nobody has ever seen', '',
    ]) {
      const e = explainInPlainWords(sample);
      expect(e.what.trim().length).toBeGreaterThan(30);
      expect(e.action.trim().length).toBeGreaterThan(20);
    }
  });
});
