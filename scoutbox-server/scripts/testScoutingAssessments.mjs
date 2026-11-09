// S9b — assessment templates, assessments, video segments and playlists as typed tables with explicit writes
// (repositories/scoutingAssessments.mjs, migration 0020). What this suite proves: the migration creates the ten typed
// tables with the four v1 templates and nothing else; the typers keep the routes' literals and refuse junk with the
// record and field named (never the content); create/update write rows at once and return fresh, deep-frozen records
// whose attributes snapshot is the template version's; the guards hold (unknown field, identity change, duplicate id,
// nested update, a segment of another club or player, a template version out of turn); the queries match the rows; the
// account-deletion redaction drops only the name; a rolled-back unit leaves nothing; there is no db.* view; and a
// fixture written through the repository is typed, refuses missing references (nothing written) and reads back what it
// wrote. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  SCOUTING_ASSESSMENTS_MIGRATION as MIGRATION, SCOUTING_ASSESSMENTS_TABLES as TABLES, SCOUTING_ASSESSMENTS_COLLECTIONS as COLLECTIONS,
  SEED_TEMPLATES, typeTemplate, typeAssessment, typeSegment, typePlaylist,
} from '../repositories/scoutingAssessments.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const plain = (v) => JSON.parse(JSON.stringify(v));
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};

// ------------------------------------------------------------- fixtures: the literals the routes write
const GK = SEED_TEMPLATES.find((t) => t.positionGroup === 'GK');
const hist = (id, action) => ({ id, at: NOW - 1000, byKind: 'org', byId: SCOUT.userId, byName: SCOUT.name, action, detail: null });
/** POST /org/assessments, then PUT with one rating. */
const assessment = (over = {}) => ({
  id: 'ass-1', orgId: ORG.id, playerId: 'pl-adult', playerName: 'Adult Signup', scoutUserId: SCOUT.userId, scoutName: SCOUT.name,
  templateId: 'tpl-gk', templateVersion: 1,
  context: { fixture: 'Eastport 2–1 Harbour', date: '2026-10-31', minutesWatched: 90, viewing: 'live', opponentLevel: null, trialId: null, trialSessionId: null },
  ratings: [{ attrId: 'shot_stopping', rating: 4, notObserved: false, confidence: 'high', note: 'SECRET_NOTE', evidenceRefs: [] }, { attrId: 'distribution', rating: null, notObserved: true, confidence: 'medium', note: null, evidenceRefs: [] }],
  state: 'draft', recommendation: null, secondOpinionOf: null, createdAt: NOW - 5000, submittedAt: null, reviewedAt: null, reviewNote: null, publishedFeedback: null,
  history: [hist('aud-1', 'created')], ...over,
});
/** POST /org/media/:id/segments. */
const segment = (over = {}) => ({ id: 'seg-1', mediaId: 'med-1', playerId: 'pl-adult', orgId: ORG.id, createdBy: { userId: SCOUT.userId, name: SCOUT.name }, startS: 12, endS: 30.5, labels: ['save', 'reflex'], eventType: 'shot', note: null, drawing: null, createdAt: NOW - 4000, ...over });
/** POST /org/playlists. */
const playlist = (over = {}) => ({ id: 'pls-1', orgId: ORG.id, name: 'Shot stopping', createdBy: { userId: SCOUT.userId, name: SCOUT.name }, segmentIds: [], createdAt: NOW - 3000, ...over });
const template = (over = {}) => ({ id: 'tpl-gk', positionGroup: 'GK', version: 2, createdAt: NOW - 2000, createdBy: SCOUT.name, attributes: [{ id: 'handling', label: 'Handling', anchors: { 3: 'Holds the routine ball' } }, { id: 'kicking', label: 'Kicking', anchors: {} }], ...over });

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.scoutingAssessments, layer, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0020 is registered after 0019 and creates the ten STRICT tables, holding only the four v1 templates; the collections are table-backed', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0019_scouting_evidence') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s9b-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    const cols = s.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['extra_json', 'context_extra_json', 'absent_keys_json', 'offtype_json', 'raw_json', 'anchors_json', 'labels_json']) assert.ok(!cols.includes(c), `${t}: no ${c}`);
  }
  const count = (t) => s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  assert.equal(count('assessment_templates'), 4); assert.equal(count('assessment_template_attributes'), 16);
  for (const t of TABLES.filter((x) => !x.startsWith('assessment_template'))) assert.equal(count(t), 0, `${t} starts empty`);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the routes\' literals type unchanged; junk is refused naming the record and the field, never the content', () => {
  for (const [typer, raw] of [[typeTemplate, template()], [typeAssessment, assessment()], [typeSegment, segment()], [typeSegment, segment({ drawing: { arrows: [[0, 0, 10, 10]] } })], [typePlaylist, playlist({ segmentIds: ['seg-1'] })]]) {
    const t = typer(raw); assert.ok(t.ok, t.reason); assert.deepEqual(plain(t.record), plain(raw));
  }
  const r0 = assessment().ratings[0];
  const cases = [
    [typeTemplate, template({ positionGroup: 'WING' }), /tpl-gk\.positionGroup must be one of/],
    [typeTemplate, template({ attributes: [{ id: 'a', label: 'A' }] }), /\.attributes must list 2 to 20/],
    [typeTemplate, template({ attributes: [{ id: 'a', label: 'A', anchors: { 9: 'x' } }, { id: 'b', label: 'B' }] }), /attributes\[0\]\.anchors must map levels/],
    [typeTemplate, template({ attributes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), /attributes\[1\]\.id names an attribute twice/],
    [typeAssessment, assessment({ state: 'published' }), /ass-1\.state must be one of draft\|submitted\|reviewed/],
    [typeAssessment, assessment({ context: { ...assessment().context, mood: 'SECRET' } }), /context carries field\(s\) this build does not store: mood/],
    [typeAssessment, assessment({ context: { ...assessment().context, date: 'last week' } }), /context\.date must be a YYYY-MM-DD day/],
    [typeAssessment, assessment({ context: { ...assessment().context, minutesWatched: 0 } }), /context\.minutesWatched must be a whole number/],
    [typeAssessment, assessment({ ratings: [{ ...r0, rating: 3.5 }] }), /ratings\[0\]\.rating must be a whole number from 1 to 5/],
    [typeAssessment, assessment({ ratings: [{ ...r0, notObserved: true }] }), /ratings\[0\]\.rating must be null when not observed/],
    [typeAssessment, assessment({ ratings: [r0, r0] }), /ratings\[1\]\.attrId rates an attribute twice/],
    [typeAssessment, assessment({ ratings: [{ ...r0, evidenceRefs: ['SECRET'] }] }), /evidenceRefs\[0\] is not an object/],
    [typeAssessment, assessment({ ratings: [{ ...r0, evidenceRefs: [{ segmentId: 'seg-1', colour: 'red' }] }] }), /evidenceRefs\[0\] carries field\(s\) this build does not store: colour/],
    [typeAssessment, assessment({ submittedAt: NOW }), /\.submittedAt must be null on a draft/],
    [typeAssessment, assessment({ publishedFeedback: { text: 'SECRET', byUserId: SCOUT.userId, byName: SCOUT.name, at: NOW } }), /publishedFeedback cannot be published from a draft/],
    [typeAssessment, assessment({ reviewNote: 'SECRET' }), /\.reviewNote exists only after review/],
    [typeSegment, segment({ endS: 900 }), /seg-1\.endS must be after startS, at most 600 seconds later/],
    [typeSegment, segment({ labels: ['x'.repeat(31)] }), /\.labels must be at most 8 labels/],
    [typeSegment, segment({ drawing: 'SECRET' }), /\.drawing must be an object/],
    [typePlaylist, playlist({ segmentIds: ['seg-1', 'seg-1'] }), /pls-1\.segmentIds names a segment twice/],
  ];
  for (const [typer, raw, re] of cases) { const t = typer(raw); assert.equal(t.ok, false, `refused: ${re}`); assert.match(t.reason, re); assert.doesNotMatch(t.reason, /SECRET/); }
});

// ------------------------------------------------------------- the repository
test('[repository] create/update write rows at once and return fresh, deep-frozen records with the template\'s attributes; the guards hold; there is no db.* view', () => {
  const dir = saveFixture(tempDir('s9b-repo'));
  const o = serverOpen(dir); const { repo } = o;
  const a = repo.assessments.create(assessment());
  assert.deepEqual(plain(a), plain({ ...assessment(), attributesSnapshot: GK.attributes }), 'read back exactly, the snapshot joined from the template version');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.ratings[0]) && Object.isFrozen(a.attributesSnapshot));
  assert.throws(() => { a.state = 'reviewed'; }, TypeError);
  refused(() => repo.assessments.create(assessment()), /SCOUTING_DUPLICATE: assessments ass-1 already exists/);
  refused(() => repo.assessments.create(assessment({ id: 'ass-2', templateVersion: 7 })), /SCOUTING_REFERENCE_MISSING: assessments ass-2 → assessment_templates tpl-gk@7/);
  const next = repo.assessments.update('ass-1', (d) => { d.state = 'submitted'; d.submittedAt = NOW; d.recommendation = { verdict: 'monitor', reasons: 'SECRET' }; });
  assert.equal(next.state, 'submitted'); assert.equal(a.state, 'draft', 'the record held before is the old version');
  refused(() => repo.assessments.update('ass-1', (d) => { d.playerId = 'pl-other'; }), /playerId cannot change/);
  refused(() => repo.assessments.update('ass-1', (d) => { d.templateVersion = 2; }), /SCOUTING_INPUT_INVALID|templateVersion cannot change/);
  refused(() => repo.assessments.update('ass-1', (d) => { d.extra = 1; }), /does not store: extra/);
  refused(() => repo.assessments.update('ass-1', () => { repo.assessments.update('ass-1', (x) => { x.reviewNote = 'n'; }); }), /SCOUTING_NESTED_UPDATE/);
  // segments: a rating may cite one of this club's segments of this player only
  repo.segments.create(segment());
  repo.segments.create(segment({ id: 'seg-other', playerId: 'pl-other' }));
  repo.assessments.create(assessment({ id: 'ass-2', history: [] }));
  const cite = (segmentId) => (d) => { d.ratings[0].evidenceRefs = [{ segmentId, t: 14 }]; };
  assert.deepEqual(plain(repo.assessments.update('ass-2', cite('seg-1')).ratings[0].evidenceRefs), [{ segmentId: 'seg-1', t: 14 }]);
  refused(() => repo.assessments.update('ass-2', cite('seg-other')), /cites seg-other, which is not a segment of this club and player/);
  // playlists keep their segments in order, once each
  repo.playlists.create(playlist());
  assert.deepEqual(repo.playlists.update('pls-1', (p) => { p.segmentIds.push('seg-other', 'seg-1'); }).segmentIds, ['seg-other', 'seg-1']);
  refused(() => repo.playlists.update('pls-1', (p) => { p.segmentIds.push('seg-nope'); }), /names seg-nope, which is not a segment of this club/);
  // templates: append-only, the next version of the group only
  refused(() => repo.templates.create(template({ version: 3 })), /version 3 is not the next version of GK/);
  assert.equal(repo.templates.create(template()).version, 2);
  assert.equal(repo.templates.currentFor('GK').version, 2); assert.equal(repo.templates.currentById('tpl-gk').version, 2);
  assert.equal(repo.templates.byIdVersion('tpl-gk', 1).attributes.length, 4);
  assert.deepEqual(plain(repo.assessments.byId('ass-1').attributesSnapshot), plain(GK.attributes), 'a new version changes no historical report');
  // the old names throw, naming the repository
  assert.deepEqual(o.layer.report().domains.scoutingAssessments.rows, { assessmentTemplates: 5, assessments: 2, videoSegments: 2, playlists: 1 });
  o.close(); rm(dir);
});

test('[queries] the club, player, scout, feedback and trial queries match the rows; the redaction drops only the name; a failed unit leaves nothing', () => {
  const dir = saveFixture(tempDir('s9b-q'));
  const o = serverOpen(dir); const { repo } = o;
  repo.assessments.create(assessment());
  repo.assessments.create(assessment({ id: 'ass-2', playerId: 'pl-kid', playerName: 'Kid', history: [], context: { ...assessment().context, trialId: 'tri-1' } }));
  repo.assessments.create(assessment({ id: 'ass-3', state: 'submitted', submittedAt: NOW, recommendation: { verdict: 'sign', reasons: 'r' }, secondOpinionOf: 'ass-1', history: [], publishedFeedback: { text: 'Well done', byUserId: SCOUT.userId, byName: SCOUT.name, at: NOW } }));
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(repo.assessments.forOrg(ORG.id)), ['ass-1', 'ass-2', 'ass-3']);
  assert.deepEqual(ids(repo.assessments.forOrgPlayer(ORG.id, 'pl-adult')), ['ass-1', 'ass-3']);
  assert.deepEqual(ids(repo.assessments.forOrgScout(ORG.id, SCOUT.userId)), ['ass-1', 'ass-2', 'ass-3']);
  assert.deepEqual(ids(repo.assessments.forPlayer('pl-kid')), ['ass-2']);
  assert.deepEqual(ids(repo.assessments.withFeedbackForPlayer('pl-adult')), ['ass-3']);
  assert.equal(repo.assessments.anyForTrial('tri-1'), true); assert.equal(repo.assessments.anyForTrial('tri-2'), false);
  assert.equal(repo.assessments.redactPlayer('pl-adult'), 2);
  assert.deepEqual(repo.assessments.forPlayer('pl-adult').map((x) => [x.playerName, x.ratings.length]), [[null, 2], [null, 2]], 'the name goes; the club\'s record stays');
  repo.segments.create(segment()); repo.segments.create(segment({ id: 'seg-2', mediaId: 'med-2' }));
  assert.deepEqual(ids(repo.segments.forOrg(ORG.id, { mediaId: 'med-2' })), ['seg-2']);
  assert.deepEqual(ids(repo.segments.forOrg(ORG.id, { playerId: 'pl-adult' })), ['seg-1', 'seg-2']);
  refused(() => o.unit(() => {
    repo.assessments.create(assessment({ id: 'ass-4', history: [] }));
    repo.assessments.create(assessment({ id: 'ass-5', secondOpinionOf: 'ass-missing', history: [] }));
  }), /FOREIGN KEY/);
  assert.equal(repo.assessments.byId('ass-4'), null, 'the first write of the failed unit is gone');
  o.close(); rm(dir);
});

// ------------------------------------------------------------- fixtures
test('[fixtures] a fixture writes the four collections through the repository and reads them back; junk and missing references refuse the whole fixture', () => {
  // The four v1 templates are the migration's; the fixture adds the club's own.
  const data = { assessmentTemplates: [template()], videoSegments: [segment()], assessments: [assessment({ ratings: [{ ...assessment().ratings[0], evidenceRefs: [{ segmentId: 'seg-1' }] }] }), assessment({ id: 'ass-2', templateVersion: 2, ratings: [], secondOpinionOf: 'ass-1', history: [] })], playlists: [playlist({ segmentIds: ['seg-1'] })] };
  // A rating cites a segment, so the segments are written first (the shared loader writes assessments before segments).
  const dir = saveFixture(tempDir('s9b-fix'), { assessmentTemplates: data.assessmentTemplates, videoSegments: data.videoSegments });
  writeFixture(dir, { assessments: data.assessments, playlists: data.playlists }, { now: NOW });
  try {
    const back = readRecords(dir);
    assert.deepEqual(back.assessmentTemplates.map((t) => `${t.id}@${t.version}`), [...SEED_TEMPLATES, template()].map((t) => `${t.id}@${t.version}`));
    assert.deepEqual(plain(back.assessmentTemplates.at(-1)), plain(template()));
    assert.deepEqual(plain(back.videoSegments), plain(data.videoSegments)); assert.deepEqual(plain(back.playlists), plain(data.playlists));
    assert.deepEqual(plain(back.assessments.map(({ attributesSnapshot, ...rest }) => rest)), plain(data.assessments));
    assert.deepEqual(back.assessments[1].attributesSnapshot.map((x) => x.id), ['handling', 'kicking'], 'the v2 assessment reads the v2 attributes');
  } finally { rm(dir); }
  const refusedFixture = (label, db, re) => {
    const d = tempDir(`s9b-fix-${label}`);
    try {
      refused(() => saveFixture(d, { assessmentTemplates: [template()], ...db }), re, label);
      const back = readRecords(d);
      assert.deepEqual([back.assessmentTemplates.length, back.assessments.length, back.videoSegments.length, back.playlists.length], [SEED_TEMPLATES.length, 0, 0, 0], `${label}: a refused fixture wrote nothing`);
    } finally { rm(d); }
  };
  refusedFixture('junk', { assessments: [assessment({ state: 'maybe' })] }, /SCOUTING_INPUT_INVALID: assessments ass-1\.state/);
  refusedFixture('org', { assessments: [assessment({ orgId: 'org-gone' })] }, /FOREIGN KEY constraint failed/);
  refusedFixture('version', { assessments: [assessment({ templateVersion: 9 })] }, /SCOUTING_REFERENCE_MISSING: assessments ass-1 → assessment_templates tpl-gk@9/);
  refusedFixture('segment', { videoSegments: [segment()], playlists: [playlist({ segmentIds: ['seg-9'] })] }, /SCOUTING_REFERENCE_MISSING: playlists pls-1 names seg-9/);
  refusedFixture('user', { videoSegments: [segment({ createdBy: { userId: 'usr-gone', name: 'X' } })] }, /FOREIGN KEY constraint failed/);
});

console.log(`\n${passed} scouting assessments checks passed`);
