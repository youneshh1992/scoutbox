// Writes LEDGER.md: one row per TypeScript battery, saying where its checks went and what this port has made of each
// part, and which domains are ported. It is generated from:
//
//   - the TypeScript server's scripts/e2eLedger.mjs: each battery's boundary status, the server modules it imported
//     before untangling and imports now, and its checks counted then and now, with the hand-written notes on checks
//     that moved elsewhere (that server checks they reconcile);
//   - e2e/batteries.mjs: the batteries this server answers;
//   - dev/battery_cases/report.json: each battery's recorded rule calls, as generated cases, pending cases and calls
//     to port by hand; and dev/battery_cases/map.mjs's HAND_PORTED, where those were ported;
//   - ACCEPTED below: the checks moved to a TypeScript unit suite that a reviewer has agreed need no Gleam
//     counterpart.
//
//   node dev/ledger.mjs           write LEDGER.md
//   node dev/ledger.mjs --check   exit 1 if LEDGER.md differs from what the sources give, or a source is inconsistent
//
// The TypeScript server is found at ../../scoutbox/scoutbox-server, or at SCOUTBOX_TS_SERVER.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HAND_PORTED } from './battery_cases/map.mjs';
import { BATTERIES } from '../e2e/batteries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TS_SERVER = path.resolve(
  process.env.SCOUTBOX_TS_SERVER ?? path.join(ROOT, '..', '..', 'scoutbox', 'scoutbox-server'),
);
const LEDGER = path.join(ROOT, 'LEDGER.md');
const REPORT = path.join(HERE, 'battery_cases', 'report.json');

/**
 * Checks moved out of a battery into a TypeScript unit suite (the server's NOTES), keyed `<battery> → <file>`, that a
 * reviewer has accepted as testing the TypeScript implementation only, with what they said.
 */
const ACCEPTED = {};

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
for (const key of Object.keys(ACCEPTED))
  if (!rows.some((r) => r.checks.moved.some((m) => `${r.battery} → ${m.to}` === key)))
    problems.push(`ACCEPTED names ${key}, which no battery's notes move checks to`);

/** What this port has made of one battery. */
function gleamSide(r) {
  const fns = report.get(r.battery) ?? [];
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const hand = fns.filter((f) => handPortCalls(f) > 0);
  return {
    answered: BATTERIES.includes(r.battery),
    generated: sum(fns.filter((f) => f.status === 'generated'), (f) => f.cases),
    pending: sum(fns.filter((f) => f.status !== 'generated'), (f) => f.cases),
    pendingFns: fns.filter((f) => f.status !== 'generated' && f.cases > 0),
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
  r.gleam.moved.map((m) => [`\`${r.battery}\``, m.checks, `\`${m.to}\``, m.why, m.accepted ?? 'not yet reviewed']),
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

const doc = `# Battery ledger

Generated by \`dev/ledger.mjs\`; don't edit it. Run \`node dev/ledger.mjs\` after changing a battery, a rules suite,
the mapping or \`e2e/batteries.mjs\`, and \`npm run e2e:check\` fails while it is stale.

Every TypeScript battery has a row, saying where its checks went and what this server has made of each part. Checks
are counted where they are written (calls of \`ok\`, \`neg\` and helpers built on them), against the battery at
\`${BASELINE_REV}\`, before any moved: the TypeScript server fails its own tests unless baseline = battery + rules
suite + moved − added.

**A domain is ported when** every battery in it is untangled and answered here (\`e2e:check\` keeps the copies
unchanged; \`npm run e2e\` shows they pass), its rules suites' recorded calls all have generated tests, every
hand-port call has its Gleam test, and every check moved to a TypeScript unit suite has a reviewer's acceptance.
The three Box Cam analysis batteries are TypeScript only for good and don't count.

## Domains

${table(['Domain', 'Batteries', 'Untangled', 'Answered', 'Cases generated / pending', 'Hand-port done / calls', 'Status'], domainRows)}

## Batteries

Modules: the TypeScript server's modules the battery imported at \`${BASELINE_REV}\` and imports now. Cases: the
distinct recorded calls of its rules suite, generated as Gleam tests or still pending a mapping.

${table(['Battery', 'Boundary', 'Modules', 'Checks then', 'Battery', 'Rules suite', 'Elsewhere', 'Answered', 'Cases', 'Hand-port', 'Left'], batteryRows)}

## Checks moved to TypeScript unit suites

They test the TypeScript implementation, so this server has nothing to port for them, once a reviewer agrees.

${movedRows.length ? table(['Battery', 'Checks', 'Now in', 'Why', 'Accepted'], movedRows) : 'None.'}

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
