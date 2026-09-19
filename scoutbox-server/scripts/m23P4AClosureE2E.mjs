// M23 P4A closure suite — the three Mediums the architecture milestone left
// open, closed and proved, plus the smaller findings closed with them.
//
//   P4A-D1   Trial dates: one validator, refusal before persistence, one
//            report-deadline derivation from one clock, read-side defence for
//            legacy rows (no 500, no fabricated date), restart consistency.
//   P4A-D10  A minor hears their guardian's decision: the outcome is a
//            request outcome (`guardian_decision` → "Messages and requests"),
//            not a discovery nudge that is off by default.
//   P4A-D14  A player who removes their account leaves an id-only tombstone
//            behind on their trials and requests; the recruitment case is not
//            moved, nothing person-shaped is retained, nothing new can be
//            written about them, and every reader copes.
//   P4A-D2/D4/D5/D12/D13 closed alongside (report date, one accept writer,
//            finalize rate limit, unknown slot refused, respondedBy on both
//            paths).
//
// Groups:
//   A  pure — the validator against every malformed shape the mandate lists
//   B  HTTP — D1 on the request, accept, calendar, postpone and feed paths
//   C  HTTP — D10, preferences, prototype keys, the privacy sentinel
//   D  HTTP — D14 cascade matrix, gate, readers, foreign org, guardian path
//   L  legacy rows injected into the store: read-side defence, signed
//      invariant, restart consistency
//   R  D5 finalize rate limit; clean-boot schema unchanged
//
// No assertion is `status !== 200`: every refusal names its status and code.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTrialDate, isTrialDate, trialReportDueAt, validateTrialDetails, chooseTrialSlot,
  TRIAL_REPORT_WINDOW_MS, TRIAL_DATE_SYNTAX, TRIAL_DETAIL_LIMITS, TRIAL_REPORT_FIELDS,
} from '../domain.mjs';
import { CATEGORIES, TYPE_CATEGORY, categoryOf } from '../m182/notificationPrefs.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { SCHEMA_VERSION } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';

const PORT = 6200 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-p4a-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
const SENTINEL = 'PRIVATE_TRIAL_INTERNAL_SENTINEL_8472';
const DAY = 24 * 3600 * 1000;

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body ?? r.text).slice(0, 220)}`);
  return good;
};
const utcDay = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const FUTURE = dayStr(Date.now() + 21 * DAY);
const FUTURE2 = dayStr(Date.now() + 28 * DAY);
const FUTURE3 = dayStr(Date.now() + 35 * DAY);
const FUTURE4 = dayStr(Date.now() + 42 * DAY);
const PAST = dayStr(Date.now() - 30 * DAY);

// ============================================================ A — pure validator
section('A — one Trial date validator, every malformed shape refused before persistence');
{
  const malformed = ['not-a-date', '2026-13-99', '2026-02-31', {}, [], 0, NaN, 'NaN', ' 2026-10-03', '2026-10-03 ', '\t2026-10-03',
    '2026-10-03T10:00', '2026-10-03T00:00:00Z', '1999-12-31', '2101-01-01', '0000-01-01', '9999-12-31', '2026-1-3', '20261003',
    true, false, 1e12, -1, '2026-02-29', '2026-04-31', '2026-00-10', '2026-10-00', '2026/10/03', '03-10-2026', 'today', 'next tuesday-ish',
    Symbol.for('x'), () => {}, new Date('2026-10-03'), { proposedDate: '2026-10-03' }, ['2026-10-03']];
  for (const m of malformed) {
    const r = parseTrialDate(m);
    neg(r.ok === false && r.error === 'TRIAL_DATE_INVALID' && r.expected === TRIAL_DATE_SYNTAX,
      `A1 ${typeof m === 'symbol' ? 'Symbol' : typeof m === 'function' ? 'function' : JSON.stringify(m) ?? String(m)} is refused as TRIAL_DATE_INVALID`);
  }
  for (const absent of ['', null, undefined]) {
    const r = parseTrialDate(absent);
    ok(r.ok === true && r.value === null && r.t === null, `A2 ${JSON.stringify(absent) ?? 'undefined'} means "no date", never an error and never a fabricated day`);
  }
  const good = parseTrialDate('2026-10-03');
  ok(good.ok && good.value === '2026-10-03' && good.t === Date.UTC(2026, 9, 3), 'A3 a calendar day parses to its own string and its UTC midnight');
  ok(parseTrialDate('2028-02-29').ok === true, 'A3b a real leap day is accepted');
  neg(parseTrialDate('2027-02-29').ok === false, 'A3c a leap day in a non-leap year is refused');
  ok(parseTrialDate('2000-01-01').ok && parseTrialDate('2100-12-31').ok, 'A3d the accepted range is inclusive at both ends');
  neg(isTrialDate('') === false && isTrialDate(null) === false && isTrialDate('bad') === false && isTrialDate('2026-10-03') === true, 'A4 isTrialDate is true only for a real stored day');

  ok(trialReportDueAt('2026-10-03', 5) === Date.UTC(2026, 9, 3) + TRIAL_REPORT_WINDOW_MS, 'A5 the deadline is trial day + 7 days, from the day not the acceptance');
  ok(trialReportDueAt(null, 1000) === 1000 + TRIAL_REPORT_WINDOW_MS, 'A5b with no day it is acceptance + 7 days, from the clock the caller passed');
  neg(trialReportDueAt('garbage', 1000) === 1000 + TRIAL_REPORT_WINDOW_MS, 'A5c a legacy garbage day falls back to the acceptance clock, never NaN');
  neg(trialReportDueAt(null, NaN) === null && trialReportDueAt(null, undefined) === null && trialReportDueAt('bad', 'bad') === null, 'A5d with nothing finite to derive from the answer is null, not NaN');
  ok(TRIAL_REPORT_WINDOW_MS === 7 * DAY, 'A5e the window is exactly seven days');

  const full = validateTrialDetails({ proposedDate: '2026-10-03', altSlots: ['2026-10-10', '2026-10-17'], venue: 'Eastport Dome', notes: 'Bring boots.' });
  ok(full.ok && JSON.stringify(full.details) === JSON.stringify({ proposedDate: '2026-10-03', altSlots: ['2026-10-10', '2026-10-17'], venue: 'Eastport Dome', notes: 'Bring boots.' }), 'A6 valid details come back canonical and untouched');
  ok(JSON.stringify(validateTrialDetails({}).details) === JSON.stringify({ proposedDate: null, altSlots: [], venue: null, notes: '' }), 'A6b nothing given is a date-to-be-confirmed invitation with empty logistics');
  ok(validateTrialDetails(null).ok && validateTrialDetails('text').ok && validateTrialDetails(42).ok, 'A6c a non-object body is treated as no details, not a crash');
  neg(validateTrialDetails({ proposedDate: 'bad' }).error === 'TRIAL_DATE_INVALID' && validateTrialDetails({ proposedDate: 'bad' }).field === 'proposedDate', 'A7 a bad proposed date is refused and names its field');
  neg(validateTrialDetails({ altSlots: 'x' }).error === 'TRIAL_SLOTS_INVALID', 'A7b altSlots must be a list');
  neg(validateTrialDetails({ altSlots: { 0: '2026-10-10', length: 1 } }).error === 'TRIAL_SLOTS_INVALID', 'A7c an array-like object is not a list');
  neg(validateTrialDetails({ altSlots: ['2026-10-10', '2026-10-17', '2026-10-24'] }).error === 'TRIAL_SLOTS_INVALID', `A7d more than ${TRIAL_DETAIL_LIMITS.altSlots} slots is refused, not truncated`);
  neg(validateTrialDetails({ altSlots: ['2026-10-10', 'bad'] }).error === 'TRIAL_DATE_INVALID' && validateTrialDetails({ altSlots: ['2026-10-10', 'bad'] }).field === 'altSlots', 'A7e a bad slot is refused as a date, naming altSlots');
  neg(validateTrialDetails({ altSlots: [''] }).error === 'TRIAL_SLOTS_INVALID' && validateTrialDetails({ altSlots: [null] }).error === 'TRIAL_SLOTS_INVALID', 'A7f an empty slot is refused (there is no such thing as an alternative "no date")');
  neg(validateTrialDetails({ proposedDate: '2026-10-03', altSlots: ['2026-10-03'] }).error === 'TRIAL_SLOTS_INVALID', 'A7g a slot equal to the proposed day is refused');
  neg(validateTrialDetails({ altSlots: ['2026-10-10', '2026-10-10'] }).error === 'TRIAL_SLOTS_INVALID', 'A7h duplicate slots are refused');
  neg(validateTrialDetails({ venue: 'x'.repeat(TRIAL_DETAIL_LIMITS.venue + 1) }).error === 'TRIAL_VENUE_INVALID', 'A8 an over-long venue is refused, not clamped');
  ok(validateTrialDetails({ venue: 'x'.repeat(TRIAL_DETAIL_LIMITS.venue) }).ok, 'A8b exactly the limit is accepted');
  neg(validateTrialDetails({ venue: 'Gate B\nEND:VEVENT' }).error === 'TRIAL_VENUE_INVALID' && validateTrialDetails({ venue: 'a\rb' }).error === 'TRIAL_VENUE_INVALID' && validateTrialDetails({ venue: 'a\u0000b' }).error === 'TRIAL_VENUE_INVALID', 'A8c a venue with a line break or control character is refused (it is written into a calendar file)');
  neg(validateTrialDetails({ venue: {} }).error === 'TRIAL_VENUE_INVALID' && validateTrialDetails({ venue: 5 }).error === 'TRIAL_VENUE_INVALID' && validateTrialDetails({ venue: [] }).error === 'TRIAL_VENUE_INVALID', 'A8d a non-text venue is refused');
  ok(validateTrialDetails({ venue: '' }).details.venue === null && validateTrialDetails({ venue: null }).details.venue === null, 'A8e an empty venue is no venue');
  neg(validateTrialDetails({ notes: 'x'.repeat(TRIAL_DETAIL_LIMITS.notes + 1) }).error === 'TRIAL_NOTES_INVALID' && validateTrialDetails({ notes: 5 }).error === 'TRIAL_NOTES_INVALID' && validateTrialDetails({ notes: {} }).error === 'TRIAL_NOTES_INVALID', 'A9 over-long or non-text notes are refused');
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
    const o = JSON.parse(`{"${key}": {"proposedDate": "bad"}, "proposedDate": "2026-10-03"}`);
    const r = validateTrialDetails(o);
    neg(r.ok === true && r.details.proposedDate === '2026-10-03' && !(key in r.details && Object.hasOwn(r.details, key)), `A10 a "${key}" key in the body neither leaks nor changes the details`);
  }

  ok(chooseTrialSlot({ proposedDate: '2026-10-03', altSlots: ['2026-10-10'] }, '2026-10-10').date === '2026-10-10', 'A11 an offered alternative is chosen');
  ok(chooseTrialSlot({ proposedDate: '2026-10-03', altSlots: ['2026-10-10'] }, undefined).date === '2026-10-03' && chooseTrialSlot({ proposedDate: '2026-10-03' }, '').date === '2026-10-03' && chooseTrialSlot({ proposedDate: '2026-10-03' }, null).date === '2026-10-03', 'A11b no choice means the proposed day');
  const unknown = chooseTrialSlot({ proposedDate: '2026-10-03', altSlots: ['2026-10-10'] }, '2026-10-04');
  neg(unknown.ok === false && unknown.error === 'TRIAL_SLOT_INVALID' && JSON.stringify(unknown.offered) === JSON.stringify(['2026-10-03', '2026-10-10']), 'A12 a day the club never offered is refused and the offered days are listed (P4A-D12)');
  for (const v of [{}, [], 0, true, 42, ['2026-10-03'], { toString: () => '2026-10-03' }]) {
    neg(chooseTrialSlot({ proposedDate: '2026-10-03' }, v).error === 'TRIAL_SLOT_INVALID', `A12b a ${JSON.stringify(v)} slot is refused, not coerced`);
  }
  neg(chooseTrialSlot({ proposedDate: 'garbage' }, 'garbage').date === null && chooseTrialSlot({ proposedDate: 'garbage' }, undefined).date === null, 'A13 a legacy request whose stored day is garbage yields no date — never the garbage, never an invented day');
  neg(chooseTrialSlot(null, undefined).date === null && chooseTrialSlot('x', undefined).date === null, 'A13b no details at all is an undated acceptance');
  neg(chooseTrialSlot({ proposedDate: null }, '2026-10-03').error === 'TRIAL_SLOT_INVALID', 'A13c a slot cannot be chosen when nothing was offered');

  // date boundaries — UTC calendar days only; there is no time-of-day and no timezone in this model, so DST cannot move a deadline
  ok(trialReportDueAt('2026-12-31', 0) === Date.UTC(2027, 0, 7), 'A14 a year-boundary trial day derives a deadline in the next year');
  ok(trialReportDueAt('2026-02-28', 0) === Date.UTC(2026, 2, 7) && trialReportDueAt('2028-02-29', 0) === Date.UTC(2028, 2, 7), 'A14b end-of-month and leap-day trial days derive correctly');
  ok(trialReportDueAt('2026-03-29', 0) - Date.UTC(2026, 2, 29) === 7 * DAY && trialReportDueAt('2026-10-25', 0) - Date.UTC(2026, 9, 25) === 7 * DAY, 'A14c the window is exactly 7 × 24 h across the European DST switches — UTC days, no local-time drift');
  ok(parseTrialDate('2026-12-31').t === Date.UTC(2026, 11, 31) && parseTrialDate('2027-01-01').t === parseTrialDate('2026-12-31').t + DAY, 'A14d consecutive days across the year boundary are one day apart');
}

// ============================================================ D10 — pure taxonomy
section('C0 — the guardian decision is a request outcome in the notification taxonomy');
{
  ok(TYPE_CATEGORY.guardian_decision === 'messages' && categoryOf('guardian_decision') === 'messages', 'C0a guardian_decision → messages ("Messages and requests")');
  ok(CATEGORIES.messages.default === true && CATEGORIES.messages.mandatory === false, 'C0b that category is on by default for every existing, new and migrated person, and may be muted like every other request outcome');
  ok(TYPE_CATEGORY.accepted === 'messages' && TYPE_CATEGORY.declined === 'messages', 'C0c the club-side outcome rows live in the same category — one taxonomy, no parallel system');
  neg(TYPE_CATEGORY.update === 'discovery_nudges' && CATEGORIES.discovery_nudges.default === false, 'C0d `update` still means a discovery nudge (off by default) — the type was wrong for the child, the category was not changed to fit it');
  // P4A's point stands: a milestone must not make its own traffic unmutable to get
  // attention. The set has grown by exactly one since, and deliberately: P5.6C's
  // `compliance` carries regulatory review, consent and verification, where muting
  // would mute an obligation rather than a preference. Pinned as a set so the next
  // milestone that wants to add a third has to come and change this line.
  neg(Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].mandatory).sort().join() === 'compliance,security_account', 'C0e the mandatory categories are still exactly two — security_account and P5.6C\'s compliance; no milestone has quietly added a third');
}

// =================================================================== HTTP
section('HTTP — booting a real server');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot() {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function restart() {
  server.kill('SIGKILL');
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; } }
  server = await boot();
}
let server = await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let data = null; let text = null;
  const raw = await r.text();
  try { data = JSON.parse(raw); } catch { text = raw; }
  return { status: r.status, body: data, text, headers: r.headers };
}
const login = async (orgId, scoutName, role) => (await j('POST', '/auth/org/login', { orgId, scoutName, role })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const guardianLogin = async (guardianId) => (await j('POST', '/auth/guardian/login', { guardianId })).body;
const REPORT = { acceleration: 7, sprintSpeedKmh: 31.2, distanceKm: 8.4, passCompletionPct: 82, duelSuccessPct: 55, coachRating: 7 };
const orgTrials = async (token) => (await j('GET', '/org/trials', undefined, token)).body;
const trialOf = async (token, playerId) => (await orgTrials(token)).filter((t) => t.playerId === playerId).slice(-1)[0] ?? null;
const pendingFor = (inbox, type = 'trial') => (inbox ?? []).find((r) => r.type === type && r.status === 'pending');
const notifs = async (path, token) => (await j('GET', path, undefined, token)).body ?? [];
const findMetric = (obj, id) => {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.hasOwn(obj, id) && obj[id] && typeof obj[id] === 'object') return obj[id];
  for (const v of Object.values(obj)) { const f = findMetric(v, id); if (f) return f; }
  return null;
};

let maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
let harbour = await login('org-harbour', 'Dan Okoro', 'Head of Recruitment');
let kola = await playerLogin('pl-adeyemi');
let elias = await playerLogin('pl-svensson');
let mateus = await playerLogin('pl-carvalho');
let guni = await playerLogin('pl-guni');
let tomasz = await playerLogin('pl-tomasz');
let amara = await guardianLogin('gd-amara');
let marek = await guardianLogin('gd-marek');
ok(!!maria.token && !!harbour.token && !!kola.token && !!elias.token && !!mateus.token && !!guni.token && !!tomasz.token && !!amara.token && !!marek.token, 'every identity the suite needs logged in');

// ============================================================ B — D1 over HTTP
section('B — D1: a malformed trial date never reaches the store');
const B = {};
{
  const before = (await j('GET', '/player/inbox', undefined, kola.token)).body.length;
  const malformedHttp = ['not-a-date', '2026-13-99', '2026-02-31', {}, [], 0, ' 2026-10-03', '2026-10-03T10:00', '1999-12-31', '2101-01-01', true, 'NaN'];
  for (const m of malformedHttp) {
    const r = await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', proposedDate: m }, maria.token);
    neg(expect(r, 400, 'TRIAL_DATE_INVALID') && r.body.field === 'proposedDate' && r.body.expected === TRIAL_DATE_SYNTAX, `B1 proposedDate ${JSON.stringify(m)} → 400 TRIAL_DATE_INVALID (field named, syntax stated)`);
  }
  const rNull = await j('POST', '/org/players/pl-adeyemi/request', JSON.stringify({ type: 'trial', message: 'Trial?', proposedDate: null }), maria.token);
  ok(rNull.status === 201, 'B1b a null proposed date is an undated invitation (date to be confirmed), accepted');
  const rNaNRaw = await j('POST', '/org/players/pl-adeyemi/request', '{"type":"trial","message":"Trial?","proposedDate":NaN}', maria.token);
  neg(rNaNRaw.status === 400, 'B1c a body that is not JSON at all (bare NaN) is refused by the JSON parser, not stored');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', altSlots: 'x' }, maria.token), 400, 'TRIAL_SLOTS_INVALID'), 'B2 altSlots must be a list');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', altSlots: [FUTURE, FUTURE2, FUTURE3] }, maria.token), 400, 'TRIAL_SLOTS_INVALID'), 'B2b three slots refused, not silently cut to two');
  const badSlot = await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', altSlots: ['2026-02-30'] }, maria.token);
  neg(expect(badSlot, 400, 'TRIAL_DATE_INVALID') && badSlot.body.field === 'altSlots', 'B2c a bad alternative slot is refused as a date, naming altSlots');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', proposedDate: FUTURE, altSlots: [FUTURE] }, maria.token), 400, 'TRIAL_SLOTS_INVALID'), 'B2d a slot equal to the proposed day is refused');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', venue: 'x'.repeat(5000) }, maria.token), 400, 'TRIAL_VENUE_INVALID'), 'B3 a 5000-character venue is refused (it used to be stored whole)');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', venue: 'Gate B\r\nEND:VEVENT' }, maria.token), 400, 'TRIAL_VENUE_INVALID'), 'B3b a venue carrying a calendar line break is refused');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', venue: { $gt: '' } }, maria.token), 400, 'TRIAL_VENUE_INVALID'), 'B3c an object venue is refused');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', notes: 'x'.repeat(501) }, maria.token), 400, 'TRIAL_NOTES_INVALID'), 'B3d 501-character notes are refused');
  neg(expect(await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial?', notes: ['a'] }, maria.token), 400, 'TRIAL_NOTES_INVALID'), 'B3e list notes are refused');
  const after = (await j('GET', '/player/inbox', undefined, kola.token)).body.length;
  neg(after === before + 1, 'B4 of all the requests above only the undated one reached the Inbox — nothing malformed was persisted');
  // the undated one: decline it so it does not confuse the rest of the group
  const undated = pendingFor((await j('GET', '/player/inbox', undefined, kola.token)).body);
  ok(undated?.trialDetails?.proposedDate === null && Array.isArray(undated.trialDetails.altSlots) && undated.trialDetails.altSlots.length === 0, 'B4b the undated invitation shows a null day and no slots to the recipient');
  neg(expect(await j('POST', `/player/requests/${undated.id}/respond`, { accept: true, chosenSlot: FUTURE }, kola.token), 400, 'TRIAL_SLOT_INVALID'), 'B4c a slot cannot be chosen on an undated invitation');
  ok((await j('POST', `/player/requests/${undated.id}/respond`, { accept: false }, kola.token)).status === 200, 'B4d it is declined');

  // prototype keys in the request body
  const proto = await j('POST', '/org/players/pl-adeyemi/request', `{"type":"trial","message":"Trial with the U23s","proposedDate":"${FUTURE}","altSlots":["${FUTURE2}","${FUTURE3}"],"venue":"Eastport Dome; Gate 2, North stand","notes":"Bring boots.\\nAsk for Priya.","__proto__":{"proposedDate":"bad"},"constructor":{"prototype":{"venue":"x"}},"toString":"bad"}`, maria.token);
  ok(proto.status === 201, 'B5 a valid request carrying prototype-named keys is accepted on its real fields');
  const inbox = (await j('GET', '/player/inbox', undefined, kola.token)).body;
  const p = pendingFor(inbox);
  B.reqId = p.id;
  ok(p.trialDetails.proposedDate === FUTURE && JSON.stringify(p.trialDetails.altSlots) === JSON.stringify([FUTURE2, FUTURE3]) && p.trialDetails.venue === 'Eastport Dome; Gate 2, North stand' && p.trialDetails.notes === 'Bring boots.\nAsk for Priya.', 'B5b the recipient sees exactly the canonical details');
  neg(!JSON.stringify(p).includes('"bad"') && !Object.hasOwn(p.trialDetails, 'constructor'), 'B5c none of the prototype-named values travelled');

  // accept: unknown slot refused BEFORE the answer is recorded
  const trialsBefore = (await orgTrials(maria.token)).length;
  const wrong = await j('POST', `/player/requests/${B.reqId}/respond`, { accept: true, chosenSlot: FUTURE4 }, kola.token);
  neg(expect(wrong, 400, 'TRIAL_SLOT_INVALID') && JSON.stringify(wrong.body.offered) === JSON.stringify([FUTURE, FUTURE2, FUTURE3]), 'B6 a day the club never offered is refused and the offered days are listed (P4A-D12)');
  for (const v of [{}, [], 0, true, 'bad', '2026-02-31']) {
    neg(expect(await j('POST', `/player/requests/${B.reqId}/respond`, { accept: true, chosenSlot: v }, kola.token), 400, 'TRIAL_SLOT_INVALID'), `B6b chosenSlot ${JSON.stringify(v)} → 400 TRIAL_SLOT_INVALID`);
  }
  const still = (await j('GET', '/player/inbox', undefined, kola.token)).body.find((r) => r.id === B.reqId);
  neg(still.status === 'pending' && (await orgTrials(maria.token)).length === trialsBefore, 'B6c after every refused slot the request is still pending and no trial row exists — validation precedes persistence');
  const accepted = await j('POST', `/player/requests/${B.reqId}/respond`, { accept: true, chosenSlot: FUTURE3 }, kola.token);
  ok(accepted.status === 200, 'B7 the second alternative is accepted');
  const t = await trialOf(maria.token, 'pl-adeyemi');
  B.trialId = t.id;
  ok(t.proposedDate === FUTURE3, 'B7b the trial is dated on the chosen alternative');
  ok(t.reportDueAt === utcDay(FUTURE3) + 7 * DAY, 'B7c the report deadline is exactly the trial day + 7 days (UTC), from the one derivation');
  ok(Number.isFinite(t.acceptedAt) && t.acceptedBy === 'player' && t.guardianApproved === false, 'B7d acceptedAt is finite; the adult path stamps acceptedBy=player and guardianApproved=false (P4A-D4: one writer)');
  const reqRow = (await j('GET', '/org/requests', undefined, maria.token)).body.find((r) => r.id === B.reqId);
  ok(reqRow.respondedBy === 'player' && reqRow.respondedAt === t.acceptedAt, 'B7e the request carries respondedBy=player (P4A-D13) and the same instant as the trial — one clock');

  // calendar export
  const ics = await j('GET', `/org/trials/${B.trialId}/ics`, undefined, maria.token);
  ok(ics.status === 200 && /text\/calendar/.test(ics.headers.get('content-type') ?? '') && ics.text.includes(`DTSTART;VALUE=DATE:${FUTURE3.replace(/-/g, '')}`), 'B8 the calendar export starts on the trial day');
  ok(ics.text.includes(`report due ${dayStr(utcDay(FUTURE3) + 7 * DAY)}.`), 'B8b and states the derived deadline');
  neg(ics.text.includes('LOCATION:Eastport Dome\\; Gate 2\\, North stand') && ics.text.includes('Bring boots.\\nAsk for Priya.'), 'B8c stored text is RFC 5545-escaped: no stored value can begin a calendar line');
  neg(ics.text.split('\r\n').filter((l) => /^END:VEVENT$/.test(l)).length === 1 && ics.text.split('\r\n').filter((l) => /^BEGIN:VEVENT$/.test(l)).length === 1, 'B8d exactly one event, no injected lines');
  neg(expect(await j('GET', `/org/trials/${B.trialId}/ics`, undefined, harbour.token), 404, 'TRIAL_NOT_FOUND'), 'B8e a foreign organisation gets the same 404 as for an unknown trial');

  // postpone through the same validator, deadline re-derived
  const badMove = await j('POST', `/org/trials/${B.trialId}/postpone`, { reason: 'Waterlogged', newDate: 'next week' }, maria.token);
  neg(expect(badMove, 400, 'TRIAL_DATE_INVALID') && badMove.body.field === 'newDate', 'B9 a postponement to a non-day is refused, naming newDate');
  neg(expect(await j('POST', `/org/trials/${B.trialId}/postpone`, { reason: 'Waterlogged', newDate: '2026-02-30' }, maria.token), 400, 'TRIAL_DATE_INVALID'), 'B9b an impossible day is refused');
  neg((await trialOf(maria.token, 'pl-adeyemi')).proposedDate === FUTURE3, 'B9c the refused postponement changed nothing');
  const moved = await j('POST', `/org/trials/${B.trialId}/postpone`, { reason: 'Waterlogged pitch', newDate: FUTURE4 }, maria.token);
  ok(moved.status === 200 && moved.body.trial.proposedDate === FUTURE4, 'B10 a postponement to a real day is recorded');
  const t2 = await trialOf(maria.token, 'pl-adeyemi');
  ok(t2.reportDueAt === utcDay(FUTURE4) + 7 * DAY, 'B10b and the report deadline followed the trial day — one derivation, not a second computation');
  const tbc = await j('POST', `/org/trials/${B.trialId}/postpone`, { reason: 'Date to be confirmed' }, maria.token);
  ok(tbc.status === 200 && (await trialOf(maria.token, 'pl-adeyemi')).proposedDate === FUTURE4 && (await trialOf(maria.token, 'pl-adeyemi')).reportDueAt === t2.reportDueAt, 'B10c a postponement without a new day keeps the day and the deadline');
  const feed = await j('GET', '/org/feed', undefined, maria.token);
  const due = (feed.body ?? []).find((i) => i.type === 'report_due' && i.trialId === B.trialId);
  ok(feed.status === 200 && due && due.dueAt === t2.reportDueAt && Number.isFinite(due.ts), 'B11 the feed lists the report as due on the derived deadline');

  // minor path through the same writer
  const gReq = await j('POST', '/org/players/pl-guni/request', { type: 'trial', message: 'U15 assessment for Guni.', proposedDate: FUTURE, altSlots: [FUTURE2] }, maria.token);
  neg(expect(gReq, 409, 'REPORTS_OUTSTANDING'), 'B12 (M12 gate, unchanged) an unfiled report blocks a new trial request');
  ok((await j('POST', `/org/trials/${B.trialId}/report`, { ...REPORT, strengthNote: 'Composed under pressure.', focusNote: 'Weak-foot passing.' }, maria.token)).status === 201, 'B12b the report is filed');
  const gReq2 = await j('POST', '/org/players/pl-guni/request', { type: 'trial', message: 'U15 assessment for Guni.', proposedDate: FUTURE, altSlots: [FUTURE2] }, maria.token);
  ok(gReq2.status === 201 && gReq2.body.routedTo === 'guardian', 'B12c the minor\'s invitation is routed to the guardian');
  const gp = pendingFor((await j('GET', '/guardian/inbox', undefined, amara.token)).body);
  B.guniReq = gp.id;
  neg(expect(await j('POST', `/guardian/requests/${gp.id}/respond`, { accept: true, chosenSlot: FUTURE3 }, amara.token), 400, 'TRIAL_SLOT_INVALID'), 'B13 the guardian route refuses an un-offered slot the same way');
  neg(pendingFor((await j('GET', '/guardian/inbox', undefined, amara.token)).body)?.id === gp.id, 'B13b and the invitation is still pending');
  ok((await j('POST', `/guardian/requests/${gp.id}/respond`, { accept: true, chosenSlot: FUTURE2 }, amara.token)).status === 200, 'B13c the guardian accepts the alternative');
  const gt = await trialOf(maria.token, 'pl-guni');
  B.guniTrial = gt.id;
  ok(gt.proposedDate === FUTURE2 && gt.reportDueAt === utcDay(FUTURE2) + 7 * DAY && gt.acceptedBy === 'guardian' && gt.guardianApproved === true, 'B13d the guardian-accepted trial comes from the same writer: same fields, guardianApproved=true, same derivation');
  const gReqRow = (await j('GET', '/org/requests', undefined, maria.token)).body.find((r) => r.id === gp.id);
  ok(gReqRow.respondedBy === 'guardian' && gReqRow.respondedAt === gt.acceptedAt, 'B13e respondedBy=guardian, same clock as the trial');
}

// ============================================================ C — D10 over HTTP
section('C — D10: a minor hears their guardian\'s decision');
{
  const gn = await notifs('/player/notifications', guni.token);
  const rows = gn.filter((n) => n.type === 'guardian_decision');
  ok(rows.length === 1 && rows[0].category === 'messages' && rows[0].text === 'Your parent/guardian accepted the trial with Eastport FC.' && rows[0].refId === B.guniReq,
    'C1 with default preferences the child has exactly one guardian_decision row, in "messages", about the request');
  neg(!gn.some((n) => n.type === 'update'), 'C1b no `update`-typed row exists for the child — the old type is gone from this path');
  neg(!(await notifs('/guardian/notifications', amara.token)).some((n) => n.type === 'guardian_decision'), 'C1c the guardian does not receive a copy of their own decision');
  const mn = await notifs('/org/notifications', maria.token);
  neg(!(Array.isArray(mn) ? mn : mn.items ?? []).some((n) => n.type === 'guardian_decision'), 'C1d nor does the club — the club hears through its own accepted row');
  const kn = await notifs('/player/notifications', kola.token);
  neg(!kn.some((n) => n.type === 'guardian_decision'), 'C1e an adult who answered for themselves has no guardian_decision row');

  // preference off → not created; on → created. A contact request exercises the decline path.
  const off = await j('PUT', '/player/notification-preferences', { categories: { messages: false } }, tomasz.token);
  ok(off.status === 200, 'C2 Tomasz mutes "Messages and requests"');
  const c1 = await j('POST', '/org/players/pl-tomasz/request', { type: 'contact', message: 'Could we talk about next season?' }, maria.token);
  ok(c1.status === 201 && c1.body.routedTo === 'guardian', 'C2b a contact for Tomasz is routed to Marek');
  const tp1 = pendingFor((await j('GET', '/guardian/inbox', undefined, marek.token)).body, 'contact');
  ok((await j('POST', `/guardian/requests/${tp1.id}/respond`, { accept: false }, marek.token)).status === 200, 'C2c Marek declines');
  neg(!(await notifs('/player/notifications', tomasz.token)).some((n) => n.type === 'guardian_decision'), 'C2d with the category muted the row is NOT created (never created-and-hidden)');
  ok((await j('PUT', '/player/notification-preferences', { categories: { messages: true } }, tomasz.token)).status === 200, 'C2e Tomasz turns it back on');
  const c2 = await j('POST', '/org/players/pl-tomasz/request', { type: 'contact', message: 'One more try — a short call?' }, maria.token);
  ok(c2.status === 201, 'C2f a second contact is sent');
  const tp2 = pendingFor((await j('GET', '/guardian/inbox', undefined, marek.token)).body, 'contact');
  ok((await j('POST', `/guardian/requests/${tp2.id}/respond`, { accept: true }, marek.token)).status === 200, 'C2g Marek accepts this one');
  const tn = (await notifs('/player/notifications', tomasz.token)).filter((n) => n.type === 'guardian_decision');
  ok(tn.length === 1 && tn[0].text === 'Your parent/guardian accepted the contact with Eastport FC.' && tn[0].refId === tp2.id, 'C2h now the row lands, worded for a contact');

  // preferences: prototype keys and mandatory refusal
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
    const r = await j('PUT', '/player/notification-preferences', `{"categories":{"${key}":false}}`, guni.token);
    neg(expect(r, 400, 'PREF_CATEGORY_UNKNOWN') && r.body.category === key, `C3 a "${key}" category is refused, not stored (own keys only)`);
  }
  const view = (await j('GET', '/player/notification-preferences', undefined, guni.token)).body.preferences;
  neg(!view.categories.some((c) => ['constructor', 'toString', '__proto__'].includes(c.id)), 'C3b and the preferences view carries no prototype name');
  neg(expect(await j('PUT', '/player/notification-preferences', { categories: { security_account: false } }, guni.token), 400, 'PREF_CATEGORY_MANDATORY'), 'C3c the mandatory category still cannot be muted');
  neg(expect(await j('PUT', '/player/notification-preferences', { categories: [] }, guni.token), 400, 'PREFS_INVALID'), 'C3d a list is not a preferences object');
  neg(expect(await j('PUT', '/player/notification-preferences', { categories: { messages: 'yes' } }, guni.token), 200, null) && (await j('GET', '/player/notification-preferences', undefined, guni.token)).body.preferences.categories.find((c) => c.id === 'messages').enabled === true, 'C3e a truthy non-boolean is stored as true (documented M18.2 behaviour, unchanged)');

  // privacy sentinel: club-private text never reaches the child, the guardian, or a foreign club
  const room = await j('POST', '/org/rooms', { playerId: 'pl-guni' }, maria.token);
  ok(room.status === 201, 'C4 a Room exists for Guni');
  const RID = room.body.room.roomId;
  const cm = await j('POST', `/org/rooms/${RID}/comments`, { body: `Internal: ${SENTINEL} — do not share.` }, maria.token);
  ok(cm.status === 201, 'C4b a room comment carries the sentinel');
  const cur = (await j('GET', `/org/rooms/${RID}`, undefined, maria.token)).body.room;
  const dec = await j('POST', `/org/rooms/${RID}/decisions`, { recommendation: 'continue_watching', reasonCodes: ['continue_monitoring'], note: `Decision note ${SENTINEL}`, expectedRev: cur.rev }, maria.token);
  ok(dec.status === 201, 'C4c a decision note carries the sentinel');
  const surfaces = [
    ['child inbox', j('GET', '/player/inbox', undefined, guni.token)],
    ['child notifications', j('GET', '/player/notifications', undefined, guni.token)],
    ['child export', j('GET', '/player/export', undefined, guni.token)],
    ['child passport', j('GET', '/player/football-passport', undefined, guni.token)],
    ['child safety pack list', j('GET', '/player/trials', undefined, guni.token)],
    ['guardian inbox', j('GET', '/guardian/inbox', undefined, amara.token)],
    ['guardian notifications', j('GET', '/guardian/notifications', undefined, amara.token)],
    ['guardian export', j('GET', '/guardian/export', undefined, amara.token)],
    ['foreign org trials', j('GET', '/org/trials', undefined, harbour.token)],
    ['foreign org journey', j('GET', `/org/rooms/${RID}/journey`, undefined, harbour.token)],
    ['foreign org notifications', j('GET', '/org/notifications', undefined, harbour.token)],
    ['club directory (public)', j('GET', '/orgs/directory', undefined, null)],
    ['email outbox (T&S)', j('GET', '/admin/outbox', undefined, null, ADMIN)],
    ['push log (T&S)', j('GET', '/admin/push-log', undefined, null, ADMIN)],
  ];
  for (const [name, p] of surfaces) {
    const r = await p;
    neg(!JSON.stringify(r.body ?? r.text ?? '').includes(SENTINEL), `C5 sentinel absent from ${name} (${r.status})`);
  }
  neg(expect(await j('GET', `/org/rooms/${RID}/journey`, undefined, harbour.token), 404, null), 'C5b the foreign org\'s journey read is a 404, not an empty page');
  ok(JSON.stringify((await j('GET', `/org/rooms/${RID}`, undefined, maria.token)).body).includes(SENTINEL), 'C5c (control) the club\'s own Room does carry the sentinel — the sweep is real');
}

// ============================================================ D — D14 over HTTP
section('D — D14: an account removal leaves an honest tombstone and moves no case');
const D = {};
{
  // Kola: room + reported trial (from group B). Elias: room + trial awaiting report, with the whole trial day filled in.
  const kRoom = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi' }, maria.token);
  ok(kRoom.status === 201, 'D0 a Room exists for Kola');
  D.kRoom = kRoom.body.room.roomId;
  ok((await j('POST', `/org/trials/${B.guniTrial}/report`, { ...REPORT }, maria.token)).status === 201, 'D0a Guni\'s report is filed so the mandatory-report gate is clear');
  const eReq = await j('POST', '/org/players/pl-svensson/request', { type: 'trial', message: 'Trial with the U23s?', proposedDate: PAST, venue: 'Eastport Training Ground', notes: 'Ask for Priya.' }, maria.token);
  ok(eReq.status === 201, 'D0b Elias is invited (a past day, so the report is already overdue)');
  const ep = pendingFor((await j('GET', '/player/inbox', undefined, elias.token)).body);
  ok((await j('POST', `/player/requests/${ep.id}/respond`, { accept: true }, elias.token)).status === 200, 'D0c Elias accepts');
  const et = await trialOf(maria.token, 'pl-svensson');
  D.eTrial = et.id; D.eReq = ep.id;
  ok((await j('POST', `/org/trials/${et.id}/staff`, { name: 'Priya Shah', role: 'Safeguarding Lead', check: { kind: 'DBS (England & Wales)', ref: 'DBS-4471', expiresAt: new Date(Date.now() + 300 * DAY).toISOString() } }, maria.token)).status === 201, 'D0d staff named');
  ok((await j('POST', `/player/trials/${et.id}/consent`, {}, elias.token)).status === 201, 'D0e consent given');
  ok((await j('POST', `/player/trials/${et.id}/emergency-contact`, { name: 'Lena Svensson', phone: '+46 70 000 11 22' }, elias.token)).status === 200, 'D0f emergency contact filed');
  ok((await j('POST', `/org/trials/${et.id}/arrival`, { time: '09:30', address: 'Gate B', notes: 'Ask for Priya at reception.' }, maria.token)).status === 200, 'D0g arrival published');
  const eRoom = await j('POST', '/org/rooms', { playerId: 'pl-svensson' }, maria.token);
  ok(eRoom.status === 201, 'D0h a Room exists for Elias');
  D.eRoom = eRoom.body.room.roomId;
  const eRoomBefore = (await j('GET', `/org/rooms/${D.eRoom}`, undefined, maria.token)).body.room;
  const kRoomBefore = (await j('GET', `/org/rooms/${D.kRoom}`, undefined, maria.token)).body.room;
  const jBefore = (await j('GET', `/org/rooms/${D.eRoom}/journey`, undefined, maria.token)).body;
  const overdueBefore = findMetric((await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body, 'overdue_trial_reports');
  ok(overdueBefore && overdueBefore.value >= 1 && overdueBefore.rows.some((r) => r.trialId === et.id), 'D0i the Director Dashboard counts Elias\'s report as overdue before the deletion');
  neg(expect(await j('POST', '/org/players/pl-carvalho/request', { type: 'trial', message: 'Trial?', proposedDate: FUTURE }, maria.token), 409, 'REPORTS_OUTSTANDING'), 'D0j (control) the outstanding report blocks new trial requests');

  // the deletions
  neg(expect(await j('DELETE', '/player/account', undefined, guni.token), 403, 'GUARDIAN_MANAGED'), 'D1 a minor cannot delete their own account');
  ok((await j('DELETE', '/player/account', undefined, kola.token)).status === 200, 'D1b Kola (reported trial) deletes their account');
  ok((await j('DELETE', '/player/account', undefined, elias.token)).status === 200, 'D1c Elias (trial awaiting report) deletes theirs');
  neg(expect(await j('DELETE', '/player/account', undefined, kola.token), 401, 'PLAYER_AUTH_REQUIRED'), 'D1d a duplicate delete on the dead session is refused (idempotent: nothing to delete twice)');
  neg(expect(await j('GET', '/player/me', undefined, elias.token), 401, 'PLAYER_AUTH_REQUIRED'), 'D1e the deleted player\'s session is gone');

  // tombstones
  const trials = await orgTrials(maria.token);
  const kt = trials.find((t) => t.id === B.trialId);
  const et2 = trials.find((t) => t.id === et.id);
  ok(!!kt && !!et2, 'D2 both trial rows still exist for the club — history is preserved');
  ok(kt.status === 'reported' && Number.isFinite(kt.subjectRemovedAt) && kt.playerId === 'pl-adeyemi' && kt.requestId === B.reqId, 'D2b the reported trial keeps its id, status, player id, request id and is marked subjectRemovedAt');
  ok(kt.report && TRIAL_REPORT_FIELDS.every((f) => kt.report[f] === REPORT[f]) && Number.isFinite(kt.report.filedAt), 'D2c the club\'s own filed numbers and filing time survive');
  neg(kt.playerName === null && kt.notes === '' && kt.report.strengthNote === null && kt.report.focusNote === null && kt.report.notes === null, 'D2d name, logistics notes and the feedback written to the person are gone');
  neg(et2.status === 'awaiting_report' && et2.playerName === null && et2.day && et2.day.emergency === null && et2.day.arrival === null && et2.day.collection === null, 'D2e the awaiting trial\'s day keeps no emergency contact, arrival or collection details');
  ok(et2.day.staff.length === 1 && et2.day.consents.length === 1 && et2.day.consents[0].by.kind === 'player' && !('id' in et2.day.consents[0].by) && !('name' in et2.day.consents[0].by), 'D2f the club\'s staff record and the fact of consent (kind only) remain');
  neg(!JSON.stringify(trials).includes('70 000 11 22') && !JSON.stringify(trials).includes('Lena') && !JSON.stringify(trials).includes('Kola Adeyemi') && !JSON.stringify(trials).includes('Elias Svensson'), 'D2g the phone number and the names appear nowhere in the club\'s trial list');
  const reqs = (await j('GET', '/org/requests', undefined, maria.token)).body;
  const kr = reqs.find((r) => r.id === B.reqId); const er = reqs.find((r) => r.id === D.eReq);
  ok(kr && er && kr.status === 'accepted' && er.status === 'accepted' && Number.isFinite(kr.subjectRemovedAt), 'D3 the request rows survive with their ids and outcomes');
  neg(kr.message === null && kr.playerName === null && er.trialDetails.notes === '' && er.trialDetails.venue === 'Eastport Training Ground' && er.trialDetails.proposedDate === PAST, 'D3b the message and name are gone; the club\'s venue and the offered days stay');
  neg(!JSON.stringify(reqs).includes('Kola Adeyemi') && !JSON.stringify(reqs).includes('Elias Svensson'), 'D3c no name in the request list');

  // cases untouched
  const kRoomAfter = (await j('GET', `/org/rooms/${D.kRoom}`, undefined, maria.token)).body.room;
  const eRoomAfter = (await j('GET', `/org/rooms/${D.eRoom}`, undefined, maria.token)).body.room;
  neg(kRoomAfter.status === kRoomBefore.status && kRoomAfter.rev === kRoomBefore.rev && eRoomAfter.status === eRoomBefore.status && eRoomAfter.rev === eRoomBefore.rev, 'D4 neither case moved and neither revision advanced — deletion is not a lifecycle event and writes no status');
  neg(kRoomAfter.playerName === null && eRoomAfter.playerName === null && !JSON.stringify(kRoomAfter).includes('Kola Adeyemi'), 'D4b the Room no longer shows the person');
  const jAfter = (await j('GET', `/org/rooms/${D.eRoom}/journey`, undefined, maria.token)).body;
  ok(jAfter.lifecycle.currentStage === jBefore.lifecycle.currentStage, 'D4c the journey\'s current stage is unchanged');
  ok(jAfter.trials.some((t) => t.id === et.id && t.status === 'awaiting_report'), 'D4d the journey still lists the trial — the evidence that it happened stays on the case');
  neg(!JSON.stringify(jAfter).includes('Elias Svensson'), 'D4e and carries no name');
  const list = await j('GET', '/org/rooms?q=kola', undefined, maria.token);
  ok(list.status === 200, 'D4f searching Rooms by name after a deletion does not crash');
  const list2 = await j('GET', '/org/rooms', undefined, maria.token);
  ok(list2.status === 200 && JSON.stringify(list2.body).includes(D.eRoom), 'D4g the case is still listed for the club');

  // readers and gates
  const feed = await j('GET', '/org/feed', undefined, maria.token);
  ok(feed.status === 200 && !(feed.body ?? []).some((i) => i.type === 'report_due' && i.trialId === et.id), 'D5 the feed answers and no longer lists a report due for a person who left');
  const overdueAfter = findMetric((await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body, 'overdue_trial_reports');
  neg(overdueAfter && !overdueAfter.rows.some((r) => r.trialId === et.id) && overdueAfter.value === overdueBefore.value - 1, 'D5b the Director Dashboard no longer counts it as overdue');
  const newReq = await j('POST', '/org/players/pl-carvalho/request', { type: 'trial', message: 'Trial?', proposedDate: FUTURE }, maria.token);
  ok(newReq.status === 201, 'D5c the mandatory-report gate skips the tombstone — the club is not blocked forever by a report nobody can file');
  D.mateusReq = newReq.body.requestId;
  neg(expect(await j('POST', `/org/trials/${et.id}/report`, { ...REPORT }, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'D6 filing a report for a removed subject is refused by name (it used to 500 on a missing profile)');
  neg(expect(await j('POST', `/org/trials/${et.id}/arrival`, { time: '10:00' }, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'D6b arrival details cannot be written for them');
  neg(expect(await j('POST', `/org/trials/${et.id}/postpone`, { reason: 'x', newDate: FUTURE }, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'D6c nor a postponement');
  neg(expect(await j('POST', `/org/trials/${et.id}/cancel`, { reason: 'x' }, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'D6d nor a cancellation');
  neg(expect(await j('POST', `/org/trials/${et.id}/staff`, { name: 'X', role: 'Y' }, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'D6e nor staff');
  neg(expect(await j('POST', `/org/trials/${et.id}/checkin`, {}, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'D6f nor a check-in');
  const day = await j('GET', `/org/trials/${et.id}/day`, undefined, maria.token);
  ok(day.status === 200 && day.body.trial.emergency === null && day.body.trial.playerName === null && !JSON.stringify(day.body).includes('70 000 11 22'), 'D6g the club can still READ the day (its own staff and history) with nothing person-shaped in it');
  const ics = await j('GET', `/org/trials/${et.id}/ics`, undefined, maria.token);
  ok(ics.status === 200 && ics.text.includes('removed player') && !ics.text.includes('Svensson'), 'D6h the calendar export still works and names nobody');
  const dir = (await j('GET', '/orgs/directory', undefined, null)).body.find((o) => o.id === 'org-eastport');
  ok(dir.trialsRun >= 2 && dir.reportsFiled >= 1, 'D6i the public club directory still counts the trials that were run and the reports filed (aggregates only)');

  // foreign org sees nothing
  neg(!(await orgTrials(harbour.token)).some((t) => [B.trialId, et.id].includes(t.id)), 'D7 the foreign org\'s trial list has neither tombstone');
  neg(expect(await j('GET', `/org/trials/${et.id}/day`, undefined, harbour.token), 404, 'TRIAL_NOT_FOUND'), 'D7b and reading the day is the same 404 as for an unknown trial');
  neg(expect(await j('GET', `/org/rooms/${D.eRoom}`, undefined, harbour.token), 404, null), 'D7c the case is invisible to it too');

  // guardian path: Marek removes Tomasz after an accepted trial
  const tReq = await j('POST', '/org/players/pl-tomasz/request', { type: 'trial', message: 'U16 trial for Tomasz.', proposedDate: FUTURE }, maria.token);
  ok(tReq.status === 201, 'D8 Tomasz is invited to a trial');
  const tp = pendingFor((await j('GET', '/guardian/inbox', undefined, marek.token)).body);
  ok((await j('POST', `/guardian/requests/${tp.id}/respond`, { accept: true }, marek.token)).status === 200, 'D8b Marek accepts');
  const tt = await trialOf(maria.token, 'pl-tomasz');
  neg(expect(await j('DELETE', '/guardian/children/pl-guni', undefined, marek.token), 404, 'CHILD_NOT_FOUND'), 'D8c a guardian cannot delete someone else\'s child');
  ok((await j('DELETE', '/guardian/children/pl-tomasz', undefined, marek.token)).status === 200, 'D8d Marek deletes Tomasz\'s profile');
  neg(expect(await j('DELETE', '/guardian/children/pl-tomasz', undefined, marek.token), 404, 'CHILD_NOT_FOUND'), 'D8e a second delete finds no child — idempotent by refusal, not by a second cascade');
  const ttAfter = (await orgTrials(maria.token)).find((t) => t.id === tt.id);
  ok(ttAfter && ttAfter.playerName === null && ttAfter.guardianApproved === true && ttAfter.acceptedBy === 'guardian' && Number.isFinite(ttAfter.subjectRemovedAt), 'D8f the minor\'s trial is tombstoned the same way, keeping who accepted');
  neg(!(await j('GET', '/guardian/inbox', undefined, marek.token)).body.some((r) => r.playerId === 'pl-tomasz'), 'D8g the guardian\'s Inbox no longer lists the removed child\'s requests');
  neg(expect(await j('GET', '/player/me', undefined, tomasz.token), 401, 'PLAYER_AUTH_REQUIRED'), 'D8h the child\'s session is gone');
  neg(!JSON.stringify((await j('GET', '/guardian/export', undefined, marek.token)).body).includes('Tomasz Kowalski'), 'D8i the guardian export no longer carries the child');
}

// ============================================================ F — calendar fuzz + deletion races
section('F — calendar export fuzz and deletion races');
{
  const theo = await playerLogin('pl-martin');
  const longNotes = 'Épreuve d’évaluation — apportez vos crampons. '.repeat(11).slice(0, TRIAL_DETAIL_LIMITS.notes);
  const rq = await j('POST', '/org/players/pl-martin/request', { type: 'trial', message: 'Trial for Théo', proposedDate: FUTURE, venue: 'Stade Émile-Zola, porte Ç; tribune Nord', notes: longNotes }, maria.token);
  ok(rq.status === 201, 'F0 a trial with non-ASCII venue, punctuation and notes at the length limit is accepted');
  const tp = pendingFor((await j('GET', '/player/inbox', undefined, theo.token)).body);
  ok((await j('POST', `/player/requests/${tp.id}/respond`, { accept: true }, theo.token)).status === 200, 'F0b Théo accepts');
  const tt = await trialOf(maria.token, 'pl-martin');
  const ics1 = await j('GET', `/org/trials/${tt.id}/ics`, undefined, maria.token);
  if (!(ics1.status === 200 && ics1.text.includes('Théo Martin') && ics1.text.includes('Stade Émile-Zola\\, porte Ç\\; tribune Nord'))) console.error('   F1 ics:', ics1.status, JSON.stringify(ics1.text ?? ics1.body).slice(0, 600));
  ok(ics1.status === 200 && ics1.text.includes('Théo Martin') && ics1.text.includes('Stade Émile-Zola\\, porte Ç\\; tribune Nord') && ics1.text.includes('Épreuve'), 'F1 non-ASCII names and venues export intact, with the RFC 5545 escapes');
  neg(ics1.text.split('\r\n').every((l) => l.length < 2000) && !/\n(?!\r?$)/.test(ics1.text.replace(/\r\n/g, '')), 'F1b long notes stay on one escaped DESCRIPTION line');
  ok((await j('POST', `/org/trials/${tt.id}/cancel`, { reason: 'Pitch closed' }, maria.token)).status === 200, 'F2 the trial is cancelled');
  const ics2 = await j('GET', `/org/trials/${tt.id}/ics`, undefined, maria.token);
  ok(ics2.status === 200 && ics2.text.includes(`UID:${tt.id}@scoutbox`), 'F2b a cancelled trial still exports (the calendar entry is the club\'s to remove) — no 500');
  neg(expect(await j('GET', '/org/trials/trial-does-not-exist/ics', undefined, maria.token), 404, 'TRIAL_NOT_FOUND'), 'F3 an unknown trial id is 404');
  neg(expect(await j('GET', '/org/trials/__proto__/ics', undefined, maria.token), 404, 'TRIAL_NOT_FOUND'), 'F3b a prototype-named id is 404, not a crash');
  neg(expect(await j('GET', `/org/trials/${encodeURIComponent(tt.id + '\n')}/ics`, undefined, maria.token), 404, 'TRIAL_NOT_FOUND'), 'F3c an id with a trailing newline is 404');
  ok((await j('POST', `/org/trials/${tt.id}/report`, { ...REPORT }, maria.token)).status === 201, 'F4 Théo\'s report is filed (the mandatory report outlives a cancellation — M12 rule, unchanged)');

  // races: delete vs report vs lifecycle advance vs a second delete, all in flight at once
  const okafor = await playerLogin('pl-okafor');
  const oRoom = await j('POST', '/org/rooms', { playerId: 'pl-okafor' }, maria.token);
  ok(oRoom.status === 201, 'F5 a Room exists for Chinedu');
  const ORID = oRoom.body.room.roomId;
  ok((await j('POST', '/org/players/pl-okafor/request', { type: 'trial', message: 'Trial?', proposedDate: FUTURE2 }, maria.token)).status === 201, 'F5b Chinedu is invited');
  const op = pendingFor((await j('GET', '/player/inbox', undefined, okafor.token)).body);
  ok((await j('POST', `/player/requests/${op.id}/respond`, { accept: true }, okafor.token)).status === 200, 'F5c and accepts');
  const ot = await trialOf(maria.token, 'pl-okafor');
  const oBefore = (await j('GET', `/org/rooms/${ORID}`, undefined, maria.token)).body.room;
  const [d1, rep, adv, d2] = await Promise.all([
    j('DELETE', '/player/account', undefined, okafor.token),
    j('POST', `/org/trials/${ot.id}/report`, { ...REPORT, strengthNote: 'Quick feet.' }, maria.token),
    j('POST', `/org/rooms/${ORID}/lifecycle`, { action: 'startReview', expectedRev: oBefore.rev }, maria.token),
    j('DELETE', '/player/account', undefined, okafor.token),
  ]);
  neg([d1.status, d2.status].sort().join() === '200,401', 'F6 two concurrent deletes: exactly one deletes, the other finds no session (no double cascade)');
  const otAfter = (await orgTrials(maria.token)).find((t) => t.id === ot.id);
  neg((rep.status === 201 && otAfter.status === 'reported' && TRIAL_REPORT_FIELDS.every((f) => otAfter.report[f] === REPORT[f]) && otAfter.report.strengthNote === null)
    || (rep.status === 409 && rep.body.error === 'TRIAL_SUBJECT_REMOVED' && otAfter.status === 'awaiting_report' && !otAfter.report),
    `F7 delete vs report (report answered ${rep.status}): either the whole report landed first and was then tombstoned, or it was refused by name — never a half-written report`);
  ok(Number.isFinite(otAfter.subjectRemovedAt) && otAfter.playerName === null, 'F7b the trial is tombstoned either way');
  const oAfter = (await j('GET', `/org/rooms/${ORID}`, undefined, maria.token)).body.room;
  neg((adv.status === 200 && oAfter.status === 'under_review' && oAfter.rev === oBefore.rev + 1) || (adv.status !== 200 && oAfter.status === oBefore.status && oAfter.rev === oBefore.rev),
    `F8 delete vs lifecycle advance (advance answered ${adv.status}): the lifecycle write applied exactly once or not at all — the deletion itself never moved the case`);
  neg(!JSON.stringify(oAfter).includes('Chinedu'), 'F8b and the Room names nobody');
}

// ============================================================ L — legacy rows
section('L — legacy rows in the store: read-side defence, signed invariant, restart consistency');
{
  // Mateus: a Room now; the snapshot will make the case `signed` with a signing (legacy state no route can produce today).
  const mRoom = await j('POST', '/org/rooms', { playerId: 'pl-carvalho' }, maria.token);
  ok(mRoom.status === 201, 'L0 a Room exists for Mateus');
  const MID = mRoom.body.room.roomId;
  const mp = pendingFor((await j('GET', '/player/inbox', undefined, mateus.token)).body);
  ok((await j('POST', `/player/requests/${mp.id}/respond`, { accept: true }, mateus.token)).status === 200, 'L0b Mateus accepts his (valid) trial');
  const mt = await trialOf(maria.token, 'pl-carvalho');

  server.kill('SIGKILL');
  for (let i = 0; i < 60; i += 1) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch { break; } }
  const store = openStore(DATA_DIR);
  const snap = store.load();
  ok(snap && Array.isArray(snap.db.trials) && Array.isArray(snap.db.recruitmentCases), 'L1 the snapshot loads for the fixture edit');
  const kase = snap.db.recruitmentCases.find((c) => c.id === MID);
  kase.room.status = 'signed'; // TEST FIXTURE ONLY: a legacy `signed` case with its signing record
  // the D14 matrix: one legacy case per lifecycle position, all for the same player (fixture rows; no route can reach these today)
  const MATRIX = ['trial_requested', 'trial_scheduled', 'trial_completed', 'offer_consideration', 'offer_made', 'offer_accepted', 'archived', 'withdrawn', 'closed'];
  for (const st of MATRIX) {
    const clone = JSON.parse(JSON.stringify(kase));
    clone.id = `case-matrix-${st}`; clone.room.status = st; clone.room.rev = 3;
    clone.history = [{ action: 'room_created', at: Date.now() - 20 * DAY, detail: { status: 'watching' } }, { action: 'room_status_changed', at: Date.now() - 10 * DAY, detail: { from: 'watching', to: st } }];
    snap.db.recruitmentCases.push(clone);
  }
  snap.db.signings.push({ id: 'sign-legacy-1', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', orgId: 'org-eastport', orgName: 'Eastport FC', userId: 'u-maria', scoutName: 'Maria Keane', ts: Date.now() - 5 * DAY });
  // legacy trial rows written before the validator existed
  snap.db.trials.push(
    { id: 'trial-legacy-garbage', requestId: 'req-legacy-1', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', orgId: 'org-eastport', orgName: 'Eastport FC', scoutName: 'Maria Keane', acceptedAt: Date.now() - 40 * DAY, proposedDate: 'next tuesday-ish', venue: 'x', notes: '', reportDueAt: null, status: 'awaiting_report' },
    { id: 'trial-legacy-nan', requestId: 'req-legacy-2', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', orgId: 'org-eastport', orgName: 'Eastport FC', scoutName: 'Maria Keane', acceptedAt: Date.now() - 40 * DAY, proposedDate: '2026-02-31', venue: null, notes: '', reportDueAt: NaN, status: 'awaiting_report' },
    { id: 'trial-legacy-null', requestId: 'req-legacy-3', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', orgId: 'org-eastport', orgName: 'Eastport FC', scoutName: 'Maria Keane', acceptedAt: Date.now() - 40 * DAY, proposedDate: null, venue: null, notes: '', reportDueAt: null, status: 'awaiting_report' },
    { id: 'trial-legacy-old', requestId: 'req-legacy-4', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', orgId: 'org-eastport', orgName: 'Eastport FC', scoutName: 'Maria Keane', acceptedAt: undefined, proposedDate: '1999-01-01', venue: null, notes: '', status: 'awaiting_report' },
  );
  snap.db.requests.push({ id: 'req-legacy-5', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', orgId: 'org-eastport', orgName: 'Eastport FC', orgType: 'club', orgVerified: true, userId: 'u-maria', scoutName: 'Maria Keane', scoutRole: 'Head of Recruitment', type: 'trial', message: 'legacy pending invitation', trialDetails: { proposedDate: 'garbage-day', altSlots: ['also-garbage'], venue: null, notes: '' }, status: 'pending', createdAt: Date.now() - 3 * DAY, routedTo: 'player', guardianId: null, contactChannel: null });
  store.save(snap);
  server = await boot();
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  mateus = await playerLogin('pl-carvalho');
  harbour = await login('org-harbour', 'Dan Okoro', 'Head of Recruitment');
  ok(!!maria.token && !!mateus.token, 'L2 the server boots on the edited snapshot');
  ok((await j('GET', '/healthz')).body.schemaVersion === SCHEMA_VERSION, `L2b schema ${SCHEMA_VERSION} — no migration was needed or added for the closure`);
  const survived = (await orgTrials(maria.token)).find((t) => t.id === mt.id);
  const survivedReq = (await j('GET', '/org/requests', undefined, maria.token)).body.find((r) => r.id === D.mateusReq);
  neg(!!survived && survivedReq?.status === 'accepted' && !!survivedReq.contactChannel,
    'L2c the trial accepted a moment before the SIGKILL survived with its request and channel — the acceptance is ONE save (P4A-D15: it used to be saved before the trial row existed)');

  // read-side defence
  neg(expect(await j('GET', '/org/trials/trial-legacy-garbage/ics', undefined, maria.token), 422, 'TRIAL_DATE_INVALID'), 'L3 the calendar export of a garbage-dated legacy trial is 422 TRIAL_DATE_INVALID, not 500');
  neg(expect(await j('GET', '/org/trials/trial-legacy-nan/ics', undefined, maria.token), 422, 'TRIAL_DATE_INVALID'), 'L3b an impossible legacy day too');
  neg(expect(await j('GET', '/org/trials/trial-legacy-old/ics', undefined, maria.token), 422, 'TRIAL_DATE_INVALID'), 'L3c a day outside the accepted range too');
  const icsNull = await j('GET', '/org/trials/trial-legacy-null/ics', undefined, maria.token);
  ok(icsNull.status === 200 && icsNull.text.includes(`DTSTART;VALUE=DATE:${dayStr(Date.now() - 40 * DAY).replace(/-/g, '')}`) && !icsNull.text.includes('report due'), 'L3d an undated legacy trial exports on its acceptance day and states no deadline it does not have');
  const legacy = (await orgTrials(maria.token)).filter((t) => t.id.startsWith('trial-legacy'));
  neg(legacy.length === 4 && legacy.every((t) => t.reportDueAt == null || Number.isFinite(t.reportDueAt)), 'L4 no legacy row reads back with a NaN deadline (JSON turned it into null or omitted it; readers treat both as unknown)');
  const feed = await j('GET', '/org/feed', undefined, maria.token);
  ok(feed.status === 200 && feed.body.filter((i) => i.type === 'report_due' && i.trialId.startsWith('trial-legacy')).every((i) => i.dueAt === null || Number.isFinite(i.dueAt)), 'L4b the feed lists them without a fabricated deadline');
  const overdue = findMetric((await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body, 'overdue_trial_reports');
  neg(overdue && !overdue.rows.some((r) => r.trialId.startsWith('trial-legacy')), 'L4c a null deadline is "unknown", not "overdue since 1970" — none of the legacy rows is counted late');
  const mpend = (await j('GET', '/player/inbox', undefined, mateus.token)).body.find((r) => r.id === 'req-legacy-5');
  neg(expect(await j('POST', '/player/requests/req-legacy-5/respond', { accept: true, chosenSlot: 'also-garbage' }, mateus.token), 200, null), 'L5 a legacy invitation with garbage days can still be accepted (the family is not blocked by the club\'s old data)');
  const lt = (await orgTrials(maria.token)).find((t) => t.requestId === 'req-legacy-5');
  neg(lt.proposedDate === null && lt.reportDueAt === lt.acceptedAt + 7 * DAY, 'L5b the trial it creates has NO date (never the garbage, never an invented day) and a deadline from the acceptance clock');
  ok(!!mpend && mpend.status === 'pending', 'L5c (control) the legacy invitation was pending before the answer');
  const fixed = await j('POST', '/org/trials/trial-legacy-garbage/postpone', { reason: 'Recorded with a bad date', newDate: FUTURE }, maria.token);
  ok(fixed.status === 200 && fixed.body.trial.proposedDate === FUTURE, 'L6 postponing the garbage-dated trial to a real day repairs it through the validator');
  const repaired = (await orgTrials(maria.token)).find((t) => t.id === 'trial-legacy-garbage');
  ok(repaired.reportDueAt === utcDay(FUTURE) + 7 * DAY && (await j('GET', '/org/trials/trial-legacy-garbage/ics', undefined, maria.token)).status === 200, 'L6b its deadline is derived and its calendar export now works');

  // the D14 matrix before deletion
  const matrixBefore = {};
  for (const st of ['trial_requested', 'trial_scheduled', 'trial_completed', 'offer_consideration', 'offer_made', 'offer_accepted', 'archived', 'withdrawn', 'closed']) {
    const r = await j('GET', `/org/rooms/case-matrix-${st}`, undefined, maria.token);
    matrixBefore[st] = r.body?.room ?? null;
    ok(r.status === 200 && r.body.room.status === st, `L6m the ${st} case reads back at ${st} before the deletion`);
  }

  // signed invariant
  const signedBefore = (await j('GET', `/org/rooms/${MID}`, undefined, maria.token)).body.room;
  ok(signedBefore.status === 'signed', 'L7 the legacy case reads as signed');
  ok((await j('DELETE', '/player/account', undefined, mateus.token)).status === 200, 'L7b Mateus deletes his account');
  const signedAfter = (await j('GET', `/org/rooms/${MID}`, undefined, maria.token)).body.room;
  neg(signedAfter.status === 'signed' && signedAfter.rev === signedBefore.rev, 'L7c the signed case is still signed at the same revision — a terminal state is never rewritten by a deletion');
  for (const [st, before] of Object.entries(matrixBefore)) {
    const r = await j('GET', `/org/rooms/case-matrix-${st}`, undefined, maria.token);
    neg(r.status === 200 && r.body.room.status === st && r.body.room.rev === before.rev && r.body.room.playerName === null,
      `L7m ${st} + delete: status ${st} kept, rev unchanged, no name — deletion wrote no lifecycle status and added no history`);
  }
  const jr = await j('GET', '/org/rooms/case-matrix-trial_completed/journey', undefined, maria.token);
  ok(jr.status === 200 && jr.body.lifecycle.currentStage === 'trial_completed' && jr.body.trials.length >= 6 && jr.body.trials.every((t) => !('playerName' in t)), 'L7n the trial_completed case still carries its trial evidence (as tombstones) in the journey — not "no trial"');
  const signings = (await j('GET', '/org/signings', undefined, maria.token)).body;
  ok(signings.some((s) => s.id === 'sign-legacy-1'), 'L7d the signing record (the club\'s revenue event) is untouched');
  const legacyAfter = (await orgTrials(maria.token)).filter((t) => t.playerId === 'pl-carvalho');
  if (!(legacyAfter.length === 6 && legacyAfter.every((t) => t.playerName === null && Number.isFinite(t.subjectRemovedAt)))) console.error('   L7e rows:', JSON.stringify(legacyAfter.map((t) => [t.id, t.playerName, t.subjectRemovedAt])));
  neg(legacyAfter.length === 6 && legacyAfter.every((t) => t.playerName === null && Number.isFinite(t.subjectRemovedAt)), 'L7e every one of his six trials, valid or legacy, is tombstoned');
  neg(legacyAfter.every((t) => t.reportDueAt == null || Number.isFinite(t.reportDueAt)), 'L7f and none of them carries NaN after the cascade');

  // restart consistency
  await restart();
  maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const afterRestart = (await orgTrials(maria.token)).filter((t) => t.playerId === 'pl-carvalho');
  ok(afterRestart.length === legacyAfter.length && JSON.stringify(afterRestart) === JSON.stringify(legacyAfter), 'L8 after a restart the tombstones are byte-identical');
  const signedRestart = (await j('GET', `/org/rooms/${MID}`, undefined, maria.token)).body.room;
  ok(signedRestart.status === 'signed' && signedRestart.rev === signedBefore.rev, 'L8b the signed case survives the restart unchanged');
  for (const [st, before] of Object.entries(matrixBefore)) {
    const r = await j('GET', `/org/rooms/case-matrix-${st}`, undefined, maria.token);
    neg(r.status === 200 && r.body.room.status === st && r.body.room.rev === before.rev, `L8m ${st} reads the same after the restart — no delete/restart drift in lifecycle meaning`);
  }
  const eAfter = (await orgTrials(maria.token)).find((t) => t.id === D.eTrial);
  ok(eAfter && eAfter.playerName === null && eAfter.day.emergency === null && eAfter.status === 'awaiting_report', 'L8c the earlier tombstones survived too');
  neg(expect(await j('POST', `/org/trials/${D.eTrial}/report`, { ...REPORT }, maria.token), 409, 'TRIAL_SUBJECT_REMOVED'), 'L8d and the report is still refused by name');
  const kAfter = (await orgTrials(maria.token)).find((t) => t.id === B.trialId);
  ok(kAfter.reportDueAt === utcDay(FUTURE4) + 7 * DAY, 'L8e a derived deadline reads back identical after the restart (no drift between boots)');
  neg(expect(await j('GET', '/org/trials/trial-legacy-nan/ics', undefined, maria.token), 422, 'TRIAL_DATE_INVALID'), 'L8f the read-side defence holds after the restart');
  ok((await j('GET', '/healthz')).body.schemaVersion === SCHEMA_VERSION, 'L8g schema unchanged');
}

// ============================================================ R — D5 + clean boot
section('R — D5: the finalize rate limit is enforced; a clean boot needs no schema advance');
{
  const guniR = await playerLogin('pl-guni');
  ok(RATE_LIMIT_POLICY.box_cv_finalize && RATE_LIMIT_POLICY.box_cv_finalize.max === 80 && RATE_LIMIT_POLICY.box_cv_finalize.scope === 'player', 'R1 the declared policy: 80 per hour per player');
  let last = null; let firstStatus = null;
  for (let i = 0; i < RATE_LIMIT_POLICY.box_cv_finalize.max + 1; i++) {
    last = await j('POST', '/player/box-cam/sessions/no-such-session/cv/finalize', { nonce: 'x' }, guniR.token);
    if (i === 0) firstStatus = last.status;
  }
  neg(firstStatus === 404 && last.status === 429 && last.body.error === 'rate_limited', 'R2 the 81st finalize in an hour is 429 rate_limited (the first 80 reached the route: 404 for an unknown session) — the guard line that was missing now runs before anything else');
  const other = await playerLogin('pl-nowak');
  ok((await j('POST', '/player/box-cam/sessions/no-such-session/cv/finalize', { nonce: 'x' }, other.token)).status === 404, 'R2b the limit is per player: another player is not throttled');
}

console.log(`\nM23 P4A closure suite: ${passed} checks passed, ${negatives} negative/abuse checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
server.kill('SIGKILL');
process.exit(process.exitCode ?? 0);
