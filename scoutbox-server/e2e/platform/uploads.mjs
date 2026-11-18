// Uploading a player's footage: resumable upload sessions (their chunk plan, integrity check, idempotent finalise,
// abort, and the files going with a deleted account), the media link's own refusals, and caption tracks, against a
// freshly seeded server of its own. Moved out of scouting/clubWorkflows whole, so that battery runs without the upload
// subsystem.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { serverCommand, serverDir } from '../support/server.mjs';
import { freePort } from '../support/testPort.mjs';

const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-e2e-'));

let server = null;
async function startServer() {
  server = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
}
function killServer() {
  try {
    server.kill('SIGKILL');
  } catch {
    /* gone */
  }
}
process.on('exit', killServer);
await startServer();

let passed = 0;
const ok = (cond, name) => {
  if (!cond) {
    console.error(`✗ ${name}`);
    killServer();
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}`);
};
const j = async (pathname, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...headers },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const post = (p, body, h) => j(p, { method: 'POST', body: JSON.stringify(body ?? {}) }, h);
const put = (p, body, h) => j(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }, h);

const KOLA = (await post('/auth/player/login', { playerId: 'pl-adeyemi' })).body.token; // adult, London
const MARIA = (
  await post('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
).body.token;
let r;

// resumable uploads
const fileBuf = crypto.randomBytes(700 * 1024);
const sha = crypto.createHash('sha256').update(fileBuf).digest('hex');
r = await post(
  '/player/uploads',
  { size: fileBuf.length, mime: 'video/webm', title: 'Resumable training clip', sha256: sha },
  bearer(KOLA),
);
ok(r.status === 201 && r.body.upload.totalChunks === 2, 'upload session opens with chunk plan');
const up = r.body.upload;
r = await put(
  `/player/uploads/${up.id}/chunks/1`,
  { data: fileBuf.subarray(up.chunkSize).toString('base64') },
  bearer(KOLA),
);
ok(r.status === 200 && r.body.complete === false, 'chunk 1 lands; upload not complete');
r = await post(`/player/uploads/${up.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 409 && r.body.missing.includes(0), 'finalise refuses while chunks are missing — no premature success');
r = await put(
  `/player/uploads/${up.id}/chunks/0`,
  { data: fileBuf.subarray(0, up.chunkSize).toString('base64') },
  bearer(KOLA),
);
r = await post(`/player/uploads/${up.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 201 && r.body.media?.id, 'all chunks + checksum → finalised into real media');
const upMedia = r.body.media.id;
r = await post(`/player/uploads/${up.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 200 && r.body.media.id === upMedia, 'finalise retry is idempotent — no duplicate media');
r = await j('/player/me', {}, bearer(KOLA));
ok(r.body.media.filter((m) => m.title === 'Resumable training clip').length === 1, 'exactly one media item exists');
r = await post('/player/uploads', { size: 1000, mime: 'application/x-msdownload', title: 'nope' }, bearer(KOLA));
ok(r.status === 400, 'disallowed types refused at session open');
r = await post(
  '/player/uploads',
  { size: 512, mime: 'video/webm', title: 'bad sha', sha256: '0'.repeat(64) },
  bearer(KOLA),
);
const badUp = r.body.upload;
await put(`/player/uploads/${badUp.id}/chunks/0`, { data: crypto.randomBytes(512).toString('base64') }, bearer(KOLA));
r = await post(`/player/uploads/${badUp.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 409 && r.body.error === 'INTEGRITY_FAILED', 'integrity mismatch refuses finalisation');
// Junk is refused at upload session open, naming the field, not coerced.
r = await post('/player/uploads', { size: 1.5, mime: 'video/webm', title: 'half a byte' }, bearer(KOLA));
ok(
  r.status === 400 && r.body.field === 'size',
  'a size that is not a whole number of bytes is refused, naming the field',
);
r = await post('/player/uploads', { size: 512, mime: 'video/webm', title: 'short sha', sha256: 'abc' }, bearer(KOLA));
ok(
  r.status === 400 && r.body.field === 'sha256',
  'a checksum that is not 64 hexadecimal characters is refused (it was cut to 64)',
);
r = await post('/player/uploads', { size: 512, mime: 'video/webm', title: 42 }, bearer(KOLA));
ok(r.status === 400 && r.body.field === 'title', 'a title that is not text is refused (it was stringified)');
r = await post('/player/uploads', { size: 512, mime: 'video/webm', title: 't'.repeat(121) }, bearer(KOLA));
ok(
  r.status === 400 && r.body.field === 'title' && r.body.problem === 'too_long',
  'IN1 a title over 120 characters is refused, not cut',
);
r = await post('/player/uploads', { size: 512, mime: 'video/webm', title: 'Owner', playerId: 'pl-osei' }, bearer(KOLA));
ok(r.status === 400 && r.body.field === 'playerId', 'IN2 an upload cannot name the player it belongs to');
r = await post('/player/uploads', { size: 512, mime: 'application/x-msdownload', title: 'nope' }, bearer(KOLA));
ok(
  r.body.error === 'TYPE_NOT_ALLOWED' && r.body.allowed?.includes('video/mp4'),
  'IN3 a disallowed type lists the allowed ones',
);
r = await put(`/player/uploads/${badUp.id}/chunks/0`, { data: ['AAAA'] }, bearer(KOLA));
ok(
  r.status === 400 && r.body.field === 'data' && r.body.problem === 'not_text',
  'IN4 chunk data that is not text is refused',
);
r = await fetch(`${API}/media/${upMedia}?e=soon&s=x&v=y`, { headers: bearer(MARIA) });
ok(r.status === 400, 'IN5 a media link with an expiry that is not a number is refused');
r = await post(`/player/uploads/${badUp.id}/abort`, {}, bearer(KOLA));
ok(
  r.status === 200 && r.body.upload.status === 'aborted' && !fs.existsSync(path.join(DATA, 'upload-tmp', badUp.id)),
  'an aborted session keeps its row and loses its chunk files',
);
r = await j(`/player/uploads/${badUp.id}`, {}, bearer(KOLA));
ok(
  r.status === 200 && r.body.upload.status === 'aborted' && r.body.upload.received.length === 1,
  'and reads back aborted, with the chunk it had received',
);
r = await j(`/player/uploads/${badUp.id}`, {}, bearer(MARIA));
ok(r.status !== 200, "another account never reads a player's upload session");
// A deleted player's upload sessions go with the account, and so do their chunk files.
r = await j('/auth/player/signup', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Leaving Uploader',
    dob: '2000-02-02',
    country: 'GB',
    position: 'CM',
    password: 'longenough1',
  }),
});
const leaver = r.body.token;
r = await post('/player/uploads', { size: 600 * 1024, mime: 'video/mp4', title: 'Half sent' }, bearer(leaver));
const leaverUp = r.body.upload;
await put(
  `/player/uploads/${leaverUp.id}/chunks/0`,
  { data: crypto.randomBytes(leaverUp.chunkSize).toString('base64') },
  bearer(leaver),
);
ok(fs.existsSync(path.join(DATA, 'upload-tmp', leaverUp.id)), 'fixture: the half-sent upload has a chunk on disk');
r = await j('/player/account', { method: 'DELETE' }, bearer(leaver));
ok(r.status === 200, 'the uploader deletes their account');
{
  const s = new DatabaseSync(path.join(DATA, 'scoutbox.db'), { readOnly: true });
  try {
    ok(
      s.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE id = ?').get(leaverUp.id).n === 0 &&
        s.prepare('SELECT COUNT(*) AS n FROM upload_session_chunks WHERE upload_session_id = ?').get(leaverUp.id).n ===
          0,
      "the deleted player's upload session and its chunk rows are gone",
    );
  } finally {
    s.close();
  }
}
ok(!fs.existsSync(path.join(DATA, 'upload-tmp', leaverUp.id)), 'and its chunk files are removed');
// captions
r = await post(
  `/player/media/${upMedia}/captions`,
  { vtt: 'WEBVTT\n\n00:00.000 --> 00:04.000\nCoach: two cones, thirty metres.' },
  bearer(KOLA),
);
ok(r.status === 200, 'caption track uploads');
let capRes = await fetch(`${API}/media/${upMedia}/captions`, { headers: bearer(MARIA) });
ok(
  capRes.status === 200 && (capRes.headers.get('content-type') ?? '').includes('text/vtt'),
  'authorised club fetches captions as text/vtt',
);
capRes = await fetch(`${API}/media/${upMedia}/captions`);
ok(capRes.status === 401, 'anonymous caption fetch refused');
console.log(`\nplatform/uploads: all ${passed} checks passed`);
killServer();
process.exit(0);
