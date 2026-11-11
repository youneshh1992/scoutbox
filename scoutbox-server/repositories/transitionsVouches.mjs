/**
 * Transition cases and coach references (vouches).
 *
 * Records:
 *   - A transition case: a player or guardian shares an evidence pack with clubs they choose, each grant
 *     individual, expiring and revocable. The pack's items, the grants (recipients) and the case history are ordered
 *     child rows; a placement and its follow-up are columns. `caseOwner` is not stored: it is always `startedBy`.
 *   - A coach reference (vouch): requested by a player or guardian (a coach proves their mailbox with a one-time code,
 *     stored only as its SHA-256 hash and cleared when used) or written straight onto the profile by a club releasing
 *     the player. `verificationMethod` and `identityVerified` are not stored: an email code proves mailbox control,
 *     never identity, so every view says 'email_code' and false.
 *
 * Writes (repositories/writes.mjs). A record is created whole and must read back as written, then changes only through
 * named acts (`grant`, `revokeGrant`, `place`, `publish`, `withdraw`, …), each an UPDATE of named columns or an INSERT
 * of new rows, joined into the open unit of work, the caller's open transaction, or a transaction of their own. No act
 * touches a case's pack, owner, note or period; grants are only inserted (a grant's revocation, once, and its last view
 * are the only fields that change) and history is only inserted. A case leaves `open` once, guarded in SQL; a code is
 * spent once. The columns and keys are the only check on stored values.
 *
 * Queries decode deep-frozen records in insertion (rowid) order unless they say otherwise. Modules receive them in
 * `verificationReads` (`transitionCases`, `vouches`).
 *
 * References. Player and guardian ids carry no key (tolerant, as the rest of verification: an account deletion leaves
 * these rows under the old id). A grant's and a placement's organisation → orgs are immediate RESTRICT
 * keys; a case's pack items, grants and history cascade with the case (a case is never deleted).
 */
import crypto from 'node:crypto';
import { isPlainObject, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { text, int, oneOf, group, tableDdl, decode } from './fieldSpecs.mjs';

export const TRANSITIONS_MIGRATION = '0025_transitions_vouches';
export const TRANSITIONS_COLLECTIONS = Object.freeze(['transitionCases', 'vouches']);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const TRANSITION_STATUSES = Object.freeze(['open', 'withdrawn', 'placed', 'expired']);
export const CASE_OWNERS = Object.freeze(['player', 'guardian']);
export const TRANSITION_ACTIONS = Object.freeze([
  'opened',
  'recipient_added',
  'recipient_revoked',
  'withdrawn',
  'placed',
  'expired',
]);
/** The pack's lists and the item kind each is stored as. */
export const PACK_KINDS = Object.freeze({ mediaIds: 'media', evidenceIds: 'evidence', feedbackIds: 'feedback' });
export const VOUCH_STATUSES = Object.freeze(['pending', 'published', 'revoked']);
/** Text limits. Ids, names, emails and lists over them are refused; the vouch routes shorten free text to them. */
export const TRANSITION_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  note: 500,
  placementNote: 300,
  packItems: 100,
  periodDays: Object.freeze({ min: 14, max: 180, default: 90 }),
  grantDays: Object.freeze({ min: 1, max: 90, default: 30 }),
  coachName: 100,
  coachEmail: 254,
  role: 200,
  text: 400,
  seasons: 40,
  conflictOfInterest: 200,
  withdrawnReason: 200,
});
const L = TRANSITION_LIMITS;
const ACTION_DETAIL = Object.freeze({
  opened: 'items',
  recipient_added: 'orgId',
  recipient_revoked: 'orgId',
  placed: 'orgId',
  withdrawn: null,
  expired: null,
});

/** The stored form of a one-time reference code: the SHA-256 hex of the code as typed, trimmed and upper-cased. */
export const vouchCodeHash = (code) =>
  crypto
    .createHash('sha256')
    .update(
      String(code ?? '')
        .trim()
        .toUpperCase(),
    )
    .digest('hex');

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, o);
const req = { req: true, nonEmpty: true };
const CASE_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  text('playerName', 'player_name', L.name),
  group('startedBy', [
    oneOf('kind', 'started_by_kind', CASE_OWNERS, { req: true }),
    idf('id', 'started_by_id', req),
    text('name', 'started_by_name', L.name),
  ]),
  text('note', 'note', L.note),
  int('periodEndsAt', 'period_ends_at', { req: true }),
  oneOf('status', 'status', TRANSITION_STATUSES, { req: true }),
  group(
    'placement',
    [
      idf('orgId', 'placement_org_id', req),
      text('orgName', 'placement_org_name', L.name),
      int('at', 'placement_at', { req: true }),
      text('note', 'placement_note', L.placementNote),
    ],
    { nullable: true },
  ),
  group('followUp', [int('dueAt', 'follow_up_due_at', { req: true }), int('notifiedAt', 'follow_up_notified_at')], {
    nullable: true,
  }),
  int('createdAt', 'created_at', { req: true }),
];
const RECIPIENT_SPEC = [
  idf('orgId', 'org_id', req),
  text('orgName', 'org_name', L.name),
  int('grantedAt', 'granted_at', { req: true }),
  int('expiresAt', 'expires_at', { req: true }),
  int('revokedAt', 'revoked_at'),
  int('viewedAt', 'viewed_at'),
];
const HISTORY_SPEC = [
  idf('id', 'id', req),
  int('at', 'at', { req: true }),
  oneOf('byKind', 'by_kind', [...CASE_OWNERS, 'system'], { req: true }),
  idf('byId', 'by_id', req),
  text('byName', 'by_name', L.name),
  oneOf('action', 'action', TRANSITION_ACTIONS, { req: true }),
];
const VOUCH_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  text('playerName', 'player_name', L.name),
  text('coachName', 'coach_name', L.coachName, req),
  text('coachEmail', 'coach_email', L.coachEmail),
  text('role', 'role', L.role, req),
  oneOf('status', 'status', VOUCH_STATUSES, { req: true }),
  text('codeHash', 'code_hash', 64),
  text('text', 'text', L.text),
  text('seasons', 'seasons', L.seasons),
  int('ts', 'created_at', { req: true }),
  int('publishedAt', 'published_at'),
  text('conflictOfInterest', 'conflict_of_interest', L.conflictOfInterest),
  group(
    'withdrawn',
    [
      int('at', 'withdrawn_at', { req: true }),
      oneOf('by', 'withdrawn_by', ['admin'], { req: true }),
      text('reason', 'withdrawn_reason', L.withdrawnReason, req),
    ],
    { nullable: true },
  ),
];

// ------------------------------------------------------------------ DDL (generated from the specs)
const CASE_ID = idf('caseId', 'transition_case_id', req);
const CASE_FK = 'FOREIGN KEY (transition_case_id) REFERENCES transition_cases(id) ON DELETE CASCADE';
export const TRANSITIONS_DDL = [
  tableDdl('transition_cases', CASE_SPEC, [
    'FOREIGN KEY (placement_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    "CHECK ((status = 'placed') = (placement_org_id IS NOT NULL))",
    'CHECK (follow_up_due_at IS NULL OR placement_org_id IS NOT NULL)',
    'CHECK (placement_org_id IS NULL OR placement_at IS NOT NULL)',
    'CHECK (placement_org_id IS NOT NULL OR (placement_org_name IS NULL AND placement_at IS NULL AND placement_note IS NULL))',
    'CHECK (follow_up_due_at IS NOT NULL OR follow_up_notified_at IS NULL)',
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
  tableDdl(
    'transition_case_recipients',
    [CASE_ID, int('ord', 'ord', { req: true }), ...RECIPIENT_SPEC],
    [
      CASE_FK,
      'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
      'PRIMARY KEY (transition_case_id, ord)',
      'CHECK (ord >= 0)',
      'CHECK (expires_at >= granted_at)',
    ],
  ),
  'CREATE INDEX transition_case_recipients_org ON transition_case_recipients (org_id, revoked_at, expires_at);',
  // The detail is one of two typed columns, by action: the item count when opened, the organisation of a grant, a
  // revocation or a placement; none for a withdrawal or an expiry.
  tableDdl(
    'transition_case_history',
    [
      HISTORY_SPEC[0],
      CASE_ID,
      ...HISTORY_SPEC.slice(1),
      int('detailItems', 'detail_items'),
      idf('detailOrgId', 'detail_org_id', { nonEmpty: true }),
    ],
    [
      CASE_FK,
      'CHECK (detail_items IS NULL OR detail_items > 0)',
      "CHECK ((action = 'opened') = (detail_items IS NOT NULL))",
      "CHECK ((action IN ('recipient_added','recipient_revoked','placed')) = (detail_org_id IS NOT NULL))",
    ],
  ),
  'CREATE INDEX transition_case_history_case ON transition_case_history (transition_case_id);',
  tableDdl('vouches', VOUCH_SPEC, [
    "CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*')",
    "CHECK ((status = 'pending') = (code_hash IS NOT NULL))",
    "CHECK (status <> 'published' OR (text IS NOT NULL AND published_at IS NOT NULL))",
    'CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL))',
  ]),
  'CREATE INDEX vouches_player_status ON vouches (player_id, status);',
  'CREATE UNIQUE INDEX vouches_code_hash ON vouches (code_hash) WHERE code_hash IS NOT NULL;',
].join('\n');
export const TRANSITIONS_TABLES = Object.freeze([
  'transition_cases',
  'transition_case_pack_items',
  'transition_case_recipients',
  'transition_case_history',
  'vouches',
]);

// ------------------------------------------------------------------ rows
function decodeCases(sqlite, rows) {
  const cids = rows.map((r) => r.id);
  const pack = childRowsOf(sqlite, 'transition_case_pack_items', 'transition_case_id', cids, {
    order: 'item_kind, ord',
    subKey: ['item_kind'],
  });
  const recs = childRowsOf(sqlite, 'transition_case_recipients', 'transition_case_id', cids, { order: 'ord' });
  const hist = childRowsOf(sqlite, 'transition_case_history', 'transition_case_id', cids, { order: 'rowid' });
  return rows.map((row) => {
    const rec = decode(CASE_SPEC, row);
    return {
      ...rec,
      caseOwner: { ...rec.startedBy },
      pack: Object.fromEntries(
        Object.entries(PACK_KINDS).map(([k, kind]) => [k, pack.all(row.id, kind).map((r) => r.item_id)]),
      ),
      recipients: recs.all(row.id).map((r) => decode(RECIPIENT_SPEC, r)),
      history: hist.all(row.id).map((h) => {
        const e = decode(HISTORY_SPEC, h);
        const want = ACTION_DETAIL[e.action];
        return {
          ...e,
          detail: want === 'items' ? { items: h.detail_items } : want === 'orgId' ? { orgId: h.detail_org_id } : null,
        };
      }),
    };
  });
}
const decodeVouch = (row) => ({
  ...decode(VOUCH_SPEC, row),
  verificationMethod: 'email_code',
  identityVerified: false,
});

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const transitionsLive = (sqlite) => migrationApplied(sqlite, TRANSITIONS_MIGRATION);
function readAll(sqlite) {
  return {
    transitionCases: decodeCases(sqlite, sqlite.prepare('SELECT * FROM transition_cases ORDER BY rowid').all()),
    vouches: sqlite.prepare('SELECT * FROM vouches ORDER BY rowid').all().map(decodeVouch),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const TRANSITIONS_RECORDS = {
  names: TRANSITIONS_COLLECTIONS,
  read(sqlite) {
    return transitionsLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM transition_cases UNION ALL SELECT player_id FROM vouches';
const playerRefCount = (sqlite, cond) =>
  sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get().n;
export const unresolvedPlayerReferences = (sqlite) =>
  transitionsLive(sqlite)
    ? { transitionsVouches: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') }
    : null;
export const retainedPlayerReferences = (sqlite) =>
  transitionsLive(sqlite)
    ? {
        transitionsVouches: playerRefCount(
          sqlite,
          'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)',
        ),
      }
    : null;

// ------------------------------------------------------------------ the repository
/**
 * `createTransitionsVouchesRepository({ sqlite, unit, now, log })`: `transitionCases` and `vouches`, each with its
 * whole-record `create`, its named acts and its queries, plus `reads` (the queries alone, merged into
 * `verificationReads`). A case's act is `act(id, input, { history })`: its own writes, then its history entries (only
 * ever inserted, each read back as written); it returns the stored case. A vouch's act is `act(id, input)`.
 */
export function createTransitionsVouchesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the transitions repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const {
    refusal: refuse,
    invalid,
    rowStep,
    listOf,
    readsBackAsWritten,
    newRecord,
    columnsOf,
    q,
    guarded,
  } = writeKit(sqlite, 'TRANSITIONS');
  const WRITES = new Set();
  const writes = (o) => {
    for (const k of Object.keys(o)) WRITES.add(k);
    return o;
  };
  const insertRow = (table, row) => {
    const cols = Object.keys(row);
    q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(row);
  };

  // ---- transition cases
  const CASES = 'transition_cases';
  const casesWhere =
    (where, order = 'rowid') =>
    (...args) =>
      decodeCases(sqlite, q(`SELECT * FROM transition_cases WHERE ${where} ORDER BY ${order}`).all(...args)).map(
        deepFreeze,
      );
  const caseById = (id) => {
    if (typeof id !== 'string') return null;
    const row = q('SELECT * FROM transition_cases WHERE id = ?').get(id);
    return row ? deepFreeze(decodeCases(sqlite, [row])[0]) : null;
  };
  const forPlayers = casesWhere('player_id IN (SELECT value FROM json_each(?))');
  const nextOrd = (table, id) =>
    q(`SELECT COALESCE(MAX(ord) + 1, 0) AS n FROM ${table} WHERE transition_case_id = ?`).get(id).n;
  const insertGrant = (id, r) => {
    if (!isPlainObject(r)) throw invalid(`${CASES} ${id} recipient: must be an object (got ${describe(r)})`);
    insertRow('transition_case_recipients', {
      transition_case_id: id,
      ord: nextOrd('transition_case_recipients', id),
      ...columnsOf(CASES, id, RECIPIENT_SPEC, r),
    });
  };
  const insertHistory = (id, h) => {
    if (!isPlainObject(h)) throw invalid(`${CASES} ${id} history: an entry must be an object (got ${describe(h)})`);
    const d = isPlainObject(h.detail) ? h.detail : {};
    insertRow('transition_case_history', {
      transition_case_id: id,
      ...columnsOf(CASES, id, HISTORY_SPEC, h),
      detail_items: d.items ?? null,
      detail_org_id: d.orgId ?? null,
    });
  };
  /** The grants not yet revoked end at `at` (all of them, or all but one organisation's). */
  const revokeOpenGrants = (id, at, keepOrgId = null) =>
    q(
      'UPDATE transition_case_recipients SET revoked_at = @at WHERE transition_case_id = @id AND revoked_at IS NULL AND (@keep IS NULL OR org_id <> @keep)',
    ).run({ id, at, keep: keepOrgId });
  const isOpen = (id, what) =>
    guarded(CASES, { id }, "status = 'open'", {}, `${CASES} ${id} is not open; ${what} is refused`);
  /** A recipient's grant (`ord`, its position among the case's recipients) while it is not revoked. */
  const liveGrant = (id, ord, cols, what) =>
    guarded(
      'transition_case_recipients',
      { transition_case_id: id, ord },
      'revoked_at IS NULL',
      cols,
      `${CASES} ${id} grant #${ord} ${what}`,
    );
  const caseActs = (defs) =>
    writes(
      Object.fromEntries(
        Object.entries(defs).map(([act, fn]) => [
          act,
          (id, input = {}, { history = [] } = {}) =>
            operation(() => {
              if (!q('SELECT 1 FROM transition_cases WHERE id = ?').get(id))
                throw refuse('NOT_FOUND', `${CASES} ${id} is not a record of the repository`);
              const check = rowStep(CASES, id, act, () => fn(id, input));
              const entries = listOf(CASES, id, 'history', history, { objects: true });
              for (const h of entries) rowStep(CASES, id, `history ${h.id}`, () => insertHistory(id, h));
              const stored = caseById(id);
              if (typeof check === 'function') check(stored);
              entries.forEach((h) =>
                readsBackAsWritten(
                  CASES,
                  id,
                  h,
                  stored.history.find((x) => x.id === h.id),
                  `history ${h.id}`,
                ),
              );
              return stored;
            }),
        ]),
      ),
    );
  const transitionCases = {
    ...writes({
      /** A new case, whole: its row, pack, grants and history. An existing id is refused; it must read back as written. */
      create: (t) =>
        operation(() => {
          newRecord(CASES, (id) => !!q('SELECT 1 FROM transition_cases WHERE id = ?').get(id), t);
          const step = (part, fn) => rowStep(CASES, t.id, part, fn);
          step('row', () => insertRow(CASES, columnsOf(CASES, t.id, CASE_SPEC, t)));
          if (t.pack !== undefined && !isPlainObject(t.pack))
            throw invalid(`${CASES} ${t.id} pack: must be an object (got ${describe(t.pack)})`);
          for (const [k, kind] of Object.entries(PACK_KINDS)) {
            listOf(CASES, t.id, `pack.${k}`, t.pack?.[k]).forEach((itemId, i) =>
              step(`pack.${k}[${i}]`, () =>
                insertRow('transition_case_pack_items', {
                  transition_case_id: t.id,
                  item_kind: kind,
                  ord: i,
                  item_id: itemId,
                }),
              ),
            );
          }
          listOf(CASES, t.id, 'recipients', t.recipients).forEach((r, i) =>
            step(`recipients[${i}]`, () => insertGrant(t.id, r)),
          );
          listOf(CASES, t.id, 'history', t.history).forEach((h, i) =>
            step(`history[${i}]`, () => insertHistory(t.id, h)),
          );
          const stored = caseById(t.id);
          readsBackAsWritten(CASES, t.id, t, stored);
          return stored;
        }),
    }),
    ...caseActs({
      /** A grant to one more club (a new recipient row; a grant is revoked, never removed). */
      grant: (id, { recipient }) => {
        isOpen(id, 'a grant');
        insertGrant(id, recipient);
        const ord = nextOrd('transition_case_recipients', id) - 1;
        return (stored) => readsBackAsWritten(CASES, id, recipient, stored.recipients[ord], `recipients[${ord}]`);
      },
      /** The owner withdraws one club's grant, once. */
      revokeGrant: (id, { ord, at }) => liveGrant(id, ord, { revoked_at: at }, 'is already revoked'),
      /** The club opened the pack under its live grant. */
      recordView: (id, { ord, at }) => liveGrant(id, ord, { viewed_at: at }, 'is revoked'),
      /** The owner closes the case: every grant ends. */
      withdraw: (id, { at }) => {
        guarded(CASES, { id }, "status = 'open'", { status: 'withdrawn' }, `${CASES} ${id} is not open`);
        revokeOpenGrants(id, at);
      },
      /** The player was placed: the case closes, the placing club's grant stays, every other ends, and a check-in falls due. */
      place: (id, { placement, followUpDueAt, at }) => {
        guarded(
          CASES,
          { id },
          "status = 'open'",
          {
            status: 'placed',
            ...columnsOf(
              CASES,
              id,
              CASE_SPEC.filter((f) => f.k === 'placement'),
              { placement },
            ),
            follow_up_due_at: followUpDueAt,
          },
          `${CASES} ${id} is not open`,
        );
        revokeOpenGrants(id, at, placement?.orgId ?? null);
      },
      /** The sweep: the period ended with the case still open. */
      expire: (id) => guarded(CASES, { id }, "status = 'open'", { status: 'expired' }, `${CASES} ${id} is not open`),
      /** The sweep sent the placement check-in, once. */
      markFollowUpNotified: (id, { at }) =>
        guarded(
          CASES,
          { id },
          'follow_up_due_at IS NOT NULL AND follow_up_notified_at IS NULL',
          { follow_up_notified_at: at },
          `${CASES} ${id} has no check-in due`,
        ),
    }),
    byId: caseById,
    /** The player's cases, oldest first. */
    forPlayer: casesWhere('player_id = ?'),
    /** The cases of any of these players, oldest first (a guardian's children). */
    forPlayers: (playerIds) => forPlayers(JSON.stringify([...playerIds])),
    /** Open cases holding a live grant (not revoked, not expired at `at`) for the organisation, oldest first: the club list. */
    grantedTo: (orgId, at) =>
      casesWhere(
        "status = 'open' AND EXISTS (SELECT 1 FROM transition_case_recipients r WHERE r.transition_case_id = transition_cases.id AND r.org_id = ? AND r.revoked_at IS NULL AND r.expires_at > ?)",
      )(orgId, at),
    /** Open cases whose period ended before `at` (the sweep). */
    expiredBy: (at) => casesWhere("status = 'open' AND period_ends_at < ?")(at),
    /** Placed cases whose check-in fell due before `at` and was not yet sent (the sweep). */
    followUpsDue: (at) =>
      casesWhere('follow_up_due_at IS NOT NULL AND follow_up_notified_at IS NULL AND follow_up_due_at < ?')(at),
  };

  // ---- coach references
  const vouchById = (id) => {
    if (typeof id !== 'string') return null;
    const row = q('SELECT * FROM vouches WHERE id = ?').get(id);
    return row ? deepFreeze(decodeVouch(row)) : null;
  };
  const vouchesWhere =
    (where, order = 'rowid') =>
    (...args) =>
      q(`SELECT * FROM vouches WHERE ${where} ORDER BY ${order}`)
        .all(...args)
        .map((r) => deepFreeze(decodeVouch(r)));
  const vouchActs = (defs) =>
    writes(
      Object.fromEntries(
        Object.entries(defs).map(([act, fn]) => [
          act,
          (id, input = {}) =>
            operation(() => {
              if (!q('SELECT 1 FROM vouches WHERE id = ?').get(id))
                throw refuse('NOT_FOUND', `vouches ${id} is not a record of the repository`);
              rowStep('vouches', id, act, () => fn(id, input));
              return vouchById(id);
            }),
        ]),
      ),
    );
  const vouches = {
    ...writes({
      /** A new reference, whole. An existing id, or a code already issued, is refused; it must read back as written. */
      create: (v) =>
        operation(() => {
          newRecord('vouches', (id) => !!q('SELECT 1 FROM vouches WHERE id = ?').get(id), v);
          if (v.codeHash && q('SELECT 1 FROM vouches WHERE code_hash = ?').get(v.codeHash))
            throw refuse('DUPLICATE', `vouches ${v.id}: that code is already issued`);
          rowStep('vouches', v.id, 'row', () => insertRow('vouches', columnsOf('vouches', v.id, VOUCH_SPEC, v)));
          const stored = vouchById(v.id);
          readsBackAsWritten('vouches', v.id, v, stored);
          return stored;
        }),
    }),
    ...vouchActs({
      /** The coach's text, published with the emailed code, which is spent (cleared). */
      publish: (id, { text, seasons = null, conflictOfInterest = null, at }) =>
        guarded(
          'vouches',
          { id },
          "status = 'pending'",
          {
            status: 'published',
            text,
            seasons,
            conflict_of_interest: conflictOfInterest,
            published_at: at,
            code_hash: null,
          },
          `vouches ${id} is not pending`,
        ),
      /** Trust & Safety revokes the reference; a pending code dies with it. */
      revoke: (id) => guarded('vouches', { id }, '', { status: 'revoked', code_hash: null }, `vouches ${id}`),
      /** Trust & Safety withdraws a reference from every profile view, once; the record stays. */
      withdraw: (id, { at, by, reason }) =>
        guarded(
          'vouches',
          { id },
          'withdrawn_at IS NULL',
          { withdrawn_at: at, withdrawn_by: by, withdrawn_reason: reason },
          `vouches ${id} is already withdrawn`,
        ),
    }),
    byId: vouchById,
    /** The pending reference this code was issued for, or null (the code as typed: trimmed and upper-cased before hashing). */
    pendingByCode: (code) => {
      const row = q("SELECT * FROM vouches WHERE code_hash = ? AND status = 'pending'").get(vouchCodeHash(code));
      return row ? deepFreeze(decodeVouch(row)) : null;
    },
    /** Every reference of the player, oldest first (the player's own profile). */
    forPlayer: vouchesWhere('player_id = ?'),
    /** The player's published references that Trust & Safety has not withdrawn, oldest first (every profile view). */
    publishedFor: vouchesWhere("player_id = ? AND status = 'published' AND withdrawn_at IS NULL"),
    /** Every reference, newest first, by cursor (`after` is the previous page's last `[rowid]`): the T&S list. */
    page: ({ limit, after = null }) => ({
      rows: q('SELECT rowid AS rid, * FROM vouches WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?')
        .all(after?.[0] ?? null, after?.[0] ?? null, limit + 1)
        .map((r) => ({ key: [r.rid], record: deepFreeze(decodeVouch(r)) })),
    }),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { transitionCases, vouches };
  const counters = {
    transitionCases: q('SELECT COUNT(*) AS n FROM transition_cases'),
    vouches: q('SELECT COUNT(*) AS n FROM vouches'),
  };
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (merged into `verificationReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!transitionsLive(sqlite))
        throw new Error(
          `the transitions repository needs ${TRANSITIONS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(TRANSITIONS_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return TRANSITIONS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
