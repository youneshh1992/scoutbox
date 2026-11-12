// `npm test`: the server's unit suites, several at a time.
//
// Each suite is its own process on its own temporary directories and
// OS-assigned ports (testPort.mjs freePort); suiteRunner.mjs runs them side by side.
//
//   npm test                          every suite, TEST_JOBS at a time (default: up to 4)
//   npm test -- testOrgs testSessions only those suites
//   TEST_JOBS=1 npm test              one at a time, in list order
//   TEST_VERBOSE=1 npm test           print every suite's whole log, not just the failures'
//
// Every suite runs even after a failure; the exit code is 1 if any failed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuites } from './suiteRunner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The slow suites (each boots real servers) come first, so the fast ones fill
// the gaps at the end instead of a slow one starting last.
export const SUITES = [
  'testOutboxPushServer',
  'testDispatchesServer',
  'testSafetyAuditServer',
  'testCoreIdentityServer',
  'testWriterAtomicity',
  'testNotificationsServer',
  'testOneTimeCodesServer',
  'testRecruitmentServer',
  'testScoutingEvidence',
  'testScoutingAssessments',
  'testClubSetup',
  'testOpportunitiesCampaigns',
  'testVerification',
  'testPassport',
  'testTransitionsVouches',
  'testAgentCore',
  'testCompliancePolicies',
  'testComplianceRecords',
  'testAgentTransactions',
  'testDevelopment',
  'testBoxCam',
  'testDiscovery',
  'testInsightCoverage',
  'testIntegrations',
  'testEnterprise',
  'testGroups',
  'testGrassroots',
  'testOperations',
  'testMatchFacts',
  'testRecruitmentContactsOffersServer',
  'testChannelsServer',
  'testRecruitmentCasesServer',
  'testPlayerErasureServer',
  'testBackup',
  'testSessions',
  'testStaff',
  'testOrgs',
  'testIdentity',
  'testRuntime',
  'testTrust',
  'testDataLayer',
  'testCoreSchema',
  'testUnitOfWork',
  'testWriteRules',
  'testIdentityRepositories',
  'testMediaDeletions',
  'testOneTimeCodes',
  'testNotifications',
  'testDispatches',
  'testOutboxPush',
  'testChannels',
  'testSafetyAudit',
  'testPlayerErasure',
  'testRecruitment',
  'testRecruitmentCases',
  'testRecruitmentContactsOffers',
  'testSigningsFollowUps',
  'testSchema',
  'testPaging',
  'testInputSchemas',
  'testPlatformHelpers',
  'testWiring',
  'testBoundaries',
  'testDeps',
  'testSuiteRunner',
];
// Files named test*.mjs that are helpers, not suites. Any other test*.mjs must
// be in SUITES: a new suite that nobody listed would otherwise never run.
const HELPERS = ['testChildren', 'testExpoStub', 'testPort', 'testSendgridStub'];
const SUITE_TIMEOUT_MS = 10 * 60_000;

const unlisted = fs
  .readdirSync(HERE)
  .filter((f) => /^test\w*\.mjs$/.test(f))
  .map((f) => f.slice(0, -4))
  .filter((n) => !SUITES.includes(n) && !HELPERS.includes(n));
if (unlisted.length) {
  console.error(
    `runTests: ${unlisted.join(', ')} ${unlisted.length === 1 ? 'is' : 'are'} in scripts/ but not in SUITES (or HELPERS) in scripts/runTests.mjs; add ${unlisted.length === 1 ? 'it' : 'them'} so ${unlisted.length === 1 ? 'it runs' : 'they run'}`,
  );
  process.exit(2);
}

const requested = process.argv.slice(2).map((a) => path.basename(a, '.mjs'));
const unknown = requested.filter((n) => !SUITES.includes(n));
if (unknown.length) {
  console.error(`runTests: not a unit suite: ${unknown.join(', ')}`);
  process.exit(2);
}
const queue = requested.length ? SUITES.filter((n) => requested.includes(n)) : [...SUITES];

await runSuites({
  label: 'unit suite',
  tool: 'runTests',
  timeoutMs: SUITE_TIMEOUT_MS,
  entries: queue.map((name) => ({ name, file: path.join(HERE, `${name}.mjs`) })),
});
