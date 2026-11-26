/**
 * Transaction error codes and the public-field allowlist.
 *
 * A missing transaction and another tenant's answer the same `TRANSACTION_NOT_FOUND`; a missing, minor, invisible or
 * blocking party the same `TRANSACTION_PARTY_NOT_FOUND`. A refusal never says "blocked".
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const TRANSACTION_ERROR_HTTP = table({
  // ---- 400: fix the request.
  TRANSACTION_INPUT_INVALID: 400,
  TRANSACTION_CLIENT_KEY_INVALID: 400,
  // A malformed expectedRev, as platform/concurrency.mjs guardRev refuses it.
  EXPECTED_REV_INVALID: 400,
  DOCUMENT_INPUT_INVALID: 400,
  NOTE_INPUT_INVALID: 400,
  TERMS_INPUT_INVALID: 400,

  // ---- 403: not yours to do. Only ever about the caller's own state.
  TRANSACTION_ACTION_NOT_PERMITTED: 403,
  TRANSACTION_PARTY_CONFIRMATION_NOT_PERMITTED: 403,
  DOCUMENT_VISIBILITY_NOT_PERMITTED: 403,
  SIGNATORY_REQUIRED: 403,
  AGENT_VERIFICATION_REQUIRED: 403,
  // `compliance.facetGateProblem` can answer with any of these; undeclared, a lapsed licence would surface as a 500.
  AGENT_LICENCE_INACTIVE: 403,
  AGENT_VERIFICATION_STALE: 403,
  AGENT_NATIONAL_REGISTRATION_REQUIRED: 403,
  AGENT_DOMESTIC_AUTHORISATION_REQUIRED: 403,
  AGENT_MINOR_AUTHORISATION_REQUIRED: 403,
  REPRESENTATION_REQUIRED: 403,
  REPRESENTATION_SCOPE_INSUFFICIENT: 403,
  REPRESENTATION_CONFLICT: 403,

  // ---- 404: concealment. Every one of these is the same body.
  TRANSACTION_NOT_FOUND: 404,
  TRANSACTION_PARTY_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  NOTE_NOT_FOUND: 404,
  MESSAGE_THREAD_NOT_FOUND: 404,

  // ---- 409: the record is not where the caller thought it was.
  TRANSACTION_VERSION_CONFLICT: 409,
  TRANSACTION_IDEMPOTENCY_CONFLICT: 409,
  // Nothing in the request to fix: the caller continues in the live transaction, or ends it.
  TRANSACTION_DUPLICATE_CONTEXT: 409,
  // The citation is well-formed, but the case's invitation is missing, closed, about another client or addressed
  // to another agency.
  HANDOFF_NOT_FOUND: 409,
  HANDOFF_NOT_OPEN: 409,
  HANDOFF_SUBJECT_MISMATCH: 409,
  HANDOFF_NOT_ADDRESSED: 409,
  TRANSACTION_PARTY_EXISTS: 409,
  TRANSACTION_TRANSITION_NOT_ALLOWED: 409,
  TRANSACTION_NOT_LIVE: 409,
  TRANSACTION_ARCHIVED: 409,
  TRANSACTION_ALREADY_CONFIRMED: 409,
  DOCUMENT_SUPERSEDED: 409,
  DOCUMENT_VERSION_CONFLICT: 409,

  // ---- 422: the policy or the workflow needs a further act first.
  TRANSACTION_PARTIES_NOT_CONFIRMED: 422,
  TRANSACTION_COMPLIANCE_PENDING: 422,
  TRANSACTION_COMPLIANCE_BLOCKED: 422,
  TRANSACTION_COMPLIANCE_STALE: 422,
  // A party to a transaction the caller can already read: one code for removed, invisible, blocked and minor, since
  // a 404 on a visible record would be a lie. Naming a party on create stays TRANSACTION_PARTY_NOT_FOUND.
  TRANSACTION_PARTY_UNAVAILABLE: 422,
  CONSENT_REQUIRED: 422,
  REGULATORY_REVIEW_REQUIRED: 422,
  JURISDICTION_UNSUPPORTED: 422,

  // ---- 503: a required source is down; nothing is assumed.
  REGULATORY_PROVIDER_UNAVAILABLE: 503,

  // ---- 500: ours.
  TRANSACTION_STATE_UNKNOWN: 500,
});

export const httpStatusFor = (code) => TRANSACTION_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error',
  'message',
  'field',
  'problem',
  'min',
  'max',
  'expected',
  'allowed',
  'status',
  'from',
  'to',
  'expectedRev',
  'currentRev',
  'updatedBy',
  'updatedAt',
  'retryAfter',
  'partyRole',
  'awaiting',
  'pendingReason',
  'reasons',
  'policyVersions',
  'consentsOutstanding',
  'staleness',
  'visibility',
  'documentType',
  'contextId',
  'outcome',
];

/** Reasons reach the wire as codes and rule references only. */
const publicReason = (r) => ({
  code: r.code,
  ruleId: r.ruleId ?? null,
  ruleStatus: r.ruleStatus ?? null,
  policyVersion: r.policyVersion ?? null,
  ...(r.partyRole ? { partyRole: r.partyRole } : {}),
  ...(r.partyRoles ? { partyRoles: r.partyRoles } : {}),
});

export function publicErrorBody(out) {
  const code = out?.error;
  if (TRANSACTION_ERROR_HTTP[code] === 500) {
    return {
      ok: false,
      error: code,
      message: 'The transaction service cannot serve this request. This has been recorded.',
    };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) {
    if (out?.[k] === undefined) continue;
    body[k] =
      k === 'reasons' && Array.isArray(out[k])
        ? out[k].map(publicReason)
        : k === 'consentsOutstanding' && Array.isArray(out[k])
          ? out[k].map((c) => ({ partyRole: c.partyRole, consentKind: c.consentKind, reasonCode: c.reasonCode }))
          : out[k];
  }
  return body;
}

export function sendTransactionError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`transactions ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({
      ok: false,
      error: 'TRANSACTION_STATE_UNKNOWN',
      message: 'The transaction service cannot serve this request. This has been recorded.',
    });
  }
  if (status === 500) console.error(`transactions ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}

/** Every "you may not know whether this exists" answer. */
export const notFound = (res, where) =>
  sendTransactionError(
    res,
    { error: 'TRANSACTION_NOT_FOUND', message: 'No transaction with that reference is available to you.' },
    where,
  );
