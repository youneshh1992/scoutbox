// Contact persistence suite.
//
// THE INVARIANTS
//
//   1. The contacts are rows of recruitment_contacts,
//      there after a clean boot and after a restart — never only because a
//      module registered or a request arrived.
//   2. A fixture that carries Contact rows restores them byte-faithfully.
//      Nothing is rewritten, re-ordered or "repaired" on boot.
//   3. A corrupt Contact row is NAMED and OMITTED, never fabricated into a
//      sound-looking one, and never allowed to take the server down.
//   4. The idempotency keys live on the record, so a replay after the process
//      died is still a replay (proved over HTTP in contacts.mjs group Z;
//      re-proved here after a restart).
//
// No fixture here calls buildSeed(): the whole defect class lives in the gap between "the seed made it" and "the
// database guarantees it". Fixtures are written and read back as stored rows. The integrity rule and the evidence it
// feeds are checked over the battery's records in scripts/rules/recruitment/contactsPersistence.mjs; the repository's
// refusal of entries that have no row form (an entry that is not a record, a history that is not a list) is in
// scripts/testRecruitmentContactsOffers.mjs.

import { pickPort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFixture } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';
import contactSpec from '../support/spec/recruitment/lifecycle/contact.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const { CONTACT_STATUSES } = contactSpec;
// The table migrations a new database records, as the migrated schema lists them.
const MIGRATIONS = (() => {
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-cp-schema-')));
  try {
    return R.rows('data_migrations').map((r) => r.id);
  } finally {
    R.close();
  }
})();
const LATEST_SCHEMA = Number(MIGRATIONS.at(-1).slice(0, 4)); // the latest table migration's number

// The tables a contact is stored in.
const CONTACT_TABLES = ['recruitment_contacts', 'contact_attempts', 'contact_history'];
/** What a stopped server left: the contact tables, the requests and the cases, as stored rows. */
const stored = (dir) => {
  const R = readRows(dir);
  try {
    return Object.fromEntries(
      [...CONTACT_TABLES, 'recruitment_requests', 'recruitment_cases'].map((t) => [t, R.rows(t)]),
    );
  } finally {
    R.close();
  }
};
/** Every contact row in every contact table, as text to compare. */
const contactRows = (s) => JSON.stringify(CONTACT_TABLES.map((t) => s[t]));
/** The whole database, as text: the yardstick for "nothing was written". */
const everything = (dir) => {
  const R = readRows(dir);
  try {
    return JSON.stringify(R.all());
  } finally {
    R.close();
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

/** Boot the real server on a directory; return a client and a stop() that SIGTERMs and reads the stored rows back. */
async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SCOUTBOX_QUIET_LOGS: '1' },
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

const PORT = pickPort(5600, 200, [0, 1, 2, 3, 4, 5, 6]);
const NOW = Date.now(); // when the fixtures are installed: the migrated schema's own rows carry it

// ------------------------------------------------------------- fixtures, as stored rows

const CLUB = (id, name) => ({
  id,
  name,
  type: 'club',
  level: 'pro',
  plan: 'Pro',
  lat: 51.5,
  lng: -0.1,
  trusted_partner: 0,
  verified: 1,
  safeguarding_contract_signed: 1,
  suspended: 0,
  email_domain_verified: 0,
  mfa_required_for_leads: 0,
  created_at: NOW,
});

/** A minimal, sound database with one verified club, one adult player, one case at contact_planned. A request names
 *  its staff member by a real key (recruitment_requests.user_id → org_users), so the fixture carries the staff row the
 *  case and the request name (the dev login below finds it by org and name). */
const baseRows = () => ({
  orgs: [CLUB('org-x', 'X FC')],
  org_users: [
    {
      id: 'usr-owner',
      org_id: 'org-x',
      name: 'Owner',
      name_key: 'owner',
      role: 'Head of Recruitment',
      created_at: 1,
      email_enabled: 1,
    },
  ],
  players: [
    {
      id: 'pl-x',
      name: 'Xavier Adult',
      birth_date: '2000-05-05',
      country: 'GB',
      city: 'London',
      academy_plus: 0,
      first_team_seeker: 0,
      availability: 'not_seeking',
      contract_status: 'unknown',
      level: 'amateur',
      identity_verified: 0,
      lat: 51.5,
      lng: -0.1,
      medical_shared: 0,
      medical_condition_status: 'unknown',
      profile_signal: 30,
    },
  ],
  recruitment_cases: [
    {
      id: 'case-x',
      org_id: 'org-x',
      player_id: 'pl-x',
      player_name: 'Xavier Adult',
      owner_user_id: 'usr-owner',
      owner_name: 'Owner',
      stage: 'review',
      priority: 'medium',
      restricted: 0,
      created_at: 1000,
      room_status: 'contact_planned',
      room_priority: 'normal',
      room_lead_scout_user_id: 'usr-owner',
      room_source_context: 'search',
      room_updated_at: 1000,
      room_rev: 2,
      room_rev_at: 1000,
    },
  ],
  case_history: [
    {
      case_id: 'case-x',
      position: 0,
      id: 'aud-1',
      at: 1000,
      action: 'room_created',
      by_kind: 'org',
      by_id: 'usr-owner',
      by_name: 'Owner',
      detail_json: JSON.stringify({ status: 'watching' }),
    },
    {
      case_id: 'case-x',
      position: 1,
      id: 'aud-2',
      at: 1001,
      action: 'room_status_changed',
      by_kind: 'org',
      by_id: 'usr-owner',
      by_name: 'Owner',
      detail_json: JSON.stringify({ from: 'watching', to: 'contact_planned', reasonCodes: [] }),
    },
  ],
});

const OWNER = { by_kind: 'org', by_user_id: 'usr-owner', by_name: 'Owner' };
/** A contact history entry: `by` is the staff member unless given. */
const entry = (position, id, at, action, detail, by = OWNER) => ({
  id,
  position,
  at,
  action,
  ...by,
  detail_json: detail === undefined ? null : JSON.stringify(detail),
});
// A contact that was never sent: no recipient, no send, no keys.
const NO_RECIPIENT = { recipient_type: null, recipient_player_id: null, recipient_minor: null };
const NOT_SENT = { sent_by_user_id: null, sent_by_name: null, sent_at: null, delivered_at: null, request_id: null };
const NO_KEYS = { create_key: null, create_fp: null, send_key: null, send_fp: null };

/** A sound contact delivered in the app, with its one attempt and its history, in its rows. `over` changes the
 *  recruitment_contacts row; `attempts` and `history` replace the child rows. */
const soundContact = (
  over = {},
  {
    attempts = [{ position: 0, at: 2001, ok: 1 }],
    history = [
      entry(0, 'aud-10', 2000, 'contact_created', { channel: 'in_app' }),
      entry(1, 'aud-11', 2001, 'contact_sent', { channel: 'in_app', recipientType: 'player', attempt: 1 }),
    ],
  } = {},
) => {
  const id = over.id ?? 'rct-1';
  return {
    recruitment_contacts: [
      {
        id,
        org_id: 'org-x',
        case_id: 'case-x',
        player_id: 'pl-x',
        status: 'delivered',
        channel: 'in_app',
        contact_mode: 'player_only',
        recipient_type: 'player',
        recipient_player_id: 'pl-x',
        recipient_minor: 0,
        subject: 'Hello',
        body: 'Hi Xavier.',
        created_by_user_id: 'usr-owner',
        created_by_name: 'Owner',
        created_at: 2000,
        updated_at: 2001,
        sent_by_user_id: 'usr-owner',
        sent_by_name: 'Owner',
        sent_at: 2001,
        delivered_at: 2001,
        request_id: 'req-1',
        create_key: 'ck-1',
        create_fp: '{"body":"Hi Xavier.","subject":"Hello"}',
        send_key: 'sk-1',
        send_fp: '{"contactId":"rct-1"}',
        rev: 2,
        rev_at: 2001,
        rev_by_user_id: 'usr-owner',
        rev_by_name: 'Owner',
        policy_version: 1,
        ...over,
      },
    ],
    contact_attempts: attempts.map((a) => ({ contact_id: id, ...a })),
    contact_history: history.map((h) => ({ contact_id: id, ...h })),
  };
};

/** The contact request a send issues for contact `contactId` (issueRecruitmentRequest's literal: the staff member and
 *  the organisation's flags it always sets). */
const contactRequest = (id, contactId, over = {}) => ({
  id,
  player_id: 'pl-x',
  player_name: 'Xavier Adult',
  org_id: 'org-x',
  org_name: 'X FC',
  org_type: 'club',
  org_verified: 1,
  org_safeguarding_certified: 1,
  user_id: 'usr-owner',
  scout_name: 'Owner',
  scout_role: 'Head of Recruitment',
  type: 'contact',
  message: 'Hi Xavier.',
  contact_id: contactId,
  status: 'pending',
  created_at: 2001,
  routed_to: 'player',
  ...over,
});

const merge = (...sets) => {
  const out = {};
  for (const s of sets) for (const [t, rs] of Object.entries(s)) out[t] = [...(out[t] ?? []), ...rs];
  return out;
};

/** Write `tables` into `dir` in one transaction: a row the schema refuses refuses the whole fixture. */
const write = (dir, tables) => {
  const F = openFixture(dir, { now: NOW });
  try {
    F.transaction(() => {
      if (F.fresh) F.markInstalled();
      F.sql.exec('PRAGMA defer_foreign_keys = ON'); // a sent contact and its request name each other
      for (const [table, rs] of Object.entries(tables)) for (const r of rs) F.insert(table, r);
      F.raiseIdCounter(500);
    });
  } finally {
    F.close();
  }
  return dir;
};

// The table-migration ledger of a stopped server's file: every id with the time it was applied.
const ledger = (dir) => {
  const db = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    return JSON.stringify(db.prepare('SELECT id, applied_at FROM data_migrations ORDER BY id').all());
  } finally {
    db.close();
  }
};

// ======================================================= the guarantee
section('the store is guaranteed by the schema, on every path');
{
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-cp-tables-')));
  try {
    ok(
      R.tables().includes('recruitment_contacts') &&
        MIGRATIONS.filter((m) => m === '0017_recruitment_contacts_offers').length === 1,
      'recruitment_contacts is a table, created by migration 0017 (read through SQL)',
    );
  } finally {
    R.close();
  }
}

// ======================================================= byte-faithful restore
section('a fixture with Contact rows restores byte-faithfully through a real boot');
const RESTORE_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-restore-'));
{
  const rows = merge(
    baseRows(),
    soundContact(),
    soundContact(
      { id: 'rct-2', status: 'draft', ...NO_RECIPIENT, ...NOT_SENT, ...NO_KEYS, rev: 1, rev_at: 3000 },
      { attempts: [], history: [entry(0, 'aud-20', 3000, 'contact_created', { channel: 'in_app' })] },
    ),
    soundContact(
      {
        id: 'rct-3',
        status: 'recorded',
        channel: 'phone',
        subject: null,
        body: null,
        summary: 'Called.',
        occurred_at: 3500,
        recorded_by_user_id: 'usr-owner',
        recorded_by_name: 'Owner',
        recorded_at: 3600,
        ...NOT_SENT,
        ...NO_KEYS,
        record_key: 'rk-1',
        record_fp: 'x',
      },
      {
        attempts: [],
        history: [
          entry(0, 'aud-30', 3600, 'contact_external_recorded', {
            channel: 'phone',
            occurredAt: 3500,
            recipientType: 'player',
          }),
        ],
      },
    ),
    // A sent contact and its request are a PAIR (recruitment_contacts.request_id is a real key and the request names
    // its contact back); two contacts naming ONE request is a state the production writer never produces (the send
    // creates the request for that contact). The responded contact therefore carries its own request, as a real one
    // would.
    soundContact(
      {
        id: 'rct-4',
        status: 'responded',
        request_id: 'req-4',
        responded_at: 4000,
        response_kind: 'accepted',
        response_message: 'Yes',
        response_by: 'player',
        response_at: 4000,
        rev: 3,
      },
      {
        history: [
          entry(0, 'aud-40', 2001, 'contact_sent', {}),
          entry(1, 'aud-41', 4000, 'contact_responded', { kind: 'accepted' }, { by_kind: 'player', by_name: 'Player' }),
        ],
      },
    ),
    {
      recruitment_requests: [
        contactRequest('req-1', 'rct-1'),
        contactRequest('req-4', 'rct-4', { status: 'accepted', responded_at: 4000, responded_by: 'player' }),
      ],
    },
  );
  write(RESTORE_DIR, rows);
  const L0 = ledger(RESTORE_DIR);
  const before = contactRows(stored(RESTORE_DIR));

  const s = await bootOn(RESTORE_DIR, PORT);
  ok(s.up, 'the server boots on the fixture');
  if (!s.up) {
    console.error(`   the server did not come up; its log ends:\n${s.log().slice(-1500)}`);
    process.exit(1);
  }
  const health = (await s.j('GET', '/healthz')).body;
  ok(health.schemaVersion === LATEST_SCHEMA, 'and reports the current schema');
  neg(!/STORE_MISSING|INTEGRITY/.test(s.log()), 'no missing store and no integrity violation was logged');
  const owner = (
    await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(
    list.status === 200 && list.body.items.length === 4 && list.body.omitted === 0,
    'all four restored contacts are listed, none omitted',
  );
  ok(
    list.body.items.map((c) => c.status).join(',') === 'delivered,draft,recorded,responded',
    'in creation order with their restored states',
  );
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, owner.token);
  ok(jr.status === 200 && jr.body.contact.contacts.length === 4, 'the journey projects them');
  const replay = await s.j(
    'POST',
    '/org/rooms/case-x/contacts/rct-1/send',
    { expectedRev: 999, clientKey: 'sk-1' },
    owner.token,
  );
  neg(
    replay.status === 200 && replay.body.idempotent === true,
    'a send key that was only ever on disk is still a replay after the boot',
  );
  const createReplay = await s.j(
    'POST',
    '/org/rooms/case-x/contacts',
    { subject: 'Hello', body: 'Hi Xavier.', clientKey: 'ck-1' },
    owner.token,
  );
  neg(
    createReplay.status === 200 && createReplay.body.idempotent === true && createReplay.body.contact.id === 'rct-1',
    'and so is a create key',
  );
  neg(
    expect422(
      await s.j(
        'POST',
        '/org/rooms/case-x/contacts',
        { subject: 'Other', body: 'Different.', clientKey: 'ck-1' },
        owner.token,
      ),
    ),
    'and the same key with a different payload is a 409 CONTACT_IDEMPOTENCY_CONFLICT, from the snapshot',
  );
  const after = await s.stop();
  ok(after !== null, 'the server shut down and the rows were read back');
  neg(
    contactRows(after) === before,
    'the four contacts came back IDENTICAL in every row of every contact table — reads, replays and a boot rewrote nothing',
  );
  neg(
    JSON.parse(L0).length === MIGRATIONS.length && ledger(RESTORE_DIR) === L0,
    'and the migration record did not churn',
  );
}
function expect422(r) {
  return r.status === 409 && r.body?.error === 'CONTACT_IDEMPOTENCY_CONFLICT';
}

// ======================================================= corruption
section('corrupt Contact rows are named and omitted, never fabricated, and never take the server down');
const CORRUPT_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-corrupt-'));
{
  // The contacts are rows of typed tables. A row the columns cannot hold — a duplicated id, an unknown status word,
  // an off-type timestamp, a channel the vocabulary does not know, a row missing the writer's columns — and a contact
  // naming a request that is not in the file are REFUSED by the schema, and nothing is written; asserted below, one
  // directory each. The defects a typed row CAN carry (a delivered contact with no recipient, a contact answered but
  // never delivered, a row of another organisation, a player disagreeing with its case) are still planted and still
  // judged on read.
  //
  // A fixture is one transaction: a row the schema refuses (a key, a CHECK, a STRICT type, a NOT NULL) refuses the
  // whole fixture, and the directory is left as a new one with nothing written.
  const FRESH = (() => {
    const D = mkdtempSync(path.join(tmpdir(), 'sbx-cp-fresh-'));
    openFixture(D, { now: NOW }).close();
    return everything(D);
  })();
  const refusedAtCutover = async (label, port, contacts, requests, pattern) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-cp-refused-'));
    let refused = null;
    try {
      write(dir, merge(baseRows(), ...contacts, { recruitment_requests: requests }));
    } catch (err) {
      refused = err;
    }
    const msg = String(refused?.message ?? '');
    neg(
      !!refused && pattern.test(msg),
      `${label}: the write is refused and names the column (${(pattern.exec(msg) ?? ['NOT named'])[0]})`,
    );
    if (!refused || !pattern.test(msg)) console.error(`   ${label}: refused=${!!refused}; ${msg.slice(0, 700)}`);
    neg(everything(dir) === FRESH, `${label}: nothing was written — nothing imported, dropped or repaired`);
    if (port) {
      const s = await bootOn(dir, port);
      neg(s.up, `${label}: a server started on the directory boots (the refused fixture left nothing behind)`);
      if (s.up) await s.stop();
    }
  };
  const req1 = [contactRequest('req-1', 'rct-1')];
  await refusedAtCutover(
    'a duplicated id',
    PORT + 5,
    [soundContact(), soundContact({ request_id: null }, { attempts: [], history: [] })],
    req1,
    /UNIQUE constraint failed: recruitment_contacts\.id/,
  );
  await refusedAtCutover(
    'a request that is not in the file',
    PORT + 6,
    [soundContact({ request_id: 'req-ghost' })],
    [],
    /FOREIGN KEY constraint failed/,
  ); // recruitment_contacts.request_id → recruitment_requests, at COMMIT
  await refusedAtCutover(
    'an unknown status word',
    null,
    [soundContact({ id: 'rct-badstatus', status: 'sent', request_id: null })],
    [],
    /CHECK constraint failed: status/,
  );
  await refusedAtCutover(
    'a timestamp that is not an instant',
    null,
    [soundContact({ id: 'rct-badts', delivered_at: 'yesterday', request_id: null })],
    [],
    /cannot store TEXT value in INTEGER column recruitment_contacts\.delivered_at/,
  );
  await refusedAtCutover(
    'a prototype-key channel',
    null,
    [soundContact({ id: 'rct-badchan', channel: 'constructor', request_id: null })],
    [],
    /CHECK constraint failed: channel/,
  );
  await refusedAtCutover(
    "a row missing the writer's columns",
    null,
    [
      {
        recruitment_contacts: [
          {
            id: 'rct-partial',
            org_id: 'org-x',
            case_id: 'case-x',
            player_id: 'pl-x',
            status: 'draft',
            channel: 'in_app',
            rev: 1,
          },
        ],
      },
    ],
    [],
    /NOT NULL constraint failed: recruitment_contacts\.contact_mode/,
  );

  // Each sent row with its OWN request (the pair), as the writer produces; the request ids carry no contact id (the
  // journey check below looks for the corrupt ids). A history entry's id is unique across contacts, as the writer's
  // nextId makes it.
  const sent = (i, over) =>
    soundContact(
      { request_id: `rq-${i}`, ...over },
      i === 1
        ? {}
        : {
            history: [
              entry(0, `aud-10-${i - 1}`, 2000, 'contact_created', { channel: 'in_app' }),
              entry(1, `aud-11-${i - 1}`, 2001, 'contact_sent', {
                channel: 'in_app',
                recipientType: 'player',
                attempt: 1,
              }),
            ],
          },
    );
  const contacts = [
    sent(1, {}), // sound
    sent(2, { id: 'rct-norecip', ...NO_RECIPIENT }), // delivered with no recipient
    sent(3, { id: 'rct-wrongorg', org_id: 'org-other' }), // another org's row on this case id
    sent(4, { id: 'rct-wrongplayer', player_id: 'pl-other' }), // a player disagreeing with its case: structurally sound
    sent(5, { id: 'rct-impossible', status: 'responded', delivered_at: null, responded_at: 5 }), // answered, never delivered
    soundContact(
      { id: 'rct-unknownevent', status: 'draft', ...NO_RECIPIENT, ...NOT_SENT, ...NO_KEYS, rev: 1 },
      { attempts: [], history: [{ id: 'aud-99-5', position: 0, at: 1, action: '__teleported__' }] },
    ), // an unknown history event on a sound draft
  ];
  const rows = merge(baseRows(), { orgs: [CLUB('org-other', 'Other FC')] }, ...contacts);
  // The foreign row's organisation exists (org_id is a real key); the tenant filter below is unchanged.
  rows.recruitment_requests = rows.recruitment_contacts
    .filter((c) => c.request_id)
    .map((c) => contactRequest(c.request_id, c.id, { org_id: c.org_id, player_id: c.player_id }));
  // `rct-wrongorg` is NOT in this list: a row carrying another organisation's id is that organisation's row, whatever
  // case id it names. It is filtered by tenant before the shape check, never listed, never counted and, by id, answers
  // the concealing 404 — a foreign row must not become a corruption oracle for the club that can see the case.
  const expectedOmitted = ['rct-norecip', 'rct-impossible'];

  write(CORRUPT_DIR, rows);
  const before = contactRows(stored(CORRUPT_DIR));
  const s = await bootOn(CORRUPT_DIR, PORT + 1);
  ok(s.up, 'the server boots with six rows, two of them corrupt and one foreign');
  if (!s.up) {
    console.error(`   the server did not come up; its log ends:\n${s.log().slice(-1500)}`);
    process.exit(1);
  }
  const owner = (
    await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(list.status === 200, 'the contact list still answers (200)');
  const ids = list.body.items.map((c) => c.id);
  neg(
    expectedOmitted.every((id) => !ids.includes(id)),
    'every corrupt row is omitted from the list',
  );
  neg(
    list.body.omitted === expectedOmitted.length,
    `and the omission is COUNTED (${list.body.omitted}) — partial projection, never a silent one`,
  );
  ok(
    ids.includes('rct-1') && ids.includes('rct-wrongplayer') && ids.includes('rct-unknownevent'),
    'the sound rows beside them still show',
  );
  neg(
    ids.filter((id) => id === 'rct-1').length === 1,
    'the sound row is listed once (a duplicated id can no longer reach a boot: the schema refused it above, for a person to decide which is real)',
  );
  for (const id of expectedOmitted) {
    const one = await s.j('GET', `/org/rooms/case-x/contacts/${id}`, undefined, owner.token);
    neg(
      one.status === 500 && one.body?.error === 'CONTACT_STATE_UNKNOWN',
      `${id} by id answers 500 CONTACT_STATE_UNKNOWN — corruption reads as corruption`,
    );
    neg(
      !JSON.stringify(one.body).includes('status_unknown') && !JSON.stringify(one.body).includes('recipient_missing'),
      `${id}: the diagnostic names stay in the log, not the body`,
    );
  }
  neg(/CONTACT integrity rct-norecip: recipient_missing/.test(s.log()), 'the log names the row and the problem');
  const foreign = await s.j('GET', '/org/rooms/case-x/contacts/rct-wrongorg', undefined, owner.token);
  neg(
    foreign.status === 404 && foreign.body?.error === 'CONTACT_NOT_FOUND',
    "a row carrying another organisation's id on this case answers the concealing 404, not a corruption report",
  );
  neg(!ids.includes('rct-wrongorg'), 'and is not listed');
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, owner.token);
  ok(
    jr.status === 200 && jr.body.contact.omitted === expectedOmitted.length,
    'the journey projects, omits the same two and counts them',
  );
  neg(
    !JSON.stringify(jr.body).includes('rct-norecip') && !JSON.stringify(jr.body).includes('rct-impossible'),
    'no corrupt row and no invented state reaches the journey',
  );
  neg(
    !JSON.stringify(jr.body.history.entries).includes('__teleported__'),
    'an unknown history event is not rendered as a milestone',
  );
  // Boot-time integrity: contacts are not part of the boot integrity report's subject, and must not make it lie.
  const caps = (await s.j('GET', '/capabilities')).body;
  ok(caps?.integrity?.ok === true && caps.integrity.violations === 0, 'the boot integrity report is clean');
  const after = await s.stop();
  neg(
    contactRows(after) === before,
    'shutdown left the corrupt rows UNCHANGED in every row — reported, never repaired (the missing recipient and the impossible state carried as written)',
  );
}

// ======================================================= clean boot, empty
section('clean boot: empty store, first write, restart');
const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-cp-clean-'));
{
  write(CLEAN_DIR, baseRows());
  const s = await bootOn(CLEAN_DIR, PORT + 2);
  ok(s.up, 'boot on an empty contacts store');
  const owner = (
    await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const list = await s.j('GET', '/org/rooms/case-x/contacts', undefined, owner.token);
  ok(
    list.status === 200 && list.body.items.length === 0 && list.body.routing.available === true,
    'an empty store lists nothing and still previews routing',
  );
  const d = await s.j('POST', '/org/rooms/case-x/contacts', { body: 'First ever.', clientKey: 'first' }, owner.token);
  ok(d.status === 201, 'the first write lands');
  const snap1 = await s.stop();
  ok(
    snap1.recruitment_contacts.length === 1 && snap1.recruitment_contacts[0].status === 'draft',
    'and is on disk as a draft after shutdown',
  );
  const s2 = await bootOn(CLEAN_DIR, PORT + 3);
  const owner2 = (
    await s2.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const again = await s2.j(
    'POST',
    '/org/rooms/case-x/contacts',
    { body: 'First ever.', clientKey: 'first' },
    owner2.token,
  );
  neg(again.status === 200 && again.body.idempotent === true, 'after a restart the create key is still a replay');
  const sent = await s2.j(
    'POST',
    `/org/rooms/case-x/contacts/${d.body.contact.id}/send`,
    { expectedRev: d.body.contact.rev, clientKey: 'send-1' },
    owner2.token,
  );
  ok(
    sent.status === 200 && sent.body.delivered && sent.body.case?.to === 'contacted',
    'the draft written before the restart sends after it, and moves the case',
  );
  const snap2 = await s2.stop();
  ok(
    snap2.recruitment_contacts[0].status === 'delivered' &&
      snap2.recruitment_cases[0].room_status === 'contacted' &&
      snap2.recruitment_requests.length === 1,
    'contact, case and request row are all on disk together — one save, one transaction',
  );
  ok(CONTACT_STATUSES.includes(snap2.recruitment_contacts[0].status), 'with a status this build recognises');
}

const total = passed;
console.log(
  `\nrecruitment/contactsPersistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`,
);
if (process.exitCode === 1) console.error('\n✗ recruitment/contactsPersistence has failures.');
else console.log('all recruitment/contactsPersistence checks passed');
process.exit(process.exitCode ?? 0);
