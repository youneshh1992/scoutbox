// The Offer rules behind the adversarial Offer battery (e2e/recruitment/offersAdversarial.mjs), checked in this
// process: the expiry boundary and temporal corruption failing closed, the minor pathway and the adult boundary, the
// event registry, the budgets (with H1's closure budgets), the error table and text hygiene.
import {
  OFFER_LIMITS,
  validateTerms,
  validateMessages,
  validateExpiry,
  effectiveRevisionStatus,
  offerStatus,
  liveStatus,
  liveRevision,
  canRespondToRevision,
  offerIntegrity,
  offerCaseConsistency,
  offerCaseCorrupt,
  offerEvidence,
  offerRecipientView,
  offerAgentView,
  offerClubView,
  minorOfferPathwayOpen,
  MINOR_OFFER_PATHWAY_ENABLED,
  responderMatches,
} from '../../../domains/recruitment/offers/offer.mjs';
import { OFFER_ERROR_HTTP } from '../../../domains/recruitment/offers/errors.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { isAdult, adultAgeFor } from '../../../domain.ts';
import { isExpiredAt } from '../../../temporal.ts';
import { canTransitionRecruitmentCase } from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { createEvidenceProvider } from '../../recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/offersAdversarial');

const H = 3_600_000;
const DAY = 24 * H;

section('E/R — pure: expiry boundary, unknown status, temporal corruption fail closed');
{
  const T = 1_800_000_000_000;
  const rev = (over = {}) => ({
    id: 'r1',
    revisionNumber: 1,
    status: 'ISSUED',
    createdAt: T - H,
    issuedAt: T,
    expiresAt: T + DAY,
    recipientSnapshot: { type: 'player', playerId: 'p1', guardianId: null },
    ...over,
  });
  const offer = (r, extra = {}) => ({
    id: 'o1',
    orgId: 'org-A',
    caseId: 'c1',
    playerId: 'p1',
    type: 'direct_recruitment',
    revisions: [r],
    currentRevisionId: r.id,
    responses: [],
    ...extra,
  });
  ok(effectiveRevisionStatus(rev(), T + DAY - 1) === 'ISSUED', 'E-p1 1 ms before expiry: ISSUED');
  neg(
    effectiveRevisionStatus(rev(), T + DAY) === 'EXPIRED' && isExpiredAt(T + DAY, T + DAY) === true,
    'E-p2 exact expiry: EXPIRED (now >= expiresAt is not acceptable — the ONE helper decides)',
  );
  neg(effectiveRevisionStatus(rev(), T + DAY + 1) === 'EXPIRED', 'E-p3 1 ms after: EXPIRED');
  neg(
    canRespondToRevision(offer(rev()), 'r1', T + DAY).error === 'OFFER_EXPIRED' &&
      canRespondToRevision(offer(rev()), 'r1', T + DAY - 1).ok === true,
    'E-p4 the answer gate follows the same boundary',
  );
  for (const bad of ['VIEWED', 'signed', 'Issued', 'ISSUED ', '', null, undefined, 1, {}])
    neg(
      effectiveRevisionStatus(rev({ status: bad }), T) === null &&
        liveStatus(offer(rev({ status: bad, issuedAt: T })), T) === null &&
        canRespondToRevision(offer(rev({ status: bad })), 'r1', T).ok !== true,
      `R-p1 unknown status ${JSON.stringify(bad)} is not ISSUED, not live, not answerable (fails closed)`,
    );
  for (const bad of [null, undefined, false, 0, 'soon', '2026-02-30T00:00:00Z', '1e12', NaN, Infinity, -1])
    neg(
      effectiveRevisionStatus(rev({ expiresAt: bad }), T) === 'EXPIRED',
      `R-p2 expiresAt ${JSON.stringify(bad)} on an ISSUED revision reads EXPIRED`,
    );
  neg(
    offerIntegrity(offer(rev({ issuedAt: T - 2 * H }))).includes('issued_before_created'),
    'R-p3 issued before drafted is corruption',
  );
  neg(
    offerIntegrity(
      offer(rev({ status: 'ACCEPTED', respondedAt: T - 1 }), {
        responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player' }],
      }),
    ).includes('responded_before_issued'),
    'R-p4 answered before issued is corruption',
  );
  neg(
    offerIntegrity(offer(rev({ status: 'WITHDRAWN', withdrawnAt: T - 2 * H }))).includes('withdrawn_before_created'),
    'R-p5 withdrawn before drafted is corruption',
  );
  neg(
    offerIntegrity(offer(rev({ expiresAt: T + 400 * DAY }))).includes('expiry_out_of_bounds'),
    'R-p6 an expiry beyond the 180-day rule (a corrupt or imported "forever" row) is corruption, not a fresh Offer',
  );
  neg(
    offerIntegrity(offer(rev({ expiresAt: T - 1 }))).includes('expired_before_issued'),
    'R-p7 expired before issued is corruption',
  );
  neg(
    offerIntegrity(offer(rev({ revisionNumber: 0 }))).includes('revision_number') &&
      offerIntegrity(offer(rev({ revisionNumber: -3 }))).includes('revision_number') &&
      offerIntegrity(offer(rev({ revisionNumber: 1e9 })), {}).length === 0,
    'R-p8 zero and negative revision numbers are corruption; a large one is merely large (server-derived, never client-chosen)',
  );
  neg(
    offerIntegrity({ ...offer(rev()), currentRevisionId: 7 }).includes('current_revision') &&
      offerIntegrity({ ...offer(rev()), currentRevisionId: 'rofr-other' }).includes('current_revision'),
    'R-p9 a forged or dangling current-revision pointer is corruption',
  );
  const kase = (st) => ({ id: 'c1', orgId: 'org-A', playerId: 'p1', room: { status: st } });
  neg(
    offerCaseCorrupt(
      offerCaseConsistency(
        offer(rev({ status: 'ACCEPTED' }), {
          responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }],
        }),
        kase('offer_declined'),
        T,
      ),
    ),
    'P-p1 ACCEPTED Offer + case offer_declined is corruption',
  );
  neg(
    offerCaseCorrupt(
      offerCaseConsistency(
        offer(rev({ status: 'DECLINED' }), {
          responses: [{ revisionId: 'r1', responseType: 'declined', actorType: 'player', actorId: 'p1' }],
        }),
        kase('offer_accepted'),
        T,
      ),
    ),
    'P-p2 DECLINED Offer + case offer_accepted is corruption',
  );
  ok(
    offerCaseConsistency(offer(rev()), kase('on_hold'), T).join() === 'LIVE_OFFER_CASE_NOT_AT_OFFER_MADE' &&
      !offerCaseCorrupt(offerCaseConsistency(offer(rev()), kase('on_hold'), T)),
    'P-p3 an issued Offer on a paused case is a WARNING, not corruption',
  );
  ok(
    offerCaseConsistency(offer(rev()), kase('offer_made'), T).length === 0 &&
      offerCaseConsistency(
        offer(rev({ status: 'ACCEPTED' }), {
          responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }],
        }),
        kase('signed'),
        T,
      ).length === 0,
    'P-p4 the ordinary readings are consistent, including an accepted Offer on a case that later moved on',
  );
  ok(
    offerRecipientView(offer(rev()), T, { caseOpen: false }).answerable === false &&
      offerRecipientView(offer(rev()), T, { caseOpen: false }).notAnswerableReason === 'CASE_PAUSED' &&
      offerRecipientView(offer(rev()), T).answerable === true,
    'P-p5 the recipient view says "not answerable right now" when the case is paused, instead of inviting a 409',
  );
  // Evidence over corrupt rows.
  const db = {
    recruitmentOffers: [
      offer(rev({ status: 'ACCEPTED', respondedAt: T - 1 }), {
        responses: [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }],
      }),
    ],
  };
  neg(
    offerEvidence(db.recruitmentOffers, { id: 'c1', orgId: 'org-A', playerId: 'p1' }, 'offer_accepted_by_recipient', T)
      .satisfied === false,
    'R-p10 a temporally corrupt ACCEPTED row is not acceptance evidence',
  );
  neg(
    canTransitionRecruitmentCase(
      { id: 'c1', orgId: 'org-A', playerId: 'p1', room: { status: 'offer_made' }, history: [] },
      'recordOfferAccepted',
      { role: 'recruitment_admin', evidence: createEvidenceProvider(db), now: T },
    ).error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'R-p11 and the lifecycle cannot move on it',
  );
}

section('S — pure: minor fail-closed in every jurisdiction; adult boundary GB 18 / KR 19 with a fixed clock');
{
  for (const jur of ['GB', 'ENG', 'INT', 'USA', 'FR', 'KR', 'DEFAULT', '', undefined, null, '__proto__', 'constructor'])
    neg(minorOfferPathwayOpen(jur) === false, `S-p1 pathway closed for ${JSON.stringify(jur)}`);
  neg(
    Object.values(MINOR_OFFER_PATHWAY_ENABLED).every((v) => v === false),
    'S-p2 the policy table has no open entry',
  );
  const on = (iso) => new Date(`${iso}T12:00:00Z`);
  ok(adultAgeFor('GB') === 18 && adultAgeFor('KR') === 19, 'S-p3 GB 18, KR 19');
  neg(
    isAdult({ dob: '2008-03-15', country: 'GB' }, on('2026-03-14')) === false,
    'S-p4 GB: the day before the 18th birthday is not an adult',
  );
  ok(isAdult({ dob: '2008-03-15', country: 'GB' }, on('2026-03-15')) === true, 'S-p5 GB: the 18th birthday is');
  ok(isAdult({ dob: '2008-03-15', country: 'GB' }, on('2026-03-16')) === true, 'S-p6 GB: the day after is');
  neg(
    isAdult({ dob: '2007-03-15', country: 'KR' }, on('2026-03-14')) === false,
    'S-p7 KR: the day before the 19th birthday is not',
  );
  ok(
    isAdult({ dob: '2007-03-15', country: 'KR' }, on('2026-03-15')) === true &&
      isAdult({ dob: '2007-03-15', country: 'KR' }, on('2026-03-16')) === true,
    'S-p8 KR: the 19th birthday and after are',
  );
  neg(
    isAdult({ dob: '2008-03-15', country: 'GB' }, new Date('2026-03-15T00:00:00+14:00')) === false &&
      isAdult({ dob: '2008-03-15', country: 'GB' }, new Date('2026-03-14T23:59:59-05:00')) === true,
    'S-p9 the boundary is a calendar day in UTC, not a zone-shifted instant (local midnight in UTC+14 is still the 14th in UTC; 23:59 in UTC-5 is already the 15th)',
  );
  for (const dob of [
    null,
    undefined,
    false,
    0,
    '',
    '0000-00-00',
    '2030-01-01',
    '2026-02-30',
    'yesterday',
    NaN,
    19900101,
  ])
    neg(
      isAdult({ dob, country: 'GB' }, on('2026-06-01')) === false,
      `S-p10 dob ${JSON.stringify(dob)} never makes an adult`,
    );
  neg(
    !responderMatches(
      { recipientSnapshot: { type: 'guardian', playerId: 'p1', guardianId: 'g1' } },
      { kind: 'player', actorId: 'p1', playerId: 'p1' },
    ),
    'S-p11 a child cannot answer a guardian-addressed revision',
  );
}

section('L/M — pure: notification category, event registry audiences and payloads');
{
  const evs = [
    'offer_draft_created',
    'offer_draft_updated',
    'offer_issued',
    'offer_superseded',
    'offer_withdrawn',
    'offer_responded',
  ];
  neg(
    evs.every((e) => EVENT_REGISTRY[e].audience === 'org_private' && EVENT_REGISTRY[e].privacyClass === 'org_internal'),
    'M-p1 every Offer event is org-private (no agency or player fanout; the recipient and the agent hear through notifications)',
  );
  neg(
    evs.every((e) => EVENT_REGISTRY[e].payload.every((k) => ['orgId', 'roomId', 'offerId', 'status'].includes(k))),
    'M-p2 no payload key can carry a term, note, expiry, reason, document or person',
  );
  neg(
    EVENT_REGISTRY.offer_draft_created.notificationEligible === false &&
      EVENT_REGISTRY.offer_draft_updated.notificationEligible === false,
    'M-p3 draft events are not notification-eligible',
  );
  ok(
    RATE_LIMIT_POLICY.offer_response.scope === 'actor' &&
      ['offer_draft_write', 'offer_issue', 'offer_withdraw'].every((k) => RATE_LIMIT_POLICY[k].scope === 'org'),
    'H-p1 budgets: per person for answers, per organisation for club acts',
  );
  ok(Object.keys(OFFER_ERROR_HTTP).length === 23, 'T-p3 the 23-code error table is unchanged by hardening');
  const bidi = validateMessages({ recipientMessage: 'Join‮evil‬ us​ now', internalNote: 'a⁦b⁩c' });
  neg(
    bidi.recipientMessage === 'Joinevil us now' && bidi.internalNote === 'abc',
    'T-p4 bidi and zero-width format controls are stripped from messages (spoof-proof), ordinary text kept',
  );
  ok(
    validateTerms({ role: 'Ailier — «gauche» / 左ウイング' }).terms.role === 'Ailier — «gauche» / 左ウイング',
    'T-p5 legitimate Unicode is kept as typed',
  );
  neg(
    validateMessages({ recipientMessage: 'x'.repeat(OFFER_LIMITS.recipientMessage + 1) }).ok === false &&
      validateTerms({ conditions: 'y'.repeat(OFFER_LIMITS.conditions + 1) }).ok === false,
    'T-p6 oversized text is refused at the domain limit',
  );
  neg(
    validateExpiry('2026-03-08T02:30:00', { now: 1_800_000_000_000 }).ok === false,
    'R-p12 a bare local time is still refused',
  );
}

section('H — rate limits: closure budgets');
{
  ok(
    RATE_LIMIT_POLICY.offer_response.max >= 30 && RATE_LIMIT_POLICY.offer_withdraw.max >= 30,
    'H1 closure budgets (answer, withdraw) are generous enough for any honest use',
  );
}

done();
