// Regression for the harness-ordering defect (§75, §76).
//
// The original failure: `crosstab` and `demoOffline` assumed a demo host was
// already listening on :8099. Run in an order where nothing had started one,
// they failed — and run in the usual order, they passed against whatever an
// earlier session had left running, which was not necessarily the current
// build. The battery reported success about code it had never loaded.
//
// So there are two properties to hold, and this file checks both directly
// rather than checking that the battery "works":
//
//   §75  With :8099 EMPTY, a test that needs the host starts one and gets the
//        current bundles. No ambient state, no ordering dependency.
//
//   §76  With a host listening that serves DIFFERENT bundles, the caller
//        REFUSES rather than proceeding. Without this, "start the server if
//        it's missing" is the original bug with an extra branch.
//
// No browser needed — this is about process lifecycle, not pages.

import http from 'node:http';
import { ensureDemoHost, buildMarker, DEFAULT_PORT } from './demoHost.mjs';

const say = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

const PORT = Number(process.env.DEMO_ORDERING_PORT || 8198);   // not the real one
let checks = 0;
const check = (cond, m) => { checks += 1; if (cond) say(m); else fail(m); };

const get = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ ok: true, status: res.statusCode, body: b }));
  });
  req.on('error', () => resolve({ ok: false }));
  req.setTimeout(1500, () => { req.destroy(); resolve({ ok: false }); });
});

console.log('demo host ordering (§74–§76)');

// -------------------------------------------------- §75: empty port
{
  const before = await get(`http://localhost:${PORT}/__buildmarker`);
  check(!before.ok, `nothing is listening on :${PORT} to begin with`);

  const demo = await ensureDemoHost({ port: PORT });
  check(demo.started === true, 'with the port empty, ensureDemoHost STARTED a host rather than assuming one');

  const served = await get(`${demo.host}/__buildmarker`);
  const onDisk = buildMarker().marker;
  check(served.ok && served.body.trim() === onDisk,
    `the started host serves the bundles currently on disk (${onDisk})`);

  // And it actually serves pages, not just a marker.
  const page = await get(`${demo.host}/club/`);
  check(page.ok && page.status === 200 && page.body.includes('<'), 'the started host serves the club demo');

  await demo.stop();
  const after = await get(`http://localhost:${PORT}/__buildmarker`);
  check(!after.ok, 'stop() released the port — the test leaves no host behind for the next one to inherit');
}

// ------------------------------------- §76: stale host must be refused
{
  // A host that answers on the port but reports a DIFFERENT build. This is
  // precisely the shape of the process that made the battery look green.
  const stale = http.createServer((req, res) => {
    if (req.url === '/__buildmarker') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('staleb0118dfeed00');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>an older bundle</body></html>');
  });
  await new Promise((r) => stale.listen(PORT, r));

  let refused = false, message = '';
  try {
    const d = await ensureDemoHost({ port: PORT });
    await d.stop();
  } catch (e) {
    refused = true; message = e.message;
  }
  check(refused, 'a host serving a DIFFERENT build is refused, not silently used');
  check(message.includes('stale') || message.includes('not serving the current'),
    'the refusal explains that it is the stale-demo-server failure');
  check(message.includes(String(PORT)), 'the refusal names the port so it can be acted on');

  await new Promise((r) => stale.close(r));
}

// --------------------------------- a host with the right build is reused
{
  const demo = await ensureDemoHost({ port: PORT });
  check(demo.started === true, 'first caller starts the host');

  const second = await ensureDemoHost({ port: PORT });
  check(second.started === false, 'a second caller finding a MATCHING host reuses it');

  // The second caller did not start it, so its stop() must not kill it.
  await second.stop();
  const alive = await get(`http://localhost:${PORT}/__buildmarker`);
  check(alive.ok, 'stop() from a caller that did not start the host leaves it running');

  await demo.stop();
  const gone = await get(`http://localhost:${PORT}/__buildmarker`);
  check(!gone.ok, 'stop() from the owner releases it');
}

// ------------------------------------- the marker is content-derived
{
  const a = buildMarker().marker;
  const b = buildMarker().marker;
  check(a === b, 'the marker is stable across calls — it hashes bundle bytes, not timestamps');

  const missing = buildMarker({ dist: '/nonexistent-dist-path' });
  check(missing.parts.every((p) => p.endsWith(':MISSING')),
    'a missing bundle is reported as MISSING rather than throwing somewhere less useful');
  check(missing.marker !== a, 'missing bundles produce a different marker than present ones');
}

console.log(`\ndemoHostOrdering: ${process.exitCode ? 'FAILED' : `all ${checks} checks passed`}`);
