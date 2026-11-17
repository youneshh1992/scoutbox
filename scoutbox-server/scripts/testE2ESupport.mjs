// The language-neutral battery support in e2e/support/: the boundary the batteries keep, the specification tables,
// the server contract, the row reader, and the SQL case plants (which must leave what the repository plants leave).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boundaryProblems } from '../e2e/support/boundary.mjs';
import { sweepStaleRuns } from '../e2e/support/staleRuns.mjs';
import { serverCommand, serverDir } from '../e2e/support/server.mjs';
import { openFixture, writeFixture, plantCase, legacyMoves } from '../e2e/support/sqlFixture.mjs';
import { readRows, rows, json } from '../e2e/support/sqlRows.mjs';
import { totp as supportTotp } from '../e2e/support/totp.mjs';
import * as serverTotp from '../domains/identity/totp.mjs';
import { boundaryReport } from './e2eBoundary.mjs';
import { undocumented } from './e2eContract.mjs';
import { checkCount, ledgerProblems, serverImports } from './e2eLedger.mjs';
import { notData, specProblems } from './specSnapshot.mjs';
import { openLayer, plantCase as plantViaLayer, legacyMoves as movesViaLayer } from './dataLayerFixture.mjs';
import {
  saveFixture,
  acceptedRequest,
  p4bInvitation,
  minorInvitation,
  legacyTrialRequest,
  scheduledTrial,
} from './recruitmentTestFixtures.mjs';
import { ROOM_CASES_FIX } from './recruitmentCasesTestFixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-e2esup-'));

// ---------------------------------------------------------------- the boundary
const crossings = (text) => boundaryProblems(text).map((p) => p.why);
assert.deepEqual(crossings("import { x } from '../../domain.ts';"), [
  'imports from outside e2e/',
  'names a path outside e2e/',
]);
assert.deepEqual(crossings("const m = await import('../../domains/x.mjs');"), [
  'imports from outside e2e/',
  'names a path outside e2e/',
]);
assert.deepEqual(crossings("const D = path.join(HERE, '..', '..', 'temporal.ts');"), ['builds a path outside e2e/']);
assert.deepEqual(crossings("spawn('node', ['server.mjs'], {"), ['starts the server itself (use support/server.mjs)']);
assert.deepEqual(crossings("import { j } from '../support/liveEvents.mjs';"), []);
assert.deepEqual(crossings("import { serverCommand } from '../support/server.mjs';"), []);
assert.deepEqual(crossings('// node server.mjs &'), ['starts the server itself (use support/server.mjs)']);
assert.deepEqual(crossings("import path from 'node:path';"), []);
assert.deepEqual(boundaryReport(), [], 'every file under e2e/ keeps the boundary, or is listed as not yet neutral');
console.log(
  '✓ the boundary refuses imports, paths and server starts outside e2e/, and every listed battery still crosses it',
);

// ---------------------------------------------------------------- the launcher
const [cmd, args] = serverCommand();
assert.equal(cmd, process.execPath);
assert.ok(fs.existsSync(args[0]) && path.basename(args[0]) === 'server.mjs', 'the launcher starts server.mjs');
assert.ok(fs.existsSync(path.join(serverDir, 'package.json')), 'serverDir is the server directory');
console.log('✓ support/server.mjs starts this server from its own directory');

// ---------------------------------------------------------------- the authenticator
{
  // The battery's authenticator must show the codes the server accepts: the RFC 6238 vectors, and random secrets
  // at random times against the server's own TOTP.
  const rfc = serverTotp.b32encode(Buffer.from('12345678901234567890'));
  for (const [s, code] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
  ])
    assert.equal(supportTotp(rfc, s * 1000), code, `RFC 6238 at t=${s}s`);
  for (let i = 0; i < 200; i++) {
    const secret = serverTotp.b32encode(crypto.randomBytes(20));
    const at = crypto.randomInt(0, 2 ** 47);
    assert.equal(supportTotp(secret, at), serverTotp.totp(secret, at), `${secret} at ${at}`);
    assert.ok(serverTotp.totpValid(secret, supportTotp(secret, at), at));
  }
  console.log("✓ support/totp.mjs shows the codes the server's TOTP accepts");
}

// ---------------------------------------------------------------- specification tables and the contract
assert.deepEqual(await specProblems(), [], 'e2e/support/spec/ is current: run node scripts/specSnapshot.mjs');
assert.deepEqual(notData({ a: [1, 'x', null, { b: true }] }), []);
assert.deepEqual(notData({ f: () => 1, s: new Set(), n: Infinity }), [
  '$.f is a function',
  '$.s is a Set',
  '$.n is Infinity',
]);
console.log('✓ the specification tables are current and plain data');
assert.deepEqual(
  undocumented(),
  [],
  'every setting, development route and header a battery uses is in e2e/support/CONTRACT.md',
);
console.log('✓ e2e/support/CONTRACT.md names everything the batteries need from a server');

// ---------------------------------------------------------------- the ledger's accounting
{
  const battery = [
    'const ok = (cond, msg) => {',
    '  if (cond) passed++;',
    '};',
    'const neg = (cond, msg) => {',
    '  negatives++;',
    '  ok(cond, `[neg] ${msg}`);',
    '};',
    'const G = (n, cond, msg) =>',
    '  ok(cond, `G${n} — ${msg}`);',
    '// ok(commented out)',
    '/* neg(nor this) */',
    "ok(res.ok, 'one');",
    "neg(r.ok(), 'two');",
    "G(1, true, 'three');",
    "if (x) ok(y, 'four');",
  ].join('\n');
  assert.equal(
    checkCount(battery),
    4,
    "ok, neg and a one-line helper count where they're written, not inside each other",
  );
  assert.deepEqual(
    serverImports(
      "import { a } from '../../domain.ts';\nimport b from '../support/x.mjs';\nawait import('../../scripts/y.mjs');",
      'platform/z.mjs',
    ),
    ['domain.ts', 'scripts/y.mjs'],
  );
  assert.deepEqual(ledgerProblems(), [], "every battery's checks are accounted for: see scripts/e2eLedger.mjs");
  console.log("✓ every battery's checks are in the battery, its rules suite, or a note saying where they went");
}

// ---------------------------------------------------------------- the row reader
{
  const dir = tmp();
  const now = Date.now();
  writeFixture(dir, {
    sessions: [
      { token: 'tok-b', sid: 'sidbbbbbbbbb', kind: 'player', refId: 'pl-b', createdAt: now },
      { token: 'tok-a', sid: 'sidaaaaaaaaa', kind: 'player', refId: 'pl-a', createdAt: now },
      { token: 'tok-c', sid: 'sidcccccccc0', kind: 'player', refId: 'pl-c', createdAt: now, via: 'sso' },
    ],
  });
  const R = readRows(dir);
  try {
    assert.equal(R.count('sessions'), 3);
    const pk = R.sql
      .prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
      .all('sessions')
      .map((c) => c.name);
    const byKey = (rs) => rs.map((r) => pk.map((c) => r[c]).join('|'));
    assert.deepEqual(
      byKey(R.rows('sessions')),
      byKey(R.rows('sessions')).sort(),
      'rows come back in primary-key order',
    );
    assert.deepEqual(
      R.rows('sessions', { via: null })
        .map((r) => r.ref_id)
        .sort(),
      ['pl-a', 'pl-b'],
      'null matches IS NULL',
    );
    assert.equal(R.count('sessions', { ref_id: ['pl-b', 'pl-a'] }), 2, 'an array matches IN');
    assert.equal(R.count('sessions', { ref_id: [] }), 0, 'an empty array matches nothing');
    assert.deepEqual(
      R.rows('sessions', {}, { order: 'sid' }).map((r) => r.sid),
      ['sidaaaaaaaaa', 'sidbbbbbbbbb', 'sidcccccccc0'],
    );
    assert.equal(R.row('sessions', { ref_id: 'nobody' }), null);
    assert.throws(() => R.row('sessions', { kind: 'player' }), /3 rows of sessions match/);
    assert.throws(() => R.rows('sessions', { refId: 'pl-b' }), /sessions has no column refId/);
    assert.throws(() => R.rows('no_such_table'), /no table no_such_table/);
    assert.ok(R.tables().includes('sessions') && !R.tables().some((t) => t.startsWith('sqlite_')));
    assert.equal(R.all().sessions.length, 3);
    assert.throws(() => R.sql.exec('DELETE FROM sessions'), /readonly/i, 'the reader cannot write');
  } finally {
    R.close();
  }
  assert.deepEqual(json('{"a":[1]}'), { a: [1] });
  assert.equal(json(null), null);
  const fresh = path.join(tmp(), 'never-booted');
  assert.deepEqual(rows(fresh, 'sessions'), [], 'a directory with no database reads as a fresh one');
}
console.log('✓ sqlRows reads stored rows exactly, refuses unknown names, and never writes');

// ---------------------------------------------------------------- case plants: SQL against the repositories
{
  const collections = {
    requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()],
    trials: [scheduledTrial()],
    ...ROOM_CASES_FIX(),
  };
  const base = tmp();
  saveFixture(base, collections);
  const copy = () => {
    const d = tmp();
    fs.cpSync(base, d, { recursive: true });
    return d;
  };
  const dump = (dir) => {
    const db = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
    try {
      return JSON.parse(
        JSON.stringify({
          cases: db.prepare('SELECT * FROM recruitment_cases ORDER BY id').all(),
          history: db.prepare('SELECT * FROM case_history ORDER BY case_id, position').all(),
        }),
      );
    } finally {
      db.close();
    }
  };
  const caseId = 'case-1';
  const firstHistoryId = rows(base, 'case_history', { case_id: caseId })[0].id;
  const plant = {
    status: 'signed',
    stage: 'closed',
    rev: 9,
    signingId: 'sgn-legacy',
    history: [
      {
        id: 'hist-plant-1',
        at: 5_000_000_000_000,
        action: 'room_status_changed',
        byKind: 'org',
        byId: 'legacy',
        byName: 'Legacy',
        detail: { from: 'trial_scheduled', to: 'signed' },
      },
      { id: 'hist-plant-2', at: 5_000_000_000_001, action: 'note', detail: 'a plain-text detail' },
    ],
    dropHistory: (id) => id === firstHistoryId,
  };
  const a = copy();
  const L = openLayer(a);
  try {
    plantViaLayer(L, caseId, plant);
  } finally {
    L.close();
  }
  const b = copy();
  const F = openFixture(b);
  let stored;
  try {
    stored = plantCase(F, caseId, plant);
    assert.throws(() => plantCase(F, 'no-such-case', { status: 'signed' }), /no recruitment case no-such-case/);
  } finally {
    F.close();
  }
  assert.deepEqual(
    dump(b),
    dump(a),
    'the SQL plant leaves the cases and their history exactly as the repository plant does',
  );
  assert.equal(stored.room_status, 'signed');
  assert.equal(stored.links_signing_id, 'sgn-legacy');

  // The same legacy chain from both, with the clock and the id suffixes pinned.
  const realNow = Date.now;
  const realRandom = Math.random;
  const NOW = 6_000_000_000_000;
  Date.now = () => NOW;
  Math.random = () => 0.5;
  try {
    const chain = ['trial_requested', 'trial_scheduled', 'offer_made'];
    const opts = { prefix: 'hist-lm', extraLast: { note: 'last' } };
    const L2 = openLayer(copy());
    let viaLayer;
    try {
      viaLayer = movesViaLayer(L2.layer.recruitmentCases.cases.byId(caseId), chain, opts);
    } finally {
      L2.close();
    }
    const F2 = openFixture(copy());
    let viaSql;
    try {
      viaSql = legacyMoves(F2, caseId, chain, opts);
      assert.deepEqual(
        legacyMoves(F2, caseId, ['watching'], { prefix: 'x', withReasons: false, now: 7_000_000_000_000 }).history[0],
        {
          id: 'x-i',
          at: 7_000_003_600_000,
          action: 'room_status_changed',
          byKind: 'org',
          byId: 'legacy',
          byName: 'Legacy',
          detail: { from: viaSql.history[0].detail.from, to: 'watching' },
        },
        'withReasons: false and an explicit now',
      );
    } finally {
      F2.close();
    }
    assert.deepEqual(viaSql, viaLayer, 'the SQL legacy chain is the repository chain');
    assert.equal(viaSql.history[1].at - viaSql.history[0].at, 3_600_000);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
}
console.log('✓ plantCase and legacyMoves in SQL leave what the repository versions leave');

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staleruns-'));
  try {
    const now = Date.now();
    const made = (name, ageMs) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'scoutbox.db'), 'x');
      const t = (now - ageMs) / 1000;
      fs.utimesSync(dir, t, t);
      return dir;
    };
    const old = made('sbx-old-a1b2c3', 2 * 86_400_000);
    const oldSuite = made('sb-idrepo-a1b2c3', 25 * 3_600_000);
    const fresh = made('sbx-fresh-a1b2c3', 3_600_000);
    const unrelated = made('someone-else-a1b2c3', 30 * 86_400_000);
    fs.writeFileSync(path.join(root, 'sbx-a-file'), 'x');
    const t = (now - 30 * 86_400_000) / 1000;
    fs.utimesSync(path.join(root, 'sbx-a-file'), t, t);
    assert.equal(sweepStaleRuns({ dir: root, now }), 2);
    assert.equal(fs.existsSync(old), false, 'a run folder over a day old is removed');
    assert.equal(fs.existsSync(oldSuite), false, "a unit suite's folder too");
    assert.equal(fs.existsSync(fresh), true, 'a folder from the last day is kept');
    assert.equal(fs.existsSync(unrelated), true, 'a folder no run names is kept');
    assert.equal(fs.existsSync(path.join(root, 'sbx-a-file')), true, 'a file is never removed');
    assert.equal(sweepStaleRuns({ dir: path.join(root, 'missing'), now }), 0, 'a missing directory sweeps nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log('✓ sweepStaleRuns removes run folders more than a day old, and nothing else');
