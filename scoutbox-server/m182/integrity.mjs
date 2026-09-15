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
import { OPEN_ROOM_STATUSES } from '../m17/shared.mjs';
import { missingRequiredStores, PRODUCTION_REQUIRED_STORES } from './migrations.mjs';

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
export function integrityReport(db) {
  const violations = [];
  const push = (code, list) => { for (const d of list) violations.push({ code, key: String(d.key), ids: d.ids.map(String) }); };

  const cases = (db.recruitmentCases ?? []).filter((c) => c && c.room);
  // One OPEN Room per organisation and player (a closed history may repeat).
  push('ROOM_OPEN_DUPLICATE', dupes(
    cases.filter((c) => OPEN_ROOM_STATUSES.includes(c.room.status)),
    (c) => `${c.orgId}:${c.playerId}`,
  ));
  push('CASE_ID_DUPLICATE', dupes(db.recruitmentCases ?? [], (c) => c?.id));
  push('BRIEF_ID_DUPLICATE', dupes(db.recruitmentBriefs ?? [], (b) => b?.id));
  push('PLAYER_ID_DUPLICATE', dupes(db.players ?? [], (p) => p?.id));
  push('ORG_ID_DUPLICATE', dupes(db.orgs ?? [], (o) => o?.id));
  // One Second Look item per (org, room): the engine's own invariant.
  push('SECOND_LOOK_ITEM_DUPLICATE', dupes(db.secondLookItems ?? [], (i) => i ? `${i.orgId}:${i.roomId}` : null));
  // Within one item, a change fingerprint appears once — a duplicated
  // fingerprint would count the same evidence twice towards the threshold.
  for (const item of db.secondLookItems ?? []) {
    const seen = new Set();
    for (const c of item?.changes ?? []) {
      if (!c?.fingerprint) continue;
      if (seen.has(c.fingerprint)) violations.push({ code: 'SECOND_LOOK_FINGERPRINT_DUPLICATE', key: `${item.id}:${c.fingerprint}`, ids: [String(item.id)] });
      seen.add(c.fingerprint);
    }
  }
  // A Room must belong to an organisation and a player that exist.
  const orgIds = new Set((db.orgs ?? []).map((o) => o?.id));
  const playerIds = new Set((db.players ?? []).map((p) => p?.id));
  for (const c of cases) {
    if (!orgIds.has(c.orgId)) violations.push({ code: 'ROOM_ORPHAN_ORG', key: String(c.orgId), ids: [String(c.id)] });
    if (!playerIds.has(c.playerId)) violations.push({ code: 'ROOM_ORPHAN_PLAYER', key: String(c.playerId), ids: [String(c.id)] });
  }
  // A rev-guarded record carries a positive integer rev after migration.
  for (const c of cases) if (!Number.isInteger(c.room.rev) || c.room.rev < 1) violations.push({ code: 'ROOM_REV_INVALID', key: String(c.room.rev), ids: [String(c.id)] });
  for (const b of db.recruitmentBriefs ?? []) if (!Number.isInteger(b?.rev) || b.rev < 1) violations.push({ code: 'BRIEF_REV_INVALID', key: String(b?.rev), ids: [String(b?.id)] });

  const checked = cases.length + (db.recruitmentBriefs ?? []).length + (db.players ?? []).length
    + (db.orgs ?? []).length + (db.secondLookItems ?? []).length;

  // M23-D2 — required collections that are absent.
  //
  // Reported SEPARATELY from `violations`, deliberately. A violation here means
  // two records disagree; a missing store means the database was never built.
  // They need different responses from a person, and folding them together
  // would have redefined a prior invariant: M18.2 asserts that an empty
  // database has no violations, and that assertion is correct — an empty
  // database has no conflicting records. It should not become false because a
  // later milestone taught this function a second subject.
  //
  // Reported, never repaired (§45): a boot script that quietly creates a
  // container hides why it was missing.
  const missingStores = missingRequiredStores(db);

  return {
    ok: violations.length === 0,
    checked,
    violations,
    stores: { required: PRODUCTION_REQUIRED_STORES.length, missing: missingStores, ok: missingStores.length === 0 },
  };
}

/** Counts by code — what /capabilities shows. Never the keys. */
export const integritySummary = (report) => ({
  ok: report.ok,
  checked: report.checked,
  violations: report.violations.length,
  byCode: report.violations.reduce((acc, v) => { acc[v.code] = (acc[v.code] ?? 0) + 1; return acc; }, {}),
  // M23-D2 — collection names are not sensitive: they are schema, not data.
  stores: report.stores ?? { required: 0, missing: [], ok: true },
});
