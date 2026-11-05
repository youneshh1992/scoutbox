// Test helper (§4.3 step 2). The server reads the cases and Room records, requests, trials, contacts, offers, signing
// packages, signings, follow-ups and outcome reports through SQL (the repositories' queries, `recruitmentReads`); the pure projectors and
// providers take those queries as `reads`. The batteries that exercise the projectors directly build plain in-memory databases, so this
// helper answers the same queries over the plain arrays of such a database, in array order (the tables' rowid order).
//
// A database WITHOUT one of the arrays gets no query object for it, exactly as the old code saw no collection: the
// journey reports the missing contacts store, the evidence provider answers "store unavailable", and the offers stay
// the optional phase they always were.
import { buildRecruitmentJourney as journey } from '../domains/recruitment/lifecycle/journey.mjs';
import { createEvidenceProvider as provider } from '../domains/recruitment/lifecycle/evidence.mjs';
import { buildReportingContext as reportingContext } from '../m20/dashboard.mjs';
import { resolveEvidenceLink as resolveLink, recordBelongsToPlayer as belongs, validateEvidenceLink as validateLink } from '../domains/development/hub/evidence.mjs';
import { resolveEvidenceRefs as resolveRefs, evidenceCandidates as candidates } from '../domains/recruitment/lifecycle/decision.mjs';
import { buildDevelopmentPlan as buildPlan } from '../domains/development/hub/plan.mjs';

const sound = (r) => r !== null && typeof r === 'object';

function contactQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((c) => c.id === id) ?? null,
    forCase: (caseId) => list().filter((c) => c.caseId === caseId),
    forOrgPlayer: (orgId, playerId) => list().filter((c) => c.orgId === orgId && c.playerId === playerId),
    forPlayer: (playerId) => list().filter((c) => c.playerId === playerId),
    forRequest: (requestId) => list().filter((c) => c.requestId === requestId),
    forAgent: (agentUserId) => list().filter((c) => c.routingSnapshot?.agent?.agentUserId === agentUserId),
    forOrg: (orgId) => list().filter((c) => c.orgId === orgId),
  };
}

function offerQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((o) => o.id === id) ?? null,
    forCase: (caseId) => list().filter((o) => o.caseId === caseId),
    forOrgPlayer: (orgId, playerId) => list().filter((o) => o.orgId === orgId && o.playerId === playerId),
    forPlayer: (playerId) => list().filter((o) => o.playerId === playerId),
    forPlayers: (playerIds) => list().filter((o) => (playerIds ?? []).includes(o.playerId)),
    forAgentShare: (agentUserId) => list().filter((o) => o.agentShare?.agentUserId === agentUserId),
    forOrg: (orgId) => list().filter((o) => o.orgId === orgId),
  };
}

function packageQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((p) => p.id === id) ?? null,
    forCase: (caseId) => list().filter((p) => p.caseId === caseId),
    forOffer: (offerId) => list().filter((p) => p.offerId === offerId),
    forPlayer: (playerId) => list().filter((p) => p.playerId === playerId),
    forOrg: (orgId) => list().filter((p) => p.orgId === orgId),
    forOrgPlayer: (orgId, playerId) => list().filter((p) => p.orgId === orgId && p.playerId === playerId),
  };
}

function signingQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((s) => s.id === id) ?? null,
    forOrg: (orgId) => list().filter((s) => s.orgId === orgId),
    forPlayer: (playerId) => list().filter((s) => s.playerId === playerId),
    forOrgPlayer: (orgId, playerId) => list().filter((s) => s.orgId === orgId && s.playerId === playerId),
    forPackage: (packageId) => list().find((s) => s.signingPackageId === packageId) ?? null,
    forOffer: (offerId) => list().find((s) => s.offerId === offerId) ?? null,
    countForOrg: (orgId) => list().filter((s) => s.orgId === orgId).length,
    count: () => list().length,
  };
}

function followUpQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((f) => f.id === id) ?? null,
    forSigning: (signingId) => list().filter((f) => f.signingId === signingId),
    forPlayer: (playerId) => list().filter((f) => f.playerId === playerId),
    forPlayers: (playerIds) => list().filter((f) => (playerIds ?? []).includes(f.playerId)),
  };
}

function outcomeQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((r) => r.id === id) ?? null,
    forFollowUp: (followUpId) => list().find((r) => r.followUpId === followUpId) ?? null,
    forPlayer: (playerId) => list().filter((r) => r.playerId === playerId),
  };
}

function requestQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((r) => r.id === id) ?? null,
    forOrg: (orgId) => list().filter((r) => r.orgId === orgId),
    forPlayer: (playerId) => list().filter((r) => r.playerId === playerId),
    forPlayers: (playerIds) => list().filter((r) => (playerIds ?? []).includes(r.playerId)),
    forOrgPlayer: (orgId, playerId) => list().filter((r) => r.orgId === orgId && r.playerId === playerId),
    forCase: (caseId) => list().filter((r) => r.caseId === caseId),
    countForOrg: (orgId) => list().filter((r) => r.orgId === orgId).length,
  };
}

function trialQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((t) => t.id === id) ?? null,
    forOrg: (orgId) => list().filter((t) => t.orgId === orgId),
    forOrgStatus: (orgId, status) => list().filter((t) => t.orgId === orgId && t.status === status),
    forPlayer: (playerId) => list().filter((t) => t.playerId === playerId),
    forPlayers: (playerIds) => list().filter((t) => (playerIds ?? []).includes(t.playerId)),
    forOrgPlayer: (orgId, playerId) => list().filter((t) => t.orgId === orgId && t.playerId === playerId),
    forCase: (caseId) => list().filter((t) => t.caseId === caseId),
  };
}

function caseQueries(rows, handoffAgent = (c) => c.transactionHandoff?.invitedAgentUserId) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((c) => c.id === id) ?? null,
    forOrg: (orgId) => list().filter((c) => c.orgId === orgId),
    forPlayer: (playerId) => list().filter((c) => c.playerId === playerId),
    forOrgPlayer: (orgId, playerId) => list().filter((c) => c.orgId === orgId && c.playerId === playerId),
    forHandoffAgent: (agentUserId) => list().filter((c) => handoffAgent(c) === agentUserId),
    withRoom: () => list().filter((c) => c.room),
    roomCount: () => list().filter((c) => c.room).length,
    countForOrg: (orgId) => list().filter((c) => c.orgId === orgId).length,
  };
}

function roomRowQueries(rows, { orgPlayer = false } = {}) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((r) => r.id === id) ?? null,
    forRoom: (roomId) => list().filter((r) => r.roomId === roomId),
    ...(orgPlayer ? { forOrgPlayer: (orgId, playerId) => list().filter((r) => r.orgId === orgId && r.playerId === playerId), forOrg: (orgId) => list().filter((r) => r.orgId === orgId) } : {}),
  };
}

/** The `recruitmentReads` shape over a plain database's arrays (an absent or non-array collection gives no queries). */
/** The S9a evidence queries (scoutingReads.evidence) over a plain array, in array order. */
function evidenceQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((e) => e.id === id) ?? null,
    forPlayer: (playerId) => list().filter((e) => e.playerId === playerId),
    currentForPlayer: (playerId) => list().filter((e) => e.playerId === playerId && !e.supersededBy),
  };
}

/** The S9b assessment queries (scoutingReads.assessments) over a plain array, in array order. */
function assessmentQueries(rows) {
  const list = () => rows.filter(sound);
  return {
    byId: (id) => list().find((a) => a.id === id) ?? null,
    forOrg: (orgId) => list().filter((a) => a.orgId === orgId),
    forOrgPlayer: (orgId, playerId) => list().filter((a) => a.orgId === orgId && a.playerId === playerId),
    forOrgScout: (orgId, userId) => list().filter((a) => a.orgId === orgId && a.scoutUserId === userId),
    forPlayer: (playerId) => list().filter((a) => a.playerId === playerId),
    withFeedbackForPlayer: (playerId) => list().filter((a) => a.playerId === playerId && a.publishedFeedback),
    anyForTrial: (trialId) => list().some((a) => a.context?.trialId === trialId),
  };
}

export function arrayReads(db) {
  const out = {};
  if (Array.isArray(db?.recruitmentContacts)) out.contacts = contactQueries(db.recruitmentContacts);
  if (Array.isArray(db?.recruitmentOffers)) out.offers = offerQueries(db.recruitmentOffers);
  if (Array.isArray(db?.signingPackages)) out.signingPackages = packageQueries(db.signingPackages);
  if (Array.isArray(db?.signings)) out.signings = signingQueries(db.signings);
  if (Array.isArray(db?.followUps)) out.followUps = followUpQueries(db.followUps);
  if (Array.isArray(db?.outcomeReports)) out.outcomeReports = outcomeQueries(db.outcomeReports);
  if (Array.isArray(db?.requests)) out.requests = requestQueries(db.requests);
  if (Array.isArray(db?.trials)) out.trials = trialQueries(db.trials);
  if (Array.isArray(db?.recruitmentCases)) out.cases = caseQueries(db.recruitmentCases);
  if (Array.isArray(db?.roomComments)) out.comments = roomRowQueries(db.roomComments);
  if (Array.isArray(db?.roomSnapshots)) out.snapshots = roomRowQueries(db.roomSnapshots);
  if (Array.isArray(db?.roomDecisions)) out.decisions = roomRowQueries(db.roomDecisions, { orgPlayer: true });
  if (Array.isArray(db?.roomEvidenceState)) out.evidenceStates = roomRowQueries(db.roomEvidenceState);
  if (Array.isArray(db?.evidence)) out.evidence = evidenceQueries(db.evidence);
  if (Array.isArray(db?.assessments)) out.assessments = assessmentQueries(db.assessments);
  return out;
}

/** `buildRecruitmentJourney` over a plain database: `opts.reads` defaults to the database's own arrays. */
export const buildRecruitmentJourney = (db, caseId, viewer, opts = {}) => journey(db, caseId, viewer, { reads: arrayReads(db), ...opts });

/** `createEvidenceProvider` over a plain database: `reads` defaults to the database's own arrays. */
export const createEvidenceProvider = (db, reads = arrayReads(db)) => provider(db, reads);

/** `buildReportingContext` over a plain database: `reads` defaults to the database's own arrays. */
export const buildReportingContext = (args) => reportingContext({ reads: arrayReads(args?.db), ...args });

// The M21 evidence links and the M23 decision evidence over a plain database: `reads` defaults to its own arrays.
export const resolveEvidenceLink = (link, opts = {}) => resolveLink(link, { reads: arrayReads(opts.db), ...opts });
export const recordBelongsToPlayer = (opts = {}) => belongs({ reads: arrayReads(opts.db), ...opts });
export const validateEvidenceLink = (opts = {}) => validateLink({ reads: arrayReads(opts.db), ...opts });
export const resolveEvidenceRefs = (refs, opts = {}) => resolveRefs(refs, { reads: arrayReads(opts.db), ...opts });
export const evidenceCandidates = (opts = {}) => candidates({ reads: arrayReads(opts.db), ...opts });
// S12a: a plan's own records are the development repository's, so give `collected` ({ plan, goals, actions, links, reviews }).
export const buildDevelopmentPlan = (opts = {}) => buildPlan({ reads: arrayReads(opts.db), ...opts });
