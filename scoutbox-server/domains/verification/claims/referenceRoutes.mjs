import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { filled, inputOrRefuse, presentOrRefuse } from '../../platform/schemas.mjs';
import { VERIFICATION_LIMITS as L } from '../../../repositories/verification.mjs';
import { NewReference, ReferenceCorrection, ReferenceWithdrawal } from './organisationInput.mjs';

export function registerReferenceRoutes(ctx) {
  const {
    effectiveStatus,
    findPlayer,
    guardianRouter,
    isBlocked,
    nextId,
    notify,
    orgOf,
    orgRouter,
    playerRouter,
    reads,
    unit,
    userClaims,
    verEvent,
    verification,
  } = ctx;
  orgRouter.post('/verification/references', (req, res) => {
    // The author needs a current, effective verified role at this org, and the player must already be visible:
    // verification grants no extra access.
    const roleClaim = userClaims(req.orgUser.id).find(
      (c) =>
        c.organisationId === req.org.id &&
        /ROLE|AFFILIATION/.test(c.claimType) &&
        effectiveStatus(c, { org: req.org }).current,
    );
    if (!roleClaim)
      return res.status(403).json({
        error: 'VERIFIED_ROLE_REQUIRED',
        message: 'Structured references need a currently verified role at this organisation.',
      });
    const body = inputOrRefuse(res, NewReference, req.body ?? {});
    if (!body) return;
    const p = findPlayer(body.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) {
      return res.status(403).json({
        error: 'UNDER_18_WALL',
        message:
          'A verified role does not widen player visibility — the standing consent and safeguarding rules decide who you can reference.',
      });
    }
    const relationship = filled(body.relationship);
    const summary = filled(body.summary);
    const missing = [...(relationship ? [] : ['relationship']), ...(summary ? [] : ['summary'])];
    if (missing.length)
      return res.status(400).json({
        error: 'FIELDS_REQUIRED',
        missing,
        problem: 'required',
        message: 'relationship and summary are required.',
      });
    const ref = unit(() => {
      const created = verification.references.create({
        id: nextId('vref'),
        version: 1,
        supersedesId: null,
        playerId: p.id,
        playerName: p.name == null ? null : String(p.name).slice(0, L.name),
        coachUserId: req.orgUser.id,
        coachName: req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name),
        orgId: req.org.id,
        orgName: String(req.org.name).slice(0, L.name),
        roleAtTime: roleClaim.role ?? (req.orgUser.role == null ? null : String(req.orgUser.role).slice(0, L.name)),
        provenanceSnapshot: {
          // snapshot at submission — later changes never rewrite it
          claimId: roleClaim.id,
          claimType: roleClaim.claimType,
          status: 'verified',
          method: roleClaim.verificationMethod,
          verifiedAt: roleClaim.verifiedAt,
          snapshotAt: Date.now(),
        },
        relationship,
        capacity: body.capacity ?? '',
        fromYear: body.fromYear ?? null,
        toYear: body.toYear ?? null,
        structured: { strengths: body.strengths ?? '', development: body.development ?? '', summary },
        status: 'active',
        withdrawnAt: null,
        withdrawReason: null,
        createdAt: Date.now(),
      });
      verEvent(
        'claim.created',
        {
          orgId: req.org.id,
          subjectId: p.id,
          after: { reference: created.id, provenance: created.provenanceSnapshot.claimId },
        },
        req,
      );
      if (isAdult(p))
        notify(
          { kind: 'player', id: p.id },
          'verification',
          `${req.orgUser.name} (${req.org.name}) added a structured reference to your profile.`,
          created.id,
        );
      else if (p.guardianId)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'verification',
          `${req.orgUser.name} (verified at ${req.org.name}) added a structured reference for ${p.name}. You can review it in the app.`,
          created.id,
        );
      return created;
    });
    res.status(201).json({ reference: ref });
  });

  orgRouter.get('/verification/references', (req, res) => {
    res.json({ items: reads.references.forOrg(req.org.id) });
  });

  orgRouter.post('/verification/references/:id/withdraw', (req, res) => {
    const ref = ownReference(req, reads.references.byId(req.params.id));
    if (!ref) return res.status(404).json({ error: 'REFERENCE_NOT_FOUND' });
    if (ref.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });
    const body = inputOrRefuse(res, ReferenceWithdrawal, req.body ?? {});
    if (!body) return;
    const reason = filled(body.reason);
    if (!presentOrRefuse(res, reason, 'reason')) return;
    const withdrawn = unit(() => {
      const next = verification.references.withdraw(ref.id, { at: Date.now(), reason });
      verEvent(
        'claim.corrected',
        {
          orgId: req.org.id,
          subjectId: ref.playerId,
          before: { reference: ref.id, status: 'active' },
          after: { status: 'withdrawn' },
          reason: next.withdrawReason,
        },
        req,
      );
      return next;
    });
    res.json({
      reference: withdrawn,
      note: 'Withdrawal is an event — the original text and its provenance remain in the record.',
    });
  });

  orgRouter.post('/verification/references/:id/correct', (req, res) => {
    const old = ownReference(req, reads.references.byId(req.params.id));
    if (!old) return res.status(404).json({ error: 'REFERENCE_NOT_FOUND' });
    if (old.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });
    const body = inputOrRefuse(res, ReferenceCorrection, req.body ?? {});
    if (!body) return;
    if (typeof body.summary === 'string' && !filled(body.summary))
      return res.status(400).json({
        error: 'FIELDS_REQUIRED',
        missing: ['summary'],
        problem: 'required',
        message: 'A reference keeps its summary.',
      });
    const next = unit(() => {
      verification.references.supersede(old.id);
      const created = verification.references.create({
        ...structuredClone(old),
        id: nextId('vref'),
        version: old.version + 1,
        supersedesId: old.id,
        structured: {
          strengths: body.strengths ?? old.structured.strengths,
          development: body.development ?? old.structured.development,
          summary: filled(body.summary) ?? old.structured.summary,
        },
        createdAt: Date.now(),
      });
      verEvent(
        'claim.corrected',
        {
          orgId: req.org.id,
          subjectId: old.playerId,
          before: { reference: old.id },
          after: { reference: created.id, version: created.version },
        },
        req,
      );
      return created;
    });
    res.json({
      reference: next,
      superseded: old.id,
      note: 'Corrections create a new version — the original is never silently edited.',
    });
  });

  const ownReference = (req, r) => (r && r.orgId === req.org.id && r.coachUserId === req.orgUser.id ? r : null);
  const refPlayerView = (r) => ({
    id: r.id,
    version: r.version,
    coachName: r.coachName,
    orgName: r.orgName,
    roleAtTime: r.roleAtTime,
    relationship: r.relationship,
    capacity: r.capacity,
    fromYear: r.fromYear,
    toYear: r.toYear,
    structured: r.structured,
    status: r.status,
    createdAt: r.createdAt,
    provenance: (() => {
      const claim = reads.claims.byId(r.provenanceSnapshot.claimId);
      const stillCurrent = claim && effectiveStatus(claim, { org: orgOf(r.orgId) }).current;
      return stillCurrent
        ? `Coach's ${r.orgName} affiliation is verified.`
        : 'Coach affiliation was verified when this reference was submitted.';
    })(),
  });
  playerRouter.get('/references', (req, res) => {
    res.json({
      items: reads.references
        .forPlayer(req.player.id)
        .filter((r) => r.status !== 'superseded')
        .map(refPlayerView),
    });
  });
  guardianRouter.get('/children/:id/references', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({
      items: reads.references
        .forPlayer(req.params.id)
        .filter((r) => r.status !== 'superseded')
        .map(refPlayerView),
    });
  });
}
