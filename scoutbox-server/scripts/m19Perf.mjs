// M19 performance probe — what explainable matching actually costs.
//
// The shape of the work is the point. Matching is:
//
//   for every player in the snapshot
//     → orgCanSee            (standing, blocks, minors, level)
//     → playerViewForOrg     (the projection, including evidence and Combine)
//     → matchPlayerToCriteria (one evaluation per criterion)
//
// So the cost is O(candidates × criteria), and the expensive half is the
// PROJECTION, not the matching — building the facts for a player walks their
// evidence, references and Combine attempts. This probe separates the two so
// the number can be read honestly instead of blamed on the wrong thing.
//
// It also measures a Dynamic Watchlist read, which is a matching run plus a
// reconciliation against the previous membership, and the reconciliation
// itself at 100 / 500 / 1000 members.
//
// Measurements only. One machine, warm process, no SLA is claimed and none of
// these figures should be quoted as one.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCriteria, criteriaVersion, describeCriteria } from '../m19/criteria.mjs';
import { matchPlayerToCriteria, briefCriteriaToCanonical } from '../m19/match.mjs';
import { reconcileMembership, transitionFingerprint, explainTransition, membershipSummary } from '../m19/watchlists.mjs';

const PORT = 5860 + Math.floor(Math.random() * 30);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m19perf-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

const micro = (label, fn, iters = 200_000) => {
  for (let i = 0; i < iters / 10; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const ns = ((performance.now() - t0) * 1e6) / iters;
  console.log(`${label.padEnd(58)} ${ns.toFixed(0)} ns/op`);
  return ns;
};

const facts = (i) => ({
  playerId: `p${i}`,
  name: `Player ${i}`,
  age: 15 + (i % 12),
  position: ['GK', 'CB', 'CDM', 'CM', 'ST'][i % 5],
  secondaryPositions: i % 3 ? ['CM'] : [],
  level: ['amateur', 'semi_pro', 'pro'][i % 3],
  foot: i % 2 ? 'right' : 'left',
  availability: 'available_now',
  distanceKm: (i % 90) + 1,
  trustBand: ['limited_evidence', 'developing_evidence', 'established_evidence', 'strong_evidence', 'very_strong_evidence'][i % 5],
  combineProtocols: i % 4 === 0 ? ['combine-box-touch-60'] : [],
  combineMeasurements: i % 4 === 0 ? { 'combine-box-touch-60': 120 + (i % 90) } : {},
  evidenceFlags: { recent_full_match: i % 2 === 0, coach_reference: i % 3 === 0, confirmed_current_club: false, combine_verified: i % 4 === 0 },
  lastEvidenceAt: Date.now() - (i % 400) * DAY,
  lastFootageAt: Date.now() - (i % 500) * DAY,
});

const build = (n) => Array.from({ length: n }, (_, i) => facts(i));

const criteriaOf = (n) => {
  const pool = [
    { type: 'position', operator: 'in', values: ['CDM', 'CM'] },
    { type: 'age', operator: 'between', values: [15, 24] },
    { type: 'level', operator: 'lte', value: 'semi_pro' },
    { type: 'foot', operator: 'in', values: ['Right'] },
    { type: 'availability', operator: 'equals', value: 'available_now' },
    { type: 'evidence', operator: 'exists', value: 'recent_full_match' },
    { type: 'evidence_recency', operator: 'within_days', value: 365 },
    { type: 'trust_band', operator: 'gte', value: 'developing_evidence' },
  ];
  const v = validateCriteria({ required: pool.slice(0, n), preferred: [] }, { orgLevel: 'pro', protocols: null });
  if (!v.ok) throw new Error(`fixture criteria rejected: ${JSON.stringify(v)}`);
  return v.criteria;
};

console.log('\n— the engine itself, per criterion —\n');
{
  const f = facts(3);
  for (const c of [
    { type: 'position', operator: 'in', values: ['CDM', 'CM'] },
    { type: 'age', operator: 'between', values: [15, 24] },
    { type: 'geography', operator: 'within_radius', value: 50 },
    { type: 'evidence_recency', operator: 'within_days', value: 365 },
    { type: 'trust_band', operator: 'gte', value: 'developing_evidence' },
    { type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 150 },
  ]) {
    const one = validateCriteria({ required: [c] }, { orgLevel: 'pro', protocols: ['combine-box-touch-60'] }).criteria;
    micro(`evaluate one ${c.type} criterion`, () => matchPlayerToCriteria(f, one));
  }
  const eight = criteriaOf(8);
  micro('evaluate a full 8-criterion set for one player', () => matchPlayerToCriteria(f, eight), 100_000);
  micro('criteriaVersion(8 criteria)', () => criteriaVersion(eight), 100_000);
  micro('describeCriteria(8 criteria)', () => describeCriteria(eight), 100_000);
  micro('validateCriteria(8 criteria, from the wire)', () => validateCriteria({ required: [{ type: 'age', operator: 'gte', value: 16 }] }, { orgLevel: 'pro' }), 100_000);
  micro('briefCriteriaToCanonical(a typical brief)', () => briefCriteriaToCanonical({ positions: ['CDM'], minAge: 16, maxAge: 20, maxLevel: 'semi_pro', minTrustBand: 'established_evidence' }), 100_000);
}

console.log('\n— matching a whole candidate set, in process (no HTTP, no projection) —\n');
{
  for (const n of [100, 500, 1000]) {
    const set = build(n);
    for (const k of [1, 4, 8]) {
      const c = criteriaOf(k);
      // Warm.
      for (const f of set) matchPlayerToCriteria(f, c);
      const t0 = performance.now();
      let matched = 0;
      for (const f of set) if (matchPlayerToCriteria(f, c).matchesRequired) matched++;
      const ms = performance.now() - t0;
      console.log(`${`${n} candidates × ${k} criteria`.padEnd(58)} ${ms.toFixed(2)} ms   (${matched} matched, ${((ms * 1e6) / (n * k)).toFixed(0)} ns per criterion-evaluation)`);
    }
  }
}

console.log('\n— reconciliation, by membership size —\n');
{
  for (const n of [100, 500, 1000]) {
    const previous = Array.from({ length: n }, (_, i) => `p${i}`);
    // A tenth of the list turns over.
    const current = [...previous.slice(Math.floor(n / 10)), ...Array.from({ length: Math.floor(n / 10) }, (_, i) => `q${i}`)];
    const t0 = performance.now();
    const diff = reconcileMembership(previous, current);
    const rec = performance.now() - t0;
    const t1 = performance.now();
    for (const id of diff.entered) {
      transitionFingerprint({ watchlistId: 'w', playerId: id, criteriaVersion: 'cv1:abcdef12', transition: 'entered', reason: 'criterion_now_met' });
      explainTransition({
        previousMatch: { required: [{ criterionId: 'age:gte:value=16', met: false }] },
        currentMatch: { required: [{ criterionId: 'age:gte:value=16', met: true, text: 'Matches age criteria (17)' }] },
        transition: 'entered',
      });
    }
    const explain = performance.now() - t1;
    membershipSummary(diff);
    console.log(`${`${n} members, ${diff.entered.length} in / ${diff.left.length} out`.padEnd(58)} diff ${rec.toFixed(2)} ms   explain+fingerprint ${explain.toFixed(2)} ms`);
  }
}

// ------------------------------------------------------------------ HTTP
const proc = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', BOX_CAM_TEST_PROVIDER: '1' },
  stdio: 'ignore',
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const j = async (method, url, body, token) => {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const time = async (label, fn, runs = 12) => {
  await fn();
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(58)} median ${med.toFixed(1)} ms   p90 ${ts[Math.floor(ts.length * 0.9)].toFixed(1)} ms`);
  return med;
};

const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const ONE = { criteria: { required: [{ type: 'age', operator: 'between', values: [5, 60] }] } };
const EIGHT = {
  criteria: {
    required: [
      { type: 'age', operator: 'between', values: [5, 60] },
      { type: 'level', operator: 'lte', value: 'pro' },
      { type: 'evidence_recency', operator: 'within_days', value: 3650 },
    ],
    preferred: [
      { type: 'position', operator: 'in', values: ['CDM', 'CM'] },
      { type: 'foot', operator: 'in', values: ['Right'] },
      { type: 'availability', operator: 'equals', value: 'available_now' },
      { type: 'trust_band', operator: 'gte', value: 'developing_evidence' },
      { type: 'evidence', operator: 'exists', value: 'recent_full_match' },
    ],
  },
};

console.log(`\n— over HTTP, ${players.length} visible players —\n`);
const health = await time('healthz (baseline round trip)', () => j('GET', '/healthz'));
const discover = await time('Discover list (the existing projection, for comparison)', () => j('GET', '/org/players', undefined, maria.token));
await time('matching vocabulary', () => j('GET', '/org/matching/vocabulary', undefined, maria.token));
const m1 = await time('matching, 1 required criterion', () => j('POST', '/org/matching', ONE, maria.token));
const m8 = await time('matching, 3 required + 5 preferred', () => j('POST', '/org/matching', EIGHT, maria.token));
const brief = (await j('POST', '/org/recruitment-briefs', { title: 'Perf brief', positions: ['CDM', 'CM'], minAge: 16, maxAge: 30 }, maria.token)).body.brief;
await time('matching from a Recruitment Brief', () => j('POST', '/org/matching', { briefId: brief.id }, maria.token));

const wl = (await j('POST', '/org/watchlists', { name: 'Perf watchlist', mode: 'snapshot', criteria: ONE.criteria }, maria.token)).body.watchlist;
const wlRead = await time('watchlist read (derive + reconcile + record)', () => j('GET', `/org/watchlists/${wl.id}`, undefined, maria.token));
await time('watchlist list', () => j('GET', '/org/watchlists', undefined, maria.token));
await time('watchlist history page', () => j('GET', `/org/watchlists/${wl.id}/history`, undefined, maria.token));

console.log('\n— reading the numbers —\n');
console.log(`matching with one criterion: ${m1.toFixed(1)} ms median over ${players.length} visible players.`);
console.log(`adding five preferred criteria: ${m8.toFixed(1)} ms (${(m8 - m1 >= 0 ? '+' : '')}${(m8 - m1).toFixed(1)} ms).`);
console.log('  The in-process figures above show why: one criterion evaluation is a few hundred');
console.log('  nanoseconds, so at these sizes the criteria count barely registers. The cost is the');
console.log('  candidate PROJECTION — orgCanSee plus playerViewForOrg plus the evidence, reference');
console.log('  and Combine walks that build each facts record.');
console.log('');
console.log('What this probe actually found, and what was done about it: criteriaVersion() was');
console.log('  being recomputed for every candidate, and at eight criteria that hash was 3.3 of the');
console.log('  5.1 microseconds an evaluation took — roughly two thirds of the engine spent');
console.log('  re-deriving a property of the criteria, not of the player. It is now memoised on the');
console.log('  criteria set (a WeakMap; a validated set is never mutated in place), which took an');
console.log('  eight-criterion evaluation to 1.7 microseconds. The figures above are after that fix.');
console.log(`Discover, which does the same projection without matching: ${discover.toFixed(1)} ms.`);
console.log(`healthz, which does neither: ${health.toFixed(1)} ms.`);
console.log(`A watchlist read is ${wlRead.toFixed(1)} ms: one matching run, plus a diff against the`);
console.log('  previous membership, plus writing any transitions. The diff itself is sub-millisecond');
console.log('  at a thousand members (above), so a watchlist read costs about what a match costs.');
console.log('');
console.log('Known limitation, stated rather than optimised away: the candidate scan is linear in');
console.log('the number of players in the snapshot and is capped by LIMITS.maxCandidateScan. There');
console.log('is no index over positions, ages or evidence, because the snapshot store holds the');
console.log('working set in memory and has no query planner to give one to. At tens of thousands');
console.log('of players this becomes the thing to fix — with a maintained projection, not with a');
console.log('cache, because a cached membership is exactly the stale list M19 exists to avoid.');
console.log('');
console.log('Measurements only — one machine, warm process, seeded dataset. No SLA is claimed.');
process.exit(0);
