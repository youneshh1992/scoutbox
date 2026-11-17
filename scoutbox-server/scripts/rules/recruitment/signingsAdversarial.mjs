// The signing rules behind the signing hardening battery (e2e/recruitment/signingsAdversarial.mjs), checked in this
// process: forged evidence (A), required-party corruption (D1–D8), the age and pathway gates (H1–H2), the row
// contradictions (P14–P15), temporal corruption on the record (S1–S9) and the start, party and gate rules (ZC–ZF). The
// battery plants the same corruption in stored rows and checks that the server fails closed over HTTP.
import { createHash } from 'node:crypto';
import { isAdult } from '../../../domain.ts';
import {
  signingIntegrity,
  signingConsistency,
  signingCorrupt,
  SIGNING_CORRUPTION,
  effectiveStatus,
  canCompleteParty,
  completionGate,
  requiredPartiesFor,
  canStart,
} from '../../../domains/recruitment/signings/signing.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/signingsAdversarial');

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.parse('2026-03-15T12:00:00Z');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdf = (text) =>
  Buffer.from(
    `%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
const SHA_A = sha256(pdf('Contract of employment — hardening A'));
const SHA_B = sha256(pdf('Contract of employment — hardening B'));

// ================================================================ A — evidence tampering (pure)
section('A — evidence tampering: every forged or moved evidence reference is corruption on the record');
{
  const T = T0;
  const base = () => ({
    id: 'spk-1',
    orgId: 'o1',
    playerId: 'p1',
    caseId: 'c1',
    offerId: 'rof-1',
    offerRevisionId: 'rofr-1',
    status: 'IN_PROGRESS',
    currentRevisionId: 'spr-1',
    createdAt: T,
    expiresAt: T + 7 * DAY,
    revisions: [
      {
        id: 'spr-1',
        revisionNumber: 1,
        status: 'IN_PROGRESS',
        createdAt: T,
        readyAt: T + H,
        document: { evidenceId: 'vevd-1', sha256: SHA_A },
        contract: { startDate: '2027-07-01', endDate: null },
        requiredParties: requiredPartiesFor({
          recipientType: 'player',
          playerId: 'p1',
          orgId: 'o1',
        }),
      },
    ],
  });
  const signed = (mut = () => {}) => {
    const p = base();
    const party = p.revisions[0].requiredParties[0];
    Object.assign(party, {
      status: 'COMPLETED',
      completedAt: T + 2 * H,
      completedBy: { kind: 'player', id: 'p1', name: 'P' },
      method: 'PLATFORM_ACKNOWLEDGMENT',
      evidenceRef: {
        kind: 'platform_acknowledgment',
        id: 'sgev-1',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
        at: T + 2 * H,
        actorKind: 'player',
        actorId: 'p1',
        session: 'authenticated',
      },
    });
    mut(p, party);
    return p;
  };
  ok(signingIntegrity(signed()).length === 0, 'A1 a genuine completed party passes');
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.completedBy.id = 'p2';
      }),
    ).includes('party_evidence_actor'),
    'A2 the actor on the party changed → party_evidence_actor',
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.completedBy.kind = 'org';
      }),
    ).includes('party_actor_kind') &&
      signingIntegrity(
        signed((p, q) => {
          q.completedBy.kind = 'org';
        }),
      ).includes('party_evidence_actor'),
    'A3 the actor TYPE changed (an org actor on the player party) → party_actor_kind and party_evidence_actor',
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.evidenceRef = null;
      }),
    ).includes('party_evidence'),
    'A4 the evidence reference removed → party_evidence',
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.completedAt = 'yesterday';
      }),
    ).includes('party_evidence'),
    'A5 a malformed completedAt → party_evidence',
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.evidenceRef.revisionId = 'spr-0';
      }),
    ).includes('party_evidence_revision'),
    'A6 evidence that names another revision → party_evidence_revision',
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.evidenceRef.documentSha256 = SHA_B;
      }),
    ).includes('party_evidence_digest'),
    'A7 evidence that names another digest → party_evidence_digest',
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.evidenceRef.at = T + 3 * H;
      }),
    ).includes('party_evidence_instant'),
    "A8 evidence whose instant differs from the party's → party_evidence_instant",
  );
  neg(
    signingIntegrity(
      signed((p, q) => {
        q.status = 'COMPLETED';
        q.evidenceRef = null;
        q.method = null;
      }),
    ).includes('party_evidence'),
    'A9 a party marked complete with no evidence → party_evidence',
  );
  neg(
    signingIntegrity(
      signed((p) => {
        const c = p.revisions[0].requiredParties[1];
        c.evidenceRef = {
          kind: 'platform_acknowledgment',
          id: 'x',
          revisionId: 'spr-1',
          documentSha256: SHA_A,
          at: T + 2 * H,
          actorKind: 'org',
          actorId: 'u',
        };
      }),
    ).includes('party_pending_with_evidence'),
    'A10 a PENDING party carrying evidence → party_pending_with_evidence',
  );
  const gate = completionGate(
    signed((p, q) => {
      q.evidenceRef.documentSha256 = SHA_B;
    }),
    {
      now: T + 3 * H,
      offer: {
        id: 'rof-1',
        orgId: 'o1',
        playerId: 'p1',
        caseId: 'c1',
        status: 'ACCEPTED',
      },
      offerRevision: { id: 'rofr-1', status: 'ACCEPTED' },
      kase: {
        id: 'c1',
        orgId: 'o1',
        playerId: 'p1',
        room: { status: 'offer_accepted' },
      },
    },
  );
  neg(
    gate.includes('DOCUMENT_MISMATCH') && gate.includes('PARTIES_INCOMPLETE'),
    'A11 the completion gate names the forged digest and the missing club party',
  );
  neg(
    completionGate(base(), {
      now: T,
      offer: null,
      offerRevision: null,
      kase: null,
      documentProblem: 'bytes_mismatch',
    }).includes('DOCUMENT_BYTES_BYTES_MISMATCH'),
    'A12 a document-bytes problem the caller verified is a gate problem of its own',
  );
}

section("D \u2014 required parties: only the package's own recipient party and club signatory, or corruption");
{
  const T = T0;
  const base = () => ({
    id: 'spk-d',
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
      },
    ],
  });
  const withParties = (f) => {
    const p = base();
    p.revisions[0].requiredParties = f(p.revisions[0].requiredParties);
    return p;
  };
  neg(signingIntegrity(withParties(() => [])).includes('parties'), 'D1 empty requiredParties → parties');
  neg(
    signingIntegrity(withParties((ps) => [...ps, { ...ps[0] }])).includes('party_duplicate'),
    'D2 a duplicate required party → party_duplicate',
  );
  neg(
    signingIntegrity(withParties((ps) => [{ ...ps[0], partyType: 'WITNESS' }, ps[1]])).includes('party_shape'),
    'D3 an unknown party type → party_shape',
  );
  neg(
    signingIntegrity(withParties((ps) => [{ ...ps[0], forEntityId: 'p2' }, ps[1]])).includes('party_entity_mismatch'),
    'D4 a PLAYER party naming another player → party_entity_mismatch',
  );
  neg(
    signingIntegrity(withParties((ps) => [{ ...ps[0], forPlayerId: 'p2' }, ps[1]])).includes('party_player_mismatch'),
    'D4b a party for another player → party_player_mismatch',
  );
  neg(
    signingIntegrity(withParties((ps) => [ps[0], { ...ps[1], forEntityId: 'o2' }])).includes('party_entity_mismatch'),
    'D5 a CLUB_SIGNATORY naming another organisation → party_entity_mismatch',
  );
  neg(
    signingIntegrity(withParties((ps) => [ps[1]])).includes('party_recipient_missing'),
    'D6 no player party → party_recipient_missing',
  );
  neg(
    signingIntegrity(withParties((ps) => [ps[0]])).includes('party_club_missing'),
    'D6b no club signatory → party_club_missing',
  );
  neg(
    signingIntegrity(
      withParties((ps) => [
        ...ps,
        {
          partyType: 'GUARDIAN',
          forEntityId: 'gd-1',
          forPlayerId: 'p1',
          status: 'PENDING',
          completedAt: null,
          completedBy: null,
          evidenceRef: null,
          method: null,
        },
      ]),
    ).includes('party_recipient_duplicate'),
    'D7 a guardian added beside the adult player → party_recipient_duplicate',
  );
  neg(
    canCompleteParty(
      base(),
      {
        partyType: 'PLAYER',
        actorKind: 'org',
        actorId: 'agent-1',
        revisionId: 'spr-1',
        documentSha256: SHA_A,
      },
      T + 2 * H,
    ).error === 'SIGNING_NOT_PERMITTED',
    'D8 an agent (org actor) substituted for the player is refused by the party gate',
  );
}

section('H \u2014 guardian and minor: a malformed date of birth opens nothing; the pathway stays closed');
{
  neg(
    isAdult({ dob: 'not-a-date', country: 'GB' }) === false &&
      isAdult({ dob: null, country: 'GB' }) === false &&
      isAdult({ dob: '2099-01-01', country: 'GB' }) === false &&
      isAdult({}) === false,
    'H1 a malformed, missing or future date of birth is NOT an adult (fails closed to the protected side)',
  );
  neg(
    canStart(
      {
        offerStatus: 'ACCEPTED',
        offerRevisionStatus: 'ACCEPTED',
        caseStatus: 'offer_accepted',
        recipientType: 'guardian',
        jurisdiction: 'ENG',
      },
      T0,
    ).error === 'SIGNING_PATHWAY_CLOSED' &&
      canStart(
        {
          offerStatus: 'ACCEPTED',
          offerRevisionStatus: 'ACCEPTED',
          caseStatus: 'offer_accepted',
          recipientType: 'guardian',
          jurisdiction: 'ZZ',
        },
        T0,
      ).error === 'SIGNING_PATHWAY_CLOSED',
    'H2 a guardian recipient cannot open a package in a known or an unknown jurisdiction',
  );
}

section('P \u2014 row contradictions: corruption, never repaired');
{
  neg(
    SIGNING_CORRUPTION.includes('COMPLETED_WITHOUT_ROW') &&
      SIGNING_CORRUPTION.includes('ROW_WITHOUT_COMPLETION') &&
      SIGNING_CORRUPTION.includes('DUPLICATE_SIGNING_ROWS') &&
      !SIGNING_CORRUPTION.includes('PLAYER_CONTRACT_STATUS_DIVERGED'),
    "P14 (pure) the row contradictions are corruption; the player's declared status is a warning",
  );
  neg(
    signingCorrupt(
      signingConsistency(
        {
          id: 'x',
          orgId: 'o',
          playerId: 'p',
          caseId: 'c',
          offerId: 'f',
          offerRevisionId: 'r',
          status: 'COMPLETED',
          completion: { signingId: 's1', completedAt: T0 },
          revisions: [],
        },
        {
          offer: null,
          kase: null,
          rows: [{ id: 's2', signingPackageId: 'x' }],
        },
        T0,
      ),
    ) &&
      signingConsistency(
        {
          id: 'x',
          orgId: 'o',
          playerId: 'p',
          caseId: 'c',
          offerId: 'f',
          offerRevisionId: 'r',
          status: 'COMPLETED',
          completion: { signingId: 's1', completedAt: T0 },
          revisions: [],
        },
        {
          offer: null,
          kase: null,
          rows: [{ id: 's2', signingPackageId: 'x' }],
        },
        T0,
      ).includes('COMPLETION_ROW_MISMATCH'),
    'P15 (pure) a completion that names a row id the store does not hold for it → COMPLETION_ROW_MISMATCH',
  );
}

section('S \u2014 temporal corruption on the record');
{
  const T = T0;
  const H1 = H;
  const base = () => ({
    id: 'spk-s',
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
        readyAt: T + H1,
        document: { evidenceId: 'vevd-1', sha256: SHA_A },
        contract: { startDate: '2027-07-01', endDate: null },
        requiredParties: requiredPartiesFor({
          recipientType: 'player',
          playerId: 'p1',
          orgId: 'o1',
        }),
      },
    ],
  });
  const mut = (f) => {
    const p = base();
    f(p);
    return p;
  };
  neg(
    signingIntegrity(
      mut((p) => {
        p.createdAt = 'yesterday';
      }),
    ).includes('created_at'),
    'S1 malformed createdAt',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.revisions[0].readyAt = 'later';
      }),
    ).includes('presented_without_document') ||
      signingIntegrity(
        mut((p) => {
          p.revisions[0].readyAt = 'later';
        }),
      ).length > 0,
    'S2 malformed readyAt (presentedAt) on a READY revision is corruption',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.expiresAt = 'soon';
      }),
    ).includes('expires_at'),
    'S3 malformed expiresAt',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.expiresAt = T + 400 * DAY;
      }),
    ).includes('expiry_beyond_max'),
    'S4 an expiry no act could have set (400 days out) is corruption — a package cannot be made immortal by editing the store',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.expiresAt = T - 1;
      }),
    ).includes('expiry_before_created'),
    'S5 expiry before creation',
  );
  neg(
    effectiveStatus(
      mut((p) => {
        p.expiresAt = 'soon';
      }),
      T,
    ) === 'READY' &&
      signingIntegrity(
        mut((p) => {
          p.expiresAt = 'soon';
        }),
      ).length > 0,
    'S6 a malformed expiry reads as live to effectiveStatus alone — which is why integrity runs before every read and write (the row is refused, not treated as never-expiring)',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.revisions[0].createdAt = T - 1;
      }),
    ).includes('revision_before_package'),
    'S7 a revision created before its package',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.revisions[0].readyAt = T - 1;
      }),
    ).includes('ready_before_created'),
    'S8 presented before created',
  );
  neg(
    signingIntegrity(
      mut((p) => {
        p.revisions[0].contract.startDate = '2027-02-30';
      }),
    ).includes('contract_dates') &&
      signingIntegrity(
        mut((p) => {
          p.revisions[0].contract.endDate = '2026-01-01';
          p.revisions[0].contract.startDate = '2027-01-01';
        }),
      ).length >= 0,
    'S9 an impossible contract day on the record is corruption',
  );
}

section('Z \u2014 the start, party and gate invariants');
{
  neg(
    canStart(
      {
        offerStatus: 'ISSUED',
        offerRevisionStatus: 'ISSUED',
        caseStatus: 'offer_made',
        recipientType: 'player',
        jurisdiction: 'GB',
      },
      T0,
    ).error === 'SIGNING_OFFER_NOT_ACCEPTED',
    'ZC an issued Offer cannot open a package (pure)',
  );
  const rp = requiredPartiesFor({
    recipientType: 'player',
    playerId: 'p1',
    orgId: 'o1',
  });
  neg(
    rp.length === 2 && rp.map((p) => p.partyType).join() === 'PLAYER,CLUB_SIGNATORY',
    'ZD/ZE the required parties are explicit; completion needs both (gate, above)',
  );
  neg(
    canCompleteParty(
      {
        id: 'x',
        orgId: 'o1',
        playerId: 'p1',
        status: 'READY',
        currentRevisionId: 'r',
        createdAt: T0,
        revisions: [
          {
            id: 'r',
            status: 'READY',
            readyAt: T0,
            document: { sha256: SHA_A },
            requiredParties: rp,
          },
        ],
      },
      {
        partyType: 'PLAYER',
        actorKind: 'org',
        actorId: 'agent',
        revisionId: 'r',
        documentSha256: SHA_A,
      },
      T0 + 1,
    ).error === 'SIGNING_NOT_PERMITTED',
    'ZF an agent cannot sign as the player',
  );
}

done();
