/**
 * ScoutBox Agent Conflict & Compliance Engine: routes.
 *
 * The governing principle: ScoutBox is infrastructure. The
 * licensed agent performs the regulated service; this module decides only
 * whether ScoutBox may PERMIT a workflow action under encoded, versioned
 * platform policy. It never negotiates, never advises, never infers a missing
 * permission, and never turns uncertainty into permission.
 *
 * Four routers:
 *   /auth/reviewer/login       credentialed Trust & Safety reviewer login
 *   /ts/*                      attributed reviewer routes — the ONLY authoritative compliance mutations
 *   /org/agent/compliance/*    the agent's own compliance workspace (agency session + membership)
 *   /org/compliance/*          a CLUB party's consent lane (club session + verification signatory authority)
 *   /player/agent/consents/*   the PLAYER party's consent lane
 *   /admin/compliance/*        the legacy shared key: READ-ONLY, non-authoritative
 *
 * Every regulated mutation re-derives, at mutation time, in this order
 * (the step numbers in the routes count along this list): authenticate → actor → agent profile → affiliation → conceal
 * foreign resource → role → client relationship → scope/status → blocks →
 * applicable policy set → licence/registration/authorisation → conflict →
 * consents → minor gate → manual review → rev/idempotency → mutate →
 * audit/event. Nothing in a request body is trusted for any of those facts.
 */

import { visibleToOrg } from '../../../domain.mjs';
import { parseStrictDateOnly } from '../../../temporal.mjs';
import { guardRev, bumpRev, revMeta } from '../../platform/concurrency.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { normaliseClientKey, payloadFingerprint } from '../../recruitment/lifecycle/contact.mjs';
import { hasVerLevel } from '../../verification/claims/shared.mjs';
import { effectiveFacetState, RECHECK_MS, effectiveAgreementStatus, agreementGrantsAccess, affiliationActive, tiersOf, can, JURISDICTIONS } from '../core/shared.mjs';
import { sendComplianceError } from './errors.mjs';
import { RULE_STATUSES, CONSENT_KINDS } from './policyVersions.mjs';

export { CONSENT_KINDS };
import { applicablePolicySet, evaluatePolicy, evaluateMinorGate, representationScopeProblem, resolveScope, ruleAt, MINOR_PATHWAY_PRODUCTION_ENABLED, POLICY_FACETS, POLICY_ACTIONS } from './policy.mjs';
import { evaluateConflict, conflictSummaryForParty, PARTY_ROLES, CONTEXT_TYPES, PERMITTED_WITH_CONSENT } from './conflict.mjs';
import { createVerificationProvider, facetFromProviderAnswer, FACET_METHOD } from './provider.mjs';
import { complianceAuditRows, reviewerDecisionRows } from './audit.mjs';
import { REVIEWER_ROLES } from '../../../repositories/compliancePolicies.mjs';
import { REVIEW_KINDS, REVIEW_STATUSES } from '../../../repositories/complianceRecords.mjs';
import { readPage, pageOf, sendPageError } from '../../platform/paging.mjs';

export { REVIEWER_ROLES, REVIEW_KINDS, REVIEW_STATUSES };

export const CONSENT_STATUSES = Object.freeze(['requested', 'granted', 'declined', 'revoked']);
/** Reason codes only a policy version can settle: a reviewer may not "approve" past them. */
export const POLICY_LEVEL_REASONS = Object.freeze(['RULE_STATUS_UNCERTAIN', 'POLICY_NOT_ENCODED', 'NO_ACTIVE_RULE_DECIDES', 'SCOPE_MIXED', 'EXCLUSIVITY_WINDOW_DOUBTFUL']);

const REVIEWER_LEGACY_NOTE = 'Records made before P5.6C through the shared admin key carry attribution "shared_admin_key" and are preserved as legacy/unattributed. They were never rewritten and are not authoritative compliance decisions.';

export function registerCompliance(rawCtx) {
  const {
    byId, app, orgRouter, playerRouter, adminRouter, tsRouter, nextId, notify, broadcast,
    findPlayer, isBlocked, isAdult, orgCanSee, moderateOrRefuse, rateLimit,
    hashPassword, verifyPassword, createSession, sessionFor, sessions, devLogins, access, verificationProvider, agentCore, unit,
    compliancePolicies, complianceRecords,
  } = rawCtx;

  const provider = verificationProvider ?? createVerificationProvider({ synthetic: process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1' });
  if (typeof compliancePolicies?.reviewers?.update !== 'function') throw new TypeError('registerCompliance needs the compliance policies repository from the data layer');
  if (typeof complianceRecords?.contexts?.recordAct !== 'function') throw new TypeError('registerCompliance needs the compliance records repository from the data layer');
  const now = () => Date.now();
  /** A history entry, for an act's bookkeeping or a whole record's history. */
  const entry = (action, by, detail = null) => ({ id: nextId('aud'), at: now(), action, by, detail });
  const hist = (record, action, by, detail = null) => {
    record.history ??= [];
    record.history.push(entry(action, by, detail));
  };
  /** An act's rev bump, attributed to `by` (an org user, a reviewer, or a party `{ id, name }`). */
  const bumped = (by) => ({ bump: { at: now(), by } });
  const byOrg = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const byPlayer = (req) => ({ kind: 'player', userId: req.player.id, name: req.player.name });
  const byClubUser = (req) => ({ kind: 'club_user', userId: req.orgUser.id, name: req.orgUser.name, orgId: req.org.id });
  const byReviewer = (req) => ({ kind: 'ts_reviewer', userId: req.reviewer.id, name: req.reviewer.name, role: req.reviewer.role });
  const bySystem = (name) => ({ kind: 'system', userId: null, name });
  const limitedOr429 = (res, action, key) => { if (rateLimit.limited(action, key)) { res.status(429).json(rateLimitedBody(action)); return true; } return false; };
  const clientKeyOr400 = (req, res) => {
    const k = normaliseClientKey(req.body?.clientKey);
    if (!k.ok) { sendComplianceError(res, { error: 'COMPLIANCE_CLIENT_KEY_INVALID', message: k.message }, 'clientKey'); return undefined; }
    return k.key;
  };
  // This module writes a facet or an agreement only through the agent core's explicit operations, inside the route's
  // unit of work.
  if (typeof agentCore?.profiles?.recordAct !== 'function' || typeof unit !== 'function') throw new TypeError('registerCompliance needs the agent core repository and unit from the data layer');
  const agentReads = agentCore.reads;
  const profileOf = (userId) => agentReads.profiles.forUser(userId);
  const activeAffiliationOf = (userId, orgId) => agentReads.affiliations.activeFor(userId, orgId, now());
  const agencyJurisdictions = (orgId) => agentReads.settings.forOrg(orgId).jurisdictions;

  // ============================================================ reviewer identity
  const { reviewers, policies } = compliancePolicies;
  const reviewerById = (id) => reviewers.byId(id);
  const publicReviewer = (r) => ({ id: r.id, name: r.name, role: r.role, status: r.status, createdAt: r.createdAt, revokedAt: r.revokedAt ?? null, ...revMeta(r) });

  /** A new, active reviewer (the secret stored only as its hash). The caller checked the id is free. */
  function createReviewer({ id, name, role, secret, createdBy }) {
    const r = { id, name, role, status: 'active', secretHash: hashPassword(secret), createdAt: now(), createdBy, revokedAt: null, revokedBy: null, rev: 1, revAt: now(), revBy: null, history: [] };
    hist(r, 'reviewer_created', createdBy, { role });
    return reviewers.create(r);
  }
  // Bootstrap: an operator-provided root reviewer (production) — never the shared key.
  if (process.env.TS_REVIEWER_BOOTSTRAP_ID && process.env.TS_REVIEWER_BOOTSTRAP_SECRET) {
    const id = String(process.env.TS_REVIEWER_BOOTSTRAP_ID).slice(0, 40);
    if (!reviewerById(id)) createReviewer({ id, name: String(process.env.TS_REVIEWER_BOOTSTRAP_NAME ?? process.env.TS_REVIEWER_BOOTSTRAP_ID).slice(0, 80), role: 'trust_safety_admin', secret: process.env.TS_REVIEWER_BOOTSTRAP_SECRET, createdBy: bySystem('bootstrap env') });
  }
  // Development and tests only: seeded reviewers with known secrets. Never when dev logins are off.
  if (devLogins && !reviewers.count()) {
    unit(() => {
      createReviewer({ id: 'tsr-dev-admin', name: 'Priya Shah', role: 'trust_safety_admin', secret: 'dev-reviewer-admin', createdBy: bySystem('dev seed') });
      createReviewer({ id: 'tsr-dev-reviewer', name: 'Marcus Bell', role: 'trust_safety_reviewer', secret: 'dev-reviewer', createdBy: bySystem('dev seed') });
      createReviewer({ id: 'tsr-dev-admin2', name: 'Léa Fontaine', role: 'trust_safety_admin', secret: 'dev-reviewer-admin2', createdBy: bySystem('dev seed') });
    });
  }

  /** Credentialed login. Uniform refusal for an unknown id, a wrong secret and a revoked reviewer. */
  app.post('/auth/reviewer/login', (req, res) => {
    const id = String(req.body?.reviewerId ?? '').trim();
    const secret = String(req.body?.secret ?? '');
    // The compliance lane is the one where a guessed credential buys the
    // most, so the per-identifier failed-login budget is checked here BEFORE the
    // secret is verified. An unknown id, a wrong secret and a revoked reviewer
    // already share one refusal; the lockout shares it too, so the 429 tells an
    // attacker nothing the uniform refusal did not already withhold.
    const bucket = `reviewer:${id.toLowerCase()}`;
    if (rateLimit.peek('login_failure', bucket).limited) {
      return res.status(429).json(rateLimitedBody('login_failure'));
    }
    const r = reviewers.activeById(id);
    const good = !!r && !!verifyPassword(secret, r.secretHash);
    if (!good) {
      rateLimit.limited('login_failure', bucket);
      return sendComplianceError(res, { error: 'REVIEWER_CREDENTIALS_INVALID', message: 'Reviewer id and secret do not match an active reviewer.' }, 'login');
    }
    const token = createSession('ts_reviewer', r.id);
    res.json({ token, reviewer: publicReviewer(r) });
  });

  /** The server derives the reviewer from the session — never from a body field or a header. */
  function reviewerAuth(req, res, next) {
    const session = sessionFor(req);
    if (session?.kind !== 'ts_reviewer') return sendComplianceError(res, { error: 'REVIEWER_AUTH_REQUIRED', message: 'An authenticated Trust & Safety reviewer session is required. The shared admin key is not a reviewer.' }, 'reviewerAuth');
    const r = reviewers.activeById(session.refId);
    if (!r) {
      sessions.revokeSid(session.sid);
      return sendComplianceError(res, { error: 'REVIEWER_REVOKED', message: 'This reviewer\'s access has been revoked.' }, 'reviewerAuth');
    }
    req.reviewer = r;
    next();
  }
  const requireReviewerRole = (req, res, role) => {
    if (req.reviewer.role === role || (role === 'trust_safety_reviewer' && REVIEWER_ROLES.includes(req.reviewer.role))) return true;
    sendComplianceError(res, { error: 'REVIEWER_ROLE_REQUIRED', role, message: `This action needs the ${role} role.` }, 'role');
    return false;
  };
  const revokeReviewerSessions = (id) => { sessions.revokeFor('ts_reviewer', id); };

  tsRouter.get('/me', (req, res) => res.json({ reviewer: publicReviewer(req.reviewer), attribution: 'authenticated_reviewer', note: 'Every authoritative compliance action is recorded against this identity.' }));
  tsRouter.get('/reviewers', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    res.json({ items: reviewers.all().map(publicReviewer), legacyNote: REVIEWER_LEGACY_NOTE });
  });
  tsRouter.post('/reviewers', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const b = req.body ?? {};
    for (const k of ['id', 'name', 'secret']) if (typeof b[k] !== 'string') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: k, message: `${k} must be text.` }, 'reviewers');
    if (b.role !== undefined && typeof b.role !== 'string') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'role', allowed: REVIEWER_ROLES }, 'reviewers');
    const id = b.id.trim();
    const name = b.name.trim().slice(0, 80);
    const role = b.role ?? 'trust_safety_reviewer';
    const secret = b.secret;
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/i.test(id) || !name) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'id', message: 'id (3–40 chars, letters, digits, dashes) and name are required.' }, 'reviewers');
    if (!REVIEWER_ROLES.includes(role)) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'role', allowed: REVIEWER_ROLES }, 'reviewers');
    if (secret.length < 12) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'secret', message: 'A reviewer secret needs at least 12 characters.' }, 'reviewers');
    if (b.secret.length > 200) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'secret', message: 'A reviewer secret has at most 200 characters.' }, 'reviewers');
    if (reviewerById(id)) return sendComplianceError(res, { error: 'REVIEWER_EXISTS' }, 'reviewers');
    const r = createReviewer({ id, name, role, secret, createdBy: byReviewer(req) });
    res.status(201).json({ reviewer: publicReviewer(r) });
  });
  tsRouter.post('/reviewers/:id/revoke', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const r = reviewerById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEWER_NOT_FOUND' }, 'reviewers');
    if (r.status === 'revoked') return res.json({ reviewer: publicReviewer(r), idempotent: true });
    if (req.body?.reason !== undefined && req.body.reason !== null && typeof req.body.reason !== 'string') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'reason', message: 'reason must be text.' }, 'reviewers');
    if (r.role === 'trust_safety_admin' && reviewers.activeCount('trust_safety_admin') <= 1) return sendComplianceError(res, { error: 'LAST_REVIEWER_ADMIN', message: 'At least one Trust & Safety administrator must remain.' }, 'reviewers');
    if (!guardRev(req, res, r, { errorCode: 'REVIEWER_VERSION_CONFLICT', current: {} })) return;
    const out = unit(() => {
      const next = reviewers.update(r.id, (d) => {
        d.status = 'revoked'; d.revokedAt = now(); d.revokedBy = { id: req.reviewer.id, name: req.reviewer.name };
        hist(d, 'reviewer_revoked', byReviewer(req), { reason: String(req.body?.reason ?? '').trim().slice(0, 200) || null });
        bumpRev(d, { by: req.reviewer, at: now() });
      });
      revokeReviewerSessions(r.id);
      return next;
    });
    res.json({ reviewer: publicReviewer(out) });
  });

  // ============================================================ policies
  const publishedPolicies = () => policies.published();
  const policySetFor = (mas, at = now()) => applicablePolicySet(publishedPolicies(), mas, at);
  const policyPublic = (p) => ({
    id: p.id, regulator: p.regulator, jurisdiction: p.jurisdiction, policyVersion: p.policyVersion, supersedes: p.supersedes ?? null,
    effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo ?? null, status: p.status,
    publishedAt: p.publishedAt ?? null, proposedBy: p.proposedBy ?? null, approvedBy: p.approvedBy ?? null, publishedBy: p.publishedBy ?? null,
    rules: Object.fromEntries(Object.entries(p.rules ?? {}).map(([id, r]) => [id, { ruleStatus: r.ruleStatus, textStatus: r.textStatus ?? null, note: r.note ?? null, params: r.params ?? {}, sourceRef: r.sourceRef ?? [] }])),
    rev: p.rev ?? 1,
  });
  /**
   * The proposed version a body describes, or `{ field, message }`. The route checks the shape a person types (id,
   * jurisdiction, version, days, at least one rule with a status and a source); the repository types the rest — rule
   * texts, sources, overrides and every parameter against the engine's vocabulary — and its refusal names the field.
   */
  function policyFromBody(b, req) {
    const errs = [];
    if (!/^jp-[a-z]{2,6}-[0-9a-z-]{2,20}$/i.test(String(b.id ?? ''))) errs.push('id');
    if (!JURISDICTIONS.includes(b.jurisdiction)) errs.push('jurisdiction');
    if (!Number.isInteger(b.policyVersion) || b.policyVersion < 1) errs.push('policyVersion');
    // A real calendar day in bounds, not merely the shape of one.
    if (!parseStrictDateOnly(b.effectiveFrom).ok) errs.push('effectiveFrom');
    if (b.effectiveTo != null && !parseStrictDateOnly(b.effectiveTo).ok) errs.push('effectiveTo');
    if (b.effectiveTo != null && parseStrictDateOnly(b.effectiveFrom).ok && parseStrictDateOnly(b.effectiveTo).ok && !(b.effectiveFrom < b.effectiveTo)) errs.push('effectiveTo');
    if (b.regulator !== undefined && b.regulator !== null && typeof b.regulator !== 'string') errs.push('regulator');
    if (b.supersedes !== undefined && b.supersedes !== null && typeof b.supersedes !== 'string') errs.push('supersedes');
    if (!b.rules || typeof b.rules !== 'object' || Array.isArray(b.rules) || !Object.keys(b.rules).length) errs.push('rules');
    else for (const [id, r] of Object.entries(b.rules)) {
      if (!RULE_STATUSES.includes(r?.ruleStatus)) errs.push(`rules.${id}.ruleStatus`);
      if (!Array.isArray(r?.sourceRef) || !r.sourceRef.length || r.sourceRef.some((s) => !s?.source || !s?.retrievedDate)) errs.push(`rules.${id}.sourceRef`);
      if (r && typeof r === 'object' && r.note !== undefined && r.note !== null && typeof r.note !== 'string') errs.push(`rules.${id}.note`);
    }
    if (errs.length) return { field: errs[0], message: `Invalid policy fields: ${errs.join(', ')}.` };
    const at = now();
    const unknown = Object.keys(b).filter((k) => !['id', 'regulator', 'jurisdiction', 'policyVersion', 'supersedes', 'effectiveFrom', 'effectiveTo', 'rules', 'expectedRev', 'clientKey'].includes(k));
    if (unknown.length) return { field: unknown[0], message: `This build stores no policy field ${unknown.join(', ')}.` };
    const row = {
      id: b.id, regulator: String(b.regulator ?? '').slice(0, 20) || 'UNKNOWN', jurisdiction: b.jurisdiction, policyVersion: b.policyVersion, supersedes: b.supersedes ?? null,
      effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo ?? null,
      rules: Object.fromEntries(Object.entries(b.rules).map(([id, r]) => [id, { ...r, note: String(r.note ?? '').slice(0, 1000) || null }])),
      status: 'proposed', proposedBy: { id: req.reviewer.id, name: req.reviewer.name, at }, approvedBy: null, publishedAt: null, publishedBy: null,
      createdAt: at, rev: 1, revAt: at, revBy: null, history: [],
    };
    hist(row, 'policy_version_proposed', byReviewer(req), { policyVersion: row.id });
    return { row };
  }
  /** A repository refusal of a policy body, as the route's 400 (the field named, never its content). */
  const policyRefusal = (res, e) => {
    if (e?.code === 'COMPLIANCE_POLICIES_DUPLICATE' && e.field === 'id') return sendComplianceError(res, { error: 'POLICY_VERSION_EXISTS' }, 'policies');
    if (e?.code === 'COMPLIANCE_POLICIES_INPUT_INVALID') return sendComplianceError(res, { error: 'POLICY_INPUT_INVALID', field: e.field ?? 'policy', message: e.message.replace(/^[A-Z_]+: /, '') }, 'policies');
    throw e;
  };
  tsRouter.get('/compliance/policies', (req, res) => res.json({ items: policies.all().map(policyPublic), ruleStatuses: RULE_STATUSES, dualControl: true }));
  tsRouter.post('/compliance/policies', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    if (limitedOr429(res, 'ts_policy_publish', req.reviewer.id)) return;
    const built = policyFromBody(req.body ?? {}, req);
    if (!built.row) return sendComplianceError(res, { error: 'POLICY_INPUT_INVALID', field: built.field, message: built.message }, 'policies');
    if (policies.exists(built.row.id)) return sendComplianceError(res, { error: 'POLICY_VERSION_EXISTS' }, 'policies');
    let p;
    try { p = policies.create(built.row); } catch (e) { return policyRefusal(res, e); }
    res.status(201).json({ policy: policyPublic(p), note: 'Proposed. A DIFFERENT Trust & Safety administrator must approve before it takes effect (dual control, C7).' });
  });
  tsRouter.post('/compliance/policies/:id/approve', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const p = policies.byId(req.params.id);
    if (!p) return sendComplianceError(res, { error: 'POLICY_NOT_FOUND' }, 'policies');
    if (p.status !== 'proposed') return sendComplianceError(res, { error: 'POLICY_NOT_PROPOSED', status: p.status }, 'policies');
    if (p.proposedBy?.id === req.reviewer.id) return sendComplianceError(res, { error: 'POLICY_DUAL_CONTROL_REQUIRED', message: 'The approving administrator must be a different person from the proposer.' }, 'policies');
    const out = unit(() => {
      const next = policies.update(p.id, (d) => {
        d.status = 'published'; d.approvedBy = { id: req.reviewer.id, name: req.reviewer.name, at: now() }; d.publishedAt = now();
        d.publishedBy = [{ kind: 'ts_reviewer', id: d.proposedBy.id, name: d.proposedBy.name }, { kind: 'ts_reviewer', id: req.reviewer.id, name: req.reviewer.name }];
        hist(d, 'policy_version_published', byReviewer(req), { policyVersion: d.id });
        bumpRev(d, { by: req.reviewer, at: now() });
      });
      // Every open context evaluated under an older version of this jurisdiction is flagged — never silently re-verdicted.
      complianceRecords.contexts.flagPolicyChange(next.jurisdiction, next.id, () => ({ id: nextId('aud'), at: now(), action: 'compliance_context_policy_changed', by: bySystem('policy publication'), detail: { policyVersions: [next.id] } }));
      return next;
    });
    broadcast('policy_version_published', {});
    res.json({ policy: policyPublic(out) });
  });
  orgRouter.get('/agent/compliance/policies', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    const mas = [...new Set(['INT', ...agencyJurisdictions(req.org.id), ...((profileOf(req.orgUser.id)?.declared?.jurisdictions) ?? [])])];
    const set = policySetFor(mas);
    res.json({ inEffect: set.policies.map(policyPublic), missing: set.missing, ruleStatuses: RULE_STATUSES, honest: 'These are ScoutBox\'s encoded platform rules with their operative status as recorded on the retrieval date. They are not legal advice and a status can change without a deploy.' });
  });
  adminRouter.get('/compliance/policies', (_req, res) => res.json({ items: policies.all().map(policyPublic), readOnly: true, note: 'Read-only. Publishing needs two authenticated Trust & Safety administrators (/ts).' }));

  // ============================================================ facets and the provider
  const facetStatesOf = (p, at = now()) => ({
    fifa_licence: effectiveFacetState(p?.facets?.fifa_licence, at),
    national_registration: Object.fromEntries(Object.entries(p?.facets?.national_registration ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)])),
    domestic_authorisation: Object.fromEntries(Object.entries(p?.facets?.domestic_authorisation ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)])),
    minors_authorisation: Object.fromEntries(Object.entries(p?.facets?.minors_authorisation ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)])),
  });
  const facetRecord = (p, facet, ma) => (facet === 'fifa_licence' ? p?.facets?.fifa_licence : p?.facets?.[facet]?.[ma]) ?? null;

  const { contexts, reviews, consents } = complianceRecords;
  const reviewPublic = (r, { forReviewer = false } = {}) => ({
    id: r.id, kind: r.kind, status: r.status, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId ?? null,
    subject: r.subject, reasons: (r.reasons ?? []).map((x) => ({ code: x.code, ruleId: x.ruleId ?? null, ruleStatus: x.ruleStatus ?? null, policyVersion: x.policyVersion ?? null })),
    policyVersions: r.policyVersions ?? [], requestedAt: r.requestedAt, startedAt: r.startedAt ?? null, decidedAt: r.decidedAt ?? null,
    decision: r.decision ? { outcome: r.decision.outcome, reasonCode: r.decision.reasonCode, reviewer: { id: r.decision.reviewerId, name: r.decision.reviewerName, role: r.decision.reviewerRole }, evidenceCount: (r.decision.evidenceRefs ?? []).length, ...(forReviewer ? { reason: r.decision.reason, evidenceRefs: r.decision.evidenceRefs, priorState: r.decision.priorState, resultingState: r.decision.resultingState } : {}), policyVersions: r.decision.policyVersions ?? [], at: r.decision.at } : null,
    startedBy: r.startedBy ? { id: r.startedBy.id, name: r.startedBy.name } : null,
    supersedes: r.supersedes ?? null, supersededBy: r.supersededBy ?? null,
    snapshot: forReviewer ? (r.snapshot ?? null) : (r.snapshot ? { outcome: r.snapshot.outcome ?? null, evaluatedAt: r.snapshot.evaluatedAt ?? null, policyVersions: r.snapshot.policyVersions ?? [] } : null),
    ...revMeta(r),
    honest: 'A ScoutBox reviewer decides whether the ScoutBox workflow may proceed under the encoded rules. This is not a legal determination and no governing body has approved anything.',
  });
  /** Request an attributed review item (one row with its first history entry); the caller holds the unit. */
  /**
   * Request an attributed review item (one row with its first history entry); the caller holds the unit. The snapshot is
   * the outcome at request time and, when there was one, the evaluation row it came from. A reconsideration names the
   * review it `supersedes`.
   */
  function createReview({ kind, agencyOrgId, agentUserId, subject, reasons, policyVersions, snapshot = null, requestedBy, supersedes = null }) {
    const r = {
      id: nextId('rrv'), kind, status: 'PENDING', agencyOrgId, agentUserId: agentUserId ?? null, subject,
      reasons: reasons ?? [], policyVersions: policyVersions ?? [],
      snapshot: snapshot && { outcome: snapshot.outcome, evaluationId: snapshot.evaluationId ?? null, evaluatedAt: snapshot.evaluatedAt ?? null },
      requestedAt: now(), requestedBy, startedAt: null, startedBy: null, decidedAt: null, decision: null,
      supersedes, supersededBy: null, keys: {}, rev: 1, revAt: now(), revBy: null,
      history: [
        entry('regulatory_review_requested', requestedBy, { kind, reasonCodes: [...new Set((reasons ?? []).map((x) => x.code))], policyVersions: policyVersions ?? [] }),
        ...(supersedes ? [entry('regulatory_review_requested', requestedBy, { reasonCode: 'supersedes', reviewId: supersedes })] : []),
      ],
    };
    const out = reviews.create(r);
    broadcast('regulatory_review_requested', { orgId: agencyOrgId, reviewId: out.id, kind });
    if (agentUserId) notify({ kind: 'org_user', id: agentUserId }, 'regulatory_review_required', kind === 'verification_facet' ? 'A verification submission needs attributed Trust & Safety review. Nothing is verified until a named reviewer decides.' : 'A compliance question needs attributed Trust & Safety review. The workflow does not proceed until a named reviewer decides.', out.id);
    return out;
  }

  /** For the agent core: a facet submission that ended MANUAL_REVIEW_REQUIRED becomes a review item. Idempotent per facet. */
  function facetNeedsReview(profile, { facet, memberAssociation }, by) {
    if (reviews.openForFacet(profile.id, facet, memberAssociation ?? null)) return null;
    return createReview({ kind: 'verification_facet', agencyOrgId: profile.agencyOrgId, agentUserId: profile.userId, subject: { profileId: profile.id, userId: profile.userId, facet, memberAssociation: memberAssociation ?? null }, reasons: [{ code: 'NO_PROVIDER', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: policySetFor([memberAssociation].filter(Boolean)).policies.map((p) => p.id), requestedBy: by });
  }
  /** For the agent core: a client's dispute becomes a review item. */
  function representationDisputed(a, by) {
    if (reviews.openForAgreement(a.id)) return null;
    return createReview({ kind: 'representation_dispute', agencyOrgId: a.agencyOrgId, agentUserId: a.agentUserId, subject: { agreementId: a.id }, reasons: [{ code: 'CLIENT_DISPUTE', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: policySetFor([a.jurisdiction].filter(Boolean)).policies.map((p) => p.id), requestedBy: by });
  }
  /** For the agent core's request route: the policy layer's verdict on an Approach (exclusivity window, USA domestic authorisation …). */
  function authorizeApproach({ profile, jurisdiction, player, agentUserId }) {
    const set = policySetFor([jurisdiction]);
    const others = agentReads.agreements.forClient(player.id).filter((a) => a.agentUserId !== agentUserId && a.exclusive && effectiveAgreementStatus(a, now()) === 'active' && a.confirmedAt).map((a) => ({ endAt: a.endAt ?? null }));
    const d = evaluatePolicy({ action: 'approach_adult', memberAssociations: [jurisdiction], facets: facetStatesOf(profile), policySet: set.policies, missingPolicies: set.missing, otherExclusiveAgreements: others, now: now() });
    return { decision: d, policySet: set };
  }

  /** Re-check a facet against the provider: STALE needs a recheck or attributed review. */
  orgRouter.post('/agent/compliance/facets/:facet/recheck', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'verification.submit')) return;
    if (limitedOr429(res, 'agent_profile_write', req.orgUser.id)) return;
    const facet = req.params.facet;
    if (!POLICY_FACETS.includes(facet)) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'facet', allowed: POLICY_FACETS }, 'recheck');
    const p = profileOf(req.orgUser.id);
    if (!p) return sendComplianceError(res, { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' }, 'recheck');
    const ma = facet === 'fifa_licence' ? null : String(req.body?.memberAssociation ?? '').trim().toUpperCase();
    const cur = facetRecord(p, facet, ma);
    if (!cur || !cur.reference) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'facet', message: 'Nothing has been submitted for this facet yet.' }, 'recheck');
    const answer = provider[FACET_METHOD[facet]]({ reference: cur.reference, now: now() });
    if (answer.state === 'UNAVAILABLE') return sendComplianceError(res, { error: 'REGULATORY_PROVIDER_UNAVAILABLE', retryAfter: 300, message: 'The verification source is unavailable. Nothing was changed; a cached VERIFIED facet stays usable only until its own recheck date.' }, 'recheck');
    const next = facetFromProviderAnswer(answer, { reference: cur.reference, memberAssociation: ma, now: now() });
    const prevState = effectiveFacetState(cur, now());
    const nextState = effectiveFacetState(next, now());
    unit(() => {
      // The stored facet keeps no stale marker from before.
      const out = agentCore.profiles.setFacet(p.id, { facet, memberAssociation: ma, record: { ...next, staleNotifiedAt: null } }, {
        at: now(), touch: true, ...bumped(req.orgUser),
        history: [
          entry('agent_facet_rechecked', byOrg(req), { facet, memberAssociation: ma, from: prevState, to: nextState }),
          ...(prevState !== nextState ? [entry('agent_verification_state_changed', byOrg(req), { facet, memberAssociation: ma, from: prevState, to: nextState, state: next.state })] : []),
        ],
      });
      if (next.state === 'MANUAL_REVIEW_REQUIRED') facetNeedsReview(out, { facet, memberAssociation: ma }, byOrg(req));
      if (prevState !== nextState) broadcast('agent_verification_state_changed', { orgId: req.org.id, userId: out.userId, facet, state: nextState });
    });
    res.json({ facet: { ...next, state: effectiveFacetState(next, now()), storedState: next.state }, provider: provider.status() });
  });

  // ============================================================ the agent's compliance overview
  const minorReadinessFor = (p, ma) => {
    const set = policySetFor([ma]);
    const facets = facetStatesOf(p);
    // Readiness is the agent's OWN state under the jurisdiction's encoded rules; no subject exists here.
    const timingRule = ma === 'INT' ? ruleAt(set.policies, 'FIFA-13.1', now()) : (() => { const nat = set.policies.find((x) => x.jurisdiction === ma); const id = nat ? Object.keys(nat.rules).find((k) => nat.rules[k]?.params?.formula) : null; return id ? ruleAt(set.policies, id, now()) : { ruleId: null, status: 'UNKNOWN' }; })();
    const d = evaluatePolicy({ action: 'approach_minor', memberAssociations: [ma], facets, policySet: set.policies, missingPolicies: set.missing, now: now() });
    return {
      memberAssociation: ma, pathwayEnabledInProduction: MINOR_PATHWAY_PRODUCTION_ENABLED[ma] === true,
      timingRule: timingRule.ruleId ? { ruleId: timingRule.ruleId, ruleStatus: timingRule.status, formula: timingRule.rule?.params?.formula ?? null } : null,
      timingEncoded: timingRule.status === 'ACTIVE' && !!timingRule.rule?.params?.formula && timingRule.rule.params.formula !== 'six_months_before_first_contract_age',
      agentReady: d.allowed, gaps: d.facetGaps, reasons: d.reasons.map((r) => ({ code: r.code, ruleId: r.ruleId, ruleStatus: r.ruleStatus })),
      honest: 'General discovery of minors by agencies is prohibited and no minor representation workflow is live in any jurisdiction. This is the agent\'s own readiness under the encoded rules, evaluated against no subject.',
    };
  };
  orgRouter.get('/agent/compliance/overview', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'compliance.read')) return;
    const p = profileOf(req.orgUser.id);
    const facets = p ? facetStatesOf(p) : null;
    const freshness = [];
    if (p) {
      const push = (facet, ma, rec) => { if (!rec) return; const st = effectiveFacetState(rec, now()); freshness.push({ facet, memberAssociation: ma, state: st, storedState: rec.state, recheckAt: rec.recheckAt ?? null, daysUntilRecheck: typeof rec.recheckAt === 'number' ? Math.ceil((rec.recheckAt - now()) / 86_400_000) : null, provenance: rec.provenance ?? null, verifiedAt: rec.verifiedAt ?? null }); };
      push('fifa_licence', null, p.facets?.fifa_licence);
      for (const f of ['national_registration', 'domestic_authorisation', 'minors_authorisation']) for (const [ma, rec] of Object.entries(p.facets?.[f] ?? {})) push(f, ma, rec);
      // A STALE facet is told once — by the agent core's sweep, not by this read.
    }
    const mine = (x) => x.agentUserId === req.orgUser.id || can(req.tiers, 'agency.compliance.read');
    const reviewList = reviews.forAgency(req.org.id).filter(mine).map((r) => reviewPublic(r));
    const contextList = contexts.forAgent(req.org.id, req.orgUser.id).map(contextForAgent);
    const consentList = consents.forAgent(req.org.id, req.orgUser.id).map(consentForAgent);
    const jurisdictions = [...new Set([...(p?.declared?.jurisdictions ?? []), ...agencyJurisdictions(req.org.id)])].filter((j) => JURISDICTIONS.includes(j));
    const inForce = policySetFor(['INT', ...jurisdictions]);
    res.json({
      provider: provider.status(), facets, freshness,
      policies: { inEffect: inForce.policies.map((x) => ({ id: x.id, regulator: x.regulator, jurisdiction: x.jurisdiction, effectiveFrom: x.effectiveFrom })), missing: inForce.missing },
      reviews: reviewList, contexts: contextList, consents: consentList,
      minorReadiness: jurisdictions.filter((j) => j !== 'INT').map((ma) => minorReadinessFor(p, ma)),
      counts: { reviewsPending: reviewList.filter((r) => r.status === 'PENDING' || r.status === 'IN_REVIEW').length, contextsOpen: contextList.filter((c) => c.status === 'open').length, consentsOutstanding: consentList.filter((k) => k.status === 'requested').length, staleFacets: freshness.filter((f) => f.state === 'STALE').length },
      honest: 'ScoutBox policy results say whether this workflow may proceed under the currently encoded rules. They are not statements of legal validity and no governing body has approved anything here.',
    });
  });

  // ============================================================ contexts
  const contextById = (id) => (typeof id === 'string' ? contexts.byId(id) : null);
  const partyName = (party, org) => {
    if (party.subjectKind === 'club') return byId.org(party.subjectId)?.name ?? null;
    const pl = findPlayer(party.subjectId);
    return pl && orgCanSee(org, pl) ? pl.name : null;
  };
  const lastEvaluation = (c) => c?.lastEvaluation ?? null;
  function contextForAgent(c) {
    const org = byId.org(c.agencyOrgId);
    const ev = lastEvaluation(c);
    return {
      id: c.id, type: c.type, status: c.status, jurisdictions: c.jurisdictions, scope: resolveScope(c.jurisdictions).scope,
      parties: c.parties.map((p) => ({ id: p.id, partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId, name: org ? partyName(p, org) : null, removed: !!p.removed })),
      representations: c.representations.map((r) => ({ id: r.id, agentUserId: r.agentUserId, partyRole: r.partyRole, agreementId: r.agreementId ?? null, status: r.status, declaredOnly: !!r.declaredOnly, reviewId: r.reviewId ?? null, firstActAt: r.firstActAt ?? null })),
      clearance: ev ? { outcome: ev.outcome, alias: ev.alias ?? null, reasons: ev.reasons, consentsOutstanding: ev.consentsOutstanding, requiredActions: ev.requiredActions, policyVersions: ev.policyVersions, evaluatedAt: ev.evaluatedAt, inputHash: ev.inputHash, current: !c.reEvaluationPending } : null,
      reEvaluationPending: !!c.reEvaluationPending, evaluationCount: c.evaluationCount ?? 0,
      openedAt: c.openedAt, closedAt: c.closedAt ?? null, ...revMeta(c),
      history: (c.history ?? []).map((h) => ({ id: h.id, at: h.at, action: h.action, byKind: h.by?.kind ?? null, detail: h.detail ?? null })),
      honest: 'A compliance context is a minimal record for conflict evaluation. It is not a Transaction Room: no negotiation, no terms, no offer and no signing happen here.',
    };
  }
  const revokedAtOf = (k) => k.revocation?.at ?? null;
  const consentStatusOf = (k) => (k.revocation ? 'revoked' : k.status);
  const consentForAgent = (k) => ({
    id: k.id, kind: k.kind, status: consentStatusOf(k), contextId: k.contextId ?? null, partyRole: k.partyRole ?? null, subjectKind: k.subject?.kind ?? null,
    requestedAt: k.requestedAt ?? null, grantedAt: k.grantedAt ?? null, declinedAt: k.declinedAt ?? null, revokedAt: revokedAtOf(k), policyVersions: k.policyVersions ?? [], ruleIds: k.ruleIds ?? [],
    particulars: k.particulars ?? null, ...revMeta(k),
  });
  /** The live consent rows the engine reads: status derived from the append-only ledger. */
  const engineConsentsFor = (contextId) => consents.forContext(contextId).map(({ revocation, ...k }) => ({ ...k, status: revocation ? 'revoked' : k.status, revokedAt: revocation?.at ?? null }));

  /** Assemble the engine's inputs from live records (the domain layer the pure engine never reads itself). */
  const repInput = (r) => ({ agentUserId: r.agentUserId, partyRole: r.partyRole, agreementId: r.agreementId ?? null, declaredOnly: r.status === 'pending_review', status: r.status === 'pending_review' ? 'declared' : r.status, firstActAt: r.firstActAt ?? null });
  const sameTransaction = (a, b) => {
    // Two contexts describe the same real-world transaction when they name the same individual and the same entities.
    const key = (c) => c.parties.filter((p) => !p.removed).map((p) => `${p.partyRole}:${p.subjectId}`).sort().join('|');
    const ka = key(a); const kb = key(b);
    const ia = a.parties.find((p) => p.partyRole === 'individual' && !p.removed)?.subjectId;
    return !!ia && ia === b.parties.find((p) => p.partyRole === 'individual' && !p.removed)?.subjectId && (ka === kb || a.parties.filter((p) => !p.removed).every((p) => b.parties.some((q) => !q.removed && q.partyRole === p.partyRole && q.subjectId === p.subjectId)));
  };
  function engineInput(c, { proposed = null } = {}) {
    const org = byId.org(c.agencyOrgId);
    const reps = c.representations.filter((r) => r.status !== 'withdrawn').map(repInput);
    if (proposed) reps.push(proposed);
    // Connected agents (same agency, FA 6.5 / FFAR 12(10)): a colleague's verified
    // representation of a party in the SAME transaction (another open context of
    // this agency naming the same parties) is attributed to this agent. The
    // colleague is never named in a reason; only the attributed party roles are.
    const colleagues = agentReads.affiliations.forAgency(c.agencyOrgId).filter((a) => a.userId !== c.agentUserId && affiliationActive(a, now())).map((a) => a.userId);
    for (const other of contexts.openForAgencyExcept(c.agencyOrgId, c.id)) {
      if (!colleagues.includes(other.agentUserId) || !sameTransaction(c, other)) continue;
      for (const r of other.representations) if (r.status === 'verified' && r.agentUserId !== c.agentUserId) reps.push({ ...repInput(r), viaColleague: true });
    }
    // The opener is always evaluated (even before any representation), so their state is always supplied.
    const agentIds = [...new Set([c.agentUserId, ...reps.map((r) => r.agentUserId)])];
    const agents = {};
    for (const id of agentIds) {
      const aff = activeAffiliationOf(id, c.agencyOrgId);
      agents[id] = { licenceState: aff ? facetStatesOf(profileOf(id)).fifa_licence : 'NO_AFFILIATION', connectedAgentUserIds: colleagues.filter((x) => x !== id).concat(id === c.agentUserId ? [] : [c.agentUserId]) };
    }
    const parties = c.parties.map((p) => {
      const pl = p.subjectKind === 'player' ? findPlayer(p.subjectId) : null;
      // A block or a lost visibility removes the party from the evaluation: a regulatory CLEAR never overrides safety.
      const gone = p.subjectKind === 'player' ? (!pl || !org || !orgCanSee(org, pl)) : !byId.org(p.subjectId);
      return { partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId, removed: !!p.removed || gone, isMinor: pl ? !isAdult(pl) : false };
    });
    const set = policySetFor(c.jurisdictions);
    return {
      // Other Services and declared interests have no route that records them: the engine reads none.
      transaction: { id: c.id, type: c.type, jurisdictions: c.jurisdictions.map((ma) => ({ memberAssociation: ma })), parties, representations: reps, otherServices: [], evaluateAgentUserIds: [c.agentUserId] },
      agents, consents: engineConsentsFor(c.id), interests: [],
      policySet: set.policies, missingPolicies: set.missing, now: now(),
    };
  }
  /** Player account removal: contexts and consents naming the player keep only the id. */
  function onPlayerDeleted(playerId, at = now()) {
    complianceRecords.forgetPlayer(playerId, at, () => ({ id: nextId('aud'), at: now(), action: 'compliance_context_party_removed', by: bySystem('account deletion'), detail: { partyRole: 'individual' } }));
  }
  /**
   * Evaluate the context as it is stored now; when `record`, append the evaluation (with its history entry) and answer
   * the stored one (with its `evaluationId`). The caller holds the unit.
   */
  function evaluateAndRecord(c, by, { proposed = null, record = true } = {}) {
    const cur = contextById(c.id) ?? c;
    const result = evaluateConflict(engineInput(cur, { proposed }));
    if (!record) return result;
    const stored = contexts.recordEvaluation(cur.id, result, {
      parties: cur.parties.map((p) => ({ partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId })),
      representations: cur.representations.map((r) => ({ agentUserId: r.agentUserId, partyRole: r.partyRole, status: r.status })),
      proposed: proposed ? { partyRole: proposed.partyRole, agentUserId: proposed.agentUserId } : null,
    }, { id: nextId('aud'), at: now(), action: 'compliance_context_evaluated', by, detail: { outcome: result.outcome, reasonCodes: [...new Set(result.reasons.map((r) => r.code))], policyVersions: result.policyVersions } });
    broadcast('conflict_evaluated', { orgId: cur.agencyOrgId, ctxId: cur.id, outcome: result.outcome });
    return stored;
  }
  const bumpContext = (id, req) => contexts.recordAct(id, bumped(req.orgUser));
  /** A refusal after a write that must not stand (a stale rev): the unit rolls back; the response was already sent. */
  const ROLLBACK = Symbol('compliance rollback');
  const unitOrSent = (work) => { try { return unit(work); } catch (e) { if (e === ROLLBACK) return undefined; throw e; } };

  /** Steps 1–6 for an agent acting on a context of their own. Conceals foreign contexts. */
  function ownContext(req, res, id, { write = false } = {}) {
    if (!access.resolveMembership(req, res)) return null;
    if (!access.requireCap(req, res, write ? 'compliance.contexts.write' : 'compliance.read')) return null;
    const c = contextById(id);
    if (!c || c.agencyOrgId !== req.org.id || c.agentUserId !== req.orgUser.id) { sendComplianceError(res, { error: 'CONTEXT_NOT_FOUND' }, 'context'); return null; }
    return c;
  }
  const resolveParty = (req, res, raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || [raw.partyRole, raw.subjectKind, raw.subjectId].some((v) => typeof v !== 'string')) { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'Each party needs partyRole (individual | engaging_entity | releasing_entity), subjectKind (player | club) and subjectId, as text.' }, 'party'); return null; }
    const { partyRole, subjectKind, subjectId } = raw;
    if (!PARTY_ROLES.includes(partyRole) || !['player', 'club'].includes(subjectKind) || !subjectId) { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'Each party needs partyRole (individual | engaging_entity | releasing_entity), subjectKind (player | club) and subjectId.' }, 'party'); return null; }
    if (subjectKind === 'player') {
      if (partyRole !== 'individual') { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'A player is the individual party.' }, 'party'); return null; }
      const pl = findPlayer(subjectId);
      // Uniform concealment: does not exist, minor, invisible and blocked answer alike (never reveals a hidden minor).
      if (!pl || !isAdult(pl) || !visibleToOrg(pl, req.org) || isBlocked(pl.id, req.org.id)) { sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'party'); return null; }
      return { id: nextId('cpt'), partyRole, subjectKind, subjectId: pl.id, addedAt: now(), removed: false, removedAt: null };
    }
    if (partyRole === 'individual') { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'A club is an engaging or releasing entity.' }, 'party'); return null; }
    const org = byId.org(subjectId, (o) => o.type === 'club');
    if (!org) { sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'party'); return null; }
    return { id: nextId('cpt'), partyRole, subjectKind, subjectId: org.id, addedAt: now(), removed: false, removedAt: null };
  };
  /** Step 10–11: the agent's own facets under the applicable set, for a declaration in this context. */
  function facetGate(req, res, p, mas) {
    const set = policySetFor(mas);
    const d = evaluatePolicy({ action: 'declare_representation', memberAssociations: mas, facets: facetStatesOf(p), policySet: set.policies, missingPolicies: set.missing, now: now() });
    if (d.facetGaps.length) { const g = d.facetGaps[0]; sendComplianceError(res, { error: g.code, facet: g.facet, memberAssociation: g.memberAssociation, state: g.state, message: `A regulated action needs a VERIFIED ${g.facet}${g.memberAssociation ? ` (${g.memberAssociation})` : ''}; it is ${g.state}.` }, 'facets'); return null; }
    if (d.requiresManualReview && d.reasons.some((r) => r.code === 'POLICY_NOT_ENCODED')) { sendComplianceError(res, { error: 'JURISDICTION_UNSUPPORTED', reasons: d.reasons.filter((r) => r.code === 'POLICY_NOT_ENCODED'), policyVersions: d.policyVersions, message: 'No encoded policy covers this jurisdiction. The workflow cannot proceed without attributed review under an encoded policy version.' }, 'facets'); return null; }
    return d;
  }

  orgRouter.get('/agent/compliance/contexts', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'compliance.read')) return;
    res.json({ items: contexts.forAgent(req.org.id, req.orgUser.id).map(contextForAgent), types: CONTEXT_TYPES, partyRoles: PARTY_ROLES });
  });
  orgRouter.post('/agent/compliance/contexts', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'compliance.contexts.write')) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const type = String(b.type ?? '');
    if (!CONTEXT_TYPES.includes(type)) return sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'type', allowed: CONTEXT_TYPES }, 'contexts');
    if (!Array.isArray(b.jurisdictions) || b.jurisdictions.some((j) => typeof j !== 'string')) return sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'jurisdictions', message: 'jurisdictions must be a non-empty list of three-letter member-association codes (INT for FIFA level).' }, 'contexts');
    const jurisdictions = [...new Set(b.jurisdictions.map((j) => j.toUpperCase()))];
    if (!jurisdictions.length || jurisdictions.length > 10 || jurisdictions.some((j) => !/^[A-Z]{3}$/.test(j))) return sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'jurisdictions', message: 'jurisdictions must be a non-empty list of up to ten three-letter member-association codes (INT for FIFA level).' }, 'contexts');
    if (b.parties !== undefined && b.parties !== null && (!Array.isArray(b.parties) || b.parties.length > 6)) return sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'parties must be a list of at most six parties.' }, 'contexts');
    const fp = payloadFingerprint({ type, jurisdictions, parties: Array.isArray(b.parties) ? b.parties : [] });
    if (key) {
      const hit = contexts.byCreateKey(req.org.id, req.orgUser.id, key);
      if (hit) { if (hit.keys.create.fp === fp) return res.json({ context: contextForAgent(hit), idempotent: true }); return sendComplianceError(res, { error: 'CONTEXT_IDEMPOTENCY_CONFLICT' }, 'contexts'); }
    }
    const p = profileOf(req.orgUser.id);
    if (!p) return sendComplianceError(res, { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' }, 'contexts');
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    if (!facetGate(req, res, p, jurisdictions)) return;
    const parties = [];
    for (const raw of Array.isArray(b.parties) ? b.parties : []) {
      const party = resolveParty(req, res, raw); if (!party) return;
      if (parties.some((x) => x.partyRole === party.partyRole)) return sendComplianceError(res, { error: 'CONTEXT_PARTY_EXISTS', message: `A ${party.partyRole} party is already named.` }, 'contexts');
      parties.push(party);
    }
    const c = {
      id: nextId('ctx'), agencyOrgId: req.org.id, agentUserId: req.orgUser.id, type, jurisdictions, parties, representations: [],
      resolvedFacts: [], reEvaluationPending: false, reviewRejectedAt: null, status: 'open',
      openedAt: now(), closedAt: null, keys: key ? { create: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(c, 'compliance_context_opened', byOrg(req), { type, policyVersions: policySetFor(jurisdictions).policies.map((x) => x.id) });
    const out = unit(() => { contexts.create(c); evaluateAndRecord(c, byOrg(req)); return contextById(c.id); });
    res.status(201).json({ context: contextForAgent(out) });
  });
  orgRouter.get('/agent/compliance/contexts/:id', (req, res) => {
    const c = ownContext(req, res, req.params.id); if (!c) return;
    res.json({ context: contextForAgent(c) });
  });
  orgRouter.post('/agent/compliance/contexts/:id/evaluate', (req, res) => {
    const c = ownContext(req, res, req.params.id); if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'evaluate');
    const { result, ctx } = unit(() => { const result = evaluateAndRecord(c, byOrg(req)); return { result, ctx: bumpContext(c.id, req) }; });
    res.json({ context: contextForAgent(ctx), evaluation: result });
  });
  orgRouter.post('/agent/compliance/contexts/:id/parties', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'parties');
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    const party = resolveParty(req, res, req.body); if (!party) return;
    if (c.parties.some((x) => x.partyRole === party.partyRole && !x.removed)) return sendComplianceError(res, { error: 'CONTEXT_PARTY_EXISTS' }, 'parties');
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const { result, ctx } = unit(() => {
      contexts.addParty(c.id, { party }, { history: [entry('compliance_context_party_added', byOrg(req), { partyRole: party.partyRole, kind: party.subjectKind })] });
      // A party change invalidates every prior check: re-evaluate now.
      const result = evaluateAndRecord(c, byOrg(req));
      return { result, ctx: bumpContext(c.id, req) };
    });
    res.status(201).json({ context: contextForAgent(ctx), evaluation: result });
  });

  /**
   * THE regulated mutation: the agent records that they perform
   * Football Agent Services for a party in this context. Full pipeline, at
   * mutation time, every time.
   */
  orgRouter.post('/agent/compliance/contexts/:id/representations', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'representations');
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    if (typeof b.partyRole !== 'string') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'partyRole', allowed: PARTY_ROLES }, 'representations');
    if (b.agreementId !== undefined && b.agreementId !== null && typeof b.agreementId !== 'string') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'agreementId', message: 'agreementId must be text.' }, 'representations');
    const partyRole = b.partyRole;
    const party = c.parties.find((x) => x.partyRole === partyRole && !x.removed);
    if (!party) return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'representations');
    const fp = payloadFingerprint({ partyRole, agreementId: b.agreementId ?? null });
    if (key) {
      const hit = c.representations.find((r) => r.keys?.declare?.key === key);
      if (hit) { if (hit.keys.declare.fp === fp) return res.json({ context: contextForAgent(c), representation: hit, idempotent: true }); return sendComplianceError(res, { error: 'CONTEXT_IDEMPOTENCY_CONFLICT' }, 'representations'); }
    }
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    // 3–4 agent profile + affiliation (resolveMembership did 4); 7–8 client relationship, scope and status.
    const p = profileOf(req.orgUser.id);
    if (!p) return sendComplianceError(res, { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' }, 'representations');
    let agreement = null; let declaredOnly = false;
    if (party.subjectKind === 'player') {
      const found = typeof b.agreementId === 'string' ? agentReads.agreements.byId(b.agreementId) : null;
      agreement = found && found.agentUserId === req.orgUser.id && found.agencyOrgId === req.org.id && found.clientId === party.subjectId ? found : null;
      // 9 blocks / safeguarding first: a block ends everything, agreement or not — and it must
      // not be distinguishable from "no such party" via a later scope refusal (uniform 404).
      const pl = findPlayer(party.subjectId);
      if (!pl || !orgCanSee(req.org, pl) || !isAdult(pl)) return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'representations');
      if (!agreement) return sendComplianceError(res, { error: 'REPRESENTATION_REQUIRED', message: 'A client-confirmed, active relationship with this party is required (agreementId).' }, 'representations');
      const st = effectiveAgreementStatus(agreement, now());
      const problem = representationScopeProblem({ agreement, effectiveStatus: st, confirmed: agreement.confirmedAt != null && agreementGrantsAccess(agreement, req.orgUser.id, now()), contextType: c.type, memberAssociations: c.jurisdictions });
      if (problem) return sendComplianceError(res, { ...problem, message: problem.error === 'REPRESENTATION_SCOPE_INSUFFICIENT' ? 'The relationship does not cover this action\'s scope or jurisdiction.' : 'No active, client-confirmed relationship covers this party.' }, 'representations');
    } else {
      // An entity client without a ScoutBox agreement is declared only → attributed review, never CLEAR (DR-18).
      declaredOnly = true;
    }
    if (c.representations.some((r) => r.partyRole === partyRole && r.status !== 'withdrawn' && r.agentUserId === req.orgUser.id)) return sendComplianceError(res, { error: 'CONTEXT_PARTY_EXISTS', message: 'You already represent this party in this context.' }, 'representations');
    // 10–11 policy set + licence / registration / authorisation.
    if (!facetGate(req, res, p, c.jurisdictions)) return;
    // 12–13 conflict + consents, with the proposed representation included; 14 minor gate is inside the engine (MINOR_PARTY).
    const proposed = { agentUserId: req.orgUser.id, partyRole, agreementId: agreement?.id ?? null, declaredOnly, status: declaredOnly ? 'declared' : 'verified', firstActAt: now() };
    const out = unitOrSent(() => {
      const result = evaluateAndRecord(c, byOrg(req), { proposed });
      if (result.outcome === 'PROHIBITED_CONFLICT') { bumpContext(c.id, req); return { refuse: { error: 'REPRESENTATION_CONFLICT', reasons: result.reasons.filter((r) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED', 'CONNECTED_AGENT_ATTRIBUTION'].includes(r.code)), policyVersions: result.policyVersions, outcome: result.outcome, message: 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.' } }; }
      if (result.outcome === PERMITTED_WITH_CONSENT) { bumpContext(c.id, req); return { refuse: { error: 'CONSENT_REQUIRED', consentsOutstanding: result.consentsOutstanding, reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'), policyVersions: result.policyVersions, outcome: result.outcome, contextId: c.id, message: 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.' } }; }
      if (result.outcome === 'INSUFFICIENT_DATA' && !declaredOnly) { bumpContext(c.id, req); return { refuse: { error: 'COMPLIANCE_INSUFFICIENT_DATA', reasons: result.reasons.filter((r) => result.missingEvidence.includes(r.code)), policyVersions: result.policyVersions, outcome: result.outcome, message: 'A fact the evaluation needs is missing. Nothing was recorded.' } }; }
      // 15 manual review.
      if (result.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' || result.outcome === 'INSUFFICIENT_DATA') {
        if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) throw ROLLBACK;
        const repId = declaredOnly ? nextId('crp') : null;
        const kind = declaredOnly ? 'representation_declared' : 'conflict_evaluation';
        const review = createReview({ kind, agencyOrgId: c.agencyOrgId, agentUserId: req.orgUser.id, subject: { contextId: c.id, representationId: repId, partyRole }, reasons: result.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: result.policyVersions, snapshot: result, requestedBy: byOrg(req) });
        if (declaredOnly) {
          const representation = { id: repId, agentUserId: req.orgUser.id, partyRole, agreementId: null, status: 'pending_review', declaredOnly: true, reviewId: review.id, declaredAt: now(), firstActAt: null, withdrawnAt: null, verifiedByReviewId: null, verifiedAt: null, keys: key ? { declare: { key, fp } } : {} };
          contexts.declareRepresentation(c.id, { representation }, { ...bumped(req.orgUser), history: [entry('compliance_representation_declared', byOrg(req), { partyRole, status: 'pending_review' })] });
        } else bumpContext(c.id, req);
        return { refuse: { error: 'REGULATORY_REVIEW_REQUIRED', reviewId: review.id, contextId: c.id, reasons: review.reasons, policyVersions: result.policyVersions, outcome: result.outcome, message: declaredOnly ? 'Representation of an entity without a ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.' : 'The deciding rule\'s operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.' } };
      }
      // 16 rev; 17 mutate; 18 audit + event.
      if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) throw ROLLBACK;
      const rep = { id: nextId('crp'), agentUserId: req.orgUser.id, partyRole, agreementId: agreement?.id ?? null, status: 'verified', declaredOnly: false, reviewId: null, declaredAt: now(), firstActAt: now(), withdrawnAt: null, verifiedByReviewId: null, verifiedAt: null, keys: key ? { declare: { key, fp } } : {} };
      const ctx = contexts.declareRepresentation(c.id, { representation: rep }, { ...bumped(req.orgUser), history: [entry('compliance_representation_declared', byOrg(req), { partyRole, status: 'verified', outcome: result.outcome, policyVersions: result.policyVersions })] });
      return { ctx, rep, result };
    });
    if (!out) return;
    if (out.refuse) return sendComplianceError(res, out.refuse, 'representations');
    res.status(201).json({ context: contextForAgent(out.ctx), representation: { id: out.rep.id, partyRole, status: out.rep.status }, evaluation: out.result });
  });
  orgRouter.post('/agent/compliance/contexts/:id/representations/:repId/withdraw', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    const rep = c.representations.find((r) => r.id === req.params.repId && r.agentUserId === req.orgUser.id);
    if (!rep) return sendComplianceError(res, { error: 'CONTEXT_NOT_FOUND' }, 'withdraw');
    if (rep.status === 'withdrawn') return res.json({ context: contextForAgent(c), idempotent: true });
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const { result, ctx } = unit(() => {
      contexts.withdrawRepresentation(c.id, { representationId: rep.id, at: now() }, { history: [entry('compliance_representation_withdrawn', byOrg(req), { partyRole: rep.partyRole })] });
      const result = evaluateAndRecord(c, byOrg(req));
      return { result, ctx: bumpContext(c.id, req) };
    });
    res.json({ context: contextForAgent(ctx), evaluation: result });
  });
  /** Close a context and cancel its open review items, each attributed (`bump` names who bumped the review's rev). */
  function closeContextNow(c, by, bumpBy = null) {
    contexts.close(c.id, { at: now() }, { history: [entry('compliance_context_closed', by)] });
    for (const r of reviews.openForContext(c.id)) {
      reviews.cancel(r.id, { at: now() }, { ...(bumpBy ? bumped(bumpBy) : {}), history: [entry('regulatory_review_cancelled', by, { reasonCode: 'context_closed' })] });
    }
  }
  orgRouter.post('/agent/compliance/contexts/:id/close', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    if (c.status === 'closed') return res.json({ context: contextForAgent(c), idempotent: true });
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const ctx = unit(() => { closeContextNow(c, byOrg(req), req.orgUser); return bumpContext(c.id, req); });
    res.json({ context: contextForAgent(ctx) });
  });

  // ============================================================ consents
  const consentById = (id) => (typeof id === 'string' ? consents.byId(id) : null);
  const consentForParty = (k) => {
    const c = contextById(k.contextId);
    const ag = profileOf(k.agentUserId);
    const org = byId.org(k.agencyOrgId);
    return {
      id: k.id, kind: k.kind, status: consentStatusOf(k), partyRole: k.partyRole,
      agent: { userId: k.agentUserId, displayName: ag?.displayName ?? null, agency: org?.name ?? null, licence: ag ? facetStatesOf(ag).fifa_licence : 'UNVERIFIED' },
      context: c ? { id: c.id, type: c.type, jurisdictions: c.jurisdictions, parties: c.parties.filter((p) => !p.removed).map((p) => ({ partyRole: p.partyRole, subjectKind: p.subjectKind, name: p.subjectKind === 'club' ? (byId.org(p.subjectId)?.name ?? null) : (p.subjectId === k.subject?.id ? 'You' : null) })) } : null,
      otherPartyRoles: k.regarding ?? [], particulars: k.particulars ?? null, policyVersions: k.policyVersions ?? [], ruleIds: k.ruleIds ?? [],
      requestedAt: k.requestedAt, grantedAt: k.grantedAt ?? null, declinedAt: k.declinedAt ?? null, revokedAt: revokedAtOf(k), ...revMeta(k),
      honest: 'You may decline. Consent is specific to this agent, this transaction context and these parties; it can be revoked at any time, and a revocation stops any future regulated action that needs it. ScoutBox records your answer; it does not advise you.',
    };
  };
  orgRouter.post('/agent/compliance/contexts/:id/consents/request', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    requestDualRepresentationConsent(req, res, c);
  });
  /**
   * Request a party's prior written consent to multiple representation.
   *
   * Extracted from the route body so the transaction workspace requests a
   * consent through EXACTLY this code (its own route resolves the transaction
   * and hands over the linked context). A second implementation would be a
   * second set of rules about when a consent may exist, which is the one thing
   * a consent ledger must not have.
   */
  function requestDualRepresentationConsent(req, res, given) {
    const c = contextById(given.id) ?? given; // the context as stored now (the transaction seam projects it first)
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'consents');
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    if (typeof b.partyRole !== 'string') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'partyRole', allowed: PARTY_ROLES }, 'consents');
    for (const f of ['fullParticularsProvided', 'legalAdviceOffered', 'proposedFeeDisclosed']) if (b[f] !== undefined && typeof b[f] !== 'boolean') return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: f, message: `${f} must be true or false.` }, 'consents');
    const partyRole = b.partyRole;
    const party = c.parties.find((x) => x.partyRole === partyRole && !x.removed);
    if (!party) return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'consents');
    const fp = payloadFingerprint({ partyRole });
    if (key) {
      const hit = consents.byRequestKey(c.id, req.orgUser.id, key);
      if (hit) { if (hit.keys.request.fp === fp) return res.json({ consent: consentForAgent(hit), idempotent: true }); return sendComplianceError(res, { error: 'CONSENT_IDEMPOTENCY_CONFLICT' }, 'consents'); }
    }
    if (limitedOr429(res, 'compliance_consent_request', req.orgUser.id)) return;
    const p = profileOf(req.orgUser.id);
    if (!p || !facetGate(req, res, p, c.jurisdictions)) return;
    // Consent exists only where an ACTIVE encoded rule makes it the permitted route (no generic bypass).
    const set = policySetFor(c.jurisdictions);
    const { scope, memberAssociations } = resolveScope(c.jurisdictions);
    const nationalPolicy = scope === 'national' ? set.policies.find((x) => x.jurisdiction === memberAssociations[0]) : null;
    const ruleId = nationalPolicy ? Object.keys(nationalPolicy.rules).find((id) => nationalPolicy.rules[id]?.params?.consentKind === 'dual_representation') ?? null : 'FIFA-12.8';
    const rule = ruleId ? ruleAt(set.policies, ruleId, now()) : { ruleId: null, status: 'UNKNOWN', policy: null };
    if (rule.status !== 'ACTIVE') return sendComplianceError(res, { error: 'REGULATORY_REVIEW_REQUIRED', reasons: [{ code: rule.status === 'UNKNOWN' ? 'POLICY_NOT_ENCODED' : 'RULE_STATUS_UNCERTAIN', ruleId: rule.ruleId, ruleStatus: rule.status, policyVersion: rule.policy?.id ?? null }], policyVersions: set.policies.map((x) => x.id), message: 'Consent can only be requested under an ACTIVE encoded rule. The deciding rule\'s status is uncertain or not encoded; consent would not cure that.' }, 'consents');
    const existing = consents.forContext(c.id).find((k) => k.kind === 'dual_representation' && k.agentUserId === req.orgUser.id && k.partyRole === partyRole && (consentStatusOf(k) === 'requested' || consentStatusOf(k) === 'granted'));
    if (existing) return sendComplianceError(res, { error: 'CONSENT_ALREADY_REQUESTED', status: consentStatusOf(existing) }, 'consents');
    const k = {
      id: nextId('rcs'), kind: 'dual_representation', contextId: c.id, agentUserId: req.orgUser.id, agencyOrgId: c.agencyOrgId, partyRole,
      subject: { kind: party.subjectKind, id: party.subjectId }, regarding: c.parties.filter((x) => !x.removed && x.partyRole !== partyRole).map((x) => x.partyRole),
      status: 'requested', requestedAt: now(), requestedBy: byOrg(req), grantedAt: null, grantedBy: null, declinedAt: null, declinedBy: null,
      particulars: { fullParticularsProvided: !!b.fullParticularsProvided, legalAdviceOffered: !!b.legalAdviceOffered, proposedFeeDisclosed: !!b.proposedFeeDisclosed, acknowledged: null },
      policyVersions: set.policies.map((x) => x.id), ruleIds: [rule.ruleId], keys: key ? { request: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null,
      history: [entry('regulatory_consent_requested', byOrg(req), { partyRole, kind: 'dual_representation', policyVersions: set.policies.map((x) => x.id) })],
    };
    const out = unit(() => {
      const stored = consents.create(k);
      broadcast('regulatory_consent_requested', { orgId: c.agencyOrgId, consentId: k.id, ctxId: c.id });
      const agentName = p.displayName ?? req.orgUser.name;
      if (party.subjectKind === 'player') notify({ kind: 'player', id: party.subjectId }, 'regulatory_consent_requested', `${agentName} (${req.org.name}) asks your written consent to also act for another party in a ${c.type.replace(/_/g, ' ')} involving you. You may decline. Nothing changes until you answer.`, k.id);
      else for (const u of rawCtx.verificationReads.admins.activeForOrg(party.subjectId)) notify({ kind: 'org_user', id: u.userId }, 'regulatory_consent_requested', `${agentName} (${req.org.name}) asks your club's written consent to act for more than one party in a ${c.type.replace(/_/g, ' ')}. Only a recorded signatory may answer.`, k.id);
      return stored;
    });
    res.status(201).json({ consent: consentForAgent(out) });
  }

  /** One consent answer path for both lanes. `who` resolves the acting party and its authority. */
  function consentAnswer(req, res, { action, who, by, rateKey }) {
    const k = consentById(req.params.id);
    if (!k) return sendComplianceError(res, { error: 'CONSENT_NOT_FOUND' }, action);
    const authority = who(k);
    if (!authority.ok) return sendComplianceError(res, { error: authority.error ?? 'CONSENT_NOT_FOUND', ...(authority.message ? { message: authority.message } : {}) }, action);
    if (limitedOr429(res, 'compliance_consent_response', rateKey)) return;
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const fp = payloadFingerprint({ action });
    if (key && k.keys?.[action]?.key === key) { if (k.keys[action].fp === fp) return res.json({ consent: consentForParty(k), idempotent: true }); return sendComplianceError(res, { error: 'CONSENT_IDEMPOTENCY_CONFLICT' }, action); }
    const st = consentStatusOf(k);
    const revBy = { id: by.userId, name: by.name };
    if (action === 'revoke') {
      if (st !== 'granted') return sendComplianceError(res, { error: 'CONSENT_NOT_PENDING', status: st, message: 'Only a granted consent can be revoked.' }, action);
      if (!guardRev(req, res, k, { errorCode: 'CONSENT_VERSION_CONFLICT', current: { status: st } })) return;
      const out = unit(() => {
        // Append-only: the revocation is its own row; the granted row is never edited (only its key, history and rev).
        const next = consents.revoke(k.id, { revocation: { id: nextId('rcs'), at: now(), by }, key: key ? { key, fp } : null },
          { ...bumped(revBy), history: [entry('regulatory_consent_revoked', by, { consentId: k.id, partyRole: k.partyRole })] });
        const c = contextById(k.contextId);
        if (c && c.status === 'open') evaluateAndRecord(c, by);
        broadcast('regulatory_consent_revoked', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
        notify({ kind: 'org_user', id: k.agentUserId }, 'regulatory_consent_revoked', 'A party revoked their consent to multiple representation. Any future regulated action that needs it will be refused; the record of what happened before stays.', k.id);
        return next;
      });
      return res.json({ consent: consentForParty(out) });
    }
    if (st !== 'requested') return sendComplianceError(res, { error: 'CONSENT_NOT_PENDING', status: st }, action);
    if (!guardRev(req, res, k, { errorCode: 'CONSENT_VERSION_CONFLICT', current: { status: st } })) return;
    if (action === 'grant') {
      const ackP = req.body?.acknowledgedParticulars === true; const ackL = req.body?.acknowledgedLegalAdvice === true;
      if (!ackP || !ackL) return sendComplianceError(res, { error: 'CONSENT_INPUT_INVALID', field: !ackP ? 'acknowledgedParticulars' : 'acknowledgedLegalAdvice', message: 'To grant, confirm you received the full particulars and were told you may take independent legal advice.' }, action);
    }
    const out = unit(() => {
      const answerKey = key ? { key, fp } : null;
      // The server's clock, never a client timestamp.
      const next = action === 'grant'
        ? consents.grant(k.id, { at: now(), by: { ...by, ...(authority.signatory !== undefined ? { signatory: authority.signatory } : {}) }, key: answerKey },
          { ...bumped(revBy), history: [entry('regulatory_consent_granted', by, { partyRole: k.partyRole, policyVersions: k.policyVersions })] })
        : consents.decline(k.id, { at: now(), by, key: answerKey }, { ...bumped(revBy), history: [entry('regulatory_consent_declined', by, { partyRole: k.partyRole })] });
      const c = contextById(k.contextId);
      if (c && c.status === 'open') evaluateAndRecord(c, by);
      // Literal event names: the event-registry contract (e2e/platform/contracts.mjs) reads call sites textually.
      if (action === 'grant') broadcast('regulatory_consent_granted', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
      else broadcast('regulatory_consent_declined', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
      notify({ kind: 'org_user', id: k.agentUserId }, action === 'grant' ? 'regulatory_consent_granted' : 'regulatory_consent_declined', action === 'grant' ? 'A party granted written consent to multiple representation for one transaction context. It is specific to that context and can be revoked.' : 'A party declined consent to multiple representation. You may continue to act for your first party only.', k.id);
      return next;
    });
    res.json({ consent: consentForParty(out) });
  }
  // Player lane.
  playerRouter.get('/agent/consents', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true, note: 'Agent representation and its consents are not available for under-18 accounts in ScoutBox.' });
    res.json({ items: consents.forSubject('player', req.player.id).filter((k) => k.kind === 'dual_representation').map(consentForParty) });
  });
  const playerWho = (req) => (k) => {
    if (req.playerIsMinor) return { ok: false, error: 'COMPLIANCE_ACTION_NOT_PERMITTED', message: 'Guardian-managed accounts cannot answer agent consents in ScoutBox.' };
    if (k.subject?.kind !== 'player' || k.subject.id !== req.player.id) return { ok: false, error: 'CONSENT_NOT_FOUND' };
    return { ok: true };
  };
  for (const action of ['grant', 'decline', 'revoke']) {
    playerRouter.post(`/agent/consents/:id/${action}`, (req, res) => consentAnswer(req, res, { action, who: playerWho(req), by: byPlayer(req), rateKey: req.player.id }));
  }
  // Club lane: only a club user with verification authority (the recorded signatory) may bind the club (DR-19).
  const clubWho = (req) => (k) => {
    if (req.org.type !== 'club') return { ok: false, error: 'CONSENT_NOT_FOUND' };
    if (k.subject?.kind !== 'club' || k.subject.id !== req.org.id) return { ok: false, error: 'CONSENT_NOT_FOUND' };
    if (!hasVerLevel(rawCtx.verificationReads, req.org.id, req.orgUser.id, 'verification_admin')) return { ok: false, error: 'SIGNATORY_REQUIRED', message: 'Only a recorded club signatory (a verification administrator) may answer for the club.' };
    return { ok: true, signatory: true };
  };
  orgRouter.get('/compliance/consents', (req, res) => {
    if (req.org.type !== 'club') return sendComplianceError(res, { error: 'COMPLIANCE_ACTION_NOT_PERMITTED' }, 'consents');
    res.json({ items: consents.forSubject('club', req.org.id).filter((k) => k.kind === 'dual_representation').map(consentForParty), signatory: hasVerLevel(rawCtx.verificationReads, req.org.id, req.orgUser.id, 'verification_admin') });
  });
  for (const action of ['grant', 'decline', 'revoke']) {
    orgRouter.post(`/compliance/consents/:id/${action}`, (req, res) => consentAnswer(req, res, { action, who: clubWho(req), by: byClubUser(req), rateKey: req.orgUser.id }));
  }

  // ============================================================ reviews — the attributed lane
  const reviewById = (id) => (typeof id === 'string' ? reviews.byId(id) : null);
  /**
   * The queue, by cursor (`?status=&limit=&cursor=`): open items first, each part oldest first. The T&S app reads
   * the first page (a "load more" is still to be built).
   */
  const queuePage = (req, res, { forReviewer }) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status !== null && !REVIEW_STATUSES.includes(status)) { sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'status', allowed: REVIEW_STATUSES }, 'reviews'); return null; }
    let page;
    try { page = readPage(req.query, ['number', 'number', 'number']); } catch (e) { sendPageError(res, e); return null; }
    const { rows } = reviews.queuePage({ status, limit: page.limit, after: page.after });
    const out = pageOf(rows, page.limit, (r) => r.key);
    return { items: out.items.map((r) => reviewPublic(r.record, { forReviewer })), nextCursor: out.nextCursor };
  };
  tsRouter.get('/compliance/reviews', (req, res) => {
    const page = queuePage(req, res, { forReviewer: true }); if (!page) return;
    res.json({ ...page, statuses: REVIEW_STATUSES, kinds: REVIEW_KINDS, reviewer: publicReviewer(req.reviewer) });
  });
  tsRouter.get('/compliance/reviews/:id', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'review');
    res.json({ review: reviewPublic(r, { forReviewer: true }), subjectDetail: reviewSubjectDetail(r) });
  });
  /** What a reviewer may see of the subject: states and ids, no client data beyond the review's need. */
  function reviewSubjectDetail(r) {
    if (r.kind === 'verification_facet') { const p = agentReads.profiles.byId(r.subject.profileId); const rec = p ? facetRecord(p, r.subject.facet, r.subject.memberAssociation) : null; return { agentDisplayName: p?.displayName ?? null, facet: r.subject.facet, memberAssociation: r.subject.memberAssociation, reference: rec?.reference ?? null, state: rec ? effectiveFacetState(rec, now()) : null, submittedAt: rec?.submittedAt ?? null }; }
    if (r.kind === 'representation_dispute') { const a = agentReads.agreements.byId(r.subject.agreementId); return a ? { agreementId: a.id, status: effectiveAgreementStatus(a, now()), disputedAt: a.disputedAt ?? null, hadReason: !!a.disputeReason, scope: a.scope, jurisdiction: a.jurisdiction ?? null } : null; }
    const c = contextById(r.subject?.contextId);
    return c ? { contextId: c.id, type: c.type, jurisdictions: c.jurisdictions, partyRoles: c.parties.filter((p) => !p.removed).map((p) => p.partyRole), representations: c.representations.map((x) => ({ partyRole: x.partyRole, status: x.status })), lastOutcome: lastEvaluation(c)?.outcome ?? null } : null;
  }
  tsRouter.post('/compliance/reviews/:id/start', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'start');
    if (r.status === 'IN_REVIEW' && r.startedBy?.id === req.reviewer.id) return res.json({ review: reviewPublic(r, { forReviewer: true }), idempotent: true });
    if (r.status !== 'PENDING') return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'start');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const out = unit(() => {
      const next = reviews.start(r.id, { at: now(), by: { id: req.reviewer.id, name: req.reviewer.name, role: req.reviewer.role } },
        { ...bumped(req.reviewer), history: [entry('regulatory_review_started', byReviewer(req), { rev: r.rev })] });
      broadcast('regulatory_review_started', { orgId: r.agencyOrgId, reviewId: r.id });
      return next;
    });
    res.json({ review: reviewPublic(out, { forReviewer: true }) });
  });
  tsRouter.post('/compliance/reviews/:id/resolve', (req, res) => {
    if (limitedOr429(res, 'ts_review_decision', req.reviewer.id)) return;
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'resolve');
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    for (const f of ['outcome', 'reasonCode', 'reason']) if (b[f] !== undefined && b[f] !== null && typeof b[f] !== 'string') return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: f, message: `${f} must be text.` }, 'resolve');
    if (b.evidenceRefs !== undefined && b.evidenceRefs !== null && (!Array.isArray(b.evidenceRefs) || b.evidenceRefs.some((e) => typeof e !== 'string') || b.evidenceRefs.length > 10)) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'evidenceRefs', message: 'evidenceRefs must be a list of at most ten texts.' }, 'resolve');
    const outcome = b.outcome ?? '';
    const reasonCode = String(b.reasonCode ?? '').trim().slice(0, 60);
    const reason = String(b.reason ?? '').trim().slice(0, 1000);
    const evidenceRefs = [...new Set((b.evidenceRefs ?? []).map((e) => e.trim().slice(0, 200)).filter(Boolean))];
    const fp = payloadFingerprint({ outcome, reasonCode, reason, evidenceRefs });
    if (key && r.keys?.resolve?.key === key) { if (r.keys.resolve.fp === fp) return res.json({ review: reviewPublic(r, { forReviewer: true }), idempotent: true }); return sendComplianceError(res, { error: 'REVIEW_IDEMPOTENCY_CONFLICT' }, 'resolve'); }
    if (!['APPROVED', 'REJECTED'].includes(outcome)) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'outcome', allowed: ['APPROVED', 'REJECTED'] }, 'resolve');
    if (!reasonCode || !reason) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: !reasonCode ? 'reasonCode' : 'reason', message: 'A reason code and a written reason are required.' }, 'resolve');
    if (outcome === 'APPROVED' && !evidenceRefs.length) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'evidenceRefs', message: 'An approval must cite at least one evidence reference.' }, 'resolve');
    if (r.status !== 'PENDING' && r.status !== 'IN_REVIEW') return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'resolve');
    // Override limits: a reviewer resolves missing or uncertain FACTS; a reviewer never rewrites active policy.
    if (outcome === 'APPROVED') {
      if (r.snapshot?.outcome === 'PROHIBITED_CONFLICT' || (r.reasons ?? []).some((x) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED'].includes(x.code))) return sendComplianceError(res, { error: 'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE', message: 'An objectively prohibited combination under an ACTIVE rule cannot be approved by review.' }, 'resolve');
      if (r.kind === 'conflict_evaluation' && (r.reasons ?? []).some((x) => POLICY_LEVEL_REASONS.includes(x.code))) return sendComplianceError(res, { error: 'REVIEW_REQUIRES_POLICY_VERSION', reasons: r.reasons.filter((x) => POLICY_LEVEL_REASONS.includes(x.code)), message: 'The deciding rule\'s status is uncertain or not encoded. Only a published policy version (dual control) can settle that; a review cannot approve past it. It may be rejected (the workflow does not proceed) or left pending.' }, 'resolve');
    }
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const priorState = { status: r.status, ...reviewEffectState(r) };
    // Apply the platform effect of the decision and record it, as one unit (the effect on a facet, an agreement or a
    // context is a table write, like the review's).
    const out = unit(() => {
      const resultingState = applyReviewDecision(r, outcome, req);
      const decision = { reviewerId: req.reviewer.id, reviewerName: req.reviewer.name, reviewerRole: req.reviewer.role, outcome, reasonCode, reason, evidenceRefs, policyVersions: r.policyVersions, at: now(), priorState, resultingState };
      const next = reviews.resolve(r.id, { decision, key: key ? { key, fp } : null }, {
        ...bumped(req.reviewer),
        history: [entry('regulatory_review_resolved', byReviewer(req), { outcome, reasonCode, evidenceRefs, evidenceCount: evidenceRefs.length, policyVersions: r.policyVersions, priorState, resultingState, rev: r.rev })],
      });
      broadcast('regulatory_review_resolved', { orgId: r.agencyOrgId, reviewId: r.id, outcome });
      if (r.agentUserId) notify({ kind: 'org_user', id: r.agentUserId }, 'regulatory_review_completed', `Attributed Trust & Safety review ${outcome === 'APPROVED' ? 'approved' : 'did not approve'} a ${r.kind.replace(/_/g, ' ')} item under ScoutBox policy. This is a platform decision, not a legal determination.`, r.id);
      return next;
    });
    res.json({ review: reviewPublic(out, { forReviewer: true }) });
  });
  function reviewEffectState(r) {
    if (r.kind === 'verification_facet') { const p = agentReads.profiles.byId(r.subject.profileId); const rec = p ? facetRecord(p, r.subject.facet, r.subject.memberAssociation) : null; return { facetState: rec ? effectiveFacetState(rec, now()) : null }; }
    if (r.kind === 'representation_dispute') { const a = agentReads.agreements.byId(r.subject.agreementId); return { agreementStatus: a ? effectiveAgreementStatus(a, now()) : null }; }
    const c = contextById(r.subject?.contextId); const rep = c?.representations.find((x) => x.id === r.subject?.representationId);
    return { contextOutcome: c ? lastEvaluation(c)?.outcome ?? null : null, representationStatus: rep?.status ?? null };
  }
  function applyReviewDecision(r, outcome, req) {
    const by = byReviewer(req);
    if (r.kind === 'verification_facet') {
      const p = agentReads.profiles.byId(r.subject.profileId);
      if (!p) return { facetState: null, note: 'profile gone' };
      const cur = facetRecord(p, r.subject.facet, r.subject.memberAssociation) ?? { state: 'UNVERIFIED', reference: null, memberAssociation: r.subject.memberAssociation ?? null, provenance: null, submittedAt: null, verifiedAt: null, recheckAt: null, note: null, staleNotifiedAt: null };
      const prev = effectiveFacetState(cur, now());
      const next = outcome === 'APPROVED'
        ? { ...cur, state: 'VERIFIED', verifiedAt: now(), recheckAt: now() + RECHECK_MS, provenance: { provider: 'attributed_review', kind: 'human_review', at: now(), reviewerId: req.reviewer.id, reviewId: r.id }, note: 'Verified by attributed Trust & Safety review against the cited evidence. Re-check due in 30 days.', staleNotifiedAt: null }
        : { ...cur, state: 'UNVERIFIED', verifiedAt: null, recheckAt: null, provenance: { provider: 'attributed_review', kind: 'human_review', at: now(), reviewerId: req.reviewer.id, reviewId: r.id }, note: 'Attributed Trust & Safety review could not verify this reference.' };
      agentCore.profiles.setFacet(p.id, { facet: r.subject.facet, memberAssociation: r.subject.memberAssociation, record: { ...next, staleNotifiedAt: null } }, {
        at: now(), touch: true, ...bumped(req.reviewer),
        history: [entry('agent_verification_state_changed', by, { facet: r.subject.facet, memberAssociation: r.subject.memberAssociation, from: prev, to: next.state, state: next.state, reviewId: r.id })],
      });
      broadcast('agent_verification_state_changed', { orgId: p.agencyOrgId, userId: p.userId, facet: r.subject.facet, state: next.state });
      broadcast('agent_authorisation_state_changed', { orgId: p.agencyOrgId, userId: p.userId, state: next.state });
      return { facetState: next.state };
    }
    if (r.kind === 'representation_dispute') {
      const a = agentReads.agreements.byId(r.subject.agreementId);
      if (!a || a.status !== 'disputed') return { agreementStatus: a ? effectiveAgreementStatus(a, now()) : null, note: 'not disputed any more' };
      // Reinstated: the client's confirmation is unchanged; only the dispute suspension lifts. An expired term stays expired.
      agentCore.agreements.resolveDispute(a.id, { outcome: outcome === 'APPROVED' ? 'reinstated' : 'ended', reviewId: r.id, at: now() }, {
        ...bumped(req.reviewer),
        history: [entry(outcome === 'APPROVED' ? 'representation_confirmed' : 'representation_terminated', by, { by: 'trust_safety', phase: 'disputed', reviewId: r.id, reasonCode: outcome === 'APPROVED' ? 'dispute_reinstated' : 'dispute_upheld' })],
      });
      broadcast(outcome === 'APPROVED' ? 'representation_confirmed' : 'representation_terminated', { orgId: a.agencyOrgId, agreementId: a.id, agentUserId: a.agentUserId });
      notify({ kind: 'player', id: a.clientId }, 'representation_disputed', outcome === 'APPROVED' ? 'Attributed Trust & Safety review resolved your dispute: the relationship record is reinstated. You can still end it at any time.' : 'Attributed Trust & Safety review resolved your dispute: the relationship record has been ended.', a.id);
      if (a.agentUserId) notify({ kind: 'org_user', id: a.agentUserId }, 'representation_disputed', outcome === 'APPROVED' ? 'A disputed relationship was reinstated by attributed review.' : 'A disputed relationship was ended by attributed review.', a.id);
      return { agreementStatus: effectiveAgreementStatus(agentReads.agreements.byId(a.id), now()) };
    }
    const c = contextById(r.subject?.contextId);
    if (!c) return { contextOutcome: null, note: 'context gone' };
    if (r.kind === 'representation_declared') {
      // When the declaration belongs to a transaction, the transaction's
      // representation row is the TRUTH and the context's array is its
      // evaluation projection — so the reviewer's decision must land on the
      // row, not only on the projection.
      if (r.subject?.transactionId && transactionHooks.representationReviewed) {
        transactionHooks.representationReviewed({ transactionId: r.subject.transactionId, representationId: r.subject.representationId, outcome, by, reviewId: r.id });
      }
      const live = contextById(c.id);
      const rep = live.representations.find((x) => x.id === r.subject.representationId);
      if (rep && rep.status === 'pending_review') {
        // A review-verified declaration records no act by the agent: firstActAt stays null until
        // the agent themselves acts, so a later party-specific consent is still "in advance".
        contexts.decideRepresentation(c.id, { representationId: rep.id, approved: outcome === 'APPROVED', reviewId: r.id, at: now() },
          { history: [entry(outcome === 'APPROVED' ? 'compliance_representation_verified' : 'compliance_representation_withdrawn', by, { partyRole: rep.partyRole, reviewId: r.id })] });
      }
    } else if (r.kind === 'conflict_evaluation') {
      const book = { history: [entry('compliance_context_evaluated', by, { reviewId: r.id, outcome: outcome === 'APPROVED' ? 'review_approved' : 'review_rejected' })] };
      if (outcome === 'APPROVED') contexts.resolveFacts(c.id, { codes: (r.reasons ?? []).map((x) => x.code).filter((code) => ['OTHER_SERVICES_PRESUMPTION', 'INTEREST_DECLARED', 'REPRESENTATION_UNVERIFIED'].includes(code)) }, book);
      else contexts.rejectByReview(c.id, { at: now() }, book);
    }
    if (contextById(c.id).status === 'open') evaluateAndRecord(c, by);
    const after = contexts.recordAct(c.id, bumped(req.reviewer));
    return { contextOutcome: lastEvaluation(after)?.outcome ?? null, representationStatus: after.representations.find((x) => x.id === r.subject?.representationId)?.status ?? null };
  }
  tsRouter.post('/compliance/reviews/:id/cancel', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'cancel');
    if (r.status !== 'PENDING' && r.status !== 'IN_REVIEW') return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'cancel');
    if (req.body?.reason !== undefined && req.body.reason !== null && typeof req.body.reason !== 'string') return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'reason', message: 'reason must be text.' }, 'cancel');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 400);
    if (!reason) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'reason' }, 'cancel');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const decision = { reviewerId: req.reviewer.id, reviewerName: req.reviewer.name, reviewerRole: req.reviewer.role, outcome: 'CANCELLED', reasonCode: 'cancelled', reason, evidenceRefs: [], policyVersions: r.policyVersions, at: now(), priorState: null, resultingState: null };
    const out = unit(() => reviews.cancel(r.id, { at: now(), decision }, { ...bumped(req.reviewer), history: [entry('regulatory_review_cancelled', byReviewer(req), { outcome: 'CANCELLED', reasonCode: 'cancelled', rev: r.rev })] }));
    res.json({ review: reviewPublic(out, { forReviewer: true }) });
  });
  /** Reconsideration never rewrites a final decision: a new review supersedes it, with the old one retained. */
  tsRouter.post('/compliance/reviews/:id/supersede', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'supersede');
    if (!['APPROVED', 'REJECTED'].includes(r.status)) return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status, message: 'Only a decided review can be superseded.' }, 'supersede');
    if (r.supersededBy) return sendComplianceError(res, { error: 'REVIEW_ALREADY_EXISTS', reviewId: r.supersededBy }, 'supersede');
    if (req.body?.reason !== undefined && req.body.reason !== null && typeof req.body.reason !== 'string') return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'reason', message: 'reason must be text.' }, 'supersede');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 400);
    if (!reason) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'reason' }, 'supersede');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const { next, old } = unit(() => {
      const next = createReview({ kind: r.kind, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId, subject: r.subject, reasons: r.reasons, policyVersions: policySetFor(r.subject?.memberAssociation ? [r.subject.memberAssociation] : (contextById(r.subject?.contextId)?.jurisdictions ?? [])).policies.map((p) => p.id), snapshot: r.snapshot, requestedBy: byReviewer(req), supersedes: r.id });
      // The decision is retained untouched.
      const old = reviews.markSuperseded(r.id, {}, { ...bumped(req.reviewer), history: [entry('regulatory_review_superseded', byReviewer(req), { reasonCode: 'superseded', reviewId: next.id, priorState: { status: r.status }, rev: r.rev })] });
      return { next, old };
    });
    res.status(201).json({ review: reviewPublic(next, { forReviewer: true }), superseded: reviewPublic(old, { forReviewer: true }) });
  });
  tsRouter.get('/compliance/audit', (req, res) => res.json({ items: reviewerDecisionRows(complianceRecords.reads, 200), legacyNote: REVIEWER_LEGACY_NOTE }));
  /** Process metrics only: counts and durations; never a person, never a ranking. */
  tsRouter.get('/compliance/metrics', (_req, res) => {
    let stale = 0;
    for (const f of agentReads.profiles.facetStates()) if (effectiveFacetState(f, now()) === 'STALE') stale += 1;
    res.json({
      reviews: reviews.metrics(),
      conflictOutcomes: contexts.outcomeCounts(),
      consents: consents.metrics(),
      staleFacets: stale,
      note: 'Process metrics only. No agent is ranked and no subscription or payment status enters any compliance outcome.',
    });
  });
  // The legacy shared key: read-only, non-authoritative.
  adminRouter.get('/compliance/reviews', (req, res) => {
    const page = queuePage(req, res, { forReviewer: false }); if (!page) return;
    res.json({ ...page, readOnly: true, note: 'Read-only. Starting, resolving, cancelling or superseding a review requires an authenticated reviewer session (/ts). The shared key can adjudicate nothing.' });
  });

  /** For the agent core's request route: an Approach whose deciding rule is uncertain records an attributed review item. */
  function createApproachReview({ req, decision, playerId, jurisdiction }) {
    return createReview({ kind: 'conflict_evaluation', agencyOrgId: req.org.id, agentUserId: req.orgUser.id, subject: { approach: true, playerId, jurisdiction }, reasons: decision.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: decision.policyVersions, snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', evaluatedAt: now() }, requestedBy: byOrg(req) });
  }

  // ============================================================ transaction seam
  /**
   * What the transaction workspace (domains/agents/transactions) is allowed to
   * do with the compliance layer, and nothing more.
   *
   * The seam exists because a transaction must not own a second conflict
   * engine, a second consent ledger or a second policy resolver. A transaction
   * OWNS one compliance context — which this module already knows how to
   * evaluate, flag on policy publication, tombstone on account deletion and
   * attach reviews to — and reads its verdict. The transaction is the
   * multi-party workspace; the context is the evaluation artifact. Neither
   * replaces the other and no fact lives in both as truth.
   *
   * The context stays PERSONAL to the agent who opened it: a club party gets
   * the outcome and its reason codes, never the evaluation's internals. The
   * transaction's own projection is what a club sees.
   */
  /**
   * Filled in by the transaction workspace at registration (server.mjs), after
   * this module is built; until then every branch that consults it is a no-op.
   */
  const transactionHooks = { representationReviewed: null };

  const transactionSeam = {
    hooks: transactionHooks,
    /** Open the evaluation context a transaction owns. `transactionId` is recorded for provenance in both directions. */
    openContext({ agencyOrgId, agentUserId, type, jurisdictions, transactionId, by }) {
      const c = {
        id: nextId('ctx'), agencyOrgId, agentUserId, type, jurisdictions, parties: [], representations: [],
        resolvedFacts: [], reEvaluationPending: false, reviewRejectedAt: null, status: 'open',
        origin: 'transaction', transactionId,
        openedAt: now(), closedAt: null, keys: {}, rev: 1, revAt: now(), revBy: null,
        history: [entry('compliance_context_opened', by, { type, policyVersions: policySetFor(jurisdictions).policies.map((x) => x.id) })],
      };
      return contexts.create(c);
    },
    contextById,
    /**
     * Project the transaction's parties and representation bindings into the
     * context the engine reads. The transaction's own stores remain the truth;
     * this is the evaluation input, rebuilt from them every time, so it
     * cannot go stale.
     */
    project(c, { parties, representations }) {
      contexts.project(c.id, {
        parties: parties.map((p) => ({ id: p.id, partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId, addedAt: p.addedAt ?? null, removed: !!p.removed, removedAt: p.removed ? (p.removedAt ?? null) : null })),
        representations: representations.map((r) => ({ id: r.id, agentUserId: r.agentUserId, partyRole: r.partyRole, agreementId: r.agreementId ?? null, status: r.status, declaredOnly: !!r.declaredOnly, reviewId: r.reviewId ?? null, declaredAt: null, firstActAt: r.firstActAt ?? null, withdrawnAt: null, verifiedByReviewId: null, verifiedAt: null, keys: {} })),
      });
    },
    evaluate(c, by, opts = {}) { return evaluateAndRecord(c, by, opts); },
    lastEvaluation,
    /** The evaluation row a transaction's snapshot names (the snapshot reads its outcome, reasons and versions from it). */
    evaluationById: (id) => contexts.evaluationById(id),
    /** How long each answered consent of a transaction's context waited (the transaction metrics). */
    consentAnswerWaits: () => consents.transactionAnswerWaits(),
    /** A snapshot taken without an evaluation (the facet gate refused first) still answers the policy flag. */
    clearReEvaluation(c) { if (c && contextById(c.id)?.reEvaluationPending) contexts.clearReEvaluation(c.id); },
    consentsFor: engineConsentsFor,
    closeContext(c, by) {
      const cur = c ? contextById(c.id) : null;
      if (!cur || cur.status === 'closed') return;
      closeContextNow(cur, by);
    },
    /** The facet gate as DATA: the first refusal payload, or null. The caller decides how to answer. */
    facetGateProblem(agentUserId, mas) {
      const p = profileOf(agentUserId);
      if (!p) return { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' };
      const set = policySetFor(mas);
      const d = evaluatePolicy({ action: 'declare_representation', memberAssociations: mas, facets: facetStatesOf(p), policySet: set.policies, missingPolicies: set.missing, now: now() });
      if (d.facetGaps.length) { const g = d.facetGaps[0]; return { error: g.code, facet: g.facet, memberAssociation: g.memberAssociation, state: g.state, gate: 'FACET_NOT_VERIFIED' }; }
      if (d.requiresManualReview && d.reasons.some((r) => r.code === 'POLICY_NOT_ENCODED')) return { error: 'JURISDICTION_UNSUPPORTED', reasons: d.reasons.filter((r) => r.code === 'POLICY_NOT_ENCODED'), policyVersions: d.policyVersions, gate: 'JURISDICTION_UNSUPPORTED' };
      return null;
    },
    /** The agent's facet states, for the party-revision hash (a licence change must make a snapshot stale). */
    facetStatesFor: (agentUserId) => { const p = profileOf(agentUserId); return p ? facetStatesOf(p) : null; },
    representationScopeProblem,
    requestConsent: requestDualRepresentationConsent,
    reviewsForContext: (ctxId) => reviews.forContext(ctxId).map((r) => ({ id: r.id, kind: r.kind, status: r.status, requestedAt: r.requestedAt, decidedAt: r.decidedAt ?? null, outcome: r.decision?.outcome ?? null })),
    createReview,
    byOrg, bySystem,
  };

  /**
   * The ONE narrow seam the cross-app integration layer asks. It
   * answers a single question: under the encoded policy in force right now, is
   * this agent clear to perform this regulated action in this jurisdiction?
   *
   * It grants nothing, opens nothing and writes nothing. An unsupported
   * jurisdiction, an unencoded rule and a stale facet all answer "not clear",
   * and the reason codes are the policy engine's own — the integration layer
   * does not invent a compliance vocabulary.
   */
  const integrationSeam = {
    clearFor({ agentUserId, jurisdiction, action }) {
      if (!POLICY_ACTIONS.includes(action)) return { clear: false, reasonCodes: ['ACTION_UNKNOWN'], policyVersions: [] };
      const p = profileOf(agentUserId);
      if (!p) return { clear: false, reasonCodes: ['AGENT_PROFILE_REQUIRED'], policyVersions: [] };
      // The ACTION's jurisdiction, and only that one — exactly as
      // `authorizeApproach` does it. A jurisdiction the agent merely declared an
      // interest in must not make an action elsewhere unlawful: an agent working
      // internationally who has not registered with the FA is not thereby barred
      // from an international act. `evaluatePolicy` adds the INT scope itself.
      const mas = [jurisdiction].filter((m) => typeof m === 'string' && m);
      // No jurisdiction at all is not "the international default": it is a
      // question this build cannot answer, and it fails closed.
      if (!mas.length) return { clear: false, reasonCodes: ['JURISDICTION_UNKNOWN'], policyVersions: [] };
      const set = policySetFor(mas);
      const d = evaluatePolicy({
        action, memberAssociations: mas, facets: facetStatesOf(p),
        policySet: set.policies, missingPolicies: set.missing, now: now(),
      });
      return {
        clear: d.allowed === true,
        reasonCodes: [...new Set(d.reasons.filter((r) => r.code !== 'FACET_VERIFIED').map((r) => r.code))],
        policyVersions: d.policyVersions,
      };
    },
    facetStatesFor: (agentUserId) => { const p = profileOf(agentUserId); return p ? facetStatesOf(p) : null; },
  };

  return {
    reviewerAuth, provider, onPlayerDeleted,
    // What the agent core asks of compliance.
    coreReviews: { facetNeedsReview, representationDisputed, authorizeApproach, createApproachReview },
    complianceAuditRows: (org) => complianceAuditRows(complianceRecords.reads, org),
    facetStatesOf, policySetFor, transactionSeam, integrationSeam,
  };
}
