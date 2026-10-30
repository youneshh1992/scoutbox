// S8d test fixtures: signing packages, completed signings, follow-ups and outcome reports in the EXACT shapes the
// writers produce (m29/index.mjs the start :412-425, the ready :506-509, the party completion :552-557, the completion
// :636-652, the cancel/void :682-685, the supersede :712-721, the T&S void :830; m29/signing.mjs:471
// completedSigningRecord and the legacy literal at m29/index.mjs:280-284; m12/operations.mjs the follow-up :33-37, the
// report :69-78, the confirmation :97-101). Synthetic ids and names only. The ids agree with the S8a–S8c fixtures:
// case-1 is the room of pl-adult with the draft offer rof-1 (revision rofr-1); org-pro, staff usr-1 (Maria).
import { NOW } from './coreIdentityTestFixtures.mjs';
import { ORG, SCOUT } from './recruitmentTestFixtures.mjs';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
export const T = Object.freeze({ started: NOW - 10 * DAY, attached: NOW - 9 * DAY, ready: NOW - 8 * DAY, player: NOW - 7 * DAY, club: NOW - 6 * DAY, completed: NOW - 5 * DAY, legacy: NOW - 200 * DAY });
export const BY = Object.freeze({ kind: 'org', id: SCOUT.userId, name: SCOUT.name, role: SCOUT.role }); // m29/index.mjs:84 byOrg(req)
export const SHA = 'a'.repeat(64);
export const SHA2 = 'b'.repeat(64);

/** m29/index.mjs:85 hist() — a package history entry. */
export const shist = (id, at, action, detail = null, by = BY) => ({ id, at, action, by: { kind: by.kind, id: by.id ?? null, name: by.name ?? null }, detail });
/** m29/index.mjs:190 storeDocument() — the document object on a revision. */
export const sdoc = (id, over = {}) => ({ id, evidenceId: 'ver-sgn-1', sha256: SHA, filename: 'contract.pdf', mime: 'application/pdf', bytes: 4321, label: 'Contract', uploadedAt: T.attached, uploadedBy: BY, ...over });
/** m29/signing.mjs:113 requiredPartiesFor() for an adult recipient. */
export const parties = (over = {}) => [
  { partyType: 'PLAYER', forEntityId: 'pl-adult', forPlayerId: 'pl-adult', status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null, ...(over.PLAYER ?? {}) },
  { partyType: 'CLUB_SIGNATORY', forEntityId: ORG.id, forPlayerId: 'pl-adult', status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null, ...(over.CLUB_SIGNATORY ?? {}) },
];
/** m29/index.mjs:412-418 — revision 1 as the start route builds it. */
export const srevision = (over = {}) => ({
  id: 'spr-1', revisionNumber: 1, status: 'DRAFT', createdAt: T.started, createdBy: BY, readyAt: null, readyBy: null, completedAt: null,
  document: null, executedDocument: null, contract: { startDate: '2027-07-01', endDate: '2028-06-30' },
  requiredParties: parties(), policySnapshot: { policyVersion: 1, jurisdiction: 'GB', offerPolicyVersion: 1 },
  supersedesRevisionId: null, supersededByRevisionId: null, ...over,
});
/** m29/index.mjs:419-425 — the package literal of the start route (history pushed right after). */
export const draftPackage = (over = {}) => ({
  id: 'spk-1', orgId: ORG.id, caseId: 'case-1', playerId: 'pl-adult', offerId: 'rof-1', offerRevisionId: 'rofr-1', transactionId: null,
  status: 'DRAFT', currentRevisionId: 'spr-1', revisions: [srevision()], expiresAt: T.started + 30 * DAY, internalNote: 'Internal: agreed verbally.',
  keys: { start: { key: 'k-start-1', fp: '{"contract":{"endDate":"2028-06-30","startDate":"2027-07-01"},"expiresAt":null,"internalNote":"Internal: agreed verbally.","offerId":"rof-1"}' }, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] },
  history: [shist('aud-sp1', T.started, 'signing_created', { revisionId: 'spr-1', offerId: 'rof-1', offerRevisionId: 'rofr-1' })], completion: null, cancelledAt: null, cancelledBy: null, cancelReason: null, voidedAt: null, voidedBy: null, voidReason: null,
  createdAt: T.started, createdBy: BY, updatedAt: T.started, rev: 1, revAt: T.started, revBy: { userId: BY.id, name: BY.name }, policyVersion: 1, ...over,
});
const evidence = (id, actorKind, actorId, at) => ({ kind: 'platform_acknowledgment', id, revisionId: 'spr-1', documentSha256: SHA, at, actorKind, actorId, session: 'authenticated' });
/** A COMPLETED package (both parties signed, the completion recorded) with its signing row. */
export const completedPackage = (over = {}) => draftPackage({
  id: 'spk-2', status: 'COMPLETED', currentRevisionId: 'spr-2',
  revisions: [srevision({ id: 'spr-2', status: 'COMPLETED', readyAt: T.ready, readyBy: BY, completedAt: T.completed, completedBy: BY, document: sdoc('sgd-1'), executedDocument: sdoc('sgx-1', { evidenceId: 'ver-sgn-2', sha256: SHA2, label: 'Executed' }),
    requiredParties: parties({ PLAYER: { status: 'COMPLETED', completedAt: T.player, completedBy: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, evidenceRef: evidence('sgev-1', 'player', 'pl-adult', T.player), method: 'PLATFORM_ACKNOWLEDGMENT' }, CLUB_SIGNATORY: { status: 'COMPLETED', completedAt: T.club, completedBy: { kind: 'org', id: BY.id, name: BY.name }, evidenceRef: evidence('sgev-2', 'org', BY.id, T.club), method: 'PLATFORM_ACKNOWLEDGMENT' } }) })],
  keys: { start: { key: 'k-start-2', fp: 'fp' }, ready: [{ key: 'k-ready-2', fp: '{"expiresAt":null}', revisionId: 'spr-2', at: T.ready }], party: [{ key: 'k-party-p', fp: 'fpp', actorId: 'pl-adult', revisionId: 'spr-2', at: T.player }, { key: 'k-party-c', fp: 'fpc', actorId: BY.id, revisionId: 'spr-2', at: T.club }], cancel: [], void: [], supersede: [], complete: [{ key: 'k-complete-2', fp: '{"complete":true}', signingId: 'sign-2', at: T.completed }] },
  history: [shist('aud-sp2', T.started, 'signing_created', { revisionId: 'spr-2', offerId: 'rof-1', offerRevisionId: 'rofr-1' }), shist('aud-sp3', T.ready, 'signing_ready', { revisionId: 'spr-2', sha256: SHA }), shist('aud-sp4', T.player, 'signing_party_completed', { revisionId: 'spr-2', partyType: 'PLAYER', sha256: SHA }, { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }), shist('aud-sp5', T.completed, 'signing_completed', { revisionId: 'spr-2', signingId: 'sign-2', sha256: SHA })],
  completion: { signingId: 'sign-2', completedAt: T.completed, completedBy: BY, contract: { startDate: '2027-07-01', endDate: '2028-06-30' }, documentSha256: SHA, lifecycle: { from: 'offer_accepted', to: 'signed', at: T.completed } },
  updatedAt: T.completed, rev: 5, revAt: T.completed, ...over,
});
/** m29/signing.mjs:471 completedSigningRecord for spk-2. */
export const canonicalSigning = (over = {}) => ({
  id: 'sign-2', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: ORG.id, orgName: ORG.name, userId: BY.id, scoutName: BY.name, ts: T.completed, signedAt: T.completed,
  firstQualifyingInteraction: { id: 'led-1', ts: T.started - DAY, type: 'view', playerId: 'pl-adult', orgId: ORG.id, orgName: ORG.name, userId: BY.id, scoutName: BY.name }, attributionWindowMonths: 18, insideAttributionWindow: true,
  method: 'CANONICAL_COMPLETION', signingPackageId: 'spk-2', signingRevisionId: 'spr-2', signingRevisionNumber: 1, caseId: 'case-1', offerId: 'rof-1', offerRevisionId: 'rofr-1', transactionId: null,
  documentSha256: SHA, documentEvidenceId: 'ver-sgn-1', executedDocumentEvidenceId: 'ver-sgn-2', contract: { startDate: '2027-07-01', endDate: '2028-06-30' },
  parties: [{ partyType: 'PLAYER', method: 'PLATFORM_ACKNOWLEDGMENT', completedAt: T.player, byKind: 'player' }, { partyType: 'CLUB_SIGNATORY', method: 'PLATFORM_ACKNOWLEDGMENT', completedAt: T.club, byKind: 'org' }], policyVersion: 1, ...over,
});
/** m29/index.mjs:280-284 — the legacy literal (a recruitment that never went through an Offer), as a pre-M29 file holds it: no method, no contract. */
export const legacySigning = (over = {}) => ({
  id: 'sign-legacy', playerId: 'pl-child1', playerName: 'Kid One', orgId: ORG.id, orgName: ORG.name, userId: BY.id, scoutName: BY.name,
  ts: T.legacy, signedAt: T.legacy, firstQualifyingInteraction: null, attributionWindowMonths: 18, insideAttributionWindow: false, note: 'Signed at the open day.', ...over,
});
/** m12/operations.mjs:33-37 scheduleFollowUps for sign-2 (3m due, the others scheduled). */
export const followUpsFor = (signingId = 'sign-2', playerId = 'pl-adult', signedAt = T.completed) => [
  { id: `fup-${signingId}-3m`, signingId, playerId, orgId: ORG.id, milestone: '3m', dueAt: signedAt + 91 * DAY, status: 'due', notifiedAt: signedAt + 91 * DAY + MIN, createdAt: signedAt + HOUR },
  { id: `fup-${signingId}-6m`, signingId, playerId, orgId: ORG.id, milestone: '6m', dueAt: signedAt + 182 * DAY, status: 'scheduled', notifiedAt: null, createdAt: signedAt + HOUR },
  { id: `fup-${signingId}-12m`, signingId, playerId, orgId: ORG.id, milestone: '12m', dueAt: signedAt + 365 * DAY, status: 'scheduled', notifiedAt: null, createdAt: signedAt + HOUR },
];
/** m12/operations.mjs:69-78 the report, :97-101 a confirmation. */
export const outcomeReport = (over = {}) => ({
  id: 'out-1', followUpId: 'fup-sign-2-3m', signingId: 'sign-2', playerId: 'pl-adult', orgId: ORG.id, by: { kind: 'org', id: BY.id, name: BY.name },
  registrationStatus: 'registered', matchesPlayed: 7, progression: 'Regular starter', endReason: null, note: null, status: 'confirmed',
  confirmations: [{ by: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, agree: true, note: 'All good.', experienceRating: 5, at: T.completed + 92 * DAY }], at: T.completed + 91 * DAY + 2 * HOUR, ...over,
});
/** The four collections as a 9fb1bc6 file holds them. */
export const S8D_FIX = () => ({
  signingPackages: [draftPackage(), completedPackage()],
  signings: [canonicalSigning(), legacySigning()],
  followUps: [...followUpsFor()].map((f) => (f.milestone === '3m' ? { ...f, status: 'complete' } : f)),
  outcomeReports: [outcomeReport()],
});
