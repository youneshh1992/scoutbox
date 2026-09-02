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

run('npx expo export --platform web --output-dir dist-demo', path.join(ROOT, 'scoutbox-player'));
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
console.log('demo bundles ready in e2e/dist/');
