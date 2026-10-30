// Runtime compatibility contract: the data layer needs
// `DatabaseSync.prototype.isTransaction` (Node.js 22.16 / 24.0), so an
// unsupported runtime must be refused clearly BEFORE the data directory is
// created or modified, and a supported one must save, roll a failed save back
// and retry. Three kinds of check, labelled in the output:
//   [current runtime]  the Node.js running this suite — a real runtime test;
//   [simulation]       the current runtime with isTransaction masked by
//                      scripts/runtime/maskIsTransaction.cjs — NOT a real
//                      older runtime, only the shape of its API;
//   [real runtime vX]  every extra Node.js binary named in
//                      SCOUTBOX_TEST_NODE_BINS (colon-separated paths) — the
//                      same probe on the actual binary; skipped when unset.
// Everything runs on throwaway directories under the OS temp directory.
// Run with: npm test   (SCOUTBOX_TEST_NODE_BINS=/path/node:/other/node npm test for the real ones)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..');
const PROBE = path.join(HERE, 'runtimeProbe.mjs');
const MASK = path.join(HERE, 'runtime', 'maskIsTransaction.cjs');
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
const digestDir = (dir) => {
  if (!fs.existsSync(dir)) return 'absent';
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) { h.update(f); h.update(fs.readFileSync(path.join(dir, f))); }
  return h.digest('hex');
};
const runProbe = (bin, dir, { mask = false } = {}) => {
  const r = spawnSync(bin, [...(mask ? ['--require', MASK] : []), PROBE, dir], { encoding: 'utf8', env: { ...process.env, M13_QUIET_LOGS: '1' } });
  const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return { status: r.status, out: line ? JSON.parse(line) : null, stderr: r.stderr };
};
const parseVersion = (v) => String(v).replace(/^v/, '').split('.').map(Number);
const atLeast = (v, min) => { const a = parseVersion(v), b = parseVersion(min); for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; } return true; };
const supportedByContract = (v) => { const [major] = parseVersion(v); return major >= 24 || (major === 22 && atLeast(v, '22.16.0')); };

const runtime = await import('../runtime.mjs').catch((err) => ({ missing: err.message }));

test('[current runtime] the support check describes this Node.js and finds the transaction API', () => {
  assert.equal(runtime.missing, undefined, `runtime.mjs: ${runtime.missing}`);
  const s = runtime.runtimeSupport();
  assert.equal(s.version, process.version);
  assert.equal(s.ok, true, s.reason);
  assert.equal(s.hasTransactionState, true);
  assert.equal(typeof runtime.MIN_NODE, 'object');
  assert.equal(runtime.MIN_NODE[22], '22.16.0'); assert.equal(runtime.MIN_NODE[24], '24.0.0');
  assert.doesNotThrow(() => runtime.requireRuntime());
  // The contract is what package.json advertises.
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.16.0', 'engines.node matches the minimum the code needs');
  const lock = JSON.parse(fs.readFileSync(path.join(SERVER, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['']?.engines?.node, '>=22.16.0', 'package-lock mirrors engines.node');
});

test(`[current runtime] ${process.version} (real): a normal save, a failed save rolled back, and the retry persisting the change`, () => {
  const dir = tempDir('rt-current');
  const r = runProbe(process.execPath, dir);
  assert.equal(r.status, 0, `probe exit ${r.status}: ${JSON.stringify(r.out)} ${r.stderr.slice(-300)}`);
  assert.equal(r.out.ok, true); assert.equal(r.out.rolledBack, true); assert.equal(r.out.squadRows, 1);
  assert.ok(r.out.steps.some((s) => s.startsWith('failed-save-threw')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[simulation] with isTransaction masked, the store refuses the runtime as unsupported before touching the data directory: an absent directory stays absent, an existing one is byte-identical, and nothing is half-opened', () => {
  // A directory that does not exist yet.
  const absent = path.join(tempDir('rt-mask'), 'data');
  const r = runProbe(process.execPath, absent, { mask: true });
  assert.equal(r.status, 3, `expected the unsupported-runtime exit (3), got ${r.status}: ${JSON.stringify(r.out)} ${r.stderr.slice(-400)}`);
  assert.equal(r.out.error?.code, 'NODE_UNSUPPORTED');
  assert.match(r.out.error.message, /22\.16/, 'the message names the minimum release');
  assert.match(r.out.error.message, /not touched/i);
  assert.deepEqual(r.out.steps, [], 'nothing was opened');
  assert.equal(fs.existsSync(absent), false, 'the data directory was not created');
  // A directory with content (a marker and an unrelated file): byte-identical afterwards.
  const existing = tempDir('rt-mask-existing');
  fs.writeFileSync(path.join(existing, 'marker.txt'), 'keep me');
  const before = digestDir(existing);
  const r2 = runProbe(process.execPath, existing, { mask: true });
  assert.equal(r2.status, 3); assert.equal(r2.out.error?.code, 'NODE_UNSUPPORTED');
  assert.equal(digestDir(existing), before, 'the existing directory is unchanged');
  assert.ok(!fs.existsSync(path.join(existing, 'scoutbox.db')), 'no database file was created');
  fs.rmSync(path.dirname(absent), { recursive: true, force: true }); fs.rmSync(existing, { recursive: true, force: true });
});

test('[simulation] the server refuses to boot on the masked runtime: non-zero exit, NODE_UNSUPPORTED before "listening on", data directory never created', () => {
  const dir = path.join(tempDir('rt-mask-server'), 'data');
  const r = spawnSync(process.execPath, ['--require', MASK, path.join(SERVER, 'server.mjs')], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, PORT: '0', M13_QUIET_LOGS: '1' }, timeout: 30_000 });
  const log = `${r.stdout}\n${r.stderr}`;
  assert.notEqual(r.status, 0, `the server must not start: exit ${r.status}`);
  assert.match(log, /NODE_UNSUPPORTED/);
  assert.ok(!/listening on/.test(log), 'never listened');
  assert.equal(fs.existsSync(dir), false, 'the data directory was not created');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const bins = (process.env.SCOUTBOX_TEST_NODE_BINS || '').split(':').filter(Boolean);
if (!bins.length) console.log('  (no SCOUTBOX_TEST_NODE_BINS supplied: real older-runtime checks skipped; the simulation above covers the API shape only)');
for (const bin of bins) {
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const expectSupported = supportedByContract(version);
  test(`[real runtime ${version}] ${expectSupported ? 'is supported: normal save, failed-save rollback and retry work' : 'is below the contract: refused before the data directory is touched'}`, () => {
    const dir = path.join(tempDir('rt-real'), 'data');
    const r = runProbe(bin, dir);
    if (expectSupported) {
      assert.equal(r.status, 0, `probe exit ${r.status}: ${JSON.stringify(r.out)} ${r.stderr.slice(-400)}`);
      assert.equal(r.out.ok, true); assert.equal(r.out.rolledBack, true); assert.equal(r.out.squadRows, 1);
      assert.equal(r.out.node, version);
    } else {
      assert.equal(r.status, 3, `expected the unsupported-runtime exit (3), got ${r.status}: ${JSON.stringify(r.out)} ${r.stderr.slice(-400)}`);
      assert.equal(r.out.error?.code, 'NODE_UNSUPPORTED');
      assert.equal(r.out.node, version);
      assert.equal(fs.existsSync(dir), false, 'the data directory was not created');
    }
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
}

console.log(`\n${passed} runtime checks passed`);
