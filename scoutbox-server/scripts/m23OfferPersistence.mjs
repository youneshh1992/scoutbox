// M23 P6 — persistence, restart and corruption audit for the canonical Offer.
//
//   1  no P6 migration: the schema is what P5.7 left (2307); `recruitmentOffers`
//      is module-guaranteed, created empty at registration, and a snapshot
//      without it boots with an empty store — nothing is backfilled and no
//      lifecycle state is reinterpreted as an Offer (§60–§62)
//   2  a real journey — DRAFT, ISSUED+ACCEPTED, ISSUED+DECLINED, ISSUED+WITHDRAWN,
//      SUPERSEDED — survives SIGTERM and a reboot byte-faithfully: revisions,
//      responses, keys, history, read receipts, case stages; no signing appears
//   3  idempotency keys still replay after the reboot; the exact issued
//      revision is still immutable; a stale rev is still a conflict
//   4  a corrupt Offer row is named and refused, never repaired, never
//      fabricated, and never lets the lifecycle move; its neighbours are fine
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, SCHEMA_VERSION } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { offerIntegrity } from '../m28/offer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const H = 3_600_000; const DAY = 24 * H;

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

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

const PORT = 5900 + Math.floor(Math.random() * 200);
const T0 = Date.now();
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };
const S_NOTE = 'PRIVATE_NOTE_PERSISTS_9911';

// ------------------------------------------------------------- 1 — schema
section('1 — no P6 migration: schema 2307, a module-guaranteed store, an absent store boots empty');
{
  ok(SCHEMA_VERSION === 2307 && MIGRATIONS.length === 17 && !MIGRATIONS.some((m) => /offer/i.test(m.id)), `1.1 schema ${SCHEMA_VERSION}, ${MIGRATIONS.length} migrations, none named for an Offer`);
  ok(guaranteeFor('recruitmentOffers') === 'module', '1.2 recruitmentOffers is module-guaranteed (created at registration, every boot)');
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23op-1-'));
  const s1 = await bootOn(DIR, PORT);
  ok(s1.up, '1.3 a fresh store boots');
  const h = (await s1.j('GET', '/healthz')).body;
  ok(h.schemaVersion === 2307, `1.4 and reports schema ${h.schemaVersion}`);
  const db1 = await s1.stop();
  ok(Array.isArray(db1.recruitmentOffers) && db1.recruitmentOffers.length === 0, '1.5 the persisted snapshot carries an empty recruitmentOffers list');
  // A snapshot from before P6: the store simply absent. Boot must create it empty and reinterpret nothing.
  delete db1.recruitmentOffers;
  const casesBefore = JSON.stringify(db1.recruitmentCases.map((c) => [c.id, c.room?.status ?? null]));
  openStore(DIR).save({ db: db1 });
  const s2 = await bootOn(DIR, PORT);
  ok(s2.up && !/applied/.test(s2.log()), '1.6 a pre-P6 snapshot boots with no migration applied');
  const maria = (await s2.j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  const room = await s2.j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
  const RID = room.body?.room?.roomId ?? room.body?.existingRoomId;
  const jr = (await s2.j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body;
  ok(jr.offer?.available === true && jr.offer.records.length === 0, '1.7 the journey reports the store available with no Offers — none was invented from the lifecycle (§62)');
  const db2 = await s2.stop();
  neg(Array.isArray(db2.recruitmentOffers) && db2.recruitmentOffers.length === 0 && JSON.stringify(db2.recruitmentCases.filter((c) => c.id !== RID).map((c) => [c.id, c.room?.status ?? null])) === casesBefore, '1.8 after the boot: an empty store, and every pre-existing case exactly where it was');
}

// ------------------------------------------------------------ 2 — journey
section('2 — a real journey survives SIGTERM and a reboot byte-faithfully');
const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23op-2-'));
const R = {};
{
  const s = await bootOn(DIR, PORT);
  ok(s.up, '2.1 booted on a fresh store');
  const { j } = s;
  const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  const playerTok = async (id) => (await j('POST', '/auth/player/login', { playerId: id })).body.token;
  const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
  const lifecycle = async (RID, action) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID)).case.rev }, maria.token);
  async function toConsideration(playerId) {
    const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, maria.token);
    const RID = r.body?.room?.roomId ?? r.body?.existingRoomId;
    await lifecycle(RID, 'startReview'); await lifecycle(RID, 'shortlist');
    const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', note: 'internal' }, maria.token);
    const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, maria.token);
    if (fin.status !== 201) throw new Error(`finalize ${JSON.stringify(fin.body)}`);
    return RID;
  }
  const create = (RID, body) => j('POST', `/org/rooms/${RID}/offers`, body, maria.token, at(T0));
  const issue = (id, rev, k) => j('POST', `/org/offers/${id}/issue`, { expectedRev: rev, clientKey: k }, maria.token, at(T0));
  const signingsBefore = (await j('GET', '/healthz')).body;
  void signingsBefore;

  // a) DRAFT — Kola
  R.kola = { RID: await toConsideration('pl-adeyemi') };
  const c1 = await create(R.kola.RID, { terms: { role: 'Winger' }, internalNote: S_NOTE, clientKey: 'P-create-kola' });
  R.kola.OID = c1.body.offer.id; R.kola.view = c1.body.offer;
  // b) ISSUED → ACCEPTED — Kim
  R.kim = { RID: await toConsideration('pl-kim') };
  const c2 = await create(R.kim.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, recipientMessage: 'Welcome.', clientKey: 'P-create-kim' });
  R.kim.OID = c2.body.offer.id;
  const i2 = await issue(R.kim.OID, 1, 'P-issue-kim');
  R.kim.R1 = i2.body.offer.currentRevisionId;
  const kim = await playerTok('pl-kim');
  await j('GET', `/player/offers/${R.kim.OID}`, undefined, kim, at(T0 + H)); // a read receipt
  const a2 = await j('POST', `/player/offers/${R.kim.OID}/accept`, { revisionId: R.kim.R1, clientKey: 'P-accept-kim' }, kim, at(T0 + 2 * H));
  ok(a2.status === 200 && a2.body.lifecycle.to === 'offer_accepted', '2.2 Kim accepted; the case at offer_accepted');
  // c) ISSUED → DECLINED — Okafor
  R.chi = { RID: await toConsideration('pl-okafor') };
  const c3 = await create(R.chi.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: 'P-create-chi' });
  R.chi.OID = c3.body.offer.id;
  const i3 = await issue(R.chi.OID, 1, 'P-issue-chi');
  R.chi.R1 = i3.body.offer.currentRevisionId;
  const chi = await playerTok('pl-okafor');
  const d3 = await j('POST', `/player/offers/${R.chi.OID}/decline`, { revisionId: R.chi.R1, reason: 'No.', clientKey: 'P-decline-chi' }, chi, at(T0 + 2 * H));
  ok(d3.status === 200 && d3.body.lifecycle.to === 'offer_declined', '2.3 Okafor declined; the case at offer_declined');
  // d) ISSUED → WITHDRAWN — Svensson
  R.sven = { RID: await toConsideration('pl-svensson') };
  const c4 = await create(R.sven.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: 'P-create-sven' });
  R.sven.OID = c4.body.offer.id;
  await issue(R.sven.OID, 1, 'P-issue-sven');
  const w4 = await j('POST', `/org/offers/${R.sven.OID}/withdraw`, { expectedRev: 2, reason: 'Budget.', clientKey: 'P-withdraw-sven' }, maria.token, at(T0 + H));
  ok(w4.status === 200 && w4.body.lifecycle.to === 'offer_consideration', '2.4 the Offer to Svensson withdrawn; the case back at offer_consideration');
  // e) SUPERSEDED — Tanaka: revision 1 issued, revision 2 issued
  R.tan = { RID: await toConsideration('pl-tanaka') };
  const c5 = await create(R.tan.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: 'P-create-tan' });
  R.tan.OID = c5.body.offer.id;
  const i5 = await issue(R.tan.OID, 1, 'P-issue-tan-1');
  R.tan.R1 = i5.body.offer.currentRevisionId;
  const rv5 = await j('POST', `/org/offers/${R.tan.OID}/revise`, { terms: { ...TERMS, squad: 'First team' }, expiresAt: T0 + 9 * DAY, expectedRev: 2, clientKey: 'P-revise-tan' }, maria.token, at(T0 + H));
  // The server clock never runs backwards: revision 2 was opened at T0+H, so it is issued at T0+H (P6.1's ordering rule refuses a revision issued before it was created).
  const i5b = await j('POST', `/org/offers/${R.tan.OID}/issue`, { expectedRev: 3, clientKey: 'P-issue-tan-2' }, maria.token, at(T0 + H));
  R.tan.R2 = i5b.body.offer.currentRevisionId;
  ok(rv5.status === 201 && i5b.status === 200 && i5b.body.offer.revisions.find((r) => r.id === R.tan.R1).status === 'SUPERSEDED', '2.5 Tanaka: revision 1 superseded by revision 2');

  // Capture every club view and every recipient view before the stop.
  R.before = {};
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan']) {
    R.before[who] = (await j('GET', `/org/offers/${R[who].OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer;
    R.before[`${who}_hist`] = (await j('GET', `/org/offers/${R[who].OID}/history`, undefined, maria.token)).body.items;
    R.before[`${who}_stage`] = (await journey(R[who].RID)).lifecycle.currentStage;
  }
  R.before.kimRecipient = (await j('GET', `/player/offers/${R.kim.OID}`, undefined, kim, at(T0 + 3 * H))).body.offer;
  R.before.stages = { kola: 'offer_consideration', kim: 'offer_accepted', chi: 'offer_declined', sven: 'offer_consideration', tan: 'offer_made' };
  ok(Object.entries(R.before.stages).every(([w, st]) => R.before[`${w}_stage`] === st), '2.6 the five cases sit where the workflow put them');

  const db = await s.stop();
  ok(Array.isArray(db.recruitmentOffers) && db.recruitmentOffers.length === 5, '2.7 SIGTERM: the snapshot holds five Offers');
  neg((db.signings ?? []).every((x) => x.playerId !== 'pl-kim'), '2.8 and no signing for the player who accepted (§83)');
  neg(!db.recruitmentCases.some((c) => c.room?.status === 'signed'), '2.9 no case is signed');
  const stored = Object.fromEntries(db.recruitmentOffers.map((o) => [o.id, o]));
  ok(stored[R.kola.OID].status === 'DRAFT' && stored[R.kim.OID].status === 'ACCEPTED' && stored[R.chi.OID].status === 'DECLINED' && stored[R.sven.OID].status === 'WITHDRAWN' && stored[R.tan.OID].status === 'ISSUED', '2.10 stored statuses: DRAFT, ACCEPTED, DECLINED, WITHDRAWN, ISSUED');
  ok(stored[R.kim.OID].responses.length === 1 && stored[R.kim.OID].responses[0].clientKey === 'P-accept-kim' && stored[R.kim.OID].readReceipts.length === 1 && stored[R.tan.OID].revisions.length === 2 && stored[R.tan.OID].keys.issue.length === 2, '2.11 responses, receipts, revisions and idempotency keys are on the rows');
  ok(db.recruitmentOffers.every((o) => offerIntegrity(o).length === 0), '2.12 every stored row passes the integrity rules');
  R.snapshot = JSON.stringify(db.recruitmentOffers);
}

// ------------------------------------------------------------- 3 — reboot
section('3 — after the reboot: identical views, keys replay, immutability and revs hold');
{
  const s = await bootOn(DIR, PORT);
  ok(s.up && !/applied/.test(s.log()), '3.1 rebooted on the same store with no migration applied');
  const { j } = s;
  const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  const kim = (await j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
  const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan']) {
    const now = (await j('GET', `/org/offers/${R[who].OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer;
    ok(JSON.stringify(now) === JSON.stringify(R.before[who]), `3.2 ${who}: the club view is byte-identical after the reboot`);
    const hist = (await j('GET', `/org/offers/${R[who].OID}/history`, undefined, maria.token)).body.items;
    ok(JSON.stringify(hist) === JSON.stringify(R.before[`${who}_hist`]), `3.3 ${who}: the history is byte-identical`);
    ok((await journey(R[who].RID)).lifecycle.currentStage === R.before.stages[who], `3.4 ${who}: the case is still at ${R.before.stages[who]}`);
  }
  ok(JSON.stringify((await j('GET', `/player/offers/${R.kim.OID}`, undefined, kim, at(T0 + 3 * H))).body.offer) === JSON.stringify(R.before.kimRecipient), '3.5 Kim\'s recipient view is byte-identical (the read receipt was already there, so no new one)');
  ok((await j('GET', `/org/offers/${R.kola.OID}`, undefined, maria.token)).body.offer.currentRevision.internalNote === S_NOTE, '3.6 the draft\'s internal note persisted');
  // keys replay
  ok((await j('POST', `/org/rooms/${R.kola.RID}/offers`, { terms: { role: 'Winger' }, internalNote: S_NOTE, clientKey: 'P-create-kola' }, maria.token, at(T0))).body.idempotent === true, '3.7 the create key replays');
  ok((await j('POST', `/org/offers/${R.tan.OID}/issue`, { expectedRev: 1, clientKey: 'P-issue-tan-2' }, maria.token, at(T0))).body.idempotent === true, '3.8 the issue key of revision 2 replays (before the rev is checked)');
  neg((await j('POST', `/org/offers/${R.tan.OID}/issue`, { expectedRev: 1, clientKey: 'P-issue-tan-1' }, maria.token, at(T0))).body.error === 'OFFER_IDEMPOTENCY_CONFLICT', '3.9 the issue key of revision 1 is a conflict — keys are never overwritten');
  ok((await j('POST', `/player/offers/${R.kim.OID}/accept`, { revisionId: R.kim.R1, clientKey: 'P-accept-kim' }, kim, at(T0))).body.idempotent === true, '3.10 the accept key replays');
  ok((await j('POST', `/org/offers/${R.sven.OID}/withdraw`, { expectedRev: 1, clientKey: 'P-withdraw-sven' }, maria.token, at(T0))).body.idempotent === true, '3.11 the withdraw key replays');
  ok((await j('POST', `/org/offers/${R.tan.OID}/revise`, { expectedRev: 1, clientKey: 'P-revise-tan' }, maria.token, at(T0))).body.idempotent === true, '3.12 the revise key replays');
  // immutability and revs
  neg((await j('PATCH', `/org/offers/${R.kim.OID}/draft`, { terms: { role: 'Striker' }, expectedRev: R.before.kim.rev }, maria.token, at(T0))).body.error === 'OFFER_STATE_INVALID', '3.13 the accepted revision cannot be edited');
  neg((await j('PATCH', `/org/offers/${R.kola.OID}/draft`, { terms: { role: 'Striker' }, expectedRev: 99 }, maria.token, at(T0))).body.error === 'OFFER_REV_CONFLICT', '3.14 a stale rev on the draft is still a conflict');
  const e = await j('PATCH', `/org/offers/${R.kola.OID}/draft`, { terms: { role: 'Striker' }, expectedRev: R.before.kola.rev }, maria.token, at(T0));
  ok(e.status === 200 && e.body.offer.rev === R.before.kola.rev + 1, '3.15 the right rev edits the draft and moves it one');
  neg((await j('POST', `/player/offers/${R.tan.OID}/accept`, { revisionId: R.tan.R1, clientKey: key() }, (await j('POST', '/auth/player/login', { playerId: 'pl-tanaka' })).body.token, at(T0 + 3 * H))).body.error === 'OFFER_SUPERSEDED', '3.16 the superseded revision is still not answerable');
  const a = await j('POST', `/player/offers/${R.tan.OID}/accept`, { revisionId: R.tan.R2, clientKey: key() }, (await j('POST', '/auth/player/login', { playerId: 'pl-tanaka' })).body.token, at(T0 + 3 * H));
  ok(a.status === 200 && a.body.lifecycle.to === 'offer_accepted', '3.17 the live revision 2 is, and the case moves — the lifecycle coupling survived the reboot');
  neg(a.body.signing?.created === false && (await journey(R.tan.RID)).outcome.signing === null, '3.18 and still no signing');
  const db = await s.stop();
  ok(db.recruitmentOffers.length === 5 && db.recruitmentOffers.every((o) => offerIntegrity(o).length === 0), '3.19 five sound rows after the second stop');
  R.db = db;
}

// --------------------------------------------------------- 4 — corruption
section('4 — a corrupt Offer row is named and refused, never repaired, and never moves a case');
{
  const db = R.db;
  const corrupt = { ...db.recruitmentOffers.find((o) => o.id === R.sven.OID), id: 'rof-corrupt', revisions: [], currentRevisionId: 'rofr-none', status: 'ISSUED' };
  const fake = { id: 'rof-fake-accepted', orgId: 'org-eastport', caseId: R.kola.RID, playerId: 'pl-adeyemi', type: 'direct_recruitment', status: 'ACCEPTED', currentRevisionId: 'rofr-f1', revisions: [{ id: 'rofr-f1', revisionNumber: 1, status: 'ACCEPTED', terms: {}, issuedAt: T0, expiresAt: T0 + DAY, recipientSnapshot: { type: 'player', playerId: 'pl-adeyemi' } }], responses: [], readReceipts: [], history: [], keys: {}, createdAt: T0, rev: 1 };
  db.recruitmentOffers.push(corrupt, fake);
  const kolaCase = db.recruitmentCases.find((c) => c.id === R.kola.RID);
  const kolaStage = kolaCase.room.status;
  openStore(DIR).save({ db });
  const s = await bootOn(DIR, PORT);
  ok(s.up, '4.1 the server boots with two corrupt rows present — corruption is not fatal to the process');
  const { j } = s;
  const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
  const r = await j('GET', '/org/offers/rof-corrupt', undefined, maria.token);
  neg(r.status === 500 && r.body.error === 'OFFER_STATE_UNKNOWN' && !has(r.body, 'revisions') && !has(r.body, 'stack'), '4.2 the club reading the corrupt row gets a generic 500 OFFER_STATE_UNKNOWN — named, not repaired, nothing internal in the body');
  neg((await j('GET', '/org/offers/rof-fake-accepted', undefined, maria.token)).status === 500, '4.3 an ACCEPTED row with no response is corruption too');
  const jr = (await j('GET', `/org/rooms/${R.kola.RID}/journey`, undefined, maria.token)).body;
  neg(jr.lifecycle.currentStage === kolaStage && !has(jr.offer.records, 'rof-fake-accepted') && jr.offer.records.some((o) => o.id === R.kola.OID), '4.4 Kola\'s case did not move and the journey omits the fake row while listing the real one');
  neg((await j('POST', `/org/rooms/${R.kola.RID}/lifecycle`, { action: 'recordOfferAccepted', expectedRev: jr.case.rev }, maria.token)).status >= 400, '4.5 a fabricated ACCEPTED row is not acceptance evidence: recordOfferAccepted is refused');
  neg(!(await j('GET', '/player/offers', undefined, kola, at(T0))).body.items.some((o) => o.id === 'rof-fake-accepted'), '4.6 the recipient list omits it');
  ok((await j('GET', `/org/offers/${R.kim.OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer.status === 'ACCEPTED', '4.7 a sound neighbour still reads');
  const db2 = await s.stop();
  neg(db2.recruitmentOffers.length === 7 && db2.recruitmentOffers.find((o) => o.id === 'rof-corrupt').revisions.length === 0, '4.8 nothing was repaired or dropped on boot or on stop');
  R.db2 = db2;
}

// ------------------------------------------------- 5 — P6.1 hardening after a restart
section('5 — P6.1: lazy expiry, temporal corruption, unknown statuses, legacy rows, the latest-revision pointer and the same-agency rule after a restart');
{
  const db = R.db2;
  const fresh = (base, id, patch) => ({ ...structuredClone(base), id, keys: { create: null, issue: [], withdraw: [], revise: [] }, responses: [], readReceipts: [], history: [], ...patch });
  const issuedRow = db.recruitmentOffers.find((o) => o.id === R.chi.OID); // an ISSUED→DECLINED shape to clone from
  const rev = ({ rid, ...patch }) => ({ ...structuredClone(issuedRow.revisions[0]), id: `rofr-${rid}`, revisionNumber: 1, status: 'ISSUED', respondedAt: null, response: null, ...patch });
  // a) an ISSUED row whose expiry has passed at the read instant: stored ISSUED, read EXPIRED, never rewritten
  const svenCase = db.recruitmentCases.find((c) => c.id === R.sven.RID);
  const lazy = fresh(issuedRow, 'rof-lazy', { caseId: R.sven.RID, playerId: 'pl-svensson', status: 'ISSUED', currentRevisionId: 'rofr-lazy', revisions: [rev({ rid: 'lazy', createdAt: T0, issuedAt: T0, expiresAt: T0 + 2 * H, recipientSnapshot: { ...issuedRow.revisions[0].recipientSnapshot, playerId: 'pl-svensson' } })] });
  // b) temporal corruption: issued before created; responded before issued; expiry beyond the bound; a future issue instant
  const tIssuedBeforeCreated = fresh(issuedRow, 'rof-t1', { status: 'ISSUED', currentRevisionId: 'rofr-t1', revisions: [rev({ rid: 't1', createdAt: T0 + H, issuedAt: T0, expiresAt: T0 + DAY })] });
  const tExpiryBound = fresh(issuedRow, 'rof-t2', { status: 'ISSUED', currentRevisionId: 'rofr-t2', revisions: [rev({ rid: 't2', createdAt: T0, issuedAt: T0, expiresAt: T0 + 400 * DAY })] });
  const tRespondedBeforeIssued = fresh(issuedRow, 'rof-t3', { status: 'DECLINED', currentRevisionId: 'rofr-t3', revisions: [rev({ rid: 't3', createdAt: T0, issuedAt: T0 + H, expiresAt: T0 + DAY, status: 'DECLINED', respondedAt: T0, response: { responseType: 'declined', actorType: 'player', actorId: 'pl-okafor', at: T0 } })], responses: [{ id: 'rsp-t3', revisionId: 'rofr-t3', responseType: 'declined', at: T0, actorType: 'player', actorId: 'pl-okafor' }] });
  const tUnknownStatus = fresh(issuedRow, 'rof-t4', { status: 'SIGNED', currentRevisionId: 'rofr-t4', revisions: [rev({ rid: 't4', status: 'SIGNED' })] });
  const tRevisionUnknown = fresh(issuedRow, 'rof-t5', { status: 'ISSUED', currentRevisionId: 'rofr-t5', revisions: [rev({ rid: 't5', status: 'countersigned' })] });
  const tPointer = fresh(issuedRow, 'rof-t6', { status: 'ISSUED', currentRevisionId: 'rofr-t6a', revisions: [rev({ rid: 't6a', revisionNumber: 1, status: 'SUPERSEDED', supersededByRevisionId: 'rofr-t6b' }), rev({ rid: 't6b', revisionNumber: 2, status: 'ISSUED', supersedesRevisionId: 'rofr-t6a' })] }); // pointer at a non-latest revision
  const tNegativeNumber = fresh(issuedRow, 'rof-t7', { status: 'ISSUED', currentRevisionId: 'rofr-t7', revisions: [rev({ rid: 't7', revisionNumber: 0 })] });
  // c) case/Offer disagreement: an ACCEPTED Offer on a case the lifecycle says declined
  const chiCase = db.recruitmentCases.find((c) => c.id === R.chi.RID);
  const disagree = fresh(issuedRow, 'rof-t8', { status: 'ACCEPTED', currentRevisionId: 'rofr-t8', revisions: [rev({ rid: 't8', status: 'ACCEPTED', respondedAt: T0 + 2 * H, response: { responseType: 'accepted', actorType: 'player', actorId: 'pl-okafor', at: T0 + 2 * H } })], responses: [{ id: 'rsp-t8', revisionId: 'rofr-t8', responseType: 'accepted', at: T0 + 2 * H, actorType: 'player', actorId: 'pl-okafor' }] });
  // d) a legacy row: a case at offer_made with no Offer row at all (a pre-P6 lifecycle written by the legacy status writer)
  const legacyCase = db.recruitmentCases.find((c) => c.id === R.kim.RID);
  void legacyCase;
  const martinCase = { ...structuredClone(svenCase), id: 'case-legacy-made', playerId: 'pl-martin', room: { ...structuredClone(svenCase.room), status: 'offer_made', id: 'case-legacy-made' }, history: [] };
  db.recruitmentCases.push(martinCase);
  db.recruitmentOffers.push(lazy, tIssuedBeforeCreated, tExpiryBound, tRespondedBeforeIssued, tUnknownStatus, tRevisionUnknown, tPointer, tNegativeNumber, disagree);
  const rowsBefore = JSON.stringify(db.recruitmentOffers);
  const casesBefore = JSON.stringify(db.recruitmentCases.map((c) => [c.id, c.room?.status ?? null]));
  openStore(DIR).save({ db });
  const s = await bootOn(DIR, PORT);
  ok(s.up && !/applied/.test(s.log()), '5.1 the server boots over nine planted rows and a legacy case — no migration, no crash');
  const { j } = s;
  const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
  const sven = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
  const chi = (await j('POST', '/auth/player/login', { playerId: 'pl-okafor' })).body.token;
  // a) lazy expiry
  ok((await j('GET', '/org/offers/rof-lazy', undefined, maria.token, at(T0 + H))).body.offer.status === 'ISSUED', '5.2 before its expiry the planted ISSUED row reads ISSUED');
  neg((await j('GET', '/org/offers/rof-lazy', undefined, maria.token, at(T0 + 3 * H))).body.offer.status === 'EXPIRED' && (await j('GET', '/org/offers/rof-lazy', undefined, maria.token, at(T0 + 3 * H))).body.offer.currentRevision.storedStatus === 'ISSUED', '5.3 after it, EXPIRED is derived at read time; the stored status is still ISSUED');
  neg((await j('POST', '/player/offers/rof-lazy/accept', { revisionId: 'rofr-lazy', clientKey: key() }, sven, at(T0 + 3 * H))).body.error === 'OFFER_EXPIRED', '5.4 and an acceptance after expiry is refused after the restart — no background job was needed');
  // b) temporal corruption and unknown statuses fail closed, named, never repaired
  for (const [id, why] of [['rof-t1', 'issued before it was created'], ['rof-t2', 'an expiry beyond the bound'], ['rof-t3', 'responded before it was issued'], ['rof-t4', 'an unknown Offer status'], ['rof-t5', 'an unknown revision status'], ['rof-t6', 'a current-revision pointer at a superseded revision'], ['rof-t7', 'a revision number below 1']]) {
    const r = await j('GET', `/org/offers/${id}`, undefined, maria.token, at(T0 + H));
    neg(r.status === 500 && r.body.error === 'OFFER_STATE_UNKNOWN' && !has(r.body, 'revisions') && !has(r.body, 'stack'), `5.5 ${id} (${why}): 500 OFFER_STATE_UNKNOWN, nothing internal in the body`);
    const m = await j('POST', `/org/offers/${id}/withdraw`, { expectedRev: 1, clientKey: key() }, maria.token, at(T0 + H));
    neg(m.status === 500 && m.body.error === 'OFFER_STATE_UNKNOWN', `5.6 ${id}: a mutation on it is refused the same way — no repair through a write`);
  }
  neg(!(await j('GET', '/player/offers', undefined, chi, at(T0 + H))).body.items.some((o) => /^rof-t/.test(o.id)), '5.7 the recipient list omits every planted row');
  // c) Offer/case disagreement
  const dr = await j('GET', '/org/offers/rof-t8', undefined, maria.token, at(T0 + 3 * H));
  neg(dr.status === 500 && dr.body.error === 'OFFER_STATE_UNKNOWN', '5.8 an ACCEPTED Offer on a case the lifecycle says offer_declined is refused as corruption (ACCEPTED_BUT_CASE_DECLINED)');
  const chiJourney = (await j('GET', `/org/rooms/${R.chi.RID}/journey`, undefined, maria.token)).body;
  neg(chiJourney.lifecycle.currentStage === 'offer_declined', '5.9 the case did not move to match the planted row');
  // d) the legacy case at offer_made with no Offer row
  const lj = await j('GET', '/org/rooms/case-legacy-made/journey', undefined, maria.token);
  neg(lj.status === 200 && lj.body.lifecycle.currentStage === 'offer_made' && lj.body.offer.records.length === 0, '5.10 a legacy case at offer_made with no Offer row is reported as it is: at offer_made, with no Offer invented');
  const ls = await j('GET', '/org/rooms/case-legacy-made/offers', undefined, maria.token, at(T0));
  neg(ls.status === 200 && ls.body.offers.length === 0 && ls.body.requirements.draftBlockers.includes('CASE_STATE'), '5.11 its Offer surface lists nothing and refuses a draft by case state');
  neg((await j('POST', '/org/rooms/case-legacy-made/lifecycle', { action: 'recordOfferAccepted', expectedRev: lj.body.case.rev }, maria.token)).status >= 400, '5.12 and the lifecycle cannot record an acceptance no Offer evidences');
  neg(!(await j('GET', '/player/offers', undefined, (await j('POST', '/auth/player/login', { playerId: 'pl-martin' })).body.token, at(T0))).body.items.length, '5.13 the legacy case\'s player sees no Offer');
  // e) the latest-revision pointer of a sound multi-revision Offer survives
  const tan = (await j('GET', `/org/offers/${R.tan.OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer;
  ok(tan.currentRevision.revisionNumber === 2 && tan.currentRevisionId === R.tan.R2 && tan.revisions.find((r) => r.id === R.tan.R1).status === 'SUPERSEDED', '5.14 Tanaka\'s current revision is still revision 2; revision 1 is still SUPERSEDED');
  // f) the same-agency rule after a restart (a share made before the restart)
  const alex = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })).body;
  await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
  await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
  const ana = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
  const bea = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Bea Agent', role: 'Agent', platform: 'agent' })).body;
  for (const a of [ana, bea]) {
    await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
    await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-P' }, a.token);
    await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-P-ENG', memberAssociation: 'ENG' }, a.token);
  }
  const kim = (await j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
  const req = await j('POST', '/org/agent/clients/request', { playerId: 'pl-kim', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const REP = req.body?.relationship?.id;
  const conf = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kim);
  ok(!!REP && conf.status === 200, '5.15 Ana represents Kim (employment)');
  const sh = await j('POST', `/player/offers/${R.kim.OID}/share-agent`, {}, kim, at(Date.now()));
  ok(sh.status === 200 && sh.body.offer.agentShared === true, '5.16 Kim shares the accepted Offer with Ana');
  ok((await j('GET', `/org/agent/clients/${REP}/offers`, undefined, ana.token, at(Date.now()))).body.items?.length === 1, '5.17 Ana reads it');
  neg((await j('GET', `/org/agent/clients/${REP}/offers`, undefined, bea.token, at(Date.now()))).status === 404, '5.18 Bea (same agency) gets NOT FOUND');
  const db3 = await s.stop();
  const s2 = await bootOn(DIR, PORT);
  ok(s2.up, '5.19 rebooted');
  const ana2 = (await s2.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Agent', role: 'Agent', platform: 'agent' })).body;
  const bea2 = (await s2.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Bea Agent', role: 'Agent', platform: 'agent' })).body;
  ok((await s2.j('GET', `/org/agent/clients/${REP}/offers`, undefined, ana2.token, at(Date.now()))).body.items?.length === 1, '5.20 the share survived the restart for Ana');
  neg((await s2.j('GET', `/org/agent/clients/${REP}/offers`, undefined, bea2.token, at(Date.now()))).status === 404, '5.21 and Bea still gets NOT FOUND after the restart');
  const db4 = await s2.stop();
  const planted = (d) => JSON.stringify(d.recruitmentOffers.filter((o) => /^rof-(lazy|t\d)$/.test(o.id)));
  neg(planted(db4) === planted(db3) && planted(db4) === JSON.stringify(JSON.parse(rowsBefore).filter((o) => /^rof-(lazy|t\d)$/.test(o.id))), '5.22 none of the planted rows was repaired, reordered or dropped by two boots and two stops');
  neg(JSON.stringify(db4.recruitmentCases.filter((c) => c.id !== R.kim.RID).map((c) => [c.id, c.room?.status ?? null])) === JSON.stringify(JSON.parse(casesBefore).filter(([id]) => id !== R.kim.RID)), '5.23 no case moved because of a planted row');
}

console.log(`\nM23 P6/P6.1 Offer persistence: ${passed} checks passed, ${negatives} negative (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P6 Offer persistence has failures.');
else console.log('all M23 P6 Offer persistence checks passed');
process.exit(process.exitCode ?? 0);
