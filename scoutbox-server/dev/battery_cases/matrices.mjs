// Rules proved over a whole matrix of inputs rather than one generated test per recorded call. A fixture written
// from the TypeScript rule holds its answer for every input that matters (dev/matrix_cases.mjs), and one Gleam
// test checks every row. Each recorded call is then looked up in the fixture: the recording must give the same
// answer, or the fixture is stale and cases:check fails.
//
// An entry is keyed as MAP's are, and has:
//
//   test           the Gleam test that checks the whole matrix
//   answer(call)   the fixture's answer for the call's arguments, as JSON text; throws a CannotHold when Gleam's
//                  types can't hold an argument (that call is then ported by hand, as a refused MAP call is)
import { readFileSync } from 'node:fs';

/** An argument the Gleam rule's types can't hold. */
export class CannotHold extends Error {}

const cannot = (what) => {
  throw new CannotHold(what);
};
const only = (value, keys, what) => {
  const extra = Object.keys(value ?? {}).filter((k) => !keys.includes(k));
  if (extra.length) cannot(`${what} has no place for ${extra.join(', ')}`);
};

// -------------------------------------------------------------------------------------------- the lifecycle

const LIFECYCLE = JSON.parse(readFileSync(new URL('../../test/fixtures/lifecycle_matrix.json', import.meta.url)));
const LIFECYCLE_TEST = 'test/scoutbox/recruitment/lifecycle_matrix_test.gleam';

const at = (list, value, what) => {
  const i = list.indexOf(value);
  if (i < 0) cannot(`cannot print ${JSON.stringify(value)} as ${what}`);
  return i;
};

/** The case's status and, as heldFromStatus reads it, the state its newest hold was taken from. */
function lifecycleCase(kase) {
  if (!kase || typeof kase !== 'object') cannot(`cannot print ${JSON.stringify(kase)} as a Room`);
  // The validator reads the status and the history; the rest of a case record is the row's.
  only(kase, ['id', 'orgId', 'playerId', 'createdAt', 'stage', 'room', 'history'], 'a Room');
  only(kase.room, ['status', 'rev', 'priority'], "a Room's room");
  const status = at(LIFECYCLE.statuses, kase.room?.status, 'a RoomStatus');
  const history = kase.history ?? [];
  if (!Array.isArray(history)) cannot(`cannot print ${JSON.stringify(history)} as a history`);
  let from = null;
  for (const e of [...history].reverse()) {
    if (e?.action !== 'room_status_changed' || e.detail?.to !== 'on_hold') continue;
    from = typeof e.detail.from === 'string' ? e.detail.from : null;
    break;
  }
  return { status, held: at(LIFECYCLE.held, from, 'the state a hold was taken from') };
}

const role = (context) => at(LIFECYCLE.roles, context?.role ?? null, 'a RoomRole');
const LACKS = LIFECYCLE.evidence.indexOf('lacks');
const result = (i) => LIFECYCLE.results[i];

function canTransition([kase, action, context = {}]) {
  only(context, ['role', 'reasonCodes', 'forAvailability', 'now'], "the validator's context");
  const { status, held } = lifecycleCase(kase);
  at(LIFECYCLE.actions, action, 'a lifecycle action');
  const { reasonCodes = [], forAvailability = false } = context;
  if (!Array.isArray(reasonCodes)) cannot(`cannot print ${JSON.stringify(reasonCodes)} as reason codes`);
  const mode = LIFECYCLE.modes.indexOf(forAvailability ? 'available' : reasonCodes.length ? 'reasons' : 'none');
  const [S, R, M, E] = [LIFECYCLE.statuses, LIFECYCLE.roles, LIFECYCLE.modes, LIFECYCLE.evidence].map((l) => l.length);
  // Only resumeCase reads the history, so only its table has the held dimension.
  const h = action === 'resumeCase' ? held : 0;
  return result(LIFECYCLE.check[action][(((h * S + status) * R + role(context)) * M + mode) * E + LACKS]);
}

function availableActions([kase, context = {}]) {
  only(context, ['role', 'now'], "availableActions' context");
  const { status, held } = lifecycleCase(kase);
  const [S, R, E] = [LIFECYCLE.statuses, LIFECYCLE.roles, LIFECYCLE.evidence].map((l) => l.length);
  return result(LIFECYCLE.available[((held * S + status) * R + role(context)) * E + LACKS]);
}

// --------------------------------------------------------------------------------------------- the contacts

const CONTACT = JSON.parse(readFileSync(new URL('../../test/fixtures/contact_matrix.json', import.meta.url)));

function canContactAction([contact, action, context = {}]) {
  if (!contact || typeof contact !== 'object') cannot(`cannot print ${JSON.stringify(contact)} as a Contact`);
  // The validator reads only the status; a recorded contact names nothing else.
  only(contact, ['status'], 'a Contact');
  only(context, ['role'], "canContactAction's context");
  at(CONTACT.statuses, contact.status, 'a contact status');
  at(CONTACT.actions, action, 'a contact action');
  at(CONTACT.roles, context.role ?? null, 'a RoomRole');
  return CONTACT.answers[`${contact.status} ${action} ${context.role ?? 'none'}`];
}

export const MATRIX = {
  ['domains/recruitment/lifecycle/contact.mjs#canContactAction']: {
    test: 'test/scoutbox/recruitment/contact_matrix_test.gleam',
    answer: canContactAction,
  },
  ['domains/recruitment/lifecycle/lifecycle.mjs#canTransitionRecruitmentCase']: {
    test: LIFECYCLE_TEST,
    answer: canTransition,
  },
  ['domains/recruitment/lifecycle/lifecycle.mjs#availableActions']: { test: LIFECYCLE_TEST, answer: availableActions },
};
