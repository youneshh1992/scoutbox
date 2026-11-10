/**
 * The regulatory verification provider. There is no live FIFA, FA or U.S. Soccer register integration: the
 * production provider is `none` (every answer goes to attributed review), and the synthetic one is a test double that
 * verifies only its own tagged references and names itself in every provenance record.
 *
 * UNAVAILABLE never permits anything: the route answers 503 and writes nothing.
 */

import { RECHECK_MS } from '../core/shared.mjs';

export const PROVIDER_STATES = Object.freeze(['VERIFIED', 'NOT_VERIFIED', 'INACTIVE', 'STALE', 'UNAVAILABLE', 'MANUAL_REVIEW_REQUIRED']);
export const PROVIDER_METHODS = Object.freeze(['verifyFifaLicence', 'verifyNationalRegistration', 'verifyDomesticAuthorisation', 'verifyMinorAuthorisation']);
export const FACET_METHOD = Object.freeze({
  fifa_licence: 'verifyFifaLicence', national_registration: 'verifyNationalRegistration',
  domestic_authorisation: 'verifyDomesticAuthorisation', minors_authorisation: 'verifyMinorAuthorisation',
});

const SYNTHETIC_ID = 'local-synthetic-test-provider';

const manual = (facet, now) => ({
  state: 'MANUAL_REVIEW_REQUIRED', verifiedAt: null, recheckAt: null,
  provenance: { provider: 'none', kind: 'none', at: now },
  note: `No ${facet === 'fifa_licence' ? 'FIFA' : 'national'} register integration exists in this build. A submitted reference is a declaration, not a verification; it has been queued for attributed Trust & Safety review (G-C0).`,
});

function syntheticAnswer(facet, reference, now) {
  const ref = String(reference ?? '').trim();
  const prov = { provider: SYNTHETIC_ID, kind: 'synthetic', at: now };
  const base = 'This is not a FIFA, FA or U.S. Soccer register check and never exists in production.';
  if (/^TEST-VERIFIED-/i.test(ref)) return { state: 'VERIFIED', verifiedAt: now, recheckAt: now + RECHECK_MS, provenance: prov, note: `Verified by the LOCAL SYNTHETIC test provider. ${base}` };
  if (/^TEST-INACTIVE-/i.test(ref)) return { state: 'INACTIVE', verifiedAt: null, recheckAt: null, provenance: prov, note: `Reported inactive by the LOCAL SYNTHETIC test provider. ${base}` };
  if (/^TEST-STALE-/i.test(ref)) return { state: 'STALE', verifiedAt: now - RECHECK_MS - 1, recheckAt: now - 1, provenance: prov, note: `Verified in the past by the LOCAL SYNTHETIC test provider; its recheck window has lapsed. ${base}` };
  if (/^TEST-UNAVAILABLE-/i.test(ref)) return { state: 'UNAVAILABLE', verifiedAt: null, recheckAt: null, provenance: prov, note: 'The LOCAL SYNTHETIC test provider simulated an outage.' };
  if (/^TEST-NOTVERIFIED-/i.test(ref)) return { state: 'NOT_VERIFIED', verifiedAt: null, recheckAt: null, provenance: prov, note: `No matching record at the LOCAL SYNTHETIC test provider. ${base}` };
  return manual(facet, now);
}

/** `synthetic: true` only when AGENT_VERIFICATION_TEST_PROVIDER=1. */
export function createVerificationProvider({ synthetic = false } = {}) {
  const answer = (facet) => ({ reference, now = Date.now() }) => (synthetic ? syntheticAnswer(facet, reference, now) : manual(facet, now));
  return Object.freeze({
    id: synthetic ? SYNTHETIC_ID : 'none',
    synthetic,
    verifyFifaLicence: answer('fifa_licence'),
    verifyNationalRegistration: answer('national_registration'),
    verifyDomesticAuthorisation: answer('domestic_authorisation'),
    verifyMinorAuthorisation: answer('minors_authorisation'),
    status: () => ({
      provider: synthetic ? SYNTHETIC_ID : 'none',
      live: false,
      registers: { fifa: 'not_connected', fa: 'not_connected', ussf: 'not_connected' },
      note: synthetic
        ? 'LOCAL SYNTHETIC test provider active. Verifies only TEST-* references. Never exists in production.'
        : 'No governing-body register is connected. Submissions are queued for attributed Trust & Safety review; a cached VERIFIED facet is usable only until its own recheck date.',
    }),
  });
}

/** UNAVAILABLE stores nothing; the caller refuses. */
export function facetFromProviderAnswer(answer, { reference, memberAssociation, now }) {
  if (!answer || answer.state === 'UNAVAILABLE') return null;
  const state = answer.state === 'STALE' ? 'VERIFIED' : answer.state === 'NOT_VERIFIED' ? 'UNVERIFIED' : answer.state;
  return {
    state, reference, memberAssociation: memberAssociation ?? null,
    provenance: answer.provenance ?? null, submittedAt: now,
    verifiedAt: answer.verifiedAt ?? null, recheckAt: answer.recheckAt ?? null, note: answer.note ?? null,
  };
}
