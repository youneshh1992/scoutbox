// M22 — the production enablement gate (§129, §130, §63).
//
// This module answers exactly one question, for one protocol at a time:
//
//     may a Combine attempt on this protocol, observed by this provider,
//     honestly become "Combine Verified" in production?
//
// It is a separate file from the provider on purpose. The provider's job is
// to observe; the gate's job is to refuse to let observation become a claim
// until the evidence for that claim exists. Merging them is how a milestone
// ends up shipping a badge it cannot justify.
//
// §130 is the rule that shapes everything here: the gate must read MEASURED
// evaluation output. It may not contain `passed = true`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_PROTOCOLS, CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION } from './policy.mjs';
import { realWorldValidationPass, validationSummary } from './validation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL_PATH = path.join(HERE, 'evaluation.json');

/**
 * The acceptance criteria (§63), fixed BEFORE the evaluation was run and
 * deliberately not softened after seeing it.
 *
 * Note the last one. It is the criterion that actually decides this
 * milestone, and it is not a number.
 */
export const ACCEPTANCE_CRITERIA = Object.freeze({
  maxFalseVerifications: 0,          // §61: any is a P0.
  maxNondeterministic: 0,            // the same fixture must answer the same way.
  maxMeanAbsCountError: 1.0,         // on fixtures that should be accepted.
  maxAbsCountError: 2,               // no single fixture may be wilder than this.
  minCorrectVerdictRate: 1.0,        // every fixture must land on its declared truth.
  // §63 again, and the honest one: a counting claim about real football
  // requires evidence from real football. Synthetic geometry can prove the
  // engine is deterministic and that it refuses what it promises to refuse.
  // It cannot show that a touch in a living room is a touch to this engine.
  requiresRealWorldValidation: true,
});

/** Read the measured evaluation artefact, or report honestly that there is none. */
export function readEvaluation({ evalPath = EVAL_PATH } = {}) {
  try {
    const raw = fs.readFileSync(evalPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { present: true, report: parsed };
  } catch {
    return { present: false, report: null };
  }
}

/**
 * Evaluate the criteria against a measured report.
 *
 * Returns every reason the gate is closed, not just the first, because a
 * reader deciding whether to invest in closing it needs the whole list.
 */
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
  // NOTE: the real-world validation criterion is deliberately NOT checked
  // here. A synthetic evaluation artefact must never be able to assert its
  // own real-world validity — that is exactly the bypass §38 exists to
  // prevent. It is checked in `protocolProductionEnabled()` against the
  // server-side versioned record in validation.mjs, which no evaluation
  // run, client or request can write.
  return { open: failures.length === 0, failures };
}

/**
 * §129 — may this protocol be production-verified here?
 *
 * Conjunctive by construction. Every clause must hold, and each one that
 * does not is named, so a "no" is always explicable.
 */
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
    reasons.push('this protocol has no M22 observation rule');
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

  // §38/§39 — THE HARD BLOCKER, applied last and independently.
  //
  // Everything above can be perfect: provider healthy, every capability
  // present, every synthetic fixture passing, zero false verifications. None
  // of it is evidence that this engine counts real football correctly, and
  // production verification requires that evidence.
  //
  // The record is read from server-side release configuration. It cannot be
  // set by a client, a request body, a provider payload, or an environment
  // variable alone (§40, §41).
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

/** A whole-matrix view for `/capabilities` and the documentation (§49, §68). */
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
