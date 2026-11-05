/**
 * M23 P5.6C — the compliance domain error contract. ONE table, no default
 * branch, a public-field allowlist. A refusal never carries a hidden minor,
 * another agent's agreement, a club that was not already shared, a fee term
 * or a reviewer's private note (mandate §67).
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const M25_ERROR_HTTP = table({
  // ---- 400: fix the request.
  COMPLIANCE_INPUT_INVALID: 400,
  CONTEXT_INPUT_INVALID: 400,
  POLICY_INPUT_INVALID: 400,
  CONSENT_INPUT_INVALID: 400,
  REVIEW_INPUT_INVALID: 400,
  COMPLIANCE_CLIENT_KEY_INVALID: 400,

  // ---- 401: no attributable identity.
  REVIEWER_AUTH_REQUIRED: 401,
  REVIEWER_REVOKED: 401,
  REVIEWER_CREDENTIALS_INVALID: 401,

  // ---- 403: not yours to do (own state only).
  REVIEWER_ROLE_REQUIRED: 403,
  AGENT_LICENCE_INACTIVE: 403,
  AGENT_VERIFICATION_STALE: 403,
  AGENT_VERIFICATION_REQUIRED: 403,
  AGENT_NATIONAL_REGISTRATION_REQUIRED: 403,
  AGENT_DOMESTIC_AUTHORISATION_REQUIRED: 403,
  AGENT_MINOR_AUTHORISATION_REQUIRED: 403,
  REPRESENTATION_REQUIRED: 403,
  REPRESENTATION_EXPIRED: 403,
  REPRESENTATION_SCOPE_INSUFFICIENT: 403,
  REPRESENTATION_CONFLICT: 403,
  MINOR_APPROACH_NOT_PERMITTED: 403,
  SIGNATORY_REQUIRED: 403,
  POLICY_DUAL_CONTROL_REQUIRED: 403,
  COMPLIANCE_ACTION_NOT_PERMITTED: 403,

  // ---- 404: concealment.
  CONTEXT_NOT_FOUND: 404,
  REVIEW_NOT_FOUND: 404,
  CONSENT_NOT_FOUND: 404,
  PARTY_NOT_FOUND: 404,
  POLICY_NOT_FOUND: 404,
  REVIEWER_NOT_FOUND: 404,

  // ---- 409: the record is not where the caller thought.
  CONTEXT_CLOSED: 409,
  CONTEXT_VERSION_CONFLICT: 409,
  CONTEXT_IDEMPOTENCY_CONFLICT: 409,
  CONTEXT_PARTY_EXISTS: 409,
  REVIEW_NOT_PENDING: 409,
  REVIEW_VERSION_CONFLICT: 409,
  REVIEW_IDEMPOTENCY_CONFLICT: 409,
  REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE: 409,
  REVIEW_REQUIRES_POLICY_VERSION: 409,
  REVIEW_ALREADY_EXISTS: 409,
  CONSENT_NOT_PENDING: 409,
  CONSENT_VERSION_CONFLICT: 409,
  CONSENT_IDEMPOTENCY_CONFLICT: 409,
  CONSENT_ALREADY_REQUESTED: 409,
  POLICY_VERSION_EXISTS: 409,
  POLICY_NOT_PROPOSED: 409,
  REVIEWER_EXISTS: 409,
  REVIEWER_VERSION_CONFLICT: 409,
  LAST_REVIEWER_ADMIN: 409,

  // ---- 422: the policy needs a further act before the workflow proceeds.
  CONSENT_REQUIRED: 422,
  CONSENT_REVOKED: 422,
  GUARDIAN_CONSENT_REQUIRED: 422,
  REGULATORY_REVIEW_REQUIRED: 422,
  JURISDICTION_UNSUPPORTED: 422,
  COMPLIANCE_INSUFFICIENT_DATA: 422,

  // ---- 503: a required source is down; nothing is assumed.
  REGULATORY_PROVIDER_UNAVAILABLE: 503,
  POLICY_UNAVAILABLE: 503,

  // ---- 500: ours.
  COMPLIANCE_STATE_UNKNOWN: 500,
});

export const httpStatusFor = (code) => M25_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'allowed', 'facet', 'memberAssociation', 'state', 'code',
  'expectedRev', 'currentRev', 'updatedBy', 'updatedAt', 'retryAfter', 'status', 'agreementId', 'field',
  'required', 'reasons', 'policyVersions', 'consentsOutstanding', 'consentKind', 'reviewId', 'contextId', 'outcome', 'reason', 'role',
];

/** Reasons reach the wire as codes and rule references only — never prose, never a name. */
const publicReason = (r) => ({ code: r.code, ruleId: r.ruleId ?? null, ruleStatus: r.ruleStatus ?? null, regulator: r.regulator ?? null, jurisdiction: r.jurisdiction ?? null, policyVersion: r.policyVersion ?? null, ...(r.partyRoles ? { partyRoles: r.partyRoles } : {}), ...(r.partyRole ? { partyRole: r.partyRole } : {}) });

export function publicErrorBody(out) {
  const code = out?.error;
  if (M25_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The compliance service cannot serve this request. This has been recorded.' };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) {
    if (out?.[k] === undefined) continue;
    body[k] = k === 'reasons' && Array.isArray(out[k]) ? out[k].map(publicReason)
      : k === 'consentsOutstanding' && Array.isArray(out[k]) ? out[k].map((c) => ({ partyRole: c.partyRole, consentKind: c.consentKind, reasonCode: c.reasonCode }))
        : out[k];
  }
  return body;
}

export function sendComplianceError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`M25 ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'COMPLIANCE_STATE_UNKNOWN', message: 'The compliance service cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`M25 ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}
