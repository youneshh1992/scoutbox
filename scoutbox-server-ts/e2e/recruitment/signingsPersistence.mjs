// Persistence, migration, restart and corruption audit for the signing workflow.
//
//   1  the migration: a fresh store boots at the latest schema with the signing tables
//      (0018) applied once; a later boot applies nothing; no signing, package,
//      party or actor is fabricated from a `signed` case, an `under_contract`
//      player or a legacy row
//   2  a real journey — DRAFT, READY, IN_PROGRESS, COMPLETED, CANCELLED,
//      VOIDED, a SUPERSEDED revision, a lazily EXPIRED package — survives
//      SIGTERM byte-faithfully: revisions, parties, evidence refs, document
//      digest, keys, history, the completed row, the case, the player
//   3  after the reboot: keys replay, completion is refused, db.signings stays
//      unique, the lifecycle and the player's contract state are consistent,
//      the document bytes are still there and still hash the same
//   4  planted corruption is named, refused, omitted and never repaired; a
//      legacy signed case with a legacy row and no package fabricates nothing
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openFixture } from '../support/sqlFixture.mjs';
import { readRows, rows } from '../support/sqlRows.mjs';
import { copySigning, insertPackage, PACKAGE_TABLES, setRow } from '../support/signingRows.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
// The table migrations a new database records, and its tables, as the migrated schema lists them.
const [MIGRATIONS, SCHEMA_TABLES] = (() => {
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23sp-schema-')));
  try {
    return [
      R.rows('data_migrations').map((r) => r.id),
      R.sql
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    ];
  } finally {
    R.close();
  }
})();
const LATEST_SCHEMA = Number(MIGRATIONS.at(-1).slice(0, 4)); // the latest table migration's number

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
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\n%%EOF\n`, 'latin1');
const dataUrl = (buf) => `data:application/pdf;base64,${buf.toString('base64')}`;
const DOC = pdf('persistence contract');
const SHA = sha256(DOC);
const DOC2 = pdf('persistence contract, amended');
const SHA2 = sha256(DOC2);

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
    return storedRows(dataDir);
  };
  return { up, j, stop, log: () => log };
}

/** The stored rows a stopped server left in `dir` that this battery reads, table by table. */
function storedRows(dir) {
  const R = readRows(dir);
  try {
    return {
      signing_packages: R.rows('signing_packages'),
      signing_revisions: R.rows('signing_revisions', {}, { order: 'package_id, position' }),
      signing_documents: R.rows('signing_documents', {}, { order: 'revision_id, kind' }),
      signing_revision_parties: R.rows('signing_revision_parties', {}, { order: 'revision_id, position' }),
      signing_history: R.rows('signing_history', {}, { order: 'package_id, position' }),
      idempotency_keys: R.rows('idempotency_keys', { owner_table: 'signing_packages' }),
      signings: R.rows('signings'),
      signing_parties: R.rows('signing_parties'),
      players: R.rows('players'),
      recruitment_cases: R.rows('recruitment_cases'),
      org_users: R.rows('org_users'),
      ver_evidence: R.rows('ver_evidence'),
    };
  } finally {
    R.close();
  }
}
/** Package `id`'s rows in a `storedRows` snapshot, table by table (PACKAGE_TABLES). */
function pkgRows(db, id) {
  const revs = new Set(db.signing_revisions.filter((r) => r.package_id === id).map((r) => r.id));
  return {
    signing_packages: db.signing_packages.filter((p) => p.id === id),
    signing_revisions: db.signing_revisions.filter((r) => r.package_id === id),
    signing_documents: db.signing_documents.filter((d) => revs.has(d.revision_id)),
    signing_revision_parties: db.signing_revision_parties.filter((q) => revs.has(q.revision_id)),
    signing_history: db.signing_history.filter((h) => h.package_id === id),
    idempotency_keys: db.idempotency_keys.filter((k) => k.owner_id === id),
  };
}

// The table-migration ledger of a stopped server's file: every id with the time it was applied.
const ledger = (dir) => {
  const st = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    return st
      .prepare('SELECT id, applied_at FROM data_migrations ORDER BY id')
      .all()
      .map((r) => `${r.id}@${r.applied_at}`);
  } finally {
    st.close();
  }
};

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
const S_NOTE = 'PRIVATE_SIGNING_NOTE_PERSISTS_7719';

// ------------------------------------------------------------- 1 — migration
section(
  '1 — the migration: fresh boot at the latest schema with the signing tables once, a later boot applies nothing, no fabrication',
);
{
  ok(
    MIGRATIONS.length === LATEST_SCHEMA && MIGRATIONS.includes('0018_signings_follow_ups'),
    '1.1 every table migration; the signing tables are 0018',
  );
  ok(
    SCHEMA_TABLES.includes('signing_packages') && SCHEMA_TABLES.includes('signings'),
    '1.2 signingPackages and signings are tables read through SQL',
  );
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23sp-1-'));
  const s1 = await bootOn(DIR, PORT);
  const fresh = s1.up && (await s1.j('GET', '/healthz')).body.schemaVersion === LATEST_SCHEMA;
  // the legacy case below needs a real owner row (recruitment_cases.owner_user_id is a key to org_users): Maria logs in once so her row exists
  await s1.j('POST', '/auth/org/login', {
    orgId: 'org-eastport',
    scoutName: 'Maria Keane',
    role: 'Head of Recruitment',
  });
  const db1 = await s1.stop();
  const L1 = ledger(DIR);
  ok(
    fresh &&
      L1.length === MIGRATIONS.length &&
      L1.filter((e) => e.startsWith('0018_signings_follow_ups@')).length === 1,
    '1.3 a fresh store boots at the latest schema with the signing step applied once',
  );
  ok(db1.signing_packages.length === 0, '1.4 the stopped file holds no signing package');
  // A legacy world: a case at signed with a legacy signing row, and a player under_contract with no signing at all.
  const maria = db1.org_users.find((u) => u.org_id === 'org-eastport' && u.name === 'Maria Keane');
  // The rows the Room route writes for a case, moved to signed long ago, as stored.
  const legacyCase = {
    id: 'case-legacy-signed',
    org_id: 'org-eastport',
    player_id: 'pl-svensson',
    player_name: 'Elias Svensson',
    vacancy_id: null,
    owner_user_id: maria?.id ?? null,
    owner_name: 'Maria Keane',
    stage: 'closed',
    priority: 'medium',
    deadline_day: null,
    deadline_at: null,
    restricted: 0,
    decision_outcome: null,
    decision_reasons: null,
    decision_by_user_id: null,
    decision_by_name: null,
    decision_approved_by_name: null,
    decision_at: null,
    links_signing_id: 'sign-legacy-p7',
    created_at: T0 - 30 * DAY,
    subject_removed_at: null,
    room_status: 'signed',
    room_priority: 'normal',
    room_lead_scout_user_id: null,
    room_source_context: 'direct',
    room_source_ref_id: null,
    room_source_ref_version: null,
    room_opened_by_user_id: maria?.id ?? null,
    room_opened_by_name: 'Maria Keane',
    room_updated_at: T0 - 29 * DAY,
    room_archived_at: null,
    room_closed_at: null,
    room_rev: 3,
    room_rev_at: T0 - 29 * DAY,
    room_rev_by_user_id: null,
    room_rev_by_name: null,
    room_reopened_at: null,
    room_reopened_by_user_id: null,
    room_reopened_by_name: null,
    room_reopened_from: null,
    room_reopened_reason_codes_json: null,
    room_reopened_source_context: null,
    room_reopened_source_ref_id: null,
    room_reopened_source_ref_version: null,
  };
  const legacyHistory = {
    case_id: 'case-legacy-signed',
    position: 0,
    id: 'aud-legacy-1',
    at: T0 - 29 * DAY,
    action: 'room_status_changed',
    by_kind: 'org',
    by_id: maria?.id ?? null,
    by_name: 'Legacy Lead',
    detail_text: null,
    detail_json: JSON.stringify({ from: 'offer_made', to: 'signed' }),
  };
  // The legacy recorder's facts only: every other column is left to the schema (method LEGACY_RECORDED, the rest null).
  const legacySigning = {
    id: 'sign-legacy-p7',
    player_id: 'pl-svensson',
    player_name: 'Elias Svensson',
    org_id: 'org-eastport',
    org_name: 'Eastport FC',
    user_id: maria?.id ?? null,
    scout_name: 'Legacy Lead',
    ts: T0 - 29 * DAY,
    inside_attribution_window: 0,
  };
  const casesBefore = JSON.stringify([...db1.recruitment_cases, legacyCase].map((c) => [c.id, c.room_status]));
  // Planted between boots as plain rows, in one transaction: the case, its legacy row, and Kim under contract.
  {
    const F = openFixture(DIR);
    try {
      F.transaction(() => {
        F.insert('recruitment_cases', legacyCase);
        F.insert('case_history', legacyHistory);
        F.insert('signings', legacySigning);
        setRow(F, 'players', { id: 'pl-kim' }, { contract_status: 'under_contract' });
      });
    } finally {
      F.close();
    }
  }
  const signingsBefore = JSON.stringify(rows(DIR, 'signings'));
  const s2 = await bootOn(DIR, PORT);
  ok(
    s2.up && (await s2.j('GET', '/healthz')).body.schemaVersion === LATEST_SCHEMA,
    '1.5 the planted legacy file boots at the latest schema',
  );
  const m = (
    await s2.j('POST', '/auth/org/login', {
      orgId: 'org-eastport',
      scoutName: 'Maria Keane',
      role: 'Head of Recruitment',
    })
  ).body;
  const room = await s2.j('GET', '/org/rooms/case-legacy-signed/signing', undefined, m.token);
  neg(
    room.status === 200 &&
      room.body.packages.length === 0 &&
      room.body.legacySigning?.id === 'sign-legacy-p7' &&
      room.body.legacySigning.method === 'LEGACY_RECORDED',
    '1.6 the legacy signed case: no package fabricated; the legacy row reported as what it is',
  );
  const jr = (await s2.j('GET', '/org/rooms/case-legacy-signed/journey', undefined, m.token)).body;
  neg(
    jr.lifecycle?.currentStage === 'signed' &&
      jr.outcome?.signing?.id === 'sign-legacy-p7' &&
      jr.outcome.signing.method === 'LEGACY_RECORDED' &&
      jr.outcome.signingPackages.length === 0,
    '1.7 the journey: signed, the legacy row a fact with no package behind it',
  );
  const db2 = await s2.stop();
  ok(JSON.stringify(ledger(DIR)) === JSON.stringify(L1), '1.5b and no migration ran again (the ledger is unchanged)');
  // The legacy row is kept as stored, fact for fact, with no package or case inferred behind it
  const legacy = db2.signings.find((x) => x.id === 'sign-legacy-p7');
  const legacyKept =
    JSON.stringify(db2.signings) === signingsBefore &&
    legacy?.method === 'LEGACY_RECORDED' &&
    legacy.signing_package_id === null &&
    legacy.case_id === null;
  neg(
    db2.signing_packages.length === 0 &&
      legacyKept &&
      JSON.stringify(db2.recruitment_cases.map((c) => [c.id, c.room_status])) === casesBefore &&
      db2.players.find((p) => p.id === 'pl-kim').contract_status === 'under_contract',
    '1.8 after the reboot: no package, the legacy row kept fact for fact (typed, method LEGACY_RECORDED, no package), every case untouched, the under_contract player untouched — nothing inferred',
  );
  const s3 = await bootOn(DIR, PORT);
  const third = s3.up && (await s3.j('GET', '/healthz')).body.schemaVersion === LATEST_SCHEMA;
  await s3.stop();
  ok(third && JSON.stringify(ledger(DIR)) === JSON.stringify(L1), '1.9 a third boot applies nothing: replay-safe');
}

// ------------------------------------------------------------ 2 — journey
section('2 — a real journey survives SIGTERM and a reboot byte-faithfully');
const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23sp-2-'));
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
  async function accepted(playerId) {
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
    const c = await j(
      'POST',
      `/org/rooms/${RID}/offers`,
      { terms: TERMS, expiresAt: T0 + 14 * DAY, clientKey: key() },
      maria.token,
      at(T0),
    );
    const i = await j(
      'POST',
      `/org/offers/${c.body.offer.id}/issue`,
      { expectedRev: 1, clientKey: key() },
      maria.token,
      at(T0),
    );
    const a = await j(
      'POST',
      `/player/offers/${c.body.offer.id}/accept`,
      { revisionId: i.body.offer.currentRevisionId, clientKey: key() },
      await playerTok(playerId),
      at(T0),
    );
    if (a.status !== 200) throw new Error(`accept ${JSON.stringify(a.body)}`);
    return { RID, OID: c.body.offer.id };
  }
  const start = (OID, k) =>
    j('POST', `/org/offers/${OID}/signing`, { internalNote: S_NOTE, clientKey: k }, maria.token, at(T0));
  const attach = (SID, buf, rev, clock = T0) =>
    j(
      'POST',
      `/org/signings/${SID}/document`,
      { dataUrl: dataUrl(buf), filename: 'contract.pdf', expectedRev: rev },
      maria.token,
      at(clock),
    );
  const ready = (SID, rev, k, extra = {}, clock = T0) =>
    j('POST', `/org/signings/${SID}/ready`, { expectedRev: rev, clientKey: k, ...extra }, maria.token, at(clock));
  const pSign = (SID, revId, sha, tok, k, clock = T0 + H) =>
    j(
      'POST',
      `/player/signings/${SID}/complete`,
      { revisionId: revId, documentSha256: sha, clientKey: k },
      tok,
      at(clock),
    );
  const clubSign = (SID, rev, revId, sha, k) =>
    j(
      'POST',
      `/org/signings/${SID}/parties/club/complete`,
      { expectedRev: rev, revisionId: revId, documentSha256: sha, clientKey: k },
      maria.token,
      at(T0 + 2 * H),
    );
  const sGet = (SID) => j('GET', `/org/signings/${SID}`, undefined, maria.token, at(T0 + 3 * H));
  const sv = (r) => r.body.signing;

  // a) DRAFT — Kola
  R.kola = await accepted('pl-adeyemi');
  const sK = await start(R.kola.OID, 'P-start-kola');
  R.kola.SID = sv(sK).id;
  // b) COMPLETED — Kim
  R.kim = await accepted('pl-kim');
  const sKi = await start(R.kim.OID, 'P-start-kim');
  R.kim.SID = sv(sKi).id;
  const aKi = await attach(R.kim.SID, DOC, sv(sKi).rev);
  const rKi = await ready(R.kim.SID, sv(aKi).rev, 'P-ready-kim');
  R.kim.SREV = sv(rKi).currentRevision.id;
  const kimTok = await playerTok('pl-kim');
  const pKi = await pSign(R.kim.SID, R.kim.SREV, SHA, kimTok, 'P-sign-kim');
  const cKi = await clubSign(R.kim.SID, (await sGet(R.kim.SID)).body.signing.rev, R.kim.SREV, SHA, 'P-club-kim');
  const dKi = await j(
    'POST',
    `/org/signings/${R.kim.SID}/complete`,
    { expectedRev: sv(cKi).rev, clientKey: 'P-complete-kim' },
    maria.token,
    at(T0 + 3 * H),
  );
  ok(
    pKi.status === 200 &&
      cKi.status === 200 &&
      dKi.status === 200 &&
      sv(dKi).status === 'COMPLETED' &&
      dKi.body.lifecycle.to === 'signed',
    '2.2 Kim: both parties, completed, the case at signed',
  );
  R.kim.signingId = sv(dKi).completion.signingId;
  // c) CANCELLED — Okafor (READY, then cancelled)
  R.chi = await accepted('pl-okafor');
  const sC = await start(R.chi.OID, 'P-start-chi');
  R.chi.SID = sv(sC).id;
  const aC = await attach(R.chi.SID, DOC, sv(sC).rev);
  const rC = await ready(R.chi.SID, sv(aC).rev, 'P-ready-chi');
  const cC = await j(
    'POST',
    `/org/signings/${R.chi.SID}/cancel`,
    { expectedRev: sv(rC).rev, reason: 'Budget.', clientKey: 'P-cancel-chi' },
    maria.token,
    at(T0 + H),
  );
  ok(cC.status === 200 && sv(cC).status === 'CANCELLED', '2.3 Okafor: cancelled');
  // d) VOIDED — Svensson (IN_PROGRESS, then voided)
  R.sven = await accepted('pl-svensson');
  const sS = await start(R.sven.OID, 'P-start-sven');
  R.sven.SID = sv(sS).id;
  const aS = await attach(R.sven.SID, DOC, sv(sS).rev);
  const rS = await ready(R.sven.SID, sv(aS).rev, 'P-ready-sven');
  R.sven.SREV = sv(rS).currentRevision.id;
  await pSign(R.sven.SID, R.sven.SREV, SHA, await playerTok('pl-svensson'), 'P-sign-sven');
  const vS = await j(
    'POST',
    `/org/signings/${R.sven.SID}/void`,
    { expectedRev: (await sGet(R.sven.SID)).body.signing.rev, reason: 'Wrong document.', clientKey: 'P-void-sven' },
    maria.token,
    at(T0 + 2 * H),
  );
  ok(vS.status === 200 && sv(vS).status === 'VOIDED', '2.4 Svensson: voided after his signature');
  // e) SUPERSEDED revision, IN_PROGRESS — Tanaka (revision 1 signed, superseded, revision 2 presented and signed by him)
  R.tan = await accepted('pl-tanaka');
  const sT = await start(R.tan.OID, 'P-start-tan');
  R.tan.SID = sv(sT).id;
  const aT = await attach(R.tan.SID, DOC, sv(sT).rev);
  const rT = await ready(R.tan.SID, sv(aT).rev, 'P-ready-tan');
  R.tan.R1 = sv(rT).currentRevision.id;
  const tanTok = await playerTok('pl-tanaka');
  await pSign(R.tan.SID, R.tan.R1, SHA, tanTok, 'P-sign-tan-1');
  const supT = await j(
    'POST',
    `/org/signings/${R.tan.SID}/supersede`,
    { expectedRev: (await sGet(R.tan.SID)).body.signing.rev, reason: 'Amended.', clientKey: 'P-supersede-tan' },
    maria.token,
    at(T0 + 2 * H),
  );
  // The server clock never runs backwards: revision 2 was opened at T0+2H, so it is attached and presented at T0+2H.
  const aT2 = await attach(R.tan.SID, DOC2, sv(supT).rev, T0 + 2 * H);
  const rT2 = await ready(R.tan.SID, sv(aT2).rev, 'P-ready-tan-2', {}, T0 + 2 * H);
  R.tan.R2 = sv(rT2).currentRevision.id;
  const pT2 = await pSign(R.tan.SID, R.tan.R2, SHA2, tanTok, 'P-sign-tan-2', T0 + 3 * H);
  if (!(supT.status === 201 && pT2.status === 200))
    console.error(
      '   2.5 →',
      'supersede',
      supT.status,
      JSON.stringify(supT.body).slice(0, 160),
      'attach',
      aT2.status,
      JSON.stringify(aT2.body).slice(0, 160),
      'ready',
      rT2.status,
      JSON.stringify(rT2.body).slice(0, 160),
      'sign',
      pT2.status,
      JSON.stringify(pT2.body).slice(0, 200),
    );
  ok(
    supT.status === 201 &&
      pT2.status === 200 &&
      sv(pT2).status === 'IN_PROGRESS' &&
      sv(pT2).currentRevision.revisionNumber === 2,
    '2.5 Tanaka: revision 1 superseded, revision 2 presented and signed by him',
  );
  // f) EXPIRED (lazily) — Martin: presented with a two-hour expiry
  R.theo = await accepted('pl-martin');
  const sM = await start(R.theo.OID, 'P-start-theo');
  R.theo.SID = sv(sM).id;
  const aM = await attach(R.theo.SID, DOC, sv(sM).rev);
  const rM = await ready(R.theo.SID, sv(aM).rev, 'P-ready-theo', { expiresAt: T0 + 2 * H });
  ok(rM.status === 200 && sv(rM).expiresAt === T0 + 2 * H, '2.6 Martin: presented with a two-hour expiry');

  R.before = {};
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan', 'theo']) {
    R.before[who] = (await sGet(R[who].SID)).body.signing;
    R.before[`${who}_hist`] = (
      await j('GET', `/org/signings/${R[who].SID}/history`, undefined, maria.token)
    ).body.items;
    R.before[`${who}_stage`] = (await journey(R[who].RID)).lifecycle.currentStage;
  }
  R.before.stages = {
    kola: 'offer_accepted',
    kim: 'signed',
    chi: 'offer_accepted',
    sven: 'offer_accepted',
    tan: 'offer_accepted',
    theo: 'offer_accepted',
  };
  ok(
    Object.entries(R.before.stages).every(([w, st]) => R.before[`${w}_stage`] === st),
    '2.7 the six cases sit where the workflow put them',
  );
  R.before.kimRecipient = (
    await j('GET', `/player/signings/${R.kim.SID}`, undefined, kimTok, at(T0 + 3 * H))
  ).body.signing;
  R.before.kimDoc = (await j('GET', `/player/signings/${R.kim.SID}/document`, undefined, kimTok, at(T0 + 3 * H))).body;
  R.before.rows = (await j('GET', '/org/signings', undefined, maria.token)).body.items;
  R.before.kimPlayer = (await j('GET', '/org/players/pl-kim', undefined, maria.token)).body;
  R.before.theoStatusAt = {
    before: (await j('GET', `/org/signings/${R.theo.SID}`, undefined, maria.token, at(T0 + 2 * H - 1))).body.signing
      .status,
    after: (await j('GET', `/org/signings/${R.theo.SID}`, undefined, maria.token, at(T0 + 2 * H))).body.signing.status,
  };
  ok(
    R.before.theoStatusAt.before === 'READY' && R.before.theoStatusAt.after === 'EXPIRED',
    "2.8 Martin's package reads READY before and EXPIRED at its instant — derived",
  );

  // Every package as the server reads its stored rows: the room surface names no integrity problem.
  let sound = true;
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan', 'theo'])
    sound &&=
      (await j('GET', `/org/rooms/${R[who].RID}/signing`, undefined, maria.token)).body?.packages?.find(
        (p) => p.id === R[who].SID,
      )?.integrity.length === 0;
  const db = await s.stop();
  ok(db.signing_packages.length === 6, '2.9 SIGTERM: the file holds six packages');
  const stored = Object.fromEntries(db.signing_packages.map((p) => [p.id, p]));
  const revsOf = (id) => db.signing_revisions.filter((r) => r.package_id === id);
  const partiesOf = (revId) => db.signing_revision_parties.filter((q) => q.revision_id === revId);
  const docOf = (revId) => db.signing_documents.find((d) => d.revision_id === revId && d.kind === 'signing');
  const keysOf = (id, act) => db.idempotency_keys.filter((k) => k.owner_id === id && k.act === act);
  ok(
    stored[R.kola.SID].status === 'DRAFT' &&
      stored[R.kim.SID].status === 'COMPLETED' &&
      stored[R.chi.SID].status === 'CANCELLED' &&
      stored[R.sven.SID].status === 'VOIDED' &&
      stored[R.tan.SID].status === 'IN_PROGRESS' &&
      stored[R.theo.SID].status === 'READY',
    '2.10 stored statuses: DRAFT, COMPLETED, CANCELLED, VOIDED, IN_PROGRESS, READY (EXPIRED is never stored)',
  );
  const [tan1, tan2] = revsOf(R.tan.SID);
  ok(
    revsOf(R.tan.SID).length === 2 &&
      tan1.status === 'SUPERSEDED' &&
      partiesOf(tan1.id).find((q) => q.party_type === 'PLAYER').status === 'COMPLETED' &&
      docOf(tan2.id).sha256 === SHA2,
    '2.11 Tanaka: revision 1 SUPERSEDED with his old signature kept as history; revision 2 carries the new digest',
  );
  ok(
    keysOf(R.kim.SID, 'start')[0]?.key === 'P-start-kim' &&
      keysOf(R.kim.SID, 'complete')[0]?.key === 'P-complete-kim' &&
      keysOf(R.kim.SID, 'party').length === 2 &&
      partiesOf(revsOf(R.kim.SID)[0].id).every((q) => q.evidence_document_sha256 === SHA),
    '2.12 keys and party evidence references are on the row',
  );
  ok(
    db.signings.filter((x) => x.signing_package_id === R.kim.SID).length === 1 &&
      db.signings.find((x) => x.signing_package_id === R.kim.SID).document_sha256 === SHA &&
      db.signings.every((x) => x.signing_package_id !== R.sven.SID && x.signing_package_id !== R.tan.SID),
    '2.13 exactly one db.signings row, for the completed package only',
  );
  ok(
    db.players.find((p) => p.id === 'pl-kim').contract_status === 'under_contract' &&
      db.players.find((p) => p.id === 'pl-svensson').contract_status !== 'under_contract' &&
      db.players.find((p) => p.id === 'pl-okafor').contract_status !== 'under_contract',
    '2.14 only the completed signing set under_contract (the voided and cancelled ones did not)',
  );
  ok(sound, '2.15 every stored row passes the integrity rules');
}

// ------------------------------------------------------------- 3 — reboot
section('3 — after the reboot: identical views, keys replay, completion refused, uniqueness and consistency hold');
{
  const s = await bootOn(DIR, PORT);
  ok(s.up && !/applied/.test(s.log()), '3.1 rebooted on the same store with no migration applied');
  const { j } = s;
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const kim = (await j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
  const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token)).body;
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan', 'theo']) {
    const now = (await j('GET', `/org/signings/${R[who].SID}`, undefined, maria.token, at(T0 + 3 * H))).body.signing;
    ok(
      JSON.stringify(now) === JSON.stringify(R.before[who]),
      `3.2 ${who}: the club view is byte-identical after the reboot`,
    );
    ok(
      JSON.stringify((await j('GET', `/org/signings/${R[who].SID}/history`, undefined, maria.token)).body.items) ===
        JSON.stringify(R.before[`${who}_hist`]),
      `3.3 ${who}: the history is byte-identical`,
    );
    ok(
      (await journey(R[who].RID)).lifecycle.currentStage === R.before.stages[who],
      `3.4 ${who}: the case is still at ${R.before.stages[who]}`,
    );
  }
  ok(
    JSON.stringify((await j('GET', `/player/signings/${R.kim.SID}`, undefined, kim, at(T0 + 3 * H))).body.signing) ===
      JSON.stringify(R.before.kimRecipient),
    "3.5 Kim's recipient view is byte-identical",
  );
  const doc = (await j('GET', `/player/signings/${R.kim.SID}/document`, undefined, kim, at(T0 + 3 * H))).body;
  ok(
    doc.document.sha256 === SHA &&
      sha256(Buffer.from(doc.file.base64, 'base64')) === SHA &&
      doc.file.base64 === R.before.kimDoc.file.base64,
    "3.6 the signed document's bytes are still there and still hash to the recorded digest",
  );
  ok(
    JSON.stringify((await j('GET', '/org/signings', undefined, maria.token)).body.items) ===
      JSON.stringify(R.before.rows),
    '3.7 the db.signings rows are byte-identical',
  );
  ok(
    JSON.stringify((await j('GET', '/org/players/pl-kim', undefined, maria.token)).body) ===
      JSON.stringify(R.before.kimPlayer),
    "3.8 Kim's player record (under_contract, level, timeline) is byte-identical",
  );
  // keys replay
  ok(
    (
      await j(
        'POST',
        `/org/offers/${R.kola.OID}/signing`,
        { internalNote: S_NOTE, clientKey: 'P-start-kola' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.9 the start key replays',
  );
  ok(
    (
      await j(
        'POST',
        `/org/signings/${R.kim.SID}/ready`,
        { expectedRev: 1, clientKey: 'P-ready-kim' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.10 the ready key replays (before the rev is checked)',
  );
  ok(
    (
      await j(
        'POST',
        `/player/signings/${R.kim.SID}/complete`,
        { revisionId: R.kim.SREV, documentSha256: SHA, clientKey: 'P-sign-kim' },
        kim,
        at(T0),
      )
    ).body.idempotent === true,
    "3.11 the player's signature key replays",
  );
  ok(
    (
      await j(
        'POST',
        `/org/signings/${R.kim.SID}/complete`,
        { expectedRev: 1, clientKey: 'P-complete-kim' },
        maria.token,
        at(T0),
      )
    ).body.idempotent === true,
    '3.12 the completion key replays',
  );
  neg(
    (
      await j(
        'POST',
        `/org/signings/${R.kim.SID}/complete`,
        { expectedRev: R.before.kim.rev, clientKey: key() },
        maria.token,
        at(T0),
      )
    ).body.error === 'SIGNING_ALREADY_COMPLETED' &&
      (await j('GET', '/org/signings', undefined, maria.token)).body.items.filter(
        (x) => x.signingPackageId === R.kim.SID,
      ).length === 1,
    '3.13 a fresh completion is refused: still one row',
  );
  neg(
    (
      await j(
        'POST',
        `/player/signings/${R.tan.SID}/complete`,
        { revisionId: R.tan.R1, documentSha256: SHA, clientKey: key() },
        (
          await j('POST', '/auth/player/login', { playerId: 'pl-tanaka' })
        ).body.token,
        at(T0 + 4 * H),
      )
    ).body.error === 'SIGNING_SUPERSEDED',
    '3.14 the superseded revision is still not signable',
  );
  neg(
    (
      await j(
        'POST',
        `/player/signings/${R.theo.SID}/complete`,
        { revisionId: R.before.theo.currentRevision.id, documentSha256: SHA, clientKey: key() },
        (
          await j('POST', '/auth/player/login', { playerId: 'pl-martin' })
        ).body.token,
        at(T0 + 3 * H),
      )
    ).body.error === 'SIGNING_EXPIRED',
    '3.15 the expired package still refuses — lazily, with nothing written',
  );
  // Tanaka completes revision 2 after the reboot: the lifecycle coupling survived.
  const tanRev = (await j('GET', `/org/signings/${R.tan.SID}`, undefined, maria.token)).body.signing.rev;
  const cT = await j(
    'POST',
    `/org/signings/${R.tan.SID}/parties/club/complete`,
    { expectedRev: tanRev, revisionId: R.tan.R2, documentSha256: SHA2, clientKey: key() },
    maria.token,
    at(T0 + 4 * H),
  );
  const dT = await j(
    'POST',
    `/org/signings/${R.tan.SID}/complete`,
    { expectedRev: cT.body.signing.rev, clientKey: key() },
    maria.token,
    at(T0 + 4 * H),
  );
  ok(
    cT.status === 200 &&
      dT.status === 200 &&
      dT.body.lifecycle.to === 'signed' &&
      (await journey(R.tan.RID)).lifecycle.currentStage === 'signed',
    "3.16 Tanaka's revision 2 completes after the reboot; the case moves to signed",
  );
  // Every package as the server reads its stored rows: the room surface names no integrity problem.
  let sound = true;
  for (const who of ['kola', 'kim', 'chi', 'sven', 'tan', 'theo'])
    sound &&=
      (await j('GET', `/org/rooms/${R[who].RID}/signing`, undefined, maria.token)).body?.packages?.find(
        (p) => p.id === R[who].SID,
      )?.integrity.length === 0;
  const db = await s.stop();
  ok(
    db.signings.filter((x) => x.signing_package_id === R.tan.SID).length === 1 &&
      db.signings.find((x) => x.signing_package_id === R.tan.SID).document_sha256 === SHA2 &&
      db.signings.filter((x) => x.player_id === 'pl-tanaka').length === 1,
    "3.17 one row for Tanaka, referencing revision 2's digest",
  );
  ok(db.signing_packages.length === 6 && sound, '3.18 six sound rows after the second stop');
  R.db = db;
}

// --------------------------------------------------------- 4 — corruption
section('4 — planted corruption is named, refused, omitted, never repaired; a legacy signed case fabricates nothing');
{
  const db = R.db;
  const base = pkgRows(db, R.kim.SID);
  // Revisions, documents and history entries are rows with their own ids, so a clone gets fresh ones (the planted
  // corruption is the column named for each row, never a duplicated child id); a clone has no keys
  const clone = (id, patch = {}) => {
    const c = JSON.parse(JSON.stringify(base));
    const fresh = (x) => `${x}-${id}`;
    const [p] = c.signing_packages;
    c.signing_packages = [{ ...p, id, current_revision_id: fresh(p.current_revision_id), ...patch }];
    c.signing_revisions = c.signing_revisions.map((r) => ({ ...r, id: fresh(r.id), package_id: id }));
    c.signing_documents = c.signing_documents.map((d) => ({
      ...d,
      id: fresh(d.id),
      revision_id: fresh(d.revision_id),
    }));
    c.signing_revision_parties = c.signing_revision_parties.map((q) => ({ ...q, revision_id: fresh(q.revision_id) }));
    c.signing_history = c.signing_history.map((h) => ({ ...h, id: fresh(h.id), package_id: id }));
    c.idempotency_keys = [];
    return c;
  };
  const NO_COMPLETION = Object.fromEntries(
    Object.keys(base.signing_packages[0])
      .filter((k) => k.startsWith('completion_'))
      .map((k) => [k, null]),
  );
  const pkgOf = (c) => c.signing_packages[0];
  const revOf = (c) => c.signing_revisions[0];
  const playerParty = (c) =>
    c.signing_revision_parties.find((q) => q.revision_id === revOf(c).id && q.party_type === 'PLAYER');
  const c1 = clone('spk-t1', { status: 'SIGNED' });
  const c2 = clone('spk-t2', { status: 'COMPLETED', ...NO_COMPLETION });
  const open = (c) => {
    Object.assign(pkgOf(c), { status: 'IN_PROGRESS', ...NO_COMPLETION });
    Object.assign(revOf(c), {
      status: 'IN_PROGRESS',
      completed_at: null,
      completed_by_kind: null,
      completed_by_user_id: null,
      completed_by_name: null,
      completed_by_role: null,
    });
    return c;
  }; // a second COMPLETED package on Kim's offer is refused by the column rule; the corruptions below are about other fields
  const c3 = open(clone('spk-t3', {}));
  Object.assign(playerParty(c3), { completed_by_kind: 'org', completed_by_id: 'agent-x', completed_by_name: 'Ana' });
  const c4 = open(clone('spk-t4', {}));
  c4.signing_revisions.push({ ...revOf(c4), id: 'spr-t4b', revision_number: 2, position: 1 }); // pointer at revision 1 while 2 exists
  c4.signing_revision_parties.push(
    ...c4.signing_revision_parties.map((q) => ({ ...q, revision_id: 'spr-t4b' })), // revision 2 has no document
  );
  const c5 = open(clone('spk-t5', {}));
  playerParty(c5).completed_at = revOf(c5).ready_at - 1;
  const c6 = clone('spk-t6', { case_id: R.chi.RID, offer_id: R.chi.OID }); // a COMPLETED package on a case that is at offer_accepted (Okafor's)
  const c7 = open(clone('spk-t7', {}));
  c7.signing_documents = c7.signing_documents.filter((d) => d.revision_id !== revOf(c7).id); // presented without a document
  const c8 = open(clone('spk-t8', { offer_id: R.chi.OID })); // #5 an Offer that names another player (Okafor's)
  const c9 = open(clone('spk-t9', { case_id: R.chi.RID })); // #6 a case that names another player
  const c10 = open(clone('spk-t10', { offer_revision_id: 'rofr-stale' })); // #7 bound to an Offer revision the Offer does not hold
  // Each planted package goes in its own transaction; a row the schema cannot hold is REFUSED there (nothing lands);
  // the rows the columns can hold land and are named on read
  const refusedAtSave = new Map();
  const planted = [];
  for (const c of [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10]) {
    const F = openFixture(DIR);
    try {
      F.transaction(() => insertPackage(F, c));
      planted.push(pkgOf(c).id);
    } catch (err) {
      refusedAtSave.set(pkgOf(c).id, String(err?.message ?? err));
    } finally {
      F.close();
    }
  }
  neg(
    [...refusedAtSave.values()].every((m) => /^CHECK constraint failed/.test(m)),
    `4.0 the rows the columns cannot hold are refused by the schema: ${[...refusedAtSave.keys()].join(', ') || 'none'}; landed: ${planted.join(', ')}`,
  );
  neg(
    refusedAtSave.has('spk-t1') && refusedAtSave.has('spk-t2'),
    '4.0b an unknown status word and a COMPLETED package without its completion record cannot be stored at all',
  );
  const plantedRows = (d) => JSON.stringify(planted.map((id) => pkgRows(d, id)));
  const atPlant = storedRows(DIR);
  const rowsBefore = plantedRows(atPlant);
  const signingsBefore = JSON.stringify(atPlant.signings);
  const chiStage = atPlant.recruitment_cases.find((c) => c.id === R.chi.RID).room_status;
  const s = await bootOn(DIR, PORT);
  ok(
    s.up,
    `4.1 the server boots with ${planted.length} corrupt row(s) present — corruption is not fatal to the process`,
  );
  const { j } = s;
  const maria = (
    await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })
  ).body;
  const kim = (await j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
  for (const [id, why] of [
    ['spk-t1', 'an unknown status word'],
    ['spk-t2', 'COMPLETED without its completion record'],
    ['spk-t3', 'a PLAYER party completed by an org actor'],
    ['spk-t4', 'a pointer at a non-latest revision'],
    ['spk-t5', 'a party completed before the revision was presented'],
    ['spk-t6', 'a COMPLETED package on a case that is not signed'],
    ['spk-t7', 'presented without a document'],
    ['spk-t8', 'an Offer that names another player'],
    ['spk-t9', 'a case that names another player'],
    ['spk-t10', 'a stale Offer revision'],
  ]) {
    if (refusedAtSave.has(id)) {
      neg(true, `4.2 ${id} (${why}): never stored — the insert refused it (${refusedAtSave.get(id).slice(0, 80)}…)`);
      continue;
    }
    const r = await j('GET', `/org/signings/${id}`, undefined, maria.token);
    neg(
      r.status === 500 &&
        r.body.error === 'SIGNING_STATE_UNKNOWN' &&
        !has(r.body, 'revisions') &&
        !has(r.body, 'stack'),
      `4.2 ${id} (${why}): 500 SIGNING_STATE_UNKNOWN, nothing internal in the body`,
    );
    const m = await j('POST', `/org/signings/${id}/complete`, { expectedRev: 1, clientKey: key() }, maria.token);
    neg(
      m.status === 500 && m.body.error === 'SIGNING_STATE_UNKNOWN',
      `4.3 ${id}: a mutation is refused the same way — no repair through a write`,
    );
  }
  neg(
    !(await j('GET', '/player/signings', undefined, kim, at(T0 + 3 * H))).body.items.some((p) => /^spk-t/.test(p.id)),
    '4.4 the recipient list omits every planted row',
  );
  const room = await j('GET', `/org/rooms/${R.chi.RID}/signing`, undefined, maria.token);
  neg(
    (refusedAtSave.has('spk-t6') ||
      room.body.packages.find((p) => p.id === 'spk-t6')?.integrity.includes('COMPLETED_BUT_CASE_NOT_SIGNED')) &&
      (await j('GET', `/org/rooms/${R.chi.RID}/journey`, undefined, maria.token)).body.lifecycle.currentStage ===
        chiStage,
    '4.5 the case surface names the disagreement and the case did not move to match the planted row',
  );
  neg(
    !(await j('GET', `/org/rooms/${R.chi.RID}/journey`, undefined, maria.token)).body.outcome.signingPackages.some(
      (p) => p.id === 'spk-t6',
    ),
    '4.6 the journey omits it',
  );
  neg(
    (
      await j(
        'POST',
        `/org/rooms/${R.chi.RID}/lifecycle`,
        {
          action: 'confirmSignedOutcome',
          expectedRev: (await j('GET', `/org/rooms/${R.chi.RID}/journey`, undefined, maria.token)).body.case.rev,
        },
        maria.token,
      )
    ).status >= 400,
    '4.7 a fabricated COMPLETED package is not signing evidence: the lifecycle refuses',
  );
  ok(
    (await j('GET', `/org/signings/${R.kim.SID}`, undefined, maria.token, at(T0 + 3 * H))).body.signing.status ===
      'COMPLETED',
    '4.8 a sound neighbour still reads',
  );
  const db2 = await s.stop();
  neg(
    plantedRows(db2) === rowsBefore && JSON.stringify(db2.signings) === signingsBefore,
    '4.9 nothing was repaired, dropped or written on boot or on stop',
  );
  R.refusedAtSave = refusedAtSave;
}

// --------------------------------------------------------- 5 — hardening
section(
  '5 — bytes, rows and evidence edited on disk fail closed after a restart; a completion interrupted by a restart converges',
);
{
  const db = R.db; // after section 4's stop: the seven planted rows are still there (never repaired), the genuine ones sound
  const mediaFile = (mediaId) => path.join(DIR, 'media', `${mediaId}.bin`);
  const kimEv = db.ver_evidence.find(
    (e) => e.signing_package_id === R.kim.SID && e.signing_document_kind === 'signing',
  );
  ok(!!kimEv?.media_id && existsSync(mediaFile(kimEv.media_id)), "5.0 Kim's signed document sits in the vault on disk");
  const originalBytes = readFileSync(mediaFile(kimEv.media_id));
  const kimRow = db.signings.find((x) => x.signing_package_id === R.kim.SID);
  const login = async (j) =>
    (
      await j('POST', '/auth/org/login', {
        orgId: 'org-eastport',
        scoutName: 'Maria Keane',
        role: 'Head of Recruitment',
      })
    ).body.token;
  // A planted row the schema cannot hold is REFUSED (nothing lands); `refused` carries the error into the check.
  // `plant(F)` writes plain SQL between boots (sqlFixture.mjs), in one transaction (null: nothing).
  let refused = null;
  const cycle = async (label, plant, check) => {
    refused = null;
    if (plant) {
      const F = openFixture(DIR);
      try {
        F.transaction(() => plant(F));
      } catch (err) {
        refused = err;
      } finally {
        F.close();
      }
    }
    const s = await bootOn(DIR, PORT);
    ok(s.up, `5.${label} the server boots`);
    const tok = await login(s.j);
    await check(s, tok);
    const after = await s.stop();
    return after;
  };
  // 5.1 the vault bytes swapped after a restart: the document is not served, the completed record and package still read
  await cycle(
    '1a',
    () => {
      writeFileSync(mediaFile(kimEv.media_id), DOC2);
    },
    async (s, tok) => {
      const kim = (await s.j('POST', '/auth/player/login', { playerId: 'pl-kim' })).body.token;
      neg(
        (await s.j('GET', `/org/signings/${R.kim.SID}/document`, undefined, tok)).body?.error ===
          'SIGNING_STATE_UNKNOWN' &&
          (await s.j('GET', `/player/signings/${R.kim.SID}/document`, undefined, kim, at(T0 + 3 * H))).body?.error ===
            'SIGNING_STATE_UNKNOWN',
        '5.1 the bytes on disk no longer hash to the digest every party confirmed: nobody is served them',
      );
      ok(
        (await s.j('GET', `/org/signings/${R.kim.SID}`, undefined, tok, at(T0 + 3 * H))).body.signing?.status ===
          'COMPLETED' && (await s.j('GET', '/org/signings', undefined, tok)).body.items.some((x) => x.id === kimRow.id),
        '5.1b the completed record and the package still read: the swap is on the bytes, the record is untouched',
      );
    },
  );
  await cycle(
    '1b',
    () => {
      writeFileSync(mediaFile(kimEv.media_id), originalBytes);
    },
    async (s, tok) => {
      const d = (await s.j('GET', `/org/signings/${R.kim.SID}/document`, undefined, tok)).body;
      ok(
        d?.file && sha256(Buffer.from(d.file.base64, 'base64')) === SHA,
        '5.1c the original bytes back: served again, nothing was repaired',
      );
    },
  );
  // 5.2 a duplicate completion row on disk
  await cycle(
    '2',
    (F) => {
      copySigning(F, kimRow, { id: 'sign-dup-p' });
    },
    async (s, tok) => {
      neg(
        /UNIQUE constraint failed: signings\.(offer_id|signing_package_id)/.test(String(refused?.message)) &&
          (await s.j('GET', `/org/signings/${R.kim.SID}`, undefined, tok, at(T0 + 3 * H))).status === 200 &&
          (await s.j('GET', `/org/rooms/${R.kim.RID}/signing`, undefined, tok, at(T0 + 3 * H))).body.packages.find(
            (p) => p.id === R.kim.SID,
          )?.integrity.length === 0,
        `5.2 a second row for one package is refused by the table's one-row-per-offer/package key; the one row reads sound (${String(refused?.message).slice(0, 70)}…)`,
      );
    },
  );
  await cycle('2b', null, async (s, tok) => {
    ok(
      !refused && (await s.j('GET', `/org/signings/${R.kim.SID}`, undefined, tok, at(T0 + 3 * H))).status === 200,
      '5.2b still readable (nothing to remove)',
    );
  });
  // 5.3 corrupted party evidence on disk
  let kimBackup = null;
  const kimParty = (F) => ({
    revision_id: F.sql.prepare('SELECT id FROM signing_revisions WHERE package_id = ? AND position = 0').get(R.kim.SID)
      .id,
    party_type: 'PLAYER',
  });
  await cycle(
    '3',
    (F) => {
      const where = kimParty(F);
      kimBackup = F.sql
        .prepare(
          'SELECT evidence_document_sha256 FROM signing_revision_parties WHERE revision_id = ? AND party_type = ?',
        )
        .get(where.revision_id, where.party_type).evidence_document_sha256;
      setRow(F, 'signing_revision_parties', where, { evidence_document_sha256: SHA2 });
    },
    async (s, tok) => {
      neg(
        (await s.j('GET', `/org/signings/${R.kim.SID}`, undefined, tok, at(T0 + 3 * H))).body?.error ===
          'SIGNING_STATE_UNKNOWN',
        '5.3 an evidence reference edited to another digest: corruption',
      );
    },
  );
  await cycle(
    '3b',
    (F) => {
      setRow(F, 'signing_revision_parties', kimParty(F), { evidence_document_sha256: kimBackup });
    },
    async (s, tok) => {
      ok(
        (await s.j('GET', `/org/signings/${R.kim.SID}`, undefined, tok, at(T0 + 3 * H))).status === 200,
        '5.3b restored',
      );
    },
  );
  // 5.4 a completed package whose row is gone
  // no repository operation removes a completed package's row, so this cycle plants nothing
  await cycle('4', null, async (s, tok) => {
    neg(
      (await s.j('GET', `/org/signings/${R.kim.SID}`, undefined, tok, at(T0 + 3 * H))).status === 200 &&
        (await s.j('GET', `/org/rooms/${R.kim.RID}/journey`, undefined, tok)).body.outcome.signing?.id === kimRow.id,
      '5.4 a COMPLETED package keeps its row: the package reads and the journey shows it',
    );
    neg(
      (
        await s.j(
          'POST',
          `/org/signings/${R.kim.SID}/complete`,
          { expectedRev: 99, clientKey: key() },
          tok,
          at(T0 + 3 * H),
        )
      ).status >= 400 &&
        (await s.j('GET', `/org/rooms/${R.kim.RID}/journey`, undefined, tok)).body.outcome.signing?.id === kimRow.id,
      '5.4b a "completion" of the completed package writes no second row',
    );
  });
  await cycle('4b', null, async (s, tok) => {
    ok(
      (await s.j('GET', `/org/rooms/${R.kim.RID}/journey`, undefined, tok)).body.outcome.signing?.id === kimRow.id,
      '5.4c the one row stands',
    );
  });
  // 5.5 a row naming a package that never completed (Kola's DRAFT)
  await cycle(
    '5',
    (F) => {
      copySigning(F, kimRow, {
        id: 'sign-forged-p',
        signing_package_id: R.kola.SID,
        player_id: 'pl-adeyemi',
        case_id: R.kola.RID,
        offer_id: R.kola.OID,
      });
    },
    async (s, tok) => {
      neg(
        (await s.j('GET', `/org/signings/${R.kola.SID}`, undefined, tok)).body?.error === 'SIGNING_STATE_UNKNOWN' &&
          (await s.j('GET', `/org/rooms/${R.kola.RID}/signing`, undefined, tok)).body.packages
            .find((p) => p.id === R.kola.SID)
            ?.integrity.includes('ROW_WITHOUT_COMPLETION'),
        '5.5 a row for a DRAFT package: ROW_WITHOUT_COMPLETION, corruption',
      );
      const rev = (await s.j('GET', `/org/rooms/${R.kola.RID}/journey`, undefined, tok)).body.case.rev;
      neg(
        (
          await s.j(
            'POST',
            `/org/rooms/${R.kola.RID}/lifecycle`,
            { action: 'confirmSignedOutcome', expectedRev: rev },
            tok,
          )
        ).status === 422 &&
          (await s.j('GET', `/org/rooms/${R.kola.RID}/journey`, undefined, tok)).body.lifecycle.currentStage ===
            'offer_accepted',
        '5.5b the forged row is not evidence for signed: the case stays at offer_accepted',
      );
    },
  );
  // Raw SQL: no repository operation deletes a signing row (a forged one is a state only a test plants), so its removal is SQL.
  await cycle(
    '5b',
    (F) => {
      for (const t of ['outcome_reports', 'follow_ups'])
        F.sql.prepare(`DELETE FROM ${t} WHERE signing_id = ?`).run('sign-forged-p');
      F.sql.prepare('DELETE FROM signings WHERE id = ?').run('sign-forged-p');
    },
    async (s, tok) => {
      ok((await s.j('GET', `/org/signings/${R.kola.SID}`, undefined, tok)).status === 200, '5.5c removed: readable');
    },
  );
  // 5.6 lazy expiry across the restart: the stored word is still READY, the read is EXPIRED
  {
    ok(
      rows(DIR, 'signing_packages', { id: R.theo.SID })[0]?.status === 'READY',
      "5.6 Martin's package is stored READY through every restart (EXPIRED is never written)",
    );
  }
  // 5.7 a completion interrupted by a restart: (a) before persistence → nothing; (b) after persistence, before the effects → converged on replay
  const playerTok = async (j, id) => (await j('POST', '/auth/player/login', { playerId: id })).body.token;
  let N = null;
  await cycle('7a', null, async (s, tok) => {
    const { j } = s;
    const journey = async (RID) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, tok)).body;
    const lifecycle = async (RID, action) =>
      j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: (await journey(RID)).case.rev }, tok);
    const r = await j('POST', '/org/rooms', { playerId: 'pl-nowak', sourceContext: 'search' }, tok);
    const RID = r.body?.room?.roomId ?? r.body?.existingRoomId;
    await lifecycle(RID, 'startReview');
    await lifecycle(RID, 'shortlist');
    const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', note: 'internal' }, tok);
    await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, tok);
    const c = await j(
      'POST',
      `/org/rooms/${RID}/offers`,
      { terms: TERMS, expiresAt: T0 + 14 * DAY, clientKey: key() },
      tok,
      at(T0 + 4 * H),
    );
    const i = await j(
      'POST',
      `/org/offers/${c.body.offer.id}/issue`,
      { expectedRev: 1, clientKey: key() },
      tok,
      at(T0 + 4 * H),
    );
    const nowak = await playerTok(j, 'pl-nowak');
    const a = await j(
      'POST',
      `/player/offers/${c.body.offer.id}/accept`,
      { revisionId: i.body.offer.currentRevisionId, clientKey: key() },
      nowak,
      at(T0 + 4 * H),
    );
    const st = await j('POST', `/org/offers/${c.body.offer.id}/signing`, { clientKey: key() }, tok, at(T0 + 4 * H));
    const SID = st.body.signing.id;
    const at1 = await j(
      'POST',
      `/org/signings/${SID}/document`,
      { dataUrl: dataUrl(DOC), filename: 'contract.pdf', expectedRev: st.body.signing.rev },
      tok,
      at(T0 + 4 * H),
    );
    const rd = await j(
      'POST',
      `/org/signings/${SID}/ready`,
      { expectedRev: at1.body.signing.rev, clientKey: key() },
      tok,
      at(T0 + 4 * H),
    );
    const SREV = rd.body.signing.currentRevision.id;
    const ps = await j(
      'POST',
      `/player/signings/${SID}/complete`,
      { revisionId: SREV, documentSha256: SHA, clientKey: key() },
      nowak,
      at(T0 + 5 * H),
    );
    const cs = await j(
      'POST',
      `/org/signings/${SID}/parties/club/complete`,
      {
        expectedRev: ps.status === 200 ? (await j('GET', `/org/signings/${SID}`, undefined, tok)).body.signing.rev : 0,
        revisionId: SREV,
        documentSha256: SHA,
        clientKey: key(),
      },
      tok,
      at(T0 + 5 * H),
    );
    ok(
      a.status === 200 && st.status === 201 && rd.status === 200 && ps.status === 200 && cs.status === 200,
      '5.7 Nowak: both parties confirmed on a fresh package',
    );
    N = { RID, SID, rev: cs.body.signing.rev, KC: key() };
    await j('POST', '/__faults', { rules: 'internal:signing.complete.after_lifecycle:1' });
    const boom = await j(
      'POST',
      `/org/signings/${SID}/complete`,
      { expectedRev: N.rev, clientKey: N.KC },
      tok,
      at(T0 + 5 * H),
    );
    neg(
      boom.status === 500 && boom.body.error === 'SIGNING_STATE_UNKNOWN',
      '5.7a the completion fails after the lifecycle moved (before persistence) — and the server is now stopped by SIGTERM with the rolled-back state',
    );
  });
  await cycle('7b', null, async (s, tok) => {
    ok(
      (await s.j('GET', `/org/signings/${N.SID}`, undefined, tok, at(T0 + 5 * H))).body.signing.status ===
        'IN_PROGRESS' &&
        (await s.j('GET', '/org/signings', undefined, tok)).body.items.every((x) => x.signingPackageId !== N.SID) &&
        (await s.j('GET', `/org/rooms/${N.RID}/journey`, undefined, tok)).body.lifecycle.currentStage ===
          'offer_accepted',
      '5.7b after the restart: IN_PROGRESS, no row, offer_accepted — the interrupted completion left nothing behind',
    );
    await s.j('POST', '/__faults', { rules: 'internal:signing.complete.effects:1' });
    const done = await s.j(
      'POST',
      `/org/signings/${N.SID}/complete`,
      { expectedRev: (await s.j('GET', `/org/signings/${N.SID}`, undefined, tok)).body.signing.rev, clientKey: N.KC },
      tok,
      at(T0 + 5 * H),
    );
    ok(
      done.status === 200 && done.body.signing.status === 'COMPLETED',
      '5.7c the same key completes; the after-effects fail (simulated) — the authoritative writes were already persisted',
    );
  });
  await cycle('7c', null, async (s, tok) => {
    const replay = await s.j(
      'POST',
      `/org/signings/${N.SID}/complete`,
      { expectedRev: 999, clientKey: N.KC },
      tok,
      at(T0 + 5 * H),
    );
    ok(
      replay.status === 200 &&
        replay.body.idempotent === true &&
        (await s.j('GET', '/org/signings', undefined, tok)).body.items.filter((x) => x.signingPackageId === N.SID)
          .length === 1 &&
        (await s.j('GET', `/org/rooms/${N.RID}/journey`, undefined, tok)).body.lifecycle.currentStage === 'signed',
      '5.7d after another restart the key replays, one row, the case signed: converged',
    );
    neg(
      (
        await s.j(
          'POST',
          `/org/signings/${N.SID}/complete`,
          { expectedRev: 999, clientKey: key() },
          tok,
          at(T0 + 5 * H),
        )
      ).body.error === 'SIGNING_ALREADY_COMPLETED',
      '5.7e a fresh completion is refused',
    );
  });
  // 5.8 planted corruption from section 4 is STILL there and still refused: nothing repaired it across five restarts
  {
    neg(
      rows(DIR, 'signing_packages').filter((p) => /^spk-t/.test(p.id)).length === 10 - R.refusedAtSave.size,
      `5.8 the ${10 - R.refusedAtSave.size} planted rows that the columns could hold survived every restart untouched — never repaired, never dropped (${R.refusedAtSave.size} never landed)`,
    );
  }
}

console.log(
  `\nrecruitment/signingsPersistence: ${passed} checks passed, ${negatives} negative (${Math.round((negatives / Math.max(passed, 1)) * 100)}%)`,
);
if (process.exitCode === 1) console.error('\n✗ recruitment/signingsPersistence has failures.');
else console.log('all recruitment/signingsPersistence checks passed');
