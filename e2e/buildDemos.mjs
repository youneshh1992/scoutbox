// Build all three self-contained demo bundles into e2e/dist/:
//   scoutbox-club-demo.html   (VITE_DEMO=1)
//   scoutbox-player-demo.html (Expo web export + deep-path history shim)
//   scoutbox-admin-demo.html  (VITE_DEMO=1)
// These single files are what gets published as the app tabs.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
for (const f of ['scoutbox-club-demo.html', 'scoutbox-admin-demo.html', 'scoutbox-grassroots-demo.html', 'scoutbox-player-demo.html']) {
  const p = path.join(OUT, f);
  let doc = fs.readFileSync(p, 'utf8');
  if (!doc.includes('data-storage-shim')) {
    doc = doc.replace(/<head>/i, `<head>${storageShim}`);
    if (!doc.includes('data-storage-shim')) doc = storageShim + doc; // no <head> tag — prepend
    fs.writeFileSync(p, doc);
  }
}
console.log('demo bundles ready in e2e/dist/');
