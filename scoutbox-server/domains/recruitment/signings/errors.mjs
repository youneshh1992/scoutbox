/**
 * The Signing error table: no default branch, and only allowlisted fields reach the client.
 *
 * A missing package, one in another organisation, one addressed to another player, one an agent may not see,
 * and a document not on a readable revision all get the same 404 body. Once a caller can read a package, a
 * refusal names only the state that stopped the act.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const SIGNING_ERROR_HTTP = table({
  // ---- 400: fix the request.
  SIGNING_INPUT_INVALID: 400,
  SIGNING_CONTRACT_DATES_INVALID: 400,
  SIGNING_EXPIRY_INVALID: 400,
  SIGNING_DOCUMENT_INVALID: 400,
  SIGNING_CLIENT_KEY_INVALID: 400,
  SIGNING_REV_REQUIRED: 400,
  SIGNING_METHOD_UNKNOWN: 400,

  // ---- 403: about the caller's own standing only.
  SIGNING_NOT_PERMITTED: 403,
  SIGNING_BLOCKED: 403,
  SIGNING_AUTHORITY_LOST: 403,

  // ---- 404: concealment; every one is the same body.
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

export const httpStatusFor = (code) => SIGNING_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'field', 'allowed', 'expected', 'current', 'expectedRev', 'currentRev',
  'updatedBy', 'updatedAt', 'reasons', 'blockers', 'lifecycle', 'status', 'parties',
];

export function publicErrorBody(out) {
  const code = out?.error;
  if (SIGNING_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The Signing service cannot serve this request. This has been recorded.' };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) if (out?.[k] !== undefined) body[k] = out[k];
  return body;
}

export function sendSigningError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`signings ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'The Signing service cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`signings ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}

export const notFound = (res, where) => sendSigningError(res, { error: 'SIGNING_NOT_FOUND', message: 'No signing with that reference is available to you.' }, where);
export const documentNotFound = (res, where) => sendSigningError(res, { error: 'SIGNING_DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, where);
