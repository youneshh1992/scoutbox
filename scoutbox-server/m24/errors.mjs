/**
 * M23 P5.6B — the Agent domain error contract. Same discipline as
 * m23/errors.mjs: ONE table, no default branch, a public-field allowlist.
 */

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

export const M24_ERROR_HTTP = table({
  // ---- 400: fix the request.
  AGENT_INPUT_INVALID: 400,
  AGENT_CLIENT_KEY_INVALID: 400,
  AGENT_TIERS_INVALID: 400,
  AGENT_FACET_INVALID: 400,
  AGENT_SCOPE_INVALID: 400,
  AGENT_TERM_INVALID: 400,
  AGENT_JURISDICTION_INVALID: 400,

  // ---- 403: not yours to do (own state; nothing about a subject).
  AGENT_ACTION_NOT_PERMITTED: 403,
  AGENCY_MEMBERSHIP_REQUIRED: 403,
  AGENT_PROFILE_REQUIRED: 403,
  AGENT_VERIFICATION_REQUIRED: 403,
  SELF_PROMOTION_BLOCKED: 403,

  // ---- 404: concealment. A player who does not exist, a minor, a blocked
  // player, a foreign agency's record and another agent's record all answer
  // alike.
  PLAYER_NOT_FOUND: 404,
  REPRESENTATION_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,

  // ---- 409: the record is not where the caller thought.
  REPRESENTATION_ALREADY_EXISTS: 409,
  REPRESENTATION_NOT_ACTIVE: 409,
  REPRESENTATION_CONFIRMATION_REQUIRED: 409,
  REPRESENTATION_DISPUTED: 409,
  REPRESENTATION_VERSION_CONFLICT: 409,
  REPRESENTATION_IDEMPOTENCY_CONFLICT: 409,
  AFFILIATION_VERSION_CONFLICT: 409,
  AFFILIATION_IDEMPOTENCY_CONFLICT: 409,
  LAST_ADMIN: 409,
  MEMBER_ALREADY_AFFILIATED: 409,

  // ---- 429: deterministic per-player request cooldown.
  REPRESENTATION_COOLDOWN: 429,

  // ---- 500: ours.
  AGENT_STORE_MISSING: 500,
  AGENT_STATE_UNKNOWN: 500,
});

export const httpStatusFor = (code) => M24_ERROR_HTTP[code] ?? null;

export const PUBLIC_ERROR_FIELDS = [
  'error', 'message', 'allowed', 'facet', 'memberAssociation', 'state',
  'expectedRev', 'currentRev', 'updatedBy', 'updatedAt', 'retryAt', 'status', 'agreementId', 'field',
];

export function publicErrorBody(out) {
  const code = out?.error;
  if (M24_ERROR_HTTP[code] === 500) {
    return { ok: false, error: code, message: 'The Agent workspace cannot serve this request. This has been recorded.' };
  }
  const body = { ok: false };
  for (const k of PUBLIC_ERROR_FIELDS) if (out?.[k] !== undefined) body[k] = out[k];
  return body;
}

export function sendAgentError(res, out, where) {
  const status = httpStatusFor(out?.error);
  if (status === null) {
    console.error(`M24 ${where} UNMAPPED_ERROR ${out?.error} — ${JSON.stringify(out)}`);
    return res.status(500).json({ ok: false, error: 'AGENT_STATE_UNKNOWN', message: 'The Agent workspace cannot serve this request. This has been recorded.' });
  }
  if (status === 500) console.error(`M24 ${where} ${out.error} — ${JSON.stringify(out)}`);
  return res.status(status).json(publicErrorBody(out));
}
