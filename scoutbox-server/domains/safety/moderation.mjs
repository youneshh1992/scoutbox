// Text moderation at the route. Children cannot share personal contact details, and club messages to guardians are
// screened the same way. Every hit is logged, and grooming-pattern language also escalates to a human at once.
import { moderateText } from '../../domain.mjs';

export function createModeration({ safetyAudit, unit, nextId }) {
  if (typeof safetyAudit?.moderationLog?.record !== 'function' || typeof unit !== 'function') throw new TypeError('createModeration needs the safety-audit repository and unit');

  return function moderateOrRefuse(res, text, context) {
    const check = moderateText(text);
    if (check.ok) return true;
    unit(() => {
      safetyAudit.moderationLog.record({ id: nextId('mod'), ts: Date.now(), context, flags: check.flags, severity: check.severity, excerpt: String(text).slice(0, 140) });
      if (check.severity === 'grooming') {
        safetyAudit.reports.file({
          id: nextId('rep'), ts: Date.now(), by: 'system', byId: 'moderation', byOrgId: null,
          targetKind: context.orgId ? 'club' : 'player', targetOrgId: context.orgId ?? null,
          reason: `Automatic escalation: grooming-pattern language blocked (${check.flags.join(', ')}) in ${context.kind}.`,
          urgent: true, status: 'pending_review', outcome: null, resolvedAt: null,
        });
      }
    });
    res.status(400).json({
      error: 'MODERATION_BLOCKED',
      message: 'This text was blocked by moderation: personal contact details and off-platform contact are not allowed.',
      flags: check.flags,
    });
    return false;
  };
}
