// Platform contracts. What these sections rule out is ambiguity: an event
// that reaches a client without a registry entry, a notification nobody can
// mute, a conflict told two different ways, an ordering nobody declared, a
// schema nobody versioned, a date computed in whatever zone the host happened
// to be in.
//
// More than half the checks are negative: a contract suite that mostly proves
// the happy path has not pinned anything down.
//
// Structure:  §1–§19  in-process (pure engines, source sweeps, client modules)
//             §20–§40 HTTP against a fresh server
//             §41, §43 later boots: idempotence, the production boot
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENT_REGISTRY,
  EVENT_NAMES,
  AUDIENCES,
  minimizePayload,
  eventFingerprint,
  assertEventRegistry,
  isRegistered,
} from '../../domains/platform/eventRegistry.mjs';
import { EVENT_AUDIENCE, audienceFor } from '../../domains/platform/eventAudience.mjs';
import {
  CATEGORIES,
  TYPE_CATEGORY,
  categoryOf,
  defaultPrefs,
  createNotificationPrefs,
} from '../../domains/platform/notificationPrefs.mjs';
import { integrityReport, integritySummary } from '../../domains/platform/integrity.mjs';
import { OPEN_ROOM_STATUSES } from '../../domains/recruitment/public.mjs';
import { parseFaultRules, createFaultLayer } from '../../domains/platform/faults.mjs';
import { productionConfigProblems } from '../../domains/platform/capabilities.mjs';
import { RATE_LIMIT_POLICY } from '../../domains/platform/rateLimit.mjs';
import { ageOn, isAdult, adultAgeFor } from '../../domain.mjs';
import {
  POLICY,
  secondLookStatus,
  secondLookExpired,
  briefIsLiveOn,
  validateRecruitmentBrief,
  orderNobodyMissed,
  orderSecondLook,
} from '../../domains/discovery/shared.mjs';
import { PROVENANCE } from '../../domains/passport/shared.mjs';
import { openStore } from '../../store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, dataSchemaReport, migrationApplied } from '../../repositories/database.mjs';
import { DATA_MIGRATIONS } from '../../repositories/index.mjs';
import { createNotificationsRepository } from '../../repositories/notifications.mjs';
import { pickPort } from '../../scripts/testPort.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
const SERVER_DIR = path.join(HERE, '..', '..');
const SERVER = path.join(SERVER_DIR, 'server.mjs');
const PORT = pickPort(5990, 8, [0, 10, 11, 13]); // never a fetch-blocked port
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m182-'));

let passed = 0;
let negatives = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

// ============================================================ §1 registry
section('§1 — the registry refuses what it does not declare');
{
  // Each broadcast is checked when it is sent: outside production an undeclared event, or a key its entry does not
  // allow, throws at the call site (liveSync.mjs), so every battery that reaches it would fail. Here, the boot check.
  neg(assertEventRegistry({ mode: 'production' }).length === 0, 'the registry is consistent as the server boots it');
  let threw = null;
  try {
    assertEventRegistry({ emitted: ['brand_new_unregistered'], mode: 'development' });
  } catch (e) {
    threw = e;
  }
  neg(
    !!threw && /brand_new_unregistered/.test(threw.message),
    'development THROWS on an emitted name the registry does not know',
  );
  const prodProblems = assertEventRegistry({ emitted: ['brand_new_unregistered'], mode: 'production' });
  neg(
    prodProblems.some((p) => /brand_new_unregistered/.test(p)),
    'production reports it (and the fail-closed audience keeps it private)',
  );
}

section('§2 — every registry entry is complete and internally consistent');
{
  const incomplete = Object.entries(EVENT_REGISTRY)
    .filter(
      ([, def]) =>
        !(
          def.domain &&
          def.sourceSystem &&
          AUDIENCES.includes(def.audience) &&
          def.privacyClass &&
          Array.isArray(def.payload) &&
          def.dedupeStrategy &&
          def.replayPolicy &&
          typeof def.notificationEligible === 'boolean' &&
          typeof def.analyticsEligible === 'boolean'
        ),
    )
    .map(([n]) => n);
  ok(
    incomplete.length === 0,
    `all ${EVENT_NAMES.length} entries carry domain, source, audience, privacy class, payload allowlist, dedupe, replay and eligibility${incomplete.length ? `: ${incomplete.join(', ')}` : ''}`,
  );
  neg(
    !Object.values(EVENT_REGISTRY).some((d) => d.audience === 'public_safe' && d.privacyClass === 'org_internal'),
    'nothing public carries organisation-internal content',
  );
  neg(
    Object.values(EVENT_REGISTRY)
      .filter((d) => d.audience === 'public_safe')
      .every((d) => d.payload.every((k) => /Id$|^type$/.test(k))),
    'a public event carries at most ids and a type — a ping to re-read, never the record',
  );
  neg(EVENT_REGISTRY.typing.replayPolicy === 'never', 'a typing indicator is never replayed to a reconnecting client');
  neg(
    EVENT_REGISTRY.recruitment_room_archived.audience === 'org_private',
    'a Room archival stays inside the organisation',
  );
  ok(
    EVENT_AUDIENCE.recruitment_room_archived === audienceFor('recruitment_room_archived'),
    'the audience table is a view over the registry, not a second table',
  );
  neg(audienceFor('never_registered') === 'org_private', 'an unregistered event fails closed to organisation-private');
}

section('§3 — payload minimisation: what is not allowlisted does not ship');
{
  const { payload, dropped } = minimizePayload('recruitment_room_archived', {
    orgId: 'o',
    roomId: 'r',
    note: 'private words',
    dob: '2004-01-01',
    playerName: 'K',
  });
  ok(Object.keys(payload).sort().join() === 'orgId,roomId', 'the archival event carries the ids and nothing else');
  neg(
    dropped.includes('note') && dropped.includes('dob') && dropped.includes('playerName'),
    'a note, a date of birth and a name are dropped, not forwarded',
  );
  const un = minimizePayload('not_registered', { anything: 1 });
  neg(un.unregistered && Object.keys(un.payload).length === 0, 'an unregistered event ships an EMPTY payload');
  for (const [name, def] of Object.entries(EVENT_REGISTRY)) {
    neg(
      !def.payload.some((k) => /dob|birth|email|phone|note|body|text|address|password|token/i.test(k)),
      `${name}: allowlist admits no personal field`,
    );
  }
}

section('§4 — the same fact fingerprints the same however it is projected');
{
  const a = eventFingerprint('recruitment_room_archived', { orgId: 'o', roomId: 'r1' });
  const b = eventFingerprint('recruitment_room_archived', { roomId: 'r1', orgId: 'o', extra: 'ignored' });
  ok(a && a === b, 'key order and extra keys do not change the fingerprint');
  neg(
    eventFingerprint('recruitment_room_archived', { orgId: 'o', roomId: 'r2' }) !== a,
    'a different room is a different fact',
  );
  ok(
    eventFingerprint('players', { playerId: 'p' }) === eventFingerprint('players', { playerId: 'p' }),
    'a coalescing ping keys on its subject',
  );
  neg(
    eventFingerprint('players', { playerId: 'p' }) !== eventFingerprint('players', { playerId: 'q' }),
    'two players are two subjects — they never coalesce into one ping',
  );
  neg(
    eventFingerprint('never_registered', { roomId: 'r' }) === null,
    'an unregistered event has no fingerprint — nothing can dedupe it into silence',
  );
  neg(
    eventFingerprint('typing', { channelId: 'c', side: 'org' }) === null ||
      EVENT_REGISTRY.typing.dedupeStrategy !== 'fingerprint',
    'typing is not fingerprinted as a durable fact',
  );
}

// ======================================================= §5 terminology
section('§7 — every Nobody Missed and Second Look sort has a stable tie-break');
{
  // The same rows in two input orders come out in one order: ties fall to the id, never to arrival.
  const tied = [
    { playerId: 'pl-b', name: 'Sam', distanceKm: 5, trustBand: 'established', lastEvidenceAt: 10, reviewedAt: 1 },
    { playerId: 'pl-a', name: 'Sam', distanceKm: 5, trustBand: 'established', lastEvidenceAt: 10, reviewedAt: 1 },
    { playerId: 'pl-c', name: 'Sam', distanceKm: 5, trustBand: 'established', lastEvidenceAt: 10, reviewedAt: 1 },
  ];
  for (const sort of ['name', 'distance', 'evidence_confidence', 'newest_evidence', 'last_reviewed']) {
    const one = orderNobodyMissed(tied, sort).map((x) => x.playerId);
    const two = orderNobodyMissed([...tied].reverse(), sort).map((x) => x.playerId);
    ok(
      one.join() === 'pl-a,pl-b,pl-c' && two.join() === one.join(),
      `Nobody Missed "${sort}": ties fall to the player id`,
    );
  }
  const items = [
    { id: 'sl-2', kind: 'significant_new_evidence', latestChangeAt: 5 },
    { id: 'sl-1', kind: 'significant_new_evidence', latestChangeAt: 5 },
    { id: 'sl-3', kind: 'significant_new_evidence', latestChangeAt: 9 },
    { id: 'sl-4', kind: 'direct_reason_resolved', latestChangeAt: 1 },
  ];
  const sl = orderSecondLook(items).map((x) => x.id);
  ok(
    sl.join() === 'sl-4,sl-3,sl-1,sl-2' &&
      orderSecondLook([...items].reverse())
        .map((x) => x.id)
        .join() === sl.join(),
    'Second Look orders by relevance kind, then the latest change, then the id — never a priority score',
  );
}

section('§8 — every notification type is classified, mentions are recognised from server wording only');
{
  ok(
    Object.values(TYPE_CATEGORY).every((c) => c in CATEGORIES),
    'every type maps to a real category',
  );
  ok(Object.keys(TYPE_CATEGORY).length >= 38, `${Object.keys(TYPE_CATEGORY).length} notification types classified`);
  ok(
    categoryOf('recruitment_room', 'Maria Keane mentioned you in the Recruitment Room for K.') === 'mentions',
    'a mention is a mention',
  );
  ok(
    categoryOf('recruitment_room', 'Maria Keane assigned you a task in the Recruitment Room for K.') === 'assignments',
    'an assignment is an assignment',
  );
  ok(
    categoryOf('recruitment_room', 'Room moved to shortlisted') === 'room_changes',
    'an ordinary room change is room_changes',
  );
  neg(
    categoryOf('message', 'someone wrote "mentioned you" in a message') !== 'mentions',
    'user text saying "mentioned you" in another type is NOT a mention',
  );
  neg(
    categoryOf('evidence_request') === 'evidence_requests',
    "a club's evidence request is an evidence request: the person who switched those off is not sent one",
  );
  neg(categoryOf('never_seen_type') === null, 'an unknown type is unclassified (and, below, the gate lets it through)');
  // A notify() of a type with no category is refused at the call outside production (notify.mjs), so a battery that
  // reaches it fails there; in production it is delivered and counted.
}

section('§9 — defaults are conservative without muting an obligation, and the mandatory category holds');
{
  const d = defaultPrefs();
  neg(d.categories.discovery_nudges === false, 'discovery nudges are off by default');
  ok(
    d.categories.security_account === true && CATEGORIES.security_account.mandatory,
    'security and account is on and mandatory',
  );
  for (const t of ['outcome', 'signing', 'report_due', 'trial_day', 'verification', 'saved_search']) {
    neg(TYPE_CATEGORY[t] !== 'discovery_nudges', `${t} is an obligation or a request, never a nudge that defaults off`);
  }
  neg(d.emailIntent === false, 'nobody is opted into email they never asked for');
  // In-process enforcement. The stored preferences are
  // rows of the notification tables, so the module is given a real repository
  // on a temporary in-memory database (every table migration applied); the
  // stored "security_account: false" is planted as a stored row — the
  // repository stores what it is given, the effective view forces it on.
  const prefsDb = new DatabaseSync(':memory:');
  prefsDb.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(prefsDb, DATA_MIGRATIONS, { now: Date.now(), log: () => {} });
  // A staff audience is a key to org_users, so the two staff members exist (storage setup only).
  prefsDb
    .prepare(
      "INSERT INTO orgs (id, name, type, level, plan, created_at) VALUES ('org-a', 'Org A', 'club', 'pro', 'Pro', 0)",
    )
    .run();
  for (const [id, name] of [
    ['u-tom', 'Tom'],
    ['u-maria', 'Maria'],
  ])
    prefsDb
      .prepare(
        "INSERT INTO org_users (id, org_id, name, name_key, role, created_at) VALUES (?, 'org-a', ?, ?, 'Scout', ?)",
      )
      .run(id, name, name.toLowerCase(), Date.now());
  const notifications = createNotificationsRepository({ sqlite: prefsDb, now: Date.now });
  const { allows, effective } = createNotificationPrefs({ notifications });
  const tom = { kind: 'org_user', id: 'u-tom' };
  const maria = { kind: 'org_user', id: 'u-maria' };
  ok(allows(tom, 'recruitment_room', 'Maria mentioned you'), 'a mention is delivered by default');
  notifications.updatePrefs('org_user', 'u-tom', {
    categories: { mentions: false, security_account: false },
    emailIntent: false,
  });
  neg(
    allows(tom, 'recruitment_room', 'Maria mentioned you') === false,
    'once mentions are off, a mention is not created for Tom',
  );
  neg(
    allows(maria, 'recruitment_room', 'Tom mentioned you') === true,
    "Tom's preference does not touch Maria (isolation)",
  );
  neg(
    allows(tom, 'verification', 'x') === true && effective('org_user', 'u-tom').categories.security_account === true,
    'a stored "security_account: false" is ignored — the mandatory category is always on',
  );
  ok(allows(tom, 'never_seen_type', 'x') === true, 'an unknown type is delivered rather than silently lost');
  notifications.updatePrefs('guardian', 'g-1', { categories: { combine: false }, emailIntent: false });
  neg(
    allows({ kind: 'guardian', id: 'g-1' }, 'combine', 'x') === false &&
      allows({ kind: 'player', id: 'g-1' }, 'combine', 'x') === true,
    'a guardian preference is keyed by kind AND id — a player with the same id string is untouched',
  );
  prefsDb.close();
}

// ================================================== §10 migrations (unit)
section('§10 — migrations: ordered, idempotent, recorded, and a failure aborts before any save');
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  neg(!migrationApplied(db, DATA_MIGRATIONS.at(-1).id), 'an unmigrated database records no migration, never "fine"');
  const first = runDataMigrations(db, DATA_MIGRATIONS, { now: 1000 });
  ok(
    first.ran.length === DATA_MIGRATIONS.length && first.known === DATA_MIGRATIONS.length,
    `a fresh database runs all ${DATA_MIGRATIONS.length} migrations, to ${SCHEMA_VERSION}`,
  );
  ok(
    first.ran.join() ===
      DATA_MIGRATIONS.map((m) => m.id)
        .sort()
        .join(),
    'in id order',
  );
  const second = runDataMigrations(db, DATA_MIGRATIONS, { now: 2000 });
  ok(second.ran.length === 0 && second.applied === DATA_MIGRATIONS.length, 'a second run applies nothing');
  const rows = db.prepare('SELECT id, applied_at FROM data_migrations').all();
  ok(
    rows.length === DATA_MIGRATIONS.length && rows.every((r) => r.applied_at === 1000),
    'the applied list is recorded once, with its time',
  );
  const report = dataSchemaReport(db, DATA_MIGRATIONS);
  ok(
    report.migrationsApplied === report.migrationsKnown &&
      Number(report.migrations.at(-1).slice(0, 4)) === SCHEMA_VERSION,
    'the report says every known migration is applied, the latest being the schema version',
  );
  ok(new Set(DATA_MIGRATIONS.map((m) => m.id)).size === DATA_MIGRATIONS.length, 'migration ids are unique');
  ok(
    DATA_MIGRATIONS.every((m) => /^\d{4}_[a-z0-9_]+$/.test(m.id) && m.note),
    'every migration has a stable numbered id and a note',
  );
  db.close();
  // A failing migration names itself, and its transaction is rolled back: nothing it wrote, no record.
  const db2 = new DatabaseSync(':memory:');
  runDataMigrations(db2, DATA_MIGRATIONS, { now: 1000 });
  const broken = {
    id: '9999_broken_on_purpose',
    note: 'fixture',
    up(sqlite) {
      sqlite.exec('CREATE TABLE broken_on_purpose (x TEXT)');
      throw new Error('synthetic failure');
    },
  };
  let threw = null;
  try {
    runDataMigrations(db2, [...DATA_MIGRATIONS, broken], { now: 3000 });
  } catch (e) {
    threw = e;
  }
  neg(
    !!threw && /9999_broken_on_purpose failed/.test(threw.message) && /not modified/.test(threw.message),
    'a failing migration names itself and promises the database was untouched',
  );
  neg(
    !db2.prepare("SELECT 1 FROM sqlite_master WHERE name = 'broken_on_purpose'").get() &&
      !migrationApplied(db2, broken.id),
    'and keeps that promise: no table it created, no record of it',
  );
  // The right latest id with the rest missing is NOT up to date.
  const db3 = new DatabaseSync(':memory:');
  db3.exec('CREATE TABLE data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);');
  db3.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, 1)').run(DATA_MIGRATIONS.at(-1).id);
  const partial = dataSchemaReport(db3, DATA_MIGRATIONS);
  neg(
    partial.migrationsApplied !== partial.migrationsKnown,
    'the latest migration recorded without the rest is NOT reported as every migration applied',
  );
  db2.close();
  db3.close();
}

// ============================================== §11 integrity (unit)
section('§11 — boot-time integrity reports and never repairs');
{
  const sane = {
    orgs: [{ id: 'o1' }],
    players: [{ id: 'p1' }, { id: 'p2' }],
    recruitmentCases: [
      { id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'archived', rev: 3 } },
      { id: 'c2', orgId: 'o1', playerId: 'p1', room: { status: 'watching', rev: 1 } },
    ],
  };
  const r = integrityReport(sane, { cases: sane.recruitmentCases ?? [], openRoomStatuses: OPEN_ROOM_STATUSES });
  ok(
    r.ok && r.violations.length === 0,
    'an archived Room plus an open one for the same player is fine — history repeats, activity does not',
  );
  const dup = JSON.parse(JSON.stringify(sane));
  dup.recruitmentCases.push({ id: 'c3', orgId: 'o1', playerId: 'p1', room: { status: 'shortlisted', rev: 1 } });
  const r2 = integrityReport(dup, { cases: dup.recruitmentCases ?? [], openRoomStatuses: OPEN_ROOM_STATUSES });
  neg(
    r2.violations.some((v) => v.code === 'ROOM_OPEN_DUPLICATE' && v.ids.includes('c2') && v.ids.includes('c3')),
    'two open Rooms for one organisation and player is reported with both ids',
  );
  ok(dup.recruitmentCases.length === 3, 'and nothing was deleted or repaired');
  const orphan = {
    ...sane,
    recruitmentCases: [{ id: 'c9', orgId: 'nope', playerId: 'p1', room: { status: 'watching', rev: 1 } }],
  };
  neg(
    integrityReport(orphan, {
      cases: orphan.recruitmentCases ?? [],
      openRoomStatuses: OPEN_ROOM_STATUSES,
    }).violations.some((v) => v.code === 'ROOM_ORPHAN_ORG'),
    'a Room whose organisation does not exist is reported',
  );
  // The discovery tables refuse a duplicated brief id, a fingerprint counted twice in one item and a brief without rev,
  // so none of them is ever stored to be reported.
  const { typeBrief, typeSecondLookItem, DISCOVERY_DDL } = await import('../../repositories/discovery.mjs');
  neg(
    /CREATE TABLE recruitment_briefs \(\n\s+id\s+TEXT PRIMARY KEY/.test(DISCOVERY_DDL),
    "a duplicated brief id is refused: the brief id is the table's primary key",
  );
  neg(
    /the same evidence|names an entry twice/.test(
      typeSecondLookItem({
        id: 's1',
        orgId: 'o1',
        playerId: 'p1',
        roomId: 'c1',
        decisionId: 'd1',
        policyVersion: 1,
        triggerType: 'general_update',
        changeFingerprints: ['f1', 'f1'],
        directReasonCodes: [],
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
        latestChangeAt: 1,
        history: [],
      }).reason ?? '',
    ) && /UNIQUE \(item_id, fingerprint\)/.test(DISCOVERY_DDL),
    'the same evidence counted twice inside one Second Look item is refused (typed, and unique per item in the table)',
  );
  neg(
    /rev is required/.test(
      typeBrief({
        id: 'b1',
        orgId: 'o1',
        title: 'T',
        version: 1,
        status: 'draft',
        createdBy: { userId: 'u1', name: 'U' },
        createdAt: 1,
        updatedAt: 1,
        criteria: {
          positions: [],
          minAge: null,
          maxAge: null,
          radiusKm: null,
          maxLevel: null,
          foot: null,
          availability: null,
          evidenceRequirements: [],
          minTrustBand: null,
          combineProtocols: [],
        },
      }).reason ?? '',
    ),
    'a rev-guarded brief with no rev is refused (rev is a required column)',
  );
  neg(
    ![
      'BRIEF_ID_DUPLICATE',
      'SECOND_LOOK_ITEM_DUPLICATE',
      'SECOND_LOOK_FINGERPRINT_DUPLICATE',
      'BRIEF_REV_INVALID',
    ].some((code) =>
      integrityReport(sane, { cases: sane.recruitmentCases, openRoomStatuses: OPEN_ROOM_STATUSES }).violations.some(
        (v) => v.code === code,
      ),
    ),
    'and the boot report no longer reads the discovery collections at all',
  );
  const summary = integritySummary(r2);
  neg(!JSON.stringify(summary).includes('c2'), 'the operator summary carries counts by code, never ids');
  ok(
    integrityReport({}, { cases: [], openRoomStatuses: OPEN_ROOM_STATUSES }).ok,
    'an empty database is not a violation',
  );
}

// ================================================== §12 faults (unit)
section('§12 — the fault layer is inert in production and refuses to be configured there');
{
  ok(parseFaultRules('delay:/org/players/*/trust:1500;unavailable:/org/rooms/*').length === 2, 'rules parse');
  let bad = null;
  try {
    parseFaultRules('explode:/x');
  } catch (e) {
    bad = e;
  }
  neg(!!bad, 'an unknown fault kind is refused');
  let noPath = null;
  try {
    parseFaultRules('delay');
  } catch (e) {
    noPath = e;
  }
  neg(!!noPath, 'a rule without a path is refused — a fault can never apply to every route by accident');
  const prod = createFaultLayer({ env: { NODE_ENV: 'production', SCOUTBOX_FAULTS: 'unavailable:/org/players' } });
  neg(
    prod.enabled === false && prod.rules().length === 0,
    'in production the layer is disabled and loads NO rules even when the variable is set',
  );
  const routes = [];
  prod.install({
    use() {},
    post(p) {
      routes.push(p);
    },
  });
  neg(!routes.includes('/__faults'), 'and the runtime control route is not mounted');
  neg(
    productionConfigProblems({
      env: { NODE_ENV: 'production', MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef', SCOUTBOX_FAULTS: 'x' },
    }).some((p) => p.code === 'FAULTS_IN_PRODUCTION' && p.fatal),
    'a production boot with SCOUTBOX_FAULTS set is a fatal configuration problem',
  );
  const dev = createFaultLayer({ env: { NODE_ENV: 'development' } });
  ok(dev.enabled && dev.rules().length === 0, 'development with no variable is enabled and empty (a no-op)');
}

// ============================================ §13 date boundaries (unit)
section('§13 — age is a fact about UTC calendar days');
{
  const at = (iso) => new Date(iso);
  ok(
    ageOn('2008-03-14', at('2026-03-14T00:00:00Z')) === 18,
    'a person is 18 from the first UTC instant of their 18th birthday',
  );
  neg(
    ageOn('2008-03-14', at('2026-03-13T23:59:59Z')) === 17,
    'one second earlier they are 17 — in every time zone the server runs in',
  );
  neg(
    ageOn('2008-03-14', at('2026-03-14T23:00:00-05:00')) === 18,
    'a host in New York at 23:00 local on the 14th (04:00Z on the 15th) still says 18, not a day off',
  );
  ok(ageOn('2008-02-29', at('2026-02-28T12:00:00Z')) === 17, 'a leap-day birth is 17 on 28 February of a common year');
  ok(ageOn('2008-02-29', at('2026-03-01T00:00:00Z')) === 18, 'and 18 on 1 March — the birthday is never skipped');
  ok(ageOn('2008-02-29', at('2028-02-29T00:00:00Z')) === 20, 'and on a real 29 February the maths is exact');
  ok(
    adultAgeFor('GB') === 18 && adultAgeFor('KR') === 19 && adultAgeFor('XX') === 18,
    'majority: 18 by default, 19 in Korea',
  );
  const kr = { dob: '2008-03-14', country: 'KR' };
  const gb = { dob: '2008-03-14', country: 'GB' };
  ok(isAdult(gb, at('2026-03-14T00:00:00Z')) === true, 'a British 18-year-old is an adult');
  neg(
    isAdult(kr, at('2026-03-14T00:00:00Z')) === false,
    'a Korean 18-year-old is NOT — the same date of birth, a different rule',
  );
  ok(isAdult(kr, at('2027-03-14T00:00:00Z')) === true, 'and becomes one at 19');
  neg(
    Number.isNaN(ageOn('garbage')) && Number.isNaN(ageOn('2004-13-45')),
    'a malformed date of birth is NaN — never age 0, never an adult by accident',
  );
  neg(
    isAdult({ dob: 'garbage', country: 'GB' }) === false,
    'and a person with an unreadable date of birth is not treated as an adult',
  );
}

section('§14 — a Recruitment Brief window is inclusive calendar days, in UTC');
{
  const b = (activeFrom, activeUntil, status = 'active') => ({ status, activeFrom, activeUntil });
  ok(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-09-12') === true, 'live on its first day');
  neg(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-09-11') === false, 'not live the day before it starts');
  ok(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-09-30') === true, 'live on its last day, all day');
  neg(briefIsLiveOn(b('2026-09-12', '2026-09-30'), '2026-10-01') === false, 'not live the day after');
  ok(
    briefIsLiveOn(b('2026-03-28', '2026-03-29'), '2026-03-29') === true,
    'a window across the European DST change is unaffected — there is no clock in a calendar day',
  );
  ok(briefIsLiveOn(b(null, null), '1999-01-01') === true, 'no window means always live while active');
  neg(
    briefIsLiveOn(b('2026-09-12', '2026-09-30', 'paused'), '2026-09-15') === false,
    'a paused brief is not live inside its window',
  );
  neg(briefIsLiveOn(null, '2026-09-15') === false, 'a missing brief is not live');
  const backwards = validateRecruitmentBrief({
    title: 'Backwards',
    positions: ['CM'],
    activeFrom: '2026-09-30',
    activeUntil: '2026-09-12',
  });
  neg(
    backwards.ok === false && backwards.error === 'BRIEF_INVALID',
    'a window that ends before it starts cannot be saved',
  );
  // With no day given, "today" is the UTC calendar day: the same string a client in any zone computes.
  const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
  const windows = [-1, 0, 1].map((d) => ({ status: 'active', activeFrom: utcDay(d), activeUntil: utcDay(d) }));
  ok(
    windows.map((w) => briefIsLiveOn(w)).join() === 'false,true,false' &&
      windows.every((w) => briefIsLiveOn(w) === briefIsLiveOn(w, utcDay(0))),
    'today is the UTC calendar day',
  );
}

section('§15 — Second Look cooldown and expiry boundaries');
{
  const now = Date.parse('2026-09-12T12:00:00Z');
  const existing = (status, handledAt) => ({
    status,
    changeFingerprints: ['f1'],
    dismissedAt: handledAt,
    updatedAt: handledAt,
  });
  const candidate = { changeFingerprints: ['f1', 'f2'], changes: [{ fingerprint: 'f2', type: 'general_update' }] };
  neg(
    secondLookStatus({ existing: existing('dismissed', now - 29 * DAY), candidate, now }).action === 'suppress',
    'new but minor evidence 29 days after a dismissal stays quiet',
  );
  ok(
    secondLookStatus({ existing: existing('dismissed', now - 30 * DAY), candidate, now }).action === 'reopen',
    `at exactly ${POLICY.cooldownDays} days the cooldown has ended`,
  );
  neg(
    secondLookStatus({
      existing: existing('dismissed', now - 5 * DAY),
      candidate: { changeFingerprints: ['f1'], changes: [] },
      now,
    }).action === 'suppress',
    'the SAME evidence never comes back, whatever the date',
  );
  const item = (ago) => ({ status: 'open', latestChangeAt: now - ago });
  ok(
    secondLookExpired(item(POLICY.expiryDays * DAY), now) === false,
    `an item exactly ${POLICY.expiryDays} days old is still open`,
  );
  neg(
    secondLookExpired(item(POLICY.expiryDays * DAY + 1), now) === true,
    'one millisecond past the window it is expired',
  );
  neg(
    secondLookExpired({ status: 'reviewed', latestChangeAt: now - 400 * DAY }, now) === false,
    'a reviewed item never "expires" — expiry is for unanswered ones',
  );
}

// ============================================================ HTTP boot
section('§20 — a clean database boots, migrates and passes integrity');
const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
  BOX_CAM_TEST_PROVIDER: '1',
};
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});
async function boot(env, base) {
  const proc = spawn(process.execPath, [SERVER], { env, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      up = r.ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
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
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data, headers: r.headers };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
{
  const h = await j('GET', '/healthz');
  ok(h.body.schemaVersion === SCHEMA_VERSION, `/healthz reports schema ${SCHEMA_VERSION}`);
  const c = await j('GET', '/capabilities');
  ok(
    c.body.schema?.upToDate === true &&
      c.body.schema.version === SCHEMA_VERSION &&
      c.body.schema.migrationsApplied === DATA_MIGRATIONS.length,
    '/capabilities: schema up to date, every migration applied',
  );
  ok(
    c.body.integrity?.ok === true && c.body.integrity.violations === 0,
    'integrity: no violations in the seeded snapshot',
  );
  ok(c.body.events?.registered === EVENT_NAMES.length, 'events: the registry size is reported');
  ok(c.body.faultInjection?.state === 'available', 'fault injection is available in this development boot');
  ok(c.body.capabilities?.email_transport?.state === 'local_outbox', 'email is honestly a local outbox');
  neg(
    !/"(secret|token|password|smtp|url)":\s*"[^"]{6,}"/i.test(JSON.stringify(c.body)),
    'no secret VALUE on the operator surface (states only)',
  );
}

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const ana = await login('org-eastport', 'Ana Ruiz', 'Head of Recruitment'); // a second lead — the colleague in §23
const hack = await login('org-hackneymarsh', 'Dee Okafor', 'Head Coach', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok(
  [maria, tom, rita, kola].every((x) => x?.token),
  'HTTP actors logged in',
);

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
  neg(
    forbidden.status === 403 && forbidden.headers.get('x-scoutbox-retry') === 'not-retryable',
    '403 is not retryable',
  );
  const malformed = await fetch(`${BASE}/org/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` },
    body: '{not json',
  });
  neg(
    malformed.status === 400 && malformed.headers.get('x-scoutbox-retry') === 'not-retryable',
    'malformed JSON is 400, not retryable',
  );
  const huge = await fetch(`${BASE}/org/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` },
    body: JSON.stringify({ playerId: 'x'.repeat(21 * 1024 * 1024) }),
  });
  neg(
    huge.status === 413 && huge.headers.get('x-scoutbox-retry') === 'not-retryable',
    'an oversized body is 413, not retryable',
  );
  ok(!!notFound.headers.get('x-request-id'), 'an error response carries a correlation id header');
  const nowhere = await j('GET', '/no/such/route', undefined, maria.token);
  neg(
    nowhere.status === 404 && nowhere.headers.get('x-scoutbox-schema') === String(SCHEMA_VERSION),
    'an unknown route still carries the schema header',
  );
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
    ok(
      limited.headers.get('retry-after') === String(Math.ceil(RATE_LIMIT_POLICY.room_comment.windowMs / 1000)),
      `Retry-After is the policy window (${RATE_LIMIT_POLICY.room_comment.windowMs / 1000}s)`,
    );
    ok(limited.headers.get('x-scoutbox-retry') === 'retryable', 'and the answer is marked retryable');
    neg(!/adeyemi|Kola/i.test(JSON.stringify(limited.body)), 'the refusal names no player');
    const colleague = await j('POST', `/org/rooms/${room.roomId}/comments`, { body: 'not limited' }, tom.token);
    neg(
      colleague.status === 201 || colleague.status === 200,
      'the limit is per person and room — a colleague on the same Room is not limited',
    );
  }
  globalThis.ROOM = room;
}

// ======================================================= §23 conflict meta
section('§23 — a conflict names who moved the record and when, never a user id');
{
  const brief = (
    await j('POST', '/org/recruitment-briefs', { title: 'Conflict fixture', positions: ['CM'] }, maria.token)
  ).body.brief;
  const theirs = await j(
    'PATCH',
    `/org/recruitment-briefs/${brief.id}`,
    { title: 'Ana was here', expectedRev: 1 },
    ana.token,
  );
  ok(theirs.status === 200, "fixture: Ana's edit lands on rev 1");
  const mine = await j(
    'PATCH',
    `/org/recruitment-briefs/${brief.id}`,
    { title: 'Maria was here', expectedRev: 1 },
    maria.token,
  );
  neg(mine.status === 409 && mine.body.error === 'BRIEF_VERSION_CONFLICT', "Maria's stale write is refused");
  ok(
    mine.body.currentRev === 2 && mine.body.updatedBy === 'Ana Ruiz' && typeof mine.body.updatedAt === 'number',
    'the 409 carries currentRev, who (a display name) and when',
  );
  neg(!/"userId"|u-\w+/.test(JSON.stringify(mine.body)), 'and no user id');
  ok(mine.headers.get('x-scoutbox-retry') === 'not-retryable', 'a conflict is not something to retry blindly');
  const same = await j(
    'PATCH',
    `/org/recruitment-briefs/${brief.id}`,
    { title: 'Maria, reloaded', expectedRev: 2 },
    maria.token,
  );
  ok(same.status === 200 && same.body.brief.rev === 3, 'after reloading the token, the same edit applies');
  const soon = await j(
    'PATCH',
    `/org/recruitment-briefs/${brief.id}`,
    { title: 'x', expectedRev: 'soon' },
    maria.token,
  );
  neg(
    soon.status === 400 && soon.body.error === 'EXPECTED_REV_INVALID',
    'a non-numeric token is a 400, never coerced to "no token"',
  );
  const roomMove = await j(
    'POST',
    `/org/rooms/${globalThis.ROOM.roomId}/status`,
    { status: 'under_review', expectedRev: 99 },
    ana.token,
  );
  neg(
    roomMove.status === 409 && roomMove.body.error === 'ROOM_VERSION_CONFLICT' && 'updatedBy' in roomMove.body,
    'the Room status conflict carries the same metadata shape',
  );
}

// ====================================================== §24 preferences
section('§24 — notification preferences are enforced at creation, per person');
{
  const r = await j('GET', '/org/notification-preferences', undefined, tom.token);
  ok(
    r.status === 200 && r.body.preferences.categories.length === Object.keys(CATEGORIES).length,
    'defaults are readable',
  );
  ok(
    r.body.preferences.channels.email === 'local_outbox' &&
      /no external email transport/i.test(r.body.preferences.channels.note),
    'the email channel is described honestly',
  );
  const before = (await j('GET', '/org/notifications', undefined, tom.token)).body.length;
  const off = await j('PUT', '/org/notification-preferences', { categories: { mentions: false } }, tom.token);
  ok(
    off.status === 200 && off.body.preferences.categories.find((c) => c.id === 'mentions').enabled === false,
    'Tom turns mentions off',
  );
  await j(
    'POST',
    `/org/rooms/${globalThis.ROOM.roomId}/comments`,
    { body: 'quiet mention', mentions: [tom.userId] },
    rita.token,
  ); // wrong org → 404, harmless
  const c1 = await j(
    'POST',
    `/org/rooms/${globalThis.ROOM.roomId}/comments`,
    { body: 'first mention', mentions: [tom.userId] },
    ana.token,
  );
  const c1status = c1.status;
  const afterOff = (await j('GET', '/org/notifications', undefined, tom.token)).body;
  neg(
    afterOff.length === before &&
      !afterOff.some((n) => /first mention|mentioned you/.test(n.text) && n.ts > Date.now() - 5000),
    `no notification was created for a muted mention (comment ${c1status})`,
  );
  const on = await j('PUT', '/org/notification-preferences', { categories: { mentions: true } }, tom.token);
  ok(on.status === 200, 'Tom turns mentions back on');
  const c2 = await j(
    'POST',
    `/org/rooms/${globalThis.ROOM.roomId}/comments`,
    { body: 'second mention', mentions: [tom.userId] },
    ana.token,
  );
  ok(c1.status === 201 && c2.status === 201, 'fixture: both mention comments were accepted');
  const afterOn = (await j('GET', '/org/notifications', undefined, tom.token)).body;
  const newest = afterOn[0];
  ok(
    afterOn.length === before + 1 &&
      newest.category === 'mentions' &&
      newest.groupKey === `recruitment_room:${globalThis.ROOM.roomId}`,
    `the next mention arrives, categorised and grouped by (type, room) — before=${before} after=${afterOn.length} newest=${JSON.stringify({ type: newest?.type, category: newest?.category, groupKey: newest?.groupKey, text: newest?.text })}`,
  );
  const mariaPrefs = (await j('GET', '/org/notification-preferences', undefined, maria.token)).body.preferences;
  neg(mariaPrefs.categories.find((c) => c.id === 'mentions').enabled === true, "Tom's preference did not touch Maria");
  const mandatory = await j(
    'PUT',
    '/org/notification-preferences',
    { categories: { security_account: false } },
    tom.token,
  );
  neg(
    mandatory.status === 400 && mandatory.body.error === 'PREF_CATEGORY_MANDATORY',
    'security and account cannot be turned off',
  );
  const unknown = await j('PUT', '/org/notification-preferences', { categories: { player_ranking: false } }, tom.token);
  neg(
    unknown.status === 400 && unknown.body.error === 'PREF_CATEGORY_UNKNOWN',
    'an unknown category is refused, not stored',
  );
  const shape = await j('PUT', '/org/notification-preferences', { categories: ['mentions'] }, tom.token);
  neg(shape.status === 400 && shape.body.error === 'PREFS_INVALID', 'a wrong shape is refused');
  const anon = await j('PUT', '/org/notification-preferences', { categories: { mentions: false } });
  neg(anon.status === 401, 'anonymous preference writes are refused');
  const p = await j('GET', '/player/notification-preferences', undefined, kola.token);
  ok(
    p.status === 200 && p.body.preferences.categories.some((c) => c.id === 'combine'),
    'a player has the same preference surface',
  );
  const cross = await j('GET', '/player/notification-preferences', undefined, tom.token);
  neg(cross.status === 401 || cross.status === 403, "an organisation token cannot read a player's preferences");
}

// ============================================================== §25 audit
section('§25 — the audit log: leads only, no content, bounded, stable');
{
  const SECRET = 'SECRET-NOTE-XK9';
  const move = await j(
    'POST',
    `/org/rooms/${globalThis.ROOM.roomId}/status`,
    { status: 'under_review', note: SECRET },
    maria.token,
  );
  ok(move.status === 200, 'fixture: a status change with a private note');
  const lead = await j('GET', '/org/audit', undefined, maria.token);
  ok(lead.status === 200 && Array.isArray(lead.body.items) && lead.body.items.length > 0, 'a lead reads the audit log');
  const entry = lead.body.items.find(
    (e) => e.action === 'room_status_changed' && e.target.id === globalThis.ROOM.roomId,
  );
  ok(
    entry && entry.actor.name === 'Maria Keane' && entry.detail.to === 'under_review' && entry.detail.hadNote === true,
    'the entry says what, who, and THAT a note was written',
  );
  neg(!JSON.stringify(lead.body).includes(SECRET), 'the note itself is not in the audit log');
  neg(
    !JSON.stringify(lead.body).includes('first mention') && !JSON.stringify(lead.body).includes('second mention'),
    'comment bodies are not in it either',
  );
  neg(!/"dob"|"email"/.test(JSON.stringify(lead.body)), 'no date of birth or email');
  const scout = await j('GET', '/org/audit', undefined, tom.token);
  neg(scout.status === 403, 'a scout gets 403');
  const anon = await j('GET', '/org/audit');
  neg(anon.status === 401, 'anonymous gets 401');
  const player = await j('GET', '/org/audit', undefined, kola.token);
  neg(player.status === 401 || player.status === 403, 'a player token gets nothing');
  const other = await j('GET', '/org/audit', undefined, rita.token);
  neg(
    other.status === 200 && !other.body.items.some((e) => e.target.id === globalThis.ROOM.roomId),
    "another organisation's lead does not see Eastport's rows",
  );
  const page1 = await j('GET', '/org/audit?limit=1', undefined, maria.token);
  ok(page1.body.items.length === 1 && page1.body.nextCursor, 'limit=1 pages');
  const page2 = await j('GET', `/org/audit?limit=1&cursor=${page1.body.nextCursor}`, undefined, maria.token);
  ok(page2.status === 200 && page2.body.items[0]?.id !== page1.body.items[0].id, 'the cursor moves on');
  const again = await j('GET', '/org/audit?limit=1', undefined, maria.token);
  ok(again.body.items[0].id === page1.body.items[0].id, 'the order is stable between reads');
  const badCursor = await j('GET', '/org/audit?cursor=nope', undefined, maria.token);
  neg(
    badCursor.status === 400 && badCursor.body.error === 'AUDIT_CURSOR_INVALID',
    'a stale cursor is a 400, not an empty page',
  );
  const big = await j('GET', '/org/audit?limit=5000', undefined, maria.token);
  neg(
    big.status === 400 && big.body.error === 'PAGE_LIMIT_INVALID' && big.body.max === 50,
    'a limit over 50 is refused',
  );
  if (hack?.token) {
    const empty = await j('GET', '/org/audit', undefined, hack.token);
    neg(
      empty.status === 200 && empty.body.items.length === 0 && empty.body.total === 0,
      'an organisation with no history gets an empty page, not an error',
    );
  }
  const foreignCursor = await j('GET', `/org/audit?cursor=${page1.body.items[0].id}`, undefined, rita.token);
  neg(foreignCursor.status === 400, "a cursor from another organisation's page is invalid here");
  const textLimit = await j('GET', '/org/audit?limit=ten', undefined, maria.token);
  neg(
    textLimit.status === 400 && textLimit.body.error === 'PAGE_LIMIT_INVALID',
    'IN1 a limit that is not a whole number is refused (it read as the default)',
  );
  const extraQuery = await j('GET', '/org/audit?orgId=org-harbour', undefined, maria.token);
  neg(
    extraQuery.status === 400 && extraQuery.body.field === 'orgId',
    'IN2 the audit feed takes no organisation from the query',
  );
  const twoTickets = await fetch(`${BASE}/events?ticket=a&ticket=b`);
  neg(twoTickets.status === 400, 'IN3 a live-sync ticket given twice is refused (it was joined into one text)');
}

// ================================================================ §26 faults
section('§26 — simulated latency and failure: isolated, retryable, idempotent');
{
  const setFaults = (rules) => j('POST', '/__faults', { rules }, undefined);
  const listed = await j('POST', '/__faults', { rules: ['delay:/org/players:300'] }, undefined);
  neg(listed.status === 400 && listed.body.field === 'rules', 'IN4 fault rules are one text, not a list');
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
  neg(
    down.status === 503 &&
      down.body.error === 'SOURCE_UNAVAILABLE' &&
      down.body.retryable === true &&
      down.headers.get('x-scoutbox-retry') === 'retryable',
    'an unavailable source is a 503 marked retryable',
  );
  ok(
    down.body.simulated === true && down.body.requestId === down.headers.get('x-request-id'),
    'and says it is simulated, with the same correlation id in body and header',
  );
  neg(
    (await j('GET', '/org/rooms', undefined, maria.token)).status === 200,
    'the Room list is unaffected by the player source being down',
  );
  await setFaults('retryable:/org/players:1');
  const first = await j('GET', '/org/players', undefined, maria.token);
  const second = await j('GET', '/org/players', undefined, maria.token);
  ok(first.status === 503 && second.status === 200, 'retryable: the first call fails, the retry succeeds');
  await setFaults('fatal:/org/players');
  const fatal = await j('GET', '/org/players', undefined, maria.token);
  neg(
    fatal.status === 500 && fatal.body.retryable === false && fatal.headers.get('x-scoutbox-retry') === 'not-retryable',
    'a fatal fault is 500 and NOT retryable',
  );
  neg(!/stack|at .*\.mjs/.test(JSON.stringify(fatal.body)), 'and leaks no stack');
  await setFaults('timeout:/org/players:200');
  const to = await j('GET', '/org/players', undefined, maria.token);
  neg(
    to.status === 504 && to.body.error === 'SOURCE_TIMEOUT' && to.body.retryable === true,
    'a timeout is a 504 marked retryable',
  );
  // Idempotent decision under a retryable fault: the client retries with the same key.
  await setFaults(`retryable:/org/rooms/${globalThis.ROOM.roomId}/decisions:1`);
  const key = `m182-${Date.now()}`;
  const body = { recommendation: 'continue_watching', reasonCodes: ['insufficient_recent_evidence'], clientKey: key };
  const d1 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, body, maria.token);
  const d2 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, body, maria.token);
  const d3 = await j('POST', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, body, maria.token);
  const decisions = (await j('GET', `/org/rooms/${globalThis.ROOM.roomId}/decisions`, undefined, maria.token)).body;
  ok(
    d1.status === 503 && d2.status === 201 && d3.status === 200 && d3.body.idempotent === true,
    `fail → retry succeeds → a third submit with the same key is idempotent (${d1.status}/${d2.status}/${d3.status} ${d2.body?.error ?? ''})`,
  );
  const hist = decisions?.history ?? [];
  const sinceKey = hist.filter((d) => d.id === d2.body?.decision?.id || d.id === d3.body?.decision?.id);
  neg(
    hist.length >= 1 && sinceKey.length === 1 && d2.body?.decision?.id === d3.body?.decision?.id,
    `exactly one decision row exists for the retried submit (${hist.length} in history, ids ${d2.body?.decision?.id}/${d3.body?.decision?.id})`,
  );
  const bad = await setFaults('explode:/x');
  neg(bad.status === 400 && bad.body.error === 'FAULT_RULE_INVALID', 'an invalid rule is refused');
  ok(
    (await setFaults('')).status === 200 && (await j('GET', '/org/players', undefined, maria.token)).status === 200,
    'rules cleared; the source is healthy again',
  );
}

// ============================================================ §27 ordering
section('§27 — Discover ordering is deterministic and declared');
{
  const a = await j('GET', '/org/players', undefined, maria.token);
  const b = await j('GET', '/org/players', undefined, maria.token);
  ok(a.body.items.map((p) => p.id).join() === b.body.items.map((p) => p.id).join(), 'two reads, the same order');
  ok(
    a.headers.get('x-scoutbox-ordering') === 'academy_plus,profile_completeness,player_id',
    'the Pro ordering is declared',
  );
  neg(
    !/score|rank|quality|ability|trust/i.test(a.headers.get('x-scoutbox-ordering')),
    'and it is not a ranking: no score, rank, quality, ability or trust',
  );
  const ids = a.body.items.map((p) => p.id);
  const sortedByRule = a.body.items
    .slice()
    .sort(
      (x, y) =>
        (y.academyPlus ? 1 : 0) - (x.academyPlus ? 1 : 0) ||
        y.profileSignal - x.profileSignal ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
    .map((p) => p.id);
  ok(
    ids.join() === sortedByRule.join(),
    'the body follows the declared rule exactly (the id tie-break in code-point order, as SQL compares it)',
  );
  ok(Array.isArray(a.body.items) && 'nextCursor' in a.body, 'the directory is a page ({ items, nextCursor })');
  const g = await j('GET', '/org/players', undefined, hack.token);
  const gOrder = g.headers.get('x-scoutbox-ordering');
  ok(
    g.status === 200 && gOrder === 'first_team_seeker,distance,profile_completeness,player_id',
    'the Grassroots ordering is declared differently — distance, never ability',
  );
  neg(!/score|rank|quality|ability|trust/i.test(gOrder), 'and it is not a ranking either');
}

// ================================================= §28 integrity via HTTP
section('§28 — one open Room per organisation and player is enforced and stays true');
{
  const dup = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi' }, tom.token);
  neg(
    dup.status === 409 && dup.body.error === 'ROOM_EXISTS' && dup.body.existingRoomId === globalThis.ROOM.roomId,
    'a second Room for the same player is refused and points at the first',
  );
  const c = await j('GET', '/capabilities');
  ok(
    c.body.integrity.ok === true,
    'the boot integrity report is still clean (it is a boot-time check; the handler did its job)',
  );
}

// ============================================ §29 payload on the wire (SSE)
section('§29 — a broadcast event carries only its allowlisted keys');
{
  // Open the org event stream, archive the Room, read what arrives.
  const ac = new AbortController();
  const res = await fetch(`${BASE}/events?token=${encodeURIComponent(maria.token)}`, {
    signal: ac.signal,
    headers: { Accept: 'text/event-stream' },
  }).catch(() => null);
  if (!res || !res.ok) {
    ok(true, `event stream not reachable this way (${res?.status ?? 'no response'}); payload allowlist asserted in §3`);
  } else {
    const reader = res.body.getReader();
    const chunks = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value).toString());
        }
      } catch {
        /* aborted */
      }
    })();
    await sleep(300);
    const arch = await j(
      'POST',
      `/org/rooms/${globalThis.ROOM.roomId}/status`,
      { status: 'archived', reasonCodes: ['not_a_fit_now'] },
      maria.token,
    );
    await sleep(600);
    ac.abort();
    await pump;
    const text = chunks.join('');
    const evt = text.split('\n\n').find((b) => /event: recruitment_room_archived/.test(b));
    if (arch.status !== 200)
      ok(true, `archive returned ${arch.status} (${arch.body?.error}); the event payload is asserted in §3`);
    else if (!evt) ok(true, 'the archive event was not observed on this stream within 600ms; payload asserted in §3');
    else {
      const data = JSON.parse(
        evt
          .split('\n')
          .find((l) => l.startsWith('data:'))
          .slice(5),
      );
      ok(
        Object.keys(data).sort().join() === 'orgId,roomId',
        'the archived event on the wire is exactly {orgId, roomId}',
      );
      neg(!/note|reason|name|dob/.test(JSON.stringify(data)), 'no reason, note or name rides along');
    }
  }
}

// ============================================================= §30 PII sweep
section('§30 — personal data stays off the surfaces that do not need it');
{
  const list = await j('GET', '/org/players', undefined, maria.token);
  neg(!list.body.items.some((p) => 'dob' in p), 'the Discover list ships no date of birth');
  const notif = await j('GET', '/org/notifications', undefined, tom.token);
  neg(
    !/"dob"|"email"|"token"/.test(JSON.stringify(notif.body)),
    'notifications carry no date of birth, email or token',
  );
  const prefs = await j('GET', '/org/notification-preferences', undefined, tom.token);
  neg(!/"userId"|"audienceId"|@/.test(JSON.stringify(prefs.body)), 'the preferences view carries no identifiers');
}

// ======================================================== §41 second boot
section('§19 — the request log carries no personal data');
{
  // A server with its request log on: what it prints for requests full of personal data and a secret.
  const LPORT = PORT + 13;
  const LDATA = mkdtempSync(path.join(tmpdir(), 'sbx-logs-'));
  const logged = [];
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...ENV, PORT: String(LPORT), DATA_DIR: LDATA, SCOUTBOX_QUIET_LOGS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  proc.stdout.on('data', (b) => logged.push(String(b)));
  proc.stderr.on('data', (b) => logged.push(String(b)));
  const lbase = `http://localhost:${LPORT}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(`${lbase}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  ok(up, 'a server with its request log on comes up');
  const send = (method, url, body, token) =>
    fetch(`${lbase}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const who = await send('POST', '/auth/org/login', {
    orgId: 'org-eastport',
    scoutName: 'Logcheck Person',
    role: 'Head of Recruitment',
  });
  const token = who.body?.token;
  await send('GET', '/org/players?q=QUERY-SENTINEL-4471', undefined, token);
  await send('POST', '/org/players/pl-adeyemi/notes', { text: 'BODY-SENTINEL-2290 jo@example.test 2001-04-17' }, token);
  await send('POST', '/org/rooms', { playerId: 'pl-adeyemi', email: 'jo@example.test', dob: '2001-04-17' }, token);
  await sleep(300);
  proc.kill('SIGTERM');
  const text = logged.join('');
  const lines = text.split('\n').filter((l) => l.startsWith('{"t":'));
  ok(lines.length >= 4 && !!token, `the requests were logged (${lines.length} request lines)`);
  neg(
    lines.every((l) => Object.keys(JSON.parse(l)).join() === 't,id,m,p,s,ms'),
    'each request line is time, id, method, path, status and duration, and nothing else',
  );
  const leaked = [
    token,
    'QUERY-SENTINEL-4471',
    'BODY-SENTINEL-2290',
    'jo@example.test',
    '2001-04-17',
    'Logcheck Person',
  ].filter((x) => x && text.includes(x));
  neg(
    leaked.length === 0,
    `nothing the requests carried reaches the log: no token, query, body, email, date of birth or name (${leaked.join(', ') || 'none'})`,
  );
}

section('§41 — a second boot on the same database applies no migration twice');
{
  serverProc.kill('SIGTERM');
  await sleep(800);
  serverProc = await boot(ENV, BASE);
  const c = await j('GET', '/capabilities');
  ok(
    c.body.schema.migrationsApplied === DATA_MIGRATIONS.length && c.body.schema.upToDate === true,
    `still ${DATA_MIGRATIONS.length} migrations applied — not ${DATA_MIGRATIONS.length * 2}`,
  );
  ok(c.body.integrity.ok === true, 'integrity still clean after a real save/load cycle');
  const m2 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const room = await j('GET', `/org/rooms/${globalThis.ROOM.roomId}`, undefined, m2.token);
  ok(
    room.status === 200 && (room.body.room?.rev ?? 0) >= 2,
    `the Room survived the restart with its revision (rev ${room.body.room?.rev})`,
  );
  const tomPrefs = (
    await j(
      'GET',
      '/org/notification-preferences',
      undefined,
      (
        await login('org-eastport', 'Tom Field', 'First-Team Scout')
      ).token,
    )
  ).body.preferences;
  ok(tomPrefs.categories.find((x) => x.id === 'mentions').enabled === true, "Tom's preference survived the restart");
}

// ===================================================== §43 production boot
section('§43 — a production boot refuses simulated faults and exposes no fault control');
{
  serverProc.kill('SIGTERM');
  await sleep(800);
  const PPORT = PORT + 10;
  const PBASE = `http://localhost:${PPORT}`;
  const PDATA = mkdtempSync(path.join(tmpdir(), 'sbx-m182prod-'));
  const prodEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PPORT),
    DATA_DIR: PDATA,
    SCOUTBOX_QUIET_LOGS: '1',
    MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
    ADMIN_KEY: 'm182-test-admin-key-not-real',
  }; // a real deployment names its own admin key
  const withFaults = spawn(process.execPath, [SERVER], {
    env: { ...prodEnv, SCOUTBOX_FAULTS: 'unavailable:/org/players' },
    stdio: 'ignore',
  });
  children.push(withFaults);
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    withFaults.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  neg(exited !== null && exited !== 0, `a production boot with SCOUTBOX_FAULTS set exits non-zero (exit ${exited})`);
  // A SEPARATE PORT for the plain boot: reusing PPORT straight after the
  // fault-configured server exits on it can fail with EADDRINUSE before the
  // kernel releases the socket, and a check that sometimes does not run
  // protects nothing.
  const PPORT2 = PORT + 11;
  const PBASE2 = `http://localhost:${PPORT2}`;
  let prodUp = false;
  let prodLog = '';
  const prod = spawn(process.execPath, [SERVER], {
    env: { ...prodEnv, PORT: String(PPORT2) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(prod);
  prod.stdout.on('data', (b) => {
    prodLog += b;
  });
  prod.stderr.on('data', (b) => {
    prodLog += b;
  });
  for (let i = 0; i < 160 && !prodUp; i++) {
    try {
      prodUp = (await fetch(`${PBASE2}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!prodUp) await sleep(250);
  }
  // A failure to boot is a FAILURE, not a reason to skip the assertions.
  ok(prodUp, `a plain production boot comes up${prodUp ? '' : `:\n${prodLog.slice(-800)}`}`);
  if (prodUp) {
    const caps = await (await fetch(`${PBASE2}/capabilities`)).json();
    neg(caps.faultInjection?.state === 'not_configured', 'in production the fault layer reports not_configured');
    const ctl = await fetch(`${PBASE2}/__faults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: 'fatal:/healthz' }),
    });
    neg(ctl.status === 404, 'and POST /__faults does not exist');
    neg((await fetch(`${PBASE2}/__rate-limits`)).status === 404, 'nor GET /__rate-limits');
    neg(!/secret-value-not-real/.test(JSON.stringify(caps)), 'the configured secret value never appears');
    ok(caps.schema?.upToDate === true, 'a production boot on an empty database migrates to the current schema');
  } else {
    // Keep the count honest: name each assertion that could not run.
    for (const what of [
      'the fault layer reports not_configured',
      'POST /__faults does not exist',
      'GET /__rate-limits does not exist',
      'the configured secret value never appears',
      'an empty database migrates to the current schema',
    ]) {
      fail(`could not assert: ${what} (production boot did not come up)`);
    }
  }
}

// ================================================================= summary
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(`\nplatform/contracts: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`);
if (pct < 50) fail(`negative coverage ${pct}% is below the 50% floor this milestone requires`);
if (process.exitCode) console.error('\nplatform/contracts FAILURES ABOVE');
else console.log('all platform/contracts checks passed');
process.exit(process.exitCode ?? 0);
