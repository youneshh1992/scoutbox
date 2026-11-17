// The Contact engine and its read rules behind the contact battery (e2e/recruitment/contacts.mjs), checked in this
// process: the state machine, the actions and roles, content and key rules, the recipient rule, external records and
// the cooldown, the integrity check (group U), and the evidence the case reads and the journey's projection of contacts,
// which carries milestones and never words (group V).
import { visibleToOrg, isAdult } from '../../../domain.ts';
import {
  CONTACT_STATUSES,
  CONTACT_TRANSITIONS,
  CONTACT_ACTIONS,
  CONTACT_ACTION_NAMES,
  CONTACT_CHANNELS,
  CONTACT_LIMITS,
  CONTACT_EVIDENCE_STATUSES,
  canContactAction,
  contactRoleAllows,
  validateContactContent,
  validateContactReply,
  normaliseClientKey,
  resolveContactRecipient,
  validateExternalRecord,
  cooldownFor,
  contactIntegrity,
  contactView,
  contactMilestone,
  plainShared,
} from '../../../domains/recruitment/lifecycle/contact.mjs';
import { canTransitionRecruitmentCase } from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { TABLE_BACKED } from '../../../repositories/index.mjs';
import { roomCan } from '../../../domains/recruitment/rooms/shared.mjs';
import { buildRecruitmentJourney, createEvidenceProvider } from '../../recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/contacts');
const SENTINEL = 'PRIVATE_ROOM_SENTINEL_123';

// ============================================================ U — pure engine
section('U — the Contact state machine is total, closed and null-prototype');
{
  ok(CONTACT_STATUSES.length === 6, 'six Contact states, and none of them is a case status');
  neg(
    CONTACT_STATUSES.every((s) => !['contact_planned', 'contacted', 'watching', 'under_review'].includes(s)),
    'no Contact state is a recruitment lifecycle state — the two machines do not share a word',
  );
  ok(
    CONTACT_STATUSES.every((s) => Array.isArray(CONTACT_TRANSITIONS[s])),
    'every state has a transition row',
  );
  neg(
    CONTACT_TRANSITIONS.responded.length === 0 &&
      CONTACT_TRANSITIONS.recorded.length === 0 &&
      CONTACT_TRANSITIONS.cancelled.length === 0,
    'responded, recorded and cancelled are final — nothing rewrites a finished communication',
  );
  neg(
    !CONTACT_TRANSITIONS.delivered.includes('draft') && !CONTACT_TRANSITIONS.responded.includes('delivered'),
    'a delivered contact cannot become a draft again and a response cannot be un-received',
  );
  neg(
    !CONTACT_STATUSES.includes('queued') && !CONTACT_STATUSES.includes('sent') && !CONTACT_STATUSES.includes('read'),
    'no `queued`, `sent` or `read` state exists — the in-app transport cannot distinguish them, so they are not invented',
  );
  for (const key of ['constructor', 'toString', '__proto__', 'prototype', 'hasOwnProperty']) {
    neg(
      CONTACT_TRANSITIONS[key] === undefined &&
        CONTACT_ACTIONS[key] === undefined &&
        CONTACT_CHANNELS[key] === undefined,
      `"${key}" is absent from the transition, action and channel tables — null prototype`,
    );
    const v = canContactAction({ status: 'draft' }, key, { role: 'recruitment_admin' });
    neg(
      v.ok === false && v.error === 'CONTACT_ACTION_UNKNOWN',
      `action "${key}" is refused as unknown, not treated as a function`,
    );
    const s = canContactAction({ status: key }, 'send', { role: 'recruitment_admin' });
    neg(
      s.ok === false && s.error === 'CONTACT_STATE_UNKNOWN',
      `a stored status of "${key}" is corruption, not a workflow position`,
    );
  }

  // The matrix: every state × action × role answers, in the declared shape.
  const ROLES = ['viewer', 'contributor', 'room_lead', 'recruitment_admin', null, 'admin', ''];
  const CODES = new Set([
    'CONTACT_NOT_PERMITTED',
    'CONTACT_INVALID_STATE',
    'CONTACT_ALREADY_SENT',
    'CONTACT_STATE_UNKNOWN',
  ]);
  let cells = 0;
  let shaped = true;
  let inversions = 0;
  for (const status of CONTACT_STATUSES) {
    for (const action of CONTACT_ACTION_NAMES) {
      const okAt = [];
      for (const role of ROLES) {
        const v = canContactAction({ status }, action, { role });
        cells += 1;
        if (!(v.ok === true || (v.ok === false && CODES.has(v.error)))) shaped = false;
        okAt.push(v.ok);
      }
      // room_lead may do what recruitment_admin may; contributor never more than room_lead.
      if (okAt[1] && !okAt[2]) inversions += 1;
      if (okAt[2] && !okAt[3]) inversions += 1;
      if (okAt[0] && !okAt[1]) inversions += 1;
    }
  }
  ok(
    cells === CONTACT_STATUSES.length * CONTACT_ACTION_NAMES.length * ROLES.length,
    `the matrix is complete: ${cells} state × action × role cells evaluated`,
  );
  neg(shaped, 'every cell returns a verdict in the declared shape with a declared code');
  neg(inversions === 0, 'the role ladder is monotone — no lower role may do what a higher one may not');
  neg(
    !canContactAction({ status: 'draft' }, 'send', { role: 'contributor' }).ok &&
      canContactAction({ status: 'draft' }, 'send', { role: 'contributor' }).error === 'CONTACT_NOT_PERMITTED',
    'a contributor cannot send — an outward act with a person on the other end sits with the room lead',
  );
  neg(!canContactAction({ status: 'draft' }, 'send', { role: 'viewer' }).ok, 'nor can a viewer');
  ok(canContactAction({ status: 'draft' }, 'send', { role: 'room_lead' }).ok, 'a room lead can');
  neg(
    canContactAction({ status: 'delivered' }, 'send', { role: 'room_lead' }).error === 'CONTACT_ALREADY_SENT',
    'sending a delivered contact is refused as ALREADY_SENT — a distinct fact from "not from here"',
  );
  neg(
    canContactAction({ status: 'delivered' }, 'edit', { role: 'room_lead' }).error === 'CONTACT_INVALID_STATE',
    'a delivered message cannot be edited — what the recipient read is what was sent',
  );
  neg(
    canContactAction({ status: 'responded' }, 'cancel', { role: 'recruitment_admin' }).error ===
      'CONTACT_INVALID_STATE',
    'an answered contact cannot be cancelled — cancelling is for things that never left',
  );
  ok(
    canContactAction({ status: 'failed' }, 'send', { role: 'room_lead' }).ok,
    'a failed attempt can be sent again — the draft survives its transport',
  );
  ok(canContactAction({ status: 'delivered' }, 'respond', {}).ok, 'the recipient responds without a club role');
  neg(
    !canContactAction({ status: 'draft' }, 'respond', {}).ok,
    'and cannot respond to a draft, which they can never see',
  );
  ok(
    roomCan('room_lead', 'contact_write') &&
      roomCan('viewer', 'contact_view') &&
      !roomCan('contributor', 'contact_write'),
    "the Rooms' roomCan carries the same two actions, so the Room has one permission table",
  );
  neg(
    !contactRoleAllows('recruitment_admin', 'constructor') && !contactRoleAllows('constructor', 'contact_view'),
    'a prototype key is neither a role nor an action',
  );
}

section('U — content is stored inert; a key is a key');
{
  const xss = validateContactContent({
    subject: '<b>Hi</b>',
    body: '<script>alert(1)</script>Hello <img src=x onerror=alert(1)> javascript:alert(1)',
  });
  ok(xss.ok, 'markup is stripped rather than refused — the words survive, the tags do not');
  neg(!/[<>]/.test(xss.body) && !/[<>]/.test(xss.subject), 'no angle bracket survives into the stored text');
  ok(
    xss.body.includes('javascript:alert(1)'),
    'a URL-shaped word is text; rendering as text is what makes it harmless (moderation refuses real URLs)',
  );
  neg(validateContactContent({ body: '' }).error === 'CONTACT_CONTENT_INVALID', 'an empty message is refused');
  neg(validateContactContent({ body: '   \n ' }).error === 'CONTACT_CONTENT_INVALID', 'so is whitespace');
  neg(validateContactContent({ body: 42 }).error === 'CONTACT_CONTENT_INVALID', 'so is a number');
  neg(
    validateContactContent({ body: { toString: 1 } }).error === 'CONTACT_CONTENT_INVALID',
    'so is an object with a hostile toString',
  );
  neg(
    validateContactContent({ body: 'x'.repeat(CONTACT_LIMITS.body * 4 + 1) }).error === 'CONTACT_CONTENT_TOO_LONG',
    'a body far over the limit is refused by name',
  );
  ok(
    validateContactContent({ body: 'y'.repeat(CONTACT_LIMITS.body + 50) }).body.length === CONTACT_LIMITS.body,
    'a body slightly over is cut to the limit',
  );
  const uni = validateContactContent({ body: 'café \uD800 hello\u0000\u0007 world' });
  ok(
    uni.ok && uni.body === 'café  hello world',
    'Unicode is NFC-normalised, lone surrogates and control characters are dropped',
  );
  ok(JSON.parse(JSON.stringify({ b: uni.body })).b === uni.body, 'and the result round-trips through JSON intact');
  ok(
    plainShared(null, 10) === '' && plainShared(undefined, 10) === '' && plainShared(5, 10) === null,
    'plainShared: absent is empty, non-text is null',
  );
  neg(
    validateContactReply({ toString: 1 }).error === 'CONTACT_RESPONSE_INVALID',
    'a reply that is not text is refused',
  );
  neg(
    validateContactReply('hi', { isContact: false }).error === 'CONTACT_RESPONSE_INVALID',
    'a reply on a non-contact request is refused',
  );
  ok(validateContactReply('  <b>ok</b> ').reply === 'ok', 'a reply is cleaned like every other shared text');
  ok(
    validateContactReply('').reply === null && validateContactReply(undefined).reply === null,
    'no reply is null, not an empty string',
  );
  neg(
    normaliseClientKey(42).error === 'CONTACT_CLIENT_KEY_INVALID' &&
      normaliseClientKey('x'.repeat(65)).error === 'CONTACT_CLIENT_KEY_INVALID',
    'a client key must be short text',
  );
  ok(
    normaliseClientKey(undefined).key === null && normaliseClientKey(' k1 ').key === 'k1',
    'absent is no key; whitespace is trimmed',
  );
}

section('U — the recipient is derived, never trusted, and fails closed');
{
  const org = { id: 'org-A', type: 'club', verified: true, level: 'pro' };
  const agency = { id: 'org-AG', type: 'agency', level: 'agency' };
  const unverified = { id: 'org-U', type: 'club', verified: false, level: 'academy' };
  const noBlock = () => false;
  const adult = { id: 'p-a', dob: '2000-01-01', country: 'GB' };
  const minor = { id: 'p-m', dob: '2012-01-01', country: 'GB', guardianId: 'g1' };
  const g1 = { id: 'g1', childIds: ['p-m'], idVerified: true, disclaimerAccepted: true };
  const deps = { org, guardians: [g1], isAdult, visibleToOrg, isBlocked: noBlock };

  const a = resolveContactRecipient({ ...deps, player: adult });
  ok(a.ok && a.recipient.type === 'player' && a.recipient.guardianId === null, 'an adult is contacted directly');
  const m = resolveContactRecipient({ ...deps, player: minor });
  ok(
    m.ok && m.recipient.type === 'guardian' && m.recipient.guardianId === 'g1' && m.recipient.minor === true,
    'a minor routes to the verified guardian who owns the account',
  );

  neg(
    resolveContactRecipient({ ...deps, player: minor, guardians: [] }).error === 'CONTACT_GUARDIAN_REQUIRED',
    'a minor with no guardian record fails closed — no direct fallback',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, guardians: [{ ...g1, childIds: ['someone-else'] }] }).error ===
      'CONTACT_GUARDIAN_REQUIRED',
    'a guardian that does not list the child is not a route',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, guardians: [{ ...g1, idVerified: false }] }).error ===
      'CONTACT_GUARDIAN_REQUIRED',
    'an unverified guardian is not a route',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, guardians: [{ ...g1, disclaimerAccepted: false }] }).error ===
      'CONTACT_GUARDIAN_REQUIRED',
    'a guardian who has not accepted the disclaimer is not a route',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, guardians: [{ ...g1, childIds: 'p-m' }] }).error ===
      'CONTACT_GUARDIAN_REQUIRED',
    'a malformed guardian record (childIds not a list) is not a route',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, guardians: [{ ...g1, removedAt: 1 }] }).error ===
      'CONTACT_GUARDIAN_REQUIRED',
    'a removed guardian is not a route',
  );
  const dup = resolveContactRecipient({ ...deps, player: minor, guardians: [g1, { ...g1, id: 'g2' }] });
  ok(dup.ok && dup.recipient.guardianId === 'g1', "two records claiming the child: the player's own link decides");
  neg(
    resolveContactRecipient({ ...deps, player: { ...minor, guardianId: 'g9' }, guardians: [g1, { ...g1, id: 'g2' }] })
      .error === 'CONTACT_GUARDIAN_REQUIRED',
    'two records and a link that matches neither is ambiguity, and ambiguity fails closed',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, org: agency }).error === 'CONTACT_RECIPIENT_UNAVAILABLE',
    'an agency can never contact a minor, guardian or not',
  );
  neg(
    resolveContactRecipient({ ...deps, player: minor, org: unverified }).error === 'CONTACT_RECIPIENT_UNAVAILABLE',
    'an unverified club can never contact a minor',
  );
  ok(
    resolveContactRecipient({ ...deps, player: adult, org: agency }).ok,
    'an agency may contact an adult (the wall is about minors)',
  );
  neg(
    resolveContactRecipient({ ...deps, player: adult, isBlocked: () => true }).error === 'CONTACT_BLOCKED',
    'a block refuses, by name',
  );
  neg(
    resolveContactRecipient({ ...deps, player: undefined }).error === 'CONTACT_RECIPIENT_UNAVAILABLE',
    'a missing player is unavailable',
  );
  neg(
    resolveContactRecipient({ ...deps, player: { ...adult, removedAt: 1 } }).error === 'CONTACT_RECIPIENT_UNAVAILABLE',
    'a removed player is unavailable — nothing is fabricated',
  );

  // Country rules — the canonical isAdult, not a second flag.
  const kr18 = { id: 'p-k', dob: '2008-06-01', country: 'KR', guardianId: 'g1' };
  const gk = { ...g1, childIds: ['p-k'] };
  const atKr = resolveContactRecipient({
    ...deps,
    player: kr18,
    guardians: [gk],
    now: new Date('2026-09-16T00:00:00Z'),
  });
  ok(atKr.ok && atKr.recipient.type === 'guardian', 'an 18-year-old in KR (majority 19) still routes to the guardian');
  const gb18 = { ...kr18, country: 'GB' };
  ok(
    resolveContactRecipient({ ...deps, player: gb18, guardians: [gk], now: new Date('2026-09-16T00:00:00Z') }).recipient
      .type === 'player',
    'the same date of birth in GB is an adult',
  );

  // Age moves between compose and send: the clock at SEND decides.
  const turning = { id: 'p-t', dob: '2008-09-20', country: 'GB', guardianId: 'g1' };
  const gt = { ...g1, childIds: ['p-t'] };
  const before = resolveContactRecipient({
    ...deps,
    player: turning,
    guardians: [gt],
    now: new Date('2026-09-16T00:00:00Z'),
  });
  const after = resolveContactRecipient({
    ...deps,
    player: turning,
    guardians: [gt],
    now: new Date('2026-09-21T00:00:00Z'),
  });
  ok(
    before.recipient.type === 'guardian' && after.recipient.type === 'player',
    'a player who turns 18 between draft and send is routed by the age at send',
  );
}

section('U — external records and the cooldown are deterministic');
{
  const NOW = 1_800_000_000_000;
  const okRec = validateExternalRecord(
    { channel: 'phone', occurredAt: NOW - 3600_000, summary: 'spoke', recipientType: 'player' },
    { now: NOW, derivedRecipientType: 'player' },
  );
  ok(okRec.ok && okRec.channel === 'phone', 'a phone call an hour ago records');
  neg(
    validateExternalRecord({ channel: 'in_app', occurredAt: NOW }, { now: NOW, derivedRecipientType: 'player' })
      .error === 'CONTACT_CHANNEL_INVALID',
    'in_app is not an external channel',
  );
  for (const key of ['constructor', '__proto__', 'toString', 'nope']) {
    neg(
      validateExternalRecord({ channel: key, occurredAt: NOW }, { now: NOW, derivedRecipientType: 'player' }).error ===
        'CONTACT_CHANNEL_INVALID',
      `channel "${key}" is refused`,
    );
  }
  neg(
    validateExternalRecord(
      { channel: 'phone', occurredAt: NOW + 3600_000 },
      { now: NOW, derivedRecipientType: 'player' },
    ).error === 'CONTACT_OCCURRED_AT_INVALID',
    'a contact an hour in the future is refused — "planned to call" is not contact',
  );
  ok(
    validateExternalRecord(
      { channel: 'phone', occurredAt: NOW + 5 * 60_000 },
      { now: NOW, derivedRecipientType: 'player' },
    ).ok,
    'five minutes ahead is clock skew and is accepted',
  );
  neg(
    validateExternalRecord(
      { channel: 'phone', occurredAt: NOW - CONTACT_LIMITS.occurredAtMaxAgeMs - 1 },
      { now: NOW, derivedRecipientType: 'player' },
    ).error === 'CONTACT_OCCURRED_AT_INVALID',
    'a contact older than 180 days is refused as evidence',
  );
  neg(
    validateExternalRecord({ channel: 'phone', occurredAt: 'yesterday' }, { now: NOW, derivedRecipientType: 'player' })
      .error === 'CONTACT_OCCURRED_AT_INVALID',
    'a non-date is refused',
  );
  neg(
    validateExternalRecord(
      { channel: 'phone', occurredAt: NOW, recipientType: 'player' },
      { now: NOW, derivedRecipientType: 'guardian' },
    ).error === 'CONTACT_RECIPIENT_MISMATCH',
    'recording direct contact with a minor is refused, not corrected',
  );
  neg(
    validateExternalRecord(
      { channel: 'phone', occurredAt: NOW, recipientType: '__proto__' },
      { now: NOW, derivedRecipientType: 'player' },
    ).error === 'CONTACT_RECIPIENT_MISMATCH',
    'a prototype key is not a recipient type',
  );
  neg(
    validateExternalRecord(
      { channel: 'phone', occurredAt: NOW, summary: ['x'] },
      { now: NOW, derivedRecipientType: 'player' },
    ).error === 'CONTACT_CONTENT_INVALID',
    'a non-text summary is refused',
  );

  const c1 = {
    id: 'c1',
    orgId: 'o',
    playerId: 'p',
    channel: 'in_app',
    status: 'delivered',
    deliveredAt: NOW - 3600_000,
  };
  ok(
    cooldownFor([c1], { orgId: 'o', playerId: 'p', now: NOW })?.retryAt === c1.deliveredAt + CONTACT_LIMITS.cooldownMs,
    'a delivered, unanswered contact an hour old blocks a second one until the window ends',
  );
  ok(
    cooldownFor([{ ...c1, status: 'responded' }], { orgId: 'o', playerId: 'p', now: NOW }) === null,
    'an answered contact does not block',
  );
  ok(
    cooldownFor([{ ...c1, status: 'failed' }], { orgId: 'o', playerId: 'p', now: NOW }) === null,
    'a failed attempt does not block a retry',
  );
  ok(
    cooldownFor([{ ...c1, playerId: 'q' }], { orgId: 'o', playerId: 'p', now: NOW }) === null,
    "another player's contact does not block",
  );
  ok(
    cooldownFor([{ ...c1, orgId: 'o2' }], { orgId: 'o', playerId: 'p', now: NOW }) === null,
    "another organisation's contact does not block",
  );
  ok(
    cooldownFor([{ ...c1, deliveredAt: NOW - CONTACT_LIMITS.cooldownMs }], { orgId: 'o', playerId: 'p', now: NOW }) ===
      null,
    'and the window ends exactly when it says',
  );
  ok(
    JSON.stringify(cooldownFor([c1], { orgId: 'o', playerId: 'p', now: NOW })) ===
      JSON.stringify(cooldownFor([c1], { orgId: 'o', playerId: 'p', now: NOW })),
    'the answer is deterministic for a fixed clock',
  );
}

section('U — corruption is named, never repaired');
{
  const good = {
    id: 'c',
    orgId: 'o',
    caseId: 'k',
    playerId: 'p',
    status: 'delivered',
    channel: 'in_app',
    recipient: { type: 'player' },
    deliveredAt: 5,
    history: [],
  };
  ok(contactIntegrity(good).length === 0, 'a sound record has no problems');
  neg(contactIntegrity({ ...good, status: 'sent' }).includes('status_unknown'), 'an unknown status is reported');
  neg(
    contactIntegrity({ ...good, recipient: null }).includes('recipient_missing'),
    'a delivered contact with no recipient is reported',
  );
  neg(
    contactIntegrity({ ...good, channel: 'constructor' }).includes('channel_unknown'),
    'a prototype-key channel is reported',
  );
  neg(
    contactIntegrity(good, { orgId: 'other' }).includes('org_mismatch'),
    'a record in the wrong organisation is reported',
  );
  neg(contactIntegrity(good, { caseId: 'other' }).includes('case_mismatch'), 'and in the wrong case');
  neg(
    contactIntegrity({ ...good, history: 'nope' }).includes('history_malformed'),
    'a history that is not a list is reported',
  );
  neg(
    contactIntegrity({ ...good, deliveredAt: 'yesterday' }).includes('timestamp_malformed'),
    'a malformed delivery timestamp is reported',
  );
  neg(
    contactIntegrity({ ...good, status: 'recorded', occurredAt: null }).includes('timestamp_malformed'),
    'a recorded contact with no occurrence time is reported',
  );
  neg(contactIntegrity(null).includes('not_an_object'), 'null is not a contact');
  const view = contactView({ ...good, keys: { create: { key: 'SECRETKEY', fp: 'x' } }, body: 'b' });
  neg(!JSON.stringify(view).includes('SECRETKEY'), 'the club view carries no idempotency key');
}

// ============================================== V — evidence and the journey (pure)
section('V — a draft is not evidence; the journey carries milestones, never words');
{
  const kase = { id: 'k1', orgId: 'o1', playerId: 'p1', room: { status: 'contact_planned', rev: 1 }, history: [] };
  const mk = (over) => ({
    id: 'c-' + Math.random().toString(36).slice(2, 6),
    orgId: 'o1',
    caseId: 'k1',
    playerId: 'p1',
    channel: 'in_app',
    status: 'draft',
    history: [],
    body: `${SENTINEL} draft body`,
    ...over,
  });
  const check = (contacts) =>
    createEvidenceProvider({ signings: [], recruitmentContacts: contacts }).check('contact_delivered', { kase });
  neg(
    check([mk()]).satisfied === false && check([mk()]).reason === 'no_contact_delivered',
    'a draft satisfies nothing',
  );
  neg(check([mk({ status: 'failed', failedAt: 1 })]).satisfied === false, 'a failed attempt satisfies nothing');
  neg(check([mk({ status: 'cancelled' })]).satisfied === false, 'a cancelled draft satisfies nothing');
  neg(
    check([mk({ status: 'delivered', recipient: { type: 'player' }, deliveredAt: 1, cancelledAt: 2 })]).satisfied ===
      false,
    'a delivered contact later marked cancelled satisfies nothing',
  );
  neg(
    check([mk({ status: 'delivered', recipient: { type: 'player' }, deliveredAt: 1, orgId: 'o2' })]).satisfied ===
      false,
    "another organisation's delivered contact proves nothing about this case",
  );
  neg(
    check([mk({ status: 'delivered', recipient: { type: 'player' }, deliveredAt: 1, playerId: 'p2' })]).satisfied ===
      false,
    'nor does a contact with another player',
  );
  neg(
    check([mk({ status: 'delivered', recipient: null, deliveredAt: 1 })]).satisfied === false,
    'a corrupt delivered record (no recipient) is not evidence',
  );
  const yes = check([mk({ status: 'delivered', recipient: { type: 'player' }, deliveredAt: 1 })]);
  ok(
    yes.satisfied === true && yes.sourceType === 'recruitment_contact',
    'a delivered in-app contact satisfies contact_delivered and names its source',
  );
  ok(
    check([mk({ status: 'recorded', channel: 'phone', recipient: { type: 'player' }, occurredAt: 1 })]).satisfied ===
      true,
    'a recorded external contact is the same class of fact',
  );
  ok(
    check([mk({ status: 'responded', recipient: { type: 'player' }, deliveredAt: 1 })]).satisfied === true,
    'an answered contact still counts — it was delivered',
  );
  neg(
    createEvidenceProvider({ signings: [] }).check('contact_delivered', { kase }).reason ===
      'contacts_store_unavailable',
    'a missing store is a broken database, never "no contact"',
  );
  ok(CONTACT_EVIDENCE_STATUSES.length === 3, 'exactly three states are evidence');

  const v = canTransitionRecruitmentCase(kase, 'recordContact', {
    role: 'room_lead',
    evidence: createEvidenceProvider({ signings: [], recruitmentContacts: [mk()] }),
  });
  neg(
    v.ok === false && v.error === 'LIFECYCLE_EVIDENCE_REQUIRED' && v.evidenceReason === 'no_contact_delivered',
    'the lifecycle refuses `contacted` on a draft, and says why',
  );
  const v2 = canTransitionRecruitmentCase(kase, 'recordContact', {
    role: 'room_lead',
    evidence: createEvidenceProvider({
      signings: [],
      recruitmentContacts: [mk({ status: 'delivered', recipient: { type: 'player' }, deliveredAt: 1 })],
    }),
  });
  ok(v2.ok === true && v2.to === 'contacted', 'and permits it once a contact was delivered');

  // Journey.
  // The contacts are read through SQL.
  const noContacts = buildRecruitmentJourney(
    { recruitmentCases: [], roomDecisions: [], requests: [], trials: [], assessments: [], signings: [] },
    'k',
    { kind: 'org_staff', orgId: 'o1' },
  );
  ok(
    noContacts.ok === false &&
      noContacts.error === 'JOURNEY_STORE_MISSING' &&
      noContacts.missing.includes('recruitmentContacts'),
    'the journey requires the contacts: without their queries it reports the store missing',
  );
  ok(TABLE_BACKED.includes('recruitmentContacts'), 'and they are a table since 0017, read through SQL');
  const db = {
    recruitmentCases: [
      {
        ...kase,
        room: { status: 'contacted', rev: 2 },
        history: [
          {
            action: 'room_status_changed',
            at: 10,
            by: { name: 'A' },
            detail: { from: 'contact_planned', to: 'contacted' },
          },
        ],
      },
    ],
    roomDecisions: [],
    requests: [
      {
        id: 'r1',
        orgId: 'o1',
        playerId: 'p1',
        type: 'contact',
        status: 'accepted',
        routedTo: 'player',
        createdAt: 10,
        contactId: 'cA',
        message: `${SENTINEL} shared body`,
      },
    ],
    trials: [],
    assessments: [],
    signings: [],
    recruitmentContacts: [
      mk({
        id: 'cA',
        status: 'responded',
        recipient: { type: 'player' },
        deliveredAt: 10,
        respondedAt: 20,
        response: { kind: 'accepted', message: `${SENTINEL} reply`, by: 'player', at: 20 },
        summary: null,
      }),
      mk({ id: 'cB', status: 'draft' }),
      mk({
        id: 'cC',
        status: 'recorded',
        channel: 'phone',
        recipient: { type: 'player' },
        occurredAt: 5,
        recordedAt: 6,
        summary: `${SENTINEL} summary`,
      }),
      mk({ id: 'cX', status: 'delivered', recipient: null, deliveredAt: 3 }),
      mk({ id: 'cO', orgId: 'o2', status: 'delivered', recipient: { type: 'player' }, deliveredAt: 3 }),
    ],
  };
  const V = { kind: 'org_staff', orgId: 'o1', role: 'room_lead' };
  const jr = buildRecruitmentJourney(db, 'k1', V, { now: 100 });
  ok(
    jr.ok && jr.contact.contacts.length === 3,
    "the club journey lists this case's three sound contacts (draft, responded, recorded)",
  );
  neg(jr.contact.omitted === 1, 'the corrupt one is omitted and counted, not rendered');
  neg(!JSON.stringify(jr).includes('cO'), "another organisation's contact does not appear");
  neg(!JSON.stringify(jr).includes(SENTINEL), 'no body, summary or reply appears anywhere in the club journey');
  const kinds = jr.history.entries.map((e) => e.kind);
  ok(
    kinds.includes('contact_initiated') && kinds.includes('contact_response_received'),
    'the timeline carries the two milestones',
  );
  neg(!kinds.includes('contact_created'), 'a draft is not a milestone — it never happened to the player');
  ok(
    jr.history.entries.filter((e) => e.kind === 'contact_initiated').length === 2,
    'both the delivered and the recorded contact are initiations',
  );
  const twice = buildRecruitmentJourney(db, 'k1', V, { now: 100 });
  ok(JSON.stringify(jr) === JSON.stringify(twice), 'deterministic for the same database and clock');
  // Same millisecond, stable.
  const same = {
    ...db,
    recruitmentContacts: [
      mk({ id: 'c9', status: 'delivered', recipient: { type: 'player' }, deliveredAt: 10 }),
      mk({ id: 'c8', status: 'delivered', recipient: { type: 'player' }, deliveredAt: 10 }),
    ],
  };
  const s1 = buildRecruitmentJourney(same, 'k1', V, { now: 100 })
    .history.entries.map((e) => e.contactId ?? e.kind)
    .join(',');
  const s2 = buildRecruitmentJourney(
    { ...same, recruitmentContacts: [...same.recruitmentContacts].reverse() },
    'k1',
    V,
    { now: 100 },
  )
    .history.entries.map((e) => e.contactId ?? e.kind)
    .join(',');
  ok(s1 === s2, 'two contacts initiated in the same millisecond order identically whatever their storage order');
  // The player's view.
  const pv = buildRecruitmentJourney(db, 'k1', { kind: 'player_self', playerId: 'p1' }, { now: 100 });
  ok(pv.ok && pv.shared.length === 1 && pv.shared[0].id === 'r1', 'the player sees the request that was sent to them');
  neg(
    !('case' in pv) && !JSON.stringify(pv).includes('cB') && !JSON.stringify(pv).includes('cA'),
    'and no case id, no draft and no Contact id',
  );
  const nothing = buildRecruitmentJourney(
    { ...db, requests: [] },
    'k1',
    { kind: 'player_self', playerId: 'p1' },
    { now: 100 },
  );
  const ghost = buildRecruitmentJourney(db, 'k-none', { kind: 'player_self', playerId: 'p1' }, { now: 100 });
  neg(
    JSON.stringify(nothing) === JSON.stringify(ghost),
    "with drafts only, the player's answer is byte-identical to a case that never existed",
  );
  neg(!JSON.stringify(contactMilestone(db.recruitmentContacts[0])).includes(SENTINEL), 'a milestone carries no text');
  neg(
    !JSON.stringify(buildRecruitmentJourney(db, 'k1', { kind: 'guardian', guardianId: 'g9' }, { now: 100 })).includes(
      SENTINEL,
    ),
    'a guardian with no share gets nothing',
  );
}

done();
