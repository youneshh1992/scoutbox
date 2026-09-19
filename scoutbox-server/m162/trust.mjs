// M16.2 — Trust Score: canonical source gathering + viewer-safe routes.
//
// This module NEVER stores a score. Every read recomputes from canonical
// sources, so a revoked claim, an invalidated Combine result or an expired
// piece of evidence is reflected immediately and deterministically.
//
// Canonical sources are read through the systems that already own them —
// M14 effective claims, the M15 Passport assembly (which already folds
// duplicate self-entries into authoritative rows), M16 Box Cam sessions and
// M16.1 Combine attempts — so the same underlying fact is counted once and
// the UI projection is never what gets scored.
//
// The Trust Score grants no permission whatsoever: every route below runs the
// standing authorization gates FIRST and the score is only ever a payload.
import { isAdult, visibleToOrg } from '../domain.mjs';
import { effectiveStatus, assuranceForClaim } from '../m14/shared.mjs';
import { PROVIDERS } from '../m16/drills.mjs';
import {
  POLICY, TRUST_SCORE_POLICY_VERSION, calculateTrustScore, safeTrustProjection,
  trustSummary, trustSnapshot, TRUST_DISCLAIMER,
} from './shared.mjs';

export function registerTrust(ctx) {
  const {
    db, playerRouter, guardianRouter, orgRouter, adminRouter,
    findPlayer, isBlocked, vmetric,
  } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  // Simulated (test-provider) evidence may only influence the score in an
  // explicitly simulated environment. In production the flag is false, so
  // local_test results contribute nothing — and the projection says so.
  const allowSimulatedEvidence = () => !!ctx.testProviderEnabled;

  // ------------------------------------------------- canonical source maps
  /** Strongest EFFECTIVE identity assurance for a player (§9). Prefers the
   *  structured M14.1 claim assurance; falls back to the legacy compatibility
   *  boolean only when no structured claim exists — and then states honestly
   *  that it was a ScoutBox review. */
  function identitySource(player) {
    const claims = (db.verClaims ?? []).filter((c) => c.claimType === 'PERSON_IDENTITY' && c.subjectId === player.id);
    let best = null;
    for (const c of claims) {
      const eff = effectiveStatus(c, { org: c.organisationId ? db.orgs.find((o) => o.id === c.organisationId) : null, now: Date.now() });
      if (!eff.displayable) continue;
      const assurance = assuranceForClaim(c);
      if (!assurance) continue;
      const rank = { authoritative: 3, organisation_attested: 2, scoutbox_document_review: 1 }[assurance] ?? 0;
      if (!best || rank > best.rank) best = { assurance, rank };
    }
    if (best) return { assurance: best.assurance };
    return player.identityVerified ? { assurance: 'scoutbox_document_review' } : null;
  }

  /** Canonical club-history rows with a stable de-duplication key. */
  function historySource(full) {
    return (full?.history?.rows ?? []).map((r, i) => ({
      key: r.source?.id ? `hist:${r.source.type ?? 'row'}:${r.source.id}`
        : `hist:${r.org?.id ?? r.title?.org ?? 'club'}:${r.from ?? ''}:${r.to ?? ''}:${i > 0 && !r.org?.id ? i : ''}`,
      provenance: r.provenance,
      current: !!r.current,
    }));
  }

  /** Verified relationships. Prestige is NOT read: no org name, level, size
   *  or reputation influences anything here — only that the relationship is
   *  verified and distinct. */
  function relationshipSource(player) {
    const out = [];
    for (const o of db.orgs) {
      if (o.suspended) continue;
      const inSquad = (o.squad ?? []).some((row) => row.playerId === player.id);
      if (inSquad) out.push({ key: `rel:club:${o.id}`, kind: 'club', verified: !!o.verified });
    }
    for (const r of (db.verReferences ?? [])) {
      if (r.playerId !== player.id || r.status !== 'active') continue;
      const claim = (db.verClaims ?? []).find((c) => c.id === r.provenanceSnapshot?.claimId);
      const verified = !!claim && claim.status === 'verified';
      out.push({ key: `rel:coach:${r.coachUserId ?? r.byUserId ?? r.id}`, kind: 'coach', verified });
    }
    // Agency representation is adult-only by the standing rules; for a minor
    // it is excluded from the denominator rather than scored as missing.
    // D-P56A-1: the record's agency key is `agencyOrgId` (there is no
    // `orgId` on an M13 F10 representation), and `confirmedAt` survives a
    // withdrawal, a dispute and expiry — only a currently ACTIVE, unexpired,
    // player-confirmed relationship is a verified relationship.
    const now = Date.now();
    for (const rep of (db.representations ?? [])) {
      if (rep.playerId !== player.id || !rep.confirmedAt || rep.status !== 'active') continue;
      if (rep.endAt && rep.endAt < now) continue;
      out.push({ key: `rel:agency:${rep.agencyOrgId}`, kind: 'agency', verified: true });
    }
    // M23 P5.6E: the CANONICAL P5.6B lane is a relationship source too. Without
    // this, Trust was blind to the authoritative lane and could only see the
    // legacy one — so a real, licensed, client-confirmed relationship counted
    // for nothing while a legacy row counted.
    //
    // The same state filter applies, for the same reason (D-P56A-1): only a row
    // that names a licensed individual, was confirmed by the client, is
    // `active` and has not passed its end date is a verified relationship. The
    // key is the AGENCY, so one client represented by two agencies is two
    // relationships and moving between agents inside one agency is not.
    for (const a of (db.representationAgreements ?? [])) {
      if (!a || a.clientId !== player.id) continue;
      if (typeof a.agentUserId !== 'string' || !a.agentUserId) continue; // a legacy mirror names nobody
      if (!a.confirmedAt || a.status !== 'active') continue;
      if (typeof a.endAt === 'number' && a.endAt <= now) continue;
      out.push({ key: `rel:agency:${a.agencyOrgId}`, kind: 'agency', verified: true });
    }
    return out;
  }

  /** M12 evidence records mapped to their canonical provenance. */
  function evidenceSource(player) {
    return (db.evidence ?? [])
      .filter((e) => e.playerId === player.id && !e.supersededBy && !(e.expiresAt && e.expiresAt < Date.now()))
      .map((e) => ({
        key: `ev:${e.id}`,
        provenance: e.verification?.status === 'club_assessed' ? 'verified_club_confirmed'
          : e.verification?.status === 'coach_confirmed' ? 'verified_coach_confirmed'
            : e.source?.kind === 'guardian' ? 'guardian_submitted' : 'player_submitted',
        recordedAt: e.recordedAt ?? 0,
      }));
  }

  /** Box Cam observed sessions (finalized, still standing). */
  function boxCamSource(player) {
    return (db.boxSessions ?? [])
      .filter((s) => s.playerId === player.id && s.finalizedAt)
      .map((s) => ({
        key: `box:${s.id}`,
        verificationState: s.verificationState,
        simulated: !!PROVIDERS[s.provider]?.testOnly,
        endedAt: s.endedAt ?? 0,
      }));
  }

  /** Combine attempts with their LIVE effective state — an attempt whose
   *  bound Box Cam session was invalidated stops contributing immediately,
   *  and a restore brings it back, with no penalty either way. The measured
   *  VALUE is deliberately not included in this projection at all. */
  function combineSource(player) {
    return (db.combineAttempts ?? [])
      .filter((a) => a.playerId === player.id)
      .map((a) => {
        const s = (db.boxSessions ?? []).find((x) => x.id === a.boxSessionId);
        const invalidated = !!s && s.verificationState === 'invalidated';
        return {
          key: `catt:${a.id}`,
          protocolId: a.protocolId, protocolVersion: a.protocolVersion,
          combineState: invalidated ? 'invalidated' : a.combineState,
          simulated: !!PROVIDERS[a.provider]?.testOnly,
        };
      });
  }

  function referenceSource(player) {
    return (db.verReferences ?? [])
      .filter((r) => r.playerId === player.id && r.status === 'active')
      .map((r) => {
        const claim = (db.verClaims ?? []).find((c) => c.id === r.provenanceSnapshot?.claimId);
        return { key: `ref:${r.id}`, verified: !!claim && claim.status === 'verified' };
      });
  }

  /** Assessments contribute by ATTRIBUTION only — the rating content is never
   *  read, so a 4/10 and a 9/10 from the same verified evaluator are
   *  identical evidence. */
  function assessmentSource(player) {
    return (db.assessments ?? [])
      .filter((a) => a.playerId === player.id && ['submitted', 'reviewed', 'published'].includes(a.state ?? ''))
      .map((a) => ({ key: `asmt:${a.id}`, verifiedSource: !!db.orgs.find((o) => o.id === a.orgId)?.verified }));
  }

  /** Build the full Trust Profile for a player. `full` is an already-built
   *  light Passport assembly when the caller has one (batch reuse). */
  function buildFor(player, { full = null } = {}) {
    const assembled = full ?? ctx.assemblePassport?.(player, { light: true }) ?? null;
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
  // Snapshot an ALREADY-built profile, so a caller that has one (a Recruitment
  // Room capturing decision context) does not rebuild it just to snapshot it.
  ctx.trustSnapshotOf = (profile) => trustSnapshot(profile);
  ctx.safeTrustProjection = safeTrustProjection;

  const band = (p) => p.band;
  const countBand = (p) => { vmetric?.(`trust_band_${band(p)}`); };

  // ================================================================ PLAYER
  playerRouter.get('/trust-profile', (req, res) => {
    const p = buildFor(req.player);
    vmetric?.('trust_profile_viewed');
    countBand(p);
    res.json({ trust: safeTrustProjection(p, 'self') });
  });

  // The explanation ("Why this score?") is the same derivation — surfaced
  // separately so the metric distinguishes a view from a drill-down.
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
  // The standing gates run FIRST and are entirely independent of the score:
  // a Trust Score of 100 opens no door that a score of 0 would not.
  orgRouter.get('/players/:id/trust-profile', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p)) return res.status(p ? 403 : 404).json({ error: p ? 'NOT_VISIBLE' : 'PLAYER_NOT_FOUND' });
    const viewer = req.org.type === 'grassroots' ? 'grassroots_club' : 'pro_club';
    vmetric?.('trust_profile_viewed');
    res.json({ playerId: p.id, trust: safeTrustProjection(buildFor(p), viewer) });
  });

  /** Batch summaries for player lists (§53). Light assembly per player, no
   *  full timeline build, and never a ranking — the caller sorts. */
  orgRouter.get('/trust-summaries', (req, res) => {
    const ids = String(req.query.playerIds ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const items = [];
    for (const id of ids) {
      const p = findPlayer(id);
      if (!p || !orgCanSee(req.org, p)) continue; // silently omitted — no leak
      items.push({ playerId: p.id, ...trustSummary(buildFor(p)) });
    }
    res.json({
      items,
      note: 'Evidence confidence — not football ability. Results are returned in the order requested and are never ranked by Trust Score.',
    });
  });

  // =================================================================== T&S
  // Trust & Safety can inspect the full derivation but cannot type a score:
  // there is no write route at all. A wrong score is fixed by correcting the
  // underlying evidence or the policy, then recalculating.
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

  adminRouter.get('/trust-policy', (_req, res) => res.json({
    policyVersion: TRUST_SCORE_POLICY_VERSION, weights: POLICY.weights, bands: POLICY.bands,
    curves: { relationships: POLICY.relationships.curve, combineProtocols: POLICY.combine.protocolCurve, boxCam: POLICY.evidence.boxCamCurve, evidenceRecords: POLICY.evidence.recordsCurve, references: POLICY.references.curve },
    subCaps: { evidenceRecords: POLICY.evidence.recordsSubCap, boxCam: POLICY.evidence.boxCamSubCap },
    disclaimer: TRUST_DISCLAIMER,
  }));

  return { buildFor };
}
