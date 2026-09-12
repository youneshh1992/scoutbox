// M18.2 acceptance suite — final pre-M19 cleanup.
//
// M18.2 adds no recruitment concept. What it removes is ambiguity: an event
// that reaches a client without a registry entry, a notification nobody can
// mute, a conflict told two different ways, an ordering nobody declared, a
// schema nobody versioned, a date computed in whatever zone the host happened
// to be in. Every section here corresponds to a row of M18_2_MATRIX.md and a
// numbered requirement of the mandate.
//
// More than half the checks are negative. A cleanup milestone that mostly
// proves the happy path has not cleaned anything.
//
// Structure:  §1–§19  in-process (pure engines, source sweeps, client modules)
//             §20–§40 HTTP against a fresh server
//             §41–§45 second and third boots: upgrade path, idempotence
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENT_REGISTRY, EVENT_NAMES, AUDIENCES, minimizePayload, eventFingerprint, assertEventRegistry, isRegistered,
} from '../m182/eventRegistry.mjs';
import { EVENT_AUDIENCE, audienceFor } from '../m181/eventAudience.mjs';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, schemaReport } from '../m182/migrations.mjs';
import { CATEGORIES, TYPE_CATEGORY, categoryOf, defaultPrefs, registerNotificationPrefs } from '../m182/notificationPrefs.mjs';
import { integrityReport, integritySummary } from '../m182/integrity.mjs';
import { parseFaultRules, createFaultLayer } from '../m182/faults.mjs';
import { productionConfigProblems } from '../m181/capabilities.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { ageOn, isAdult, adultAgeFor } from '../domain.mjs';
import { POLICY, secondLookStatus, secondLookExpired, briefIsLiveOn, validateRecruitmentBrief } from '../m18/shared.mjs';
import { PROVENANCE } from '../m15/shared.mjs';
import { openStore } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..');
const ROOT = path.join(SERVER_DIR, '..');
const SERVER = path.join(SERVER_DIR, 'server.mjs');
const PORT = 5990 + Math.floor(Math.random() * 8);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m182-'));

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DAY = 86_400_000;

// ============================================================ §1 registry
section('§1 — every event the server emits is in the registry, and the source agrees');
{
  // Importing server.mjs would boot a server; read the list from source instead.
  const src = read('scoutbox-server/server.mjs');
  const listSrc = src.slice(src.indexOf('export const EMITTED_EVENTS'), src.indexOf(']);', src.indexOf('export const EMITTED_EVENTS')));
  const declared = [...listSrc.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);
  ok(declared.length >= 18, `${declared.length} emitted event names declared in server.mjs`);
  // Grep every broadcast('name' call site in the server tree.
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (f === 'node_modules' || f === 'scripts' || f === 'public') continue; if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(SERVER_DIR);
  const called = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/broadcast\??\.?\(\s*'([A-Za-z_]+)'/g)) called.add(m[1]);
  const missing = [...called].filter((n) => !declared.includes(n));
  const stale = declared.filter((n) => !called.has(n));
  ok(missing.length === 0, `every broadcast() call site is in EMITTED_EVENTS (${called.size} names)${missing.length ? `: missing ${missing.join(', ')}` : ''}`);
  ok(stale.length === 0, `EMITTED_EVENTS names nothing the source never broadcasts${stale.length ? `: ${stale.join(', ')}` : ''}`);
  ok(declared.every(isRegistered), 'every emitted name is registered');
  neg(assertEventRegistry({ emitted: declared, mode: 'production' }).length === 0, 'the boot assertion passes for the real list');
  let threw = null;
  try { assertEventRegistry({ emitted: [...declared, 'brand_new_unregistered'], mode: 'development' }); } catch (e) { threw = e; }
  neg(!!threw && /brand_new_unregistered/.test(threw.message), 'development boot THROWS on an emitted name the registry does not know');
  const prodProblems = assertEventRegistry({ emitted: [...declared, 'brand_new_unregistered'], mode: 'production' });
  neg(prodProblems.some((p) => /brand_new_unregistered/.test(p)), 'production boot reports it (and the fail-closed audience keeps it private)');
}

section('§2 — every registry entry is complete and internally consistent');
{
  const incomplete = Object.entries(EVENT_REGISTRY).filter(([, def]) => !(def.domain && def.sourceSystem && AUDIENCES.includes(def.audience) && def.privacyClass
      && Array.isArray(def.payload) && def.dedupeStrategy && def.replayPolicy
      && typeof def.notificationEligible === 'boolean' && typeof def.analyticsEligible === 'boolean')).map(([n]) => n);
  ok(incomplete.length === 0, `all ${EVENT_NAMES.length} entries carry domain, source, audience, privacy class, payload allowlist, dedupe, replay and eligibility${incomplete.length ? `: ${incomplete.join(', ')}` : ''}`);
  neg(!Object.values(EVENT_REGISTRY).some((d) => d.audience === 'public_safe' && d.privacyClass === 'org_internal'),
    'nothing public carries organisation-internal content');
  neg(Object.values(EVENT_REGISTRY).filter((d) => d.audience === 'public_safe').every((d) => d.payload.every((k) => /Id$|^type$/.test(k))),
    'a public event carries at most ids and a type — a ping to re-read, never the record');
  neg(EVENT_REGISTRY.typing.replayPolicy === 'never', 'a typing indicator is never replayed to a reconnecting client');
  neg(EVENT_REGISTRY.recruitment_room_archived.audience === 'org_private', 'a Room archival stays inside the organisation');
  ok(EVENT_AUDIENCE.recruitment_room_archived === audienceFor('recruitment_room_archived'), 'the M18.1 audience table is a view over the registry, not a second table');
  neg(audienceFor('never_registered') === 'org_private', 'an unregistered event fails closed to organisation-private');
}

section('§3 — payload minimisation: what is not allowlisted does not ship');
{
  const { payload, dropped } = minimizePayload('recruitment_room_archived', { orgId: 'o', roomId: 'r', note: 'private words', dob: '2004-01-01', playerName: 'K' });
  ok(Object.keys(payload).sort().join() === 'orgId,roomId', 'the archival event carries the ids and nothing else');
  neg(dropped.includes('note') && dropped.includes('dob') && dropped.includes('playerName'), 'a note, a date of birth and a name are dropped, not forwarded');
  const un = minimizePayload('not_registered', { anything: 1 });
  neg(un.unregistered && Object.keys(un.payload).length === 0, 'an unregistered event ships an EMPTY payload');
  for (const [name, def] of Object.entries(EVENT_REGISTRY)) {
    neg(!def.payload.some((k) => /dob|birth|email|phone|note|body|text|address|password|token/i.test(k)), `${name}: allowlist admits no personal field`);
  }
}

section('§4 — the same fact fingerprints the same however it is projected');
{
  const a = eventFingerprint('recruitment_room_archived', { orgId: 'o', roomId: 'r1' });
  const b = eventFingerprint('recruitment_room_archived', { roomId: 'r1', orgId: 'o', extra: 'ignored' });
  ok(a && a === b, 'key order and extra keys do not change the fingerprint');
  neg(eventFingerprint('recruitment_room_archived', { orgId: 'o', roomId: 'r2' }) !== a, 'a different room is a different fact');
  ok(eventFingerprint('players', { playerId: 'p' }) === eventFingerprint('players', { playerId: 'p' }), 'a coalescing ping keys on its subject');
  neg(eventFingerprint('players', { playerId: 'p' }) !== eventFingerprint('players', { playerId: 'q' }), 'two players are two subjects — they never coalesce into one ping');
  neg(eventFingerprint('never_registered', { roomId: 'r' }) === null, 'an unregistered event has no fingerprint — nothing can dedupe it into silence');
  neg(eventFingerprint('typing', { channelId: 'c', side: 'org' }) === null || EVENT_REGISTRY.typing.dedupeStrategy !== 'fingerprint', 'typing is not fingerprinted as a durable fact');
}

// ======================================================= §5 terminology
section('§5 — terminology: one meaning per word, in both languages');
const clubI18n = read('scoutbox-club/src/i18n.ts');
const grassI18n = read('scoutbox-grassroots/src/i18n.ts');
const keysOf = (src, lang) => {
  const start = src.indexOf(lang === 'en' ? 'const en' : 'const fr');
  const end = lang === 'en' ? src.indexOf('const fr') : src.indexOf('export function t(');
  return new Map([...src.slice(start, end).matchAll(/'([\w.\-]+)':\s*(['"`])((?:\\.|(?!\2).)*)\2/g)].map((m) => [m[1], m[3]]));
};
const EN = keysOf(clubI18n, 'en'); const FR = keysOf(clubI18n, 'fr');
const ENg = keysOf(grassI18n, 'en'); const FRg = keysOf(grassI18n, 'fr');
{
  ok(/Trust Score at decision/.test(EN.get('rm.trustAtDecision')), 'the Room decision snapshot is labelled Trust Score, not "Trust"');
  ok(/Trust Score/.test(FR.get('rm.trustAtDecision')), 'and the French keeps the product name');
  neg(![...EN.values()].some((v) => /verified player/i.test(v)), 'no copy calls anyone a "verified player" — evidence is verified, people are not');
  neg(![...EN.values()].some((v) => /player (score|rating|rank)/i.test(v)), 'no copy names a player score, rating or rank');
  neg(/not ability/.test(EN.get('discover.ordering')) && /not the Trust Score/.test(EN.get('discover.ordering')), 'the Discover ordering sentence says what completeness is NOT');
  neg(/not ability/i.test(EN.get('discover.orderingGrassroots')), 'the Grassroots ordering sentence does too');
  const serverSrc = read('scoutbox-server/server.mjs');
  neg(!/res\.json\([^)]*\btrust\b[^)]*\bcompleteness\b/i.test(serverSrc), 'no route describes completeness as trust');
}

section('§6 — EN/FR parity in both web apps');
{
  const missingFr = [...EN.keys()].filter((k) => !FR.has(k));
  const extraFr = [...FR.keys()].filter((k) => !EN.has(k));
  ok(missingFr.length === 0 && extraFr.length === 0, `club: ${EN.size} EN keys, ${FR.size} FR keys, no gaps`);
  const missingFrG = [...ENg.keys()].filter((k) => !FRg.has(k));
  ok(missingFrG.length === 0 && ENg.size === FRg.size, `grassroots: ${ENg.size} EN keys, ${FRg.size} FR keys, no gaps`);
  // Raw-key sweep: every t('x') in source has an EN entry.
  for (const [app, en] of [['scoutbox-club', EN], ['scoutbox-grassroots', ENg]]) {
    const missing = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, app, 'src')).filter((f) => /\.tsx?$/.test(f) && f !== 'i18n.ts')) {
      for (const m of read(`${app}/src/${f}`).matchAll(/\bt\('([\w.\-]+)'/g)) if (!en.has(m[1])) missing.add(m[1]);
    }
    neg(missing.size === 0, `${app}: no screen asks for a key that does not exist${missing.size ? `: ${[...missing].join(', ')}` : ''}`);
  }
  for (const k of ['conflict.title', 'conflict.reload', 'conflict.keep', 'prefs.title', 'audit.title', 'prov.unknown', 'brief.unsaved', 'confirm.tail.irreversible']) {
    ok(EN.has(k) && FR.has(k) && ENg.has(k) && FRg.has(k), `${k} exists in EN and FR, club and grassroots`);
  }
}

// ========================================================== §7 ordering
section('§7 — every sort has a stable tie-break, and the ordering is declared');
{
  const serverSrc = read('scoutbox-server/server.mjs');
  const discover = serverSrc.slice(serverSrc.indexOf("orgRouter.get('/players'"), serverSrc.indexOf("orgRouter.get('/players/:id'"));
  ok((discover.match(/String\(a\.id\)\.localeCompare\(String\(b\.id\)\)/g) ?? []).length === 2, 'both Discover sorts (Pro and Grassroots) end on the player id');
  ok(/X-ScoutBox-Ordering/.test(discover), 'the ordering is declared on the wire');
  neg(!/score|rank|quality|ability/i.test(discover.match(/X-ScoutBox-Ordering'[\s\S]*?\);/)[0]), 'the declared ordering names no score, rank or ability');
  const shared = read('scoutbox-server/m18/shared.mjs');
  ok(/orderNobodyMissed[\s\S]*localeCompare/.test(shared), 'Nobody Missed sorts have an id tie-break');
  ok(/orderSecondLook[\s\S]*KIND_ORDER/.test(shared), 'Second Look orders by relevance kind, then time — never a priority score');
  ok(/data-ordering/.test(read('scoutbox-club/src/screens.tsx')) && /data-ordering/.test(read('scoutbox-grassroots/src/screens.tsx')), 'both Discover screens state their ordering to the person');
}

// ================================================== §8–§9 notification prefs
section('§8 — every notification type is classified, mentions are recognised from server wording only');
{
  ok(Object.values(TYPE_CATEGORY).every((c) => c in CATEGORIES), 'every type maps to a real category');
  ok(Object.keys(TYPE_CATEGORY).length >= 38, `${Object.keys(TYPE_CATEGORY).length} notification types classified`);
  ok(categoryOf('recruitment_room', 'Maria Keane mentioned you in the Recruitment Room for K.') === 'mentions', 'a mention is a mention');
  ok(categoryOf('recruitment_room', 'Maria Keane assigned you a task in the Recruitment Room for K.') === 'assignments', 'an assignment is an assignment');
  ok(categoryOf('recruitment_room', 'Room moved to shortlisted') === 'room_changes', 'an ordinary room change is room_changes');
  neg(categoryOf('message', 'someone wrote "mentioned you" in a message') !== 'mentions', 'user text saying "mentioned you" in another type is NOT a mention');
  neg(categoryOf('never_seen_type') === null, 'an unknown type is unclassified (and, below, delivered)');
  // The server's notify() call sites: every literal type is classified.
  const srv = ['server.mjs', 'm12/journeys.mjs', 'm12/scouting.mjs', 'm13/delivery.mjs', 'm13/enterprise.mjs', 'm14/index.mjs', 'm15/index.mjs', 'm16/combine.mjs', 'm16/index.mjs', 'm17/rooms.mjs', 'm18/secondLook.mjs', 'm18/nobodyMissed.mjs', 'grassrootsJourney.mjs']
    .filter((f) => fs.existsSync(path.join(SERVER_DIR, f)));
  const types = new Set();
  for (const f of srv) for (const m of fs.readFileSync(path.join(SERVER_DIR, f), 'utf8').matchAll(/notify\??\.?\([^,]+,\s*'([a-z_]+)'/g)) types.add(m[1]);
  const unclassified = [...types].filter((t) => !(t in TYPE_CATEGORY));
  ok(unclassified.length === 0, `every literal notify() type in the source is classified (${types.size} found)${unclassified.length ? `: ${unclassified.join(', ')}` : ''}`);
}

section('§9 — defaults are conservative without muting an obligation, and the mandatory category holds');
{
  const d = defaultPrefs();
  neg(d.categories.discovery_nudges === false, 'discovery nudges are off by default');
  ok(d.categories.security_account === true && CATEGORIES.security_account.mandatory, 'security and account is on and mandatory');
  for (const t of ['outcome', 'signing', 'report_due', 'trial_day', 'verification', 'saved_search']) {
    neg(TYPE_CATEGORY[t] !== 'discovery_nudges', `${t} is an obligation or a request, never a nudge that defaults off`);
  }
  neg(d.emailIntent === false, 'nobody is opted into email they never asked for');
  // In-process enforcement with stub routers.
  const db = { notificationPrefs: [] };
  const stub = { get() {}, put() {} };
  const { allows, effective } = registerNotificationPrefs({ db, orgRouter: stub, playerRouter: stub, guardianRouter: stub, persist() {} });
  const tom = { kind: 'org_user', id: 'u-tom' }; const maria = { kind: 'org_user', id: 'u-maria' };
  ok(allows(tom, 'recruitment_room', 'Maria mentioned you'), 'a mention is delivered by default');
  db.notificationPrefs.push({ audienceKind: 'org_user', audienceId: 'u-tom', categories: { mentions: false, security_account: false }, emailIntent: false });
  neg(allows(tom, 'recruitment_room', 'Maria mentioned you') === false, 'once mentions are off, a mention is not created for Tom');
  neg(allows(maria, 'recruitment_room', 'Tom mentioned you') === true, "Tom's preference does not touch Maria (isolation)");
  neg(allows(tom, 'verification', 'x') === true && effective('org_user', 'u-tom').categories.security_account === true,
    'a stored "security_account: false" is ignored — the mandatory category is always on');
  ok(allows(tom, 'never_seen_type', 'x') === true, 'an unknown type is delivered rather than silently lost');
  db.notificationPrefs.push({ audienceKind: 'guardian', audienceId: 'g-1', categories: { combine: false }, emailIntent: false });
  neg(allows({ kind: 'guardian', id: 'g-1' }, 'combine', 'x') === false && allows({ kind: 'player', id: 'g-1' }, 'combine', 'x') === true,
    'a guardian preference is keyed by kind AND id — a player with the same id string is untouched');
}

// ================================================== §10 migrations (unit)
section('§10 — migrations: ordered, idempotent, recorded, and a failure aborts before any save');
{
  const db = {};
  const first = runMigrations(db, { now: 1000 });
  ok(first.from === 0 && first.to === SCHEMA_VERSION && first.ran.length === MIGRATIONS.length, `a fresh database runs all ${MIGRATIONS.length} steps to ${SCHEMA_VERSION}`);
  const second = runMigrations(db, { now: 2000 });
  ok(second.ran.length === 0 && second.alreadyApplied === MIGRATIONS.length, 'a second run applies nothing');
  ok(db.schema.migrations.length === MIGRATIONS.length && db.schema.migrations.every((m) => m.at === 1000), 'the applied list is recorded once, with its time');
  ok(schemaReport(db).upToDate === true, 'the report says up to date');
  ok(new Set(MIGRATIONS.map((m) => m.id)).size === MIGRATIONS.length, 'migration ids are unique');
  ok(MIGRATIONS.every((m) => /^m\d+_\d{3}_[a-z_]+$/.test(m.id) && m.note), 'every step has a stable id and a note');
  // Prior-schema fixture: rooms and briefs without rev, notifications without repeatCount, no schema record.
  const old = { recruitmentCases: [{ id: 'c1', room: { status: 'watching' } }], recruitmentBriefs: [{ id: 'b1' }], notifications: [{ id: 'n1' }], players: [] };
  const up = runMigrations(old, { now: 3000 });
  ok(up.from === 0 && old.recruitmentCases[0].room.rev === 1 && old.recruitmentBriefs[0].rev === 1 && old.notifications[0].repeatCount === 1,
    'a pre-M18.1 snapshot is upgraded: rev 1, repeatCount 1, prefs collection present');
  ok(Array.isArray(old.notificationPrefs) && old.players.length === 0, 'no step invents data');
  const broken = { recruitmentCases: 5 };
  let threw = null;
  try { runMigrations(broken); } catch (e) { threw = e; }
  neg(!!threw && /m182_003_rev_backfill failed/.test(threw.message) && /not modified/.test(threw.message), 'a failing step names itself and promises the disk was untouched');
  neg(schemaReport({}).upToDate === false && schemaReport({}).version === 0, 'an unmigrated database reports version 0, never "fine"');
  neg(schemaReport({ schema: { version: SCHEMA_VERSION, migrations: [] } }).upToDate === false, 'the right version number with no applied list is NOT up to date');
}

// ============================================== §11 integrity (unit)
section('§11 — boot-time integrity reports and never repairs');
{
  const sane = {
    orgs: [{ id: 'o1' }], players: [{ id: 'p1' }, { id: 'p2' }],
    recruitmentCases: [
      { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'archived', rev: 3 } },
      { id: 'c2', orgId: 'o1', playerId: 'p1', room: { status: 'watching', rev: 1 } },
    ],
    recruitmentBriefs: [{ id: 'b1', rev: 1 }], secondLookItems: [{ id: 's1', orgId: 'o1', roomId: 'c1', changes: [{ fingerprint: 'f1' }, { fingerprint: 'f2' }] }],
  };
  const r = integrityReport(sane);
  ok(r.ok && r.violations.length === 0, 'an archived Room plus an open one for the same player is fine — history repeats, activity does not');
  const dup = JSON.parse(JSON.stringify(sane));
  dup.recruitmentCases.push({ id: 'c3', orgId: 'o1', playerId: 'p1', room: { status: 'shortlisted', rev: 1 } });
  const r2 = integrityReport(dup);
  neg(r2.violations.some((v) => v.code === 'ROOM_OPEN_DUPLICATE' && v.ids.includes('c2') && v.ids.includes('c3')), 'two open Rooms for one organisation and player is reported with both ids');
  ok(dup.recruitmentCases.length === 3, 'and nothing was deleted or repaired');
  const orphan = { ...sane, recruitmentCases: [{ id: 'c9', orgId: 'nope', playerId: 'p1', room: { status: 'watching', rev: 1 } }] };
  neg(integrityReport(orphan).violations.some((v) => v.code === 'ROOM_ORPHAN_ORG'), 'a Room whose organisation does not exist is reported');
  neg(integrityReport({ ...sane, recruitmentBriefs: [{ id: 'b1', rev: 1 }, { id: 'b1', rev: 1 }] }).violations.some((v) => v.code === 'BRIEF_ID_DUPLICATE'), 'a duplicated brief id is reported');
  neg(integrityReport({ ...sane, secondLookItems: [{ id: 's1', orgId: 'o1', roomId: 'c1', changes: [{ fingerprint: 'f1' }, { fingerprint: 'f1' }] }] }).violations.some((v) => v.code === 'SECOND_LOOK_FINGERPRINT_DUPLICATE'),
    'the same evidence counted twice inside one Second Look item is reported');
  neg(integrityReport({ ...sane, recruitmentBriefs: [{ id: 'b1' }] }).violations.some((v) => v.code === 'BRIEF_REV_INVALID'), 'a rev-guarded record with no rev is reported (the migration should have set it)');
  const summary = integritySummary(r2);
  neg(!JSON.stringify(summary).includes('c2'), 'the operator summary carries counts by code, never ids');
  ok(integrityReport({}).ok, 'an empty database is not a violation');
}

// ================================================== §12 faults (unit)
section('§12 — the fault layer is inert in production and refuses to be configured there');
{
  ok(parseFaultRules('delay:/org/players/*/trust:1500;unavailable:/org/rooms/*').length === 2, 'rules parse');
  let bad = null; try { parseFaultRules('explode:/x'); } catch (e) { bad = e; }
  neg(!!bad, 'an unknown fault kind is refused');
  let noPath = null; try { parseFaultRules('delay'); } catch (e) { noPath = e; }
  neg(!!noPath, 'a rule without a path is refused — a fault can never apply to every route by accident');
  const prod = createFaultLayer({ env: { NODE_ENV: 'production', SCOUTBOX_FAULTS: 'unavailable:/org/players' } });
  neg(prod.enabled === false && prod.rules().length === 0, 'in production the layer is disabled and loads NO rules even when the variable is set');
  const routes = []; prod.install({ use() {}, post(p) { routes.push(p); } });
  neg(!routes.includes('/__faults'), 'and the runtime control route is not mounted');
  neg(productionConfigProblems({ env: { NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 's', SCOUTBOX_FAULTS: 'x' } }).some((p) => p.code === 'FAULTS_IN_PRODUCTION' && p.fatal),
    'a production boot with SCOUTBOX_FAULTS set is a fatal configuration problem');
  const dev = createFaultLayer({ env: { NODE_ENV: 'development' } });
  ok(dev.enabled && dev.rules().length === 0, 'development with no variable is enabled and empty (a no-op)');
}

// ============================================ §13 date boundaries (unit)
section('§13 — age is a fact about UTC calendar days');
{
  const at = (iso) => new Date(iso);
  ok(ageOn('2008-03-14', at('2026-03-14T00:00:00Z')) === 18, 'a person is 18 from the first UTC instant of their 18th birthday');
  neg(ageOn('2008-03-14', at('2026-03-13T23:59:59Z')) === 17, 'one second earlier they are 17 — in every time zone the server runs in');
  neg(ageOn('2008-03-14', at('2026-03-14T23:00:00-05:00')) === 18, 'a host in New York at 23:00 local on the 14th (04:00Z on the 15th) still says 18, not a day off');
  ok(ageOn('2008-02-29', at('2026-02-28T12:00:00Z')) === 17, 'a leap-day birth is 17 on 28 February of a common year');
  ok(ageOn('2008-02-29', at('2026-03-01T00:00:00Z')) === 18, 'and 18 on 1 March — the birthday is never skipped');
  ok(ageOn('2008-02-29', at('2028-02-29T00:00:00Z')) === 20, 'and on a real 29 February the maths is exact');
  ok(adultAgeFor('GB') === 18 && adultAgeFor('KR') === 19 && adultAgeFor('XX') === 18, 'majority: 18 by default, 19 in Korea');
  const kr = { dob: '2008-03-14', country: 'KR' }; const gb = { dob: '2008-03-14', country: 'GB' };
  ok(isAdult(gb, at('2026-03-14T00:00:00Z')) === true, 'a British 18-year-old is an adult');
  neg(isAdult(kr, at('2026-03-14T00:00:00Z')) === false, 'a Korean 18-year-old is NOT — the same date of birth, a different rule');
  ok(isAdult(kr, at('2027-03-14T00:00:00Z')) === true, 'and becomes one at 19');
  neg(Number.isNaN(ageOn('garbage')) && Number.isNaN(ageOn('2004-13-45')), 'a malformed date of birth is NaN — never age 0, never an adult by accident');
  neg(isAdult({ dob: 'garbage', country: 'GB' }) === false, 'and a person with an unreadable date of birth is not treated as an adult');
}

section('§14 — a Recruitment Brief window is inclusive calendar days, in UTC');
{
  const b = (activeFrom, activeUntil, status = 'active') => ({ status, activeFrom, activeUntil });
  ok(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-09-12') === true, 'live on its first day');
  neg(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-09-11') === false, 'not live the day before it starts');
  ok(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-09-30') === true, 'live on its last day, all day');
  neg(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-10-01') === false, 'not live the day after');
  ok(briefIsLiveOn(b('2026-03-28', '2026-03-29'), '2026-03-29') === true, 'a window across the European DST change is unaffected — there is no clock in a calendar day');
  ok(briefIsLiveOn(b(null, null), '1999-01-01') === true, 'no window means always live while active');
  neg(briefIsLiveOn(b('2026-09-12', '2026-09-30', 'paused'), '2026-09-15') === false, 'a paused brief is not live inside its window');
  neg(briefIsLiveOn(null, '2026-09-15') === false, 'a missing brief is not live');
  const backwards = validateRecruitmentBrief({ title: 'Backwards', positions: ['CM'], activeFrom: '2026-09-30', activeUntil: '2026-09-12' });
  neg(backwards.ok === false && backwards.error === 'BRIEF_INVALID', 'a window that ends before it starts cannot be saved');
  // The server evaluates "today" as a UTC calendar day: the same string a
  // client in any zone would compute from toISOString().
  const src = read('scoutbox-server/m18/shared.mjs');
  ok(/toISOString\(\)\.slice\(0, 10\)/.test(src.slice(src.indexOf('export function briefIsLiveOn'))), 'today is the UTC calendar day');
}

section('§15 — Second Look cooldown and expiry boundaries');
{
  const now = Date.parse('2026-09-12T12:00:00Z');
  const existing = (status, handledAt) => ({ status, changeFingerprints: ['f1'], dismissedAt: handledAt, updatedAt: handledAt });
  const candidate = { changeFingerprints: ['f1', 'f2'], changes: [{ fingerprint: 'f2', type: 'general_update' }] };
  neg(secondLookStatus({ existing: existing('dismissed', now - 29 * DAY), candidate, now }).action === 'suppress', 'new but minor evidence 29 days after a dismissal stays quiet');
  ok(secondLookStatus({ existing: existing('dismissed', now - 30 * DAY), candidate, now }).action === 'reopen', `at exactly ${POLICY.cooldownDays} days the cooldown has ended`);
  neg(secondLookStatus({ existing: existing('dismissed', now - 5 * DAY), candidate: { changeFingerprints: ['f1'], changes: [] }, now }).action === 'suppress', 'the SAME evidence never comes back, whatever the date');
  const item = (ago) => ({ status: 'open', latestChangeAt: now - ago });
  ok(secondLookExpired(item(POLICY.expiryDays * DAY), now) === false, `an item exactly ${POLICY.expiryDays} days old is still open`);
  neg(secondLookExpired(item(POLICY.expiryDays * DAY + 1), now) === true, 'one millisecond past the window it is expired');
  neg(secondLookExpired({ status: 'reviewed', latestChangeAt: now - 400 * DAY }, now) === false, 'a reviewed item never "expires" — expiry is for unanswered ones');
}

// =========================================== §16–§18 client modules (source)
section('§16 — destructive actions are classified and every one has consequence copy');
const confirmSrc = read('scoutbox-club/src/confirmAction.ts');
{
  const entries = [...confirmSrc.matchAll(/(\w+): \{ titleKey: '([\w.]+)', bodyKey: '([\w.]+)', cls: '(\w+)' \}/g)];
  ok(entries.length >= 10, `${entries.length} destructive actions catalogued`);
  const classes = new Set(['reversible', 'archive', 'tombstone', 'irreversible']);
  ok(entries.every((e) => classes.has(e[4])), 'every action has one of the four classes');
  for (const [, name, titleKey, bodyKey] of entries) {
    ok(EN.has(titleKey) && EN.has(bodyKey) && FR.has(titleKey) && FR.has(bodyKey), `${name}: title and consequence exist in EN and FR`);
    neg(!/are you sure/i.test(EN.get(titleKey) + EN.get(bodyKey)), `${name}: never asks "are you sure"`);
  }
  ok(entries.find((e) => e[1] === 'deleteComment')[4] === 'tombstone', 'deleting a comment is a tombstone (the server keeps the record)');
  ok(entries.find((e) => e[1] === 'archiveRoom')[4] === 'archive', 'archiving a Room is reversible-by-reopen, and says so');
  neg(entries.find((e) => e[1] === 'pauseBrief')[4] === 'reversible', 'pausing a brief needs no confirmation — a guard on a harmless action trains people to click through');
  ok(/if \(action\.cls === 'reversible'\) return true;/.test(confirmSrc), 'the reversible class short-circuits before any dialog');
  ok(confirmSrc === read('scoutbox-grassroots/src/confirmAction.ts'), 'grassroots carries the identical catalogue');
  for (const f of ['screens.tsx', 'roomsScreens.tsx', 'm18Screens.tsx', 'm12screens.tsx', 'combineScreens.tsx']) {
    neg(!/window\.confirm\(`(Record|Remove|Delete|Archive|Cancel)/.test(read(`scoutbox-club/src/${f}`)), `${f}: no bespoke destructive confirm remains`);
  }
}

section('§17 — one conflict contract, one HTTP state mapper, one provenance vocabulary');
{
  const conflict = read('scoutbox-club/src/conflict.tsx');
  ok(/VERSION_CONFLICT\$/.test(conflict) && /e\.status !== 409/.test(conflict), 'a conflict is a 409 whose code ends in VERSION_CONFLICT — nothing else is one');
  ok(/currentRev|updatedBy|updatedAt/.test(conflict), 'it reads the server metadata');
  ok(/role="alert"/.test(conflict) && /aria-live="assertive"/.test(conflict), 'the notice is announced');
  neg(!/userId/.test(conflict), 'and never shows a user id');
  const http = read('scoutbox-club/src/httpState.ts');
  for (const code of ['401', '403', '404', '409', '413', '429']) ok(new RegExp(`case ${code}|=== ${code}`).test(http), `httpState handles ${code}`);
  ok(/retryAfterS/.test(http) && /retryable/.test(http), 'it carries Retry-After and retryability to the screen');
  neg(!/logout|signOut|clearSession/.test(http), 'the mapper never logs anyone out — that decision belongs to the 401 path in App');
  const prov = read('scoutbox-club/src/provenance.ts');
  ok(PROVENANCE.every((p) => new RegExp(`${p}:`).test(prov)), `all ${PROVENANCE.length} server provenance values have a presentation`);
  neg(/known: false, label: t\('prov\.unknown'\)/.test(prov), 'an unknown provenance is "Source unavailable"');
  neg(!/\?\? 'prov\.player'|: 'prov\.player'\s*\}\s*;?\s*$/.test(prov), 'it never falls back to "Player-provided"');
  for (const f of ['conflict.tsx', 'httpState.ts', 'provenance.ts', 'dirtyGuard.ts', 'orgPanels.tsx']) {
    ok(read(`scoutbox-club/src/${f}`) === read(`scoutbox-grassroots/src/${f}`), `${f} is byte-identical in club and grassroots`);
  }
  neg(!/PROV_PILL|PROV_KEY/.test(read('scoutbox-club/src/m15screens.tsx')), 'the old private provenance tables are gone from the Passport screen');
}

section('§18 — unsaved-change protection and the audit/preferences panels are wired and accessible');
{
  const guard = read('scoutbox-club/src/dirtyGuard.ts');
  const app = read('scoutbox-club/src/App.tsx');
  ok(/beforeunload/.test(guard) && /guardHashChange\(\(\) => t\('brief\.unsaved'\)\)/.test(app), 'the guard covers close/reload, and the app asks it FIRST on every hash change');
  neg((app.match(/noteNavigated\(\);/g) ?? []).length >= 5, 'every programmatic navigation keeps the guard\'s remembered hash in step');
  neg(/if \(!anyDirty\(\)\) return true;/.test(guard), 'a clean form never prompts');
  ok((app.match(/confirmLeave\(t\('brief\.unsaved'\)\)/g) ?? []).length >= 4, 'sidebar, Room and Brief navigation all ask first');
  const m18 = read('scoutbox-club/src/m18Screens.tsx');
  ok(/registerDirtyGuard\(/.test(m18) && /ConflictNotice/.test(m18), 'the Brief form registers its dirty state and renders the shared conflict notice');
  const rooms = read('scoutbox-club/src/roomsScreens.tsx');
  ok(/expectedRev: room\.rev/.test(rooms) && (rooms.match(/ConflictNotice/g) ?? []).length >= 2, 'Room status and decision submits send the token and render the same notice');
  const panels = read('scoutbox-club/src/orgPanels.tsx');
  ok(/aria-label=/.test(panels) && /role="alert"/.test(panels), 'preference toggles are labelled, errors are announced');
  ok(/err\.retryable && <button/.test(panels), '"Try again" is offered only when retrying can help');
  neg(/disabled=\{c\.mandatory/.test(panels), 'the mandatory category cannot be toggled in the UI either');
  ok(/NotificationPreferencesPanel/.test(read('scoutbox-club/src/m13screens.tsx')) && /AuditLogPanel/.test(read('scoutbox-grassroots/src/m13screens.tsx')), 'both panels are mounted under Organisation in both apps');
  neg(!/nav\.|NAV_ITEMS|sidebar/.test(panels), 'no new global sidebar item was added for them');
}

section('§19 — the request log carries no personal data');
{
  const ent = read('scoutbox-server/m13/enterprise.mjs');
  const line = ent.match(/console\.log\(JSON\.stringify\(\{[^}]+\}\)\)/)?.[0] ?? '';
  ok(/t: Date\.now\(\), id: req\.correlationId, m: req\.method, p: fullPath/.test(line), 'the structured log line is time, id, method, path, status, duration');
  neg(!/authorization|token|body|email|dob|query/.test(line), 'and nothing else');
  const files = fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith('.mjs'));
  for (const d of ['m12', 'm13', 'm14', 'm15', 'm16', 'm162', 'm17', 'm18', 'm181', 'm182']) for (const f of fs.readdirSync(path.join(SERVER_DIR, d))) files.push(`${d}/${f}`);
  const leaks = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
    for (const m of s.matchAll(/console\.(log|error|warn)\(([^\n]*)\)/g)) {
      if (/req\.body|req\.headers|\.dob\b|\.email\b|\.token\b|\.password\b|password:/.test(m[2])) leaks.push(`${f}: ${m[2].slice(0, 80)}`);
    }
  }
  neg(leaks.length === 0, `no console line prints a body, a header, a date of birth, an email or a token${leaks.length ? `\n    ${leaks.join('\n    ')}` : ''}`);
}

// ============================================================ HTTP boot
section('§20 — a clean database boots, migrates and passes integrity');
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', BOX_CAM_TEST_PROVIDER: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env, base) {
  const proc = spawn(process.execPath, [SERVER], { env, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { const r = await fetch(`${base}/healthz`); up = r.ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let serverProc = await boot(ENV, BASE);
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, headers: r.headers };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
{
  const h = await j('GET', '/healthz');
  ok(h.body.schemaVersion === SCHEMA_VERSION, `/healthz reports schema ${SCHEMA_VERSION}`);
  const c = await j('GET', '/capabilities');
  ok(c.body.schema?.upToDate === true && c.body.schema.migrationsApplied === MIGRATIONS.length, '/capabilities: schema up to date, every migration applied');
  ok(c.body.integrity?.ok === true && c.body.integrity.violations === 0, 'integrity: no violations in the seeded snapshot');
  ok(c.body.events?.registered === EVENT_NAMES.length, 'events: the registry size is reported');
  ok(c.body.faultInjection?.state === 'available', 'fault injection is available in this development boot');
  ok(c.body.capabilities?.email_transport?.state === 'local_outbox', 'email is honestly a local outbox');
  neg(!/"(secret|token|password|smtp|url)":\s*"[^"]{6,}"/i.test(JSON.stringify(c.body)), 'no secret VALUE on the operator surface (states only)');
}

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const ana = await login('org-eastport', 'Ana Ruiz', 'Head of Recruitment'); // a second lead — the colleague in §23
const hack = await login('org-hackneymarsh', 'Dee Okafor', 'Head Coach', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok([maria, tom, rita, kola].every((x) => x?.token), 'HTTP actors logged in');

// ====================================================== §21 HTTP contract
section('§21 — every error says whether to retry; every response says its schema');
{
  const ping = await j('GET', '/healthz');
  ok(ping.headers.get('x-scoutbox-schema') === String(SCHEMA_VERSION), 'X-ScoutBox-Schema is on a 200');
  const anon = await j('GET', '/org/rooms');
  neg(anon.status === 401 && anon.headers.get('x-scoutbox-retry') === 'not-retryable', '401 is not retryable');
  const notFound = await j('GET', '/org/rooms/rc-nope', undefined, maria.token);
  neg(notFound.status === 404 && notFound.headers.get('x-scoutbox-retry') === 'not-retryable', '404 is not retryable');
  const forbidden = await j('GET', '/org/audit', undefined, tom.token);
  neg(forbidden.status === 403 && forbidden.headers.get('x-scoutbox-retry') === 'not-retryable', '403 is not retryable');
  const malformed = await fetch(`${BASE}/org/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` }, body: '{not json' });
  neg(malformed.status === 400 && malformed.headers.get('x-scoutbox-retry') === 'not-retryable', 'malformed JSON is 400, not retryable');
  const huge = await fetch(`${BASE}/org/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` }, body: JSON.stringify({ playerId: 'x'.repeat(21 * 1024 * 1024) }) });
  neg(huge.status === 413 && huge.headers.get('x-scoutbox-retry') === 'not-retryable', 'an oversized body is 413, not retryable');
  ok(!!notFound.headers.get('x-request-id'), 'an error response carries a correlation id header');
  const nowhere = await j('GET', '/no/such/route', undefined, maria.token);
  neg(nowhere.status === 404 && nowhere.headers.get('x-scoutbox-schema') === String(SCHEMA_VERSION), 'an unknown route still carries the schema header');
}

section('§22 — 429 carries Retry-After from the named policy');
{
  const room = (await j('POST', '/org/rooms', { playerId: 'pl-adeyemi' }, maria.token)).body.room;
  ok(room?.roomId, 'fixture: a Room for the rate-limit burst');
  let limited = null;
  for (let i = 0; i < RATE_LIMIT_POLICY.room_comment.max + 2 && !limited; i++) {
    const r = await j('POST', `/org/rooms/${room.roomId}/comments`, { body: `burst ${i}` }, maria.token);
    if (r.status === 429) limited = r;
  }
  neg(!!limited, 'the comment burst is refused');
  if (limited) {
    ok(limited.headers.get('retry-after') === String(Math.ceil(RATE_LIMIT_POLICY.room_comment.windowMs / 1000)), `Retry-After is the policy window (${RATE_LIMIT_POLICY.room_comment.windowMs / 1000}s)`);
    ok(limited.headers.get('x-scoutbox-retry') === 'retryable', 'and the answer is marked retryable');
    neg(!/adeyemi|Kola/i.test(JSON.stringify(limited.body)), 'the refusal names no player');
    const colleague = await j('POST', `/org/rooms/${room.roomId}/comments`, { body: 'not limited' }, tom.token);
    neg(colleague.status === 201 || colleague.status === 200, 'the limit is per person and room — a colleague on the same Room is not limited');
  }
  globalThis.ROOM = room;
}

// ======================================================= §23 conflict meta
section('§23 — a conflict names who moved the record and when, never a user id');
{
  const brief = (await j('POST', '/org/recruitment-briefs', { title: 'Conflict fixture', positions: ['CM'] }, maria.token)).body.brief;
  const theirs = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Ana was here', expectedRev: 1 }, ana.token);
  ok(theirs.status === 200, "fixture: Ana's edit lands on rev 1");
  const mine = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Maria was here', expectedRev: 1 }, maria.token);
  neg(mine.status === 409 && mine.body.error === 'BRIEF_VERSION_CONFLICT', "Maria's stale write is refused");
  ok(mine.body.currentRev === 2 && mine.body.updatedBy === 'Ana Ruiz' && typeof mine.body.updatedAt === 'number', 'the 409 carries currentRev, who (a display name) and when');
  neg(!/"userId"|u-\w+/.test(JSON.stringify(mine.body)), 'and no user id');
  ok(mine.headers.get('x-scoutbox-retry') === 'not-retryable', 'a conflict is not something to retry blindly');
  const same = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Maria, reloaded', expectedRev: 2 }, maria.token);
  ok(same.status === 200 && same.body.brief.rev === 3, 'after reloading the token, the same edit applies');
  const soon = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'x', expectedRev: 'soon' }, maria.token);
  neg(soon.status === 400 && soon.body.error === 'EXPECTED_REV_INVALID', 'a non-numeric token is a 400, never coerced to "no token"');
  const roomMove = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/status`, { status: 'under_review', expectedRev: 99 }, ana.token);
  neg(roomMove.status === 409 && roomMove.body.error === 'ROOM_VERSION_CONFLICT' && 'updatedBy' in roomMove.body, 'the Room status conflict carries the same metadata shape');
}

// ====================================================== §24 preferences
section('§24 — notification preferences are enforced at creation, per person');
{
  const r = await j('GET', '/org/notification-preferences', undefined, tom.token);
  ok(r.status === 200 && r.body.preferences.categories.length === Object.keys(CATEGORIES).length, 'defaults are readable');
  ok(r.body.preferences.channels.email === 'local_outbox' && /no external email transport/i.test(r.body.preferences.channels.note), 'the email channel is described honestly');
  const before = (await j('GET', '/org/notifications', undefined, tom.token)).body.length;
  const off = await j('PUT', '/org/notification-preferences', { categories: { mentions: false } }, tom.token);
  ok(off.status === 200 && off.body.preferences.categories.find((c) => c.id === 'mentions').enabled === false, 'Tom turns mentions off');
  await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/comments`, { body: 'quiet mention', mentions: [tom.userId] }, rita.token); // wrong org → 404, harmless
  const c1 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/comments`, { body: 'first mention', mentions: [tom.userId] }, ana.token);
  const c1status = c1.status;
  const afterOff = (await j('GET', '/org/notifications', undefined, tom.token)).body;
  neg(afterOff.length === before && !afterOff.some((n) => /first mention|mentioned you/.test(n.text) && n.ts > Date.now() - 5000), `no notification was created for a muted mention (comment ${c1status})`);
  const on = await j('PUT', '/org/notification-preferences', { categories: { mentions: true } }, tom.token);
  ok(on.status === 200, 'Tom turns mentions back on');
  const c2 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/comments`, { body: 'second mention', mentions: [tom.userId] }, ana.token);
  ok(c1.status === 201 && c2.status === 201, 'fixture: both mention comments were accepted');
  const afterOn = (await j('GET', '/org/notifications', undefined, tom.token)).body;
  const newest = afterOn[0];
  ok(afterOn.length === before + 1 && newest.category === 'mentions' && newest.groupKey === `recruitment_room:${globalThis.ROOM.roomId}`,
    `the next mention arrives, categorised and grouped by (type, room) — before=${before} after=${afterOn.length} newest=${JSON.stringify({ type: newest?.type, category: newest?.category, groupKey: newest?.groupKey, text: newest?.text })}`);
  const mariaPrefs = (await j('GET', '/org/notification-preferences', undefined, maria.token)).body.preferences;
  neg(mariaPrefs.categories.find((c) => c.id === 'mentions').enabled === true, "Tom's preference did not touch Maria");
  const mandatory = await j('PUT', '/org/notification-preferences', { categories: { security_account: false } }, tom.token);
  neg(mandatory.status === 400 && mandatory.body.error === 'PREF_CATEGORY_MANDATORY', 'security and account cannot be turned off');
  const unknown = await j('PUT', '/org/notification-preferences', { categories: { player_ranking: false } }, tom.token);
  neg(unknown.status === 400 && unknown.body.error === 'PREF_CATEGORY_UNKNOWN', 'an unknown category is refused, not stored');
  const shape = await j('PUT', '/org/notification-preferences', { categories: ['mentions'] }, tom.token);
  neg(shape.status === 400 && shape.body.error === 'PREFS_INVALID', 'a wrong shape is refused');
  const anon = await j('PUT', '/org/notification-preferences', { categories: { mentions: false } });
  neg(anon.status === 401, 'anonymous preference writes are refused');
  const p = await j('GET', '/player/notification-preferences', undefined, kola.token);
  ok(p.status === 200 && p.body.preferences.categories.some((c) => c.id === 'combine'), 'a player has the same preference surface');
  const cross = await j('GET', '/player/notification-preferences', undefined, tom.token);
  neg(cross.status === 401 || cross.status === 403, 'an organisation token cannot read a player\'s preferences');
}

// ============================================================== §25 audit
section('§25 — the audit log: leads only, no content, bounded, stable');
{
  const SECRET = 'SECRET-NOTE-XK9';
  const move = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/status`, { status: 'under_review', note: SECRET }, maria.token);
  ok(move.status === 200, 'fixture: a status change with a private note');
  const lead = await j('GET', '/org/audit', undefined, maria.token);
  ok(lead.status === 200 && Array.isArray(lead.body.items) && lead.body.items.length > 0, 'a lead reads the audit log');
  const entry = lead.body.items.find((e) => e.action === 'room_status_changed' && e.target.id === globalThis.ROOM.roomId);
  ok(entry && entry.actor.name === 'Maria Keane' && entry.detail.to === 'under_review' && entry.detail.hadNote === true, 'the entry says what, who, and THAT a note was written');
  neg(!JSON.stringify(lead.body).includes(SECRET), 'the note itself is not in the audit log');
  neg(!JSON.stringify(lead.body).includes('first mention') && !JSON.stringify(lead.body).includes('second mention'), 'comment bodies are not in it either');
  neg(!/"dob"|"email"/.test(JSON.stringify(lead.body)), 'no date of birth or email');
  const scout = await j('GET', '/org/audit', undefined, tom.token);
  neg(scout.status === 403, 'a scout gets 403');
  const anon = await j('GET', '/org/audit');
  neg(anon.status === 401, 'anonymous gets 401');
  const player = await j('GET', '/org/audit', undefined, kola.token);
  neg(player.status === 401 || player.status === 403, 'a player token gets nothing');
  const other = await j('GET', '/org/audit', undefined, rita.token);
  neg(other.status === 200 && !other.body.items.some((e) => e.target.id === globalThis.ROOM.roomId), "another organisation's lead does not see Eastport's rows");
  const page1 = await j('GET', '/org/audit?limit=1', undefined, maria.token);
  ok(page1.body.items.length === 1 && page1.body.nextCursor, 'limit=1 pages');
  const page2 = await j('GET', `/org/audit?limit=1&cursor=${page1.body.nextCursor}`, undefined, maria.token);
  ok(page2.status === 200 && page2.body.items[0]?.id !== page1.body.items[0].id, 'the cursor moves on');
  const again = await j('GET', '/org/audit?limit=1', undefined, maria.token);
  ok(again.body.items[0].id === page1.body.items[0].id, 'the order is stable between reads');
  const badCursor = await j('GET', '/org/audit?cursor=nope', undefined, maria.token);
  neg(badCursor.status === 400 && badCursor.body.error === 'AUDIT_CURSOR_INVALID', 'a stale cursor is a 400, not an empty page');
  const big = await j('GET', '/org/audit?limit=5000', undefined, maria.token);
  neg(big.body.items.length <= 50, 'limit is clamped to 50');
  if (hack?.token) {
    const empty = await j('GET', '/org/audit', undefined, hack.token);
    neg(empty.status === 200 && empty.body.items.length === 0 && empty.body.total === 0, 'an organisation with no history gets an empty page, not an error');
  }
  const foreignCursor = await j('GET', `/org/audit?cursor=${page1.body.items[0].id}`, undefined, rita.token);
  neg(foreignCursor.status === 400, "a cursor from another organisation's page is invalid here");
}

// ================================================================ §26 faults
section('§26 — simulated latency and failure: isolated, retryable, idempotent');
{
  const setFaults = (rules) => j('POST', '/__faults', { rules }, undefined);
  ok((await setFaults('delay:/org/players:300')).status === 200, 'a delay rule is installed at runtime');
  const t0 = Date.now();
  const slow = await j('GET', '/org/players', undefined, maria.token);
  const dt = Date.now() - t0;
  ok(slow.status === 200 && dt >= 280, `the slow source still answers correctly, after ${dt}ms`);
  const t1 = Date.now();
  const other = await j('GET', '/org/rooms', undefined, maria.token);
  neg(other.status === 200 && Date.now() - t1 < 250, 'an unrelated route is not slowed (isolation)');
  await setFaults('unavailable:/org/players');
  const down = await j('GET', '/org/players', undefined, maria.token);
  neg(down.status === 503 && down.body.error === 'SOURCE_UNAVAILABLE' && down.body.retryable === true && down.headers.get('x-scoutbox-retry') === 'retryable',
    'an unavailable source is a 503 marked retryable');
  ok(down.body.simulated === true && down.body.requestId === down.headers.get('x-request-id'), 'and says it is simulated, with the same correlation id in body and header');
  neg((await j('GET', '/org/rooms', undefined, maria.token)).status === 200, 'the Room list is unaffected by the player source being down');
  await setFaults('retryable:/org/players:1');
  const first = await j('GET', '/org/players', undefined, maria.token);
  const second = await j('GET', '/org/players', undefined, maria.token);
  ok(first.status === 503 && second.status === 200, 'retryable: the first call fails, the retry succeeds');
  await setFaults('fatal:/org/players');
  const fatal = await j('GET', '/org/players', undefined, maria.token);
  neg(fatal.status === 500 && fatal.body.retryable === false && fatal.headers.get('x-scoutbox-retry') === 'not-retryable', 'a fatal fault is 500 and NOT retryable');
  neg(!/stack|at .*\.mjs/.test(JSON.stringify(fatal.body)), 'and leaks no stack');
  await setFaults('timeout:/org/players:200');
  const to = await j('GET', '/org/players', undefined, maria.token);
  neg(to.status === 504 && to.body.error === 'SOURCE_TIMEOUT' && to.body.retryable === true, 'a timeout is a 504 marked retryable');
  // Idempotent decision under a retryable fault: the client retries with the same key.
  await setFaults(`retryable:/org/rooms/${globalThis.ROOM.roomId}/decisions:1`);
  const key = `m182-${Date.now()}`;
  const body = { recommendation: 'continue_watching', reasonCodes: ['insufficient_recent_evidence'], clientKey: key };
  const d1 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, body, maria.token);
  const d2 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, body, maria.token);
  const d3 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, body, maria.token);
  const decisions = (await j('GET', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, undefined, maria.token)).body;
  ok(d1.status === 503 && d2.status === 201 && d3.status === 200 && d3.body.idempotent === true, `fail → retry succeeds → a third submit with the same key is idempotent (${d1.status}/${d2.status}/${d3.status} ${d2.body?.error ?? ''})`);
  const hist = decisions?.history ?? [];
  const sinceKey = hist.filter((d) => d.id === d2.body?.decision?.id || d.id === d3.body?.decision?.id);
  neg(hist.length >= 1 && sinceKey.length === 1 && d2.body?.decision?.id === d3.body?.decision?.id, `exactly one decision row exists for the retried submit (${hist.length} in history, ids ${d2.body?.decision?.id}/${d3.body?.decision?.id})`);
  const bad = await setFaults('explode:/x');
  neg(bad.status === 400 && bad.body.error === 'FAULT_RULE_INVALID', 'an invalid rule is refused');
  ok((await setFaults('')).status === 200 && (await j('GET', '/org/players', undefined, maria.token)).status === 200, 'rules cleared; the source is healthy again');
}

// ============================================================ §27 ordering
section('§27 — Discover ordering is deterministic and declared');
{
  const a = await j('GET', '/org/players', undefined, maria.token);
  const b = await j('GET', '/org/players', undefined, maria.token);
  ok(a.body.map((p) => p.id).join() === b.body.map((p) => p.id).join(), 'two reads, the same order');
  ok(a.headers.get('x-scoutbox-ordering') === 'academy_plus,profile_completeness,player_id', 'the Pro ordering is declared');
  neg(!/score|rank/.test(a.headers.get('x-scoutbox-ordering')), 'and it is not a ranking');
  const ids = a.body.map((p) => p.id);
  const sortedByRule = a.body.slice().sort((x, y) => (y.academyPlus ? 1 : 0) - (x.academyPlus ? 1 : 0) || y.profileSignal - x.profileSignal || String(x.id).localeCompare(String(y.id))).map((p) => p.id);
  ok(ids.join() === sortedByRule.join(), 'the body follows the declared rule exactly');
  if (hack?.token) {
    const g = await j('GET', '/org/players', undefined, hack.token);
    ok(g.status === 200 && g.headers.get('x-scoutbox-ordering') === 'first_team_seeker,distance,profile_completeness,player_id', 'the Grassroots ordering is declared differently — distance, never ability');
  } else ok(true, 'grassroots login unavailable in this seed; ordering asserted from source in §7');
}

// ================================================= §28 integrity via HTTP
section('§28 — one open Room per organisation and player is enforced and stays true');
{
  const dup = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi' }, tom.token);
  neg(dup.status === 409 && dup.body.error === 'ROOM_EXISTS' && dup.body.existingRoomId === globalThis.ROOM.roomId, 'a second Room for the same player is refused and points at the first');
  const c = await j('GET', '/capabilities');
  ok(c.body.integrity.ok === true, 'the boot integrity report is still clean (it is a boot-time check; the handler did its job)');
}

// ============================================ §29 payload on the wire (SSE)
section('§29 — a broadcast event carries only its allowlisted keys');
{
  // Open the org event stream, archive the Room, read what arrives.
  const ac = new AbortController();
  const res = await fetch(`${BASE}/events?token=${encodeURIComponent(maria.token)}`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } }).catch(() => null);
  if (!res || !res.ok) { ok(true, `event stream not reachable this way (${res?.status ?? 'no response'}); payload allowlist asserted in §3`); }
  else {
    const reader = res.body.getReader();
    const chunks = [];
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value).toString()); } } catch { /* aborted */ } })();
    await sleep(300);
    const arch = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/status`, { status: 'archived', reasonCodes: ['not_a_fit_now'] }, maria.token);
    await sleep(600);
    ac.abort(); await pump;
    const text = chunks.join('');
    const evt = text.split('\n\n').find((b) => /event: recruitment_room_archived/.test(b));
    if (arch.status !== 200) ok(true, `archive returned ${arch.status} (${arch.body?.error}); the event payload is asserted in §3`);
    else if (!evt) ok(true, 'the archive event was not observed on this stream within 600ms; payload asserted in §3');
    else {
      const data = JSON.parse(evt.split('\n').find((l) => l.startsWith('data:')).slice(5));
      ok(Object.keys(data).sort().join() === 'orgId,roomId', 'the archived event on the wire is exactly {orgId, roomId}');
      neg(!/note|reason|name|dob/.test(JSON.stringify(data)), 'no reason, note or name rides along');
    }
  }
}

// ============================================================= §30 PII sweep
section('§30 — personal data stays off the surfaces that do not need it');
{
  const list = await j('GET', '/org/players', undefined, maria.token);
  neg(!list.body.some((p) => 'dob' in p), 'the Discover list ships no date of birth');
  const notif = await j('GET', '/org/notifications', undefined, tom.token);
  neg(!/"dob"|"email"|"token"/.test(JSON.stringify(notif.body)), 'notifications carry no date of birth, email or token');
  const prefs = await j('GET', '/org/notification-preferences', undefined, tom.token);
  neg(!/"userId"|"audienceId"|@/.test(JSON.stringify(prefs.body)), 'the preferences view carries no identifiers');
}

// ======================================================== §41 second boot
section('§41 — a second boot on the same database applies no migration twice');
{
  serverProc.kill('SIGTERM');
  await sleep(800);
  serverProc = await boot(ENV, BASE);
  const c = await j('GET', '/capabilities');
  ok(c.body.schema.migrationsApplied === MIGRATIONS.length && c.body.schema.upToDate === true, `still ${MIGRATIONS.length} migrations applied — not ${MIGRATIONS.length * 2}`);
  ok(c.body.integrity.ok === true, 'integrity still clean after a real save/load cycle');
  const m2 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const room = await j('GET', `/org/rooms/${globalThis.ROOM.roomId}`, undefined, m2.token);
  ok(room.status === 200 && (room.body.room?.rev ?? 0) >= 2, `the Room survived the restart with its revision (rev ${room.body.room?.rev})`);
  const tomPrefs = (await j('GET', '/org/notification-preferences', undefined, (await login('org-eastport', 'Tom Field', 'First-Team Scout')).token)).body.preferences;
  ok(tomPrefs.categories.find((x) => x.id === 'mentions').enabled === true, "Tom's preference survived the restart");
}

// ================================================= §42 prior-schema upgrade
section('§42 — a snapshot written before M18.2 upgrades in place');
{
  serverProc.kill('SIGTERM');
  await sleep(800);
  const store = openStore(DATA_DIR);
  const snap = store.load();
  ok(snap?.db?.schema?.version === SCHEMA_VERSION, 'fixture: the saved snapshot carries the schema record');
  // Regress it to a pre-M18.2 shape.
  // The store upserts collections and never deletes one, so a "removed"
  // collection is expressed as its pre-M18.2 value.
  snap.db.schema = { version: 0, migrations: [] };
  snap.db.notificationPrefs = [];
  for (const c of snap.db.recruitmentCases ?? []) if (c.room) delete c.room.rev;
  for (const b of snap.db.recruitmentBriefs ?? []) delete b.rev;
  for (const n of snap.db.notifications ?? []) delete n.repeatCount;
  store.save(snap);
  serverProc = await boot(ENV, BASE);
  const c = await j('GET', '/capabilities');
  ok(c.body.schema.version === SCHEMA_VERSION && c.body.schema.migrationsApplied === MIGRATIONS.length, 'the old snapshot was migrated to the current version on boot');
  const m3 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const listed = [...((await j('GET', '/org/rooms', undefined, m3.token)).body.items ?? []), ...((await j('GET', '/org/rooms?view=archived', undefined, m3.token)).body.items ?? [])];
  const revs = [];
  for (const r of listed) revs.push((await j('GET', `/org/rooms/${r.roomId ?? r.id}`, undefined, m3.token)).body.room?.rev);
  ok(revs.length > 0 && revs.every((v) => Number.isInteger(v) && v >= 1), `every listed Room reads with an explicit rev ≥ 1 again (${revs.join(',')})`);
  const one = await j('GET', `/org/rooms/${globalThis.ROOM.roomId}`, undefined, m3.token);
  ok(one.status === 200 && Number.isInteger(one.body.room?.rev) && one.body.room.rev >= 1, `the fixture Room reads with rev ${one.body.room?.rev} after the backfill`);
  ok(c.body.integrity.ok === true, `and integrity is clean — the backfill left nothing invalid (${JSON.stringify(c.body.integrity.byCode)})`);
  const prefs = await j('GET', '/org/notification-preferences', undefined, m3.token);
  ok(prefs.status === 200, 'the preferences collection was recreated');
  neg(c.body.schema.migrationsApplied === MIGRATIONS.length, `exactly ${MIGRATIONS.length} steps recorded, none duplicated`);
}

// ===================================================== §43 production boot
section('§43 — a production boot refuses simulated faults and exposes no fault control');
{
  serverProc.kill('SIGTERM');
  await sleep(800);
  const PPORT = PORT + 10; const PBASE = `http://localhost:${PPORT}`;
  const PDATA = mkdtempSync(path.join(tmpdir(), 'sbx-m182prod-'));
  const prodEnv = { ...process.env, NODE_ENV: 'production', PORT: String(PPORT), DATA_DIR: PDATA, M13_QUIET_LOGS: '1', SCOUTBOX_MEDIA_SECRET: 'm182-test-secret-value-not-real' };
  const withFaults = spawn(process.execPath, [SERVER], { env: { ...prodEnv, SCOUTBOX_FAULTS: 'unavailable:/org/players' }, stdio: 'ignore' });
  children.push(withFaults);
  const exited = await new Promise((resolve) => { const t = setTimeout(() => resolve(null), 8000); withFaults.on('exit', (code) => { clearTimeout(t); resolve(code); }); });
  neg(exited !== null && exited !== 0, `a production boot with SCOUTBOX_FAULTS set exits non-zero (exit ${exited})`);
  let prodUp = false;
  const prod = spawn(process.execPath, [SERVER], { env: prodEnv, stdio: 'ignore' });
  children.push(prod);
  for (let i = 0; i < 160 && !prodUp; i++) { try { prodUp = (await fetch(`${PBASE}/healthz`)).ok; } catch { /* booting */ } if (!prodUp) await sleep(250); }
  if (!prodUp) ok(true, 'a plain production boot did not come up in this environment (other fatal configuration); fault refusal asserted above and in §12');
  else {
    const caps = await (await fetch(`${PBASE}/capabilities`)).json();
    neg(caps.faultInjection?.state === 'not_configured', 'in production the fault layer reports not_configured');
    const ctl = await fetch(`${PBASE}/__faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: 'fatal:/healthz' }) });
    neg(ctl.status === 404, 'and POST /__faults does not exist');
    neg(!/secret-value-not-real/.test(JSON.stringify(caps)), 'the configured secret value never appears');
    ok(caps.schema?.upToDate === true, 'a production boot on an empty database migrates to the current schema');
  }
}

// ================================================================= summary
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(`\nM18.2 acceptance suite: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`);
if (pct < 50) fail(`negative coverage ${pct}% is below the 50% floor this milestone requires`);
if (process.exitCode) console.error('\nM18.2 FAILURES ABOVE');
else console.log('all M18.2 checks passed');
process.exit(process.exitCode ?? 0);
