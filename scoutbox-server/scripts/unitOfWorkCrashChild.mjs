// Child process for scripts/testUnitOfWork.mjs: boots a store on <dir> (already
// set up by the parent), starts a unit of work that writes organisation rows and a player,
// then kills itself with SIGKILL BEFORE the commit. The parent reopens the
// database and expects the pre-operation state everywhere. Synthetic data only.
//   node scripts/unitOfWorkCrashChild.mjs <data-dir>
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';

const dir = process.argv[2];
const store = openStore(dir);
const db = {};
const layer = attachDataLayer({ db, store, nextId: (p) => `${p}-crash`, persist: () => {}, sessionTtlMs: 30 * 86_400_000 });
store.unitOfWork(() => {
  layer.orgs.create({ id: 'org-crash', name: 'Crash FC', type: 'club', plan: 'Pro' });
  layer.players.setFootballCategory('pl-1', 'Crash');
  layer.orgs.update('org-pro', (d) => { d.suspended = true; });
  // The row statements have run inside the open transaction; nothing is committed.
  if (store.sqlite.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-crash'").get().n !== 1) throw new Error('fixture: the row should be visible inside the transaction');
  process.stdout.write('ABOUT_TO_CRASH\n');
  process.kill(process.pid, 'SIGKILL');
});
