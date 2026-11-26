// Latency of the hot paths, with the synthetic population of dev/perf_population.mjs (once the TypeScript server's
// scripts/perfPopulation.mjs) written as plain SQL into the server's own migrated database:
//   - GET /org/players/:id (the org player view: visibility, blocks, the record and its lists, a ledger write)
//   - POST /admin/reports/:id/resolve (the resolution unit: the report, the organisation, the reporter's notice)
// Each is timed one request at a time, then with 32 concurrent clients.
//   gleam export erlang-shipment && node dev/perf.mjs [players=10000]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GL = path.resolve(HERE, '..');
const { syntheticPopulation } = await import(path.join(HERE, 'perf_population.mjs'));
const PLAYERS = Number(process.argv[2] ?? 10000);
const REPORTS = 3000;
const SEQUENTIAL = 1000;
const CONCURRENT = { clients: 32, requests: 2000 };

const servers = {
  gleam: { cmd: path.join(GL, 'build/erlang-shipment/entrypoint.sh'), args: ['run'], cwd: GL },
};

async function boot(server, data, port) {
  const child = spawn(server.cmd, server.args, {
    cwd: server.cwd,
    env: { ...process.env, PORT: String(port), DATA_DIR: data, SCOUTBOX_QUIET_LOGS: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) break;
    } catch {}
    if (i > 240) throw new Error('did not boot');
    await new Promise((r) => setTimeout(r, 250));
  }
  return child;
}
const stop = (child) => new Promise((r) => (child.once('exit', r), child.kill('SIGTERM')));

/** The population as rows. */
function populate(file, now) {
  const pop = syntheticPopulation({ players: PLAYERS, now });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF; BEGIN');
  const ins = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...cols.map((c) => row[c]),
    );
  };
  const b = (v) => (v ? 1 : 0);
  for (const o of pop.orgs)
    ins('orgs', {
      id: o.id,
      name: o.name,
      type: o.type,
      level: o.level,
      plan: o.plan,
      country: o.country,
      city: o.location.city,
      lat: o.location.lat,
      lng: o.location.lng,
      verified: b(o.verified),
      safeguarding_contract_signed: b(o.safeguardingContractSigned),
      trusted_partner: 0,
      created_at: now,
    });
  for (const g of pop.guardians)
    ins('guardians', {
      id: g.id,
      name: g.name,
      email: g.email,
      email_verified: 1,
      id_verified: 1,
      disclaimer_accepted: 1,
      created_at: now,
    });
  for (const p of pop.players) {
    const complete = !!(p.position && p.foot && p.heightCm && p.weightKg && p.stats);
    const signal = Math.min(99, 30 + (p.identityVerified ? 10 : 0) + 5 + 2 + (complete ? 5 : 0));
    ins('players', {
      id: p.id,
      name: p.name,
      birth_date: p.dob,
      country: p.country,
      city: p.city,
      position: p.position,
      foot: p.foot,
      height_cm: p.heightCm,
      weight_kg: p.weightKg,
      academy_plus: b(p.academyPlus),
      availability: p.availability,
      contract_status: p.contractStatus,
      level: p.level,
      identity_verified: b(p.identityVerified),
      guardian_id: p.guardianId,
      lat: p.location.lat,
      lng: p.location.lng,
      stats_appearances: p.stats.appearances,
      stats_goals: p.stats.goals,
      stats_assists: p.stats.assists,
      stats_pace_kmh: p.stats.paceKmh,
      stats_pass_completion_pct: p.stats.passCompletionPct,
      stats_duel_success_pct: p.stats.duelSuccessPct,
      profile_signal: signal,
      created_at: p.createdAt,
    });
    if (p.guardianId) ins('guardian_children', { guardian_id: p.guardianId, player_id: p.id, role: 'primary' });
    const a = p.attendance[0];
    ins('player_attendance', {
      id: a.id,
      player_id: p.id,
      position: 0,
      fixture: a.fixture,
      venue: a.venue,
      match_date: a.date,
      lat: a.gps.lat,
      lng: a.gps.lng,
      verified: 1,
    });
    const m = p.media[0];
    ins('player_media', {
      id: m.id,
      player_id: p.id,
      position: 0,
      title: m.title,
      kind: m.kind,
      uploaded_at: m.uploadedAt,
      url: m.url,
      views: m.views,
    });
    ins('player_timeline', { player_id: p.id, position: 0, year: '2024', event: 'Joined' });
    ins('player_badges', { player_id: p.id, position: 0, badge: 'Fresh Start' });
    ins('player_season_history', {
      player_id: p.id,
      position: 0,
      season: '2024/25',
      appearances: 20,
      goals: 3,
      assists: 2,
    });
    p.activityLog.forEach((t, i) => ins('player_activity_log', { player_id: p.id, position: i, occurred_at: t }));
  }
  for (let k = 0; k < REPORTS; k++)
    ins('reports', {
      id: `rep-perf-${k}`,
      created_at: now - k,
      by_kind: 'player',
      by_id: `pl-${3 * k + 1}`,
      target_kind: 'club',
      target_org_id: `org-${k % pop.orgs.length}`,
      reason: 'Synthetic.',
      urgent: 0,
      status: 'pending_review',
    });
  db.exec('COMMIT');
  db.close();
  return pop;
}

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
async function timed(fn) {
  const t = performance.now();
  const r = await fn();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  await r.arrayBuffer();
  return performance.now() - t;
}
async function measure(label, count, clients, request) {
  const times = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async () => {
      for (let i = next++; i < count; i = next++) times.push(await timed(() => request(i)));
    }),
  );
  const secs = (performance.now() - start) / 1000;
  return { label, p50: percentile(times, 50), p95: percentile(times, 95), rps: count / secs };
}

const results = [];
for (const [name, server] of Object.entries(servers)) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `perf-${name}-`));
  const port = 23000 + Math.floor(Math.random() * 5000);
  const base = `http://localhost:${port}`;
  await stop(await boot(server, data, port));
  const pop = populate(path.join(data, 'scoutbox.db'), Date.now());
  const child = await boot(server, data, port);
  try {
    const login = await fetch(`${base}/auth/org/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'org-3', scoutName: 'Perf Scout', role: 'Head of Recruitment' }),
    });
    const { token } = await login.json();
    const auth = { authorization: `Bearer ${token}` };
    const admin = { 'content-type': 'application/json', 'x-admin-key': 'scoutbox-admin' };
    // org-3 is a verified pro club: it sees every player, minors included.
    const view = (i) => fetch(`${base}/org/players/pl-${(i * 7919) % PLAYERS}`, { headers: auth });
    let report = 0;
    const resolve = () =>
      fetch(`${base}/admin/reports/rep-perf-${report++}/resolve`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ outcome: 'Reviewed.', action: 'none' }),
      });
    for (let i = 0; i < 50; i++) await (await view(i)).arrayBuffer(); // warm up
    results.push({ server: name, ...(await measure('org player view, one at a time', SEQUENTIAL, 1, view)) });
    results.push({
      server: name,
      ...(await measure(
        `org player view, ${CONCURRENT.clients} clients`,
        CONCURRENT.requests,
        CONCURRENT.clients,
        view,
      )),
    });
    const directory = (i) =>
      fetch(`${base}/org/players?limit=20&position=${['GK', 'CB', 'CM', 'ST', 'LW'][i % 5]}`, { headers: auth });
    results.push({ server: name, ...(await measure('directory page of 20, one at a time', SEQUENTIAL, 1, directory)) });
    results.push({
      server: name,
      ...(await measure(
        `directory page of 20, ${CONCURRENT.clients} clients`,
        CONCURRENT.requests,
        CONCURRENT.clients,
        directory,
      )),
    });
    results.push({ server: name, ...(await measure('report resolution, one at a time', SEQUENTIAL, 1, resolve)) });
    results.push({
      server: name,
      ...(await measure(
        `report resolution, ${CONCURRENT.clients} clients`,
        REPORTS - SEQUENTIAL - 50,
        CONCURRENT.clients,
        resolve,
      )),
    });
    void pop;
  } finally {
    await stop(child);
    fs.rmSync(data, { recursive: true, force: true });
  }
}
console.log(`\n${PLAYERS} players, ${os.cpus().length} cores (${os.cpus()[0].model})\n`);
console.log('server      | measurement                         |   p50 ms |   p95 ms |  req/s');
for (const r of results)
  console.log(
    `${r.server.padEnd(11)} | ${r.label.padEnd(35)} | ${r.p50.toFixed(2).padStart(8)} | ${r.p95.toFixed(2).padStart(8)} | ${r.rps.toFixed(0).padStart(6)}`,
  );
