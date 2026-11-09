// S12a — development objectives, drill-guidance reviews and the Development Hub as typed tables with explicit writes
// (repositories/development.mjs, migration 0030). What this suite proves: the migration creates the eighteen STRICT
// tables (no JSON column) and a fresh database holds no row; the typers refuse junk with the record and field named
// (an unknown field, a third objective, a progress entry naming another objective's item, a history detail key the
// Hub never writes, a blocked goal without a reason, a link with two holders, a review with a note but no club);
// records are created and read back whole, the derived fields (a snapshot's completion, a review's supersededBy and
// share scopes) worked out on read; an update keeps the fields that never change and only grows the history; the
// list, count, duplicate and audit-feed queries answer what the routes need; a rolled-back unit leaves nothing; the
// db.* names throw; and a fixture written through the repository is typed, refuses a missing reference (nothing
// written) and reads back what it wrote.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  DEVELOPMENT_MIGRATION as MIGRATION, DEVELOPMENT_TABLES as TABLES, DEVELOPMENT_COLLECTIONS as COLLECTIONS, DEVELOPMENT_HISTORY_ACTIONS,
  typeObjective, typePlan, typeGoal, typeLink, typeReview, typeHistoryEntry,
} from '../repositories/development.mjs';
import { TIMELINE_ACTION_NAMES } from '../domains/development/hub/plan.mjs';
import { EVIDENCE_LINK_FIELDS } from '../domains/development/hub/evidence.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------- fixtures: the literals the routes write
const PID = 'pl-1';
const PLAYER = { kind: 'player', id: PID, name: 'Kola' };
const COACH = { kind: 'org', id: SCOUT.userId, name: SCOUT.name };
const hist = (id, action, detail = null, by = PLAYER) => ({ id, at: NOW, byKind: by.kind, byId: by.id, byName: by.name, action, detail });
/** createObjective (domains/development/objectives.mjs). */
const objective = (over = {}) => ({
  id: 'obj-1', playerId: PID, sourceFeedbackId: 'asm-1', orgId: ORG.id,
  reviewer: { userId: SCOUT.userId, name: SCOUT.name, orgName: ORG.name },
  objectives: [{ id: 'objx-1', text: 'Weak-foot passing', exerciseRefs: ['wall passes'], baselineEvidenceIds: ['ev-1'] }],
  progress: [], sharing: { orgIds: [] }, reassessments: [], reviewAt: null, status: 'active', createdBy: { ...PLAYER }, createdAt: NOW, ...over,
});
/** POST /development/plans (domains/development/hub/index.mjs), a club plan. */
const plan = (over = {}) => ({
  id: 'devplan-1', playerId: PID, owner: { kind: 'org', orgId: ORG.id, orgName: ORG.name }, createdBy: { ...COACH }, title: 'Season plan',
  status: 'active', visibility: 'player_guardian', sharedWithOrgIds: [], startDate: NOW, nextReviewAt: null, endDate: null, templateId: null,
  originObjectiveId: null, createdAt: NOW, updatedAt: NOW, rev: 1, revAt: NOW, revBy: { userId: COACH.id, name: COACH.name }, completedAt: null, archivedAt: null,
  history: [hist('aud-1', 'plan_created', { visibility: 'player_guardian', owner: 'org' }, COACH), hist('aud-2', 'plan_activated', null, COACH)], ...over,
});
/** newGoal. */
const goal = (over = {}) => ({
  id: 'devgoal-1', planId: 'devplan-1', playerId: PID, title: 'First touch', description: null, category: 'technical', status: 'not_started',
  blockReason: null, blockNote: null, targetDate: null,
  target: { sourceType: 'combine_attempt', protocolId: 'juggle-60', protocolVersion: 1, metricType: 'count', metricUnit: 'juggles', operator: 'gte', value: 40, protocolTitle: 'Juggling', direction: 'higher', precision: 'integer' },
  originObjectiveId: null, createdBy: { ...COACH }, createdAt: NOW, updatedAt: NOW, completedAt: null, rev: 1, revAt: NOW, revBy: { userId: COACH.id, name: COACH.name },
  history: [hist('aud-3', 'goal_created', { kind: 'technical' }, COACH), hist('aud-4', 'goal_target_set', { protocolId: 'juggle-60' }, COACH)], ...over,
});
const action = (over = {}) => ({
  id: 'devact-1', planId: 'devplan-1', goalId: 'devgoal-1', playerId: PID, type: 'training', title: 'Juggle daily', dueAt: NOW + 5,
  assignee: { kind: 'player', id: PID, name: 'Kola' }, status: 'todo', createdBy: { ...COACH }, createdAt: NOW, updatedAt: NOW, completedAt: null,
  history: [hist('aud-5', 'action_created', { kind: 'training' }, COACH)], ...over,
});
const link = (over = {}) => ({
  id: 'devlink-1', planId: 'devplan-1', goalId: 'devgoal-1', actionId: null, playerId: PID, sourceType: 'passport_evidence', sourceId: 'ev-1',
  linkedByKind: 'org', linkedById: COACH.id, linkedByName: COACH.name, linkedAt: NOW, ...over,
});
const review = (over = {}) => ({
  id: 'devrev-1', planId: 'devplan-1', playerId: PID, reviewerKind: 'coach_review', reviewedBy: { ...COACH }, orgId: ORG.id, reviewedAt: NOW,
  sharedSummary: 'Good week.', internalNote: 'Keep an eye on load.',
  goalSnapshots: [{ goalId: 'devgoal-1', title: 'First touch', category: 'technical', status: 'in_progress', actionCounts: { total: 3, done: 1, blocked: 0, cancelled: 1 }, completion: { done: 1, of: 2, phrase: '1 of 2 actions completed' }, evidenceRefs: [{ sourceType: 'passport_evidence', sourceId: 'ev-1' }], targetStateAtReview: { state: 'no_current_valid_measurement', reason: 'no_attempts', measured: null } }],
  nextReviewAt: null, sharedWithPlayerAt: null, shareScopes: [], supersedes: null, supersededBy: null, createdAt: NOW,
  history: [hist('aud-6', 'review_submitted', { kind: 'coach_review', note: true }, COACH)], ...over,
});

function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.development, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
/** A server-shaped store holding one club plan with a goal, an action, a link and a review. */
function seeded(label) {
  const dir = tempDir(label); saveFixture(dir);
  const s = serverOpen(dir);
  s.unit(() => { s.repo.plans.create(plan()); s.repo.goals.create(goal()); s.repo.actions.create(action()); s.repo.links.create(link()); s.repo.reviews.create(review()); });
  return { s, dir };
}

// ------------------------------------------------------------- schema
test('[schema] 0030 is registered after 0029 and creates the eighteen STRICT tables (no JSON column), empty on a fresh database', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0029_agent_transactions') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  assert.equal(TABLES.length, 18);
  const dir = tempDir('s12a-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  s.close(); rm(dir);
});

test('[vocabulary] every timeline action is a history action the table accepts; a link holds exactly EVIDENCE_LINK_FIELDS', () => {
  for (const a of TIMELINE_ACTION_NAMES) assert.ok(DEVELOPMENT_HISTORY_ACTIONS.includes(a), a);
  assert.deepEqual(Object.keys(typeLink(link()).record).sort(), [...EVIDENCE_LINK_FIELDS].sort());
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named', () => {
  assert.equal(typeObjective(objective()).ok, true);
  assert.match(typeObjective(objective({ shoeSize: 9 })).reason, /obj-1 carries field\(s\) this build does not store: shoeSize/);
  assert.match(typeObjective(objective({ objectives: [1, 2, 3] })).reason, /obj-1\.objectives must list 1 to 2/);
  assert.match(typeObjective(objective({ objectives: [{ id: 'objx-1', text: 'x', exerciseRefs: [1], baselineEvidenceIds: [] }] })).reason, /exerciseRefs\[0\] must be text/);
  assert.match(typeObjective(objective({ progress: [{ id: 'prg-1', at: NOW, objectiveId: 'objx-9', note: null, evidenceId: null }] })).reason, /prg-1 names objx-9, which is not one of this objective's items/);
  assert.match(typeObjective(objective({ reviewAt: 'soon' })).reason, /reviewAt must be an integer/);
  assert.match(typeObjective(objective({ reassessments: [{ id: 'ras-1', requestedBy: { ...PLAYER }, requestedAt: NOW, status: 'completed', outcome: null }] })).reason, /outcome is recorded exactly when the reassessment is completed/);
  assert.equal(typePlan(plan()).ok, true);
  assert.match(typePlan(plan({ visibility: 'private' })).reason, /visibility must be one of org_private\|player_guardian for a org-owned plan/);
  assert.match(typePlan(plan({ sharedWithOrgIds: [ORG.id] })).reason, /sharedWithOrgIds is for a player-owned plan only/);
  assert.match(typePlan(plan({ originTrialId: null })).reason, /originTrialId/);
  assert.match(typeHistoryEntry(hist('aud-9', 'plan_created', { mood: 'happy' }), 'h').reason, /h\.detail carries field\(s\) this build does not store: mood/);
  assert.match(typeHistoryEntry(hist('aud-9', 'plan_renamed'), 'h').reason, /h\.action must be one of/);
  assert.match(typeGoal(goal({ status: 'blocked' })).reason, /blockReason is set exactly while the goal is blocked/);
  assert.match(typeGoal(goal({ target: { ...goal().target, value: '40' } })).reason, /target\.value must be a finite number/);
  assert.match(typeLink(link({ actionId: 'devact-1' })).reason, /exactly one of the two/);
  assert.match(typeReview(review({ reviewerKind: 'player_reflection', reviewedBy: { ...PLAYER }, orgId: null })).reason, /internalNote is written by the club only/);
  assert.match(typeReview(review({ shareScopes: ['summary'] })).reason, /shareScopes are set only once the review is shared/);
});

// ------------------------------------------------------------- objectives
test('[objectives] created whole and read back; an update keeps the items and source, only grows progress, completes a reassessment once; club and reassessment lookups', () => {
  const dir = tempDir('s12a-obj'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    const created = s.unit(() => s.repo.objectives.create(objective()));
    assert.deepEqual(plain(created), objective());
    assert.ok(Object.isFrozen(created) && Object.isFrozen(created.objectives[0]), 'records are read-only');
    s.unit(() => s.repo.objectives.update('obj-1', (d) => {
      d.progress.push({ id: 'prg-1', at: NOW + 1, objectiveId: 'objx-1', note: 'Did 50', evidenceId: null });
      d.sharing.orgIds.push(ORG.id);
      d.reassessments.push({ id: 'ras-1', requestedBy: { ...PLAYER }, requestedAt: NOW + 2, status: 'requested', outcome: null });
    }));
    assert.equal(s.repo.reads.objectives.sharedWith(PID, ORG.id).length, 1);
    assert.equal(s.repo.reads.objectives.sharedWith(PID, 'org-other').length, 0);
    assert.equal(s.repo.reads.objectives.byReassessment('ras-1').id, 'obj-1');
    refused(() => s.unit(() => s.repo.objectives.update('obj-1', (d) => { d.objectives[0].text = 'Something else'; })), /objectives cannot change/, 'items are fixed');
    refused(() => s.unit(() => s.repo.objectives.update('obj-1', (d) => { d.progress = []; })), /progress only grows/, 'progress only grows');
    refused(() => s.unit(() => s.repo.objectives.update('obj-1', (d) => { d.reassessments.push({ id: 'ras-2', requestedBy: { ...PLAYER }, requestedAt: NOW, status: 'requested', outcome: null }); })), /more than one open request/, 'one open request');
    const outcome = { note: 'Better.', evidenceIds: ['ev-2'], byUserId: SCOUT.userId, byName: SCOUT.name, at: NOW + 3 };
    s.unit(() => s.repo.objectives.update('obj-1', (d) => { Object.assign(d.reassessments[0], { status: 'completed', outcome }); }));
    assert.deepEqual(plain(s.repo.reads.objectives.byId('obj-1').reassessments[0].outcome), outcome);
    refused(() => s.unit(() => s.repo.objectives.update('obj-1', (d) => { d.reassessments[0].outcome.note = 'Changed'; })), /only completes, once/, 'an outcome is final');
    refused(() => s.unit(() => s.repo.objectives.create(objective({ id: 'obj-2', reviewer: { userId: 'usr-none', name: null, orgName: null } }))), /FOREIGN KEY/, 'the reviewer is staff');
  } finally { s.close(); rm(dir); }
});

// ------------------------------------------------------------- the Hub
test('[hub] a plan, goal, action, link and review are created whole and read back; derived fields on read; the plan collects in one call', () => {
  const { s, dir } = seeded('s12a-hub');
  try {
    const got = s.repo.reads.plans.collect('devplan-1');
    assert.deepEqual(plain(got.plan), plan());
    assert.deepEqual(plain(got.goals), [goal()]);
    assert.deepEqual(plain(got.actions), [action()]);
    assert.deepEqual(plain(got.links), [link()]);
    assert.deepEqual(plain(got.reviews), [review()]);
    assert.equal(s.repo.reads.plans.collect('devplan-none'), null);
  } finally { s.close(); rm(dir); }
});

test('[hub] updates keep the fixed fields and only grow the history; a review is append-only and shared once; a correction derives supersededBy', () => {
  const { s, dir } = seeded('s12a-upd');
  try {
    s.unit(() => s.repo.goals.update('devgoal-1', (d) => { d.status = 'blocked'; d.blockReason = 'schedule'; d.history.push(hist('aud-7', 'goal_status_changed', { from: 'not_started', to: 'blocked' }, COACH)); }));
    assert.deepEqual(plain(s.repo.reads.goals.byId('devgoal-1').history.at(-1).detail), { from: 'not_started', to: 'blocked' });
    refused(() => s.unit(() => s.repo.goals.update('devgoal-1', (d) => { d.planId = 'devplan-2'; })), /planId cannot change/);
    refused(() => s.unit(() => s.repo.goals.update('devgoal-1', (d) => { d.history.shift(); })), /history only grows/);
    refused(() => s.unit(() => s.repo.plans.update('devplan-1', (d) => { d.owner.orgId = 'org-other'; })), /owner cannot change/);
    refused(() => s.unit(() => s.repo.reviews.update('devrev-1', (d) => { d.internalNote = 'rewritten'; })), /internalNote cannot change/, 'append-only');
    s.unit(() => s.repo.reviews.update('devrev-1', (d) => { d.sharedWithPlayerAt = NOW + 1; d.shareScopes = ['goals', 'summary']; }));
    assert.deepEqual(s.repo.reads.reviews.byId('devrev-1').shareScopes, ['summary', 'goals'], 'scopes read back in their fixed order');
    refused(() => s.unit(() => s.repo.reviews.update('devrev-1', (d) => { d.shareScopes = ['summary']; })), /shared once/);
    s.unit(() => s.repo.reviews.create(review({ id: 'devrev-2', supersedes: 'devrev-1', history: [] })));
    assert.equal(s.repo.reads.reviews.byId('devrev-1').supersededBy, 'devrev-2');
    refused(() => s.unit(() => s.repo.reviews.create(review({ id: 'devrev-3', supersedes: 'devrev-1', history: [] }))), /already superseded by devrev-2/);
    refused(() => s.unit(() => s.repo.links.create(link({ id: 'devlink-2' }))), /already linked there/, 'one link per holder and source');
    s.unit(() => s.repo.links.remove('devlink-1'));
    assert.equal(s.repo.reads.links.byId('devlink-1'), null);
    refused(() => s.unit(() => s.repo.actions.create(action({ id: 'devact-2', goalId: 'devgoal-none' }))), /names no goal of plan devplan-1/);
  } finally { s.close(); rm(dir); }
});

test('[hub] list candidates, counts, the open-plan count, the duplicate create and the organisation audit feed', () => {
  const { s, dir } = seeded('s12a-list');
  try {
    s.unit(() => s.repo.plans.create(plan({ id: 'devplan-2', owner: { kind: 'player', orgId: null, orgName: null }, createdBy: { ...PLAYER }, visibility: 'shared_with_org', sharedWithOrgIds: [ORG.id], updatedAt: NOW + 5, status: 'completed', completedAt: NOW + 5, history: [hist('aud-8', 'plan_created', { visibility: 'shared_with_org', owner: 'player' })] })));
    assert.deepEqual(s.repo.reads.plans.forOrg(ORG.id).map((p) => p.id), ['devplan-2', 'devplan-1'], 'owned and shared, newest change first');
    assert.deepEqual(s.repo.reads.plans.forOrg(ORG.id, { status: 'active' }).map((p) => p.id), ['devplan-1']);
    assert.deepEqual(s.repo.reads.plans.forOrg('org-other').map((p) => p.id), []);
    assert.deepEqual(s.repo.reads.plans.forPlayers([PID]).map((p) => p.id), ['devplan-2', 'devplan-1']);
    assert.ok(!('history' in s.repo.reads.plans.forPlayers([PID])[0]), 'list candidates leave the history out');
    const counts = s.repo.reads.plans.listCounts(['devplan-1', 'devplan-2']);
    assert.deepEqual(counts.goals.get('devplan-1'), [{ status: 'not_started' }]);
    assert.deepEqual(counts.actions.get('devplan-1'), [{ status: 'todo', dueAt: NOW + 5 }]);
    assert.deepEqual(counts.goals.get('devplan-2'), []);
    assert.equal(s.repo.reads.plans.openCount(PID, 'org', ORG.id), 1);
    assert.equal(s.repo.reads.plans.openCount(PID, 'player', null), 0, 'a completed plan does not count');
    assert.equal(s.repo.reads.plans.recentCreate({ playerId: PID, title: 'Season plan', createdById: COACH.id, ownerKind: 'org', ownerOrgId: ORG.id, since: NOW - 1 })?.id, 'devplan-1');
    assert.equal(s.repo.reads.plans.recentCreate({ playerId: PID, title: 'Season plan', createdById: COACH.id, ownerKind: 'org', ownerOrgId: ORG.id, since: NOW }), null);
    const feed = s.repo.reads.plans.orgFeed(ORG.id, ['plan_created', 'review_submitted']);
    assert.deepEqual(feed.map((r) => [r.entry.id, r.plan?.id ?? null, r.review?.id ?? null]), [['aud-1', 'devplan-1', null], ['aud-6', null, 'devrev-1']], 'the club\'s own plan and review only — not the player\'s shared plan');
  } finally { s.close(); rm(dir); }
});

// ------------------------------------------------------------- drill reviews, units, db.*
test('[drills] a review is recorded (a second replaces the first) and read back; a rolled-back unit leaves nothing', () => {
  const dir = tempDir('s12a-unit'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    s.repo.drillReviews.record({ drillId: 'sprint-30', reviewer: 'Coach A', reviewedAt: NOW });
    s.repo.drillReviews.record({ drillId: 'sprint-30', reviewer: 'Coach B', reviewedAt: NOW + 1 });
    assert.deepEqual(plain(s.repo.reads.drillReviews.all()), [{ drillId: 'sprint-30', reviewer: 'Coach B', reviewedAt: NOW + 1 }]);
    refused(() => s.repo.drillReviews.record({ drillId: 'sprint-30', reviewer: '', reviewedAt: NOW }), /reviewer must not be empty/);
    assert.throws(() => s.unit(() => { s.repo.objectives.create(objective()); s.repo.plans.create(plan()); throw new Error('boom'); }), /boom/);
    assert.equal(s.repo.reads.objectives.byId('obj-1'), null);
    assert.equal(s.repo.reads.plans.byId('devplan-1'), null);
  } finally { s.close(); rm(dir); }
});

// ------------------------------------------------------------- fixtures
test('[fixtures] a fixture written through the repository is typed (junk refused naming the record, nothing written), a missing reference is refused, and the records read back as written', () => {
  const dir = tempDir('s12a-fix');
  saveFixture(dir, {
    devObjectives: [objective()], drillGuidance: [{ drillId: 'sprint-30', reviewer: 'Coach', reviewedAt: NOW }],
    developmentPlans: [plan({ originObjectiveId: 'obj-1' })], developmentGoals: [goal()], developmentActions: [action()],
    // the corrected review first, then its correction (as the route writes them)
    developmentEvidenceLinks: [link()], developmentReviews: [review(), review({ id: 'devrev-2', supersedes: 'devrev-1', history: [] })],
  });
  try {
    const back = readRecords(dir);
    assert.deepEqual(plain(back.devObjectives), [objective()]);
    assert.deepEqual(plain(back.developmentPlans), [plan({ originObjectiveId: 'obj-1' })]);
    assert.deepEqual(plain(back.developmentReviews).map((r) => [r.id, r.supersedes, r.supersededBy]), [['devrev-1', null, 'devrev-2'], ['devrev-2', 'devrev-1', null]], 'the correction supersedes the corrected review');
  } finally { rm(dir); }
  const refusedFixture = (label, db, re) => {
    const d = tempDir(`s12a-fix-${label}`);
    try {
      refused(() => saveFixture(d, { devObjectives: [objective({ id: 'obj-ok' })], ...db }), re, label);
      const back = readRecords(d);
      assert.equal(back.devObjectives.length + back.developmentPlans.length + back.developmentGoals.length, 0, `${label}: a refused fixture wrote nothing`);
    } finally { rm(d); }
  };
  refusedFixture('plan', { developmentGoals: [goal({ planId: 'devplan-none' })] }, /DEVELOPMENT_REFERENCE_MISSING: development_goals devgoal-1: planId/);
  refusedFixture('org', { developmentPlans: [plan({ owner: { kind: 'org', orgId: 'org-none', orgName: null } })] }, /FOREIGN KEY constraint failed/);
  refusedFixture('junk', { devObjectives: [objective({ id: 'obj-ok' }), objective({ reviewAt: '2026-11-05' })] }, /DEVELOPMENT_INPUT_INVALID: devObjectives obj-1\.reviewAt/);
});

console.log(`\ndevelopment repository: ${passed} checks passed`);
