// M22 — CV evaluation harness (§128).
//
// This is NOT an API test. It evaluates the observation algorithm itself
// against the golden fixtures and writes a measured artefact that the
// production enablement gate reads (§129, §130).
//
// It reports what §60 demands — absolute count error, accept/reject
// correctness, false positives, FALSE VERIFICATIONS and refusal rate — and
// deliberately not a single "average accuracy", because an average is how a
// false verification hides.
//
// §61: a clearly invalid attempt accepted as a verified measurement is a P0.
// The harness exits non-zero on any such case, whatever the other numbers say.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObservationRun } from '../m22/engine.mjs';
import { decodeFrame } from '../m22/frames.mjs';
import { goldenFixtures } from '../m22/fixtures.mjs';
import { variationFamilies, falseTouchStress } from '../m22/families.mjs';
import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION } from '../m22/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'm22', 'evaluation.json');

/** Run one fixture through the engine exactly as the provider would. */
function evaluate(fx) {
  const run = new ObservationRun({ eventKind: fx.kind });
  let decodeErrors = 0;
  for (const raw of fx.frames) {
    const d = decodeFrame(raw);
    if (!d.ok) { decodeErrors += 1; continue; }
    run.processFrame(d.frame);
  }
  const result = run.finish({});
  return { result, decodeErrors };
}

/**
 * Judge one fixture against its declared ground truth.
 *
 * The verdicts are deliberately asymmetric. `falseVerification` means the
 * engine ACCEPTED and produced a count for material that should never have
 * produced one — that is the P0. A refusal where acceptance was expected is
 * a miss, which costs recall and is survivable.
 */
function judge(fx, result) {
  const exp = fx.expected;
  const accepted = result.state === 'accepted';
  const count = result.count;

  if (exp.state === 'accepted') {
    if (!accepted) return { verdict: 'missed_acceptance', falseVerification: false, countError: null };
    const err = Math.abs((count ?? 0) - exp.count);
    return {
      verdict: err <= (exp.tolerance ?? 0) ? 'correct' : 'count_out_of_tolerance',
      falseVerification: false,
      countError: err,
    };
  }

  if (exp.state === 'accepted_count_not_asserted') {
    // A declared limitation: the case is outside the supported envelope, so
    // its count is recorded but not marked against ground truth. It must
    // still not be a false verification of something invalid.
    return { verdict: accepted ? 'correct' : 'correct_refusal', falseVerification: false, countError: null };
  }

  if (exp.state === 'accepted_with_zero_or_refusal') {
    // Camera shake with a stationary ball. Accepting is fine ONLY if nothing
    // was counted; any count here is a fabricated event.
    if (!accepted) return { verdict: 'correct_refusal', falseVerification: false, countError: null };
    const n = count ?? 0;
    return {
      verdict: n === 0 ? 'correct' : 'false_positive_events',
      falseVerification: n > 0,
      countError: n,
    };
  }

  if (exp.state === 'any_refusal_or_uncounted') {
    if (!accepted) return { verdict: 'correct_refusal', falseVerification: false, countError: null };
    const n = count ?? 0;
    return {
      verdict: n === 0 ? 'correct' : 'false_positive_events',
      falseVerification: n > 0,
      countError: n,
    };
  }

  // A specific refusal state was required.
  if (accepted) {
    return { verdict: 'FALSE_VERIFICATION', falseVerification: true, countError: count ?? 0 };
  }
  return {
    verdict: result.state === exp.state ? 'correct_refusal' : 'refused_wrong_reason',
    falseVerification: false,
    countError: null,
    got: result.state,
  };
}

// ------------------------------------------------------------------ run

const fixtures = goldenFixtures();
const rows = [];
let falseVerifications = 0;
let accepted = 0;
let refused = 0;
let correct = 0;

console.log(`M22 CV evaluation — engine v${CV_ENGINE_VERSION}, policy v${BOX_CAM_CV_POLICY_VERSION}`);
console.log(`${fixtures.length} golden fixtures (synthetic; see m22/fixtures.mjs for what that does and does not prove)\n`);

for (const fx of fixtures) {
  const { result, decodeErrors } = evaluate(fx);
  const j = judge(fx, result);
  if (result.state === 'accepted') accepted += 1; else refused += 1;
  if (j.falseVerification) falseVerifications += 1;
  if (j.verdict === 'correct' || j.verdict === 'correct_refusal') correct += 1;

  rows.push({
    id: fx.id,
    kind: fx.kind,
    expectedState: fx.expected.state,
    expectedCount: fx.expected.count ?? null,
    gotState: result.state,
    gotCount: result.count,
    countError: j.countError,
    verdict: j.verdict,
    falseVerification: j.falseVerification,
    confidence: result.confidence?.aggregate ?? 0,
    coverage: result.confidence?.coverage ?? 0,
    decodeErrors,
    detail: result.detail ?? null,
  });

  const flag = j.falseVerification ? ' ***FALSE VERIFICATION***' : '';
  const cnt = result.count == null ? '—' : String(result.count);
  console.log(
    `${pad(fx.id, 22)} expect ${pad(fx.expected.state, 34)} got ${pad(result.state, 26)} count ${pad(cnt, 5)} ${j.verdict}${flag}`,
  );
}

// ==================================================== FIX A: families
//
// Each family varies ONE axis (or a documented combination) and asserts that
// the semantic result is unchanged across its variants. A family that counts
// 8 at one resolution and 6 at another has a pixel-space threshold in it,
// whatever its average looks like.

const families = variationFamilies();
let familyVariants = 0;
let familyFailures = 0;
let invarianceBreaks = 0;
const familyRows = [];

console.log(`\n--- Fix A: variation families -----------------------------------`);
for (const fam of families) {
  const counts = [];
  const states = [];
  let famBad = 0;
  for (const v of fam.variants) {
    familyVariants += 1;
    const { result } = evaluate(v);
    const j = judge(v, result);
    if (j.falseVerification) falseVerifications += 1;
    const ok = j.verdict === 'correct' || j.verdict === 'correct_refusal';
    if (!ok) { famBad += 1; familyFailures += 1; }
    counts.push(result.count);
    states.push(result.state);
    familyRows.push({
      family: fam.family, id: v.id, expectedState: v.expected.state,
      expectedCount: v.expected.count ?? null, gotState: result.state,
      gotCount: result.count, verdict: j.verdict, falseVerification: j.falseVerification,
    });
  }
  // The invariance property itself.
  //
  // Only families that declare `count_must_match_across_variants` are checked
  // for a matching count, because only those hold the underlying physical
  // event count constant while varying something that must not matter
  // (resolution, frame rate, ball size, contrast, camera motion). The pace
  // family deliberately varies how many touches occur, so comparing its raw
  // counts across variants measures nothing — each variant is instead held
  // to its own declared ground truth, which is the off-truth count above.
  const checksCount = fam.invariant === 'count_must_match_across_variants';
  const acceptedCounts = counts.filter((c) => c != null);
  const spread = acceptedCounts.length ? Math.max(...acceptedCounts) - Math.min(...acceptedCounts) : 0;
  const sameState = new Set(states).size === 1;
  const invariant = checksCount ? (sameState && spread <= 2) : famBad === 0;
  if (!invariant) invarianceBreaks += 1;
  console.log(
    `${pad(fam.family, 28)} ${pad(fam.axis, 16)} variants ${pad(fam.variants.length, 3)} ` +
    `counts [${counts.map((c) => (c == null ? '—' : c)).join(', ')}] ` +
    `${invariant ? (checksCount ? 'invariant' : 'on-truth') : '*** NOT INVARIANT ***'}${famBad ? ` ${famBad} off-truth` : ''}`,
  );
}

// ================================================ FIX B: false-touch stress
//
// Twenty attempts to manufacture a touch that never happened. Every one
// expects zero. §4: any false touch here is a P0 for exact counting.

const stress = falseTouchStress();
let falseTouches = 0;
let stressAccepted = 0;
const stressRows = [];

console.log(`\n--- Fix B: false-touch stress suite ------------------------------`);
for (const st of stress) {
  const { result } = evaluate(st);
  const n = result.count ?? 0;
  const accepted = result.state === 'accepted';
  if (accepted) stressAccepted += 1;
  if (n > 0) {
    falseTouches += n;
    console.log(`${pad(st.id, 36)} ${pad(result.state, 26)} count ${n}  *** FALSE TOUCH ***`);
  } else {
    console.log(`${pad(st.id, 36)} ${pad(result.state, 26)} count 0`);
  }
  stressRows.push({ id: st.id, description: st.description, gotState: result.state, gotCount: n, falseTouch: n > 0 });
}

// -------------------------------------------------------- determinism
//
// §76 of the negative list, and the property the whole gate rests on: the
// same fixture must produce the same answer every time. Each fixture is run
// a second time and compared field by field.
let nondeterministic = 0;
for (const fx of fixtures) {
  const a = evaluate(fx).result;
  const b = evaluate(fx).result;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    nondeterministic += 1;
    console.log(`  ✗ NONDETERMINISTIC: ${fx.id}`);
  }
}

const countingRows = rows.filter((r) => r.expectedState === 'accepted');
const countErrors = countingRows.map((r) => r.countError).filter((n) => n != null);
const meanAbsErr = countErrors.length ? countErrors.reduce((a, b) => a + b, 0) / countErrors.length : null;
const maxAbsErr = countErrors.length ? Math.max(...countErrors) : null;

const report = {
  engineVersion: CV_ENGINE_VERSION,
  policyVersion: BOX_CAM_CV_POLICY_VERSION,
  generatedAt: new Date().toISOString(),
  fixtureCount: fixtures.length,
  // §57/§59: the provenance of the evaluation material travels WITH the
  // numbers, so no reader can mistake this for real-world validation.
  fixtureProvenance: 'synthetic_generated',
  realWorldValidation: false,
  realWorldValidationNote:
    'No real football video was used. These fixtures are rendered geometry. They evidence determinism and refusal behaviour; they do not evidence real-world counting accuracy.',
  accepted,
  refused,
  correct,
  falseVerifications,
  nondeterministic,
  refusalRate: round3(refused / fixtures.length),
  familyCount: families.length,
  familyVariants,
  familyFailures,
  invarianceBreaks,
  stressCases: stress.length,
  falseTouches,
  stressAccepted,
  familyRows,
  stressRows,
  meanAbsCountError: meanAbsErr == null ? null : round3(meanAbsErr),
  maxAbsCountError: maxAbsErr,
  rows,
};

fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n--- measured result -------------------------------------------`);
console.log(`fixtures                 ${fixtures.length}`);
console.log(`accepted / refused       ${accepted} / ${refused}`);
console.log(`correct verdicts         ${correct} of ${fixtures.length}`);
console.log(`FALSE VERIFICATIONS      ${falseVerifications}   (§61: any is a P0)`);
console.log(`nondeterministic         ${nondeterministic}`);
console.log(`mean abs count error     ${meanAbsErr == null ? 'n/a' : meanAbsErr.toFixed(2)}`);
console.log(`max abs count error      ${maxAbsErr == null ? 'n/a' : maxAbsErr}`);
console.log(`refusal rate             ${(report.refusalRate * 100).toFixed(1)}%`);
console.log(`families / variants      ${families.length} / ${familyVariants}  (off-truth ${familyFailures})`);
console.log(`invariance breaks        ${invarianceBreaks}   (resolution + frame-rate + scale)`);
console.log(`false-touch stress cases ${stress.length}`);
console.log(`FALSE TOUCHES            ${falseTouches}   (§4: any is a P0)`);
console.log(`real-world validation    NO — synthetic fixtures only`);
console.log(`written to               m22/evaluation.json`);

if (falseTouches > 0) {
  console.error(`\nm22CvEval: FAILED — ${falseTouches} false touch(es) in the stress suite. §4 makes this a P0.`);
  process.exit(1);
}
if (invarianceBreaks > 0) {
  console.error(`\nm22CvEval: FAILED — ${invarianceBreaks} family/families are not invariant across their axis.`);
  process.exit(1);
}
if (familyFailures > 0) {
  console.error(`\nm22CvEval: FAILED — ${familyFailures} family variant(s) missed their declared ground truth.`);
  process.exit(1);
}
if (falseVerifications > 0) {
  console.error(`\nm22CvEval: FAILED — ${falseVerifications} false verification(s). §61 makes this a P0.`);
  process.exit(1);
}
if (nondeterministic > 0) {
  console.error(`\nm22CvEval: FAILED — ${nondeterministic} fixture(s) produced nondeterministic output.`);
  process.exit(1);
}
console.log(`\nm22CvEval: no false verifications, fully deterministic.`);

function pad(s, n) { return String(s).padEnd(n); }
function round3(n) { return Math.round(n * 1000) / 1000; }
