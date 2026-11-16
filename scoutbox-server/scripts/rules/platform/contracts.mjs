// The rules behind the platform contracts battery (e2e/platform/contracts.mjs) that are checked in this process: the
// event registry, payload minimisation and fingerprints (§1–§4), the Nobody Missed and Second Look orderings (§7),
// notification classification and preferences (§8–§9), the boot integrity report (§11), and the date boundaries of
// age, briefs and Second Look (§13–§15).
import {
  EVENT_REGISTRY,
  EVENT_NAMES,
  AUDIENCES,
  minimizePayload,
  eventFingerprint,
  assertEventRegistry,
} from '../../../domains/platform/eventRegistry.mjs';
import { EVENT_AUDIENCE, audienceFor } from '../../../domains/platform/eventAudience.mjs';
import {
  CATEGORIES,
  TYPE_CATEGORY,
  categoryOf,
  defaultPrefs,
  createNotificationPrefs,
} from '../../../domains/platform/notificationPrefs.mjs';
import { integrityReport, integritySummary } from '../../../domains/platform/integrity.mjs';
import { OPEN_ROOM_STATUSES } from '../../../domains/recruitment/public.mjs';
import { ageOn, isAdult, adultAgeFor } from '../../../domain.ts';
import {
  POLICY,
  secondLookStatus,
  secondLookExpired,
  briefIsLiveOn,
  validateRecruitmentBrief,
  orderNobodyMissed,
  orderSecondLook,
} from '../../../domains/discovery/shared.mjs';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../../../repositories/database.ts';
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import { createNotificationsRepository } from '../../../repositories/notifications.ts';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('platform/contracts');
const DAY = 86_400_000;

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

done();
