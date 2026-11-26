// `node e2e/check.mjs` (part of `npm run e2e:check`): every file under e2e/ keeps to the boundary in
// support/boundary.mjs (it imports only Node and e2e/, and starts the server only through support/server.mjs), and
// every battery file is listed in batteries.mjs, so `npm run e2e` runs it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATTERIES } from './batteries.mjs';
import { boundaryProblems, EXEMPT } from './support/boundary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The runner and its list, which live beside the batteries but drive them. */
const RUNNER = ['run.mjs', 'batteries.mjs', 'check.mjs'];

const files = fs
  .readdirSync(HERE, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
  .map((e) => path.relative(HERE, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
  .filter((f) => !f.startsWith('node_modules/'));

const problems = [];
for (const f of files.filter((f) => !EXEMPT.includes(f) && !RUNNER.includes(f)))
  for (const p of boundaryProblems(fs.readFileSync(path.join(HERE, f), 'utf8')))
    problems.push(`${f}:${p.line} ${p.why}: ${p.text}`);
const batteries = files.filter((f) => !f.startsWith('support/') && !RUNNER.includes(f)).map((f) => f.replace(/\.mjs$/, ''));
for (const b of batteries.filter((b) => !BATTERIES.includes(b)))
  problems.push(`${b}.mjs is a battery that e2e/batteries.mjs doesn't list`);
for (const b of BATTERIES.filter((b) => !batteries.includes(b)))
  problems.push(`e2e/batteries.mjs lists ${b}, which has no file`);
for (const p of problems) console.error(`e2e/check: ${p}`);
process.exit(problems.length ? 1 : 0);
