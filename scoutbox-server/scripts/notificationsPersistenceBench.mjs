// S7a persistence benchmark (synthetic, temporary database only; nothing touches
// DATA_DIR). Measures what one snapshot save writes as BLOBS when the server
// has N notifications, before and after S7a: run the same file from a pre-S7a
// checkout (copy it into that tree's scripts/ — it resolves ../store.mjs and
// ../repositories/index.mjs relative to itself) and from this tree, and compare.
// S7d: the same round appends the message through the channels repository when
// the tree has one (layer.channels), into the blob otherwise, and the report
// states the channels and ledger blob bytes per save — the ledger is still a blob,
// so the whole-database-write objective is still not met (narrowed again).
//
// It boots the data layer the way the server does (server-mode store, table
// migrations, attachDataLayer), seeds a few blob collections of realistic size
// plus N notifications (into the blob on a pre-S7a tree, through the repository
// here), then performs K "notify then save" rounds — the postMessage pattern
// (persistNow after every message) — and reports, per save: the bytes of blob
// JSON written (every blob row is rewritten by every save), the number of blob
// rows, the time, and whether the notifications collection is among them.
//
// What it does NOT claim: the whole-database write per save is gone. Every
// other blob collection is still rewritten on every save; S7a removes the
// notifications blob from that set and nothing else.
//
// Usage: node scripts/notificationsPersistenceBench.mjs [N=3000] [K=100] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const json = args.includes('--json');
const [N = 3000, K = 100] = args.filter((a) => !a.startsWith('--')).map(Number);
const build = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: HERE, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ntf-bench-'));
let counter = 1;
const nextId = (p) => `${p}-${counter++}`;
const T0 = Date.UTC(2026, 9, 11, 12);
const audience = (i) => ({ kind: i % 3 === 0 ? 'player' : i % 3 === 1 ? 'org_user' : 'guardian', id: `id-${i % 50}` });
const legacyRow = (i) => ({ id: nextId('ntf'), ts: T0 - (N - i) * 60_000, audience: audience(i), type: 'message', text: `Eastport FC (Head of Recruitment) sent a message. #${i}`, refId: `chan-${i % 40}`, read: i % 4 === 0, repeatCount: 1, groupKey: `message:chan-${i % 40}`, category: 'messages', deferredPush: false });

// 1. The file: blob collections of realistic size, plus the notifications in the pre-S7a shape (the migration imports them on an S7a tree).
{
  const tool = openStore(dir);
  const db = {
    // One organisation the threads can reference (S7d: the channels import checks the org_id against the orgs table; the request against the requests blob).
    players: [], guardians: [], orgs: [{ id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', squad: [] }], users: [], sessions: [],
    requests: Array.from({ length: 400 }, (_, i) => ({ id: `req-${i}`, playerId: `pl-${i % 50}`, orgId: 'org-pro', status: 'pending', type: 'contact', message: 'Hello there, we would like to talk about next season.', createdAt: T0 - i, history: [] })),
    ledger: Array.from({ length: 2000 }, (_, i) => ({ id: `led-${i}`, ts: T0 - i, type: 'view', playerId: `pl-${i % 50}`, orgId: 'org-pro', orgName: 'Eastport FC', userId: `usr-${i % 20}`, scoutName: 'Maria Keane' })),
    channels: Array.from({ length: 60 }, (_, i) => ({ id: `chan-${i}`, requestId: `req-${i}`, playerId: `pl-${i % 50}`, playerName: 'Player', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T0, messages: Array.from({ length: 25 }, (_, j) => ({ id: `msg-${i}-${j}`, ts: T0 + j, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria' }, text: `Message ${j} in thread ${i}: a sentence of ordinary length.`, attachment: null })), readBy: { org: null, counterparty: null } })),
    notifications: Array.from({ length: N }, (_, i) => legacyRow(i)),
  };
  tool.save({ savedAt: T0, idCounter: counter, db });
  tool.sqlite.close();
}

// 2. The server's view of it.
const store = openStore(dir, { tableBacked: TABLE_BACKED });
const db = store.load().db;
const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: 30 * 86_400_000, log: () => {}, warn: () => {} });
const repo = layer.notifications ?? null; // null on a pre-S7a tree
const threads = layer.channels ?? null; // null on a pre-S7d tree
const snapshot = () => ({ savedAt: Date.now(), idCounter: counter, db });
const blobStats = () => store.sqlite.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(length(value)), 0) AS bytes FROM collections').get();
const hasBlob = (name) => !!store.sqlite.prepare('SELECT 1 FROM collections WHERE name = ?').get(name);
const blobBytes = (name) => store.sqlite.prepare('SELECT COALESCE(length(value), 0) AS n FROM collections WHERE name = ?').get(name)?.n ?? 0;
const hasNotificationsBlob = () => hasBlob('notifications');
const notificationsBlobBytes = () => blobBytes('notifications');

// 3. K rounds of "a message lands, its notification is created, the snapshot is saved now".
const times = [];
for (let k = 0; k < K; k++) {
  const i = N + k;
  const thread = db.channels[i % db.channels.length];
  const msg = { id: nextId('msg'), ts: Date.now(), sender: { kind: 'org_user', id: 'usr-1', name: 'Maria' }, text: `Round ${k}.`, attachment: null };
  if (threads) threads.appendMessage(thread.id, msg); // S7d: the message row, staged into this round's save
  else thread.messages.push(msg);
  if (repo) repo.create({ audience: audience(i), type: 'message', text: `Eastport FC (Head of Recruitment) sent a message. #${i}`, refId: `chan-${i % 40}`, category: 'messages', deferredPush: false });
  else db.notifications.push({ ...legacyRow(i), ts: Date.now() });
  const t = process.hrtime.bigint();
  store.save(snapshot());
  times.push(Number(process.hrtime.bigint() - t) / 1e6);
}
times.sort((a, b) => a - b);
const stats = blobStats();
const result = {
  build, N, K, engine: threads ? 's7d: notifications and channels table-backed (staged repositories)' : repo ? 's7a: notifications table-backed (staged repository)' : 'pre-s7a: notifications blob',
  perSave: { blobRows: stats.rows, blobBytes: stats.bytes, notificationsBlobBytes: notificationsBlobBytes(), notificationsBlobRewritten: hasNotificationsBlob(), channelsBlobBytes: blobBytes('channels'), channelsBlobRewritten: hasBlob('channels'), ledgerBlobBytes: blobBytes('ledger'), ledgerBlobRewritten: hasBlob('ledger'), ms: { mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2), p50: +times[Math.floor(times.length * 0.5)].toFixed(2), p95: +times[Math.floor(times.length * 0.95)].toFixed(2), max: +times[times.length - 1].toFixed(2) } },
  notificationRows: repo ? repo.count() : db.notifications.length,
  threadRows: threads ? threads.counts() : { channels: db.channels.length, messages: db.channels.reduce((n, c) => n + c.messages.length, 0) },
  note: threads
    ? 'Every remaining blob collection is still rewritten by every save (the ledger among them); S7a removed the notifications blob from that set, S7d removes the channels blob and nothing else. This does not meet the whole-database-write objective; it narrows it again.'
    : 'Every blob collection is still rewritten by every save; S7a removes the notifications collection from that set and nothing else. This does not meet the whole-database-write objective; it narrows it.',
};
store.sqlite.close();
fs.rmSync(dir, { recursive: true, force: true });
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`build ${build} — ${result.engine}: ${N} notifications, ${K} notify+save rounds`);
  console.log(`per save: ${stats.rows} blob rows, ${stats.bytes} blob bytes (notifications blob: ${result.perSave.notificationsBlobBytes} bytes, rewritten: ${result.perSave.notificationsBlobRewritten}; channels blob: ${result.perSave.channelsBlobBytes} bytes, rewritten: ${result.perSave.channelsBlobRewritten}; ledger blob: ${result.perSave.ledgerBlobBytes} bytes, rewritten: ${result.perSave.ledgerBlobRewritten}); mean ${result.perSave.ms.mean} ms, p50 ${result.perSave.ms.p50} ms, p95 ${result.perSave.ms.p95} ms, max ${result.perSave.ms.max} ms`);
  console.log(result.note);
}
