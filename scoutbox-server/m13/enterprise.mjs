// F12 — Enterprise onboarding, recovery, and service reliability.
// Honesty contract for this module:
//  * SSO ships with a LOCAL TEST identity provider (in-process, HMAC-signed
//    tokens, enabled only where dev logins are). No corporate IdP is
//    configured; the API and the screens both say so. A production rollout
//    swaps the token verification for a maintained OIDC library (e.g. jose)
//    against the real issuer — the state/nonce/code flow tested here is the
//    same.
//  * Backups copy data; restores happen into a SEPARATE empty directory and
//    never touch the active database.
//  * Metrics come from this process only. Nothing here claims an SLA.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { totpValid, b32encode, timingSafeEqStr } from './shared.mjs';

// ---------------------------------------------------- request instrumentation
// Exported separately so server.mjs can install it BEFORE all routes.
export const metrics = {
  startedAt: Date.now(),
  requests: 0, status2xx: 0, status4xx: 0, status5xx: 0,
  slowRequests: 0, // > 500ms
  byRoute: {},     // top-level path segment → count
  failedUploads: 0,
  deliveryFailures: 0, jobRuns: 0, sseConnects: 0,
};
// Mutable hook: insight.mjs (F4) plugs exposure capture in here so profile
// and passport reads become funnel events without touching older handlers.
export const exposureHook = { fn: null };
export function requestInstrumentation() {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    req.correlationId = /^[a-zA-Z0-9_-]{6,64}$/.test(String(req.headers['x-request-id'] ?? ''))
      ? String(req.headers['x-request-id'])
      : `req_${crypto.randomBytes(8).toString('hex')}`;
    res.set('X-Request-Id', req.correlationId);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      // originalUrl, never req.path: inside a mounted router that ended the
      // response, req.path is still the prefix-stripped form.
      const fullPath = String(req.originalUrl ?? req.url ?? '').split('?')[0];
      metrics.requests++;
      if (res.statusCode >= 500) metrics.status5xx++;
      else if (res.statusCode >= 400) metrics.status4xx++;
      else metrics.status2xx++;
      if (ms > 500) metrics.slowRequests++;
      const seg = `/${(fullPath.split('/')[1] ?? '')}`;
      metrics.byRoute[seg] = (metrics.byRoute[seg] ?? 0) + 1;
      if (fullPath.startsWith('/player/uploads') && res.statusCode >= 400) metrics.failedUploads++;
      if (fullPath === '/events') metrics.sseConnects++;
      try { exposureHook.fn?.(req, res); } catch { /* exposure capture must never break a request */ }
      // Structured log line. REDACTION: no auth headers, no tokens, no bodies,
      // no emails — method/path/status/timing/correlation id only.
      if (process.env.M13_QUIET_LOGS !== '1') {
        console.log(JSON.stringify({ t: Date.now(), id: req.correlationId, m: req.method, p: fullPath.slice(0, 120), s: res.statusCode, ms: Math.round(ms) }));
      }
    });
    next();
  };
}

export function registerEnterprise(ctx) {
  const {
    db, app, orgRouter, adminRouter, nextId, persist, persistNow, notify,
    mailer, requireLead, isLead, paginate, histAppend, timingSafeEq, signBody,
    storage, DATA_DIR,
  } = ctx;

  const DEV = (process.env.NODE_ENV ?? 'development') !== 'production' || process.env.ALLOW_DEV_LOGINS === '1';

  // ================================================== A. org onboarding
  orgRouter.post('/invites', (req, res) => {
    if (!requireLead(req, res)) return;
    const { email, name, role } = req.body ?? {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'EMAIL_INVALID' });
    if (!name?.trim()) return res.status(400).json({ error: 'NAME_REQUIRED' });
    if (db.users.some((u) => u.orgId === req.org.id && !u.removedAt && u.email === email)) {
      return res.status(409).json({ error: 'ALREADY_STAFF', message: 'Someone with this email is already on your staff.' });
    }
    const inv = {
      id: nextId('inv'), orgId: req.org.id, email: String(email), name: String(name).trim().slice(0, 80),
      role: String(role ?? 'Scout').trim().slice(0, 60),
      token: crypto.randomBytes(18).toString('hex'),
      status: 'pending', invitedBy: req.orgUser.name, createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 86_400_000, acceptedAt: null, revokedAt: null,
    };
    db.orgInvites.push(inv);
    void mailer.send({ to: email, subject: `${req.org.name} invited you to ScoutBox`, text: `Hi ${inv.name},\n\n${req.orgUser.name} invited you to join ${req.org.name} on ScoutBox as ${inv.role}.\n\nAccept with invite code: ${inv.token}\n\nThe code expires in 7 days.` });
    persistNow();
    res.status(201).json({ invite: { ...inv, token: undefined }, note: 'The invite code went to their email (dev outbox in this environment).' });
  });

  orgRouter.get('/invites', (req, res) => {
    res.json({ items: db.orgInvites.filter((i) => i.orgId === req.org.id).map(({ token, ...i }) => i) });
  });

  orgRouter.post('/invites/:id/revoke', (req, res) => {
    if (!requireLead(req, res)) return;
    const inv = db.orgInvites.find((i) => i.id === req.params.id && i.orgId === req.org.id);
    if (!inv) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    if (inv.status === 'pending') { inv.status = 'revoked'; inv.revokedAt = Date.now(); persistNow(); }
    res.json({ invite: { ...inv, token: undefined } });
  });

  // Public accept: the emailed code is the proof of invitation.
  app.post('/auth/org/accept-invite', (req, res) => {
    const { token, scoutName } = req.body ?? {};
    const inv = db.orgInvites.find((i) => i.token === String(token ?? ''));
    if (!inv || inv.status !== 'pending') return res.status(404).json({ error: 'INVITE_INVALID' });
    if (inv.expiresAt < Date.now()) { inv.status = 'expired'; persist(); return res.status(410).json({ error: 'INVITE_EXPIRED' }); }
    const org = db.orgs.find((o) => o.id === inv.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    let user = db.users.find((u) => u.orgId === org.id && u.name.toLowerCase() === inv.name.toLowerCase() && !u.removedAt);
    if (!user) {
      user = { id: nextId('usr'), orgId: org.id, name: scoutName?.trim() || inv.name, role: inv.role, createdAt: Date.now() };
      db.users.push(user);
    }
    user.email = inv.email; // email is bound by the invite — the basis for SSO linking
    inv.status = 'accepted';
    inv.acceptedAt = Date.now();
    inv.userId = user.id;
    persistNow();
    res.status(201).json({
      userId: user.id, role: user.role, org: ctx.orgSafe(org),
      token: ctx.createSession('org', org.id, { userId: user.id }),
      onboarding: onboardingFor(org, user),
    });
  });

  function onboardingFor(org, user) {
    const staff = db.users.filter((u) => u.orgId === org.id && !u.removedAt);
    const leads = staff.filter((u) => isLead(u));
    const tasks = [
      { id: 'verify_org', label: 'Verify your organisation (company email domain)', done: !!org.verified, help: 'Trust & Safety reviews verification — required before any under-18 visibility.' },
      { id: 'safeguarding', label: 'Sign the safeguarding contract', done: !!org.safeguardingContractSigned, help: 'Required for under-18 access. The club safeguarding officer signs.' },
      { id: 'invite_staff', label: 'Invite your staff', done: staff.length > 1, help: 'Each person works under their own named account — no shared logins.' },
      { id: 'mfa_leads', label: 'Enable MFA for privileged accounts', done: leads.every((u) => u.mfa?.enabledAt), help: 'Leads approve signings and manage staff — protect those accounts first.' },
      { id: 'first_import', label: 'Import or add your player records', done: db.importBatches.some((b) => b.orgId === org.id && b.status === 'committed') || db.prospects.some((p) => p.orgId === org.id), help: 'CSV import with dry-run preview, or add prospects by hand.' },
      { id: 'coverage_plan', label: 'Set up a coverage plan', done: db.coveragePlans.some((c) => c.orgId === org.id), help: 'Fixtures, assignments and observation tracking live under Coverage.' },
    ];
    return {
      tasks, complete: tasks.every((t) => t.done),
      roleHelp: isLead(user)
        ? 'As a lead you approve signings, manage staff and see restricted cases.'
        : 'As a scout you file assessments and observations; a lead reviews decisions.',
    };
  }
  orgRouter.get('/onboarding', (req, res) => res.json(onboardingFor(req.org, req.orgUser)));

  // ================================================== B. MFA + sessions
  const mfaAttempts = new Map(); // userId → {fails, lockedUntil}
  function mfaLocked(userId) {
    const a = mfaAttempts.get(userId);
    return a?.lockedUntil && a.lockedUntil > Date.now();
  }
  function mfaFail(userId) {
    const a = mfaAttempts.get(userId) ?? { fails: 0, lockedUntil: 0 };
    a.fails++;
    if (a.fails >= 5) { a.lockedUntil = Date.now() + 5 * 60_000; a.fails = 0; }
    mfaAttempts.set(userId, a);
  }
  ctx.mfaGuards = { mfaLocked, mfaFail, clear: (id) => mfaAttempts.delete(id) };

  orgRouter.post('/mfa/setup', (req, res) => {
    if (req.orgUser.mfa?.enabledAt) return res.status(409).json({ error: 'MFA_ALREADY_ENABLED' });
    const secretB32 = b32encode(crypto.randomBytes(20));
    req.orgUser.mfa = { secretB32, enabledAt: null, recoveryHashes: [] };
    persistNow();
    res.json({
      secret: secretB32,
      otpauth: `otpauth://totp/ScoutBox:${encodeURIComponent(req.orgUser.name)}?secret=${secretB32}&issuer=ScoutBox`,
      note: 'Scan into an authenticator app, then confirm with POST /org/mfa/verify {code}. The secret is shown once.',
    });
  });

  orgRouter.post('/mfa/verify', (req, res) => {
    const m = req.orgUser.mfa;
    if (!m?.secretB32 || m.enabledAt) return res.status(409).json({ error: 'MFA_NOT_PENDING' });
    if (mfaLocked(req.orgUser.id)) return res.status(429).json({ error: 'MFA_LOCKED', message: 'Too many wrong codes — try again in a few minutes.' });
    if (!totpValid(m.secretB32, req.body?.code)) { mfaFail(req.orgUser.id); return res.status(401).json({ error: 'MFA_CODE_WRONG' }); }
    m.enabledAt = Date.now();
    const plain = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    m.recoveryHashes = plain.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
    persistNow();
    res.json({ enabled: true, recoveryCodes: plain, note: 'Store these recovery codes now — each works once and they are never shown again.' });
  });

  orgRouter.post('/mfa/disable', (req, res) => {
    // Self-service disable requires a current valid code (proof of control).
    const m = req.orgUser.mfa;
    if (!m?.enabledAt) return res.status(409).json({ error: 'MFA_NOT_ENABLED' });
    if (!totpValid(m.secretB32, req.body?.code)) return res.status(401).json({ error: 'MFA_CODE_WRONG' });
    req.orgUser.mfa = null;
    persistNow();
    res.json({ enabled: false });
  });

  orgRouter.put('/security', (req, res) => {
    if (!requireLead(req, res)) return;
    req.org.mfaRequiredForLeads = req.body?.mfaRequiredForLeads === true;
    persistNow();
    res.json({ mfaRequiredForLeads: req.org.mfaRequiredForLeads, note: 'Enforced at login: leads without MFA are asked to set it up before privileged actions.' });
  });

  // Session/device management (own sessions only).
  orgRouter.get('/sessions', (req, res) => {
    const mine = db.sessions.filter((s) => s.kind === 'org' && s.userId === req.orgUser.id);
    const currentToken = (req.headers.authorization ?? '').slice(7);
    res.json({ items: mine.map((s) => ({ sid: s.sid, createdAt: s.createdAt, current: s.token === currentToken, via: s.via ?? 'password' })) });
  });

  orgRouter.post('/sessions/revoke', (req, res) => {
    const sid = String(req.body?.sid ?? '');
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((s) => !(s.kind === 'org' && s.userId === req.orgUser.id && s.sid === sid));
    persistNow();
    res.json({ revoked: before - db.sessions.length });
  });

  // ================================================== B2. SSO (local test IdP)
  // Explicit per-org configuration; nothing implicit.
  orgRouter.get('/sso', (req, res) => {
    const cfg = db.ssoConfigs.find((c) => c.orgId === req.org.id);
    res.json({
      config: cfg ?? null,
      available: DEV ? ['local-test-idp'] : [],
      note: cfg ? null : 'No identity provider configured. In this environment only the local test IdP is available — a corporate provider requires real OIDC credentials.',
    });
  });

  orgRouter.put('/sso', (req, res) => {
    if (!requireLead(req, res)) return;
    const issuer = String(req.body?.issuer ?? '');
    if (issuer !== 'local-test-idp') {
      return res.status(400).json({ error: 'IDP_UNAVAILABLE', message: 'Only the local test IdP exists in this environment. A real provider needs its issuer URL, client id and secret configured on the server.' });
    }
    if (!DEV) return res.status(403).json({ error: 'TEST_IDP_DEV_ONLY' });
    let cfg = db.ssoConfigs.find((c) => c.orgId === req.org.id);
    if (!cfg) { cfg = { id: nextId('sso'), orgId: req.org.id, createdAt: Date.now() }; db.ssoConfigs.push(cfg); }
    cfg.issuer = issuer;
    cfg.clientId = `scoutbox-${req.org.id}`;
    cfg.updatedAt = Date.now();
    persistNow();
    res.json({ config: cfg });
  });

  const IDP_SECRET = process.env.TEST_IDP_SECRET || 'local-test-idp-secret';
  const signToken = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', IDP_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
  };
  const verifyToken = (tok) => {
    const [body, sig] = String(tok ?? '').split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', IDP_SECRET).update(body).digest('base64url');
    if (!timingSafeEqStr(sig, expect)) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  };

  // Start: mint state+nonce, hand back the authorisation URL.
  app.post('/auth/sso/start', (req, res) => {
    const org = db.orgs.find((o) => o.id === req.body?.orgId);
    const cfg = org && db.ssoConfigs.find((c) => c.orgId === org.id);
    if (!cfg) return res.status(404).json({ error: 'SSO_NOT_CONFIGURED', message: 'This organisation has no identity provider configured.' });
    const st = {
      id: nextId('sst'), state: crypto.randomBytes(16).toString('hex'), nonce: crypto.randomBytes(16).toString('hex'),
      orgId: org.id, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60_000, usedAt: null,
    };
    db.ssoStates.push(st);
    persist();
    res.json({ authUrl: `/testidp/authorize?client_id=${cfg.clientId}&state=${st.state}&nonce=${st.nonce}`, state: st.state });
  });

  if (DEV) {
    // The local test IdP: authenticates "as" whatever email the tester picks —
    // it exists to exercise the RELYING-PARTY logic (state, nonce, linking).
    app.get('/testidp/authorize', (req, res) => {
      const { client_id: clientId, state, nonce, email, groups } = req.query;
      if (!clientId || !state || !nonce || !email) return res.status(400).json({ error: 'IDP_PARAMS', message: 'client_id, state, nonce, email required' });
      const code = signToken({ typ: 'code', sub: `idp-${crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 12)}`, email: String(email), nonce: String(nonce), groups: String(groups ?? '').split(',').filter(Boolean), iat: Date.now(), exp: Date.now() + 5 * 60_000 });
      res.json({ code, state });
    });
  }

  app.post('/auth/sso/callback', (req, res) => {
    const { code, state } = req.body ?? {};
    const st = db.ssoStates.find((s) => s.state === String(state ?? ''));
    if (!st || st.usedAt || st.expiresAt < Date.now()) {
      return res.status(401).json({ error: 'SSO_STATE_INVALID', message: 'Unknown, expired or already-used state — restart the sign-in.' });
    }
    st.usedAt = Date.now(); // single use, always — even on failure below
    const tok = verifyToken(code);
    if (!tok || tok.typ !== 'code' || tok.exp < Date.now()) return res.status(401).json({ error: 'SSO_TOKEN_INVALID' });
    if (tok.nonce !== st.nonce) return res.status(401).json({ error: 'SSO_NONCE_MISMATCH', message: 'The token was not minted for this sign-in attempt.' });
    const org = db.orgs.find((o) => o.id === st.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    // Account linking requires PROOF: the user's email was bound by an
    // accepted invite (or a previous linked login). An SSO assertion for an
    // email we never invited links nothing and creates nothing.
    const user = db.users.find((u) => u.orgId === org.id && !u.removedAt && (u.ssoSubject === tok.sub || (u.email && u.email.toLowerCase() === String(tok.email).toLowerCase())));
    if (!user) {
      return res.status(403).json({ error: 'SSO_NOT_LINKED', message: 'No staff account with this email exists in the organisation. Ask a lead for an invitation — SSO never creates accounts by itself.' });
    }
    user.ssoSubject = tok.sub; // link (or confirm) sub ↔ user
    // SSO group claims NEVER grant ScoutBox privileges: role, verification and
    // safeguarding approval only change through ScoutBox's own flows.
    persistNow();
    res.json({
      userId: user.id, role: user.role, org: ctx.orgSafe(org),
      token: ctx.createSession('org', org.id, { userId: user.id, via: 'sso' }),
      ignoredClaims: tok.groups?.length ? { groups: tok.groups, note: 'Identity-provider groups are ignored for permissions.' } : null,
    });
  });

  // ================================================== C. audit + support
  orgRouter.get('/audit/export', (req, res) => {
    if (!requireLead(req, res)) return;
    const orgId = req.org.id;
    const scoped = {
      contract: 'audit-export.2026-09.v1', orgId, exportedAt: Date.now(), exportedBy: req.orgUser.name,
      ledger: db.ledger.filter((l) => l.orgId === orgId),
      caseHistories: db.recruitmentCases.filter((c) => c.orgId === orgId).map((c) => ({ id: c.id, playerId: c.playerId, history: c.history })),
      importHistories: db.importBatches.filter((b) => b.orgId === orgId).map((b) => ({ id: b.id, history: b.history })),
      grantsGiven: db.groupGrants.filter((g) => g.fromOrgId === orgId),
      grantsReceived: db.groupGrants.filter((g) => g.toOrgIds?.includes(orgId)),
      supportAccess: db.supportAccessGrants.filter((g) => g.orgId === orgId),
    };
    db.opsEvents.push({ id: nextId('ops'), at: Date.now(), kind: 'audit_export', detail: { orgId, by: req.orgUser.name } });
    persist();
    res.json(scoped);
  });

  orgRouter.post('/support', (req, res) => {
    const { subject, body, refs } = req.body ?? {};
    if (!subject?.trim()) return res.status(400).json({ error: 'SUBJECT_REQUIRED' });
    const t = {
      id: nextId('tkt'), orgId: req.org.id, byUserId: req.orgUser.id, byName: req.orgUser.name,
      subject: String(subject).slice(0, 160), body: String(body ?? '').slice(0, 2000),
      refs: (Array.isArray(refs) ? refs : []).slice(0, 10).map((r) => ({ kind: String(r.kind).slice(0, 30), id: String(r.id).slice(0, 40) })),
      status: 'open', replies: [], createdAt: Date.now(),
    };
    db.supportTickets.push(t);
    persistNow();
    res.status(201).json({ ticket: t, note: 'Records are referenced by id — nothing was copied into the ticket.' });
  });

  orgRouter.get('/support', (req, res) => {
    res.json({ items: db.supportTickets.filter((t) => t.orgId === req.org.id).slice().reverse() });
  });

  orgRouter.post('/support/:id/approve-access', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.supportAccessGrants.find((x) => x.ticketId === req.params.id && x.orgId === req.org.id && x.status === 'requested');
    if (!g) return res.status(404).json({ error: 'NO_PENDING_REQUEST' });
    g.status = 'active';
    g.approvedBy = req.orgUser.name;
    g.approvedAt = Date.now();
    g.expiresAt = Date.now() + g.hours * 3600_000;
    persistNow();
    res.json({ grant: g });
  });

  adminRouter.get('/support', (_req, res) => res.json({ items: db.supportTickets.slice().reverse(), grants: db.supportAccessGrants.slice().reverse() }));

  adminRouter.post('/support/:id/reply', (req, res) => {
    const t = db.supportTickets.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    t.replies.push({ at: Date.now(), by: 'Trust & Safety', text: String(req.body?.text ?? '').slice(0, 2000) });
    if (req.body?.close) t.status = 'closed';
    const lead = db.users.find((u) => u.id === t.byUserId);
    if (lead) notify({ kind: 'org_user', id: lead.id }, 'support', `Support replied on “${t.subject}”.`, t.id);
    persistNow();
    res.json({ ticket: t });
  });

  adminRouter.post('/support/:id/request-access', (req, res) => {
    const t = db.supportTickets.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    const hours = Math.min(Math.max(Number(req.body?.hours) || 24, 1), 72);
    const g = {
      id: nextId('sag'), ticketId: t.id, orgId: t.orgId, hours,
      status: 'requested', requestedAt: Date.now(), approvedBy: null, approvedAt: null, expiresAt: null, accessLog: [],
    };
    db.supportAccessGrants.push(g);
    const lead = db.users.find((u) => u.id === t.byUserId);
    if (lead) notify({ kind: 'org_user', id: lead.id }, 'support', `Trust & Safety asks for time-limited access (${hours}h) to investigate “${t.subject}”. A lead can approve it from the Support screen.`, t.id);
    persistNow();
    res.status(201).json({ grant: g, note: 'Access starts only after an organisation lead approves, and every read is logged.' });
  });

  // The ONLY admin view into org-private records — gated by an approved,
  // unexpired grant; every use appended to the grant's access log.
  adminRouter.get('/support/:id/org-records', (req, res) => {
    const t = db.supportTickets.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    const g = db.supportAccessGrants.find((x) => x.ticketId === t.id && x.status === 'active' && x.expiresAt > Date.now());
    if (!g) return res.status(403).json({ error: 'SUPPORT_ACCESS_NOT_GRANTED', message: 'A lead of the organisation must approve time-limited access first. There is no silent access path.' });
    g.accessLog.push({ at: Date.now(), what: 'org-records' });
    persistNow();
    const orgId = t.orgId;
    res.json({
      grant: { id: g.id, expiresAt: g.expiresAt },
      records: {
        refs: t.refs,
        cases: db.recruitmentCases.filter((c) => c.orgId === orgId && t.refs.some((r) => r.kind === 'case' && r.id === c.id)),
        imports: db.importBatches.filter((b) => b.orgId === orgId && t.refs.some((r) => r.kind === 'import' && r.id === b.id)).map(({ rows, ...b }) => b),
      },
      note: 'Only records the ticket references, only while the grant lives, only logged.',
    });
  });

  // ================================================== D. backup + recovery
  function fileSha256(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }

  adminRouter.post('/backup', (req, res) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(DATA_DIR, 'backups', stamp);
    fs.mkdirSync(dir, { recursive: true });
    // 1. A consistent snapshot: the same shape store.load() imports on first
    //    boot (db.json legacy path) — a restore is simply "point a fresh
    //    DATA_DIR at a copy of this directory".
    persistNow();
    const snapshotPath = path.join(dir, 'db.json');
    fs.writeFileSync(snapshotPath, JSON.stringify({ savedAt: Date.now(), idCounter: ctx.currentIdCounter(), db }));
    // 2. Media files.
    const mediaSrc = path.join(DATA_DIR, 'media');
    const mediaDst = path.join(dir, 'media');
    const files = [];
    if (fs.existsSync(mediaSrc)) {
      fs.mkdirSync(mediaDst, { recursive: true });
      for (const f of fs.readdirSync(mediaSrc)) {
        fs.copyFileSync(path.join(mediaSrc, f), path.join(mediaDst, f));
        files.push({ path: `media/${f}`, sha256: fileSha256(path.join(mediaDst, f)), bytes: fs.statSync(path.join(mediaDst, f)).size });
      }
    }
    files.unshift({ path: 'db.json', sha256: fileSha256(snapshotPath), bytes: fs.statSync(snapshotPath).size });
    const manifest = {
      contract: 'backup.2026-09.v1', createdAt: Date.now(), engine: 'json-snapshot + media files',
      counts: { players: db.players.length, orgs: db.orgs.length, notifications: db.notifications.length },
      files,
      secretsNote: 'Backups contain NO server secrets (ADMIN_KEY, signing secrets live in env, never in the DB). Store backups with the same care as the live data directory.',
      restore: 'Copy this directory to a NEW empty DATA_DIR and start the server with DATA_DIR pointing at it. Never restore over a live data directory.',
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    db.opsEvents.push({ id: nextId('ops'), at: Date.now(), kind: 'backup_created', detail: { dir: stamp, files: files.length } });
    persistNow();
    res.status(201).json({ dir, manifest });
  });

  adminRouter.get('/backups', (_req, res) => {
    const root = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(root)) return res.json({ items: [] });
    res.json({
      items: fs.readdirSync(root).sort().reverse().slice(0, 20).map((d) => {
        try { return { dir: d, manifest: JSON.parse(fs.readFileSync(path.join(root, d, 'manifest.json'), 'utf8')) }; }
        catch { return { dir: d, manifest: null }; }
      }),
    });
  });

  adminRouter.post('/backup/verify', (req, res) => {
    const dir = path.join(DATA_DIR, 'backups', path.basename(String(req.body?.dir ?? '')));
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
    catch { return res.status(404).json({ error: 'BACKUP_NOT_FOUND' }); }
    const results = manifest.files.map((f) => {
      try { return { path: f.path, ok: fileSha256(path.join(dir, f.path)) === f.sha256 }; }
      catch { return { path: f.path, ok: false, missing: true }; }
    });
    res.json({ ok: results.every((r) => r.ok), results });
  });

  // ================================================== E. reliability
  // M18.2: the schema version is on the health check so an operator can see
  // which snapshot shape this instance is running without reading a database.
  app.get('/healthz', (_req, res) => res.json({
    ok: true,
    uptimeS: Math.round((Date.now() - metrics.startedAt) / 1000),
    schemaVersion: db.schema?.version ?? 0,
  }));

  app.get('/readyz', (_req, res) => {
    // Ready = snapshot store writable + data loaded.
    try {
      persistNow();
      res.json({ ready: true, players: db.players.length });
    } catch (err) {
      res.status(503).json({ ready: false, error: err.message });
    }
  });

  adminRouter.get('/metrics', (_req, res) => {
    res.json({
      ...metrics,
      deliveryFailures: db.opsEvents.filter((e) => e.kind === 'delivery_failed').length,
      webhookFailures: db.opsEvents.filter((e) => e.kind === 'webhook_failed').length,
      dispatchBacklog: db.dispatches.filter((d) => ['queued', 'retrying'].includes(d.status)).length,
      webhookBacklog: db.webhookDeliveries.filter((d) => ['queued', 'retrying'].includes(d.status)).length,
      opsEvents: db.opsEvents.slice(-50).reverse(),
      note: 'Counters cover this process since boot. Local development metrics — not a production SLA measurement.',
    });
  });
}
