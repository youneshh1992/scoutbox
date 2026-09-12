// M15 shared — Football Passport pure engine.
//
// The Passport is a PROJECTION over existing ScoutBox records (M12 evidence,
// M14 claims/references, trials, assessments, opportunities, objectives,
// transitions, signings, representation) plus a handful of narrowly scoped
// M15 records (self-submitted career entries, achievements, preferences,
// shares, corrections). Nothing here stores a second copy of a fact that
// another system owns; nothing here scores a player.
//
// Everything in this file is a pure function over plain data so the engine
// is unit-testable without a server.
import crypto from 'node:crypto';

// ------------------------------------------------------------- provenance
// One vocabulary for "where did this come from". Ordered least→most
// authoritative; ranking is used ONLY for conflict precedence per field,
// never rendered as a score.
export const PROVENANCE = [
  'player_submitted', 'guardian_submitted', 'system_recorded',
  'historical_migration',
  // M16: first-party observed training evidence — stronger than a player's
  // own submission, deliberately weaker than a ScoutBox review or any
  // organisation confirmation. Never an authoritative current-club source.
  'box_cam_observed',
  'scoutbox_reviewed', 'verified_coach_confirmed',
  'verified_club_confirmed', 'authoritative_registry',
];
export const provRank = (p) => PROVENANCE.indexOf(p);

/** Map an M14 claim verification method onto Passport provenance. */
export function provenanceFromMethod(method) {
  switch (method) {
    case 'authoritative_registry':
    case 'federation_confirmation': return 'authoritative_registry';
    case 'organisation_admin_confirmation': return 'verified_club_confirmed';
    case 'existing_verified_org_admin': return 'verified_club_confirmed';
    case 'official_domain_email': return 'verified_club_confirmed';
    case 'scoutbox_manual_review': return 'scoutbox_reviewed';
    case 'migration': return 'historical_migration';
    default: return 'system_recorded';
  }
}

// Honest per-provenance copy (EN defaults; clients translate by code).
export const PROVENANCE_COPY = {
  player_submitted: 'Provided by the player. ScoutBox has not independently confirmed this item.',
  guardian_submitted: 'Provided by the player’s guardian. ScoutBox has not independently confirmed this item.',
  system_recorded: 'Recorded automatically by ScoutBox from platform activity.',
  historical_migration: 'Carried forward from an earlier ScoutBox record.',
  scoutbox_reviewed: 'Reviewed by ScoutBox Trust & Safety — a document review, not an independent register check.',
  verified_coach_confirmed: 'Confirmed by a coach whose club affiliation was verified when they confirmed it.',
  verified_club_confirmed: 'Confirmed by an authorised administrator of the named organisation.',
  authoritative_registry: 'Confirmed against an authoritative registry.',
  box_cam_observed: 'Recorded live through ScoutBox Box Cam. ScoutBox observed activity consistent with the selected supported drill — this describes observed training, not football ability.',
};

// ------------------------------------------------------------- visibility
// Narrowing-only levels. An item's level comes from its SOURCE policy;
// player/guardian selections may narrow, never widen.
export const VISIBILITY = ['public', 'recruitment', 'private', 'guardian_only', 'trust_and_safety'];
export const VIEWERS = ['self', 'guardian', 'pro_club', 'grassroots_club', 'agency', 'other_player', 'public', 'trust_safety'];

export function viewerSees(viewer, visibility) {
  switch (viewer) {
    case 'trust_safety': return true;
    case 'self': return visibility !== 'trust_and_safety' && visibility !== 'guardian_only';
    case 'guardian': return visibility !== 'trust_and_safety';
    case 'pro_club':
    case 'grassroots_club': return visibility === 'public' || visibility === 'recruitment';
    case 'agency': return visibility === 'public' || visibility === 'recruitment';
    case 'other_player':
    case 'public': return visibility === 'public';
    default: return false;
  }
}

// ------------------------------------------------- date precision honesty
// Football history rarely has exact days. We keep the SOURCE precision:
// 'day' | 'month' | 'year'; nothing invents a date it was never given.
export function normWhen(input) {
  if (input == null) return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    const d = new Date(input);
    return { t: input, precision: 'day', y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  if (typeof input === 'object') {
    const y = Number(input.year ?? input.y);
    if (!Number.isFinite(y)) return null;
    const m = input.month ?? input.m;
    if (m != null && Number.isFinite(Number(m))) {
      const mm = Math.min(Math.max(Number(m), 1), 12);
      return { t: Date.UTC(y, mm - 1, 1), precision: 'month', y, m: mm };
    }
    return { t: Date.UTC(y, 0, 1), precision: 'year', y };
  }
  if (typeof input === 'string') {
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
    if (dm) return normWhen(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]));
    const mm = /^(\d{4})-(\d{2})$/.exec(input);
    if (mm) return normWhen({ year: +mm[1], month: +mm[2] });
    const yy = /^(\d{4})$/.exec(input);
    if (yy) return normWhen({ year: +yy[1] });
  }
  return null;
}
export function whenDisplay(w) {
  if (!w) return null;
  if (w.precision === 'year') return String(w.y);
  if (w.precision === 'month') return `${w.y}-${String(w.m).padStart(2, '0')}`;
  return new Date(w.t).toISOString().slice(0, 10);
}

// ------------------------------------------------------ canonical event id
// Derived events are deterministic: same source ⇒ same id, no duplicates on
// re-projection. sourceType + sourceId + semantic IS the identity.
export const evId = (sourceType, sourceId, semantic) => `pev:${sourceType}:${sourceId}:${semantic}`;

// --------------------------------------------------------------- timeline
// Input: pre-normalised source arrays (assembled server-side). Output:
// deterministic, deduplicated, reverse-chronological events with provenance,
// visibility and a traceable source reference. Ties sort by precision
// (finer first) then id — stable under equal timestamps.
export function buildTimeline(src) {
  const events = [];
  const push = (e) => { if (e.when) events.push(e); };
  const org = (id, name) => (id || name ? { id: id ?? null, name: name ?? null } : null);

  // M14 affiliation claims (already annotated with effective status).
  for (const { claim, eff } of src.affiliations ?? []) {
    if (!eff.displayable) continue;
    const prov = provenanceFromMethod(claim.verificationMethod);
    const o = org(claim.organisationId, claim.orgName);
    const joined = normWhen(claim.validFrom ?? claim.verifiedAt);
    push({
      id: evId('claim', claim.id, 'club_joined'), type: 'club_joined', when: joined,
      title: { org: o?.name, role: claim.role ?? null }, org: o, provenance: prov,
      assurance: claim.assurance ?? null, visibility: 'public', current: eff.current,
      source: { type: 'verification_claim', id: claim.id },
    });
    if (claim.verifiedAt && claim.validFrom && Math.abs(claim.verifiedAt - claim.validFrom) > 86_400_000) {
      push({
        id: evId('claim', claim.id, 'club_affiliation_verified'), type: 'club_affiliation_verified',
        when: normWhen(claim.verifiedAt), title: { org: o?.name }, org: o, provenance: prov,
        visibility: 'public', source: { type: 'verification_claim', id: claim.id },
      });
    }
    if (claim.current === false && claim.validUntil) {
      push({
        id: evId('claim', claim.id, 'club_left'), type: 'club_left', when: normWhen(claim.validUntil),
        title: { org: o?.name }, org: o, provenance: prov, visibility: 'public',
        source: { type: 'verification_claim', id: claim.id },
      });
    }
  }

  // Self/guardian-submitted career entries (M15 records).
  for (const c of src.careerEntries ?? []) {
    if (c.withdrawnAt) continue;
    const o = org(null, c.orgName);
    push({
      id: evId('career', c.id, 'club_joined'), type: 'club_joined', when: normWhen(c.from),
      title: { org: c.orgName, role: c.role ?? null }, org: o,
      provenance: c.submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted',
      // Self-submitted history is recruitment-visible with honest provenance;
      // it reaches the PUBLIC passport only by explicit selection.
      visibility: 'recruitment', publicEligible: true, current: !c.to, source: { type: 'career_entry', id: c.id },
    });
    if (c.to) {
      push({
        id: evId('career', c.id, 'club_left'), type: 'club_left', when: normWhen(c.to),
        title: { org: c.orgName }, org: o,
        provenance: c.submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted',
        visibility: 'recruitment', publicEligible: true, source: { type: 'career_entry', id: c.id },
      });
    }
  }

  // Squad membership (invite-approved; grassroots club lists).
  for (const s of src.squads ?? []) {
    push({
      id: evId('squad', `${s.orgId}:${s.rowId}`, 'club_joined'), type: 'club_joined',
      when: normWhen(s.addedAt), title: { org: s.orgName, role: 'squad' }, org: org(s.orgId, s.orgName),
      provenance: s.orgVerified ? 'verified_club_confirmed' : 'system_recorded',
      visibility: 'public', current: true, source: { type: 'squad_row', id: `${s.orgId}:${s.rowId}` },
    });
  }

  // Trials. A trial is NEVER employment. Participation may become publicly
  // visible only by explicit selection; outcomes stay private by default.
  for (const t of src.trials ?? []) {
    const o = org(t.orgId, t.orgName);
    push({
      id: evId('trial', t.id, 'trial_attended'), type: 'trial_attended',
      when: normWhen(t.proposedDate ?? t.acceptedAt), title: { org: o?.name }, org: o,
      provenance: 'verified_club_confirmed', visibility: 'recruitment_own_org',
      publicEligible: true, source: { type: 'trial', id: t.id },
    });
    if (t.report) {
      push({
        id: evId('trial', t.id, 'trial_outcome'), type: 'trial_outcome',
        when: normWhen(t.report.at ?? t.proposedDate ?? t.acceptedAt), title: { org: o?.name }, org: o,
        provenance: 'verified_club_confirmed', visibility: 'private_own_org',
        source: { type: 'trial', id: t.id },
      });
    }
  }

  // Assessments: existence only, and only once feedback exists for the
  // player OR for the assessing org itself (raw notes never travel).
  for (const a of src.assessments ?? []) {
    push({
      id: evId('assessment', a.id, 'assessment_completed'), type: 'assessment_completed',
      when: normWhen(a.submittedAt ?? a.createdAt), title: { org: a.orgName ?? null }, org: org(a.orgId, a.orgName),
      provenance: 'verified_club_confirmed', visibility: 'recruitment_own_org',
      source: { type: 'assessment', id: a.id },
    });
  }

  // Coach references (M14): snapshot provenance, never rewritten.
  for (const r of src.references ?? []) {
    push({
      id: evId('reference', r.id, 'reference_received'), type: 'reference_received',
      when: normWhen(r.createdAt), title: { coach: r.coachName, org: r.orgName }, org: org(r.orgId, r.orgName),
      provenance: 'verified_coach_confirmed', visibility: 'recruitment',
      source: { type: 'coach_reference', id: r.id },
    });
  }

  // Evidence: only footage-class additions make the timeline (summary covers
  // the rest); self-reported provenance stays honest.
  for (const e of src.evidence ?? []) {
    if (e.claimType !== 'footage' || e.superseded) continue;
    push({
      id: evId('evidence', e.id, 'evidence_added'), type: 'evidence_added',
      when: normWhen(e.recordedAt), title: { label: e.label },
      provenance: e.tier === 'club_assessed' ? 'verified_club_confirmed' : e.tier === 'coach_confirmed' ? 'verified_coach_confirmed' : e.sourceKind === 'guardian' ? 'guardian_submitted' : 'player_submitted',
      visibility: 'recruitment', publicEligible: true, source: { type: 'evidence', id: e.id },
    });
  }

  // Development objectives — private by default.
  for (const oj of src.objectives ?? []) {
    push({
      id: evId('objective', oj.id, 'development_objective_created'), type: 'development_objective_created',
      when: normWhen(oj.createdAt), title: { org: oj.orgName ?? null }, org: org(oj.orgId, oj.orgName),
      provenance: 'verified_club_confirmed', visibility: 'private', source: { type: 'dev_objective', id: oj.id },
    });
    if (oj.status === 'achieved' || oj.status === 'completed') {
      push({
        id: evId('objective', oj.id, 'development_objective_completed'), type: 'development_objective_completed',
        when: normWhen(oj.completedAt ?? oj.createdAt), title: { org: oj.orgName ?? null }, org: org(oj.orgId, oj.orgName),
        provenance: 'verified_club_confirmed', visibility: 'private', source: { type: 'dev_objective', id: oj.id },
      });
    }
  }

  // Opportunity applications — the player's own activity; outcomes private.
  for (const ap of src.applications ?? []) {
    push({
      id: evId('application', ap.id, 'opportunity_application'), type: 'opportunity_application',
      when: normWhen(ap.createdAt), title: { org: ap.orgName ?? null, opportunity: ap.opportunityTitle ?? null },
      org: org(ap.orgId, ap.orgName), provenance: 'system_recorded', visibility: 'private',
      source: { type: 'application', id: ap.id },
    });
  }

  // Transitions — confidential.
  for (const t of src.transitions ?? []) {
    push({
      id: evId('transition', t.id, 'transition_opened'), type: 'transition_opened',
      when: normWhen(t.createdAt), title: {}, provenance: 'system_recorded', visibility: 'private',
      source: { type: 'transition', id: t.id },
    });
    if (t.placement) {
      push({
        id: evId('transition', t.id, 'transition_completed'), type: 'transition_completed',
        when: normWhen(t.placement.at ?? t.createdAt), title: { org: t.placement.orgName ?? null },
        provenance: 'system_recorded', visibility: 'private', source: { type: 'transition', id: t.id },
      });
    }
  }

  // Signings — club-confirmed career outcomes.
  for (const s of src.signings ?? []) {
    push({
      id: evId('signing', s.id, 'signed'), type: 'signed', when: normWhen(s.ts),
      title: { org: s.orgName }, org: org(s.orgId, s.orgName),
      provenance: 'verified_club_confirmed', visibility: 'public', source: { type: 'signing', id: s.id },
    });
  }

  // Post-signing outcome reports — progression notes (recruitment view).
  for (const o2 of src.outcomes ?? []) {
    push({
      id: evId('outcome', o2.id, 'role_or_squad_changed'), type: 'role_or_squad_changed',
      when: normWhen(o2.at), title: { org: o2.orgName ?? null, note: o2.progression ?? o2.registrationStatus ?? null },
      org: org(o2.orgId, o2.orgName), provenance: 'verified_club_confirmed', visibility: 'recruitment',
      source: { type: 'outcome_report', id: o2.id },
    });
  }

  // Representation (adults only upstream) — never public.
  for (const r of src.representations ?? []) {
    push({
      id: evId('representation', r.id, 'representation_started'), type: 'representation_started',
      when: normWhen(r.confirmedAt ?? r.startAt), title: { org: r.agencyName }, org: org(r.agencyOrgId, r.agencyName),
      provenance: 'system_recorded', visibility: 'recruitment', source: { type: 'representation', id: r.id },
    });
    if (r.withdrawnAt || (r.endAt && r.endAt < Date.now())) {
      push({
        id: evId('representation', r.id, 'representation_ended'), type: 'representation_ended',
        when: normWhen(r.withdrawnAt ?? r.endAt), title: { org: r.agencyName }, org: org(r.agencyOrgId, r.agencyName),
        provenance: 'system_recorded', visibility: 'recruitment', source: { type: 'representation', id: r.id },
      });
    }
  }

  // Achievements (M15): provenance follows confirmation state.
  for (const a of src.achievements ?? []) {
    if (a.withdrawnAt) continue;
    push({
      id: evId('achievement', a.id, 'achievement'), type: 'achievement', when: normWhen(a.when),
      title: { label: a.title, org: a.orgName ?? null },
      provenance: a.confirmation ? a.confirmation.provenance : (a.submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted'),
      visibility: 'recruitment', publicEligible: true, source: { type: 'achievement', id: a.id },
    });
  }

  // M16 Box Cam: meaningful sessions only (the caller pre-filters — the
  // career timeline is never flooded with every minor session; detailed
  // history lives in Box Training).
  for (const b of src.boxSessions ?? []) {
    push({
      id: evId('box_session', b.id, 'box_session_completed'), type: 'box_session_completed',
      when: normWhen(b.endedAt), title: { drill: b.drillTitle, verifiedActive: b.verifiedActive, reps: b.verifiedReps ?? null, targetCompleted: b.targetCompleted === true },
      org: b.assignedByOrg ? { id: b.assignedByOrg.id, name: b.assignedByOrg.name } : null,
      provenance: 'box_cam_observed', visibility: 'private',
      source: { type: 'box_session', id: b.id },
    });
  }
  for (const c of src.boxChallenges ?? []) {
    push({
      id: evId('box_challenge', c.entryId, 'box_challenge_completed'), type: 'box_challenge_completed',
      when: normWhen(c.completedAt), title: { label: c.title, publisher: c.publisherName ?? 'ScoutBox' },
      org: c.publisherOrg ? { id: c.publisherOrg.id, name: c.publisherOrg.name } : null,
      provenance: 'box_cam_observed', visibility: 'recruitment', publicEligible: true,
      source: { type: 'box_challenge_entry', id: c.entryId },
    });
  }

  // Position changes (self-declared history).
  for (const p of src.positionHistory ?? []) {
    push({
      id: evId('position', p.id, 'position_change'), type: 'position_change', when: normWhen(p.from),
      title: { primary: p.primary, secondary: p.secondary ?? [] }, provenance: 'player_submitted',
      visibility: 'recruitment', source: { type: 'position_entry', id: p.id },
    });
  }

  // Dedupe on canonical id, then deterministic ordering: newest first,
  // finer precision first on ties, id as the final tiebreak.
  const seen = new Map();
  for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
  const precRank = { day: 0, month: 1, year: 2 };
  return [...seen.values()].sort((a, b) =>
    (b.when.t - a.when.t) || (precRank[a.when.precision] - precRank[b.when.precision]) || (a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------ club history
// Best-evidence career rows. Authoritative rows win display for the same
// organisation/period; self entries that duplicate an authoritative row are
// folded into it (and flagged for the self view). A trial NEVER creates a
// club-history row.
export function clubHistory(src) {
  const rows = [];
  for (const { claim, eff } of src.affiliations ?? []) {
    if (!eff.displayable) continue;
    rows.push({
      key: `claim:${claim.id}`, orgId: claim.organisationId ?? null, orgName: claim.orgName ?? null,
      role: claim.role ?? null, from: normWhen(claim.validFrom ?? claim.verifiedAt), to: claim.validUntil ? normWhen(claim.validUntil) : null,
      current: eff.current, provenance: provenanceFromMethod(claim.verificationMethod),
      assurance: claim.assurance ?? null, source: { type: 'verification_claim', id: claim.id },
    });
  }
  for (const sg of src.signingRows ?? []) {
    rows.push({
      key: `signing:${sg.id}`, orgId: sg.orgId, orgName: sg.orgName, role: null,
      from: normWhen(sg.ts), to: sg.endedAt ? normWhen(sg.endedAt) : null, current: !sg.endedAt && !sg.orgSuspended,
      provenance: 'verified_club_confirmed', source: { type: 'signing', id: sg.id },
    });
  }
  for (const s of src.squads ?? []) {
    if (rows.some((r) => r.orgId === s.orgId && r.current)) continue; // claim/signing already covers it
    rows.push({
      key: `squad:${s.orgId}`, orgId: s.orgId, orgName: s.orgName, role: 'squad',
      from: normWhen(s.addedAt), to: null, current: true,
      provenance: s.orgVerified ? 'verified_club_confirmed' : 'system_recorded',
      source: { type: 'squad_row', id: `${s.orgId}:${s.rowId}` },
    });
  }
  const foldedConflicts = [];
  for (const c of src.careerEntries ?? []) {
    if (c.withdrawnAt) continue;
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    const authoritative = rows.find((r) => norm(r.orgName) === norm(c.orgName));
    if (authoritative) { foldedConflicts.push({ entryId: c.id, into: authoritative.key }); continue; }
    rows.push({
      key: `career:${c.id}`, orgId: null, orgName: c.orgName, role: c.role ?? null,
      from: normWhen(c.from), to: c.to ? normWhen(c.to) : null, current: !c.to,
      provenance: c.submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted',
      source: { type: 'career_entry', id: c.id },
    });
  }
  rows.sort((a, b) => ((b.from?.t ?? 0) - (a.from?.t ?? 0)) || (a.key < b.key ? -1 : 1));
  return { rows, foldedConflicts };
}

// --------------------------------------------------------- current status
// Field-level precedence (§57): authoritative registry > verified club >
// verified coach > ScoutBox review > guardian > player. Player input NEVER
// silently wins over an authoritative current record — it becomes a flagged
// conflict for the self view instead.
export function currentStatus({ history, prefs, representations = [], identity = null }) {
  const authoritative = history.rows.find((r) => r.current && provRank(r.provenance) >= provRank('scoutbox_reviewed'));
  const selfCurrent = history.rows.find((r) => r.current && (r.provenance === 'player_submitted' || r.provenance === 'guardian_submitted'));
  const conflicts = [];
  if (authoritative && selfCurrent && authoritative.key !== selfCurrent.key) {
    conflicts.push({
      code: 'CURRENT_CLUB_CONFLICT',
      authoritative: { orgName: authoritative.orgName, provenance: authoritative.provenance, source: authoritative.source },
      submitted: { orgName: selfCurrent.orgName, provenance: selfCurrent.provenance, source: selfCurrent.source },
    });
  }
  const anyCurrent = history.rows.find((r) => r.current);
  const currentClub = authoritative ?? anyCurrent ?? null;
  const activeRep = representations.find((r) => r.status === 'active');
  return {
    currentClub: currentClub && {
      orgId: currentClub.orgId, orgName: currentClub.orgName, role: currentClub.role,
      since: currentClub.from ? whenDisplay(currentClub.from) : null,
      provenance: currentClub.provenance, assurance: currentClub.assurance ?? null,
    },
    positions: prefs?.positions ?? null, // { primary, secondary[] } player-declared
    availability: prefs?.availability ?? null,
    availableFrom: prefs?.availableFrom ?? null,
    representation: activeRep ? { agencyName: activeRep.agencyName, scope: activeRep.scope, since: whenDisplay(normWhen(activeRep.confirmedAt ?? activeRep.startAt)) } : null,
    identity,
    conflicts,
  };
}

// -------------------------------------------------- temporal consistency
// Impossible chronology becomes a TEMPORAL_CONFLICT flag for correction —
// never an automatic fraud accusation.
export function temporalConflicts({ events = [], history = [], dob = null }) {
  const out = [];
  const dobT = dob ? normWhen(String(dob))?.t ?? null : null;
  for (const e of events) {
    if (dobT && e.when.t < dobT) out.push({ code: 'TEMPORAL_CONFLICT', kind: 'before_dob', eventId: e.id });
    if (e.when.t > Date.now() + 400 * 86_400_000) out.push({ code: 'TEMPORAL_CONFLICT', kind: 'far_future', eventId: e.id });
  }
  for (const r of history) {
    if (r.from && r.to && r.to.t < r.from.t) out.push({ code: 'TEMPORAL_CONFLICT', kind: 'left_before_joined', key: r.key });
  }
  const currentExclusive = history.filter((r) => r.current && r.role !== 'squad' && provRank(r.provenance) >= provRank('scoutbox_reviewed'));
  if (currentExclusive.length > 1) out.push({ code: 'TEMPORAL_CONFLICT', kind: 'overlapping_current_authoritative', keys: currentExclusive.map((r) => r.key) });
  return out;
}

// ------------------------------------------------------------- gap engine
// Deterministic, versioned, non-shaming. Each rule: stable id, version,
// condition over facts, explanation code (clients translate), suggested
// action, auto-resolution = condition turning false. NO AI, NO scores.
export const GAP_RULES_VERSION = 2;
export const GAP_RULES = [
  { id: 'gap.full_match_recent', v: 1, category: 'match_evidence', test: (f) => !f.hasRecentFullMatch },
  // v2 (M16): contextual and optional — never daily-training pressure.
  { id: 'gap.training_evidence', v: 2, category: 'training', test: (f) => !f.hasRecentTrainingEvidence },
  { id: 'gap.coach_reference', v: 1, category: 'references', test: (f) => f.referenceCount === 0 },
  { id: 'gap.current_club_confirmed', v: 1, category: 'club_history', test: (f) => !f.hasConfirmedCurrentClub },
  { id: 'gap.assessment_recent', v: 1, category: 'assessments', test: (f) => !f.hasRecentAssessment },
  { id: 'gap.position_declared', v: 1, category: 'position', test: (f) => !f.hasPosition },
  { id: 'gap.availability_set', v: 1, category: 'availability', test: (f) => !f.hasAvailability },
  { id: 'gap.identity_confirmed', v: 1, category: 'identity', test: (f) => !f.identityConfirmed },
  { id: 'gap.career_history', v: 1, category: 'career', test: (f) => f.historyRows === 0 },
];
export function evaluateGaps(facts) {
  return GAP_RULES.filter((r) => r.test(facts)).map((r) => ({ id: r.id, version: r.v, category: r.category }));
}

// Deterministic descriptors — coverage words, never ability, never a score.
export function completeness(facts) {
  const gaps = evaluateGaps(facts);
  const satisfied = GAP_RULES.length - gaps.length;
  const evidencePoints = (facts.fullMatchCount > 0 ? 1 : 0) + (facts.hasRecentFullMatch ? 1 : 0)
    + (facts.clipCount > 0 ? 1 : 0) + (facts.referenceCount > 0 ? 1 : 0) + (facts.hasRecentAssessment ? 1 : 0);
  const evidenceCoverage = evidencePoints >= 4 ? 'strong' : evidencePoints >= 2 ? 'moderate' : 'limited';
  return {
    evidenceCoverage,
    gaps,
    eligibility: {
      // "x of y generic checks": the denominator is EXACTLY the versioned
      // generic rule list above — never a club's confidential criteria.
      satisfied, total: GAP_RULES.length, rulesVersion: GAP_RULES_VERSION,
      missing: gaps.map((g) => g.id),
    },
  };
}

// -------------------------------------------------------- share tokens
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const mintShareSecret = () => crypto.randomBytes(24).toString('base64url');
export const SHARE_MODES = ['public', 'recruitment'];

/** Pure share validation (no consumption — shares are multi-use until
 *  revoked/expired). Exact failure codes; unknown & revoked & expired all
 *  surface identically at the route (404 concealment). */
export function shareProblem(share, { now = Date.now(), playerRemoved = false } = {}) {
  if (!share) return 'SHARE_UNKNOWN';
  if (share.revokedAt) return 'SHARE_REVOKED';
  if (share.expiresAt && share.expiresAt < now) return 'SHARE_EXPIRED';
  if (playerRemoved) return 'SUBJECT_REMOVED';
  return null;
}

// ------------------------------------------------------------- projection
// The ONE viewer filter. Client apps receive already-filtered payloads and
// never reconstruct the Passport from raw endpoints.
const OWN_ORG_VIS = new Set(['recruitment_own_org', 'private_own_org']);
function eventVisibleTo(e, viewer, { orgId = null, publicSelections = new Set() } = {}) {
  const vis = e.visibility;
  if (viewer === 'trust_safety') return true;
  if (viewer === 'self') return vis !== 'trust_and_safety';
  if (viewer === 'guardian') return vis !== 'trust_and_safety';
  if (viewer === 'public' || viewer === 'other_player') {
    if (vis === 'public') return true;
    // Opt-in public items: allowed ONLY where the source is public-eligible.
    return !!e.publicEligible && publicSelections.has(e.id);
  }
  // org viewers (pro/grassroots/agency — upstream gates already applied)
  if (vis === 'public' || vis === 'recruitment') return true;
  if (OWN_ORG_VIS.has(vis)) return !!orgId && e.org?.id === orgId;
  return false;
}

/**
 * M18.1 — the Football Passport CONTENT revision.
 *
 * `passportVersion` is the projection SCHEMA version and is deliberately still
 * the constant 1. What was missing, and what a decision snapshot actually needs,
 * is a token that says *which Passport truth* a club was looking at when it
 * decided. This is that token: a stable hash over the canonical inputs.
 *
 * Two properties matter more than the hash itself:
 *
 *   1. It does NOT move on a read. Everything derived from "now" — the rolling
 *      development-activity window, `lastEvidenceDays`, the recency flags in
 *      completeness — is excluded, because otherwise the revision would change
 *      overnight while nothing about the player had changed.
 *   2. It DOES move when passport truth moves: club history and its provenance,
 *      the confirmed current club, position, identity assurance, evidence
 *      identity and verification tier, references, achievements and their
 *      confirmations, and verified Combine results.
 *
 * It is a fingerprint, not a sequence: it cannot be compared for order, only
 * for equality, which is exactly what "is this the same Passport I saw?" needs.
 */
export function passportRevision(full) {
  if (!full) return null;
  const parts = [];
  const push = (label, value) => parts.push(`${label}=${value ?? ''}`);

  push('pos', full.player?.position);
  push('lvl', full.player?.level);
  push('idn', full.identity ? `${full.identity.confirmed ? 1 : 0}:${full.identity.assurance ?? ''}` : '0');
  const cc = full.status?.currentClub;
  push('club', cc ? `${cc.orgId ?? cc.orgName ?? ''}:${cc.provenance ?? ''}:${cc.assurance ?? ''}` : 'none');

  for (const r of [...(full.history?.rows ?? [])].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    push('hist', `${r.key}:${r.provenance}:${r.current ? 1 : 0}:${r.from?.t ?? ''}:${r.to?.t ?? ''}:${r.role ?? ''}`);
  }
  for (const e of [...(full.revisionSources?.evidence ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    push('evd', `${e.id}:${e.tier}:${e.superseded ? 1 : 0}:${e.expired ? 1 : 0}`);
  }
  for (const r of [...(full.references ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    push('ref', `${r.id}:${r.status ?? ''}:${r.provenanceStillCurrent ? 1 : 0}`);
  }
  for (const a of [...(full.achievements ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    push('ach', `${a.id}:${a.confirmation ? 'confirmed' : 'self'}:${a.withdrawnAt ? 'withdrawn' : 'live'}`);
  }
  for (const c of [...(full.combine?.results ?? [])].sort((a, b) => (String(a.protocolId) < String(b.protocolId) ? -1 : 1))) {
    // An invalidated session drops its result from this set entirely, so the
    // revision moves on invalidation and moves back on restoration.
    push('cmb', `${c.protocolId}@${c.protocolVersion ?? ''}:${c.measuredValue ?? ''}:${c.combineVerified ? 1 : 0}`);
  }
  for (const c of [...(full.revisionSources?.careerEntries ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    push('car', `${c.id}:${c.withdrawnAt ? 'withdrawn' : 'live'}`);
  }
  return `pr_${crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)}`;
}

export function projectPassport(full, viewer, opts = {}) {
  const { orgId = null, shareMode = null } = opts;
  const publicSelections = new Set(full.prefs?.publicSelections ?? []);
  const filterEvents = (viewerKind) => full.timeline
    .filter((e) => eventVisibleTo(e, viewerKind, { orgId, publicSelections }))
    .map((e) => ({
      id: e.id, type: e.type, when: { display: whenDisplay(e.when), precision: e.when.precision },
      title: e.title, org: e.org ? { id: e.org.id, name: e.org.name } : null,
      provenance: e.provenance, provenanceCopy: PROVENANCE_COPY[e.provenance] ?? null,
      assurance: e.assurance ?? null, current: e.current ?? null,
      source: viewerKind === 'trust_safety' || viewerKind === 'self' || viewerKind === 'guardian' ? e.source : { type: e.source.type },
    }));
  const historyRows = (min) => full.history.rows
    .filter((r) => min === 'public' ? provRank(r.provenance) >= 0 : true)
    .map((r) => ({
      orgName: r.orgName, role: r.role, from: r.from ? whenDisplay(r.from) : null,
      to: r.to ? whenDisplay(r.to) : null, current: r.current,
      provenance: r.provenance, provenanceCopy: PROVENANCE_COPY[r.provenance] ?? null,
      assurance: r.assurance ?? null,
    }));

  const base = {
    // Schema version of this projection (unchanged since M15) and, since
    // M18.1, the CONTENT revision of the canonical facts behind it.
    passportVersion: 1,
    passportRevision: passportRevision(full),
    player: {
      id: full.player.id, name: full.player.name,
      age: full.player.age, position: full.player.position ?? null,
      // location: city-level only; precise coordinates never leave the
      // existing discovery surfaces.
      location: full.player.city ?? null,
      level: full.player.level ?? null,
    },
    identity: full.identity, // M14 structured identity assurance (or null)
    status: full.status,
    note: 'A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement.',
  };

  switch (viewer) {
    case 'self':
    case 'guardian':
      return {
        ...base, viewer,
        timeline: filterEvents(viewer),
        clubHistory: historyRows('all'),
        foldedConflicts: full.history.foldedConflicts,
        conflicts: full.status.conflicts,
        temporalConflicts: full.temporalConflicts,
        evidence: full.evidenceSummary,
        references: full.references.map((r) => refView(r, viewer)),
        achievements: full.achievements.map((a) => achievementView(a, viewer)),
        development: full.developmentSummary,
        trials: full.trialsSummary,
        completeness: full.completeness,
        developmentActivity: full.developmentActivity ?? null,
        combine: full.combine ?? null,
        sharing: full.sharingSummary,
        prefs: full.prefs ? { bio: full.prefs.bio ?? null, positions: full.prefs.positions ?? null, availability: full.prefs.availability ?? null, availableFrom: full.prefs.availableFrom ?? null, publicSelections: full.prefs.publicSelections ?? [] } : null,
      };
    case 'pro_club':
    case 'grassroots_club':
    case 'agency': {
      return {
        ...base, viewer,
        // Existing redaction policy holds: a minor's location is stripped
        // from every org view (mirrors playerViewForOrg).
        player: { ...base.player, location: full.player.minor ? null : base.player.location },
        // Conflict flags are a conversation between the player and T&S —
        // recruiting orgs get the resolved display, never the dispute.
        status: {
          currentClub: full.status.currentClub,
          positions: full.status.positions,
          availability: full.status.availability,
          availableFrom: full.status.availableFrom,
          representation: viewer === 'agency' || full.player.age >= 18 ? full.status.representation : null,
          identity: full.status.identity ?? null,
        },
        timeline: filterEvents(viewer),
        clubHistory: historyRows('all'),
        evidence: full.evidenceSummary,
        references: full.references.map((r) => refView(r, viewer)),
        achievements: full.achievements.filter((a) => a.confirmation || true).map((a) => achievementView(a, viewer)),
        assessments: (full.assessmentsForOrg ?? []).map((a) => ({ id: a.id, org: a.orgName ?? null, at: whenDisplay(normWhen(a.submittedAt ?? a.createdAt)), state: a.state })),
        trials: (full.trialsForOrg ?? []).map((t) => ({ id: t.id, org: t.orgName, date: t.proposedDate ?? null, hasReport: !!t.report })),
        availability: full.status.availability,
        representation: viewer === 'agency' || full.player.age >= 18 ? full.status.representation : null,
        // Development activity is an aggregate the player (or guardian)
        // explicitly opted into sharing for recruitment — never raw home
        // sessions, never automatic.
        developmentActivity: full.boxShareRecruitment ? full.developmentActivity ?? null : null,
        // At-Home Combine verified results, aggregate and recruitment-safe —
        // shown to a recruiting org only on the player's/guardian's explicit
        // recruitment opt-in. A club's own Combine request reads results
        // through the dedicated Combine endpoint instead.
        combine: full.boxShareRecruitment ? full.combine ?? null : null,
        shareMode,
      };
    }
    case 'other_player':
    case 'public':
      return {
        ...base, viewer: 'public',
        player: { id: full.player.id, name: full.player.name, age: full.player.age, position: full.player.position ?? null, location: full.player.minor ? null : full.player.city ?? null },
        identity: full.identity ? { confirmed: full.identity.confirmed, assurance: full.identity.assurance, label: full.identity.label } : null,
        status: {
          currentClub: full.status.currentClub && provRank(full.status.currentClub.provenance) >= provRank('scoutbox_reviewed')
            ? full.status.currentClub : null, // public shows CONFIRMED current club only
        },
        timeline: filterEvents('public'),
        clubHistory: historyRows('public').filter((r) => provRank(r.provenance) >= provRank('scoutbox_reviewed') || publicSelections.has(`hist:${r.orgName}`)),
        achievements: full.achievements.filter((a) => a.confirmation && publicSelections.has(evId('achievement', a.id, 'achievement'))).map((a) => achievementView(a, 'public')),
        evidence: { summaryOnly: true, fullMatches: full.evidenceSummary.fullMatches, clips: full.evidenceSummary.clips, lastEvidenceDays: full.evidenceSummary.lastEvidenceDays },
      };
    case 'trust_safety':
      return { ...base, viewer, timeline: filterEvents(viewer), clubHistory: historyRows('all'), conflicts: full.status.conflicts, temporalConflicts: full.temporalConflicts, graph: full.timeline.map((e) => ({ id: e.id, source: e.source, provenance: e.provenance, visibility: e.visibility })) };
    default:
      return null;
  }
}

function refView(r, viewer) {
  const base = {
    id: r.id, coachName: r.coachName, roleAtTime: r.roleAtTime, orgName: r.orgName,
    relationship: r.relationship, fromYear: r.fromYear, toYear: r.toYear,
    at: whenDisplay(normWhen(r.createdAt)),
    provenance: 'verified_coach_confirmed',
    provenanceCopy: r.provenanceStillCurrent
      ? `Coach's ${r.orgName} affiliation is verified.`
      : 'Coach affiliation was verified when this reference was submitted.',
  };
  if (viewer === 'self' || viewer === 'guardian' || viewer === 'pro_club' || viewer === 'grassroots_club' || viewer === 'trust_safety') {
    return { ...base, structured: r.structured };
  }
  return base;
}
function achievementView(a, viewer) {
  return {
    id: a.id, title: a.title, orgName: a.orgName ?? null, when: a.when ? whenDisplay(normWhen(a.when)) : null,
    provenance: a.confirmation ? a.confirmation.provenance : (a.submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted'),
    // The ORGANISATION stands behind a confirmation — individual staff
    // identity is never exposed to the player through the Passport.
    confirmedBy: a.confirmation ? a.confirmation.orgName ?? null : null,
    provenanceCopy: a.confirmation ? PROVENANCE_COPY[a.confirmation.provenance] : PROVENANCE_COPY[a.submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted'],
    ...(viewer === 'self' || viewer === 'guardian' ? { withdrawable: !a.confirmation } : {}),
  };
}
