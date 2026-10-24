// REVIEW-ONLY reproduction (S4 preparation, docs/architecture/s4-deletion-decision.md §2):
// after a shortlisted player deletes their account, GET /org/shortlist dereferences the
// missing player (server.mjs: playerViewForOrg(findPlayer(id), org) on a ledger-derived id).
// Boots the real server from the seed on a throwaway DATA_DIR with dev logins (the default
// outside production), then prints VERIFIED or NOT_REPRODUCED. Touches no real data; not part
// of npm test.
//   node scripts/review/reproShortlistAfterDeletion.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from '../../seed.mjs';
import { isAdult } from '../../domain.mjs';
import { pickPort } from '../testPort.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-repro-shortlist-'));
const port = pickPort(7900, 100);
const proc = spawn(process.execPath, [path.join(HERE, '..', '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
await new Promise((resolve, reject) => { proc.stdout.on('data', () => { if (/listening on/.test(log)) resolve(); }); proc.on('exit', (c) => reject(new Error(`server exited ${c}: ${log}`))); setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000); });
const j = async (method, p, body, token) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let parsed = null; try { parsed = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: parsed };
};
try {
  const seed = buildSeed();
  const adult = seed.players.find((p) => isAdult(p) && !p.guardianId && !p.password);
  const org = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' });
  const shortlisted = await j('POST', `/org/players/${adult.id}/shortlist`, {}, org.body.token);
  const before = await j('GET', '/org/shortlist', undefined, org.body.token);
  const player = await j('POST', '/auth/player/login', { playerId: adult.id });
  const deleted = await j('DELETE', '/player/account', undefined, player.body.token);
  const after = await j('GET', '/org/shortlist', undefined, org.body.token);
  const threw = /TypeError: Cannot read properties of null \(reading 'id'\)/.test(log) || /Cannot read properties of null/.test(log);
  const result = {
    player: adult.id, shortlistStatus: shortlisted.status, shortlistBefore: before.status, shortlistCountBefore: Array.isArray(before.body) ? before.body.length : null,
    deleteStatus: deleted.status, shortlistAfter: after.status, serverLoggedTypeError: threw,
    verdict: after.status >= 500 || threw ? 'VERIFIED: /org/shortlist fails after a shortlisted player deletes their account' : `NOT_REPRODUCED: /org/shortlist answered ${after.status}`,
  };
  console.log(JSON.stringify(result, null, 2));
  const errLine = log.split('\n').find((l) => /TypeError/.test(l));
  if (errLine) console.log('server log:', errLine.trim());
} finally {
  await new Promise((resolve) => { proc.on('exit', () => resolve()); proc.kill('SIGTERM'); });
  fs.rmSync(dir, { recursive: true, force: true });
}
