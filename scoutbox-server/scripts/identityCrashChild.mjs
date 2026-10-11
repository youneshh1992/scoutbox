// Child process for scripts/testIdentityRepositories.mjs: opens the store on
// <dir> (the parent prepared the live identity schema and markers on it),
// attaches the identity repositories as a unit-of-work participant, starts a
// unit that inserts a guardian and its child, edits a facet and a blob, then
// kills itself with SIGKILL BEFORE the commit. The parent reopens the database
// and expects the pre-operation state everywhere. Synthetic data only.
//   node scripts/identityCrashChild.mjs <data-dir>
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';
import { createIdentityRepositories } from '../repositories/identity.mjs';

const dir = process.argv[2];
const NOW = Date.UTC(2026, 9, 11, 12);
const store = openStore(dir, { tableBacked: [...TABLE_BACKED, 'players', 'guardians'] });
const loaded = store.load();
const db = { ...loaded.db };
attachDataLayer({ db, store, nextId: (p) => `${p}-crash`, persist: () => {}, sessionTtlMs: 30 * 86_400_000 });
const identity = createIdentityRepositories({ sqlite: store.sqlite, unit: store.unit, now: () => NOW });
identity.attach();
Object.defineProperty(db, 'players', { value: identity.players.view, writable: false, configurable: false, enumerable: true });
Object.defineProperty(db, 'guardians', { value: identity.guardians.view, writable: false, configurable: false, enumerable: true });
store.setSaveHook(identity.saveHook());
const snapshot = () => ({ savedAt: NOW, idCounter: loaded.idCounter, db });
store.unitOfWork(() => {
  identity.guardians.insert({ id: 'gd-crash', name: 'Crash Parent', email: 'crash@example.test', password: null, emailVerified: true, emailCode: null, idVerified: true, disclaimerAccepted: true, childIds: [] });
  identity.players.insert({ id: 'pl-crash', name: 'Crash Child', dob: '2014-01-01', country: 'GB', city: '', guardianId: 'gd-crash', stats: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } });
  db.players.find((p) => p.id === 'pl-adult').medical.records.push({ id: 'md-crash', type: 'x', title: 'y' });
  db.requests[0].status = 'crashing';
  if (store.sqlite.prepare("SELECT COUNT(*) AS n FROM guardian_children WHERE guardian_id = 'gd-crash'").get().n !== 1) throw new Error('fixture: the link should be visible inside the transaction');
  process.stdout.write('ABOUT_TO_CRASH\n');
  process.kill(process.pid, 'SIGKILL');
}, { snapshot });
