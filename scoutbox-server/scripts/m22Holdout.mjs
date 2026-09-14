// M22 — the holdout run (§33–§38).
//
// RUN ONCE, UNDER A FROZEN SET OF CONSTANTS, AND REPORT SEPARATELY.
//
// Three properties make this a holdout rather than a second development set,
// and all three are CHECKED here rather than asserted in a comment:
//
//   1. The constants are frozen and intact (§34). If a threshold has moved
//      since the freeze was recorded, this script REFUSES TO RUN. Re-running
//      a holdout after adjusting the engine is how a holdout quietly becomes
//      a development set.
//
//   2. The seeds are disjoint from development (§35).
//
//   3. The results are reported beside the development results, never merged
//      into one figure (§38).
//
// ON EXIT CODES, AND WHY THEY ARE ASYMMETRIC
//
// A false touch or a false verification on holdout material exits non-zero:
// those are P0 correctness failures under §4 and §61 and their severity does
// not depend on which set they appear in.
//
// A COUNT ERROR on holdout material does NOT exit non-zero. That is
// deliberate, and it is the whole point of the exercise. A generalisation gap
// is a measurement — the number this script exists to produce — and turning
// it into a failing build creates exactly one incentive: make it pass. The
// gap is reported, loudly, in its own section, and the correct responses are
// to narrow the declared envelope, document the limitation, or fix the engine
// and then regenerate the holdout with fresh seeds under a new freeze. The
// incorrect response is to nudge a threshold until this script goes quiet,
// and that response is not available because the freeze check would catch it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObservationRun } from '../m22/engine.mjs';
import { decodeFrame } from '../m22/frames.mjs';
import {
  holdoutFamilies, holdoutFalseTouchStress, holdoutSeeds, DEV_SEEDS,
  GENERATION_PARAMETERS, HOLDOUT_GENERATIONS, ACTIVE_GENERATION,
} from '../m22/holdout.mjs';
import { freezeStatus, geometryMirrorCheck, FREEZE } from '../m22/freeze.mjs';
import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION } from '../m22/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const M22 = path.join(HERE, '..', 'm22');
const OUT = path.join(M22, 'holdout.json');
const DEV_EVAL = path.join(M22, 'evaluation.json');

const pad = (s, n) => String(s).padEnd(n);
const round3 = (n) => Math.round(n * 1000) / 1000;

// ------------------------------------------------------- preconditions

console.log(`M22 holdout — engine v${CV_ENGINE_VERSION}, policy v${BOX_CAM_CV_POLICY_VERSION}`);
console.log(`freeze ${FREEZE.freezeId} recorded ${FREEZE.frozenAt}`);
console.log(`holdout generation ${ACTIVE_GENERATION.generation}, seed base ${ACTIVE_GENERATION.seedBase}\n`);

// The ledger, printed every run. A consumed generation and the reason it was
// consumed are part of the result, not a footnote: a reader who sees only
// generation 2's clean numbers would be reading a materially incomplete
// account of what the holdout actually found.
const consumed = HOLDOUT_GENERATIONS.filter((g) => g.status === 'consumed');
if (consumed.length) {
  console.log('--- consumed generations ----------------------------------------');
  for (const g of consumed) {
    console.log(`generation ${g.generation} (freeze ${g.freezeId}) — CONSUMED`);
    console.log(`  false touches found: ${g.result.falseTouches}`);
    console.log(`  ${g.consumedBecause.replace(/\s+/g, ' ')}`);
  }
  console.log('  These cases are now permanent development regressions (see m22CvEval).\n');
}

const fz = freezeStatus();
if (!fz.intact) {
  console.error('m22Holdout: REFUSING TO RUN — the constant freeze has drifted.\n');
  for (const d of fz.drifted) {
    console.error(`  ${pad(d.group, 12)} recorded ${d.recorded}  live ${d.live}`);
  }
  console.error(
    '\nThe engine has changed since the freeze was recorded, so any holdout result\n' +
    'measured now would be measured against different constants than the ones the\n' +
    'holdout was generated under. Record a new freeze, regenerate the holdout with\n' +
    'fresh seeds, and run it once. Do not re-run the existing holdout.',
  );
  process.exit(2);
}
console.log('freeze intact           yes — all eight constant groups match the record');

const mirror = geometryMirrorCheck({
  readFile: (f) => fs.readFileSync(path.join(M22, f), 'utf8'),
});
if (!mirror.ok) {
  console.error('m22Holdout: REFUSING TO RUN — a mirrored geometry constant no longer appears in its source:');
  for (const m of mirror.missing) console.error(`  ${m.file}: ${m.needle}`);
  process.exit(2);
}
console.log('geometry mirror         verified against detect/track/protocol source');

const seeds = holdoutSeeds();
const collisions = seeds.filter((s) => DEV_SEEDS.includes(s));
if (collisions.length) {
  console.error(`m22Holdout: REFUSING TO RUN — holdout seeds collide with development seeds: ${collisions.join(', ')}`);
  process.exit(2);
}
console.log(`seeds disjoint          yes — holdout ${seeds.length} seeds, none in [${DEV_SEEDS.join(', ')}]\n`);

// ------------------------------------------------------------ evaluate

function evaluate(fx) {
  const run = new ObservationRun({ eventKind: fx.kind });
  for (const raw of fx.frames) {
    const d = decodeFrame(raw);
    if (!d.ok) continue;
    run.processFrame(d.frame);
  }
  return run.finish({});
}

/**
 * The same verdict logic the development harness uses, kept to the cases the
 * holdout actually declares. Identical judging matters: a holdout scored by a
 * kinder rule is not comparable to the development set it is reported beside.
 */
function judge(fx, result) {
  const exp = fx.expected;
  const accepted = result.state === 'accepted';
  if (exp.state === 'accepted') {
    if (!accepted) return { verdict: 'missed_acceptance', falseVerification: false, countError: null };
    const err = Math.abs((result.count ?? 0) - exp.count);
    return {
      verdict: err <= (exp.tolerance ?? 0) ? 'correct' : 'count_out_of_tolerance',
      falseVerification: false,
      countError: err,
    };
  }
  if (exp.state === 'zero_touches') {
    const n = result.count ?? 0;
    return {
      verdict: n === 0 ? 'correct' : 'FALSE_TOUCH',
      falseVerification: n > 0,
      countError: n,
    };
  }
  throw new Error(`holdout fixture ${fx.id} declares an unsupported expectation: ${exp.state}`);
}

const families = holdoutFamilies();
const familyRows = [];
let variants = 0, offTruth = 0, invarianceBreaks = 0, falseVerifications = 0;
const countErrors = [];

console.log('--- holdout counting families -----------------------------------');
for (const fam of families) {
  const counts = [], states = [];
  let famBad = 0;
  for (const v of fam.variants) {
    variants += 1;
    const result = evaluate(v);
    const j = judge(v, result);
    if (j.falseVerification) falseVerifications += 1;
    if (j.countError != null) countErrors.push(j.countError);
    const ok = j.verdict === 'correct';
    if (!ok) { famBad += 1; offTruth += 1; }
    counts.push(result.count);
    states.push(result.state);
    familyRows.push({
      family: fam.family, id: v.id,
      expectedState: v.expected.state, expectedCount: v.expected.count ?? null,
      gotState: result.state, gotCount: result.count,
      countError: j.countError, verdict: j.verdict,
    });
  }
  const checksCount = fam.invariant === 'count_must_match_across_variants';
  const got = counts.filter((c) => c != null);
  const spread = got.length ? Math.max(...got) - Math.min(...got) : 0;
  const sameState = new Set(states).size === 1;
  const invariant = checksCount ? (sameState && spread <= 2) : famBad === 0;
  if (!invariant) invarianceBreaks += 1;
  console.log(
    `${pad(fam.family, 30)} ${pad(fam.axis, 20)} counts [${counts.map((c) => (c == null ? '—' : c)).join(', ')}] ` +
    `${invariant ? (checksCount ? 'invariant' : 'on-truth') : '*** NOT INVARIANT ***'}${famBad ? ` ${famBad} off-truth` : ''}`,
  );
}

// -------------------------------------------- holdout adversarial group

const stress = holdoutFalseTouchStress();
const stressRows = [];
let falseTouches = 0;

console.log('\n--- holdout adversarial group (every case expects zero) ----------');
for (const st of stress) {
  const result = evaluate(st);
  const n = result.count ?? 0;
  if (n > 0) falseTouches += n;
  console.log(`${pad(st.id, 36)} ${pad(result.state, 26)} count ${n}${n > 0 ? '  *** FALSE TOUCH ***' : ''}`);
  stressRows.push({ id: st.id, description: st.description, gotState: result.state, gotCount: n, falseTouch: n > 0 });
}

// ------------------------------------------------------- determinism

let nondeterministic = 0;
for (const fam of families) {
  for (const v of fam.variants) {
    if (JSON.stringify(evaluate(v)) !== JSON.stringify(evaluate(v))) {
      nondeterministic += 1;
      console.log(`  ✗ NONDETERMINISTIC: ${v.id}`);
    }
  }
}

const meanAbsErr = countErrors.length ? countErrors.reduce((a, b) => a + b, 0) / countErrors.length : null;
const maxAbsErr = countErrors.length ? Math.max(...countErrors) : null;

// ------------------------------------------------ development, for contrast
//
// §38: read the development numbers and PRINT THEM IN A SEPARATE COLUMN. They
// are never averaged with the holdout numbers, and the artefact keeps them in
// separate objects so no downstream reader can merge them by accident.

let dev = null;
try {
  const raw = JSON.parse(fs.readFileSync(DEV_EVAL, 'utf8'));
  dev = {
    source: 'm22/evaluation.json',
    generatedAt: raw.generatedAt,
    engineVersion: raw.engineVersion,
    fixtures: raw.fixtureCount,
    familyVariants: raw.familyVariants,
    offTruth: raw.familyFailures,
    invarianceBreaks: raw.invarianceBreaks,
    stressCases: raw.stressCases,
    falseTouches: raw.falseTouches,
    falseVerifications: raw.falseVerifications,
    nondeterministic: raw.nondeterministic,
    meanAbsCountError: raw.meanAbsCountError,
    maxAbsCountError: raw.maxAbsCountError,
  };
} catch {
  console.log('\n(development evaluation artefact not readable; holdout reported alone)');
}

const holdout = {
  source: 'm22/holdout.mjs',
  familyCount: families.length,
  familyVariants: variants,
  offTruth,
  invarianceBreaks,
  stressCases: stress.length,
  falseTouches,
  falseVerifications,
  nondeterministic,
  meanAbsCountError: meanAbsErr == null ? null : round3(meanAbsErr),
  maxAbsCountError: maxAbsErr,
};

// The gap is the deliverable. It is computed and named, not left for a reader
// to work out by subtracting two tables.
const gap = dev ? {
  meanAbsCountError: dev.meanAbsCountError == null || holdout.meanAbsCountError == null
    ? null : round3(holdout.meanAbsCountError - dev.meanAbsCountError),
  offTruthRateDevelopment: dev.familyVariants ? round3(dev.offTruth / dev.familyVariants) : null,
  offTruthRateHoldout: variants ? round3(offTruth / variants) : null,
} : null;

const report = {
  kind: 'm22_holdout',
  generatedAt: new Date().toISOString(),
  engineVersion: CV_ENGINE_VERSION,
  policyVersion: BOX_CAM_CV_POLICY_VERSION,
  freeze: { ...fz, live: undefined },
  seedDisjointness: { holdoutSeeds: seeds, developmentSeeds: [...DEV_SEEDS], collisions: [] },
  generation: ACTIVE_GENERATION.generation,
  generations: HOLDOUT_GENERATIONS,
  parameters: GENERATION_PARAMETERS[ACTIVE_GENERATION.generation],
  provenance: 'synthetic_generated',
  realWorldValidation: false,
  realWorldValidationNote:
    'The holdout is held out from DEVELOPMENT, not from reality. It is rendered geometry, ' +
    'generated by the same scene model as the development set. It evidences that the engine ' +
    'is not fitted to particular development parameter values. It does not evidence real-world ' +
    'counting accuracy, and a strong holdout score is not a substitute for real-world validation.',
  // Two separate objects. Never merged (§38).
  development: dev,
  holdout,
  generalisationGap: gap,
  familyRows,
  stressRows,
};

fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

// ------------------------------------------------------------- report

console.log('\n--- reported separately (§38) -----------------------------------');
console.log(`${pad('', 26)}${pad('development', 16)}holdout`);
const row = (label, d, h) => console.log(`${pad(label, 26)}${pad(d ?? 'n/a', 16)}${h ?? 'n/a'}`);
row('family variants', dev?.familyVariants, variants);
row('off-truth variants', dev?.offTruth, offTruth);
row('invariance breaks', dev?.invarianceBreaks, invarianceBreaks);
row('adversarial cases', dev?.stressCases, stress.length);
row('FALSE TOUCHES', dev?.falseTouches, falseTouches);
row('FALSE VERIFICATIONS', dev?.falseVerifications, falseVerifications);
row('nondeterministic', dev?.nondeterministic, nondeterministic);
row('mean abs count error', dev?.meanAbsCountError, holdout.meanAbsCountError);
row('max abs count error', dev?.maxAbsCountError, holdout.maxAbsCountError);

if (gap) {
  console.log('\n--- generalisation gap ------------------------------------------');
  console.log(`mean abs count error     ${gap.meanAbsCountError == null ? 'n/a' : (gap.meanAbsCountError >= 0 ? '+' : '') + gap.meanAbsCountError} (holdout minus development)`);
  console.log(`off-truth rate           development ${gap.offTruthRateDevelopment}  holdout ${gap.offTruthRateHoldout}`);
}

console.log('\nprovenance               synthetic — held out from development, not from reality');
console.log(`written to               m22/holdout.json`);

if (falseTouches > 0) {
  console.error(`\nm22Holdout: FAILED — ${falseTouches} false touch(es) on holdout material. §4 makes this a P0.`);
  process.exit(1);
}
if (falseVerifications > 0) {
  console.error(`\nm22Holdout: FAILED — ${falseVerifications} false verification(s). §61 makes this a P0.`);
  process.exit(1);
}
if (nondeterministic > 0) {
  console.error(`\nm22Holdout: FAILED — ${nondeterministic} holdout variant(s) produced nondeterministic output.`);
  process.exit(1);
}

if (offTruth > 0 || invarianceBreaks > 0) {
  console.log(
    `\nm22Holdout: no P0 failures. ${offTruth} off-truth variant(s) and ${invarianceBreaks} invariance break(s)\n` +
    'are RECORDED, not failed — a generalisation gap is a measurement. The permitted\n' +
    'responses are to narrow the declared envelope, document the limitation, or fix the\n' +
    'engine and regenerate the holdout under a new freeze. Tuning against these numbers\n' +
    'is not one of them.',
  );
} else {
  console.log('\nm22Holdout: no false touches, no false verifications, deterministic, no generalisation gap measured.');
}
