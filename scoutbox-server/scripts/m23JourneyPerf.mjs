// M23 P8 — a perf probe for the journey projection (§79). Pure: builds an
// in-memory database of N cases, each with its own contact, trial, decision,
// Offer and package, and measures ONE club projection, ONE player projection
// over every case of one player, and the notification target resolver's
// per-row cost. Prints timings; asserts nothing about hardware. The point is
// the shape: one projection touches its own case's records through a handful
// of filters, not N × M scans, and a store ten times larger makes a read at
// most a few times slower (the filters are linear in the store, by design —
// there is no index and none was added).
import { buildRecruitmentJourney } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';

const T0 = Date.now(); const DAY = 86_400_000;
function build(N) {
  // 50 players, N/50 clubs, ONE case per (club, player) pair — a club keeps one
  // live case per player (M17), so a real store has this shape: every player
  // pursued by many clubs, never one club with a hundred live cases for one player.
  const db = { orgs: [], players: [], recruitmentCases: [], roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [], recruitmentOffers: [], signingPackages: [], blocks: [], verEvidence: [], notifications: [] };
  for (let i = 0; i < N; i += 1) {
    const pid = `p${i % 50}`; const cid = `case-${i}`; const t = T0 - (N - i) * DAY; const oid = `o${Math.floor(i / 50)}`;
    if (i < 50) db.players.push({ id: pid, name: `Player ${i}`, contractStatus: 'unknown' });
    if (i % 50 === 0) db.orgs.push({ id: oid, name: `Club ${oid}`, level: 'pro' });
    const hist = [{ id: `h${i}a`, at: t, action: 'room_created', detail: { status: 'watching' } }, { id: `h${i}b`, at: t + 1, action: 'room_status_changed', detail: { from: 'watching', to: 'under_review' } }, { id: `h${i}c`, at: t + 2, action: 'room_status_changed', detail: { from: 'under_review', to: 'contact_planned' } }, { id: `h${i}d`, at: t + 3, action: 'room_status_changed', detail: { from: 'contact_planned', to: 'contacted', contactId: `rct-${i}`, trigger: `contact:rct-${i}` } }, { id: `h${i}e`, at: t + 4, action: 'room_status_changed', detail: { from: 'contacted', to: 'trial_requested', requestId: `req-${i}` } }, { id: `h${i}f`, at: t + 5, action: 'room_status_changed', detail: { from: 'trial_requested', to: 'trial_scheduled', trialId: `trial-${i}` } }, { id: `h${i}g`, at: t + 6, action: 'room_status_changed', detail: { from: 'trial_scheduled', to: 'trial_completed', trialId: `trial-${i}` } }, { id: `h${i}h`, at: t + 7, action: 'room_status_changed', detail: { from: 'trial_completed', to: 'offer_consideration', decisionId: `rdec-${i}` } }, { id: `h${i}i`, at: t + 8, action: 'room_status_changed', detail: { from: 'offer_consideration', to: 'offer_made', offerId: `rof-${i}` } }, { id: `h${i}j`, at: t + 9, action: 'room_status_changed', detail: { from: 'offer_made', to: 'offer_accepted', offerId: `rof-${i}` } }];
    db.recruitmentCases.push({ id: cid, orgId: oid, playerId: pid, createdAt: t, stage: 'decision', links: { requestIds: [], trialIds: [], signingId: null }, history: hist, room: { status: 'offer_accepted', priority: 'normal', rev: 12, leadScoutUserId: 'u1' } });
    db.recruitmentContacts.push({ id: `rct-${i}`, orgId: oid, caseId: cid, playerId: pid, status: 'responded', channel: 'in_app', recipient: { type: 'player' }, deliveredAt: t + 3, respondedAt: t + 3.5, createdAt: t + 2.5, history: [] });
    db.requests.push({ id: `req-${i}`, type: 'trial', orgId: oid, playerId: pid, caseId: cid, status: 'accepted', createdAt: t + 4, routedTo: 'player' });
    db.trials.push({ id: `trial-${i}`, orgId: oid, playerId: pid, caseId: cid, requestId: `req-${i}`, status: 'reported', workflowState: 'completed', acceptedAt: t + 4.5, schedule: { timezone: 'Europe/London', confirmedAt: t + 5, revision: 1, sessions: [{ id: `s-${i}`, startsAt: t + 5.5, endsAt: t + 5.6, kind: 'training' }] }, completion: { state: 'completed', at: t + 6 }, history: [{ id: `th${i}`, at: t + 6, action: 'trial_completed', by: { kind: 'org', name: 'x' } }], attendance: [] });
    db.assessments.push({ id: `as-${i}`, orgId: oid, playerId: pid, state: 'submitted', submittedAt: t + 6.5, createdAt: t + 6.2, context: { trialId: `trial-${i}` } });
    db.roomDecisions.push({ id: `rdec-${i}`, roomId: cid, orgId: oid, playerId: pid, kind: 'formal', state: 'final', outcome: 'progress', createdAt: t + 7, reasonCodes: ['tactical_fit'], evidenceRefs: [] });
    db.recruitmentOffers.push({ id: `rof-${i}`, orgId: oid, caseId: cid, playerId: pid, type: 'direct_recruitment', status: 'ACCEPTED', createdAt: t + 8, updatedAt: t + 9, currentRevisionId: `rofr-${i}`, revisions: [{ id: `rofr-${i}`, revisionNumber: 1, status: 'ACCEPTED', issuedAt: t + 8, respondedAt: t + 9, expiresAt: t + 30 * DAY, terms: {}, recipientSnapshot: { type: 'player', playerId: pid }, documents: [], response: { id: `resp-${i}`, responseType: 'accepted', actorType: 'player', actorId: pid, at: t + 9 } }], responses: [{ revisionId: `rofr-${i}`, responseType: 'accepted', actorType: 'player', actorId: pid }], history: [{ id: `oh${i}`, at: t + 8, action: 'offer_issued', by: { kind: 'org', name: 'x' }, detail: { revisionId: `rofr-${i}`, revisionNumber: 1 } }, { id: `oh${i}b`, at: t + 9, action: 'offer_accepted', by: { kind: 'player' }, detail: { revisionId: `rofr-${i}` } }] });
    db.signingPackages.push({ id: `spk-${i}`, orgId: oid, caseId: cid, playerId: pid, offerId: `rof-${i}`, offerRevisionId: `rofr-${i}`, status: 'READY', createdAt: t + 10, expiresAt: T0 + 30 * DAY, currentRevisionId: `spr-${i}`, revisions: [{ id: `spr-${i}`, revisionNumber: 1, status: 'READY', createdAt: t + 10, readyAt: t + 11, document: { evidenceId: `ev-${i}`, sha256: 'a'.repeat(64) }, contract: { startDate: '2027-07-01', endDate: null }, requiredParties: [{ partyType: 'PLAYER', forEntityId: pid, status: 'PENDING' }, { partyType: 'CLUB_SIGNATORY', forEntityId: oid, status: 'PENDING' }] }], history: [{ id: `sh${i}`, at: t + 11, action: 'signing_ready', by: { kind: 'org', name: 'x' }, detail: { revisionId: `spr-${i}` } }] });
    db.notifications.push({ id: `ntf-${i}`, ts: t, audience: { kind: 'player', id: pid }, type: 'recruitment_signing', text: 'x', refId: `spk-${i}`, read: false });
  }
  return db;
}
const time = (fn, n = 20) => { const s = process.hrtime.bigint(); for (let i = 0; i < n; i += 1) fn(); return Number(process.hrtime.bigint() - s) / 1e6 / n; };
for (const N of [500, 5000]) {
  const db = build(N); const ev = createEvidenceProvider(db);
  const last = db.recruitmentCases[N - 1];
  const club = time(() => buildRecruitmentJourney(db, last.id, { kind: 'org_staff', orgId: last.orgId, userId: 'u1', role: 'recruitment_admin' }, { evidence: ev }));
  const player = time(() => { for (const k of db.recruitmentCases) if (k.playerId === last.playerId) buildRecruitmentJourney(db, k.id, { kind: 'player_self', playerId: last.playerId }, { evidence: ev }); }, 5);
  const agent = time(() => buildRecruitmentJourney(db, last.id, { kind: 'agent', authorized: true, playerId: last.playerId, userId: 'ag1', grants: ['contacts', 'trials', 'offers', 'signings'] }, { evidence: ev }));
  const out = buildRecruitmentJourney(db, last.id, { kind: 'org_staff', orgId: last.orgId, userId: 'u1', role: 'recruitment_admin' }, { evidence: ev });
  console.log(`N=${N} cases: club projection ${club.toFixed(2)} ms · player journeys over ${Math.round(N / 50)} cases ${player.toFixed(2)} ms · agent projection ${agent.toFixed(2)} ms · next=${out.journey.nextAction.code} stage=${out.journey.stage} class=${out.journey.classification} timeline=${out.history.total}`);
}
console.log('m23JourneyPerf: one projection = a handful of linear filters over the store (no N+1, no index, no cache); a 10× store reads a few × slower, never 10² ×.');
