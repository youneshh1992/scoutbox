// Uploads through object storage (final-port-steps.md step 5), against the local store, which refuses what R2 does,
// on a freshly seeded server of its own.
//
//   A declaring: each audience opens the purposes it may upload; junk is refused by field, not coerced
//   B storage: the URL takes exactly the declared bytes with exactly its headers, once
//   C limits: an owner holds at most ten open uploads
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverCommand, serverDir } from '../support/server.mjs';
import { freePort } from '../support/testPort.mjs';
import { declare, opener, put, sha256Hex } from '../support/uploads.mjs';

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
r = await declare(API, asMaria, { purpose: 'verification_evidence', bytes: Buffer.alloc(100), mime: 'application/pdf' });
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
  body: JSON.stringify({ purpose: 'player_clip', size: 10, mime: 'video/mp4', sha256: sha256Hex('x'), playerId: 'pl-osei' }),
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
  r = await declare(API, asMaria, { purpose: 'signing_document', bytes: Buffer.alloc(10 + i), mime: 'application/pdf' });
  ok(r.status === 201, `open upload ${i + 3} of 10`);
}
r = await declare(API, asMaria, { purpose: 'signing_document', bytes: Buffer.alloc(99), mime: 'application/pdf' });
neg(r.status === 429 && r.body.error === 'TOO_MANY_OPEN_UPLOADS', 'an eleventh open upload is refused');
r = await declare(API, asKola, { purpose: 'player_clip', bytes: clip, mime: 'video/mp4' });
ok(r.status === 201, "another owner's uploads don't count");

r = await fetch(`${API}/media/whatever?e=soon&s=x&v=y`, { headers: { authorization: `Bearer ${MARIA}` } });
neg(r.status === 400, 'a media link with an expiry that is not a number is refused');

console.log(`\nplatform/uploads: ${passed} checks passed, ${negatives} negative, 0 failed`);
cleanup();
process.exit(0);
