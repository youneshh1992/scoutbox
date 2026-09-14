// M22 — the real-world validation record (§38–§42).
//
// This is the hard blocker, and it is deliberately the most boring file in
// the milestone.
//
// The failure mode it exists to prevent is specific and very easy to fall
// into: synthetic fixtures all pass, the numbers look excellent, someone
// wires `productionEligible` to those numbers, and ScoutBox starts printing
// "Combine Verified" on the strength of geometry it rendered itself. The
// evaluation would be honest, the gate would be honest, and the CLAIM would
// still be false.
//
// So real-world validation is not a boolean and not an environment variable
// (§41). It is a VERSIONED RECORD that must name what was validated, with
// which engine, against which dataset, and who released it. A future
// milestone enables production by supplying such a record. Nothing else can.
//
// §40: this can never come from a client, a request body, or a provider
// session payload. It is read from server-side release configuration only.

import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION, CANDIDATE_PROTOCOLS } from './policy.mjs';

export const VALIDATION_STATUSES = Object.freeze(['not_completed', 'in_progress', 'failed', 'passed']);

/**
 * The fields a record MUST carry to be considered at all (§41).
 * A record missing any of these is not a weak record — it is not a record.
 */
export const REQUIRED_RECORD_FIELDS = Object.freeze([
  'protocolId',
  'cvPolicyVersion',
  'providerVersion',
  'engineVersion',
  'datasetId',
  'datasetVersion',
  'result',
  'approvalVersion',
  'approvedAt',
]);

/**
 * The current record for this build.
 *
 * It is `not_completed` for every protocol, and that is the true state of
 * the world: no real football video has been observed by this engine,
 * because none exists in this environment and M22 is forbidden from
 * collecting any.
 *
 * This constant is the single place a future milestone edits — and editing
 * it alone is not enough, because `validateRecord()` below rejects a record
 * that does not name a matching engine, policy and dataset.
 */
export const REAL_WORLD_VALIDATION = Object.freeze({
  'combine-box-touch-60': Object.freeze({ status: 'not_completed', record: null }),
  'combine-box-juggle': Object.freeze({ status: 'not_completed', record: null }),
  'combine-box-control-60': Object.freeze({ status: 'not_completed', record: null }),
});

/**
 * Is this record real, current, and a pass?
 *
 * Every clause is a way a plausible-looking record can still fail to justify
 * a production claim. A record validated against an older engine does not
 * describe THIS engine's behaviour, so it does not transfer.
 */
export function validateRecord(protocolId, record, {
  engineVersion = CV_ENGINE_VERSION,
  policyVersion = BOX_CAM_CV_POLICY_VERSION,
  providerVersion = null,
} = {}) {
  const problems = [];
  if (!record || typeof record !== 'object') {
    return { valid: false, problems: ['no validation record exists for this protocol'] };
  }
  for (const f of REQUIRED_RECORD_FIELDS) {
    if (record[f] === undefined || record[f] === null || record[f] === '') {
      problems.push(`validation record is missing "${f}"`);
    }
  }
  if (record.protocolId !== protocolId) {
    problems.push(`validation record is for "${record.protocolId}", not "${protocolId}"`);
  }
  if (record.engineVersion !== engineVersion) {
    problems.push(`validation record covers engine v${record.engineVersion}, this build runs v${engineVersion}`);
  }
  if (record.cvPolicyVersion !== policyVersion) {
    problems.push(`validation record covers CV policy v${record.cvPolicyVersion}, this build runs v${policyVersion}`);
  }
  if (providerVersion != null && record.providerVersion !== providerVersion) {
    problems.push(`validation record covers provider v${record.providerVersion}, this build runs v${providerVersion}`);
  }
  if (record.result !== 'passed') {
    problems.push(`validation result is "${record.result}", not "passed"`);
  }
  return { valid: problems.length === 0, problems };
}

/**
 * The question the gate asks.
 *
 * Note what is NOT a parameter: nothing from a request, nothing from a
 * client, nothing from an environment variable on its own.
 */
export function realWorldValidationPass(protocolId, {
  table = REAL_WORLD_VALIDATION,
  engineVersion = CV_ENGINE_VERSION,
  policyVersion = BOX_CAM_CV_POLICY_VERSION,
  providerVersion = null,
} = {}) {
  const entry = table[protocolId] ?? null;
  if (!entry) {
    return { pass: false, status: 'not_completed', problems: [`no validation entry for "${protocolId}"`] };
  }
  if (entry.status !== 'passed') {
    return {
      pass: false,
      status: entry.status,
      problems: [`real-world validation for this protocol is "${entry.status}"`],
    };
  }
  const check = validateRecord(protocolId, entry.record, { engineVersion, policyVersion, providerVersion });
  return { pass: check.valid, status: entry.status, problems: check.problems };
}

/** Reporting view for `/capabilities` and the docs (§42). */
export function validationSummary({ table = REAL_WORLD_VALIDATION } = {}) {
  const out = {};
  for (const id of Object.keys(CANDIDATE_PROTOCOLS)) {
    const e = table[id] ?? { status: 'not_completed', record: null };
    out[id] = {
      status: e.status,
      datasetId: e.record?.datasetId ?? null,
      approvalVersion: e.record?.approvalVersion ?? null,
      note: e.status === 'passed'
        ? 'Validated against real capture material under a versioned release record.'
        : 'Not validated against real capture material. Exact production measurement is therefore not available for this protocol.',
    };
  }
  return out;
}
