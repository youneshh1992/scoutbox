import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { payloadFingerprint } from '../../platform/idempotency.mjs';
import { hasVerLevel } from '../../verification/public.mjs';
import { sendComplianceError } from './errors.mjs';
import { resolveScope, ruleAt } from './policy.mjs';
import { now } from '../../platform/clock.mjs';

/** Returns `requestDualRepresentationConsent`, which the transaction workspace requests through too. */
export function registerConsentRoutes(ctx) {
  const {
    broadcast,
    bumped,
    byClubUser,
    byId,
    byOrg,
    byPlayer,
    clientKeyOr400,
    complianceRecords,
    consentForAgent,
    consentStatusOf,
    contextById,
    entry,
    evaluateAndRecord,
    facetGate,
    facetStatesOf,
    inputOr400,
    limitedOr429,
    nextId,
    notify,
    orgRouter,
    ownContext,
    playerRouter,
    policySetFor,
    profileOf,
    revokedAtOf,
    unit,
    verificationReads,
  } = ctx;
  const { consents } = complianceRecords;
  const consentById = (id) => (typeof id === 'string' ? consents.byId(id) : null);
  const consentForParty = (k) => {
    const c = contextById(k.contextId);
    const ag = profileOf(k.agentUserId);
    const org = byId.org(k.agencyOrgId);
    return {
      id: k.id,
      kind: k.kind,
      status: consentStatusOf(k),
      partyRole: k.partyRole,
      agent: {
        userId: k.agentUserId,
        displayName: ag?.displayName ?? null,
        agency: org?.name ?? null,
        licence: ag ? facetStatesOf(ag).fifa_licence : 'UNVERIFIED',
      },
      context: c
        ? {
            id: c.id,
            type: c.type,
            jurisdictions: c.jurisdictions,
            parties: c.parties
              .filter((p) => !p.removed)
              .map((p) => ({
                partyRole: p.partyRole,
                subjectKind: p.subjectKind,
                name:
                  p.subjectKind === 'club'
                    ? (byId.org(p.subjectId)?.name ?? null)
                    : p.subjectId === k.subject?.id
                      ? 'You'
                      : null,
              })),
          }
        : null,
      otherPartyRoles: k.regarding ?? [],
      particulars: k.particulars ?? null,
      policyVersions: k.policyVersions ?? [],
      ruleIds: k.ruleIds ?? [],
      requestedAt: k.requestedAt,
      grantedAt: k.grantedAt ?? null,
      declinedAt: k.declinedAt ?? null,
      revokedAt: revokedAtOf(k),
      ...revMeta(k),
      honest:
        'You may decline. Consent is specific to this agent, this transaction context and these parties; it can be revoked at any time, and a revocation stops any future regulated action that needs it. ScoutBox records your answer; it does not advise you.',
    };
  };
  orgRouter.post('/agent/compliance/contexts/:id/consents/request', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true });
    if (!c) return;
    requestDualRepresentationConsent(req, res, c);
  });
  /** A party's prior written consent to multiple representation. The transaction workspace requests through this too. */
  function requestDualRepresentationConsent(req, res, given) {
    const c = contextById(given.id) ?? given; // as stored now: the transaction seam projects it first
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'consents');
    const b = inputOr400(res, 'consentRequest', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const partyRole = b.partyRole;
    const party = c.parties.find((x) => x.partyRole === partyRole && !x.removed);
    if (!party) return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'consents');
    const fp = payloadFingerprint({ partyRole });
    if (key) {
      const hit = consents.byRequestKey(c.id, req.orgUser.id, key);
      if (hit) {
        if (hit.keys.request.fp === fp) return res.json({ consent: consentForAgent(hit), idempotent: true });
        return sendComplianceError(res, { error: 'CONSENT_IDEMPOTENCY_CONFLICT' }, 'consents');
      }
    }
    if (limitedOr429(res, 'compliance_consent_request', req.orgUser.id)) return;
    const p = profileOf(req.orgUser.id);
    if (!p || !facetGate(req, res, p, c.jurisdictions)) return;
    // Consent exists only where an active encoded rule makes it the permitted route.
    const set = policySetFor(c.jurisdictions);
    const { scope, memberAssociations } = resolveScope(c.jurisdictions);
    const nationalPolicy =
      scope === 'national' ? set.policies.find((x) => x.jurisdiction === memberAssociations[0]) : null;
    const ruleId = nationalPolicy
      ? (Object.keys(nationalPolicy.rules).find(
          (id) => nationalPolicy.rules[id]?.params?.consentKind === 'dual_representation',
        ) ?? null)
      : 'FIFA-12.8';
    const rule = ruleId ? ruleAt(set.policies, ruleId, now()) : { ruleId: null, status: 'UNKNOWN', policy: null };
    if (rule.status !== 'ACTIVE')
      return sendComplianceError(
        res,
        {
          error: 'REGULATORY_REVIEW_REQUIRED',
          reasons: [
            {
              code: rule.status === 'UNKNOWN' ? 'POLICY_NOT_ENCODED' : 'RULE_STATUS_UNCERTAIN',
              ruleId: rule.ruleId,
              ruleStatus: rule.status,
              policyVersion: rule.policy?.id ?? null,
            },
          ],
          policyVersions: set.policies.map((x) => x.id),
          message:
            "Consent can only be requested under an ACTIVE encoded rule. The deciding rule's status is uncertain or not encoded; consent would not cure that.",
        },
        'consents',
      );
    const existing = consents
      .forContext(c.id)
      .find(
        (k) =>
          k.kind === 'dual_representation' &&
          k.agentUserId === req.orgUser.id &&
          k.partyRole === partyRole &&
          (consentStatusOf(k) === 'requested' || consentStatusOf(k) === 'granted'),
      );
    if (existing)
      return sendComplianceError(
        res,
        { error: 'CONSENT_ALREADY_REQUESTED', status: consentStatusOf(existing) },
        'consents',
      );
    const k = {
      id: nextId('rcs'),
      kind: 'dual_representation',
      contextId: c.id,
      agentUserId: req.orgUser.id,
      agencyOrgId: c.agencyOrgId,
      partyRole,
      subject: { kind: party.subjectKind, id: party.subjectId },
      regarding: c.parties.filter((x) => !x.removed && x.partyRole !== partyRole).map((x) => x.partyRole),
      status: 'requested',
      requestedAt: now(),
      requestedBy: byOrg(req),
      grantedAt: null,
      grantedBy: null,
      declinedAt: null,
      declinedBy: null,
      particulars: {
        fullParticularsProvided: b.fullParticularsProvided === true,
        legalAdviceOffered: b.legalAdviceOffered === true,
        proposedFeeDisclosed: b.proposedFeeDisclosed === true,
        acknowledged: null,
      },
      policyVersions: set.policies.map((x) => x.id),
      ruleIds: [rule.ruleId],
      keys: key ? { request: { key, fp } } : {},
      rev: 1,
      revAt: now(),
      revBy: null,
      history: [
        entry('regulatory_consent_requested', byOrg(req), {
          partyRole,
          kind: 'dual_representation',
          policyVersions: set.policies.map((x) => x.id),
        }),
      ],
    };
    const out = unit(() => {
      const stored = consents.create(k);
      broadcast('regulatory_consent_requested', { orgId: c.agencyOrgId, consentId: k.id, ctxId: c.id });
      const agentName = p.displayName ?? req.orgUser.name;
      if (party.subjectKind === 'player')
        notify(
          { kind: 'player', id: party.subjectId },
          'regulatory_consent_requested',
          `${agentName} (${req.org.name}) asks your written consent to also act for another party in a ${c.type.replace(/_/g, ' ')} involving you. You may decline. Nothing changes until you answer.`,
          k.id,
        );
      else
        for (const u of verificationReads.admins.activeForOrg(party.subjectId))
          notify(
            { kind: 'org_user', id: u.userId },
            'regulatory_consent_requested',
            `${agentName} (${req.org.name}) asks your club's written consent to act for more than one party in a ${c.type.replace(/_/g, ' ')}. Only a recorded signatory may answer.`,
            k.id,
          );
      return stored;
    });
    res.status(201).json({ consent: consentForAgent(out) });
  }

  /** Both lanes. `who` resolves the acting party and its authority. */
  function consentAnswer(req, res, { action, who, by, rateKey }) {
    const k = consentById(req.params.id);
    if (!k) return sendComplianceError(res, { error: 'CONSENT_NOT_FOUND' }, action);
    const authority = who(k);
    if (!authority.ok)
      return sendComplianceError(
        res,
        { error: authority.error ?? 'CONSENT_NOT_FOUND', ...(authority.message ? { message: authority.message } : {}) },
        action,
      );
    if (limitedOr429(res, 'compliance_consent_response', rateKey)) return;
    const b = inputOr400(res, action === 'grant' ? 'consentGrant' : 'consentAnswer', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const fp = payloadFingerprint({ action });
    if (key && k.keys?.[action]?.key === key) {
      if (k.keys[action].fp === fp) return res.json({ consent: consentForParty(k), idempotent: true });
      return sendComplianceError(res, { error: 'CONSENT_IDEMPOTENCY_CONFLICT' }, action);
    }
    const st = consentStatusOf(k);
    const revBy = { id: by.userId, name: by.name };
    if (action === 'revoke') {
      if (st !== 'granted')
        return sendComplianceError(
          res,
          { error: 'CONSENT_NOT_PENDING', status: st, message: 'Only a granted consent can be revoked.' },
          action,
        );
      if (!guardRev(req, res, k, { errorCode: 'CONSENT_VERSION_CONFLICT', current: { status: st } })) return;
      const out = unit(() => {
        // The revocation is its own row; the granted row changes only its key, history and rev.
        const next = consents.revoke(
          k.id,
          { revocation: { id: nextId('rcs'), at: now(), by }, key: key ? { key, fp } : null },
          {
            ...bumped(revBy),
            history: [entry('regulatory_consent_revoked', by, { consentId: k.id, partyRole: k.partyRole })],
          },
        );
        const c = contextById(k.contextId);
        if (c && c.status === 'open') evaluateAndRecord(c, by);
        broadcast('regulatory_consent_revoked', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
        notify(
          { kind: 'org_user', id: k.agentUserId },
          'regulatory_consent_revoked',
          'A party revoked their consent to multiple representation. Any future regulated action that needs it will be refused; the record of what happened before stays.',
          k.id,
        );
        return next;
      });
      return res.json({ consent: consentForParty(out) });
    }
    if (st !== 'requested') return sendComplianceError(res, { error: 'CONSENT_NOT_PENDING', status: st }, action);
    if (!guardRev(req, res, k, { errorCode: 'CONSENT_VERSION_CONFLICT', current: { status: st } })) return;
    if (action === 'grant') {
      const ackP = b.acknowledgedParticulars === true;
      const ackL = b.acknowledgedLegalAdvice === true;
      if (!ackP || !ackL)
        return sendComplianceError(
          res,
          {
            error: 'CONSENT_INPUT_INVALID',
            field: !ackP ? 'acknowledgedParticulars' : 'acknowledgedLegalAdvice',
            message:
              'To grant, confirm you received the full particulars and were told you may take independent legal advice.',
          },
          action,
        );
    }
    const out = unit(() => {
      const answerKey = key ? { key, fp } : null;
      const next =
        action === 'grant'
          ? consents.grant(
              k.id,
              {
                at: now(),
                by: { ...by, ...(authority.signatory !== undefined ? { signatory: authority.signatory } : {}) },
                key: answerKey,
              },
              {
                ...bumped(revBy),
                history: [
                  entry('regulatory_consent_granted', by, { partyRole: k.partyRole, policyVersions: k.policyVersions }),
                ],
              },
            )
          : consents.decline(
              k.id,
              { at: now(), by, key: answerKey },
              { ...bumped(revBy), history: [entry('regulatory_consent_declined', by, { partyRole: k.partyRole })] },
            );
      const c = contextById(k.contextId);
      if (c && c.status === 'open') evaluateAndRecord(c, by);
      // Literal event names: the event-registry contract (e2e/platform/contracts.mjs) reads call sites textually.
      if (action === 'grant')
        broadcast('regulatory_consent_granted', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
      else broadcast('regulatory_consent_declined', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
      notify(
        { kind: 'org_user', id: k.agentUserId },
        action === 'grant' ? 'regulatory_consent_granted' : 'regulatory_consent_declined',
        action === 'grant'
          ? 'A party granted written consent to multiple representation for one transaction context. It is specific to that context and can be revoked.'
          : 'A party declined consent to multiple representation. You may continue to act for your first party only.',
        k.id,
      );
      return next;
    });
    res.json({ consent: consentForParty(out) });
  }
  playerRouter.get('/agent/consents', (req, res) => {
    if (req.playerIsMinor)
      return res.json({
        items: [],
        minor: true,
        note: 'Agent representation and its consents are not available for under-18 accounts in ScoutBox.',
      });
    res.json({
      items: consents
        .forSubject('player', req.player.id)
        .filter((k) => k.kind === 'dual_representation')
        .map(consentForParty),
    });
  });
  const playerWho = (req) => (k) => {
    if (req.playerIsMinor)
      return {
        ok: false,
        error: 'COMPLIANCE_ACTION_NOT_PERMITTED',
        message: 'Guardian-managed accounts cannot answer agent consents in ScoutBox.',
      };
    if (k.subject?.kind !== 'player' || k.subject.id !== req.player.id)
      return { ok: false, error: 'CONSENT_NOT_FOUND' };
    return { ok: true };
  };
  for (const action of ['grant', 'decline', 'revoke']) {
    playerRouter.post(`/agent/consents/:id/${action}`, (req, res) =>
      consentAnswer(req, res, { action, who: playerWho(req), by: byPlayer(req), rateKey: req.player.id }),
    );
  }
  // Only the recorded signatory (a verification administrator) may bind the club (DR-19).
  const clubWho = (req) => (k) => {
    if (req.org.type !== 'club') return { ok: false, error: 'CONSENT_NOT_FOUND' };
    if (k.subject?.kind !== 'club' || k.subject.id !== req.org.id) return { ok: false, error: 'CONSENT_NOT_FOUND' };
    if (!hasVerLevel(verificationReads, req.org.id, req.orgUser.id, 'verification_admin'))
      return {
        ok: false,
        error: 'SIGNATORY_REQUIRED',
        message: 'Only a recorded club signatory (a verification administrator) may answer for the club.',
      };
    return { ok: true, signatory: true };
  };
  orgRouter.get('/compliance/consents', (req, res) => {
    if (req.org.type !== 'club')
      return sendComplianceError(res, { error: 'COMPLIANCE_ACTION_NOT_PERMITTED' }, 'consents');
    res.json({
      items: consents
        .forSubject('club', req.org.id)
        .filter((k) => k.kind === 'dual_representation')
        .map(consentForParty),
      signatory: hasVerLevel(verificationReads, req.org.id, req.orgUser.id, 'verification_admin'),
    });
  });
  for (const action of ['grant', 'decline', 'revoke']) {
    orgRouter.post(`/compliance/consents/:id/${action}`, (req, res) =>
      consentAnswer(req, res, { action, who: clubWho(req), by: byClubUser(req), rateKey: req.orgUser.id }),
    );
  }

  return { requestDualRepresentationConsent };
}
