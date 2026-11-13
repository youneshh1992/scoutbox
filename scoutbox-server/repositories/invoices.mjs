/**
 * Invoices: the success fee of one signing, stored exactly in minor units; one per signing, issued after the signing
 * commits (the billing adapter, adapters.mjs). An invoice keeps its copy of the player's name: a billing record.
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen.
 * Organisations and signings are RESTRICT keys.
 */
import { isPlainObject, text, int, oneOf, tableDdl, bad, typeSpec, encode, decode, insertSql } from './fieldSpecs.mjs';
import { migrationApplied, operationOn } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const INVOICES_MIGRATION = '0038_operations';
export const INVOICES_COLLECTIONS = Object.freeze(['invoices']);
export const INVOICES_TABLES = Object.freeze(['invoices']);

export const INVOICE_PROVIDERS = Object.freeze(['dev-ledger', 'stripe']);
const L = Object.freeze({ id: 80, name: 200, description: 300 });

const idf = (k, c) => text(k, c, L.id, { nonEmpty: true, req: true });
const req = { req: true };
const INVOICE_SPEC = [
  idf('id', 'id'),
  int('ts', 'created_at', req),
  idf('orgId', 'org_id'),
  text('orgName', 'org_name', L.name, req),
  idf('signingId', 'signing_id'),
  text('playerName', 'player_name', L.name, req),
  text('description', 'description', L.description, req),
  int('amountMinor', 'amount_minor', req),
  text('currency', 'currency', 3, req),
  oneOf('status', 'status', ['issued'], req),
  oneOf('provider', 'provider', INVOICE_PROVIDERS, req),
];

export const INVOICES_DDL = [
  tableDdl('invoices', INVOICE_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (signing_id) REFERENCES signings(id) ON DELETE RESTRICT',
    'CHECK (amount_minor >= 0)',
    "CHECK (currency GLOB '[A-Z][A-Z][A-Z]')",
  ]),
  'CREATE UNIQUE INDEX invoices_signing ON invoices (signing_id);',
  'CREATE INDEX invoices_org ON invoices (org_id);',
].join('\n');

export function typeInvoice(raw, at = 'invoices') {
  const label = `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
  const t = typeSpec(INVOICE_SPEC, raw, label);
  if (!t.ok) return t;
  if (t.record.amountMinor < 0) return bad(label, 'amountMinor', 'must not be negative');
  if (!/^[A-Z]{3}$/.test(t.record.currency)) return bad(label, 'currency', 'must be a three-letter currency code');
  return t;
}

export const invoicesLive = (sqlite) => migrationApplied(sqlite, INVOICES_MIGRATION);
/** Every invoice read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const INVOICES_RECORDS = {
  names: INVOICES_COLLECTIONS,
  read: (sqlite) =>
    invoicesLive(sqlite)
      ? {
          invoices: sqlite
            .prepare('SELECT * FROM invoices ORDER BY rowid')
            .all()
            .map((r) => decode(INVOICE_SPEC, r)),
        }
      : null,
};

const WRITES = new Set(['issue']);

/** `createInvoicesRepository({ sqlite, unit, now, log })`: issuing an invoice and the queries, plus `reads`. */
export function createInvoicesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the invoices repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const { q, refusal, invalid } = writeKit(sqlite, 'INVOICE');

  const dec = (row) => deepFreeze(decode(INVOICE_SPEC, row));
  const byId = (id) => {
    const row = typeof id === 'string' ? q('SELECT * FROM invoices WHERE id = ?').get(id) : null;
    return row ? dec(row) : null;
  };
  const need = (i, tbl, id) => {
    if (!q(`SELECT 1 FROM ${tbl} WHERE id = ?`).get(id))
      throw refusal('REFERENCE_MISSING', `invoices ${i} names no ${tbl} row (${id})`);
  };
  /** Rows after `after` (a [rowid] key), newest first, decoded: `{ items, nextCursor }`. */
  const newestPage = (where, args, { after = null, limit }) => {
    const rows = q(
      `SELECT rowid, * FROM invoices WHERE ${where} AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`,
    ).all(...args, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
    const page = pageOf(rows, limit, (r) => [r.rowid]);
    return { items: page.items.map(dec), nextCursor: page.nextCursor };
  };
  const acts = {
    /** Issues the signing's invoice. A second invoice for one signing is refused (INVOICE_EXISTS). */
    issue: (raw) =>
      operation(() => {
        const t = typeInvoice(raw);
        if (!t.ok) throw invalid(t.reason);
        const i = t.record;
        if (q('SELECT 1 FROM invoices WHERE id = ?').get(i.id))
          throw refusal('DUPLICATE', `invoices ${i.id} already exists`);
        if (q('SELECT 1 FROM invoices WHERE signing_id = ?').get(i.signingId))
          throw refusal('EXISTS', `signings ${i.signingId} already has an invoice`);
        need(i.id, 'orgs', i.orgId);
        need(i.id, 'signings', i.signingId);
        q(insertSql('invoices', INVOICE_SPEC)).run(encode(INVOICE_SPEC, i));
        return byId(i.id);
      }),
    byId,
    forSigning: (signingId) => {
      const row = q('SELECT * FROM invoices WHERE signing_id = ?').get(signingId);
      return row ? dec(row) : null;
    },
    /** A page of the organisation's invoices, newest first. */
    pageForOrg: (orgId, page) => newestPage('org_id = ?', [orgId], page),
    /** A page of every invoice, newest first (Trust & Safety). */
    page: (page) => newestPage('1', [], page),
    count: () => q('SELECT COUNT(*) AS n FROM invoices').get().n,
  };
  const counts = () => ({ invoices: acts.count() });
  return {
    ...acts,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(acts).filter(([k]) => !WRITES.has(k)))),
    attach() {
      if (!invoicesLive(sqlite)) throw new Error(`the invoices repository needs ${INVOICES_MIGRATION} recorded`);
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll: () => INVOICES_RECORDS.read(sqlite),
    log,
    now,
  };
}
