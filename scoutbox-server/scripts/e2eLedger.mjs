// Where every battery's checks went. Untangling a battery moves checks out of it (into its rules suite,
// scripts/rules/<domain>/<battery>.mjs, or into a unit suite when they test this implementation) and rewrites others,
// and none may be lost on the way. So each battery's checks are counted against the battery as it stood before any
// check moved (BASELINE_REV, frozen in e2eLedger.baseline.json):
//
//   baseline = checks left in the battery + checks in its rules suite + checks moved elsewhere − checks added
//
// where the moves elsewhere and the additions are written down by hand in NOTES, each with its reason. testE2ESupport
// fails when a battery doesn't reconcile. A check is a call of `ok`, `neg`, or a one-line helper built on them
// (`const G = (n, cond, msg) => ok(…)`), counted where it is written, not how often it runs.
//
// The ledger itself (one row per battery, and what a port has made of it) is written by the port: the Gleam
// repository's dev/ledger.mjs reads ledgerRows() from here, so this server never reads the port.
//
//   node scripts/e2eLedger.mjs              print each battery's accounting
//   node scripts/e2eLedger.mjs --baseline   rewrite e2eLedger.baseline.json from BASELINE_REV (only ever once)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPESCRIPT_ONLY, NOT_YET_NEUTRAL } from './e2eBoundary.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(SCRIPTS, '..');
const E2E_DIR = path.join(SERVER_DIR, 'e2e');
const RULES_DIR = path.join(SCRIPTS, 'rules');
const BASELINE_FILE = path.join(SCRIPTS, 'e2eLedger.baseline.json');

/** The last commit before any check moved out of a battery: after the launcher codemod, which moved none. */
export const BASELINE_REV = '3c843bb2';

/**
 * Checks that left a battery for somewhere other than its rules suite, and checks an untangling added, by battery.
 * `moved`: `{ checks, to, why }`, `to` the file they went to (a unit suite: they test this implementation).
 * `added`: `{ checks, why }`, checks the battery or its rules suite has that the baseline didn't.
 */
export const NOTES = {
  'platform/sessionsAndPorts': {
    moved: [
      {
        checks: 3,
        to: 'scripts/testPlatformHelpers.mjs',
        why: "A1–A3 built their own Express app in the battery's process to prove installAsyncErrorForwarding; that is a unit check of the patch. The battery keeps A4–A5 over HTTP",
      },
    ],
  },
  'platform/storeGuarantees': {
    moved: [
      {
        checks: 1,
        to: 'scripts/testDataLayer.mjs',
        why: "COUNTER_MISSING was checked by calling the repository's createIdCounter on a damaged file; that is a unit check of the repository",
      },
    ],
    added: [
      {
        checks: 1,
        why: 'the battery keeps COUNTER_MISSING over HTTP: the server refuses to start without its counter row',
      },
      {
        checks: 1,
        why: 'a first boot on an empty directory now has its own check, as part 1 boots a server instead of opening the store',
      },
      {
        checks: 1,
        why: 'the plan count is checked in both: the rules suite over the catalogue, the battery over /meta',
      },
    ],
  },
};

// ------------------------------------------------------------------------------------------------ counting

/** `text` without its comments, keeping line breaks. A `//` inside a string (a URL) is kept. */
function uncommented(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

/** The body of the arrow function or function whose definition starts at `from`: a balanced block, or one line. */
function bodyAt(text, from) {
  const arrow = text.indexOf('=>', from);
  const brace = text.indexOf('{', from);
  const start = arrow >= 0 && (brace < 0 || arrow < brace) ? arrow + 2 : brace;
  let i = start;
  while (/\s/.test(text[i])) i++;
  if (text[i] !== '{') return text.slice(i, text.indexOf('\n', i) >>> 0);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return text.slice(i);
}

const calls = (text, name) => [...text.matchAll(new RegExp(`(?<![\\w$.]|function\\s)${name}\\s*\\(`, 'g'))].length;

/** The checks written in a battery or rules suite: calls of `ok`, `neg` and the one-line helpers built on them. */
export function checkCount(source) {
  const text = uncommented(source);
  const helpers = new Set(['ok', 'neg']);
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*(?:ok|neg)\(/g)) helpers.add(m[1]);
  let count = 0;
  for (const h of helpers) count += calls(text, h);
  // The helpers' own definitions call the others (`neg` calls `ok`); those calls aren't checks.
  for (const m of text.matchAll(/\b(?:const|let|function)\s+([A-Za-z_$][\w$]*)\b/g)) {
    if (!helpers.has(m[1])) continue;
    const body = bodyAt(text, m.index);
    for (const h of helpers) count -= calls(body, h);
  }
  return count;
}

/** The server's modules a file under e2e/ imports: every import specifier that resolves outside e2e/. */
export function serverImports(source, file) {
  const out = new Set();
  const dir = path.dirname(path.join(E2E_DIR, file));
  for (const m of uncommented(source).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"`]([^'"`]+)['"`]/g)) {
    if (!m[1].startsWith('.')) continue;
    const rel = path.relative(E2E_DIR, path.resolve(dir, m[1])).split(path.sep).join('/');
    if (rel.startsWith('../')) out.add(rel.slice(3));
  }
  return [...out].sort();
}

// ------------------------------------------------------------------------------------------------ the rows

const batteryFiles = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4).split(path.sep).join('/'))
    .filter((f) => !f.startsWith('support/'))
    .sort();

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function baseline() {
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
}

/**
 * One row per battery, as it stood at the baseline or stands now (a battery moved whole into its rules suite is
 * still a row): `{ battery, domain, inE2E, boundary, modules: { baseline, now }, checks: { baseline, battery, rules, moved,
 * added }, rulesSuite, reconciled }`. `boundary` is 'neutral', 'not yet neutral' or 'TypeScript only'.
 */
export function ledgerRows() {
  const base = baseline().batteries;
  const now = batteryFiles(E2E_DIR);
  const suites = fs.existsSync(RULES_DIR) ? batteryFiles(RULES_DIR) : [];
  const names = [...new Set([...Object.keys(base), ...now, ...suites])].sort();
  return names.map((battery) => {
    const text = read(path.join(E2E_DIR, `${battery}.mjs`));
    const suite = read(path.join(RULES_DIR, `${battery}.mjs`));
    const notes = NOTES[battery] ?? {};
    const moved = notes.moved ?? [];
    const added = notes.added ?? [];
    const checks = {
      baseline: base[battery]?.checks ?? 0,
      battery: text === null ? 0 : checkCount(text),
      rules: suite === null ? 0 : checkCount(suite),
      moved,
      added,
    };
    const sum = (xs) => xs.reduce((n, x) => n + x.checks, 0);
    return {
      battery,
      domain: battery.split('/')[0],
      inE2E: text !== null,
      boundary: TYPESCRIPT_ONLY.includes(battery)
        ? 'TypeScript only'
        : NOT_YET_NEUTRAL.includes(battery)
          ? 'not yet neutral'
          : 'neutral',
      modules: {
        baseline: base[battery]?.modules.length ?? 0,
        now: text === null ? 0 : serverImports(text, `${battery}.mjs`).length,
      },
      checks,
      rulesSuite: suite === null ? null : `scripts/rules/${battery}.mjs`,
      reconciled: checks.baseline === checks.battery + checks.rules + sum(moved) - sum(added),
    };
  });
}

/** Every battery whose checks don't reconcile, and every note that names something missing, as messages. */
export function ledgerProblems() {
  const rows = ledgerRows();
  const out = [];
  for (const r of rows.filter((x) => !x.reconciled && x.boundary !== 'TypeScript only')) {
    const c = r.checks;
    out.push(
      `${r.battery}: ${c.baseline} checks at ${BASELINE_REV}, now ${c.battery} in the battery + ${c.rules} in its rules suite; account for the difference in NOTES (scripts/e2eLedger.mjs)`,
    );
  }
  for (const [battery, notes] of Object.entries(NOTES)) {
    if (!rows.some((r) => r.battery === battery)) out.push(`NOTES names ${battery}, which is not a battery`);
    for (const m of notes.moved ?? [])
      if (!fs.existsSync(path.join(SERVER_DIR, m.to)))
        out.push(`NOTES moves ${battery}'s checks to ${m.to}, which doesn't exist`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the CLI

function writeBaseline() {
  const git = (...args) => execFileSync('git', args, { cwd: SERVER_DIR, encoding: 'utf8', maxBuffer: 1 << 28 });
  const files = git('ls-tree', '-r', '--name-only', BASELINE_REV, '--', 'e2e')
    .split('\n')
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('e2e/support/'));
  const batteries = {};
  for (const f of files) {
    const source = git('show', `${BASELINE_REV}:scoutbox-server/${f}`);
    const rel = f.slice('e2e/'.length);
    batteries[rel.slice(0, -4)] = { checks: checkCount(source), modules: serverImports(source, rel) };
  }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ rev: BASELINE_REV, batteries }, null, 2)}\n`);
  console.log(
    `e2eLedger: wrote ${path.relative(SERVER_DIR, BASELINE_FILE)} from ${BASELINE_REV} (${files.length} batteries)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--baseline')) writeBaseline();
  else {
    for (const r of ledgerRows()) {
      const c = r.checks;
      console.log(
        `${r.reconciled ? ' ' : '✗'} ${r.battery.padEnd(48)} ${r.boundary.padEnd(16)} modules ${String(r.modules.baseline).padStart(2)} → ${String(r.modules.now).padStart(2)}   checks ${String(c.baseline).padStart(3)} → ${String(c.battery).padStart(3)} + ${String(c.rules).padStart(3)} rules`,
      );
    }
    const problems = ledgerProblems();
    for (const p of problems) console.error(`e2eLedger: ${p}`);
    process.exitCode = problems.length ? 1 : 0;
  }
}
