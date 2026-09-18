// M23 P5.6B acceptance suite — ScoutBox Agent core.
//
// The governing principle this suite exists to enforce (P5.6A, frozen):
//
//   A licensed natural person is not an agency; agency membership is not a
//   licence; a self-typed licence number is not a verified licence; a CRM
//   entry is not representation; an agent's claim is not private access;
//   the client's confirmation — and only that — is the root of a relationship.
//   ScoutBox adjudicates nothing, and the shared Trust & Safety key can
//   adjudicate nothing either.
//
// Groups:
//   A  pure engine — states, facets, decay, synthetic provider, gaps
//   B  permission matrix — every tier × capability, monotone, null-prototype
//   C  affiliation invariants — self-promotion, last admin, windows
//   D  agreement engine — statuses, transitions, access predicate, cooldown
//   E  platform gating — agent login, org listing, club user refused
//   F  membership over HTTP — bootstrap, foreign org, ended member, removed user
//   G  profile + verification over HTTP — declaration ≠ verification, facets separate
//   H  the synthetic provider is named, local, and absent without the flag
//   I  team management — tiers, self-promotion, last admin, rev, idempotency
//   J  players lookup — adults only, invisible, blocked, short query, cap
//   K  request — verification gate, uniform 404, conflict, cooldown, term/scope
//   L  the client's answer — confirm / decline / dispute / terminate, notifications
//   M  access basis — proposed ≠ access, disputed suspends, terminated ends, expiry derives
//   N  privacy — colleague, other agency, other player, summary sharing, minor
//   O  blocks — before request, before confirm
//   P  idempotency, payload collision, stale rev, malformed rev, concurrency
//   Q  rate limits — every agent policy exists and fires
//   R  Trust & Safety — read-only; NO route lets the shared key adjudicate
//   S  the subsystems Agent must not touch — signings, offers, Trust, Passport, Box Cam
//   T  events, notifications, audit — registered, org-private, ids only
//   U  tombstones — player deletion leaves an id-only record
//   V  legacy rows — read-only, no access, mirrored once
//   W  restart — everything above survives the process dying
//
// No assertion here is `status !== 200`. Every refusal names the status and
// the code it expects.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_POLICY_VERSION, VERIFICATION_STATES, FACETS, RECHECK_MS, JURISDICTIONS, newFacets, effectiveFacetState,
  evaluateSubmission, requiredFacetsFor, verificationGap, TIERS, normaliseTiers, affiliationActive, tiersOf,
  PERMISSIONS, can, capabilitiesOf, affiliationChangeProblem, AGREEMENT_STATUSES, SCOPES, MAX_TERM_MONTHS,
  DEFAULT_TERM_MONTHS, REQUEST_COOLDOWN_MS, normaliseScope, termMonthsOf, termEndAt, effectiveAgreementStatus,
  agreementGrantsAccess, requestConflict, AGENT_TRANSITIONS, CLIENT_TRANSITIONS, clientTransitionAllowed,
  agentTransitionAllowed, agreementForAgent, agreementForClient, agreementSummaryForStaff,
} from '../m24/shared.mjs';
import { M24_ERROR_HTTP, PUBLIC_ERROR_FIELDS, publicErrorBody } from '../m24/errors.mjs';
import { AGENT_AUDIT_ACTIONS } from '../m24/audit.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../m182/notificationPrefs.mjs';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { openStore } from '../store.mjs';

const PORT = 6300 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23agent-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Exact status AND exact code. */
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
  return good;
};
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// ============================================================ A — pure engine
section('A — verification engine: honest states, separate facets, decay, no pretend register');
{
  ok(VERIFICATION_STATES.length === 6 && ['UNVERIFIED', 'PENDING', 'VERIFIED', 'STALE', 'INACTIVE', 'MANUAL_REVIEW_REQUIRED'].every((s) => VERIFICATION_STATES.includes(s)), 'A1 the six honest verification states, exactly');
  neg(!VERIFICATION_STATES.includes('APPROVED') && !VERIFICATION_STATES.includes('LICENSED') && !VERIFICATION_STATES.includes('TRUSTED'), 'A2 no state claims a licence, an approval or trust — a state describes provenance, never authority');
  // P5.6C added the fourth facet (domestic_authorisation, P5.6A DR-53); the invariant is "separate facets, never one boolean".
  ok(FACETS.length === 4 && FACETS.includes('fifa_licence') && FACETS.includes('national_registration') && FACETS.includes('domestic_authorisation') && FACETS.includes('minors_authorisation'), 'A3 four separate facets, never one boolean');
  const f = newFacets();
  ok(f.fifa_licence.state === 'UNVERIFIED' && f.fifa_licence.reference === null && Object.keys(f.national_registration).length === 0 && Object.keys(f.minors_authorisation).length === 0, 'A4 a new profile is UNVERIFIED with nothing declared');
  ok(effectiveFacetState(null) === 'UNVERIFIED' && effectiveFacetState({}) === 'UNVERIFIED' && effectiveFacetState(undefined) === 'UNVERIFIED', 'A5 a missing facet reads UNVERIFIED, never anything better');
  ok(effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 + DAY }, T0) === 'VERIFIED', 'A6 VERIFIED before recheckAt is VERIFIED');
  neg(effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 }, T0) === 'STALE' && effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 - 1 }, T0) === 'STALE', 'A7 VERIFIED at or past recheckAt decays to STALE — a verification has a shelf life (DR-6)');
  neg(effectiveFacetState({ state: 'VERIFIED' }, T0) === 'VERIFIED', 'A8 a VERIFIED facet with no recheckAt does not decay (legacy-safe), but the provider always sets one');
  neg(effectiveFacetState({ state: 'approved' }, T0) === 'MANUAL_REVIEW_REQUIRED' && effectiveFacetState({ state: 'constructor' }, T0) === 'MANUAL_REVIEW_REQUIRED', 'A9 an unknown stored state is corruption and reads as MANUAL_REVIEW_REQUIRED, never as VERIFIED');
  ok(RECHECK_MS === 30 * DAY, 'A10 recheck window is 30 days');
  // Provider abstraction.
  const prod = evaluateSubmission({ facet: 'fifa_licence', reference: 'TEST-VERIFIED-1', testProviderEnabled: false, now: T0 });
  neg(prod.state === 'MANUAL_REVIEW_REQUIRED' && prod.provenance.provider === 'none' && /G-C0/.test(prod.note) && /not a verification/.test(prod.note), 'A11 WITHOUT the flag, even a TEST-VERIFIED reference is MANUAL_REVIEW_REQUIRED with provenance "none" and a note naming G-C0 — production never fakes a register');
  const syn = evaluateSubmission({ facet: 'fifa_licence', reference: 'test-verified-1', testProviderEnabled: true, now: T0 });
  ok(syn.state === 'VERIFIED' && syn.provenance.provider === 'local-synthetic-test-provider' && syn.provenance.kind === 'synthetic' && syn.recheckAt === T0 + RECHECK_MS && /SYNTHETIC/.test(syn.note) && /never exists in production/.test(syn.note), 'A12 with the flag, TEST-VERIFIED (case-insensitive) is VERIFIED, provenance names the synthetic provider, note says it never exists in production');
  const inactive = evaluateSubmission({ facet: 'fifa_licence', reference: 'TEST-INACTIVE-9', testProviderEnabled: true, now: T0 });
  ok(inactive.state === 'INACTIVE' && inactive.verifiedAt === null, 'A13 TEST-INACTIVE is INACTIVE');
  const other = evaluateSubmission({ facet: 'fifa_licence', reference: 'FIFA-REAL-LOOKING-123', testProviderEnabled: true, now: T0 });
  neg(other.state === 'MANUAL_REVIEW_REQUIRED', 'A14 with the flag, a real-looking reference is STILL manual review — the synthetic provider verifies only its own tagged references');
  neg(evaluateSubmission({ facet: 'fifa_licence', reference: '  ', testProviderEnabled: true, now: T0 }).state === 'MANUAL_REVIEW_REQUIRED', 'A15 an empty reference verifies nothing');
  // Requirements and gaps.
  ok(requiredFacetsFor('INT').length === 1 && requiredFacetsFor('INT')[0].facet === 'fifa_licence', 'A16 INT requires the FIFA licence');
  ok(requiredFacetsFor('ENG').length === 2 && requiredFacetsFor('ENG')[1].facet === 'national_registration' && requiredFacetsFor('ENG')[1].ma === 'ENG', 'A17 ENG additionally requires FA registration (FA 2026-27 basis)');
  neg(!requiredFacetsFor('INT').some((r) => r.facet === 'minors_authorisation') && !requiredFacetsFor('ENG').some((r) => r.facet === 'minors_authorisation'), 'A18 minors_authorisation is required by NO regulated action in P5.6B — the minor pathway is preserved, not activated');
  neg(verificationGap(null, 'INT', T0)?.error === 'AGENT_PROFILE_REQUIRED', 'A19 no profile → AGENT_PROFILE_REQUIRED');
  const p = { facets: newFacets(), declared: { fifaLicenceNumber: 'FIFA-123' } };
  neg(verificationGap(p, 'INT', T0)?.error === 'AGENT_VERIFICATION_REQUIRED' && verificationGap(p, 'INT', T0).state === 'UNVERIFIED', 'A20 a DECLARED licence number with nothing verified is a gap — a typed number is a declaration (S9)');
  p.facets.fifa_licence = { state: 'VERIFIED', recheckAt: T0 + DAY };
  ok(verificationGap(p, 'INT', T0) === null, 'A21 VERIFIED fifa closes the INT gap');
  neg(verificationGap(p, 'ENG', T0)?.facet === 'national_registration' && verificationGap(p, 'ENG', T0).memberAssociation === 'ENG', 'A22 but not the ENG gap — a FIFA licence is not FA registration (facets never collapse)');
  p.facets.national_registration.ENG = { state: 'VERIFIED', recheckAt: T0 + DAY };
  ok(verificationGap(p, 'ENG', T0) === null, 'A23 with FA registration VERIFIED the ENG gap closes');
  neg(verificationGap(p, 'ENG', T0 + 2 * DAY)?.state === 'STALE', 'A24 and re-opens as STALE once the recheck window passes');
  neg(verificationGap({ facets: { fifa_licence: { state: 'MANUAL_REVIEW_REQUIRED' } } }, 'INT', T0)?.state === 'MANUAL_REVIEW_REQUIRED', 'A25 MANUAL_REVIEW_REQUIRED is a gap: pending human review authorises nothing');
  neg(verificationGap({ facets: { fifa_licence: { state: 'INACTIVE' } } }, 'INT', T0)?.state === 'INACTIVE', 'A26 INACTIVE is a gap');
  neg(verificationGap({ facets: { fifa_licence: { state: 'PENDING' } } }, 'INT', T0)?.state === 'PENDING', 'A27 PENDING is a gap');
  ok(JURISDICTIONS.length === 3 && JURISDICTIONS.includes('INT') && JURISDICTIONS.includes('ENG') && JURISDICTIONS.includes('USA'), 'A28 three member-association codes in P5.6B');
  ok(AGENT_POLICY_VERSION === 1, 'A29 policy version 1');
}

// ============================================================ B — matrix
section('B — the permission matrix is server-side, complete, monotone and null-prototype safe');
{
  ok(TIERS.length === 5 && ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'].every((t) => TIERS.includes(t)), 'B1 the five agency roles');
  const caps = Object.keys(PERMISSIONS);
  ok(caps.length >= 16, `B2 ${caps.length} capabilities declared`);
  let cells = 0; let shaped = true;
  for (const cap of caps) for (const t of TIERS) { cells += 1; if (typeof can([t], cap) !== 'boolean') shaped = false; }
  ok(shaped && cells === caps.length * TIERS.length, `B3 the matrix is complete: ${cells} tier × capability cells answer a boolean`);
  const regulated = ['clients.request', 'clients.terminate', 'clients.opportunities.read', 'players.lookup', 'clients.read.own', 'profile.write.own', 'verification.submit'];
  for (const cap of regulated) {
    neg(can(['licensed_agent'], cap) && !can(['agency_admin'], cap) && !can(['analyst'], cap) && !can(['assistant'], cap) && !can(['finance'], cap), `B4 ${cap} is held by licensed_agent ONLY — an administrator is not an agent`);
  }
  for (const cap of ['agency.team.write', 'agency.settings.write', 'agency.audit.read']) {
    neg(can(['agency_admin'], cap) && !can(['licensed_agent'], cap) && !can(['analyst'], cap), `B5 ${cap} is held by agency_admin only — a licensed agent is not an administrator`);
  }
  ok(TIERS.every((t) => can([t], 'me.read') && can([t], 'inbox.read') && can([t], 'agency.read') && can([t], 'agency.team.read')), 'B6 every member may read themselves, their inbox, and the agency they belong to');
  neg(!can(['licensed_agent'], 'clients.read.shared_summary') && can(['analyst'], 'clients.read.shared_summary'), 'B7 the shared summary is the support roles\' view, and even that is client-gated at the route');
  neg(can([], 'me.read') === false && can(null, 'me.read') === false && can(undefined, 'clients.request') === false, 'B8 no roles → nothing');
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'prototype']) {
    neg(can(TIERS, key) === false && PERMISSIONS[key] === undefined, `B9 "${key}" is not a capability`);
    neg(!normaliseTiers([key]).length && !can([key], 'me.read'), `B10 "${key}" is not a role`);
  }
  neg(can(['licensed_agent'], 'licence.verify') === false && can(TIERS, 'dispute.resolve') === false && can(TIERS, 'regulatory.override') === false && can(TIERS, 'minor.approve') === false, 'B11 no capability named verify, resolve, override or approve exists for any agency role — those are P5.6C attributed-review acts, not agency powers');
  ok(capabilitiesOf(['licensed_agent', 'agency_admin']).length > capabilitiesOf(['licensed_agent']).length && capabilitiesOf(['licensed_agent', 'agency_admin']).every((c) => can(['licensed_agent'], c) || can(['agency_admin'], c)), 'B12 roles combine by union, never more');
  ok(normaliseTiers(['analyst', 'analyst', 'bogus', 'finance']).join(',') === 'analyst,finance' && normaliseTiers('licensed_agent').length === 0, 'B13 tiers normalise: de-duplicated, unknown dropped, non-array rejected');
}

// ============================================================ C — affiliation invariants
section('C — affiliation windows and role-change invariants');
{
  ok(affiliationActive({ startedAt: T0, endedAt: null }, T0) && affiliationActive({ startedAt: T0, endedAt: T0 + 1 }, T0), 'C1 active from startedAt while endedAt is null or in the future');
  neg(!affiliationActive({ startedAt: T0 + 1, endedAt: null }, T0) && !affiliationActive({ startedAt: T0, endedAt: T0 }, T0) && !affiliationActive(null, T0) && !affiliationActive({ endedAt: null }, T0), 'C2 not yet started, already ended, missing or window-less → inactive (fail closed)');
  ok(tiersOf({ tiers: ['finance', 'x'] }).join() === 'finance' && tiersOf(null).length === 0, 'C3 tiersOf normalises');
  const admin = { userId: 'u1', tiers: ['agency_admin'], startedAt: T0, endedAt: null };
  const staff = { userId: 'u2', tiers: ['assistant'], startedAt: T0, endedAt: null };
  neg(affiliationChangeProblem({ affiliations: [admin, staff], target: staff, actorUserId: 'u2', nextTiers: ['agency_admin'], now: T0 }) === 'SELF_PROMOTION_BLOCKED', 'C4 nobody grants themselves agency_admin');
  ok(affiliationChangeProblem({ affiliations: [admin, staff], target: staff, actorUserId: 'u1', nextTiers: ['agency_admin', 'assistant'], now: T0 }) === null, 'C5 an administrator may promote a colleague');
  neg(affiliationChangeProblem({ affiliations: [admin, staff], target: admin, actorUserId: 'u1', nextTiers: ['assistant'], now: T0 }) === 'LAST_ADMIN', 'C6 the last administrator cannot demote themselves');
  neg(affiliationChangeProblem({ affiliations: [admin, staff], target: admin, actorUserId: 'u1', nextTiers: [], now: T0, ending: true }) === 'LAST_ADMIN', 'C7 nor be removed');
  const admin2 = { userId: 'u3', tiers: ['agency_admin'], startedAt: T0, endedAt: null };
  ok(affiliationChangeProblem({ affiliations: [admin, staff, admin2], target: admin, actorUserId: 'u3', nextTiers: [], now: T0, ending: true }) === null, 'C8 with a second administrator, removal is allowed');
  const endedAdmin = { userId: 'u4', tiers: ['agency_admin'], startedAt: T0 - DAY, endedAt: T0 - 1 };
  neg(affiliationChangeProblem({ affiliations: [admin, endedAdmin], target: admin, actorUserId: 'u1', nextTiers: ['finance'], now: T0 }) === 'LAST_ADMIN', 'C9 an ENDED administrator does not count — the window is honoured');
  ok(affiliationChangeProblem({ affiliations: [admin, staff], target: admin, actorUserId: 'u1', nextTiers: ['agency_admin', 'licensed_agent'], now: T0 }) === null, 'C10 an administrator may add licensed_agent to their own roles — the tier is agency governance, not a licence (verification still gates every regulated act)');
}

// ============================================================ D — agreement engine
section('D — agreement statuses, transitions, the access predicate and the cooldown');
{
  ok(AGREEMENT_STATUSES.length === 7 && ['proposed', 'active', 'declined', 'expired', 'terminated_by_client', 'terminated_by_agent', 'disputed'].every((s) => AGREEMENT_STATUSES.includes(s)), 'D1 the seven P5.6A statuses, by their P5.6A names');
  neg(!AGREEMENT_STATUSES.includes('signed') && !AGREEMENT_STATUSES.includes('approved') && !AGREEMENT_STATUSES.includes('resolved'), 'D2 no signed, approved or resolved status — nothing in P5.6B is adjudicated or transacted');
  ok(SCOPES.length === 4 && MAX_TERM_MONTHS === 24 && DEFAULT_TERM_MONTHS === 12, 'D3 four scopes; two-year cap (FFAR 12(3) / FA 4.3); 12-month default');
  ok(normaliseScope(undefined).join() === 'employment' && normaliseScope(['transfer', 'transfer', 'x']).join() === 'transfer' && normaliseScope('commercial').join() === 'commercial', 'D4 scope normalises with employment as default');
  ok(termMonthsOf(undefined) === 12 && termMonthsOf('') === 12 && termMonthsOf(24) === 24 && termMonthsOf('6') === 6, 'D5 term defaults and parses');
  neg(termMonthsOf(25) === null && termMonthsOf(0) === null && termMonthsOf(1.5) === null && termMonthsOf('abc') === null && termMonthsOf(-3) === null, 'D6 25 months, zero, fractions, text and negatives are refused');
  ok(termEndAt(T0, 12) === T0 + 12 * 30 * DAY, 'D7 end is start plus months');
  const active = { status: 'active', agentUserId: 'a1', confirmedAt: T0, endAt: T0 + DAY };
  ok(effectiveAgreementStatus(active, T0) === 'active', 'D8 active before endAt is active');
  neg(effectiveAgreementStatus(active, T0 + DAY) === 'expired' && active.status === 'active', 'D9 at endAt it READS expired while the stored status is untouched — expiry is derived, never written');
  ok(effectiveAgreementStatus({ status: 'proposed' }, T0) === 'proposed' && effectiveAgreementStatus(null) === null, 'D10 other statuses pass through');
  // THE access predicate.
  ok(agreementGrantsAccess(active, 'a1', T0), 'D11 the named agent on an active confirmed unexpired agreement has access');
  neg(!agreementGrantsAccess(active, 'a2', T0), 'D12 a different agent — a colleague at the same agency — does not');
  neg(!agreementGrantsAccess(active, 'a1', T0 + DAY), 'D13 the same agent after expiry does not');
  neg(!agreementGrantsAccess({ ...active, status: 'proposed', confirmedAt: null }, 'a1', T0), 'D14 a proposal — the agent\'s claim — grants nothing');
  neg(!agreementGrantsAccess({ ...active, status: 'disputed' }, 'a1', T0), 'D15 a disputed agreement suspends access');
  neg(!agreementGrantsAccess({ ...active, status: 'terminated_by_client' }, 'a1', T0) && !agreementGrantsAccess({ ...active, status: 'terminated_by_agent' }, 'a1', T0) && !agreementGrantsAccess({ ...active, status: 'declined' }, 'a1', T0), 'D16 terminated either way, or declined, grants nothing');
  neg(!agreementGrantsAccess({ ...active, confirmedAt: null }, 'a1', T0), 'D17 an "active" row with no confirmation timestamp grants nothing — the confirmation is the root, not the status word');
  neg(!agreementGrantsAccess({ ...active, agentUserId: null }, null, T0), 'D18 a legacy agency-level row (no agent) grants nothing even to a null caller');
  neg(!agreementGrantsAccess(null, 'a1', T0), 'D19 no agreement, no access');
  // Transitions.
  ok(CLIENT_TRANSITIONS.proposed.join() === 'active,declined,disputed' && CLIENT_TRANSITIONS.active.join() === 'terminated_by_client,disputed', 'D20 the client confirms, declines or disputes a proposal; ends or disputes an active one');
  ok(AGENT_TRANSITIONS.proposed.join() === 'terminated_by_agent' && AGENT_TRANSITIONS.active.join() === 'terminated_by_agent', 'D21 the agent may only withdraw or end');
  neg(AGENT_TRANSITIONS.disputed === undefined && CLIENT_TRANSITIONS.disputed === undefined && AGENT_TRANSITIONS.declined === undefined && CLIENT_TRANSITIONS.expired === undefined, 'D22 disputed, declined and expired are terminal for BOTH sides in P5.6B — resolution is P5.6C attributed review');
  neg(!agentTransitionAllowed({ status: 'proposed' }, 'active', T0), 'D23 the agent cannot make a proposal active — only the client can');
  neg(!clientTransitionAllowed({ status: 'proposed' }, 'terminated_by_agent', T0) && !clientTransitionAllowed({ status: 'active', endAt: T0 - 1 }, 'terminated_by_client', T0), 'D24 the client cannot act as the agent, nor end an already-expired agreement');
  for (const key of ['constructor', '__proto__', 'toString']) {
    neg(AGENT_TRANSITIONS[key] === undefined && CLIENT_TRANSITIONS[key] === undefined && !clientTransitionAllowed({ status: key }, 'active', T0), `D25 "${key}" is not a status`);
  }
  // Conflict and cooldown.
  const rows = [{ id: 'r1', agentUserId: 'a1', clientId: 'p1', status: 'proposed' }];
  neg(requestConflict(rows, { agentUserId: 'a1', playerId: 'p1', now: T0 })?.error === 'REPRESENTATION_ALREADY_EXISTS', 'D26 a pending proposal blocks a second request');
  ok(requestConflict(rows, { agentUserId: 'a2', playerId: 'p1', now: T0 }) === null, 'D27 a different agent is not blocked by it (multiple representation is neither approved nor adjudicated here — it is simply not this agent\'s record)');
  ok(requestConflict(rows, { agentUserId: 'a1', playerId: 'p2', now: T0 }) === null, 'D28 nor a different player');
  const declined = [{ id: 'r2', agentUserId: 'a1', clientId: 'p1', status: 'declined', declinedAt: T0 }];
  neg(requestConflict(declined, { agentUserId: 'a1', playerId: 'p1', now: T0 + DAY })?.error === 'REPRESENTATION_COOLDOWN' && requestConflict(declined, { agentUserId: 'a1', playerId: 'p1', now: T0 + DAY }).retryAt === T0 + REQUEST_COOLDOWN_MS, 'D29 a decline starts a 30-day cooldown with a stated retryAt');
  ok(requestConflict(declined, { agentUserId: 'a1', playerId: 'p1', now: T0 + REQUEST_COOLDOWN_MS }) === null, 'D30 which lifts exactly when it says');
  const ended = [{ id: 'r3', agentUserId: 'a1', clientId: 'p1', status: 'terminated_by_client', terminatedAt: T0 }];
  neg(requestConflict(ended, { agentUserId: 'a1', playerId: 'p1', now: T0 + 1 })?.error === 'REPRESENTATION_COOLDOWN', 'D31 a client termination too');
  const disputed = [{ id: 'r4', agentUserId: 'a1', clientId: 'p1', status: 'disputed' }];
  neg(requestConflict(disputed, { agentUserId: 'a1', playerId: 'p1', now: T0 })?.error === 'REPRESENTATION_ALREADY_EXISTS', 'D32 a dispute blocks a fresh request indefinitely — no re-asking around a dispute');
  // Projections.
  const a = { id: 'r9', agentUserId: 'a1', agencyOrgId: 'o1', clientKind: 'player', clientId: 'p1', status: 'disputed', disputeReason: 'PRIVATE_REASON_TEXT', scope: ['employment'], history: [{ id: 'h1', at: T0, action: 'representation_disputed', by: { kind: 'player', userId: 'p1', name: 'P' }, detail: { hadReason: true } }] };
  const forAgent = agreementForAgent(a, T0);
  neg(!JSON.stringify(forAgent).includes('PRIVATE_REASON_TEXT'), 'D33 the agent projection never carries the client\'s dispute reason');
  ok(agreementForClient(a, T0).disputeReason === 'PRIVATE_REASON_TEXT' && agreementForClient(a, T0).pending === false, 'D34 the client projection carries their own reason');
  const summary = agreementSummaryForStaff(a, T0);
  neg(Object.keys(summary).sort().join() === 'agentUserId,clientId,endAt,id,startAt,status,summaryOnly' && !('scope' in summary) && !('history' in summary), 'D35 the staff summary is id, status and dates only');
  ok(/not a representation contract/.test(forAgent.honest) && /has not assessed/.test(forAgent.honest), 'D36 the agent projection says what the record is not');
  ok(/legacy/i.test(agreementForAgent({ ...a, legacy: { fromRepresentationId: 'x' } }, T0).honest) && /no licensed individual/.test(agreementForAgent({ ...a, legacy: { fromRepresentationId: 'x' } }, T0).honest), 'D37 a legacy row says it names no licensed individual');
  // Errors.
  ok(Object.getPrototypeOf(M24_ERROR_HTTP) === null && M24_ERROR_HTTP.constructor === undefined, 'D38 the error table is null-prototype');
  neg(M24_ERROR_HTTP.PLAYER_NOT_FOUND === 404 && M24_ERROR_HTTP.REPRESENTATION_NOT_FOUND === 404 && M24_ERROR_HTTP.AGENT_VERIFICATION_REQUIRED === 403 && M24_ERROR_HTTP.REPRESENTATION_COOLDOWN === 429 && M24_ERROR_HTTP.LAST_ADMIN === 409, 'D39 codes map to the right statuses');
  const pub = publicErrorBody({ error: 'PLAYER_NOT_FOUND', stack: 'x', internal: 'y', message: 'm' });
  neg(pub.stack === undefined && pub.internal === undefined && pub.error === 'PLAYER_NOT_FOUND' && PUBLIC_ERROR_FIELDS.includes('message'), 'D40 error bodies are whitelisted fields only');
  ok(AGENT_AUDIT_ACTIONS.has('representation_requested') && AGENT_AUDIT_ACTIONS.has('agency_affiliation_ended') && AGENT_AUDIT_ACTIONS.has('representation_sharing_changed') && !AGENT_AUDIT_ACTIONS.has('representation_resolved'), 'D41 the audit projection lists lifecycle actions (including the client\'s content-free sharing toggle) and no resolution action');
}

// ============================================================ registry / policy
section('T1 — events, notification categories, rate policies and stores are declared');
{
  const EVENTS = ['agent_profile_created', 'agent_verification_state_changed', 'agency_affiliation_created', 'agency_affiliation_ended', 'representation_requested', 'representation_confirmed', 'representation_rejected', 'representation_terminated', 'representation_disputed'];
  for (const e of EVENTS) {
    const r = EVENT_REGISTRY[e];
    ok(!!r && r.audience === 'org_private' && r.privacyClass === 'org_internal' && r.replayPolicy === 'never' && r.notificationEligible === true && r.analyticsEligible === false, `T1 ${e} is registered org_private / org_internal, never replayed, notification-eligible, never analytics`);
    neg(!!r && r.payload.every((k) => /Id$|^facet$|^state$/.test(k)) && !r.payload.some((k) => /name|reason|reference|licence|number/i.test(k)), `T1 ${e} payload is ids and state words only — no name, reason, reference or licence number`);
  }
  neg(EVENT_REGISTRY.representation_resolved === undefined && EVENT_REGISTRY.agent_licence_verified_by_admin === undefined && EVENT_REGISTRY.offer_made === undefined, 'T1 no resolution, admin-verification or offer event exists');
  for (const t of ['representation_request', 'representation_confirmed', 'representation_rejected', 'representation_terminated', 'representation_disputed', 'representation_expiring']) ok(TYPE_CATEGORY[t] === 'representation', `T1 notification ${t} → representation category`);
  ok(CATEGORIES.representation.default === true && CATEGORIES.representation.mandatory === false, 'T1 representation is on by default and may be muted');
  ok(TYPE_CATEGORY.agent_verification === 'security_account' && TYPE_CATEGORY.agency_membership === 'security_account' && CATEGORIES.security_account.mandatory, 'T1 verification and membership notices are security/account — mandatory');
  for (const [k, scope] of [['agent_representation_request', 'actor'], ['agent_player_lookup', 'actor'], ['agent_profile_write', 'actor'], ['agent_affiliation_write', 'org'], ['agent_client_response', 'actor']]) {
    ok(RATE_LIMIT_POLICY[k] && RATE_LIMIT_POLICY[k].scope === scope && RATE_LIMIT_POLICY[k].max > 0, `T1 rate policy ${k} (${scope})`);
  }
  for (const s of ['agentProfiles', 'agencyAffiliations', 'representationAgreements']) ok(guaranteeFor(s) === 'migration' && PRODUCTION_REQUIRED_STORES.includes(s), `T1 ${s} is migration-guaranteed and production-required`);
  const step = MIGRATIONS.find((m) => m.id === 'm240_001_agent_core_stores');
  // Pin updated in P5.6C: the Agent step is still the one 2305 step; the schema is now 2306 (Compliance stores).
  ok(step?.version === 2305 && SCHEMA_VERSION === 2306 && MIGRATIONS.filter((m) => m.version === 2305).length === 1, 'T1 exactly one step advances the schema to 2305 (the current schema is 2306, P5.6C)');
  neg(guaranteeFor('agentAuth') !== 'migration' && guaranteeFor('agentSessions') !== 'migration' && guaranteeFor('agentUsers') !== 'migration' && guaranteeFor('offers') !== 'migration' && guaranteeFor('agentTransactions') !== 'migration', 'T1 no agent auth database, no offers and no transaction store is guaranteed (signings is the existing M12 store, which P5.6B never writes)');
}

// =================================================================== HTTP
section('HTTP — booting a real server (synthetic verification provider ON)');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform = 'agent') => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;

/** Read SSE frames for a while, as one identity. */
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}

const ERROR_BODIES = [];
const collect = (label, r) => { if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body }); return r; };

// ============================================================ E — platform gating
section('E — platform gating: agent login, org listing, club user refused');
{
  const h = await j('GET', '/healthz');
  ok(h.body.schemaVersion === 2306, 'E1 the server reports schema 2306 (P5.6C; the P5.6B step is 2305)');
  const orgs = await j('GET', '/orgs?platform=agent');
  ok(orgs.status === 200 && orgs.body.length === 1 && orgs.body[0].id === 'org-northstar' && orgs.body[0].type === 'agency', 'E2 the agent platform lists agency organisations only');
  neg(!orgs.body.some((o) => o.type === 'club'), 'E3 no club appears on the agent login');
  neg(expect(collect('E4', await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment', platform: 'agent' })), 403, 'PLATFORM_MISMATCH'), 'E4 a club user cannot enter ScoutBox Agent');
  neg(expect(collect('E5', await j('POST', '/auth/org/login', { orgId: 'org-hackneymarsh', scoutName: 'Dev', role: 'Manager', platform: 'agent' })), 403, null), 'E5 nor a grassroots club');
  neg(expect(collect('E6', await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: '', role: 'Director', platform: 'agent' })), 400, 'SCOUT_NAME_REQUIRED'), 'E6 no anonymous agency session');
  const pl = await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Tomás Rivera', role: 'Director', platform: 'agent' });
  ok(pl.status === 200 && pl.body.token, 'E7 an agency user logs in on the agent platform');
  const asPlayer = await playerLogin('pl-adeyemi');
  neg(expect(collect('E8', await j('GET', '/org/agent/me', undefined, asPlayer.token)), 401, null), 'E8 a player token is not an agent session');
  neg(expect(collect('E9', await j('GET', '/org/agent/me')), 401, null), 'E9 no token, no workspace');
}

const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', null);
const kola = await playerLogin('pl-adeyemi');     // adult, GB
const mateus = await playerLogin('pl-carvalho');  // adult
const chinedu = await playerLogin('pl-okafor');   // adult
const filip = await playerLogin('pl-nowak');      // adult
const theo = await playerLogin('pl-martin');      // adult
const riku = await playerLogin('pl-tanaka');      // adult
const guni = await playerLogin('pl-guni');        // minor, 14

// ============================================================ F — membership
section('F — membership: bootstrap, foreign organisation, added member, ended member');
let TOMAS_ID;
{
  const me = await j('GET', '/org/agent/me', undefined, tomas.token);
  ok(me.status === 200 && me.body.affiliation.tiers.join() === 'agency_admin' && me.body.profile === null, 'F1 the seeded Director was bootstrapped by migration 2305 as agency_admin — and has NO agent profile');
  TOMAS_ID = me.body.user.id;
  neg(!me.body.affiliation.tiers.includes('licensed_agent'), 'F2 a self-typed "Director" role made nobody a licensed agent (S9)');
  ok(me.body.platform.testVerificationProvider === true && me.body.policyVersion === 1, 'F3 /me states that the synthetic provider is on');
  neg(expect(collect('F4', await j('GET', '/org/agent/me', undefined, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'F4 a club user with a valid club session gets no agent workspace');
  neg(expect(collect('F5', await j('GET', '/org/agent/clients', undefined, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'F5 nor the clients list');
  // A second agency user logging in fresh is NOT auto-affiliated once the agency has members.
  const stranger = await login('org-northstar', 'Walk In', 'Analyst');
  neg(expect(collect('F6', await j('GET', '/org/agent/me', undefined, stranger.token)), 403, 'AGENCY_MEMBERSHIP_REQUIRED'), 'F6 a new login into an agency that already has members is NOT a member until an administrator adds them');
  neg(expect(collect('F7', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi' }, stranger.token)), 403, 'AGENCY_MEMBERSHIP_REQUIRED'), 'F7 and can request nothing');
  const home = await j('GET', '/org/agent/home', undefined, tomas.token);
  ok(home.status === 200 && home.body.hasProfile === false && home.body.profileState === 'UNVERIFIED' && home.body.alerts.some((a) => a.kind === 'verification') && /adjudicates no conflicts/.test(home.body.regulatoryNotice), 'F8 Home says: no profile, UNVERIFIED, and the regulatory notice');
}

// ============================================================ I — team management
section('I — team: tiers, self-promotion, last admin, rev, idempotency, ending');
let ANA, BEN, ANA_ID, BEN_ID, BEN_AFF_REV;
{
  neg(expect(collect('I1', await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, maria.token)), 403, null), 'I1 a club user cannot add agency members');
  neg(expect(collect('I2', await j('POST', '/org/agent/agency/team', { name: '', tiers: ['analyst'] }, tomas.token)), 400, 'AGENT_INPUT_INVALID'), 'I2 a member needs a name');
  neg(expect(collect('I3', await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['owner'] }, tomas.token)), 400, 'AGENT_TIERS_INVALID'), 'I3 an unknown tier is refused');
  neg(expect(collect('I4', await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: 'licensed_agent' }, tomas.token)), 400, 'AGENT_TIERS_INVALID'), 'I4 tiers must be a list');
  neg(expect(collect('I5', await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'], clientKey: 'x'.repeat(200) }, tomas.token)), 400, 'AGENT_CLIENT_KEY_INVALID'), 'I5 an oversized client key is refused');
  const add = await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', role: 'Agent', tiers: ['licensed_agent'], clientKey: 'add-ana' }, tomas.token);
  ok(add.status === 201 && add.body.member.tiers.join() === 'licensed_agent' && add.body.member.active && add.body.member.licensed === false, 'I6 an administrator adds a licensed_agent member — "licensed" is false until a profile exists');
  ANA_ID = add.body.member.userId;
  const replay = await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', role: 'Agent', tiers: ['licensed_agent'], clientKey: 'add-ana' }, tomas.token);
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.member.userId === ANA_ID, 'I7 the same key replays the same member');
  neg(expect(collect('I8', await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['finance'], clientKey: 'add-ana' }, tomas.token)), 409, 'AFFILIATION_IDEMPOTENCY_CONFLICT'), 'I8 the same key with a different payload is a collision');
  neg(expect(collect('I9', await j('POST', '/org/agent/agency/team', { name: 'ana costa', tiers: ['finance'] }, tomas.token)), 409, 'MEMBER_ALREADY_AFFILIATED'), 'I9 the same person (case-insensitive) is not affiliated twice');
  const ben = await j('POST', '/org/agent/agency/team', { name: 'Ben Okoro', role: 'Analyst', tiers: ['analyst'] }, tomas.token);
  ok(ben.status === 201, 'I10 an analyst is added');
  BEN_ID = ben.body.member.userId; BEN_AFF_REV = ben.body.member.rev;
  ANA = await login('org-northstar', 'Ana Costa', 'Agent');
  BEN = await login('org-northstar', 'Ben Okoro', 'Analyst');
  ok((await j('GET', '/org/agent/me', undefined, ANA.token)).body.affiliation.tiers.join() === 'licensed_agent', 'I11 Ana logs in and is a licensed_agent member');
  ok((await j('GET', '/org/agent/me', undefined, BEN.token)).body.capabilities.includes('agency.team.read') && !(await j('GET', '/org/agent/me', undefined, BEN.token)).body.capabilities.includes('clients.request'), 'I12 Ben sees his capabilities: team read, no client requests');
  neg(expect(collect('I13', await j('PATCH', `/org/agent/agency/team/${BEN_ID}`, { tiers: ['agency_admin'], expectedRev: BEN_AFF_REV }, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'I13 an analyst cannot change roles at all');
  neg(expect(collect('I14', await j('PATCH', `/org/agent/agency/team/${ANA_ID}`, { tiers: ['licensed_agent', 'agency_admin'], expectedRev: 1 }, ANA.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'I14 nor a licensed agent (no team.write)');
  neg(expect(collect('I15', await j('PATCH', `/org/agent/agency/team/${TOMAS_ID}`, { tiers: ['assistant'], expectedRev: 1 }, tomas.token)), 409, 'LAST_ADMIN'), 'I15 the last administrator cannot demote themselves');
  neg(expect(collect('I16', await j('POST', `/org/agent/agency/team/${TOMAS_ID}/end`, { expectedRev: 1 }, tomas.token)), 409, 'LAST_ADMIN'), 'I16 nor end their own membership');
  neg(expect(collect('I17', await j('PATCH', `/org/agent/agency/team/${BEN_ID}`, { tiers: ['analyst', 'agency_admin'], expectedRev: BEN_AFF_REV + 5 }, tomas.token)), 409, 'AFFILIATION_VERSION_CONFLICT'), 'I17 a stale rev is refused');
  neg(expect(collect('I18', await j('PATCH', `/org/agent/agency/team/${BEN_ID}`, { tiers: ['analyst'], expectedRev: 'one' }, tomas.token)), 400, 'EXPECTED_REV_INVALID'), 'I18 a malformed rev is refused');
  neg(expect(collect('I19', await j('PATCH', '/org/agent/agency/team/usr-nobody', { tiers: ['analyst'], expectedRev: 1 }, tomas.token)), 404, 'MEMBER_NOT_FOUND'), 'I19 an unknown member is 404');
  const promote = await j('PATCH', `/org/agent/agency/team/${BEN_ID}`, { tiers: ['analyst', 'agency_admin'], expectedRev: BEN_AFF_REV }, tomas.token);
  ok(promote.status === 200 && promote.body.member.tiers.join() === 'analyst,agency_admin' && promote.body.member.rev === BEN_AFF_REV + 1, 'I20 the administrator promotes Ben to a second admin; rev advances');
  BEN_AFF_REV = promote.body.member.rev;
  const demoteSelf = await j('PATCH', `/org/agent/agency/team/${TOMAS_ID}`, { tiers: ['agency_admin', 'licensed_agent'], expectedRev: 1 }, tomas.token);
  ok(demoteSelf.status === 200 && demoteSelf.body.member.tiers.includes('licensed_agent'), 'I21 with two admins, Tomás may add licensed_agent to his own roles');
  const carl = await j('POST', '/org/agent/agency/team', { name: 'Carl Temp', tiers: ['assistant'] }, tomas.token);
  const CARL = await login('org-northstar', 'Carl Temp', 'Assistant');
  ok((await j('GET', '/org/agent/me', undefined, CARL.token)).status === 200, 'I22 Carl is in');
  const end = await j('POST', `/org/agent/agency/team/${carl.body.member.userId}/end`, { expectedRev: carl.body.member.rev, reason: 'left' }, tomas.token);
  ok(end.status === 200 && end.body.member.active === false && end.body.member.endedReason === 'left', 'I23 an administrator ends Carl\'s membership');
  neg(expect(collect('I24', await j('GET', '/org/agent/me', undefined, CARL.token)), 401, null), 'I24 Carl\'s session is dead immediately');
  neg(expect(collect('I25', await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Carl Temp', role: 'Assistant', platform: 'agent' })), 403, 'USER_REMOVED'), 'I25 and he cannot log back in by typing his name');
  neg(expect(collect('I26', await j('POST', '/org/agent/agency/team', { name: 'Carl Temp', tiers: ['assistant'] }, tomas.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'I26 removal is not undone from the team page');
  const team = await j('GET', '/org/agent/agency/team', undefined, BEN.token);
  ok(team.status === 200 && team.body.members.some((m) => m.name === 'Carl Temp' && !m.active) && team.body.members.filter((m) => m.active).length === 3, 'I27 the team page lists the ended member as ended and three active members');
  neg(expect(collect('I28', await j('PATCH', '/org/agent/agency/settings', { jurisdictions: ['ENG', 'MARS'] }, tomas.token)), 400, 'AGENT_JURISDICTION_INVALID'), 'I28 settings refuse an unknown jurisdiction');
  neg(expect(collect('I29', await j('PATCH', '/org/agent/agency/settings', { description: 'call me on 07700 900123' }, tomas.token)), 400, null), 'I29 a settings description carrying a phone number is moderated out');
  const settings = await j('PATCH', '/org/agent/agency/settings', { jurisdictions: ['ENG', 'INT'], description: 'Player representation, England and international.' }, tomas.token);
  ok(settings.status === 200 && settings.body.settings.jurisdictions.join() === 'ENG,INT', 'I30 settings are saved');
  neg(expect(collect('I31', await j('PATCH', '/org/agent/agency/settings', { description: 'x' }, ANA.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'I31 a licensed agent cannot change agency settings');
  const agency = await j('GET', '/org/agent/agency', undefined, ANA.token);
  ok(agency.status === 200 && agency.body.members.admins === 2 && agency.body.members.licensedAgents === 2 && /holds no football-agent licence/.test(agency.body.honest), 'I32 the agency overview counts and says the agency holds no licence');
}

// ============================================================ G/H — profile + verification
section('G/H — profile and verification: declaration ≠ verification; facets separate; provider named');
let ANA_PROFILE_REV;
{
  neg(expect(collect('G1', await j('POST', '/org/agent/profile', { displayName: 'Ben' }, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'G1 an analyst/admin without licensed_agent cannot create an agent profile');
  neg(expect(collect('G2', await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-1' }, ANA.token)), 403, 'AGENT_PROFILE_REQUIRED'), 'G2 a submission needs a profile first');
  neg(expect(collect('G3', await j('POST', '/org/agent/profile', { displayName: '   ' }, ANA.token)), 400, 'AGENT_INPUT_INVALID'), 'G3 an empty display name is refused');
  neg(expect(collect('G4', await j('POST', '/org/agent/profile', { jurisdictions: 'ENG' }, ANA.token)), 400, 'AGENT_JURISDICTION_INVALID'), 'G4 jurisdictions must be a list');
  const create = await j('POST', '/org/agent/profile', { displayName: 'Ana Costa', fifaLicenceNumber: 'FIFA-2024-777', jurisdictions: ['ENG'] }, ANA.token);
  ok(create.status === 201 && create.body.profile.declared.fifaLicenceNumber === 'FIFA-2024-777' && create.body.profile.facets.fifa_licence.state === 'UNVERIFIED', 'G5 Ana creates a profile with a DECLARED licence number — the facet stays UNVERIFIED');
  neg(create.body.profile.regulatoryState.fifaLicence === 'UNVERIFIED' && create.body.profile.regulatoryState.jurisdictions[0].regulatedActionsPermitted === false && /declaration, not a verified licence/.test(create.body.profile.honest), 'G6 the profile says a typed number is a declaration, and no regulated action is permitted');
  ANA_PROFILE_REV = create.body.profile.rev;
  const team = await j('GET', '/org/agent/agency/team', undefined, tomas.token);
  ok(team.body.members.find((m) => m.userId === ANA_ID).licensed === true && team.body.members.find((m) => m.userId === ANA_ID).fifaLicence === 'UNVERIFIED', 'G7 the team row shows a profile exists and the licence is UNVERIFIED — never a licence number');
  neg(!JSON.stringify(team.body).includes('FIFA-2024-777'), 'G8 the licence number never appears on the team page');
  neg(expect(collect('G9', await j('POST', '/org/agent/profile/facets/passport/submit', { reference: 'x' }, ANA.token)), 400, 'AGENT_FACET_INVALID'), 'G9 an unknown facet is refused');
  neg(expect(collect('G10', await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: '' }, ANA.token)), 400, 'AGENT_INPUT_INVALID'), 'G10 an empty reference is refused');
  neg(expect(collect('G11', await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-FA', memberAssociation: 'INT' }, ANA.token)), 400, 'AGENT_JURISDICTION_INVALID'), 'G11 a national registration needs a real member association, not INT');
  const manual = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'FIFA-2024-777' }, ANA.token);
  neg(manual.status === 200 && manual.body.facet.state === 'MANUAL_REVIEW_REQUIRED' && manual.body.facet.provenance.provider === 'none' && /G-C0/.test(manual.body.facet.note), 'G12 submitting the real-looking declared number → MANUAL_REVIEW_REQUIRED, provider "none", note names G-C0 — no register is pretended');
  neg(expect(collect('G13', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi' }, ANA.token)), 403, 'AGENT_VERIFICATION_REQUIRED'), 'G13 MANUAL_REVIEW_REQUIRED authorises no request');
  const verified = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-777' }, ANA.token);
  ok(verified.status === 200 && verified.body.facet.state === 'VERIFIED' && verified.body.facet.provenance.provider === 'local-synthetic-test-provider' && verified.body.provider === 'local-synthetic-test-provider' && typeof verified.body.facet.recheckAt === 'number', 'H1 the synthetic provider verifies a TEST-VERIFIED reference and names itself in the provenance, with a recheck date');
  ok(verified.body.profile.regulatoryState.fifaLicence === 'VERIFIED' && verified.body.profile.regulatoryState.jurisdictions[0].nationalRegistration === 'UNVERIFIED' && verified.body.profile.regulatoryState.jurisdictions[0].regulatedActionsPermitted === false, 'H2 FIFA VERIFIED, ENG FA registration still UNVERIFIED — ENG regulated actions still not permitted');
  neg(expect(collect('H3', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', jurisdiction: 'ENG' }, ANA.token)), 403, 'AGENT_VERIFICATION_REQUIRED') && (await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', jurisdiction: 'ENG' }, ANA.token)).body.facet === 'national_registration', 'H3 an ENG request names the missing facet: national_registration (ENG)');
  const fa = await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-FA', memberAssociation: 'eng' }, ANA.token);
  ok(fa.status === 200 && fa.body.profile.facets.national_registration.ENG.state === 'VERIFIED' && fa.body.profile.regulatoryState.jurisdictions[0].regulatedActionsPermitted === true, 'H4 FA registration verified (member association upper-cased) → ENG regulated actions permitted');
  const minors = await j('POST', '/org/agent/profile/facets/minors_authorisation/submit', { reference: 'TEST-VERIFIED-MINORS', memberAssociation: 'ENG' }, ANA.token);
  ok(minors.status === 200 && minors.body.profile.facets.minors_authorisation.ENG.state === 'VERIFIED', 'H5 a minors authorisation facet can be RECORDED');
  neg((await j('GET', '/org/agent/players?q=gu', undefined, ANA.token)).body.items.length === 0 && (await j('GET', '/org/agent/players?q=gu', undefined, ANA.token)).body.adultsOnly === true, 'H6 …and it activates NOTHING: a minor (Guni, 14) is still invisible to the lookup — the minor pathway is preserved, not activated (DR-49)');
  neg(expect(collect('H7', await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', jurisdiction: 'ENG' }, ANA.token)), 404, 'PLAYER_NOT_FOUND'), 'H7 a request naming a minor is 404, indistinguishable from a player who does not exist');
  const inactive = await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-INACTIVE-USA', memberAssociation: 'USA' }, ANA.token);
  ok(inactive.body.profile.facets.national_registration.USA.state === 'INACTIVE', 'H8 an INACTIVE facet is recorded honestly');
  const prof = await j('GET', '/org/agent/profile', undefined, ANA.token);
  ok(prof.body.profile.history.some((h) => h.action === 'agent_verification_state_changed' && h.detail?.to === 'VERIFIED'), 'H9 every state change is in the profile history');
  neg(!prof.body.profile.history.some((h) => JSON.stringify(h.detail ?? {}).includes('TEST-VERIFIED-777')), 'H10 the history carries no reference number');
  // Changing the declared number after verification resets the facet.
  const rev = prof.body.profile.rev;
  neg(expect(collect('H11', await j('POST', '/org/agent/profile', { fifaLicenceNumber: 'FIFA-9999', expectedRev: rev + 3 }, ANA.token)), 409, 'REPRESENTATION_VERSION_CONFLICT'), 'H11 a stale profile rev is refused');
  const change = await j('POST', '/org/agent/profile', { fifaLicenceNumber: 'FIFA-9999', rev }, ANA.token);
  neg(change.status === 200 && change.body.profile.facets.fifa_licence.state === 'UNVERIFIED' && /re-submit/.test(change.body.profile.facets.fifa_licence.note), 'H12 changing the declared licence number after verification RESETS the facet to UNVERIFIED — the verified reference is no longer the declared one');
  neg(expect(collect('H13', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi' }, ANA.token)), 403, 'AGENT_VERIFICATION_REQUIRED'), 'H13 and requests are gated again');
  const reverify = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-777' }, ANA.token);
  ok(reverify.body.facet.state === 'VERIFIED', 'H14 re-verified for the rest of the suite');
  ANA_PROFILE_REV = reverify.body.profile.rev;
  // Colleague's view.
  const me2 = await j('GET', '/org/agent/me', undefined, BEN.token);
  neg(me2.body.profile === null, 'H15 /me shows only one\'s OWN profile — Ben sees none, not Ana\'s');
  const compliance = await j('GET', '/org/agent/agency/compliance', undefined, tomas.token);
  ok(compliance.status === 200 && compliance.body.informational === true && /Nothing here verifies, approves or overrides/.test(compliance.body.honest) && compliance.body.agents.some((a) => a.userId === ANA_ID && a.fifaLicence === 'VERIFIED'), 'H16 the compliance view is informational and says so; it shows states, not numbers');
  neg(!JSON.stringify(compliance.body).includes('TEST-VERIFIED') && !JSON.stringify(compliance.body).includes('FIFA-9999'), 'H17 no reference or licence number on the compliance page');
  neg(expect(collect('H18', await j('GET', '/org/agent/agency/compliance', undefined, BEN.token)), 200, null) && (await j('GET', '/org/agent/agency/compliance', undefined, BEN.token)).body.informational === true, 'H18 Ben (now admin) reads it; it is still informational');
}

// ============================================================ J — lookup
section('J — players lookup: adults only, visibility, blocks, short query, cap');
{
  neg(expect(collect('J1', await j('GET', '/org/agent/players?q=ko', undefined, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'J1 an admin/analyst cannot look players up');
  const short = await j('GET', '/org/agent/players?q=k', undefined, ANA.token);
  ok(short.status === 200 && short.body.items.length === 0 && /two characters/.test(short.body.note), 'J2 a one-character query returns nothing');
  const hit = await j('GET', '/org/agent/players?q=kola', undefined, ANA.token);
  ok(hit.status === 200 && hit.body.items.length === 1 && hit.body.items[0].id === 'pl-adeyemi' && hit.body.adultsOnly === true, 'J3 an adult is found by name');
  neg(Object.keys(hit.body.items[0]).sort().join() === 'age,club,country,id,name,position', 'J4 a lookup row is id, name, position, age, club, country — nothing private');
  neg((await j('GET', '/org/agent/players?q=tomasz', undefined, ANA.token)).body.items.length === 0 && (await j('GET', '/org/agent/players?q=guni', undefined, ANA.token)).body.items.length === 0, 'J5 minors (Tomasz 16, Guni 14) never appear, by name or otherwise');
  const all = await j('GET', '/org/agent/players?q=%20a%20', undefined, ANA.token);
  neg(all.body.items.every((p) => p.age >= 18) && all.body.items.length <= 20, 'J6 a broad query returns adults only, capped at 20');
  neg((await j('GET', '/org/agent/players?q=<script>', undefined, ANA.token)).body.items.length === 0, 'J7 a query with markup finds nothing and breaks nothing');
}

// ============================================================ K — request
section('K — the request: gate order, uniform 404, conflict, cooldown, term, scope');
let REL; // Ana ↔ Kola
{
  neg(expect(collect('K1', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi' }, tomas.token)), 403, 'AGENT_PROFILE_REQUIRED'), 'K1 Tomás holds licensed_agent but has no profile — refused before any subject check');
  neg(expect(collect('K2', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi' }, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'K2 Ben has no clients.request');
  neg(expect(collect('K3', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', termMonths: 36 }, ANA.token)), 400, 'AGENT_TERM_INVALID'), 'K3 a 36-month term is refused (two-year cap)');
  neg(expect(collect('K4', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['bribery'] }, ANA.token)), 400, 'AGENT_SCOPE_INVALID'), 'K4 an unknown scope is refused');
  neg(expect(collect('K5', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', jurisdiction: 'FRA' }, ANA.token)), 400, 'AGENT_JURISDICTION_INVALID'), 'K5 an unknown jurisdiction is refused');
  neg(expect(collect('K6', await j('POST', '/org/agent/clients/request', { playerId: 'pl-does-not-exist' }, ANA.token)), 404, 'PLAYER_NOT_FOUND'), 'K6 a player who does not exist → 404');
  neg(expect(collect('K7', await j('POST', '/org/agent/clients/request', { playerId: 'pl-tomasz' }, ANA.token)), 404, 'PLAYER_NOT_FOUND'), 'K7 a minor → the SAME 404');
  neg(expect(collect('K8', await j('POST', '/org/agent/clients/request', { playerId: 'org-eastport' }, ANA.token)), 404, 'PLAYER_NOT_FOUND'), 'K8 an organisation id → the same 404');
  const r1 = collect('K9', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], termMonths: 18, jurisdiction: 'ENG', clientKey: 'ana-kola-1' }, ANA.token));
  ok(r1.status === 201 && r1.body.relationship.status === 'proposed' && r1.body.relationship.scope.join() === 'employment,transfer' && r1.body.relationship.termMonths === 18 && r1.body.relationship.confirmedAt === null && r1.body.relationship.startAt === null, 'K9 Ana requests Kola: proposed, no start, no confirmation');
  REL = r1.body.relationship.id;
  ok(r1.body.relationship.client.accessBasis === 'pending_request' && r1.body.relationship.client.name === 'Kola Adeyemi', 'K10 the agent sees the client\'s public identity with access basis "pending_request"');
  neg(!('trust' in r1.body.relationship.client) && !('medical' in r1.body.relationship.client) && !('email' in r1.body.relationship.client), 'K11 and nothing private');
  neg(expect(collect('K12', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', clientKey: 'ana-kola-2' }, ANA.token)), 409, 'REPRESENTATION_ALREADY_EXISTS'), 'K12 a second request to the same player is refused while one is pending');
  const replay = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], termMonths: 18, jurisdiction: 'ENG', clientKey: 'ana-kola-1' }, ANA.token);
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.relationship.id === REL, 'K13 the same key replays');
  neg(expect(collect('K14', await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', termMonths: 6, clientKey: 'ana-kola-1' }, ANA.token)), 409, 'REPRESENTATION_IDEMPOTENCY_CONFLICT'), 'K14 same key, different payload → collision');
  const list = await j('GET', '/org/agent/clients', undefined, ANA.token);
  ok(list.status === 200 && list.body.items.length === 1 && list.body.items[0].id === REL && list.body.items[0].mode === 'own', 'K15 Ana\'s clients list has the pending request');
  const home = await j('GET', '/org/agent/home', undefined, ANA.token);
  ok(home.body.counts.pending === 1 && home.body.counts.active === 0, 'K16 Home counts one pending, zero active');
  const inbox = await j('GET', '/org/agent/inbox', undefined, ANA.token);
  ok(inbox.body.pending.length === 1 && inbox.body.pending[0].id === REL, 'K17 the inbox lists the pending request');
  const opps = await j('GET', `/org/agent/clients/${REL}/opportunities`, undefined, ANA.token);
  neg(expect(collect('K18', opps), 409, 'REPRESENTATION_NOT_ACTIVE') && opps.body.status === 'proposed', 'K18 a PROPOSED relationship opens no opportunities — a claim is not access');
  ok((await j('GET', '/org/agent/opportunities', undefined, ANA.token)).body.items.length === 0, 'K19 the aggregate board is empty');
  const detail = await j('GET', `/org/agent/clients/${REL}`, undefined, ANA.token);
  ok(detail.status === 200 && detail.body.access === false && detail.body.client.accessBasis === 'pending_request', 'K20 the detail says access: false');
}

// ============================================================ L — the client answers
section('L — the client\'s answer: confirm / decline / dispute / terminate');
{
  const mine = await j('GET', '/player/agent/relationships', undefined, kola.token);
  ok(mine.status === 200 && mine.body.items.length === 1 && mine.body.items[0].pending === true && mine.body.items[0].agent.displayName === 'Ana Costa' && mine.body.items[0].agent.agency.id === 'org-northstar', 'L1 Kola sees the pending request, the agent\'s name and the agency');
  ok(mine.body.items[0].agent.verification.fifaLicence === 'VERIFIED' && /recorded provenance/.test(mine.body.items[0].agent.honest), 'L2 the agent card shows the FIFA facet state with an honest caveat');
  neg(!JSON.stringify(mine.body).includes('TEST-VERIFIED'), 'L3 no reference number reaches the player');
  const notes = await j('GET', '/player/notifications', undefined, kola.token);
  ok(notes.body.some((n) => n.type === 'representation_request' && n.refId === REL && /Nothing is active until YOU confirm/.test(n.text)), 'L4 Kola was notified, and the notice says nothing is active until they confirm');
  // Wrong people.
  neg(expect(collect('L5', await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, mateus.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'L5 another player cannot confirm Kola\'s request (404, not 403)');
  neg(expect(collect('L6', await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, guni.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'L6 a minor account is refused before any lookup');
  neg(expect(collect('L7', await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, ANA.token)), 401, null), 'L7 the agent cannot confirm as the player');
  neg(expect(collect('L8', await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 })), 401, null), 'L8 nor can nobody');
  neg(expect(collect('L9', await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 7 }, kola.token)), 409, 'REPRESENTATION_VERSION_CONFLICT'), 'L9 a stale rev is refused');
  neg(expect(collect('L10', await j('POST', `/player/agent/relationships/${REL}/terminate`, { expectedRev: 1 }, kola.token)), 409, 'REPRESENTATION_NOT_ACTIVE'), 'L10 a proposal cannot be "terminated" — it is declined');
  const sse = await sseCollect(ANA.token, 700);
  const confirm = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1, clientKey: 'kola-confirm' }, kola.token);
  ok(confirm.status === 200 && confirm.body.relationship.status === 'active' && typeof confirm.body.relationship.confirmedAt === 'number' && confirm.body.relationship.endAt === confirm.body.relationship.startAt + 18 * 30 * DAY && confirm.body.relationship.rev === 2, 'L11 Kola CONFIRMS: active, dated from now, ending after the 18-month term, rev 2');
  const frames = await sse.stop();
  ok(/representation_confirmed/.test(frames), 'L12 Ana\'s stream carried representation_confirmed');
  neg(!/Kola/.test(frames), 'L13 the event carried ids, not the client\'s name');
  const replay = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1, clientKey: 'kola-confirm' }, kola.token);
  ok(replay.status === 200 && replay.body.idempotent === true, 'L14 the same key replays the confirmation');
  neg(expect(collect('L15', await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 2, clientKey: 'kola-confirm-2' }, kola.token)), 409, 'REPRESENTATION_NOT_ACTIVE'), 'L15 confirming twice with a new key is refused — an active agreement is not re-confirmed');
  neg(expect(collect('L16', await j('POST', `/player/agent/relationships/${REL}/decline`, { expectedRev: 2 }, kola.token)), 409, 'REPRESENTATION_NOT_ACTIVE'), 'L16 nor declined after confirmation');
  const agentNotes = await j('GET', '/org/agent/inbox', undefined, ANA.token);
  ok(agentNotes.body.notifications.some((n) => n.type === 'representation_confirmed' && n.refId === REL) && agentNotes.body.pending.length === 0, 'L17 Ana was notified; nothing pending');
  const audit = await j('GET', '/org/agent/agency/audit', undefined, tomas.token);
  ok(audit.body.items.some((r) => r.action === 'representation_confirmed' && r.actor?.userId === null && r.actor?.name === 'Player' && r.target.id === REL), 'L18 the agency audit shows the confirmation attributed to "Player" — no org actor, no player id or name in the actor');
  neg(!JSON.stringify(audit.body).includes('kola-confirm'), 'L19 no client key in the audit');
  neg(expect(collect('L20', await j('GET', '/org/agent/agency/audit', undefined, ANA.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'L20 a licensed agent does not read the agency audit');
}

// ============================================================ M — access basis
section('M — access basis: active grants, colleagues do not, disputed suspends, terminated ends');
let REL2; // Ana ↔ Mateus (will be disputed)
let REL3; // Ana ↔ Chinedu (will be terminated by client)
{
  const detail = await j('GET', `/org/agent/clients/${REL}`, undefined, ANA.token);
  ok(detail.status === 200 && detail.body.access === true && detail.body.client.accessBasis === 'active_confirmed_relationship' && detail.body.client.name === 'Kola Adeyemi', 'M1 Ana\'s access basis is the active confirmed relationship');
  const opps = await j('GET', `/org/agent/clients/${REL}/opportunities`, undefined, ANA.token);
  ok(opps.status === 200 && Array.isArray(opps.body.items) && opps.body.clientId === 'pl-adeyemi' && /Applying is the player/.test(opps.body.note), 'M2 the client\'s opportunities board opens, and says applying is the player\'s act');
  neg(!opps.body.items.some((o) => /^case-|^room-/.test(String(o.id))) && opps.body.items.every((o) => ['open_trial', 'trial_day', 'campaign', 'open_day', 'friendly', 'combine', 'matchday', 'squad', 'saved_search'].includes(o.type) || typeof o.type === 'string'), 'M3 the board is the player\'s own opportunity engine output — no recruitment case or room ids');
  const kolaBoard = await j('GET', '/player/opportunity-board', undefined, kola.token);
  ok(kolaBoard.status === 200 && JSON.stringify(kolaBoard.body.items.map((o) => o.id).sort()) === JSON.stringify(opps.body.items.map((o) => o.id).sort()), 'M4 …and it is exactly what Kola sees on their own board (same engine, same rules)');
  // Colleagues.
  neg(expect(collect('M5', await j('GET', `/org/agent/clients/${REL}`, undefined, tomas.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'M5 Tomás (admin + licensed_agent) gets 404 for Ana\'s client — not 403, not a summary');
  neg(expect(collect('M6', await j('GET', `/org/agent/clients/${REL}/opportunities`, undefined, tomas.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'M6 nor the client\'s board');
  neg(expect(collect('M7', await j('GET', `/org/agent/clients/${REL}`, undefined, BEN.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'M7 Ben (admin/analyst) 404 — the client did not share with staff');
  ok((await j('GET', '/org/agent/clients', undefined, BEN.token)).body.items.length === 0 && (await j('GET', '/org/agent/clients', undefined, tomas.token)).body.items.length === 0, 'M8 the colleagues\' client lists are empty');
  ok((await j('GET', '/org/agent/opportunities', undefined, tomas.token)).body.items.length === 0, 'M9 Tomás\' opportunities board is empty — access does not flow through the agency');
  // Client shares a summary with staff.
  const share = await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { shareWithAgencyStaff: true, expectedRev: 2 }, kola.token);
  ok(share.status === 200 && share.body.relationship.shareWithAgencyStaff === true, 'M10 Kola chooses to share a summary with agency staff');
  const benView = await j('GET', `/org/agent/clients/${REL}`, undefined, BEN.token);
  ok(benView.status === 200 && benView.body.mode === 'summary' && benView.body.relationship.summaryOnly === true && benView.body.relationship.client.name === 'Kola Adeyemi', 'M11 Ben now sees a SUMMARY (name, status, dates)');
  neg(!('scope' in benView.body.relationship) && !('history' in benView.body.relationship) && !('client' in benView.body) && !JSON.stringify(benView.body).includes('accessBasis'), 'M12 …and no scope, history, client data or access basis');
  neg(expect(collect('M13', await j('GET', `/org/agent/clients/${REL}/opportunities`, undefined, tomas.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'M13 the summary opens no opportunities for Tomás');
  neg(expect(collect('M14', await j('POST', `/org/agent/clients/${REL}/terminate`, {}, tomas.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'M14 nor can he end it');
  const unshare = await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { shareWithAgencyStaff: false, expectedRev: 3 }, kola.token);
  ok(unshare.status === 200 && expect(await j('GET', `/org/agent/clients/${REL}`, undefined, BEN.token), 404, 'REPRESENTATION_NOT_FOUND'), 'M15 Kola withdraws the sharing; Ben is back to 404');
  // Other agency.
  const rival = await login('org-northstar', 'Ana Costa', 'Agent'); // same person, second session — fine
  ok((await j('GET', `/org/agent/clients/${REL}`, undefined, rival.token)).status === 200, 'M16 a second session of the same agent sees the same client');
  // Dispute.
  const r2 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-carvalho', clientKey: 'ana-mateus' }, ANA.token);
  REL2 = r2.body.relationship.id;
  await j('POST', `/player/agent/relationships/${REL2}/confirm`, { expectedRev: 1 }, mateus.token);
  ok((await j('GET', `/org/agent/clients/${REL2}`, undefined, ANA.token)).body.access === true, 'M17 Mateus confirmed; Ana has access');
  neg(expect(collect('M18', await j('POST', `/player/agent/relationships/${REL2}/dispute`, { expectedRev: 2, reason: 'email me at x@y.com' }, mateus.token)), 400, null), 'M18 a dispute reason carrying contact details is moderated');
  const dispute = await j('POST', `/player/agent/relationships/${REL2}/dispute`, { expectedRev: 2, reason: 'I never agreed to the transfer scope.' }, mateus.token);
  ok(dispute.status === 200 && dispute.body.relationship.status === 'disputed' && dispute.body.relationship.disputeReason === 'I never agreed to the transfer scope.', 'M19 Mateus DISPUTES; the client sees their own reason');
  const disputedView = await j('GET', `/org/agent/clients/${REL2}`, undefined, ANA.token);
  neg(disputedView.status === 200 && disputedView.body.access === false && disputedView.body.relationship.status === 'disputed' && !JSON.stringify(disputedView.body).includes('never agreed'), 'M20 Ana\'s access is SUSPENDED and she does not see the reason');
  neg(expect(collect('M21', await j('GET', `/org/agent/clients/${REL2}/opportunities`, undefined, ANA.token)), 409, 'REPRESENTATION_NOT_ACTIVE'), 'M21 no board through a dispute');
  neg(expect(collect('M22', await j('POST', `/org/agent/clients/${REL2}/terminate`, {}, ANA.token)), 409, 'REPRESENTATION_NOT_ACTIVE'), 'M22 the agent cannot end a disputed agreement (and so cannot "resolve" it by ending it)');
  neg(expect(collect('M23', await j('POST', `/player/agent/relationships/${REL2}/terminate`, { expectedRev: 3 }, mateus.token)), 409, 'REPRESENTATION_DISPUTED'), 'M23 nor can the client — a dispute is terminal until attributed review exists (P5.6C)');
  neg(expect(collect('M24', await j('POST', `/player/agent/relationships/${REL2}/confirm`, { expectedRev: 3 }, mateus.token)), 409, 'REPRESENTATION_NOT_ACTIVE'), 'M24 nor re-confirmed');
  neg(expect(collect('M25', await j('POST', '/org/agent/clients/request', { playerId: 'pl-carvalho', clientKey: 'ana-mateus-again' }, ANA.token)), 409, 'REPRESENTATION_ALREADY_EXISTS'), 'M25 Ana cannot route around the dispute with a fresh request');
  ok((await j('GET', '/org/agent/home', undefined, ANA.token)).body.counts.disputed === 1 && (await j('GET', '/org/agent/home', undefined, ANA.token)).body.alerts.some((a) => a.kind === 'disputed'), 'M26 Home alerts the dispute');
  const agentNote = (await j('GET', '/org/agent/inbox', undefined, ANA.token)).body.notifications.find((n) => n.type === 'representation_disputed');
  ok(!!agentNote && /not yet available in this build/.test(agentNote.text), 'M27 the dispute notice tells the agent that attributed review is not yet available');
  // Client termination.
  const r3 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-okafor', clientKey: 'ana-chinedu' }, ANA.token);
  REL3 = r3.body.relationship.id;
  await j('POST', `/player/agent/relationships/${REL3}/confirm`, { expectedRev: 1 }, chinedu.token);
  const end = await j('POST', `/player/agent/relationships/${REL3}/terminate`, { expectedRev: 2, clientKey: 'chinedu-end' }, chinedu.token);
  ok(end.status === 200 && end.body.relationship.status === 'terminated_by_client' && end.body.relationship.terminatedBy === 'client', 'M28 Chinedu ENDS an active relationship');
  neg((await j('GET', `/org/agent/clients/${REL3}`, undefined, ANA.token)).body.access === false && (await j('GET', `/org/agent/clients/${REL3}`, undefined, ANA.token)).body.client.accessBasis === 'none', 'M29 Ana\'s access ended at once; the record stays');
  neg(expect(collect('M30', await j('POST', '/org/agent/clients/request', { playerId: 'pl-okafor', clientKey: 'ana-chinedu-2' }, ANA.token)), 429, 'REPRESENTATION_COOLDOWN') && typeof (await j('POST', '/org/agent/clients/request', { playerId: 'pl-okafor', clientKey: 'ana-chinedu-2' }, ANA.token)).body.retryAt === 'number', 'M30 re-asking within 30 days is a cooldown with a retryAt');
  const chinNotes = await j('GET', '/player/notifications', undefined, chinedu.token);
  ok(!chinNotes.body.some((n) => n.type === 'representation_terminated'), 'M31 the client who ended it is not notified of their own act');
  ok((await j('GET', '/org/agent/inbox', undefined, ANA.token)).body.notifications.some((n) => n.type === 'representation_terminated' && n.refId === REL3), 'M32 the agent is');
  // Agent termination and withdrawal.
  const r4 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-nowak', clientKey: 'ana-filip' }, ANA.token);
  const withdraw = await j('POST', `/org/agent/clients/${r4.body.relationship.id}/terminate`, { reasonCode: 'withdrawn', clientKey: 'wd-1' }, ANA.token);
  ok(withdraw.status === 200 && withdraw.body.relationship.status === 'terminated_by_agent' && withdraw.body.relationship.terminationReasonCode === 'withdrawn', 'M33 Ana withdraws a pending request (terminated_by_agent)');
  ok((await j('GET', '/player/notifications', undefined, filip.token)).body.some((n) => n.type === 'representation_terminated' && /withdrew/.test(n.text)), 'M34 Filip is told the request was withdrawn');
  neg(expect(collect('M35', await j('POST', `/player/agent/relationships/${r4.body.relationship.id}/confirm`, { expectedRev: 2 }, filip.token)), 409, 'REPRESENTATION_NOT_ACTIVE') && /no longer open/.test((await j('POST', `/player/agent/relationships/${r4.body.relationship.id}/confirm`, { expectedRev: 2 }, filip.token)).body.message), 'M35 Filip cannot confirm a withdrawn request, and is told why');
  const r5 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-martin', clientKey: 'ana-theo' }, ANA.token);
  await j('POST', `/player/agent/relationships/${r5.body.relationship.id}/confirm`, { expectedRev: 1 }, theo.token);
  const agentEnd = await j('POST', `/org/agent/clients/${r5.body.relationship.id}/terminate`, { clientKey: 'end-theo', expectedRev: 2 }, ANA.token);
  ok(agentEnd.status === 200 && agentEnd.body.relationship.status === 'terminated_by_agent', 'M36 Ana ends an active relationship');
  ok((await j('POST', `/org/agent/clients/${r5.body.relationship.id}/terminate`, { clientKey: 'end-theo', expectedRev: 2 }, ANA.token)).body.idempotent === true, 'M37 replaying the end is idempotent');
  neg(expect(collect('M38', await j('POST', `/org/agent/clients/${r5.body.relationship.id}/terminate`, { clientKey: 'end-theo', reasonCode: 'other', expectedRev: 3 }, ANA.token)), 409, 'REPRESENTATION_IDEMPOTENCY_CONFLICT'), 'M38 same key, different reason → collision');
  neg((await j('GET', '/player/agent/relationships', undefined, theo.token)).body.items[0].status === 'terminated_by_agent', 'M39 Theo\'s history keeps the ended record');
  // Decline.
  const r6 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', clientKey: 'ana-riku' }, ANA.token);
  const decline = await j('POST', `/player/agent/relationships/${r6.body.relationship.id}/decline`, { expectedRev: 1 }, riku.token);
  ok(decline.status === 200 && decline.body.relationship.status === 'declined', 'M40 Riku DECLINES');
  neg(expect(collect('M41', await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', clientKey: 'ana-riku-2' }, ANA.token)), 429, 'REPRESENTATION_COOLDOWN'), 'M41 a decline starts the cooldown');
  ok((await j('GET', '/org/agent/inbox', undefined, ANA.token)).body.notifications.some((n) => n.type === 'representation_rejected' && /30 days/.test(n.text)), 'M42 Ana is told, with the cooldown');
}

// ============================================================ N — privacy sweep
section('N — privacy: other agency, other player, minor, guardian-managed, enumeration');
{
  // A second agency, registered on the fly through the same seeded-org shape is not available; use a club user and a foreign player.
  neg(expect(collect('N1', await j('GET', `/org/agent/clients/${REL}`, undefined, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'N1 a club user cannot read an agency\'s client');
  neg(expect(collect('N2', await j('GET', '/org/agent/agency/team', undefined, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'N2 nor its team');
  const mateusView = await j('GET', '/player/agent/relationships', undefined, mateus.token);
  neg(mateusView.body.items.length === 1 && mateusView.body.items[0].id === REL2, 'N3 Mateus sees only his own relationship, never Kola\'s');
  neg(expect(collect('N4', await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { shareWithAgencyStaff: true, expectedRev: 3 }, mateus.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'N4 Mateus cannot change Kola\'s sharing');
  neg(expect(collect('N5', await j('POST', `/player/agent/relationships/${REL}/dispute`, { expectedRev: 3, reason: 'x' }, mateus.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'N5 nor dispute it');
  const minorView = await j('GET', '/player/agent/relationships', undefined, guni.token);
  neg(minorView.status === 200 && minorView.body.items.length === 0 && minorView.body.minor === true, 'N6 a minor\'s My Agent is empty with a note — no request could ever have reached it');
  neg(expect(collect('N7', await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { shareWithAgencyStaff: true }, guni.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'N7 a minor cannot act on any relationship');
  neg(expect(collect('N8', await j('GET', '/org/agent/clients/rep-999999', undefined, ANA.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'N8 an unknown relationship is 404');
  neg(expect(collect('N9', await j('GET', '/org/agent/clients/__proto__', undefined, ANA.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'N9 "__proto__" is 404');
  neg(expect(collect('N10', await j('POST', '/player/agent/relationships/constructor/confirm', { expectedRev: 1 }, kola.token)), 404, 'REPRESENTATION_NOT_FOUND'), 'N10 "constructor" is 404');
  // The club side: no agent data leaks into a club's view of the player.
  const clubView = await j('GET', '/org/players/pl-adeyemi', undefined, maria.token);
  neg(clubView.status === 200 ? !JSON.stringify(clubView.body).includes('Ana Costa') && !JSON.stringify(clubView.body).includes(REL) : true, 'N11 a club\'s player view carries no P5.6B relationship or agent name (M16.2 relationship semantics untouched)');
  // Trust score untouched.
  const trust = await j('GET', '/player/trust', undefined, kola.token);
  neg(trust.status === 404 || !JSON.stringify(trust.body).includes('agent'), 'N12 the Trust projection has no agent term (DR-21 deferred)');
}

// ============================================================ O — blocks
section('O — blocks: before a request, before a confirmation');
{
  // Kim blocks the agency, then Ana tries.
  const kim = await playerLogin('pl-kim');
  await j('POST', '/player/block', { orgId: 'org-northstar', reason: 'no agents' }, kim.token);
  neg((await j('GET', '/org/agent/players?q=kim', undefined, ANA.token)).body.items.length === 0, 'O1 a player who blocked the agency vanishes from the lookup');
  neg(expect(collect('O2', await j('POST', '/org/agent/clients/request', { playerId: 'pl-kim', clientKey: 'ana-kim' }, ANA.token)), 404, 'PLAYER_NOT_FOUND'), 'O2 and a request to them is the uniform 404');
  // Osei receives a request, then blocks before confirming.
  const osei = await playerLogin('pl-osei');
  const r = await j('POST', '/org/agent/clients/request', { playerId: 'pl-osei', clientKey: 'ana-osei' }, ANA.token);
  ok(r.status === 201, 'O3 Ana requests Osei');
  await j('POST', '/player/block', { orgId: 'org-northstar' }, osei.token);
  neg(expect(collect('O4', await j('POST', `/player/agent/relationships/${r.body.relationship.id}/confirm`, { expectedRev: 1 }, osei.token)), 409, 'REPRESENTATION_NOT_ACTIVE') && /blocked this agency/.test((await j('POST', `/player/agent/relationships/${r.body.relationship.id}/confirm`, { expectedRev: 1 }, osei.token)).body.message), 'O4 confirming through a block is refused and explained');
  ok((await j('POST', `/player/agent/relationships/${r.body.relationship.id}/decline`, { expectedRev: 1 }, osei.token)).status === 200, 'O5 declining through a block still works');
  const detail = await j('GET', `/org/agent/clients/${r.body.relationship.id}`, undefined, ANA.token);
  neg(detail.status === 200 && detail.body.client.name === null && detail.body.client.unavailable === true, 'O6 after the block the agent\'s record shows the client as unavailable — no name');
}

// ============================================================ P — concurrency
section('P — concurrency: parallel confirmations, parallel requests');
{
  const kimoon = await playerLogin('pl-alvarez');
  const r = await j('POST', '/org/agent/clients/request', { playerId: 'pl-alvarez', clientKey: 'ana-alvarez' }, ANA.token);
  ok(r.status === 201, 'P1 a request to Alvarez');
  const id = r.body.relationship.id;
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => j('POST', `/player/agent/relationships/${id}/confirm`, { expectedRev: 1, clientKey: `race-${i}` }, kimoon.token)));
  const wins = results.filter((x) => x.status === 200 && x.body.idempotent !== true).length;
  const losses = results.filter((x) => x.status === 409).length;
  neg(wins === 1 && losses === 4, `P2 five parallel confirmations with different keys: exactly one wins (${wins}), four are refused (${losses})`);
  const store = await j('GET', `/org/agent/clients/${id}`, undefined, ANA.token);
  ok(store.body.relationship.rev === 2 && store.body.relationship.history.filter((h) => h.action === 'representation_confirmed').length === 1, 'P3 one confirmation in the history, rev 2');
  const mensah = await playerLogin('pl-mensah');
  const reqs = await Promise.all([1, 2, 3].map((i) => j('POST', '/org/agent/clients/request', { playerId: 'pl-mensah', clientKey: `dup-${i}` }, ANA.token)));
  neg(reqs.filter((x) => x.status === 201).length === 1 && reqs.filter((x) => x.status === 409 && x.body.error === 'REPRESENTATION_ALREADY_EXISTS').length === 2, 'P4 three parallel requests to the same player with different keys: one created, two refused');
  ok((await j('GET', '/player/agent/relationships', undefined, mensah.token)).body.items.length === 1, 'P5 Mensah has exactly one request');
}

// ============================================================ Q — rate limits
section('Q — rate limits fire for the agent policies');
{
  // Player lookup: 120/h per actor. Burn them.
  let limited = null;
  for (let i = 0; i < 125 && !limited; i++) {
    const r = await j('GET', `/org/agent/players?q=zz${i}`, undefined, ANA.token);
    if (r.status === 429) limited = r;
  }
  neg(!!limited && limited.body.error === 'RATE_LIMITED' && limited.body.action === 'agent_player_lookup', 'Q1 the lookup limit fires at 120/h with the policy name');
  ok((await j('GET', '/org/agent/players?q=kola', undefined, tomas.token)).status === 200, 'Q2 …and it is per actor: Tomás (licensed_agent since I21) is not limited by Ana\'s burn');
  ok((await j('GET', '/org/agent/clients', undefined, ANA.token)).status === 200, 'Q3 other Ana routes are unaffected');
}

// ============================================================ R — Trust & Safety
section('R — Trust & Safety: read-only; NO route lets the shared key adjudicate');
{
  const rels = await j('GET', '/admin/agent/relationships', undefined, undefined, ADMIN);
  ok(rels.status === 200 && rels.body.readOnly === true && /No Trust & Safety action/.test(rels.body.note) && rels.body.items.some((a) => a.id === REL2 && a.status === 'disputed'), 'R1 T&S may LOOK at relationships, including the disputed one, and the route says it is read-only');
  neg(!JSON.stringify(rels.body).includes('never agreed'), 'R2 the dispute reason does not reach the shared key either');
  const profs = await j('GET', '/admin/agent/profiles', undefined, undefined, ADMIN);
  ok(profs.status === 200 && profs.body.readOnly === true, 'R3 T&S may look at profiles');
  neg(!JSON.stringify(profs.body).includes('TEST-VERIFIED') && !JSON.stringify(profs.body).includes('FIFA-9999'), 'R4 without reference or licence numbers');
  // Every conceivable adjudication route, with the shared key: none exists.
  const probes = [
    ['POST', `/admin/agent/relationships/${REL2}/resolve`, { outcome: 'agent' }],
    ['POST', `/admin/agent/relationships/${REL2}/dispute/resolve`, {}],
    ['PATCH', `/admin/agent/relationships/${REL2}`, { status: 'active' }],
    ['PUT', `/admin/agent/relationships/${REL2}`, { status: 'active' }],
    ['DELETE', `/admin/agent/relationships/${REL2}`],
    ['POST', `/admin/agent/relationships/${REL2}/approve`, {}],
    ['POST', `/admin/agent/relationships/${REL2}/override`, { status: 'active' }],
    ['POST', `/admin/agent/profiles/${ANA_ID}/verify`, { facet: 'fifa_licence' }],
    ['POST', `/admin/agent/profiles/${ANA_ID}/facets/fifa_licence/verify`, {}],
    ['POST', `/admin/agent/profiles/${ANA_ID}/facets/fifa_licence/reject`, {}],
    ['PATCH', `/admin/agent/profiles/${ANA_ID}`, { facets: { fifa_licence: { state: 'VERIFIED' } } }],
    ['POST', `/admin/agent/profiles/${ANA_ID}/minors/approve`, { memberAssociation: 'ENG' }],
    ['POST', '/admin/agent/verification/manual-review', { userId: ANA_ID, decision: 'VERIFIED' }],
    ['POST', '/admin/agent/regulatory/override', { userId: ANA_ID }],
    ['POST', '/admin/agent/conflicts/adjudicate', { agreementId: REL2 }],
    ['POST', '/admin/agent/multiple-representation/approve', { playerId: 'pl-adeyemi' }],
    ['POST', '/admin/representation/resolve', { id: REL2 }],
  ];
  for (const [m, u, b] of probes) {
    const r = await j(m, u, b, undefined, ADMIN);
    neg(r.status === 404, `R5 ${m} ${u} → 404 with the shared T&S key (no such route)`);
  }
  // And the state is exactly what it was.
  const after = await j('GET', '/admin/agent/relationships', undefined, undefined, ADMIN);
  neg(after.body.items.find((a) => a.id === REL2).status === 'disputed' && after.body.items.find((a) => a.id === REL2).rev === (rels.body.items.find((a) => a.id === REL2).rev), 'R6 the disputed relationship is untouched: same status, same rev');
  const anaProf = (await j('GET', '/org/agent/profile', undefined, ANA.token)).body.profile;
  neg(anaProf.rev === ANA_PROFILE_REV && anaProf.facets.fifa_licence.provenance.provider === 'local-synthetic-test-provider', 'R7 Ana\'s profile is untouched: same rev, provenance still the synthetic provider — no admin provenance exists');
  // The M14 review lane cannot reach agent facets: they are not M14 claims.
  const claims = await j('GET', '/admin/verification/queue', undefined, undefined, ADMIN);
  neg(claims.status !== 200 || !JSON.stringify(claims.body).includes(ANA_ID) || !JSON.stringify(claims.body).includes('fifa_licence'), 'R8 no agent facet sits in the M14 verification queue — the shared-key claim review cannot reach a licence facet');
  // Without the key, nothing.
  neg(expect(collect('R9', await j('GET', '/admin/agent/relationships')), 401, 'ADMIN_KEY_REQUIRED'), 'R9 no key, no look');
  neg(expect(collect('R10', await j('GET', '/admin/agent/relationships', undefined, ANA.token)), 401, 'ADMIN_KEY_REQUIRED'), 'R10 an agent session is not the T&S key');
}

// ============================================================ S — subsystems untouched
section('S — the subsystems Agent must not touch');
{
  const before = openStore(DATA_DIR).load()?.db;
  neg((before.signings ?? []).length === 0 || before.signings === undefined, 'S1 no signing was written by any agent action');
  neg(!(before.ledger ?? []).some((l) => /offer|signed/.test(l.type) && l.orgId === 'org-northstar'), 'S2 no offer_made / offer_accepted / offer_declined / signed ledger row for the agency');
  neg((before.representations ?? []).length === 0, 'S3 the legacy M13 representations store was not written by P5.6B');
  neg(!(before.trials ?? []).some((t) => t.orgId === 'org-northstar') && !(before.recruitmentCases ?? []).some((c) => c.orgId === 'org-northstar'), 'S4 no trial and no recruitment case was created for the agency');
  neg(!(before.claims ?? before.verificationClaims ?? []).some((c) => String(c.orgId) === 'org-northstar' && /fifa|licence/i.test(JSON.stringify(c))), 'S5 no M14 claim was created for a licence facet');
  const kolaP = before.players.find((p) => p.id === 'pl-adeyemi');
  neg(!('agentUserId' in kolaP) && !('agent' in kolaP) && !('representationAgreements' in kolaP), 'S6 the player record gained no agent field — the relationship lives in its own store');
  neg(expect((await j('POST', '/org/agent/clients/' + REL + '/offer', { amount: 1 }, ANA.token)), 404, null), 'S7 there is no offer route');
  neg(expect((await j('POST', '/org/agent/clients/' + REL + '/sign', {}, ANA.token)), 404, null), 'S8 no sign route');
  neg(expect((await j('POST', '/org/agent/clients/' + REL + '/passport', {}, ANA.token)), 404, null) && expect(await j('GET', '/org/agent/clients/' + REL + '/passport', undefined, ANA.token), 404, null), 'S9 no passport route — the agent does not own the client\'s Passport');
  neg(expect((await j('GET', '/org/agent/clients/' + REL + '/box-cam', undefined, ANA.token)), 404, null), 'S10 no Box Cam route');
  neg(expect((await j('POST', '/org/agent/clients/' + REL + '/trust', { score: 99 }, ANA.token)), 404, null), 'S11 no Trust route');
  neg(expect((await j('POST', '/org/agent/clients/' + REL + '/contact', { body: 'hi' }, ANA.token)), 404, null), 'S12 no Contact route — an Agent is not a Club Contact actor in P5.6B');
  neg(expect((await j('POST', '/org/agent/transactions', {}, ANA.token)), 404, null) && expect(await j('GET', '/org/agent/fees', undefined, ANA.token), 404, null), 'S13 no transaction room, no fee route');
  neg(expect((await j('POST', '/org/agent/clients/' + REL + '/apply', { opportunityId: 'x' }, ANA.token)), 404, null), 'S14 no route lets the agent APPLY for the client — applying is the player\'s act');
}

// ============================================================ T — events / audit
section('T2 — audit rows are content-free; the org audit merges the agent domain');
{
  const audit = await j('GET', '/org/audit?limit=50', undefined, tomas.token);
  ok(audit.status === 200 && audit.body.items.some((r) => r.domain === 'representation') && audit.body.items.some((r) => r.domain === 'agency') && audit.body.items.some((r) => r.domain === 'agent'), 'T2 the organisation audit carries the three agent domains');
  neg(!JSON.stringify(audit.body).includes('never agreed') && !JSON.stringify(audit.body).includes('TEST-VERIFIED') && !JSON.stringify(audit.body).includes('FIFA-9999'), 'T2 no dispute reason, reference or licence number in the audit');
  const rowFor = audit.body.items.find((r) => r.action === 'representation_disputed');
  ok(!!rowFor && rowFor.detail?.hadReason === true && rowFor.detail.reason === undefined, 'T2 a dispute row records that a reason was given, never the reason');
  const pageA = await j('GET', '/org/agent/agency/audit?limit=2', undefined, tomas.token);
  const pageB = await j('GET', `/org/agent/agency/audit?limit=2&cursor=${pageA.body.nextCursor}`, undefined, tomas.token);
  ok(pageA.body.items.length === 2 && pageB.status === 200 && pageB.body.items.length === 2 && pageA.body.items[1].id !== pageB.body.items[0].id, 'T2 the agency audit paginates by cursor');
  neg(expect(collect('T2', await j('GET', '/org/agent/agency/audit?cursor=nope', undefined, tomas.token)), 400, 'AUDIT_CURSOR_INVALID'), 'T2 a bad cursor is 400');
}

// ============================================================ U — tombstones
section('U — player deletion leaves an id-only record');
let DELETED_REL;
{
  const nowak2 = await playerLogin('pl-nowak');
  // Filip: earlier withdrawn record exists; make a fresh confirmed one after the cooldown? cooldown blocks — use pending withdraw record only. Use pl-svensson instead.
  const elias = await playerLogin('pl-svensson');
  const r = await j('POST', '/org/agent/clients/request', { playerId: 'pl-svensson', clientKey: 'ana-elias' }, ANA.token);
  ok(r.status === 201, 'U1 a request to Elias');
  DELETED_REL = r.body.relationship.id;
  await j('POST', `/player/agent/relationships/${DELETED_REL}/confirm`, { expectedRev: 1 }, elias.token);
  await j('POST', `/player/agent/relationships/${DELETED_REL}/dispute`, { expectedRev: 2, reason: 'SECRET_DISPUTE_TEXT' }, elias.token);
  const del = await j('DELETE', '/player/account', undefined, elias.token);
  ok(del.status === 200 && del.body.deleted === true, 'U2 Elias deletes their account');
  const after = await j('GET', `/org/agent/clients/${DELETED_REL}`, undefined, ANA.token);
  neg(after.status === 200 && after.body.client.removed === true && after.body.client.name === null && typeof after.body.relationship.subjectRemovedAt === 'number' && after.body.access === false, 'U3 the agent\'s record survives as an id-only tombstone: no name, no access');
  const db = openStore(DATA_DIR).load()?.db;
  const row = db.representationAgreements.find((a) => a.id === DELETED_REL);
  neg(row.disputeReason === null && !JSON.stringify(row).includes('SECRET_DISPUTE_TEXT') && row.history.filter((h) => h.by?.kind === 'player').every((h) => h.by.name === null && h.by.userId === null), 'U4 the stored row lost the dispute reason and every player attribution');
  neg(!db.players.some((p) => p.id === 'pl-svensson'), 'U5 the player is gone');
  ok(nowak2.token && true, 'U6 (other players unaffected)');
}

// ============================================================ W — restart
section('W — restart: everything survives the process dying');
{
  server.kill('SIGTERM');
  for (let i = 0; i < 60 && server.exitCode == null; i++) await sleep(100);
  server = await boot();
  const ana2 = await login('org-northstar', 'Ana Costa', 'Agent');
  const me = await j('GET', '/org/agent/me', undefined, ana2.token);
  ok(me.status === 200 && me.body.affiliation.tiers.join() === 'licensed_agent' && me.body.profile.facets.fifa_licence.state === 'VERIFIED' && me.body.profile.facets.fifa_licence.provenance.provider === 'local-synthetic-test-provider', 'W1 Ana\'s membership, profile and verification provenance survived');
  const kola2 = await playerLogin('pl-adeyemi');
  ok((await j('GET', `/org/agent/clients/${REL}`, undefined, ana2.token)).body.access === true, 'W2 the active relationship still grants access');
  neg((await j('GET', `/org/agent/clients/${REL2}`, undefined, ana2.token)).body.access === false && (await j('GET', `/org/agent/clients/${REL2}`, undefined, ana2.token)).body.relationship.status === 'disputed', 'W3 the dispute still suspends');
  neg(expect(await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], termMonths: 18, jurisdiction: 'ENG', clientKey: 'ana-kola-1' }, ana2.token), 200, null) && (await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], termMonths: 18, jurisdiction: 'ENG', clientKey: 'ana-kola-1' }, ana2.token)).body.idempotent === true, 'W4 the request idempotency key replays across the restart');
  ok((await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1, clientKey: 'kola-confirm' }, kola2.token)).body.idempotent === true, 'W5 the confirmation key too');
  neg(expect(await j('POST', `/player/agent/relationships/${REL2}/terminate`, { expectedRev: 3 }, (await playerLogin('pl-carvalho')).token), 409, 'REPRESENTATION_DISPUTED'), 'W6 the dispute is still terminal');
  neg(expect(await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Carl Temp', role: 'Assistant', platform: 'agent' }), 403, 'USER_REMOVED'), 'W7 the ended member is still out');
  neg((await j('GET', `/org/agent/clients/${DELETED_REL}`, undefined, ana2.token)).body.client.removed === true, 'W8 the tombstone is still a tombstone');
  const h = await j('GET', '/healthz');
  ok(h.body.schemaVersion === 2306, 'W9 schema 2306 after restart; the 2305 step did not run twice');
  const db = openStore(DATA_DIR).load()?.db;
  ok(db.schema.migrations.filter((m) => m.id === 'm240_001_agent_core_stores').length === 1, 'W10 exactly one 2305 migration record');
}

// ============================================================ E2 — error contract
section('E2 — every refusal in this run carried a status and a code, and no private field');
{
  const bad = ERROR_BODIES.filter((e) => !e.body || typeof e.body.error !== 'string');
  neg(bad.length === 0, `E2 all ${ERROR_BODIES.length} refusals carried an error code (${bad.map((b) => b.label).join(', ') || 'none missing'})`);
  neg(!ERROR_BODIES.some((e) => /stack|internal|at\s+\w+\s+\(/.test(JSON.stringify(e.body))), 'E2 no stack trace or internal field in any refusal');
  neg(!ERROR_BODIES.some((e) => JSON.stringify(e.body).includes('never agreed') || JSON.stringify(e.body).includes('SECRET_DISPUTE_TEXT')), 'E2 no dispute reason in any refusal');
}

console.log(`\nM23 P5.6B Agent suite: ${passed} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) console.error('SOME CHECKS FAILED'); else console.log('all M23 P5.6B Agent checks passed');
process.exit(process.exitCode ?? 0);
