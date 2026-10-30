/**
 * Runtime compatibility contract.
 *
 * The data layer relies on `DatabaseSync.prototype.isTransaction`
 * (node:sqlite) to tell a save transaction from autocommit: the
 * organisations repository refuses to flush outside a transaction and to
 * insert/update inside one, and the store rolls back only an open
 * transaction. The property exists from Node.js 22.16.0 (the 22 line) and
 * 24.0.0 onwards. On an older runtime the server would open the database,
 * then fail every save and leave a transaction open — so the runtime is
 * checked BEFORE the data directory is created or opened, and an unsupported
 * one is refused with `NODE_UNSUPPORTED` and nothing written.
 *
 * The decision combines the release floor (what `package.json` advertises)
 * with feature detection on an in-memory connection, so a build that lacks
 * the property is refused whatever its version string says.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/** Minimum release per supported line (what `engines.node` and the docs say). */
export const MIN_NODE = Object.freeze({ 22: '22.16.0', 24: '24.0.0' });
export const CONTRACT = `Node.js ${MIN_NODE[22]} or later on the 22 line, or ${MIN_NODE[24]} or later`;

const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => Number(n) || 0);
const atLeast = (v, min) => { const a = parse(v), b = parse(min); for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; } return true; };

/**
 * Describe the running Node.js against the contract. Never throws. Opens and
 * closes one in-memory connection for the feature check; touches no file.
 */
export function runtimeSupport() {
  const version = process.version;
  const [major] = parse(version);
  if (!DatabaseSync) {
    return { ok: false, code: 'SQLITE_REQUIRED', version, hasTransactionState: false, reason: `ScoutBox needs the node:sqlite module (${CONTRACT}, enabled by default; this is ${version}${process.execArgv.some((a) => /no-experimental-sqlite/.test(a)) ? ', started with --no-experimental-sqlite' : ''}). There is no JSON fallback.` };
  }
  let hasTransactionState = false;
  try {
    const probe = new DatabaseSync(':memory:');
    hasTransactionState = typeof probe.isTransaction === 'boolean';
    probe.close();
  } catch { hasTransactionState = false; }
  // Release floor: the two supported lines; any other line (23, 25+) is accepted only on the feature check.
  const versionOk = major >= 24 || (major === 22 ? atLeast(version, MIN_NODE[22]) : hasTransactionState);
  if (!versionOk) {
    return { ok: false, code: 'NODE_UNSUPPORTED', version, hasTransactionState, reason: `Node.js ${version} is not supported: ScoutBox needs ${CONTRACT} (node:sqlite transaction state, DatabaseSync.isTransaction, arrived in those releases).` };
  }
  if (!hasTransactionState) {
    return { ok: false, code: 'NODE_UNSUPPORTED', version, hasTransactionState, reason: `Node.js ${version} is not supported: its node:sqlite has no DatabaseSync.isTransaction, which ScoutBox needs (${CONTRACT}).` };
  }
  return { ok: true, code: null, version, hasTransactionState, reason: null };
}

/** Throw `NODE_UNSUPPORTED` / `SQLITE_REQUIRED` with a clear message, or return the support description. */
export function requireRuntime() {
  const support = runtimeSupport();
  if (support.ok) return support;
  const err = new Error(`${support.code}: ${support.reason} The data directory was not touched.`);
  err.code = support.code;
  err.support = support;
  throw err;
}
