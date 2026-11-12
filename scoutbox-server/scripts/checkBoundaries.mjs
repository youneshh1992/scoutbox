// `npm run check:boundaries`: the server's import rules (docs/architecture.md, "Domain boundaries").
//
//   1. No import cycles between server modules.
//   2. A domain imports another domain only through that domain's `public.mjs`, and only a domain in a lower layer of
//      DOMAIN_LAYERS. `domains/platform/` is the lowest layer: any module may import it, and it imports no domain.
//   3. Code outside `domains/` (the repositories, the shared rule modules) imports a domain only through its
//      `public.mjs`. `server.mjs` wires the domains together and may import any module.
//   4. A `public.mjs` only re-exports from its own domain's modules, and never from one that registers routes.
//   5. Every relative import names a file that exists, and every domain folder has a layer.
//
// The tests (`e2e/`, `scripts/`) may import any module.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bottom to top. A domain may import the public module of a domain in a lower layer only. */
export const DOMAIN_LAYERS = [
  ['platform'],
  ['identity', 'groups', 'integrations', 'media', 'safety'],
  ['enterprise', 'messaging'],
  ['development'],
  ['verification'],
  ['discovery'],
  ['recruitment'],
  ['scouting', 'insight', 'operations'],
  ['agents'],
  ['passport'],
];

const SKIPPED_DIRS = new Set(['node_modules', 'e2e', 'scripts', 'data', 'public', 'assets']);
const COMPOSITION_ROOT = 'server.mjs';

const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gms;
const BARE_IMPORT = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const REGISTERS_ROUTES = /^export\s+(?:async\s+)?function\s+register[A-Z]/m;

function serverModules(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(rel);
      } else if (e.name.endsWith('.mjs')) out.push(rel);
    }
  })('');
  return out.sort();
}

function importsOf(source) {
  const specs = [];
  for (const re of [STATIC_IMPORT, BARE_IMPORT, DYNAMIC_IMPORT])
    for (const m of source.matchAll(re)) if (m[1].startsWith('.')) specs.push(m[1]);
  return specs;
}

const domainOf = (file) => {
  const parts = file.split('/');
  return parts[0] === 'domains' && parts.length > 2 ? parts[1] : null;
};

function cycles(graph) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  const visit = (v) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (graph.get(v) ?? []).includes(v)) found.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

/** Every broken rule, as one line each. An empty list means the tree keeps the rules. */
export function checkBoundaries(root, { layers = DOMAIN_LAYERS } = {}) {
  const problems = [];
  const layerOf = new Map(layers.flatMap((names, i) => names.map((n) => [n, i])));
  const files = serverModules(root);
  const known = new Set(files);
  const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  const graph = new Map();

  const domainsDir = path.join(root, 'domains');
  if (fs.existsSync(domainsDir))
    for (const e of fs.readdirSync(domainsDir, { withFileTypes: true }))
      if (e.isDirectory() && !layerOf.has(e.name))
        problems.push(`domains/${e.name}/ has no layer in DOMAIN_LAYERS (scripts/checkBoundaries.mjs)`);

  for (const file of files) {
    const edges = [];
    graph.set(file, edges);
    const from = domainOf(file);
    for (const spec of importsOf(sources.get(file))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!known.has(target)) {
        if (!fs.existsSync(path.join(root, target))) problems.push(`${file} imports ${spec}, which does not exist`);
        continue;
      }
      edges.push(target);
      const to = domainOf(target);
      if (!to || to === from || file === COMPOSITION_ROOT) continue;
      if (from === 'platform') {
        problems.push(`${file} imports ${target}: the platform layer imports no domain`);
        continue;
      }
      if (to === 'platform') continue;
      if (target !== `domains/${to}/public.mjs`)
        problems.push(`${file} imports ${target}: another domain is imported through domains/${to}/public.mjs`);
      if (from && layerOf.has(from) && layerOf.has(to) && layerOf.get(to) >= layerOf.get(from))
        problems.push(`${file} imports the ${to} domain, which is not in a lower layer than ${from}`);
    }
  }

  for (const file of files.filter((f) => /^domains\/[^/]+\/public\.mjs$/.test(f))) {
    const domain = domainOf(file);
    const body = sources
      .get(file)
      .replace(/\/\/[^\n]*\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const statements = body
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const st of statements) {
      const m = /^export\s*\{[^}]*\}\s*from\s*['"](\.[^'"]+)['"]$/s.exec(st);
      if (!m) {
        problems.push(`${file} holds something other than re-exports: ${st.split('\n')[0].slice(0, 80)}`);
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
      if (domainOf(target) !== domain) problems.push(`${file} re-exports ${target}, outside its domain`);
      else if (sources.has(target) && REGISTERS_ROUTES.test(sources.get(target)))
        problems.push(`${file} re-exports ${target}, which registers routes`);
    }
  }

  for (const scc of cycles(graph)) problems.push(`import cycle: ${scc.join(' → ')}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkBoundaries(root);
  for (const p of problems) console.error(`BOUNDARY ${p}`);
  if (problems.length) {
    console.error(
      `${problems.length} boundary problem(s); the rules are in docs/architecture.md, "Domain boundaries".`,
    );
    process.exit(1);
  }
  console.log('domain boundaries hold');
}
