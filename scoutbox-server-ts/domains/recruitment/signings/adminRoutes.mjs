/** Trust & Safety's voiding of a signing. */

import { notFound } from './errors.mjs';
import { SIGNING_LIMITS, currentRevision, canCancel, canVoid, SIGNING_INPUT } from './signing.mjs';

export function registerAdminRoutes(ctx) {
  const {
    adminRouter,
    broadcast,
    caseAudit,
    caseOf,
    err,
    hist,
    notifyClubLeads,
    notifyPlayer,
    now,
    signingInput,
    sp,
    textOrRefuse,
    touch,
    unit,
  } = ctx;
  adminRouter.post('/signings/:id/void', (req, res) => {
    if (!req.reviewer?.id)
      return err(res, 'SIGNING_NOT_PERMITTED', 'Voiding a signing requires a named Trust & Safety reviewer.');
    const pkg = sp.byId(req.params.id);
    if (!pkg) return notFound(res, 'admin');
    const at = now(req);
    const body = signingInput(res, SIGNING_INPUT.adminVoid, req.body);
    if (!body) return;
    const reason = textOrRefuse(res, 'reason', body.reason, SIGNING_LIMITS.reason, { required: true });
    if (reason === undefined) return;
    const g = canVoid(pkg, at);
    if (!g.ok) {
      const g2 = canCancel(pkg, at);
      if (!g2.ok) return err(res, g2.error, g2.message, g2.current ? { current: g2.current } : {});
    }
    const by = { kind: 'admin', id: req.reviewer.id, name: req.reviewer.name ?? req.reviewer.id };
    const rev = currentRevision(pkg);
    let fresh;
    try {
      fresh = unit(
        () => {
          let p = sp.patchRevision(pkg.id, rev.id, { status: 'VOIDED' });
          p = sp.patch(p.id, { status: 'VOIDED', voidedAt: at, voidedBy: by, voidReason: reason });
          p = hist(p, 'signing_voided', by, { revisionId: rev.id, hadReason: true, byTrustAndSafety: true }, at);
          const kase = caseOf(p);
          if (kase)
            caseAudit(kase, 'admin', by.id, by.name, 'signing_voided', {
              signingPackageId: p.id,
              byTrustAndSafety: true,
            });
          return touch(p, null, at, { id: by.id, name: by.name });
        },
        (fresh) => {
          broadcast?.('signing_voided', { orgId: fresh.orgId, roomId: fresh.caseId, signingPackageId: fresh.id });
          notifyClubLeads(fresh, 'Trust & Safety voided a signing on one of your cases. Nothing was signed.');
          if (rev.readyAt)
            notifyPlayer(fresh, 'The signing presented to you was voided by Trust & Safety. Nothing was signed.');
        },
      );
    } catch (e) {
      console.error(`SIGNING admin_void_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be voided; nothing was recorded.');
    }
    res.json({ ok: true, signingPackageId: fresh.id, status: 'VOIDED' });
  });
}
