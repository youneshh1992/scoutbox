/**
 * M23 P5.6C — ScoutBox Agent Conflict & Compliance Engine: routes.
 *
 * The governing principle (mandate §2, §99): ScoutBox is infrastructure. The
 * licensed agent performs the regulated service; this module decides only
 * whether ScoutBox may PERMIT a workflow action under encoded, versioned
 * platform policy. It never negotiates, never advises, never infers a missing
 * permission, and never turns uncertainty into permission.
 *
 * Four routers:
 *   /auth/reviewer/login       credentialed Trust & Safety reviewer login (G-C0)
 *   /ts/*                      attributed reviewer routes — the ONLY authoritative compliance mutations
 *   /org/agent/compliance/*    the agent's own compliance workspace (agency session + membership)
 *   /org/compliance/*          a CLUB party's consent lane (club session + M14 signatory authority)
 *   /player/agent/consents/*   the PLAYER party's consent lane
 *   /admin/compliance/*        the legacy shared key: READ-ONLY, non-authoritative
 *
 * Every regulated mutation re-derives, at mutation time, in this order
 * (mandate §55): authenticate → actor → agent profile → affiliation → conceal
 * foreign resource → role → client relationship → scope/status → blocks →
 * applicable policy set → licence/registration/authorisation → conflict →
 * consents → minor gate → manual review → rev/idempotency → mutate →
 * audit/event. Nothing in a request body is trusted for any of those facts.
 */

import { visibleToOrg } from '../domain.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';
import { guardRev, bumpRev, revMeta } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { normaliseClientKey, payloadFingerprint } from '../m23/contact.mjs';
import { hasVerLevel } from '../m14/shared.mjs';
import { effectiveFacetState, RECHECK_MS, effectiveAgreementStatus, agreementGrantsAccess, affiliationActive, tiersOf, can, JURISDICTIONS, termEndAt } from '../m24/shared.mjs';
import { sendComplianceError } from './errors.mjs';
import { RULE_STATUSES, SEEDED_POLICY_VERSIONS } from './policyVersions.mjs';
import { applicablePolicySet, evaluatePolicy, evaluateMinorGate, representationScopeProblem, resolveScope, ruleAt, MINOR_PATHWAY_PRODUCTION_ENABLED, POLICY_FACETS, POLICY_ACTIONS } from './policy.mjs';
import { evaluateConflict, conflictSummaryForParty, PARTY_ROLES, CONTEXT_TYPES, PERMITTED_WITH_CONSENT } from './conflict.mjs';
import { createVerificationProvider, facetFromProviderAnswer, FACET_METHOD } from './provider.mjs';
import { complianceAuditRows, reviewerDecisionRows } from './audit.mjs';

export const REVIEWER_ROLES = Object.freeze(['trust_safety_reviewer', 'trust_safety_admin']);
export const REVIEW_KINDS = Object.freeze(['verification_facet', 'representation_declared', 'conflict_evaluation', 'representation_dispute']);
export const REVIEW_STATUSES = Object.freeze(['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED']);
export const CONSENT_KINDS = Object.freeze(['dual_representation', 'agency_performance', 'guardian_approach', 'guardian_agreement', 'legal_advice_ack']);
export const CONSENT_STATUSES = Object.freeze(['requested', 'granted', 'declined', 'revoked']);
/** Reason codes only a policy version can settle: a reviewer may not "approve" past them (mandate §37). */
export const POLICY_LEVEL_REASONS = Object.freeze(['RULE_STATUS_UNCERTAIN', 'POLICY_NOT_ENCODED', 'NO_ACTIVE_RULE_DECIDES', 'SCOPE_MIXED', 'EXCLUSIVITY_WINDOW_DOUBTFUL']);

const REVIEWER_LEGACY_NOTE = 'Records made before P5.6C through the shared admin key carry attribution "shared_admin_key" and are preserved as legacy/unattributed. They were never rewritten and are not authoritative compliance decisions.';

export function registerCompliance(rawCtx) {
  const {
    db, app, orgRouter, playerRouter, adminRouter, tsRouter, nextId, persistNow, notify, broadcast,
    findPlayer, isBlocked, isAdult, orgCanSee, moderateOrRefuse, rateLimit,
    hashPassword, verifyPassword, createSession, sessionFor, devLogins, agent, verificationProvider,
  } = rawCtx;

  const provider = verificationProvider ?? createVerificationProvider({ synthetic: process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1' });
  // Registration-time presence (the migration guarantees these; this is the
  // module-class belt to that brace, never a read-time repair).
  db.tsReviewers ??= [];
  db.jurisdictionPolicies ??= [];
  db.regulatoryReviews ??= [];
  db.regulatoryConsents ??= [];
  db.complianceContexts ??= [];
  const now = () => Date.now();
  const hist = (record, action, by, detail = null) => {
    record.history ??= [];
    record.history.push({ id: nextId('aud'), at: now(), action, by, detail });
  };
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
  const profileOf = (userId) => (db.agentProfiles ?? []).find((p) => p && p.userId === userId) ?? null;
  const activeAffiliationOf = (userId, orgId) => (db.agencyAffiliations ?? []).find((a) => a && a.userId === userId && a.agencyOrgId === orgId && affiliationActive(a, now())) ?? null;

  // ============================================================ G-C0 — reviewer identity
  const reviewerById = (id) => db.tsReviewers.find((r) => r && r.id === id) ?? null;
  const activeReviewers = () => db.tsReviewers.filter((r) => r && r.status === 'active');
  const publicReviewer = (r) => ({ id: r.id, name: r.name, role: r.role, status: r.status, createdAt: r.createdAt, revokedAt: r.revokedAt ?? null, ...revMeta(r) });

  function upsertReviewer({ id, name, role, secret, createdBy }) {
    let r = reviewerById(id);
    if (r) return r;
    r = { id, name, role, status: 'active', secretHash: hashPassword(secret), createdAt: now(), createdBy, revokedAt: null, revokedBy: null, rev: 1, revAt: now(), revBy: null, history: [] };
    hist(r, 'reviewer_created', createdBy, { role });
    db.tsReviewers.push(r);
    return r;
  }
  // Bootstrap: an operator-provided root reviewer (production) — never the shared key.
  if (process.env.TS_REVIEWER_BOOTSTRAP_ID && process.env.TS_REVIEWER_BOOTSTRAP_SECRET) {
    upsertReviewer({ id: String(process.env.TS_REVIEWER_BOOTSTRAP_ID).slice(0, 40), name: String(process.env.TS_REVIEWER_BOOTSTRAP_NAME ?? process.env.TS_REVIEWER_BOOTSTRAP_ID).slice(0, 80), role: 'trust_safety_admin', secret: process.env.TS_REVIEWER_BOOTSTRAP_SECRET, createdBy: bySystem('bootstrap env') });
    persistNow();
  }
  // Development and tests only: seeded reviewers with known secrets. Never when dev logins are off.
  if (devLogins && !db.tsReviewers.length) {
    upsertReviewer({ id: 'tsr-dev-admin', name: 'Priya Shah', role: 'trust_safety_admin', secret: 'dev-reviewer-admin', createdBy: bySystem('dev seed') });
    upsertReviewer({ id: 'tsr-dev-reviewer', name: 'Marcus Bell', role: 'trust_safety_reviewer', secret: 'dev-reviewer', createdBy: bySystem('dev seed') });
    upsertReviewer({ id: 'tsr-dev-admin2', name: 'Léa Fontaine', role: 'trust_safety_admin', secret: 'dev-reviewer-admin2', createdBy: bySystem('dev seed') });
    persistNow();
  }

  /** Credentialed login. Uniform refusal for an unknown id, a wrong secret and a revoked reviewer. */
  app.post('/auth/reviewer/login', (req, res) => {
    const id = String(req.body?.reviewerId ?? '').trim();
    const secret = String(req.body?.secret ?? '');
    // P5.6F: the compliance lane is the one where a guessed credential buys the
    // most, so the per-identifier failed-login budget is checked here BEFORE the
    // secret is verified. An unknown id, a wrong secret and a revoked reviewer
    // already share one refusal; the lockout shares it too, so the 429 tells an
    // attacker nothing the uniform refusal did not already withhold.
    const bucket = `reviewer:${id.toLowerCase()}`;
    if (rateLimit.peek('login_failure', bucket).limited) {
      return res.status(429).json(rateLimitedBody('login_failure'));
    }
    const r = reviewerById(id);
    const good = r && r.status === 'active' && !!verifyPassword(secret, r.secretHash);
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
    const r = reviewerById(session.refId);
    if (!r || r.status !== 'active') {
      db.sessions = db.sessions.filter((s) => s !== session);
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
  const revokeReviewerSessions = (id) => { db.sessions = db.sessions.filter((s) => !(s.kind === 'ts_reviewer' && s.refId === id)); };

  tsRouter.get('/me', (req, res) => res.json({ reviewer: publicReviewer(req.reviewer), attribution: 'authenticated_reviewer', note: 'Every authoritative compliance action is recorded against this identity.' }));
  tsRouter.get('/reviewers', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    res.json({ items: db.tsReviewers.map(publicReviewer), legacyNote: REVIEWER_LEGACY_NOTE });
  });
  tsRouter.post('/reviewers', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const id = String(req.body?.id ?? '').trim().slice(0, 40);
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    const role = String(req.body?.role ?? 'trust_safety_reviewer');
    const secret = String(req.body?.secret ?? '');
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/i.test(id) || !name) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'id', message: 'id (3–40 chars, letters, digits, dashes) and name are required.' }, 'reviewers');
    if (!REVIEWER_ROLES.includes(role)) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'role', allowed: REVIEWER_ROLES }, 'reviewers');
    if (secret.length < 12) return sendComplianceError(res, { error: 'COMPLIANCE_INPUT_INVALID', field: 'secret', message: 'A reviewer secret needs at least 12 characters.' }, 'reviewers');
    if (reviewerById(id)) return sendComplianceError(res, { error: 'REVIEWER_EXISTS' }, 'reviewers');
    const r = upsertReviewer({ id, name, role, secret, createdBy: byReviewer(req) });
    persistNow();
    res.status(201).json({ reviewer: publicReviewer(r) });
  });
  tsRouter.post('/reviewers/:id/revoke', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const r = reviewerById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEWER_NOT_FOUND' }, 'reviewers');
    if (r.status === 'revoked') return res.json({ reviewer: publicReviewer(r), idempotent: true });
    if (r.role === 'trust_safety_admin' && activeReviewers().filter((x) => x.role === 'trust_safety_admin').length <= 1) return sendComplianceError(res, { error: 'LAST_REVIEWER_ADMIN', message: 'At least one Trust & Safety administrator must remain.' }, 'reviewers');
    if (!guardRev(req, res, r, { errorCode: 'REVIEWER_VERSION_CONFLICT', current: {} })) return;
    r.status = 'revoked'; r.revokedAt = now(); r.revokedBy = { id: req.reviewer.id, name: req.reviewer.name };
    hist(r, 'reviewer_revoked', byReviewer(req), { reason: String(req.body?.reason ?? '').slice(0, 200) || null });
    bumpRev(r, { by: req.reviewer, at: now() });
    revokeReviewerSessions(r.id);
    persistNow();
    res.json({ reviewer: publicReviewer(r) });
  });

  // ============================================================ policies
  const publishedPolicies = () => db.jurisdictionPolicies.filter((p) => p && p.status === 'published');
  const policySetFor = (mas, at = now()) => applicablePolicySet(publishedPolicies(), mas, at);
  const policyPublic = (p) => ({
    id: p.id, regulator: p.regulator, jurisdiction: p.jurisdiction, policyVersion: p.policyVersion, supersedes: p.supersedes ?? null,
    effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo ?? null, status: p.status,
    publishedAt: p.publishedAt ?? null, proposedBy: p.proposedBy ?? null, approvedBy: p.approvedBy ?? null, publishedBy: p.publishedBy ?? null,
    rules: Object.fromEntries(Object.entries(p.rules ?? {}).map(([id, r]) => [id, { ruleStatus: r.ruleStatus, textStatus: r.textStatus ?? null, note: r.note ?? null, params: r.params ?? {}, sourceRef: r.sourceRef ?? [] }])),
    rev: p.rev ?? 1,
  });
  function validatePolicyBody(b) {
    const errs = [];
    if (!/^jp-[a-z]{2,6}-[0-9a-z-]{2,20}$/i.test(String(b.id ?? ''))) errs.push('id');
    if (!JURISDICTIONS.includes(b.jurisdiction)) errs.push('jurisdiction');
    if (!Number.isInteger(b.policyVersion) || b.policyVersion < 1) errs.push('policyVersion');
    // M23 P5.7 (T-4): a real calendar day in bounds, not merely the shape of one.
    if (!parseStrictDateOnly(b.effectiveFrom).ok) errs.push('effectiveFrom');
    if (b.effectiveTo != null && !parseStrictDateOnly(b.effectiveTo).ok) errs.push('effectiveTo');
    if (b.effectiveTo != null && parseStrictDateOnly(b.effectiveFrom).ok && parseStrictDateOnly(b.effectiveTo).ok && !(b.effectiveFrom < b.effectiveTo)) errs.push('effectiveTo');
    if (!b.rules || typeof b.rules !== 'object' || !Object.keys(b.rules).length) errs.push('rules');
    else for (const [id, r] of Object.entries(b.rules)) {
      if (!RULE_STATUSES.includes(r?.ruleStatus)) errs.push(`rules.${id}.ruleStatus`);
      if (!Array.isArray(r?.sourceRef) || !r.sourceRef.length || r.sourceRef.some((s) => !s?.source || !s?.retrievedDate)) errs.push(`rules.${id}.sourceRef`);
    }
    return errs;
  }
  tsRouter.get('/compliance/policies', (req, res) => res.json({ items: db.jurisdictionPolicies.map(policyPublic), ruleStatuses: RULE_STATUSES, dualControl: true }));
  tsRouter.post('/compliance/policies', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    if (limitedOr429(res, 'ts_policy_publish', req.reviewer.id)) return;
    const b = req.body ?? {};
    const errs = validatePolicyBody(b);
    if (errs.length) return sendComplianceError(res, { error: 'POLICY_INPUT_INVALID', field: errs[0], message: `Invalid policy fields: ${errs.join(', ')}.` }, 'policies');
    if (db.jurisdictionPolicies.some((p) => p.id === b.id)) return sendComplianceError(res, { error: 'POLICY_VERSION_EXISTS' }, 'policies');
    const row = {
      id: b.id, regulator: String(b.regulator ?? '').slice(0, 20) || 'UNKNOWN', jurisdiction: b.jurisdiction, policyVersion: b.policyVersion, supersedes: b.supersedes ?? null,
      effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo ?? null,
      rules: Object.fromEntries(Object.entries(b.rules).map(([id, r]) => [id, { ruleStatus: r.ruleStatus, textStatus: r.textStatus ?? null, sourceRef: r.sourceRef, params: r.params ?? {}, note: String(r.note ?? '').slice(0, 1000) || null, ...(Array.isArray(r.overrides) ? { overrides: r.overrides } : {}), ...(r.effectiveFrom ? { effectiveFrom: r.effectiveFrom } : {}) }])),
      status: 'proposed', proposedBy: { id: req.reviewer.id, name: req.reviewer.name, at: now() }, approvedBy: null, publishedAt: null, publishedBy: null,
      createdAt: now(), rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(row, 'policy_version_proposed', byReviewer(req), { policyVersion: row.id });
    db.jurisdictionPolicies.push(row);
    persistNow();
    res.status(201).json({ policy: policyPublic(row), note: 'Proposed. A DIFFERENT Trust & Safety administrator must approve before it takes effect (dual control, C7).' });
  });
  tsRouter.post('/compliance/policies/:id/approve', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const p = db.jurisdictionPolicies.find((x) => x && x.id === req.params.id);
    if (!p) return sendComplianceError(res, { error: 'POLICY_NOT_FOUND' }, 'policies');
    if (p.status !== 'proposed') return sendComplianceError(res, { error: 'POLICY_NOT_PROPOSED', status: p.status }, 'policies');
    if (p.proposedBy?.id === req.reviewer.id) return sendComplianceError(res, { error: 'POLICY_DUAL_CONTROL_REQUIRED', message: 'The approving administrator must be a different person from the proposer.' }, 'policies');
    p.status = 'published'; p.approvedBy = { id: req.reviewer.id, name: req.reviewer.name, at: now() }; p.publishedAt = now();
    p.publishedBy = [{ kind: 'ts_reviewer', id: p.proposedBy.id, name: p.proposedBy.name }, { kind: 'ts_reviewer', id: req.reviewer.id, name: req.reviewer.name }];
    hist(p, 'policy_version_published', byReviewer(req), { policyVersion: p.id });
    bumpRev(p, { by: req.reviewer, at: now() });
    // Every open context evaluated under an older version of this jurisdiction is flagged — never silently re-verdicted.
    for (const c of db.complianceContexts ?? []) {
      if (!c || c.status !== 'open') continue;
      const last = c.evaluations?.[c.evaluations.length - 1];
      if (last && (c.jurisdictions ?? []).includes(p.jurisdiction) && !last.policyVersions.includes(p.id)) { c.reEvaluationPending = true; hist(c, 'compliance_context_policy_changed', bySystem('policy publication'), { policyVersions: [p.id] }); }
    }
    persistNow();
    broadcast('policy_version_published', {});
    res.json({ policy: policyPublic(p) });
  });
  orgRouter.get('/agent/compliance/policies', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    const mas = [...new Set(['INT', ...(req.org.settings?.jurisdictions ?? []), ...((profileOf(req.orgUser.id)?.declared?.jurisdictions) ?? [])])];
    const set = policySetFor(mas);
    res.json({ inEffect: set.policies.map(policyPublic), missing: set.missing, ruleStatuses: RULE_STATUSES, honest: 'These are ScoutBox\'s encoded platform rules with their operative status as recorded on the retrieval date. They are not legal advice and a status can change without a deploy.' });
  });
  adminRouter.get('/compliance/policies', (_req, res) => res.json({ items: db.jurisdictionPolicies.map(policyPublic), readOnly: true, note: 'Read-only. Publishing needs two authenticated Trust & Safety administrators (/ts).' }));

  // ============================================================ facets and the provider
  const facetStatesOf = (p, at = now()) => ({
    fifa_licence: effectiveFacetState(p?.facets?.fifa_licence, at),
    national_registration: Object.fromEntries(Object.entries(p?.facets?.national_registration ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)])),
    domestic_authorisation: Object.fromEntries(Object.entries(p?.facets?.domestic_authorisation ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)])),
    minors_authorisation: Object.fromEntries(Object.entries(p?.facets?.minors_authorisation ?? {}).map(([k, v]) => [k, effectiveFacetState(v, at)])),
  });
  const facetRecord = (p, facet, ma) => (facet === 'fifa_licence' ? p?.facets?.fifa_licence : p?.facets?.[facet]?.[ma]) ?? null;
  const setFacet = (p, facet, ma, next) => { if (facet === 'fifa_licence') p.facets.fifa_licence = next; else { p.facets[facet] ??= {}; p.facets[facet][ma] = next; } };

  const openReviewFor = (kind, subjectMatch) => db.regulatoryReviews.find((r) => r && r.kind === kind && (r.status === 'PENDING' || r.status === 'IN_REVIEW') && subjectMatch(r.subject ?? {}));
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
  function createReview({ kind, agencyOrgId, agentUserId, subject, reasons, policyVersions, snapshot = null, requestedBy }) {
    const r = {
      id: nextId('rrv'), kind, status: 'PENDING', agencyOrgId, agentUserId: agentUserId ?? null, subject,
      reasons: reasons ?? [], policyVersions: policyVersions ?? [], snapshot,
      requestedAt: now(), requestedBy, startedAt: null, startedBy: null, decidedAt: null, decision: null,
      supersedes: null, supersededBy: null, keys: {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(r, 'regulatory_review_requested', requestedBy, { kind, reasonCodes: [...new Set((reasons ?? []).map((x) => x.code))], policyVersions: r.policyVersions });
    db.regulatoryReviews.push(r);
    broadcast('regulatory_review_requested', { orgId: agencyOrgId, reviewId: r.id, kind });
    if (agentUserId) notify({ kind: 'org_user', id: agentUserId }, 'regulatory_review_required', kind === 'verification_facet' ? 'A verification submission needs attributed Trust & Safety review. Nothing is verified until a named reviewer decides.' : 'A compliance question needs attributed Trust & Safety review. The workflow does not proceed until a named reviewer decides.', r.id);
    return r;
  }

  /** Hook for m24: a facet submission that ended MANUAL_REVIEW_REQUIRED becomes a review item. Idempotent per facet. */
  function facetNeedsReview(profile, { facet, memberAssociation, reference }, by) {
    if (openReviewFor('verification_facet', (s) => s.profileId === profile.id && s.facet === facet && (s.memberAssociation ?? null) === (memberAssociation ?? null))) return null;
    return createReview({ kind: 'verification_facet', agencyOrgId: profile.agencyOrgId, agentUserId: profile.userId, subject: { profileId: profile.id, userId: profile.userId, facet, memberAssociation: memberAssociation ?? null, referenceHash: reference ? String(reference.length) : null }, reasons: [{ code: 'NO_PROVIDER', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: policySetFor([memberAssociation].filter(Boolean)).policies.map((p) => p.id), requestedBy: by });
  }
  /** Hook for m24: a client's dispute becomes a review item (P5.6A C6). */
  function representationDisputed(a, by) {
    if (openReviewFor('representation_dispute', (s) => s.agreementId === a.id)) return null;
    return createReview({ kind: 'representation_dispute', agencyOrgId: a.agencyOrgId, agentUserId: a.agentUserId, subject: { agreementId: a.id }, reasons: [{ code: 'CLIENT_DISPUTE', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: policySetFor([a.jurisdiction].filter(Boolean)).policies.map((p) => p.id), requestedBy: by });
  }
  /** Hook for m24's request route: the policy layer's verdict on an Approach (exclusivity window, USA domestic authorisation …). */
  function authorizeApproach({ profile, jurisdiction, player, agentUserId }) {
    const set = policySetFor([jurisdiction]);
    const others = (db.representationAgreements ?? []).filter((a) => a && a.clientId === player.id && a.agentUserId && a.agentUserId !== agentUserId && a.exclusive && effectiveAgreementStatus(a, now()) === 'active' && a.confirmedAt).map((a) => ({ endAt: a.endAt ?? null }));
    const d = evaluatePolicy({ action: 'approach_adult', memberAssociations: [jurisdiction], facets: facetStatesOf(profile), policySet: set.policies, missingPolicies: set.missing, otherExclusiveAgreements: others, now: now() });
    return { decision: d, policySet: set };
  }

  /** Re-check a facet against the provider (mandate §31): STALE needs a recheck or attributed review. */
  orgRouter.post('/agent/compliance/facets/:facet/recheck', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'verification.submit')) return;
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
    setFacet(p, facet, ma, next);
    hist(p, 'agent_facet_rechecked', byOrg(req), { facet, memberAssociation: ma, from: prevState, to: effectiveFacetState(next, now()) });
    if (next.state === 'MANUAL_REVIEW_REQUIRED') facetNeedsReview(p, { facet, memberAssociation: ma, reference: cur.reference }, byOrg(req));
    if (prevState !== effectiveFacetState(next, now())) { hist(p, 'agent_verification_state_changed', byOrg(req), { facet, memberAssociation: ma, from: prevState, to: effectiveFacetState(next, now()), state: next.state }); broadcast('agent_verification_state_changed', { orgId: req.org.id, userId: p.userId, facet, state: effectiveFacetState(next, now()) }); }
    p.updatedAt = now(); bumpRev(p, { by: req.orgUser, at: now() }); persistNow();
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
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'compliance.read')) return;
    const p = profileOf(req.orgUser.id);
    const facets = p ? facetStatesOf(p) : null;
    const freshness = [];
    if (p) {
      const push = (facet, ma, rec) => { if (!rec) return; const st = effectiveFacetState(rec, now()); freshness.push({ facet, memberAssociation: ma, state: st, storedState: rec.state, recheckAt: rec.recheckAt ?? null, daysUntilRecheck: typeof rec.recheckAt === 'number' ? Math.ceil((rec.recheckAt - now()) / 86_400_000) : null, provenance: rec.provenance ?? null, verifiedAt: rec.verifiedAt ?? null }); };
      push('fifa_licence', null, p.facets?.fifa_licence);
      for (const f of ['national_registration', 'domestic_authorisation', 'minors_authorisation']) for (const [ma, rec] of Object.entries(p.facets?.[f] ?? {})) push(f, ma, rec);
      // A STALE facet is told once (mandate §70).
      for (const f of freshness) if (f.state === 'STALE') { const rec = facetRecord(p, f.facet, f.memberAssociation); if (rec && !rec.staleNotifiedAt) { rec.staleNotifiedAt = now(); notify({ kind: 'org_user', id: p.userId }, 'agent_verification_stale', `Verification of ${f.facet}${f.memberAssociation ? ` (${f.memberAssociation})` : ''} has gone STALE. Re-check it or request attributed review before any regulated action.`, p.id); persistNow(); } }
    }
    const mine = (x) => x && x.agencyOrgId === req.org.id && (x.agentUserId === req.orgUser.id || can(req.tiers, 'agency.compliance.read'));
    const reviews = db.regulatoryReviews.filter(mine).map((r) => reviewPublic(r));
    const contexts = db.complianceContexts.filter((c) => c && c.agencyOrgId === req.org.id && c.agentUserId === req.orgUser.id).map(contextForAgent);
    const consents = db.regulatoryConsents.filter((k) => k && k.agencyOrgId === req.org.id && k.agentUserId === req.orgUser.id && k.kind !== 'revocation').map(consentForAgent);
    const jurisdictions = [...new Set([...(p?.declared?.jurisdictions ?? []), ...(req.org.settings?.jurisdictions ?? [])])].filter((j) => JURISDICTIONS.includes(j));
    res.json({
      provider: provider.status(), facets, freshness,
      policies: { inEffect: policySetFor(['INT', ...jurisdictions]).policies.map((x) => ({ id: x.id, regulator: x.regulator, jurisdiction: x.jurisdiction, effectiveFrom: x.effectiveFrom })), missing: policySetFor(['INT', ...jurisdictions]).missing },
      reviews, contexts, consents,
      minorReadiness: jurisdictions.filter((j) => j !== 'INT').map((ma) => minorReadinessFor(p, ma)),
      counts: { reviewsPending: reviews.filter((r) => r.status === 'PENDING' || r.status === 'IN_REVIEW').length, contextsOpen: contexts.filter((c) => c.status === 'open').length, consentsOutstanding: consents.filter((k) => k.status === 'requested').length, staleFacets: freshness.filter((f) => f.state === 'STALE').length },
      honest: 'ScoutBox policy results say whether this workflow may proceed under the currently encoded rules. They are not statements of legal validity and no governing body has approved anything here.',
    });
  });

  // ============================================================ contexts
  const contextById = (id) => db.complianceContexts.find((c) => c && c.id === id) ?? null;
  const partyName = (party, org) => {
    if (party.subjectKind === 'club') return db.orgs.find((o) => o.id === party.subjectId)?.name ?? null;
    const pl = findPlayer(party.subjectId);
    return pl && orgCanSee(org, pl) ? pl.name : null;
  };
  const lastEvaluation = (c) => c.evaluations?.[c.evaluations.length - 1] ?? null;
  function contextForAgent(c) {
    const org = db.orgs.find((o) => o.id === c.agencyOrgId);
    const ev = lastEvaluation(c);
    return {
      id: c.id, type: c.type, status: c.status, jurisdictions: c.jurisdictions, scope: resolveScope(c.jurisdictions).scope,
      parties: c.parties.map((p) => ({ id: p.id, partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId, name: org ? partyName(p, org) : null, removed: !!p.removed })),
      representations: c.representations.map((r) => ({ id: r.id, agentUserId: r.agentUserId, partyRole: r.partyRole, agreementId: r.agreementId ?? null, status: r.status, declaredOnly: !!r.declaredOnly, reviewId: r.reviewId ?? null, firstActAt: r.firstActAt ?? null })),
      clearance: ev ? { outcome: ev.outcome, alias: ev.alias ?? null, reasons: ev.reasons, consentsOutstanding: ev.consentsOutstanding, requiredActions: ev.requiredActions, policyVersions: ev.policyVersions, evaluatedAt: ev.evaluatedAt, inputHash: ev.inputHash, current: !c.reEvaluationPending } : null,
      reEvaluationPending: !!c.reEvaluationPending, evaluationCount: (c.evaluations ?? []).length,
      openedAt: c.openedAt, closedAt: c.closedAt ?? null, ...revMeta(c),
      history: (c.history ?? []).map((h) => ({ id: h.id, at: h.at, action: h.action, byKind: h.by?.kind ?? null, detail: h.detail ?? null })),
      honest: 'A compliance context is a minimal record for conflict evaluation. It is not a Transaction Room: no negotiation, no terms, no offer and no signing happen here.',
    };
  }
  const consentForAgent = (k) => ({
    id: k.id, kind: k.kind, status: consentStatusOf(k), contextId: k.contextId ?? null, partyRole: k.partyRole ?? null, subjectKind: k.subject?.kind ?? null,
    requestedAt: k.requestedAt ?? null, grantedAt: k.grantedAt ?? null, declinedAt: k.declinedAt ?? null, revokedAt: revokedAtOf(k), policyVersions: k.policyVersions ?? [], ruleIds: k.ruleIds ?? [],
    particulars: k.particulars ?? null, ...revMeta(k),
  });
  const revokedAtOf = (k) => db.regulatoryConsents.find((x) => x && x.kind === 'revocation' && x.of === k.id)?.at ?? null;
  const consentStatusOf = (k) => (revokedAtOf(k) ? 'revoked' : k.status);
  /** The live consent rows the engine reads: status derived from the append-only ledger. */
  const engineConsentsFor = (contextId) => db.regulatoryConsents.filter((k) => k && k.contextId === contextId && k.kind !== 'revocation').map((k) => ({ ...k, status: consentStatusOf(k), revokedAt: revokedAtOf(k) }));

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
    const org = db.orgs.find((o) => o.id === c.agencyOrgId);
    const reps = c.representations.filter((r) => r.status !== 'withdrawn').map(repInput);
    if (proposed) reps.push(proposed);
    // Connected agents (same agency, FA 6.5 / FFAR 12(10)): a colleague's verified
    // representation of a party in the SAME transaction (another open context of
    // this agency naming the same parties) is attributed to this agent. The
    // colleague is never named in a reason; only the attributed party roles are.
    const colleagues = (db.agencyAffiliations ?? []).filter((a) => a && a.agencyOrgId === c.agencyOrgId && a.userId !== c.agentUserId && affiliationActive(a, now())).map((a) => a.userId);
    for (const other of db.complianceContexts) {
      if (!other || other.id === c.id || other.agencyOrgId !== c.agencyOrgId || other.status !== 'open' || !colleagues.includes(other.agentUserId)) continue;
      if (!sameTransaction(c, other)) continue;
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
      // A block or a lost visibility removes the party from the evaluation: a regulatory CLEAR never overrides safety (mandate §54).
      const gone = p.subjectKind === 'player' ? (!pl || !org || !orgCanSee(org, pl)) : !db.orgs.some((o) => o.id === p.subjectId);
      return { partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId, removed: !!p.removed || gone, isMinor: pl ? !isAdult(pl) : false };
    });
    const set = policySetFor(c.jurisdictions);
    return {
      transaction: { id: c.id, type: c.type, jurisdictions: c.jurisdictions.map((ma) => ({ memberAssociation: ma })), parties, representations: reps, otherServices: (c.otherServices ?? []).filter((o) => !(c.resolvedFacts ?? []).includes('OTHER_SERVICES_PRESUMPTION')), evaluateAgentUserIds: [c.agentUserId] },
      agents, consents: engineConsentsFor(c.id), interests: (c.interests ?? []).filter(() => !(c.resolvedFacts ?? []).includes('INTEREST_DECLARED')),
      policySet: set.policies, missingPolicies: set.missing, now: now(),
    };
  }
  /** Player account removal: contexts and consents naming the player keep only the id (mandate §AJ). */
  function onPlayerDeleted(playerId, at = now()) {
    for (const c of db.complianceContexts) {
      if (!c) continue;
      let touched = false;
      for (const p of c.parties) if (p.subjectKind === 'player' && p.subjectId === playerId && !p.removed) { p.removed = true; p.removedAt = at; touched = true; }
      if (touched) { hist(c, 'compliance_context_party_removed', bySystem('account deletion'), { partyRole: 'individual' }); for (const h of c.history ?? []) if (h?.by?.kind === 'player') h.by = { kind: 'player', userId: null, name: null }; }
    }
    for (const k of db.regulatoryConsents) {
      if (!k || k.subject?.kind !== 'player' || k.subject.id !== playerId) continue;
      if (k.grantedBy?.kind === 'player') k.grantedBy = { kind: 'player', userId: null, name: null };
      if (k.declinedBy?.kind === 'player') k.declinedBy = { kind: 'player', userId: null, name: null };
      if (k.by?.kind === 'player') k.by = { kind: 'player', userId: null, name: null };
      for (const h of k.history ?? []) if (h?.by?.kind === 'player') h.by = { kind: 'player', userId: null, name: null };
    }
  }
  function evaluateAndRecord(c, by, { proposed = null, record = true } = {}) {
    const result = evaluateConflict(engineInput(c, { proposed }));
    if (record) {
      c.evaluations ??= [];
      c.evaluations.push({ ...result, snapshotOf: { parties: c.parties.map((p) => ({ partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId })), representations: c.representations.map((r) => ({ agentUserId: r.agentUserId, partyRole: r.partyRole, status: r.status })), proposed: proposed ? { partyRole: proposed.partyRole, agentUserId: proposed.agentUserId } : null }, ruleStatuses: Object.fromEntries(result.reasons.filter((r) => r.ruleId).map((r) => [r.ruleId, r.ruleStatus])) });
      c.reEvaluationPending = false;
      hist(c, 'compliance_context_evaluated', by, { outcome: result.outcome, reasonCodes: [...new Set(result.reasons.map((r) => r.code))], policyVersions: result.policyVersions });
      broadcast('conflict_evaluated', { orgId: c.agencyOrgId, ctxId: c.id, outcome: result.outcome });
    }
    return result;
  }

  /** Steps 1–6 for an agent acting on a context of their own. Conceals foreign contexts. */
  function ownContext(req, res, id, { write = false } = {}) {
    if (!agent.resolveMembership(req, res)) return null;
    if (!agent.requireCap(req, res, write ? 'compliance.contexts.write' : 'compliance.read')) return null;
    const c = contextById(id);
    if (!c || c.agencyOrgId !== req.org.id || c.agentUserId !== req.orgUser.id) { sendComplianceError(res, { error: 'CONTEXT_NOT_FOUND' }, 'context'); return null; }
    return c;
  }
  const resolveParty = (req, res, raw) => {
    const partyRole = String(raw?.partyRole ?? '');
    const subjectKind = String(raw?.subjectKind ?? '');
    const subjectId = String(raw?.subjectId ?? '');
    if (!PARTY_ROLES.includes(partyRole) || !['player', 'club'].includes(subjectKind) || !subjectId) { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'Each party needs partyRole (individual | engaging_entity | releasing_entity), subjectKind (player | club) and subjectId.' }, 'party'); return null; }
    if (subjectKind === 'player') {
      if (partyRole !== 'individual') { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'A player is the individual party.' }, 'party'); return null; }
      const pl = findPlayer(subjectId);
      // Uniform concealment: does not exist, minor, invisible and blocked answer alike (never reveals a hidden minor).
      if (!pl || !isAdult(pl) || !visibleToOrg(pl, req.org) || isBlocked(pl.id, req.org.id)) { sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'party'); return null; }
      return { id: nextId('cpt'), partyRole, subjectKind, subjectId: pl.id, addedAt: now(), removed: false };
    }
    if (partyRole === 'individual') { sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'parties', message: 'A club is an engaging or releasing entity.' }, 'party'); return null; }
    const org = db.orgs.find((o) => o.id === subjectId && o.type === 'club');
    if (!org) { sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'party'); return null; }
    return { id: nextId('cpt'), partyRole, subjectKind, subjectId: org.id, addedAt: now(), removed: false };
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
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'compliance.read')) return;
    res.json({ items: db.complianceContexts.filter((c) => c && c.agencyOrgId === req.org.id && c.agentUserId === req.orgUser.id).map(contextForAgent), types: CONTEXT_TYPES, partyRoles: PARTY_ROLES });
  });
  orgRouter.post('/agent/compliance/contexts', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'compliance.contexts.write')) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const type = String(b.type ?? '');
    if (!CONTEXT_TYPES.includes(type)) return sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'type', allowed: CONTEXT_TYPES }, 'contexts');
    const jurisdictions = Array.isArray(b.jurisdictions) ? [...new Set(b.jurisdictions.map((j) => String(j).toUpperCase()))] : [];
    if (!jurisdictions.length || jurisdictions.some((j) => !/^[A-Z]{3}$/.test(j))) return sendComplianceError(res, { error: 'CONTEXT_INPUT_INVALID', field: 'jurisdictions', message: 'jurisdictions must be a non-empty list of three-letter member-association codes (INT for FIFA level).' }, 'contexts');
    const fp = payloadFingerprint({ type, jurisdictions, parties: Array.isArray(b.parties) ? b.parties : [] });
    if (key) {
      const hit = db.complianceContexts.find((c) => c && c.agencyOrgId === req.org.id && c.agentUserId === req.orgUser.id && c.keys?.create?.key === key);
      if (hit) { if (hit.keys.create.fp === fp) return res.json({ context: contextForAgent(hit), idempotent: true }); return sendComplianceError(res, { error: 'CONTEXT_IDEMPOTENCY_CONFLICT' }, 'contexts'); }
    }
    const p = profileOf(req.orgUser.id);
    if (!p) return sendComplianceError(res, { error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent profile first.' }, 'contexts');
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    if (!facetGate(req, res, p, jurisdictions)) return;
    const parties = [];
    for (const raw of Array.isArray(b.parties) ? b.parties.slice(0, 6) : []) {
      const party = resolveParty(req, res, raw); if (!party) return;
      if (parties.some((x) => x.partyRole === party.partyRole)) return sendComplianceError(res, { error: 'CONTEXT_PARTY_EXISTS', message: `A ${party.partyRole} party is already named.` }, 'contexts');
      parties.push(party);
    }
    const c = {
      id: nextId('ctx'), agencyOrgId: req.org.id, agentUserId: req.orgUser.id, type, jurisdictions, parties, representations: [],
      otherServices: [], interests: [], resolvedFacts: [], evaluations: [], reEvaluationPending: false, status: 'open',
      openedAt: now(), closedAt: null, keys: key ? { create: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(c, 'compliance_context_opened', byOrg(req), { type, policyVersions: policySetFor(jurisdictions).policies.map((x) => x.id) });
    db.complianceContexts.push(c);
    evaluateAndRecord(c, byOrg(req));
    persistNow();
    res.status(201).json({ context: contextForAgent(c) });
  });
  orgRouter.get('/agent/compliance/contexts/:id', (req, res) => {
    const c = ownContext(req, res, req.params.id); if (!c) return;
    res.json({ context: contextForAgent(c) });
  });
  orgRouter.post('/agent/compliance/contexts/:id/evaluate', (req, res) => {
    const c = ownContext(req, res, req.params.id); if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'evaluate');
    const result = evaluateAndRecord(c, byOrg(req));
    bumpRev(c, { by: req.orgUser, at: now() }); persistNow();
    res.json({ context: contextForAgent(c), evaluation: result });
  });
  orgRouter.post('/agent/compliance/contexts/:id/parties', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'parties');
    if (limitedOr429(res, 'compliance_context_write', req.orgUser.id)) return;
    const party = resolveParty(req, res, req.body); if (!party) return;
    if (c.parties.some((x) => x.partyRole === party.partyRole && !x.removed)) return sendComplianceError(res, { error: 'CONTEXT_PARTY_EXISTS' }, 'parties');
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    c.parties.push(party);
    hist(c, 'compliance_context_party_added', byOrg(req), { partyRole: party.partyRole, kind: party.subjectKind });
    // A party change invalidates every prior check (mandate §44): re-evaluate now.
    const result = evaluateAndRecord(c, byOrg(req));
    bumpRev(c, { by: req.orgUser, at: now() }); persistNow();
    res.status(201).json({ context: contextForAgent(c), evaluation: result });
  });

  /**
   * THE regulated mutation of P5.6C: the agent records that they perform
   * Football Agent Services for a party in this context. Full pipeline, at
   * mutation time, every time.
   */
  orgRouter.post('/agent/compliance/contexts/:id/representations', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'representations');
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const partyRole = String(b.partyRole ?? '');
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
      agreement = (db.representationAgreements ?? []).find((a) => a && a.id === String(b.agreementId ?? '') && a.agentUserId === req.orgUser.id && a.agencyOrgId === req.org.id && a.clientId === party.subjectId) ?? null;
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
    const result = evaluateAndRecord(c, byOrg(req), { proposed });
    if (result.outcome === 'PROHIBITED_CONFLICT') { bumpRev(c, { by: req.orgUser, at: now() }); persistNow(); return sendComplianceError(res, { error: 'REPRESENTATION_CONFLICT', reasons: result.reasons.filter((r) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED', 'CONNECTED_AGENT_ATTRIBUTION'].includes(r.code)), policyVersions: result.policyVersions, outcome: result.outcome, message: 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.' }, 'representations'); }
    if (result.outcome === PERMITTED_WITH_CONSENT) { bumpRev(c, { by: req.orgUser, at: now() }); persistNow(); return sendComplianceError(res, { error: 'CONSENT_REQUIRED', consentsOutstanding: result.consentsOutstanding, reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'), policyVersions: result.policyVersions, outcome: result.outcome, contextId: c.id, message: 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.' }, 'representations'); }
    if (result.outcome === 'INSUFFICIENT_DATA' && !declaredOnly) { bumpRev(c, { by: req.orgUser, at: now() }); persistNow(); return sendComplianceError(res, { error: 'COMPLIANCE_INSUFFICIENT_DATA', reasons: result.reasons.filter((r) => result.missingEvidence.includes(r.code)), policyVersions: result.policyVersions, outcome: result.outcome, message: 'A fact the evaluation needs is missing. Nothing was recorded.' }, 'representations'); }
    // 15 manual review.
    if (result.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' || result.outcome === 'INSUFFICIENT_DATA') {
      if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
      let rep = null;
      if (declaredOnly) {
        rep = { id: nextId('crp'), agentUserId: req.orgUser.id, partyRole, agreementId: null, status: 'pending_review', declaredOnly: true, reviewId: null, declaredAt: now(), firstActAt: null, keys: key ? { declare: { key, fp } } : {} };
        c.representations.push(rep);
        hist(c, 'compliance_representation_declared', byOrg(req), { partyRole, status: 'pending_review' });
      }
      const kind = declaredOnly ? 'representation_declared' : 'conflict_evaluation';
      const review = createReview({ kind, agencyOrgId: c.agencyOrgId, agentUserId: req.orgUser.id, subject: { contextId: c.id, representationId: rep?.id ?? null, partyRole }, reasons: result.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: result.policyVersions, snapshot: { ...result, proposed: { partyRole, agentUserId: req.orgUser.id } }, requestedBy: byOrg(req) });
      if (rep) rep.reviewId = review.id;
      bumpRev(c, { by: req.orgUser, at: now() }); persistNow();
      return sendComplianceError(res, { error: 'REGULATORY_REVIEW_REQUIRED', reviewId: review.id, contextId: c.id, reasons: review.reasons, policyVersions: result.policyVersions, outcome: result.outcome, message: declaredOnly ? 'Representation of an entity without a ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.' : 'The deciding rule\'s operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.' }, 'representations');
    }
    // 16 rev; 17 mutate; 18 audit + event.
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    const rep = { id: nextId('crp'), agentUserId: req.orgUser.id, partyRole, agreementId: agreement?.id ?? null, status: 'verified', declaredOnly: false, reviewId: null, declaredAt: now(), firstActAt: now(), keys: key ? { declare: { key, fp } } : {} };
    c.representations.push(rep);
    hist(c, 'compliance_representation_declared', byOrg(req), { partyRole, status: 'verified', outcome: result.outcome, policyVersions: result.policyVersions });
    bumpRev(c, { by: req.orgUser, at: now() }); persistNow();
    res.status(201).json({ context: contextForAgent(c), representation: { id: rep.id, partyRole, status: rep.status }, evaluation: result });
  });
  orgRouter.post('/agent/compliance/contexts/:id/representations/:repId/withdraw', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    const rep = c.representations.find((r) => r.id === req.params.repId && r.agentUserId === req.orgUser.id);
    if (!rep) return sendComplianceError(res, { error: 'CONTEXT_NOT_FOUND' }, 'withdraw');
    if (rep.status === 'withdrawn') return res.json({ context: contextForAgent(c), idempotent: true });
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    rep.status = 'withdrawn'; rep.withdrawnAt = now();
    hist(c, 'compliance_representation_withdrawn', byOrg(req), { partyRole: rep.partyRole });
    const result = evaluateAndRecord(c, byOrg(req));
    bumpRev(c, { by: req.orgUser, at: now() }); persistNow();
    res.json({ context: contextForAgent(c), evaluation: result });
  });
  orgRouter.post('/agent/compliance/contexts/:id/close', (req, res) => {
    const c = ownContext(req, res, req.params.id, { write: true }); if (!c) return;
    if (c.status === 'closed') return res.json({ context: contextForAgent(c), idempotent: true });
    if (!guardRev(req, res, c, { errorCode: 'CONTEXT_VERSION_CONFLICT', current: {} })) return;
    c.status = 'closed'; c.closedAt = now();
    hist(c, 'compliance_context_closed', byOrg(req));
    for (const r of db.regulatoryReviews) if (r && r.subject?.contextId === c.id && (r.status === 'PENDING' || r.status === 'IN_REVIEW')) { r.status = 'CANCELLED'; r.decidedAt = now(); hist(r, 'regulatory_review_cancelled', byOrg(req), { reasonCode: 'context_closed' }); bumpRev(r, { by: req.orgUser, at: now() }); }
    bumpRev(c, { by: req.orgUser, at: now() }); persistNow();
    res.json({ context: contextForAgent(c) });
  });

  // ============================================================ consents
  const consentById = (id) => db.regulatoryConsents.find((k) => k && k.id === id && k.kind !== 'revocation') ?? null;
  const consentForParty = (k) => {
    const c = contextById(k.contextId);
    const ag = profileOf(k.agentUserId);
    const org = db.orgs.find((o) => o.id === k.agencyOrgId);
    return {
      id: k.id, kind: k.kind, status: consentStatusOf(k), partyRole: k.partyRole,
      agent: { userId: k.agentUserId, displayName: ag?.displayName ?? null, agency: org?.name ?? null, licence: ag ? facetStatesOf(ag).fifa_licence : 'UNVERIFIED' },
      context: c ? { id: c.id, type: c.type, jurisdictions: c.jurisdictions, parties: c.parties.filter((p) => !p.removed).map((p) => ({ partyRole: p.partyRole, subjectKind: p.subjectKind, name: p.subjectKind === 'club' ? (db.orgs.find((o) => o.id === p.subjectId)?.name ?? null) : (p.subjectId === k.subject?.id ? 'You' : null) })) } : null,
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
   * Extracted from the route body so the P5.6D transaction workspace requests a
   * consent through EXACTLY this code (its own route resolves the transaction
   * and hands over the linked context). A second implementation would be a
   * second set of rules about when a consent may exist, which is the one thing
   * a consent ledger must not have.
   */
  function requestDualRepresentationConsent(req, res, c) {
    if (c.status !== 'open') return sendComplianceError(res, { error: 'CONTEXT_CLOSED' }, 'consents');
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const partyRole = String(b.partyRole ?? '');
    const party = c.parties.find((x) => x.partyRole === partyRole && !x.removed);
    if (!party) return sendComplianceError(res, { error: 'PARTY_NOT_FOUND' }, 'consents');
    const fp = payloadFingerprint({ partyRole });
    if (key) {
      const hit = db.regulatoryConsents.find((k) => k && k.kind === 'dual_representation' && k.contextId === c.id && k.agentUserId === req.orgUser.id && k.keys?.request?.key === key);
      if (hit) { if (hit.keys.request.fp === fp) return res.json({ consent: consentForAgent(hit), idempotent: true }); return sendComplianceError(res, { error: 'CONSENT_IDEMPOTENCY_CONFLICT' }, 'consents'); }
    }
    if (limitedOr429(res, 'compliance_consent_request', req.orgUser.id)) return;
    const p = profileOf(req.orgUser.id);
    if (!p || !facetGate(req, res, p, c.jurisdictions)) return;
    // Consent exists only where an ACTIVE encoded rule makes it the permitted route (no generic bypass, mandate §38).
    const set = policySetFor(c.jurisdictions);
    const { scope, memberAssociations } = resolveScope(c.jurisdictions);
    const nationalPolicy = scope === 'national' ? set.policies.find((x) => x.jurisdiction === memberAssociations[0]) : null;
    const ruleId = nationalPolicy ? Object.keys(nationalPolicy.rules).find((id) => nationalPolicy.rules[id]?.params?.consentKind === 'dual_representation') ?? null : 'FIFA-12.8';
    const rule = ruleId ? ruleAt(set.policies, ruleId, now()) : { ruleId: null, status: 'UNKNOWN', policy: null };
    if (rule.status !== 'ACTIVE') return sendComplianceError(res, { error: 'REGULATORY_REVIEW_REQUIRED', reasons: [{ code: rule.status === 'UNKNOWN' ? 'POLICY_NOT_ENCODED' : 'RULE_STATUS_UNCERTAIN', ruleId: rule.ruleId, ruleStatus: rule.status, policyVersion: rule.policy?.id ?? null }], policyVersions: set.policies.map((x) => x.id), message: 'Consent can only be requested under an ACTIVE encoded rule. The deciding rule\'s status is uncertain or not encoded; consent would not cure that.' }, 'consents');
    const existing = db.regulatoryConsents.find((k) => k && k.kind === 'dual_representation' && k.contextId === c.id && k.agentUserId === req.orgUser.id && k.partyRole === partyRole && (consentStatusOf(k) === 'requested' || consentStatusOf(k) === 'granted'));
    if (existing) return sendComplianceError(res, { error: 'CONSENT_ALREADY_REQUESTED', status: consentStatusOf(existing) }, 'consents');
    const k = {
      id: nextId('rcs'), kind: 'dual_representation', contextId: c.id, agentUserId: req.orgUser.id, agencyOrgId: c.agencyOrgId, partyRole,
      subject: { kind: party.subjectKind, id: party.subjectId }, regarding: c.parties.filter((x) => !x.removed && x.partyRole !== partyRole).map((x) => x.partyRole),
      status: 'requested', requestedAt: now(), requestedBy: byOrg(req), grantedAt: null, grantedBy: null, declinedAt: null,
      particulars: { fullParticularsProvided: !!b.fullParticularsProvided, legalAdviceOffered: !!b.legalAdviceOffered, proposedFeeDisclosed: !!b.proposedFeeDisclosed, acknowledged: null },
      policyVersions: set.policies.map((x) => x.id), ruleIds: [rule.ruleId], keys: key ? { request: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(k, 'regulatory_consent_requested', byOrg(req), { partyRole, kind: k.kind, policyVersions: k.policyVersions });
    db.regulatoryConsents.push(k);
    broadcast('regulatory_consent_requested', { orgId: c.agencyOrgId, consentId: k.id, ctxId: c.id });
    const agentName = p.displayName ?? req.orgUser.name;
    if (party.subjectKind === 'player') notify({ kind: 'player', id: party.subjectId }, 'regulatory_consent_requested', `${agentName} (${req.org.name}) asks your written consent to also act for another party in a ${c.type.replace(/_/g, ' ')} involving you. You may decline. Nothing changes until you answer.`, k.id);
    else for (const u of (db.verAdmins ?? []).filter((a) => a.orgId === party.subjectId && a.status === 'active')) notify({ kind: 'org_user', id: u.userId }, 'regulatory_consent_requested', `${agentName} (${req.org.name}) asks your club's written consent to act for more than one party in a ${c.type.replace(/_/g, ' ')}. Only a recorded signatory may answer.`, k.id);
    persistNow();
    res.status(201).json({ consent: consentForAgent(k) });
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
    if (action === 'revoke') {
      if (st !== 'granted') return sendComplianceError(res, { error: 'CONSENT_NOT_PENDING', status: st, message: 'Only a granted consent can be revoked.' }, action);
      if (!guardRev(req, res, k, { errorCode: 'CONSENT_VERSION_CONFLICT', current: { status: st } })) return;
      // Append-only: the revocation is a NEW row; the granted row is never edited.
      const rv = { id: nextId('rcs'), kind: 'revocation', of: k.id, contextId: k.contextId, agentUserId: k.agentUserId, agencyOrgId: k.agencyOrgId, partyRole: k.partyRole, subject: k.subject, at: now(), by, history: [] };
      hist(rv, 'regulatory_consent_revoked', by, { consentId: k.id, partyRole: k.partyRole });
      db.regulatoryConsents.push(rv);
      k.keys ??= {}; if (key) k.keys[action] = { key, fp };
      hist(k, 'regulatory_consent_revoked', by, { consentId: k.id, partyRole: k.partyRole });
      bumpRev(k, { by: { id: by.userId, name: by.name }, at: now() });
      const c = contextById(k.contextId);
      if (c && c.status === 'open') evaluateAndRecord(c, by);
      broadcast('regulatory_consent_revoked', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
      notify({ kind: 'org_user', id: k.agentUserId }, 'regulatory_consent_revoked', 'A party revoked their consent to multiple representation. Any future regulated action that needs it will be refused; the record of what happened before stays.', k.id);
      persistNow();
      return res.json({ consent: consentForParty(k) });
    }
    if (st !== 'requested') return sendComplianceError(res, { error: 'CONSENT_NOT_PENDING', status: st }, action);
    if (!guardRev(req, res, k, { errorCode: 'CONSENT_VERSION_CONFLICT', current: { status: st } })) return;
    if (action === 'grant') {
      const ackP = !!req.body?.acknowledgedParticulars; const ackL = !!req.body?.acknowledgedLegalAdvice;
      if (!ackP || !ackL) return sendComplianceError(res, { error: 'CONSENT_INPUT_INVALID', field: !ackP ? 'acknowledgedParticulars' : 'acknowledgedLegalAdvice', message: 'To grant, confirm you received the full particulars and were told you may take independent legal advice.' }, action);
      k.status = 'granted'; k.grantedAt = now(); // server clock; never a client timestamp
      k.grantedBy = { ...by, ...(authority.signatory !== undefined ? { signatory: authority.signatory } : {}) };
      k.particulars = { ...(k.particulars ?? {}), acknowledged: { particulars: true, legalAdvice: true, at: now() } };
      hist(k, 'regulatory_consent_granted', by, { partyRole: k.partyRole, policyVersions: k.policyVersions });
    } else {
      k.status = 'declined'; k.declinedAt = now(); k.declinedBy = by;
      hist(k, 'regulatory_consent_declined', by, { partyRole: k.partyRole });
    }
    k.keys ??= {}; if (key) k.keys[action] = { key, fp };
    bumpRev(k, { by: { id: by.userId, name: by.name }, at: now() });
    const c = contextById(k.contextId);
    if (c && c.status === 'open') evaluateAndRecord(c, by);
    // Literal event names: the M18.2 registry audit reads call sites textually.
    if (action === 'grant') broadcast('regulatory_consent_granted', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
    else broadcast('regulatory_consent_declined', { orgId: k.agencyOrgId, consentId: k.id, ctxId: k.contextId });
    notify({ kind: 'org_user', id: k.agentUserId }, action === 'grant' ? 'regulatory_consent_granted' : 'regulatory_consent_declined', action === 'grant' ? 'A party granted written consent to multiple representation for one transaction context. It is specific to that context and can be revoked.' : 'A party declined consent to multiple representation. You may continue to act for your first party only.', k.id);
    persistNow();
    res.json({ consent: consentForParty(k) });
  }
  // Player lane.
  playerRouter.get('/agent/consents', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true, note: 'Agent representation and its consents are not available for under-18 accounts in ScoutBox.' });
    res.json({ items: db.regulatoryConsents.filter((k) => k && k.kind === 'dual_representation' && k.subject?.kind === 'player' && k.subject.id === req.player.id).map(consentForParty) });
  });
  const playerWho = (req) => (k) => {
    if (req.playerIsMinor) return { ok: false, error: 'COMPLIANCE_ACTION_NOT_PERMITTED', message: 'Guardian-managed accounts cannot answer agent consents in ScoutBox.' };
    if (k.subject?.kind !== 'player' || k.subject.id !== req.player.id) return { ok: false, error: 'CONSENT_NOT_FOUND' };
    return { ok: true };
  };
  for (const action of ['grant', 'decline', 'revoke']) {
    playerRouter.post(`/agent/consents/:id/${action}`, (req, res) => consentAnswer(req, res, { action, who: playerWho(req), by: byPlayer(req), rateKey: req.player.id }));
  }
  // Club lane: only a club user with M14 verification authority (the recorded signatory) may bind the club (DR-19).
  const clubWho = (req) => (k) => {
    if (req.org.type !== 'club') return { ok: false, error: 'CONSENT_NOT_FOUND' };
    if (k.subject?.kind !== 'club' || k.subject.id !== req.org.id) return { ok: false, error: 'CONSENT_NOT_FOUND' };
    if (!hasVerLevel(db, req.org.id, req.orgUser.id, 'verification_admin')) return { ok: false, error: 'SIGNATORY_REQUIRED', message: 'Only a recorded club signatory (a verification administrator) may answer for the club.' };
    return { ok: true, signatory: true };
  };
  orgRouter.get('/compliance/consents', (req, res) => {
    if (req.org.type !== 'club') return sendComplianceError(res, { error: 'COMPLIANCE_ACTION_NOT_PERMITTED' }, 'consents');
    res.json({ items: db.regulatoryConsents.filter((k) => k && k.kind === 'dual_representation' && k.subject?.kind === 'club' && k.subject.id === req.org.id).map(consentForParty), signatory: hasVerLevel(db, req.org.id, req.orgUser.id, 'verification_admin') });
  });
  for (const action of ['grant', 'decline', 'revoke']) {
    orgRouter.post(`/compliance/consents/:id/${action}`, (req, res) => consentAnswer(req, res, { action, who: clubWho(req), by: byClubUser(req), rateKey: req.orgUser.id }));
  }

  // ============================================================ reviews — the attributed lane
  const reviewById = (id) => db.regulatoryReviews.find((r) => r && r.id === id) ?? null;
  tsRouter.get('/compliance/reviews', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const items = db.regulatoryReviews.filter((r) => r && (!status || r.status === status)).sort((a, b) => (a.requestedAt - b.requestedAt)).map((r) => reviewPublic(r, { forReviewer: true }));
    res.json({ items, statuses: REVIEW_STATUSES, kinds: REVIEW_KINDS, reviewer: publicReviewer(req.reviewer) });
  });
  tsRouter.get('/compliance/reviews/:id', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'review');
    res.json({ review: reviewPublic(r, { forReviewer: true }), subjectDetail: reviewSubjectDetail(r) });
  });
  /** What a reviewer may see of the subject: states and ids, no client data beyond the review's need (mandate §62). */
  function reviewSubjectDetail(r) {
    if (r.kind === 'verification_facet') { const p = (db.agentProfiles ?? []).find((x) => x.id === r.subject.profileId); const rec = p ? facetRecord(p, r.subject.facet, r.subject.memberAssociation) : null; return { agentDisplayName: p?.displayName ?? null, facet: r.subject.facet, memberAssociation: r.subject.memberAssociation, reference: rec?.reference ?? null, state: rec ? effectiveFacetState(rec, now()) : null, submittedAt: rec?.submittedAt ?? null }; }
    if (r.kind === 'representation_dispute') { const a = (db.representationAgreements ?? []).find((x) => x.id === r.subject.agreementId); return a ? { agreementId: a.id, status: effectiveAgreementStatus(a, now()), disputedAt: a.disputedAt ?? null, hadReason: !!a.disputeReason, scope: a.scope, jurisdiction: a.jurisdiction ?? null } : null; }
    const c = contextById(r.subject?.contextId);
    return c ? { contextId: c.id, type: c.type, jurisdictions: c.jurisdictions, partyRoles: c.parties.filter((p) => !p.removed).map((p) => p.partyRole), representations: c.representations.map((x) => ({ partyRole: x.partyRole, status: x.status })), lastOutcome: lastEvaluation(c)?.outcome ?? null } : null;
  }
  tsRouter.post('/compliance/reviews/:id/start', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'start');
    if (r.status === 'IN_REVIEW' && r.startedBy?.id === req.reviewer.id) return res.json({ review: reviewPublic(r, { forReviewer: true }), idempotent: true });
    if (r.status !== 'PENDING') return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'start');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    r.status = 'IN_REVIEW'; r.startedAt = now(); r.startedBy = { id: req.reviewer.id, name: req.reviewer.name, role: req.reviewer.role };
    hist(r, 'regulatory_review_started', byReviewer(req), { rev: r.rev });
    bumpRev(r, { by: req.reviewer, at: now() });
    broadcast('regulatory_review_started', { orgId: r.agencyOrgId, reviewId: r.id });
    persistNow();
    res.json({ review: reviewPublic(r, { forReviewer: true }) });
  });
  tsRouter.post('/compliance/reviews/:id/resolve', (req, res) => {
    if (limitedOr429(res, 'ts_review_decision', req.reviewer.id)) return;
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'resolve');
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const outcome = String(b.outcome ?? '');
    const reasonCode = String(b.reasonCode ?? '').trim().slice(0, 60);
    const reason = String(b.reason ?? '').trim().slice(0, 1000);
    const evidenceRefs = Array.isArray(b.evidenceRefs) ? b.evidenceRefs.map((e) => String(e).trim().slice(0, 200)).filter(Boolean).slice(0, 10) : [];
    const fp = payloadFingerprint({ outcome, reasonCode, reason, evidenceRefs });
    if (key && r.keys?.resolve?.key === key) { if (r.keys.resolve.fp === fp) return res.json({ review: reviewPublic(r, { forReviewer: true }), idempotent: true }); return sendComplianceError(res, { error: 'REVIEW_IDEMPOTENCY_CONFLICT' }, 'resolve'); }
    if (!['APPROVED', 'REJECTED'].includes(outcome)) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'outcome', allowed: ['APPROVED', 'REJECTED'] }, 'resolve');
    if (!reasonCode || !reason) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: !reasonCode ? 'reasonCode' : 'reason', message: 'A reason code and a written reason are required.' }, 'resolve');
    if (outcome === 'APPROVED' && !evidenceRefs.length) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'evidenceRefs', message: 'An approval must cite at least one evidence reference.' }, 'resolve');
    if (r.status !== 'PENDING' && r.status !== 'IN_REVIEW') return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'resolve');
    // Override limits (mandate §37): a reviewer resolves missing or uncertain FACTS; a reviewer never rewrites active policy.
    if (outcome === 'APPROVED') {
      if (r.snapshot?.outcome === 'PROHIBITED_CONFLICT' || (r.reasons ?? []).some((x) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED'].includes(x.code))) return sendComplianceError(res, { error: 'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE', message: 'An objectively prohibited combination under an ACTIVE rule cannot be approved by review.' }, 'resolve');
      if (r.kind === 'conflict_evaluation' && (r.reasons ?? []).some((x) => POLICY_LEVEL_REASONS.includes(x.code))) return sendComplianceError(res, { error: 'REVIEW_REQUIRES_POLICY_VERSION', reasons: r.reasons.filter((x) => POLICY_LEVEL_REASONS.includes(x.code)), message: 'The deciding rule\'s status is uncertain or not encoded. Only a published policy version (dual control) can settle that; a review cannot approve past it. It may be rejected (the workflow does not proceed) or left pending.' }, 'resolve');
    }
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const priorState = { status: r.status, ...reviewEffectState(r) };
    const decision = { reviewerId: req.reviewer.id, reviewerName: req.reviewer.name, reviewerRole: req.reviewer.role, outcome, reasonCode, reason, evidenceRefs, policyVersions: r.policyVersions ?? [], at: now(), priorState, resultingState: null };
    // Apply the platform effect of the decision.
    const resulting = applyReviewDecision(r, outcome, req);
    decision.resultingState = resulting;
    r.status = outcome; r.decidedAt = now(); r.decision = decision;
    r.keys ??= {}; if (key) r.keys.resolve = { key, fp };
    hist(r, 'regulatory_review_resolved', byReviewer(req), { outcome, reasonCode, evidenceRefs, evidenceCount: evidenceRefs.length, policyVersions: decision.policyVersions, priorState, resultingState: resulting, rev: r.rev });
    bumpRev(r, { by: req.reviewer, at: now() });
    broadcast('regulatory_review_resolved', { orgId: r.agencyOrgId, reviewId: r.id, outcome });
    if (r.agentUserId) notify({ kind: 'org_user', id: r.agentUserId }, 'regulatory_review_completed', `Attributed Trust & Safety review ${outcome === 'APPROVED' ? 'approved' : 'did not approve'} a ${r.kind.replace(/_/g, ' ')} item under ScoutBox policy. This is a platform decision, not a legal determination.`, r.id);
    persistNow();
    res.json({ review: reviewPublic(r, { forReviewer: true }) });
  });
  function reviewEffectState(r) {
    if (r.kind === 'verification_facet') { const p = (db.agentProfiles ?? []).find((x) => x.id === r.subject.profileId); const rec = p ? facetRecord(p, r.subject.facet, r.subject.memberAssociation) : null; return { facetState: rec ? effectiveFacetState(rec, now()) : null }; }
    if (r.kind === 'representation_dispute') { const a = (db.representationAgreements ?? []).find((x) => x.id === r.subject.agreementId); return { agreementStatus: a ? effectiveAgreementStatus(a, now()) : null }; }
    const c = contextById(r.subject?.contextId); const rep = c?.representations.find((x) => x.id === r.subject?.representationId);
    return { contextOutcome: c ? lastEvaluation(c)?.outcome ?? null : null, representationStatus: rep?.status ?? null };
  }
  function applyReviewDecision(r, outcome, req) {
    const by = byReviewer(req);
    if (r.kind === 'verification_facet') {
      const p = (db.agentProfiles ?? []).find((x) => x.id === r.subject.profileId);
      if (!p) return { facetState: null, note: 'profile gone' };
      const cur = facetRecord(p, r.subject.facet, r.subject.memberAssociation) ?? { reference: null };
      const prev = effectiveFacetState(cur, now());
      const next = outcome === 'APPROVED'
        ? { ...cur, state: 'VERIFIED', verifiedAt: now(), recheckAt: now() + RECHECK_MS, provenance: { provider: 'attributed_review', kind: 'human_review', reviewerId: req.reviewer.id, reviewId: r.id, at: now() }, note: 'Verified by attributed Trust & Safety review against the cited evidence. Re-check due in 30 days.', staleNotifiedAt: null }
        : { ...cur, state: 'UNVERIFIED', verifiedAt: null, recheckAt: null, provenance: { provider: 'attributed_review', kind: 'human_review', reviewerId: req.reviewer.id, reviewId: r.id, at: now() }, note: 'Attributed Trust & Safety review could not verify this reference.' };
      setFacet(p, r.subject.facet, r.subject.memberAssociation, next);
      hist(p, 'agent_verification_state_changed', by, { facet: r.subject.facet, memberAssociation: r.subject.memberAssociation, from: prev, to: next.state, state: next.state, reviewId: r.id });
      p.updatedAt = now(); bumpRev(p, { by: req.reviewer, at: now() });
      broadcast('agent_verification_state_changed', { orgId: p.agencyOrgId, userId: p.userId, facet: r.subject.facet, state: next.state });
      broadcast('agent_authorisation_state_changed', { orgId: p.agencyOrgId, userId: p.userId, state: next.state });
      return { facetState: next.state };
    }
    if (r.kind === 'representation_dispute') {
      const a = (db.representationAgreements ?? []).find((x) => x.id === r.subject.agreementId);
      if (!a || a.status !== 'disputed') return { agreementStatus: a ? effectiveAgreementStatus(a, now()) : null, note: 'not disputed any more' };
      if (outcome === 'APPROVED') {
        // Reinstate: the client's confirmation is unchanged; only the dispute suspension lifts. An expired term stays expired.
        a.status = 'active'; a.disputeResolvedAt = now(); a.disputeResolution = { reviewId: r.id, outcome: 'reinstated' };
        if (typeof a.endAt !== 'number' && a.confirmedAt) a.endAt = termEndAt(a.startAt ?? a.confirmedAt, a.termMonths ?? 12);
      } else {
        a.status = 'terminated_by_client'; a.terminatedAt = now(); a.terminatedBy = 'trust_safety'; a.terminationReasonCode = 'dispute_upheld'; a.disputeResolvedAt = now(); a.disputeResolution = { reviewId: r.id, outcome: 'ended' };
      }
      hist(a, outcome === 'APPROVED' ? 'representation_confirmed' : 'representation_terminated', by, { by: 'trust_safety', phase: 'disputed', reviewId: r.id, reasonCode: outcome === 'APPROVED' ? 'dispute_reinstated' : 'dispute_upheld' });
      bumpRev(a, { by: req.reviewer, at: now() });
      broadcast(outcome === 'APPROVED' ? 'representation_confirmed' : 'representation_terminated', { orgId: a.agencyOrgId, agreementId: a.id, agentUserId: a.agentUserId });
      notify({ kind: 'player', id: a.clientId }, 'representation_disputed', outcome === 'APPROVED' ? 'Attributed Trust & Safety review resolved your dispute: the relationship record is reinstated. You can still end it at any time.' : 'Attributed Trust & Safety review resolved your dispute: the relationship record has been ended.', a.id);
      if (a.agentUserId) notify({ kind: 'org_user', id: a.agentUserId }, 'representation_disputed', outcome === 'APPROVED' ? 'A disputed relationship was reinstated by attributed review.' : 'A disputed relationship was ended by attributed review.', a.id);
      return { agreementStatus: effectiveAgreementStatus(a, now()) };
    }
    const c = contextById(r.subject?.contextId);
    if (!c) return { contextOutcome: null, note: 'context gone' };
    if (r.kind === 'representation_declared') {
      // P5.6D: when the declaration belongs to a transaction, the
      // `transactionRepresentations` row is the TRUTH and the context's array is
      // its evaluation projection — so the reviewer's decision must land on the
      // row, not only on the projection. The hook is filled in by m26 at
      // registration; absent (P5.6C-only builds) nothing changes.
      if (r.subject?.transactionId && transactionHooks.representationReviewed) {
        transactionHooks.representationReviewed({ transactionId: r.subject.transactionId, representationId: r.subject.representationId, outcome, by, reviewId: r.id });
      }
      const rep = c.representations.find((x) => x.id === r.subject.representationId);
      if (rep && rep.status === 'pending_review') {
        rep.status = outcome === 'APPROVED' ? 'verified' : 'withdrawn';
        // A review-verified declaration records no act by the agent: firstActAt stays null until
        // the agent themselves acts, so a later party-specific consent is still "in advance".
        if (outcome === 'APPROVED') { rep.declaredOnly = false; rep.verifiedByReviewId = r.id; rep.verifiedAt = now(); } else rep.withdrawnAt = now();
        hist(c, outcome === 'APPROVED' ? 'compliance_representation_verified' : 'compliance_representation_withdrawn', by, { partyRole: rep.partyRole, reviewId: r.id });
      }
    } else if (r.kind === 'conflict_evaluation') {
      if (outcome === 'APPROVED') { c.resolvedFacts = [...new Set([...(c.resolvedFacts ?? []), ...(r.reasons ?? []).map((x) => x.code).filter((code) => ['OTHER_SERVICES_PRESUMPTION', 'INTEREST_DECLARED', 'REPRESENTATION_UNVERIFIED'].includes(code))])]; }
      else c.reviewRejectedAt = now();
      hist(c, 'compliance_context_evaluated', by, { reviewId: r.id, outcome: outcome === 'APPROVED' ? 'review_approved' : 'review_rejected' });
    }
    if (c.status === 'open') evaluateAndRecord(c, by);
    bumpRev(c, { by: req.reviewer, at: now() });
    return { contextOutcome: lastEvaluation(c)?.outcome ?? null, representationStatus: c.representations.find((x) => x.id === r.subject?.representationId)?.status ?? null };
  }
  tsRouter.post('/compliance/reviews/:id/cancel', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'cancel');
    if (r.status !== 'PENDING' && r.status !== 'IN_REVIEW') return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status }, 'cancel');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 400);
    if (!reason) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'reason' }, 'cancel');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    r.status = 'CANCELLED'; r.decidedAt = now(); r.decision = { reviewerId: req.reviewer.id, reviewerName: req.reviewer.name, reviewerRole: req.reviewer.role, outcome: 'CANCELLED', reasonCode: 'cancelled', reason, evidenceRefs: [], policyVersions: r.policyVersions ?? [], at: now(), priorState: null, resultingState: null };
    hist(r, 'regulatory_review_cancelled', byReviewer(req), { outcome: 'CANCELLED', reasonCode: 'cancelled', rev: r.rev });
    bumpRev(r, { by: req.reviewer, at: now() }); persistNow();
    res.json({ review: reviewPublic(r, { forReviewer: true }) });
  });
  /** Reconsideration never rewrites a final decision: a new review supersedes it, with the old one retained (mandate §79). */
  tsRouter.post('/compliance/reviews/:id/supersede', (req, res) => {
    const r = reviewById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEW_NOT_FOUND' }, 'supersede');
    if (!['APPROVED', 'REJECTED'].includes(r.status)) return sendComplianceError(res, { error: 'REVIEW_NOT_PENDING', status: r.status, message: 'Only a decided review can be superseded.' }, 'supersede');
    if (r.supersededBy) return sendComplianceError(res, { error: 'REVIEW_ALREADY_EXISTS', reviewId: r.supersededBy }, 'supersede');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 400);
    if (!reason) return sendComplianceError(res, { error: 'REVIEW_INPUT_INVALID', field: 'reason' }, 'supersede');
    if (!guardRev(req, res, r, { errorCode: 'REVIEW_VERSION_CONFLICT', current: { status: r.status } })) return;
    const next = createReview({ kind: r.kind, agencyOrgId: r.agencyOrgId, agentUserId: r.agentUserId, subject: r.subject, reasons: r.reasons, policyVersions: policySetFor(r.subject?.memberAssociation ? [r.subject.memberAssociation] : (contextById(r.subject?.contextId)?.jurisdictions ?? [])).policies.map((p) => p.id), snapshot: r.snapshot, requestedBy: byReviewer(req) });
    next.supersedes = r.id;
    hist(next, 'regulatory_review_requested', byReviewer(req), { reasonCode: 'supersedes', reviewId: r.id });
    const priorStatus = r.status;
    r.status = 'SUPERSEDED'; r.supersededBy = next.id; // the decision object is retained untouched
    hist(r, 'regulatory_review_superseded', byReviewer(req), { reasonCode: 'superseded', reviewId: next.id, priorState: { status: priorStatus }, rev: r.rev });
    bumpRev(r, { by: req.reviewer, at: now() }); persistNow();
    res.status(201).json({ review: reviewPublic(next, { forReviewer: true }), superseded: reviewPublic(r, { forReviewer: true }) });
  });
  tsRouter.get('/compliance/audit', (req, res) => res.json({ items: reviewerDecisionRows(db).slice(0, 200), legacyNote: REVIEWER_LEGACY_NOTE }));
  /** Process metrics only (mandate §72): counts and durations; never a person, never a ranking. */
  tsRouter.get('/compliance/metrics', (_req, res) => {
    const reviews = db.regulatoryReviews.filter(Boolean);
    const decided = reviews.filter((r) => r.decidedAt && r.requestedAt);
    const outcomes = {};
    for (const c of db.complianceContexts) for (const e of c?.evaluations ?? []) outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    const consents = db.regulatoryConsents.filter((k) => k && k.kind === 'dual_representation');
    let stale = 0;
    for (const p of db.agentProfiles ?? []) { const s = facetStatesOf(p); if (s.fifa_licence === 'STALE') stale += 1; for (const f of ['national_registration', 'domestic_authorisation', 'minors_authorisation']) for (const v of Object.values(s[f])) if (v === 'STALE') stale += 1; }
    res.json({
      reviews: { byStatus: Object.fromEntries(REVIEW_STATUSES.map((s) => [s, reviews.filter((r) => r.status === s).length])), byKind: Object.fromEntries(REVIEW_KINDS.map((k) => [k, reviews.filter((r) => r.kind === k).length])), medianDurationMs: decided.length ? decided.map((r) => r.decidedAt - r.requestedAt).sort((a, b) => a - b)[Math.floor(decided.length / 2)] : null },
      conflictOutcomes: outcomes,
      consents: { requested: consents.length, granted: consents.filter((k) => consentStatusOf(k) === 'granted').length, declined: consents.filter((k) => consentStatusOf(k) === 'declined').length, revoked: consents.filter((k) => consentStatusOf(k) === 'revoked').length },
      staleFacets: stale,
      note: 'Process metrics only. No agent is ranked and no subscription or payment status enters any compliance outcome.',
    });
  });
  // The legacy shared key: read-only, non-authoritative.
  adminRouter.get('/compliance/reviews', (_req, res) => res.json({ items: db.regulatoryReviews.filter(Boolean).map((r) => reviewPublic(r)), readOnly: true, note: 'Read-only. Starting, resolving, cancelling or superseding a review requires an authenticated reviewer session (/ts). The shared key can adjudicate nothing.' }));

  /** Hook for m24's request route: an Approach whose deciding rule is uncertain records an attributed review item. */
  function createApproachReview({ req, decision, playerId, jurisdiction }) {
    return createReview({ kind: 'conflict_evaluation', agencyOrgId: req.org.id, agentUserId: req.orgUser.id, subject: { approach: true, playerId, jurisdiction }, reasons: decision.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: decision.policyVersions, snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', reasons: decision.reasons, policyVersions: decision.policyVersions, evaluatedAt: now() }, requestedBy: byOrg(req) });
  }

  // ============================================================ P5.6D seam
  /**
   * What the transaction workspace (m26) is allowed to do with the compliance
   * layer, and nothing more.
   *
   * The seam exists because a transaction must not own a second conflict
   * engine, a second consent ledger or a second policy resolver. A transaction
   * OWNS one `complianceContexts` row — the evaluation record P5.6C already
   * knows how to evaluate, flag on policy publication, tombstone on account
   * deletion and attach reviews to — and reads its verdict. The transaction is
   * the multi-party workspace; the context is the evaluation artifact. Neither
   * replaces the other and no fact lives in both as truth.
   *
   * The context stays PERSONAL to the agent who opened it: a club party never
   * reads it, because the frozen privacy matrix gives a club the outcome and
   * its reason codes (row 14), never the evaluation's internals. The
   * transaction's own projection is what a club sees.
   */
  /**
   * Filled in by m26 at registration. A P5.6C-only build leaves it empty and
   * every branch that consults it is a no-op, which is why it is an object with
   * null members rather than an optional import.
   */
  const transactionHooks = { representationReviewed: null };

  const transactionSeam = {
    hooks: transactionHooks,
    /** Open the evaluation context a transaction owns. `transactionId` is recorded for provenance in both directions. */
    openContext({ agencyOrgId, agentUserId, type, jurisdictions, transactionId, by }) {
      const c = {
        id: nextId('ctx'), agencyOrgId, agentUserId, type, jurisdictions, parties: [], representations: [],
        otherServices: [], interests: [], resolvedFacts: [], evaluations: [], reEvaluationPending: false, status: 'open',
        origin: 'transaction', transactionId,
        openedAt: now(), closedAt: null, keys: {}, rev: 1, revAt: now(), revBy: null, history: [],
      };
      hist(c, 'compliance_context_opened', by, { type, policyVersions: policySetFor(jurisdictions).policies.map((x) => x.id) });
      db.complianceContexts.push(c);
      return c;
    },
    contextById,
    /**
     * Project the transaction's parties and representation bindings into the
     * context the engine reads. The transaction's own stores remain the truth;
     * this is the evaluation input, rebuilt from them every time, so a stale
     * mirror cannot exist.
     */
    project(c, { parties, representations }) {
      c.parties = parties.map((p) => ({ id: p.id, partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId, addedAt: p.addedAt, removed: !!p.removed, ...(p.removedAt ? { removedAt: p.removedAt } : {}) }));
      c.representations = representations.map((r) => ({ id: r.id, agentUserId: r.agentUserId, partyRole: r.partyRole, agreementId: r.agreementId ?? null, status: r.status, declaredOnly: !!r.declaredOnly, reviewId: r.reviewId ?? null, firstActAt: r.firstActAt ?? null }));
    },
    evaluate(c, by, opts = {}) { return evaluateAndRecord(c, by, opts); },
    lastEvaluation,
    consentsFor: (ctxId) => db.regulatoryConsents.filter((k) => k && k.contextId === ctxId && k.kind !== 'revocation').map((k) => ({ ...k, status: consentStatusOf(k), revokedAt: revokedAtOf(k) })),
    closeContext(c, by) {
      if (!c || c.status === 'closed') return;
      c.status = 'closed'; c.closedAt = now();
      hist(c, 'compliance_context_closed', by);
      for (const r of db.regulatoryReviews) if (r && r.subject?.contextId === c.id && (r.status === 'PENDING' || r.status === 'IN_REVIEW')) { r.status = 'CANCELLED'; r.decidedAt = now(); hist(r, 'regulatory_review_cancelled', by, { reasonCode: 'context_closed' }); }
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
    reviewsForContext: (ctxId) => db.regulatoryReviews.filter((r) => r && r.subject?.contextId === ctxId).map((r) => ({ id: r.id, kind: r.kind, status: r.status, requestedAt: r.requestedAt, decidedAt: r.decidedAt ?? null, outcome: r.decision?.outcome ?? null })),
    createReview,
    byOrg, bySystem,
  };

  /**
   * M23 P5.6E — the ONE narrow seam the cross-app integration layer asks. It
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
    reviewerAuth, provider, onPlayerDeleted, hooks: { facetNeedsReview, representationDisputed, authorizeApproach, createApproachReview, auditRows: (org) => complianceAuditRows(db, org) },
    complianceAuditRows: (org) => complianceAuditRows(db, org),
    facetStatesOf, policySetFor, transactionSeam, integrationSeam,
  };
}
