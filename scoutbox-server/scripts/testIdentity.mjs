// Unit tests for the identity hardening: the single lead-role rule, reverse-
// proxy trust parsing and its effect on req.ip, and the capability/boot
// reporting of both. Run with: npm test (from scoutbox-server/).
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isLeadRole, isLeadUser, LEAD_ROLE_PATTERN, isFinanceRole, isFinanceUser } from '../roles.mjs';
import { parseTrustProxy } from '../httpTrust.mjs';
import { buildCapabilityReport, demoSeedEnabled, devLoginsEnabled, liveMailConfigured, livePushConfigured, MEDIA_SECRET_MIN_LENGTH, productionConfigProblems, UNIMPLEMENTED_PROVIDER_VARIABLES } from '../m181/capabilities.mjs';
import { createBilling, createIdvProvider, createStorage } from '../adapters.mjs';
import { buildSeed } from '../seed.mjs';
import { pickPort } from './testPort.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ------------------------------------------------------------- roles.mjs
await test('lead tier: Head / Director / Lead / Manager / Owner / Chief, case-insensitive', () => {
  for (const role of ['Head of Recruitment', 'Director', 'Managing Director', 'Recruitment Lead', 'owner', 'CHIEF SCOUT', 'Team Manager']) {
    assert.equal(isLeadRole(role), true, role);
  }
});
await test('lead tier: scouts, coaches, assistants and agents are not leads', () => {
  for (const role of ['Scout', 'First-Team Scout', 'Head Coach'.replace('Head ', ''), 'Assistant', 'Agent', 'Analyst', '']) {
    assert.equal(isLeadRole(role), false, role || '(empty)');
  }
});
await test('lead tier: a missing role or user is never a lead', () => {
  assert.equal(isLeadRole(null), false);
  assert.equal(isLeadRole(undefined), false);
  assert.equal(isLeadUser(null), false);
  assert.equal(isLeadUser({}), false);
  assert.equal(isLeadUser({ role: 'Manager' }), true);
});
await test('lead tier: the exported pattern is the documented one', () => {
  assert.equal(LEAD_ROLE_PATTERN.source, 'head|director|lead|manager|owner|chief');
  assert.equal(LEAD_ROLE_PATTERN.flags, 'i');
});
await test('finance tier: every lead plus finance and treasurer roles see deal amounts', () => {
  for (const role of ['Head of Recruitment', 'Director', 'Finance Officer', 'Head of Finance', 'Club Treasurer', 'treasurer']) {
    assert.equal(isFinanceRole(role), true, role);
  }
  for (const role of ['Scout', 'First-Team Scout', 'Analyst', 'Assistant', 'Agent', '', null, undefined]) {
    assert.equal(isFinanceRole(role), false, String(role));
  }
  assert.equal(isFinanceUser({ role: 'Treasurer' }), true);
  assert.equal(isFinanceUser(null), false);
});
await test('finance tier: m13 canViewFinance is the roles.mjs rule, not a copy', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../m13/shared.mjs', import.meta.url), 'utf8');
  assert.match(src, /const canViewFinance = isFinanceUser;/);
});

// ---------------------------------------------------------- httpTrust.mjs
await test('trust proxy: unset, empty, 0, false and off trust nothing', () => {
  for (const v of [undefined, null, '', '  ', '0', 'false', 'off', 'no', 'FALSE']) {
    const out = parseTrustProxy(v);
    assert.equal(out.setting, false, String(v));
    assert.equal(out.state, 'not_configured', String(v));
  }
});
await test('trust proxy: a hop count becomes a number', () => {
  assert.deepEqual([parseTrustProxy('1').setting, parseTrustProxy('2').setting, parseTrustProxy(' 3 ').setting], [1, 2, 3]);
  assert.equal(parseTrustProxy('1').state, 'configured');
  assert.match(parseTrustProxy('1').note, /1 proxy hop/);
});
await test('trust proxy: true trusts every hop and says it is spoofable without a stripping proxy', () => {
  assert.equal(parseTrustProxy('true').setting, true);
  assert.match(parseTrustProxy('true').note, /spoofable/);
});
await test('trust proxy: keywords, addresses and subnets pass through as the Express list form', () => {
  assert.equal(parseTrustProxy('loopback').setting, 'loopback');
  assert.equal(parseTrustProxy('loopback, 10.0.0.0/8').setting, 'loopback, 10.0.0.0/8');
  assert.equal(parseTrustProxy('172.16.0.1').setting, '172.16.0.1');
  assert.equal(parseTrustProxy('::1').setting, '::1');
  assert.equal(parseTrustProxy('2001:db8::/32, linklocal').setting, '2001:db8::/32, linklocal');
});
await test('trust proxy: anything else is invalid and trusts nothing', () => {
  for (const v of ['fly', '10.0.0.0/33', '2001:db8::/129', '1.2.3', 'loopback, fly', '10.0.0.0/8/1', '-1', '1.5']) {
    const out = parseTrustProxy(v);
    assert.equal(out.state, 'invalid', v);
    assert.equal(out.setting, false, v);
  }
});

// Express honours the parsed setting: with one trusted hop the client address
// comes from X-Forwarded-For; with nothing trusted the header is ignored.
async function ipSeenBy(setting, headers) {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
    return (await res.json()).ip;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
await test('req.ip: with SCOUTBOX_TRUST_PROXY=1 the forwarded client address is used', async () => {
  assert.equal(await ipSeenBy(parseTrustProxy('1').setting, { 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
});
await test('req.ip: with one hop trusted, only the last forwarded address counts (a client cannot prepend its own)', async () => {
  assert.equal(await ipSeenBy(parseTrustProxy('1').setting, { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' }), '203.0.113.9');
});
await test('req.ip: with nothing trusted the forwarded header is ignored', async () => {
  assert.ok(isLoopback(await ipSeenBy(parseTrustProxy('').setting, { 'x-forwarded-for': '203.0.113.9' })));
});
await test('req.ip: an invalid value behaves like nothing trusted', async () => {
  assert.ok(isLoopback(await ipSeenBy(parseTrustProxy('fly').setting, { 'x-forwarded-for': '203.0.113.9' })));
});

// ------------------------------------------------- m181/capabilities.mjs
const PROD = { NODE_ENV: 'production', MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef', ADMIN_KEY: 'a-long-production-admin-key-0123' };
await test('boot: a test IdP secret on a production instance is fatal', () => {
  const problems = productionConfigProblems({ env: { ...PROD, TEST_IDP_SECRET: 'copied-from-dev' }, trustWeightsTotal: 100 });
  assert.ok(problems.some((p) => p.code === 'TEST_IDP_IN_PRODUCTION' && p.fatal));
});
await test('boot: the same secret in development is not a problem', () => {
  assert.equal(productionConfigProblems({ env: { TEST_IDP_SECRET: 'x' }, trustWeightsTotal: 100 }).length, 0);
});
await test('boot: an invalid SCOUTBOX_TRUST_PROXY is fatal in production, silent in development', () => {
  assert.ok(productionConfigProblems({ env: { ...PROD, SCOUTBOX_TRUST_PROXY: 'fly' }, trustWeightsTotal: 100 }).some((p) => p.code === 'TRUST_PROXY_INVALID' && p.fatal));
  assert.equal(productionConfigProblems({ env: { SCOUTBOX_TRUST_PROXY: 'fly' }, trustWeightsTotal: 100 }).length, 0);
});
await test('boot: a valid hop count or an unset value raises nothing', () => {
  assert.equal(productionConfigProblems({ env: { ...PROD, SCOUTBOX_TRUST_PROXY: '1' }, trustWeightsTotal: 100 }).length, 0);
  assert.equal(productionConfigProblems({ env: PROD, trustWeightsTotal: 100 }).length, 0);
});
await test('capabilities: proxy trust is reported as a state with a plain-language note, never the raw value', () => {
  const off = buildCapabilityReport({ env: {} }).capabilities.proxy_trust;
  assert.equal(off.state, 'not_configured');
  assert.match(off.note, /share the proxy/);
  const on = buildCapabilityReport({ env: { SCOUTBOX_TRUST_PROXY: '10.0.0.0/8' } }).capabilities.proxy_trust;
  assert.equal(on.state, 'configured');
  assert.deepEqual(Object.keys(on).sort(), ['note', 'state']);
});
await test('capabilities: staff SSO is test_only in development and not_configured in production', () => {
  assert.equal(buildCapabilityReport({ env: {} }).capabilities.staff_sso.state, 'test_only');
  assert.equal(buildCapabilityReport({ env: { NODE_ENV: 'production' } }).capabilities.staff_sso.state, 'not_configured');
  assert.equal(buildCapabilityReport({ env: { NODE_ENV: 'production', ALLOW_DEV_LOGINS: '1' } }).capabilities.staff_sso.state, 'not_configured', 'no production override');
});
await test('boot: ALLOW_DEV_LOGINS on a production instance is fatal, whatever its value, and harmless in development', () => {
  for (const value of ['1', 'true', '0']) {
    assert.ok(productionConfigProblems({ env: { ...PROD, ALLOW_DEV_LOGINS: value }, trustWeightsTotal: 100 }).some((p) => p.code === 'DEV_LOGIN_IN_PRODUCTION' && p.fatal), value);
  }
  assert.equal(productionConfigProblems({ env: { ...PROD, ALLOW_DEV_LOGINS: '' }, trustWeightsTotal: 100 }).length, 0, 'an empty value (.env.example) is unset');
  assert.equal(productionConfigProblems({ env: { ALLOW_DEV_LOGINS: '1' }, trustWeightsTotal: 100 }).length, 0);
});
await test('boot: production needs MEDIA_SECRET of 32+ characters; the old SCOUTBOX_MEDIA_SECRET name does not count', () => {
  const { MEDIA_SECRET: _m, ...noSecret } = PROD;
  const fatal = (env) => productionConfigProblems({ env, trustWeightsTotal: 100 }).some((p) => p.code === 'MEDIA_SECRET_MISSING' && p.fatal);
  assert.ok(fatal(noSecret));
  assert.ok(fatal({ ...noSecret, SCOUTBOX_MEDIA_SECRET: PROD.MEDIA_SECRET }), 'the name the server never read is not accepted');
  assert.ok(fatal({ ...noSecret, MEDIA_SECRET: 'x'.repeat(MEDIA_SECRET_MIN_LENGTH - 1) }));
  assert.ok(!fatal({ ...noSecret, MEDIA_SECRET: 'x'.repeat(MEDIA_SECRET_MIN_LENGTH) }));
  assert.ok(!fatal({}), 'development signs with a per-process key');
  assert.equal(buildCapabilityReport({ env: { MEDIA_SECRET: PROD.MEDIA_SECRET } }).capabilities.media_signing_secret.state, 'configured');
  assert.equal(buildCapabilityReport({ env: { SCOUTBOX_MEDIA_SECRET: PROD.MEDIA_SECRET } }).capabilities.media_signing_secret.state, 'not_configured');
});
await test('boot: a provider variable with no real integration behind it is fatal in production and ignored in development', () => {
  for (const name of ['ONFIDO_API_TOKEN', 'STRIPE_SECRET_KEY', 'S3_BUCKET']) {
    const problems = productionConfigProblems({ env: { ...PROD, [name]: 'synthetic' }, trustWeightsTotal: 100 });
    assert.ok(problems.some((p) => p.code === 'PROVIDER_NOT_IMPLEMENTED' && p.fatal && p.message.startsWith(name)), name);
    assert.ok(!JSON.stringify(problems).includes('synthetic'), 'the value is never echoed');
    assert.equal(productionConfigProblems({ env: { [name]: 'synthetic' }, trustWeightsTotal: 100 }).length, 0);
  }
  assert.deepEqual(Object.keys(UNIMPLEMENTED_PROVIDER_VARIABLES).sort(), ['ONFIDO_API_TOKEN', 'S3_BUCKET', 'STRIPE_SECRET_KEY']);
});
await test('adapters: IDV, billing and storage name the dev provider they are, whatever the environment says', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ONFIDO_API_TOKEN: 'synthetic', STRIPE_SECRET_KEY: 'synthetic', S3_BUCKET: 'synthetic' });
  try {
    const idv = createIdvProvider();
    assert.equal(idv.provider, 'dev-attestation');
    assert.equal((await idv.verify({ name: 'Parent', documentType: 'passport', documentRef: '123456789' })).provider, 'dev-attestation');
    const db = { invoices: [] };
    const billing = createBilling(db, (p) => `${p}-1`);
    assert.equal(billing.provider, 'dev-ledger');
    assert.equal((await billing.invoiceForSigning({ id: 'sg-1', playerName: 'Player' }, { id: 'org-1', name: 'Club', plan: 'Pro' })).provider, 'dev-ledger');
    assert.equal(createStorage(os.tmpdir()).provider, 'local-disk');
  } finally {
    for (const k of ['ONFIDO_API_TOKEN', 'STRIPE_SECRET_KEY', 'S3_BUCKET']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
await test('capabilities: adapters are reported from the variables the adapters read', () => {
  const caps = (env) => buildCapabilityReport({ env }).capabilities;
  assert.equal(caps({ SENDGRID_API_KEY: 'SG.synthetic' }).email_transport.state, 'configured');
  assert.equal(caps({ SENDGRID_API_KEY: '  ' }).email_transport.state, 'local_outbox', 'blank is unset, as in the mailer');
  assert.equal(caps({ SCOUTBOX_SMTP_URL: 'smtp://x', SMTP_URL: 'smtp://x' }).email_transport.state, 'local_outbox', 'names nothing reads');
  const everything = { SCOUTBOX_IDV_PROVIDER: 'onfido', ONFIDO_API_TOKEN: 'x', SCOUTBOX_STORAGE_BUCKET: 'b', S3_BUCKET: 'b' };
  assert.equal(caps(everything).authoritative_identity_provider.state, 'not_configured', 'no IDV provider is integrated');
  assert.equal(caps(everything).object_storage.state, 'not_configured', 'no object storage is integrated');
  assert.equal(liveMailConfigured({ SENDGRID_API_KEY: 'k' }), true);
  assert.equal(livePushConfigured({ EXPO_ACCESS_TOKEN: '' }), false);
});
await test('first boot: demo data in development, catalogues only in production; SCOUTBOX_SEED_DEMO overrides either way', () => {
  assert.equal(demoSeedEnabled({}), true);
  assert.equal(demoSeedEnabled({ SCOUTBOX_SEED_DEMO: '0' }), false);
  assert.equal(demoSeedEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(demoSeedEnabled({ NODE_ENV: 'production', SCOUTBOX_SEED_DEMO: '1' }), true);
  assert.ok(productionConfigProblems({ env: { ...PROD, SCOUTBOX_SEED_DEMO: 'yes' }, trustWeightsTotal: 100 }).some((p) => p.code === 'SEED_DEMO_INVALID' && p.fatal));
  const empty = buildSeed({ demo: false }), demo = buildSeed();
  for (const k of ['orgs', 'guardians', 'players', 'reputationSeed']) assert.deepEqual(empty[k], [], k);
  assert.ok(demo.orgs.length && demo.players.length && demo.guardians.length);
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(demo).sort(), 'the same containers either way');
  assert.deepEqual(empty.plans, demo.plans, 'the product catalogues are not demo data');
  assert.deepEqual(empty.archetypes, demo.archetypes);
});
await test('first boot (real server): production starts with no people or clubs, SCOUTBOX_SEED_DEMO=1 opts in, and a saved database is never re-seeded', async () => {
  const PROD_ENV = { NODE_ENV: 'production', MEDIA_SECRET: PROD.MEDIA_SECRET, ADMIN_KEY: PROD.ADMIN_KEY };
  const port = pickPort(7900, 100);
  const boot = (dir, env) => new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, SCOUTBOX_SEED_DEMO: '', ...env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(proc); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${log}`)));
    setTimeout(() => reject(new Error(`boot timeout: ${log}`)), 20_000).unref();
  });
  const stop = (proc) => new Promise((resolve) => { proc.removeAllListeners('exit'); proc.on('exit', resolve); proc.kill('SIGTERM'); });
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const dirs = [];
  const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-first-boot-')); dirs.push(d); return d; };
  try {
    const prodDir = fresh();
    let proc = await boot(prodDir, PROD_ENV);
    let h = await health();
    assert.equal(h.players, 0, 'no demo players'); assert.equal(h.orgs, 0, 'no demo clubs');
    const directory = await (await fetch(`http://127.0.0.1:${port}/orgs/directory`)).json();
    assert.deepEqual(directory, [], 'the public club directory is empty');
    await stop(proc);
    proc = await boot(prodDir, { ...PROD_ENV, SCOUTBOX_SEED_DEMO: '1' });
    h = await health();
    assert.equal(h.players + h.orgs, 0, 'the flag never seeds over a saved database');
    await stop(proc);
    proc = await boot(fresh(), { ...PROD_ENV, SCOUTBOX_SEED_DEMO: '1' });
    h = await health();
    assert.ok(h.players > 0 && h.orgs > 0, 'opting in loads the demo world on a first boot');
    assert.equal(h.devLogins, false, 'and its people still have no passwordless logins');
    await stop(proc);
    proc = await boot(fresh(), { SCOUTBOX_SEED_DEMO: '0' });
    h = await health();
    assert.equal(h.players + h.orgs, 0, 'development can start empty too');
    await stop(proc);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
await test('dev logins: one rule — on in development, off in production with no override', () => {
  assert.equal(devLoginsEnabled({}), true);
  assert.equal(devLoginsEnabled({ NODE_ENV: 'test' }), true);
  assert.equal(devLoginsEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(devLoginsEnabled({ NODE_ENV: 'production', ALLOW_DEV_LOGINS: '1' }), false);
});
await test('capabilities: the report never carries the test IdP secret', () => {
  const text = JSON.stringify(buildCapabilityReport({ env: { TEST_IDP_SECRET: 'super-secret-value-9' } }));
  assert.ok(!text.includes('super-secret-value-9'));
});

console.log(`\n${passed} identity checks passed`);
