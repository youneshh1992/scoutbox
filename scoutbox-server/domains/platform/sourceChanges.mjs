/**
 * A clock for changes whose records carry none: `positionHistory.from` is the
 * football date a player started a position and `prefs.updatedAt` moves on any
 * preference edit, so neither dates a `position_changed`. Where a row already
 * has an honest clock (a signing's `ts`, say) the collector reads that instead.
 * Append-only, no player content; the oldest rows beyond SOURCE_CHANGE_CAP are dropped.
 */

export function createSourceChanges({ nextId, safetyAudit }) {
  if (typeof safetyAudit?.sourceChanges?.record !== 'function' || typeof nextId !== 'function')
    throw new TypeError('createSourceChanges needs the safety-audit repository and nextId');

  /** `occurredAt` is when the fact changed, never a record's creation time standing in for it. */
  const recordSourceChange = ({ playerId, type, sourceSystem, sourceId, occurredAt = Date.now(), detail = null }) => {
    if (!playerId || !type || !sourceSystem) return null;
    return safetyAudit.sourceChanges.record({
      id: nextId('srcc'),
      playerId,
      type,
      sourceSystem,
      sourceId: sourceId ?? null,
      occurredAt,
      detail: detail ?? null,
    });
  };

  /** Oldest first. */
  const sourceChangesFor = (playerId) => safetyAudit.sourceChanges.forPlayer(playerId);

  return { recordSourceChange, sourceChangesFor };
}
