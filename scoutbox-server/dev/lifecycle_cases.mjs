// Writes test/fixtures/lifecycle_matrix.json: what the TypeScript lifecycle validator (domains/recruitment/
// lifecycle/lifecycle.mjs: canTransitionRecruitmentCase and availableActions) answers over every input that matters
// to it, so test/scoutbox/recruitment/lifecycle_matrix_test.gleam can check the Gleam validator on all of them.
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
// each input's result. Regenerate with `node dev/lifecycle_cases.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS = path.join(HERE, '../../../scoutbox/scoutbox-server/domains/recruitment');
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
              intern(L.canTransitionRecruitmentCase(kase(status, h), action, { role, ...CONTEXTS[mode], evidence: PROVIDERS[ev] })),
            );
  check[action] = cells;
}

// available: held × status × role × evidence.
const available = [];
for (const h of held)
  for (const status of statuses)
    for (const role of roles)
      for (const ev of evidence) available.push(intern(L.availableActions(kase(status, h), { role, evidence: PROVIDERS[ev] })));

const line = (v) => JSON.stringify(v);
const text = `{
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
`;
fs.writeFileSync(path.join(HERE, '../test/fixtures/lifecycle_matrix.json'), text);
console.log(`lifecycle_matrix: ${results.length} distinct results, ${Object.values(check).flat().length + available.length} inputs`);
