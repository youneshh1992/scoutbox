// P2.5 closure — a deterministic fingerprint of a client's SOURCE, computed
// from file contents (never timestamps). `buildDemos.mjs` stamps it into each
// demo bundle as <meta name="sb-source-fingerprint">; `demoFreshness.test.mjs`
// recomputes it and refuses a bundle whose source has moved on. A stale
// review artifact therefore fails a cheap test instead of misleading a
// reviewer. Anything that changes what the bundle renders lives under src/
// (plus the app's package.json and, for the player, app.json).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEMO_APPS = {
  'scoutbox-club-demo.html': { app: 'scoutbox-club', extra: ['package.json', 'index.html'] },
  'scoutbox-grassroots-demo.html': { app: 'scoutbox-grassroots', extra: ['package.json', 'index.html'] },
  'scoutbox-admin-demo.html': { app: 'scoutbox-admin', extra: ['package.json', 'index.html'] },
  'scoutbox-player-demo.html': { app: 'scoutbox-player', extra: ['package.json', 'app.json'] },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** sha256 over (relative path + contents) of every file under src/ plus the extras, in a fixed order. */
export function sourceFingerprint(app, extra = []) {
  const base = path.join(ROOT, app);
  const files = walk(path.join(base, 'src')).concat(extra.map((f) => path.join(base, f)).filter((f) => fs.existsSync(f)));
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(base, f)); h.update('\0');
    h.update(fs.readFileSync(f)); h.update('\0');
  }
  // The inliner and the demo build script shape the bundle too.
  for (const f of ['e2e/inline.mjs', 'e2e/buildDemos.mjs']) { h.update(f); h.update(fs.readFileSync(path.join(ROOT, f))); }
  return h.digest('hex').slice(0, 24);
}

export function readStamp(html) {
  const fp = html.match(/<meta name="sb-source-fingerprint" content="([0-9a-f]+)">/)?.[1] ?? null;
  const sha = html.match(/<meta name="sb-build-sha" content="([0-9a-f]+)">/)?.[1] ?? null;
  return { fingerprint: fp, sha };
}
