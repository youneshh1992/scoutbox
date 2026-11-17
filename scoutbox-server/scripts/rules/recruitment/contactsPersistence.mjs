// The contact rules behind the contact persistence battery (e2e/recruitment/contactsPersistence.mjs), checked in this
// process over the battery's own contact records: the journey requires the contacts' queries, the integrity check
// names every defect the battery plants or the schema refuses (and passes the ones that are only a case's business),
// and a corrupt "delivered" contact is never evidence of contact.
import { contactIntegrity } from '../../../domains/recruitment/lifecycle/contact.mjs';
import { buildRecruitmentJourney, createEvidenceProvider } from '../../recruitmentReadsFixture.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/contactsPersistence');

const OWNER = { kind: 'org', userId: 'usr-owner', name: 'Owner' };
const KASE = {
  id: 'case-x',
  orgId: 'org-x',
  playerId: 'pl-x',
  playerName: 'Xavier Adult',
  ownerUserId: 'usr-owner',
  ownerName: 'Owner',
  stage: 'review',
  links: { requestIds: [], trialIds: [], signingId: null },
  room: { status: 'contact_planned', rev: 2, revAt: 1000, revBy: null, updatedAt: 1000 },
  createdAt: 1000,
  history: [],
};

const soundContact = (over = {}) => ({
  id: 'rct-1',
  orgId: 'org-x',
  caseId: 'case-x',
  playerId: 'pl-x',
  status: 'delivered',
  channel: 'in_app',
  recipient: { type: 'player', playerId: 'pl-x', guardianId: null, minor: false },
  contactMode: 'player_only',
  routingSnapshot: null,
  subject: 'Hello',
  body: 'Hi Xavier.',
  summary: null,
  createdBy: OWNER,
  createdAt: 2000,
  updatedAt: 2001,
  sentBy: OWNER,
  sentAt: 2001,
  deliveredAt: 2001,
  failedAt: null,
  failureCode: null,
  attempts: [{ at: 2001, ok: true, code: null }],
  requestId: 'req-1',
  emailCopy: null,
  lifecycle: null,
  occurredAt: null,
  recordedBy: null,
  recordedAt: null,
  respondedAt: null,
  response: null,
  cancelledAt: null,
  cancelledBy: null,
  keys: {
    create: { key: 'ck-1', fp: '{"body":"Hi Xavier.","subject":"Hello"}' },
    send: { key: 'sk-1', fp: '{"contactId":"rct-1"}' },
    record: null,
  },
  history: [
    { id: 'aud-10', at: 2000, action: 'contact_created', by: OWNER, detail: { channel: 'in_app' } },
    {
      id: 'aud-11',
      at: 2001,
      action: 'contact_sent',
      by: OWNER,
      detail: { channel: 'in_app', recipientType: 'player', attempt: 1 },
    },
  ],
  rev: 2,
  revAt: 2001,
  revBy: { userId: 'usr-owner', name: 'Owner' },
  policyVersion: 1,
  ...over,
});
const HERE = { orgId: 'org-x', caseId: 'case-x' };

section('the journey requires the contacts');
{
  const noContacts = buildRecruitmentJourney(
    { recruitmentCases: [], roomDecisions: [], requests: [], trials: [], assessments: [], signings: [] },
    'k',
    { kind: 'org_staff', orgId: 'o1' },
  );
  ok(
    noContacts.ok === false &&
      noContacts.error === 'JOURNEY_STORE_MISSING' &&
      noContacts.missing.includes('recruitmentContacts'),
    'the journey still requires the contacts: without their queries it reports the store missing',
  );
}

section('the integrity check names each defect');
{
  const unstorable = [
    soundContact({ id: 'rct-badstatus', status: 'sent' }),
    soundContact({ id: 'rct-nohist', history: 'not-a-list' }),
    soundContact({ id: 'rct-badts', deliveredAt: 'yesterday' }),
    soundContact({ id: 'rct-badchan', channel: 'constructor' }),
  ];
  ok(
    unstorable.every((c) => contactIntegrity(c, HERE).length > 0),
    'the integrity check still names a problem on each of the four unstorable rows',
  );
  const corrupt = [
    soundContact({ id: 'rct-norecip', recipient: null }), // delivered with no recipient
    soundContact({ id: 'rct-impossible', status: 'responded', deliveredAt: null, respondedAt: 5 }), // answered, never delivered
  ];
  const named = corrupt.map((c) => [c.id, contactIntegrity(c, HERE)]);
  ok(
    named.every(([, p]) => p.length > 0),
    `the integrity check names a problem on every one of the ${named.length} corrupt rows`,
  );
  neg(
    contactIntegrity(soundContact({ id: 'rct-wrongplayer', playerId: 'pl-other' }), HERE).length === 0,
    'a row whose player disagrees with its case is structurally sound — the case check, not the shape check, is where that is caught',
  );
  const unknownEvent = soundContact({
    id: 'rct-unknownevent',
    status: 'draft',
    recipient: null,
    sentBy: null,
    sentAt: null,
    deliveredAt: null,
    attempts: [],
    requestId: null,
    keys: { create: null, send: null, record: null },
    history: [{ id: 'aud-99', at: 1, action: '__teleported__', by: null, detail: null }],
    rev: 1,
  });
  ok(
    contactIntegrity(unknownEvent).length === 0,
    'a sound draft with an unknown history event is not corrupt — the event is simply not a milestone',
  );

  section('a corrupt "delivered" contact is not evidence of contact');
  const ev = createEvidenceProvider({ signings: [], recruitmentContacts: corrupt }).check('contact_delivered', {
    kase: KASE,
  });
  neg(
    ev.satisfied === false && ev.reason === 'no_contact_delivered',
    'the corrupt "delivered" rows are NOT evidence of contact',
  );
  const ev2 = createEvidenceProvider({ signings: [], recruitmentContacts: [soundContact(), ...corrupt] }).check(
    'contact_delivered',
    { kase: KASE },
  );
  ok(ev2.satisfied === true && ev2.sourceId === 'rct-1', 'the sound row beside them is');
}

done();
