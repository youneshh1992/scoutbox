// M23 P8 §60 — the entry-screen credit regression.
//
// "Built by Guni & Younes" is rendered on every intended entry surface: the
// Club, Grassroots, Agent and Admin login screens and the Player onboarding
// hero. The check reads the `login-signature` test id each surface carries and
// the text inside it — nothing about pixels, fonts or colours (the styling is
// M24's to change). No server is needed: the credit is part of the entry
// screen before any request is made.
//
//   node e2e/entryCredit.test.mjs            # builds the five bundles, serves them, checks each at 1280 and 390
//   KEEP_DIST=1 …                           # reuses dist-livecredit bundles when present

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const DIST = 'dist-livecredit'; // under the ignored dist-live* pattern
const APPS = [['scoutbox-club', 8551, 'Club'], ['scoutbox-grassroots', 8552, 'Grassroots'], ['scoutbox-agent', 8553, 'Agent'], ['scoutbox-admin', 8554, 'Admin'], ['scoutbox-player', 8555, 'Player onboarding']];
const CREDIT = /Built by\s*Guni\s*&\s*Younes/i;

let passed = 0;
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond, m) => (cond ? say(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [, port] of APPS) {
  const free = await new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.once('listening', () => probe.close(() => resolve(true))); probe.listen(port, '127.0.0.1'); });
  if (!free) fail(`port ${port} is already in use — a stale process is running. Kill it and re-run.`);
}

const KEEP = process.env.KEEP_DIST === '1';
const haveDist = APPS.every(([app]) => fs.existsSync(path.join(ROOT, app, DIST, 'index.html')));
if (KEEP && haveDist) console.log('reusing credit bundles (KEEP_DIST=1)');
else {
  console.log('building the five entry surfaces…');
  for (const [app] of APPS) {
    if (app === 'scoutbox-player') execSync(`EXPO_PUBLIC_API_URL=http://localhost:4999 npx expo export --clear --platform web --output-dir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
    else execSync(`VITE_API_URL=http://localhost:4999 npx vite build --outDir ${DIST}`, { cwd: path.join(ROOT, app), stdio: 'pipe' });
  }
}

const statics = [];
function serveDir(dir, port) {
  const root = path.join(ROOT, dir);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { const idx = path.join(file, 'index.html'); file = fs.existsSync(idx) ? idx : path.join(root, 'index.html'); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(port); statics.push(srv);
}
for (const [app, port] of APPS) serveDir(`${app}/${DIST}`, port);

let browser = null;
const cleanup = () => {
  try { browser?.close(); } catch { /* gone */ }
  for (const s of statics) { try { s.close(); } catch { /* gone */ } }
  if (!KEEP) for (const [app] of APPS) fs.rmSync(path.join(ROOT, app, DIST), { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

browser = await chromium.launch({ executablePath: EXE });
const errors = [];
for (const [app, port, label] of APPS) {
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label}@${width}: ${e}`));
    await page.goto(`http://localhost:${port}/`);
    // The player app lands on its onboarding hero (no session); the web apps on their login screen.
    const sel = '[data-testid="login-signature"]';
    let seen = false;
    for (let i = 0; i < 80 && !seen; i++) { seen = (await page.locator(sel).count()) > 0; if (!seen) await sleep(250); }
    ok(seen, `${label} @ ${width}px: the entry surface carries the credit element (login-signature)`);
    const text = (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
    ok(CREDIT.test(text), `${label} @ ${width}px: it reads "Built by Guni & Younes" (${JSON.stringify(text)})`);
    const box = await page.locator(sel).first().boundingBox();
    ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= width + 1, `${label} @ ${width}px: it is rendered inside the viewport width`);
    await ctx.close();
  }
}
ok(errors.length === 0, `zero page errors across the five entry surfaces (${errors.length ? errors.join(' | ') : 'none'})`);
console.log(`\nentryCredit: ${passed} checks passed — the credit is present on Club, Grassroots, Agent, Admin and Player onboarding`);
process.exit(0);
