import express from 'express';
import { readPage, sendPageError, pageOf } from '../platform/paging.mjs';
import { filled, presentOrRefuse } from '../platform/schemas.mjs';
import { REPORT_TARGETS, safetyInput } from './schemas.mjs';
import { hashPassword, invoiceView } from '../../adapters.mjs';

export const reportView = (r) => ({
  id: r.id,
  ts: r.ts,
  by: r.by,
  byId: r.byId,
  byOrgId: r.byOrgId,
  targetKind: r.targetKind,
  targetOrgId: r.targetOrgId,
  targetScoutName: r.targetScoutName,
  targetPlayerId: r.targetPlayerId,
  reason: r.reason,
  urgent: r.urgent,
  status: r.status,
  outcome: r.outcome,
  resolvedAt: r.resolvedAt,
});
const blockView = (b) => ({ id: b.id, playerId: b.playerId, orgId: b.orgId, by: b.by, reason: b.reason, ts: b.ts });
const moderationView = (m) => ({
  id: m.id,
  ts: m.ts,
  context: m.context,
  flags: m.flags,
  severity: m.severity,
  excerpt: m.excerpt,
});

/** A reviewer session beside the shared key attributes the action to that person; the key alone is read-only. */
export function createAdminRouter({ app, adminKey, sessionFor, compliancePolicies }) {
  if (typeof adminKey !== 'string' || !adminKey) throw new TypeError('createAdminRouter needs the admin key');
  const adminRouter = express.Router();
  app.use(
    '/admin',
    (req, res, next) => {
      if (req.headers['x-admin-key'] !== adminKey) return res.status(401).json({ error: 'ADMIN_KEY_REQUIRED' });
      const session = sessionFor(req);
      if (session?.kind === 'ts_reviewer') {
        const reviewer = compliancePolicies.reviewers.activeById(session.refId);
        if (reviewer) req.reviewer = reviewer;
      }
      next();
    },
    adminRouter,
  );
  return adminRouter;
}

export function registerReporting({
  playerRouter,
  guardianRouter,
  orgRouter,
  safetyAudit,
  recruitmentActs,
  byId,
  unit,
  nextId,
  ledgerAppend,
  broadcast,
}) {
  // An urgent report against an organisation suspends communication with the reporter's players at once, pending review.
  function handleReport(req, res, actor) {
    const body = safetyInput(res, 'report', req.body);
    if (!body) return;
    const { targetKind, targetOrgId, targetScoutName, targetPlayerId, urgent } = body;
    if (!targetKind)
      return res
        .status(400)
        .json({ error: 'TARGET_KIND_REQUIRED', field: 'targetKind', problem: 'required', allowed: REPORT_TARGETS });
    const reason = filled(body.reason);
    if (!presentOrRefuse(res, reason, 'reason')) return;
    if (targetOrgId && !byId.org(targetOrgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const report = {
      id: nextId('rep'),
      ts: Date.now(),
      byOrgId: null,
      ...actor,
      targetKind,
      targetOrgId: targetOrgId || null,
      targetScoutName: targetScoutName || null,
      targetPlayerId: targetPlayerId || null,
      reason,
      urgent: urgent === true,
      status: 'pending_review',
      outcome: null,
      resolvedAt: null,
    };
    // The targetPlayerId is not checked against the players (Q4, docs/decisions.md).
    const suspend = !!(report.urgent && targetOrgId);
    const playerIds = !suspend
      ? []
      : actor.by === 'guardian'
        ? (byId.guardian(actor.byId)?.childIds ?? [])
        : actor.by === 'player'
          ? [actor.byId]
          : [];
    unit(() => {
      safetyAudit.reports.file(report);
      for (const pid of playerIds) {
        safetyAudit.blocks.add({
          id: nextId('blk'),
          playerId: pid,
          orgId: targetOrgId,
          by: actor.by,
          reason: 'suspended_pending_review',
          ts: Date.now(),
        });
        recruitmentActs.suspendPendingRequests(targetOrgId, pid);
      }
    });
    if (suspend) broadcast('players');
    res.status(201).json({ reportId: report.id, status: report.status, suspended: suspend });
  }

  const addBlock = (res, { playerId, orgId, by, reason }) => {
    unit(() => {
      safetyAudit.blocks.add({ id: nextId('blk'), playerId, orgId, by, reason: reason || '', ts: Date.now() });
      ledgerAppend({
        type: `org_blocked_by_${by}`,
        playerId,
        orgId,
        orgName: byId.org(orgId).name,
        userId: null,
        scoutName: by,
      });
    });
    broadcast('players');
    res.status(201).json({ blocked: true });
  };

  guardianRouter.get('/reports', (req, res) =>
    res.json(safetyAudit.reports.forReporter('guardian', req.guardian.id).map(reportView)),
  );
  guardianRouter.post('/report', (req, res) => handleReport(req, res, { by: 'guardian', byId: req.guardian.id }));
  guardianRouter.post('/block', (req, res) => {
    const body = safetyInput(res, 'guardianBlock', req.body);
    if (!body) return;
    const { orgId, playerId, reason } = body;
    // A playerId that is not this guardian's child is refused, never swapped for another child; with no playerId, a
    // guardian of exactly one child means that child.
    if (playerId && !req.guardian.childIds.includes(playerId))
      return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const childId = playerId || (req.guardian.childIds.length === 1 ? req.guardian.childIds[0] : null);
    if (!orgId || !childId)
      return res.status(400).json({
        error: 'ORG_AND_CHILD_REQUIRED',
        message: playerId ? undefined : 'Name which child the block is for (playerId).',
      });
    if (!byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    addBlock(res, { playerId: childId, orgId, by: 'guardian', reason });
  });

  orgRouter.post('/report', (req, res) =>
    handleReport(req, res, { by: 'org_user', byId: req.orgUser.id, byOrgId: req.org.id }),
  );
  orgRouter.get('/reports', (req, res) =>
    res.json(safetyAudit.reports.forReporter('org_user', req.orgUser.id).map(reportView)),
  );

  playerRouter.get('/reports', (req, res) =>
    res.json(safetyAudit.reports.forReporter('player', req.player.id).map(reportView)),
  );
  playerRouter.post('/report', (req, res) => handleReport(req, res, { by: 'player', byId: req.player.id }));
  playerRouter.post('/block', (req, res) => {
    const body = safetyInput(res, 'playerBlock', req.body);
    if (!body) return;
    const { orgId, reason } = body;
    if (!orgId) return res.status(400).json({ error: 'ORG_REQUIRED', field: 'orgId', problem: 'required' });
    if (!byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    addBlock(res, { playerId: req.player.id, orgId, by: 'player', reason });
  });
}

export function registerSafetyConsole({
  adminRouter,
  dataLayerReport,
  storeEngine,
  unit,
  notify,
  broadcast,
  mailer,
  players,
  guardians,
  orgs,
  orgRecord,
  sessions,
  channels,
  safetyAudit,
  signingsFollowUps,
  invoices,
  outbox,
  pushLog,
  transitionsVouches,
  coachReferences,
  verificationReads,
  byId,
  orgSafe,
  safeguardingCertified,
  channelViewFor,
  vouchView,
  syncLegacyOrgVerification,
}) {
  if (typeof syncLegacyOrgVerification !== 'function')
    throw new TypeError("registerSafetyConsole needs the verification claims' syncLegacyOrgVerification");
  const paged = (req, res, cursor, read) => {
    const query = safetyInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, cursor);
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json(read(page));
  };

  // Row-level detail; the public /capabilities carries only counts and statuses.
  adminRouter.get('/data-layer', (_req, res) => res.json(dataLayerReport({ details: true })));

  adminRouter.get('/overview', (_req, res) => {
    res.json({
      players: players.count(),
      guardians: guardians.count(),
      orgs: orgs.count(),
      openReports: safetyAudit.reports.countOpen(),
      blocks: safetyAudit.blocks.count(),
      moderationHits: safetyAudit.moderationLog.count(),
      channels: channels.count(),
      signings: signingsFollowUps.signings.count(),
      invoices: invoices.count(),
      emailsSent: outbox.count(),
      pushesSent: pushLog.count(),
      sessions: sessions.count(),
      storageEngine: storeEngine,
      groomingEscalations: safetyAudit.moderationLog.count('grooming'),
      persisted: true, // every write commits before the handler answers
    });
  });

  // Urgent first, then oldest pending, then resolved (newest first).
  adminRouter.get('/reports', (req, res) =>
    paged(req, res, ['number', 'number', 'number'], (page) => {
      const out = safetyAudit.reports.triagePage(page);
      return { items: out.items.map(reportView), nextCursor: out.nextCursor };
    }),
  );

  // On the dev transport the outbox is the delivery, so a mail whose one-time code the stored row withholds is shown
  // in full while this process holds it (never saved, never backed up).
  adminRouter.get('/outbox', (req, res) =>
    paged(req, res, ['number'], (page) => {
      const out = outbox.page(page);
      return {
        items: out.items.map((m) => {
          const full = mailer.devDeliveredText(m.id);
          return full ? { ...m, text: full } : m;
        }),
        nextCursor: out.nextCursor,
      };
    }),
  );
  adminRouter.get('/push-log', (req, res) => paged(req, res, ['number'], (page) => pushLog.page(page)));
  adminRouter.get('/invoices', (req, res) =>
    paged(req, res, ['number'], (page) => {
      const { items, nextCursor } = invoices.page(page);
      return { items: items.map(invoiceView), nextCursor };
    }),
  );
  // T&S sees the coach's e-mail, never the code.
  adminRouter.get('/vouches', (req, res) =>
    paged(req, res, ['number'], (page) => {
      const { items, nextCursor } = pageOf(transitionsVouches.vouches.page(page).rows, page.limit, (r) => r.key);
      return { items: items.map(({ record: v }) => ({ ...vouchView(v), coachEmail: v.coachEmail })), nextCursor };
    }),
  );
  adminRouter.post('/vouches/:id/revoke', (req, res) => {
    const vouch = verificationReads.vouches.byId(req.params.id);
    if (!vouch) return res.status(404).json({ error: 'VOUCH_NOT_FOUND' });
    if (!safetyInput(res, 'none', req.body)) return;
    unit(() => coachReferences.revoke(vouch.id));
    broadcast('players', { playerId: vouch.playerId });
    res.json({ revoked: true });
  });

  adminRouter.post('/reports/:id/resolve', (req, res) => {
    const report = safetyAudit.reports.byId(req.params.id);
    if (!report) return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
    if (report.status !== 'pending_review') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const body = safetyInput(res, 'resolve', req.body);
    if (!body) return;
    const { action } = body;
    const outcome = filled(body.outcome);
    if (!presentOrRefuse(res, outcome, 'outcome')) return;
    const resolved = unit(() => {
      const r = safetyAudit.reports.resolve(report.id, { outcome, at: Date.now() });
      if (action === 'suspend_org' && r.targetOrgId) orgRecord.suspend(r.targetOrgId);
      if (r.by !== 'system')
        notify({ kind: r.by, id: r.byId }, 'report_resolved', `Your report was reviewed: ${r.outcome}`, r.id); // a system escalation has no reporter to tell
      return r;
    });
    res.json(reportView(resolved));
  });

  adminRouter.get('/clubs', (req, res) => {
    const query = safetyInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = orgs.page({}, readPage(query, ['number']));
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json({
      items: page.items.map((o) => ({ ...orgSafe(o), safeguardingCertified: safeguardingCertified(o) })),
      nextCursor: page.nextCursor,
    });
  });

  // How real Pro and Grassroots users sign in when the dev shortcuts are off: T&S provisions or rotates the password.
  adminRouter.post('/clubs/:id/credentials', (req, res) => {
    const org = byId.org(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const body = safetyInput(res, 'credentials', req.body);
    if (!body) return;
    const { password } = body;
    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: 'PASSWORD_TOO_SHORT', message: 'Club passwords need at least 8 characters.' });
    }
    orgRecord.provisionPassword(org.id, hashPassword(password));
    res.json({ ok: true, note: 'Credentials provisioned — the organisation signs in with this password from now on.' });
  });

  adminRouter.post('/clubs/:id/verification', (req, res) => {
    const org = byId.org(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const body = safetyInput(res, 'clubStanding', req.body);
    if (!body) return;
    const { verified, safeguardingContractSigned, verifiedDomain, suspended } = body;
    // Mirrored on the organisation's identity claim in the same unit.
    const updated = unit(() => {
      orgRecord.setStanding(org.id, {
        verified,
        safeguardingContractSigned,
        suspended,
        verifiedDomain: verifiedDomain === undefined ? undefined : verifiedDomain?.trim() || null,
      });
      syncLegacyOrgVerification(org, body);
      return byId.org(org.id);
    });
    broadcast('players'); // visibility rules may have changed
    res.json({ ...orgSafe(updated), safeguardingCertified: safeguardingCertified(updated) });
  });

  adminRouter.get('/blocks', (req, res) =>
    paged(req, res, ['number'], (page) => {
      const out = safetyAudit.blocks.page(page);
      return { items: out.items.map(blockView), nextCursor: out.nextCursor };
    }),
  );
  // Lifting a block deletes its row (Q5, docs/decisions.md).
  adminRouter.post('/blocks/:id/lift', (req, res) => {
    if (!safetyInput(res, 'none', req.body)) return;
    const lifted = safetyAudit.blocks.lift(req.params.id);
    if (!lifted) return res.status(404).json({ error: 'BLOCK_NOT_FOUND' });
    broadcast('players');
    res.json({ lifted: blockView(lifted) });
  });

  adminRouter.get('/moderation', (req, res) =>
    paged(req, res, ['number'], (page) => {
      const out = safetyAudit.moderationLog.page(page);
      return { items: out.items.map(moderationView), nextCursor: out.nextCursor };
    }),
  );

  // Most recently active first: "all communications logged", made inspectable.
  adminRouter.get('/channels', (req, res) =>
    paged(req, res, ['number', 'number'], (page) => {
      const out = channels.page(page);
      return {
        items: out.items.map((c) => ({ ...channelViewFor(c, 'org'), guardianId: c.guardianId })),
        nextCursor: out.nextCursor,
      };
    }),
  );
}
