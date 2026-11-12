// Verification: independent claims and their review, organisation and staff verification, the club checks, coach
// references, and transition cases.
import { needs, strictContext } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerVerificationClaims } from './claims/index.mjs';
import { registerClubChecks } from './clubChecks.mjs';
import { registerTransitions } from './transitions.mjs';
import { createVouchReads } from './vouches.mjs';

/** A player's coach references: `publishedVouchesFor` and `vouchesFor`. No routes. */
export function createVouches(deps) {
  const { verificationReads } = needs('createVouches', deps, ['verificationReads']);
  return createVouchReads({ vouches: verificationReads.vouches });
}

/**
 * The club checks, transition cases and verification claims. Returns the minute `transitionSweep` and
 * `verificationSweep`, the console's
 * `syncLegacyOrgVerification`, and `storeEvidenceFile` / `addEvidence`, through which a signing attaches its documents
 * as claim evidence.
 */
export function createVerification(deps) {
  needs('createVerification', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'users',
    'orgs',
    'players',
    'codes',
    'clubSetup',
    'verification',
    'transitionsVouches',
    'development',
    'scoutingReads',
    'byId',
    'findPlayer',
    'isBlocked',
    'rateLimit',
    'storage',
    'mailer',
    'unit',
    'seam',
    'nextId',
    'notify',
    'broadcast',
    'ledgerAppend',
    'notifyAction',
    'emitWebhook',
  ]);
  const d = strictContext('createVerification', deps);
  registerClubChecks({
    orgRouter: d.orgRouter,
    orgs: d.orgs,
    codes: d.codes,
    clubSetup: d.clubSetup,
    mailer: d.mailer,
    rateLimit: d.rateLimit,
    unit: d.unit,
    seam: d.seam,
    broadcast: d.broadcast,
  });
  const ctx = routeContext('createVerification', deps);
  const { transitionSweep } = registerTransitions(ctx);
  const claims = registerVerificationClaims(ctx);
  return {
    transitionSweep,
    verificationSweep: () => claims.verificationSweep?.(),
    syncLegacyOrgVerification: claims.syncLegacyOrgVerification,
    storeEvidenceFile: claims.storeEvidenceFile,
    addEvidence: claims.addEvidence,
  };
}
