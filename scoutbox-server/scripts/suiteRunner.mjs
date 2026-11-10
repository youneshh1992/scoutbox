// Runs test files several at a time: shared by `npm test` (runTests.mjs) and `npm run e2e` (runE2E.mjs).
//
// Each file is its own process on its own temporary directories and ports, so files never share state and
// can run side by side. Its temporary directories live under a folder of its own (the child's TMPDIR, which
// os.tmpdir() reads), deleted when the file exits, whether it passed, failed or was stopped: a file that forgets
// to remove its databases, or a server it started, cannot leave them behind. A file's output is printed in one piece when it finishes, so nothing interleaves; a
// failing file prints its whole log. Every file runs even after a failure; the exit code is 1 if any failed.
//
//   TEST_JOBS=1      one at a time, in list order (default: up to 4)
//   TEST_VERBOSE=1   print every file's whole log, not just the failures'
//   TEST_KEEP_TMP=1  keep a FAILED file's temporary folder for inspection (its path is printed)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const plural = (word, n) => (n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const NOISE = /ExperimentalWarning|--trace-warnings/;

/**
 * @param {object} o
 * @param {string} o.label         what the files are, for the summary ("unit suite", "end-to-end battery")
 * @param {string} o.tool          the runner's name, for its messages
 * @param {{ name: string, file: string, cwd?: string }[]} o.entries  in start order (slowest first)
 * @param {number} o.timeoutMs     a file still running after this is stopped with SIGTERM
 */
export async function runSuites({ label, tool, entries, timeoutMs }) {
  const jobsEnv = process.env.TEST_JOBS;
  if (jobsEnv !== undefined && !/^[1-9]\d*$/.test(jobsEnv)) {
    console.error(`${tool}: TEST_JOBS must be a positive whole number`);
    process.exit(2);
  }
  const jobs = jobsEnv ? Number(jobsEnv) : Math.max(1, Math.min(4, os.availableParallelism()));
  const verbose = process.env.TEST_VERBOSE === '1';
  const keepFailed = process.env.TEST_KEEP_TMP === '1';
  // One folder per run, one sub-folder per file; whatever is left of it is removed when the run ends.
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `scoutbox-${tool}-`));
  const kept = new Set();
  const removeDir = (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.error(`${tool}: could not remove ${dir}: ${err.message}`);
    }
  };
  const cleanRoot = () => {
    if (!kept.size) {
      removeDir(runRoot);
      return;
    }
    for (const e of fs.readdirSync(runRoot)) {
      const d = path.join(runRoot, e);
      if (!kept.has(d)) removeDir(d);
    }
  };
  process.on('exit', cleanRoot);

  const queue = [...entries];
  const running = new Set();
  const results = [];
  const t0 = Date.now();

  const runOne = ({ name, file, cwd }) =>
    new Promise((resolve) => {
      const started = Date.now();
      const tmp = fs.mkdtempSync(path.join(runRoot, `${name.replace(/[^\w-]/g, '_')}-`));
      const child = spawn(process.execPath, [file], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      });
      running.add(child);
      let log = '';
      child.stdout.on('data', (d) => {
        log += d;
      });
      child.stderr.on('data', (d) => {
        log += d;
      });
      // A hung file is stopped with SIGTERM, so its own handler still stops its servers.
      const timer = setTimeout(() => {
        log += `\n${tool}: stopped after ${secs(timeoutMs)}\n`;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        running.delete(child);
        const ms = Date.now() - started;
        const ok = code === 0;
        const last =
          log
            .trim()
            .split('\n')
            .filter((l) => !NOISE.test(l))
            .at(-1) ?? '';
        console.log(`${ok ? '✓' : '✗'} ${name} (${secs(ms)})${ok ? ` ${last}` : ` exit ${code ?? signal}`}`);
        if (!ok || verbose)
          console.log(log.replace(/^.*(ExperimentalWarning|--trace-warnings).*\n/gm, '').replace(/^/gm, '    '));
        if (!ok && keepFailed) {
          kept.add(tmp);
          console.log(`    (temporary files kept: ${tmp})`);
        } else removeDir(tmp);
        results.push({ name, ok, ms });
        resolve();
      });
    });

  // Ctrl-C or a SIGTERM from CI: start nothing new, pass SIGTERM on so every
  // running file stops its own servers, and exit once they have.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(signal, () => {
      queue.length = 0;
      for (const c of running) c.kill('SIGTERM');
      setTimeout(() => process.exit(code), 2000).unref();
      if (!running.size) process.exit(code);
      else Promise.all([...running].map((c) => new Promise((r) => c.once('exit', r)))).then(() => process.exit(code));
    });
  }

  console.log(`${queue.length} ${plural(label, queue.length)}, ${jobs} at a time`);
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift());
    }),
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} ${plural(label, results.length)} passed in ${secs(Date.now() - t0)}${failed.length ? `; failed: ${failed.map((r) => r.name).join(', ')}` : ''}`,
  );
  process.exit(failed.length ? 1 : 0);
}
