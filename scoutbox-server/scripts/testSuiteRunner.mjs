// The shared test runner (scripts/suiteRunner.mjs) removes every temporary file a suite leaves behind: each suite
// runs with a TMPDIR of its own, deleted when it exits. Here two throwaway "suites" deliberately leak (one passes,
// one fails) into os.tmpdir(), and the runner's own temporary folder must be empty afterwards; with TEST_KEEP_TMP=1
// only the failing suite's folder is kept.
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-runner-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

// Two leaking suites and a driver that runs them through runSuites.
const leak = (exitCode) => `
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-leak-'));
fs.writeFileSync(path.join(d, 'scoutbox.db'), 'x'.repeat(1024));
process.exit(${exitCode});
`;
fs.writeFileSync(path.join(work, 'passes.mjs'), leak(0));
fs.writeFileSync(path.join(work, 'fails.mjs'), leak(1));
fs.writeFileSync(
  path.join(work, 'driver.mjs'),
  `
import { runSuites } from ${JSON.stringify(path.join(HERE, 'suiteRunner.mjs'))};
await runSuites({ label: 'suite', tool: 'runnerTest', timeoutMs: 20_000, entries: [
  { name: 'passes', file: ${JSON.stringify(path.join(work, 'passes.mjs'))} },
  { name: 'fails', file: ${JSON.stringify(path.join(work, 'fails.mjs'))} },
] });
`,
);

const run = (env = {}) => {
  const tmp = fs.mkdtempSync(path.join(work, 'tmp-'));
  const r = spawnSync(process.execPath, [path.join(work, 'driver.mjs')], {
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, TEST_KEEP_TMP: '', ...env },
    encoding: 'utf8',
  });
  const left = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      left.push(path.relative(tmp, f));
      if (e.isDirectory()) walk(f);
    }
  })(tmp);
  return { status: r.status, out: r.stdout + r.stderr, left };
};

test('a passing and a failing suite that both leak a database leave nothing behind; the run still reports the failure', () => {
  const r = run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /1\/2 suites passed/);
  assert.deepEqual(r.left, [], `left behind: ${r.left.join(', ')}`);
});

test("TEST_KEEP_TMP=1 keeps the failing suite's folder only, and says where it is", () => {
  const r = run({ TEST_KEEP_TMP: '1' });
  assert.equal(r.status, 1, r.out);
  const kept = r.left.filter((p) => p.endsWith('scoutbox.db'));
  assert.equal(kept.length, 1, `kept: ${r.left.join(', ')}`);
  assert.match(kept[0], /fails-/, "the kept database is the failing suite's");
  assert.match(r.out, /temporary files kept: .*fails-/);
});

console.log(`\n${passed} suite-runner checks passed`);
