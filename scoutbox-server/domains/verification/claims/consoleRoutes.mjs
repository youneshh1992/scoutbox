import { parseDateOrInstant, isAbsent } from '../../../temporal.mjs';
import { filled, inputOrRefuse, presentOrRefuse } from '../../platform/schemas.mjs';
import { Decision, DECISION_CODES, Departure, STAFF_QUERY_CODES, StaffQuery } from './organisationInput.mjs';

export function registerConsoleRoutes(ctx) {
  const {
    applyStatus,
    byId,
    effectiveStatus,
    ledgerAppend,
    notify,
    orgCanAttest,
    orgRouter,
    orgVerificationStatus,
    reads,
    requireVer,
    subjectClaimView,
    unit,
    userClaims,
    verEvent,
    verification,
  } = ctx;
  orgRouter.get('/verification/dashboard', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const mine = reads.claims.forOrgStaff(req.org.id);
    const now = Date.now();
    // A raw status of 'verified' does not count when org standing, account removal or expiry suppresses it.
    const effCurrent = (c) => {
      const u = byId.user(c.subjectId);
      return effectiveStatus(c, { org: req.org, subjectRemoved: !u || !!u.removedAt, now }).current;
    };
    res.json({
      organisationStatus: orgVerificationStatus(req.org),
      counts: {
        verifiedStaff: new Set(mine.filter(effCurrent).map((c) => c.subjectId)).size,
        pending: mine.filter((c) => ['pending', 'automated_checks_passed'].includes(c.status)).length,
        humanReview: mine.filter((c) => c.status === 'requires_human_review').length,
        expiringSoon: mine.filter(
          (c) => c.status === 'verified' && c.validUntil && c.validUntil > now && c.validUntil < now + 30 * 86_400_000,
        ).length,
        disputed: reads.disputes.openCountForOrg(req.org.id),
        revoked: mine.filter((c) => c.status === 'revoked').length,
        domains: reads.domains.forOrg(req.org.id).length,
        administrators: reads.admins.activeForOrg(req.org.id).length,
      },
    });
  });

  // The admin decides on a prepared case.
  const requestRow = (claim) => {
    const user = byId.user(claim.subjectId);
    const identity = userClaims(claim.subjectId).find((c) => c.claimType === 'PERSON_IDENTITY');
    return {
      claimId: claim.id,
      claimType: claim.claimType,
      pairId: claim.metadata?.pairId ?? null,
      person: {
        id: user?.id,
        name: user?.name,
        email: user?.email ?? null,
        accountCreatedAt: user?.createdAt ?? null,
        removed: !!user?.removedAt,
      },
      claimedRole: claim.role,
      requestedStart: claim.metadata?.requestedStart ?? null,
      identityStatus: identity?.status ?? 'unverified',
      emailStatus:
        claim.metadata?.domainControl === 'passed'
          ? claim.metadata?.domainCoveredByOrg
            ? 'work_email_on_verified_domain'
            : 'work_email_on_other_domain'
          : 'not_proved',
      riskFlags: claim.riskFlags,
      status: claim.status,
      requestedAt: claim.createdAt,
      priorClaims: userClaims(claim.subjectId)
        .filter((c) => c.id !== claim.id && c.status === 'verified')
        .map((c) => ({ claimType: c.claimType, organisationId: c.organisationId, role: c.role, current: c.current })),
    };
  };

  orgRouter.get('/verification/requests', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const rows = reads.claims
      .forOrgStaff(req.org.id)
      .filter((c) => ['pending', 'automated_checks_passed'].includes(c.status))
      .map(requestRow);
    res.json({ items: rows, note: 'Decisions are audited. You cannot decide your own request.' });
  });

  orgRouter.post('/verification/requests/:claimId/decide', (req, res) => {
    if (!requireVer(req, res, 'verification_reviewer')) return;
    const found = reads.claims.byId(req.params.claimId);
    const claim = found && found.organisationId === req.org.id && found.subjectType === 'user' ? found : null;
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (claim.subjectId === req.orgUser.id) {
      verEvent(
        'security.self_verification_blocked',
        {
          claimId: claim.id,
          subjectId: claim.subjectId,
          orgId: req.org.id,
          reason: 'reviewer attempted to decide own claim',
        },
        req,
      );
      return res.status(403).json({
        error: 'SELF_VERIFICATION_FORBIDDEN',
        message:
          'You cannot be the authoritative confirmer of your own claim. Another authorised administrator must decide it.',
      });
    }
    if (!['pending', 'automated_checks_passed'].includes(claim.status)) {
      return res.status(409).json({
        error: 'CLAIM_NOT_DECIDABLE',
        message: `The request is ${claim.status} — it may already be decided, withdrawn or escalated.`,
      });
    }
    if (!orgCanAttest(req.org)) {
      return res.status(403).json({
        error: 'ORG_NOT_ELIGIBLE',
        message: `This organisation is ${orgVerificationStatus(req.org)} and cannot confirm staff verification right now.`,
      });
    }
    const body = inputOrRefuse(res, Decision, req.body ?? {}, DECISION_CODES);
    if (!body) return;
    const { action, validFrom, validUntil } = body;
    const role = filled(body.role);
    const reason = filled(body.reason);
    const pair = claim.metadata?.pairId
      ? reads.claims
          .byPair(claim.metadata.pairId)
          .filter((c) => ['pending', 'automated_checks_passed'].includes(c.status))
      : [];
    const targets = pair.length ? pair : [claim];
    /** Every target moves or none does; a refusal is answered 409. */
    // The decision, its notice to the person and its ledger row commit together.
    const announce = (text) => {
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', text, claim.id);
      ledgerAppend?.({
        type: 'verification_decision',
        orgId: req.org.id,
        scoutName: req.orgUser.name,
        playerId: null,
        detail: { claimId: claim.id, action },
      });
    };
    const decide = (to, text, extra = {}, before = null) => {
      try {
        unit(() => {
          before?.();
          for (const c of targets) {
            const err = applyStatus(
              c,
              to,
              req,
              {
                method: 'organisation_admin_confirmation',
                reason,
                eventType: to === 'verified' ? 'review.approved' : 'review.rejected',
              },
              {
                set: {
                  ...extra,
                  ...(to === 'verified' ? { authorityType: 'org_admin', authorityId: req.orgUser.id } : {}),
                },
              },
            );
            if (err) throw Object.assign(new Error(err), { decideError: err });
          }
          announce(text);
        });
      } catch (e) {
        if (e.decideError) return e.decideError;
        throw e;
      }
      return null;
    };
    if (action === 'confirm' || action === 'correct_role' || action === 'mark_former') {
      const roleClaim = targets.find((c) => /ROLE/.test(c.claimType));
      let correct = null;
      let roleNow = roleClaim?.role ?? null;
      if (action === 'correct_role') {
        if (!presentOrRefuse(res, role, 'role')) return;
        if (roleClaim) {
          roleNow = role;
          correct = () => {
            verEvent(
              'claim.corrected',
              {
                claimId: roleClaim.id,
                subjectId: claim.subjectId,
                orgId: req.org.id,
                before: { role: roleClaim.role },
                after: { role },
              },
              req,
            );
            verification.claims.correctRole(roleClaim.id, { role: roleNow });
          };
        }
      }
      const fromP = isAbsent(validFrom) ? null : parseDateOrInstant(validFrom, { dayEdge: 'start' });
      const untilP = isAbsent(validUntil) ? null : parseDateOrInstant(validUntil, { dayEdge: 'end' });
      const from = fromP ? fromP.ms : Date.now();
      const until = untilP ? untilP.ms : action === 'mark_former' ? Date.now() : null;
      // Checked only when the club stated both ends: a defaulted start is "now" by convention, not a claim.
      if (fromP && untilP && !(from < until))
        return res
          .status(400)
          .json({ error: 'INTERVAL_INVALID', field: 'validUntil', message: 'The period must end after it starts.' });
      const err = decide(
        'verified',
        `${req.org.name} confirmed your ${action === 'mark_former' ? 'historical ' : ''}affiliation${roleClaim ? ` as ${roleNow}` : ''}. ✓`,
        { validFrom: from, validUntil: until, current: action !== 'mark_former' },
        correct,
      );
      if (err) return res.status(409).json({ error: err });
    } else if (action === 'reject') {
      if (
        !presentOrRefuse(res, reason, 'reason', {
          message: 'A rejection needs a reason — it is shown to the person and audited.',
        })
      )
        return;
      const err = decide('rejected', `${req.org.name} declined the verification request: ${reason.slice(0, 140)}`);
      if (err) return res.status(409).json({ error: err });
    } else {
      unit(() => {
        for (const c of targets) applyStatus(c, 'collecting_evidence', req, { reason });
        announce(
          `${req.org.name} asks for more information on your verification request${reason ? `: ${reason.slice(0, 140)}` : ''}.`,
        );
      });
    }
    res.json({ decided: action, claims: targets.map((c) => subjectClaimView(reads.claims.byId(c.id))) });
  });

  orgRouter.get('/verification/staff', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const query = inputOrRefuse(res, StaffQuery, req.query ?? {}, STAFF_QUERY_CODES);
    if (!query) return;
    const { state, current, method, role } = query;
    let rows = reads.claims.forOrgStaff(req.org.id).filter((c) => !['unverified'].includes(c.status));
    if (state) rows = rows.filter((c) => c.status === state);
    if (current === 'true') rows = rows.filter((c) => c.current !== false);
    if (current === 'false') rows = rows.filter((c) => c.current === false);
    if (method) rows = rows.filter((c) => c.verificationMethod === method);
    if (role) rows = rows.filter((c) => (c.role ?? '').toLowerCase().includes(role.toLowerCase()));
    res.json({
      items: rows.map((c) => {
        const u = byId.user(c.subjectId);
        const eff = effectiveStatus(c, { org: req.org });
        return {
          claimId: c.id,
          person: { id: u?.id, name: u?.name },
          claimType: c.claimType,
          role: c.role,
          status: c.status,
          effective: eff,
          current: c.current,
          validFrom: c.validFrom,
          validUntil: c.validUntil,
          verificationMethod: c.verificationMethod,
          verifiedAt: c.verifiedAt,
        };
      }),
    });
  });

  // ----- employment change: the period closes, the history stays.
  orgRouter.post('/verification/staff/:userId/departed', (req, res) => {
    if (!requireVer(req, res, 'verification_reviewer')) return;
    if (req.params.userId === req.orgUser.id)
      return res.status(403).json({
        error: 'SELF_VERIFICATION_FORBIDDEN',
        message: 'Ask another administrator to record your own departure.',
      });
    const claims = reads.claims
      .forOrgSubject(req.org.id, req.params.userId)
      .filter((c) => c.status === 'verified' && c.current !== false);
    if (!claims.length) return res.status(404).json({ error: 'NO_CURRENT_VERIFIED_CLAIMS' });
    const body = inputOrRefuse(res, Departure, req.body ?? {});
    if (!body) return;
    const untilP = isAbsent(body.validUntil) ? null : parseDateOrInstant(body.validUntil, { dayEdge: 'end' });
    const until = untilP ? untilP.ms : Date.now();
    unit(() => {
      for (const c of claims) {
        verEvent(
          'claim.corrected',
          {
            claimId: c.id,
            subjectId: c.subjectId,
            orgId: req.org.id,
            before: { current: true },
            after: { current: false, validUntil: until },
            reason: 'marked departed',
          },
          req,
        );
        verification.claims.closePeriod(c.id, { until, at: Date.now() });
      }
      // Powers tied to the relationship end immediately.
      for (const a of reads.admins.activeFor(req.org.id, req.params.userId)) {
        verification.admins.revoke(a.id, { at: Date.now(), by: req.orgUser.id });
        verEvent('admin.revoked', { orgId: req.org.id, subjectId: a.userId, reason: 'departed' }, req);
      }
      notify(
        { kind: 'org_user', id: req.params.userId },
        'verification',
        `${req.org.name} recorded you as departed. Your verified history stays on your profile; if this is wrong you can dispute it from Verification.`,
        claims[0].id,
      );
    });
    res.json({
      closed: claims.length,
      note: 'Current badges end now; the historical verified period remains. The person can dispute this.',
    });
  });
}
