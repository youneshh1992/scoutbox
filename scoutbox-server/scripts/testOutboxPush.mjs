// The mail outbox, the push log and the device push tokens as typed tables with explicit writes
// (repositories/outboxPush.mjs, migration 0011): the schema (the structural source CHECK, the
// vocabulary and length CHECKs, an address on every outbox row, one row per device token); the repository's writes
// (append, markDelivered, register: typed input, unknown fields and wrong types refused by field, never by address,
// text or token) and SQL reads (frozen records, pages newest first by cursor, a person's tokens); units of work; no
// mirror and no db.outbox / db.pushLog / db.pushTokens; fixtures written through the repository.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, TABLE_BACKED, DATA_MIGRATIONS } from '../repositories/index.mjs';
import { createOutboxPushRepository, OUTBOX_PUSH_MIGRATION } from '../repositories/outboxPush.mjs';
import { DISPATCHES_MIGRATION } from '../repositories/dispatches.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, openRaw, FIXTURE, ORGS, USERS, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
const second = (dir) => new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
const plain = (v) => JSON.parse(JSON.stringify(v));
const mail = (over = {}) => ({
  id: `mail-${++counter}`,
  ts: NOW,
  to: 'guardian@example.test',
  subject: 'Verify your ScoutBox guardian account',
  text: 'Your code is [code withheld — delivered to the recipient only].',
  transport: 'dev-outbox',
  delivered: true,
  ...over,
});
const delivery = (over = {}) => ({
  id: `mail-${++counter}`,
  at: NOW,
  channel: 'email',
  to: 'guardian@example.test',
  text: 'Eastport FC sent a request.',
  providerMessageId: `fm_${counter}`,
  provider: 'local-fake',
  ...over,
});
const push = (over = {}) => ({
  id: `push-${++counter}`,
  ts: NOW,
  audience: { kind: 'player', id: 'pl-adult' },
  title: 'ScoutBox',
  body: 'Eastport FC sent a message.',
  transport: 'dev-log',
  ...over,
});
const token = (over = {}) => ({
  kind: 'player',
  refId: 'pl-adult',
  token: 'ExponentPushToken[synthetic-1]',
  ts: NOW,
  ...over,
});

function fixtureFile(dir, extra = {}) {
  writeFixture(dir, { ...FIXTURE(), orgs: ORGS(), users: USERS(), ...extra }, { now: NOW, idCounter: 1000 });
}
function live(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, repo: layer.outboxPush, close: () => store.sqlite.close() };
}
const bare = (s) => createOutboxPushRepository({ sqlite: s, now: () => NOW });

// ============================================================= the schema
test("the schema: 0011 is registered after 0010; the structural CHECK ties each outbox source to its columns, its transport and its text length; every outbox row carries an address; the push log's audience kind and transport and a token's owner kind are vocabulary CHECKs; one row per device token; nothing carries a key; STRICT, no side column, no blob", () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.ok(ids.indexOf(OUTBOX_PUSH_MIGRATION) === ids.indexOf(DISPATCHES_MIGRATION) + 1);
  const dir = tempDir('obx-schema');
  fixtureFile(dir);
  const s = openRaw(dir);
  assert.equal(hasBlobTable(s), false);
  for (const t of ['outbox', 'push_log', 'push_tokens']) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/);
    assert.deepEqual(s.prepare(`PRAGMA foreign_key_list(${t})`).all(), []);
    assert.deepEqual(
      s
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .filter((c) => /_json$/.test(c.name)),
      [],
    );
  }
  const box = (o = {}) =>
    s
      .prepare(
        'INSERT INTO outbox (id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id) VALUES (@id, @source, 1, @to, @subject, @text, @transport, @delivered, @channel, @pmid)',
      )
      .run({
        id: `raw-${++counter}`,
        source: 'mailer',
        to: 'a@b.test',
        subject: 'S',
        text: 'T',
        transport: 'dev-outbox',
        delivered: 1,
        channel: null,
        pmid: null,
        ...o,
      });
  const del = {
    source: 'delivery',
    subject: null,
    delivered: null,
    channel: 'email',
    pmid: 'fm_x',
    transport: 'local-fake',
  };
  box();
  box({ ...del, pmid: `fm_${++counter}` });
  for (const [o, why] of [
    [{ to: null }, 'a mailer row without an address'],
    [{ ...del, to: null }, 'a delivery row without an address'],
    [{ subject: null }, 'a mailer row without a subject'],
    [{ transport: 'local-fake' }, 'a mailer row on the fake provider'],
    [{ transport: 'carrier-pigeon' }, 'an unknown transport'],
    [{ ...del, channel: 'sms' }, 'an unknown channel'],
    [{ ...del, delivered: 1 }, 'a delivery row with a delivered flag'],
    [{ ...del, text: 'x'.repeat(301) }, 'a delivery text over 300 characters'],
  ]) {
    assert.throws(() => box(o), /CHECK constraint failed|NOT NULL constraint failed/, why);
  }
  const pl = (o = {}) =>
    s
      .prepare(
        'INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (@id, 1, @k, @i, @t, @b, @tr)',
      )
      .run({ id: `raw-${++counter}`, k: 'player', i: 'pl-adult', t: 'ScoutBox', b: 'B', tr: 'dev-log', ...o });
  pl();
  for (const o of [{ k: 'org' }, { tr: 'sms' }, { t: '' }]) assert.throws(() => pl(o), /CHECK constraint failed/);
  const tk = (o = {}) =>
    s
      .prepare('INSERT INTO push_tokens (ref_kind, ref_id, token, registered_at) VALUES (@k, @i, @t, 1)')
      .run({ k: 'guardian', i: 'gd-primary', t: 'tok-1', ...o });
  tk();
  assert.throws(() => tk({ k: 'player', i: 'pl-adult' }), /UNIQUE constraint failed/, 'one row per device token');
  for (const o of [{ t: 'tok-2', k: 'org' }, { t: 'tok-3', k: 'ts_reviewer' }, { t: '' }, { t: 'x'.repeat(201) }])
    assert.throws(() => tk(o), /CHECK constraint failed/);
  s.close();
  rm(dir);
});

// ============================================================= writes and reads
test("the outbox: append types either literal (an unknown field, a missing address, an unknown transport, a duplicate id refused by field and id, never by address or text); markDelivered changes only a mailer record's flag; byId and the page answer frozen records newest first by cursor", () => {
  const dir = tempDir('obx-repo');
  fixtureFile(dir);
  const s = openRaw(dir);
  const { outbox } = bare(s);
  const m = outbox.append(mail({ id: 'mail-a', transport: 'sendgrid', delivered: false }));
  const d = outbox.append(delivery({ id: 'mail-b' }));
  assert.deepEqual(plain(m), plain(mail({ id: 'mail-a', transport: 'sendgrid', delivered: false, ts: m.ts })));
  assert.deepEqual(Object.keys(d), ['id', 'at', 'channel', 'to', 'text', 'providerMessageId', 'provider']);
  assert.ok(Object.isFrozen(d));
  for (const [raw, re] of [
    [mail({ extra: 1 }), /unknown field\(s\) extra/],
    [mail({ to: null }), /to must be an address/],
    [mail({ to: ['a@b.test'] }), /to must be an address/],
    [mail({ transport: 'carrier' }), /transport must be one of/],
    [mail({ delivered: 'yes' }), /delivered must be a boolean/],
    [delivery({ text: 'x'.repeat(301) }), /at most 300/],
    [delivery({ provider: 'sendgrid' }), /provider must be local-fake/],
    [mail({ id: 'mail-a' }), /OUTBOX_DUPLICATE/],
  ]) {
    assert.throws(() => outbox.append(raw), re);
  }
  try {
    outbox.append(mail({ to: 42, text: 'secret 123456' }));
  } catch (e) {
    assert.doesNotMatch(e.message, /123456|guardian@/, 'never the text or an address');
  }
  assert.equal(outbox.markDelivered('mail-a', true).delivered, true);
  assert.throws(() => outbox.markDelivered('mail-b', true), /delivery record/);
  assert.throws(() => outbox.markDelivered('mail-nowhere', true), /OUTBOX_NOT_FOUND/);
  assert.throws(() => outbox.markDelivered('mail-a', 'yes'), /boolean/);
  for (let i = 0; i < 3; i++) outbox.append(mail({ id: `mail-p${i}` }));
  const p1 = outbox.page({ limit: 2 });
  assert.deepEqual(
    p1.items.map((r) => r.id),
    ['mail-p2', 'mail-p1'],
  );
  const p2 = outbox.page({ limit: 10, after: JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString()) });
  assert.deepEqual(
    p2.items.map((r) => r.id),
    ['mail-p0', 'mail-b', 'mail-a'],
  );
  assert.equal(p2.nextCursor, null);
  assert.equal(outbox.count(), 5);
  s.close();
  rm(dir);
});

test("the push log and the tokens: a push record is typed (an unknown audience kind or transport refused); register keeps one row per device token — the same account again updates its time, another account takes the token over (moved: true) — and refuses staff, Trust & Safety and over-long tokens; forAudience answers one person's tokens", () => {
  const dir = tempDir('obx-push');
  fixtureFile(dir);
  const s = openRaw(dir);
  const { pushLog, pushTokens } = bare(s);
  const p = pushLog.append(push({ id: 'push-a' }));
  assert.deepEqual(plain(p), plain(push({ id: 'push-a', ts: p.ts })));
  assert.ok(Object.isFrozen(p.audience));
  for (const [raw, re] of [
    [push({ audience: { kind: 'org', id: 'org-pro' } }), /audience must be/],
    [push({ transport: 'sms' }), /transport must be one of/],
    [push({ extra: 1 }), /unknown field/],
    [push({ id: 'push-a' }), /OUTBOX_DUPLICATE/],
  ])
    assert.throws(() => pushLog.append(raw), re);
  pushLog.append(push({ id: 'push-b', audience: { kind: 'org_user', id: 'usr-1' } }));
  assert.deepEqual(
    pushLog.page({ limit: 50 }).items.map((r) => r.id),
    ['push-b', 'push-a'],
  );
  assert.deepEqual(pushTokens.register(token()).moved, false);
  assert.deepEqual(
    pushTokens.register(token({ ts: NOW + 5 })),
    { moved: false, row: { kind: 'player', refId: 'pl-adult', token: 'ExponentPushToken[synthetic-1]', ts: NOW + 5 } },
    'the same account again: its time is updated',
  );
  pushTokens.register(token({ token: 'ExponentPushToken[synthetic-2]' }));
  assert.deepEqual(
    pushTokens.forAudience('player', 'pl-adult').map((t) => t.token),
    ['ExponentPushToken[synthetic-2]', 'ExponentPushToken[synthetic-1]'],
    'oldest registration first: the re-registered token is last',
  );
  const moved = pushTokens.register(token({ kind: 'guardian', refId: 'gd-primary', ts: NOW + 9 }));
  assert.equal(moved.moved, true, 'a shared phone: the token moves to the account that signed in last');
  assert.deepEqual(
    pushTokens.forAudience('player', 'pl-adult').map((t) => t.token),
    ['ExponentPushToken[synthetic-2]'],
  );
  assert.deepEqual(
    pushTokens.forAudience('guardian', 'gd-primary').map((t) => t.token),
    ['ExponentPushToken[synthetic-1]'],
  );
  assert.equal(pushTokens.count(), 2);
  for (const [raw, re] of [
    [token({ kind: 'org', refId: 'org-pro' }), /kind must be one of player, guardian/],
    [token({ kind: 'ts_reviewer' }), /kind must be one of/],
    [token({ token: 'x'.repeat(201) }), /token must be text of 1 to 200/],
    [token({ token: 12 }), /token must be text/],
    [token({ extra: 1 }), /unknown field/],
  ])
    assert.throws(() => pushTokens.register(raw), re);
  try {
    pushTokens.register(token({ token: 'ExponentPushToken[' + 'y'.repeat(300) + ']' }));
  } catch (e) {
    assert.doesNotMatch(e.message, /yyyy/, 'a refusal never quotes the token');
  }
  s.close();
  rm(dir);
});

// ============================================================= the server's attachment and units
test('in the server: no mirror and no db.outbox, db.pushLog or db.pushTokens (each name throws, naming the repository); a write inside a unit commits or rolls back with it; outside a unit each write is durable at once', () => {
  const dir = tempDir('obx-unit');
  fixtureFile(dir);
  const L = live(dir);
  L.layer.outbox.append(mail({ id: 'mail-now' }));
  {
    const s = second(L.store.dir ?? dir);
    assert.equal(
      s.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id = 'mail-now'").get().n,
      1,
      'durable at once, seen by a second connection',
    );
    s.close();
  }
  assert.throws(
    () =>
      L.store.unitOfWork(() => {
        L.layer.outbox.append(mail({ id: 'mail-u' }));
        L.layer.pushTokens.register(token());
        throw new Error('refused later in the unit');
      }),
    /refused later/,
  );
  assert.equal(L.layer.outbox.byId('mail-u'), null);
  assert.equal(L.layer.pushTokens.count(), 0, 'the unit rolled back both');
  L.store.unitOfWork(() => {
    L.layer.outbox.append(delivery({ id: 'mail-d' }));
    L.layer.pushTokens.register(token());
  });
  assert.ok(L.layer.outbox.byId('mail-d'));
  assert.equal(L.layer.pushTokens.count(), 1);
  const rep = L.layer.report().domains.outboxPush;
  assert.deepEqual(rep.rows, { outbox: 2, pushLog: 0, pushTokens: 1 });
  assert.equal(rep.pendingWrites, 0);
  L.close();
  rm(dir);
});

// ============================================================= fixtures
test('fixtures: every outbox record (both literals), push record and token written through the repository reads back as written; an entry the tables cannot hold (an unknown field, a missing address, a staff token) refuses the whole fixture, naming the entry, and writes nothing', () => {
  const dir = tempDir('obx-fix');
  fixtureFile(dir);
  const records = {
    outbox: [mail({ id: 'mail-1' }), delivery({ id: 'mail-2' })],
    pushLog: [push({ id: 'push-1' })],
    pushTokens: [token(), token({ kind: 'guardian', refId: 'gd-primary', token: 'tok-g' })],
  };
  writeFixture(dir, records, { now: NOW });
  const back = () => {
    const r = readRecords(dir);
    return plain({ outbox: r.outbox, pushLog: r.pushLog, pushTokens: r.pushTokens });
  };
  assert.deepEqual(back(), plain(records));
  for (const [bad, re] of [
    [{ outbox: [mail({ id: 'x', extra: 1 })] }, /an outbox mailer record carries unknown field/],
    [{ outbox: [delivery({ id: 'x', to: null })] }, /to must be an address/],
    [{ pushTokens: [token({ kind: 'org', token: 'tok-x' })] }, /kind must be one of/],
  ]) {
    assert.throws(() => writeFixture(dir, bad, { now: NOW }), re);
  }
  assert.deepEqual(back(), plain(records), 'a refused fixture writes nothing');
  rm(dir);
});

console.log(`\n${passed} outbox/push checks passed`);
