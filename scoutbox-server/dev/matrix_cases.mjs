// Writes the matrix fixtures: what a TypeScript rule over a small finite domain answers for every input that matters
// to it, so one Gleam test per rule can check every row (dev/battery_cases/matrices.mjs checks the rules suites'
// recorded calls against the same fixtures). Regenerate with `node dev/matrix_cases.mjs`.
//
//   test/fixtures/lifecycle_matrix.json   canTransitionRecruitmentCase and availableActions
//                                         (domains/recruitment/lifecycle/lifecycle.mjs), for
//                                         test/scoutbox/recruitment/lifecycle_matrix_test.gleam
//   test/fixtures/contact_matrix.json     canContactAction (domains/recruitment/lifecycle/contact.mjs), for
//                                         test/scoutbox/recruitment/contact_matrix_test.gleam
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
