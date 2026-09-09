// M14 acceptance suite — Verification & Trust.
// Spawns its own server on an ISOLATED throwaway database, runs unit fixtures
// against the pure helpers (state machine, effective engine, decision engine,
// tokens, projector), then drives journeys V1–V18 and the eighteen security
// audit cases over HTTP. Well over a third of the checks are negative/abuse
// tests with exact status codes.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTransition, canTransition, effectiveStatus, decideReview, riskFlags,
  emailProblem, domainOfEmail, isFreeMail, isDisposable, domainCovered,
  normalizeDomain, evidenceFileProblem, evidenceCompleteness, mintToken,
  consumeToken, toPublicVerificationProfile, verLevelFor, orgVerificationStatus,
} from '../m14/shared.mjs';
import { totp } from '../m13/shared.mjs';

const PORT = 4600 + Math.floor(Math.random() * 300);
const DOWN_PORT = PORT + 300;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m14-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_FAST_RETRY: '1', M13_QUIET_LOGS: '1', TEST_LICENCE_REGISTRY: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function startServer(port = PORT, dataDir = DATA_DIR, extraEnv = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...ENV, PORT: String(port), DATA_DIR: dataDir, ...extraEnv }, stdio: 'ignore' });
  children.push(proc);
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://localhost:${port}/healthz`); if (r.ok) return proc; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error(`server on :${port} did not come up`);
}
async function jAt(base, method, url, body, token, extraHeaders = {}) {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const j = (method, url, body, token, extra) => jAt(BASE, method, url, body, token, extra);
const A = { 'x-admin-key': 'scoutbox-admin' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function outboxCode(to) {
  const r = await j('GET', '/admin/outbox', undefined, null, A);
  const mail = (r.body ?? []).find((m) => m.to === to);
  return mail ? (mail.text.match(/code (?:is|for[^:]*:) ?([A-Za-z0-9_-]{8,})/) ?? [])[1] ?? null : null;
}

// ====================================================== 0. unit fixtures
section('unit fixtures — state machine');
{
  const mk = (status, extra = {}) => ({ id: 'c1', subjectType: 'user', subjectId: 'u1', claimType: 'CLUB_ROLE', organisationId: 'o1', status, current: true, validFrom: null, validUntil: null, verificationMethod: null, metadata: {}, riskFlags: [], reviewReasons: [], evidenceIds: [], ...extra });
  ok(canTransition('pending', 'automated_checks_passed') && !canTransition('pending', 'verified'), 'pending can never jump straight to verified');
  ok(!canTransition('unverified', 'verified') && !canTransition('collecting_evidence', 'verified'), 'no path from evidence collection directly to verified');
  const c1 = mk('automated_checks_passed');
  ok(applyTransition(c1, 'verified', { method: 'document_submitted', actorKind: 'org_admin' }) === 'METHOD_NOT_AUTHORITATIVE', 'document_submitted can NEVER produce a verified claim');
  ok(c1.status === 'automated_checks_passed', 'failed transition mutates nothing');
  const c2 = mk('automated_checks_passed', { claimType: 'ORGANISATION_IDENTITY' });
  ok(applyTransition(c2, 'verified', { method: 'official_domain_email', actorKind: 'system' }) === 'DOMAIN_CONTROL_INSUFFICIENT', 'domain-email control alone cannot verify ORGANISATION_IDENTITY (security case 17)');
  const c3 = mk('automated_checks_passed', { claimType: 'ORGANISATION_DOMAIN' });
  ok(applyTransition(c3, 'verified', { method: 'official_domain_email', actorKind: 'system' }) === null && c3.status === 'verified', 'official_domain_email verifies exactly the DOMAIN claim');
  const c4 = mk('verified', { verificationMethod: 'organisation_admin_confirmation', verifiedAt: 1 });
  ok(applyTransition(c4, 'revoked', {}) === 'REASON_REQUIRED', 'revocation without a reason is refused');
  ok(applyTransition(c4, 'revoked', { reason: 'left club', actorKind: 'org_admin', actorId: 'a1' }) === null && c4.current === false, 'revocation records reason and ends currency');
  ok(applyTransition(c4, 'verified', { method: 'organisation_admin_confirmation', actorKind: 'trust_safety' }) === null, 'reinstatement from revoked is possible (policy-gated at the route)');
  ok(applyTransition(mk('rejected'), 'verified', { method: 'scoutbox_manual_review' }) === 'ILLEGAL_TRANSITION', 'rejected is terminal — resubmission is a NEW claim');
  const c5 = mk('verified', { verificationMethod: 'organisation_admin_confirmation' });
  ok(applyTransition(c5, 'verified', {}) === 'ALREADY_IN_STATE', 'idempotent: same-state transition is rejected predictably');
}

section('unit fixtures — effective engine (read-time truth)');
{
  const base = { status: 'verified', current: true, validFrom: 1, validUntil: null, organisationId: 'o1', verificationMethod: 'organisation_admin_confirmation' };
  const okOrg = { id: 'o1', suspended: false, verification: { revokedAt: null } };
  ok(effectiveStatus({ ...base }, { org: okOrg }).displayable === true, 'verified + eligible org displays');
  ok(effectiveStatus({ ...base, validUntil: Date.now() - 1000 }, { org: okOrg }).status === 'expired', 'validUntil in the past reads as expired regardless of stored status');
  ok(effectiveStatus({ ...base }, { org: { ...okOrg, suspended: true } }).displayable === false, 'suspended organisation suppresses the badge at read time');
  ok(effectiveStatus({ ...base }, { org: { ...okOrg, verification: { revokedAt: 5 } } }).displayable === false, 'revoked organisation suppresses the badge');
  const hist = effectiveStatus({ ...base, current: false, validUntil: Date.now() + 10 }, { org: okOrg });
  ok(hist.displayable === true && hist.historical === true && hist.current === false, 'closed period stays displayable as HISTORY (security case 15: never as current)');
  ok(effectiveStatus({ ...base, current: false, validUntil: 99 }, { org: { ...okOrg, verification: { revokedAt: 5 } } }).displayable === false, 'a fraud-revoked organisation stops lending even historical badges');
}

section('unit fixtures — deterministic decision engine + risk flags');
{
  const d1 = decideReview({ claimType: 'ORGANISATION_IDENTITY', isFirstOrgAdmin: true });
  ok(d1.decision === 'REQUIRES_HUMAN_REVIEW' && d1.reasons.includes('ROOT_ORGANISATION_BOOTSTRAP'), 'first org admin ALWAYS requires human review');
  ok(decideReview({ claimType: 'CLUB_ROLE', orgHasActiveAuthority: true }).decision === 'CAN_AUTO_COMPLETE', 'affiliation with an active org authority routes to the ORG, not to T&S');
  const d2 = decideReview({ claimType: 'CLUB_ROLE', orgHasActiveAuthority: false });
  ok(d2.decision === 'REQUIRES_HUMAN_REVIEW' && d2.reasons.includes('NO_AUTHORITATIVE_SOURCE'), 'no authoritative source → human review with the exact reason code');
  ok(decideReview({ claimType: 'LICENCE', documentOnly: true, orgHasActiveAuthority: true }).reasons.includes('DOCUMENT_AUTHENTICITY_UNCONFIRMED'), 'document-only licence never auto-completes');
  ok(decideReview({ claimType: 'LICENCE', documentOnly: true, registryResult: 'match', orgHasActiveAuthority: true }).decision === 'CAN_AUTO_COMPLETE', 'a registry MATCH is the authoritative exception');
  ok(decideReview({ claimType: 'CLUB_ROLE', orgHasActiveAuthority: true, registryResult: 'ambiguous' }).reasons.includes('REGISTRY_AMBIGUOUS_MATCH'), 'ambiguous registry result forces a human');
  const rf = riskFlags({ email: 'x@mailinator.com', orgDomains: ['club.com'], actorIsSubject: true });
  ok(rf.includes('DISPOSABLE_EMAIL') && rf.includes('ORG_DOMAIN_MISMATCH') && rf.includes('SELF_VERIFICATION_ATTEMPT'), 'risk flags are deterministic signals');
  ok(riskFlags({ email: 'a@gmail.com' }).includes('FREE_EMAIL_PROVIDER') && !riskFlags({ email: 'a@chelseafc.com' }).length, 'free-mail flagged; clean corporate address has no flags');
}

section('unit fixtures — email/domain/evidence/token primitives');
{
  ok(emailProblem('not-an-email') === 'EMAIL_SYNTAX' && emailProblem('a@b.co') === null, 'email syntax validation');
  ok(normalizeDomain('https://www.ChelseaFC.com/tickets') === 'chelseafc.com', 'domain normalisation strips scheme/www/path/case');
  ok(domainCovered('mail.chelseafc.com', 'chelseafc.com') && !domainCovered('chelseafc.com.evil.io', 'chelseafc.com'), 'subdomain coverage cannot be spoofed by suffix tricks');
  ok(isFreeMail('gmail.com') && isDisposable('mailinator.com') && !isFreeMail(domainOfEmail('m@chelseafc.com')), 'free/disposable classification');
  ok(evidenceFileProblem({ mime: 'application/pdf', bytes: 1000, filename: 'licence.pdf' }) === null, 'pdf within limits accepted');
  ok(evidenceFileProblem({ mime: 'image/svg+xml', bytes: 100, filename: 'a.svg' }) === 'FILE_TYPE_NOT_ALLOWED', 'svg (scriptable) refused');
  ok(evidenceFileProblem({ mime: 'application/pdf', bytes: 100, filename: '../../etc/passwd' }) === 'FILENAME_INVALID', 'path traversal in filename refused');
  ok(evidenceFileProblem({ mime: 'application/pdf', bytes: 9 * 1024 * 1024, filename: 'big.pdf' }) === 'FILE_TOO_LARGE', 'oversize refused');
  ok(!evidenceCompleteness('PERSON_IDENTITY', []).complete && evidenceCompleteness('PERSON_IDENTITY', ['document']).complete, 'identity claims need a document before submission');

  const fdb = { verTokens: [] };
  const nid = (() => { let n = 0; return (p) => `${p}-${++n}`; })();
  const secret = mintToken(fdb, nid, { purpose: 'work_email', email: 'a@club.com', subjectId: 'u1' });
  ok(!fdb.verTokens[0].hash.includes(secret) && fdb.verTokens[0].hash.length === 64, 'tokens are stored hashed, never in plain text');
  ok(consumeToken(fdb, { purpose: 'player_invite', secret }).error === 'TOKEN_WRONG_PURPOSE', 'purpose binding enforced');
  ok(consumeToken(fdb, { purpose: 'work_email', secret, subjectId: 'u2' }).error === 'TOKEN_WRONG_ACCOUNT', 'account binding enforced (Alice token refused for Bob)');
  ok(consumeToken(fdb, { purpose: 'work_email', secret, email: 'other@club.com' }).error === 'TOKEN_WRONG_ADDRESS', 'address binding enforced');
  ok(consumeToken(fdb, { purpose: 'work_email', secret, subjectId: 'u1', email: 'a@club.com' }).token != null, 'correct bindings consume the token');
  ok(consumeToken(fdb, { purpose: 'work_email', secret }).error === 'TOKEN_ALREADY_USED', 'single use: replay refused (security case 5/11)');
  const secret2 = mintToken(fdb, nid, { purpose: 'work_email', ttlMs: -1 });
  ok(consumeToken(fdb, { purpose: 'work_email', secret: secret2 }).error === 'TOKEN_EXPIRED', 'expired token refused');
  ok(consumeToken(fdb, { purpose: 'work_email', secret: 'guess' }).error === 'TOKEN_UNKNOWN', 'unknown token refused');
}

section('unit fixtures — safe public projector');
{
  const org = { id: 'o1', name: 'Chelsea FC', suspended: false, verification: { revokedAt: null } };
  const claims = [
    { subjectType: 'user', subjectId: 'u1', claimType: 'PERSON_IDENTITY', status: 'verified', current: true, verificationMethod: 'scoutbox_manual_review', organisationId: null, metadata: {} },
    { subjectType: 'user', subjectId: 'u1', claimType: 'CLUB_ROLE', role: 'Academy Scout', status: 'verified', current: true, organisationId: 'o1', verificationMethod: 'organisation_admin_confirmation', verifiedAt: 5, validFrom: 1, metadata: { workEmail: 'secret@chelseafc.com' }, riskFlags: ['X'], evidenceIds: ['e1'] },
    { subjectType: 'user', subjectId: 'u1', claimType: 'LICENCE', status: 'pending', organisationId: null, verificationMethod: 'document_submitted', metadata: { licenceType: 'UEFA A' }, current: true },
  ];
  const prof = toPublicVerificationProfile({ subjectType: 'user', subjectId: 'u1', claims, orgsById: new Map([['o1', org]]) });
  ok(prof.identityVerified === true && prof.badges.length === 1, 'projector: identity flag + ONLY displayable claims (pending licence excluded — security case 16)');
  ok(prof.badges[0].label === 'Role verified: Academy Scout' && prof.badges[0].provenance.includes('authorised Chelsea FC administrator'), 'badge defines the verified fact and its provenance in plain English');
  const s = JSON.stringify(prof);
  ok(!s.includes('secret@') && !s.includes('riskFlags') && !s.includes('evidenceIds') && !s.includes('workEmail'), 'projector leaks no emails, no evidence, no risk flags');
  ok(orgVerificationStatus({ verified: true, suspended: true }, { verRootRequests: [] }) === 'suspended', 'org lifecycle: suspension outranks verified');
  ok(verLevelFor({ verAdmins: [{ orgId: 'o', userId: 'u', level: 'verification_reviewer', status: 'active' }, { orgId: 'o', userId: 'u', level: 'verification_root_admin', status: 'revoked' }] }, 'o', 'u') === 'verification_reviewer', 'revoked authority rows do not count');
}

// ================================================================ boot
section('server boot + actors + honest migration');
await startServer();
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'Scout');
const sam = await login('org-eastport', 'Sam Cole', 'Coach');
const rita = await login('org-eastport', 'Rita Vale', 'Scout');
const uma = await login('org-eastport', 'Uma Patel', 'Analyst');
const eve = await login('org-eastport', 'Eve Adams', 'Analyst');
const bea = await login('org-eastport', 'Bea Long', 'Director');
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const dee = await login('org-hackneymarsh', 'Dee Coach', 'Manager', 'grassroots');
const adeyemi = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, tom, sam, rita, uma, eve, bea, alex, dee, adeyemi, amara].every((a) => a?.token), 'all actors logged in');

{
  // Honest migration (§48): pre-verified orgs got ORGANISATION_IDENTITY claims
  // with method `migration`; nothing else was upgraded.
  const r = await j('GET', '/org/verification/public/org/org-eastport', undefined, maria.token);
  ok(r.body.organisationStatus === 'verified' && r.body.badges.some((b) => b.claimType === 'ORGANISATION_IDENTITY' && b.provenance.includes('previously established')), 'migrated org shows verified with honest migration provenance');
  const n = await j('GET', '/org/verification/public/org/org-northstar', undefined, maria.token);
  ok(n.body.organisationStatus === 'unverified' && n.body.badges.length === 0, 'never-verified org migrated to unverified, no badges invented');
}

// T&S establishes eastport's root verification administrator (migrated org).
{
  let r = await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId }, null, A);
  ok(r.status === 400 && r.body.error === 'REASON_REQUIRED', 'root appointment without a reason refused');
  r = await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'club identity re-checked against migrated T&S review' }, null, A);
  ok(r.status === 201, 'T&S appoints the migrated club’s first root verification admin (audited)');
  r = await j('POST', '/admin/verification/orgs/org-northstar/appoint-root', { userId: alex.userId, reason: 'x' }, null, A);
  ok(r.status === 409 && r.body.error === 'ORG_NOT_VERIFIED', 'an UNVERIFIED org cannot get a root admin');
  // Maria enables MFA — root-level authority operations demand it.
  const setup = await j('POST', '/org/mfa/setup', {}, maria.token);
  r = await j('POST', '/org/mfa/verify', { code: totp(setup.body.secret) }, maria.token);
  ok(r.status === 200 && r.body.enabled, 'root admin enables MFA (required for sensitive authority operations)');
  maria.mfaSecret = setup.body.secret;
}

// ==================================== V1 — verified club adds a scout
section('V1 — existing verified club verifies a scout (full authority chain)');
let tomAffId, tomRoleId, tomEvidenceId;
{
  let r = await j('POST', '/org/verification/affiliation', { role: 'Academy Scout' }, tom.token);
  ok(r.status === 201 && r.body.affiliation.status === 'collecting_evidence', 'affiliation request creates linked claims in collecting_evidence');
  tomAffId = r.body.affiliation.id; tomRoleId = r.body.role.id;
  r = await j('POST', '/org/verification/affiliation', { role: 'Academy Scout' }, tom.token);
  ok(r.status === 409, 'duplicate affiliation request refused (idempotency)');
  r = await j('POST', '/org/verification/work-email', { email: 'tom@mailinator.com' }, tom.token);
  ok(r.status === 422 && r.body.error === 'DISPOSABLE_EMAIL_REFUSED', 'disposable work email refused');
  r = await j('POST', '/org/verification/work-email', { email: 'tom.field@gmail.com' }, tom.token);
  ok(r.status === 422 && r.body.error === 'COMPANY_EMAIL_REQUIRED', 'free-provider work email refused with honest guidance');
  r = await j('POST', '/org/verification/work-email', { email: 'tom.field@eastportfc.com' }, tom.token);
  ok(r.status === 201, 'work-email challenge sent (local fake transport)');
  r = await j('POST', '/org/verification/work-email/confirm', { code: 'WRONG-CODE-123' }, tom.token);
  ok(r.status === 401, 'wrong code refused and counted');
  const code = await outboxCode('tom.field@eastportfc.com');
  ok(!!code, 'challenge code travelled only in the (local) email');
  r = await j('POST', '/org/verification/work-email/confirm', { code }, tom.token);
  ok(r.status === 200 && r.body.domainControl === 'passed', 'mailbox control proved');
  ok(r.body.note.includes('does NOT by itself verify employment'), 'email control explicitly ≠ employment');
  ok(r.body.claims.every((c) => c.status === 'automated_checks_passed'), 'claims auto-advance to automated_checks_passed — org authority exists, so NO T&S review needed');
  const r2 = await j('POST', '/org/verification/work-email/confirm', { code }, tom.token);
  ok(r2.status === 401 && r2.body.error === 'TOKEN_ALREADY_USED', 'email code is single-use (duplicate callback, security case 11)');

  r = await j('GET', '/org/verification/requests', undefined, maria.token);
  const row = r.body.items.find((x) => x.claimId === tomAffId);
  ok(!!row && row.emailStatus === 'work_email_on_other_domain' && row.identityStatus === 'unverified' && row.claimedRole === null, 'admin sees a PREPARED case: email status, identity state, risk flags');
  ok(r.body.items.some((x) => x.claimId === tomRoleId && x.claimedRole === 'Academy Scout'), 'role claim carries the claimed role for the decision');

  r = await j('POST', `/org/verification/requests/${tomAffId}/decide`, { action: 'confirm' }, maria.token);
  ok(r.status === 200 && r.body.claims.every((c) => c.status === 'verified'), 'authorised admin confirms → BOTH paired claims verified');
  ok(r.body.claims[0].provenance.includes('authorised'), 'provenance label names the authority type');
  r = await j('POST', `/org/verification/requests/${tomAffId}/decide`, { action: 'confirm' }, maria.token);
  ok(r.status === 409 && r.body.error === 'CLAIM_NOT_DECIDABLE', 'double-approval refused (idempotency, security case 12)');

  const pub = await j('GET', `/org/verification/public/user/${tom.userId}`, undefined, alex.token);
  const roleBadge = pub.body.badges.find((b) => b.kind === 'role');
  ok(roleBadge?.label === 'Role verified: Academy Scout' && roleBadge.current === true, 'public profile shows the verified role, defined precisely');
  ok(pub.body.identityVerified === false, 'identity stays separately unverified — claims are INDEPENDENT');
  const pubStr = JSON.stringify(pub.body);
  ok(!pubStr.includes('eastportfc.com') && !pubStr.includes('riskFlags') && !pubStr.includes('evidence'), 'public projection leaks no email, evidence or internal flags');

  const notif = await j('GET', '/org/notifications', undefined, tom.token);
  ok(notif.body.some((n) => n.type === 'verification' && n.text.includes('confirmed')), 'delivery-centre notification reached the subject');
  const led = await j('GET', '/org/ledger', undefined, maria.token);
  ok(led.body.some((l) => l.type === 'verification_decision'), 'decision landed in the tenant audit ledger');
}

// Identity claim: document evidence + T&S review (never auto).
let tomIdentityClaim;
{
  let r = await j('POST', '/org/verification/identity', {}, tom.token);
  tomIdentityClaim = r.body.claim.id;
  r = await j('POST', `/org/verification/claims/${tomIdentityClaim}/submit`, {}, tom.token);
  ok(r.status === 422 && r.body.error === 'EVIDENCE_INCOMPLETE', 'identity cannot be submitted without a document');
  r = await j('POST', `/org/verification/claims/${tomIdentityClaim}/evidence`, { dataUrl: PNG, filename: 'passport.png' }, tom.token);
  ok(r.status === 201 && r.body.evidenceChecks.malwareScan === 'not_configured', 'evidence stored; malware scan honestly not_configured');
  tomEvidenceId = r.body.claim.evidence[0].id;
  r = await j('POST', `/org/verification/claims/${tomIdentityClaim}/evidence`, { dataUrl: 'data:text/html;base64,PGI+', filename: 'x.html' }, tom.token);
  ok(r.status === 422, 'active-content evidence file refused');
  r = await j('POST', `/org/verification/claims/${tomIdentityClaim}/submit`, { status: 'verified' }, tom.token);
  ok(r.status === 200 && r.body.claim.status === 'requires_human_review', 'identity routes to human review — a forged status field in the body is ignored (security case 4)');
  ok(r.body.claim.humanReviewNote?.includes('reviewer checks it'), 'the UI is told WHY human review is needed, in plain language');
  const q = await j('GET', '/admin/verification/queue', undefined, null, A);
  ok(q.body.humanReview.some((x) => x.id === tomIdentityClaim), 'T&S queue received the prepared identity case');
  r = await j('POST', `/admin/verification/claims/${tomIdentityClaim}/approve`, { reason: 'document matches account holder records' }, null, A);
  ok(r.status === 200 && r.body.claim.status === 'verified' && r.body.claim.verificationMethod === 'scoutbox_manual_review', 'T&S approves identity with reason + method recorded');
  const pub = await j('GET', `/org/verification/public/user/${tom.userId}`, undefined, alex.token);
  ok(pub.body.identityVerified === true, 'identity badge now shows');
}

// ============================== V2 — self-verification attack (case 1)
section('V2 — self-verification is impossible');
let samAffId;
{
  let r = await j('POST', '/org/verification/affiliation', { role: 'Academy Coach' }, sam.token);
  samAffId = r.body.affiliation.id;
  r = await j('POST', '/org/verification/work-email', { email: 'sam.cole@eastportfc.com' }, sam.token);
  const code = await outboxCode('sam.cole@eastportfc.com');
  await j('POST', '/org/verification/work-email/confirm', { code }, sam.token);
  r = await j('POST', '/org/verification/admins', { userId: sam.userId, level: 'verification_reviewer' }, maria.token);
  ok(r.status === 201, 'root admin grants reviewer authority to Sam');
  r = await j('POST', `/org/verification/requests/${samAffId}/decide`, { action: 'confirm' }, sam.token);
  ok(r.status === 403 && r.body.error === 'SELF_VERIFICATION_FORBIDDEN', 'a reviewer CANNOT approve their own claim — 403');
  const view = await j('GET', '/org/verification/me', undefined, sam.token);
  ok(view.body.claims.find((c) => c.id === samAffId).status === 'automated_checks_passed', 'no state mutation from the blocked attempt');
  const kase = await j('GET', `/admin/verification/cases/${samAffId}`, undefined, null, A);
  ok(kase.body.events.some((e) => e.type === 'security.self_verification_blocked'), 'security event recorded in the append-only log');
  r = await j('POST', `/org/verification/requests/${samAffId}/decide`, { action: 'correct_role', role: 'First-Team Coach' }, maria.token);
  ok(r.status === 200 && r.body.claims.some((c) => c.role === 'First-Team Coach'), 'a DIFFERENT admin confirms, correcting the role (audited)');
}

// ==================================== V3/V4 — root club bootstrap
section('V3/V4 — root organisation bootstrap: automated checks, human boundary');
let riverton = null, rivertonRootTok = null, rootReqId = null, applicantSecret = null;
{
  let r = await j('POST', '/auth/org/verification/apply', {
    orgName: 'Riverton Athletic FC', orgType: 'professional club', country: 'GB',
    website: 'https://www.rivertonathletic.com', domain: 'rivertonathletic.com',
    applicantName: 'Priya Nair', applicantRole: 'Club Secretary', workEmail: 'priya.nair@rivertonathletic.com',
    declarations: { authorised: true },
  });
  ok(r.status === 201 && r.body.checks.emailDomainAlignment === 'passed', 'application accepted; deterministic checks ran');
  ok(r.body.checks.dnsOwnership === 'not_configured', 'DNS ownership probe honestly not_configured — never faked');
  rootReqId = r.body.requestId; applicantSecret = r.body.applicantSecret;
  r = await j('POST', `/auth/org/verification/apply/${rootReqId}/evidence`, { applicantSecret: 'wrong', note: 'x' });
  ok(r.status === 404, 'wrong applicant secret looks identical to a missing request (no probing)');
  r = await j('POST', `/auth/org/verification/apply/${rootReqId}/submit`, { applicantSecret });
  ok(r.status === 422 && r.body.error === 'EMAIL_NOT_PROVED', 'cannot submit before proving the mailbox');
  const code = await outboxCode('priya.nair@rivertonathletic.com');
  r = await j('POST', `/auth/org/verification/apply/${rootReqId}/confirm-email`, { applicantSecret, code });
  ok(r.status === 200 && r.body.emailProved, 'applicant proves the organisation mailbox');
  await j('POST', `/auth/org/verification/apply/${rootReqId}/evidence`, { applicantSecret, dataUrl: PNG, filename: 'registration.png', note: 'FA registration certificate' });
  r = await j('POST', `/auth/org/verification/apply/${rootReqId}/submit`, { applicantSecret });
  ok(r.status === 200 && r.body.status === 'requires_human_review' && r.body.reasons.includes('ROOT_ORGANISATION_BOOTSTRAP'), 'domain email + evidence do NOT auto-verify: human boundary enforced (security case 17)');
  ok(r.body.explanation.includes('rivertonathletic.com') && r.body.explanation.includes('not yet been established'), 'the applicant is told exactly why a human reviews it');
  const orgs = await j('GET', '/orgs?platform=main');
  ok(!orgs.body.some((o) => o.name === 'Riverton Athletic FC'), 'no organisation exists before the human decision');

  const q = await j('GET', '/admin/verification/queue', undefined, null, A);
  ok(q.body.rootRequests.some((x) => x.id === rootReqId && !x.applicantSecretHash), 'T&S queue holds the prepared case (secret hash never exposed)');
  r = await j('POST', `/admin/verification/root-requests/${rootReqId}/approve`, {}, null, A);
  ok(r.status === 400 && r.body.error === 'REASON_REQUIRED', 'root approval demands a written reason');
  r = await j('POST', `/admin/verification/root-requests/${rootReqId}/approve`, { reason: 'company registry + federation listing match the evidence; applicant reachable on official mailbox' }, null, A);
  ok(r.status === 200 && r.body.orgId && r.body.rootAdminUserId, 'V4: human approval establishes the organisation AND its first root admin');
  riverton = r.body;
  const r2 = await j('POST', `/admin/verification/root-requests/${rootReqId}/approve`, { reason: 'again' }, null, A);
  ok(r2.status === 409, 'stale double-approval of the root request refused');

  const orgs2 = await j('GET', '/orgs?platform=main');
  ok(orgs2.body.some((o) => o.id === riverton.orgId && o.verified === true), 'organisation now listed as verified');
  rivertonRootTok = (await login(riverton.orgId, 'Priya Nair')).token;
  const dash = await j('GET', '/org/verification/dashboard', undefined, rivertonRootTok);
  ok(dash.status === 200 && dash.body.organisationStatus === 'verified' && dash.body.counts.administrators === 1, 'root admin operates the verification console');
  const doms = await j('GET', '/org/verification/domains', undefined, rivertonRootTok);
  ok(doms.body.domains.some((d) => d.domain === 'rivertonathletic.com' && d.status === 'verified'), 'aligned mailbox proof recorded the official domain');
  const kase = await j('GET', `/admin/verification/queue`, undefined, null, A);
  ok(!kase.body.rootRequests.some((x) => x.id === rootReqId), 'decided request left the queue; audit trail retains reviewer + evidence');
}

// ==================================== V5/V6 — departure + dispute
section('V5/V6 — employee leaves; history survives; dispute flows to T&S');
{
  let r = await j('POST', `/org/verification/staff/${tom.userId}/departed`, {}, maria.token);
  ok(r.status === 200 && r.body.closed >= 2, 'club admin marks Tom departed — the verified period CLOSES');
  const pub = await j('GET', `/org/verification/public/user/${tom.userId}`, undefined, alex.token);
  const badge = pub.body.badges.find((b) => b.kind === 'role');
  ok(badge && badge.current === false && badge.historical === true && badge.label.startsWith('Former'), 'current badge gone; historical verified role remains (security case 15)');
  r = await j('POST', `/org/verification/staff/${tom.userId}/departed`, {}, maria.token);
  ok(r.status === 404 && r.body.error === 'NO_CURRENT_VERIFIED_CLAIMS', 'double-departure is a predictable no-op');

  r = await j('POST', `/org/verification/claims/${tomAffId}/dispute`, { reason: 'my departure date is wrong — I worked through July' }, tom.token);
  ok(r.status === 201 && r.body.note.includes('never silently disappear'), 'V6: former employee disputes; claim flagged, history preserved');
  const dup = await j('POST', `/org/verification/claims/${tomAffId}/dispute`, { reason: 'again' }, tom.token);
  ok(dup.status === 409, 'one open dispute per claim');
  const q = await j('GET', '/admin/verification/disputes', undefined, null, A);
  const disp = q.body.items.find((d) => d.claimId === tomAffId && d.status === 'open');
  ok(!!disp, 'dispute landed in the T&S queue');
  r = await j('POST', `/admin/verification/disputes/${disp.id}/resolve`, { action: 'correct', reason: 'club confirmed the later end date', validUntil: Date.now(), current: false }, null, A);
  ok(r.status === 200 && r.body.dispute.status === 'resolved' && r.body.claim.status === 'verified', 'T&S resolves with a correction; claim back to verified-historical');
  const kase = await j('GET', `/admin/verification/cases/${tomAffId}`, undefined, null, A);
  ok(kase.body.events.filter((e) => e.type === 'claim.disputed').length >= 1 && kase.body.events.some((e) => e.type === 'claim.corrected'), 'append-only event log kept every step');
}

// ==================================== V7/V8/V14 — licences
section('V7/V8/V14 — licences: submitted ≠ verified; registry adapter; honesty');
let samLicId;
{
  let r = await j('GET', '/org/verification/licence-providers', undefined, sam.token);
  ok(r.body.providers.find((p) => p.id === 'fa-england').state === 'not_configured', 'production registries honestly not_configured');
  ok(r.body.providers.find((p) => p.id === 'local-test-registry').state === 'configured', 'only the env-gated local TEST fixture is configured');

  r = await j('POST', '/org/verification/licence', { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'UEFA-B-77777', holderName: 'Sam Cole', dataUrl: PNG, filename: 'licence.png' }, sam.token);
  samLicId = r.body.claim.id;
  ok(r.body.claim.display === 'Credential submitted — verification pending', 'V7: upload shows “Credential submitted”, NEVER “Licence verified”');
  let pub = await j('GET', `/org/verification/public/user/${sam.userId}`, undefined, alex.token);
  ok(!pub.body.badges.some((b) => b.kind === 'licence'), 'V14: uploaded evidence alone produces NO verified badge anywhere');

  r = await j('POST', `/org/verification/licence/${samLicId}/submit`, { providerId: 'local-test-registry' }, sam.token);
  ok(r.status === 200 && r.body.claim.status === 'verified' && r.body.claim.display === 'Licence verified: UEFA B Licence', 'V8: exact deterministic registry match → verified via authoritative_registry');
  pub = await j('GET', `/org/verification/public/user/${sam.userId}`, undefined, alex.token);
  ok(pub.body.badges.some((b) => b.kind === 'licence' && b.provenance.includes('authoritative registry')), 'licence badge carries registry provenance');

  r = await j('POST', '/org/verification/licence', { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'AMBIG-001', holderName: 'Alex Taylor' }, eve.token);
  const ambId = r.body.claim.id;
  r = await j('POST', `/org/verification/licence/${ambId}/submit`, { providerId: 'local-test-registry' }, eve.token);
  ok(r.body.claim.status === 'requires_human_review' && r.body.provider.result === 'ambiguous', 'ambiguous registry match → human review, never a guess');

  r = await j('POST', '/org/verification/licence', { licenceType: 'FA Level 2', issuer: 'The FA', identifier: 'NOPE-123', holderName: 'Uma Patel' }, uma.token);
  const umaLic = r.body.claim.id;
  r = await j('POST', `/org/verification/licence/${umaLic}/submit`, { providerId: 'local-test-registry' }, uma.token);
  ok(r.body.provider.result === 'no_match' && r.body.claim.status === 'requires_human_review' && r.body.claim.display.includes('Credential submitted'), 'no-match neither verifies nor rejects');
  r = await j('POST', `/admin/verification/claims/${umaLic}/approve`, { reason: 'issuer letterhead + reference call to county FA office' }, null, A);
  ok(r.body.claim.metadata.display.includes('document review') && r.body.claim.metadata.display.includes('not an independent register check'), 'manual review is labelled as a DOCUMENT review, never a register check');
}

// Provider unavailable — separate server with the registry marked down.
{
  const downDir = mkdtempSync(path.join(tmpdir(), 'sbx-m14down-'));
  await startServer(DOWN_PORT, downDir, { TEST_LICENCE_REGISTRY: 'down' });
  const dBase = `http://localhost:${DOWN_PORT}`;
  const m2 = (await jAt(dBase, 'POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Down Tester', role: 'Coach' })).body;
  let r = await jAt(dBase, 'POST', '/org/verification/licence', { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'UEFA-B-77777', holderName: 'Down Tester' }, m2.token);
  r = await jAt(dBase, 'POST', `/org/verification/licence/${r.body.claim.id}/submit`, { providerId: 'local-test-registry' }, m2.token);
  ok(r.body.provider.state === 'temporarily_unavailable' && r.body.note.includes('remains pending'), 'provider outage: honest “remains pending” — never verified, never rejected (§62)');
  children.at(-1).kill('SIGKILL');
}

// ==================================== V9 — minors: verification ≠ access
section('V9 — safeguarding intact: verification grants no minor access');
let kid17;
{
  const dobY = (y) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); d.setDate(d.getDate() + 10); return d.toISOString().slice(0, 10); };
  kid17 = (await j('POST', '/guardian/children', { name: 'Noor Test17', dob: dobY(18), position: 'CM', foot: 'right', lat: 51.5, lng: -0.06 }, amara.token)).body?.player;
  ok(kid17?.id, 'guardian creates a 17-year-old (existing DOB/country logic — no new age system)');
  let r = await j('POST', '/org/representation/propose', { playerId: kid17.id, scope: 'full_representation' }, alex.token);
  ok(r.status === 403, 'agency representation of a 17-year-old still refused — verification changes nothing');
  const kidTok = (await j('POST', '/auth/player/login', { playerId: kid17.id })).body;
  const inv = await j('POST', '/org/verification/player-invites', { name: 'Noor Test17', squad: 'U18' }, maria.token);
  ok(inv.status === 201 && inv.body.code, 'verified club mints a squad invitation (code handed over, single-use)');
  r = await j('POST', '/player/invites/accept', { code: inv.body.code }, kidTok.token);
  ok(r.status === 403 && r.body.error === 'GUARDIAN_MANAGED', 'a minor cannot accept an invitation — guardian flow only');
  r = await j('POST', '/guardian/invites/accept', { code: inv.body.code, childId: kid17.id }, amara.token);
  ok(r.status === 200 && r.body.invite.guardianApproved, 'guardian accepts; approval recorded; no identity claim created');
  const prof = await j('GET', `/org/verification/public/user/${kid17.id}`, undefined, maria.token);
  ok(prof.body.badges.length === 0 && prof.body.identityVerified === false, 'invitation acceptance created NO verification claim for the player');
}

// ==================================== V16 — reference provenance snapshot
section('V16 — coach references: provenance snapshot, correction, withdrawal');
{
  let r = await j('POST', '/org/verification/references', { playerId: 'pl-adeyemi', relationship: 'Head coach, first team', capacity: 'coached 2 seasons', fromYear: 2024, toYear: 2026, strengths: 'pressing triggers', development: 'weak-foot delivery', summary: 'Reliable, coachable wide forward.' }, sam.token);
  ok(r.status === 201 && r.body.reference.provenanceSnapshot.claimId, 'verified coach submits a structured reference with a provenance SNAPSHOT');
  const refId = r.body.reference.id;
  r = await j('POST', '/org/verification/references', { playerId: 'pl-adeyemi', relationship: 'x', summary: 'y' }, uma.token);
  ok(r.status === 403 && r.body.error === 'VERIFIED_ROLE_REQUIRED', 'no verified current role → no reference authority');
  // Reference for a minor routes through the guardian (existing rules).
  r = await j('POST', '/org/verification/references', { playerId: kid17.id, relationship: 'Academy coach', summary: 'Composed left-sided defender.' }, sam.token);
  ok(r.status === 201, 'reference for a visible minor is allowed under standing rules…');
  const gNotif = await j('GET', '/guardian/notifications', undefined, amara.token);
  ok(gNotif.body.some((n) => n.type === 'verification' && n.text.includes('reference')), '…and the notification routes to the GUARDIAN, not the child');

  r = await j('POST', `/org/verification/references/${refId}/correct`, { summary: 'Reliable, coachable wide forward; excellent pressing.' }, sam.token);
  ok(r.status === 200 && r.body.reference.version === 2 && r.body.superseded === refId, 'correction creates version 2; the original is superseded, never edited');
  let mine = await j('GET', '/player/references', undefined, adeyemi.token);
  const cur = mine.body.items.find((x) => x.version === 2);
  ok(cur && cur.provenance.includes('is verified'), 'player sees the reference with live provenance while the coach is current');

  // Coach departs → provenance snapshot is preserved, wording changes honestly.
  r = await j('POST', `/org/verification/staff/${sam.userId}/departed`, {}, maria.token);
  ok(r.status === 200, 'club later marks the coach departed');
  mine = await j('GET', '/player/references', undefined, adeyemi.token);
  ok(mine.body.items.find((x) => x.version === 2)?.provenance === 'Coach affiliation was verified when this reference was submitted.', 'history is not rewritten: reference states verification AT SUBMISSION TIME');
  r = await j('POST', `/org/verification/references/${mine.body.items.find((x) => x.version === 2).id}/withdraw`, { reason: 'superseded by season-end review' }, sam.token);
  ok(r.status === 200 && r.body.reference.status === 'withdrawn', 'withdrawal is explicit, reasoned and audited');
}

// ==================================== V10 — revoked admin + cascade
section('V10 — revoked authority: immediate, provenance queryable, cascade');
let umaAffId;
{
  await j('POST', '/org/verification/admins', { userId: rita.userId, level: 'verification_reviewer' }, maria.token);
  let r = await j('POST', '/org/verification/affiliation', { role: 'Recruitment Analyst' }, uma.token);
  umaAffId = r.body.affiliation.id;
  await j('POST', '/org/verification/work-email', { email: 'uma.patel@eastportfc.com' }, uma.token);
  const code = await outboxCode('uma.patel@eastportfc.com');
  await j('POST', '/org/verification/work-email/confirm', { code }, uma.token);
  r = await j('POST', `/org/verification/requests/${umaAffId}/decide`, { action: 'confirm' }, rita.token);
  ok(r.status === 200, 'reviewer Rita confirms Uma');
  const admins = await j('GET', '/org/verification/admins', undefined, maria.token);
  const ritaRow = admins.body.items.find((a) => a.userId === rita.userId && a.status === 'active');
  r = await j('POST', `/org/verification/admins/${ritaRow.id}/revoke`, { reason: 'left the verification team' }, maria.token);
  ok(r.status === 200, 'authority revoked');
  r = await j('POST', '/org/verification/affiliation', { role: 'Scout' }, eve.token);
  const eveAffId = r.body.affiliation.id;
  await j('POST', '/org/verification/work-email', { email: 'eve.adams@eastportfc.com' }, eve.token);
  const code2 = await outboxCode('eve.adams@eastportfc.com');
  await j('POST', '/org/verification/work-email/confirm', { code: code2 }, eve.token);
  r = await j('POST', `/org/verification/requests/${eveAffId}/decide`, { action: 'confirm' }, rita.token);
  ok(r.status === 403 && r.body.error === 'VERIFICATION_PERMISSION_REQUIRED', 'revoked admin IMMEDIATELY loses decision power (security case 3)');
  r = await j('GET', `/admin/verification/authorities/${rita.userId}/claims`, undefined, null, A);
  ok(r.body.items.some((c) => c.id === umaAffId), 'cascade: “which claims depend on this authority” is answerable');
  r = await j('POST', `/admin/verification/authorities/${rita.userId}/flag`, { reason: 'authority revoked — routine re-check', suspendClaimIds: [umaAffId] }, null, A);
  ok(r.status === 200 && r.body.suspended === 1, 'T&S suspends selected dependent claims — never blanket destruction');
  const pub = await j('GET', `/org/verification/public/user/${uma.userId}`, undefined, alex.token);
  ok(!pub.body.badges.some((b) => b.kind === 'affiliation') && pub.body.badges.some((b) => b.kind === 'role'), 'suspended claim stops displaying instantly — and ONLY that claim (independence)');
  r = await j('POST', `/admin/verification/claims/${umaAffId}/reinstate`, { reason: 're-check passed: employment re-confirmed with club secretary' }, null, A);
  ok(r.status === 200 && r.body.claim.status === 'verified', 'reinstatement after analysis, with reason');
  // Expiring claim + deterministic sweep: Eve confirmed with a short validity.
  r = await j('POST', `/org/verification/requests/${eveAffId}/decide`, { action: 'confirm', validUntil: Date.now() + 1500 }, maria.token);
  ok(r.status === 200, 'claim verified with an explicit validity end');
  await sleep(2600); // M13_FAST_RETRY sweep interval is 500ms
  const st = await j('GET', '/org/verification/me', undefined, eve.token);
  ok(st.body.claims.find((c) => c.id === eveAffId)?.status === 'expired', 'expiry processor moved verified → expired (nothing deleted)');
  const notifs = await j('GET', '/org/notifications', undefined, eve.token);
  ok(notifs.body.some((n) => n.type === 'verification' && n.text.includes('expired')), 'expiry notified through the delivery centre');
}

// ==================================== V11 — organisation suspension
section('V11 — suspended organisation cannot verify; badges respond');
{
  let r = await j('POST', `/admin/clubs/${riverton.orgId}/verification`, { suspended: true }, null, A);
  ok(r.status === 200, 'T&S suspends Riverton');
  r = await j('GET', '/org/verification/dashboard', undefined, rivertonRootTok);
  ok(r.status === 403 && r.body.error === 'ORG_SUSPENDED', 'suspended org staff cannot operate at all (fail closed, security case 13)');
  const pub = await j('GET', `/player/verification/org/${riverton.orgId}`, undefined, adeyemi.token);
  ok(pub.body.organisationStatus === 'suspended' && pub.body.badges.length === 0, 'public projection: suspended, badges suppressed');
  // Legacy toggle stays in sync with the claim engine both ways.
  await j('POST', `/admin/clubs/${riverton.orgId}/verification`, { verified: false, suspended: false }, null, A);
  let pub2 = await j('GET', `/player/verification/org/${riverton.orgId}`, undefined, adeyemi.token);
  ok(pub2.body.organisationStatus === 'unverified', 'legacy un-verify revokes the identity claim (provenance kept)');
  await j('POST', `/admin/clubs/${riverton.orgId}/verification`, { verified: true }, null, A);
  pub2 = await j('GET', `/player/verification/org/${riverton.orgId}`, undefined, adeyemi.token);
  ok(pub2.body.organisationStatus === 'verified', 'legacy re-verify reinstates through the claim engine');
}

// ==================================== V12 — cross-tenant isolation
section('V12 — cross-tenant isolation (concealing 404s)');
{
  let r = await j('POST', '/admin/verification/orgs/org-hackneymarsh/appoint-root', { userId: dee.userId, reason: 'grassroots club verified at M8; committee chair confirmed by federation listing' }, null, A);
  ok(r.status === 201, 'grassroots club gets its own root admin');
  r = await j('GET', '/org/verification/requests', undefined, dee.token);
  ok(r.status === 200 && r.body.items.length === 0, 'club B sees only its own (empty) request queue');
  r = await j('POST', `/org/verification/requests/${samAffId}/decide`, { action: 'confirm' }, dee.token);
  ok(r.status === 404, 'club B deciding club A’s claim: concealed as 404 (security case 2)');
  r = await j('GET', `/org/verification/evidence/${tomEvidenceId}`, undefined, dee.token);
  ok(r.status === 404, 'cross-tenant evidence access concealed as 404 (security case 7)');
  r = await j('GET', `/org/verification/evidence/${tomEvidenceId}`, undefined, maria.token);
  ok(r.status === 404, 'identity documents are Trust&Safety-only — even the subject’s own org cannot fetch them');
  r = await j('GET', '/org/verification/staff', undefined, dee.token);
  ok(r.status === 200 && !r.body.items.some((x) => [samAffId, umaAffId, tomAffId].includes(x.claimId) || x.person.id === tom.userId), 'staff registry is tenant-scoped');
  // The evidence FILE is not reachable through the media path either.
  const kase = await j('GET', `/admin/verification/cases/${tomIdentityClaim}`, undefined, null, A);
  const fileId = kase.body.evidence[0].mediaId;
  const raw = await fetch(`${BASE}/media/${fileId}`, { headers: { Authorization: `Bearer ${adeyemi.token}` } });
  ok(raw.status === 401, 'direct private-file URL access refused (security case 8)');
  const admEv = await j('GET', `/admin/verification/evidence/${kase.body.evidence[0].id}`, undefined, null, A);
  ok(admEv.status === 200 && admEv.body.file?.base64?.length > 0, 'T&S retrieves the document through the logged, authorised route');
  const kase2 = await j('GET', `/admin/verification/cases/${tomIdentityClaim}`, undefined, null, A);
  ok(kase2.body.events.some((e) => e.type === 'evidence.accessed'), 'every sensitive evidence read is an audit event');
}

// ==================================== V13 — token security (remaining)
section('V13 — token binding across accounts and purposes');
{
  await j('POST', '/org/verification/affiliation', { role: 'Scout' }, bea.token);
  await j('POST', '/org/verification/work-email', { email: 'bea.long@eastportfc.com' }, bea.token);
  const beaCode = await outboxCode('bea.long@eastportfc.com');
  let r = await j('POST', '/org/verification/work-email/confirm', { code: beaCode }, uma.token);
  ok(r.status === 401 && ['TOKEN_WRONG_ACCOUNT'].includes(r.body.error), 'Bea’s code refused for Uma (security case 6)');
  r = await j('POST', '/guardian/invites/accept', { code: beaCode, childId: kid17.id }, amara.token);
  ok(r.status === 404 && r.body.error === 'TOKEN_WRONG_PURPOSE', 'work-email token cannot act as an invitation (purpose binding)');
  r = await j('POST', '/org/verification/work-email/confirm', { code: beaCode }, bea.token);
  ok(r.status === 200, 'the rightful holder can still use it');
}

// ==================================== V17 — grassroots without a domain
section('V17 — grassroots evidence path: prepared, never auto-approved');
{
  let r = await j('POST', '/auth/org/verification/apply', {
    orgName: 'Marsh Lane Juniors', orgType: 'grassroots club', country: 'GB',
    website: 'https://marshlanejuniors.example.org', federation: 'London FA',
    applicantName: 'Kemi Ade', applicantRole: 'Club Secretary', workEmail: 'kemi.ade.mlj@gmail.com',
  });
  ok(r.status === 201 && r.body.checks.freeEmailProvider === 'flagged', 'grassroots application accepted; free email honestly flagged, not fatal');
  const id = r.body.requestId, sec = r.body.applicantSecret;
  const code = await outboxCode('kemi.ade.mlj@gmail.com');
  await j('POST', `/auth/org/verification/apply/${id}/confirm-email`, { applicantSecret: sec, code });
  await j('POST', `/auth/org/verification/apply/${id}/evidence`, { applicantSecret: sec, dataUrl: PNG, filename: 'league-listing.png', note: 'London FA league handbook entry' });
  r = await j('POST', `/auth/org/verification/apply/${id}/submit`, { applicantSecret: sec });
  ok(r.body.status === 'requires_human_review', 'insufficient authoritative evidence → human review, NOT a lowered bar');
  r = await j('POST', `/admin/verification/root-requests/${id}/reject`, { reason: 'federation listing could not be corroborated — invited to reapply with the county FA affiliation number' }, null, A);
  ok(r.status === 200 && r.body.request.status === 'rejected', 'T&S can reject with a recorded reason');
}

// ==================================== V18 — takeover + dual control
section('V18 — admin takeover fails; root changes need two people');
{
  let r = await j('POST', '/org/verification/admins', { userId: eve.userId, level: 'verification_admin' }, maria.token);
  ok(r.status === 201, 'root admin (with MFA) grants verification_admin');
  r = await j('POST', '/org/verification/admins', { userId: eve.userId, level: 'verification_root_admin' }, eve.token);
  ok(r.status === 403 && r.body.error === 'VERIFICATION_PERMISSION_REQUIRED', 'non-root cannot touch root authority (security case 9/18)');
  r = await j('POST', '/org/verification/admins', { userId: maria.userId, level: 'verification_admin' }, maria.token);
  ok(r.status === 403 && r.body.error === 'SELF_PROMOTION_FORBIDDEN', 'root admin cannot change their OWN authority (security case 10)');
  r = await j('POST', '/org/verification/admins', { userId: eve.userId, level: 'verification_root_admin' }, maria.token);
  ok(r.status === 202 && r.body.transfer, 'root grant becomes a PENDING dual-control transfer');
  const transferId = r.body.transfer.id;
  r = await j('POST', `/org/verification/root-transfers/${transferId}/approve`, {}, maria.token);
  ok(r.status === 403 && r.body.error === 'DUAL_CONTROL_REQUIRED', 'the proposer cannot also be the approver');
  r = await j('POST', `/org/verification/root-transfers/${transferId}/approve`, {}, eve.token);
  ok(r.status === 403, 'the beneficiary cannot approve it either');
  await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: bea.userId, reason: 'second root for dual control (director, MFA verified)' }, null, A);
  r = await j('POST', `/org/verification/root-transfers/${transferId}/approve`, {}, bea.token);
  ok(r.status === 403 && r.body.error === 'MFA_REQUIRED_FOR_ROOT_OPERATION', 'root operations demand MFA on the acting account');
  const setup = await j('POST', '/org/mfa/setup', {}, bea.token);
  await j('POST', '/org/mfa/verify', { code: totp(setup.body.secret) }, bea.token);
  r = await j('POST', `/org/verification/root-transfers/${transferId}/approve`, {}, bea.token);
  ok(r.status === 200 && r.body.admin.level === 'verification_root_admin', 'a SECOND root admin approves — dual control satisfied');
  // Domain takeover attempt from another tenant.
  r = await j('POST', '/org/verification/domains', { domain: 'eastportfc.com', challengeEmail: 'it@eastportfc.com' }, rivertonRootTok);
  ok(r.status === 201 && r.body.request.status === 'requires_human_review', 'claiming another club’s domain (or any new root domain) cannot self-serve — T&S review');
  const admins = await j('GET', '/org/verification/admins', undefined, maria.token);
  ok(admins.body.items.filter((a) => a.level === 'verification_root_admin' && a.status === 'active').length === 3, 'existing root admins remain in control throughout');
  const ownRow = admins.body.items.find((a) => a.userId === maria.userId && a.level === 'verification_root_admin' && a.status === 'active');
  r = await j('POST', `/org/verification/admins/${ownRow.id}/revoke`, {}, maria.token);
  ok(r.status === 403 && r.body.error === 'SELF_REVOKE_FORBIDDEN', 'nobody removes their own authority — orphaning is prevented with T&S as recovery');
}

// ==================================== authorization sweep (security 32/54)
section('authorization sweep — every surface fails closed');
{
  let r = await j('GET', '/org/verification/dashboard', undefined, uma.token);
  ok(r.status === 403, 'ordinary staff member cannot read the console');
  r = await j('POST', `/org/verification/requests/${samAffId}/decide`, { action: 'confirm' }, uma.token);
  ok(r.status === 403, 'ordinary staff cannot approve verification');
  r = await fetch(`${BASE}/org/verification/dashboard`, { headers: { Authorization: `Bearer ${adeyemi.token}` } });
  ok(r.status === 401, 'player session cannot reach club verification at all (security case 9)');
  r = await j('GET', '/admin/verification/queue', undefined, maria.token);
  ok(r.status === 401, 'club admin cannot read the T&S queue');
  r = await j('GET', '/admin/verification/queue', undefined, null, { 'x-admin-key': 'wrong' });
  ok(r.status === 401, 'wrong admin key refused');
  r = await j('POST', '/org/verification/player-invites', { name: 'X' }, alex.token);
  ok(r.status === 403 && r.body.error === 'ORG_NOT_ELIGIBLE', 'unverified org cannot send squad invitations');
  // Conflict declarations: explicit, org-internal.
  r = await j('POST', '/org/verification/conflicts', { kind: 'family_relationship', subject: 'nephew trials at U15', note: 'declared before assessment' }, sam.token);
  ok(r.status === 201, 'conflict of interest declared explicitly');
  const list = await j('GET', '/org/verification/conflicts', undefined, maria.token);
  ok(list.body.items.some((c) => c.kind === 'family_relationship'), 'org verification admins see declarations');
  const deeList = await j('GET', '/org/verification/conflicts', undefined, dee.token);
  ok(!deeList.body.items.some((c) => c.kind === 'family_relationship'), 'other tenants never see them');
}

// ==================================== rate limits, batch reads, metrics
section('operational: deterministic rate limit, batch projector, metrics');
{
  let last = null;
  for (let i = 0; i < 20; i++) last = await j('POST', '/org/verification/player-invites', { name: `Bulk ${i}` }, maria.token);
  ok(last.status === 201 || last.status === 429, 'bulk invitations processed');
  const over = await j('POST', '/org/verification/player-invites', { name: 'One Too Many' }, maria.token);
  ok(over.status === 429 && over.body.error === 'INVITE_RATE_LIMIT', 'deterministic per-day invite cap → 429');
  const ids = [tom.userId, sam.userId, uma.userId, eve.userId, bea.userId].join(',');
  const t0 = Date.now();
  const batch = await j('GET', `/org/verification/public/users?ids=${ids}`, undefined, maria.token);
  ok(batch.body.profiles.length === 5 && Date.now() - t0 < 500, 'one batched call returns many badge profiles (no N+1 read path)');
  const m = await j('GET', '/admin/metrics', undefined, null, A);
  ok(m.body.verification && m.body.verification.requestsCreated > 10 && m.body.verification.routedToHumanReview > 0, 'verification metrics exposed as counters');
  ok(!JSON.stringify(m.body.verification).match(/@|Maria|Tom/), 'metrics carry no names or emails');
  const audit = await j('GET', '/org/audit/export', undefined, maria.token);
  ok(audit.body.ledger.some((l) => l.type === 'verification_decision'), 'verification decisions appear in the tenant audit export');
}

console.log(`\nm14E2E: ${process.exitCode ? 'FAILED — see ✗ above' : `all ${passed} checks passed`}`);
process.exit(process.exitCode ?? 0);
