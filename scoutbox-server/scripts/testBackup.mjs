// The admin backup through the REAL server (server.mjs booted as a child process
// on temporary data directories, synthetic records only): a backup is a copy of
// the database (scoutbox.db, VACUUM INTO) next to media/ and manifest.json. The
// copy matches the source table for table; the manifest's checksums match the
// files and nothing in the backup is a secret or a plain token; a restore into a
// NEW directory brings everything back, sessions and media included; a file whose
// removal is queued is left out and the restored server finishes the removal; a
// corrupt database stops the boot and is never replaced by a seed. And the store
// itself refuses a copy inside an open transaction or over an existing file.
// Nothing here touches DATA_DIR or any real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-backup-${tag}-`));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
// Synthetic, distinctive secrets: the backup must contain neither.
const ADMIN_KEY = `synthetic-admin-${crypto.randomBytes(8).toString('hex')}`;
const MEDIA_SECRET = `synthetic-media-secret-${crypto.randomBytes(16).toString('hex')}`;
const A = { 'x-admin-key': ADMIN_KEY };

async function boot(dir, env = {}) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', ADMIN_KEY, MEDIA_SECRET, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
   
    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    const S = { proc, port, dir, log: () => log, j, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
async function bootRefuses(dir) {
  try { const S = await boot(dir); await S.kill(); throw new Error(`the server booted but must have refused: ${S.log().slice(-600)}`); }
  catch (err) { if (typeof err.code !== 'number') throw err; return { code: err.code, log: err.log }; }
}
/** A read-only second connection on a database file. */
function withDb(file, fn) { const s = new DatabaseSync(file, { readOnly: true }); try { return fn(s); } finally { s.close(); } }
const q1 = (dir, sql, ...p) => withDb(path.join(dir, 'scoutbox.db'), (s) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every table of a database file: its DDL and its rows, in rowid order (key order for a WITHOUT ROWID table). */
function dumpTables(file) {
  return withDb(file, (s) => {
    const tables = s.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => ({ ...r }));
    const out = {};
    for (const { name, sql } of tables) {
      const q = `"${name.replace(/"/g, '""')}"`;
      const withoutRowid = /WITHOUT\s+ROWID/i.test(sql ?? '');
      const cols = s.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${name.replace(/'/g, "''")}')`).get().n;
      const order = withoutRowid ? Array.from({ length: cols }, (_, i) => i + 1).join(', ') : 'rowid';
      out[name] = { sql, rows: s.prepare(`SELECT * FROM ${q} ORDER BY ${order}`).all().map((r) => ({ ...r })) };
    }
    return out;
  });
}

const orgLogin = async (S, orgId, scoutName, role) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
async function signupWithClip(S, dir, name) {
  const r = await S.j('POST', '/auth/player/signup', { name, dob: '2001-01-01', country: 'GB', password: 'backup-pass-1' }); assert.equal(r.status, 201, r.text);
  const m = await S.j('POST', '/player/media', { title: 'Clip', kind: 'video', dataUrl: 'data:video/webm;base64,AAAAAAAA' }, r.body.token); assert.equal(m.status, 201, m.text);
  return { id: r.body.playerId, token: r.body.token, mediaId: m.body.media.id, file: path.join(dir, 'media', `${m.body.media.id}.webm`) };
}

/**
 * A source directory with real activity across several domains, a pending media
 * removal and one backup taken through the route; the server stopped right after
 * the backup. Shared by the cases below.
 */
async function sourceWithBackup() {
  const dir = tempDir('source'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  // A message thread (requests, channels, messages, notifications).
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'We would like to talk about next season.' }, maria); assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status, 200);
  const channels = await S.j('GET', '/player/channels', undefined, kola); const channelId = channels.body[0]?.id; assert.ok(channelId, channels.text);
  assert.equal((await S.j('POST', `/org/channels/${channelId}/messages`, { text: 'A synthetic message to back up.' }, maria)).status, 201);
  // A notification preference.
  assert.equal((await S.j('PUT', '/org/notification-preferences', { categories: { mentions: false }, emailIntent: true }, maria)).status, 200);
  // Media: one live clip, and one whose owner was deleted while the file could not be removed (a directory in its place), then put back.
  const live = await signupWithClip(S, dir, 'Still Here'); const gone = await signupWithClip(S, dir, 'Removed Owner');
  fs.rmSync(gone.file); fs.mkdirSync(gone.file);
  assert.equal((await S.j('DELETE', '/player/account', undefined, gone.token)).status, 200);
  fs.rmdirSync(gone.file); fs.writeFileSync(gone.file, 'synthetic media of a removed owner');
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM media_deletions WHERE media_id = ?', gone.mediaId).n, 1, 'the removal is queued and the file is on disk');
  const feed = (await S.j('GET', '/player/notifications', undefined, kola)).body.map((n) => n.id);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const verify = await S.j('POST', '/admin/backup/verify', { dir: path.basename(bk.body.dir) }, null, A);
  await S.stop();
  return { dir, backup: bk.body.dir, manifest: bk.body.manifest, verify: verify.body, maria, kola, live, gone, channelId, feed };
}

const src = await sourceWithBackup();

// ------------------------------------------------------------- the backup's contents
await test('format: the backup holds scoutbox.db, media/ and manifest.json and nothing else; the manifest is backup.2026-11.v2, lists scoutbox.db first and every file with its real sha256 and size (verify agrees); the copy is a standalone database (no -wal/-shm beside it, integrity ok); no secret and no plain session token appears in any file', async () => {
  const entries = fs.readdirSync(src.backup).sort();
  assert.deepEqual(entries, ['manifest.json', 'media', 'scoutbox.db'], `the backup directory: ${entries}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(src.backup, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, src.manifest, 'the route answered the manifest it wrote');
  assert.equal(manifest.contract, 'backup.2026-11.v2');
  assert.equal(manifest.files[0].path, 'scoutbox.db');
  const onDisk = ['scoutbox.db', ...fs.readdirSync(path.join(src.backup, 'media')).map((f) => `media/${f}`)].sort();
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), onDisk, 'the manifest lists exactly the files the backup holds');
  for (const f of manifest.files) {
    const file = path.join(src.backup, f.path);
    assert.equal(f.sha256, sha256(file), `${f.path}: checksum`); assert.equal(f.bytes, fs.statSync(file).size, `${f.path}: size`);
  }
  assert.equal(src.verify.ok, true, JSON.stringify(src.verify));
  assert.equal(manifest.counts.mediaFiles, manifest.files.length - 1);
  withDb(path.join(src.backup, 'scoutbox.db'), (s) => assert.equal(s.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'));
  const all = [path.join(src.backup, 'manifest.json'), ...manifest.files.map((f) => path.join(src.backup, f.path))].map((f) => fs.readFileSync(f));
  for (const needle of [ADMIN_KEY, MEDIA_SECRET, src.maria, src.kola, src.live.token]) {
    assert.ok(all.every((buf) => !buf.includes(needle)), `the backup carries no secret or plain token (${needle.slice(0, 12)}…)`);
  }
});

await test('copy: every table of the source database is in the copy with the same DDL and the same rows in the same order (data_migrations, meta, counters and every domain table) — the only difference is what the server wrote AFTER the copy: the backup_created ops event and the one id it took', async () => {
  const before = dumpTables(path.join(src.dir, 'scoutbox.db'));
  const copy = dumpTables(path.join(src.backup, 'scoutbox.db'));
  assert.deepEqual(Object.keys(copy), Object.keys(before), 'the same tables');
  // Rewritten in S14a: the blob rows in `collections` and the save counters in `meta` are gone; the id counter is a `counters` row.
  assert.equal('collections' in before, false, 'there is no blob table');
  for (const name of ['data_migrations', 'meta', 'counters', 'players', 'channels', 'messages', 'notifications', 'sessions', 'media_deletions']) {
    assert.ok(before[name]?.rows.length > 0, `${name} has rows in the source (the comparison is not over empty tables)`);
  }
  for (const name of Object.keys(before)) {
    assert.equal(copy[name].sql, before[name].sql, `${name}: the same DDL`);
    if (name === 'ops_events') {
      // The route records backup_created after the copy is written.
      const later = before[name].rows.slice(copy[name].rows.length);
      assert.deepEqual(before[name].rows.slice(0, copy[name].rows.length), copy[name].rows, 'ops_events: the copy is the source up to the copy');
      assert.deepEqual(later.map((r) => r.kind), ['backup_created'], 'ops_events: only the backup_created event came after');
      continue;
    }
    if (name === 'counters') {
      const strip = (rows) => rows.filter((r) => r.name !== 'id');
      assert.deepEqual(strip(copy[name].rows), strip(before[name].rows), 'counters: identical apart from the id counter');
      const counter = (rows) => Number(rows.find((r) => r.name === 'id').value);
      assert.equal(counter(before[name].rows) - counter(copy[name].rows), 1, 'counters: the id counter moved by exactly the one id the backup_created event took');
      continue;
    }
    assert.deepEqual(copy[name].rows, before[name].rows, `${name}: the same rows in the same order`);
  }
});

// ------------------------------------------------------------- restore
await test('restore: the backup copied into a NEW directory boots; the sessions minted before the backup still work (same hashes), the feed, the thread and the preference are back, the live clip is served to its owner — and the queued clip was left out of the backup, is never served, and the restored server cleared its queue entry at boot', async () => {
  assert.equal(fs.existsSync(path.join(src.backup, 'media', `${src.gone.mediaId}.webm`)), false, 'a queued file is never copied into a backup');
  assert.equal(fs.existsSync(path.join(src.backup, 'media', `${src.live.mediaId}.webm`)), true, 'a live clip is');
  assert.equal(src.manifest.media.queuedForRemoval, 1);
  assert.equal(q1(src.backup, 'SELECT COUNT(*) AS n FROM media_deletions WHERE media_id = ?', src.gone.mediaId).n, 1, 'the removal intent travels in the copied database');
  const restored = tempDir('restored'); fs.cpSync(src.backup, restored, { recursive: true });
  let S = await boot(restored);
  assert.deepEqual((await S.j('GET', '/player/notifications', undefined, src.kola)).body.map((n) => n.id), src.feed, 'the player feed is back (the session travelled)');
  const ch = await S.j('GET', '/org/channels', undefined, src.maria);
  assert.equal(ch.status, 200, ch.text); assert.ok(ch.body.items.some((c) => c.id === src.channelId), 'the thread is back');
  assert.ok(ch.text.includes('A synthetic message to back up.'), 'with its message');
  const prefs = await S.j('GET', '/org/notification-preferences', undefined, src.maria); assert.equal(prefs.status, 200, prefs.text);
  assert.equal(prefs.body.preferences.categories.find((c) => c.id === 'mentions').enabled, false, 'the preference is back');
  assert.equal((await S.j('GET', `/media/${src.live.mediaId}`, undefined, src.live.token)).status, 200, 'the live clip is served to its owner');
  assert.equal((await S.j('GET', `/media/${src.gone.mediaId}`, undefined, src.maria)).status === 200, false, 'the removed owner\'s clip is not served');
  assert.equal(q1(restored, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0, 'the restored server finished the removal at boot (the file is absent)');
  await S.stop();
  // A restart stays as it is.
  S = await boot(restored);
  assert.deepEqual((await S.j('GET', '/player/notifications', undefined, src.kola)).body.map((n) => n.id), src.feed);
  await S.stop();
  rm(restored);
});

await test('corrupt database: a restored directory whose scoutbox.db has a garbage header, or was cut short, stops the boot with a non-zero exit; the file is left exactly as it was (never replaced by a seed) and the next boot refuses again', async () => {
  const good = fs.readFileSync(path.join(src.backup, 'scoutbox.db'));
  const garbage = Buffer.from(good); garbage.fill(0x5a, 0, 100);
  const cut = good.subarray(0, Math.floor(good.length / 2));
  assert.ok(cut.length >= 4096, 'the cut file is more than one page');
  for (const [label, bytes] of [['garbage header', garbage], ['cut short', cut]]) {
    const dir = tempDir('corrupt'); fs.cpSync(src.backup, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scoutbox.db'), bytes);
    const digest = sha256(path.join(dir, 'scoutbox.db'));
    const r1 = await bootRefuses(dir); assert.notEqual(r1.code, 0, `${label}: non-zero exit`);
    assert.equal(/listening on/.test(r1.log), false, `${label}: nothing was served`);
    assert.equal(sha256(path.join(dir, 'scoutbox.db')), digest, `${label}: the file was not replaced or rewritten`);
    const r2 = await bootRefuses(dir); assert.notEqual(r2.code, 0, `${label}: refused again`);
    assert.equal(sha256(path.join(dir, 'scoutbox.db')), digest);
    rm(dir);
  }
});

await test('empty database: a restored directory whose scoutbox.db is 0 bytes stops the boot with DATABASE_EMPTY instead of starting from the seed; nothing is created beside it, the file stays empty, and the next boot refuses again (a missing file is still a first installation)', async () => {
  const dir = tempDir('empty'); fs.cpSync(src.backup, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scoutbox.db'), '');
  for (const attempt of ['first boot', 'next boot']) {
    const r = await bootRefuses(dir); assert.notEqual(r.code, 0, `${attempt}: non-zero exit`);
    assert.match(r.log, /DATABASE_EMPTY/, `${attempt}: the refusal names the cause`);
    assert.equal(/listening on|seeded/.test(r.log), false, `${attempt}: nothing was seeded or served`);
    assert.equal(fs.statSync(path.join(dir, 'scoutbox.db')).size, 0, `${attempt}: the file is untouched`);
    for (const side of ['scoutbox.db-wal', 'scoutbox.db-shm']) assert.equal(fs.existsSync(path.join(dir, side)), false, `${attempt}: no ${side} was created`);
  }
  rm(dir);
  const fresh = tempDir('fresh'); const S = await boot(fresh);
  assert.equal((await S.j('GET', '/orgs/directory')).status, 200, 'a directory with no scoutbox.db still boots as a first installation');
  await S.stop(); rm(fresh);
});

// ------------------------------------------------------------- the store's copy
await test('store.copyTo: refused while a transaction is open (its writes are not committed) and over an existing file (left untouched); outside a transaction it writes a standalone copy of what is committed', () => {
  const dir = tempDir('copyto'); const store = openStore(dir);
  try {
    const target = path.join(dir, 'copy.db');
    store.sqlite.exec("INSERT INTO meta (key, value) VALUES ('synthetic', 'committed')");
    store.sqlite.exec('BEGIN');
    store.sqlite.exec("UPDATE meta SET value = 'uncommitted' WHERE key = 'synthetic'");
    assert.throws(() => store.copyTo(target), /transaction is open/);
    assert.equal(fs.existsSync(target), false, 'no file was written');
    store.sqlite.exec('ROLLBACK');
    const existing = path.join(dir, 'existing.db'); fs.writeFileSync(existing, 'synthetic bytes');
    assert.throws(() => store.copyTo(existing), /already exists/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'synthetic bytes', 'the existing file is untouched');
    store.copyTo(target);
    assert.equal(withDb(target, (s) => s.prepare("SELECT value FROM meta WHERE key = 'synthetic'").get().value), 'committed');
    assert.equal(fs.existsSync(`${target}-wal`), false);
  } finally { store.sqlite.close(); rm(dir); }
});

rm(src.dir);
console.log(`\n${passed} backup test(s) passed`);
