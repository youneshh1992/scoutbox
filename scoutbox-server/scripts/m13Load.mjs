// Bounded local load test — ISOLATED database, agreed-in-code limits.
// Reports exactly what was run. Local development numbers only: they say the
// code path holds together under modest concurrency, not what production
// hardware would do, and they claim no SLA.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 4600 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-load-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

const TOTAL_REQUESTS = 600;   // agreed in code — bounded
const CONCURRENCY = 12;       // agreed in code — bounded

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { } await sleep(250); }

const login = await (await fetch(`${BASE}/auth/org/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Load Tester', role: 'Head of Recruitment' }) })).json();
const H = { Authorization: `Bearer ${login.token}` };
const playerLogin = await (await fetch(`${BASE}/auth/player/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: 'pl-adeyemi' }) })).json();
const HP = { Authorization: `Bearer ${playerLogin.token}` };

// Mixed, realistic read-heavy workload with some writes.
const OPS = [
  () => fetch(`${BASE}/org/players`, { headers: H }),
  () => fetch(`${BASE}/org/players/pl-svensson`, { headers: H }),
  () => fetch(`${BASE}/org/review-queue`, { headers: H }),
  () => fetch(`${BASE}/org/coverage/assignments`, { headers: H }),
  () => fetch(`${BASE}/org/opportunities`, { headers: H }),
  () => fetch(`${BASE}/player/me`, { headers: HP }),
  () => fetch(`${BASE}/player/exposure`, { headers: HP }),
  () => fetch(`${BASE}/healthz`),
  () => fetch(`${BASE}/org/exposure/impressions`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ playerIds: ['pl-svensson'] }) }),
  () => fetch(`${BASE}/player/preferences`, { headers: HP }),
];

const durations = [];
let errors = 0;
let sent = 0;
const t0 = Date.now();
async function worker() {
  while (sent < TOTAL_REQUESTS) {
    const op = OPS[sent % OPS.length];
    sent++;
    const s = performance.now();
    try {
      const r = await op();
      if (r.status >= 500) errors++;
      await r.arrayBuffer();
    } catch { errors++; }
    durations.push(performance.now() - s);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const wallMs = Date.now() - t0;

durations.sort((a, b) => a - b);
const pct = (p) => Math.round(durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))]);
console.log(JSON.stringify({
  environment: 'local container, single node process, isolated throwaway SQLite-snapshot DB (seeded: 14 players, 5 orgs)',
  dataset: 'seed data only — NOT production scale',
  totalRequests: TOTAL_REQUESTS, concurrency: CONCURRENCY,
  wallSeconds: Math.round(wallMs / 100) / 10,
  throughputRps: Math.round((TOTAL_REQUESTS / wallMs) * 1000),
  latencyMs: { p50: pct(50), p90: pct(90), p99: pct(99), max: Math.round(durations.at(-1)) },
  errors5xxOrNetwork: errors,
  honesty: 'A bounded smoke of the request path on one machine. It demonstrates no capacity claim, no SLA, and nothing about production hardware or real datasets.',
}, null, 2));
proc.kill('SIGTERM');
process.exit(errors > 0 ? 1 : 0);
