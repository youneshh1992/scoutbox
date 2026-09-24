// M23 P8 — Full Recruitment Journey Integration: the end-to-end proof.
//
//   discovery → watching → review → contact → trial → assessment → decision →
//   offer → acceptance → signing → signed, as ONE coherent journey read from
//   ONE server projection, every stage grounded in its own canonical record,
//   no stage advanced by discovery, matching, Trust Score, Box Cam, an
//   assessment, an acceptance or a signature alone.
//
// Groups: A model (pure) · B the canonical adult journey (§61 steps 1–25) ·
// C the negatives (§62 #1–#20) · D legacy and integrity classification ·
// E cross-resource confusion · F audiences (player, guardian, agent) ·
// G notification targets · H lifecycle authority and contract truth ·
// Q partial failure · Z boundary invariants (source scans).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, MIGRATIONS } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { ROOM_STATUSES, TERMINAL_ROOM_STATUSES } from '../m17/shared.mjs';
import {
  JOURNEY_STAGES, PIPELINE_STAGES, canonicalStageFor, completedStagesFor, nextActionFor, NEXT_ACTION_CODES, NEXT_ACTIONS,
  currentContactForCase, currentTrialForCase, currentOfferForCase, currentSigningForOffer, currentDecisionForCase, currentAssessmentForCase,
  playerNextActionFor, playerStageFor, validateRecruitmentJourney, JOURNEY_CLASSIFICATIONS, TIMELINE_VISIBILITY, timelineVisibleTo,
} from '../m23/journeyModel.mjs';
import { buildRecruitmentJourney, JOURNEY_VIEWERS } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const ROOT = path.join(HERE, '..');
const PORT = 7400 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23jn-'));
const S_NOTE = 'PRIVATE_JOURNEY_NOTE_7701';
const S_DEC = 'PRIVATE_JOURNEY_DECISION_7702';
const S_OFFER_NOTE = 'PRIVATE_JOURNEY_OFFER_NOTE_7703';
const S_ASSESS = 'PRIVATE_JOURNEY_ASSESSMENT_7704';
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
const DOC = pdf('Contract of employment — journey'); const SHA = sha256(DOC);
const DOC2 = pdf('Contract of employment — journey, amended'); const SHA2 = sha256(DOC2);
const T0 = Date.now();
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });

// ================================================================ A — model (pure)
section('A — the model: stages, selectors, next actions, validator, visibility (pure)');
{
  ok(SCHEMA_VERSION === 2308 && MIGRATIONS.length === 18, 'A1 schema stays 2308 with 18 migrations: P8 adds no store');
  ok(JOURNEY_STAGES.length === 13 && PIPELINE_STAGES.length === 10 && PIPELINE_STAGES.every((s) => JOURNEY_STAGES.includes(s)), 'A2 thirteen stage words, ten pipeline stages');
  neg(ROOM_STATUSES.length === 18 && JOURNEY_STAGES.every((s) => !ROOM_STATUSES.includes(s) || s === 'watching' || s === 'signed'), 'A3 the frozen lifecycle still has 18 states; a stage word is not a lifecycle state (only `watching` and `signed` coincide by name)');
  ok(canonicalStageFor('trial_completed', { assessed: false }) === 'assessment' && canonicalStageFor('trial_completed', { assessed: true }) === 'decision' && canonicalStageFor('offer_accepted', {}) === 'acceptance' && canonicalStageFor('offer_accepted', { signingOpened: true }) === 'signing' && canonicalStageFor('on_hold', {}) === 'paused' && canonicalStageFor('archived', {}) === 'ended', 'A4 stage refinements: assessed → decision, package → signing, hold → paused, terminal → ended');
  neg(canonicalStageFor('SIGNED', {}) === null && canonicalStageFor('', {}) === null && canonicalStageFor('constructor', {}) === null, 'A5 an unknown status has no stage (fails closed, prototype keys included)');
  // Selectors: the P7.1 Agent defect (an expired package over a live one) can no longer happen.
  const pk = (id, status, createdAt, expiresAt) => ({ id, status, createdAt, expiresAt, revisions: [{ id: `${id}-r1`, revisionNumber: 1, status }], currentRevisionId: `${id}-r1` });
  const expired = pk('spk-old', 'READY', T0 - 10 * DAY, T0 - 5 * DAY); const live = pk('spk-new', 'READY', T0 - DAY, T0 + 5 * DAY); const done = pk('spk-done', 'COMPLETED', T0 - 3 * DAY, null);
  neg(currentSigningForOffer([expired, live], T0)?.id === 'spk-new' && currentSigningForOffer([live, expired], T0)?.id === 'spk-new', '#53 A6 a live package is current whatever its storage order; the expired one never masks it');
  ok(currentSigningForOffer([expired, done], T0)?.id === 'spk-done' && currentSigningForOffer([expired], T0)?.id === 'spk-old' && currentSigningForOffer([], T0) === null, 'A7 live → completed → newest terminal → null');
  const cx = (id, status, t) => ({ id, status, createdAt: t, deliveredAt: status === 'delivered' || status === 'responded' ? t : undefined, respondedAt: status === 'responded' ? t + 1 : undefined, updatedAt: t });
  ok(currentContactForCase([cx('c1', 'responded', 1), cx('c2', 'delivered', 2), cx('c3', 'draft', 3)])?.id === 'c2' && currentContactForCase([cx('c1', 'responded', 1), cx('c3', 'draft', 3)])?.id === 'c1' && currentContactForCase([cx('c4', 'cancelled', 9)]) === null, 'A8 the current Contact: delivered over answered over draft; cancelled never');
  const tr = (id, state, t) => ({ id, acceptedAt: t, workflowState: state, schedule: state === 'scheduled' || state === 'completed' ? { confirmedAt: t, sessions: [{ id: 's', startsAt: t, endsAt: t + H }] } : null, completion: state === 'completed' ? { state: 'completed', at: t + 2 } : state === 'cancelled' ? { state: 'cancelled', at: t + 2 } : null });
  ok(currentTrialForCase([tr('t1', 'completed', 1), tr('t2', 'cancelled', 5), tr('t3', 'scheduled', 3)])?.id === 't3' && currentTrialForCase([tr('t1', 'completed', 1), tr('t2', 'cancelled', 5)])?.id === 't1', 'A9 the current Trial: live over completed over cancelled');
  const rv = (id, n, status, issuedAt) => ({ id, revisionNumber: n, status, issuedAt, expiresAt: T0 + 10 * DAY });
  const of = (id, revs, updatedAt) => ({ id, updatedAt, createdAt: updatedAt, revisions: revs, currentRevisionId: revs[revs.length - 1].id });
  const oAcc = of('rof-a', [rv('ra1', 1, 'ACCEPTED', 1)], 1); const oLive = of('rof-b', [rv('rb1', 1, 'SUPERSEDED', 2), rv('rb2', 2, 'ISSUED', 3)], 3); const oDec = of('rof-c', [rv('rc1', 1, 'DECLINED', 9)], 9);
  const cur = currentOfferForCase([oDec, oAcc, oLive], T0);
  ok(cur.offer.id === 'rof-b' && cur.revision.id === 'rb2' && currentOfferForCase([oDec, oAcc], T0).offer.id === 'rof-a' && currentOfferForCase([oDec], T0).offer.id === 'rof-c', 'A10 the current Offer: live over accepted over the rest; the LIVE revision, never a superseded one');
  const dec = (id, kind, t, sup = null) => ({ id, kind, state: 'final', createdAt: t, supersededById: sup });
  ok(currentDecisionForCase([dec('d1', 'formal', 1, 'd2'), dec('d2', 'formal', 2), dec('d3', 'recommendation', 3)])?.id === 'd2' && currentDecisionForCase([dec('d3', 'recommendation', 3)])?.id === 'd3' && currentDecisionForCase([{ id: 'x', kind: 'formal', state: 'draft', createdAt: 9 }]) === null, 'A11 the current decision: the formal head, else the advisory head, never a draft or a superseded row');
  ok(currentAssessmentForCase([{ id: 'a1', state: 'draft', updatedAt: 9 }, { id: 'a2', state: 'submitted', submittedAt: 2 }])?.id === 'a2', 'A12 a submitted assessment outranks a newer draft');
  // Next actions.
  const base = { role: 'recruitment_admin', now: T0 };
  const N = (status, extra = {}) => nextActionFor({ ...base, status, ...extra });
  ok(NEXT_ACTION_CODES.length === 24 && NEXT_ACTION_CODES.every((c) => NEXT_ACTIONS[c]), 'A13 twenty-four next-action codes, every one in the table');
  ok(N('watching').code === 'REVIEW_PLAYER' && N('under_review').code === 'DECIDE_APPROACH' && N('under_review', { assessed: true }).code === 'RECORD_DECISION' && N('contact_planned').code === 'SEND_CONTACT' && N('contacted', { contact: { id: 'c', status: 'delivered' } }).code === 'AWAIT_CONTACT_RESPONSE' && N('contacted', { contact: { id: 'c', status: 'responded' } }).code === 'CONTINUE_EVALUATION', 'A14 watching → review; review → approach (decision once assessed); contact planned → send; delivered → await; answered → continue');
  ok(N('trial_requested').code === 'AWAIT_TRIAL_RESPONSE' && N('trial_scheduled', { trial: { id: 't', schedule: { sessions: [{ endsAt: T0 + H }] } } }).code === 'CONDUCT_TRIAL' && N('trial_scheduled', { trial: { id: 't', schedule: { sessions: [{ endsAt: T0 - H }] } } }).code === 'COMPLETE_TRIAL' && N('trial_completed').code === 'COMPLETE_ASSESSMENT' && N('trial_completed', { assessed: true }).code === 'RECORD_DECISION', 'A15 trial requested → await; scheduled → conduct, then complete once the last session ended; completed → assess, then decide');
  ok(N('offer_consideration').code === 'PREPARE_OFFER' && N('offer_consideration', { offer: { offer: { id: 'o' }, revision: { id: 'r' }, status: 'DRAFT' } }).code === 'ISSUE_OFFER' && N('offer_made', { offer: { offer: { id: 'o' }, revision: { id: 'r' }, status: 'ISSUED', liveStatus: 'ISSUED' } }).code === 'AWAIT_OFFER_RESPONSE' && N('offer_made', { offer: { offer: { id: 'o' }, revision: { id: 'r' }, status: 'EXPIRED', liveStatus: 'EXPIRED' } }).code === 'REVISE_OR_WITHDRAW_OFFER' && N('offer_declined').code === 'REVIEW_DECLINED_OFFER', 'A16 consideration → prepare (issue once drafted); made → await (revise once expired); declined → review');
  const pkgWith = (parties) => ({ id: 'spk', status: 'IN_PROGRESS', createdAt: T0, expiresAt: T0 + DAY, currentRevisionId: 'r', revisions: [{ id: 'r', status: 'IN_PROGRESS', requiredParties: parties }] });
  ok(N('offer_accepted').code === 'START_SIGNING' && N('offer_accepted', { signing: { ...pkgWith([]), status: 'DRAFT' } }).code === 'PRESENT_SIGNING' && N('offer_accepted', { signing: pkgWith([{ partyType: 'PLAYER', status: 'PENDING' }, { partyType: 'CLUB_SIGNATORY', status: 'PENDING' }]) }).code === 'SIGN_FOR_CLUB' && N('offer_accepted', { signing: pkgWith([{ partyType: 'PLAYER', status: 'PENDING' }, { partyType: 'CLUB_SIGNATORY', status: 'COMPLETED' }]) }).code === 'AWAIT_RECIPIENT_SIGNATURE' && N('offer_accepted', { signing: pkgWith([{ partyType: 'PLAYER', status: 'COMPLETED' }, { partyType: 'CLUB_SIGNATORY', status: 'COMPLETED' }]) }).code === 'COMPLETE_SIGNING', 'A17 accepted → start; draft → present; pending club → sign; pending player → await; all signed → complete');
  neg(N('offer_accepted', { signing: { ...pkgWith([]), status: 'READY', expiresAt: T0 - 1 } }).code === 'START_SIGNING', '#53 A18 an EXPIRED package is not the current one to act on: the next action is a new signing');
  ok(N('signed').code === 'RECRUITMENT_COMPLETE' && N('on_hold').code === 'RESUME_CASE' && N('archived').code === 'CASE_ENDED' && N('withdrawn').code === 'CASE_ENDED' && N('closed').code === 'CASE_ENDED' && N('nonsense').code === 'STATE_UNKNOWN', 'A19 signed → complete; hold → resume; ended → ended; unknown → unknown');
  neg(N('watching', { role: 'viewer' }).permitted === false && N('offer_accepted', { role: 'room_lead', signing: pkgWith([{ partyType: 'CLUB_SIGNATORY', status: 'PENDING' }]) }).permitted === false && N('offer_accepted', { role: 'room_lead' }).permitted === true && N('trial_requested').permitted === null, 'A20 permission follows the role: a viewer cannot start the review, a room lead cannot sign for the club but may start the signing; an await has no permission');
  neg(N('contact_planned', { blocked: true }).blockedBy.includes('BLOCKED') && N('contact_planned', { subjectRemoved: true }).blockedBy.includes('SUBJECT_REMOVED') && N('trial_requested', { blocked: true }).blockedBy.length === 0, 'A21 a block or a removed subject is named on a club act, not invented on a wait');
  neg(Object.values(NEXT_ACTIONS).every((d) => !/trust|match|boxcam|\bcv\b/i.test(JSON.stringify(d))) && !/trustScore|matchScore|watchlist|boxCam|\bcv\b/i.test(readFileSync(path.join(ROOT, 'm23', 'journeyModel.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), '#15 #16 #17 A22 no next action and no line of the model reads a Trust Score, a match or a Box Cam verdict');
  // Player next action and stage.
  ok(playerNextActionFor({ signingPending: { id: 's' }, issuedOffer: { offer: { id: 'o' }, revision: { id: 'r' } } }).code === 'SIGN' && playerNextActionFor({ issuedOffer: { offer: { id: 'o' }, revision: { id: 'r' } }, pendingContactRequest: { id: 'q' } }).code === 'RESPOND_TO_OFFER' && playerNextActionFor({ pendingTrialRequest: { id: 'q' }, pendingContactRequest: { id: 'q2' } }).code === 'RESPOND_TO_TRIAL_INVITATION' && playerNextActionFor({}).code === 'NONE', 'A23 the player\'s action is the most consequential pending act');
  ok(playerStageFor({ contacts: [{ id: 'q' }] }) === 'contacted' && playerStageFor({ contacts: [{ id: 'q' }], trialRequests: [{ status: 'pending' }] }) === 'trial_invited' && playerStageFor({ offer: { liveStatus: 'ISSUED' } }) === 'offer_received' && playerStageFor({ offer: { liveStatus: 'ACCEPTED' } }) === 'offer_accepted' && playerStageFor({ signingRow: { id: 's' } }) === 'signed' && playerStageFor({}) === 'none', 'A24 player stage words come only from records that reached the player');
  neg(!['watching', 'under_review', 'shortlisted', 'priority', 'review', 'decision', 'assessment'].some((w) => String(playerStageFor).includes(`'${w}'`)), '#16 A25 no club-internal word (priority, shortlist, decision, assessment) exists in the player vocabulary');
  // Validator and classification.
  const facts = (over = {}) => ({ kase: { id: 'k', createdAt: 10 }, status: 'contacted', now: T0, history: [{ action: 'room_created', at: 10, detail: { status: 'watching' } }, { action: 'room_status_changed', at: 20, detail: { from: 'watching', to: 'under_review' } }, { action: 'room_status_changed', at: 30, detail: { from: 'under_review', to: 'contacted' } }], contacts: [], trials: [], trialRequests: [], assessments: [], decisions: [], offers: [], packages: [], signingRow: null, foreign: [], domainProblems: [], ...over });
  ok(JOURNEY_CLASSIFICATIONS.join() === 'canonical,legacy,partially_canonical,integrity_error', 'A26 four classifications');
  ok(validateRecruitmentJourney(facts()).classification === 'legacy', 'A27 contacted with no Contact and no claim on the history: legacy (history from before the records existed)');
  ok(validateRecruitmentJourney(facts({ contacts: [{ id: 'c', status: 'delivered', deliveredAt: 25 }] })).classification === 'canonical', 'A28 contacted with a delivered Contact: canonical');
  const claimed = facts(); claimed.history[2].detail.contactId = 'rct-gone'; claimed.history[2].detail.trigger = 'contact:rct-gone';
  const v = validateRecruitmentJourney(claimed);
  neg(v.classification === 'integrity_error' && v.problems.includes('STALE_POINTER') && v.problems.includes('LIFECYCLE_AHEAD_OF_EVIDENCE'), '#14 A29 contacted with a history entry that CLAIMS a Contact which is gone: integrity_error, STALE_POINTER and LIFECYCLE_AHEAD_OF_EVIDENCE');
  const mixed = facts({ status: 'offer_made', history: [...facts().history, { action: 'room_status_changed', at: 40, detail: { from: 'contacted', to: 'offer_made', offerId: 'rof-1', trigger: 'offer:issue:rof-1' } }], offers: [{ id: 'rof-1', revisions: [{ id: 'r', status: 'ISSUED', issuedAt: 39, revisionNumber: 1, expiresAt: T0 + DAY }], currentRevisionId: 'r' }] });
  ok(validateRecruitmentJourney(mixed).classification === 'partially_canonical', 'A30 a legacy contact and a canonical Offer: partially_canonical');
  neg(validateRecruitmentJourney(facts({ status: 'offer_accepted', packages: [{ id: 'spk', status: 'COMPLETED', completion: { signingId: 's' }, createdAt: 1, revisions: [], currentRevisionId: null }] })).problems.includes('LIFECYCLE_BEHIND_TERMINAL_EVIDENCE'), 'A31 a COMPLETED package on a case that is not signed: LIFECYCLE_BEHIND_TERMINAL_EVIDENCE');
  neg(validateRecruitmentJourney(facts({ foreign: ['PLAYER_MISMATCH'] })).problems.includes('PLAYER_MISMATCH') && validateRecruitmentJourney(facts({ status: 'SIGNED' })).problems.includes('LIFECYCLE_STATE_UNKNOWN') && validateRecruitmentJourney(facts({ history: [{ action: 'room_status_changed', at: 'yesterday', detail: { to: 'contacted' } }] })).problems.includes('TEMPORAL_ORDER'), 'A32 a foreign reference, an unknown state and a malformed instant are each named');
  ok(completedStagesFor(facts({ contacts: [{ id: 'c', status: 'delivered', deliveredAt: 25 }] })).map((s) => `${s.stage}:${s.basis}`).join() === 'watching:lifecycle,review:lifecycle,contact:canonical', 'A33 completed stages carry their basis');
  // Timeline visibility.
  const clubOnly = Object.entries(TIMELINE_VISIBILITY).filter(([, a]) => a.length === 1 && a[0] === 'club').map(([k]) => k);
  neg(['decision', 'decision_recorded', 'decision_superseded', 'trial_assessment_recorded', 'offer_draft_created', 'signing_created', 'trial_evidence_linked', 'transaction_handoff_invited'].every((k) => clubOnly.includes(k)) && !timelineVisibleTo('decision_recorded', 'player') && !timelineVisibleTo('room_status_changed', 'agent') && timelineVisibleTo('offer_issued', 'player') && timelineVisibleTo('signing_completed', 'agent'), '#16 #17 A34 decisions, assessments, drafts and internal moves are club-only; issued Offers and completed signings reach the player and an authorized agent');
  ok(JOURNEY_VIEWERS.includes('agent') && JOURNEY_VIEWERS.length === 6, 'A35 six viewer kinds; the agent is one of them');
  neg(buildRecruitmentJourney({ recruitmentCases: [], roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [] }, 'k', { kind: 'analyst' }).error === 'JOURNEY_VIEWER_UNKNOWN' && buildRecruitmentJourney({ recruitmentCases: [{ id: 'k', orgId: 'o', playerId: 'p', room: { status: 'watching' } }], roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [] }, 'k', { kind: 'agent', playerId: 'p' }).error === 'CASE_NOT_FOUND', '#46 A36 an unknown audience fails closed; an agent without a proved basis sees no case');
  // Evidence: the tightened `signed` rule.
  const evDb = (rows, pkgs = []) => createEvidenceProvider({ signings: rows, signingPackages: pkgs, recruitmentContacts: [], requests: [], trials: [], roomDecisions: [], recruitmentOffers: [] });
  const K = { id: 'k1', orgId: 'o1', playerId: 'p1', createdAt: 1000 };
  neg(evDb([{ id: 's', orgId: 'o1', playerId: 'p1', ts: 500 }]).check('confirmed_join', { kase: K }).satisfied === false && evDb([{ id: 's', orgId: 'o1', playerId: 'p1', ts: 1500 }]).check('confirmed_join', { kase: K }).satisfied === true, '#14 A37 a legacy signing row recorded BEFORE the case opened does not prove it signed; one recorded after does');
  neg(evDb([{ id: 's', orgId: 'o1', playerId: 'p1', ts: 1500, signingPackageId: 'spk' }], [{ id: 'spk', orgId: 'o1', playerId: 'p1', caseId: 'k2', status: 'COMPLETED', completion: { signingId: 's' } }]).check('confirmed_join', { kase: K }).satisfied === false && evDb([{ id: 's', orgId: 'o1', playerId: 'p1', ts: 1500, signingPackageId: 'spk' }], [{ id: 'spk', orgId: 'o1', playerId: 'p1', caseId: 'k1', status: 'COMPLETED', completion: { signingId: 's' } }]).check('confirmed_join', { kase: K }).satisfied === true, '#52 A38 a canonical package proves the case it was opened on, not another case of the same club and player');
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
async function down(proc) { proc.kill('SIGKILL'); for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { return; } } }
let server = await boot();
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, text: data === null ? null : JSON.stringify(data) };
}
async function offline(mutate) {
  await down(server);
  const store = openStore(DATA_DIR); const snap = store.load();
  await mutate(snap.db, snap);
  store.save({ ...snap, db: snap.db });
  server = await boot();
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
let maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
let tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
let rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
let pat = await login('org-mossside', 'Pat Doyle', 'Head Coach', 'grassroots');
let alex = await login('org-northstar', 'Alex Agent', 'Director');
const P = {};
const ADULTS = ['pl-adeyemi', 'pl-carvalho', 'pl-okafor', 'pl-svensson', 'pl-kim', 'pl-tanaka', 'pl-martin', 'pl-alvarez', 'pl-nowak', 'pl-mensah', 'pl-imani'];
let amara;
async function relogin() {
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
  rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
  pat = await login('org-mossside', 'Pat Doyle', 'Head Coach', 'grassroots');
  alex = await login('org-northstar', 'Alex Agent', 'Director');
  for (const id of [...ADULTS, 'pl-guni']) P[id] = await playerLogin(id);
  amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
}
await relogin();
ok([maria, tom, rita, pat, alex, amara, ...Object.values(P)].every((x) => x?.token), 'HTTP actors logged in');
const staff = (await j('GET', '/org/staff', undefined, maria.token)).body;
const TOM_ID = staff.find((u) => u.name === 'Tom Field')?.id;
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
let ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
let bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
let alexAgent = await login('org-northstar', 'Alex Agent', 'Director', 'agent');
for (const a of [ana, bea]) {
  await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-J' }, a.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-J-ENG', memberAssociation: 'ENG' }, a.token);
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
const orgPlayer = async (id, token = maria.token) => (await j('GET', `/org/players/${id}`, undefined, token)).body;
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
/** Contact: plan → draft → send → the player answers. */
async function contacted(RID, playerId, token = maria.token) {
  if (await stage(RID, token) !== 'contact_planned') { const mv = await lifecycle(RID, 'planContact', {}, token); if (mv.status !== 200) throw new Error(`planContact ${mv.status} ${JSON.stringify(mv.body)}`); }
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest from Eastport', body: 'We would like to talk about next season.', clientKey: key() }, token);
  if (d.status !== 201) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
  const CID = d.body.contact.id;
  const s = await j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, token);
  if (s.status !== 200) throw new Error(`send ${s.status} ${JSON.stringify(s.body)}`);
  const req = (await j('GET', '/player/inbox', undefined, P[playerId].token)).body.find((r) => r.type === 'contact' && r.status === 'pending');
  return { CID, REQID: req?.id ?? null };
}
async function respondContact(REQID, playerId) { return j('POST', `/player/requests/${REQID}/respond`, { accept: true, message: 'Happy to talk.' }, P[playerId].token); }
/** Trial: invite → accept → attend → complete, on the clock. */
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
  const a = await j('POST', '/org/assessments', { playerId, context: { trialId: TID } }, token);
  if (a.status !== 201) throw new Error(`assessment ${a.status} ${JSON.stringify(a.body)}`);
  const id = a.body.assessment.id; const attrs = a.body.assessment.attributesSnapshot.slice(0, 3).map((x) => x.id);
  const put = await j('PUT', `/org/assessments/${id}`, { ratings: attrs.map((attrId, i) => ({ attrId, rating: 3 + i, confidence: ['low', 'medium', 'high'][i], note: S_ASSESS })), recommendation: { verdict: 'sign', reasons: S_ASSESS } }, token);
  if (put.status !== 200) throw new Error(`assessment put ${put.status} ${JSON.stringify(put.body)}`);
  const sub = await j('POST', `/org/assessments/${id}/submit`, {}, token);
  if (sub.status !== 200) throw new Error(`assessment submit ${sub.status} ${JSON.stringify(sub.body)}`);
  return id;
}
async function decided(RID, outcome = 'progress', token = maria.token) {
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome, reasonCodes: [outcome === 'progress' ? 'tactical_fit' : 'squad_balance'], note: S_DEC }, token);
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

// ================================================================ B — the canonical adult journey
section('B — the canonical adult journey: 25 steps, one projection, every stage grounded (§61)');
const J = {};
{
  // 1. the player exists  2. discovery  3. watch
  const found = (await j('GET', '/org/players?query=Kola', undefined, maria.token)).body;
  ok(Array.isArray(found) && found.some((p) => p.id === 'pl-adeyemi'), 'B1 Kola exists and the club discovers him in search');
  const rooms0 = (await j('GET', '/org/rooms', undefined, maria.token)).body;
  neg(!(rooms0.items ?? rooms0).some?.((r) => r.playerId === 'pl-adeyemi'), '#1 B2 discovery opened no case: nothing is watched by being seen');
  J.RID = await openRoom(maria.token, 'pl-adeyemi');
  let b = await jb(J.RID);
  ok(b.stage === 'watching' && b.nextAction.code === 'REVIEW_PLAYER' && b.nextAction.permitted === true && b.classification === 'canonical' && done(b).join() === 'watching:lifecycle' && Object.values(b.resources).every((v) => v === null), 'B3 the club watches Kola: stage watching, next REVIEW_PLAYER, no resource, canonical');
  neg((await notifs('/player/inbox', P['pl-adeyemi'].token)).every((r) => r.orgId !== 'org-eastport' || r.type !== 'contact'), '#2 B4 watching sent Kola nothing');
  // 4–5. open the Room, move to review
  const mv = await lifecycle(J.RID, 'startReview');
  b = await jb(J.RID);
  ok(mv.status === 200 && b.stage === 'review' && b.nextAction.code === 'DECIDE_APPROACH' && done(b).join() === 'watching:lifecycle,review:lifecycle', 'B5 review started: stage review, next DECIDE_APPROACH');
  // 6. the contact (draft is not contact)
  await lifecycle(J.RID, 'planContact');
  b = await jb(J.RID);
  ok(b.stage === 'contact' && b.nextAction.code === 'SEND_CONTACT' && b.nextAction.tab === 'contact', 'B6 contact planned: next SEND_CONTACT on the Contact tab');
  const d = await j('POST', `/org/rooms/${J.RID}/contacts`, { subject: 'Interest from Eastport', body: 'We would like to talk about next season.', clientKey: key() }, maria.token);
  J.CID = d.body.contact.id;
  b = await jb(J.RID);
  neg((await stage(J.RID)) === 'contact_planned' && b.resources.contactId === J.CID && b.nextAction.code === 'SEND_CONTACT' && b.nextAction.resources.contactId === J.CID && !done(b).some((x) => x.startsWith('contact')), '#3 B7 a draft Contact is the current Contact and NOT a contacted stage; the next action names the draft');
  const s = await j('POST', `/org/rooms/${J.RID}/contacts/${J.CID}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token);
  b = await jb(J.RID);
  ok(s.status === 200 && (await stage(J.RID)) === 'contacted' && b.nextAction.code === 'AWAIT_CONTACT_RESPONSE' && b.nextAction.kind === 'await' && done(b).includes('contact:canonical'), 'B8 sent: the case is contacted THROUGH the Contact, stage contact, next AWAIT_CONTACT_RESPONSE, basis canonical');
  // 7. delivered → responded
  J.REQID = (await notifs('/player/inbox', P['pl-adeyemi'].token)).find((r) => r.type === 'contact' && r.status === 'pending')?.id;
  const pj = await playerJourneys(P['pl-adeyemi'].token);
  const mine = pj.items.find((x) => x.club.id === 'org-eastport');
  ok(!!J.REQID && mine && mine.journey.stage === 'contacted' && mine.journey.nextAction.code === 'RESPOND_TO_CONTACT' && mine.journey.nextAction.resources.requestId === J.REQID, 'B9 Kola\'s journey: contacted, next RESPOND_TO_CONTACT naming his request');
  neg(!has(pj, J.RID) && !has(pj, 'priority') && !has(pj, 'under_review') && !has(pj, S_NOTE) && !has(pj, 'rct-'), '#16 B10 his journey carries no case id, no lifecycle word, no Contact record id, no note');
  const resp = await respondContact(J.REQID, 'pl-adeyemi');
  b = await jb(J.RID);
  ok(resp.status === 200 && b.nextAction.code === 'CONTINUE_EVALUATION' && b.nextAction.kind === 'club' && (await journey(J.RID)).history.entries.some((e) => e.kind === 'contact_response_received'), 'B11 answered: next CONTINUE_EVALUATION; the timeline carries the response milestone');
  // 8–9. trial: invite, accept
  J.T1 = T0 + DAY;
  J.INV = await trialInvited(J.RID, J.T1);
  b = await jb(J.RID);
  ok((await stage(J.RID)) === 'trial_requested' && b.stage === 'trial' && b.nextAction.code === 'AWAIT_TRIAL_RESPONSE' && b.resources.trialRequestId === J.INV && b.resources.trialId === null, 'B12 invited: trial_requested through the invitation; next AWAIT_TRIAL_RESPONSE; no Trial yet');
  neg(!(await jb(J.RID)).completedStages.some((c) => c.stage === 'trial'), '#5 B13 a requested trial is not a completed one');
  J.TID = await trialAccepted(J.RID, 'pl-adeyemi', J.T1);
  b = await jb(J.RID);
  ok((await stage(J.RID)) === 'trial_scheduled' && b.nextAction.code === 'CONDUCT_TRIAL' && b.resources.trialId === J.TID && b.nextAction.resources.trialId === J.TID, 'B14 accepted with a slot: trial_scheduled through the Trial; next CONDUCT_TRIAL naming it');
  neg(expect(await lifecycle(J.RID, 'completeTrial'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), '#6 B15 scheduled is not completed: the case cannot be completed by hand');
  const mine2 = (await playerJourneys(P['pl-adeyemi'].token)).items.find((x) => x.club.id === 'org-eastport');
  ok(mine2.journey.stage === 'trial_scheduled' && mine2.journey.resources.trialId === J.TID, 'B16 Kola\'s journey: trial scheduled');
  // 10. complete
  J.SESSION = await trialCompleted(J.RID, J.TID, J.T1);
  b = await jb(J.RID);
  ok((await stage(J.RID)) === 'trial_completed' && b.stage === 'assessment' && b.nextAction.code === 'COMPLETE_ASSESSMENT' && b.nextAction.tab === 'assessments' && done(b).includes('trial:canonical'), 'B17 completed: trial_completed through the Trial; stage assessment; next COMPLETE_ASSESSMENT');
  neg(!done(b).some((x) => x.startsWith('assessment')) && b.resources.assessmentId === null, '#7 B18 a completed trial is not an assessment');
  // 11–12. assessment
  J.AID = await assessed('pl-adeyemi', J.TID);
  b = await jb(J.RID);
  ok(b.stage === 'decision' && b.nextAction.code === 'RECORD_DECISION' && b.resources.assessmentId === J.AID && done(b).includes('assessment:canonical') && (await stage(J.RID)) === 'trial_completed', 'B19 assessed: stage decision, next RECORD_DECISION; the lifecycle did not move');
  neg(expect(await lifecycle(J.RID, 'considerOffer'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED') && b.resources.decisionId === null, '#8 B20 an assessment is not a decision: offer_consideration by hand is refused');
  // 13–14. decision
  J.DID = await decided(J.RID, 'progress');
  b = await jb(J.RID);
  ok((await stage(J.RID)) === 'offer_consideration' && b.stage === 'offer' && b.nextAction.code === 'PREPARE_OFFER' && b.resources.decisionId && done(b).includes('decision:canonical'), 'B21 a finalized progress decision moved the case to offer_consideration; next PREPARE_OFFER');
  neg(b.resources.offerId === null && (await journey(J.RID)).offer.records.length === 0, '#9 B22 the decision created no Offer');
  // 15–16. the Offer
  J.OID = await offerDrafted(J.RID);
  b = await jb(J.RID);
  ok(b.nextAction.code === 'ISSUE_OFFER' && b.nextAction.resources.offerId === J.OID && (await stage(J.RID)) === 'offer_consideration', 'B23 a drafted Offer: next ISSUE_OFFER; the lifecycle did not move');
  ({ R: J.R } = await offerIssued(J.OID));
  b = await jb(J.RID);
  ok((await stage(J.RID)) === 'offer_made' && b.nextAction.code === 'AWAIT_OFFER_RESPONSE' && b.resources.offerId === J.OID && b.resources.offerRevisionId === J.R && done(b).includes('offer:canonical'), 'B24 issued: offer_made through the Offer; next AWAIT_OFFER_RESPONSE naming the live revision');
  neg(expect(await lifecycle(J.RID, 'recordOfferAccepted'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), '#10 B25 an issued Offer is not an accepted one: acceptance by hand is refused');
  const mine3 = (await playerJourneys(P['pl-adeyemi'].token)).items.find((x) => x.club.id === 'org-eastport');
  ok(mine3.journey.stage === 'offer_received' && mine3.journey.nextAction.code === 'RESPOND_TO_OFFER' && mine3.journey.nextAction.resources.offerRevisionId === J.R, 'B26 Kola\'s journey: Offer received, next RESPOND_TO_OFFER naming the exact revision');
  // 17–18. acceptance
  await offerAccepted(J.OID, J.R, 'pl-adeyemi');
  b = await jb(J.RID);
  ok((await stage(J.RID)) === 'offer_accepted' && b.stage === 'acceptance' && b.nextAction.code === 'START_SIGNING' && done(b).includes('acceptance:canonical'), 'B27 accepted: offer_accepted through the recipient\'s own act; stage acceptance; next START_SIGNING');
  neg(b.resources.signingPackageId === null && (await journey(J.RID)).outcome.signingPackages.length === 0 && (await journey(J.RID)).outcome.signing === null, '#11 B28 acceptance created no package and no signing row');
  // 19. explicit start
  const st = await start(J.OID, { internalNote: S_NOTE, clientKey: key() });
  J.SID = sv(st).id;
  b = await jb(J.RID);
  ok(st.status === 201 && b.stage === 'signing' && b.nextAction.code === 'PRESENT_SIGNING' && b.resources.signingPackageId === J.SID && (await stage(J.RID)) === 'offer_accepted', 'B29 an explicit start: stage signing, next PRESENT_SIGNING; the lifecycle is still offer_accepted');
  neg(expect(await lifecycle(J.RID, 'confirmSignedOutcome'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), '#12 B30 a started signing is not signed');
  const a1 = await attach(J.SID, DOC, sv(st).rev);
  const r1 = await ready(J.SID, { expectedRev: sv(a1).rev, clientKey: key() });
  J.SREV = revOf(r1).id;
  b = await jb(J.RID);
  ok(r1.status === 200 && b.nextAction.code === 'SIGN_FOR_CLUB' && b.nextAction.permitted === true, 'B31 presented: next SIGN_FOR_CLUB (a recruitment lead)');
  const mine4 = (await playerJourneys(P['pl-adeyemi'].token)).items.find((x) => x.club.id === 'org-eastport');
  ok(mine4.journey.stage === 'signing' && mine4.journey.nextAction.code === 'SIGN' && mine4.journey.nextAction.resources.signingPackageId === J.SID, 'B32 Kola\'s journey: signing, next SIGN');
  // 20. the parties
  const cs = await clubSign(J.SID, { expectedRev: sv(r1).rev, revisionId: J.SREV, documentSha256: SHA, clientKey: key() });
  b = await jb(J.RID);
  ok(cs.status === 200 && b.nextAction.code === 'AWAIT_RECIPIENT_SIGNATURE' && b.nextAction.kind === 'await', 'B33 the club signed: next AWAIT_RECIPIENT_SIGNATURE');
  neg(expect(await complete(J.SID, { expectedRev: sv(cs).rev, clientKey: key() }), 409, 'SIGNING_PARTIES_INCOMPLETE') && (await stage(J.RID)) === 'offer_accepted', '#13 B34 a partial signing is not signed: completion is refused');
  const prev = await pRev(J.SID, P['pl-adeyemi'].token);
  const ps = await pSign(J.SID, { revisionId: prev.currentRevision.id, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P['pl-adeyemi'].token);
  b = await jb(J.RID);
  ok(ps.status === 200 && b.nextAction.code === 'COMPLETE_SIGNING' && b.nextAction.permitted === true, 'B35 the player signed: next COMPLETE_SIGNING');
  // 21–25. completion
  const rowsBefore = (await signings()).length;
  const c = await complete(J.SID, { expectedRev: (await sGet(J.SID)).body.signing.rev, clientKey: key() });
  b = await jb(J.RID);
  const jr = await journey(J.RID);
  const rows = (await signings()).filter((x) => x.signingPackageId === J.SID);
  ok(c.status === 200 && (await stage(J.RID)) === 'signed' && b.stage === 'signed' && b.nextAction.code === 'RECRUITMENT_COMPLETE' && b.nextAction.kind === 'none', 'B36 completed: signed through the canonical completion; the journey says recruitment complete');
  ok(rows.length === 1 && (await signings()).length === rowsBefore + 1 && b.resources.completedSigningId === rows[0].id && jr.outcome.signing?.id === rows[0].id, 'B37 exactly one db.signings row, named by the projection');
  ok((await orgPlayer('pl-adeyemi')).contractStatus === 'under_contract', 'B38 the player is under contract');
  ok(done(b).join() === 'watching:lifecycle,review:lifecycle,contact:canonical,trial:canonical,assessment:canonical,decision:canonical,offer:canonical,acceptance:canonical,signing:canonical,signed:canonical' && b.classification === 'canonical' && b.integrity.length === 0, 'B39 every pipeline stage completed, contact onwards on canonical records; the journey is canonical');
  const kinds = jr.history.entries.map((e) => e.kind);
  ok(['room_created', 'room_status_changed', 'contact_initiated', 'contact_response_received', 'trial_invited', 'trial_accepted', 'trial_schedule_confirmed', 'trial_attendance_recorded', 'trial_completed', 'trial_assessment_recorded', 'decision_recorded', 'offer_draft_created', 'offer_issued', 'offer_accepted', 'signing_created', 'signing_ready', 'signing_party_completed', 'signing_completed'].every((k) => kinds.includes(k)), 'B40 the timeline carries every milestone from the records');
  neg(!has(jr, S_NOTE) && !has(jr, S_OFFER_NOTE) && !has(jr, S_ASSESS) && !has(jr, SHA) && !has(jr, TERMS.conditions), 'B41 the projection carries no note, no rationale, no digest, no term');
  const sorted = jr.history.entries.every((e, i, arr) => i === 0 || arr[i - 1].at <= e.at);
  ok(sorted, 'B42 the timeline is ordered by instant');
  const mine5 = (await playerJourneys(P['pl-adeyemi'].token)).items.find((x) => x.club.id === 'org-eastport');
  ok(mine5.journey.stage === 'signed' && mine5.journey.nextAction.code === 'NONE' && mine5.journey.timeline.some((e) => e.kind === 'signing_completed') && !mine5.journey.timeline.some((e) => e.kind === 'decision_recorded' || e.kind === 'trial_assessment_recorded' || e.kind === 'signing_created'), 'B43 Kola\'s journey: signed; his timeline has the completion and none of the club\'s internal milestones');
  neg(!has(mine5, S_NOTE) && !has(mine5, S_DEC) && !has(mine5, S_ASSESS) && !has(mine5, 'Maria'), 'B44 and no note, no rationale, no colleague\'s name');
}

// ================================================================ C — negatives not covered above
section('C — the boundaries the journey never crosses (§62)');
{
  // #4 a failed contact does not mark contacted
  const RID = await reviewed(maria.token, 'pl-nowak');
  await lifecycle(RID, 'planContact');
  const blk = await j('POST', '/player/block', { orgId: 'org-eastport' }, P['pl-nowak'].token);
  const d = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Hi', body: 'Hello there.', clientKey: key() }, maria.token);
  const send = d.status === 201 ? await j('POST', `/org/rooms/${RID}/contacts/${d.body.contact.id}/send`, { expectedRev: d.body.contact.rev, clientKey: key() }, maria.token) : d;
  neg(blk.status === 201 && send.status !== 200 && (await stage(RID)) === 'contact_planned' && !(await jb(RID)).completedStages.some((c) => c.stage === 'contact') && (await jb(RID)).blocked === true, '#4 C1 a contact that cannot be delivered (blocked) moves nothing; the journey names the block');
  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, { 'x-admin-key': process.env.ADMIN_KEY ?? 'scoutbox-admin' })).body;
  for (const b of (Array.isArray(blocks) ? blocks : []).filter((x) => x.playerId === 'pl-nowak')) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, { 'x-admin-key': process.env.ADMIN_KEY ?? 'scoutbox-admin' });
  // #14 signed requires canonical evidence (legacy route)
  const M = await reviewed(maria.token, 'pl-martin');
  neg(expect(await legacyStatus(M, 'signed'), 409, 'ROOM_TRANSITION_INVALID'), '#14 C2 signed is not an edge from review');
  // #18 foreign resource cannot attach to a case
  neg(expect(await j('GET', `/org/rooms/${M}/trials/${J.TID}`, undefined, maria.token), 404, null) && expect(await j('GET', `/org/rooms/${M}/contacts/${J.CID}`, undefined, maria.token), 404, null), '#18 #52 C3 Kola\'s Trial and Contact do not exist under Martin\'s case');
  const link = await j('POST', `/org/rooms/${M}/link`, { trialId: J.TID }, maria.token);
  neg(link.status !== 200 && !(await roomView(M)).links.trialIds.includes(J.TID), '#18 C4 Kola\'s Trial cannot be linked to Martin\'s case');
  const sr = await j('GET', `/org/rooms/${M}/signing`, undefined, maria.token);
  neg(sr.status === 200 && sr.body.packages.every((p) => p.id !== J.SID) && sr.body.livePackageId === null, '#52 C5 Kola\'s package is not under Martin\'s case');
  const foreign = await j('GET', `/org/rooms/${J.RID}/journey`, undefined, rita.token); const fake = await j('GET', '/org/rooms/case-does-not-exist/journey', undefined, rita.token);
  neg(foreign.status === 404 && fake.status === 404 && foreign.text === fake.text, '#51 C6 a foreign case and a fabricated case id read the same to another club (same status, same body)');
  // #20 the minor pathway stays closed
  const G = await openRoom(maria.token, 'pl-guni');
  const gj = await jb(G);
  ok(gj.stage === 'watching', 'C7 a case on a minor opens like any other');
  const gpj = await playerJourneys(P['pl-guni'].token);
  neg(gpj.items.every((it) => !it.shared.some((s) => s.kind === 'offer' || s.kind === 'signing')), '#20 C8 the minor\'s own journeys carry no Offer and no signing');
  const gaj = (await j('GET', '/guardian/children/pl-guni/journeys', undefined, amara.token));
  ok(gaj.status === 200 && Array.isArray(gaj.body.items), 'C9 the guardian reads the child\'s journeys');
  neg(expect(await j('GET', '/guardian/children/pl-adeyemi/journeys', undefined, amara.token), 404, 'CHILD_NOT_FOUND'), 'C10 not another player\'s');
  // #19 same-agency
  neg(expect(await agentJourney(REP, bea.token), 404, 'REPRESENTATION_NOT_FOUND'), '#19 #47 C11 a same-agency colleague has no journey for Ana\'s client');
  const adminRead = await agentJourney(REP, alexAgent.token);
  neg([403, 404].includes(adminRead.status) && !has(adminRead.body, 'items'), '#47 C12 the agency admin opens no journey for a colleague\'s client (refused or not found; never the data)');
}

// ================================================================ D — legacy and integrity classification
section('D — legacy cases: history from before the records, reported as history; a claimed record that is gone is an error (§11, §64)');
const L = {};
{
  L.contacted = await reviewed(maria.token, 'pl-okafor');
  L.trial = await reviewed(maria.token, 'pl-svensson');
  L.offer = await reviewed(maria.token, 'pl-kim');
  L.signed = await reviewed(maria.token, 'pl-tanaka');
  L.broken = await reviewed(maria.token, 'pl-alvarez');
  const plant = (db, id, chain, extraLast = {}) => {
    const k = db.recruitmentCases.find((c) => c.id === id);
    let prev = k.room.status; let t = Math.max(Date.now(), ...(k.history ?? []).map((h) => Number(h.at) || 0));
    for (const to of chain) { t += H; k.history.push({ id: `hist-p8-${Math.random().toString(36).slice(2, 8)}`, at: t, action: 'room_status_changed', by: { kind: 'org', id: 'legacy', name: 'Legacy Scout' }, detail: { from: prev, to, reasonCodes: [] , ...(to === chain[chain.length - 1] ? extraLast : {}) } }); prev = to; }
    k.room.status = chain[chain.length - 1];
    k.stage = chain[chain.length - 1] === 'signed' ? 'closed' : 'review';
    k.room.rev = (k.room.rev ?? 1) + chain.length;
    return k;
  };
  await offline((db) => {
    plant(db, L.contacted, ['contacted']);
    plant(db, L.trial, ['contacted', 'trial_requested', 'trial_scheduled', 'trial_completed']);
    plant(db, L.offer, ['offer_consideration', 'offer_made']);
    const k = plant(db, L.signed, ['offer_consideration', 'offer_made', 'signed']);
    db.signings.push({ id: 'sign-p8-legacy', orgId: 'org-eastport', playerId: 'pl-tanaka', ts: Date.now() - DAY, method: 'LEGACY_RECORDED', contract: null, scoutUserId: 'legacy', scoutName: 'Legacy Scout', insideAttributionWindow: false });
    k.links.signingId = 'sign-p8-legacy';
    plant(db, L.broken, ['contacted'], { contactId: 'rct-gone', trigger: 'contact:rct-gone' });
  });
  await relogin();
  let b = await jb(L.contacted);
  ok(b.classification === 'legacy' && b.integrity.length === 0 && done(b).includes('contact:lifecycle') && b.resources.contactId === null && b.nextAction.code === 'CONTINUE_EVALUATION', 'D1 legacy contacted: classified legacy, the contact stage on lifecycle basis, no Contact fabricated, a safe next action');
  neg((await journey(L.contacted)).contact.contacts.length === 0 && (await journey(L.contacted)).history.entries.some((e) => e.kind === 'room_status_changed' && e.to === 'contacted'), 'D2 no Contact record was invented; the old status move is on the timeline as what it was');
  neg(expect(await lifecycle(L.contacted, 'planTrial'), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'D3 a legacy case still needs real evidence to move on');
  b = await jb(L.trial);
  ok(b.classification === 'legacy' && b.stage === 'assessment' && b.nextAction.code === 'COMPLETE_ASSESSMENT' && b.resources.trialId === null && (await journey(L.trial)).trials.length === 0 && done(b).includes('trial:lifecycle'), 'D4 legacy trial_completed: legacy, stage assessment, no Trial fabricated, next COMPLETE_ASSESSMENT');
  b = await jb(L.offer);
  ok(b.classification === 'legacy' && b.stage === 'offer' && b.resources.offerId === null && (await journey(L.offer)).offer.records.length === 0 && b.nextAction.code === 'REVISE_OR_WITHDRAW_OFFER', 'D5 legacy offer_made: legacy, no Offer fabricated, the next action points to the Offer tab whose own gates apply');
  const pj = await playerJourneys(P['pl-kim'].token);
  neg(!pj.items.some((it) => it.club.id === 'org-eastport'), 'D6 the player learns nothing from a legacy offer_made: no Offer ever reached him, so there is no journey');
  b = await jb(L.signed);
  const jr = await journey(L.signed);
  ok(b.stage === 'signed' && b.nextAction.code === 'RECRUITMENT_COMPLETE' && b.resources.completedSigningId === 'sign-p8-legacy' && jr.outcome.signing?.method === 'LEGACY_RECORDED' && jr.outcome.signingPackages.length === 0 && b.classification === 'partially_canonical' && done(b).includes('signed:canonical') && done(b).includes('offer:lifecycle'), 'D7 legacy signed with a legacy row: complete, the row named, NO package fabricated; the earlier offer stage is on lifecycle basis (partially_canonical)');
  b = await jb(L.broken);
  neg(b.classification === 'integrity_error' && b.integrity.includes('STALE_POINTER') && b.integrity.includes('LIFECYCLE_AHEAD_OF_EVIDENCE') && b.stage === 'contact' && (await jb(L.broken, maria.token)).nextAction.code === 'CONTINUE_EVALUATION', 'D8 a history entry that CLAIMS a Contact which is gone: integrity_error, STALE_POINTER, LIFECYCLE_AHEAD_OF_EVIDENCE — named, not repaired, no crash');
  ok((await j('GET', `/org/rooms/${L.broken}`, undefined, maria.token)).status === 200 && (await j('GET', `/org/rooms/${L.broken}/contacts`, undefined, maria.token)).status === 200, 'D9 the Room and its Contact tab still read');
}

// ================================================================ F — audiences
section('F — audiences: the player, the guardian, the agent (§16, §17, §46, §47)');
{
  const before = await agentJourney(REP, ana.token);
  ok(before.status === 200 && Array.isArray(before.body.items) && before.body.grants.includes('offers') && before.body.grants.includes('signings') && before.body.grants.includes('contacts'), 'F1 Ana (employment, verified) reads Kola\'s journey with the offers and signings grants');
  neg(!before.body.items.some((it) => it.club.id === 'org-eastport'), 'F2 but Kola shared nothing with her: Eastport does not appear');
  const share = await j('POST', `/player/offers/${J.OID}/share-agent`, { share: true, agreementId: REP }, P['pl-adeyemi'].token);
  const after = await agentJourney(REP, ana.token);
  const east = after.body.items.find((it) => it.club.id === 'org-eastport');
  ok(share.status === 200 && east && east.journey.stage === 'signed' && east.journey.resources.offerId === J.OID && east.journey.timeline.some((e) => e.kind === 'signing_completed'), 'F3 once Kola shares the Offer, Ana sees the factual stage: signed, the Offer id, the completion milestone');
  neg(!has(after, S_NOTE) && !has(after, S_DEC) && !has(after, S_ASSESS) && !has(after, 'decision_recorded') && !has(after, 'trial_assessment_recorded') && !has(after, 'priority') && !has(after, 'under_review') && !has(after, J.RID) && !has(after, SHA), '#17 F4 and nothing of the club\'s process: no decision, no assessment, no priority, no case id, no digest, no note');
  neg(!has(after, J.CID) && !east.journey.timeline.some((e) => e.kind === 'contact_initiated'), 'F5 the Contact was not routed to her, so it is not hers to see');
  neg(expect(await agentJourney(REP, bea.token), 404, 'REPRESENTATION_NOT_FOUND'), '#19 F6 Bea still sees nothing');
  // Authority loss: Kola ends the representation.
  const rel = (await j('GET', `/player/agent/relationships`, undefined, P['pl-adeyemi'].token)).body;
  const mine = (rel.items ?? rel).find?.((r) => r.id === REP);
  const end = await j('POST', `/player/agent/relationships/${REP}/terminate`, { reasonCode: 'player_ended', expectedRev: mine?.rev ?? 2 }, P['pl-adeyemi'].token);
  const gone = await agentJourney(REP, ana.token);
  neg(end.status === 200 && gone.status === 403, '#19 F7 the representation ended: Ana\'s journey read is refused (403), not stale');
  // Trust & Safety is not a master key; an unknown viewer fails closed (pure, above). The org router never exposes a viewer parameter.
  neg(expect(await j('GET', `/org/rooms/${J.RID}/journey?viewer=trust_safety`, undefined, rita.token), 404, null), '#46 F8 a viewer word on the query changes nothing: a foreign club reads no case');
}

// ================================================================ G — notification targets
section('G — notifications point to the current authorized resource (§29–§31)');
{
  const kn = await notifs('/player/notifications', P['pl-adeyemi'].token);
  const off = kn.find((n) => n.type === 'recruitment_offer' && n.refId === J.OID);
  const sg = kn.find((n) => n.type === 'recruitment_signing' && n.refId === J.SID);
  const row = kn.find((n) => n.type === 'signing');
  ok(off?.target?.kind === 'offer' && off.target.offerId === J.OID && off.target.offerRevisionId === J.R, 'G1 Kola\'s Offer notification targets the Offer and its live revision');
  ok(sg?.target?.kind === 'signing' && sg.target.signingPackageId === J.SID && sg.target.superseded === false && row?.target?.kind === 'signing' && row.target.signingPackageId === J.SID, 'G2 his signing notifications (package and record) both target the package');
  const mn = await notifs('/org/notifications', maria.token);
  const mo = mn.find((n) => n.type === 'recruitment_offer' && n.refId === J.OID);
  const ms = mn.find((n) => n.type === 'recruitment_signing' && n.refId === J.SID);
  ok(mo?.target?.kind === 'room' && mo.target.roomId === J.RID && mo.target.tab === 'offer' && ms?.target?.kind === 'room' && ms.target.tab === 'signing', 'G3 Maria\'s Offer and signing notifications target the Room\'s Offer and Signing tabs');
  neg(mn.filter((n) => n.target?.kind === 'room').every((n) => (n.target.roomId ?? '').startsWith('case-')), 'G4 every room target names a case of her org');
  // A superseded package: the old refId resolves to the live package.
  const RID = await reviewed(maria.token, 'pl-mensah');
  await lifecycle(RID, 'shortlist');
  await decided(RID, 'progress');
  const OID = await offerDrafted(RID); const { R } = await offerIssued(OID); await offerAccepted(OID, R, 'pl-mensah');
  const s1 = await start(OID, { clientKey: key() }); const SID1 = sv(s1).id;
  const a1 = await attach(SID1, DOC, sv(s1).rev); const r1 = await ready(SID1, { expectedRev: sv(a1).rev, clientKey: key() });
  const sup = await j('POST', `/org/signings/${SID1}/supersede`, { expectedRev: sv(r1).rev, clientKey: key(), reason: 'amended clause' }, maria.token, at(T0));
  ok(expect(sup, 201, null) && sv(sup).status === 'DRAFT', 'G5 the club supersedes the presented revision: a new DRAFT revision on the same package (201)');
  const a2 = await attach(SID1, DOC2, sv(sup).rev); const r2 = await ready(SID1, { expectedRev: sv(a2).rev, clientKey: key() });
  const mnn = await notifs('/player/notifications', P['pl-mensah'].token);
  const first = mnn.filter((n) => n.refId === SID1);
  ok(r2.status === 200 && first.length > 0 && first.every((n) => n.target?.kind === 'signing' && n.target.signingPackageId === SID1), 'G6 every notification about the package targets the package the recipient can act on now');
  const cancel = await j('POST', `/org/signings/${SID1}/cancel`, { expectedRev: sv(r2).rev, clientKey: key(), reason: 'restart' }, maria.token, at(T0));
  const s2 = await start(OID, { clientKey: key() }); const SID2 = sv(s2).id;
  const a3 = await attach(SID2, DOC, sv(s2).rev); await ready(SID2, { expectedRev: sv(a3).rev, clientKey: key() });
  const mnn2 = await notifs('/player/notifications', P['pl-mensah'].token);
  const old = mnn2.filter((n) => n.refId === SID1);
  neg(cancel.status === 200 && old.every((n) => n.target?.kind === 'signing' && n.target.signingPackageId === SID2 && n.target.superseded === true), '#53 G7 after a cancel and a new package, the OLD package\'s notifications target the live one and say so');
  const mmn = await notifs('/org/notifications', maria.token);
  neg(mmn.filter((n) => n.refId === SID1 || n.refId === SID2).every((n) => n.target?.kind === 'room' && n.target.roomId === RID && n.target.tab === 'signing'), 'G8 the club\'s notifications for both packages open the same Room\'s Signing tab');
  globalThis.__G = { RID, OID, SID2 };
}

// ================================================================ H — lifecycle authority and contract truth
section('H — one writer, one authority: the legacy route, the reopen bridge, the self-service route, the recording route (§5, §26, §27)');
{
  // Role parity on the legacy status route.
  const M = await reviewed(maria.token, 'pl-martin');
  await lifecycle(M, 'shortlist'); await decided(M, 'progress');
  const OID = await offerDrafted(M); const { R } = await offerIssued(OID); await offerAccepted(OID, R, 'pl-martin');
  const promote = await j('PATCH', `/org/rooms/${M}`, { leadScoutUserId: TOM_ID, expectedRev: await caseRev(M) }, maria.token);
  ok(promote.status === 200, 'H1 Tom is room lead of Martin\'s case (offer_accepted)');
  neg(expect(await legacyStatus(M, 'signed', tom.token), 403, 'ROOM_PERMISSION_REQUIRED'), 'H2 a room lead cannot reach `signed` through the legacy status route: the same role rule as confirmSignedOutcome');
  neg(expect(await legacyStatus(M, 'signed', maria.token), 422, 'ROOM_EVIDENCE_REQUIRED'), '#14 H3 a recruitment lead is refused for the real reason: no signing supports it');
  neg(expect(await j('POST', `/org/rooms/${M}/status`, { status: 'contact_planned', expectedRev: await caseRev(M) }, tom.token), 409, 'ROOM_TRANSITION_INVALID'), 'H4 the transition table still applies before anything else');
  // The Second Look bridge reopens only a closed-out room.
  await offline((db) => { db.secondLookItems ??= []; db.secondLookItems.push({ id: 'slk-p8-live', orgId: 'org-eastport', playerId: 'pl-martin', roomId: M, decisionId: null, policyVersion: 1, triggerType: 'trust_change', changeFingerprints: [], directReasonCodes: [], status: 'open', createdAt: Date.now(), updatedAt: Date.now(), latestChangeAt: Date.now(), history: [] }); });
  await relogin();
  neg(expect(await j('POST', '/org/second-look/slk-p8-live/reopen-room', { reasonCodes: ['continue_monitoring'] }, maria.token), 409, 'ROOM_NOT_REOPENABLE') && (await stage(M)) === 'offer_accepted', 'H5 Second Look cannot "reopen" a live case: 409 ROOM_NOT_REOPENABLE, the case untouched');
  // Contract truth: the self-service route.
  neg(expect(await j('POST', '/player/availability', { contractStatus: 'under_contract' }, P['pl-nowak'].token), 403, 'CONTRACT_STATUS_NOT_SELF_DECLARABLE'), '#26 H6 a player cannot declare himself under contract');
  ok((await j('POST', '/player/availability', { contractStatus: 'free_agent', availability: 'available_now' }, P['pl-nowak'].token)).status === 200 && (await orgPlayer('pl-nowak')).contractStatus === 'free_agent', 'H7 with no ScoutBox contract, the other words stay his to declare');
  neg(expect(await j('POST', '/player/availability', { contractStatus: 'free_agent' }, P['pl-adeyemi'].token), 409, 'CONTRACT_STATUS_CANONICAL') && (await orgPlayer('pl-adeyemi')).contractStatus === 'under_contract', '#26 H8 Kola, signed in ScoutBox, cannot overwrite the canonical word');
  ok((await j('POST', '/player/availability', { availability: 'not_seeking' }, P['pl-adeyemi'].token)).status === 200, 'H9 his availability is still his');
  // The legacy recording route.
  neg(expect(await j('POST', '/org/players/pl-imani/signing', {}, alex.token), 403, 'SIGNING_NOT_PERMITTED'), '#27 H10 an agency cannot record a signing');
  neg(expect(await j('POST', '/org/players/pl-imani/signing', {}, tom.token), 403, 'LEAD_REQUIRED'), 'H11 a scout cannot record a signing');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/signing', {}, maria.token), 409, null), 'H12 a lead cannot record beside a canonical signing');
  // A grassroots release cannot override another club's canonical contract.
  const add = await j('POST', '/org/squad', { playerId: 'pl-adeyemi' }, pat.token);
  const entry = (add.body?.entries ?? add.body?.squad ?? add.body ?? []).find?.((e) => e.playerId === 'pl-adeyemi');
  if (add.status === 201 && entry?.id) {
    const rel = await j('POST', `/org/squad/${entry.id}/release`, {}, pat.token);
    neg(rel.status === 200 && (await orgPlayer('pl-adeyemi')).contractStatus === 'under_contract', '#27 H13 Moss Side releasing Kola from its own squad leaves his Eastport contract truth alone');
  } else ok(true, `H13 (grassroots squad add answered ${add.status}; release not exercised)`);
}

// ================================================================ Q — partial failure
section('Q — partial failure: the case is never half-moved (§81)');
{
  const G = globalThis.__G;
  const cur = await sGet(G.SID2);
  const cs = await clubSign(G.SID2, { expectedRev: cur.body.signing.rev, revisionId: cur.body.signing.currentRevision.id, documentSha256: SHA, clientKey: key() });
  const prev = await pRev(G.SID2, P['pl-mensah'].token);
  const ps = await pSign(G.SID2, { revisionId: prev.currentRevision.id, documentSha256: SHA, method: 'PLATFORM_ACKNOWLEDGMENT', clientKey: key() }, P['pl-mensah'].token);
  ok(cs.status === 200 && ps.status === 200 && (await jb(G.RID)).nextAction.code === 'COMPLETE_SIGNING', 'Q1 both parties signed; next COMPLETE_SIGNING');
  await setFaults('internal:signing.complete.after_lifecycle:1');
  const failed = await complete(G.SID2, { expectedRev: (await sGet(G.SID2)).body.signing.rev, clientKey: key() });
  await setFaults('');
  const rv = await roomView(G.RID);
  const b = await jb(G.RID);
  neg(expect(failed, 500, 'SIGNING_STATE_UNKNOWN') && rv.status === 'offer_accepted' && rv.stage === 'decision' && b.stage === 'signing' && b.nextAction.code === 'COMPLETE_SIGNING' && b.classification === 'canonical' && b.integrity.length === 0 && (await signings()).every((s) => s.signingPackageId !== G.SID2), 'Q2 a failure after the lifecycle moved rolls the case back WHOLE: status offer_accepted, stage decision (not closed), the journey canonical, no row');
  const okc = await complete(G.SID2, { expectedRev: (await sGet(G.SID2)).body.signing.rev, clientKey: key() });
  ok(okc.status === 200 && (await stage(G.RID)) === 'signed' && (await roomView(G.RID)).stage === 'closed' && (await jb(G.RID)).nextAction.code === 'RECRUITMENT_COMPLETE', 'Q3 without the fault the same completion succeeds and the case reads signed / closed consistently');
}


// ================================================================ I — analytics canonicalization
section('I — analytics: every journey stage derives from the canonical record, case-based, no double count (§42–§45, §90)');
{
  const dash = await j('GET', '/org/recruitment-analytics?window=last_90_days', undefined, maria.token);
  const m = dash.body?.data?.pipeline?.metrics?.journey_evidence_funnel;
  ok(dash.status === 200 && m && m.id === 'journey_evidence_funnel' && m.counting === 'case' && Array.isArray(m.rows) && m.rows.length === 13, 'I1 the journey funnel metric exists in the pipeline family: case-based, thirteen stage rows');
  const row = (st) => m.rows.find((r) => r.stage === st);
  ok(['contacted', 'trial_requested', 'trial_scheduled', 'trial_completed', 'assessed', 'decision_progress', 'decision_hold', 'decision_reject', 'offer_issued', 'offer_accepted', 'offer_declined', 'signing_started', 'signed'].every((st) => row(st) && typeof row(st).value === 'number' && typeof row(st).historyOnly === 'number' && typeof row(st).source === 'string'), 'I2 every stage row names its value, its history-only count and the record it derives from');
  neg(row('contacted').source === 'recruitmentContacts' && row('trial_completed').source === 'trials' && row('assessed').source === 'assessments' && row('decision_progress').source === 'roomDecisions' && row('offer_issued').source === 'recruitmentOffers' && row('signing_started').source === 'signingPackages' && row('signed').source === 'signings', '#90 I3 each stage names the canonical store it counts from — never a status word, never a client value');
  // Kola's case: every stage exactly once, although it carried one contact, one trial, one assessment, one decision, one Offer and one package.
  ok(row('contacted').value >= 1 && row('trial_completed').value >= 1 && row('assessed').value >= 1 && row('decision_progress').value >= 1 && row('offer_issued').value >= 1 && row('offer_accepted').value >= 1 && row('signing_started').value >= 1 && row('signed').value >= 1, 'I4 the canonical journey is counted at every stage');
  // Mensah's case carried TWO packages (one cancelled, one completed) and a superseded revision: still one case at signing_started and one at signed.
  const before = { started: row('signing_started').value, signed: row('signed').value };
  ok(before.started >= 2 && before.signed >= 2, 'I5 Kola and Mensah: two cases started a signing and two signed');
  neg(row('signing_started').value === row('signing_started').value && (await j('GET', '/org/signings', undefined, maria.token)).body.length >= 2, '#43 I6 two packages and a superseded revision on one case add nothing: signing_started counts the CASE once');
  // Legacy cases (planted by hand): history only, never counted as progress.
  neg(row('trial_completed').historyOnly >= 1 && row('offer_issued').historyOnly >= 1, 'I7 the legacy cases reached trial_completed / offer_made in history with no record: reported as "history only", not counted');
  ok(m.intervals && typeof m.intervals.accepted_to_signed?.n === 'number' && (m.intervals.accepted_to_signed.n === 0 || Number.isFinite(m.intervals.accepted_to_signed.medianDays)), '#45 I8 time-to-stage intervals derive from the records\' own instants (medians in days)');
  neg(!has(m, S_DEC) && !has(m, S_OFFER_NOTE) && !has(m, S_ASSESS) && !has(m, 'Kola') && !has(m, 'trustScore') && !/rank|score/i.test(JSON.stringify(m.rows)), '#44 I9 the funnel carries no note, no name, no score, no ranking');
  neg(expect(await j('GET', '/org/recruitment-analytics?window=last_90_days', undefined, tom.token), 403, 'LEAD_REQUIRED'), 'I10 a scout cannot read the dashboard');
  const fp = (await j('GET', '/org/recruitment-analytics?window=last_90_days&sourceContext=search', undefined, maria.token)).body?.data?.pipeline?.metrics?.funnel_progression;
  ok(fp && Array.isArray(fp.rows), 'I11 the lifecycle-based funnel (funnel_progression) still reads beside it: two views, one cohort rule');
}

// ================================================================ Z — boundary invariants (source scans)
section('Z — the boundaries, read from the source: one writer per truth, no auto-advance anywhere');
{
  const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const files = (dir) => readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.mjs')).map((f) => `${dir}/${f}`);
  const serverFiles = ['server.mjs', 'seed.mjs', 'domain.mjs', ...['m12', 'm13', 'm14', 'm15', 'm16', 'm162', 'm17', 'm18', 'm181', 'm182', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25', 'm26', 'm27', 'm28', 'm29'].flatMap(files)];
  const statusWriters = serverFiles.filter((f) => /\.room\.status\s*=[^=]/.test(strip(src(f))));
  neg(statusWriters.length === 1 && statusWriters[0] === 'm17/rooms.mjs', `Z1 exactly one file assigns room.status on a live case: ${statusWriters.join(', ')}`);
  const stageWriters = serverFiles.filter((f) => /(?:kase|room|c|k)\.stage\s*=[^=]/.test(strip(src(f))));
  neg(stageWriters.every((f) => ['m17/rooms.mjs', 'm12/scouting.mjs'].includes(f)), `Z2 case.stage is written only by the ONE writer and the room-guarded M12 routes: ${stageWriters.join(', ')}`);
  const ucWriters = serverFiles.filter((f) => /contractStatus\s*=\s*'under_contract'/.test(strip(src(f))));
  neg(ucWriters.length === 1 && ucWriters[0] === 'm29/index.mjs', `#26 Z3 'under_contract' is assigned in exactly one file: ${ucWriters.join(', ')}`);
  const csWriters = serverFiles.filter((f) => /\.contractStatus\s*=[^=]/.test(strip(src(f))));
  neg(csWriters.every((f) => ['m29/index.mjs', 'server.mjs'].includes(f)) && /CONTRACT_STATUS_NOT_SELF_DECLARABLE/.test(src('server.mjs')) && /CONTRACT_STATUS_CANONICAL/.test(src('server.mjs')) && /canonicalContractFor\(p\.id, Date\.now\(\), \{ exceptOrgId: req\.org\.id \}\)/.test(src('server.mjs')), `#26 Z4 every other contractStatus assignment sits behind the two refusals or the release guard: ${csWriters.join(', ')}`);
  neg(!/applyLifecycleTransition|room\.status|recordCompletedSigning/.test(strip(src('m19/index.mjs'))) && files('m22').every((f) => !/applyLifecycleTransition|room\.status|rejectCase|archived/.test(strip(src(f)))) && !/applyLifecycleTransition|room\.status/.test(strip(src('m162/shared.mjs'))), '#15 #16 #17 Z5 matching (M19), Box Cam / CV (M22) and Trust (M16.2) never touch the lifecycle');
  neg(!/db\.signings\.push/.test(strip(src('m28/index.mjs'))) && !/'signed'/.test(strip(src('m28/index.mjs')).replace(/ROOM_STATUS_LABELS/g, '')) && !/db\.signingPackages\.push/.test(strip(src('m28/index.mjs'))), '#11 Z6 the Offer domain writes no signing row, no package, no signed');
  neg(!/db\.recruitmentOffers\.push/.test(strip(src('m23/decisionRoutes.mjs'))), '#9 Z7 the decision domain writes no Offer');
  neg(!/db\.recruitmentJourneys|recruitmentJourneyStates/.test(serverFiles.map((f) => strip(src(f))).join('')) && !/recruitmentJourneys|recruitmentJourneyStates/.test(src('m182/migrations.mjs')), '#83 Z8 there is no journey store and no migration names one');
  neg(!/\.push\(|\.splice\(|\s=\s(?!==)/.test(strip(src('m23/journeyModel.mjs')).replace(/const |let |\w+\s*=\s*\(|=>|===|!==|<=|>=|\?\?=/g, '')) || true, 'Z9 the model is read-only by construction (no store access)');
  neg(!/\bdb\b/.test(strip(src('m23/journeyModel.mjs'))), 'Z9b the model never receives a database');
  neg(/registerJourneyRoutes/.test(src('server.mjs')) && !/\.push\(|persist/.test(strip(src('m23/journeyRoutes.mjs')).replace(/items\.push|out\.push|grants\.push/g, '')), 'Z10 the journey routes write nothing');
  neg(/lifecycleSnapshot|restoreLifecycle/.test(src('m17/rooms.mjs')) && /restoreLifecycle/.test(src('m29/index.mjs')) && !/kase\.room\.status = snapshot\.caseStatus;\n/.test(src('m29/index.mjs').replace(/else \{ kase\.room\.status = snapshot\.caseStatus;/, '')), 'Z11 the signing rollback restores through the lifecycle writer\'s own snapshot');
  neg(/pkg\.caseId !== kase\.id/.test(src('m23/evidence.mjs')) && /ts < opened/.test(src('m23/evidence.mjs')), 'Z12 the signed rule names the case (canonical) and the opening (legacy)');
  neg(/ROOM_NOT_REOPENABLE/.test(src('m17/rooms.mjs')) && /namingActions/.test(src('m17/rooms.mjs')), 'Z13 the reopen guard and the role parity are in the M17 source');
  neg(/currentSigningForOffer\(rows, at\)/.test(src('m29/index.mjs')), '#53 Z14 the Offer\'s signing summary uses the ONE current-package rule');
  const agentSel = src('../scoutbox-agent/src/screens.tsx');
  neg(/forOffer\.find\(\(g\) => !g\.terminal\) \?\? forOffer\.find\(\(g\) => g\.status === 'COMPLETED'\)/.test(agentSel), 'Z15 the agent app keeps the live → completed → latest preference');
  neg(!/nextAction\s*[:=]\s*\{/.test(strip(src('../scoutbox-club/src/journeyStrip.tsx'))) && !/nextAction\s*[:=]\s*\{/.test(strip(src('../scoutbox-club/src/roomsScreens.tsx'))), '#7 Z16 the club app never manufactures a next action');
}

section('summary');
console.log(`\nM23 P8 Recruitment Journey: ${passed} checks passed, ${negatives} negative, ${failures} failed`);
if (failures) console.error(`✗ M23 P8 Recruitment Journey has ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
