// How a browser suite starts its own API: the Gleam server, with the options a suite would give `spawn` (its env
// names the port and an isolated DATA_DIR). The server is compiled first, once per process; `gleam build` is
// incremental, so that is quick after the first time. After a fresh clone, run `npm run esqlite` in
// scoutbox-server/ before any suite.
import { execFileSync, spawn } from 'node:child_process';
import { serverCommand, serverDir } from '../scoutbox-server/e2e/support/server.mjs';

let built = false;

/** Starts the API server; the child is the BEAM itself, so killing it stops the server. */
export function spawnApi(options = {}) {
  if (!built) {
    execFileSync('gleam', ['build'], { cwd: serverDir, stdio: 'ignore' });
    built = true;
  }
  return spawn(...serverCommand(), { stdio: 'ignore', ...options, cwd: serverDir });
}
