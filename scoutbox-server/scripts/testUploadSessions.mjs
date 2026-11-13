// Upload sessions (repositories/uploadSessions.mjs): chunks recorded once each, a session ends once, the sweep abandons
// stale ones, a deleted player's sessions go, typing, units of work and fixtures. Temporary databases only. Run with:
// npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { fixtureDb } from './recruitmentTestFixtures.mjs';
import {
  UPLOAD_SESSIONS_MIGRATION as MIGRATION,
  UPLOAD_SESSIONS_TABLES as TABLES,
  UPLOAD_SESSIONS_COLLECTIONS as COLLECTIONS,
  typeUpload,
} from '../repositories/uploadSessions.mjs';

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
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The tables are STRICT, have no JSON column, and start with `rows(table)` rows. */
function schemaChecks(tables, rows = () => 0) {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0037_grassroots') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('repo-schema');
  const s = openLayer(dir).sqlite;
  for (const t of tables) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, rows(t, s), `${t} rows`);
  }
  s.close();
  rm(dir);
}
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

const MB = 1024 * 1024;
const CHUNK = 512 * 1024;
const upload = (over = {}) => ({
  id: 'upl-1',
  playerId: 'pl-adult',
  size: MB,
  mime: 'video/mp4',
  title: 'Volley',
  sha256: null,
  chunkSize: CHUNK,
  totalChunks: 2,
  status: 'open',
  createdAt: NOW,
  finalisedMediaId: null,
  ...over,
});
/** Sessions written the way the routes write them: opened, then each chunk received, then finalised or aborted. */
const WRITERS = {
  uploadSessions: (L, records) => {
    for (const { received = [], status, finalisedMediaId = null, ...u } of records) {
      L.uploadSessions.open({ ...u, status: 'open', finalisedMediaId: null });
      for (const c of received) L.uploadSessions.receiveChunk(u.id, c);
      if (status === 'finalised') L.uploadSessions.finalise(u.id, finalisedMediaId);
      else if (status === 'aborted') L.uploadSessions.abort(u.id);
      else if (status !== 'open')
        throw new Error(`upload_sessions ${u.id}: a fixture cannot write a ${status} session`);
    }
  },
};
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: WRITERS });
const seeded = (label) => {
  const dir = tempDir(label);
  write(dir, fixtureDb({ users: USERS(), orgs: ORGS() }));
  return { dir, s: serverOpen(dir) };
};

test('[schema] 0038 creates the STRICT upload tables, empty, with no JSON column', () => schemaChecks(TABLES));

test('[typing] junk is refused naming the record and field', () => {
  const ok = typeUpload({ ...upload(), received: [1, 0] });
  assert.ok(ok.ok, ok.reason);
  for (const [r, pattern] of [
    [typeUpload({ ...upload({ totalChunks: 3 }), received: [] }), /upl-1\.totalChunks/],
    [typeUpload({ ...upload({ size: 1.5 }), received: [] }), /upl-1\.size must be an integer/],
    [typeUpload({ ...upload({ sha256: 'z'.repeat(64) }), received: [] }), /upl-1\.sha256/],
    [typeUpload({ ...upload({ status: 'finalised' }), received: [] }), /upl-1\.finalisedMediaId/],
    [typeUpload({ ...upload({ mime: 'application/pdf' }), received: [] }), /upl-1\.mime must be one of/],
    [typeUpload({ ...upload(), received: [2] }), /received\[0\]/],
  ]) {
    assert.equal(r.ok, false, String(pattern));
    assert.match(r.reason, pattern);
  }
});

test('[uploads] a session records each chunk once, ends once, is abandoned by the sweep and goes with its player', () => {
  const { dir, s } = seeded('upl');
  const uploads = s.layer.uploadSessions;
  uploads.open(upload());
  uploads.receiveChunk('upl-1', 1);
  uploads.receiveChunk('upl-1', 0);
  uploads.receiveChunk('upl-1', 1);
  assert.deepEqual(plain(uploads.byId('upl-1').received), [1, 0], 'in arrival order, once each');
  refused(() => uploads.receiveChunk('upl-1', 2), /UPLOAD_INPUT_INVALID.*out of range/);
  refused(() => uploads.open(upload()), /UPLOAD_DUPLICATE/);
  assert.equal(uploads.forPlayerById('pl-other', 'upl-1'), null, 'another player never sees it');
  assert.equal(uploads.finalise('upl-1', 'media-1').status, 'finalised');
  refused(() => uploads.abort('upl-1'), /UPLOAD_NOT_OPEN/);
  refused(() => uploads.receiveChunk('upl-1', 0), /UPLOAD_NOT_OPEN/);
  refused(() => uploads.receiveChunk('upl-none', 0), /UPLOAD_NOT_FOUND/);
  uploads.open(upload({ id: 'upl-old', createdAt: NOW - 25 * 3600_000 }));
  uploads.open(upload({ id: 'upl-new', createdAt: NOW - 3600_000 }));
  assert.deepEqual(uploads.abandonOpenBefore(NOW - 24 * 3600_000), ['upl-old']);
  assert.equal(uploads.byId('upl-old').status, 'abandoned');
  assert.equal(uploads.byId('upl-new').status, 'open');
  uploads.open(upload({ id: 'upl-x', playerId: 'pl-other' }));
  assert.deepEqual(uploads.removeForPlayer('pl-adult').sort(), ['upl-1', 'upl-new', 'upl-old']);
  assert.equal(uploads.byId('upl-1'), null);
  assert.equal(
    s.store.sqlite.prepare('SELECT count(*) AS n FROM upload_session_chunks').get().n,
    0,
    'the chunk rows went with it',
  );
  assert.equal(uploads.byId('upl-x').playerId, 'pl-other', "another player's session stays");
  s.close();
  rm(dir);
});

test('[unit] a rolled-back unit leaves nothing, the reads cannot write', () => {
  const { dir, s } = seeded('upl-unit');
  assert.throws(
    () =>
      s.unit(() => {
        s.layer.uploadSessions.open(upload());
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(s.layer.uploadSessions.reads.byId('upl-1'), null);
  for (const w of ['open', 'receiveChunk', 'finalise', 'abort', 'abandonOpenBefore', 'removeForPlayer'])
    assert.equal(typeof s.layer.uploadSessions.reads[w], 'undefined', `the reads cannot ${w}`);
  s.close();
  rm(dir);
});

test('[fixtures] a session written through the repository reads back as written', () => {
  const dir = tempDir('upl-fix');
  const up = { ...upload({ status: 'finalised', finalisedMediaId: 'media-1' }), received: [0, 1] };
  write(dir, fixtureDb({ users: USERS(), orgs: ORGS(), uploadSessions: [up] }));
  assert.deepEqual(plain(readRecords(dir).uploadSessions), [plain(up)]);
  rm(dir);
});

console.log(`\n${passed} upload session checks passed`);
