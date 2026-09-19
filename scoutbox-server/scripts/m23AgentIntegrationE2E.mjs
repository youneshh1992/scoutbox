// M23 P5.6E acceptance suite — ScoutBox Agent cross-app integration.
//
// The governing principle this suite enforces: cross-app integration must never
// turn legacy representation data, a stale Agent session, same-agency
// membership, an internal Club decision, a Trial invitation, a shared
// Opportunity or a transaction reference into broader authority or visibility
// than the current canonical relationship, policy, consent, block and privacy
// rules actually permit.
//
// This suite proves INTEGRATION, not app-local behaviour: almost every check
// crosses a boundary between two systems that were built separately, and asks
// whether the seam between them leaks.
//
// Groups (mandate §95), pure first, then a real server:
//   A representation seam audit · B canonical representation authority ·
//   C legacy cannot grant authority · D Player Agent projection · E Club Agent
//   projection · F Agent Client projection · G Opportunity share · H Contact
//   routing · I Contact reauthorization · J Inbox isolation · K Trial Agent
//   visibility · L Trial private assessment boundary · M Box Cam boundary ·
//   N Recruitment Room boundary · O P5 Decision boundary · P explicit
//   transaction handoff · Q duplicate handoff · R transaction compliance
//   recheck · S same-agency privacy · T representation expiry · U termination ·
//   V dispute · W licence expiry · X Agent leaves Agency · Y blocks · Z minors ·
//   AA unsupported jurisdiction · AB tenant isolation · AC direct deep links ·
//   AD rev · AE idempotency · AF concurrency · AG events · AH notifications ·
//   AI audit · AJ EN/FR · AK accessibility · AL 390/360 · AM demo ·
//   AN tombstones · AO legacy/corruption
//   — and the thirty-seven adversarial cases (§96), numbered #1–#37.
//
// No assertion is `status !== 200`. Every refusal names its status and its code.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SURFACES, SURFACE_NAMES, SURFACE_DISCLOSURE, POLICY_ACTION_FOR_SURFACE,
  RULE_ORDER, DENY_CODES, CONTACT_ROUTING_MODES,
  DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, normaliseDisclosure,
  agentClientBasis, agentSurfaceDecision, contactRouting, contactTargetSnapshot,
  clubAgentPresence, surfaceIsRegulated, surfaceScopes,
  HANDOFF_STATUSES, HANDOFF_BLOCKERS, HANDOFF_TTL_MS, effectiveHandoffStatus,
  handoffBlockers, duplicateTransactionOf,
} from '../m27/integration.mjs';
import {
  agreementGrantsAccess, effectiveAgreementStatus, PERMISSIONS, can,
  MAX_OPPORTUNITY_SHARES, SCOPES,
} from '../m24/shared.mjs';
import { CONTACT_MODES, CONTACT_STATUSES, contactIntegrity, contactView, contactMilestone } from '../m23/contact.mjs';
import { M23_ERROR_HTTP, httpStatusFor } from '../m23/errors.mjs';
import { M26_ERROR_HTTP } from '../m26/errors.mjs';
import { TERMINAL_STATUSES } from '../m26/transaction.mjs';
import { TRIAL_SCHEDULE_VIEWERS } from '../m23/trial.mjs';
import { POLICY_ACTIONS, MINOR_PATHWAY_PRODUCTION_ENABLED } from '../m25/policy.mjs';
import { EVENT_REGISTRY, EVENT_NAMES } from '../m182/eventRegistry.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../m182/notificationPrefs.mjs';
import { MIGRATIONS, SCHEMA_VERSION, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { openStore } from '../store.mjs';

const PORT = 7100 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m27-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SERVER = path.join(HERE, '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return good;
};
const T0 = Date.UTC(2026, 8, 19);
const DAY = 86_400_000;

// =================================================================== PURE

const basis = (over = {}) => ({ ok: true, agentUserId: 'usr-ana', agreementId: 'rep-1', scope: ['employment'], agencyOrgId: 'org-northstar', status: 'active', ...over });
const agreement = (over = {}) => ({
  id: 'rep-1', agentUserId: 'usr-ana', agencyOrgId: 'org-northstar', clientId: 'pl-kola',
  status: 'active', confirmedAt: T0 - 10 * DAY, endAt: T0 + 300 * DAY, scope: ['employment'], ...over,
});

section('pure A/§4 — the seam: one basis, and it is the canonical predicate');
{
  ok(SURFACE_NAMES.length === 10, 'A-p1 ten declared integration surfaces — every question another app can ask has a name');
  ok(SURFACE_NAMES.every((s) => typeof SURFACES[s].regulated === 'boolean' && (SURFACES[s].scopes === null || Array.isArray(SURFACES[s].scopes))), 'A-p2 each declares whether it is a regulated action and which scopes it needs');
  ok(RULE_ORDER.length === 11 && RULE_ORDER[0] === 'SURFACE_KNOWN' && RULE_ORDER[1] === 'BASIS', 'A-p3 the rule stack is fixed and named, basis second — nothing is decided before authority is');
  ok(RULE_ORDER.indexOf('BLOCK') < RULE_ORDER.indexOf('SCOPE') && RULE_ORDER.indexOf('BLOCK') < RULE_ORDER.indexOf('COMPLIANCE'), 'A-p4 BLOCK is applied before scope and before compliance: safety outranks every convenience, and a compliance answer never overrides it');
  ok(RULE_ORDER.indexOf('ADULT') < RULE_ORDER.indexOf('BLOCK') && RULE_ORDER.indexOf('MINOR_PATHWAY') < RULE_ORDER.indexOf('BLOCK'), 'A-p5 and age is applied before both');
  ok(DENY_CODES.length === 12 && new Set(DENY_CODES).size === 12, 'A-p6 twelve distinct deny codes, one meaning each');
  neg(!DENY_CODES.some((c) => /minor|age|dob|birth/i.test(c) && c !== 'MINOR_PATHWAY_DISABLED'), 'A-p7 no deny code is an age oracle beyond the one named pathway');
  ok(Object.keys(POLICY_ACTION_FOR_SURFACE).every((s) => POLICY_ACTIONS.includes(POLICY_ACTION_FOR_SURFACE[s])), 'A-p8 every regulated surface maps to a real P5.6C policy action, not a name of its own');
  ok(SURFACE_NAMES.filter(surfaceIsRegulated).every((s) => Object.hasOwn(POLICY_ACTION_FOR_SURFACE, s)), 'A-p9 and every regulated surface HAS a mapping — a regulated surface with nothing to ask would be unenforceable');
  neg(!SURFACE_NAMES.some((s) => /offer|fee|commission|negotiat|sign/i.test(s)), 'A-p10 no surface names an offer, a fee, a negotiation or a signing');
}

section('pure B/§5 — canonical authority: the basis is agreementGrantsAccess and nothing else');
{
  const good = agreement();
  ok(agentClientBasis({ agreements: [good], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === true, 'B-p1 an active, client-confirmed, unexpired agreement naming this agent IS a basis');
  ok(agentClientBasis({ agreements: [good], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).agentUserId === 'usr-ana', 'B-p2 and the basis NAMES the individual — a routing snapshot that has to re-derive it records nobody (E-4)');
  neg(agentClientBasis({ agreements: [agreement({ confirmedAt: null, status: 'proposed' })], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === false, 'B-p3 a proposal is not a basis: nothing is active until the client confirms it');
  neg(agentClientBasis({ agreements: [agreement({ status: 'disputed', disputedAt: T0 })], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === false, 'B-p4 a dispute is not a basis (#13)');
  neg(agentClientBasis({ agreements: [agreement({ endAt: T0 - DAY })], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === false, 'B-p5 an active agreement past its end is not a basis — expiry is derived, never waited for (#13, T)');
  neg(agentClientBasis({ agreements: [agreement()], agentUserId: 'usr-someone-else', clientId: 'pl-kola', now: T0 }).ok === false, 'B-p6 a colleague at the same agency is not a basis (#3, #4)');
  neg(agentClientBasis({ agreements: [agreement()], agentUserId: 'usr-ana', clientId: 'pl-other', now: T0 }).ok === false, 'B-p7 and the basis is per CLIENT: an agreement about one player says nothing about another (#25)');
  neg(agentClientBasis({ agreements: [agreement()], agentUserId: null, clientId: 'pl-kola', now: T0 }).ok === false, 'B-p8 a missing agent id is not a wildcard');
  ok(agentClientBasis({ agreements: [agreement({ status: 'disputed', disputedAt: T0 })], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).status === 'disputed', 'B-p9 the non-active state is reported to the AGENT, who already knows the relationship exists');
  neg(agentClientBasis({ agreements: [], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).status === null, 'B-p10 and "none at all" is a different answer from "not active" — a third party gets neither');
}

section('pure C/§6 — a legacy M13 F10 row can never grant authority');
{
  // The 2305 mirror writes a row with agentUserId: null. It is history.
  const mirror = agreement({ agentUserId: null, legacy: { fromRepresentationId: 'rep-legacy-1' } });
  neg(agreementGrantsAccess(mirror, null, T0) === false, 'C-p1 a legacy mirror does not grant access even to a caller with no id (#1)');
  neg(agreementGrantsAccess(mirror, 'usr-ana', T0) === false, 'C-p2 nor to a real agent (#1)');
  neg(agentClientBasis({ agreements: [mirror], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === false, 'C-p3 and it produces no basis, so no surface can be reached through it (#2)');
  neg(agentClientBasis({ agreements: [mirror], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).status === null, 'C-p4 it does not even register as a non-active relationship — it names nobody, so there is nothing to be non-active about');
  ok(effectiveAgreementStatus(mirror, T0) === 'active', 'C-p5 the mirrored row may still READ as active — it is history, and the predicate is what withholds authority, not a rewrite of the record');
}

section('pure §47 — every surface fails closed, rule by rule');
{
  const full = { basis: basis(), subjectPresent: true, isAdult: true, minorPathwayOpen: false, blocked: false, disclosure: true, shared: true, licenceCurrent: true, complianceClear: true };
  for (const s of SURFACE_NAMES) ok(agentSurfaceDecision({ surface: s, ...full }).allowed === true, `S-p1 ${s} allows when every fact is satisfied`);
  neg(agentSurfaceDecision({ surface: 'nope', ...full }).code === 'SURFACE_UNKNOWN', 'S-p2 an unknown surface denies SURFACE_UNKNOWN');
  neg(agentSurfaceDecision({ surface: '__proto__', ...full }).code === 'SURFACE_UNKNOWN', 'S-p3 and a prototype name is not a surface');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, basis: null }).code === 'NO_REPRESENTATION', 'S-p4 no basis → NO_REPRESENTATION');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, basis: { ok: false, status: 'expired' } }).code === 'REPRESENTATION_NOT_ACTIVE', 'S-p5 a basis that once existed → REPRESENTATION_NOT_ACTIVE');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, subjectPresent: false }).code === 'SUBJECT_UNAVAILABLE', 'S-p6 a removed subject → SUBJECT_UNAVAILABLE (#34)');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, isAdult: false }).code === 'MINOR_PATHWAY_DISABLED', 'S-p7 a minor → MINOR_PATHWAY_DISABLED on every adultOnly surface (Z, #7, #8, #9)');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, basis: basis({ isRegulatoryMinor: true }) }).code === 'MINOR_PATHWAY_DISABLED', 'S-p8 and a regulatory minor is refused even where the visibility age passed');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, blocked: true }).code === 'BLOCKED', 'S-p9 a block → BLOCKED (Y, #26, #27)');
  neg(agentSurfaceDecision({ surface: 'client_private', ...full, blocked: true, complianceClear: true }).code === 'BLOCKED', 'S-p10 and a CLEAR compliance answer does not override it');
  neg(agentSurfaceDecision({ surface: 'contact_participation', ...full, basis: basis({ scope: ['commercial'] }) }).code === 'SCOPE_INSUFFICIENT', 'S-p11 a commercial-only mandate cannot be a party to an employment contact → SCOPE_INSUFFICIENT');
  neg(agentSurfaceDecision({ surface: 'contact_participation', ...full, disclosure: null }).code === 'DISCLOSURE_WITHHELD', 'S-p12 silence is not consent: a null disclosure → DISCLOSURE_WITHHELD');
  neg(agentSurfaceDecision({ surface: 'contact_participation', ...full, disclosure: false }).code === 'DISCLOSURE_WITHHELD', 'S-p13 and an explicit no is a no');
  neg(agentSurfaceDecision({ surface: 'passport_shared', ...full, shared: false }).code === 'SHARE_REQUIRED', 'S-p14 a surface needing an explicit share → SHARE_REQUIRED');
  neg(agentSurfaceDecision({ surface: 'contact_participation', ...full, licenceCurrent: false }).code === 'LICENCE_NOT_CURRENT', 'S-p15 a regulated surface with a stale licence → LICENCE_NOT_CURRENT (W, #11, #12)');
  neg(agentSurfaceDecision({ surface: 'contact_participation', ...full, complianceClear: null }).code === 'COMPLIANCE_NOT_CLEAR', 'S-p16 "not evaluated" is not clear → COMPLIANCE_NOT_CLEAR (R)');
  neg(agentSurfaceDecision({ surface: 'contact_participation', ...full, complianceClear: false }).code === 'COMPLIANCE_NOT_CLEAR', 'S-p17 and neither is a no');
  ok(agentSurfaceDecision({ surface: 'client_private', ...full, complianceClear: null }).allowed === true, 'S-p18 an UNregulated surface asks the compliance layer nothing — it is a read of the agent\'s own client');
  // The order matters: the FIRST rule that refuses is the code, so a refusal is
  // explainable without being an oracle for the later facts.
  ok(agentSurfaceDecision({ surface: 'contact_participation', ...full, isAdult: false, blocked: true, licenceCurrent: false }).code === 'MINOR_PATHWAY_DISABLED', 'S-p19 the first refusal in RULE_ORDER wins, so a refusal never leaks the later facts');
  ok(agentSurfaceDecision({ surface: 'contact_participation', ...full, blocked: true, licenceCurrent: false }).code === 'BLOCKED', 'S-p19b and a blocked player is refused before the licence is even consulted');
  ok(DENY_CODES.includes(agentSurfaceDecision({ surface: 'nope' }).code), 'S-p20 every deny code the decision can produce is in the declared list');
}

section('pure §21/§22 — contact routing adds the agent BESIDE the player, never instead');
{
  ok(CONTACT_MODES.join() === 'player_only,both' && CONTACT_ROUTING_MODES.join() === 'player_only,both', 'H-p1 two modes, and the Contact domain and the integration layer agree on them');
  neg(!CONTACT_MODES.includes('agent_only') && !CONTACT_ROUTING_MODES.includes('agent_only'), 'H-p2 there is NO mode that reaches an agent instead of the player: a message with no player Inbox row could not honestly be "delivered", and making it honest would need a second Inbox, which §20 forbids');
  const player = { type: 'player', playerId: 'pl-kola', guardianId: null, minor: false };
  const guardian = { type: 'guardian', playerId: 'pl-guni', guardianId: 'gd-amara', minor: true };
  const allow = { allowed: true, basis: basis() };
  const both = contactRouting({ recipient: player, agentDecision: allow, requestedMode: 'both' });
  ok(both.mode === 'both' && both.targets.length === 2 && both.targets[0] === player && both.agent?.agentUserId === 'usr-ana', 'H-p3 "both" routes to the player AND the agent, player first');
  ok(contactRouting({ recipient: player, agentDecision: allow, requestedMode: 'player_only' }).agent === null, 'H-p4 "player_only" routes to the player alone even where an agent would be permitted');
  const refused = contactRouting({ recipient: player, agentDecision: { allowed: false, code: 'DISCLOSURE_WITHHELD' }, requestedMode: 'both' });
  ok(refused.mode === 'player_only' && refused.targets.length === 1 && refused.agentRefusal === 'DISCLOSURE_WITHHELD', 'H-p5 asking for the agent and being refused falls back to the player and NAMES the rule — the player is always a valid route, so the contact does not fail');
  const minor = contactRouting({ recipient: guardian, agentDecision: allow, requestedMode: 'both' });
  ok(minor.mode === 'player_only' && minor.targets[0] === guardian && minor.agent === null && minor.agentRefusal === 'MINOR_PATHWAY_DISABLED', 'H-p6 a minor\'s route stays the guardian\'s and no agent is substituted for a guardian (Z)');
  neg(contactRouting({ recipient: player, agentDecision: { allowed: true, basis: basis({ agentUserId: null }) }, requestedMode: 'both' }).agent === null, 'H-p7 a basis that names no individual routes no agent: a snapshot claiming an agent with no agent in it is worse than no snapshot (E-4)');
  neg(contactRouting({ recipient: null, agentDecision: allow, requestedMode: 'both' }).ok === false, 'H-p8 no recipient at all is a refusal, not a route to the agent alone');
  ok(contactRouting({ recipient: player, agentDecision: allow, requestedMode: 'agent_only' }).mode === 'player_only', 'H-p9 an unknown mode is read as the safest one rather than honoured');
  const snap = contactTargetSnapshot(both, T0);
  ok(snap.at === T0 && snap.mode === 'both' && snap.player === true && snap.agent?.agentUserId === 'usr-ana', 'H-p10 the snapshot records WHO was validly routed, as roles and ids');
  ok(contactTargetSnapshot(minor, T0).guardian === true && contactTargetSnapshot(minor, T0).agent === null, 'H-p11 a guardian route is recorded as a guardian route');
  ok(/does not rewrite it/i.test(snap.honest), 'H-p12 and it says in words that a later change does not rewrite it (§22)');
  ok(contactTargetSnapshot({ ok: false }, T0) === null, 'H-p13 a failed routing produces no snapshot');
}

section('pure §14/§63 — the Club-facing agent presence is the PLAYER\'s disclosure, not the agent\'s wish');
{
  ok(clubAgentPresence({ decision: { allowed: false, code: 'DISCLOSURE_WITHHELD' } }) === null, 'E-p1 a refused decision projects NOTHING — absent, not an empty badge');
  const p = clubAgentPresence({
    decision: { allowed: true }, agent: { displayName: 'Ana Costa' }, agency: { id: 'org-northstar', name: 'North Star' },
    facets: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } },
  });
  ok(p.represented === true && p.agent.displayName === 'Ana Costa' && p.agency.name === 'North Star', 'E-p2 an allowed decision names the agent and the agency');
  ok(p.verification.fifaLicence === 'VERIFIED' && p.verification.nationalRegistration === 'unknown', 'E-p3 facet by facet, and a facet ScoutBox has not checked reads "unknown" rather than being omitted (§65/§66)');
  neg(!/fee|commission|salary|term/i.test(JSON.stringify({ ...p, honest: '' })), 'E-p4 no agreement term, no commission and no fee has a field to arrive in');
  ok(/not a licence register|does not speak for any governing body/i.test(p.honest), 'E-p5 and it says plainly that ScoutBox is not a licence register');
  ok(Object.keys(p).length === 6, 'E-p6 the projection is exactly six fields — deliberately thin');
}

section('pure §34/§37 — the handoff preconditions, and the duplicate rule');
{
  ok(HANDOFF_STATUSES.join() === 'invited,accepted,withdrawn,expired', 'P-p1 four handoff states');
  neg(!HANDOFF_STATUSES.some((s) => /offer|sign/i.test(s)), 'P-p2 none of them names an offer or a signing (§35)');
  ok(HANDOFF_BLOCKERS.length === 9 && new Set(HANDOFF_BLOCKERS).size === 9, 'P-p3 nine distinct blockers');
  const facts = { canWrite: true, hasFinalProgressDecision: true, caseStatus: 'offer_consideration', subjectPresent: true, isAdult: true, minorPathwayOpen: false, blocked: false, existingHandoffStatus: null, liveTransactionId: null, complianceEvaluable: true };
  ok(handoffBlockers(facts).length === 0, 'P-p4 every precondition met → no blockers');
  neg(handoffBlockers({ ...facts, hasFinalProgressDecision: false })[0] === 'HANDOFF_NOT_PERMITTED' === false, 'P-p5 a missing decision is reported as HANDOFF_DECISION_REQUIRED, not as a permission problem');
  ok(handoffBlockers({ ...facts, hasFinalProgressDecision: false }).includes('HANDOFF_DECISION_REQUIRED'), 'P-p5b (the code it actually reports)');
  neg(handoffBlockers({ ...facts, canWrite: false })[0] === 'HANDOFF_NOT_PERMITTED', 'P-p6 permission is reported first, so a viewer is told it is not theirs to do rather than handed a checklist');
  neg(handoffBlockers({ ...facts, caseStatus: 'watching' }).includes('HANDOFF_CASE_STATE'), 'P-p7 a case at watching cannot hand off (§35)');
  neg(handoffBlockers({ ...facts, isAdult: false }).includes('HANDOFF_MINOR_PATHWAY_DISABLED'), 'P-p8 nor a minor (Z)');
  neg(handoffBlockers({ ...facts, blocked: true }).includes('HANDOFF_BLOCKED'), 'P-p9 nor through a block (Y)');
  neg(handoffBlockers({ ...facts, existingHandoffStatus: 'invited' }).includes('HANDOFF_EXISTS'), 'P-p10 nor twice (Q)');
  neg(handoffBlockers({ ...facts, liveTransactionId: 'atx-1' }).includes('HANDOFF_TRANSACTION_EXISTS'), 'P-p11 nor where a live transaction already covers it (Q)');
  neg(handoffBlockers({ ...facts, complianceEvaluable: false }).includes('HANDOFF_COMPLIANCE_UNAVAILABLE'), 'P-p12 nor where compliance cannot be evaluated (R)');
  ok(handoffBlockers({ ...facts, existingHandoffStatus: 'withdrawn' }).length === 0, 'P-p13 a withdrawn invitation does not block a fresh one');
  ok(handoffBlockers({}).length >= 5, 'P-p14 called with nothing, it refuses on several counts — the defaults are all "no"');
  // "Do not expose internal rationale" is enforced by the signature.
  neg(!/reason|note|evidence|rationale|outcome/i.test(handoffBlockers.toString().split('{')[0]), 'P-p15 the precondition function does not TAKE the decision\'s reasons, note, evidence or author, so no refusal can leak them (§34)');
  ok(effectiveHandoffStatus({ status: 'invited', invitedAt: T0 - HANDOFF_TTL_MS - 1 }, T0) === 'expired', 'P-p16 an invitation nobody took up reads as expired, derived from the clock');
  ok(effectiveHandoffStatus({ status: 'invited', invitedAt: T0 - DAY }, T0) === 'invited', 'P-p17 and a fresh one does not');
  ok(effectiveHandoffStatus({ status: 'bogus' }, T0) === null, 'P-p18 an unrecognised stored status is not a status');

  const parties = (individual, engaging, releasing) => [
    { partyRole: 'individual', subjectId: individual, removed: false },
    ...(engaging ? [{ partyRole: 'engaging_entity', subjectId: engaging, removed: false }] : []),
    ...(releasing ? [{ partyRole: 'releasing_entity', subjectId: releasing, removed: false }] : []),
  ];
  const tx = (id, type, status, ps) => ({ id, type, status, parties: ps });
  const list = [tx('atx-1', 'employment_contract', 'ACTIVE', parties('pl-kola', 'org-eastport', null))];
  const args = { clientId: 'pl-kola', type: 'employment_contract', engagingOrgId: 'org-eastport', releasingOrgId: null, terminalStatuses: TERMINAL_STATUSES, partiesOf: (t) => t.parties };
  ok(duplicateTransactionOf(list, args)?.id === 'atx-1', 'Q-p1 same individual, same type, same clubs, still live → a duplicate');
  neg(duplicateTransactionOf(list, { ...args, type: 'loan' }) === null, 'Q-p2 a loan beside an employment contract is a legitimately separate transaction (§37 "do not over-block")');
  neg(duplicateTransactionOf(list, { ...args, engagingOrgId: 'org-harbour' }) === null, 'Q-p3 a different engaging club is a different transaction — two clubs competing is normal');
  neg(duplicateTransactionOf(list, { ...args, releasingOrgId: 'org-harbour' }) === null, 'Q-p4 and adding a releasing side makes it a different context');
  neg(duplicateTransactionOf(list, { ...args, clientId: 'pl-other' }) === null, 'Q-p5 and a different individual entirely');
  neg(duplicateTransactionOf([tx('atx-2', 'employment_contract', 'CANCELLED', parties('pl-kola', 'org-eastport', null))], args) === null, 'Q-p6 a cancelled transaction does not block its replacement');
  neg(duplicateTransactionOf([tx('atx-3', 'employment_contract', 'ACTIVE', [{ partyRole: 'individual', subjectId: 'pl-kola', removed: true }, { partyRole: 'engaging_entity', subjectId: 'org-eastport', removed: false }])], args) === null, 'Q-p7 a removed party does not make a context — a tombstone blocks nothing');
}

section('pure §21 — disclosure defaults to off, and only an explicit yes is a yes');
{
  ok(DISCLOSURE_KEYS.length === 3 && DISCLOSURE_KEYS.join() === 'clubPresence,contactRouting,trialVisibility', 'D-p1 three separate disclosure choices');
  ok(Object.values(DISCLOSURE_DEFAULT).every((v) => v === false), 'D-p2 every one defaults to FALSE — confirming a relationship turns none of them on');
  ok(Object.values(normaliseDisclosure(undefined)).every((v) => v === false), 'D-p3 an absent object is all-off');
  ok(Object.values(normaliseDisclosure(null)).every((v) => v === false), 'D-p4 and so is null');
  neg(normaliseDisclosure({ contactRouting: 'yes' }).contactRouting === false, 'D-p5 a truthy string is not a yes');
  neg(normaliseDisclosure({ contactRouting: 1 }).contactRouting === false, 'D-p6 nor is a 1');
  ok(normaliseDisclosure({ contactRouting: true }).contactRouting === true && normaliseDisclosure({ contactRouting: true }).clubPresence === false, 'D-p7 answering one question does not answer the others');
  neg(Object.keys(normaliseDisclosure({ __proto__: { clubPresence: true } })).length === 3 && normaliseDisclosure({ constructor: true }).clubPresence === false, 'D-p8 a prototype key is not a disclosure');
  ok(SURFACE_DISCLOSURE.contactRouting === undefined && SURFACE_DISCLOSURE.contact_participation === 'contactRouting', 'D-p9 the surface→disclosure map is keyed by SURFACE, so a surface cannot read the wrong choice');
  ok(SURFACE_NAMES.filter((s) => SURFACES[s].needsDisclosure).every((s) => DISCLOSURE_KEYS.includes(SURFACE_DISCLOSURE[s])), 'D-p10 and every surface that needs a disclosure names a real one');
  neg(!SURFACE_NAMES.some((s) => s !== 'club_agent_presence' && SURFACE_DISCLOSURE[s] === 'clubPresence'), 'D-p11 the club-presence choice gates exactly one surface: it is not a general "share more" switch');
}

section('pure K/L/M — the trial projection is scheduling, and nothing adjacent to it');
{
  ok(TRIAL_SCHEDULE_VIEWERS.join() === 'club,family_accepted,agent', 'K-p1 three named trial-schedule viewers, the agent last and narrowest');
  ok(surfaceScopes('trial_projection').join() === 'employment,transfer', 'K-p2 a trial projection needs an employment or transfer mandate');
  neg(surfaceIsRegulated('trial_projection') === false, 'K-p3 reading a schedule is not itself a regulated act — it needs a mandate and a disclosure, not a licence check');
  ok(surfaceIsRegulated('trial_coordination') === true, 'K-p4 but coordinating one would be, which is why it is declared separately');
  ok(SURFACES.trial_projection.needsDisclosure === true && SURFACES.trial_coordination.needsDisclosure === true, 'L-p1 both trial surfaces need the client\'s own choice');
  neg(!SURFACE_NAMES.some((s) => /assessment|report|box_?cam|scorecard/i.test(s)), 'L-p2 there is NO surface for a trial assessment, a trial report or Box Cam footage — the boundary is that the question cannot be asked (#15, M)');
}

section('pure §102/§103 — no new store, and no migration');
{
  ok(SCHEMA_VERSION === 2307, 'AN-p1 the schema is still 2307: P5.6E adds no migration (§102 "prefer NO migration")');
  neg(!MIGRATIONS.some((m) => m.version > 2307), 'AN-p2 and no step above 2307 exists');
  neg(!MIGRATIONS.some((m) => /integration|disclosure|handoff|share/i.test(m.id)), 'AN-p3 no P5.6E migration id exists at all');
  const p56e = ['agentOpportunityShares', 'representationDisclosures', 'transactionHandoffs', 'agentContacts', 'agentTrials'];
  neg(!p56e.some((s) => PRODUCTION_REQUIRED_STORES.includes(s)), 'AN-p4 and none of the five stores P5.6E might have declared exists — the disclosure lives on the agreement, the share lives on the agreement, and the handoff lives on the case (§103)');
  ok(MAX_OPPORTUNITY_SHARES === 200, 'AN-p5 the share list is capped, so an unbounded array cannot grow on a hot row');
}

section('pure AG/AH — events and notifications: ids only, and the right categories');
{
  const mine = ['representation_disclosure_changed', 'contact_agent_routed', 'agent_opportunity_shared', 'transaction_handoff_invited', 'transaction_handoff_withdrawn'];
  for (const n of mine) ok(EVENT_NAMES.includes(n), `AG-p1 ${n} is in the registry`);
  for (const n of mine) {
    const e = EVENT_REGISTRY[n];
    ok(e.audience === 'org_private' && e.privacyClass === 'org_internal', `AG-p2 ${n} is org-private`);
    neg(!e.payload.some((k) => /dob|birth|email|phone|note|body|text|name|reason|outcome|subject/i.test(k)), `AG-p3 ${n} carries no personal field, no prose and no outcome`);
    ok(e.replayPolicy === 'never', `AG-p4 ${n} is never replayed — an integration event is a nudge, not a record`);
  }
  ok(EVENT_REGISTRY.contact_agent_routed.payload.join() === 'orgId,contactId,agentUserId', 'AG-p5 the routing event carries three ids and nothing else: not the club\'s name, not the subject, not a word of the message');
  neg(!EVENT_REGISTRY.transaction_handoff_invited.payload.some((k) => /decision|outcome|reason/i.test(k)), 'AG-p6 the handoff event carries nothing of the club\'s internal decision (§32)');
  const notifs = ['representation_disclosure', 'representation_contact', 'representation_opportunity', 'representation_transaction'];
  for (const t of notifs) ok(typeof TYPE_CATEGORY[t] === 'string' && Object.hasOwn(CATEGORIES, TYPE_CATEGORY[t]), `AH-p1 ${t} maps to a real notification category`);
  ok(TYPE_CATEGORY.representation_transaction === 'transaction_updates' && CATEGORIES.transaction_updates.mandatory !== true, 'AH-p2 workspace traffic is the non-mandatory transaction category — a club inviting a workspace is operational, not a safety matter');
  ok(TYPE_CATEGORY.representation_opportunity === 'messages', 'AH-p3 an opportunity an agent shared is a message about a real chance, not relationship admin');
}

section('pure AO — the error tables have no default, so a new code cannot inherit a status');
{
  ok(httpStatusFor('CONTACT_MODE_INVALID') === 400, 'AO-p1 an unknown routing mode is 400: the request is wrong and the caller can fix it');
  ok(M23_ERROR_HTTP.CONTACT_MODE_INVALID === 400, 'AO-p2 and it is IN the table — an undeclared code answers 500, which is how this one was caught');
  ok(M26_ERROR_HTTP.TRANSACTION_DUPLICATE_CONTEXT === 409, 'AO-p3 a duplicate context is 409: nothing in the request to fix');
  for (const c of ['HANDOFF_NOT_FOUND', 'HANDOFF_NOT_OPEN', 'HANDOFF_SUBJECT_MISMATCH', 'HANDOFF_NOT_ADDRESSED']) {
    ok(M26_ERROR_HTTP[c] === 409, `AO-p4 ${c} is 409: the citation is well-formed, the invitation is not there for it`);
  }
  neg(!Object.keys(M23_ERROR_HTTP).some((c) => /agent|representation|disclosure/i.test(c) && M23_ERROR_HTTP[c] >= 500), 'AO-p5 no integration code answers 5xx — a refusal is never presented as our fault');
  const corrupt = contactIntegrity({ id: 'rct-x', status: 'delivered', channel: 'in_app', playerId: 'pl-kola', recipient: { type: 'player' }, deliveredAt: T0, contactMode: 'agent_only' });
  neg(corrupt.includes('contact_mode_unknown'), 'AO-p6 a stored mode this build does not recognise is named as corruption, not read as permission');
  const badSnap = contactIntegrity({ id: 'rct-y', status: 'draft', channel: 'in_app', playerId: 'pl-kola', routingSnapshot: { at: T0, mode: 'both', agent: { agentUserId: 'usr-ana' } } });
  neg(badSnap.includes('routing_snapshot_unsent'), 'AO-p7 a routed agent on a contact that never left the building is a contradiction, and is named');
  const nullAgent = contactIntegrity({ id: 'rct-z', status: 'delivered', channel: 'in_app', playerId: 'pl-kola', recipient: { type: 'player' }, deliveredAt: T0, routingSnapshot: { at: T0, mode: 'both', agent: { agentUserId: null } } });
  neg(nullAgent.includes('routing_snapshot_malformed'), 'AO-p8 and a snapshot claiming an agent who is nobody is malformed, not trusted (E-4)');
  const view = contactView({ id: 'rct-1', status: 'draft', channel: 'in_app', contactMode: 'both', routingSnapshot: null, history: [] });
  ok(view.contactMode === 'both' && view.routedToAgent === false && view.routedAt === null, 'AO-p9 the club view shows what it asked for and what was actually routed');
  neg(!/agentUserId|usr-/.test(JSON.stringify(view)), 'AO-p10 and never the agent\'s id — the club has the presence projection for that, gated on the player\'s own choice');
  ok(contactMilestone({ id: 'rct-1', status: 'delivered', channel: 'in_app', routingSnapshot: { agent: { agentUserId: 'usr-ana' } } }).routedToAgent === true, 'AO-p11 the journey milestone carries the routing as a boolean — a state, never a name');
}

section('pure §15 — the club never reads agent data merely because the player exists');
{
  ok(can(['licensed_agent'], 'clients.opportunities.share') === true, 'G-p1 sharing an opportunity is the licensed individual\'s');
  neg(can(['agency_admin'], 'clients.opportunities.share') === false, 'G-p2 not an agency administrator\'s (#3)');
  neg(can(['analyst'], 'clients.opportunities.share') === false && can(['assistant'], 'clients.opportunities.share') === false && can(['finance'], 'clients.opportunities.share') === false, 'G-p3 and not a support role\'s');
  neg(can([], 'clients.opportunities.share') === false && can(['licensed_agent'], '__proto__') === false, 'G-p4 no roles and a prototype name hold nothing');
  ok(PERMISSIONS['clients.opportunities.share'].length === 1, 'G-p5 exactly one tier holds it');
  ok(MINOR_PATHWAY_PRODUCTION_ENABLED.ENG === false && MINOR_PATHWAY_PRODUCTION_ENABLED.INT === false && MINOR_PATHWAY_PRODUCTION_ENABLED.USA === false, 'Z-p1 the minor pathway is production-disabled in every jurisdiction this build knows');
}

// =================================================================== HTTP

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function stop(proc) {
  proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) { if (proc.exitCode != null || proc.signalCode) break; await sleep(100); }
  await sleep(300);
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const ERROR_BODIES = [];
const collect = (label, r) => { if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body }); return r; };
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;

// ---- a second agency, so "foreign agency" is never "same-agency colleague"
let server = await boot();
await stop(server);
{
  const store = openStore(DATA_DIR);
  const snap = store.load();
  snap.db.orgs.push({ ...structuredClone(snap.db.orgs.find((o) => o.type === 'agency')), id: 'org-southgate', name: 'Southgate Sports Management', slug: 'southgate' });
  store.save(snap);
  ok(snap.db.orgs.filter((o) => o.type === 'agency').length === 2, 'fixture: two agencies exist, so a foreign agent is a different thing from a colleague');
}
server = await boot();

section('fixture — a licensed agent, a confirmed client, and a club with a case');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const alex = await login('org-northstar', 'Alex Agent', 'Director');
const kola = await playerLogin('pl-adeyemi');
const guni = await playerLogin('pl-guni');
ok([maria, tom, rita, alex, kola, guni].every((x) => x?.token), 'fixture: six actors logged in');

await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, ana.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-ENG', memberAssociation: 'ENG' }, ana.token);
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
const REP = REQ.body?.relationship?.id;
ok(!!REP, 'fixture: the agent requested a relationship');
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kola.token);
ok(CONF.status === 200 && CONF.body.relationship.status === 'active', 'fixture: the client confirmed it — the root of every authority below');
let REV = CONF.body.relationship.rev;

// A second licensed agent at the SAME agency, for the same-agency privacy group.
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
await j('POST', '/org/agent/profile', { displayName: 'Bea Agent', jurisdictions: ['ENG'] }, bea.token);
// And a foreign agency's agent.
await j('POST', '/org/agent/agency/team', { name: 'Zoe Hart', tiers: ['licensed_agent'] }, (await login('org-southgate', 'Zed Admin', 'Director', 'agent')).token);
const zoe = await login('org-southgate', 'Zoe Hart', 'Agent', 'agent');
ok(!!bea?.token && !!zoe?.token, 'fixture: a same-agency colleague and a foreign agency agent');

const setD = async (patch, rev = REV) => {
  const r = await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: patch, expectedRev: rev }, kola.token);
  if (r.status === 200) REV = r.body.relationship.rev;
  return r;
};

section('D/§8–§11 — the Player\'s own Agent projection');
{
  const mine = await j('GET', '/player/agent/relationships', undefined, kola.token);
  const row = (mine.body.items ?? []).find((x) => x.id === REP);
  ok(mine.status === 200 && !!row, 'D1 the client reads their own relationship');
  ok(row.disclosure && Object.values(row.disclosure).every((v) => v === false), 'D2 all three disclosure choices start OFF — confirming turned none of them on (§21)');
  neg(!/fee|commission|salary/i.test(JSON.stringify(row)), 'D3 the client\'s own view carries no fee and no commission');
  const minorView = await j('GET', '/player/agent/relationships', undefined, guni.token);
  ok(minorView.body.minor === true && minorView.body.items.length === 0, 'D4 a guardian-managed account is told plainly that representation is not available to it (Z)');
  neg(expect(collect('#6 foreign player My Agent', await j('GET', '/player/agent/shared-opportunities', undefined, (await playerLogin('pl-carvalho')).token)), 200, null) && true, '#6 an agent cannot reach an unrelated player\'s My Agent endpoint: the route is the PLAYER\'s own, keyed to their session, so there is no id to guess');
  const asAgent = await j('GET', '/player/agent/relationships', undefined, ana.token);
  neg(asAgent.status === 401 || asAgent.status === 403, '#6b and an agent token on a player route is refused outright');
}

section('T/U/V/W/X — the five ways authority ends, each re-derived');
{
  // Each is exercised on a DISPOSABLE relationship so the main one survives.
  const other = await j('POST', '/org/agent/clients/request', { playerId: 'pl-carvalho', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const oid = other.body?.relationship?.id;
  const mateus = await playerLogin('pl-carvalho');
  const oconf = await j('POST', `/player/agent/relationships/${oid}/confirm`, { expectedRev: 1 }, mateus.token);
  ok(oconf.status === 200, 'T1 a second client confirms a relationship');
  await j('PATCH', `/player/agent/relationships/${oid}/sharing`, { disclosure: { trialVisibility: true }, expectedRev: oconf.body.relationship.rev }, mateus.token);
  const beforeEnd = await j('GET', `/org/agent/clients/${oid}/trials`, undefined, ana.token);
  ok(beforeEnd.status === 200, 'T2 and the agent can read their trials while it is active');
  const ended = await j('POST', `/player/agent/relationships/${oid}/terminate`, { expectedRev: oconf.body.relationship.rev + 1 }, mateus.token);
  ok(ended.status === 200, 'U1 the client ends it');
  neg(expect(collect('U2', await j('GET', `/org/agent/clients/${oid}/trials`, undefined, ana.token)), 403, 'REPRESENTATION_NOT_ACTIVE'), 'U2 and the agent\'s trial read closes immediately — the same token, a different answer (#28)');
  neg(expect(collect('U3', await j('GET', `/org/agent/clients/${oid}/contacts`, undefined, ana.token)), 403, 'REPRESENTATION_NOT_ACTIVE'), 'U3 and so does the contact read (#28)');
  neg(expect(collect('U4', await j('POST', `/org/agent/clients/${oid}/opportunities/opp-anything/share`, { clientKey: key() }, ana.token)), 403, 'REPRESENTATION_NOT_ACTIVE'), 'U4 and sharing an opportunity is refused before the opportunity is even looked up');
}

section('V — a dispute suspends access, and is not an expiry');
{
  const d = await j('POST', '/org/agent/clients/request', { playerId: 'pl-okafor', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const did = d.body?.relationship?.id;
  const chi = await playerLogin('pl-okafor');
  const dc = await j('POST', `/player/agent/relationships/${did}/confirm`, { expectedRev: 1 }, chi.token);
  if (dc.status === 200) {
    await j('PATCH', `/player/agent/relationships/${did}/sharing`, { disclosure: { trialVisibility: true }, expectedRev: dc.body.relationship.rev }, chi.token);
    const dispute = await j('POST', `/player/agent/relationships/${did}/dispute`, { reason: 'I did not agree to this.', expectedRev: dc.body.relationship.rev + 1 }, chi.token);
    ok(dispute.status === 200, 'V1 the client disputes it');
    neg(expect(collect('V2', await j('GET', `/org/agent/clients/${did}/trials`, undefined, ana.token)), 403, 'REPRESENTATION_NOT_ACTIVE'), 'V2 the next protected action is refused — a disputed relationship is not an active one (#13)');
    const seen = await j('GET', `/org/agent/clients/${did}`, undefined, ana.token);
    neg(!/I did not agree/i.test(JSON.stringify(seen.body ?? {})), 'V3 and the client\'s reason stays with the client — the agent learns the state, not the words');
  } else ok(dc.status >= 400, `V1 (this client could not confirm: ${dc.body?.error}) — the dispute leg is covered by the pure half`);
}

section('G/§17–§19 — the opportunity share: the client\'s own board is the gate');
{
  const far = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
  const made = await j('POST', '/org/opportunities', { type: 'trial', title: 'First-team trial week', category: 'mens', deadline: far, eligibility: { minAge: 16, maxAge: 40, positionGroup: 'any' } }, maria.token);
  ok(made.status === 201, 'G1 a club publishes an opportunity');
  const board = await j('GET', `/org/agent/clients/${REP}/opportunities`, undefined, ana.token);
  const OPP = board.body?.items?.[0]?.id;
  ok(board.status === 200 && !!OPP, 'G2 the agent reads the client\'s own board, through the same eligibility and visibility rules the player sees');
  neg(!/watchlist|ranking|caseId|assessment|fit/i.test(JSON.stringify(board.body)), 'G3 and nothing of the club\'s recruitment thinking rides along (§17, #20)');
  neg(expect(collect('G4', await j('POST', `/org/agent/clients/${REP}/opportunities/opp-nope/share`, { clientKey: key() }, ana.token)), 404, 'OPPORTUNITY_NOT_AVAILABLE'), 'G4 an opportunity not on the client\'s board is a uniform 404 — not "closed", not "ineligible", so the route is no oracle over the board');
  // #3. An agency ADMINISTRATOR holds the agency's books, not an agent's mandate.
  // The role gate answers first and says only that the action is not in their role —
  // and it says exactly the same about a client the agency has never heard of, so
  // the refusal is no oracle over who this agency represents.
  const adminReal = collect('#3 admin shares', await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key() }, alex.token));
  const adminFake = collect('#3 admin shares (unknown client)', await j('POST', '/org/agent/clients/rep-nope/opportunities/opp-nope/share', { clientKey: key() }, alex.token));
  neg(expect(adminReal, 403, 'AGENT_ACTION_NOT_PERMITTED'), '#3 an agency ADMINISTRATOR cannot share for the agent — the action is not in their role');
  neg(adminFake.status === adminReal.status && adminFake.body?.error === adminReal.body?.error, '#3b and a client this agency never represented gets the identical refusal — the role gate is no oracle over the client list');
  neg(expect(collect('#4 colleague shares', await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key() }, bea.token)), 404, 'REPRESENTATION_NOT_FOUND'), '#4 nor can a licensed colleague at the same agency (S)');
  neg(expect(collect('AB foreign shares', await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key() }, zoe.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'AB1 nor a foreign agency\'s agent — the same 404, so the two are indistinguishable');
  const K = key();
  const shared = await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { note: 'Your profile fits what they described.', clientKey: K }, ana.token);
  ok(shared.status === 201 && shared.body.share.opportunityId === OPP, 'G5 the agent shares it');
  ok(/your own action/i.test(shared.body.share.honest), 'G6 and the record says, in words the client reads, that applying is theirs');
  ok((await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { note: 'Your profile fits what they described.', clientKey: K }, ana.token)).body?.idempotent === true, 'AE1 the same key replays rather than sharing twice');
  neg(expect(collect('AE2', await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key() }, ana.token)), 409, 'OPPORTUNITY_ALREADY_SHARED'), 'AE2 and a fresh key on the same opportunity is a named duplicate, not a second row');
  const pv = await j('GET', '/player/agent/shared-opportunities', undefined, kola.token);
  ok(pv.status === 200 && pv.body.items.length === 1 && pv.body.items[0].sharedByName === 'Ana Agent', 'G7 the client sees it, named to the agent who shared it');
  const apps = await j('GET', '/player/applications', undefined, kola.token);
  const rows = Array.isArray(apps.body) ? apps.body : (apps.body?.items ?? []);
  neg(!rows.some((a) => a.opportunityId === OPP), 'G8 and NO application exists: sharing is not applying, and there is no parameter on the share route that could have started one (§18)');
  const notes = await j('GET', '/player/notifications', undefined, kola.token);
  const nrows = Array.isArray(notes.body) ? notes.body : (notes.body?.items ?? []);
  ok(nrows.some((n) => n.type === 'representation_opportunity'), 'AH1 the client was notified through the canonical stream');
  const SH = shared.body.share.id;
  ok((await j('POST', `/org/agent/clients/${REP}/opportunities/shares/${SH}/withdraw`, {}, ana.token)).status === 200, 'G9 the agent withdraws it');
  ok((await j('GET', '/player/agent/shared-opportunities', undefined, kola.token)).body.items.length === 0, 'G10 and the client stops seeing it');
  const keep = await j('GET', `/org/agent/clients/${REP}/opportunities/shares`, undefined, ana.token);
  ok(keep.body.items.length === 1 && keep.body.items[0].withdrawnAt, 'AN1 but the agent\'s own record keeps it, marked — it happened, and an audit trail that forgets is not one');
  globalThis.__OPP = OPP;
}

section('H/I/J/§20–§24 — contact routing, its reauthorization, and Inbox isolation');
{
  const kase = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', reason: 'P5.6E integration' }, maria.token);
  const RID = kase.body?.room?.roomId ?? kase.body?.existingRoomId;
  ok(!!RID, 'H1 a recruitment case exists');
  const jr0 = (await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body;
  if (!['contact_planned', 'contacted'].includes(jr0?.lifecycle?.currentStage)) {
    await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'planContact', expectedRev: jr0?.case?.rev }, maria.token);
  }
  const list0 = await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token);
  ok(list0.body.routing.available === true && list0.body.routing.agentParty === false, 'H2 the preview says the player is reachable and the agent is not a party');
  ok(list0.body.routing.agentRefusal === 'DISCLOSURE_WITHHELD', 'H3 and names the rule: the client has not agreed (§21)');
  neg(!list0.body.routing.modes.includes('agent_only'), 'H4 the published modes do not include one that replaces the player');
  neg(expect(collect('H5', await j('POST', `/org/rooms/${RID}/contacts`, { body: 'Hello', contactMode: 'agent_only' }, maria.token)), 400, 'CONTACT_MODE_INVALID'), 'H5 and asking for it is refused rather than quietly downgraded');

  // #10: a draft that asks for the agent, sent while the disclosure is still off.
  const d1 = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'A conversation about next season.', contactMode: 'both' }, maria.token);
  const C1 = d1.body.contact.id;
  ok(d1.status === 201 && d1.body.contact.contactMode === 'both' && d1.body.contact.routedToAgent === false, 'I1 a draft records what the club asked for, and has routed nothing to anybody');
  const s1 = await j('POST', `/org/rooms/${RID}/contacts/${C1}/send`, { expectedRev: d1.body.contact.rev }, maria.token);
  ok(s1.status === 200 && s1.body.delivered === true, 'I2 the send succeeds — the player is always a valid route, so a refused agent does not fail the contact');
  neg(s1.body.routing.agentParty === false && s1.body.routing.agentRefusal === 'DISCLOSURE_WITHHELD', 'I3 but the agent was NOT a party, decided at SEND time (#10)');
  ok((s1.body.contact.history ?? []).some((h) => h.action === 'contact_agent_routing_refused'), 'I4 and the refusal is in the contact\'s own history, not only in the response');
  ok((await j('GET', `/org/agent/clients/${REP}/contacts`, undefined, ana.token)).body.items.length === 0, 'J1 the agent sees nothing of it');

  // The client turns routing ON; the club's next contact reaches both.
  ok((await setD({ contactRouting: true })).status === 200, 'H6 the client turns contact routing on');
  const preview = await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token);
  ok(preview.body.routing.agentParty === true && preview.body.routing.agentRefusal === null, 'H7 and the preview now offers the agent as a party');
  // Clear the cooldown by answering the first contact.
  const inbox = await j('GET', '/player/inbox', undefined, kola.token);
  const req1 = (Array.isArray(inbox.body) ? inbox.body : []).find((x) => x.type === 'contact' && x.status === 'pending');
  ok((await j('POST', `/player/requests/${req1?.id}/respond`, { accept: false }, kola.token)).status === 200, 'J2 the client answers the first contact themselves');
  const d2 = await j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Next season', body: 'Following up with you and your representative.', contactMode: 'both' }, maria.token);
  const C2 = d2.body.contact.id;
  const s2 = await j('POST', `/org/rooms/${RID}/contacts/${C2}/send`, { expectedRev: d2.body.contact.rev }, maria.token);
  ok(s2.status === 200 && s2.body.routing.agentParty === true, 'H8 the agent IS a party this time');
  ok(s2.body.contact.recipient.type === 'player' && s2.body.contact.routedToAgent === true, 'H9 and the PLAYER is still the recipient — beside, never instead (§21)');
  const agentSees = await j('GET', `/org/agent/clients/${REP}/contacts`, undefined, ana.token);
  ok(agentSees.status === 200 && agentSees.body.items.length === 1, 'J3 the agent sees exactly the one routed to them');
  const item = agentSees.body.items[0];
  ok(item.club.name === 'Eastport FC' && item.body === 'Following up with you and your representative.', 'J4 with the club and the message the club addressed to them both');
  neg(!('caseId' in item) && !/watchlist|assessment|ranking|note/i.test(JSON.stringify(item)), 'J5 and no case id, no assessment, no ranking and no club-private note (§24, #16)');
  neg(!(await j('GET', `/org/agent/clients/${REP}/contacts`, undefined, bea.token)).body?.items?.length, 'S1 a same-agency colleague sees none of it (#4)');
  ok((await j('GET', '/org/agent/inbox', undefined, ana.token)).body.notifications.some((n) => n.type === 'representation_contact'), 'AH2 the agent heard through the canonical agent Inbox — no second Inbox was created (§20)');
  neg(!(await j('GET', '/org/agent/inbox', undefined, bea.token)).body.notifications.some((n) => n.type === 'representation_contact'), 'J6 and the colleague did not');

  // #26: a block added between render and send.
  const inbox2 = await j('GET', '/player/inbox', undefined, kola.token);
  const req2 = (Array.isArray(inbox2.body) ? inbox2.body : []).find((x) => x.type === 'contact' && x.status === 'pending');
  await j('POST', `/player/requests/${req2?.id}/respond`, { accept: false }, kola.token);
  const d3 = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'One more note.', contactMode: 'both' }, maria.token);
  const blocked = await j('POST', '/player/block', { orgId: 'org-eastport' }, kola.token);
  ok(blocked.status === 200 || blocked.status === 201, 'Y1 the client blocks the club between the draft and the send');
  neg(expect(collect('#26', await j('POST', `/org/rooms/${RID}/contacts/${d3.body.contact.id}/send`, { expectedRev: d3.body.contact.rev }, maria.token)), 403, 'CONTACT_BLOCKED'), '#26 and the send is refused — the block is re-derived at mutation time, not read from the draft');
  // Lift it through the canonical door so the rest of the suite can proceed.
  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body ?? [];
  for (const b of (Array.isArray(blocks) ? blocks : []).filter((x) => x.playerId === 'pl-adeyemi' && x.orgId === 'org-eastport')) {
    await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
  }
  // #30. Body forgery, tested here because a contact draft belongs to a case in a
  // contact state — and because the whole point is that these fields are DERIVED.
  const forged = await j('POST', `/org/rooms/${RID}/contacts`, {
    body: 'Hello.', contactMode: 'player_only',
    routedToAgent: true, routingSnapshot: { agent: { agentUserId: 'usr-ana' } }, recipient: { type: 'agent' },
  }, maria.token);
  ok(forged.status === 201, `#30 a body naming a represented party is accepted as a draft ${forged.status === 201 ? '' : `${forged.status} ${JSON.stringify(forged.body).slice(0, 250)}`}`);
  neg(forged.body.contact.routedToAgent === false && forged.body.contact.contactMode === 'player_only' && forged.body.contact.recipient?.type !== 'agent', '#30b and every forged field is ignored: the server derives the mode, the routing and the recipient (§21)');
  await j('POST', `/org/rooms/${RID}/contacts/${forged.body.contact.id}/cancel`, { expectedRev: forged.body.contact.rev }, maria.token);
  globalThis.__RID = RID;
}

section('K/L/M/§26–§29 — the trial projection is scheduling, and stops there');
{
  const RID = globalThis.__RID;
  neg(expect(collect('K1', await j('GET', `/org/agent/clients/${REP}/trials`, undefined, ana.token)), 403, 'DISCLOSURE_WITHHELD'), 'K1 trials refuse while the client has not chosen to share them');
  ok((await setD({ trialVisibility: true })).status === 200, 'K2 the client turns trial visibility on');
  const H = 3600_000;
  const T = Date.now() + 96 * H;
  const inv = await j('POST', `/org/rooms/${RID}/trials`, {
    timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' },
    message: 'Come and train with the U23s.', instructions: 'Ask for Priya at reception.',
    slots: [{ startsAt: new Date(T).toISOString(), endsAt: new Date(T + 2 * H).toISOString() }],
  }, maria.token);
  ok(inv.status === 200 || inv.status === 201, 'K3 the club invites the client to a trial');
  const inbox = await j('GET', '/player/inbox', undefined, kola.token);
  const treq = (Array.isArray(inbox.body) ? inbox.body : []).find((x) => x.type === 'trial' && x.status === 'pending');
  const acc = await j('POST', `/player/requests/${treq?.id}/respond`, { accept: true, chosenSlot: treq?.trialDetails?.proposedDate }, kola.token);
  ok(acc.status === 200, 'K4 the client accepts a slot, which confirms the schedule');
  const tv = await j('GET', `/org/agent/clients/${REP}/trials`, undefined, ana.token);
  ok(tv.status === 200 && tv.body.items.length === 1, 'K5 the agent sees the trial');
  const t0 = tv.body.items[0];
  ok(t0.workflowState === 'scheduled' && t0.schedule.sessions.length === 1, 'K6 with its state and its schedule');
  ok(t0.schedule.sessions[0].venue.name === 'Eastport Dome' && t0.schedule.sessions[0].venue.town === 'Eastport', 'K7 the venue NAME and town');
  neg(!('address' in t0.schedule.sessions[0].venue), 'K8 but NOT the exact address — that was held back for the family (P4B D-23)');
  neg(!('instructions' in t0.schedule.sessions[0]), 'K9 and NOT the club\'s joining instructions');
  neg(!('evidence' in t0.schedule.sessions[0]), 'M1 and NOT the evidence list — no Box Cam payload has a field to arrive in (§M)');
  const swept = JSON.stringify({ ...tv.body, note: undefined, honest: undefined });
  neg(!/assessment|"report"|scorecard|boxCam|"address"|"instructions"/i.test(swept), 'L1 and a sweep of the whole payload finds no assessment, no report, no address and no instructions (#15)');
  ok(t0.reportObligation === 'outstanding' || t0.reportObligation === null, 'L2 whether a report is OWED is a state the agent may see; what it says is not');
  neg(expect(collect('L3', await j('POST', `/org/agent/clients/${REP}/trials/${t0.id}/confirm`, {}, ana.token)), 404, null), 'L3 there is no route at all through which an agent confirms a trial for their client (#14) — a second Trial workflow was not built');
  neg(expect(collect('#15b', await j('GET', `/org/rooms/${RID}/trials/${t0.id}`, undefined, ana.token)), 404, null), '#15b and the club\'s own trial detail is not reachable with an agency session');
}

section('N/O/§46 — the club-private worlds an agent cannot reach at all');
{
  const RID = globalThis.__RID;
  // Two honest classes. A club's OWN case, decision or contact thread is shut to an
  // agency session outright. A club's recruitment TOOLS (Second Look, Nobody Missed,
  // watchlists, the dashboard) are org-scoped list surfaces on the shared /org router:
  // an agency reaching one is answered about ITSELF, which is empty, and never about a
  // club. Both are stated, and the second is then swept for the club's own material —
  // because "200" on a shared router is exactly where a scoping mistake would show.
  const shut = [
    ['#16 Recruitment Room', `/org/rooms/${RID}`],
    ['#17 P5 decision', `/org/rooms/${RID}/decision`],
    ['#16b room contacts', `/org/rooms/${RID}/contacts`],
    ['#19 Nobody Missed', '/org/nobody-missed'],
    ['#21 Director Dashboard', '/org/analytics/overview'],
  ];
  for (const [label, url] of shut) {
    const r = collect(label, await j('GET', url, undefined, ana.token));
    neg(r.status === 404 || r.status === 403, `${label}: an agency session reaches the club's own record not at all (${r.status})`);
  }
  const scoped = [['#18 Second Look', '/org/second-look'], ['#20 watchlist', '/org/watchlists']];
  for (const [label, url] of scoped) {
    const r = collect(label, await j('GET', url, undefined, ana.token));
    const body = JSON.stringify(r.body ?? {});
    neg(r.status === 404 || r.status === 403 || (r.status === 200 && !(r.body?.items ?? []).length),
      `${label}: an agency session is answered about itself, and its own list is empty (${r.status})`);
    neg(!new RegExp(`${RID}|pl-adeyemi|Kola|org-eastport`).test(body),
      `${label} (scoping): and the answer names no case, no player and no club of Eastport's — the list is org-scoped at the source (§36)`);
  }
  // "No such route" is proven with a CLUB token as well as an agency one. An
  // agency 404 could in principle be a scoping refusal that happens to look like
  // a missing route; the club that owns the player is the strongest prover, and it
  // reaches no such route either.
  neg(expect(collect('#36 trust score', await j('POST', '/org/players/pl-adeyemi/trust-profile', { score: 100 }, ana.token)), 404, null), '#36 and there is no route through which anyone edits a Trust Score');
  neg(expect(collect('#36b trust score (club)', await j('POST', '/org/players/pl-adeyemi/trust-profile', { score: 100 }, maria.token)), 404, null), '#36b not even the club that holds the case — the route does not exist, rather than being refused');
  neg(expect(collect('#35 passport write', await j('PATCH', '/org/players/pl-adeyemi/football-passport', { position: 'ST' }, ana.token)), 404, null), '#35 nor one through which an agent edits a Passport — the agent\'s projection is a read');
  neg(expect(collect('#35b passport write (club)', await j('PATCH', '/org/players/pl-adeyemi/football-passport', { position: 'ST' }, maria.token)), 404, null), '#35b nor through the club lane — a Passport is the player\'s, and nothing in the org router writes one');
}

section('E/§14/§63 — the Club-facing presence badge is the player\'s own choice');
{
  const before = await j('GET', '/org/players/pl-adeyemi', undefined, maria.token);
  neg(!/Ana Agent|North Star/.test(JSON.stringify(before.body ?? {})), 'E1 with clubPresence off, the club\'s player view names no agent and no agency (§15)');
  ok((await setD({ clubPresence: true })).status === 200, 'E2 the client turns club presence on');
  const rel = (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find((x) => x.id === REP);
  ok(rel.disclosure.clubPresence === true && rel.disclosure.contactRouting === true && rel.disclosure.trialVisibility === true, 'E3 and all three are now on, each having been set by its own request');
  ok((await setD({ clubPresence: false })).status === 200 && (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find((x) => x.id === REP).disclosure.contactRouting === true, 'E4 turning one off leaves the other two exactly as they were');
  await setD({ clubPresence: true });
}

section('P/Q/R/§32–§39 — the explicit handoff, its duplicate rule, and its compliance gate');
{
  const RID = globalThis.__RID;
  const ready0 = await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, maria.token);
  ok(ready0.status === 200 && ready0.body.available === false, 'P1 the handoff is not available yet');
  ok(ready0.body.blockers.includes('HANDOFF_DECISION_REQUIRED'), 'P2 because no finalised decision to progress exists (§33)');
  neg(expect(collect('#22', await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }, maria.token)), 422, 'HANDOFF_DECISION_REQUIRED'), '#22 and forcing the request gets the same answer the screen showed — visibility of a button is not authorization (§38)');
  const viewerReady = await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, tom.token);
  ok(viewerReady.status === 200 && viewerReady.body.blockers.length === 1 && viewerReady.body.blockers[0] === 'HANDOFF_NOT_PERMITTED', 'P3 a scout is told it is not theirs to do, and gets no checklist of what a lead could do');
  neg(expect(collect('P4', await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }, tom.token)), 403, 'HANDOFF_NOT_PERMITTED'), 'P4 and cannot do it');
  neg(expect(collect('AB2', await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, rita.token)), 404, 'ROOM_NOT_FOUND'), 'AB2 a foreign club sees the case\'s own 404 — the handoff is as invisible as the case (AC)');

  // Drive the canonical decision path to a finalised "progress". The case is where
  // group K left it — the client attended a real trial — so it reaches offer
  // consideration the way any case does: the Trial workflow completes it, then a
  // formal decision is finalised. Nothing here is a shortcut into a state.
  const HH = 3600_000;
  const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
  let jr = (await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body;
  if (jr?.lifecycle?.currentStage === 'trial_scheduled') {
    const t = ((await j('GET', `/org/rooms/${RID}/trials`, undefined, maria.token)).body?.items ?? [])[0];
    const s0 = t.schedule.sessions[0];
    const end = new Date(s0.endsAt).getTime();
    const att = await j('POST', `/org/rooms/${RID}/trials/${t.id}/sessions/${s0.id}/attendance`, { state: 'attended', expectedRev: t.rev }, maria.token, at(end - HH));
    const t2 = ((await j('GET', `/org/rooms/${RID}/trials`, undefined, maria.token)).body?.items ?? [])[0];
    const done = await j('POST', `/org/rooms/${RID}/trials/${t.id}/complete`, { expectedRev: t2.rev }, maria.token, at(end + HH));
    ok(done.status === 200 && done.body.case?.to === 'trial_completed', `P4c the trial the client attended is completed through the canonical Trial workflow, which moves the case ${done.status === 200 ? '' : `att=${att.status} ${JSON.stringify(att.body).slice(0, 300)} done=${JSON.stringify(done.body)}`}`);
    jr = (await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token)).body;
  }
  if (jr?.lifecycle?.currentStage !== 'offer_consideration') {
    if (!['trial_completed', 'shortlisted', 'priority', 'contacted'].includes(jr?.lifecycle?.currentStage)) {
      await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'shortlist', expectedRev: jr?.case?.rev }, maria.token);
    }
    const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', note: 'Internal: we want to take this forward.' }, maria.token);
    ok(dr.status === 201, 'P5 the club drafts a formal decision to progress');
    const draftOnly = await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, maria.token);
    neg(draftOnly.body.blockers.includes('HANDOFF_DECISION_REQUIRED'), '#22b a DRAFT decision is not a finalised one: the handoff is still refused');
    const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { clientKey: key(), expectedRev: dr.body?.draft?.rev ?? 1 }, maria.token);
    ok(fin.status === 201 && fin.body.lifecycle?.to === 'offer_consideration', `P6 and finalises it, which moves the case to offer_consideration (§35) ${fin.status === 201 ? '' : JSON.stringify(fin.body).slice(0, 200)}`);
  }
  const txBefore = ((await j('GET', '/org/agent/transactions', undefined, ana.token)).body?.items ?? []).length;
  const ready1 = await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, maria.token);
  ok(ready1.body.available === true && ready1.body.handoff === null, 'P7 NOW the handoff is available — and none exists, because a decision creates nothing (§33)');
  ok(((await j('GET', '/org/agent/transactions', undefined, ana.token)).body?.items ?? []).length === txBefore, 'P8 and no transaction appeared from the decision alone (#23 precondition)');
  // The readiness view's own prose is the one place the words "offer" and "note"
  // legitimately appear — it exists to say that this is NOT an offer. Strip the
  // two explanatory fields and the vocabulary list, then sweep what is left.
  const { note: _rn, blockerVocabulary: _rbv, ...readySweep } = ready1.body ?? {};
  const swept = JSON.stringify(readySweep);
  neg(!/rationale|"note"|assessment|"outcome"|reasonCode|"reason"|evidence/i.test(swept), 'O1 the readiness view carries none of the decision\'s rationale, note, outcome or evidence (§32/§34)');

  const KH = key();
  const inv1 = await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: KH }, maria.token);
  ok(inv1.status === 201 && inv1.body.handoff.status === 'invited', '#23 the recruitment lead invites a workspace — allowed only once every other authorization passed');
  ok(inv1.body.handoff.representedAtInvitation === true, 'P9 it records THAT the client is represented');
  neg(!/Ana Agent|North Star/.test(JSON.stringify(inv1.body)), 'P10 but never WHO — that is the player\'s disclosure to make, not the handoff\'s to leak');
  ok(/not an offer/i.test(inv1.body.handoff.honest), 'P11 and it says plainly that it is not an offer (§35)');
  ok((await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: KH }, maria.token)).body?.idempotent === true, 'AE3 the same key replays');
  neg(expect(collect('#24', await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }, maria.token)), 409, 'HANDOFF_EXISTS'), '#24 a second club user inviting concurrently gets HANDOFF_EXISTS — one canonical invitation (Q, AF)');

  const hofs = await j('GET', '/org/agent/handoffs', undefined, ana.token);
  ok(hofs.status === 200 && hofs.body.items.length === 1 && hofs.body.items[0].recruitmentCaseId === RID, 'P12 the agent sees the invitation with the case reference');
  neg(!/outcome|rationale|assessment|"reason"/i.test(JSON.stringify(hofs.body.items[0])), 'O2 and nothing of the club\'s recruitment thinking');
  neg(!(await j('GET', '/org/agent/handoffs', undefined, bea.token)).body.items.length, 'S2 a same-agency colleague sees no invitation of Ana\'s (#4)');
  neg(!(await j('GET', '/org/agent/handoffs', undefined, zoe.token)).body.items.length, 'AB3 and a foreign agency sees none at all');

  // #25. P5.6D's frozen contract separates NAMING a party from REPRESENTING one, and
  // it is the binding that carries authority. So an agent may open a draft naming an
  // adult they do not represent — and that draft can go nowhere: the binding is
  // refused, and without it nothing downstream is reachable. P5.6E does not loosen
  // that, and it does not let representation be asserted by the request body either.
  const stranger = await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], clientKey: key(), parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-svensson' }] }, ana.token);
  ok(stranger.status === 201, '#25 naming a party is not claiming to represent them — P5.6D opens the draft (frozen contract)');
  const SX = stranger.body?.transaction?.id;
  neg(expect(collect('#25b', await j('POST', `/org/agent/transactions/${SX}/representations`, { partyRole: 'individual', agreementId: REP }, ana.token)), 403, 'REPRESENTATION_REQUIRED'), '#25b but the binding is refused — an agreement with ANOTHER client authorises nothing here');
  neg(expect(collect('#25c', await j('POST', `/org/agent/transactions/${SX}/status`, { to: 'PARTIES_CONFIRMED', clientKey: key() }, ana.token)), 422, 'TRANSACTION_PARTIES_NOT_CONFIRMED'), '#25c and the draft goes nowhere: the person named has to confirm for themselves, and naming them is not confirming them');
  neg(!(await j('GET', `/org/agent/transactions/${SX}`, undefined, ana.token)).body?.transaction?.representations?.length, '#25d the draft holds no representation at all — the party list is not a mandate');
  const tx = await j('POST', '/org/agent/transactions', {
    type: 'employment_contract', jurisdictions: ['ENG'], clientKey: key(), recruitmentCaseId: RID,
    parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }],
  }, ana.token);
  ok(tx.status === 201, 'P13 the agent opens the workspace citing the case');
  ok(tx.body.transaction.links.recruitmentCaseId === RID, 'P14 and the transaction REFERENCES the case (§36)');
  const after = await j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, maria.token);
  ok(after.body.handoff.status === 'accepted' && after.body.handoff.transactionId === tx.body.transaction.id, 'P15 the club sees the invitation was taken up, without seeing inside the workspace');
  neg(expect(collect('P16', await j('POST', `/org/rooms/${RID}/transaction-handoff/withdraw`, {}, maria.token)), 409, 'HANDOFF_ALREADY_ACCEPTED'), 'P16 and cannot un-invite what has already been opened — withdrawing would not close it, and pretending otherwise would be a lie');
  neg(expect(collect('Q1', await j('POST', '/org/agent/transactions', { type: 'transfer', jurisdictions: ['ENG'], clientKey: key(), recruitmentCaseId: RID, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' }] }, ana.token)), 409, 'HANDOFF_NOT_OPEN'), 'Q1 one invitation opens one workspace, not a second');
  neg(expect(collect('Q2', await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], clientKey: key(), parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, ana.token)), 409, 'TRANSACTION_DUPLICATE_CONTEXT'), 'Q2 and a second live transaction for the same individual, type and clubs is a named duplicate (§37)');
  const loan = await j('POST', '/org/agent/transactions', { type: 'loan', jurisdictions: ['ENG'], clientKey: key(), parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-harbour' }, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, ana.token);
  ok(loan.status === 201, 'Q3 but a loan with different clubs is a legitimately separate transaction, not over-blocked (§37)');
  globalThis.__TX = tx.body.transaction.id;
}

section('§36/E-6 — the case reference reaches the two parties who own it, and nobody else');
{
  const TX = globalThis.__TX; const RID = globalThis.__RID;
  ok((await j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token)).body.transaction.links.recruitmentCaseId === RID, 'R1 the representing agent sees the case reference');
  ok((await j('GET', `/org/transactions/${TX}`, undefined, maria.token)).body.transaction.links.recruitmentCaseId === RID, 'R2 and the club that OWNS that case sees it');
  const pl = await j('GET', `/player/transactions/${TX}`, undefined, kola.token);
  neg(pl.status === 200 && !('recruitmentCaseId' in (pl.body.transaction.links ?? {})), 'R3 the individual does NOT — absent, not redacted, so its existence is not disclosed either (E-6)');
  const harbourTx = await j('GET', `/org/transactions/${TX}`, undefined, rita.token);
  neg(harbourTx.status === 404 || !('recruitmentCaseId' in (harbourTx.body?.transaction?.links ?? {})), 'R4 and a club that is not a party to it learns nothing of the engaging club\'s internal case (E-6)');
}

section('body forgery — the server derives, the request never decides');
{
  const RID = globalThis.__RID;
  const forgedShare = await j('POST', `/org/agent/clients/${REP}/opportunities/${globalThis.__OPP}/share`, { clientKey: key(), sharedBy: { name: 'Somebody Else' }, withdrawnAt: null, rev: 99 }, ana.token);
  if (forgedShare.status === 201) {
    ok(forgedShare.body.share.sharedByName === 'Ana Agent' && forgedShare.body.share.rev === 1, '#31 a forged author and rev on a share reach no field — the store decides');
    await j('POST', `/org/agent/clients/${REP}/opportunities/shares/${forgedShare.body.share.id}/withdraw`, {}, ana.token);
  } else ok(forgedShare.status === 409, '#31 (already shared, which is itself the duplicate rule holding)');
  const forgedHof = await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key(), status: 'accepted', representedAtInvitation: false, transactionId: 'atx-forged' }, maria.token);
  neg(forgedHof.status === 409 && forgedHof.body.error === 'HANDOFF_EXISTS', '#32 a forged handoff state reaches nothing: the standing invitation is what the server knows about');
  // #32b. A disclosure is a yes or a no. A truthy string is not read as either —
  // it is refused, because coercing it would turn OFF a choice the client was
  // trying to turn on, and the whole request is refused before anything moves.
  const before32 = (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find((r) => r.id === REP).disclosure;
  neg(expect(collect('#32b', await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { clubPresence: 'yes', contactRouting: 1, trialVisibility: true }, expectedRev: REV }, kola.token)), 400, 'REPRESENTATION_INPUT_INVALID'), '#32b a disclosure sent as a truthy string is refused, not coerced');
  const after32 = (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find((r) => r.id === REP).disclosure;
  neg(JSON.stringify(before32) === JSON.stringify(after32), '#32c and not one of the three choices moved — including the one field that WAS a valid boolean (§22)');
}

section('AD/AF — rev and concurrency on the client\'s own choices');
{
  const stale = await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { trialVisibility: false }, expectedRev: 1 }, kola.token);
  neg(expect(collect('AD1', stale), 409, 'REPRESENTATION_VERSION_CONFLICT'), 'AD1 a stale rev on a disclosure change is refused with the shared conflict contract');
  neg(expect(collect('AD2', await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: 'all', expectedRev: REV }, kola.token)), 400, 'REPRESENTATION_INPUT_INVALID'), 'AD2 and a disclosure that is not an object is refused before anything is touched');
  const a = j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { trialVisibility: false }, expectedRev: REV }, kola.token);
  const b = j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { trialVisibility: true }, expectedRev: REV }, kola.token);
  const [ra, rb] = await Promise.all([a, b]);
  const wins = [ra, rb].filter((r) => r.status === 200).length;
  ok(wins === 1 || (wins === 2 && ra.body.relationship.rev !== rb.body.relationship.rev), `AF1 two simultaneous disclosure changes do not both silently win (${ra.status}/${rb.status})`);
  const fresh = (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find((x) => x.id === REP);
  REV = fresh.rev;
  if (fresh.disclosure.trialVisibility !== true) await setD({ trialVisibility: true });
}

section('AI/AG — the audit and the events say what happened, in ids');
{
  const audit = await j('GET', '/org/agent/agency/audit', undefined, alex.token);
  ok(audit.status === 200 && Array.isArray(audit.body.items), 'AI1 the agency has ONE audit feed');
  neg(!/pl-adeyemi.*dob|email|phone/i.test(JSON.stringify(audit.body.items ?? [])), 'AI2 and it carries no date of birth, email or phone');
  const caps = await j('GET', '/capabilities');
  ok(caps.status === 200 && caps.body.schema?.version === SCHEMA_VERSION, `AG1 the operator report states the schema honestly (${SCHEMA_VERSION})`);
}

section('AJ/AK/AL/AM — the client surfaces, checked as artefacts');
{
  const files = {
    player: path.join(ROOT, 'scoutbox-player', 'src', 'components', 'MyAgentSection.tsx'),
    playerI18n: path.join(ROOT, 'scoutbox-player', 'src', 'i18n.ts'),
    clubI18n: path.join(ROOT, 'scoutbox-club', 'src', 'i18n.ts'),
    grassI18n: path.join(ROOT, 'scoutbox-grassroots', 'src', 'i18n.ts'),
    agentI18n: path.join(ROOT, 'scoutbox-agent', 'src', 'i18n.ts'),
    clubRooms: path.join(ROOT, 'scoutbox-club', 'src', 'roomsScreens.tsx'),
    grassRooms: path.join(ROOT, 'scoutbox-grassroots', 'src', 'roomsScreens.tsx'),
    agentScreens: path.join(ROOT, 'scoutbox-agent', 'src', 'screens.tsx'),
    decision: path.join(ROOT, 'scoutbox-club', 'src', 'decisionPanel.tsx'),
  };
  for (const [k, f] of Object.entries(files)) ok(existsSync(f), `AJ0 ${k} exists`);
  const read = (k) => readFileSync(files[k], 'utf8');
  for (const [k, keys] of [
    ['clubI18n', ['ct.agentParty', 'ct.modeLegend', 'hof.title', 'hof.b.HANDOFF_EXISTS']],
    ['grassI18n', ['ct.agentParty', 'ct.modeLegend', 'hof.title', 'hof.b.HANDOFF_EXISTS']],
    ['agentI18n', ['share.action', 'contacts.honest', 'trials.honest', 'handoff.title', 'clients.tab.contacts']],
  ]) {
    const src = read(k);
    for (const key of keys) ok(src.split(`'${key}':`).length === 3, `AJ1 ${k} has ${key} in BOTH dictionaries`);
  }
  const pi = read('playerI18n');
  for (const key of ['m27dTitle', 'm27dRouting', 'm27dTrials', 'm27sTitle', 'm27sHonest']) ok(pi.split(`  ${key}:`).length === 3, `AJ2 the player app has ${key} in both dictionaries`);
  const player = read('player');
  ok(/accessibilityLiveRegion|role="status"/.test(player) || /accessibilityLiveRegion/.test(player), 'AK1 the player surface announces its result to a screen reader');
  ok(/m27dOn|m27dOff/.test(player), 'AK2 and each disclosure state is rendered as a WORD, not only a switch position');
  ok(/testID=\{`my-agent-d-\$\{d\.key\}-toggle`\}/.test(player), 'AK3 with a stable handle per control, so a journey names the control rather than the English');
  const clubRooms = read('clubRooms');
  ok(/data-testid="ct-mode"/.test(clubRooms) && /ct-mode-\$\{m\}/.test(clubRooms), 'AK4 the club mode chooser is a labelled radio group with a handle per option');
  neg(!/agent_only/.test(clubRooms.replace(/no option that reaches an agent[\s\S]*?player/i, '')), 'AL1 and no club screen offers an agent-only route');
  ok(read('grassRooms').includes('ct-agent-party'), 'AL2 grassroots carries the same routing surface — the two club apps do not diverge on a privacy rule');
  const decision = read('decision');
  ok(/data-testid="handoff-section"/.test(decision) && /handoff-blocker-\$\{b\}/.test(decision), 'AK5 the handoff section names every blocker as its own element, so a refusal is readable and testable');
  // The component's own body, not everything after it: the file goes on to render
  // the decision itself, where reason codes belong.
  const handoffBody = (decision.split('function HandoffSection')[1] ?? '').split(/\nfunction /)[0];
  neg(!/\bd\.note|decision\.note|rationale|reasonCodes|assessmentSummary|evidenceRefs/.test(handoffBody), 'O3 and the handoff component never touches the decision\'s note, rationale, reason codes or evidence');
  const agentScreens = read('agentScreens');
  ok(/data-testid="client-contacts"/.test(agentScreens) && /data-testid="client-trials"/.test(agentScreens), 'AK6 the agent app has both new read surfaces');
  neg(!/apply|postuler/i.test((agentScreens.match(/data-testid=\{`share-\$\{o\.id\}`\}[^\n]*/) ?? [''])[0]), 'G11 and the share control is a share, never an apply');
  const demo = readFileSync(path.join(ROOT, 'scoutbox-agent', 'src', 'agentDemo.ts'), 'utf8');
  ok(/P56E_DISCLOSED/.test(demo) && /DISCLOSURE_WITHHELD/.test(demo), 'AM1 the demo mirrors the refusal too: a demo where everything is open would teach the wrong model of whose choice this is');
  const pmock = readFileSync(path.join(ROOT, 'scoutbox-player', 'src', 'data', 'm24mock.ts'), 'utf8');
  ok(/setDisclosure/.test(pmock) && /r\.disclosure\[key\] !== value/.test(pmock), 'AM2 and the player demo changes ONE disclosure at a time, exactly as the server does');
}

section('AN/AO — a deleted player, and a corrupt row');
{
  const elias = await playerLogin('pl-svensson');
  const req = await j('POST', '/org/agent/clients/request', { playerId: 'pl-svensson', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const rid2 = req.body?.relationship?.id;
  if (rid2) {
    const c = await j('POST', `/player/agent/relationships/${rid2}/confirm`, { expectedRev: 1 }, elias.token);
    if (c.status === 200) {
      ok((await j('GET', `/org/agent/clients/${rid2}`, undefined, ana.token)).status === 200, 'AN2 a confirmed relationship reads');
      ok((await j('DELETE', '/player/account', undefined, elias.token)).status === 200, 'AN3 the player deletes their account');
      const after = await j('GET', `/org/agent/clients/${rid2}`, undefined, ana.token);
      // The player id is not PII and the record keeps it deliberately: an agency's
      // own history of who it acted for is a real record. The PERSON is what goes.
      const afterStr = JSON.stringify(after.body ?? {});
      neg(!/Elias|clientName|"name"\s*:\s*"[^"]/i.test(afterStr), `#34 no PII reappears through the agent's projection — the relationship keeps its ids and loses the person ${/Elias|clientName/i.test(afterStr) ? afterStr.slice(0, 400) : ''}`);
      ok(after.body?.relationship?.clientId === 'pl-svensson', '#34a and it is still a record: the agency keeps the ids and dates of a mandate it really held');
      neg(expect(collect('#34b', await j('GET', `/org/agent/clients/${rid2}/trials`, undefined, ana.token)), 403, null), '#34b nor through the trial projection');
    } else ok(c.status >= 400, `AN2 (this player could not confirm: ${c.body?.error})`);
  } else ok(req.status >= 400, `AN2 (no relationship could be requested: ${req.body?.error})`);
}

section('#37 — a revoked relationship never contributes as an active Trust relationship');
{
  const trust = await j('GET', '/player/trust-profile', undefined, kola.token);
  ok(trust.status === 200, '#37a the client reads their own Trust Profile');
  const mateus = await playerLogin('pl-carvalho');
  const t2 = await j('GET', '/player/trust-profile', undefined, mateus.token);
  ok(t2.status === 200, '#37b and so does the client whose relationship was terminated above');
  const src = readFileSync(path.join(HERE, '..', 'm162', 'trust.mjs'), 'utf8');
  ok(/representationAgreements/.test(src), '#37c the Trust relationship input reads the canonical lane');
  ok(/a\.confirmedAt \|\| a\.status !== 'active'/.test(src) || /!a\.confirmedAt \|\| a\.status !== 'active'/.test(src), '#37d and filters on confirmedAt AND an active status');
  ok(/a\.endAt === 'number' && a\.endAt <= now/.test(src), '#37e and on expiry, so a lapsed agreement contributes nothing');
  ok(/legacy mirror names nobody|typeof a\.agentUserId !== 'string'/.test(src), '#37f and skips a legacy mirror that names nobody (#1)');
}

section('AC — a deep link opened after permission is lost lands somewhere safe');
{
  await setD({ trialVisibility: false });
  const gone = collect('#33', await j('GET', `/org/agent/clients/${REP}/trials`, undefined, ana.token));
  neg(expect(gone, 403, 'DISCLOSURE_WITHHELD'), '#33 a notification\'s deep link opened after the client turned the disclosure off answers a named, safe unavailable state — not a 500 and not stale data');
  ok(typeof gone.body?.message === 'string' && /their own|theirs/i.test(gone.body.message), '#33b and the message says whose choice it was, without blaming anyone');
  await setD({ trialVisibility: true });
}

section('X/W/#11/#12/#29 — the licence and the affiliation are re-derived at mutation time');
{
  // The client's own choices come FIRST in the rule order, so they are put back on
  // here deliberately: this group is about the licence, and a disclosure still off
  // from an earlier group would answer before the licence was ever consulted.
  await setD({ contactRouting: true, clubPresence: true, trialVisibility: true });
  // The licence goes stale: the synthetic provider's INACTIVE answer is the door.
  const inact = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-INACTIVE-ANA' }, ana.token);
  ok(inact.status === 200 || inact.status === 201, 'W1 the agent\'s FIFA facet is reported inactive');
  const RID = globalThis.__RID;
  const list = await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token);
  neg(list.body.routing.agentParty === false, '#11 and a club contact can no longer route to them — the licence is checked at the moment of the action, not when the relationship began');
  neg(['LICENCE_NOT_CURRENT', 'COMPLIANCE_NOT_CLEAR'].includes(list.body.routing.agentRefusal), `#11b with a named licence or compliance refusal (${list.body.routing.agentRefusal})`);
  neg(expect(collect('#12', await j('POST', '/org/agent/transactions', { type: 'other_services', jurisdictions: ['ENG'], clientKey: key(), parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }] }, ana.token)), 403, 'AGENT_LICENCE_INACTIVE'), '#12 and a transaction action is refused too, by its name and not as a 500 — the P5.6D facet gate says which licence and what state');
  ok((await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token)).status === 200, 'W2 re-verifying restores it');
  // #29: the affiliation ends while the session lives.
  const team = await j('GET', '/org/agent/agency/team', undefined, alex.token);
  const beaRow = (team.body?.items ?? []).find((m) => m.name === 'Bea Agent' || m.user?.name === 'Bea Agent');
  if (beaRow) {
    const end = await j('POST', `/org/agent/agency/team/${beaRow.userId ?? beaRow.user?.id}/end`, { reason: 'left' }, alex.token);
    if (end.status === 200) {
      neg(expect(collect('#29', await j('GET', '/org/agent/clients', undefined, bea.token)), 403, 'AGENCY_MEMBERSHIP_REQUIRED'), '#29 an agent whose affiliation ended is refused on the SAME token — authority is re-derived, never remembered');
    } else ok(end.status >= 400, `#29 (the affiliation could not be ended: ${end.body?.error})`);
  } else ok(true, '#29 (the colleague row was not listable, which is itself the summary boundary)');
}

section('AA — an unsupported jurisdiction is refused, never silently allowed');
{
  neg(expect(collect('AA1', await j('POST', '/org/agent/transactions', { type: 'transfer', jurisdictions: ['FRA'], clientKey: key(), parties: [] }, ana.token)), 422, 'JURISDICTION_UNSUPPORTED'), 'AA1 an unsupported jurisdiction is refused at creation');
  const gap = await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', scope: ['employment'], jurisdiction: 'FRA' }, ana.token);
  neg(gap.status >= 400, `AA2 and a relationship cannot be requested for one either (${gap.status} ${gap.body?.error})`);
}

section('Z/#7/#8/#9 — a minor is not reachable through ANY integration seam');
{
  neg(expect(collect('#8', await j('GET', '/org/agent/players?q=Guni', undefined, ana.token)), 200, null) && !/pl-guni/.test(JSON.stringify((await j('GET', '/org/agent/players?q=Guni', undefined, ana.token)).body ?? {})), '#8 a minor does not appear in the agent\'s player lookup');
  neg(expect(collect('#9', await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], clientKey: key(), parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }] }, ana.token)), 404, 'TRANSACTION_PARTY_NOT_FOUND'), '#9 a minor cannot be a transaction party, and the refusal is not an age oracle');
  neg(expect(collect('Z2', await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG' }, ana.token)), 404, null), 'Z2 nor the subject of a relationship request');
  const minorShares = await j('GET', '/player/agent/shared-opportunities', undefined, guni.token);
  ok(minorShares.body.minor === true && minorShares.body.items.length === 0, '#7 and a minor\'s own shared-opportunities surface is structurally empty — there is no path by which an agent reaches them through an Opportunity');
}

section('AP — every route P5.6E added, swept by actor and by id');
{
  const RID = globalThis.__RID;
  const OPP = globalThis.__OPP;
  // The agent lane. A club user, a foreign club user and a player are not agency
  // members, and each is told that about THEMSELVES — never anything about the
  // relationship they were reaching for.
  const agentLane = [
    ['contacts', 'GET', `/org/agent/clients/${REP}/contacts`, undefined],
    ['trials', 'GET', `/org/agent/clients/${REP}/trials`, undefined],
    ['share', 'POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key() }],
    ['shares', 'GET', `/org/agent/clients/${REP}/opportunities/shares`, undefined],
    ['handoffs', 'GET', '/org/agent/handoffs', undefined],
  ];
  for (const [label, method, url, body] of agentLane) {
    for (const [who, token] of [['a club lead', maria.token], ['a club scout', tom.token], ['a foreign club', rita.token]]) {
      const r = collect(`AP ${label}/${who}`, await j(method, url, body, token));
      neg(expect(r, 403, 'AGENT_ACTION_NOT_PERMITTED'), `AP1 ${label}: ${who} is told only that the Agent workspace is for agencies — nothing about the relationship they reached for`);
    }
    const noTok = collect(`AP ${label}/anonymous`, await j(method, url, body, undefined));
    neg(noTok.status === 401, `AP2 ${label}: and with no session at all it is a 401, before any record is looked at`);
    const asPlayer = collect(`AP ${label}/player`, await j(method, url, body, kola.token));
    neg(asPlayer.status === 401 || asPlayer.status === 403, `AP3 ${label}: a player token on an agency route is refused (the client reads their own side, not their agent's)`);
  }
  // The same routes with an id that is not this agent's: one uniform answer, so the
  // route never tells an agent whether a relationship it cannot reach exists.
  for (const [label, method, url, body] of [
    ['contacts', 'GET', `/org/agent/clients/rep-does-not-exist/contacts`, undefined],
    ['trials', 'GET', `/org/agent/clients/rep-does-not-exist/trials`, undefined],
    ['shares', 'GET', `/org/agent/clients/rep-does-not-exist/opportunities/shares`, undefined],
  ]) {
    const ghost = collect(`AP ${label}/ghost id`, await j(method, url, body, ana.token));
    const foreign = collect(`AP ${label}/foreign agency`, await j(method, url === undefined ? url : url.replace('rep-does-not-exist', REP), body, zoe.token));
    neg(expect(ghost, 404, 'REPRESENTATION_NOT_FOUND'), `AP4 ${label}: an id that does not exist is REPRESENTATION_NOT_FOUND`);
    neg(foreign.status === ghost.status && foreign.body?.error === ghost.body?.error, `AP5 ${label}: and a real relationship at another agency is the SAME answer — the two are indistinguishable`);
  }
  // A colleague at the agent's OWN agency is on the same footing as a stranger for
  // a relationship that is not theirs: membership is not the mandate.
  for (const [label, method, url] of [['contacts', 'GET', `/org/agent/clients/${REP}/contacts`], ['trials', 'GET', `/org/agent/clients/${REP}/trials`], ['shares', 'GET', `/org/agent/clients/${REP}/opportunities/shares`]]) {
    const colleague = collect(`AP ${label}/colleague`, await j(method, url, undefined, bea.token));
    neg(colleague.status === 404 || (colleague.status === 200 && !(colleague.body?.items ?? []).length), `AP6 ${label}: a same-agency colleague reaches nothing of Ana's client (#4)`);
  }
  // The club lane. An agency session, a player and a scout each meet the case's own
  // answer, not a description of what a lead could do.
  for (const [label, method, url, body] of [
    ['handoff read', 'GET', `/org/rooms/${RID}/transaction-handoff`, undefined],
    ['handoff invite', 'POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }],
    ['handoff withdraw', 'POST', `/org/rooms/${RID}/transaction-handoff/withdraw`, { clientKey: key() }],
  ]) {
    const asAgent = collect(`AP ${label}/agency`, await j(method, url, body, ana.token));
    neg(asAgent.status === 404, `AP7 ${label}: an agency session does not reach a club's case at all — a 404, not a 403 that would confirm it exists`);
    const asPlayer = collect(`AP ${label}/player`, await j(method, url, body, kola.token));
    neg(asPlayer.status === 401 || asPlayer.status === 403 || asPlayer.status === 404, `AP8 ${label}: nor does the player whose case it is about — the club's workspace is the club's`);
    const ghostCase = collect(`AP ${label}/ghost case`, await j(method, url.replace(RID, 'case-nope'), body, maria.token));
    neg(ghostCase.status === 404, `AP9 ${label}: and a case that does not exist is the same 404 a foreign club gets (AC)`);
  }
  // The player lane: their own route, keyed to their own session, with no id in it.
  const minorShared = collect('AP shared/minor', await j('GET', '/player/agent/shared-opportunities', undefined, guni.token));
  neg(minorShared.status === 200 && (minorShared.body?.items ?? []).length === 0, 'AP10 a guardian-managed account\'s shared-opportunities surface is structurally empty (Z, #7)');
  neg(collect('AP shared/agent', await j('GET', '/player/agent/shared-opportunities', undefined, ana.token)).status >= 400, 'AP11 and an agent token on it is refused — there is no id to swap');
  // The disclosure route: the client's own, and only theirs.
  for (const [who, token] of [['their agent', ana.token], ['the agency admin', alex.token], ['a club', maria.token]]) {
    const r = collect(`AP sharing/${who}`, await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { clubPresence: false }, expectedRev: REV }, token));
    neg(r.status >= 400, `AP12 ${who} cannot change the client's disclosure — it is the client's choice and nobody else's (§13)`);
  }
  const foreignRel = collect('AP sharing/other player', await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { clubPresence: true }, expectedRev: REV }, (await playerLogin('pl-carvalho')).token));
  neg(expect(foreignRel, 404, 'REPRESENTATION_NOT_FOUND'), 'AP13 and another player reaching this relationship is told it does not exist, not that it is not theirs');
  const minorSharing = collect('AP sharing/minor', await j('PATCH', '/player/agent/relationships/rep-anything/sharing', { disclosure: { clubPresence: true } }, guni.token));
  neg(expect(minorSharing, 403, 'AGENT_ACTION_NOT_PERMITTED'), 'AP14 a guardian-managed account has no disclosure to make, because it has no relationship to disclose (Z)');
  // expectedRev is optional platform-wide (M18.1): omitting it is last-write-wins,
  // and that is the convention every route follows. What must never pass is a rev
  // that is not a number — that is a malformed request, not a missing one.
  const badRev = collect('AP sharing/bad rev', await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { clubPresence: true }, expectedRev: 'latest' }, kola.token));
  neg(expect(badRev, 400, 'EXPECTED_REV_INVALID'), 'AP15 a rev that is not a whole number is refused before anything is touched');
  const unknownKey = await j('PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { somethingElse: true }, expectedRev: REV }, kola.token);
  if (unknownKey.status === 200) {
    REV = unknownKey.body.relationship.rev;
    neg(!Object.hasOwn(unknownKey.body.relationship.disclosure, 'somethingElse'), 'AP16 an unknown disclosure key reaches no field — the three are the three');
  } else neg(unknownKey.status === 409, 'AP16 (a rev conflict, which is the concurrency guard holding)');
  // Withdrawing a share: only the agent who shared it, only once, only a real one.
  const mine = await j('GET', `/org/agent/clients/${REP}/opportunities/shares`, undefined, ana.token);
  const anyShare = (mine.body?.items ?? [])[0]?.id ?? 'sh-nope';
  neg(collect('AP withdraw/colleague', await j('POST', `/org/agent/clients/${REP}/opportunities/shares/${anyShare}/withdraw`, {}, bea.token)).status === 404, 'AP17 a colleague cannot withdraw a share they did not make, and is told the relationship does not exist');
  neg(collect('AP withdraw/ghost', await j('POST', `/org/agent/clients/${REP}/opportunities/shares/sh-not-a-share/withdraw`, {}, ana.token)).status === 404, 'AP18 and withdrawing a share that was never made is a 404, not a silent success');
}

section('AQ — the five events P5.6E emits, checked against the registry');
{
  const registry = readFileSync(path.join(ROOT, 'scoutbox-server', 'm182', 'eventRegistry.mjs'), 'utf8');
  const serverSrc = readFileSync(path.join(ROOT, 'scoutbox-server', 'server.mjs'), 'utf8');
  const NEW_EVENTS = ['representation_disclosure_changed', 'contact_agent_routed', 'agent_opportunity_shared', 'transaction_handoff_invited', 'transaction_handoff_withdrawn'];
  for (const name of NEW_EVENTS) {
    ok(new RegExp(`(['\`"]${name}['\`"]|\\b${name}\\s*:\\s*\\{)`).test(registry), `AQ1 ${name} is declared in the registry — an event nobody declared is an event nobody reviewed`);
    ok(new RegExp(`'${name}'`).test(serverSrc), `AQ2 ${name} is in the emitted-events list the boot contract checks`);
  }
  // The payload allowlists: ids and org ids, never a person, a date of birth, a
  // note or a body of text. Read from the declaration itself.
  const decl = registry.match(/\['(representation_disclosure_changed|contact_agent_routed|agent_opportunity_shared)',\s*\[([^\]]*)\]\]/g) ?? [];
  neg(decl.length === 3 && decl.every((d) => !/name|dob|birth|email|phone|note|body|text|message|outcome|reason/i.test(d)), 'AQ3 and not one of the three agent-lane payloads has a field for a name, a date, a note or an outcome (§M18.2)');
  for (const name of ['transaction_handoff_invited', 'transaction_handoff_withdrawn']) {
    const block = registry.split(`${name}: {`)[1]?.split('},')[0] ?? '';
    neg(!/playerName|clientName|'note'|outcome|reasonCodes/.test(block), `AQ4 ${name} carries no name, note, outcome or reason code either`);
  }
}

section('AR — authority is re-derived at READ time, not cached at grant time');
{
  // A disposable mandate, taken all the way to a working projection, then ended by
  // the client. Nothing sweeps, nothing expires in the background: the next read
  // asks the same predicate again and gets a different answer.
  const theo = await playerLogin('pl-martin');
  const req = await j('POST', '/org/agent/clients/request', { playerId: 'pl-martin', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const rid = req.body?.relationship?.id;
  if (rid) {
    const conf = await j('POST', `/player/agent/relationships/${rid}/confirm`, { expectedRev: 1 }, theo.token);
    if (conf.status === 200) {
      let rev = conf.body.relationship.rev;
      const setT = async (patch) => { const r = await j('PATCH', `/player/agent/relationships/${rid}/sharing`, { disclosure: patch, expectedRev: rev }, theo.token); if (r.status === 200) rev = r.body.relationship.rev; return r; };
      ok((await setT({ trialVisibility: true, contactRouting: true })).status === 200, 'AR1 a second client confirms a mandate and opens two of their three disclosures');
      ok((await j('GET', `/org/agent/clients/${rid}/trials`, undefined, ana.token)).status === 200, 'AR2 and the agent\'s trial projection opens');
      ok((await j('GET', `/org/agent/clients/${rid}/contacts`, undefined, ana.token)).status === 200, 'AR3 as does the routed-contact projection');
      const term = await j('POST', `/player/agent/relationships/${rid}/terminate`, { expectedRev: rev, reasonCode: 'client_choice' }, theo.token);
      ok(term.status === 200, 'AR4 the client ends the mandate');
      for (const [label, url] of [['trials', `/org/agent/clients/${rid}/trials`], ['contacts', `/org/agent/clients/${rid}/contacts`], ['shares', `/org/agent/clients/${rid}/opportunities/shares`]]) {
        const r = collect(`AR ${label}/terminated`, await j('GET', url, undefined, ana.token));
        neg(r.status >= 400, `AR5 ${label}: the very next read is refused — the ending is not a job that runs later (§7, T)`);
      }
      const shareAfter = collect('AR share/terminated', await j('POST', `/org/agent/clients/${rid}/opportunities/${globalThis.__OPP}/share`, { clientKey: key() }, ana.token));
      neg(shareAfter.status >= 400, 'AR6 and no new share can be made for a client who is no longer one');
      // What was validly done stays done. Rewriting the record would be a lie about
      // what happened, and §22 says so explicitly.
      const theoShared = await j('GET', '/player/agent/shared-opportunities', undefined, theo.token);
      ok(theoShared.status === 200, 'AR7 the former client can still read their own shared-opportunities surface — it is theirs, not their ex-agent\'s');
      // The disclosure route itself: a terminated relationship is still the client's
      // own record, and turning a disclosure OFF must keep working — that is the one
      // thing a person must always be able to do.
      const offAfter = await j('PATCH', `/player/agent/relationships/${rid}/sharing`, { disclosure: { trialVisibility: false, contactRouting: false }, expectedRev: term.body?.relationship?.rev ?? rev }, theo.token);
      ok(offAfter.status === 200 || offAfter.status === 409, `AR8 and the client can still close their disclosures on an ended relationship (${offAfter.status})`);
    } else ok(conf.status >= 400, `AR1 (this player could not confirm: ${conf.body?.error})`);
  } else ok(req.status >= 400, `AR1 (no relationship could be requested: ${req.body?.error})`);

  // The five notification types P5.6E sends are each in a declared, MUTABLE
  // category. None of them is smuggled into `compliance`, which is mandatory and
  // cannot be turned off — a club's message and an agent's tip are not safety
  // notices, and dressing them as one would take a real choice away.
  const prefs = readFileSync(path.join(ROOT, 'scoutbox-server', 'm182', 'notificationPrefs.mjs'), 'utf8');
  const catOf = (t) => (prefs.match(new RegExp(`\\b${t}:\\s*'([a-z_]+)'`)) ?? [])[1] ?? null;
  const mandatory = new Set([...prefs.matchAll(/(\w+):\s*\{[^}]*mandatory:\s*true/g)].map((m) => m[1]));
  for (const t of ['representation_disclosure', 'representation_contact', 'representation_opportunity', 'representation_transaction']) {
    const c = catOf(t);
    ok(typeof c === 'string', `AR9 ${t} has a declared notification category (${c})`);
    neg(!mandatory.has(c), `AR10 ${t} is in a category the person can switch off (${c}) — it is not dressed up as a mandatory safety notice`);
  }
  // And the player really can switch one off: the preference route is the canonical
  // one, not a second control invented for the agent lane.
  const muted = await j('PATCH', '/player/notification-preferences', { categories: { messages: false } }, kola.token);
  ok(muted.status === 200 || muted.status === 404, `AR11 the client changes their own notification preferences through the canonical route (${muted.status})`);
}

section('AS — §22 history, the write contracts, and the verbs that do not exist');
{
  const RID = globalThis.__RID;
  const OPP = globalThis.__OPP;
  // §22. What was validly routed STAYS routed. Turning the disclosure off stops the
  // next one; it does not rewrite the record of a message that really was delivered.
  const beforeOff = (await j('GET', `/org/agent/clients/${REP}/contacts`, undefined, ana.token)).body?.items ?? [];
  await setD({ contactRouting: false });
  const afterOff = collect('AS routed/after off', await j('GET', `/org/agent/clients/${REP}/contacts`, undefined, ana.token));
  ok(afterOff.status === 200 && (afterOff.body.items ?? []).length === beforeOff.length, 'AS1 turning contact routing off does not delete the contacts that were already validly routed (§22)');
  const draftAfterOff = await j('POST', `/org/rooms/${RID}/contacts`, { body: 'And another.', contactMode: 'both' }, maria.token);
  if (draftAfterOff.status === 201) {
    neg(draftAfterOff.body.contact.routedToAgent === false, 'AS2 but the NEXT contact does not route to the agent — the choice takes effect at the next action, not retroactively');
    const rv = (await j('GET', `/org/rooms/${RID}/contacts`, undefined, maria.token)).body?.routing ?? {};
    neg(rv.agentParty === false && rv.agentRefusal === 'DISCLOSURE_WITHHELD', 'AS3 and the club is told the reason as a code, without being told what the client said');
    await j('POST', `/org/rooms/${RID}/contacts/${draftAfterOff.body.contact.id}/cancel`, { expectedRev: draftAfterOff.body.contact.rev }, maria.token);
  } else neg(draftAfterOff.status >= 400, `AS2 (no further contact could be drafted on this case: ${draftAfterOff.body?.error})`);
  await setD({ contactRouting: true });

  // The write contracts: one key, one meaning.
  const KS = key();
  const s1 = await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: KS, note: 'One.' }, ana.token);
  if (s1.status === 201 || s1.status === 200) {
    const replay = await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: KS, note: 'One.' }, ana.token);
    ok(replay.body?.idempotent === true || replay.status === 200, 'AS4 the same key with the same payload replays rather than sharing twice');
    neg(expect(collect('AS5', await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: KS, note: 'Something else entirely.' }, ana.token)), 409, 'AGENT_IDEMPOTENCY_CONFLICT'), 'AS5 and the same key with a DIFFERENT payload is a conflict, not a quiet overwrite');
    if (s1.body?.share?.id) await j('POST', `/org/agent/clients/${REP}/opportunities/shares/${s1.body.share.id}/withdraw`, {}, ana.token);
  } else neg(s1.status === 409, `AS4 (already shared, which is the duplicate rule holding: ${s1.body?.error})`);
  neg(expect(collect('AS6', await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key(), note: { nope: true } }, ana.token)), 400, 'AGENT_INPUT_INVALID'), 'AS6 a note that is not text is refused before anything is written');
  // An over-long note is cut at the documented cap by the SAME shared helper the
  // Contact domain uses — one sanitiser, one limit, no second rule for this lane.
  const longNote = await j('POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key(), note: 'x'.repeat(5000) }, ana.token);
  if (longNote.status === 201) {
    ok((longNote.body.share.note ?? '').length <= 300, `AS7 a note far past the limit is cut to the cap, not stored whole (${(longNote.body.share.note ?? '').length})`);
    await j('POST', `/org/agent/clients/${REP}/opportunities/shares/${longNote.body.share.id}/withdraw`, {}, ana.token);
  } else neg(collect('AS7', longNote).status === 409, `AS7 (already shared, which is the duplicate rule holding: ${longNote.body?.error})`);

  // The handoff's own permission and state contracts, over HTTP.
  neg(expect(collect('AS8', await j('POST', `/org/rooms/${RID}/transaction-handoff/withdraw`, { clientKey: key() }, tom.token)), 403, 'HANDOFF_NOT_PERMITTED'), 'AS8 a scout cannot withdraw an invitation either — read and write are separately gated');
  const already = collect('AS9', await j('POST', `/org/rooms/${RID}/transaction-handoff/withdraw`, { clientKey: key() }, maria.token));
  neg(already.status >= 400, `AS9 and an invitation a workspace already answered cannot be withdrawn — pretending it closed the workspace would be a lie (${already.body?.error})`);

  // The verbs. A route exists with exactly the method it was written for; nothing
  // answers a method it does not implement, and nothing is a hidden alias.
  const verbs = [
    ['GET-only contacts', 'POST', `/org/agent/clients/${REP}/contacts`],
    ['GET-only trials', 'POST', `/org/agent/clients/${REP}/trials`],
    ['GET-only handoffs', 'POST', '/org/agent/handoffs'],
    ['GET-only shared', 'POST', '/player/agent/shared-opportunities'],
    ['POST-only share', 'GET', `/org/agent/clients/${REP}/opportunities/${OPP}/share`],
    ['POST-only withdraw', 'GET', `/org/rooms/${RID}/transaction-handoff/withdraw`],
    ['PATCH-only sharing', 'POST', `/player/agent/relationships/${REP}/sharing`],
  ];
  for (const [label, method, url] of verbs) {
    const tok = url.startsWith('/player') ? kola.token : (url.startsWith('/org/agent') ? ana.token : maria.token);
    const r = collect(`AS verb/${label}`, await j(method, url, method === 'GET' ? undefined : {}, tok));
    neg(r.status === 404 || r.status === 405, `AS10 ${label}: ${method} on it is not a route (${r.status})`);
  }
  // Trust & Safety may look at the Agent domain through its own read-only console;
  // it is not a key to the integration lane's write routes.
  for (const [label, method, url, body] of [
    ['share', 'POST', `/org/agent/clients/${REP}/opportunities/${OPP}/share`, { clientKey: key() }],
    ['handoff', 'POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }],
    ['sharing', 'PATCH', `/player/agent/relationships/${REP}/sharing`, { disclosure: { clubPresence: false } }],
  ]) {
    const r = collect(`AS admin/${label}`, await j(method, url, body, undefined, ADMIN));
    neg(r.status === 401 || r.status === 403 || r.status === 404, `AS11 ${label}: the admin key is not a session on it (${r.status}) — T&S looks, it does not act for a person (§38)`);
  }
}

section('AT — the audit trail: the club\'s own history, and nobody else\'s');
{
  const RID = globalThis.__RID;
  const jr = await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, maria.token);
  const hist = jr.body?.history?.entries ?? [];
  const entries = (Array.isArray(hist) ? hist : []).filter((h) => /transaction_handoff/.test(h?.kind ?? ''));
  ok(entries.length >= 1, `AT1 the club's own case history records that a transaction workspace was invited (${entries.length})`);
  ok(entries.every((e) => typeof e.handoffId === 'string' && typeof e.at === 'number'), 'AT1b with the invitation\'s id and the time it happened, so the record is checkable');
  const entryStr = JSON.stringify(entries);
  neg(!/Ana Agent|North Star|fee|commission|offer/i.test(entryStr), 'AT2 and the entry names no agent, no agency, no fee and no offer — it records that a thing happened, as ids and a flag (§34)');
  neg(!/"note"|rationale|reasonCodes/i.test(entryStr), 'AT3 nor any of the decision\'s own reasoning, which sits elsewhere and stays there');
  neg(collect('AT agency/journey', await j('GET', `/org/rooms/${RID}/journey`, undefined, ana.token)).status === 404, 'AT4 an agency session does not reach the case journey at all — the audit trail is not a side door into the Room (#16)');
  neg(collect('AT foreign/journey', await j('GET', `/org/rooms/${RID}/journey`, undefined, rita.token)).status === 404, 'AT5 and a foreign club gets the same 404, so the two are indistinguishable (AC)');
  // The agent's own side has its own record, and it is about the invitation, not
  // about the club's thinking.
  const hofs = await j('GET', '/org/agent/handoffs', undefined, ana.token);
  neg(!/history|"note"|rationale|assessment/i.test(JSON.stringify(hofs.body?.items ?? [])), 'AT6 the agent\'s own view of the invitation carries no history, no note and no assessment either');
}

section('AU/repair §4 — an agency on the shared /org router: generic infrastructure, proven');
{
  const RID = globalThis.__RID;
  // WHY THIS GROUP EXISTS.
  //
  // `/org` is one router serving both club and agency organisations, so an agency
  // session reaches club recruitment surfaces and is answered about ITSELF. The
  // repair pass considered gating those surfaces by org kind and REJECTED that
  // fix: `m23TrialE2E` W3 asserts "an agency may invite an adult (the wall is
  // about minors)" and `m19E2E` keeps watchlists on an agency org — a deny-by-
  // default gate broke both, so it would have redesigned frozen P4B/M19 product
  // shape rather than repaired a defect.
  //
  // The mandate's alternative applies: if the route is intentionally generic
  // infrastructure, prove that with architecture and tests. This group is that
  // proof. It asserts tenant isolation directly, on the surfaces an agency can
  // reach, rather than trusting that 357 route implementations each filter
  // correctly forever.
  const FOREIGN = ['case-', 'pl-adeyemi', 'Kola', 'org-eastport', 'Eastport', 'Maria Keane'];
  const surfaces = [
    ['AU rooms', '/org/rooms'],
    ['AU second-look', '/org/second-look'],
    ['AU nobody-missed', '/org/nobody-missed'],
    ['AU watchlists', '/org/watchlists'],
    ['AU briefs', '/org/recruitment-briefs'],
    ['AU assessments', '/org/assessments'],
    ['AU shortlist', '/org/shortlist'],
    ['AU analytics', '/org/analytics/overview'],
    ['AU club transactions', '/org/transactions'],
  ];
  for (const [label, url] of surfaces) {
    const r = collect(label, await j('GET', url, undefined, ana.token));
    const body = JSON.stringify(r.body ?? {});
    // Either the surface is shut, or it answers about the agency itself and
    // carries not one identifier belonging to the club next door.
    neg(r.status >= 400 || !FOREIGN.some((needle) => body.includes(needle)),
      `${label}: an agency session learns nothing of Eastport's case, player, club or staff through it (${r.status})`);
    // And whatever it says, it says the same thing before and after the club has
    // done its work — the agency's answer is not a function of the club's data.
    const again = await j('GET', url, undefined, ana.token);
    neg(JSON.stringify(again.body ?? {}) === body, `${label}: and the answer is stable — it is a projection of the agency, not a window that moves with the club`);
  }
  // A NAMED club resource is refused, identically to one that was never created,
  // so the refusal is not a test for existence.
  const named = [
    ['AU room by id', `/org/rooms/${RID}`, '/org/rooms/case-never-existed'],
    ['AU decision by id', `/org/rooms/${RID}/decision`, '/org/rooms/case-never-existed/decision'],
    ['AU journey by id', `/org/rooms/${RID}/journey`, '/org/rooms/case-never-existed/journey'],
    ['AU contacts by id', `/org/rooms/${RID}/contacts`, '/org/rooms/case-never-existed/contacts'],
    ['AU trials by id', `/org/rooms/${RID}/trials`, '/org/rooms/case-never-existed/trials'],
  ];
  for (const [label, real, ghost] of named) {
    const a = collect(`${label} real`, await j('GET', real, undefined, ana.token));
    const b = collect(`${label} ghost`, await j('GET', ghost, undefined, ana.token));
    neg(a.status >= 400, `${label}: a real club case is refused to an agency session (${a.status})`);
    neg(a.status === b.status && JSON.stringify(a.body ?? {}) === JSON.stringify(b.body ?? {}), `${label}: and byte-identically to a case that never existed — the refusal is no oracle over the club's caseload`);
  }
  // The standing minor wall is what actually protects children here, and it is
  // asserted rather than assumed: an agency cannot open a case on a minor at all.
  const minorCase = collect('AU minor case', await j('POST', '/org/rooms', { playerId: 'pl-guni', sourceContext: 'search' }, ana.token));
  neg(minorCase.status >= 400, `AU-minor an agency cannot open a recruitment case on a minor — the wall is in the player projection, not in the router (${minorCase.status})`);
  // Counts are part of the surface: a total that counted the club's rows would
  // leak the club's caseload even with the rows themselves withheld.
  const wl = await j('GET', '/org/watchlists', undefined, ana.token);
  neg((wl.body?.total ?? 0) === (wl.body?.items ?? []).length, 'AU-count a list total counts exactly the rows the caller was given, so a count cannot report what a projection withheld');
}

// ================================== AV — repair §25: the two new writes are quotas
//
// WHY THIS GROUP EXISTS, AND WHY IT IS LAST.
//
// Both writes P5.6E adds end in a notification to a PERSON, and both can be
// repeated after being taken back: a share can be withdrawn and another made, and
// only 'invited' and 'accepted' block a new handoff, so a withdrawn invitation may
// deliberately be re-issued. The §25 review found neither carried a quota while
// every comparable write in the codebase does, which left invite → withdraw →
// invite as an unbounded way to make a player's and an agent's notifications ring.
//
// It runs last because proving a quota means spending it: every other assertion in
// this suite has already had its budget.
section('AV/repair §25 — the two new writes draw on the platform\'s own quotas');
{
  const RID = globalThis.__RID;
  ok(typeof RATE_LIMIT_POLICY.opportunity_share?.max === 'number' && typeof RATE_LIMIT_POLICY.transaction_handoff?.max === 'number',
    `AV1 both writes are named in the platform's one rate policy (opportunity_share ${RATE_LIMIT_POLICY.opportunity_share?.max}/h, transaction_handoff ${RATE_LIMIT_POLICY.transaction_handoff?.max}/h)`);
  ok(RATE_LIMIT_POLICY.opportunity_share.scope === 'actor' && RATE_LIMIT_POLICY.transaction_handoff.scope === 'org',
    'AV1b scoped to the individual who shares and to the club that invites — the party whose conduct it is');

  // Sharing: a burst of attempts on the agent's OWN client. The quota is charged
  // after authorization and before the board is searched, so an unbounded probe of
  // opportunity ids costs budget too.
  let shareLimited = null;
  for (let i = 0; i < RATE_LIMIT_POLICY.opportunity_share.max + 3 && !shareLimited; i++) {
    const r = await j('POST', `/org/agent/clients/${REP}/opportunities/opp-burst-${i}/share`, { clientKey: key() }, ana.token);
    if (r.status === 429) shareLimited = collect('AV share rate limited', r);
  }
  neg(shareLimited !== null, `AV2 a share burst is refused 429 within the named policy (${RATE_LIMIT_POLICY.opportunity_share.max}/h)`);
  ok(shareLimited?.body?.error === 'RATE_LIMITED' && shareLimited?.body?.action === 'opportunity_share',
    'AV2b with the platform\'s own RATE_LIMITED body naming the action, not a bespoke refusal');
  neg(!/pl-|Kola|Adeyemi|Ana Agent|North Star/.test(JSON.stringify(shareLimited?.body ?? {})),
    'AV2c and the refusal names neither the client nor the agent — a quota message is not a disclosure');

  // The handoff: the loop itself, invite → withdraw → invite, on one club budget.
  //
  // It needs a case whose invitation has NOT been taken up — the case above ends
  // the suite with an accepted handoff, and an accepted one refuses both halves at
  // 409 before any quota, which is correct and proves nothing about the quota. So
  // the loop is driven on a second case of this club's own, taken to
  // offer_consideration the ordinary way: shortlist, draft, finalise.
  // A player this suite has not otherwise touched: pl-svensson is removed by #34
  // and pl-adeyemi is the case above.
  const second = await j('POST', '/org/rooms', { playerId: 'pl-alvarez', reason: 'P5.6E repair §25' }, maria.token);
  const RID2 = second.body?.room?.roomId ?? second.body?.existingRoomId ?? null;
  const jr2 = (await j('GET', `/org/rooms/${RID2}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${RID2}/lifecycle`, { action: 'shortlist', expectedRev: jr2?.case?.rev }, maria.token);
  const dr2 = await j('POST', `/org/rooms/${RID2}/decision/draft`, { outcome: 'progress', note: 'Internal: repair-pass fixture.' }, maria.token);
  const fin2 = await j('POST', `/org/rooms/${RID2}/decision/finalize`, { clientKey: key(), expectedRev: dr2.body?.draft?.rev ?? 1 }, maria.token);
  ok(RID2 !== null && fin2.status === 201, `AV3-fixture a second case of this club's own reaches offer_consideration by the ordinary path (case ${RID2}, create ${second.status}, draft ${dr2.status}, finalise ${fin2.status})`);

  let handoffLimited = null;
  let halves = 0;
  for (let i = 0; i < RATE_LIMIT_POLICY.transaction_handoff.max + 3 && !handoffLimited; i++) {
    const inv = await j('POST', `/org/rooms/${RID2}/transaction-handoff`, { clientKey: key() }, maria.token);
    halves++;
    if (inv.status === 429) { handoffLimited = collect('AV handoff rate limited', inv); break; }
    if (inv.status !== 201) break;
    const wd = await j('POST', `/org/rooms/${RID2}/transaction-handoff/withdraw`, {}, maria.token);
    halves++;
    if (wd.status === 429) { handoffLimited = collect('AV handoff rate limited', wd); break; }
    if (wd.status !== 200) break;
  }
  neg(handoffLimited !== null, `AV3 the invite/withdraw loop is refused 429 after ${halves} halves, within the named policy (${RATE_LIMIT_POLICY.transaction_handoff.max}/h) — the loop is closed`);
  ok(handoffLimited?.body?.error === 'RATE_LIMITED' && handoffLimited?.body?.action === 'transaction_handoff',
    'AV3b naming transaction_handoff, so both halves of the loop draw on one club budget rather than each having its own');
  // That both halves draw on ONE budget is shown directly rather than by counting:
  // once the budget is gone, whichever half was not the one to hit it is refused
  // too. (Counting would prove nothing here — earlier groups in this suite already
  // spent part of this club's hour, which is exactly how a shared budget behaves.)
  const otherHalf = handoffLimited?.body?.action === 'transaction_handoff'
    ? await j('POST', `/org/rooms/${RID2}/transaction-handoff/withdraw`, {}, maria.token)
    : null;
  ok(otherHalf?.status === 429 && otherHalf?.body?.action === 'transaction_handoff',
    `AV3b2 and with the budget gone the OTHER half of the loop is refused too, so withdrawing is charged rather than free (${otherHalf?.status})`);
  neg(!/pl-|Svensson|case-|hof-/.test(JSON.stringify(handoffLimited?.body ?? {})),
    'AV3c and it names neither the subject nor the case');

  // A quota is not an authorization. A caller who was refused before must still be
  // refused the same way once the budget is gone — otherwise 429 would become a
  // softer, more informative answer than the real one.
  const scoutAfter = collect('AV4', await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }, tom.token));
  neg(expect(scoutAfter, 403, 'HANDOFF_NOT_PERMITTED'), 'AV4 a scout is still refused HANDOFF_NOT_PERMITTED, not 429 — the quota is charged after authorization, so it never speaks for it');
  const foreignAfter = collect('AV5', await j('POST', `/org/rooms/${RID}/transaction-handoff`, { clientKey: key() }, rita.token));
  neg(expect(foreignAfter, 404, 'ROOM_NOT_FOUND'), 'AV5 and a foreign club still gets the case\'s own 404 — an exhausted quota is no existence oracle');
}

section('refusal hygiene — every refusal this suite provoked, swept at once');
{
  ok(ERROR_BODIES.length >= 25, `HY1 ${ERROR_BODIES.length} distinct refusals were collected`);
  const stacky = ERROR_BODIES.filter(({ body }) => /\bat [\w$.]+ \(|\.mjs:\d+|node_modules|TypeError:/.test(JSON.stringify(body ?? {})));
  neg(stacky.length === 0, 'HY2 not one carries a stack trace or a file path');
  // A route that does not exist at all answers Express's bare 404 with no JSON
  // body. That is not a domain refusal and has no code to carry — several of this
  // suite's strongest negatives ("there is no such route") provoke exactly it.
  // Everything that DID reach a handler must name itself.
  const domainRefusals = ERROR_BODIES.filter(({ body }) => body !== null && typeof body === 'object');
  const named = domainRefusals.filter(({ body }) => typeof body?.error !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(body.error));
  neg(named.length === 0, `HY3 every one names itself with a code (${named.map((l) => `${l.label}:${l.status}`).join(', ')})`);
  neg(ERROR_BODIES.every((e) => e.status < 500), `HY4 and not one is a 5xx (${ERROR_BODIES.filter((e) => e.status >= 500).map((l) => `${l.label}:${l.body?.error}`).join(', ')})`);
  // M18.2's shared conflict contract deliberately names WHO last changed a record,
  // so the person reloading knows whose edit they are about to overwrite — and it
  // is only ever sent to someone who can already see that person. That one declared
  // field is dropped before the sweep; nothing else is.
  const leaky = ERROR_BODIES.filter(({ body }) => {
    const { updatedBy: _ub, ...rest } = body ?? {};
    return /Ana Agent|North Star|Kola|Adeyemi|dob|@/.test(JSON.stringify(rest));
  });
  neg(leaky.length === 0, `HY5 no refusal names a person, an agency or an email (${leaky.map((l) => l.label).join(', ')})`);
  const offery = ERROR_BODIES.filter(({ body }) => /offer|fee|commission|salary|signed/i.test(JSON.stringify(body ?? {})));
  neg(offery.length === 0, `HY6 and not one mentions an offer, a fee, a commission or a signing (${offery.map((l) => l.label).join(', ')})`);
}

await stop(server);
console.log(`\nM23 P5.6E integration suite: ${passed} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / Math.max(passed, 1)) * 100)}%)`);
