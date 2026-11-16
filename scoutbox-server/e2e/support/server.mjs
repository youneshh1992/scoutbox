// How a battery starts the Gleam server: `spawn(...serverCommand(), { cwd: serverDir, env })`, against the Erlang
// release `npm run e2e` builds once (`gleam export erlang-shipment`), so a battery's boot is the BEAM's, not a
// compile. The entrypoint `exec`s erl, so the child a battery kills is the BEAM itself.
//
// This is the one file under e2e/support/ that this repository writes: the TypeScript server's own launcher starts
// its server.mjs, and e2e/sync.mjs copies everything else verbatim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server's directory: the working directory a battery starts it in. */
export const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRYPOINT = path.join(serverDir, 'build', 'erlang-shipment', 'entrypoint.sh');

/** `[command, args]` that start the server, for `spawn`. */
export function serverCommand() {
  if (!fs.existsSync(ENTRYPOINT))
    throw new Error(`${ENTRYPOINT} is missing: run the batteries with \`npm run e2e\`, which builds the release first`);
  return [ENTRYPOINT, ['run']];
}
