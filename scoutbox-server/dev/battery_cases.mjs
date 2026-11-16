// Records the TypeScript rules suites' calls to the rules (scripts/rules/<domain>/<battery>.mjs in the TypeScript
// server: a battery's checks of the rules themselves, moved out of the battery), so the Gleam rules can be proved
// against the same cases, and reports what each battery's recorded calls still need.
//
// Each suite runs twice under dev/battery_cases/preload.mjs, the second time with the clock moved on: a call whose
// result changes with the clock is not a case. Of the rest, a call whose arguments and result are plain data is a
// case; any other call (a closure, a class instance, a stateful engine) has to be ported by hand, and is listed.
//
//   node dev/battery_cases.mjs           record, then write dev/battery_cases/report.json
//   node dev/battery_cases.mjs --check   exit 1 if the committed report differs from a fresh recording
//
// The raw recordings go to build/battery_cases/ (not committed). The TypeScript server is found at
// ../../scoutbox/scoutbox-server, or at SCOUTBOX_TS_SERVER.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TS_SERVER = path.resolve(
  process.env.SCOUTBOX_TS_SERVER ?? path.join(ROOT, '..', '..', 'scoutbox', 'scoutbox-server'),
);
const RULES_DIR = path.join(TS_SERVER, 'scripts', 'rules');
const OUT_DIR = path.join(ROOT, 'build', 'battery_cases');
const REPORT = path.join(HERE, 'battery_cases', 'report.json');
const PRELOAD = pathToFileURL(path.join(HERE, 'battery_cases', 'preload.mjs')).href;
/** How far the second run moves the clock: over a year, so birthdays, seasons and expiries all move. */
const SHIFT_MS = 400 * 86_400_000 + 7 * 3_600_000;

const { TYPESCRIPT_ONLY } = await import(pathToFileURL(path.join(TS_SERVER, 'scripts', 'e2eBoundary.mjs')).href);

const suites = fs.existsSync(RULES_DIR)
  ? fs
      .readdirSync(RULES_DIR, { recursive: true })
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => f.slice(0, -4).split(path.sep).join('/'))
      .filter((b) => !TYPESCRIPT_ONLY.includes(b))
      .sort()
  : [];

/** One run of a suite's file, recorded; the calls it made, in order. */
function record(battery, shift) {
  const out = path.join(OUT_DIR, `${battery.replaceAll('/', '__')}${shift ? '.shifted' : ''}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(out, { force: true });
  const run = spawnSync(process.execPath, ['--import', PRELOAD, path.join(RULES_DIR, `${battery}.mjs`)], {
    cwd: TS_SERVER,
    env: {
      ...process.env,
      BATTERY_CASES_SERVER: TS_SERVER,
      BATTERY_CASES_OUT: out,
      BATTERY_CASES_SHIFT: String(shift),
    },
    encoding: 'utf8',
  });
  if (run.status !== 0 || !fs.existsSync(out))
    throw new Error(`${battery}: the rules suite failed under the recorder${shift ? ' (clock moved)' : ''}:\n${run.stderr || run.stdout}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

/** A reason without its positions, so the same kind of argument counts once: `args[1].evidence is a function`. */
const reason = (why) => why.replace(/\[\d+\]/g, '[]');

/** One battery's report: every function its suite calls, and what each call is. */
function report(battery) {
  const first = record(battery, 0);
  const moved = record(battery, SHIFT_MS);
  const aligned = first.length === moved.length && first.every((c, i) => c.module === moved[i].module && c.name === moved[i].name);
  const movedByArgs = new Map(moved.filter((c) => c.args).map((c) => [`${c.module}#${c.name}${c.args}`, c]));
  const fns = new Map();
  first.forEach((c, i) => {
    const id = `${c.module}#${c.name}`;
    if (!fns.has(id)) fns.set(id, { function: id, calls: 0, cases: new Set(), handPort: {} });
    const f = fns.get(id);
    f.calls += 1;
    let why = c.why ? reason(c.why) : null;
    if (!why) {
      // The same call with the clock moved: by position when both runs made the same calls, else by its arguments.
      const twin = aligned ? moved[i] : movedByArgs.get(`${id}${c.args}`);
      const same = (a, b) => a.args === b.args && a.result === b.result && a.throws === b.throws;
      if (twin && twin.args === c.args && !same(c, twin)) why = 'its result depends on the clock';
    }
    if (why) f.handPort[why] = (f.handPort[why] ?? 0) + 1;
    else f.cases.add(JSON.stringify([c.args, c.result ?? null, c.throws ?? null]));
  });
  return {
    battery,
    functions: [...fns.values()]
      .sort((a, b) => a.function.localeCompare(b.function))
      .map((f) => ({
        function: f.function,
        calls: f.calls,
        cases: f.cases.size,
        handPort: Object.fromEntries(Object.entries(f.handPort).sort(([a], [b]) => a.localeCompare(b))),
        status: 'pending',
      })),
  };
}

const text = `${JSON.stringify(suites.map(report), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const committed = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '';
  if (committed !== text) {
    console.error('battery_cases: dev/battery_cases/report.json differs from a fresh recording; run node dev/battery_cases.mjs');
    process.exit(1);
  }
  process.exit(0);
}
fs.writeFileSync(REPORT, text);
for (const r of JSON.parse(text)) {
  const cases = r.functions.reduce((n, f) => n + f.cases, 0);
  const hand = r.functions.reduce((n, f) => n + Object.values(f.handPort).reduce((a, b) => a + b, 0), 0);
  console.log(`battery_cases: ${r.battery}: ${r.functions.length} functions, ${cases} cases pending, ${hand} calls to port by hand`);
}
