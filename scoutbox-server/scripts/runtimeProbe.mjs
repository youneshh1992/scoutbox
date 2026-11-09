// Runtime probe: opens a store on <dir>, boots the data layer with one
// organisation, saves, writes it in a unit that fails, retries, and
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
  const db = {};
  const seed = { orgs: [{ id: 'org-1', name: 'One FC', type: 'club', level: 'grassroots', plan: 'Grassroots' }], guardians: [], players: [{ id: 'pl-1', name: 'P', dob: '2001-01-01', country: 'GB' }] };
  const layer = attachDataLayer({ db, seed, store, nextId, persist: () => {}, sessionTtlMs: 30 * 86_400_000 });
  // A unit of work that fails after its write rolls the write back; the retry commits it. (Rewritten in S14a, where
  // the failure was an unserialisable blob, and S14g, where it was a failing save after an organisation facet edit.)
  try { store.unitOfWork(() => { layer.orgs.update('org-1', (d) => { d.suspended = true; }); throw new Error('injected failure after the write'); }); out.steps.push('failed-save-did-not-throw'); } catch (err) { out.steps.push(`failed-save-threw: ${String(err.message).slice(0, 60)}`); }
  out.rolledBack = store.sqlite.prepare("SELECT suspended FROM orgs WHERE id = 'org-1'").get().suspended === 0;
  store.unitOfWork(() => layer.orgs.update('org-1', (d) => { d.suspended = true; }));
  out.steps.push('retried');
  out.squadRows = store.sqlite.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'org-1' AND suspended = 1").get().n;
  store.sqlite.close();
  out.ok = out.rolledBack === true && out.squadRows === 1 && out.steps.some((s) => s.startsWith('failed-save-threw'));
} catch (err) {
  out.error = { code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 400) };
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : out.error?.code === 'NODE_UNSUPPORTED' ? 3 : 1);
