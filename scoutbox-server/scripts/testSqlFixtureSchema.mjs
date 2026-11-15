// e2e/support/schema.sql (the migrated schema the SQL fixture writer loads) matches the table migrations, and a
// fixture written as plain rows leaves the same database the repository-backed fixture leaves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migratedSchemaSql, SCHEMA_FILE } from './sqlFixtureSchema.mjs';
import { writeFixture as viaRepositories } from './dataLayerFixture.mjs';
import { writeFixture as viaSql, openFixture } from '../e2e/support/sqlFixture.mjs';

assert.equal(
  fs.readFileSync(SCHEMA_FILE, 'utf8'),
  migratedSchemaSql(),
  'e2e/support/schema.sql is out of date: run node scripts/sqlFixtureSchema.mjs',
);
console.log('✓ e2e/support/schema.sql matches the table migrations');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-sqlfx-'));
const dump = (dir) => {
  const db = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    const out = { schema: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all() };
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      out[name] = db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((r) => JSON.stringify(r))
        .sort();
    return JSON.parse(JSON.stringify(out));
  } finally {
    db.close();
  }
};
const now = Date.now();
for (const fixture of [
  {},
  {
    sessions: [
      { token: 'tok-a', sid: 'sidaaaaaaaaa', kind: 'player', refId: 'pl-x', createdAt: now - 40 * 86_400_000 },
    ],
  },
]) {
  const a = tmp();
  const b = tmp();
  viaRepositories(a, fixture, { now, idCounter: 4200 });
  viaSql(b, fixture, { now, idCounter: 4200 });
  assert.deepEqual(
    dump(b),
    dump(a),
    `the SQL fixture ${JSON.stringify(Object.keys(fixture))} matches the repositories'`,
  );
}
console.log('✓ a fresh SQL fixture leaves the database the repository fixture leaves');

assert.throws(() => viaSql(tmp(), { players: [] }), /FIXTURE_COLLECTION_UNSUPPORTED/);
const d = tmp();
viaSql(d, {});
const F = openFixture(d);
assert.throws(
  () =>
    F.transaction(() => {
      F.session({ token: 't1', sid: 'sid111111111', kind: 'player', refId: 'pl-x' });
      F.insert('sessions', {
        token_hash: 'h',
        sid: 'sid222222222',
        kind: 'player',
        ref_id: 'x',
        created_at: 'soon',
        expires_at: 1,
      });
    }),
  /cannot store TEXT value in INTEGER column/,
);
assert.equal(F.sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'a refused fixture writes nothing');
F.close();
console.log('✓ an unsupported collection and a row the schema refuses write nothing');
