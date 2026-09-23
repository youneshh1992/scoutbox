// Terminate leftover test servers WITHOUT `pkill -f`, which matches the calling
// shell's own command line and has killed an agent session (exit 144) twice.
//
// A process qualifies only when /proc/<pid>/comm is exactly "node" AND its argv
// is exactly [<node>, "…/server.mjs"]. A bash shell whose command line merely
// CONTAINS that string has comm "bash", so it can never match.
//
//   node e2e/tools/reap.mjs
import fs from 'node:fs';

const killed = [];
for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
  if (Number(pid) === process.pid) continue;
  let comm; let argv;
  try {
    comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch { continue; }
  if (comm !== 'node' || argv.length !== 2 || !/(^|\/)server\.mjs$/.test(argv[1])) continue;
  try { process.kill(Number(pid), 'SIGTERM'); killed.push(pid); } catch { /* already gone */ }
}
console.log(killed.length ? `terminated server.mjs pids: ${killed.join(' ')}` : 'no server.mjs process running');
