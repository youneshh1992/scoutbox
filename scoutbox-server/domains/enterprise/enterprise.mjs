// SSO runs against a local test identity provider (HMAC-signed, enabled only where dev logins are); no corporate IdP
// is configured and the API says so. A production rollout swaps the token verification for a maintained OIDC library
// against the real issuer; the state/nonce/code flow is the same. Restores go into a separate empty directory.
import { sideEffect, declareAuditedRead } from '../../writeRules.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { totpValid, b32encode, timingSafeEqStr } from '../identity/totp.mjs';
import { signBody } from '../integrations/webhooks.mjs';
import { devLoginsEnabled } from '../platform/capabilities.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { filled, presentOrRefuse } from '../platform/schemas.mjs';
import { enterpriseInput } from './schemas.mjs';
import { grantView as grantExport } from '../groups/groups.mjs';

// ---------------------------------------------------- request instrumentation
// Exported separately so server.mjs can install it before all routes.
export const metrics = {
  startedAt: Date.now(),
  requests: 0,
  status2xx: 0,
  status4xx: 0,
  status5xx: 0,
  slowRequests: 0, // > 500ms
  byRoute: {}, // top-level path segment → count
  failedUploads: 0,
  deliveryFailures: 0,
  jobRuns: 0,
  sseConnects: 0,
};
// insight.mjs plugs exposure capture in here so profile and passport reads become funnel events.
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
      // originalUrl, not req.path: inside a mounted router that ended the response, req.path is prefix-stripped.
      const fullPath = String(req.originalUrl ?? req.url ?? '').split('?')[0];
      metrics.requests++;
      if (res.statusCode >= 500) metrics.status5xx++;
      else if (res.statusCode >= 400) metrics.status4xx++;
      else metrics.status2xx++;
      if (ms > 500) metrics.slowRequests++;
      const seg = `/${fullPath.split('/')[1] ?? ''}`;
      metrics.byRoute[seg] = (metrics.byRoute[seg] ?? 0) + 1;
      if (fullPath.startsWith('/player/uploads') && res.statusCode >= 400) metrics.failedUploads++;
      if (fullPath === '/events') metrics.sseConnects++;
      try {
        // Passive measurement after the response: not the request's act.
        sideEffect(() => exposureHook.fn?.(req, res));
      } catch {
        /* exposure capture must never break a request */
      }
      // Redacted: no auth headers, tokens, bodies or emails.
      if (process.env.SCOUTBOX_QUIET_LOGS !== '1') {
        console.log(
          JSON.stringify({
            t: Date.now(),
            id: req.correlationId,
            m: req.method,
            p: fullPath.slice(0, 120),
            s: res.statusCode,
            ms: Math.round(ms),
          }),
        );
      }
    });
    next();
  };
}

/**
 * Wrong-code counting for staff second factors (org log-in and MFA set-up): five wrong codes lock the account's code
 * checks for five minutes. Per process, like the rate limiter.
 */
export function createMfaGuards() {
  const attempts = new Map(); // userId → { fails, lockedUntil }
  return {
    mfaLocked(userId) {
      const a = attempts.get(userId);
      return !!a?.lockedUntil && a.lockedUntil > Date.now();
    },
    mfaFail(userId) {
      const a = attempts.get(userId) ?? { fails: 0, lockedUntil: 0 };
      a.fails++;
      if (a.fails >= 5) {
        a.lockedUntil = Date.now() + 5 * 60_000;
        a.fails = 0;
      }
      attempts.set(userId, a);
    },
    clear: (userId) => {
      attempts.delete(userId);
    },
  };
}

export function registerEnterprise(ctx) {
  const {
    byId,
    users,
    sessions,
    orgs,
    mediaDeletions,
    codes,
    notifications,
    dispatches,
    outbox,
    pushLog,
    pushTokens,
    channels,
    safetyAudit,
    recruitment,
    recruitmentCases,
    players,
    app,
    orgRouter,
    adminRouter,
    nextId,
    notify,
    mailer,
    requireLead,
    isLead,
    paginate,
    histAppend,
    storage,
    DATA_DIR,
    backupDatabase,
    unit,
    enterprise,
    enterpriseReads,
    schemaVersion,
  } = ctx;
  if (!enterprise || !enterpriseReads)
    throw new TypeError('registerEnterprise needs the enterprise repository (ctx.enterprise, ctx.enterpriseReads)');
  if (typeof ctx.mfaGuards?.mfaFail !== 'function')
    throw new TypeError('registerEnterprise needs the MFA guards the org log-in shares (createMfaGuards)');
  if (!ctx.groupReads)
    throw new TypeError('registerEnterprise needs groupReads (the audit export lists the group grants)');
  const opsEvent = (row) => safetyAudit.opsEvents.record(row);
  const ledgerExport = (l) => ({
    id: l.id,
    ts: l.ts,
    type: l.type,
    playerId: l.playerId,
    orgId: l.orgId,
    orgName: l.orgName,
    userId: l.userId,
    scoutName: l.scoutName,
    detail: l.detail,
  });

  const DEV = devLoginsEnabled();

  // ================================================== A. org onboarding
  // The emailed invite code is stored only as its sha-256, and no response carries the hash.
  const inviteView = (i) => ({
    id: i.id,
    orgId: i.orgId,
    email: i.email,
    name: i.name,
    role: i.role,
    status: i.status,
    invitedBy: i.invitedBy,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    revokedAt: i.revokedAt,
    userId: i.userId,
  });
  const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

  orgRouter.post('/invites', (req, res) => {
    if (!requireLead(req, res)) return;
    const body = enterpriseInput(res, 'invite', req.body);
    if (!body) return;
    const { email } = body;
    const name = filled(body.name);
    if (!presentOrRefuse(res, name, 'name')) return;
    if (users.activeByEmail(req.org.id, email)) {
      return res
        .status(409)
        .json({ error: 'ALREADY_STAFF', message: 'Someone with this email is already on your staff.' });
    }
    const code = crypto.randomBytes(18).toString('hex');
    const at = Date.now();
    const inv = enterprise.invites.create({
      id: nextId('inv'),
      orgId: req.org.id,
      email,
      name,
      role: filled(body.role) ?? 'Scout',
      tokenHash: sha256(code),
      status: 'pending',
      invitedBy: req.orgUser.name ?? null,
      createdAt: at,
      expiresAt: at + 7 * 86_400_000,
      acceptedAt: null,
      revokedAt: null,
      userId: null,
    });
    // A rejected send is logged by id rather than left as an unhandled rejection; the invite stands.
    mailer
      .send({
        to: email,
        subject: `${req.org.name} invited you to ScoutBox`,
        text: `Hi ${inv.name},\n\n${req.orgUser.name} invited you to join ${req.org.name} on ScoutBox as ${inv.role}.\n\nAccept with invite code: ${code}\n\nThe code expires in 7 days.`,
      })
      .catch((err) =>
        console.error(
          `staff invite ${inv.id}: the mail was not recorded or sent (${err?.code ?? err?.message ?? err})`,
        ),
      );
    res
      .status(201)
      .json({ invite: inviteView(inv), note: 'The invite code went to their email (dev outbox in this environment).' });
  });

  orgRouter.get('/invites', (req, res) => {
    const query = enterpriseInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const p = enterpriseReads.invites.page(req.org.id, page);
    res.json({ items: p.items.map(inviteView), nextCursor: p.nextCursor });
  });

  orgRouter.post('/invites/:id/revoke', (req, res) => {
    if (!requireLead(req, res)) return;
    if (!enterpriseInput(res, 'none', req.body)) return;
    const inv = enterpriseReads.invites.forOrgById(req.org.id, req.params.id);
    if (!inv) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    res.json({ invite: inviteView(enterprise.invites.revoke(inv.id, Date.now())) });
  });

  // The emailed code is the proof of invitation; it is looked up by its hash.
  app.post('/auth/org/accept-invite', (req, res) => {
    const body = enterpriseInput(res, 'acceptInvite', req.body);
    if (!body) return;
    const { token } = body;
    const inv = token ? enterpriseReads.invites.byTokenHash(sha256(token)) : null;
    if (!inv || inv.status !== 'pending') return res.status(404).json({ error: 'INVITE_INVALID' });
    if (inv.expiresAt < Date.now()) {
      enterprise.invites.expire(inv.id);
      return res.status(410).json({ error: 'INVITE_EXPIRED' });
    }
    const org = byId.org(inv.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    const name = filled(body.scoutName) ?? inv.name;
    // Staff sign in by name, so a name belongs to one account of the organisation (removed ones included): the
    // invited name's account is bound when current and restored when removed (product decision), with the invite's
    // role; any other taken name is refused.
    let out;
    try {
      out = unit(() => {
        const at = Date.now();
        const existing = users.byOrgAndName(org.id, inv.name);
        let user;
        if (existing) {
          // A restored account starts without its old authenticator (the person may no longer have it); they set MFA up again.
          if (existing.removedAt && existing.mfa) users.disableMfa(existing.id);
          user = users.update(existing.id, (d) => {
            if (d.removedAt) {
              d.removedAt = null;
              d.removedById = null;
              d.role = inv.role;
            }
            d.email = inv.email; // bound by the invite: the basis for SSO linking
          });
        } else {
          user = users.create({ orgId: org.id, name, role: inv.role, email: inv.email, createdAt: at });
        }
        enterprise.invites.accept(inv.id, { userId: user.id, at });
        return { user, restored: !!existing?.removedAt, token: ctx.createSession('org', org.id, { userId: user.id }) };
      });
    } catch (e) {
      if (e?.code === 'STAFF_NAME_TAKEN')
        return res.status(409).json({
          error: 'STAFF_NAME_TAKEN',
          message:
            'Someone with this name is already on the staff — sign in with a different name (a middle initial, for example).',
        });
      if (e?.code === 'STAFF_EMAIL_TAKEN')
        return res
          .status(409)
          .json({ error: 'ALREADY_STAFF', message: 'Someone with this email is already on the staff.' });
      throw e;
    }
    const { user, restored } = out;
    res.status(201).json({
      userId: user.id,
      role: user.role,
      org: ctx.orgSafe(org),
      token: out.token,
      ...(restored ? { restored: true } : {}),
      onboarding: onboardingFor(org, user),
    });
  });

  function onboardingFor(org, user) {
    const staff = users.forOrg(org.id, { active: true });
    const leads = staff.filter((u) => isLead(u));
    const tasks = [
      {
        id: 'verify_org',
        label: 'Verify your organisation (company email domain)',
        done: !!org.verified,
        help: 'Trust & Safety reviews verification — required before any under-18 visibility.',
      },
      {
        id: 'safeguarding',
        label: 'Sign the safeguarding contract',
        done: !!org.safeguardingContractSigned,
        help: 'Required for under-18 access. The club safeguarding officer signs.',
      },
      {
        id: 'invite_staff',
        label: 'Invite your staff',
        done: staff.length > 1,
        help: 'Each person works under their own named account — no shared logins.',
      },
      {
        id: 'mfa_leads',
        label: 'Enable MFA for privileged accounts',
        done: leads.every((u) => u.mfa?.enabledAt),
        help: 'Leads approve signings and manage staff — protect those accounts first.',
      },
      {
        id: 'first_import',
        label: 'Import or add your player records',
        done: ctx.integrationReads.batches.hasCommitted(org.id) || ctx.integrationReads.prospects.anyForOrg(org.id),
        help: 'CSV import with dry-run preview, or add prospects by hand.',
      },
      {
        id: 'coverage_plan',
        label: 'Set up a coverage plan',
        done: ctx.insightReads.plans.countForOrg(org.id) > 0,
        help: 'Fixtures, assignments and observation tracking live under Coverage.',
      },
    ];
    return {
      tasks,
      complete: tasks.every((t) => t.done),
      roleHelp: isLead(user)
        ? 'As a lead you approve signings, manage staff and see restricted cases.'
        : 'As a scout you file assessments and observations; a lead reviews decisions.',
    };
  }
  orgRouter.get('/onboarding', (req, res) => res.json(onboardingFor(req.org, req.orgUser)));

  // ================================================== B. MFA + sessions
  const { mfaLocked, mfaFail } = ctx.mfaGuards;

  orgRouter.post('/mfa/setup', (req, res) => {
    if (!enterpriseInput(res, 'none', req.body)) return;
    if (req.orgUser.mfa?.enabledAt) return res.status(409).json({ error: 'MFA_ALREADY_ENABLED' });
    const secretB32 = b32encode(crypto.randomBytes(20));
    users.startMfa(req.orgUser.id, secretB32);
    res.json({
      secret: secretB32,
      otpauth: `otpauth://totp/ScoutBox:${encodeURIComponent(req.orgUser.name)}?secret=${secretB32}&issuer=ScoutBox`,
      note: 'Scan into an authenticator app, then confirm with POST /org/mfa/verify {code}. The secret is shown once.',
    });
  });

  orgRouter.post('/mfa/verify', (req, res) => {
    const body = enterpriseInput(res, 'mfaCode', req.body);
    if (!body) return;
    const secret = users.mfaSecretOf(req.orgUser.id);
    if (!secret || req.orgUser.mfa?.enabledAt) return res.status(409).json({ error: 'MFA_NOT_PENDING' });
    if (mfaLocked(req.orgUser.id))
      return res
        .status(429)
        .json({ error: 'MFA_LOCKED', message: 'Too many wrong codes — try again in a few minutes.' });
    if (!totpValid(secret, body.code)) {
      mfaFail(req.orgUser.id);
      return res.status(401).json({ error: 'MFA_CODE_WRONG' });
    }
    const plain = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    users.enableMfa(req.orgUser.id, {
      at: Date.now(),
      recoveryHashes: plain.map((c) => crypto.createHash('sha256').update(c).digest('hex')),
    });
    res.json({
      enabled: true,
      recoveryCodes: plain,
      note: 'Store these recovery codes now — each works once and they are never shown again.',
    });
  });

  orgRouter.post('/mfa/disable', (req, res) => {
    // Disabling needs a current valid code (proof of control).
    const body = enterpriseInput(res, 'mfaCode', req.body);
    if (!body) return;
    if (!req.orgUser.mfa?.enabledAt) return res.status(409).json({ error: 'MFA_NOT_ENABLED' });
    if (!totpValid(users.mfaSecretOf(req.orgUser.id), body.code))
      return res.status(401).json({ error: 'MFA_CODE_WRONG' });
    users.disableMfa(req.orgUser.id);
    res.json({ enabled: false });
  });

  orgRouter.put('/security', (req, res) => {
    if (!requireLead(req, res)) return;
    const body = enterpriseInput(res, 'security', req.body);
    if (!body) return;
    const updated = orgs.update(req.org.id, (d) => {
      d.mfaRequiredForLeads = body.mfaRequiredForLeads;
    });
    res.json({
      mfaRequiredForLeads: updated.mfaRequiredForLeads,
      note: 'Enforced at login: leads without MFA are asked to set it up before privileged actions.',
    });
  });

  // "Current" is decided by hashing the presented bearer token; sessions hold only hashes.
  orgRouter.get('/sessions', (req, res) => {
    const mine = sessions.listOrgUser(req.orgUser.id);
    const currentToken = (req.headers.authorization ?? '').slice(7);
    res.json({
      items: mine.map((s) => ({
        sid: s.sid,
        createdAt: s.createdAt,
        current: sessions.isCurrent(s, currentToken),
        via: s.via ?? 'password',
      })),
    });
  });

  orgRouter.post('/sessions/revoke', (req, res) => {
    const body = enterpriseInput(res, 'revokeSession', req.body);
    if (!body) return;
    const sid = body.sid ?? '';
    const revoked = sid ? sessions.revokeOwn(req.orgUser.id, sid) : 0;
    res.json({ revoked });
  });

  // ================================================== B2. SSO (local test IdP)
  orgRouter.get('/sso', (req, res) => {
    const cfg = enterpriseReads.sso.forOrg(req.org.id);
    res.json({
      config: cfg ?? null,
      available: DEV ? ['local-test-idp'] : [],
      note: cfg
        ? null
        : 'No identity provider configured. In this environment only the local test IdP is available — a corporate provider requires real OIDC credentials.',
    });
  });

  orgRouter.put('/sso', (req, res) => {
    if (!requireLead(req, res)) return;
    const body = enterpriseInput(res, 'sso', req.body);
    if (!body) return;
    const issuer = body.issuer ?? '';
    if (issuer !== 'local-test-idp') {
      return res.status(400).json({
        error: 'IDP_UNAVAILABLE',
        message:
          'Only the local test IdP exists in this environment. A real provider needs its issuer URL, client id and secret configured on the server.',
      });
    }
    if (!DEV) return res.status(403).json({ error: 'TEST_IDP_DEV_ONLY' });
    const cfg = enterprise.sso.configure({
      id: enterpriseReads.sso.forOrg(req.org.id) ? null : nextId('sso'),
      orgId: req.org.id,
      issuer,
      clientId: `scoutbox-${req.org.id}`,
      at: Date.now(),
    });
    res.json({ config: cfg });
  });

  // No fallback secret: unset, a random one is drawn at boot, so a code minted against a publicly known string never
  // verifies. The callback is also refused outside development, since the test IdP is the only issuer.
  const IDP_SECRET = process.env.TEST_IDP_SECRET || crypto.randomBytes(32).toString('hex');
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
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null;
    }
  };

  const testIdpOnly = (res) => {
    if (DEV) return false;
    res.status(403).json({
      error: 'SSO_PROVIDER_UNAVAILABLE',
      message:
        'Only the local test identity provider exists, and it is disabled outside development. Staff sign in with their organisation credentials.',
    });
    return true;
  };

  app.post('/auth/sso/start', (req, res) => {
    if (testIdpOnly(res)) return;
    const body = enterpriseInput(res, 'ssoStart', req.body);
    if (!body) return;
    const org = body.orgId ? byId.org(body.orgId) : null;
    const cfg = org && enterpriseReads.sso.forOrg(org.id);
    if (!cfg)
      return res
        .status(404)
        .json({ error: 'SSO_NOT_CONFIGURED', message: 'This organisation has no identity provider configured.' });
    // The browser gets the state and nonce; the row keeps only their hashes.
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const at = Date.now();
    enterprise.ssoStates.create({
      id: nextId('sst'),
      stateHash: sha256(state),
      nonceHash: sha256(nonce),
      orgId: org.id,
      createdAt: at,
      expiresAt: at + 10 * 60_000,
      usedAt: null,
    });
    res.json({ authUrl: `/testidp/authorize?client_id=${cfg.clientId}&state=${state}&nonce=${nonce}`, state });
  });

  if (DEV) {
    // Authenticates as whatever email the tester picks: it exists to exercise the relying-party logic.
    app.get('/testidp/authorize', (req, res) => {
      const query = enterpriseInput(res, 'testIdpQuery', req.query, 'query');
      if (!query) return;
      const { client_id: clientId, state, nonce, email, groups } = query;
      if (!clientId || !state || !nonce || !email)
        return res.status(400).json({ error: 'IDP_PARAMS', message: 'client_id, state, nonce, email required' });
      const code = signToken({
        typ: 'code',
        sub: `idp-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 12)}`,
        email,
        nonce,
        groups: (groups ?? '').split(',').filter(Boolean),
        iat: Date.now(),
        exp: Date.now() + 5 * 60_000,
      });
      res.json({ code, state });
    });
  }

  app.post('/auth/sso/callback', (req, res) => {
    if (testIdpOnly(res)) return;
    const body = enterpriseInput(res, 'ssoCallback', req.body);
    if (!body) return;
    const { code, state } = body;
    const st = state ? enterpriseReads.ssoStates.byStateHash(sha256(state)) : null;
    // Single use even on failure: the database decides, so two callbacks racing on one state cannot both pass.
    if (!st || st.usedAt || st.expiresAt < Date.now() || !enterprise.ssoStates.markUsed(st.id, Date.now())) {
      return res
        .status(401)
        .json({ error: 'SSO_STATE_INVALID', message: 'Unknown, expired or already-used state — restart the sign-in.' });
    }
    const tok = verifyToken(code);
    if (!tok || tok.typ !== 'code' || tok.exp < Date.now()) return res.status(401).json({ error: 'SSO_TOKEN_INVALID' });
    if (typeof tok.nonce !== 'string' || sha256(tok.nonce) !== st.nonceHash)
      return res
        .status(401)
        .json({ error: 'SSO_NONCE_MISMATCH', message: 'The token was not minted for this sign-in attempt.' });
    const org = byId.org(st.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    // Linking needs proof: the email was bound by an accepted invite (or a previous linked login). An assertion for
    // an email never invited links and creates nothing. The subject's linked account wins over the email match.
    const linked = typeof tok.sub === 'string' && tok.sub ? users.bySsoSubject(org.id, tok.sub) : null;
    const user =
      linked && !linked.removedAt
        ? linked
        : users.activeByEmail(org.id, typeof tok.email === 'string' ? tok.email : null);
    if (!user) {
      return res.status(403).json({
        error: 'SSO_NOT_LINKED',
        message:
          'No staff account with this email exists in the organisation. Ask a lead for an invitation — SSO never creates accounts by itself.',
      });
    }
    if (user.ssoSubject !== tok.sub) {
      // A subject still held by a removed account of the organisation is not moved.
      try {
        users.update(user.id, (d) => {
          d.ssoSubject = tok.sub;
        });
      } catch (e) {
        if (e?.code === 'STAFF_SSO_TAKEN')
          return res.status(409).json({
            error: 'SSO_LINK_CONFLICT',
            message: 'This identity-provider account is linked to another staff account of the organisation.',
          });
        throw e;
      }
    }
    // SSO group claims never grant ScoutBox privileges; role, verification and safeguarding approval have their own flows.
    res.json({
      userId: user.id,
      role: user.role,
      org: ctx.orgSafe(org),
      token: ctx.createSession('org', org.id, { userId: user.id, via: 'sso' }),
      ignoredClaims: tok.groups?.length
        ? { groups: tok.groups, note: 'Identity-provider groups are ignored for permissions.' }
        : null,
    });
  });

  // ================================================== C. audit + support
  orgRouter.get('/audit/export', (req, res) => {
    if (!requireLead(req, res)) return;
    const orgId = req.org.id;
    const scoped = {
      contract: 'audit-export.2026-09.v1',
      orgId,
      exportedAt: Date.now(),
      exportedBy: req.orgUser.name,
      ledger: safetyAudit.ledger.forOrg(orgId).map(ledgerExport),
      caseHistories: ctx.recruitmentReads.cases
        .forOrg(orgId)
        .map((c) => ({ id: c.id, playerId: c.playerId, history: c.history })),
      importHistories: ctx.integrationReads.batches.historiesForOrg(orgId),
      grantsGiven: ctx.groupReads.grants.allGivenBy(orgId).map(grantExport),
      grantsReceived: ctx.groupReads.grants.allReceivedBy(orgId).map(grantExport),
      supportAccess: enterpriseReads.grants.forOrg(orgId),
    };
    declareAuditedRead('an audit export is itself recorded');
    opsEvent({ id: nextId('ops'), at: Date.now(), kind: 'audit_export', detail: { orgId, by: req.orgUser.name } });
    res.json(scoped);
  });

  // A ticket references a case or an import of the organisation by id; nothing is copied.
  orgRouter.post('/support', (req, res) => {
    const input = enterpriseInput(res, 'ticket', req.body);
    if (!input) return;
    const subject = filled(input.subject);
    if (!presentOrRefuse(res, subject, 'subject')) return;
    const t = enterprise.tickets.create({
      id: nextId('tkt'),
      orgId: req.org.id,
      byUserId: req.orgUser.id,
      byName: req.orgUser.name ?? null,
      subject,
      body: input.body ?? '',
      refs: input.refs ?? [],
      status: 'open',
      replies: [],
      createdAt: Date.now(),
    });
    res.status(201).json({ ticket: t, note: 'Records are referenced by id — nothing was copied into the ticket.' });
  });

  orgRouter.get('/support', (req, res) => {
    const query = enterpriseInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json(enterpriseReads.tickets.page(req.org.id, page));
  });

  orgRouter.post('/support/:id/approve-access', (req, res) => {
    if (!requireLead(req, res)) return;
    if (!enterpriseInput(res, 'none', req.body)) return;
    const g = enterpriseReads.grants.pendingFor(req.org.id, req.params.id);
    if (!g) return res.status(404).json({ error: 'NO_PENDING_REQUEST' });
    res.json({ grant: enterprise.grants.approve(g.id, { by: req.orgUser.name ?? null, at: Date.now() }) });
  });

  adminRouter.get('/support', (req, res) => {
    const query = enterpriseInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const p = enterpriseReads.tickets.pageAll(page);
    res.json({
      items: p.items,
      nextCursor: p.nextCursor,
      grants: enterpriseReads.grants.forTickets(p.items.map((t) => t.id)),
    });
  });

  adminRouter.post('/support/:id/reply', (req, res) => {
    const t = enterpriseReads.tickets.byId(req.params.id);
    if (!t) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    const body = enterpriseInput(res, 'reply', req.body);
    if (!body) return;
    const text = filled(body.text);
    if (!presentOrRefuse(res, text, 'text', { error: 'FIELD_INVALID' })) return;
    const ticket = unit(() => {
      const out = enterprise.tickets.reply(
        t.id,
        { at: Date.now(), by: 'Trust & Safety', text },
        { close: body.close === true },
      );
      const lead = byId.user(t.byUserId);
      if (lead) notify({ kind: 'org_user', id: lead.id }, 'support', `Support replied on “${t.subject}”.`, t.id);
      return out;
    });
    res.json({ ticket });
  });

  adminRouter.post('/support/:id/request-access', (req, res) => {
    const t = enterpriseReads.tickets.byId(req.params.id);
    if (!t) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    const body = enterpriseInput(res, 'accessRequest', req.body);
    if (!body) return;
    const hours = body.hours ?? 24;
    const g = unit(() => {
      const out = enterprise.grants.request({
        id: nextId('sag'),
        ticketId: t.id,
        orgId: t.orgId,
        hours,
        status: 'requested',
        requestedAt: Date.now(),
        approvedBy: null,
        approvedAt: null,
        expiresAt: null,
        accessLog: [],
      });
      const lead = byId.user(t.byUserId);
      if (lead)
        notify(
          { kind: 'org_user', id: lead.id },
          'support',
          `Trust & Safety asks for time-limited access (${hours}h) to investigate “${t.subject}”. A lead can approve it from the Support screen.`,
          t.id,
        );
      return out;
    });
    res
      .status(201)
      .json({ grant: g, note: 'Access starts only after an organisation lead approves, and every read is logged.' });
  });

  // The only admin view into org-private records: needs an approved, unexpired grant, and every use is logged.
  adminRouter.get('/support/:id/org-records', (req, res) => {
    const t = enterpriseReads.tickets.byId(req.params.id);
    if (!t) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    const g = enterpriseReads.grants.liveFor(t.id, Date.now());
    if (!g)
      return res.status(403).json({
        error: 'SUPPORT_ACCESS_NOT_GRANTED',
        message: 'A lead of the organisation must approve time-limited access first. There is no silent access path.',
      });
    declareAuditedRead("support access to an organisation's records is logged");
    enterprise.grants.logAccess(g.id, { at: Date.now(), what: 'org-records' });
    const orgId = t.orgId;
    res.json({
      grant: { id: g.id, expiresAt: g.expiresAt },
      records: {
        refs: t.refs,
        cases: t.refs
          .filter((r) => r.kind === 'case')
          .map((r) => ctx.recruitmentReads.cases.byId(r.id))
          .filter((c) => c && c.orgId === orgId),
        imports: ctx.integrationReads.batches.forOrgByIds(
          orgId,
          t.refs.filter((r) => r.kind === 'import').map((r) => r.id),
        ),
      },
      note: 'Only records the ticket references, only while the grant lives, only logged.',
    });
  });

  // ================================================== D. backup + recovery
  function fileSha256(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }

  adminRouter.post('/backup', (req, res) => {
    if (!enterpriseInput(res, 'none', req.body)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(DATA_DIR, 'backups', stamp);
    // A restore is "copy this directory into a new, empty DATA_DIR and boot". A queued removal naming a clip a live
    // player still carries is a conflict to resolve, refused before any directory exists.
    const conflicts = mediaDeletions.conflicts();
    if (conflicts.length) {
      opsEvent({
        id: nextId('ops'),
        at: Date.now(),
        kind: 'backup_refused',
        detail: { dir: stamp, error: 'MEDIA_QUEUE_OWNERSHIP_CONFLICT', conflictCount: conflicts.length },
      });
      return res.status(409).json({
        error: 'MEDIA_QUEUE_OWNERSHIP_CONFLICT',
        message: `${conflicts.length} queued media removal(s) name a clip a live player still references; the backup was refused because it could neither copy the file as the player's nor leave it out as removed. Resolve the queue entry or the player's reference first.`,
        conflicts: conflicts.map((c) => ({ mediaId: c.media_id, owners: c.owners })),
      });
    }
    let manifest;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const databasePath = path.join(dir, 'scoutbox.db');
      // Read once: the copy carries this queue, and it decides which files are left out below.
      const queuedIds = new Set(mediaDeletions.pending().map((r) => r.media_id));
      backupDatabase(databasePath);
      // Files queued for removal are left out: a backup never carries a file without the intent to remove it. On a
      // restored server the queue entry clears once the file is confirmed absent, and the boot sweep removes a file
      // copied back by hand.
      const mediaSrc = path.join(DATA_DIR, 'media');
      const mediaDst = path.join(dir, 'media');
      const files = [];
      let leftOut = 0;
      if (fs.existsSync(mediaSrc)) {
        fs.mkdirSync(mediaDst, { recursive: true });
        for (const f of fs.readdirSync(mediaSrc)) {
          if (queuedIds.has(f.replace(/\.[^.]+$/, ''))) {
            leftOut += 1;
            continue;
          }
          fs.copyFileSync(path.join(mediaSrc, f), path.join(mediaDst, f));
          files.push({
            path: `media/${f}`,
            sha256: fileSha256(path.join(mediaDst, f)),
            bytes: fs.statSync(path.join(mediaDst, f)).size,
          });
        }
      }
      files.unshift({ path: 'scoutbox.db', sha256: fileSha256(databasePath), bytes: fs.statSync(databasePath).size });
      manifest = {
        contract: 'backup.2026-11.v2',
        createdAt: Date.now(),
        engine: 'sqlite database copy + media files',
        counts: {
          players: players.count(),
          retainedPlayers: players.retainedCount(),
          orgs: orgs.count(),
          notifications: notifications.count(),
          mediaFiles: files.length - 1,
        },
        media: {
          copied: files.length - 1,
          queuedForRemoval: leftOut,
          note: 'Files whose removal was committed but not yet completed are left out on purpose: their queue entries are in scoutbox.db, and the restored server serves nothing for them and finishes the removal at boot.',
        },
        files,
        secretsNote:
          'Backups contain NO server secrets (ADMIN_KEY, signing secrets live in env, never in the DB). Store backups with the same care as the live data directory.',
        restore:
          'Copy this directory to a NEW empty DATA_DIR and start the server with DATA_DIR pointing at it. Never restore over a live data directory.',
      };
      // Written last: a directory without a manifest is not a backup.
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    } catch (err) {
      // Nothing half-made is left behind looking usable.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      console.error(`backup failed (${stamp}): ${err?.message ?? err}`);
      opsEvent({
        id: nextId('ops'),
        at: Date.now(),
        kind: 'backup_failed',
        detail: { dir: stamp, error: String(err?.message ?? err).slice(0, 200) },
      });
      return res.status(500).json({
        error: 'BACKUP_FAILED',
        message: 'The backup could not be completed; the partial directory was removed.',
      });
    }
    opsEvent({
      id: nextId('ops'),
      at: Date.now(),
      kind: 'backup_created',
      detail: { dir: stamp, files: manifest.files.length, queuedForRemoval: manifest.media.queuedForRemoval },
    });
    res.status(201).json({ dir, manifest });
  });

  adminRouter.get('/backups', (_req, res) => {
    const root = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(root)) return res.json({ items: [] });
    res.json({
      items: fs
        .readdirSync(root)
        .sort()
        .reverse()
        .slice(0, 20)
        .map((d) => {
          try {
            return { dir: d, manifest: JSON.parse(fs.readFileSync(path.join(root, d, 'manifest.json'), 'utf8')) };
          } catch {
            return { dir: d, manifest: null };
          }
        }),
    });
  });

  adminRouter.post('/backup/verify', (req, res) => {
    const body = enterpriseInput(res, 'backupDir', req.body);
    if (!body) return;
    const dir = path.join(DATA_DIR, 'backups', path.basename(body.dir));
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      return res.status(404).json({ error: 'BACKUP_NOT_FOUND' });
    }
    const results = manifest.files.map((f) => {
      try {
        return { path: f.path, ok: fileSha256(path.join(dir, f.path)) === f.sha256 };
      } catch {
        return { path: f.path, ok: false, missing: true };
      }
    });
    res.json({ ok: results.every((r) => r.ok), results });
  });

  // ================================================== E. reliability
  // The schema version lets an operator see which schema this instance runs without reading the database.
  app.get('/healthz', (_req, res) =>
    res.json({
      ok: true,
      uptimeS: Math.round((Date.now() - metrics.startedAt) / 1000),
      schemaVersion: schemaVersion(),
    }),
  );

  app.get('/readyz', (_req, res) => {
    try {
      res.json({ ready: true, players: players.count() });
    } catch (err) {
      res.status(503).json({ ready: false, error: err.message });
    }
  });

  adminRouter.get('/metrics', (_req, res) => {
    res.json({
      ...metrics,
      deliveryFailures: safetyAudit.opsEvents.count('delivery_failed'),
      webhookFailures: safetyAudit.opsEvents.count('webhook_failed'),
      dispatchBacklog: dispatches.backlogCount(), // queued or retrying (a COUNT on the dispatches table)
      webhookBacklog: ctx.integrationReads.deliveries.backlogCount(), // queued or retrying
      opsEvents: safetyAudit.opsEvents.newest(50).map((e) => ({ id: e.id, at: e.at, kind: e.kind, detail: e.detail })),
      note: 'Counters cover this process since boot. Local development metrics — not a production SLA measurement.',
    });
  });
}
