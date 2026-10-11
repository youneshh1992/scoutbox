// Runtime probe: opens a store on <dir>, boots the data layer with one
// organisation, saves, changes a facet, injects a save failure, retries, and
// prints one JSON line with what happened. scripts/testRuntime.mjs runs it on
// the current runtime, on a masked (simulated older) runtime and on any real
// extra Node.js binaries. Exit 0 when every step worked, 3 when the runtime was
// refused as unsupported before the directory was touched, 1 otherwise.
//   node scripts/runtimeProbe.mjs <data-dir>
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/runtimeProbe.mjs <data-dir>'); process.exit(1); }
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const out = { node: process.version, steps: [], ok: false };
try {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  out.steps.push('opened');
  const db = { orgs: [{ id: 'org-1', name: 'One FC', type: 'club', level: 'grassroots', plan: 'Grassroots', squad: [] }], guardians: [], players: [{ id: 'pl-1', name: 'P', dob: '2001-01-01', country: 'GB' }], sessions: [], users: [] };
  attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: 30 * 86_400_000 });
  store.save({ savedAt: 1, idCounter: 1000, db });
  out.steps.push('saved');
  db.orgs[0].squad.push({ id: 'sq-1', name: 'Kid', position: 'ST', playerId: null, source: 'manual', addedAt: 1 });
  db.players[0].big = 1n; // JSON cannot serialise a BigInt: the save fails after the facets were flushed
  try { store.save({ savedAt: 2, idCounter: 1000, db }); out.steps.push('failed-save-did-not-throw'); } catch (err) { out.steps.push(`failed-save-threw: ${String(err.message).slice(0, 60)}`); }
  out.rolledBack = JSON.parse(store.sqlite.prepare("SELECT facets_json FROM orgs WHERE id = 'org-1'").get().facets_json).squad.length === 0;
  delete db.players[0].big;
  store.save({ savedAt: 3, idCounter: 1000, db });
  out.steps.push('retried');
  out.squadRows = JSON.parse(store.sqlite.prepare("SELECT facets_json FROM orgs WHERE id = 'org-1'").get().facets_json).squad.length;
  store.sqlite.close();
  out.ok = out.rolledBack === true && out.squadRows === 1 && out.steps.some((s) => s.startsWith('failed-save-threw'));
} catch (err) {
  out.error = { code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 400) };
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : out.error?.code === 'NODE_UNSUPPORTED' ? 3 : 1);
