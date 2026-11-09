/**
 * M18.2 — boot-time integrity check.
 *
 * Every invariant below is already enforced by a handler: a Room refuses to be
 * created while one is open for the same organisation and player (ROOM_EXISTS),
 * ids come from one counter, a Second Look item is one per (org, room). What
 * a handler cannot see is a snapshot that arrived by another road — a restore
 * from an older bundle, a hand-edited JSON row, a migration that ran half-way
 * on a machine that lost power. This check reads the loaded snapshot once at
 * boot and REPORTS what it finds. It never repairs anything: a silent repair
 * chooses which of two conflicting records wins, and that is a decision for a
 * person with the context, not for a boot script.
 *
 * The report is logged, surfaced on /capabilities as counts, and the pure
 * function is exported so a suite can hand it a broken snapshot directly.
 */
import { OPEN_ROOM_STATUSES } from '../recruitment/rooms/shared.mjs';

const dupes = (items, keyOf) => {
  const seen = new Map();
  const out = [];
  for (const it of items) {
    const k = keyOf(it);
    if (k == null) continue;
    if (seen.has(k)) out.push({ key: k, ids: [seen.get(k), it.id] });
    else seen.set(k, it.id);
  }
  return out;
};

/**
 * @returns {{ ok: boolean, checked: number, violations: Array<{code:string, key:string, ids:string[]}> }}
 * Keys and ids only — never a name, a note or a date of birth.
 */
/** `records` holds the `players` and `orgs` to check against (plain arrays: the server reads them from their repositories). */
export function integrityReport(records, { cases: allCases = [] } = {}) {
  const violations = [];
  const push = (code, list) => { for (const d of list) violations.push({ code, key: String(d.key), ids: d.ids.map(String) }); };

  // §4.3 step 2: the cases come from SQL (the caller passes the recruitment-cases repository's Rooms), not from db.
  const cases = allCases.filter((c) => c && c.room);
  // One OPEN Room per organisation and player (a closed history may repeat).
  push('ROOM_OPEN_DUPLICATE', dupes(
    cases.filter((c) => OPEN_ROOM_STATUSES.includes(c.room.status)),
    (c) => `${c.orgId}:${c.playerId}`,
  ));
  push('CASE_ID_DUPLICATE', dupes(allCases, (c) => c?.id));
  push('PLAYER_ID_DUPLICATE', dupes(records.players ?? [], (p) => p?.id));
  // A brief id, one Second Look item per (organisation, room, decision cycle), a fingerprint once per item and a brief's
  // rev ≥ 1 are the discovery tables' own keys and CHECKs since S12c (repositories/discovery.mjs): a row that breaks
  // them is never written, so there is nothing left to report here.
  // A Room must belong to an organisation and a player that exist.
  const orgIds = new Set((records.orgs ?? []).map((o) => o?.id));
  const playerIds = new Set((records.players ?? []).map((p) => p?.id));
  for (const c of cases) {
    if (!orgIds.has(c.orgId)) violations.push({ code: 'ROOM_ORPHAN_ORG', key: String(c.orgId), ids: [String(c.id)] });
    if (!playerIds.has(c.playerId)) violations.push({ code: 'ROOM_ORPHAN_PLAYER', key: String(c.playerId), ids: [String(c.id)] });
  }
  // A rev-guarded record carries a positive integer rev after migration.
  for (const c of cases) if (!Number.isInteger(c.room.rev) || c.room.rev < 1) violations.push({ code: 'ROOM_REV_INVALID', key: String(c.room.rev), ids: [String(c.id)] });

  const checked = cases.length + (records.players ?? []).length + (records.orgs ?? []).length;

  return {
    ok: violations.length === 0,
    checked,
    violations,
  };
}

/** Counts by code — what /capabilities shows. Never the keys. */
export const integritySummary = (report) => ({
  ok: report.ok,
  checked: report.checked,
  violations: report.violations.length,
  byCode: report.violations.reduce((acc, v) => { acc[v.code] = (acc[v.code] ?? 0) + 1; return acc; }, {}),
});
