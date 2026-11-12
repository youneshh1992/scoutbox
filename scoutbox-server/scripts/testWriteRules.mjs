// The write rules (writeRules.mjs): one changing commit per request, a read that writes nothing, nothing sent while a
// transaction is open, and every write inside a transaction. Throwaway databases, synthetic rows. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { operationOn } from '../repositories/database.mjs';
import { inRequest, asSweep, apartFromTheAct, declareAuditedRead, standaloneWrite } from '../writeRules.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function fixture({ production = false } = {}) {
  const was = process.env.NODE_ENV;
  if (production) process.env.NODE_ENV = 'production';
  else delete process.env.NODE_ENV;
  let store;
  try {
    store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-write-rules-')));
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
  store.sqlite.exec('CREATE TABLE rows (id TEXT PRIMARY KEY) STRICT');
  // A repository's own write: a transaction of its own, or joined to the open unit.
  const operation = operationOn(store.sqlite, store.unit);
  const insert = store.sqlite.prepare('INSERT INTO rows (id) VALUES (?)');
  const write = (id) => operation(() => insert.run(id));
  const ids = () =>
    store.sqlite
      .prepare('SELECT id FROM rows ORDER BY id')
      .all()
      .map((r) => r.id);
  const request = (method, fn, route = `${method} /test`) => inRequest({ method, routeKey: () => route }, fn);
  return { store, write, insert, ids, request };
}

const refused = (rule) => (err) => err?.code === 'WRITE_RULE_BROKEN' && err.rule === rule;

await test('outside a request (boot, a timer), separate transactions are not counted', () => {
  const { write, ids } = fixture();
  write('a');
  write('b');
  assert.deepEqual(ids(), ['a', 'b']);
});

await test('a request may commit one unit that writes several rows', () => {
  const { store, write, ids, request } = fixture();
  request('POST', () =>
    store.unitOfWork(() => {
      write('a');
      write('b');
    }),
  );
  assert.deepEqual(ids(), ['a', 'b']);
});

await test('a second changing commit in a request is refused before it commits, naming both call sites', () => {
  const { write, ids, request } = fixture();
  assert.throws(
    () =>
      request('POST', () => {
        write('a');
        write('b');
      }),
    (err) => refused('second_commit')(err) && /POST \/test committed a second transaction/.test(err.message),
  );
  assert.deepEqual(ids(), ['a'], 'the first commit stands; the refused one rolled back');
});

await test('the count follows the request across an await', async () => {
  const { write, ids, request } = fixture();
  await assert.rejects(
    request('POST', async () => {
      write('a');
      await new Promise((r) => setTimeout(r, 5));
      write('b');
    }),
    refused('second_commit'),
  );
  assert.deepEqual(ids(), ['a']);
});

await test('a transaction that changed nothing is not counted', () => {
  const { store, write, ids, request } = fixture();
  const operation = operationOn(store.sqlite, store.unit);
  request('POST', () => {
    operation(() => store.sqlite.prepare("UPDATE rows SET id = 'x' WHERE id = 'missing'").run());
    write('a');
  });
  assert.deepEqual(ids(), ['a']);
});

await test("after-commit side effects and what they write are not the request's act", () => {
  const { store, write, ids, request } = fixture();
  request('POST', () => {
    store.unitOfWork(() => {
      write('a');
      store.afterCommit(() => write('push-log'));
    });
    store.outward('mail', () => write('outbox'));
  });
  assert.deepEqual(ids(), ['a', 'outbox', 'push-log']);
  assert.equal(store.unitOfWorkState().afterCommitFailures, 0);
});

await test('a sweep run from a request commits one transaction per item', () => {
  const { write, ids, request } = fixture();
  request('POST', () =>
    asSweep(() => {
      write('a');
      write('b');
      write('c');
    }),
  );
  assert.deepEqual(ids(), ['a', 'b', 'c']);
});

await test('a write apart from the act (first-use setup) is not counted, so a read may make it and an act may follow it', () => {
  const { write, ids, request } = fixture();
  request('GET', () => apartFromTheAct('first member', () => write('first-member')));
  request('POST', () => {
    apartFromTheAct('bootstrap', () => write('bootstrap'));
    write('act');
  });
  assert.deepEqual(ids(), ['act', 'bootstrap', 'first-member']);
});

await test('a GET or HEAD that writes is refused, unless it declares an audited read', () => {
  const { store, write, ids, request } = fixture();
  assert.throws(() => request('GET', () => write('a')), refused('read_wrote'));
  assert.throws(() => request('HEAD', () => write('a')), refused('read_wrote'));
  request('GET', () => {
    declareAuditedRead('a shared passport was opened');
    store.unitOfWork(() => {
      write('b');
      write('c');
    });
  });
  assert.deepEqual(ids(), ['b', 'c']);
  assert.throws(
    () =>
      request('GET', () => {
        declareAuditedRead('still one unit');
        write('d');
        write('e');
      }),
    refused('second_commit'),
    'an audited read is still one transaction',
  );
});

await test('sending something out while a transaction is open is refused before it is sent, and the unit rolls back', () => {
  for (const production of [false, true]) {
    const { store, write, ids } = fixture({ production });
    let sent = 0;
    assert.throws(
      () =>
        store.unitOfWork(() => {
          write('a');
          store.outward('push', () => sent++);
        }),
      refused('outward'),
    );
    assert.equal(sent, 0, production ? 'in production too' : 'outside production');
    assert.deepEqual(ids(), []);
    assert.equal(store.unitOfWorkState().writeRules.outward, 1);
  }
});

await test('a write with no transaction open is caught at the next transaction; the id counter is allowed', () => {
  const { store, insert, write, ids, request } = fixture();
  request('POST', () => standaloneWrite(store.sqlite, () => insert.run('mint')));
  request('POST', () => write('a'));
  assert.throws(
    () =>
      request('POST', () => {
        insert.run('loose');
        write('b');
      }),
    refused('write_outside_transaction'),
  );
  assert.deepEqual(ids(), ['a', 'loose', 'mint']);
  assert.equal(store.unitOfWorkState().writeRules.writesOutsideTransaction, 1);
});

await test('in production a broken rule is counted and logged, not thrown', () => {
  const { store, write, ids, request } = fixture({ production: true });
  const logged = [];
  const error = console.error;
  console.error = (m) => logged.push(String(m));
  try {
    request('POST', () => {
      write('a');
      write('b');
    });
  } finally {
    console.error = error;
  }
  assert.deepEqual(ids(), ['a', 'b']);
  const state = store.unitOfWorkState().writeRules;
  assert.equal(state.violations, 1);
  assert.equal(state.lastViolation.rule, 'second_commit');
  assert.ok(logged.some((m) => m.startsWith('WRITE_RULE second_commit')));
});

console.log(`write rules: ${passed} checks passed`);
