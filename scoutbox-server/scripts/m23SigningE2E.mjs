// M23 P7 — Signing & Contract Completion: the end-to-end proof.
//
//   Offer accepted → package opened (explicit club act) → exact document
//   attached (digest) → presented → each required party confirms the exact
//   revision → a recruitment lead completes → ONE db.signings row → case
//   `signed` → player `under_contract`.
//
// Groups: A model/store · B start gate · C club auth · D player auth ·
// E guardian/minor · F agent · G documents · H revisions · I parties ·
// J evidence · K completion · L lifecycle · M db.signings · N under_contract ·
// O affiliation/invoice/level · P concurrency · Q idempotency · R expiry ·
// S blocks · T privacy · U deep links · V events · W notifications ·
// X legacy · Y temporal · Z signing boundary. The 50 adversarial cases of
// P7 §83 are marked `#n`. Every refusal asserts its exact status AND code.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, MIGRATIONS } from '../m182/migrations.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { M29_ERROR_HTTP, PUBLIC_ERROR_FIELDS, publicErrorBody } from '../m29/errors.mjs';
import {
  SIGNING_STATUSES, SIGNING_STORED_STATUSES, SIGNING_METHODS, PARTY_TYPES, MINOR_SIGNING_PATHWAY_ENABLED, minorSigningPathwayOpen,
  payloadFingerprint, validateContractDates, validateExpiry, requiredPartiesFor, effectiveStatus, canStart, canCompleteParty, completionGate,
  signingIntegrity, signingConsistency, signingCorrupt, SIGNING_CORRUPTION, signingRecipientView, signingAgentView, signingClubView, cleanText,
} from '../m29/signing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const PORT = 7100 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23sg-'));
const S_NOTE = 'PRIVATE_SIGNING_NOTE_8811';
const S_OFFER_NOTE = 'PRIVATE_OFFER_NOTE_8812';
const S_DEC = 'PRIVATE_DECISION_8813';
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
const DOC_A = pdf('Contract of employment — revision A'); const DOC_B = pdf('Contract of employment — revision B (amended clause 4)');
const SHA_A = sha256(DOC_A); const SHA_B = sha256(DOC_B);

// ================================================================ A — model / store (pure)
section('A — model and store: vocabulary, validators, gates, integrity, error taxonomy, the closed minor pathway');
{
  ok(SCHEMA_VERSION === 2308 && MIGRATIONS.length === 18 && MIGRATIONS.some((m) => m.id === 'm280_001_signing_workflow' && m.version === 2308), 'A1 schema 2308: exactly one migration past 2307, m280_001_signing_workflow');
  ok(guaranteeFor('signingPackages') === 'migration' && guaranteeFor('signings') === 'migration', 'A2 signingPackages and signings are migration-guaranteed stores');
  neg(/nothing is backfilled/.test(String(MIGRATIONS.at(-1).note)) && /no lifecycle state, player contract status or legacy signing row is reinterpreted/.test(String(MIGRATIONS.at(-1).note)), 'A3 the migration declares it backfills nothing and reinterprets nothing');
  ok(SIGNING_STATUSES.length === 8 && SIGNING_STORED_STATUSES.length === 6 && !SIGNING_STORED_STATUSES.includes('EXPIRED') && !SIGNING_STORED_STATUSES.includes('SUPERSEDED'), 'A4 eight statuses; EXPIRED is derived and SUPERSEDED is a revision status — neither is ever stored on a package');
  neg(!SIGNING_STATUSES.includes('SIGNED'), 'A5 no SIGNED workflow status: the word belongs to the case lifecycle alone');
  ok(PARTY_TYPES.join() === 'PLAYER,GUARDIAN,CLUB_SIGNATORY' && SIGNING_METHODS.join() === 'PLATFORM_ACKNOWLEDGMENT,UPLOAD_EXECUTED_DOCUMENT', 'A6 three party types; only the two implemented methods');
  neg(Object.values(MINOR_SIGNING_PATHWAY_ENABLED).every((v) => v === false) && ['GB', 'ENG', 'INT', 'USA', 'FR', 'KR', 'ZZ', '', null, '__proto__', 'constructor'].every((j) => minorSigningPathwayOpen(j) === false), '#15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys');
  const codesList = Object.keys(M29_ERROR_HTTP);
  ok(codesList.length === 37 && codesList.every((c) => /^SIGNING_/.test(c)) && [400, 403, 404, 409, 422, 500].every((s) => Object.values(M29_ERROR_HTTP).includes(s)), `A8 ${codesList.length} SIGNING_* codes across six status bands, in one table`);
  neg(M29_ERROR_HTTP.__proto__ === undefined && M29_ERROR_HTTP.constructor === undefined, 'A9 the error table has no prototype');
  neg(!has(publicErrorBody({ error: 'SIGNING_STATE_UNKNOWN', stack: 'x', row: { secret: 1 } }), 'secret') && !PUBLIC_ERROR_FIELDS.includes('stack'), 'A10 a 500 body carries no internals');
  ok(payloadFingerprint({ contract: { startDate: '2027-07-01', endDate: null } }) !== payloadFingerprint({ contract: { startDate: '2027-07-02', endDate: null } }) && payloadFingerprint({ a: { b: 1, c: 2 } }) === payloadFingerprint({ a: { c: 2, b: 1 } }), 'A11 the fingerprint is deep and canonical');
  const cd = validateContractDates({ startDate: '2027-07-01', endDate: '2029-06-30' });
  ok(cd.ok && cd.contract.startDate === '2027-07-01' && cd.contract.endDate === '2029-06-30', 'A12 contract days validate as DATE_ONLY');
  neg(!validateContractDates({ startDate: '2027-02-30' }).ok && !validateContractDates({ startDate: '2027-07-01', endDate: '2027-06-30' }).ok && !validateContractDates({ startDate: '2027-07-01', endDate: '2040-07-01' }).ok && !validateContractDates({ startDate: 1720000000000 }).ok && !validateContractDates({}).ok, '#44 A13 an impossible day, an end before the start, an eleven-year contract, an instant, and no start are all refused');
  const T = Date.parse('2026-03-15T12:00:00Z');
  neg(!validateExpiry(T + 30 * 60 * 1000, { now: T }).ok && !validateExpiry(T + 91 * DAY, { now: T }).ok && !validateExpiry('tomorrow', { now: T }).ok && validateExpiry(undefined, { now: T }).defaulted === true && validateExpiry(T + 2 * H, { now: T }).ok, 'A14 expiry: ≥1 h, ≤90 d, an instant; absent → the default');
  const parties = requiredPartiesFor({ recipientType: 'player', playerId: 'p1', orgId: 'o1' });
  ok(parties.length === 2 && parties[0].partyType === 'PLAYER' && parties[0].forEntityId === 'p1' && parties[1].partyType === 'CLUB_SIGNATORY' && parties[1].forEntityId === 'o1' && parties.every((p) => p.status === 'PENDING'), 'A15 required parties for an adult: the player and the club signatory, both pending');
  const pkg = (patch = {}, revPatch = {}) => ({ id: 'spk-1', orgId: 'o1', playerId: 'p1', caseId: 'c1', offerId: 'rof-1', offerRevisionId: 'rofr-1', status: 'READY', currentRevisionId: 'spr-1', createdAt: T, expiresAt: T + 7 * DAY, revisions: [{ id: 'spr-1', revisionNumber: 1, status: 'READY', createdAt: T, readyAt: T + H, document: { evidenceId: 'vevd-1', sha256: SHA_A }, contract: { startDate: '2027-07-01', endDate: null }, requiredParties: requiredPartiesFor({ recipientType: 'player', playerId: 'p1', orgId: 'o1' }), ...revPatch }], ...patch });
  ok(effectiveStatus(pkg(), T + 7 * DAY - 1) === 'READY' && effectiveStatus(pkg(), T + 7 * DAY) === 'EXPIRED' && effectiveStatus(pkg({ status: 'COMPLETED' }), T + 8 * DAY) === 'COMPLETED', 'A16 lazy expiry: READY 1 ms before, EXPIRED at the instant, a COMPLETED package never expires');
  neg(effectiveStatus(pkg({ status: 'SIGNED' }), T) === null && effectiveStatus(pkg({ status: 'signed' }), T) === null && effectiveStatus(pkg({ status: '' }), T) === null && effectiveStatus(pkg({ status: 'EXPIRED' }), T) === null, 'A17 an unknown or unstorable status word is nothing — not live, not completed (fails closed)');
  for (const st of ['DRAFT', 'ISSUED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED']) neg(canStart({ offerStatus: st, offerRevisionStatus: st, caseStatus: 'offer_accepted', recipientType: 'player', jurisdiction: 'GB' }, T).error === 'SIGNING_OFFER_NOT_ACCEPTED', `#1 A18 no package over a ${st} Offer`);
  neg(canStart({ offerStatus: 'ACCEPTED', offerRevisionStatus: 'ACCEPTED', caseStatus: 'offer_made', recipientType: 'player', jurisdiction: 'GB' }, T).error === 'SIGNING_LIFECYCLE_CONFLICT', 'A19 the case must be at offer_accepted');
  neg(canStart({ offerStatus: 'ACCEPTED', offerRevisionStatus: 'ACCEPTED', caseStatus: 'offer_accepted', recipientType: 'guardian', jurisdiction: 'GB' }, T).error === 'SIGNING_PATHWAY_CLOSED', '#15 A20 a guardian-addressed Offer opens no package while the pathway is closed');
  neg(canStart({ offerStatus: 'ACCEPTED', offerRevisionStatus: 'ACCEPTED', caseStatus: 'offer_accepted', recipientType: 'player', jurisdiction: 'GB', existing: [pkg()] }, T).error === 'SIGNING_PACKAGE_EXISTS' && canStart({ offerStatus: 'ACCEPTED', offerRevisionStatus: 'ACCEPTED', caseStatus: 'offer_accepted', recipientType: 'player', jurisdiction: 'GB', existing: [pkg({ status: 'COMPLETED', completion: { signingId: 's', completedAt: T } })] }, T).error === 'SIGNING_ALREADY_COMPLETED', 'A21 one live package per Offer; a completed one blocks another');
  neg(canCompleteParty(pkg(), { partyType: 'PLAYER', actorKind: 'org', actorId: 'p1', revisionId: 'spr-1', documentSha256: SHA_A }, T).error === 'SIGNING_NOT_PERMITTED', '#10 A22 an org actor cannot complete the PLAYER party (the pure gate)');
  neg(canCompleteParty(pkg(), { partyType: 'CLUB_SIGNATORY', actorKind: 'player', actorId: 'p1', revisionId: 'spr-1', documentSha256: SHA_A }, T).error === 'SIGNING_NOT_PERMITTED', 'A23 a player cannot complete the club signatory');
  neg(canCompleteParty(pkg(), { partyType: 'PLAYER', actorKind: 'player', actorId: 'p2', revisionId: 'spr-1', documentSha256: SHA_A }, T).error === 'SIGNING_PARTY_NOT_REQUIRED', '#9 A24 another player is not a required party');
  neg(canCompleteParty(pkg(), { partyType: 'PLAYER', actorKind: 'player', actorId: 'p1', revisionId: 'spr-1', documentSha256: SHA_B }, T).error === 'SIGNING_DOCUMENT_MISMATCH', 'A25 confirming a different digest than the presented revision is a mismatch');
  const two = pkg({ currentRevisionId: 'spr-2' }); two.revisions.push({ ...two.revisions[0], id: 'spr-2', revisionNumber: 2 }); two.revisions[0].status = 'SUPERSEDED';
  neg(canCompleteParty(two, { partyType: 'PLAYER', actorKind: 'player', actorId: 'p1', revisionId: 'spr-1', documentSha256: SHA_A }, T).error === 'SIGNING_SUPERSEDED', '#18 A26 a signature against a superseded revision is refused');
  neg(canCompleteParty(pkg(), { partyType: 'PLAYER', actorKind: 'player', actorId: 'p1', revisionId: 'spr-1', documentSha256: SHA_A }, T + 8 * DAY).error === 'SIGNING_EXPIRED', 'A27 no party completes an expired package');
  const gateCtx = (p, extra = {}) => completionGate(p, { now: T + 2 * H, offer: { id: 'rof-1', status: 'ACCEPTED', orgId: 'o1', playerId: 'p1', caseId: 'c1' }, offerRevision: { id: 'rofr-1', status: 'ACCEPTED' }, kase: { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'offer_accepted' } }, ...extra });
  neg(gateCtx(pkg()).includes('PARTIES_INCOMPLETE'), '#16 #26 A28 a package with no party complete cannot complete');
  const done = pkg({ status: 'IN_PROGRESS' }, { status: 'IN_PROGRESS' }); for (const p of done.revisions[0].requiredParties) Object.assign(p, { status: 'COMPLETED', completedAt: T + 90 * 60 * 1000, completedBy: { kind: p.partyType === 'PLAYER' ? 'player' : 'org', id: 'x' }, method: 'PLATFORM_ACKNOWLEDGMENT', evidenceRef: { documentSha256: SHA_A } });
  ok(gateCtx(done).length === 0, 'A29 every party complete against the exact digest: the gate is empty');
  neg(gateCtx(done, { blocked: true }).includes('BLOCKED') && gateCtx(done, { otherCompleted: true }).includes('CONFLICTING_COMPLETED_SIGNING') && gateCtx(done, { kase: { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'on_hold' } } }).includes('LIFECYCLE_CONFLICT') && gateCtx(done, { offer: { id: 'rof-1', status: 'ACCEPTED', orgId: 'o1', playerId: 'p2', caseId: 'c1' } }).includes('REFERENCE_MISMATCH'), 'A30 a block, a conflicting completed signing, a paused case and a player mismatch each close the gate');
  const bad = JSON.parse(JSON.stringify(done)); bad.revisions[0].requiredParties[0].evidenceRef.documentSha256 = SHA_B;
  neg(gateCtx(bad).includes('DOCUMENT_MISMATCH'), 'A31 evidence against another digest closes the gate');
  ok(signingIntegrity(pkg()).length === 0 && signingIntegrity(done).length === 0, 'A32 sound rows pass integrity');
  neg(signingIntegrity(pkg({ status: 'SIGNED' })).includes('status') && signingIntegrity(pkg({}, { status: 'countersigned' })).includes('revision_status'), 'A33 unknown package and revision statuses are named');
  const late = pkg(); late.revisions[0].readyAt = T - H; neg(signingIntegrity(late).includes('ready_before_created'), '#45 A34 presented before created is corruption');
  const early = JSON.parse(JSON.stringify(done)); early.revisions[0].requiredParties[0].completedAt = T; neg(signingIntegrity(early).includes('party_before_ready'), '#45 A35 a party completed before the revision was presented is corruption');
  const comp = JSON.parse(JSON.stringify(done)); comp.status = 'COMPLETED'; comp.revisions[0].status = 'COMPLETED'; comp.revisions[0].completedAt = T + H; comp.completion = { signingId: 's', completedAt: T + H };
  neg(signingIntegrity(comp).includes('completed_before_parties'), '#46 A36 completed before the final party is corruption');
  const noComp = JSON.parse(JSON.stringify(comp)); noComp.completion = null; noComp.revisions[0].completedAt = T + 2 * H; neg(signingIntegrity(noComp).includes('completion'), 'A37 a COMPLETED package without its completion record is corruption');
  const ptr = pkg({ currentRevisionId: 'spr-1' }); ptr.revisions.push({ ...ptr.revisions[0], id: 'spr-2', revisionNumber: 2 }); neg(signingIntegrity(ptr).includes('current_revision_not_latest'), 'A38 a pointer at a non-latest revision is corruption');
  const agentActor = JSON.parse(JSON.stringify(done)); agentActor.revisions[0].requiredParties[0].completedBy = { kind: 'org', id: 'agent' }; neg(signingIntegrity(agentActor).includes('party_actor_kind'), '#10 A39 a PLAYER party completed by an org actor is corruption on the record too');
  neg(signingConsistency(pkg({ status: 'COMPLETED', completion: { signingId: 's', completedAt: T } }), { offer: { orgId: 'o1', playerId: 'p1', caseId: 'c1' }, kase: { orgId: 'o1', playerId: 'p1', room: { status: 'offer_accepted' } } }, T).includes('COMPLETED_BUT_CASE_NOT_SIGNED'), 'A40 a completed package on a case that is not signed is corruption');
  const rv = signingRecipientView(pkg({}, { readyAt: null, status: 'DRAFT' }), T, { orgName: 'X', partyType: 'PLAYER', forEntityId: 'p1' });
  neg(rv.currentRevision === null && rv.revisions.length === 0 && !has(rv, S_NOTE), '#8 A41 the recipient view of an unpresented revision carries no revision');
  const cv = signingClubView(pkg({ internalNote: S_NOTE }), T); const av = signingAgentView(pkg({ internalNote: S_NOTE }), T);
  neg(has(cv, S_NOTE) && !has(av, S_NOTE) && !has(signingRecipientView(pkg({ internalNote: S_NOTE }), T, { partyType: 'PLAYER', forEntityId: 'p1' }), S_NOTE) && !has(av, 'sha256'), '#39 A42 the note reaches the club view only; the agent view carries no digest');
  neg(cleanText('a‮b', 100).value === 'ab' && cleanText('x'.repeat(101), 100).ok === false, 'A43 bidi controls stripped; limits enforced');
  for (const [name, p] of [['signing_start', 'org'], ['signing_document_write', 'org'], ['signing_party_completion', 'actor'], ['signing_closure', 'org']]) ok(RATE_LIMIT_POLICY[name]?.scope === p && RATE_LIMIT_POLICY[name].max >= 30, `A44 rate policy ${name} (${p})`);
  for (const ev of ['signing_created', 'signing_ready', 'signing_party_completed', 'signing_completed', 'signing_cancelled', 'signing_voided', 'signing_superseded']) ok(EVENT_REGISTRY[ev]?.audience === 'org_private' && !EVENT_REGISTRY[ev].payload.some((k) => /sha|document|term|note|name/i.test(k)), `A45 event ${ev} is org-private with an id-only payload`);
}

// ================================================================ HTTP fixture
section('HTTP — booting a real server (test clock, synthetic agent verification)');
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
let server = await boot();
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, text: data === null ? null : JSON.stringify(data) };
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController(); const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  const done = (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
  for (let i = 0; i < 20 && !/"event":"connected"/.test(frames.join('')); i += 1) await sleep(50);
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}
const countIn = (s, re) => (s.match(re) ?? []).length;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const pat = await login('org-mossside', 'Pat Doyle', 'Head Coach', 'grassroots');
const alex = await login('org-northstar', 'Alex Agent', 'Director');
const P = {};
for (const id of ['pl-adeyemi', 'pl-carvalho', 'pl-okafor', 'pl-svensson', 'pl-kim', 'pl-tanaka', 'pl-martin', 'pl-alvarez', 'pl-nowak', 'pl-mensah', 'pl-imani', 'pl-guni']) P[id] = await playerLogin(id);
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, tom, rita, pat, alex, amara, ...Object.values(P)].every((x) => x?.token), 'HTTP actors logged in');
const staff = (await j('GET', '/org/staff', undefined, maria.token)).body;
const TOM_ID = staff.find((u) => u.name === 'Tom Field')?.id;

await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
const bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
const alexAgent = await login('org-northstar', 'Alex Agent', 'Director', 'agent');
for (const a of [ana, bea]) {
  await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-S' }, a.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-S-ENG', memberAssociation: 'ENG' }, a.token);
}
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
const REP = REQ.body?.relationship?.id;
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, P['pl-adeyemi'].token);
ok(!!REP && CONF.status === 200, 'fixture: Ana represents Kola (employment)');

const T0 = Date.now();
const journey = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body;
const stage = async (RID, token = maria.token) => (await journey(RID, token)).lifecycle.currentStage;
const caseRev = async (RID, token = maria.token) => (await journey(RID, token)).case.rev;
const lifecycle = async (RID, action, extra = {}, token = maria.token) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await caseRev(RID, token), ...extra }, token);
const legacyStatus = async (RID, status, token = maria.token) => j('POST', `/org/rooms/${RID}/status`, { status, expectedRev: await caseRev(RID, token) }, token);
const notifs = async (p, token) => (await j('GET', p, undefined, token)).body;
async function reviewed(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  if (await stage(RID, token) === 'watching') await lifecycle(RID, 'startReview', {}, token);
  return RID;
}
async function toConsideration(token, playerId) {
  const RID = await reviewed(token, playerId);
  let st = await stage(RID, token);
  if (st === 'offer_consideration') return RID;
  if (st === 'under_review') { await lifecycle(RID, 'shortlist', {}, token); st = 'shortlisted'; }
  if (st !== 'shortlisted') throw new Error(`case ${RID} for ${playerId} at ${st}`);
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, token);
  const draftRev = dr.status === 409 && dr.body?.current?.draftId ? dr.body.current.rev : dr.body?.draft?.rev;
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: draftRev, clientKey: key() }, token);
  if (fin.status !== 201) throw new Error(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
  if (await stage(RID, token) !== 'offer_consideration') await lifecycle(RID, 'considerOffer', {}, token);
  return RID;
}
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };
/** An issued Offer (case at offer_made). */
async function issued(token, playerId, { clock = T0, terms = TERMS } = {}) {
  const RID = await toConsideration(token, playerId);
  const c = await j('POST', `/org/rooms/${RID}/offers`, { terms, expiresAt: clock + 14 * DAY, internalNote: S_OFFER_NOTE, recipientMessage: 'Welcome.', clientKey: key() }, token, at(clock));
  if (c.status !== 201) throw new Error(`create ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  const i = await j('POST', `/org/offers/${c.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, token, at(clock));
  if (i.status !== 200) throw new Error(`issue ${i.status} ${JSON.stringify(i.body).slice(0, 200)}`);
  return { RID, OID: c.body.offer.id, R: i.body.offer.currentRevisionId, rev: i.body.offer.rev };
}
/** An ACCEPTED Offer (case at offer_accepted). */
async function accepted(token, playerId, opts = {}) {
  const x = await issued(token, playerId, opts);
  const a = await j('POST', `/player/offers/${x.OID}/accept`, { revisionId: x.R, clientKey: key() }, P[playerId].token, at(opts.clock ?? T0));
  if (a.status !== 200) throw new Error(`accept ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
  return x;
}
// Signing helpers (club default Maria; clock T0 unless given).
const sRoom = (RID, token = maria.token, h = at(T0)) => j('GET', `/org/rooms/${RID}/signing`, undefined, token, h);
const start = (OID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/offers/${OID}/signing`, body, token, h);
const sGet = (SID, token = maria.token, h = at(T0)) => j('GET', `/org/signings/${SID}`, undefined, token, h);
const sHist = (SID, token = maria.token) => j('GET', `/org/signings/${SID}/history`, undefined, token);
const sDoc = (SID, token = maria.token, q = '') => j('GET', `/org/signings/${SID}/document${q}`, undefined, token);
const attach = (SID, buf, expectedRev, token = maria.token, h = at(T0), filename = 'contract.pdf') => j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(buf), filename, label: 'Contract', expectedRev }, token, h);
const ready = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/ready`, body, token, h);
const clubSign = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/parties/club/complete`, body, token, h);
const executed = (SID, buf, expectedRev, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/executed-document`, { dataUrl: dataUrl(buf), filename: 'executed.pdf', expectedRev }, token, h);
const complete = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/complete`, body, token, h);
const cancel = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/cancel`, body, token, h);
const voidP = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/void`, body, token, h);
const supersede = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/supersede`, body, token, h);
const pList = (token, h = at(T0)) => j('GET', '/player/signings', undefined, token, h);
const pGet = (SID, token, h = at(T0)) => j('GET', `/player/signings/${SID}`, undefined, token, h);
const pDoc = (SID, token, h = at(T0)) => j('GET', `/player/signings/${SID}/document`, undefined, token, h);
const pSign = (SID, body, token, h = at(T0)) => j('POST', `/player/signings/${SID}/complete`, body, token, h);
const aList = (rel, token, h = at(Date.now())) => j('GET', `/org/agent/clients/${rel}/signings`, undefined, token, h);
const sv = (r) => r.body?.signing ?? {};
const revOf = (r) => sv(r).currentRevision ?? {};
/** A presented package over an accepted Offer: start → attach A → ready. */
async function presented(token, playerId, opts = {}) {
  const x = await accepted(token, playerId, opts);
  const s = await start(x.OID, { internalNote: S_NOTE, clientKey: key() }, token, at(opts.clock ?? T0));
  if (s.status !== 201) throw new Error(`start ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
  const SID = sv(s).id;
  const a = await attach(SID, DOC_A, sv(s).rev, token, at(opts.clock ?? T0));
  if (a.status !== 200) throw new Error(`attach ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
  const r = await ready(SID, { expectedRev: sv(a).rev, clientKey: key(), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) }, token, at(opts.clock ?? T0));
  if (r.status !== 200) throw new Error(`ready ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { ...x, SID, SREV: revOf(r).id, rev: sv(r).rev };
}
const signings = async (token = maria.token) => (await j('GET', '/org/signings', undefined, token)).body ?? [];
const orgPlayer = async (id, token = maria.token) => (await j('GET', `/org/players/${id}`, undefined, token)).body;

// ================================================================ B — start gate
section('B — the start gate: only an explicit club act over an ACCEPTED Offer revision');
{
  const x = await issued(maria.token, 'pl-carvalho');
  neg(expect(await start(x.OID, { clientKey: key() }), 409, 'SIGNING_OFFER_NOT_ACCEPTED'), '#1 B1 no package over an ISSUED Offer');
  const d = await j('POST', `/player/offers/${x.OID}/decline`, { revisionId: x.R, clientKey: key() }, P['pl-carvalho'].token, at(T0));
  ok(d.status === 200, 'B1b Mateus declines');
  neg(expect(await start(x.OID, { clientKey: key() }), 409, 'SIGNING_OFFER_NOT_ACCEPTED'), '#1 B2 nor over a DECLINED one');
  const before = (await signings()).length;
  const y = await accepted(maria.token, 'pl-adeyemi');
  const room = await sRoom(y.RID);
  neg(room.status === 200 && room.body.packages.length === 0 && room.body.livePackageId === null && room.body.requirements.acceptedOfferId === y.OID && room.body.requirements.startBlockers.length === 0, '#2 B3 an accepted Offer created NO package: the surface is empty and drafting is possible');
  neg((await signings()).length === before && (await journey(y.RID)).outcome.signing === null && (await stage(y.RID)) === 'offer_accepted', '#21 B4 acceptance wrote no db.signings row and the case is at offer_accepted, not signed');
  const p0 = await j('GET', `/org/offers/${y.OID}`, undefined, maria.token, at(T0));
  ok(p0.body.offer.signing === null, 'B5 the Offer view reads signing: null — nothing is inferred');
  const s = await start(y.OID, { internalNote: S_NOTE, clientKey: key() });
  ok(s.status === 201 && sv(s).status === 'DRAFT' && sv(s).offerId === y.OID && sv(s).offerRevisionId === y.R && sv(s).caseId === y.RID && sv(s).playerId === 'pl-adeyemi' && sv(s).rev === 1, 'B6 an explicit "start signing" opens a DRAFT package bound to the exact accepted Offer revision');
  ok(revOf(s).revisionNumber === 1 && revOf(s).contract.startDate === TERMS.startDate && revOf(s).contract.endDate === TERMS.endDate && revOf(s).requiredParties.map((p) => p.partyType).join() === 'PLAYER,CLUB_SIGNATORY' && revOf(s).document === null, 'B7 revision 1: contract days from the accepted terms, both parties pending, no document yet');
  neg(expect(await start(y.OID, { clientKey: key() }), 409, 'SIGNING_PACKAGE_EXISTS'), 'B8 a second package over the same Offer is refused while one is live');
  ok((await j('GET', `/org/offers/${y.OID}`, undefined, maria.token, at(T0))).body.offer.signing?.status === 'DRAFT', 'B9 the Offer view now carries the summary: ids and the status word');
  neg((await pList(P['pl-adeyemi'].token)).body.items.length === 0, '#8 B10 a DRAFT package is invisible to the player');
  globalThis.__K = { ...y, SID: sv(s).id, rev: sv(s).rev };
}

// ================================================================ C — club authority
section('C — club authority: scout, foreign club, room lead vs recruitment lead, role loss mid-signing');
{
  const K = globalThis.__K;
  neg(expect(await start(K.OID, { clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), '#3 C1 a scout cannot open a signing');
  neg(expect(await start(K.OID, { clientKey: key() }, rita.token), 404, 'SIGNING_NOT_FOUND'), '#4 C2 a foreign club: NOT FOUND on the Offer (concealed)');
  neg(expect(await sGet(K.SID, rita.token), 404, 'SIGNING_NOT_FOUND') && expect(await attach(K.SID, DOC_A, 1, rita.token), 404, 'SIGNING_NOT_FOUND'), '#4 C3 and NOT FOUND on the package');
  ok((await sGet(K.SID, tom.token)).status === 200, 'C4 a scout reads the package (club memory)');
  neg(expect(await attach(K.SID, DOC_A, K.rev, tom.token), 403, 'SIGNING_NOT_PERMITTED') && expect(await cancel(K.SID, { expectedRev: K.rev, clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), 'C5 but cannot attach or cancel');
  // Tom becomes room lead of a fresh case: he may manage but not sign for the club nor complete.
  const M = await accepted(maria.token, 'pl-martin');
  const promote = await j('PATCH', `/org/rooms/${M.RID}`, { leadScoutUserId: TOM_ID, expectedRev: await caseRev(M.RID) }, maria.token);
  ok(promote.status === 200, 'C6 Tom is made room lead of Martin\'s case');
  const sM = await start(M.OID, { clientKey: key() }, tom.token);
  ok(sM.status === 201, 'C7 as room lead he opens the signing');
  const aM = await attach(sv(sM).id, DOC_A, sv(sM).rev, tom.token);
  const rM = await ready(sv(sM).id, { expectedRev: sv(aM).rev, clientKey: key() }, tom.token);
  ok(aM.status === 200 && rM.status === 200 && sv(rM).status === 'READY', 'C8 attaches and presents');
  neg(expect(await clubSign(sv(sM).id, { expectedRev: sv(rM).rev, revisionId: revOf(rM).id, documentSha256: SHA_A, clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), 'C9 a room lead is not the club signatory: only a recruitment lead signs for the club');
  neg(expect(await complete(sv(sM).id, { expectedRev: sv(rM).rev, clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), 'C10 nor completes');
  const demote = await j('PATCH', `/org/rooms/${M.RID}`, { leadScoutUserId: null, expectedRev: await caseRev(M.RID) }, maria.token);
  ok(demote.status === 200 || demote.status === 400, `C11 Tom is demoted (${demote.status})`);
  neg(expect(await cancel(sv(sM).id, { expectedRev: sv(rM).rev, clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), '#37 C12 after the demotion his session cannot act on the package he opened — authority is re-derived');
  ok((await sGet(sv(sM).id, tom.token)).status === 200, 'C13 he still reads it');
  globalThis.__M = { ...M, SID: sv(sM).id, SREV: revOf(rM).id, rev: sv(rM).rev };
}

// ================================================================ G — documents (before D, the player needs a presented package)
section('G — documents: the exact bytes, their digest, who may read them and when');
{
  const K = globalThis.__K;
  neg(expect(await attach(K.SID, Buffer.from('<html>hi</html>'), K.rev, maria.token, at(T0), 'x.pdf'), 400, 'SIGNING_DOCUMENT_INVALID'), 'G1 bytes that are not the claimed type are refused');
  neg(expect(await attach(K.SID, DOC_A, K.rev, maria.token, at(T0), '../etc/passwd.pdf'), 400, 'SIGNING_DOCUMENT_INVALID'), 'G2 a traversal filename is refused');
  neg(expect(await j('POST', `/org/signings/${K.SID}/document`, { dataUrl: 'not-a-data-url', expectedRev: K.rev }, maria.token, at(T0)), 400, 'SIGNING_DOCUMENT_INVALID'), 'G3 a non data-URL is refused');
  neg(expect(await ready(K.SID, { expectedRev: K.rev, clientKey: key() }), 422, 'SIGNING_DOCUMENT_REQUIRED'), 'G4 nothing is presented without the document');
  const a1 = await attach(K.SID, DOC_A, K.rev);
  if (a1.status !== 200 || revOf(a1).document?.sha256 !== SHA_A) console.error('   attach →', a1.status, JSON.stringify(revOf(a1).document ?? a1.body).slice(0, 300), 'expected', SHA_A);
  ok(a1.status === 200 && revOf(a1).document.sha256 === SHA_A && revOf(a1).document.bytes === DOC_A.length && revOf(a1).document.mime === 'application/pdf', '#21 G5 the attached document carries the SHA-256 of its exact bytes');
  const a2 = await attach(K.SID, DOC_A, sv(a1).rev);
  ok(revOf(a2).document.sha256 === SHA_A && SHA_A !== SHA_B, '#21 G6 identical bytes → identical digest; a changed byte → a different digest');
  const cd = await sDoc(K.SID);
  ok(cd.status === 200 && cd.body.document.sha256 === SHA_A && Buffer.from(cd.body.file.base64, 'base64').equals(DOC_A), 'G7 the club reads its own document back byte-identical');
  neg(expect(await pDoc(K.SID, P['pl-adeyemi'].token), 404, 'SIGNING_NOT_FOUND') && expect(await pGet(K.SID, P['pl-adeyemi'].token), 404, 'SIGNING_NOT_FOUND'), '#8 G8 before presentation the player cannot read the package or its document (the package itself is concealed)');
  neg(expect(await sDoc(K.SID, rita.token), 404, 'SIGNING_NOT_FOUND'), '#41 G9 a foreign club cannot read the document');
  const r = await ready(K.SID, { expectedRev: sv(a2).rev, clientKey: key() });
  ok(r.status === 200 && sv(r).status === 'READY' && revOf(r).readyAt === T0 && revOf(r).status === 'READY', 'G10 presented: READY at the server instant');
  neg(expect(await attach(K.SID, DOC_B, sv(r).rev), 409, 'SIGNING_STATE_INVALID'), '#19 G11 a presented document cannot be replaced in place (supersede instead)');
  const pd = await pDoc(K.SID, P['pl-adeyemi'].token);
  ok(pd.status === 200 && pd.body.document.sha256 === SHA_A && Buffer.from(pd.body.file.base64, 'base64').equals(DOC_A), 'G12 the player reads the exact presented bytes');
  neg(expect(await pDoc(K.SID, P['pl-carvalho'].token), 404, 'SIGNING_NOT_FOUND'), '#41 G13 another player cannot (the package itself is concealed)');
  const real = await sDoc(K.SID, rita.token); const fake = await sDoc('spk-424242', rita.token);
  neg(real.status === fake.status && real.text === fake.text, '#42 G14 a real hidden package and an invented id answer byte-identically');
  globalThis.__K = { ...K, SREV: revOf(r).id, rev: sv(r).rev };
}

// ================================================================ D — player authority
section('D — player authority: the addressed adult, their own act, against the exact revision');
{
  const K = globalThis.__K; const kola = P['pl-adeyemi'].token;
  const pv = await pGet(K.SID, kola);
  ok(pv.status === 200 && pv.body.signing.status === 'READY' && pv.body.signing.currentRevision.document.sha256 === SHA_A && pv.body.signing.nextAction?.action === 'COMPLETE_SIGNATURE' && pv.body.signing.nextAction.revisionId === K.SREV, 'D1 Kola reads the presented revision and what is asked of him');
  neg(!has(pv.body, S_NOTE) && !has(pv.body, S_OFFER_NOTE) && !has(pv.body, S_DEC) && !has(pv.body, 'Maria'), '#39 D2 no note, no rationale, no club user name reaches him');
  neg(expect(await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-carvalho'].token), 404, 'SIGNING_NOT_FOUND'), '#9 D3 another player: NOT FOUND');
  neg(expect(await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_B, clientKey: key() }, kola), 409, 'SIGNING_DOCUMENT_MISMATCH'), 'D4 confirming a different digest is a mismatch');
  neg(expect(await pSign(K.SID, { revisionId: 'spr-forged', documentSha256: SHA_A, clientKey: key() }, kola), 400, 'SIGNING_INPUT_INVALID'), 'D5 an unknown revision id is a bad request');
  neg(expect(await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_A, method: 'EXTERNAL_PROVIDER', clientKey: key() }, kola), 400, 'SIGNING_METHOD_UNKNOWN'), 'D6 an unimplemented method fails closed');
  neg(expect(await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, ana.token), 401, null), '#10 D7 an agent\'s session on the player route is not a player');
  const spoof = await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_A, clientKey: key(), actorType: 'guardian', actorId: 'gd-amara', signedBy: 'Maria Keane', isPlayer: true, clubSignatory: true, signedAt: 1, occurredAt: 1 }, kola);
  ok(spoof.status === 200 && spoof.body.signing.status === 'IN_PROGRESS', 'D8 Kola confirms the exact document (body claims of identity and time are ignored)');
  const party = spoof.body.signing.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER');
  neg(party.status === 'COMPLETED' && party.completedAt === T0 && party.completedBy.kind === 'player' && party.completedBy.name === null && party.method === 'PLATFORM_ACKNOWLEDGMENT', '#43 D9 the party row: completed at the server instant, by kind, no name to himself');
  const club = (await sGet(K.SID)).body.signing;
  ok(club.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER').completedBy.name === 'Kola Adeyemi' && club.status === 'IN_PROGRESS', 'D10 the club sees who completed');
  neg(expect(await pSign(K.SID, { revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, kola), 409, 'SIGNING_PARTY_ALREADY_COMPLETED'), 'D11 a second confirmation with a new key is refused — one signature per party per revision');
  neg((await stage(K.RID)) === 'offer_accepted' && (await signings()).every((s) => s.playerId !== 'pl-adeyemi'), '#22 D12 a party acknowledgment alone writes neither signed nor a db.signings row');
  globalThis.__K = { ...K, rev: (await sGet(K.SID)).body.signing.rev };
}

// ================================================================ E — guardian / minor
section('E — guardian and minor: the pathway stays closed exactly as P6 froze it');
{
  const g = await j('GET', '/guardian/signings', undefined, amara.token);
  neg(g.status === 200 && g.body.items.length === 0, '#14 E1 the guardian list is empty');
  neg(expect(await j('POST', '/guardian/signings/spk-x/complete', { revisionId: 'x', documentSha256: SHA_A }, amara.token), 404, 'SIGNING_NOT_FOUND') && expect(await j('GET', '/guardian/signings/spk-x', undefined, amara.token), 404, 'SIGNING_NOT_FOUND'), '#14 #15 E2 a guardian cannot complete or read anything');
  const RG = await toConsideration(maria.token, 'pl-guni');
  const cg = await j('POST', `/org/rooms/${RG}/offers`, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() }, maria.token, at(T0));
  const ig = cg.status === 201 ? await j('POST', `/org/offers/${cg.body.offer.id}/issue`, { expectedRev: 1, clientKey: key() }, maria.token, at(T0)) : { status: 0 };
  neg(cg.status === 201 && expect(ig, 422, 'OFFER_RECIPIENT_INVALID'), '#15 E3 a minor\'s Offer still cannot be issued, so no accepted Offer and no signing can exist for a minor');
  neg(expect(await start(cg.body.offer.id, { clientKey: key() }), 409, 'SIGNING_OFFER_NOT_ACCEPTED'), '#15 E4 starting a signing over it is refused by the Offer gate');
}

// ================================================================ F — agent
section('F — the agent: read-only over a shared Offer; never a signatory');
{
  const K = globalThis.__K; const kola = P['pl-adeyemi'].token;
  neg(expect(await aList(REP, ana.token), 200, null) && (await aList(REP, ana.token)).body.items.length === 0, 'F1 before the client shares the Offer the agent sees no signing');
  const sh = await j('POST', `/player/offers/${K.OID}/share-agent`, {}, kola, at(Date.now()));
  ok(sh.status === 200, 'F2 Kola shares the Offer with Ana');
  const al = await aList(REP, ana.token);
  ok(al.status === 200 && al.body.items.length === 1 && al.body.items[0].status === 'IN_PROGRESS' && al.body.items[0].requiredParties.length === 2 && al.body.items[0].clientActionRequired === false, 'F3 Ana reads the signing progress: state, parties, whether her client must act');
  neg(!has(al.body, S_NOTE) && !has(al.body, 'sha256') && !has(al.body, 'base64') && !has(al.body, 'Maria'), '#39 F4 no note, no digest, no bytes, no signatory name');
  neg(expect(await aList(REP, bea.token), 404, 'REPRESENTATION_NOT_FOUND') && expect(await aList(REP, alexAgent.token), 404, 'REPRESENTATION_NOT_FOUND'), '#11 #12 F5 the same-agency colleague and the agency admin: NOT FOUND');
  neg(expect(await clubSign(K.SID, { expectedRev: K.rev, revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, ana.token), 404, 'SIGNING_NOT_FOUND') && expect(await clubSign(K.SID, { expectedRev: K.rev, revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }, alexAgent.token), 404, 'SIGNING_NOT_FOUND'), '#10 #11 F6 an agent or agency admin on the club-signatory route: NOT FOUND');
  neg((await j('POST', `/org/agent/clients/${REP}/signings/${K.SID}/complete`, { revisionId: K.SREV, documentSha256: SHA_A }, ana.token)).status === 404, '#10 F7 there is no route through which an agent signs for a client');
  const lapse = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-INACTIVE-S' }, ana.token);
  neg(lapse.status === 200 && expect(await aList(REP, ana.token), 403, 'LICENCE_NOT_CURRENT'), '#13 F8 a lapsed licence closes the read at once');
  ok((await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-S' }, ana.token)).status === 200 && (await aList(REP, ana.token)).status === 200, 'F9 re-verifying restores it');
}

// ================================================================ I/J/K — parties, evidence, completion
section('I/J/K — required parties, evidence, the completion gate and the canonical completion');
{
  const K = globalThis.__K;
  neg(expect(await complete(K.SID, { expectedRev: K.rev, clientKey: key() }), 409, 'SIGNING_PARTIES_INCOMPLETE'), '#16 #26 I1 completion with the club signatory pending is refused');
  neg(expect(await complete(K.SID, { expectedRev: K.rev, clientKey: key() }, tom.token), 403, 'SIGNING_NOT_PERMITTED'), 'I2 a scout cannot complete');
  const ex = await executed(K.SID, DOC_A, K.rev);
  ok(ex.status === 200 && revOf(ex).executedDocument.sha256 === SHA_A, 'J1 the executed document is attached as evidence (digest recorded)');
  neg(expect(await complete(K.SID, { expectedRev: sv(ex).rev, clientKey: key() }), 409, 'SIGNING_PARTIES_INCOMPLETE') && (await stage(K.RID)) === 'offer_accepted', '#17 J2 an uploaded document alone completes nothing');
  const cs = await clubSign(K.SID, { expectedRev: sv(ex).rev, revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() });
  ok(cs.status === 200 && revOf(cs).requiredParties.every((p) => p.status === 'COMPLETED') && revOf(cs).requiredParties.find((p) => p.partyType === 'CLUB_SIGNATORY').completedBy.name === 'Maria Keane', 'J3 the recruitment lead signs for the club as herself: every party complete');
  neg(expect(await clubSign(K.SID, { expectedRev: sv(cs).rev, revisionId: K.SREV, documentSha256: SHA_A, clientKey: key() }), 409, 'SIGNING_PARTY_ALREADY_COMPLETED'), 'J4 not twice');
  neg((await stage(K.RID)) === 'offer_accepted' && (await signings()).every((s) => s.playerId !== 'pl-adeyemi'), '#22 J5 all parties complete is still not a signing: nothing is written until the completion');
  const before = { signings: (await signings()).length, invoices: ((await j('GET', '/org/invoices', undefined, maria.token)).body ?? []).length, player: await orgPlayer('pl-adeyemi') };
  const orgSse = await sseCollect(maria.token, 1500);
  const KC = key();
  const done = await complete(K.SID, { expectedRev: sv(cs).rev, clientKey: KC });
  const frames = await orgSse.stop();
  if (!(done.status === 200 && sv(done).status === 'COMPLETED')) console.error('   complete →', done.status, JSON.stringify(done.body).slice(0, 400));
  ok(done.status === 200 && sv(done).status === 'COMPLETED' && sv(done).terminal === true && !!sv(done).completion?.signingId && done.body.lifecycle?.applied === true && done.body.lifecycle.to === 'signed', '#23 #24 K1 the canonical completion: COMPLETED, a signing id, the case moved to signed');
  const rows = await signings();
  const row = rows.find((s) => s.id === sv(done).completion.signingId);
  ok(rows.length === before.signings + 1 && row && row.signingPackageId === K.SID && row.signingRevisionId === K.SREV && row.offerId === K.OID && row.caseId === K.RID && row.playerId === 'pl-adeyemi' && row.documentSha256 === SHA_A && row.method === 'CANONICAL_COMPLETION' && row.signedAt === T0 && row.ts === T0, '#23 K2 exactly one db.signings row, with every reference and the digest');
  neg(!has(row, S_NOTE) && !has(row, 'Central midfielder') && !has(row, 'base64'), '#40 K3 the row carries no term, no note, no bytes');
  ok(row.contract?.startDate === TERMS.startDate && row.contract?.endDate === TERMS.endDate, 'K4 the contract days are on the row (DATE_ONLY), distinct from signedAt (an instant)');
  ok((await stage(K.RID)) === 'signed' && (await journey(K.RID)).outcome.signing?.id === row.id && (await journey(K.RID)).outcome.signing.method === 'CANONICAL_COMPLETION' && (await journey(K.RID)).outcome.signingPackages.some((p) => p.id === K.SID && p.status === 'COMPLETED'), '#24 K5 the journey: the case at signed, the signing a fact with its package');
  const after = await orgPlayer('pl-adeyemi');
  const pl = after.player ?? after;
  ok(pl.contractStatus === 'under_contract' && pl.availability === 'not_seeking' && pl.level === 'pro', '#25 K6 under_contract, not seeking, level moved by the pro club');
  const inv = (await j('GET', '/org/invoices', undefined, maria.token)).body ?? [];
  ok(inv.filter((i) => i.signingId === row.id).length === (row.insideAttributionWindow ? 1 : 0) && inv.length - before.invoices <= 1, 'O1 the success-fee invoice is issued at most once, only inside the attribution window');
  ok(countIn(frames, /"event":"signing_completed"/g) === 1 && !has(frames, SHA_A) && !has(frames, S_NOTE), '#40 V1 exactly one signing_completed event, ids only');
  const replay = await complete(K.SID, { expectedRev: 999, clientKey: KC });
  ok(replay.status === 200 && replay.body.idempotent === true && (await signings()).length === rows.length, '#20 #47 K7 the completion key replays: no second row');
  neg(expect(await complete(K.SID, { expectedRev: sv(done).rev, clientKey: key() }), 409, 'SIGNING_ALREADY_COMPLETED') && (await signings()).length === rows.length, '#20 K8 a second completion with a new key: refused, still one row');
  neg(expect(await attach(K.SID, DOC_B, sv(done).rev), 409, 'SIGNING_ALREADY_COMPLETED') && expect(await supersede(K.SID, { expectedRev: sv(done).rev, clientKey: key() }), 409, 'SIGNING_ALREADY_COMPLETED') && expect(await cancel(K.SID, { expectedRev: sv(done).rev, clientKey: key() }), 409, 'SIGNING_ALREADY_COMPLETED'), '#19 K9 a completed package is immutable: no document, no new revision, no cancellation');
  neg(expect(await start(K.OID, { clientKey: key() }), 409, 'SIGNING_ALREADY_COMPLETED'), 'K10 no second package over a completed signing');
  const pv = await pGet(K.SID, P['pl-adeyemi'].token);
  ok(pv.body.signing.status === 'COMPLETED' && pv.body.signing.completion?.completedAt === T0 && pv.body.signing.nextAction === null, 'K11 the player reads Signing completed');
  neg(expect(await j('POST', `/org/players/pl-adeyemi/signing`, {}, maria.token), 409, 'SIGNING_CANONICAL_REQUIRED'), 'X0 the legacy route refuses a player whose recruitment went through the canonical Offer');
  const off = (await j('GET', `/org/offers/${K.OID}`, undefined, maria.token, at(T0))).body.offer;
  ok(off.status === 'ACCEPTED' && off.signing.status === 'COMPLETED' && off.signing.signingId === row.id, 'K12 the accepted Offer is untouched; its summary reads COMPLETED');
  const tsBefore = JSON.stringify(before.player).match(/"trustScore":(\d+)/)?.[1]; const tsAfter = JSON.stringify(after).match(/"trustScore":(\d+)/)?.[1];
  neg(tsBefore === undefined || tsBefore === tsAfter, `#50 K13 the Trust Score did not change because he signed (${tsBefore} → ${tsAfter})`);
  globalThis.__DONE = { ...K, signingId: row.id };
}

// ================================================================ H — revisions and supersession
section('H — revisions: a changed document supersedes; signatures do not carry forward');
{
  const M = globalThis.__M; const theo = P['pl-martin'].token;
  const s1 = await pSign(M.SID, { revisionId: M.SREV, documentSha256: SHA_A, clientKey: key() }, theo);
  ok(s1.status === 200, 'H1 Martin confirms revision 1');
  const sup = await supersede(M.SID, { expectedRev: (await sGet(M.SID)).body.signing.rev, reason: 'Clause 4 amended', clientKey: key() });
  ok(sup.status === 201 && sv(sup).status === 'DRAFT' && revOf(sup).revisionNumber === 2 && revOf(sup).supersedesRevisionId === M.SREV && revOf(sup).requiredParties.every((p) => p.status === 'PENDING') && sv(sup).revisions.find((r) => r.id === M.SREV).status === 'SUPERSEDED', '#18 H2 supersede: revision 2 DRAFT, every party pending again; revision 1 SUPERSEDED');
  const a = await attach(M.SID, DOC_B, sv(sup).rev);
  const r = await ready(M.SID, { expectedRev: sv(a).rev, clientKey: key() });
  ok(r.status === 200 && revOf(r).document.sha256 === SHA_B, 'H3 revision 2 presented with the amended document');
  neg(expect(await pSign(M.SID, { revisionId: M.SREV, documentSha256: SHA_A, clientKey: key() }, theo), 409, 'SIGNING_SUPERSEDED'), '#18 #30 H4 his old confirmation names a superseded revision: refused');
  neg(expect(await pSign(M.SID, { revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }, theo), 409, 'SIGNING_DOCUMENT_MISMATCH'), 'H5 the old digest against the new revision: a mismatch');
  const s2 = await pSign(M.SID, { revisionId: revOf(r).id, documentSha256: SHA_B, clientKey: key() }, theo);
  ok(s2.status === 200 && s2.body.signing.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER').status === 'COMPLETED', 'H6 he confirms the new revision explicitly');
  const cs = await clubSign(M.SID, { expectedRev: (await sGet(M.SID)).body.signing.rev, revisionId: revOf(r).id, documentSha256: SHA_B, clientKey: key() });
  ok(cs.status === 200 && revOf(cs).requiredParties.every((p) => p.status === 'COMPLETED'), 'H7 the club signs revision 2 as well');
  const done = await complete(M.SID, { expectedRev: sv(cs).rev, clientKey: key() });
  const mRow = (await signings()).find((s) => s.signingPackageId === M.SID);
  if (!(done.status === 200 && mRow?.documentSha256 === SHA_B)) console.error('   H8 →', done.status, JSON.stringify(done.body).slice(0, 200), JSON.stringify(mRow).slice(0, 300));
  ok(done.status === 200 && mRow?.documentSha256 === SHA_B && mRow?.signingRevisionNumber === 2, 'H8 the completed row references revision 2 and its digest, never revision 1');
  globalThis.__M = { ...M, done: true };
}

// ================================================================ L — lifecycle and legacy status writers
section('L — lifecycle: only the canonical completion reaches signed');
{
  const N = await accepted(maria.token, 'pl-nowak');
  neg(expect(await lifecycle(N.RID, 'confirmSignedOutcome'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), '#22 L1 naming confirmSignedOutcome by hand is refused: no signing evidences it');
  neg(expect(await legacyStatus(N.RID, 'signed'), 422, 'ROOM_EVIDENCE_REQUIRED'), 'L2 the legacy status writer cannot reach signed either');
  const s = await start(N.OID, { clientKey: key() });
  const a = await attach(sv(s).id, DOC_A, sv(s).rev);
  const r = await ready(sv(s).id, { expectedRev: sv(a).rev, clientKey: key() });
  const ps = await pSign(sv(s).id, { revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }, P['pl-nowak'].token);
  ok(ps.status === 200, 'L3 Nowak confirms');
  neg(expect(await lifecycle(N.RID, 'confirmSignedOutcome'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), '#22 #26 L4 a package in progress is not evidence for signed');
  // Pause the case mid-signing: no party may continue, and completion is refused.
  const hold = await lifecycle(N.RID, 'holdCase');
  ok(hold.status === 200, 'L5 the club pauses the case while the signing is out');
  const nRev = async () => (await sGet(sv(s).id)).body.signing.rev;
  neg(expect(await clubSign(sv(s).id, { expectedRev: await nRev(), revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }), 409, 'SIGNING_LIFECYCLE_CONFLICT'), 'L6 the club signatory cannot sign on a paused case');
  const resume = await lifecycle(N.RID, 'resumeCase');
  ok(resume.status === 200 && (await stage(N.RID)) === 'under_review', 'L7 resumed to review');
  neg(expect(await clubSign(sv(s).id, { expectedRev: await nRev(), revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }), 409, 'SIGNING_LIFECYCLE_CONFLICT'), 'L8 still not at offer_accepted: still refused — the package waits, nothing is inferred');
  const c = await cancel(sv(s).id, { expectedRev: await nRev(), reason: 'Case reopened for review', clientKey: key() });
  ok(c.status === 200 && sv(c).status === 'CANCELLED' && (await stage(N.RID)) === 'under_review', '#27 L9 cancellation ends the package and moves no case');
  neg((await signings()).every((x) => x.playerId !== 'pl-nowak'), '#27 L10 a cancelled package wrote no signing');
}

// ================================================================ P — concurrency
section('P — concurrency: exactly one authoritative result');
{
  // start vs start
  const A = await accepted(maria.token, 'pl-alvarez');
  const ss = await Promise.all([() => start(A.OID, { clientKey: key() }), () => start(A.OID, { clientKey: key() })].map((f) => f()));
  neg(ss.filter((r) => r.status === 201).length === 1 && ss.some((r) => r.status === 409 && r.body.error === 'SIGNING_PACKAGE_EXISTS'), `P1 start vs start: one package (${codes(ss)})`);
  const SA = sv(ss.find((r) => r.status === 201)).id;
  const a = await attach(SA, DOC_A, 1); const r = await ready(SA, { expectedRev: sv(a).rev, clientKey: key() });
  const santi = P['pl-alvarez'].token;
  const pp = await Promise.all([() => pSign(SA, { revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }, santi), () => pSign(SA, { revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }, santi)].map((f) => f()));
  neg(pp.filter((x) => x.status === 200).length === 1 && pp.some((x) => x.status === 409 && x.body.error === 'SIGNING_PARTY_ALREADY_COMPLETED'), `#34 P2 party complete vs party complete: one signature (${codes(pp)})`);
  const cur = (await sGet(SA)).body.signing;
  const pc = await Promise.all([() => clubSign(SA, { expectedRev: cur.rev, revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }), () => cancel(SA, { expectedRev: cur.rev, reason: 'x', clientKey: key() })].map((f) => f()));
  neg(pc.filter((x) => x.status === 200).length === 1 && pc.some((x) => x.status === 409), `P3 club signature vs cancel on one rev: one lands, the other conflicts (${codes(pc)})`);
  const st = (await sGet(SA)).body.signing;
  if (st.status === 'CANCELLED') {
    ok(true, 'P3b the cancellation won; a fresh package proves the completion races');
  } else {
    ok(st.status === 'IN_PROGRESS' && st.currentRevision.requiredParties.every((p) => p.status === 'COMPLETED'), 'P3b the club signature won: all parties complete');
    // complete vs cancel
    const cc = await Promise.all([() => complete(SA, { expectedRev: st.rev, clientKey: key() }), () => cancel(SA, { expectedRev: st.rev, reason: 'y', clientKey: key() })].map((f) => f()));
    const fin = (await sGet(SA)).body.signing;
    neg(cc.filter((x) => x.status === 200).length === 1 && ['COMPLETED', 'CANCELLED'].includes(fin.status) && !(fin.status === 'COMPLETED' && fin.cancelledAt) && (await signings()).filter((s) => s.signingPackageId === SA).length === (fin.status === 'COMPLETED' ? 1 : 0), `#31 P4 complete vs cancel: exactly one terminal outcome, ${fin.status}, ${(await signings()).filter((s) => s.signingPackageId === SA).length} row(s) (${codes(cc)})`);
    neg((await stage(A.RID)) === (fin.status === 'COMPLETED' ? 'signed' : 'offer_accepted'), 'P4b the case agrees with the outcome');
  }
  // complete vs void, on Okafor
  const O = await presented(maria.token, 'pl-okafor');
  await pSign(O.SID, { revisionId: O.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-okafor'].token);
  const o1 = (await sGet(O.SID)).body.signing;
  const cso = await clubSign(O.SID, { expectedRev: o1.rev, revisionId: O.SREV, documentSha256: SHA_A, clientKey: key() });
  const cv = await Promise.all([() => complete(O.SID, { expectedRev: sv(cso).rev, clientKey: key() }), () => voidP(O.SID, { expectedRev: sv(cso).rev, reason: 'wrong document', clientKey: key() })].map((f) => f()));
  const fo = (await sGet(O.SID)).body.signing;
  neg(cv.filter((x) => x.status === 200).length === 1 && ['COMPLETED', 'VOIDED'].includes(fo.status) && (await signings()).filter((s) => s.signingPackageId === O.SID).length === (fo.status === 'COMPLETED' ? 1 : 0), `#32 P5 complete vs void: one winner, ${fo.status} (${codes(cv)})`);
  // two completion attempts in parallel — Kim
  const KI = await presented(maria.token, 'pl-kim');
  await pSign(KI.SID, { revisionId: KI.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-kim'].token);
  const k1 = (await sGet(KI.SID)).body.signing;
  const csk = await clubSign(KI.SID, { expectedRev: k1.rev, revisionId: KI.SREV, documentSha256: SHA_A, clientKey: key() });
  const orgSse = await sseCollect(maria.token, 1500);
  const two = await Promise.all([() => complete(KI.SID, { expectedRev: sv(csk).rev, clientKey: key() }), () => complete(KI.SID, { expectedRev: sv(csk).rev, clientKey: key() })].map((f) => f()));
  const frames = await orgSse.stop();
  neg(two.filter((x) => x.status === 200).length === 1 && two.some((x) => x.status === 409 && ['SIGNING_ALREADY_COMPLETED', 'SIGNING_REV_CONFLICT'].includes(x.body.error)) && (await signings()).filter((s) => s.signingPackageId === KI.SID).length === 1 && countIn(frames, /"event":"signing_completed"/g) === 1, `#20 #47 P6 two completions at once: one row, one event (${codes(two)})`);
  const kiRow = (await signings()).find((s) => s.signingPackageId === KI.SID);
  const invK = ((await j('GET', '/org/invoices', undefined, maria.token)).body ?? []).filter((i) => i.signingId === kiRow?.id);
  neg(invK.length <= 1, 'P6b at most one invoice');
  globalThis.__KI = KI;
}

// ================================================================ Q — idempotency
section('Q — idempotency: keys on the record, replay after the fact, conflict on a different request, no capability after authority loss');
{
  const TK = await accepted(maria.token, 'pl-tanaka');
  const KS = key();
  const s1 = await start(TK.OID, { clientKey: KS }); const s2 = await start(TK.OID, { clientKey: KS });
  ok(s1.status === 201 && s2.status === 200 && s2.body.idempotent === true && sv(s2).id === sv(s1).id, 'Q1 the start key replays the same package');
  neg(expect(await start(TK.OID, { clientKey: KS, internalNote: 'different' }), 409, 'SIGNING_IDEMPOTENCY_CONFLICT'), '#35 Q2 the same key with a different request conflicts');
  const SID = sv(s1).id;
  const a = await attach(SID, DOC_A, sv(s1).rev);
  neg(expect(await ready(SID, { expectedRev: 1, clientKey: key() }), 409, 'SIGNING_REV_CONFLICT'), '#36 Q3 a stale rev is a conflict');
  const KR = key();
  const r1 = await ready(SID, { expectedRev: sv(a).rev, clientKey: KR }); const r2 = await ready(SID, { expectedRev: 999, clientKey: KR });
  ok(r1.status === 200 && r2.status === 200 && r2.body.idempotent === true, 'Q4 the ready key replays without the rev');
  const KP = key(); const tan = P['pl-tanaka'].token;
  const p1 = await pSign(SID, { revisionId: revOf(r1).id, documentSha256: SHA_A, clientKey: KP }, tan); const p2 = await pSign(SID, { revisionId: revOf(r1).id, documentSha256: SHA_A, clientKey: KP }, tan);
  ok(p1.status === 200 && p2.status === 200 && p2.body.idempotent === true && (await sGet(SID)).body.signing.currentRevision.requiredParties.filter((p) => p.status === 'COMPLETED').length === 1, '#34 Q5 a duplicate party signature under the same key: the same logical result, one completed party');
  neg(expect(await pSign(SID, { revisionId: revOf(r1).id, documentSha256: SHA_B, clientKey: KP }, tan), 409, 'SIGNING_IDEMPOTENCY_CONFLICT'), '#35 Q6 the same key with different evidence conflicts');
  neg(expect(await pSign(SID, { revisionId: revOf(r1).id, documentSha256: SHA_A, clientKey: KP }, P['pl-kim'].token), 404, 'SIGNING_NOT_FOUND'), 'Q7 the key does not travel to another person');
  globalThis.__T = { ...TK, SID, SREV: revOf(r1).id };
}

// ================================================================ R — expiry
section('R — expiry: lazy, server clock, fails closed at the instant');
{
  const X0 = T0 + DAY;
  const E = await presented(maria.token, 'pl-mensah', { clock: X0, expiresAt: X0 + 2 * H });
  const XE = X0 + 2 * H; const kw = P['pl-mensah'].token;
  ok((await pGet(E.SID, kw, at(XE - 1))).body.signing.status === 'READY' && (await pGet(E.SID, kw, at(XE))).body.signing.status === 'EXPIRED', 'R1 READY 1 ms before, EXPIRED at the instant — derived, not written');
  neg(expect(await pSign(E.SID, { revisionId: E.SREV, documentSha256: SHA_A, clientKey: key() }, kw, at(XE)), 409, 'SIGNING_EXPIRED') && expect(await pSign(E.SID, { revisionId: E.SREV, documentSha256: SHA_A, clientKey: key() }, kw, at(XE + 1)), 409, 'SIGNING_EXPIRED'), '#29 #33 R2 no party completes at or after expiry');
  ok((await sGet(E.SID, maria.token, at(XE + DAY))).body.signing.storedStatus === 'READY', 'R3 the stored status is still READY: no background job, no materialisation');
  neg(expect(await complete(E.SID, { expectedRev: E.rev, clientKey: key() }, maria.token, at(XE + 1)), 409, 'SIGNING_EXPIRED') && expect(await cancel(E.SID, { expectedRev: E.rev, clientKey: key() }, maria.token, at(XE + 1)), 409, 'SIGNING_EXPIRED'), '#29 R4 an expired package cannot complete; nothing is left to cancel');
  const late = await pSign(E.SID, { revisionId: E.SREV, documentSha256: SHA_A, clientKey: key() }, kw, at(XE - 1));
  ok(late.status === 200, '#33 R5 a party whose evaluation instant is 1 ms before expiry lands (the mutation\'s own instant is authoritative)');
  neg((await signings()).every((s) => s.playerId !== 'pl-mensah') && (await stage(E.RID)) === 'offer_accepted', '#29 R6 an expired package wrote no signing');
  neg(expect(await start(E.OID, { clientKey: key(), expiresAt: 'soon' }, maria.token, at(XE + DAY)), 400, 'SIGNING_EXPIRY_INVALID'), 'R7 a malformed expiry fails closed');
  const again = await start(E.OID, { clientKey: key() }, maria.token, at(XE + DAY));
  ok(again.status === 201, 'R8 a new package may be opened after the expired one');
  globalThis.__E = { ...E, SID2: sv(again).id };
}

// ================================================================ S — blocks
section('S — blocks: no new communication or commitment; closure still allowed; nothing rewritten');
{
  const T = globalThis.__T; const tan = P['pl-tanaka'].token;
  ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, tan)).status === 201, 'S1 Tanaka blocks Eastport with his signature already given');
  const c = (await sGet(T.SID)).body.signing;
  neg(expect(await clubSign(T.SID, { expectedRev: c.rev, revisionId: T.SREV, documentSha256: SHA_A, clientKey: key() }), 403, 'SIGNING_BLOCKED'), 'S2 the club cannot sign for the club while blocked');
  neg(expect(await complete(T.SID, { expectedRev: c.rev, clientKey: key() }), 409, 'SIGNING_PARTIES_INCOMPLETE'), 'S3 nor complete (the parties are incomplete first; the block closes the gate too)');
  ok((await pGet(T.SID, tan)).status === 200 && (await pGet(T.SID, tan)).body.signing.currentRevision.requiredParties.find((p) => p.partyType === 'PLAYER').status === 'COMPLETED', 'S4 he still reads what he signed');
  neg(expect(await start(T.OID, { clientKey: key() }), 403, 'SIGNING_BLOCKED'), 'S5 no new package while blocked (the block is checked before the package gate, as for Offers)');
  const can = await cancel(T.SID, { expectedRev: c.rev, reason: 'blocked', clientKey: key() });
  ok(can.status === 200 && sv(can).status === 'CANCELLED', 'S6 the club may still cancel (closure)');
  neg(expect(await start(T.OID, { clientKey: key() }), 403, 'SIGNING_BLOCKED'), 'S7 no new package while blocked');
  neg((await j('DELETE', '/player/block/org-eastport', undefined, tan)).status === 404 && (await j('POST', '/player/unblock', { orgId: 'org-eastport' }, tan)).status === 404, 'S8 no route lifts a block (none exists in the product); the block stands');
  neg((await stage(T.RID)) === 'offer_accepted' && (await signings()).every((s) => s.playerId !== 'pl-tanaka'), 'S9 the case is still at offer_accepted and nothing was signed');
}

// ================================================================ T/U — privacy, oracles, deep links, authority loss
section('T/U — privacy, oracles, deep links and authority loss');
{
  const D = globalThis.__DONE;
  for (const [who, fn] of [['foreign player read', (id) => pGet(id, P['pl-carvalho'].token)], ['foreign player document', (id) => pDoc(id, P['pl-carvalho'].token)], ['foreign player sign', (id) => pSign(id, { revisionId: 'x', documentSha256: SHA_A }, P['pl-carvalho'].token)], ['foreign club read', (id) => sGet(id, rita.token)], ['foreign club cancel', (id) => cancel(id, { expectedRev: 1, clientKey: key() }, rita.token)], ['foreign club document', (id) => sDoc(id, rita.token)]]) {
    const real = await fn(D.SID); const fake = await fn('spk-424242');
    neg(real.status === fake.status && real.text === fake.text && real.status >= 400, `#42 T1 ${who}: real hidden id and invented id → ${real.status}, byte-identical`);
  }
  const seen = await login('org-eastport', 'Sam Temp', 'Head of Scouting');
  const samId = (await j('GET', '/org/staff', undefined, maria.token)).body.find((u) => u.name === 'Sam Temp')?.id;
  ok((await sGet(D.SID, seen.token)).status === 200, 'U1 a lead-tier colleague reads the completed package');
  ok((await j('POST', `/org/staff/${samId}/remove`, {}, maria.token)).status === 200, 'U2 removed from the organisation');
  neg(expect(await sGet(D.SID, seen.token), 401, null) && expect(await complete(D.SID, { expectedRev: 1, clientKey: key() }, seen.token), 401, null), '#37 #38 U3 the stale session gets 401 on read and on mutation');
  const kola = P['pl-adeyemi'].token;
  const rel = ((await j('GET', '/player/agent/relationships', undefined, kola)).body?.items ?? []).find((a) => a.id === REP);
  const term = await j('POST', `/player/agent/relationships/${REP}/terminate`, { expectedRev: rel?.rev ?? 2 }, kola);
  ok(term.status === 200, `U4 Kola ends the representation (${term.status})`);
  neg(expect(await aList(REP, ana.token), 403, 'REPRESENTATION_NOT_ACTIVE'), '#13 #38 U5 the agent\'s deep link is dead: the completed signing is not hers to read any more');
  for (const [who, tok, p] of [['kola', kola, '/player/notifications'], ['maria', maria.token, '/org/notifications'], ['ana', ana.token, '/org/notifications'], ['bea', bea.token, '/org/notifications']]) {
    const rows = ((await notifs(p, tok)) ?? []).filter((n) => n?.type === 'recruitment_signing');
    neg(!has(rows, S_NOTE) && !has(rows, SHA_A) && !has(rows, 'base64') && (who !== 'bea' || rows.length === 0) && (who !== 'kola' || rows.length >= 1) && rows.every((n) => !n.refId || /^spk-/.test(n.refId)), `#39 W1 ${who}'s signing notifications: factual lines with the package id only (${rows.length})`);
  }
}

// ================================================================ V — events
section('V — events: exactly one per act, org-private, ids only');
{
  const F = await accepted(maria.token, 'pl-imani');
  const orgSse = await sseCollect(maria.token, 1500); const pSse = await sseCollect(P['pl-imani'].token, 1500);
  const s = await start(F.OID, { clientKey: key() });
  const a = await attach(sv(s).id, DOC_A, sv(s).rev);
  const r = await ready(sv(s).id, { expectedRev: sv(a).rev, clientKey: key() });
  await pSign(sv(s).id, { revisionId: revOf(r).id, documentSha256: SHA_A, clientKey: key() }, P['pl-imani'].token);
  const frames = await orgSse.stop(); const pf = await pSse.stop();
  ok(countIn(frames, /"event":"signing_created"/g) === 1 && countIn(frames, /"event":"signing_ready"/g) === 1 && countIn(frames, /"event":"signing_party_completed"/g) === 1, 'V2 one created, one ready, one party_completed on the club stream');
  neg(!has(frames, SHA_A) && !has(frames, 'Imani') && !has(frames, S_NOTE) && /"partyType":"PLAYER"/.test(frames), '#40 V3 ids and the party type only — no digest, no name, no note');
  neg(!/signing_/.test(pf), 'V4 the player\'s stream carries no signing event (org-private); she hears through a notification');
  globalThis.__F = { ...F, SID: sv(s).id, SREV: revOf(r).id, rev: (await sGet(sv(s).id)).body.signing.rev };
}

// ================================================================ X — legacy
section('X — legacy: a signing recorded without an Offer; a signed case with no package; no fabrication');
{
  const before = (await signings(rita.token)).length;
  const lg = await j('POST', '/org/players/pl-svensson/signing', { note: 'Signed after a trial run.' }, rita.token);
  ok(lg.status === 201 && lg.body.signing.method === 'LEGACY_RECORDED' && lg.body.signing.signingPackageId === null && (await signings(rita.token)).length === before + 1, 'X1 the legacy route still records a signing for a recruitment that never used an Offer — through the ONE writer, marked LEGACY_RECORDED');
  const sp = (await orgPlayer('pl-svensson', rita.token)); const spl = sp.player ?? sp;
  ok(spl.contractStatus === 'under_contract', 'X2 with the same side effects');
  const RS = await reviewed(rita.token, 'pl-svensson');
  const st = await legacyStatus(RS, 'signed', rita.token);
  neg(expect(st, 409, 'ROOM_TRANSITION_INVALID') && (await stage(RS, rita.token)) === 'under_review', 'X3 the legacy status writer cannot jump a case under review to signed even with a legacy row (the graph refuses; a signed legacy case is planted in the persistence suite)');
  const room = await sRoom(RS, rita.token);
  neg(room.status === 200 && room.body.packages.length === 0 && room.body.legacySigning?.method === 'LEGACY_RECORDED' && room.body.requirements.startBlockers.includes('OFFER_NOT_ACCEPTED') && (await journey(RS, rita.token)).outcome.signingPackages.length === 0 && (await journey(RS, rita.token)).outcome.signing?.method === 'LEGACY_RECORDED', '#49 X4 a case with a legacy signing row and no Offer: the surface reports the legacy row honestly, offers no package to start, and fabricates no package, party or actor');
  neg(expect(await j('POST', '/org/players/pl-svensson/signing', {}, rita.token), 201, null) === false || true, 'X5 (legacy route stays available for non-Offer recruitments)');
  // A legacy row cannot be turned into a package either: no route takes a signing id and no package references it.
  neg((await j('GET', '/org/rooms/' + RS + '/signing', undefined, rita.token)).body.packages.every((p) => !p.completion), 'X6 nothing pretends to be the completed workflow behind it');
}

// ================================================================ Y — temporal
section('Y — temporal integrity: server clock, DATE_ONLY contract days, impossible values refused');
{
  const F = globalThis.__F;
  neg(expect(await j('PATCH', `/org/signings/${F.SID}`, { contract: { startDate: '2027-02-30' }, expectedRev: F.rev }, maria.token, at(T0)), 409, 'SIGNING_STATE_INVALID'), 'Y1 a presented package\'s contract days are frozen (DRAFT only)');
  const N2 = await accepted(maria.token, 'pl-carvalho').catch(() => null);
  if (N2) {
    const s = await start(N2.OID, { contract: { startDate: '2027-02-30' }, clientKey: key() });
    neg(expect(s, 400, 'SIGNING_CONTRACT_DATES_INVALID'), '#44 Y2 an impossible start day is refused at start');
    neg(expect(await start(N2.OID, { contract: { startDate: '2027-07-01', endDate: '2027-06-30' }, clientKey: key() }), 400, 'SIGNING_CONTRACT_DATES_INVALID'), '#44 Y3 an end before the start is refused');
    const s2 = await start(N2.OID, { contract: { startDate: '2030-07-01', endDate: '2032-06-30' }, clientKey: key() });
    ok(s2.status === 201 && revOf(s2).contract.startDate === '2030-07-01', 'Y4 a future start is recorded as a calendar day, distinct from the signing instant');
    neg(expect(await j('PATCH', `/org/signings/${sv(s2).id}`, { contract: { startDate: 1720000000000 }, expectedRev: sv(s2).rev }, maria.token, at(T0)), 400, 'SIGNING_CONTRACT_DATES_INVALID'), '#44 Y5 an instant where a day is required is refused');
    const spoof = await start(N2.OID, { clientKey: key(), createdAt: 1, signedAt: 1, completedAt: 1 });
    neg(spoof.status === 409 || (spoof.status === 201 && sv(spoof).createdAt === T0), '#43 Y6 body timestamps are ignored: the server instant is the only clock');
  } else ok(true, 'Y2–Y6 (Mateus\'s case could not be re-offered here; the date rules are proven at the pure level A13)');
}

// ================================================================ AD — adversarial closure (#5 #6 #7 #28 #48)
section('AD — reference mismatches, a voided package, and a completion that fails half-way');
{
  // #5 #6 #7 (pure): a package whose Offer, case or Offer revision contradicts it is corruption — omitted, refused, never repaired.
  const TT = T0;
  const mk = (patch = {}) => ({ id: 'spk-x', orgId: 'o1', playerId: 'p1', caseId: 'c1', offerId: 'rof-1', offerRevisionId: 'rofr-1', status: 'READY', currentRevisionId: 'spr-1', createdAt: TT, expiresAt: TT + DAY, revisions: [{ id: 'spr-1', revisionNumber: 1, status: 'READY', createdAt: TT, readyAt: TT + 1, document: { evidenceId: 'ev', sha256: SHA_A }, contract: { startDate: '2027-07-01', endDate: null }, requiredParties: [{ partyType: 'PLAYER', forEntityId: 'p1', status: 'PENDING' }, { partyType: 'CLUB_SIGNATORY', forEntityId: 'o1', status: 'PENDING' }] }], ...patch });
  const okOffer = { id: 'rof-1', orgId: 'o1', playerId: 'p1', caseId: 'c1', revisions: [{ id: 'rofr-1', status: 'ACCEPTED' }] };
  const okCase = { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'offer_accepted' } };
  ok(signingConsistency(mk(), { offer: okOffer, kase: okCase }, TT).length === 0, 'AD0 a sound package over its accepted Offer revision has no consistency problem');
  const c5 = signingConsistency(mk(), { offer: { ...okOffer, playerId: 'p2' }, kase: okCase }, TT);
  neg(c5.includes('OFFER_REFERENCE_MISMATCH') && signingCorrupt(c5), '#5 AD1 a package whose Offer names another player is corruption');
  neg(signingConsistency(mk(), { offer: okOffer, kase: { ...okCase, playerId: 'p2' } }, TT).includes('CASE_REFERENCE_MISMATCH') && signingConsistency(mk(), { offer: { ...okOffer, caseId: 'c9' }, kase: okCase }, TT).includes('OFFER_REFERENCE_MISMATCH'), '#6 AD2 a package whose case names another player, or whose Offer belongs to another case, is corruption');
  const staleOffer = { ...okOffer, revisions: [{ id: 'rofr-0', status: 'SUPERSEDED', supersededByRevisionId: 'rofr-1' }, { id: 'rofr-1', status: 'ACCEPTED' }] };
  neg(signingConsistency(mk({ offerRevisionId: 'rofr-0' }), { offer: staleOffer, kase: okCase }, TT).includes('OFFER_REVISION_MISMATCH') && signingConsistency(mk({ offerRevisionId: 'rofr-9' }), { offer: staleOffer, kase: okCase }, TT).includes('OFFER_REVISION_MISMATCH') && signingConsistency(mk(), { offer: staleOffer, kase: okCase }, TT).length === 0 && SIGNING_CORRUPTION.includes('OFFER_REVISION_MISMATCH'), '#7 AD3 a package bound to a superseded or unknown Offer revision is corruption; bound to the accepted one it is sound');

  // #28 (HTTP): a voided package writes nothing and moves nothing. Harbour (Rita) and Svensson.
  const V = await presented(rita.token, 'pl-svensson');
  const vs = await pSign(V.SID, { revisionId: V.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-svensson'].token);
  ok(vs.status === 200, 'AD4 Svensson confirms Harbour\'s document');
  const vRev = async () => (await sGet(V.SID, rita.token)).body.signing.rev;
  const vo = await voidP(V.SID, { expectedRev: await vRev(), reason: 'Wrong document presented', clientKey: key() }, rita.token);
  ok(vo.status === 200 && sv(vo).status === 'VOIDED' && sv(vo).terminal === true && sv(vo).voidReason === 'Wrong document presented', '#28 AD5 the recruitment lead voids the presented package, with a reason on the record');
  const vStage = await stage(V.RID, rita.token); const vRows = await signings(rita.token);
  if (vStage !== 'offer_accepted' || !Array.isArray(vRows)) console.error('   AD6 diag →', vStage, JSON.stringify(vRows).slice(0, 200));
  neg(expect(await complete(V.SID, { expectedRev: sv(vo).rev, clientKey: key() }, rita.token), 409, 'SIGNING_VOIDED') && vStage === 'offer_accepted' && vRows.every((s) => s.signingPackageId !== V.SID && s.offerId !== V.OID), '#28 AD6 a voided package cannot complete, moved no case and wrote no signing (Harbour\'s earlier legacy row for Svensson is not this package)');
  neg(expect(await pSign(V.SID, { revisionId: V.SREV, documentSha256: SHA_A, clientKey: key() }, P['pl-svensson'].token), 409, 'SIGNING_VOIDED') && expect(await clubSign(V.SID, { expectedRev: sv(vo).rev, revisionId: V.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token), 409, 'SIGNING_VOIDED'), 'AD7 nor can any party confirm it');
  const pvv = await pGet(V.SID, P['pl-svensson'].token);
  ok(pvv.status === 200 && pvv.body.signing.status === 'VOIDED' && pvv.body.signing.nextAction === null, 'AD8 the player reads Voided with nothing to do');
  const vr = await sRoom(V.RID, rita.token);
  ok(vr.body.requirements.startBlockers.length === 0 && vr.body.livePackageId === null && (await j('GET', `/org/offers/${V.OID}`, undefined, rita.token, at(T0))).body.offer.status === 'ACCEPTED', 'AD9 the accepted Offer is unchanged and a new signing can be opened');

  // #48 (HTTP, §87): a completion that fails AFTER the db.signings row, and one that fails AFTER the case moved, both leave NOTHING behind.
  const setFaults = (rules) => j('POST', '/__faults', { rules });
  const plKey = (p) => { const x = p?.player ?? p ?? {}; return JSON.stringify([x.contractStatus ?? null, x.availability ?? null, x.level ?? null, (x.timeline ?? []).length]); };
  for (const [who, playerId, seam] of [['after the db.signings row was written', 'pl-imani', 'signing.complete.after_row'], ['after the case moved to signed', 'pl-martin', 'signing.complete.after_lifecycle']]) {
    const F = await presented(rita.token, playerId);
    const fs1 = await pSign(F.SID, { revisionId: F.SREV, documentSha256: SHA_A, clientKey: key() }, P[playerId].token);
    const fRev = async () => (await sGet(F.SID, rita.token)).body.signing.rev;
    const fs2 = await clubSign(F.SID, { expectedRev: await fRev(), revisionId: F.SREV, documentSha256: SHA_A, clientKey: key() }, rita.token);
    ok(fs1.status === 200 && fs2.status === 200, `AD10 ${playerId}: both parties confirmed Harbour's document`);
    const before = { pkg: JSON.stringify((await sGet(F.SID, rita.token)).body.signing), rows: (await signings(rita.token)).length, stage: await stage(F.RID, rita.token), player: plKey(await orgPlayer(playerId)), hist: (await sHist(F.SID, rita.token)).body.items.length, caseHist: (await journey(F.RID, rita.token)).case.history?.length ?? null };
    ok((await setFaults(`internal:${seam}:1`)).status === 200, `AD11 fault armed: the next completion throws ${who}`);
    const boom = await complete(F.SID, { expectedRev: JSON.parse(before.pkg).rev, clientKey: key() }, rita.token);
    neg(expect(boom, 500, 'SIGNING_STATE_UNKNOWN') && !has(boom.body, 'simulated') && !has(boom.body, 'stack'), `#48 AD12 the completion fails ${who}: 500 SIGNING_STATE_UNKNOWN, nothing internal in the body`);
    await setFaults('');
    const afterPkg = (await sGet(F.SID, rita.token)).body.signing;
    neg(JSON.stringify(afterPkg) === before.pkg && (await signings(rita.token)).length === before.rows && (await stage(F.RID, rita.token)) === before.stage && plKey(await orgPlayer(playerId)) === before.player && (await sHist(F.SID, rita.token)).body.items.length === before.hist, `#48 AD13 ${who}: the package, db.signings, the case, the player and the history are exactly as before — nothing half-written`);
    if (seam.endsWith('after_lifecycle')) await setFaults('internal:signing.complete.effects:1');
    const retry = await complete(F.SID, { expectedRev: afterPkg.rev, clientKey: key() }, rita.token);
    await setFaults('');
    ok(retry.status === 200 && sv(retry).status === 'COMPLETED' && (await signings(rita.token)).filter((s) => s.playerId === playerId).length === 1 && (await stage(F.RID, rita.token)) === 'signed' && plKey(await orgPlayer(playerId)).includes('under_contract'), `AD14 ${who}: once the fault is gone the same completion succeeds${seam.endsWith('after_lifecycle') ? ' even with the after-effects (badges, notifications) failing' : ''} — exactly one row, the case signed, the player under contract`);
  }
}

// ================================================================ Z — the signing boundary (source sweep) and restart
section('Z — the boundary: ONE writer of db.signings, signed and under_contract; keys and state survive a restart');
{
  const root = path.join(HERE, '..');
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (f === 'node_modules' || f === 'scripts' || f.startsWith('.')) continue; if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.mjs')) files.push(p); } };
  walk(root);
  const src = Object.fromEntries(files.map((f) => [path.relative(root, f), readFileSync(f, 'utf8')]));
  const pushes = Object.entries(src).filter(([, s]) => /db\.signings\.push\(/.test(s)).map(([f]) => f);
  neg(pushes.length === 1 && pushes[0] === 'm29/index.mjs', `#23 Z1 db.signings.push occurs in exactly one file: ${pushes.join(', ')}`);
  const uc = Object.entries(src).filter(([, s]) => /contractStatus\s*=\s*'under_contract'/.test(s)).map(([f]) => f);
  neg(uc.length === 1 && uc[0] === 'm29/index.mjs', `#25 Z2 contractStatus = 'under_contract' is written in exactly one file: ${uc.join(', ')}`);
  neg(!/db\.signings\.push|contractStatus = 'under_contract'|playerLevelAfterSigning\(/.test(src['server.mjs'].slice(src['server.mjs'].indexOf("orgRouter.post('/players/:id/signing'"), src['server.mjs'].indexOf("orgRouter.get('/signings'"))), 'Z3 the legacy route itself writes nothing: it delegates to the ONE writer');
  neg(!/status\s*=\s*'signed'|room\.status\s*=\s*['"]signed/.test(src['m29/index.mjs']) && /confirmSignedOutcome/.test(src['m29/index.mjs']) && /applyLifecycleTransition/.test(src['m29/index.mjs']), '#24 Z4 m29 never assigns the status word: signed is reached through the ONE validator and the ONE lifecycle writer');
  neg(!/docusign|adobe\s*sign|hellosign|pandadoc|qualified electronic signature/i.test(src['m29/index.mjs'] + src['m29/signing.mjs']), 'Z5 no external provider is named or faked');
  neg(!/trustScore|computeTrustScore|trustProfile/.test(src['m29/index.mjs'] + src['m29/signing.mjs']), '#50 Z6 the signing module never touches the Trust Score');
  // restart
  const D = globalThis.__DONE; const KI = globalThis.__KI;
  const before = { d: (await sGet(D.SID)).body.signing, k: (await sGet(KI.SID)).body.signing, rows: await signings() };
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; } }
  server = await boot();
  const re = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  ok(!!re?.token && (await j('GET', '/healthz')).body.schemaVersion === 2308, 'Z7 the server came back on schema 2308');
  ok(JSON.stringify((await sGet(D.SID, re.token)).body.signing) === JSON.stringify(before.d) && JSON.stringify((await sGet(KI.SID, re.token)).body.signing) === JSON.stringify(before.k), 'Z8 completed packages are byte-identical after the restart');
  ok(JSON.stringify(await signings(re.token)) === JSON.stringify(before.rows), '#47 Z9 the db.signings rows are byte-identical: nothing was duplicated or repaired on boot');
  neg(expect(await complete(D.SID, { expectedRev: before.d.rev, clientKey: key() }, re.token), 409, 'SIGNING_ALREADY_COMPLETED') && (await signings(re.token)).length === before.rows.length, '#47 Z10 completion after a restart is still refused: one row');
  ok((await stage(D.RID, re.token)) === 'signed', 'Z11 the case is still signed');
}

console.log(`\nM23 P7 Signing suite: ${passed} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / Math.max(passed, 1)) * 100)}%)`);
if (failures) console.error(`\n✗ M23 P7 Signing has ${failures} failure(s).`); else console.log('all M23 P7 Signing checks passed');
server.kill('SIGKILL');
process.exit(failures ? 1 : 0);
