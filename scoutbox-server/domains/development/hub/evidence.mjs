/**
 * Evidence links: references, resolved live, never copied.
 *
 * This is the file where the hub could most easily have gone wrong. The tempting
 * design is to copy the evidence into the development record: it makes the
 * plan self-contained, it makes rendering trivial, and it is wrong. A copy is
 * a second truth, and a second truth starts disagreeing with the first the
 * moment the original is superseded, expired, invalidated or hidden. A club
 * would then be reading a development plan that still asserts something the
 * evidence layer has withdrawn.
 *
 * So a link stores four things and no content:
 *
 *     { sourceType, sourceId, goalId | actionId, playerId }
 *
 * and everything a surface renders is resolved from the canonical record at
 * READ time, every time. Three consequences follow, and all three are wanted:
 *
 *   • an invalidated Combine result reads as invalid NOW, not as it was when
 *     someone linked it;
 *   • evidence the viewer may not see resolves to "unavailable" carrying no
 *     detail at all — not the label, not the value, not who recorded it;
 *   • the link itself survives. History honestly says something was cited and
 *     is no longer available, rather than quietly deleting the citation.
 *
 * The ownership rule is absolute and checked before anything else: a link may
 * only point at a record belonging to the same player as the plan. It is
 * the difference between a development plan and a way to read another player's
 * assessments.
 */
import { liveCombineState, isProductionValidCombine, combineProtocol, latestCombineProtocol } from '../boxcam/combineShared.mjs';
import { PROVIDERS } from '../boxcam/drills.mjs';
import { EVIDENCE_SOURCES, EVIDENCE_SOURCE_LABELS, UNAVAILABLE_REASONS } from './shared.mjs';
import { parseTrialDate } from '../../../domain.mjs';

/**
 * The complete set of keys an evidence-link record may carry. Asserted by the
 * acceptance suite against a real stored link: if a future change adds a
 * `label`, a `value` or a `note`, the store has started holding evidence and
 * the test fails. That is the whole point of the assertion.
 */
export const EVIDENCE_LINK_FIELDS = Object.freeze([
  'id', 'planId', 'goalId', 'actionId', 'playerId', 'sourceType', 'sourceId',
  'linkedByKind', 'linkedById', 'linkedByName', 'linkedAt',
]);

export const UNAVAILABLE_COPY = Object.freeze({
  evidence_not_found: 'This evidence is no longer available.',
  evidence_superseded: 'This evidence was replaced by a corrected record.',
  evidence_expired: 'This evidence has passed its validity period.',
  evidence_withdrawn: 'This evidence was invalidated after review.',
  evidence_not_visible: 'This evidence is not available to you.',
});

/** Passport evidence tier → the canonical Passport provenance vocabulary. No new labels. */
const TIER_PROVENANCE = Object.freeze({
  self_reported: 'player_submitted',
  coach_confirmed: 'verified_coach_confirmed',
  club_assessed: 'verified_club_confirmed',
  independent: 'authoritative_registry',
});

const unavailable = (link, reason) => ({
  sourceType: link.sourceType,
  sourceId: link.sourceId,
  sourceLabel: EVIDENCE_SOURCE_LABELS[link.sourceType] ?? 'Evidence',
  available: false,
  reason,
  note: UNAVAILABLE_COPY[reason],
  // Nothing else. Not the title, not the date, not the organisation — an
  // "unavailable" that leaks its subject is not unavailable.
  provenance: null,
  occurredAt: null,
  simulated: false,
});

/**
 * Can this viewer see the player at all? Org viewers go through the same live
 * gate every other surface uses; a block or a visibility change removes access
 * here at the same instant it removes it everywhere else.
 */
function viewerMaySeePlayer(viewer, player, { orgCanSee }) {
  if (!player) return false;
  if (viewer.kind === 'player_self') return viewer.playerId === player.id;
  if (viewer.kind === 'guardian') return viewer.childIds?.includes(player.id) ?? false;
  if (viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff') return !!viewer.org && orgCanSee(viewer.org, player);
  return false;
}

/**
 * Resolve one link for one viewer.
 *
 * Order matters and is deliberate: viewer access first, then existence, then
 * ownership, then current validity. Checking existence before access would let
 * a caller distinguish "no such id" from "not yours", which is an enumeration
 * oracle over another club's evidence.
 */
export function resolveEvidenceLink(link, { reads = {}, player, viewer, orgCanSee, now = Date.now() }) {
  if (!EVIDENCE_SOURCES.includes(link.sourceType)) return unavailable(link, 'evidence_not_found');
  if (!viewerMaySeePlayer(viewer, player, { orgCanSee })) return unavailable(link, 'evidence_not_visible');

  switch (link.sourceType) {
    case 'passport_evidence': return resolvePassportEvidence(link, { reads, player, now });
    case 'assessment': return resolveAssessment(link, { reads, player, viewer });
    case 'box_cam_session': return resolveBoxSession(link, { reads, player });
    case 'combine_attempt': return resolveCombineAttempt(link, { reads, player });
    case 'trial_report': return resolveTrialReport(link, { reads, player, viewer });
    default: return unavailable(link, 'evidence_not_found');
  }
}

function resolvePassportEvidence(link, { reads, player, now }) {
  const e = reads.evidence?.byId(link.sourceId) ?? null;
  if (!e || e.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  if (e.supersededBy) return unavailable(link, 'evidence_superseded');
  if (e.expiresAt && e.expiresAt < now) return unavailable(link, 'evidence_expired');
  return {
    sourceType: link.sourceType, sourceId: e.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.passport_evidence,
    available: true, reason: null,
    title: e.label,
    provenance: TIER_PROVENANCE[e.verification?.status] ?? 'system_recorded',
    occurredAt: e.observedAt ?? e.recordedAt ?? null,
    simulated: false,
  };
}

/**
 * An assessment is an organisation's own record. The player sees it only where
 * the club chose to publish feedback — the same rule objectives apply when one
 * is seeded — and another organisation never sees it at all.
 */
function resolveAssessment(link, { reads, player, viewer }) {
  const a = reads.assessments?.byId(link.sourceId) ?? null;
  if (!a || a.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  const isOwningOrg = (viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff') && a.orgId === viewer.org?.id;
  const isSubject = viewer.kind === 'player_self' || viewer.kind === 'guardian';
  if (!isOwningOrg && !(isSubject && a.publishedFeedback)) return unavailable(link, 'evidence_not_visible');
  if (a.state === 'draft') return unavailable(link, 'evidence_not_found');
  return {
    sourceType: link.sourceType, sourceId: a.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.assessment,
    available: true, reason: null,
    // The organisation's name, and nothing the assessment says. Ratings,
    // recommendation and reviewer notes never cross into a development plan.
    title: a.context?.fixture ? `Assessment — ${a.context.fixture}` : 'Assessment',
    org: { id: a.orgId, name: null },
    provenance: 'verified_club_confirmed',
    occurredAt: a.submittedAt ?? a.createdAt ?? null,
    simulated: false,
  };
}

function resolveBoxSession(link, { reads, player }) {
  const s = reads.boxCam?.sessions.byId(link.sourceId) ?? null;
  if (!s || s.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  if (s.verificationState === 'invalidated') return unavailable(link, 'evidence_withdrawn');
  return {
    sourceType: link.sourceType, sourceId: s.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.box_cam_session,
    available: true, reason: null,
    title: s.drillId,
    provenance: 'box_cam_observed',
    occurredAt: s.endedAt ?? s.startedAt ?? s.createdAt ?? null,
    // Never hidden: a fixture-driven session is labelled simulated wherever it
    // appears, including here.
    simulated: !!PROVIDERS[s.provider]?.testOnly,
    // Observed training. Deliberately not a number, and deliberately not a
    // count of hours — volume is not progress.
    note: 'Observed training. ScoutBox recorded activity consistent with the selected drill; it does not measure how much the player improved.',
  };
}

function resolveCombineAttempt(link, { reads, player }) {
  const a = reads.boxCam?.attempts.byId(link.sourceId) ?? null;
  if (!a || a.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  const session = reads.boxCam.sessions.byId(a.boxSessionId);
  const state = liveCombineState(a, session);
  if (state === 'invalidated') return unavailable(link, 'evidence_withdrawn');
  const provider = PROVIDERS[a.provider];
  const productionValid = isProductionValidCombine(a, session, provider);
  const proto = combineProtocol(a.protocolId, a.protocolVersion) ?? latestCombineProtocol(a.protocolId);
  return {
    sourceType: link.sourceType, sourceId: a.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.combine_attempt,
    available: true, reason: null,
    title: proto?.title ?? a.protocolId,
    protocolId: a.protocolId, protocolVersion: a.protocolVersion,
    measuredValue: state === 'combine_verified' ? a.measuredValue : null,
    metricUnit: a.metricUnit,
    combineState: state,
    // `combine_verified` is a confirmation badge; a simulated result gets the
    // demo badge instead, whatever state it finished in.
    provenance: provider?.testOnly ? 'simulated_demo' : (state === 'combine_verified' ? 'combine_verified' : 'box_cam_observed'),
    occurredAt: a.completedAt ?? a.createdAt ?? null,
    simulated: !!provider?.testOnly,
    productionValid,
  };
}

/**
 * A trial report belongs to the organisation that ran the trial. It is visible
 * to that organisation only, and even then the hub shows that it exists — never a
 * line of what it says. A trial report is a recruitment record; copying it into
 * a development plan the player can read would leak it.
 */
function resolveTrialReport(link, { reads, player, viewer }) {
  const t = reads.trials?.byId(link.sourceId) ?? null;
  if (!t || t.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  const isOwningOrg = (viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff') && t.orgId === viewer.org?.id;
  if (!isOwningOrg) return unavailable(link, 'evidence_not_visible');
  if (t.status !== 'reported') return unavailable(link, 'evidence_not_found');
  return {
    sourceType: link.sourceType, sourceId: t.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.trial_report,
    available: true, reason: null,
    title: 'Trial report',
    provenance: 'verified_club_confirmed',
    // The one date validator; a stored day that is not a calendar day falls back
    // to acceptance rather than becoming NaN.
    occurredAt: (() => { const d = parseTrialDate(t.proposedDate); return d.ok && d.t !== null ? d.t : (Number.isFinite(t.acceptedAt) ? t.acceptedAt : null); })(),
    simulated: false,
  };
}

/**
 * Validate a link a caller wants to create.
 *
 * The linker's own access decides whether the record exists for them, so this
 * takes the same viewer the resolver does. Ownership is checked here too: a
 * link to another player's record is refused at write time AND would resolve
 * to unavailable at read time, because one guard is never enough for the rule
 * that keeps players' records apart.
 */
export function validateEvidenceLink({ sourceType, sourceId, reads = {}, player, viewer, orgCanSee, now = Date.now() }) {
  if (!EVIDENCE_SOURCES.includes(String(sourceType))) {
    return { error: 'EVIDENCE_SOURCE_UNKNOWN', allowed: EVIDENCE_SOURCES, detail: `Unknown evidence source "${sourceType}".` };
  }
  if (!sourceId || typeof sourceId !== 'string') {
    return { error: 'EVIDENCE_ID_REQUIRED', detail: 'An evidence link needs the id of an existing record.' };
  }

  // Does the record exist AND belong to this player? Both questions get the
  // same answer, so a caller cannot use the difference to discover that an id
  // exists on somebody else.
  const owned = recordBelongsToPlayer({ reads, sourceType, sourceId, playerId: player.id });
  if (!owned) {
    return { error: 'EVIDENCE_NOT_FOUND', detail: 'That evidence does not exist for this player.' };
  }

  const probe = resolveEvidenceLink({ sourceType, sourceId }, { reads, player, viewer, orgCanSee, now });
  if (!probe.available && probe.reason === 'evidence_not_visible') {
    return { error: 'EVIDENCE_NOT_FOUND', detail: 'That evidence does not exist for this player.' };
  }
  // Linking already-invalid evidence is refused at creation: the link would be
  // born unavailable, which is a confusing thing to store deliberately. An item
  // that becomes invalid LATER keeps its link, which is the honest case.
  if (!probe.available) {
    return { error: 'EVIDENCE_NOT_LINKABLE', reason: probe.reason, detail: probe.note };
  }
  return { value: { sourceType: String(sourceType), sourceId: String(sourceId) } };
}

/** Ownership, per store. One place, so no source can be added without answering it. */
export function recordBelongsToPlayer({ reads = {}, sourceType, sourceId, playerId }) {
  const find = (list) => (list ?? []).find((x) => x.id === sourceId && x.playerId === playerId) ?? null;
  switch (sourceType) {
    case 'passport_evidence': { const e = reads.evidence?.byId(sourceId) ?? null; return e && e.playerId === playerId ? e : null; }
    case 'assessment': { const a = reads.assessments?.byId(sourceId) ?? null; return a && a.playerId === playerId ? a : null; }
    case 'box_cam_session': { const s = reads.boxCam?.sessions.byId(sourceId) ?? null; return s && s.playerId === playerId ? s : null; }
    case 'combine_attempt': { const a = reads.boxCam?.attempts.byId(sourceId) ?? null; return a && a.playerId === playerId ? a : null; }
    case 'trial_report': { const t = reads.trials?.byId(sourceId) ?? null; return t && t.playerId === playerId ? t : null; }
    default: return null;
  }
}

/** Counts for a plan summary. Available vs unavailable, never a confidence figure. */
export function summariseEvidence(resolved) {
  const total = resolved.length;
  const available = resolved.filter((r) => r.available).length;
  return {
    total,
    available,
    unavailable: total - available,
    simulated: resolved.filter((r) => r.simulated).length,
    // No score, no weighting, no "evidence strength". A count of linked items
    // is a count of linked items.
    note: total === 0 ? 'No evidence linked yet.' : `${available} of ${total} linked items are currently available.`,
  };
}

export { UNAVAILABLE_REASONS };
