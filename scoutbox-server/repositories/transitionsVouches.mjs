/**
 * S10c — transition cases and coach references (vouches) as typed tables (migration `0025_transitions_vouches`;
 * docs/architecture/migration.md §4.5 S10; sql/05_verification_passport.sql).
 *
 * Records:
 *   - A transition case (M13 F2): a player or guardian shares an evidence pack with clubs they choose, each grant
 *     individual, expiring and revocable. The pack's items, the grants (recipients) and the case history are ordered
 *     child rows; a placement and its follow-up are columns. `caseOwner` is not stored: it is always `startedBy`.
 *   - A coach reference (vouch): requested by a player or guardian (a coach proves their mailbox with a one-time code,
 *     stored only as its SHA-256 hash and cleared when used) or written straight onto the profile by a club releasing
 *     the player. `verificationMethod` and `identityVerified` are not stored: an email code proves mailbox control,
 *     never identity, so every view says 'email_code' and false (as every reader defaulted before).
 *
 * The M13 F10 legacy representations are not part of this step: their writer has refused since M23 P5.6E, but step
 * 2305 mirrors their rows into the agent agreements, so the collection moves with the agent stores in S11.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write it at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own; an unknown field and
 * an update from inside its own update are refused. A case's pack, owner, note and period never change; its grants
 * only gain rows (a grant's revocation and last view are the only fields that change); its history only grows.
 *
 * READS are SQL: no mirror. Queries decode fresh, deep-frozen records in insertion (rowid) order unless they say
 * otherwise. Modules receive them in `verificationReads` (`transitionCases`, `vouches`).
 *
 * References. Player and guardian ids carry no key (tolerant, as the rest of verification: an account deletion leaves
 * these rows under the old id, as before). A grant's and a placement's organisation → orgs are immediate RESTRICT
 * keys; a case's pack items, grants and history cascade with the case (a case is never deleted).
 */
import crypto from 'node:crypto';
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { text, int, oneOf, group, tableDdl, bad, typeSpec, encode, decode, upsertSql } from './fieldSpecs.mjs';

export const TRANSITIONS_MIGRATION = '0025_transitions_vouches';
export const TRANSITIONS_COLLECTIONS = Object.freeze(['transitionCases', 'vouches']);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const TRANSITION_STATUSES = Object.freeze(['open', 'withdrawn', 'placed', 'expired']);
export const CASE_OWNERS = Object.freeze(['player', 'guardian']);
export const TRANSITION_ACTIONS = Object.freeze(['opened', 'recipient_added', 'recipient_revoked', 'withdrawn', 'placed', 'expired']);
/** The pack's lists and the item kind each is stored as. */
export const PACK_KINDS = Object.freeze({ mediaIds: 'media', evidenceIds: 'evidence', feedbackIds: 'feedback' });
export const VOUCH_STATUSES = Object.freeze(['pending', 'published', 'revoked']);
/** Text limits: the routes shorten free text to these (as they always did); ids, names, emails and lists over them are refused. */
export const TRANSITION_LIMITS = Object.freeze({
  id: 80, name: 200, note: 500, placementNote: 300, packItems: 100,
  periodDays: Object.freeze({ min: 14, max: 180, default: 90 }), grantDays: Object.freeze({ min: 1, max: 90, default: 30 }),
  coachName: 100, coachEmail: 254, role: 200, text: 400, seasons: 40, conflictOfInterest: 200, withdrawnReason: 200,
});
const L = TRANSITION_LIMITS;
const ACTION_DETAIL = Object.freeze({ opened: 'items', recipient_added: 'orgId', recipient_revoked: 'orgId', placed: 'orgId', withdrawn: null, expired: null });

/** The stored form of a one-time reference code: the SHA-256 hex of the code as typed, trimmed and upper-cased. */
export const vouchCodeHash = (code) => crypto.createHash('sha256').update(String(code ?? '').trim().toUpperCase()).digest('hex');

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, o);
const req = { req: true, nonEmpty: true };
const CASE_SPEC = [
  idf('id', 'id', req), idf('playerId', 'player_id', req), text('playerName', 'player_name', L.name),
  group('startedBy', [oneOf('kind', 'started_by_kind', CASE_OWNERS, { req: true }), idf('id', 'started_by_id', req), text('name', 'started_by_name', L.name)]),
  text('note', 'note', L.note), int('periodEndsAt', 'period_ends_at', { req: true }),
  oneOf('status', 'status', TRANSITION_STATUSES, { req: true }),
  group('placement', [idf('orgId', 'placement_org_id', req), text('orgName', 'placement_org_name', L.name), int('at', 'placement_at', { req: true }), text('note', 'placement_note', L.placementNote)], { nullable: true }),
  group('followUp', [int('dueAt', 'follow_up_due_at', { req: true }), int('notifiedAt', 'follow_up_notified_at')], { nullable: true }),
  int('createdAt', 'created_at', { req: true }),
];
const RECIPIENT_SPEC = [
  idf('orgId', 'org_id', req), text('orgName', 'org_name', L.name), int('grantedAt', 'granted_at', { req: true }),
  int('expiresAt', 'expires_at', { req: true }), int('revokedAt', 'revoked_at'), int('viewedAt', 'viewed_at'),
];
const HISTORY_SPEC = [
  idf('id', 'id', req), int('at', 'at', { req: true }), oneOf('byKind', 'by_kind', [...CASE_OWNERS, 'system'], { req: true }),
  idf('byId', 'by_id', req), text('byName', 'by_name', L.name), oneOf('action', 'action', TRANSITION_ACTIONS, { req: true }),
];
const VOUCH_SPEC = [
  idf('id', 'id', req), idf('playerId', 'player_id', req), text('playerName', 'player_name', L.name),
  text('coachName', 'coach_name', L.coachName, req), text('coachEmail', 'coach_email', L.coachEmail), text('role', 'role', L.role, req),
  oneOf('status', 'status', VOUCH_STATUSES, { req: true }), text('codeHash', 'code_hash', 64),
  text('text', 'text', L.text), text('seasons', 'seasons', L.seasons), int('ts', 'created_at', { req: true }), int('publishedAt', 'published_at'),
  text('conflictOfInterest', 'conflict_of_interest', L.conflictOfInterest),
  group('withdrawn', [int('at', 'withdrawn_at', { req: true }), oneOf('by', 'withdrawn_by', ['admin'], { req: true }), text('reason', 'withdrawn_reason', L.withdrawnReason, req)], { nullable: true }),
];

// ------------------------------------------------------------------ DDL (generated from the specs)
const CASE_ID = idf('caseId', 'transition_case_id', req);
const CASE_FK = 'FOREIGN KEY (transition_case_id) REFERENCES transition_cases(id) ON DELETE CASCADE';
export const TRANSITIONS_DDL = [
  tableDdl('transition_cases', CASE_SPEC, [
    'FOREIGN KEY (placement_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    "CHECK ((status = 'placed') = (placement_org_id IS NOT NULL))",
    'CHECK (follow_up_due_at IS NULL OR placement_org_id IS NOT NULL)',
  ]),
  'CREATE INDEX transition_cases_player ON transition_cases (player_id);',
  'CREATE INDEX transition_cases_status_period ON transition_cases (status, period_ends_at);',
  'CREATE INDEX transition_cases_follow_up ON transition_cases (follow_up_due_at) WHERE follow_up_due_at IS NOT NULL AND follow_up_notified_at IS NULL;',
  `CREATE TABLE transition_case_pack_items (
  transition_case_id TEXT NOT NULL REFERENCES transition_cases(id) ON DELETE CASCADE,
  item_kind         TEXT NOT NULL CHECK (item_kind IN ('media','evidence','feedback')),
  ord                INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${L.packItems}),
  item_id            TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= ${L.id}),
  PRIMARY KEY (transition_case_id, item_kind, item_id),
  UNIQUE (transition_case_id, item_kind, ord)
) STRICT;`,
  tableDdl('transition_case_recipients', [CASE_ID, int('ord', 'ord', { req: true }), ...RECIPIENT_SPEC], [
    CASE_FK,
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'PRIMARY KEY (transition_case_id, ord)',
    'CHECK (ord >= 0)',
    'CHECK (expires_at >= granted_at)',
  ]),
  'CREATE INDEX transition_case_recipients_org ON transition_case_recipients (org_id, revoked_at, expires_at);',
  // The detail is one of two typed columns, by action: the item count when opened, the organisation of a grant, a
  // revocation or a placement; none for a withdrawal or an expiry.
  tableDdl('transition_case_history', [HISTORY_SPEC[0], CASE_ID, ...HISTORY_SPEC.slice(1), int('detailItems', 'detail_items'), idf('detailOrgId', 'detail_org_id', { nonEmpty: true })], [
    CASE_FK,
    'CHECK (detail_items IS NULL OR detail_items > 0)',
    "CHECK ((action = 'opened') = (detail_items IS NOT NULL))",
    "CHECK ((action IN ('recipient_added','recipient_revoked','placed')) = (detail_org_id IS NOT NULL))",
  ]),
  'CREATE INDEX transition_case_history_case ON transition_case_history (transition_case_id);',
  tableDdl('vouches', VOUCH_SPEC, [
    'CHECK (length(code_hash) = 64)',
    "CHECK ((status = 'pending') = (code_hash IS NOT NULL))",
    "CHECK (status <> 'published' OR (text IS NOT NULL AND published_at IS NOT NULL))",
  ]),
  'CREATE INDEX vouches_player_status ON vouches (player_id, status);',
  'CREATE UNIQUE INDEX vouches_code_hash ON vouches (code_hash) WHERE code_hash IS NOT NULL;',
].join('\n');
export const TRANSITIONS_TABLES = Object.freeze(['transition_cases', 'transition_case_pack_items', 'transition_case_recipients', 'transition_case_history', 'vouches']);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();

function typePack(pack, label) {
  if (!isPlainObject(pack)) return bad(label, 'pack', `must be an object (got ${describe(pack)})`);
  const unknown = Object.keys(pack).filter((k) => !Object.hasOwn(PACK_KINDS, k));
  if (unknown.length) return bad(label, 'pack', `carries field(s) this build does not store: ${unknown.join(', ')}`);
  const out = {};
  for (const k of Object.keys(PACK_KINDS)) {
    const list = pack[k] ?? [];
    if (!Array.isArray(list)) return bad(label, `pack.${k}`, `must be a list (got ${describe(list)})`);
    if (list.length > L.packItems) return bad(label, `pack.${k}`, `holds more than ${L.packItems} entries`);
    const i = list.findIndex((x) => typeof x !== 'string' || !x.length || x.length > L.id);
    if (i >= 0) return bad(label, `pack.${k}[${i}]`, `must be an id of at most ${L.id} characters (got ${describe(list[i])})`);
    if (new Set(list).size !== list.length) return bad(label, `pack.${k}`, 'names an entry twice');
    out[k] = [...list];
  }
  if (!Object.values(out).some((l) => l.length)) return bad(label, 'pack', 'holds no item');
  return { ok: true, record: out };
}
function typeHistoryEntry(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { detail = null, ...rest } = raw;
  const t = typeSpec(HISTORY_SPEC, rest, at); if (!t.ok) return t;
  const want = ACTION_DETAIL[t.record.action];
  if (want === null) {
    if (detail !== null) return bad(at, 'detail', `must be null for ${t.record.action}`);
  } else {
    const keys = isPlainObject(detail) ? Object.keys(detail) : null;
    if (!keys || keys.length !== 1 || keys[0] !== want) return bad(at, 'detail', `must be { ${want} } for ${t.record.action} (got ${describe(detail)})`);
    const v = detail[want];
    if (want === 'items' ? !(Number.isSafeInteger(v) && v > 0) : !(typeof v === 'string' && v.length > 0 && v.length <= L.id)) return bad(at, `detail.${want}`, `is not valid (got ${describe(v)})`);
  }
  return { ok: true, record: { ...t.record, detail: want === null ? null : { [want]: detail[want] } } };
}
/** A transition case: the flat columns, the pack, the grants and the history. `caseOwner` is accepted when it is `startedBy`. */
export function typeTransitionCase(raw, at = 'transitionCases') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { pack, recipients = [], history = [], caseOwner, ...flatPart } = raw;
  const t = typeSpec(CASE_SPEC, flatPart, label); if (!t.ok) return t;
  if (caseOwner !== undefined && JSON.stringify(caseOwner) !== JSON.stringify(t.record.startedBy)) return bad(label, 'caseOwner', 'is always who started the case');
  const p = typePack(pack, label); if (!p.ok) return p;
  if (!Array.isArray(recipients)) return bad(label, 'recipients', `must be a list (got ${describe(recipients)})`);
  const grants = [];
  for (const [i, r] of recipients.entries()) {
    const rt = typeSpec(RECIPIENT_SPEC, r, `${label}.recipients[${i}]`); if (!rt.ok) return rt;
    if (rt.record.expiresAt < rt.record.grantedAt) return bad(`${label}.recipients[${i}]`, 'expiresAt', 'is before the grant');
    grants.push(rt.record);
  }
  if (!Array.isArray(history)) return bad(label, 'history', `must be a list (got ${describe(history)})`);
  const hist = [];
  for (const [i, h] of history.entries()) { const ht = typeHistoryEntry(h, `${label}.history[${i}]`); if (!ht.ok) return ht; hist.push(ht.record); }
  if (new Set(hist.map((h) => h.id)).size !== hist.length) return bad(label, 'history', 'names an id twice');
  const r = t.record;
  if ((r.status === 'placed') !== (r.placement !== null)) return bad(label, 'placement', 'is set exactly when the case is placed');
  if (r.followUp && !r.placement) return bad(label, 'followUp', 'follows a placement only');
  return { ok: true, record: { ...r, caseOwner: { ...r.startedBy }, pack: p.record, recipients: grants, history: hist } };
}
/** A coach reference. A pending one carries its code hash; a published one its text and instant. */
export function typeVouch(raw, at = 'vouches') {
  const label = labelOf(at, raw);
  const t = typeSpec(VOUCH_SPEC, raw, label, ['verificationMethod', 'identityVerified']); if (!t.ok) return t;
  if (raw.verificationMethod !== undefined && raw.verificationMethod !== 'email_code') return bad(label, 'verificationMethod', "is always 'email_code'");
  if (raw.identityVerified !== undefined && raw.identityVerified !== false) return bad(label, 'identityVerified', 'is always false (an email code proves the mailbox, not the person)');
  const v = t.record;
  if (v.codeHash !== null && !/^[0-9a-f]{64}$/.test(v.codeHash)) return bad(label, 'codeHash', 'must be a SHA-256 hex digest');
  if ((v.status === 'pending') !== (v.codeHash !== null)) return bad(label, 'codeHash', 'is held exactly while the reference is pending');
  if (v.status === 'published' && (v.text === null || v.publishedAt === null)) return bad(label, 'text', 'and publishedAt are required once published');
  return { ok: true, record: { ...v, verificationMethod: 'email_code', identityVerified: false } };
}

// ------------------------------------------------------------------ rows
function caseStatements(sqlite) {
  return {
    upsert: sqlite.prepare(upsertSql('transition_cases', CASE_SPEC)),
    packIns: sqlite.prepare('INSERT INTO transition_case_pack_items (transition_case_id, item_kind, ord, item_id) VALUES (?, ?, ?, ?)'),
    recDel: sqlite.prepare('DELETE FROM transition_case_recipients WHERE transition_case_id = ?'),
    recIns: sqlite.prepare('INSERT INTO transition_case_recipients (transition_case_id, ord, org_id, org_name, granted_at, expires_at, revoked_at, viewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    histIns: sqlite.prepare('INSERT INTO transition_case_history (id, transition_case_id, at, by_kind, by_id, by_name, action, detail_items, detail_org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  };
}
const encodeCase = (rec) => encode(CASE_SPEC, rec);
/** Write a typed case: the row, the pack (only when new), the grants whole, the history entries not yet stored. */
function writeCase(st, rec, { isNew, knownHistory = 0 }) {
  st.upsert.run(encodeCase(rec));
  if (isNew) for (const [k, kind] of Object.entries(PACK_KINDS)) rec.pack[k].forEach((id, i) => st.packIns.run(rec.id, kind, i, id));
  st.recDel.run(rec.id);
  rec.recipients.forEach((r, i) => st.recIns.run(rec.id, i, r.orgId, r.orgName, r.grantedAt, r.expiresAt, r.revokedAt, r.viewedAt));
  for (const h of rec.history.slice(knownHistory)) st.histIns.run(h.id, rec.id, h.at, h.byKind, h.byId, h.byName, h.action, h.detail?.items ?? null, h.detail?.orgId ?? null);
}
function decodeCases(sqlite, rows) {
  const cids = rows.map((r) => r.id);
  const pack = childRowsOf(sqlite, 'transition_case_pack_items', 'transition_case_id', cids, { order: 'item_kind, ord', subKey: ['item_kind'] });
  const recs = childRowsOf(sqlite, 'transition_case_recipients', 'transition_case_id', cids, { order: 'ord' });
  const hist = childRowsOf(sqlite, 'transition_case_history', 'transition_case_id', cids, { order: 'rowid' });
  return rows.map((row) => {
    const rec = decode(CASE_SPEC, row);
    return {
      ...rec,
      caseOwner: { ...rec.startedBy },
      pack: Object.fromEntries(Object.entries(PACK_KINDS).map(([k, kind]) => [k, pack.all(row.id, kind).map((r) => r.item_id)])),
      recipients: recs.all(row.id).map((r) => decode(RECIPIENT_SPEC, r)),
      history: hist.all(row.id).map((h) => {
        const e = decode(HISTORY_SPEC, h);
        const want = ACTION_DETAIL[e.action];
        return { ...e, detail: want === 'items' ? { items: h.detail_items } : want === 'orgId' ? { orgId: h.detail_org_id } : null };
      }),
    };
  });
}
const decodeVouch = (row) => ({ ...decode(VOUCH_SPEC, row), verificationMethod: 'email_code', identityVerified: false });
const encodeVouch = (rec) => { const { verificationMethod: _m, identityVerified: _i, ...r } = rec; return encode(VOUCH_SPEC, r); };

// ------------------------------------------------------------------ snapshot (fixtures and the persistence batteries)
export const transitionsLive = (sqlite) => migrationApplied(sqlite, TRANSITIONS_MIGRATION);
function readAll(sqlite) {
  return {
    transitionCases: decodeCases(sqlite, sqlite.prepare('SELECT * FROM transition_cases ORDER BY rowid').all()),
    vouches: sqlite.prepare('SELECT * FROM vouches ORDER BY rowid').all().map(decodeVouch),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back); null before its migration. */
export const TRANSITIONS_RECORDS = {
  names: TRANSITIONS_COLLECTIONS,
  read(sqlite) { return transitionsLive(sqlite) ? readAll(sqlite) : null; },
};
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM transition_cases UNION ALL SELECT player_id FROM vouches';
const playerRefCount = (sqlite, cond) => sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get().n;
export const unresolvedPlayerReferences = (sqlite) => (transitionsLive(sqlite) ? { transitionsVouches: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') } : null);
export const retainedPlayerReferences = (sqlite) => (transitionsLive(sqlite) ? { transitionsVouches: playerRefCount(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)') } : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * `createTransitionsVouchesRepository({ sqlite, unit, now, log })`: `transitionCases` and `vouches`, each with its writes
 * and queries, plus `reads` (the queries alone, merged into `verificationReads`).
 */
export function createTransitionsVouchesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the transitions repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const cs = caseStatements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('TRANSITIONS_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('TRANSITIONS_INPUT_INVALID', t.reason); return t.record; };

  // ---- transition cases
  const casesWhere = (where, order = 'rowid') => (...args) => decodeCases(sqlite, q(`SELECT * FROM transition_cases WHERE ${where} ORDER BY ${order}`).all(...args)).map(deepFreeze);
  const caseById = (id) => { if (typeof id !== 'string') return null; const row = q('SELECT * FROM transition_cases WHERE id = ?').get(id); return row ? deepFreeze(decodeCases(sqlite, [row])[0]) : null; };
  const CASE_IMMUTABLE = ['id', 'playerId', 'playerName', 'startedBy', 'note', 'pack', 'periodEndsAt', 'createdAt'];
  const forPlayers = casesWhere('player_id IN (SELECT value FROM json_each(?))');
  const transitionCases = {
    create: (raw) => operation(() => {
      const r = typedOr(typeTransitionCase, raw, 'transitionCases');
      if (caseById(r.id)) throw refusal('TRANSITIONS_DUPLICATE', `transition_cases ${r.id} already exists`);
      writeCase(cs, r, { isNew: true });
      return caseById(r.id);
    }),
    /**
     * `update(id, change)`: `change` edits a plain copy of the stored case; the result is typed whole and written at once.
     * The pack, owner, note and period never change; grants only gain rows and only their revocation (once) and last
     * view change; the history only grows.
     */
    update: (id, change) => guard(`transition_cases ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('transitionCases.update(id, change) needs a function that edits the copy it is given');
      const stored = caseById(id);
      if (!stored) throw refusal('TRANSITIONS_NOT_FOUND', `transition_cases ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeTransitionCase, returned === undefined ? draft : returned, 'transitionCases');
      for (const k of CASE_IMMUTABLE) if (!same(next[k], stored[k])) throw refusal('TRANSITIONS_INPUT_INVALID', `transition_cases ${id}: ${k} cannot change`);
      if (next.recipients.length < stored.recipients.length) throw refusal('TRANSITIONS_INPUT_INVALID', `transition_cases ${id}: a grant cannot be removed`);
      stored.recipients.forEach((r, i) => {
        const n = next.recipients[i];
        if (n.orgId !== r.orgId || n.orgName !== r.orgName || n.grantedAt !== r.grantedAt || n.expiresAt !== r.expiresAt) throw refusal('TRANSITIONS_INPUT_INVALID', `transition_cases ${id}: grant #${i} keeps its organisation and dates`);
        if (r.revokedAt !== null && n.revokedAt !== r.revokedAt) throw refusal('TRANSITIONS_INPUT_INVALID', `transition_cases ${id}: grant #${i} was already revoked`);
      });
      if (stored.history.some((h, i) => !same(h, next.history[i]))) throw refusal('TRANSITIONS_INPUT_INVALID', `transition_cases ${id}: the history only grows (a stored entry cannot change or go)`);
      const taken = next.history.slice(stored.history.length).find((h) => q('SELECT 1 FROM transition_case_history WHERE id = ?').get(h.id));
      if (taken) throw refusal('TRANSITIONS_DUPLICATE', `transition_case_history ${taken.id} already exists`);
      writeCase(cs, next, { isNew: false, knownHistory: stored.history.length });
      return caseById(id);
    })),
    byId: caseById,
    /** The player's cases, oldest first. */
    forPlayer: casesWhere('player_id = ?'),
    /** The cases of any of these players, oldest first (a guardian's children). */
    forPlayers: (playerIds) => forPlayers(JSON.stringify([...playerIds])),
    /** Open cases holding a live grant (not revoked, not expired at `at`) for the organisation, oldest first: the club list. */
    grantedTo: (orgId, at) => casesWhere("status = 'open' AND EXISTS (SELECT 1 FROM transition_case_recipients r WHERE r.transition_case_id = transition_cases.id AND r.org_id = ? AND r.revoked_at IS NULL AND r.expires_at > ?)")(orgId, at),
    /** Open cases whose period ended before `at` (the sweep). */
    expiredBy: (at) => casesWhere("status = 'open' AND period_ends_at < ?")(at),
    /** Placed cases whose check-in fell due before `at` and was not yet sent (the sweep). */
    followUpsDue: (at) => casesWhere('follow_up_due_at IS NOT NULL AND follow_up_notified_at IS NULL AND follow_up_due_at < ?')(at),
  };

  // ---- coach references
  const vouchById = (id) => { if (typeof id !== 'string') return null; const row = q('SELECT * FROM vouches WHERE id = ?').get(id); return row ? deepFreeze(decodeVouch(row)) : null; };
  const vouchesWhere = (where, order = 'rowid') => (...args) => q(`SELECT * FROM vouches WHERE ${where} ORDER BY ${order}`).all(...args).map((r) => deepFreeze(decodeVouch(r)));
  const VOUCH_IMMUTABLE = ['id', 'playerId', 'playerName', 'coachName', 'coachEmail', 'role', 'ts'];
  const writeVouch = (rec) => q(upsertSql('vouches', VOUCH_SPEC)).run(encodeVouch(rec));
  const vouches = {
    create: (raw) => operation(() => {
      const r = typedOr(typeVouch, raw, 'vouches');
      if (vouchById(r.id)) throw refusal('TRANSITIONS_DUPLICATE', `vouches ${r.id} already exists`);
      if (r.codeHash && q('SELECT 1 FROM vouches WHERE code_hash = ?').get(r.codeHash)) throw refusal('TRANSITIONS_DUPLICATE', `vouches ${r.id}: that code is already issued`);
      writeVouch(r);
      return vouchById(r.id);
    }),
    /** `update(id, change)`: `change` edits a plain copy of the stored reference; the result is typed whole and written at once. */
    update: (id, change) => guard(`vouches ${id}`, () => operation(() => {
      if (typeof change !== 'function') throw new TypeError('vouches.update(id, change) needs a function that edits the copy it is given');
      const stored = vouchById(id);
      if (!stored) throw refusal('TRANSITIONS_NOT_FOUND', `vouches ${id} is not a record of the repository`);
      const draft = clone(stored);
      const returned = change(draft);
      const next = typedOr(typeVouch, returned === undefined ? draft : returned, 'vouches');
      for (const k of VOUCH_IMMUTABLE) if (!same(next[k], stored[k])) throw refusal('TRANSITIONS_INPUT_INVALID', `vouches ${id}: ${k} cannot change`);
      if (next.codeHash !== null && next.codeHash !== stored.codeHash) throw refusal('TRANSITIONS_INPUT_INVALID', `vouches ${id}: a code is issued once`);
      writeVouch(next);
      return vouchById(id);
    })),
    byId: vouchById,
    /** The pending reference this code was issued for, or null (the code as typed: trimmed and upper-cased before hashing). */
    pendingByCode: (code) => { const row = q("SELECT * FROM vouches WHERE code_hash = ? AND status = 'pending'").get(vouchCodeHash(code)); return row ? deepFreeze(decodeVouch(row)) : null; },
    /** Every reference of the player, oldest first (the player's own profile). */
    forPlayer: vouchesWhere('player_id = ?'),
    /** The player's published references that Trust & Safety has not withdrawn, oldest first (every profile view). */
    publishedFor: vouchesWhere("player_id = ? AND status = 'published' AND withdrawn_at IS NULL"),
    /** Every reference, newest first, by cursor (`after` is the previous page's last `[rowid]`): the T&S list. */
    page: ({ limit, after = null }) => ({
      rows: q('SELECT rowid AS rid, * FROM vouches WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?').all(after?.[0] ?? null, after?.[0] ?? null, limit + 1)
        .map((r) => ({ key: [r.rid], record: deepFreeze(decodeVouch(r)) })),
    }),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { transitionCases, vouches };
  const counters = { transitionCases: q('SELECT COUNT(*) AS n FROM transition_cases'), vouches: q('SELECT COUNT(*) AS n FROM vouches') };
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (merged into `verificationReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!transitionsLive(sqlite)) throw new Error(`the transitions repository needs ${TRANSITIONS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(TRANSITIONS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return TRANSITIONS_RECORDS.read(sqlite); },
    log,
    now,
  };
}
