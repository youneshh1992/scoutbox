// Synthetic fixtures can pass while the claim "Combine Verified" is still false. So real-world validation is a
// versioned record naming what was validated, with which engine, against which dataset, and who released it. It is
// read from server-side release configuration only, never a client, request or provider payload.

import { CV_ENGINE_VERSION, BOX_CAM_CV_POLICY_VERSION, CANDIDATE_PROTOCOLS } from './policy.mjs';

export const VALIDATION_STATUSES = Object.freeze(['not_completed', 'in_progress', 'failed', 'passed']);

/** A record missing any of these is not a record. */
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
 * `not_completed` for every protocol: the engine has observed no real football video. A release edits this, and
 * `validateRecord()` rejects a record without a matching engine, policy and dataset.
 */
export const REAL_WORLD_VALIDATION = Object.freeze({
  'combine-box-touch-60': Object.freeze({ status: 'not_completed', record: null }),
  'combine-box-juggle': Object.freeze({ status: 'not_completed', record: null }),
  'combine-box-control-60': Object.freeze({ status: 'not_completed', record: null }),
});

/** A record validated against an older engine doesn't describe this one, so it doesn't transfer. */
export function validateRecord(
  protocolId,
  record,
  { engineVersion = CV_ENGINE_VERSION, policyVersion = BOX_CAM_CV_POLICY_VERSION, providerVersion = null } = {},
) {
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

export function realWorldValidationPass(
  protocolId,
  {
    table = REAL_WORLD_VALIDATION,
    engineVersion = CV_ENGINE_VERSION,
    policyVersion = BOX_CAM_CV_POLICY_VERSION,
    providerVersion = null,
  } = {},
) {
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

export function validationSummary({ table = REAL_WORLD_VALIDATION } = {}) {
  const out = {};
  for (const id of Object.keys(CANDIDATE_PROTOCOLS)) {
    const e = table[id] ?? { status: 'not_completed', record: null };
    out[id] = {
      status: e.status,
      datasetId: e.record?.datasetId ?? null,
      approvalVersion: e.record?.approvalVersion ?? null,
      note:
        e.status === 'passed'
          ? 'Validated against real capture material under a versioned release record.'
          : 'Not validated against real capture material. Exact production measurement is therefore not available for this protocol.',
    };
  }
  return out;
}
