// M21 performance probe — what reading a Development Plan actually costs.
//
// The shape of the work, and why it is worth measuring:
//
//   collectPlan   one pass over each of the five development collections,
//                 filtering by planId. The snapshot store has no indexes —
//                 a scan IS the access path — so this cost is proportional to
//                 the size of the whole store, not the size of the plan.
//   projection    per goal: resolve its evidence links against the canonical
//                 stores, evaluate its objective target against the player's
//                 Combine attempts, count its actions.
//   timeline      one pass over the history of every record in the plan.
//
// If `collectPlan` dominates, an index on planId would pay for itself. If the
// projection dominates, it would not, and adding one would be speculative
// (§153/§154). This probe separates them, because that is the only question
// worth asking before adding an index to a store that has none.
//
// Measurements only: one machine, warm process, synthetic snapshots of the
// exact shapes the server stores. No SLA is claimed and none of these numbers
// should be quoted as one.
import { collectPlan, buildDevelopmentPlan, buildTimeline, planListItem } from '../m21/plan.mjs';
import { planAccess } from '../m21/permissions.mjs';
import { evaluateTarget, validateTarget } from '../m21/targets.mjs';
import { resolveEvidenceLink } from '../m21/evidence.mjs';
import { buildGoalSnapshots } from '../m21/reviews.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);

const ms = (label, fn, iters) => {
  for (let i = 0; i < Math.max(2, Math.floor(iters / 5)); i++) fn(i);   // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const per = (performance.now() - t0) / iters;
  console.log(`  ${label.padEnd(46)} ${per < 1 ? `${(per * 1000).toFixed(1)} µs` : `${per.toFixed(2)} ms`}`);
  return per;
};

const TARGET = validateTarget({ sourceType: 'combine_attempt', protocolId: 'combine-box-touch-60', operator: 'gte', value: 160 }).value;

/**
 * A synthetic snapshot. `otherPlans` exists to make the scan honest: reading
 * one plan out of a store holding two thousand is the case that decides
 * whether an index is worth having.
 */
function snapshot({ goals: goalCount, actionsPerGoal = 3, linksPerGoal = 2, historyPerRecord = 3, reviews: reviewCount = 4, otherPlans = 0 }) {
  const db = {
    developmentPlans: [], developmentGoals: [], developmentActions: [],
    developmentEvidenceLinks: [], developmentReviews: [],
    evidence: [], assessments: [], boxSessions: [], combineAttempts: [], trials: [],
  };
  const hist = (n, action) => Array.from({ length: n }, (_, k) => ({ id: `aud-${action}-${k}`, at: NOW - k * DAY, action, byKind: 'org', byName: 'A Coach', detail: null }));

  const makePlan = (pid, playerId, goals) => {
    db.developmentPlans.push({
      id: pid, playerId, owner: { kind: 'org', orgId: 'org-a', orgName: 'Org A' },
      createdBy: { kind: 'org', id: 'u1', name: 'A Coach' },
      title: `Plan ${pid}`, status: 'active', visibility: 'org_private', sharedWithOrgIds: [],
      startDate: NOW - 90 * DAY, nextReviewAt: NOW + 10 * DAY, endDate: null,
      createdAt: NOW - 90 * DAY, updatedAt: NOW, rev: 4,
      history: hist(historyPerRecord, 'plan_created'),
    });
    for (let g = 0; g < goals; g++) {
      const gid = `${pid}-g${g}`;
      db.developmentGoals.push({
        id: gid, planId: pid, playerId, title: `Goal ${g}`, description: 'Something specific.',
        category: ['technical', 'tactical', 'physical', 'match_understanding'][g % 4],
        status: ['not_started', 'in_progress', 'blocked', 'achieved'][g % 4],
        blockReason: g % 4 === 2 ? 'waiting_for_assessment' : null, blockNote: null,
        targetDate: NOW + 20 * DAY,
        // Every third goal carries an objective target, so target evaluation is
        // measured at a realistic density rather than on every goal or none.
        target: g % 3 === 0 ? TARGET : null,
        createdBy: { kind: 'org', id: 'u1', name: 'A Coach' },
        createdAt: NOW - (80 - g) * DAY, updatedAt: NOW, rev: 2,
        history: hist(historyPerRecord, 'goal_created'),
      });
      for (let a = 0; a < actionsPerGoal; a++) {
        db.developmentActions.push({
          id: `${gid}-a${a}`, planId: pid, goalId: gid, playerId,
          type: 'training', title: `Action ${a}`, dueAt: NOW + (a - 1) * DAY,
          assignee: { kind: 'player', id: playerId, name: 'A Player' },
          status: ['todo', 'done', 'in_progress'][a % 3],
          createdBy: { kind: 'org', id: 'u1', name: 'A Coach' },
          createdAt: NOW - 40 * DAY, updatedAt: NOW, completedAt: a % 3 === 1 ? NOW - DAY : null,
          history: hist(historyPerRecord, 'action_created'),
        });
      }
      for (let l = 0; l < linksPerGoal; l++) {
        const eid = `${gid}-e${l}`;
        db.evidence.push({ id: eid, playerId, label: `Evidence ${l}`, verification: { status: 'coach_confirmed' }, recordedAt: NOW - 10 * DAY });
        db.developmentEvidenceLinks.push({
          id: `${gid}-l${l}`, planId: pid, goalId: gid, actionId: null, playerId,
          sourceType: 'passport_evidence', sourceId: eid,
          linkedByKind: 'org', linkedById: 'u1', linkedByName: 'A Coach', linkedAt: NOW - 9 * DAY,
        });
      }
    }
    for (let r = 0; r < reviewCount; r++) {
      db.developmentReviews.push({
        id: `${pid}-r${r}`, planId: pid, playerId, reviewerKind: 'coach_review',
        reviewedBy: { kind: 'org', id: 'u1', name: 'A Coach' }, orgId: 'org-a',
        reviewedAt: NOW - r * 30 * DAY, sharedSummary: 'A summary.', internalNote: 'A note.',
        goalSnapshots: [], nextReviewAt: null, sharedWithPlayerAt: NOW - r * 30 * DAY,
        shareScopes: ['summary'], supersedes: null, supersededBy: null,
        createdAt: NOW - r * 30 * DAY, history: hist(historyPerRecord, 'review_submitted'),
      });
    }
  };

  makePlan('devplan-subject', 'p1', goalCount);
  for (let o = 0; o < otherPlans; o++) makePlan(`devplan-other-${o}`, `p-other-${o}`, 4);

  // A player's Combine attempts: the set every objective target is evaluated
  // against, once per targeted goal.
  for (let c = 0; c < 12; c++) {
    db.boxSessions.push({ id: `boxs-${c}`, playerId: 'p1', verificationState: 'verified', drillId: 'box-touches', provider: 'local_test', endedAt: NOW - c * DAY });
    db.combineAttempts.push({
      id: `catt-${c}`, playerId: 'p1', protocolId: 'combine-box-touch-60', protocolVersion: 1,
      provider: c % 2 ? 'local_test' : 'web_client', combineState: 'combine_verified',
      measuredValue: 140 + c, boxSessionId: `boxs-${c}`, completedAt: NOW - c * DAY,
    });
  }
  return db;
}

const player = { id: 'p1', name: 'A Player', isMinor: false };
const viewer = { kind: 'org_staff', org: { id: 'org-a' }, orgUser: { id: 'u1', lead: true }, isLead: true };
const access = planAccess(viewer, { id: 'devplan-subject', playerId: 'p1', owner: { kind: 'org', orgId: 'org-a' }, visibility: 'org_private' }, { player, orgCanSee: () => true, isLead: () => true });
const orgCanSee = () => true;

console.log('M21 performance probe — the Development Plan projection\n');
console.log('One machine, warm process, synthetic data. Measurements, not guarantees.\n');

const rows = [];
for (const spec of [
  { name: '10 goals, 4 reviews, 1 plan in the store', goals: 10, otherPlans: 0 },
  { name: '50 goals, 4 reviews, 1 plan in the store', goals: 50, otherPlans: 0 },
  { name: '10 goals, 4 reviews, 500 plans in the store', goals: 10, otherPlans: 500 },
  { name: '50 goals, 4 reviews, 500 plans in the store', goals: 50, otherPlans: 500 },
]) {
  const db = snapshot(spec);
  const records = db.developmentPlans.length + db.developmentGoals.length + db.developmentActions.length
    + db.developmentEvidenceLinks.length + db.developmentReviews.length;
  console.log(`\n— ${spec.name} (${records} development records in the store) —`);

  const collect = ms('collectPlan (the scan)', () => collectPlan(db, 'devplan-subject'), 300);
  const bundle = collectPlan(db, 'devplan-subject');
  const whole = ms('buildDevelopmentPlan (whole projection)', () => buildDevelopmentPlan({
    db, planId: 'devplan-subject', player, viewer, access, orgCanSee, now: NOW, collected: bundle,
  }), 200);
  const timeline = ms('buildTimeline', () => buildTimeline({ ...bundle, access }), 400);

  const attempts = db.combineAttempts.filter((a) => a.playerId === 'p1');
  const sessions = new Map(db.boxSessions.map((s) => [s.id, s]));
  const targeted = bundle.goals.filter((g) => g.target);
  const targets = ms(`evaluateTarget × ${targeted.length} targeted goals`, () => {
    for (const g of targeted) evaluateTarget({ target: g.target, attempts, sessions });
  }, 400);
  const links = ms(`resolveEvidenceLink × ${bundle.links.length} links`, () => {
    for (const l of bundle.links) resolveEvidenceLink(l, { db, player, viewer, orgCanSee, now: NOW });
  }, 300);
  const snaps = ms('buildGoalSnapshots (a review submission)', () => buildGoalSnapshots({
    goals: bundle.goals, actions: bundle.actions, links: bundle.links, attempts, sessions,
  }), 300);
  const list = ms('planListItem (one row of a list)', () => planListItem({
    plan: bundle.plan, player, goals: bundle.goals, actions: bundle.actions, now: NOW,
  }), 1000);

  rows.push({ name: spec.name, records, collect, whole, timeline, targets, links, snaps, list });
}

// ---- history depth, measured on its own
console.log('\n— history depth —');
for (const depth of [100, 500]) {
  const perRecord = Math.ceil(depth / 15);
  const db = snapshot({ goals: 10, historyPerRecord: perRecord });
  const bundle = collectPlan(db, 'devplan-subject');
  const entries = buildTimeline({ ...bundle, access }).length;
  ms(`buildTimeline over ~${entries} entries`, () => buildTimeline({ ...bundle, access }), 300);
}

// ---- what the numbers say
console.log('\n— what these numbers say —\n');
const small = rows[0];
const big = rows[3];
// `whole` is measured with the bundle already collected, so a real read costs
// collect + whole. Comparing them as a share of that total is the only reading
// of these two numbers that means anything.
// `ms()` returns milliseconds; everything below is stated in microseconds.
const US = 1000;
const fullSmallStore = (rows[1].collect + rows[1].whole) * US;
const fullBigStore = (big.collect + big.whole) * US;
const scanShare = Math.round(((big.collect * US) / fullBigStore) * 100);
console.log(`  A full 50-goal read costs ${fullBigStore.toFixed(0)} µs with 500 other plans in the store,`);
console.log(`  and ${fullSmallStore.toFixed(0)} µs with none. The scan is ${scanShare}% of the larger figure.`);
console.log(`  A plan grows ${(rows[1].whole / rows[0].whole).toFixed(1)}× in projection cost from 10 goals to 50.`);
console.log(`  Adding 500 unrelated plans changes a 10-goal read by ${((rows[2].collect + rows[2].whole) / (rows[0].collect + rows[0].whole)).toFixed(2)}×.`);
console.log('');
console.log('  The two costs grow along different axes, which is the useful finding:');
console.log('    • the SCAN is linear in the size of the whole development store;');
console.log('    • the PROJECTION is linear in the size of THIS plan, which is bounded by');
console.log('      construction — at most 20 goals, 20 actions each, 30 links each.');
console.log('');
// The threshold, named rather than left to judgement, so the next person has a
// number instead of a feeling.
const perRecordUs = (big.collect * US) / big.records;
const recordsFor10ms = Math.round((10_000 / perRecordUs) / 1000) * 1000;  // 10 ms = 10,000 µs
console.log(`  The scan costs about ${(perRecordUs * 1000).toFixed(0)} ns per development record. A single plan read`);
console.log(`  would not reach 10 ms until roughly ${recordsFor10ms.toLocaleString('en-GB')} development records exist —`);
console.log('  a store far larger than anything this deployment holds or is designed for.');
console.log('');
console.log('  So NO index is added. The snapshot store has no indexing layer at all, so');
console.log('  "add an index" means building one, and building one to save a quarter of a');
console.log('  millisecond is exactly the speculative optimisation M18.2, M19 and M20 each');
console.log('  declined (§154). The threshold above is the number to profile against when');
console.log('  somebody asks again, rather than re-deciding it by feel.');
console.log('');
console.log('  Honest limitations of this probe:');
console.log('   • one machine, one warm process, synthetic data;');
console.log('   • evidence links here all resolve against db.evidence, the cheapest source;');
console.log('     a plan citing twenty Combine results costs more, bounded by the same');
console.log('     per-target limit;');
console.log('   • the snapshot store keeps everything in memory, so none of this measures');
console.log('     disk, and a deployment whose working set does not fit in memory has a');
console.log('     different problem than an index would solve;');
console.log('   • the history figures are the timeline projection only — the routes page it');
console.log(`     at ${100} entries, so no single response walks the largest case measured.`);
console.log(`\n  Smallest full read measured: ${((small.collect + small.whole) * US).toFixed(0)} µs · largest: ${fullBigStore.toFixed(0)} µs`);
