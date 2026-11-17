// How a battery starts the Gleam server: `spawn(...serverCommand(), { cwd: serverDir, env })`, against the dev build
// `npm run e2e` compiles first (`gleam build`, incremental), so a battery's boot is the BEAM's, not a compile. erl
// `exec`s the emulator, so the child a battery kills is the BEAM itself.
//
// This is the one file under e2e/support/ that this repository writes: the TypeScript server's own launcher starts
// its server.mjs, and e2e/sync.mjs copies everything else verbatim.
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
    .filter((p) => fs.existsSync(p))
    .flatMap((p) => ['-pa', p]);
  return ['erl', [...NO_BUSY_WAIT, ...paths, '-eval', 'scoutbox@@main:run(scoutbox)', '-noshell', '-extra']];
}
