/**
 * M23 P5.6D — the transaction domain error contract. ONE table, no default
 * branch, a public-field allowlist.
 *
 * The refusals this table exists to keep indistinguishable (§78, adversarial
 * 4–6, 23): a transaction that does not exist, one belonging to another agency,
 * one belonging to another club, and one belonging to another player all answer
 * `TRANSACTION_NOT_FOUND` with the same body. Naming a party who does not
 * exist, who is a minor, who is invisible to the caller's organisation or who
 * has blocked it all answer `TRANSACTION_PARTY_NOT_FOUND` with the same body. A
 * caller who can tell those apart has an oracle.
 *
 * Once a caller can already READ a transaction, concealment has nothing left to
 * protect there, and a 404 on a record they are looking at would be a lie. A
 * party who becomes unavailable AFTER the fact therefore stops the writes with
 * `TRANSACTION_PARTY_UNAVAILABLE` — one code for removed, invisible, blocked
 * and minor alike, so it still distinguishes nothing.
 *
 * A refusal never carries: a document's content, a note's text, a fee term, a
 * counterparty's name, another agency's agent, a reviewer's reason, a player's
 * date of birth, or the word "blocked".
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const M26_ERROR_HTTP = table({
  // ---- 400: fix the request.
  TRANSACTION_INPUT_INVALID: 400,
  TRANSACTION_CLIENT_KEY_INVALID: 400,
  DOCUMENT_INPUT_INVALID: 400,
  NOTE_INPUT_INVALID: 400,
  TERMS_INPUT_INVALID: 400,

  // ---- 403: not yours to do. Only ever about the CALLER's own state.
  TRANSACTION_ACTION_NOT_PERMITTED: 403,
  TRANSACTION_PARTY_CONFIRMATION_NOT_PERMITTED: 403,
  DOCUMENT_VISIBILITY_NOT_PERMITTED: 403,
  SIGNATORY_REQUIRED: 403,
  AGENT_VERIFICATION_REQUIRED: 403,
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
  // M23 P5.6E §37. The request is fine; a live transaction already covers this
  // individual, this type and these clubs. 409, because there is nothing in the
  // request to fix — the caller continues in the one that exists, or ends it.
  TRANSACTION_DUPLICATE_CONTEXT: 409,
  // M23 P5.6E §32/§36. A transaction that cites a recruitment case must be
  // answering that club's own invitation. These four are 409: the citation is
  // well-formed and the caller is permitted, but the invitation is not there,
  // not open, not about this client, or not addressed to this agency.
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
  // A party to an EXISTING transaction is no longer available to the caller's
  // organisation. Uniform across "removed", "no longer visible", "blocked" and
  // "now a minor", so it is not an oracle — and honest, unlike a 404 on a record
  // the caller can still read. (Naming a party on CREATE stays the uniform
  // TRANSACTION_PARTY_NOT_FOUND, because there the caller IS probing.)
  TRANSACTION_PARTY_UNAVAILABLE: 422,
  CONSENT_REQUIRED: 422,
  REGULATORY_REVIEW_REQUIRED: 422,
  JURISDICTION_UNSUPPORTED: 422,

  // ---- 503: a required source is down; nothing is assumed.
  REGULATORY_PROVIDER_UNAVAILABLE: 503,

  // ---- 500: ours.
  TRANSACTION_STATE_UNKNOWN: 500,
});

export const httpStatusFor = (code) => M26_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'field', 'allowed', 'status', 'from', 'to', 'expectedRev', 'currentRev',
  'updatedBy', 'updatedAt', 'retryAfter', 'partyRole', 'awaiting', 'pendingReason', 'reasons',
  'policyVersions', 'consentsOutstanding', 'staleness', 'visibility', 'documentType', 'contextId', 'outcome',
];

/** Reasons reach the wire as codes and rule references only. */
const publicReason = (r) => ({ code: r.code, ruleId: r.ruleId ?? null, ruleStatus: r.ruleStatus ?? null, policyVersion: r.policyVersion ?? null, ...(r.partyRole ? { partyRole: r.partyRole } : {}), ...(r.partyRoles ? { partyRoles: r.partyRoles } : {}) });

export function publicErrorBody(out) {
  const code = out?.error;
  if (M26_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The transaction service cannot serve this request. This has been recorded.' };
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

export function sendTransactionError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`M26 ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'TRANSACTION_STATE_UNKNOWN', message: 'The transaction service cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`M26 ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}

/** The ONE concealment refusal. Used for every "you may not know whether this exists" answer. */
export const notFound = (res, where) => sendTransactionError(res, { error: 'TRANSACTION_NOT_FOUND', message: 'No transaction with that reference is available to you.' }, where);
