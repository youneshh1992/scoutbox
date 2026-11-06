// F8 — Multi-club and federation workspaces.
// The one rule everything here enforces: effective access is the
// INTERSECTION of (actor is a live group member) ∧ (a live, unexpired,
// unrevoked grant names them) ∧ (the resource still exists and its owner
// still owns it) ∧ (every player involved is CURRENTLY visible to the
// RECEIVING org under the standing safeguarding rules). Group membership by
// itself shares nothing, and no group administrator can hand out access the
// receiving club could not hold on its own.
//
// S13c: groups and grants are rows of repositories/groups.mjs, written through its explicit operations and read
// through `groupReads`. Responses are built from the allowlists below, never by spreading a stored record.
import { readPage, sendPageError } from '../platform/paging.mjs';
import { GRANT_RESOURCE_KINDS, GROUP_LIMITS as L, typeExpiresDays, grantExpiry } from '../../repositories/groups.mjs';

export const groupView = (g) => ({
  id: g.id, name: g.name, adminOrgIds: [...g.adminOrgIds], memberOrgIds: [...g.memberOrgIds],
  pendingInvites: g.pendingInvites.map((i) => ({ orgId: i.orgId, invitedBy: i.invitedBy, at: i.at })),
  sharedTemplateIds: [...g.sharedTemplateIds],
  programmes: g.programmes.map((p) => ({ id: p.id, name: p.name, region: p.region, createdAt: p.createdAt })),
  createdAt: g.createdAt,
});
export const grantView = (gr) => ({
  id: gr.id, groupId: gr.groupId, fromOrgId: gr.fromOrgId, fromOrgName: gr.fromOrgName, toOrgIds: [...gr.toOrgIds],
  resourceKind: gr.resourceKind, resourceId: gr.resourceId, expiresAt: gr.expiresAt, revokedAt: gr.revokedAt,
  revokeReason: gr.revokeReason, createdBy: gr.createdBy, createdAt: gr.createdAt,
});

export function registerGroups(ctx) {
  const {
    db, byId, users, orgRouter, adminRouter, nextId, notify, findPlayer, unit,
    orgCanSee, requireLead, suppress, groups, groupReads,
  } = ctx;
  if (!groups || !groupReads) throw new TypeError('registerGroups needs the groups repository (ctx.groups, ctx.groupReads)');
  // §4.3 step 2: the signings are read through SQL (the signings repository's queries).
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function') throw new TypeError('registerGroups needs recruitmentReads (signings) from the data layer');
  const G = groupReads.groups;
  const fieldInvalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
  const leadOf = (orgId) => users.firstActive(orgId);

  // ------------------------------------------------------- administration
  adminRouter.post('/groups', (req, res) => {
    const { name, adminOrgId } = req.body ?? {};
    if (name !== undefined && name !== null && typeof name !== 'string') return fieldInvalid(res, 'name', 'A group name is text.');
    if (typeof name === 'string' && name.length > L.name) return fieldInvalid(res, 'name', `A group name is at most ${L.name} characters.`);
    const admin = typeof adminOrgId === 'string' ? byId.org(adminOrgId) : null;
    if (!name?.trim() || !admin) return res.status(400).json({ error: 'GROUP_FIELDS', message: 'name and a valid adminOrgId are required.' });
    if (admin.type === 'agency') return res.status(403).json({ error: 'AGENCIES_EXCLUDED', message: 'Agency organisations cannot join club/federation workspaces.' });
    // In a unit, so the id counter is saved with the row.
    const g = unit(() => groups.groups.create({
      id: nextId('grp'), name, adminOrgIds: [admin.id], memberOrgIds: [admin.id],
      pendingInvites: [], sharedTemplateIds: [], programmes: [], createdAt: Date.now(),
    }));
    res.status(201).json({ group: groupView(g) });
  });

  // Every group, newest first, paged by cursor (domains/platform/paging.mjs): { items, nextCursor }.
  adminRouter.get('/groups', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const p = G.page(page);
    res.json({ items: p.items.map(groupView), nextCursor: p.nextCursor });
  });

  orgRouter.get('/groups', (req, res) => {
    res.json({
      items: G.forMember(req.org.id).map((g) => ({
        ...groupView(g),
        members: g.memberOrgIds.map((id) => { const o = byId.org(id); return o ? { id: o.id, name: o.name, level: o.level ?? 'pro' } : null; }).filter(Boolean),
        youAdmin: g.adminOrgIds.includes(req.org.id),
      })),
      invites: G.invitesFor(req.org.id),
    });
  });

  // Delegated administration: the admin org invites; the invited org's lead
  // accepts. Nobody is added to a group silently.
  orgRouter.post('/groups/:id/invite', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.adminOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const target = typeof req.body?.orgId === 'string' ? byId.org(req.body.orgId) : null;
    if (!target) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (target.type === 'agency') return res.status(403).json({ error: 'AGENCIES_EXCLUDED', message: 'Agency organisations cannot join club/federation workspaces.' });
    if (g.memberOrgIds.includes(target.id) || g.pendingInvites.some((i) => i.orgId === target.id)) return res.status(409).json({ error: 'ALREADY_INVITED' });
    if (g.memberOrgIds.length + g.pendingInvites.length >= L.members) return res.status(409).json({ error: 'GROUP_LIMIT', message: `A group holds at most ${L.members} members and invites.` });
    // The invite and its notification are one unit.
    const out = unit(() => {
      const next = groups.groups.invite(g.id, { orgId: target.id, invitedBy: req.org.id, at: Date.now() });
      const lead = leadOf(target.id);
      if (lead) notify({ kind: 'org_user', id: lead.id }, 'group', `🤝 ${req.org.name} invited ${target.name} to the “${g.name}” workspace. A lead can accept from Group settings. Joining shares NOTHING by itself.`, g.id);
      return next;
    });
    res.status(201).json({ group: groupView(out) });
  });

  orgRouter.post('/groups/:id/accept', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g?.pendingInvites.some((i) => i.orgId === req.org.id)) return res.status(404).json({ error: 'NO_INVITE' });
    const next = groups.groups.accept(g.id, req.org.id);
    res.json({ group: groupView(next), note: 'You are a member. Access to anything remains grant-by-grant: default isolated.' });
  });

  orgRouter.post('/groups/:id/leave', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.memberOrgIds.includes(req.org.id)) return res.status(404).json({ error: 'NOT_A_MEMBER' });
    // Departure: grants in either direction whose owner no longer shares a group with any of their recipients end now,
    // in the same unit as the departure. (A grant whose other recipients still share a group stays live for them; the
    // shared read re-checks membership for every reader.)
    const killed = unit(() => {
      groups.groups.leave(g.id, req.org.id);
      return groups.grants.endUnshared(req.org.id, Date.now());
    });
    res.json({ left: true, grantsEnded: killed, note: 'Your records stay yours — leaving removes group access in both directions, never ownership.' });
  });

  // Group templates: the admin org designates shared assessment templates.
  orgRouter.post('/groups/:id/templates', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.adminOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const t = typeof req.body?.templateId === 'string' ? ctx.scoutingReads.templates.currentById(req.body.templateId) : null;
    if (!t) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
    if (!g.sharedTemplateIds.includes(t.id) && g.sharedTemplateIds.length >= L.templates) return res.status(409).json({ error: 'GROUP_LIMIT', message: `A group shares at most ${L.templates} templates.` });
    res.json({ group: groupView(groups.groups.shareTemplate(g.id, t.id)) });
  });

  orgRouter.post('/groups/:id/programmes', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.adminOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const { name = null, region = null } = req.body ?? {};
    if (name !== null && (typeof name !== 'string' || !name.trim() || name.length > L.programmeName)) return fieldInvalid(res, 'name', `A programme name is text of 1 to ${L.programmeName} characters.`);
    if (region !== null && (typeof region !== 'string' || region.length > L.region)) return fieldInvalid(res, 'region', `A region is text of at most ${L.region} characters.`);
    if (g.programmes.length >= L.programmes) return res.status(409).json({ error: 'GROUP_LIMIT', message: `A group holds at most ${L.programmes} programmes.` });
    const next = unit(() => groups.groups.addProgramme(g.id, { id: nextId('pgm'), name: name ?? 'Programme', region: region?.trim() ? region : null, createdAt: Date.now() }));
    res.status(201).json({ group: groupView(next) });
  });

  // --------------------------------------------------------------- grants
  function resourceOwnerOk(kind, id, orgId) {
    if (typeof id !== 'string') return false;
    if (kind === 'shortlist') return id === '*'; // "my shortlist" as a whole
    if (kind === 'case') return ctx.recruitmentReads.cases.byId(id)?.orgId === orgId;
    if (kind === 'assessment') { const a = ctx.scoutingReads.assessments.byId(id); return !!a && a.orgId === orgId && a.state !== 'draft'; }
    return false;
  }
  /** `toOrgIds`: absent is none; otherwise a list of organisation ids. The members other than the sharer, once each. */
  function recipientsOf(res, g, toOrgIds, orgId) {
    if (toOrgIds === undefined || toOrgIds === null) return [];
    if (!Array.isArray(toOrgIds) || toOrgIds.length > L.members || !toOrgIds.every((id) => typeof id === 'string')) {
      fieldInvalid(res, 'toOrgIds', `toOrgIds is a list of at most ${L.members} organisation ids.`);
      return null;
    }
    return [...new Set(toOrgIds)].filter((id) => g.memberOrgIds.includes(id) && id !== orgId);
  }

  // What WOULD the recipient see? Same code path as the real read — the
  // preview can therefore never promise more than the grant delivers.
  function resourceViewFor(grant, receivingOrg) {
    const eligible = (pid) => { const p = findPlayer(pid); return p && orgCanSee(receivingOrg, p); };
    if (grant.resourceKind === 'shortlist') {
      const ids = ctx.safetyReads.ledger.playersListedBy(grant.fromOrgId);
      const visible = ids.filter(eligible);
      return {
        kind: 'shortlist',
        players: visible.map((pid) => { const p = findPlayer(pid); return { id: p.id, name: p.name, position: p.position, level: p.level }; }),
        withheld: ids.length - visible.length,
        withheldNote: ids.length - visible.length > 0 ? `${ids.length - visible.length} player(s) withheld — outside your organisation's own visibility rules (under-18 verification, agency wall, grassroots level/50 km). A group grant never overrides those.` : null,
      };
    }
    if (grant.resourceKind === 'case') {
      const found = ctx.recruitmentReads.cases.byId(grant.resourceId);
      const c = found && found.orgId === grant.fromOrgId ? found : null;
      if (!c) return { kind: 'case', gone: true };
      if (!eligible(c.playerId)) return { kind: 'case', withheldNote: 'The player in this case is not visible to your organisation under the standing rules.' };
      return { kind: 'case', case: { id: c.id, playerName: c.playerName, stage: c.stage, priority: c.priority, decision: c.decision } };
    }
    if (grant.resourceKind === 'assessment') {
      const found = ctx.scoutingReads.assessments.byId(grant.resourceId);
      const a = found && found.orgId === grant.fromOrgId ? found : null;
      if (!a) return { kind: 'assessment', gone: true };
      if (!eligible(a.playerId)) return { kind: 'assessment', withheldNote: 'The assessed player is not visible to your organisation under the standing rules.' };
      return { kind: 'assessment', assessment: { id: a.id, playerName: a.playerName, scoutName: a.scoutName, templateId: a.templateId, ratings: a.ratings, recommendation: a.recommendation, context: a.context } };
    }
    return {};
  }

  orgRouter.post('/groups/:id/grants/preview', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.memberOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'NOT_A_MEMBER' });
    const { resourceKind, resourceId, toOrgIds } = req.body ?? {};
    if (!GRANT_RESOURCE_KINDS.includes(resourceKind) || !resourceOwnerOk(resourceKind, resourceId, req.org.id)) {
      return res.status(400).json({ error: 'RESOURCE_INVALID', message: 'You can only share resources your organisation owns.' });
    }
    const recipients = recipientsOf(res, g, toOrgIds, req.org.id);
    if (!recipients) return;
    res.json({
      recipients: recipients.map((id) => {
        const org = byId.org(id);
        return { orgId: id, orgName: org?.name, wouldSee: resourceViewFor({ fromOrgId: req.org.id, resourceKind, resourceId }, org) };
      }),
      note: 'Per-recipient preview through the same rules the real read uses.',
    });
  });

  orgRouter.post('/groups/:id/grants', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.memberOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'NOT_A_MEMBER' });
    const { resourceKind, resourceId, toOrgIds, expiresDays } = req.body ?? {};
    if (!GRANT_RESOURCE_KINDS.includes(resourceKind) || !resourceOwnerOk(resourceKind, resourceId, req.org.id)) {
      return res.status(400).json({ error: 'RESOURCE_INVALID', message: 'You can only share resources your organisation owns.' });
    }
    const days = typeExpiresDays(expiresDays);
    if (!days.ok) return fieldInvalid(res, 'expiresDays', `expiresDays is a whole number from ${L.expiresDays[0]} to ${L.expiresDays[1]}.`);
    const listed = recipientsOf(res, g, toOrgIds, req.org.id);
    if (!listed) return;
    const recipients = listed.filter((id) => byId.org(id)?.type !== 'agency');
    if (!recipients.length) return res.status(400).json({ error: 'RECIPIENTS_REQUIRED', message: 'Name at least one other member organisation.' });
    const at = Date.now();
    // The grant and its notifications are one unit.
    const grant = unit(() => {
      const out = groups.grants.create({
        id: nextId('gnt'), groupId: g.id, fromOrgId: req.org.id, fromOrgName: req.org.name,
        toOrgIds: recipients, resourceKind, resourceId, expiresAt: grantExpiry(at, days.value),
        revokedAt: null, revokeReason: null, createdBy: req.orgUser.name ?? null, createdAt: at,
      });
      for (const id of recipients) {
        const u = leadOf(id);
        if (u) notify({ kind: 'org_user', id: u.id }, 'group', `📂 ${req.org.name} shared a ${resourceKind} with your club in “${g.name}”.`, out.id);
      }
      return out;
    });
    res.status(201).json({ grant: grantView(grant) });
  });

  // The grants the organisation gave, newest first, paged by cursor (`nextCursor` pages `given`), and the grants it
  // can read now (live, and the owner still shares a group with it).
  orgRouter.get('/grants', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const now = Date.now();
    const given = groupReads.grants.pageGiven(req.org.id, page);
    res.json({
      given: given.items.map((gr) => ({ ...grantView(gr), live: !gr.revokedAt && gr.expiresAt > now })),
      nextCursor: given.nextCursor,
      received: groupReads.grants.liveReceived(req.org.id, now)
        .map((gr) => ({ id: gr.id, fromOrgName: gr.fromOrgName, resourceKind: gr.resourceKind, expiresAt: gr.expiresAt })),
    });
  });

  // How many grants the organisation gave, and how many it can read now (the Network screen's count).
  orgRouter.get('/grants/counts', (req, res) => res.json(groupReads.grants.countsFor(req.org.id, Date.now())));

  orgRouter.post('/grants/:id/revoke', (req, res) => {
    if (!requireLead(req, res)) return;
    const gr = groupReads.grants.givenBy(req.org.id, req.params.id);
    if (!gr) return res.status(404).json({ error: 'GRANT_NOT_FOUND' });
    const next = groups.grants.revoke(gr.id, { at: Date.now(), reason: 'revoked_by_owner' });
    res.json({ grant: grantView(next), note: 'Effective immediately: the shared read, media entitlements and event delivery all re-check the grant live.' });
  });

  // The shared read — every condition of the intersection, evaluated NOW.
  orgRouter.get('/shared/:grantId', (req, res) => {
    const gr = groupReads.grants.byId(req.params.grantId);
    if (!gr || !gr.toOrgIds.includes(req.org.id)) return res.status(404).json({ error: 'GRANT_NOT_FOUND' });
    if (gr.revokedAt || gr.expiresAt <= Date.now()) return res.status(403).json({ error: 'GRANT_ENDED', message: 'This share was revoked or expired.' });
    if (!G.shareAGroup(gr.fromOrgId, req.org.id)) return res.status(403).json({ error: 'GROUP_MEMBERSHIP_ENDED', message: 'One of the organisations left the shared workspace.' });
    res.json({ grantId: gr.id, from: gr.fromOrgName, resource: resourceViewFor(gr, req.org) });
  });

  // Aggregate reporting for the admin org — n<3 suppression everywhere.
  orgRouter.get('/groups/:id/report', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = G.byId(req.params.id);
    if (!g || !g.adminOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const memberRows = g.memberOrgIds.map((orgId) => {
      const org = byId.org(orgId);
      const assessments = ctx.scoutingReads.assessments.forOrg(orgId).filter((a) => a.state !== 'draft').length;
      const signings = reads.signings.countForOrg(orgId);
      return { orgId, orgName: org?.name, assessments: suppress(assessments) ? '<3' : assessments, signings: suppress(signings) ? '<3' : signings };
    });
    const sharing = groupReads.grants.countsForGroup(g.id, Date.now());
    res.json({
      group: { id: g.id, name: g.name, members: g.memberOrgIds.length },
      activity: memberRows,
      sharing: { grantsCreated: sharing.created, live: sharing.live },
      note: 'Counts under 3 are suppressed. This report contains NO player-level data — player records stay inside each member club\'s own permissions.',
    });
  });
}
