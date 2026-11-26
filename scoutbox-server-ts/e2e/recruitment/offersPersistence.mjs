// Persistence, restart and corruption audit for the canonical Offer.
//
//   1  no Offer migration beyond the contacts/offers tables (0017);
//      a file with no Offers boots with an empty store and no migration runs
//      again — nothing is backfilled and no lifecycle state is reinterpreted
//      as an Offer
//   2  a real journey — DRAFT, ISSUED+ACCEPTED, ISSUED+DECLINED, ISSUED+WITHDRAWN,
//      SUPERSEDED — survives SIGTERM and a reboot byte-faithfully: revisions,
//      responses, keys, history, read receipts, case stages; no signing appears
//   3  idempotency keys still replay after the reboot; the exact issued
//      revision is still immutable; a stale rev is still a conflict
//   4  a corrupt Offer row is named and refused, never repaired, never
//      fabricated, and never lets the lifecycle move; its neighbours are fine
//
// Nothing is rewritten, re-ordered or "repaired" on boot. Fixtures are planted and read back as stored rows; a row
// the schema refuses is planted with plain SQL and expected to throw (the repository's own refusals are its unit
// suite's, scripts/testRecruitmentContactsOffers.mjs).

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '../support/sqlFixture.mjs';
import { readRows, rows } from '../support/sqlRows.mjs';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

// The table migrations a new database records, as the migrated schema lists them.
const MIGRATIONS = (() => {
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23op-schema-')));
  try {
    return R.rows('data_migrations').map((r) => r.id);
  } finally {
    R.close();
  }
})();
const LATEST_SCHEMA = Number(MIGRATIONS.at(-1).slice(0, 4)); // the latest table migration's number

// The tables an Offer is stored in.
const OFFER_TABLES = [
  'recruitment_offers',
  'offer_revisions',
  'offer_revision_documents',
  'offer_responses',
  'offer_read_receipts',
  'offer_history',
  'offer_keys',
];
/** What a stopped server left: the Offer's tables, the cases and the signings, as stored rows. */
const stored = (dir) => {
  const R = readRows(dir);
  try {
    return Object.fromEntries([...OFFER_TABLES, 'recruitment_cases', 'signings'].map((t) => [t, R.rows(t)]));
  } finally {
    R.close();
  }
};
/** Every Offer row of every Offer table, as text to compare. */
const offerRows = (dir) => {
  const s = stored(dir);
  return JSON.stringify(OFFER_TABLES.map((t) => s[t]));
};
/** Plant `[table, rows]` in order, in one transaction whose references are checked at its end. */
const plant = (dir, tables) => {
  const F = openFixture(dir);
  try {
    F.transaction(() => {
      F.sql.exec('PRAGMA defer_foreign_keys = ON'); // a revision and its response name each other
      for (const [table, rs] of tables) for (const r of rs) F.insert(table, r);
    });
  } finally {
    F.close();
  }
};

let passed = 0;
let negatives = 0;
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`✓ ${m}`);
  } else fail(m);
};
const neg = (c, m) => {
  negatives++;
  ok(c, `[neg] ${m}`);
};
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const H = 3_600_000;
const DAY = 24 * H;

const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SCOUTBOX_QUIET_LOGS: '1',
      SCOUTBOX_TEST_CLOCK: '1',
      AGENT_VERIFICATION_TEST_PROVIDER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => {
    log += b;
  });
  proc.stderr.on('data', (b) => {
    log += b;
  });
  proc.unref();
  proc.stdout.unref();
  proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log: () => log };
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* non-json */
    }
    return { status: r.status, body: data };
  };
  const stop = async () => {
    proc.kill('SIGTERM');
    for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
    return stored(dataDir);
  };
  return { up, j, stop, log: () => log };
}

const PORT = await freePort();
const T0 = Date.now();
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
const TERMS = {
  role: 'Central midfielder',
  squad: 'Under-23s',
  startDate: '2027-07-01',
  endDate: '2029-06-30',
  conditions: 'Subject to a medical.',
};
const S_NOTE = 'PRIVATE_NOTE_PERSISTS_9911';

// ------------------------------------------------------------- 1 — schema
const ledger = (dir) => {
  return JSON.stringify(rows(dir, 'data_migrations').map(({ id, applied_at }) => ({ id, applied_at })));
};
section(
  '1 — no Offer migration of its own: the latest schema, the offers are their tables, a file with none boots empty',
);
{
  ok(
    MIGRATIONS.length === LATEST_SCHEMA &&
      MIGRATIONS.filter((id) => /offer/i.test(id)).join() === '0017_recruitment_contacts_offers',
    '1.1 every table migration; the only one naming an Offer is 0017 (contacts and offers)',
  );
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23op-1-'));
  const s1 = await bootOn(DIR, PORT);
  ok(s1.up, '1.3 a fresh store boots');
  const h = (await s1.j('GET', '/healthz')).body;
  ok(h.schemaVersion === LATEST_SCHEMA, `1.4 and reports schema ${h.schemaVersion}`);
  const db1 = await s1.stop();
  const L1 = ledger(DIR);
  const tables = (() => {
    const R1 = readRows(DIR);
    try {
      return R1.tables();
    } finally {
      R1.close();
    }
  })();
  ok(
    ['recruitment_offers', 'offer_revisions', 'offer_responses'].every((t) => tables.includes(t)),
    '1.2 the offers are their tables, read through SQL',
  );
  ok(db1.recruitment_offers.length === 0, '1.5 the stopped file holds no Offer');
  // A file with no Offers: boot must reinterpret nothing.
  const casesBefore = JSON.stringify(db1.recruitment_cases.map((c) => [c.id, c.room_status]));
  const s2 = await bootOn(DIR, PORT);
  ok(
    s2.up && ledger(DIR) === L1 && JSON.parse(L1).length === MIGRATIONS.length,
    '1.6 the file boots with no migration applied (the ledger is unchanged)',
  );
  const maria = (
    await s2.j('POST', '/auth/org/login', {
      orgId: 'org-eastport',
      scoutName: 'Maria Keane',
      role: 'Head of Recruitment',
    })
  ).body;
  const room = await s2.j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
  const RID = room.body?.room?.roomId ?? room.body?.existingRoomId;
  const jr = (await s2.j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body;
  ok(
    jr.offer?.available === true && jr.offer.records.length === 0,
    '1.7 the journey reports the store available with no Offers — none was invented from the lifecycle',
  );
  const db2 = await s2.stop();
  neg(
    db2.recruitment_offers.length === 0 &&
      JSON.stringify(db2.recruitment_cases.filter((c) => c.id !== RID).map((c) => [c.id, c.room_status])) ===
        casesBefore,
    '1.8 after the boot: an empty store, and every pre-existing case exactly where it was',
  );
}

// ------------------------------------------------------------ 2 — journey
section('2 — a real journey survives SIGTERM and a reboot byte-faithfully');
const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23op-2-'));
const R = {};
{
  const s = await bootOn(DIR, PORT);
  ok(s.up, '2.1 booted on a fresh store');
  const { j } = s;
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const playerTok = async (id) => (await j('POST', '/auth/player/login', { playerId: id })).body.token;
  const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
  const lifecycle = async (RID, action) =>
    j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID)).case.rev }, maria.token);
  async function toConsideration(playerId) {
    const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, maria.token);
    const RID = r.body?.room?.roomId ?? r.body?.existingRoomId;
    await lifecycle(RID, 'startReview');
    await lifecycle(RID, 'shortlist');
    const dr = await j(
      'POST',
      `/org/rooms/${RID}/decision/draft`,
      { outcome: 'progress', note: 'internal' },
      maria.token,
    );
    const fin = await j(
      'POST',
      `/org/rooms/${RID}/decision/finalize`,
      { expectedRev: dr.body.draft.rev, clientKey: key() },
      maria.token,
    );
    if (fin.status !== 201) throw new Error(`finalize ${JSON.stringify(fin.body)}`);
    return RID;
  }
  const create = (RID, body) => j('POST', `/org/rooms/${RID}/offers`, body, maria.token, at(T0));
  const issue = (id, rev, k) =>
    j('POST', `/org/offers/${id}/issue`, { expectedRev: rev, clientKey: k }, maria.token, at(T0));
  const signingsBefore = (await j('GET', '/healthz')).body;
  void signingsBefore;

  // a) DRAFT — Kola
  R.kola = { RID: await toConsideration('pl-adeyemi') };
  const c1 = await create(R.kola.RID, { terms: { role: 'Winger' }, internalNote: S_NOTE, clientKey: 'P-create-kola' });
  R.kola.OID = c1.body.offer.id;
  R.kola.view = c1.body.offer;
  // b) ISSUED → ACCEPTED — Kim
  R.kim = { RID: await toConsideration('pl-kim') };
  const c2 = await create(R.kim.RID, {
    terms: TERMS,
    expiresAt: T0 + 7 * DAY,
    recipientMessage: 'Welcome.',
    clientKey: 'P-create-kim',
  });
  R.kim.OID = c2.body.offer.id;
  const i2 = await issue(R.kim.OID, 1, 'P-issue-kim');
  R.kim.R1 = i2.body.offer.currentRevisionId;
  const kim = await playerTok('pl-kim');
  await j('GET', `/player/offers/${R.kim.OID}`, undefined, kim, at(T0 + H)); // a read receipt
  const a2 = await j(
    'POST',
    `/player/offers/${R.kim.OID}/accept`,
    { revisionId: R.kim.R1, clientKey: 'P-accept-kim' },
    kim,
    at(T0 + 2 * H),
  );
  ok(a2.status === 200 && a2.body.lifecycle.to === 'offer_accepted', '2.2 Kim accepted; the case at offer_accepted');
  // c) ISSUED → DECLINED — Okafor
  R.chi = { RID: await toConsideration('pl-okafor') };
  const c3 = await create(R.chi.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: 'P-create-chi' });
  R.chi.OID = c3.body.offer.id;
  const i3 = await issue(R.chi.OID, 1, 'P-issue-chi');
  R.chi.R1 = i3.body.offer.currentRevisionId;
  const chi = await playerTok('pl-okafor');
  const d3 = await j(
    'POST',
    `/player/offers/${R.chi.OID}/decline`,
    { revisionId: R.chi.R1, reason: 'No.', clientKey: 'P-decline-chi' },
    chi,
    at(T0 + 2 * H),
  );
  ok(d3.status === 200 && d3.body.lifecycle.to === 'offer_declined', '2.3 Okafor declined; the case at offer_declined');
  // d) ISSUED → WITHDRAWN — Svensson
  R.sven = { RID: await toConsideration('pl-svensson') };
  const c4 = await create(R.sven.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: 'P-create-sven' });
  R.sven.OID = c4.body.offer.id;
  await issue(R.sven.OID, 1, 'P-issue-sven');
  const w4 = await j(
    'POST',
    `/org/offers/${R.sven.OID}/withdraw`,
    { expectedRev: 2, reason: 'Budget.', clientKey: 'P-withdraw-sven' },
    maria.token,
    at(T0 + H),
  );
  ok(
    w4.status === 200 && w4.body.lifecycle.to === 'offer_consideration',
    '2.4 the Offer to Svensson withdrawn; the case back at offer_consideration',
  );
  // e) SUPERSEDED — Tanaka: revision 1 issued, revision 2 issued
  R.tan = { RID: await toConsideration('pl-tanaka') };
  const c5 = await create(R.tan.RID, { terms: TERMS, expiresAt: T0 + 7 * DAY, clientKey: 'P-create-tan' });
  R.tan.OID = c5.body.offer.id;
  const i5 = await issue(R.tan.OID, 1, 'P-issue-tan-1');
  R.tan.R1 = i5.body.offer.currentRevisionId;
  const rv5 = await j(
    'POST',
    `/org/offers/${R.tan.OID}/revise`,
    { terms: { ...TERMS, squad: 'First team' }, expiresAt: T0 + 9 * DAY, expectedRev: 2, clientKey: 'P-revise-tan' },
    maria.token,
    at(T0 + H),
  );
  // The server clock never runs backwards: revision 2 was opened at T0+H, so it is issued at T0+H (the ordering rule refuses a revision issued before it was created).
  const i5b = await j(
    'POST',
    `/org/offers/${R.tan.OID}/issue`,
    { expectedRev: 3, clientKey: 'P-issue-tan-2' },
    maria.token,
    at(T0 + H),
  );
  R.tan.R2 = i5b.body.offer.currentRevisionId;
  ok(
    rv5.status === 201 &&
      i5b.status === 200 &&
      i5b.body.offer.revisions.find((r) => r.id === R.tan.R1).status === 'SUPERSEDED',
    '2.5 Tanaka: revision 1 superseded by revision 2',
  );

  // Capture every club view and every recipient view before the stop.
  R.before = {};
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan']) {
    R.before[who] = (await j('GET', `/org/offers/${R[who].OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer;
    R.before[`${who}_hist`] = (await j('GET', `/org/offers/${R[who].OID}/history`, undefined, maria.token)).body.items;
    R.before[`${who}_stage`] = (await journey(R[who].RID)).lifecycle.currentStage;
  }
  R.before.kimRecipient = (await j('GET', `/player/offers/${R.kim.OID}`, undefined, kim, at(T0 + 3 * H))).body.offer;
  R.before.stages = {
    kola: 'offer_consideration',
    kim: 'offer_accepted',
    chi: 'offer_declined',
    sven: 'offer_consideration',
    tan: 'offer_made',
  };
  ok(
    Object.entries(R.before.stages).every(([w, st]) => R.before[`${w}_stage`] === st),
    '2.6 the five cases sit where the workflow put them',
  );

  const db = await s.stop();
  ok(db.recruitment_offers.length === 5, '2.7 SIGTERM: the file holds five Offers');
  neg(
    db.signings.every((x) => x.player_id !== 'pl-kim'),
    '2.8 and no signing for the player who accepted',
  );
  neg(!db.recruitment_cases.some((c) => c.room_status === 'signed'), '2.9 no case is signed');
  const status = Object.fromEntries(db.recruitment_offers.map((o) => [o.id, o.status]));
  const of = (table, id) => db[table].filter((r) => r.offer_id === id);
  ok(
    status[R.kola.OID] === 'DRAFT' &&
      status[R.kim.OID] === 'ACCEPTED' &&
      status[R.chi.OID] === 'DECLINED' &&
      status[R.sven.OID] === 'WITHDRAWN' &&
      status[R.tan.OID] === 'ISSUED',
    '2.10 stored statuses: DRAFT, ACCEPTED, DECLINED, WITHDRAWN, ISSUED',
  );
  ok(
    of('offer_responses', R.kim.OID).length === 1 &&
      of('offer_responses', R.kim.OID)[0].client_key === 'P-accept-kim' &&
      of('offer_read_receipts', R.kim.OID).length === 1 &&
      of('offer_revisions', R.tan.OID).length === 2 &&
      of('offer_keys', R.tan.OID).filter((k) => k.act === 'issue').length === 2,
    '2.11 responses, receipts, revisions and idempotency keys are on the rows',
  );
  // The server judges a row's integrity on every read, and a row that fails it reads 500 OFFER_STATE_UNKNOWN.
  ok(
    ['kola', 'kim', 'chi', 'sven', 'tan'].every((who) => R.before[who]?.id === R[who].OID),
    '2.12 every stored row passes the integrity rules: the club read each one',
  );
}

// ------------------------------------------------------------- 3 — reboot
section('3 — after the reboot: identical views, keys replay, immutability and revs hold');
{
  const s = await bootOn(DIR, PORT);
  ok(s.up && !/applied/.test(s.log()), '3.1 rebooted on the same store with no migration applied');
  const { j } = s;
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const kim = (await j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
  const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan']) {
    const now = (await j('GET', `/org/offers/${R[who].OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer;
    ok(
      JSON.stringify(now) === JSON.stringify(R.before[who]),
      `3.2 ${who}: the club view is byte-identical after the reboot`,
    );
    const hist = (await j('GET', `/org/offers/${R[who].OID}/history`, undefined, maria.token)).body.items;
    ok(JSON.stringify(hist) === JSON.stringify(R.before[`${who}_hist`]), `3.3 ${who}: the history is byte-identical`);
    ok(
      (await journey(R[who].RID)).lifecycle.currentStage === R.before.stages[who],
      `3.4 ${who}: the case is still at ${R.before.stages[who]}`,
    );
  }
  ok(
    JSON.stringify((await j('GET', `/player/offers/${R.kim.OID}`, undefined, kim, at(T0 + 3 * H))).body.offer) ===
      JSON.stringify(R.before.kimRecipient),
    "3.5 Kim's recipient view is byte-identical (the read receipt was already there, so no new one)",
  );
  ok(
    (await j('GET', `/org/offers/${R.kola.OID}`, undefined, maria.token)).body.offer.currentRevision.internalNote ===
      S_NOTE,
    "3.6 the draft's internal note persisted",
  );
  // keys replay
  ok(
    (
      await j(
        'POST',
        `/org/rooms/${R.kola.RID}/offers`,
        { terms: { role: 'Winger' }, internalNote: S_NOTE, clientKey: 'P-create-kola' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.7 the create key replays',
  );
  ok(
    (
      await j(
        'POST',
        `/org/offers/${R.tan.OID}/issue`,
        { expectedRev: 1, clientKey: 'P-issue-tan-2' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.8 the issue key of revision 2 replays (before the rev is checked)',
  );
  neg(
    (
      await j(
        'POST',
        `/org/offers/${R.tan.OID}/issue`,
        { expectedRev: 1, clientKey: 'P-issue-tan-1' },
        maria.token,
        at(T0),
      )
    ).body.error === 'OFFER_IDEMPOTENCY_CONFLICT',
    '3.9 the issue key of revision 1 is a conflict — keys are never overwritten',
  );
  ok(
    (
      await j(
        'POST',
        `/player/offers/${R.kim.OID}/accept`,
        { revisionId: R.kim.R1, clientKey: 'P-accept-kim' },
        kim,
        at(T0),
      )
    ).body.idempotent === true,
    '3.10 the accept key replays',
  );
  ok(
    (
      await j(
        'POST',
        `/org/offers/${R.sven.OID}/withdraw`,
        { expectedRev: 1, clientKey: 'P-withdraw-sven' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.11 the withdraw key replays',
  );
  ok(
    (
      await j(
        'POST',
        `/org/offers/${R.tan.OID}/revise`,
        { expectedRev: 1, clientKey: 'P-revise-tan' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.12 the revise key replays',
  );
  // immutability and revs
  neg(
    (
      await j(
        'PATCH',
        `/org/offers/${R.kim.OID}/draft`,
        { terms: { role: 'Striker' }, expectedRev: R.before.kim.rev },
        maria.token,
        at(T0),
      )
    ).body.error === 'OFFER_STATE_INVALID',
    '3.13 the accepted revision cannot be edited',
  );
  neg(
    (
      await j(
        'PATCH',
        `/org/offers/${R.kola.OID}/draft`,
        { terms: { role: 'Striker' }, expectedRev: 99 },
        maria.token,
        at(T0),
      )
    ).body.error === 'OFFER_REV_CONFLICT',
    '3.14 a stale rev on the draft is still a conflict',
  );
  const e = await j(
    'PATCH',
    `/org/offers/${R.kola.OID}/draft`,
    { terms: { role: 'Striker' }, expectedRev: R.before.kola.rev },
    maria.token,
    at(T0),
  );
  ok(
    e.status === 200 && e.body.offer.rev === R.before.kola.rev + 1,
    '3.15 the right rev edits the draft and moves it one',
  );
  neg(
    (
      await j(
        'POST',
        `/player/offers/${R.tan.OID}/accept`,
        { revisionId: R.tan.R1, clientKey: key() },
        (
          await j('POST', '/auth/player/login', { playerId: 'pl-tanaka' })
        ).body.token,
        at(T0 + 3 * H),
      )
    ).body.error === 'OFFER_SUPERSEDED',
    '3.16 the superseded revision is still not answerable',
  );
  const a = await j(
    'POST',
    `/player/offers/${R.tan.OID}/accept`,
    { revisionId: R.tan.R2, clientKey: key() },
    (await j('POST', '/auth/player/login', { playerId: 'pl-tanaka' })).body.token,
    at(T0 + 3 * H),
  );
  ok(
    a.status === 200 && a.body.lifecycle.to === 'offer_accepted',
    '3.17 the live revision 2 is, and the case moves — the lifecycle coupling survived the reboot',
  );
  neg(
    a.body.signing?.created === false && (await journey(R.tan.RID)).outcome.signing === null,
    '3.18 and still no signing',
  );
  const sound = [];
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan'])
    sound.push((await j('GET', `/org/offers/${R[who].OID}`, undefined, maria.token, at(T0 + 3 * H))).status === 200);
  const db = await s.stop();
  ok(
    db.recruitment_offers.length === 5 && sound.every(Boolean),
    '3.19 five sound rows after the second stop (the club read each one before it)',
  );
  R.db = db;
}

// --------------------------------------------------------- 4 — corruption
section('4 — a corrupt Offer row is named and refused, never repaired, and never moves a case');
{
  const db = R.db;
  const offerRow = (id) => db.recruitment_offers.find((o) => o.id === id);
  // An Offer with no revision is a row the tables cannot hold: the schema REFUSES it (its current revision must be
  // one of its revisions) and nothing is written — the directory keeps the five sound rows. An ACCEPTED row with no
  // response is a typed row (every column valid) whose states disagree: it is still planted, and still judged on read.
  const corrupt = {
    ...offerRow(R.sven.OID),
    id: 'rof-corrupt',
    create_key: null,
    create_fp: null,
    current_revision_id: 'rofr-none',
    status: 'ISSUED',
  };
  const offersBefore = offerRows(DIR);
  let refused = null;
  try {
    plant(DIR, [['recruitment_offers', [corrupt]]]);
  } catch (e) {
    refused = e;
  }
  neg(
    /FOREIGN KEY constraint failed/.test(refused?.message) && offerRows(DIR) === offersBefore,
    `4.2 an Offer with no revision cannot be stored: the schema refuses it, and nothing was written (${String(refused?.message ?? 'no refusal').slice(0, 120)})`,
  );
  const fake = {
    ...offerRow(R.kola.OID),
    id: 'rof-fake-accepted',
    status: 'ACCEPTED',
    current_revision_id: 'rofr-f1',
    create_key: null,
    create_fp: null,
    agent_share_user_id: null,
    agent_share_agreement_id: null,
    agent_share_at: null,
    agent_share_by_kind: null,
    agent_share_by_id: null,
    lifecycle_applied: null,
    lifecycle_action: null,
    lifecycle_reason: null,
    lifecycle_message: null,
    lifecycle_allowed_json: null,
    lifecycle_from: null,
    lifecycle_to: null,
    lifecycle_at: null,
    created_at: T0,
    rev: 1,
  };
  const fakeRevision = {
    ...db.offer_revisions.find((r) => r.offer_id === R.kola.OID && r.position === 0),
    id: 'rofr-f1',
    offer_id: 'rof-fake-accepted',
    position: 0,
    revision_number: 1,
    status: 'ACCEPTED',
    issued_at: T0,
    expires_at: T0 + DAY,
    responded_at: null,
    response_id: null,
    supersedes_revision_id: null,
    superseded_by_revision_id: null,
    superseded_at: null,
    discarded_by_response_id: null,
  };
  const kolaStage = db.recruitment_cases.find((c) => c.id === R.kola.RID).room_status;
  // additive: the five sound rows stay as the server left them
  plant(DIR, [
    ['recruitment_offers', [fake]],
    ['offer_revisions', [fakeRevision]],
  ]);
  const s = await bootOn(DIR, PORT);
  ok(s.up, '4.1 the server boots with a corrupt row present — corruption is not fatal to the process');
  const { j } = s;
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
  const r = await j('GET', '/org/offers/rof-fake-accepted', undefined, maria.token);
  neg(
    r.status === 500 && r.body.error === 'OFFER_STATE_UNKNOWN' && !has(r.body, 'revisions') && !has(r.body, 'stack'),
    '4.2b the club reading the corrupt row gets a generic 500 OFFER_STATE_UNKNOWN — named, not repaired, nothing internal in the body',
  );
  neg(
    (await j('GET', '/org/offers/rof-fake-accepted', undefined, maria.token)).status === 500,
    '4.3 an ACCEPTED row with no response is corruption too',
  );
  const jr = (await j('GET', `/org/rooms/${R.kola.RID}/journey`, undefined, maria.token)).body;
  neg(
    jr.lifecycle.currentStage === kolaStage &&
      !has(jr.offer.records, 'rof-fake-accepted') &&
      jr.offer.records.some((o) => o.id === R.kola.OID),
    "4.4 Kola's case did not move and the journey omits the fake row while listing the real one",
  );
  neg(
    (
      await j(
        'POST',
        `/org/rooms/${R.kola.RID}/lifecycle`,
        { action: 'recordOfferAccepted', expectedRev: jr.case.rev },
        maria.token,
      )
    ).status >= 400,
    '4.5 a fabricated ACCEPTED row is not acceptance evidence: recordOfferAccepted is refused',
  );
  neg(
    !(await j('GET', '/player/offers', undefined, kola, at(T0))).body.items.some((o) => o.id === 'rof-fake-accepted'),
    '4.6 the recipient list omits it',
  );
  ok(
    (await j('GET', `/org/offers/${R.kim.OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer.status ===
      'ACCEPTED',
    '4.7 a sound neighbour still reads',
  );
  const db2 = await s.stop();
  neg(
    db2.recruitment_offers.length === 6 &&
      db2.offer_responses.filter((r) => r.offer_id === 'rof-fake-accepted').length === 0 &&
      db2.recruitment_offers.find((o) => o.id === 'rof-fake-accepted').status === 'ACCEPTED',
    '4.8 nothing was repaired or dropped on boot or on stop',
  );
  R.db2 = db2;
}

// ------------------------------------------------- 5 — hardening after a restart
section(
  '5 — lazy expiry, temporal corruption, unknown statuses, legacy rows, the latest-revision pointer and the same-agency rule after a restart',
);
{
  const db = R.db2;
  const issuedRow = db.recruitment_offers.find((o) => o.id === R.chi.OID); // an ISSUED→DECLINED shape to clone from
  const issuedRevision = db.offer_revisions.find((r) => r.offer_id === R.chi.OID && r.position === 0);
  // A planted Offer: its row, its revisions in order, and its responses. No keys, receipts or history.
  const fresh = (id, patch, revisions, responses = []) => ({
    offer: { ...issuedRow, id, create_key: null, create_fp: null, ...patch },
    revisions: revisions.map((r, position) => ({ ...r, offer_id: id, position })),
    responses: responses.map((r, position) => ({ ...r, offer_id: id, position })),
  });
  const rev = ({ rid, ...patch }) => ({
    ...issuedRevision,
    id: `rofr-${rid}`,
    revision_number: 1,
    status: 'ISSUED',
    responded_at: null,
    response_id: null,
    supersedes_revision_id: null,
    superseded_by_revision_id: null,
    superseded_at: null,
    discarded_by_response_id: null,
    ...patch,
  });
  // A typed response by Chi.
  const answer = (id, revisionId, responseType, occurredAt) => ({
    id,
    revision_id: revisionId,
    response_type: responseType,
    actor_type: 'player',
    actor_id: 'pl-okafor',
    actor_name: null,
    for_player_id: issuedRow.player_id,
    occurred_at: occurredAt,
    reason: null,
    client_key: null,
  });
  // a) an ISSUED row whose expiry has passed at the read instant: stored ISSUED, read EXPIRED, never rewritten
  const svenCase = db.recruitment_cases.find((c) => c.id === R.sven.RID);
  const lazy = fresh(
    'rof-lazy',
    { case_id: R.sven.RID, player_id: 'pl-svensson', status: 'ISSUED', current_revision_id: 'rofr-lazy' },
    [rev({ rid: 'lazy', created_at: T0, issued_at: T0, expires_at: T0 + 2 * H, recipient_player_id: 'pl-svensson' })],
  );
  // b) temporal corruption: issued before created; responded before issued; expiry beyond the bound; a future issue instant
  const tIssuedBeforeCreated = fresh('rof-t1', { status: 'ISSUED', current_revision_id: 'rofr-t1' }, [
    rev({ rid: 't1', created_at: T0 + H, issued_at: T0, expires_at: T0 + DAY }),
  ]);
  const tExpiryBound = fresh('rof-t2', { status: 'ISSUED', current_revision_id: 'rofr-t2' }, [
    rev({ rid: 't2', created_at: T0, issued_at: T0, expires_at: T0 + 400 * DAY }),
  ]);
  const tRespondedBeforeIssued = fresh(
    'rof-t3',
    { status: 'DECLINED', current_revision_id: 'rofr-t3' },
    [
      rev({
        rid: 't3',
        created_at: T0,
        issued_at: T0 + H,
        expires_at: T0 + DAY,
        status: 'DECLINED',
        responded_at: T0,
        response_id: 'rsp-t3',
      }),
    ],
    [answer('rsp-t3', 'rofr-t3', 'declined', T0)],
  );
  const tUnknownStatus = fresh('rof-t4', { status: 'SIGNED', current_revision_id: 'rofr-t4' }, [
    rev({ rid: 't4', status: 'SIGNED' }),
  ]);
  const tRevisionUnknown = fresh('rof-t5', { status: 'ISSUED', current_revision_id: 'rofr-t5' }, [
    rev({ rid: 't5', status: 'countersigned' }),
  ]);
  const tPointer = fresh('rof-t6', { status: 'ISSUED', current_revision_id: 'rofr-t6a' }, [
    rev({ rid: 't6a', revision_number: 1, status: 'SUPERSEDED', superseded_by_revision_id: 'rofr-t6b' }),
    rev({ rid: 't6b', revision_number: 2, status: 'ISSUED', supersedes_revision_id: 'rofr-t6a' }),
  ]); // pointer at a non-latest revision
  const tNegativeNumber = fresh('rof-t7', { status: 'ISSUED', current_revision_id: 'rofr-t7' }, [
    rev({ rid: 't7', revision_number: 0 }),
  ]);
  // c) case/Offer disagreement: an ACCEPTED Offer on a case the lifecycle says declined
  const disagree = fresh(
    'rof-t8',
    { status: 'ACCEPTED', current_revision_id: 'rofr-t8' },
    [rev({ rid: 't8', status: 'ACCEPTED', responded_at: T0 + 2 * H, response_id: 'rsp-t8' })],
    [answer('rsp-t8', 'rofr-t8', 'accepted', T0 + 2 * H)],
  );
  // d) a legacy row: a case at offer_made with no Offer row at all (a lifecycle written by the legacy status writer)
  const martinCase = { ...svenCase, id: 'case-legacy-made', player_id: 'pl-martin', room_status: 'offer_made' };
  const tablesOf = (offers) => [
    ['recruitment_offers', offers.map((o) => o.offer)],
    ['offer_revisions', offers.flatMap((o) => o.revisions)],
    ['offer_responses', offers.flatMap((o) => o.responses)],
  ];
  // An unknown Offer status, an unknown revision status and a revision number below 1 are values the columns cannot
  // hold — the schema REFUSES each, and the directory is unchanged. The other planted rows are typed rows whose
  // values disagree (time order, bounds, pointers, the case): judged on read.
  const storedNow = offerRows(DIR);
  for (const [planted, pattern, why] of [
    [tUnknownStatus, /CHECK constraint failed: status/, 'an unknown Offer status'],
    [tRevisionUnknown, /CHECK constraint failed: status/, 'an unknown revision status'],
    [tNegativeNumber, /CHECK constraint failed: revision_number >= 1/, 'a revision number below 1'],
  ]) {
    let refusal = null;
    try {
      plant(DIR, tablesOf([planted]));
    } catch (e) {
      refusal = e;
    }
    neg(
      pattern.test(refusal?.message) && offerRows(DIR) === storedNow,
      `5.0 ${planted.offer.id} (${why}) cannot be stored: the schema refuses it, nothing written (${String(refusal?.message ?? 'no refusal').slice(0, 120)})`,
    );
  }
  plant(DIR, [
    ['recruitment_cases', [martinCase]],
    ...tablesOf([lazy, tIssuedBeforeCreated, tExpiryBound, tRespondedBeforeIssued, tPointer, disagree]),
  ]); // additive, one transaction
  const afterPlant = stored(DIR);
  const casesBefore = JSON.stringify(afterPlant.recruitment_cases.map((c) => [c.id, c.room_status]));
  const s = await bootOn(DIR, PORT);
  ok(
    s.up && !/applied/.test(s.log()),
    '5.1 the server boots over six planted rows and a legacy case — no migration, no crash',
  );
  const { j } = s;
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const sven = (await j('POST', '/auth/player/login', { playerId: 'pl-svensson' })).body.token;
  const chi = (await j('POST', '/auth/player/login', { playerId: 'pl-okafor' })).body.token;
  // a) lazy expiry
  ok(
    (await j('GET', '/org/offers/rof-lazy', undefined, maria.token, at(T0 + H))).body.offer.status === 'ISSUED',
    '5.2 before its expiry the planted ISSUED row reads ISSUED',
  );
  neg(
    (await j('GET', '/org/offers/rof-lazy', undefined, maria.token, at(T0 + 3 * H))).body.offer.status === 'EXPIRED' &&
      (await j('GET', '/org/offers/rof-lazy', undefined, maria.token, at(T0 + 3 * H))).body.offer.currentRevision
        .storedStatus === 'ISSUED',
    '5.3 after it, EXPIRED is derived at read time; the stored status is still ISSUED',
  );
  neg(
    (
      await j(
        'POST',
        '/player/offers/rof-lazy/accept',
        { revisionId: 'rofr-lazy', clientKey: key() },
        sven,
        at(T0 + 3 * H),
      )
    ).body.error === 'OFFER_EXPIRED',
    '5.4 and an acceptance after expiry is refused after the restart — no background job was needed',
  );
  // b) temporal corruption and unknown statuses fail closed, named, never repaired
  for (const [id, why] of [
    ['rof-t1', 'issued before it was created'],
    ['rof-t2', 'an expiry beyond the bound'],
    ['rof-t3', 'responded before it was issued'],
    ['rof-t6', 'a current-revision pointer at a superseded revision'],
  ]) {
    const r = await j('GET', `/org/offers/${id}`, undefined, maria.token, at(T0 + H));
    neg(
      r.status === 500 && r.body.error === 'OFFER_STATE_UNKNOWN' && !has(r.body, 'revisions') && !has(r.body, 'stack'),
      `5.5 ${id} (${why}): 500 OFFER_STATE_UNKNOWN, nothing internal in the body`,
    );
    const m = await j(
      'POST',
      `/org/offers/${id}/withdraw`,
      { expectedRev: 1, clientKey: key() },
      maria.token,
      at(T0 + H),
    );
    neg(
      m.status === 500 && m.body.error === 'OFFER_STATE_UNKNOWN',
      `5.6 ${id}: a mutation on it is refused the same way — no repair through a write`,
    );
  }
  neg(
    !(await j('GET', '/player/offers', undefined, chi, at(T0 + H))).body.items.some((o) => /^rof-t/.test(o.id)),
    '5.7 the recipient list omits every planted row',
  );
  // c) Offer/case disagreement
  const dr = await j('GET', '/org/offers/rof-t8', undefined, maria.token, at(T0 + 3 * H));
  neg(
    dr.status === 500 && dr.body.error === 'OFFER_STATE_UNKNOWN',
    '5.8 an ACCEPTED Offer on a case the lifecycle says offer_declined is refused as corruption (ACCEPTED_BUT_CASE_DECLINED)',
  );
  const chiJourney = (await j('GET', `/org/rooms/${R.chi.RID}/journey`, undefined, maria.token)).body;
  neg(chiJourney.lifecycle.currentStage === 'offer_declined', '5.9 the case did not move to match the planted row');
  // d) the legacy case at offer_made with no Offer row
  const lj = await j('GET', '/org/rooms/case-legacy-made/journey', undefined, maria.token);
  neg(
    lj.status === 200 && lj.body.lifecycle.currentStage === 'offer_made' && lj.body.offer.records.length === 0,
    '5.10 a legacy case at offer_made with no Offer row is reported as it is: at offer_made, with no Offer invented',
  );
  const ls = await j('GET', '/org/rooms/case-legacy-made/offers', undefined, maria.token, at(T0));
  neg(
    ls.status === 200 && ls.body.offers.length === 0 && ls.body.requirements.draftBlockers.includes('CASE_STATE'),
    '5.11 its Offer surface lists nothing and refuses a draft by case state',
  );
  neg(
    (
      await j(
        'POST',
        '/org/rooms/case-legacy-made/lifecycle',
        { action: 'recordOfferAccepted', expectedRev: lj.body.case.rev },
        maria.token,
      )
    ).status >= 400,
    '5.12 and the lifecycle cannot record an acceptance no Offer evidences',
  );
  neg(
    !(
      await j(
        'GET',
        '/player/offers',
        undefined,
        (
          await j('POST', '/auth/player/login', { playerId: 'pl-martin' })
        ).body.token,
        at(T0),
      )
    ).body.items.length,
    "5.13 the legacy case's player sees no Offer",
  );
  // e) the latest-revision pointer of a sound multi-revision Offer survives
  const tan = (await j('GET', `/org/offers/${R.tan.OID}`, undefined, maria.token, at(T0 + 3 * H))).body.offer;
  ok(
    tan.currentRevision.revisionNumber === 2 &&
      tan.currentRevisionId === R.tan.R2 &&
      tan.revisions.find((r) => r.id === R.tan.R1).status === 'SUPERSEDED',
    "5.14 Tanaka's current revision is still revision 2; revision 1 is still SUPERSEDED",
  );
  // f) the same-agency rule after a restart (a share made before the restart)
  const alex = (
    await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Director' })
  ).body;
  await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
  await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
  const ana = (
    await j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Ana Agent',
      role: 'Agent',
      platform: 'agent',
    })
  ).body;
  const bea = (
    await j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Bea Agent',
      role: 'Agent',
      platform: 'agent',
    })
  ).body;
  for (const a of [ana, bea]) {
    await j('POST', '/org/agent/profile', { displayName: 'x', jurisdictions: ['ENG'] }, a.token);
    await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-P' }, a.token);
    await j(
      'POST',
      '/org/agent/profile/facets/national_registration/submit',
      { reference: 'TEST-VERIFIED-P-ENG', memberAssociation: 'ENG' },
      a.token,
    );
  }
  const kim = (await j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
  const req = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-kim', scope: ['employment'], jurisdiction: 'ENG' },
    ana.token,
  );
  const REP = req.body?.relationship?.id;
  const conf = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kim);
  ok(!!REP && conf.status === 200, '5.15 Ana represents Kim (employment)');
  const sh = await j('POST', `/player/offers/${R.kim.OID}/share-agent`, {}, kim, at(Date.now()));
  ok(sh.status === 200 && sh.body.offer.agentShared === true, '5.16 Kim shares the accepted Offer with Ana');
  ok(
    (await j('GET', `/org/agent/clients/${REP}/offers`, undefined, ana.token, at(Date.now()))).body.items?.length === 1,
    '5.17 Ana reads it',
  );
  neg(
    (await j('GET', `/org/agent/clients/${REP}/offers`, undefined, bea.token, at(Date.now()))).status === 404,
    '5.18 Bea (same agency) gets NOT FOUND',
  );
  const db3 = await s.stop();
  const s2 = await bootOn(DIR, PORT);
  ok(s2.up, '5.19 rebooted');
  const ana2 = (
    await s2.j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Ana Agent',
      role: 'Agent',
      platform: 'agent',
    })
  ).body;
  const bea2 = (
    await s2.j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Bea Agent',
      role: 'Agent',
      platform: 'agent',
    })
  ).body;
  ok(
    (await s2.j('GET', `/org/agent/clients/${REP}/offers`, undefined, ana2.token, at(Date.now()))).body.items
      ?.length === 1,
    '5.20 the share survived the restart for Ana',
  );
  neg(
    (await s2.j('GET', `/org/agent/clients/${REP}/offers`, undefined, bea2.token, at(Date.now()))).status === 404,
    '5.21 and Bea still gets NOT FOUND after the restart',
  );
  const db4 = await s2.stop();
  // Every row of every Offer table that belongs to a planted Offer, every column compared.
  const isPlanted = (id) => /^rofr?-(lazy|t\d)/.test(id);
  const planted = (db) =>
    JSON.stringify(
      OFFER_TABLES.map((t) =>
        db[t].filter((r) => isPlanted(t === 'recruitment_offers' ? r.id : (r.offer_id ?? r.revision_id))),
      ),
    );
  neg(
    planted(db4) === planted(db3) && planted(db4) === planted(afterPlant),
    '5.22 none of the planted rows was repaired, reordered or dropped by two boots and two stops (every column compared)',
  );
  neg(
    JSON.stringify(db4.recruitment_cases.filter((c) => c.id !== R.kim.RID).map((c) => [c.id, c.room_status])) ===
      JSON.stringify(JSON.parse(casesBefore).filter(([id]) => id !== R.kim.RID)),
    '5.23 no case moved because of a planted row',
  );
}

console.log(
  `\nrecruitment/offersPersistence: ${passed} checks passed, ${negatives} negative (${Math.round((negatives / passed) * 100)}%)`,
);
if (process.exitCode === 1) console.error('\n✗ recruitment/offersPersistence has failures.');
else console.log('all recruitment/offersPersistence checks passed');
process.exit(process.exitCode ?? 0);
