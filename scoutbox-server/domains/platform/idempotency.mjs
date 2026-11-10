/**
 * The idempotency rules every act with a `clientKey` shares: what counts as a key, and what makes a retry "the same
 * request". Each domain keeps its own error code.
 */

import { canonicalJson } from './values.mjs';

export const CLIENT_KEY_MAX = 64;

/** A client key is text, trimmed, 1–64 characters. Absent or '' is no key; anything else is refused, never coerced. */
export function normaliseClientKey(raw, error = 'CLIENT_KEY_INVALID') {
  if (raw === undefined || raw === null || raw === '') return { ok: true, key: null };
  if (typeof raw !== 'string') return { ok: false, error, message: 'clientKey must be text.' };
  const k = raw.trim();
  if (!k || k.length > CLIENT_KEY_MAX) return { ok: false, error, message: `clientKey must be 1–${CLIENT_KEY_MAX} characters.` };
  return { ok: true, key: k };
}

/**
 * A fingerprint of the parts of a request that make it "the same request". It is serialised deeply: a retry under the
 * same key with different nested terms (a different list of parties, say) is a different request.
 */
export const payloadFingerprint = (parts) => canonicalJson(parts);
