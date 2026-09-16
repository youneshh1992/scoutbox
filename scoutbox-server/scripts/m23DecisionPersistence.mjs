// M23 P5 — persistence, restart and corruption audit for the formal decision.
//
//   1  no P5 migration: the schema is what P4B left, `roomDecisions` is the
//      one decision store, the draft lives on the case, nothing is renamed
//   2  a snapshot with legacy + formal rows and a draft restores byte-faithfully
//      through a real boot: chain, keys, draft rev, case status
//   3  corrupt FORMAL rows are named and omitted, never fabricated, never
//      repaired; duplicate final heads are corruption, not a tie (500)
//   4  legacy M17 rows read as advisory, keep their chain, and are never judged
//      by the P5 integrity rules
//   5  clean boot: draft → finalize → stop → snapshot → reboot: the row is on
//      `roomDecisions` (no second store), the draft is gone, keys replay
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { JOURNEY_REQUIRED_STORES } from '../m23/journey.mjs';
import { decisionIntegrity, duplicateFinalHeads, chainHead, isFormal } from '../m23/decision.mjs';
import { guaranteeFor } from '../storeContract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; }); proc.stderr.on('data', (b) => { log += b; });
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log: () => log };
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* non-json */ }
    return { status: r.status, body: data };
  };
  const stop = async () => {
    proc.kill('SIGTERM');
    for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
    return openStore(dataDir).load()?.db ?? null;
  };
  return { up, j, stop, log: () => log };
}

const PORT = 5800 + Math.floor(Math.random() * 200);
const T0 = 1_800_000_000_000;
const BY = { userId: 'usr-owner', name: 'Owner', role: 'Head of Recruitment' };

// ------------------------------------------------------------- fixtures

/** A minimal, sound database: one verified club, one adult player, one case at shortlisted. */
function baseDb() {
  const db = {
    players: [{ id: 'pl-x', name: 'Xavier Adult', dob: '2000-05-05', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } }],
    orgs: [{ id: 'org-x', name: 'X FC', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, squad: [], location: { lat: 51.5, lng: -0.1 } }],
    guardians: [], users: [], sessions: [], ledger: [], notifications: [],
    recruitmentCases: [{
      id: 'case-x', orgId: 'org-x', playerId: 'pl-x', playerName: 'Xavier Adult', ownerUserId: 'usr-owner', ownerName: 'Owner', stage: 'review',
      priority: 'medium', restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
      room: { status: 'shortlisted', priority: 'normal', tags: [], leadScoutUserId: 'usr-owner', sourceContext: 'search', updatedAt: 1000, archivedAt: null, closedAt: null, rev: 2, revAt: 1000, revBy: null },
      createdAt: 1000, history: [{ id: 'aud-1', at: 1000, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_created', detail: { status: 'watching' } }, { id: 'aud-2', at: 1001, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_status_changed', detail: { from: 'watching', to: 'shortlisted', reasonCodes: [] } }],
    }],
  };
  runMigrations(db);
  return db;
}

const legacyRow = (over = {}) => ({
  id: 'rdec-legacy', roomId: 'case-x', orgId: 'org-x', playerId: 'pl-x',
  recommendation: 'shortlist', reasonCodes: ['tactical_fit'], note: 'Legacy opinion.', by: BY, createdAt: T0, trigger: 'decision',
  supersedes: null, supersededById: 'rdec-formal-1', clientKey: 'legacy-key', snapshot: null,
  ...over,
});
const formalRow = (over = {}) => ({
  id: 'rdec-formal-1', roomId: 'case-x', orgId: 'org-x', playerId: 'pl-x',
  kind: 'formal', state: 'final', outcome: 'progress', recommendation: 'offer',
  reasonCodes: ['position_need'], note: 'First formal.', by: BY, createdAt: T0 + 10, finalizedAt: T0 + 10, trigger: 'decision:finalize', clientKey: 'fin-1',
  supersedes: 'rdec-legacy', supersededById: 'rdec-formal-2', supersession: null,
  rev: 2, revAt: T0 + 20, evidenceRefs: [{ kind: 'assessment', id: 'ass-1', meta: { scoutName: 'S', submittedAt: T0, verdict: 'sign', trialId: null } }],
  assessmentSummary: { submitted: 1, withheld: 0, verdicts: { sign: 1, monitor: 0, pass: 0, none: 0 }, assessmentIds: ['ass-1'] },
  snapshot: null, keys: { finalize: { key: 'fin-1', fp: '{"fixture":1}' }, draft: { key: 'draft-1', fp: '{"fixture":1}' } }, draftId: 'rdraft-1',
  lifecycle: { action: 'considerOffer', from: 'shortlisted', to: 'offer_consideration', applied: true, at: T0 + 10 }, policyVersion: 1,
  ...over,
});
const headRow = (over = {}) => formalRow({
  id: 'rdec-formal-2', outcome: 'hold', recommendation: 'continue_watching', reasonCodes: ['timing'], note: 'Second formal.',
  createdAt: T0 + 20, finalizedAt: T0 + 20, clientKey: 'fin-2', supersedes: 'rdec-formal-1', supersededById: null,
  supersession: { of: 'rdec-formal-1', reason: 'Budget review.' }, rev: 1, revAt: T0 + 20, evidenceRefs: [], assessmentSummary: { submitted: 1, withheld: 0, verdicts: { sign: 1, monitor: 0, pass: 0, none: 0 }, assessmentIds: ['ass-1'] },
  keys: { finalize: { key: 'fin-2', fp: '{"fixture":2}' }, draft: null }, draftId: 'rdraft-2',
  lifecycle: { action: 'holdCase', from: 'offer_consideration', to: 'on_hold', applied: true, at: T0 + 20 },
  ...over,
});
const draftRow = (over = {}) => ({
  id: 'rdraft-3', outcome: 'reject', reasonCodes: ['insufficient_recent_evidence'], note: 'Thinking.', evidenceRefs: [],
  by: BY, createdAt: T0 + 30, updatedAt: T0 + 31, updatedBy: BY, rev: 2, revAt: T0 + 31, keys: { create: { key: 'draft-3', fp: '{"fixture":3}' } },
  ...over,
});

const stableJson = (v) => JSON.stringify(v);
const lead = (s) => s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' }).then((r) => r.body);

// ======================================================= 1 — no migration
section('1 — no P5 migration: one decision store, the draft on the case, nothing renamed');
{
  ok(SCHEMA_VERSION === 2304 && !MIGRATIONS.some((m) => /decision/i.test(m.id) && m.version > 2304), `the schema is still ${SCHEMA_VERSION}: P5 adds no migration step`);
  ok(guaranteeFor('roomDecisions') === 'migration' && PRODUCTION_REQUIRED_STORES.includes('roomDecisions') && JOURNEY_REQUIRED_STORES.includes('roomDecisions'), 'roomDecisions is migration-guaranteed, production-required and journey-required (M17, unchanged)');
  neg(guaranteeFor('recruitmentDecisions') !== 'migration' && guaranteeFor('decisionDrafts') !== 'migration' && guaranteeFor('recruitmentOffers') !== 'migration', 'no second decision store, no draft store, no offer store is guaranteed by the registry');
  const fresh = {};
  runMigrations(fresh);
  ok(Array.isArray(fresh.roomDecisions) && fresh.roomDecisions.length === 0 && fresh.recruitmentDecisions === undefined && fresh.decisionDrafts === undefined && fresh.recruitmentOffers === undefined, 'a clean database gets an empty roomDecisions and no P5-invented store');
  const db = baseDb();
  db.roomDecisions.push(legacyRow(), formalRow(), headRow());
  db.recruitmentCases[0].decisionDraft = draftRow();
  const before = stableJson(db.roomDecisions) + stableJson(db.recruitmentCases[0].decisionDraft);
  const again = runMigrations(db);
  ok(again.ran.length === 0 && stableJson(db.roomDecisions) + stableJson(db.recruitmentCases[0].decisionDraft) === before, 'running the migrations over formal rows and a draft changes nothing');
  neg(db.recruitmentCases[0].room.status === 'shortlisted' && !('decisionStatus' in db.recruitmentCases[0].room), 'no case field was invented for the decision — the case carries only its draft');
}

// ======================================================= 2 — byte-faithful restore
section('2 — a snapshot with legacy + formal rows and a draft restores byte-faithfully through a real boot');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-restore-'));
  const db = baseDb();
  db.roomDecisions.push(legacyRow(), formalRow(), headRow());
  db.recruitmentCases[0].decisionDraft = draftRow();
  db.recruitmentCases[0].room.status = 'on_hold';
  openStore(DIR).save({ db });
  const beforeRows = db.roomDecisions.map(stableJson); const beforeDraft = stableJson(db.recruitmentCases[0].decisionDraft);
  const s = await bootOn(DIR, PORT);
  ok(s.up, 'the server boots on the snapshot');
  const L = await lead(s);
  const sf = await s.j('GET', '/org/rooms/case-x/decision', undefined, L.token);
  ok(sf.status === 200 && sf.body.current?.id === 'rdec-formal-2' && sf.body.current.outcome === 'hold' && sf.body.current.rev === 1 && sf.body.current.supersession?.reason === 'Budget review.' && sf.body.omitted === 0 && sf.body.duplicateHeads.length === 0, 'the surface: the hold is current, with its supersession reason; nothing omitted');
  ok(sf.body.history.map((d) => d.id).join() === 'rdec-formal-2,rdec-formal-1,rdec-legacy' && sf.body.history[1].rev === 2 && sf.body.history[1].supersededById === 'rdec-formal-2' && sf.body.history[2].kind === 'recommendation' && sf.body.history[2].supersededById === 'rdec-formal-1', 'the chain reads newest first: hold ← progress (rev 2, superseded) ← legacy advisory (superseded by the progress)');
  ok(sf.body.draft?.id === 'rdraft-3' && sf.body.draft.rev === 2 && sf.body.draft.outcome === 'reject' && sf.body.draft.note === 'Thinking.', 'the draft restored with its rev and content');
  ok(sf.body.history[1].evidenceRefs[0].meta.verdict === 'sign' && sf.body.history[1].assessmentSummary.assessmentIds[0] === 'ass-1', 'the references and the assessment snapshot restored on the superseded row');
  // Keys restored: the stored fingerprints are fixture values, so a different payload under the same key is a CONFLICT — the key was restored.
  const dk = await s.j('POST', '/org/rooms/case-x/decision/draft', { outcome: 'hold', clientKey: 'draft-3' }, L.token);
  neg(dk.status === 409 && dk.body.error === 'DECISION_IDEMPOTENCY_CONFLICT', 'the draft key on the case was restored (mismatched fingerprint is a conflict, not a fresh draft)');
  const fk = await s.j('POST', '/org/rooms/case-x/decision/finalize', { expectedRev: 2, clientKey: 'fin-2' }, L.token);
  neg(fk.status === 409 && fk.body.error === 'DECISION_IDEMPOTENCY_CONFLICT', 'the finalize key on the formal row was restored too');
  const stale = await s.j('PATCH', '/org/rooms/case-x/decision/draft', { note: 'x', expectedRev: 1 }, L.token);
  neg(stale.status === 409 && stale.body.error === 'DECISION_VERSION_CONFLICT' && stale.body.currentRev === 2, 'the draft rev is enforced from the snapshot');
  const legacyRoute = await s.j('GET', '/org/rooms/case-x/decisions', undefined, L.token);
  ok(legacyRoute.status === 200 && legacyRoute.body.current?.id === 'rdec-formal-2' && legacyRoute.body.history.length === 3, 'the M17 route reads the same three rows and the same head');
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, L.token);
  ok(jr.status === 200 && jr.body.decisions.formal?.id === 'rdec-formal-2' && jr.body.decisions.draft?.id === 'rdraft-3' && jr.body.lifecycle.currentStage === 'on_hold', 'the journey projects the formal head, the draft and the case stage');
  const after = await s.stop();
  ok(after && after.roomDecisions.map(stableJson).join('\n') === beforeRows.join('\n') && stableJson(after.recruitmentCases[0].decisionDraft) === beforeDraft, 'after a boot, reads, refused writes and a graceful stop, every row and the draft are byte-identical — nothing rewritten, re-ordered or "repaired"');
  neg(!s.log().includes('DECISION integrity'), 'no integrity warning was logged for sound rows');
}

// ======================================================= 3 — corrupt rows
section('3 — corrupt formal rows are named and omitted; duplicate heads are corruption, not a tie');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-corrupt-'));
  const db = baseDb();
  const bad = [
    formalRow({ id: 'rdec-bad-outcome', outcome: 'accept', supersedes: null, supersededById: 'x1', createdAt: T0 + 1 }),
    formalRow({ id: 'rdec-bad-proto', outcome: '__proto__', supersedes: null, supersededById: 'x1', createdAt: T0 + 2 }),
    formalRow({ id: 'rdec-bad-actor', by: null, supersedes: null, supersededById: 'x1', createdAt: T0 + 3 }),
    formalRow({ id: 'rdec-bad-time', createdAt: 'yesterday', supersedes: null, supersededById: 'x1' }),
    formalRow({ id: 'rdec-bad-reasons', reasonCodes: 'position_need', supersedes: null, supersededById: 'x1', createdAt: T0 + 4 }),
    formalRow({ id: 'rdec-bad-code', reasonCodes: ['race'], supersedes: null, supersededById: 'x1', createdAt: T0 + 5 }),
    formalRow({ id: 'rdec-bad-refs', evidenceRefs: {}, supersedes: null, supersededById: 'x1', createdAt: T0 + 6 }),
    formalRow({ id: 'rdec-bad-rev', rev: 0, supersedes: null, supersededById: 'x1', createdAt: T0 + 7 }),
  ];
  db.roomDecisions.push(legacyRow({ supersededById: 'rdec-formal-2' }), headRow({ supersedes: 'rdec-legacy' }), ...bad, null, 'string', 42);
  openStore(DIR).save({ db });
  const s = await bootOn(DIR, PORT + 1);
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots with eight corrupt formal rows and three alien entries in the store');
  const L = await lead(s);
  const sf = await s.j('GET', '/org/rooms/case-x/decision', undefined, L.token);
  if (sf.status !== 200) console.error('   surface', sf.status, JSON.stringify(sf.body).slice(0, 300), s.log().split('\n').filter((l) => /Error|TypeError/.test(l)).slice(0, 4).join(' | '));
  ok(sf.status === 200 && sf.body.current?.id === 'rdec-formal-2' && sf.body.history.length === 2, 'the surface serves the sound head and the legacy row');
  neg(sf.body.omitted === 8, `eight corrupt formal rows are counted as omitted (${sf.body.omitted}); the alien entries are ignored`);
  const log = s.log();
  neg(bad.every((r) => log.includes(`DECISION integrity ${r.id}`)), 'every corrupt row is NAMED in the server log with its problems');
  neg(bad.every((r) => decisionIntegrity(r, { orgId: 'org-x', caseId: 'case-x' }).length > 0) && decisionIntegrity(headRow(), { orgId: 'org-x', caseId: 'case-x' }).length === 0, 'the pure integrity check agrees row by row');
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, L.token);
  ok(jr.status === 200 && jr.body.decisions.formal?.id === 'rdec-formal-2', 'the journey still projects the sound head');
  const after = await s.stop();
  neg(after.roomDecisions.filter((x) => x && typeof x === 'object').length === 10 && after.roomDecisions.some((x) => x?.id === 'rdec-bad-outcome' && x.outcome === 'accept'), 'the corrupt rows are still in the snapshot exactly as they were — omitted on read, never deleted or "repaired" on write');
  if (stableJson(after.roomDecisions) !== stableJson(db.roomDecisions)) console.error('   store changed', stableJson(after.roomDecisions).slice(0, 300));
  ok(stableJson(after.roomDecisions) === stableJson(db.roomDecisions), 'the whole store is byte-identical');

  // Duplicate final heads.
  const DIR2 = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-dup-'));
  const db2 = baseDb();
  db2.roomDecisions.push(headRow({ id: 'rdec-head-a', supersedes: null }), headRow({ id: 'rdec-head-b', supersedes: null, createdAt: T0 + 21 }));
  db2.recruitmentCases[0].decisionDraft = draftRow();
  openStore(DIR2).save({ db: db2 });
  neg(duplicateFinalHeads(db2.roomDecisions).length === 2 && chainHead(db2.roomDecisions).id === 'rdec-head-b', 'the pure check names both heads (the chain reader alone would silently pick the later one)');
  const s2 = await bootOn(DIR2, PORT + 2);
  ok(s2.up, 'the server boots with two formal rows both claiming to be current');
  const L2 = await lead(s2);
  const dup = await s2.j('GET', '/org/rooms/case-x/decision', undefined, L2.token);
  neg(dup.status === 500 && dup.body.error === 'DECISION_STATE_UNKNOWN', 'reading the surface is DECISION_STATE_UNKNOWN (500) — no honest "current decision" exists');
  const fin = await s2.j('POST', '/org/rooms/case-x/decision/finalize', { expectedRev: 2 }, L2.token);
  neg(fin.status === 500 && fin.body.error === 'DECISION_STATE_UNKNOWN', 'nothing new is finalized on top of corruption');
  neg(s2.log().includes('duplicate_final_heads rdec-head-a,rdec-head-b'), 'the duplicate heads are named in the log');
  const after2 = await s2.stop();
  ok(stableJson(after2.roomDecisions) === stableJson(db2.roomDecisions) && stableJson(after2.recruitmentCases[0].decisionDraft) === stableJson(db2.recruitmentCases[0].decisionDraft), 'the two heads and the draft are still there, untouched — a person decides which is true, not the boot');
}

// ======================================================= 4 — legacy rows
section('4 — legacy M17 rows read as advisory and keep their chain; P5 judges only formal rows');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-legacy-'));
  const db = baseDb();
  db.roomDecisions.push(
    legacyRow({ id: 'rdec-l1', createdAt: T0, supersededById: 'rdec-l2' }),
    legacyRow({ id: 'rdec-l2', recommendation: 'offer', reasonCodes: [], note: null, createdAt: T0 + 1, supersedes: 'rdec-l1', supersededById: null }),
    legacyRow({ id: 'rdec-l-odd', by: null, createdAt: 'x', reasonCodes: 'weird', supersededById: 'rdec-l1' }),
  );
  openStore(DIR).save({ db });
  const s = await bootOn(DIR, PORT + 3);
  ok(s.up, 'the server boots on a legacy-only decision memory');
  const L = await lead(s);
  const sf = await s.j('GET', '/org/rooms/case-x/decision', undefined, L.token);
  ok(sf.status === 200 && sf.body.current === null && sf.body.advisory?.id === 'rdec-l2' && sf.body.advisory.kind === 'recommendation' && sf.body.advisory.recommendation === 'offer' && sf.body.omitted === 0, 'an M17 "offer" recommendation at the head is ADVISORY — not a formal decision, not current');
  neg(!db.roomDecisions.some(isFormal) && sf.body.requirements.hasFinal === false, 'no legacy row is read as formal, whatever it recommends');
  ok(sf.body.history.length === 3 && sf.body.omitted === 0 && !s.log().includes('DECISION integrity'), 'an odd legacy row (no actor, no time) is served as M17 always served it — P5 does not judge it');
  const byHand = await s.j('POST', '/org/rooms/case-x/lifecycle', { action: 'considerOffer', expectedRev: 2 }, L.token);
  neg(byHand.status === 422 && byHand.body.error === 'LIFECYCLE_EVIDENCE_REQUIRED' && byHand.body.evidenceReason === 'no_finalized_progress_decision', 'and the advisory "offer" does not evidence offer_consideration');
  const after = await s.stop();
  ok(stableJson(after.roomDecisions) === stableJson(db.roomDecisions), 'the legacy rows are byte-identical after the boot');
}

// ======================================================= 5 — clean boot, live flow, restart
section('5 — clean boot: draft → finalize → stop → reboot: one store, keys replay, the draft is gone');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-clean-'));
  openStore(DIR).save({ db: baseDb() });
  const s = await bootOn(DIR, PORT + 4);
  const L = await lead(s);
  const d = await s.j('POST', '/org/rooms/case-x/decision/draft', { outcome: 'progress', reasonCodes: ['position_need'], note: 'Clean.', clientKey: 'clean-draft' }, L.token);
  ok(d.status === 201 && d.body.draft.rev === 1, 'a draft opens on a clean database');
  const snap0 = await s.stop();
  ok(snap0.recruitmentCases[0].decisionDraft?.id === d.body.draft.id && snap0.recruitmentCases[0].decisionDraft.keys.create.key === 'clean-draft' && snap0.roomDecisions.length === 0, 'the snapshot holds the draft ON THE CASE with its key, and no decision row');
  const s2 = await bootOn(DIR, PORT + 5);
  const L2 = await lead(s2);
  const replayDraft = await s2.j('POST', '/org/rooms/case-x/decision/draft', { outcome: 'progress', reasonCodes: ['position_need'], note: 'Clean.', clientKey: 'clean-draft' }, L2.token);
  ok(replayDraft.status === 200 && replayDraft.body.idempotent === true, 'after the reboot the draft key replays');
  const fin = await s2.j('POST', '/org/rooms/case-x/decision/finalize', { expectedRev: 1, clientKey: 'clean-final' }, L2.token);
  ok(fin.status === 201 && fin.body.lifecycle.to === 'offer_consideration', 'the draft finalizes to a progress decision and the case moves');
  const snap1 = await s2.stop();
  const row = snap1.roomDecisions.find((x) => x.id === fin.body.decision.id);
  ok(row && row.kind === 'formal' && row.state === 'final' && row.outcome === 'progress' && row.keys.finalize.key === 'clean-final' && row.keys.draft.key === 'clean-draft' && row.draftId === d.body.draft.id && snap1.recruitmentCases[0].decisionDraft === null && snap1.recruitmentCases[0].room.status === 'offer_consideration', 'the snapshot holds the formal row on roomDecisions with both keys, the draft cleared, the case at offer_consideration');
  neg(!Object.keys(snap1).some((k) => /offer|decisionDraft|recruitmentDecision/i.test(k)), 'no new top-level store appeared in the snapshot');
  const s3 = await bootOn(DIR, PORT + 6);
  const L3 = await lead(s3);
  const replayFin = await s3.j('POST', '/org/rooms/case-x/decision/finalize', { expectedRev: 1, clientKey: 'clean-final' }, L3.token);
  ok(replayFin.status === 200 && replayFin.body.idempotent === true && replayFin.body.decision.id === fin.body.decision.id, 'after another reboot the finalize key replays the same decision');
  const replayDraft2 = await s3.j('POST', '/org/rooms/case-x/decision/draft', { outcome: 'progress', reasonCodes: ['position_need'], note: 'Clean.', clientKey: 'clean-draft' }, L3.token);
  ok(replayDraft2.status === 200 && replayDraft2.body.idempotent === true && replayDraft2.body.decision?.id === fin.body.decision.id, 'and the draft key replays the decision it became');
  const sf = await s3.j('GET', '/org/rooms/case-x/decision', undefined, L3.token);
  ok(sf.body.current?.id === fin.body.decision.id && sf.body.draft === null && sf.body.history.length === 1, 'the surface after two reboots: one formal decision, no draft');
  const snap2 = await s3.stop();
  ok(stableJson(snap2.roomDecisions) === stableJson(snap1.roomDecisions), 'a reboot with only reads and replays rewrote nothing');
}

// ------------------------------------------------------------ report
console.log(`\nM23 P5 Decision persistence: ${passed} checks passed, ${negatives} negative (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P5 Decision persistence has failures.');
else console.log('all M23 P5 Decision persistence checks passed');
process.exit(process.exitCode ?? 0);
