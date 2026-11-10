/**
 * Evidence links store a reference, never content, and are resolved from the
 * source record at read time: a copy would keep asserting evidence that has
 * since been superseded, expired or invalidated. A link whose source becomes
 * unavailable survives, so history still shows what was cited. A link may only
 * point at a record of the plan's own player.
 */
import {
  liveCombineState,
  isProductionValidCombine,
  combineProtocol,
  latestCombineProtocol,
} from '../boxcam/combineShared.mjs';
import { PROVIDERS } from '../boxcam/drills.mjs';
import { EVIDENCE_SOURCES, EVIDENCE_SOURCE_LABELS, UNAVAILABLE_REASONS } from './shared.mjs';
import { parseTrialDate } from '../../../domain.mjs';

/** Tests assert a stored link has exactly these keys, so no content creeps in. */
export const EVIDENCE_LINK_FIELDS = Object.freeze([
  'id',
  'planId',
  'goalId',
  'actionId',
  'playerId',
  'sourceType',
  'sourceId',
  'linkedByKind',
  'linkedById',
  'linkedByName',
  'linkedAt',
]);

export const UNAVAILABLE_COPY = Object.freeze({
  evidence_not_found: 'This evidence is no longer available.',
  evidence_superseded: 'This evidence was replaced by a corrected record.',
  evidence_expired: 'This evidence has passed its validity period.',
  evidence_withdrawn: 'This evidence was invalidated after review.',
  evidence_not_visible: 'This evidence is not available to you.',
});

/** Passport evidence tier → Passport provenance vocabulary. */
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
  // No title, date or organisation: an unavailable item must not leak its subject.
  provenance: null,
  occurredAt: null,
  simulated: false,
});

function viewerMaySeePlayer(viewer, player, { orgCanSee }) {
  if (!player) return false;
  if (viewer.kind === 'player_self') return viewer.playerId === player.id;
  if (viewer.kind === 'guardian') return viewer.childIds?.includes(player.id) ?? false;
  if (viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff')
    return !!viewer.org && orgCanSee(viewer.org, player);
  return false;
}

/**
 * Access is checked before existence, so a caller cannot tell "no such id"
 * from "not yours".
 */
export function resolveEvidenceLink(link, { reads = {}, player, viewer, orgCanSee, now = Date.now() }) {
  if (!EVIDENCE_SOURCES.includes(link.sourceType)) return unavailable(link, 'evidence_not_found');
  if (!viewerMaySeePlayer(viewer, player, { orgCanSee })) return unavailable(link, 'evidence_not_visible');

  switch (link.sourceType) {
    case 'passport_evidence':
      return resolvePassportEvidence(link, { reads, player, now });
    case 'assessment':
      return resolveAssessment(link, { reads, player, viewer });
    case 'box_cam_session':
      return resolveBoxSession(link, { reads, player });
    case 'combine_attempt':
      return resolveCombineAttempt(link, { reads, player });
    case 'trial_report':
      return resolveTrialReport(link, { reads, player, viewer });
    default:
      return unavailable(link, 'evidence_not_found');
  }
}

function resolvePassportEvidence(link, { reads, player, now }) {
  const e = reads.evidence?.byId(link.sourceId) ?? null;
  if (!e || e.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  if (e.supersededBy) return unavailable(link, 'evidence_superseded');
  if (e.expiresAt && e.expiresAt < now) return unavailable(link, 'evidence_expired');
  return {
    sourceType: link.sourceType,
    sourceId: e.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.passport_evidence,
    available: true,
    reason: null,
    title: e.label,
    provenance: TIER_PROVENANCE[e.verification?.status] ?? 'system_recorded',
    occurredAt: e.observedAt ?? e.recordedAt ?? null,
    simulated: false,
  };
}

/** The player sees an assessment only if the club published feedback; other clubs never do. */
function resolveAssessment(link, { reads, player, viewer }) {
  const a = reads.assessments?.byId(link.sourceId) ?? null;
  if (!a || a.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  const isOwningOrg = (viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff') && a.orgId === viewer.org?.id;
  const isSubject = viewer.kind === 'player_self' || viewer.kind === 'guardian';
  if (!isOwningOrg && !(isSubject && a.publishedFeedback)) return unavailable(link, 'evidence_not_visible');
  if (a.state === 'draft') return unavailable(link, 'evidence_not_found');
  return {
    sourceType: link.sourceType,
    sourceId: a.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.assessment,
    available: true,
    reason: null,
    // Ratings, recommendation and reviewer notes stay out of development plans.
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
    sourceType: link.sourceType,
    sourceId: s.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.box_cam_session,
    available: true,
    reason: null,
    title: s.drillId,
    provenance: 'box_cam_observed',
    occurredAt: s.endedAt ?? s.startedAt ?? s.createdAt ?? null,
    simulated: !!PROVIDERS[s.provider]?.testOnly,
    // No number or hours: volume is not progress.
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
    sourceType: link.sourceType,
    sourceId: a.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.combine_attempt,
    available: true,
    reason: null,
    title: proto?.title ?? a.protocolId,
    protocolId: a.protocolId,
    protocolVersion: a.protocolVersion,
    measuredValue: state === 'combine_verified' ? a.measuredValue : null,
    metricUnit: a.metricUnit,
    combineState: state,
    // A simulated result gets the demo badge whatever state it finished in.
    provenance: provider?.testOnly
      ? 'simulated_demo'
      : state === 'combine_verified'
        ? 'combine_verified'
        : 'box_cam_observed',
    occurredAt: a.completedAt ?? a.createdAt ?? null,
    simulated: !!provider?.testOnly,
    productionValid,
  };
}

/**
 * A trial report is a recruitment record: only the trial's organisation sees
 * the link, and never its content, since the player may read the plan.
 */
function resolveTrialReport(link, { reads, player, viewer }) {
  const t = reads.trials?.byId(link.sourceId) ?? null;
  if (!t || t.playerId !== player.id) return unavailable(link, 'evidence_not_found');
  const isOwningOrg = (viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff') && t.orgId === viewer.org?.id;
  if (!isOwningOrg) return unavailable(link, 'evidence_not_visible');
  if (t.status !== 'reported') return unavailable(link, 'evidence_not_found');
  return {
    sourceType: link.sourceType,
    sourceId: t.id,
    sourceLabel: EVIDENCE_SOURCE_LABELS.trial_report,
    available: true,
    reason: null,
    title: 'Trial report',
    provenance: 'verified_club_confirmed',
    // A stored day that is not a calendar day falls back to acceptance rather than NaN.
    occurredAt: (() => {
      const d = parseTrialDate(t.proposedDate);
      return d.ok && d.t !== null ? d.t : Number.isFinite(t.acceptedAt) ? t.acceptedAt : null;
    })(),
    simulated: false,
  };
}

/** Ownership is checked at write time as well as at read time. */
export function validateEvidenceLink({
  sourceType,
  sourceId,
  reads = {},
  player,
  viewer,
  orgCanSee,
  now = Date.now(),
}) {
  if (!EVIDENCE_SOURCES.includes(String(sourceType))) {
    return {
      error: 'EVIDENCE_SOURCE_UNKNOWN',
      allowed: EVIDENCE_SOURCES,
      detail: `Unknown evidence source "${sourceType}".`,
    };
  }
  if (!sourceId || typeof sourceId !== 'string') {
    return { error: 'EVIDENCE_ID_REQUIRED', detail: 'An evidence link needs the id of an existing record.' };
  }

  // Missing and not-this-player's get the same answer, so ids cannot be probed.
  const owned = recordBelongsToPlayer({ reads, sourceType, sourceId, playerId: player.id });
  if (!owned) {
    return { error: 'EVIDENCE_NOT_FOUND', detail: 'That evidence does not exist for this player.' };
  }

  const probe = resolveEvidenceLink({ sourceType, sourceId }, { reads, player, viewer, orgCanSee, now });
  if (!probe.available && probe.reason === 'evidence_not_visible') {
    return { error: 'EVIDENCE_NOT_FOUND', detail: 'That evidence does not exist for this player.' };
  }
  // Already-invalid evidence cannot be linked; evidence that becomes invalid later keeps its link.
  if (!probe.available) {
    return { error: 'EVIDENCE_NOT_LINKABLE', reason: probe.reason, detail: probe.note };
  }
  return { value: { sourceType: String(sourceType), sourceId: String(sourceId) } };
}

export function recordBelongsToPlayer({ reads = {}, sourceType, sourceId, playerId }) {
  const find = (list) => (list ?? []).find((x) => x.id === sourceId && x.playerId === playerId) ?? null;
  switch (sourceType) {
    case 'passport_evidence': {
      const e = reads.evidence?.byId(sourceId) ?? null;
      return e && e.playerId === playerId ? e : null;
    }
    case 'assessment': {
      const a = reads.assessments?.byId(sourceId) ?? null;
      return a && a.playerId === playerId ? a : null;
    }
    case 'box_cam_session': {
      const s = reads.boxCam?.sessions.byId(sourceId) ?? null;
      return s && s.playerId === playerId ? s : null;
    }
    case 'combine_attempt': {
      const a = reads.boxCam?.attempts.byId(sourceId) ?? null;
      return a && a.playerId === playerId ? a : null;
    }
    case 'trial_report': {
      const t = reads.trials?.byId(sourceId) ?? null;
      return t && t.playerId === playerId ? t : null;
    }
    default:
      return null;
  }
}

/** Counts only, never a confidence or strength figure. */
export function summariseEvidence(resolved) {
  const total = resolved.length;
  const available = resolved.filter((r) => r.available).length;
  return {
    total,
    available,
    unavailable: total - available,
    simulated: resolved.filter((r) => r.simulated).length,
    note: total === 0 ? 'No evidence linked yet.' : `${available} of ${total} linked items are currently available.`,
  };
}

export { UNAVAILABLE_REASONS };
