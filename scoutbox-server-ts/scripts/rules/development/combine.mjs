// The At-Home Combine rules behind the Combine battery (e2e/development/combine.mjs), checked in this process: the
// protocol registry and its honesty gate, measurement derivation, personal bests, the comparison and the result hash.
import {
  COMBINE_PROTOCOLS,
  combineProtocol,
  latestCombineProtocol,
  measurementSupported,
  measurementCapability,
  measureAttempt,
  formatCombineValue,
  personalBest,
  combineResultHash,
  comparisonMatrix,
} from '../../../domains/development/boxcam/combineShared.mjs';
import { PROVIDERS } from '../../../domains/development/boxcam/drills.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('development/combine');
const WINDOW = 60_000;

// ============================================================ Unit: registry
section('U1 — protocol registry + honesty gate (pure)');
{
  ok(COMBINE_PROTOCOLS.length >= 9, 'combine protocol library present');
  ok(
    COMBINE_PROTOCOLS.every((p) => p.id && p.version >= 1 && p.metricType && p.measurementAlgorithmVersion >= 1),
    'every protocol is versioned with a metric + algorithm version',
  );
  const webCaps = PROVIDERS.web_client.capabilities;
  const testCaps = PROVIDERS.local_test.capabilities;
  neg(
    measurementCapability(combineProtocol('combine-box-touch-60', 1), webCaps) === 'not_configured',
    'Box Touch 60 (count) is NOT supported on the production web provider — honestly not_configured',
  );
  neg(
    measurementCapability(combineProtocol('combine-box-control-60', 1), webCaps) === 'not_configured',
    'Box Control 60 (ball duration) is NOT supported on web (no ball observation) — not_configured, not faked',
  );
  ok(
    measurementSupported(combineProtocol('combine-box-touch-60', 1), testCaps),
    'count protocol IS supported by the gated test provider (demo)',
  );
  neg(
    measurementCapability(combineProtocol('combine-accel-10m', 1), testCaps) === 'not_configured',
    '10m sprint needs capabilities NO provider has — not_configured even under the test provider',
  );
  neg(
    measurementCapability(combineProtocol('combine-broad-jump', 1), testCaps) === 'not_configured',
    'broad jump distance needs spatial scale no provider has — never fabricated',
  );
  ok(latestCombineProtocol('combine-box-touch-60').version === 1, 'latest protocol resolves');
}

section('U2 — measurement derivation (pure): server-only, no projection');
{
  const proto = combineProtocol('combine-box-touch-60', 1);
  const caps = PROVIDERS.local_test.capabilities;
  const full = {
    verificationState: 'partially_verified',
    sessionDurationMs: WINDOW,
    verifiedReps: 184,
    verifiedActiveMs: 60_000,
    quality: 'good',
  };
  const r1 = measureAttempt({
    protocolDef: proto,
    session: full,
    calibrationPassed: true,
    providerCapabilities: caps,
    mode: 'verified',
  });
  ok(
    r1.combineState === 'combine_verified' && r1.measuredValue === 184,
    'full 60s window + good quality → combine_verified 184 (drill target irrelevant)',
  );
  const short = {
    verificationState: 'partially_verified',
    sessionDurationMs: 43_200,
    verifiedReps: 132,
    verifiedActiveMs: 43_200,
    quality: 'good',
  };
  const r2 = measureAttempt({
    protocolDef: proto,
    session: short,
    calibrationPassed: true,
    providerCapabilities: caps,
    mode: 'verified',
  });
  neg(
    r2.combineState === 'partially_measured' && r2.measuredValue === 132 && r2.observedMs === 43_200,
    'short window → partially_measured 132, observed 43.2s — measured, never projected to 184',
  );
  const r3 = measureAttempt({
    protocolDef: proto,
    session: full,
    calibrationPassed: true,
    providerCapabilities: PROVIDERS.web_client.capabilities,
    mode: 'verified',
  });
  neg(r3.combineState === 'measurement_unavailable', 'unsupported provider → measurement_unavailable, no value');
  const r4 = measureAttempt({
    protocolDef: proto,
    session: { ...full, verificationState: 'unable_to_verify', verifiedReps: 0 },
    calibrationPassed: true,
    providerCapabilities: caps,
    mode: 'verified',
  });
  neg(r4.combineState === 'measurement_unavailable', 'no reliable observation → measurement_unavailable');
  const r5 = measureAttempt({
    protocolDef: proto,
    session: { ...full, verificationState: 'invalidated' },
    calibrationPassed: true,
    providerCapabilities: caps,
    mode: 'verified',
  });
  neg(r5.combineState === 'invalidated', 'invalidated session → invalidated combine result');
  const r6 = measureAttempt({
    protocolDef: proto,
    session: full,
    calibrationPassed: true,
    providerCapabilities: caps,
    mode: 'practice',
  });
  neg(r6.combineState !== 'combine_verified', 'practice attempt is never combine_verified');
  const dur = combineProtocol('combine-box-control-60', 1);
  const r7 = measureAttempt({
    protocolDef: dur,
    session: {
      verificationState: 'partially_verified',
      sessionDurationMs: WINDOW,
      verifiedActiveMs: 57_400,
      quality: 'good',
    },
    calibrationPassed: true,
    providerCapabilities: caps,
    mode: 'verified',
  });
  ok(
    r7.combineState === 'combine_verified' &&
      r7.measuredValue === 57.4 &&
      formatCombineValue(dur, r7.measuredValue) === '57.4',
    'duration metric → 57.4s verified, tenths precision',
  );
}

section('U3 — personal best + comparison (pure)');
{
  const attempts = [
    { measuredValue: 171, direction: 'higher', effectiveState: 'combine_verified' },
    { measuredValue: 184, direction: 'higher', effectiveState: 'combine_verified' },
    { measuredValue: 999, direction: 'higher', effectiveState: 'partially_measured' },
  ];
  ok(personalBest(attempts).measuredValue === 184, 'personal best ignores non-verified attempts');
  ok(
    personalBest([
      { measuredValue: 6.9, direction: 'lower', effectiveState: 'combine_verified' },
      { measuredValue: 6.8, direction: 'lower', effectiveState: 'combine_verified' },
    ]).measuredValue === 6.8,
    'lower-is-better direction respected',
  );
  const m = comparisonMatrix({
    players: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    protocols: [combineProtocol('combine-box-touch-60', 1)],
    bestByPlayerProtocol: new Map([['a::combine-box-touch-60@1', { measuredValue: 184, completedAt: 1 }]]),
  });
  neg(m.rows[1].cells[0] === null, 'missing comparison cell is null, never 0');
  ok(!('overall' in m) && !('rank' in m), 'comparison produces no overall ranking');
}

section('the result hash');
{
  // 30 result hash present and deterministic over inputs
  ok(
    combineResultHash({
      id: 'x',
      playerId: 'p',
      protocolId: 'combine-box-touch-60',
      protocolVersion: 1,
      boxSessionId: 's',
      metricType: 'count',
      measuredValue: 184,
      provider: 'local_test',
      providerVersion: 1,
      measurementAlgorithmVersion: 1,
      completedAt: 1,
      combineState: 'combine_verified',
    }).length === 64,
    '30: canonical combine result hash produced',
  );
}

done();
