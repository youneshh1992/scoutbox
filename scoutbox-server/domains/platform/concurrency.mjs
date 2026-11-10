/**
 * Optimistic concurrency for collaborative records. A request may send the
 * `rev` it was editing; if the record has moved on the write gets 409.
 *
 * `rev` is separate from a Brief's `version`, the criteria version that
 * Evaluation Coverage points at, which does not move on a status change.
 * Requests may still spell it `expectedVersion`.
 *
 * Comments, tags, tasks and notes are not versioned: a lost update there is an
 * inconvenience, and demanding a rev for trivial edits trains people to send
 * whatever number makes the error go away.
 */

export function expectedRevOf(body) {
  const raw = body?.expectedRev ?? body?.expectedVersion;
  if (raw === undefined || raw === null || raw === '') return null;
  // `Number()` on an object calls its own `toString`/`valueOf`, so `{ toString: 1 }` would throw a 500.
  if (typeof raw !== 'number' && typeof raw !== 'string') return Number.NaN;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN; // NaN = malformed
}

/** A record with no `rev` is rev 1. */
export const revOf = (record) => Number(record?.rev ?? 1);

/**
 * Returns true when the caller may proceed; otherwise it has answered. The
 * conflict body never carries the colleague's content, which the caller gets
 * by reloading through its own authorised read.
 */
export function guardRev(req, res, record, { errorCode, current }) {
  const expected = expectedRevOf(req.body);
  if (Number.isNaN(expected)) {
    res.status(400).json({ error: 'EXPECTED_REV_INVALID', message: 'expectedRev must be a whole number.' });
    return false;
  }
  if (expected === null) return true; // not supplied: the write is unguarded
  const now = revOf(record);
  if (expected === now) return true;
  res.status(409).json({
    error: errorCode,
    expectedRev: expected,
    currentRev: now,
    // A display name, never a user id.
    updatedBy: record?.revBy?.name ?? null,
    updatedAt: record?.revAt ?? null,
    ...current,
    message: 'Someone else changed this while you were working on it. Reload to see their change, then apply yours.',
  });
  return false;
}

/** Call once per accepted write, at the end. */
export function bumpRev(record, { by = null, at = Date.now() } = {}) {
  record.rev = revOf(record) + 1;
  record.revAt = at;
  record.revBy = by ? { userId: by.id ?? null, name: by.name ?? null } : null;
  return record.rev;
}

export const revMeta = (record) => ({
  rev: revOf(record),
  revAt: record?.revAt ?? null,
  revBy: record?.revBy?.name ?? null,
});
