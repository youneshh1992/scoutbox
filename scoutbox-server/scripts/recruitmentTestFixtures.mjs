// S8a-core test fixtures: requests and trials in the EXACT shapes the writers produce
// (server.mjs issueRecruitmentRequest / the open-day outcome route / issueAcceptedTrial /
// the report route / tombstoneRequest / tombstoneTrial; m23/trialRoutes.mjs the P4B
// invitation, schedule, cancel, attendance, complete, evidence links, the recipient's
// confirm/decline/cancel; m12/journeys.mjs the day containers; m12/operations.mjs the
// reminder markers). Synthetic ids and names only. Shared by testRecruitment.mjs,
// testRecruitmentServer.mjs and the handoff bench.
import { NOW } from './coreIdentityTestFixtures.mjs';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
export const T = Object.freeze({ invited: NOW - 3 * DAY, accepted: NOW - 2 * DAY, session: NOW + 2 * DAY, sessionEnd: NOW + 2 * DAY + 90 * MIN, filed: NOW - HOUR, removed: NOW });
export const ORG = Object.freeze({ id: 'org-pro', name: 'Eastport FC', type: 'club' });
export const SCOUT = Object.freeze({ userId: 'usr-1', name: 'Maria', role: 'Head of Recruitment' });

/** issueRecruitmentRequest, the legacy direct route (type trial, a date-only invitation): the literal key for key. */
export const legacyTrialRequest = (over = {}) => ({
  id: 'req-legacy', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: ORG.id, orgName: ORG.name, orgType: ORG.type, orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false,
  userId: SCOUT.userId, scoutName: SCOUT.name, scoutRole: SCOUT.role, type: 'trial', message: 'Come and train with us.',
  trialDetails: { proposedDate: '2026-11-01', altSlots: ['2026-11-02'], venue: 'Eastport Ground', notes: 'Bring boots' },
  status: 'pending', createdAt: T.invited, routedTo: 'player', guardianId: null, contactChannel: null, ...over,
});
/** The same writer for a CONTACT (M23 P3: subject and contactId present, trialDetails null). */
export const contactRequest = (over = {}) => ({
  id: 'req-contact', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: ORG.id, orgName: ORG.name, orgType: ORG.type, orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false,
  userId: SCOUT.userId, scoutName: SCOUT.name, scoutRole: SCOUT.role, type: 'contact', message: 'A conversation about next season.', subject: 'Next season', contactId: 'rc-1',
  trialDetails: null, status: 'pending', createdAt: T.invited, routedTo: 'player', guardianId: null, contactChannel: null, ...over,
});
/** The open-day outcome route's literal (no subject/contactId/recipient/keys; trustedPartner may be absent after JSON when the org has no flag). */
export const openDayRequest = (over = {}) => ({
  id: 'req-openday', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: ORG.id, orgName: ORG.name, orgType: ORG.type, orgVerified: true, orgSafeguardingCertified: true,
  userId: SCOUT.userId, scoutName: SCOUT.name, scoutRole: SCOUT.role, type: 'trial', message: 'We liked what we saw at "Open day" — come for a proper trial.',
  trialDetails: { proposedDate: null, altSlots: [], venue: 'Eastport Ground', notes: 'Follow-up from open day "Open day".' },
  status: 'pending', createdAt: T.invited, routedTo: 'player', guardianId: null, contactChannel: null, ...over,
});
export const slot = (id, day, startsAt, over = {}) => ({ id, day, kind: 'training', startsAt, endsAt: startsAt + 90 * MIN, timezone: 'Europe/London', venue: { name: 'Eastport Ground', town: 'Eastport' }, ...over });
/** The P4B invitation (m23/trialRoutes.mjs:395–412): slots, the private details held back until acceptance, caseId, trialId null, recipient, keys.invite. */
export const p4bInvitation = (over = {}) => ({
  ...legacyTrialRequest({ id: 'req-p4b', message: 'Trial invitation.' }),
  trialDetails: { proposedDate: '2026-11-03', altSlots: ['2026-11-04'], venue: 'Eastport Ground, Eastport', notes: '', slots: [slot('tslot-1', '2026-11-03', T.session), slot('tslot-2', '2026-11-04', T.session + DAY)], private: { venueAddress: '1 Harbour Road', instructions: 'Gate B, ask for Maria' } },
  caseId: 'case-1', trialId: null, recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false }, keys: { invite: { key: 'client-key-1', fp: 'fp-1' } }, ...over,
});
/** A minor's P4B invitation routed to the guardian (recipient.guardianId set, routedTo guardian). */
export const minorInvitation = (over = {}) => p4bInvitation({ id: 'req-minor', playerId: 'pl-child1', playerName: 'Child pl-child1', routedTo: 'guardian', guardianId: 'gd-primary', recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-primary', minor: true }, caseId: 'case-2', ...over });
/** The request after the recipient accepted (the respond routes: status, respondedAt, respondedBy, contactChannel; the hook: trialId). */
export const acceptedRequest = (base, trialId, { by = 'player', channel = 'chan-1' } = {}) => ({ ...base, status: 'accepted', respondedAt: T.accepted, respondedBy: by, contactChannel: channel, ...(Object.hasOwn(base, 'trialId') ? { trialId } : {}) });

const who = (kind, id, name) => (kind === 'org' ? { kind, userId: id, name } : { kind, id, name });
export const session = (over = {}) => ({ id: 'tses-1', kind: 'training', startsAt: T.session, endsAt: T.sessionEnd, venue: { name: 'Eastport Ground', town: 'Eastport', address: '1 Harbour Road' }, instructions: 'Gate B, ask for Maria', evidence: [], ...over });
export const evidenceLink = (over = {}) => ({ id: 'tev-1', kind: 'box_cam_session', sessionId: 'box-1', linkedAt: T.accepted + HOUR, linkedBy: who('org', SCOUT.userId, SCOUT.name), removedAt: null, removedBy: null, ...over });
/** issueAcceptedTrial for a concrete P4B slot: born `scheduled`, revision 1 confirmed by the recipient; keys.accept {key: null, fp}; history of two entries. */
export const scheduledTrial = (over = {}) => {
  const s = session();
  const proposedBy = who('org', SCOUT.userId, SCOUT.name); const confirmedBy = who('player', 'pl-adult', 'Adult Signup');
  return {
    id: 'trial-1', requestId: 'req-p4b', caseId: 'case-1', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: ORG.id, orgName: ORG.name, scoutName: SCOUT.name,
    acceptedAt: T.accepted, acceptedBy: 'player', guardianApproved: false, proposedDate: '2026-11-03', venue: 'Eastport Ground, Eastport', notes: '', reportDueAt: T.session + 7 * DAY, status: 'awaiting_report',
    workflowState: 'scheduled',
    schedule: { timezone: 'Europe/London', revision: 1, proposedAt: T.invited, proposedBy, confirmedAt: T.accepted, confirmedBy, sessions: [s], revisions: [{ revision: 1, timezone: 'Europe/London', sessions: [{ ...s }], proposedAt: T.invited, proposedBy, confirmedAt: T.accepted, confirmedBy, supersededAt: null, reason: 'invitation', material: null }] },
    attendance: [], completion: null, recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false, at: T.accepted },
    keys: { accept: { key: null, fp: JSON.stringify({ requestId: 'req-p4b', day: '2026-11-03' }) } },
    history: [{ id: 'aud-1', at: T.accepted, action: 'trial_accepted', by: confirmedBy, detail: { recipientType: 'player', slotId: 'tslot-1', day: '2026-11-03' } }, { id: 'aud-2', at: T.accepted, action: 'trial_schedule_confirmed', by: confirmedBy, detail: { revision: 1, sessionCount: 1 } }],
    reminders: {}, rev: 1, revAt: T.accepted, revBy: null, ...over,
  };
};
/** issueAcceptedTrial for a date-only (legacy) invitation: born `accepted`, no schedule. */
export const acceptedTrial = (over = {}) => scheduledTrial({ id: 'trial-legacy', requestId: 'req-legacy', caseId: null, proposedDate: '2026-11-01', venue: 'Eastport Ground', notes: 'Bring boots', workflowState: 'accepted', schedule: null, keys: { accept: { key: null, fp: JSON.stringify({ requestId: 'req-legacy', day: '2026-11-01' }) } }, history: [{ id: 'aud-3', at: T.accepted, action: 'trial_accepted', by: who('player', 'pl-adult', 'Adult Signup'), detail: { recipientType: 'player', slotId: null, day: '2026-11-01' } }], ...over });
/** A trial written BEFORE the P4B containers existed (M12): no workflowState, schedule, attendance, completion, recipient, keys, history, reminders, rev — `isLegacyTrial` reads it as legacy_accepted. */
export const preP4bTrial = (over = {}) => ({ id: 'trial-old', requestId: 'req-old', caseId: null, playerId: 'pl-adult', playerName: 'Adult Signup', orgId: ORG.id, orgName: ORG.name, scoutName: SCOUT.name, acceptedAt: T.accepted - 30 * DAY, acceptedBy: 'player', guardianApproved: false, proposedDate: '2026-09-01', venue: 'Old ground', notes: '', reportDueAt: T.accepted - 20 * DAY, status: 'reported', report: report({ id: 'rep-old', trialId: 'trial-old', filedAt: T.accepted - 25 * DAY }), ...over });
/** The report route's literal (TRIAL_REPORT_FIELDS in order, notes '' default, the two feedback notes). */
export const report = (over = {}) => ({ id: 'rep-1', trialId: 'trial-1', playerId: 'pl-adult', orgId: ORG.id, orgName: ORG.name, userId: SCOUT.userId, scoutName: SCOUT.name, filedAt: T.filed, acceleration: 7, sprintSpeedKmh: 31, distanceKm: 6.2, passCompletionPct: 78, duelSuccessPct: 55, coachRating: 8, notes: 'Quick feet.', strengthNote: 'Pace', focusNote: 'Left foot', ...over });
/** The day container (m12/journeys.mjs:534) once the club worked on the trial day: staff with a filed check, a consent, a check-in, a status event, arrival/emergency/collection. */
export const dayContainer = (over = {}) => ({
  staff: [{ id: 'stf-1', name: 'Coach Dan', role: 'Lead coach', check: { kind: 'DBS (England & Wales)', ref: 'DBS-001', status: 'pending', expiresAt: '2027-01-01', reviewedBy: null }, addedBy: SCOUT.name, addedAt: T.accepted + HOUR }, { id: 'stf-2', name: 'Physio Pat', role: 'Physio', check: null, addedBy: SCOUT.name, addedAt: T.accepted + 2 * HOUR }],
  consents: [{ id: 'cns-1', by: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, scope: 'player_event_consent', at: T.accepted + 3 * HOUR }],
  arrival: { time: '09:30', address: '1 Harbour Road', notes: 'Use the side gate' }, emergency: { name: 'Next of kin', phone: '+44 7000 000000', setBy: 'player', at: T.accepted + 4 * HOUR },
  checkins: [{ playerId: 'pl-adult', at: T.session, byUserId: SCOUT.userId, byName: SCOUT.name }], collection: { policy: 'Collected by a named adult' },
  statusEvents: [{ kind: 'postponed', at: T.accepted + 5 * HOUR, by: SCOUT.name, reason: 'Pitch waterlogged', newDate: '2026-11-05' }], ...over,
});
/** A fully worked trial: schedule revision 2, an evidence link (one removed), attendance, completion, the day container, a report, reminder markers, lifecycle, keys lists, rev 4. */
export const workedTrial = (over = {}) => {
  const base = scheduledTrial();
  const s2 = session({ id: 'tses-2', startsAt: T.session + DAY, endsAt: T.sessionEnd + DAY, evidence: [evidenceLink(), evidenceLink({ id: 'tev-2', sessionId: 'box-2', removedAt: T.accepted + 2 * HOUR, removedBy: who('org', SCOUT.userId, SCOUT.name) })] });
  const orgBy = who('org', SCOUT.userId, SCOUT.name);
  return {
    ...base, status: 'reported', reminderSent: true, feedbackEscalatedAt: T.filed - HOUR, report: report(), day: dayContainer(), workflowState: 'completed',
    schedule: { ...base.schedule, revision: 2, proposedAt: T.accepted + HOUR, proposedBy: orgBy, confirmedAt: T.accepted + 2 * HOUR, confirmedBy: base.schedule.confirmedBy, declinedAt: null, declinedBy: null, sessions: [s2], revisions: [...base.schedule.revisions, { revision: 2, timezone: 'Europe/London', sessions: [{ ...s2, evidence: [] }], proposedAt: T.accepted + HOUR, proposedBy: orgBy, confirmedAt: T.accepted + 2 * HOUR, confirmedBy: base.schedule.confirmedBy, supersededAt: null, reason: 'Pitch change', material: true }] },
    attendance: [{ sessionId: 'tses-2', state: 'attended', source: 'manual', recordedBy: orgBy, recordedAt: T.sessionEnd + DAY, note: 'Full session' }],
    completion: { state: 'completed', at: T.sessionEnd + DAY + HOUR, by: orgBy, reason: null, phase: 'scheduled' },
    keys: { ...base.keys, schedule: [{ key: 'k-sched-1', fp: 'fp-s1', at: T.accepted + HOUR }], attendance: [{ key: 'k-att-1', fp: 'fp-a1', at: T.sessionEnd + DAY }], complete: [{ key: 'k-comp-1', fp: 'fp-c1', at: T.sessionEnd + DAY + HOUR }], link: [{ key: 'k-link-1', fp: 'fp-l1', at: T.accepted + HOUR }] },
    history: [...base.history, { id: 'aud-4', at: T.accepted + HOUR, action: 'trial_rescheduled', by: orgBy, detail: { revision: 2 } }, { id: 'aud-5', at: T.sessionEnd + DAY + HOUR, action: 'trial_completed', by: orgBy, detail: null }],
    reminders: { 't48:tses-2:2': T.session + DAY - 48 * HOUR, completionPending: T.sessionEnd + DAY + 25 * HOUR }, lifecycle: { applied: true, from: 'trial_scheduled', to: 'trial_completed', at: T.sessionEnd + DAY + HOUR },
    rev: 4, revAt: T.sessionEnd + DAY + HOUR, revBy: { userId: SCOUT.userId, name: SCOUT.name }, ...over,
  };
};
/** The recipient cancelled (trialRoutes.mjs:978): completion by the recipient, cancelledBy the kind. */
export const cancelledTrial = (over = {}) => scheduledTrial({ id: 'trial-cancelled', requestId: 'req-cancelled', workflowState: 'cancelled', completion: { state: 'cancelled', at: T.accepted + DAY, by: who('player', 'pl-adult', 'Adult Signup'), reason: 'Injured', phase: 'scheduled', cancelledBy: 'player' }, keys: { accept: { key: null, fp: 'fp-x' }, cancel: [{ key: 'k-cancel-1', fp: 'fp-cx', at: T.accepted + DAY }] }, rev: 2, revAt: T.accepted + DAY, revBy: null, ...over });

/** The recruitmentCases blob entries the strict case references (Q7b) resolve against: ids only matter here. */
/** The cases the strict case references (Q7b) resolve against: since S8b (migration 0016) a table-backed collection imported on the same run, so each is a full case literal (m12/scouting.mjs:450) with EMPTY links — these fixtures vary the requests and trials freely and a case link would have to name one of them. */
const caseLiteral = (over) => ({ id: 'case-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Adult Signup', vacancyId: null, ownerUserId: SCOUT.userId, ownerName: SCOUT.name, stage: 'trial', priority: 'medium', deadline: null, restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null }, createdAt: T.invited - DAY, history: [], room: null, budget: null, ...over });
export const CASES = () => [caseLiteral({ id: 'case-1' }), caseLiteral({ id: 'case-2', playerId: 'pl-child1', playerName: 'Child pl-child1' })];

/** JSON-persisted shape (what the blob held): a live `undefined` is absence. */
export const persisted = (v) => JSON.parse(JSON.stringify(v));
