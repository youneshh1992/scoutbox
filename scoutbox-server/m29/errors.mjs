/**
 * M23 P7 — the Signing domain error contract. ONE table, no default branch,
 * a public-field allowlist (the M23 / P5.6D / P6 pattern, unchanged).
 *
 * Concealment (§64, §82): a signing package that does not exist, one in
 * another organisation, one addressed to another player, one an agent is
 * not entitled to, and a document that is not on a revision the caller may
 * read all answer `SIGNING_NOT_FOUND` / `SIGNING_DOCUMENT_NOT_FOUND` with
 * the same body. Once a caller can already READ a package, a refusal names
 * the STATE that stopped the act and nothing else — never an internal note,
 * a party's identity the caller may not see, or the word "blocked" to a
 * recipient.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const M29_ERROR_HTTP = table({
  // ---- 400: fix the request.
  SIGNING_INPUT_INVALID: 400,
  SIGNING_CONTRACT_DATES_INVALID: 400,
  SIGNING_EXPIRY_INVALID: 400,
  SIGNING_DOCUMENT_INVALID: 400,
  SIGNING_CLIENT_KEY_INVALID: 400,
  SIGNING_REV_REQUIRED: 400,
  SIGNING_METHOD_UNKNOWN: 400,

  // ---- 403: not yours to do. Only ever about the CALLER's own standing.
  SIGNING_NOT_PERMITTED: 403,
  SIGNING_BLOCKED: 403,
  SIGNING_AUTHORITY_LOST: 403,

  // ---- 404: concealment. Every one of these is the same body.
  SIGNING_NOT_FOUND: 404,
  SIGNING_DOCUMENT_NOT_FOUND: 404,

  // ---- 409: the package, the Offer or the case is not where the caller thought.
  SIGNING_STATE_INVALID: 409,
  SIGNING_REV_CONFLICT: 409,
  SIGNING_NOT_READY: 409,
  SIGNING_ALREADY_COMPLETED: 409,
  SIGNING_EXPIRED: 409,
  SIGNING_CANCELLED: 409,
  SIGNING_VOIDED: 409,
  SIGNING_SUPERSEDED: 409,
  SIGNING_PARTY_NOT_REQUIRED: 409,
  SIGNING_PARTY_ALREADY_COMPLETED: 409,
  SIGNING_PARTIES_INCOMPLETE: 409,
  SIGNING_DOCUMENT_MISMATCH: 409,
  SIGNING_IDEMPOTENCY_CONFLICT: 409,
  SIGNING_LIFECYCLE_CONFLICT: 409,
  SIGNING_CONFLICT: 409,
  SIGNING_OFFER_NOT_ACCEPTED: 409,
  SIGNING_PACKAGE_EXISTS: 409,
  SIGNING_CANONICAL_REQUIRED: 409,
  SIGNING_SUBJECT_REMOVED: 409,

  // ---- 422: well-formed, permitted, possible — and the world says no.
  SIGNING_DOCUMENT_REQUIRED: 422,
  SIGNING_EVIDENCE_INVALID: 422,
  SIGNING_PATHWAY_CLOSED: 422,
  SIGNING_RECIPIENT_INVALID: 422,

  // ---- 500: ours.
  SIGNING_STATE_UNKNOWN: 500,
  SIGNING_STORE_MISSING: 500,
});

export const httpStatusFor = (code) => M29_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'field', 'allowed', 'expected', 'current', 'expectedRev', 'currentRev',
  'updatedBy', 'updatedAt', 'reasons', 'blockers', 'lifecycle', 'status', 'parties',
];

export function publicErrorBody(out) {
  const code = out?.error;
  if (M29_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The Signing service cannot serve this request. This has been recorded.' };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) if (out?.[k] !== undefined) body[k] = out[k];
  return body;
}

export function sendSigningError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`M29 ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'The Signing service cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`M29 ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}

/** The ONE concealment refusal. */
export const notFound = (res, where) => sendSigningError(res, { error: 'SIGNING_NOT_FOUND', message: 'No signing with that reference is available to you.' }, where);
export const documentNotFound = (res, where) => sendSigningError(res, { error: 'SIGNING_DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, where);
