/**
 * M18.1 — canonical source-change events.
 *
 * M18 declared two change types it could never emit, because no honest clock
 * existed for them:
 *
 *   - `position_changed`: `positionHistory.from` is the FOOTBALL date the
 *     player started playing the position, and `prefs.updatedAt` moves when any
 *     preference is edited. Neither one dates the change.
 *   - `current_club_confirmed`: derivable, but only from rows that each already
 *     carry their own genuine clock.
 *
 * Rather than guess a timestamp from a record that means something else — the
 * single worst thing this store could do — M18.1 does two things:
 *
 *   1. where a canonical row already carries an honest clock (a signing's `ts`,
 *      a squad row's `addedAt`, a verified claim's `verifiedAt`, a Box Cam
 *      session's invalidation), the collector reads THAT clock;
 *   2. where no clock exists at all (a position preference edit), the write
 *      site appends an event here, with the time it actually happened.
 *
 * This store is append-only and holds no player content: a type, the canonical
 * source identity, when it happened, and a small structured detail used for
 * copy. It is not a second copy of anything.
 *
 * The store is the source_changes table (repositories/safetyAudit.mjs): a
 * recorded change is one explicit write that also drops the OLDEST rows beyond
 * the cap (SOURCE_CHANGE_CAP), in the caller's unit of work when one is open.
 */

export function registerSourceChanges(ctx) {
  const { nextId, safetyAudit } = ctx;

  /**
   * Append a canonical source change. `occurredAt` must be the moment the fact
   * changed — never a record's creation time standing in for a different event.
   */
  ctx.recordSourceChange = ({ playerId, type, sourceSystem, sourceId, occurredAt = Date.now(), detail = null }) => {
    if (!playerId || !type || !sourceSystem) return null;
    return safetyAudit.sourceChanges.record({
      id: nextId('srcc'),
      playerId, type, sourceSystem,
      sourceId: sourceId ?? null,
      occurredAt,
      detail: detail ?? null,
    });
  };

  /** Every recorded change for a player, oldest first. */
  ctx.sourceChangesFor = (playerId) => safetyAudit.sourceChanges.forPlayer(playerId);
}
