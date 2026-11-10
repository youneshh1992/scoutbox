/**
 * Boot-time integrity check for data that bypassed the handlers, such as a
 * hand-edited row. It reports and never repairs: choosing which of two
 * conflicting records wins needs a person with the context.
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

/** Reports keys and ids only, never a name, note or date of birth. */
export function integrityReport(records, { cases: allCases = [] } = {}) {
  const violations = [];
  const push = (code, list) => { for (const d of list) violations.push({ code, key: String(d.key), ids: d.ids.map(String) }); };

  const cases = allCases.filter((c) => c && c.room);
  // Closed Rooms for the same organisation and player may repeat.
  push('ROOM_OPEN_DUPLICATE', dupes(
    cases.filter((c) => OPEN_ROOM_STATUSES.includes(c.room.status)),
    (c) => `${c.orgId}:${c.playerId}`,
  ));
  push('CASE_ID_DUPLICATE', dupes(allCases, (c) => c?.id));
  push('PLAYER_ID_DUPLICATE', dupes(records.players ?? [], (p) => p?.id));
  // Brief and Second Look invariants are enforced by the discovery tables' own keys and CHECKs.
  const orgIds = new Set((records.orgs ?? []).map((o) => o?.id));
  const playerIds = new Set((records.players ?? []).map((p) => p?.id));
  for (const c of cases) {
    if (!orgIds.has(c.orgId)) violations.push({ code: 'ROOM_ORPHAN_ORG', key: String(c.orgId), ids: [String(c.id)] });
    if (!playerIds.has(c.playerId)) violations.push({ code: 'ROOM_ORPHAN_PLAYER', key: String(c.playerId), ids: [String(c.id)] });
  }
  for (const c of cases) if (!Number.isInteger(c.room.rev) || c.room.rev < 1) violations.push({ code: 'ROOM_REV_INVALID', key: String(c.room.rev), ids: [String(c.id)] });

  const checked = cases.length + (records.players ?? []).length + (records.orgs ?? []).length;

  return {
    ok: violations.length === 0,
    checked,
    violations,
  };
}

/** What /capabilities shows: counts, never the keys. */
export const integritySummary = (report) => ({
  ok: report.ok,
  checked: report.checked,
  violations: report.violations.length,
  byCode: report.violations.reduce((acc, v) => { acc[v.code] = (acc[v.code] ?? 0) + 1; return acc; }, {}),
});
