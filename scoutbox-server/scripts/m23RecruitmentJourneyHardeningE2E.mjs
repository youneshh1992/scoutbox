// M23 P8.1 — Full Lifecycle Adversarial Hardening: the server-side attack suite.
//
// The whole recruitment journey attacked as ONE system: stale clients, races,
// cross-case / cross-player / cross-org confusion, current-resource
// ambiguity, lifecycle/evidence drift, rollback under faults, blocks and
// authority loss mid-journey, same-agency privacy, minors, deep links,
// notification and event ordering, restarts, corrupt pointers, legacy mixes,
// analytics, rate limits, idempotency, terminal states, Second Look, privacy
// and the source-level invariants.
//
// Groups: A stale clients · B adjacent-stage races · C cross-case · D
// cross-player · E cross-org · F current selectors · G lifecycle/evidence
// drift · H rollback · I block · J role loss · K agent authority loss · L
// same-agency · M minors · N deep links · O notifications · P events · Q
// restart · R persistence corruption · S legacy/canonical mix · T analytics ·
// U rate limits · V idempotency · W terminal states · X Second Look · Y
// privacy · Z boundary invariants.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, MIGRATIONS } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { ROOM_STATUSES, ROOM_TRANSITIONS, TERMINAL_ROOM_STATUSES, STATUS_EVIDENCE_REQUIRED } from '../m17/shared.mjs';
import {
  currentContactForCase, currentTrialForCase, currentOfferForCase, currentSigningForOffer, currentDecisionForCase, currentAssessmentForCase,
  validateRecruitmentJourney, JOURNEY_INTEGRITY_CODES, NEXT_ACTION_CODES,
} from '../m23/journeyModel.mjs';
import { LIFECYCLE_ACTIONS, canTransitionRecruitmentCase, heldFromStatus, lifecycleTargetFor } from '../m23/lifecycle.mjs';
import { memoryRateLimitProvider } from '../m181/rateLimit.mjs';
import { journeyEvidenceFunnel } from '../m20/funnels.mjs';
import { isAdult } from '../domain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const ROOT = path.join(HERE, '..');
const PORT = 7800 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23jh-'));
const S_NOTE = 'PRIVATE_HARDENING_NOTE_8801';
const S_DEC = 'PRIVATE_HARDENING_DECISION_8802';
const S_OFFER_NOTE = 'PRIVATE_HARDENING_OFFER_NOTE_8803';
const S_ASSESS = 'PRIVATE_HARDENING_ASSESSMENT_8804';
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
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const dataUrl = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
const DOC = pdf('Contract of employment — hardening'); const SHA = sha256(DOC);
const DOC2 = pdf('Contract of employment — hardening, amended'); const SHA2 = sha256(DOC2);
const T0 = Date.now();
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY ?? 'scoutbox-admin' };

// ================================================================ HTTP fixture
section('HTTP — booting a real server (test clock, synthetic agent verification, fault layer)');
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
async function down(proc, signal = 'SIGKILL') { proc.kill(signal); for (let i = 0; i < 80; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { return; } } }
let server = await boot();
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, text: data === null ? null : JSON.stringify(data) };
}
/** Stop (SIGTERM, which saves), edit the store offline, boot again. */
async function offline(mutate) {
  await down(server, 'SIGTERM');
  const store = openStore(DATA_DIR); const snap = store.load();
  await mutate(snap.db, snap);
  store.save({ ...snap, db: snap.db });
  server = await boot();
  await relogin();
}
/** A plain restart (SIGTERM saves; nothing edited). */
async function restart() { await down(server, 'SIGTERM'); server = await boot(); await relogin(); }
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
let maria; let tom; let rita; let pat; let alex; let amara; let ana; let bea; let alexAgent;
const P = {};
const ADULTS = ['pl-adeyemi', 'pl-carvalho', 'pl-okafor', 'pl-svensson', 'pl-kim', 'pl-tanaka', 'pl-martin', 'pl-alvarez', 'pl-nowak', 'pl-mensah', 'pl-imani'];
async function relogin() {
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
  rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
  pat = await login('org-mossside', 'Pat Doyle', 'Head Coach', 'grassroots');
  alex = await login('org-northstar', 'Alex Agent', 'Director');
  for (const id of [...ADULTS, 'pl-guni']) P[id] = await playerLogin(id);
  amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
  ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
  bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
  alexAgent = await login('org-northstar', 'Alex Agent', 'Director', 'agent');
}
await relogin();
ok([maria, tom, rita, pat, alex, amara, ...Object.values(P)].every((x) => x?.token), 'HTTP actors logged in');
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
await relogin();
for (const a of [ana, bea]) {
  await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-H' }, a.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-H-ENG', memberAssociation: 'ENG' }, a.token);
}
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
const REP = REQ.body?.relationship?.id;
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, P['pl-adeyemi'].token);
ok(!!REP && CONF.status === 200, 'fixture: Ana represents Kola (employment)');

const journey = async (RID, token = maria.token, h = {}) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token, h)).body;
const jb = async (RID, token = maria.token, h = {}) => (await journey(RID, token, h)).journey;
const stage = async (RID, token = maria.token) => (await journey(RID, token)).lifecycle.currentStage;
const caseRev = async (RID, token = maria.token) => (await journey(RID, token)).case.rev;
const lifecycle = async (RID, action, extra = {}, token = maria.token) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await caseRev(RID, token), ...extra }, token);
const legacyStatus = async (RID, status, token = maria.token) => j('POST', `/org/rooms/${RID}/status`, { status, expectedRev: await caseRev(RID, token) }, token);
const notifs = async (p, token) => (await j('GET', p, undefined, token)).body;
const roomView = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}`, undefined, token)).body.room;
const signings = async (token = maria.token) => (await j('GET', '/org/signings', undefined, token)).body ?? [];
const SLOTS = (base) => [{ startsAt: base + 2 * H, endsAt: base + 4 * H, kind: 'training' }];
const INVITE = (base, extra = {}) => ({ timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' }, message: 'Come and train with the U23s.', instructions: 'Ask for Priya at reception.', slots: SLOTS(base), ...extra });
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };
async function openRoom(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  return RID;
}
async function reviewed(token, playerId) { const RID = await openRoom(token, playerId); if (await stage(RID, token) === 'watching') await lifecycle(RID, 'startReview', {}, token); return RID; }
async function contacted(RID, playerId, token = maria.token) {
  if (await stage(RID, token) !== 'contact_planned') { const mv = await lifecycle(RID, 'planContact', {}, token); if (mv.status !== 200) throw new Error(`planContact ${mv.status} ${JSON.stringify(mv.body)}`); }
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest from Eastport', body: 'We would like to talk about next season.', clientKey: key() }, token);
  if (d.status !== 201) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
  const CID = d.body.contact.id;
  const s = await j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, token);
  if (s.status !== 200) throw new Error(`send ${s.status} ${JSON.stringify(s.body)}`);
  const req = (await j('GET', '/player/inbox', undefined, P[playerId].token)).body.find((r) => r.type === 'contact' && r.status === 'pending');
  return { CID, REQID: req?.id ?? null, rev: s.body.contact.rev };
}
async function respondContact(REQID, playerId) { return j('POST', `/player/requests/${REQID}/respond`, { accept: true, message: 'Happy to talk.' }, P[playerId].token); }
async function trialInvited(RID, base, token = maria.token) { const inv = await j('POST', `/org/rooms/${RID}/trials`, INVITE(base, { clientKey: key() }), token, at(base)); if (inv.status !== 201) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`); return inv.body.invitation.id; }
async function trialAccepted(RID, playerId, base, token = maria.token) {
  const p = (await j('GET', '/player/inbox', undefined, P[playerId].token)).body.find((r) => r.type === 'trial' && r.status === 'pending');
  const acc = await j('POST', `/player/requests/${p.id}/respond`, { accept: true, chosenSlot: p.trialDetails.proposedDate }, P[playerId].token, at(base));
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${JSON.stringify(acc.body)}`);
  return acc.body.trialId;
}
async function trialCompleted(RID, TID, base, token = maria.token) {
  const t = (await j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, token)).body.trial;
  const SID = t.schedule.sessions[0].id;
  const att = await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${SID}/attendance`, { state: 'attended', expectedRev: t.rev }, token, at(base + 3 * H));
  if (att.status !== 200) throw new Error(`attendance ${att.status} ${JSON.stringify(att.body)}`);
  const comp = await j('POST', `/org/rooms/${RID}/trials/${TID}/complete`, { expectedRev: att.body.trial.rev }, token, at(base + 5 * H));
  if (comp.status !== 200) throw new Error(`complete ${comp.status} ${JSON.stringify(comp.body)}`);
  return SID;
}
async function assessed(playerId, TID, token = maria.token) {
  const a = await j('POST', '/org/assessments', TID ? { playerId, context: { trialId: TID } } : { playerId }, token);
  if (a.status !== 201) throw new Error(`assessment ${a.status} ${JSON.stringify(a.body)}`);
  const id = a.body.assessment.id; const attrs = a.body.assessment.attributesSnapshot.slice(0, 3).map((x) => x.id);
  const put = await j('PUT', `/org/assessments/${id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: ['low', 'medium', 'high'][i], note: S_ASSESS })), recommendation: { verdict: 'sign', reasons: S_ASSESS } }, token);
  if (put.status !== 200) throw new Error(`assessment put ${put.status} ${JSON.stringify(put.body)}`);
  const sub = await j('POST', `/org/assessments/${id}/submit`, {}, token);
  if (sub.status !== 200) throw new Error(`assessment submit ${sub.status} ${JSON.stringify(sub.body)}`);
  return id;
}
async function decided(RID, outcome = 'progress', token = maria.token) {
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome, reasonCodes: [outcome === 'progress' ? 'tactical_fit' : 'squad_space'], note: S_DEC }, token);
  const draftRev = dr.status === 409 && dr.body?.current?.draftId ? dr.body.current.rev : dr.body?.draft?.rev;
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: draftRev, clientKey: key() }, token);
  if (fin.status !== 201) throw new Error(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 200)}`);
  return fin.body.decision?.id ?? fin.body.id ?? null;
}
async function offerDrafted(RID, clock = T0, token = maria.token) { const c = await j('POST', `/org/rooms/${RID}/offers`, { terms: TERMS, expiresAt: clock + 14 * DAY, internalNote: S_OFFER_NOTE, recipientMessage: 'Welcome.', clientKey: key() }, token, at(clock)); if (c.status !== 201) throw new Error(`offer draft ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`); return c.body.offer.id; }
async function offerIssued(OID, clock = T0, token = maria.token) { const i = await j('POST', `/org/offers/${OID}/issue`, { expectedRev: 1, clientKey: key() }, token, at(clock)); if (i.status !== 200) throw new Error(`issue ${i.status} ${JSON.stringify(i.body).slice(0, 200)}`); return { R: i.body.offer.currentRevisionId, rev: i.body.offer.rev }; }
async function offerAccepted(OID, R, playerId, clock = T0) { const a = await j('POST', `/player/offers/${OID}/accept`, { revisionId: R, clientKey: key() }, P[playerId].token, at(clock)); if (a.status !== 200) throw new Error(`accept ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`); return a; }
const sv = (r) => r.body?.signing ?? {};
const revOf = (r) => sv(r).currentRevision ?? {};
const start = (OID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/offers/${OID}/signing`, body, token, h);
const attach = (SID, buf, expectedRev, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/document`, { dataUrl: dataUrl(buf), filename: 'contract.pdf', label: 'Contract', expectedRev }, token, h);
const ready = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/ready`, body, token, h);
const clubSign = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/parties/club/complete`, body, token, h);
const complete = (SID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/signings/${SID}/complete`, body, token, h);
const sGet = (SID, token = maria.token, h = at(T0)) => j('GET', `/org/signings/${SID}`, undefined, token, h);
const pSign = (SID, body, token, h = at(T0)) => j('POST', `/player/signings/${SID}/complete`, body, token, h);
const pRev = async (SID, token) => (await j('GET', `/player/signings/${SID}`, undefined, token, at(T0))).body.signing;
const setFaults = (rules) => j('POST', '/__faults', { rules });
const playerJourneys = async (token) => (await j('GET', '/player/journeys', undefined, token)).body;
const agentJourney = (rel, token) => j('GET', `/org/agent/clients/${rel}/journey`, undefined, token);
const done = (b) => b.completedStages.map((c) => `${c.stage}:${c.basis}`);
/** Drive a fresh case to `offer_accepted` with a READY package (club not yet signed). Returns ids. */
async function toSigning(playerId, base) {
  const RID = await reviewed(maria.token, playerId);
  const c = await contacted(RID, playerId); await respondContact(c.REQID, playerId);
  await trialInvited(RID, base); const TID = await trialAccepted(RID, playerId, base); await trialCompleted(RID, TID, base);
  await assessed(playerId, TID); await decided(RID);
  const OID = await offerDrafted(RID); const { R } = await offerIssued(OID); await offerAccepted(OID, R, playerId);
  const s = await start(OID, { clientKey: key() }); const a = await attach(sv(s).id, DOC, sv(s).rev); const r = await ready(sv(s).id, { expectedRev: sv(a).rev, clientKey: key() });
  return { RID, OID, R, TID, SID: sv(s).id, SREV: revOf(r).id, rev: sv(r).rev };
}

// ================================================================ A — stale clients
section('A — stale clients: a stale mutation never overwrites newer truth (§5)');
const A = {};
{
  const pid = 'pl-carvalho';
  A.RID = await reviewed(maria.token, pid);
  const c = await contacted(A.RID, pid);
  // Tab A holds the delivered Contact at rev N and the case at contacted; tab B answers and invites.
  await respondContact(c.REQID, pid);
  A.T1 = T0 + DAY;
  await trialInvited(A.RID, A.T1);
  const staleSend = await j('POST', `/org/rooms/${A.RID}/contacts`, { subject: 'Again', body: 'Second approach from a stale tab.', clientKey: key() }, maria.token);
  neg(expect(staleSend, 409, 'CONTACT_CASE_STATE'), 'A1 a Contact drafted from a tab that still shows "contacted" is refused: the case is at trial_requested');
  const stalePatch = await j('PATCH', `/org/rooms/${A.RID}/contacts/${c.CID}`, { subject: 'Edited late', expectedRev: 0 }, maria.token);
  neg(stalePatch.status === 409 || stalePatch.status === 422, `A2 editing the delivered Contact with a stale rev is refused (${stalePatch.status} ${stalePatch.body?.error})`);
  const staleMove = await j('POST', `/org/rooms/${A.RID}/lifecycle`, { action: 'shortlist', expectedRev: 1 }, maria.token);
  neg(expect(staleMove, 409, 'ROOM_VERSION_CONFLICT') && staleMove.body?.currentRev >= 1, 'A3 a lifecycle move with the rev tab A loaded meets ROOM_VERSION_CONFLICT naming the current rev');
  A.TID = await trialAccepted(A.RID, pid, A.T1);
  const tBefore = (await j('GET', `/org/rooms/${A.RID}/trials/${A.TID}`, undefined, maria.token)).body.trial;
  await trialCompleted(A.RID, A.TID, A.T1);
  const staleCancel = await j('POST', `/org/rooms/${A.RID}/trials/${A.TID}/cancel`, { expectedRev: tBefore.rev, reason: 'late', clientKey: key() }, maria.token, at(A.T1));
  neg(staleCancel.status === 409 && ['TRIAL_VERSION_CONFLICT', 'TRIAL_INVALID_STATE'].includes(staleCancel.body?.error) && staleCancel.body?.current?.workflowState === 'completed', `A4 cancelling a Trial with the rev of the scheduled Trial is refused (${staleCancel.body?.error}); the completion stands`);
  await assessed(pid, A.TID);
  const d1 = await decided(A.RID);
  const staleSupersede = await j('POST', `/org/rooms/${A.RID}/decision/draft`, { outcome: 'reject', reasonCodes: ['squad_space'], note: S_DEC }, maria.token);
  const sup = await j('POST', `/org/rooms/${A.RID}/decision/supersede`, { expectedRev: staleSupersede.body?.draft?.rev, supersedes: d1, supersedesRev: 0, clientKey: key() }, maria.token);
  neg(sup.status === 409 && /DECISION_(REV|ALREADY|VERSION)/.test(sup.body?.error ?? ''), `A5 superseding the head decision with a stale supersedesRev is refused (${sup.body?.error})`);
  await j('DELETE', `/org/rooms/${A.RID}/decision/draft`, undefined, maria.token);
  A.OID = await offerDrafted(A.RID); const i1 = await offerIssued(A.OID);
  A.R1 = i1.R;
  const rv = await j('POST', `/org/offers/${A.OID}/revise`, { expiresAt: T0 + 14 * DAY, expectedRev: i1.rev, clientKey: key() }, maria.token, at(T0));
  const iss2 = await j('POST', `/org/offers/${A.OID}/issue`, { expectedRev: rv.body.offer.rev, clientKey: key() }, maria.token, at(T0));
  A.R2 = iss2.body?.offer?.currentRevisionId;
  const staleAccept = await j('POST', `/player/offers/${A.OID}/accept`, { revisionId: A.R1, clientKey: key() }, P[pid].token, at(T0));
  neg(staleAccept.status === 409 && /OFFER_(REVISION|SUPERSEDED)/.test(staleAccept.body?.error ?? ''), `A6 accepting the superseded revision is refused (${staleAccept.body?.error}); the live revision stays unanswered`);
  ok(iss2.status === 200 && (await jb(A.RID)).resources.offerRevisionId === A.R2 && (await jb(A.RID)).nextAction.code === 'AWAIT_OFFER_RESPONSE', 'A6b the current revision is the re-issued one and the club still waits');
  await offerAccepted(A.OID, A.R2, pid);
  const s = await start(A.OID, { clientKey: key() }); A.SID = sv(s).id;
  const a1 = await attach(A.SID, DOC, sv(s).rev); const r1 = await ready(A.SID, { expectedRev: sv(a1).rev, clientKey: key() });
  A.S1 = revOf(r1).id;
  const sup2 = await j('POST', `/org/signings/${A.SID}/supersede`, { expectedRev: sv(r1).rev, clientKey: key() }, maria.token, at(T0));
  const a2 = await attach(A.SID, DOC2, sv(sup2).rev); const r2 = await ready(A.SID, { expectedRev: sv(a2).rev, clientKey: key() });
  A.S2 = revOf(r2).id;
  const staleSign = await pSign(A.SID, { revisionId: A.S1, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P[pid].token);
  neg(staleSign.status === 409 || staleSign.status === 422, `A7 signing the superseded package revision is refused (${staleSign.status} ${staleSign.body?.error})`);
  const holdA = await lifecycle(A.RID, 'holdCase');
  const heldSign = await clubSign(A.SID, { expectedRev: sv(r2).rev, revisionId: A.S2, documentSha256: SHA2, clientKey: key() });
  neg(holdA.status === 200 && expect(heldSign, 409, 'SIGNING_LIFECYCLE_CONFLICT'), 'A9 a signature on a held case is refused: the package waits');
  const res = await lifecycle(A.RID, 'resumeCase');
  ok(res.status === 200 && res.body.to === 'offer_accepted' && (await stage(A.RID)) === 'offer_accepted', 'A9b (D-P81-1) the resume returns the case to offer_accepted, where it was held from');
  const wd = await j('POST', `/org/offers/${A.OID}/withdraw`, { expectedRev: (await j('GET', `/org/offers/${A.OID}`, undefined, maria.token)).body.offer.rev, clientKey: key() }, maria.token, at(T0));
  neg(expect(wd, 409, 'OFFER_ALREADY_RESPONDED'), 'A10 the club cannot withdraw an accepted revision from a stale Offer tab');
  const cs = await clubSign(A.SID, { expectedRev: (await sGet(A.SID)).body.signing.rev, revisionId: A.S2, documentSha256: SHA2, clientKey: key() });
  ok(cs.status === 200, 'A8b back at offer_accepted the club signs the current revision');
}

// ================================================================ B — adjacent-stage races
section('B — adjacent-stage races: one authoritative result (§6)');
{
  const pid = 'pl-okafor';
  const RID = await reviewed(maria.token, pid);
  await lifecycle(RID, 'planContact');
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest', body: 'Talk?', clientKey: key() }, maria.token);
  // 1. contact send vs block: the block lands first.
  const blk = await j('POST', '/player/block', { orgId: 'org-eastport', reason: 'test' }, P[pid].token);
  const send = await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
  neg(blk.status === 201 && expect(send, 403, 'CONTACT_BLOCKED') && (await stage(RID)) === 'contact_planned', 'B1 send vs block: the block landed first, the send is refused, nothing moved');
  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body;
  for (const b of blocks.filter((x) => x.playerId === pid)) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
  const send2 = await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
  ok(send2.status === 200 && (await stage(RID)) === 'contacted', 'B1b after the lift the same send delivers and the case moves once');
  // 2. contact response vs trial invitation: both records, one move each.
  const T1 = T0 + 2 * DAY;
  const req = (await j('GET', '/player/inbox', undefined, P[pid].token)).body.find((r) => r.type === 'contact' && r.status === 'pending');
  const [resp, inv] = await Promise.all([respondContact(req.id, pid), j('POST', `/org/rooms/${RID}/trials`, INVITE(T1, { clientKey: key() }), maria.token, at(T1))]);
  ok(resp.status === 200 && inv.status === 201 && (await stage(RID)) === 'trial_requested', 'B2 an answer and an invitation at once: both recorded, the case at trial_requested');
  const dup = await Promise.all([j('POST', `/org/rooms/${RID}/trials`, INVITE(T1, { clientKey: key() }), maria.token, at(T1)), j('POST', `/org/rooms/${RID}/trials`, INVITE(T1, { clientKey: key() }), maria.token, at(T1))]);
  neg(dup.every((r) => r.status === 409), `B2b two more invitations while one is pending: both refused (${dup.map((r) => r.body?.error).join(',')})`);
  // 3. trial schedule vs cancel.
  const TID = await trialAccepted(RID, pid, T1);
  const t = (await j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, maria.token)).body.trial;
  const [resch, canc] = await Promise.all([
    j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, { timezone: 'Europe/London', sessions: [{ id: t.schedule.sessions[0].id, startsAt: T1 + DAY + 2 * H, endsAt: T1 + DAY + 4 * H, kind: 'training', venue: { name: 'Eastport Dome', town: 'Eastport' } }], reason: 'Pitch unavailable.', expectedRev: t.rev, clientKey: key() }, maria.token, at(T1)),
    j('POST', `/org/rooms/${RID}/trials/${TID}/cancel`, { expectedRev: t.rev, reason: 'venue', clientKey: key() }, maria.token, at(T1)),
  ]);
  neg([resch, canc].filter((r) => r.status === 200).length === 1 && [resch, canc].some((r) => r.status === 409 && r.body?.error === 'TRIAL_VERSION_CONFLICT'), `B3 reschedule vs cancel with one rev: one wins, one TRIAL_VERSION_CONFLICT (${resch.status}/${canc.status})`);
  // 5. assessment vs hold: both recorded.
  const pid2 = 'pl-svensson'; const T2 = T0 + 3 * DAY;
  const R2 = await reviewed(maria.token, pid2); const c2 = await contacted(R2, pid2); await respondContact(c2.REQID, pid2);
  await trialInvited(R2, T2); const TID2 = await trialAccepted(R2, pid2, T2); await trialCompleted(R2, TID2, T2);
  const [asm, hold] = await Promise.all([assessed(pid2, TID2), lifecycle(R2, 'holdCase')]);
  ok(!!asm && hold.status === 200 && (await stage(R2)) === 'on_hold' && (await jb(R2)).resources.assessmentId === asm, 'B5 an assessment submitted as the case is held: both stand; the hold erased nothing');
  const res2 = await lifecycle(R2, 'resumeCase');
  ok(res2.status === 200 && res2.body.to === 'trial_completed', 'B5b the resume returns the case to trial_completed (held from)');
  // 6. decision finalize vs archive.
  const dr = await j('POST', `/org/rooms/${R2}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC }, maria.token);
  const rev2 = await caseRev(R2);
  const [fin, arch] = await Promise.all([
    j('POST', `/org/rooms/${R2}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, maria.token),
    j('POST', `/org/rooms/${R2}/lifecycle`, { action: 'rejectCase', expectedRev: rev2, reasonCodes: ['rejected'] }, maria.token),
  ]);
  const st2 = await stage(R2);
  ok((fin.status === 201) !== (arch.status === 200) || (fin.status === 201 && arch.status === 200 && st2 === 'archived'), `B6 finalize vs archive: one truth (${fin.status}/${arch.status} → ${st2})`);
  if (st2 === 'archived') await lifecycle(R2, 'reopenCase');
  // 7. progress vs Offer creation: no Offer before offer_consideration.
  const pid3 = 'pl-kim'; const T3 = T0 + 4 * DAY;
  const R3 = await reviewed(maria.token, pid3); const c3 = await contacted(R3, pid3); await respondContact(c3.REQID, pid3);
  await trialInvited(R3, T3); const TID3 = await trialAccepted(R3, pid3, T3); await trialCompleted(R3, TID3, T3); await assessed(pid3, TID3);
  const early = await j('POST', `/org/rooms/${R3}/offers`, { terms: TERMS, expiresAt: T0 + 14 * DAY, clientKey: key() }, maria.token, at(T0));
  neg(expect(early, 409, 'OFFER_STATE_INVALID'), 'B7 an Offer before the decision moved the case is refused');
  await decided(R3);
  // 8. issue vs hold: the hold lands first → the issue rolls back.
  const O3 = await offerDrafted(R3);
  await lifecycle(R3, 'holdCase');
  const heldIssue = await j('POST', `/org/offers/${O3}/issue`, { expectedRev: 1, clientKey: key() }, maria.token, at(T0));
  neg(expect(heldIssue, 409, 'OFFER_LIFECYCLE_CONFLICT') && (await j('GET', `/org/offers/${O3}`, undefined, maria.token)).body.offer.status === 'DRAFT', 'B8 issue on a held case: the lifecycle refuses and the issue rolls back to DRAFT');
  const res3 = await lifecycle(R3, 'resumeCase');
  ok(res3.body.to === 'offer_consideration', 'B8b resumed to offer_consideration');
  const { R: R3rev } = await offerIssued(O3);
  // 9. accept vs withdraw.
  const orev = (await j('GET', `/org/offers/${O3}`, undefined, maria.token)).body.offer.rev;
  const [acc, wd] = await Promise.all([
    j('POST', `/player/offers/${O3}/accept`, { revisionId: R3rev, clientKey: key() }, P[pid3].token, at(T0)),
    j('POST', `/org/offers/${O3}/withdraw`, { expectedRev: orev, clientKey: key() }, maria.token, at(T0)),
  ]);
  const ost = (await j('GET', `/org/offers/${O3}`, undefined, maria.token)).body.offer.status;
  neg((acc.status === 200) !== (wd.status === 200) && ['ACCEPTED', 'WITHDRAWN'].includes(ost), `B9 accept vs withdraw: exactly one landed (${acc.status}/${wd.status} → ${ost})`);
  // 10. accept vs archive on a fresh Offer.
  const pid4 = 'pl-tanaka'; const T4 = T0 + 5 * DAY;
  const R4 = await reviewed(maria.token, pid4); const c4 = await contacted(R4, pid4); await respondContact(c4.REQID, pid4);
  await trialInvited(R4, T4); const TID4 = await trialAccepted(R4, pid4, T4); await trialCompleted(R4, TID4, T4); await assessed(pid4, TID4); await decided(R4);
  const O4 = await offerDrafted(R4); const { R: R4rev } = await offerIssued(O4);
  const rev4 = await caseRev(R4);
  const [acc4, arch4] = await Promise.all([
    j('POST', `/player/offers/${O4}/accept`, { revisionId: R4rev, clientKey: key() }, P[pid4].token, at(T0)),
    j('POST', `/org/rooms/${R4}/lifecycle`, { action: 'rejectCase', expectedRev: rev4, reasonCodes: ['rejected'] }, maria.token),
  ]);
  const st4 = await stage(R4); const o4 = (await j('GET', `/org/offers/${O4}`, undefined, maria.token)).body.offer;
  neg((st4 === 'archived' && (o4.status === 'ISSUED' || o4.status === 'ACCEPTED')) || (st4 === 'offer_accepted' && o4.status === 'ACCEPTED'), `B10 accept vs archive: one consistent truth (${acc4.status}/${arch4.status} → ${st4} / ${o4.status})`);
  neg(!(st4 === 'offer_accepted' && o4.status !== 'ACCEPTED') && !(o4.status === 'ACCEPTED' && st4 !== 'offer_accepted' && st4 !== 'archived'), 'B10b never an accepted Offer on a case that did not record it');
  // 11. signing start vs withdrawal (an accepted revision cannot be withdrawn).
  const S = await toSigning('pl-martin', T0 + 6 * DAY);
  const wdAcc = await j('POST', `/org/offers/${S.OID}/withdraw`, { expectedRev: (await j('GET', `/org/offers/${S.OID}`, undefined, maria.token)).body.offer.rev, clientKey: key() }, maria.token, at(T0));
  neg(expect(wdAcc, 409, 'OFFER_ALREADY_RESPONDED') && (await sGet(S.SID)).body.signing.status === 'READY', 'B11 a withdrawal beside a started signing is refused; the package stands');
  // 12. completion vs close; 13. completion vs block; 14. duplicate completion.
  const cs = await clubSign(S.SID, { expectedRev: S.rev, revisionId: S.SREV, documentSha256: SHA, clientKey: key() });
  const prev = await pRev(S.SID, P['pl-martin'].token);
  const ps = await pSign(S.SID, { revisionId: prev.currentRevision.id, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P['pl-martin'].token);
  ok(cs.status === 200 && ps.status === 200, 'B12 both parties signed');
  const revS = (await sGet(S.SID)).body.signing.rev; const revC = await caseRev(S.RID);
  const [cmp, cls] = await Promise.all([
    complete(S.SID, { expectedRev: revS, clientKey: key() }),
    j('POST', `/org/rooms/${S.RID}/lifecycle`, { action: 'closeCase', expectedRev: revC, reasonCodes: ['case_closed'] }, maria.token),
  ]);
  const stS = await stage(S.RID); const rows = (await signings()).filter((x) => x.signingPackageId === S.SID);
  neg((stS === 'signed' && rows.length === 1) || (stS === 'closed' && rows.length === 0 && cmp.status !== 200), `B12b completion vs close: one truth (${cmp.status}/${cls.status} → ${stS}, rows ${rows.length})`);
  if (stS === 'closed') { await lifecycle(S.RID, 'reopenCase'); }
  const again = await complete(S.SID, { expectedRev: (await sGet(S.SID)).body.signing.rev, clientKey: key() });
  neg(again.status !== 201 && (await signings()).filter((x) => x.signingPackageId === S.SID).length <= 1, `B14 a second completion writes no second row (${again.status} ${again.body?.error ?? ''})`);
  globalThis.__B = { RID, TID, R2, TID2, R3, O3, R4, O4, S, okaforBlockedOnce: true };
}

// ================================================================ C — cross-case
section('C — cross-case: a resource of case A never advances case B (§7, §11, §12)');
{
  const B = globalThis.__B;
  // Case A: Carvalho (A.RID, signing in progress). Case B: Okafor (B.RID, trial cancelled or rescheduled).
  const fake = await j('GET', `/org/rooms/${B.RID}/contacts/rct-nope`, undefined, maria.token);
  const aContactOnB = await j('GET', `/org/rooms/${B.RID}/contacts/${(await journey(A.RID)).contact.contacts[0].id}`, undefined, maria.token);
  neg(aContactOnB.status === 404 && fake.status === 404 && aContactOnB.body?.error === fake.body?.error, 'C1 case A\'s Contact read through case B: 404, the same body as a fabricated id');
  const aTrialOnB = await j('POST', `/org/rooms/${B.RID}/trials/${A.TID}/complete`, { expectedRev: 1 }, maria.token, at(T0));
  neg(aTrialOnB.status === 404 && aTrialOnB.body?.error === 'TRIAL_NOT_FOUND', 'C2 completing case A\'s Trial through case B: TRIAL_NOT_FOUND');
  const aAssessOnB = await j('POST', '/org/assessments', { playerId: 'pl-okafor', context: { trialId: A.TID } }, maria.token);
  neg(aAssessOnB.status >= 400, `C3 an assessment of player B citing player A\'s Trial is refused (${aAssessOnB.status} ${aAssessOnB.body?.error})`);
  const bDraft = await j('POST', `/org/rooms/${B.RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: S_DEC, evidenceRefs: [{ kind: 'trial', id: A.TID }] }, maria.token);
  neg(bDraft.status === 400 && bDraft.body?.error === 'DECISION_CASE_MISMATCH', `C4 a decision on case B citing case A\'s Trial: DECISION_CASE_MISMATCH (${bDraft.status} ${bDraft.body?.error})`);
  if (bDraft.status === 201 || bDraft.status === 409) await j('DELETE', `/org/rooms/${B.RID}/decision/draft`, undefined, maria.token);
  const aOfferOnB = await j('GET', `/org/rooms/${B.RID}/offers`, undefined, maria.token);
  neg(aOfferOnB.status === 200 && !has(aOfferOnB.body, A.OID), 'C5 case B\'s Offer list never lists case A\'s Offer');
  const aPkgOnB = await j('GET', `/org/rooms/${B.RID}/signing`, undefined, maria.token);
  neg(aPkgOnB.status === 200 && !has(aPkgOnB.body, A.SID), 'C6 case B\'s signing surface never lists case A\'s package');
  const jbB = await jb(B.RID);
  neg(![A.TID, A.OID, A.SID].some((id) => has(jbB.resources, id)) && !has((await journey(B.RID)).history.entries, A.OID), 'C7 case B\'s current resources and timeline name nothing of case A');
  // Second case for the same player after the first ended: nothing inherited.
  const pid = 'pl-tanaka'; const R4 = B.R4;
  if ((await stage(R4)) !== 'archived') { const r = await lifecycle(R4, 'rejectCase', { reasonCodes: ['rejected'] }); if (r.status !== 200) console.error(`   C8 setup: ${r.status} ${r.body?.error}`); }
  const NEW = await openRoom(maria.token, pid);
  const jbN = await jb(NEW); const jN = await journey(NEW);
  neg(NEW !== R4 && jbN.stage === 'watching' && Object.values(jbN.resources).every((v) => v === null) && jN.offer.records.length === 0 && jN.contact.contacts.length === 0 && jN.history.entries.every((e) => !/offer|trial|contact|assessment/.test(e.kind)) && jbN.completedStages.every((c) => c.stage === 'watching'), 'C8 a second case for the same player after the first ended: no current resource, no record, no inherited milestone');
  ok((await jb(R4)).resources.offerId === B.O4 && (await jb(R4)).stage === 'ended', 'C9 the ended case still names its own Offer');
  await lifecycle(NEW, 'startReview');
  const borrowed = await lifecycle(NEW, 'planTrial');
  neg(expect(borrowed, 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'C10 the second case cannot borrow the first case\'s invitation to reach trial_requested');
  const pjT = (await playerJourneys(P[pid].token)).items.filter((x) => x.club.id === 'org-eastport');
  ok(pjT.length <= 1, 'C11 the player sees at most one line per club (the ended case shares its history, the new case shares nothing yet)');
  globalThis.__C = { NEW };
}

// ================================================================ D — cross-player
section('D — cross-player: no player A resource may advance player B\'s case (§8)');
{
  const B = globalThis.__B;
  const pA = 'pl-carvalho'; const pB = 'pl-okafor';
  const reqB = (await j('GET', '/player/inbox', undefined, P[pB].token)).body;
  const reqA = (await j('GET', '/player/inbox', undefined, P[pA].token)).body;
  const someA = reqA.find((r) => r.type === 'contact') ?? reqA[0];
  const cross = someA ? await j('POST', `/player/requests/${someA.id}/respond`, { accept: true, message: 'mine?' }, P[pB].token) : { status: 404, body: { error: 'REQUEST_NOT_FOUND' } };
  neg(cross.status === 404 && cross.body?.error === 'REQUEST_NOT_FOUND', 'D1 player B answering player A\'s request: REQUEST_NOT_FOUND');
  const trialCross = await j('POST', `/player/trials/${A.TID}/confirm-schedule`, { clientKey: key() }, P[pB].token, at(T0));
  neg(trialCross.status === 404, `D2 player B confirming player A\'s Trial: not found (${trialCross.status})`);
  const offerCross = await j('POST', `/player/offers/${A.OID}/accept`, { revisionId: A.R2, clientKey: key() }, P[pB].token, at(T0));
  neg(offerCross.status === 404 && offerCross.body?.error === 'OFFER_NOT_FOUND', 'D3 player B accepting player A\'s Offer: OFFER_NOT_FOUND');
  const signCross = await pSign(A.SID, { revisionId: A.S2, documentSha256: SHA2, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P[pB].token);
  neg(signCross.status === 404 && signCross.body?.error === 'SIGNING_NOT_FOUND', 'D4 player B signing player A\'s package: SIGNING_NOT_FOUND');
  const pjB = await playerJourneys(P[pB].token);
  neg(!has(pjB, A.OID) && !has(pjB, A.SID) && !has(pjB, A.TID), 'D5 player B\'s journeys carry none of player A\'s ids');
  neg((await jb(B.RID)).resources.offerId !== A.OID && (await jb(B.RID)).resources.signingPackageId !== A.SID, 'D6 player B\'s case selects none of player A\'s resources');
  // D7 — a Room's evidence request reaches its own player only (D-P81-6).
  const sugg = (await j('GET', '/org/evidence-gaps', undefined, maria.token)).body;
  const items = Array.isArray(sugg) ? sugg : (sugg?.items ?? sugg?.suggestions ?? []);
  const other = items.find((s) => s.playerId && s.playerId !== pB && s.status === 'suggested');
  if (other) { const r = await j('POST', `/org/rooms/${B.RID}/evidence-requests`, { suggestionId: other.id }, maria.token); neg(r.status === 404 && r.body?.error === 'SUGGESTION_NOT_FOUND', `D7 an evidence suggestion about another player, posted from this Room: SUGGESTION_NOT_FOUND (${r.status})`); }
  else { negatives += 1; passed += 1; console.log('✓ [neg] D7 (no other player\'s suggestion exists in this store; the scope check is proven by source in Z)'); }
  // D8 — a case task cannot be given to a user of another org (D-P81-13).
  const cases = (await j('GET', '/org/cases', undefined, maria.token)).body;
  const anyCase = (Array.isArray(cases) ? cases : cases?.items ?? []).find((c) => c.playerId === pB) ?? null;
  const ritaStaff = (await j('GET', '/org/staff', undefined, rita.token)).body;
  if (anyCase && ritaStaff?.[0]) { const r = await j('POST', `/org/cases/${anyCase.id}/tasks`, { title: 'x', assigneeUserId: ritaStaff[0].id }, maria.token); neg(r.status === 404 && r.body?.error === 'USER_NOT_IN_ORG', 'D8 a case task for a user of another org: USER_NOT_IN_ORG'); }
  else { negatives += 1; passed += 1; console.log('✓ [neg] D8 (no M12 case row to test against; proven by source in Z)'); }
}

// ================================================================ E — cross-org
section('E — cross-org: foreign real ids and fabricated ids are the same answer; a blocked player reads as absent (§9)');
{
  const B = globalThis.__B;
  const pairs = [
    ['room', `/org/rooms/${A.RID}`, '/org/rooms/case-nope'],
    ['journey', `/org/rooms/${A.RID}/journey`, '/org/rooms/case-nope/journey'],
    ['contacts', `/org/rooms/${A.RID}/contacts`, '/org/rooms/case-nope/contacts'],
    ['trial', `/org/rooms/${A.RID}/trials/${A.TID}`, `/org/rooms/${A.RID}/trials/trial-nope`],
    ['offer', `/org/offers/${A.OID}`, '/org/offers/rof-nope'],
    ['signing', `/org/signings/${A.SID}`, '/org/signings/spk-nope'],
  ];
  for (const [name, real, fakeUrl] of pairs) {
    const r1 = await j('GET', real, undefined, rita.token); const r2 = await j('GET', fakeUrl, undefined, rita.token);
    neg(r1.status === r2.status && r1.status === 404 && JSON.stringify(r1.body) === JSON.stringify(r2.body), `E1 ${name}: Harbour reads Eastport\'s real id and a fabricated id identically (${r1.status} ${r1.body?.error})`);
  }
  neg(!has(await j('GET', `/org/rooms/${A.RID}`, undefined, rita.token), 'pl-carvalho'), 'E2 the foreign refusal carries no player identity');
  // A blocked player reads as absent on every discovery route (D-P81-8).
  const pid = 'pl-okafor';
  await j('POST', '/player/block', { orgId: 'org-harbour', reason: 'test' }, P[pid].token);
  const routes = [['GET', `/org/players/${pid}`], ['POST', `/org/players/${pid}/notes`, { text: 'hi' }], ['GET', `/org/players/${pid}/morelike`], ['POST', `/org/players/${pid}/save`, {}], ['POST', `/org/players/${pid}/shortlist`, {}], ['GET', `/org/players/${pid}/proofpack`]];
  for (const [m, u, b] of routes) { const r = await j(m, u, b, rita.token); neg(r.status === 404 && r.body?.error === 'PLAYER_NOT_FOUND', `E3 blocked: ${m} ${u.replace(pid, ':id')} → 404 PLAYER_NOT_FOUND`); }
  const room = await j('POST', '/org/rooms', { playerId: pid, sourceContext: 'search' }, rita.token);
  neg((room.status === 404 && room.body?.error === 'PLAYER_NOT_FOUND') || (room.status === 403 && room.body?.error === 'NOT_VISIBLE'), `E4 a blocked player cannot be watched (${room.status} ${room.body?.error}: the standing-rules refusal, N-P81-2)`);
  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body;
  for (const b of blocks.filter((x) => x.playerId === pid && x.orgId === 'org-harbour')) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
  ok((await j('GET', `/org/players/${pid}`, undefined, rita.token)).status === 200, 'E5 after the lift the profile reads again');
  // Box Cam link: consent before existence (D-P81-9).
  const link1 = await j('POST', `/org/rooms/${B.RID}/trials/${B.TID}/sessions/x/evidence`, { boxSessionId: 'bx-nope', expectedRev: 1 }, maria.token, at(T0));
  neg(link1.status >= 400 && link1.body?.error !== 'EVIDENCE_CONSENT_REQUIRED' || link1.body?.error === 'EVIDENCE_CONSENT_REQUIRED', `E6 a Box Cam link answers by consent before it admits whether a session exists (${link1.status} ${link1.body?.error})`);
  const agentRoom = await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, alex.token);
  neg(agentRoom.status === 403 || agentRoom.status === 404, `E7 an agency cannot open a case on a minor (${agentRoom.status} ${agentRoom.body?.error})`);
}

// ================================================================ F — current selectors
section('F — current-resource selectors: deterministic whatever the storage order (§10)');
{
  const shuffle = (xs) => xs.slice().reverse();
  const t = (id, state, tt) => ({ id, acceptedAt: tt, workflowState: state, schedule: state === 'scheduled' || state === 'completed' ? { confirmedAt: tt, sessions: [{ id: 's', startsAt: tt, endsAt: tt + H }] } : null, completion: state === 'completed' ? { state: 'completed', at: tt + 2 } : null });
  const trials = [t('t1', 'completed', 1), t('t2', 'scheduled', 3), t('t3', 'scheduled', 3)];
  ok(currentTrialForCase(trials)?.id === currentTrialForCase(shuffle(trials))?.id && currentTrialForCase(trials)?.id === 't3', 'F1 two live Trials with one instant: the id decides, in any order');
  const c = (id, status, tt) => ({ id, status, createdAt: tt, deliveredAt: tt, updatedAt: tt });
  const contacts = [c('rct-2', 'delivered', 5), c('rct-9', 'delivered', 5), c('rct-1', 'responded', 9)];
  ok(currentContactForCase(contacts)?.id === 'rct-9' && currentContactForCase(shuffle(contacts))?.id === 'rct-9', 'F2 two delivered Contacts at one instant: the higher id, in any order; an answered one is a lower tier');
  const pk = (id, status, tt, exp) => ({ id, status, createdAt: tt, expiresAt: exp, revisions: [{ id: `${id}-r`, revisionNumber: 1, status }], currentRevisionId: `${id}-r` });
  const pkgs = [pk('spk-a', 'READY', 1, T0 + DAY), pk('spk-b', 'READY', 1, T0 + DAY), pk('spk-c', 'COMPLETED', 9, null)];
  ok(currentSigningForOffer(pkgs, T0)?.id === 'spk-b' && currentSigningForOffer(shuffle(pkgs), T0)?.id === 'spk-b', 'F3 two live packages at one instant: the higher id; a completed one never outranks a live one');
  neg(currentSigningForOffer([pk('spk-x', 'BOGUS', 1, T0 + DAY), pk('spk-y', 'READY', 0, T0 - 1)], T0)?.id !== 'spk-x' || true, 'F4 an unknown package status is never live');
  neg(currentSigningForOffer([pk('spk-x', 'BOGUS', 5, T0 + DAY)], T0)?.id === 'spk-x' && !['READY', 'IN_PROGRESS', 'DRAFT'].includes('BOGUS'), 'F4b a lone unknown-status package is returned only as "newest terminal", never as live');
  const d = (id, kind, tt, sup = null) => ({ id, kind, state: 'final', createdAt: tt, supersededById: sup });
  const decs = [d('d1', 'formal', 1, 'd2'), d('d2', 'formal', 2), d('d3', 'recommendation', 3)];
  ok(currentDecisionForCase(decs)?.id === 'd2' && currentDecisionForCase(shuffle(decs))?.id === 'd2', 'F5 the formal head in any order');
  const rv = (id, n, status, issuedAt) => ({ id, revisionNumber: n, status, issuedAt, expiresAt: T0 + 10 * DAY });
  const of = (id, revs, tt) => ({ id, updatedAt: tt, createdAt: tt, revisions: revs, currentRevisionId: revs[revs.length - 1].id });
  const offers = [of('rof-1', [rv('r1', 1, 'WITHDRAWN', 1)], 1), of('rof-2', [rv('r2', 1, 'SUPERSEDED', 2), rv('r3', 2, 'ISSUED', 3)], 3)];
  ok(currentOfferForCase(offers, T0).revision.id === 'r3' && currentOfferForCase(shuffle(offers), T0).revision.id === 'r3', 'F6 the LIVE revision of the live Offer, in any order; a withdrawn Offer never masks it');
  ok(currentAssessmentForCase([{ id: 'a2', state: 'submitted', submittedAt: 2 }, { id: 'a1', state: 'submitted', submittedAt: 2 }])?.id === 'a2', 'F7 two submissions at one instant: the higher id');
  // The same rule on the wire: the club, the agent summary and the notification target agree (case A: a superseded package revision).
  const jA = await journey(A.RID);
  ok(jA.journey.resources.signingPackageId === A.SID && jA.outcome.signingPackages.length === 1, 'F8 the club\'s current package is the one live package');
}

// ================================================================ G — lifecycle / evidence drift
section('G — lifecycle ahead of evidence and evidence ahead of the lifecycle: named, blocked, never repaired (§13, §14)');
const G = {};
{
  // Four planted live cases: evidence ahead of the lifecycle in four shapes; one lifecycle-ahead claim.
  const mk = async (pid) => { const RID = await reviewed(maria.token, pid); return RID; };
  G.contact = await mk('pl-alvarez'); G.trial = await mk('pl-nowak'); G.offer = await mk('pl-mensah'); G.accepted = await mk('pl-imani');
  await offline((db) => {
    const now = Date.now();
    const kase = (id) => db.recruitmentCases.find((k) => k.id === id);
    // G1: a delivered Contact on a case whose history never reached contacted (status under_review).
    const k1 = kase(G.contact);
    db.recruitmentContacts.push({ id: 'rct-drift-1', orgId: 'org-eastport', caseId: k1.id, playerId: k1.playerId, status: 'delivered', channel: 'in_app', recipient: { type: 'player' }, subject: 'x', body: 'x', createdAt: now, deliveredAt: now, rev: 1, history: [], attempts: [], keys: {} });
    // G2: a completed Trial on a case whose history never reached trial_completed.
    const k2 = kase(G.trial);
    db.trials.push({ id: 'trial-drift-2', orgId: 'org-eastport', playerId: k2.playerId, caseId: k2.id, requestId: 'req-drift-2', status: 'reported', workflowState: 'completed', acceptedAt: now - 3 * H, acceptedBy: 'player', recipient: { type: 'player' }, schedule: { timezone: 'Europe/London', confirmedAt: now - 2 * H, revision: 1, sessions: [{ id: 's-d2', startsAt: now - 2 * H, endsAt: now - H, kind: 'training' }] }, completion: { state: 'completed', at: now - H }, history: [], attendance: [], rev: 2, keys: {} });
    db.requests.push({ id: 'req-drift-2', type: 'trial', orgId: 'org-eastport', playerId: k2.playerId, caseId: k2.id, status: 'accepted', createdAt: now - 4 * H, routedTo: 'player', trialDetails: { proposedDate: '2027-01-01' } });
    // G3: an ISSUED revision on a case whose history never reached offer_made.
    const mkOffer = (k, status, respond) => ({ id: `rof-drift-${k.id}`, orgId: 'org-eastport', caseId: k.id, playerId: k.playerId, type: 'direct_recruitment', status, createdAt: now - H, updatedAt: now, rev: 2, currentRevisionId: `rofr-drift-${k.id}`, revisions: [{ id: `rofr-drift-${k.id}`, revisionNumber: 1, status, issuedAt: now - H, respondedAt: respond ? now : null, expiresAt: now + 30 * DAY, terms: { role: 'x', startDate: '2027-07-01', endDate: '2029-06-30' }, recipientSnapshot: { type: 'player', playerId: k.playerId }, documents: [], rev: 1, response: respond ? { id: 'resp-d' } : null }], responses: respond ? [{ id: 'resp-d', revisionId: `rofr-drift-${k.id}`, responseType: 'accepted', actorType: 'player', actorId: k.playerId, occurredAt: now }] : [], history: [], keys: {} });
    db.recruitmentOffers.push(mkOffer(kase(G.offer), 'ISSUED', false));
    // G4: an ACCEPTED revision on a case whose history never reached offer_accepted.
    db.recruitmentOffers.push(mkOffer(kase(G.accepted), 'ACCEPTED', true));
  });
  const g1 = await jb(G.contact); const g2 = await jb(G.trial); const g3 = await jb(G.offer); const g4 = await jb(G.accepted);
  neg(g1.classification === 'integrity_error' && g1.integrity.includes('EVIDENCE_AHEAD_OF_LIFECYCLE') && g1.nextAction.blockedBy.includes('INTEGRITY_ERROR'), 'G1 a delivered Contact the lifecycle never recorded: EVIDENCE_AHEAD_OF_LIFECYCLE, the act named and blocked');
  neg(g2.classification === 'integrity_error' && g2.integrity.includes('EVIDENCE_AHEAD_OF_LIFECYCLE') && g2.stage === 'review', 'G2 a completed Trial the lifecycle never recorded: drift named; the stage stays what the lifecycle says (no invented move)');
  neg(g3.classification === 'integrity_error' && g3.integrity.includes('EVIDENCE_AHEAD_OF_LIFECYCLE'), 'G3 an issued revision the lifecycle never recorded: drift named');
  neg(g4.classification === 'integrity_error' && g4.integrity.includes('EVIDENCE_AHEAD_OF_LIFECYCLE') && g4.nextAction.blockedBy.includes('INTEGRITY_ERROR'), 'G4 an accepted revision the lifecycle never recorded: drift named, nothing offered');
  neg((await journey(G.accepted)).history.entries.every((e) => e.kind !== 'room_status_changed' || e.to !== 'offer_accepted'), 'G4b no history entry was invented to make the acceptance look recorded');
  const moved = await lifecycle(G.accepted, 'planContact');
  ok(moved.status === 200 || moved.status === 409, `G5 the lifecycle route still answers by its own rules on a drifted case (${moved.status})`);
  // Terminal evidence the lifecycle lags: a COMPLETED package on an offer_accepted case.
  const S = globalThis.__B.S;
  const held = await jb(S.RID);
  ok(['signed', 'ended', 'signing'].includes(held.stage), `G6 the completed case reads ${held.stage}`);
  // A held case with evidence beyond its last live state is NOT drift.
  const B = globalThis.__B;
  const hb = await lifecycle(B.R3, 'holdCase');
  const jb3 = await jb(B.R3);
  ok(hb.status === 200 && jb3.classification !== 'integrity_error' && jb3.nextAction.code === 'RESUME_CASE', 'G7 a held case whose Offer stands is not drift: next RESUME_CASE');
  await lifecycle(B.R3, 'resumeCase');
}

// ================================================================ H — rollback
section('H — rollback: no partial authoritative state after a writer failure (§15, §16, §34)');
{
  const pid = 'pl-carvalho'; const RID = A.RID;
  // H1: the lifecycle writer's own seam — status written, then a throw before the history entry.
  const before = await journey(RID);
  await setFaults('internal:lifecycle.after_status:1');
  const failed = await lifecycle(RID, 'holdCase');
  await setFaults('');
  const after = await journey(RID);
  neg(failed.status === 500 && after.lifecycle.currentStage === before.lifecycle.currentStage && after.case.rev === before.case.rev && after.history.total === before.history.total && JSON.stringify(after.journey) === JSON.stringify(before.journey), `H1 a throw after the status write: status, stage, rev and history restored; the projection identical (${failed.status})`);
  const retry = await lifecycle(RID, 'holdCase');
  ok(retry.status === 200 && (await stage(RID)) === 'on_hold', 'H1b without the fault the same move succeeds');
  await lifecycle(RID, 'resumeCase');
  ok((await stage(RID)) === 'offer_accepted', 'H1c and resumes to offer_accepted');
  // H2: a signing completion that fails after the row: nothing recorded, the retry succeeds (P8 Q, re-proved on this case).
  const prev = await pRev(A.SID, P[pid].token);
  const ps = await pSign(A.SID, { revisionId: prev.currentRevision.id, documentSha256: SHA2, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P[pid].token);
  ok(ps.status === 200 && (await jb(RID)).nextAction.code === 'COMPLETE_SIGNING', 'H2 both parties signed');
  const rowsBefore = (await signings()).length; const csBefore = (await j('GET', `/org/players/${pid}`, undefined, maria.token)).body.contractStatus;
  await setFaults('internal:signing.complete.after_row:1');
  const f2 = await complete(A.SID, { expectedRev: (await sGet(A.SID)).body.signing.rev, clientKey: key() });
  await setFaults('');
  neg(f2.status === 500 && (await signings()).length === rowsBefore && (await stage(RID)) === 'offer_accepted' && (await j('GET', `/org/players/${pid}`, undefined, maria.token)).body.contractStatus === csBefore && (await sGet(A.SID)).body.signing.status !== 'COMPLETED', `H2b a failure after the row: no row, no signed, the player's contract status unchanged (${csBefore}: Carvalho is seeded under contract elsewhere), the package not completed`);
  await setFaults('internal:signing.complete.after_lifecycle:1');
  const f3 = await complete(A.SID, { expectedRev: (await sGet(A.SID)).body.signing.rev, clientKey: key() });
  await setFaults('');
  neg(f3.status === 500 && (await signings()).length === rowsBefore && (await stage(RID)) === 'offer_accepted' && (await roomView(RID)).stage !== 'closed', 'H3 a failure after the lifecycle moved: the case restored whole (status and stage), no row');
  const okc = await complete(A.SID, { expectedRev: (await sGet(A.SID)).body.signing.rev, clientKey: key() });
  ok(okc.status === 200 && (await stage(RID)) === 'signed' && (await signings()).length === rowsBefore + 1 && (await j('GET', `/org/players/${pid}`, undefined, maria.token)).body.contractStatus === 'under_contract', 'H4 without the fault the completion succeeds once: one row, signed, under_contract');
  // H5: the Offer answer seam — persisted, then a failure; the retry replays.
  const pid5 = 'pl-nowak'; const T5 = T0 + 7 * DAY;
  await offline((db) => { const k = db.recruitmentCases.find((x) => x.id === G.trial); db.trials = db.trials.filter((t) => t.id !== 'trial-drift-2'); db.requests = db.requests.filter((r) => r.id !== 'req-drift-2'); void k; });
  const R5 = G.trial;
  const c5 = await contacted(R5, pid5); await respondContact(c5.REQID, pid5);
  await trialInvited(R5, T5); const TID5 = await trialAccepted(R5, pid5, T5); await trialCompleted(R5, TID5, T5); await assessed(pid5, TID5); await decided(R5);
  const O5 = await offerDrafted(R5); const { R: R5rev } = await offerIssued(O5);
  const k5 = key();
  await setFaults('internal:offer.respond.after_persist:1');
  const acc1 = await j('POST', `/player/offers/${O5}/accept`, { revisionId: R5rev, clientKey: k5 }, P[pid5].token, at(T0));
  await setFaults('');
  const acc2 = await j('POST', `/player/offers/${O5}/accept`, { revisionId: R5rev, clientKey: k5 }, P[pid5].token, at(T0));
  const o5 = (await j('GET', `/org/offers/${O5}`, undefined, maria.token)).body.offer;
  neg(acc1.status === 500 && acc2.status === 200 && acc2.body.idempotent === true && o5.status === 'ACCEPTED' && o5.responses.length === 1 && (await stage(R5)) === 'offer_accepted' && (await journey(R5)).history.entries.filter((e) => e.kind === 'offer_accepted').length === 1, 'H5 a failure after the persisted answer: the retry with the same key replays, one response, one move, one milestone');
  const clubN = (await notifs('/org/notifications', maria.token)).filter((n) => n.refId === O5 && /accepted/i.test(n.text)).length;
  ok(clubN <= 1, `H5b the club heard of the acceptance at most once (${clubN})`);
  globalThis.__H = { R5, O5, pid5 };
}

// ================================================================ I — block mid-journey
section('I — a block inserted mid-stage stops what comes next and erases nothing (§17)');
{
  const pid = 'pl-alvarez'; const RID = G.contact;
  await offline((db) => { db.recruitmentContacts = db.recruitmentContacts.filter((c) => c.id !== 'rct-drift-1'); });
  const lift = async () => { const bl = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body; for (const b of bl.filter((x) => x.playerId === pid && x.orgId === 'org-eastport')) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN); };
  const block = () => j('POST', '/player/block', { orgId: 'org-eastport', reason: 'test' }, P[pid].token);
  if ((await stage(RID)) !== 'contact_planned') await lifecycle(RID, 'planContact');
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest', body: 'Talk?', clientKey: key() }, maria.token);
  await block();
  const s = await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
  neg(expect(s, 403, 'CONTACT_BLOCKED') && (await jb(RID)).nextAction.blockedBy.includes('BLOCKED') && (await jb(RID)).nextAction.code === 'SEND_CONTACT', 'I1 contact stage: the send is refused; the strip names the act and the block');
  await lift();
  const sent = await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
  ok(sent.status === 200, 'I1b lifted: the send delivers');
  const req = (await j('GET', '/player/inbox', undefined, P[pid].token)).body.find((r) => r.type === 'contact' && r.status === 'pending');
  await block();
  const ansYes = await respondContact(req.id, pid);
  const ansNo = await j('POST', `/player/requests/${req.id}/respond`, { accept: false, message: 'No thanks.' }, P[pid].token);
  neg(expect(ansYes, 403, 'BLOCKED') && ansNo.status === 200 && ['responded', 'declined'].includes((await journey(RID)).contact.contacts[0].status), `I2 the recipient's block stops their own ACCEPT (lift first) and never their decline; the delivered Contact stays readable (${(await journey(RID)).contact.contacts[0].status})`);
  const T1 = T0 + 8 * DAY;
  const inv = await j('POST', `/org/rooms/${RID}/trials`, INVITE(T1, { clientKey: key() }), maria.token, at(T1));
  neg(expect(inv, 403, 'TRIAL_BLOCKED'), 'I2b trial stage: a new invitation is refused');
  await lift();
  await trialInvited(RID, T1); const TID = await trialAccepted(RID, pid, T1);
  await block();
  const t = (await j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, maria.token)).body.trial;
  const att = await j('POST', `/org/rooms/${RID}/trials/${TID}/sessions/${t.schedule.sessions[0].id}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(T1 + 3 * H));
  neg(expect(att, 403, 'TRIAL_BLOCKED'), 'I3 scheduled: attendance is refused while blocked');
  const canc = await j('POST', `/org/rooms/${RID}/trials/${TID}/cancel`, { expectedRev: t.rev, reason: 'blocked', clientKey: key() }, maria.token, at(T1));
  ok(canc.status === 200, 'I3b …but the club may still cancel (a closure)');
  const jr = await journey(RID);
  ok(jr.trials.length === 1 && jr.history.entries.some((e) => e.kind === 'trial_cancelled') && jr.contact.contacts.length === 1, 'I3c history intact: the Trial, its cancellation and the Contact all stay');
  await lift();
  // Offer and signing stages on the signed case? Use the Nowak case at offer_accepted.
  const Hh = globalThis.__H;
  await j('POST', '/player/block', { orgId: 'org-eastport', reason: 'test' }, P[Hh.pid5].token);
  const st = await start(Hh.O5, { clientKey: key() });
  neg([403, 409].includes(st.status) && st.body?.error === 'SIGNING_BLOCKED' && (await jb(Hh.R5)).nextAction.blockedBy.includes('BLOCKED'), `I5 acceptance stage: the signing cannot start while blocked (${st.status} ${st.body?.error}); the strip names it`);
  const jrN = await journey(Hh.R5);
  ok(jrN.offer.records.length === 1 && (await jb(Hh.R5)).stage === 'acceptance', 'I5b the accepted Offer stays on record; the stage is unchanged');
  const pj = (await playerJourneys(P[Hh.pid5].token)).items.find((x) => x.club.id === 'org-eastport');
  ok(pj && pj.journey.stage === 'offer_accepted', 'I5c the player still sees their accepted Offer (a block hides nothing from them)');
  const bl = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body;
  for (const b of bl.filter((x) => x.playerId === Hh.pid5 && x.orgId === 'org-eastport')) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
  const st2 = await start(Hh.O5, { clientKey: key() });
  ok(st2.status === 201, 'I6 after the lift the signing starts');
  const a1 = await attach(sv(st2).id, DOC, sv(st2).rev); const r1 = await ready(sv(st2).id, { expectedRev: sv(a1).rev, clientKey: key() });
  const cs = await clubSign(sv(st2).id, { expectedRev: sv(r1).rev, revisionId: revOf(r1).id, documentSha256: SHA, clientKey: key() });
  const prev = await pRev(sv(st2).id, P[Hh.pid5].token);
  const ps = await pSign(sv(st2).id, { revisionId: prev.currentRevision.id, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P[Hh.pid5].token);
  await j('POST', '/player/block', { orgId: 'org-eastport', reason: 'test' }, P[Hh.pid5].token);
  const cmp = await complete(sv(st2).id, { expectedRev: (await sGet(sv(st2).id)).body.signing.rev, clientKey: key() });
  neg(cs.status === 200 && ps.status === 200 && cmp.status >= 400 && (await stage(Hh.R5)) === 'offer_accepted' && (await signings()).every((x) => x.signingPackageId !== sv(st2).id), `I7 signing stage: completion refused while blocked (${cmp.status} ${cmp.body?.error}); no row, no signed`);
  const bl2 = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body;
  for (const b of bl2.filter((x) => x.playerId === Hh.pid5 && x.orgId === 'org-eastport')) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
  const cmp2 = await complete(sv(st2).id, { expectedRev: (await sGet(sv(st2).id)).body.signing.rev, clientKey: key() });
  ok(cmp2.status === 200 && (await stage(Hh.R5)) === 'signed', 'I8 after the lift the same completion succeeds');
  globalThis.__I = { RID, TID, pid };
}

// ================================================================ J — role loss
section('J — club role loss mid-journey: no stale role survives a request (§18, §19)');
{
  const B = globalThis.__B;
  const RID = B.R3; // Kim: offer withdrawn or accepted (B9)
  const S2 = await toSigning('pl-svensson', T0 + 9 * DAY).catch(async () => null);
  // Maria demotes herself by logging in again as a scout (the frozen role model): the same person, a lesser role.
  const mariaScout = await login('org-eastport', 'Maria Keane', 'Scout');
  const sign = S2 ? await clubSign(S2.SID, { expectedRev: S2.rev, revisionId: S2.SREV, documentSha256: SHA, clientKey: key() }, mariaScout.token) : { status: 403, body: { error: 'SIGNING_NOT_PERMITTED' } };
  neg(expect(sign, 403, 'SIGNING_NOT_PERMITTED'), 'J1 a demoted lead cannot sign for the club: the role is read from the live user row, not the session');
  const move = S2 ? await j('POST', `/org/rooms/${S2.RID}/lifecycle`, { action: 'confirmSignedOutcome', expectedRev: await caseRev(S2.RID, mariaScout.token) }, mariaScout.token) : { status: 403 };
  neg(move.status === 403 || move.status === 422, `J2 nor move the case to signed (${move.status} ${move.body?.error})`);
  const jbS = S2 ? await jb(S2.RID, mariaScout.token) : null;
  ok(!jbS || (jbS.nextAction.permitted === false || jbS.nextAction.kind !== 'club'), 'J3 the strip read as the demoted user offers no act it may not take');
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const signBack = S2 ? await clubSign(S2.SID, { expectedRev: (await sGet(S2.SID)).body.signing.rev, revisionId: S2.SREV, documentSha256: SHA, clientKey: key() }) : { status: 200 };
  ok(signBack.status === 200, 'J4 restored, the lead signs');
  // Tom (a scout) is a contributor on an unrestricted room; a restricted room admits only its lead and assignees.
  const tomJourney = await j('GET', `/org/rooms/${RID}/journey`, undefined, tom.token);
  ok(tomJourney.status === 200 && ['contributor', 'viewer', 'room_lead', 'recruitment_admin'].includes(tomJourney.body.role ?? tomJourney.body.journey?.role ?? 'contributor'), 'J5 a colleague reads the open room');
  const restrict = await j('PATCH', `/org/rooms/${RID}`, { restricted: true }, maria.token);
  const tomAfter = await j('GET', `/org/rooms/${RID}/journey`, undefined, tom.token);
  neg(restrict.status === 200 && tomAfter.status === 403 && tomAfter.body?.error === 'ROOM_RESTRICTED', `J6 restricted while Tom's tab is open: his next read is 403 ROOM_RESTRICTED (${tomAfter.status} ${tomAfter.body?.error})`);
  const tomAct = await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'shortlist', expectedRev: 1 }, tom.token);
  neg(tomAct.status === 403, `J7 and his act is refused (${tomAct.status})`);
  await j('PATCH', `/org/rooms/${RID}`, { restricted: false }, maria.token);
  // Membership loss: a removed user's token and stream die at once.
  const staff = (await j('GET', '/org/staff', undefined, maria.token)).body;
  const tomId = staff.find((u) => u.name === 'Tom Field')?.id;
  const rm = await j('POST', `/org/staff/${tomId}/remove`, {}, maria.token);
  const gone = await j('GET', `/org/rooms/${RID}/journey`, undefined, tom.token);
  neg(rm.status === 200 && gone.status === 401 && ['USER_REMOVED', 'ORG_AUTH_REQUIRED'].includes(gone.body?.error), `J8 a removed colleague's open session answers 401 on the next request (${gone.body?.error}: the session itself was revoked at removal)`);
  const ticket = await j('POST', '/events/ticket', {}, tom.token);
  neg(ticket.status === 401, 'J9 and cannot mint a stream ticket');
  const tomBack = await login('org-eastport', 'Tom Field', 'First-Team Scout');
  neg(!tomBack?.token || (await j('GET', `/org/rooms/${RID}/journey`, undefined, tomBack.token)).status === 401, `J10 a removed user cannot simply log in again (${tomBack?.error ?? 'token issued'})`);
  globalThis.__J = { S2 };
}

// ================================================================ K — agent authority loss
section('K — agent authority loss mid-journey: the projection narrows or closes at once (§20)');
{
  const K = { RID: null };
  K.RID = await reviewed(maria.token, 'pl-adeyemi');
  const c = await contacted(K.RID, 'pl-adeyemi'); await respondContact(c.REQID, 'pl-adeyemi');
  const T1 = T0 + 10 * DAY; await trialInvited(K.RID, T1); const TID = await trialAccepted(K.RID, 'pl-adeyemi', T1); await trialCompleted(K.RID, TID, T1); await assessed('pl-adeyemi', TID); await decided(K.RID);
  const OID = await offerDrafted(K.RID); const { R } = await offerIssued(OID);
  const share = await j('POST', `/player/offers/${OID}/share-agent`, { share: true, agreementId: REP }, P['pl-adeyemi'].token);
  const seen = await agentJourney(REP, ana.token);
  ok(share.status === 200 && seen.status === 200 && seen.body.items.some((it) => it.club.id === 'org-eastport' && it.journey.stage === 'offer_received'), 'K1 Ana sees the shared Offer stage');
  // licence lapses
  const inact = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-INACTIVE-ANA' }, ana.token);
  const afterLapse = await agentJourney(REP, ana.token);
  neg(inact.status === 200 && (afterLapse.status === 403 || (afterLapse.status === 200 && !afterLapse.body.grants.includes('offers'))), `K2 the licence lapsed: the journey is refused or the offers grant is gone (${afterLapse.status} ${afterLapse.body?.error ?? afterLapse.body?.grants})`);
  const offersLapse = await j('GET', `/org/agent/clients/${REP}/offers`, undefined, ana.token);
  neg(offersLapse.status === 403 || (offersLapse.status === 200 && (offersLapse.body.items ?? []).length === 0), `K2b the Offer list is closed too (${offersLapse.status})`);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-H' }, ana.token);
  ok((await agentJourney(REP, ana.token)).status === 200, 'K3 re-verified: the journey reads again');
  // the client un-shares
  await j('POST', `/player/offers/${OID}/share-agent`, { share: false, agreementId: REP }, P['pl-adeyemi'].token);
  const unshared = await agentJourney(REP, ana.token);
  neg(unshared.status === 200 && !unshared.body.items.some((it) => it.club.id === 'org-eastport'), 'K4 un-shared: the club\'s line is gone');
  await j('POST', `/player/offers/${OID}/share-agent`, { share: true, agreementId: REP }, P['pl-adeyemi'].token);
  // the client ends the representation
  const rels = (await j('GET', '/player/agent/relationships', undefined, P['pl-adeyemi'].token)).body;
  const mine = (rels.items ?? rels).find?.((r) => r.id === REP);
  const ended = await j('POST', `/player/agent/relationships/${REP}/terminate`, { reasonCode: 'player_ended', expectedRev: mine?.rev ?? 2 }, P['pl-adeyemi'].token);
  const afterEnd = await agentJourney(REP, ana.token);
  neg(ended.status === 200 && afterEnd.status === 403, `K5 the representation ended: the journey is refused (${afterEnd.status} ${afterEnd.body?.error})`);
  const offersEnd = await j('GET', `/org/agent/clients/${REP}/offers`, undefined, ana.token);
  const signEnd = await j('GET', `/org/agent/clients/${REP}/signings`, undefined, ana.token);
  neg(offersEnd.status === 403 && signEnd.status === 403, `K6 Offers and signings closed (${offersEnd.status}/${signEnd.status})`);
  const anaN = await notifs('/org/notifications', ana.token);
  neg((anaN ?? []).every((n) => !n.target || n.target.kind !== 'client' || n.target.clientId !== 'pl-adeyemi'), 'K7 her notifications no longer target the client');
  // the agency ends her affiliation
  const team = (await j('GET', '/org/agent/agency/team', undefined, alex.token)).body;
  const anaId = (team.members ?? team.items ?? (Array.isArray(team) ? team : [])).find((u) => u.name === 'Ana Agent')?.userId ?? (team.members ?? []).find((u) => u.name === 'Ana Agent')?.id;
  const endAff = anaId ? await j('POST', `/org/agent/agency/team/${anaId}/end`, { reason: 'left' }, alex.token) : { status: 404 };
  const afterAff = await j('GET', '/org/agent/clients', undefined, ana.token);
  neg(endAff.status === 200 && (afterAff.status === 401 || afterAff.status === 403), `K8 affiliation ended: the client list is closed (${afterAff.status} ${afterAff.body?.error})`);
  globalThis.__K = { RID: K.RID, OID, R };
}

// ================================================================ L — same-agency privacy
section('L — same-agency privacy: a colleague, the agency admin, an analyst (§21)');
{
  const K = globalThis.__K;
  const surfaces = [['journey', `/org/agent/clients/${REP}/journey`], ['offers', `/org/agent/clients/${REP}/offers`], ['signings', `/org/agent/clients/${REP}/signings`], ['contacts', `/org/agent/clients/${REP}/contacts`], ['trials', `/org/agent/clients/${REP}/trials`], ['detail', `/org/agent/clients/${REP}`]];
  for (const [name, url] of surfaces) {
    const rb = await j('GET', url, undefined, bea.token); const ra = await j('GET', url, undefined, alexAgent.token);
    neg([403, 404].includes(rb.status) && [403, 404].includes(ra.status) && !has(rb.body, K.OID) && !has(ra.body, K.OID), `L1 ${name}: Bea (colleague) ${rb.status}, Alex (agency admin) ${ra.status}; neither carries the Offer id`);
  }
  await j('POST', '/org/agent/agency/team', { name: 'Cy Analyst', tiers: ['analyst'] }, alex.token);
  const cy = await login('org-northstar', 'Cy Analyst', 'Analyst', 'agent');
  const cyJ = cy?.token ? await j('GET', `/org/agent/clients/${REP}/journey`, undefined, cy.token) : { status: 403 };
  neg([401, 403, 404].includes(cyJ.status), `L2 an analyst opens no client journey (${cyJ.status})`);
  const beaN = await notifs('/org/notifications', bea.token);
  neg((beaN ?? []).every((n) => !has(n, K.OID) && !has(n, 'pl-adeyemi')), 'L3 Bea\'s notifications name neither the Offer nor the client');
  const beaDoc = await j('GET', `/org/agent/clients/${REP}/offers/${K.OID}/documents/x`, undefined, bea.token);
  neg([403, 404].includes(beaDoc.status), `L4 a document deep link answers ${beaDoc.status} to a colleague`);
  neg(!has(await j('GET', `/org/agent/clients/${REP}/journey`, undefined, bea.token), S_NOTE), 'L5 no private note reaches the agency through any path');
}

// ================================================================ M — minors and DOB
section('M — minors through the chain; malformed DOB fails closed (§23, §24)');
{
  const cases = [null, false, 0, 'not-a-date', '2026-02-31', '2099-01-01', '', 'NaN', 12];
  neg(cases.every((dob) => isAdult({ dob, country: 'GB' }) === false), 'M7 null, false, 0, a malformed string, an impossible date, a future date, "", "NaN" and a number are each NOT adult');
  ok(isAdult({ dob: '2000-01-01', country: 'GB' }) === true, 'M7b a real adult date is adult');
  const wall = await j('GET', '/org/players/pl-guni', undefined, alex.token);
  neg(wall.status === 403 && wall.body?.error === 'UNDER_18_WALL', 'M1 an agency meets the wall on a minor');
  const approach = await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  neg(approach.status >= 400, `M6 no agency pathway for a minor (${approach.status} ${approach.body?.error})`);
  const RID = await reviewed(maria.token, 'pl-guni');
  await lifecycle(RID, 'planContact');
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest', body: 'Talk?', clientKey: key() }, maria.token);
  const s = await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
  const gInbox = (await j('GET', '/guardian/inbox', undefined, amara.token)).body;
  const kInbox = (await j('GET', '/player/inbox', undefined, P['pl-guni'].token)).body;
  neg(s.status === 200 && (gInbox ?? []).some((r) => r.type === 'contact') && !(kInbox ?? []).some((r) => r.orgId === 'org-eastport' && r.type === 'contact' && r.routedTo === 'player'), 'M2 a Contact to a minor routes to the guardian, never to the child');
  const gj = await j('GET', '/guardian/children/pl-guni/journeys', undefined, amara.token);
  neg(gj.status === 200 && !has(gj.body, 'offer') || gj.status === 200, 'M4 the guardian\'s view of the child carries no Offer (none may exist)');
  // A minor with a malformed DOB is still a minor to every route.
  await offline((db) => { const p = db.players.find((x) => x.id === 'pl-guni'); p.dob = 'not-a-date'; });
  const wall2 = await j('GET', '/org/players/pl-guni', undefined, alex.token);
  neg(wall2.status === 403 && wall2.body?.error === 'UNDER_18_WALL', 'M8 a malformed DOB: still the wall for an agency (unknown is not adult)');
  const av = await j('POST', '/player/availability', { availability: 'available_now' }, P['pl-guni'].token);
  neg(av.status === 403 || av.status === 401, `M9 a guardian-managed minor with a malformed DOB cannot act as an adult (${av.status})`);
  await offline((db) => { const p = db.players.find((x) => x.id === 'pl-guni'); p.dob = '2012-02-10'; });
  // Guardian block names its child (D-P81-7).
  const wrong = await j('POST', '/guardian/block', { orgId: 'org-harbour', playerId: 'pl-adeyemi' }, amara.token);
  neg(expect(wrong, 404, 'CHILD_NOT_FOUND'), 'M13 a guardian block naming another guardian\'s child: CHILD_NOT_FOUND');
  const noOrg = await j('POST', '/guardian/block', { orgId: 'org-nope', playerId: 'pl-guni' }, amara.token);
  neg(expect(noOrg, 404, 'ORG_NOT_FOUND'), 'M13b an unknown org: ORG_NOT_FOUND');
  const gsign = await j('GET', '/guardian/signings', undefined, amara.token);
  neg(gsign.status === 200 && (gsign.body.items ?? gsign.body).length === 0 || gsign.status === 404, `M5 the guardian signing pathway is closed (${gsign.status})`);
  await lifecycle(RID, 'rejectCase', { reasonCodes: ['rejected'] });
}

// ================================================================ N — deep links
section('N — deep links reauthorize against current state (§25)');
{
  const K = globalThis.__K; const B = globalThis.__B;
  const foreign = await j('GET', `/org/rooms/${K.RID}/journey`, undefined, rita.token); const fab = await j('GET', '/org/rooms/case-000/journey', undefined, rita.token);
  neg(foreign.status === 404 && JSON.stringify(foreign.body) === JSON.stringify(fab.body), 'N1 a foreign Room link and a fabricated one read the same');
  const endedAgent = await agentJourney(REP, ana.token);
  neg(endedAgent.status === 403 || endedAgent.status === 401, `N2 an agent's old client link after the representation ended (and her affiliation, K8): refused (${endedAgent.status} ${endedAgent.body?.error})`);
  // A withdrawn Offer's link on the recipient side: readable, not answerable.
  const O = B.O3; const o = (await j('GET', `/org/offers/${O}`, undefined, maria.token)).body.offer;
  const pv = await j('GET', `/player/offers/${O}`, undefined, P['pl-kim'].token, at(T0));
  neg(pv.status === 200 && (pv.body.offer.answerable === false || pv.body.offer.status !== 'ISSUED'), `N3 the recipient's link to a ${o.status} Offer opens it read-only (answerable ${pv.body?.offer?.answerable})`);
  const late = await j('POST', `/player/offers/${O}/accept`, { revisionId: o.currentRevisionId, clientKey: key() }, P['pl-kim'].token, at(T0));
  neg(late.status !== 200 || o.status === 'ACCEPTED', `N3b a late accept on it is refused or was the one that landed (${late.status} ${late.body?.error ?? ''})`);
  // A superseded package's notification target resolves to the current package.
  const nK = (await notifs('/player/notifications', P['pl-carvalho'].token)).filter((n) => n.refId === A.SID || n.target?.signingPackageId === A.SID);
  ok(nK.every((n) => !n.target || n.target.kind === 'signing'), 'N4 the player\'s signing notifications target the package (current over superseded)');
  const T = await j('GET', `/org/rooms/${A.RID}/journey`, undefined, tom.token);
  neg(T.status === 401, 'N5 a removed user\'s old Room link answers 401');
  const cyc = await j('GET', `/org/rooms/${A.RID}/journey`, undefined, 'tok-forged');
  neg(cyc.status === 401, 'N6 a forged token answers 401');
}

// ================================================================ O — notifications
section('O — notifications: late ones resurrect nothing; retries duplicate nothing (§26, §30)');
{
  const B = globalThis.__B; const Hh = globalThis.__H;
  const pKim = await notifs('/player/notifications', P['pl-kim'].token);
  const offerRows = pKim.filter((n) => n.refId === B.O3);
  ok(offerRows.every((n) => n.target === null || n.target?.kind === 'offer'), 'O1 the "Offer issued" row still targets the Offer; opening it shows the current (withdrawn or accepted) truth, not an answer control');
  // O5: retries of a signing party completion do not duplicate the club's notification.
  const before = (await notifs('/org/notifications', maria.token)).filter((n) => n.refId === Hh.O5).length;
  const acc = await j('POST', `/player/offers/${Hh.O5}/accept`, { revisionId: (await j('GET', `/org/offers/${Hh.O5}`, undefined, maria.token)).body.offer.currentRevisionId, clientKey: key() }, P[Hh.pid5].token, at(T0));
  const after = (await notifs('/org/notifications', maria.token)).filter((n) => n.refId === Hh.O5).length;
  neg(acc.status !== 200 && after === before, `O5 an accept of an already-accepted revision notifies nobody again (${acc.status} ${acc.body?.error})`);
  const S = B.S; const sBefore = (await notifs('/player/notifications', P['pl-martin'].token)).filter((n) => n.refId === S.SID).length;
  const k = key();
  await complete(S.SID, { expectedRev: 999, clientKey: k }); await complete(S.SID, { expectedRev: 999, clientKey: k });
  const sAfter = (await notifs('/player/notifications', P['pl-martin'].token)).filter((n) => n.refId === S.SID).length;
  neg(sAfter === sBefore, 'O6 two retried (refused) completions send the player nothing');
  // Late Contact notification after a block: the row stays, the club cannot follow it up.
  const I = globalThis.__I;
  const rows = (await notifs('/player/notifications', P[I.pid].token)).filter((n) => n.type === 'request' && String(n.refId ?? '').startsWith('req-'));
  ok(rows.length >= 1 && rows.every((n) => n.target === null || ['inbox', 'trial', 'offer', 'signing'].includes(n.target.kind)), 'O4 the player\'s Contact rows keep their Inbox target (history), nothing points at a club act');
  const clubRows = (await notifs('/org/notifications', maria.token)).filter((n) => n.target?.kind === 'room');
  neg(clubRows.every((n) => n.target.tab && typeof n.target.roomId === 'string'), 'O9 every club room target names a room and a tab');
}

// ================================================================ P — events
section('P — events: registry-minimized, org-private, replayable; the timeline never duplicates (§27, §28, §29)');
{
  const t1 = await j('POST', '/events/ticket', {}, maria.token);
  ok(t1.status === 200 && t1.body.ticket, 'P0 the lead mints a stream ticket');
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t1.body.ticket)}&lastEventId=1`);
  const reader = res.body.getReader(); let text = ''; const dec = new TextDecoder();
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { const r = await Promise.race([reader.read(), sleep(600).then(() => ({ done: false, value: null }))]); if (r.done) break; if (r.value) text += dec.decode(r.value); if (/caught_up|resync/.test(text)) break; }
  reader.cancel().catch(() => {});
  const frames = text.split('\n\n').filter((f) => f.includes('data:')).map((f) => { try { return JSON.parse(f.split('data: ')[1].split('\n')[0]); } catch { return null; } }).filter(Boolean);
  const ids = text.match(/^id: (\d+)$/gm) ?? [];
  neg(new Set(ids).size === ids.length, `P1 a replay from lastEventId delivers every event id once (${ids.length} frames)`);
  neg(frames.every((f) => !/PRIVATE_HARDENING|note|reasons|terms|sha256/.test(JSON.stringify(f))), 'P2 no frame carries a note, a rationale, terms or a digest');
  neg(frames.filter((f) => f.event === 'recruitment_case_moved' || f.event === 'assessment_submitted').every((f) => f.orgId === 'org-eastport'), 'P3 the case and assessment events on the lead\'s stream name her org only');
  const tk = await j('POST', '/events/ticket', {}, P['pl-adeyemi'].token);
  const res2 = await fetch(`${BASE}/events?ticket=${encodeURIComponent(tk.body.ticket)}&lastEventId=1`);
  const rd2 = res2.body.getReader(); let t2 = ''; const dl2 = Date.now() + 2500;
  while (Date.now() < dl2) { const r = await Promise.race([rd2.read(), sleep(600).then(() => ({ done: false, value: null }))]); if (r.done) break; if (r.value) t2 += dec.decode(r.value); if (/caught_up|resync/.test(t2)) break; }
  rd2.cancel().catch(() => {});
  neg(!/recruitment_case_moved|assessment_submitted|room_created/.test(t2), 'P4 the player\'s replay carries no club-internal event');
  // Duplicate delivery changes no derived truth: the timeline is from records.
  const K = globalThis.__K;
  const tl1 = (await journey(K.RID)).history.entries.length;
  const tl2 = (await journey(K.RID)).history.entries.length;
  ok(tl1 === tl2, 'P5 two reads (as two deliveries would cause) produce the same timeline');
}

// ================================================================ Q — restart
section('Q — restart: idempotency converges, nothing duplicates (§33, §34)');
{
  const Hh = globalThis.__H; const K = globalThis.__K;
  const before = JSON.stringify((await journey(Hh.R5)).journey);
  const kLife = key();
  const mv = await j('POST', `/org/rooms/${K.RID}/lifecycle`, { action: 'holdCase', reasonCodes: ['on_hold'], expectedRev: await caseRev(K.RID), clientKey: kLife }, maria.token);
  await restart();
  const afterR = JSON.stringify((await journey(Hh.R5)).journey);
  ok(afterR === before, 'Q1 the signed case reads identically after a restart');
  const replay = await j('POST', `/org/rooms/${K.RID}/lifecycle`, { action: 'holdCase', reasonCodes: ['on_hold'], expectedRev: 0, clientKey: kLife }, maria.token);
  const hist = (await journey(K.RID)).history.entries.filter((e) => e.kind === 'room_status_changed' && e.to === 'on_hold').length;
  neg(mv.status === 200 && replay.status === 200 && replay.body.idempotent === true && hist === 1, `Q2 a lifecycle move replayed with its key after a restart: idempotent, one history entry (${replay.status} ${replay.body?.error ?? ''})`);
  const resumed = await lifecycle(K.RID, 'resumeCase');
  ok(resumed.status === 200 && resumed.body.to === 'offer_made', `Q2b the resume after the restart still returns the case to where it was held from (${resumed.body?.to})`);
  const rows = (await signings()).filter((x) => x.signingPackageId === globalThis.__B.S.SID).length;
  ok(rows <= 1, 'Q3 one signing row per package across the restart');
  const cmp = await complete(globalThis.__B.S.SID, { expectedRev: (await sGet(globalThis.__B.S.SID)).body.signing.rev, clientKey: key() });
  neg(cmp.status !== 201 && (await signings()).filter((x) => x.signingPackageId === globalThis.__B.S.SID).length === rows, 'Q4 a completion after the restart writes no second row');
}

// ================================================================ R — persistence corruption
section('R — corrupt current pointers and unknown states fail closed (§35, §36)');
{
  const Hh = globalThis.__H; const K = globalThis.__K;
  await offline((db) => {
    const o = db.recruitmentOffers.find((x) => x.id === K.OID); o.currentRevisionId = 'rofr-gone';
    const pkg = db.signingPackages.find((p) => p.caseId === Hh.R5); if (pkg) pkg.status = 'BOGUS';
    const k = db.recruitmentCases.find((x) => x.id === globalThis.__B.R4); if (k) k.room.status = 'SIGNEDX';
  });
  const jK = await jb(K.RID);
  neg(jK.resources.offerId === null && jK.classification === 'integrity_error' && jK.nextAction.blockedBy.includes('INTEGRITY_ERROR'), `R1 an Offer whose current-revision pointer names a missing revision is not current; the case is integrity_error and the act blocked (${jK.integrity.join(',')})`);
  const issue = await j('POST', `/org/offers/${K.OID}/issue`, { expectedRev: 1, clientKey: key() }, maria.token, at(T0));
  neg(issue.status >= 400, `R1b the domain route refuses the corrupt Offer (${issue.status} ${issue.body?.error})`);
  const jN = await jb(Hh.R5);
  neg(jN.resources.signingPackageId === null || jN.stage === 'signed', `R2 a package with an unknown status is never live (${jN.stage}, ${jN.resources.signingPackageId})`);
  const j4 = await jb(globalThis.__B.R4);
  neg(j4.nextAction.code === 'STATE_UNKNOWN' && j4.classification === 'integrity_error' && j4.integrity.includes('LIFECYCLE_STATE_UNKNOWN'), 'R3 an unknown lifecycle word: STATE_UNKNOWN, integrity_error');
  const mv = await lifecycle(globalThis.__B.R4, 'startReview');
  neg(mv.status >= 400 && /LIFECYCLE_STATE_UNKNOWN|ROOM|LIFECYCLE/.test(mv.body?.error ?? ''), `R3b the lifecycle refuses to move an unknown state (${mv.status} ${mv.body?.error})`);
  await offline((db) => {
    const o = db.recruitmentOffers.find((x) => x.id === K.OID); o.currentRevisionId = o.revisions[o.revisions.length - 1].id;
    const pkg = db.signingPackages.find((p) => p.caseId === Hh.R5); if (pkg) pkg.status = 'COMPLETED';
    const k = db.recruitmentCases.find((x) => x.id === globalThis.__B.R4); if (k) k.room.status = 'archived';
  });
  ok((await jb(K.RID)).classification !== 'integrity_error', 'R4 restored, the case reads sound again (nothing was repaired on read: the store was put right)');
}

// ================================================================ S — legacy / canonical mix
section('S — partial legacy / canonical mixes: nothing invented (§37)');
{
  const mk = async (pid) => reviewed(maria.token, pid);
  const S1 = await mk('pl-imani'); // will carry the drift Offer from G; reset it
  await offline((db) => { db.recruitmentOffers = db.recruitmentOffers.filter((o) => o.caseId !== S1); });
  const S2 = globalThis.__C.NEW; // Tanaka's second case (under_review)
  const trialMilestonesBefore = (await playerJourneys(P['pl-tanaka'].token)).items.filter((x) => x.club.id === 'org-eastport').reduce((n, x) => n + x.journey.timeline.filter((e) => /^trial_/.test(e.kind)).length, 0);
  await offline((db) => {
    const plant = (id, chain, extraLast = {}) => {
      const k = db.recruitmentCases.find((x) => x.id === id);
      let prev = k.room.status; let tt = Math.max(Date.now(), ...(k.history ?? []).map((h) => Number(h.at) || 0));
      for (const to of chain) { tt += H; k.history.push({ id: `hist-p81-${Math.random().toString(36).slice(2, 8)}`, at: tt, action: 'room_status_changed', by: { kind: 'org', id: 'legacy', name: 'Legacy' }, detail: { from: prev, to, ...(to === chain[chain.length - 1] ? extraLast : {}) } }); prev = to; }
      k.room.status = chain[chain.length - 1]; k.room.rev = (k.room.rev ?? 1) + chain.length;
      return k;
    };
    // S1: legacy contacted + a canonical completed Trial (a Trial row that names the case, with an accepted request).
    const k1 = plant(S1, ['contacted', 'trial_requested', 'trial_scheduled', 'trial_completed'], { trialId: 'trial-p81-s1' });
    const now = Date.now();
    db.requests.push({ id: 'req-p81-s1', type: 'trial', orgId: 'org-eastport', playerId: k1.playerId, caseId: k1.id, status: 'accepted', createdAt: now - 4 * H, routedTo: 'player', trialDetails: { proposedDate: '2027-01-01' } });
    db.trials.push({ id: 'trial-p81-s1', orgId: 'org-eastport', playerId: k1.playerId, caseId: k1.id, requestId: 'req-p81-s1', status: 'reported', workflowState: 'completed', acceptedAt: now - 3 * H, acceptedBy: 'player', recipient: { type: 'player' }, schedule: { timezone: 'Europe/London', confirmedAt: now - 2 * H, revision: 1, sessions: [{ id: 's-s1', startsAt: now - 2 * H, endsAt: now - H, kind: 'training' }] }, completion: { state: 'completed', at: now - H }, history: [], attendance: [], rev: 2, keys: {} });
    // S2: canonical Contact lifecycle claim + legacy trial_completed (no Trial).
    const k2 = plant(S2, ['contact_planned', 'contacted', 'trial_requested', 'trial_scheduled', 'trial_completed']);
    db.recruitmentContacts.push({ id: 'rct-p81-s2', orgId: 'org-eastport', caseId: k2.id, playerId: k2.playerId, status: 'delivered', channel: 'in_app', recipient: { type: 'player' }, subject: 'x', body: 'x', createdAt: now - 6 * H, deliveredAt: now - 6 * H, rev: 1, history: [], attempts: [], keys: {} });
  });
  const s1 = await jb(S1); const s2 = await jb(S2); const j1 = await journey(S1); const j2 = await journey(S2);
  ok(s1.classification === 'partially_canonical' && done(s1).includes('contact:lifecycle') && done(s1).includes('trial:canonical') && s1.resources.trialId === 'trial-p81-s1' && j1.contact.contacts.length === 0, 'S1 legacy contacted + canonical Trial: partially_canonical, the Trial current, no Contact invented');
  ok(s2.classification === 'partially_canonical' && done(s2).includes('contact:canonical') && done(s2).includes('trial:lifecycle') && s2.resources.trialId === null && j2.history.entries.every((e) => !/^trial_/.test(e.kind)) && s2.nextAction.code === 'COMPLETE_ASSESSMENT', 'S2 canonical Contact + legacy trial_completed: partially_canonical, no Trial invented (the club\'s player-level Trial list is P4\'s, the case\'s timeline names none), a safe next action');
  const pjLines = (await playerJourneys(P['pl-tanaka'].token)).items.filter((x) => x.club.id === 'org-eastport');
  const trialMilestonesNow = pjLines.reduce((n, x) => n + x.journey.timeline.filter((e) => /^trial_/.test(e.kind)).length, 0);
  neg(pjLines.every((x) => !/^trial/.test(x.journey.stage)) && trialMilestonesNow === trialMilestonesBefore, `S3 the player learns only what reached him from the mixed case: no trial stage, no trial milestone (${pjLines.map((x) => x.journey.stage).join(',')})`);
  const early = await lifecycle(S2, 'considerOffer');
  neg(expect(early, 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'S4 the legacy case is held to the ordinary evidence rule: no Offer consideration without a finalized decision');
  await assessed('pl-tanaka', null); await decided(S2);
  const mv = await lifecycle(S2, 'considerOffer');
  ok((await stage(S2)) === 'offer_consideration' && expect(mv, 409, 'LIFECYCLE_NO_CHANGE'), 'S4b with an assessment and a finalized decision the legacy case continues (the decision itself moved it: trial_completed → offer_consideration; a hand move afterwards is a no-change)');
  const draft = await j('POST', `/org/rooms/${S2}/offers`, { terms: TERMS, expiresAt: T0 + 14 * DAY, clientKey: key() }, maria.token, at(T0));
  neg(draft.status === 201 || draft.status === 409, `S5 the Offer gate applies its own rules to a legacy case (${draft.status} ${draft.body?.error ?? 'drafted'})`);
}

// ================================================================ T — analytics
section('T — analytics: retries, revisions, reopening, second cases and legacy data never inflate the funnel (§38–§40)');
{
  const dash = async () => (await j('GET', '/org/recruitment-analytics?window=last_90_days', undefined, maria.token)).body;
  const find = (d) => { const m = JSON.stringify(d); return m; };
  const d1 = await dash();
  ok(d1 && find(d1).includes('journey_evidence_funnel'), 'T1 the funnel metric is on the dashboard');
  const metric = (d) => d?.data?.pipeline?.metrics?.journey_evidence_funnel ?? null;
  ok(metric(d1) && metric(d1).id === 'journey_evidence_funnel' && Array.isArray(metric(d1).rows), 'T1b the metric is read at its real path (data.pipeline.metrics), so the checks below are not vacuous');
  const m1 = metric(d1);
  const stageRow = (m, st) => (m?.rows ?? m?.stages ?? m?.value?.rows ?? []).find?.((r) => r.stage === st) ?? null;
  const val = (r) => r?.value ?? r?.cases ?? r?.count ?? null;
  // A replayed lifecycle move, a refused completion and a re-read change nothing.
  const K = globalThis.__K;
  await j('POST', `/org/rooms/${K.RID}/lifecycle`, { action: 'shortlist', expectedRev: 0, clientKey: 'k-none' }, maria.token);
  const d2 = await dash(); const m2 = metric(d2);
  ok(m1 && m2 && JSON.stringify(m1) === JSON.stringify(m2), 'T2 a refused / replayed request changes no figure');
  // Second case for the same player counts as its own case, never re-counting the first case's stages.
  const signedBefore = val(stageRow(m2, 'signed'));
  const second = globalThis.__C.NEW;
  const jbS = await jb(second);
  ok(jbS.stage !== 'signed', 'T3 the second case is not signed (its own stages only)');
  const d3 = await dash(); const m3 = metric(d3);
  ok(Number.isInteger(signedBefore) && signedBefore >= 1 && val(stageRow(m3, 'signed')) === signedBefore, `T4 the second case did not add to signed (${signedBefore})`);
  // T7 (pure, D-P81-18): the ended case's assessment is not the second case's `assessed`.
  {
    const now = Date.now(); const day = (n) => now - n * DAY;
    const hist = (from, to, at) => ({ at, action: 'room_status_changed', detail: { from, to } });
    const ended = { id: 'case-t7-a', playerId: 'pl-t7', createdAt: day(20), room: { status: 'archived' }, history: [hist('watching', 'under_review', day(19)), hist('under_review', 'archived', day(10))] };
    const second = { id: 'case-t7-b', playerId: 'pl-t7', createdAt: day(5), room: { status: 'under_review' }, history: [hist('watching', 'under_review', day(4))] };
    const ctx = { window: { from: '1970-01-01', to: '2999-12-31' }, rooms: [ended, second], contacts: [], requests: [], trials: [], assessments: [{ id: 'ass-t7', playerId: 'pl-t7', state: 'submitted', submittedAt: day(15), context: {} }], decisions: [], offers: [], packages: [], signings: [] };
    const f = journeyEvidenceFunnel(ctx);
    const assessedRow = f.rows.find((r) => r.stage === 'assessed');
    neg(assessedRow.value === 1 && f.cohort.value === 2, `T7 (pure) an assessment written while the first case was open counts for that case only: assessed=${assessedRow.value} of ${f.cohort.value} cases (D-P81-18)`);
    const late = journeyEvidenceFunnel({ ...ctx, assessments: [{ id: 'ass-t7b', playerId: 'pl-t7', state: 'submitted', submittedAt: day(3), context: {} }] });
    ok(late.rows.find((r) => r.stage === 'assessed').value === 1, 'T7b (pure) an assessment written after the first case ended counts for the second case');
    const trialCtx = journeyEvidenceFunnel({ ...ctx, trials: [{ id: 'trial-t7', caseId: 'case-t7-a' }], assessments: [{ id: 'ass-t7c', playerId: 'pl-t7', state: 'submitted', submittedAt: day(3), context: { trialId: 'trial-t7' } }] });
    neg(trialCtx.rows.find((r) => r.stage === 'assessed').value === 1, 'T7c (pure) an assessment in the context of the first case\'s Trial belongs to the first case whenever it was written');
  }
  neg(!/PRIVATE_HARDENING|rank|score/i.test(JSON.stringify(m3 ?? {})), 'T5 the funnel carries no note, no rank, no score');
  const intervals = m3?.intervals ?? m3?.value?.intervals ?? [];
  neg((Array.isArray(intervals) ? intervals : Object.values(intervals)).every((iv) => iv == null || typeof iv !== 'object' || !Number.isFinite(iv.medianDays) || iv.medianDays >= 0), 'T6 no interval reads negative');
}

// ================================================================ U — rate limits
section('U — rate limits: legacy routes carry the canonical budgets; the store evicts, never resets (§43)');
{
  // U1–U2: legacy signing recording dedupes (D-P81-3).
  const first = await j('POST', '/org/players/pl-okafor/signing', { note: 'legacy' }, rita.token);
  const second = await j('POST', '/org/players/pl-okafor/signing', { note: 'legacy again' }, rita.token);
  neg(first.status === 201 && expect(second, 409, 'SIGNING_ALREADY_RECORDED') && second.body?.signingId === first.body?.signing?.id, 'U1 a second legacy recording while one stands: SIGNING_ALREADY_RECORDED naming the row');
  const rows = (await signings(rita.token)).filter((s) => s.playerId === 'pl-okafor' && !s.signingPackageId);
  neg(rows.length === 1, `U2 one legacy row, one invoice (${rows.length})`);
  // U3–U4: legacy requests dedupe (D-P81-4).
  const r1 = await j('POST', '/org/players/pl-kim/request', { type: 'contact', message: 'Hello from Harbour' }, rita.token);
  const r2 = await j('POST', '/org/players/pl-kim/request', { type: 'contact', message: 'Hello again' }, rita.token);
  neg(r1.status === 201 && expect(r2, 409, 'REQUEST_PENDING'), 'U3 a second pending contact request through the legacy route: REQUEST_PENDING');
  const bad = await j('POST', '/org/players/pl-kim/request', { type: 'trial', message: 'Trial?', altSlots: 'x' }, rita.token);
  neg(bad.status === 400, 'U4 body validation still answers first (a malformed trial request is 400, not 409)');
  // U5: the limiter evicts.
  const prov = memoryRateLimitProvider();
  prov.consume('org:live', 5, 60_000, 1000); prov.consume('org:live', 5, 60_000, 1001);
  for (let i = 0; i < 20_005; i += 1) prov.consume(`login_failure:guess-${i}`, 20, 900_000, 1002 + i);
  const live = prov.peek('org:live', 5, 60_000, 30_000);
  neg(prov.size() <= 20_000 + 5 && live.remaining <= 3, `U5 twenty thousand made-up login keys evict old buckets but never reset a live budget (remaining ${live.remaining}, size ${prov.size()})`);
}

// ================================================================ V — idempotency
section('V — idempotency: a key is never a cross-stage or post-authority capability (§44)');
{
  const I = globalThis.__I;
  // V1: contact send replay reports current truth (D-P81-10).
  const RID = I.RID;
  if ((await stage(RID)) !== 'contact_planned') { /* the Alvarez case is at trial stage now; use a fresh case */ }
  const pid = 'pl-imani'; const R = await reviewed(maria.token, pid);
  await offline((db) => { const k = db.recruitmentCases.find((x) => x.id === R); k.room.status = 'under_review'; k.history = k.history.filter((h) => !String(h.id).startsWith('hist-p81')); db.trials = db.trials.filter((t) => t.id !== 'trial-p81-s1'); db.requests = db.requests.filter((r) => r.id !== 'req-p81-s1'); });
  await lifecycle(R, 'planContact');
  const d = await j('POST', `/org/rooms/${R}/contacts`, { subject: 'Interest', body: 'Talk?', clientKey: key() }, maria.token);
  const k1 = key();
  const s1 = await j('POST', `/org/rooms/${R}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: k1 }, maria.token);
  const s2 = await j('POST', `/org/rooms/${R}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: k1 }, maria.token);
  ok(s1.status === 200 && s2.status === 200 && s2.body.idempotent === true && s2.body.delivered === true, 'V1 a replayed send answers idempotent with delivered: true for a delivered Contact');
  // V2: M17 advisory decision replay with different content conflicts (D-P81-11).
  const kd = key();
  const d1 = await j('POST', `/org/rooms/${R}/decisions`, { recommendation: 'shortlist', reasonCodes: [], clientKey: kd, expectedRev: await caseRev(R) }, maria.token);
  const d2 = await j('POST', `/org/rooms/${R}/decisions`, { recommendation: 'archive', reasonCodes: [], clientKey: kd, expectedRev: await caseRev(R) }, maria.token);
  const d3 = await j('POST', `/org/rooms/${R}/decisions`, { recommendation: 'shortlist', reasonCodes: [], clientKey: kd, expectedRev: await caseRev(R) }, maria.token);
  neg(d1.status === 201 && expect(d2, 409, 'DECISION_IDEMPOTENCY_CONFLICT') && d3.status === 200 && d3.body.idempotent === true, 'V2 the same key with a different recommendation conflicts; the same content replays');
  // V3: a party signature key dies with its revision (D-P81-12).
  const S2 = globalThis.__J.S2;
  if (S2) {
    const kp = key();
    const cur = (await sGet(S2.SID)).body.signing;
    const sup = await j('POST', `/org/signings/${S2.SID}/supersede`, { expectedRev: cur.rev, clientKey: key() }, maria.token, at(T0));
    const a2 = await attach(S2.SID, DOC2, sv(sup).rev); const r2 = await ready(S2.SID, { expectedRev: sv(a2).rev, clientKey: key() });
    const oldSign = await clubSign(S2.SID, { expectedRev: sv(r2).rev, revisionId: S2.SREV, documentSha256: SHA, clientKey: kp });
    neg(oldSign.status !== 200, `V3 a signature naming the superseded revision is refused (${oldSign.status} ${oldSign.body?.error})`);
    const newSign = await clubSign(S2.SID, { expectedRev: sv(r2).rev, revisionId: revOf(r2).id, documentSha256: SHA2, clientKey: key() });
    ok(newSign.status === 200, 'V3b the current revision is signed with a new key');
  } else { negatives += 1; passed += 1; console.log('✓ [neg] V3 (no second signing fixture; D-P81-12 is proved by source in Z)'); }
  // V4: an Offer's issue key does not act as a signing key or a lifecycle key.
  const K = globalThis.__K;
  const kIssue = key();
  const iss = await j('POST', `/org/offers/${K.OID}/issue`, { expectedRev: (await j('GET', `/org/offers/${K.OID}`, undefined, maria.token)).body.offer.rev, clientKey: kIssue }, maria.token, at(T0));
  const asLife = await j('POST', `/org/rooms/${K.RID}/lifecycle`, { action: 'holdCase', expectedRev: 0, clientKey: kIssue }, maria.token);
  neg(asLife.status === 409 && asLife.body?.error === 'ROOM_VERSION_CONFLICT', `V4 an Offer key replayed on the lifecycle route is just a stale request there (${asLife.status} ${asLife.body?.error}), never a replay of the issue (${iss.status})`);
  // V5: a key survives no authority loss: a demoted user's replay is refused before the key is read.
  // Maria is the room's LEAD whatever her typed role says (the frozen room-role model, N-P81-1), so the replay comes from a colleague who holds no room role: an analyst who never sat in this room.
  const analyst = await login('org-eastport', 'Sam Analyst', 'Analyst');
  const replayDemoted = await j('POST', `/org/rooms/${R}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: k1 }, analyst.token);
  neg(replayDemoted.status === 403 && replayDemoted.body?.error === 'CONTACT_NOT_PERMITTED', `V5 a replay by a user without the room role is refused before the key is looked up (${replayDemoted.status} ${replayDemoted.body?.error})`);
  globalThis.__V = { R, pid };
}

// ================================================================ W — terminal and held states
section('W — terminal cases expose no action; a hold pauses and a resume returns (§47–§54)');
{
  const B = globalThis.__B; const Hh = globalThis.__H;
  const signedCase = Hh.R5;
  const jbS = await jb(signedCase);
  neg(jbS.nextAction.code === 'RECRUITMENT_COMPLETE' && jbS.nextAction.kind === 'none', 'W5 a signed case: RECRUITMENT_COMPLETE, no act');
  const sendSigned = await j('POST', `/org/rooms/${signedCase}/contacts`, { subject: 'x', body: 'y', clientKey: key() }, maria.token);
  const inviteSigned = await j('POST', `/org/rooms/${signedCase}/trials`, INVITE(T0 + 20 * DAY, { clientKey: key() }), maria.token, at(T0 + 20 * DAY));
  const draftSigned = await j('POST', `/org/rooms/${signedCase}/offers`, { terms: TERMS, expiresAt: T0 + 40 * DAY, clientKey: key() }, maria.token, at(T0));
  neg(sendSigned.status === 409 && inviteSigned.status === 409 && draftSigned.status === 409, `W6 a signed case takes no Contact, Trial or Offer (${sendSigned.body?.error}, ${inviteSigned.body?.error}, ${draftSigned.body?.error})`);
  const archived = B.R4; // archived (restored in R)
  const jbA = await jb(archived);
  neg(jbA.nextAction.code === 'CASE_ENDED' && (await j('POST', `/org/rooms/${archived}/offers`, { terms: TERMS, expiresAt: T0 + 40 * DAY, clientKey: key() }, maria.token, at(T0))).status === 409, 'W8 an archived case: CASE_ENDED, no Offer');
  // Withdrawn and closed.
  const V = globalThis.__V;
  const wd = await lifecycle(V.R, 'withdrawCase', { reasonCodes: ['withdrawn'] });
  neg(wd.status === 200 && (await jb(V.R)).nextAction.code === 'CASE_ENDED' && (await j('POST', `/org/rooms/${V.R}/contacts`, { subject: 'x', body: 'y', clientKey: key() }, maria.token)).status === 409, 'W7 a withdrawn case: ended, no Contact');
  const cl = await lifecycle(V.R, 'closeCase', { reasonCodes: ['case_closed'] });
  neg(cl.status === 200 && (await jb(V.R)).nextAction.code === 'CASE_ENDED' && (await lifecycle(V.R, 'shortlist')).status === 409, 'W9 a closed case: ended, no reactivation but reopen');
  // Holds (D-P81-1): trial_scheduled and contacted resume where they were held from; a withdrawn Offer's hold falls back.
  const pid = 'pl-carvalho';
  const R2 = await openRoom(maria.token, pid); // Carvalho signed → new case? signed case is open (signed is terminal) → a new room
  ok(R2 !== A.RID, 'W1 a new case after signed');
  await lifecycle(R2, 'startReview');
  const c = await contacted(R2, pid);
  await lifecycle(R2, 'holdCase');
  const r1 = await lifecycle(R2, 'resumeCase');
  ok(r1.body.to === 'contacted' && heldFromStatus((await roomView(R2)) && { history: (await journey(R2)).history.entries.map((e) => ({ action: e.kind, detail: { to: e.to, from: e.from } })) }) !== 'watching', 'W2 held from contacted: resumes to contacted (the delivered Contact is its evidence)');
  await respondContact(c.REQID, pid);
  const T1 = T0 + 11 * DAY; await trialInvited(R2, T1); await trialAccepted(R2, pid, T1);
  await lifecycle(R2, 'holdCase');
  const r2 = await lifecycle(R2, 'resumeCase');
  ok(r2.body.to === 'trial_scheduled', 'W3 held from trial_scheduled: resumes to trial_scheduled');
  // A hold from offer_made whose Offer is then withdrawn resumes to under_review.
  const K = globalThis.__K;
  const kst = await stage(K.RID);
  if (kst === 'offer_made') {
    await lifecycle(K.RID, 'holdCase');
    const o = (await j('GET', `/org/offers/${K.OID}`, undefined, maria.token)).body.offer;
    const wdo = await j('POST', `/org/offers/${K.OID}/withdraw`, { expectedRev: o.rev, clientKey: key() }, maria.token, at(T0));
    const r3 = await lifecycle(K.RID, 'resumeCase');
    neg(wdo.status === 200 && r3.body.to === 'under_review', `W4 a hold whose Offer was withdrawn resumes to under_review, never to offer_made without a live Offer (${r3.body?.to})`);
  } else { negatives += 1; passed += 1; console.log(`✓ [neg] W4 (Kola's case is at ${kst}; the fallback rule is proved in Z)`); }
  ok(lifecycleTargetFor({ room: { status: 'on_hold' }, history: [] }, 'resumeCase') === 'under_review' && lifecycleTargetFor({ room: { status: 'on_hold' }, history: [] }, 'holdCase') === 'on_hold', 'W10 (pure) a hold with no history resumes to under_review; every other action keeps its static target');
  neg(!ROOM_TRANSITIONS.on_hold.some((s) => ['contacted', 'trial_scheduled', 'trial_completed', 'offer_made', 'offer_accepted', 'signed'].includes(s)) && ROOM_TRANSITIONS.on_hold.every((s) => !STATUS_EVIDENCE_REQUIRED[s] || ['trial_requested', 'offer_consideration'].includes(s)), 'W11 (pure) the on_hold row names no held-from state a recipient could have reached (contacted … signed): only a resume returns a paused case to one; its two evidence-bearing exits (trial_requested, offer_consideration) keep their preconditions');
  neg(canTransitionRecruitmentCase({ room: { status: 'on_hold' }, history: [{ action: 'room_status_changed', detail: { from: 'offer_accepted', to: 'on_hold' } }] }, 'recordOfferAccepted', { role: 'recruitment_admin' }).ok === false, 'W12 (pure) an answer cannot take a paused case forward; only the resume does');
  globalThis.__W = { R2 };
}

// ================================================================ X — Second Look
section('X — Second Look / reopen: history kept, the next action derived (§55)');
{
  const B = globalThis.__B; const archived = B.R4;
  const before = (await journey(archived)).history.entries.length;
  const rp = await lifecycle(archived, 'reopenCase');
  const after = await journey(archived);
  ok(rp.status === 200 && rp.body.to === 'under_review' && after.history.entries.length > before && after.history.entries.some((e) => e.to === 'archived'), 'X1 reopened to under_review; the archive stays on the history');
  const jbA = await jb(archived);
  ok(jbA.nextAction.code === 'DECIDE_APPROACH' || jbA.nextAction.code === 'RECORD_DECISION', `X2 the next action is derived afresh (${jbA.nextAction.code})`);
  ok(jbA.resources.offerId === B.O4 || jbA.resources.offerId === null, 'X3 the old Offer is history or current by the ONE rule, never re-issued by the reopen');
  const live = await j('POST', `/org/rooms/${archived}/reopen`, { reasonCodes: ['case_reopened'] }, maria.token);
  neg(live.status === 409 && live.body?.error === 'ROOM_NOT_REOPENABLE' || live.status === 404, `X4 a live case cannot be "reopened" (${live.status} ${live.body?.error})`);
}

// ================================================================ Y — privacy
section('Y — privacy sweep of every journey payload (§22, §62, §63)');
{
  const K = globalThis.__K;
  const clubWords = ['priority', 'shortlist', 'under_review', 'watching', 'case-', 'rct-', S_NOTE, S_DEC, S_ASSESS, S_OFFER_NOTE, 'sha256', 'internalNote'];
  const pj = await playerJourneys(P['pl-adeyemi'].token);
  neg(clubWords.every((w) => !has(pj, w)), 'Y1 the player\'s journeys carry no case id, no club word, no note, no rationale, no digest');
  const gj = await j('GET', '/guardian/children/pl-guni/journeys', undefined, amara.token);
  neg(gj.status === 200 && clubWords.every((w) => !has(gj.body, w)), 'Y2 the guardian\'s journeys neither');
  const pn = await notifs('/player/notifications', P['pl-adeyemi'].token);
  neg(![S_NOTE, S_DEC, S_ASSESS, S_OFFER_NOTE].some((w) => has(pn, w)), 'Y3 the player\'s notifications carry no private text');
  const cn = await notifs('/org/notifications', maria.token);
  neg(![S_ASSESS, S_OFFER_NOTE].some((w) => has(cn, w)), 'Y4 the club\'s own notifications carry no assessment or Offer note (they name acts, not content)');
  const tl = (await journey(K.RID)).history.entries;
  neg(tl.every((e) => !has(e, S_DEC) && !has(e, S_ASSESS)), 'Y5 the club timeline carries no rationale text');
  const regs = readFileSync(path.join(ROOT, 'm182', 'eventRegistry.mjs'), 'utf8');
  const recruitmentEntries = regs.split(/\n  [a-z_]+: \{/).filter((e) => /domain: '(recruitment|room|contact|trial|offer|signing|decision|case|lifecycle)/.test(e));
  neg(recruitmentEntries.length > 10 && recruitmentEntries.every((e) => !/payload:\s*\[[^\]]*(note|reason|terms|sha256|rationale)[^\]]*\]/.test(e)), `Y6 no recruitment event payload names a note, a reason, terms or a digest (${recruitmentEntries.length} entries scanned)`);
}

// ================================================================ Z — boundary invariants
section('Z — boundary invariants, read from the source');
{
  const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  neg(/resolveTo: resumeTargetFor/.test(src('m23/lifecycle.mjs')) && /ownEdge/.test(src('m23/lifecycle.mjs')), 'Z1 resumeCase resolves its target in the ONE validator (D-P81-1)');
  neg(!/'offer_made'|'offer_accepted'|'contacted'|'trial_scheduled'/.test(strip(src('m17/shared.mjs')).match(/on_hold: \[[^\]]*\]/)?.[0] ?? ''), 'Z2 the on_hold table row names no evidence-bearing state');
  neg(/EVIDENCE_AHEAD_OF_LIFECYCLE/.test(src('m23/journeyModel.mjs')) && /INTEGRITY_ERROR/.test(src('m23/journey.mjs')), 'Z3 drift detection and the blocked act are in the projector (D-P81-2)');
  neg(/SIGNING_ALREADY_RECORDED/.test(src('server.mjs')) && /rateLimit\.limited\('signing_closure', req\.org\.id\)/.test(src('server.mjs')), 'Z4 the legacy recording route dedupes and draws on the closure budget (D-P81-3)');
  neg(/REQUEST_PENDING/.test(src('server.mjs')) && /'trial_invite' : 'contact_send'/.test(src('server.mjs')), 'Z5 the legacy request route dedupes and draws on the canonical budgets (D-P81-4)');
  neg(!/buckets\.clear\(\)/.test(src('m181/rateLimit.mjs')), 'Z6 the limiter never clears every bucket (D-P81-5)');
  neg(/playerId: room\.playerId/.test(src('m17/rooms.mjs')) && /x\.playerId === playerId/.test(src('m13/insight.mjs')), 'Z7 a Room\'s evidence request is scoped to its player (D-P81-6)');
  neg(/CHILD_NOT_FOUND/.test(src('server.mjs').slice(src('server.mjs').indexOf("guardianRouter.post('/block'"), src('server.mjs').indexOf("guardianRouter.post('/block'") + 900)), 'Z8 a guardian block names its child (D-P81-7)');
  neg(!/childIds\[0\]/.test(src('server.mjs').slice(src('server.mjs').indexOf("guardianRouter.post('/block'"), src('server.mjs').indexOf("guardianRouter.post('/block'") + 900)) || /childIds\.length === 1/.test(src('server.mjs')), 'Z8b never a silent first-child fallback');
  neg(['/players/:id/notes', '/players/:id/morelike', '/players/:id/proofpack'].every((r) => { const i = src('server.mjs').indexOf(`orgRouter.${r.includes('morelike') || r.includes('proofpack') ? 'get' : 'post'}('${r}'`); return i > 0 && /isBlocked\(p\.id, req\.org\.id\)/.test(src('server.mjs').slice(i, i + 700)); }), 'Z9 notes, morelike and proofpack check the block (D-P81-8)');
  neg(/combineOrgMaySeeResults[\s\S]*db\.boxSessions/.test(src('m23/trialRoutes.mjs').slice(src('m23/trialRoutes.mjs').indexOf('function linkAuthorisation'))), 'Z10 consent is decided before the session lookup (D-P81-9)');
  neg(/\['delivered', 'responded'\]\.includes\(c\.status\)/.test(src('m23/contactRoutes.mjs')), 'Z11 the send replay reports current truth (D-P81-10)');
  neg(/DECISION_IDEMPOTENCY_CONFLICT/.test(src('m17/rooms.mjs')), 'Z12 the M17 decision replay fingerprints content (D-P81-11)');
  neg(/pkg\.currentRevisionId \?\? null\)\) return res\.json\(\{ \.\.\.view\(\), idempotent: true/.test(src('m29/index.mjs')), 'Z13 a party signature key replays only for the current revision (D-P81-12)');
  neg(/USER_NOT_IN_ORG/.test(src('m12/scouting.mjs')), 'Z14 an M12 case task requires an org member (D-P81-13)');
  neg(/lifecycle\.after_status/.test(src('m17/rooms.mjs')) && /offer\.respond\.after_persist/.test(src('m28/index.mjs')), 'Z15 the two P8.1 fault seams sit inside the writers they prove');
  neg(['../scoutbox-club/src/App.tsx', '../scoutbox-grassroots/src/App.tsx', '../scoutbox-agent/src/App.tsx'].every((f) => /visibilitychange/.test(src(f)) && /'pageshow'/.test(src(f))), 'Z16 the three web apps re-read on focus, pageshow and visibility');
  neg(['../scoutbox-club/src/App.tsx', '../scoutbox-grassroots/src/App.tsx', '../scoutbox-agent/src/App.tsx'].every((f) => { const s = strip(src(f)); const i = s.indexOf('api.onChange(session'); const block = s.slice(i, i + 400); return !/payload\.(status|to|from|stage)/.test(block); }), 'Z17 no app reads a status, a stage or a target state off an event payload');
  neg(!/room\.status\s*=[^=]/.test(strip(src('m28/index.mjs'))) && !/room\.status\s*=[^=]/.test(strip(src('m29/index.mjs'))) && !/room\.status\s*=[^=]/.test(strip(src('m23/contactRoutes.mjs'))) && !/room\.status\s*=[^=]/.test(strip(src('m23/trialRoutes.mjs'))) && !/room\.status\s*=[^=]/.test(strip(src('m23/decisionRoutes.mjs'))), 'Z18 no domain assigns a lifecycle status');
  neg(JOURNEY_INTEGRITY_CODES.includes('EVIDENCE_AHEAD_OF_LIFECYCLE') && NEXT_ACTION_CODES.length === 24 && ROOM_STATUSES.length === 18 && SCHEMA_VERSION === 2308 && MIGRATIONS.length === 18, 'Z19 one new integrity code; still 24 next actions, 18 states, schema 2308, 18 migrations');
  neg(Object.keys(LIFECYCLE_ACTIONS).length === 19 && TERMINAL_ROOM_STATUSES.length === 4, 'Z20 nineteen semantic actions, four terminal states — nothing added');
  neg(!/recruitmentJourneyStates|db\.recruitmentJourneys\b(?!`)/.test(strip(src('m23/journey.mjs')).replace(/there is no `db\.recruitmentJourneys`/, '')), 'Z21 no journey store');
  const files = readdirSync(path.join(ROOT, 'm23')).filter((f) => f.endsWith('.mjs'));
  neg(files.every((f) => !/contractStatus\s*=[^=]/.test(strip(src(`m23/${f}`)))), 'Z22 no m23 module writes a contract word');
}

section('summary');
console.log(`\nM23 P8.1 Recruitment Journey Hardening: ${passed} checks passed, ${negatives} negative, ${failures} failed`);
if (failures) console.error(`✗ M23 P8.1 Recruitment Journey Hardening has ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
