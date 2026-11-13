/**
 * The delivery centre's bookkeeping (domains/messaging/delivery.mjs): the provider callback ids already applied (the
 * newest 5,000, at most 1,000 more), the instant the delivery centre started (one row, written by the migration:
 * notifications older than it are never sent externally) and the admin-injected provider failures still to fire, by
 * channel (one row per channel, written by the migration).
 *
 * Every write joins the open unit of work, the caller's transaction or its own.
 */
import { describe } from './fieldSpecs.mjs';
import { migrationApplied, operationOn } from './database.mjs';
import { writeKit } from './writes.mjs';

export const DELIVERY_BOOKKEEPING_MIGRATION = '0038_operations';
export const DELIVERY_BOOKKEEPING_COLLECTIONS = Object.freeze(['deliveryCallbacksSeen']);
export const DELIVERY_BOOKKEEPING_TABLES = Object.freeze([
  'delivery_callbacks_seen',
  'delivery_centre',
  'delivery_fail_injections',
]);

export const FAIL_INJECT_CHANNELS = Object.freeze(['email', 'push', 'contact', 'trial', 'decision']);
const L = Object.freeze({ callbackId: 200, callbacksKept: 5000, callbacksPruned: 1000 });

export const DELIVERY_BOOKKEEPING_DDL = `CREATE TABLE delivery_callbacks_seen (
  callback_id TEXT PRIMARY KEY CHECK (length(callback_id) > 0 AND length(callback_id) <= ${L.callbackId}),
  seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_centre (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  since INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_fail_injections (
  channel TEXT PRIMARY KEY CHECK (channel IN (${FAIL_INJECT_CHANNELS.map((c) => `'${c}'`).join(',')})),
  remaining INTEGER NOT NULL CHECK (remaining >= 0)
) STRICT;`;

/** The migration's rows: the delivery centre starts now (nothing older is ever sent externally) and no failure is injected. */
export function seedDeliveryRows(sqlite, now) {
  sqlite.prepare('INSERT INTO delivery_centre (id, since) VALUES (1, ?)').run(now);
  const inject = sqlite.prepare('INSERT INTO delivery_fail_injections (channel, remaining) VALUES (?, 0)');
  for (const c of FAIL_INJECT_CHANNELS) inject.run(c);
}

export const deliveryBookkeepingLive = (sqlite) => migrationApplied(sqlite, DELIVERY_BOOKKEEPING_MIGRATION);
/** The callback ids read back (`readAllRecords` in index.mjs: the test suites' read-back). */
export const DELIVERY_BOOKKEEPING_RECORDS = {
  names: DELIVERY_BOOKKEEPING_COLLECTIONS,
  read: (sqlite) =>
    deliveryBookkeepingLive(sqlite)
      ? {
          deliveryCallbacksSeen: sqlite
            .prepare('SELECT callback_id FROM delivery_callbacks_seen ORDER BY rowid')
            .all()
            .map((r) => r.callback_id),
        }
      : null,
};

const WRITES = new Set(['markSeen', 'inject', 'consumeInjectedFailure']);

/** `createDeliveryBookkeepingRepository({ sqlite, unit, now, log })`: the writes and queries, plus `reads`. */
export function createDeliveryBookkeepingRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the delivery bookkeeping repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const { q, invalid } = writeKit(sqlite, 'DELIVERY');

  const injected = (channel) =>
    q('SELECT remaining FROM delivery_fail_injections WHERE channel = ?').get(channel)?.remaining ?? 0;
  const acts = {
    /** Remembers a provider callback id. False when it was already applied (the caller skips it). */
    markSeen: (callbackId, at) =>
      operation(() => {
        if (typeof callbackId !== 'string' || !callbackId.length || callbackId.length > L.callbackId)
          throw invalid(`a callback id is 1 to ${L.callbackId} characters (got ${describe(callbackId)})`);
        const added = q('INSERT OR IGNORE INTO delivery_callbacks_seen (callback_id, seen_at) VALUES (?, ?)').run(
          callbackId,
          at,
        ).changes;
        if (added !== 1) return false;
        if (q('SELECT COUNT(*) AS n FROM delivery_callbacks_seen').get().n > L.callbacksKept) {
          q(
            'DELETE FROM delivery_callbacks_seen WHERE rowid IN (SELECT rowid FROM delivery_callbacks_seen ORDER BY rowid LIMIT ?)',
          ).run(L.callbacksPruned);
        }
        return true;
      }),
    hasSeen: (callbackId) => !!q('SELECT 1 FROM delivery_callbacks_seen WHERE callback_id = ?').get(callbackId),
    seenCount: () => q('SELECT COUNT(*) AS n FROM delivery_callbacks_seen').get().n,
    /** Notifications created before this instant are never sent externally (no retroactive blast). */
    centreSince: () => q('SELECT since FROM delivery_centre WHERE id = 1').get().since,
    /** The next `count` sends on `channel` fail at the provider. Returns the channel's remaining count. */
    inject: (channel, count) =>
      operation(() => {
        if (!FAIL_INJECT_CHANNELS.includes(channel) || !Number.isSafeInteger(count) || count < 1)
          throw invalid('an injection names a channel and a positive count');
        q('UPDATE delivery_fail_injections SET remaining = remaining + ? WHERE channel = ?').run(count, channel);
        return injected(channel);
      }),
    /** Uses up one injected failure on `channel`: true when one was waiting (the send must fail). */
    consumeInjectedFailure: (channel) =>
      operation(
        () =>
          q('UPDATE delivery_fail_injections SET remaining = remaining - 1 WHERE channel = ? AND remaining > 0').run(
            channel,
          ).changes === 1,
      ),
    injected,
  };
  const counts = () => ({ deliveryCallbacksSeen: acts.seenCount() });
  return {
    ...acts,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(acts).filter(([k]) => !WRITES.has(k)))),
    attach() {
      if (!deliveryBookkeepingLive(sqlite))
        throw new Error(`the delivery bookkeeping repository needs ${DELIVERY_BOOKKEEPING_MIGRATION} recorded`);
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll: () => DELIVERY_BOOKKEEPING_RECORDS.read(sqlite),
    log,
    now,
  };
}
