// M23 P4B — Trial persistence suite.
//
// THE INVARIANTS
//
//   1. Schema 2304 adds the operational containers to every trial row with
//      NEUTRAL values (`legacy_accepted`, no schedule, no attendance, no
//      completion) and never renames `awaiting_report` / `reported`, never
//      invents a date, an attendance or a completion. Running it twice
//      changes nothing.
//   2. A snapshot that carries P4B trial rows restores them byte-faithfully
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
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { JOURNEY_REQUIRED_STORES } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import { trialIntegrity, deriveWorkflowState, TRIAL_WORKFLOW_STATES } from '../m23/trial.mjs';
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

/** Boot the real server on a directory; return a client and a stop() that SIGTERMs and reads the snapshot back. */
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
    return openStore(dataDir).load()?.db ?? null;
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
    orgs: [{ id: 'org-x', name: 'X FC', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, squad: [], location: { lat: 51.5, lng: -0.1 } }],
    guardians: [], users: [], sessions: [], ledger: [], notifications: [],
    recruitmentCases: [{
      id: 'case-x', orgId: 'org-x', playerId: 'pl-x', playerName: 'Xavier Adult', ownerUserId: 'usr-owner', ownerName: 'Owner', stage: 'review',
      priority: 'medium', restricted: false, assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
      room: { status: 'under_review', priority: 'normal', tags: [], leadScoutUserId: 'usr-owner', sourceContext: 'search', updatedAt: 1000, archivedAt: null, closedAt: null, rev: 2, revAt: 1000, revBy: null },
      createdAt: 1000, history: [{ id: 'aud-1', at: 1000, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_created', detail: { status: 'watching' } }, { id: 'aud-2', at: 1001, byKind: 'org', byId: 'usr-owner', byName: 'Owner', action: 'room_status_changed', detail: { from: 'watching', to: 'under_review', reasonCodes: [] } }],
    }],
  };
  runMigrations(db);
  return db;
}

/** A sound, fully-populated P4B trial row: two sessions, two revisions, two attendance records, one evidence link, keys. */
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
  keys: { accept: { key: null, fp: '{"requestId":"req-1","day":"2027-01-15"}' }, schedule: [{ key: 'sk-1', fp: 'fp-1', at: T0 + 100 }], attendance: [{ key: 'ak-1', fp: 'fp-a', at: T0 + 3 * H + 1 }] },
  history: [
    { id: 'aud-10', at: T0, action: 'trial_accepted', by: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, detail: { recipientType: 'player', slotId: 'tslot-1', day: '2027-01-15' } },
    { id: 'aud-11', at: T0 + 100, action: 'trial_rescheduled', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { revision: 2, sessionCount: 2, material: true, requiresConfirmation: true } },
    { id: 'aud-12', at: T0 + 200, action: 'trial_schedule_confirmed', by: { kind: 'player', id: 'pl-x', name: 'Xavier Adult' }, detail: { revision: 2, sessionCount: 2 } },
    { id: 'aud-13', at: T0 + 300, action: 'trial_evidence_linked', by: { kind: 'org', userId: 'usr-owner', name: 'Owner' }, detail: { trialSessionId: 'tses-2', kind: 'box_cam_session', sessionId: 'bx-1' } },
  ],
  reminders: {}, rev: 5, revAt: T0 + 3 * H + 1, revBy: { userId: 'usr-owner', name: 'Owner' },
  ...over,
});

const legacyTrial = () => ({
  id: 'trial-legacy', requestId: 'req-0', playerId: 'pl-x', playerName: 'Xavier Adult', orgId: 'org-x', orgName: 'X FC', scoutName: 'Owner',
  acceptedAt: T0 - 400 * H, acceptedBy: 'player', guardianApproved: false, proposedDate: '2026-12-01', venue: 'Old Ground', notes: 'Bring boots',
  reportDueAt: T0 - 300 * H, status: 'reported', report: { id: 'rep-1', trialId: 'trial-legacy', playerId: 'pl-x', orgId: 'org-x', filedAt: T0 - 350 * H, notes: 'Fine.' },
  day: { staff: [], consents: [], arrival: null, emergency: { name: 'Mum', phone: '0770' }, checkins: [{ playerId: 'pl-x', at: T0 - 399 * H, byUserId: 'usr-owner', byName: 'Owner' }], collection: null, statusEvents: [] },
});

const stableJson = (v) => JSON.stringify(v);

// ======================================================= 1 — the migration
section('1 — schema 2304: neutral containers, nothing renamed, nothing invented, idempotent');
{
  ok(guaranteeFor('trials') === 'migration' && PRODUCTION_REQUIRED_STORES.includes('trials') && JOURNEY_REQUIRED_STORES.includes('trials'), 'trials is migration-guaranteed, production-required and journey-required (unchanged from P4A)');
  const step = MIGRATIONS.find((m) => m.id === 'm230_005_trial_workflow');
  ok(step?.version === 2304 && SCHEMA_VERSION === 2304, 'm230_005_trial_workflow is version 2304, the current schema');
  const db = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [], trials: [legacyTrial(), soundTrial()] };
  runMigrations(db);
  db.schema.version = 2303; db.schema.migrations = db.schema.migrations.filter((m) => m.id !== 'm230_005_trial_workflow');
  // Simulate a 2303 snapshot: strip the containers from the legacy row only (it never had them).
  const before = stableJson(db.trials[1]);
  const up = runMigrations(db);
  ok(up.ran.join(',') === 'm230_005_trial_workflow' && up.to === 2304, 'a 2303 snapshot runs exactly the Trial step');
  const l = db.trials[0];
  ok(l.workflowState === 'legacy_accepted' && l.caseId === null && l.schedule === null && Array.isArray(l.attendance) && l.attendance.length === 0 && l.completion === null && l.rev === 1 && Array.isArray(l.history) && l.history.length === 0 && stableJson(l.keys) === '{}' && stableJson(l.reminders) === '{}', 'the legacy row gains legacy_accepted and empty containers');
  neg(l.status === 'reported' && l.report.id === 'rep-1' && l.proposedDate === '2026-12-01' && l.notes === 'Bring boots' && l.day.checkins.length === 1 && l.day.emergency.name === 'Mum', 'and keeps status, report, date, notes and the P2 day record exactly — no attendance derived from the check-in, no completion invented');
  neg(deriveWorkflowState(l) === 'legacy_accepted' && trialIntegrity(l, { orgId: 'org-x' }).length === 0, 'the legacy row is sound and derives legacy_accepted');
  ok(stableJson(db.trials[1]) === before, 'a row that already carries P4B fields is byte-identical after the step');
  const again = runMigrations(db);
  ok(again.ran.length === 0 && stableJson(db.trials[0]) === stableJson(l), 'running it twice changes nothing');
  neg(!TRIAL_WORKFLOW_STATES.includes('awaiting_report') && !TRIAL_WORKFLOW_STATES.includes('reported'), 'the report statuses are not workflow states — the migration cannot have renamed them');
  const missing = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [] };
  runMigrations(missing);
  ok(Array.isArray(missing.trials) && missing.trials.length === 0, 'a database with no trials store gets an empty one (P4A guarantee), and the Trial step tolerates it');
  const bad = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [], trials: [null, 'x', 7, { id: 'only-id' }] };
  let threw = null;
  try { runMigrations(bad); } catch (e) { threw = e; }
  neg(threw === null && bad.trials.length === 4 && bad.trials[3].workflowState === 'legacy_accepted', 'garbage entries in the store do not throw the migration; a bare row still gains its containers');
}

// ======================================================= 2 — byte-faithful restore
section('2 — a snapshot with P4B trial rows restores byte-faithfully through a real boot');
{
  const RESTORE_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-restore-'));
  const db = baseDb();
  db.trials.push(soundTrial(), legacyTrial());
  db.requests = [{ id: 'req-1', orgId: 'org-x', orgName: 'X FC', playerId: 'pl-x', userId: 'usr-owner', scoutName: 'Owner', type: 'trial', message: 'Come.', status: 'accepted', routedTo: 'player', createdAt: T0 - 1000, respondedAt: T0, respondedBy: 'player', caseId: 'case-x', trialId: 'trial-1', recipient: { type: 'player', playerId: 'pl-x', guardianId: null, minor: false }, keys: { invite: { key: 'ik-1', fp: 'fp-i' } }, trialDetails: { proposedDate: '2027-01-15', altSlots: [], venue: 'Dome, London', notes: '', slots: [{ id: 'tslot-1', day: '2027-01-15', kind: 'training', startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, timezone: 'Europe/London', venue: { name: 'Dome', town: 'London' } }], private: { venueAddress: '1 Dome Road', instructions: null } } }];
  db.recruitmentCases[0].room.status = 'trial_scheduled';
  db.recruitmentCases[0].links.trialIds.push('trial-1');
  const written = openStore(RESTORE_DIR);
  written.save({ db });
  const beforeSound = stableJson(db.trials[0]); const beforeLegacy = stableJson(db.trials[1]);
  const s = await bootOn(RESTORE_DIR, PORT);
  ok(s.up, 'the server boots on the snapshot');
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
  db.trials.push(
    soundTrial(),
    soundTrial({ id: 'trial-bad-state', workflowState: 'flying' }),
    soundTrial({ id: 'trial-bad-mismatch', workflowState: 'completed' }),
    soundTrial({ id: 'trial-bad-att', attendance: [{ sessionId: 'ghost', state: 'attended' }] }),
    soundTrial({ id: 'trial-bad-tz', schedule: { ...soundTrial().schedule, timezone: 'Mars/Olympus' } }),
    soundTrial({ id: 'trial-bad-sessions', schedule: { ...soundTrial().schedule, sessions: 'two' } }),
    soundTrial({ id: 'trial-bad-rev', rev: 0 }),
    soundTrial({ id: 'trial-bad-completion', completion: { state: 'done', at: 1 } }),
    null, 'string', 42,
  );
  openStore(CORRUPT_DIR).save({ db });
  const s = await bootOn(CORRUPT_DIR, PORT + 1);
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots with eleven bad or alien entries in the trials store');
  const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const list = await s.j('GET', '/org/rooms/case-x/trials', undefined, lead.token);
  if (list.status !== 200) console.error('   list', list.status, JSON.stringify(list.body).slice(0, 300), s.log().split('\n').filter((l) => /Error|TypeError/.test(l)).slice(0, 4).join(' | '));
  ok(list.status === 200 && list.body.items.length === 1 && list.body.items[0].id === 'trial-1', 'the room serves the one sound trial');
  neg(list.body.omitted === 7, `seven corrupt rows are counted as omitted (${list.body.omitted}), the three alien entries are ignored`);
  const one = await s.j('GET', '/org/rooms/case-x/trials/trial-bad-state', undefined, lead.token);
  neg(one.status === 500 && one.body.error === 'TRIAL_STATE_UNKNOWN', 'reading a corrupt row by id is TRIAL_STATE_UNKNOWN (500), never a fabricated view');
  const mut = await s.j('POST', '/org/rooms/case-x/trials/trial-bad-tz/cancel', { expectedRev: 5, reason: 'x' }, lead.token);
  neg(mut.status === 500 && mut.body.error === 'TRIAL_STATE_UNKNOWN', 'nor can a corrupt row be mutated');
  const log = s.log();
  neg(['trial-bad-state', 'trial-bad-mismatch', 'trial-bad-att', 'trial-bad-tz', 'trial-bad-sessions', 'trial-bad-rev', 'trial-bad-completion'].every((id) => log.includes(`TRIAL integrity ${id}`)), 'every corrupt row is NAMED in the server log with its problems');
  const journey = await s.j('GET', '/org/rooms/case-x/journey', undefined, lead.token);
  ok(journey.status === 200 && journey.body.trials.length === 1 && journey.body.trialsOmitted === 7, 'the journey omits and counts the same seven');
  const after = await s.stop();
  neg(after.trials.filter((x) => x && typeof x === 'object').length === 8 && after.trials.some((x) => x?.id === 'trial-bad-state' && x.workflowState === 'flying'), 'the corrupt rows are still in the snapshot exactly as they were — omitted on read, never deleted or "repaired" on write');
  if (stableJson(after.trials) !== stableJson(db.trials)) { for (let i = 0; i < db.trials.length; i += 1) if (stableJson(after.trials[i]) !== stableJson(db.trials[i])) console.error('   changed row', i, JSON.stringify(after.trials[i]).slice(0, 200)); }
}

// ======================================================= 4 — clean boot, live flow, restart
section('4 — clean boot: invitation, acceptance, restart — keys and stages survive');
{
  const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-clean-'));
  openStore(CLEAN_DIR).save({ db: baseDb() });
  const s = await bootOn(CLEAN_DIR, PORT + 2);
  const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })).body;
  const player = (await s.j('POST', '/auth/player/login', { playerId: 'pl-x' })).body;
  const NOW = Date.now();
  const inv = await s.j('POST', '/org/rooms/case-x/trials', { timezone: 'Europe/London', venue: { name: 'Dome', town: 'London', address: '1 Dome Road' }, message: 'Come and train.', instructions: 'Gate B', slots: [{ startsAt: NOW + 2 * H, endsAt: NOW + 4 * H }], clientKey: 'clean-inv' }, lead.token);
  ok(inv.status === 201 && inv.body.case.to === 'trial_requested', 'an invitation goes out from a clean database');
  const inbox = (await s.j('GET', '/player/inbox', undefined, player.token)).body.find((r) => r.type === 'trial' && r.status === 'pending');
  const acc = await s.j('POST', `/player/requests/${inbox.id}/respond`, { accept: true, chosenSlot: inbox.trialDetails.proposedDate }, player.token);
  ok(acc.status === 200 && acc.body.trialId, 'the player accepts');
  const snap1 = await s.stop();
  const row = snap1.trials.find((t) => t.id === acc.body.trialId);
  ok(row && row.workflowState === 'scheduled' && row.caseId === 'case-x' && row.schedule.sessions.length === 1 && row.keys.accept && snap1.recruitmentCases[0].room.status === 'trial_scheduled' && snap1.requests[0].keys.invite.key === 'clean-inv', 'the snapshot holds the scheduled trial, the case at trial_scheduled and the invitation key');
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
console.log(`\nM23 P4B Trial persistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P4B Trial persistence has failures.');
else console.log('all M23 P4B Trial persistence checks passed');
process.exit(process.exitCode ?? 0);
