// `npm run e2e`: builds the server once (`gleam build`), then runs the batteries (e2e/batteries.mjs) against it,
// one per core at a time, the slowest of the last run first so that none starts at the end. Each battery boots its
// own server on a temporary DATA_DIR and its own port.
//
//   npm run e2e                     every battery
//   npm run e2e -- platform/staff   only those
//   TEST_JOBS=1                     one at a time
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATTERIES } from './batteries.mjs';
import { sweepStaleRuns } from './support/staleRuns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..');

const requested = process.argv.slice(2);
const unknown = requested.filter((r) => !BATTERIES.some((b) => b === r || b.startsWith(`${r}/`)));
if (unknown.length) {
  console.error(`e2e: not a battery or domain: ${unknown.join(', ')}`);
  process.exit(2);
}
// How long each battery took when it last ran: the order to start them in. Not committed; a missing or unreadable
// file falls back to the list's order.
const TIMES = path.join(SERVER_DIR, 'build', 'e2e-times.json');
let times = {};
try {
  times = JSON.parse(fs.readFileSync(TIMES, 'utf8'));
} catch {
  /* no times yet */
}
const queue = BATTERIES.filter(
  (b) => !requested.length || requested.some((r) => b === r || b.startsWith(`${r}/`)),
).sort((a, b) => (times[b] ?? 0) - (times[a] ?? 0));

// The patched esqlite first (nothing to do when it is current): the build links its NIF.
const esqlite = spawnSync(process.execPath, [path.join(SERVER_DIR, 'dev/esqlite.mjs')], { cwd: SERVER_DIR, encoding: 'utf8' });
if (esqlite.status !== 0) {
  console.error(esqlite.stdout, esqlite.stderr);
  console.error('e2e: the patched esqlite did not build');
  process.exit(1);
}
const build = spawnSync('gleam', ['build'], { cwd: SERVER_DIR, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  console.error('e2e: the server did not build');
  process.exit(1);
}

const jobs = Number(process.env.TEST_JOBS ?? os.availableParallelism());
const results = [];
// Each battery's temporary directories go in a folder of its own (its TMPDIR, which os.tmpdir() reads), removed when
// it exits; what earlier runs left behind is removed once it is a day old.
sweepStaleRuns();
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-e2e-'));
process.on('exit', () => fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 3 }));
const runOne = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    const tmp = fs.mkdtempSync(path.join(runRoot, `${name.replace(/[^\w-]/g, '_')}-`));
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], {
      cwd: SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', (code) => {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      const ok = code === 0;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const summary = log.trim().split('\n').at(-1);
      console.log(`${ok ? '✓' : '✗'} ${name} (${secs}s)${ok ? `  ${summary}` : ''}`);
      if (!ok) console.log(log.replace(/^/gm, '    '));
      results.push({ name, ok });
      times[name] = Number(secs);
      resolve();
    });
  });

const pending = [...queue];
await Promise.all(
  Array.from({ length: Math.max(1, jobs) }, async () => {
    while (pending.length) await runOne(pending.shift());
  }),
);
try {
  fs.writeFileSync(TIMES, `${JSON.stringify(times, null, 2)}\n`);
} catch {
  /* the order is only a convenience */
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} batteries passed`);
process.exit(failed.length ? 1 : 0);
