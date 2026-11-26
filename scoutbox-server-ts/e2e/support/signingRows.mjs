// Test helper: a signing package's stored rows, for the batteries that plant corruption in them. Every edit is plain
// SQL on an open fixture `F` (sqlFixture.mjs), so it is the attacker editing the file, not an act of the server: a
// value a column cannot hold, or a row a key or index refuses, throws, and the fixture's transaction writes nothing.
//
//   setRow(F, 'signing_packages', { id }, { status: 'READY' })   one row, or it throws
//   const rows = packageRows(F, id); …; restorePackage(F, rows)   a package's rows, and putting them back exactly
//   copyRevision(F, revisionId, { id, revision_number, position }, '-copy')
//   copySigning(F, signingRow, { id: 'sign-forged', … })
//
// Synthetic data only; temporary directories only.

/** A row as a plain object (node:sqlite returns null-prototype rows), or null. */
export const plain = (r) => (r ? { ...r } : null);

/** Set `cols` on the one row of `table` matching `where` (both `{ column: value }`); any other match count throws. */
export function setRow(F, table, where, cols) {
  const set = Object.keys(cols).map((c) => `"${c}" = ?`);
  const at = Object.keys(where).map((c) => `"${c}" = ?`);
  const r = F.sql
    .prepare(`UPDATE "${table}" SET ${set.join(', ')} WHERE ${at.join(' AND ')}`)
    .run(...Object.values(cols), ...Object.values(where));
  if (r.changes !== 1) throw new Error(`setRow: ${r.changes} rows of ${table} match ${JSON.stringify(where)}`);
}

/** A required party with no evidence reference: every evidence column empty. */
export const NO_EVIDENCE = {
  evidence_ref_kind: null,
  evidence_ref_id: null,
  evidence_revision_id: null,
  evidence_document_sha256: null,
  evidence_at: null,
  evidence_actor_kind: null,
  evidence_actor_id: null,
  evidence_session: null,
};

/** The tables a package's rows live in, in an order they can be inserted. */
export const PACKAGE_TABLES = [
  'signing_packages',
  'signing_revisions',
  'signing_documents',
  'signing_revision_parties',
  'signing_history',
  'idempotency_keys',
];

/** Every stored row of package `id`, table by table (PACKAGE_TABLES), in a stable order. */
export function packageRows(F, id) {
  const revs = 'SELECT id FROM signing_revisions WHERE package_id = ?';
  const all = (q) => F.sql.prepare(q).all(id).map(plain);
  return {
    signing_packages: all('SELECT * FROM signing_packages WHERE id = ?'),
    signing_revisions: all('SELECT * FROM signing_revisions WHERE package_id = ? ORDER BY position'),
    signing_documents: all(`SELECT * FROM signing_documents WHERE revision_id IN (${revs}) ORDER BY revision_id, kind`),
    signing_revision_parties: all(
      `SELECT * FROM signing_revision_parties WHERE revision_id IN (${revs}) ORDER BY revision_id, position`,
    ),
    signing_history: all('SELECT * FROM signing_history WHERE package_id = ? ORDER BY position'),
    idempotency_keys: all(
      "SELECT * FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = ? ORDER BY position",
    ),
  };
}

/** Put back rows from `packageRows` exactly: the package's stored rows are removed and the copies inserted. */
export function restorePackage(F, rows) {
  const id = rows.signing_packages[0].id;
  F.sql.prepare('DELETE FROM signing_history WHERE package_id = ?').run(id);
  F.sql.prepare("DELETE FROM idempotency_keys WHERE owner_table = 'signing_packages' AND owner_id = ?").run(id);
  F.sql.prepare('DELETE FROM signing_packages WHERE id = ?').run(id); // its revisions, documents and parties cascade
  insertPackage(F, rows);
}

/** Insert a package's rows (the shape `packageRows` returns), table by table. */
export function insertPackage(F, rows) {
  for (const table of PACKAGE_TABLES) for (const r of rows[table] ?? []) F.insert(table, r);
}

/** A copy of revision `from`, with its documents and parties, under `patch`; the documents' ids get `docSuffix`. */
export function copyRevision(F, from, patch, docSuffix) {
  const rev = plain(F.sql.prepare('SELECT * FROM signing_revisions WHERE id = ?').get(from));
  F.insert('signing_revisions', { ...rev, ...patch });
  for (const d of F.sql.prepare('SELECT * FROM signing_documents WHERE revision_id = ?').all(from))
    F.insert('signing_documents', { ...d, id: `${d.id}${docSuffix}`, revision_id: patch.id });
  for (const q of F.sql.prepare('SELECT * FROM signing_revision_parties WHERE revision_id = ?').all(from))
    F.insert('signing_revision_parties', { ...q, revision_id: patch.id });
}

/** A copy of a stored signings row (and its parties) under `patch`. */
export function copySigning(F, row, patch) {
  F.insert('signings', { ...row, ...patch });
  for (const q of F.sql.prepare('SELECT * FROM signing_parties WHERE signing_id = ?').all(row.id))
    F.insert('signing_parties', { ...q, signing_id: patch.id });
}

/** The vault row (ver_evidence) of package `pkgId`'s document of `kind`, or null. */
export const evidenceOfPackage = (F, pkgId, kind = 'signing') =>
  plain(
    F.sql
      .prepare('SELECT * FROM ver_evidence WHERE signing_package_id = ? AND signing_document_kind = ?')
      .get(pkgId, kind),
  );
