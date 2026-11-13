// Invoices (repositories/invoices.mjs): one per signing, stored exactly in minor units, paged newest first, typing,
// units of work and fixtures. Temporary databases only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, USERS, ORGS } from './coreIdentityTestFixtures.mjs';
import { fixtureDb } from './recruitmentTestFixtures.mjs';
import { legacySigning } from './signingsFollowUpsTestFixtures.mjs';
import {
  INVOICES_MIGRATION as MIGRATION,
  INVOICES_TABLES as TABLES,
  INVOICES_COLLECTIONS as COLLECTIONS,
  typeInvoice,
} from '../repositories/invoices.mjs';

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

const ORG = 'org-pro';
const OTHER = 'org-two';
const FIX = () => ({
  users: USERS(),
  orgs: [...ORGS(), { ...ORGS()[0], id: OTHER, name: 'Second FC' }],
  notifications: [],
  dispatches: [],
  signings: [
    legacySigning({ id: 'sign-a' }),
    legacySigning({ id: 'sign-b', playerId: 'pl-b' }),
    legacySigning({ id: 'sign-c', playerId: 'pl-c', orgId: OTHER, orgName: 'Second FC' }),
  ],
});
const invoice = (over = {}) => ({
  id: 'inv-1',
  ts: NOW,
  orgId: ORG,
  orgName: 'Eastport FC',
  signingId: 'sign-a',
  playerName: 'Kid One',
  description: 'Success fee',
  amountMinor: 150_000,
  currency: 'EUR',
  status: 'issued',
  provider: 'dev-ledger',
  ...over,
});
const write = (dir, records) => writeFixture(dir, records, { now: NOW });
const seeded = (label) => {
  const dir = tempDir(label);
  write(dir, fixtureDb(FIX()));
  return { dir, s: serverOpen(dir) };
};

test('[schema] 0038 creates the STRICT invoices table, empty, with no JSON column', () => schemaChecks(TABLES));

test('[typing] junk is refused naming the record and field', () => {
  const ok = typeInvoice(invoice());
  assert.ok(ok.ok, ok.reason);
  for (const [r, pattern] of [
    [typeInvoice(invoice({ currency: 'eur' })), /inv-1\.currency/],
    [typeInvoice(invoice({ amountMinor: 1500.5 })), /inv-1\.amountMinor must be an integer/],
  ]) {
    assert.equal(r.ok, false, String(pattern));
    assert.match(r.reason, pattern);
  }
});

test('[invoices] one per signing, in minor units, paged newest first', () => {
  const { dir, s } = seeded('inv');
  const { invoices } = s.layer;
  invoices.issue(invoice());
  refused(() => invoices.issue(invoice({ id: 'inv-2' })), /INVOICE_EXISTS.*sign-a/);
  refused(() => invoices.issue(invoice({ signingId: 'sign-b' })), /INVOICE_DUPLICATE.*inv-1/);
  refused(
    () => invoices.issue(invoice({ id: 'inv-3', signingId: 'sign-none' })),
    /INVOICE_REFERENCE_MISSING.*sign-none/,
  );
  invoices.issue(invoice({ id: 'inv-2', signingId: 'sign-b', amountMinor: 50_000 }));
  invoices.issue(invoice({ id: 'inv-o', signingId: 'sign-c', orgId: OTHER }));
  assert.equal(invoices.forSigning('sign-a').amountMinor, 150_000);
  const first = invoices.pageForOrg(ORG, { limit: 1 });
  assert.deepEqual(
    first.items.map((i) => i.id),
    ['inv-2'],
  );
  const after = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  const second = invoices.pageForOrg(ORG, { limit: 1, after });
  assert.deepEqual([second.items.map((i) => i.id), second.nextCursor], [['inv-1'], null]);
  assert.deepEqual(
    invoices.page({ limit: 10 }).items.map((i) => i.id),
    ['inv-o', 'inv-2', 'inv-1'],
  );
  assert.equal(invoices.count(), 3);
  s.close();
  rm(dir);
});

test('[unit] a rolled-back unit leaves nothing, the reads cannot write', () => {
  const { dir, s } = seeded('inv-unit');
  assert.throws(
    () =>
      s.unit(() => {
        s.layer.invoices.issue(invoice());
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(s.layer.invoices.reads.count(), 0);
  assert.equal(typeof s.layer.invoices.reads.issue, 'undefined', 'the reads cannot issue');
  s.close();
  rm(dir);
});

test('[fixtures] an invoice written through the repository reads back as written; a missing reference or an unknown field is refused and leaves nothing', () => {
  const dir = tempDir('inv-fix');
  write(dir, fixtureDb({ ...FIX(), invoices: [invoice()] }));
  assert.deepEqual(plain(readRecords(dir).invoices), [invoice()]);
  refused(
    () => write(dir, { invoices: [invoice({ id: 'inv-2', signingId: 'sign-none' })] }),
    /INVOICE_REFERENCE_MISSING.*sign-none/,
  );
  refused(
    () => write(dir, { invoices: [{ ...invoice({ id: 'inv-3', signingId: 'sign-b' }), amount: 1500 }] }),
    /INVOICE_INPUT_INVALID.*does not store: amount/,
  );
  assert.deepEqual(plain(readRecords(dir).invoices), [invoice()], 'a refused write changed nothing');
  rm(dir);
});

console.log(`\n${passed} invoice checks passed`);
