// The write rules, checked rather than left as conventions (docs/architecture.md, "Writes"):
//
//  1. A request commits at most one transaction that changes rows: an act and everything it records (its
//     notifications, ledger and audit rows) commit or roll back together, in one unit of work.
//  2. A GET or HEAD request commits nothing, unless it declares the write (`declareAuditedRead`).
//  3. Nothing leaves the process (mail, push, a live event, a provider call) while a transaction is open.
//  4. Every write runs inside a transaction: a statement that writes outside one is reported.
//
// What a request commits is counted from SQLite's own change counter (`total_changes()`), so a transaction that
// changed nothing is not counted, and a write that bypassed the transaction helpers is still seen. Not counted:
// the id counter's mints (a lost mint leaves a gap, never a wrong row); after-commit side effects and the delivery
// records they write (`sideEffect`); sweeps, which commit one transaction per item by design (`asSweep`); a row
// created on first use and a credential's bookkeeping (`apartFromTheAct`); state a read reconciles (`asReconciling`); and work
// outside any request (boot, timers).
//
// A broken rule throws outside production, so a battery fails at the call site; in production it is counted and
// logged (`state()`), because the commit it would refuse is the second one, and the first is already durable.
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
const RULES = new WeakMap();

// While routes are being moved onto one unit each, the ones that still commit more than once are listed here and
// counted instead of refused. The list only shrinks.
export const TRANSITIONAL_ROUTES = new Set([
  'DELETE /guardian/children/:id',
  'DELETE /player/account',
  'POST /auth/guardian/signup',
  'POST /auth/org/login',
  'POST /auth/sso/callback',
  'POST /callbacks/delivery',
  'POST /org/agent/agency/team',
  'POST /org/agent/clients/request',
  'POST /org/agent/transactions/:id/consents/request',
  'POST /org/rooms/:id/transaction-handoff',
]);

/** Run `fn` as one HTTP request. `routeKey()` names the matched route (`POST /org/rooms/:id`) once Express knows it. */
export function inRequest({ method, routeKey }, fn) {
  return scope.run({ request: { method, routeKey, first: null, auditedRead: null }, exempt: null }, fn);
}

const exempt = (kind, fn) => scope.run({ request: scope.getStore()?.request ?? null, exempt: kind }, fn);

/** Run an after-commit side effect: what it writes (a push log row, a mail outbox row) is not the request's act. */
export const sideEffect = (fn) => exempt('side_effect', fn);

/** Run a sweep from inside a request: each item is its own transaction, by design. */
export const asSweep = (fn) => exempt('sweep', fn);

/**
 * A write that is not the request's act and costs nothing if lost or committed on its own: a row created on first
 * use (the first member of an agency becomes its administrator), or bookkeeping about the caller's credential (an
 * API key's last use). Any route may do it, a read included. `why` names it for the reader.
 */
export const apartFromTheAct = (why, fn) => exempt(`apart: ${why}`, fn);

/** A read that must leave a record of itself (a shared passport opened). It lifts rule 2 only. */
export function declareAuditedRead(reason) {
  const request = scope.getStore()?.request;
  if (request) request.auditedRead = reason;
}

/**
 * Bring stored workflow state up to date with current facts when it is read, because nothing else does (a
 * watchlist's membership, the Second Look queue, a player's evidence-gap suggestions). Idempotent and independent
 * of the request's act, so it is not counted as the act, and a read may do it. Each is a known exception
 * (docs/known-issues.md): it belongs in a sweep.
 */
export const asReconciling = (fn) => exempt('reconcile', fn);

/** A write outside any transaction that is allowed, because losing it costs nothing (the id counter's mint). */
export function standaloneWrite(sqlite, fn) {
  const rules = RULES.get(sqlite);
  if (!rules || sqlite.isTransaction) return fn();
  rules.checkDrift();
  try {
    return fn();
  } finally {
    rules.settle();
  }
}

export const rulesOf = (sqlite) => RULES.get(sqlite) ?? null;

const isRead = (method) => method === 'GET' || method === 'HEAD';

function callSite() {
  const lines = String(new Error().stack).split('\n').slice(1);
  // The first frame of the code that asked for the write, past the server's `unit` wrapper.
  const own = lines.find((l) => /\/(domains|server\.mjs|adapters\.mjs)/.test(l) && !/^\s*at unit \(/.test(l));
  return (own ?? lines.find((l) => !/(writeRules|store|database)\.mjs/.test(l)) ?? '')
    .trim()
    .replace(/^at /, '')
    .replace(/\(?file:\/\/\S*?scoutbox-server\//, '')
    .replace(/\)$/, '');
}

/**
 * The rules for one connection. `enforce`: throw on a broken rule (everywhere but production). `transitional`:
 * route keys that are counted instead of refused.
 */
export function attachWriteRules(sqlite, { enforce = true, transitional = TRANSITIONAL_ROUTES } = {}) {
  const total = sqlite.prepare('SELECT total_changes() AS n');
  const changes = () => total.get().n;
  let settled = changes();
  let atBegin = null;
  const counts = { violations: 0, transitional: 0, outward: 0, writesOutsideTransaction: 0 };
  let lastViolation = null;

  function violation(rule, message, request) {
    const route = request?.routeKey?.() ?? null;
    const listed = route && transitional.has(route) && rule !== 'outward';
    if (listed) counts.transitional += 1;
    else counts.violations += 1;
    lastViolation = { at: Date.now(), rule, route, message: message.slice(0, 300) };
    if (listed) return;
    const err = Object.assign(new Error(`WRITE_RULE ${rule}: ${message}`), { code: 'WRITE_RULE_BROKEN', rule });
    if (enforce || rule === 'outward') throw err;
    console.error(err.message);
  }

  const counted = () => {
    const s = scope.getStore();
    return s?.request && !s.exempt ? s.request : null;
  };

  const rules = {
    /** A write ran outside any transaction since the last settle: report it (rule 4). */
    checkDrift() {
      if (sqlite.isTransaction) return;
      const now = changes();
      if (now === settled) return;
      settled = now;
      counts.writesOutsideTransaction += 1;
      const request = counted();
      if (request)
        violation(
          'write_outside_transaction',
          `a statement wrote with no transaction open, before ${callSite()} (writes go through a repository operation or a unit of work)`,
          request,
        );
    },
    settle() {
      settled = changes();
    },
    /** BEGIN was just executed. */
    began() {
      atBegin = changes();
    },
    /** Just before COMMIT, inside the transaction: a throw here rolls it back (rules 1 and 2). */
    beforeCommit() {
      const request = counted();
      if (!request || atBegin === null || changes() === atBegin) return;
      const here = enforce ? callSite() : null;
      if (isRead(request.method) && !request.auditedRead)
        violation(
          'read_wrote',
          `${request.routeKey()} is a read and committed a write at ${here ?? '?'} (a read never writes; a notice it needs comes from a sweep)`,
          request,
        );
      if (request.first)
        violation(
          'second_commit',
          `${request.routeKey()} committed a second transaction at ${here ?? '?'}; the first was at ${request.first} (one act, one unit of work)`,
          request,
        );
      request.first = here ?? 'an earlier transaction';
    },
    /** COMMIT or ROLLBACK returned. */
    ended() {
      atBegin = null;
      settled = changes();
    },
    /** Rule 3: refuse to let anything leave the process while a transaction is open. */
    checkOutward(what) {
      if (!sqlite.isTransaction) return;
      counts.outward += 1;
      violation(
        'outward',
        `${what} was sent while a transaction is open (register it with store.afterCommit, or send it after the unit)`,
        scope.getStore()?.request ?? null,
      );
    },
    /** Called when a request has finished: a write it made outside a transaction at the very end is still seen. */
    requestEnded() {
      try {
        rules.checkDrift();
      } catch (err) {
        console.error(err.message); // the response has gone; only the report is left
      }
    },
    state: () => ({ ...counts, lastViolation }),
  };
  RULES.set(sqlite, rules);
  return rules;
}
