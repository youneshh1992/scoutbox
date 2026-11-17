// Persistence, restart and corruption audit for the formal decision.
//
//   1  no decision migration of its own: `room_decisions` is the one decision
//      table, the draft is its case's, nothing is renamed
//   2  a fixture with legacy + formal rows and a draft restores byte-faithfully
//      through a real boot: chain, keys, draft rev, case status
//   3  corrupt FORMAL rows are named and omitted, never fabricated, never
//      repaired; duplicate final heads are corruption, not a tie (500)
//   4  legacy (advisory) rows read as advisory, keep their chain, and are never
//      judged by the formal-decision integrity rules
//   5  clean boot: draft → finalize → stop → read back → reboot: the row is on
//      `room_decisions` (no second store), the draft is gone, keys replay
//
// Nothing is rewritten, re-ordered or "repaired" on boot. Fixtures are written and read back as stored rows. The
// integrity rules' own verdicts on these records are in scripts/rules/recruitment/decisionsPersistence.mjs, and the
// repository's refusals of records that have no row form (an entry that is not a record, a list that is not a list)
// in scripts/testRecruitmentCases.mjs.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

// The table migrations a new database records, as the migrated schema lists them.
const MIGRATIONS = (() => {
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23d-schema-')));
  try {
    return R.rows('data_migrations').map((r) => r.id);
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

const PORT = await freePort();
const T0 = 1_800_000_000_000;
const NOW = Date.now(); // when the fixtures are installed: the migrated schema's own rows carry it

// ------------------------------------------------------------- fixtures, as stored rows

// The tables a decision is stored in, and the tables of the draft on its case.
const DECISION_TABLES = [
  'room_decisions',
  'room_decision_reason_codes',
  'room_decision_evidence_refs',
  'room_decision_assessment_ids',
];
const DRAFT_TABLES = ['case_decision_drafts', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs'];

/** A minimal, sound database: one verified club, one adult player, its owner on the staff table, one case at shortlisted.
 *  The case's owner and lead scout are real staff keys, so the fixture carries the staff row the case names. */
const baseRows = ({ roomStatus = 'shortlisted' } = {}) => ({
  orgs: [
    {
      id: 'org-x',
      name: 'X FC',
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
    },
  ],
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
      room_status: roomStatus,
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
      detail_json: JSON.stringify({ from: 'watching', to: 'shortlisted', reasonCodes: [] }),
    },
  ],
});

const BY = { by_user_id: 'usr-owner', by_name: 'Owner', by_role: 'Head of Recruitment' };
const NO_ACTOR = { by_user_id: null, by_name: null, by_role: null };
// A decision is its room_decisions row; its reason codes, evidence references and assessment ids are its child rows.
const legacyRow = (over = {}) => ({
  id: 'rdec-legacy',
  room_id: 'case-x',
  org_id: 'org-x',
  player_id: 'pl-x',
  recommendation: 'shortlist',
  note: 'Legacy opinion.',
  ...BY,
  created_at: T0,
  trigger: 'decision',
  supersedes_id: null,
  superseded_by_id: 'rdec-formal-1',
  client_key: 'legacy-key',
  snapshot_id: null,
  reasonCodes: ['tactical_fit'],
  evidenceRefs: [],
  assessmentIds: [],
  ...over,
});
const formalRow = (over = {}) => ({
  id: 'rdec-formal-1',
  room_id: 'case-x',
  org_id: 'org-x',
  player_id: 'pl-x',
  kind: 'formal',
  state: 'final',
  outcome: 'progress',
  recommendation: 'offer',
  note: 'First formal.',
  ...BY,
  created_at: T0 + 10,
  finalized_at: T0 + 10,
  trigger: 'decision:finalize',
  client_key: 'fin-1',
  supersedes_id: 'rdec-legacy',
  superseded_by_id: 'rdec-formal-2',
  supersession_of_id: null,
  supersession_reason: null,
  rev: 2,
  rev_at: T0 + 20,
  assessments_submitted: 1,
  assessments_withheld: 0,
  assessment_verdicts_json: JSON.stringify({ sign: 1, monitor: 0, pass: 0, none: 0 }),
  snapshot_id: null,
  finalize_key: 'fin-1',
  finalize_fp: '{"fixture":1}',
  draft_key: 'draft-1',
  draft_fp: '{"fixture":1}',
  draft_id: 'rdraft-1',
  lifecycle_action: 'considerOffer',
  lifecycle_from: 'shortlisted',
  lifecycle_to: 'offer_consideration',
  lifecycle_applied: 1,
  lifecycle_at: T0 + 10,
  policy_version: 1,
  reasonCodes: ['position_need'],
  evidenceRefs: [
    {
      kind: 'assessment',
      ref_id: 'ass-1',
      meta_json: JSON.stringify({ scoutName: 'S', submittedAt: T0, verdict: 'sign', trialId: null }),
    },
  ],
  assessmentIds: ['ass-1'],
  ...over,
});
const headRow = (over = {}) =>
  formalRow({
    id: 'rdec-formal-2',
    outcome: 'hold',
    recommendation: 'continue_watching',
    reasonCodes: ['timing'],
    note: 'Second formal.',
    created_at: T0 + 20,
    finalized_at: T0 + 20,
    client_key: 'fin-2',
    supersedes_id: 'rdec-formal-1',
    superseded_by_id: null,
    supersession_of_id: 'rdec-formal-1',
    supersession_reason: 'Budget review.',
    rev: 1,
    rev_at: T0 + 20,
    evidenceRefs: [],
    assessmentIds: ['ass-1'],
    finalize_key: 'fin-2',
    finalize_fp: '{"fixture":2}',
    draft_key: null,
    draft_fp: null,
    draft_id: 'rdraft-2',
    lifecycle_action: 'holdCase',
    lifecycle_from: 'offer_consideration',
    lifecycle_to: 'on_hold',
    lifecycle_at: T0 + 20,
    ...over,
  });
// The draft on the case: its case_decision_drafts row and its reason codes.
const draftRow = (over = {}) => ({
  case_id: 'case-x',
  id: 'rdraft-3',
  outcome: 'reject',
  note: 'Thinking.',
  ...BY,
  created_at: T0 + 30,
  updated_at: T0 + 31,
  updated_by_user_id: 'usr-owner',
  updated_by_name: 'Owner',
  updated_by_role: 'Head of Recruitment',
  rev: 2,
  rev_at: T0 + 31,
  create_key: 'draft-3',
  create_fp: '{"fixture":3}',
  reasonCodes: ['insufficient_recent_evidence'],
  evidenceRefs: [],
  ...over,
});

/** The whole fixture, by table: the base rows, the draft (if any) and the decisions with their child rows. */
const fixture = (decisions = [], { draft = null, roomStatus } = {}) => {
  const listed = (owner, key, list, row) => list.map((x, position) => ({ [key]: owner, position, ...row(x) }));
  return {
    ...baseRows({ roomStatus }),
    case_decision_drafts: draft ? [(({ reasonCodes, evidenceRefs, ...row }) => row)(draft)] : [],
    case_decision_draft_reason_codes: draft
      ? listed(draft.case_id, 'case_id', draft.reasonCodes, (code) => ({ code }))
      : [],
    case_decision_draft_evidence_refs: draft ? listed(draft.case_id, 'case_id', draft.evidenceRefs, (ref) => ref) : [],
    room_decisions: decisions.map(({ reasonCodes, evidenceRefs, assessmentIds, ...row }) => row),
    room_decision_reason_codes: decisions.flatMap((d) =>
      listed(d.id, 'decision_id', d.reasonCodes, (code) => ({ code })),
    ),
    room_decision_evidence_refs: decisions.flatMap((d) => listed(d.id, 'decision_id', d.evidenceRefs, (ref) => ref)),
    room_decision_assessment_ids: decisions.flatMap((d) =>
      listed(d.id, 'decision_id', d.assessmentIds, (assessment_id) => ({ assessment_id })),
    ),
  };
};

/** Write `tables` into `dir` in one transaction, its references checked at the end (a decision chain points both ways). */
const write = (dir, tables) => {
  const F = openFixture(dir, { now: NOW });
  try {
    F.transaction(() => {
      if (F.fresh) F.markInstalled();
      F.sql.exec('PRAGMA defer_foreign_keys = ON');
      for (const [table, rs] of Object.entries(tables)) for (const r of rs) F.insert(table, r);
    });
  } finally {
    F.close();
  }
  return dir;
};

/** What a stopped server left: the decision and draft tables, the cases, and the names of every table. */
const stored = (dir) => {
  const R = readRows(dir);
  try {
    return {
      ...Object.fromEntries([...DECISION_TABLES, ...DRAFT_TABLES, 'recruitment_cases'].map((t) => [t, R.rows(t)])),
      tables: R.tables(),
    };
  } finally {
    R.close();
  }
};
const same = (a, b, tables) => tables.every((t) => JSON.stringify(a[t]) === JSON.stringify(b[t]));
const lead = (s) =>
  s
    .j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
    .then((r) => r.body);

// ======================================================= 1 — no migration
section('1 — no decision migration: one decision store, the draft on the case, nothing renamed');
{
  // The rows surviving a boot unchanged, with no case field invented, is proved over a real boot in section 2.
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23d-tables-')));
  let tables;
  let draftKey;
  try {
    tables = R.tables();
    draftKey = R.sql
      .prepare('PRAGMA table_info(case_decision_drafts)')
      .all()
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .join();
  } finally {
    R.close();
  }
  ok(
    MIGRATIONS.length === LATEST_SCHEMA && !MIGRATIONS.some((id) => /decision/i.test(id)),
    'the current schema, and the decision adds no migration of its own (its table comes with the cases, 0016)',
  );
  ok(tables.includes('room_decisions'), 'room_decisions is a typed table read through SQL');
  neg(
    !tables.includes('recruitment_decisions') && !tables.includes('decision_drafts') && draftKey === 'case_id',
    "no second decision table and no draft table of its own: a draft is its case's, keyed by the case",
  );
}

// ======================================================= 2 — byte-faithful restore
section('2 — a fixture with legacy + formal rows and a draft restores byte-faithfully through a real boot');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-restore-'));
  write(DIR, fixture([legacyRow(), formalRow(), headRow()], { draft: draftRow(), roomStatus: 'on_hold' }));
  // The reference is the store as written: every row of the decisions and the draft, as stored.
  const saved = stored(DIR);
  const s = await bootOn(DIR, PORT);
  ok(s.up, 'the server boots on the fixture');
  const L = await lead(s);
  const sf = await s.j('GET', '/org/rooms/case-x/decision', undefined, L.token);
  ok(
    sf.status === 200 &&
      sf.body.current?.id === 'rdec-formal-2' &&
      sf.body.current.outcome === 'hold' &&
      sf.body.current.rev === 1 &&
      sf.body.current.supersession?.reason === 'Budget review.' &&
      sf.body.omitted === 0 &&
      sf.body.duplicateHeads.length === 0,
    'the surface: the hold is current, with its supersession reason; nothing omitted',
  );
  ok(
    sf.body.history.map((d) => d.id).join() === 'rdec-formal-2,rdec-formal-1,rdec-legacy' &&
      sf.body.history[1].rev === 2 &&
      sf.body.history[1].supersededById === 'rdec-formal-2' &&
      sf.body.history[2].kind === 'recommendation' &&
      sf.body.history[2].supersededById === 'rdec-formal-1',
    'the chain reads newest first: hold ← progress (rev 2, superseded) ← legacy advisory (superseded by the progress)',
  );
  ok(
    sf.body.draft?.id === 'rdraft-3' &&
      sf.body.draft.rev === 2 &&
      sf.body.draft.outcome === 'reject' &&
      sf.body.draft.note === 'Thinking.',
    'the draft restored with its rev and content',
  );
  ok(
    sf.body.history[1].evidenceRefs[0].meta.verdict === 'sign' &&
      sf.body.history[1].assessmentSummary.assessmentIds[0] === 'ass-1',
    'the references and the assessment snapshot restored on the superseded row',
  );
  // Keys restored: the stored fingerprints are fixture values, so a different payload under the same key is a CONFLICT — the key was restored.
  const dk = await s.j('POST', '/org/rooms/case-x/decision/draft', { outcome: 'hold', clientKey: 'draft-3' }, L.token);
  neg(
    dk.status === 409 && dk.body.error === 'DECISION_IDEMPOTENCY_CONFLICT',
    'the draft key on the case was restored (mismatched fingerprint is a conflict, not a fresh draft)',
  );
  const fk = await s.j('POST', '/org/rooms/case-x/decision/finalize', { expectedRev: 2, clientKey: 'fin-2' }, L.token);
  neg(
    fk.status === 409 && fk.body.error === 'DECISION_IDEMPOTENCY_CONFLICT',
    'the finalize key on the formal row was restored too',
  );
  const stale = await s.j('PATCH', '/org/rooms/case-x/decision/draft', { note: 'x', expectedRev: 1 }, L.token);
  neg(
    stale.status === 409 && stale.body.error === 'DECISION_VERSION_CONFLICT' && stale.body.currentRev === 2,
    'the draft rev is enforced from the fixture',
  );
  const legacyRoute = await s.j('GET', '/org/rooms/case-x/decisions', undefined, L.token);
  ok(
    legacyRoute.status === 200 &&
      legacyRoute.body.current?.id === 'rdec-formal-2' &&
      legacyRoute.body.history.length === 3,
    'the Rooms route reads the same three rows and the same head',
  );
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, L.token);
  ok(
    jr.status === 200 &&
      jr.body.decisions.formal?.id === 'rdec-formal-2' &&
      jr.body.decisions.draft?.id === 'rdraft-3' &&
      jr.body.lifecycle.currentStage === 'on_hold',
    'the journey projects the formal head, the draft and the case stage',
  );
  const after = await s.stop();
  for (const t of [...DECISION_TABLES, ...DRAFT_TABLES])
    if (!same(after, saved, [t]))
      console.error(`   ${t} before ${JSON.stringify(saved[t])}\n   ${t} after  ${JSON.stringify(after[t])}`);
  ok(
    same(after, saved, [...DECISION_TABLES, ...DRAFT_TABLES]),
    'after a boot, reads, refused writes and a graceful stop, every row and the draft are identical in every column — nothing rewritten, re-ordered or "repaired"',
  );
  neg(!s.log().includes('DECISION integrity'), 'no integrity warning was logged for sound rows');
  neg(
    !Object.keys(after.recruitment_cases[0]).some((c) => /decision_status/.test(c)),
    'no case field was invented for the decision — the case carries only its draft',
  );
}

// ======================================================= 3 — corrupt rows
section('3 — corrupt formal rows are named and omitted; duplicate heads are corruption, not a tie');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-corrupt-'));
  // Six defects. Four are values the typed columns cannot hold: the schema refuses each. Two — a formal row with no
  // actor and one citing a prohibited reason code — are rows the tables can carry: they are planted and judged on read.
  const unstorable = [
    formalRow({
      id: 'rdec-bad-outcome',
      outcome: 'accept',
      supersedes_id: null,
      superseded_by_id: 'x1',
      created_at: T0 + 1,
    }),
    formalRow({
      id: 'rdec-bad-proto',
      outcome: '__proto__',
      supersedes_id: null,
      superseded_by_id: 'x1',
      created_at: T0 + 2,
    }),
    formalRow({ id: 'rdec-bad-time', created_at: 'yesterday', supersedes_id: null, superseded_by_id: 'x1' }),
    formalRow({ id: 'rdec-bad-rev', rev: 0, supersedes_id: null, superseded_by_id: 'x1', created_at: T0 + 7 }),
  ];
  const bad = [
    formalRow({ id: 'rdec-bad-actor', ...NO_ACTOR, supersedes_id: null, superseded_by_id: 'x1', created_at: T0 + 3 }),
    formalRow({
      id: 'rdec-bad-code',
      reasonCodes: ['race'],
      supersedes_id: null,
      superseded_by_id: 'x1',
      created_at: T0 + 5,
    }),
  ];
  // A fixture is one transaction: a row the schema refuses (a CHECK, a STRICT type, a reference to a decision that
  // does not exist) refuses the whole fixture, and the directory is left as a new one with nothing written.
  {
    const everything = (dir) => {
      const R = readRows(dir);
      try {
        return JSON.stringify(R.all());
      } finally {
        R.close();
      }
    };
    const FRESH = (() => {
      const D = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-fresh-'));
      openFixture(D, { now: NOW }).close();
      return everything(D);
    })();
    const refused = async (label, decisions, pattern) => {
      const D = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-refused-'));
      let err = null;
      try {
        write(
          D,
          fixture([
            legacyRow({ superseded_by_id: 'rdec-formal-2' }),
            headRow({ supersedes_id: 'rdec-legacy' }),
            ...decisions,
          ]),
        );
      } catch (e) {
        err = e;
      }
      const refusal = String(err?.message ?? '');
      ok(!!err && pattern.test(refusal), `${label}: the write is REFUSED by the schema (${refusal.slice(0, 160)}…)`);
      ok(everything(D) === FRESH, `${label}: nothing was written — nothing deleted, nothing repaired`);
    };
    // What each column says of the value it cannot hold.
    const why = {
      outcome: /CHECK constraint failed: outcome/,
      created_at: /cannot store TEXT value in INTEGER column room_decisions\.created_at/,
      rev: /CHECK constraint failed: rev/,
    };
    for (const [r, field] of unstorable.map((r, i) => [r, ['outcome', 'outcome', 'created_at', 'rev'][i]]))
      await refused(`a corrupt row the typed columns cannot hold (${r.id}.${field})`, [r], why[field]);
    await refused(
      'two corrupt rows whose chain pointer names a decision that does not exist',
      bad,
      /FOREIGN KEY constraint failed/,
    );
  }
  // The two storable defects, each row superseded by the real head, are stored and judged on read.
  for (const r of bad) r.superseded_by_id = 'rdec-formal-2';
  write(
    DIR,
    fixture([legacyRow({ superseded_by_id: 'rdec-formal-2' }), headRow({ supersedes_id: 'rdec-legacy' }), ...bad]),
  );
  const savedRows = stored(DIR);
  const s = await bootOn(DIR, await freePort());
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots with two corrupt formal rows in the store');
  const L = await lead(s);
  const sf = await s.j('GET', '/org/rooms/case-x/decision', undefined, L.token);
  if (sf.status !== 200)
    console.error(
      '   surface',
      sf.status,
      JSON.stringify(sf.body).slice(0, 300),
      s
        .log()
        .split('\n')
        .filter((l) => /Error|TypeError/.test(l))
        .slice(0, 4)
        .join(' | '),
    );
  ok(
    sf.status === 200 && sf.body.current?.id === 'rdec-formal-2' && sf.body.history.length === 2,
    'the surface serves the sound head and the legacy row',
  );
  neg(sf.body.omitted === 2, `two corrupt formal rows are counted as omitted (${sf.body.omitted})`);
  const log = s.log();
  neg(
    bad.every((r) => log.includes(`DECISION integrity ${r.id}`)),
    'every corrupt row is NAMED in the server log with its problems',
  );
  const jr = await s.j('GET', '/org/rooms/case-x/journey', undefined, L.token);
  ok(
    jr.status === 200 && jr.body.decisions.formal?.id === 'rdec-formal-2',
    'the journey still projects the sound head',
  );
  const after = await s.stop();
  neg(
    after.room_decisions.length === 4 &&
      after.room_decision_reason_codes.some(
        (x) => x.decision_id === 'rdec-bad-code' && x.position === 0 && x.code === 'race',
      ),
    'the corrupt rows are still in the snapshot exactly as they were — omitted on read, never deleted or "repaired" on write',
  );
  if (!same(after, savedRows, DECISION_TABLES))
    console.error('   store changed', JSON.stringify(after.room_decisions).slice(0, 300));
  ok(same(after, savedRows, DECISION_TABLES), 'the whole store is identical in every column');

  // Duplicate final heads.
  const DIR2 = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-dup-'));
  write(
    DIR2,
    fixture(
      [
        headRow({ id: 'rdec-head-a', supersedes_id: null }),
        headRow({ id: 'rdec-head-b', supersedes_id: null, created_at: T0 + 21 }),
      ],
      { draft: draftRow() },
    ),
  );
  const saved2 = stored(DIR2);
  const s2 = await bootOn(DIR2, await freePort());
  ok(s2.up, 'the server boots with two formal rows both claiming to be current');
  const L2 = await lead(s2);
  const dup = await s2.j('GET', '/org/rooms/case-x/decision', undefined, L2.token);
  neg(
    dup.status === 500 && dup.body.error === 'DECISION_STATE_UNKNOWN',
    'reading the surface is DECISION_STATE_UNKNOWN (500) — no honest "current decision" exists',
  );
  const fin = await s2.j('POST', '/org/rooms/case-x/decision/finalize', { expectedRev: 2 }, L2.token);
  neg(
    fin.status === 500 && fin.body.error === 'DECISION_STATE_UNKNOWN',
    'nothing new is finalized on top of corruption',
  );
  neg(s2.log().includes('duplicate_final_heads rdec-head-a,rdec-head-b'), 'the duplicate heads are named in the log');
  const after2 = await s2.stop();
  ok(
    same(after2, saved2, [...DECISION_TABLES, ...DRAFT_TABLES]),
    'the two heads and the draft are still there, untouched — a person decides which is true, not the boot',
  );
}

// ======================================================= 4 — legacy rows
section('4 — legacy advisory row read as advisory and keep their chain; P5 judges only formal rows');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-legacy-'));
  write(
    DIR,
    fixture([
      legacyRow({ id: 'rdec-l1', created_at: T0, superseded_by_id: 'rdec-l2' }),
      legacyRow({
        id: 'rdec-l2',
        recommendation: 'offer',
        reasonCodes: [],
        note: null,
        created_at: T0 + 1,
        supersedes_id: 'rdec-l1',
        superseded_by_id: null,
      }),
      // An odd legacy row: no actor and no reason (a time is a typed column, so the schema refuses junk there).
      legacyRow({ id: 'rdec-l-odd', ...NO_ACTOR, reasonCodes: [], superseded_by_id: 'rdec-l1' }),
    ]),
  );
  const savedLegacy = stored(DIR);
  const s = await bootOn(DIR, await freePort());
  ok(s.up, 'the server boots on a legacy-only decision memory');
  const L = await lead(s);
  const sf = await s.j('GET', '/org/rooms/case-x/decision', undefined, L.token);
  ok(
    sf.status === 200 &&
      sf.body.current === null &&
      sf.body.advisory?.id === 'rdec-l2' &&
      sf.body.advisory.kind === 'recommendation' &&
      sf.body.advisory.recommendation === 'offer' &&
      sf.body.omitted === 0,
    'an advisory "offer" recommendation at the head is ADVISORY — not a formal decision, not current',
  );
  neg(sf.body.requirements.hasFinal === false, 'no legacy row is read as formal, whatever it recommends');
  ok(
    sf.body.history.length === 3 && sf.body.omitted === 0 && !s.log().includes('DECISION integrity'),
    'an odd legacy row (no actor, no reason) is served as the Rooms always served it — P5 does not judge it',
  );
  const byHand = await s.j('POST', '/org/rooms/case-x/lifecycle', { action: 'considerOffer', expectedRev: 2 }, L.token);
  neg(
    byHand.status === 422 &&
      byHand.body.error === 'LIFECYCLE_EVIDENCE_REQUIRED' &&
      byHand.body.evidenceReason === 'no_finalized_progress_decision',
    'and the advisory "offer" does not evidence offer_consideration',
  );
  const after = await s.stop();
  ok(same(after, savedLegacy, DECISION_TABLES), 'the legacy rows are identical in every column after the boot');
}

// ======================================================= 5 — clean boot, live flow, restart
section('5 — clean boot: draft → finalize → stop → reboot: one store, keys replay, the draft is gone');
{
  const DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23d-clean-'));
  write(DIR, fixture());
  const s = await bootOn(DIR, await freePort());
  const L = await lead(s);
  const d = await s.j(
    'POST',
    '/org/rooms/case-x/decision/draft',
    { outcome: 'progress', reasonCodes: ['position_need'], note: 'Clean.', clientKey: 'clean-draft' },
    L.token,
  );
  ok(d.status === 201 && d.body.draft.rev === 1, 'a draft opens on a clean database');
  const snap0 = await s.stop();
  ok(
    snap0.case_decision_drafts.length === 1 &&
      snap0.case_decision_drafts[0].case_id === 'case-x' &&
      snap0.case_decision_drafts[0].id === d.body.draft.id &&
      snap0.case_decision_drafts[0].create_key === 'clean-draft' &&
      snap0.room_decisions.length === 0,
    'the snapshot holds the draft ON THE CASE with its key, and no decision row',
  );
  const s2 = await bootOn(DIR, await freePort());
  const L2 = await lead(s2);
  const replayDraft = await s2.j(
    'POST',
    '/org/rooms/case-x/decision/draft',
    { outcome: 'progress', reasonCodes: ['position_need'], note: 'Clean.', clientKey: 'clean-draft' },
    L2.token,
  );
  ok(replayDraft.status === 200 && replayDraft.body.idempotent === true, 'after the reboot the draft key replays');
  const fin = await s2.j(
    'POST',
    '/org/rooms/case-x/decision/finalize',
    { expectedRev: 1, clientKey: 'clean-final' },
    L2.token,
  );
  ok(
    fin.status === 201 && fin.body.lifecycle.to === 'offer_consideration',
    'the draft finalizes to a progress decision and the case moves',
  );
  const snap1 = await s2.stop();
  const row = snap1.room_decisions.find((x) => x.id === fin.body.decision.id);
  ok(
    row &&
      row.kind === 'formal' &&
      row.state === 'final' &&
      row.outcome === 'progress' &&
      row.finalize_key === 'clean-final' &&
      row.draft_key === 'clean-draft' &&
      row.draft_id === d.body.draft.id &&
      snap1.case_decision_drafts.length === 0 &&
      snap1.recruitment_cases[0].room_status === 'offer_consideration',
    'the snapshot holds the formal row on room_decisions with both keys, the draft cleared, the case at offer_consideration',
  );
  neg(
    snap1.tables
      .filter((t) => /decision/.test(t))
      .sort()
      .join() === [...DECISION_TABLES, ...DRAFT_TABLES].sort().join() &&
      snap1.tables.filter((t) => /offer/.test(t)).every((t) => t === 'recruitment_offers' || t.startsWith('offer_')),
    'no P5 store appeared beside the decision and draft tables (the P6 Offer tables are the one Offer store)',
  );
  const s3 = await bootOn(DIR, await freePort());
  const L3 = await lead(s3);
  const replayFin = await s3.j(
    'POST',
    '/org/rooms/case-x/decision/finalize',
    { expectedRev: 1, clientKey: 'clean-final' },
    L3.token,
  );
  ok(
    replayFin.status === 200 &&
      replayFin.body.idempotent === true &&
      replayFin.body.decision.id === fin.body.decision.id,
    'after another reboot the finalize key replays the same decision',
  );
  const replayDraft2 = await s3.j(
    'POST',
    '/org/rooms/case-x/decision/draft',
    { outcome: 'progress', reasonCodes: ['position_need'], note: 'Clean.', clientKey: 'clean-draft' },
    L3.token,
  );
  ok(
    replayDraft2.status === 200 &&
      replayDraft2.body.idempotent === true &&
      replayDraft2.body.decision?.id === fin.body.decision.id,
    'and the draft key replays the decision it became',
  );
  const sf = await s3.j('GET', '/org/rooms/case-x/decision', undefined, L3.token);
  ok(
    sf.body.current?.id === fin.body.decision.id && sf.body.draft === null && sf.body.history.length === 1,
    'the surface after two reboots: one formal decision, no draft',
  );
  const snap2 = await s3.stop();
  ok(same(snap2, snap1, DECISION_TABLES), 'a reboot with only reads and replays rewrote nothing');
}

// ------------------------------------------------------------ report
console.log(
  `\nrecruitment/decisionsPersistence: ${passed} checks passed, ${negatives} negative (${Math.round((negatives / passed) * 100)}%)`,
);
if (process.exitCode === 1) console.error('\n✗ recruitment/decisionsPersistence has failures.');
else console.log('all recruitment/decisionsPersistence checks passed');
process.exit(process.exitCode ?? 0);
