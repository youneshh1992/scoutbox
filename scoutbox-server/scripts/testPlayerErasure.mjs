// The retained player record (the Founder's decisions, docs/decisions.md: the full
// birth date and the country code are KEPT). The identity repositories on temporary
// databases through the real data layer: `players.erase` retains exactly the agreed
// row and nothing else of the person, removes the owned rows and links, is excluded
// from every account reader, refuses the reintroduction of a retained id, keeps the
// under-18 refusal for LIVE records, fails atomically and lands once on retry;
// migration 0014. Synthetic records only; nothing here touches DATA_DIR. Run with:
// npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED, DATA_MIGRATIONS } from '../repositories/index.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';
import {
  NOW,
  TTL,
  DAY,
  tempDir,
  clone,
  adult,
  child,
  seeded,
  gPrimary,
  gCo,
  gSignup,
  freshFile,
  openRaw,
  applied,
  dump,
} from './coreIdentityTestFixtures.mjs';

let passed = 0;
/** A fixture record as `create` takes it: the password hash beside the record, not on it. */
const asCreate = ({ password = null, ...r }) => ({ ...r, passwordHash: password });
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0014_player_erasure';
let erasureMod = null;
try {
  erasureMod = await import('../repositories/identity.mjs');
} catch {
  erasureMod = null;
}

/** The retained row, column by column: the identifier, the deletion instant, the two retained facts, fixed placeholders, NULL everywhere else. */
const RETAINED_ROW = (id, deletedAt, birthDate, country) => ({
  id,
  name: 'Deleted player',
  birth_date: birthDate,
  country,
  city: null,
  position: null,
  foot: null,
  height_cm: null,
  weight_kg: null,
  squad_number: null,
  contract_until_date: null,
  market_value_range: null,
  agent_name: null,
  academy_plus: 0,
  first_team_seeker: 0,
  availability: 'not_seeking',
  contract_status: 'unknown',
  level: 'amateur',
  football_category: null,
  identity_verified: 0,
  guardian_id: null,
  lat: null,
  lng: null,
  stats_appearances: null,
  stats_goals: null,
  stats_assists: null,
  stats_pace_kmh: null,
  stats_pass_completion_pct: null,
  stats_duel_success_pct: null,
  stats_clean_sheets: null,
  medical_shared: 0,
  medical_condition_status: 'unknown',
  prefs_quiet_start: null,
  prefs_quiet_end: null,
  prefs_school_hours_mute: null,
  prefs_timezone: null,
  programme_track: null,
  programme_started_at: null,
  password_hash: null,
  profile_signal: 0,
  created_at: null,
  deleted_at: deletedAt,
});
const RECORD = (id, deletedAt, birthDate, country) => ({ id, deletedAt, birthDate, country });

// ------------------------------------------------------------------ harness (the identity suite's, with the whole data layer attached)
const FIXTURE = () => ({
  players: [
    adult(),
    child('pl-child1', 'gd-primary', '2014-03-03'),
    seeded(),
    child('pl-child2', 'gd-primary', '2016-08-08'),
  ],
  guardians: [gPrimary(), gCo(), gSignup()],
});
const ORGS = () => [{ id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB' }];
function boot(dir, { players = [], guardians = [], warnings = [] } = {}) {
  const store = openStore(dir);
  const layer = attachDataLayer({
    seed: { orgs: ORGS(), players: clone(players), guardians: clone(guardians) },
    store,
    nextId,
    sessionTtlMs: TTL,
    now: () => NOW,
    warn: (m) => warnings.push(m),
  });
  return wire({ store, layer, warnings });
}
function reopen(dir, { warnings = [] } = {}) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  return wire({ store, layer, warnings });
}
function wire({ store, layer, warnings }) {
  const raw = (sql, ...p) => {
    const r = store.sqlite.prepare(sql).get(...p);
    return r ? { ...r } : r;
  };
  const all = (sql, ...p) =>
    store.sqlite
      .prepare(sql)
      .all(...p)
      .map((r) => ({ ...r }));
  const row = (id) => raw('SELECT * FROM players WHERE id = ?', id);
  const OWNED_TABLES = SUBRECORD_TABLES.filter((t) => t !== 'player_media_tags'); // the tag rows hang off player_media (media_id), not the player
  const childRows = (id) =>
    OWNED_TABLES.reduce((n, t) => n + raw(`SELECT COUNT(*) AS n FROM ${t} WHERE player_id = ?`, id).n, 0);
  const links = (id) =>
    all('SELECT guardian_id, player_id, role FROM guardian_children WHERE player_id = ? ORDER BY rowid', id);
  return {
    store,
    layer,
    warnings,
    players: layer.identity.players,
    guardians: layer.identity.guardians,
    codes: layer.codes,
    sessions: layer.sessions,
    mediaDeletions: layer.mediaDeletions,
    raw,
    all,
    row,
    childRows,
    links,
    fileDump: () => dump(store.sqlite),
    unit: (fn) => store.unitOfWork(fn),
    close: () => store.sqlite.close(),
  };
}

// ------------------------------------------------------------------ the erase
test('erase: a deleted player keeps EXACTLY the agreed row — id, the deletion instant, the full birth date and the country; a fixed placeholder in every NOT NULL column (never the previous value: a verified semi-pro academy player reads 0 / amateur / not_seeking afterwards), NULL everywhere else, no facets — the twelve child tables and the links are emptied explicitly, every guardian stops listing the id (the held childIds array in place); the retained row is served by no account reader (byId, byGuardian, count, linksOf, the whole-database read) and only by the narrow accessor; a second erase, remove, update, link and a re-creation under the same id are refused before any statement', () => {
  const dir = tempDir('erase-row');
  const t = boot(dir, FIXTURE());
  assert.equal(typeof t.players.erase, 'function', 'players.erase exists');
  const before = t.row('pl-seeded');
  assert.deepEqual(
    [
      before.identity_verified,
      before.academy_plus,
      before.level,
      before.availability,
      before.contract_status,
      before.medical_shared,
      before.medical_condition_status,
    ],
    [1, 1, 'semi_pro', 'available_now', 'expiring_summer', 1, 'fully_fit'],
    'the fixture carries non-default values in every placeholder column',
  );
  assert.ok(t.childRows('pl-seeded') > 5, 'the fixture has child rows');
  const kids = () => t.guardians.byId('gd-primary').childIds;
  const coKids = () => t.guardians.byId('gd-co').childIds;
  const countBefore = t.players.count();
  // An adult, outside a unit (the repository's own transaction).
  const result = t.players.erase('pl-seeded', { at: NOW });
  assert.deepEqual(result, { id: 'pl-seeded', deletedAt: NOW });
  assert.deepEqual(
    t.row('pl-seeded'),
    RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB'),
    'the retained row, column by column',
  );
  assert.equal(t.childRows('pl-seeded'), 0, 'every child row is gone');
  assert.deepEqual(t.links('pl-seeded'), []);
  assert.equal(t.players.byId('pl-seeded'), null);
  assert.equal(t.players.exists('pl-seeded'), false);
  assert.equal(t.players.count(), countBefore - 1);
  assert.deepEqual(t.guardians.linksOf('pl-seeded'), []);
  assert.deepEqual(t.players.retained('pl-seeded'), RECORD('pl-seeded', NOW, '2004-03-14', 'GB'));
  assert.equal(t.players.isRetained('pl-seeded'), true);
  assert.equal(t.players.isRetained('pl-adult'), false);
  assert.deepEqual(t.players.retainedRecords(), [RECORD('pl-seeded', NOW, '2004-03-14', 'GB')]);
  assert.equal(t.players.retainedCount(), 1);
  assert.equal(t.players.retained('pl-adult'), null, 'a live player is not a retained record');
  const read = readRecords(dir);
  assert.equal(
    read.players.some((p) => p.id === 'pl-seeded'),
    false,
    'the whole-database read serves no retained row as a player',
  );
  assert.deepEqual(
    read.playersRetained,
    [RECORD('pl-seeded', NOW, '2004-03-14', 'GB')],
    'and serves the retained records under their own name',
  );
  // A guardian-managed child, inside a unit (as the deletion route runs it): links and childIds.
  assert.deepEqual([...kids()], ['pl-child1', 'pl-child2']);
  assert.deepEqual([...coKids()], ['pl-child1', 'pl-child2']);
  t.unit(() => {
    t.codes.revokePairingCodesFor('pl-child1');
    t.players.erase('pl-child1', { at: NOW + DAY });
  });
  assert.deepEqual(t.row('pl-child1'), RETAINED_ROW('pl-child1', NOW + DAY, '2014-03-03', 'GB'));
  assert.deepEqual([...kids()], ['pl-child2'], 'the primary no longer lists the player');
  assert.deepEqual([...coKids()], ['pl-child2'], 'nor does the co-guardian');
  assert.deepEqual(t.links('pl-child1'), []);
  assert.deepEqual(
    t.players.byGuardian('gd-primary').map((p) => p.id),
    ['pl-child2'],
  );
  assert.equal(t.players.retainedCount(), 2);
  assert.equal(
    t.raw('SELECT COUNT(*) AS n FROM players').n,
    countBefore + 0,
    'the table keeps every row (two of them retained)',
  );
  // Refusals, before any statement: the table and the counters are untouched afterwards.
  const snapshotOfTable = () => JSON.stringify(t.all('SELECT * FROM players ORDER BY rowid'));
  const tableBefore = snapshotOfTable();
  assert.throws(() => t.players.erase('pl-seeded'), /pl-seeded .*retained/);
  assert.throws(() => t.players.setFootballCategory('pl-seeded', 'X'), /does not exist/);
  assert.throws(() => t.players.link('gd-co', 'pl-child1', 'co'), /does not exist/);
  assert.throws(
    () => t.players.create(asCreate({ ...adult(), id: 'pl-seeded' })),
    /pl-seeded .*retained/,
    'a deleted account is not re-created under its id',
  );
  assert.throws(() => t.players.erase('pl-nobody'), /does not exist/);
  assert.equal(snapshotOfTable(), tableBefore);
  assert.equal(t.players.count(), countBefore - 2);
  assert.equal(t.players.retainedCount(), 2);
  assert.equal(t.players.create(asCreate({ ...adult(), id: 'pl-new' })).id, 'pl-new', 'a new id is created as before');
  // A reopen agrees.
  t.close();
  const r = reopen(dir);
  assert.deepEqual(r.row('pl-seeded'), RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB'));
  assert.equal(r.players.byId('pl-seeded'), null);
  assert.equal(r.players.exists('pl-child1'), false);
  assert.deepEqual(r.players.retainedRecords(), [
    RECORD('pl-seeded', NOW, '2004-03-14', 'GB'),
    RECORD('pl-child1', NOW + DAY, '2014-03-03', 'GB'),
  ]);
  assert.deepEqual([...r.guardians.byId('gd-primary').childIds], ['pl-child2']);
  assert.throws(() => r.players.create(asCreate({ ...adult(), id: 'pl-child1' })), /retained/);
  r.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('beside the retained rows: the whole-database read carries them under their own name and never inside players; a later fixture that lists a retained id as a LIVE player is refused atomically with ids only (no birth date in the message), nothing written; the under-18-without-guardian refusal still holds for LIVE records while retained rows sit beside them; an unrelated later write leaves the retained rows byte-identical', () => {
  const dir = tempDir('erase-beside');
  const t = boot(dir, FIXTURE());
  t.players.erase('pl-seeded', { at: NOW });
  t.unit(() => {
    t.codes.revokePairingCodesFor('pl-child2');
    t.players.erase('pl-child2', { at: NOW + 1 });
  });
  const all = (sql) => {
    const s = openRaw(dir);
    try {
      return s
        .prepare(sql)
        .all()
        .map((r) => ({ ...r }));
    } finally {
      s.close();
    }
  };
  const fileDump = () => {
    const s = openRaw(dir);
    try {
      return dump(s);
    } finally {
      s.close();
    }
  };
  const expected = JSON.stringify([
    RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB'),
    RETAINED_ROW('pl-child2', NOW + 1, '2016-08-08', 'GB'),
  ]);
  const rows = () => JSON.stringify(all('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid'));
  const live = () => JSON.stringify(all('SELECT id FROM players WHERE deleted_at IS NULL ORDER BY rowid'));
  assert.equal(rows(), expected);
  t.close();
  const read = readRecords(dir);
  assert.deepEqual(
    read.playersRetained,
    [RECORD('pl-seeded', NOW, '2004-03-14', 'GB'), RECORD('pl-child2', NOW + 1, '2016-08-08', 'GB')],
    'the whole-database read carries the records under their own name',
  );
  assert.equal(
    read.players.some((p) => p.id === 'pl-seeded' || p.id === 'pl-child2'),
    false,
    'and never inside players',
  );
  const refused = (collections, pattern, label) => {
    const liveBefore = live();
    const fileBefore = fileDump();
    let err = null;
    try {
      writeFixture(dir, collections, { now: NOW });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${label}: refused`);
    assert.match(String(err.message), pattern, `${label}: ${err?.message}`);
    assert.doesNotMatch(
      String(err.message),
      /2004-03-14|2016-08-08|2001-05-20/,
      `${label}: no birth date in the message`,
    );
    assert.equal(rows(), expected, `${label}: retained rows unchanged`);
    assert.equal(live(), liveBefore, `${label}: live rows unchanged`);
    assert.equal(fileDump(), fileBefore, `${label}: nothing written`);
  };
  refused(
    { players: [asCreate({ ...seeded(), id: 'pl-seeded' })] },
    /pl-seeded .*retained/,
    'a retained id listed as a live player',
  );
  // The Founder's rule for live records is unchanged: a minor with no guardian link is refused.
  refused(
    { players: [asCreate(child('pl-orphan', null, '2015-05-05'))] },
    /MINOR_WITHOUT_GUARDIAN[\s\S]*pl-orphan/,
    'a live minor without a guardian link',
  );
  writeFixture(
    dir,
    {
      ledger: [
        {
          id: 'led-beside',
          ts: NOW,
          type: 'view',
          playerId: 'pl-seeded',
          orgId: 'org-pro',
          orgName: 'Eastport FC',
          userId: null,
          scoutName: 'Maria',
        },
      ],
    },
    { now: NOW },
  );
  assert.equal(rows(), expected, 'an unrelated later write: the retained rows byte-identical');
  const r = reopen(dir);
  assert.deepEqual(r.players.retainedRecords(), [
    RECORD('pl-seeded', NOW, '2004-03-14', 'GB'),
    RECORD('pl-child2', NOW + 1, '2016-08-08', 'GB'),
  ]);
  assert.equal(r.players.byId('pl-child2'), null);
  r.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unit of work: an erase inside a unit that fails after every write — and one whose REAL COMMIT fails — leaves the account exactly as it was: the row, the child rows, the links, the session, the media queue, the pairing code; memory restored through the memento (the same held view object, the held childIds array with its content, the indexes, no retained record, the facet tracking), an unrelated pending facet edit survives; the retry lands everything once and a second erase is refused; the audit rows (a ledger row naming the player) are untouched throughout', () => {
  const dir = tempDir('erase-unit');
  const t = boot(dir, FIXTURE());
  t.sessions.create('player', 'pl-child1');
  const code = t.codes.issuePairingCode('pl-child1');
  assert.ok(code?.code, 'a pairing code was issued');
  t.layer.safetyAudit.ledger.append({
    id: 'led-erase',
    ts: NOW,
    type: 'view',
    playerId: 'pl-child1',
    orgId: 'org-pro',
    orgName: 'Eastport FC',
    userId: null,
    scoutName: 'Maria',
  }); // no staff row in this fixture: the staff key is RESTRICT
  const ledgerBefore = JSON.stringify(t.all('SELECT * FROM ledger ORDER BY seq'));
  const view = t.players.byId('pl-child1');
  const kids = t.guardians.byId('gd-primary').childIds;
  const sessionsBefore = t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = 'pl-child1'").n;
  assert.equal(sessionsBefore, 1);
  const stateOf = () =>
    JSON.stringify({
      row: t.row('pl-child1'),
      children: t.childRows('pl-child1'),
      links: t.links('pl-child1'),
      sessions: t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = 'pl-child1'").n,
      queue: t.raw('SELECT COUNT(*) AS n FROM media_deletions').n,
      codes: t.raw("SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = 'pl-child1'").n,
      ledger: t.all('SELECT * FROM ledger ORDER BY seq'),
    });
  const before = stateOf();
  // An unrelated write committed before the unit.
  t.players.setFootballCategory('pl-seeded', 'Northgate');
  const fileBefore = t.fileDump();
  const attempt = (label, failHow) => {
    assert.throws(
      () =>
        t.unit(() => {
          t.mediaDeletions.enqueue(['med-x'], { playerId: 'pl-child1', at: NOW });
          t.sessions.revokeFor('player', 'pl-child1');
          t.codes.revokePairingCodesFor('pl-child1');
          t.players.erase('pl-child1', { at: NOW });
          assert.equal(t.players.byId('pl-child1'), null, `${label}: inside the unit the account is gone`);
          assert.equal(t.players.isRetained('pl-child1'), true);
          failHow();
        }),
      /synthetic|constraint failed|FOREIGN KEY/i,
      `${label}: the unit fails`,
    );
    assert.equal(stateOf(), before, `${label}: the file is exactly as before`);
    assert.equal(t.fileDump(), fileBefore, `${label}: nothing written anywhere`);
    assert.deepEqual(t.players.byId('pl-child1'), view, `${label}: the account reads as before`);
    assert.equal(view.name, 'Child pl-child1');
    assert.deepEqual(
      [...t.guardians.byId('gd-primary').childIds],
      [...kids],
      `${label}: the guardian lists the child as before`,
    );
    assert.deepEqual([...kids], ['pl-child1', 'pl-child2']);
    assert.equal(t.players.isRetained('pl-child1'), false);
    assert.equal(t.players.retainedCount(), 0);
    assert.equal(t.players.exists('pl-child1'), true);
    assert.deepEqual(
      t.players.byGuardian('gd-primary').map((p) => p.id),
      ['pl-child1', 'pl-child2'],
    );
    assert.deepEqual(t.guardians.linksOf('pl-child1'), [
      { guardianId: 'gd-primary', role: 'primary' },
      { guardianId: 'gd-co', role: 'co' },
    ]);
    assert.equal(
      t.players.byId('pl-seeded').footballCategory,
      'Northgate',
      `${label}: the unrelated earlier write survives`,
    );
  };
  attempt('failure after the writes', () => {
    throw new Error('synthetic failure after the erase');
  });
  attempt('failure at the real COMMIT', () => t.store.failCommitOfOpenTransaction());
  // The retry lands everything once.
  t.unit(() => {
    t.mediaDeletions.enqueue(['med-x'], { playerId: 'pl-child1', at: NOW });
    t.sessions.revokeFor('player', 'pl-child1');
    t.codes.revokePairingCodesFor('pl-child1');
    t.players.erase('pl-child1', { at: NOW });
  });
  assert.deepEqual(t.row('pl-child1'), RETAINED_ROW('pl-child1', NOW, '2014-03-03', 'GB'));
  assert.equal(t.childRows('pl-child1'), 0);
  assert.deepEqual(t.links('pl-child1'), []);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = 'pl-child1'").n, 0);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = 'pl-child1'").n, 0);
  assert.equal(t.raw('SELECT COUNT(*) AS n FROM media_deletions').n, 1);
  assert.equal(t.players.byId('pl-child1'), null);
  assert.deepEqual([...t.guardians.byId('gd-primary').childIds], ['pl-child2']);
  assert.equal(t.players.retainedCount(), 1);
  assert.throws(() => t.unit(() => t.players.erase('pl-child1', { at: NOW })), /retained/);
  assert.equal(
    JSON.stringify(t.all('SELECT * FROM ledger ORDER BY seq')),
    ledgerBefore,
    'the ledger row naming the deleted child is exactly as it was',
  );
  assert.equal(
    t.raw("SELECT football_category FROM players WHERE id = 'pl-seeded'").football_category,
    'Northgate',
    'the unrelated earlier write is in the row',
  );
  t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ migration 0014
test('migration 0014_player_erasure: registered after 0013; on a database at 0013 it records the step and changes no row and no table; it refuses to run outside the runner or before 0013; a second run is a no-op; retained records the erase wrote read back by deletion instant, then id', () => {
  assert.equal(
    DATA_MIGRATIONS.map((m) => m.id)
      .filter((id) => id < '0019')
      .at(-5),
    MIGRATION,
    'registered after 0013 (0015–0018 follow it)',
  );
  const step = DATA_MIGRATIONS.find((m) => m.id === MIGRATION);
  const tables = (s) =>
    s
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
  const a = tempDir('m14-plain');
  freshFile(a);
  let s = openRaw(a);
  runDataMigrations(
    s,
    DATA_MIGRATIONS.filter((m) => m.id < MIGRATION),
    { now: NOW, context: { sessionTtlMs: TTL } },
  );
  const before = dump(s, { except: ['data_migrations'] });
  const tablesBefore = tables(s);
  assert.throws(() => step.up(s), /inside the migration runner's transaction only/);
  assert.deepEqual(
    runDataMigrations(
      s,
      DATA_MIGRATIONS.filter((m) => m.id <= MIGRATION),
      { now: NOW },
    ).ran,
    [MIGRATION],
  );
  assert.ok(applied(s).includes(MIGRATION));
  assert.deepEqual(tables(s), tablesBefore, 'no table created');
  assert.equal(dump(s, { except: ['data_migrations'] }), before, 'no row changed');
  assert.deepEqual(
    runDataMigrations(s, DATA_MIGRATIONS, { now: NOW + 1 }).ran.filter((id) => id < '0019'),
    ['0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups'],
    'never twice',
  );
  s.close();
  // Before 0013: refused.
  const b = tempDir('m14-early');
  freshFile(b);
  s = openRaw(b);
  s.exec('BEGIN');
  assert.throws(() => step.up(s), /0013_safety_audit must be recorded first/);
  s.exec('ROLLBACK');
  s.close();
  // Retained records the erase wrote are read back by deletion instant, then id (the rows stay in insertion order).
  const c = tempDir('m14-read');
  {
    const t = boot(c, FIXTURE());
    t.players.erase('pl-seeded', { at: NOW - DAY });
    t.unit(() => {
      t.codes.revokePairingCodesFor('pl-child2');
      t.players.erase('pl-child2', { at: NOW - 2 * DAY });
    });
    assert.deepEqual(t.all('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid'), [
      RETAINED_ROW('pl-seeded', NOW - DAY, '2004-03-14', 'GB'),
      RETAINED_ROW('pl-child2', NOW - 2 * DAY, '2016-08-08', 'GB'),
    ]);
    t.close();
    assert.deepEqual(
      readRecords(c).playersRetained,
      [RECORD('pl-child2', NOW - 2 * DAY, '2016-08-08', 'GB'), RECORD('pl-seeded', NOW - DAY, '2004-03-14', 'GB')],
      'by deletion instant, then id',
    );
  }
  for (const d of [a, b, c]) fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n${passed} player-erasure checks passed`);
