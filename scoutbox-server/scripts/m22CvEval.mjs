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
console.log(`real-world validation    NO — synthetic fixtures only`);
console.log(`written to               m22/evaluation.json`);

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
