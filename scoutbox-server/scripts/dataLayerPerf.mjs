// Synthetic performance measurement for the data layer (plan step S1).
//
// Builds a snapshot of N organisations, guardians, players and sessions in
// the exact shapes the server writes, then measures on a throwaway database:
//   1. the blob save alone (what every persistNow() costs today),
//   2. the blob save with the shadow projection inside it (what S1 adds),
//   3. a point lookup of a session by token hash against the table versus the
//      linear scan the server does on every request today.
// Usage: node scripts/dataLayerPerf.mjs [players=10000] [sessions=20000]
// Nothing here touches DATA_DIR.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';

const PLAYERS = Number(process.argv[2]) || 10_000;
const SESSIONS = Number(process.argv[3]) || 20_000;
const ORGS = Math.max(10, Math.round(PLAYERS / 20));
const GUARDIANS = Math.round(PLAYERS / 3);
const DAY = 86_400_000;
const now = Date.now();
const pick = (arr, i) => arr[i % arr.length];

function build() {
  const orgs = Array.from({ length: ORGS }, (_, i) => ({
    id: `org-${i}`, name: `Club ${i}`, type: i % 7 === 0 ? 'agency' : 'club', level: i % 7 === 0 ? 'agency' : pick(['pro', 'academy', 'grassroots'], i),
    plan: i % 7 === 0 ? 'Agency' : pick(['Pro', 'Academy', 'Grassroots'], i), country: 'GB', location: { lat: 51 + i / 1000, lng: -1 + i / 1000, city: `Town ${i}` },
    verified: i % 3 === 0, safeguardingContractSigned: i % 3 === 0, trustedPartner: false, password: 'scrypt$ab$cd',
  }));
  const users = Array.from({ length: ORGS * 3 }, (_, i) => ({ id: `usr-${i}`, orgId: `org-${i % ORGS}`, name: `Staff ${i}`, role: i % 3 ? 'Scout' : 'Head of Recruitment', createdAt: now - i * 1000 }));
  const guardians = Array.from({ length: GUARDIANS }, (_, i) => ({ id: `gd-${i}`, name: `Guardian ${i}`, email: `g${i}@example.com`, emailVerified: true, idVerified: true, disclaimerAccepted: true, childIds: [] }));
  const players = Array.from({ length: PLAYERS }, (_, i) => {
    const minor = i % 3 === 0;
    const guardianId = minor ? `gd-${i % GUARDIANS}` : null;
    if (guardianId) guardians[i % GUARDIANS].childIds.push(`pl-${i}`);
    return {
      id: `pl-${i}`, name: `Player ${i}`, dob: minor ? '2011-05-05' : '1999-05-05', country: pick(['GB', 'PT', 'FR', 'NG'], i), city: `Town ${i % ORGS}`,
      position: pick(['GK', 'CB', 'CM', 'ST', 'LW'], i), foot: pick(['left', 'right'], i), heightCm: 160 + (i % 30), weightKg: 55 + (i % 30),
      stats: { appearances: i % 40, goals: i % 15, assists: i % 9, paceKmh: 28 + (i % 7), passCompletionPct: 60 + (i % 35), duelSuccessPct: 40 + (i % 50) },
      seasonHistory: [{ season: '2024/25', appearances: 20, goals: 3, assists: 2 }], academyPlus: i % 5 === 0, badges: ['Fresh Start'],
      availability: pick(['available_now', 'end_of_season', 'not_seeking'], i), contractStatus: 'unknown', identityVerified: i % 2 === 0,
      attendance: [{ id: `att-${i}`, fixture: 'Match', venue: 'Ground', date: '2026-09-01', gps: { lat: 51.5, lng: -0.1 }, verified: true }],
      timeline: [{ year: '2024', event: 'Joined' }], media: [{ id: `media-${i}`, title: 'Clip', kind: 'video', uploadedAt: new Date(now).toISOString(), url: null, views: 0, tags: {}, verifiedClip: null }],
      trialReports: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, guardianId, drills: [], drillResults: [],
      activityLog: [now - DAY, now], createdAt: now - (i % 60) * DAY, password: minor ? null : 'scrypt$ab$cd', level: 'amateur', location: { lat: 51.5, lng: -0.1 },
    };
  });
  const sessions = Array.from({ length: SESSIONS }, (_, i) => {
    const kind = pick(['player', 'org', 'guardian'], i);
    return { token: crypto.randomBytes(24).toString('hex'), sid: crypto.randomBytes(6).toString('hex'), kind, refId: kind === 'player' ? `pl-${i % PLAYERS}` : kind === 'org' ? `org-${i % ORGS}` : `gd-${i % GUARDIANS}`, ...(kind === 'org' ? { userId: `usr-${i % (ORGS * 3)}` } : {}), createdAt: now - (i % 20) * DAY };
  });
  return { orgs, users, guardians, players, sessions, ledger: [], notifications: [] };
}

const timed = (fn) => { const t = process.hrtime.bigint(); const out = fn(); return { ms: Number(process.hrtime.bigint() - t) / 1e6, out }; };
const median = (fn, n = 5) => { const xs = Array.from({ length: n }, () => timed(fn).ms).sort((a, b) => a - b); return xs[Math.floor(n / 2)]; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-'));
const db = build();
const blobBytes = Buffer.byteLength(JSON.stringify(db));
const store = openStore(dir, { tableBacked: TABLE_BACKED });
const layer = attachDataLayer({ db, store, nextId: (p) => `${p}-${Math.random()}`, persist: () => {}, sessionTtlMs: 30 * DAY });

const snapshot = () => ({ savedAt: Date.now(), idCounter: 1000, db });
store.setProjection(null);
const blobOnly = median(() => store.save(snapshot()));
store.setProjection((d) => layer.shadow.project(d));
const withShadow = median(() => store.save(snapshot()));
const projectionOnly = layer.shadow.last().durationMs;

const wanted = db.sessions[Math.floor(SESSIONS / 2)].token;
const hash = crypto.createHash('sha256').update(wanted).digest('hex');
const scan = median(() => db.sessions.find((s) => s.token === wanted), 50);
const stmt = store.sqlite.prepare('SELECT kind, ref_id FROM sessions WHERE token_hash = ?');
const lookup = median(() => stmt.get(hash), 50);

const report = layer.report().shadow;
console.log(`synthetic snapshot: ${ORGS} orgs, ${ORGS * 3} staff, ${GUARDIANS} guardians, ${PLAYERS} players, ${SESSIONS} sessions, ${(blobBytes / 1e6).toFixed(1)} MB of JSON`);
console.log(`blob save alone (every persistNow today)      ${blobOnly.toFixed(1)} ms (median of 5)`);
console.log(`blob save with the S1 shadow projection       ${withShadow.toFixed(1)} ms (median of 5)`);
console.log(`  of which the projection itself              ${projectionOnly} ms (last run)`);
console.log(`session lookup, linear scan over the array    ${(scan * 1000).toFixed(1)} µs`);
console.log(`session lookup, table by token hash           ${(lookup * 1000).toFixed(1)} µs`);
console.log(`shadow reconciliation: ${Object.entries(report.tables).map(([t, r]) => `${t} ${r.tableRows}/${r.snapshotRows}${r.skipped ? ` (${r.skipped} refused)` : ''}`).join(', ')}`);
console.log(`database file: ${(fs.statSync(path.join(dir, 'scoutbox.db')).size / 1e6).toFixed(1)} MB`);
store.sqlite.close();
fs.rmSync(dir, { recursive: true, force: true });
