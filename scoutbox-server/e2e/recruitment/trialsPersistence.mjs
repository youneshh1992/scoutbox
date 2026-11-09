// Trial persistence suite.
//
// THE INVARIANTS
//
//   1. A trial row reads back with the operational containers at NEUTRAL
//      values (`legacy_accepted`, no schedule, no attendance, no completion)
//      and never renames `awaiting_report` / `reported`, never invents a
//      date, an attendance or a completion.
//   2. A fixture that carries workflow trial rows restores them byte-faithfully
//      through a real boot: sessions keep their ids and order, the append-only
//      revisions and attendance history keep every entry, the idempotency
//      keys live on the row.
//   3. A corrupt trial row is NAMED and OMITTED from the room's trial list
//      (counted, logged) and never takes the server down; a sound row on the
//      same case still serves.
//   4. Clean boot → invitation → acceptance → restart: the replay keys, the
//      case stage and the trial state are the same after the process died.
//
// No fixture here calls buildSeed(): the defect class lives in the gap
// between "the seed made it" and "the database guarantees it".

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixture, readRecords } from '../../scripts/dataLayerFixture.mjs';
import { JOURNEY_REQUIRED_STORES } from '../../domains/recruitment/lifecycle/journey.mjs';
import { trialIntegrity, deriveWorkflowState, TRIAL_WORKFLOW_STATES } from '../../domains/recruitment/lifecycle/trial.mjs';
import { typeTrial } from '../../repositories/recruitment.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../repositories/index.mjs';
import { createEvidenceProvider } from '../../scripts/recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
const LATEST_SCHEMA = Number(DATA_MIGRATIONS.map((m) => m.id).sort().at(-1).slice(0, 4)); // the latest table migration's number

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** Boot the real server on a directory; return a client and a stop() that SIGTERMs and reads the stored records back. */
async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return readRecords(dataDir);
  };
  return { up, j, stop, log: () => log };
}

const PORT = 5700 + Math.floor(Math.random() * 200);
const H = 3_600_000;
const T0 = 1_800_000_000_000; // 2027-01-15T08:00:00Z — inside the 2000–2100 window, in the future

// ------------------------------------------------------------- fixtures

/** A minimal, sound database: one verified club with a lead, one adult player, one case at under_review. */
function baseDb() {
  const db = {
    players: [{ id: 'pl-x', name: 'Xavier Adult', dob: '2000-05-05', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } }],
    orgs: [{ id: 'org-x', name: 'X FC', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, location: { lat: 51.5, lng: -0.1 } }],
    guardians: [],
    // A request names its staff member by a real key (recruitment_requests.user_id → org_users), so the
    // fixture carries the staff row the case and the request name (the dev login below finds it by org and name).
    users: [{ id: 'usr-owner', orgId: 'org-x', name: 'Owner', role: 'Head of Recruitment', createdAt: 1 }],
    sessions: [], ledger: [], notifications: [],
    recruitmentCases: [{
      id: 'case-x', orgId: 'org-x', playerId: 'pl-x', playerName: 'Xavier Adult', ownerUserId: 'usr-owner', ownerName: 'Owner', stage: 'review',
      priority: 'medium', restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
      room: { status: 'under_review', priority: 'normal', tags: [], leadScoutUserId: 'usr-owner', sourceContext: 'search', updatedAt: 1000, archivedAt: null, closedAt: null, rev: 2, revAt: 1000, revBy: null },
      createdAt: 1000, history: [{ id: 'aud-1', at: 1000, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_created', detail: { status: 'watching' } }, { id: 'aud-2', at: 1001, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_status_changed', detail: { from: 'watching', to: 'under_review', reasonCodes: [] } }],
    }],
  };
  db.trials ??= []; db.requests ??= [];
  return db;
}

/** A sound, fully-populated workflow trial row: two sessions, two revisions, two attendance records, one evidence link, keys. */
const soundTrial = (over = {}) => ({
  id: 'trial-1', requestId: 'req-1', caseId: 'case-x', playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', scoutName: 'Owner',
  acceptedAt: T0, acceptedBy: 'player', guardianApproved: false, proposedDate: '2027-01-15', venue: 'Dome, London', notes: '',
  reportDueAt: T0 + 7 * 86_400_000, status: 'awaiting_report',
  workflowState: 'scheduled',
  schedule: {
    timezone: 'Europe/London', revision: 2, proposedAt: T0 + 100, proposedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' },
    confirmedAt: T0 + 200, confirmedBy: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, declinedAt: null, declinedBy: null,
    sessions: [
      { id: 'tses-2', kind: 'match', startsAt: T0 + 48 * H, endsAt: T0 + 50 * H, venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, instructions: 'Gate B', evidence: [{ id: 'tev-1', kind: 'box_cam_session', sessionId: 'bx-1', linkedAt: T0 + 300, linkedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, removedAt: null, removedBy: null }] },
      { id: 'tses-1', kind: 'training', startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, instructions: null, evidence: [] },
    ],
    revisions: [
      { revision: 1, timezone: 'Europe/London', sessions: [{ id: 'tses-1', kind: 'training', startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, venue: { name: 'Dome', town: 'London', address: null }, instructions: null }], proposedAt: T0, proposedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, confirmedAt: T0, confirmedBy: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, supersededAt: T0 + 100, reason: 'invitation', material: null },
      { revision: 2, timezone: 'Europe/London', sessions: [{ id: 'tses-1', kind: 'training', startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, instructions: null }, { id: 'tses-2', kind: 'match', startsAt: T0 + 48 * H, endsAt: T0 + 50 * H, venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, instructions: 'Gate B' }], proposedAt: T0 + 100, proposedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, confirmedAt: T0 + 200, confirmedBy: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, supersededAt: null, reason: 'Added a match.', material: true },
    ],
  },
  attendance: [
    { sessionId: 'tses-1', state: 'no_show', source: 'manual', recordedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, recordedAt: T0 + 3 * H, note: null },
    { sessionId: 'tses-1', state: 'attended', source: 'manual', recordedBy: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, recordedAt: T0 + 3 * H + 1, note: 'Late.' },
  ],
  completion: null,
  recipient: { type: 'player', playerId: 'pl-x', guardianId: null, minor: false, at: T0 },
  keys: { schedule: [{ key: 'sk-1', fp: 'fp-1', at: T0 + 100 }], attendance: [{ key: 'ak-1', fp: 'fp-a', at: T0 + 3 * H + 1 }] },
  history: [
    { id: 'aud-10', at: T0, action: 'trial_accepted', by: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, detail: { recipientType: 'player', slotId: 'tslot-1', day: '2027-01-15' } },
    { id: 'aud-11', at: T0 + 100, action: 'trial_rescheduled', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { revision: 2, sessionCount: 2, material: true, requiresConfirmation: true } },
    { id: 'aud-12', at: T0 + 200, action: 'trial_schedule_confirmed', by: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, detail: { revision: 2, sessionCount: 2 } },
    { id: 'aud-13', at: T0 + 300, action: 'trial_evidence_linked', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { trialSessionId: 'tses-2', kind: 'box_cam_session', sessionId: 'bx-1' } },
  ],
  reminders: {}, rev: 5, revAt: T0 + 3 * H + 1, revBy: { userId: 'usr-owner', name: 'Owner' },
  ...over,
});

/** A trial without the workflow containers (the older shape, stored as `legacy_accepted`): a filed report (the report route's literal) and a trial day. */
const legacyTrial = () => ({
  id: 'trial-legacy', requestId: 'req-0', playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', scoutName: 'Owner',
  acceptedAt: T0 - 400 * H, acceptedBy: 'player', guardianApproved: false, proposedDate: '2026-12-01', venue: 'Old Ground', notes: 'Bring boots',
  reportDueAt: T0 - 300 * H, status: 'reported', workflowState: 'legacy_accepted', rev: 1,
  report: { id: 'rep-1', trialId: 'trial-legacy', playerId: 'pl-x', orgId: 'org-x', orgName: 'X FC', userId: 'usr-owner', scoutName: 'Owner', filedAt: T0 - 350 * H, acceleration: 7, sprintSpeedKmh: 30.5, distanceKm: 6.1, passCompletionPct: 80, duelSuccessPct: 50, coachRating: 7, notes: 'Fine.', strengthNote: null, focusNote: null },
  day: { staff: [], consents: [], arrival: null, emergency: { name: 'Mum', phone: '0770', setBy: 'player', at: T0 - 401 * H }, checkins: [{ playerId: 'pl-x', at: T0 - 399 * H, byUserId: 'usr-owner', byName: 'Owner' }], collection: null, statusEvents: [] },
});

const stableJson = (v) => JSON.stringify(v);
const write = (dir, db) => writeFixture(dir, db);
// What a new directory holds after a refused fixture (the migrations' reference rows and the first installation's
// organisation and player, by id): the yardstick for "nothing was written".
const rowIds = (d) => JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, rows]) => [k, rows.map((r) => r?.id ?? JSON.stringify(r))])));
const FRESH = (() => { const { orgs, players, guardians } = baseDb(); return rowIds(readRecords(writeFixture(mkdtempSync(path.join(tmpdir(), 'sbx-m23t-fresh-')), { orgs, players, guardians }))); })();
/** What a typed trial row reads back as — the record as written, with every absent field null and every absent list empty. */
const typedJson = (t) => { const r = typeTrial(t); if (!r.ok) throw new Error(r.reason); return stableJson(r.record); };

// ======================================================= 1 — the migration
section('1 — a trial row: neutral containers, nothing renamed, nothing invented');
{
  // The trials are typed rows read through SQL; every trial reads back from its row with the containers (typeTrial).
  ok(TABLE_BACKED.includes('trials') && !JOURNEY_REQUIRED_STORES.includes('trials') && DATA_MIGRATIONS.length === LATEST_SCHEMA, 'trials is a typed table read through SQL');
  const input = legacyTrial();
  const l = JSON.parse(typedJson(input)); // the legacy row as its typed table row reads back
  ok(stableJson(input) === stableJson(legacyTrial()) && l.workflowState === 'legacy_accepted' && l.caseId === null && l.schedule === null && Array.isArray(l.attendance) && l.attendance.length === 0 && l.completion === null && l.rev === 1 && Array.isArray(l.history) && l.history.length === 0 && Object.values(l.keys).every((k) => k === null || (Array.isArray(k) && k.length === 0)) && stableJson(l.reminders) === '{}', 'the legacy row, typed, reads back with legacy_accepted and empty containers (the record it came from untouched)');
  neg(l.status === 'reported' && l.report.id === 'rep-1' && l.proposedDate === '2026-12-01' && l.notes === 'Bring boots' && l.day.checkins.length === 1 && l.day.emergency.name === 'Mum', 'and keeps status, report, date, notes and the P2 day record exactly — no attendance derived from the check-in, no completion invented');
  neg(deriveWorkflowState(l) === 'legacy_accepted' && trialIntegrity(l, { orgId: 'org-x' }).length === 0, 'the legacy row is sound and derives legacy_accepted');
  const sound = soundTrial(); const soundBefore = stableJson(sound);
  ok(typeTrial(sound).ok && stableJson(sound) === soundBefore, 'a row that already carries P4B fields types cleanly and is left byte-identical');
  neg(!TRIAL_WORKFLOW_STATES.includes('awaiting_report') && !TRIAL_WORKFLOW_STATES.includes('reported'), 'the report statuses are not workflow states — nothing can have renamed them');
}

// ======================================================= 2 — byte-faithful restore
section('2 — a fixture with trial rows restores byte-faithfully through a real boot');
{
  const RESTORE_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-restore-'));
  const db = baseDb();
  db.trials.push(soundTrial(), legacyTrial());
  // The legacy trial carries a filed report; the player's trialReports are read from the trials, so the fixture
  // player carries no copy (a copy is refused).
  // A trial names its request by a real key (trials.request_id → recruitment_requests), so the legacy trial
  // gets the accepted invitation it came from (req-0, the legacy direct-request literal) beside the sound pair; a trial
  // naming an absent request is refused at the write with its id (PAIR_MISMATCH), never repaired. The legacy trial
  // row itself is unchanged.
  db.requests = [{ id: 'req-0', orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, playerId: 'pl-x', playerName: 'Xavier Adult', userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Come and train.', trialDetails: { proposedDate: '2026-12-01', altSlots: [], venue: 'Old Ground', notes: 'Bring boots' }, status: 'accepted', createdAt: T0 - 401 * H, respondedAt: T0 - 400 * H, respondedBy: 'player', routedTo: 'player', guardianId: null, contactChannel: null }, { id: 'req-1', orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, playerId: 'pl-x', playerName: 'Xavier Adult', userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Come.', status: 'accepted', routedTo: 'player', guardianId: null, contactChannel: null, createdAt: T0 - 1000, respondedAt: T0, respondedBy: 'player', caseId: 'case-x', trialId: 'trial-1', recipient: { type: 'player', playerId: 'pl-x', guardianId: null, minor: false }, keys: { invite: { key: 'ik-1', fp: 'fp-i' } }, trialDetails: { proposedDate: '2027-01-15', altSlots: [], venue: 'Dome, London', notes: '', slots: [{ id: 'tslot-1', day: '2027-01-15', kind: 'training', startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, timezone: 'Europe/London', venue: { name: 'Dome', town: 'London' } }], private: { venueAddress: '1 Dome Road', instructions: null } } }];
  db.recruitmentCases[0].room.status = 'trial_scheduled';
  db.recruitmentCases[0].links.trialIds.push('trial-1');
  write(RESTORE_DIR, db);
  const beforeSound = typedJson(db.trials[0]); const beforeLegacy = typedJson(db.trials[1]);
  const s = await bootOn(RESTORE_DIR, PORT);
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots on the fixture');
  const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/trials', undefined, lead.token);
  ok(list.status === 200 && list.body.items.length === 2 && list.body.omitted === 0, 'both trials serve from the room (the P4B row and the legacy row), none omitted');
  const t = list.body.items.find((x) => x.id === 'trial-1');
  ok(t.workflowState === 'scheduled' && t.rev === 5 && t.schedule.revision === 2 && t.schedule.sessions.map((x) => x.id).join(',') === 'tses-1,tses-2' && t.revisions.length === 2 && t.attendanceHistory.length === 2 && t.schedule.sessions[0].attendance.state === 'attended' && t.evidenceCount === 1, 'the P4B row projects with its rev, its two revisions, its ordered sessions, the current attendance and the evidence count');
  const l = list.body.items.find((x) => x.id === 'trial-legacy');
  ok(l.workflowState === 'legacy_accepted' && l.legacy === true && l.reportStatus === 'reported' && l.hasReport === true && l.schedule.legacy === true, 'the legacy row projects as legacy_accepted with its report and a date-only, flagged schedule');
  const replay = await s.j('POST', '/org/rooms/case-x/trials/trial-1/sessions/tses-1/attendance', { state: 'attended', expectedRev: 1, clientKey: 'ak-1', note: 'Late.' }, lead.token);
  // The stored fingerprint is a fixture value, not the live one: a different payload under the same key is a conflict — the KEY was restored.
  neg(replay.status === 409 && replay.body.error === 'TRIAL_IDEMPOTENCY_CONFLICT', 'the attendance idempotency key was restored from the snapshot (a mismatched fingerprint is a conflict, not a fresh write)');
  const inviteReplay = await s.j('POST', '/org/rooms/case-x/trials', { timezone: 'Europe/London', venue: { name: 'Dome', town: 'London' }, message: 'Come.', slots: [{ startsAt: T0 + 2 * H, endsAt: T0 + 4 * H }], clientKey: 'ik-1' }, lead.token);
  neg(inviteReplay.status === 409 && inviteReplay.body.error === 'TRIAL_IDEMPOTENCY_CONFLICT', 'the invitation key on the request row was restored too');
  const after = await s.stop();
  ok(after && stableJson(after.trials.find((x) => x.id === 'trial-1')) === beforeSound && stableJson(after.trials.find((x) => x.id === 'trial-legacy')) === beforeLegacy, 'after a boot, reads and a graceful stop, both rows are byte-identical in the snapshot — nothing was rewritten, re-ordered or "repaired"');
  neg(!s.log().includes('TRIAL integrity'), 'no integrity warning was logged for sound rows');
}

// ======================================================= 3 — corrupt rows
section('3 — corrupt trial rows are named and omitted, never fabricated, never fatal');
{
  const CORRUPT_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-corrupt-'));
  const db = baseDb();
  // Every trial names its own accepted invitation (trials.request_id is a UNIQUE key to recruitment_requests) and
  // only the sound trial is OPEN in case-x (trials_one_open_per_case). The typed tables hold a trial whose stored state
  // disagrees with its facts, a timezone that is not a zone and rev 0 — corruption a typed row can still carry — so
  // those three are planted and judged on read. A state, a completion or an attendance row outside the vocabulary and
  // an off-type `sessions` cannot be stored at all: section 3c proves the save refuses them with their ids.
  const invitation = (id, trialId) => ({ id, orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, playerId: 'pl-x', playerName: 'Xavier Adult', userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Come.', trialDetails: { proposedDate: '2027-01-15', altSlots: [], venue: 'Dome, London', notes: '' }, status: 'accepted', createdAt: T0 - 1000, respondedAt: T0, respondedBy: 'player', routedTo: 'player', guardianId: null, contactChannel: null, caseId: 'case-x', trialId });
  db.trials.push(
    soundTrial(),
    soundTrial({ id: 'trial-bad-mismatch', requestId: 'req-bad-mismatch', workflowState: 'completed' }),
    soundTrial({ id: 'trial-bad-tz', requestId: 'req-bad-tz', workflowState: 'cancelled', schedule: { ...soundTrial().schedule, timezone: 'Mars/Olympus' } }),
    soundTrial({ id: 'trial-bad-rev', requestId: 'req-bad-rev', workflowState: 'cancelled', rev: 0 }),
  );
  db.requests = db.trials.map((t) => invitation(t.requestId, t.id));
  write(CORRUPT_DIR, db);
  const s = await bootOn(CORRUPT_DIR, PORT + 1);
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots with four trials, three of them corrupt rows');
  const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/trials', undefined, lead.token);
  if (list.status !== 200) console.error('   list', list.status, JSON.stringify(list.body).slice(0, 300), s.log().split('\n').filter((l) => /Error|TypeError/.test(l)).slice(0, 4).join(' | '));
  ok(list.status === 200 && list.body.items.length === 1 && list.body.items[0].id === 'trial-1', 'the room serves the one sound trial');
  neg(list.body.omitted === 3, `three corrupt rows are counted as omitted (${list.body.omitted})`);
  const one = await s.j('GET', '/org/rooms/case-x/trials/trial-bad-mismatch', undefined, lead.token);
  neg(one.status === 500 && one.body.error === 'TRIAL_STATE_UNKNOWN', 'reading a corrupt row by id is TRIAL_STATE_UNKNOWN (500), never a fabricated view');
  const mut = await s.j('POST', '/org/rooms/case-x/trials/trial-bad-tz/cancel', { expectedRev: 5, reason: 'x' }, lead.token);
  neg(mut.status === 500 && mut.body.error === 'TRIAL_STATE_UNKNOWN', 'nor can a corrupt row be mutated');
  const log = s.log();
  neg(['trial-bad-mismatch', 'trial-bad-tz', 'trial-bad-rev'].every((id) => log.includes(`TRIAL integrity ${id}`)), 'every corrupt row is NAMED in the server log with its problem codes');
  const journey = await s.j('GET', '/org/rooms/case-x/journey', undefined, lead.token);
  ok(journey.status === 200 && journey.body.trials.length === 1 && journey.body.trialsOmitted === 3, 'the journey omits and counts the same three');
  const after = await s.stop();
  neg(after.trials.length === 4 && after.trials.some((x) => x.id === 'trial-bad-tz' && x.schedule.timezone === 'Mars/Olympus') && after.trials.some((x) => x.id === 'trial-bad-rev' && x.rev === 0), 'the corrupt rows are still in the snapshot exactly as they were — omitted on read, never deleted or repaired');
  if (after.trials.map(stableJson).join() !== db.trials.map(typedJson).join()) { for (let i = 0; i < db.trials.length; i += 1) if (stableJson(after.trials[i]) !== typedJson(db.trials[i])) console.error('   changed row', i, JSON.stringify(after.trials[i]).slice(0, 200)); }
}

// ======================================================= 3c — records the typed tables cannot hold
section('3c — a state, a completion or an attendance row outside the vocabulary, or an off-type list, is refused by the write with its id');
{
  const db = baseDb();
  const invitation = (id) => ({ id, orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, playerId: 'pl-x', playerName: 'Xavier Adult', userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Come.', trialDetails: { proposedDate: null, altSlots: [], venue: null, notes: '' }, status: 'accepted', createdAt: T0 - 1000, routedTo: 'player', guardianId: null, contactChannel: null });
  const cases = [
    ['trial-bad-state', { workflowState: 'flying' }, /trial-bad-state\.workflowState must be one of/],
    ['trial-bad-att', { workflowState: 'cancelled', attendance: [{ sessionId: 'ghost', state: 'attended' }] }, /trial-bad-att attendance\[0\]\.source must be one of/],
    ['trial-bad-sessions', { workflowState: 'cancelled', schedule: { ...soundTrial().schedule, sessions: 'two' } }, /trial-bad-sessions\.schedule\.sessions must be a list/],
    ['trial-bad-completion', { workflowState: 'cancelled', completion: { state: 'done', at: 1 } }, /trial-bad-completion\.completion\.state must be one of/],
  ];
  for (const [id, over, named] of cases) {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-unstorable-'));
    db.trials = [soundTrial({ id, requestId: `req-${id}`, caseId: null, ...over })];
    db.requests = [invitation(`req-${id}`)];
    let refused = null;
    try { write(dir, db); } catch (err) { refused = err; }
    neg(refused?.code === 'RECRUITMENT_INPUT_INVALID' && named.test(String(refused.message)), `${id}: the write is refused and names the trial and the field (${String(refused?.message ?? 'not refused').slice(0, 160)})`);
    neg(rowIds(readRecords(dir)) === FRESH, `${id}: nothing was written`);
  }
}

// ======================================================= 3b — alien entries
section('3b — alien entries in the trials store are refused with their positions; the file is not modified');
{
  // A null, a string or a number in the trials store is not a record: the trials repository's create refuses each by
  // its kind and nothing of the fixture is written. Nothing is dropped or repaired silently.
  const req1 = { id: 'req-1', orgId: 'org-x', orgName: 'X FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, playerId: 'pl-x', playerName: 'Xavier Adult', userId: 'usr-owner', scoutName: 'Owner', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Come.', trialDetails: { proposedDate: '2027-01-15', altSlots: [], venue: 'Dome, London', notes: '' }, status: 'accepted', createdAt: T0 - 1000, respondedAt: T0, respondedBy: 'player', routedTo: 'player', guardianId: null, contactChannel: null, caseId: 'case-x', trialId: 'trial-1' };
  let ALIEN_DIR = null;
  for (const [alien, what] of [[null, 'null'], ['string', 'a string'], [42, 'a number']]) {
    ALIEN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-alien-'));
    const db = baseDb();
    db.trials.push(soundTrial(), alien);
    db.requests = [req1];
    let refused = null;
    try { write(ALIEN_DIR, db); } catch (err) { refused = err; }
    const msg = String(refused?.message ?? '');
    neg(refused?.code === 'RECRUITMENT_INPUT_INVALID' && msg.includes(`trials is not an object (${what})`), `a trials entry that is ${what} is refused by its kind (${msg.slice(0, 120)})`);
    neg(rowIds(readRecords(ALIEN_DIR)) === FRESH, `${what}: nothing was written: the directory holds only the first installation`);
  }
  const s = await bootOn(ALIEN_DIR, PORT + 2);
  ok(s.up, 'a server started on the directory boots (the refused fixture left nothing behind)');
  if (s.up) await s.stop();
}

// ======================================================= 4 — clean boot, live flow, restart
section('4 — clean boot: invitation, acceptance, restart — keys and stages survive');
{
  const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-clean-'));
  write(CLEAN_DIR, baseDb());
  const s = await bootOn(CLEAN_DIR, PORT + 2);
  const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const player = (await s.j('POST', '/auth/player/login', { playerId: 'pl-x' })).body;
  const NOW = Date.now();
  const inv = await s.j('POST', '/org/rooms/case-x/trials', { timezone: 'Europe/London', venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, message: 'Come and train.', instructions: 'Gate B', slots: [{ startsAt: NOW + 2 * H, endsAt: NOW + 4 * H }], clientKey: 'clean-inv' }, lead.token);
  ok(inv.status === 201 && inv.body.case.to === 'trial_requested', 'an invitation goes out from a clean database');
  const inbox = (await s.j('GET', '/player/inbox', undefined, player.token)).body.items.find((r) => r.type === 'trial' && r.status === 'pending');
  const acc = await s.j('POST', `/player/requests/${inbox.id}/respond`, { accept: true, chosenSlot: inbox.trialDetails.proposedDate }, player.token);
  ok(acc.status === 200 && acc.body.trialId, 'the player accepts');
  const snap1 = await s.stop();
  const row = snap1.trials.find((t) => t.id === acc.body.trialId);
  ok(row && row.workflowState === 'scheduled' && row.caseId === 'case-x' && row.schedule.sessions.length === 1 && row.history[0]?.action === 'trial_accepted' && row.requestId === snap1.requests[0].id && snap1.recruitmentCases[0].room.status === 'trial_scheduled' && snap1.requests[0].keys.invite.key === 'clean-inv', 'the snapshot holds the scheduled trial, the case at trial_scheduled and the invitation key');
  const s2 = await bootOn(CLEAN_DIR, PORT + 3);
  const lead2 = (await s2.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const replay = await s2.j('POST', '/org/rooms/case-x/trials', { timezone: 'Europe/London', venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, message: 'Come and train.', instructions: 'Gate B', slots: [{ startsAt: NOW + 2 * H, endsAt: NOW + 4 * H }], clientKey: 'clean-inv' }, lead2.token);
  neg(replay.status === 200 && replay.body.idempotent === true && replay.body.invitation.id === inbox.id, 'after the restart the invitation key replays from the row');
  const t = (await s2.j('GET', `/org/rooms/case-x/trials/${acc.body.trialId}`, undefined, lead2.token)).body;
  ok(t.trial.workflowState === 'scheduled' && t.trial.rev === 1 && t.trial.history.map((h) => h.action).join(',') === 'trial_accepted,trial_schedule_confirmed', 'the trial is exactly as it was: scheduled, rev 1, two history entries');
  const jr = (await s2.j('GET', '/org/rooms/case-x/journey', undefined, lead2.token)).body;
  ok(jr.lifecycle.currentStage === 'trial_scheduled' && jr.history.entries.some((e) => e.kind === 'trial_accepted'), 'the case stage and the milestone survived');
  const snap2 = await s2.stop();
  const strip = (rows) => stableJson(rows.map((t) => ({ ...t, reminders: undefined })));
  ok(strip(snap2.trials) === strip(snap1.trials), 'a boot, a replay and a stop rewrote nothing in the trials store (reminder markers aside)');
  const row2 = snap2.trials.find((t) => t.id === acc.body.trialId);
  ok(Object.keys(row2.reminders).some((k) => k.startsWith('t48:')) && Object.keys(row.reminders).length === 0, 'the T-48h reminder for the session two hours away went out on the second boot and left its marker ON THE ROW — a restart re-sends nothing (the marker is persisted, not timer-held)');
  const health = createEvidenceProvider(snap2).check('trial_confirmed', { kase: snap2.recruitmentCases[0] });
  ok(health.satisfied === true && health.sourceId === acc.body.trialId, 'the evidence provider, over the snapshot alone, still finds the confirmed schedule');
}

// ---------------------------------------------------------------- report
const total = passed;
console.log(`\nrecruitment/trialsPersistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`);
if (process.exitCode === 1) console.error('\n✗ recruitment/trialsPersistence has failures.');
else console.log('all recruitment/trialsPersistence checks passed');
process.exit(process.exitCode ?? 0);
