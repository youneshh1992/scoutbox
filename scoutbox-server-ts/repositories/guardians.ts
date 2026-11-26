/**
 * Guardians (`guardians`; their links to players are `guardian_children`, written by identity.ts).
 *
 * Guardian record: { id, name, email, emailVerified, idVerified, idvReference, disclaimerAccepted, disclaimerAcceptedAt,
 *   coGuardianOf, notificationPrefs, createdAt, childIds, coGuardians }
 * `childIds` is the guardian's link rows (in their order); `coGuardians` is the guardians whose `co_guardian_of` names
 * this one, as `{ id, name, email }`. A guardian's e-mail is unique case-insensitively.
 *
 * Password and e-mail-code hashes are never on a record (`passwordHashOf`, `setPasswordHash`, `emailCodeHashOf`,
 * `setEmailCodeHash`).
 */
import type { DeepReadonly } from '../domains/platform/values.ts';
import { deepFreeze } from '../domains/platform/values.ts';
import type { PlayerRow } from './playerRecord.ts';
import {
  IDENTITY_LIMITS as L,
  refusal,
  isPlainObject,
  isClock,
  textOk,
  optTextOk,
  given,
  b,
  nb,
  prefsWithDefaults,
  recordPrefsProblems,
  prefsReplacementProblems,
  prefsFromRow,
  prefsParams,
  passwordProblem,
  NO_PREFS,
  pageOf,
  type IdentityKit,
  type NotificationPrefs,
} from './identityRules.ts';

type GuardianFields = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  idVerified: boolean;
  /** The ID-check provider's reference. */
  idvReference: string | null;
  disclaimerAccepted: boolean;
  /** The first acceptance. */
  disclaimerAcceptedAt: number | null;
  /** The guardian this one is a co-guardian of. */
  coGuardianOf: string | null;
  notificationPrefs: NotificationPrefs | null;
  createdAt: number | null;
  /** The players this guardian lists, in link order. */
  childIds: string[];
};
/** A guardian as the repository reads it back, frozen at every level. */
export type Guardian = DeepReadonly<GuardianFields & { coGuardians: { id: string; name: string; email: string }[] }>;
/** A new guardian: the identity fields and any others (absent ones take their defaults). */
export type GuardianInput = Pick<GuardianFields, 'id' | 'name' | 'email'> &
  Partial<Omit<GuardianFields, 'id' | 'name' | 'email' | 'notificationPrefs' | 'childIds'>> & {
    notificationPrefs?: { [K in keyof NotificationPrefs]?: NotificationPrefs[K] | null } | null;
    childIds?: readonly string[];
  };
/** A guardian as written (no `coGuardians`, which is worked out). */
export type GuardianDraft = GuardianFields;

export const GUARDIAN_RECORD_KEYS: readonly string[] = Object.freeze([
  'id',
  'name',
  'email',
  'emailVerified',
  'idVerified',
  'idvReference',
  'disclaimerAccepted',
  'disclaimerAcceptedAt',
  'coGuardianOf',
  'notificationPrefs',
  'createdAt',
  'childIds',
  'coGuardians',
]);
const GUARDIAN_BOOLEANS = Object.freeze(['emailVerified', 'idVerified', 'disclaimerAccepted'] as const);
const GUARDIAN_INPUT_KEYS = Object.freeze(GUARDIAN_RECORD_KEYS.filter((k) => k !== 'coGuardians'));
/** An incoming guardian with its defaults. Not yet checked: `guardianRecordProblems` decides whether it is a draft. */
export function guardianWithDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const g = given(raw);
  const r: Record<string, unknown> = {
    emailVerified: false,
    idVerified: false,
    idvReference: null,
    disclaimerAccepted: false,
    disclaimerAcceptedAt: null,
    coGuardianOf: null,
    notificationPrefs: null,
    createdAt: null,
    childIds: [],
    ...g,
  };
  if (isPlainObject(r.notificationPrefs)) r.notificationPrefs = prefsWithDefaults(r.notificationPrefs);
  return r;
}
export function guardianRecordProblems(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(r)) {
    if (GUARDIAN_INPUT_KEYS.includes(k)) continue;
    if (k === 'coGuardians')
      out.push("coGuardians is worked out from the co-guardians' coGuardianOf and is not written");
    else out.push(`unknown field ${k}`);
  }
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters`);
  if (!(textOk(r.email, L.email, 3) && r.email.includes('@')))
    out.push(`email must be an address of 3 to ${L.email} characters`);
  for (const k of GUARDIAN_BOOLEANS) if (typeof r[k] !== 'boolean') out.push(`${k} must be a boolean`);
  if (!optTextOk(r.idvReference, L.idvReference))
    out.push(`idvReference must be text of 1 to ${L.idvReference} characters or null`);
  if (r.disclaimerAcceptedAt !== null && !isClock(r.disclaimerAcceptedAt))
    out.push('disclaimerAcceptedAt must be an integer timestamp or null');
  if (r.coGuardianOf !== null && !textOk(r.coGuardianOf, L.id)) out.push('coGuardianOf must be a guardian id or null');
  if (r.coGuardianOf !== null && r.coGuardianOf === r.id) out.push('coGuardianOf cannot name the guardian itself');
  if (r.createdAt !== null && !isClock(r.createdAt)) out.push('createdAt must be an integer timestamp or null');
  if (!Array.isArray(r.childIds) || r.childIds.some((c) => !textOk(c, L.id)))
    out.push('childIds must be a list of player ids');
  else if (new Set(r.childIds).size !== r.childIds.length) out.push('childIds lists a player more than once');
  out.push(...recordPrefsProblems(r.notificationPrefs));
  return out;
}
export const codeHashProblem = (h: unknown): string | null =>
  h === null || (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
    ? null
    : 'the e-mail code hash must be a sha256 hex digest or null';

const G_COLS = [
  'id',
  'name',
  'email',
  'password_hash',
  'email_verified',
  'email_code_hash',
  'id_verified',
  'idv_reference',
  'disclaimer_accepted',
  'disclaimer_accepted_at',
  'co_guardian_of',
  'prefs_quiet_start',
  'prefs_quiet_end',
  'prefs_school_hours_mute',
  'prefs_timezone',
  'created_at',
] as const;
/** A `guardians` row as SQLite reads it. */
export type GuardianRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string | null;
  email_verified: 0 | 1;
  email_code_hash: string | null;
  id_verified: 0 | 1;
  idv_reference: string | null;
  disclaimer_accepted: 0 | 1;
  disclaimer_accepted_at: number | null;
  co_guardian_of: string | null;
  prefs_quiet_start: string | null;
  prefs_quiet_end: string | null;
  prefs_school_hours_mute: 0 | 1 | null;
  prefs_timezone: string | null;
  created_at: number | null;
};
export const G_SELECT = `SELECT ${G_COLS.join(', ')} FROM guardians`;
export const G_INSERT = `INSERT INTO guardians (${G_COLS.join(', ')}) VALUES (${G_COLS.map((c) => `@${c}`).join(', ')})`;
export function guardianParams(
  r: GuardianDraft,
  { passwordHash = null, emailCodeHash = null }: { passwordHash?: string | null; emailCodeHash?: string | null } = {},
): GuardianRow {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    password_hash: passwordHash,
    email_verified: b(r.emailVerified),
    email_code_hash: emailCodeHash,
    id_verified: b(r.idVerified),
    idv_reference: r.idvReference,
    disclaimer_accepted: b(r.disclaimerAccepted),
    disclaimer_accepted_at: r.disclaimerAcceptedAt,
    co_guardian_of: r.coGuardianOf,
    ...prefsParams(r.notificationPrefs),
    created_at: r.createdAt,
  };
}
export function guardianFromDb(
  d: GuardianRow,
  childIds: string[],
  coGuardians: { id: string; name: string; email: string }[],
) {
  return {
    id: d.id,
    name: d.name,
    email: d.email,
    emailVerified: d.email_verified === 1,
    idVerified: d.id_verified === 1,
    idvReference: d.idv_reference,
    disclaimerAccepted: d.disclaimer_accepted === 1,
    disclaimerAcceptedAt: d.disclaimer_accepted_at,
    coGuardianOf: d.co_guardian_of,
    notificationPrefs: prefsFromRow(d),
    createdAt: d.created_at,
    childIds,
    coGuardians,
  };
}

export const GUARDIAN_WRITES = Object.freeze([
  'create',
  'verifyEmail',
  'recordIdCheck',
  'reviewIdCheck',
  'acceptDisclaimer',
  'setNotificationPrefs',
  'setPasswordHash',
  'setEmailCodeHash',
] as const);

export const guardianInvalid = (id: unknown, problems: string[]) =>
  refusal('GUARDIAN_RECORD_INVALID', `a guardian record was refused (guardian ${id}): ${problems.join('; ')}`, {
    problems,
  });
export const noGuardian = (id: unknown) => refusal('GUARDIAN_NOT_FOUND', `guardian ${id} does not exist`);

/**
 * The guardians repository, without the link acts (identity.ts adds them: they write both sides). `playerRow` reads a
 * live player's row, for the links `create` writes.
 */
export function createGuardians(
  { q, operation }: IdentityKit,
  { playerRow }: { playerRow: (id: unknown) => PlayerRow | null },
) {
  const decodeGuardians = (rows: GuardianRow[]): Guardian[] => {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map((d) => d.id));
    const kids = new Map<string, string[]>();
    const cos = new Map<string, { id: string; name: string; email: string }[]>();
    for (const l of q(
      'SELECT guardian_id, player_id FROM guardian_children WHERE guardian_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
    ).all(ids) as { guardian_id: string; player_id: string }[]) {
      let list = kids.get(l.guardian_id);
      if (!list) kids.set(l.guardian_id, (list = []));
      list.push(l.player_id);
    }
    for (const c of q(
      'SELECT id, name, email, co_guardian_of FROM guardians WHERE co_guardian_of IN (SELECT value FROM json_each(?)) ORDER BY rowid',
    ).all(ids) as (Pick<GuardianRow, 'id' | 'name' | 'email'> & { co_guardian_of: string })[]) {
      let list = cos.get(c.co_guardian_of);
      if (!list) cos.set(c.co_guardian_of, (list = []));
      list.push({ id: c.id, name: c.name, email: c.email });
    }
    return rows.map((d) => deepFreeze(guardianFromDb(d, kids.get(d.id) ?? [], cos.get(d.id) ?? [])));
  };
  const guardianById = (id: unknown): Guardian | null =>
    typeof id === 'string' && id
      ? (decodeGuardians(q(`${G_SELECT} WHERE id = ?`).all(id) as GuardianRow[])[0] ?? null)
      : null;
  /** The guardian after an act that has just written it. */
  const stored = (id: string): Guardian => {
    const g = guardianById(id);
    if (!g) throw noGuardian(id);
    return g;
  };
  const exists = (id: unknown) => !!q('SELECT 1 FROM guardians WHERE id = ?').get(id as string);
  const emailOwner = (email: unknown, exceptId: string | null = null): string | null =>
    typeof email === 'string'
      ? ((
          q('SELECT id FROM guardians WHERE lower(email) = lower(?) AND id IS NOT ?').get(email, exceptId) as
            | { id: string }
            | undefined
        )?.id ?? null)
      : null;
  const hashOf = (col: 'password_hash' | 'email_code_hash', id: string): string | null =>
    ((q(`SELECT ${col} FROM guardians WHERE id = ?`).get(id) as Record<string, string | null> | undefined)?.[col] ??
      null) as string | null;

  const guardians = {
    /**
     * Create a guardian (`passwordHash` and `emailCodeHash` stored, never on the record). `childIds` given here become
     * link rows in the same unit (`primary` where the child's guardianId names this guardian, `co` otherwise); the
     * e-mail must be unique case-insensitively and `coGuardianOf` must name an existing guardian. Returns the record.
     */
    create: ({
      passwordHash = null,
      emailCodeHash = null,
      ...fields
    }: GuardianInput & { passwordHash?: string | null; emailCodeHash?: string | null }): Guardian =>
      operation(() => {
        const raw = guardianWithDefaults(fields);
        const problems = guardianRecordProblems(raw);
        const pw = passwordProblem(passwordHash);
        if (pw) problems.push(pw);
        const ch = codeHashProblem(emailCodeHash);
        if (ch) problems.push(ch);
        if (problems.length) throw guardianInvalid(raw.id, problems);
        const r = raw as GuardianDraft;
        if (exists(r.id)) throw refusal('GUARDIAN_EXISTS', `guardian ${r.id} already exists`);
        const taken = emailOwner(r.email);
        if (taken)
          throw refusal(
            'EMAIL_IN_USE',
            `another guardian (${taken}) already uses this e-mail (compared case-insensitively)`,
          );
        if (r.coGuardianOf !== null && !exists(r.coGuardianOf))
          throw refusal('GUARDIAN_NOT_FOUND', `coGuardianOf names guardian ${r.coGuardianOf}, which does not exist`);
        const kids = r.childIds.map((childId) => {
          const p = playerRow(childId);
          if (!p) throw refusal('PLAYER_NOT_FOUND', `childIds names player ${childId}, which does not exist`);
          return p;
        });
        q(G_INSERT).run(guardianParams(r, { passwordHash, emailCodeHash }));
        for (const p of kids)
          q('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, ?)').run(
            r.id,
            p.id,
            p.guardian_id === r.id ? 'primary' : 'co',
          );
        return stored(r.id);
      }),
    /*
     * The safeguarding gates. No act un-verifies an e-mail or withdraws an accepted disclaimer, and the first
     * acceptance time is kept. Only Trust & Safety's ID review (`reviewIdCheck`) turns `idVerified` off again.
     */
    /** Mark the e-mail verified and clear the spent code's hash. A second call changes nothing. */
    verifyEmail: (id: string): Guardian =>
      operation(() => {
        if (
          !q('UPDATE guardians SET email_verified = 1, email_code_hash = NULL WHERE id = ? AND email_verified = 0').run(
            id,
          ).changes &&
          !guardianById(id)
        )
          throw noGuardian(id);
        return stored(id);
      }),
    /** A passed ID check from the provider: verified, with the provider's reference. */
    recordIdCheck: (id: string, { reference }: { reference: string }): Guardian =>
      operation(() => {
        if (!textOk(reference, L.idvReference))
          throw guardianInvalid(id, [`idvReference must be text of 1 to ${L.idvReference} characters`]);
        if (q('UPDATE guardians SET id_verified = 1, idv_reference = ? WHERE id = ?').run(reference, id).changes !== 1)
          throw noGuardian(id);
        return stored(id);
      }),
    /** Trust & Safety's review of the ID check: approve, or revoke. */
    reviewIdCheck: (id: string, approved: boolean): Guardian =>
      operation(() => {
        if (typeof approved !== 'boolean') throw guardianInvalid(id, ['approved must be a boolean']);
        if (q('UPDATE guardians SET id_verified = ? WHERE id = ?').run(b(approved), id).changes !== 1)
          throw noGuardian(id);
        return stored(id);
      }),
    /** Accept the safeguarding disclaimer at `at`; a later acceptance keeps the first time. */
    acceptDisclaimer: (id: string, at: number): Guardian =>
      operation(() => {
        if (!isClock(at))
          throw new TypeError('guardians.acceptDisclaimer: `at` must be a non-negative integer timestamp (ms)');
        if (
          q(
            'UPDATE guardians SET disclaimer_accepted = 1, disclaimer_accepted_at = COALESCE(disclaimer_accepted_at, ?) WHERE id = ?',
          ).run(at, id).changes !== 1
        )
          throw noGuardian(id);
        return stored(id);
      }),
    /** Replace the notification preferences (`{ quietStart, quietEnd, schoolHoursMute, timezone }`), or clear them with null. */
    setNotificationPrefs: (id: string, prefs: NotificationPrefs | null): Guardian =>
      operation(() => {
        const n = prefs ?? NO_PREFS;
        const problems = prefsReplacementProblems(n);
        if (problems.length) throw guardianInvalid(id, problems);
        if (
          q(
            'UPDATE guardians SET prefs_quiet_start = ?, prefs_quiet_end = ?, prefs_school_hours_mute = ?, prefs_timezone = ? WHERE id = ?',
          ).run(n.quietStart, n.quietEnd, nb(n.schoolHoursMute), n.timezone, id).changes !== 1
        )
          throw noGuardian(id);
        return stored(id);
      }),
    setPasswordHash: (id: string, hash: string | null): Guardian =>
      operation(() => {
        const pw = passwordProblem(hash);
        if (pw) throw guardianInvalid(id, [pw]);
        if (q('UPDATE guardians SET password_hash = ? WHERE id = ?').run(hash, id).changes !== 1) throw noGuardian(id);
        return stored(id);
      }),
    setEmailCodeHash: (id: string, hash: string | null): Guardian =>
      operation(() => {
        const ch = codeHashProblem(hash);
        if (ch) throw guardianInvalid(id, [ch]);
        if (q('UPDATE guardians SET email_code_hash = ? WHERE id = ?').run(hash, id).changes !== 1)
          throw noGuardian(id);
        return stored(id);
      }),

    byId: guardianById,
    byIds: (ids: readonly unknown[] | null | undefined): Guardian[] => {
      const list = [...new Set((ids ?? []).filter((x): x is string => typeof x === 'string' && !!x))];
      if (!list.length) return [];
      const byKey = new Map(
        decodeGuardians(
          q(`${G_SELECT} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list)) as GuardianRow[],
        ).map((g) => [g.id, g]),
      );
      return list.map((x) => byKey.get(x)).filter((g): g is Guardian => !!g);
    },
    /** The guardian with this e-mail (case-insensitive), or null. */
    byEmail: (email: unknown): Guardian | null => {
      const id = emailOwner(email);
      return id ? guardianById(id) : null;
    },
    emailTaken: (email: unknown, exceptId: string | null = null): boolean => emailOwner(email, exceptId) !== null,
    /** The guardians listing this player, with their role. */
    linksOf: (playerId: string): { guardianId: string; role: 'primary' | 'co' }[] =>
      (
        q('SELECT guardian_id, role FROM guardian_children WHERE player_id = ? ORDER BY rowid').all(playerId) as {
          guardian_id: string;
          role: 'primary' | 'co';
        }[]
      ).map((l) => ({ guardianId: l.guardian_id, role: l.role })),
    /** The guardians listing this player (records), primary first. */
    forPlayer: (playerId: string): Guardian[] =>
      guardians.byIds(
        (
          q("SELECT guardian_id FROM guardian_children WHERE player_id = ? ORDER BY role = 'primary' DESC, rowid").all(
            playerId,
          ) as { guardian_id: string }[]
        ).map((l) => l.guardian_id),
      ),
    childIds: (id: string): string[] =>
      (
        q('SELECT player_id FROM guardian_children WHERE guardian_id = ? ORDER BY rowid').all(id) as {
          player_id: string;
        }[]
      ).map((l) => l.player_id),
    /** One page of every guardian, oldest first; `page` is the route's `readPage(query, ['number'])`: `{ items, nextCursor }`. */
    page: ({ limit, after = null }: { limit: number; after?: readonly unknown[] | null }) => {
      const rows = q(
        `SELECT rowid AS rid, ${G_COLS.join(', ')} FROM guardians WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      ).all(after ? (after[0] as number) : 0, limit + 1) as (GuardianRow & { rid: number })[];
      const page = pageOf(rows, limit, (r: { rid: number }) => [r.rid]);
      return { items: decodeGuardians(page.items), nextCursor: page.nextCursor as string | null };
    },
    count: (): number => (q('SELECT COUNT(*) AS n FROM guardians').get() as { n: number }).n,
    passwordHashOf: (id: string) => hashOf('password_hash', id),
    emailCodeHashOf: (id: string) => hashOf('email_code_hash', id),
  };
  return guardians;
}
