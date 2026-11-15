// How a battery starts the Gleam server: the Erlang release `npm run e2e` builds once
// (`gleam export erlang-shipment`), so a battery's boot is the BEAM's, not a compile.
//
// The batteries come from the TypeScript server, where they run `spawn('node', ['server.mjs'], …)` with the
// server directory as cwd; e2e/sync.mjs rewrites that line to `spawn(...gleamServer(), …)`. The entrypoint
// `exec`s erl, so the child a battery kills is the BEAM itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRYPOINT = path.join(SERVER_DIR, 'build', 'erlang-shipment', 'entrypoint.sh');

/** `[command, args]` for `spawn`. */
export function gleamServer() {
  if (!fs.existsSync(ENTRYPOINT))
    throw new Error(`${ENTRYPOINT} is missing: run the batteries with \`npm run e2e\`, which builds the release first`);
  return [ENTRYPOINT, ['run']];
}
