// Demo-host lifecycle for the E2E battery.
//
// A test that needs the demo host starts one if none is running and stops the
// one it started, so no test depends on state another left behind.
//
// Starting one is not enough: a stale host still answers. So the host publishes
// a BUILD MARKER derived from the bytes of the bundles it serves, and a caller
// that finds an existing host compares it with the bundles on disk. A mismatch
// is a hard failure, never a silent "something answered". Without that check,
// tests pass against whatever bundle an earlier session left running.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.join(HERE, 'dist');
export const DEFAULT_PORT = Number(process.env.DEMO_PORT || 8099);

/** The bundles the host serves, in a fixed order so the marker is stable. */
export const BUNDLES = Object.freeze([
  'scoutbox-admin-demo.html',
  'scoutbox-agent-demo.html',
  'scoutbox-club-demo.html',
  'scoutbox-connected-demo.html',
  'scoutbox-grassroots-demo.html',
  'scoutbox-player-demo.html',
]);

/**
 * A marker for the bundles currently on disk.
 *
 * Content-derived, not time-derived: rebuilding an identical bundle produces
 * the same marker, and a bundle whose bytes changed produces a different one.
 * A timestamp would flag every rebuild as stale and train people to ignore it.
 *
 * A missing bundle is recorded rather than thrown on, so the mismatch message
 * can say "this file is missing" instead of failing somewhere less useful.
 */
export function buildMarker({ dist = DIST } = {}) {
  const h = createHash('sha256');
  const parts = [];
  for (const name of BUNDLES) {
    const p = path.join(dist, name);
    let tag;
    try {
      const bytes = fs.readFileSync(p);
      tag = `${name}:${bytes.length}:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
    } catch {
      tag = `${name}:MISSING`;
    }
    parts.push(tag);
    h.update(tag);
  }
  return { marker: h.digest('hex').slice(0, 16), parts };
}

function get(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure a demo host is serving the CURRENT bundles, and say who owns it.
 *
 * Returns `{ host, started, marker, stop() }`. `stop()` is always safe to call
 * and only terminates a host this call started — a pre-existing host that
 * matched is left exactly as it was found.
 *
 * Throws when a host is listening but serving something else. That is the
 * whole point: the alternative is a green test about code nobody ran.
 */
export async function ensureDemoHost({ port = DEFAULT_PORT, dist = DIST, timeoutMs = 15000 } = {}) {
  const host = `http://localhost:${port}`;
  const { marker, parts } = buildMarker({ dist });

  const missing = parts.filter((p) => p.endsWith(':MISSING'));
  if (missing.length) {
    throw new Error(
      `demo bundles are missing from ${dist}:\n  ${missing.join('\n  ')}\n` +
        'Run `node e2e/buildDemos.mjs` (and buildConnectedDemo.mjs) before the E2E battery.',
    );
  }

  // Is anything already there?
  const probe = await get(`${host}/__buildmarker`);
  if (probe.ok) {
    if (probe.status === 200 && probe.body.trim() === marker) {
      return { host, started: false, marker, stop: async () => {} };
    }
    const served = probe.status === 200 ? probe.body.trim() : `no marker (HTTP ${probe.status})`;
    throw new Error(
      `A process is listening on :${port} but it is not serving the current demo bundles.\n` +
        `  on disk: ${marker}\n  served : ${served}\n` +
        'This is the stale-demo-server failure: the tests would have passed against a build\n' +
        'nobody in this run produced. Stop that process and let the battery start its own\n' +
        `(e.g. \`pkill -f e2e/serve.mjs\` or free port ${port}), then re-run.`,
    );
  }

  // Nothing there — start one and own it.
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stderr.on('data', (c) => {
    childErr += c;
  });

  // Ownership must not depend on the caller remembering to call stop().
  //
  // A dozen suites each have a slightly different exit shape — early
  // process.exit(1) on a page error, a bare exit(0) at the end, an uncaught
  // rejection. Patching every one of those is how a host gets left behind
  // again, which is the exact bug this module exists to kill. So the child is
  // killed from an exit hook here, synchronously, for every caller.
  const killOnExit = () => {
    try {
      if (child.exitCode == null) child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  };
  process.once('exit', killOnExit);
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      killOnExit();
      process.exit(130);
    });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`demo host exited immediately (code ${child.exitCode})\n${childErr}`);
    }
    const r = await get(`${host}/__buildmarker`);
    if (r.ok && r.status === 200 && r.body.trim() === marker) {
      // Do not hold the caller's event loop open.
      //
      // A spawned child with piped stdio keeps Node alive, so a suite that
      // ends without calling stop() HANGS rather than finishing — which read
      // as a timeout failure on a suite that had actually printed OK. Unref
      // the child and its pipes: the process can now exit whenever its own
      // work is done, and the exit hook above still kills the host.
      child.unref();
      child.stdout?.unref?.();
      child.stderr?.unref?.();

      return {
        host,
        started: true,
        marker,
        stop: async () => {
          process.removeListener('exit', killOnExit);
          if (child.exitCode == null) {
            child.kill('SIGTERM');
            // Give it a moment, then insist.
            for (let i = 0; i < 20 && child.exitCode == null; i += 1) await sleep(25);
            if (child.exitCode == null) child.kill('SIGKILL');
          }
        },
      };
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`demo host did not become ready on :${port} within ${timeoutMs}ms\n${childErr}`);
}
