// Proves the Gleam rules against the calls the TypeScript rules suites made to the TypeScript rules
// (scripts/rules/<domain>/<battery>.mjs in the TypeScript server: a battery's checks of the rules themselves, moved
// out of the battery), and reports what each battery's recorded calls still need.
//
// The calls are frozen in dev/battery_cases/recordings.json.gz, so this needs no TypeScript tree. They were recorded
// by running each suite twice under dev/battery_cases/preload.mjs with the clock standing still, at CLOCK and then
// over a year later: a call whose result changed between the two (`moved`) depends on the clock, and is a case only
// for a Gleam rule that takes `now`. Of the rest, a call whose arguments and result are plain data is a case; any
// other call (a closure, a class instance, a stateful engine) has to be ported by hand, and is listed.
//
//   node dev/battery_cases.mjs           write dev/battery_cases/report.json and the generated tests
//                                        (test/scoutbox/battery/, from the mapping in dev/battery_cases/map.mjs)
//   node dev/battery_cases.mjs --check   exit 1 if the committed report or a generated test differs from what the
//                                        recordings generate
//   node dev/battery_cases.mjs --record  record the suites again from the TypeScript server (../../scoutbox/
//                                        scoutbox-server, or SCOUTBOX_TS_SERVER) and rewrite the recordings first;
//                                        with --check, exit 1 if a fresh recording differs from the frozen one
//
// A recording run's raw output goes to build/battery_cases/ (not committed).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { existing, generate, unprintable } from './battery_cases/generate.mjs';
import { MAP, NO_COUNTERPART, RANDOM } from './battery_cases/map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT_DIR = path.join(ROOT, 'build', 'battery_cases');
const REPORT = path.join(HERE, 'battery_cases', 'report.json');
const RECORDINGS = path.join(HERE, 'battery_cases', 'recordings.json.gz');
const PRELOAD = pathToFileURL(path.join(HERE, 'battery_cases', 'preload.mjs')).href;
/** The instant the clock stands at while a suite is recorded; generated tests pass it as `now`. */
export const CLOCK = Date.UTC(2026, 10, 15, 12, 0, 0);
/** How far the second run moves the clock: over a year, so birthdays, seasons and expiries all move. */
const SHIFT_MS = 400 * 86_400_000 + 7 * 3_600_000;

const CHECK = process.argv.includes('--check');
const RECORD = process.argv.includes('--record');

// ------------------------------------------------------------------------------------------------- recording

/** One run of a suite's file, recorded; the calls it made, in order. */
function run(tsServer, battery, shift) {
  const out = path.join(OUT_DIR, `${battery.replaceAll('/', '__')}${shift ? '.shifted' : ''}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(out, { force: true });
  const proc = spawnSync(process.execPath, ['--import', PRELOAD, path.join(tsServer, 'scripts', 'rules', `${battery}.mjs`)], {
    cwd: tsServer,
    env: {
      ...process.env,
      BATTERY_CASES_SERVER: tsServer,
      BATTERY_CASES_OUT: out,
      BATTERY_CASES_CLOCK: String(CLOCK + shift),
    },
    encoding: 'utf8',
  });
  if (proc.status !== 0 || !fs.existsSync(out))
    throw new Error(`${battery}: the rules suite failed under the recorder${shift ? ' (clock moved)' : ''}:\n${proc.stderr || proc.stdout}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

/**
 * A suite recorded at CLOCK and with the clock moved: the first run's calls, each marked `moved` when the same call
 * with the clock moved answered otherwise. A call the recorder can't print (`why`) never becomes a case, so it keeps
 * no assertion.
 */
function recordSuite(tsServer, battery) {
  const first = run(tsServer, battery, 0);
  const later = run(tsServer, battery, SHIFT_MS);
  const aligned = first.length === later.length && first.every((c, i) => c.module === later[i].module && c.name === later[i].name);
  const laterByArgs = new Map(later.filter((c) => c.args).map((c) => [`${c.module}#${c.name}${c.args}`, c]));
  const same = (a, b) => a.args === b.args && a.result === b.result && a.throws === b.throws && a.argsAfter === b.argsAfter;
  return first.map((c, i) => {
    if (c.why) {
      const { assertion: _, ...rest } = c;
      return rest;
    }
    // The same call with the clock moved: by position when both runs made the same calls, else by its arguments.
    const twin = aligned ? later[i] : laterByArgs.get(`${c.module}#${c.name}${c.args}`);
    return twin && twin.args === c.args && !same(c, twin) ? { ...c, moved: true } : c;
  });
}

/** Every suite the TypeScript server has, recorded: `{ battery: calls }`. */
async function recordAll() {
  const tsServer = path.resolve(process.env.SCOUTBOX_TS_SERVER ?? path.join(ROOT, '..', '..', 'scoutbox', 'scoutbox-server'));
  const rulesDir = path.join(tsServer, 'scripts', 'rules');
  if (!fs.existsSync(rulesDir)) throw new Error(`no TypeScript rules suites at ${rulesDir}`);
  const { TYPESCRIPT_ONLY } = await import(pathToFileURL(path.join(tsServer, 'scripts', 'e2eBoundary.mjs')).href);
  const suites = fs
    .readdirSync(rulesDir, { recursive: true })
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4).split(path.sep).join('/'))
    .filter((b) => !TYPESCRIPT_ONLY.includes(b))
    .sort();
  return Object.fromEntries(suites.map((b) => [b, recordSuite(tsServer, b)]));
}

/** The recordings as stored: per suite, each distinct call once (`pool`) and the order the suite made them in. */
function freeze(recorded) {
  const suites = {};
  for (const [battery, calls] of Object.entries(recorded)) {
    const pool = [];
    const index = new Map();
    const order = calls.map((c) => {
      const key = JSON.stringify(c);
      if (!index.has(key)) {
        index.set(key, pool.length);
        pool.push(c);
      }
      return index.get(key);
    });
    suites[battery] = { pool, order };
  }
  return zlib.gzipSync(JSON.stringify({ clock: CLOCK, shift: SHIFT_MS, suites }), { level: 9 });
}

/** The frozen recordings: `{ battery: calls }`. */
function thaw(bytes) {
  const frozen = JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
  if (frozen.clock !== CLOCK || frozen.shift !== SHIFT_MS)
    throw new Error('dev/battery_cases/recordings.json.gz was recorded at another clock; run node dev/battery_cases.mjs --record');
  return Object.fromEntries(Object.entries(frozen.suites).map(([b, s]) => [b, s.order.map((i) => s.pool[i])]));
}

let recordings;
if (RECORD) {
  const fresh = freeze(await recordAll());
  if (CHECK) {
    const committed = fs.existsSync(RECORDINGS) ? fs.readFileSync(RECORDINGS) : Buffer.alloc(0);
    if (!committed.equals(fresh)) {
      console.error('battery_cases: dev/battery_cases/recordings.json.gz differs from a fresh recording; run node dev/battery_cases.mjs --record');
      process.exit(1);
    }
  } else fs.writeFileSync(RECORDINGS, fresh);
  recordings = thaw(fresh);
} else recordings = thaw(fs.readFileSync(RECORDINGS));

// ---------------------------------------------------------------------------------------------------- report

/** A reason without its positions, so the same kind of argument counts once: `args[1].evidence is a function`. */
const reason = (why) => why.replace(/\[\d+\]/g, '[]');

/** One battery's report: every function its suite calls, and what each call is; and its calls that are cases. */
function report(battery, calls) {
  const fns = new Map();
  const cases = [];
  for (const c of calls) {
    const id = `${c.module}#${c.name}`;
    if (!fns.has(id)) fns.set(id, { function: id, calls: 0, cases: new Set(), handPort: {} });
    const f = fns.get(id);
    f.calls += 1;
    let why = c.why ? reason(c.why) : RANDOM.includes(id) ? 'its result is random' : null;
    const clockDependent = !why && !!c.moved;
    // A rule that takes `now` in Gleam is given the instant the recording stood at.
    if (clockDependent && !MAP[id]?.now) why = 'its result depends on the clock';
    if (!why) why = unprintable(id, c, CLOCK);
    if (why) f.handPort[why] = (f.handPort[why] ?? 0) + 1;
    else {
      f.cases.add(JSON.stringify([c.args, c.result ?? null, c.throws ?? null, c.argsAfter ?? null]));
      cases.push({ battery, fn: id, call: c, clockDependent });
    }
  }
  return {
    report: {
      battery,
      functions: [...fns.values()]
        .sort((a, b) => a.function.localeCompare(b.function))
        .map((f) => ({
          function: f.function,
          calls: f.calls,
          cases: f.cases.size,
          handPort: Object.fromEntries(Object.entries(f.handPort).sort(([a], [b]) => a.localeCompare(b))),
          status: MAP[f.function] ? 'generated' : NO_COUNTERPART[f.function] ? 'closed' : 'pending',
        })),
    },
    cases,
  };
}

const results = Object.keys(recordings)
  .sort()
  .map((b) => report(b, recordings[b]));
const text = `${JSON.stringify(
  results.map((r) => r.report),
  null,
  2,
)}\n`;
const generated = generate(
  results.flatMap((r) => r.cases),
  CLOCK,
);
const stale = existing().filter((f) => !generated.has(f));
if (CHECK) {
  const problems = [];
  const committed = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '';
  if (committed !== text) problems.push('dev/battery_cases/report.json differs from what the recordings generate');
  for (const [file, source] of generated)
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source)
      problems.push(`${path.relative(ROOT, file)} differs from what the recordings generate`);
  for (const file of stale) problems.push(`${path.relative(ROOT, file)} is no longer generated`);
  for (const p of problems) console.error(`battery_cases: ${p}; run node dev/battery_cases.mjs`);
  process.exit(problems.length ? 1 : 0);
}
fs.writeFileSync(REPORT, text);
for (const [file, source] of generated) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}
for (const file of stale) fs.rmSync(file);
for (const r of results.map((x) => x.report)) {
  const count = (status) => r.functions.filter((f) => f.status === status).reduce((n, f) => n + f.cases, 0);
  const hand = r.functions.reduce((n, f) => n + Object.values(f.handPort).reduce((a, b) => a + b, 0), 0);
  console.log(
    `battery_cases: ${r.battery}: ${r.functions.length} functions, ${count('generated')} cases generated, ${count('pending')} pending, ${count('closed')} closed, ${hand} calls to port by hand`,
  );
}
