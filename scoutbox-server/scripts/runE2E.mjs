// `npm run e2e`: the end-to-end batteries in e2e/<domain>/, several at a time (suiteRunner.mjs).
//
// Each battery boots its own server(s) on a temporary DATA_DIR and its own ports.
//
//   npm run e2e                                     every battery
//   npm run e2e -- recruitment                      every battery of one domain
//   npm run e2e -- platform/api recruitment/offers  only those batteries
//
// A check that fails for a recorded reason uses e2e/support/knownFailure.mjs, so its battery stays in the list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuites } from './suiteRunner.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = path.join(SERVER_DIR, 'e2e');

// Every battery, slowest first so the fast ones fill the gaps at the end.
export const BATTERIES = [
  'recruitment/signingsAdversarial', 'recruitment/journeyPersistence', 'recruitment/signingsPersistence',
  'recruitment/offersAdversarial', 'recruitment/journeyAdversarial', 'platform/connectedMode', 'operations/clubOperations',
  'recruitment/offers', 'recruitment/signings', 'recruitment/decisions', 'recruitment/contactsPersistence',
  'platform/contracts', 'platform/safeguarding', 'platform/messaging', 'platform/delivery', 'platform/notifications', 'platform/staff', 'agents/adversarial', 'platform/sessionsAndPorts', 'recruitment/trials',
  'recruitment/offersPersistence', 'agents/transactionsPersistence', 'recruitment/decisionsPersistence',
  'agents/compliancePersistence', 'recruitment/trialsPersistence', 'discovery/matchingAndWatchlists',
  'platform/storeGuarantees', 'discovery/exposureCalibrationAndCoverage', 'verification/organisationsAndStaff',
  'platform/dates', 'recruitment/contacts', 'recruitment/journey', 'agents/transactions',
  'verification/organisationsAndStaffAdversarial', 'agents/corePersistence', 'agents/core', 'development/hub',
  'agents/crossApp', 'recruitment/trialDatesMinorsAndErasure', 'agents/compliance', 'recruitment/analytics',
  'discovery/secondLookAndNobodyMissed', 'development/boxCamCvRobustness', 'recruitment/rooms',
  'development/boxCamCvProvider', 'recruitment/lifecycle', 'platform/api', 'development/combine',
  'platform/productionHardening', 'scouting/clubWorkflows', 'development/boxCam', 'agents/crossAppAdversarial',
  'verification/passport', 'verification/trustScore', 'development/combineProductionGate',
];
// Folders under e2e/ that hold helpers, not batteries.
const HELPER_DIRS = ['support'];
const BATTERY_TIMEOUT_MS = 10 * 60_000;

const onDisk = fs.readdirSync(E2E_DIR, { recursive: true })
  .filter((f) => f.endsWith('.mjs') && !HELPER_DIRS.includes(f.split(path.sep)[0]))
  .map((f) => f.slice(0, -4).split(path.sep).join('/'));
const unlisted = onDisk.filter((n) => !BATTERIES.includes(n));
if (unlisted.length) { console.error(`runE2E: ${unlisted.join(', ')} ${unlisted.length === 1 ? 'is' : 'are'} in e2e/ but not in BATTERIES in scripts/runE2E.mjs; add ${unlisted.length === 1 ? 'it' : 'them'} so ${unlisted.length === 1 ? 'it runs' : 'they run'}`); process.exit(2); }
const missing = BATTERIES.filter((n) => !onDisk.includes(n));
if (missing.length) { console.error(`runE2E: BATTERIES lists ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in e2e/`); process.exit(2); }

const requested = process.argv.slice(2).map((a) => a.replace(/^(\.\/)?e2e\//, '').replace(/\.mjs$/, ''));
const matches = (n, r) => n === r || n.startsWith(`${r}/`);
const unknown = requested.filter((r) => !BATTERIES.some((n) => matches(n, r)));
if (unknown.length) { console.error(`runE2E: not a battery or domain: ${unknown.join(', ')}`); process.exit(2); }
const queue = requested.length ? BATTERIES.filter((n) => requested.some((r) => matches(n, r))) : [...BATTERIES];

await runSuites({
  label: 'end-to-end battery', tool: 'runE2E', timeoutMs: BATTERY_TIMEOUT_MS,
  entries: queue.map((name) => ({ name, file: path.join(E2E_DIR, `${name}.mjs`), cwd: SERVER_DIR })),
});
