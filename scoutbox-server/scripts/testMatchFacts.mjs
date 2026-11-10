// The match facts (repositories/matchFacts.mjs, domains/discovery/matchFacts.mjs) and the match reads over them
// (domains/discovery/matching/match.mjs criterionSql, query.mjs). Throwaway databases, synthetic records only.
// Run with: npm test -- testMatchFacts
//
//   - the triggers: every input table has them; a change to a relevant column marks the player, an unrelated one does
//     not; an outer conflict clause cannot make a mark fail; an organisation's standing marks its linked players;
//   - the pre-commit work runs inside transaction() and units of work, and a failure there rolls the write back;
//   - the keeper: start derives every player, a write is re-derived before its COMMIT, a retained player loses the
//     row, the sweep re-derives what time alone changed, a new policy rebuilds everything;
//   - the reads: every criterion's SQL admits exactly the players its JS test meets, over generated players, facts
//     and criteria, for a Pro and a Grassroots club; the keyset orders match reference comparators;
//   - adulthood: adulthoodAt is the first instant isAdult holds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';
import { transaction, onBeforeCommit } from '../repositories/database.mjs';
import { MATCH_FACT_INPUTS, TRUST_BAND_IDS, foldName } from '../repositories/matchFacts.mjs';
import { PLAYER_POSITIONS, PLAYER_FEET } from '../repositories/identity.mjs';
import { createMatchFactsKeeper, adulthoodAt } from '../domains/discovery/matchFacts.mjs';
import { criterionSql, matchPlayerToCriteria } from '../domains/discovery/matching/match.mjs';
import { validateCriteria, AVAILABILITY_VALUES } from '../domains/discovery/matching/criteria.mjs';
import { createMatchReads } from '../domains/discovery/matching/query.mjs';
import { EVIDENCE_REQUIREMENTS } from '../domains/discovery/shared.mjs';
import { isAdult, ADULT_AGE } from '../domain.mjs';
import { tempDir, clone, NOW, DAY, TTL, FIXTURE } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }

let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
const ORGS = () => [
  { id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', verified: true },
  { id: 'org-grass', name: 'Leeds Juniors', type: 'club', level: 'grassroots', plan: 'Grassroots', country: 'GB', location: { lat: 53.8, lng: -1.55, city: 'Leeds' } },
];
const PROTOCOLS = ['box_touch_60', 'sprint_20m'];

/** A first installation through the real data layer, at a fixed clock. */
function boot(dir = tempDir('mfacts')) {
  const store = openStore(dir);
  const layer = attachDataLayer({ db: {}, seed: { orgs: ORGS(), players: clone(FIXTURE().players), guardians: clone(FIXTURE().guardians) }, store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const q = (sql, ...a) => store.sqlite.prepare(sql).all(...a);
  const dirty = () => q('SELECT player_id FROM player_match_facts_dirty ORDER BY player_id').map((r) => r.player_id);
  const clearDirty = () => store.sqlite.exec('DELETE FROM player_match_facts_dirty');
  const done = () => { store.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { store, layer, sqlite: store.sqlite, q, dirty, clearDirty, done, unit: (fn) => store.unitOfWork(fn) };
}

// A small deterministic generator, so a failure reproduces.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 2 ** 32; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const maybe = (r, v, p = 0.75) => (r() < p ? v : null);

test('triggers: every input table carries its triggers; a relevant change marks the player, an unrelated column does not, and an outer conflict clause cannot make a mark fail', () => {
  const t = boot();
  const names = new Set(t.q("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name));
  for (const input of MATCH_FACT_INPUTS) {
    for (const ev of input.events ?? ['INSERT', 'UPDATE', 'DELETE']) assert.ok(names.has(`match_facts_${input.table}_${ev.toLowerCase()}`), `${input.table} ${ev} trigger`);
  }
  assert.deepEqual(t.dirty().sort(), FIXTURE().players.map((p) => p.id).sort(), 'the seed import marked every player (the keeper derives them at start)');
  t.clearDirty();
  t.layer.players.setAvailability('pl-adult', { availability: 'loan_open' });
  assert.deepEqual(t.dirty(), ['pl-adult'], 'an availability change marks the player');
  t.clearDirty();
  t.sqlite.prepare('UPDATE players SET prefs_timezone = ? WHERE id = ?').run('Europe/London', 'pl-adult');
  assert.deepEqual(t.dirty(), [], 'a column the facts do not read marks nothing');
  // INSERT OR REPLACE twice: the outer conflict clause overrides a trigger's own, so the trigger must not conflict.
  t.sqlite.prepare("INSERT OR REPLACE INTO passport_prefs (player_id, updated_at) VALUES ('pl-adult', 1)").run();
  t.sqlite.prepare("INSERT OR REPLACE INTO passport_prefs (player_id, updated_at) VALUES ('pl-adult', 2)").run();
  assert.deepEqual(t.dirty(), ['pl-adult'], 'marked once, and the second write did not fail on the mark');
  t.clearDirty();
  t.sqlite.prepare("INSERT INTO org_squad_members (id, org_id, player_id, name, source, added_at) VALUES ('sq-1', 'org-pro', 'pl-seeded', 'Seeded', 'manual', 1)").run();
  t.clearDirty();
  t.layer.orgs.update('org-pro', (d) => { d.verified = false; });
  assert.deepEqual(t.dirty(), ['pl-seeded'], 'an organisation\'s standing marks the players linked to it');
  t.clearDirty();
  t.layer.orgs.update('org-pro', (d) => { d.name = 'Eastport Town'; });
  assert.deepEqual(t.dirty(), [], 'an organisation\'s name is not a fact');
  t.done();
});

test('pre-commit work: it runs inside transaction() and a unit of work before COMMIT, sees their writes, and a failure there rolls the write back', () => {
  const t = boot();
  const seen = [];
  let fail = false;
  const stop = onBeforeCommit(t.sqlite, () => { seen.push(t.sqlite.isTransaction); if (fail) throw new Error('derivation failed'); });
  transaction(t.sqlite, () => t.sqlite.prepare("UPDATE players SET name = 'Renamed' WHERE id = 'pl-adult'").run());
  t.unit(() => t.sqlite.prepare("UPDATE players SET name = 'Renamed Again' WHERE id = 'pl-adult'").run());
  assert.deepEqual(seen, [true, true], 'inside the open transaction, once per commit');
  fail = true;
  assert.throws(() => t.unit(() => t.sqlite.prepare("UPDATE players SET name = 'Lost' WHERE id = 'pl-adult'").run()), /derivation failed/);
  assert.equal(t.layer.players.byId('pl-adult').name, 'Renamed Again', 'the unit rolled back');
  assert.throws(() => transaction(t.sqlite, () => t.sqlite.prepare("UPDATE players SET name = 'Lost' WHERE id = 'pl-adult'").run()), /derivation failed/);
  assert.equal(t.layer.players.byId('pl-adult').name, 'Renamed Again', 'the transaction rolled back');
  stop();
  t.done();
});

/** The keeper over the real repositories, with the trust band stubbed (the trust module is the e2e batteries'). */
function keeperOf(t, bands = new Map(), opts = {}) {
  const L = t.layer;
  return createMatchFactsKeeper({
    matchFacts: L.matchFacts, players: L.players, unit: t.unit, sqlite: t.sqlite,
    verificationReads: { ...L.verification.reads, ...L.passport.reads, ...L.transitionsVouches.reads },
    scoutingReads: { ...L.scoutingEvidence.reads, ...L.scoutingAssessments.reads, ...L.clubSetup.reads, ...L.opportunitiesCampaigns.reads },
    boxCamReads: L.boxCam.reads,
    recruitmentReads: { ...L.recruitmentContactsOffers.reads, ...L.signingsFollowUps.reads, ...L.recruitment.reads, ...L.recruitmentCases.reads },
    agentReads: L.agentCore.reads,
    trustSummaryFor: (p) => ({ band: bands.get(p.id) ?? 'limited_evidence' }),
    ...opts,
  });
}

test('keeper: start derives every player; a write is re-derived before its COMMIT (the preference wins over the profile); a retained player loses the row; the sweep re-derives what time alone changed; a new policy rebuilds everything', () => {
  const t = boot();
  const bands = new Map([['pl-adult', 'strong_evidence']]);
  const k = keeperOf(t, bands);
  k.start();
  assert.equal(t.dirty().length, 0, 'nothing left marked after start');
  const row = t.layer.matchFacts.row('pl-adult');
  assert.equal(row.position, 'ST'); assert.equal(row.availability, 'not_seeking'); assert.equal(row.trust_band, 'strong_evidence');
  assert.equal(row.coach_reference, 0); assert.equal(row.club_confirmed, 0);
  assert.equal(t.layer.matchFacts.counts().players, FIXTURE().players.length, 'one row per live player');

  t.unit(() => t.layer.passport.passportPrefs.save('pl-adult', (d) => { d.positions = { primary: 'CM', secondary: ['CDM', 'CAM'] }; d.availability = 'open_to_trials'; d.updatedAt = NOW; }));
  const after = t.layer.matchFacts.row('pl-adult');
  assert.equal(after.position, 'CM', 'the Passport preference wins'); assert.deepEqual(after.secondary, ['CDM', 'CAM']); assert.equal(after.availability, 'open_to_trials');
  assert.equal(t.dirty().length, 0, 'the COMMIT left no mark');

  // A write outside any unit (the repository's own transaction) is derived too.
  t.layer.players.setAvailability('pl-seeded', { availability: 'loan_open' });
  assert.equal(t.layer.matchFacts.row('pl-seeded').availability, 'loan_open');

  t.layer.players.erase('pl-seeded');
  assert.equal(t.layer.matchFacts.row('pl-seeded'), null, 'a retained (erased) player has no facts');

  // Time alone: a row due now is re-derived by the sweep, with the band its inputs give today.
  t.sqlite.prepare("UPDATE player_match_facts SET refresh_due_at = ? WHERE player_id = 'pl-adult'").run(NOW - 1);
  bands.set('pl-adult', 'developing_evidence');
  k.sweep(Date.now());
  assert.equal(t.layer.matchFacts.row('pl-adult').trust_band, 'developing_evidence', 'the sweep re-derived the due row');

  // A new policy (here: simulated evidence allowed) rebuilds every row at start.
  k.stopForTests();
  bands.set('pl-adult', 'very_strong_evidence');
  const k2 = keeperOf(t, bands, { testProviderEnabled: true });
  assert.notEqual(k2.policyKey, k.policyKey);
  k2.start();
  assert.equal(t.layer.matchFacts.row('pl-adult').trust_band, 'very_strong_evidence', 'every row was rebuilt under the new policy');
  k2.stopForTests();
  t.done();
});

test('repository: a facts record the columns cannot hold is refused by player', () => {
  const t = boot();
  const base = { name: 'P', position: null, secondaryPositions: [], availability: null, trustBand: null, lastEvidenceAt: null, lastFootageAt: null, coachReference: false, clubConfirmed: false, combine: {}, refreshDueAt: null };
  assert.throws(() => t.layer.matchFacts.write('pl-adult', { ...base, position: 'XX' }), /MATCH_FACTS_INVALID: player pl-adult: position/);
  assert.throws(() => t.layer.matchFacts.write('pl-adult', { ...base, trustBand: 'great' }), /trust band/);
  assert.throws(() => t.layer.matchFacts.write('pl-adult', { ...base, lastEvidenceAt: 1.5 }), /lastEvidenceAt/);
  assert.throws(() => t.layer.matchFacts.write('pl-adult', { ...base, secondaryPositions: ['CM', 'CB', 'ST', 'GK'] }), /secondary/);
  assert.throws(() => t.layer.matchFacts.write('pl-adult', { ...base, combine: { box_touch_60: 'fast' } }), /Combine best/);
  t.layer.matchFacts.write('pl-adult', { ...base, combine: { box_touch_60: null } });
  assert.deepEqual(t.layer.matchFacts.row('pl-adult').combine, { box_touch_60: null }, 'a protocol with no numeric measurement is kept, with no best');
  t.done();
});

/** Random criteria, normalised by the real validator (so only what a club can save is generated). */
function randomCriterion(r, orgLevel) {
  const raw = pick(r, [
    () => ({ type: 'position', operator: 'in', values: [pick(r, PLAYER_POSITIONS), pick(r, PLAYER_POSITIONS)], primaryOnly: r() < 0.5 }),
    () => { const a = 10 + Math.floor(r() * 25); return pick(r, [{ type: 'age', operator: 'between', values: [a, a + Math.floor(r() * 8)] }, { type: 'age', operator: 'gte', value: a }, { type: 'age', operator: 'lte', value: a }]); },
    () => ({ type: 'geography', operator: 'within_radius', value: 1 + Math.floor(r() * 60) }),
    () => (r() < 0.5 ? { type: 'level', operator: 'lte', value: pick(r, ['amateur', 'semi_pro', 'pro']) } : { type: 'level', operator: 'in', values: [pick(r, ['amateur', 'semi_pro', 'pro'])] }),
    () => ({ type: 'foot', operator: 'in', values: [pick(r, ['Left', 'Right', 'Both'])] }),
    () => ({ type: 'availability', operator: 'equals', value: pick(r, AVAILABILITY_VALUES) }),
    () => ({ type: 'evidence', operator: 'exists', value: pick(r, EVIDENCE_REQUIREMENTS).key }),
    () => ({ type: 'evidence_recency', operator: 'within_days', value: 1 + Math.floor(r() * 300), evidenceKind: pick(r, ['any', 'footage']) }),
    () => ({ type: 'trust_band', operator: 'gte', value: pick(r, TRUST_BAND_IDS) }),
    () => ({ type: 'combine_result', operator: 'exists', value: pick(r, PROTOCOLS) }),
    () => ({ type: 'combine_measurement', operator: pick(r, ['gte', 'lte']), protocol: pick(r, PROTOCOLS), value: Math.floor(r() * 100) }),
  ])();
  const v = validateCriteria({ required: [raw] }, { orgLevel, protocols: PROTOCOLS });
  assert.ok(v.ok, JSON.stringify(v));
  return v.criteria.required[0];
}

test('reads: every criterion\'s SQL admits exactly the players its JS test meets (generated players, facts and criteria, a Pro and a Grassroots club), and the keyset orders are the old comparators\' orders', () => {
  const t = boot();
  const r = rng(20261108);
  const L = t.layer;
  for (let i = 0; i < 80; i += 1) {
    const id = `pl-gen-${String(i).padStart(3, '0')}`;
    const year = 1986 + Math.floor(r() * 25);
    const dob = `${year}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
    const country = pick(r, ['GB', 'GB', 'KR', 'US']);
    const name = `Gen ${pick(r, ['Ana', 'émile', 'Zoe', 'bo', 'Ola', 'Ébo', 'ana'])} ${i}`;
    L.players.create({
      id, name, dob, country,
      guardianId: isAdult({ dob, country }, NOW) ? null : 'gd-signup', position: maybe(r, pick(r, PLAYER_POSITIONS)), foot: maybe(r, pick(r, PLAYER_FEET)),
      level: pick(r, ['amateur', 'semi_pro', 'pro']), availability: pick(r, AVAILABILITY_VALUES),
      location: r() < 0.8 ? { lat: 53.8 + (r() - 0.5) * 1.2, lng: -1.55 + (r() - 0.5) * 1.6 } : null,
    });
    const at = () => maybe(r, NOW - Math.floor(r() * 400 * DAY), 0.7);
    const combine = {};
    for (const p of PROTOCOLS) if (r() < 0.35) combine[p] = maybe(r, Math.floor(r() * 120), 0.8);
    L.matchFacts.write(id, {
      name, position: maybe(r, pick(r, PLAYER_POSITIONS)), secondaryPositions: r() < 0.5 ? [pick(r, PLAYER_POSITIONS)] : [],
      availability: maybe(r, pick(r, AVAILABILITY_VALUES)), trustBand: maybe(r, pick(r, TRUST_BAND_IDS)),
      lastEvidenceAt: at(), lastFootageAt: at(), coachReference: r() < 0.3, clubConfirmed: r() < 0.3, combine, refreshDueAt: null,
    });
  }
  const reads = createMatchReads({ players: L.players, matchFacts: L.matchFacts });
  let checked = 0;
  let informative = 0; // comparisons where the criterion admitted some players and refused others
  for (const org of ['org-pro', 'org-grass'].map((id) => L.orgs.byId(id))) {
    const everyone = reads.matchQuery(org, [], NOW).page([['p.id', 'ASC']], { limit: 10_000 });
    const facts = reads.factsOfRows(everyone, org, NOW);
    assert.ok(facts.length > 10, `${org.id} sees enough generated players to test (${facts.length})`);
    for (let n = 0; n < 400; n += 1) {
      const c = randomCriterion(r, org.level);
      const js = facts.filter((f) => matchPlayerToCriteria(f, { required: [c], preferred: [] }, { now: NOW }).matchesRequired).map((f) => f.playerId).sort();
      const sql = reads.matchQuery(org, [c], NOW).ids();
      assert.deepEqual(sql, js, `${org.id}: ${c.id} — the SQL and the JS test admit the same players`);
      assert.ok(criterionSql(c, { now: NOW, org }).sql.length > 0);
      checked += 1;
      if (js.length > 0 && js.length < facts.length) informative += 1;
    }
    // The orders: each matches a reference comparator, ending on the player id.
    const BANDS = TRUST_BAND_IDS;
    const cmp = {
      recent_evidence: (a, b) => (b.lastEvidenceAt ?? 0) - (a.lastEvidenceAt ?? 0),
      age: (a, b) => (a.age ?? 999) - (b.age ?? 999),
      evidence_confidence: (a, b) => BANDS.indexOf(b.trustBand) - BANDS.indexOf(a.trustBand),
      distance: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
      name: (a, b) => { const x = foldName(a.name); const y = foldName(b.name); return x < y ? -1 : x > y ? 1 : 0; },
    };
    for (const sort of Object.keys(cmp)) {
      const { order } = reads.matchOrder(sort, org, NOW);
      const sqlOrder = reads.matchQuery(org, [], NOW).page(order, { limit: 10_000 }).map((row) => row.id);
      const jsOrder = facts.slice().sort((a, b) => cmp[sort](a, b) || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0)).map((f) => f.playerId);
      assert.deepEqual(sqlOrder, jsOrder, `${org.id}: the ${sort} order`);
      // And a walk by cursor visits the same players in the same order.
      const walked = [];
      let after = null;
      for (;;) {
        const rows = reads.matchQuery(org, [], NOW).page(order, { limit: 7, after });
        walked.push(...rows.slice(0, 7).map((x) => x.id));
        if (rows.length <= 7) break;
        after = [rows[6].k0, rows[6].k1];
      }
      assert.deepEqual(walked, sqlOrder, `${org.id}: the ${sort} pages by cursor without a gap or a repeat`);
    }
  }
  // A Pro club with a ground still sees no distance: its distance order is the id order and no cursor key carries one.
  const proWithGround = { ...L.orgs.byId('org-pro'), location: { lat: 53.8, lng: -1.55 } };
  const keyed = reads.matchQuery(proWithGround, [], NOW).page(reads.matchOrder('distance', proWithGround, NOW).order, { limit: 10_000 });
  assert.ok(keyed.length > 10 && keyed.every((row) => row.k0 === keyed[0].k0), 'every key ties for a club that is not shown distance');
  assert.deepEqual(keyed.map((row) => row.id), keyed.map((row) => row.id).slice().sort(), 'so the order is the player id');
  assert.ok(checked >= 800);
  assert.ok(informative >= 300, `most comparisons split the players (${informative} of ${checked})`);
  t.done();
});

test('adulthood: adulthoodAt is the first instant isAdult holds, for every country rule, 29 February included', () => {
  const r = rng(42);
  const countries = [...Object.keys(ADULT_AGE).filter((k) => k !== 'DEFAULT'), 'GB'];
  const dobs = ['2008-02-29', '2009-03-01', '2010-12-31', '2011-01-01'];
  for (let i = 0; i < 200; i += 1) dobs.push(`${2000 + Math.floor(r() * 20)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`);
  for (const country of countries) {
    for (const dob of dobs) {
      const p = { dob, country };
      const at = adulthoodAt(p);
      assert.ok(isAdult(p, at) && !isAdult(p, at - 1), `${country} ${dob}: the flip is at ${new Date(at).toISOString()}`);
    }
  }
  assert.equal(adulthoodAt({ dob: null, country: 'GB' }), null, 'an unknown birth date has no adulthood instant');
});

console.log(`${passed} match facts checks passed`);
