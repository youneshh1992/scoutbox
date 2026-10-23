// S8b test fixtures: recruitment cases (the M12 case with the M17 room facet, its owned lists and objects), room
// comments, room snapshots, room decisions and room evidence states in the EXACT shapes the writers produce
// (m12/scouting.mjs the case, assignments, M12 tasks, approvals, the decision; m17/rooms.mjs the room facet, M17 tasks,
// assignments, links, reopen, comments, snapshots, recommendations, evidence states; m23/decisionRoutes.mjs the draft
// and the formal decision; m27/index.mjs the transaction handoff and its history literal; m13/planning.mjs the budget;
// m12/shared.mjs / m13/shared.mjs the history literal; m17/index.mjs and m13/shared.mjs the `room ??= null` /
// `budget ??= null` backfills). Synthetic ids and names only. Shared by testRecruitmentCases.mjs and
// testRecruitmentCasesServer.mjs. The ids agree with recruitmentTestFixtures.mjs: case-1 is the room of pl-adult that
// req-p4b / trial-1 name, case-2 the case of pl-child1 that req-minor names.
import { NOW } from './coreIdentityTestFixtures.mjs';
import { ORG, SCOUT, T } from './recruitmentTestFixtures.mjs';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
export const TC = Object.freeze({ created: NOW - 10 * DAY, opened: NOW - 9 * DAY, moved: NOW - 5 * DAY, reopened: NOW - 3 * DAY, decided: NOW - 2 * DAY, filed: NOW - HOUR });
const by = () => ({ userId: SCOUT.userId, name: SCOUT.name });

/** m12/shared.mjs `audit()` / m13/shared.mjs `histAppend()`: the history literal every M12/M17/M23 writer appends. */
export const hist = (id, at, action, detail = null, over = {}) => ({ id, at, byKind: 'org', byId: SCOUT.userId, byName: SCOUT.name, action, detail, ...over });
/** m27/index.mjs:697 — the second history literal in the same list (`by` an object, no byKind/byId/byName). */
export const histM27 = (id, at, action, detail) => ({ id, at, action, by: { kind: 'org', userId: SCOUT.userId, name: SCOUT.name }, detail });

/** m12/scouting.mjs:450 — the M12 case literal (no room; `room: null` and `budget: null` backfilled at boot by m17/index.mjs and m13/shared.mjs). */
export const m12Case = (over = {}) => ({
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

/** m17/rooms.mjs:568–:599 — the room literal (the case created by the room route, the facet, `applyStatus` to under_review, rev 1) with every owned list and object a later route may add. */
export const roomCase = (over = {}) => ({
  id: 'case-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Adult Signup',
  vacancyId: null, ownerUserId: SCOUT.userId, ownerName: SCOUT.name,
  stage: 'trial', priority: 'medium', deadline: null, restricted: false,
  assignments: [{ id: 'asg-2', userId: SCOUT.userId, name: SCOUT.name, task: 'Video assessment', dueAt: TC.moved + 7 * DAY, status: 'open', createdAt: TC.opened + HOUR }],
  tasks: [{ id: 'tsk-2', title: 'Call the parent', description: 'Agree the trial date.', assigneeUserId: SCOUT.userId, assigneeName: SCOUT.name, status: 'open', dueAt: TC.moved + 2 * DAY, linkedResourceType: 'trial', linkedResourceId: 'trial-1', createdBy: by(), createdAt: TC.opened + 2 * HOUR, completedAt: null }],
  approvals: [], decision: null,
  // a legacy duplicate entry in the trial list: kept (position-keyed), never deduplicated
  links: { requestIds: ['req-p4b'], trialIds: ['trial-1', 'trial-1'], signingId: null },
  createdAt: TC.opened,
  history: [
    hist('aud-c1-1', TC.opened, 'room_created', { status: 'under_review', sourceContext: 'search', adoptedExistingCase: false, inheritedStage: null }),
    hist('aud-c1-2', TC.moved, 'room_status_changed', { from: 'under_review', to: 'trial_requested', reasonCodes: ['trial_arranged'], lifecycleAction: 'requestTrial', clientKey: null, policyVersion: 2, decisionId: null }),
    hist('aud-c1-3', TC.moved + MIN, 'room_trial_linked', { trialId: 'trial-1', status: 'awaiting_report' }),
    histM27('aud-c1-4', TC.decided, 'transaction_handoff_invited', { handoffId: 'hof-1', represented: false }),
    hist('aud-c1-5', TC.decided + HOUR, 'room_decision_finalized', { decisionId: 'rdec-2', outcome: 'proceed', supersedes: null, reasonCodes: ['strong_evidence'], note: true, to: undefined }),
  ],
  room: {
    status: 'trial_requested', priority: 'high', tags: ['watch', 'u18'], leadScoutUserId: SCOUT.userId, sourceContext: 'search',
    openedBy: by(), updatedAt: TC.moved, archivedAt: null, closedAt: null,
    rev: 3, revAt: TC.moved, revBy: by(),
    reopened: { by: by(), at: TC.reopened, from: 'archived', reasonCodes: ['new_evidence'], sourceContext: 'second_look', sourceRef: { kind: 'second_look_item', id: 'sl-1' } },
  },
  decisionDraft: { id: 'rdraft-1', outcome: 'proceed', reasonCodes: ['strong_evidence', 'fit'], note: 'Strong on the left.', evidenceRefs: [{ kind: 'trial', id: 'trial-1', meta: { status: 'awaiting_report' } }], by: { ...by(), role: SCOUT.role }, createdAt: TC.decided, updatedAt: TC.decided + MIN, updatedBy: { ...by(), role: SCOUT.role }, rev: 2, revAt: TC.decided + MIN, keys: { create: { key: 'draft-key-1', fp: 'fp-draft-1' } } },
  transactionHandoff: { id: 'hof-1', caseId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', status: 'invited', invitedAt: TC.decided, invitedBy: { kind: 'org', ...by() }, acceptedAt: null, withdrawnAt: null, transactionId: null, representedAtInvitation: false, invitedAgencyOrgId: null, invitedAgentUserId: null, keys: { invite: { key: 'invite-key-1' } }, rev: 1, revAt: TC.decided },
  budget: { scenarios: [{
    id: 'scn-1', version: 2, label: 'Base case', currency: 'GBP', termMonths: 24,
    lines: [{ id: 'ln-1', kind: 'salary', label: 'Salary', amountMinor: 120000000, currency: 'GBP', schedule: 'annual', confirmed: true, conditional: null }, { id: 'ln-2', kind: 'bonus', label: 'Appearance bonus', amountMinor: 500000, currency: 'EUR', schedule: 'per_appearance', confirmed: false, conditional: { assumption: '20 appearances' } }],
    fxAssumptions: [{ from: 'EUR', to: 'GBP', rate: '0.861234', source: 'manual entry', date: '2026-10-01', manual: true }],
    approval: { by: SCOUT.name, byUserId: SCOUT.userId, at: TC.moved, version: 1, superseded: true },
    actuals: [{ id: 'act-1', lineId: 'ln-1', amountMinor: 10000000, at: TC.decided, recordedBy: SCOUT.name }],
    createdBy: SCOUT.name, createdAt: TC.opened + DAY, updatedAt: TC.moved,
  }] },
  ...over,
});

/** A case a pre-M17 build wrote and no backfill touched (no `room`, `budget`, `restricted`, `decision`, `approvals` keys; an unknown field; an off-type `createdAt`). */
export const legacyCase = (over = {}) => ({
  id: 'case-legacy', orgId: ORG.id, playerId: 'pl-child2', playerName: 'Child pl-child2', vacancyId: 'vac-9', ownerUserId: SCOUT.userId, ownerName: SCOUT.name,
  stage: 'identified', priority: 'low', deadline: '2026-12-01', assignments: [], tasks: [], links: { requestIds: [], trialIds: [] },
  createdAt: TC.created, history: [{ id: 'aud-l-1', at: TC.created, byKind: 'org', byId: SCOUT.userId, byName: SCOUT.name, action: 'created', detail: 'identified', legacyNote: 'kept' }], legacyFlag: true, ...over,
});
/** server.mjs:4290 — the case after its player's account deletion: `playerName` null, `subjectRemovedAt` set (nothing else changes). */
export const tombstonedCase = (over = {}) => m12Case({ id: 'case-gone', playerId: 'pl-gone-long-ago', playerName: null, subjectRemovedAt: T.removed, links: { requestIds: [], trialIds: [], signingId: null }, history: [hist('aud-g-1', TC.created, 'created', 'identified')], assignments: [], tasks: [], approvals: [], decision: null, ...over });

/** m17/rooms.mjs:1041–:1046 — a comment; `:1073`–`:1075` the edit; `:1088`–`:1089` the tombstone. */
export const comment = (over = {}) => ({ id: 'rcmt-1', roomId: 'case-1', orgId: ORG.id, authorId: SCOUT.userId, authorName: SCOUT.name, body: 'Quick on the turn.', replyToId: null, mentions: [SCOUT.userId], createdAt: TC.moved, editedAt: null, editCount: 0, deletedAt: null, ...over });
export const editedComment = (over = {}) => comment({ id: 'rcmt-2', body: 'Quick on the turn (edited).', replyToId: 'rcmt-1', mentions: [], createdAt: TC.moved + MIN, editedAt: TC.moved + 2 * MIN, editCount: 1, ...over });
export const tombstonedComment = (over = {}) => comment({ id: 'rcmt-3', body: 'Removed by the author.', mentions: [], createdAt: TC.moved + 3 * MIN, deletedAt: TC.moved + 4 * MIN, deletedBy: by(), ...over });

/** m17/rooms.mjs:962–:983 with m17/shared.mjs `buildRoomSnapshot` — the snapshot literal, trust absent (null) and present. */
export const snapshot = (over = {}) => ({ id: 'rsnap-1', roomId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', at: TC.moved, trigger: 'status:trial_requested', trust: null, sourceRefs: { passportVersion: 1, passportRevision: 4, evidenceIds: ['ev-1', 'ev-2'], assessmentIds: [], combineResults: ['sprint-30m@2'], trialIds: ['trial-1'] }, note: 'Evidence confidence at decision time; not a judgement of the player.', ...over });
export const trustedSnapshot = (over = {}) => snapshot({ id: 'rsnap-2', at: TC.decided, trigger: 'decision:finalize', trust: { score: 72, band: 'good', policyVersion: 3, componentLevels: { evidence: 'high', identity: 'verified', consistency: 'medium' }, hash: 'sha256:abc' }, sourceRefs: { passportVersion: 1, passportRevision: 5, evidenceIds: ['ev-1', 'ev-2', 'ev-3'], assessmentIds: ['as-1'], combineResults: ['sprint-30m@2', 'agility@1'], trialIds: ['trial-1'] }, ...over });

/** m17/rooms.mjs:1175–:1183 — an M17 recommendation (superseded by the formal decision below). */
export const recommendation = (over = {}) => ({ id: 'rdec-1', roomId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', recommendation: 'monitor', reasonCodes: ['needs_more_evidence'], note: null, by: { ...by(), role: SCOUT.role }, createdAt: TC.moved, trigger: 'decision', clientKey: 'rec-key-1', supersedes: null, supersededById: 'rdec-2', snapshot: { at: TC.moved, trust: null, sourceRefs: snapshot().sourceRefs, snapshotId: 'rsnap-1' }, ...over });
/** m23/decisionRoutes.mjs:371–:385 — the formal decision (kind formal, state final, the keys, the assessment summary, the snapshot copy, the lifecycle). */
export const formalDecision = (over = {}) => ({
  id: 'rdec-2', roomId: 'case-1', orgId: ORG.id, playerId: 'pl-adult', kind: 'formal', state: 'final', outcome: 'proceed', recommendation: 'shortlist',
  reasonCodes: ['strong_evidence'], note: 'Strong on the left.', by: { ...by(), role: SCOUT.role }, createdAt: TC.decided + HOUR, finalizedAt: TC.decided + HOUR, trigger: 'decision:finalize', clientKey: 'fin-key-1',
  supersedes: 'rdec-1', supersededById: null, supersession: null, rev: 1, revAt: TC.decided + HOUR,
  evidenceRefs: [{ kind: 'trial', id: 'trial-1', meta: { status: 'awaiting_report' } }, { kind: 'assessment', id: 'as-1', meta: null }],
  assessmentSummary: { submitted: 1, withheld: 0, verdicts: { proceed: 1 }, assessmentIds: ['as-1'] },
  snapshot: { at: TC.decided, trust: trustedSnapshot().trust, sourceRefs: trustedSnapshot().sourceRefs, snapshotId: 'rsnap-2' },
  keys: { finalize: { key: 'fin-key-1', fp: 'fp-fin-1' }, draft: { key: 'draft-key-1', fp: 'fp-draft-1' } },
  draftId: 'rdraft-0', lifecycle: { action: 'shortlist', from: 'trial_requested', to: 'shortlisted', applied: true, at: TC.decided + HOUR }, policyVersion: 2, ...over,
});
/** m17/rooms.mjs:1273 — an evidence review state, overwritten in place. */
export const evidenceState = (over = {}) => ({ id: 'rev-1', roomId: 'case-1', orgId: ORG.id, evidenceId: 'ev-1', state: 'reviewed', note: 'Good angle.', byId: SCOUT.userId, byName: SCOUT.name, at: TC.moved + 5 * MIN, ...over });

/** The standard S8b graph: the room case, the M12 case, the legacy case, the tombstoned case; their room rows. */
export const S8B_FIX = () => ({
  recruitmentCases: [roomCase(), m12Case(), legacyCase(), tombstonedCase()],
  roomComments: [comment(), editedComment(), tombstonedComment()],
  roomSnapshots: [snapshot(), trustedSnapshot()],
  roomDecisions: [recommendation(), formalDecision()],
  roomEvidenceState: [evidenceState()],
});

/** JSON-persisted shape (what the blob held): a live `undefined` is absence. */
export const persisted = (v) => JSON.parse(JSON.stringify(v));
