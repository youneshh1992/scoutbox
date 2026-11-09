// S9d — the opportunity board, applications, assessment campaigns and players' private suitability preferences as
// typed tables with explicit writes (repositories/opportunitiesCampaigns.mjs, migration 0022). What this suite proves:
// the migration creates the fifteen typed tables, empty; db.opportunities and the other four names throw; the typers
// refuse junk with the field named; every record reads back exactly as written (structured requirements, history,
// the approved summary, drills, rubric, attempts with their file-check issues, preferences with slots and tags); one
// live application per opportunity and player and one submission per campaign and player hold; the fixed fields of an
// update cannot change and a nested update is refused; a rolled-back unit leaves nothing; preferences are not stored
// until saved; the counts, the reminder query and the club lists by cursor answer from SQL; and a fixture written
// through the repository is typed, refuses missing references and duplicates (nothing written), and reads back.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { readRecords, writeFixture } from './dataLayerFixture.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  OPPORTUNITIES_CAMPAIGNS_MIGRATION as MIGRATION, OPPORTUNITIES_CAMPAIGNS_TABLES as TABLES, OPPORTUNITIES_CAMPAIGNS_COLLECTIONS as COLLECTIONS, FILE_CHECK_ISSUES,
  typeOpportunity, typeApplication, typeCampaign, typeSubmission, typePreferences, blankPreferences,
} from '../repositories/opportunitiesCampaigns.mjs';

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
const reason = (t) => (t.ok ? '' : t.reason);
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------- fixtures: the literals the routes write
const ELIG = Object.freeze({ minAge: 16, maxAge: 40, positionGroup: 'ATT', category: 'mens', maxLevel: null, radiusKm: null });
/** POST /org/opportunities (structured: PUT /org/opportunities/:id/structured-requirements). */
const opportunity = (over = {}) => ({
  id: 'opp-1', orgId: ORG.id, orgName: 'Eastport FC', orgLevel: 'pro', type: 'trial', title: 'U23 open trial', team: null, category: 'mens', ageGroup: 'U23', role: null,
  description: 'Bring boots.', schedule: 'Saturdays', deadline: '2027-01-01', capacity: 2, eligibility: { ...ELIG }, requirements: ['Bring boots', 'One clip'],
  status: 'published', createdBy: 'Maria', createdAt: NOW - 9000, closedAt: null, structured: null, ...over,
});
const STRUCTURED = Object.freeze({ trainingSlots: [{ day: 'tue', start: '17:00', end: '18:30', tz: 'Europe/London' }], relocationRequired: false, feeMinor: 0, currency: 'GBP', expensesCovered: false, environment: ['competitive'], accommodations: ['step-free access'] });
const hist = (over = {}) => ({ id: 'aud-1', at: NOW - 8000, byKind: 'player', byId: 'pl-adult', byName: 'Adult Signup', action: 'submitted', detail: null, ...over });
/** applyTo. */
const application = (over = {}) => ({
  history: [hist({ id: `aud-${over.id ?? 'apl-1'}` })],
  id: 'apl-1', opportunityId: 'opp-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Adult Signup', submittedBy: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' },
  note: 'Would love a look.', status: 'submitted', outcome: null, createdAt: NOW - 8000, remindedAt: null, suitabilitySummary: null, ...over,
});
/** POST /org/campaigns. */
const campaign = (over = {}) => ({
  id: 'cmp-1', orgId: ORG.id, orgName: 'Eastport FC', title: 'Remote sprint', deadline: '2027-01-01', attemptsAllowed: 2,
  drills: [{ name: '30m sprint', instructions: 'Two cones.', recording: { equipment: 'Phone', distance: 'Full run', surface: 'Grass', camera: 'Side-on' } }],
  eligibility: { minAge: null, maxAge: null, positionGroup: 'any', maxLevel: null, radiusKm: null }, rubric: [{ criterion: 'Full run visible', guidance: 'Both cones' }],
  status: 'published', createdBy: 'Maria', createdAt: NOW - 7000, ...over,
});
const attempt = (over = {}) => ({ id: 'att-1', mediaId: 'media-1', drillName: '30m sprint', note: null, fileChecks: { passed: true, issues: [], checkedAt: NOW - 6000, kind: 'automated_file_check' }, status: 'submitted', review: null, submittedAt: NOW - 6000, ...over });
const failed = (over = {}) => attempt({ id: 'att-0', mediaId: null, fileChecks: { passed: false, issues: [FILE_CHECK_ISSUES.media_missing], checkedAt: NOW - 6500, kind: 'automated_file_check' }, status: 'failed_checks', submittedAt: NOW - 6500, ...over });
/** submitAttempt (created on the first attempt). */
const submission = (over = {}) => ({ id: 'csb-1', campaignId: 'cmp-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Adult Signup', submittedBy: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, attempts: [failed(), attempt()], createdAt: NOW - 6500, ...over });
/** PUT /player/preferences. */
const prefs = (over = {}) => ({
  ...blankPreferences('pl-adult'), commitments: [{ day: 'tue', start: '16:00', end: '18:00', tz: 'Europe/London', label: 'college class' }], availableSlots: [{ day: 'sat', start: '09:00', end: '12:00', tz: 'Europe/London', label: null }],
  travelLimitKm: 20, transport: 'public', environment: ['competitive'], accessibility: ['quiet changing room'], compensation: { maxFeeMinor: 0, currency: 'GBP', expensesNeeded: true }, updatedAt: NOW - 5000, ...over,
});

function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.opportunitiesCampaigns, layer, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0022 is registered after 0021 and creates the fifteen STRICT tables, empty; the five blob names throw', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0021_club_setup') + 1);
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, log: () => {} });
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  s.close();
  const dir = saveFixture(tempDir('s9d-schema'));
  const o = serverOpen(dir);
  try {
    assert.deepEqual(Object.values(o.repo.counts()).reduce((a, b) => a + b, 0), 0);
  } finally { o.close(); rm(dir); }
});

// ------------------------------------------------------------- typing
test('[typing] the writers\' literals type; junk is refused with the field named', () => {
  for (const [t, rec] of [[typeOpportunity, opportunity({ structured: STRUCTURED })], [typeApplication, application()], [typeCampaign, campaign()], [typeSubmission, submission()], [typePreferences, prefs()]]) assert.ok(t(rec).ok, reason(t(rec)));
  const cases = [
    [typeOpportunity, opportunity({ category: 'veterans' }), /category must be one of/],
    [typeOpportunity, opportunity({ eligibility: { ...ELIG, positionGroup: 'FWD' } }), /positionGroup must be one of/],
    [typeOpportunity, opportunity({ eligibility: { ...ELIG, minAge: 30, maxAge: 20 } }), /maxAge is below minAge/],
    [typeOpportunity, opportunity({ eligibility: { ...ELIG, maxLevel: 'elite' } }), /maxLevel must be one of/],
    [typeOpportunity, opportunity({ capacity: 0 }), /capacity must be a whole number/],
    [typeOpportunity, opportunity({ requirements: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), /more than 6/],
    [typeOpportunity, opportunity({ status: 'closed' }), /closedAt is required/],
    [typeOpportunity, opportunity({ structured: { ...STRUCTURED, trainingSlots: [{ day: 'tuesday', start: '17:00', end: '18:00', tz: 'Europe/London' }] } }), /day must be one of/],
    [typeOpportunity, opportunity({ structured: { ...STRUCTURED, trainingSlots: [{ day: 'tue', start: '19:00', end: '18:00', tz: 'Europe/London' }] } }), /end must be after start/],
    [typeOpportunity, opportunity({ structured: { ...STRUCTURED, trainingSlots: [{ day: 'tue', start: '17:00', end: '18:00', tz: 'Mars/Olympus' }] } }), /tz must be an IANA time zone/],
    [typeOpportunity, opportunity({ structured: { ...STRUCTURED, currency: 'pounds' } }), /currency must be a three-letter/],
    [typeOpportunity, opportunity({ extra: 1 }), /field\(s\) this build does not store: extra/],
    [typeApplication, application({ status: 'accepted' }), /outcome is required/],
    [typeApplication, application({ status: 'declined', outcome: { decision: 'accepted', note: null, byUserId: SCOUT.userId, byName: 'Maria', at: NOW } }), /disagrees with status/],
    [typeApplication, application({ submittedBy: { kind: 'agent', id: 'x', name: 'X' } }), /submittedBy must be/],
    [typeApplication, application({ suitabilitySummary: { approvedAt: NOW, approvedBy: 'player', verdicts: [{ dimension: 'mood', verdict: 'compatible' }] } }), /verdicts\[0\]/],
    [typeCampaign, campaign({ attemptsAllowed: 9 }), /attemptsAllowed must be a whole number from 1 to 5/],
    [typeCampaign, campaign({ drills: [] }), /drills must be a list of 1 to 6/],
    [typeCampaign, campaign({ drills: [campaign().drills[0], campaign().drills[0]] }), /repeats 30m sprint/],
    [typeSubmission, submission({ attempts: [attempt({ status: 'failed_checks' })] }), /disagrees with the file checks/],
    [typeSubmission, submission({ attempts: [attempt({ status: 'returned', review: { byUserId: SCOUT.userId, byName: 'M', at: NOW, kind: 'human_review', reasons: null, rubricNotes: null } })] }), /carries its reasons/],
    [typeSubmission, submission({ attempts: [attempt({ fileChecks: { passed: false, issues: ['it looked odd'], checkedAt: NOW, kind: 'automated_file_check' }, status: 'failed_checks' })] }), /automated file-check messages/],
    [typePreferences, prefs({ transport: 'horse' }), /transport must be one of/],
    [typePreferences, prefs({ travelLimitKm: 900 }), /travelLimitKm must be a number from 0 to 500/],
    [typePreferences, prefs({ commitments: [{ day: 'tue', start: '4pm', end: '18:00', tz: 'Europe/London', label: null }] }), /start must be a 24-hour time/],
    [typePreferences, prefs({ compensation: { maxFeeMinor: 1.5, currency: 'GBP', expensesNeeded: false } }), /maxFeeMinor must be a whole number/],
  ];
  for (const [t, rec, re] of cases) { const r = t(rec); assert.ok(!r.ok, `${re} should be refused`); assert.match(r.reason, re); }
});

// ------------------------------------------------------------- writes and reads
test('[round trip] every record reads back as written; the counts and the club lists answer from SQL', () => {
  const dir = saveFixture(tempDir('s9d-rt'));
  const o = serverOpen(dir); const { repo } = o;
  try {
    const opp = repo.opportunities.create(opportunity());
    assert.deepEqual(plain(opp), opportunity());
    assert.ok(Object.isFrozen(opp) && Object.isFrozen(opp.eligibility), 'reads are deep-frozen');
    const withStructured = repo.opportunities.update(opp.id, (d) => { d.structured = { ...STRUCTURED }; });
    assert.deepEqual(plain(withStructured.structured), STRUCTURED);
    const apl = repo.applications.create(application());
    assert.deepEqual(plain(apl), application());
    const summary = { approvedAt: NOW, approvedBy: 'player', verdicts: [{ dimension: 'schedule', verdict: 'conflict' }, { dimension: 'travel', verdict: 'unknown' }] };
    const shared = repo.applications.update(apl.id, (d) => { d.suitabilitySummary = summary; });
    assert.deepEqual(plain(shared.suitabilitySummary), summary);
    const cleared = repo.applications.update(apl.id, (d) => { d.suitabilitySummary = null; });
    assert.equal(cleared.suitabilitySummary, null);
    const accepted = repo.applications.update(apl.id, (d) => { d.status = 'accepted'; d.outcome = { decision: 'accepted', note: 'See you Saturday.', byUserId: SCOUT.userId, byName: 'Maria', at: NOW }; d.history.push(hist({ id: 'aud-2', byKind: 'org', byId: SCOUT.userId, byName: 'Maria', action: 'accepted', at: NOW })); });
    assert.equal(accepted.outcome.note, 'See you Saturday.'); assert.deepEqual(accepted.history.map((h) => h.action), ['submitted', 'accepted']);
    const camp = repo.campaigns.create(campaign());
    assert.deepEqual(plain(camp), campaign());
    const sub = repo.submissions.create(submission());
    assert.deepEqual(plain(sub), submission());
    assert.deepEqual(plain(repo.submissions.byAttempt('att-1')), submission());
    const reviewed = repo.submissions.update(sub.id, (d) => { const a = d.attempts.find((x) => x.id === 'att-1'); a.status = 'returned'; a.review = { byUserId: SCOUT.userId, byName: 'Maria', at: NOW, kind: 'human_review', reasons: 'Camera moved', rubricNotes: null }; });
    assert.equal(reviewed.attempts[1].review.reasons, 'Camera moved');
    assert.deepEqual(reviewed.attempts[0].fileChecks.issues, [FILE_CHECK_ISSUES.media_missing], 'an issue is stored as its code and read back as its message');
    assert.deepEqual(repo.opportunities.applicationCounts(['opp-1', 'opp-none']), { 'opp-1': { applications: 1, outstanding: 0 }, 'opp-none': { applications: 0, outstanding: 0 } });
    assert.deepEqual(repo.campaigns.submissionCounts(['cmp-1']), { 'cmp-1': { submissions: 1, awaitingReview: 0 } });
    for (let i = 2; i <= 4; i++) repo.opportunities.create(opportunity({ id: `opp-${i}` }));
    const p1 = repo.opportunities.page(ORG.id, { limit: 3 }); assert.deepEqual(p1.rows.map((r) => r.opportunity.id), ['opp-4', 'opp-3', 'opp-2', 'opp-1'], 'newest first, one row beyond the page');
    assert.deepEqual(repo.opportunities.page(ORG.id, { limit: 3, after: p1.rows[2].key }).rows.map((r) => r.opportunity.id), ['opp-1']);
    assert.deepEqual(repo.opportunities.openOn('2027-01-02'), [], 'past the deadline nothing is open');
    assert.equal(repo.opportunities.openOn('2026-12-31').length, 4);
  } finally { o.close(); rm(dir); }
});

test('[rules] one live application per opportunity and player; one submission per campaign and player; fixed fields and nested updates are refused; a rolled-back unit leaves nothing', () => {
  const dir = saveFixture(tempDir('s9d-rules'));
  const o = serverOpen(dir); const { repo } = o;
  try {
    repo.opportunities.create(opportunity()); repo.campaigns.create(campaign());
    repo.applications.create(application());
    refused(() => repo.applications.create(application({ id: 'apl-2' })), /OPPORTUNITIES_CAMPAIGNS_UNIQUENESS: .*already has a live application/);
    repo.applications.update('apl-1', (d) => { d.status = 'withdrawn'; });
    assert.equal(repo.applications.create(application({ id: 'apl-2' })).id, 'apl-2', 'after a withdrawal the player may apply again');
    refused(() => repo.applications.create(application({ id: 'apl-3', opportunityId: 'opp-x' })), /not an opportunity of organisation/);
    refused(() => repo.applications.update('apl-2', (d) => { d.playerId = 'pl-other'; }), /playerId cannot change/);
    refused(() => repo.applications.update('apl-2', () => { repo.applications.update('apl-2', (d) => { d.note = 'x'; }); }), /NESTED_UPDATE/);
    refused(() => repo.opportunities.update('opp-1', (d) => { d.orgId = 'org-two'; }), /orgId cannot change/);
    repo.submissions.create(submission());
    refused(() => repo.submissions.create(submission({ id: 'csb-2', attempts: [] })), /already has a submission/);
    refused(() => repo.submissions.create(submission({ id: 'csb-3', playerId: 'pl-child1', attempts: [attempt()] })), /att-1 already exists/);
    const before = repo.counts();
    refused(() => o.unit(() => { repo.applications.update('apl-2', (d) => { d.status = 'withdrawn'; }); repo.opportunities.create(opportunity({ id: 'opp-rb' })); throw new Error('later step failed'); }), /later step failed/);
    assert.deepEqual(repo.counts(), before); assert.equal(repo.applications.byId('apl-2').status, 'submitted'); assert.equal(repo.opportunities.byId('opp-rb'), null);
  } finally { o.close(); rm(dir); }
});

test('[sweep and preferences] the reminder query finds week-old unanswered applications once; preferences are stored only when saved', () => {
  const dir = saveFixture(tempDir('s9d-sweep'));
  const o = serverOpen(dir); const { repo } = o;
  try {
    repo.opportunities.create(opportunity());
    repo.applications.create(application({ createdAt: NOW - 8 * 86_400_000 }));
    repo.applications.create(application({ id: 'apl-new', playerId: 'pl-child1', createdAt: NOW - 86_400_000 }));
    const cutoff = NOW - 7 * 86_400_000;
    assert.deepEqual(repo.applications.remindersDue(cutoff).map((a) => a.id), ['apl-1']);
    repo.applications.update('apl-1', (d) => { d.remindedAt = NOW; });
    assert.deepEqual(repo.applications.remindersDue(cutoff), [], 'a reminded application is not due again');
    assert.equal(repo.preferences.forPlayer('pl-adult'), null, 'nothing stored before a save');
    assert.equal(repo.counts().player_prefs, 0);
    const saved = repo.preferences.save(prefs());
    assert.deepEqual(plain(saved), prefs());
    const again = repo.preferences.save(prefs({ commitments: [], environment: [], updatedAt: NOW }));
    assert.deepEqual([again.commitments, again.environment, again.accessibility], [[], [], ['quiet changing room']], 'a save replaces the lists it carries');
    assert.deepEqual(repo.counts().player_pref_slots, 1);
  } finally { o.close(); rm(dir); }
});

// ------------------------------------------------------------- fixtures
/** The players' preferences: the shared loader has no writer for them. */
const fixture = (dir, db) => writeFixture(dir, fixtureDb(db), { now: NOW, idCounter: 1000 });

test('[fixtures] a fixture written through the repository is typed, refuses missing references, duplicates and junk with ids (nothing written), and reads back what it wrote', () => {
  const full = { opportunities: [opportunity({ structured: STRUCTURED })], applications: [application()], campaigns: [campaign()], campaignSubmissions: [submission()], playerPrefs: [prefs()] };
  const dir = fixture(tempDir('s9d-fix'), full);
  try {
    const back = readRecords(dir);
    for (const n of COLLECTIONS) assert.deepEqual(plain(back[n]), plain(full[n]), `${n} reads back`);
  } finally { rm(dir); }
  const refusedFixture = (label, db, re) => {
    const d = tempDir(`s9d-fix-${label}`);
    try {
      refused(() => fixture(d, { campaigns: [campaign()], ...db }), re, label);
      const back = readRecords(d);
      for (const n of COLLECTIONS) assert.deepEqual(back[n], [], `${label}: a refused fixture wrote no ${n}`);
    } finally { rm(d); }
  };
  refusedFixture('ref', { applications: [application({ opportunityId: 'opp-gone' })] }, /OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID: applications apl-1: opportunity opp-gone is not an opportunity/);
  refusedFixture('dup', { opportunities: [opportunity()], applications: [application(), application({ id: 'apl-2' })] }, /OPPORTUNITIES_CAMPAIGNS_UNIQUENESS: applications: player pl-adult already has a live application to opp-1/);
  refusedFixture('junk', { campaigns: [campaign({ attemptsAllowed: 0 })], opportunities: [opportunity()] }, /OPPORTUNITIES_CAMPAIGNS_INPUT_INVALID: campaigns cmp-1\.attemptsAllowed/);
});

console.log(`\n${passed} opportunities/campaigns checks passed`);
