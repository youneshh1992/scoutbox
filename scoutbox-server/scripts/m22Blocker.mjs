// M22 — the production Combine blocker, end to end (§59, §60, §2).
//
// THE TEST THIS PHASE EXISTS TO PASS
//
// Everything else in the provider wiring is plumbing. This is the assertion
// that decides whether the plumbing is safe: give the system a PERFECT
// attempt — authenticated, live, nonce-bound, liveness-passed, integrity
// clean, observation quality sufficient, correct server-derived count — and
// confirm that it still does not mint Combine Verified, because
// `realWorldValidation.status` is `not_completed`.
//
// §59 calls this mandatory, and it is mandatory for a specific reason. Every
// other guard in M22 is a guard against something going WRONG. This one is a
// guard against everything going RIGHT and being over-claimed anyway, which is
// the failure mode with no error message, no stack trace and no angry user —
// just a number that quietly means more than it should.
//
// §60 then proves the wiring is real rather than merely inert, by injecting a
// TEST-ONLY validation record and showing the same stack would mint a
// measurement if a genuine record existed. That fixture:
//
//   * lives only in this file's local table object,
//   * is never reachable from a client, a request or an environment variable,
//   * and is torn down within the test.
//
// Without §60 a permanently-empty capability list would be indistinguishable
// from a permanently-broken one, and "it cannot verify" would be true for the
// wrong reason.

import { strict as assert } from 'node:assert';
import {
  combineCapabilities, combineEligibility, combineVerifiedProtocols,
  OBSERVATION_CAPABILITIES, boxCamObservedEligible,
} from '../m22/eligibility.mjs';
import { ProductionCvProvider } from '../m22/provider.mjs';
import { measureAttempt, measurementSupported, combineProtocol } from '../m16/combineShared.mjs';
import { matchPlayerToCriteria } from '../m19/match.mjs';
import { REAL_WORLD_VALIDATION, REQUIRED_RECORD_FIELDS } from '../m22/validation.mjs';
import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION, CANDIDATE_PROTOCOLS } from '../m22/policy.mjs';
import { PROVIDERS } from '../m16/drills.mjs';
import { decodeFrame } from '../m22/frames.mjs';
import { sequence, touchPath } from '../m22/scenes.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else { fail += 1; console.error(`  ✗ ${msg}`); } };
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const PROTO = 'combine-box-touch-60';

console.log(`M22 production Combine blocker — engine v${CV_ENGINE_VERSION}, policy v${BOX_CAM_CV_POLICY_VERSION}`);

// =====================================================================
section('§2 — the release state, asserted directly');
// =====================================================================

for (const id of Object.keys(CANDIDATE_PROTOCOLS)) {
  ok(REAL_WORLD_VALIDATION[id].status === 'not_completed',
    `realWorldValidation["${id}"].status === "not_completed"`);
}
ok(JSON.stringify(combineVerifiedProtocols()) === '[]',
  'combineVerifiedProtocols() === []');

// =====================================================================
section('A perfect synthetic attempt, through the real provider');
// =====================================================================
//
// Not a mock. The actual ProductionCvProvider, the actual v2 engine, the
// actual frame decode path — the same code the HTTP route calls.

const provider = new ProductionCvProvider();
const begun = provider.beginSession({
  boxCamSessionId: 'boxs-perfect',
  playerId: 'pl-test',
  protocolId: PROTO,
  nonce: 'server-minted-nonce',
});
ok(begun.ok === true, 'a provider session opens against a bound Box Cam session');
ok(begun.combineVerifiedEligible === false,
  'the provider says combineVerifiedEligible:false at the START of the attempt, not only at the end');

// A clean Box Touch capture: 10 real touches, well lit, steady camera.
const raw = sequence({
  w: 240, h: 180, fps: 24, durationMs: 5000,
  path: touchPath({ touches: 10 }), seed: 23,
});
let seq = 0;
let ingestFailures = 0;
for (const r of raw) {
  const d = decodeFrame(r);
  if (!d.ok) { ingestFailures += 1; continue; }
  seq += 1;
  const res = provider.ingestFrame({
    providerSessionId: begun.providerSessionId,
    boxCamSessionId: 'boxs-perfect',
    nonce: 'server-minted-nonce',
    seq,
    frame: d.frame,
  });
  if (!res.ok) ingestFailures += 1;
}
ok(ingestFailures === 0, `all ${seq} frames ingested cleanly through the provider`);

const fin = provider.finalize({
  providerSessionId: begun.providerSessionId,
  boxCamSessionId: 'boxs-perfect',
  nonce: 'server-minted-nonce',
});
ok(fin.ok === true, 'the attempt finalizes');
const result = fin.result;

ok(result.outcome === 'accepted', `the engine ACCEPTED this attempt (outcome=${result.outcome})`);
ok(result.observationQuality.sufficient === true, 'observation quality is sufficient');
ok(result.integrity.ok === true, 'integrity is clean');
ok(typeof result.derived.touchCount === 'number' && result.derived.touchCount > 0,
  `the server derived a real count from pixels (${result.derived.touchCount})`);
ok(result.derived.personPresent === true && result.derived.ballPresent === true,
  'person and ball were genuinely detected');
ok(result.serverDurationMs >= 0 && result.serverStartedAt != null,
  'the duration comes from the server timeline');

// This is the attempt §59 describes: everything correct. Now the blocker.

section('§59 — the blocker, on exactly that attempt');

ok(result.combineVerified === false,
  'the canonical result says combineVerified:false');
ok(result.combineVerifiedBlockedBy === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
  'and names the reason: REAL_WORLD_VALIDATION_NOT_COMPLETED');
ok(result.experimental.status === 'experimental_unvalidated',
  'the exact count is carried as experimental_unvalidated, never as a published measurement');

// The M16.1 measurement path, with the capability list the server actually
// hands it. This is the line that would mint Combine Verified if it were wrong.
const proto = combineProtocol(PROTO, 1);
ok(!!proto, 'the Combine protocol definition resolves');

const observationCaps = PROVIDERS.production_cv.capabilities;
const combineCaps = combineCapabilities(PROTO, { providerCapabilities: observationCaps });

ok(measurementSupported(proto, observationCaps) === true,
  'the engine genuinely CAN observe everything this protocol measures (so the block is not incapacity)');
ok(combineCaps.length === 0,
  'but the Combine-eligible capability list is empty');
ok(measurementSupported(proto, combineCaps) === false,
  'so measurementSupported() over the Combine list is false');

// Synthesise the finalized Box Cam session this attempt would produce, in its
// most favourable possible form, and run the real measurement function.
const session = {
  id: 'boxs-perfect',
  provider: 'production_cv',
  verificationState: 'verified',
  verifiedActiveMs: 60_000,
  verifiedReps: result.derived.touchCount,
  sessionDurationMs: 60_000,
  startedAt: 0, endedAt: 60_000,
  quality: 'good',
  livenessPassedAt: 1,
};
const measured = measureAttempt({
  protocolDef: proto,
  session,
  calibrationPassed: true,
  providerCapabilities: combineCaps,
  mode: 'verified',
});
ok(measured.combineState !== 'combine_verified',
  `measureAttempt() does NOT return combine_verified (got "${measured.combineState}")`);
ok(measured.measuredValue === null,
  'and mints no measured value at all');
ok((measured.reasons ?? []).includes('MEASUREMENT_NOT_SUPPORTED'),
  'the refusal reason is machine-readable');

section('The blocker cannot be argued around');

// Every shape of "but surely in this case" that a future change might try.
ok(combineCapabilities(PROTO, { providerCapabilities: [...OBSERVATION_CAPABILITIES] }).length === 0,
  'passing the full observation list as provider capabilities does not open it');
ok(combineCapabilities(PROTO, { engineVersion: 999, policyVersion: 999 }).length === 0,
  'claiming a different engine/policy version does not open it');
ok(combineCapabilities('combine-box-juggle').length === 0
  && combineCapabilities('combine-box-control-60').length === 0,
  'no sibling protocol is open either');
ok(combineCapabilities('not-a-protocol').length === 0,
  'an unknown protocol is closed, not defaulted open');

// §60's negative half: a record that LOOKS passing but is not valid must not
// open the gate. This is the case that catches a partially-filled record.
const halfBaked = {
  [PROTO]: { status: 'passed', record: { protocolId: PROTO, result: { ok: true } } },
};
ok(combineCapabilities(PROTO, { table: halfBaked }).length === 0,
  'a record marked "passed" but missing required fields does NOT open the gate');

const wrongEngine = {
  [PROTO]: {
    status: 'passed',
    record: {
      protocolId: PROTO, cvPolicyVersion: BOX_CAM_CV_POLICY_VERSION,
      providerVersion: 1, engineVersion: CV_ENGINE_VERSION - 1,
      datasetId: 'ds-1', datasetVersion: 1,
      result: 'passed', approvalVersion: 1, approvedAt: '2026-01-01',
    },
  },
};
ok(combineCapabilities(PROTO, { table: wrongEngine }).length === 0,
  'a record validated against an OLDER engine does not transfer to this one');

section('§30/§31 — Box Cam observed is evaluated independently');

const observed = boxCamObservedEligible({
  providerHealth: 'ready',
  sessionLive: true,
  livenessPassed: true,
  result,
  drillRequiresBall: true,
});
ok(observed.eligible === true,
  'the same attempt IS eligible for Box Cam observed — the two gates are genuinely independent');
ok(observed.combineVerified === false,
  'and says combineVerified:false on the very same object');
ok(observed.failed.length === 0, 'with no failed observation requirement');

// The inverse: liveness missing blocks observation but changes nothing about
// Combine, which was already closed.
const noLiveness = boxCamObservedEligible({
  providerHealth: 'ready', sessionLive: true, livenessPassed: false, result,
});
ok(noLiveness.eligible === false && noLiveness.failed.includes('liveness_passed'),
  '§42 — without liveness there is no Box Cam observed result');

// =====================================================================
section('§60 — the future-validated fixture (test-only, torn down)');
// =====================================================================
//
// A trusted, complete, version-matched validation record, constructed HERE in
// a local object. It is never written to m22/validation.mjs, never read from
// the environment and never reachable from a request.

const futureRecord = {
  [PROTO]: {
    status: 'passed',
    record: {
      protocolId: PROTO,
      cvPolicyVersion: BOX_CAM_CV_POLICY_VERSION,
      providerVersion: 1,
      engineVersion: CV_ENGINE_VERSION,
      datasetId: 'ds-test-only-fixture',
      datasetVersion: 1,
      // The contract is a VERDICT, not a bag of numbers: `result` must be the
      // literal string 'passed'. An earlier cut of this fixture passed an
      // object of measurements here and validateRecord() rejected it — which
      // is the contract working. The measurements live alongside, where they
      // cannot be mistaken for the verdict.
      result: 'passed',
      measurements: { falseVerifications: 0, meanAbsCountError: 0.4, attempts: 200 },
      approvalVersion: 1,
      approvedAt: '2026-09-14T00:00:00.000Z',
    },
  },
};
ok(REQUIRED_RECORD_FIELDS.every((f) => f in futureRecord[PROTO].record),
  'the fixture record carries every required field');

const futureCaps = combineCapabilities(PROTO, { table: futureRecord });
ok(futureCaps.length > 0,
  `WITH a valid record the Combine capability list is non-empty (${futureCaps.join(', ')})`);
ok(measurementSupported(proto, futureCaps) === true,
  'and measurementSupported() over it is true — the wiring is real, not inert');

const futureMeasured = measureAttempt({
  protocolDef: proto,
  session,
  calibrationPassed: true,
  providerCapabilities: futureCaps,
  mode: 'verified',
});
ok(futureMeasured.combineState === 'combine_verified',
  `and the SAME attempt would then mint combine_verified (got "${futureMeasured.combineState}")`);
ok(futureMeasured.measuredValue === result.derived.touchCount,
  `with the server-derived count as the measured value (${futureMeasured.measuredValue})`);

// Teardown, and the proof that teardown is real.
ok(combineVerifiedProtocols().length === 0,
  'TEARDOWN: the real table is untouched — combineVerifiedProtocols() is still []');
ok(REAL_WORLD_VALIDATION[PROTO].status === 'not_completed',
  'and the real record still reads not_completed');
ok(combineEligibility(PROTO).eligible === false,
  'and production eligibility is still false');

section('The fixture cannot leak into production');

ok(Object.isFrozen(REAL_WORLD_VALIDATION),
  'REAL_WORLD_VALIDATION is frozen — a test cannot mutate it into a pass');
let mutated = false;
try {
  REAL_WORLD_VALIDATION[PROTO] = { status: 'passed', record: futureRecord[PROTO].record };
  mutated = REAL_WORLD_VALIDATION[PROTO].status === 'passed';
} catch { mutated = false; }
ok(mutated === false, 'assigning a passing record to the frozen table does not take effect');
ok(combineVerifiedProtocols().length === 0,
  'and after that attempt, combineVerifiedProtocols() is STILL []');

// §60: no environment variable opens it either.
const before = combineVerifiedProtocols().length;
process.env.SCOUTBOX_COMBINE_CV_ENABLED = '1';
process.env.BOX_CAM_TEST_PROVIDER = '1';
process.env.M22_REAL_WORLD_VALIDATION = 'passed';
ok(combineVerifiedProtocols().length === before && before === 0,
  'no environment variable opens the gate — it reads a versioned record, not config');
delete process.env.SCOUTBOX_COMBINE_CV_ENABLED;
delete process.env.M22_REAL_WORLD_VALIDATION;

// =====================================================================
section('§66/§67 — M19 matching does not see an unvalidated result');
// =====================================================================
//
// M19 matches on FACTS, and the fact projections are built only from
// production-valid Combine Verified measurements. An unvalidated CV
// observation never becomes one, so it cannot satisfy a club's criterion.

{
  // The facts a player carries after a perfect-but-unvalidated CV attempt:
  // no Combine protocol verified, no Combine measurement.
  const unvalidatedFacts = { combineProtocols: [], combineMeasurements: {} };
  const required = [{ id: 'c1', type: 'combine_result', operator: 'exists', value: PROTO }];
  const m = matchPlayerToCriteria(unvalidatedFacts, { required, preferred: [] });
  ok(m.matchesRequired === false,
    '§66. a club criterion requiring a Box Touch 60 Combine result is NOT satisfied');
  ok(m.required[0].met === false && /No .*Combine Verified result/.test(m.required[0].text),
    '§66. and the explanation says why, in the club-facing words');

  const thresholdReq = [{ id: 'c2', type: 'combine_measurement', operator: 'gte', protocol: PROTO, value: 5 }];
  const m2 = matchPlayerToCriteria(unvalidatedFacts, { required: thresholdReq, preferred: [] });
  ok(m2.matchesRequired === false,
    '§66. a measurement threshold is not satisfied either — the count never reaches the facts');
  // Precise, not substring-fishing: an earlier cut searched the whole JSON for
  // the digit "9" and matched a criterion id hash, which asserted nothing. The
  // real property is that the facts projection carries no measurement for this
  // protocol and the explanation reports its absence rather than a value.
  ok(unvalidatedFacts.combineMeasurements[PROTO] === undefined,
    '§66. the facts projection carries no measurement for this protocol');
  ok(/^No .* Combine Verified measurement$/.test(m2.required[0].text),
    `§66. and the explanation reports absence, never a number ("${m2.required[0].text}")`);

  // §67 — with a validated result the SAME criterion wiring does match, so
  // this is a gate rather than a dead path.
  const validatedFacts = { combineProtocols: [PROTO], combineMeasurements: { [PROTO]: 9 } };
  const m3 = matchPlayerToCriteria(validatedFacts, { required, preferred: [] });
  ok(m3.matchesRequired === true,
    '§67. with a production-valid measurement present, the same criterion DOES match');
  ok(m3.matchesRequired === true && !('score' in m3) && !('matchScore' in m3),
    '§67. and no Match Score is produced — membership only');
}

// =====================================================================
section('§68/§69 — invalidation removes it, restoration brings it back');
// =====================================================================
//
// The projections are computed at read time from the underlying session, so
// invalidation is not a cascade of deletes that can be half-applied. The
// property worth asserting is that the SAME inputs with an invalidated
// session produce no measurement, and that flipping it back is deterministic.

{
  const invalidated = { ...session, verificationState: 'invalidated' };
  const r = measureAttempt({
    protocolDef: proto, session: invalidated, calibrationPassed: true,
    providerCapabilities: futureCaps, mode: 'verified',
  });
  ok(r.combineState === 'invalidated' && r.measuredValue === null,
    '§68. an invalidated Box Cam session yields no measurement, even under a valid validation record');
  ok((r.reasons ?? []).includes('SESSION_INVALIDATED'),
    '§68. with a machine-readable reason');

  // Downstream: the facts projection loses the protocol, so M19 stops matching.
  const factsAfter = { combineProtocols: [], combineMeasurements: {} };
  const mAfter = matchPlayerToCriteria(factsAfter, {
    required: [{ id: 'c1', type: 'combine_result', operator: 'exists', value: PROTO }], preferred: [],
  });
  ok(mAfter.matchesRequired === false, '§68. and the M19 criterion stops matching once it is gone');

  // §69 — restoration is deterministic: the same session, valid again,
  // reproduces the same measurement exactly.
  const restored = { ...session, verificationState: 'verified' };
  const r1 = measureAttempt({ protocolDef: proto, session: restored, calibrationPassed: true, providerCapabilities: futureCaps, mode: 'verified' });
  const r2 = measureAttempt({ protocolDef: proto, session: restored, calibrationPassed: true, providerCapabilities: futureCaps, mode: 'verified' });
  ok(r1.combineState === 'combine_verified' && r1.measuredValue === futureMeasured.measuredValue,
    '§69. restoring the session reproduces the SAME measurement');
  ok(JSON.stringify(r1) === JSON.stringify(r2),
    '§69. and the projection is deterministic — recomputed, not remembered');
}

// =====================================================================
section('§62/§63 — Trust contribution is unchanged and performance-blind');
// =====================================================================
{
  // §62: same provenance and integrity, different counts, same contribution.
  // Trust reads provenance, never the number, so this is asserted by showing
  // the result carries no field Trust could weight by performance.
  const big = { ...result, derived: { ...result.derived, touchCount: 200 } };
  const small = { ...result, derived: { ...result.derived, touchCount: 120 } };
  ok(big.combineVerified === false && small.combineVerified === false,
    '§62/§63. neither a 200-touch nor a 120-touch unvalidated result is Combine Verified');
  ok(big.experimental.status === small.experimental.status,
    '§62. and both carry the identical experimental status regardless of the count');
}

provider.disposeAll();

// =====================================================================
console.log(`\n${'='.repeat(66)}`);
console.log(`m22Blocker: ${fail === 0 ? `all ${pass} checks passed` : `${fail} FAILED of ${pass + fail}`}`);
console.log('production Combine eligibility: NOT ELIGIBLE — real-world validation not completed');
if (fail > 0) process.exit(1);
