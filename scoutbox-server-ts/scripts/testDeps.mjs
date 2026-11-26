// A domain factory's declared dependencies (domains/platform/deps.mjs): a missing or undeclared name fails at once, and
// the context its routes read refuses a name the declaration left out, outside production only. Run with: npm test
import assert from 'node:assert/strict';
import { needs, strictContext } from '../domains/platform/deps.mjs';
import { routeContext } from '../domains/platform/routeHelpers.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

test('exactly the declared names pass, and null stands for a dependency deliberately absent', () => {
  const deps = { unit: () => {}, faults: null };
  assert.equal(needs('createX', deps, ['unit', 'faults']), deps);
});

test('a missing or undefined declared name fails, naming it', () => {
  assert.throws(() => needs('createX', { unit: undefined }, ['unit', 'notify']), /createX: missing unit, notify/);
});

test('a name the factory did not declare fails, so a wide context cannot be handed on', () => {
  assert.throws(() => needs('createX', { unit: 1, players: 2 }, ['unit']), /createX: not declared: players/);
});

test('outside production, reading a name the context does not hold throws where it is read', () => {
  const ctx = strictContext('createX', { unit: 1, absent: null });
  assert.equal(ctx.unit, 1);
  assert.equal(ctx.absent, null);
  assert.throws(() => ctx.notify, /createX: notify is not one of its dependencies/);
  assert.equal('notify' in ctx, false, 'asking whether it is there is not reading it');
  assert.equal(ctx.then, undefined, 'awaiting or logging the context does not throw');
  assert.deepEqual({ ...ctx }, { unit: 1, absent: null });
});

test('in production the context is the plain object', () => {
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const plain = { unit: 1 };
    assert.equal(strictContext('createX', plain), plain);
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
});

test('the route context adds the route helpers and stays strict, its helpers included', () => {
  const ctx = routeContext('createX', { nextId: (p) => `${p}-1`, isBlocked: () => false });
  assert.equal(ctx.auditEntry('org', 'u1', 'Ana', 'x').id, 'aud-1');
  assert.equal(ctx.orgCanSee({ id: 'o1' }, null), false);
  assert.throws(() => ctx.storage, /createX: storage is not one of its dependencies/);
  // activeAffiliation reads scoutingReads, which this factory did not declare.
  assert.throws(() => ctx.activeAffiliation('o1', 'Ana'), /createX: scoutingReads is not one of its dependencies/);
});

console.log(`testDeps: ${passed} passed`);
