// Writes the matrix fixtures: what a TypeScript rule over a small finite domain answers for every input that matters
// to it, so one Gleam test per rule can check every row (dev/battery_cases/matrices.mjs checks the rules suites'
// recorded calls against the same fixtures). Regenerate with `node dev/matrix_cases.mjs`.
//
//   test/fixtures/lifecycle_matrix.json   canTransitionRecruitmentCase and availableActions
//                                         (domains/recruitment/lifecycle/lifecycle.mjs), for
//                                         test/scoutbox/recruitment/lifecycle_matrix_test.gleam
//   test/fixtures/contact_matrix.json     canContactAction (domains/recruitment/lifecycle/contact.mjs), for
//                                         test/scoutbox/recruitment/contact_matrix_test.gleam
//   test/fixtures/next_action_matrix.json nextActionFor (domains/recruitment/lifecycle/journeyModel.mjs), for
//                                         test/scoutbox/recruitment/next_action_matrix_test.gleam
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS = path.join(HERE, '../../../scoutbox/scoutbox-server/domains/recruitment');
const FIXTURES = path.join(HERE, '../test/fixtures');
const line = (v) => JSON.stringify(v);

// -------------------------------------------------------------------------------------------- the lifecycle
//
// The inputs are the product of:
//   status    every Room status the case may be at
//   action    every lifecycle action
//   role      no role, and every Room role
//   mode      performed with a reason code, performed with none, or asked about for availability
//   evidence  a provider that holds every kind of record, or the TypeScript default that holds none
//             (`not_implemented`); each target needs at most one kind, so the two cover every answer
//   held      only for resumeCase, the one action that reads the history: no hold, or a hold from each status
//
// Each distinct result is stored once (`results`); a table lists, in the order of the loops below, the index of
// each input's result.
{
  const L = await import(path.join(TS, 'lifecycle/lifecycle.mjs'));
  const { ROOM_STATUSES } = await import(path.join(TS, 'rooms/shared.mjs'));

  const statuses = [...ROOM_STATUSES];
  const actions = [...L.LIFECYCLE_ACTION_NAMES];
  const roles = [null, 'viewer', 'contributor', 'room_lead', 'recruitment_admin'];
  const modes = ['reasons', 'none', 'available'];
  const evidence = ['holds', 'lacks'];
  const held = [null, ...statuses];

  const PROVIDERS = { holds: { check: () => ({ satisfied: true }) }, lacks: L.NULL_EVIDENCE_PROVIDER };
  const CONTEXTS = {
    reasons: { reasonCodes: ['club_decision'] },
    none: { reasonCodes: [] },
    available: { forAvailability: true },
  };

  const kase = (status, from) => ({
    id: 'case-m',
    orgId: 'org-m',
    playerId: 'pl-m',
    room: { status, rev: 1 },
    history: from === null ? [] : [{ action: 'room_status_changed', detail: { from, to: 'on_hold' } }],
  });

  const results = [];
  const index = new Map();
  const intern = (value) => {
    const text = JSON.stringify(value);
    if (!index.has(text)) {
      index.set(text, results.length);
      results.push(text);
    }
    return index.get(text);
  };

  // check[action]: [held ×] status × role × mode × evidence, held only for resumeCase.
  const check = {};
  for (const action of actions) {
    const cells = [];
    for (const h of action === 'resumeCase' ? held : [null])
      for (const status of statuses)
        for (const role of roles)
          for (const mode of modes)
            for (const ev of evidence)
              cells.push(
                intern(
                  L.canTransitionRecruitmentCase(kase(status, h), action, {
                    role,
                    ...CONTEXTS[mode],
                    evidence: PROVIDERS[ev],
                  }),
                ),
              );
    check[action] = cells;
  }

  // available: held × status × role × evidence.
  const available = [];
  for (const h of held)
    for (const status of statuses)
      for (const role of roles)
        for (const ev of evidence)
          available.push(intern(L.availableActions(kase(status, h), { role, evidence: PROVIDERS[ev] })));

  fs.writeFileSync(
    path.join(FIXTURES, 'lifecycle_matrix.json'),
    `{
  "statuses": ${line(statuses)},
  "actions": ${line(actions)},
  "roles": ${line(roles)},
  "modes": ${line(modes)},
  "evidence": ${line(evidence)},
  "held": ${line(held)},
  "results": [
${results.map((r) => `    ${line(r)}`).join(',\n')}
  ],
  "check": {
${actions.map((a) => `    ${line(a)}: ${line(check[a])}`).join(',\n')}
  },
  "available": ${line(available)}
}
`,
  );
  console.log(`lifecycle_matrix: ${results.length} distinct results, ${Object.values(check).flat().length + available.length} inputs`);
}

// --------------------------------------------------------------------------------------------- the contacts
//
// Every contact status × every contact action × no role and every Room role. The validator reads only the
// contact's status, so a contact is `{ status }`. Each row is keyed `<status> <action> <role or none>`.
{
  const C = await import(path.join(TS, 'lifecycle/contact.mjs'));
  const statuses = [...C.CONTACT_STATUSES];
  const actions = [...C.CONTACT_ACTION_NAMES];
  const roles = [null, 'viewer', 'contributor', 'room_lead', 'recruitment_admin'];
  const rows = [];
  for (const status of statuses)
    for (const action of actions)
      for (const role of roles)
        rows.push([`${status} ${action} ${role ?? 'none'}`, JSON.stringify(C.canContactAction({ status }, action, { role }))]);
  fs.writeFileSync(
    path.join(FIXTURES, 'contact_matrix.json'),
    `{
  "statuses": ${line(statuses)},
  "actions": ${line(actions)},
  "roles": ${line(roles)},
  "answers": {
${rows.map(([k, v]) => `    ${line(k)}: ${line(v)}`).join(',\n')}
  }
}
`,
  );
  console.log(`contact_matrix: ${rows.length} inputs`);
}

// -------------------------------------------------------------------------------------------- the next action
//
// nextActionFor (domains/recruitment/lifecycle/journeyModel.mjs) is finish(pick(status, facts)): `pick` chooses the
// code and the resources from the status and the case's current records, and `finish` adds what the code, the role
// and the two blocks decide. Each half is a matrix of its own.
//
//   pick     Each fact the rule reads, as the classes its record can be in: assessed; a formal decision or none; the
//            current contact's status or none; the current trial with no sessions, its last session ended before
//            now, at now or after, or none; a pending trial request or none; the current Offer's status, its live
//            revision's status and whether it has a revision, or none; the current signing package's effective
//            status, whether the club or another party is still to sign and whether it names a completed signing,
//            or none; a signing row or none. Every status is taken with every combination of the facts `reads`
//            names for it, and with every value of each other fact, one at a time; the generator refuses to write
//            the fixture if one of those changes the answer, so `reads` is checked against the TypeScript rule.
//   finish   Every code × no role and every Room role × blocked × subject removed × the journey's integrity error,
//            which the projector (journey.mjs) adds to a club act after nextActionFor answers.
//
// Each row lists its classes as indices into the value lists, then the index of its answer in `results`.
{
  const M = await import(path.join(TS, 'lifecycle/journeyModel.mjs'));
  const { ROOM_STATUSES } = await import(path.join(TS, 'rooms/shared.mjs'));
  const S = await import(path.join(TS, 'signings/signing.mjs'));
  const C = await import(path.join(TS, 'lifecycle/contact.mjs'));
  const O = await import(path.join(TS, 'offers/offer.mjs'));

  const now = 1_800_000_000_000;
  const OFFER = [null, ...O.OFFER_STATUSES];
  const SIGNING = [...S.SIGNING_STORED_STATUSES, 'EXPIRED'];
  const values = {
    assessed: [false, true],
    decision: [null, 'rdc-m'],
    contact: [null, ...C.CONTACT_STATUSES],
    trial: [null, 'no_sessions', 'ended', 'ends_now', 'later'],
    request: [null, 'rrq-m'],
    offer: [null, ...OFFER.flatMap((status) => OFFER.flatMap((live) => [false, true].map((rev) => [status, live, rev])))],
    signing: [
      null,
      ...SIGNING.flatMap((st) =>
        [false, true].flatMap((club) => [false, true].flatMap((others) => [false, true].map((done) => [st, club, others, done]))),
      ),
    ],
    signingRow: [null, 'sg-row-m'],
  };
  const dims = Object.keys(values);
  const reads = {
    watching: [],
    under_review: ['assessed', 'decision'],
    shortlisted: ['assessed', 'decision'],
    priority: ['assessed', 'decision'],
    contact_planned: ['contact'],
    contacted: ['contact'],
    trial_requested: ['request'],
    trial_scheduled: ['trial'],
    trial_completed: ['assessed', 'decision', 'trial'],
    offer_consideration: ['decision', 'offer'],
    offer_made: ['offer'],
    offer_declined: ['offer'],
    offer_accepted: ['offer', 'signing'],
    signed: ['signing', 'signingRow'],
    on_hold: [],
    withdrawn: [],
    archived: [],
    closed: [],
  };
  if (Object.keys(reads).sort().join() !== [...ROOM_STATUSES].sort().join()) throw new Error('reads names every status');

  const trialOf = (t) => {
    if (t === null) return null;
    const ends = { no_sessions: null, ended: now - 1, ends_now: now, later: now + 1 }[t];
    return { id: 'trl-m', schedule: { sessions: ends === null ? [] : [{ id: 'ses-m', endsAt: ends }] } };
  };
  const offerOf = (o) =>
    o === null ? null : { offer: { id: 'rof-m' }, revision: o[2] ? { id: 'rrev-m' } : null, status: o[0], liveStatus: o[1] };
  const signingOf = (s) => {
    if (s === null) return null;
    const [st, club, others, done] = s;
    const pkg = {
      id: 'spk-m',
      status: st === 'EXPIRED' ? 'READY' : st,
      createdAt: now - 1000,
      expiresAt: st === 'EXPIRED' ? now - 1 : now + 86_400_000,
      currentRevisionId: 'srev-m',
      revisions: [
        {
          id: 'srev-m',
          status: 'READY',
          requiredParties: [
            { partyType: 'PLAYER', status: others ? 'PENDING' : 'COMPLETED' },
            { partyType: 'CLUB_SIGNATORY', status: club ? 'PENDING' : 'COMPLETED' },
          ],
        },
      ],
      completion: done ? { signingId: 'sg-m' } : null,
    };
    if (S.effectiveStatus(pkg, now) !== st) throw new Error(`a package built as ${st} reads as ${S.effectiveStatus(pkg, now)}`);
    return pkg;
  };
  const facts = (status, row) => {
    const v = Object.fromEntries(dims.map((d, i) => [d, values[d][row[i]]]));
    return {
      status,
      now,
      assessed: v.assessed,
      decision: v.decision === null ? null : { id: v.decision },
      contact: v.contact === null ? null : { id: 'rct-m', status: v.contact },
      trial: trialOf(v.trial),
      trialRequest: v.request === null ? null : { id: v.request },
      offer: offerOf(v.offer),
      signing: signingOf(v.signing),
      signingRow: v.signingRow === null ? null : { id: v.signingRow },
    };
  };

  const results = [];
  const index = new Map();
  const intern = (value) => {
    const text = JSON.stringify(value);
    if (!index.has(text)) {
      index.set(text, results.length);
      results.push(text);
    }
    return index.get(text);
  };
  const product = (names) =>
    names.reduce((rows, d) => rows.flatMap((r) => values[d].map((_, i) => ({ ...r, [d]: i }))), [{}]);

  const pick = [];
  const seen = new Set();
  const answer = (status, row) => {
    const { code, resources } = M.nextActionFor({ ...facts(status, row), role: 'recruitment_admin' });
    return { code, resources };
  };
  const push = (status, row) => {
    const key = `${status} ${row.join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    pick.push([ROOM_STATUSES.indexOf(status), ...row, intern(answer(status, row))]);
  };
  for (const status of ROOM_STATUSES) {
    const own = product(reads[status]);
    for (const r of own) push(status, dims.map((d) => r[d] ?? 0));
    // Each other fact, every value, over the first and the last combination of the facts the status reads.
    for (const r of [own[0], own[own.length - 1]]) {
      const base = dims.map((d) => r[d] ?? 0);
      const expected = JSON.stringify(answer(status, base));
      dims.forEach((d, i) => {
        if (reads[status].includes(d)) return;
        values[d].forEach((_, v) => {
          const row = base.with(i, v);
          if (JSON.stringify(answer(status, row)) !== expected)
            throw new Error(`nextActionFor at ${status} reads ${d}, which reads doesn't name`);
          push(status, row);
        });
      });
    }
  }

  // finish: a code's envelope. A code is reached with its resources; finish passes them through, so any do.
  const codes = [...M.NEXT_ACTION_CODES];
  const roles = [null, 'viewer', 'contributor', 'room_lead', 'recruitment_admin'];
  const finishResults = [];
  const finishIndex = new Map();
  const internFinish = (value) => {
    const text = JSON.stringify(value);
    if (!finishIndex.has(text)) {
      finishIndex.set(text, finishResults.length);
      finishResults.push(text);
    }
    return finishIndex.get(text);
  };
  // A status whose rule can answer the code with no records, if there is one: finish only reads the code.
  const reach = (code) => {
    for (const status of ROOM_STATUSES)
      for (const r of product(reads[status])) {
        const row = dims.map((d) => r[d] ?? 0);
        if (answer(status, row).code === code) return [status, row];
      }
    return null;
  };
  const finish = [];
  for (const code of codes) {
    const at = reach(code);
    for (const role of roles)
      for (const blocked of [false, true])
        for (const removed of [false, true])
          for (const integrity of [false, true]) {
            const p = at ? facts(...at) : { status: '__unknown__', now };
            const next = M.nextActionFor({ ...p, role, blocked, subjectRemoved: removed });
            if (next.code !== code) throw new Error(`${code} was not reached`);
            // The projector's own rule (journey.mjs): a club act on a journey with an integrity error is blocked by it.
            if (integrity && next.kind === 'club' && !next.blockedBy.includes('INTEGRITY_ERROR'))
              next.blockedBy.push('INTEGRITY_ERROR');
            // The resources are pick's, passed through; the row is answered with none.
            finish.push([codes.indexOf(code), roles.indexOf(role), +blocked, +removed, +integrity, internFinish({ ...next, resources: {} })]);
          }
  }

  fs.writeFileSync(
    path.join(FIXTURES, 'next_action_matrix.json'),
    `{
  "now": ${now},
  "statuses": ${line([...ROOM_STATUSES])},
  "dims": ${line(dims)},
  "values": {
${dims.map((d) => `    ${line(d)}: ${line(values[d])}`).join(',\n')}
  },
  "reads": ${line(reads)},
  "results": [
${results.map((r) => `    ${line(r)}`).join(',\n')}
  ],
  "pick": [
${pick.map((r) => `    ${line(r)}`).join(',\n')}
  ],
  "codes": ${line(codes)},
  "roles": ${line(roles)},
  "finishResults": [
${finishResults.map((r) => `    ${line(r)}`).join(',\n')}
  ],
  "finish": [
${finish.map((r) => `    ${line(r)}`).join(',\n')}
  ]
}
`,
  );
  console.log(`next_action_matrix: ${pick.length} pick inputs (${results.length} answers), ${finish.length} finish inputs`);
}
