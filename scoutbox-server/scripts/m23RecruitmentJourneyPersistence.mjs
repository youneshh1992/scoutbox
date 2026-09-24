// M23 P8 — persistence and restart audit for the recruitment journey.
//
//   1  a real journey is driven to nine checkpoints — contacted,
//      trial_requested, trial_scheduled, trial_completed, offer_consideration,
//      offer_made, offer_accepted, signing in progress, signed — and at each
//      the server is stopped (SIGTERM) and booted again on the same store:
//      the journey projection (stage, completed stages, resources, next
//      action, classification, timeline) is IDENTICAL before and after
//   2  after the final reboot: the player's journey and the club's journey
//      agree; db.signings stays unique; nothing is fabricated on boot
//   3  planted legacy and corrupt cases survive five restarts untouched:
//      never repaired, never re-classified, never given a record
//   4  the migration ledger applies nothing on replay (schema 2308)
//
// Nothing is rewritten, re-ordered or "repaired" on boot.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
let passed = 0; let negatives = 0; let failures = 0;
const fail = (m) => { failures++; console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const H = 3_600_000; const DAY = 24 * H;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\n%%EOF\n`, 'latin1');
const dataUrl = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
const DOC = pdf('journey persistence contract'); const SHA = sha256(DOC);
const S_DEC = 'PRIVATE_JOURNEY_PERSIST_DECISION_4410';
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
const PORT = 7600 + Math.floor(Math.random() * 200);
const DATA = mkdtempSync(path.join(tmpdir(), 'sbx-m23jnp-'));
const T0 = Date.now();
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

let S = await bootOn(DATA, PORT);
ok(S.up, `boot 1 on an empty store (schema ${SCHEMA_VERSION})`);
let maria; let kola;
const login = async () => {
  maria = (await S.j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  kola = (await S.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
};
await login();
ok(!!maria?.token && !!kola?.token, 'actors logged in');

const journey = async (RID) => (await S.j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
/** The comparable projection: everything but the generation instant. */
const fingerprint = (jr) => JSON.stringify({ stage: jr.lifecycle.currentStage, journey: jr.journey, timeline: jr.history.entries, contacts: jr.contact.contacts, trials: jr.trials, offers: jr.offer.records, packages: jr.outcome.signingPackages, signing: jr.outcome.signing, decisions: jr.decisions.all.map((d) => d.id) });
const playerJourney = async () => (await S.j('GET', '/player/journeys', undefined, kola.token)).body.items.find((x) => x.club.id === 'org-eastport') ?? null;
const pfp = (it) => JSON.stringify(it ? { stage: it.journey.stage, next: it.journey.nextAction, res: it.journey.resources, tl: it.journey.timeline, shared: it.shared } : null);
const rev = async (RID) => (await journey(RID)).case.rev;
const lifecycle = async (RID, action) => S.j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await rev(RID) }, maria.token);

/** Stop, reboot on the same store, re-login, and prove the projection is byte-identical. */
async function restartAndCompare(RID, label, expectStage, expectNext) {
  const before = fingerprint(await journey(RID)); const pBefore = pfp(await playerJourney());
  const db = await S.stop();
  ok(db !== null, `${label}: the store was persisted before the restart`);
  S = await bootOn(DATA, PORT);
  ok(S.up, `${label}: rebooted`);
  await login();
  const after = await journey(RID);
  ok(fingerprint(after) === before, `${label}: the club's journey projection is IDENTICAL after the restart`);
  ok(pfp(await playerJourney()) === pBefore, `${label}: the player's journey is IDENTICAL after the restart`);
  ok(after.lifecycle.currentStage === expectStage && after.journey.nextAction.code === expectNext, `${label}: ${expectStage} / ${expectNext}`);
  return after;
}

// ================================================================ 1 — the nine checkpoints
section('1 — the nine checkpoints, each across a SIGTERM restart');
const r = await S.j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
const RID = r.body.room.roomId;
await lifecycle(RID, 'startReview'); await lifecycle(RID, 'planContact');
const d = await S.j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest', body: 'We would like to talk.', clientKey: key() }, maria.token);
const sent = await S.j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
ok(sent.status === 200, 'contact sent');
await restartAndCompare(RID, 'checkpoint contacted', 'contacted', 'AWAIT_CONTACT_RESPONSE');
const req = (await S.j('GET', '/player/inbox', undefined, kola.token)).body.find((x) => x.type === 'contact' && x.status === 'pending');
ok((await S.j('POST', `/player/requests/${req.id}/respond`, { accept: true, message: 'Yes.' }, kola.token)).status === 200, 'the player answered');
const T1 = T0 + DAY;
const inv = await S.j('POST', `/org/rooms/${RID}/trials`, { timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B' }, message: 'Come and train.', slots: [{ startsAt: T1 + 2 * H, endsAt: T1 + 4 * H, kind: 'training' }], clientKey: key() }, maria.token, at(T1));
ok(inv.status === 201, 'trial invited');
await restartAndCompare(RID, 'checkpoint trial_requested', 'trial_requested', 'AWAIT_TRIAL_RESPONSE');
const p = (await S.j('GET', '/player/inbox', undefined, kola.token)).body.find((x) => x.type === 'trial' && x.status === 'pending');
const acc = await S.j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, kola.token, at(T1));
ok(acc.status === 200, 'trial accepted');
const TID = acc.body.trialId;
await restartAndCompare(RID, 'checkpoint trial_scheduled', 'trial_scheduled', 'CONDUCT_TRIAL');
const t = (await S.j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, maria.token)).body.trial;
const att = await S.j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${t.schedule.sessions[0].id}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(T1 + 3 * H));
const comp = await S.j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: att.body.trial.rev }, maria.token, at(T1 + 5 * H));
ok(att.status === 200 && comp.status === 200, 'trial completed');
await restartAndCompare(RID, 'checkpoint trial_completed', 'trial_completed', 'COMPLETE_ASSESSMENT');
const a = await S.j('POST', '/org/assessments', { playerId: 'pl-adeyemi', context: { trialId: TID } }, maria.token);
const attrs = a.body.assessment.attributesSnapshot.slice(0, 3).map((x) => x.id);
await S.j('PUT', `/org/assessments/${a.body.assessment.id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: 'medium', note: 'ok' })), recommendation: { verdict: 'sign', reasons: 'ok' } }, maria.token);
ok((await S.j('POST', `/org/assessments/${a.body.assessment.id}/submit`, {}, maria.token)).status === 200, 'assessment submitted');
const dr = await S.j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, maria.token);
const fin = await S.j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, maria.token);
ok(fin.status === 201, 'decision finalized');
await restartAndCompare(RID, 'checkpoint offer_consideration', 'offer_consideration', 'PREPARE_OFFER');
const c = await S.j('POST', `/org/rooms/${RID}/offers`, { terms: { role: 'Midfielder', squad: 'U23', startDate: '2027-07-01', endDate: '2029-06-30' }, expiresAt: T0 + 14 * DAY, clientKey: key() }, maria.token, at(T0));
const OID = c.body.offer.id;
const iss = await S.j('POST', `/org/offers/${OID}/issue`, { expectedRev: 1, clientKey: key() }, maria.token, at(T0));
ok(c.status === 201 && iss.status === 200, 'offer issued');
const R = iss.body.offer.currentRevisionId;
await restartAndCompare(RID, 'checkpoint offer_made', 'offer_made', 'AWAIT_OFFER_RESPONSE');
ok((await S.j('POST', `/player/offers/${OID}/accept`, { revisionId: R, clientKey: key() }, kola.token, at(T0))).status === 200, 'offer accepted by the player');
await restartAndCompare(RID, 'checkpoint offer_accepted', 'offer_accepted', 'START_SIGNING');
const st = await S.j('POST', `/org/offers/${OID}/signing`, { clientKey: key() }, maria.token, at(T0));
const SID = st.body.signing.id;
const a1 = await S.j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(DOC), filename: 'contract.pdf', label: 'Contract', expectedRev: st.body.signing.rev }, maria.token, at(T0));
const r1 = await S.j('POST', `/org/signings/${SID}/ready`, { expectedRev: a1.body.signing.rev, clientKey: key() }, maria.token, at(T0));
const cs = await S.j('POST', `/org/signings/${SID}/parties/club/complete`, { expectedRev: r1.body.signing.rev, revisionId: r1.body.signing.currentRevision.id, documentSha256: SHA, clientKey: key() }, maria.token, at(T0));
ok(st.status === 201 && a1.status === 200 && r1.status === 200 && cs.status === 200, 'signing started, presented, signed by the club');
const mid = await restartAndCompare(RID, 'checkpoint signing in progress', 'offer_accepted', 'AWAIT_RECIPIENT_SIGNATURE');
ok(mid.journey.stage === 'signing' && mid.journey.resources.signingPackageId === SID, 'the in-progress package is still the current one after the restart');
const prev = (await S.j('GET', `/player/signings/${SID}`, undefined, kola.token, at(T0))).body.signing;
const ps = await S.j('POST', `/player/signings/${SID}/complete`, { revisionId: prev.currentRevision.id, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, kola.token, at(T0));
const cur = (await S.j('GET', `/org/signings/${SID}`, undefined, maria.token, at(T0))).body.signing;
const done = await S.j('POST', `/org/signings/${SID}/complete`, { expectedRev: cur.rev, clientKey: key() }, maria.token, at(T0));
ok(ps.status === 200 && done.status === 200, 'the player signed; the lead completed');
const fin9 = await restartAndCompare(RID, 'checkpoint signed', 'signed', 'RECRUITMENT_COMPLETE');
ok(fin9.journey.completedStages.length === 10 && fin9.journey.classification === 'canonical' && fin9.outcome.signing?.id === fin9.journey.resources.completedSigningId, 'signed: ten completed stages, canonical, the row named');

// ================================================================ 2 — after the final reboot
section('2 — after the final reboot: agreement, uniqueness, nothing fabricated');
{
  const rows = (await S.j('GET', '/org/signings', undefined, maria.token)).body.filter((s) => s.signingPackageId === SID);
  ok(rows.length === 1, 'exactly one db.signings row for the package');
  const again = await S.j('POST', `/org/signings/${SID}/complete`, { expectedRev: 99, clientKey: key() }, maria.token, at(T0));
  neg(again.status !== 200 && (await S.j('GET', '/org/signings', undefined, maria.token)).body.filter((s) => s.signingPackageId === SID).length === 1, 'a second completion after the reboot writes no second row');
  const pj = await playerJourney();
  ok(pj.journey.stage === 'signed' && pj.journey.nextAction.code === 'NONE' && (await S.j('GET', '/org/players/pl-adeyemi', undefined, maria.token)).body.contractStatus === 'under_contract', 'the player\'s journey says signed; the player is under contract');
  neg((await S.j('POST', '/player/availability', { contractStatus: 'free_agent' }, kola.token)).status === 409, 'the canonical contract still owns the word after the reboot');
  const store = openStore(DATA).load().db;
  neg(!('recruitmentJourneys' in store) && !('recruitmentJourneyStates' in store), 'no journey store appeared on disk');
}

// ================================================================ 3 — planted cases across five restarts
section('3 — legacy and corrupt cases across five restarts: untouched, never repaired');
{
  const mk = async (playerId) => { const rr = await S.j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, maria.token); const id = rr.status === 201 ? rr.body.room.roomId : rr.body?.existingRoomId; await lifecycle(id, 'startReview'); return id; };
  const LEG = await mk('pl-okafor'); const BAD = await mk('pl-svensson'); const LSIGN = await mk('pl-tanaka');
  let db = await S.stop();
  const plant = (id, chain, extraLast = {}) => {
    const k = db.recruitmentCases.find((x) => x.id === id);
    let prev = k.room.status; let tt = Math.max(Date.now(), ...(k.history ?? []).map((h) => Number(h.at) || 0));
    for (const to of chain) { tt += H; k.history.push({ id: `hist-p8p-${Math.random().toString(36).slice(2, 8)}`, at: tt, action: 'room_status_changed', by: { kind: 'org', id: 'legacy', name: 'Legacy' }, detail: { from: prev, to, reasonCodes: [], ...(to === chain[chain.length - 1] ? extraLast : {}) } }); prev = to; }
    k.room.status = chain[chain.length - 1]; k.stage = chain[chain.length - 1] === 'signed' ? 'closed' : 'review'; k.room.rev = (k.room.rev ?? 1) + chain.length;
    return k;
  };
  plant(LEG, ['contacted', 'trial_requested', 'trial_scheduled', 'trial_completed']);
  plant(BAD, ['contacted'], { contactId: 'rct-missing', trigger: 'contact:rct-missing' });
  const k3 = plant(LSIGN, ['offer_consideration', 'offer_made', 'signed']);
  db.signings.push({ id: 'sign-p8p-legacy', orgId: 'org-eastport', playerId: 'pl-tanaka', ts: Date.now() - DAY, method: 'LEGACY_RECORDED', contract: null, scoutUserId: 'legacy', scoutName: 'Legacy', insideAttributionWindow: false });
  k3.links.signingId = 'sign-p8p-legacy';
  const st0 = openStore(DATA); const snap = st0.load(); snap.db = db; st0.save(snap);
  const snapshot = (kase) => JSON.stringify({ status: kase.room.status, stage: kase.stage, rev: kase.room.rev, history: kase.history.length, links: kase.links });
  const fps = {};
  for (let i = 1; i <= 5; i += 1) {
    S = await bootOn(DATA, PORT); ok(S.up, `restart ${i}`); await login();
    const a = await journey(LEG); const b = await journey(BAD); const c3 = await journey(LSIGN);
    const now = { LEG: fingerprint(a), BAD: fingerprint(b), LSIGN: fingerprint(c3) };
    if (i === 1) {
      Object.assign(fps, now);
      ok(a.journey.classification === 'legacy' && a.trials.length === 0 && a.journey.nextAction.code === 'COMPLETE_ASSESSMENT', 'legacy trial_completed: legacy, no Trial, a safe next action');
      neg(b.journey.classification === 'integrity_error' && b.journey.integrity.includes('STALE_POINTER'), 'a claimed-but-missing Contact: integrity_error, STALE_POINTER');
      ok(c3.journey.stage === 'signed' && c3.outcome.signing?.id === 'sign-p8p-legacy' && c3.outcome.signingPackages.length === 0, 'legacy signed: the legacy row named, no package');
    } else {
      ok(now.LEG === fps.LEG && now.BAD === fps.BAD && now.LSIGN === fps.LSIGN, `restart ${i}: all three projections identical to restart 1`);
    }
    const d2 = await S.stop();
    const same = ['LEG', 'BAD', 'LSIGN'].every((k) => snapshot(d2.recruitmentCases.find((x) => x.id === ({ LEG, BAD, LSIGN })[k])) === snapshot(db.recruitmentCases.find((x) => x.id === ({ LEG, BAD, LSIGN })[k])));
    neg(same && d2.recruitmentContacts.every((c) => c.caseId !== BAD) && d2.trials.every((t) => t.caseId !== LEG) && (d2.signingPackages ?? []).every((p) => p.caseId !== LSIGN), `restart ${i}: nothing repaired, nothing fabricated on disk`);
  }
  S = await bootOn(DATA, PORT); ok(S.up, 'final boot'); await login();
}

// ================================================================ 4 — migration replay
section('4 — the migration ledger on replay');
{
  const h = await fetch(`http://localhost:${PORT}/health`);
  ok(h.headers.get('x-scoutbox-schema') === String(SCHEMA_VERSION), `schema ${SCHEMA_VERSION} on the wire`);
  const log = S.log();
  neg(!/applied\s+m2\d\d_/.test(log) || /applied 0/.test(log), 'no migration step applied on replay');
}

await S.stop();
console.log(`\nM23 P8 Recruitment Journey Persistence: ${passed} checks passed, ${negatives} negative, ${failures} failed`);
if (failures) console.error(`✗ M23 P8 Recruitment Journey Persistence has ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
