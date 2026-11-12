// Trust Score source gathering and routes. Sources are read through the systems that own them (effective claims,
// the Passport assembly, which already folds duplicate self-entries into authoritative rows, Box Cam), so the same
// fact is counted once and a UI projection is never what gets scored.
import * as v from 'valibot';
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { idsText, inputOrRefuse, listedIds } from '../../platform/schemas.mjs';
import { effectiveStatus, assuranceForClaim } from '../../verification/public.mjs';
import { agreementInForce } from '../../agents/public.mjs';
import { PROVIDERS } from '../../development/public.mjs';
import {
  POLICY,
  TRUST_SCORE_POLICY_VERSION,
  calculateTrustScore,
  safeTrustProjection,
  trustSummary,
  trustSnapshot,
  TRUST_DISCLAIMER,
} from './shared.mjs';

const SummariesQuery = v.strictObject({ playerIds: v.optional(idsText(100)) });

export function registerTrust(ctx) {
  const { byId, playerRouter, guardianRouter, orgRouter, adminRouter, findPlayer, isBlocked, vmetric } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  // Simulated (test-provider) evidence counts only in an explicitly simulated environment, and the projection says so.
  const allowSimulatedEvidence = () => !!ctx.testProviderEnabled;

  // ------------------------------------------------- source maps
  /** Falls back to `identityVerified` only when no claim exists, and then reports it as a ScoutBox review. */
  function identitySource(player) {
    const claims = ctx.verificationReads.claims
      .forSubjectId(player.id)
      .filter((c) => c.claimType === 'PERSON_IDENTITY');
    let best = null;
    for (const c of claims) {
      const eff = effectiveStatus(c, { org: c.organisationId ? byId.org(c.organisationId) : null, now: Date.now() });
      if (!eff.displayable) continue;
      const assurance = assuranceForClaim(c);
      if (!assurance) continue;
      const rank = { authoritative: 3, organisation_attested: 2, scoutbox_document_review: 1 }[assurance] ?? 0;
      if (!best || rank > best.rank) best = { assurance, rank };
    }
    if (best) return { assurance: best.assurance };
    return player.identityVerified ? { assurance: 'scoutbox_document_review' } : null;
  }

  function historySource(full) {
    return (full?.history?.rows ?? []).map((r, i) => ({
      key: r.source?.id
        ? `hist:${r.source.type ?? 'row'}:${r.source.id}`
        : `hist:${r.org?.id ?? r.title?.org ?? 'club'}:${r.from ?? ''}:${r.to ?? ''}:${i > 0 && !r.org?.id ? i : ''}`,
      provenance: r.provenance,
      current: !!r.current,
    }));
  }

  /** Prestige is not read: only that the relationship is verified and distinct. */
  function relationshipSource(player) {
    const out = [];
    // A club's shadow list is not a relationship.
    const clubs = new Set();
    for (const row of ctx.scoutingReads.squad.forPlayer(player.id)) {
      const o = ctx.byId.org(row.orgId);
      if (!o || o.suspended || clubs.has(o.id)) continue;
      clubs.add(o.id);
      out.push({ key: `rel:club:${o.id}`, kind: 'club', verified: !!o.verified });
    }
    for (const r of ctx.verificationReads.references.activeForPlayer(player.id)) {
      const claim = ctx.verificationReads.claims.byId(r.provenanceSnapshot?.claimId);
      const verified = !!claim && claim.status === 'verified';
      out.push({ key: `rel:coach:${r.coachUserId ?? r.byUserId ?? r.id}`, kind: 'coach', verified });
    }
    const now = Date.now();
    // Only an agreement in force counts (the access predicate's own rule, so a mandate not yet started counts for
    // nothing). Keyed on the agency, so moving between agents inside one agency is not a new relationship.
    for (const a of ctx.agentReads.agreements.forClient(player.id)) {
      if (!agreementInForce(a, now)) continue;
      out.push({ key: `rel:agency:${a.agencyOrgId}`, kind: 'agency', verified: true });
    }
    return out;
  }

  function evidenceSource(player) {
    return ctx.scoutingReads.evidence
      .currentForPlayer(player.id)
      .filter((e) => !(e.expiresAt && e.expiresAt < Date.now()))
      .map((e) => ({
        key: `ev:${e.id}`,
        provenance:
          e.verification?.status === 'club_assessed'
            ? 'verified_club_confirmed'
            : e.verification?.status === 'coach_confirmed'
              ? 'verified_coach_confirmed'
              : e.source?.kind === 'guardian'
                ? 'guardian_submitted'
                : 'player_submitted',
        recordedAt: e.recordedAt ?? 0,
      }));
  }

  function boxCamSource(player) {
    return ctx.boxCamReads.sessions
      .forPlayer(player.id)
      .filter((s) => s.finalizedAt)
      .map((s) => ({
        key: `box:${s.id}`,
        verificationState: s.verificationState,
        simulated: !!PROVIDERS[s.provider]?.testOnly,
        endedAt: s.endedAt ?? 0,
      }));
  }

  /** An attempt whose session was invalidated stops contributing, and a restore brings it back. The measured value
   *  is not in this projection at all. */
  function combineSource(player) {
    const attempts = [...ctx.boxCamReads.attempts.forPlayer(player.id)].reverse();
    const sessions = new Map(ctx.boxCamReads.sessions.byIds(attempts.map((a) => a.boxSessionId)).map((s) => [s.id, s]));
    return attempts.map((a) => {
      const s = sessions.get(a.boxSessionId);
      const invalidated = !!s && s.verificationState === 'invalidated';
      return {
        key: `catt:${a.id}`,
        protocolId: a.protocolId,
        protocolVersion: a.protocolVersion,
        combineState: invalidated ? 'invalidated' : a.combineState,
        simulated: !!PROVIDERS[a.provider]?.testOnly,
      };
    });
  }

  function referenceSource(player) {
    return ctx.verificationReads.references.activeForPlayer(player.id).map((r) => {
      const claim = ctx.verificationReads.claims.byId(r.provenanceSnapshot?.claimId);
      return { key: `ref:${r.id}`, verified: !!claim && claim.status === 'verified' };
    });
  }

  /** Attribution only: the rating content is never read. */
  function assessmentSource(player) {
    return ctx.scoutingReads.assessments
      .forPlayer(player.id)
      .filter((a) => a.state !== 'draft')
      .map((a) => ({ key: `asmt:${a.id}`, verifiedSource: !!byId.org(a.orgId)?.verified }));
  }

  /** `full` is an already-built light Passport assembly when the caller has one. */
  function buildFor(player, { full = null } = {}) {
    // Only the Passport's club history is a trust source, so without an assembly the history is read alone.
    const assembled =
      full ??
      (ctx.passportHistoryFor ? { history: ctx.passportHistoryFor(player) } : null) ??
      ctx.assemblePassport?.(player, { light: true }) ??
      null;
    return calculateTrustScore({
      playerContext: { isAdult: isAdult(player) },
      identity: identitySource(player),
      historyRows: historySource(assembled),
      relationships: relationshipSource(player),
      evidenceItems: evidenceSource(player),
      boxCamSessions: boxCamSource(player),
      combineAttempts: combineSource(player),
      references: referenceSource(player),
      assessments: assessmentSource(player),
      now: Date.now(),
      allowSimulatedEvidence: allowSimulatedEvidence(),
    });
  }
  ctx.buildTrustProfile = buildFor;
  ctx.trustSummaryFor = (player, opts) => trustSummary(buildFor(player, opts));
  ctx.trustSnapshotFor = (player) => trustSnapshot(buildFor(player));
  ctx.trustSnapshotOf = (profile) => trustSnapshot(profile);
  ctx.safeTrustProjection = safeTrustProjection;

  const band = (p) => p.band;
  const countBand = (p) => {
    vmetric?.(`trust_band_${band(p)}`);
  };

  // ================================================================ PLAYER
  playerRouter.get('/trust-profile', (req, res) => {
    const p = buildFor(req.player);
    vmetric?.('trust_profile_viewed');
    countBand(p);
    res.json({ trust: safeTrustProjection(p, 'self') });
  });

  // The same derivation, separate so the metric distinguishes a view from a drill-down.
  playerRouter.get('/trust-profile/explain', (req, res) => {
    const p = buildFor(req.player);
    vmetric?.('trust_explanation_viewed');
    res.json({
      trust: safeTrustProjection(p, 'self'),
      policy: { version: TRUST_SCORE_POLICY_VERSION, weights: POLICY.weights, bands: POLICY.bands },
      disclaimer: TRUST_DISCLAIMER,
    });
  });

  guardianRouter.get('/children/:id/trust-profile', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    vmetric?.('trust_profile_viewed');
    res.json({ trust: safeTrustProjection(buildFor(child), 'guardian') });
  });

  // ================================================================== CLUB
  // A Trust Score of 100 opens no door that a score of 0 would not.
  orgRouter.get('/players/:id/trust-profile', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p))
      return res.status(p ? 403 : 404).json({ error: p ? 'NOT_VISIBLE' : 'PLAYER_NOT_FOUND' });
    const viewer = req.org.type === 'grassroots' ? 'grassroots_club' : 'pro_club';
    vmetric?.('trust_profile_viewed');
    res.json({ playerId: p.id, trust: safeTrustProjection(buildFor(p), viewer) });
  });

  /** Returned in the order requested, never ranked. */
  orgRouter.get('/trust-summaries', (req, res) => {
    const query = inputOrRefuse(res, SummariesQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    const items = [];
    for (const id of listedIds(query.playerIds)) {
      const p = findPlayer(id);
      if (!p || !orgCanSee(req.org, p)) continue; // omitted silently, so absence leaks nothing
      items.push({ playerId: p.id, ...trustSummary(buildFor(p)) });
    }
    res.json({
      items,
      note: 'Evidence confidence — not football ability. Results are returned in the order requested and are never ranked by Trust Score.',
    });
  });

  // =================================================================== T&S
  // There is no write route: a wrong score is fixed by correcting the evidence or the policy.
  adminRouter.get('/trust/:playerId', (req, res) => {
    const p = findPlayer(req.params.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const profile = buildFor(p);
    res.json({
      playerId: p.id,
      trust: safeTrustProjection(profile, 'trust_safety'),
      policy: { version: TRUST_SCORE_POLICY_VERSION, weights: POLICY.weights, bands: POLICY.bands },
      snapshot: trustSnapshot(profile),
      note: 'Trust Score is derived at read time from canonical evidence. It cannot be set manually — correct the underlying evidence or the policy, then recalculate.',
    });
  });

  adminRouter.get('/trust-policy', (_req, res) =>
    res.json({
      policyVersion: TRUST_SCORE_POLICY_VERSION,
      weights: POLICY.weights,
      bands: POLICY.bands,
      curves: {
        relationships: POLICY.relationships.curve,
        combineProtocols: POLICY.combine.protocolCurve,
        boxCam: POLICY.evidence.boxCamCurve,
        evidenceRecords: POLICY.evidence.recordsCurve,
        references: POLICY.references.curve,
      },
      subCaps: { evidenceRecords: POLICY.evidence.recordsSubCap, boxCam: POLICY.evidence.boxCamSubCap },
      disclaimer: TRUST_DISCLAIMER,
    }),
  );

  return { buildFor };
}
