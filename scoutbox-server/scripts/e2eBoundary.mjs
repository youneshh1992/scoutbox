// The batteries' boundary (e2e/support/boundary.mjs) applied to every file under e2e/, with the batteries still to be
// made language-neutral listed below. The list only shrinks: a battery on it that no longer crosses the boundary is
// an error too, so its entry is removed as soon as it's done. The batteries in TYPESCRIPT_ONLY are left out for good.
// runE2E refuses to run while there is a problem, and testE2ESupport checks the same.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundaryProblems, EXEMPT } from '../e2e/support/boundary.mjs';

const E2E_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e');

/**
 * Batteries of Box Cam's video analysis (the computer-vision engine, its provider and the Combine production gate).
 * That analysis is to move to a service of its own, so these batteries test this server's implementation only: they
 * stay as they are, outside the boundary, and a port of this server doesn't run them.
 */
export const TYPESCRIPT_ONLY = [
  'development/boxCamCvProvider',
  'development/boxCamCvRobustness',
  'development/combineProductionGate',
];

/** Batteries that still import the server or start it themselves. */
export const NOT_YET_NEUTRAL = [
  'agents/adversarial',
  'agents/compliance',
  'agents/compliancePersistence',
  'agents/corePersistence',
  'agents/crossApp',
  'agents/crossAppAdversarial',
  'agents/transactions',
  'agents/transactionsPersistence',
  'development/boxCam',
  'development/combine',
  'development/hub',
  'discovery/matchingAndWatchlists',
  'discovery/secondLookAndNobodyMissed',
  'operations/clubOperations',
  'passport/passport',
  'passport/trustScore',
  'recruitment/analytics',
  'recruitment/contacts',
  'recruitment/contactsPersistence',
  'recruitment/decisions',
  'recruitment/decisionsPersistence',
  'recruitment/journeyAdversarial',
  'recruitment/journeyPersistence',
  'recruitment/lifecycle',
  'recruitment/offers',
  'recruitment/offersAdversarial',
  'recruitment/offersPersistence',
  'recruitment/rooms',
  'recruitment/signings',
  'recruitment/signingsAdversarial',
  'recruitment/signingsPersistence',
  'recruitment/trialDatesMinorsAndErasure',
  'recruitment/trials',
  'recruitment/trialsPersistence',
];

/** Every boundary problem under e2e/, as messages. Empty when the boundary holds. */
export function boundaryReport() {
  const files = fs
    .readdirSync(E2E_DIR, { recursive: true })
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !EXEMPT.includes(f))
    .sort();
  const out = [];
  for (const f of files) {
    const name = f.replace(/\.mjs$/, '');
    const problems = boundaryProblems(fs.readFileSync(path.join(E2E_DIR, f), 'utf8'));
    if (TYPESCRIPT_ONLY.includes(name)) continue;
    const pending = NOT_YET_NEUTRAL.includes(name);
    if (problems.length && !pending) for (const p of problems) out.push(`e2e/${f}:${p.line} ${p.why}: ${p.text}`);
    if (!problems.length && pending)
      out.push(`e2e/${f} no longer crosses the boundary: remove it from NOT_YET_NEUTRAL in scripts/e2eBoundary.mjs`);
  }
  for (const [list, names] of [
    ['NOT_YET_NEUTRAL', NOT_YET_NEUTRAL],
    ['TYPESCRIPT_ONLY', TYPESCRIPT_ONLY],
  ])
    for (const name of names)
      if (!files.includes(`${name}.mjs`)) out.push(`${list} lists ${name}, which is not in e2e/`);
  for (const name of NOT_YET_NEUTRAL.filter((n) => TYPESCRIPT_ONLY.includes(n)))
    out.push(`${name} is in both NOT_YET_NEUTRAL and TYPESCRIPT_ONLY`);
  return out;
}
