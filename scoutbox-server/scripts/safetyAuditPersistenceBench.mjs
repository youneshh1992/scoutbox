// S6b persistence benchmark (synthetic, temporary database only; nothing touches
// DATA_DIR). Measures what one snapshot save writes as BLOBS when the server
// holds a realistic amount of audit data, before and after S6b: run the same file
// from the accepted pre-S6b checkout (copy it into that tree's scripts/ — it
// resolves ../store.mjs and ../repositories/index.mjs relative to itself) and
// from this tree, with the SAME fixture sizes, and compare the two reports.
//
// The fixture: one organisation, 400 requests, 60 threads of 25 messages, N ledger
// rows and a proportional number of blocks, reports, moderation hits, notes, ops
// events, source changes and IDV entries (the eight audit collections, in their
// writers' literals), plus 500 notifications — every collection in the pre-S6b
// blob shape (0013 imports the eight on this tree; 0009/0012 import the others on
// both). Then K rounds of the postMessage pattern: a message is appended (through
// the channels repository), a notification created, a ledger row appended (the
// `message` ledger row postMessage writes — through the repository on this tree,
// into the array before), and the snapshot is saved now.
//
// Reported per save: the number of `collections` rows upserted and their total
// bytes (every remaining blob row is rewritten by every save — the store has no
// dirty tracking, and this benchmark does not add any), the eight audit blobs'
// rows and bytes among them (zero after S6b), and the save time (mean, median,
// p95, max). What it does NOT claim: the whole-database write per save is gone.
// Every remaining blob collection (requests among them) is still serialised and
// UPSERTed by every save; S6b removes the eight audit blobs from that set and
// nothing else (plan §D.4, "what a send mutates versus what its save persists").
//
// Usage: node scripts/safetyAuditPersistenceBench.mjs [N=5000] [K=100] [--json]
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
const [N = 5000, K = 100] = args.filter((a) => !a.startsWith('--')).map(Number);
const build = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: HERE, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s6b-bench-'));
let counter = 1;
const nextId = (p) => `${p}-${counter++}`;
const T0 = Date.UTC(2026, 9, 19, 12);
const AUDIT = ['blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue'];
const audience = (i) => ({ kind: i % 3 === 0 ? 'player' : i % 3 === 1 ? 'org_user' : 'guardian', id: `id-${i % 50}` });

// 1. The file: every collection in the pre-S6b blob shape, deterministic sizes derived from N.
{
  const tool = openStore(dir);
  // Identity rows in the shape the S4a preflight accepts (id, name, dob, country / id, name, email): the 50 adults the audit rows name, the 20 guardians the IDV entries name (Domain G is strict).
  const players = Array.from({ length: 50 }, (_, i) => ({ id: `pl-${i}`, name: `Player ${i}`, dob: '2004-01-01', country: 'GB', createdAt: T0 - i }));
  const guardians = Array.from({ length: 20 }, (_, i) => ({ id: `gd-${i}`, name: `Parent ${i}`, email: `parent${i}@example.test`, createdAt: T0 - i, childIds: [] }));
  const db = {
    players, guardians,
    orgs: [{ id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', squad: [] }], users: [], sessions: [],
    requests: Array.from({ length: 400 }, (_, i) => ({ id: `req-${i}`, playerId: `pl-${i % 50}`, orgId: 'org-pro', status: 'pending', type: 'contact', message: 'Hello there, we would like to talk about next season.', createdAt: T0 - i, history: [] })),
    channels: Array.from({ length: 60 }, (_, i) => ({ id: `chan-${i}`, requestId: `req-${i}`, playerId: `pl-${i % 50}`, playerName: 'Player', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T0, messages: Array.from({ length: 25 }, (_, j) => ({ id: `msg-${i}-${j}`, ts: T0 + j, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria' }, text: `Message ${j} in thread ${i}: a sentence of ordinary length.`, attachment: null })), readBy: { org: null, counterparty: null } })),
    notifications: Array.from({ length: 500 }, (_, i) => ({ id: nextId('ntf'), ts: T0 - (500 - i) * 60_000, audience: audience(i), type: 'message', text: `Eastport FC (Head of Recruitment) sent a message. #${i}`, refId: `chan-${i % 40}`, read: i % 4 === 0, repeatCount: 1, groupKey: `message:chan-${i % 40}`, category: 'messages', deferredPush: false })),
    // The eight audit collections, in their writers' literals (fixture ids carry '-fixture-' so the rounds' nextId() ids never collide: the repository refuses a duplicate id, the array never did).
    ledger: Array.from({ length: N }, (_, i) => ({ id: `led-fixture-${i}`, ts: T0 - (N - i), type: ['view', 'save', 'shortlist', 'message', 'contact_request'][i % 5], playerId: `pl-${i % 50}`, orgId: 'org-pro', orgName: 'Eastport FC', userId: `usr-${i % 20}`, scoutName: 'Maria Keane' })),
    blocks: Array.from({ length: Math.ceil(N / 100) }, (_, i) => ({ id: `blk-fixture-${i}`, playerId: `pl-${i % 50}`, orgId: 'org-pro', by: i % 2 ? 'guardian' : 'player', reason: 'synthetic', ts: T0 - i })),
    reports: Array.from({ length: Math.ceil(N / 50) }, (_, i) => ({ id: `rep-fixture-${i}`, ts: T0 - i, by: 'player', byId: `pl-${i % 50}`, targetKind: 'club', targetOrgId: 'org-pro', targetScoutName: null, targetPlayerId: null, reason: 'Synthetic report text of ordinary length for the benchmark.', urgent: false, status: i % 3 ? 'resolved' : 'pending_review', outcome: i % 3 ? 'Reviewed.' : null, resolvedAt: i % 3 ? T0 : null })),
    moderationLog: Array.from({ length: Math.ceil(N / 50) }, (_, i) => ({ id: `mod-fixture-${i}`, ts: T0 - i, context: { kind: 'org_message', orgId: 'org-pro', userId: `usr-${i % 20}`, channelId: `chan-${i % 60}` }, flags: ['phone_number'], severity: 'contact', excerpt: 'synthetic excerpt of a blocked message' })),
    orgNotes: Array.from({ length: Math.ceil(N / 20) }, (_, i) => ({ id: `note-fixture-${i}`, orgId: 'org-pro', playerId: `pl-${i % 50}`, userId: `usr-${i % 20}`, scoutName: 'Maria Keane', text: 'A private scouting note of ordinary length about the player.', ts: T0 - i })),
    opsEvents: Array.from({ length: Math.ceil(N / 100) }, (_, i) => ({ id: `ops-fixture-${i}`, at: T0 - i, kind: 'backup_created', detail: { dir: `2026-10-19T00-00-${String(i % 60).padStart(2, '0')}Z`, files: 4, queuedForRemoval: 0 } })),
    sourceChanges: Array.from({ length: Math.ceil(N / 20) }, (_, i) => ({ id: `srcc-fixture-${i}`, playerId: `pl-${i % 50}`, type: 'position_changed', sourceSystem: 'passport_prefs', sourceId: `pl-${i % 50}`, occurredAt: T0 - i, detail: { from: 'CM', to: 'CAM' } })),
    idvQueue: Array.from({ length: 20 }, (_, i) => ({ id: `idv-fixture-${i}`, guardianId: `gd-${i}`, guardianName: `Parent ${i}`, documentType: 'passport', documentRef: '4567', provider: 'dev-attestation', reference: `idv_${String(i).padStart(16, '0')}`, ts: T0 - i, status: 'approved' })),
  };
  tool.save({ savedAt: T0, idCounter: counter, db });
  tool.sqlite.close();
}

// 2. The server's view of it (table migrations, repositories, views).
const store = openStore(dir, { tableBacked: TABLE_BACKED });
const db = store.load().db;
const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: 30 * 86_400_000, log: () => {}, warn: () => {} });
const repo = layer.notifications ?? null;
const threads = layer.channels ?? null;
const audit = layer.safetyAudit ?? null; // null on a pre-S6b tree
const snapshot = () => ({ savedAt: Date.now(), idCounter: counter, db });
const blobStats = () => store.sqlite.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(length(value)), 0) AS bytes FROM collections').get();
const auditBlobStats = () => store.sqlite.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(length(value)), 0) AS bytes FROM collections WHERE name IN (${AUDIT.map(() => '?').join(', ')})`).get(...AUDIT);
const blobNames = () => store.sqlite.prepare('SELECT name FROM collections ORDER BY name').all().map((r) => r.name);

// 3. K rounds of the postMessage pattern: message, notification, ledger row, save now.
const times = [];
for (let k = 0; k < K; k++) {
  const i = 500 + k;
  const thread = db.channels[i % db.channels.length];
  const msg = { id: nextId('msg'), ts: Date.now(), sender: { kind: 'org_user', id: 'usr-1', name: 'Maria' }, text: `Round ${k}.`, attachment: null };
  if (threads) threads.appendMessage(thread.id, msg); else thread.messages.push(msg);
  if (repo) repo.create({ audience: audience(i), type: 'message', text: `Eastport FC (Head of Recruitment) sent a message. #${i}`, refId: thread.id, category: 'messages', deferredPush: false });
  else db.notifications.push({ id: nextId('ntf'), ts: Date.now(), audience: audience(i), type: 'message', text: `#${i}`, refId: thread.id, read: false, repeatCount: 1, groupKey: `message:${thread.id}`, category: 'messages', deferredPush: false });
  const row = { id: nextId('led'), ts: Date.now(), type: 'message', playerId: thread.playerId, orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria' };
  if (audit) audit.ledger.append(row); else db.ledger.push(row);
  const t = process.hrtime.bigint();
  store.save(snapshot());
  times.push(Number(process.hrtime.bigint() - t) / 1e6);
}
const sorted = times.slice().sort((a, b) => a - b);
const stats = blobStats(); const auditStats = auditBlobStats();
const result = {
  build, N, K,
  engine: audit ? 's6b: the eight audit collections table-backed (staged repository); notifications and channels table-backed' : threads ? 'pre-s6b (s7d): notifications and channels table-backed; the eight audit collections are blobs' : 'older',
  fixture: { ledgerRows: N, blocks: Math.ceil(N / 100), reports: Math.ceil(N / 50), moderationLog: Math.ceil(N / 50), orgNotes: Math.ceil(N / 20), opsEvents: Math.ceil(N / 100), sourceChanges: Math.ceil(N / 20), idvQueue: 20, requests: 400, threads: 60, messagesPerThread: 25, notifications: 500 },
  perSave: {
    blobRowsUpserted: stats.rows, blobBytesSerialised: stats.bytes,
    auditBlobRowsUpserted: auditStats.rows, auditBlobBytesSerialised: auditStats.bytes,
    remainingBlobCollections: blobNames(),
    ms: { mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2), median: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) },
  },
  ledgerRowsNow: audit ? audit.counts().ledger : db.ledger.length,
  note: audit
    ? 'Every remaining blob collection (requests, players-adjacent containers, module collections) is still serialised and UPSERTed by every save — no dirty tracking exists or was added. S6b removes the eight audit blobs from that set and nothing else; the whole-database-write objective is still not met (plan §D.4).'
    : 'Every blob collection, the eight audit collections included, is serialised and UPSERTed by every save.',
};
store.sqlite.close();
fs.rmSync(dir, { recursive: true, force: true });
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`build ${build} — ${result.engine}: ${N} ledger rows (+ the proportional audit fixture), ${K} message+notification+ledger+save rounds`);
  console.log(`per save: ${stats.rows} blob rows upserted, ${stats.bytes} blob bytes serialised (of which the eight audit blobs: ${auditStats.rows} rows, ${auditStats.bytes} bytes); remaining blob collections: ${result.perSave.remainingBlobCollections.length}; mean ${result.perSave.ms.mean} ms, median ${result.perSave.ms.median} ms, p95 ${result.perSave.ms.p95} ms, max ${result.perSave.ms.max} ms`);
  console.log(result.note);
}
