// M14.1 adversarial suite — hardening-pass regression/abuse tests.
// Every finding from the independent architectural review gets negative
// tests proving the fix: root identity linking, licence assurance,
// removed-account suppression, invite recipient binding, evidence content
// signatures, identity provenance, reviewer attribution, authority
// revocation semantics and effective dashboard counts.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evidenceFileProblem, sniffFileSignature, toPublicVerificationProfile,
  assuranceForClaim, claimProvenanceLabel, mintToken, consumeToken, peekToken,
} from '../m14/shared.mjs';

const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m141-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_FAST_RETRY: '1', M13_QUIET_LOGS: '1', TEST_LICENCE_REGISTRY: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
{
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extraHeaders = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
const REV = { ...A, 'x-admin-reviewer-id': 'rev-ana', 'x-admin-reviewer-name': 'Ana Blake', 'x-request-id': 'req-m141-attr' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (s) => Buffer.from(s).toString('base64');
async function mailWith(to, re) {
  const r = await j('GET', '/admin/outbox', undefined, null, A);
  const mail = (r.body ?? []).find((m) => m.to === to);
  return mail ? (mail.text.match(re) ?? [])[1] ?? null : null;
}
const applyCode = (to) => mailWith(to, /code is ([A-Za-z0-9_-]{8,})/);
const inviteCode = (to) => mailWith(to, /Invitation code: ([A-Za-z0-9_-]{8,})/);

// ============================== U — unit fixtures (pure, no server needed)
section('U1 — evidence content signatures: bytes must BE the claimed format');
{
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  ok(sniffFileSignature(png) === 'image/png', 'real PNG bytes sniff as PNG');
  ok(evidenceFileProblem({ mime: 'image/png', bytes: png.length, filename: 'ok.png', buffer: png }) === null, 'genuine PNG accepted');
  const exe = Buffer.concat([Buffer.from('MZ\x90\x00\x03'), Buffer.alloc(64)]);
  ok(evidenceFileProblem({ mime: 'image/png', bytes: exe.length, filename: 'x.png', buffer: exe }) === 'FILE_CONTENT_UNRECOGNISED', 'executable bytes labelled image/png rejected');
  const html = Buffer.from('<!doctype html><script>alert(1)</script><p>padding padding</p>');
  ok(evidenceFileProblem({ mime: 'application/pdf', bytes: html.length, filename: 'doc.pdf', buffer: html }) === 'FILE_CONTENT_UNRECOGNISED', 'HTML labelled application/pdf rejected');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>');
  ok(evidenceFileProblem({ mime: 'image/png', bytes: svg.length, filename: 'img.png', buffer: svg }) === 'FILE_CONTENT_UNRECOGNISED', 'SVG/script content renamed .png rejected');
  const pdfBytesAsPng = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]);
  ok(evidenceFileProblem({ mime: 'image/png', bytes: pdfBytesAsPng.length, filename: 'img.png', buffer: pdfBytesAsPng }) === 'FILE_SIGNATURE_MISMATCH', 'valid PDF bytes under an image/png label = signature mismatch');
  ok(evidenceFileProblem({ mime: 'application/pdf', bytes: 4, filename: 'a.pdf', buffer: Buffer.from('%PDF') }) === 'FILE_CONTENT_UNRECOGNISED', 'truncated/malformed payload rejected');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  ok(sniffFileSignature(jpeg) === 'image/jpeg' && sniffFileSignature(webp) === 'image/webp', 'JPEG and WebP signatures recognised');
  ok(evidenceFileProblem({ mime: 'application/pdf', bytes: 1000, filename: 'no-buffer.pdf' }) === null, 'metadata-only validation still works where no bytes are in play');
}

section('U2 — assurance semantics: the projector is provenance-sensitive');
{
  const org = { id: 'o1', name: 'Testchester FC', suspended: false, verification: { revokedAt: null } };
  const lic = (method) => ({ id: 'c', subjectType: 'user', subjectId: 'u1', claimType: 'LICENCE', organisationId: null, status: 'verified', current: true, validFrom: 1, validUntil: null, verificationMethod: method, verifiedAt: 5, metadata: { licenceType: 'UEFA A Licence' }, evidenceIds: [] });
  ok(assuranceForClaim(lic('authoritative_registry')) === 'authoritative', 'registry match → authoritative');
  ok(assuranceForClaim(lic('scoutbox_manual_review')) === 'scoutbox_document_review', 'manual review → scoutbox_document_review');
  ok(assuranceForClaim(lic('organisation_admin_confirmation')) === 'organisation_attested', 'org confirmation → organisation_attested');
  const pReg = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [lic('authoritative_registry')] });
  ok(pReg.badges[0].label === 'Licence verified: UEFA A Licence' && pReg.badges[0].assurance === 'authoritative', 'authoritative source MAY say "Licence verified"');
  const pMan = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [lic('scoutbox_manual_review')] });
  ok(pMan.badges[0].label === 'Credential reviewed: UEFA A Licence', 'document review NEVER says "Licence verified" — it says "Credential reviewed"');
  ok(pMan.badges[0].provenance.includes('not independently confirmed with the issuing authority'), 'document-review provenance names the limitation explicitly');
  ok(claimProvenanceLabel(lic('scoutbox_manual_review'))
    === 'Document reviewed by ScoutBox Trust & Safety — not independently confirmed with the issuing authority.', 'licence provenance override exact');
  const pending = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [{ ...lic('document_submitted'), status: 'pending' }] });
  ok(pending.badges.length === 0, 'document upload alone → NO licence badge of any kind');
}

section('U3 — identity provenance: structured, method-distinguishing, no evidence');
{
  const idc = (method, status = 'verified') => ({ id: 'i', subjectType: 'user', subjectId: 'u1', claimType: 'PERSON_IDENTITY', organisationId: null, status, current: true, validFrom: 1, validUntil: null, verificationMethod: method, verifiedAt: 9, metadata: {}, evidenceIds: ['ev-secret'] });
  const man = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [idc('scoutbox_manual_review')] });
  ok(man.identity?.confirmed === true && man.identity.assurance === 'scoutbox_document_review', 'manual identity review → confirmed with scoutbox_document_review assurance');
  ok(man.identity.label === 'Identity confirmed by ScoutBox review' && man.identityVerified === true, 'label + compatibility boolean agree');
  const auth = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [idc('authoritative_registry')] });
  ok(auth.identity?.assurance === 'authoritative' && auth.identity.label === 'Identity confirmed by an authoritative provider', 'a (future/test) authoritative identity method is DISTINGUISHABLE from document review');
  ok(toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [idc('document_submitted', 'pending')] }).identity === null, 'pending identity exposes nothing');
  ok(toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [{ ...idc('scoutbox_manual_review'), status: 'revoked', current: false }] }).identity === null, 'revoked identity exposes nothing');
  const s = JSON.stringify([man, auth]);
  ok(!s.includes('ev-secret') && !s.includes('evidenceIds'), 'identity projection never leaks evidence');
}

section('U4 — subjectRemoved + peekToken primitives');
{
  const org = { id: 'o1', name: 'X', suspended: false, verification: { revokedAt: null } };
  const cur = { id: 'c', subjectType: 'user', subjectId: 'u1', claimType: 'CLUB_ROLE', organisationId: 'o1', status: 'verified', current: true, validFrom: 1, validUntil: null, verificationMethod: 'organisation_admin_confirmation', verifiedAt: 2, role: 'Scout', metadata: {}, evidenceIds: [] };
  const hist = { ...cur, id: 'h', current: false, validUntil: 99 };
  const alive = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [cur, hist], orgsById: new Map([['o1', org]]) });
  const removed = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims: [cur, hist], orgsById: new Map([['o1', org]]), subjectRemoved: true });
  ok(alive.badges.some((b) => b.current), 'active account: current badge displays');
  ok(!removed.badges.some((b) => b.current), 'subjectRemoved: NO current badge survives the projector');
  ok(removed.badges.some((b) => b.historical), 'closed historical periods remain as history (policy: truth preserved)');
  const fdb = { verTokens: [] };
  const nid = (() => { let n = 0; return (p) => `${p}-${++n}`; })();
  const secret = mintToken(fdb, nid, { purpose: 'player_invite', subjectId: 'alice' });
  ok(peekToken(fdb, { purpose: 'player_invite', secret }).token && !fdb.verTokens[0].usedAt, 'peek validates WITHOUT consuming');
  ok(peekToken(fdb, { purpose: 'player_invite', secret, subjectId: 'bob' }).error === 'TOKEN_WRONG_ACCOUNT', 'peek enforces subject binding');
  ok(consumeToken(fdb, { purpose: 'player_invite', secret, subjectId: 'alice' }).token && fdb.verTokens[0].usedAt, 'consume marks used on success');
  const expired = mintToken(fdb, nid, { purpose: 'player_invite', ttlMs: -1 });
  ok(peekToken(fdb, { purpose: 'player_invite', secret: expired }).error === 'TOKEN_EXPIRED', 'expired invite token refused');
}

// ====================================================== HTTP scenarios
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'Scout');
const sam = await login('org-eastport', 'Sam Cole', 'Coach');
const rita = await login('org-eastport', 'Rita Vale', 'Scout');
const uma = await login('org-eastport', 'Uma Patel', 'Analyst');
const eve = await login('org-eastport', 'Eve Adams', 'Analyst');
const bea = await login('org-eastport', 'Bea Long', 'Winger');
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const adeyemi = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, tom, sam, rita, uma, eve, bea, alex, adeyemi, amara].every((a) => a?.token), 'all actors logged in');
await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'M14.1 suite: migrated club root admin' }, null, A);

// Helper: full affiliation flow for one user, decided by maria.
async function verifyAffiliation(actor, role, emailLocal, decideBody = { action: 'confirm' }) {
  const aff = await j('POST', '/org/verification/affiliation', { role }, actor.token);
  const affId = aff.body.affiliation.id;
  await j('POST', '/org/verification/work-email', { email: `${emailLocal}@eastportfc.com` }, actor.token);
  const code = await mailWith(`${emailLocal}@eastportfc.com`, /code is ([A-Za-z0-9_-]{8,})/);
  await j('POST', '/org/verification/work-email/confirm', { code }, actor.token);
  const d = await j('POST', `/org/verification/requests/${affId}/decide`, decideBody, maria.token);
  return { affId, decide: d };
}

section('H1 — root approval: identity is NEVER linked by name');
let provisionedSamId;
{
  // The org name as the server knows it (needed for the duplicate-org match).
  const pub = await j('GET', '/org/verification/public/org/org-eastport', undefined, maria.token);
  const orgName = pub.body.badges.find((b) => b.claimType === 'ORGANISATION_IDENTITY')?.organisation?.name;
  ok(!!orgName, 'org display name resolved from the public projection');

  const applyFor = async (applicantName, workEmail) => {
    const r = await j('POST', '/auth/org/verification/apply', {
      orgName, orgType: 'professional club', country: 'GB', website: 'https://www.eastportfc.com',
      domain: 'eastport-mail.co', applicantName, applicantRole: 'Secretary', workEmail,
    });
    const { requestId, applicantSecret } = r.body;
    const code = await applyCode(workEmail);
    await j('POST', `/auth/org/verification/apply/${requestId}/confirm-email`, { applicantSecret, code });
    await j('POST', `/auth/org/verification/apply/${requestId}/evidence`, { applicantSecret, dataUrl: PNG, filename: 'letterhead.png', note: 'club letterhead' });
    await j('POST', `/auth/org/verification/apply/${requestId}/submit`, { applicantSecret });
    return requestId;
  };

  // Applicant shares a NAME with existing employee Sam Cole but proves a
  // DIFFERENT mailbox. Approval must refuse to guess.
  const req1 = await applyFor('Sam Cole', 'sam.cole@eastport-mail.co');
  let r = await j('POST', `/admin/verification/root-requests/${req1}/approve`, { reason: 'looks legitimate' }, null, A);
  ok(r.status === 409 && r.body.error === 'AMBIGUOUS_APPLICANT_IDENTITY', 'same name as an existing employee → approval REFUSES to auto-link');
  ok(r.body.candidates.some((c) => c.id === sam.userId && c.matched === 'name_similarity_only'), 'the name match is surfaced as a review candidate only');
  r = await j('POST', `/admin/verification/root-requests/${req1}/approve`, { reason: 'x', linkUserId: 'usr-does-not-exist' }, null, A);
  ok(r.status === 404 && r.body.error === 'LINK_USER_NOT_FOUND', 'explicit selection of a non-existent account refused');
  r = await j('POST', `/admin/verification/root-requests/${req1}/approve`, { reason: 'new person, provisioned deliberately', provisionNewUser: true }, null, REV);
  ok(r.status === 200 && r.body.identityLink === 'provisioned_new_user', 'T&S explicitly provisions a NEW account instead of guessing');
  provisionedSamId = r.body.rootAdminUserId;
  ok(provisionedSamId && provisionedSamId !== sam.userId, 'the wrong (name-matched) account received NO root authority');
  ok(r.body.request.decidedBy === 'Ana Blake' && r.body.request.decidedById === 'rev-ana', 'root decision attributed to the declared reviewer');
  const admins = await j('GET', '/org/verification/admins', undefined, maria.token);
  ok(!admins.body.items.some((a) => a.userId === sam.userId), 'employee Sam Cole holds no verification authority whatsoever');
  const dash = await j('GET', '/org/verification/dashboard', undefined, sam.token);
  ok(dash.status === 403, 'name-matched employee cannot even view the verification console');

  // Exact verified-email match: the SAME mailbox re-applies → links to the
  // provisioned account, not to employee Sam Cole.
  const req2 = await applyFor('Sam Cole', 'sam.cole@eastport-mail.co');
  r = await j('POST', `/admin/verification/root-requests/${req2}/approve`, { reason: 'email re-proved; same person' }, null, A);
  ok(r.status === 200 && r.body.identityLink === 'verified_work_email', 'exact verified work-email match links authoritatively');
  ok(r.body.rootAdminUserId === provisionedSamId, 'email linkage selects the CORRECT account (never the name-matched one)');

  // Explicit T&S selection.
  const req3 = await applyFor('R. Vale', 'admin.office@eastport-mail.co');
  r = await j('POST', `/admin/verification/root-requests/${req3}/approve`, { reason: 'confirmed by phone with the club office', linkUserId: bea.userId }, null, A);
  ok(r.status === 200 && r.body.identityLink === 'trust_safety_selection' && r.body.rootAdminUserId === bea.userId, 'ambiguity resolved only by explicit human account selection');
}

section('H2+H5 — licence assurance over HTTP + reviewer attribution');
{
  // (a) Document-only → manual T&S review → "Credential reviewed", never "Licence verified".
  let r = await j('POST', '/org/verification/licence', { licenceType: 'UEFA A Licence', issuer: 'UEFA', identifier: 'NO-MATCH-XX', holderName: 'Rita Vale', dataUrl: PNG, filename: 'licence.png' }, rita.token);
  const ritaLic = r.body.claim.id;
  r = await j('POST', `/org/verification/licence/${ritaLic}/submit`, { providerId: 'local-test-registry' }, rita.token);
  ok(r.body.provider.result === 'no_match' && r.body.claim.status === 'requires_human_review', 'no registry match → human review, nothing verified');
  r = await j('POST', `/admin/verification/claims/${ritaLic}/approve`, { reason: 'document layout, hologram and issuer fields consistent' }, null, REV);
  ok(r.status === 200 && r.body.claim.verificationMethod === 'scoutbox_manual_review', 'T&S approves as a DOCUMENT REVIEW');
  const ritaPub = await j('GET', `/org/verification/public/user/${rita.userId}`, undefined, alex.token);
  const licBadge = ritaPub.body.badges.find((b) => b.kind === 'licence');
  ok(licBadge?.label === 'Credential reviewed: UEFA A Licence', 'public label: "Credential reviewed" — NOT "Licence verified"');
  ok(licBadge.assurance === 'scoutbox_document_review', 'public assurance level says exactly who stands behind it');
  ok(licBadge.provenance.includes('not independently confirmed with the issuing authority'), 'public provenance carries the honest limitation');
  ok(!JSON.stringify(ritaPub.body).includes('Licence verified'), 'nothing in the public profile upgrades a document review to a verified licence');
  // Attribution on the decision event:
  const caseView = await j('GET', `/admin/verification/cases/${ritaLic}`, undefined, null, A);
  const approvedEvt = caseView.body.events.findLast((e) => e.type === 'review.approved');
  ok(approvedEvt.actorId === 'rev-ana' && approvedEvt.actorName === 'Ana Blake' && approvedEvt.attribution === 'declared_reviewer', 'decision event names the declared reviewer');
  ok(approvedEvt.requestId === 'req-m141-attr', 'decision event carries the correlation/request id');

  // (b) Authoritative registry match keeps the strong label.
  r = await j('POST', '/org/verification/licence', { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'UEFA-B-77777', holderName: 'Sam Cole' }, sam.token);
  const samLic = r.body.claim.id;
  r = await j('POST', `/org/verification/licence/${samLic}/submit`, { providerId: 'local-test-registry' }, sam.token);
  ok(r.body.provider.result === 'match' && r.body.claim.display === 'Licence verified: UEFA B Licence', 'exact registry match → authoritative verification');
  const samPub = await j('GET', `/org/verification/public/user/${sam.userId}`, undefined, alex.token);
  const samBadge = samPub.body.badges.find((b) => b.kind === 'licence');
  ok(samBadge?.label === 'Licence verified: UEFA B Licence' && samBadge.assurance === 'authoritative', 'authoritative badge says "Licence verified" with authoritative assurance');

  // (c) Ambiguous never becomes authoritative — and an undeclared reviewer is honest.
  r = await j('POST', '/org/verification/licence', { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'AMBIG-001', holderName: 'Alex Taylor' }, uma.token);
  const umaLic = r.body.claim.id;
  r = await j('POST', `/org/verification/licence/${umaLic}/submit`, { providerId: 'local-test-registry' }, uma.token);
  ok(r.body.provider.result === 'ambiguous' && r.body.claim.status === 'requires_human_review', 'ambiguous registry result → human, never a guess');
  r = await j('POST', `/admin/verification/claims/${umaLic}/approve`, { reason: 'holder disambiguated by issue year on the document' }, null, A);
  ok(r.body.claim.verificationMethod === 'scoutbox_manual_review', 'ambiguous resolution is a document review, not registry verification');
  const umaPub = await j('GET', `/org/verification/public/user/${uma.userId}`, undefined, alex.token);
  ok(umaPub.body.badges.find((b) => b.kind === 'licence')?.assurance === 'scoutbox_document_review', 'ambiguous case never renders authoritative');
  const umaCase = await j('GET', `/admin/verification/cases/${umaLic}`, undefined, null, A);
  const evt2 = umaCase.body.events.findLast((e) => e.type === 'review.approved');
  ok(evt2.actorId === 'admin' && evt2.attribution === 'shared_admin_key', 'no declared reviewer → event honestly says shared_admin_key, no invented person');
}

section('H3 — spoofed evidence over HTTP');
{
  await j('POST', '/org/verification/identity', {}, tom.token);
  const idClaim = (await j('GET', '/org/verification/me', undefined, tom.token)).body.claims.find((c) => c.claimType === 'PERSON_IDENTITY');
  let r = await j('POST', `/org/verification/claims/${idClaim.id}/evidence`, { dataUrl: `data:application/pdf;base64,${b64('<!doctype html><h1>fake passport</h1>')}`, filename: 'passport.pdf' }, tom.token);
  ok(r.status === 422 && r.body.error === 'FILE_CONTENT_UNRECOGNISED', 'HTML bytes labelled application/pdf rejected at upload');
  r = await j('POST', `/org/verification/claims/${idClaim.id}/evidence`, { dataUrl: `data:image/png;base64,${b64('%PDF-1.7 not actually a png padockpad')}`, filename: 'scan.png' }, tom.token);
  ok(r.status === 422 && r.body.error === 'FILE_SIGNATURE_MISMATCH', 'PDF bytes labelled image/png rejected (signature mismatch)');
  r = await j('POST', `/org/verification/claims/${idClaim.id}/evidence`, { dataUrl: PNG, filename: 'passport.png' }, tom.token);
  ok(r.status === 201 && r.body.evidenceChecks.malwareScan === 'not_configured' && r.body.evidenceChecks.contentSignature === 'matched_claimed_type', 'genuine bytes accepted; malware scan honestly not_configured; signature check honestly named');
}

section('H4 — removed accounts lose current public verification immediately');
{
  await verifyAffiliation(tom, 'Academy Scout', 'tom.field');
  let pub = await j('GET', `/org/verification/public/user/${tom.userId}`, undefined, alex.token);
  ok(pub.body.badges.some((b) => b.current), 'current verified scout is publicly displayable');
  const dashBefore = (await j('GET', '/org/verification/dashboard', undefined, maria.token)).body.counts.verifiedStaff;
  // Historical case prepared before removal:
  await verifyAffiliation(eve, 'Analyst', 'eve.adams', { action: 'mark_former', validUntil: Date.now() });
  let evePub = await j('GET', `/org/verification/public/user/${eve.userId}`, undefined, alex.token);
  ok(evePub.body.badges.some((b) => b.historical) && !evePub.body.badges.some((b) => b.current), 'closed period reads as history');
  // Remove both accounts (existing M12 structural removal).
  let r = await j('POST', `/org/staff/${tom.userId}/remove`, {}, maria.token);
  ok(r.status === 200, 'account removed via the existing staff-removal route');
  await j('POST', `/org/staff/${eve.userId}/remove`, {}, maria.token);
  pub = await j('GET', `/org/verification/public/user/${tom.userId}`, undefined, alex.token);
  ok(!pub.body.badges.some((b) => b.current), 'NEXT public read: current verification suppressed — no deploy, no sweep, no cache');
  const batch = await j('GET', `/org/verification/public/users?ids=${tom.userId}`, undefined, alex.token);
  ok(!batch.body.profiles[0].badges.some((b) => b.current), 'batch projection path agrees — no stale cached boolean anywhere');
  evePub = await j('GET', `/org/verification/public/user/${eve.userId}`, undefined, alex.token);
  ok(evePub.body.badges.some((b) => b.historical), 'removal preserves closed HISTORICAL periods (audit/truth policy)');
  const dashAfter = (await j('GET', '/org/verification/dashboard', undefined, maria.token)).body.counts.verifiedStaff;
  ok(dashAfter === dashBefore - 1, 'dashboard "currently verified" derives from the effective engine (removed user no longer counted)');
  r = await j('POST', `/org/staff/${tom.userId}/remove`, {}, maria.token);
  ok(r.status === 409, 'no restoration side-channel: repeat removal conflicts; reinstatement is an explicit (T&S-level) act, not an API default');
}

section('H5 — invitation tokens are recipient-bound');
{
  const bobSignup = await j('POST', '/auth/player/signup', { name: 'Bob Forward', dob: '1995-05-05', country: 'GB', position: 'ST', password: 'longenough1' });
  const bob = bobSignup.body?.token ? bobSignup.body : (await j('POST', '/auth/player/login', { playerId: bobSignup.body.playerId })).body;
  ok(bob?.token, 'second adult player exists');

  // (a) identity-bound invite: only the named player may accept.
  let inv = await j('POST', '/org/verification/player-invites', { name: 'Kola Adeyemi', playerId: 'pl-adeyemi' }, maria.token);
  ok(inv.status === 201 && inv.body.invite.targetPlayerId === 'pl-adeyemi', 'invite minted bound to an existing ScoutBox identity');
  let r = await j('POST', '/player/invites/accept', { code: inv.body.code }, bob.token);
  ok(r.status === 403 && r.body.error === 'INVITE_RECIPIENT_MISMATCH', 'forwarded code: Bob CANNOT accept Alice’s invitation');
  r = await j('POST', '/player/invites/accept', { code: inv.body.code }, adeyemi.token);
  ok(r.status === 200, 'rightful recipient still succeeds — the failed attempt did not burn the token');
  r = await j('POST', '/player/invites/accept', { code: inv.body.code }, adeyemi.token);
  ok(r.status === 404 && r.body.error === 'TOKEN_ALREADY_USED', 'replay after acceptance fails');

  // (b) child-bound invite: exactly that child, via the EXISTING guardianship.
  const dobY = (y) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); d.setDate(d.getDate() + 10); return d.toISOString().slice(0, 10); };
  const kidA = (await j('POST', '/guardian/children', { name: 'Noor A', dob: dobY(18), position: 'CM', foot: 'right', lat: 51.5, lng: -0.06 }, amara.token)).body?.player;
  const kidB = (await j('POST', '/guardian/children', { name: 'Zaid B', dob: dobY(17), position: 'GK', foot: 'left', lat: 51.5, lng: -0.06 }, amara.token)).body?.player;
  ok(kidA?.id && kidB?.id, 'guardian has two children (existing guardianship flow)');
  inv = await j('POST', '/org/verification/player-invites', { name: 'Noor A', playerId: kidA.id }, maria.token);
  r = await j('POST', '/guardian/invites/accept', { code: inv.body.code, childId: kidB.id }, amara.token);
  ok(r.status === 403 && r.body.error === 'INVITE_RECIPIENT_MISMATCH', 'one child’s invitation cannot be applied to another child');
  r = await j('POST', '/guardian/invites/accept', { code: inv.body.code, childId: kidA.id }, amara.token);
  ok(r.status === 200 && r.body.invite.guardianApproved, 'rightful guardian flow succeeds for the named child');

  // (c) email-bound invites.
  const amaraEmail = (await j('GET', '/guardian/me', undefined, amara.token)).body?.email;
  ok(!!amaraEmail, 'guardian account email known');
  inv = await j('POST', '/org/verification/player-invites', { name: 'Zaid B', email: 'some.other.parent@example.org' }, maria.token);
  const wrongGuardianCode = await inviteCode('some.other.parent@example.org');
  r = await j('POST', '/guardian/invites/accept', { code: wrongGuardianCode, childId: kidB.id }, amara.token);
  ok(r.status === 403 && r.body.error === 'INVITE_RECIPIENT_MISMATCH', 'guardian invite addressed to a DIFFERENT guardian email is refused');
  inv = await j('POST', '/org/verification/player-invites', { name: 'Zaid B', email: amaraEmail }, maria.token);
  const rightGuardianCode = await inviteCode(amaraEmail);
  r = await j('POST', '/guardian/invites/accept', { code: rightGuardianCode, childId: kidB.id }, amara.token);
  ok(r.status === 200, 'guardian invite to the guardian’s own verified email succeeds');
  inv = await j('POST', '/org/verification/player-invites', { name: 'Bob Forward', email: 'bob.forward@example.org' }, maria.token);
  const bobCode = await inviteCode('bob.forward@example.org');
  r = await j('POST', '/player/invites/accept', { code: bobCode }, bob.token);
  ok(r.status === 403 && r.body.error === 'INVITE_RECIPIENT_MISMATCH', 'adult email invite: code possession alone is NOT acceptance');
  r = await j('POST', '/player/invites/accept', { code: bobCode, email: 'wrong@example.org' }, bob.token);
  ok(r.status === 403, 'wrong recipient-address confirmation refused');
  r = await j('POST', '/player/invites/accept', { code: bobCode, email: 'bob.forward@example.org' }, bob.token);
  ok(r.status === 200, 'rightful adult recipient (address + code) succeeds');
}

section('H6 — authority revocation: new approvals stop, provenance survives');
{
  let r = await j('POST', '/org/verification/admins', { userId: rita.userId, level: 'verification_reviewer' }, maria.token);
  const ritaAdminRow = r.body.admin?.id;
  ok(r.status === 201, 'root admin grants rita reviewer authority');
  // rita approves uma's affiliation:
  const aff = await j('POST', '/org/verification/affiliation', { role: 'Performance Analyst' }, uma.token);
  const umaAff = aff.body.affiliation.id;
  await j('POST', '/org/verification/work-email', { email: 'uma.patel@eastportfc.com' }, uma.token);
  const code = await mailWith('uma.patel@eastportfc.com', /code is ([A-Za-z0-9_-]{8,})/);
  await j('POST', '/org/verification/work-email/confirm', { code }, uma.token);
  r = await j('POST', `/org/verification/requests/${umaAff}/decide`, { action: 'confirm' }, rita.token);
  ok(r.status === 200, 'reviewer approves a colleague’s affiliation');
  // Revoke rita's authority; prepare a second pending claim:
  const aff2 = await j('POST', '/org/verification/affiliation', { role: 'Set-piece Coach' }, bea.token);
  const beaAff = aff2.body.affiliation.id;
  await j('POST', '/org/verification/work-email', { email: 'bea.long@eastportfc.com' }, bea.token);
  const code2 = await mailWith('bea.long@eastportfc.com', /code is ([A-Za-z0-9_-]{8,})/);
  await j('POST', '/org/verification/work-email/confirm', { code: code2 }, bea.token);
  r = await j('POST', `/org/verification/admins/${ritaAdminRow}/revoke`, { reason: 'left the verification team' }, maria.token);
  ok(r.status === 200, 'authority revoked');
  r = await j('POST', `/org/verification/requests/${beaAff}/decide`, { action: 'confirm' }, rita.token);
  ok(r.status === 403 && r.body.error === 'VERIFICATION_PERMISSION_REQUIRED', 'revoked authority can approve NOTHING new');
  const caseView = await j('GET', `/admin/verification/cases/${umaAff}`, undefined, null, A);
  ok(caseView.body.claim.status === 'verified' && caseView.body.claim.authorityId === rita.userId, 'previously approved claim keeps status AND provenance (no silent destruction)');
  const cascade = await j('GET', `/admin/verification/authorities/${rita.userId}/claims`, undefined, null, A);
  ok(cascade.body.items.some((c) => c.id === umaAff), 'dependent claims are enumerable for policy-driven review');
}

section('H7 — dashboard counts follow the effective engine');
{
  const zed = await login('org-eastport', 'Zed Temporary', 'Scout');
  const before = (await j('GET', '/org/verification/dashboard', undefined, maria.token)).body.counts.verifiedStaff;
  await verifyAffiliation(zed, 'Loan Scout', 'zed.temp', { action: 'confirm', validUntil: Date.now() + 1500 });
  let dash = await j('GET', '/org/verification/dashboard', undefined, maria.token);
  ok(dash.body.counts.verifiedStaff === before + 1, 'freshly confirmed staff counted while effective');
  await sleep(2600); // fast-retry sweep expires the claim
  dash = await j('GET', '/org/verification/dashboard', undefined, maria.token);
  ok(dash.body.counts.verifiedStaff === before, 'expired claim leaves the "currently verified" count');
  // Organisation suspension suppresses staff badges publicly at read time:
  const umaBefore = await j('GET', `/org/verification/public/user/${uma.userId}`, undefined, alex.token);
  ok(umaBefore.body.badges.some((b) => b.organisation?.id === 'org-eastport' && b.current), 'staff badge shows while the organisation is in good standing');
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, null, A);
  const umaSusp = await j('GET', `/org/verification/public/user/${uma.userId}`, undefined, alex.token);
  ok(!umaSusp.body.badges.some((b) => b.organisation?.id === 'org-eastport' && b.current), 'suspending the organisation suppresses its staff badges on the next read');
  ok(umaSusp.body.badges.some((b) => b.kind === 'licence' && b.current), 'org-independent credentials are untouched by the org suspension (claims stay independent)');
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, null, A);
  const umaBack = await j('GET', `/org/verification/public/user/${uma.userId}`, undefined, alex.token);
  ok(umaBack.body.badges.some((b) => b.organisation?.id === 'org-eastport' && b.current), 'lifting the suspension restores display — nothing was destroyed');
}

console.log(`\nM14.1 adversarial suite: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
process.exit(process.exitCode ?? 0);
