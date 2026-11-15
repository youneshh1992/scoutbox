/**
 * The Football Passport's own records: a player's Passport preferences (bio, positions, availability, the position history and the public
 * selections), self-submitted career entries, achievements (with a verified club's confirmation), share links (token
 * hashes only) and correction requests. Every field is a typed column with its vocabulary and length CHECKs; there are no
 * JSON columns. Football dates are stored as the player gave them, to the precision given: 'YYYY', 'YYYY-MM' or
 * 'YYYY-MM-DD' (the routes write any accepted form, an epoch or `{ year, month }`, in that shape). Positions are
 * PLAYER_POSITIONS codes; secondary positions and public selections are ordered child rows.
 *
 * WRITES are explicit, joined into the open unit of work, the caller's open transaction, or a transaction of their own.
 * `create(record)` types the whole record and writes it at once (an unknown field is refused); then a record changes
 * only through named acts guarded in SQL by the state they move from (an entry or achievement is withdrawn, an
 * achievement confirmed, a share revoked, a correction resolved, each once). Preferences are saved by naming the fields
 * that change (`passportPrefs.save(playerId, { set, history, at })`): a row exists only once a player or guardian saved,
 * and the position history only grows. A share's view count is `shares.recordView(id)`.
 *
 * Queries decode deep-frozen records in insertion (rowid) order unless they say otherwise. Modules receive them in
 * `verificationReads`.
 *
 * Records and inputs are typed from the field specs (`RecordOf`, repositories/fieldSpecs.ts); the typers take unknown
 * input and return those records.
 *
 * References. Player and guardian ids carry no key (tolerant, as recruitment, scouting and verification: an account
 * deletion leaves these rows under the old id). A confirmation's organisation → orgs is an immediate RESTRICT
 * key; the preferences' child rows cascade with their preferences.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
  isPlainObject,
  describe,
  text,
  int,
  oneOf,
  date,
  group,
  quote,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  insertSql,
  upsertSql,
  type FieldOptions,
  type RecordOf,
  type Refusal,
  type Spec,
  type Typed,
} from './fieldSpecs.ts';
import { migrationApplied, childRowsOf, operationOn, type Row, type UnitParticipant } from './database.ts';
import { readsOf, refusal } from './identityRules.ts';
import { writeKit, type Flatten, type InputWith } from './writes.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';
import { PLAYER_POSITIONS, type PlayerPosition } from './playerRecord.ts';

export const PASSPORT_MIGRATION = '0024_passport';
export const PASSPORT_COLLECTIONS = Object.freeze([
  'passportPrefs',
  'passportCareerEntries',
  'passportAchievements',
  'passportShares',
  'passportCorrections',
] as const);
export type PassportCollection = (typeof PASSPORT_COLLECTIONS)[number];

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const AVAILABILITY = Object.freeze(['open_to_trials', 'open_to_contact', 'not_looking'] as const);
export const SUBMITTERS = Object.freeze(['player', 'guardian'] as const);
export const SHARE_MODES = Object.freeze(['public', 'recruitment'] as const);
export const CORRECTION_TARGETS = Object.freeze([
  'timeline_event',
  'career_entry',
  'club_history',
  'reference',
  'trial',
  'assessment',
  'achievement',
  'signing',
] as const);
export const CORRECTION_OUTCOMES = Object.freeze(['corrected', 'rejected', 'referred'] as const);
export type Availability = (typeof AVAILABILITY)[number];
export type Submitter = (typeof SUBMITTERS)[number];
export type ShareMode = (typeof SHARE_MODES)[number];
export type CorrectionTarget = (typeof CORRECTION_TARGETS)[number];
export type CorrectionOutcome = (typeof CORRECTION_OUTCOMES)[number];
/** Text limits: the routes shorten free text to these; ids, codes and lists over them are refused. */
export const PASSPORT_LIMITS = Object.freeze({
  id: 80,
  bio: 400,
  orgName: 100,
  role: 60,
  note: 200,
  title: 120,
  reason: 500,
  resolutionReason: 400,
  targetId: 80,
  selection: 120,
  selections: 100,
  secondary: 3,
  name: 200,
  shareDays: { min: 1, max: 90, default: 30 },
});
const L = PASSPORT_LIMITS;

// ------------------------------------------------------------------ field specs
const idf = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) =>
  text(k, c, L.id, o);
const position = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) =>
  oneOf(k, c, PLAYER_POSITIONS, o);
const PREFS_SPEC = [
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('bio', 'bio', L.bio),
  position('primaryPosition', 'position_primary'),
  oneOf('availability', 'availability', AVAILABILITY),
  date('availableFrom', 'available_from'),
  int('updatedAt', 'updated_at', { req: true }),
] as const;
const HISTORY_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  date('from', 'from_date', { req: true }),
  position('primary', 'position_primary', { req: true }),
  oneOf('submittedBy', 'submitted_by', SUBMITTERS, { req: true }),
  int('recordedAt', 'recorded_at', { req: true }),
] as const;
const CAREER_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('orgName', 'org_name', L.orgName, { req: true, nonEmpty: true }),
  text('role', 'role', L.role),
  date('from', 'from_date', { req: true }),
  date('to', 'to_date'),
  text('note', 'note', L.note),
  oneOf('submittedBy', 'submitted_by', SUBMITTERS, { req: true }),
  int('createdAt', 'created_at', { req: true }),
  int('withdrawnAt', 'withdrawn_at'),
] as const;
const ACHIEVEMENT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  text('orgName', 'org_name', L.orgName),
  date('when', 'when_date'),
  oneOf('submittedBy', 'submitted_by', SUBMITTERS, { req: true }),
  group(
    'confirmation',
    [
      oneOf('provenance', 'confirmation_provenance', ['verified_club_confirmed'], { req: true }),
      idf('orgId', 'confirmation_org_id', { req: true, nonEmpty: true }),
      text('orgName', 'confirmation_org_name', L.name, { req: true }),
      text('byName', 'confirmation_by_name', L.name),
      int('at', 'confirmation_at', { req: true }),
    ],
    { nullable: true },
  ),
  int('createdAt', 'created_at', { req: true }),
  int('withdrawnAt', 'withdrawn_at'),
] as const;
const SHARE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  oneOf('mode', 'mode', SHARE_MODES, { req: true }),
  text('tokenHash', 'token_hash', 64, { req: true, nonEmpty: true }),
  group('createdBy', [
    oneOf('kind', 'created_by_kind', SUBMITTERS, { req: true }),
    idf('id', 'created_by_id', { req: true, nonEmpty: true }),
  ]),
  int('createdAt', 'created_at', { req: true }),
  int('expiresAt', 'expires_at', { req: true }),
  int('revokedAt', 'revoked_at'),
  group(
    'revokedBy',
    [
      oneOf('kind', 'revoked_by_kind', [...SUBMITTERS, 'trust_safety'], { req: true }),
      idf('id', 'revoked_by_id', { req: true, nonEmpty: true }),
    ],
    { nullable: true },
  ),
  int('views', 'views', { req: true, def: 0 }),
] as const;
const CORRECTION_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  oneOf('targetType', 'target_kind', CORRECTION_TARGETS, { req: true }),
  text('targetId', 'target_id', L.targetId),
  text('reason', 'reason', L.reason, { req: true, nonEmpty: true }),
  group('by', [
    oneOf('kind', 'by_kind', SUBMITTERS, { req: true }),
    idf('id', 'by_id', { req: true, nonEmpty: true }),
    text('name', 'by_name', L.name),
  ]),
  oneOf('status', 'status', ['open', 'resolved'], { req: true }),
  group(
    'resolution',
    [
      oneOf('outcome', 'resolution_outcome', CORRECTION_OUTCOMES, { req: true }),
      text('reason', 'resolution_reason', L.resolutionReason, { req: true, nonEmpty: true }),
      int('at', 'resolved_at', { req: true }),
    ],
    { nullable: true },
  ),
  int('createdAt', 'created_at', { req: true }),
] as const;

// ------------------------------------------------------------------ the records
/** A player's positions: a primary and up to L.secondary others, or null when neither is set. */
export type Positions = { primary: PlayerPosition | null; secondary: PlayerPosition[] };
type HistoryRecord = Flatten<RecordOf<typeof HISTORY_SPEC> & { secondary: PlayerPosition[] }>;
type PrefsRecord = Flatten<
  Omit<RecordOf<typeof PREFS_SPEC>, 'primaryPosition'> & {
    positions: Positions | null;
    positionHistory: HistoryRecord[];
    publicSelections: string[];
  }
>;
type CorrectionRecord = Flatten<RecordOf<typeof CORRECTION_SPEC> & { resolvedAt: number | null }>;
/** Each collection's record as read back (before it is frozen). */
type Records = {
  passportPrefs: PrefsRecord;
  passportCareerEntries: RecordOf<typeof CAREER_SPEC>;
  passportAchievements: RecordOf<typeof ACHIEVEMENT_SPEC>;
  passportShares: RecordOf<typeof SHARE_SPEC>;
  passportCorrections: CorrectionRecord;
};
export type PassportRecord<N extends PassportCollection> = DeepReadonly<Records[N]>;
export type PassportPrefs = PassportRecord<'passportPrefs'>;
export type PositionHistoryEntry = DeepReadonly<HistoryRecord>;
export type CareerEntry = PassportRecord<'passportCareerEntries'>;
export type Achievement = PassportRecord<'passportAchievements'>;
export type PassportShare = PassportRecord<'passportShares'>;
export type CorrectionRequest = PassportRecord<'passportCorrections'>;
/** The preferences of a player who never saved any (`blankPrefs`): nothing set, never saved. */
export type BlankPrefs = Flatten<Omit<PrefsRecord, 'updatedAt'> & { updatedAt: null }>;
/** The whole domain as plain records (`PASSPORT_RECORDS.read`). */
export type PassportRecords = { [N in PassportCollection]: Records[N][] };

export type PositionHistoryInput = InputWith<HistoryRecord>;
export type PassportPrefsInput = InputWith<PrefsRecord>;
export type CareerEntryInput = InputWith<Records['passportCareerEntries']>;
export type AchievementInput = InputWith<Records['passportAchievements']>;
export type AchievementConfirmation = NonNullable<AchievementInput['confirmation']>;
export type PassportShareInput = InputWith<Records['passportShares'], 'views'>;
export type ShareRevoker = NonNullable<Records['passportShares']['revokedBy']>;
/** A correction: `resolvedAt`, when given, must be the resolution's instant. */
export type CorrectionRequestInput = InputWith<RecordOf<typeof CORRECTION_SPEC>> & { resolvedAt?: number | null };
/** What a preferences save may change (`passportPrefs.save`): not the player, the history or the time. */
export type PassportPrefsChange = Partial<
  Pick<PassportPrefsInput, 'bio' | 'positions' | 'availability' | 'availableFrom' | 'publicSelections'>
>;
export type PassportPrefsSave = {
  set?: PassportPrefsChange;
  /** Position-history entries added after the stored ones. */
  history?: readonly PositionHistoryInput[];
  at: number;
};
/** A page of records by cursor: `after` is the previous page's last key (`[rowid]`). */
export type PassportPageRequest = { limit: number; after?: readonly [number] | null };
export type PassportPage<T> = { rows: { key: [number]; record: T }[] };

// ------------------------------------------------------------------ DDL (generated from the specs)
const codeList = (
  name: string,
  owner: string,
  ownerTable: string,
  ownerCol: string,
  col: string,
  check: string,
) => `CREATE TABLE ${name} (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(${ownerCol}) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  ${col}    TEXT NOT NULL CHECK (${check}),
  PRIMARY KEY (${owner}, ord),
  UNIQUE (${owner}, ${col})
) STRICT;`;
const POSITION_CHECK = (c: string) => `${c} IN (${PLAYER_POSITIONS.map(quote).join(',')})`;
export const PASSPORT_DDL = [
  tableDdl('passport_prefs', PREFS_SPEC, ['PRIMARY KEY (player_id)']),
  codeList(
    'passport_pref_positions',
    'player_id',
    'passport_prefs',
    'player_id',
    'code',
    `${POSITION_CHECK('code')} AND ord < ${L.secondary}`,
  ),
  tableDdl(
    'passport_position_history',
    [
      ...HISTORY_SPEC.slice(0, 1),
      idf('playerId', 'player_id', { req: true, nonEmpty: true }),
      ...HISTORY_SPEC.slice(1),
    ],
    ['FOREIGN KEY (player_id) REFERENCES passport_prefs(player_id) ON DELETE CASCADE'],
  ),
  'CREATE INDEX passport_position_history_player ON passport_position_history (player_id);',
  codeList(
    'passport_position_history_positions',
    'history_id',
    'passport_position_history',
    'id',
    'code',
    `${POSITION_CHECK('code')} AND ord < ${L.secondary}`,
  ),
  codeList(
    'passport_public_selections',
    'player_id',
    'passport_prefs',
    'player_id',
    'selection',
    `length(selection) > 0 AND length(selection) <= ${L.selection} AND ord < ${L.selections}`,
  ),
  tableDdl('passport_career_entries', CAREER_SPEC),
  'CREATE INDEX passport_career_entries_player ON passport_career_entries (player_id);',
  tableDdl('passport_achievements', ACHIEVEMENT_SPEC, [
    'FOREIGN KEY (confirmation_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX passport_achievements_player ON passport_achievements (player_id);',
  tableDdl('passport_shares', SHARE_SPEC, [
    'CHECK (length(token_hash) = 64)',
    'CHECK (views >= 0)',
    'CHECK ((revoked_at IS NULL) = (revoked_by_kind IS NULL))',
  ]),
  'CREATE UNIQUE INDEX passport_shares_token_hash ON passport_shares (token_hash);',
  'CREATE INDEX passport_shares_player ON passport_shares (player_id);',
  tableDdl('passport_corrections', CORRECTION_SPEC, [
    "CHECK ((status = 'resolved') = (resolution_outcome IS NOT NULL))",
  ]),
  'CREATE INDEX passport_corrections_status ON passport_corrections (status);',
  'CREATE INDEX passport_corrections_player ON passport_corrections (player_id);',
].join('\n');
export const PASSPORT_TABLES = Object.freeze([
  'passport_prefs',
  'passport_pref_positions',
  'passport_position_history',
  'passport_position_history_positions',
  'passport_public_selections',
  'passport_career_entries',
  'passport_achievements',
  'passport_shares',
  'passport_corrections',
] as const);

// ------------------------------------------------------------------ typing
export { refusal };
const labelOf = (at: string, raw: unknown, key = 'id') =>
  `${at} ${isPlainObject(raw) && typeof raw[key] === 'string' ? raw[key] : ''}`.trim();
function typeList<T>(
  list: unknown,
  at: string,
  field: string,
  max: number,
  ok: (x: unknown) => x is T,
  what: string,
): { ok: true; list: T[] } | Refusal {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list)) return bad(at, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(at, field, `holds more than ${max} entries`);
  const i = list.findIndex((x) => !ok(x));
  if (i >= 0) return bad(at, `${field}[${i}]`, `must be ${what} (got ${describe(list[i])})`);
  if (new Set(list).size !== list.length) return bad(at, field, 'names an entry twice');
  return { ok: true, list: [...list] };
}
const isPosition = (x: unknown): x is PlayerPosition => (PLAYER_POSITIONS as readonly unknown[]).includes(x);
const typePositions = (list: unknown, at: string, field: string) =>
  typeList(list, at, field, L.secondary, isPosition, `a position code (${PLAYER_POSITIONS.join('|')})`);
const isSelection = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= L.selection;

/** The preferences of a player who never saved any. */
export const blankPrefs = (playerId: string): BlankPrefs => ({
  playerId,
  bio: null,
  positions: null,
  positionHistory: [],
  availability: null,
  availableFrom: null,
  publicSelections: [],
  updatedAt: null,
});

export function typePrefs(raw: unknown, at = 'passportPrefs'): Typed<PrefsRecord> {
  const label = labelOf(at, raw, 'playerId');
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { positions, positionHistory, publicSelections, ...flatPart } = raw;
  // positions: null, or { primary, secondary[] }; an object with neither is stored (and read back) as null.
  let primary: PlayerPosition | null = null;
  let secondary: PlayerPosition[] = [];
  if (positions !== undefined && positions !== null) {
    if (!isPlainObject(positions))
      return bad(label, 'positions', `must be an object or null (got ${describe(positions)})`);
    const unknown = Object.keys(positions).filter((k) => k !== 'primary' && k !== 'secondary');
    if (unknown.length)
      return bad(label, 'positions', `carries field(s) this build does not store: ${unknown.join(', ')}`);
    if (positions.primary != null && !isPosition(positions.primary))
      return bad(
        label,
        'positions.primary',
        `must be a position code (${PLAYER_POSITIONS.join('|')}) (got ${describe(positions.primary)})`,
      );
    primary = (positions.primary as PlayerPosition | null | undefined) ?? null;
    const s = typePositions(positions.secondary, label, 'positions.secondary');
    if (!s.ok) return s;
    secondary = s.list;
  }
  const t = typeSpec(PREFS_SPEC, { ...flatPart, primaryPosition: primary }, label);
  if (!t.ok) return t;
  if (!Array.isArray(positionHistory ?? []))
    return bad(label, 'positionHistory', `must be a list (got ${describe(positionHistory)})`);
  const history: HistoryRecord[] = [];
  for (const [i, h] of ((positionHistory ?? []) as unknown[]).entries()) {
    const { secondary: hs, ...hFlat } = isPlainObject(h) ? h : {};
    if (!isPlainObject(h)) return bad(label, `positionHistory[${i}]`, `must be an object (got ${describe(h)})`);
    const ht = typeSpec(HISTORY_SPEC, hFlat, `${label}.positionHistory[${i}]`);
    if (!ht.ok) return ht;
    const hp = typePositions(hs, `${label}.positionHistory[${i}]`, 'secondary');
    if (!hp.ok) return hp;
    history.push({ ...ht.record, secondary: hp.list });
  }
  if (new Set(history.map((h) => h.id)).size !== history.length)
    return bad(label, 'positionHistory', 'names an id twice');
  const sel = typeList(
    publicSelections,
    label,
    'publicSelections',
    L.selections,
    isSelection,
    `an id of at most ${L.selection} characters`,
  );
  if (!sel.ok) return sel;
  const { primaryPosition, ...rest } = t.record;
  return {
    ok: true,
    record: {
      ...rest,
      positions: primaryPosition || secondary.length ? { primary: primaryPosition, secondary } : null,
      positionHistory: history,
      publicSelections: sel.list,
    },
  };
}
const simpleTyper =
  <S extends Spec>(spec: S, fallback: string) =>
  (raw: unknown, at = fallback): Typed<RecordOf<S>> =>
    typeSpec(spec, raw, labelOf(at, raw));
export const typeCareerEntry = simpleTyper(CAREER_SPEC, 'passportCareerEntries');
export const typeAchievement = simpleTyper(ACHIEVEMENT_SPEC, 'passportAchievements');
export const typeShare = simpleTyper(SHARE_SPEC, 'passportShares');
/** A correction: `resolvedAt` is the resolution's instant (one column), accepted when it agrees. */
export function typeCorrection(raw: unknown, at = 'passportCorrections'): Typed<CorrectionRecord> {
  const label = labelOf(at, raw);
  const t = typeSpec(CORRECTION_SPEC, raw, label, ['resolvedAt']);
  if (!t.ok) return t;
  const resolvedAt = t.record.resolution?.at ?? null;
  // typeSpec refused anything but an object.
  const given = (raw as { resolvedAt?: unknown }).resolvedAt;
  if (given !== undefined && given !== resolvedAt) return bad(label, 'resolvedAt', "must be the resolution's instant");
  if ((t.record.status === 'resolved') !== (t.record.resolution !== null))
    return bad(label, 'resolution', 'is set exactly when the correction is resolved');
  return { ok: true, record: { ...t.record, resolvedAt } };
}

// ------------------------------------------------------------------ rows
type FlatCollection = Exclude<PassportCollection, 'passportPrefs'>;
type FlatEntity<N extends FlatCollection> = {
  table: string;
  spec: Spec;
  type: (raw: unknown, at?: string) => Typed<Records[N]>;
};
const ENTITIES: { readonly [N in FlatCollection]: FlatEntity<N> } = {
  passportCareerEntries: {
    table: 'passport_career_entries',
    spec: CAREER_SPEC,
    type: typeCareerEntry,
  },
  passportAchievements: {
    table: 'passport_achievements',
    spec: ACHIEVEMENT_SPEC,
    type: typeAchievement,
  },
  passportShares: {
    table: 'passport_shares',
    spec: SHARE_SPEC,
    type: typeShare,
  },
  passportCorrections: {
    table: 'passport_corrections',
    spec: CORRECTION_SPEC,
    type: typeCorrection,
  },
};
const FLAT_COLLECTIONS = Object.keys(ENTITIES) as FlatCollection[];
const decodeFlat = <N extends FlatCollection>(name: N, row: Row): Records[N] => {
  const rec = decode(ENTITIES[name].spec, row) as Record<string, unknown>;
  if (name === 'passportCorrections') rec.resolvedAt = (rec as RecordOf<typeof CORRECTION_SPEC>).resolution?.at ?? null;
  return rec as Records[N];
};
const encodeFlat = <N extends FlatCollection>(name: N, rec: Records[N]) => {
  const { resolvedAt: _r, ...r } = rec as Records[N] & { resolvedAt?: unknown };
  return encode(ENTITIES[name].spec, r);
};

type PrefsStatements = Record<
  'upsert' | 'byPlayer' | 'all' | 'posDel' | 'posIns' | 'histIns' | 'histPosIns' | 'selDel' | 'selIns',
  StatementSync
>;
function prefsStatements(sqlite: DatabaseSync): PrefsStatements {
  return {
    upsert: sqlite.prepare(upsertSql('passport_prefs', PREFS_SPEC, ['player_id'])),
    byPlayer: sqlite.prepare('SELECT * FROM passport_prefs WHERE player_id = ?'),
    all: sqlite.prepare('SELECT * FROM passport_prefs ORDER BY rowid'),
    posDel: sqlite.prepare('DELETE FROM passport_pref_positions WHERE player_id = ?'),
    posIns: sqlite.prepare('INSERT INTO passport_pref_positions (player_id, ord, code) VALUES (?, ?, ?)'),
    histIns: sqlite.prepare(
      'INSERT INTO passport_position_history (id, player_id, from_date, position_primary, submitted_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    histPosIns: sqlite.prepare(
      'INSERT INTO passport_position_history_positions (history_id, ord, code) VALUES (?, ?, ?)',
    ),
    selDel: sqlite.prepare('DELETE FROM passport_public_selections WHERE player_id = ?'),
    selIns: sqlite.prepare('INSERT INTO passport_public_selections (player_id, ord, selection) VALUES (?, ?, ?)'),
  };
}
function decodePrefs(sqlite: DatabaseSync, rows: Row[]): PrefsRecord[] {
  const pids = rows.map((r) => r.player_id as string);
  const pos = childRowsOf(sqlite, 'passport_pref_positions', 'player_id', pids, { order: 'ord' });
  const hist = childRowsOf(sqlite, 'passport_position_history', 'player_id', pids, { order: 'rowid' });
  const histPos = childRowsOf(
    sqlite,
    'passport_position_history_positions',
    'history_id',
    pids.flatMap((p) => hist.all(p).map((h) => h.id as string)),
    { order: 'ord' },
  );
  const sel = childRowsOf(sqlite, 'passport_public_selections', 'player_id', pids, { order: 'ord' });
  return rows.map((row) => {
    const pid = row.player_id as string;
    const { primaryPosition, ...rec } = decode(PREFS_SPEC, row);
    const secondary = pos.all(pid).map((r) => r.code as PlayerPosition);
    return {
      ...rec,
      positions: primaryPosition || secondary.length ? { primary: primaryPosition, secondary } : null,
      positionHistory: hist.all(pid).map((h) => ({
        ...decode(HISTORY_SPEC, h),
        secondary: histPos.all(h.id as string).map((r) => r.code as PlayerPosition),
      })),
      publicSelections: sel.all(pid).map((r) => r.selection as string),
    };
  });
}
/** Write a typed preferences record; `knownHistory` is the ids already stored (the history only grows). */
function writePrefs(st: PrefsStatements, rec: PrefsRecord, knownHistory: ReadonlySet<string> = new Set()) {
  st.upsert.run(encode(PREFS_SPEC, { ...rec, primaryPosition: rec.positions?.primary ?? null }));
  st.posDel.run(rec.playerId);
  (rec.positions?.secondary ?? []).forEach((c, i) => st.posIns.run(rec.playerId, i, c));
  for (const h of rec.positionHistory) {
    if (knownHistory.has(h.id)) continue;
    st.histIns.run(h.id, rec.playerId, h.from, h.primary, h.submittedBy, h.recordedAt);
    h.secondary.forEach((c, i) => st.histPosIns.run(h.id, i, c));
  }
  st.selDel.run(rec.playerId);
  rec.publicSelections.forEach((s, i) => st.selIns.run(rec.playerId, i, s));
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const passportLive = (sqlite: DatabaseSync): boolean => migrationApplied(sqlite, PASSPORT_MIGRATION);
function readAll(sqlite: DatabaseSync): PassportRecords {
  const out: Partial<Record<PassportCollection, unknown[]>> = {
    passportPrefs: decodePrefs(sqlite, prefsStatements(sqlite).all.all()),
  };
  for (const name of FLAT_COLLECTIONS)
    out[name] = sqlite
      .prepare(`SELECT * FROM ${ENTITIES[name].table} ORDER BY rowid`)
      .all()
      .map((r) => decodeFlat(name, r));
  return out as PassportRecords;
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const PASSPORT_RECORDS = {
  names: PASSPORT_COLLECTIONS,
  read(sqlite: DatabaseSync): PassportRecords | null {
    return passportLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL = PASSPORT_COLLECTIONS.map((n) =>
  n === 'passportPrefs' ? 'SELECT player_id AS pid FROM passport_prefs' : `SELECT player_id FROM ${ENTITIES[n].table}`,
).join(' UNION ALL ');
const playerRefCount = (sqlite: DatabaseSync, cond: string): number =>
  (sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get() as { n: number }).n;
export const unresolvedPlayerReferences = (sqlite: DatabaseSync): { passport: number } | null =>
  passportLive(sqlite)
    ? { passport: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') }
    : null;
export const retainedPlayerReferences = (sqlite: DatabaseSync): { passport: number } | null =>
  passportLive(sqlite)
    ? {
        passport: playerRefCount(
          sqlite,
          'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)',
        ),
      }
    : null;

// ------------------------------------------------------------------ the repository
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/**
 * `createPassportRepository({ sqlite, unit, now, log })`: `passportPrefs`, `careerEntries`, `achievements`, `shares` and
 * `corrections`, each with its writes and queries, plus `reads` (the queries alone, merged into `verificationReads`).
 */
export function createPassportRepository(
  {
    sqlite,
    unit = null,
    now = Date.now,
    log = () => {},
  }: {
    sqlite: DatabaseSync;
    unit?: UnitParticipant | null;
    now?: () => number;
    log?: (message: string) => void;
  } = {} as { sqlite: DatabaseSync },
) {
  if (!sqlite) throw new TypeError('the passport repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const cache = new Map<string, StatementSync>();
  const q = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const ps = prefsStatements(sqlite);
  // ---- preferences
  const prefsOf = (playerId: unknown): PassportPrefs | null => {
    const row = typeof playerId === 'string' ? ps.byPlayer.get(playerId) : null;
    return row ? deepFreeze(decodePrefs(sqlite, [row])[0]) : null;
  };
  const passportPrefs = {
    /** The player's saved preferences, or null when nobody saved any (use `blankPrefs`). */
    forPlayer: prefsOf,
    /**
     * Save the player's preferences at `at`: `set` names the fields that change (bio, positions, availability,
     * availableFrom, publicSelections), `history` the position-history entries added after the stored ones. The
     * result is typed whole and written at once; a stored history entry never changes or goes.
     */
    save: (playerId: string, { set = {}, history = [], at }: PassportPrefsSave): PassportPrefs =>
      operation(() => {
        const change: unknown = set;
        if (!isPlainObject(change) || 'playerId' in change || 'positionHistory' in change || 'updatedAt' in change)
          throw refusal(
            'PASSPORT_INPUT_INVALID',
            `passport_prefs ${playerId}: set names the preferences a save changes (not the player, the history or the time)`,
          );
        if (!Array.isArray(history))
          throw refusal('PASSPORT_INPUT_INVALID', `passport_prefs ${playerId}: history must be a list`);
        const stored = prefsOf(playerId);
        const base = clone((stored ?? blankPrefs(playerId)) as BlankPrefs | PrefsRecord);
        const t = typePrefs({
          ...base,
          ...change,
          positionHistory: [...base.positionHistory, ...history],
          updatedAt: at,
        });
        if (!t.ok) throw refusal('PASSPORT_INPUT_INVALID', t.reason);
        // The history was typed with the record, so each entry is an object with an id.
        const taken = (history as readonly { id: string }[]).find((h) =>
          q('SELECT 1 FROM passport_position_history WHERE id = ?').get(h?.id),
        );
        if (taken) throw refusal('PASSPORT_DUPLICATE', `passport_position_history ${taken.id} already exists`);
        writePrefs(ps, t.record, new Set(base.positionHistory.map((h) => h.id)));
        return prefsOf(playerId) as PassportPrefs;
      }),
  };

  // ---- the flat records
  const read = <N extends FlatCollection>(name: N, id: unknown): PassportRecord<N> | null => {
    if (typeof id !== 'string') return null;
    const row = q(`SELECT * FROM ${ENTITIES[name].table} WHERE id = ?`).get(id);
    return row ? deepFreeze(decodeFlat(name, row)) : null;
  };
  const all = <N extends FlatCollection>(name: N, where: string, ...args: SQLInputValue[]): PassportRecord<N>[] =>
    q(`SELECT * FROM ${ENTITIES[name].table} WHERE ${where} ORDER BY rowid`)
      .all(...args)
      .map((r) => deepFreeze(decodeFlat(name, r)));
  const typedOr = <N extends FlatCollection>(name: N, raw: unknown): Records[N] => {
    const t = ENTITIES[name].type(raw, name);
    if (!t.ok) throw refusal('PASSPORT_INPUT_INVALID', t.reason);
    return t.record;
  };
  const insertOf = <N extends FlatCollection>(name: N) => q(insertSql(ENTITIES[name].table, ENTITIES[name].spec));
  /** `create(record)`: typed whole; an existing id is refused before the insert. */
  const create =
    <N extends FlatCollection, I>(name: N) =>
    (raw: I): PassportRecord<N> =>
      operation(() => {
        const r = typedOr(name, raw);
        if (read(name, r.id)) throw refusal('PASSPORT_DUPLICATE', `${ENTITIES[name].table} ${r.id} already exists`);
        insertOf(name).run(encodeFlat(name, r));
        return read(name, r.id) as PassportRecord<N>;
      });
  const { guarded, columnsOf } = writeKit(sqlite, 'PASSPORT');
  /**
   * An act that sets `fields` of record `id` while `where` holds: the record is typed with them (and the `derived`
   * fields a read works out from them), then only their columns are written. A record the guard no longer matches is refused with `what` (PASSPORT_STATE_CONFLICT).
   */
  const setFields = <N extends FlatCollection>(
    name: N,
    id: string,
    fields: Record<string, unknown>,
    where: string,
    what: string,
    derived: Record<string, unknown> = {},
  ): PassportRecord<N> =>
    operation(() => {
      const { table, spec } = ENTITIES[name];
      const stored = read(name, id);
      if (!stored) throw refusal('PASSPORT_NOT_FOUND', `${table} ${id} is not a record of the repository`);
      typedOr(name, { ...clone(stored), ...fields, ...derived });
      guarded(table, { id }, where, columnsOf(table, id, spec, fields, { only: new Set(Object.keys(fields)) }), what);
      return read(name, id) as PassportRecord<N>;
    });

  const paged =
    <N extends FlatCollection>(name: N, where: string, desc: boolean) =>
    (args: SQLInputValue[], { limit, after = null }: PassportPageRequest): PassportPage<PassportRecord<N>> => {
      const rows = q(
        `SELECT rowid AS rid, * FROM ${ENTITIES[name].table} WHERE ${where} AND (? IS NULL OR rowid ${desc ? '<' : '>'} ?) ORDER BY rowid ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
      ).all(...args, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      return { rows: rows.map((r) => ({ key: [r.rid as number], record: deepFreeze(decodeFlat(name, r)) })) };
    };

  const careerEntries = {
    create: create<'passportCareerEntries', CareerEntryInput>('passportCareerEntries'),
    /** The player withdraws a self-submitted entry at `at`, once. */
    withdraw: (id: string, { at }: { at: number }): CareerEntry =>
      setFields(
        'passportCareerEntries',
        id,
        { withdrawnAt: at },
        'withdrawn_at IS NULL',
        `passport_career_entries ${id} is already withdrawn`,
      ),
    byId: (id: unknown): CareerEntry | null => read('passportCareerEntries', id),
    forPlayer: (playerId: string): CareerEntry[] => all('passportCareerEntries', 'player_id = ?', playerId),
  };
  const achievements = {
    create: create<'passportAchievements', AchievementInput>('passportAchievements'),
    /** The player withdraws an unconfirmed achievement at `at`, once; a confirmed one is part of the record. */
    withdraw: (id: string, { at }: { at: number }): Achievement =>
      setFields(
        'passportAchievements',
        id,
        { withdrawnAt: at },
        'withdrawn_at IS NULL AND confirmation_at IS NULL',
        `passport_achievements ${id} is withdrawn or confirmed`,
      ),
    /** A verified club confirms a standing achievement, once. */
    confirm: (id: string, { confirmation }: { confirmation: AchievementConfirmation }): Achievement =>
      setFields(
        'passportAchievements',
        id,
        { confirmation },
        'withdrawn_at IS NULL AND confirmation_at IS NULL',
        `passport_achievements ${id} is withdrawn or already confirmed`,
      ),
    byId: (id: unknown): Achievement | null => read('passportAchievements', id),
    forPlayer: (playerId: string): Achievement[] => all('passportAchievements', 'player_id = ?', playerId),
  };
  const sharesPage = paged('passportShares', '1 = 1', true);
  const shares = {
    create: create<'passportShares', PassportShareInput>('passportShares'),
    /** Revoke a share link at `at`, by `by` (`{ kind, id }`), once. */
    revoke: (id: string, { at, by }: { at: number; by: ShareRevoker }): PassportShare =>
      setFields(
        'passportShares',
        id,
        { revokedAt: at, revokedBy: by },
        'revoked_at IS NULL',
        `passport_shares ${id} is already revoked`,
      ),
    byId: (id: unknown): PassportShare | null => read('passportShares', id),
    byHash: (hash: string): PassportShare | null => {
      const row = q('SELECT * FROM passport_shares WHERE token_hash = ?').get(hash);
      return row ? deepFreeze(decodeFlat('passportShares', row)) : null;
    },
    forPlayer: (playerId: string): PassportShare[] => all('passportShares', 'player_id = ?', playerId),
    /** The player's shares neither revoked nor expired at `at`. */
    activeCount: (playerId: string, at: number): number =>
      (
        q(
          'SELECT COUNT(*) AS n FROM passport_shares WHERE player_id = ? AND revoked_at IS NULL AND expires_at > ?',
        ).get(playerId, at) as { n: number }
      ).n,
    /** Every share, newest first, by cursor (`after` is the previous page's last `[rowid]`): the T&S list. */
    page: (opts: PassportPageRequest): PassportPage<PassportShare> => sharesPage([], opts),
    /** Count one successful opening of share `id`. */
    recordView: (id: string): void =>
      operation(() => {
        q('UPDATE passport_shares SET views = views + 1 WHERE id = ?').run(id);
      }),
  };
  const openPage = paged('passportCorrections', "status = 'open'", false);
  const allPage = paged('passportCorrections', '1 = 1', false);
  const corrections = {
    create: create<'passportCorrections', CorrectionRequestInput>('passportCorrections'),
    /** Trust & Safety resolves an open correction request (`{ outcome, reason, at }`), once. */
    resolve: (
      id: string,
      { outcome, reason, at }: { outcome: CorrectionOutcome; reason: string; at: number },
    ): CorrectionRequest =>
      setFields(
        'passportCorrections',
        id,
        { status: 'resolved', resolution: { outcome, reason, at } },
        "status = 'open'",
        `passport_corrections ${id} is already resolved`,
        { resolvedAt: at },
      ),
    byId: (id: unknown): CorrectionRequest | null => read('passportCorrections', id),
    /** The T&S queue, oldest first, by cursor: open corrections, or every correction with `all`. */
    page: ({ all = false, ...opts }: PassportPageRequest & { all?: boolean }): PassportPage<CorrectionRequest> =>
      (all ? allPage : openPage)([], opts),
  };

  const counters = {
    passportPrefs: q('SELECT COUNT(*) AS n FROM passport_prefs'),
    ...Object.fromEntries(FLAT_COLLECTIONS.map((n) => [n, q(`SELECT COUNT(*) AS n FROM ${ENTITIES[n].table}`)])),
  } as Record<PassportCollection, StatementSync>;
  const counts = () =>
    Object.fromEntries(PASSPORT_COLLECTIONS.map((n) => [n, (counters[n].get() as { n: number }).n])) as Record<
      PassportCollection,
      number
    >;
  return {
    passportPrefs,
    careerEntries,
    achievements,
    shares,
    corrections,
    /** The queries alone, for modules and projectors that must not write (merged into `verificationReads`). */
    reads: Object.freeze({
      passportPrefs: readsOf(passportPrefs, ['save']),
      careerEntries: readsOf(careerEntries, ['create', 'withdraw']),
      achievements: readsOf(achievements, ['create', 'withdraw', 'confirm']),
      shares: readsOf(shares, ['create', 'revoke', 'recordView']),
      corrections: readsOf(corrections, ['create', 'resolve']),
    }),
    attach(): { counts: Record<PassportCollection, number> } {
      if (!passportLive(sqlite))
        throw new Error(
          `the passport repository needs ${PASSPORT_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll(): PassportRecords | null {
      return PASSPORT_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type PassportRepository = ReturnType<typeof createPassportRepository>;
export type PassportReads = PassportRepository['reads'];
