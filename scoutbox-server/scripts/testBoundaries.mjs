// The import rules (scripts/checkBoundaries.mjs): the server keeps them, and each rule refuses a tree that breaks it.
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBoundaries } from './checkBoundaries.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYERS = [['platform'], ['low'], ['high']];

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** A throwaway server tree: `{ 'domains/low/a.mjs': "…" }`. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-boundaries-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const BASE = {
  'domains/platform/values.mjs': 'export const x = 1;\n',
  'domains/low/rules.mjs': "import { x } from '../platform/values.mjs';\nexport const LOW = x;\n",
  'domains/low/routes.mjs': "import { LOW } from './rules.mjs';\nexport function registerLow() { return LOW; }\n",
  'domains/low/public.mjs': "// The low domain's vocabulary.\nexport { LOW } from './rules.mjs';\n",
  'domains/high/routes.mjs':
    "import { LOW } from '../low/public.mjs';\nexport function registerHigh() { return LOW; }\n",
  'repositories/low.mjs': "import { LOW } from '../domains/low/public.mjs';\nexport const repo = LOW;\n",
  'server.mjs':
    "import { registerLow } from './domains/low/routes.mjs';\nimport { registerHigh } from './domains/high/routes.mjs';\n",
  'e2e/low/battery.mjs': "import { LOW } from '../../domains/low/rules.mjs';\n",
};
function problemsOf(changes) {
  const root = tree({ ...BASE, ...changes });
  try {
    return checkBoundaries(root, { layers: LAYERS });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the server keeps the rules', () => {
  assert.deepEqual(checkBoundaries(SERVER), []);
});

test('a tree that keeps the rules has no problems; the composition root and the tests may import anything', () => {
  assert.deepEqual(problemsOf({}), []);
});

test("another domain's internals are refused, from a domain and from a repository", () => {
  const p = problemsOf({
    'domains/high/routes.mjs': "import { LOW } from '../low/rules.mjs';\n",
    'repositories/low.mjs': "import { LOW } from '../domains/low/rules.mjs';\n",
  });
  assert.equal(p.filter((l) => l.includes('is imported through domains/low/public.mjs')).length, 2, p.join('\n'));
});

test('an import from a domain in the same or a higher layer is refused', () => {
  const p = problemsOf({
    'domains/high/public.mjs': "export { registerHigh } from './routes.mjs';\n",
    'domains/low/up.mjs': "import { HIGH } from '../high/public.mjs';\n",
  });
  assert.ok(
    p.some((l) => l.includes('domains/low/up.mjs imports the high domain, which is not in a lower layer than low')),
    p.join('\n'),
  );
});

test('the platform layer imports no domain, even through its public module', () => {
  const p = problemsOf({ 'domains/platform/audit.mjs': "import { LOW } from '../low/public.mjs';\n" });
  assert.ok(
    p.some((l) => l.includes('the platform layer imports no domain')),
    p.join('\n'),
  );
});

test('an import cycle is refused, inside one folder too', () => {
  const p = problemsOf({
    'repositories/a.mjs': "import { b } from './b.mjs';\nexport const a = 1;\n",
    'repositories/b.mjs': "import { a } from './a.mjs';\nexport const b = 2;\n",
  });
  assert.ok(p.includes('import cycle: repositories/a.mjs → repositories/b.mjs'), p.join('\n'));
});

test('a public module re-exports only its own domain, never from a module that registers routes, and holds nothing else', () => {
  const p = problemsOf({
    'domains/low/public.mjs':
      "export { LOW } from './rules.mjs';\nexport { registerLow } from './routes.mjs';\nexport { x } from '../platform/values.mjs';\nexport const extra = 1;\n",
  });
  assert.ok(
    p.some((l) => l.includes('re-exports domains/low/routes.mjs, which registers routes')),
    p.join('\n'),
  );
  assert.ok(
    p.some((l) => l.includes('re-exports domains/platform/values.mjs, outside its domain')),
    p.join('\n'),
  );
  assert.ok(
    p.some((l) => l.includes('holds something other than re-exports')),
    p.join('\n'),
  );
});

test('a missing file and a domain with no layer are refused', () => {
  const p = problemsOf({
    'domains/low/broken.mjs': "import { gone } from './gone.mjs';\n",
    'domains/stray/x.mjs': 'export const y = 1;\n',
  });
  assert.ok(p.includes('domains/low/broken.mjs imports ./gone.mjs, which does not exist'), p.join('\n'));
  assert.ok(
    p.some((l) => l.startsWith('domains/stray/ has no layer')),
    p.join('\n'),
  );
});

console.log(`testBoundaries: ${passed} passed`);
