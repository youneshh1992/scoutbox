// Test helper (§4.3 step 2). The server reads the contacts and offers through SQL (the contacts/offers repository's
// queries, `recruitmentReads`); the pure projectors and providers take those queries as `reads`. The batteries that
// exercise the projectors directly build plain in-memory databases, so this helper answers the same queries over the
// plain `recruitmentContacts` / `recruitmentOffers` arrays of such a database, in array order (the tables' rowid order).
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

/** The `recruitmentReads` shape over a plain database's arrays (an absent or non-array collection gives no queries). */
export function arrayReads(db) {
  const out = {};
  if (Array.isArray(db?.recruitmentContacts)) out.contacts = contactQueries(db.recruitmentContacts);
  if (Array.isArray(db?.recruitmentOffers)) out.offers = offerQueries(db.recruitmentOffers);
  return out;
}

/** `buildRecruitmentJourney` over a plain database: `opts.reads` defaults to the database's own arrays. */
export const buildRecruitmentJourney = (db, caseId, viewer, opts = {}) => journey(db, caseId, viewer, { reads: arrayReads(db), ...opts });

/** `createEvidenceProvider` over a plain database: `reads` defaults to the database's own arrays. */
export const createEvidenceProvider = (db, reads = arrayReads(db)) => provider(db, reads);

/** `buildReportingContext` over a plain database: `reads` defaults to the database's own arrays. */
export const buildReportingContext = (args) => reportingContext({ reads: arrayReads(args?.db), ...args });
