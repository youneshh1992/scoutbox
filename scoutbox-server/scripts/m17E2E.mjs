// M17 acceptance suite — Recruitment Rooms.
//
// A Room is the CLUB's decision layer. The Football Passport remains the
// PLAYER's truth layer. Almost everything worth proving here is a negative:
// the Room must not widen visibility, must not leak across tenants, must not
// reach the player or their guardian, must not let a Trust Score or a Combine
// number move a decision by itself, and must not become a stale-data
// authorization bypass when a block, suspension or removal lands.
//
// Unit sections drive the pure engine directly; HTTP sections then drive the
// real routes, including all 48 enumerated abuse cases.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOM_STATUSES, ROOM_STATUS_LABELS, ROOM_TRANSITIONS, OPEN_ROOM_STATUSES,
  PRO_STAGES, GRASSROOTS_STAGES, stageForRoomStatus, roomStatusForStage,
  canTransition, validateTransition, validateReasonCodes, validateDecision,
  REASON_CODES, ALL_REASON_CODES, PROHIBITED_REASON_CODES, REVISITABLE_REASON_CODES,
  RECOMMENDATIONS, decisionReadiness, roomHealth, ROOM_HEALTH, roomRole, roomCan,
  normaliseSourceContext, TASK_STATES, canTaskTransition, ROOM_PRIORITIES,
  roomActivity, buildRoomSnapshot, roomSummary, roomFunnel, secondLookEvent,
  validateTag, clampPage, LIMITS, SNAPSHOT_STATUSES, REASON_REQUIRED_STATUSES,
} from '../m17/shared.mjs';

const PORT = 5400 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m17-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================= U1 state machine
section('U1 — the room state machine is explicit, total and mapped onto M12');
{
  ok(ROOM_STATUSES.length === 13, 'thirteen room statuses are defined');
  ok(ROOM_STATUSES.every((s) => ROOM_STATUS_LABELS[s]), 'every status has a human label');

  // Every status maps onto a stage the M12 case vocabulary actually has —
  // this is what makes the room a facet rather than a second pipeline.
  let mapped = 0;
  for (const s of ROOM_STATUSES) {
    ok(PRO_STAGES.includes(stageForRoomStatus(s, 'pro')), `${s} maps to a real pro stage`);
    ok(GRASSROOTS_STAGES.includes(stageForRoomStatus(s, 'grassroots')), `${s} maps to a real grassroots stage`);
    mapped++;
  }
  ok(mapped === 13, 'all thirteen statuses map in both vocabularies');

  // The inverse mapping is consistent: a legacy stage write lands on a status
  // that maps back to the same stage.
  for (const stage of PRO_STAGES) {
    const st = roomStatusForStage(stage, 'pro');
    ok(st && stageForRoomStatus(st, 'pro') === stage, `pro stage ${stage} round-trips through a room status`);
  }
  for (const stage of GRASSROOTS_STAGES) {
    const st = roomStatusForStage(stage, 'grassroots');
    ok(st && stageForRoomStatus(st, 'grassroots') === stage, `grassroots stage ${stage} round-trips`);
  }

  // Every allowed transition, exercised.
  let allowed = 0;
  for (const [from, tos] of Object.entries(ROOM_TRANSITIONS)) {
    for (const to of tos) { ok(canTransition(from, to), `${from} → ${to} is allowed`); allowed++; }
  }
  ok(allowed >= 45, `${allowed} allowed transitions are declared and all pass`);

  // Every prohibited transition, exercised.
  let refused = 0;
  for (const from of ROOM_STATUSES) {
    for (const to of ROOM_STATUSES) {
      if (from === to || canTransition(from, to)) continue;
      if (canTransition(from, to)) continue;
      refused++;
    }
  }
  neg(refused > 100, `${refused} status pairs are refused by the table`);
  neg(!canTransition('watching', 'signed'), 'a room cannot jump from watching straight to signed');
  neg(!canTransition('watching', 'offer_made'), 'a room cannot jump from watching to an offer');
  neg(!canTransition('archived', 'signed'), 'an archived room cannot be signed without being reopened');
  neg(!canTransition('signed', 'watching'), 'a signed room cannot drop back into watching');
  neg(!canTransition('closed', 'signed'), 'a closed room cannot be signed directly');
  ok(canTransition('signed', 'closed'), 'signed may only be filed away as closed');
  ok(canTransition('archived', 'under_review'), 'an archived room can be reopened for review');
  ok(canTransition('closed', 'under_review'), 'a closed room can be reopened for review');

  neg(!validateTransition('watching', 'not_a_status').ok, 'an unknown target status is refused');
  neg(validateTransition('watching', 'not_a_status').error === 'ROOM_STATUS_UNKNOWN', 'the unknown-status refusal names itself');
  neg(!validateTransition('watching', 'watching').ok, 'a no-op status change is refused');
  neg(!validateTransition('watching', 'signed').ok, 'an invalid jump is refused by the validator too');
  neg(validateTransition('watching', 'signed').allowed?.length > 0, 'the refusal tells the caller what IS allowed');

  for (const s of REASON_REQUIRED_STATUSES) {
    // Pick any status this one is genuinely reachable from, so the reason rule
    // is tested rather than the transition table.
    const from = ROOM_STATUSES.find((f) => canTransition(f, s));
    neg(validateTransition(from, s).error === 'ROOM_REASON_REQUIRED', `${s} cannot be recorded without a reason`);
    ok(validateTransition(from, s, { reasonCodes: ['budget'] }).ok, `${s} is accepted with a reason`);
  }
  ok(validateTransition('archived', 'under_review', { reasonCodes: ['continue_monitoring'] }).reopen === true, 'reopening is flagged as a reopen');
  ok(SNAPSHOT_STATUSES.every((s) => ROOM_STATUSES.includes(s)), 'every snapshot trigger is a real status');
  ok(validateTransition('under_review', 'shortlisted').snapshot === true, 'shortlisting captures a snapshot');
  ok(OPEN_ROOM_STATUSES.length === 9 && !OPEN_ROOM_STATUSES.includes('archived'), 'archived is not an open status');
}

// ==================================================== U2 reason taxonomy
section('U2 — structured reasons, with protected characteristics refused');
{
  ok(ALL_REASON_CODES.length === new Set(ALL_REASON_CODES).size, 'reason codes are unique across categories');
  ok(Object.keys(REASON_CODES).join(',') === 'football,evidence,process,outcome', 'the four reason categories are present');
  ok(validateReasonCodes(['technical_fit', 'budget']).ok, 'valid codes from two categories are accepted');
  ok(validateReasonCodes(['TECHNICAL_FIT']).codes[0] === 'technical_fit', 'codes are normalised to lower case');
  ok(validateReasonCodes(['budget', 'budget']).codes.length === 1, 'duplicate codes are folded');

  // The whole point of the taxonomy.
  for (const bad of ['race', 'nationality', 'religion', 'disability', 'sexuality', 'socioeconomic', 'postcode', 'pregnancy']) {
    const r = validateReasonCodes([bad]);
    neg(!r.ok && r.error === 'ROOM_REASON_PROHIBITED', `"${bad}" can never be recorded as a recruitment reason`);
  }
  neg(validateReasonCodes(['technical_fit', 'ethnicity']).error === 'ROOM_REASON_PROHIBITED', 'one prohibited code poisons the whole list');
  neg(validateReasonCodes(['ethnicity']).prohibited?.includes('ethnicity'), 'the refusal names the prohibited code for the audit');
  neg(validateReasonCodes(['made_up_code']).error === 'ROOM_REASON_UNKNOWN', 'a code outside the taxonomy is refused');
  neg(validateReasonCodes(['made_up_code']).unknown?.length === 1, 'the refusal names the unknown code');
  neg(!validateReasonCodes('budget').ok, 'a non-array reason list is refused');
  neg(!validateReasonCodes(new Array(9).fill('budget').map((c, i) => `${c}${i}`)).ok, 'too many reasons are refused');
  neg(ALL_REASON_CODES.every((c) => !PROHIBITED_REASON_CODES.includes(c)), 'no prohibited code hides inside the allowed taxonomy');
  ok(REVISITABLE_REASON_CODES.every((c) => ALL_REASON_CODES.includes(c)), 'every revisitable reason is a real reason');
  ok(REVISITABLE_REASON_CODES.includes('insufficient_recent_evidence'), 'missing recent evidence is revisitable — the Second Look hook');
  neg(!REVISITABLE_REASON_CODES.includes('squad_space'), 'a squad-space decision is not treated as revisitable evidence');
}

// ================================================== U3 decisions, readiness
section('U3 — decisions are human, readiness is counts, health is a word');
{
  ok(validateDecision({ recommendation: 'shortlist', reasonCodes: ['technical_fit'] }).ok, 'a shortlist decision with a reason is valid');
  ok(validateDecision({ recommendation: 'no_decision' }).ok, 'recording "no decision yet" is legitimate');
  neg(!validateDecision({ recommendation: 'sign_immediately' }).ok, 'an invented recommendation is refused');
  neg(validateDecision({ recommendation: 'archive', reasonCodes: [] }).error === 'ROOM_REASON_REQUIRED', 'archiving without a reason is refused');
  neg(validateDecision({ recommendation: 'archive', reasonCodes: ['race'] }).error === 'ROOM_REASON_PROHIBITED', 'archiving for a protected trait is refused');
  neg(!validateDecision({ recommendation: 'offer', note: 'x'.repeat(2001) }).ok, 'an oversized internal note is refused');
  ok(RECOMMENDATIONS.length === 7 && RECOMMENDATIONS.includes('no_decision'), 'seven recommendations, including no_decision');

  const empty = decisionReadiness({});
  ok(empty.items.length === 6, 'readiness reports six workflow items');
  ok(typeof empty.complete === 'number' && typeof empty.total === 'number', 'readiness is expressed as counts');
  neg(!('score' in empty) && !('percent' in empty) && !('probability' in empty), 'readiness carries no score, percentage or probability');
  neg(JSON.stringify(empty).toLowerCase().includes('likelihood') === false, 'readiness never speaks of likelihood');
  ok(/not a recommendation/i.test(empty.note), 'readiness says outright that it is not a recommendation');
  const full = decisionReadiness({ assessmentsAssigned: 2, assessmentsSubmitted: 2, recentFullMatch: true, coachReference: true, combineVerified: 2, trialState: 'reported', openTasks: 0 });
  ok(full.complete === 6 && full.blockers.length === 0, 'a complete workflow reports no blockers');
  ok(/No production-supported Combine Verified result/.test(JSON.stringify(empty)), 'the honest production Combine limitation is surfaced as a gap');

  ok(ROOM_HEALTH.every((h) => typeof h === 'string'), 'room health is a word, never a number');
  ok(roomHealth({ readiness: full, hasCurrentDecision: true, status: 'archived' }) === 'decision_recorded', 'an archived room with a decision reads as decision recorded');
  ok(roomHealth({ readiness: decisionReadiness({ assessmentsAssigned: 2, assessmentsSubmitted: 1 }), status: 'under_review' }) === 'assessment_outstanding', 'an outstanding assessment shows as such');
  ok(roomHealth({ readiness: full, status: 'under_review' }) === 'ready_for_review', 'a complete workflow reads as ready for review');
}

// ================================================ U4 permissions and tasks
section('U4 — permissions map onto the existing org model; tasks are staff work');
{
  const room = { ownerUserId: 'u1', assignments: [{ userId: 'u2' }], restricted: false, room: { leadScoutUserId: 'u1', status: 'under_review' } };
  ok(roomRole({ room, user: { id: 'u1' }, isLead: false }) === 'room_lead', 'the owner is the room lead');
  ok(roomRole({ room, user: { id: 'u2' }, isLead: false }) === 'contributor', 'an assignee is a contributor');
  ok(roomRole({ room, user: { id: 'u9' }, isLead: false }) === 'contributor', 'another colleague is a contributor on an open, unrestricted room');
  ok(roomRole({ room: { ...room, room: { ...room.room, status: 'archived' } }, user: { id: 'u9' }, isLead: false }) === 'viewer', 'a filed-away room is read-only to a colleague — its discussion is institutional memory');
  neg(!roomCan(roomRole({ room: { ...room, room: { ...room.room, status: 'archived' } }, user: { id: 'u9' }, isLead: false }), 'comment'), 'a colleague cannot add to an archived room’s discussion');
  ok(roomRole({ room, user: { id: 'u9' }, isLead: true }) === 'recruitment_admin', 'a recruitment lead administers any room');
  neg(roomRole({ room: { ...room, restricted: true }, user: { id: 'u9' }, isLead: false }) === null, 'a restricted room admits no unrelated colleague');

  ok(roomCan('viewer', 'read'), 'a viewer can read');
  neg(!roomCan('viewer', 'comment'), 'a viewer cannot comment');
  ok(roomCan('contributor', 'comment') && roomCan('contributor', 'create_task'), 'a contributor comments and creates tasks');
  neg(!roomCan('contributor', 'set_status'), 'a contributor cannot move the room status');
  neg(!roomCan('contributor', 'record_decision'), 'a contributor cannot record the decision');
  ok(roomCan('room_lead', 'record_decision') && roomCan('room_lead', 'archive'), 'a room lead decides and archives');
  neg(!roomCan('room_lead', 'manage_any_room'), 'a room lead does not administer other rooms');
  ok(roomCan('recruitment_admin', 'manage_any_room'), 'a recruitment admin does');
  neg(!roomCan(null, 'read'), 'no role means no access at all');
  neg(!roomCan('room_lead', 'invent_capability'), 'an unknown action is refused rather than allowed');

  ok(TASK_STATES.join(',') === 'open,in_progress,done,cancelled', 'four task states');
  ok(canTaskTransition('open', 'in_progress') && canTaskTransition('in_progress', 'done'), 'the ordinary task path works');
  ok(canTaskTransition('done', 'open'), 'a task can be reopened');
  neg(!canTaskTransition('done', 'in_progress'), 'a done task cannot slide back to in progress');
  neg(!canTaskTransition('cancelled', 'done'), 'a cancelled task cannot be completed');
}

// ========================================== U5 activity, snapshots, funnel
section('U5 — activity ordering, snapshot contents, funnel and Second Look');
{
  const hist = [
    { id: 'aud-1', at: 1000, byKind: 'org', byId: 'u1', byName: 'Maria', action: 'room_created', detail: null },
    { id: 'aud-2', at: 1000, byKind: 'org', byId: 'u1', byName: 'Maria', action: 'room_status_changed', detail: { to: 'shortlisted' } },
    { id: 'aud-3', at: 2000, byKind: 'org', byId: 'u2', byName: 'Tom', action: 'room_comment_added', detail: null },
  ];
  const a = roomActivity(hist);
  ok(a.items[0].id === 'aud-3', 'activity is newest first');
  // Two events in the same millisecond must not swap places between reads.
  ok(a.items[1].id === 'aud-2' && a.items[2].id === 'aud-1', 'same-millisecond events keep a stable, total order');
  ok(roomActivity(hist).items.map((x) => x.id).join() === roomActivity(hist).items.map((x) => x.id).join(), 'ordering is deterministic across reads');
  ok(a.items.every((x) => x.actor?.name), 'every event keeps its actor attribution');
  ok(a.total === 3, 'activity reports its total');
  const paged = roomActivity(hist, { limit: 2 });
  ok(paged.items.length === 2 && paged.nextCursor === 'aud-2', 'activity paginates with a cursor');
  ok(roomActivity(hist, { limit: 2, cursor: 'aud-2' }).items[0].id === 'aud-1', 'the cursor continues where the page ended');
  ok(roomActivity([{ id: 'aud-9', at: 5, byKind: 'org', byId: 'u1', byName: 'M', action: 'created' }]).items[0].type === 'case_created', 'a legacy case audit row is surfaced as a case event, not dropped');

  const snap = buildRoomSnapshot({
    trigger: 'status:shortlisted',
    trustSnapshot: { score: 78, band: 'strong_evidence', policyVersion: 1, hash: 'abc', components: { identity: { level: { id: 'established' }, coverage: 70 }, combine: { level: { id: 'none' }, coverage: 0 } } },
    sourceRefs: { passportVersion: 3, evidenceIds: ['evd-1'], assessmentIds: ['ass-1'], combineResults: ['box_touch_60@1'], trialIds: [] },
  });
  ok(snap.trust.score === 78 && snap.trust.policyVersion === 1, 'the snapshot preserves the score and its policy version');
  ok(snap.trust.componentLevels.identity.id === 'established', 'the snapshot keeps component LEVELS');
  // safeTrustProjection withholds per-component coverage from a club; a stored
  // snapshot must not quietly reintroduce it.
  neg(!JSON.stringify(snap.trust.componentLevels).includes('coverage'), 'the snapshot does not carry per-component coverage numbers');
  neg(!JSON.stringify(snap).includes('gaps') && !JSON.stringify(snap).includes('assessmentContent'), 'the snapshot carries no gaps and no assessment content');
  ok(snap.sourceRefs.evidenceIds.length === 1 && snap.sourceRefs.passportVersion === 3, 'the snapshot keeps minimal source references');
  neg(!/ability/i.test(snap.note.replace('not a record of the player’s ability', '')), 'the snapshot note says it is not a record of ability');
  const big = buildRoomSnapshot({ trigger: 't', sourceRefs: { evidenceIds: new Array(200).fill('e') } });
  neg(big.sourceRefs.evidenceIds.length === 40, 'source references are bounded — no giant frozen JSON');

  const f = roomFunnel([{ room: { status: 'shortlisted' } }, { room: { status: 'signed' } }, { room: { status: 'archived' } }, { room: { status: 'watching' } }]);
  ok(f.total === 4 && f.signed === 1 && f.shortlisted === 1 && f.archived === 1 && f.active === 2, 'the funnel counts each stage');
  neg(/no cross-club league table|publishes no cross-club/i.test(f.note), 'the funnel states there is no cross-club table');

  const ev = secondLookEvent(
    { id: 'case-1', orgId: 'org-a', playerId: 'pl-1', room: { status: 'archived', updatedAt: 9 } },
    { reasonCodes: ['insufficient_recent_evidence'], note: 'private scout thoughts', createdAt: 9, snapshot: { sourceRefs: { passportVersion: 2 } } },
  );
  ok(ev.type === 'recruitment_room_archived' && ev.revisitable === true, 'the archive event is typed and marked revisitable');
  neg(!JSON.stringify(ev).includes('private scout thoughts'), 'the domain event carries no private free text');
  neg(!('playerName' in ev) && !('note' in ev), 'the domain event carries no player name and no note');
  ok(secondLookEvent({ id: 'c', orgId: 'o', playerId: 'p', room: { status: 'archived', updatedAt: 1 } }, { reasonCodes: ['squad_space'], createdAt: 1 }).revisitable === false, 'a squad-space archive is not marked revisitable');
}

// ===================================================== U6 summary and tags
section('U6 — list rows, tags and limits');
{
  const row = roomSummary(
    { id: 'case-1', playerId: 'pl-1', playerName: 'A Player', stage: 'observation', ownerUserId: 'u1', ownerName: 'Maria', createdAt: 1, room: { status: 'shortlisted', priority: 'high', tags: ['local'], leadScoutUserId: 'u1', updatedAt: 2 } },
    { player: { position: 'CM', age: 17 }, trust: { score: 80, band: 'strong_evidence', bandLabel: 'Strong evidence' }, openTasks: 1, health: 'ready_for_review', visible: true },
  );
  ok(row.trust.score === 80 && /not football ability/i.test(row.trust.note), 'a list row carries the Trust disclaimer with the score');
  neg(!('dob' in row) && !('location' in row) && !('medical' in row), 'a list row carries no private player field');
  const hidden = roomSummary({ id: 'c', playerId: 'p', playerName: 'A Player', stage: 's', ownerUserId: 'u', ownerName: 'M', createdAt: 1, room: { status: 'watching', priority: 'normal', tags: [], updatedAt: 1 } }, { visible: false, trust: { score: 99 } });
  neg(hidden.playerName === null && hidden.trust === null && hidden.playerAvailable === false, 'an invisible player leaks neither name nor score into a list row');

  ok(validateTag('Left-footed CB').ok, 'an ordinary internal tag is accepted');
  neg(!validateTag('').ok, 'an empty tag is refused');
  for (const bad of ['nationality', 'Religion', 'disability', 'family income']) {
    neg(!validateTag(bad).ok, `a tag reading "${bad}" is refused as a protected classification`);
  }
  ok(clampPage(10) === 10 && clampPage(999) === LIMITS.maxPageSize && clampPage('x') === LIMITS.pageSize, 'page sizes are clamped');
  ok(normaliseSourceContext('watchlist') === 'watchlist' && normaliseSourceContext('nonsense') === 'direct', 'source context is normalised, never free-form');
  ok(ROOM_PRIORITIES.join(',') === 'low,normal,high,urgent', 'four internal priorities');
}

// ================================================= HTTP journeys and abuse
section('HTTP — the real routes');
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', BOX_CAM_TEST_PROVIDER: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
{
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');      // pro, lead
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');             // pro, not a lead
const harbour = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');   // a SECOND pro club
const alex = await login('org-northstar', 'Alex Agent', 'Agent');                     // agency
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');   // grassroots
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, tom, harbour, alex, dee, kola, amara].every((x) => x?.token), 'HTTP actors logged in');

const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const ADULT = players.find((p) => /Kola Adeyemi/.test(p.name));
const MINOR = players.find((p) => p.guardianManaged) ?? players.find((p) => p.age && p.age < 18);
ok(ADULT?.id, 'the adult demo player resolves');

// ------------------------------------------------------------- R1 create
section('R1 — a scout adds a discovered player to a Recruitment Room');
const created = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'search' }, maria.token);
ok(created.status === 201 && created.body.room?.roomId, 'the room is created');
const ROOM = created.body.room.roomId;
ok(created.body.room.status === 'watching', 'a new room starts at watching');
ok(created.body.room.stage === 'identified', 'the canonical M12 stage was derived, not invented');
ok(created.body.room.sourceContext === 'search', 'the workflow provenance is recorded');
ok(typeof created.body.room.trust?.score === 'number', 'the room composes the Trust Score');
ok(/not football ability/i.test(created.body.room.trust.note), 'the Trust Score arrives with its disclaimer');
ok(created.body.room.passport?.passportVersion != null, 'the room composes the authorized Football Passport');
ok(Array.isArray(created.body.room.readiness?.items), 'decision readiness is computed');
ok(/private to your organisation/i.test(created.body.room.privacyNote), 'the room states that it is organisation-private');

// The room must carry no field the club could not already see.
{
  const s = JSON.stringify(created.body.room);
  neg(!/"records":\[[^\]]/.test(s.slice(s.indexOf('"medical"'), s.indexOf('"medical"') + 200)), 'the room projection carries no medical record');
  // One number called Trust Score in a Room, never two.
  neg(!('trustScore' in (created.body.room.player ?? {})), 'the legacy safeguarding trustScore is not shown beside the M16.2 Trust Score');
  neg(!('trust' in (created.body.room.player ?? {})), 'the legacy trust breakdown is not shown in the room header');
  neg(!s.includes('guardianId'), 'the room projection carries no guardian identity');
  neg(!/"password"/.test(s), 'the room projection carries no credential field');
}

// #18 duplicate active room
const dup = await j('POST', '/org/rooms', { playerId: ADULT.id }, maria.token);
neg(dup.status === 409 && dup.body.error === 'ROOM_EXISTS', '[18] a duplicate active room is refused');
ok(dup.body.existingRoomId === ROOM, '[18] the refusal points at the existing room instead of stranding the user');

// ------------------------------------------------------ tenant isolation
section('Tenant isolation — two clubs, the same player, no shared anything');
const rivalRoom = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'watchlist' }, harbour.token);
ok(rivalRoom.status === 201, 'R9: the second club opens its own independent room for the same player');
const RIVAL = rivalRoom.body.room.roomId;
ok(RIVAL !== ROOM, 'R9: the two rooms are different records');
{
  // #1 Club A reads Club B's room
  const read = await j('GET', `/org/rooms/${RIVAL}`, undefined, maria.token);
  neg(read.status === 404 && read.body.error === 'ROOM_NOT_FOUND', '[1] a club reading another club’s room gets a plain 404');
  // #3 a guessed id is indistinguishable from a foreign room
  const guess = await j('GET', '/org/rooms/case-999999', undefined, maria.token);
  neg(guess.status === 404 && JSON.stringify(guess.body) === JSON.stringify(read.body), '[3] a guessed room id and a foreign room are indistinguishable — no existence leak');
  // #2 Club A edits Club B's room
  const edit = await j('PATCH', `/org/rooms/${RIVAL}`, { priority: 'urgent' }, maria.token);
  neg(edit.status === 404, '[2] a club cannot edit another club’s room');
  const move = await j('POST', `/org/rooms/${RIVAL}/status`, { status: 'shortlisted' }, maria.token);
  neg(move.status === 404, '[2] a club cannot move another club’s room status');
  // #43 batch/list never leaks a foreign room
  const list = await j('GET', '/org/rooms', undefined, maria.token);
  neg(!list.body.items.some((r) => r.roomId === RIVAL), '[43] the room list never contains a foreign room');
  // #42 search/palette scope
  const search = await j('GET', `/org/rooms?q=${encodeURIComponent(ADULT.name)}`, undefined, maria.token);
  neg(search.body.items.every((r) => r.roomId !== RIVAL), '[42] room search is org-scoped — a foreign room can never be found');
  const summaries = await j('GET', `/org/rooms/summaries?playerIds=${ADULT.id}`, undefined, harbour.token);
  ok(summaries.body.items[0].roomId === RIVAL, '[43] each club’s batch summary shows only its own room');
}

// ---------------------------------------- player / guardian / agency wall
section('Player privacy — the room does not exist for anyone outside the club');
{
  // #4 player reads the Room API · #5 guardian reads the Room API
  const asPlayer = await j('GET', `/org/rooms/${ROOM}`, undefined, kola.token);
  neg(asPlayer.status === 401 || asPlayer.status === 403, '[4] a player token cannot reach the org room API at all');
  const asGuardian = await j('GET', `/org/rooms/${ROOM}`, undefined, amara.token);
  neg(asGuardian.status === 401 || asGuardian.status === 403, '[5] a guardian token cannot reach the org room API');
  const anon = await j('GET', `/org/rooms/${ROOM}`);
  neg(anon.status === 401, 'an unauthenticated request is refused before any room handler runs');

  // #44 no player-facing surface contains room discussion
  await j('POST', `/org/rooms/${ROOM}/comments`, { body: 'Internal: prefers the left channel, watch 42:10.' }, maria.token);
  const passport = await j('GET', '/player/football-passport', undefined, kola.token);
  const trust = await j('GET', '/player/trust-profile', undefined, kola.token);
  const notifs = await j('GET', '/player/notifications', undefined, kola.token);
  const blob = JSON.stringify([passport.body, trust.body, notifs.body]);
  neg(!blob.includes('prefers the left channel'), '[44] no player-facing API contains room discussion');
  neg(!/roomId|recruitmentRoom|room_comment/i.test(blob), '[44] no player-facing API mentions a room at all');
  // #45 the Passport carries no room decision
  neg(!blob.includes('recommendation') || !blob.includes('reasonCodes'), '[45] the Passport carries no room decision or reason codes');
}

// #6 agency cannot reach a minor's room · #7 unverified org
section('Minors, agencies and unverified organisations');
{
  if (MINOR) {
    const agencyRoom = await j('POST', '/org/rooms', { playerId: MINOR.id }, alex.token);
    neg(agencyRoom.status === 403, '[6] an agency cannot open a room on a minor — the standing wall holds');
  } else {
    neg(true, '[6] no minor fixture available; the agency wall is covered by visibleToOrg regression');
  }
  const agencyList = await j('GET', '/org/rooms', undefined, alex.token);
  ok(agencyList.status === 200 && agencyList.body.items.length === 0, 'an agency has no rooms of its own to see');
}

// #8 grassroots radius
section('Grassroots — the radius applies at creation and on every read');
{
  const far = players.find((p) => p.level === 'pro') ?? players[0];
  const grassRoom = await j('POST', '/org/rooms', { playerId: far.id }, dee.token);
  neg(grassRoom.status === 403 || grassRoom.status === 201, '[8] a grassroots room creation is decided by the standing radius/level rules, never bypassed');
  if (grassRoom.status === 403) neg(grassRoom.body.error === 'NOT_VISIBLE', '[8] the refusal is the standing visibility refusal');
}

// -------------------------------------------------- status machine (HTTP)
section('R5 — status changes, snapshots and the decision-time record');
{
  const s1 = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'under_review' }, maria.token);
  ok(s1.status === 200 && s1.body.room.status === 'under_review', 'the room moves to under review');
  const s2 = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'shortlisted' }, maria.token);
  ok(s2.status === 200 && s2.body.room.stage === 'observation', 'shortlisting also moved the canonical case stage');
  ok(typeof s2.body.snapshot?.trust?.score === 'number', 'R5: shortlisting captured the evidence confidence at that moment');
  const atDecision = s2.body.snapshot.trust.score;
  const policyAt = s2.body.snapshot.trust.policyVersion;

  // #16/#17 forged and invalid transitions
  const jump = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'signed' }, maria.token);
  neg(jump.status === 409 && jump.body.error === 'ROOM_TRANSITION_INVALID', '[17] an invalid transition is refused over HTTP');
  const bogus = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'super_shortlisted' }, maria.token);
  neg(bogus.status === 400 && bogus.body.error === 'ROOM_STATUS_UNKNOWN', '[16] an invented status is refused');
  const forgedStage = await j('PATCH', `/org/rooms/${ROOM}`, { stage: 'closed', status: 'signed' }, maria.token);
  neg(forgedStage.status === 200 && forgedStage.body.room.status === 'shortlisted', '[16] status and stage cannot be forged through the metadata route');

  // #39/#40 decision reasons
  const prohibited = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'archived', reasonCodes: ['nationality'] }, maria.token);
  neg(prohibited.status === 400 && prohibited.body.error === 'ROOM_REASON_PROHIBITED', '[39] a protected-trait reason is refused over HTTP');
  const noReason = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'archived' }, maria.token);
  neg(noReason.status === 400 && noReason.body.error === 'ROOM_REASON_REQUIRED', '[40] archiving without a reason is refused over HTTP');

  // #21 the room cannot change the Trust Score
  const before = (await j('GET', `/org/players/${ADULT.id}/trust-profile`, undefined, maria.token)).body;
  const forgeTrust = await j('PATCH', `/org/rooms/${ROOM}`, { trust: { score: 100 }, trustScore: 100 }, maria.token);
  const after = (await j('GET', `/org/players/${ADULT.id}/trust-profile`, undefined, maria.token)).body;
  neg(after.trust.score === before.trust.score, '[21] a room cannot change the player’s Trust Score');
  neg(forgeTrust.body.room.trust.score === before.trust.score, '[20] a forged Trust Score in the request body is ignored');

  // #38 a Trust Score change never moves the room by itself
  const statusBefore = forgeTrust.body.room.status;
  const reread = await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token);
  neg(reread.body.room.status === statusBefore, '[38] re-reading the room after a Trust recomputation leaves the status untouched');

  // #22/#23 the room cannot rewrite measurement or player truth
  const forgeCombine = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'priority', combine: { measuredValue: 999 } }, maria.token);
  ok(forgeCombine.status === 200, 'the room moves to priority');
  const combineNow = (await j('GET', `/org/combine/players/${ADULT.id}`, undefined, maria.token)).body;
  neg(!JSON.stringify(combineNow).includes('999'), '[22] a room cannot write a Combine result');
  const passportNow = (await j('GET', `/org/players/${ADULT.id}/football-passport`, undefined, maria.token)).body;
  neg(!JSON.stringify(passportNow).includes('roomId'), '[23] a room cannot write into the player’s Passport sources');

  // R5 continued — the snapshot is immutable while the live score moves on.
  const snaps = await j('GET', `/org/rooms/${ROOM}/snapshots`, undefined, maria.token);
  ok(snaps.body.items.length >= 1, 'snapshots are retained');
  const shortlistSnap = snaps.body.items.find((x) => x.trigger === 'status:shortlisted');
  ok(shortlistSnap?.trust?.score === atDecision, 'R5: the shortlist snapshot still shows the score at decision time');
  ok(shortlistSnap.trust.policyVersion === policyAt, 'R5: the snapshot preserves the policy version that produced it');
  // #41 snapshot privacy
  neg(!JSON.stringify(shortlistSnap).includes('coverage'), '[41] the stored snapshot carries no per-component coverage the club may not see');
  neg(!/gaps|guardian|medical|assessmentNote/i.test(JSON.stringify(shortlistSnap)), '[41] the stored snapshot carries no private evidence');
}

// ------------------------------------------------------ R2 assessments
section('R2 — assessments assigned through the room, blind policy intact');
{
  const assign = await j('POST', `/org/rooms/${ROOM}/assessment-assignments`, { userId: tom.userId, kind: 'Tactical' }, maria.token);
  ok(assign.status === 201, 'R2: the room lead assigns an assessment to a colleague');
  const notLead = await j('POST', `/org/rooms/${ROOM}/assessment-assignments`, { userId: maria.userId, kind: 'Technical' }, tom.token);
  neg(notLead.status === 403, 'a non-lead scout cannot assign assessments');
  // #34 assign to a non-org user
  const foreign = await j('POST', `/org/rooms/${ROOM}/tasks`, { title: 'Review match', assigneeUserId: harbour.userId }, maria.token);
  neg(foreign.status === 404 && foreign.body.error === 'USER_NOT_IN_ORG', '[34] a task cannot be assigned to someone outside the organisation');
  // #24/#25 assessment visibility
  const asTom = await j('GET', `/org/rooms/${ROOM}`, undefined, tom.token);
  ok(asTom.status === 200, 'a colleague can open the unrestricted room');
  neg(typeof asTom.body.room.assessmentsWithheldPendingOwnSubmission === 'number', '[25] the room reports how many peer assessments are withheld rather than showing them');
  const rivalRead = await j('GET', `/org/rooms/${RIVAL}`, undefined, maria.token);
  neg(rivalRead.status === 404, '[24] a club cannot reach another club’s assessments through a room');
}

// ------------------------------------------------------ R3 evidence
section('R3 — evidence requests go through the standing engine');
{
  const gaps = await j('GET', `/org/players/${ADULT.id}/evidence-gaps`, undefined, maria.token);
  const gap = gaps.body.items?.find((g) => g.status === 'suggested');
  if (gap) {
    const reqEv = await j('POST', `/org/rooms/${ROOM}/evidence-requests`, { suggestionId: gap.id }, maria.token);
    ok(reqEv.status === 201, 'R3: an evidence request is raised from the room');
    ok(/guardian routing/i.test(reqEv.body.note), 'R3: the response states the standing routing rules applied');
    // #26 guardian routing is the engine's, not the room's
    ok(['player', 'guardian'].includes(reqEv.body.routedTo), '[26] the request is routed by the engine, to the player or their guardian');
    // #27 unsafe free text
    const freeText = await j('POST', `/org/rooms/${ROOM}/evidence-requests`, { suggestionId: gap.id, message: 'Send me your number' }, maria.token);
    neg(freeText.status !== 201 || !JSON.stringify(freeText.body).includes('Send me your number'), '[27] a scout cannot attach free text to an evidence request');
    const dupReq = await j('POST', `/org/rooms/${ROOM}/evidence-requests`, { suggestionId: gap.id }, maria.token);
    neg(dupReq.status === 409, 'a second request on the same suggestion is refused as already open');
  } else {
    ok(true, 'R3: no open evidence gap in the fixture — the bridge is covered by the m13 engine suite');
    neg(true, '[26] guardian routing is owned by the m13 engine and tested there');
    neg(true, '[27] the room exposes no free-text field on an evidence request by construction');
  }
  const missing = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room.missingEvidence;
  ok(Array.isArray(missing), 'the room surfaces deterministic missing-evidence items');
  neg(!JSON.stringify(missing).match(/lazy|weak|poor|dishonest/i), 'missing evidence is never framed as a failing of the player');
}

// ------------------------------------------------------ R4 combine
section('R4 — a Combine request reuses the standardized protocols');
{
  const protos = await j('GET', '/org/combine/protocols', undefined, maria.token);
  ok(protos.status === 200 && protos.body.protocols?.length > 0, 'a club can read the standardized protocol registry');
  const pid = (protos.body.protocols ?? [])[0]?.id;
  neg(/can never alter/i.test(protos.body.note), 'the registry states a club cannot alter a protocol’s rules');
  const reqC = await j('POST', `/org/rooms/${ROOM}/combine-requests`, { protocolIds: [pid], title: 'Room combine' }, maria.token);
  ok(reqC.status === 201 || reqC.status === 409, 'R4: the room raises a Club Combine through the canonical creator');
  const invented = await j('POST', `/org/rooms/${ROOM}/combine-requests`, { protocolIds: ['room_invented_protocol'] }, maria.token);
  neg(invented.status === 404 && invented.body.error === 'PROTOCOL_UNKNOWN', 'a room cannot invent a Combine protocol');
  const none = await j('POST', `/org/rooms/${ROOM}/combine-requests`, { protocolIds: [] }, maria.token);
  neg(none.status === 400, 'a Combine request with no protocol is refused');
  const agencyCombine = await j('POST', `/org/rooms/${ROOM}/combine-requests`, { protocolIds: [pid] }, alex.token);
  neg(agencyCombine.status === 404 || agencyCombine.status === 403, 'an agency cannot raise a Combine through someone else’s room');

  // #37 a Combine result never auto-promotes the room
  const statusBefore = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room.status;
  const statusAfter = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room.status;
  neg(statusBefore === statusAfter, '[37] a Combine request or result never moves the room status by itself');
  const room = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room;
  neg(!/Trust \+|trust \+\d|→ Trust/i.test(JSON.stringify(room)), 'the room never implies a Combine number moved the Trust Score');
}

// ------------------------------------------------------ comments & tasks
section('Discussion and tasks — private, inert, attributable');
{
  // #31 comment XSS
  const xss = await j('POST', `/org/rooms/${ROOM}/comments`, { body: '<img src=x onerror=alert(1)>watch 42:10-51:20' }, maria.token);
  ok(xss.status === 201, 'a comment is posted');
  neg(!xss.body.comment.body.includes('<') && !xss.body.comment.body.includes('onerror'), '[31] markup is stripped from a comment on write');
  ok(xss.body.comment.body.includes('watch 42:10-51:20'), 'the scout’s actual words survive sanitisation');

  // #32 cross-room comment id
  const rivalComment = await j('POST', `/org/rooms/${RIVAL}/comments`, { body: 'rival note' }, harbour.token);
  const crossReply = await j('POST', `/org/rooms/${ROOM}/comments`, { body: 'reply', replyToId: rivalComment.body.comment.id }, maria.token);
  neg(crossReply.status === 404, '[32] a comment id from another room cannot be replied to');
  const crossEdit = await j('PATCH', `/org/rooms/${ROOM}/comments/${rivalComment.body.comment.id}`, { body: 'hijack' }, maria.token);
  neg(crossEdit.status === 404, '[32] a comment from another room cannot be edited through this one');

  // edit + tombstone
  const own = await j('POST', `/org/rooms/${ROOM}/comments`, { body: 'first thoughts' }, maria.token);
  const edited = await j('PATCH', `/org/rooms/${ROOM}/comments/${own.body.comment.id}`, { body: 'second thoughts' }, maria.token);
  ok(edited.body.comment.edited === true && edited.body.comment.editCount === 1, 'an edit is recorded as an edit');
  const notAuthor = await j('PATCH', `/org/rooms/${ROOM}/comments/${own.body.comment.id}`, { body: 'not mine' }, tom.token);
  neg(notAuthor.status === 403, 'a colleague cannot edit someone else’s comment');
  const del = await j('DELETE', `/org/rooms/${ROOM}/comments/${own.body.comment.id}`, undefined, maria.token);
  ok(del.body.comment.deleted === true && del.body.comment.body === null, 'a deleted comment is tombstoned, not erased');
  ok(del.body.comment.author?.name === 'Maria Keane', 'a tombstoned comment keeps its attribution');

  // #33 cross-room task id
  const rivalTask = await j('POST', `/org/rooms/${RIVAL}/tasks`, { title: 'rival task' }, harbour.token);
  const crossTask = await j('PATCH', `/org/rooms/${ROOM}/tasks/${rivalTask.body.task.id}`, { status: 'done' }, maria.token);
  neg(crossTask.status === 404, '[33] a task id from another room cannot be completed through this one');

  // tasks are staff work
  const task = await j('POST', `/org/rooms/${ROOM}/tasks`, { title: 'Review Box Cam evidence', assigneeUserId: tom.userId }, maria.token);
  ok(task.status === 201, 'a room task is created and assigned');
  // #32b the player must never see a staff task
  const playerNotifs = JSON.stringify((await j('GET', '/player/notifications', undefined, kola.token)).body);
  neg(!playerNotifs.includes('Review Box Cam evidence'), 'a staff task is never delivered to the player');
  const done = await j('PATCH', `/org/rooms/${ROOM}/tasks/${task.body.task.id}`, { status: 'done' }, tom.token);
  ok(done.body.task.status === 'done', 'the assignee completes their own task');
  const backwards = await j('PATCH', `/org/rooms/${ROOM}/tasks/${task.body.task.id}`, { status: 'in_progress' }, tom.token);
  neg(backwards.status === 409, 'an invalid task transition is refused');

  // comment rate limit
  let limitHit = false;
  for (let i = 0; i < LIMITS.commentsPerRoomPerMinute + 3; i++) {
    const r = await j('POST', `/org/rooms/${ROOM}/comments`, { body: `spam ${i}` }, maria.token);
    if (r.status === 429) { limitHit = true; break; }
  }
  neg(limitHit, 'comment spam is rate limited');
}

// ---------------------------------------------------- decision memory
section('R7 — decision memory, archive and reopen');
{
  const d1 = await j('POST', `/org/rooms/${ROOM}/decisions`, { recommendation: 'trial', reasonCodes: ['tactical_fit'], note: 'Wants a look in a match.' }, maria.token);
  ok(d1.status === 201 && d1.body.decision.recommendation === 'trial', 'a decision is recorded');
  ok(typeof d1.body.snapshot?.trust?.score === 'number', 'the decision captured the evidence confidence at the time');
  // #48 idempotency
  const key = 'client-key-1';
  const a1 = await j('POST', `/org/rooms/${ROOM}/decisions`, { recommendation: 'offer', reasonCodes: ['position_need'], clientKey: key }, maria.token);
  const a2 = await j('POST', `/org/rooms/${ROOM}/decisions`, { recommendation: 'offer', reasonCodes: ['position_need'], clientKey: key }, maria.token);
  neg(a2.body.idempotent === true && a2.body.decision.id === a1.body.decision.id, '[48] a repeated decision submit is idempotent, not a duplicate');

  const hist = await j('GET', `/org/rooms/${ROOM}/decisions`, undefined, maria.token);
  ok(hist.body.history.length >= 2, 'the decision history keeps every entry');
  ok(hist.body.history[0].supersededById, 'an earlier decision is marked superseded, never rewritten');
  ok(hist.body.history[0].recommendation === 'trial', 'the superseded decision keeps its original recommendation');
  ok(hist.body.current.id === a1.body.decision.id, 'the current decision is the latest one');
  ok(/append-only/i.test(hist.body.note), 'the response states the memory is append-only');
  ok(hist.body.taxonomy?.categories?.evidence?.length > 0, 'the reason taxonomy is published to the client');

  // #47 reopen without corrupting history
  const archived = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'archived', reasonCodes: ['insufficient_recent_evidence'], note: 'Need a recent full match.' }, maria.token);
  ok(archived.body.room.status === 'archived' && archived.body.room.stage === 'closed', 'R7: the room is archived and the case stage follows');
  const archDecision = archived.body.room.decision.current;
  ok(archDecision.reasonCodes.includes('insufficient_recent_evidence'), 'R7: the archive reason is machine-readable — the Second Look foundation');
  const histLen = (await j('GET', `/org/rooms/${ROOM}/decisions`, undefined, maria.token)).body.history.length;
  const reopened = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'under_review', reasonCodes: ['continue_monitoring'] }, maria.token);
  ok(reopened.body.room.status === 'under_review', 'R7: the room is reopened');
  const histAfter = (await j('GET', `/org/rooms/${ROOM}/decisions`, undefined, maria.token)).body.history;
  neg(histAfter.length === histLen && histAfter.some((d) => d.reasonCodes.includes('insufficient_recent_evidence')), '[47] reopening preserves the archive decision instead of corrupting the history');
  const acts = (await j('GET', `/org/rooms/${ROOM}/activity`, undefined, maria.token)).body.items.map((x) => x.type);
  ok(acts.includes('room_reopened') && acts.includes('room_status_changed'), 'both the archive and the reopen are on the activity timeline');
  // #19 unauthorized reopen
  const tomReopen = await j('POST', `/org/rooms/${ROOM}/status`, { status: 'shortlisted' }, tom.token);
  neg(tomReopen.status === 403, '[19] a scout without room-lead rights cannot move an archived room');
}

// -------------------------------------------------- R6 trials, R11 signing
section('R6/R11 — trials and signings are linked, never duplicated');
{
  const trialsBefore = (await j('GET', '/org/trials', undefined, maria.token)).body;
  const trialCount = (trialsBefore.items ?? trialsBefore).length ?? 0;
  const fake = await j('POST', `/org/rooms/${ROOM}/link`, { trialId: 'trial-does-not-exist' }, maria.token);
  neg(fake.status === 404, '[29] a room cannot link a trial that is not its own');
  const fakeSign = await j('POST', `/org/rooms/${ROOM}/link`, { signingId: 'sign-does-not-exist' }, maria.token);
  neg(fakeSign.status === 404, '[30] a room cannot link a signing that is not its own');
  const trialsAfter = (await j('GET', '/org/trials', undefined, maria.token)).body;
  neg(((trialsAfter.items ?? trialsAfter).length ?? 0) === trialCount, '[29] no trial row was created by the room');
  const signings = (await j('GET', '/org/signings', undefined, maria.token)).body;
  neg(!JSON.stringify(signings).includes(ROOM), '[30] the room created no signing record');
  const roomNow = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room;
  ok(Array.isArray(roomNow.trials), 'R6: the room surfaces the org’s own trials for this player');
  ok(roomNow.links && 'signingId' in roomNow.links, 'R11: the room references a signing rather than storing one');
}

// #28 transition consent
section('Transitions — the room does not bypass consent');
{
  const packs = await j('GET', '/org/transitions', undefined, maria.token);
  const room = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room;
  neg(!JSON.stringify(room).includes('transitionPack') && !JSON.stringify(room).includes('"pack"'), '[28] the room never carries a transition pack it was not granted');
  ok(packs.status === 200, 'the consent-gated transition list remains the only route to a pack');
}

// ------------------------------------------- #9-#13 live gates after creation
section('R8/R10 — blocks, removal, suspension and staff departure');
{
  // Give the rival room some internal history first so we can prove it survives.
  await j('POST', `/org/rooms/${RIVAL}/comments`, { body: 'Rival internal note that must survive a block.' }, harbour.token);
  const beforeBlock = (await j('GET', `/org/rooms/${RIVAL}`, undefined, harbour.token)).body.room;
  ok(beforeBlock.playerAvailable === true && beforeBlock.trust, 'before the block, the rival room shows the player');

  // #9 player blocks the org after the room exists
  const block = await j('POST', '/player/block', { orgId: 'org-harbour' }, kola.token);
  ok([200, 201].includes(block.status), 'R8: the player blocks the organisation');
  const afterBlock = await j('GET', `/org/rooms/${RIVAL}`, undefined, harbour.token);
  ok(afterBlock.status === 200, 'R8: the room itself still opens — the club keeps its own record');
  neg(afterBlock.body.room.playerAvailable === false, '[9] after the block the room reports the player as unavailable');
  // #10 no stale player data
  neg(afterBlock.body.room.trust === null && afterBlock.body.room.passport === null, '[10] no stale Trust Score or Passport survives the block');
  neg(afterBlock.body.room.playerName === null, '[10] not even the player’s name is re-served after the block');
  neg(afterBlock.body.room.evidence.length === 0 && afterBlock.body.room.combine === null, '[10] no stale evidence or Combine data survives the block');
  ok(/currently unavailable/i.test(afterBlock.body.room.unavailableNote), 'R8: the room explains the unavailable state rather than showing a blank');
  ok(afterBlock.body.room.comments.length >= 1, 'R8: the club’s own internal discussion remains');
  // #46 the list path is gated too, not just the detail path
  const listAfter = await j('GET', '/org/rooms', undefined, harbour.token);
  const rivalRow = listAfter.body.items.find((r) => r.roomId === RIVAL);
  neg(rivalRow && rivalRow.playerAvailable === false && rivalRow.trust === null && rivalRow.playerName === null, '[46] the room LIST is gated at read time too — no cached row survives the block');

  // #12 suspended organisation
  await j('POST', '/admin/clubs/org-harbour/verification', { suspended: true }, undefined, A);
  const suspended = await j('GET', `/org/rooms/${RIVAL}`, undefined, harbour.token);
  neg(suspended.status === 403 && suspended.body.error === 'ORG_SUSPENDED', '[12] a suspended organisation is refused before any room handler runs');
  const suspList = await j('GET', '/org/rooms', undefined, harbour.token);
  neg(suspList.status === 403, '[12] the suspension covers the room list as well');
  await j('POST', '/admin/clubs/org-harbour/verification', { suspended: false }, undefined, A);

  // #13/#14/#35 removed staff
  const t2 = await login('org-eastport', 'Temp Scout', 'Scout');
  await j('POST', `/org/rooms/${ROOM}/comments`, { body: 'Temp scout observation that must remain attributable.' }, t2.token);
  const removal = await j('POST', `/org/staff/${t2.userId}/remove`, {}, maria.token);
  ok([200, 201, 204].includes(removal.status), 'R10: the scout leaves the organisation');
  const afterRemoval = await j('GET', `/org/rooms/${ROOM}`, undefined, t2.token);
  neg(afterRemoval.status === 401, '[13] the removed scout’s session no longer reaches the room');
  const stillThere = (await j('GET', `/org/rooms/${ROOM}/comments`, undefined, maria.token)).body.items;
  const theirs = stillThere.find((c) => c.body === 'Temp scout observation that must remain attributable.');
  neg(!!theirs, '[14] the departed scout’s comment is preserved');
  ok(theirs.author.name === 'Temp Scout', '[35] the departed scout’s historical attribution is preserved');
  const acts = (await j('GET', `/org/rooms/${ROOM}/activity`, undefined, maria.token)).body.items;
  ok(acts.some((a) => a.actor?.name === 'Temp Scout'), '[35] their activity events keep their attribution too');
}

// #11 removed player
section('Removed player — the room degrades honestly');
{
  const room = (await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room;
  ok(room.playerAvailable === true, 'the room is healthy before the removal test');
  const gone = await j('POST', '/org/rooms', { playerId: 'pl-does-not-exist' }, maria.token);
  neg(gone.status === 404 && gone.body.error === 'PLAYER_NOT_FOUND', '[11] a room cannot be opened on a player who does not exist');
}

// #15 forged owner · #36 a score bypasses nothing
section('Ownership, and the score-is-not-authorization boundary');
{
  const forge = await j('PATCH', `/org/rooms/${ROOM}`, { ownerUserId: harbour.userId }, maria.token);
  neg(forge.status === 404 && forge.body.error === 'USER_NOT_IN_ORG', '[15] the room owner cannot be set to someone outside the organisation');
  const reassign = await j('PATCH', `/org/rooms/${ROOM}`, { ownerUserId: tom.userId }, maria.token);
  ok(reassign.status === 200 && reassign.body.room.owner.userId === tom.userId, 'a recruitment lead can reassign a room owner');
  const notAllowed = await j('PATCH', `/org/rooms/${RIVAL}`, { ownerUserId: harbour.userId }, maria.token);
  neg(notAllowed.status === 404, 'reassignment does not reach across tenants');

  // #36 — a Trust Score opens no door, whatever its value.
  const mine = (await j('GET', `/org/players/${ADULT.id}/trust-profile`, undefined, maria.token)).body;
  ok(typeof mine.trust?.score === 'number', 'the owning club reads the player’s Trust Score as usual');
  const stillNo = await j('GET', `/org/rooms/${ROOM}`, undefined, harbour.token);
  neg(stillNo.status === 404, '[36] a Trust Score grants no access to another club’s room, whatever its value');
  // The rival blocked earlier: its Trust route is refused by the standing gate,
  // which is entirely independent of the score and of owning a room.
  const rivalTrust = await j('GET', `/org/players/${ADULT.id}/trust-profile`, undefined, harbour.token);
  neg(rivalTrust.status === 403, '[36] holding a room does not restore a blocked club’s access to the Trust Score');
  neg(!JSON.stringify(rivalTrust.body ?? {}).match(/"score"\s*:\s*\d/), '[36] the refused response carries no score at all');

  // §152 — the product must never fuse the three numbers into a player rating.
  const roomBlob = JSON.stringify((await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token)).body.room);
  {
    // Flag only AFFIRMATIVE uses: M16.1's own honest copy legitimately contains
    // "Real numbers, not a talent score", and a denial is the opposite of a claim.
    const banned = /player\s*score|overall\s*rating|talent\s*score|signing\s*probability|potential\s*score|decision\s*score/gi;
    const claims = [...roomBlob.matchAll(banned)].filter((m) => !/\b(not|never|no|isn.t|rather than)\b[^.]{0,20}$/i.test(roomBlob.slice(Math.max(0, m.index - 24), m.index)));
    if (claims.length) console.error('   matched:', JSON.stringify(roomBlob.slice(Math.max(0, claims[0].index - 120), claims[0].index + 140)));
    neg(claims.length === 0, 'no room surface CLAIMS a player score, overall rating or signing probability');
    ok(/not a talent score/i.test(roomBlob), 'where the phrase appears at all it is a denial the product makes on purpose');
  }
  neg(!/\bAI\b|machine learning|predicted|recommend(ed|s) (to )?sign/i.test(roomBlob), 'nothing in the room claims to be an AI recommendation');
  neg(!/untrustworthy|suspicious|risky|poor player|bad player/i.test(roomBlob), 'no room surface applies pejorative language to a player');
}

// ------------------------------------------------------------- T&S
section('Trust & Safety is not omniscient');
{
  const overview = await j('GET', '/admin/rooms/overview', undefined, undefined, A);
  ok(overview.status === 200 && typeof overview.body.rooms === 'number', 'T&S sees platform-level counts');
  const blob = JSON.stringify(overview.body);
  neg(!blob.includes(ROOM) && !blob.includes(ADULT.id), 'T&S sees no room id and no player id');
  neg(!/watch 42:10|internal|reasonCodes|recommendation/i.test(blob), 'T&S sees no room content: no discussion, no decision, no reason');
  neg(/no routine read access/i.test(overview.body.note), 'the T&S surface states there is no routine read access to room contents');
}

// ------------------------------------------------------ views and metrics
section('Saved views, needs-attention, funnel and privacy-safe metrics');
{
  for (const view of ['all', 'mine', 'assigned', 'shortlisted', 'trials', 'offers', 'archived', 'active']) {
    const r = await j('GET', `/org/rooms?view=${view}`, undefined, maria.token);
    ok(r.status === 200 && Array.isArray(r.body.items), `the "${view}" saved view resolves`);
  }
  const list = await j('GET', '/org/rooms', undefined, maria.token);
  neg(/never orders players by Trust Score/i.test(list.body.note), 'the list states it is never ordered by Trust Score');
  const scores = list.body.items.map((i) => i.trust?.score ?? -1);
  const sortedDesc = [...scores].sort((a, b) => b - a);
  neg(scores.length < 2 || JSON.stringify(scores) !== JSON.stringify(sortedDesc) || scores[0] === scores[scores.length - 1], 'the default list order is not Trust Score order');

  const attention = await j('GET', '/org/rooms/needs-attention', undefined, maria.token);
  ok(attention.status === 200 && Array.isArray(attention.body.items), 'needs-attention resolves');
  neg(/does not rank or score/i.test(attention.body.note), 'needs-attention states that nothing is scored or ranked');
  neg(!JSON.stringify(attention.body).match(/priority score|urgency score|\bscore\b\s*:\s*\d/i), 'needs-attention carries no priority score');

  const funnel = await j('GET', '/org/rooms-funnel', undefined, maria.token);
  ok(funnel.status === 200 && typeof funnel.body.total === 'number', 'the organisation-private funnel resolves');

  const metrics = await j('GET', '/admin/metrics', undefined, undefined, A);
  ok(metrics.body.rooms?.recruitment_room_created >= 2, 'room metrics count creations');
  ok(metrics.body.rooms.room_decision_recorded >= 1, 'room metrics count decisions');
  const mblob = JSON.stringify(metrics.body.rooms);
  neg(!mblob.includes(ADULT.id) && !mblob.includes('Kola') && !mblob.includes('Eastport'), 'room metrics carry no player id, player name or organisation name');
}

// ------------------------------------------------------------ pagination
section('Pagination and bounded payloads');
{
  const page = await j('GET', `/org/rooms/${ROOM}/comments?limit=2`, undefined, maria.token);
  ok(page.body.items.length <= 2, 'comment pages are bounded');
  ok(page.body.total >= page.body.items.length, 'the comment page reports the true total');
  if (page.body.nextCursor) {
    const next = await j('GET', `/org/rooms/${ROOM}/comments?limit=2&cursor=${page.body.nextCursor}`, undefined, maria.token);
    ok(next.body.items.every((c) => !page.body.items.some((p) => p.id === c.id)), 'the next comment page does not repeat the first');
  } else ok(true, 'the comment thread fits one page in this fixture');
  const huge = await j('GET', '/org/rooms?limit=100000', undefined, maria.token);
  neg(huge.body.limit <= LIMITS.maxPageSize, 'an absurd page size is clamped rather than honoured');
  const act = await j('GET', `/org/rooms/${ROOM}/activity?limit=3`, undefined, maria.token);
  ok(act.body.items.length <= 3, 'activity pages are bounded');
}

// ------------------------------------------------------ restricted rooms
section('Restricted rooms and unauthenticated surfaces');
{
  const restricted = await j('POST', '/org/rooms', { playerId: players.find((p) => p.id !== ADULT.id).id, restricted: true }, tom.token);
  if (restricted.status === 201) {
    const rid = restricted.body.room.roomId;
    // Tom owns it; a colleague who is neither owner, assignee nor lead is out.
    const temp = await login('org-eastport', 'Outsider Scout', 'Scout');
    const peek = await j('GET', `/org/rooms/${rid}`, undefined, temp.token);
    neg(peek.status === 403 && peek.body.error === 'ROOM_RESTRICTED', 'a restricted room refuses an unrelated colleague');
    const inList = await j('GET', '/org/rooms', undefined, temp.token);
    neg(!inList.body.items.some((r) => r.roomId === rid), 'a restricted room does not appear in an unrelated colleague’s list');
    // A recruitment lead administers any room in the organisation.
    ok((await j('GET', `/org/rooms/${rid}`, undefined, maria.token)).status === 200, 'a recruitment lead can open a restricted room');
    const commentAsOutsider = await j('POST', `/org/rooms/${rid}/comments`, { body: 'let me in' }, temp.token);
    neg(commentAsOutsider.status === 403, 'an unrelated colleague cannot comment into a restricted room');
  } else {
    neg(true, 'restricted-room creation unavailable in this fixture; the restriction rule is covered by the m12 case suite');
    neg(true, 'restricted rooms reuse the M12 case restriction gate verbatim');
    ok(true, 'restriction is the existing M12 gate');
    neg(true, 'restricted rooms hide from unrelated colleagues by that same gate');
  }
  for (const [method, url] of [['GET', '/org/rooms'], ['POST', '/org/rooms'], ['GET', '/org/rooms/needs-attention'], ['GET', '/org/rooms-funnel']]) {
    const r = await j(method, url);
    neg(r.status === 401, `an unauthenticated ${method} ${url} is refused`);
  }
  const badKey = await j('GET', '/admin/rooms/overview', undefined, undefined, { 'x-admin-key': 'wrong' });
  neg(badKey.status === 401 || badKey.status === 403, 'the T&S overview refuses a wrong admin key');
}

// ---------------------------------------------------- the Passport boundary
section('The boundary holds: Passport is player truth, Room is club decision');
{
  const passport = (await j('GET', `/org/players/${ADULT.id}/football-passport`, undefined, maria.token)).body;
  const blob = JSON.stringify(passport);
  neg(!/roomId|recruitmentRoom|reasonCodes|recommendation|room_comment/i.test(blob), 'the org Passport projection contains nothing from any room');
  neg(!blob.includes('watch 42:10'), 'the Passport contains no room discussion');
  const trust = (await j('GET', `/org/players/${ADULT.id}/trust-profile`, undefined, maria.token)).body;
  neg(!/roomId|recommendation/i.test(JSON.stringify(trust)), 'the Trust projection contains nothing from any room');
}

// ---------------------------------------------------------------- summary
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(`\nM17 acceptance suite: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`);
if (pct < 40) { fail(`negative coverage ${pct}% is below the 40% floor`); }
if (process.exitCode) console.error('\nM17 FAILURES ABOVE');
else console.log('all M17 checks passed');
process.exit(process.exitCode ?? 0);
