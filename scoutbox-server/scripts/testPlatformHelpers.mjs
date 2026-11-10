// The shared helpers under domains/platform/ that every domain uses instead of its own copy: the request clock and
// its production refusal, the client-key rule and request fingerprint, deepFreeze and canonicalJson, the side-effect
// runner and the rate-limit checks. Run with: npm test
import assert from 'node:assert/strict';
import { requestClock, TEST_CLOCK_HEADER } from '../domains/platform/clock.mjs';
import { testClockEnabled, productionConfigProblems } from '../domains/platform/capabilities.mjs';
import { normaliseClientKey, payloadFingerprint, CLIENT_KEY_MAX } from '../domains/platform/idempotency.mjs';
import { deepFreeze, canonicalJson } from '../domains/platform/values.mjs';
import { sideEffectRunner } from '../domains/platform/sideEffects.mjs';
import { limitCheck, refuseWhenLimited } from '../domains/platform/rateLimit.mjs';
import { normaliseClientKey as contactKey } from '../domains/recruitment/lifecycle/contact.mjs';
import { normaliseSigningClientKey } from '../domains/recruitment/signings/signing.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const reqWith = (v) => ({ get: (h) => (h === TEST_CLOCK_HEADER ? v : undefined) });

test('request clock: the header pins the time only with SCOUTBOX_TEST_CLOCK=1 outside production; junk falls back to the server clock', () => {
  const pinned = requestClock({ SCOUTBOX_TEST_CLOCK: '1' });
  assert.equal(pinned(reqWith('1700000000000')), 1700000000000);
  for (const junk of [undefined, '', 'soon', '0', '-5'])
    assert.ok(Math.abs(pinned(reqWith(junk)) - Date.now()) < 1000, `${junk} is ignored`);
  assert.ok(Math.abs(pinned() - Date.now()) < 1000, 'no request: the server clock');
  for (const env of [{}, { SCOUTBOX_TEST_CLOCK: '1', NODE_ENV: 'production' }]) {
    assert.ok(
      Math.abs(requestClock(env)(reqWith('1700000000000')) - Date.now()) < 1000,
      `${JSON.stringify(env)} ignores the header`,
    );
  }
  assert.equal(testClockEnabled({ SCOUTBOX_TEST_CLOCK: '1', NODE_ENV: 'production' }), false);
});

test('a production boot with SCOUTBOX_TEST_CLOCK set is refused; development is left alone', () => {
  const codes = (env) => productionConfigProblems({ env }).map((p) => p.code);
  assert.ok(codes({ NODE_ENV: 'production', SCOUTBOX_TEST_CLOCK: '1' }).includes('TEST_CLOCK_IN_PRODUCTION'));
  assert.ok(!codes({ SCOUTBOX_TEST_CLOCK: '1' }).includes('TEST_CLOCK_IN_PRODUCTION'));
});

test("client key: absent or empty is no key; text is trimmed and 1–64 characters; anything else is refused under the caller's code", () => {
  for (const none of [undefined, null, '']) assert.deepEqual(normaliseClientKey(none, 'X'), { ok: true, key: null });
  assert.deepEqual(normaliseClientKey('  k-1 ', 'X'), { ok: true, key: 'k-1' });
  assert.equal(normaliseClientKey('k'.repeat(CLIENT_KEY_MAX), 'X').key.length, CLIENT_KEY_MAX);
  for (const bad of ['k'.repeat(CLIENT_KEY_MAX + 1), '   ', 7, {}, [], true])
    assert.equal(normaliseClientKey(bad, 'X_INVALID').error, 'X_INVALID');
  assert.equal(contactKey(7).error, 'CONTACT_CLIENT_KEY_INVALID');
  assert.equal(normaliseSigningClientKey('k'.repeat(65)).error, 'SIGNING_CLIENT_KEY_INVALID');
});

test('fingerprint: key order does not matter at any depth; a different nested value is a different request', () => {
  assert.equal(payloadFingerprint({ a: 1, b: { c: 2, d: 3 } }), payloadFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  const parties = (role) =>
    payloadFingerprint({ type: 'transfer', jurisdictions: ['GB'], parties: [{ partyRole: role, subjectId: 'p-1' }] });
  assert.notEqual(parties('buyer'), parties('seller'));
  // A flat payload reads the same as the old top-level fingerprint, so keys stored before the change still match.
  assert.equal(payloadFingerprint({ subject: 's', body: 'b' }), '{"body":"b","subject":"s"}');
});

test('canonicalJson sorts keys at every level and keeps array order; deepFreeze freezes every level', () => {
  assert.equal(canonicalJson({ b: [2, 1], a: { y: null, x: undefined } }), '{"a":{"x":null,"y":null},"b":[2,1]}');
  const v = deepFreeze({ a: { b: [{ c: 1 }] } });
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.a) && Object.isFrozen(v.a.b) && Object.isFrozen(v.a.b[0]));
});

test('side-effect runner: returns the value, and logs a failure instead of throwing it', () => {
  const run = sideEffectRunner('TEST');
  assert.equal(
    run('ok', () => 5),
    5,
  );
  const logged = [];
  const orig = console.error;
  console.error = (m) => logged.push(m);
  try {
    assert.equal(
      run('boom', () => {
        throw new Error('nope');
      }),
      undefined,
    );
  } finally {
    console.error = orig;
  }
  assert.deepEqual(logged, ['TEST side_effect_failed boom: nope']);
});

test('rate-limit checks: no limiter limits nothing; a limited action answers 429 with the shared body', () => {
  assert.equal(limitCheck(undefined)('a', 'k'), false);
  const limiter = { limited: (action) => action === 'busy' };
  assert.equal(limitCheck(limiter)('busy', 'k'), true);
  const sent = {};
  const res = {
    status(c) {
      sent.status = c;
      return this;
    },
    json(b) {
      sent.body = b;
    },
  };
  const refuse = refuseWhenLimited(limiter);
  assert.equal(refuse(res, 'idle', 'k'), false);
  assert.equal(refuse(res, 'busy', 'k'), true);
  assert.equal(sent.status, 429);
  assert.equal(sent.body.error, 'RATE_LIMITED');
  assert.equal(sent.body.action, 'busy');
});

console.log(`\n${passed} passed`);
