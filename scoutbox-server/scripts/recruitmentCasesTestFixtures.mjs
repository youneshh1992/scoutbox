// Test fixtures: recruitment cases (with the room facet), room comments, room snapshots, room decisions and room
// evidence states in the EXACT shapes the writers produce, each one a record the typed tables hold. Synthetic ids and
// names only. Shared by testRecruitmentCases.mjs and testRecruitmentCasesServer.mjs. The ids agree with
// recruitmentTestFixtures.mjs: case-1 is the room of pl-adult that req-p4b / trial-1 name, case-2 the case of
// pl-child1 that req-minor names.
import { NOW } from './coreIdentityTestFixtures.mjs';
import { ORG, SCOUT, T } from './recruitmentTestFixtures.mjs';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
export const TC = Object.freeze({ created: NOW - 10 * DAY, opened: NOW - 9 * DAY, moved: NOW - 5 * DAY, reopened: NOW - 3 * DAY, decided: NOW - 2 * DAY, filed: NOW - HOUR });
const by = () => ({ userId: SCOUT.userId, name: SCOUT.name });

/** domains/platform/routeHelpers.mjs `audit()` and `histAppend()`: the history literal every case writer appends. */
export const hist = (id, at, action, detail = null, over = {}) => ({ id, at, byKind: 'org', byId: SCOUT.userId, byName: SCOUT.name, action, detail, ...over });

/** domains/scouting/scouting.mjs — the workspace case literal (no room, no budget). */
export const plainCase = (over = {}) => ({
  id: 'case-2', orgId: ORG.id, playerId: 'pl-child1', playerName: 'Child pl-child1',
  vacancyId: null, ownerUserId: SCOUT.userId, ownerName: SCOUT.name,
  stage: 'identified', priority: 'medium', deadline: null, restricted: false,
  assignments: [{ id: 'asg-1', userId: SCOUT.userId, name: SCOUT.name, task: 'Scout this player', dueAt: null, status: 'open', createdAt: TC.created + HOUR }],
  tasks: [{ id: 'tsk-1', title: 'Watch the cup game', dueAt: '2026-11-20', assigneeUserId: SCOUT.userId, status: 'done', createdAt: TC.created + 2 * HOUR, completedAt: TC.moved, completedBy: SCOUT.name }],
  approvals: [{ id: 'apr-1', decision: { outcome: 'sign', reasons: 'Ready for the first team.' }, requestedBy: by(), status: 'approved', requestedAt: TC.moved, resolvedBy: { ...by(), at: TC.moved + HOUR } }],
  decision: { outcome: 'sign', reasons: 'Ready for the first team.', byUserId: SCOUT.userId, byName: SCOUT.name, approvedBy: SCOUT.name, at: TC.moved + HOUR },
  links: { requestIds: ['req-minor'], trialIds: [], signingId: null },
  createdAt: TC.created, history: [hist('aud-c2-1', TC.created, 'created', 'identified'), hist('aud-c2-2', TC.created + HOUR, 'assigned', 'Maria: Scout this player'), hist('aud-c2-3', TC.moved, 'approval_requested', 'sign'), hist('aud-c2-4', TC.moved + HOUR, 'approved', 'sign')],
  room: null, budget: null, ...over,
});

/** domains/recruitment/rooms/rooms.mjs — the room literal (the case created by the room route, the facet, `applyStatus` to under_review, rev 1) with every owned list and object a later route may add. */
export const roomCase = (over = {}) => ({
  id: 'case-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Adult Signup',
  vacancyId: null, ownerUserId: SCOUT.userId, ownerName: SCOUT.name,
  stage: 'trial', priority: 'medium', deadline: null, restricted: false,
  assignments: [{ id: 'asg-2', userId: SCOUT.userId, name: SCOUT.name, task: 'Video assessment', dueAt: TC.moved + 7 * DAY, status: 'open', createdAt: TC.opened + HOUR }],
  tasks: [{ id: 'tsk-2', title: 'Call the parent', description: 'Agree the trial date.', assigneeUserId: SCOUT.userId, assigneeName: SCOUT.name, status: 'open', dueAt: TC.moved + 2 * DAY, linkedResourceType: 'trial', linkedResourceId: 'trial-1', createdBy: by(), createdAt: TC.opened + 2 * HOUR, completedAt: null }],
  approvals: [], decision: null,
  links: { requestIds: ['req-p4b'], trialIds: ['trial-1'], signingId: null },
  createdAt: TC.opened,
  history: [
    hist('aud-c1-1', TC.opened, 'room_created', { status: 'under_review', sourceContext: 'search', adoptedExistingCase: false, inheritedStage: null }),
    hist('aud-c1-2', TC.moved, 'room_status_changed', { from: 'under_review', to: 'trial_requested', reasonCodes: ['trial_arranged'], lifecycleAction: 'requestTrial', clientKey: null, policyVersion: 2, decisionId: null }),
    hist('aud-c1-3', TC.moved + MIN, 'room_trial_linked', { trialId: 'trial-1', status: 'awaiting_report' }),
    hist('aud-c1-4', TC.decided, 'transaction_handoff_invited', { handoffId: 'hof-1', represented: false }),
    hist('aud-c1-5', TC.decided + HOUR, 'room_decision_finalized', { decisionId: 'rdec-2', outcome: 'progress', supersedes: null, reasonCodes: ['strong_evidence'], note: true }),
  ],
  room: {
    status: 'trial_requested', priority: 'high', tags: ['watch', 'u18'], leadScoutUserId: SCOUT.userId, sourceContext: 'search',
    openedBy: by(), updatedAt: TC.moved, archivedAt: null, closedAt: null,
    rev: 3, revAt: TC.moved, revBy: by(),
    reopened: { by: by(), at: TC.reopened, from: 'archived', reasonCodes: ['new_evidence'], sourceContext: 'second_look', sourceRef: { id: 'sl-1', version: null } },
  },
  decisionDraft: { id: 'rdraft-1', outcome: 'progress', reasonCodes: ['strong_evidence', 'fit'], note: 'Strong on the left.', evidenceRefs: [{ kind: 'trial', id: 'trial-1', meta: { status: 'awaiting_report' } }], by: { ...by(), role: SCOUT.role }, createdAt: TC.decided, updatedAt: TC.decided + MIN, updatedBy: { ...by(), role: SCOUT.role }, rev: 2, revAt: TC.decided + MIN, keys: { create: { key: 'draft-key-1', fp: 'fp-draft-1' } } },
  transactionHandoff: { id: 'hof-1', caseId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', status: 'invited', invitedAt: TC.decided, invitedBy: { kind: 'org', ...by() }, acceptedAt: null, withdrawnAt: null, transactionId: null, representedAtInvitation: false, invitedAgencyOrgId: null, invitedAgentUserId: null, keys: { invite: { key: 'invite-key-1' } }, rev: 1, revAt: TC.decided },
  budget: { scenarios: [{
    id: 'scn-1', version: 2, label: 'Base case', currency: 'GBP', termMonths: 24,
    lines: [{ id: 'ln-1', kind: 'wage', label: 'Salary', amountMinor: 120000000, currency: 'GBP', schedule: 'annual', confirmed: true, conditional: null }, { id: 'ln-2', kind: 'bonus', label: 'Appearance bonus', amountMinor: 500000, currency: 'EUR', schedule: 'monthly', confirmed: false, conditional: { assumption: '20 appearances' } }],
    fxAssumptions: [{ from: 'EUR', to: 'GBP', rate: '0.861234', source: 'manual entry', date: '2026-10-01', manual: true }],
    approval: { by: SCOUT.name, byUserId: SCOUT.userId, at: TC.moved, version: 1, superseded: true },
    actuals: [{ id: 'act-1', lineId: 'ln-1', amountMinor: 10000000, at: TC.decided, recordedBy: SCOUT.name }],
    createdBy: SCOUT.name, createdAt: TC.opened + DAY, updatedAt: TC.moved,
  }] },
  ...over,
});

/** domains/scouting/scouting.mjs — a bare workspace case: a vacancy, a deadline day, nothing assigned yet. */
export const legacyCase = (over = {}) => plainCase({
  id: 'case-legacy', playerId: 'pl-child2', playerName: 'Child pl-child2', vacancyId: 'vac-9', priority: 'low', deadline: '2026-12-01',
  assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
  history: [hist('aud-l-1', TC.created, 'created', 'identified')], ...over,
});
/** The case after its player's account deletion: `playerName` null, `subjectRemovedAt` set (nothing else changes). */
export const tombstonedCase = (over = {}) => plainCase({ id: 'case-gone', playerId: 'pl-gone-long-ago', playerName: null, subjectRemovedAt: T.removed, links: { requestIds: [], trialIds: [], signingId: null }, history: [hist('aud-g-1', TC.created, 'created', 'identified')], assignments: [], tasks: [], approvals: [], decision: null, ...over });

/** domains/recruitment/rooms/rooms.mjs — a comment, its edit and its tombstone. */
export const comment = (over = {}) => ({ id: 'rcmt-1', roomId: 'case-1', orgId: ORG.id, authorId: SCOUT.userId, authorName: SCOUT.name, body: 'Quick on the turn.', replyToId: null, mentions: [SCOUT.userId], createdAt: TC.moved, editedAt: null, editCount: 0, deletedAt: null, ...over });
export const editedComment = (over = {}) => comment({ id: 'rcmt-2', body: 'Quick on the turn (edited).', replyToId: 'rcmt-1', mentions: [], createdAt: TC.moved + MIN, editedAt: TC.moved + 2 * MIN, editCount: 1, ...over });
export const tombstonedComment = (over = {}) => comment({ id: 'rcmt-3', body: 'Removed by the author.', mentions: [], createdAt: TC.moved + 3 * MIN, deletedAt: TC.moved + 4 * MIN, deletedBy: by(), ...over });

/** domains/recruitment/rooms/rooms.mjs with domains/recruitment/rooms/shared.mjs `buildRoomSnapshot` — the snapshot literal, trust absent (null) and present. */
export const snapshot = (over = {}) => ({ id: 'rsnap-1', roomId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', at: TC.moved, trigger: 'status:trial_requested', trust: null, sourceRefs: { passportVersion: 1, passportRevision: 'pr_4', evidenceIds: ['ev-1', 'ev-2'], assessmentIds: [], combineResults: ['sprint-30m@2'], trialIds: ['trial-1'] }, note: 'Evidence confidence at decision time; not a judgement of the player.', ...over });
export const trustedSnapshot = (over = {}) => snapshot({ id: 'rsnap-2', at: TC.decided, trigger: 'decision:finalize', trust: { score: 72, band: 'good', policyVersion: 3, componentLevels: { evidence: 'high', identity: 'verified', consistency: 'medium' }, hash: 'sha256:abc' }, sourceRefs: { passportVersion: 1, passportRevision: 'pr_5', evidenceIds: ['ev-1', 'ev-2', 'ev-3'], assessmentIds: ['as-1'], combineResults: ['sprint-30m@2', 'agility@1'], trialIds: ['trial-1'] }, ...over });

/** domains/recruitment/rooms/rooms.mjs — a room recommendation (superseded by the formal decision below). */
export const recommendation = (over = {}) => ({ id: 'rdec-1', roomId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', recommendation: 'continue_watching', reasonCodes: ['needs_more_evidence'], note: null, by: { ...by(), role: SCOUT.role }, createdAt: TC.moved, trigger: 'decision', clientKey: 'rec-key-1', supersedes: null, supersededById: 'rdec-2', snapshot: { at: TC.moved, trust: null, sourceRefs: snapshot().sourceRefs, snapshotId: 'rsnap-1' }, ...over });
/** domains/recruitment/lifecycle/decisionRoutes.mjs — the formal decision (kind formal, state final, the keys, the assessment summary, the snapshot copy, the lifecycle). */
export const formalDecision = (over = {}) => ({
  id: 'rdec-2', roomId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', kind: 'formal', state: 'final', outcome: 'progress', recommendation: 'offer',
  reasonCodes: ['strong_evidence'], note: 'Strong on the left.', by: { ...by(), role: SCOUT.role }, createdAt: TC.decided + HOUR, finalizedAt: TC.decided + HOUR, trigger: 'decision:finalize', clientKey: 'fin-key-1',
  supersedes: 'rdec-1', supersededById: null, supersession: null, rev: 1, revAt: TC.decided + HOUR,
  evidenceRefs: [{ kind: 'trial', id: 'trial-1', meta: { status: 'awaiting_report' } }, { kind: 'assessment', id: 'as-1', meta: null }],
  assessmentSummary: { submitted: 1, withheld: 0, verdicts: { sign: 1 }, assessmentIds: ['as-1'] },
  snapshot: { at: TC.decided, trust: trustedSnapshot().trust, sourceRefs: trustedSnapshot().sourceRefs, snapshotId: 'rsnap-2' },
  keys: { finalize: { key: 'fin-key-1', fp: 'fp-fin-1' }, draft: { key: 'draft-key-1', fp: 'fp-draft-1' } },
  draftId: 'rdraft-0', lifecycle: { action: 'shortlist', from: 'trial_requested', to: 'shortlisted', applied: true, at: TC.decided + HOUR }, policyVersion: 2, ...over,
});
/** domains/recruitment/rooms/rooms.mjs — an evidence review state, overwritten in place. */
export const evidenceState = (over = {}) => ({ id: 'rev-1', roomId: 'case-1', orgId: ORG.id, evidenceId: 'ev-1', state: 'reviewed', note: 'Good angle.', byId: SCOUT.userId, byName: SCOUT.name, at: TC.moved + 5 * MIN, ...over });

/** The standard case graph: the room case, the workspace case, the legacy case, the tombstoned case; their room rows. */
export const ROOM_CASES_FIX = () => ({
  recruitmentCases: [roomCase(), plainCase(), legacyCase(), tombstonedCase()],
  roomComments: [comment(), editedComment(), tombstonedComment()],
  roomSnapshots: [snapshot(), trustedSnapshot()],
  roomDecisions: [recommendation(), formalDecision()],
  roomEvidenceState: [evidenceState()],
});

/** JSON shape: a live `undefined` is absence. */
export const persisted = (v) => JSON.parse(JSON.stringify(v));

