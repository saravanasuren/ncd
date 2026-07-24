/**
 * LockerHub façade — agent endpoints (docs/08 §1):
 *
 *   POST /agents/from-lockerhub          self-signup mirror (idempotent on
 *                                        lockerhub_user_id; 409 contract for
 *                                        phone/email collisions)
 *   GET  /agents/email-check?email=      legacy read-only routing check
 *   POST /agents/email-check             { email } → { exists, is_agent }
 *   POST /agents/authenticate            { identifier, password } → agent identity
 *   POST /agents/issue-webview-session   X-Acting-As-Agent header → BOTH handoff
 *                                        shapes: session_code+establish_url AND
 *                                        legacy token+bridge_url (roll-forward/
 *                                        back design, docs/08 §1)
 *
 * The wealth_user_id LockerHub stores (and echoes back via X-Acting-As-Agent)
 * is ncd's agents.id.
 */
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../../db/index.js';
import { config } from '../../config.js';
import { asyncHandler } from '../../middleware/error.js';
import { writeAudit } from '../../lib/audit.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';
import { enqueue } from '../notifications/service.js';
import { activeAgents, proposeAgent } from '../agents/service.js';
import { maskEmail, maskPhone, normalisePhone, phoneMatchSql, signToken, verifyToken } from './shared.js';

// On agent-registration approval: activate the agent + notify.
registerOnFinalApprove('agent_registration', async (tx, req) => {
  if (!req.entity_id) return;
  await tx.query("UPDATE agents SET is_active = TRUE, commission_status = 'Approved' WHERE id = $1", [Number(req.entity_id)]);
  const agent = (await tx.query<{ email: string | null; phone: string | null; full_name: string; agent_code: string }>(
    'SELECT email, phone, full_name, agent_code FROM agents WHERE id = $1', [Number(req.entity_id)])).rows[0];
  const to = agent?.email ?? agent?.phone;
  if (to && agent) await enqueue(tx, { channel: agent.email ? 'email' : 'sms', template: 'agent_registration_approved', to, payload: { agentName: agent.full_name, agentCode: agent.agent_code } });
});

export const agentsRouter = Router();

// ─── B24 · staff "add agent" flows ───────────────────────────────────────
// Active agents for a picker.
agentsRouter.get('/agents/active', asyncHandler(async (req, res) => {
  const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : 100;
  res.json({ agents: await activeAgents(getDb(), limit) });
}));

// Propose a new agent → PendingApproval + agent_registration approval (idempotent by name).
agentsRouter.post('/agents/propose', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const fullName = String(b.full_name ?? '').trim();
  if (!fullName) return res.status(400).json({ error: 'full_name required' });
  const r = await proposeAgent(getDb(), { full_name: fullName, phone: b.phone ?? null, email: b.email ?? null, proposed_by: b.proposed_by ?? null });
  res.status(r.created ? 201 : 200).json({ success: true, ...r });
}));

// ─── Agent self-signup mirror ────────────────────────────────────────────
agentsRouter.post('/agents/from-lockerhub', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const fullName = String(b.full_name ?? '').trim();
  const phone = normalisePhone(b.phone ?? '');
  const email = b.email ? String(b.email).trim().toLowerCase() : null;
  const lhUid = b.lockerhub_user_id;

  if (lhUid !== undefined && lhUid !== null && !(Number.isInteger(lhUid) && lhUid > 0)) {
    return res.status(400).json({ error: 'lockerhub_user_id must be a positive integer' });
  }
  if (!fullName) return res.status(400).json({ error: 'full_name required' });
  if (phone.length < 10) return res.status(400).json({ error: 'phone required (10 digits)' });

  const db = getDb();
  const out = await db.withTx(async (tx) => {
    // Idempotency: the mirror keys off lockerhub_user_id.
    if (lhUid) {
      const same = (await tx.query<{ id: string }>('SELECT id FROM agents WHERE lockerhub_user_id = $1 AND deleted_at IS NULL', [lhUid])).rows[0];
      if (same) {
        const id = Number(same.id);
        return { status: 200 as const, body: { ok: true, wealth_user_id: id, id, role: 'agent', already_existed: true, agent_id: id, status: 'exists' } };
      }
    }

    // Phone collision with an existing agent.
    const byPhone = (await tx.query<{ id: string; lockerhub_user_id: string | null; phone: string | null }>(
      `SELECT id, lockerhub_user_id, phone FROM agents
        WHERE deleted_at IS NULL AND ${phoneMatchSql('phone')} = $1 ORDER BY id ASC LIMIT 1`, [phone]
    )).rows[0];
    if (byPhone) {
      const id = Number(byPhone.id);
      if (byPhone.lockerhub_user_id == null || Number(byPhone.lockerhub_user_id) === Number(lhUid ?? NaN)) {
        // Same person re-sent (older mirrors carried no lockerhub_user_id) —
        // adopt the id and answer idempotently.
        if (lhUid && byPhone.lockerhub_user_id == null) {
          await tx.query('UPDATE agents SET lockerhub_user_id = $1 WHERE id = $2', [lhUid, id]);
        }
        return { status: 200 as const, body: { ok: true, wealth_user_id: id, id, role: 'agent', already_existed: true, agent_id: id, status: 'exists' } };
      }
      return {
        status: 409 as const,
        body: {
          error_code: 'PHONE_BELONGS_TO_EXISTING_AGENT',
          matched_by: 'phone',
          user_message: 'This phone number already belongs to a registered Dhanam agent. Please sign in with your Dhanam Wealth credentials instead, or contact support.',
          existing: { role: 'agent', contact: maskPhone(byPhone.phone ?? phone) },
        },
      };
    }

    // Phone/email collision with a staff user.
    const staff = (await tx.query<{ id: string; email: string; phone: string | null; role: string }>(
      `SELECT u.id, u.email, u.phone, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = TRUE AND r.name <> 'agent' AND r.name <> 'customer'
          AND (${phoneMatchSql('u.phone')} = $1 ${email ? 'OR lower(u.email) = $2' : ''})
        ORDER BY u.id ASC LIMIT 1`,
      email ? [phone, email] : [phone]
    )).rows[0];
    if (staff) {
      const byEmail = email != null && staff.email.toLowerCase() === email;
      return {
        status: 409 as const,
        body: {
          error_code: byEmail ? 'EMAIL_BELONGS_TO_EXISTING_USER' : 'PHONE_BELONGS_TO_STAFF',
          matched_by: byEmail ? 'email' : 'phone',
          user_message: byEmail
            ? 'This email already belongs to an existing Dhanam user. Please use a different email, or contact support.'
            : 'This phone number belongs to a Dhanam staff member. Please contact support.',
          existing: { role: staff.role, contact: byEmail ? maskEmail(staff.email) : maskPhone(staff.phone ?? phone) },
        },
      };
    }

    // Fresh signup → agents row + registration approval queue.
    const code = `AG-LH-${phone.slice(-6)}`;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agents (agent_code, full_name, phone, email, source, commission_status, is_active, lockerhub_user_id)
       VALUES ($1,$2,$3,$4,'dhanamfin','PendingApproval',FALSE,$5) RETURNING id`,
      [code, fullName, phone, email, lhUid ?? null]
    );
    const agentId = Number(rows[0]!.id);
    const approval = await createApprovalRequest(tx, {
      type: 'agent_registration',
      entityType: 'agents',
      entityId: agentId,
      makerUserId: null,
      metadata: { agentName: fullName, agentCode: code, lockerhubUserId: lhUid ?? null },
    });
    await writeAudit(tx, {
      actorId: null,
      action: 'LOCKERHUB_AGENT_SIGNUP',
      entityType: 'agents',
      entityId: agentId,
      after: { agent_code: code, phone: maskPhone(phone), lockerhub_user_id: lhUid ?? null, request_no: approval.request_no },
      ip: req.ip,
    });
    return {
      status: 201 as const,
      body: {
        ok: true,
        wealth_user_id: agentId,
        id: agentId,
        role: 'agent',
        already_existed: false,
        agent_id: agentId,
        status: 'pending_approval',
        request_no: approval.request_no,
      },
    };
  });

  res.status(out.status).json(out.body);
}));

// ─── Email-check (route existing agents to Sign-In, not Sign-Up) ─────────
async function emailCheck(email: string): Promise<{ exists: boolean; is_agent: boolean }> {
  const db = getDb();
  const agent = (await db.query('SELECT 1 FROM agents WHERE lower(email) = lower($1) LIMIT 1', [email])).rows[0];
  if (agent) return { exists: true, is_agent: true };
  const user = (await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1', [email])).rows[0];
  return { exists: !!user, is_agent: false };
}

agentsRouter.get('/agents/email-check', asyncHandler(async (req, res) => {
  const r = await emailCheck(String(req.query.email ?? ''));
  res.json({ exists: r.exists, is_agent: r.is_agent });
}));

agentsRouter.post('/agents/email-check', asyncHandler(async (req, res) => {
  const email = String((req.body ?? {}).email ?? '').trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const r = await emailCheck(email);
  res.json({ exists: r.exists, is_agent: r.is_agent });
}));

// ─── Agent + staff SSO authenticate (broker model, Option B) ─────────────
// LockerHub forwards the credentials once over TLS; consumer branches on
// 401/'invalid_credentials', 403/'not_an_agent'/'disabled' and reads
// wealth_user_id||id, name, email, phone on success.
//
// Agents live in `agents`, our own employees live in `users` — this endpoint
// resolves BOTH. An agent match wins (an agent with a linked user account is
// still an agent). A staff match answers `role:'staff'` with `staff_id`, and
// deliberately nulls wealth_user_id/id/agent_id: LockerHub stores
// wealth_user_id as agents.id, so handing back a users.id there would alias a
// completely different agent. Staff carry staff_id and nothing else.
agentsRouter.post('/agents/authenticate', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const identifier = String(b.identifier ?? b.email ?? '').trim();
  const password = String(b.password ?? '');
  if (!identifier || !password) return res.status(400).json({ error: 'identifier and password required' });

  const db = getDb();
  const identPhone = normalisePhone(identifier);
  const agent = (await db.query<Record<string, unknown>>(
    `SELECT ag.id, ag.agent_code, ag.full_name, ag.phone, ag.email, ag.is_active AS agent_active,
            u.id AS user_id, u.password_hash, u.is_active AS user_active
       FROM agents ag
       LEFT JOIN users u ON u.id = ag.user_id
      WHERE ag.deleted_at IS NULL
        AND (lower(COALESCE(ag.email,'')) = lower($1)
             OR lower(COALESCE(u.email,'')) = lower($1)
             ${identPhone.length === 10 ? `OR ${phoneMatchSql('ag.phone')} = $2` : ''})
      ORDER BY ag.id ASC LIMIT 1`,
    identPhone.length === 10 ? [identifier, identPhone] : [identifier]
  )).rows[0];

  if (!agent) {
    // No agent — try a staff identity. Same predicate the signup mirror uses
    // for its staff-collision check, so the two agree on who counts as staff.
    const staff = (await db.query<Record<string, unknown>>(
      `SELECT u.id, u.full_name, u.email, u.phone, u.password_hash, u.is_active, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.name <> 'agent' AND r.name <> 'customer'
          AND (lower(u.email) = lower($1)
               ${identPhone.length === 10 ? `OR ${phoneMatchSql('u.phone')} = $2` : ''})
        ORDER BY u.id ASC LIMIT 1`,
      identPhone.length === 10 ? [identifier, identPhone] : [identifier]
    )).rows[0];

    if (staff) {
      if (staff.is_active === false) return res.status(403).json({ error: 'disabled' });
      if (!staff.password_hash) return res.status(401).json({ error: 'invalid_credentials' });
      if (!(await bcrypt.compare(password, String(staff.password_hash)))) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      const staffId = Number(staff.id);
      await writeAudit(db, {
        actorId: staffId,
        action: 'LOCKERHUB_STAFF_AUTH',
        entityType: 'users',
        entityId: staffId,
        after: { role: staff.role, via: 'lockerhub_sso' },
        ip: req.ip,
      });
      return res.json({
        ok: true,
        success: true,
        // Null on purpose — see the note above the handler.
        wealth_user_id: null,
        id: null,
        agent_id: null,
        agent_code: null,
        staff_id: staffId,
        name: staff.full_name,
        email: staff.email ?? null,
        phone: staff.phone ?? null,
        role: 'staff',
        staff_role: staff.role,
      });
    }

    // A matching non-agent, non-staff user (a customer) is 'not_an_agent'.
    const user = (await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1', [identifier])).rows[0];
    if (user) return res.status(403).json({ error: 'not_an_agent' });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (agent.agent_active !== true || agent.user_active === false) {
    return res.status(403).json({ error: 'disabled' });
  }
  // An agents row carrying no linked user account must not shadow a real user
  // with the same contact details. Self-signup mirrors and staff-created
  // agents arrive with user_id NULL, so the person's actual login lives in
  // `users` — match it on the AGENT's own email/phone (not on the raw
  // identifier) so we can only ever adopt the same contact point.
  let passwordHash = agent.password_hash as string | null;
  let actorUserId = agent.user_id != null ? Number(agent.user_id) : null;
  if (!passwordHash) {
    const agentEmail = String(agent.email ?? '');
    const agentPhone = normalisePhone(String(agent.phone ?? ''));
    const linked = (await db.query<Record<string, unknown>>(
      `SELECT u.id, u.password_hash, u.is_active
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.name <> 'customer' AND u.password_hash IS NOT NULL
          AND (($1 <> '' AND lower(u.email) = lower($1))
               OR ($2 <> '' AND ${phoneMatchSql('u.phone')} = $2))
        ORDER BY u.id ASC LIMIT 1`,
      [agentEmail, agentPhone]
    )).rows[0];
    if (linked) {
      if (linked.is_active === false) return res.status(403).json({ error: 'disabled' });
      passwordHash = String(linked.password_hash);
      actorUserId = Number(linked.id);
    }
  }
  if (!passwordHash) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password, passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const agentId = Number(agent.id);
  await writeAudit(db, {
    actorId: actorUserId,
    action: 'LOCKERHUB_AGENT_AUTH',
    entityType: 'agents',
    entityId: agentId,
    after: { agent_code: agent.agent_code, via: 'lockerhub_sso' },
    ip: req.ip,
  });

  res.json({
    ok: true,
    success: true,
    wealth_user_id: agentId,
    id: agentId,
    agent_id: agentId,
    agent_code: agent.agent_code,
    name: agent.full_name,
    email: agent.email ?? null,
    phone: agent.phone ?? null,
    role: 'agent',
  });
}));

// ─── Webview session handoff (both shapes; docs/08 §1) ───────────────────
const WEBVIEW_TOKEN_TTL = 86400; // legacy 24h JWT
const ESTABLISH_CODE_TTL = 60;   // single-use short-lived establish code

agentsRouter.post('/agents/issue-webview-session', asyncHandler(async (req, res) => {
  const actingAs = parseInt(String(req.get('X-Acting-As-Agent') ?? ''), 10);
  if (!actingAs || Number.isNaN(actingAs)) {
    return res.status(400).json({ error: 'X-Acting-As-Agent header required' });
  }
  const db = getDb();
  const agent = (await db.query<Record<string, unknown>>(
    'SELECT id, agent_code, full_name, is_active FROM agents WHERE id = $1', [actingAs]
  )).rows[0];
  if (!agent) return res.status(404).json({ error: 'unknown_agent' });
  if (agent.is_active !== true) return res.status(403).json({ error: 'disabled' });

  const b = req.body ?? {};
  let returnTo = String(b.return_to ?? b.path ?? '/app');
  if (!returnTo.startsWith('/')) returnTo = '/app';
  const includeNav = b.include_wealth_nav === true;
  const logoutRedirect = /^https:\/\//.test(String(b.logout_redirect ?? '')) ? String(b.logout_redirect) : null;

  // Chrome-stripped webview unless the caller asks for the full sidebar nav.
  const nextPath = includeNav ? returnTo : returnTo + (returnTo.includes('?') ? '&' : '?') + 'webview=1';
  const base = config.WEB_ORIGIN.replace(/\/+$/, '');

  const tokenIdentity = { id: Number(agent.id), customer_code: String(agent.agent_code), full_name: String(agent.full_name) };
  // Legacy shape: 24h JWT in the URL fragment (bridge page → localStorage).
  const token = signToken(tokenIdentity, 'lh_agent_webview', WEBVIEW_TOKEN_TTL);
  // Cookie shape: short-lived single-use-style establish code (stateless HMAC
  // + nonce; the establish endpoint exchanges it for a Set-Cookie session).
  const sessionCode = signToken(
    { ...tokenIdentity, full_name: `${agent.full_name}:${randomBytes(8).toString('hex')}` },
    'lh_agent_establish',
    ESTABLISH_CODE_TTL
  );
  const establishUrl = `${base}/api/auth/session/establish?code=${encodeURIComponent(sessionCode)}&next=${encodeURIComponent(nextPath)}`;
  const bridgeUrl = `${base}/agent-bridge?next=${encodeURIComponent(nextPath)}${logoutRedirect ? `&logout_redirect=${encodeURIComponent(logoutRedirect)}` : ''}#token=${token}`;

  await writeAudit(db, {
    actorId: null,
    action: 'LOCKERHUB_AGENT_WEBVIEW_SESSION',
    entityType: 'agents',
    entityId: Number(agent.id),
    after: { return_to: returnTo, include_wealth_nav: includeNav },
    ip: req.ip,
  });

  res.json({
    ok: true,
    success: true,
    agent_id: Number(agent.id),
    // Cookie-establish shape (preferred by the consumer when present)
    session_code: sessionCode,
    establish_url: establishUrl,
    code_expires_in_seconds: ESTABLISH_CODE_TTL,
    // Legacy bridge shape (roll-back path)
    token,
    bridge_url: bridgeUrl,
    url: bridgeUrl,
    return_to: returnTo,
    expires_in_seconds: WEBVIEW_TOKEN_TTL,
  });
}));

/** Validate an agent webview token/establish code (used by the web shell). */
export function verifyAgentWebviewToken(token: string) {
  return verifyToken(token, 'lh_agent_webview');
}
