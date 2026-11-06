// S12d — exposure events, review-later deferrals, evidence suggestions, calibration sessions, fixtures, coverage plans and
// coverage assignments as typed tables with explicit writes (repositories/insightCoverage.mjs, migration 0033). What
// this suite proves: the migration creates the STRICT tables (no JSON column), empty; the typers refuse junk naming the
// record and field (a rating out of range, a day that does not exist, half a location, an unknown rule, a negative
// budget); an exposure event is recorded once per day and the window prune deletes only what lies before it; a deferral
// is replaced, and the due ones are found once; a reconciliation supplies closed gaps, rewrites an open one only when it
// changed, and keeps one open suggestion per rule; status moves are guarded; a calibration session pins its template
// version, takes one submission per participant against the rubric's attributes, and pages; an assignment keys its own
// fixture, keeps targets and warnings as rows, completes once and pages; a rolled-back unit leaves nothing; the db.*
// names throw; and the snapshot write types, names a missing reference and reads back what it wrote. Temporary
// databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  INSIGHT_COVERAGE_MIGRATION as MIGRATION, INSIGHT_COVERAGE_TABLES as TABLES, INSIGHT_COVERAGE_COLLECTIONS as COLLECTIONS,
  typeExposure, typeSuggestion, typeSession, typeFixture, typePlan, typeAssignment, typeSubmission,
} from '../repositories/insightCoverage.mjs';
import { boundGap } from '../domains/insight/insight.mjs';

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
const SCOUT2 = { id: 'usr-2', orgId: ORG.id, name: 'Tom', role: 'Scout', createdAt: 1 };
const RIVAL = { id: 'usr-9', orgId: 'org-rival', name: 'Rival', role: 'Scout', createdAt: 1 };
const DAY = 86_400_000;
const today = Math.floor(NOW / DAY);

// ------------------------------------------------------------- fixtures: the literals the routes write
const exposure = (over = {}) => ({ id: nextId('exp'), orgId: ORG.id, playerId: 'pl-adult', kind: 'impression', day: today, at: NOW, ...over });
const deferral = (over = {}) => ({ id: nextId('rvl'), orgId: ORG.id, playerId: 'pl-adult', byUserId: SCOUT.userId, dueAt: NOW + 3 * DAY, remindedAt: null, ...over });
const suggestion = (over = {}) => ({
  id: 'gap-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Ada', ruleId: 'no_recent_footage', ruleVersion: 1, records: ['med-1', 'med-2'],
  explanation: 'All 2 clips are older than 180 days.', status: 'suggested', requestedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const session = (over = {}) => ({
  id: 'cal-1', orgId: ORG.id, title: 'Wing play', templateId: 'tpl-gk', templateVersion: 1, mediaId: null,
  participants: [SCOUT.userId, SCOUT2.id], submissions: [], notes: [], status: 'open', createdBy: SCOUT.userId, createdAt: NOW, closedAt: null, ...over,
});
const submission = (userId, ratings, over = {}) => ({ userId, userName: 'Maria', ratings, confidence: 'medium', submittedAt: NOW, ...over });
const fixture = (over = {}) => ({ id: 'fix-1', orgId: ORG.id, competition: 'U21 League', home: 'Eastport U21', away: 'Rovers U21', date: '2026-10-01', location: { lat: 53.48, lng: -2.24, city: 'Manchester' }, createdBy: 'Maria', createdAt: NOW, ...over });
const plan = (over = {}) => ({ id: 'cvp-1', orgId: ORG.id, label: 'Autumn sweep', competition: 'U21 League', region: null, goalObservations: 2, windowDays: 90, createdBy: 'Maria', createdAt: NOW, ...over });
const assignment = (over = {}) => ({
  id: 'cva-1', orgId: ORG.id, fixture: { kind: 'own', id: 'fix-1' }, fixtureDate: '2026-10-01', fixtureLabel: 'Eastport U21 v Rovers U21', fixtureCompetition: 'U21 League',
  scoutUserId: SCOUT2.id, scoutName: 'Tom', targetPlayerIds: ['pl-adult'], travelBudget: { amountMinor: 4500, currency: 'GBP', enteredBy: 'Maria' },
  warnings: [], assignedBy: 'Maria', createdAt: NOW, observedAt: null, assessmentId: null, cancelledAt: null, ...over,
});

const FIX = () => ({ users: [...USERS(), SCOUT2], notifications: [], dispatches: [] });
function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.insightCoverage, grassroots: layer.grassroots, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}
const seeded = (label) => { const dir = tempDir(label); saveFixture(dir, FIX()); return { dir, s: serverOpen(dir) }; };

// ------------------------------------------------------------- schema
test('[schema] 0033 is registered after 0032 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0032_discovery') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s12d-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  assert.ok(typeExposure(exposure()).ok);
  assert.match(typeExposure(exposure({ kind: 'click' })).reason, /kind/);
  assert.match(typeSuggestion(suggestion({ ruleId: 'vibes' })).reason, /evidenceSuggestions gap-1\.ruleId/);
  assert.match(typeSuggestion(suggestion({ status: 'requested' })).reason, /requestedAt/);
  assert.match(typeSuggestion({ ...suggestion(), action: 'copy' }).reason, /carries field\(s\).*action/, 'the action copy is not stored');
  assert.match(typeSession(session({ participants: [SCOUT.userId] })).reason, /at least two/);
  assert.match(typeSession(session({ participants: [SCOUT.userId, SCOUT.userId] })).reason, /twice/);
  assert.match(typeSession(session({ status: 'closed' })).reason, /closedAt/);
  assert.match(typeSubmission(submission('usr-1', [{ attrId: 'a', value: 6 }]), 'sub').reason, /value must be a whole number from 1 to 5/);
  assert.match(typeSubmission(submission('usr-1', [{ attrId: 'a', value: 3 }, { attrId: 'a', notObserved: true }]), 'sub').reason, /twice/);
  assert.match(typeSubmission(submission('usr-1', [{ attrId: 'a', value: 3, notObserved: true }]), 'sub').reason, /value is absent/);
  assert.match(typeFixture(fixture({ date: '2026-02-30' })).reason, /fixtures fix-1\.date/, 'a day that does not exist');
  assert.match(typeFixture(fixture({ date: '2026-10' })).reason, /date/);
  assert.match(typeFixture(fixture({ location: { lat: 53.4, city: 'x' } })).reason, /location\.lng/, 'half a location');
  assert.match(typeFixture(fixture({ location: { lat: 95, lng: 0, city: '' } })).reason, /location/);
  assert.match(typePlan(plan({ goalObservations: 0 })).reason, /goalObservations/);
  assert.match(typePlan(plan({ windowDays: 400 })).reason, /windowDays/);
  assert.match(typeAssignment(assignment({ travelBudget: { amountMinor: -1, currency: 'GBP', enteredBy: null } })).reason, /travelBudget/);
  assert.match(typeAssignment(assignment({ travelBudget: { amountMinor: 1, currency: 'XYZ', enteredBy: null } })).reason, /currency/);
  assert.match(typeAssignment(assignment({ assessmentId: 'asm-1' })).reason, /assessmentId/);
  assert.match(typeAssignment(assignment({ warnings: [{ code: 'duplicate_visit' }, { code: 'duplicate_visit' }] })).reason, /once/);
});

// ------------------------------------------------------------- exposure and deferrals
test('[exposure] one event per (organisation, player, kind, day); figures by GROUP BY; the prune keeps the window', () => {
  const { dir, s } = seeded('s12d-exposure');
  const { exposure: ex } = s.repo;
  assert.equal(ex.record(exposure()), true);
  assert.equal(ex.record(exposure()), false, 'a second event on the same day is not recorded');
  ex.record(exposure({ kind: 'profile_view' })); ex.record(exposure({ playerId: 'pl-minor' }));
  ex.record(exposure({ day: today - 100, at: NOW - 100 * DAY }));
  assert.deepEqual(ex.distinctPlayersByKind(ORG.id, today - 90), { impression: 2, profile_view: 1, evidence_view: 0 });
  assert.deepEqual(ex.firstSeen(ORG.id, today - 200).find((x) => x.playerId === 'pl-adult'), { playerId: 'pl-adult', firstDay: today - 100 });
  assert.deepEqual(ex.forPlayer('pl-adult', today - 90), { byKind: { impression: 1, profile_view: 1, evidence_view: 0 }, orgCount: 1 });
  assert.equal(ex.prune(today - 90), 1, 'only the event before the window goes');
  assert.equal(s.repo.counts().exposureEvents, 3);
  refused(() => ex.record(exposure({ orgId: 'org-none' })), /FOREIGN KEY/i, 'an unknown organisation');
  s.close(); rm(dir);
});

test('[review later] a deferral is replaced; the due ones are found once; the staff member must be the organisation\'s', () => {
  const { dir, s } = seeded('s12d-later');
  const { reviewLater: rl } = s.repo;
  rl.defer(deferral({ id: 'rvl-1' }));
  rl.defer(deferral({ id: 'rvl-2', dueAt: NOW - 1 }));
  assert.equal(rl.byId('rvl-1'), null, 're-deferring replaces the earlier deferral');
  assert.equal(rl.isDeferred(ORG.id, 'pl-adult', NOW), false);
  assert.deepEqual(rl.dueForReminder(NOW).map((r) => r.id), ['rvl-2']);
  rl.markReminded('rvl-2', NOW);
  assert.deepEqual(rl.dueForReminder(NOW), [], 'a reminded deferral is not due again');
  refused(() => rl.markReminded('rvl-2', NOW), /INSIGHT_NOT_FOUND/);
  rl.defer(deferral({ id: 'rvl-3', playerId: 'pl-minor' }));
  assert.deepEqual([...rl.activeFor(ORG.id, NOW).keys()], ['pl-minor']);
  refused(() => rl.defer(deferral({ byUserId: 'usr-nobody' })), /INSIGHT_REFERENCE_MISSING.*byUserId/);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- evidence suggestions
test('[suggestions] reconcile supplies closed gaps, rewrites an open one only when it changed, keeps one open per rule', () => {
  const { dir, s } = seeded('s12d-gaps');
  const { suggestions: sg } = s.repo;
  const hit = (ruleId, records = ['med-1'], explanation = 'x') => ({ ruleId, ruleVersion: 1, records, explanation });
  let list = sg.reconcile({ orgId: ORG.id, playerId: 'pl-adult', playerName: 'Ada', found: [hit('no_recent_footage'), hit('stale_assessment')], at: NOW, mintId: () => nextId('gap') });
  assert.deepEqual(list.map((x) => [x.ruleId, x.status]), [['no_recent_footage', 'suggested'], ['stale_assessment', 'suggested']]);
  const [a, b] = list;
  list = sg.reconcile({ orgId: ORG.id, playerId: 'pl-adult', found: [hit('no_recent_footage')], at: NOW + 1000, mintId: () => nextId('gap') });
  assert.equal(list.find((x) => x.id === a.id).updatedAt, NOW, 'an unchanged open gap is not rewritten');
  assert.deepEqual([list.find((x) => x.id === b.id).status, list.find((x) => x.id === b.id).updatedAt], ['supplied', NOW + 1000], 'a gap that closed is supplied');
  list = sg.reconcile({ orgId: ORG.id, playerId: 'pl-adult', found: [hit('no_recent_footage', ['med-9'], 'y'), hit('stale_assessment')], at: NOW + 2000, mintId: () => nextId('gap') });
  assert.deepEqual(plain(list.find((x) => x.id === a.id).records), ['med-9']);
  assert.equal(list.length, 3, 'a rule that fires again after it was supplied is a new suggestion');
  assert.deepEqual([...sg.playerIdsWithStatus(ORG.id, 'supplied')], ['pl-adult']);
  // status moves
  sg.setStatus(a.id, 'requested', NOW + 3000);
  assert.equal(sg.byId(a.id).requestedAt, NOW + 3000);
  refused(() => sg.setStatus(a.id, 'reviewed', NOW), /requested cannot become reviewed/);
  assert.equal(sg.recentRequest(ORG.id, 'pl-adult', 'no_recent_footage', NOW, 'gap-other').id, a.id);
  assert.equal(sg.recentRequest(ORG.id, 'pl-adult', 'no_recent_footage', NOW, a.id), null);
  assert.equal(sg.forOrgById('org-rival', a.id), null, 'another organisation\'s id is no suggestion');
  // A rule's hit beyond the stored limits (hundreds of clips, a long rubric never observed) is bounded, never a failed read.
  const big = boundGap({ records: Array.from({ length: 300 }, (_, i) => `med-${i}`), explanation: 'x'.repeat(1700) });
  assert.deepEqual([big.records.length, big.explanation.length], [200, 1000]);
  sg.reconcile({ orgId: ORG.id, playerId: 'pl-big', found: [{ ruleId: 'single_match_sample', ruleVersion: 1, ...big }], at: NOW, mintId: () => nextId('gap') });
  assert.equal(sg.forOrgPlayer(ORG.id, 'pl-big')[0].records.length, 200);
  refused(() => s.store.sqlite.prepare("INSERT INTO evidence_suggestions (id, org_id, player_id, rule_id, rule_version, explanation, status, created_at, updated_at) VALUES ('gap-x', ?, 'pl-adult', 'no_recent_footage', 1, 'e', 'suggested', 1, 1)").run(ORG.id), /UNIQUE/, 'one open suggestion per rule');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- calibration
test('[calibration] pins the template version, one blind submission per participant against the rubric, notes, close and paging', () => {
  const { dir, s } = seeded('s12d-cal');
  const { calibration: cal } = s.repo;
  refused(() => cal.create(session({ templateVersion: 9 })), /no template tpl-gk v9/);
  refused(() => cal.create(session({ participants: [SCOUT.userId, RIVAL.id] })), /INSIGHT_REFERENCE_MISSING|another organisation/);
  const c = cal.create(session());
  assert.deepEqual(cal.attributesOf(c).map((a) => a.id), ['shot_stopping', 'distribution', 'command_of_area', 'one_v_one'], 'the rubric is the template version\'s');
  refused(() => cal.submit(c.id, submission(SCOUT.userId, [{ attrId: 'pace', value: 3 }])), /no attribute pace/);
  refused(() => cal.submit(c.id, submission('usr-nobody', [{ attrId: 'distribution', value: 3 }])), /not a participant/);
  cal.submit(c.id, submission(SCOUT2.id, [{ attrId: 'shot_stopping', value: 5 }, { attrId: 'distribution', notObserved: true }], { userName: 'Tom', confidence: 'high' }));
  refused(() => cal.submit(c.id, submission(SCOUT2.id, [{ attrId: 'shot_stopping', value: 2 }])), /already submitted/);
  const after = cal.addNote(c.id, { at: NOW, byUserId: SCOUT2.id, byName: 'Tom', text: 'Rubric anchor 3 is vague.' });
  assert.deepEqual(plain(after.submissions[0].ratings), [{ attrId: 'shot_stopping', value: 5, notObserved: false }, { attrId: 'distribution', notObserved: true }]);
  assert.equal(after.notes[0].text, 'Rubric anchor 3 is vague.');
  const closed = cal.close(c.id, NOW + 1);
  assert.deepEqual([closed.status, closed.closedAt], ['closed', NOW + 1]);
  refused(() => cal.submit(c.id, submission(SCOUT.userId, [{ attrId: 'distribution', value: 3 }])), /closed/);
  cal.create(session({ id: 'cal-2', createdAt: NOW + 5, participants: [SCOUT.userId, SCOUT2.id] }));
  const first = cal.page(ORG.id, { limit: 1 });
  assert.deepEqual(first.map((r) => r.id), ['cal-2', 'cal-1'], 'newest first, one row more than the page');
  assert.deepEqual(cal.page(ORG.id, { after: [NOW + 5, 'cal-2'], limit: 1 }).map((r) => [r.id, r.participants, r.submitted]), [['cal-1', 2, 1]]);
  assert.deepEqual(cal.page(ORG.id, { userId: 'usr-nobody' }), [], 'a non-lead sees only the sessions they take part in');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- coverage
test('[coverage] an assignment keys its own fixture, keeps targets and warnings, completes once, counts towards a plan and pages', () => {
  const { dir, s } = seeded('s12d-coverage');
  const { fixtures: fx, plans: pl, assignments: as } = s.repo;
  assert.deepEqual(plain(fx.create(fixture())), { ...plain(fixture()), source: 'own' });
  fx.create(fixture({ id: 'fix-2', date: '2026-09-01', location: null, competition: null }));
  assert.deepEqual(fx.forOrg(ORG.id).map((f) => f.id), ['fix-2', 'fix-1'], 'by date');
  const p = pl.create(plan());
  refused(() => as.create(assignment({ fixture: { kind: 'own', id: 'fix-none' } })), /no fixture fix-none/);
  as.create(assignment());
  // S13d: an assignment to a friendly or an open day is a key to it.
  refused(() => as.create(assignment({ id: 'cva-2', fixture: { kind: 'friendly_board', id: 'frd-7' } })), /no friendly frd-7/);
  refused(() => as.create(assignment({ id: 'cva-2', fixture: { kind: 'open_trial', id: 'open-7' } })), /no open day open-7/);
  s.grassroots.friendlies.create({ id: 'frd-7', orgId: ORG.id, postedByUserId: SCOUT2.id, ageGroup: 'u15', date: '2026-10-01', venue: '', notes: '', responses: [], createdAt: NOW });
  as.create(assignment({ id: 'cva-2', fixture: { kind: 'friendly_board', id: 'frd-7' }, travelBudget: null, targetPlayerIds: [], warnings: [{ code: 'scout_clash', scoutName: 'Tom' }], createdAt: NOW + 1 }));
  assert.ok(as.liveForFixture(ORG.id, { kind: 'own', id: 'fix-1' }));
  assert.equal(as.liveForFixture(ORG.id, { kind: 'open_trial', id: 'fix-1' }), null, 'the kind is part of the reference');
  assert.equal(as.scoutBusyOn(ORG.id, SCOUT2.id, '2026-10-01'), true);
  assert.deepEqual([...as.coveredKeys(ORG.id)].sort(), ['friendly_board:frd-7', 'own:fix-1']);
  assert.deepEqual(plain(as.byId('cva-1')), plain(assignment()), 'read back whole');
  assert.equal(pl.observationsFor(p, NOW - 90 * DAY), 0);
  const done = as.complete('cva-1', { at: NOW, assessmentId: 'asm-1' });
  assert.deepEqual([done.observedAt, done.assessmentId], [NOW, 'asm-1']);
  refused(() => as.complete('cva-1', { at: NOW }), /already completed/);
  assert.equal(pl.observationsFor(p, NOW - 90 * DAY), 1);
  assert.equal(pl.observationsFor(plan({ competition: 'Other' }), NOW - 90 * DAY), 0, 'a plan counts its own competition only');
  as.cancel('cva-2', NOW);
  assert.deepEqual(as.page(ORG.id).map((a) => a.id), ['cva-1'], 'a cancelled assignment leaves the list');
  assert.deepEqual(as.page(ORG.id, { scoutUserId: SCOUT.userId }), [], 'a scout sees their own');
  refused(() => s.store.sqlite.prepare('DELETE FROM fixtures WHERE id = ?').run('fix-1'), /FOREIGN KEY/i, 'an assigned fixture cannot go');
  s.close(); rm(dir);
});

test('[unit] a rolled-back unit leaves nothing, and the db.* names throw naming the repository', () => {
  const { dir, s } = seeded('s12d-unit');
  assert.throws(() => s.unit(() => { s.repo.fixtures.create(fixture()); s.repo.calibration.create(session()); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.fixtures.byId('fix-1'), null); assert.equal(s.repo.reads.calibration.byId('cal-1'), null);
  assert.equal(typeof s.repo.reads.fixtures.create, 'undefined', 'the reads cannot write');
  for (const n of COLLECTIONS) assert.throws(() => s.db[n], new RegExp(`db\\.${n} is gone: read it through the insightCoverage repository`));
  s.close(); rm(dir);
});

test('[snapshot] the write types every record, names a missing reference, and reads back what it wrote', () => {
  const dir = tempDir('s12d-snapshot');
  const cal = session({ submissions: [submission(SCOUT2.id, [{ attrId: 'distribution', value: 4, notObserved: false }])], notes: [{ at: NOW, byUserId: SCOUT2.id, byName: 'Tom', text: 'n' }] });
  saveFixture(dir, {
    ...FIX(),
    exposureEvents: [exposure({ id: 'exp-1' })], reviewLater: [deferral({ id: 'rvl-1' })], evidenceSuggestions: [suggestion()],
    calibrationSessions: [cal], fixtures: [fixture()], coveragePlans: [plan()], coverageAssignments: [assignment()],
  });
  const store = openStore(dir);
  const back = readTableBacked(store.sqlite);
  assert.deepEqual(plain(back.calibrationSessions), [plain(cal)]);
  assert.deepEqual(plain(back.coverageAssignments), [plain(assignment())]);
  assert.deepEqual(plain(back.evidenceSuggestions), [plain(suggestion())]);
  const snap = store.load();
  refused(() => store.save({ ...snap, db: { ...snap.db, coverageAssignments: [assignment({ fixture: { kind: 'own', id: 'fix-none' } })] } }), /INSIGHT_REFERENCE_MISSING.*fix-none/);
  refused(() => store.save({ ...snap, db: { ...snap.db, calibrationSessions: [session({ submissions: [submission(SCOUT2.id, [{ attrId: 'pace', value: 4 }])] })] } }), /attribute\(s\) its template does not have \(pace\)/);
  refused(() => store.save({ ...snap, db: { ...snap.db, fixtures: [fixture({ date: '01/10/2026' })] } }), /INSIGHT_IMPORT_BLOCKED.*date/);
  refused(() => store.save({ ...snap, db: { ...snap.db, exposureEvents: [exposure({ id: 'exp-a' }), exposure({ id: 'exp-b' })] } }), /same organisation, player, kind and day/);
  assert.deepEqual(readTableBacked(store.sqlite).coverageAssignments.map((a) => a.id), ['cva-1'], 'a refused write changed nothing');
  store.sqlite.close(); rm(dir);
});

console.log(`\n${passed} insight and coverage checks passed`);
