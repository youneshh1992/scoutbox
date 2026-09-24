/**
 * M23 P6 — the Offer domain error contract. ONE table, no default branch, a
 * public-field allowlist (the M23 / P5.6D pattern, unchanged).
 *
 * The refusals this table keeps indistinguishable (§50, §51): an Offer that
 * does not exist, one in another organisation, one addressed to another
 * player, one a colleague at the same agency is not entitled to, and a
 * document that is not on an issued revision the caller may read all answer
 * `OFFER_NOT_FOUND` / `OFFER_DOCUMENT_NOT_FOUND` with the same body. A caller
 * who can tell those apart has an oracle.
 *
 * Once a caller can already READ an Offer, concealment has nothing left to
 * protect there: a refusal names the STATE that stopped the action
 * (expired, withdrawn, superseded, already answered) and nothing else — never
 * an internal note, a decision rationale, a transaction blocker's detail, a
 * reviewer, or the word "blocked" to a recipient.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const M28_ERROR_HTTP = table({
  // ---- 400: fix the request.
  OFFER_INPUT_INVALID: 400,
  OFFER_TERMS_INVALID: 400,
  OFFER_EXPIRY_INVALID: 400,
  OFFER_DOCUMENT_INVALID: 400,
  OFFER_CLIENT_KEY_INVALID: 400,
  OFFER_REV_REQUIRED: 400,

  // ---- 403: not yours to do. Only ever about the CALLER's own standing.
  OFFER_NOT_PERMITTED: 403,
  OFFER_BLOCKED: 403,

  // ---- 404: concealment. Every one of these is the same body.
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
  OFFER_STORE_MISSING: 500,
});

export const httpStatusFor = (code) => M28_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'field', 'allowed', 'expected', 'current', 'expectedRev', 'currentRev',
  'updatedBy', 'updatedAt', 'reasons', 'blockers', 'lifecycle', 'status',
];

export function publicErrorBody(out) {
  const code = out?.error;
  if (M28_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The Offer service cannot serve this request. This has been recorded.' };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) if (out?.[k] !== undefined) body[k] = out[k];
  return body;
}

export function sendOfferError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`M28 ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'OFFER_STATE_UNKNOWN', message: 'The Offer service cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`M28 ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}

/** The ONE concealment refusal. */
export const notFound = (res, where) => sendOfferError(res, { error: 'OFFER_NOT_FOUND', message: 'No Offer with that reference is available to you.' }, where);
export const documentNotFound = (res, where) => sendOfferError(res, { error: 'OFFER_DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, where);
