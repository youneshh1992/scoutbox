/**
 * M18.2 — the organisation audit view.
 *
 * Nothing here is new history. Recruitment Rooms have carried an append-only
 * `history` since M17, Recruitment Briefs since M18, and staff removal has been
 * a Discovery Ledger row since M12. What an organisation's leads could not do
 * was read them together, in order, without opening each record. This route
 * is a read-only projection over those three sources.
 *
 * Three rules, in priority order:
 *
 *   1. Leads and directors only. A scout sees their own Rooms' activity in the
 *      Room; the organisation-wide view is administrative. Players, guardians
 *      and every other organisation get exactly what a route that does not
 *      exist would give them.
 *   2. No content. An entry says WHAT happened and WHO did it. It never carries
 *      a note body, a comment body, a decision note, an assessment or a
 *      player's private field. Reason codes are structured vocabulary the
 *      organisation itself chose, so they are shown; the free text next to
 *      them is not.
 *   3. Bounded. Cursor pagination, at most 50 rows per page, newest first,
 *      stable across reads (time, then id).
 */

const PAGE_MAX = 50;
const PAGE_DEFAULT = 25;

/** Room activity types worth an administrator's attention. Chatter is not. */
const ROOM_ACTIONS = new Set([
  'room_created', 'room_status_changed', 'room_reopened', 'room_decision_recorded',
  'room_owner_changed', 'room_member_assigned', 'room_priority_changed',
  'room_evidence_requested', 'room_assessment_assigned',
]);
const BRIEF_ACTIONS = new Set([
  'recruitment_brief_created', 'recruitment_brief_updated', 'recruitment_brief_activated',
]);
const WATCHLIST_ACTIONS = new Set(['watchlist_created', 'watchlist_updated', 'watchlist_archived']);
const LEDGER_ACTIONS = new Set(['staff_removed', 'signing', 'released_by_club']);

/** The structured, content-free summary of one history detail. */
function safeDetail(action, detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['from', 'to', 'status', 'priority', 'recommendation', 'version', 'criteriaChanged', 'sourceContext', 'kind']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  if (Array.isArray(detail.reasonCodes)) out.reasonCodes = detail.reasonCodes.slice(0, 10);
  // `note: true|false` is whether a note was written — never the note.
  if (typeof detail.note === 'boolean') out.hadNote = detail.note;
  return Object.keys(out).length ? out : null;
}

export function registerAudit(ctx) {
  const { db, orgRouter, requireLead, findPlayer, orgCanSee } = ctx;

  function entriesFor(org) {
    const rows = [];
    for (const c of db.recruitmentCases ?? []) {
      if (c.orgId !== org.id || !c.room) continue;
      // The player is named only if the organisation may currently see them.
      const p = findPlayer(c.playerId);
      const subject = p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
      for (const h of c.history ?? []) {
        if (!ROOM_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'recruitment_room',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'room', id: c.id, ...subject },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    for (const b of db.recruitmentBriefs ?? []) {
      if (b.orgId !== org.id) continue;
      for (const h of b.history ?? []) {
        if (!BRIEF_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'recruitment_brief',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'brief', id: b.id, title: b.title },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // M19: watchlist LIFECYCLE only. Which players entered or left belongs in
    // the watchlist's own history, not in an administrator's audit feed.
    for (const w of db.dynamicWatchlists ?? []) {
      if (w.orgId !== org.id) continue;
      for (const h of w.history ?? []) {
        if (!WATCHLIST_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'dynamic_watchlist',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'watchlist', id: w.id, title: w.name },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    for (const l of db.ledger ?? []) {
      if (l.orgId !== org.id || !LEDGER_ACTIONS.has(l.type)) continue;
      rows.push({
        id: l.id, at: l.ts, action: l.type, domain: 'organisation',
        actor: l.userId ? { userId: l.userId, name: l.scoutName ?? null } : null,
        target: l.playerId ? { type: 'player', id: l.playerId } : { type: 'organisation', id: org.id },
        detail: null,
      });
    }
    // Newest first, id as the tie-break so two rows in the same millisecond
    // keep their order between reads.
    rows.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
    return rows;
  }

  orgRouter.get('/audit', (req, res) => {
    if (!requireLead(req, res)) return;
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(req.query.limit) || PAGE_DEFAULT));
    const all = entriesFor(req.org);
    let start = 0;
    if (req.query.cursor) {
      const idx = all.findIndex((r) => r.id === String(req.query.cursor));
      if (idx < 0) return res.status(400).json({ error: 'AUDIT_CURSOR_INVALID', message: 'That page no longer exists — start again from the first page.' });
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    res.json({
      items: page,
      nextCursor: start + limit < all.length ? page[page.length - 1].id : null,
      total: all.length,
      note: 'Operational history only: what happened and who did it. Notes, comments, decision text and assessments are never shown here.',
    });
  });
}
