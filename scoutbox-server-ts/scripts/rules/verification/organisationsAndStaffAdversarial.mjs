// The verification rules behind the adversarial organisations-and-staff battery
// (e2e/verification/organisationsAndStaffAdversarial.mjs), checked in this process: evidence content signatures,
// licence assurance, identity provenance, removed subjects and token peeking.
import {
  evidenceFileProblem,
  sniffFileSignature,
  toPublicVerificationProfile,
  assuranceForClaim,
  claimProvenanceLabel,
  mintToken,
  consumeToken,
  peekToken,
  arrayTokenStore,
} from '../../../domains/verification/claims/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, section, done } = rulesSuite('verification/organisationsAndStaffAdversarial');
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

section('U1 — evidence content signatures: bytes must BE the claimed format');
{
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  ok(sniffFileSignature(png) === 'image/png', 'real PNG bytes sniff as PNG');
  ok(
    evidenceFileProblem({ mime: 'image/png', bytes: png.length, filename: 'ok.png', buffer: png }) === null,
    'genuine PNG accepted',
  );
  const exe = Buffer.concat([Buffer.from('MZ\x90\x00\x03'), Buffer.alloc(64)]);
  ok(
    evidenceFileProblem({ mime: 'image/png', bytes: exe.length, filename: 'x.png', buffer: exe }) ===
      'FILE_CONTENT_UNRECOGNISED',
    'executable bytes labelled image/png rejected',
  );
  const html = Buffer.from('<!doctype html><script>alert(1)</script><p>padding padding</p>');
  ok(
    evidenceFileProblem({ mime: 'application/pdf', bytes: html.length, filename: 'doc.pdf', buffer: html }) ===
      'FILE_CONTENT_UNRECOGNISED',
    'HTML labelled application/pdf rejected',
  );
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>');
  ok(
    evidenceFileProblem({ mime: 'image/png', bytes: svg.length, filename: 'img.png', buffer: svg }) ===
      'FILE_CONTENT_UNRECOGNISED',
    'SVG/script content renamed .png rejected',
  );
  const pdfBytesAsPng = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]);
  ok(
    evidenceFileProblem({
      mime: 'image/png',
      bytes: pdfBytesAsPng.length,
      filename: 'img.png',
      buffer: pdfBytesAsPng,
    }) === 'FILE_SIGNATURE_MISMATCH',
    'valid PDF bytes under an image/png label = signature mismatch',
  );
  ok(
    evidenceFileProblem({ mime: 'application/pdf', bytes: 4, filename: 'a.pdf', buffer: Buffer.from('%PDF') }) ===
      'FILE_CONTENT_UNRECOGNISED',
    'truncated/malformed payload rejected',
  );
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  ok(
    sniffFileSignature(jpeg) === 'image/jpeg' && sniffFileSignature(webp) === 'image/webp',
    'JPEG and WebP signatures recognised',
  );
  ok(
    evidenceFileProblem({ mime: 'application/pdf', bytes: 1000, filename: 'no-buffer.pdf' }) === null,
    'metadata-only validation still works where no bytes are in play',
  );
}

section('U2 — assurance semantics: the projector is provenance-sensitive');
{
  const org = { id: 'o1', name: 'Testchester FC', suspended: false, verificationRevokedAt: null };
  const lic = (method) => ({
    id: 'c',
    subjectType: 'user',
    subjectId: 'u1',
    claimType: 'LICENCE',
    organisationId: null,
    status: 'verified',
    current: true,
    validFrom: 1,
    validUntil: null,
    verificationMethod: method,
    verifiedAt: 5,
    metadata: { licenceType: 'UEFA A Licence' },
    evidenceIds: [],
  });
  ok(assuranceForClaim(lic('authoritative_registry')) === 'authoritative', 'registry match → authoritative');
  ok(
    assuranceForClaim(lic('scoutbox_manual_review')) === 'scoutbox_document_review',
    'manual review → scoutbox_document_review',
  );
  ok(
    assuranceForClaim(lic('organisation_admin_confirmation')) === 'organisation_attested',
    'org confirmation → organisation_attested',
  );
  const pReg = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [lic('authoritative_registry')],
  });
  ok(
    pReg.badges[0].label === 'Licence verified: UEFA A Licence' && pReg.badges[0].assurance === 'authoritative',
    'authoritative source MAY say "Licence verified"',
  );
  const pMan = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [lic('scoutbox_manual_review')],
  });
  ok(
    pMan.badges[0].label === 'Credential reviewed: UEFA A Licence',
    'document review NEVER says "Licence verified" — it says "Credential reviewed"',
  );
  ok(
    pMan.badges[0].provenance.includes('not independently confirmed with the issuing authority'),
    'document-review provenance names the limitation explicitly',
  );
  ok(
    claimProvenanceLabel(lic('scoutbox_manual_review')) ===
      'Document reviewed by ScoutBox Trust & Safety — not independently confirmed with the issuing authority.',
    'licence provenance override exact',
  );
  const pending = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [{ ...lic('document_submitted'), status: 'pending' }],
  });
  ok(pending.badges.length === 0, 'document upload alone → NO licence badge of any kind');
}

section('U3 — identity provenance: structured, method-distinguishing, no evidence');
{
  const idc = (method, status = 'verified') => ({
    id: 'i',
    subjectType: 'user',
    subjectId: 'u1',
    claimType: 'PERSON_IDENTITY',
    organisationId: null,
    status,
    current: true,
    validFrom: 1,
    validUntil: null,
    verificationMethod: method,
    verifiedAt: 9,
    metadata: {},
    evidenceIds: ['ev-secret'],
  });
  const man = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [idc('scoutbox_manual_review')],
  });
  ok(
    man.identity?.confirmed === true && man.identity.assurance === 'scoutbox_document_review',
    'manual identity review → confirmed with scoutbox_document_review assurance',
  );
  ok(
    man.identity.label === 'Identity confirmed by ScoutBox review' && man.identityVerified === true,
    'label + compatibility boolean agree',
  );
  const auth = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [idc('authoritative_registry')],
  });
  ok(
    auth.identity?.assurance === 'authoritative' &&
      auth.identity.label === 'Identity confirmed by an authoritative provider',
    'a (future/test) authoritative identity method is DISTINGUISHABLE from document review',
  );
  ok(
    toPublicVerificationProfile({
      subjectType: 'user',
      subjectId: 'u1',
      claims: [idc('document_submitted', 'pending')],
    }).identity === null,
    'pending identity exposes nothing',
  );
  ok(
    toPublicVerificationProfile({
      subjectType: 'user',
      subjectId: 'u1',
      claims: [{ ...idc('scoutbox_manual_review'), status: 'revoked', current: false }],
    }).identity === null,
    'revoked identity exposes nothing',
  );
  const s = JSON.stringify([man, auth]);
  ok(!s.includes('ev-secret') && !s.includes('evidenceIds'), 'identity projection never leaks evidence');
}

section('U4 — subjectRemoved + peekToken primitives');
{
  const org = { id: 'o1', name: 'X', suspended: false, verificationRevokedAt: null };
  const cur = {
    id: 'c',
    subjectType: 'user',
    subjectId: 'u1',
    claimType: 'CLUB_ROLE',
    organisationId: 'o1',
    status: 'verified',
    current: true,
    validFrom: 1,
    validUntil: null,
    verificationMethod: 'organisation_admin_confirmation',
    verifiedAt: 2,
    role: 'Scout',
    metadata: {},
    evidenceIds: [],
  };
  const hist = { ...cur, id: 'h', current: false, validUntil: 99 };
  const alive = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [cur, hist],
    orgsById: new Map([['o1', org]]),
  });
  const removed = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims: [cur, hist],
    orgsById: new Map([['o1', org]]),
    subjectRemoved: true,
  });
  ok(
    alive.badges.some((b) => b.current),
    'active account: current badge displays',
  );
  ok(!removed.badges.some((b) => b.current), 'subjectRemoved: NO current badge survives the projector');
  ok(
    removed.badges.some((b) => b.historical),
    'closed historical periods remain as history (policy: truth preserved)',
  );
  const fdb = { verTokens: [] };
  const ts = arrayTokenStore(fdb.verTokens); // the token functions take a store (the server's is the repository)
  const nid = (() => {
    let n = 0;
    return (p) => `${p}-${++n}`;
  })();
  const secret = mintToken(ts, nid, { purpose: 'player_invite', subjectId: 'alice' });
  ok(
    peekToken(ts, { purpose: 'player_invite', secret }).token && !fdb.verTokens[0].usedAt,
    'peek validates WITHOUT consuming',
  );
  ok(
    peekToken(ts, { purpose: 'player_invite', secret, subjectId: 'bob' }).error === 'TOKEN_WRONG_ACCOUNT',
    'peek enforces subject binding',
  );
  ok(
    consumeToken(ts, { purpose: 'player_invite', secret, subjectId: 'alice' }).token && fdb.verTokens[0].usedAt,
    'consume marks used on success',
  );
  const expired = mintToken(ts, nid, { purpose: 'player_invite', ttlMs: -1 });
  ok(
    peekToken(ts, { purpose: 'player_invite', secret: expired }).error === 'TOKEN_EXPIRED',
    'expired invite token refused',
  );
}

done();
