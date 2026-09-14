// Demo-host lifecycle for the E2E battery (§74–§76).
//
// THE DEFECT THIS FIXES
//
// `crosstab` and `demoOffline` both assumed something was already listening on
// :8099. For a long time something always was — a demo host left running from
// an earlier session — so both tests passed. They were passing against
// WHATEVER that process happened to be serving, which was a bundle built at
// some earlier, unknown point. The tests looked green and were not testing the
// current build.
//
// That is worse than a failing test, because a failing test gets fixed. This
// one reported success about code it had never loaded, and it only surfaced
// when the battery was run in an order where nothing had started the host
// first, at which point two tests that had "always passed" failed.
//
// THE FIX HAS TWO HALVES, AND BOTH ARE NECESSARY
//
//   1. Ownership. A test that needs the demo host starts one if none is
//      running, and stops the one it started. No test depends on ambient
//      state left behind by another.
//
//   2. Identity. Starting one is not enough, because a stale host is still
//      listening and still answers. So the host publishes a BUILD MARKER
//      derived from the bytes of the bundles it will serve, and a caller that
//      finds an existing host compares that marker against the bundles on
//      disk. A mismatch is a hard failure with an explicit message — never a
//      silent "well, something answered".
//
// The second half is the one that matters. Without it, "make the test start
// the server" quietly becomes "make the test start the server unless one is
// already there", which is the original bug with extra steps.

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
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false }); });
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
  child.stderr.on('data', (c) => { childErr += c; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`demo host exited immediately (code ${child.exitCode})\n${childErr}`);
    }
    const r = await get(`${host}/__buildmarker`);
    if (r.ok && r.status === 200 && r.body.trim() === marker) {
      return {
        host, started: true, marker,
        stop: async () => {
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
