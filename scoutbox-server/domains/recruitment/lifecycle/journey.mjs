/**
 * The recruitment journey projection: one case's records (through
 * `opts.reads`, owned by other repositories) arranged for one viewer, computed
 * on read. A required read that is absent is broken composition, not an empty
 * history, and the projector refuses. There is no score, probability or
 * progress percentage: how far a case has travelled is a fact about a club's
 * process, not a measurement of a person.
 */

import {
  LIFECYCLE_TERMINAL, LIFECYCLE_REOPENABLE, RECRUITMENT_LIFECYCLE_POLICY_VERSION,
  availableActions, derivedConditions, NULL_EVIDENCE_PROVIDER,
} from './lifecycle.mjs';
import { ROOM_STATUS_LABELS, ROOM_TRANSITIONS } from '../rooms/shared.mjs';
import { contactMilestone, contactIntegrity } from './contact.mjs';
import { trialMilestone, trialIntegrity } from './trial.mjs';
// The Offer domain's derivation (lazy expiry), so an expired revision never reads as its stored status.
import { offerStatus as canonicalOfferStatus, liveStatus as canonicalLiveStatus, offerIntegrity, offerCaseConsistency, offerCaseCorrupt } from '../offers/offer.mjs';
import { effectiveStatus as signingEffectiveStatus, currentRevision as signingCurrentRevision, signingIntegrity, signingConsistency, signingCorrupt, isLive as signingIsLive, findParty } from '../signings/signing.mjs';
import {
  JOURNEY_POLICY_VERSION, canonicalStageFor, completedStagesFor, nextActionFor, validateRecruitmentJourney,
  currentContactForCase, currentTrialForCase, currentAssessmentForCase, currentDecisionForCase, currentOfferForCase, currentSigningForCase,
  playerNextActionFor, playerStageFor, timelineVisibleTo, offerTimelineEntry, signingTimelineEntry,
} from './journeyModel.mjs';

/**
 * Empty: every input is an `opts.reads` entry, and the projector checks the
 * required ones. Kept as exports for their importers.
 */
export const JOURNEY_REQUIRED_STORES = Object.freeze([
]);

export const JOURNEY_OPTIONAL_STORES = Object.freeze([]);

export const JOURNEY_VIEWERS = Object.freeze([
  'org_staff', 'grassroots_staff', 'player_self', 'guardian', 'trust_safety',
  // The route proves the basis and passes `authorized: true`.
  'agent',
]);

const HISTORY_PAGE_DEFAULT = 50;
const HISTORY_PAGE_MAX = 200;

/** Same-millisecond entries (which the reopen path writes) must still sort the same on every read. */
const byTimeThenKey = (a, b) => {
  const ta = Date.parse(a.at ?? 0) || Number(a.at) || 0;
  const tb = Date.parse(b.at ?? 0) || Number(b.at) || 0;
  if (ta !== tb) return ta - tb;
  return String(a._k ?? '').localeCompare(String(b._k ?? ''));
};

/** History actions that are lifecycle-meaningful. */
const TIMELINE_ACTIONS = new Set([
  'room_created', 'room_status_changed', 'room_reopened',
  'case_created', 'case_stage_changed',
  'room_decision_recorded',
]);

/** Trial history actions that are milestones. Unlinking is housekeeping. */
const TRIAL_TIMELINE_ACTIONS = new Set([
  'trial_accepted', 'trial_schedule_proposed', 'trial_rescheduled', 'trial_schedule_confirmed', 'trial_schedule_declined',
  'trial_attendance_recorded', 'trial_cancelled', 'trial_completed', 'trial_evidence_linked',
]);

/**
 * The club projection takes no visibility callback: it carries the club's own
 * record of its process and no player identity (name, birth date, contact
 * detail). Surfaces that do carry identity re-run `orgCanSee` on every read.
 *
 * A row naming a case belongs to that case. A row naming none (a legacy
 * request or Trial, an assessment outside a Trial) belongs to the case of this
 * club and player open when it was written: an ended case keeps its own, a
 * later case inherits nothing, and a row older than every case belongs to the
 * case being read.
 */
function caseEndedAt(k) {
  if (!LIFECYCLE_TERMINAL.includes(k?.room?.status)) return Infinity;
  const ends = (k.history ?? []).filter((e) => e?.action === 'room_status_changed' && LIFECYCLE_TERMINAL.includes(e.detail?.to)).map((e) => Number(e.at) || 0);
  return ends.length ? Math.max(...ends) : (Number(k.room?.updatedAt) || 0);
}
function ownedByAnotherCase(rec, kase, { caseId = null, at = null }) {
  if (typeof caseId === 'string' && caseId) return caseId !== kase.id;
  const ts = Number(at);
  if (!Number.isFinite(ts)) return false;
  return rec.siblingCases.some((k) => k && k.id !== kase.id && k.orgId === kase.orgId && k.playerId === kase.playerId && k.room && Number(k.room.createdAt) <= ts && ts <= caseEndedAt(k));
}
const trialCaseOf = (rec, trialId) => (typeof trialId === 'string' ? rec.trialById(trialId)?.caseId ?? null : null);
const contactCaseOf = (rec, contactId) => (typeof contactId === 'string' ? rec.contactById(contactId)?.caseId ?? null : null);

export function buildRecruitmentJourney(caseId, viewer, opts = {}) {
  const {
    now = Date.now(),
    evidence = NULL_EVIDENCE_PROVIDER,
    historyLimit = HISTORY_PAGE_DEFAULT,
    historyCursor = 0,
    reads = {},
  } = opts;
  const playerOf = typeof reads.player === 'function' ? reads.player : () => null;

  // A missing query object is broken composition, never an empty history.
  // `malformed` is always empty; it stays in the response shape.
  const missing = [];
  if (typeof reads.cases?.byId !== 'function' || typeof reads.cases?.forOrgPlayer !== 'function') missing.push('recruitmentCases');
  if (typeof reads.decisions?.forRoom !== 'function') missing.push('roomDecisions');
  if (typeof reads.contacts?.forCase !== 'function' || typeof reads.contacts?.byId !== 'function') missing.push('recruitmentContacts');
  if (typeof reads.signings?.forOrgPlayer !== 'function' || typeof reads.signings?.byId !== 'function') missing.push('signings');
  if (typeof reads.requests?.forOrgPlayer !== 'function' || typeof reads.requests?.forCase !== 'function') missing.push('requests');
  if (typeof reads.trials?.forOrgPlayer !== 'function' || typeof reads.trials?.forCase !== 'function' || typeof reads.trials?.byId !== 'function') missing.push('trials');
  if (typeof reads.assessments?.forOrgPlayer !== 'function') missing.push('assessments');
  if (missing.length) {
    return {
      ok: false,
      error: 'JOURNEY_STORE_MISSING',
      message: 'The recruitment journey cannot be built: a required collection is absent or is not a list.',
      missing,
      malformed: [],
    };
  }

  if (!JOURNEY_VIEWERS.includes(viewer?.kind)) {
    return { ok: false, error: 'JOURNEY_VIEWER_UNKNOWN', message: 'Unknown viewer context.' };
  }

  const kase = reads.cases.byId(caseId);

  // A foreign organisation's case is indistinguishable from one that does not exist.
  const orgScoped = viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff';
  if (!kase || (orgScoped && kase.orgId !== viewer.orgId)) {
    return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
  }
  if (!kase.room) {
    return { ok: false, error: 'CASE_NOT_A_ROOM', message: 'This recruitment case has no workspace.' };
  }

  // This case's records, read once. `offers` and `packages` are null when not
  // composed; signings are the club's, since a legacy row names no package.
  const rec = {
    contacts: reads.contacts.forCase(kase.id),
    // Sibling cases: an earlier, ended case owns its own records.
    siblingCases: reads.cases.forOrgPlayer(kase.orgId, kase.playerId),
    decisions: reads.decisions.forRoom(kase.id),
    assessments: reads.assessments.forOrgPlayer(kase.orgId, kase.playerId),
    offers: typeof reads.offers?.forCase === 'function' ? reads.offers.forCase(kase.id) : null,
    packages: typeof reads.signingPackages?.forCase === 'function' ? reads.signingPackages.forCase(kase.id) : null,
    signings: reads.signings.forOrgPlayer(kase.orgId, kase.playerId),
    outcomesAvailable: typeof reads.outcomeReports?.forPlayer === 'function',
    requests: reads.requests.forOrgPlayer(kase.orgId, kase.playerId),
    trials: reads.trials.forOrgPlayer(kase.orgId, kase.playerId),
    caseRequests: reads.requests.forCase(kase.id),
    caseTrials: reads.trials.forCase(kase.id),
    trialById: (id) => reads.trials.byId(id),
    contactById: (id) => reads.contacts.byId(id),
    /** The row must name the package back. */
    completedRowOf: (pkg) => { const row = reads.signings.byId(pkg.completion.signingId); return row && row.signingPackageId === pkg.id ? row : null; },
    signingForPackage: (packageId) => (typeof reads.signings.forPackage === 'function' ? reads.signings.forPackage(packageId) : null),
  };

  // ---- Hidden club interest: a player cannot learn that a club has a case on
  // them by asking. With no record shared with them, they get the answer for a
  // case that was never opened.
  if (viewer.kind === 'player_self' || viewer.kind === 'guardian') {
    const shared = sharedRecordsFor(rec, kase, viewer, now);
    if (shared.length === 0) {
      return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
    }
    return {
      ok: true,
      viewer: viewer.kind,
      // Not the case id: the player sees what was shared, not the club's workspace.
      shared,
      // No case id, lifecycle state, priority, decision or note.
      journey: playerJourneyFor(rec, kase, viewer, shared, now),
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
      generatedAt: now,
    };
  }

  // ---- Trust & Safety is not a master key.
  if (viewer.kind === 'trust_safety' && viewer.authorized !== true) {
    return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
  }

  // ---- Nor is an agent; the route establishes the basis.
  if (viewer.kind === 'agent') {
    if (viewer.authorized !== true || viewer.playerId !== kase.playerId) {
      return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
    }
    return agentJourneyFor(rec, kase, viewer, now);
  }

  // An unreadable history must not be reported as empty, which would assert
  // nothing ever happened. This sits below the concealment branches, so
  // corruption reporting cannot confirm to a player that the case exists.
  if (kase.history !== undefined && !Array.isArray(kase.history)) {
    return {
      ok: false,
      error: 'CASE_HISTORY_CORRUPT',
      message: 'This recruitment case has a history that cannot be read. It is not reported as empty.',
    };
  }

  // ---- Club projection.
  const status = kase.room.status;
  const role = viewer.role ?? null;

  const decisions = rec.decisions
    .filter((d) => d?.roomId === kase.id && d.orgId === kase.orgId)
    .map((d) => ({
      id: d.id,
      recommendation: d.recommendation,
      reasonCodes: d.reasonCodes ?? [],
      at: d.createdAt,
      by: d.by?.name ?? null,
      supersededById: d.supersededById ?? null,
      // The note is org-private free text and is never projected.
      hasNote: !!d.note,
      // Legacy rows read as advisory recommendations.
      kind: d.kind === 'formal' ? 'formal' : 'recommendation',
      outcome: d.kind === 'formal' ? d.outcome ?? null : null,
      evidenceCount: d.kind === 'formal' ? (Array.isArray(d.evidenceRefs) ? d.evidenceRefs.length : 0) : 0,
    }));
  const currentDecision = decisions.filter((d) => !d.supersededById).slice(-1)[0] ?? null;
  const currentFormal = currentDecision && currentDecision.kind === 'formal' ? currentDecision : null;
  // The case's single draft, for the club only: never its rationale.
  const decisionDraft = kase.decisionDraft && typeof kase.decisionDraft === 'object'
    ? { id: kase.decisionDraft.id ?? null, outcome: kase.decisionDraft.outcome ?? null, by: kase.decisionDraft.by?.name ?? null, updatedAt: kase.decisionDraft.updatedAt ?? null }
    : null;

  // Milestones only: never instructions, an address, a note, an observation
  // or an assessment. A corrupt row is omitted and counted.
  let trialsOmitted = 0;
  const trials = [];
  for (const t of rec.trials) {
    if (!t || t.orgId !== kase.orgId || t.playerId !== kase.playerId) continue;
    if (trialIntegrity(t, { orgId: kase.orgId, caseId: t.caseId ?? null }).length) { trialsOmitted += 1; continue; }
    trials.push({ id: t.id, status: t.status, proposedDate: t.proposedDate ?? null, hasReport: !!t.report, workflow: trialMilestone(t) });
  }
  // The model and timeline read this case's Trials only, the evidence
  // provider's scope: a Trial from an earlier, ended case is that case's
  // history. `trials` above stays the club's view of the player.
  const trialRows = rec.trials.filter((t) => t?.orgId === kase.orgId && t.playerId === kase.playerId && t.caseId === kase.id && trials.some((x) => x.id === t.id));
  const trialInvitations = rec.caseRequests.filter((r) => r?.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId);
  const trialAssessments = rec.assessments.filter((a) => a.context?.trialId && trialRows.some((x) => x.id === a.context.trialId));

  const contacts = rec.requests
    .filter((r) => r?.orgId === kase.orgId && r.playerId === kase.playerId)
    .map((r) => ({ id: r.id, type: r.type, status: r.status, routedTo: r.routedTo ?? null, createdAt: r.createdAt }));

  // Milestones only: never a body, a summary or a reply. A corrupt record is omitted and counted.
  let contactsOmitted = 0;
  const contactRecords = [];
  for (const c of rec.contacts) {
    if (!c || c.caseId !== kase.id || c.orgId !== kase.orgId) continue;
    if (contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length) { contactsOmitted += 1; continue; }
    contactRecords.push(contactMilestone(c));
  }
  contactRecords.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const assessments = rec.assessments
    .map((a) => ({ id: a.id, state: a.state, at: a.submittedAt ?? a.createdAt }));

  // Optional reads degrade to an empty list plus an availability flag. Offer
  // status is derived (an ISSUED revision past its expiry reads EXPIRED);
  // terms, notes and documents never appear.
  const offersAvailable = rec.offers !== null;
  const offers = offersAvailable
    ? rec.offers
      .filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0 && !offerCaseCorrupt(offerCaseConsistency(o, kase, now)))
      .map((o) => ({ id: o.id, type: o.type, status: canonicalOfferStatus(o, now), liveStatus: canonicalLiveStatus(o, now) }))
    : [];

  // A row that names another case's package proves nothing here.
  const packageRows = rec.packages !== null ? rec.packages.filter((p) => p?.caseId === kase.id && p.orgId === kase.orgId && p.playerId === kase.playerId) : [];
  const signing = supportingSigningRow(rec, kase, packageRows) ?? null;
  const outcomeAvailable = rec.outcomesAvailable;

  const offerRows = offersAvailable ? rec.offers.filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0) : [];
  const soundPackages = packageRows.filter((p) => signingIntegrity(p, { orgId: kase.orgId }).length === 0);
  // Records naming this case that failed integrity: omitted above, a problem below.
  const offersCorrupt = offersAvailable ? rec.offers.filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length > 0).length : 0;
  const packagesCorrupt = packageRows.length - soundPackages.length;
  const trialsCorrupt = rec.caseTrials.filter((t) => t?.caseId === kase.id && t.orgId === kase.orgId && trialIntegrity(t, { orgId: kase.orgId, caseId: kase.id }).length > 0).length;
  const corruptRecords = offersCorrupt + packagesCorrupt + trialsCorrupt + contactsOmitted;
  // Never the ended case's assessments.
  const allAssessments = rec.assessments.filter((a) => !ownedByAnotherCase(rec, kase, { caseId: trialCaseOf(rec, a.context?.trialId), at: a.createdAt }));
  const journeyBlock = journeyFor(rec, kase, {
    playerOf,
    status, role, now,
    blocked: !!reads.blocks?.has(kase.playerId, kase.orgId),
    contacts: rec.contacts.filter((c) => c && c.caseId === kase.id && c.orgId === kase.orgId && contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length === 0),
    trials: trialRows, trialRequests: trialInvitations, assessments: allAssessments,
    decisions: rec.decisions.filter((d) => d?.roomId === kase.id && d.orgId === kase.orgId),
    offers: offerRows, packages: soundPackages, signingRow: signing,
    corruptRecords,
    foreign: foreignReferences(rec, kase),
    domainProblems: [
      ...offerRows.flatMap((o) => offerCaseConsistency(o, kase, now).filter((c) => offerCaseCorrupt([c]))),
      ...soundPackages.flatMap((p) => signingConsistency(p, { offer: offerRows.find((o) => o.id === p.offerId) ?? null, kase, rows: [rec.signingForPackage(p.id)].filter(Boolean), player: playerOf(kase.playerId) }, now).filter((c) => signingCorrupt([c]))),
    ],
  });

  const history = timelineFor(kase, decisions, contactRecords, { trials: trialRows, invitations: trialInvitations, assessments: trialAssessments, offers: offerRows, packages: soundPackages, now });
  const limit = Math.min(Math.max(Number(historyLimit) || HISTORY_PAGE_DEFAULT, 1), HISTORY_PAGE_MAX);
  const cursor = Math.max(Number(historyCursor) || 0, 0);
  const page = history.slice(cursor, cursor + limit);

  const conditions = derivedConditions({
    status,
    hasCurrentDecision: !!currentDecision,
    activeTrial: trials.some((t) => t.status === 'awaiting_report'),
    offerAwaitingResponse: offers.some((o) => o.liveStatus === 'ISSUED'),
  });
  // A workflow-coverage fact, not a judgement.
  conditions.decisionOutstanding = !LIFECYCLE_TERMINAL.includes(status)
    && !currentFormal
    && (assessments.some((a) => a.state !== 'draft') || trials.some((t) => t.workflow?.workflowState === 'completed'));
  conditions.hasFormalDecision = !!currentFormal;

  // Permission-aware: an act this person cannot perform is a dead end with a 403.
  const actions = availableActions(kase, { role, evidence, now });

  return {
    ok: true,
    viewer: viewer.kind,
    case: {
      id: kase.id,
      orgId: kase.orgId,
      playerId: kase.playerId,
      priority: kase.room.priority ?? null,
      leadScoutUserId: kase.room.leadScoutUserId ?? null,
      createdAt: kase.createdAt,
      rev: kase.room.rev ?? 1,
    },
    lifecycle: {
      currentStage: status,
      label: ROOM_STATUS_LABELS[status] ?? status,
      stage: kase.stage ?? null,          // derived from status, for reference only
      terminal: LIFECYCLE_TERMINAL.includes(status),
      reopenable: LIFECYCLE_REOPENABLE.includes(status),
      allowedNext: ROOM_TRANSITIONS[status] ?? [],
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
    },
    conditions,
    nextActions: actions,
    // Clients read these; they never compute them.
    journey: journeyBlock,
    contact: { records: contacts, contacts: contactRecords, omitted: contactsOmitted },
    trials,
    trialsOmitted,
    assessments,
    decisions: { all: decisions, current: currentDecision, formal: currentFormal, draft: decisionDraft },
    offer: { available: offersAvailable, records: offers },
    outcome: {
      available: outcomeAvailable,
      // Never inferred from the lifecycle reaching `offer_accepted`.
      signing: signing ? { id: signing.id, at: signing.ts, method: signing.method ?? 'LEGACY_RECORDED', signingPackageId: signing.signingPackageId ?? null } : null,
      // A case at `signed` with no package has none, and none is invented.
      signingPackages: rec.packages !== null
        ? rec.packages
          .filter((p) => p?.caseId === kase.id && p.orgId === kase.orgId && p.playerId === kase.playerId && signingIntegrity(p, { orgId: kase.orgId }).length === 0)
          .map((p) => ({ id: p.id, status: signingEffectiveStatus(p, now), revisionNumber: signingCurrentRevision(p)?.revisionNumber ?? null, offerId: p.offerId, signingId: p.completion?.signingId ?? null }))
        : [],
    },
    history: { entries: page, total: history.length, cursor, nextCursor: cursor + page.length < history.length ? cursor + page.length : null },
    generatedAt: now,
  };
}

/** Records that crossed a share boundary to a player or guardian: no case id, stage, room, decision or internal count. */
function sharedRecordsFor(rec, kase, viewer, now = Date.now()) {
  const mine = (r) => {
    if (r?.orgId !== kase.orgId || r.playerId !== kase.playerId) return false;
    if (ownedByAnotherCase(rec, kase, { caseId: r.caseId ?? contactCaseOf(rec, r.contactId), at: r.createdAt })) return false; // the ended case's request is its own
    if (viewer.kind === 'player_self') return r.routedTo !== 'guardian' && viewer.playerId === kase.playerId;
    return r.routedTo === 'guardian' && r.guardianId === viewer.guardianId;
  };
  const requests = rec.requests.filter(mine).map((r) => ({
    kind: 'contact_request',
    id: r.id,
    type: r.type,
    status: r.status,
    at: r.createdAt,
  }));
  // Only the recipient who accepted sees the Trial here; a minor's own device
  // sees the outcome line, never the guardian's record.
  const mineTrial = (t) => {
    if (t?.orgId !== kase.orgId || t.playerId !== kase.playerId || t.subjectRemovedAt) return false;
    if (ownedByAnotherCase(rec, kase, { caseId: t.caseId ?? null, at: t.acceptedAt ?? t.createdAt })) return false;
    if (viewer.kind === 'player_self') return viewer.playerId === kase.playerId && (t.recipient ? t.recipient.type === 'player' : t.acceptedBy === 'player');
    return t.recipient ? t.recipient.type === 'guardian' && t.recipient.guardianId === viewer.guardianId : t.acceptedBy === 'guardian';
  };
  const trials = rec.trials.filter(mineTrial).map((t) => {
    const m = trialMilestone(t);
    return { kind: 'trial', id: t.id, workflowState: m.workflowState, at: t.acceptedAt, scheduledAt: m.scheduledAt, revision: m.revision, sessionCount: m.sessions.length, completion: m.completion };
  });
  // No terms, digest or note.
  const offers = offersSharedWith(rec, kase, viewer, now).map(({ offer, revision, liveStatus }) => ({ kind: 'offer', id: offer.id, revisionId: revision?.id ?? null, revisionNumber: revision?.revisionNumber ?? null, status: liveStatus, at: revision?.issuedAt ?? offer.createdAt ?? null, respondedAt: revision?.respondedAt ?? null }));
  const signings = packagesSharedWith(rec, kase, viewer, now).map((p) => ({ kind: 'signing', id: p.id, status: signingEffectiveStatus(p, now), revisionNumber: signingCurrentRevision(p)?.revisionNumber ?? null, at: signingCurrentRevision(p)?.readyAt ?? p.createdAt ?? null, completedAt: p.completion?.completedAt ?? null }));
  return [...requests, ...trials, ...offers, ...signings];
}

/** Offers whose live revision's recipient snapshot names this recipient. */
function offersSharedWith(rec, kase, viewer, now) {
  if (rec.offers === null) return [];
  const out = [];
  for (const o of rec.offers) {
    if (!o || o.caseId !== kase.id || o.orgId !== kase.orgId || o.playerId !== kase.playerId) continue;
    if (offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length) continue;
    const cur = currentOfferForCase([o], now);
    const rev = cur?.revision; const snap = rev?.recipientSnapshot;
    if (!rev?.issuedAt || !snap) continue;
    const mine = viewer.kind === 'player_self' ? (snap.type === 'player' && snap.playerId === viewer.playerId) : (snap.type === 'guardian' && snap.guardianId === viewer.guardianId);
    if (mine) out.push(cur);
  }
  return out;
}

/** Packages presented (READY or later) with a required party for this recipient. */
function packagesSharedWith(rec, kase, viewer, now) {
  if (rec.packages === null) return [];
  return rec.packages.filter((p) => {
    if (!p || p.caseId !== kase.id || p.orgId !== kase.orgId || p.playerId !== kase.playerId) return false;
    if (signingIntegrity(p, { orgId: kase.orgId }).length) return false;
    const rev = signingCurrentRevision(p);
    if (!rev?.readyAt) return false; // a DRAFT never reached anyone
    return viewer.kind === 'player_self'
      ? !!findParty(rev, 'PLAYER', viewer.playerId)
      : !!findParty(rev, 'GUARDIAN', viewer.guardianId);
  });
}

/** A row a COMPLETED package on this case names back, else the club's un-packaged row for this player. */
function supportingSigningRow(rec, kase, packageRows) {
  const rows = rec.signings.filter((s) => s && s.orgId === kase.orgId && s.playerId === kase.playerId && !s.cancelledAt && !s.revokedAt && !s.voidedAt);
  for (const p of packageRows) {
    if (p.status !== 'COMPLETED' || !p.completion?.signingId) continue;
    const row = rows.find((s) => s.id === p.completion.signingId && s.signingPackageId === p.id);
    if (row) return row;
  }
  return rows.find((s) => !s.signingPackageId) ?? null;
}

/** Records that name this case but another player or club: reported, never used. */
function foreignReferences(rec, kase) {
  const out = new Set();
  const check = (rows, orgKey = 'orgId') => {
    for (const r of rows ?? []) {
      if (!r || r.caseId !== kase.id) continue;
      if (r[orgKey] !== kase.orgId) out.add('CLUB_MISMATCH');
      if (r.playerId !== undefined && r.playerId !== kase.playerId) out.add('PLAYER_MISMATCH');
    }
  };
  check(rec.contacts); check(rec.caseTrials); check(rec.caseRequests); check(rec.offers); check(rec.packages);
  for (const d of rec.decisions) { if (d?.roomId === kase.id && (d.orgId !== kase.orgId || (d.playerId !== undefined && d.playerId !== kase.playerId))) out.add(d.orgId !== kase.orgId ? 'CLUB_MISMATCH' : 'PLAYER_MISMATCH'); }
  return [...out];
}

function journeyFor(rec, kase, f) {
  const contact = currentContactForCase(f.contacts);
  const trial = currentTrialForCase(f.trials);
  const trialRequest = (f.trialRequests ?? []).filter((r) => r?.status === 'pending' && !r.subjectRemovedAt).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] ?? null;
  const assessment = currentAssessmentForCase(f.assessments);
  const assessed = (f.assessments ?? []).some((a) => a && a.state !== 'draft');
  const decisionHead = currentDecisionForCase(f.decisions);
  const decision = decisionHead && decisionHead.kind === 'formal' ? decisionHead : null;
  const offer = currentOfferForCase(f.offers, f.now);
  const signing = currentSigningForCase(f.packages, f.now);
  const facts = { ...f, kase, createdAt: kase.createdAt ?? null, history: Array.isArray(kase.history) ? kase.history : [], historyMalformed: kase.history !== undefined && !Array.isArray(kase.history), signingRowIds: new Set(rec.signings.filter((s) => s && s.orgId === kase.orgId && s.playerId === kase.playerId).map((s) => s.id)) };
  const blocked = f.blocked;
  const subjectRemoved = !!kase.subjectRemovedAt || !f.playerOf(kase.playerId);
  const verdict = validateRecruitmentJourney(facts);
  const next = nextActionFor({ status: f.status, role: f.role, now: f.now, blocked, subjectRemoved, contact, trial, trialRequest, assessed, decision, offer, signing, signingRow: f.signingRow });
  // A case whose lifecycle and records disagree fails closed: the act is
  // named but not offered until the record is put right. The domain routes keep their own gates.
  if (verdict.classification === 'integrity_error' && next.kind === 'club' && !next.blockedBy.includes('INTEGRITY_ERROR')) next.blockedBy.push('INTEGRITY_ERROR');
  return {
    policyVersion: JOURNEY_POLICY_VERSION,
    stage: canonicalStageFor(f.status, { assessed, signingOpened: !!(signing && signingIsLive(signing, f.now)) }),
    completedStages: completedStagesFor(facts),
    resources: {
      contactId: contact?.id ?? null,
      trialRequestId: trialRequest?.id ?? null,
      trialId: trial?.id ?? null,
      assessmentId: assessment?.id ?? null,
      decisionId: decision?.id ?? null,
      offerId: offer?.offer.id ?? null,
      offerRevisionId: offer?.revision?.id ?? null,
      signingPackageId: signing?.id ?? null,
      completedSigningId: f.signingRow?.id ?? signing?.completion?.signingId ?? null,
    },
    nextAction: next,
    classification: verdict.classification,
    integrity: verdict.problems,
    blocked, subjectRemoved,
  };
}

/** No lifecycle word except `signed`, which is theirs. */
function playerJourneyFor(rec, kase, viewer, shared, now) {
  const audience = viewer.kind === 'guardian' ? 'guardian' : 'player';
  const requests = shared.filter((s) => s.kind === 'contact_request');
  const contactReqs = requests.filter((r) => r.type === 'contact');
  const trialReqs = requests.filter((r) => r.type === 'trial');
  const trialRows = rec.trials.filter((t) => shared.some((s) => s.kind === 'trial' && s.id === t?.id));
  const offers = offersSharedWith(rec, kase, viewer, now);
  const offer = offers.length ? currentOfferForCase(offers.map((x) => x.offer), now) : null;
  const packages = packagesSharedWith(rec, kase, viewer, now);
  const signing = packages.length ? currentSigningForCase(packages, now) : null;
  const signingRow = signing && signing.status === 'COMPLETED' && signing.completion?.signingId ? rec.completedRowOf(signing) : null;
  const stage = playerStageFor({ contacts: contactReqs, trialRequests: trialReqs, trials: trialRows, offer, signing, signingRow, now });
  const partyType = audience === 'guardian' ? 'GUARDIAN' : 'PLAYER';
  const partyId = audience === 'guardian' ? viewer.guardianId : viewer.playerId;
  const pendingParty = signing && ['READY', 'IN_PROGRESS'].includes(signingEffectiveStatus(signing, now)) && findParty(signingCurrentRevision(signing), partyType, partyId)?.status === 'PENDING' ? signing : null;
  const awaitingConfirmation = trialRows.find((t) => t.schedule && !t.schedule.confirmedAt && (t.schedule.sessions ?? []).length > 0 && !t.completion) ?? null;
  const nextAction = playerNextActionFor({
    pendingContactRequest: contactReqs.find((r) => r.status === 'pending') ?? null,
    pendingTrialRequest: trialReqs.find((r) => r.status === 'pending') ?? null,
    trialAwaitingConfirmation: awaitingConfirmation,
    issuedOffer: offer && offer.liveStatus === 'ISSUED' ? offer : null,
    signingPending: pendingParty,
  });
  // Filtered by the visibility table: never club history.
  const contactRecords = rec.contacts.filter((c) => c && c.caseId === kase.id && c.orgId === kase.orgId && ['delivered', 'responded'].includes(c.status) && contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length === 0 && (audience === 'guardian' ? c.recipient?.type === 'guardian' : c.recipient?.type === 'player')).map(contactMilestone);
  const invitations = rec.caseRequests.filter((r) => r?.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId && trialReqs.some((x) => x.id === r.id));
  const timeline = timelineFor(kase, [], contactRecords, { trials: trialRows, invitations, assessments: [], offers: offers.map((x) => x.offer), packages, now })
    .filter((e) => timelineVisibleTo(e.kind, audience))
    .map(({ by, contactId, ...rest }) => rest); // never a club member's name, never the club's Contact record id
  return {
    policyVersion: JOURNEY_POLICY_VERSION,
    stage, nextAction,
    resources: { contactRequestId: contactReqs.find((r) => r.status === 'pending')?.id ?? contactReqs[contactReqs.length - 1]?.id ?? null, trialRequestId: trialReqs.find((r) => r.status === 'pending')?.id ?? null, trialId: currentTrialForCase(trialRows)?.id ?? null, offerId: offer?.offer.id ?? null, offerRevisionId: offer?.revision?.id ?? null, signingPackageId: signing?.id ?? null },
    timeline,
  };
}

/**
 * `viewer.grants` says which record kinds the scope and the client's shares
 * permit. Ungranted kinds read as absent, not refused, so the projection does
 * not disclose what it is hiding.
 */
function agentJourneyFor(rec, kase, viewer, now) {
  const grants = new Set(viewer.grants ?? []);
  // Only records the client's own act routed or shared to this agent. Trials
  // follow the client's disclosure choice.
  const contactRecords = grants.has('contacts') ? rec.contacts.filter((c) => c && c.caseId === kase.id && c.orgId === kase.orgId && ['delivered', 'responded'].includes(c.status) && c.routingSnapshot?.agent?.agentUserId === viewer.userId && contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length === 0).map(contactMilestone) : [];
  const trialRows = grants.has('trials') ? rec.caseTrials.filter((t) => t && t.caseId === kase.id && t.orgId === kase.orgId && t.playerId === kase.playerId && !t.subjectRemovedAt && trialIntegrity(t, { orgId: kase.orgId, caseId: kase.id }).length === 0) : [];
  const invitations = grants.has('trials') ? rec.caseRequests.filter((r) => r?.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId) : [];
  const offerRows = grants.has('offers') && rec.offers !== null ? rec.offers.filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && o.agentShare?.agentUserId === viewer.userId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0 && liveRevisionOf(o)) : [];
  const sharedOfferIds = new Set(offerRows.map((o) => o.id));
  const packages = grants.has('signings') && rec.packages !== null ? rec.packages.filter((p) => p?.caseId === kase.id && p.orgId === kase.orgId && p.playerId === kase.playerId && sharedOfferIds.has(p.offerId) && signingIntegrity(p, { orgId: kase.orgId }).length === 0 && signingCurrentRevision(p)?.readyAt) : [];
  const offer = currentOfferForCase(offerRows, now);
  const signing = currentSigningForCase(packages, now);
  const signingRow = signing?.status === 'COMPLETED' && signing.completion?.signingId ? rec.completedRowOf(signing) : null;
  const stage = playerStageFor({ contacts: contactRecords, trialRequests: invitations, trials: trialRows, offer, signing, signingRow, now });
  const timeline = timelineFor(kase, [], contactRecords, { trials: trialRows, invitations, assessments: [], offers: offerRows, packages, now })
    .filter((e) => timelineVisibleTo(e.kind, 'agent'))
    .map(({ by, ...rest }) => rest);
  return {
    ok: true,
    viewer: 'agent',
    journey: {
      policyVersion: JOURNEY_POLICY_VERSION,
      stage,
      resources: { contactId: currentContactForCase(rec.contacts.filter((c) => c && c.caseId === kase.id && contactRecords.some((m) => m.id === c.id)))?.id ?? null, trialId: currentTrialForCase(trialRows)?.id ?? null, offerId: offer?.offer.id ?? null, offerRevisionId: offer?.revision?.id ?? null, signingPackageId: signing?.id ?? null },
      timeline,
      grants: [...grants],
    },
    policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
    generatedAt: now,
  };
}
const liveRevisionOf = (o) => (o?.revisions ?? []).some((r) => r && r.status !== 'DRAFT' && r.issuedAt);

/** Reads never appear: `audit()` only writes things that changed something. Note bodies never appear. */
function timelineFor(kase, decisions, contactRecords = [], trial = {}) {
  const out = [];
  // Never a note, an address, an instruction, an observation or a rating.
  for (const r of trial.invitations ?? []) {
    if (r?.createdAt != null) out.push({ _k: `trial_invited:${r.id}`, kind: 'trial_invited', at: r.createdAt, by: r.scoutName ?? null, requestId: r.id, recipientType: r.recipient?.type ?? r.routedTo ?? null });
    if (r?.status === 'declined' && r.respondedAt != null) out.push({ _k: `trial_declined:${r.id}`, kind: 'trial_declined', at: r.respondedAt, by: null, requestId: r.id });
  }
  for (const t of trial.trials ?? []) {
    for (const h of t.history ?? []) {
      if (!TRIAL_TIMELINE_ACTIONS.has(h?.action)) continue;
      const d = h.detail ?? {};
      out.push({
        _k: `${h.action}:${t.id}:${h.id ?? ''}`, kind: h.action, at: h.at, by: h.by?.kind === 'org' ? (h.by.name ?? null) : null,
        byKind: h.by?.kind ?? null, trialId: t.id,
        ...(d.sessionId != null ? { sessionId: d.sessionId } : {}), ...(d.trialSessionId != null ? { sessionId: d.trialSessionId } : {}),
        ...(d.state != null ? { state: d.state } : {}), ...(d.revision != null ? { revision: d.revision } : {}),
        ...(d.sessionCount != null ? { sessionCount: d.sessionCount } : {}), ...(d.phase != null ? { phase: d.phase } : {}),
        ...(d.cancelledBy != null ? { cancelledBy: d.cancelledBy } : {}), ...(d.attendedSessions != null ? { attendedSessions: d.attendedSessions } : {}),
      });
    }
  }
  for (const a of trial.assessments ?? []) {
    const at = a.submittedAt ?? a.createdAt;
    if (at != null) out.push({ _k: `trial_assessment_recorded:${a.id}`, kind: 'trial_assessment_recorded', at, by: null, trialId: a.context.trialId, assessmentId: a.id, state: a.state });
  }
  // Keyed by the contact id so two in the same millisecond keep a stable order.
  for (const c of contactRecords) {
    if (c.initiatedAt != null) {
      out.push({ _k: `contact:${c.id}`, kind: 'contact_initiated', at: c.initiatedAt, by: null, channel: c.channel, recipientType: c.recipientType, contactId: c.id });
    }
    if (c.respondedAt != null) {
      out.push({ _k: `contact_response:${c.id}`, kind: 'contact_response_received', at: c.respondedAt, by: null, responseKind: c.responseKind, contactId: c.id });
    }
  }
  // Never a term, a digest, a note or a recipient's name. An expired live
  // revision is a derived milestone at its expiry (nothing writes EXPIRED).
  for (const o of trial.offers ?? []) {
    for (const h of o.history ?? []) { const e = offerTimelineEntry(o, h); if (e) out.push(e); }
    const live = canonicalLiveStatus(o, trial.now ?? Date.now());
    if (live === 'EXPIRED') { const r = (o.revisions ?? []).filter((x) => x?.issuedAt).sort((a, b) => b.revisionNumber - a.revisionNumber)[0]; if (r?.expiresAt) out.push({ _k: `offer_expired:${o.id}:${r.id}`, kind: 'offer_expired', at: r.expiresAt, by: null, byKind: null, offerId: o.id, offerRevisionId: r.id }); }
  }
  for (const p of trial.packages ?? []) {
    for (const h of p.history ?? []) { const e = signingTimelineEntry(p, h); if (e) out.push(e); }
  }
  for (const h of kase.history ?? []) {
    if (!TIMELINE_ACTIONS.has(h?.action)) continue;
    out.push({
      _k: `${h.action}:${h.detail?.to ?? ''}`,
      kind: h.action,
      at: h.at,
      by: h.by?.name ?? null,
      from: h.detail?.from ?? null,
      to: h.detail?.to ?? null,
      reasonCodes: h.detail?.reasonCodes ?? [],
    });
  }
  // The moment the case reached outside the Room. Whether the player was
  // represented, never who their agent is, a term or an amount. Keyed on the
  // handoff id so a re-invite keeps a stable order.
  for (const h of kase.history ?? []) {
    if (h?.action !== 'transaction_handoff_invited' && h?.action !== 'transaction_handoff_withdrawn') continue;
    out.push({
      _k: `${h.action}:${h.detail?.handoffId ?? ''}`,
      kind: h.action, at: h.at, by: h.by?.name ?? null,
      handoffId: h.detail?.handoffId ?? null,
      ...(h.detail?.represented === undefined ? {} : { represented: h.detail.represented === true }),
    });
  }
  for (const d of decisions) {
    out.push({ _k: `decision:${d.id}`, kind: d.kind === 'formal' ? (d.supersededById ? 'decision_superseded' : 'decision_recorded') : 'decision', at: d.at, by: d.by, recommendation: d.recommendation, reasonCodes: d.reasonCodes, decisionKind: d.kind ?? 'recommendation', outcome: d.outcome ?? null, decisionId: d.id });
  }
  out.sort(byTimeThenKey);
  return out.map(({ _k, ...rest }) => rest);
}
