// Staff accounts (with the Founder's two rules on names, docs/decisions.md), against a real server on a temporary
// data directory with the synthetic seed.
//
//   A removal: a lead removes a colleague in one step — the account stays (history attributable), its sessions die,
//     its name no longer signs in, a second removal is refused
//   B re-invite: accepting a new invitation restores the removed account (same id, the invite's role), and it signs in
//   C names: a new account cannot take a name the organisation already has (removed accounts included); the e-mail check
//     on an invite ignores case
//   D MFA: a recovery code works exactly once; the TOTP secret never appears in a staff response
//   E delivery preferences: junk is refused by field, nothing stored; the response is the stored preference
//   F sign-in: an over-long name is refused by field
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../scripts/testPort.mjs';
import { totp } from '../../domains/identity/totp.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-staff-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };

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
const j = async (method, pathname, body, token, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (scoutName, role) => {
  const r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName, role });
  ok(r.status === 200, `${scoutName} signs in`);
  return r.body;
};
const inviteCodeFor = async (to) =>
  (await j('GET', '/admin/outbox', undefined, null, ADMIN)).body.items
    .filter((m) => m.to === to)
    .at(0)
    ?.text.match(/invite code: ([0-9a-f]+)/)?.[1];

child = spawn('node', ['server.mjs'], {
  cwd: SERVER_DIR,
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

const maria = await login('Maria Keane', 'Head of Recruitment');
const tom = await login('Tom Reid', 'Scout');

section('A — removal');
let r = await j('POST', `/org/staff/${tom.userId}/remove`, {}, maria.token);
ok(
  r.status === 200 && r.body.removed.id === tom.userId && Number.isInteger(r.body.removed.removedAt),
  'the lead removes the scout and the reply carries the stored removal time',
);
r = await j('GET', '/org/staff', undefined, tom.token);
neg(r.status === 401 && r.body.error === 'ORG_AUTH_REQUIRED', "the removed scout's session is gone");
r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'tom reid', role: 'Scout' });
neg(r.status === 403 && r.body.error === 'USER_REMOVED', 'the removed name no longer signs in, whatever its case');
r = await j('POST', `/org/staff/${tom.userId}/remove`, {}, maria.token);
neg(r.status === 409 && r.body.error === 'ALREADY_REMOVED', 'a second removal is refused');
r = await j('GET', '/org/staff', undefined, maria.token);
const tomRow = r.body.find((u) => u.id === tom.userId);
ok(
  !!tomRow &&
    tomRow.removedAt !== null &&
    JSON.stringify(Object.keys(tomRow)) === JSON.stringify(['id', 'name', 'role', 'lead', 'removedAt']),
  'the account stays listed, removed, as an allowlist',
);

section('B — re-invite restores the removed account');
r = await j(
  'POST',
  '/org/invites',
  { email: 'tom.reid@eastport.example', name: 'Tom Reid', role: 'Senior Scout' },
  maria.token,
);
ok(r.status === 201, 'the lead invites Tom again');
let code = await inviteCodeFor('tom.reid@eastport.example');
ok(!!code, 'the invitation went to the outbox');
r = await j('POST', '/auth/org/accept-invite', { token: code });
ok(
  r.status === 201 && r.body.userId === tom.userId && r.body.restored === true && r.body.role === 'Senior Scout',
  "accepting restores the same account with the invite's role",
);
const back = await login('Tom Reid'); // no role: on a demo club a sign-in's role would replace the stored one (the development shortcut)
ok(
  back.userId === tom.userId && back.role === 'Senior Scout' && !back.mfaSetupRequired,
  'Tom signs in by name again, as the same account',
);

section('C — names and e-mails');
r = await j(
  'POST',
  '/org/invites',
  { email: 'TOM.REID@eastport.example', name: 'Another Tom', role: 'Scout' },
  maria.token,
);
neg(r.status === 409 && r.body.error === 'ALREADY_STAFF', "the invite's e-mail check ignores case");
r = await j(
  'POST',
  '/org/invites',
  { email: 'newcomer@eastport.example', name: 'Newcomer', role: 'Scout' },
  maria.token,
);
code = await inviteCodeFor('newcomer@eastport.example');
r = await j('POST', '/auth/org/accept-invite', { token: code, scoutName: 'MARIA KEANE' });
neg(r.status === 409 && r.body.error === 'STAFF_NAME_TAKEN', 'accepting under a name a colleague has is refused');
r = await j('POST', '/auth/org/accept-invite', { token: code, scoutName: 'Newcomer' });
ok(
  r.status === 201 && r.body.userId !== maria.userId,
  "the same invitation is still usable under a name of one's own (the refusal wrote nothing)",
);

section('D — MFA');
const setup = await j('POST', '/org/mfa/setup', {}, back.token);
ok(setup.status === 200 && typeof setup.body.secret === 'string', 'set-up shows the secret once');
r = await j('POST', '/org/mfa/verify', { code: totp(setup.body.secret) }, back.token);
ok(r.status === 200 && r.body.recoveryCodes.length === 10, 'confirming gives ten recovery codes');
const recovery = r.body.recoveryCodes[0];
r = await j('GET', '/org/staff', undefined, back.token);
neg(!JSON.stringify(r.body).includes(setup.body.secret), 'the staff list carries no secret');
r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Reid', recoveryCode: recovery });
ok(r.status === 200 && r.body.userId === tom.userId, 'a recovery code signs in once');
r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Reid', recoveryCode: recovery });
neg(r.status === 401 && r.body.error === 'MFA_CODE_WRONG', 'the same recovery code never works again');
const tomMfa = (
  await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Reid', mfaCode: totp(setup.body.secret) })
).body;
ok(!!tomMfa.token, 'the authenticator code signs in');

section('E — delivery preferences');
for (const [body, field] of [
  [{ email: 'no' }, 'email'],
  [{ email: 0 }, 'email'],
  [{ quietStart: '25:00' }, 'quietStart'],
  [{ quietEnd: { h: 7 } }, 'quietEnd'],
]) {
  r = await j('PUT', '/org/delivery/prefs', body, maria.token);
  neg(
    r.status === 400 && r.body.error === 'FIELD_INVALID' && r.body.field === field,
    `junk ${JSON.stringify(body)} is refused naming ${field}`,
  );
}
r = await j('PUT', '/org/delivery/prefs', { quietStart: '22:00', quietEnd: '07:00', email: false }, maria.token);
ok(
  r.status === 200 &&
    JSON.stringify(r.body.prefs) ===
      JSON.stringify({ quietStart: '22:00', quietEnd: '07:00', channels: { email: false } }),
  'the reply is the stored preference',
);
r = await j('PUT', '/org/delivery/prefs', {}, maria.token);
ok(
  r.status === 200 && r.body.prefs.channels.email === true && r.body.prefs.quietStart === null,
  'an empty write resets to the defaults',
);

section('F — sign-in');
r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'x'.repeat(121), role: 'Scout' });
neg(
  r.status === 400 && r.body.error === 'FIELD_INVALID' && r.body.field === 'scoutName',
  'an over-long name is refused by field, nothing created',
);

console.log(`\nplatform/staff: ${passed} checks passed, ${negatives} negative, 0 failed`);
cleanup();
process.exit(0);
