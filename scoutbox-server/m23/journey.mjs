/**
 * M23 — the canonical recruitment journey projection.
 *
 * A journey is NOT a stored object. It is what you get when you read the
 * canonical records for one case and arrange them for one viewer. Nothing here
 * writes, nothing here caches, and there is no `db.recruitmentJourneys` — a
 * second copy of a derivation is a second thing that can be wrong.
 *
 * Inputs, all canonical and all owned by someone else:
 *
 *   db.recruitmentCases    the case, its room facet, and case.history
 *   db.roomDecisions       append-only decisions (M17)
 *   db.requests            contact/trial requests (core)
 *   db.trials              accepted trials (core)
 *   db.assessments         assessments (M12)
 *   db.recruitmentOffers   offers (M23 P4 — absent in P2, and that is fine)
 *   db.outcomeReports      post-signing outcomes (M12)
 *   db.signings            signings (core)
 *
 * THE D2 CARRY-FORWARD (§26). A required store that is ABSENT is not an empty
 * recruitment history — it is a broken database, and reporting "nothing
 * happened" would be the most misleading possible answer. The projector
 * refuses instead. Migration should make this unreachable; if it is ever
 * reached, something is wrong that a person needs to see.
 *
 * NO SCORE (§30). There is no journey score, readiness score, signing
 * probability, candidate quality or progress percentage — and there is no
 * field one could be stored in. How far a case has travelled is a fact about a
 * club's process, not a measurement of a person.
 */

import {
  LIFECYCLE_TERMINAL, LIFECYCLE_REOPENABLE, RECRUITMENT_LIFECYCLE_POLICY_VERSION,
  availableActions, derivedConditions, NULL_EVIDENCE_PROVIDER,
} from './lifecycle.mjs';
import { ROOM_STATUS_LABELS, ROOM_TRANSITIONS } from '../m17/shared.mjs';
import { contactMilestone, contactIntegrity } from './contact.mjs';
import { trialMilestone, trialIntegrity } from './trial.mjs';
// M23 P6 — the Offer domain's own status derivation (lazy expiry), so the
// journey never reads a stored status an expired revision has outgrown.
import { offerStatus as canonicalOfferStatus, liveStatus as canonicalLiveStatus, offerIntegrity, offerCaseConsistency, offerCaseCorrupt } from '../m28/offer.mjs';
import { effectiveStatus as signingEffectiveStatus, currentRevision as signingCurrentRevision, signingIntegrity, signingConsistency, signingCorrupt, isLive as signingIsLive, findParty } from '../m29/signing.mjs';
// M23 P8 — the journey MODEL: stage, completed stages, current resources, the
// server-derived next action, the validator and the timeline visibility table.
import {
  JOURNEY_POLICY_VERSION, canonicalStageFor, completedStagesFor, nextActionFor, validateRecruitmentJourney,
  currentContactForCase, currentTrialForCase, currentAssessmentForCase, currentDecisionForCase, currentOfferForCase, currentSigningForCase,
  playerNextActionFor, playerStageFor, timelineVisibleTo, offerTimelineEntry, signingTimelineEntry,
} from './journeyModel.mjs';

/** Stores this projection may not proceed without. `recruitmentContacts` joined in P3. */
export const JOURNEY_REQUIRED_STORES = Object.freeze([
  'recruitmentCases', 'roomDecisions', 'requests', 'trials', 'assessments', 'signings',
  'recruitmentContacts',
]);

/** Stores that are genuinely optional right now, because their phase has not shipped. */
export const JOURNEY_OPTIONAL_STORES = Object.freeze(['recruitmentOffers', 'outcomeReports']);

export const JOURNEY_VIEWERS = Object.freeze([
  'org_staff', 'grassroots_staff', 'player_self', 'guardian', 'trust_safety',
  // M23 P8 — an authorized agent: the route proves the basis (representation,
  // scope, licence, the client's own share) and passes `authorized: true`;
  // the projection then shows the factual workflow stages the client shared.
  'agent',
]);

const HISTORY_PAGE_DEFAULT = 50;
const HISTORY_PAGE_MAX = 200;

/**
 * Deterministic ordering: time, then a stable tie-break.
 *
 * Two entries written in the same millisecond — which the reopen path does on
 * purpose — must still come back in the same order on every read, or two
 * identical requests disagree.
 */
const byTimeThenKey = (a, b) => {
  const ta = Date.parse(a.at ?? 0) || Number(a.at) || 0;
  const tb = Date.parse(b.at ?? 0) || Number(b.at) || 0;
  if (ta !== tb) return ta - tb;
  return String(a._k ?? '').localeCompare(String(b._k ?? ''));
};

/** The history actions that are lifecycle-meaningful. Page views are not. */
const TIMELINE_ACTIONS = new Set([
  'room_created', 'room_status_changed', 'room_reopened',
  'case_created', 'case_stage_changed',
  'room_decision_recorded',
]);

/** P4B — the Trial history actions that are milestones. Unlinking is housekeeping. */
const TRIAL_TIMELINE_ACTIONS = new Set([
  'trial_accepted', 'trial_schedule_proposed', 'trial_rescheduled', 'trial_schedule_confirmed', 'trial_schedule_declined',
  'trial_attendance_recorded', 'trial_cancelled', 'trial_completed', 'trial_evidence_linked',
]);

/**
 * @param {object} db
 * @param {string} caseId
 * @param {object} viewer  { kind, orgId?, userId?, role?, playerId?, guardianId?, authorized? }
 * @param {object} opts    { now?, evidence?, historyLimit?, historyCursor? }
 *
 * No visibility callback is taken, and none is needed. This projection carries
 * the club's own record of its own process — decisions it wrote, statuses it
 * set, ids of records it already owns — and NO player identity: no name, no
 * date of birth, no contact detail. A block or a removal stops a player's data
 * flowing; there is no player data here for it to stop. The surfaces that do
 * carry player identity (M17's room header) re-run `orgCanSee` on every read,
 * which is where that check belongs.
 */
export function buildRecruitmentJourney(db, caseId, viewer, opts = {}) {
  const {
    now = Date.now(),
    evidence = NULL_EVIDENCE_PROVIDER,
    historyLimit = HISTORY_PAGE_DEFAULT,
    historyCursor = 0,
  } = opts;

  // ---- §26 — infrastructure before data.
  //
  // A required collection that is ABSENT and one that is present but is not a
  // list are the same class of problem: the database is not in a shape this
  // build can read. Checking only for `undefined` let `null` — the shape a
  // half-finished migration leaves behind — through the gate to throw a
  // TypeError deeper in, where it reads as a bug in the projector rather than
  // as the broken infrastructure it is. Both are reported, named separately so
  // the log says which happened.
  const missing = JOURNEY_REQUIRED_STORES.filter((k) => db?.[k] === undefined);
  const malformed = JOURNEY_REQUIRED_STORES.filter((k) => db?.[k] !== undefined && !Array.isArray(db[k]));
  if (missing.length || malformed.length) {
    return {
      ok: false,
      error: 'JOURNEY_STORE_MISSING',
      message: 'The recruitment journey cannot be built: a required collection is absent or is not a list.',
      missing,
      malformed,
    };
  }

  if (!JOURNEY_VIEWERS.includes(viewer?.kind)) {
    return { ok: false, error: 'JOURNEY_VIEWER_UNKNOWN', message: 'Unknown viewer context.' };
  }

  const kase = db.recruitmentCases.find((c) => c?.id === caseId);

  // ---- §39 — tenant isolation with 404 concealment.
  //
  // A foreign organisation's case must be indistinguishable from one that does
  // not exist. Same code, same message, no count, no hint that the id is real.
  const orgScoped = viewer.kind === 'org_staff' || viewer.kind === 'grassroots_staff';
  if (!kase || (orgScoped && kase.orgId !== viewer.orgId)) {
    return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
  }
  if (!kase.room) {
    return { ok: false, error: 'CASE_NOT_A_ROOM', message: 'This recruitment case has no workspace.' };
  }

  // ---- §35/§36/§37 — hidden club interest.
  //
  // THE RULE THIS ENFORCES: a player cannot learn that a club has a case on
  // them by asking. Not the stage, not the existence, not a count, not a
  // different error for "exists but hidden" versus "does not exist".
  //
  // At P2 no share boundary has been crossed by anything — Contact, Trial and
  // Offer arrive in later phases — so the honest answer to every player and
  // guardian is the same one they would get for a case that was never opened.
  if (viewer.kind === 'player_self' || viewer.kind === 'guardian') {
    const shared = sharedRecordsFor(db, kase, viewer, now);
    if (shared.length === 0) {
      return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
    }
    return {
      ok: true,
      viewer: viewer.kind,
      // Deliberately NOT the case id: the player is being shown the things
      // that were shared with them, not a window onto the club's workspace.
      shared,
      // M23 P8 — the player's own journey: a stage word derived only from
      // records that reached them, the one thing they could do now, the ids
      // of their current records, and the milestones they were party to.
      // No case id, no lifecycle state, no priority, no decision, no note.
      journey: playerJourneyFor(db, kase, viewer, shared, now),
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
      generatedAt: now,
    };
  }

  // ---- §38 — Trust & Safety is not a master key.
  if (viewer.kind === 'trust_safety' && viewer.authorized !== true) {
    return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
  }

  // ---- M23 P8 §17/§47 — an agent is not a master key either. The route
  // establishes the basis; without `authorized: true` the case does not exist.
  if (viewer.kind === 'agent') {
    if (viewer.authorized !== true || viewer.playerId !== kase.playerId) {
      return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
    }
    return agentJourneyFor(db, kase, viewer, now);
  }

  // A history that is not a list cannot be read, and must not be reported as
  // an empty one. `history: { entries: [], total: 0 }` asserts that nothing
  // ever happened to this case — a confident wrong answer, which is worse than
  // no answer. The current status would still be true, but a page that shows a
  // state and silently drops how it was reached is the fabrication the
  // governing rule forbids.
  //
  // DELIBERATELY BELOW the concealment branches. Answering a player
  // "this case is corrupt" where a stranger gets "no such case" confirms the
  // case exists — corruption reporting must not become a disclosure oracle.
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

  const decisions = db.roomDecisions
    .filter((d) => d?.roomId === kase.id && d.orgId === kase.orgId)
    .map((d) => ({
      id: d.id,
      recommendation: d.recommendation,
      reasonCodes: d.reasonCodes ?? [],
      at: d.createdAt,
      by: d.by?.name ?? null,
      supersededById: d.supersededById ?? null,
      // §80 — the note is NEVER projected. It is org-private free text and it
      // has no business travelling inside a summary that other surfaces embed.
      hasNote: !!d.note,
      // P5 — a formal decision is the same row with an outcome; legacy rows
      // read as advisory recommendations. Ids, the outcome word, a count.
      kind: d.kind === 'formal' ? 'formal' : 'recommendation',
      outcome: d.kind === 'formal' ? d.outcome ?? null : null,
      evidenceCount: d.kind === 'formal' ? (Array.isArray(d.evidenceRefs) ? d.evidenceRefs.length : 0) : 0,
    }));
  const currentDecision = decisions.filter((d) => !d.supersededById).slice(-1)[0] ?? null;
  const currentFormal = currentDecision && currentDecision.kind === 'formal' ? currentDecision : null;
  // P5 — the case's single draft, for the club only: its existence, its
  // outcome and who holds it. Never its rationale; never on any other viewer.
  const decisionDraft = kase.decisionDraft && typeof kase.decisionDraft === 'object'
    ? { id: kase.decisionDraft.id ?? null, outcome: kase.decisionDraft.outcome ?? null, by: kase.decisionDraft.by?.name ?? null, updatedAt: kase.decisionDraft.updatedAt ?? null }
    : null;

  // P4B — the Trial workflow, as MILESTONES: ids, states, times and counts
  // (§87). Never instructions, an address, a note, an observation or an
  // assessment. A structurally corrupt row is omitted and counted (§143).
  let trialsOmitted = 0;
  const trials = [];
  for (const t of db.trials) {
    if (!t || t.orgId !== kase.orgId || t.playerId !== kase.playerId) continue;
    if (trialIntegrity(t, { orgId: kase.orgId, caseId: t.caseId ?? null }).length) { trialsOmitted += 1; continue; }
    trials.push({ id: t.id, status: t.status, proposedDate: t.proposedDate ?? null, hasReport: !!t.report, workflow: trialMilestone(t) });
  }
  // P8 — the model, the current-resource selection and the timeline read THIS
  // case's Trials only (`caseId`), the same scope as the evidence provider: a
  // Trial from this club's earlier, ended case with the same player is that
  // case's history, never this case's current Trial or its trial stage. The
  // `trials` list above stays the club's view of the player (P4).
  const trialRows = db.trials.filter((t) => t?.orgId === kase.orgId && t.playerId === kase.playerId && t.caseId === kase.id && trials.some((x) => x.id === t.id));
  const trialInvitations = db.requests.filter((r) => r?.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId);
  const trialAssessments = (db.assessments ?? []).filter((a) => a?.orgId === kase.orgId && a.playerId === kase.playerId && a.context?.trialId && trialRows.some((x) => x.id === a.context.trialId));

  const contacts = db.requests
    .filter((r) => r?.orgId === kase.orgId && r.playerId === kase.playerId)
    .map((r) => ({ id: r.id, type: r.type, status: r.status, routedTo: r.routedTo ?? null, createdAt: r.createdAt }));

  // P3 — the Contact workflow, as MILESTONES (§87). Ids, states and times.
  // Never a body, a summary or a reply: the journey is a map of the process,
  // not a copy of the communication. A structurally corrupt record is omitted
  // and counted rather than rendered as if it were sound (§143).
  let contactsOmitted = 0;
  const contactRecords = [];
  for (const c of db.recruitmentContacts) {
    if (!c || c.caseId !== kase.id || c.orgId !== kase.orgId) continue;
    if (contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length) { contactsOmitted += 1; continue; }
    contactRecords.push(contactMilestone(c));
  }
  contactRecords.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const assessments = db.assessments
    .filter((a) => a?.orgId === kase.orgId && a.playerId === kase.playerId)
    .map((a) => ({ id: a.id, state: a.state, at: a.submittedAt ?? a.createdAt }));

  // Optional stores: absent because their phase has not shipped. Structural
  // degradation (an empty list plus an explicit availability flag), never an
  // invented record.
  // P6: the canonical Offer store. Only this case's own rows (same org, same
  // player), with an integrity check so a malformed row projects nothing; the
  // status is DERIVED (an ISSUED revision past its expiry reads EXPIRED).
  // Terms, notes and documents never appear in the journey.
  const offersAvailable = Array.isArray(db.recruitmentOffers);
  const offers = offersAvailable
    ? db.recruitmentOffers
      .filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0 && !offerCaseCorrupt(offerCaseConsistency(o, kase, now)))
      .map((o) => ({ id: o.id, type: o.type, status: canonicalOfferStatus(o, now), liveStatus: canonicalLiveStatus(o, now) }))
    : [];

  // M23 P7.1/P8 — the signing ROW that supports this case: the one a
  // COMPLETED package on THIS case names back, else (legacy) the club's
  // un-packaged row for this player. A row that names another case's
  // package proves nothing here.
  const packageRows = Array.isArray(db.signingPackages) ? db.signingPackages.filter((p) => p?.caseId === kase.id && p.orgId === kase.orgId && p.playerId === kase.playerId) : [];
  const signing = supportingSigningRow(db, kase, packageRows) ?? null;
  const outcomeAvailable = Array.isArray(db.outcomeReports);

  // ---- M23 P8 — the journey block: stage, completed stages, current
  // resources, the server-derived next action and the classification.
  const offerRows = offersAvailable ? db.recruitmentOffers.filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0) : [];
  const soundPackages = packageRows.filter((p) => signingIntegrity(p, { orgId: kase.orgId }).length === 0);
  const allAssessments = db.assessments.filter((a) => a?.orgId === kase.orgId && a.playerId === kase.playerId);
  const journeyBlock = journeyFor(db, kase, {
    status, role, now,
    contacts: db.recruitmentContacts.filter((c) => c && c.caseId === kase.id && c.orgId === kase.orgId && contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length === 0),
    trials: trialRows, trialRequests: trialInvitations, assessments: allAssessments,
    decisions: db.roomDecisions.filter((d) => d?.roomId === kase.id && d.orgId === kase.orgId),
    offers: offerRows, packages: soundPackages, signingRow: signing,
    foreign: foreignReferences(db, kase),
    domainProblems: [
      ...offerRows.flatMap((o) => offerCaseConsistency(o, kase, now).filter((c) => offerCaseCorrupt([c]))),
      ...soundPackages.flatMap((p) => signingConsistency(p, { offer: offerRows.find((o) => o.id === p.offerId) ?? null, kase, rows: db.signings, player: (db.players ?? []).find((x) => x?.id === kase.playerId) ?? null }, now).filter((c) => signingCorrupt([c]))),
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
  // P5 §61 — evaluation exists (a submitted assessment or a completed trial)
  // and no FORMAL decision stands on a live case. Derived by looking, never
  // stored, never a status; a workflow-coverage fact, not a judgement.
  conditions.decisionOutstanding = !LIFECYCLE_TERMINAL.includes(status)
    && !currentFormal
    && (assessments.some((a) => a.state !== 'draft') || trials.some((t) => t.workflow?.workflowState === 'completed'));
  conditions.hasFormalDecision = !!currentFormal;

  // §31/§42 — next actions are deterministic AND permission-aware. An action
  // this person cannot perform is not a suggestion, it is a dead end with a
  // 403 at the end of it.
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
      stage: kase.stage ?? null,          // the M12 derivation, for reference only
      terminal: LIFECYCLE_TERMINAL.includes(status),
      reopenable: LIFECYCLE_REOPENABLE.includes(status),
      allowedNext: ROOM_TRANSITIONS[status] ?? [],
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
    },
    conditions,
    nextActions: actions,
    // M23 P8 — ONE server-derived next action, the current resources and the
    // classification. Clients read these; they never compute them.
    journey: journeyBlock,
    contact: { records: contacts, contacts: contactRecords, omitted: contactsOmitted },
    trials,
    trialsOmitted,
    assessments,
    decisions: { all: decisions, current: currentDecision, formal: currentFormal, draft: decisionDraft },
    offer: { available: offersAvailable, records: offers },
    outcome: {
      available: outcomeAvailable,
      // A signing is a separate, confirmed fact. It is reported as what it is
      // and never inferred from the lifecycle reaching `offer_accepted`.
      signing: signing ? { id: signing.id, at: signing.ts, method: signing.method ?? 'LEGACY_RECORDED', signingPackageId: signing.signingPackageId ?? null } : null,
      // M23 P7 — the signing WORKFLOW, ids and the status word only. A case at
      // `signed` from before P7 has none, and none is invented for it.
      signingPackages: Array.isArray(db.signingPackages)
        ? db.signingPackages
          .filter((p) => p?.caseId === kase.id && p.orgId === kase.orgId && p.playerId === kase.playerId && signingIntegrity(p, { orgId: kase.orgId }).length === 0)
          .map((p) => ({ id: p.id, status: signingEffectiveStatus(p, now), revisionNumber: signingCurrentRevision(p)?.revisionNumber ?? null, offerId: p.offerId, signingId: p.completion?.signingId ?? null }))
        : [],
    },
    history: { entries: page, total: history.length, cursor, nextCursor: cursor + page.length < history.length ? cursor + page.length : null },
    generatedAt: now,
  };
}

/**
 * What a player or guardian may see: records that crossed an explicit share
 * boundary, and nothing else.
 *
 * At P2 this returns the contact/trial requests that were actually sent to
 * them — records that already exist and that they already receive through the
 * Inbox. It deliberately contains no case id, no stage, no room, no decision
 * and no count of anything internal.
 */
function sharedRecordsFor(db, kase, viewer, now = Date.now()) {
  const mine = (r) => {
    if (r?.orgId !== kase.orgId || r.playerId !== kase.playerId) return false;
    if (viewer.kind === 'player_self') return r.routedTo !== 'guardian' && viewer.playerId === kase.playerId;
    return r.routedTo === 'guardian' && r.guardianId === viewer.guardianId;
  };
  const requests = db.requests.filter(mine).map((r) => ({
    kind: 'contact_request',
    id: r.id,
    type: r.type,
    status: r.status,
    at: r.createdAt,
  }));
  // P4B — the family's own Trial: the operational edge they already hold
  // through /player/trials and /guardian/trials (state, revision, times).
  // Only the recipient who accepted sees it here; a minor's own device sees
  // the outcome line, never the guardian's record. No case id, no history.
  const mineTrial = (t) => {
    if (t?.orgId !== kase.orgId || t.playerId !== kase.playerId || t.subjectRemovedAt) return false;
    if (viewer.kind === 'player_self') return viewer.playerId === kase.playerId && (t.recipient ? t.recipient.type === 'player' : t.acceptedBy === 'player');
    return t.recipient ? t.recipient.type === 'guardian' && t.recipient.guardianId === viewer.guardianId : t.acceptedBy === 'guardian';
  };
  const trials = db.trials.filter(mineTrial).map((t) => {
    const m = trialMilestone(t);
    return { kind: 'trial', id: t.id, workflowState: m.workflowState, at: t.acceptedAt, scheduledAt: m.scheduledAt, revision: m.revision, sessionCount: m.sessions.length, completion: m.completion };
  });
  // M23 P8 — an Offer whose live revision was ISSUED to this recipient, and a
  // signing package PRESENTED to them, crossed the share boundary too. Ids,
  // status words and instants; no terms, no digest, no note.
  const offers = offersSharedWith(db, kase, viewer, now).map(({ offer, revision, liveStatus }) => ({ kind: 'offer', id: offer.id, revisionId: revision?.id ?? null, revisionNumber: revision?.revisionNumber ?? null, status: liveStatus, at: revision?.issuedAt ?? offer.createdAt ?? null, respondedAt: revision?.respondedAt ?? null }));
  const signings = packagesSharedWith(db, kase, viewer, now).map((p) => ({ kind: 'signing', id: p.id, status: signingEffectiveStatus(p, now), revisionNumber: signingCurrentRevision(p)?.revisionNumber ?? null, at: signingCurrentRevision(p)?.readyAt ?? p.createdAt ?? null, completedAt: p.completion?.completedAt ?? null }));
  return [...requests, ...trials, ...offers, ...signings];
}

/** Offers of this case whose live revision was issued to THIS recipient (the snapshot names them). */
function offersSharedWith(db, kase, viewer, now) {
  if (!Array.isArray(db.recruitmentOffers)) return [];
  const out = [];
  for (const o of db.recruitmentOffers) {
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

/** Signing packages of this case presented (READY or later) with a required party for THIS recipient. */
function packagesSharedWith(db, kase, viewer, now) {
  if (!Array.isArray(db.signingPackages)) return [];
  return db.signingPackages.filter((p) => {
    if (!p || p.caseId !== kase.id || p.orgId !== kase.orgId || p.playerId !== kase.playerId) return false;
    if (signingIntegrity(p, { orgId: kase.orgId }).length) return false;
    const rev = signingCurrentRevision(p);
    if (!rev?.readyAt) return false; // a DRAFT never reached anyone
    return viewer.kind === 'player_self'
      ? !!findParty(rev, 'PLAYER', viewer.playerId)
      : !!findParty(rev, 'GUARDIAN', viewer.guardianId);
  });
}

/**
 * The signing ROW that supports THIS case (P7.1 §32 applied to the journey):
 * a row a COMPLETED package on this case names back, else — for a case from
 * before P7 — the club's un-packaged row for this player. A row that belongs
 * to another case's package is not this case's evidence.
 */
function supportingSigningRow(db, kase, packageRows) {
  const rows = (db.signings ?? []).filter((s) => s && s.orgId === kase.orgId && s.playerId === kase.playerId && !s.cancelledAt && !s.revokedAt && !s.voidedAt);
  for (const p of packageRows) {
    if (p.status !== 'COMPLETED' || !p.completion?.signingId) continue;
    const row = rows.find((s) => s.id === p.completion.signingId && s.signingPackageId === p.id);
    if (row) return row;
  }
  return rows.find((s) => !s.signingPackageId) ?? null;
}

/** Records that name this case but another player or club: reported, never used. */
function foreignReferences(db, kase) {
  const out = new Set();
  const check = (rows, orgKey = 'orgId') => {
    for (const r of rows ?? []) {
      if (!r || r.caseId !== kase.id) continue;
      if (r[orgKey] !== kase.orgId) out.add('CLUB_MISMATCH');
      if (r.playerId !== undefined && r.playerId !== kase.playerId) out.add('PLAYER_MISMATCH');
    }
  };
  check(db.recruitmentContacts); check(db.trials); check(db.requests); check(db.recruitmentOffers); check(db.signingPackages);
  for (const d of db.roomDecisions ?? []) { if (d?.roomId === kase.id && (d.orgId !== kase.orgId || (d.playerId !== undefined && d.playerId !== kase.playerId))) out.add(d.orgId !== kase.orgId ? 'CLUB_MISMATCH' : 'PLAYER_MISMATCH'); }
  return [...out];
}

/**
 * M23 P8 — the journey block for the club: the canonical stage, the completed
 * stages with their basis, the current resource of each kind, ONE next
 * action for this viewer, and the validator's verdict. Reads; never writes.
 */
function journeyFor(db, kase, f) {
  const contact = currentContactForCase(f.contacts);
  const trial = currentTrialForCase(f.trials);
  const trialRequest = (f.trialRequests ?? []).filter((r) => r?.status === 'pending' && !r.subjectRemovedAt).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] ?? null;
  const assessment = currentAssessmentForCase(f.assessments);
  const assessed = (f.assessments ?? []).some((a) => a && a.state !== 'draft');
  const decisionHead = currentDecisionForCase(f.decisions);
  const decision = decisionHead && decisionHead.kind === 'formal' ? decisionHead : null;
  const offer = currentOfferForCase(f.offers, f.now);
  const signing = currentSigningForCase(f.packages, f.now);
  const facts = { ...f, kase, createdAt: kase.createdAt ?? null, history: Array.isArray(kase.history) ? kase.history : [], historyMalformed: kase.history !== undefined && !Array.isArray(kase.history) };
  const blocked = (db.blocks ?? []).some((b) => b && b.playerId === kase.playerId && b.orgId === kase.orgId);
  const subjectRemoved = !!kase.subjectRemovedAt || !(db.players ?? []).some((p) => p?.id === kase.playerId);
  const verdict = validateRecruitmentJourney(facts);
  const next = nextActionFor({ status: f.status, role: f.role, now: f.now, blocked, subjectRemoved, contact, trial, trialRequest, assessed, decision, offer, signing, signingRow: f.signingRow });
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

/**
 * M23 P8 §16 — the player's (or guardian's) journey with ONE club: derived
 * only from records that reached them. Stage word, next action, current
 * ids, the milestones they were party to. No case id, no lifecycle word
 * (except `signed`, which is theirs), no priority, no decision, no note.
 */
function playerJourneyFor(db, kase, viewer, shared, now) {
  const audience = viewer.kind === 'guardian' ? 'guardian' : 'player';
  const requests = shared.filter((s) => s.kind === 'contact_request');
  const contactReqs = requests.filter((r) => r.type === 'contact');
  const trialReqs = requests.filter((r) => r.type === 'trial');
  const trialRows = db.trials.filter((t) => shared.some((s) => s.kind === 'trial' && s.id === t?.id));
  const offers = offersSharedWith(db, kase, viewer, now);
  const offer = offers.length ? currentOfferForCase(offers.map((x) => x.offer), now) : null;
  const packages = packagesSharedWith(db, kase, viewer, now);
  const signing = packages.length ? currentSigningForCase(packages, now) : null;
  const signingRow = signing && signing.status === 'COMPLETED' && signing.completion?.signingId ? (db.signings ?? []).find((s) => s?.id === signing.completion.signingId && s.signingPackageId === signing.id) ?? null : null;
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
  // The milestones they were party to, from the same derivations the club's
  // timeline uses, filtered by the visibility table — never club history.
  const contactRecords = db.recruitmentContacts.filter((c) => c && c.caseId === kase.id && c.orgId === kase.orgId && ['delivered', 'responded'].includes(c.status) && contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length === 0 && (audience === 'guardian' ? c.recipient?.type === 'guardian' : c.recipient?.type === 'player')).map(contactMilestone);
  const invitations = db.requests.filter((r) => r?.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId && trialReqs.some((x) => x.id === r.id));
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
 * M23 P8 §17 — an authorized agent's projection: the factual workflow stages
 * the client shared, and nothing about the club's process. The route has
 * already proved the basis; `viewer.grants` says which record kinds the
 * scope and the client's shares permit (`contacts`, `trials`, `offers`,
 * `signings`). Ungranted kinds read as absent, not as refused, so the
 * projection itself does not disclose what it is hiding.
 */
function agentJourneyFor(db, kase, viewer, now) {
  const grants = new Set(viewer.grants ?? []);
  // Only the records the client's own act routed or shared to THIS agent: a
  // contact whose routing snapshot names them, an Offer the client shared
  // with them, the packages over those Offers. Trials follow the client's
  // disclosure choice (the `trials` grant).
  const contactRecords = grants.has('contacts') ? db.recruitmentContacts.filter((c) => c && c.caseId === kase.id && c.orgId === kase.orgId && ['delivered', 'responded'].includes(c.status) && c.routingSnapshot?.agent?.agentUserId === viewer.userId && contactIntegrity(c, { orgId: kase.orgId, caseId: kase.id }).length === 0).map(contactMilestone) : [];
  const trialRows = grants.has('trials') ? db.trials.filter((t) => t && t.caseId === kase.id && t.orgId === kase.orgId && t.playerId === kase.playerId && !t.subjectRemovedAt && trialIntegrity(t, { orgId: kase.orgId, caseId: kase.id }).length === 0) : [];
  const invitations = grants.has('trials') ? db.requests.filter((r) => r?.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId) : [];
  const offerRows = grants.has('offers') && Array.isArray(db.recruitmentOffers) ? db.recruitmentOffers.filter((o) => o?.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && o.agentShare?.agentUserId === viewer.userId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0 && liveRevisionOf(o)) : [];
  const sharedOfferIds = new Set(offerRows.map((o) => o.id));
  const packages = grants.has('signings') && Array.isArray(db.signingPackages) ? db.signingPackages.filter((p) => p?.caseId === kase.id && p.orgId === kase.orgId && p.playerId === kase.playerId && sharedOfferIds.has(p.offerId) && signingIntegrity(p, { orgId: kase.orgId }).length === 0 && signingCurrentRevision(p)?.readyAt) : [];
  const offer = currentOfferForCase(offerRows, now);
  const signing = currentSigningForCase(packages, now);
  const signingRow = signing?.status === 'COMPLETED' && signing.completion?.signingId ? (db.signings ?? []).find((s) => s?.id === signing.completion.signingId && s.signingPackageId === signing.id) ?? null : null;
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
      resources: { contactId: currentContactForCase(db.recruitmentContacts.filter((c) => c && c.caseId === kase.id && contactRecords.some((m) => m.id === c.id)))?.id ?? null, trialId: currentTrialForCase(trialRows)?.id ?? null, offerId: offer?.offer.id ?? null, offerRevisionId: offer?.revision?.id ?? null, signingPackageId: signing?.id ?? null },
      timeline,
      grants: [...grants],
    },
    policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
    generatedAt: now,
  };
}
const liveRevisionOf = (o) => (o?.revisions ?? []).some((r) => r && r.status !== 'DRAFT' && r.issuedAt);

/**
 * The club timeline: lifecycle-meaningful events only.
 *
 * Reads are absent by construction rather than filtered out — `audit()` only
 * ever wrote things that changed something. Note bodies never appear.
 */
function timelineFor(kase, decisions, contactRecords = [], trial = {}) {
  const out = [];
  // P4B — Trial milestones: ids, states and counts. The invitation and its
  // decline come from the request row; everything after acceptance comes
  // from the Trial's own append-only history; an assessment is recorded as
  // existing and nothing more (D-16). Never a note, an address, an
  // instruction, an observation or a rating.
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
  // P3 — two safe milestones per contact, keyed by the contact id so two in
  // the same millisecond keep a stable order.
  for (const c of contactRecords) {
    if (c.initiatedAt != null) {
      out.push({ _k: `contact:${c.id}`, kind: 'contact_initiated', at: c.initiatedAt, by: null, channel: c.channel, recipientType: c.recipientType, contactId: c.id });
    }
    if (c.respondedAt != null) {
      out.push({ _k: `contact_response:${c.id}`, kind: 'contact_response_received', at: c.respondedAt, by: null, responseKind: c.responseKind, contactId: c.id });
    }
  }
  // M23 P8 — Offer and signing milestones from each record's own append-only
  // history: ids, words and instants. Never a term, a digest, a note or a
  // recipient's name. A live revision that expired unanswered is a derived
  // milestone at its expiry instant (nothing writes EXPIRED).
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
  // M23 P5.6E — the club's own record that it invited a transaction workspace from
  // this case, and that it withdrew the invitation. A milestone, because it is the
  // moment the case reached outside the Room. Ids, a time, the colleague who did it
  // and WHETHER the player was represented — never who their agent is, never a term,
  // never an amount. Keyed on the handoff id so an invite and a later re-invite keep
  // a stable order rather than colliding.
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
