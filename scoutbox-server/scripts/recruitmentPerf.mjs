// Recruitment at scale: does the recruitment domain meet the bar (p50 under 5 ms on the hot paths, no request
// writing the whole database) with 100k synthetic players?
//
// 1. Builds a database in a temporary directory: the synthetic population (scripts/perfPopulation.mjs) and the
//    recruitment graph of the recruitment test fixtures (a Room case with its request, trial, comments, snapshots,
//    decisions, evidence states, contacts, offers, signing packages, signings, follow-ups and outcome report, plus an
//    workspace case, a legacy case and a tombstoned one), cloned with fresh ids onto real clubs and players. One club is
//    busy (BUSY clones); the rest of the clones spread over the other clubs, and one player is in many of them.
//    Every record is written through its repository (scripts/dataLayerFixture.mjs), so it is typed as a route's write is.
// 2. Boots the real server on that directory and times the hot reads over HTTP (sequential, after a warm-up), for
//    the busy club, a typical club, the popular player and a guardian.
// 3. Times one write (a Room comment) and measures what it adds to the write-ahead log, against the size of the
//    database.
// 4. Times the every-minute sweeps' queries on their own connection.
//
// Timings include the HTTP round trip on localhost. Synthetic data only; nothing touches DATA_DIR.
// Usage: node scripts/recruitmentPerf.mjs [players=100000] [clones=10000] [busy=500]
// PERF_DIR=<dir> keeps the database there and reuses it on the next run with the same arguments (the build is
// deterministic; a reused database has been booted, so its rows may have moved on by the sweeps' minutes).
// PERF_BOOT_ONLY=1 stops after the boot (and, with PERF_CPU_PROF=<dir>, writes a CPU profile of it there).
// PERF_ONLY=<text> times only the routes whose path contains it (with PERF_CPU_PROF, a profile of those routes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openLayer, writeFixture } from './dataLayerFixture.mjs';
import { createRecruitmentRepository } from '../repositories/recruitment.mjs';
import { createSigningsFollowUpsRepository } from '../repositories/signingsFollowUps.mjs';
import { syntheticPopulation } from './perfPopulation.mjs';
import { tempDir, NOW } from './coreIdentityTestFixtures.mjs';
import { p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest } from './recruitmentTestFixtures.mjs';
import { ROOM_CASES_FIX } from './recruitmentCasesTestFixtures.mjs';
import { CONTACTS_OFFERS_FIX } from './recruitmentContactsOffersTestFixtures.mjs';
import { SIGNINGS_FIX } from './signingsFollowUpsTestFixtures.mjs';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';

const arg = (i, fallback) => (process.argv[i] === undefined ? fallback : Number(process.argv[i]));
const PLAYERS = arg(2, 100_000);
const CLONES = arg(3, 10_000);
const BUSY = Math.min(CLONES, arg(4, 500));
const RUNS = 40;
const DAY = 86_400_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (m) => console.log(m);
const t0 = () => performance.now();
const since = (t) => performance.now() - t;
const fmt = (ms) => (ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(2)} ms`);
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// ------------------------------------------------------------------ the template graph and its clones
// The fixtures' clock is a fixed day (NOW of coreIdentityTestFixtures.mjs); every instant is moved to today, so the
// graph is current and the boot's sweep has no backlog to catch up on (a backlog is measured separately). The
// 200-day-old legacy signing is left out for the same reason: its follow-ups would all be
// backfilled and notified at the first boot.
const SHIFT = Date.now() - NOW;
const isInstant = (v) => typeof v === 'number' && v > NOW - 400 * DAY && v < NOW + 400 * DAY;
const shifted = (v) => (Array.isArray(v) ? v.map(shifted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shifted(x)])) : isInstant(v) ? v + SHIFT : v);
const TEMPLATE = () => {
  const t = {
    requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()],
    ...ROOM_CASES_FIX(), ...CONTACTS_OFFERS_FIX(), ...SIGNINGS_FIX(),
  };
  t.signings = t.signings.filter((x) => x.id !== 'sign-legacy');
  return shifted(t);
};
const IDENTITIES = ['org-pro', 'usr-1', 'pl-adult', 'pl-child1', 'gd-primary', 'pl-gone-long-ago'];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `clone(k, map)`: the template with every record id suffixed `-k<k>` and the identities replaced through `map`. */
function cloner(template) {
  const own = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'id' && typeof x === 'string') own.add(x); walk(x); } };
  walk(template);
  for (const id of IDENTITIES) own.delete(id);
  const tokens = [...own, ...IDENTITIES].sort((a, b) => b.length - a.length).map(escape);
  const re = new RegExp(`(?<![A-Za-z0-9])(${tokens.join('|')})(?![A-Za-z0-9])`, 'g');
  const json = JSON.stringify(template);
  return (k, map) => JSON.parse(json.replace(re, (t) => map[t] ?? `${t}-k${k}`));
}

function build() {
  const now = Date.now();
  const pop = syntheticPopulation({ players: PLAYERS, now });
  const { orgs: ORGS } = pop.counts;
  const clubs = pop.orgs.map((o, i) => ({ o, i })).filter(({ o }) => o.type === 'club');
  const busy = clubs.find(({ o }) => o.level === 'pro' && o.verified);
  const leads = clubs.filter(({ i }) => i !== busy.i && [i, i + ORGS, i + 2 * ORGS].some((j) => j % 3 === 0)); // a club with a recruitment lead
  const typical = leads[Math.floor(leads.length / 2)];
  const adults = pop.players.filter((p) => !p.guardianId); const minors = pop.players.filter((p) => p.guardianId);
  const popular = adults[1];
  const clone = cloner(TEMPLATE());
  const db = { ...pop }; delete db.counts;
  for (const name of Object.keys(TEMPLATE())) db[name] = [];
  const others = clubs.filter(({ i }) => i !== busy.i);
  for (let k = 0; k < CLONES; k += 1) {
    const club = k < BUSY ? busy : k === BUSY ? typical : others[(k * 7919) % others.length];
    const adult = k >= BUSY && k % 50 === 0 ? popular : adults[k % adults.length];
    const child = minors[k % minors.length];
    const graph = clone(k, { 'org-pro': club.o.id, 'usr-1': `usr-${club.i}`, 'pl-adult': adult.id, 'pl-child1': child.id, 'gd-primary': child.guardianId, 'pl-gone-long-ago': `pl-gone-k${k}` });
    for (const [name, rows] of Object.entries(graph)) for (const r of rows) {
      if ('orgName' in r) r.orgName = club.o.name;
      if ('playerName' in r && r.playerName !== null) r.playerName = r.playerId === child.id ? child.name : r.playerId === adult.id ? adult.name : r.playerName;
      db[name].push(r);
    }
  }
  const leadOf = (i) => `usr-${[i, i + ORGS, i + 2 * ORGS].find((j) => j % 3 === 0)}`;
  // A Grassroots club whose 50 km radius holds the population's ground (51.5, -0.1).
  const grass = clubs.find(({ o }) => o.level === 'grassroots' && Math.abs(o.location.lat - 51.5) < 0.2 && Math.abs(o.location.lng + 0.1) < 0.6) ?? null;
  return { db, now, grass: grass?.o ?? null, grassUser: grass ? `usr-${grass.i}` : null, busy: busy.o, busyUser: leadOf(busy.i), typical: typical.o, typicalUser: leadOf(typical.i), popular, guardian: minors[0].guardianId, ORGS };
}

// ------------------------------------------------------------------ the server
async function boot(dir) {
  const port = await freePort();
  const started = t0();
  return new Promise((resolve, reject) => {
    const args = process.env.PERF_CPU_PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.PERF_CPU_PROF}`] : [];
    const proc = spawnChild(process.execPath, [...args, path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, SCOUTBOX_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const get = async (p, token, init = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
      const text = await r.text(); return { status: r.status, text };
    };
    const S = { get, log: () => log, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }) };
    let timer = null;
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) { clearTimeout(timer); resolve({ ...S, bootMs: since(started) }); } });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${log.slice(-2000)}`)));
    timer = setTimeout(() => { proc.kill('SIGINT'); reject(new Error(`boot timeout: ${log.slice(-1000)}`)); }, Number(process.env.PERF_BOOT_TIMEOUT_MS) || 600_000).unref();
  });
}

const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
/** `spec` is a path (a GET) or `{ label, path, body }` (a POST of `body`, e.g. matching). */
async function timeRoute(S, label, spec, token) {
  const { path: route, body, label: shown = route } = typeof spec === 'string' ? { path: spec } : spec;
  const call = () => S.get(route, token, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  let last = null;
  for (let i = 0; i < 5; i += 1) last = await call();
  if (last.status !== 200) return { label, route: shown, status: last.status, error: last.text.slice(0, 160) };
  const xs = [];
  const t1 = t0(); await call(); const runs = since(t1) > 500 ? 5 : RUNS;
  for (let i = 0; i < runs; i += 1) { const t = t0(); const r = await call(); xs.push(since(t)); if (r.status !== 200) throw new Error(`${shown}: ${r.status}`); }
  return { label, route: shown, status: 200, runs, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), bytes: Buffer.byteLength(last.text) };
}

// ------------------------------------------------------------------ run
const KEEP = process.env.PERF_DIR || null;
const dir = KEEP ?? tempDir('recruitment-perf');
const reuse = !!KEEP && fs.existsSync(path.join(dir, 'scoutbox.db'));
say(`building ${PLAYERS} players and ${CLONES} recruitment graphs (${BUSY} in the busy club) …`);
let t = t0();
const world = build();
const sizes = Object.fromEntries(Object.entries(world.db).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
say(`  built in memory in ${fmt(since(t))}`);
t = t0();
if (!reuse) { fs.mkdirSync(dir, { recursive: true }); writeFixture(dir, world.db, { now: world.now, idCounter: 1_000_000 }); }
world.db = null; // only the ids are needed from here
const saveMs = since(t);
if (reuse) say(`  reusing the database in ${dir}`);
// sessions are minted through the repository (hashed in the table), as a login would
const tokens = {};
{
  const L = openLayer(dir, { nextId: (p) => `${p}-${Math.random().toString(36).slice(2)}`, sessionTtlMs: 30 * DAY }); const { layer } = L;
  tokens.busy = layer.sessions.create('org', world.busy.id, { userId: world.busyUser }).token;
  tokens.typical = layer.sessions.create('org', world.typical.id, { userId: world.typicalUser }).token;
  if (world.grass) tokens.grass = layer.sessions.create('org', world.grass.id, { userId: world.grassUser }).token;
  tokens.player = layer.sessions.create('player', world.popular.id).token;
  tokens.guardian = layer.sessions.create('guardian', world.guardian).token;
  L.close();
}
const ro = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
const n = (sql, ...p) => ro.prepare(sql).get(...p).n;
const counts = {
  cases: n('SELECT COUNT(*) AS n FROM recruitment_cases'), busyCases: n('SELECT COUNT(*) AS n FROM recruitment_cases WHERE org_id = ?', world.busy.id),
  requests: n('SELECT COUNT(*) AS n FROM recruitment_requests'), busyRequests: n('SELECT COUNT(*) AS n FROM recruitment_requests WHERE org_id = ?', world.busy.id),
  trials: n('SELECT COUNT(*) AS n FROM trials'), contacts: n('SELECT COUNT(*) AS n FROM recruitment_contacts'), offers: n('SELECT COUNT(*) AS n FROM recruitment_offers'),
  signings: n('SELECT COUNT(*) AS n FROM signings'), followUps: n('SELECT COUNT(*) AS n FROM follow_ups'),
  popularCases: n('SELECT COUNT(*) AS n FROM recruitment_cases WHERE player_id = ?', world.popular.id), popularRequests: n('SELECT COUNT(*) AS n FROM recruitment_requests WHERE player_id = ?', world.popular.id),
};
ro.close();
const dbBytes = fs.statSync(path.join(dir, 'scoutbox.db')).size;
say(`  saved through the typed writers in ${fmt(saveMs)}: database ${mb(dbBytes)}`);
say(`  rows: ${counts.cases} cases (${counts.busyCases} in the busy club), ${counts.requests} requests (${counts.busyRequests} busy), ${counts.trials} trials, ${counts.contacts} contacts, ${counts.offers} offers, ${counts.signings} signings, ${counts.followUps} follow-ups`);
say(`  the popular player: ${counts.popularCases} cases, ${counts.popularRequests} requests`);

const S = await boot(dir);
say(`\nboot: ${fmt(S.bootMs)} until the server listens`);
if (process.env.PERF_BOOT_ONLY) { await S.stop(); if (!KEEP) fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }

const room = async (token) => { const r = await S.get('/org/rooms?limit=1', token); return JSON.parse(r.text).items?.[0]?.roomId ?? null; };
const busyRoom = await room(tokens.busy);
const typicalRoom = await room(tokens.typical);
// Matching, a watchlist and Nobody Missed are SQL over the stored facts. A brief and a watchlist are created
// through the routes (the busy club's user must be a lead for the brief; without one, its routes are skipped).
const post = async (route, token, body, method = 'POST') => { const r = await S.get(route, token, { method, body: JSON.stringify(body) }); return { status: r.status, body: r.text ? JSON.parse(r.text) : null }; };
const CM = { required: [{ type: 'position', operator: 'in', values: ['CM', 'CDM'] }], preferred: [] };
const YOUNG = { required: [{ type: 'age', operator: 'between', values: [18, 24] }, { type: 'trust_band', operator: 'gte', value: 'developing_evidence' }], preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }] };
const wl = await post('/org/watchlists', tokens.busy, { name: 'Perf CM', mode: 'snapshot', criteria: CM });
const brief = await post('/org/recruitment-briefs', tokens.busy, { title: 'Perf brief', positions: ['CM'], minAge: 18, maxAge: 30 });
const briefId = brief.status === 201 ? brief.body.brief.id : null;
if (briefId) await post(`/org/recruitment-briefs/${briefId}`, tokens.busy, { status: 'active', expectedRev: brief.body.brief.rev }, 'PATCH');
else say(`  (no brief: ${brief.status} ${JSON.stringify(brief.body).slice(0, 120)})`);
const MATCHING = (who) => [
  { label: `POST /org/matching (CM, ${who})`, path: '/org/matching', body: { criteria: CM } },
  { label: 'POST /org/matching (age, band, name)', path: '/org/matching', body: { criteria: YOUNG, sort: 'name' } },
  { label: 'POST /org/matching (everyone)', path: '/org/matching', body: { criteria: { required: [], preferred: [] } } },
];
const ROUTES = [
  ['busy club', tokens.busy, [...MATCHING('busy'), ...(wl.status === 201 ? [`/org/watchlists/${wl.body.watchlist.id}`] : []), ...(briefId ? [`/org/nobody-missed?briefId=${briefId}`, '/org/evaluation-coverage'] : [])]],
  ...(tokens.grass ? [['grassroots', tokens.grass, MATCHING('grassroots').slice(0, 1)]] : []),
  ['busy club', tokens.busy, ['/org/rooms', '/org/rooms-funnel', '/org/rooms/needs-attention', '/org/rooms/summaries', '/org/cases', '/org/audit', '/org/requests', '/org/trials', '/org/recruitment-counts', '/org/followups', '/org/signings', '/org/recruitment-analytics', '/org/funnel', ...(busyRoom ? [`/org/rooms/${busyRoom}`, `/org/rooms/${busyRoom}/journey`, `/org/rooms/${busyRoom}/activity`, `/org/rooms/${busyRoom}/offers`, `/org/rooms/${busyRoom}/contacts`, `/org/rooms/${busyRoom}/trials`] : [])]],
  ['typical club', tokens.typical, ['/org/rooms', '/org/cases', '/org/audit', '/org/requests', '/org/recruitment-counts', '/org/recruitment-analytics', ...(typicalRoom ? [`/org/rooms/${typicalRoom}`, `/org/rooms/${typicalRoom}/journey`] : [])]],
  // The hot player reads (the directory, similar players, the deck, the feed, the fixtures, the rotation, benchmarks).
  ['busy club', tokens.busy, ['/org/players', '/org/players?academyPlus=true&position=CM', '/org/players?q=player%2012', `/org/players/${world.popular.id}`, `/org/players/${world.popular.id}/morelike`, '/org/filmroom', '/org/feed', '/org/fixtures', '/org/discovery-rotation']],
  ...(tokens.grass ? [['grassroots', tokens.grass, ['/org/players', '/org/filmroom', '/org/feed', '/org/fixtures']]] : []),
  ['popular player', tokens.player, ['/player/benchmarks']],
  ['popular player', tokens.player, ['/player/inbox', '/player/journeys', '/player/trials', '/player/offers', '/player/signings', '/player/followups']],
  ['guardian', tokens.guardian, ['/guardian/inbox', '/guardian/trials', '/guardian/offers']],
];
const results = [];
for (const [who, token, routes] of ROUTES) for (const route of routes) if (!process.env.PERF_ONLY || (typeof route === 'string' ? route : route.path).includes(process.env.PERF_ONLY)) results.push({ who, ...(await timeRoute(S, who, route, token)) });

say(`\nreads (${RUNS} sequential requests each, 5 for a route slower than 500 ms, after 5 warm-up; p50 / p95 / response size)`);
for (const r of results) {
  if (r.status !== 200) { say(`  ${r.who.padEnd(14)} ${r.route.padEnd(44)} HTTP ${r.status} ${r.error}`); continue; }
  const flag = r.p50 >= 5 ? '  ✗ over 5 ms' : '';
  say(`  ${r.who.padEnd(14)} ${r.route.replace(busyRoom ?? '\0', ':id').replace(typicalRoom ?? '\0', ':id').replace(/wl-[a-z0-9-]+/, ':id').replace(/brf-[a-z0-9-]+/, ':id').padEnd(44)} ${fmt(r.p50).padStart(9)} ${fmt(r.p95).padStart(9)} ${(r.bytes / 1000).toFixed(1).padStart(8)} kB${r.runs < RUNS ? ` (${r.runs} runs)` : ''}${flag}`);
}

// one write: a Room comment, and what it adds to the write-ahead log
const wal = () => { try { return fs.statSync(path.join(dir, 'scoutbox.db-wal')).size; } catch { return 0; } };
// A second connection checkpoints and truncates the log, so its size afterwards is what the write added (retried while busy).
const side = new DatabaseSync(path.join(dir, 'scoutbox.db')); side.exec('PRAGMA busy_timeout = 5000');
const truncateWal = () => { for (let i = 0; i < 20; i += 1) { const r = side.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (!r.busy) return true; } return false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (busyRoom) {
  const rooms = JSON.parse((await S.get('/org/rooms?limit=20', tokens.busy)).text).items.map((x) => x.roomId);
  const lat = []; const grew = [];
  for (const id of rooms.slice(0, 10)) {
    await sleep(1500); // space the samples out before measuring
    if (!truncateWal()) { say('  could not truncate the log; skipping'); continue; }
    const before = wal(); const t = t0();
    const r = await S.get(`/org/rooms/${id}/comments`, tokens.busy, { method: 'POST', body: JSON.stringify({ body: 'Synthetic perf comment.' }) });
    lat.push(since(t)); if (r.status !== 201 && r.status !== 200) { say(`  comment refused: ${r.status} ${r.text.slice(0, 200)}`); break; }
    await sleep(1500); grew.push(wal() - before);
  }
  if (lat.length) {
    say(`\nwrite: a Room comment, p50 ${fmt(quantile(lat, 0.5))} (p95 ${fmt(quantile(lat, 0.95))})`);
    say(`  write-ahead log growth per comment, including any debounced save: median ${(quantile(grew, 0.5) / 1000).toFixed(1)} kB, max ${(Math.max(...grew) / 1000).toFixed(1)} kB`);
    say(`  (the database is ${mb(dbBytes)})`);
  }
}
side.close();
await S.stop();

// the every-minute sweeps' queries, on their own connection
{
  const sqlite = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  const rec = createRecruitmentRepository({ sqlite }); const sfu = createSigningsFollowUpsRepository({ sqlite });
  const now = Date.now();
  const time = (label, fn) => { fn(); const xs = []; let rows = 0; for (let i = 0; i < 10; i += 1) { const t = t0(); rows = fn().length; xs.push(since(t)); } say(`  ${label.padEnd(44)} ${fmt(quantile(xs, 0.5)).padStart(9)}  (${rows} rows)`); };
  say('\nsweep queries (median of 10)');
  time('trials: report overdue', () => rec.trials.reportOverdue(now));
  time('trials: reminders due', () => rec.trials.remindersDue(now));
  time('trials: completed, assessment not reminded', () => rec.trials.completedUnreminded(now));
  time('signings: missing follow-ups', () => sfu.signings.missingFollowUps(4));
  time('follow-ups: due to mark', () => sfu.followUps.dueToMark(now));
  time('follow-ups: due, not notified', () => sfu.followUps.dueUnnotified());
  sqlite.close();
}
if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
say(`\ncollections built: ${JSON.stringify(sizes)}`);
