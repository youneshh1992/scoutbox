// Reports, blocks and the Trust & Safety console. Players, guardians and club staff report; players and guardians
// block; ScoutBox staff resolve reports, lift blocks and set an organisation's standing from the console.
import express from 'express';
import { readPage, sendPageError, pageOf } from '../platform/paging.mjs';
import { optText, reqText, badField } from '../platform/input.mjs';
import { AUDIT_LIMITS } from '../../repositories/safetyAudit.mjs';
import { ORG_LIMITS } from '../../repositories/orgs.mjs';
import { hashPassword, invoiceView } from '../../adapters.mjs';

export const reportView = (r) => ({ id: r.id, ts: r.ts, by: r.by, byId: r.byId, byOrgId: r.byOrgId, targetKind: r.targetKind, targetOrgId: r.targetOrgId, targetScoutName: r.targetScoutName, targetPlayerId: r.targetPlayerId, reason: r.reason, urgent: r.urgent, status: r.status, outcome: r.outcome, resolvedAt: r.resolvedAt });
const blockView = (b) => ({ id: b.id, playerId: b.playerId, orgId: b.orgId, by: b.by, reason: b.reason, ts: b.ts });
const moderationView = (m) => ({ id: m.id, ts: m.ts, context: m.context, flags: m.flags, severity: m.severity, excerpt: m.excerpt });

/**
 * The `/admin` router behind the shared key. A reviewer session presented beside the key attributes the action to that
 * person; the key alone is read-only and non-authoritative for compliance.
 */
export function createAdminRouter({ app, adminKey, sessionFor, compliancePolicies }) {
  if (typeof adminKey !== 'string' || !adminKey) throw new TypeError('createAdminRouter needs the admin key');
  const adminRouter = express.Router();
  app.use('/admin', (req, res, next) => {
    if (req.headers['x-admin-key'] !== adminKey) return res.status(401).json({ error: 'ADMIN_KEY_REQUIRED' });
    const session = sessionFor(req);
    if (session?.kind === 'ts_reviewer') {
      const reviewer = compliancePolicies.reviewers.activeById(session.refId);
      if (reviewer) req.reviewer = reviewer;
    }
    next();
  }, adminRouter);
  return adminRouter;
}

/** `POST /report` and `GET /reports` for players, guardians and club staff, and `POST /block` for players and guardians. */
export function registerReporting({ playerRouter, guardianRouter, orgRouter, safetyAudit, recruitment, byId, unit, nextId, ledgerAppend, broadcast }) {
  // An urgent report against an organisation suspends communication with the reporter's players at once, pending review.
  function handleReport(req, res, actor) {
    const { targetKind, targetOrgId, targetScoutName, targetPlayerId, reason, urgent } = req.body || {};
    if (!['club', 'scout', 'player'].includes(targetKind)) {
      return res.status(400).json({ error: 'TARGET_KIND_REQUIRED', allowed: ['club', 'scout', 'player'] });
    }
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    if (typeof reason !== 'string' || reason.trim().length > AUDIT_LIMITS.reason) return badField(res, 'reason');
    for (const [field, v] of [['targetOrgId', targetOrgId], ['targetScoutName', targetScoutName], ['targetPlayerId', targetPlayerId]]) if (!optText(v, 200)) return badField(res, field);
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
      reason: String(reason).trim(),
      urgent: !!urgent,
      status: 'pending_review',
      outcome: null,
      resolvedAt: null,
    };
    // The targetPlayerId is not checked against the players (Q4, docs/decisions.md).
    const suspend = !!(report.urgent && targetOrgId);
    const playerIds = !suspend ? [] : actor.by === 'guardian'
      ? byId.guardian(actor.byId)?.childIds ?? []
      : actor.by === 'player' ? [actor.byId] : [];
    unit(() => {
      safetyAudit.reports.file(report);
      for (const pid of playerIds) {
        safetyAudit.blocks.add({ id: nextId('blk'), playerId: pid, orgId: targetOrgId, by: actor.by, reason: 'suspended_pending_review', ts: Date.now() });
        for (const r of recruitment.requests.forOrgPlayer(targetOrgId, pid).filter((x) => x.status === 'pending')) {
          recruitment.requests.suspend(r.id);
        }
      }
    });
    if (suspend) broadcast('players');
    res.status(201).json({ reportId: report.id, status: report.status, suspended: suspend });
  }

  const addBlock = (res, { playerId, orgId, by, reason }) => {
    unit(() => {
      safetyAudit.blocks.add({ id: nextId('blk'), playerId, orgId, by, reason: reason || '', ts: Date.now() });
      ledgerAppend({ type: `org_blocked_by_${by}`, playerId, orgId, orgName: byId.org(orgId).name, userId: null, scoutName: by });
    });
    broadcast('players');
    res.status(201).json({ blocked: true });
  };

  guardianRouter.get('/reports', (req, res) => res.json(safetyAudit.reports.forReporter('guardian', req.guardian.id).map(reportView)));
  guardianRouter.post('/report', (req, res) => handleReport(req, res, { by: 'guardian', byId: req.guardian.id }));
  guardianRouter.post('/block', (req, res) => {
    const { orgId, playerId, reason } = req.body || {};
    // A playerId that is not this guardian's child is refused, never swapped for another child; with no playerId, a
    // guardian of exactly one child means that child.
    if (playerId && !req.guardian.childIds.includes(playerId)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const childId = playerId || (req.guardian.childIds.length === 1 ? req.guardian.childIds[0] : null);
    if (!orgId || !childId) return res.status(400).json({ error: 'ORG_AND_CHILD_REQUIRED', message: playerId ? undefined : 'Name which child the block is for (playerId).' });
    if (!optText(reason)) return badField(res, 'reason');
    if (!byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    addBlock(res, { playerId: childId, orgId, by: 'guardian', reason });
  });

  orgRouter.post('/report', (req, res) => handleReport(req, res, { by: 'org_user', byId: req.orgUser.id, byOrgId: req.org.id }));
  orgRouter.get('/reports', (req, res) => res.json(safetyAudit.reports.forReporter('org_user', req.orgUser.id).map(reportView)));

  playerRouter.get('/reports', (req, res) => res.json(safetyAudit.reports.forReporter('player', req.player.id).map(reportView)));
  playerRouter.post('/report', (req, res) => handleReport(req, res, { by: 'player', byId: req.player.id }));
  playerRouter.post('/block', (req, res) => {
    const { orgId, reason } = req.body || {};
    if (!orgId) return res.status(400).json({ error: 'ORG_REQUIRED' });
    if (!reqText(orgId, 200)) return badField(res, 'orgId');
    if (!optText(reason)) return badField(res, 'reason');
    if (!byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    addBlock(res, { playerId: req.player.id, orgId, by: 'player', reason });
  });
}

/** The console's queues, logs and organisation controls on `adminRouter`. */
export function registerSafetyConsole({
  adminRouter, dataLayerReport, storeEngine, unit, notify, broadcast, mailer,
  players, guardians, orgs, sessions, channels, safetyAudit, signingsFollowUps, operations, outbox, pushLog,
  transitionsVouches, verificationReads, byId,
  orgSafe, safeguardingCertified, channelViewFor, vouchView, syncLegacyOrgVerification,
}) {
  if (typeof orgs?.setStanding !== 'function') throw new TypeError('registerSafetyConsole needs the orgs repository');
  if (typeof syncLegacyOrgVerification !== 'function') throw new TypeError('registerSafetyConsole needs the verification claims\' syncLegacyOrgVerification');
  const paged = (req, res, cursor, read) => {
    let page;
    try { page = readPage(req.query, cursor); } catch (e) { return sendPageError(res, e); }
    res.json(read(page));
  };

  // Row-level detail of the data layer; the public /capabilities carries only counts and statuses.
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
      invoices: operations.invoices.count(),
      emailsSent: outbox.count(),
      pushesSent: pushLog.count(),
      sessions: sessions.count(),
      storageEngine: storeEngine,
      groomingEscalations: safetyAudit.moderationLog.count('grooming'),
      persisted: true, // every write is committed to the database before the handler answers
    });
  });

  // Triage order: urgent first, then oldest pending, then resolved (newest first).
  adminRouter.get('/reports', (req, res) => paged(req, res, ['number', 'number', 'number'], (page) => {
    const out = safetyAudit.reports.triagePage(page);
    return { items: out.items.map(reportView), nextCursor: out.nextCursor };
  }));

  // On the dev transport the outbox is the delivery, so a mail whose one-time code the stored row withholds is shown
  // in full while this process holds it (never saved, never backed up).
  adminRouter.get('/outbox', (req, res) => paged(req, res, ['number'], (page) => {
    const out = outbox.page(page);
    return { items: out.items.map((m) => { const full = mailer.devDeliveredText(m.id); return full ? { ...m, text: full } : m; }), nextCursor: out.nextCursor };
  }));
  adminRouter.get('/push-log', (req, res) => paged(req, res, ['number'], (page) => pushLog.page(page)));
  adminRouter.get('/invoices', (req, res) => paged(req, res, ['number'], (page) => {
    const { items, nextCursor } = operations.invoices.page(page);
    return { items: items.map(invoiceView), nextCursor };
  }));
  // T&S sees the coach's e-mail, never the code.
  adminRouter.get('/vouches', (req, res) => paged(req, res, ['number'], (page) => {
    const { items, nextCursor } = pageOf(transitionsVouches.vouches.page(page).rows, page.limit, (r) => r.key);
    return { items: items.map(({ record: v }) => ({ ...vouchView(v), coachEmail: v.coachEmail })), nextCursor };
  }));
  adminRouter.post('/vouches/:id/revoke', (req, res) => {
    const vouch = verificationReads.vouches.byId(req.params.id);
    if (!vouch) return res.status(404).json({ error: 'VOUCH_NOT_FOUND' });
    unit(() => transitionsVouches.vouches.revoke(vouch.id));
    broadcast('players', { playerId: vouch.playerId });
    res.json({ revoked: true });
  });

  adminRouter.post('/reports/:id/resolve', (req, res) => {
    const report = safetyAudit.reports.byId(req.params.id);
    if (!report) return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
    if (report.status !== 'pending_review') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { outcome, action } = req.body || {};
    if (!outcome || !String(outcome).trim()) return res.status(400).json({ error: 'OUTCOME_REQUIRED' });
    if (typeof outcome !== 'string' || outcome.trim().length > AUDIT_LIMITS.outcome) return badField(res, 'outcome');
    const resolved = unit(() => {
      const r = safetyAudit.reports.resolve(report.id, { outcome: outcome.trim(), at: Date.now() });
      if (action === 'suspend_org' && r.targetOrgId) orgs.setStanding(r.targetOrgId, { suspended: true });
      if (r.by !== 'system') notify({ kind: r.by, id: r.byId }, 'report_resolved', `Your report was reviewed: ${r.outcome}`, r.id); // a system escalation has no reporter to tell
      return r;
    });
    res.json(reportView(resolved));
  });

  adminRouter.get('/clubs', (req, res) => {
    let page;
    try { page = orgs.page({}, readPage(req.query, ['number'])); } catch (e) { return sendPageError(res, e); }
    res.json({ items: page.items.map((o) => ({ ...orgSafe(o), safeguardingCertified: safeguardingCertified(o) })), nextCursor: page.nextCursor });
  });

  // How real Pro and Grassroots users sign in when the dev shortcuts are off: T&S provisions or rotates the password.
  adminRouter.post('/clubs/:id/credentials', (req, res) => {
    const org = byId.org(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'PASSWORD_TOO_SHORT', message: 'Club passwords need at least 8 characters.' });
    }
    orgs.setPasswordHash(org.id, hashPassword(String(password)));
    res.json({ ok: true, note: 'Credentials provisioned — the organisation signs in with this password from now on.' });
  });

  adminRouter.post('/clubs/:id/verification', (req, res) => {
    const org = byId.org(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const { verified, safeguardingContractSigned, verifiedDomain, suspended } = req.body || {};
    for (const [f, v] of [['verified', verified], ['safeguardingContractSigned', safeguardingContractSigned], ['suspended', suspended]]) if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ error: 'FIELD_INVALID', field: f, message: `${f} must be true or false.` });
    if (verifiedDomain !== undefined && verifiedDomain !== null && !(typeof verifiedDomain === 'string' && verifiedDomain.trim().length <= ORG_LIMITS.domain)) return badField(res, 'verifiedDomain');
    // The switch is mirrored on the organisation's identity claim in the same unit, so the two never disagree.
    const updated = unit(() => {
      orgs.setStanding(org.id, { verified, safeguardingContractSigned, suspended, verifiedDomain: verifiedDomain === undefined ? undefined : verifiedDomain?.trim() || null });
      syncLegacyOrgVerification(org, req.body);
      return byId.org(org.id);
    });
    broadcast('players'); // visibility rules may have changed
    res.json({ ...orgSafe(updated), safeguardingCertified: safeguardingCertified(updated) });
  });

  adminRouter.get('/blocks', (req, res) => paged(req, res, ['number'], (page) => {
    const out = safetyAudit.blocks.page(page);
    return { items: out.items.map(blockView), nextCursor: out.nextCursor };
  }));
  // Lifting a block deletes its row (Q5, docs/decisions.md).
  adminRouter.post('/blocks/:id/lift', (req, res) => {
    const lifted = safetyAudit.blocks.lift(req.params.id);
    if (!lifted) return res.status(404).json({ error: 'BLOCK_NOT_FOUND' });
    broadcast('players');
    res.json({ lifted: blockView(lifted) });
  });

  adminRouter.get('/moderation', (req, res) => paged(req, res, ['number'], (page) => {
    const out = safetyAudit.moderationLog.page(page);
    return { items: out.items.map(moderationView), nextCursor: out.nextCursor };
  }));

  // Every thread, most recently active first: "all communications logged", made inspectable.
  adminRouter.get('/channels', (req, res) => paged(req, res, ['number', 'number'], (page) => {
    const out = channels.page(page);
    return { items: out.items.map((c) => ({ ...channelViewFor(c, 'org'), guardianId: c.guardianId })), nextCursor: out.nextCursor };
  }));
}
