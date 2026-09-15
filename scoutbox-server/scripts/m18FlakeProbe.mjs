// M18 — targeted flake probe for the Second Look `changeCount` wobble.
//
// THE OBSERVATION
//
// `m18E2E`'s "S1: one underlying change, one item" asserts `changeCount === 1`
// after archiving a room and adding exactly one piece of evidence. It failed
// twice in roughly thirty full-battery runs and never in isolation.
//
// WHAT changeCount MEANS (established from source, not assumed)
//
//   m18/shared.mjs:428   changeCount: material.length
//   material             = dedupeMaterialChanges(changesSinceDecision(changes, decisionAt))
//   fingerprint          = `${type}:${sourceSystem}:${sourceId}`   — NO timestamp
//
// So it counts UNIQUE MATERIAL CHANGES BY CANONICAL IDENTITY since the
// decision, not event occurrences. The same fact observed twice collapses. A
// count of 2 therefore means a SECOND DISTINCT (type, sourceSystem, sourceId)
// triple appeared — not a duplicate delivery, not a replay.
//
// That rules out most of the usual flake causes before a single run: SSE
// replay, duplicate broadcast and double listener registration would all
// produce the same fingerprint and collapse. This probe exists to name the
// second fingerprint.
//
// USAGE
//   node scripts/m18FlakeProbe.mjs [runs]
//   M18_FLAKE_LOAD=1 node scripts/m18FlakeProbe.mjs 50   (adds CPU pressure)
//
// Every run gets a FRESH database and a FRESH server process, so no state
// crosses a run boundary.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const RUNS = Number(process.argv[2] ?? 50);
const LOAD = process.env.M18_FLAKE_LOAD === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** Burn a core so timers and I/O interleave differently. */
function loadGenerator() {
  if (!LOAD) return null;
  const child = spawn(process.execPath, ['-e', 'const e=Date.now()+600000;while(Date.now()<e){Math.sqrt(Math.random());}'], { stdio: 'ignore' });
  children.push(child);
  child.unref();
  return child;
}

async function oneRun(i) {
  const DATA = mkdtempSync(path.join(tmpdir(), 'sbx-m18flake-'));
  const PORT = 5400 + (i % 150);
  const BASE = `http://localhost:${PORT}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; });
  proc.stderr.on('data', (b) => { log += b; });
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();

  let up = false;
  for (let k = 0; k < 200 && !up; k += 1) {
    try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(100);
  }
  if (!up) { rmSync(DATA, { recursive: true, force: true }); return { ok: false, why: 'server did not start', log: log.slice(-400) }; }

  const j = async (p, opts = {}, token) => {
    const res = await fetch(`${BASE}${p}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // --- exactly the m18E2E prelude -----------------------------------------
  const maria = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).body;
  const players = (await j('/org/players', {}, maria.token)).body;
  const ADULT = (players ?? []).find((p) => /Kola Adeyemi/.test(p.name)) ?? players?.[0];
  const room = (await j('/org/rooms', { method: 'POST', body: JSON.stringify({ playerId: ADULT.id }) }, maria.token)).body.room;
  await j(`/org/rooms/${room.roomId}/status`, { method: 'POST', body: JSON.stringify({ status: 'under_review' }) }, maria.token);
  const archived = await j(`/org/rooms/${room.roomId}/status`, {
    method: 'POST', body: JSON.stringify({ status: 'archived', reasonCodes: ['insufficient_recent_evidence'] }),
  }, maria.token);

  // HYPOTHESIS PROBE. `computeGaps()` (m13/insight.mjs) is a READ-TRIGGERED
  // WRITE: asking for a player's evidence gaps flips any open suggestion that
  // no longer hits to `status:'supplied'` with `updatedAt = Date.now()`. And
  // m18/secondLook.mjs counts `evidence_gap_closed` for exactly that shape.
  //
  // So if a gap was OPEN when the evidence landed, and anything asks for gaps
  // afterwards, a SECOND distinct fingerprint appears. Set M18_FLAKE_GAPS=1 to
  // walk that path deliberately.
  if (process.env.M18_FLAKE_GAPS === '1') {
    await j(`/org/players/${ADULT.id}/evidence-gaps`, {}, maria.token);
  }

  const before = await j('/org/second-look', {}, maria.token);
  const added = await j(`/org/players/${ADULT.id}/evidence`, {
    method: 'POST', body: JSON.stringify({ claimType: 'footage', label: 'Full match vs Riverton' }),
  }, maria.token);
  if (process.env.M18_FLAKE_GAPS === '1') {
    await j(`/org/players/${ADULT.id}/evidence-gaps`, {}, maria.token);
  }
  const after = await j('/org/second-look', {}, maria.token);

  const item = after.body?.items?.[0] ?? null;
  const result = {
    ok: before.body?.total === 0 && after.body?.total === 1 && item?.changeCount === 1,
    beforeTotal: before.body?.total,
    afterTotal: after.body?.total,
    changeCount: item?.changeCount ?? null,
    // The diagnostic that matters: every change's canonical identity.
    changes: (item?.changes ?? []).map((c) => ({
      type: c.type, source: c.sourceSystem, sourceId: c.sourceId, at: c.occurredAt, fp: c.fingerprint,
    })),
    decisionAt: item?.decisionAt ?? null,
    archivedStatus: archived.status,
    evidenceStatus: added.status,
    evidenceId: added.body?.evidence?.id ?? added.body?.id ?? null,
  };

  proc.kill('SIGTERM');
  for (let k = 0; k < 40 && proc.exitCode == null; k += 1) await sleep(50);
  try { proc.kill('SIGKILL'); } catch { /* gone */ }
  rmSync(DATA, { recursive: true, force: true });
  return result;
}

const load = loadGenerator();
console.log(`m18 flake probe: ${RUNS} runs, fresh DB + fresh process each${LOAD ? ', under CPU load' : ''}`);

let failures = 0;
const seen = new Map();
for (let i = 0; i < RUNS; i += 1) {
  const r = await oneRun(i);
  if (!r.ok) {
    failures += 1;
    console.error(`\n✗ run ${i + 1}: changeCount=${r.changeCount} beforeTotal=${r.beforeTotal} afterTotal=${r.afterTotal}`);
    console.error(`  decisionAt=${r.decisionAt}`);
    for (const c of r.changes) console.error(`  change: ${c.fp}  at=${c.at}  (Δ from decision ${c.at - r.decisionAt}ms)`);
    if (r.why) console.error(`  ${r.why}\n${r.log ?? ''}`);
    for (const c of r.changes) seen.set(c.fp, (seen.get(c.fp) ?? 0) + 1);
  } else {
    process.stdout.write('.');
  }
  if ((i + 1) % 50 === 0) process.stdout.write(` ${i + 1}\n`);
}
try { load?.kill('SIGKILL'); } catch { /* none */ }

console.log(`\n\n${RUNS - failures}/${RUNS} clean, ${failures} mismatch${failures === 1 ? '' : 'es'}`);
if (seen.size) {
  console.log('fingerprints seen on failing runs:');
  for (const [fp, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${fp}`);
}
process.exit(failures ? 1 : 0);
