/**
 * The match facts: a projection of each live player's facts that matching, the Dynamic Watchlists and Nobody Missed
 * test, kept in tables so those reads are SQL queries over the visible players instead of a per-player assembly in
 * code.
 *
 * WHAT IS STORED: only what the `players` row cannot answer by itself. Name, age, level, foot and the Grassroots
 * distance stay on `players` (the visibility query already reads that row). Here, per player:
 *   player_match_facts            the position and availability the Passport preferences resolve (a preference wins
 *                                 over the profile), the evidence-confidence band, the newest evidence and footage
 *                                 instants, an active or coach-confirmed reference, a confirmed club (a signing), and
 *                                 `refresh_due_at`: the next instant at which time alone changes an input (evidence
 *                                 expiry, a claim's valid_until, an agent agreement's start or end, adulthood);
 *   player_match_fact_positions   the Passport's secondary positions, ordered;
 *   player_match_fact_combine     one row per protocol with a live production Combine Verified result, and the best
 *                                 measurement (null when none was a number).
 *
 * WHO KEEPS IT: nobody by hand. Every input table carries triggers (MATCH_FACT_INPUTS) that put the player's id in
 * `player_match_facts_dirty`; the store re-derives the dirty players just before every COMMIT (onBeforeCommit in
 * database.mjs, the builder registered by the discovery domain), so a committed write never leaves a stale row. A
 * change to an organisation's standing (verified, suspended, revoked) marks the players linked to it. Time-only
 * changes are the sweep's (`markDue`, run at boot and every minute). The facts are derived: they are never a source,
 * and a policy change rebuilds them all (`policyKey` in meta).
 *
 * References: `player_id` → players ON DELETE CASCADE (a projection of the player row, never outliving it); the
 * child rows cascade from their facts row. The dirty markers carry no key (a trigger may mark an id that is not a
 * player, e.g. a claim's organisation subject; the drain finds no player and removes nothing).
 */
import { transaction } from './database.mjs';
import { PLAYER_POSITIONS } from './identity.mjs';
import { POLICY as TRUST_POLICY } from '../domains/verification/trust/shared.mjs';
import { BOX_CAM_LIMITS } from './boxCam.mjs';

export const MATCH_FACTS_MIGRATION = '0040_match_facts';
export const MATCH_FACTS_TABLES = Object.freeze(['player_match_facts', 'player_match_fact_positions', 'player_match_fact_combine', 'player_match_facts_dirty']);
export const MATCH_FACTS_POLICY_META = 'matchFactsPolicy';
export const TRUST_BAND_IDS = Object.freeze(TRUST_POLICY.bands.map((b) => b.id));
// The protocol id is a Combine attempt's (combine_attempts.protocol_id, BOX_CAM_LIMITS.id): the same bound, imported.
export const MATCH_FACT_LIMITS = Object.freeze({ availability: 40, protocol: BOX_CAM_LIMITS.id, secondary: 3 });

const inList = (vs) => vs.map((v) => `'${v}'`).join(',');
/**
 * The band's rank (0 = limited … 4 = very strong; -1 none) as an expression over `trust_band`: the one definition the
 * evidence-confidence order and criterion use (match.mjs BAND_RANK_SQL), so its index serves them.
 */
export const bandRankExpr = (col) => `COALESCE(CASE ${col} ${TRUST_BAND_IDS.map((b, i) => `WHEN '${b}' THEN ${i}`).join(' ')} END, -1)`;
const BAND_RANK_EXPR = bandRankExpr('trust_band');
export const MATCH_FACTS_DDL = `
CREATE TABLE player_match_facts (
  player_id         TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  name_key          TEXT NOT NULL CHECK (length(name_key) <= 120),
  position          TEXT CHECK (position IS NULL OR position IN (${inList(PLAYER_POSITIONS)})),
  availability      TEXT CHECK (availability IS NULL OR length(availability) BETWEEN 1 AND ${MATCH_FACT_LIMITS.availability}),
  trust_band        TEXT CHECK (trust_band IS NULL OR trust_band IN (${inList(TRUST_BAND_IDS)})),
  last_evidence_at  INTEGER CHECK (last_evidence_at IS NULL OR last_evidence_at > 0),
  last_footage_at   INTEGER CHECK (last_footage_at IS NULL OR last_footage_at > 0),
  coach_reference   INTEGER NOT NULL CHECK (coach_reference IN (0, 1)),
  club_confirmed    INTEGER NOT NULL CHECK (club_confirmed IN (0, 1)),
  refresh_due_at    INTEGER,
  refreshed_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX player_match_facts_due ON player_match_facts (refresh_due_at) WHERE refresh_due_at IS NOT NULL;
CREATE INDEX player_match_facts_recent ON player_match_facts (COALESCE(last_evidence_at, 0) DESC, player_id);
CREATE INDEX player_match_facts_name ON player_match_facts (name_key, player_id);
CREATE INDEX player_match_facts_band ON player_match_facts (${BAND_RANK_EXPR} DESC, player_id);
CREATE INDEX player_match_facts_position ON player_match_facts (position, player_id);
CREATE INDEX player_match_facts_availability ON player_match_facts (availability, player_id);
CREATE TABLE player_match_fact_positions (
  player_id         TEXT NOT NULL REFERENCES player_match_facts(player_id) ON DELETE CASCADE,
  ord               INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${MATCH_FACT_LIMITS.secondary}),
  code              TEXT NOT NULL CHECK (code IN (${inList(PLAYER_POSITIONS)})),
  PRIMARY KEY (player_id, ord)
) STRICT;
CREATE INDEX player_match_fact_positions_code ON player_match_fact_positions (code, player_id);
CREATE TABLE player_match_fact_combine (
  player_id         TEXT NOT NULL REFERENCES player_match_facts(player_id) ON DELETE CASCADE,
  protocol_id       TEXT NOT NULL CHECK (length(protocol_id) BETWEEN 1 AND ${MATCH_FACT_LIMITS.protocol}),
  best_value        REAL,
  PRIMARY KEY (player_id, protocol_id)
) STRICT;
CREATE INDEX player_match_fact_combine_protocol ON player_match_fact_combine (protocol_id, player_id);
CREATE TABLE player_match_facts_dirty (
  player_id         TEXT PRIMARY KEY
) STRICT;
`;

/**
 * The tables the facts are derived from, and how a row names its player. The builder's reads are exactly these (and
 * the decoding children listed in MATCH_FACT_DECODING_ONLY): scripts/testMatchFacts.mjs records every table the
 * builder reads and fails if one is missing here. `update` lists the columns whose change matters, where the table
 * is written for other reasons too (a players row changes on every profile write); otherwise any update marks.
 * `fanOut` marks further players through another table (an organisation's standing reaches the players linked to it);
 * each of its SELECTs names its column `pid`.
 */
export const MATCH_FACT_INPUTS = Object.freeze([
  { table: 'players', player: (r) => `${r}.id`, update: ['name', 'position', 'availability', 'identity_verified', 'birth_date', 'country', 'deleted_at'] },
  { table: 'passport_prefs', player: (r) => `${r}.player_id` },
  { table: 'passport_pref_positions', player: (r) => `${r}.player_id` },
  { table: 'passport_career_entries', player: (r) => `${r}.player_id` },
  { table: 'evidence', player: (r) => `${r}.player_id` },
  { table: 'ver_references', player: (r) => `${r}.player_id` },
  { table: 'ver_claims', player: (r) => `${r}.subject_id`, fanOut: (r) => `SELECT player_id AS pid FROM ver_references WHERE provenance_claim_id = ${r}.id` },
  { table: 'ver_player_invites', player: (r) => `${r}.player_id` },
  { table: 'combine_attempts', player: (r) => `${r}.player_id` },
  { table: 'box_sessions', player: (r) => `${r}.player_id` },
  { table: 'signings', player: (r) => `${r}.player_id` },
  { table: 'outcome_reports', player: (r) => `${r}.player_id` },
  { table: 'org_squad_members', player: (r) => `${r}.player_id` },
  { table: 'representation_agreements', player: (r) => `CASE WHEN ${r}.client_kind = 'player' THEN ${r}.client_id END` },
  { table: 'assessments', player: (r) => `${r}.player_id` },
  {
    table: 'orgs', player: null, events: ['UPDATE'], update: ['verified', 'suspended', 'verification_revoked_at'],
    fanOut: (r) => [
      `SELECT player_id AS pid FROM org_squad_members WHERE org_id = ${r}.id`,
      `SELECT player_id AS pid FROM ver_player_invites WHERE org_id = ${r}.id`,
      `SELECT player_id AS pid FROM signings WHERE org_id = ${r}.id`,
      `SELECT player_id AS pid FROM assessments WHERE org_id = ${r}.id`,
      `SELECT subject_id AS pid FROM ver_claims WHERE organisation_id = ${r}.id`,
    ].join(' UNION '),
  },
]);
/** Tables the builder reads only to decode a record whose facts come from its parent (an evidence item's disputes). */
export const MATCH_FACT_DECODING_ONLY = Object.freeze(['evidence_disputes', 'evidence_media', 'evidence_history', 'passport_position_history', 'passport_position_history_positions', 'passport_public_selections', 'ver_claim_evidence']);

/**
 * The triggers, one per input table and event. They insert only an unmarked id rather than INSERT OR IGNORE: an outer
 * statement's conflict clause (an OR REPLACE, an OR ABORT) overrides a trigger's own, so OR IGNORE is not reliable here.
 */
export function matchFactsTriggersDdl() {
  const out = [];
  for (const input of MATCH_FACT_INPUTS) {
    for (const event of input.events ?? ['INSERT', 'UPDATE', 'DELETE']) {
      const rows = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
      const sources = rows.flatMap((r) => [input.player ? `SELECT ${input.player(r)} AS pid` : null, input.fanOut ? input.fanOut(r) : null].filter(Boolean));
      // A repository writes the whole row, so UPDATE OF alone would fire on every write: the WHEN keeps it to a real change.
      const listed = event === 'UPDATE' && input.update;
      const on = listed ? `UPDATE OF ${input.update.join(', ')}` : event;
      const when = listed ? ` WHEN ${input.update.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')}` : '';
      out.push(`CREATE TRIGGER match_facts_${input.table}_${event.toLowerCase()} AFTER ${on} ON ${input.table}${when} BEGIN
  INSERT INTO player_match_facts_dirty (player_id) SELECT pid FROM (${sources.join(' UNION ')}) WHERE pid IS NOT NULL AND pid NOT IN (SELECT player_id FROM player_match_facts_dirty);
END;`);
    }
  }
  return out.join('\n');
}

/** The policy the stored facts were derived under: a change rebuilds every row at boot. */
export const matchFactsPolicyKey = ({ trustPolicyVersion, simulatedEvidence }) => `facts1|trust${trustPolicyVersion}|sim${simulatedEvidence ? 1 : 0}`;

/** A name's sort key (`name_key`): case and accents folded, so "Émile" sorts with "Emile"; then code-point order. */
export function foldName(v) { return typeof v === 'string' ? v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() : v; }

// ------------------------------------------------------------------ typing a facts record (from the builder)
const refusal = (message) => Object.assign(new Error(`MATCH_FACTS_INVALID: ${message}`), { code: 'MATCH_FACTS_INVALID' });
const instant = (v, f, id) => { if (v === null) return null; if (!Number.isSafeInteger(v) || v <= 0) throw refusal(`player ${id}: ${f} must be a positive whole instant or null`); return v; };
function typeFacts(id, f) {
  if (f.position !== null && !PLAYER_POSITIONS.includes(f.position)) throw refusal(`player ${id}: position ${JSON.stringify(f.position)} is not a position code`);
  if (f.availability !== null && !(typeof f.availability === 'string' && f.availability.length >= 1 && f.availability.length <= MATCH_FACT_LIMITS.availability)) throw refusal(`player ${id}: availability must be text of 1 to ${MATCH_FACT_LIMITS.availability} characters or null`);
  if (f.trustBand !== null && !TRUST_BAND_IDS.includes(f.trustBand)) throw refusal(`player ${id}: trust band ${JSON.stringify(f.trustBand)} is unknown`);
  const secondary = [...new Set(f.secondaryPositions ?? [])];
  if (secondary.length > MATCH_FACT_LIMITS.secondary || secondary.some((p) => !PLAYER_POSITIONS.includes(p))) throw refusal(`player ${id}: secondary positions must be at most ${MATCH_FACT_LIMITS.secondary} position codes`);
  const combine = Object.entries(f.combine ?? {}).map(([protocol, best]) => {
    if (!(protocol.length >= 1 && protocol.length <= MATCH_FACT_LIMITS.protocol)) throw refusal(`player ${id}: a Combine protocol id must be 1 to ${MATCH_FACT_LIMITS.protocol} characters`);
    if (best !== null && !Number.isFinite(best)) throw refusal(`player ${id}: a Combine best measurement must be a number or null`);
    return [protocol, best];
  });
  return {
    name_key: foldName(f.name ?? '').slice(0, 120), position: f.position, availability: f.availability, trust_band: f.trustBand,
    last_evidence_at: instant(f.lastEvidenceAt, 'lastEvidenceAt', id), last_footage_at: instant(f.lastFootageAt, 'lastFootageAt', id),
    coach_reference: f.coachReference ? 1 : 0, club_confirmed: f.clubConfirmed ? 1 : 0,
    refresh_due_at: f.refreshDueAt === null ? null : instant(f.refreshDueAt, 'refreshDueAt', id),
    secondary, combine,
  };
}

/**
 * The facts columns a match read selects (alias `f`), and a row's facts in the engine's shape, without the fields the
 * players row gives (name, age, level, foot, distance): `factsOfRow` adds those.
 */
export const FACT_COLS = ['name_key', 'position', 'availability', 'trust_band', 'last_evidence_at', 'last_footage_at', 'coach_reference', 'club_confirmed'];

export function createMatchFactsRepository({ sqlite, now = Date.now }) {
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) { s = sqlite.prepare(sql); cache.set(sql, s); } return s; };
  const operation = (fn) => (sqlite.isTransaction ? fn() : transaction(sqlite, fn));

  /** Write one player's facts (`null`: the player is gone or retained, so the row goes). The caller clears the marker. */
  const write = (playerId, facts) => operation(() => {
    q('DELETE FROM player_match_facts WHERE player_id = ?').run(playerId);
    if (facts === null) return;
    const t = typeFacts(playerId, facts);
    q(`INSERT INTO player_match_facts (player_id, ${FACT_COLS.join(', ')}, refresh_due_at, refreshed_at) VALUES (?, ${FACT_COLS.map(() => '?').join(', ')}, ?, ?)`)
      .run(playerId, ...FACT_COLS.map((c) => t[c]), t.refresh_due_at, now());
    t.secondary.forEach((code, ord) => q('INSERT INTO player_match_fact_positions (player_id, ord, code) VALUES (?, ?, ?)').run(playerId, ord, code));
    for (const [protocol, best] of t.combine) q('INSERT INTO player_match_fact_combine (player_id, protocol_id, best_value) VALUES (?, ?, ?)').run(playerId, protocol, best);
  });

  /** Child rows of a page's players, in one query each: Map playerId → { secondary, combine }. */
  const childrenOf = (ids) => {
    const out = new Map(ids.map((id) => [id, { secondary: [], combine: {} }]));
    if (!ids.length) return out;
    const json = JSON.stringify(ids);
    for (const r of q('SELECT player_id, code FROM player_match_fact_positions WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY player_id, ord').all(json)) out.get(r.player_id)?.secondary.push(r.code);
    for (const r of q('SELECT player_id, protocol_id, best_value FROM player_match_fact_combine WHERE player_id IN (SELECT value FROM json_each(?)) ORDER BY player_id, protocol_id').all(json)) { const o = out.get(r.player_id); if (o) o.combine[r.protocol_id] = r.best_value; }
    return out;
  };

  return {
    write,
    /** Up to `limit` dirty player ids. */
    dirty: (limit = 500) => q('SELECT player_id FROM player_match_facts_dirty LIMIT ?').all(limit).map((r) => r.player_id),
    clearDirty: (ids) => { if (ids.length) q('DELETE FROM player_match_facts_dirty WHERE player_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)); },
    dirtyCount: () => q('SELECT COUNT(*) AS n FROM player_match_facts_dirty').get().n,
    /** Mark the players whose time-only change is due (the sweep); returns how many. */
    markDue: (at = now()) => Number(q('INSERT OR IGNORE INTO player_match_facts_dirty (player_id) SELECT player_id FROM player_match_facts WHERE refresh_due_at IS NOT NULL AND refresh_due_at <= ?').run(at).changes),
    /** Mark every live player and every facts row (a policy change, a first derivation). */
    markAll: () => Number(q('INSERT OR IGNORE INTO player_match_facts_dirty (player_id) SELECT id FROM players WHERE deleted_at IS NULL UNION SELECT player_id FROM player_match_facts').run().changes),
    policyKey: () => q('SELECT value FROM meta WHERE key = ?').get(MATCH_FACTS_POLICY_META)?.value ?? null,
    setPolicyKey: (key) => q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MATCH_FACTS_POLICY_META, key),
    /** One player's stored facts row (tests and the capability report), or null. */
    row: (playerId) => { const r = q('SELECT * FROM player_match_facts WHERE player_id = ?').get(playerId); if (!r) return null; const c = childrenOf([playerId]).get(playerId); return { ...r, secondary: c.secondary, combine: c.combine }; },
    childrenOf,
    counts: () => ({ players: q('SELECT COUNT(*) AS n FROM player_match_facts').get().n, dirty: q('SELECT COUNT(*) AS n FROM player_match_facts_dirty').get().n, due: q('SELECT COUNT(*) AS n FROM player_match_facts WHERE refresh_due_at IS NOT NULL').get().n }),
    /**
     * A match query over the players `visible` admits (identity's visibleWhere, alias p) joined to their facts (f):
     * `where` more `{ sql, args }` conditions; `order` `[[expr, 'ASC'|'DESC', args?], …]`, the last key unique (the id).
     *   page(…, { limit, after })  one keyset page plus one row (each with `k0…kN`)
     *   count(…)                   how many match
     *   ids(…)                     every matching id, in code-point order (a watchlist's membership)
     */
    query: (visible, where = []) => {
      const conds = [visible.sql, ...where.map((c) => `(${c.sql})`)].join(' AND ');
      const args = [...visible.args, ...where.flatMap((c) => c.args ?? [])];
      const from = `FROM players p JOIN player_match_facts f ON f.player_id = p.id WHERE ${conds}`;
      const cols = `p.id AS id, p.name AS name, p.birth_date AS birth_date, p.country AS country, p.level AS level, p.foot AS foot, p.lat AS lat, p.lng AS lng, ${FACT_COLS.map((c) => `f.${c} AS f_${c}`).join(', ')}`;
      return {
        count: () => q(`SELECT COUNT(*) AS n ${from}`).get(...args).n,
        ids: () => q(`SELECT p.id AS id ${from}`).all(...args).map((r) => r.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        page: (order, { limit, after = null }) => {
          const keys = order.map(([expr], i) => `${expr} AS k${i}`).join(', ');
          const keyArgs = order.flatMap(([, , a = []]) => a);
          const beyond = after ? ` WHERE (${order.map((_, i) => `(${[...order.slice(0, i).map((__, j) => `k${j} = ?`), `k${i} ${order[i][1] === 'DESC' ? '<' : '>'} ?`].join(' AND ')})`).join(' OR ')})` : '';
          const afterArgs = after ? order.flatMap((_, i) => [...after.slice(0, i), after[i]]) : [];
          return q(`SELECT * FROM (SELECT ${cols}, ${keys} ${from})${beyond} ORDER BY ${order.map(([, dir], i) => `k${i} ${dir}`).join(', ')} LIMIT ?`).all(...keyArgs, ...args, ...afterArgs, limit + 1);
        },
      };
    },
  };
}
