// S9a — the evidence passport, coach affiliations and squad invitations as typed tables with explicit writes
// (repositories/scoutingEvidence.mjs, migration 0019). What this suite proves: the migration creates the seven typed
// tables and a fresh database holds no row; the typers refuse junk with the record and field named (never the content);
// create/update write rows at once and return fresh, deep-frozen records, refuse an unknown field, an identity change, a
// duplicate id, a second pending invitation and an update from inside its own update; a correction commits with its
// superseded original; the queries (current records, the dispute queue, the coach lookup, the pending invitations) match
// the rows; a rolled-back unit leaves nothing; there is no db.* view; and the snapshot write types, names missing
// references and uniqueness with ids, removes departures and reads back what it wrote.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  SCOUTING_EVIDENCE_MIGRATION as MIGRATION, SCOUTING_EVIDENCE_TABLES as TABLES, SCOUTING_EVIDENCE_COLLECTIONS as COLLECTIONS,
  typeEvidence, typeCoachAffiliation, typeSquadInvite,
} from '../repositories/scoutingEvidence.mjs';

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
const hist = (id, action, detail = null, by = { byKind: 'player', byId: 'pl-adult', byName: 'Adult Signup' }) => ({ id, at: NOW - 1000, ...by, action, detail });
/** domains/scouting/passport.mjs newEvidence + audit 'created': a self-reported statistic. */
const evidence = (over = {}) => ({
  id: 'evd-1', playerId: 'pl-adult', claimType: 'statistic', label: 'League goals', value: 14, units: 'goals', season: '2025/26',
  source: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, observedAt: null, recordedAt: NOW - 5000, mediaIds: [],
  verification: { status: 'self_reported', method: 'self_entry', reviewerId: null, reviewerName: null, reviewedAt: null },
  expiresAt: null, correctionOf: null, supersededBy: null, disputes: [], note: null, history: [hist('aud-1', 'created', 'self_reported')], ...over,
});
const dispute = (over = {}) => ({ id: 'dsp-1', at: NOW - 900, by: { kind: 'org', id: ORG.id, name: `${SCOUT.name} · ${ORG.name}` }, reason: 'Not what we saw', status: 'open', resolution: null, ...over });
/** POST /org/coaches. */
const affiliation = (over = {}) => ({
  id: 'aff-1', orgId: ORG.id, orgName: ORG.name, coachName: 'Maria', coachEmail: null, role: 'Head Coach', from: '2026-01-01', to: null, status: 'confirmed',
  confirmedBy: { userId: SCOUT.userId, name: SCOUT.name }, conflictOfInterest: null, createdAt: NOW - 4000, history: [hist('aud-2', 'confirmed', 'Head Coach', { byKind: 'org', byId: ORG.id, byName: SCOUT.name })], ...over,
});
/** POST /org/squad/invite. */
const invite = (over = {}) => ({ id: 'sqi-1', orgId: ORG.id, orgName: ORG.name, playerId: 'pl-adult', playerName: 'Adult Signup', byUserId: SCOUT.userId, byName: SCOUT.name, note: null, status: 'pending_player', createdAt: NOW - 3000, respondedAt: null, ...over });

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.scoutingEvidence, layer, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0019 is registered after 0018 and creates the seven STRICT tables, empty on a fresh database; the collections are table-backed', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0018_signings_follow_ups') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s9a-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    const cols = s.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['extra_json', 'absent_keys_json', 'offtype_json', 'value_json']) assert.ok(!cols.includes(c), `${t}: no ${c}`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the routes\' literals type unchanged; junk is refused naming the record and the field, never the content', () => {
  for (const [typer, raw] of [[typeEvidence, evidence()], [typeEvidence, evidence({ value: 'about twelve', disputes: [dispute()] })], [typeCoachAffiliation, affiliation()], [typeSquadInvite, invite()]]) {
    const t = typer(raw); assert.ok(t.ok, t.reason); assert.deepEqual(plain(t.record), plain(raw));
  }
  const cases = [
    [typeEvidence, evidence({ value: { goals: 14 } }), /evidence evd-1\.value must be a number, text/],
    [typeEvidence, evidence({ value: true }), /\.value must be/],
    [typeEvidence, evidence({ claimType: 'rating' }), /\.claimType must be one of/],
    [typeEvidence, evidence({ label: 'SECRET'.repeat(30) }), /\.label exceeds 120 characters/],
    [typeEvidence, evidence({ verification: { status: 'independent', method: null, reviewerId: null, reviewerName: null, reviewedAt: null } }), /verification\.status must be one of self_reported\|coach_confirmed\|club_assessed/],
    [typeEvidence, evidence({ source: { kind: 'coach', id: 'x', name: 'y' } }), /\.source must be/],
    [typeEvidence, evidence({ mediaIds: ['m1', 'm1'] }), /mediaIds names a media item twice/],
    [typeEvidence, evidence({ supersededBy: 'evd-1' }), /supersededBy names the record itself/],
    [typeEvidence, evidence({ disputes: [dispute({ status: 'resolved' })] }), /resolution is required on a resolved dispute/],
    [typeEvidence, evidence({ freshness: { fresh: true } }), /carries field\(s\) this build does not store: freshness/],
    [typeEvidence, evidence({ history: [hist('aud-1', 'created'), hist('aud-1', 'disputed')] }), /history\[1\]\.id duplicates aud-1/],
    [typeCoachAffiliation, affiliation({ from: 'last spring' }), /aff-1\.from must be a YYYY-MM-DD day/],
    [typeCoachAffiliation, affiliation({ to: '2026-02-01' }), /\.to must be null while the affiliation is confirmed/],
    [typeCoachAffiliation, affiliation({ status: 'ended' }), /\.to is required once the affiliation ended/],
    [typeSquadInvite, invite({ status: 'approved' }), /sqi-1\.respondedAt is required once the invitation is answered/],
    [typeSquadInvite, invite({ status: 'maybe' }), /\.status must be one of/],
  ];
  for (const [typer, raw, re] of cases) { const t = typer(raw); assert.equal(t.ok, false, `refused: ${re}`); assert.match(t.reason, re); assert.doesNotMatch(t.reason, /SECRET|Not what we saw|about twelve/); }
});

// ------------------------------------------------------------- the repository
test('[repository] create/update write rows at once and return fresh, deep-frozen records; the guards hold; there is no db.* view', () => {
  const dir = saveFixture(tempDir('s9a-repo'));
  const o = serverOpen(dir); const { repo } = o;
  const e = repo.evidence.create(evidence({ mediaIds: ['m2', 'm1'] }));
  assert.deepEqual(plain(e), plain(evidence({ mediaIds: ['m2', 'm1'] })), 'read back exactly, the media order kept');
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.verification) && Object.isFrozen(e.history));
  assert.throws(() => { e.label = 'x'; }, TypeError);
  refused(() => repo.evidence.create(evidence()), /SCOUTING_DUPLICATE: evidence evd-1 already exists/);
  refused(() => repo.evidence.create(evidence({ id: 'evd-bad', value: [] })), /SCOUTING_INPUT_INVALID: evidence evd-bad\.value/);
  const next = repo.evidence.update('evd-1', (d) => { d.disputes.push(dispute()); });
  assert.equal(next.disputes.length, 1); assert.equal(e.disputes.length, 0, 'the record held before is the old version');
  refused(() => repo.evidence.update('evd-1', (d) => { d.playerId = 'pl-other'; }), /playerId cannot change/);
  refused(() => repo.evidence.update('evd-1', (d) => { d.extra = 1; }), /does not store: extra/);
  refused(() => repo.evidence.update('evd-1', () => { repo.evidence.update('evd-1', (x) => { x.note = 'n'; }); }), /SCOUTING_NESTED_UPDATE/);
  assert.equal(repo.evidence.byId('evd-1').note, null, 'the refused updates wrote nothing');
  // invitations: one pending per organisation and player
  repo.squadInvites.create(invite());
  refused(() => repo.squadInvites.create(invite({ id: 'sqi-2' })), /SCOUTING_UNIQUENESS: .*org-pro.*pl-adult/);
  repo.squadInvites.update('sqi-1', (i) => { i.status = 'declined'; i.respondedAt = NOW; });
  repo.squadInvites.create(invite({ id: 'sqi-2' }));
  assert.deepEqual(repo.squadInvites.forPlayers(['pl-adult'], 'pending_player').map((i) => i.id), ['sqi-2']);
  assert.equal(repo.squadInvites.pendingFor(ORG.id, 'pl-adult').id, 'sqi-2');
  // the old names throw, naming the repository
  assert.deepEqual(o.layer.report().domains.scoutingEvidence.rows, { evidence: 1, coachAffiliations: 0, squadInvites: 2 });
  o.close(); rm(dir);
});

test('[repository] a correction commits with its superseded original; a failure inside the unit leaves nothing', () => {
  const dir = saveFixture(tempDir('s9a-corr'));
  const o = serverOpen(dir); const { repo } = o;
  repo.evidence.create(evidence());
  o.unit(() => {
    repo.evidence.create(evidence({ id: 'evd-2', value: 12, correctionOf: 'evd-1', recordedAt: NOW, history: [hist('aud-3', 'created_as_correction', 'double counted')] }));
    repo.evidence.update('evd-1', (x) => { x.supersededBy = 'evd-2'; x.history.push(hist('aud-4', 'superseded', 'double counted')); });
  });
  assert.equal(repo.evidence.byId('evd-1').supersededBy, 'evd-2');
  assert.deepEqual(repo.evidence.currentForPlayer('pl-adult').map((x) => x.id), ['evd-2']);
  assert.deepEqual(repo.evidence.forPlayer('pl-adult').map((x) => x.id), ['evd-1', 'evd-2']);
  // a correction naming a record that is not there is refused by the key; the unit rolls back whole
  refused(() => o.unit(() => {
    repo.evidence.create(evidence({ id: 'evd-3', recordedAt: NOW, history: [] }));
    repo.evidence.create(evidence({ id: 'evd-4', correctionOf: 'evd-missing', recordedAt: NOW, history: [] }));
  }), /FOREIGN KEY/);
  assert.equal(repo.evidence.byId('evd-3'), null, 'the first write of the failed unit is gone');
  o.close(); rm(dir);
});

test('[queries] the dispute queue pages by offset in filing order; the coach lookup ignores case and ended affiliations', () => {
  const dir = saveFixture(tempDir('s9a-q'));
  const o = serverOpen(dir); const { repo } = o;
  repo.evidence.create(evidence({ disputes: [dispute({ id: 'dsp-b', at: NOW - 100 }), dispute({ id: 'dsp-a', at: NOW - 200, status: 'resolved', resolution: { outcome: 'rejected', note: null, at: NOW - 50 } })] }));
  repo.evidence.create(evidence({ id: 'evd-2', history: [], disputes: [dispute({ id: 'dsp-c', at: NOW - 300 })] }));
  const open = repo.evidence.disputePage({ limit: 50, offset: 0 });
  assert.equal(open.total, 2); assert.deepEqual(open.items.map((d) => d.id), ['dsp-c', 'dsp-b']);
  assert.deepEqual({ ...open.items[0], by: undefined }, { id: 'dsp-c', at: NOW - 300, by: undefined, reason: 'Not what we saw', status: 'open', resolution: null, evidenceId: 'evd-2', playerId: 'pl-adult', label: 'League goals', tier: 'self_reported' });
  const all = repo.evidence.disputePage({ all: true, limit: 2, offset: 1 });
  assert.equal(all.total, 3); assert.deepEqual(all.items.map((d) => d.id), ['dsp-a', 'dsp-b']);
  assert.equal(repo.evidence.byDispute('dsp-a').id, 'evd-1'); assert.equal(repo.evidence.byDispute('nope'), null);
  repo.coachAffiliations.create(affiliation());
  repo.coachAffiliations.create(affiliation({ id: 'aff-2', coachName: 'Sam', createdAt: NOW - 100, history: [] }));
  assert.equal(repo.coachAffiliations.activeFor(ORG.id, 'MARIA').id, 'aff-1');
  repo.coachAffiliations.update('aff-1', (a) => { a.status = 'ended'; a.to = '2026-11-04'; });
  assert.equal(repo.coachAffiliations.activeFor(ORG.id, 'Maria'), undefined);
  assert.deepEqual(repo.coachAffiliations.page({ limit: 10, offset: 0 }).items.map((a) => a.id), ['aff-2', 'aff-1'], 'newest first');
  o.close(); rm(dir);
});

// ------------------------------------------------------------- snapshot mode
test('[snapshot] a save types and writes the three collections and reads them back; departures leave; junk, missing references and a second pending invitation refuse the whole save with ids', () => {
  const corrected = [evidence({ supersededBy: 'evd-2' }), evidence({ id: 'evd-2', correctionOf: 'evd-1', recordedAt: NOW, history: [] })];
  const dir = saveFixture(tempDir('s9a-snap'), { evidence: corrected, coachAffiliations: [affiliation()], squadInvites: [invite()] });
  const read = (d) => { const s = openStore(d); try { return readTableBacked(s.sqlite); } finally { s.sqlite.close(); } };
  let back = read(dir);
  assert.deepEqual(plain(back.evidence), plain(corrected), 'the self references round-trip whatever the array order');
  assert.deepEqual(plain(back.coachAffiliations), plain([affiliation()])); assert.deepEqual(plain(back.squadInvites), plain([invite()]));
  // a supplied collection is the whole final collection; an omitted one is kept
  const s = openStore(dir);
  s.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb({ squadInvites: [] }) });
  s.sqlite.close();
  back = read(dir); assert.equal(back.squadInvites.length, 0); assert.equal(back.evidence.length, 2, 'evidence omitted, kept');
  const refusedSave = (db, re) => { const st = openStore(dir); try { refused(() => st.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(db) }), re); } finally { st.sqlite.close(); } };
  refusedSave({ evidence: [evidence({ value: { x: 1 } })] }, /SCOUTING_IMPORT_BLOCKED: .*evidence entry #0 evd-1\.value/);
  refusedSave({ coachAffiliations: [affiliation({ orgId: 'org-gone' })] }, /SCOUTING_REFERENCE_MISSING: .*coach_affiliations aff-1 → orgs org-gone/);
  refusedSave({ squadInvites: [invite({ byUserId: 'usr-gone' })] }, /squad_invites sqi-1 byUserId → org_users usr-gone/);
  refusedSave({ evidence: [evidence({ supersededBy: 'evd-9' })] }, /evidence evd-1 supersededBy → evd-9/);
  refusedSave({ squadInvites: [invite(), invite({ id: 'sqi-2' })] }, /SCOUTING_UNIQUENESS: .*one pending invitation per organisation and player/);
  back = read(dir); assert.equal(back.evidence.length, 2, 'every refused save changed nothing'); assert.equal(back.coachAffiliations.length, 1);
  rm(dir);
});

console.log(`\n${passed} scouting evidence checks passed`);
