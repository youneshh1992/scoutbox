// Re-blesses the fixtures under test/fixtures/: writes this server's answers into them, and prints the inputs whose
// answer changed. See test/scoutbox/blessed.gleam for how a test stores its answers.
//
// It runs `gleam test` with SCOUTBOX_BLESS=1, under which each fixture test records its answers in
// build/bless/<fixture>.jsonl instead of comparing them, then writes each fixture that recorded any. Inputs are kept
// as they are. Review the changes it prints (and `git diff test/fixtures`) before committing them with the code.
//
//   npm run fixtures:bless
//
// A fixture is written one case per line (see `layout`), so a diff shows the cases that changed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'build', 'bless');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const SHOWN = 20;

fs.rmSync(OUT, { recursive: true, force: true });
const run = spawnSync('gleam', ['test'], {
  cwd: ROOT,
  env: { ...process.env, SCOUTBOX_BLESS: '1' },
  encoding: 'utf8',
  maxBuffer: 1 << 30,
});
if (run.status !== 0) {
  // Under bless a fixture check never fails, so this is some other test (or a crash before it recorded).
  console.error(`${run.stdout.slice(-4000)}${run.stderr.slice(-2000)}`);
  console.error('bless: `gleam test` failed under bless, above; blessing what was recorded');
}
const recorded = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.jsonl')) : [];
if (!recorded.length) {
  console.error('bless: no fixture test recorded any answers');
  process.exit(1);
}

const get = (data, at) => at.reduce((v, k) => (v == null ? undefined : v[k]), data);
const set = (data, at, value) => {
  const parent = get(data, at.slice(0, -1));
  parent[at.at(-1)] = value;
};
const same = (a, b) => isDeepStrictEqual(normal(a), normal(b));
// 1 and 1.0 are one JSON number; key order is not an answer's concern here (a test that cares compares text).
const normal = (v) =>
  Array.isArray(v)
    ? v.map(normal)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, normal(v[k])]),
        )
      : v;
const show = (v) => (v === undefined ? '(nothing)' : JSON.stringify(v));

let changedTotal = 0;
for (const file of recorded.sort()) {
  const name = file.replace(/\.jsonl$/, '');
  const fixture = path.join(FIXTURES, `${name}.json`);
  const data = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const answers = fs
    .readFileSync(path.join(OUT, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // What each answer was, read before anything is written.
  const before = (a) => {
    const slot = a.table ? get(data, a.table)?.[a.key] : get(data, a.at);
    if (!a.pool) return slot;
    return Number.isInteger(slot) ? get(data, a.pool)?.[slot] : undefined;
  };
  const changes = [];
  for (const a of answers) {
    const was = before(a);
    if (!same(was, a.answer)) changes.push({ what: a.what, was, now: a.answer });
  }

  // Rebuild pools and tables from the answers alone, so nothing stale is left in them.
  const key = (at) => JSON.stringify(at);
  const pools = new Map();
  const tables = new Map();
  for (const a of answers) {
    if (a.pool && !pools.has(key(a.pool))) pools.set(key(a.pool), { at: a.pool, values: [], index: new Map() });
    if (a.table && !tables.has(key(a.table))) tables.set(key(a.table), { at: a.table, entries: {} });
  }
  const removed = [];
  for (const t of tables.values()) {
    const old = get(data, t.at);
    t.old = old && typeof old === 'object' && !Array.isArray(old) ? old : {};
  }
  for (const a of answers) {
    let value = a.answer;
    if (a.pool) {
      const p = pools.get(key(a.pool));
      const k = JSON.stringify(value);
      if (!p.index.has(k)) {
        p.index.set(k, p.values.length);
        p.values.push(value);
      }
      value = p.index.get(k);
    }
    if (a.table) tables.get(key(a.table)).entries[a.key] = value;
    else set(data, a.at, value);
  }
  for (const t of tables.values()) {
    for (const k of Object.keys(t.old)) if (!(k in t.entries)) removed.push(k);
    set(data, t.at, t.entries);
  }
  for (const p of pools.values()) set(data, p.at, p.values);

  fs.writeFileSync(fixture, layout(data));
  changedTotal += changes.length + removed.length;
  const summary = `${name}: ${answers.length} answers, ${changes.length} changed${removed.length ? `, ${removed.length} inputs gone` : ''}`;
  console.log(summary);
  for (const c of changes.slice(0, SHOWN)) console.log(`  ${c.what}\n    was ${show(c.was)}\n    now ${show(c.now)}`);
  if (changes.length > SHOWN) console.log(`  … and ${changes.length - SHOWN} more`);
  for (const k of removed.slice(0, SHOWN)) console.log(`  gone: ${k}`);
  if (removed.length > SHOWN) console.log(`  … and ${removed.length - SHOWN} more gone`);
}
console.log(
  changedTotal ? 'bless: review the changes above, then commit them with the code' : 'bless: no answer changed',
);

/**
 * One case per line: a top-level list has one element per line; a top-level object has one key per line, and a
 * list or object under it has one element or key per line. Everything deeper stays on its line.
 */
function layout(data) {
  const inner = (v) =>
    Array.isArray(v)
      ? v.length
        ? `[\n${v.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n]`
        : '[]'
      : v && typeof v === 'object'
        ? Object.keys(v).length
          ? `{\n${Object.entries(v)
              .map(([k, x]) => `  ${JSON.stringify(k)}: ${JSON.stringify(x)}`)
              .join(',\n')}\n}`
          : '{}'
        : JSON.stringify(v);
  if (Array.isArray(data)) return `${inner(data)}\n`;
  const nested = (v) => inner(v).replaceAll('\n', '\n  ');
  return `{\n${Object.entries(data)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${nested(v)}`)
    .join(',\n')}\n}\n`;
}
