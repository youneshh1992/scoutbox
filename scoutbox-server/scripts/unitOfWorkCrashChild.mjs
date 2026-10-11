// Child process for scripts/testUnitOfWork.mjs: boots a store on <dir> (already
// cut over by the parent), starts a unit of work that writes a row, a facet and a
// blob, then kills itself with SIGKILL BEFORE the commit. The parent reopens the
// database and expects the pre-operation state everywhere. Synthetic data only.
//   node scripts/unitOfWorkCrashChild.mjs <data-dir>
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';

const dir = process.argv[2];
const store = openStore(dir, { tableBacked: TABLE_BACKED });
const loaded = store.load();
const db = { ...loaded.db };
const layer = attachDataLayer({ db, store, nextId: (p) => `${p}-crash`, persist: () => {}, sessionTtlMs: 30 * 86_400_000 });
const snapshot = () => ({ savedAt: Date.now(), idCounter: loaded.idCounter, db });
store.unitOfWork(() => {
  layer.orgs.insert({ id: 'org-crash', name: 'Crash FC', type: 'club', plan: 'Pro' });
  db.orgs.find((o) => o.id === 'org-pro').squad.push({ id: 'sq-crash', name: 'Crash', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
  db.requests[0].status = 'accepted';
  db.requests.push({ id: 'req-crash', playerId: 'pl-1', status: 'pending', history: [] });
  // The row statements have run inside the open transaction; nothing is committed.
  if (store.sqlite.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-crash'").get().n !== 1) throw new Error('fixture: the row should be visible inside the transaction');
  process.stdout.write('ABOUT_TO_CRASH\n');
  process.kill(process.pid, 'SIGKILL');
}, { snapshot });
