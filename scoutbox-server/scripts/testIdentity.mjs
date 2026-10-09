// Unit tests for the identity hardening: the single lead-role rule, reverse-
// proxy trust parsing and its effect on req.ip, and the capability/boot
// reporting of both. Run with: npm test (from scoutbox-server/).
import assert from 'node:assert/strict';
import express from 'express';
import { isLeadRole, isLeadUser, LEAD_ROLE_PATTERN } from '../roles.mjs';
import { parseTrustProxy } from '../httpTrust.mjs';
import { buildCapabilityReport, productionConfigProblems } from '../m181/capabilities.mjs';

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
const PROD = { NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 's', ADMIN_KEY: 'a-long-production-admin-key-0123' };
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
  assert.equal(buildCapabilityReport({ env: { NODE_ENV: 'production', ALLOW_DEV_LOGINS: '1' } }).capabilities.staff_sso.state, 'test_only');
});
await test('capabilities: the report never carries the test IdP secret', () => {
  const text = JSON.stringify(buildCapabilityReport({ env: { TEST_IDP_SECRET: 'super-secret-value-9' } }));
  assert.ok(!text.includes('super-secret-value-9'));
});

console.log(`\n${passed} identity checks passed`);
