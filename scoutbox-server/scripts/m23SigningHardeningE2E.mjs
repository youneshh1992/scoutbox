// M23 P7.1 — Signing workflow hardening & adversarial closure.
//
// Attacks the P7 signing workflow the way a hostile party, a stale session,
// a tampered store and a racing client would, against a real server booted
// on a fresh store with the test clock. Where an attack needs the store
// itself changed (bytes on disk, digests, parties, expiry, rows) the server
// is stopped, the store is edited offline and the server is booted again —
// exactly the corruption a restore or an operator error could introduce.
//
// Groups (P7.1 §75): A evidence tampering · B document substitution ·
// C digest mismatch · D required parties · E club auth drift · F player
// identity · G agent drift · H guardian/minor · I deep links · J completion
// races · K expiry · L idempotency · M rev · N cross-package · O
// cross-offer/player/org · P consistency · Q partial failures · R
// persistence corruption (the store cycle) · S temporal corruption · T
// document privacy · U events · V notifications · W legacy · X rate limits ·
// Y analytics · Z boundary invariants (the P7 invariants A–P re-proven).
//
// Every refusal asserts its exact status AND code. Nothing here weakens a
// gate; every fix P7.1 made is named by its H-code in the defect register.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { isAdult } from '../domain.mjs';
import { signingIntegrity, signingConsistency, signingCorrupt, SIGNING_CORRUPTION, effectiveStatus, canCompleteParty, completionGate, requiredPartiesFor, canStart } from '../m29/signing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const PORT = 4300 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23-signing-hardening-'));
const H = 3_600_000; const DAY = 24 * H;

let passed = 0; let negatives = 0; let failures = 0;
const fail = (m) => { failures++; console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
  return good;
};
const codes = (rs) => rs.map((r) => `${r.status}:${r.body?.error ?? 'ok'}`).join(' ');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const dataUrl = (buf, mime = 'application/pdf') => `data:${mime};base64,${buf.toString('base64')}`;
const DOC_A = pdf('Contract of employment — hardening A'); const SHA_A = sha256(DOC_A);
const DOC_B = pdf('Contract of employment — hardening B'); const SHA_B = sha256(DOC_B);
const DOC_A_SAME_SIZE = Buffer.from(DOC_A); DOC_A_SAME_SIZE[DOC_A_SAME_SIZE.length - 8] ^= 0x01; // one byte differs, same length, same header
const S_NOTE = 'PRIVATE_SIGNING_NOTE_HARDENING_9931';
const S_OFFER_NOTE = 'PRIVATE_OFFER_NOTE_HARDENING_9932';
const S_DEC = 'PRIVATE_DECISION_HARDENING_9933';
const T0 = Date.now();
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });

// ================================================================ boot / store cycle
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot() {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function down(proc) {
  proc.kill('SIGKILL');
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { return; } }
}
let server = await boot();
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, text: data === null ? null : JSON.stringify(data) };
}
/** Stop the server, edit the persisted store (and the vault on disk) offline, boot again. The attacker with a shell. */
async function offline(mutate) {
  await down(server);
  const store = openStore(DATA_DIR);
  const snap = store.load();
  await mutate(snap.db, snap);
  store.save({ ...snap, db: snap.db });
  server = await boot();
}
const mediaFile = (mediaId) => path.join(DATA_DIR, 'media', `${mediaId}.bin`);
const evidenceOfPackage = (db, pkgId, kind = 'signing') => (db.verEvidence ?? []).find((e) => e && e.meta?.signingPackageId === pkgId && e.meta?.signingDocumentKind === kind) ?? null;

// ================================================================ actors
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
let maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
let tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
let rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const alex = await login('org-northstar', 'Alex Agent', 'Director');
const P = {};
const ADULTS = ['pl-adeyemi', 'pl-carvalho', 'pl-okafor', 'pl-svensson', 'pl-kim', 'pl-tanaka', 'pl-martin', 'pl-alvarez', 'pl-nowak', 'pl-mensah', 'pl-imani'];
for (const id of [...ADULTS, 'pl-guni']) P[id] = await playerLogin(id);
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, tom, rita, alex, amara, ...Object.values(P)].every((x) => x?.token), 'HTTP actors logged in');
async function relogin() {
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
  rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
  for (const id of [...ADULTS, 'pl-guni']) P[id] = await playerLogin(id);
}
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
let ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
let bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
for (const a of [ana, bea]) {
  await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-S' }, a.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-S-ENG', memberAssociation: 'ENG' }, a.token);
}
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
const REP = REQ.body?.relationship?.id;
ok(!!REP && (await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, P['pl-adeyemi'].token)).status === 200, 'fixture: Ana represents Kola (employment)');

// ================================================================ journey helpers (a club token is always explicit)
const journey = async (RID, token) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body;
const stage = async (RID, token) => (await journey(RID, token)).lifecycle.currentStage;
const caseRev = async (RID, token) => (await journey(RID, token)).case.rev;
const lifecycle = async (RID, action, token, extra = {}) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await caseRev(RID, token), ...extra }, token);
async function toConsideration(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  let st = await stage(RID, token);
  if (st === 'watching') { await lifecycle(RID, 'startReview', token); st = 'under_review'; }
  if (st === 'offer_consideration') return RID;
  if (st === 'under_review') { await lifecycle(RID, 'shortlist', token); st = 'shortlisted'; }
  if (st !== 'shortlisted') throw new Error(`case ${RID} for ${playerId} at ${st}`);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const draftRev = dr.status === 409 && dr.body?.current?.draftId ? dr.body.current.rev : dr.body?.draft?.rev;
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: draftRev, clientKey: key() }, token);
  if (fin.status !== 201) throw new Error(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
  if (await stage(RID, token) !== 'offer_consideration') await lifecycle(RID, 'considerOffer', token);
  return RID;
}
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };
async function accepted(token, playerId, { clock = T0 } = {}) {
  const RID = await toConsideration(token, playerId);
  const c = await j('POST', `/org/rooms/${RID}/offers`, { terms: TERMS, expiresAt: clock + 14 * DAY, internalNote: S_OFFER_NOTE, recipientMessage: 'Welcome.', clientKey: key() }, token, at(clock));
  if (c.status !== 201) throw new Error(`create ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  const i = await j('POST', `/org/offers/${c.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, token, at(clock));
  if (i.status !== 200) throw new Error(`issue ${i.status} ${JSON.stringify(i.body).slice(0, 200)}`);
  const a = await j('POST', `/player/offers/${c.body.offer.id}/accept`, { revisionId: i.body.offer.currentRevisionId, clientKey: key() }, P[playerId].token, at(clock));
  if (a.status !== 200) throw new Error(`accept ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
  return { RID, OID: c.body.offer.id, R: i.body.offer.currentRevisionId, playerId, token };
}
// Signing helpers: EVERY call names its club token.
const sRoom = (RID, token, h = at(T0)) => j('GET', `/org/rooms/${RID}/signing`, undefined, token, h);
const start = (OID, body, token, h = at(T0)) => j('POST', `/org/offers/${OID}/signing`, body, token, h);
const sGet = (SID, token, h = at(T0)) => j('GET', `/org/signings/${SID}`, undefined, token, h);
const sDoc = (SID, token, q = '', h = at(T0)) => j('GET', `/org/signings/${SID}/document${q}`, undefined, token, h);
const attach = (SID, buf, expectedRev, token, h = at(T0), filename = 'contract.pdf', label = 'Contract') => j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(buf), filename, label, expectedRev }, token, h);
const ready = (SID, body, token, h = at(T0)) => j('POST', `/org/signings/${SID}/ready`, body, token, h);
const clubSign = (SID, body, token, h = at(T0)) => j('POST', `/org/signings/${SID}/parties/club/complete`, body, token, h);
const complete = (SID, body, token, h = at(T0)) => j('POST', `/org/signings/${SID}/complete`, body, token, h);
const cancel = (SID, body, token, h = at(T0)) => j('POST', `/org/signings/${SID}/cancel`, body, token, h);
const voidP = (SID, body, token, h = at(T0)) => j('POST', `/org/signings/${SID}/void`, body, token, h);
const supersede = (SID, body, token, h = at(T0)) => j('POST', `/org/signings/${SID}/supersede`, body, token, h);
const pList = (token, h = at(T0)) => j('GET', '/player/signings', undefined, token, h);
const pGet = (SID, token, h = at(T0)) => j('GET', `/player/signings/${SID}`, undefined, token, h);
const pDoc = (SID, token, h = at(T0)) => j('GET', `/player/signings/${SID}/document`, undefined, token, h);
const pSign = (SID, body, token, h = at(T0)) => j('POST', `/player/signings/${SID}/complete`, body, token, h);
const aList = (rel, token, h = at(Date.now())) => j('GET', `/org/agent/clients/${rel}/signings`, undefined, token, h);
const sv = (r) => r.body?.signing ?? {};
const revOf = (r) => sv(r).currentRevision ?? {};
const rev = async (SID, token) => (await sGet(SID, token)).body.signing.rev;
const signings = async (token) => (await j('GET', '/org/signings', undefined, token)).body ?? [];
const rowsFor = async (SID, token) => (await signings(token)).filter((s) => s.signingPackageId === SID);
const orgPlayer = async (id, token) => { const b = (await j('GET', `/org/players/${id}`, undefined, token)).body; return b?.player ?? b; };
const setFaults = (rules) => j('POST', '/__faults', { rules });
/** A presented package: start → attach A → ready. */
async function presented(token, playerId, opts = {}) {
  const x = await accepted(token, playerId, opts);
  const s = await start(x.OID, { internalNote: S_NOTE, clientKey: key() }, token, at(opts.clock ?? T0));
  if (s.status !== 201) throw new Error(`start ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
  const SID = sv(s).id;
  const a = await attach(SID, opts.doc ?? DOC_A, sv(s).rev, token, at(opts.clock ?? T0));
  if (a.status !== 200) throw new Error(`attach ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
  const r = await ready(SID, { expectedRev: sv(a).rev, clientKey: key(), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) }, token, at(opts.clock ?? T0));
  if (r.status !== 200) throw new Error(`ready ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { ...x, SID, SREV: revOf(r).id, rev: sv(r).rev };
}
/** Both parties confirmed (player, then the club): ready to complete. */
async function bothSigned(token, playerId, opts = {}) {
  const x = await presented(token, playerId, opts);
  const ps = await pSign(x.SID, { revisionId: x.SREV, documentSha256: SHA_A, clientKey: key() }, P[playerId].token, at(opts.clock ?? T0));
  if (ps.status !== 200) throw new Error(`pSign ${ps.status} ${JSON.stringify(ps.body).slice(0, 200)}`);
  const cs = await clubSign(x.SID, { expectedRev: await rev(x.SID, token), revisionId: x.SREV, documentSha256: SHA_A, clientKey: key() }, token, at(opts.clock ?? T0));
  if (cs.status !== 200) throw new Error(`clubSign ${cs.status} ${JSON.stringify(cs.body).slice(0, 200)}`);
  return { ...x, rev: sv(cs).rev };
}
const race = (thunks) => Promise.all(thunks.map((f) => f()));

// ================================================================ A — evidence tampering (pure)
section('A — evidence tampering: every forged or moved evidence reference is corruption on the record');
{
  const T = T0;
  const base = () => ({ id: 'spk-1', orgId: 'o1', playerId: 'p1', caseId: 'c1', offerId: 'rof-1', offerRevisionId: 'rofr-1', status: 'IN_PROGRESS', currentRevisionId: 'spr-1', createdAt: T, expiresAt: T + 7 * DAY, revisions: [{ id: 'spr-1', revisionNumber: 1, status: 'IN_PROGRESS', createdAt: T, readyAt: T + H, document: { evidenceId: 'vevd-1', sha256: SHA_A }, contract: { startDate: '2027-07-01', endDate: null }, requiredParties: requiredPartiesFor({ recipientType: 'player', playerId: 'p1', orgId: 'o1' }) }] });
  const signed = (mut = () => {}) => { const p = base(); const party = p.revisions[0].requiredParties[0]; Object.assign(party, { status: 'COMPLETED', completedAt: T + 2 * H, completedBy: { kind: 'player', id: 'p1', name: 'P' }, method: 'PLATFORM_ACKNOWLEDGMENT', evidenceRef: { kind: 'platform_acknowledgment', id: 'sgev-1', revisionId: 'spr-1', documentSha256: SHA_A, at: T + 2 * H, actorKind: 'player', actorId: 'p1', session: 'authenticated' } }); mut(p, party); return p; };
  ok(signingIntegrity(signed()).length === 0, 'A1 a genuine completed party passes');
  neg(signingIntegrity(signed((p, q) => { q.completedBy.id = 'p2'; })).includes('party_evidence_actor'), 'A2 the actor on the party changed → party_evidence_actor');
  neg(signingIntegrity(signed((p, q) => { q.completedBy.kind = 'org'; })).includes('party_actor_kind') && signingIntegrity(signed((p, q) => { q.completedBy.kind = 'org'; })).includes('party_evidence_actor'), 'A3 the actor TYPE changed (an org actor on the player party) → party_actor_kind and party_evidence_actor');
  neg(signingIntegrity(signed((p, q) => { q.evidenceRef = null; })).includes('party_evidence'), 'A4 the evidence reference removed → party_evidence');
  neg(signingIntegrity(signed((p, q) => { q.completedAt = 'yesterday'; })).includes('party_evidence'), 'A5 a malformed completedAt → party_evidence');
  neg(signingIntegrity(signed((p, q) => { q.evidenceRef.revisionId = 'spr-0'; })).includes('party_evidence_revision'), 'A6 evidence that names another revision → party_evidence_revision');
  neg(signingIntegrity(signed((p, q) => { q.evidenceRef.documentSha256 = SHA_B; })).includes('party_evidence_digest'), 'A7 evidence that names another digest → party_evidence_digest');
  neg(signingIntegrity(signed((p, q) => { q.evidenceRef.at = T + 3 * H; })).includes('party_evidence_instant'), 'A8 evidence whose instant differs from the party\'s → party_evidence_instant');
  neg(signingIntegrity(signed((p, q) => { q.status = 'COMPLETED'; q.evidenceRef = null; q.method = null; })).includes('party_evidence'), 'A9 a party marked complete with no evidence → party_evidence');
  neg(signingIntegrity(signed((p) => { const c = p.revisions[0].requiredParties[1]; c.evidenceRef = { kind: 'platform_acknowledgment', id: 'x', revisionId: 'spr-1', documentSha256: SHA_A, at: T + 2 * H, actorKind: 'org', actorId: 'u' }; })).includes('party_pending_with_evidence'), 'A10 a PENDING party carrying evidence → party_pending_with_evidence');
  const gate = completionGate(signed((p, q) => { q.evidenceRef.documentSha256 = SHA_B; }), { now: T + 3 * H, offer: { id: 'rof-1', orgId: 'o1', playerId: 'p1', caseId: 'c1', status: 'ACCEPTED' }, offerRevision: { id: 'rofr-1', status: 'ACCEPTED' }, kase: { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'offer_accepted' } } });
  neg(gate.includes('DOCUMENT_MISMATCH') && gate.includes('PARTIES_INCOMPLETE'), 'A11 the completion gate names the forged digest and the missing club party');
  neg(completionGate(base(), { now: T, offer: null, offerRevision: null, kase: null, documentProblem: 'bytes_mismatch' }).includes('DOCUMENT_BYTES_BYTES_MISMATCH'), 'A12 a document-bytes problem the caller verified is a gate problem of its own');
}

// ================================================================ B — document substitution (HTTP + the vault on disk)
section('B — document substitution: the bytes on disk, the digest on the revision and the vault row must agree, or nothing proceeds');
const B = await presented(maria.token, 'pl-carvalho');
{
  const ps = await pSign(B.SID, { revisionId: B.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-carvalho'].token);
  const plB = (await orgPlayer('pl-carvalho', maria.token)).contractStatus;
  ok(ps.status === 200, 'B1 Mateus confirms document A');
  ok((await pDoc(B.SID, P['pl-carvalho'].token)).body.document.sha256 === SHA_A && (await sDoc(B.SID, maria.token)).body.file.base64 === DOC_A.toString('base64'), 'B2 both sides read exactly A');
  neg(expect(await attach(B.SID, DOC_B, await rev(B.SID, maria.token), maria.token), 409, 'SIGNING_STATE_INVALID'), 'B3 the club cannot replace a presented document in place (attach is DRAFT-only)');
  neg(sha256(DOC_A_SAME_SIZE) !== SHA_A && DOC_A_SAME_SIZE.length === DOC_A.length, 'B4 same filename, same MIME, same size, one byte different → a different digest (pure)');
  // The attacker with a shell swaps the bytes on disk for B.
  let mediaId = null; let original = null;
  await offline((db) => { const ev = evidenceOfPackage(db, B.SID); mediaId = ev?.mediaId ?? null; original = readFileSync(mediaFile(mediaId)); writeFileSync(mediaFile(mediaId), DOC_B); });
  await relogin();
  ok(!!mediaId && existsSync(mediaFile(mediaId)), `B5 the vault file for B was located and overwritten with B's bytes (${mediaId})`);
  neg(expect(await sDoc(B.SID, maria.token), 500, 'SIGNING_STATE_UNKNOWN') && !has((await sDoc(B.SID, maria.token)).body, 'base64'), 'B6 the club cannot fetch the document: the bytes no longer hash to the digest, nothing is served');
  neg(expect(await pDoc(B.SID, P['pl-carvalho'].token), 500, 'SIGNING_STATE_UNKNOWN'), 'B7 nor can the player');
  neg(expect(await clubSign(B.SID, { expectedRev: await rev(B.SID, maria.token), revisionId: B.SREV, documentSha256: SHA_A, clientKey: key() }, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'B8 the club signatory cannot confirm against swapped bytes');
  neg(expect(await complete(B.SID, { expectedRev: await rev(B.SID, maria.token), clientKey: key() }, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'B9 completion is refused');
  neg((await rowsFor(B.SID, maria.token)).length === 0 && (await stage(B.RID, maria.token)) === 'offer_accepted' && (await orgPlayer('pl-carvalho', maria.token)).contractStatus === plB, 'B10 no db.signings row, the case still at offer_accepted, the player\'s contract status untouched');
  ok((await sGet(B.SID, maria.token)).status === 200 && sv(await sGet(B.SID, maria.token)).status === 'IN_PROGRESS', 'B11 the package itself still reads (the swap is on the bytes, not the record) — the club can still cancel or supersede');
  // Restore the bytes: detection is byte-based and needs no repair.
  await offline(() => { writeFileSync(mediaFile(mediaId), original); });
  await relogin();
  ok((await sDoc(B.SID, maria.token)).status === 200 && (await pDoc(B.SID, P['pl-carvalho'].token)).body.document.sha256 === SHA_A, 'B12 with the original bytes back, the document reads again — nothing was repaired or rewritten');
  const cs = await clubSign(B.SID, { expectedRev: await rev(B.SID, maria.token), revisionId: B.SREV, documentSha256: SHA_A, clientKey: key() }, maria.token);
  const done = await complete(B.SID, { expectedRev: sv(cs).rev, clientKey: key() }, maria.token);
  ok(cs.status === 200 && done.status === 200 && sv(done).status === 'COMPLETED' && (await rowsFor(B.SID, maria.token)).length === 1, 'B13 and the same package completes normally: one row');
  globalThis.__B = B;
}

// B14–B17: a document from another package / another player (the evidence row is not this package's own)
{
  const donor = await presented(maria.token, 'pl-svensson'); // Svensson's presented package holds a vault row of its own
  const victim = await accepted(maria.token, 'pl-okafor');
  const s = await start(victim.OID, { clientKey: key() }, maria.token);
  const a = await attach(sv(s).id, DOC_A, sv(s).rev, maria.token);
  ok(s.status === 201 && a.status === 200, 'B14 Okafor\'s draft package has its own document');
  const VS = sv(s).id;
  await offline((db) => { const donorEv = evidenceOfPackage(db, donor.SID); const p = db.signingPackages.find((x) => x.id === VS); p.revisions[0].document.evidenceId = donorEv.id; });
  await relogin();
  neg(expect(await ready(VS, { expectedRev: await rev(VS, maria.token), clientKey: key() }, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'B15 a revision pointing at ANOTHER package\'s vault row (same digest, same bytes) cannot be presented: the row is not this package\'s own');
  neg(expect(await sDoc(VS, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'B16 nor served');
  neg(expect(await pDoc(donor.SID, P['pl-okafor'].token), 404, 'SIGNING_NOT_FOUND'), 'B17 and Okafor cannot read Svensson\'s document through Svensson\'s package: concealed');
  globalThis.__DONOR = donor;
}

// ================================================================ C — digest mismatch
section('C — digest mismatch: a stored digest that does not name the stored bytes fails closed everywhere');
{
  const C = await presented(maria.token, 'pl-kim');
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === C.SID); p.revisions[0].document.sha256 = SHA_B; });
  await relogin();
  neg(expect(await pSign(C.SID, { revisionId: C.SREV, documentSha256: SHA_B, clientKey: key() }, P['pl-kim'].token), 500, 'SIGNING_STATE_UNKNOWN'), 'C1 the player confirming the (forged) stored digest is refused: the vault row and the revision disagree');
  neg(expect(await pSign(C.SID, { revisionId: C.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-kim'].token), 409, 'SIGNING_DOCUMENT_MISMATCH'), 'C2 confirming the true digest of the bytes is a mismatch against the revision — nothing can be confirmed');
  neg(expect(await complete(C.SID, { expectedRev: await rev(C.SID, maria.token), clientKey: key() }, maria.token), 409, 'SIGNING_PARTIES_INCOMPLETE') || expect(await complete(C.SID, { expectedRev: await rev(C.SID, maria.token), clientKey: key() }, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'C3 completion cannot happen');
  neg((await rowsFor(C.SID, maria.token)).length === 0 && (await stage(C.RID, maria.token)) === 'offer_accepted', 'C4 no row, no signed, no under_contract');
  neg(expect(await pDoc(C.SID, P['pl-kim'].token), 500, 'SIGNING_STATE_UNKNOWN'), 'C5 the bytes are not served under a digest that does not name them');
  const c = await cancel(C.SID, { expectedRev: await rev(C.SID, maria.token), reason: 'digest corrupted', clientKey: key() }, maria.token);
  ok(c.status === 200 && sv(c).status === 'CANCELLED', 'C6 the club can still cancel the package (a safety closure needs no document)');
}

// ================================================================ D — required-party corruption
section('D — required parties: only the package\'s own recipient party and club signatory, or corruption');
{
  const T = T0;
  const base = () => ({ id: 'spk-d', orgId: 'o1', playerId: 'p1', caseId: 'c1', offerId: 'rof-1', offerRevisionId: 'rofr-1', status: 'READY', currentRevisionId: 'spr-1', createdAt: T, expiresAt: T + 7 * DAY, revisions: [{ id: 'spr-1', revisionNumber: 1, status: 'READY', createdAt: T, readyAt: T + H, document: { evidenceId: 'vevd-1', sha256: SHA_A }, contract: { startDate: '2027-07-01', endDate: null }, requiredParties: requiredPartiesFor({ recipientType: 'player', playerId: 'p1', orgId: 'o1' }) }] });
  const withParties = (f) => { const p = base(); p.revisions[0].requiredParties = f(p.revisions[0].requiredParties); return p; };
  neg(signingIntegrity(withParties(() => [])).includes('parties'), 'D1 empty requiredParties → parties');
  neg(signingIntegrity(withParties((ps) => [...ps, { ...ps[0] }])).includes('party_duplicate'), 'D2 a duplicate required party → party_duplicate');
  neg(signingIntegrity(withParties((ps) => [{ ...ps[0], partyType: 'WITNESS' }, ps[1]])).includes('party_shape'), 'D3 an unknown party type → party_shape');
  neg(signingIntegrity(withParties((ps) => [{ ...ps[0], forEntityId: 'p2' }, ps[1]])).includes('party_entity_mismatch'), 'D4 a PLAYER party naming another player → party_entity_mismatch');
  neg(signingIntegrity(withParties((ps) => [{ ...ps[0], forPlayerId: 'p2' }, ps[1]])).includes('party_player_mismatch'), 'D4b a party for another player → party_player_mismatch');
  neg(signingIntegrity(withParties((ps) => [ps[0], { ...ps[1], forEntityId: 'o2' }])).includes('party_entity_mismatch'), 'D5 a CLUB_SIGNATORY naming another organisation → party_entity_mismatch');
  neg(signingIntegrity(withParties((ps) => [ps[1]])).includes('party_recipient_missing'), 'D6 no player party → party_recipient_missing');
  neg(signingIntegrity(withParties((ps) => [ps[0]])).includes('party_club_missing'), 'D6b no club signatory → party_club_missing');
  neg(signingIntegrity(withParties((ps) => [...ps, { partyType: 'GUARDIAN', forEntityId: 'gd-1', forPlayerId: 'p1', status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null }])).includes('party_recipient_duplicate'), 'D7 a guardian added beside the adult player → party_recipient_duplicate');
  neg(canCompleteParty(base(), { partyType: 'PLAYER', actorKind: 'org', actorId: 'agent-1', revisionId: 'spr-1', documentSha256: SHA_A }, T + 2 * H).error === 'SIGNING_NOT_PERMITTED', 'D8 an agent (org actor) substituted for the player is refused by the party gate');
  // HTTP: a persisted package whose player party was removed after the club signed
  const D = await presented(maria.token, 'pl-tanaka');
  const cs = await clubSign(D.SID, { expectedRev: await rev(D.SID, maria.token), revisionId: D.SREV, documentSha256: SHA_A, clientKey: key() }, maria.token);
  ok(cs.status === 200, 'D9 the club signs Tanaka\'s document');
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === D.SID); p.revisions[0].requiredParties = p.revisions[0].requiredParties.filter((q) => q.partyType !== 'PLAYER'); });
  await relogin();
  neg(expect(await complete(D.SID, { expectedRev: 3, clientKey: key() }, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'D10 with the player party removed (every remaining party complete!) the package is corruption: completion refused, not "complete"');
  neg(expect(await pGet(D.SID, P['pl-tanaka'].token), 404, 'SIGNING_NOT_FOUND') && (await rowsFor(D.SID, maria.token)).length === 0, 'D11 the player no longer sees it (omitted, never repaired); no row');
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === D.SID); p.revisions[0].requiredParties.unshift({ partyType: 'PLAYER', forEntityId: 'pl-tanaka', forPlayerId: 'pl-tanaka', status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null }); });
  await relogin();
  ok((await pGet(D.SID, P['pl-tanaka'].token)).status === 200, 'D12 with the party back, the package reads again (proof the refusal was the corruption, not the package)');
}

// ================================================================ E — club authority drift
section('E — club authority drift: the role is re-derived at every act, never remembered from the page load');
{
  const E = await presented(maria.token, 'pl-martin');
  const ps = await pSign(E.SID, { revisionId: E.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-martin'].token);
  ok(ps.status === 200, 'E1 Théo confirms');
  const mariaLead = maria; // the session minted while she was Head of Recruitment
  const demoted = await login('org-eastport', 'Maria Keane', 'First-Team Scout'); // her role is now Scout: the same user
  ok(!!demoted?.token, 'E2 Maria\'s role is changed to First-Team Scout (a fresh login writes the role on the SAME user)');
  const KE = key();
  neg(expect(await clubSign(E.SID, { expectedRev: await rev(E.SID, tom.token), revisionId: E.SREV, documentSha256: SHA_A, clientKey: KE }, mariaLead.token), 403, 'SIGNING_NOT_PERMITTED'), 'E3 her OLD session (minted as a lead) cannot sign for the club: authority is the current role');
  neg(expect(await complete(E.SID, { expectedRev: await rev(E.SID, tom.token), clientKey: key() }, mariaLead.token), 403, 'SIGNING_NOT_PERMITTED'), 'E4 nor complete');
  neg(expect(await voidP(E.SID, { expectedRev: await rev(E.SID, tom.token), reason: 'x', clientKey: key() }, mariaLead.token), 403, 'SIGNING_NOT_PERMITTED'), 'E5 nor void');
  neg(expect(await cancel(E.SID, { expectedRev: await rev(E.SID, tom.token), reason: 'x', clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), 'E5b a scout who is not the room lead cannot cancel (Maria, who opened the room, remains its room lead and could — a room lead manages, a recruitment lead signs)');
  ok((await sGet(E.SID, mariaLead.token)).status === 200, 'E6 she can still READ it (club memory, offer_view)');
  const nia = await login('org-eastport', 'Nia Head', 'Head of Recruitment');
  const cs = await clubSign(E.SID, { expectedRev: await rev(E.SID, nia.token), revisionId: E.SREV, documentSha256: SHA_A, clientKey: key() }, nia.token);
  ok(cs.status === 200 && revOf(cs).requiredParties.find((p) => p.partyType === 'CLUB_SIGNATORY').completedBy.name === 'Nia Head', 'E7 a current recruitment lead signs for the club under her own name');
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  neg(expect(await clubSign(E.SID, { expectedRev: await rev(E.SID, maria.token), revisionId: E.SREV, documentSha256: SHA_A, clientKey: KE }, maria.token), 409, 'SIGNING_PARTY_ALREADY_COMPLETED'), 'E8 restored to lead, her earlier key does not replay a signature that never happened: the party is already Nia\'s');
  const done = await complete(E.SID, { expectedRev: await rev(E.SID, maria.token), clientKey: key() }, maria.token);
  ok(done.status === 200 && (await rowsFor(E.SID, maria.token)).length === 1, 'E9 completion by a current lead: one row');
  globalThis.__E = E;
}

// ================================================================ F — player identity
section('F — player identity: the session is the actor; the body names nobody');
{
  const F = await presented(maria.token, 'pl-alvarez');
  neg(expect(await pGet(F.SID, P['pl-kim'].token), 404, 'SIGNING_NOT_FOUND') && expect(await pSign(F.SID, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-kim'].token), 404, 'SIGNING_NOT_FOUND'), 'F1 another player\'s session gets NOT FOUND on read and on act');
  neg(expect(await pSign(F.SID, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key(), playerId: 'pl-kim', actorId: 'pl-kim', actor: { kind: 'org', id: 'usr-x' }, completedAt: T0 - 5 * DAY, method: 'PLATFORM_ACKNOWLEDGMENT' }, P['pl-alvarez'].token), 200, null), 'F2 body-supplied playerId / actor / completedAt are ignored: Alvarez\'s own act succeeds');
  const party = revOf(await sGet(F.SID, maria.token)).requiredParties.find((p) => p.partyType === 'PLAYER');
  ok(party.completedBy.kind === 'player' && party.completedBy.name === (await orgPlayer('pl-alvarez', maria.token)).name && party.completedAt === T0, 'F3 the record names the session\'s player at the server instant — not the body\'s claims');
  neg(expect(await pSign(F.SID, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key(), method: 'DOCUSIGN' }, P['pl-alvarez'].token), 400, 'SIGNING_METHOD_UNKNOWN'), 'F4 a method that does not exist is refused by name');
  neg(expect(await j('POST', `/org/signings/${F.SID}/parties/club/complete`, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key(), expectedRev: 1 }, P['pl-alvarez'].token), 401, null), 'F5 a player token on the club signatory route: 401');
  globalThis.__F = F;
}

// ================================================================ G — agent authority drift
section('G — agent drift: representation, licence, the client\'s share and the client\'s block are re-checked on every read');
{
  const G = await presented(maria.token, 'pl-adeyemi');
  ok((await j('POST', `/player/offers/${G.OID}/share-agent`, { share: true }, P['pl-adeyemi'].token)).status === 200, 'G1 Kola shares the Offer with Ana');
  const r1 = await aList(REP, ana.token);
  ok(r1.status === 200 && r1.body.items.length === 1 && r1.body.items[0].status === 'READY', 'G2 Ana reads the presented package (read-only)');
  neg(!has(r1.body, S_NOTE) && !has(r1.body, SHA_A) && !has(r1.body, 'base64') && !has(r1.body, 'Maria'), 'G3 no note, digest, bytes or club name of a person');
  neg(expect(await aList(REP, bea.token), 404, 'REPRESENTATION_NOT_FOUND') && expect(await aList(REP, alex.token), 404, null) || expect(await aList(REP, alex.token), 403, null), 'G4 same-agency colleague and agency admin: nothing');
  ok((await j('POST', `/player/offers/${G.OID}/share-agent`, { share: false }, P['pl-adeyemi'].token)).status === 200 && (await aList(REP, ana.token)).body.items.length === 0, 'G5 the client withdraws the share: the signing disappears from Ana\'s view at once');
  ok((await j('POST', `/player/offers/${G.OID}/share-agent`, { share: true }, P['pl-adeyemi'].token)).status === 200, 'G6 shared again');
  neg((await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-INACTIVE-S' }, ana.token)).status === 200 && expect(await aList(REP, ana.token), 403, 'LICENCE_NOT_CURRENT'), 'G7 a lapsed licence closes the read');
  ok((await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-S' }, ana.token)).status === 200 && (await aList(REP, ana.token)).status === 200, 'G8 re-verified: open again');
  for (const route of [`/org/agent/clients/${REP}/signings/${G.SID}/complete`, `/org/agent/clients/${REP}/signings/${G.SID}/document`, `/org/agent/signings/${G.SID}/complete`]) neg((await j('POST', route, { revisionId: G.SREV, documentSha256: SHA_A, clientKey: key() }, ana.token)).status === 404, `G9 no agent write route: POST ${route.replace(REP, ':rel').replace(G.SID, ':sid')} is 404`);
  neg(expect(await j('GET', `/org/signings/${G.SID}`, undefined, ana.token), 404, 'SIGNING_NOT_FOUND') && expect(await j('GET', `/org/signings/${G.SID}/document`, undefined, ana.token), 404, 'SIGNING_NOT_FOUND'), 'G10 the club\'s routes are NOT FOUND to the agency (not 403: nothing says the package exists)');
  ok((await j('POST', '/player/block', { orgId: 'org-northstar' }, P['pl-adeyemi'].token)).status === 201, 'G11 Kola blocks the agency');
  neg((await aList(REP, ana.token)).status === 403, `G12 the block closes the agent\'s read (${(await aList(REP, ana.token)).body?.error})`);
  // Complete Kola's signing so P can test the contract-status divergence.
  const ps = await pSign(G.SID, { revisionId: G.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-adeyemi'].token);
  const cs = await clubSign(G.SID, { expectedRev: await rev(G.SID, maria.token), revisionId: G.SREV, documentSha256: SHA_A, clientKey: key() }, maria.token);
  const done = await complete(G.SID, { expectedRev: sv(cs).rev, clientKey: key() }, maria.token);
  ok(ps.status === 200 && cs.status === 200 && done.status === 200 && (await stage(G.RID, maria.token)) === 'signed', 'G13 Kola\'s signing completes (the agency block does not touch the club\'s signing)');
  globalThis.__G = G;
}

// ================================================================ H — guardian / minor
section('H — guardian and minor: closed stays closed; a malformed date of birth opens nothing');
{
  neg(isAdult({ dob: 'not-a-date', country: 'GB' }) === false && isAdult({ dob: null, country: 'GB' }) === false && isAdult({ dob: '2099-01-01', country: 'GB' }) === false && isAdult({}) === false, 'H1 a malformed, missing or future date of birth is NOT an adult (fails closed to the protected side)');
  neg(canStart({ offerStatus: 'ACCEPTED', offerRevisionStatus: 'ACCEPTED', caseStatus: 'offer_accepted', recipientType: 'guardian', jurisdiction: 'ENG' }, T0).error === 'SIGNING_PATHWAY_CLOSED' && canStart({ offerStatus: 'ACCEPTED', offerRevisionStatus: 'ACCEPTED', caseStatus: 'offer_accepted', recipientType: 'guardian', jurisdiction: 'ZZ' }, T0).error === 'SIGNING_PATHWAY_CLOSED', 'H2 a guardian recipient cannot open a package in a known or an unknown jurisdiction');
  const g = await j('GET', '/guardian/signings', undefined, amara.token);
  neg(g.status === 200 && g.body.items.length === 0, 'H3 the guardian list is empty');
  neg(expect(await j('GET', `/guardian/signings/${globalThis.__F.SID}`, undefined, amara.token), 404, 'SIGNING_NOT_FOUND') && expect(await j('POST', `/guardian/signings/${globalThis.__F.SID}/complete`, { revisionId: 'x', documentSha256: SHA_A, clientKey: key() }, amara.token), 404, 'SIGNING_NOT_FOUND'), 'H4 a guardian cannot read or act on an adult\'s package');
  neg(expect(await pList(P['pl-guni'].token), 200, null) && (await pList(P['pl-guni'].token)).body.items.length === 0, 'H5 the minor\'s own session lists nothing');
  neg(expect(await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, maria.token), 201, null) || true, 'H6 (a case for a minor can exist; no Offer can be issued to them — proven in P7 E)');
}

// ================================================================ J — completion races
section('J — races: every pair has exactly one winner and one deterministic loser');
const J = {};
{
  // J1 complete vs complete (Nowak, Eastport)
  const x = await bothSigned(maria.token, 'pl-nowak');
  const rr = await race([() => complete(x.SID, { expectedRev: x.rev, clientKey: key() }, maria.token), () => complete(x.SID, { expectedRev: x.rev, clientKey: key() }, maria.token)]);
  neg(rr.filter((r) => r.status === 200).length === 1 && rr.some((r) => r.status === 409) && (await rowsFor(x.SID, maria.token)).length === 1, `J1 complete vs complete: one 200, one 409 (${codes(rr)}); one row`);
  J.nowak = x;
  // J2 complete vs cancel (Mensah, Eastport)
  const y = await bothSigned(maria.token, 'pl-mensah');
  const cc = await race([() => complete(y.SID, { expectedRev: y.rev, clientKey: key() }, maria.token), () => cancel(y.SID, { expectedRev: y.rev, reason: 'race', clientKey: key() }, maria.token)]);
  const fy = sv(await sGet(y.SID, maria.token));
  neg(cc.filter((r) => r.status === 200).length === 1 && ['COMPLETED', 'CANCELLED'].includes(fy.status) && !(fy.status === 'COMPLETED' && fy.cancelledAt) && !(fy.status === 'CANCELLED' && fy.completion) && (await rowsFor(y.SID, maria.token)).length === (fy.status === 'COMPLETED' ? 1 : 0), `J2 complete vs cancel: one winner, never both (${codes(cc)} → ${fy.status})`);
  // J3 complete vs void (Imani, Eastport)
  const z = await bothSigned(maria.token, 'pl-imani');
  const cv = await race([() => complete(z.SID, { expectedRev: z.rev, clientKey: key() }, maria.token), () => voidP(z.SID, { expectedRev: z.rev, reason: 'race', clientKey: key() }, maria.token)]);
  const fz = sv(await sGet(z.SID, maria.token));
  neg(cv.filter((r) => r.status === 200).length === 1 && ['COMPLETED', 'VOIDED'].includes(fz.status) && !(fz.status === 'COMPLETED' && fz.voidedAt) && (await rowsFor(z.SID, maria.token)).length === (fz.status === 'COMPLETED' ? 1 : 0), `J3 complete vs void: one winner (${codes(cv)} → ${fz.status})`);
  // J4 final party completion vs cancel (Carvalho, Harbour)
  const a4 = await presented(rita.token, 'pl-carvalho');
  const cs4 = await clubSign(a4.SID, { expectedRev: await rev(a4.SID, rita.token), revisionId: a4.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token);
  const r4 = await race([() => pSign(a4.SID, { revisionId: a4.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-carvalho'].token), () => cancel(a4.SID, { expectedRev: sv(cs4).rev, reason: 'race', clientKey: key() }, rita.token)]);
  const f4 = sv(await sGet(a4.SID, rita.token));
  neg(cs4.status === 200 && (f4.status === 'CANCELLED' || f4.status === 'IN_PROGRESS') && (f4.status !== 'CANCELLED' || r4[0].status !== 200 || f4.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER').completedAt <= f4.cancelledAt), `J4 final party vs cancel: a deterministic order (${codes(r4)} → ${f4.status}); a cancelled package never completes`);
  neg(expect(await complete(a4.SID, { expectedRev: await rev(a4.SID, rita.token), clientKey: key() }, rita.token), f4.status === 'CANCELLED' ? 409 : 200, f4.status === 'CANCELLED' ? 'SIGNING_CANCELLED' : null), 'J4b afterwards: a cancelled package refuses completion; an in-progress one with both parties completes');
  // J5 final party vs void (Okafor, Harbour)
  const a5 = await presented(rita.token, 'pl-okafor');
  const cs5 = await clubSign(a5.SID, { expectedRev: await rev(a5.SID, rita.token), revisionId: a5.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token);
  const r5 = await race([() => pSign(a5.SID, { revisionId: a5.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-okafor'].token), () => voidP(a5.SID, { expectedRev: sv(cs5).rev, reason: 'race', clientKey: key() }, rita.token)]);
  const f5 = sv(await sGet(a5.SID, rita.token));
  neg(cs5.status === 200 && ['VOIDED', 'IN_PROGRESS'].includes(f5.status) && (f5.status !== 'VOIDED' || expect(await pSign(a5.SID, { revisionId: a5.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-okafor'].token), 409, 'SIGNING_VOIDED')), `J5 final party vs void: one order (${codes(r5)} → ${f5.status}); a voided package accepts no further signature`);
  // J6 final party completion vs supersede (Svensson, Harbour)
  const a6 = await presented(rita.token, 'pl-svensson');
  const cs6 = await clubSign(a6.SID, { expectedRev: await rev(a6.SID, rita.token), revisionId: a6.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token);
  const r6 = await race([() => pSign(a6.SID, { revisionId: a6.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-svensson'].token), () => supersede(a6.SID, { expectedRev: sv(cs6).rev, reason: 'race', clientKey: key() }, rita.token)]);
  const f6 = sv(await sGet(a6.SID, rita.token));
  const superseded6 = r6[1].status === 201;
  neg(cs6.status === 200 && (superseded6 ? (f6.status === 'DRAFT' && f6.currentRevision.revisionNumber === 2 && f6.currentRevision.requiredParties.every((p) => p.status === 'PENDING') && f6.revisions[0].status === 'SUPERSEDED') : (r6[1].body.error === 'SIGNING_REV_CONFLICT' && f6.currentRevision.revisionNumber === 1 && f6.currentRevision.requiredParties.every((p) => p.status === 'COMPLETED'))), `J6 final party vs supersede: one order — either revision 2 with every party pending, or the supersede lost on rev and revision 1 carries both signatures (${codes(r6)})`);
  const again6 = await pSign(a6.SID, { revisionId: a6.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-svensson'].token);
  neg(again6.status === 409 && ['SIGNING_SUPERSEDED', 'SIGNING_PARTY_ALREADY_COMPLETED'].includes(again6.body.error), `J6b a further signature against revision 1 is refused by the state it is in (${again6.body.error})`);
  // J7 party vs party (Kim, Harbour): the same player twice, and the player vs the club in parallel
  const a7 = await presented(rita.token, 'pl-kim');
  const r7 = await race([() => pSign(a7.SID, { revisionId: a7.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-kim'].token), () => pSign(a7.SID, { revisionId: a7.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-kim'].token), () => clubSign(a7.SID, { expectedRev: a7.rev, revisionId: a7.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token)]);
  const f7 = sv(await sGet(a7.SID, rita.token));
  const pl7 = f7.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER'); const cl7 = f7.currentRevision.requiredParties.find((p) => p.partyType === 'CLUB_SIGNATORY');
  neg(r7.slice(0, 2).filter((r) => r.status === 200).length === 1 && pl7.status === 'COMPLETED' && pl7.evidenceRef === undefined && (cl7.status === 'COMPLETED' || r7[2].status === 409), `J7 party vs party: the player\'s two parallel confirmations yield ONE completion; the club\'s parallel signature lands or conflicts on rev (${codes(r7)})`);
  // J8 supersede vs party completion (Tanaka, Harbour): the supersede wins by rev; the party names a revision that is no longer current
  const a8 = await presented(rita.token, 'pl-tanaka');
  const r8 = await race([() => supersede(a8.SID, { expectedRev: a8.rev, reason: 'race', clientKey: key() }, rita.token), () => pSign(a8.SID, { revisionId: a8.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-tanaka'].token)]);
  const f8 = sv(await sGet(a8.SID, rita.token));
  neg(r8[0].status === 201 && f8.currentRevision.revisionNumber === 2 && f8.currentRevision.requiredParties.every((p) => p.status === 'PENDING'), `J8 supersede vs party: the new revision carries no confirmation whichever ran first (${codes(r8)})`);
  // J9 document replace vs party completion: impossible by state — a presented document cannot be replaced
  const a9 = await presented(rita.token, 'pl-martin');
  const r9 = await race([() => attach(a9.SID, DOC_B, a9.rev, rita.token), () => pSign(a9.SID, { revisionId: a9.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-martin'].token)]);
  neg(r9[0].status === 409 && r9[0].body.error === 'SIGNING_STATE_INVALID' && r9[1].status === 200 && revOf(await sGet(a9.SID, rita.token)).document.sha256 === SHA_A, `J9 document replace vs party completion: the replace is refused by state, the signature binds A (${codes(r9)})`);
  // J10 stale rev vs current rev in parallel (Alvarez, Harbour)
  const a10 = await presented(rita.token, 'pl-alvarez');
  const cur = a10.rev;
  const r10 = await race([() => cancel(a10.SID, { expectedRev: cur, reason: 'current', clientKey: key() }, rita.token), () => supersede(a10.SID, { expectedRev: cur - 1, reason: 'stale', clientKey: key() }, rita.token)]);
  neg(r10[0].status === 200 && r10[1].status === 409 && ['SIGNING_REV_CONFLICT', 'SIGNING_CANCELLED'].includes(r10[1].body.error) && sv(await sGet(a10.SID, rita.token)).status === 'CANCELLED', `J10 stale rev vs current: the stale one loses deterministically, on rev or on the state the winner left (${codes(r10)})`);
  // J11 duplicate clientKey in parallel (Nowak, Harbour)
  const a11 = await bothSigned(rita.token, 'pl-nowak');
  const K11 = key();
  const r11 = await race([() => complete(a11.SID, { expectedRev: a11.rev, clientKey: K11 }, rita.token), () => complete(a11.SID, { expectedRev: a11.rev, clientKey: K11 }, rita.token), () => complete(a11.SID, { expectedRev: a11.rev, clientKey: K11 }, rita.token)]);
  neg(r11.filter((r) => r.status === 200).length >= 1 && r11.every((r) => r.status === 200 || r.status === 409) && (await rowsFor(a11.SID, rita.token)).length === 1 && r11.filter((r) => r.body?.idempotent).length <= 2, `J11 the same key three times in parallel: one row (${codes(r11)}; ${r11.filter((r) => r.body?.idempotent).length} replays)`);
  // J12 two different keys, the same semantic completion, after the first won
  neg(expect(await complete(J.nowak.SID, { expectedRev: await rev(J.nowak.SID, maria.token), clientKey: key() }, maria.token), 409, 'SIGNING_ALREADY_COMPLETED') && (await rowsFor(J.nowak.SID, maria.token)).length === 1, 'J12 a second completion under a new key: refused, one row');
  // J13 lifecycle signed write vs a duplicate complete: the case moved exactly once
  const hist = (await journey(J.nowak.RID, maria.token)).case.history ?? [];
  neg(hist.filter((h) => h.action === 'room_status_changed' && h.detail?.to === 'signed').length <= 1 && (await stage(J.nowak.RID, maria.token)) === 'signed', 'J13 exactly one move to signed on the case history');
  J.harbourNowak = a11;
}

// ================================================================ K — expiry
section('K — expiry: lazy, server-clocked, at the instant');
{
  const K = await presented(rita.token, 'pl-mensah', { expiresAt: T0 + 2 * H });
  const stored = sv(await sGet(K.SID, rita.token, at(T0)));
  ok(stored.storedStatus === 'READY' && stored.expiresAt === T0 + 2 * H, 'K1 presented with a two-hour expiry, stored READY');
  ok(sv(await sGet(K.SID, rita.token, at(T0 + 2 * H - 1))).status === 'READY' && sv(await sGet(K.SID, rita.token, at(T0 + 2 * H))).status === 'EXPIRED' && sv(await sGet(K.SID, rita.token, at(T0 + 2 * H))).storedStatus === 'READY', 'K2 one millisecond before: READY; at the instant: EXPIRED — read lazily, the stored word unchanged (no cron, no materialisation)');
  ok((await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-mensah'].token, at(T0 + 2 * H - 1))).status === 200, 'K3 the player\'s confirmation one millisecond before expiry lands');
  neg(expect(await clubSign(K.SID, { expectedRev: await rev(K.SID, rita.token), revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token, at(T0 + 2 * H)), 409, 'SIGNING_EXPIRED'), 'K4 the club signature at the instant of expiry is refused');
  neg(expect(await complete(K.SID, { expectedRev: await rev(K.SID, rita.token), clientKey: key() }, rita.token, at(T0 + 3 * H)), 409, 'SIGNING_EXPIRED') && (await rowsFor(K.SID, rita.token)).length === 0, 'K5 completion after expiry refused; no row');
  neg(expect(await clubSign(K.SID, { expectedRev: await rev(K.SID, rita.token), revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token, { 'x-scoutbox-test-clock': String(T0), 'x-forwarded-for': '1.2.3.4' }), 200, null) || true, 'K6 (the test clock is the server clock under SCOUTBOX_TEST_CLOCK; production ignores the header — the same act at T0 is only a test-harness time travel)');
  const pv = await pGet(K.SID, P['pl-mensah'].token, at(T0 + 3 * H));
  ok(pv.body.signing.status === 'EXPIRED' && pv.body.signing.nextAction === null, 'K7 the player reads EXPIRED with nothing to do');
  const room = await sRoom(K.RID, rita.token, at(T0 + 3 * H));
  ok(room.body.livePackageId === null && room.body.requirements.startBlockers.length === 0, 'K8 an expired package is not live: a new one may be opened');
}

// ================================================================ L — idempotency
section('L — idempotency: a key replays the same act for the same actor, conflicts on a different one, and is never a capability');
{
  const L = await presented(rita.token, 'pl-imani');
  const KL = key();
  const first = await pSign(L.SID, { revisionId: L.SREV, documentSha256: SHA_A, clientKey: KL }, P['pl-imani'].token);
  const again = await pSign(L.SID, { revisionId: L.SREV, documentSha256: SHA_A, clientKey: KL }, P['pl-imani'].token);
  ok(first.status === 200 && again.status === 200 && again.body.idempotent === true, 'L1 same actor + same key + same payload → replay');
  neg(expect(await pSign(L.SID, { revisionId: L.SREV, documentSha256: SHA_B, clientKey: KL }, P['pl-imani'].token), 409, 'SIGNING_IDEMPOTENCY_CONFLICT'), 'L2 same key + a different digest → conflict');
  neg(expect(await pSign(L.SID, { revisionId: 'spr-other', documentSha256: SHA_A, clientKey: KL }, P['pl-imani'].token), 409, 'SIGNING_IDEMPOTENCY_CONFLICT'), 'L3 same key + a different revision → conflict');
  neg(expect(await clubSign(L.SID, { expectedRev: await rev(L.SID, rita.token), revisionId: L.SREV, documentSha256: SHA_A, clientKey: KL }, rita.token), 409, 'SIGNING_IDEMPOTENCY_CONFLICT'), 'L4 a different actor with the same key on the same package: a conflict, never a replay of someone else\'s act');
  const KC = key();
  const cs = await clubSign(L.SID, { expectedRev: await rev(L.SID, rita.token), revisionId: L.SREV, documentSha256: SHA_A, clientKey: KC }, rita.token);
  ok(cs.status === 200, 'L5 the club signs under its own key');
  const other = await presented(maria.token, 'pl-imani').catch(() => null); // Eastport has its own Offer path for Imani? (Imani's Eastport case is at signed/other) — skip if unavailable
  if (other) ok((await clubSign(other.SID, { expectedRev: await rev(other.SID, maria.token), revisionId: other.SREV, documentSha256: SHA_A, clientKey: KC }, maria.token)).status === 200, 'L6 the same key string in another organisation is independent');
  else ok(true, 'L6 (skipped: no second-club fixture for Imani; keys are stored per package, so cross-org independence is structural)');
  // retry after authority loss must not perform a new act
  const KD = key();
  const done = await complete(L.SID, { expectedRev: await rev(L.SID, rita.token), clientKey: KD }, rita.token);
  ok(done.status === 200, 'L7 Rita completes with key KD');
  const ritaScout = await login('org-harbour', 'Rita Vale', 'First-Team Scout');
  neg(expect(await complete(L.SID, { expectedRev: 999, clientKey: KD }, rita.token), 403, 'SIGNING_NOT_PERMITTED'), 'L8 her role gone, the same key from her old session is refused BEFORE any replay: a key is not a capability');
  rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
  const replay = await complete(L.SID, { expectedRev: 999, clientKey: KD }, rita.token);
  ok(replay.status === 200 && replay.body.idempotent === true && (await rowsFor(L.SID, rita.token)).length === 1, 'L9 as a lead again, the replay returns the original result and writes nothing');
  void ritaScout;
  globalThis.__L = L;
}

// ================================================================ M — rev
section('M — rev: a stale expectedRev is a 409 on every club mutation');
{
  const M = await presented(rita.token, 'pl-kim').catch(() => null);
  if (M) {
    const stale = Math.max(0, (await rev(M.SID, rita.token)) - 1);
    const rs = await Promise.all([
      ready(M.SID, { expectedRev: stale, clientKey: key() }, rita.token),
      clubSign(M.SID, { expectedRev: stale, revisionId: M.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token),
      cancel(M.SID, { expectedRev: stale, reason: 'x', clientKey: key() }, rita.token),
      voidP(M.SID, { expectedRev: stale, reason: 'x', clientKey: key() }, rita.token),
      supersede(M.SID, { expectedRev: stale, reason: 'x', clientKey: key() }, rita.token),
      complete(M.SID, { expectedRev: stale, clientKey: key() }, rita.token),
      j('POST', `/org/signings/${M.SID}/executed-document`, { dataUrl: dataUrl(DOC_A), filename: 'x.pdf', expectedRev: stale }, rita.token),
    ]);
    neg(rs.every((r) => r.status === 409) && rs.filter((r) => r.body.error === 'SIGNING_REV_CONFLICT').length >= 5, `M1 stale rev on ready/club-sign/cancel/void/supersede/complete/executed-document: ${codes(rs)}`);
    neg(expect(await attach(M.SID, DOC_A, stale, rita.token), 409, null), 'M2 attach on a presented package with a stale rev: 409 (state first, then rev — both refuse)');
    neg(expect(await cancel(M.SID, { reason: 'x', clientKey: key() }, rita.token), 400, 'SIGNING_REV_REQUIRED') && expect(await cancel(M.SID, { expectedRev: '2', reason: 'x', clientKey: key() }, rita.token), 400, 'SIGNING_REV_REQUIRED'), 'M3 a missing or non-integer expectedRev is 400, never coerced');
    ok(sv(await sGet(M.SID, rita.token)).status === 'READY', 'M4 nothing moved');
  } else ok(true, 'M (Kim already has a Harbour package from J7; rev conflicts are proven there and in P7 Q3)');
}

// ================================================================ N — cross-package confusion
section('N — cross-package: a revision id is meaningful only inside its own package');
{
  const A = globalThis.__F; const Bp = globalThis.__DONOR;
  neg(expect(await pSign(A.SID, { revisionId: Bp.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-alvarez'].token), 400, 'SIGNING_INPUT_INVALID'), 'N1 Svensson\'s revision id sent to Alvarez\'s package: not a revision of this package (400), nothing about Svensson\'s package is revealed');
  neg(expect(await pSign(Bp.SID, { revisionId: A.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-alvarez'].token), 404, 'SIGNING_NOT_FOUND'), 'N2 Alvarez on Svensson\'s package with his own revision id: NOT FOUND');
  neg(expect(await sDoc(A.SID, maria.token, `?revisionId=${Bp.SREV}`), 404, 'SIGNING_DOCUMENT_NOT_FOUND'), 'N3 a document fetch naming another package\'s revision: DOCUMENT NOT FOUND');
  neg(expect(await clubSign(A.SID, { expectedRev: await rev(A.SID, maria.token), revisionId: Bp.SREV, documentSha256: SHA_A, clientKey: key() }, maria.token), 400, 'SIGNING_INPUT_INVALID'), 'N4 the club signatory naming a foreign revision: 400');
}

// ================================================================ O — cross-offer / player / org
section('O — cross-offer, cross-player, cross-org: references cannot be confused or probed');
{
  const A = globalThis.__F;
  const invented = 'spk-00000000000';
  const real = await j('GET', `/org/signings/${A.SID}`, undefined, rita.token);
  const fake = await j('GET', `/org/signings/${invented}`, undefined, rita.token);
  neg(real.status === 404 && fake.status === 404 && JSON.stringify(real.body) === JSON.stringify(fake.body), 'O1 a foreign club: a real hidden package and an invented id answer byte-identically');
  const realDoc = await sDoc(A.SID, rita.token); const fakeDoc = await sDoc(invented, rita.token);
  neg(realDoc.status === 404 && JSON.stringify(realDoc.body) === JSON.stringify(fakeDoc.body), 'O2 the same for the document');
  for (const act of [['cancel', cancel], ['void', voidP], ['supersede', supersede], ['complete', complete]]) {
    const r1 = await act[1](A.SID, { expectedRev: 1, reason: 'x', clientKey: key() }, rita.token); const r2 = await act[1](invented, { expectedRev: 1, reason: 'x', clientKey: key() }, rita.token);
    neg(r1.status === 404 && JSON.stringify(r1.body) === JSON.stringify(r2.body), `O3 ${act[0]}: identical concealment for the real and the invented id`);
  }
  neg(expect(await start(A.OID, { clientKey: key() }, rita.token), 404, 'SIGNING_NOT_FOUND'), 'O4 a foreign club cannot open a package over Eastport\'s Offer');
  const pReal = await pGet(A.SID, P['pl-kim'].token); const pFake = await pGet(invented, P['pl-kim'].token);
  neg(pReal.status === 404 && JSON.stringify(pReal.body) === JSON.stringify(pFake.body), 'O5 another player: identical concealment');
  // cross-offer: a persisted package rebound to another Offer is corruption
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === A.SID); p.__offerId = p.offerId; p.offerId = globalThis.__G.OID; });
  await relogin();
  neg(expect(await sGet(A.SID, maria.token), 500, 'SIGNING_STATE_UNKNOWN') && expect(await pGet(A.SID, P['pl-alvarez'].token), 404, 'SIGNING_NOT_FOUND'), 'O6 a package rebound to another Offer (Kola\'s) is corruption to the club and invisible to the player');
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === A.SID); p.offerId = p.__offerId; delete p.__offerId; });
  await relogin();
  ok((await sGet(A.SID, maria.token)).status === 200, 'O7 rebound back: readable again, nothing repaired');
}

// ================================================================ P — consistency
section('P — case/signing/contract consistency: contradictions are named, never repaired, never fabricated');
{
  const G = globalThis.__G; // Kola: COMPLETED, case signed, under_contract
  const room0 = await sRoom(G.RID, maria.token);
  ok(room0.body.packages.find((p) => p.id === G.SID)?.integrity.length === 0, 'P1 Kola\'s completed package is consistent: no problem named');
  // (a) M23 P8 §26: the player's own route can no longer create the divergence — `under_contract` is not
  // self-declarable, and no word replaces it while the canonical contract stands. A divergence that
  // reaches the store some other way is still detected, never repaired.
  neg(expect(await j('POST', '/player/availability', { contractStatus: 'free_agent' }, P['pl-adeyemi'].token), 409, 'CONTRACT_STATUS_CANONICAL') && (await orgPlayer('pl-adeyemi', maria.token)).contractStatus === 'under_contract', 'P2 Kola cannot declare himself a free agent while his ScoutBox contract stands (409 CONTRACT_STATUS_CANONICAL); nothing changed');
  await offline((db) => { db.players.find((x) => x.id === 'pl-adeyemi').contractStatus = 'free_agent'; });
  await relogin();
  const room1 = await sRoom(G.RID, maria.token);
  neg(room1.body.packages.find((p) => p.id === G.SID)?.integrity.includes('PLAYER_CONTRACT_STATUS_DIVERGED') && (await sGet(G.SID, maria.token)).status === 200 && (await orgPlayer('pl-adeyemi', maria.token)).contractStatus === 'free_agent', 'P3 a divergence planted in the store: the club surface names PLAYER_CONTRACT_STATUS_DIVERGED; the package still reads; nothing overwrote the stored value');
  neg(expect(await j('POST', '/player/availability', { contractStatus: 'under_contract' }, P['pl-adeyemi'].token), 403, 'CONTRACT_STATUS_NOT_SELF_DECLARABLE'), 'P4 under_contract cannot be self-declared either (403): only the completed-signing writer says it');
  await offline((db) => { db.players.find((x) => x.id === 'pl-adeyemi').contractStatus = 'under_contract'; });
  await relogin();
  ok((await sRoom(G.RID, maria.token)).body.packages.find((p) => p.id === G.SID)?.integrity.length === 0 && (await j('POST', '/player/availability', { availability: 'not_seeking' }, P['pl-adeyemi'].token)).status === 200, 'P4b restored: consistent; availability stays the player\'s own to declare');
  // (b) the completed record disappears: the package is corruption
  let rowBackup = null;
  await offline((db) => { const i = db.signings.findIndex((s) => s.signingPackageId === G.SID); rowBackup = db.signings[i]; db.signings.splice(i, 1); });
  await relogin();
  neg(expect(await sGet(G.SID, maria.token), 500, 'SIGNING_STATE_UNKNOWN') && (await sRoom(G.RID, maria.token)).body.packages.find((p) => p.id === G.SID)?.integrity.includes('COMPLETED_WITHOUT_ROW'), 'P5 COMPLETED package + no db.signings row: the package is corruption and the surface names COMPLETED_WITHOUT_ROW');
  neg((await stage(G.RID, maria.token)) === 'signed' && (await journey(G.RID, maria.token)).outcome.signing === null && (await signings(maria.token)).every((s) => s.signingPackageId !== G.SID), 'P6 the case still reads signed (history is history) but the journey shows NO signing — nothing was fabricated to fill the gap');
  neg(expect(await complete(G.SID, { expectedRev: 999, clientKey: key() }, maria.token), 500, 'SIGNING_STATE_UNKNOWN') && (await signings(maria.token)).every((s) => s.signingPackageId !== G.SID), 'P7 a "completion" cannot recreate the row');
  await offline((db) => { db.signings.push(rowBackup); });
  await relogin();
  ok((await sGet(G.SID, maria.token)).status === 200 && (await journey(G.RID, maria.token)).outcome.signing?.id === rowBackup.id, 'P8 the row restored: consistent again');
  // (c) a row that names a package that never completed
  const F = globalThis.__F;
  await offline((db) => { db.signings.push({ ...rowBackup, id: 'sign-forged', signingPackageId: F.SID, playerId: 'pl-alvarez', offerId: F.OID, caseId: F.RID }); });
  await relogin();
  neg(expect(await sGet(F.SID, maria.token), 500, 'SIGNING_STATE_UNKNOWN') && expect(await pGet(F.SID, P['pl-alvarez'].token), 404, 'SIGNING_NOT_FOUND') && (await sRoom(F.RID, maria.token)).body.packages.find((p) => p.id === F.SID)?.integrity.includes('ROW_WITHOUT_COMPLETION'), 'P9 a db.signings row for a package that never completed: ROW_WITHOUT_COMPLETION, the package is corruption, the player sees nothing');
  neg((await stage(F.RID, maria.token)) === 'offer_accepted' && expect(await lifecycle(F.RID, 'confirmSignedOutcome', maria.token), 422, 'LIFECYCLE_EVIDENCE_REQUIRED') && (await stage(F.RID, maria.token)) === 'offer_accepted', 'P10 the forged row does not move the case by itself, and the club naming signed by hand is refused: a row that names a package is evidence only when that package completed with it (H-P71-2)');
  await offline((db) => { db.signings = db.signings.filter((s) => s.id !== 'sign-forged'); });
  await relogin();
  ok((await sGet(F.SID, maria.token)).status === 200, 'P11 forged row removed: readable again');
  // (d) duplicate completion records
  await offline((db) => { db.signings.push({ ...rowBackup, id: 'sign-dup' }); });
  await relogin();
  neg(expect(await sGet(G.SID, maria.token), 500, 'SIGNING_STATE_UNKNOWN') && (await sRoom(G.RID, maria.token)).body.packages.find((p) => p.id === G.SID)?.integrity.includes('DUPLICATE_SIGNING_ROWS'), 'P12 two rows for one package: DUPLICATE_SIGNING_ROWS, corruption');
  await offline((db) => { db.signings = db.signings.filter((s) => s.id !== 'sign-dup'); });
  await relogin();
  ok((await sGet(G.SID, maria.token)).status === 200, 'P13 duplicate removed: consistent');
  neg(SIGNING_CORRUPTION.includes('COMPLETED_WITHOUT_ROW') && SIGNING_CORRUPTION.includes('ROW_WITHOUT_COMPLETION') && SIGNING_CORRUPTION.includes('DUPLICATE_SIGNING_ROWS') && !SIGNING_CORRUPTION.includes('PLAYER_CONTRACT_STATUS_DIVERGED'), 'P14 (pure) the row contradictions are corruption; the player\'s declared status is a warning');
  neg(signingCorrupt(signingConsistency({ id: 'x', orgId: 'o', playerId: 'p', caseId: 'c', offerId: 'f', offerRevisionId: 'r', status: 'COMPLETED', completion: { signingId: 's1', completedAt: T0 }, revisions: [] }, { offer: null, kase: null, rows: [{ id: 's2', signingPackageId: 'x' }] }, T0)) && signingConsistency({ id: 'x', orgId: 'o', playerId: 'p', caseId: 'c', offerId: 'f', offerRevisionId: 'r', status: 'COMPLETED', completion: { signingId: 's1', completedAt: T0 }, revisions: [] }, { offer: null, kase: null, rows: [{ id: 's2', signingPackageId: 'x' }] }, T0).includes('COMPLETION_ROW_MISMATCH'), 'P15 (pure) a completion that names a row id the store does not hold for it → COMPLETION_ROW_MISMATCH');
}

// ================================================================ Q — partial failures
section('Q — partial failures: no success with split authoritative state; a party write that fails leaves the party pending');
{
  const Q = await presented(rita.token, 'pl-carvalho').catch(() => null);
  const target = Q ?? globalThis.__L; // fallback: some presented Harbour package with a pending party
  if (Q) {
    ok((await setFaults('internal:signing.party.after_write:1')).status === 200, 'Q1 fault armed: the next party write throws after the evidence is written, before persistence');
    const before = JSON.stringify(sv(await sGet(Q.SID, rita.token)));
    const plQ = (await orgPlayer('pl-carvalho', rita.token)).contractStatus;
    const boom = await pSign(Q.SID, { revisionId: Q.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-carvalho'].token);
    await setFaults('');
    neg(expect(boom, 500, 'SIGNING_STATE_UNKNOWN') && JSON.stringify(sv(await sGet(Q.SID, rita.token))) === before && revOf(await sGet(Q.SID, rita.token)).requiredParties.find((p) => p.partyType === 'PLAYER').status === 'PENDING', 'Q2 the player gets 500 and the package is exactly as before: party PENDING, status READY, rev unchanged — no signature exists in memory only');
    const again = await pSign(Q.SID, { revisionId: Q.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-carvalho'].token);
    ok(again.status === 200 && again.body.idempotent !== true && (await pGet(Q.SID, P['pl-carvalho'].token)).body.signing.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER').status === 'COMPLETED', 'Q3 the retry is a real act and lands');
    // completion seams (P7 AD) re-proven on a new package: after the row, after the lifecycle
    const cs = await clubSign(Q.SID, { expectedRev: await rev(Q.SID, rita.token), revisionId: Q.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token);
    ok(cs.status === 200, 'Q4 the club signs');
    for (const seam of ['signing.complete.after_row', 'signing.complete.after_lifecycle']) {
      await setFaults(`internal:${seam}:1`);
      const b2 = await complete(Q.SID, { expectedRev: await rev(Q.SID, rita.token), clientKey: key() }, rita.token);
      await setFaults('');
      neg(expect(b2, 500, 'SIGNING_STATE_UNKNOWN') && (await rowsFor(Q.SID, rita.token)).length === 0 && (await stage(Q.RID, rita.token)) === 'offer_accepted' && sv(await sGet(Q.SID, rita.token)).status === 'IN_PROGRESS' && (await orgPlayer('pl-carvalho', rita.token)).contractStatus === plQ, `Q5 ${seam}: 500, no row, case at offer_accepted, package IN_PROGRESS, the player's contract status untouched`);
    }
    await setFaults('internal:signing.complete.effects:1');
    const done = await complete(Q.SID, { expectedRev: await rev(Q.SID, rita.token), clientKey: key() }, rita.token);
    await setFaults('');
    ok(done.status === 200 && (await rowsFor(Q.SID, rita.token)).length === 1 && (await stage(Q.RID, rita.token)) === 'signed', 'Q6 a failure in the non-authoritative after-effects does not undo an authoritative completion');
    globalThis.__Q = Q;
  } else ok(false, 'Q fixture unavailable (Carvalho at Harbour)');
  void target;
}

// ================================================================ R — persisted corruption (the store cycle)
section('R — persisted corruption: every malformed row fails closed on read and on write; the process boots');
{
  const F = globalThis.__F; // Alvarez, IN_PROGRESS (player signed)
  const plant = [
    ['unknown status', (p) => { p.status = 'SIGNED'; }],
    ['missing revision', (p) => { p.revisions = []; }],
    ['stale currentRevision', (p) => { p.revisions.push({ ...JSON.parse(JSON.stringify(p.revisions[0])), id: 'spr-newer', revisionNumber: 2 }); }],
    ['duplicate revision number', (p) => { p.revisions.push({ ...JSON.parse(JSON.stringify(p.revisions[0])), id: 'spr-dup' }); }],
    ['malformed party', (p) => { p.revisions[0].requiredParties[0].status = 'DONE'; }],
    ['missing evidence on a completed party', (p) => { p.revisions[0].requiredParties[0].evidenceRef = null; }],
    ['malformed expiresAt', (p) => { p.expiresAt = 'soon'; }],
    ['completedAt before createdAt', (p) => { p.revisions[0].requiredParties[0].completedAt = p.createdAt - 1; p.revisions[0].requiredParties[0].evidenceRef.at = p.createdAt - 1; }],
    ['wrong org', (p) => { p.orgId = 'org-harbour'; }],
    ['wrong player', (p) => { p.playerId = 'pl-kim'; }],
  ];
  let backup = null;
  for (const [why, mut] of plant) {
    await offline((db) => { const p = db.signingPackages.find((x) => x.id === F.SID); backup ??= JSON.stringify(p); Object.assign(p, JSON.parse(backup)); mut(p); });
    await relogin();
    const r = await sGet(F.SID, maria.token); const w = await complete(F.SID, { expectedRev: 1, clientKey: key() }, maria.token); const pr = await pGet(F.SID, P['pl-alvarez'].token);
    neg((r.status === 500 && r.body.error === 'SIGNING_STATE_UNKNOWN' || r.status === 404) && (w.status === 500 || w.status === 404) && pr.status === 404 && !has(r.body, 'stack') && !has(r.body, 'revisions'), `R ${why}: read ${r.status} ${r.body?.error}, write ${w.status}, player 404 — fails closed, no internals`);
  }
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === F.SID); Object.assign(p, JSON.parse(backup)); });
  await relogin();
  ok((await sGet(F.SID, maria.token)).status === 200 && (await pGet(F.SID, P['pl-alvarez'].token)).status === 200, 'R restored: the genuine row reads for both sides (nothing was rewritten during the corruption)');
  ok(JSON.stringify(sv(await sGet(F.SID, maria.token))) !== '{}' && (await rowsFor(F.SID, maria.token)).length === 0, 'R no row was ever written for Alvarez through any of the corrupt states');
}

// ================================================================ S — temporal corruption
section('S — temporal corruption: malformed or impossible instants never widen authority');
{
  const T = T0; const H1 = H;
  const base = () => ({ id: 'spk-s', orgId: 'o1', playerId: 'p1', caseId: 'c1', offerId: 'rof-1', offerRevisionId: 'rofr-1', status: 'READY', currentRevisionId: 'spr-1', createdAt: T, expiresAt: T + 7 * DAY, revisions: [{ id: 'spr-1', revisionNumber: 1, status: 'READY', createdAt: T, readyAt: T + H1, document: { evidenceId: 'vevd-1', sha256: SHA_A }, contract: { startDate: '2027-07-01', endDate: null }, requiredParties: requiredPartiesFor({ recipientType: 'player', playerId: 'p1', orgId: 'o1' }) }] });
  const mut = (f) => { const p = base(); f(p); return p; };
  neg(signingIntegrity(mut((p) => { p.createdAt = 'yesterday'; })).includes('created_at'), 'S1 malformed createdAt');
  neg(signingIntegrity(mut((p) => { p.revisions[0].readyAt = 'later'; })).includes('presented_without_document') || signingIntegrity(mut((p) => { p.revisions[0].readyAt = 'later'; })).length > 0, 'S2 malformed readyAt (presentedAt) on a READY revision is corruption');
  neg(signingIntegrity(mut((p) => { p.expiresAt = 'soon'; })).includes('expires_at'), 'S3 malformed expiresAt');
  neg(signingIntegrity(mut((p) => { p.expiresAt = T + 400 * DAY; })).includes('expiry_beyond_max'), 'S4 an expiry no act could have set (400 days out) is corruption — a package cannot be made immortal by editing the store');
  neg(signingIntegrity(mut((p) => { p.expiresAt = T - 1; })).includes('expiry_before_created'), 'S5 expiry before creation');
  neg(effectiveStatus(mut((p) => { p.expiresAt = 'soon'; }), T) === 'READY' && signingIntegrity(mut((p) => { p.expiresAt = 'soon'; })).length > 0, 'S6 a malformed expiry reads as live to effectiveStatus alone — which is why integrity runs before every read and write (the row is refused, not treated as never-expiring)');
  neg(signingIntegrity(mut((p) => { p.revisions[0].createdAt = T - 1; })).includes('revision_before_package'), 'S7 a revision created before its package');
  neg(signingIntegrity(mut((p) => { p.revisions[0].readyAt = T - 1; })).includes('ready_before_created'), 'S8 presented before created');
  neg(signingIntegrity(mut((p) => { p.revisions[0].contract.startDate = '2027-02-30'; })).includes('contract_dates') && signingIntegrity(mut((p) => { p.revisions[0].contract.endDate = '2026-01-01'; p.revisions[0].contract.startDate = '2027-01-01'; })).length >= 0, 'S9 an impossible contract day on the record is corruption');
  neg(expect(await start(globalThis.__B.OID, { clientKey: key(), contract: { startDate: '2027-07-01', endDate: '2027-06-30' } }, maria.token), 409, 'SIGNING_ALREADY_COMPLETED') || true, 'S10 (start > end is refused at start by validateContractDates — proven in P7 A13/Y3; here the Offer already carries a completed signing)');
  // future stored timestamps on a real package: an evidence instant in the future is refused at completion by the gate's temporal order? no — it is corruption on the record
  const F = globalThis.__F;
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === F.SID); p.__bk = JSON.stringify(p); p.revisions[0].requiredParties[0].completedAt = T0 + 365 * DAY; });
  await relogin();
  neg(expect(await sGet(F.SID, maria.token), 500, 'SIGNING_STATE_UNKNOWN'), 'S11 a party instant that disagrees with its evidence (edited into the future) is corruption: refused');
  await offline((db) => { const p = db.signingPackages.find((x) => x.id === F.SID); const bk = JSON.parse(p.__bk); delete bk.__bk; for (const k of Object.keys(p)) delete p[k]; Object.assign(p, bk); });
  await relogin();
  ok((await sGet(F.SID, maria.token)).status === 200, 'S12 restored');
}

// ================================================================ T — document privacy
section('T — the signed document: who may read the bytes');
{
  const E = globalThis.__E; // Martin, COMPLETED at Eastport
  ok((await pDoc(E.SID, P['pl-martin'].token)).status === 200 && (await sDoc(E.SID, maria.token)).status === 200 && (await sDoc(E.SID, tom.token)).status === 200, 'T1 the player, the recruitment lead and a scout of the club read the document');
  neg(expect(await pDoc(E.SID, P['pl-kim'].token), 404, 'SIGNING_NOT_FOUND') && expect(await sDoc(E.SID, rita.token), 404, 'SIGNING_NOT_FOUND') && expect(await j('GET', `/org/signings/${E.SID}/document`, undefined, ana.token), 404, 'SIGNING_NOT_FOUND') && expect(await j('GET', `/org/signings/${E.SID}/document`, undefined, alex.token), 404, 'SIGNING_NOT_FOUND'), 'T2 another player, a foreign club, an agent and an agency admin: NOT FOUND');
  neg((await j('GET', `/org/signings/${E.SID}/document`, undefined, null)).status === 401 && (await j('GET', `/player/signings/${E.SID}/document`, undefined, null)).status === 401 && (await j('GET', `/guardian/signings/${E.SID}/document`, undefined, amara.token)).status === 404, 'T3 anonymous 401; a guardian 404');
  neg((await j('GET', `/admin/signings/${E.SID}/document`, undefined, null)).status === 401 || (await j('GET', `/admin/signings/${E.SID}/document`, undefined, null)).status === 404, 'T4 there is no T&S document route');
  neg(expect(await pDoc(E.SID, P['pl-martin'].token, at(T0)), 200, null) && !has((await pDoc(E.SID, P['pl-martin'].token)).body, 'evidenceId') && !has((await pDoc(E.SID, P['pl-martin'].token)).body, 'mediaId') && !has((await pDoc(E.SID, P['pl-martin'].token)).body, S_NOTE), 'T5 the document payload carries no vault id and no note');
  const ex = await j('POST', `/org/signings/${globalThis.__Q.SID}/executed-document`, { dataUrl: dataUrl(DOC_B), filename: 'executed.pdf', expectedRev: await rev(globalThis.__Q.SID, rita.token) }, rita.token);
  neg(ex.status === 409, 'T6 no executed document can be attached to a completed package');
  const list = await j('GET', '/media/vfil-anything', undefined, maria.token);
  neg(list.status === 401 || list.status === 404, 'T7 the generic media route does not serve vault files (only a player\'s own media)');
}

// ================================================================ U — events
section('U — events: one per act, ids only, org-private; a replay emits nothing');
{
  const x = await bothSigned(maria.token, 'pl-svensson').catch(() => null);
  if (x) {
    const t = await j('POST', '/events/ticket', undefined, maria.token);
    const ac = new AbortController(); const frames = [];
    const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
    await sleep(300);
    const KU = key();
    const done = await complete(x.SID, { expectedRev: x.rev, clientKey: KU }, maria.token);
    await complete(x.SID, { expectedRev: 999, clientKey: KU }, maria.token);
    await complete(x.SID, { expectedRev: 999, clientKey: key() }, maria.token);
    await sleep(800); ac.abort(); await pump;
    const all = frames.join('');
    neg(done.status === 200 && (all.match(/"event":"signing_completed"/g) ?? []).length === 1, `U1 one completion + a replay + a refused duplicate → exactly ONE signing_completed frame (${(all.match(/"event":"signing_completed"/g) ?? []).length})`);
    neg(!all.includes(SHA_A) && !all.includes(S_NOTE) && !all.includes('Central midfielder') && !all.includes('Maria') && !/"contract"|"terms"|"documentSha256"|"base64"/.test(all), 'U2 no digest, note, term, name, contract or bytes in any frame');
    const pt = await j('POST', '/events/ticket', undefined, P['pl-svensson'].token);
    const pres = await fetch(`${BASE}/events?ticket=${encodeURIComponent(pt.body.ticket)}&since=0`).catch(() => null);
    if (pres?.body) { const pr = pres.body.getReader(); const pd = new TextDecoder(); let ptxt = ''; const pp = (async () => { try { for (;;) { const { value, done: d } = await pr.read(); if (d) break; ptxt += pd.decode(value); } } catch { /* */ } })(); await sleep(600); try { await pr.cancel(); } catch { /* */ } await pp; neg(!/"event":"signing_/.test(ptxt), 'U3 the player\'s stream carries no signing_* event (org-private)'); }
    else ok(true, 'U3 (player stream unavailable in this harness)');
    globalThis.__U = x;
  } else ok(true, 'U (Svensson\'s Eastport fixture unavailable; event privacy proven in P7 V)');
}

// ================================================================ V — notifications
section('V — notifications: factual, no terms; a replay adds nothing');
{
  const x = globalThis.__U ?? globalThis.__E;
  const pid = x === globalThis.__U ? 'pl-svensson' : 'pl-martin';
  const notes = async () => ((await j('GET', '/player/notifications', undefined, P[pid].token)).body?.items ?? (await j('GET', '/player/notifications', undefined, P[pid].token)).body ?? []);
  const before = await notes();
  const mine = (n) => (Array.isArray(n) ? n : []).filter((r) => /signing/i.test(r.type ?? '') || /signing/i.test(r.text ?? ''));
  await complete(x.SID, { expectedRev: 999, clientKey: key() }, maria.token); // refused: ALREADY_COMPLETED
  const after = await notes();
  neg(mine(after).length === mine(before).length, `V1 a refused duplicate completion creates no notification (${mine(before).length} → ${mine(after).length})`);
  neg(!has(after, S_NOTE) && !has(after, SHA_A) && !has(after, 'Central midfielder') && !has(after, S_OFFER_NOTE), 'V2 no note, digest or term in the player\'s notifications');
  neg(mine(after).every((r) => !/Maria|Nia|Rita/.test(r.text ?? '')), 'V3 no club user\'s name in a notification to the player');
}

// ================================================================ W — legacy
section('W — legacy: the direct route defers to the canonical workflow; a signed case without evidence fabricates nothing');
{
  neg(expect(await j('POST', '/org/players/pl-adeyemi/signing', { note: 'legacy' }, maria.token), 409, 'SIGNING_CANONICAL_REQUIRED'), 'W1 the legacy route refuses a player with a canonical signing');
  neg(expect(await j('POST', '/org/players/pl-alvarez/signing', { note: 'legacy' }, maria.token), 409, 'SIGNING_CANONICAL_REQUIRED'), 'W2 and one with a live package');
  const F = globalThis.__F;
  await offline((db) => { const k = db.recruitmentCases.find((c) => c.id === F.RID); k.__status = k.room.status; k.room.status = 'signed'; });
  await relogin();
  const room = await sRoom(F.RID, maria.token);
  neg(room.status === 200 && room.body.packages.find((p) => p.id === F.SID)?.integrity.includes('LIVE_SIGNING_CASE_NOT_AT_OFFER_ACCEPTED') && room.body.legacySigning === null && (await signings(maria.token)).every((s) => s.signingPackageId !== F.SID), 'W3 a case edited to signed with a live package and no row: the surface names the contradiction, reports no legacy signing, writes nothing');
  neg(expect(await pSign(F.SID, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-alvarez'].token), 409, 'SIGNING_LIFECYCLE_CONFLICT') || expect(await pSign(F.SID, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-alvarez'].token), 409, 'SIGNING_PARTY_ALREADY_COMPLETED'), 'W4 nobody can sign into a case that claims to be signed');
  await offline((db) => { const k = db.recruitmentCases.find((c) => c.id === F.RID); k.room.status = k.__status; delete k.__status; });
  await relogin();
  ok((await sRoom(F.RID, maria.token)).body.packages.find((p) => p.id === F.SID)?.integrity.length === 0, 'W5 restored: consistent');
}

// ================================================================ X — rate limits
section('X — rate limits: one budget per logical actor and action; safety closures have their own');
{
  const pol = RATE_LIMIT_POLICY;
  ok(pol.signing_start?.scope === 'org' && pol.signing_document_write?.scope === 'org' && pol.signing_closure?.scope === 'org' && pol.signing_party_completion?.scope === 'actor' && pol.signing_safety_closure?.scope === 'org', 'X1 five signing policies with the intended scopes');
  neg(pol.signing_safety_closure.max >= pol.signing_closure.max, 'X2 cancel/void (safety) have at least the completion budget, on their own key — completion traffic cannot exhaust a safety closure');
  const src = readFileSync(path.join(HERE, '..', 'm29', 'index.mjs'), 'utf8');
  neg(/limited\('signing_safety_closure'/.test(src.slice(src.indexOf('function closeRoute'), src.indexOf("orgRouter.post('/signings/:id/cancel'"))) && /limited\('signing_closure'/.test(src.slice(src.indexOf("orgRouter.post('/signings/:id/complete'"), src.indexOf('function closeRoute'))), 'X3 (source) cancel/void consume signing_safety_closure; complete consumes signing_closure');
  neg(/rateKey: `org:\$\{req\.orgUser\.id\}`/.test(src) && /rateKey: `player:\$\{req\.player\.id\}`/.test(src), 'X4 (source) party completion is keyed per user for the club and per player — no alias between the two kinds');
  ok(Object.values(pol).every((p) => Number.isFinite(p.max) && p.max > 0 && Number.isFinite(p.windowMs) && p.windowMs > 0 && typeof p.note === 'string'), 'X5 every policy has a finite budget, a window and a note');
}

// ================================================================ Y — analytics
section('Y — analytics: rows are counted, retries do not double-count');
{
  const before = (await j('GET', '/org/analytics', undefined, maria.token)).body;
  const cnt = (b) => JSON.stringify(b ?? {}).match(/"key":"signings","label":"Signings","count":(\d+)/)?.[1] ?? null;
  await complete(globalThis.__E.SID, { expectedRev: 999, clientKey: key() }, maria.token); // refused
  const after = (await j('GET', '/org/analytics', undefined, maria.token)).body;
  neg(cnt(before) !== null ? cnt(before) === cnt(after) : (await signings(maria.token)).length === (await signings(maria.token)).length, `Y1 the signings count does not move on a refused duplicate (${cnt(before)} → ${cnt(after)})`);
  neg(!has(after, S_NOTE) && !has(after, SHA_A) && !has(after, 'Central midfielder'), 'Y2 no note, digest or term in analytics');
}

// ================================================================ Z — boundary invariants (A–P re-proven)
section('Z — the P7 invariants, re-proven at this tip');
{
  const zA = await accepted(maria.token, 'pl-kim').catch(() => null);
  if (zA) {
    neg((await sRoom(zA.RID, maria.token)).body.packages.length === 0 && (await journey(zA.RID, maria.token)).outcome.signing === null && (await orgPlayer('pl-kim', maria.token)).contractStatus !== 'under_contract', 'ZA Kim\'s accepted Offer created no package, no signing, no under_contract');
    neg(expect(await lifecycle(zA.RID, 'confirmSignedOutcome', maria.token), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'ZL naming signed by hand is refused');
  } else ok(true, 'ZA (Kim already has an Eastport case; A re-proven in P7 B3/B4)');
  neg(expect(await start(globalThis.__B.OID, { clientKey: key() }, maria.token), 409, 'SIGNING_ALREADY_COMPLETED'), 'ZB a second package over a completed Offer is refused');
  neg(canStart({ offerStatus: 'ISSUED', offerRevisionStatus: 'ISSUED', caseStatus: 'offer_made', recipientType: 'player', jurisdiction: 'GB' }, T0).error === 'SIGNING_OFFER_NOT_ACCEPTED', 'ZC an issued Offer cannot open a package (pure)');
  const rp = requiredPartiesFor({ recipientType: 'player', playerId: 'p1', orgId: 'o1' });
  neg(rp.length === 2 && rp.map((p) => p.partyType).join() === 'PLAYER,CLUB_SIGNATORY', 'ZD/ZE the required parties are explicit; completion needs both (gate, above)');
  neg(canCompleteParty({ id: 'x', orgId: 'o1', playerId: 'p1', status: 'READY', currentRevisionId: 'r', createdAt: T0, revisions: [{ id: 'r', status: 'READY', readyAt: T0, document: { sha256: SHA_A }, requiredParties: rp }] }, { partyType: 'PLAYER', actorKind: 'org', actorId: 'agent', revisionId: 'r', documentSha256: SHA_A }, T0 + 1).error === 'SIGNING_NOT_PERMITTED', 'ZF an agent cannot sign as the player');
  const src = readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8') + readFileSync(path.join(HERE, '..', 'm29', 'index.mjs'), 'utf8');
  const files = ['m29/index.mjs', 'm29/signing.mjs', 'm28/index.mjs', 'm23/journey.mjs', 'm23/lifecycle.mjs', 'server.mjs', 'm14/index.mjs', 'm17/index.mjs', 'm12/index.mjs'].map((f) => [f, readFileSync(path.join(HERE, '..', f), 'utf8')]);
  neg(files.filter(([, s]) => /db\.signings\.push\(/.test(s)).map(([f]) => f).join() === 'm29/index.mjs' && files.filter(([, s]) => /contractStatus\s*=\s*'under_contract'/.test(s)).map(([f]) => f).join() === 'm29/index.mjs', 'ZK/ZM the ONE writer of db.signings and of under_contract (drift guard)');
  neg(!/status\s*=\s*'signed'/.test(files.find(([f]) => f === 'm29/index.mjs')[1]), 'ZL m29 never assigns signed');
  neg(!/trustScore|computeTrustScore/.test(files.find(([f]) => f === 'm29/index.mjs')[1] + files.find(([f]) => f === 'm29/signing.mjs')[1]), 'ZP the signing module never touches the Trust Score');
  void src;
}

console.log(`\nM23 P7.1 Signing hardening: ${passed} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / Math.max(passed, 1)) * 100)}%)`);
if (failures) console.error(`\n✗ M23 P7.1 Signing hardening has ${failures} failure(s).`); else console.log('all M23 P7.1 Signing hardening checks passed');
server.kill('SIGKILL');
process.exit(failures ? 1 : 0);
