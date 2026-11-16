// How a battery starts the server under test: `spawn(...serverCommand(), { cwd: serverDir, env })`.
//
// This is the one file under e2e/ that names the server, so it is the one file a port of the server replaces: the
// batteries themselves never mention server.mjs or a path outside e2e/ (support/boundary.mjs checks).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server's directory: the working directory a battery starts it in. */
export const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `[command, args]` that start the server, for `spawn`. */
export const serverCommand = () => [process.execPath, [path.join(serverDir, 'server.mjs')]];
