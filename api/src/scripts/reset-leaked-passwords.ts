/**
 * reset-leaked-passwords — give a fresh temporary password to every login whose
 * password leaked, and make the holder replace it (owner 2026-10-08: "reset
 * those 11 passwords - on the next login ask the users to reset their own
 * password").
 *
 * WHY. odpulse's GET /api/users returned every account WITH its plaintext
 * password to anyone who asked, and 23.153.36.167 took it three times on
 * 2026-10-08. Eleven NCD logins used one of those two passwords — a CXO, an NCD
 * Manager, a Branch Manager, six branch staff and two agents.
 *
 * It does NOT work from a list of names. It tests each account's stored hash
 * against the leaked passwords and resets the ones that actually match, so it
 * stays right if someone is added, removed, or has already changed theirs. An
 * account that no longer matches is left alone.
 *
 * Each gets a different random password — one shared password would simply be
 * the next leak — and must_change_password, so the temporary one is good for
 * nothing but setting a real one.
 *
 * DRY-RUN (default) names who would be reset and writes nothing. --commit does
 * it and prints the temporary passwords ONCE, for the owner to hand out.
 *
 *   cd ~/ncd/api && set -a && . ./.env && set +a
 *   node dist/scripts/reset-leaked-passwords.js            # who matches
 *   node dist/scripts/reset-leaked-passwords.js --commit   # do it
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';

/** The passwords visible in odpulse's exposed user list. */
const LEAKED = ['admin123', 'Dhanam@123'];

/** Readable but unguessable: no l/I/0/O, so it survives being read aloud. */
function tempPassword(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = randomBytes(12);
  return `Dh-${[...b].map((n) => abc[n % abc.length]).join('')}`;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();

  const users = (await db.query<{ id: string; email: string; full_name: string; password_hash: string; role: string }>(
    `SELECT u.id, u.email, u.full_name, u.password_hash, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.password_hash IS NOT NULL AND u.is_active = TRUE
      ORDER BY u.id`)).rows;

  const hit: typeof users = [];
  for (const u of users) {
    for (const pw of LEAKED) {
      if (await bcrypt.compare(pw, u.password_hash)) { hit.push(u); break; }
    }
  }

  console.log(`[reset-leaked] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${users.length} active login(s) checked, ${hit.length} still using a leaked password`);
  for (const u of hit) console.log(`   #${u.id} ${u.full_name} <${u.email}> (${u.role})`);
  if (!hit.length) { console.log('[reset-leaked] nothing to do.'); return; }
  if (!commit) { console.log('\n[reset-leaked] dry-run only — re-run with --commit.'); return; }

  console.log('\nHand these out in person or by a channel the recipient controls.');
  console.log('Each person must set their own password at first sign-in; nothing else will work until they do.\n');
  for (const u of hit) {
    const pw = tempPassword();
    const hash = await bcrypt.hash(pw, 10);
    await db.withTx(async (tx) => {
      await tx.query(
        'UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = now() WHERE id = $2',
        [hash, u.id]);
      // Every existing session dies with the password: whoever else holds the
      // old one must not keep a live session.
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await writeAudit(tx, {
        actorId: null, action: 'user.password-reset-forced', entityType: 'users', entityId: Number(u.id),
        after: { reason: 'password exposed via the odpulse user list, 2026-10-08', must_change_password: true },
      });
    });
    console.log(`   ${u.full_name.padEnd(22)} <${u.email}>`.padEnd(62) + `  ${pw}`);
  }

  const left = (await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM users WHERE must_change_password = TRUE')).rows[0]!.n;
  console.log(`\n[reset-leaked] done — ${left} login(s) now waiting to set their own password.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
