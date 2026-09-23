// Report surviving test processes, distinguishing a LEAK from teardown.
//
// Not `pgrep -f`: that pattern matches the calling shell's own command line and
// has killed an agent session with exit 144 more than once. Identity comes from
// /proc/<pid>/comm plus argv.
//
// Not every match is a leak. A process in state Z is a ZOMBIE: it has already
// exited and is only waiting for its parent to reap it. It holds no port, no
// memory and no file descriptor. Chromium spawns a tree of helpers, so for a
// second or two after a suite exits there are usually several. Reporting those
// as survivors would make this check cry wolf, which is how a real leak
// eventually gets ignored. So: ignore zombies, allow a short settle window for
// live processes still shutting down, and report anything alive after that.
//
//   node e2e/tools/survivors.mjs          → exit 1 if a live survivor remains
//   SETTLE_MS=8000 node e2e/tools/survivors.mjs
import fs from 'node:fs';

const SETTLE_MS = Number(process.env.SETTLE_MS ?? 4000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scan() {
  const live = []; const zombies = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    if (Number(pid) === process.pid) continue;
    let comm; let argv; let state;
    try {
      comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      // The comm field in /proc/<pid>/stat is parenthesised and may contain
      // spaces, so split after the LAST ')' rather than on whitespace.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch { continue; }
    const isServer = comm === 'node' && argv.some((a) => /(^|\/)server\.mjs$/.test(a));
    const isSuite = comm === 'node' && argv.some((a) => /\.test\.mjs$/.test(a));
    const isChromium = /^chrome|^chromium|^headless/.test(comm);
    const isVite = comm === 'node' && argv.some((a) => /(^|\/)vite$/.test(a));
    if (!(isServer || isSuite || isChromium || isVite)) continue;
    const row = `${pid} ${comm} [${state}] ${argv.slice(0, 3).join(' ')}`;
    (state === 'Z' ? zombies : live).push(row);
  }
  return { live, zombies };
}

let { live, zombies } = scan();
if (live.length) { await sleep(SETTLE_MS); ({ live, zombies } = scan()); }

if (zombies.length) console.log(`${zombies.length} zombie(s) awaiting reap — exited already, holding no port or memory; not a leak`);
if (live.length) {
  console.log(`!!! ${live.length} LIVE survivor(s) after a ${SETTLE_MS}ms settle:\n${live.join('\n')}`);
  process.exit(1);
}
console.log('no live surviving server / suite / chromium / vite process');
