// Message threads (S14c: the channels repository's explicit writes and SQL reads), against a real server on a
// temporary data directory with the synthetic seed.
//
//   A the organisation's inbox pages by cursor ({ items, nextCursor }), most recently active first; a new message
//     moves its thread to the top; `playerId` limits it to one player's threads; junk paging is refused with 400
//   B the inbox figures (/org/channels/counts): the threads, and the messages from players and guardians since the
//     club last opened each thread
//   C junk is refused at the route, never cut down: an over-long text, a retry id that is not text or is over 64
//     characters (400 FIELD_INVALID naming the field); nothing is stored
//   D a retried send with the same retry id answers the stored message; another sender may use the same id
//   E a message, its ledger row and its notification land together; the receipt routes answer the stored receipts
//   F responses are allowlists: the player and guardian views carry no organisation or guardian id, the club's
//     carries its own id, the admin audit both (and pages the same way)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../scripts/testPort.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-messaging-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };

let passed = 0; let negatives = 0;
let child = null;
function cleanup() { if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } fs.rmSync(DATA, { recursive: true, force: true }); }
process.on('exit', cleanup);
const ok = (cond, name) => { if (!cond) { console.error(`✗ ${name}`); cleanup(); process.exit(1); } passed++; console.log(`✓ ${name}`); };
const neg = (cond, name) => { negatives++; ok(cond, `[neg] ${name}`); };
const section = (name) => console.log(`\n— ${name} —`);
const j = async (method, pathname, body, token, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (route, body) => { const r = await j('POST', route, body); ok(r.status === 200, `login ${route} ${JSON.stringify(body)}`); return r.body.token; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child = spawn('node', ['server.mjs'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA }, stdio: 'ignore' });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* booting */ }
  if (i > 80) throw new Error('server did not boot');
  await sleep(250);
}

const maria = await login('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' });
const harbour = await login('/auth/org/login', { orgId: 'org-harbour', scoutName: 'Harbour Scout', role: 'Head of Recruitment' });
const kola = await login('/auth/player/login', { playerId: 'pl-adeyemi' });
const mateus = await login('/auth/player/login', { playerId: 'pl-carvalho' });
const amara = await login('/auth/guardian/login', { guardianId: 'gd-amara' });

/** A contact request accepted by its recipient: the thread it opened. */
async function thread(playerId, answerAs, answerRoute, listRoute) {
  const req = await j('POST', `/org/players/${playerId}/request`, { type: 'contact', message: 'Synthetic contact request.' }, maria);
  ok(req.status === 201, `a contact request to ${playerId}`);
  ok((await j('POST', `${answerRoute}/${req.body.requestId}/respond`, { accept: true }, answerAs)).status === 200, `the request to ${playerId} is accepted`);
  const t = (await j('GET', listRoute, undefined, answerAs)).body.find((c) => c.requestId === req.body.requestId);
  ok(!!t?.id, `the thread with ${playerId} is listed`);
  return t;
}
const adult = await thread('pl-adeyemi', kola, '/player/requests', '/player/channels');
await sleep(5);
const child_ = await thread('pl-guni', amara, '/guardian/requests', '/guardian/channels');
await sleep(5);
const other = await thread('pl-carvalho', mateus, '/player/requests', '/player/channels');
const inbox = async (q = '') => j('GET', `/org/channels${q}`, undefined, maria);

section('A — the organisation\'s inbox pages by cursor, most recently active first');
{
  const all = await inbox();
  ok(all.status === 200 && Array.isArray(all.body.items) && all.body.nextCursor === null, 'a page: { items, nextCursor }');
  ok(JSON.stringify(all.body.items.map((c) => c.id)) === JSON.stringify([other.id, child_.id, adult.id]), 'newest thread first while none has a message');
  await sleep(5);
  ok((await j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic reply from the player.' }, kola)).status === 201, 'the player replies');
  ok((await inbox()).body.items[0].id === adult.id, 'a new message moves its thread to the top');
  const p1 = await inbox('?limit=2');
  ok(p1.body.items.length === 2 && typeof p1.body.nextCursor === 'string', 'limit=2: two threads and a cursor');
  const p2 = await inbox(`?limit=2&cursor=${p1.body.nextCursor}`);
  ok(p2.body.items.length === 1 && p2.body.nextCursor === null, 'the cursor continues where the page ended');
  ok(new Set([...p1.body.items, ...p2.body.items].map((c) => c.id)).size === 3, 'no thread twice, none missed');
  ok(JSON.stringify((await inbox('?playerId=pl-guni')).body.items.map((c) => c.id)) === JSON.stringify([child_.id]), 'playerId: one player\'s threads (a Room\'s inbox panel)');
  ok((await inbox('?playerId=pl-nobody')).body.items.length === 0, 'playerId of a player with no thread: an empty page');
  neg((await inbox('?limit=0')).body?.error === 'PAGE_LIMIT_INVALID', 'limit=0: 400 PAGE_LIMIT_INVALID');
  neg((await inbox('?cursor=junk')).body?.error === 'PAGE_CURSOR_INVALID', 'a junk cursor: 400 PAGE_CURSOR_INVALID');
  const twice = await inbox('?playerId=a&playerId=b');
  neg(twice.status === 400 && twice.body.error === 'FIELD_INVALID' && twice.body.field === 'playerId', 'playerId twice: 400 naming the field');
  ok((await j('GET', '/org/channels', undefined, harbour)).body.items.length === 0, 'another organisation\'s inbox holds none of them');
}

section('B — the inbox figures');
{
  const c0 = (await j('GET', '/org/channels/counts', undefined, maria)).body;
  ok(c0.threads === 3 && c0.unreadMessages === 1, 'three threads, one unread message (the player\'s reply)');
  ok((await j('POST', `/guardian/channels/${child_.id}/messages`, { text: 'Synthetic guardian message.' }, amara)).status === 201, 'the guardian writes');
  ok((await j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic club message.' }, maria)).status === 201, 'the club writes (its own message is never unread to it)');
  ok((await j('GET', '/org/channels/counts', undefined, maria)).body.unreadMessages === 2, 'two unread: the player\'s and the guardian\'s');
  ok((await j('POST', `/org/channels/${adult.id}/read`, {}, maria)).status === 200, 'the club opens the adult thread');
  ok((await j('GET', '/org/channels/counts', undefined, maria)).body.unreadMessages === 1, 'one unread left');
  const h = (await j('GET', '/org/channels/counts', undefined, harbour)).body;
  ok(h.threads === 0 && h.unreadMessages === 0, 'another organisation counts none of them');
}

section('C — junk refused at the route');
{
  const count = async () => (await j('GET', '/player/channels', undefined, kola)).body.find((c) => c.id === adult.id).messages.length;
  const before = await count();
  const long = await j('POST', `/player/channels/${adult.id}/messages`, { text: 'x'.repeat(4001) }, kola);
  neg(long.status === 400 && long.body.error === 'FIELD_INVALID' && long.body.field === 'text', 'a message over 4,000 characters: 400 naming the field');
  ok((await j('POST', `/player/channels/${adult.id}/messages`, { text: 'x'.repeat(4000) }, kola)).status === 201, 'a message of exactly 4,000 characters is sent');
  const numeric = await j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic.', clientMsgId: 42 }, maria);
  neg(numeric.status === 400 && numeric.body.error === 'FIELD_INVALID' && numeric.body.field === 'clientMsgId', 'a numeric retry id: 400 naming the field (it used to be turned into text)');
  const longId = await j('POST', `/guardian/channels/${child_.id}/messages`, { text: 'Synthetic.', clientMsgId: 'c'.repeat(65) }, amara);
  neg(longId.status === 400 && longId.body.field === 'clientMsgId', 'a retry id over 64 characters: 400 (it used to be cut to 64)');
  neg((await j('POST', `/player/channels/${adult.id}/messages`, { text: 7 }, kola)).body?.error === 'TEXT_REQUIRED', 'a non-text message: 400 TEXT_REQUIRED');
  ok(await count() === before + 1, 'nothing refused was stored');
}

section('D — a retried send');
{
  const first = await j('POST', `/player/channels/${other.id}/messages`, { text: 'Synthetic once.', clientMsgId: 'retry-1' }, mateus);
  const again = await j('POST', `/player/channels/${other.id}/messages`, { text: 'Synthetic once (retried).', clientMsgId: 'retry-1' }, mateus);
  ok(first.status === 201 && again.status === 201 && JSON.stringify(again.body) === JSON.stringify(first.body), 'the retry answers the stored message');
  const club = await j('POST', `/org/channels/${other.id}/messages`, { text: 'Synthetic club, same id.', clientMsgId: 'retry-1' }, maria);
  ok(club.status === 201 && club.body.id !== first.body.id, 'another sender may use the same retry id');
  const msgs = (await j('GET', '/player/channels', undefined, mateus)).body.find((c) => c.id === other.id).messages;
  ok(msgs.filter((m) => m.clientMsgId === 'retry-1').length === 2, 'stored once per sender');
}

section('E — a message with its ledger row and notification; the receipts');
{
  const notes = async () => (await j('GET', '/player/notifications', undefined, kola)).body.filter((n) => n.type === 'message').length;
  const ledger = async () => (await j('GET', '/org/ledger?limit=100', undefined, maria)).body.items.filter((e) => e.type === 'message').length;
  const [n0, l0] = [await notes(), await ledger()];
  ok((await j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic, for the record.' }, maria)).status === 201, 'the club writes to the player');
  ok(await ledger() === l0 + 1, 'its ledger row is there when the route answers');
  ok(await notes() >= n0 && (await j('GET', '/player/notifications', undefined, kola)).body.some((n) => n.type === 'message'), 'the player has the message notification');
  const r = await j('POST', `/player/channels/${adult.id}/read`, {}, kola);
  ok(r.status === 200 && Object.keys(r.body).join() === 'readBy' && typeof r.body.readBy.counterparty === 'number' && typeof r.body.readBy.org === 'number', 'the receipt route answers the stored receipts');
  const listed = (await j('GET', '/player/channels', undefined, kola)).body.find((c) => c.id === adult.id);
  ok(listed.readBy.counterparty === r.body.readBy.counterparty, 'the list agrees');
}

section('F — responses are allowlists');
{
  const pv = (await j('GET', '/player/channels', undefined, kola)).body[0];
  ok(!('orgId' in pv) && !('guardianId' in pv) && typeof pv.lastActivityAt === 'number', 'the player\'s view: no organisation or guardian id; the activity time');
  const gv = (await j('GET', '/guardian/channels', undefined, amara)).body[0];
  ok(!('orgId' in gv) && !('guardianId' in gv), 'the guardian\'s view: neither id');
  const ov = (await inbox()).body.items.find((c) => c.id === child_.id);
  ok(ov.orgId === 'org-eastport' && !('guardianId' in ov) && ov.closed === false, 'the club\'s view: its own id, no guardian id, the closed flag');
  ok(Object.keys(ov.messages[0]).every((k) => ['id', 'ts', 'sender', 'text', 'attachment', 'clientMsgId'].includes(k)), 'a message carries only its own fields');
  const audit = await j('GET', '/admin/channels?limit=2', undefined, null, ADMIN);
  ok(audit.status === 200 && audit.body.items.length === 2 && typeof audit.body.nextCursor === 'string', 'the admin audit pages the same way');
  const rest = await j('GET', `/admin/channels?cursor=${audit.body.nextCursor}`, undefined, null, ADMIN);
  const g = [...audit.body.items, ...rest.body.items].find((c) => c.id === child_.id);
  ok(g?.guardianId === 'gd-amara' && g.orgId === 'org-eastport', 'the admin audit carries both ids');
  ok((await j('GET', '/admin/overview', undefined, null, ADMIN)).body.channels === 3, 'the overview counts the threads');
  neg((await j('GET', '/admin/channels')).status === 401, 'the admin audit needs the admin key');
}

section('G — a sign-up name is at most 120 characters (S14h); a thread keeps the whole name');
{
  const tooLong = await j('POST', '/auth/player/signup', { name: `Synthetic ${'L'.repeat(340)}`, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' });
  neg(tooLong.status === 400 && tooLong.body?.error === 'FIELD_INVALID' && tooLong.body?.field === 'name', 'a 350-character name is refused at sign-up, naming the field (S14h)');
  const longName = `Synthetic ${'L'.repeat(110)}`;
  const signup = await j('POST', '/auth/player/signup', { name: longName, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' });
  ok(signup.status === 201, 'an adult with a 120-character name signs up');
  const req = await j('POST', `/org/players/${signup.body.playerId}/request`, { type: 'contact', message: 'Synthetic contact request.' }, maria);
  ok(req.status === 201, 'the club sends a contact request');
  const ans = await j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, signup.body.token);
  ok(ans.status === 200, 'the player can accept it (the thread opens)');
  const t = (await j('GET', '/player/channels', undefined, signup.body.token)).body[0];
  ok(t?.playerName === longName, 'the thread keeps the whole name (a thread holds up to 200 characters)');
  ok((await j('POST', `/player/channels/${t.id}/messages`, { text: 'Synthetic reply.' }, signup.body.token)).status === 201, 'and the player can write in it');
}

console.log(`\n${passed} messaging checks passed (${negatives} negative)`);
cleanup();
process.exit(0);
