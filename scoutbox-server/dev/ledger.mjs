// Writes LEDGER.md: one row per TypeScript battery, saying where its checks went and what this port has made of each
// part, and which domains are ported. It is generated from:
//
//   - the TypeScript server's scripts/e2eLedger.mjs: each battery's boundary status, the server modules it imported
//     before untangling and imports now, and its checks counted then and now, with the hand-written notes on checks
//     that moved elsewhere (that server checks they reconcile);
//   - e2e/batteries.mjs: the batteries this server answers;
//   - dev/battery_cases/report.json: each battery's recorded rule calls, as generated cases, pending cases and calls
//     to port by hand; and dev/battery_cases/map.mjs's HAND_PORTED, where those were ported;
//   - ACCEPTED below: a reviewer's verdict on each check moved to a TypeScript unit suite: where this port covers
//     it, or why it needs nothing here.
//
//   node dev/ledger.mjs           write LEDGER.md
//   node dev/ledger.mjs --check   exit 1 if LEDGER.md differs from what the sources give, or a source is inconsistent
//
// The TypeScript server is found at ../../scoutbox/scoutbox-server, or at SCOUTBOX_TS_SERVER.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HAND_PORTED, MAP, NO_COUNTERPART } from './battery_cases/map.mjs';
import { BATTERIES } from '../e2e/batteries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TS_SERVER = path.resolve(
  process.env.SCOUTBOX_TS_SERVER ?? path.join(ROOT, '..', '..', 'scoutbox', 'scoutbox-server'),
);
const LEDGER = path.join(ROOT, 'LEDGER.md');
const REPORT = path.join(HERE, 'battery_cases', 'report.json');

/**
 * The reviewed checks moved out of a battery into a TypeScript unit suite (the server's NOTES), keyed
 * `<battery> → <file>`: `{ gleam: '<test file>' }` where a Gleam unit test checks the same thing, or
 * `{ none: '<why>' }` where it tests something this server doesn't have.
 */
const ACCEPTED = {
  'platform/storeGuarantees → scripts/testDataLayer.mjs': { gleam: 'test/scoutbox/ids_test.gleam' },
  // The runner's order, idempotence, single records and rollback of a failing migration, and the latest id alone
  // not counting as up to date.
  'platform/contracts → scripts/testDataLayer.mjs': { gleam: 'test/scoutbox/migrations_test.gleam' },
  // Parsing, refusals, production inertness and how rules count. The production boot's refusal of SCOUTBOX_FAULTS
  // stays in the battery (§43).
  'platform/contracts → scripts/testPlatformHelpers.mjs': { gleam: 'test/scoutbox/faults_test.gleam' },
  'platform/contracts → scripts/testDiscovery.mjs': {
    none: "These test the TypeScript discovery repository's own typing (typeBrief, typeSecondLookItem) and its DDL text. This server has no such layer: its tables are the TypeScript migrations verbatim (migrations:check), and the two facts the battery depends on stay in it as schema checks (§11b).",
  },
  'recruitment/trialsPersistence → scripts/testRecruitment.mjs': {
    none: "These test the TypeScript recruitment repository's writing of its own record shapes (the legacy trial's neutral containers, a workflow trial stored as written, the fixture left untouched) and its refusal of entries that have no row form. This server has no record-shaped writer: its fixtures are the tables' rows, which the battery writes and reads back column for column, and the schema's refusals stay in the battery as plain-SQL writes (§3c).",
  },
  'platform/sessionsAndPorts → scripts/testPlatformHelpers.mjs': {
    none: "These test installAsyncErrorForwarding, a patch to Express's async handlers. This server has no Express; a crashing handler is a 500 by router.rescue, and the battery keeps the outcome over HTTP (A4–A5).",
  },
};

const { ledgerRows, BASELINE_REV } = await import(pathToFileURL(path.join(TS_SERVER, 'scripts', 'e2eLedger.mjs')).href);
const rows = ledgerRows();
const report = new Map(JSON.parse(fs.readFileSync(REPORT, 'utf8')).map((r) => [r.battery, r.functions]));

const problems = [];
for (const b of BATTERIES) if (!rows.some((r) => r.battery === b)) problems.push(`e2e/batteries.mjs lists ${b}, which the TypeScript server has no row for`);
const handPortCalls = (f) => Object.values(f.handPort).reduce((a, b) => a + b, 0);
for (const [fn, file] of Object.entries(HAND_PORTED)) {
  if (!fs.existsSync(path.join(ROOT, file))) problems.push(`HAND_PORTED puts ${fn} in ${file}, which doesn't exist`);
  const recorded = [...report.values()].flat().filter((f) => f.function === fn);
  if (!recorded.some((f) => handPortCalls(f) > 0)) problems.push(`HAND_PORTED lists ${fn}, which has no calls to port by hand`);
}
for (const fn of Object.keys(NO_COUNTERPART)) {
  if (MAP[fn]) problems.push(`NO_COUNTERPART lists ${fn}, which MAP maps`);
  if (![...report.values()].flat().some((f) => f.function === fn)) problems.push(`NO_COUNTERPART lists ${fn}, which no suite calls`);
}
for (const [key, verdict] of Object.entries(ACCEPTED)) {
  if (verdict.gleam && !fs.existsSync(path.join(ROOT, verdict.gleam)))
    problems.push(`ACCEPTED puts ${key} in ${verdict.gleam}, which doesn't exist`);
  if (!verdict.gleam === !verdict.none) problems.push(`ACCEPTED ${key} needs either a Gleam test or a reason for none`);
  if (!rows.some((r) => r.checks.moved.some((m) => `${r.battery} → ${m.to}` === key)))
    problems.push(`ACCEPTED names ${key}, which no battery's notes move checks to`);
}

/** What this port has made of one battery. */
function gleamSide(r) {
  const fns = report.get(r.battery) ?? [];
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const hand = fns.filter((f) => handPortCalls(f) > 0);
  return {
    answered: BATTERIES.includes(r.battery),
    generated: sum(fns.filter((f) => f.status === 'generated'), (f) => f.cases),
    pending: sum(fns.filter((f) => f.status === 'pending'), (f) => f.cases),
    pendingFns: fns.filter((f) => f.status === 'pending' && f.cases > 0),
    closedFns: fns.filter((f) => f.status === 'closed' && f.cases > 0),
    hand,
    handDone: sum(hand.filter((f) => HAND_PORTED[f.function]), handPortCalls),
    handAll: sum(hand, handPortCalls),
    moved: r.checks.moved.map((m) => ({ ...m, accepted: ACCEPTED[`${r.battery} → ${m.to}`] ?? null })),
    recorded: report.has(r.battery),
  };
}

const rowsWith = rows.map((r) => ({ ...r, gleam: gleamSide(r) }));

/** Whether a battery is done on this side, and if not, what is missing. */
function missing(r) {
  if (r.boundary === 'TypeScript only') return [];
  const g = r.gleam;
  const out = [];
  if (r.boundary === 'not yet neutral') out.push('not untangled');
  if (r.inE2E && !g.answered) out.push('not answered');
  if (r.rulesSuite && !g.recorded) out.push('rules suite not recorded');
  if (g.pending) out.push(`${g.pending} cases pending`);
  if (g.handDone < g.handAll) out.push(`${g.handAll - g.handDone} hand-port calls`);
  const unaccepted = g.moved.filter((m) => !m.accepted).length;
  if (unaccepted) out.push(`${unaccepted} TypeScript-only move${unaccepted > 1 ? 's' : ''} unreviewed`);
  return out;
}

// ------------------------------------------------------------------------------------------------ the document

const domains = [...new Set(rowsWith.map((r) => r.domain))].sort();
const cell = (s) => String(s).replaceAll('|', '\\|');
const table = (head, body) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

const domainRows = domains.map((d) => {
  const rs = rowsWith.filter((r) => r.domain === d && r.boundary !== 'TypeScript only');
  const todo = rs.filter((r) => missing(r).length);
  const n = (f) => rs.reduce((a, r) => a + f(r), 0);
  return [
    d,
    rs.length,
    rs.filter((r) => r.boundary !== 'not yet neutral').length,
    rs.filter((r) => r.gleam.answered).length,
    `${n((r) => r.gleam.generated)} / ${n((r) => r.gleam.pending)}`,
    `${n((r) => r.gleam.handDone)} / ${n((r) => r.gleam.handAll)}`,
    rs.length && !todo.length ? '**ported**' : `${todo.length} to go`,
  ];
});

const batteryRows = rowsWith.map((r) => {
  const c = r.checks;
  const g = r.gleam;
  const moved = c.moved.reduce((n, m) => n + m.checks, 0);
  const added = c.added.reduce((n, m) => n + m.checks, 0);
  const left = missing(r);
  return [
    `\`${r.battery}\``,
    r.boundary,
    `${r.modules.baseline} → ${r.modules.now}`,
    c.baseline,
    r.inE2E ? c.battery : '(moved whole)',
    c.rules || '',
    [moved && `${moved} moved`, added && `+${added} added`].filter(Boolean).join(', '),
    r.boundary === 'TypeScript only' ? '' : g.answered ? 'yes' : '',
    r.rulesSuite ? `${g.generated} / ${g.pending}` : '',
    g.handAll ? `${g.handDone} / ${g.handAll}` : '',
    r.boundary === 'TypeScript only' ? 'TypeScript only' : left.length ? left.join('; ') : '**done**',
  ];
});

const movedRows = rowsWith.flatMap((r) =>
  r.gleam.moved.map((m) => [`\`${r.battery}\``, m.checks, `\`${m.to}\``, m.why, m.accepted ? (m.accepted.gleam ? `\`${m.accepted.gleam}\`` : `none: ${m.accepted.none}`) : 'not yet reviewed']),
);
const addedRows = rowsWith.flatMap((r) => r.checks.added.map((a) => [`\`${r.battery}\``, a.checks, a.why]));

const handRows = [];
for (const r of rowsWith)
  for (const f of r.gleam.hand)
    handRows.push([
      `\`${r.battery}\``,
      `\`${f.function}\``,
      handPortCalls(f),
      Object.keys(f.handPort).join('; '),
      HAND_PORTED[f.function] ? `\`${HAND_PORTED[f.function]}\`` : 'to do',
    ]);

const pendingRows = rowsWith.flatMap((r) =>
  r.gleam.pendingFns.map((f) => [`\`${r.battery}\``, `\`${f.function}\``, f.cases]),
);

const closedRows = rowsWith.flatMap((r) =>
  r.gleam.closedFns.map((f) => [`\`${r.battery}\``, `\`${f.function}\``, f.cases, NO_COUNTERPART[f.function]]),
);

const doc = `# Battery ledger

Generated by \`dev/ledger.mjs\`; don't edit it. Run \`node dev/ledger.mjs\` after changing a battery, a rules suite,
the mapping or \`e2e/batteries.mjs\`, and \`npm run e2e:check\` fails while it is stale.

Every TypeScript battery has a row, saying where its checks went and what this server has made of each part. Checks
are counted where they are written (calls of \`ok\`, \`neg\` and helpers built on them), against the battery at
\`${BASELINE_REV}\`, before any moved: the TypeScript server fails its own tests unless baseline = battery + rules
suite + moved − added.

**A domain is ported when** every battery in it is untangled and answered here (\`e2e:check\` keeps the copies
unchanged; \`npm run e2e\` shows they pass), its rules suites' recorded calls all have generated tests (or are closed, with a reason, as having no Gleam counterpart), every
hand-port call has its Gleam test, and every check moved to a TypeScript unit suite has a reviewer's verdict.
The three Box Cam analysis batteries are TypeScript only for good and don't count.

## Domains

${table(['Domain', 'Batteries', 'Untangled', 'Answered', 'Cases generated / pending', 'Hand-port done / calls', 'Status'], domainRows)}

## Batteries

Modules: the TypeScript server's modules the battery imported at \`${BASELINE_REV}\` and imports now. Cases: the
distinct recorded calls of its rules suite, generated as Gleam tests or still pending a mapping.

${table(['Battery', 'Boundary', 'Modules', 'Checks then', 'Battery', 'Rules suite', 'Elsewhere', 'Answered', 'Cases', 'Hand-port', 'Left'], batteryRows)}

## Checks moved to TypeScript unit suites

They test the TypeScript implementation rather than its behaviour over HTTP. A reviewer decides where this server
covers each one: a Gleam unit test of its own counterpart, or nothing, with the reason.

${movedRows.length ? table(['Battery', 'Checks', 'Now in', 'Why', 'Here'], movedRows) : 'None.'}

## Checks added while untangling

${addedRows.length ? table(['Battery', 'Checks', 'Why'], addedRows) : 'None.'}

## Calls to port by hand

Recorded calls whose arguments or results aren't plain data (closures, stateful stores): each function's checks are
ported by hand to a gleeunit test.

${handRows.length ? table(['Battery', 'Function', 'Calls', 'Why', 'Ported in'], handRows) : 'None.'}

## Cases pending a mapping

Rules the suites call that have no entry in \`dev/battery_cases/map.mjs\` yet: each needs its Gleam rule ported and
mapped, then \`npm run cases\`.

${pendingRows.length ? table(['Battery', 'Function', 'Cases'], pendingRows) : 'None.'}

## Cases closed: no Gleam counterpart

Rules \`NO_COUNTERPART\` in \`dev/battery_cases/map.mjs\` closes with a reason: this server has nothing that plays
their role, so their recorded calls get no test.

${closedRows.length ? table(['Battery', 'Function', 'Cases', 'Why'], closedRows) : 'None.'}
`;

if (process.argv.includes('--check')) {
  const committed = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '';
  if (committed !== doc) problems.push('LEDGER.md differs from what the sources give; run node dev/ledger.mjs');
  for (const p of problems) console.error(`ledger: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
for (const p of problems) console.error(`ledger: ${p}`);
fs.writeFileSync(LEDGER, doc);
const ported = domainRows.filter((d) => d[6] === '**ported**').map((d) => d[0]);
console.log(`ledger: wrote LEDGER.md (${rows.length} batteries; ported: ${ported.join(', ') || 'none'})`);
process.exitCode = problems.length ? 1 : 0;
