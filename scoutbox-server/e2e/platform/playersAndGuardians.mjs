// Players and guardians (S14h: the identity repository's explicit writes and SQL reads), against a real server on a
// temporary data directory with the synthetic seed.
//
//   A a write's response is the stored record: availability, the switches, medical sharing, stats, badges, quiet
//     hours, a guardian's child settings
//   B junk is refused at the route, naming the field, instead of coerced: switches that are not true or false, stats
//     sent as text or out of range, an over-long or malformed sign-up, quiet hours' school-hours mute, the admin ID
//     decision
//   C the co-guardian: created with its links to the children in one unit; the primary's coGuardians list is worked
//     out from it; a duplicate e-mail (in any case) is 409; the co-guardian sees the children
//   D the admin guardians list pages by cursor; junk paging is refused
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../scripts/testPort.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-identity-'));
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
const refusedField = (r, field) => r.status === 400 && r.body?.error === 'FIELD_INVALID' && r.body?.field === field;

child = spawn('node', ['server.mjs'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA }, stdio: 'ignore' });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* booting */ }
  if (i > 80) throw new Error('server did not boot');
  await new Promise((r) => setTimeout(r, 250));
}

const amara = await login('/auth/guardian/login', { guardianId: 'gd-amara' });
const signup = await j('POST', '/auth/player/signup', { name: 'Identity Adult', dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1', position: 'CM', heightCm: 178 });
ok(signup.status === 201 && signup.body.player.heightCm === 178 && signup.body.player.city === null, 'an adult signs up (an absent city is null)');
const adult = signup.body.token;

section('A — a write answers with the stored record');
{
  const av = await j('POST', '/player/availability', { availability: 'loan_open', contractStatus: 'free_agent' }, adult);
  ok(av.status === 200 && av.body.availability === 'loan_open' && av.body.contractStatus === 'free_agent', 'availability and contract status');
  const fts = await j('POST', '/player/first-team-seeker', { enabled: true }, adult);
  ok(fts.status === 200 && fts.body.firstTeamSeeker === true, 'First Team Seeker on');
  const ap = await j('POST', '/player/academyplus', { enabled: true }, adult);
  ok(ap.status === 200 && ap.body.academyPlus === true && ap.body.badges.includes('Fresh Start'), 'Academy+ on, with its badge');
  const apOff = await j('POST', '/player/academyplus', { enabled: false }, adult);
  ok(apOff.status === 200 && apOff.body.academyPlus === false && !apOff.body.badges.includes('Fresh Start'), 'Academy+ off, the badge gone');
  const med = await j('POST', '/player/medical/share', { shared: true }, adult);
  ok(med.status === 200 && med.body.shared === true, 'medical sharing');
  const st = await j('POST', '/player/stats', { goals: 4, appearances: 9 }, adult);
  ok(st.status === 200 && st.body.stats.goals === 4 && st.body.stats.appearances === 9 && st.body.stats.assists === 0, 'stats');
  const bd = await j('POST', '/player/badges', { badges: ['Grit', 'Grit'] }, adult);
  ok(bd.status === 200 && JSON.stringify(bd.body.badges) === JSON.stringify(['Grit', 'Grit']), 'badges (a legal duplicate kept)');
  const pr = await j('POST', '/player/prefs', { quietStart: '22:00', quietEnd: '07:00', timezone: 'Europe/London' }, adult);
  ok(pr.status === 200 && pr.body.prefs.quietStart === '22:00' && pr.body.prefs.timezone === 'Europe/London', 'quiet hours');
  const me = (await j('GET', '/player/me', undefined, adult)).body;
  ok(me.availability === 'loan_open' && me.firstTeamSeeker === true && me.medical.shared === true && me.stats.goals === 4, 'and /player/me reads the same');
  const kid = await j('POST', '/guardian/children/pl-guni/availability', { availability: 'end_of_season' }, amara);
  ok(kid.status === 200 && kid.body.availability === 'end_of_season', 'a guardian sets a child\'s availability');
  const kidMed = await j('POST', '/guardian/children/pl-guni/medical/share', { shared: true }, amara);
  ok(kidMed.status === 200 && kidMed.body.shared === true, 'and a child\'s medical sharing');
}

section('B — junk refused at the route, naming the field');
{
  neg(refusedField(await j('POST', '/player/academyplus', { enabled: 'yes' }, adult), 'enabled'), 'a switch sent as text');
  neg(refusedField(await j('POST', '/player/first-team-seeker', {}, adult), 'enabled'), 'a switch left out');
  neg(refusedField(await j('POST', '/player/medical/share', { shared: 1 }, adult), 'shared'), 'a switch sent as a number');
  neg(refusedField(await j('POST', '/guardian/children/pl-guni/medical/share', { shared: 'true' }, amara), 'shared'), 'a guardian\'s switch sent as text');
  for (const [body, field] of [[{ goals: '3' }, 'goals'], [{ appearances: 2.5 }, 'appearances'], [{ passCompletionPct: 120 }, 'passCompletionPct'], [{ assists: -1 }, 'assists']]) {
    const r = await j('POST', '/player/stats', body, adult);
    neg(r.status === 400 && r.body?.error === 'BAD_STAT' && r.body?.field === field, `a stat ${JSON.stringify(body)} is refused`);
  }
  ok((await j('GET', '/player/me', undefined, adult)).body.stats.goals === 4, 'the refused stats changed nothing');
  for (const [body, field] of [
    [{ name: 'N'.repeat(121) }, 'name'], [{ heightCm: '180' }, 'heightCm'], [{ weightKg: 900 }, 'weightKg'],
    [{ position: 'WING' }, 'position'], [{ foot: 'both' }, 'foot'], [{ city: 42 }, 'city'], [{ lat: 'north', lng: 0 }, 'lat'],
  ]) neg(refusedField(await j('POST', '/auth/player/signup', { name: 'Junk Signup', dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1', ...body }), field), `a sign-up with ${field} junk`);
  neg(refusedField(await j('POST', '/player/prefs', { schoolHoursMute: 'yes' }, adult), 'schoolHoursMute'), 'a school-hours mute sent as text');
  const maria = await login('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' });
  neg(refusedField(await j('GET', '/org/players?country=GB&country=ES', undefined, maria), 'country'), 'a directory filter sent twice');
  const dir = await j('GET', '/org/players?position=CM', undefined, maria);
  ok(dir.status === 200 && dir.body.length >= 1 && dir.body.every((p) => p.position === 'CM'), 'the directory filters in SQL');
  neg(refusedField(await j('POST', '/admin/guardians/gd-amara/idv', { approved: 'true' }, null, ADMIN), 'approved'), 'an admin ID decision sent as text');
  const g = (await j('GET', '/guardian/me', undefined, amara)).body;
  ok(g.idVerified === true, 'the refused decision changed nothing');
}

section('C — the co-guardian');
{
  const co = await j('POST', '/guardian/coguardian', { name: 'Co Parent', email: 'co.parent@example.test' }, amara);
  ok(co.status === 201 && typeof co.body.guardianId === 'string', 'a co-guardian is created');
  const me = (await j('GET', '/guardian/me', undefined, amara)).body;
  ok(me.coGuardians.length === 1 && me.coGuardians[0].id === co.body.guardianId && me.coGuardians[0].email === 'co.parent@example.test', 'the primary lists it (worked out from the co-guardian\'s record)');
  const dup = await j('POST', '/guardian/coguardian', { name: 'Again', email: 'CO.PARENT@example.test' }, amara);
  neg(dup.status === 409 && dup.body?.error === 'EMAIL_IN_USE', 'the same e-mail in another case is refused');
  neg(refusedField(await j('POST', '/guardian/coguardian', { name: 'N'.repeat(121), email: 'long@example.test' }, amara), 'name'), 'an over-long co-guardian name');
  neg(refusedField(await j('POST', '/guardian/coguardian', { name: 'No At', email: 'not-an-address' }, amara), 'email'), 'a co-guardian e-mail that is not an address');
  ok((await j('GET', '/guardian/me', undefined, amara)).body.coGuardians.length === 1, 'the refusals created nobody');
  const coToken = await login('/auth/guardian/login', { email: 'CO.Parent@example.test' });
  const kids = (await j('GET', '/guardian/children', undefined, coToken)).body;
  ok(Array.isArray(kids) && kids.some((k) => k.id === 'pl-guni'), 'the co-guardian sees the children (the links were made with it); its e-mail signs in in any case');
}

section('D — the admin guardians list pages by cursor');
{
  const first = await j('GET', '/admin/guardians?limit=1', undefined, null, ADMIN);
  ok(first.status === 200 && first.body.guardians.length === 1 && typeof first.body.nextCursor === 'string' && Array.isArray(first.body.idvQueue), 'the first page and its cursor');
  const next = await j('GET', `/admin/guardians?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, undefined, null, ADMIN);
  ok(next.status === 200 && next.body.guardians.length === 1 && next.body.guardians[0].id !== first.body.guardians[0].id, 'the next page');
  ok(!('password' in first.body.guardians[0]) && !('emailCodeHash' in first.body.guardians[0]), 'an allowlist: no hash');
  neg((await j('GET', '/admin/guardians?limit=abc', undefined, null, ADMIN)).status === 400, 'junk paging');
}

console.log(`\nplayers and guardians: ${passed} checks passed (${negatives} negative)`);
cleanup();
