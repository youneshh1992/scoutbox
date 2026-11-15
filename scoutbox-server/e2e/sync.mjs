// Copies the end-to-end batteries this server answers from the TypeScript server, where they are the
// behavioural specification, applying only mechanical rewrites:
//
//   - the helpers a battery imports from the server tree come from e2e/support/ (copied verbatim, below);
//   - `spawn('node', ['server.mjs'], {` starts the Gleam release instead (e2e/support/server.mjs).
//
// Nothing else in a battery changes. A battery that imports any other part of the TypeScript server (its
// repositories or domain modules, usually for a storage assertion) is refused: that import has to be replaced by
// something language-neutral before the battery can run here.
//
//   node e2e/sync.mjs            copy every battery in e2e/batteries.mjs and the helpers
//   node e2e/sync.mjs --check    exit 1 if a committed copy differs from what the source would give
//
// The TypeScript server is found at ../../scoutbox/scoutbox-server, or at SCOUTBOX_TS_SERVER.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATTERIES } from './batteries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_SERVER = path.resolve(process.env.SCOUTBOX_TS_SERVER ?? path.join(HERE, '..', '..', '..', 'scoutbox', 'scoutbox-server'));


/** Server-tree helpers a battery may import, and where their copies live. */
const HELPERS = {
  '../../scripts/testPort.mjs': { from: 'scripts/testPort.mjs', to: 'support/testPort.mjs' },
  '../../domains/identity/totp.mjs': { from: 'domains/identity/totp.mjs', to: 'support/totp.mjs' },
};

const SPAWN = "spawn('node', ['server.mjs'], {";
const banner = (source) =>
  `// Copied from the TypeScript server's ${source} by e2e/sync.mjs, with only its mechanical rewrites. Edit the source.\n`;

function rewrite(name, text) {
  let out = text;
  for (const [from, { to }] of Object.entries(HELPERS)) out = out.split(`'${from}'`).join(`'../${to}'`);
  // Static (`from '../../…'`) and dynamic (`import('../../…')`) imports alike.
  const internal = [...out.matchAll(/(?:from |import\()'(\.\.\/\.\.\/[^']+)'/g)].map((m) => m[1]);
  if (internal.length)
    throw new Error(`${name} imports TypeScript-server internals: ${[...new Set(internal)].join(', ')}`);
  if (!out.includes(SPAWN)) throw new Error(`${name} does not start its server with ${SPAWN}`);
  out = out.split(SPAWN).join("spawn(...gleamServer(), {");
  // After the last import, so the battery's own imports keep their order.
  const imports = [...out.matchAll(/^import .*;$/gm)];
  const at = imports.at(-1).index + imports.at(-1)[0].length;
  out = `${out.slice(0, at)}\nimport { gleamServer } from '../support/server.mjs';${out.slice(at)}`;
  return banner(`e2e/${name}.mjs`) + out;
}

const outputs = new Map();
for (const { from, to } of Object.values(HELPERS))
  outputs.set(path.join(HERE, to), banner(from) + fs.readFileSync(path.join(TS_SERVER, from), 'utf8'));
for (const name of BATTERIES)
  outputs.set(path.join(HERE, `${name}.mjs`), rewrite(name, fs.readFileSync(path.join(TS_SERVER, 'e2e', `${name}.mjs`), 'utf8')));

if (process.argv.includes('--check')) {
  const stale = [...outputs].filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text);
  for (const [file] of stale) console.error(`e2e/sync: ${path.relative(HERE, file)} differs from its source; run node e2e/sync.mjs`);
  process.exit(stale.length ? 1 : 0);
}
for (const [file, text] of outputs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`e2e/sync: wrote ${path.relative(HERE, file)}`);
}
