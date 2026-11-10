// May a Combine attempt on this protocol, observed by this provider, become "Combine Verified"? Separate from the
// provider, which observes. The gate reads measured evaluation output; it may not contain `passed = true`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_PROTOCOLS, CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION } from './policy.mjs';
import { realWorldValidationPass, validationSummary } from './validation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL_PATH = path.join(HERE, 'evaluation.json');

/** Fixed before the evaluation was run, not softened after. The last one decides enablement and is not a number. */
export const ACCEPTANCE_CRITERIA = Object.freeze({
  maxFalseVerifications: 0,          // any is a P0.
  maxNondeterministic: 0,            // the same fixture must answer the same way.
  maxMeanAbsCountError: 1.0,         // on fixtures that should be accepted.
  maxAbsCountError: 2,               // no single fixture may be wilder than this.
  minCorrectVerdictRate: 1.0,        // every fixture must land on its declared truth.
  // A counting claim about real football needs evidence from real football.
  requiresRealWorldValidation: true,
});

/** The measured evaluation artefact, or a report that there is none. */
export function readEvaluation({ evalPath = EVAL_PATH } = {}) {
  try {
    const raw = fs.readFileSync(evalPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { present: true, report: parsed };
  } catch {
    return { present: false, report: null };
  }
}

/** Every reason the gate is closed, not just the first. */
export function evaluateGate(report) {
  const failures = [];
  if (!report) return { open: false, failures: ['no measured evaluation artefact exists'] };

  if (report.engineVersion !== CV_ENGINE_VERSION) {
    failures.push(`evaluation was produced by engine v${report.engineVersion}, this build is v${CV_ENGINE_VERSION}`);
  }
  if (report.policyVersion !== BOX_CAM_CV_POLICY_VERSION) {
    failures.push(`evaluation was produced under policy v${report.policyVersion}, this build is v${BOX_CAM_CV_POLICY_VERSION}`);
  }
  if ((report.falseVerifications ?? Infinity) > ACCEPTANCE_CRITERIA.maxFalseVerifications) {
    failures.push(`${report.falseVerifications} false verification(s) in the adversarial fixture set`);
  }
  if ((report.nondeterministic ?? Infinity) > ACCEPTANCE_CRITERIA.maxNondeterministic) {
    failures.push(`${report.nondeterministic} fixture(s) produced nondeterministic output`);
  }
  if (report.meanAbsCountError == null || report.meanAbsCountError > ACCEPTANCE_CRITERIA.maxMeanAbsCountError) {
    failures.push(`mean absolute count error ${report.meanAbsCountError ?? 'n/a'} exceeds ${ACCEPTANCE_CRITERIA.maxMeanAbsCountError}`);
  }
  if (report.maxAbsCountError == null || report.maxAbsCountError > ACCEPTANCE_CRITERIA.maxAbsCountError) {
    failures.push(`worst-case count error ${report.maxAbsCountError ?? 'n/a'} exceeds ${ACCEPTANCE_CRITERIA.maxAbsCountError}`);
  }
  const rate = report.fixtureCount ? (report.correct ?? 0) / report.fixtureCount : 0;
  if (rate < ACCEPTANCE_CRITERIA.minCorrectVerdictRate) {
    failures.push(`correct-verdict rate ${(rate * 100).toFixed(1)}% is below ${(ACCEPTANCE_CRITERIA.minCorrectVerdictRate * 100).toFixed(0)}%`);
  }
  // Real-world validation isn't checked here, so a synthetic artefact can't assert its own real-world validity. It is
  // checked in `protocolProductionEnabled()` against validation.mjs.
  return { open: failures.length === 0, failures };
}

/** Every clause must hold, and each failing one is named. */
export function protocolProductionEnabled(protocolId, {
  providerConfigured = false,
  providerHealth = 'not_configured',
  providerCapabilities = [],
  environmentAllows = true,
  evaluation = null,
  providerVersion = null,
} = {}) {
  const reasons = [];
  const candidate = CANDIDATE_PROTOCOLS[protocolId] ?? null;

  if (!candidate) {
    reasons.push('this protocol has no computer-vision observation rule');
  }
  if (!providerConfigured) {
    reasons.push('the production observation provider is not configured');
  }
  if (providerHealth !== 'ready') {
    reasons.push(`the provider is "${providerHealth}", not "ready"`);
  }
  if (candidate) {
    const missing = candidate.requires.filter((c) => !providerCapabilities.includes(c));
    if (missing.length) reasons.push(`provider is missing required capabilities: ${missing.join(', ')}`);
  }
  if (!environmentAllows) {
    reasons.push('this environment does not permit production observation');
  }

  const evalRes = evaluateGate(evaluation);
  if (!evalRes.open) reasons.push(...evalRes.failures);

  // The hard blocker, applied last: everything above can pass without evidence that the engine counts real football.
  const rw = realWorldValidationPass(protocolId, {
    engineVersion: CV_ENGINE_VERSION,
    policyVersion: BOX_CAM_CV_POLICY_VERSION,
    providerVersion,
  });
  if (!rw.pass) {
    reasons.push(
      `real-world validation is "${rw.status}" for this protocol — synthetic evaluation alone cannot authorise production measurement`,
      ...rw.problems.filter((p) => !p.startsWith('real-world validation for this protocol is')),
    );
  }

  return {
    enabled: reasons.length === 0,
    reasons,
    realWorldValidation: { status: rw.status, pass: rw.pass },
  };
}

export function productionMatrix(opts = {}) {
  const out = {};
  for (const id of Object.keys(CANDIDATE_PROTOCOLS)) {
    const r = protocolProductionEnabled(id, opts);
    out[id] = {
      eventKind: CANDIDATE_PROTOCOLS[id].eventKind,
      enabled: r.enabled,
      state: r.enabled ? 'verified_capable' : 'not_verified_capable',
      reasons: r.reasons,
      realWorldValidation: r.realWorldValidation ?? null,
    };
  }
  return out;
}

export { validationSummary };
