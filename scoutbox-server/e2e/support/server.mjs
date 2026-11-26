// How a battery starts the Gleam server: `spawn(...serverCommand(), { cwd: serverDir, env })`, against the dev build
// `npm run e2e` compiles first (`gleam build`, incremental), so a battery's boot is the BEAM's, not a compile. erl
// `exec`s the emulator, so the child a battery kills is the BEAM itself.
//
// The batteries start the server only through this file (e2e/boundary.mjs checks that), so they stay independent of
// how the server is built.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server's directory: the working directory a battery starts it in. */
export const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(serverDir, 'build', 'dev', 'erlang');

// An idle scheduler spins for a while before it sleeps. With several servers on one machine, each server's
// spinning takes cores from the others: switched off, a full run took 71 s instead of 119 s.
const NO_BUSY_WAIT = ['+sbwt', 'none', '+sbwtdcpu', 'none', '+sbwtdio', 'none'];

/** `[command, args]` that start the server, for `spawn`. Flags go to erl here, not through a battery's env. */
export function serverCommand() {
  if (!fs.existsSync(path.join(BUILD, 'scoutbox', 'ebin')))
    throw new Error(`${BUILD} is missing: run the batteries with \`npm run e2e\`, which builds first`);
  const paths = fs
    .readdirSync(BUILD)
    .map((p) => path.join(BUILD, p, 'ebin'))
    .filter((p) => fs.existsSync(p));
  // Added in the eval, not with `-pa`: OTP leaves `-pa` directories out of the code path cache, so each module the
  // server loads would be looked for in every directory on disk. Cached, a boot took 486 ms instead of 667 ms, and a
  // full run 43 s instead of 60 s (most of the difference was system time, from those lookups).
  const run = `code:add_pathsa(${JSON.stringify(paths)}, cache), scoutbox@@main:run(scoutbox)`;
  return ['erl', [...NO_BUSY_WAIT, '-eval', run, '-noshell', '-extra']];
}
