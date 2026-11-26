/**
 * Organisation staff (`org_users`, `org_user_recovery_codes`).
 *
 * Record (`Staff`): { id, orgId, name, role, email, ssoSubject, createdAt, removedAt, removedById, provenance,
 *   mfa: null | { enabledAt },                       enabledAt null: set up but not yet confirmed
 *   deliveryPrefs: { quietStart, quietEnd, channels: { email } } }
 * The TOTP secret and the recovery-code hashes are never on a record: `mfaSecretOf` gives the secret to the code
 * checks and `useRecoveryCode` spends a code. Responses are allowlists, never the record.
 *
 * Staff are removed softly (`removed_at`), never deleted by a route. Staff sign in by name, so a name is unique in its
 * organisation (case-insensitive, removed staff included; the repository writes `name_key`); an e-mail is unique among
 * an organisation's current staff, an SSO subject within an organisation. `org_id` and `removed_by_id` are RESTRICT
 * keys; `(id, org_id)` is unique so an org session can name its staff member and organisation together.
 *
 * Refusals carry a code and name the id and the field, never a value.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { migrationApplied, type UnitParticipant } from './database.ts';
import type { DeepReadonly } from '../domains/platform/values.ts';
import { deepFreeze } from '../domains/platform/values.ts';
import { isPlainObject } from './fieldSpecs.ts';
import { refusal, identityKit, readsOf, isClock, type IdentityRefusal } from './identityRules.ts';

export const USERS_MIGRATION = '0001_org_users';
export const STAFF_LIMITS = Object.freeze({ id: 80, name: 120, role: 60, email: 254, ssoSubject: 255, secret: 128 });
export const STAFF_PROVENANCES = Object.freeze(['org_password_bootstrap'] as const);
export type StaffProvenance = (typeof STAFF_PROVENANCES)[number];
const L = STAFF_LIMITS;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_CHECK = (c: string) =>
  `CHECK (${c} IS NULL OR ${c} GLOB '[01][0-9]:[0-5][0-9]' OR ${c} GLOB '2[0-3]:[0-5][0-9]')`;

export const ORG_USERS_DDL = `
CREATE TABLE org_users (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND ${L.id}),
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  name_key       TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND ${L.role}),
  email          TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND ${L.email}),
  sso_subject    TEXT CHECK (sso_subject IS NULL OR length(sso_subject) BETWEEN 1 AND ${L.ssoSubject}),
  created_at     INTEGER NOT NULL,
  removed_at     INTEGER,
  removed_by_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  provenance     TEXT CHECK (provenance IS NULL OR provenance IN (${STAFF_PROVENANCES.map((p) => `'${p}'`).join(', ')})),
  mfa_secret     TEXT CHECK (mfa_secret IS NULL OR length(mfa_secret) BETWEEN 16 AND ${L.secret}),
  mfa_enabled_at INTEGER,
  quiet_start    TEXT ${HHMM_CHECK('quiet_start')},
  quiet_end      TEXT ${HHMM_CHECK('quiet_end')},
  email_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0, 1)),
  UNIQUE (id, org_id),
  CHECK (removed_by_id IS NULL OR removed_at IS NOT NULL),
  CHECK (mfa_enabled_at IS NULL OR mfa_secret IS NOT NULL)
) STRICT;
CREATE INDEX org_users_org ON org_users (org_id);
CREATE UNIQUE INDEX org_users_org_name ON org_users (org_id, name_key);
CREATE UNIQUE INDEX org_users_org_email ON org_users (org_id, lower(email)) WHERE email IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX org_users_sso ON org_users (org_id, sso_subject) WHERE sso_subject IS NOT NULL;
CREATE INDEX org_users_removed_by ON org_users (removed_by_id) WHERE removed_by_id IS NOT NULL;
CREATE TABLE org_user_recovery_codes (
  org_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL CHECK (length(code_hash) = 64),
  PRIMARY KEY (org_user_id, code_hash)
) STRICT;`;

export const usersLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, USERS_MIGRATION);

/** A staff member's quiet hours and e-mail switch. */
export type StaffDeliveryPrefs = {
  /** HH:MM */
  quietStart: string | null;
  /** HH:MM */
  quietEnd: string | null;
  channels: { email: boolean };
};
/** Delivery preferences as an act takes them: an absent field takes its default (no quiet hours, e-mail on). */
export type StaffDeliveryPrefsInput = {
  quietStart?: string | null;
  quietEnd?: string | null;
  channels?: { email?: boolean };
};
type StaffFields = {
  id: string;
  orgId: string;
  name: string;
  role: string;
  email: string | null;
  ssoSubject: string | null;
  createdAt: number;
  removedAt: number | null;
  removedById: string | null;
  provenance: StaffProvenance | null;
  /** Null when MFA was never set up; `enabledAt` null while set up but not yet confirmed. */
  mfa: { enabledAt: number | null } | null;
  deliveryPrefs: StaffDeliveryPrefs;
};
/** A staff member as the repository reads it back, frozen at every level. */
export type Staff = DeepReadonly<StaffFields>;
/**
 * A new staff account: its organisation, name and role, and any other fields (the id is minted when not given).
 * Typed when written, so a caller still in JavaScript can pass anything and be refused by field.
 */
export type StaffInput = {
  id?: string | null;
  orgId: string;
  name: string;
  role: string;
  email?: string | null;
  ssoSubject?: string | null;
  provenance?: StaffProvenance | null;
  deliveryPrefs?: StaffDeliveryPrefsInput | null;
  createdAt?: number;
};
/** A staff member as the whole-domain read carries it: the record with its MFA secret and recovery-code hashes. */
export type StaffSnapshotRow = Omit<StaffFields, 'mfa'> & {
  mfa: { secretB32: string; enabledAt: number | null; recoveryHashes: string[] } | null;
};

// Its own wording, not identityRules': an absent value reads "a undefined", and text must not carry surrounding spaces.
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const describe = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const textOk = (v: unknown, max: number, min = 1): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max && v === v.trim();
const isProvenance = (v: unknown): v is StaffProvenance => (STAFF_PROVENANCES as readonly unknown[]).includes(v);
/** The key a name is unique by in its organisation (and looked up by at sign-in). */
export const staffNameKey = (name: unknown) =>
  String(name ?? '')
    .trim()
    .toLowerCase();

const DEFAULT_PREFS: DeepReadonly<StaffDeliveryPrefs> = Object.freeze({
  quietStart: null,
  quietEnd: null,
  channels: Object.freeze({ email: true }),
});
/** The fields an act through `change` sets. */
type ChangedFields = Partial<
  Pick<StaffFields, 'role' | 'email' | 'ssoSubject' | 'removedAt' | 'removedById'> & { deliveryPrefs: unknown }
>;
/** The columns of the fields the acts set. */
const FIELD_COLUMNS: Readonly<Record<keyof ChangedFields, readonly string[]>> = Object.freeze({
  role: ['role'],
  email: ['email'],
  ssoSubject: ['sso_subject'],
  removedAt: ['removed_at'],
  removedById: ['removed_by_id'],
  deliveryPrefs: ['quiet_start', 'quiet_end', 'email_enabled'],
});

/** Why a delivery-preference value cannot be stored, or null. */
function prefsProblem(p: unknown): string | null {
  if (!isPlainObject(p))
    return `deliveryPrefs must be { quietStart, quietEnd, channels: { email } } (got ${describe(p)})`;
  const unknown = Object.keys(p).filter((k) => !['quietStart', 'quietEnd', 'channels'].includes(k));
  if (unknown.length) return `deliveryPrefs carries unknown field(s) ${unknown.join(', ')}`;
  for (const k of ['quietStart', 'quietEnd'] as const)
    if (p[k] != null && !(typeof p[k] === 'string' && HHMM.test(p[k])))
      return `deliveryPrefs.${k} is a time written HH:MM or null`;
  const ch = p.channels ?? { email: true };
  if (!isPlainObject(ch) || Object.keys(ch).some((k) => k !== 'email'))
    return 'deliveryPrefs.channels must be { email }';
  if (ch.email !== undefined && typeof ch.email !== 'boolean') return 'deliveryPrefs.channels.email must be a boolean';
  return null;
}
/** Checked preferences (`prefsProblem` found none) with their defaults filled in. */
const prefsOf = (p: unknown): DeepReadonly<StaffDeliveryPrefs> => {
  if (p == null) return DEFAULT_PREFS;
  const given = p as StaffDeliveryPrefsInput;
  return {
    quietStart: given.quietStart ?? null,
    quietEnd: given.quietEnd ?? null,
    channels: { email: given.channels?.email ?? true },
  };
};

/** The problems with a record's scalar fields (a new staff record, or one with an act's fields set), by field name. */
function recordProblems(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (typeof r.orgId !== 'string' || !r.orgId) out.push('orgId must name an organisation');
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters without surrounding spaces`);
  if (!textOk(r.role, L.role)) out.push(`role must be text of 1 to ${L.role} characters without surrounding spaces`);
  if (r.email !== null && !textOk(r.email, L.email, 3))
    out.push(`email must be text of 3 to ${L.email} characters or null`);
  if (r.ssoSubject !== null && !textOk(r.ssoSubject, L.ssoSubject))
    out.push(`ssoSubject must be text of 1 to ${L.ssoSubject} characters or null`);
  if (!isClock(r.createdAt)) out.push('createdAt must be an integer timestamp');
  if (r.removedAt !== null && !isClock(r.removedAt)) out.push('removedAt must be an integer timestamp or null');
  if (r.removedById !== null && (typeof r.removedById !== 'string' || !r.removedById))
    out.push('removedById must name a staff member or null');
  if (r.removedById !== null && r.removedAt === null) out.push('removedById is set only on a removed account');
  if (r.provenance !== null && !isProvenance(r.provenance))
    out.push(`provenance must be one of ${STAFF_PROVENANCES.join(', ')} or null`);
  const p = prefsProblem(r.deliveryPrefs);
  if (p) out.push(p);
  return out;
}

const COLS =
  'id, org_id, name, name_key, role, email, sso_subject, created_at, removed_at, removed_by_id, provenance, mfa_secret, mfa_enabled_at, quiet_start, quiet_end, email_enabled';
const SELECT = `SELECT ${COLS} FROM org_users`;
const INSERT = `INSERT INTO org_users (${COLS}) VALUES (${COLS.split(', ')
  .map((c) => `@${c}`)
  .join(', ')})`;
type StaffRow = {
  id: string;
  org_id: string;
  name: string;
  name_key: string;
  role: string;
  email: string | null;
  sso_subject: string | null;
  created_at: number;
  removed_at: number | null;
  removed_by_id: string | null;
  provenance: StaffProvenance | null;
  mfa_secret: string | null;
  mfa_enabled_at: number | null;
  quiet_start: string | null;
  quiet_end: string | null;
  email_enabled: 0 | 1;
};
/** A checked record (or one with an act's fields set) as columns; the MFA columns are written by their own acts. */
type CheckedStaff = Omit<StaffFields, 'mfa' | 'deliveryPrefs'> & { deliveryPrefs: DeepReadonly<StaffDeliveryPrefs> };
const params = (r: CheckedStaff): StaffRow => ({
  id: r.id,
  org_id: r.orgId,
  name: r.name,
  name_key: staffNameKey(r.name),
  role: r.role,
  email: r.email,
  sso_subject: r.ssoSubject,
  created_at: r.createdAt,
  removed_at: r.removedAt,
  removed_by_id: r.removedById,
  provenance: r.provenance,
  mfa_secret: null,
  mfa_enabled_at: null,
  quiet_start: r.deliveryPrefs.quietStart,
  quiet_end: r.deliveryPrefs.quietEnd,
  email_enabled: r.deliveryPrefs.channels.email ? 1 : 0,
});
/** The record for a table row (plain; the repository freezes what it hands out). */
function fromDb(d: StaffRow): StaffFields {
  return {
    id: d.id,
    orgId: d.org_id,
    name: d.name,
    role: d.role,
    email: d.email,
    ssoSubject: d.sso_subject,
    createdAt: d.created_at,
    removedAt: d.removed_at,
    removedById: d.removed_by_id,
    provenance: d.provenance,
    mfa: d.mfa_secret === null ? null : { enabledAt: d.mfa_enabled_at },
    deliveryPrefs: { quietStart: d.quiet_start, quietEnd: d.quiet_end, channels: { email: d.email_enabled === 1 } },
  };
}

/** The uniqueness rules, named before the engine would refuse them (`except`: the row being updated). */
function clashOf(q: (sql: string) => StatementSync, r: CheckedStaff): IdentityRefusal | null {
  if (
    q('SELECT 1 FROM org_users WHERE org_id = ? AND name_key = ? AND id <> ?').get(r.orgId, staffNameKey(r.name), r.id)
  ) {
    return refusal(
      'STAFF_NAME_TAKEN',
      `org_users ${r.id}: another staff account of organisation ${r.orgId} has this name`,
      { field: 'name' },
    );
  }
  if (
    r.email !== null &&
    r.removedAt === null &&
    q('SELECT 1 FROM org_users WHERE org_id = ? AND lower(email) = lower(?) AND removed_at IS NULL AND id <> ?').get(
      r.orgId,
      r.email,
      r.id,
    )
  ) {
    return refusal(
      'STAFF_EMAIL_TAKEN',
      `org_users ${r.id}: another current staff member of organisation ${r.orgId} has this e-mail`,
      { field: 'email' },
    );
  }
  if (
    r.ssoSubject !== null &&
    q('SELECT 1 FROM org_users WHERE org_id = ? AND sso_subject = ? AND id <> ?').get(r.orgId, r.ssoSubject, r.id)
  ) {
    return refusal(
      'STAFF_SSO_TAKEN',
      `org_users ${r.id}: another staff account of organisation ${r.orgId} is linked to this sign-in subject`,
      { field: 'ssoSubject' },
    );
  }
  return null;
}

function readSnapshot(sqlite: DatabaseSync): StaffSnapshotRow[] {
  const codes = new Map<string, string[]>();
  const rows = sqlite.prepare('SELECT org_user_id, code_hash FROM org_user_recovery_codes ORDER BY rowid').all() as {
    org_user_id: string;
    code_hash: string;
  }[];
  for (const c of rows) {
    const list = codes.get(c.org_user_id) ?? [];
    list.push(c.code_hash);
    codes.set(c.org_user_id, list);
  }
  return (sqlite.prepare(`${SELECT} ORDER BY rowid`).all() as StaffRow[]).map((d) => ({
    ...fromDb(d),
    mfa:
      d.mfa_secret === null
        ? null
        : { secretB32: d.mfa_secret, enabledAt: d.mfa_enabled_at, recoveryHashes: codes.get(d.id) ?? [] },
  }));
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const USERS_TABLE = {
  name: 'users',
  read(sqlite: DatabaseSync): StaffSnapshotRow[] | null {
    return usersLive(sqlite) ? readSnapshot(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = [
  'create',
  'restore',
  'setEmail',
  'linkSso',
  'setDeliveryPrefs',
  'setRole',
  'remove',
  'startMfa',
  'enableMfa',
  'disableMfa',
  'useRecoveryCode',
] as const;

/** `createUsersRepository({ sqlite, nextId, unit, now, log })`: the staff writes and queries, plus `reads` (the queries alone). */
export function createUsersRepository({
  sqlite,
  nextId,
  unit = null,
  now = Date.now,
  log = () => {},
}: {
  sqlite: DatabaseSync;
  nextId: (prefix: string) => string;
  unit?: UnitParticipant | null;
  now?: () => number;
  log?: (message: string) => void;
}) {
  if (!sqlite)
    throw new TypeError(
      'the staff repository needs a SQLite connection (node:sqlite); staff have no in-memory fallback',
    );
  if (typeof nextId !== 'function') throw new TypeError('the staff repository needs nextId');
  const { q, operation } = identityKit(sqlite, unit, now);
  const dec = (rows: unknown[]): Staff[] => (rows as StaffRow[]).map((d) => deepFreeze(fromDb(d)));
  const byId = (id: unknown): Staff | null =>
    typeof id === 'string' && id ? (dec(q(`${SELECT} WHERE id = ?`).all(id))[0] ?? null) : null;
  const invalid = (id: unknown, problems: string[]): IdentityRefusal =>
    refusal('STAFF_RECORD_INVALID', `org_users ${id}: ${problems.join('; ')}`, { problems });
  const noStaff = (id: unknown) => refusal('STAFF_NOT_FOUND', `org_users ${id} does not exist`);
  const mustExist = (id: string) => {
    const r = q('SELECT id, mfa_secret, mfa_enabled_at FROM org_users WHERE id = ?').get(id) as
      | Pick<StaffRow, 'id' | 'mfa_secret' | 'mfa_enabled_at'>
      | undefined;
    if (!r) throw noStaff(id);
    return r;
  };
  const checkRemover = (r: Pick<StaffFields, 'id' | 'orgId' | 'removedById'>) => {
    if (r.removedById === null) return;
    const by = byId(r.removedById);
    if (!by || by.orgId !== r.orgId)
      throw invalid(r.id, ['removedById must name a staff member of the same organisation']);
  };
  /**
   * One act on a staff record: `fields(stored)` names the fields it sets, which are checked with the rest of the
   * record (and its uniqueness rules) before only their columns are written.
   */
  const change = (id: string, fields: (stored: Staff) => ChangedFields): Staff =>
    operation(() => {
      const before = byId(id);
      if (!before) throw noStaff(id);
      const set = fields(before);
      const next: Record<string, unknown> = { ...before, ...set };
      const problems = recordProblems(next);
      if (problems.length) throw invalid(id, problems);
      const checked = { ...(next as Omit<StaffFields, 'deliveryPrefs'>), deliveryPrefs: prefsOf(next.deliveryPrefs) };
      checkRemover(checked);
      const clash = clashOf(q, checked);
      if (clash) throw clash;
      const all = params(checked);
      const cols = (Object.keys(set) as (keyof ChangedFields)[]).flatMap((k) => FIELD_COLUMNS[k]);
      q(`UPDATE org_users SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(
        Object.fromEntries([['id', id], ...cols.map((c) => [c, all[c as keyof StaffRow]])]),
      );
      return byId(id) as Staff;
    });

  const repo = {
    // ---------------------------------------------------------- writes
    /** Create a staff account (the id is minted here). Refuses junk by field and a name, e-mail or SSO subject already taken. Returns the stored record. */
    create: (
      {
        id = null,
        orgId,
        name,
        role,
        email = null,
        ssoSubject = null,
        provenance = null,
        deliveryPrefs = null,
        createdAt = now(),
      }: StaffInput = {} as StaffInput,
    ): Staff =>
      operation(() => {
        const r: Record<string, unknown> = {
          id: id ?? nextId('usr'),
          orgId,
          name,
          role,
          email,
          ssoSubject,
          createdAt,
          removedAt: null,
          removedById: null,
          provenance,
          deliveryPrefs: deliveryPrefs ?? DEFAULT_PREFS,
        };
        const problems = recordProblems(r);
        if (problems.length) throw invalid(r.id, problems);
        if (!q('SELECT 1 FROM orgs WHERE id = ?').get(orgId))
          throw refusal('STAFF_ORG_MISSING', `org_users ${r.id}: organisation ${orgId} does not exist`);
        const checked = { ...(r as Omit<CheckedStaff, 'deliveryPrefs'>), deliveryPrefs: prefsOf(r.deliveryPrefs) };
        const clash = clashOf(q, checked);
        if (clash) throw clash;
        q(INSERT).run(params(checked));
        return byId(checked.id) as Staff;
      }),
    /**
     * Restore a removed staff member with `role`, bound to `email` (the invitation's, or null): the membership is
     * current again. Refused with STAFF_NOT_REMOVED when it is current, and STAFF_EMAIL_TAKEN when another current
     * staff member has the e-mail. Returns the stored record.
     */
    restore: (id: string, { role, email = null }: { role: string; email?: string | null }): Staff =>
      change(id, (r) => {
        if (r.removedAt === null) throw refusal('STAFF_NOT_REMOVED', `org_users ${id} is not removed`);
        return { removedAt: null, removedById: null, role, email };
      }),
    /** Set the staff member's e-mail (or null). Refused when another current staff member has it. Returns the stored record. */
    setEmail: (id: string, email: string | null): Staff => change(id, () => ({ email })),
    /** Link the account to an SSO subject. Refused when another account of the organisation holds it. Returns the stored record. */
    linkSso: (id: string, subject: string): Staff => change(id, () => ({ ssoSubject: subject })),
    /** Replace the delivery preferences (`{ quietStart, quietEnd, channels: { email } }`). Returns the stored record. */
    setDeliveryPrefs: (id: string, prefs: StaffDeliveryPrefsInput): Staff =>
      change(id, () => ({ deliveryPrefs: prefs })),
    /** Give a staff member another role (text of 1 to 60 characters, trimmed). Returns the stored record. */
    setRole: (id: string, role: string): Staff =>
      operation(() => {
        if (!textOk(role, L.role))
          throw invalid(id, [`role must be text of 1 to ${L.role} characters without surrounding spaces`]);
        if (q('UPDATE org_users SET role = ? WHERE id = ?').run(role, id).changes !== 1) throw noStaff(id);
        return byId(id) as Staff;
      }),
    /**
     * End a staff member's membership at `at`, by `by` (a staff member of the same organisation). The row stays so
     * history remains attributed. Refused with STAFF_ALREADY_REMOVED when the account is already removed. Returns the
     * stored record.
     */
    remove: (id: string, { at = now(), by = null }: { at?: number; by?: string | null } = {}): Staff =>
      operation(() => {
        if (!isClock(at)) throw new TypeError('users.remove: `at` must be a non-negative integer timestamp (ms)');
        if (by !== null && (typeof by !== 'string' || !by))
          throw new TypeError('users.remove: `by` must be a staff id or null');
        const before = byId(id);
        if (!before) throw noStaff(id);
        checkRemover({ ...before, removedById: by });
        if (
          q('UPDATE org_users SET removed_at = ?, removed_by_id = ? WHERE id = ? AND removed_at IS NULL').run(
            at,
            by,
            id,
          ).changes !== 1
        ) {
          throw refusal('STAFF_ALREADY_REMOVED', `org_users ${id} is already removed`);
        }
        return byId(id) as Staff;
      }),
    /** Begin MFA set-up with a new secret (replacing an unconfirmed one); refused once MFA is enabled. Returns the stored record. */
    startMfa: (id: string, secretB32: string): Staff =>
      operation(() => {
        const m = mustExist(id);
        if (m.mfa_enabled_at !== null) throw refusal('STAFF_MFA_ENABLED', `org_users ${id}: MFA is already enabled`);
        if (!textOk(secretB32, L.secret, 16))
          throw invalid(id, [`the MFA secret must be text of 16 to ${L.secret} characters`]);
        q('UPDATE org_users SET mfa_secret = ?, mfa_enabled_at = NULL WHERE id = ?').run(secretB32, id);
        q('DELETE FROM org_user_recovery_codes WHERE org_user_id = ?').run(id);
        return byId(id) as Staff;
      }),
    /** Confirm MFA: enabled from `at`, with these recovery-code hashes (each usable once). Returns the stored record. */
    enableMfa: (
      id: string,
      { at = now(), recoveryHashes = [] }: { at?: number; recoveryHashes?: readonly string[] } = {},
    ): Staff =>
      operation(() => {
        const m = mustExist(id);
        if (m.mfa_secret === null || m.mfa_enabled_at !== null)
          throw refusal('STAFF_MFA_NOT_PENDING', `org_users ${id}: MFA is not awaiting confirmation`);
        if (!isClock(at)) throw invalid(id, ['at must be an integer timestamp']);
        if (
          !Array.isArray(recoveryHashes) ||
          !recoveryHashes.every(isHash) ||
          new Set(recoveryHashes).size !== recoveryHashes.length
        )
          throw invalid(id, ['recovery codes are distinct sha256 hex hashes']);
        q('UPDATE org_users SET mfa_enabled_at = ? WHERE id = ?').run(at, id);
        const add = q('INSERT INTO org_user_recovery_codes (org_user_id, code_hash) VALUES (?, ?)');
        for (const h of recoveryHashes) add.run(id, h);
        return byId(id) as Staff;
      }),
    /** Turn MFA off: the secret and the unused recovery codes go. Returns the stored record. */
    disableMfa: (id: string): Staff =>
      operation(() => {
        mustExist(id);
        q('DELETE FROM org_user_recovery_codes WHERE org_user_id = ?').run(id);
        q('UPDATE org_users SET mfa_secret = NULL, mfa_enabled_at = NULL WHERE id = ?').run(id);
        return byId(id) as Staff;
      }),
    /** Spend one recovery code (by its hash). True when it existed and is now gone: a code works exactly once. */
    useRecoveryCode: (id: string, codeHash: string): boolean =>
      operation(() =>
        isHash(codeHash)
          ? q('DELETE FROM org_user_recovery_codes WHERE org_user_id = ? AND code_hash = ?').run(id, codeHash)
              .changes === 1
          : false,
      ),

    // ---------------------------------------------------------- reads
    byId,
    /** The account with this name in the organisation (case-insensitive; removed accounts included), or null. */
    byOrgAndName: (orgId: string, name: unknown): Staff | null => {
      const key = staffNameKey(name);
      return key ? (dec(q(`${SELECT} WHERE org_id = ? AND name_key = ?`).all(orgId, key))[0] ?? null) : null;
    },
    /** The organisation's staff in creation order; `active: true` leaves out removed accounts. */
    forOrg: (orgId: string, { active = false }: { active?: boolean } = {}): Staff[] =>
      dec(q(`${SELECT} WHERE org_id = ?${active ? ' AND removed_at IS NULL' : ''} ORDER BY rowid`).all(orgId)),
    /** The organisation's first current staff member (creation order), or null. */
    firstActive: (orgId: string): Staff | null =>
      dec(q(`${SELECT} WHERE org_id = ? AND removed_at IS NULL ORDER BY rowid LIMIT 1`).all(orgId))[0] ?? null,
    /** The current staff member with this e-mail (case-insensitive), or null. */
    activeByEmail: (orgId: string, email: unknown): Staff | null =>
      typeof email === 'string' && email
        ? (dec(
            q(`${SELECT} WHERE org_id = ? AND lower(email) = lower(?) AND removed_at IS NULL`).all(orgId, email),
          )[0] ?? null)
        : null,
    /** The account linked to this SSO subject in the organisation, or null. */
    bySsoSubject: (orgId: string, subject: unknown): Staff | null =>
      typeof subject === 'string' && subject
        ? (dec(q(`${SELECT} WHERE org_id = ? AND sso_subject = ?`).all(orgId, subject))[0] ?? null)
        : null,
    /** The TOTP secret for the code checks (never on a record), or null. */
    mfaSecretOf: (id: string): string | null =>
      (q('SELECT mfa_secret FROM org_users WHERE id = ?').get(id) as Pick<StaffRow, 'mfa_secret'> | undefined)
        ?.mfa_secret ?? null,
    /** How many unused recovery codes a staff member has. */
    recoveryCodesLeft: (id: string): number =>
      (q('SELECT COUNT(*) AS n FROM org_user_recovery_codes WHERE org_user_id = ?').get(id) as { n: number }).n,
    count: (): number => (q('SELECT COUNT(*) AS n FROM org_users').get() as { n: number }).n,
    attach(): { engine: 'sqlite'; rows: number } {
      if (!usersLive(sqlite)) throw new Error(`the staff repository needs ${USERS_MIGRATION} recorded`);
      const rows = repo.count();
      log(`org_users: ${rows} staff account(s) in the table`);
      return { engine: 'sqlite', rows };
    },
  };
  return Object.assign(repo, { reads: readsOf(repo, [...WRITES, 'attach']) });
}
export type UsersRepository = ReturnType<typeof createUsersRepository>;
export type StaffReads = UsersRepository['reads'];
