// P2.5 closure — stale-artifact guard. Every demo bundle in e2e/dist must
// have been built from the CURRENT client source: its stamped source
// fingerprint (a content hash written by buildDemos.mjs) must equal the
// fingerprint recomputed from the working tree. No browser, no timestamps,
// no git state — a bundle built from older source simply fails.
//   node e2e/demoFreshness.test.mjs            # fails if any bundle is stale or missing
//   node e2e/buildDemos.mjs && node e2e/demoFreshness.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_APPS, ROOT, readStamp, sourceFingerprint } from './sourceFingerprint.mjs';

let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failed++; console.error(`✗ ${m}`); } };
const DIST = path.join(ROOT, 'e2e', 'dist');

for (const [file, { app, extra }] of Object.entries(DEMO_APPS)) {
  const p = path.join(DIST, file);
  if (!fs.existsSync(p)) { ok(false, `${file}: bundle missing — run node e2e/buildDemos.mjs`); continue; }
  const html = fs.readFileSync(p, 'utf8');
  const { fingerprint, sha } = readStamp(html);
  ok(!!fingerprint && !!sha, `${file}: carries a source fingerprint and a build sha (${sha ?? '—'})`);
  const now = sourceFingerprint(app, extra);
  ok(fingerprint === now, `${file}: built from the current ${app} source (${fingerprint?.slice(0, 8) ?? '—'} vs ${now.slice(0, 8)})`);
  ok(/data-demo-badge/.test(html) && /Interactive demo/.test(html), `${file}: declares itself an interactive demo with its build id`);
  // M23 P8 §60/§76 — the entry-screen credit ships in every demo bundle: the
  // signature element and the words, in whichever case the app sets them.
  ok(/login-signature/.test(html) && /built by/i.test(html) && /Guni (&amp;|&) Younes/.test(html), `${file}: carries the entry-screen credit (login-signature, "Built by Guni & Younes")`);
}
// The stamp is content-derived: the same source must fingerprint the same way twice.
ok(sourceFingerprint('scoutbox-club', DEMO_APPS['scoutbox-club-demo.html'].extra) === sourceFingerprint('scoutbox-club', DEMO_APPS['scoutbox-club-demo.html'].extra), 'fingerprint is deterministic');

console.log(`\ndemoFreshness: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
