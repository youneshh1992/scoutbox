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

/** Stores this projection may not proceed without. */
export const JOURNEY_REQUIRED_STORES = Object.freeze([
  'recruitmentCases', 'roomDecisions', 'requests', 'trials', 'assessments', 'signings',
]);

/** Stores that are genuinely optional right now, because their phase has not shipped. */
export const JOURNEY_OPTIONAL_STORES = Object.freeze(['recruitmentOffers', 'outcomeReports']);

export const JOURNEY_VIEWERS = Object.freeze([
  'org_staff', 'grassroots_staff', 'player_self', 'guardian', 'trust_safety',
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
  const missing = JOURNEY_REQUIRED_STORES.filter((k) => db?.[k] === undefined);
  if (missing.length) {
    return {
      ok: false,
      error: 'JOURNEY_STORE_MISSING',
      message: 'The recruitment journey cannot be built: a required collection is absent.',
      missing,
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
    const shared = sharedRecordsFor(db, kase, viewer);
    if (shared.length === 0) {
      return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
    }
    return {
      ok: true,
      viewer: viewer.kind,
      // Deliberately NOT the case id: the player is being shown the things
      // that were shared with them, not a window onto the club's workspace.
      shared,
      policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
      generatedAt: now,
    };
  }

  // ---- §38 — Trust & Safety is not a master key.
  if (viewer.kind === 'trust_safety' && viewer.authorized !== true) {
    return { ok: false, error: 'CASE_NOT_FOUND', message: 'No such recruitment case.' };
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
    }));
  const currentDecision = decisions.filter((d) => !d.supersededById).slice(-1)[0] ?? null;

  const trials = db.trials
    .filter((t) => t?.orgId === kase.orgId && t.playerId === kase.playerId)
    .map((t) => ({ id: t.id, status: t.status, proposedDate: t.proposedDate ?? null, hasReport: !!t.report }));

  const contacts = db.requests
    .filter((r) => r?.orgId === kase.orgId && r.playerId === kase.playerId)
    .map((r) => ({ id: r.id, type: r.type, status: r.status, routedTo: r.routedTo ?? null, createdAt: r.createdAt }));

  const assessments = db.assessments
    .filter((a) => a?.orgId === kase.orgId && a.playerId === kase.playerId)
    .map((a) => ({ id: a.id, state: a.state, at: a.submittedAt ?? a.createdAt }));

  // Optional stores: absent because their phase has not shipped. Structural
  // degradation (an empty list plus an explicit availability flag), never an
  // invented record.
  const offersAvailable = Array.isArray(db.recruitmentOffers);
  const offers = offersAvailable
    ? db.recruitmentOffers.filter((o) => o?.caseId === kase.id).map((o) => ({ id: o.id, type: o.type, status: o.status }))
    : [];

  const signing = db.signings.find((s) => s?.orgId === kase.orgId && s.playerId === kase.playerId) ?? null;
  const outcomeAvailable = Array.isArray(db.outcomeReports);

  const history = timelineFor(kase, decisions);
  const limit = Math.min(Math.max(Number(historyLimit) || HISTORY_PAGE_DEFAULT, 1), HISTORY_PAGE_MAX);
  const cursor = Math.max(Number(historyCursor) || 0, 0);
  const page = history.slice(cursor, cursor + limit);

  const conditions = derivedConditions({
    status,
    hasCurrentDecision: !!currentDecision,
    activeTrial: trials.some((t) => t.status === 'awaiting_report'),
    offerAwaitingResponse: offers.some((o) => o.status === 'sent'),
  });

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
    contact: { records: contacts },
    trials,
    assessments,
    decisions: { all: decisions, current: currentDecision },
    offer: { available: offersAvailable, records: offers },
    outcome: {
      available: outcomeAvailable,
      // A signing is a separate, confirmed fact. It is reported as what it is
      // and never inferred from the lifecycle reaching `offer_accepted`.
      signing: signing ? { id: signing.id, at: signing.ts } : null,
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
function sharedRecordsFor(db, kase, viewer) {
  const mine = (r) => {
    if (r?.orgId !== kase.orgId || r.playerId !== kase.playerId) return false;
    if (viewer.kind === 'player_self') return r.routedTo !== 'guardian' && viewer.playerId === kase.playerId;
    return r.routedTo === 'guardian' && r.guardianId === viewer.guardianId;
  };
  return db.requests.filter(mine).map((r) => ({
    kind: 'contact_request',
    id: r.id,
    type: r.type,
    status: r.status,
    at: r.createdAt,
  }));
}

/**
 * The club timeline: lifecycle-meaningful events only.
 *
 * Reads are absent by construction rather than filtered out — `audit()` only
 * ever wrote things that changed something. Note bodies never appear.
 */
function timelineFor(kase, decisions) {
  const out = [];
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
  for (const d of decisions) {
    out.push({ _k: `decision:${d.id}`, kind: 'decision', at: d.at, by: d.by, recommendation: d.recommendation, reasonCodes: d.reasonCodes });
  }
  out.sort(byTimeThenKey);
  return out.map(({ _k, ...rest }) => rest);
}
