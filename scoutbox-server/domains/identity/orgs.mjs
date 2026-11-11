import crypto from 'node:crypto';
import express from 'express';
import { filled } from '../platform/schemas.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { hashPassword, verifyPassword } from '../../adapters.mjs';
import { isLeadRole } from '../../roles.mjs';
import { totpValid } from './totp.mjs';
import { identityInput, PASSWORD_MIN } from './schemas.mjs';

/**
 * `orgSafe` is an allowlist (the password hash is never on the record). `safeguardingCertified` is earned and
 * losable: verification, a signed contract and no unresolved urgent report.
 */
export function createOrgViews({ clubSetup, safetyAudit }) {
  function orgSafe(o) {
    const fed = clubSetup.federation.forOrg(o.id);
    return {
      id: o.id,
      name: o.name,
      type: o.type,
      level: o.level,
      plan: o.plan,
      country: o.country,
      location: o.location ? { lat: o.location.lat, lng: o.location.lng, city: o.location.city } : null,
      federationRef: o.federationRef
        ? { federation: o.federationRef.federation, registrationId: o.federationRef.registrationId }
        : null,
      trustedPartner: o.trustedPartner,
      verified: o.verified,
      verifiedDomain: o.verifiedDomain,
      safeguardingContractSigned: o.safeguardingContractSigned,
      suspended: o.suspended,
      emailDomain: o.emailDomain,
      emailDomainVerified: o.emailDomainVerified,
      mfaRequiredForLeads: o.mfaRequiredForLeads,
      verificationRevokedAt: o.verificationRevokedAt,
      createdAt: o.createdAt,
      lookingFor: [...clubSetup.lookingFor.forOrg(o.id)],
      federationCheck: fed
        ? {
            federation: fed.federation,
            registrationId: fed.registrationId,
            contactEmail: fed.contactEmail,
            status: fed.status,
            submittedAt: fed.submittedAt,
          }
        : null,
    };
  }
  function safeguardingCertified(org) {
    if (!org.verified || !org.safeguardingContractSigned) return false;
    return !safetyAudit.reports.openUrgentAgainst(org.id);
  }
  return { orgSafe, safeguardingCertified };
}

/** A session is minted per named staff member, so the token resolves to the organisation and the person. */
export function createOrgSession({ app, findOrg, users, sessionFor }) {
  function orgAuth(req, res, next) {
    const session = sessionFor(req);
    if (session?.kind !== 'org')
      return res
        .status(401)
        .json({ error: 'ORG_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
    const org = findOrg(session.refId);
    if (!org) return res.status(401).json({ error: 'ORG_AUTH_REQUIRED' });
    const user = users.byId(session.userId);
    if (!user || user.orgId !== org.id) return res.status(401).json({ error: 'USER_UNKNOWN' });
    if (user.removedAt)
      return res
        .status(401)
        .json({ error: 'USER_REMOVED', message: 'Your access to this organisation has been removed.' });
    if (org.suspended) {
      return res
        .status(403)
        .json({ error: 'ORG_SUSPENDED', message: 'This organisation is suspended pending a safety review.' });
    }
    req.org = org;
    req.orgUser = user;
    next();
  }
  const orgRouter = express.Router();
  app.use('/org', orgAuth, orgRouter);
  return { orgRouter };
}

export function registerOrgAccount({
  app,
  orgs,
  users,
  safetyAudit,
  findOrg,
  unit,
  nextId,
  broadcast,
  createSession,
  loginLockedOut,
  noteLoginFailure,
  devLogins,
  devLoginRefused,
  mfaGuards,
  orgSafe,
  safeguardingCertified,
}) {
  if (typeof users?.setRole !== 'function' || typeof mfaGuards?.mfaLocked !== 'function')
    throw new TypeError('registerOrgAccount needs the staff repository and the MFA guards');

  app.get('/orgs', (req, res) => {
    const query = identityInput(res, 'orgsQuery', req.query, 'query');
    if (!query) return;
    // The Grassroots app lists only grassroots clubs, the main app never lists them, and the Agent app lists agencies
    // only. Unpaged: the sign-in pickers have no search yet (docs/known-issues.md).
    const filter =
      { grassroots: { level: 'grassroots' }, main: { notLevel: 'grassroots' }, agent: { type: 'agency' } }[
        query.platform
      ] ?? {};
    const list = orgs.list(filter);
    res.json(
      list.map((o) => ({
        id: o.id,
        name: o.name,
        type: o.type,
        level: o.level ?? null,
        plan: o.plan,
        trustedPartner: o.trustedPartner,
        verified: o.verified,
        safeguardingCertified: safeguardingCertified(o),
        ...(o.level === 'grassroots'
          ? { city: o.location?.city ?? null, federation: o.federationRef?.federation ?? null }
          : {}),
      })),
    );
  });

  // T&S verifies the club (federation record, email domain, safeguarding contract) before it can see any minor.
  app.post('/auth/org/register-grassroots', (req, res) => {
    const body = identityInput(res, 'registerGrassroots', req.body);
    if (!body) return;
    const { country = 'GB', lat, lng, password } = body;
    const name = filled(body.name);
    const federation = filled(body.federation);
    const registrationId = filled(body.registrationId);
    const scoutName = filled(body.scoutName);
    if (password != null && password.length < PASSWORD_MIN) {
      return res
        .status(400)
        .json({ error: 'PASSWORD_TOO_SHORT', message: 'Club passwords need at least 8 characters.' });
    }
    if (!name) return res.status(400).json({ error: 'NAME_REQUIRED' });
    if (!country.trim() || country !== country.trim())
      return res.status(400).json({
        error: 'FIELD_INVALID',
        field: 'country',
        problem: 'invalid',
        message: 'country must be a country code.',
      });
    if (!federation || !registrationId) {
      return res.status(400).json({
        error: 'FEDERATION_REQUIRED',
        message: 'Grassroots clubs must hold a federation registration — name the federation and your registration id.',
      });
    }
    if (lat == null || lng == null) {
      return res.status(400).json({
        error: 'LOCATION_REQUIRED',
        message: 'The 50km scouting radius is measured from your ground — a location is required.',
      });
    }
    if (!scoutName) return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED' });
    const { org, user, token } = unit(() => {
      const created = orgs.create({
        name,
        type: 'club',
        level: 'grassroots',
        location: { lat, lng, city: filled(body.city) },
        federationRef: { federation, registrationId },
        plan: 'Grassroots',
        country,
        passwordHash: password ? hashPassword(password) : null,
      });
      const admin = users.create({ orgId: created.id, name: scoutName, role: filled(body.role) ?? 'Manager' });
      return { org: created, user: admin, token: createSession('org', created.id, { userId: admin.id }) };
    });
    broadcast('orgs');
    res.status(201).json({
      userId: user.id,
      role: user.role,
      org: { ...orgSafe(org), safeguardingCertified: safeguardingCertified(org) },
      token,
      note: 'Registered. Adults within 50km are visible now; under-18 visibility needs verification + the safeguarding contract, reviewed by Trust & Safety.',
    });
  });

  app.post('/auth/org/login', (req, res) => {
    const body = identityInput(res, 'orgLogin', req.body);
    if (!body) return;
    const { orgId, scoutName, role, platform } = body;
    if (loginLockedOut(res, `org:${orgId}`)) return;
    const org = orgId ? findOrg(orgId) : null;
    if (!org) {
      noteLoginFailure(`org:${orgId}`);
      return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    }
    // A grassroots club exists only on ScoutBox Grassroots and every other org only on ScoutBox. An agency can still
    // log into the club app, where its representation lane lives.
    const wantsGrassroots = platform === 'grassroots';
    if (org.level === 'grassroots' && !wantsGrassroots) {
      return res.status(403).json({
        error: 'GRASSROOTS_PLATFORM_ONLY',
        message: 'This club is registered on ScoutBox Grassroots — log in there.',
      });
    }
    if (org.level !== 'grassroots' && wantsGrassroots) {
      return res.status(403).json({
        error: 'PLATFORM_MISMATCH',
        message: 'ScoutBox Grassroots is for federation-registered grassroots clubs only.',
      });
    }
    if (platform === 'agent' && org.type !== 'agency') {
      return res
        .status(403)
        .json({ error: 'PLATFORM_MISMATCH', message: 'ScoutBox Agent is for agency organisations only.' });
    }
    if (!filled(scoutName)) {
      return res
        .status(400)
        .json({ error: 'SCOUT_NAME_REQUIRED', message: 'Every session is attributed to a named individual.' });
    }
    // Unprovisioned (seeded demo) orgs skip the password as a development shortcut only.
    const passwordHash = orgs.passwordHashOf(org.id);
    if (passwordHash) {
      const check = verifyPassword(body.password ?? '', passwordHash);
      if (!check) {
        noteLoginFailure(`org:${orgId}`);
        return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This organisation is password-protected.' });
      }
      if (check === 'upgrade') orgs.setPasswordHash(org.id, hashPassword(body.password));
    } else if (!devLogins) {
      return devLoginRefused(res);
    }
    let user = users.byOrgAndName(orgId, scoutName);
    if (user?.removedAt) {
      return res
        .status(403)
        .json({ error: 'USER_REMOVED', message: "This staff member's access was removed by the organisation." });
    }
    // With MFA enabled the password alone never gets a session; recovery codes are one-time.
    if (user?.mfa?.enabledAt) {
      if (mfaGuards.mfaLocked(user.id)) {
        return res
          .status(429)
          .json({ error: 'MFA_LOCKED', message: 'Too many wrong codes — try again in a few minutes.' });
      }
      const { mfaCode, recoveryCode } = body;
      let second = false;
      if (mfaCode) second = totpValid(users.mfaSecretOf(user.id), mfaCode);
      else if (recoveryCode) {
        // Only the call that deleted the code's row passes.
        second = users.useRecoveryCode(user.id, crypto.createHash('sha256').update(recoveryCode).digest('hex'));
      }
      if (!second) {
        if (mfaCode || recoveryCode) mfaGuards.mfaFail(user.id);
        return res.status(401).json({
          error: mfaCode || recoveryCode ? 'MFA_CODE_WRONG' : 'MFA_REQUIRED',
          message:
            mfaCode || recoveryCode
              ? 'That code is not valid.'
              : 'This account uses two-factor authentication — send mfaCode (authenticator) or recoveryCode.',
        });
      }
      mfaGuards.clear(user.id);
    }
    // An organisation with real credentials gets staff accounts only through server-controlled flows: the registering
    // administrator, a lead's invitation, or once, the first login with the organisation password, which bootstraps
    // an administrator. The role sent with that login is ignored, so nobody with the shared password can make
    // themselves staff or rewrite another's role. Seeded demo organisations let a login name its own role, refused
    // outside development above.
    const credentialed = !!passwordHash;
    let roleNote;
    if (!user) {
      if (credentialed) {
        if (users.firstActive(orgId)) {
          return res.status(403).json({
            error: 'STAFF_NOT_PROVISIONED',
            message:
              'No staff account with this name exists in the organisation. Ask a lead for an invitation — the organisation password does not create accounts.',
          });
        }
        // A lead-tier role, so the organisation can invite its staff.
        const requested = (role || '').trim();
        user = unit(() => {
          const created = users.create({
            orgId,
            name: scoutName.trim(),
            role: isLeadRole(requested) ? requested : 'Manager',
            provenance: 'org_password_bootstrap',
          });
          safetyAudit.opsEvents.record({
            id: nextId('ops'),
            at: Date.now(),
            kind: 'staff_bootstrapped',
            detail: { orgId: org.id, userId: created.id, by: created.name },
          });
          return created;
        });
      } else {
        user = users.create({ orgId, name: scoutName.trim(), role: role?.trim() || 'Scout' });
      }
    } else if (role && role.trim() && role.trim() !== user.role) {
      if (credentialed) {
        roleNote = 'Roles are assigned by your organisation; the role entered at sign-in was not applied.';
      } else {
        user = users.setRole(user.id, role.trim()); // the development shortcut above
      }
    }
    res.json({
      userId: user.id,
      role: user.role,
      org: { ...orgSafe(org), safeguardingCertified: safeguardingCertified(org) },
      token: createSession('org', org.id, { userId: user.id }),
      ...(roleNote ? { roleNote } : {}),
      // A nudge, not a lockout.
      mfaSetupRequired:
        !!(org.mfaRequiredForLeads && user && isLeadRole(user.role) && !user.mfa?.enabledAt) || undefined,
    });
  });
}

/**
 * Verified identity and how clubs actually behave (trials run, report turnaround). Grassroots clubs show their
 * development record instead of resale multiples.
 */
export function registerClubDirectory({ app, orgs, trialsForOrg, safeguardingCertified, pathwayRecord }) {
  app.get('/orgs/directory', (req, res) => {
    const query = identityInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = orgs.page({ type: 'club' }, readPage(query, ['number']));
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((o) => {
        const trials = trialsForOrg(o.id);
        const reported = trials.filter((t) => t.status === 'reported' && t.report);
        const avgReportDays = reported.length
          ? Math.round(
              (reported.reduce((sum, t) => sum + (t.report.filedAt - t.acceptedAt), 0) /
                reported.length /
                (24 * 3600 * 1000)) *
                10,
            ) / 10
          : null;
        return {
          id: o.id,
          name: o.name,
          plan: o.plan,
          verified: o.verified,
          trustedPartner: o.trustedPartner,
          safeguardingCertified: safeguardingCertified(o),
          trialsRun: trials.length,
          reportsFiled: reported.length,
          avgReportDays,
          ...(o.level === 'grassroots' ? pathwayRecord(o) : {}),
        };
      }),
    });
  });
}
