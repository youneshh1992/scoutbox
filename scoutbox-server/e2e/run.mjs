// `npm run e2e`: builds the Erlang release once, then runs the batteries (e2e/batteries.mjs) against it,
// several at a time. Each battery boots its own server on a temporary DATA_DIR and its own port.
//
//   npm run e2e                     every battery
//   npm run e2e -- platform/staff   only those
//   TEST_JOBS=1                     one at a time
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATTERIES } from './batteries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..');

const requested = process.argv.slice(2);
const unknown = requested.filter((r) => !BATTERIES.some((b) => b === r || b.startsWith(`${r}/`)));
if (unknown.length) {
  console.error(`e2e: not a battery or domain: ${unknown.join(', ')}`);
  process.exit(2);
}
const queue = BATTERIES.filter((b) => !requested.length || requested.some((r) => b === r || b.startsWith(`${r}/`)));

// The patched esqlite first (nothing to do when it is current): the release links its NIF.
const esqlite = spawnSync(process.execPath, [path.join(SERVER_DIR, 'dev/esqlite.mjs')], { cwd: SERVER_DIR, encoding: 'utf8' });
if (esqlite.status !== 0) {
  console.error(esqlite.stdout, esqlite.stderr);
  console.error('e2e: the patched esqlite did not build');
  process.exit(1);
}
const build = spawnSync('gleam', ['export', 'erlang-shipment'], { cwd: SERVER_DIR, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  console.error('e2e: the release did not build');
  process.exit(1);
}

const jobs = Number(process.env.TEST_JOBS ?? Math.min(4, os.availableParallelism()));
const results = [];
const runOne = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', (code) => {
      const ok = code === 0;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const summary = log.trim().split('\n').at(-1);
      console.log(`${ok ? '✓' : '✗'} ${name} (${secs}s)${ok ? `  ${summary}` : ''}`);
      if (!ok) console.log(log.replace(/^/gm, '    '));
      results.push({ name, ok });
      resolve();
    });
  });

const pending = [...queue];
await Promise.all(
  Array.from({ length: Math.max(1, jobs) }, async () => {
    while (pending.length) await runOne(pending.shift());
  }),
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} batteries passed`);
process.exit(failed.length ? 1 : 0);
