// What the batteries need from a server beyond its routes: the environment settings they start it with, the
// development-only routes they call, and the test-clock header. e2e/support/CONTRACT.md documents each one, because a
// port of the server must honour all of them; testE2ESupport fails when a battery uses one the document doesn't name.
//
//   node scripts/e2eContract.mjs     print each item and the batteries that use it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = path.join(SERVER_DIR, 'e2e');
export const CONTRACT_FILE = path.join(E2E_DIR, 'support', 'CONTRACT.md');
const SKIP = new Set(['node_modules', 'e2e', 'scripts', 'dist']);

function sourceFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** The environment settings and development routes the server reads, found in its source. */
export function serverHooks() {
  const env = new Set();
  const routes = new Set();
  for (const file of sourceFiles(SERVER_DIR, ['.mjs', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) env.add(name);
    for (const [, route] of text.matchAll(/\.(?:get|post|put|patch|delete)\(\s*['"`](\/__[a-z-]+)/g)) routes.add(route);
  }
  return { env, routes };
}

/** Item → the battery files (relative to e2e/) that use it. */
export function contractUsage() {
  const { env, routes } = serverHooks();
  const items = [...env, ...routes, 'x-scoutbox-test-clock'];
  const usage = new Map(items.map((i) => [i, []]));
  for (const f of fs
    .readdirSync(E2E_DIR, { recursive: true })
    .filter((f) => f.endsWith('.mjs'))
    .sort()) {
    const text = fs.readFileSync(path.join(E2E_DIR, f), 'utf8');
    for (const item of items) {
      const re = item.startsWith('/') || item.startsWith('x-') ? item : new RegExp(`\\b${item}\\b`);
      if (typeof re === 'string' ? text.toLowerCase().includes(re) : re.test(text)) usage.get(item).push(f);
    }
  }
  for (const [item, files] of usage) if (!files.length) usage.delete(item);
  return usage;
}

/** Items a battery uses that CONTRACT.md doesn't name (in backticks). */
export function undocumented() {
  const doc = fs.existsSync(CONTRACT_FILE) ? fs.readFileSync(CONTRACT_FILE, 'utf8') : '';
  return [...contractUsage().keys()].filter((item) => !doc.includes(`\`${item}\``));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [item, files] of contractUsage()) console.log(`${item} (${files.length}): ${files.join(', ')}`);
  const missing = undocumented();
  if (missing.length) console.log(`\nnot in e2e/support/CONTRACT.md: ${missing.join(', ')}`);
}
