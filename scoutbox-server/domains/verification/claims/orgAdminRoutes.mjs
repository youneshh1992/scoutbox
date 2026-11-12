import { filled, inputOrRefuse } from '../../platform/schemas.mjs';
import { emailProblem, domainOfEmail, isFreeMail, isDisposable, normalizeDomain, domainCovered } from './shared.mjs';
import { VERIFICATION_LIMITS as L } from '../../../repositories/verification.mjs';
import {
  ADMIN_GRANT_CODES,
  AdminGrant,
  Code,
  Conflict,
  CONFLICT_CODES,
  DOMAIN_CODES,
  NewDomain,
  Reason,
} from './organisationInput.mjs';

export function registerOrgAdminRoutes(ctx) {
  const {
    byId,
    createClaim,
    hasVerLevel,
    mailer,
    mintToken,
    nextId,
    notify,
    onlyOrg,
    orgRouter,
    peekToken,
    reads,
    requireVer,
    unit,
    useToken,
    verEvent,
    verification,
    verifiedDomainsOf,
    vmetric,
  } = ctx;
  orgRouter.get('/verification/domains', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    res.json({
      domains: reads.domains.forOrg(req.org.id),
      requests: reads.domainRequests.forOrg(req.org.id),
    });
  });

  orgRouter.post('/verification/domains', async (req, res) => {
    if (!requireVer(req, res, 'verification_admin')) return;
    const body = inputOrRefuse(res, NewDomain, req.body ?? {}, DOMAIN_CODES);
    if (!body) return;
    const domain = normalizeDomain(body.domain);
    const challengeEmail = (body.challengeEmail ?? '').trim().toLowerCase();
    if (!domain || !domain.includes('.') || domain.length > L.domain)
      return res.status(400).json({ error: 'DOMAIN_INVALID' });
    if (isFreeMail(domain) || isDisposable(domain))
      return res.status(422).json({
        error: 'SHARED_PROVIDER_DOMAIN',
        message: 'Free/shared email providers cannot be organisation domains.',
      });
    const mine = verifiedDomainsOf(req.org.id);
    if (reads.domains.has(req.org.id, domain)) return res.status(409).json({ error: 'DOMAIN_EXISTS' });
    const otherOrg = reads.domains.verifiedElsewhere(domain, req.org.id);
    const verifiedRoot = mine.find((d) => domainCovered(domain, d));
    const highRisk = !verifiedRoot || !!otherOrg; // first/root domain or contested → human review
    const reasons = [
      ...(otherOrg ? ['DOMAIN_OWNERSHIP_AMBIGUOUS'] : []),
      ...(!verifiedRoot ? ['HIGH_RISK_ADMIN_CHANGE'] : []),
    ];
    let status = highRisk ? 'requires_human_review' : 'email_challenge';
    const challengeOk =
      status === 'email_challenge' && !emailProblem(challengeEmail) && domainOfEmail(challengeEmail) === domain;
    if (status === 'email_challenge' && !challengeOk) {
      status = 'requires_human_review';
      if (!reasons.includes('DOMAIN_OWNERSHIP_AMBIGUOUS')) reasons.push('DOMAIN_OWNERSHIP_AMBIGUOUS');
    }
    const id = nextId('vdom');
    const r = unit(() => {
      const created = verification.domainRequests.create({
        id,
        orgId: req.org.id,
        domain,
        requestedBy: req.orgUser.id,
        status,
        reviewReasons: reasons,
        method: null,
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        decidedById: null,
      });
      verEvent(
        'organisation.domain_added',
        { orgId: req.org.id, after: { domain, status: highRisk ? 'requires_human_review' : 'email_challenge' } },
        req,
      );
      return created;
    });
    if (challengeOk) {
      const secret = mintToken({ purpose: 'domain_email', email: challengeEmail, orgId: req.org.id, refId: r.id });
      await mailer.send({
        to: challengeEmail,
        subject: `Confirm ${domain} for ${req.org.name} on ScoutBox`,
        text: `Confirmation code for adding ${domain} as an official ${req.org.name} domain: ${secret}\n\nSingle use, expires in 30 minutes.`,
      });
    }
    res.status(201).json({
      request: r,
      note:
        r.status === 'requires_human_review'
          ? 'Root or contested domain changes are reviewed by Trust & Safety before they take effect.'
          : 'A confirmation code went to the mailbox on that domain.',
    });
  });

  orgRouter.post('/verification/domains/:id/confirm', (req, res) => {
    if (!requireVer(req, res, 'verification_admin')) return;
    const r = onlyOrg(req, reads.domainRequests.byId(req.params.id));
    if (!r) return res.status(404).json({ error: 'DOMAIN_REQUEST_NOT_FOUND' });
    if (r.status !== 'email_challenge') return res.status(409).json({ error: 'NOT_IN_EMAIL_CHALLENGE' });
    const body = inputOrRefuse(res, Code, req.body ?? {});
    if (!body) return;
    const peek = peekToken({ purpose: 'domain_email', secret: body.code });
    if (peek.error || peek.token.refId !== r.id) {
      if (!peek.error) useToken(peek.token); // a valid code for another request is spent
      vmetric('emailChallengeFailures');
      return res.status(401).json({ error: peek.error ?? 'TOKEN_WRONG_PURPOSE' });
    }
    unit(() => {
      useToken(peek.token);
      verification.domainRequests.confirmByEmail(r.id, { at: Date.now() });
      if (!reads.domains.has(req.org.id, r.domain))
        verification.domains.add(req.org.id, {
          domain: r.domain,
          status: 'verified',
          method: 'official_domain_email',
          verifiedAt: Date.now(),
          addedBy: req.orgUser.id,
        });
      createClaim(
        {
          subjectType: 'org',
          subjectId: req.org.id,
          claimType: 'ORGANISATION_DOMAIN',
          organisationId: req.org.id,
          status: 'verified',
          verificationMethod: 'official_domain_email',
          verifiedAt: Date.now(),
          verifiedBy: { kind: 'org_admin', id: req.orgUser.id },
          metadata: { domain: r.domain },
        },
        req,
      );
      verEvent('organisation.domain_verified', { orgId: req.org.id, after: { domain: r.domain } }, req);
    });
    res.json({ domain: r.domain, status: 'verified' });
  });

  orgRouter.post('/verification/domains/:id/remove', (req, res) => {
    const list = reads.domains.forOrg(req.org.id);
    const d = list.find((x) => x.domain === normalizeDomain(req.params.id) || x.domain === req.params.id);
    if (!d) return res.status(404).json({ error: 'DOMAIN_NOT_FOUND' });
    const isRoot = !list.some((o) => o.domain !== d.domain && d.domain.endsWith(`.${o.domain}`));
    if (!requireVer(req, res, isRoot ? 'verification_root_admin' : 'verification_admin', { root: isRoot })) return;
    unit(() => {
      verification.domains.remove(req.org.id, d.domain);
      verEvent('organisation.domain_removed', { orgId: req.org.id, before: { domain: d.domain } }, req);
    });
    res.json({ removed: d.domain });
  });

  // ======================================== verification administrators
  orgRouter.get('/verification/admins', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    res.json({
      items: reads.admins.forOrg(req.org.id).map((a) => ({
        ...a,
        person: { id: a.userId, name: byId.user(a.userId)?.name ?? '(removed)' },
      })),
      transfers: reads.rootTransfers.forOrg(req.org.id),
    });
  });

  orgRouter.post('/verification/admins', (req, res) => {
    const body = inputOrRefuse(res, AdminGrant, req.body ?? {}, ADMIN_GRANT_CODES);
    if (!body) return;
    const { userId, level } = body;
    const needsRoot = ['verification_admin', 'verification_root_admin'].includes(level);
    if (!requireVer(req, res, needsRoot ? 'verification_root_admin' : 'verification_admin', { root: needsRoot }))
      return;
    if (userId === req.orgUser.id) {
      verEvent(
        'security.self_verification_blocked',
        { orgId: req.org.id, subjectId: userId, reason: 'self-promotion attempt' },
        req,
      );
      return res
        .status(403)
        .json({ error: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot change your own verification authority.' });
    }
    const target = byId.user(userId, (u) => u.orgId === req.org.id && !u.removedAt);
    if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (level === 'verification_root_admin') {
      // Dual control: a second root admin (or Trust & Safety) must approve.
      if (reads.rootTransfers.hasPending(req.org.id)) {
        return res.status(409).json({ error: 'TRANSFER_ALREADY_PENDING' });
      }
      const t = unit(() => {
        const created = verification.rootTransfers.create({
          id: nextId('vrtx'),
          orgId: req.org.id,
          toUserId: userId,
          proposedBy: req.orgUser.id,
          status: 'pending',
          createdAt: Date.now(),
          approvedBy: null,
          approvedAt: null,
        });
        verEvent(
          'admin.invited',
          { orgId: req.org.id, subjectId: userId, after: { level, dualControl: 'pending' } },
          req,
        );
        return created;
      });
      return res.status(202).json({
        transfer: t,
        note: 'Root authority changes need a second approval: another root administrator, or Trust & Safety.',
      });
    }
    if (reads.admins.activeFor(req.org.id, userId).some((a) => a.level === level)) {
      return res.status(409).json({ error: 'ALREADY_GRANTED' });
    }
    const a = unit(() => {
      const created = verification.admins.create({
        id: nextId('vadm'),
        orgId: req.org.id,
        userId,
        level,
        status: 'active',
        invitedBy: req.orgUser.id,
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        revokedAt: null,
        revokedBy: null,
      });
      verEvent('admin.accepted', { orgId: req.org.id, subjectId: userId, after: { level } }, req);
      notify(
        { kind: 'org_user', id: userId },
        'verification',
        `You now hold ${level.replace(/_/g, ' ')} authority for ${req.org.name}.`,
        created.id,
      );
      return created;
    });
    res.status(201).json({ admin: a });
  });

  orgRouter.post('/verification/root-transfers/:id/approve', (req, res) => {
    if (!requireVer(req, res, 'verification_root_admin', { root: true })) return;
    const t = onlyOrg(req, reads.rootTransfers.byId(req.params.id));
    if (!t) return res.status(404).json({ error: 'TRANSFER_NOT_FOUND' });
    if (t.status !== 'pending') return res.status(409).json({ error: 'TRANSFER_NOT_PENDING' });
    if (t.proposedBy === req.orgUser.id) {
      return res.status(403).json({
        error: 'DUAL_CONTROL_REQUIRED',
        message: 'The approver must be a different root administrator than the proposer.',
      });
    }
    if (t.toUserId === req.orgUser.id) {
      return res.status(403).json({
        error: 'SELF_PROMOTION_FORBIDDEN',
        message: 'The beneficiary cannot approve their own root authority.',
      });
    }
    const [approved, a] = unit(() => {
      const tr = verification.rootTransfers.approve(t.id, { at: Date.now(), by: req.orgUser.id });
      // One active grant per person and level.
      const held = reads.admins.activeFor(req.org.id, t.toUserId).find((x) => x.level === 'verification_root_admin');
      const grant =
        held ??
        verification.admins.create({
          id: nextId('vadm'),
          orgId: req.org.id,
          userId: t.toUserId,
          level: 'verification_root_admin',
          status: 'active',
          invitedBy: t.proposedBy,
          createdAt: Date.now(),
          acceptedAt: Date.now(),
          revokedAt: null,
          revokedBy: null,
        });
      verEvent(
        'admin.accepted',
        {
          orgId: req.org.id,
          subjectId: t.toUserId,
          after: { level: 'verification_root_admin', dualControl: `approved by ${req.orgUser.id}` },
        },
        req,
      );
      return [tr, grant];
    });
    res.json({ transfer: approved, admin: a });
  });

  orgRouter.post('/verification/admins/:id/revoke', (req, res) => {
    const a = onlyOrg(req, reads.admins.byId(req.params.id));
    if (!a) return res.status(404).json({ error: 'ADMIN_NOT_FOUND' });
    const isRootRow = a.level === 'verification_root_admin';
    if (!requireVer(req, res, isRootRow ? 'verification_root_admin' : 'verification_admin', { root: isRootRow }))
      return;
    if (a.userId === req.orgUser.id)
      return res.status(403).json({
        error: 'SELF_REVOKE_FORBIDDEN',
        message: 'Another administrator (or Trust & Safety) must change your authority.',
      });
    if (a.status !== 'active') return res.status(409).json({ error: 'ALREADY_REVOKED' });
    const body = inputOrRefuse(res, Reason, req.body ?? {});
    if (!body) return;
    if (isRootRow) {
      if (reads.admins.activeRootCount(req.org.id) <= 1) {
        return res.status(409).json({
          error: 'LAST_ROOT_ADMIN',
          message:
            'An organisation cannot remove its final root administrator itself — Trust & Safety handles root recovery so the organisation is never orphaned.',
        });
      }
    }
    const revoked = unit(() => {
      const next = verification.admins.revoke(a.id, { at: Date.now(), by: req.orgUser.id });
      verEvent(
        'admin.revoked',
        { orgId: req.org.id, subjectId: a.userId, reason: filled(body.reason) ?? 'revoked by organisation' },
        req,
      );
      return next;
    });
    res.json({
      admin: revoked,
      note: 'Authority ends immediately. Claims this person previously approved keep their provenance and can be reviewed (Trust & Safety cascade tools).',
    });
  });

  // ========================================== conflict declarations
  orgRouter.post('/verification/conflicts', (req, res) => {
    const body = inputOrRefuse(res, Conflict, req.body ?? {}, CONFLICT_CODES);
    if (!body) return;
    const { kind } = body;
    const c = verification.conflicts.create({
      id: nextId('vcoi'),
      userId: req.orgUser.id,
      orgId: req.org.id,
      kind,
      subject: body.subject ?? '',
      note: body.note ?? '',
      createdAt: Date.now(),
      withdrawnAt: null,
    });
    res.status(201).json({
      conflict: c,
      note: 'Declarations are explicit and visible to your organisation’s verification administrators and Trust & Safety — never inferred, never public.',
    });
  });
  orgRouter.get('/verification/conflicts', (req, res) => {
    const admin = hasVerLevel(req.org.id, req.orgUser.id, 'verification_reviewer');
    res.json({
      items: admin ? reads.conflicts.forOrg(req.org.id) : reads.conflicts.forOrgUser(req.org.id, req.orgUser.id),
    });
  });
  orgRouter.post('/verification/conflicts/:id/withdraw', (req, res) => {
    const found = reads.conflicts.byId(req.params.id);
    const c = found && found.orgId === req.org.id && found.userId === req.orgUser.id ? found : null;
    if (!c) return res.status(404).json({ error: 'CONFLICT_NOT_FOUND' });
    if (c.withdrawnAt) return res.status(409).json({ error: 'ALREADY_WITHDRAWN' });
    const withdrawn = verification.conflicts.withdraw(c.id, { at: Date.now() });
    res.json({ conflict: withdrawn });
  });
}
