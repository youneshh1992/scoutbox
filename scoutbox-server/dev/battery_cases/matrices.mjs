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

// ------------------------------------------------------------------------------------------- the next action

const NEXT = JSON.parse(readFileSync(new URL('../../test/fixtures/next_action_matrix.json', import.meta.url)));
const NEXT_TEST = 'test/scoutbox/recruitment/next_action_matrix_test.gleam';
const LIVE_SIGNING = ['DRAFT', 'READY', 'IN_PROGRESS'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const valueAt = (dim, value, what) => {
  const i = NEXT.values[dim].findIndex((v) => same(v, value));
  if (i < 0) cannot(`cannot print ${JSON.stringify(value)} as ${what}`);
  return i;
};
/** The id a record has, which the fixture's own id stands for in the answer. */
const idOf = (record, what) => {
  if (typeof record?.id !== 'string') cannot(`${what} without an id`);
  return record.id;
};

// What the projector hands nextActionFor besides the facts: the player's standing, which the journey shows
// elsewhere. The Gleam facts have no place for any of it, so it can't change the answer.
const NEXT_IGNORED = ['trustScore', 'trust', 'matchScore', 'match', 'player', 'onWatchlist', 'watchlists', 'boxCam', 'cv', 'combine'];

/**
 * A call's row: each record reduced to its class as the rule reads it (the package's effective status as
 * signing.mjs#effectiveStatus reads it, its current revision's parties), and the facts the status doesn't read
 * left at none, which the fixture's sweeps show changes nothing. The fixture's ids are then replaced by the call's.
 */
function nextActionFor([p]) {
  only(p, ['status', 'role', 'now', 'blocked', 'subjectRemoved', 'assessed', 'decision', 'contact', 'trial', 'trialRequest', 'offer', 'signing', 'signingRow', ...NEXT_IGNORED], "nextActionFor's facts");
  const status = at(NEXT.statuses, p.status, 'a RoomStatus');
  const role = at(NEXT.roles, p.role ?? null, 'a RoomRole');
  if (typeof p.now !== 'number') cannot('nextActionFor without a clock');
  const now = p.now;
  const ids = {};
  const fact = {
    assessed: () => valueAt('assessed', !!p.assessed, 'assessed'),
    decision: () => {
      if (!p.decision) return 0;
      ids['rdc-m'] = idOf(p.decision, 'a decision');
      return 1;
    },
    contact: () => {
      if (!p.contact) return 0;
      ids['rct-m'] = idOf(p.contact, 'a contact');
      return valueAt('contact', p.contact.status, 'a contact status');
    },
    trial: () => {
      if (!p.trial) return 0;
      ids['trl-m'] = idOf(p.trial, 'a trial');
      const sessions = p.trial.schedule?.sessions ?? [];
      const last = sessions.reduce((m, x) => Math.max(m, Number(x?.endsAt) || 0), 0);
      return valueAt('trial', last === 0 ? 'no_sessions' : last < now ? 'ended' : last === now ? 'ends_now' : 'later', 'a trial');
    },
    request: () => {
      if (!p.trialRequest) return 0;
      ids['rrq-m'] = idOf(p.trialRequest, 'a trial request');
      return 1;
    },
    offer: () => {
      if (!p.offer) return 0;
      ids['rof-m'] = idOf(p.offer.offer, 'an Offer');
      if (p.offer.revision) ids['rrev-m'] = idOf(p.offer.revision, 'a revision');
      return valueAt('offer', [p.offer.status ?? null, p.offer.liveStatus ?? null, !!p.offer.revision], 'an Offer');
    },
    signing: () => {
      const s = p.signing;
      if (!s) return 0;
      ids['spk-m'] = idOf(s, 'a signing package');
      const exp = s.expiresAt;
      const effective = LIVE_SIGNING.includes(s.status) && Number.isFinite(exp) && now >= exp ? 'EXPIRED' : s.status;
      const rev = (s.revisions ?? []).find((r) => r?.id === s.currentRevisionId);
      const parties = Array.isArray(rev?.requiredParties) ? rev.requiredParties : [];
      const pending = (club) => parties.some((x) => (x?.partyType === 'CLUB_SIGNATORY') === club && x.status === 'PENDING');
      const done = s.completion?.signingId ?? null;
      if (done !== null) ids['sg-m'] = done;
      return valueAt('signing', [effective, pending(true), pending(false), done !== null], 'a signing package');
    },
    signingRow: () => {
      if (!p.signingRow) return 0;
      ids['sg-row-m'] = idOf(p.signingRow, 'a signing row');
      return 1;
    },
  };
  const reads = NEXT.reads[p.status];
  const row = NEXT.dims.map((d) => (reads.includes(d) ? fact[d]() : 0));
  const found = NEXT.pick.find((r) => r[0] === status && same(r.slice(1, -1), row));
  if (!found) throw new Error(`next_action_matrix has no row for ${p.status} ${row}`);
  const { code, resources } = JSON.parse(NEXT.results[found.at(-1)]);
  const codeAt = NEXT.codes.indexOf(code);
  const fin = NEXT.finish.find((r) => same(r.slice(0, 5), [codeAt, role, +!!p.blocked, +!!p.subjectRemoved, 0]));
  const envelope = JSON.parse(NEXT.finishResults[fin.at(-1)]);
  envelope.resources = Object.fromEntries(Object.entries(resources).map(([k, v]) => [k, v === null ? null : (ids[v] ?? cannot(`no record stands for ${v}`))]));
  return JSON.stringify(envelope);
}


// ------------------------------------------------------------------------------------------ the transactions

const TXM = JSON.parse(readFileSync(new URL('../../test/fixtures/transaction_matrix.json', import.meta.url)));
const TXM_TEST = 'test/scoutbox/agents/transaction_matrix_test.gleam';

function transition(which) {
  return (args) => {
    if (!Array.isArray(args)) cannot(`cannot print ${JSON.stringify(args)} as a status and a status`);
    const [from, to] = args;
    at(TXM.statuses, from, 'a TransactionStatus');
    at(TXM.statuses, to, 'a TransactionStatus');
    return JSON.stringify(TXM.transitions[`${from} ${to}`][which]);
  };
}

/** A role set's key, as the fixture writes it: its roles in the fixture's order. */
function rolesKey(roles, side) {
  if (!Array.isArray(roles)) cannot(`cannot print ${JSON.stringify(roles)} as a List`);
  for (const r of roles) at(TXM.roles, r, 'a RoomRole');
  at(TXM.sides, side ?? null, 'a PartyRole');
  const set = TXM.roles.filter((r) => roles.includes(r));
  return `${set.length ? set.join('+') : '-'} ${side ?? 'none'}`;
}

function canSee([visibility, roles, side = null]) {
  const i = at(TXM.visibilities, visibility, 'a DocumentVisibility');
  return JSON.stringify(TXM.canSee[rolesKey(roles, side)][i] === '1');
}

function uploadable([roles, side = null]) {
  return JSON.stringify(TXM.uploadable[rolesKey(roles, side)]);
}

function timelineVisible([audience, roles, side = null, detail = null]) {
  at(TXM.audiences, audience, 'an Audience');
  // The Gleam rule reads the entry's class column, which holds a class or nothing.
  const v = typeof detail?.visibility === 'string' ? detail.visibility : null;
  const i = v === null ? 0 : at(TXM.visibilities, v, 'a DocumentVisibility') + 1;
  return JSON.stringify(TXM.timeline[`${audience} ${rolesKey(roles, side)}`][i] === '1');
}

const TX_FN = 'domains/agents/transactions/transaction.mjs';

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
  ['domains/recruitment/lifecycle/journeyModel.mjs#nextActionFor']: { test: NEXT_TEST, answer: nextActionFor },
  [`${TX_FN}#actorTransitionAllowed`]: { test: TXM_TEST, answer: transition(0) },
  [`${TX_FN}#complianceTransitionAllowed`]: { test: TXM_TEST, answer: transition(1) },
  [`${TX_FN}#canSeeVisibility`]: { test: TXM_TEST, answer: canSee },
  [`${TX_FN}#uploadableVisibilities`]: { test: TXM_TEST, answer: uploadable },
  [`${TX_FN}#timelineVisible`]: { test: TXM_TEST, answer: timelineVisible },
};
