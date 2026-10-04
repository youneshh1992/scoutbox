// Build the self-contained demo bundles into e2e/dist/:
//   scoutbox-club-demo.html   (VITE_DEMO=1)
//   scoutbox-player-demo.html (Expo web export + deep-path history shim)
//   scoutbox-admin-demo.html  (VITE_DEMO=1)
//   scoutbox-grassroots-demo.html, scoutbox-agent-demo.html (VITE_DEMO=1)
// These single files are what gets published as the app tabs.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_APPS, sourceFingerprint } from './sourceFingerprint.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e', 'dist');
fs.mkdirSync(OUT, { recursive: true });
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env } });
const inline = (dist, out) => run(`node ${path.join(ROOT, 'e2e', 'inline.mjs')} ${dist} ${out}`, ROOT);

run('VITE_DEMO=1 npx vite build', path.join(ROOT, 'scoutbox-club'));
inline(path.join(ROOT, 'scoutbox-club', 'dist'), path.join(OUT, 'scoutbox-club-demo.html'));

run('VITE_DEMO=1 npx vite build', path.join(ROOT, 'scoutbox-admin'));
inline(path.join(ROOT, 'scoutbox-admin', 'dist'), path.join(OUT, 'scoutbox-admin-demo.html'));

run('VITE_DEMO=1 npx vite build', path.join(ROOT, 'scoutbox-grassroots'));
inline(path.join(ROOT, 'scoutbox-grassroots', 'dist'), path.join(OUT, 'scoutbox-grassroots-demo.html'));

run('VITE_DEMO=1 npx vite build', path.join(ROOT, 'scoutbox-agent'));
inline(path.join(ROOT, 'scoutbox-agent', 'dist'), path.join(OUT, 'scoutbox-agent-demo.html'));

// Demo is explicit now: without EXPO_PUBLIC_DEMO=1 the player app builds in
// LIVE mode against the real backend.
run('EXPO_PUBLIC_DEMO=1 npx expo export --clear --platform web --output-dir dist-demo', path.join(ROOT, 'scoutbox-player'));
inline(path.join(ROOT, 'scoutbox-player', 'dist-demo'), path.join(OUT, 'scoutbox-player-demo.html'));

// expo-router matches on pathname; hosted at any deep path the demo must
// still land on "/". file:// forbids this shim, so file:// is not supported
// for the player demo — serve it over http (see serve.mjs).
const playerFile = path.join(OUT, 'scoutbox-player-demo.html');
let html = fs.readFileSync(playerFile, 'utf8');
const shim = '<script>try{history.replaceState(null,"","/")}catch(e){}</script>';
if (!html.includes(shim)) {
  html = html.replace(/(<div id="root"[^>]*>)/, `$1${shim}`);
  fs.writeFileSync(playerFile, html);
}

// Sandboxed hosts (e.g. artifact viewers without allow-same-origin) make the
// localStorage/sessionStorage GETTERS throw — `typeof localStorage` included —
// which crashes app bundles at boot into a white screen. Replace throwing
// storage with an in-memory shim before any bundle code runs, in every demo.
const storageShim = '<script data-storage-shim>(function(){function mem(){var m=new Map;return{getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()},key:function(i){return Array.from(m.keys())[i]!==undefined?Array.from(m.keys())[i]:null},get length(){return m.size}}}function guard(n){try{window[n].getItem("__probe__")}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}}guard("localStorage");guard("sessionStorage")})();</script>';
for (const f of ['scoutbox-club-demo.html', 'scoutbox-admin-demo.html', 'scoutbox-grassroots-demo.html', 'scoutbox-agent-demo.html', 'scoutbox-player-demo.html']) {
  const p = path.join(OUT, f);
  let doc = fs.readFileSync(p, 'utf8');
  if (!doc.includes('data-storage-shim')) {
    doc = doc.replace(/<head>/i, `<head>${storageShim}`);
    if (!doc.includes('data-storage-shim')) doc = storageShim + doc; // no <head> tag — prepend
    fs.writeFileSync(p, doc);
  }
}
// Honesty chrome, demo builds only: a small fixed "Interactive demo" badge
// with the source build id, so every artifact declares what it is and which
// commit it was built from. Never injected into connected/live builds.
const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
const built = new Date().toISOString().slice(0, 10);
// M24F.5 — Inter like the product; bottom-right, and above the Player tab bar so it never covers a label.
const badgeFor = (bottom) => `<div data-demo-badge style="position:fixed;right:8px;bottom:${bottom}px;z-index:2147483000;background:rgba(11,18,32,.78);border:1px solid #263a5e;color:#8fa3c8;font:10px/1.4 Inter,system-ui,sans-serif;border-radius:8px;padding:2px 7px;pointer-events:none">Interactive demo — sample data · build ${sha} · ${built}</div>`;
for (const f of ['scoutbox-club-demo.html', 'scoutbox-admin-demo.html', 'scoutbox-grassroots-demo.html', 'scoutbox-agent-demo.html', 'scoutbox-player-demo.html']) {
  const p = path.join(OUT, f);
  let doc = fs.readFileSync(p, 'utf8');
  doc = doc.replace(/<div data-demo-badge[^>]*>[^<]*<\/div>/, ''); // idempotent
  const badge = badgeFor(f === 'scoutbox-player-demo.html' ? 74 : 8);
  doc = doc.replace(/<\/body>/i, `${badge}</body>`);
  if (!doc.includes('data-demo-badge')) doc += badge; // no </body> — append
  fs.writeFileSync(p, doc);
}
// P2.5 closure — stamp each bundle with a fingerprint of the source it was
// built from (content hash, not a timestamp) and the build commit.
// `demoFreshness.test.mjs` recomputes the fingerprint from the working tree
// and fails when a bundle is stale.
// The ScoutBox mark: a dark tile with the green full stop of the wordmark.
const ICON = `<link rel="icon" data-sb-icon type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#18201b"/><rect x="18" y="18" width="7" height="7" rx="1.5" fill="#00e676"/></svg>')}">`;
for (const [f, { app, extra }] of Object.entries(DEMO_APPS)) {
  const p = path.join(OUT, f);
  let doc = fs.readFileSync(p, 'utf8');
  doc = doc.replace(/<meta name="sb-source-fingerprint" content="[^"]*">/g, '').replace(/<meta name="sb-build-sha" content="[^"]*">/g, '').replace(/<link rel="icon" data-sb-icon[^>]*>/g, '');
  // M24F.5 freeze — an inline icon, so a browser serving the single-file bundle never asks the host for /favicon.ico (no 404).
  const stamp = `<meta name="sb-source-fingerprint" content="${sourceFingerprint(app, extra)}"><meta name="sb-build-sha" content="${sha}">${ICON}`;
  doc = doc.includes('<head>') ? doc.replace('<head>', `<head>${stamp}`) : stamp + doc;
  fs.writeFileSync(p, doc);
}
console.log(`demo bundles ready in e2e/dist/ (build ${sha})`);
