// Organisation accounts: the session check in front of `/org`, the organisation as the apps see it, the sign-in
// pickers, Grassroots club registration, staff log-in (with the second factor) and the public club directory.
import crypto from 'node:crypto';
import express from 'express';
import { optText, reqText, badField } from '../platform/input.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { STAFF_LIMITS } from '../../repositories/users.mjs';
import { hashPassword, verifyPassword } from '../../adapters.mjs';
import { isLeadRole } from '../../roles.mjs';
import { totpValid } from '../../m13/shared.mjs';

/**
 * `orgSafe(org)`: the organisation as the apps see it, an allowlist (the password hash is never on the record). What
 * the club is looking for and its federation-route request are club setup rows, added explicitly.
 * `safeguardingCertified(org)`: earned and losable — verification, a signed contract and no unresolved urgent report.
 */
export function createOrgViews({ clubSetup, safetyAudit }) {
  function orgSafe(o) {
    const fed = clubSetup.federation.forOrg(o.id);
    return {
      id: o.id, name: o.name, type: o.type, level: o.level, plan: o.plan, country: o.country,
      location: o.location ? { lat: o.location.lat, lng: o.location.lng, city: o.location.city } : null,
      federationRef: o.federationRef ? { federation: o.federationRef.federation, registrationId: o.federationRef.registrationId } : null,
      trustedPartner: o.trustedPartner, verified: o.verified, verifiedDomain: o.verifiedDomain,
      safeguardingContractSigned: o.safeguardingContractSigned, suspended: o.suspended,
      emailDomain: o.emailDomain, emailDomainVerified: o.emailDomainVerified, mfaRequiredForLeads: o.mfaRequiredForLeads,
      verificationRevokedAt: o.verificationRevokedAt, createdAt: o.createdAt,
      lookingFor: [...clubSetup.lookingFor.forOrg(o.id)],
      federationCheck: fed ? { federation: fed.federation, registrationId: fed.registrationId, contactEmail: fed.contactEmail, status: fed.status, submittedAt: fed.submittedAt } : null,
    };
  }
  function safeguardingCertified(org) {
    if (!org.verified || !org.safeguardingContractSigned) return false;
    return !safetyAudit.reports.openUrgentAgainst(org.id);
  }
  return { orgSafe, safeguardingCertified };
}

/**
 * The `/org` router behind the session check, created before the domains that mount on it. A session is minted per
 * named staff member, so the token resolves to both the organisation and the person: no shared workspace access.
 */
export function createOrgSession({ app, findOrg, users, sessionFor }) {
  function orgAuth(req, res, next) {
    const session = sessionFor(req);
    if (session?.kind !== 'org') return res.status(401).json({ error: 'ORG_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
    const org = findOrg(session.refId);
    if (!org) return res.status(401).json({ error: 'ORG_AUTH_REQUIRED' });
    const user = users.byId(session.userId);
    if (!user || user.orgId !== org.id) return res.status(401).json({ error: 'USER_UNKNOWN' });
    if (user.removedAt) return res.status(401).json({ error: 'USER_REMOVED', message: 'Your access to this organisation has been removed.' });
    if (org.suspended) {
      return res.status(403).json({ error: 'ORG_SUSPENDED', message: 'This organisation is suspended pending a safety review.' });
    }
    req.org = org;
    req.orgUser = user;
    next();
  }
  const orgRouter = express.Router();
  app.use('/org', orgAuth, orgRouter);
  return { orgRouter };
}

/** The sign-in pickers, Grassroots registration and staff log-in, all on `app`. */
export function registerOrgAccount({
  app, orgs, users, safetyAudit, findOrg, unit, nextId, broadcast, createSession, loginLockedOut, noteLoginFailure,
  devLogins, devLoginRefused, mfaGuards, orgSafe, safeguardingCertified,
}) {
  if (typeof users?.setRole !== 'function' || typeof mfaGuards?.mfaLocked !== 'function') throw new TypeError('registerOrgAccount needs the staff repository and the MFA guards');

  app.get('/orgs', (req, res) => {
    // Platform separation starts at the login screen: the Grassroots app lists only grassroots clubs, the main app
    // never lists them, and the Agent app lists agency organisations only. Unpaged: the sign-in pickers have no
    // search yet (docs/known-issues.md).
    const filter = { grassroots: { level: 'grassroots' }, main: { notLevel: 'grassroots' }, agent: { type: 'agency' } }[req.query.platform] ?? {};
    const list = orgs.list(filter);
    res.json(list.map((o) => ({
      id: o.id, name: o.name, type: o.type, level: o.level ?? null, plan: o.plan, trustedPartner: o.trustedPartner,
      verified: o.verified, safeguardingCertified: safeguardingCertified(o),
      ...(o.level === 'grassroots' ? { city: o.location?.city ?? null, federation: o.federationRef?.federation ?? null } : {}),
    })));
  });

  // Registration is open to federation-registered grassroots clubs; verification (federation record, email domain,
  // safeguarding contract) is checked by T&S before the club can see any minor — the same bar every club faces.
  app.post('/auth/org/register-grassroots', (req, res) => {
    const { name, country = 'GB', city, lat, lng, federation, registrationId, scoutName, role, password } = req.body || {};
    if (password !== undefined && String(password).length < 8) {
      return res.status(400).json({ error: 'PASSWORD_TOO_SHORT', message: 'Club passwords need at least 8 characters.' });
    }
    if (!reqText(name, 120)) return res.status(400).json({ error: 'NAME_REQUIRED' });
    for (const [f, v, max] of [['country', country, 2], ['city', city, 80], ['federation', federation, 120], ['registrationId', registrationId, 60], ['role', role, 60]]) if (!optText(v, max)) return badField(res, f);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      if (typeof lat === 'number' || typeof lng === 'number') return badField(res, 'location');
    }
    if (typeof country !== 'string' || !country.trim() || country !== country.trim()) return badField(res, 'country');
    if (!federation?.trim() || !registrationId?.trim()) {
      return res.status(400).json({ error: 'FEDERATION_REQUIRED', message: 'Grassroots clubs must hold a federation registration — name the federation and your registration id.' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'LOCATION_REQUIRED', message: 'The 50km scouting radius is measured from your ground — a location is required.' });
    }
    if (!reqText(scoutName, 120)) return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED' });
    const { org, user, token } = unit(() => {
      const created = orgs.create({
        name: name.trim(),
        type: 'club',
        level: 'grassroots',
        location: { lat, lng, city: city?.trim() || null },
        federationRef: { federation: federation.trim(), registrationId: registrationId.trim() },
        plan: 'Grassroots',
        country,
        passwordHash: password ? hashPassword(String(password)) : null,
      });
      const admin = users.create({ orgId: created.id, name: scoutName.trim(), role: role?.trim() || 'Manager' });
      return { org: created, user: admin, token: createSession('org', created.id, { userId: admin.id }) };
    });
    broadcast('orgs');
    res.status(201).json({
      userId: user.id, role: user.role, org: { ...orgSafe(org), safeguardingCertified: safeguardingCertified(org) },
      token,
      note: 'Registered. Adults within 50km are visible now; under-18 visibility needs verification + the safeguarding contract, reviewed by Trust & Safety.',
    });
  });

  app.post('/auth/org/login', (req, res) => {
    const { orgId, scoutName, role, platform } = req.body || {};
    if (loginLockedOut(res, `org:${orgId}`)) return;
    const org = findOrg(orgId);
    if (!org) { noteLoginFailure(`org:${orgId}`); return res.status(404).json({ error: 'ORG_NOT_FOUND' }); }
    // Hard platform separation: a grassroots club exists only on ScoutBox Grassroots; every other org exists only on
    // ScoutBox. An agency can still log into the club app, where its representation lane lives.
    const wantsGrassroots = platform === 'grassroots';
    if (org.level === 'grassroots' && !wantsGrassroots) {
      return res.status(403).json({ error: 'GRASSROOTS_PLATFORM_ONLY', message: 'This club is registered on ScoutBox Grassroots — log in there.' });
    }
    if (org.level !== 'grassroots' && wantsGrassroots) {
      return res.status(403).json({ error: 'PLATFORM_MISMATCH', message: 'ScoutBox Grassroots is for federation-registered grassroots clubs only.' });
    }
    if (platform === 'agent' && org.type !== 'agency') {
      return res.status(403).json({ error: 'PLATFORM_MISMATCH', message: 'ScoutBox Agent is for agency organisations only.' });
    }
    if (!optText(role, 60)) return badField(res, 'role');
    if (typeof scoutName !== 'string' || !scoutName.trim()) {
      return res.status(400).json({ error: 'SCOUT_NAME_REQUIRED', message: 'Every session is attributed to a named individual.' });
    }
    if (scoutName.trim().length > STAFF_LIMITS.name) return res.status(400).json({ error: 'FIELD_INVALID', field: 'scoutName', message: `scoutName is at most ${STAFF_LIMITS.name} characters.` });
    // Provisioned orgs require their password; unprovisioned (seeded demo) orgs are a development shortcut only.
    const passwordHash = orgs.passwordHashOf(org.id);
    if (passwordHash) {
      const check = verifyPassword(req.body?.password ?? '', passwordHash);
      if (!check) { noteLoginFailure(`org:${orgId}`); return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This organisation is password-protected.' }); }
      if (check === 'upgrade') orgs.setPasswordHash(org.id, hashPassword(req.body.password));
    } else if (!devLogins) {
      return devLoginRefused(res);
    }
    let user = users.byOrgAndName(orgId, scoutName);
    if (user?.removedAt) {
      return res.status(403).json({ error: 'USER_REMOVED', message: 'This staff member\'s access was removed by the organisation.' });
    }
    // A user who enabled MFA never gets a session from the password alone; recovery codes are one-time; wrong codes
    // count towards the lock.
    if (user?.mfa?.enabledAt) {
      if (mfaGuards.mfaLocked(user.id)) {
        return res.status(429).json({ error: 'MFA_LOCKED', message: 'Too many wrong codes — try again in a few minutes.' });
      }
      const { mfaCode, recoveryCode } = req.body ?? {};
      let second = false;
      if (mfaCode) second = totpValid(users.mfaSecretOf(user.id), mfaCode);
      else if (recoveryCode) {
        // Spending a code deletes its row, and only the call that deleted it passes.
        second = users.useRecoveryCode(user.id, crypto.createHash('sha256').update(String(recoveryCode)).digest('hex'));
      }
      if (!second) {
        if (mfaCode || recoveryCode) mfaGuards.mfaFail(user.id);
        return res.status(401).json({
          error: mfaCode || recoveryCode ? 'MFA_CODE_WRONG' : 'MFA_REQUIRED',
          message: mfaCode || recoveryCode ? 'That code is not valid.' : 'This account uses two-factor authentication — send mfaCode (authenticator) or recoveryCode.',
        });
      }
      mfaGuards.clear(user.id);
    }
    // Roles are assigned by the organisation, never by the person logging in. An organisation with real credentials
    // gets staff accounts only through server-controlled flows: the registering administrator, a lead's invitation,
    // or — exactly once — the first login with the organisation password, which bootstraps the administrator of an
    // organisation provisioned without one. The role sent with a login is ignored there, so nobody with the shared
    // password can make themselves staff or rewrite another person's role. Unprovisioned (seeded demo) organisations
    // keep the development shortcut: a login names its own role. That path is refused outside development above.
    const credentialed = !!passwordHash;
    let roleNote;
    if (!user) {
      if (credentialed) {
        if (users.firstActive(orgId)) {
          return res.status(403).json({
            error: 'STAFF_NOT_PROVISIONED',
            message: 'No staff account with this name exists in the organisation. Ask a lead for an invitation — the organisation password does not create accounts.',
          });
        }
        // A lead-tier role is required so the organisation can invite its staff.
        const requested = (role || '').trim();
        user = unit(() => {
          const created = users.create({
            orgId, name: scoutName.trim(),
            role: isLeadRole(requested) ? requested : 'Manager',
            provenance: 'org_password_bootstrap',
          });
          safetyAudit.opsEvents.record({ id: nextId('ops'), at: Date.now(), kind: 'staff_bootstrapped', detail: { orgId: org.id, userId: created.id, by: created.name } });
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
      userId: user.id, role: user.role,
      org: { ...orgSafe(org), safeguardingCertified: safeguardingCertified(org) },
      token: createSession('org', org.id, { userId: user.id }),
      ...(roleNote ? { roleNote } : {}),
      // A policy nudge, never a lockout: existing users keep access and are steered through MFA setup.
      mfaSetupRequired: !!(org.mfaRequiredForLeads && user && isLeadRole(user.role) && !user.mfa?.enabledAt) || undefined,
    });
  });
}

/**
 * The club directory players browse: verified identity and how clubs actually behave (trials run, report turnaround).
 * Grassroots clubs wear their development record instead of resale multiples. Paged by cursor, oldest club first.
 */
export function registerClubDirectory({ app, orgs, trialsForOrg, safeguardingCertified, pathwayRecord }) {
  app.get('/orgs/directory', (req, res) => {
    let page;
    try { page = orgs.page({ type: 'club' }, readPage(req.query, ['number'])); } catch (e) { return sendPageError(res, e); }
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((o) => {
        const trials = trialsForOrg(o.id);
        const reported = trials.filter((t) => t.status === 'reported' && t.report);
        const avgReportDays = reported.length
          ? Math.round(reported.reduce((sum, t) => sum + (t.report.filedAt - t.acceptedAt), 0) / reported.length / (24 * 3600 * 1000) * 10) / 10
          : null;
        return {
          id: o.id, name: o.name, plan: o.plan, verified: o.verified,
          trustedPartner: o.trustedPartner, safeguardingCertified: safeguardingCertified(o),
          trialsRun: trials.length, reportsFiled: reported.length, avgReportDays,
          ...(o.level === 'grassroots' ? pathwayRecord(o) : {}),
        };
      }),
    });
  });
}
