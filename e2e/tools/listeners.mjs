// Real listening-port enumeration for the browser batteries.
//
// `ss` is NOT installed in the CI/agent container (M23 P5.6F, F-7): every
// `ss -ltn | grep :port` check there reported "zero listeners" whether or not a
// port was held — a check that cannot fail, which is worse than no check because
// it appears in the evidence column. This reads /proc/net/tcp and /proc/net/tcp6
// directly for sockets in state 0A (LISTEN).
//
//   node e2e/tools/listeners.mjs              → every listening port
//   node e2e/tools/listeners.mjs 4028,8728    → only those, exit 1 if any is held
import fs from 'node:fs';

const want = process.argv[2] ? new Set(process.argv[2].split(',').map(Number)) : null;
const found = new Set();
for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of txt.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 4 || c[3] !== '0A') continue;
    const port = parseInt(c[1].split(':')[1], 16);
    if (Number.isFinite(port)) found.add(port);
  }
}
const list = [...found].sort((a, b) => a - b).filter((p) => !want || want.has(p));
process.stdout.write(list.join(' ') + '\n');
process.exit(list.length ? 1 : 0);
