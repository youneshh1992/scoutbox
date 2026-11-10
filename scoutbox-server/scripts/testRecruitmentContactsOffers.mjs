// Recruitment contacts and offers (repositories/recruitmentContactsOffers.mjs, migration 0017): the typed tables,
// typed writes and refusals, SQL reads that match a table scan, units of work and the deletion unit's redactions. The
// request key is deferred so a contact may name a request written later in the same unit. Player references are
// counted, never refused (Q8c-a, docs/decisions.md). Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { checkHistoryFeed } from './historyFeedCheck.mjs';
import { registerContact } from '../domains/recruitment/lifecycle/contactRoutes.mjs';
import { registerOffers } from '../domains/recruitment/offers/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
import { NOW, TTL, tempDir, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import {
  p4bInvitation,
  minorInvitation,
  acceptedRequest,
  scheduledTrial,
  legacyTrialRequest,
  saveFixture,
} from './recruitmentTestFixtures.mjs';
import { ROOM_CASES_FIX } from './recruitmentCasesTestFixtures.mjs';
import {
  draftContact,
  respondedContact,
  nullKeyContact,
  externalContact,
  cancelledContact,
  draftOffer,
  acceptedOffer,
  declinedOffer,
  withdrawnOffer,
  revision,
  contactRequest,
  CONTACTS_OFFERS_FIX,
  persisted,
  TX,
} from './recruitmentContactsOffersTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0017_recruitment_contacts_offers';
const COLLECTIONS = ['recruitmentContacts', 'recruitmentOffers'];
const TABLES = [
  'recruitment_contacts',
  'contact_attempts',
  'contact_history',
  'recruitment_offers',
  'offer_revisions',
  'offer_revision_documents',
  'offer_responses',
  'offer_read_receipts',
  'offer_history',
  'offer_keys',
];
const mod = await import('../repositories/recruitmentContactsOffers.mjs');
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => {
  const s = second(dir);
  try {
    return fn(s);
  } finally {
    s.close();
  }
};
const tableExistsIn = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) =>
  JSON.stringify(
    s
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => [
        r.name,
        s
          .prepare(`SELECT * FROM "${r.name}"`)
          .all()
          .map((x) => ({ ...x })),
      ]),
  );
const s8cDump = (s) =>
  JSON.stringify(
    TABLES.map((t) =>
      s
        .prepare(`SELECT * FROM ${t} ORDER BY rowid`)
        .all()
        .map((r) => ({ ...r })),
    ),
  );
const ddlOf = (s, t) =>
  s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const col = (s, sql, ...p) => {
  const r = s.prepare(sql).get(...p);
  return r ? Object.values({ ...r })[0] : undefined;
};
const RECRUITMENT_FIX = () => ({
  requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()],
  trials: [scheduledTrial()],
});
/** A contact reads back exactly as it was written. */
const storedContact = (raw) => persisted(raw);
/** An offer reads back exactly as it was written; a field the fixture leaves out reads null. */
const storedOffer = (raw) => ({ subjectRemovedAt: null, ...persisted(raw) });

/** The recruitment fixtures as one fixture; `two` overrides a contact/offer collection (undefined omits it). */
function fixtureCollections({ more = {}, ...two } = {}) {
  const fix = CONTACTS_OFFERS_FIX();
  const db = { ...ROOM_CASES_FIX(), ...RECRUITMENT_FIX(), ...more };
  for (const name of COLLECTIONS) {
    const v = Object.hasOwn(two, name) ? two[name] : fix[name];
    if (v !== undefined) db[name] = v;
  }
  return db;
}
const file = (tag, over = {}) => saveFixture(tempDir(`s8c-${tag}`), fixtureCollections(over));
const refused = (fn, pattern, label = '') => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  assert.doesNotMatch(
    String(err.message),
    /next season|winter window|Yes please|Too far|Primary Parent|Adult Signup|Spoke on the phone/,
    `${label}: ids only, never a body, a note, a reply or a name`,
  );
  return err;
};
/** Write the fixtures, with `over`, into a new database and expect the write refused, atomically: no recruitment row written. */
const refusedSave = (tag, over, pattern) => {
  const d = tempDir(`s8c-ref-${tag}`);
  refused(() => saveFixture(d, fixtureCollections(over)), pattern, tag);
  assert.equal(
    withRo(d, (s) =>
      TABLES.concat(['recruitment_cases', 'recruitment_requests', 'trials']).reduce(
        (n, t) => n + col(s, `SELECT count(*) FROM ${t}`),
        0,
      ),
    ),
    0,
    `${tag}: nothing written`,
  );
  rm(d);
};
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return {
    store,
    layer,
    unit: (w) => store.unitOfWork(w),
    repo: layer.recruitmentContactsOffers,
    recruitment: layer.recruitment,
    close: () => store.sqlite.close(),
  };
}

// ------------------------------------------------------------- the schema and the typed fixtures

test('[schema] migration 0017 is registered before 0018 and creates the ten typed STRICT tables (no lossless side column, the case key immediate and the request key deferred to COMMIT, the vocabulary CHECKs); a fresh database holds no row and no blob; the fixtures written through the repository read back as the typed expectation, their keys as columns and offer_keys rows; the live counters count the historically missing player (Q8c-a); the step never runs twice', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.ok(ids.indexOf(MIGRATION) >= 0 && ids.indexOf(MIGRATION) < ids.indexOf('0018_signings_follow_ups'));
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const empty = tempDir('s8c-empty');
  const E = openLayer(empty);
  const e = E.sqlite;
  for (const t of TABLES) {
    assert.ok(tableExistsIn(e, t), `${t} exists`);
    assert.equal(col(e, `SELECT count(*) FROM ${t}`), 0);
    assert.match(ddlOf(e, t), /STRICT/);
    assert.doesNotMatch(
      ddlOf(e, t),
      /absent_keys_json|offtype_json|extra_json|raw_json/,
      `${t} has no lossless side column`,
    );
  }
  assert.match(
    ddlOf(e, 'recruitment_contacts'),
    /case_id TEXT NOT NULL REFERENCES recruitment_cases\(id\) ON DELETE RESTRICT,/,
  );
  assert.match(
    ddlOf(e, 'recruitment_contacts'),
    /request_id TEXT REFERENCES recruitment_requests\(id\) DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    ddlOf(e, 'recruitment_contacts'),
    /status TEXT NOT NULL CHECK \(status IS NULL OR status IN \('draft','delivered','failed','responded','recorded','cancelled'\)\)/,
  );
  assert.match(
    ddlOf(e, 'offer_revisions'),
    /internal_note TEXT CHECK \(internal_note IS NULL OR length\(internal_note\) <= 2000\)/,
  );
  assert.doesNotMatch(
    ddlOf(e, 'idempotency_keys'),
    /'recruitment_contacts'|'recruitment_offers'/,
    "the keys are the owners' own columns",
  );
  assert.equal(hasBlobTable(e), false, 'no blob table');
  E.close();
  rm(empty);
  const d = file('schema');
  const back = readRecords(d);
  const s = new DatabaseSync(dbFile(d));
  s.exec('PRAGMA foreign_keys = ON');
  const after = fullDump(s);
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }).ran, []);
  assert.equal(fullDump(s), after, 'never runs twice');
  const fix = CONTACTS_OFFERS_FIX();
  assert.deepEqual(plain(back.recruitmentContacts), fix.recruitmentContacts.map(storedContact));
  assert.deepEqual(plain(back.recruitmentOffers), fix.recruitmentOffers.map(storedOffer));
  assert.deepEqual(
    back.recruitmentContacts[2].keys.send,
    { key: null, fp: '{"contactId":"rct-3"}' },
    'the null-key send',
  );
  assert.equal(Object.hasOwn(back.recruitmentOffers[1].revisions[2], 'discardedByResponseId'), true);
  assert.equal(
    Object.hasOwn(back.recruitmentOffers[1].revisions[1], 'discardedByResponseId'),
    false,
    'only the discarded draft carries the pointer',
  );
  assert.deepEqual(back.recruitmentOffers[2].lifecycle, {
    applied: false,
    action: 'considerOffer',
    from: 'offer_declined',
    to: 'offer_declined',
    at: TX.accepted + 60_000,
    reason: 'LIFECYCLE_NOT_ALLOWED',
    message: 'not from here',
    allowed: ['offer_accepted', 'withdrawn'],
  });
  assert.deepEqual(
    s
      .prepare("SELECT act, key, revision_id FROM offer_keys WHERE offer_id = 'rof-2' ORDER BY act, position")
      .all()
      .map((r) => [r.act, r.key, r.revision_id]),
    [
      ['issue', 'k-issue-1', 'rofr-2'],
      ['issue', 'k-issue-2', 'rofr-3'],
      ['revise', 'k-rev-2', 'rofr-3'],
      ['revise', 'k-rev-3', 'rofr-4'],
    ],
  );
  assert.equal(col(s, "SELECT create_key FROM recruitment_contacts WHERE id = 'rct-1'"), 'k-create-1');
  assert.equal(col(s, "SELECT record_key FROM recruitment_contacts WHERE id = 'rct-4'"), 'k-rec-4');
  assert.deepEqual(
    mod.unresolvedPlayerReferences(s),
    { recruitmentContacts: 1, recruitmentOffers: 2 },
    'pl-gone-long-ago: the cancelled contact; the withdrawn offer and its revision recipient',
  );
  s.close();
  rm(d);
});

test("[fixtures][typed] a write STOPS with the id on a record the columns cannot hold — nothing written: an unknown status, a subject over 120 characters, a field or value the tables would not store as written (an unknown field, top level and nested, an off-type rev), a list that is not a list, a current revision the offer does not hold, a response naming another offer's revision, two answers to one revision, a receipt naming a missing revision; a contact naming a case or a request that is not there", () => {
  const C = (over) => ({ recruitmentContacts: [draftContact(over)] });
  const O = (o) => ({ recruitmentOffers: [o] });
  refusedSave(
    'status',
    C({ status: 'sent' }),
    /CONTACTS_OFFERS_INPUT_INVALID: recruitment_contacts rct-1 row: CHECK constraint failed: status/,
  );
  refusedSave(
    'subject',
    C({ subject: 'x'.repeat(121) }),
    /recruitment_contacts rct-1 row: CHECK constraint failed: subject IS NULL OR length\(subject\) <= 120/,
  );
  refusedSave('unknown', C({ legacyFlag: 'kept' }), /recruitment_contacts rct-1 legacyFlag: is not stored as written/);
  refusedSave(
    'nested',
    C({ emailCopy: { state: 'queued', to: 'guardian', outboxId: null, at: NOW, extra: 1 } }),
    /recruitment_contacts rct-1 emailCopy\.extra: is not stored as written/,
  );
  refusedSave('rev', C({ rev: '1' }), /recruitment_contacts rct-1 rev: is not stored as written/);
  refusedSave(
    'attempts',
    C({ attempts: { not: 'a list' } }),
    /recruitment_contacts rct-1 attempts: must be a list \(got an object\)/,
  );
  refusedSave(
    'current',
    O(draftOffer({ currentRevisionId: 'rofr-missing' })),
    /CONTACTS_OFFERS_INPUT_INVALID: recruitment_offers rof-1 currentRevisionId: rofr-missing is not a revision of this offer/,
  );
  const foreign = acceptedOffer();
  foreign.responses[0].revisionId = 'rofr-1';
  refusedSave('foreign', O(foreign), /recruitment_offers rof-2 response rofa-1: FOREIGN KEY constraint failed/);
  const twice = acceptedOffer();
  twice.responses.push({ ...twice.responses[0], id: 'rofa-9', clientKey: null });
  refusedSave(
    'twice',
    O(twice),
    /recruitment_offers rof-2 response rofa-9: UNIQUE constraint failed: offer_responses\.offer_id, offer_responses\.revision_id/,
  );
  refusedSave(
    'receipt',
    O(
      draftOffer({
        readReceipts: [{ revisionId: 'rofr-x', viewerKind: 'player', viewerId: 'pl-adult', firstViewedAt: NOW }],
      }),
    ),
    /recruitment_offers rof-1 read receipt 0: FOREIGN KEY constraint failed/,
  );
  refusedSave(
    'actor-empty',
    { recruitmentOffers: [acceptedOffer({ responses: [{ ...acceptedOffer().responses[0], actorId: '' }] })] },
    /recruitment_offers rof-2 response rofa-1: CHECK constraint failed: length\(actor_id\) > 0/,
  );
  refusedSave(
    'offer-status',
    O(draftOffer({ status: 'SIGNED' })),
    /recruitment_offers rof-1 row: CHECK constraint failed: status/,
  );
  refusedSave(
    'revision-number',
    O(draftOffer({ revisions: [revision({ revisionNumber: 0 })] })),
    /recruitment_offers rof-1 revision rofr-1: CHECK constraint failed: revision_number >= 1/,
  );
  refusedSave(
    'calendar-day',
    O(draftOffer({ revisions: [revision({ terms: { ...revision().terms, startDate: '2026/09/01' } })] })),
    /recruitment_offers rof-1 revision rofr-1: CHECK constraint failed: term_start_date/,
  );
  refusedSave(
    'supersedes',
    O(draftOffer({ revisions: [revision({ supersedesRevisionId: 'rofr-elsewhere' })] })),
    /recruitment_offers rof-1 revision rofr-1 pointers: FOREIGN KEY constraint failed/,
  );
  refusedSave(
    'case',
    C({ caseId: 'case-nowhere' }),
    /CONTACTS_OFFERS_REFERENCE_MISSING[\s\S]*recruitment_contacts holds 1 row\(s\) naming a recruitment_cases row that is not there \(rct-1 → recruitment_cases case-nowhere\)/,
  );
  refusedSave(
    'request',
    C({
      status: 'delivered',
      requestId: 'req-nowhere',
      recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false },
    }),
    /FOREIGN KEY constraint failed/,
  ); // the deferred request key, at COMMIT
});

// ------------------------------------------------------------- the repository

test("[repository] explicit writes: there is no db.* view (reading or assigning db.recruitmentContacts / db.recruitmentOffers throws, naming the repository); every returned record is read-only (a field assignment and a nested push throw); create and update write their rows at once — a second connection sees them with no save — and return the fresh record; a contact or an offer changes only through its named acts, which refuse a move its revision's state does not allow (an issued revision's terms are never edited), a key naming another offer's revision and an unknown id; nothing is written by a save; a reopen serves the same records", () => {
  const d = file('repo');
  const L = serverOpen(d);
  const { contacts, offers } = L.repo;
  assert.throws(() => {
    contacts.byId('rct-1').status = 'cancelled';
  }, TypeError);
  assert.throws(() => {
    offers.byId('rof-2').revisions[0].documents.push({});
  }, TypeError);
  const created = contacts.create(
    draftContact({ id: 'rct-new', keys: { create: null, send: null, record: null }, history: [] }),
  );
  assert.equal(created.id, 'rct-new');
  assert.throws(() => {
    created.subject = 'x';
  }, TypeError);
  withRo(d, (s) =>
    assert.equal(col(s, "SELECT status FROM recruitment_contacts WHERE id = 'rct-new'"), 'draft', 'written at once'),
  );
  refused(
    () => contacts.create(draftContact({ id: 'rct-new' })),
    /CONTACTS_OFFERS_DUPLICATE: recruitment_contacts rct-new already exists/,
  );
  const staff = { id: 'usr-1', name: 'Maria' };
  const edit = (id, subject, history = []) =>
    contacts.editDraft(
      id,
      { subject, body: contacts.byId(id).body, contactMode: 'player_only' },
      { at: NOW, revBy: staff, touch: true, bump: true, history },
    );
  const edited = edit('rct-new', 'Edited', [
    {
      id: 'aud-e1',
      at: NOW,
      action: 'contact_edited',
      by: { kind: 'org', userId: 'usr-1', name: 'Maria' },
      detail: { fields: ['subject'] },
    },
  ]);
  assert.equal(edited.subject, 'Edited');
  assert.equal(edited.history.length, 1);
  assert.equal(edited.rev, created.rev + 1);
  assert.equal(edited.revBy.userId, 'usr-1');
  withRo(d, (s) => {
    assert.equal(col(s, "SELECT subject FROM recruitment_contacts WHERE id = 'rct-new'"), 'Edited');
    assert.equal(col(s, "SELECT action FROM contact_history WHERE contact_id = 'rct-new'"), 'contact_edited');
  });
  refused(
    () => edit('rct-new', 'x'.repeat(121)),
    /CONTACTS_OFFERS_INPUT_INVALID: recruitment_contacts rct-new editDraft: CHECK constraint failed: subject/,
  );
  contacts.cancel(
    'rct-new',
    { at: NOW, by: { kind: 'org', userId: 'usr-1', name: 'Maria' } },
    { at: NOW, revBy: staff, touch: true, bump: true },
  );
  refused(
    () => edit('rct-new', 'After cancelling'),
    /CONTACTS_OFFERS_STATE_CONFLICT: recruitment_contacts rct-new is not an editable draft/,
  );
  refused(
    () => contacts.recordResponse('rct-new', { response: { kind: 'accepted', message: null, by: 'player', at: NOW } }),
    /CONTACTS_OFFERS_STATE_CONFLICT: recruitment_contacts rct-new cannot move to responded/,
  );
  refused(() => contacts.recordAct('rct-nowhere', {}), /CONTACTS_OFFERS_NOT_FOUND/);
  assert.equal(contacts.byId('rct-new').subject, 'Edited', 'a refused act changed nothing');
  assert.equal(contacts.byId('rct-new').status, 'cancelled');
  const by = { kind: 'org', id: 'usr-1', name: 'Maria', role: 'Head of Recruitment' };
  const o = offers.addRevision(
    'rof-1',
    { revision: revision({ id: 'rofr-n', revisionNumber: 2 }) },
    {
      at: NOW,
      revBy: by,
      touch: true,
      bump: true,
      key: { act: 'revise', key: 'k-n', revisionId: 'rofr-n' },
      history: [{ id: 'aud-n', at: NOW, action: 'offer_draft_created', by, detail: { revisionId: 'rofr-n' } }],
    },
  );
  assert.equal(o.revisions.length, 2);
  assert.equal(o.currentRevisionId, 'rofr-n');
  assert.equal(o.rev, 2);
  assert.equal(o.history.at(-1).id, 'aud-n');
  withRo(d, (s) => {
    assert.equal(col(s, "SELECT count(*) FROM offer_revisions WHERE offer_id = 'rof-1'"), 2);
    assert.equal(col(s, "SELECT key FROM offer_keys WHERE offer_id = 'rof-1'"), 'k-n');
  });
  const issued = offers.issueRevision('rof-1', {
    revisionId: 'rofr-n',
    at: NOW,
    by,
    terms: revision().terms,
    recipientSnapshot: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false, at: NOW },
    readinessSnapshot: null,
  });
  assert.equal(issued.status, 'ISSUED');
  assert.equal(issued.revisions[1].issuedBy.id, 'usr-1');
  refused(
    () => offers.editDraft('rof-1', { revisionId: 'rofr-n', at: NOW, by, terms: revision().terms }),
    /CONTACTS_OFFERS_STATE_CONFLICT: offer_revisions rofr-n of recruitment_offers rof-1 is not a draft/,
  );
  refused(
    () => offers.issueRevision('rof-1', { revisionId: 'rofr-n', at: NOW, by, terms: revision().terms }),
    /CONTACTS_OFFERS_STATE_CONFLICT: offer_revisions rofr-n of recruitment_offers rof-1 cannot move to ISSUED/,
  );
  refused(
    () => offers.recordAct('rof-1', { key: { act: 'issue', key: 'k-x', revisionId: 'rofr-2' } }),
    /recruitment_offers rof-1 issue key: FOREIGN KEY constraint failed/,
  );
  refused(() => offers.recordAct('rof-nowhere', {}), /CONTACTS_OFFERS_NOT_FOUND/);
  const dump = withRo(d, s8cDump);
  assert.equal(withRo(d, s8cDump), dump, 'a save writes no contact or offer row');
  const served = plain(L.repo.exportAll());
  L.close();
  const R = serverOpen(d);
  assert.deepEqual(plain(R.repo.exportAll()), served);
  R.close();
  rm(d);
});

test('[repository] SQL reads: byId and every list query return exactly the records a scan of the tables would, in insertion order; an unknown or non-text id reads null; forPlayers takes several players and ignores junk; the read-only `reads` object carries the queries and no write', () => {
  const d = file('reads');
  const L = serverOpen(d);
  const { contacts, offers, reads } = L.repo;
  const all = { contacts: mod.readContacts(L.store.sqlite), offers: mod.readOffers(L.store.sqlite) };
  assert.ok(all.contacts.length >= 5 && all.offers.length >= 4, 'the fixture has records to query');
  const ids = (rows) => rows.map((r) => r.id);
  const values = (list, key) => [
    ...new Set(list.map((r) => key(r)).filter((v) => v !== null && v !== undefined)),
    'nobody',
  ];
  for (const c of all.contacts) assert.deepEqual(plain(contacts.byId(c.id)), plain(c));
  for (const o of all.offers) assert.deepEqual(plain(offers.byId(o.id)), plain(o));
  for (const bad of ['rct-nowhere', undefined, null, 42]) {
    assert.equal(contacts.byId(bad), null);
    assert.equal(offers.byId(bad), null);
  }
  const check = (label, got, want) => assert.deepEqual(ids(got), ids(want), label);
  for (const v of values(all.contacts, (c) => c.caseId))
    check(
      `contacts.forCase ${v}`,
      contacts.forCase(v),
      all.contacts.filter((c) => c.caseId === v),
    );
  for (const v of values(all.contacts, (c) => c.playerId))
    check(
      `contacts.forPlayer ${v}`,
      contacts.forPlayer(v),
      all.contacts.filter((c) => c.playerId === v),
    );
  for (const v of values(all.contacts, (c) => c.orgId))
    check(
      `contacts.forOrg ${v}`,
      contacts.forOrg(v),
      all.contacts.filter((c) => c.orgId === v),
    );
  for (const v of values(all.contacts, (c) => c.requestId))
    check(
      `contacts.forRequest ${v}`,
      contacts.forRequest(v),
      all.contacts.filter((c) => c.requestId === v),
    );
  for (const v of values(all.contacts, (c) => c.routingSnapshot?.agent?.agentUserId))
    check(
      `contacts.forAgent ${v}`,
      contacts.forAgent(v),
      all.contacts.filter((c) => c.routingSnapshot?.agent?.agentUserId === v),
    );
  for (const c of all.contacts)
    check(
      `contacts.forOrgPlayer ${c.orgId}/${c.playerId}`,
      contacts.forOrgPlayer(c.orgId, c.playerId),
      all.contacts.filter((x) => x.orgId === c.orgId && x.playerId === c.playerId),
    );
  for (const v of values(all.offers, (o) => o.caseId))
    check(
      `offers.forCase ${v}`,
      offers.forCase(v),
      all.offers.filter((o) => o.caseId === v),
    );
  for (const v of values(all.offers, (o) => o.playerId))
    check(
      `offers.forPlayer ${v}`,
      offers.forPlayer(v),
      all.offers.filter((o) => o.playerId === v),
    );
  for (const v of values(all.offers, (o) => o.orgId))
    check(
      `offers.forOrg ${v}`,
      offers.forOrg(v),
      all.offers.filter((o) => o.orgId === v),
    );
  for (const v of values(all.offers, (o) => o.agentShare?.agentUserId))
    check(
      `offers.forAgentShare ${v}`,
      offers.forAgentShare(v),
      all.offers.filter((o) => o.agentShare?.agentUserId === v),
    );
  for (const o of all.offers)
    check(
      `offers.forOrgPlayer ${o.orgId}/${o.playerId}`,
      offers.forOrgPlayer(o.orgId, o.playerId),
      all.offers.filter((x) => x.orgId === o.orgId && x.playerId === o.playerId),
    );
  const players = values(all.offers, (o) => o.playerId);
  check(
    'offers.forPlayers (all, with junk and a repeat)',
    offers.forPlayers([...players, players[0], 42, null]),
    all.offers.filter((o) => players.includes(o.playerId)),
  );
  assert.deepEqual(offers.forPlayers([]), []);
  assert.deepEqual(offers.forPlayers(undefined), []);
  for (const r of [...contacts.forOrg(all.contacts[0].orgId), ...offers.forOrg(all.offers[0].orgId)])
    assert.ok(Object.isFrozen(r), 'a listed record is read-only');
  for (const name of ['contacts', 'offers']) {
    assert.ok(Object.isFrozen(reads[name]));
    for (const w of [
      'create',
      'update',
      'redactPlayer',
      'editDraft',
      'issueRevision',
      'withdrawRevision',
      'addRevision',
      'recordResponse',
      'addReadReceipt',
      'setAgentShare',
      'recordAct',
    ])
      assert.equal(reads[name][w], undefined, `reads.${name} has no ${w}`);
    assert.equal(reads[name].byId, L.repo[name].byId);
  }
  assert.deepEqual(L.repo.counts(), { recruitmentContacts: all.contacts.length, recruitmentOffers: all.offers.length });
  checkHistoryFeed('contacts.historyFeed', {
    feed: L.repo.contacts.historyFeed,
    count: L.repo.contacts.historyCount,
    records: all.contacts,
    ownerKey: 'contactId',
  });
  L.close();
  rm(d);
});

test("[repository] a unit of work: a contact written in a unit together with the request it names — a NEW request the request repository writes at the same COMMIT (the deferred key) — commits; a read inside the unit sees the unit's own writes; a unit that throws after its writes rolls the rows back (the records held before read the pre-unit values, and a fresh read the stored ones); a contact naming a request that never arrives fails at COMMIT and nothing lands", () => {
  const d = file('unit');
  const L = serverOpen(d);
  const { contacts } = L.repo;
  const sent = (id, requestId) =>
    draftContact({
      id,
      status: 'delivered',
      recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false },
      requestId,
      sentAt: NOW,
      deliveredAt: NOW,
      attempts: [{ at: NOW, ok: true, code: null }],
      keys: { create: null, send: { key: null, fp: `{"contactId":"${id}"}` }, record: null },
      history: [],
    });
  L.unit(() => {
    L.recruitment.requests.create(contactRequest('req-new', 'rct-new'));
    contacts.create(sent('rct-new', 'req-new'));
  });
  withRo(d, (s) => {
    assert.equal(col(s, "SELECT request_id FROM recruitment_contacts WHERE id = 'rct-new'"), 'req-new');
    assert.equal(col(s, "SELECT contact_id FROM recruitment_requests WHERE id = 'req-new'"), 'rct-new');
  });
  const held = L.repo.contacts.byId('rct-1');
  const before = withRo(d, fullDump);
  assert.throws(
    () =>
      L.unit(() => {
        contacts.editDraft('rct-1', {
          subject: 'In the unit',
          body: contacts.byId('rct-1').body,
          contactMode: 'player_only',
        });
        contacts.create(draftContact({ id: 'rct-gone', history: [] }));
        assert.equal(contacts.byId('rct-1').subject, 'In the unit', 'a read inside the unit sees its update');
        assert.ok(
          contacts.forCase(contacts.byId('rct-gone').caseId).some((c) => c.id === 'rct-gone'),
          'and its create',
        );
        throw new Error('synthetic unit failure');
      }),
    /synthetic unit failure/,
  );
  assert.equal(withRo(d, fullDump), before, 'the rows rolled back');
  assert.equal(held.subject, 'Next season');
  assert.equal(L.repo.contacts.byId('rct-1').subject, 'Next season');
  assert.equal(L.repo.contacts.byId('rct-gone'), null, 'a fresh read sees the rollback');
  assert.throws(
    () =>
      L.unit(() => {
        contacts.create(sent('rct-dangling', 'req-never'));
      }),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal(withRo(d, fullDump), before);
  assert.equal(L.repo.contacts.byId('rct-dangling'), null);
  assert.equal(L.store.sqlite.isTransaction, false);
  L.close();
  rm(d);
});

test("[repository] the deletion unit's redactions: the contacts about the player lose the reply's words and keep everything else; the offers keep ids, states and times and lose the player's name and words (a PLAYER response's name and reason, a PLAYER history name) and gain subject_removed_at; a guardian's answer and other players' records are untouched", () => {
  const playerAnswer = {
    ...acceptedOffer().responses[0],
    id: 'rofa-p',
    revisionId: 'rofr-1',
    responseType: 'declined',
    actorType: 'player',
    actorId: 'pl-adult',
    actorName: 'Adult Signup',
    forPlayerId: 'pl-adult',
    reason: 'Too far',
    clientKey: null,
  };
  const answered = draftOffer({
    status: 'DECLINED',
    revisions: [
      revision({
        status: 'DECLINED',
        issuedAt: TX.issued,
        issuedBy: acceptedOffer().createdBy,
        expiresAt: TX.issued + 86_400_000,
        respondedAt: TX.accepted,
        response: { id: 'rofa-p' },
        recipientSnapshot: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false, at: TX.issued },
      }),
    ],
    responses: [playerAnswer],
    history: [
      {
        id: 'aud-p',
        at: TX.accepted,
        action: 'offer_declined',
        by: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' },
        detail: null,
      },
    ],
  });
  const replied = nullKeyContact({
    status: 'responded',
    respondedAt: TX.answered,
    response: { kind: 'accepted', message: 'Yes please', by: 'player', at: TX.answered },
  });
  const d = file('redact', {
    recruitmentContacts: [draftContact(), respondedContact(), replied],
    recruitmentOffers: [answered, acceptedOffer()],
  });
  const L = serverOpen(d);
  L.unit(() => {
    L.repo.contacts.redactPlayer('pl-adult');
    L.repo.offers.redactPlayer('pl-adult', NOW);
  });
  withRo(d, (s) => {
    assert.equal(col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-3'"), null);
    assert.equal(col(s, "SELECT response_kind FROM recruitment_contacts WHERE id = 'rct-3'"), 'accepted');
    assert.equal(
      col(s, "SELECT response_message FROM recruitment_contacts WHERE id = 'rct-2'"),
      'Yes please',
      "another player's reply is untouched",
    );
    assert.deepEqual(
      { ...s.prepare("SELECT actor_name, reason, response_type FROM offer_responses WHERE id = 'rofa-p'").get() },
      { actor_name: null, reason: null, response_type: 'declined' },
    );
    assert.equal(col(s, "SELECT by_name FROM offer_history WHERE id = 'aud-p'"), null);
    assert.equal(col(s, "SELECT subject_removed_at FROM recruitment_offers WHERE id = 'rof-1'"), NOW);
    assert.equal(
      col(s, "SELECT subject_removed_at FROM recruitment_offers WHERE id = 'rof-2'"),
      TX.removed,
      "another player's offer is untouched",
    );
  });
  assert.equal(L.repo.offers.byId('rof-1').responses[0].actorName, null, 'a read follows the redaction');
  L.close();
  rm(d);
});

test('[wiring] the contact routes refuse to register without the cross-app integration seam (no silent player-only fallback), and the offers without the signing summary', () => {
  const base = { recruitmentContactsOffers: { contacts: {} }, unit: () => {}, afterCommit: () => {} };
  assert.throws(
    () => registerContact(base),
    (e) => e instanceof TypeError && /integration seam/.test(e.message),
  );
  assert.throws(
    () => registerContact({ ...base, integration: { contactRoute: () => null } }),
    (e) => e instanceof TypeError && /integration seam/.test(e.message),
  );
  assert.throws(
    () => registerOffers({ recruitmentContactsOffers: { offers: {} }, unit: () => {}, afterCommit: () => {} }),
    (e) => e instanceof TypeError && /summaryForOffer/.test(e.message),
  );
});

test('[capabilities] the live report: explicit write mode, no pending writes, the typed tables and the player counters', () => {
  const d = file('caps', { recruitmentContacts: [draftContact(), cancelledContact()] });
  const L = serverOpen(d);
  const r = L.layer.report().domains.recruitmentContactsOffers;
  assert.equal(r.pendingWrites, 0);
  assert.match(r.writeMode, /^explicit/);
  assert.deepEqual(r.rows, { recruitmentContacts: 2, recruitmentOffers: 4 });
  assert.deepEqual(r.unresolvedPlayerReferences, { recruitmentContacts: 1, recruitmentOffers: 2 });
  assert.equal(Object.hasOwn(r, 'unresolvedPointerReferences'), false);
  L.close();
  rm(d);
});

console.log(`${passed} recruitment contacts/offers checks passed`);
