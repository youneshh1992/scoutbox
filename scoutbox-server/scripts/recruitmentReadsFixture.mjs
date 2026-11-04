// Test helper (§4.3 step 2). The server reads the contacts, offers, signing packages, signings, follow-ups and outcome
// reports through SQL (the repositories' queries, `recruitmentReads`); the pure projectors and providers take those
// queries as `reads`. The batteries that exercise the projectors directly build plain in-memory databases, so this
// helper answers the same queries over the plain arrays of such a database, in array order (the tables' rowid order).
//
// A database WITHOUT one of the arrays gets no query object for it, exactly as the old code saw no collection: the
// journey reports the missing contacts store, the evidence provider answers "store unavailable", and the offers stay
// the optional phase they always were.
import { buildRecruitmentJourney as journey } from '../m23/journey.mjs';
import { createEvidenceProvider as provider } from '../m23/evidence.mjs';
import { buildReportingContext as reportingContext } from '../m20/dashboard.mjs';

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

/** The `recruitmentReads` shape over a plain database's arrays (an absent or non-array collection gives no queries). */
export function arrayReads(db) {
  const out = {};
  if (Array.isArray(db?.recruitmentContacts)) out.contacts = contactQueries(db.recruitmentContacts);
  if (Array.isArray(db?.recruitmentOffers)) out.offers = offerQueries(db.recruitmentOffers);
  if (Array.isArray(db?.signingPackages)) out.signingPackages = packageQueries(db.signingPackages);
  if (Array.isArray(db?.signings)) out.signings = signingQueries(db.signings);
  if (Array.isArray(db?.followUps)) out.followUps = followUpQueries(db.followUps);
  if (Array.isArray(db?.outcomeReports)) out.outcomeReports = outcomeQueries(db.outcomeReports);
  return out;
}

/** `buildRecruitmentJourney` over a plain database: `opts.reads` defaults to the database's own arrays. */
export const buildRecruitmentJourney = (db, caseId, viewer, opts = {}) => journey(db, caseId, viewer, { reads: arrayReads(db), ...opts });

/** `createEvidenceProvider` over a plain database: `reads` defaults to the database's own arrays. */
export const createEvidenceProvider = (db, reads = arrayReads(db)) => provider(db, reads);

/** `buildReportingContext` over a plain database: `reads` defaults to the database's own arrays. */
export const buildReportingContext = (args) => reportingContext({ reads: arrayReads(args?.db), ...args });
