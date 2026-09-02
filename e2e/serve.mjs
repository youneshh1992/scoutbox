// Static host for the demo bundles on :8099 — one origin so the cross-tab
// sync bus (BroadcastChannel + localStorage) connects the club and player
// tabs, plus a deep path to prove the player route shim.
//   /club/         → club demo      /player/       → player demo
//   /admin/        → admin demo     /deep/nested/  → player demo (deep path)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.env.PORT || 8099);
const FILES = {
  '/club/': 'scoutbox-club-demo.html',
  '/player/': 'scoutbox-player-demo.html',
  '/admin/': 'scoutbox-admin-demo.html',
  '/deep/nested/': 'scoutbox-player-demo.html',
  '/grassroots/': 'scoutbox-grassroots-demo.html',
};

http.createServer((req, res) => {
  const key = Object.keys(FILES).find((k) => req.url === k || req.url === k.slice(0, -1));
  if (!key) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(DIST, FILES[key])));
}).listen(PORT, () => console.log(`demo host on :${PORT} — /club /player /admin /deep/nested`));
