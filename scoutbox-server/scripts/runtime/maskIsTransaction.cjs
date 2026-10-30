// SIMULATION of a Node.js release older than 22.16 / 24.0: hides
// `DatabaseSync.prototype.isTransaction` (added in those releases) from every
// importer of `node:sqlite`, CommonJS and ESM alike, while leaving every other
// statement working. Loaded with `node --require <this file> …` by
// scripts/testRuntime.mjs. It changes nothing in the package source and it is
// not a substitute for running the real older binary (the suite does that too
// when SCOUTBOX_TEST_NODE_BINS names one).
const sqlite = require('node:sqlite');
const Real = sqlite.DatabaseSync;
class DatabaseSync extends Real {
  constructor(...args) {
    super(...args);
    // The property is a non-configurable own accessor on the instance, so it
    // cannot be deleted; a proxy that answers `undefined` for it is the
    // closest faithful stand-in for "the getter does not exist".
    return new Proxy(this, {
      get(t, k) { if (k === 'isTransaction') return undefined; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; },
    });
  }
}
sqlite.DatabaseSync = DatabaseSync;
require('node:module').syncBuiltinESMExports();
