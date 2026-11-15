// Boots the TypeScript server and the Gleam release side by side on fresh data directories, makes the same
// requests of both, and prints where the responses' shapes differ: key paths, their order, and each value's JSON
// type. The batteries check what they assert; this catches drift in everything else a response carries.
//   gleam export erlang-shipment && node dev/shape_diff.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TS = path.resolve(process.env.SCOUTBOX_TS_SERVER ?? path.join(HERE, '../../../scoutbox/scoutbox-server'));
const GL = path.resolve(HERE, '..');
const boot = async (name, cmd, args, cwd, port) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `shape-${name}-`));
  const child = spawn(cmd, args, { cwd, env: { ...process.env, PORT: String(port), DATA_DIR: data, SCOUTBOX_QUIET_LOGS: '1' }, stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) break; } catch {}
    if (i > 120) throw new Error(`${name} did not boot`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { child, base: `http://localhost:${port}` };
};
const shape = (v, at = '$', out = []) => {
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  out.push(`${at}: ${t}`);
  if (t === 'object') for (const k of Object.keys(v)) shape(v[k], `${at}.${k}`, out);
  if (t === 'array' && v.length) shape(v[0], `${at}[0]`, out);
  return out;
};
const ts = await boot('ts', 'node', ['server.mjs'], TS, 21000 + Math.floor(Math.random() * 1000));
const gl = await boot('gl', `${GL}/build/erlang-shipment/entrypoint.sh`, ['run'], GL, 22000 + Math.floor(Math.random() * 1000));
const call = async (base, method, p, body, token, admin) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-key': 'scoutbox-admin' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const session = async (base) => ({
  maria: (await call(base, 'POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body.token,
  hackney: (await call(base, 'POST', '/auth/org/login', { orgId: 'org-hackneymarsh', scoutName: 'Hackney Coach', role: 'Head Coach', platform: 'grassroots' })).body.token,
  amara: (await call(base, 'POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token,
  moss: (await call(base, 'POST', '/auth/org/login', { orgId: 'org-mossside', scoutName: 'Moss Coach', role: 'Head Coach', platform: 'grassroots' })).body.token,
});
const S = { ts: await session(ts.base), gl: await session(gl.base) };
const requests = [
  ['signup', (s) => ['POST', '/auth/player/signup', { name: 'Shape Adult', dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1', position: 'CM', heightCm: 180 }]],
  ['org view (pro club, adult)', (s) => ['GET', '/org/players/pl-adeyemi', null, s.maria]],
  ['org view (pro club, minor)', (s) => ['GET', '/org/players/pl-guni', null, s.maria]],
  ['org view (grassroots)', (s) => ['GET', '/org/players/pl-carvalho', null, s.hackney]],
  ['org view (grassroots, adult in radius)', (s) => ['GET', '/org/players/pl-osei', null, s.hackney]],
  ['org view (verified grassroots, minor in radius)', (s) => ['GET', '/org/players/pl-guni', null, s.hackney]],
  ['org view (unverified grassroots, adult)', (s) => ['GET', '/org/players/pl-adeyemi', null, s.moss]],
  ['org view (unverified grassroots, minor)', (s) => ['GET', '/org/players/pl-guni', null, s.moss]],
  ['guardian me', (s) => ['GET', '/guardian/me', null, s.amara]],
  ['guardian children', (s) => ['GET', '/guardian/children', null, s.amara]],
  ['contact request', (s) => ['POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Hello.' }, s.maria]],
  ['guardian inbox', (s) => ['GET', '/guardian/inbox', null, s.amara]],
  ['guardian notifications', (s) => ['GET', '/guardian/notifications', null, s.amara]],
  ['guardian log', (s) => ['GET', '/guardian/log', null, s.amara]],
  ['admin clubs', (s) => ['GET', '/admin/clubs?limit=1', null, null, true]],
  ['admin overview', (s) => ['GET', '/admin/overview', null, null, true]],
  ['admin metrics', (s) => ['GET', '/admin/metrics', null, null, true]],
  ['funnel', (s) => ['GET', '/org/funnel', null, s.maria]],
  ['directory', (s) => ['GET', '/org/players?limit=3', null, s.maria]],
  ['directory (grassroots)', (s) => ['GET', '/org/players?limit=3', null, s.hackney]],
  ['directory u18', (s) => ['GET', '/org/players?ageGroup=u18', null, s.maria]],
  ['directory search', (s) => ['GET', '/org/players?q=london', null, s.maria]],
  ['film room', (s) => ['GET', '/org/filmroom?limit=2', null, s.maria]],
  ['fixtures', (s) => ['GET', '/org/fixtures?limit=2', null, s.maria]],
  ['admin guardians', (s) => ['GET', '/admin/guardians?limit=1', null, null, true]],
  ['child availability', (s) => ['POST', '/guardian/children/pl-guni/availability', { availability: 'end_of_season' }, s.amara]],
  ['coguardian', (s) => ['POST', '/guardian/coguardian', { name: 'Co Parent', email: 'co.shape@example.test' }, s.amara]],
  ['idv review', (s) => ['POST', '/admin/guardians/gd-amara/idv', { approved: true }, null, true]],
];
const adultToken = {};
for (const [k, srv] of [['ts', ts], ['gl', gl]]) adultToken[k] = (await call(srv.base, 'POST', '/auth/player/signup', { name: 'Me Adult', dob: '1999-05-05', country: 'GB', password: 'synthetic-pass-1', position: 'ST' })).body.token;
S.ts.adult = adultToken.ts; S.gl.adult = adultToken.gl;
requests.push(
  ['player me', (s) => ['GET', '/player/me', null, s.adult]],
  ['stats', (s) => ['POST', '/player/stats', { goals: 2 }, s.adult]],
  ['academyplus', (s) => ['POST', '/player/academyplus', { enabled: true }, s.adult]],
  ['prefs', (s) => ['POST', '/player/prefs', { quietStart: '22:00', timezone: 'Europe/Paris' }, s.adult]],
  ['prefs bad zone', (s) => ['POST', '/player/prefs', { timezone: 'Mars/Olympus' }, s.adult]],
  ['availability', (s) => ['POST', '/player/availability', { availability: 'loan_open' }, s.adult]],
  ['timeline', (s) => ['POST', '/player/timeline', { year: '2025', event: 'Scored a hat-trick' }, s.adult]],
  ['export', (s) => ['GET', '/player/export', null, s.adult]],
  ['player me after', (s) => ['GET', '/player/me', null, s.adult]],
);
let differing = 0;
const keysOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
try {
  for (const [name, make] of requests) {
    const [a, b] = await Promise.all([call(ts.base, ...make(S.ts)), call(gl.base, ...make(S.gl))]);
    if (a.body?.distanceKm !== undefined || b.body?.distanceKm !== undefined) console.log(`      distanceKm ${a.body?.distanceKm} vs ${b.body?.distanceKm}`);
    const sa = shape(a.body), sb = shape(b.body);
    const onlyTs = sa.filter((x) => !sb.includes(x)), onlyGl = sb.filter((x) => !sa.includes(x));
    const order = sa.filter((x) => sb.includes(x)).join() !== sb.filter((x) => sa.includes(x)).join();
    if (order) {
      const fa = sa.filter((x) => sb.includes(x)), fb = sb.filter((x) => sa.includes(x));
      const i = fa.findIndex((x, j) => x !== fb[j]);
      console.log('   first difference:', fa.slice(i, i + 4), 'vs', fb.slice(i, i + 4));
    }
    if (a.status === b.status && !onlyTs.length && !onlyGl.length && !order) { console.log(`same  ${name} (${a.status})`); continue; }
    differing++;
    console.log(`DIFF  ${name}: status ${a.status} vs ${b.status}${order ? ', key order differs' : ''}`);
    for (const x of onlyTs) console.log(`        TS only  ${x}`);
    for (const x of onlyGl) console.log(`        Gleam only  ${x}`);
  }
} finally {
  ts.child.kill('SIGKILL');
  gl.child.kill('SIGKILL');
}
console.log(`\n${differing} of ${requests.length} responses differ in shape`);
