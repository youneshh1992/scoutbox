// F8 — Multi-club and federation workspaces.
// The one rule everything here enforces: effective access is the
// INTERSECTION of (actor is a live group member) ∧ (a live, unexpired,
// unrevoked grant names them) ∧ (the resource still exists and its owner
// still owns it) ∧ (every player involved is CURRENTLY visible to the
// RECEIVING org under the standing safeguarding rules). Group membership by
// itself shares nothing, and no group administrator can hand out access the
// receiving club could not hold on its own.
export function registerGroups(ctx) {
  const {
    db, orgRouter, adminRouter, nextId, persistNow, notify, findPlayer,
    orgCanSee, paginate, isLead, requireLead, suppress, sameGroupLive,
  } = ctx;

  const groupsOf = (orgId) => db.groups.filter((g) => g.memberOrgIds.includes(orgId));
  const isGroupAdmin = (group, orgId) => group.adminOrgIds.includes(orgId);

  // ------------------------------------------------------- administration
  adminRouter.post('/groups', (req, res) => {
    const { name, adminOrgId } = req.body ?? {};
    const admin = db.orgs.find((o) => o.id === adminOrgId);
    if (!name?.trim() || !admin) return res.status(400).json({ error: 'GROUP_FIELDS', message: 'name and a valid adminOrgId are required.' });
    const g = {
      id: nextId('grp'), name: String(name).slice(0, 100),
      adminOrgIds: [admin.id], memberOrgIds: [admin.id],
      pendingInvites: [], sharedTemplateIds: [], programmes: [],
      createdAt: Date.now(),
    };
    db.groups.push(g);
    persistNow();
    res.status(201).json({ group: g });
  });

  adminRouter.get('/groups', (_req, res) => res.json({ items: db.groups }));

  orgRouter.get('/groups', (req, res) => {
    res.json({
      items: groupsOf(req.org.id).map((g) => ({
        ...g,
        members: g.memberOrgIds.map((id) => { const o = db.orgs.find((x) => x.id === id); return o ? { id: o.id, name: o.name, level: o.level ?? 'pro' } : null; }).filter(Boolean),
        youAdmin: isGroupAdmin(g, req.org.id),
      })),
      invites: db.groups.filter((g) => g.pendingInvites.some((i) => i.orgId === req.org.id)).map((g) => ({ groupId: g.id, name: g.name })),
    });
  });

  // Delegated administration: the admin org invites; the invited org's lead
  // accepts. Nobody is added to a group silently.
  orgRouter.post('/groups/:id/invite', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !isGroupAdmin(g, req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const target = db.orgs.find((o) => o.id === req.body?.orgId);
    if (!target) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (target.type === 'agency') return res.status(403).json({ error: 'AGENCIES_EXCLUDED', message: 'Agency organisations cannot join club/federation workspaces.' });
    if (g.memberOrgIds.includes(target.id) || g.pendingInvites.some((i) => i.orgId === target.id)) return res.status(409).json({ error: 'ALREADY_INVITED' });
    g.pendingInvites.push({ orgId: target.id, invitedBy: req.org.id, at: Date.now() });
    const lead = db.users.find((u) => u.orgId === target.id && !u.removedAt);
    if (lead) notify({ kind: 'org_user', id: lead.id }, 'group', `🤝 ${req.org.name} invited ${target.name} to the “${g.name}” workspace. A lead can accept from Group settings. Joining shares NOTHING by itself.`, g.id);
    persistNow();
    res.status(201).json({ group: g });
  });

  orgRouter.post('/groups/:id/accept', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    const inv = g?.pendingInvites.find((i) => i.orgId === req.org.id);
    if (!inv) return res.status(404).json({ error: 'NO_INVITE' });
    g.pendingInvites = g.pendingInvites.filter((i) => i !== inv);
    g.memberOrgIds.push(req.org.id);
    persistNow();
    res.json({ group: g, note: 'You are a member. Access to anything remains grant-by-grant: default isolated.' });
  });

  orgRouter.post('/groups/:id/leave', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !g.memberOrgIds.includes(req.org.id)) return res.status(404).json({ error: 'NOT_A_MEMBER' });
    g.memberOrgIds = g.memberOrgIds.filter((id) => id !== req.org.id);
    g.adminOrgIds = g.adminOrgIds.filter((id) => id !== req.org.id);
    // Departure: grants in either direction that relied on this group die now.
    let killed = 0;
    for (const gr of db.groupGrants) {
      if (gr.revokedAt) continue;
      const involved = gr.fromOrgId === req.org.id || gr.toOrgIds.includes(req.org.id);
      if (involved && !sameGroupLive(gr.fromOrgId, gr.toOrgIds[0])) { gr.revokedAt = Date.now(); gr.revokeReason = 'group_departure'; killed++; }
    }
    persistNow();
    res.json({ left: true, grantsEnded: killed, note: 'Your records stay yours — leaving removes group access in both directions, never ownership.' });
  });

  // Group templates: the admin org designates shared assessment templates.
  orgRouter.post('/groups/:id/templates', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !isGroupAdmin(g, req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const t = db.assessmentTemplates.find((x) => x.id === req.body?.templateId);
    if (!t) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
    if (!g.sharedTemplateIds.includes(t.id)) g.sharedTemplateIds.push(t.id);
    persistNow();
    res.json({ group: g });
  });

  orgRouter.post('/groups/:id/programmes', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !isGroupAdmin(g, req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    g.programmes.push({ id: nextId('pgm'), name: String(req.body?.name ?? 'Programme').slice(0, 100), region: String(req.body?.region ?? '').slice(0, 80) || null, createdAt: Date.now() });
    persistNow();
    res.status(201).json({ group: g });
  });

  // --------------------------------------------------------------- grants
  const RESOURCE_KINDS = ['shortlist', 'case', 'assessment'];

  function resourceOwnerOk(kind, id, orgId) {
    if (kind === 'shortlist') return id === '*'; // "my shortlist" as a whole
    if (kind === 'case') return db.recruitmentCases.some((c) => c.id === id && c.orgId === orgId);
    if (kind === 'assessment') return db.assessments.some((a) => a.id === id && a.orgId === orgId && a.state !== 'draft');
    return false;
  }

  // What WOULD the recipient see? Same code path as the real read — the
  // preview can therefore never promise more than the grant delivers.
  function resourceViewFor(grant, receivingOrg) {
    const eligible = (pid) => { const p = findPlayer(pid); return p && orgCanSee(receivingOrg, p); };
    if (grant.resourceKind === 'shortlist') {
      const ids = [...new Set(db.ledger.filter((l) => l.type === 'shortlist' && l.orgId === grant.fromOrgId).map((l) => l.playerId))];
      const visible = ids.filter(eligible);
      return {
        kind: 'shortlist',
        players: visible.map((pid) => { const p = findPlayer(pid); return { id: p.id, name: p.name, position: p.position, level: p.level }; }),
        withheld: ids.length - visible.length,
        withheldNote: ids.length - visible.length > 0 ? `${ids.length - visible.length} player(s) withheld — outside your organisation's own visibility rules (under-18 verification, agency wall, grassroots level/50 km). A group grant never overrides those.` : null,
      };
    }
    if (grant.resourceKind === 'case') {
      const c = db.recruitmentCases.find((x) => x.id === grant.resourceId && x.orgId === grant.fromOrgId);
      if (!c) return { kind: 'case', gone: true };
      if (!eligible(c.playerId)) return { kind: 'case', withheldNote: 'The player in this case is not visible to your organisation under the standing rules.' };
      return { kind: 'case', case: { id: c.id, playerName: c.playerName, stage: c.stage, priority: c.priority, decision: c.decision } };
    }
    if (grant.resourceKind === 'assessment') {
      const a = db.assessments.find((x) => x.id === grant.resourceId && x.orgId === grant.fromOrgId);
      if (!a) return { kind: 'assessment', gone: true };
      if (!eligible(a.playerId)) return { kind: 'assessment', withheldNote: 'The assessed player is not visible to your organisation under the standing rules.' };
      return { kind: 'assessment', assessment: { id: a.id, playerName: a.playerName, scoutName: a.scoutName, templateId: a.templateId, ratings: a.ratings, recommendation: a.recommendation, context: a.context } };
    }
    return {};
  }

  orgRouter.post('/groups/:id/grants/preview', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !g.memberOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'NOT_A_MEMBER' });
    const { resourceKind, resourceId, toOrgIds } = req.body ?? {};
    if (!RESOURCE_KINDS.includes(resourceKind) || !resourceOwnerOk(resourceKind, resourceId, req.org.id)) {
      return res.status(400).json({ error: 'RESOURCE_INVALID', message: 'You can only share resources your organisation owns.' });
    }
    const recipients = (Array.isArray(toOrgIds) ? toOrgIds : []).filter((id) => g.memberOrgIds.includes(id) && id !== req.org.id);
    res.json({
      recipients: recipients.map((id) => {
        const org = db.orgs.find((o) => o.id === id);
        return { orgId: id, orgName: org?.name, wouldSee: resourceViewFor({ fromOrgId: req.org.id, resourceKind, resourceId }, org) };
      }),
      note: 'Per-recipient preview through the same rules the real read uses.',
    });
  });

  orgRouter.post('/groups/:id/grants', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !g.memberOrgIds.includes(req.org.id)) return res.status(403).json({ error: 'NOT_A_MEMBER' });
    const { resourceKind, resourceId, toOrgIds, expiresDays } = req.body ?? {};
    if (!RESOURCE_KINDS.includes(resourceKind) || !resourceOwnerOk(resourceKind, resourceId, req.org.id)) {
      return res.status(400).json({ error: 'RESOURCE_INVALID', message: 'You can only share resources your organisation owns.' });
    }
    const recipients = (Array.isArray(toOrgIds) ? toOrgIds : []).filter((id) => g.memberOrgIds.includes(id) && id !== req.org.id && db.orgs.find((o) => o.id === id)?.type !== 'agency');
    if (!recipients.length) return res.status(400).json({ error: 'RECIPIENTS_REQUIRED', message: 'Name at least one other member organisation.' });
    const grant = {
      id: nextId('gnt'), groupId: g.id, fromOrgId: req.org.id, fromOrgName: req.org.name,
      toOrgIds: recipients, resourceKind, resourceId: String(resourceId),
      expiresAt: Date.now() + Math.min(Math.max(Number(expiresDays) || 30, 1), 180) * 86_400_000,
      revokedAt: null, createdBy: req.orgUser.name, createdAt: Date.now(),
    };
    db.groupGrants.push(grant);
    for (const id of recipients) {
      const u = db.users.find((x) => x.orgId === id && !x.removedAt);
      if (u) notify({ kind: 'org_user', id: u.id }, 'group', `📂 ${req.org.name} shared a ${resourceKind} with your club in “${g.name}”.`, grant.id);
    }
    persistNow();
    res.status(201).json({ grant });
  });

  orgRouter.get('/grants', (req, res) => {
    const now = Date.now();
    const live = (gr) => !gr.revokedAt && gr.expiresAt > now;
    res.json({
      given: db.groupGrants.filter((gr) => gr.fromOrgId === req.org.id).map((gr) => ({ ...gr, live: live(gr) })),
      received: db.groupGrants.filter((gr) => gr.toOrgIds.includes(req.org.id) && live(gr) && sameGroupLive(gr.fromOrgId, req.org.id))
        .map((gr) => ({ id: gr.id, fromOrgName: gr.fromOrgName, resourceKind: gr.resourceKind, expiresAt: gr.expiresAt })),
    });
  });

  orgRouter.post('/grants/:id/revoke', (req, res) => {
    if (!requireLead(req, res)) return;
    const gr = db.groupGrants.find((x) => x.id === req.params.id && x.fromOrgId === req.org.id);
    if (!gr) return res.status(404).json({ error: 'GRANT_NOT_FOUND' });
    if (!gr.revokedAt) { gr.revokedAt = Date.now(); gr.revokeReason = 'revoked_by_owner'; persistNow(); }
    res.json({ grant: gr, note: 'Effective immediately: the shared read, media entitlements and event delivery all re-check the grant live.' });
  });

  // The shared read — every condition of the intersection, evaluated NOW.
  orgRouter.get('/shared/:grantId', (req, res) => {
    const gr = db.groupGrants.find((x) => x.id === req.params.grantId);
    if (!gr || !gr.toOrgIds.includes(req.org.id)) return res.status(404).json({ error: 'GRANT_NOT_FOUND' });
    if (gr.revokedAt || gr.expiresAt <= Date.now()) return res.status(403).json({ error: 'GRANT_ENDED', message: 'This share was revoked or expired.' });
    if (!sameGroupLive(gr.fromOrgId, req.org.id)) return res.status(403).json({ error: 'GROUP_MEMBERSHIP_ENDED', message: 'One of the organisations left the shared workspace.' });
    res.json({ grantId: gr.id, from: gr.fromOrgName, resource: resourceViewFor(gr, req.org) });
  });

  // Aggregate reporting for the admin org — n<3 suppression everywhere.
  orgRouter.get('/groups/:id/report', (req, res) => {
    if (!requireLead(req, res)) return;
    const g = db.groups.find((x) => x.id === req.params.id);
    if (!g || !isGroupAdmin(g, req.org.id)) return res.status(403).json({ error: 'GROUP_ADMIN_ONLY' });
    const memberRows = g.memberOrgIds.map((orgId) => {
      const org = db.orgs.find((o) => o.id === orgId);
      const assessments = db.assessments.filter((a) => a.orgId === orgId && a.state !== 'draft').length;
      const signings = db.signings.filter((s) => s.orgId === orgId).length;
      return { orgId, orgName: org?.name, assessments: suppress(assessments) ? '<3' : assessments, signings: suppress(signings) ? '<3' : signings };
    });
    const grants = db.groupGrants.filter((gr) => gr.groupId === g.id);
    res.json({
      group: { id: g.id, name: g.name, members: g.memberOrgIds.length },
      activity: memberRows,
      sharing: { grantsCreated: grants.length, live: grants.filter((gr) => !gr.revokedAt && gr.expiresAt > Date.now()).length },
      note: 'Counts under 3 are suppressed. This report contains NO player-level data — player records stay inside each member club\'s own permissions.',
    });
  });
}
