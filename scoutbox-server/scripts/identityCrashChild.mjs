// Child process for scripts/testIdentityRepositories.mjs: opens the store on
// <dir> (a database the parent initialised through the data layer), attaches
// the data layer (the identity repositories are its unit-of-work participant), starts a
// unit that inserts a guardian and its child, edits a facet and a blob, then
// kills itself with SIGKILL BEFORE the commit. The parent reopens the database
// and expects the pre-operation state everywhere. Synthetic data only.
//   node scripts/identityCrashChild.mjs <data-dir>
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';

const dir = process.argv[2];
const NOW = Date.UTC(2026, 9, 11, 12);
const store = openStore(dir, { tableBacked: TABLE_BACKED });
const loaded = store.load();
const db = { ...loaded.db };
const { identity } = attachDataLayer({ db, store, nextId: (p) => `${p}-crash`, persist: () => {}, sessionTtlMs: 30 * 86_400_000, now: () => NOW });
const snapshot = () => ({ savedAt: NOW, idCounter: loaded.idCounter, db });
store.unitOfWork(() => {
  identity.guardians.insert({ id: 'gd-crash', name: 'Crash Parent', email: 'crash@example.test', password: null, emailVerified: true, emailCode: null, idVerified: true, disclaimerAccepted: true, childIds: [] });
  identity.players.insert({ id: 'pl-crash', name: 'Crash Child', dob: '2014-01-01', country: 'GB', city: '', guardianId: 'gd-crash', stats: null, medical: { shared: false, records: [], conditionStatus: 'unknown' } });
  identity.players.addItem('pl-adult', 'medical.records', { id: 'md-crash', type: 'x', title: 'y' }); // S5: a row of player_medical_records, inside the unit
  db.requests[0].status = 'crashing';
  if (store.sqlite.prepare("SELECT COUNT(*) AS n FROM guardian_children WHERE guardian_id = 'gd-crash'").get().n !== 1) throw new Error('fixture: the link should be visible inside the transaction');
  process.stdout.write('ABOUT_TO_CRASH\n');
  process.kill(process.pid, 'SIGKILL');
}, { snapshot });
