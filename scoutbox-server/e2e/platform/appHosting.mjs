// The web portals the server hosts (platform/portals), against a real server whose PUBLIC_DIR is a temporary folder
// holding stand-in builds of two of the four portals.
//
//   A files: a built file is served with its type; Vite's hashed assets may be cached for good, the rest revalidate;
//     an unchanged file answers 304 to its ETag
//   B app routes: the portal's root and any deep link are its index.html, so a reload works
//   C misses: a missing file answers 404, not HTML; a portal that wasn't built isn't served; a lookalike path, a
//     non-GET and a climb out of the build aren't served
//   D the API: routes still answer beside the portals, with the usual headers
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-apphosting-'));
const PUBLIC = path.join(DATA, 'public');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (pathname, init = {}) => {
  const res = await fetch(`${API}${pathname}`, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

// Stand-in builds: the club portal and the agent portal. The admin console and Grassroots aren't built.
const CLUB_INDEX =
  '<!doctype html><title>club</title><script type="module" src="/app/assets/index-abc123.js"></script>';
const CLUB_JS = 'console.log("club");';
const AGENT_INDEX = '<!doctype html><title>agent</title>';
const write = (rel, text) => {
  const file = path.join(PUBLIC, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
write('club/index.html', CLUB_INDEX);
write('club/assets/index-abc123.js', CLUB_JS);
write('club/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
write('agent/index.html', AGENT_INDEX);
// Beside the builds, not in one: never served.
write('secret.txt', 'not for the web');
// A folder without an index.html is not a build.
write('admin/assets/stray.js', 'console.log("stray");');

child = spawn(...serverCommand(), {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, PUBLIC_DIR: PUBLIC, SCOUTBOX_QUIET_LOGS: '1' },
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

section('A files');
let r = await get('/app/assets/index-abc123.js');
ok(r.status === 200 && r.text === CLUB_JS, 'a built asset is served');
ok(/javascript/.test(r.headers.get('content-type') ?? ''), 'with its type');
ok(r.headers.get('cache-control') === 'public, max-age=31536000, immutable', 'a hashed asset may be cached for good');
ok(r.headers.get('x-content-type-options') === 'nosniff', 'with the usual hardening headers');
const etag = r.headers.get('etag');
ok(!!etag, 'with an ETag');
r = await get('/app/assets/index-abc123.js', { headers: { 'if-none-match': etag } });
ok(r.status === 304, 'an unchanged asset answers 304 to its ETag');
r = await get('/app/favicon.svg');
ok(r.status === 200 && r.headers.get('cache-control') === 'no-cache', 'a file outside assets/ is revalidated');

section('B app routes');
for (const p of ['/app', '/app/', '/app/players/p-1', '/app/rooms/r-1/journey']) {
  r = await get(p);
  ok(
    r.status === 200 && r.text === CLUB_INDEX && /text\/html/.test(r.headers.get('content-type') ?? ''),
    `${p} is the club portal's index.html`,
  );
}
ok(r.headers.get('cache-control') === 'no-cache', 'index.html is revalidated, so a deploy shows at once');
r = await get('/agent/clients/c-1');
ok(r.status === 200 && r.text === AGENT_INDEX, "a deep link in the agent portal is the agent portal's index.html");

section('C misses');
r = await get('/app/assets/index-old999.js');
neg(r.status === 404 && JSON.parse(r.text).error === 'NOT_FOUND', 'a missing asset answers 404, not HTML');
r = await get('/app/robots.txt');
neg(r.status === 404, 'any missing file answers 404');
for (const p of ['/console', '/console/cases', '/grassroots', '/console/assets/stray.js']) {
  r = await get(p);
  neg(r.status === 404, `${p}: a portal that wasn't built isn't served`);
}
r = await get('/application');
neg(r.status === 404, "a path that only starts with a portal's name isn't served");
r = await get('/app/players', { method: 'POST' });
neg(r.status === 404, 'a POST under a portal is not answered with its index.html');
for (const p of ['/app/%2e%2e/secret.txt', '/app/..%2fsecret.txt', '/app/assets/%2e%2e/%2e%2e/secret.txt']) {
  r = await get(p);
  neg(r.status === 404 && !r.text.includes('not for the web'), `${p} doesn't climb out of the build`);
}

section('D the API');
r = await get('/healthz');
ok(r.status === 200 && r.headers.get('x-scoutbox-schema') !== null, 'an API route still answers beside the portals');
r = await get('/org/agent/relationships');
neg(
  r.status === 401 && JSON.parse(r.text).error === 'ORG_AUTH_REQUIRED',
  'an API path naming a portal is still the API',
);
r = await get('/no-such-route');
neg(r.status === 404 && JSON.parse(r.text).error === 'NOT_FOUND', 'an unknown path is still the API’s 404');

console.log(`\nplatform/appHosting: ${passed} checks passed, ${negatives} negative, 0 failed`);
cleanup();
process.exit(0);
