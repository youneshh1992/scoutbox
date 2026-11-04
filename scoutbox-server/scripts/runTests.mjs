// `npm test`: the server's unit suites, several at a time.
//
// Each suite is its own process on its own temporary directories and
// OS-assigned ports (testPort.mjs freePort), so suites never share state and
// can run side by side. A suite's output is printed in one piece when it
// finishes, so nothing interleaves; a failing suite prints its whole log.
//
//   npm test                          every suite, TEST_JOBS at a time (default: up to 4)
//   npm test -- testOrgs testSessions only those suites
//   TEST_JOBS=1 npm test              one at a time, in list order
//   TEST_VERBOSE=1 npm test           print every suite's whole log, not just the failures'
//
// Every suite runs even after a failure; the exit code is 1 if any failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The slow suites (each boots real servers) come first, so the fast ones fill
// the gaps at the end instead of a slow one starting last.
export const SUITES = [
  'testOutboxPushServer', 'testDispatchesServer', 'testSafetyAuditServer', 'testCoreIdentityServer',
  'testWriterAtomicity', 'testNotificationsServer', 'testOneTimeCodesServer', 'testRecruitmentServer',
  'testRecruitmentContactsOffersServer', 'testChannelsServer', 'testRecruitmentCasesServer', 'testPlayerErasureServer',
  'testBackup', 'testSessions', 'testOrgs', 'testIdentity',
  'testRuntime', 'testTrust', 'testDataLayer', 'testCoreSchema', 'testUnitOfWork', 'testCoreIdentityMapping',
  'testIdentityRepositories', 'testCoreIdentityMigration', 'testMediaDeletions', 'testPlayerSubrecords',
  'testOneTimeCodes', 'testNotifications', 'testDispatches', 'testOutboxPush', 'testChannels', 'testSafetyAudit',
  'testPlayerErasure', 'testRecruitment', 'testRecruitmentCases', 'testRecruitmentContactsOffers',
  'testSigningsFollowUps', 'testSchemaDdl', 'testPaging',
];
// Files named test*.mjs that are helpers, not suites. Any other test*.mjs must
// be in SUITES: a new suite that nobody listed would otherwise never run.
const HELPERS = ['testChildren', 'testExpoStub', 'testPort', 'testSendgridStub'];
const SUITE_TIMEOUT_MS = 10 * 60_000;

const unlisted = fs.readdirSync(HERE).filter((f) => /^test\w*\.mjs$/.test(f)).map((f) => f.slice(0, -4)).filter((n) => !SUITES.includes(n) && !HELPERS.includes(n));
if (unlisted.length) { console.error(`runTests: ${unlisted.join(', ')} ${unlisted.length === 1 ? 'is' : 'are'} in scripts/ but not in SUITES (or HELPERS) in scripts/runTests.mjs; add ${unlisted.length === 1 ? 'it' : 'them'} so ${unlisted.length === 1 ? 'it runs' : 'they run'}`); process.exit(2); }

const requested = process.argv.slice(2).map((a) => path.basename(a, '.mjs'));
const unknown = requested.filter((n) => !SUITES.includes(n));
if (unknown.length) { console.error(`runTests: not a unit suite: ${unknown.join(', ')}`); process.exit(2); }
const queue = requested.length ? SUITES.filter((n) => requested.includes(n)) : [...SUITES];

const jobsEnv = process.env.TEST_JOBS;
if (jobsEnv !== undefined && !/^[1-9]\d*$/.test(jobsEnv)) { console.error('runTests: TEST_JOBS must be a positive whole number'); process.exit(2); }
const jobs = jobsEnv ? Number(jobsEnv) : Math.max(1, Math.min(4, os.availableParallelism()));
const verbose = process.env.TEST_VERBOSE === '1';

const running = new Set();
const results = [];
const t0 = Date.now();
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    // A hung suite is stopped with SIGTERM, so its own handler (testChildren.mjs) still stops its servers.
    const timer = setTimeout(() => { log += `\nrunTests: stopped after ${secs(SUITE_TIMEOUT_MS)}\n`; child.kill('SIGTERM'); }, SUITE_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); running.delete(child);
      const ms = Date.now() - started;
      const ok = code === 0;
      const last = log.trim().split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).at(-1) ?? '';
      console.log(`${ok ? '✓' : '✗'} ${name} (${secs(ms)})${ok ? ` ${last}` : ` exit ${code ?? signal}`}`);
      if (!ok || verbose) console.log(log.replace(/^.*(ExperimentalWarning|--trace-warnings).*\n/gm, '').replace(/^/gm, '    '));
      results.push({ name, ok, ms });
      resolve();
    });
  });
}

// Ctrl-C or a SIGTERM from CI: start nothing new, pass SIGTERM on so every
// running suite stops its own servers, and exit once they have.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    queue.length = 0;
    for (const c of running) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 2000).unref();
    if (!running.size) process.exit(code);
    else Promise.all([...running].map((c) => new Promise((r) => c.once('exit', r)))).then(() => process.exit(code));
  });
}

console.log(`${queue.length} unit suite(s), ${jobs} at a time`);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) await runSuite(queue.shift());
}));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${secs(Date.now() - t0)}${failed.length ? `; failed: ${failed.map((r) => r.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
