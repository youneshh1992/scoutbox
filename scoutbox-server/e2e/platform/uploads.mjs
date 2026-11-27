// Uploads through object storage (docs/final-port-steps.md, step 5), against the local store, which refuses what R2 does,
// on a freshly seeded server of its own.
//
//   A declaring: each audience opens the purposes it may upload; junk is refused by field, not coerced
//   B storage: the URL takes exactly the declared bytes with exactly its headers, once
//   C limits: an owner holds at most ten open uploads
//   D clips: an upload named to /player/media becomes a clip with its file, once; the Verified Clip needs one; the
//     media link redirects to storage for whoever may see the clip; a drill result naming such a clip is verified;
//     erasure removes the file
//   E evidence: an upload named as evidence once; again, the evidence it became is named
//   F clean-up: the sweep expires uploads past their time and removes their files, once; a file a record uses stays;
//     a clip file erasure couldn't remove stays queued, unserved, until a sweep removes it
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverCommand, serverDir } from '../support/server.mjs';
import { freePort } from '../support/testPort.mjs';
import { DatabaseSync } from 'node:sqlite';
import { declare, fileOf, opener, put, sha256Hex, upload } from '../support/uploads.mjs';

const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-uploads-'));

let passed = 0;
let negatives = 0;
let child = null;
function cleanup() {
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on('exit', cleanup);
const ok = (cond, name) => {
  if (!cond) {
    console.error(`✗ ${name}`);
    cleanup();
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}`);
};
const neg = (cond, name) => {
  negatives++;
  ok(cond, `[neg] ${name}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const j = async (method, pathname, body, token) => {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child = spawn(...serverCommand(), {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, SCOUTBOX_QUIET_LOGS: '1' },
  stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${API}/health`)).ok) break;
  } catch {
    /* booting */
  }
  if (i > 80) throw new Error('server did not boot');
  await sleep(250);
}

const KOLA = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const MARIA = (
  await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
).body.token;
const asKola = opener.player(KOLA);
const asMaria = opener.org(MARIA);
const clip = crypto.randomBytes(300 * 1024);
let r;

section('A declaring');
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
ok(
  r.status === 201 && /^upl-[0-9a-f]{24}$/.test(r.body.uploadId) && typeof r.body.expiresAt === 'string',
  'a player declares a clip and gets an upload id',
);
ok(
  JSON.stringify(Object.keys(r.body)) === '["uploadId","put","expiresAt"]' &&
    r.body.put.headers['content-type'] === 'video/mp4' &&
    r.body.put.headers['if-none-match'] === '*' &&
    r.body.put.headers['x-amz-checksum-sha256'] === Buffer.from(sha256Hex(clip), 'hex').toString('base64'),
  'with a URL and the headers the PUT must carry: the type, no overwrite and the declared digest',
);
const opened = r.body;
r = await declare(API, asMaria, {
  purpose: 'verification_evidence',
  bytes: Buffer.alloc(100),
  mime: 'application/pdf',
});
ok(r.status === 201, 'organisation staff declare evidence');
r = await declare(API, asMaria, { purpose: 'signing_document', bytes: Buffer.alloc(100), mime: 'application/pdf' });
ok(r.status === 201, 'and signing documents');
r = await declare(API, asKola, { purpose: 'signing_document', bytes: Buffer.alloc(100), mime: 'application/pdf' });
neg(r.status === 400 && r.body.field === 'purpose', "a player can't declare another audience's purpose");
r = await declare(API, asMaria, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
neg(r.status === 400 && r.body.field === 'purpose', 'nor can staff declare a clip');
r = await declare(API, opener.player('nope'), { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
neg(r.status === 401, 'without a session nothing is declared');
r = await declare(API, opener.applicant('vroot-none', 'secret'), {
  purpose: 'verification_evidence',
  bytes: Buffer.alloc(100),
  mime: 'application/pdf',
});
neg(r.status === 404, "an applicant without the application's secret declares nothing");
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'application/x-msdownload' });
neg(
  r.status === 400 && r.body.error === 'TYPE_NOT_ALLOWED' && r.body.allowed?.includes('video/mp4'),
  'a type the purpose refuses lists the allowed ones',
);
r = await declare(API, asMaria, { purpose: 'verification_evidence', bytes: clip, mime: 'video/mp4' });
neg(r.status === 400 && r.body.error === 'TYPE_NOT_ALLOWED', "evidence can't be a video");
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4', size: 1.5 });
neg(r.status === 400 && r.body.field === 'size', 'a size that is not a whole number of bytes is refused by field');
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4', size: 40 * 1024 * 1024 + 1 });
neg(
  r.status === 400 && r.body.field === 'size' && r.body.problem === 'too_large' && r.body.max === 41943040,
  'a clip over 40 MiB is refused, naming the cap',
);
r = await declare(API, asMaria, {
  purpose: 'verification_evidence',
  bytes: clip,
  mime: 'application/pdf',
  size: 8 * 1024 * 1024 + 1,
});
neg(r.status === 400 && r.body.field === 'size' && r.body.max === 8388608, 'evidence over 8 MiB is refused');
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4', sha256: 'abc' });
neg(r.status === 400 && r.body.field === 'sha256', 'a digest that is not 64 hexadecimal characters is refused');
r = await declare(API, asKola, {
  purpose: 'player_clip',
  bytes: clip,
  mime: 'video/mp4',
  sha256: sha256Hex(clip).toUpperCase(),
});
neg(r.status === 400 && r.body.field === 'sha256', 'nor is one in upper case: the digest is written one way');
r = await fetch(`${API}/player/uploads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KOLA}` },
  body: JSON.stringify({
    purpose: 'player_clip',
    size: 10,
    mime: 'video/mp4',
    sha256: sha256Hex('x'),
    playerId: 'pl-osei',
  }),
});
neg(r.status === 400 && (await r.json()).field === 'playerId', 'an upload cannot name the player it belongs to');

section('B storage');
r = await put(API, opened, clip, { 'x-amz-checksum-sha256': null });
neg(r.status === 403, 'a PUT without the signed digest header is refused');
r = await put(API, opened, clip, { 'content-type': 'video/webm' });
neg(r.status === 403, 'so is one that changes the type');
const flipped = Buffer.from(clip);
flipped[1000] ^= 1;
r = await put(API, opened, flipped);
neg(r.status === 400, 'bytes other than the declared ones are refused');
r = await put(API, opened, clip.subarray(1));
neg(r.status === 400, 'and so is a file of another length');
r = await put(API, opened, clip);
ok(r.status === 200, 'the declared bytes are stored');
r = await put(API, opened, clip);
neg(r.status === 412, 'once: the key is never written again');
r = await fetch(new URL(opened.put.url, API), { method: 'GET' });
neg(r.status === 403, "an upload's URL doesn't read the file back");

section('C limits');
// Kola has one open upload, and staff two; staff fill theirs to the cap.
for (let i = 0; i < 8; i++) {
  r = await declare(API, asMaria, {
    purpose: 'signing_document',
    bytes: Buffer.alloc(10 + i),
    mime: 'application/pdf',
  });
  ok(r.status === 201, `open upload ${i + 3} of 10`);
}
r = await declare(API, asMaria, { purpose: 'signing_document', bytes: Buffer.alloc(99), mime: 'application/pdf' });
neg(r.status === 429 && r.body.error === 'TOO_MANY_OPEN_UPLOADS', 'an eleventh open upload is refused');
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
ok(r.status === 201, "another owner's uploads don't count");

section('D clips');
const CARVALHO = (await j('POST', '/auth/player/login', { playerId: 'pl-carvalho' })).body.token;
const clipId = await upload(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
r = await j('POST', '/player/media', { title: 'Uploaded training clip', uploadId: clipId }, KOLA);
ok(
  r.status === 201 &&
    r.body.media.kind === 'video' &&
    r.body.media.sizeBytes === clip.length &&
    /^\/media\/media-[0-9]+\?e=\d+&s=[\w-]+&v=[\w-]+$/.test(r.body.media.url) &&
    typeof r.body.trustScore === 'number',
  'naming the upload makes a clip with its file and a signed link',
);
const made = r.body.media;
r = await j('POST', '/player/media', { title: 'Uploaded training clip', uploadId: clipId }, KOLA);
ok(r.status === 201 && r.body.media.id === made.id, 'naming it again answers the same clip');
r = await j('GET', '/player/me', undefined, KOLA);
ok(r.body.media.filter((m) => m.title === 'Uploaded training clip').length === 1, 'and there is exactly one');
r = await j('POST', '/player/media', { title: 'Not mine', uploadId: clipId }, CARVALHO);
neg(r.status === 404 && r.body.error === 'UPLOAD_NOT_FOUND', "another player can't name Kola's upload");
r = await j('POST', '/player/media', { title: 'Nothing sent', uploadId: opened.uploadId.replace(/.$/, '0') }, KOLA);
neg(r.status === 404, 'an upload id nobody declared names nothing');
r = await declare(API, asKola, { purpose: 'player_clip', bytes: Buffer.from('never sent'), mime: 'video/webm' });
r = await j('POST', '/player/media', { title: 'Never sent', uploadId: r.body.uploadId }, KOLA);
neg(r.status === 409 && r.body.error === 'UPLOAD_NOT_RECEIVED', 'an upload whose file never arrived makes no clip');
r = await fetch(`${API}${made.url}`, { redirect: 'manual' });
ok(r.status === 302 && r.headers.get('location').startsWith('/blobs/'), 'the media link redirects to storage');
r = await fetch(`${API}${made.url}`);
ok(r.ok && Buffer.from(await r.arrayBuffer()).equals(clip), 'which serves the uploaded bytes');
r = await fetch(`${API}${made.url}`, { headers: { range: 'bytes=100-199' } });
ok(
  r.status === 206 && Buffer.from(await r.arrayBuffer()).equals(clip.subarray(100, 200)),
  'a byte range of it, so a video can be seeked',
);
r = await fetch(`${API}/media/${made.id}`, { redirect: 'manual' });
neg(r.status === 401, 'a bare media id without signature or session is refused, before any redirect');
r = await j('GET', '/org/players/pl-adeyemi', undefined, MARIA);
const clubLink = r.body.media.find((m) => m.id === made.id)?.url;
r = await fetch(`${API}${clubLink}`);
ok(r.ok && Buffer.from(await r.arrayBuffer()).equals(clip), 'a club that may see the player watches the clip');

const attendanceId = (await j('GET', '/player/me', undefined, KOLA)).body.attendance[0].id;
r = await j('POST', '/player/media', { title: 'Cup final', attendanceId }, KOLA);
neg(r.status === 400 && r.body.error === 'FILE_REQUIRED_FOR_VERIFIED_CLIP', 'the Verified Clip needs the footage');
const sealedId = await upload(API, asKola, {
  purpose: 'player_clip',
  bytes: clip.subarray(0, 4096),
  mime: 'video/webm',
});
r = await j('POST', '/player/media', { title: 'Cup final', uploadId: sealedId, attendanceId: 'att-507075353' }, KOLA);
neg(r.status === 400 && r.body.error === 'ATTENDANCE_NOT_FOUND', "another player's attendance seals nothing");
r = await j('POST', '/player/media', { title: 'Cup final', uploadId: sealedId, attendanceId }, KOLA);
ok(r.status === 201 && r.body.media.verifiedClip === attendanceId, 'with it, the clip is sealed to the attendance');

r = await j(
  'POST',
  `/player/media/${made.id}/captions`,
  { vtt: 'WEBVTT\n\n00:00.000 --> 00:04.000\nCoach: two cones, thirty metres.' },
  KOLA,
);
ok(r.status === 200, 'a caption track is added to the clip');
r = await fetch(`${API}/media/${made.id}/captions`, { headers: { authorization: `Bearer ${MARIA}` } });
ok(r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/vtt'), 'the club reads it as text/vtt');
r = await fetch(`${API}/media/${made.id}/captions`);
neg(r.status === 401, 'anonymously, not at all');

// A drill result is verified by naming a clip of the player's own that carries its footage.
const drill = (body, token = KOLA) => j('POST', '/player/drills/drill-sprint-ladder/complete', body, token);
const resultOf = (res, value) => res.body?.drillResults?.find((x) => x.value === value);
r = await drill({ value: 4.41, mediaId: made.id });
ok(
  r.status === 200 && resultOf(r, 4.41)?.verified === true,
  "a drill result naming one of the player's clips is verified",
);
r = await drill({ value: 4.42 });
ok(r.status === 200 && resultOf(r, 4.42)?.verified === false, 'without one it is recorded unverified');
const titleOnly = (await j('POST', '/player/media', { title: 'Title only' }, KOLA)).body.media.id;
r = await drill({ value: 4.43, mediaId: titleOnly });
neg(
  r.status === 400 && r.body.error === 'FILE_REQUIRED_FOR_VERIFIED_RESULT',
  'a clip without its footage verifies nothing',
);
r = await drill({ value: 4.44, mediaId: made.id }, CARVALHO);
neg(r.status === 404 && r.body.error === 'MEDIA_NOT_FOUND', "another player's clip verifies nothing");
r = await drill({ value: 4.45, videoDataUrl: 'data:video/mp4;base64,AAAA' });
neg(r.status === 400 && r.body.problem === 'unknown_field', 'a video sent inline is refused');
r = await j('GET', '/player/me', undefined, KOLA);
neg(
  ![4.43, 4.44, 4.45].some((v) => r.body.drillResults.some((x) => x.value === v)),
  'and a refused result is not recorded',
);

// A deleted player's clip files go with the account, and an upload never named expires.
r = await j('POST', '/auth/player/signup', {
  name: 'Leaving Uploader',
  dob: '2000-02-02',
  country: 'GB',
  position: 'CM',
  password: 'longenough1',
});
const leaver = r.body.token;
const asLeaver = opener.player(leaver);
const leaverClip = await upload(API, asLeaver, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
r = await j('POST', '/player/media', { title: 'Leaving clip', uploadId: leaverClip }, leaver);
ok(r.status === 201, 'fixture: the leaver has a clip');
const halfSent = await upload(API, asLeaver, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
const stored = (key) => fs.existsSync(path.join(DATA, 'media', key));
ok(stored(leaverClip) && stored(halfSent), 'fixture: both files are in storage');
r = await j('DELETE', '/player/account', undefined, leaver);
ok(r.status === 200, 'the leaver deletes their account');
ok(!stored(leaverClip), "the clip's file is removed");
{
  const db = new DatabaseSync(path.join(DATA, 'scoutbox.db'), { readOnly: true });
  try {
    ok(db.prepare('SELECT COUNT(*) AS n FROM media_deletions').get().n === 0, 'and its removal is not left queued');
    ok(
      db.prepare('SELECT status FROM upload_intents WHERE id = ?').get(halfSent).status === 'expired',
      'the upload never made into a clip has expired, for the sweep to remove',
    );
  } finally {
    db.close();
  }
}

section('E evidence');
const TOM = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Reid', role: 'Scout' })).body
  .token;
const claim = (await j('POST', '/org/verification/identity', {}, TOM)).body.claim.id;
const passport = fileOf('image/png', 2048);
const evidenceUpload = await upload(API, opener.org(TOM), {
  purpose: 'verification_evidence',
  bytes: passport,
  mime: 'image/png',
});
r = await j(
  'POST',
  `/org/verification/claims/${claim}/evidence`,
  { uploadId: evidenceUpload, filename: 'id.png' },
  TOM,
);
ok(r.status === 201 && r.body.claim.evidence.length === 1, "Tom's upload becomes evidence on his claim");
const evidenceId = r.body.claim.evidence[0].id;
r = await j(
  'POST',
  `/org/verification/claims/${claim}/evidence`,
  { uploadId: evidenceUpload, filename: 'id.png' },
  TOM,
);
neg(
  r.status === 409 && r.body.error === 'UPLOAD_ALREADY_USED' && r.body.evidenceId === evidenceId,
  'naming it again adds nothing, and names the evidence it became',
);
const clipAsEvidence = await upload(API, asKola, {
  purpose: 'player_clip',
  bytes: clip.subarray(0, 64),
  mime: 'video/mp4',
});
r = await j('POST', `/org/verification/claims/${claim}/evidence`, { uploadId: clipAsEvidence, filename: 'x.mp4' }, TOM);
neg(r.status === 404, "a player's clip upload is not evidence");

section('F clean-up');
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };
const sweep = async () => {
  const res = await fetch(`${API}/admin/sweep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ADMIN },
    body: '{}',
  });
  return res.status;
};
const intent = (id) => {
  const db = new DatabaseSync(path.join(DATA, 'scoutbox.db'), { readOnly: true });
  try {
    return db.prepare('SELECT status, removed_at AS removedAt FROM upload_intents WHERE id = ?').get(id);
  } finally {
    db.close();
  }
};
const backdate = (id) => {
  const db = new DatabaseSync(path.join(DATA, 'scoutbox.db'));
  try {
    db.prepare('UPDATE upload_intents SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  } finally {
    db.close();
  }
};
const forgotten = await upload(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
ok(stored(forgotten), 'fixture: an upload sent but never named');
backdate(forgotten);
ok((await sweep()) === 200, 'the sweep runs after its time has passed');
ok(!stored(forgotten) && !fs.existsSync(path.join(DATA, 'media', `${forgotten}.json`)), 'its file is removed');
r = intent(forgotten);
ok(r.status === 'expired' && typeof r.removedAt === 'number', 'and the upload is expired, its removal recorded');
const removedAt = r.removedAt;
r = await j('POST', '/player/media', { title: 'Too late', uploadId: forgotten }, KOLA);
neg(r.status === 410 && r.body.error === 'UPLOAD_EXPIRED', 'naming it now answers that it expired');
ok((await sweep()) === 200 && intent(forgotten).removedAt === removedAt, 'a second sweep changes nothing');
ok(!stored(halfSent) && typeof intent(halfSent).removedAt === 'number', "the leaver's unnamed upload is removed too");
ok(stored(clipId) && intent(clipId).status === 'used', 'a file a clip uses stays');
ok(stored(evidenceUpload) && intent(evidenceUpload).status === 'used', 'and so does one evidence uses');

// Erasure that can't reach storage keeps the clip's removal queued; the clip is never served meanwhile.
if (process.getuid?.() === 0) {
  console.log('(skipped: as root, a read-only directory refuses nothing)');
} else {
  r = await j('POST', '/auth/player/signup', {
    name: 'Stranded Uploader',
    dob: '2000-03-03',
    country: 'GB',
    position: 'CB',
    password: 'longenough1',
  });
  const stranded = r.body.token;
  const strandedKey = await upload(API, opener.player(stranded), {
    purpose: 'player_clip',
    bytes: clip,
    mime: 'video/mp4',
  });
  r = await j('POST', '/player/media', { title: 'Stranded clip', uploadId: strandedKey }, stranded);
  ok(r.status === 201, 'fixture: a player with a clip');
  const strandedLink = r.body.media.url;
  const queued = () => {
    const db = new DatabaseSync(path.join(DATA, 'scoutbox.db'), { readOnly: true });
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM media_deletions WHERE blob_key = ?').get(strandedKey).n;
    } finally {
      db.close();
    }
  };
  const media = path.join(DATA, 'media');
  fs.chmodSync(media, 0o555);
  try {
    r = await j('DELETE', '/player/account', undefined, stranded);
    ok(r.status === 200, 'the player deletes their account while storage refuses removals');
    ok(stored(strandedKey) && queued() === 1, "the clip's file is still there, its removal queued");
    r = await fetch(`${API}${strandedLink}`, { redirect: 'manual' });
    neg(r.status !== 302 && r.status !== 200, 'and the clip is not served');
    ok((await sweep()) === 200 && queued() === 1, 'a sweep that still cannot remove it keeps it queued');
  } finally {
    fs.chmodSync(media, 0o755);
  }
  ok((await sweep()) === 200, 'once storage answers, the sweep runs');
  ok(!stored(strandedKey) && queued() === 0, 'and removes the file and its queue entry');
}

r = await fetch(`${API}/media/whatever?e=soon&s=x&v=y`, { headers: { authorization: `Bearer ${MARIA}` } });
neg(r.status === 400, 'a media link with an expiry that is not a number is refused');

console.log(`\nplatform/uploads: ${passed} checks passed, ${negatives} negative, 0 failed`);
cleanup();
process.exit(0);
