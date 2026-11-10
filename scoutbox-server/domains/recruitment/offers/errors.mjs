/**
 * The Offer error table: no default branch, and only allowlisted fields reach the client.
 *
 * A missing Offer, one in another organisation, one addressed to another player, one a same-agency colleague
 * may not see, and a document not on a readable issued revision all get the same 404 body, so the refusal is
 * not an oracle. Once a caller can read an Offer, a refusal names only the state that stopped the action.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const OFFER_ERROR_HTTP = table({
  // ---- 400: fix the request.
  OFFER_INPUT_INVALID: 400,
  OFFER_TERMS_INVALID: 400,
  OFFER_EXPIRY_INVALID: 400,
  OFFER_DOCUMENT_INVALID: 400,
  OFFER_CLIENT_KEY_INVALID: 400,
  OFFER_REV_REQUIRED: 400,

  // ---- 403: about the caller's own standing only.
  OFFER_NOT_PERMITTED: 403,
  OFFER_BLOCKED: 403,

  // ---- 404: concealment; every one is the same body.
  OFFER_NOT_FOUND: 404,
  OFFER_DOCUMENT_NOT_FOUND: 404,

  // ---- 409: the Offer or the case is not where the caller thought.
  OFFER_STATE_INVALID: 409,
  OFFER_REV_CONFLICT: 409,
  OFFER_EXPIRED: 409,
  OFFER_SUPERSEDED: 409,
  OFFER_WITHDRAWN: 409,
  OFFER_ALREADY_RESPONDED: 409,
  OFFER_IDEMPOTENCY_CONFLICT: 409,
  OFFER_LIFECYCLE_CONFLICT: 409,
  OFFER_SUBJECT_REMOVED: 409,

  // ---- 422: well-formed, permitted, possible — and the world says no.
  OFFER_ISSUE_NOT_ALLOWED: 422,
  OFFER_RECIPIENT_INVALID: 422,
  OFFER_COMPLIANCE_BLOCKED: 422,

  // ---- 500: ours.
  OFFER_STATE_UNKNOWN: 500,
});

export const httpStatusFor = (code) => OFFER_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'field', 'allowed', 'expected', 'current', 'expectedRev', 'currentRev',
  'updatedBy', 'updatedAt', 'reasons', 'blockers', 'lifecycle', 'status',
];

export function publicErrorBody(out) {
  const code = out?.error;
  if (OFFER_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The Offer service cannot serve this request. This has been recorded.' };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) if (out?.[k] !== undefined) body[k] = out[k];
  return body;
}

export function sendOfferError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`offers ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'OFFER_STATE_UNKNOWN', message: 'The Offer service cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`offers ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}

export const notFound = (res, where) => sendOfferError(res, { error: 'OFFER_NOT_FOUND', message: 'No Offer with that reference is available to you.' }, where);
export const documentNotFound = (res, where) => sendOfferError(res, { error: 'OFFER_DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, where);
