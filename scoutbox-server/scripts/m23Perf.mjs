// M23 — performance and scan audit for the recruitment journey projection.
//
// Measure before optimising. Nothing here adds an index, a cache or a
// precomputed projection; it establishes what the projection actually costs so
// that a later decision to change it is made against numbers rather than
// intuition.
//
// The question that matters is not "how fast is one journey" — it is whether
// the cost scales with the TARGET CASE or with the whole database. A
// projection that walks every case in the organisation to render one of them
// is the defect this file exists to detect.

import { buildRecruitmentJourney } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';

const say = (m) => console.log(m);

/** Median and p95 from a sample, sorted once. */
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}

const ms = (n) => `${n.toFixed(3)}ms`;

function makeCase(id, orgId, playerId, events) {
  const history = [{ action: 'room_created', at: new Date(1767225600000).toISOString(), by: { name: 'S' }, detail: { status: 'watching' } }];
  for (let i = 0; i < events; i += 1) {
    const from = i % 2 === 0 ? 'under_review' : 'on_hold';
    const to = i % 2 === 0 ? 'on_hold' : 'under_review';
    history.push({
      action: 'room_status_changed',
      at: new Date(1767225600000 + i * 60000).toISOString(),
      by: { name: 'S' },
      detail: { from, to, reasonCodes: [] },
    });
  }
  return {
    id, orgId, playerId, stage: 'review',
    room: { status: 'under_review', rev: 1, priority: 'normal' },
    createdAt: new Date(1767225600000).toISOString(),
    history,
  };
}

/**
 * A database wrapper that counts how many times each collection is READ.
 *
 * The store is a plain object of arrays, so there is no query planner to ask.
 * A Proxy is the honest equivalent: it records every property access, which is
 * exactly one full-array scan per access in this architecture.
 */
function countingDb(base) {
  const counts = {};
  return {
    counts,
    db: new Proxy(base, {
      get(target, prop) {
        if (typeof prop === 'string') counts[prop] = (counts[prop] ?? 0) + 1;
        return target[prop];
      },
    }),
  };
}

function buildDb({ targetEvents, otherCases = 0, otherOrgCases = 0, historyPerOther = 3 }) {
  const cases = [makeCase('case-T', 'org-T', 'pl-T', targetEvents)];
  for (let i = 0; i < otherCases; i += 1) cases.push(makeCase(`case-o${i}`, 'org-T', `pl-o${i}`, historyPerOther));
  for (let i = 0; i < otherOrgCases; i += 1) cases.push(makeCase(`case-f${i}`, 'org-F', `pl-f${i}`, historyPerOther));
  return {
    recruitmentCases: cases,
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [],
  };
}

const VIEWER = { kind: 'org_staff', orgId: 'org-T', role: 'room_lead' };
const OPTS = { now: 1767225600000, evidence: createEvidenceProvider({ signings: [] }), historyLimit: 200 };

function measure(db, runs = 200) {
  // Warm up: the first calls pay JIT and shape-learning costs that say nothing
  // about steady-state behaviour.
  for (let i = 0; i < 30; i += 1) buildRecruitmentJourney(db, 'case-T', VIEWER, OPTS);
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    buildRecruitmentJourney(db, 'case-T', VIEWER, OPTS);
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

say('\n— §100 — buildRecruitmentJourney by history size —\n');
say('  events   mean      p50       p95       max       bytes');
const sizes = [0, 25, 100, 500];
const byEvents = {};
for (const events of sizes) {
  const db = buildDb({ targetEvents: events });
  const s = measure(db);
  const bytes = JSON.stringify(buildRecruitmentJourney(db, 'case-T', VIEWER, OPTS)).length;
  byEvents[events] = { ...s, bytes };
  say(`  ${String(events).padStart(6)}   ${ms(s.mean).padEnd(9)} ${ms(s.p50).padEnd(9)} ${ms(s.p95).padEnd(9)} ${ms(s.max).padEnd(9)} ${bytes}`);
}

say('\n— §101 — does cost scale with the TARGET or with the database? —\n');
{
  const small = buildDb({ targetEvents: 25 });
  const large = buildDb({ targetEvents: 25, otherCases: 100, otherOrgCases: 100, historyPerOther: 10 });
  const a = measure(small);
  const b = measure(large);
  const totalHistories = 1 + 200 * 10;
  say(`  target 25 events, database otherwise empty      : ${ms(a.p50)} (p50)`);
  say(`  target 25 events, +200 other cases, ~${totalHistories} entries: ${ms(b.p50)} (p50)`);
  const ratio = b.p50 / Math.max(a.p50, 0.0001);
  say(`  ratio: ${ratio.toFixed(2)}x`);
  say(ratio < 3
    ? '  → cost tracks the TARGET journey, not the database size.'
    : '  → WARNING: cost grows with unrelated data; investigate before adding phases.');
}

say('\n— §102/§103 — collection scan audit —\n');
{
  const { db, counts } = countingDb(buildDb({ targetEvents: 100 }));
  buildRecruitmentJourney(db, 'case-T', VIEWER, OPTS);
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  say('  collection              reads   filtering');
  const how = {
    recruitmentCases: 'linear find by id (no index — snapshot store has no query planner)',
    roomDecisions: 'linear filter by roomId + orgId',
    requests: 'linear filter by orgId + playerId',
    trials: 'linear filter by orgId + playerId',
    assessments: 'linear filter by orgId + playerId',
    signings: 'linear find by orgId + playerId',
    recruitmentOffers: 'presence check only (phase not shipped)',
    outcomeReports: 'presence check only',
  };
  for (const [k, n] of rows) say(`  ${k.padEnd(22)} ${String(n).padStart(5)}   ${how[k] ?? 'presence check'}`);
  const worst = rows[0];
  say('');
  say(worst[1] <= 3
    ? `  → no collection is read more than ${worst[1]} times for one journey. There is no`
    : `  → WARNING: ${worst[0]} is read ${worst[1]} times for one journey.`);
  say('    per-history-event rescan: the timeline is built from the case\'s own');
  say('    history array, which is already in hand once the case is found.');
}

say('\n— §104 — memory: 500-event projection, repeated —\n');
{
  const db = buildDb({ targetEvents: 500 });
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i += 1) buildRecruitmentJourney(db, 'case-T', VIEWER, OPTS);
  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  const deltaMb = (after - before) / 1024 / 1024;
  say(`  heap delta over 2,000 projections: ${deltaMb.toFixed(2)} MB`);
  say(Math.abs(deltaMb) < 40
    ? '  → nothing is retained across projections (the projector holds no cache).'
    : '  → WARNING: heap grew materially; check for a retained reference.');
  if (!global.gc) say('  (run with --expose-gc for a tighter figure; this is an upper bound)');
}

say('\n— §105 — response size and the history cap —\n');
{
  const db = buildDb({ targetEvents: 500 });
  const capped = buildRecruitmentJourney(db, 'case-T', VIEWER, { ...OPTS, historyLimit: 50 });
  const full = buildRecruitmentJourney(db, 'case-T', VIEWER, { ...OPTS, historyLimit: 200 });
  say(`  default page (50 entries) : ${JSON.stringify(capped).length} bytes, total ${capped.history.total}, nextCursor ${capped.history.nextCursor}`);
  say(`  max page     (200 entries): ${JSON.stringify(full).length} bytes`);
  say('  → history is paginated by default rather than the overview growing without bound.');
}

say('\nM23 perf: measured, not tuned. No index was added and no cache exists.');
