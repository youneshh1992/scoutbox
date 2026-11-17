// The signing-package engine behind the signing battery (e2e/recruitment/signings.mjs), checked in this process: the
// vocabulary, validators, gates, integrity and views (A), and the reference mismatches that make a package corrupt
// (AD0–AD3). The battery keeps the schema, the error table, the rate policies and the events, read from spec/.
import { createHash } from 'node:crypto';
import {
  PUBLIC_ERROR_FIELDS,
  SIGNING_ERROR_HTTP,
  publicErrorBody,
} from '../../../domains/recruitment/signings/errors.mjs';
import {
  SIGNING_STATUSES,
  SIGNING_STORED_STATUSES,
  SIGNING_METHODS,
  PARTY_TYPES,
  MINOR_SIGNING_PATHWAY_ENABLED,
  minorSigningPathwayOpen,
  payloadFingerprint,
  validateContractDates,
  validateExpiry,
  requiredPartiesFor,
  effectiveStatus,
  canStart,
  canCompleteParty,
  completionGate,
  signingIntegrity,
  signingConsistency,
  signingCorrupt,
  SIGNING_CORRUPTION,
  signingRecipientView,
  signingAgentView,
  signingClubView,
  cleanText,
  SIGNING_INPUT_CODES,
} from '../../../domains/recruitment/signings/signing.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/signings');

const S_NOTE = 'PRIVATE_SIGNING_NOTE_8811';
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.parse('2026-03-15T12:00:00Z');
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdf = (text) =>
  Buffer.from(
    `%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
const DOC_A = pdf('Contract of employment — revision A');
const DOC_B = pdf('Contract of employment — revision B (amended clause 4)');
const SHA_A = sha256(DOC_A);
const SHA_B = sha256(DOC_B);

// ================================================================ A — model / store (pure)
section('A — model and store: vocabulary, validators, gates, integrity, error taxonomy, the closed minor pathway');
{
  ok(
    SIGNING_STATUSES.length === 8 &&
      SIGNING_STORED_STATUSES.length === 6 &&
      !SIGNING_STORED_STATUSES.includes('EXPIRED') &&
      !SIGNING_STORED_STATUSES.includes('SUPERSEDED'),
    'A4 eight statuses; EXPIRED is derived and SUPERSEDED is a revision status — neither is ever stored on a package',
  );
  neg(
    !SIGNING_STATUSES.includes('SIGNED'),
    'A5 no SIGNED workflow status: the word belongs to the case lifecycle alone',
  );
  ok(
    PARTY_TYPES.join() === 'PLAYER,GUARDIAN,CLUB_SIGNATORY' &&
      SIGNING_METHODS.join() === 'PLATFORM_ACKNOWLEDGMENT,UPLOAD_EXECUTED_DOCUMENT',
    'A6 three party types; only the two implemented methods',
  );
  neg(
    Object.values(MINOR_SIGNING_PATHWAY_ENABLED).every((v) => v === false) &&
      ['GB', 'ENG', 'INT', 'USA', 'FR', 'KR', 'ZZ', '', null, '__proto__', 'constructor'].every(
        (j) => minorSigningPathwayOpen(j) === false,
      ),
    '#15 A7 the minor signing pathway is closed in every jurisdiction, including unknown and prototype keys',
  );
  neg(
    [...Object.values(SIGNING_INPUT_CODES.codes), ...Object.values(SIGNING_INPUT_CODES.fieldCodes)].every(
      (c) => SIGNING_ERROR_HTTP[c] === 400,
    ) && ['problem', 'min', 'max'].every((f) => PUBLIC_ERROR_FIELDS.includes(f)),
    'A8b every input refusal code is a 400 in the table, and a refusal carries its problem and bounds',
  );
  neg(
    SIGNING_ERROR_HTTP.__proto__ === undefined && SIGNING_ERROR_HTTP.constructor === undefined,
    'A9 the error table has no prototype',
  );
  neg(
    !has(
      publicErrorBody({
        error: 'SIGNING_STATE_UNKNOWN',
        stack: 'x',
        row: { secret: 1 },
      }),
      'secret',
    ) && !PUBLIC_ERROR_FIELDS.includes('stack'),
    'A10 a 500 body carries no internals',
  );
  ok(
    payloadFingerprint({
      contract: { startDate: '2027-07-01', endDate: null },
    }) !==
      payloadFingerprint({
        contract: { startDate: '2027-07-02', endDate: null },
      }) && payloadFingerprint({ a: { b: 1, c: 2 } }) === payloadFingerprint({ a: { c: 2, b: 1 } }),
    'A11 the fingerprint is deep and canonical',
  );
  const cd = validateContractDates({
    startDate: '2027-07-01',
    endDate: '2029-06-30',
  });
  ok(
    cd.ok && cd.contract.startDate === '2027-07-01' && cd.contract.endDate === '2029-06-30',
    'A12 contract days validate as DATE_ONLY',
  );
  neg(
    !validateContractDates({ startDate: '2027-02-30' }).ok &&
      !validateContractDates({ startDate: '2027-07-01', endDate: '2027-06-30' }).ok &&
      !validateContractDates({ startDate: '2027-07-01', endDate: '2040-07-01' }).ok &&
      !validateContractDates({ startDate: 1720000000000 }).ok &&
      !validateContractDates({}).ok,
    '#44 A13 an impossible day, an end before the start, an eleven-year contract, an instant, and no start are all refused',
  );
  const T = Date.parse('2026-03-15T12:00:00Z');
  neg(
    !validateExpiry(T + 30 * 60 * 1000, { now: T }).ok &&
      !validateExpiry(T + 91 * DAY, { now: T }).ok &&
      !validateExpiry('tomorrow', { now: T }).ok &&
      validateExpiry(undefined, { now: T }).defaulted === true &&
      validateExpiry(T + 2 * H, { now: T }).ok,
    'A14 expiry: ≥1 h, ≤90 d, an instant; absent → the default',
  );
  const parties = requiredPartiesFor({
    recipientType: 'player',
    playerId: 'p1',
    orgId: 'o1',
  });
  ok(
    parties.length === 2 &&
      parties[0].partyType === 'PLAYER' &&
      parties[0].forEntityId === 'p1' &&
      parties[1].partyType === 'CLUB_SIGNATORY' &&
      parties[1].forEntityId === 'o1' &&
      parties.every((p) => p.status === 'PENDING'),
    'A15 required parties for an adult: the player and the club signatory, both pending',
  );
  const pkg = (patch = {}, revPatch = {}) => ({
    id: 'spk-1',
    orgId: 'o1',
    playerId: 'p1',
    caseId: 'c1',
    offerId: 'rof-1',
    offerRevisionId: 'rofr-1',
    status: 'READY',
    currentRevisionId: 'spr-1',
    createdAt: T,
    expiresAt: T + 7 * DAY,
    revisions: [
      {
        id: 'spr-1',
        revisionNumber: 1,
        status: 'READY',
        createdAt: T,
        readyAt: T + H,
        document: { evidenceId: 'vevd-1', sha256: SHA_A },
        contract: { startDate: '2027-07-01', endDate: null },
        requiredParties: requiredPartiesFor({
          recipientType: 'player',
          playerId: 'p1',
          orgId: 'o1',
        }),
        ...revPatch,
      },
    ],
    ...patch,
  });
  ok(
    effectiveStatus(pkg(), T + 7 * DAY - 1) === 'READY' &&
      effectiveStatus(pkg(), T + 7 * DAY) === 'EXPIRED' &&
      effectiveStatus(pkg({ status: 'COMPLETED' }), T + 8 * DAY) === 'COMPLETED',
    'A16 lazy expiry: READY 1 ms before, EXPIRED at the instant, a COMPLETED package never expires',
  );
  neg(
    effectiveStatus(pkg({ status: 'SIGNED' }), T) === null &&
      effectiveStatus(pkg({ status: 'signed' }), T) === null &&
      effectiveStatus(pkg({ status: '' }), T) === null &&
      effectiveStatus(pkg({ status: 'EXPIRED' }), T) === null,
    'A17 an unknown or unstorable status word is nothing — not live, not completed (fails closed)',
  );
  for (const st of ['DRAFT', 'ISSUED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED'])
    neg(
      canStart(
        {
          offerStatus: st,
          offerRevisionStatus: st,
          caseStatus: 'offer_accepted',
          recipientType: 'player',
          jurisdiction: 'GB',
        },
        T,
      ).error === 'SIGNING_OFFER_NOT_ACCEPTED',
      `#1 A18 no package over a ${st} Offer`,
    );
  neg(
    canStart(
      {
        offerStatus: 'ACCEPTED',
        offerRevisionStatus: 'ACCEPTED',
        caseStatus: 'offer_made',
        recipientType: 'player',
        jurisdiction: 'GB',
      },
      T,
    ).error === 'SIGNING_LIFECYCLE_CONFLICT',
    'A19 the case must be at offer_accepted',
  );
  neg(
    canStart(
      {
        offerStatus: 'ACCEPTED',
        offerRevisionStatus: 'ACCEPTED',
        caseStatus: 'offer_accepted',
        recipientType: 'guardian',
        jurisdiction: 'GB',
      },
      T,
    ).error === 'SIGNING_PATHWAY_CLOSED',
    '#15 A20 a guardian-addressed Offer opens no package while the pathway is closed',
  );
  neg(
    canStart(
      {
        offerStatus: 'ACCEPTED',
        offerRevisionStatus: 'ACCEPTED',
        caseStatus: 'offer_accepted',
        recipientType: 'player',
        jurisdiction: 'GB',
        existing: [pkg()],
      },
      T,
    ).error === 'SIGNING_PACKAGE_EXISTS' &&
      canStart(
        {
          offerStatus: 'ACCEPTED',
          offerRevisionStatus: 'ACCEPTED',
          caseStatus: 'offer_accepted',
          recipientType: 'player',
          jurisdiction: 'GB',
          existing: [
            pkg({
              status: 'COMPLETED',
              completion: { signingId: 's', completedAt: T },
            }),
          ],
        },
        T,
      ).error === 'SIGNING_ALREADY_COMPLETED',
    'A21 one live package per Offer; a completed one blocks another',
  );
  neg(
    canCompleteParty(
      pkg(),
      {
        partyType: 'PLAYER',
        actorKind: 'org',
        actorId: 'p1',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
      },
      T,
    ).error === 'SIGNING_NOT_PERMITTED',
    '#10 A22 an org actor cannot complete the PLAYER party (the pure gate)',
  );
  neg(
    canCompleteParty(
      pkg(),
      {
        partyType: 'CLUB_SIGNATORY',
        actorKind: 'player',
        actorId: 'p1',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
      },
      T,
    ).error === 'SIGNING_NOT_PERMITTED',
    'A23 a player cannot complete the club signatory',
  );
  neg(
    canCompleteParty(
      pkg(),
      {
        partyType: 'PLAYER',
        actorKind: 'player',
        actorId: 'p2',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
      },
      T,
    ).error === 'SIGNING_PARTY_NOT_REQUIRED',
    '#9 A24 another player is not a required party',
  );
  neg(
    canCompleteParty(
      pkg(),
      {
        partyType: 'PLAYER',
        actorKind: 'player',
        actorId: 'p1',
        revisionId: 'spr-1',
        documentSha256: SHA_B,
      },
      T,
    ).error === 'SIGNING_DOCUMENT_MISMATCH',
    'A25 confirming a different digest than the presented revision is a mismatch',
  );
  const two = pkg({ currentRevisionId: 'spr-2' });
  two.revisions.push({ ...two.revisions[0], id: 'spr-2', revisionNumber: 2 });
  two.revisions[0].status = 'SUPERSEDED';
  neg(
    canCompleteParty(
      two,
      {
        partyType: 'PLAYER',
        actorKind: 'player',
        actorId: 'p1',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
      },
      T,
    ).error === 'SIGNING_SUPERSEDED',
    '#18 A26 a signature against a superseded revision is refused',
  );
  neg(
    canCompleteParty(
      pkg(),
      {
        partyType: 'PLAYER',
        actorKind: 'player',
        actorId: 'p1',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
      },
      T + 8 * DAY,
    ).error === 'SIGNING_EXPIRED',
    'A27 no party completes an expired package',
  );
  const gateCtx = (p, extra = {}) =>
    completionGate(p, {
      now: T + 2 * H,
      offer: {
        id: 'rof-1',
        status: 'ACCEPTED',
        orgId: 'o1',
        playerId: 'p1',
        caseId: 'c1',
      },
      offerRevision: { id: 'rofr-1', status: 'ACCEPTED' },
      kase: {
        id: 'c1',
        orgId: 'o1',
        playerId: 'p1',
        room: { status: 'offer_accepted' },
      },
      ...extra,
    });
  neg(gateCtx(pkg()).includes('PARTIES_INCOMPLETE'), '#16 #26 A28 a package with no party complete cannot complete');
  const done = pkg({ status: 'IN_PROGRESS' }, { status: 'IN_PROGRESS' });
  for (const p of done.revisions[0].requiredParties)
    Object.assign(p, {
      status: 'COMPLETED',
      completedAt: T + 90 * 60 * 1000,
      completedBy: {
        kind: p.partyType === 'PLAYER' ? 'player' : 'org',
        id: 'x',
      },
      method: 'PLATFORM_ACKNOWLEDGMENT',
      evidenceRef: {
        kind: 'platform_acknowledgment',
        id: 'sgev-x',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
        at: T + 90 * 60 * 1000,
        actorKind: p.partyType === 'PLAYER' ? 'player' : 'org',
        actorId: 'x',
        session: 'authenticated',
      },
    }); // a real evidence reference names the revision, the digest, the actor and the instant
  ok(gateCtx(done).length === 0, 'A29 every party complete against the exact digest: the gate is empty');
  neg(
    gateCtx(done, { blocked: true }).includes('BLOCKED') &&
      gateCtx(done, { otherCompleted: true }).includes('CONFLICTING_COMPLETED_SIGNING') &&
      gateCtx(done, {
        kase: {
          id: 'c1',
          orgId: 'o1',
          playerId: 'p1',
          room: { status: 'on_hold' },
        },
      }).includes('LIFECYCLE_CONFLICT') &&
      gateCtx(done, {
        offer: {
          id: 'rof-1',
          status: 'ACCEPTED',
          orgId: 'o1',
          playerId: 'p2',
          caseId: 'c1',
        },
      }).includes('REFERENCE_MISMATCH'),
    'A30 a block, a conflicting completed signing, a paused case and a player mismatch each close the gate',
  );
  const bad = JSON.parse(JSON.stringify(done));
  bad.revisions[0].requiredParties[0].evidenceRef.documentSha256 = SHA_B;
  neg(gateCtx(bad).includes('DOCUMENT_MISMATCH'), 'A31 evidence against another digest closes the gate');
  ok(signingIntegrity(pkg()).length === 0 && signingIntegrity(done).length === 0, 'A32 sound rows pass integrity');
  neg(
    signingIntegrity(pkg({ status: 'SIGNED' })).includes('status') &&
      signingIntegrity(pkg({}, { status: 'countersigned' })).includes('revision_status'),
    'A33 unknown package and revision statuses are named',
  );
  const late = pkg();
  late.revisions[0].readyAt = T - H;
  neg(signingIntegrity(late).includes('ready_before_created'), '#45 A34 presented before created is corruption');
  const early = JSON.parse(JSON.stringify(done));
  early.revisions[0].requiredParties[0].completedAt = T;
  neg(
    signingIntegrity(early).includes('party_before_ready'),
    '#45 A35 a party completed before the revision was presented is corruption',
  );
  const comp = JSON.parse(JSON.stringify(done));
  comp.status = 'COMPLETED';
  comp.revisions[0].status = 'COMPLETED';
  comp.revisions[0].completedAt = T + H;
  comp.completion = { signingId: 's', completedAt: T + H };
  neg(
    signingIntegrity(comp).includes('completed_before_parties'),
    '#46 A36 completed before the final party is corruption',
  );
  const noComp = JSON.parse(JSON.stringify(comp));
  noComp.completion = null;
  noComp.revisions[0].completedAt = T + 2 * H;
  neg(
    signingIntegrity(noComp).includes('completion'),
    'A37 a COMPLETED package without its completion record is corruption',
  );
  const ptr = pkg({ currentRevisionId: 'spr-1' });
  ptr.revisions.push({ ...ptr.revisions[0], id: 'spr-2', revisionNumber: 2 });
  neg(
    signingIntegrity(ptr).includes('current_revision_not_latest'),
    'A38 a pointer at a non-latest revision is corruption',
  );
  const agentActor = JSON.parse(JSON.stringify(done));
  agentActor.revisions[0].requiredParties[0].completedBy = {
    kind: 'org',
    id: 'agent',
  };
  neg(
    signingIntegrity(agentActor).includes('party_actor_kind'),
    '#10 A39 a PLAYER party completed by an org actor is corruption on the record too',
  );
  neg(
    signingConsistency(
      pkg({
        status: 'COMPLETED',
        completion: { signingId: 's', completedAt: T },
      }),
      {
        offer: { orgId: 'o1', playerId: 'p1', caseId: 'c1' },
        kase: {
          orgId: 'o1',
          playerId: 'p1',
          room: { status: 'offer_accepted' },
        },
      },
      T,
    ).includes('COMPLETED_BUT_CASE_NOT_SIGNED'),
    'A40 a completed package on a case that is not signed is corruption',
  );
  const rv = signingRecipientView(pkg({}, { readyAt: null, status: 'DRAFT' }), T, {
    orgName: 'X',
    partyType: 'PLAYER',
    forEntityId: 'p1',
  });
  neg(
    rv.currentRevision === null && rv.revisions.length === 0 && !has(rv, S_NOTE),
    '#8 A41 the recipient view of an unpresented revision carries no revision',
  );
  const cv = signingClubView(pkg({ internalNote: S_NOTE }), T);
  const av = signingAgentView(pkg({ internalNote: S_NOTE }), T);
  neg(
    has(cv, S_NOTE) &&
      !has(av, S_NOTE) &&
      !has(
        signingRecipientView(pkg({ internalNote: S_NOTE }), T, {
          partyType: 'PLAYER',
          forEntityId: 'p1',
        }),
        S_NOTE,
      ) &&
      !has(av, 'sha256'),
    '#39 A42 the note reaches the club view only; the agent view carries no digest',
  );
  neg(
    cleanText('a‮b', 100).value === 'ab' && cleanText('x'.repeat(101), 100).ok === false,
    'A43 bidi controls stripped; limits enforced',
  );
}

// ================================================================ AD — reference mismatches (#5 #6 #7)
section('AD — reference mismatches: a package whose Offer, case or Offer revision contradicts it');
{
  // #5 #6 #7 (pure): a package whose Offer, case or Offer revision contradicts it is corruption — omitted, refused, never repaired.
  const TT = T0;
  const mk = (patch = {}) => ({
    id: 'spk-x',
    orgId: 'o1',
    playerId: 'p1',
    caseId: 'c1',
    offerId: 'rof-1',
    offerRevisionId: 'rofr-1',
    status: 'READY',
    currentRevisionId: 'spr-1',
    createdAt: TT,
    expiresAt: TT + DAY,
    revisions: [
      {
        id: 'spr-1',
        revisionNumber: 1,
        status: 'READY',
        createdAt: TT,
        readyAt: TT + 1,
        document: { evidenceId: 'ev', sha256: SHA_A },
        contract: { startDate: '2027-07-01', endDate: null },
        requiredParties: [
          { partyType: 'PLAYER', forEntityId: 'p1', status: 'PENDING' },
          { partyType: 'CLUB_SIGNATORY', forEntityId: 'o1', status: 'PENDING' },
        ],
      },
    ],
    ...patch,
  });
  const okOffer = {
    id: 'rof-1',
    orgId: 'o1',
    playerId: 'p1',
    caseId: 'c1',
    revisions: [{ id: 'rofr-1', status: 'ACCEPTED' }],
  };
  const okCase = {
    id: 'c1',
    orgId: 'o1',
    playerId: 'p1',
    room: { status: 'offer_accepted' },
  };
  ok(
    signingConsistency(mk(), { offer: okOffer, kase: okCase }, TT).length === 0,
    'AD0 a sound package over its accepted Offer revision has no consistency problem',
  );
  const c5 = signingConsistency(mk(), { offer: { ...okOffer, playerId: 'p2' }, kase: okCase }, TT);
  neg(
    c5.includes('OFFER_REFERENCE_MISMATCH') && signingCorrupt(c5),
    '#5 AD1 a package whose Offer names another player is corruption',
  );
  neg(
    signingConsistency(mk(), { offer: okOffer, kase: { ...okCase, playerId: 'p2' } }, TT).includes(
      'CASE_REFERENCE_MISMATCH',
    ) &&
      signingConsistency(mk(), { offer: { ...okOffer, caseId: 'c9' }, kase: okCase }, TT).includes(
        'OFFER_REFERENCE_MISMATCH',
      ),
    '#6 AD2 a package whose case names another player, or whose Offer belongs to another case, is corruption',
  );
  const staleOffer = {
    ...okOffer,
    revisions: [
      { id: 'rofr-0', status: 'SUPERSEDED', supersededByRevisionId: 'rofr-1' },
      { id: 'rofr-1', status: 'ACCEPTED' },
    ],
  };
  neg(
    signingConsistency(mk({ offerRevisionId: 'rofr-0' }), { offer: staleOffer, kase: okCase }, TT).includes(
      'OFFER_REVISION_MISMATCH',
    ) &&
      signingConsistency(mk({ offerRevisionId: 'rofr-9' }), { offer: staleOffer, kase: okCase }, TT).includes(
        'OFFER_REVISION_MISMATCH',
      ) &&
      signingConsistency(mk(), { offer: staleOffer, kase: okCase }, TT).length === 0 &&
      SIGNING_CORRUPTION.includes('OFFER_REVISION_MISMATCH'),
    '#7 AD3 a package bound to a superseded or unknown Offer revision is corruption; bound to the accepted one it is sound',
  );
}

done();
