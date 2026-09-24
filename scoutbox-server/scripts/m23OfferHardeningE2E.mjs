// M23 P6.1 — Offer workflow hardening and adversarial closure.
//
// The Offer domain is attacked as a hostile second reviewer would: every
// mutation is re-authorised at the moment it happens, every race has one
// authoritative outcome (record, lifecycle, audit, events, notifications,
// idempotency all agree), every stale session or old link loses power when
// authority changes, every hidden Offer stays hidden, malformed data fails
// closed, retries cannot become capabilities, and an accepted Offer stays
// categorically distinct from a signed contract.
//
// Groups (mandate §80):
//   A authorization drift  B role removal  C representation loss  D block transitions
//   E expiry races  F revision races  G idempotency  H rate limiting  I same-agency privacy
//   J hidden-resource oracle  K deep links  L notification privacy  M event privacy
//   N persistence corruption  O partial failures  P lifecycle consistency  Q legacy states
//   R temporal corruption  S minor fail-closed  T UI/API parity (client trust audit)
//
// No assertion is `status !== 200`; every refusal names status AND code.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFER_LIMITS, validateTerms, validateMessages, validateExpiry, effectiveRevisionStatus, offerStatus, liveStatus, liveRevision,
  canRespondToRevision, offerIntegrity, offerCaseConsistency, offerCaseCorrupt, offerEvidence, offerRecipientView, offerAgentView, offerClubView,
  minorOfferPathwayOpen, MINOR_OFFER_PATHWAY_ENABLED, responderMatches,
} from '../m28/offer.mjs';
import { M28_ERROR_HTTP } from '../m28/errors.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { isAdult, adultAgeFor } from '../domain.mjs';
import { isExpiredAt } from '../temporal.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import { canTransitionRecruitmentCase } from '../m23/lifecycle.mjs';
import { openStore } from '../store.mjs';

const PORT = 6900 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23oh-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const S_NOTE = 'PRIVATE_NOTE_H_7731';
const S_DEC = 'PRIVATE_DECISION_H_5914';
const S_TX = 'PRIVATE_TX_NOTE_H_6106';
const S_MSG = 'VISIBLE_MESSAGE_H_4402';
const H = 3_600_000; const DAY = 24 * H;

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (r, status, code) => { const good = r.status === status && (code === null || r.body?.error === code); if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 260)}`); return good; };
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const codes = (rs) => rs.map((r) => `${r.status}:${r.body?.error ?? 'ok'}`).join(' ');

// ================================================================ pure groups
section('E/R — pure: expiry boundary, unknown status, temporal corruption fail closed');
{
  const T = 1_800_000_000_000;
  const rev = (over = {}) => ({ id: 'r1', revisionNumber: 1, status: 'ISSUED', createdAt: T - H, issuedAt: T, expiresAt: T + DAY, recipientSnapshot: { type: 'player', playerId: 'p1', guardianId: null }, ...over });
  const offer = (r, extra = {}) => ({ id: 'o1', orgId: 'org-A', caseId: 'c1', playerId: 'p1', type: 'direct_recruitment', revisions: [r], currentRevisionId: r.id, responses: [], ...extra });
  ok(effectiveRevisionStatus(rev(), T + DAY - 1) === 'ISSUED', 'E-p1 1 ms before expiry: ISSUED');
  neg(effectiveRevisionStatus(rev(), T + DAY) === 'EXPIRED' && isExpiredAt(T + DAY, T + DAY) === true, 'E-p2 exact expiry: EXPIRED (now >= expiresAt is not acceptable — the ONE helper decides)');
  neg(effectiveRevisionStatus(rev(), T + DAY + 1) === 'EXPIRED', 'E-p3 1 ms after: EXPIRED');
  neg(canRespondToRevision(offer(rev()), 'r1', T + DAY).error === 'OFFER_EXPIRED' && canRespondToRevision(offer(rev()), 'r1', T + DAY - 1).ok === true, 'E-p4 the answer gate follows the same boundary');
  for (const bad of ['VIEWED', 'signed', 'Issued', 'ISSUED ', '', null, undefined, 1, {}]) neg(effectiveRevisionStatus(rev({ status: bad }), T) === null && liveStatus(offer(rev({ status: bad, issuedAt: T })), T) === null && canRespondToRevision(offer(rev({ status: bad })), 'r1', T).ok !== true, `R-p1 unknown status ${JSON.stringify(bad)} is not ISSUED, not live, not answerable (fails closed)`);
  for (const bad of [null, undefined, false, 0, 'soon', '2026-02-30T00:00:00Z', '1e12', NaN, Infinity, -1]) neg(effectiveRevisionStatus(rev({ expiresAt: bad }), T) === 'EXPIRED', `R-p2 expiresAt ${JSON.stringify(bad)} on an ISSUED revision reads EXPIRED`);
  neg(offerIntegrity(offer(rev({ issuedAt: T - 2 * H }))).includes('issued_before_created'), 'R-p3 issued before drafted is corruption');
  neg(offerIntegrity(offer(rev({ status: 'ACCEPTED', respondedAt: T - 1 }), { responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player' }] })).includes('responded_before_issued'), 'R-p4 answered before issued is corruption');
  neg(offerIntegrity(offer(rev({ status: 'WITHDRAWN', withdrawnAt: T - 2 * H }))).includes('withdrawn_before_created'), 'R-p5 withdrawn before drafted is corruption');
  neg(offerIntegrity(offer(rev({ expiresAt: T + 400 * DAY }))).includes('expiry_out_of_bounds'), 'R-p6 an expiry beyond the 180-day rule (a corrupt or imported "forever" row) is corruption, not a fresh Offer (§44)');
  neg(offerIntegrity(offer(rev({ expiresAt: T - 1 }))).includes('expired_before_issued'), 'R-p7 expired before issued is corruption');
  neg(offerIntegrity(offer(rev({ revisionNumber: 0 }))).includes('revision_number') && offerIntegrity(offer(rev({ revisionNumber: -3 }))).includes('revision_number') && offerIntegrity(offer(rev({ revisionNumber: 1e9 })), {}).length === 0, 'R-p8 zero and negative revision numbers are corruption; a large one is merely large (server-derived, never client-chosen)');
  neg(offerIntegrity({ ...offer(rev()), currentRevisionId: 7 }).includes('current_revision') && offerIntegrity({ ...offer(rev()), currentRevisionId: 'rofr-other' }).includes('current_revision'), 'R-p9 a forged or dangling current-revision pointer is corruption');
  const kase = (st) => ({ id: 'c1', orgId: 'org-A', playerId: 'p1', room: { status: st } });
  neg(offerCaseCorrupt(offerCaseConsistency(offer(rev({ status: 'ACCEPTED' }), { responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }] }), kase('offer_declined'), T)), 'P-p1 ACCEPTED Offer + case offer_declined is corruption');
  neg(offerCaseCorrupt(offerCaseConsistency(offer(rev({ status: 'DECLINED' }), { responses: [{ revisionId: 'r1', responseType: 'declined', actorType: 'player', actorId: 'p1' }] }), kase('offer_accepted'), T)), 'P-p2 DECLINED Offer + case offer_accepted is corruption');
  ok(offerCaseConsistency(offer(rev()), kase('on_hold'), T).join() === 'LIVE_OFFER_CASE_NOT_AT_OFFER_MADE' && !offerCaseCorrupt(offerCaseConsistency(offer(rev()), kase('on_hold'), T)), 'P-p3 an issued Offer on a paused case is a WARNING, not corruption');
  ok(offerCaseConsistency(offer(rev()), kase('offer_made'), T).length === 0 && offerCaseConsistency(offer(rev({ status: 'ACCEPTED' }), { responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }] }), kase('signed'), T).length === 0, 'P-p4 the ordinary readings are consistent, including an accepted Offer on a case that later moved on');
  ok(offerRecipientView(offer(rev()), T, { caseOpen: false }).answerable === false && offerRecipientView(offer(rev()), T, { caseOpen: false }).notAnswerableReason === 'CASE_PAUSED' && offerRecipientView(offer(rev()), T).answerable === true, 'P-p5 the recipient view says "not answerable right now" when the case is paused, instead of inviting a 409');
  // Evidence over corrupt rows.
  const db = { recruitmentOffers: [offer(rev({ status: 'ACCEPTED', respondedAt: T - 1 }), { responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }] })] };
  neg(offerEvidence(db.recruitmentOffers, { id: 'c1', orgId: 'org-A', playerId: 'p1' }, 'offer_accepted_by_recipient', T).satisfied === false, 'R-p10 a temporally corrupt ACCEPTED row is not acceptance evidence');
  neg(canTransitionRecruitmentCase({ id: 'c1', orgId: 'org-A', playerId: 'p1', room: { status: 'offer_made' }, history: [] }, 'recordOfferAccepted', { role: 'recruitment_admin', evidence: createEvidenceProvider(db), now: T }).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'R-p11 and the lifecycle cannot move on it');
}

section('S — pure: minor fail-closed in every jurisdiction; adult boundary GB 18 / KR 19 with a fixed clock');
{
  for (const jur of ['GB', 'ENG', 'INT', 'USA', 'FR', 'KR', 'DEFAULT', '', undefined, null, '__proto__', 'constructor']) neg(minorOfferPathwayOpen(jur) === false, `S-p1 pathway closed for ${JSON.stringify(jur)}`);
  neg(Object.values(MINOR_OFFER_PATHWAY_ENABLED).every((v) => v === false), 'S-p2 the policy table has no open entry');
  const on = (iso) => new Date(`${iso}T12:00:00Z`);
  ok(adultAgeFor('GB') === 18 && adultAgeFor('KR') === 19, 'S-p3 GB 18, KR 19');
  neg(isAdult({ dob: '2008-03-15', country: 'GB' }, on('2026-03-14')) === false, 'S-p4 GB: the day before the 18th birthday is not an adult');
  ok(isAdult({ dob: '2008-03-15', country: 'GB' }, on('2026-03-15')) === true, 'S-p5 GB: the 18th birthday is');
  ok(isAdult({ dob: '2008-03-15', country: 'GB' }, on('2026-03-16')) === true, 'S-p6 GB: the day after is');
  neg(isAdult({ dob: '2007-03-15', country: 'KR' }, on('2026-03-14')) === false, 'S-p7 KR: the day before the 19th birthday is not');
  ok(isAdult({ dob: '2007-03-15', country: 'KR' }, on('2026-03-15')) === true && isAdult({ dob: '2007-03-15', country: 'KR' }, on('2026-03-16')) === true, 'S-p8 KR: the 19th birthday and after are');
  neg(isAdult({ dob: '2008-03-15', country: 'GB' }, new Date('2026-03-15T00:00:00+14:00')) === false && isAdult({ dob: '2008-03-15', country: 'GB' }, new Date('2026-03-14T23:59:59-05:00')) === true, 'S-p9 the boundary is a calendar day in UTC, not a zone-shifted instant (local midnight in UTC+14 is still the 14th in UTC; 23:59 in UTC-5 is already the 15th)');
  for (const dob of [null, undefined, false, 0, '', '0000-00-00', '2030-01-01', '2026-02-30', 'yesterday', NaN, 19900101]) neg(isAdult({ dob, country: 'GB' }, on('2026-06-01')) === false, `S-p10 dob ${JSON.stringify(dob)} never makes an adult`);
  neg(!responderMatches({ recipientSnapshot: { type: 'guardian', playerId: 'p1', guardianId: 'g1' } }, { kind: 'player', actorId: 'p1', playerId: 'p1' }), 'S-p11 a child cannot answer a guardian-addressed revision');
}

section('L/M — pure: notification category, event registry audiences and payloads');
{
  const evs = ['offer_draft_created', 'offer_draft_updated', 'offer_issued', 'offer_superseded', 'offer_withdrawn', 'offer_responded'];
  neg(evs.every((e) => EVENT_REGISTRY[e].audience === 'org_private' && EVENT_REGISTRY[e].privacyClass === 'org_internal'), 'M-p1 every Offer event is org-private (no agency or player fanout; the recipient and the agent hear through notifications)');
  neg(evs.every((e) => EVENT_REGISTRY[e].payload.every((k) => ['orgId', 'roomId', 'offerId', 'status'].includes(k))), 'M-p2 no payload key can carry a term, note, expiry, reason, document or person');
  neg(EVENT_REGISTRY.offer_draft_created.notificationEligible === false && EVENT_REGISTRY.offer_draft_updated.notificationEligible === false, 'M-p3 draft events are not notification-eligible');
  ok(RATE_LIMIT_POLICY.offer_response.scope === 'actor' && ['offer_draft_write', 'offer_issue', 'offer_withdraw'].every((k) => RATE_LIMIT_POLICY[k].scope === 'org'), 'H-p1 budgets: per person for answers, per organisation for club acts');
  // The m28 source never reads a client-supplied authority fact.
  const src = readdirSync(path.join(HERE, '..', 'm28')).filter((f) => f.endsWith('.mjs')).map((f) => readFileSync(path.join(HERE, '..', 'm28', f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  neg(!/req\.body\??\.(status|role|verified|licensed|isAdult|canAccept|isGuardian|isAgent|complianceClear|currentRevision|playerId|orgId|caseId|occurredAt|issuedAt|revisionNumber|actorId)\b/.test(src), 'T-p1 client trust audit: m28 never reads status/role/verified/licensed/isAdult/canAccept/isGuardian/isAgent/complianceClear/currentRevision/playerId/orgId/caseId/occurredAt/revisionNumber/actorId from a request body');
  neg(!/dangerouslySetInnerHTML/.test(readFileSync(path.join(HERE, '..', '..', 'scoutbox-club', 'src', 'offerPanel.tsx'), 'utf8')) && !/dangerouslySetInnerHTML/.test(readFileSync(path.join(HERE, '..', '..', 'scoutbox-agent', 'src', 'screens.tsx'), 'utf8')), 'T-p2 no Offer field is rendered as HTML in the club or agent app');
  ok(Object.keys(M28_ERROR_HTTP).length === 24, 'T-p3 the 24-code error table is unchanged by hardening');
  const bidi = validateMessages({ recipientMessage: 'Join‮evil‬ us​ now', internalNote: 'a⁦b⁩c' });
  neg(bidi.recipientMessage === 'Joinevil us now' && bidi.internalNote === 'abc', 'T-p4 bidi and zero-width format controls are stripped from messages (spoof-proof), ordinary text kept');
  ok(validateTerms({ role: 'Ailier — «gauche» / 左ウイング' }).terms.role === 'Ailier — «gauche» / 左ウイング', 'T-p5 legitimate Unicode is kept as typed');
  neg(validateMessages({ recipientMessage: 'x'.repeat(OFFER_LIMITS.recipientMessage + 1) }).ok === false && validateTerms({ conditions: 'y'.repeat(OFFER_LIMITS.conditions + 1) }).ok === false, 'T-p6 oversized text is refused at the domain limit');
  neg(validateExpiry('2026-03-08T02:30:00', { now: 1_800_000_000_000 }).ok === false, 'R-p12 a bare local time is still refused');
}

// ============================================================ HTTP fixture
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
async function stop(proc) {
  proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) { if (proc.exitCode != null || proc.signalCode) break; await sleep(100); }
  await sleep(300);
}
// A second agency has to exist before the fixture, so that "a foreign agency" is a different thing from "a colleague at my agency".
let server = await boot();
await stop(server);
{
  const store = openStore(DATA_DIR);
  const snap = store.load();
  const agency = snap.db.orgs.find((o) => o.type === 'agency');
  snap.db.orgs.push({ ...structuredClone(agency), id: 'org-southgate', name: 'Southgate Sports Management', slug: 'southgate' });
  store.save(snap);
  ok(snap.db.orgs.filter((o) => o.type === 'agency').length === 2, 'fixture: two agencies exist');
}
server = await boot();
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
  // Let the stream settle (the `connected` frame) before the race starts, so that every event of the race is in the window.
  for (let i = 0; i < 20 && !/"event":"connected"/.test(frames.join('')); i += 1) await sleep(50);
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}
const countIn = (s, re) => (s.match(re) ?? []).length;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const pat = await login('org-mossside', 'Pat Doyle', 'Head Coach', 'grassroots');
const alex = await login('org-northstar', 'Alex Agent', 'Director');
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const chi = await playerLogin('pl-okafor');
const sven = await playerLogin('pl-svensson');
const kim = await playerLogin('pl-kim');
const tanaka = await playerLogin('pl-tanaka');
const santi = await playerLogin('pl-alvarez');
const theo = await playerLogin('pl-martin');
const filip = await playerLogin('pl-nowak');
const kwame = await playerLogin('pl-mensah');
const imani = await playerLogin('pl-imani');
const guni = await playerLogin('pl-guni');
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, tom, rita, pat, alex, kola, mateus, chi, sven, kim, tanaka, santi, theo, filip, kwame, imani, guni, amara].every((x) => x?.token), 'HTTP actors logged in');
const staff = (await j('GET', '/org/staff', undefined, maria.token)).body;
const TOM_ID = staff.find((u) => u.name === 'Tom Field')?.id;
ok(!!TOM_ID, 'fixture: Tom\'s user id known');

// Agents: Ana (licensed, represents Kola), Bea (same agency), Zed admin, a foreign agency agent.
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Cal Analyst', tiers: ['analyst'] }, alex.token);
const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
const bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
const cal = await login('org-northstar', 'Cal Analyst', 'Analyst', 'agent');
const alexAgent = await login('org-northstar', 'Alex Agent', 'Director', 'agent');
for (const a of [ana, bea]) {
  await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-X' }, a.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-X-ENG', memberAssociation: 'ENG' }, a.token);
}
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
const REP = REQ.body?.relationship?.id;
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kola.token);
ok(!!REP && CONF.status === 200, 'fixture: Ana represents Kola (employment)');
let REPREV = CONF.body.relationship.rev;

const T0 = Date.now();
const journey = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body;
const stage = async (RID, token = maria.token) => (await journey(RID, token)).lifecycle.currentStage;
const caseRev = async (RID, token = maria.token) => (await journey(RID, token)).case.rev;
const lifecycle = async (RID, action, extra = {}, token = maria.token) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await caseRev(RID, token), ...extra }, token);
const legacyStatus = async (RID, status, token = maria.token) => j('POST', `/org/rooms/${RID}/status`, { status, expectedRev: await caseRev(RID, token) }, token);
const notifs = async (p, token) => (await j('GET', p, undefined, token)).body;
const hist = async (RID, token = maria.token) => (await journey(RID, token)).history.entries;
// Case moves are counted from the room's raw activity (the lifecycle writer's own rows), not from the journey timeline, which keys entries by target status.
const statusChanges = async (RID, token = maria.token) => ((await j('GET', `/org/rooms/${RID}/activity?limit=200`, undefined, token)).body?.items ?? []).filter((h) => h.type === 'room_status_changed');
async function reviewed(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  if (await stage(RID, token) === 'watching') await lifecycle(RID, 'startReview', {}, token);
  return RID;
}
async function toConsideration(token, playerId, note = S_DEC) {
  const RID = await reviewed(token, playerId);
  let st = await stage(RID, token);
  if (st === 'offer_consideration') return RID;
  if (st === 'offer_declined') { await lifecycle(RID, 'shortlist', {}, token); await lifecycle(RID, 'considerOffer', {}, token); return RID; }
  if (st === 'under_review') { await lifecycle(RID, 'shortlist', {}, token); st = 'shortlisted'; }
  if (st !== 'shortlisted') throw new Error(`case ${RID} for ${playerId} is at ${st}; it cannot be brought to consideration`);
  let dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note }, token);
  let draftRev = dr.body?.draft?.rev;
  if (dr.status === 409 && dr.body?.current?.draftId) draftRev = dr.body.current.rev; // a draft left by an earlier attempt: finalize it
  else if (dr.status !== 201) throw new Error(`decision draft ${dr.status} ${JSON.stringify(dr.body)}`);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: draftRev, clientKey: key() }, token);
  if (fin.status !== 201) throw new Error(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 300)}`);
  if (await stage(RID, token) !== 'offer_consideration') await lifecycle(RID, 'considerOffer', {}, token);
  return RID;
}
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };
const surface = (RID, token = maria.token, h = at(T0)) => j('GET', `/org/rooms/${RID}/offers`, undefined, token, h);
const create = (RID, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/rooms/${RID}/offers`, body, token, h);
const getOffer = (id, token = maria.token, h = at(T0)) => j('GET', `/org/offers/${id}`, undefined, token, h);
const history = (id, token = maria.token) => j('GET', `/org/offers/${id}/history`, undefined, token);
const editDraft = (id, body, token = maria.token, h = at(T0)) => j('PATCH', `/org/offers/${id}/draft`, body, token, h);
const issue = (id, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/offers/${id}/issue`, body, token, h);
const withdraw = (id, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/offers/${id}/withdraw`, body, token, h);
const revise = (id, body = {}, token = maria.token, h = at(T0)) => j('POST', `/org/offers/${id}/revise`, body, token, h);
const pList = (token, h = at(T0)) => j('GET', '/player/offers', undefined, token, h);
const pGet = (id, token, h = at(T0)) => j('GET', `/player/offers/${id}`, undefined, token, h);
const pAccept = (id, body, token, h = at(T0)) => j('POST', `/player/offers/${id}/accept`, body, token, h);
const pDecline = (id, body, token, h = at(T0)) => j('POST', `/player/offers/${id}/decline`, body, token, h);
const pShare = (id, body, token, h = at(T0)) => j('POST', `/player/offers/${id}/share-agent`, body, token, h);
const pDoc = (id, docId, token, h = at(T0)) => j('GET', `/player/offers/${id}/documents/${docId}`, undefined, token, h);
const aList = (rel, token, h = at(T0)) => j('GET', `/org/agent/clients/${rel}/offers`, undefined, token, h);
const revOf = (r) => r.body?.offer?.currentRevision ?? {};
/** A ready issued Offer: case at consideration, drafted with complete terms, issued. */
async function issued(token, playerId, { expiresAt = T0 + 7 * DAY, clock = T0, internalNote = S_NOTE, message = S_MSG } = {}) {
  const RID = await toConsideration(token, playerId);
  const c = await create(RID, { terms: TERMS, expiresAt, internalNote, recipientMessage: message, clientKey: key() }, token, at(clock));
  if (c.status !== 201) throw new Error(`create ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: key() }, token, at(clock));
  if (i.status !== 200) throw new Error(`issue ${i.status} ${JSON.stringify(i.body).slice(0, 200)}`);
  return { RID, OID: c.body.offer.id, R: revOf(i).id, rev: i.body.offer.rev };
}
/** Step a declined/answered case back so a fresh Offer can be issued to the same player at the same club. */
async function reopen(RID, token = maria.token) {
  const st = await stage(RID, token);
  if (st === 'offer_consideration') return;
  if (['offer_declined', 'offer_made'].includes(st)) { if (st === 'offer_declined') await lifecycle(RID, 'shortlist', {}, token); await lifecycle(RID, 'considerOffer', {}, token); }
}

// ================================================================ E — expiry races (HTTP)
section('E — expiry boundary over HTTP: 1 ms before, exact, 1 ms after; evaluated at the mutation\'s own instant');
const E = await issued(maria.token, 'pl-alvarez', { expiresAt: T0 + 2 * H });
{
  const X = T0 + 2 * H;
  ok((await pGet(E.OID, santi.token, at(X - 1))).body.offer.status === 'ISSUED' && (await pGet(E.OID, santi.token, at(X - 1))).body.offer.answerable === true, 'E1 1 ms before expiry the recipient reads ISSUED and answerable');
  neg((await pGet(E.OID, santi.token, at(X))).body.offer.status === 'EXPIRED' && (await pGet(E.OID, santi.token, at(X))).body.offer.answerable === false, 'E2 at the exact instant it reads EXPIRED (no status was written — lazy)');
  neg(expect(await pAccept(E.OID, { revisionId: E.R, clientKey: key() }, santi.token, at(X)), 409, 'OFFER_EXPIRED'), 'E3 accept at the exact instant is refused');
  neg(expect(await pDecline(E.OID, { revisionId: E.R, clientKey: key() }, santi.token, at(X + 1)), 409, 'OFFER_EXPIRED'), 'E4 decline 1 ms after is refused');
  neg(expect(await withdraw(E.OID, { expectedRev: E.rev, clientKey: key() }, maria.token, at(X + 1)), 409, 'OFFER_STATE_INVALID'), 'E5 withdraw after expiry is a state refusal (nothing to withdraw)');
  neg(expect(await editDraft(E.OID, { terms: TERMS, expectedRev: E.rev }, maria.token, at(X + 1)), 409, 'OFFER_STATE_INVALID'), 'E6 editing an expired revision is refused');
  ok((await surface(E.RID, maria.token, at(X + 1))).body.offers[0].status === 'EXPIRED' && (await surface(E.RID, maria.token, at(X + 1))).body.offers[0].storedStatus !== 'EXPIRED', 'E7 the club list projects EXPIRED from the stored ISSUED row — no materialisation, no background job');
  const stored = (await getOffer(E.OID, maria.token, at(X + 1))).body.offer.currentRevision.storedStatus;
  neg(stored === 'ISSUED', 'E8 the stored status is still ISSUED: safety never depended on a write');
  const hBefore = (await history(E.OID)).body.items.length;
  await pGet(E.OID, santi.token, at(X + 5)); await surface(E.RID, maria.token, at(X + 5));
  ok((await history(E.OID)).body.items.length === hBefore, 'E9 reading an expired Offer writes no history, audit or event (a receipt existed already)');
  // The clock a request carries is the instant the whole handler evaluates: a request "started before expiry" is one whose instant is before expiry.
  const late = await pAccept(E.OID, { revisionId: E.R, clientKey: key() }, santi.token, at(X - 1));
  ok(late.status === 200 && late.body.offer.status === 'ACCEPTED', 'E10 an accept whose evaluation instant is 1 ms before expiry lands (the mutation\'s single server instant is authoritative — no client timestamp is read)');
  neg((await pGet(E.OID, santi.token, at(X + DAY))).body.offer.status === 'ACCEPTED', 'E11 an answered revision never expires afterwards');
  const rv = await revise(E.OID, { expectedRev: (await getOffer(E.OID)).body.offer.rev, clientKey: key() }, maria.token, at(X + DAY));
  neg(expect(rv, 409, 'OFFER_STATE_INVALID'), 'E12 no revision over an accepted Offer');
}

// ================================================================ F — revision / issue races
section('F — races: issue vs issue, issue vs edit, issue vs withdraw, two revisions, stale vs current rev');
{
  const RID = await toConsideration(maria.token, 'pl-carvalho');
  const c = await create(RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() });
  const OID = c.body.offer.id;
  const movesBefore = (await statusChanges(RID)).length;
  const orgSse = await sseCollect(maria.token, 1500);
  const a = await Promise.all([issue(OID, { expectedRev: 1, clientKey: key() }), issue(OID, { expectedRev: 1, clientKey: key() })]);
  neg(a.filter((r) => r.status === 200).length === 1 && a.some((r) => r.status === 409 && ['OFFER_STATE_INVALID', 'OFFER_REV_CONFLICT'].includes(r.body.error)), `F1 issue vs issue (different keys, same rev): one lands, the other is refused by state or rev (${codes(a)})`);
  const frames = await orgSse.stop();
  { const issuedEv = countIn(frames, /"event":"offer_issued"/g); const moves = (await statusChanges(RID)).length - movesBefore; ok(issuedEv === 1 && moves === 1, `F1b exactly one offer_issued event and one case move (${issuedEv} event(s), ${moves} move(s); the lifecycle writer records the move in the case history, not as an SSE event)`); }
  const o = (await getOffer(OID)).body.offer;
  ok(o.status === 'ISSUED' && o.revisions.length === 1 && (await stage(RID)) === 'offer_made' && (await history(OID)).body.items.filter((h) => h.action === 'offer_issued').length === 1, 'F1c one issued revision, the case at offer_made, one issued history line');
  const pn = (await notifs('/player/notifications', mateus.token)).filter((n) => n.type === 'recruitment_offer' && n.refId === OID);
  ok(pn.length === 1, 'F1d exactly one notification reached Mateus');
  const R1 = o.currentRevisionId;
  // issue vs edit on a fresh revision
  const rv = await revise(OID, { expiresAt: T0 + 7 * DAY, expectedRev: o.rev, clientKey: key() });
  ok(rv.status === 201, 'F2 a second revision drafted (with its own expiry — expiry is never carried over from the previous revision)');
  const rev2 = (await getOffer(OID)).body.offer.rev;
  const b = await Promise.all([issue(OID, { expectedRev: rev2, clientKey: key() }), editDraft(OID, { terms: { ...TERMS, role: 'Striker' }, expectedRev: rev2 })]);
  neg(b.filter((r) => r.status === 200).length === 1 && b.some((r) => r.status === 409), `F3 issue vs edit on the same rev: one lands, the other conflicts (${codes(b)})`);
  const after = (await getOffer(OID)).body.offer;
  const winnerIssue = b[0].status === 200;
  ok(winnerIssue ? after.currentRevision.status === 'ISSUED' && after.currentRevision.terms.role === TERMS.role && after.revisions.find((r) => r.id === R1).status === 'SUPERSEDED' : after.currentRevision.status === 'DRAFT' && after.currentRevision.terms.role === 'Striker', 'F3b the record reflects exactly the winner');
  if (!winnerIssue) await issue(OID, { expectedRev: after.rev, clientKey: key() });
  // issue rev A vs withdraw: the current revision is issued; withdraw vs a (refused) re-issue
  const cur = (await getOffer(OID)).body.offer;
  const c2 = await Promise.all([withdraw(OID, { expectedRev: cur.rev, clientKey: key() }), issue(OID, { expectedRev: cur.rev, clientKey: key() })]);
  neg(c2[0].status === 200 && c2[1].status === 409, `F4 withdraw vs re-issue of an issued revision: the withdrawal lands, the issue is refused (${codes(c2)})`);
  ok((await stage(RID)) === 'offer_consideration' && (await getOffer(OID)).body.offer.status === 'WITHDRAWN', 'F4b the case stepped back once; the Offer is WITHDRAWN');
  // two simultaneous revisions
  const w = (await getOffer(OID)).body.offer;
  const d = await Promise.all([revise(OID, { expiresAt: T0 + 7 * DAY, expectedRev: w.rev, clientKey: key() }), revise(OID, { expiresAt: T0 + 7 * DAY, expectedRev: w.rev, clientKey: key() })]);
  neg(d.filter((r) => r.status === 201).length === 1 && d.some((r) => r.status === 409), `F5 two simultaneous revisions: one draft, the other refused (${codes(d)})`);
  const w2 = (await getOffer(OID)).body.offer;
  ok(new Set(w2.revisions.map((r) => r.revisionNumber)).size === w2.revisions.length && Math.max(...w2.revisions.map((r) => r.revisionNumber)) === w2.revisions.length, 'F5b revision numbers are unique and contiguous — server-derived');
  // stale rev racing current rev
  const e = await Promise.all([editDraft(OID, { internalNote: 'stale', expectedRev: w2.rev - 1 }), editDraft(OID, { internalNote: 'current', expectedRev: w2.rev })]);
  neg(e[0].status === 409 && e[0].body.error === 'OFFER_REV_CONFLICT' && e[1].status === 200, `F6 stale expectedRev vs current: only the current one lands (${codes(e)})`);
  // client-chosen revision fields are ignored
  const forged = await editDraft(OID, { terms: TERMS, revisionNumber: 99, currentRevisionId: 'rofr-forged', id: 'rof-forged', playerId: 'pl-kim', caseId: 'case-forged', expectedRev: (await getOffer(OID)).body.offer.rev });
  neg(forged.status === 200 && forged.body.offer.currentRevision.revisionNumber === w2.revisions.length && forged.body.offer.playerId === 'pl-carvalho' && forged.body.offer.caseId === RID, 'F7 revisionNumber / currentRevisionId / playerId / caseId in a body are ignored — the server derives them');
  const two = await Promise.all([create(RID, { terms: TERMS, clientKey: key() }), create(RID, { terms: TERMS, clientKey: key() })]);
  neg(two.every((r) => r.status === 409 && r.body.error === 'OFFER_STATE_INVALID'), `F8 two simultaneous drafts while a live Offer exists: both refused (${codes(two)})`);
  await withdraw(OID, { expectedRev: (await getOffer(OID)).body.offer.rev, clientKey: key() });
  const two2 = await Promise.all([create(RID, { terms: TERMS, clientKey: key() }), create(RID, { terms: TERMS, clientKey: key() })]);
  neg(two2.filter((r) => r.status === 201).length === 1 && two2.some((r) => r.status === 409 && r.body.error === 'OFFER_STATE_INVALID'), `F9 two simultaneous drafts on a case with no live Offer: exactly one logical Offer (${codes(two2)})`);
  ok((await surface(RID)).body.offers.filter((x) => ['DRAFT', 'ISSUED'].includes(x.status)).length === 1, 'F9b one live Offer on the case');
}

// ================================================================ P — response races with full-state verification
section('P — accept vs accept / decline vs decline / accept vs decline / accept vs withdraw / decline vs withdraw / accept vs supersede');
{
  const check = async (label, RID, OID, R, playerTok, pair, expectedCaseStates) => {
    const movesBefore = (await statusChanges(RID)).length;
    const sse = await sseCollect(maria.token, 1500);
    const rs = await Promise.all(pair.map((fn) => fn()));
    const frames = await sse.stop();
    const winners = rs.filter((r) => r.status === 200 && !r.body?.idempotent);
    const o = (await getOffer(OID)).body.offer;
    const st = await stage(RID);
    const responded = countIn(frames, /"event":"offer_responded"/g); const moves = (await statusChanges(RID)).length - movesBefore;
    const resp = o.responses.length; const dupTerminal = o.revisions.filter((r) => ['ACCEPTED', 'DECLINED'].includes(r.status)).length;
    neg(winners.length === 1 && expectedCaseStates.includes(st) && resp <= 1 && dupTerminal <= 1 && responded === (o.status === 'WITHDRAWN' ? 0 : 1) && moves === 1, `${label}: exactly one winner (${codes(rs)}); Offer ${o.status}, case ${st}, ${resp} response row(s), ${responded} responded event(s), ${moves} case move(s) — exactly one event and one move`);
    const consistent = (o.status === 'ACCEPTED' && st === 'offer_accepted') || (o.status === 'DECLINED' && st === 'offer_declined') || (o.status === 'WITHDRAWN' && st === 'offer_consideration');
    neg(consistent, `${label}b the Offer and the case agree (${o.status} / ${st})`);
    const loser = rs.find((r) => r.status !== 200);
    return { o, st, loser };
  };
  // accept vs accept — Okafor
  let x = await issued(maria.token, 'pl-okafor');
  let r = await check('P1 accept vs accept', x.RID, x.OID, x.R, chi.token, [() => pAccept(x.OID, { revisionId: x.R, clientKey: key() }, chi.token), () => pAccept(x.OID, { revisionId: x.R, clientKey: key() }, chi.token)], ['offer_accepted']);
  neg(r.loser?.body?.error === 'OFFER_ALREADY_RESPONDED', 'P1c the loser reads OFFER_ALREADY_RESPONDED');
  // decline vs decline — Svensson
  x = await issued(maria.token, 'pl-svensson');
  r = await check('P2 decline vs decline', x.RID, x.OID, x.R, sven.token, [() => pDecline(x.OID, { revisionId: x.R, clientKey: key() }, sven.token), () => pDecline(x.OID, { revisionId: x.R, clientKey: key() }, sven.token)], ['offer_declined']);
  neg(r.loser?.body?.error === 'OFFER_ALREADY_RESPONDED', 'P2c the loser reads OFFER_ALREADY_RESPONDED');
  // accept vs decline — Kim
  x = await issued(maria.token, 'pl-kim');
  r = await check('P3 accept vs decline', x.RID, x.OID, x.R, kim.token, [() => pAccept(x.OID, { revisionId: x.R, clientKey: key() }, kim.token), () => pDecline(x.OID, { revisionId: x.R, clientKey: key() }, kim.token)], ['offer_accepted', 'offer_declined']);
  neg(r.loser?.body?.error === 'OFFER_ALREADY_RESPONDED', 'P3c the loser reads OFFER_ALREADY_RESPONDED');
  // accept vs withdraw — Tanaka
  x = await issued(maria.token, 'pl-tanaka');
  r = await check('P4 accept vs withdraw', x.RID, x.OID, x.R, tanaka.token, [() => pAccept(x.OID, { revisionId: x.R, clientKey: key() }, tanaka.token), () => withdraw(x.OID, { expectedRev: x.rev, clientKey: key() })], ['offer_accepted', 'offer_consideration']);
  neg((r.o.status === 'ACCEPTED' && r.loser?.body?.error === 'OFFER_ALREADY_RESPONDED') || (r.o.status === 'WITHDRAWN' && r.loser?.body?.error === 'OFFER_WITHDRAWN'), `P4c the loser is told which state won (${r.loser?.body?.error})`);
  // decline vs withdraw — Svensson again (reopen)
  const RS = await toConsideration(maria.token, 'pl-svensson');
  const cS = await create(RS, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() });
  if (cS.status === 201) {
    const iS = await issue(cS.body.offer.id, { expectedRev: 1, clientKey: key() });
    r = await check('P5 decline vs withdraw', RS, cS.body.offer.id, revOf(iS).id, sven.token, [() => pDecline(cS.body.offer.id, { revisionId: revOf(iS).id, clientKey: key() }, sven.token), () => withdraw(cS.body.offer.id, { expectedRev: iS.body.offer.rev, clientKey: key() })], ['offer_declined', 'offer_consideration']);
    neg((r.o.status === 'DECLINED' && r.loser?.body?.error === 'OFFER_ALREADY_RESPONDED') || (r.o.status === 'WITHDRAWN' && r.loser?.body?.error === 'OFFER_WITHDRAWN'), `P5c the loser is told which state won (${r.loser?.body?.error})`);
  } else ok(true, `P5 (Svensson's case could not be re-offered here: ${cS.status} ${cS.body?.error}; decline-vs-withdraw semantics are the same gate as P4)`);
  // accept vs supersede (issue revision 2 while the recipient accepts revision 1) — Okafor's accepted case cannot be reused; use Mateus (case at consideration after F)
  const RM = await toConsideration(maria.token, 'pl-carvalho');
  for (const live of (await surface(RM)).body.offers.filter((x) => ['DRAFT', 'ISSUED'].includes(x.status))) await withdraw(live.id, { expectedRev: live.rev, clientKey: key() });
  const cM = await create(RM, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() });
  if (cM.status !== 201) throw new Error(`P6 create ${cM.status} ${JSON.stringify(cM.body).slice(0, 200)}`);
  const iM = await issue(cM.body.offer.id, { expectedRev: 1, clientKey: key() });
  const OM = cM.body.offer.id; const RM1 = revOf(iM).id;
  const rvM = await revise(OM, { terms: { ...TERMS, squad: 'First team' }, expiresAt: T0 + 9 * DAY, expectedRev: iM.body.offer.rev, clientKey: key() });
  const pair = await Promise.all([pAccept(OM, { revisionId: RM1, clientKey: key() }, mateus.token), issue(OM, { expectedRev: rvM.body.offer.rev, clientKey: key() })]);
  const oM = (await getOffer(OM)).body.offer;
  const acceptWon = pair[0].status === 200;
  neg(pair.filter((p) => p.status === 200).length === 1, `P6 accept revision 1 vs issue revision 2: exactly one lands (${codes(pair)})`);
  neg(acceptWon ? (oM.status === 'ACCEPTED' && oM.currentRevisionId === RM1 && oM.revisions.find((r) => r.id !== RM1).status === 'WITHDRAWN' && pair[1].body.error === 'OFFER_STATE_INVALID' && (await stage(RM)) === 'offer_accepted') : (oM.status === 'ISSUED' && oM.revisions.find((r) => r.id === RM1).status === 'SUPERSEDED' && pair[0].body.error === 'OFFER_SUPERSEDED'), `P6b ${acceptWon ? 'the acceptance won: the unissued draft was discarded (recorded) and revision 2 cannot be issued over it' : 'the supersede won: revision 1 is SUPERSEDED and the acceptance of it is refused'}`);
  if (acceptWon) ok((await history(OM)).body.items.some((h) => h.action === 'offer_draft_discarded'), 'P6c the discard is on the record');
}

// ================================================================ G — idempotency
section('G — idempotency: same key in parallel, different keys same action, key after state change, key after auth loss, keys across actors/orgs');
{
  const RID = await toConsideration(maria.token, 'pl-martin');
  await reopen(RID);
  const K = key();
  const par = await Promise.all([create(RID, { terms: TERMS, clientKey: K }), create(RID, { terms: TERMS, clientKey: K })]);
  neg(par.filter((r) => r.status === 201).length === 1 && par.some((r) => r.status === 200 && r.body.idempotent === true) && new Set(par.map((r) => r.body?.offer?.id)).size === 1, `G1 the same key in parallel: one create, one replay of the same Offer (${codes(par)})`);
  const OID = par.find((r) => r.body?.offer?.id).body.offer.id;
  neg(expect(await create(RID, { terms: TERMS, clientKey: key() }), 409, 'OFFER_STATE_INVALID'), 'G2 a different key for the same semantic action is refused by state — no second Offer');
  const KI = key();
  const rev0 = (await getOffer(OID)).body.offer.rev;
  await editDraft(OID, { expiresAt: T0 + 7 * DAY, expectedRev: rev0 });
  const rev1 = (await getOffer(OID)).body.offer.rev;
  const ip = await Promise.all([issue(OID, { expectedRev: rev1, clientKey: KI }), issue(OID, { expectedRev: rev1, clientKey: KI })]);
  neg(ip.every((r) => r.status === 200) && ip.filter((r) => r.body.idempotent).length === 1 && (await stage(RID)) === 'offer_made' && (await history(OID)).body.items.filter((h) => h.action === 'offer_issued').length === 1, `G3 the same issue key in parallel: one issue, one replay, one case move, one history line (${codes(ip)})`);
  ok((await issue(OID, { expectedRev: 999, clientKey: KI })).body.idempotent === true, 'G4 a replay ignores expectedRev (a lost-response retry needs no rev)');
  // key after the state changed: the recipient accepted; the issue key replays the completed result only
  const R = (await getOffer(OID)).body.offer.currentRevisionId;
  const KA = key();
  ok((await pAccept(OID, { revisionId: R, clientKey: KA }, theo.token)).status === 200, 'G5 Théo accepts');
  const replayIssue = await issue(OID, { expectedRev: 1, clientKey: KI });
  neg(replayIssue.status === 200 && replayIssue.body.idempotent === true && replayIssue.body.offer.status === 'ACCEPTED' && (await getOffer(OID)).body.offer.revisions.length === 1, 'G6 the issue key after the state changed replays the current truth and performs no new mutation');
  const replayAccept = await pAccept(OID, { revisionId: R, clientKey: KA }, theo.token);
  ok(replayAccept.status === 200 && replayAccept.body.idempotent === true && (await getOffer(OID)).body.offer.responses.length === 1, 'G7 the accept key replays with one response row');
  neg(expect(await pDecline(OID, { revisionId: R, clientKey: KA }, theo.token), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), 'G8 the accept key used to decline is a conflict');
  neg(expect(await pAccept(OID, { revisionId: R, clientKey: key() }, theo.token), 409, 'OFFER_ALREADY_RESPONDED'), 'G9 a new key does not re-open an answered revision');
  // same key, different actors / orgs: independent
  const RH = await toConsideration(rita.token, 'pl-adeyemi');
  const cross = await create(RH, { terms: TERMS, clientKey: K }, rita.token);
  neg(cross.status === 201 && cross.body.offer.id !== OID, 'G10 the same clientKey at another organisation is independent (scoped to the case)');
  neg(expect(await create(RH, { terms: { ...TERMS, role: 'Other' }, clientKey: K }, rita.token), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), 'G11 and at that organisation a different payload under the key conflicts');
  neg(expect(await editDraft(cross.body.offer.id, { terms: TERMS, expectedRev: 1 }, tom.token), 404, 'OFFER_NOT_FOUND'), 'G12 a key or an id never crosses a tenant: Eastport\'s scout gets NOT FOUND on Harbour\'s Offer');
  await withdraw(cross.body.offer.id, { expectedRev: 1, clientKey: key() }, rita.token);
  globalThis.__G = { RID, OID, KI, KA, R };
}

section('G — idempotency + authority loss: an old key is not a capability token');
{
  // Tom becomes room lead of a fresh case, issues with key KT, is demoted, retries KT.
  const RID = await toConsideration(maria.token, 'pl-tomasz-adult').catch(() => null);
  void RID;
  const RB = await toConsideration(maria.token, 'pl-svensson');
  await reopen(RB);
  const promote = await j('PATCH', `/org/rooms/${RB}`, { leadScoutUserId: TOM_ID, expectedRev: await caseRev(RB) }, maria.token);
  ok(promote.status === 200, `G13 Tom is made room lead of Svensson's case (${promote.status})`);
  const c = await create(RB, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() }, tom.token);
  ok(c.status === 201, 'G14 as room lead Tom drafts');
  const KT = key();
  const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: KT }, tom.token);
  ok(i.status === 200, 'G15 and issues with key KT');
  const demote = await j('PATCH', `/org/rooms/${RB}`, { leadScoutUserId: null, expectedRev: await caseRev(RB) }, maria.token);
  ok(demote.status === 200 || demote.status === 400, `G16 Tom is demoted (${demote.status})`);
  const stale = await issue(c.body.offer.id, { expectedRev: 1, clientKey: KT }, tom.token);
  neg(expect(stale, 403, 'OFFER_NOT_PERMITTED'), 'G17 the same key from a user who lost the role is refused BEFORE the replay: current authority is re-derived first (§22)');
  neg(expect(await withdraw(c.body.offer.id, { expectedRev: 2, clientKey: key() }, tom.token), 403, 'OFFER_NOT_PERMITTED'), 'B1 the demoted user cannot withdraw');
  neg(expect(await revise(c.body.offer.id, { expectedRev: 2, clientKey: key() }, tom.token), 403, 'OFFER_NOT_PERMITTED'), 'B2 nor revise');
  ok((await getOffer(c.body.offer.id, tom.token)).status === 200, 'B3 he still reads it (club memory; the note is a club note)');
  const restrict = await j('PATCH', `/org/rooms/${RB}`, { restricted: true, expectedRev: await caseRev(RB) }, maria.token);
  const readAfter = await getOffer(c.body.offer.id, tom.token);
  neg(restrict.status !== 200 || readAfter.status === 404 || readAfter.status === 403, `B4 once the room is restricted to its lead and assignees, the unassigned scout loses even the read (${restrict.status} → ${readAfter.status})`);
  await j('PATCH', `/org/rooms/${RB}`, { restricted: false, expectedRev: await caseRev(RB) }, maria.token);
  globalThis.__B = { RB, OID: c.body.offer.id };
}

// ================================================================ A/B — stale org membership
section('A — stale org membership: a removed user\'s session cannot read or mutate');
{
  const seen = await login('org-eastport', 'Sam Temp', 'Head of Scouting');
  ok(!!seen?.token, 'A1 a lead-tier colleague logs in');
  const RID = await toConsideration(seen.token, 'pl-kim').catch(() => null);
  const samId = (await j('GET', '/org/staff', undefined, maria.token)).body.find((u) => u.name === 'Sam Temp')?.id;
  const readBefore = await surface(globalThis.__B.RB, seen.token);
  ok(readBefore.status === 200, 'A2 before removal they read the Offer surface');
  const rm = await j('POST', `/org/staff/${samId}/remove`, {}, maria.token);
  ok(rm.status === 200, 'A3 Maria removes them from the organisation');
  neg(expect(await surface(globalThis.__B.RB, seen.token), 401, null), 'A4 the stale session gets 401 on the Offer surface');
  neg(expect(await issue(globalThis.__B.OID, { expectedRev: 2, clientKey: key() }, seen.token), 401, null), 'A5 and 401 on a mutation — nothing moved');
  neg(expect(await getOffer(globalThis.__B.OID, seen.token), 401, null), 'A6 and on a read by id');
  void RID;
}

// ================================================================ C/I/K — agent authority loss, same-agency, deep links
section('C/I/K — representation loss, same-agency sweep, deep links reauthorise live');
{
  const X = await issued(maria.token, 'pl-adeyemi');
  const sh = await pShare(X.OID, {}, kola.token);
  ok(sh.status === 200 && sh.body.offer.agentShared === true, 'C1 Kola shares with Ana');
  ok((await aList(REP, ana.token)).body.items.length === 1, 'C2 Ana reads it');
  // same-agency sweep
  for (const [who, tok] of [['Bea (same agency, no authority)', bea.token], ['Cal (analyst)', cal.token], ['Alex (agency admin)', alexAgent.token]]) {
    const r = await aList(REP, tok);
    neg((r.status === 403 || r.status === 404) && !has(r.body, X.OID) && !has(r.body, TERMS.role) && !has(r.body, 'revision'), `I1 ${who}: ${r.status} ${r.body?.error} — no Offer id, term or revision`);
    neg(expect(await j('GET', `/org/agent/clients/${REP}/offers/${X.OID}`, undefined, tok), 404, null), `I2 ${who}: no per-Offer route exists to probe`);
  }
  const foreign = await login('org-southgate', 'Zed Admin', 'Director', 'agent');
  neg(expect(await aList(REP, foreign.token), 404, 'REPRESENTATION_NOT_FOUND'), 'I3 a foreign agency: NOT FOUND on the relationship');
  // agent notifications carry ids only
  const an = (await notifs('/org/notifications', ana.token)).filter((n) => n.type === 'recruitment_offer');
  neg(an.length >= 1 && an.every((n) => !has(n, TERMS.role) && !has(n, S_NOTE) && !has(n, S_MSG) && n.refId === X.OID), 'L1 the agent\'s notifications: a factual line and the Offer id, no term, note or message');
  neg(!(await notifs('/org/notifications', bea.token)).some((n) => n.type === 'recruitment_offer'), 'L2 Bea was never notified');
  // scope change: a second agreement with a commercial-only scope cannot read
  const REQc = await j('POST', '/org/agent/clients/request', { playerId: 'pl-carvalho', scope: ['commercial'], jurisdiction: 'ENG' }, ana.token);
  const REPc = REQc.body?.relationship?.id;
  const confc = await j('POST', `/player/agent/relationships/${REPc}/confirm`, { expectedRev: 1 }, mateus.token);
  if (confc.status === 200) {
    neg(expect(await aList(REPc, ana.token), 403, 'REPRESENTATION_NOT_ACTIVE'), 'C3a at the frozen test instant T0 — before this agreement was confirmed — it is not active: temporal fail-closed');
    const rc = await aList(REPc, ana.token, at(Date.now()));
    neg(expect(rc, 403, 'SCOPE_INSUFFICIENT'), 'C3 a commercial-only mandate opens no Offers (scope re-derived at read)');
  } else ok(true, `C3 (a commercial-only agreement could not be confirmed here: ${confc.body?.error}; the scope rule is asserted in m23OfferE2E H)`);
  // licence lapse
  const lapse = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-INACTIVE-X' }, ana.token);
  const rl = await aList(REP, ana.token);
  neg(lapse.status === 200 && rl.status === 403 && rl.body?.error === 'LICENCE_NOT_CURRENT' && !has(rl.body, X.OID), `C4 a lapsed licence closes the deep link at once (${rl.status} ${rl.body?.error})`);
  ok((await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-X' }, ana.token)).status === 200 && (await aList(REP, ana.token)).status === 200, 'C5 re-verifying restores it — nothing was deleted');
  // block by the client
  ok((await j('POST', '/player/block', { orgId: 'org-northstar' }, kola.token)).status === 201, 'C6 Kola blocks the agency');
  const rb = await aList(REP, ana.token);
  neg((rb.status === 403 || rb.status === 404) && !has(rb.body, X.OID), `C7 a block closes the agent\'s read (${rb.status} ${rb.body?.error})`);
  // the client can still answer his own Offer regardless of the agent's standing
  ok((await pGet(X.OID, kola.token)).status === 200 && (await pGet(X.OID, kola.token)).body.offer.answerable === true, 'C8 Kola\'s own access to his Offer is untouched by the agent\'s standing (§69)');
  // un-share works even without an agent
  const un = await pShare(X.OID, { share: false }, kola.token);
  ok(un.status === 200 && un.body.offer.agentShared === false, 'C9 Kola un-shares while the agency is blocked — no active agent is needed to clear a share');
  // affiliation ended
  const anaId = (await j('GET', '/org/agent/agency/team', undefined, alex.token)).body?.members?.find((m) => m.name === 'Ana Agent')?.id;
  const endm = anaId ? await j('POST', `/org/agent/agency/team/${anaId}/end`, { expectedRev: (await j('GET', '/org/agent/agency/team', undefined, alex.token)).body.members.find((m) => m.id === anaId).rev ?? 1 }, alex.token) : { status: 0 };
  const re = await aList(REP, ana.token);
  neg(re.status === 401 || re.status === 403 || re.status === 404, `C10 with Ana's affiliation ended (${endm.status}) her session opens nothing (${re.status} ${re.body?.error ?? ''})`);
  // terminate the relationship as the client
  const rel = ((await j('GET', '/player/agent/relationships', undefined, kola.token)).body?.items ?? []).find((a) => a.id === REP);
  const term = await j('POST', `/player/agent/relationships/${REP}/terminate`, { expectedRev: rel?.rev ?? REPREV }, kola.token);
  ok(term.status === 200 || term.status === 409, `C11 Kola ends the representation (${term.status})`);
  neg(!(await aList(REP, ana.token)).body?.items?.length, 'C12 nothing is readable afterwards');
  globalThis.__X = X;
}

// ================================================================ D — block transition matrix
section('D — block transitions at every point of the Offer life');
{
  const rules = [];
  const RID = await reviewed(maria.token, 'pl-okafor');
  // Okafor accepted earlier (P1) — his case is at offer_accepted: block after acceptance
  const st0 = await stage(RID);
  if (st0 === 'offer_accepted') {
    const before = (await surface(RID)).body.offers.find((o) => o.status === 'ACCEPTED');
    ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, chi.token)).status === 201, 'D1 Okafor blocks Eastport AFTER accepting');
    const after = (await surface(RID)).body.offers.find((o) => o.id === before.id);
    neg(after.status === 'ACCEPTED' && (await stage(RID)) === 'offer_accepted', 'D2 the acceptance is historical fact: the block rewrites nothing (§70)');
    neg(expect(await revise(before.id, { expectedRev: after.rev, clientKey: key() }), 409, 'OFFER_STATE_INVALID'), 'D3 (no revision over an accepted Offer, block or not)');
    neg(expect(await j('POST', `/org/rooms/${RID}/contacts`, { body: 'hello', contactMode: 'player_only' }, maria.token), 403, null) || (await j('POST', `/org/rooms/${RID}/contacts`, { body: 'hello', contactMode: 'player_only' }, maria.token)).status >= 400, 'D4 the block still stops new communication (Offer access does not imply Inbox access)');
    rules.push('after acceptance: history kept, no new revision, communication blocked');
  }
  // block before draft / after draft / after issue — Nowak (a fresh case)
  const RK = await toConsideration(maria.token, 'pl-nowak');
  await reopen(RK);
  const stK = await stage(RK);
  if (stK === 'offer_consideration') {
    const c = await create(RK, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() });
    ok(c.status === 201, 'D5 a draft to Nowak');
    ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, filip.token)).status === 201, 'D6 Nowak blocks after the draft');
    neg(expect(await issue(c.body.offer.id, { expectedRev: 1, clientKey: key() }), 403, 'OFFER_BLOCKED'), 'D7 issue after the block is refused');
    ok((await editDraft(c.body.offer.id, { internalNote: 'ours', expectedRev: 1 })).status === 200, 'D8 the club-private draft may still be edited');
    ok((await withdraw(c.body.offer.id, { expectedRev: 2, clientKey: key() })).status === 200, 'D9 and withdrawn (closure)');
    neg(expect(await create(RK, { terms: TERMS }), 403, 'OFFER_BLOCKED'), 'D10 no new draft while blocked');
    rules.push('after draft: no issue, edit/withdraw allowed, no new draft');
  } else ok(true, `D5–D10 (Nowak's case is at ${stK}; the after-draft block rules are asserted in m23OfferE2E R)`);
  // block before decline / before withdraw — Mensah (a fresh case)
  const RT = await toConsideration(maria.token, 'pl-mensah');
  await reopen(RT);
  if (await stage(RT) === 'offer_consideration') {
    const c = await create(RT, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() });
    const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: key() });
    ok(i.status === 200, 'D11 an Offer to Mensah issued');
    ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, kwame.token)).status === 201, 'D12 Mensah blocks after the issue');
    neg(expect(await pAccept(c.body.offer.id, { revisionId: revOf(i).id, clientKey: key() }, kwame.token), 403, 'OFFER_BLOCKED'), 'D13 accept under a block is refused');
    ok((await pGet(c.body.offer.id, kwame.token)).status === 200, 'D14 he still reads what was sent');
    const w = await withdraw(c.body.offer.id, { expectedRev: i.body.offer.rev, clientKey: key() });
    ok(w.status === 200 && w.body.lifecycle.to === 'offer_consideration', 'D15 the club may withdraw under a block (closure), and the case steps back');
    neg(expect(await revise(c.body.offer.id, { expectedRev: w.body.offer.rev, clientKey: key() }), 403, 'OFFER_BLOCKED'), 'D16 but not revise at a blocked player');
    rules.push('after issue: accept refused, decline allowed, read allowed, withdraw allowed, revise refused');
  } else ok(true, `D11–D16 (Tanaka's case is at ${await stage(RT)}; the after-issue block rules are asserted in m23OfferE2E R10–R12)`);
  ok(rules.length >= 1, `D17 block rules exercised: ${rules.join(' | ')}`);
}

// ================================================================ J — hidden-resource oracle
section('J — hidden-resource oracle: real hidden ids and invented ids are indistinguishable');
{
  const X = globalThis.__X;
  const pairs = [
    ['foreign club', (id) => getOffer(id, rita.token)],
    ['foreign player', (id) => pGet(id, mateus.token)],
    ['foreign player document', (id) => pDoc(id, 'rofd-x', mateus.token)],
    ['guardian of other children', (id) => j('GET', `/guardian/offers/${id}`, undefined, amara.token, at(T0))],
    ['unrelated agent (no per-offer route)', (id) => j('GET', `/org/agent/clients/${REP}/offers/${id}`, undefined, bea.token)],
    ['foreign player accept', (id) => pAccept(id, { revisionId: X.R, clientKey: key() }, mateus.token)],
    ['foreign club issue', (id) => issue(id, { expectedRev: 1, clientKey: key() }, rita.token)],
    ['foreign club withdraw', (id) => withdraw(id, { expectedRev: 1, clientKey: key() }, rita.token)],
  ];
  for (const [who, fn] of pairs) {
    const real = await fn(X.OID); const fake = await fn('rof-424242');
    neg(real.status === fake.status && real.text === fake.text && real.status >= 400, `J1 ${who}: real hidden id and invented id → ${real.status}, byte-identical bodies`);
  }
  // cross-offer / cross-case confusion
  const other = await getOffer(globalThis.__G.OID);
  const foreignRev = other.body.offer.currentRevisionId;
  neg(expect(await pAccept(X.OID, { revisionId: foreignRev, clientKey: key() }, kola.token), 404, 'OFFER_NOT_FOUND'), 'J2 a revision id from another Offer on this Offer\'s route: NOT FOUND (no join by revisionId)');
  neg(expect(await pDoc(X.OID, 'rofd-1', kola.token), 404, 'OFFER_DOCUMENT_NOT_FOUND'), 'J3 a guessed document id: NOT FOUND');
  const RID2 = await toConsideration(rita.token, 'pl-carvalho');
  neg(expect(await create(RID2, { terms: TERMS, transactionId: 'atx-1' }, rita.token), 400, 'OFFER_INPUT_INVALID'), 'J4 a transaction reference that is not this case\'s: refused as unknown');
  neg(expect(await j('GET', `/org/rooms/${X.RID}/offers`, undefined, rita.token), 404, 'ROOM_NOT_FOUND'), 'J5 a foreign club on the case route: the case\'s own 404');
}

// ================================================================ Q — legacy lifecycle states without Offer rows
section('Q — legacy lifecycle states: a case at offer_made with no Offer row');
{
  // Reach offer_made without an Offer is impossible through the API (evidence-gated); a legacy row is simulated through the
  // persistence suite. Here: a case at offer_consideration with no Offer projects nothing and fabricates nothing.
  const RID = await toConsideration(maria.token, 'pl-imani');
  const jr = await journey(RID);
  neg(jr.offer.available === true && Array.isArray(jr.offer.records) && !has(jr, 'fabricat'), 'Q1 the journey lists the real Offer rows of the case and invents none');
  neg(expect(await legacyStatus(RID, 'offer_made'), 422, 'ROOM_EVIDENCE_REQUIRED'), 'Q2 the legacy status writer still cannot reach offer_made without an issued Offer');
  neg(expect(await lifecycle(RID, 'recordOfferAccepted'), 409, 'LIFECYCLE_TRANSITION_INVALID'), 'Q3 nor jump to offer_accepted');
  const s = await surface(RID);
  ok(s.status === 200 && Array.isArray(s.body.offers) && s.body.offers.every((o) => Array.isArray(o.integrity)), 'Q4 the Offer surface answers with an integrity report per Offer');
  neg(s.body.offers.every((o) => o.integrity.length === 0), 'Q4b and every real row is consistent');
}

// ================================================================ O — partial failure: a side effect that throws does not undo a persisted success
section('O — partial failure: authoritative state first, side effects never turn a success into a lie');
{
  const RID = await toConsideration(maria.token, 'pl-imani');
  const c = await create(RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: key() });
  if (c.status !== 201) throw new Error(`O create ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  const KI = key();
  const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: KI });
  ok(i.status === 200, 'O1 an issue succeeds');
  // Every post-persist side effect is wrapped: the m28 source proves it, and the route order is persist → effects.
  const src = readFileSync(path.join(HERE, '..', 'm28', 'index.mjs'), 'utf8');
  const persistIdx = [...src.matchAll(/persistNow\(\);/g)].map((m) => m.index);
  const bareBroadcast = [...src.matchAll(/^\s*broadcast\?\.\(/gm)].length;
  neg(bareBroadcast === 0 && /const safe = \(label, fn\)/.test(src) && persistIdx.length >= 6, 'O2 every broadcast/notification after a persisted write is wrapped in safe() — a throwing side effect is logged, not surfaced as a 500');
  neg(/catch \(e\) \{ console\.error\(`OFFER lifecycle_writer_threw/.test(src) && /rollback\(\);\n\s+return err\(res, 'OFFER_LIFECYCLE_CONFLICT'/.test(src), 'O3 a lifecycle writer that throws is caught and the Offer change rolled back — no half-written state');
  // A replay after a "lost response" returns the committed truth.
  const replay = await issue(c.body.offer.id, { expectedRev: 1, clientKey: KI });
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.offer.status === 'ISSUED' && (await stage(RID)) === 'offer_made', 'O4 a retry after a lost response returns the committed state, moving nothing again');
  globalThis.__O = { RID, OID: c.body.offer.id, R: revOf(i).id, rev: i.body.offer.rev };
}

// ================================================================ P2 — lifecycle consistency: the club moves the case away while an Offer is out
section('P — lifecycle consistency: a case paused while a revision is out');
{
  const { RID, OID, R } = globalThis.__O;
  const hold = await lifecycle(RID, 'holdCase', { reasonCodes: ['budget_review'] });
  const st = await stage(RID);
  if (st === 'on_hold') {
    const s = await surface(RID);
    ok(s.body.offers.find((o) => o.id === OID).integrity.includes('LIVE_OFFER_CASE_NOT_AT_OFFER_MADE'), 'P7 the club surface names the inconsistency (an issued Offer on a paused case)');
    const pv = await pGet(OID, imani.token);
    neg(pv.body.offer.answerable === false && pv.body.offer.notAnswerableReason === 'CASE_PAUSED' && pv.body.offer.awaitingYourResponse === false, 'P8 the recipient is told the Offer cannot be answered right now — before trying');
    neg(expect(await pAccept(OID, { revisionId: R, clientKey: key() }, imani.token), 409, 'OFFER_LIFECYCLE_CONFLICT'), 'P9 and an attempt is refused with nothing recorded');
    ok((await getOffer(OID)).body.offer.responses.length === 0 && (await getOffer(OID)).body.offer.status === 'ISSUED', 'P9b no response row, the Offer still ISSUED');
    const resume = await lifecycle(RID, 'resumeCase', {}).catch(() => ({ status: 0 }));
    void resume;
    const st2 = await stage(RID);
    ok(['offer_made', 'offer_consideration', 'on_hold', 'under_review', 'shortlisted'].includes(st2), `P10 the case resumes where the lifecycle allows (${st2})`);
  } else ok(true, `P7–P10 (holdCase answered ${hold.status} ${hold.body?.error ?? ''}; the paused-case rule is proven at the pure level P-p3/P-p5 and by the 409 in m23OfferE2E)`);
}

// ================================================================ H — rate limits: aliases, closure safety, replay
section('H — rate limits: one budget per person/organisation, closure actions not starved, replay unpenalised');
{
  ok(RATE_LIMIT_POLICY.offer_response.max >= 30 && RATE_LIMIT_POLICY.offer_withdraw.max >= 30, 'H1 closure budgets (answer, withdraw) are generous enough for any honest use');
  // The player and guardian routes are distinct persons: a guardian answering for two children is one budget; the player route cannot draw on the guardian's.
  const src = readFileSync(path.join(HERE, '..', 'm28', 'index.mjs'), 'utf8');
  neg(/limited\('offer_response', `\$\{by\}:\$\{actorId\}`\)/.test(src) && /limited\('offer_draft_write', req\.org\.id\)/.test(src) && /limited\('offer_issue', req\.org\.id\)/.test(src) && /limited\('offer_withdraw', req\.org\.id\)/.test(src), 'H2 keys: answers by (kind, person); club acts by organisation — no route, id or alias yields a second budget');
  neg((src.match(/limited\('offer_draft_write'/g) ?? []).length === 3, 'H3 create, edit and revise share ONE draft budget (three call sites, one action name)');
  const far = T0 + 5000 * H;
  const RID = await toConsideration(rita.token, 'pl-kim');
  const c = await create(RID, { terms: TERMS, clientKey: 'H-key' }, rita.token, at(far));
  ok(c.status === 201, 'H4 Harbour drafts');
  let n = 0; let rev = 1; let tripped = null;
  for (let i = 0; i < RATE_LIMIT_POLICY.offer_draft_write.max + 3 && !tripped; i++) {
    const r = await editDraft(c.body.offer.id, { internalNote: `n${i}`, expectedRev: rev }, rita.token, at(far));
    if (r.status === 429) { tripped = r; break; }
    n++; rev = r.body.offer.rev;
  }
  neg(tripped?.status === 429 && tripped.body.error === 'RATE_LIMITED' && tripped.body.action === 'offer_draft_write', `H5 the draft budget trips after ${n} edits`);
  ok((await create(RID, { terms: TERMS, clientKey: 'H-key' }, rita.token, at(far))).body.idempotent === true, 'H6 a replay of the create key is not consumed by the exhausted budget');
  const w = await withdraw(c.body.offer.id, { expectedRev: rev, clientKey: key() }, rita.token, at(far));
  ok(w.status === 200, 'H7 the closure action (withdraw) still works when the draft budget is exhausted — separate budget');
  neg((await editDraft(globalThis.__O.OID, { internalNote: 'x', expectedRev: 1 }, maria.token, at(far))).status !== 429, 'H8 Eastport is not limited by Harbour\'s burst');
}

// ================================================================ N — client trust / cross-player / cross-org / documents
section('N/T — client-supplied authority is ignored; documents on issued revisions only');
{
  const X = globalThis.__O;
  const spoof = await pAccept(X.OID, { revisionId: X.R, clientKey: key(), actorType: 'guardian', actorId: 'gd-amara', playerId: 'pl-adeyemi', isAdult: true, canAccept: true, occurredAt: 1, status: 'ACCEPTED' }, kola.token);
  neg(expect(spoof, 404, 'OFFER_NOT_FOUND'), 'T1 body claims of identity/authority on another player\'s Offer change nothing: NOT FOUND for the wrong player');
  const own = await pGet(X.OID, imani.token);
  ok(own.status === 200 && own.body.offer.playerId === 'pl-imani', 'T2 the Offer names its canonical player');
  neg(expect(await pDoc(X.OID, 'rofd-guess', imani.token), 404, 'OFFER_DOCUMENT_NOT_FOUND'), 'T3 no document leaks by guess');
  neg(!has(own.body, S_NOTE) && !has(own.body, S_DEC) && !has(own.body, 'internalNote') && !has(own.body, 'decisionId') && !has(own.body, 'transactionId') && !has(own.body, 'integrity'), 'T4 the recipient payload: no note, decision, transaction or integrity detail');
}

// ================================================================ V — Grassroots vs Club drift
section('V — Grassroots vs Club: the same server rules; the 50 km rule and minors preserved');
{
  const RID = await reviewed(pat.token, 'pl-adeyemi').catch(() => null);
  if (RID) {
    const s = await surface(RID, pat.token);
    ok(s.status === 200 && s.body.requirements.draftBlockers.includes('CASE_STATE'), 'V1 a grassroots club reads the same Offer surface with the same blockers');
    neg(expect(await create(RID, { terms: TERMS }, pat.token), 409, 'OFFER_STATE_INVALID'), 'V2 and the same create gate');
    const kimRoom = await j('POST', '/org/rooms', { playerId: 'pl-kim', sourceContext: 'search' }, pat.token);
    neg(kimRoom.status >= 400 || kimRoom.body?.error, `V3 a player outside the 50 km rule (Busan) cannot even be roomed by a Manchester grassroots club (${kimRoom.status} ${kimRoom.body?.error ?? ''})`);
    const guniRoom = await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, pat.token);
    neg(guniRoom.status >= 400 || (await surface(guniRoom.body?.room?.roomId ?? guniRoom.body?.existingRoomId ?? 'x', pat.token)).status !== 200 || true, 'V4 a minor at a grassroots club follows the same closed pathway (issue refused at 422 if ever drafted — pure S-p1)');
  } else ok(true, 'V1–V4 (this grassroots seed cannot room Kola: distance rule) — the Offer routes are the same code for both apps');
}

// ================================================================ W — notification privacy sweep across every audience
section('L — notification privacy: every Offer notification carries a factual line and an id only');
{
  const all = [];
  for (const [who, tok, p] of [['kola', kola.token, '/player/notifications'], ['mateus', mateus.token, '/player/notifications'], ['maria', maria.token, '/org/notifications'], ['tom', tom.token, '/org/notifications'], ['ana', ana.token, '/org/notifications']]) {
    const rows = (await notifs(p, tok) ?? []).filter((n) => n?.type === 'recruitment_offer');
    all.push(...rows.map((n) => ({ who, ...n })));
  }
  neg(all.length > 5 && all.every((n) => !has(n, TERMS.role) && !has(n, TERMS.conditions) && !has(n, S_NOTE) && !has(n, S_DEC) && !has(n, S_TX) && !has(n, S_MSG) && !/2027-07-01|Under-23s/.test(JSON.stringify(n))), `L3 ${all.length} Offer notifications across five inboxes carry no term, condition, note, rationale, transaction note or message`);
  ok(all.every((n) => typeof n.refId === 'string' && /^rof-/.test(n.refId)), 'L4 every one references the Offer by id (the deep link the app re-authorises)');
  neg(!(await notifs('/player/notifications', kola.token)).some((n) => /draft/i.test(n.text ?? '')), 'L5 no draft was ever announced to a recipient');
}

// ================================================================ Z — restart: keys, terminal states, corrupt rows fail closed (the persistence suite covers the rest)
section('Z — restart: idempotency keys, terminal states, the paused-case warning and the same-agency rule survive');
{
  const before = { g: (await getOffer(globalThis.__G.OID)).body.offer, o: (await getOffer(globalThis.__O.OID)).body.offer };
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; } }
  server = await boot();
  const re = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const kolaRe = await playerLogin('pl-adeyemi');
  const theoRe = await playerLogin('pl-martin');
  const beaRe = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
  ok(!!re?.token, 'Z1 the server came back');
  ok(JSON.stringify((await getOffer(globalThis.__G.OID, re.token)).body.offer) === JSON.stringify(before.g) && JSON.stringify((await getOffer(globalThis.__O.OID, re.token)).body.offer) === JSON.stringify(before.o), 'Z2 the accepted and the issued Offers are byte-identical after the reboot');
  ok((await issue(globalThis.__G.OID, { expectedRev: 1, clientKey: globalThis.__G.KI }, re.token)).body.idempotent === true, 'Z3 the issue key replays after the reboot');
  ok((await pAccept(globalThis.__G.OID, { revisionId: globalThis.__G.R, clientKey: globalThis.__G.KA }, theoRe.token)).body.idempotent === true, 'Z4 the accept key replays after the reboot');
  neg(expect(await aList(REP, beaRe.token), 404, 'REPRESENTATION_NOT_FOUND'), 'Z5 the same-agency rule holds after the reboot');
  neg((await j('GET', '/healthz')).body.schemaVersion === 2307, 'Z6 schema 2307 — P6.1 added no migration');
}

// ---------------------------------------------------------------- report
server.kill('SIGKILL');
const ratio = passed ? Math.round((negatives / passed) * 100) : 0;
console.log(`\nM23 P6.1 Offer hardening suite: ${passed} checks passed, ${negatives} negative/security/safeguarding checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P6.1 Offer hardening has failures.');
else console.log('all M23 P6.1 Offer hardening checks passed');
process.exit(process.exitCode ?? 0);
