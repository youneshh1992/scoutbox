// Copies the end-to-end batteries this server answers, and their support files, verbatim from the TypeScript
// server, where they are the behavioural specification. The batteries are language-neutral there: they import only
// Node and e2e/support/, and start the server through support/server.mjs, which is the one file this repository
// writes for itself. So nothing is rewritten.
//
// A battery is refused if it crosses the boundary the TypeScript server checks (its e2e/support/boundary.mjs, run
// here on the copies too), or if the TypeScript server marks it TYPESCRIPT_ONLY.
//
//   node e2e/sync.mjs            copy every battery in e2e/batteries.mjs and all of e2e/support/
//   node e2e/sync.mjs --check    exit 1 if a committed copy differs from its source, or a copy has no source
//
// The TypeScript server is found at ../../scoutbox/scoutbox-server, or at SCOUTBOX_TS_SERVER.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BATTERIES } from './batteries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_SERVER = path.resolve(
  process.env.SCOUTBOX_TS_SERVER ?? path.join(HERE, '..', '..', '..', 'scoutbox', 'scoutbox-server'),
);
const TS_E2E = path.join(TS_SERVER, 'e2e');

/** Files under e2e/ that belong to this repository, not copies. */
const OWN = ['batteries.mjs', 'run.mjs', 'sync.mjs', 'support/server.mjs'];

const { boundaryProblems, EXEMPT } = await import(pathToFileURL(path.join(TS_E2E, 'support', 'boundary.mjs')).href);
const { TYPESCRIPT_ONLY } = await import(pathToFileURL(path.join(TS_SERVER, 'scripts', 'e2eBoundary.mjs')).href);

/** Every file under `root`/`sub`, as a path relative to `root`. */
const listed = (root, sub = '.') =>
  fs
    .readdirSync(path.join(root, sub), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'));

const sources = [
  ...listed(TS_E2E, 'support').filter((f) => !OWN.includes(f)),
  ...BATTERIES.map((name) => `${name}.mjs`),
];

const problems = [];
for (const name of BATTERIES.filter((n) => TYPESCRIPT_ONLY.includes(n)))
  problems.push(`${name} tests the TypeScript implementation only (TYPESCRIPT_ONLY): it can't be copied`);
const outputs = new Map();
for (const f of sources) {
  const text = fs.readFileSync(path.join(TS_E2E, f), 'utf8');
  if (f.endsWith('.mjs') && !EXEMPT.includes(f))
    for (const p of boundaryProblems(text)) problems.push(`${f}:${p.line} ${p.why}: ${p.text}`);
  outputs.set(f, text);
}
if (problems.length) {
  for (const p of problems) console.error(`e2e/sync: ${p}`);
  process.exit(2);
}

const copies = listed(HERE).filter((f) => !OWN.includes(f) && !f.startsWith('node_modules/'));
const orphans = copies.filter((f) => !outputs.has(f));

if (process.argv.includes('--check')) {
  const stale = [...outputs].filter(
    ([f, text]) => !fs.existsSync(path.join(HERE, f)) || fs.readFileSync(path.join(HERE, f), 'utf8') !== text,
  );
  for (const [f] of stale) console.error(`e2e/sync: ${f} differs from its source; run node e2e/sync.mjs`);
  for (const f of orphans) console.error(`e2e/sync: ${f} has no source any more; run node e2e/sync.mjs`);
  process.exit(stale.length || orphans.length ? 1 : 0);
}
for (const [f, text] of outputs) {
  const file = path.join(HERE, f);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`e2e/sync: wrote ${f}`);
}
for (const f of orphans) {
  fs.rmSync(path.join(HERE, f));
  console.log(`e2e/sync: removed ${f}, which has no source any more`);
}
