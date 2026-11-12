/** Policy versions: proposed by one Trust & Safety administrator and published by a different one (dual control). */

import { bumpRev } from '../../platform/concurrency.mjs';
import { sendComplianceError } from './errors.mjs';
import { filled } from '../../platform/schemas.mjs';
import { RULE_STATUSES } from './policyVersions.mjs';
import { applicablePolicySet } from './policy.mjs';
import { now } from '../../platform/clock.mjs';

/** Returns `policySetFor(memberAssociations, at)`, the published policy versions that apply. */
export function registerPolicies(ctx) {
  const {
    access,
    adminRouter,
    agencyJurisdictions,
    broadcast,
    byReviewer,
    bySystem,
    compliancePolicies,
    complianceRecords,
    hist,
    inputOr400,
    limitedOr429,
    nextId,
    orgRouter,
    profileOf,
    requireReviewerRole,
    tsRouter,
    unit,
  } = ctx;
  const { policies } = compliancePolicies;
  const publishedPolicies = () => policies.published();
  const policySetFor = (mas, at = now()) => applicablePolicySet(publishedPolicies(), mas, at);
  const policyPublic = (p) => ({
    id: p.id,
    regulator: p.regulator,
    jurisdiction: p.jurisdiction,
    policyVersion: p.policyVersion,
    supersedes: p.supersedes ?? null,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo ?? null,
    status: p.status,
    publishedAt: p.publishedAt ?? null,
    proposedBy: p.proposedBy ?? null,
    approvedBy: p.approvedBy ?? null,
    publishedBy: p.publishedBy ?? null,
    rules: Object.fromEntries(
      Object.entries(p.rules ?? {}).map(([id, r]) => [
        id,
        {
          ruleStatus: r.ruleStatus,
          textStatus: r.textStatus ?? null,
          note: r.note ?? null,
          params: r.params ?? {},
          sourceRef: r.sourceRef ?? [],
        },
      ]),
    ),
    rev: p.rev ?? 1,
  });
  /**
   * `{ row }` or `{ field, problem, message }` for a body its schema has read. The schema checks each field and the
   * rule parameters' types; the repository checks them again as it stores them, and its refusal names the field.
   */
  function policyFromBody(b, req) {
    if (b.effectiveTo != null && !(b.effectiveFrom < b.effectiveTo))
      return { field: 'effectiveTo', problem: 'invalid', message: 'effectiveTo must be after effectiveFrom.' };
    const at = now();
    const row = {
      id: b.id,
      regulator: filled(b.regulator) ?? 'UNKNOWN',
      jurisdiction: b.jurisdiction,
      policyVersion: b.policyVersion,
      supersedes: b.supersedes ?? null,
      effectiveFrom: b.effectiveFrom,
      effectiveTo: b.effectiveTo ?? null,
      rules: Object.fromEntries(Object.entries(b.rules).map(([id, r]) => [id, { ...r, note: r.note || null }])),
      status: 'proposed',
      proposedBy: { id: req.reviewer.id, name: req.reviewer.name, at },
      approvedBy: null,
      publishedAt: null,
      publishedBy: null,
      createdAt: at,
      rev: 1,
      revAt: at,
      revBy: null,
      history: [],
    };
    hist(row, 'policy_version_proposed', byReviewer(req), { policyVersion: row.id });
    return { row };
  }
  /** Names the field, never its content. */
  const policyRefusal = (res, e) => {
    if (e?.code === 'COMPLIANCE_POLICIES_DUPLICATE' && e.field === 'id')
      return sendComplianceError(res, { error: 'POLICY_VERSION_EXISTS' }, 'policies');
    if (e?.code === 'COMPLIANCE_POLICIES_INPUT_INVALID')
      return sendComplianceError(
        res,
        { error: 'POLICY_INPUT_INVALID', field: e.field ?? 'policy', message: e.message.replace(/^[A-Z_]+: /, '') },
        'policies',
      );
    throw e;
  };
  tsRouter.get('/compliance/policies', (req, res) =>
    res.json({ items: policies.all().map(policyPublic), ruleStatuses: RULE_STATUSES, dualControl: true }),
  );
  tsRouter.post('/compliance/policies', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    if (limitedOr429(res, 'ts_policy_publish', req.reviewer.id)) return;
    const b = inputOr400(res, 'newPolicy', req.body);
    if (!b) return;
    const built = policyFromBody(b, req);
    if (!built.row) return sendComplianceError(res, { error: 'POLICY_INPUT_INVALID', ...built }, 'policies');
    if (policies.exists(built.row.id)) return sendComplianceError(res, { error: 'POLICY_VERSION_EXISTS' }, 'policies');
    let p;
    try {
      p = policies.create(built.row);
    } catch (e) {
      return policyRefusal(res, e);
    }
    res.status(201).json({
      policy: policyPublic(p),
      note: 'Proposed. A DIFFERENT Trust & Safety administrator must approve before it takes effect (dual control, C7).',
    });
  });
  tsRouter.post('/compliance/policies/:id/approve', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    if (!inputOr400(res, 'policyApproval', req.body)) return;
    const p = policies.byId(req.params.id);
    if (!p) return sendComplianceError(res, { error: 'POLICY_NOT_FOUND' }, 'policies');
    if (p.status !== 'proposed')
      return sendComplianceError(res, { error: 'POLICY_NOT_PROPOSED', status: p.status }, 'policies');
    if (p.proposedBy?.id === req.reviewer.id)
      return sendComplianceError(
        res,
        {
          error: 'POLICY_DUAL_CONTROL_REQUIRED',
          message: 'The approving administrator must be a different person from the proposer.',
        },
        'policies',
      );
    const out = unit(() => {
      const next = policies.update(p.id, (d) => {
        d.status = 'published';
        d.approvedBy = { id: req.reviewer.id, name: req.reviewer.name, at: now() };
        d.publishedAt = now();
        d.publishedBy = [
          { kind: 'ts_reviewer', id: d.proposedBy.id, name: d.proposedBy.name },
          { kind: 'ts_reviewer', id: req.reviewer.id, name: req.reviewer.name },
        ];
        hist(d, 'policy_version_published', byReviewer(req), { policyVersion: d.id });
        bumpRev(d, { by: req.reviewer, at: now() });
      });
      // Open contexts under an older version are flagged, never silently re-verdicted.
      complianceRecords.contexts.flagPolicyChange(next.jurisdiction, next.id, () => ({
        id: nextId('aud'),
        at: now(),
        action: 'compliance_context_policy_changed',
        by: bySystem('policy publication'),
        detail: { policyVersions: [next.id] },
      }));
      return next;
    });
    broadcast('policy_version_published', {});
    res.json({ policy: policyPublic(out) });
  });
  orgRouter.get('/agent/compliance/policies', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    const mas = [
      ...new Set([
        'INT',
        ...agencyJurisdictions(req.org.id),
        ...(profileOf(req.orgUser.id)?.declared?.jurisdictions ?? []),
      ]),
    ];
    const set = policySetFor(mas);
    res.json({
      inEffect: set.policies.map(policyPublic),
      missing: set.missing,
      ruleStatuses: RULE_STATUSES,
      honest:
        "These are ScoutBox's encoded platform rules with their operative status as recorded on the retrieval date. They are not legal advice and a status can change without a deploy.",
    });
  });
  adminRouter.get('/compliance/policies', (_req, res) =>
    res.json({
      items: policies.all().map(policyPublic),
      readOnly: true,
      note: 'Read-only. Publishing needs two authenticated Trust & Safety administrators (/ts).',
    }),
  );

  return { policySetFor };
}
