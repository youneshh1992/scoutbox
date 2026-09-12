/**
 * M18.1 — optimistic concurrency for collaborative organisation records.
 *
 * Recruitment Rooms and Recruitment Briefs are worked on by several people at
 * once. Before M18.1 the last write won: two scouts editing the same brief, or
 * moving the same room, silently overwrote each other and nothing recorded that
 * it had happened. That is a lost update, and on a room it can also lose the
 * reason a decision was recorded against.
 *
 * The mechanism is deliberately boring and identical for both records:
 *
 *   - every collaborative record carries `rev`, an integer that increments on
 *     every ACCEPTED mutation;
 *   - a mutating request may supply the rev it was editing;
 *   - if the record has moved on, the write is refused with 409 and the caller
 *     is told what the current state is so it can reload and re-apply.
 *
 * `rev` is a separate field from the Recruitment Brief's existing `version`,
 * which means something else and must keep meaning it: `version` is the
 * CRITERIA version that historical Evaluation Coverage points at, and it
 * deliberately does not move when only the brief's status changes. A
 * concurrency token has to move on every mutation, so it is its own field. The
 * conflict response carries both, and the request accepts either spelling
 * (`expectedRev`, or `expectedVersion` for callers that think in the
 * mandate's vocabulary).
 *
 * Deliberately NOT versioned: comments, tags, tasks and notes. A lost update
 * there is an inconvenience, not a corrupted decision record, and demanding a
 * rev for every trivial edit trains people to send whatever number makes the
 * error go away.
 */

/** Read the caller's expected revision, accepting either spelling. */
export function expectedRevOf(body) {
  const raw = body?.expectedRev ?? body?.expectedVersion;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN; // NaN = malformed
}

/** Current revision of a record that may predate M18.1 (treated as rev 1). */
export const revOf = (record) => Number(record?.rev ?? 1);

/**
 * Guard a mutation. Returns true when the caller may proceed; otherwise it has
 * already answered the request.
 *
 * The conflict body carries only what a colleague is allowed to know: the
 * current revision, when it changed and who changed it — never the content
 * they wrote, which the caller will get from its own reload through the normal
 * authorised read.
 */
export function guardRev(req, res, record, { errorCode, current }) {
  const expected = expectedRevOf(req.body);
  if (Number.isNaN(expected)) {
    res.status(400).json({ error: 'EXPECTED_REV_INVALID', message: 'expectedRev must be a whole number.' });
    return false;
  }
  if (expected === null) return true; // not supplied: unchanged pre-M18.1 behaviour
  const now = revOf(record);
  if (expected === now) return true;
  res.status(409).json({
    error: errorCode,
    expectedRev: expected,
    currentRev: now,
    // M18.2: who moved it and when — a display name, never a user id — so the
    // shared conflict notice can say "Tom Field changed this" instead of
    // "someone".
    updatedBy: record?.revBy?.name ?? null,
    updatedAt: record?.revAt ?? null,
    ...current,
    message: 'Someone else changed this while you were working on it. Reload to see their change, then apply yours.',
  });
  return false;
}

/** Record an accepted mutation. Call once per accepted write, at the end. */
export function bumpRev(record, { by = null, at = Date.now() } = {}) {
  record.rev = revOf(record) + 1;
  record.revAt = at;
  record.revBy = by ? { userId: by.id ?? null, name: by.name ?? null } : null;
  return record.rev;
}

/** Safe "who touched it last" metadata for a conflict body or a projection. */
export const revMeta = (record) => ({
  rev: revOf(record),
  revAt: record?.revAt ?? null,
  revBy: record?.revBy?.name ?? null,
});
