// F7 — Recruitment coverage and observation planning (moved from m13/planning.mjs).
// Travel times are never invented; candidate suggestions only ever contain
// players the org can see under the standing rules.

export function registerCoverage(ctx) {
  const {
    db, byId, orgRouter, nextId, persistNow, notify, findPlayer, orgCanSee,
    paginate, histAppend, isLead, requireLead, canViewFinance, haversineKm,
    validAmountMinor, convertMinor, CURRENCIES,
    recruitmentCases, // S8b: a budget change is one explicit write of its case (cases.update)
  } = ctx;
  const { cases } = recruitmentCases;

  // ============================================================ F7 coverage
  orgRouter.post('/coverage/fixtures', (req, res) => {
    const b = req.body ?? {};
    if (!b.home?.trim() || !b.away?.trim() || !b.date) return res.status(400).json({ error: 'FIXTURE_FIELDS', message: 'home, away and date are required.' });
    const f = {
      id: nextId('fix'), orgId: req.org.id, source: 'own',
      competition: String(b.competition ?? '').slice(0, 80) || null,
      home: String(b.home).slice(0, 80), away: String(b.away).slice(0, 80),
      date: String(b.date).slice(0, 10),
      location: (typeof b.lat === 'number' && typeof b.lng === 'number') ? { lat: b.lat, lng: b.lng, city: String(b.city ?? '').slice(0, 60) } : null,
      createdBy: req.orgUser.name, createdAt: Date.now(),
    };
    db.fixtures.push(f);
    persistNow();
    res.status(201).json({ fixture: f });
  });

  // Read-time union: own fixture records + existing platform events the org
  // can already see (friendlies board, open trials). Nothing scraped, nothing
  // duplicated into new rows.
  function observableFixtures(org) {
    const own = db.fixtures.filter((f) => f.orgId === org.id);
    const orgLoc = (orgId) => byId.org(orgId)?.location ?? null;
    const friendlies = (db.friendlies ?? []).map((fr) => ({
      id: `fr-${fr.id}`, source: 'friendly_board', competition: 'Friendly',
      home: fr.orgName ?? 'Host club', away: fr.status === 'open' ? 'open invitation' : 'confirmed opponent',
      date: fr.date ?? null, location: orgLoc(fr.orgId),
    })).filter((f) => f.date);
    const trials = (db.openTrials ?? []).map((t) => ({
      id: `tr-${t.id}`, source: 'open_trial', competition: 'Open trial',
      home: t.orgName ?? byId.org(t.orgId)?.name ?? 'Club', away: '—',
      date: t.date ?? null, location: orgLoc(t.orgId),
    })).filter((f) => f.date);
    return [...own, ...friendlies, ...trials];
  }

  orgRouter.get('/coverage/fixtures', (req, res) => {
    const all = observableFixtures(req.org).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    res.json(paginate(req, all));
  });

  orgRouter.post('/coverage-plans', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = req.body ?? {};
    const p = {
      id: nextId('cvp'), orgId: req.org.id,
      label: String(b.label ?? 'Coverage plan').slice(0, 100),
      competition: b.competition ? String(b.competition).slice(0, 80) : null,
      region: b.region ? String(b.region).slice(0, 80) : null,
      goalObservations: Math.min(Math.max(Number(b.goalObservations) || 5, 1), 200),
      windowDays: Math.min(Math.max(Number(b.windowDays) || 60, 7), 365),
      createdBy: req.orgUser.name, createdAt: Date.now(),
    };
    db.coveragePlans.push(p);
    persistNow();
    res.status(201).json({ plan: p });
  });

  function planProgress(plan) {
    const since = Date.now() - plan.windowDays * 86_400_000;
    const done = db.coverageAssignments.filter((a) => a.orgId === plan.orgId && a.observedAt && a.observedAt >= since
      && (!plan.competition || a.fixtureCompetition === plan.competition)).length;
    return { done, goal: plan.goalObservations, complete: done >= plan.goalObservations };
  }

  orgRouter.get('/coverage-plans', (req, res) => {
    res.json({ items: db.coveragePlans.filter((p) => p.orgId === req.org.id).map((p) => ({ ...p, progress: planProgress(p) })) });
  });

  orgRouter.post('/coverage/assignments', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = req.body ?? {};
    const fixture = observableFixtures(req.org).find((f) => f.id === b.fixtureId);
    if (!fixture) return res.status(404).json({ error: 'FIXTURE_NOT_FOUND' });
    const scout = byId.user(b.scoutUserId, (u) => u.orgId === req.org.id && !u.removedAt);
    if (!scout) return res.status(404).json({ error: 'SCOUT_NOT_FOUND' });
    // Targets: only players this org can currently see. Never a leak path.
    const targets = (Array.isArray(b.targetPlayerIds) ? b.targetPlayerIds : [])
      .map(findPlayer).filter((p) => p && orgCanSee(req.org, p)).map((p) => p.id);
    const warnings = [];
    const dup = db.coverageAssignments.find((a) => a.orgId === req.org.id && a.fixtureId === fixture.id && !a.cancelledAt);
    if (dup) warnings.push(`Duplicate visit: ${byId.user(dup.scoutUserId)?.name ?? 'a scout'} is already assigned to this fixture.`);
    const clash = db.coverageAssignments.find((a) => a.orgId === req.org.id && a.scoutUserId === scout.id && a.fixtureDate === fixture.date && !a.cancelledAt);
    if (clash) warnings.push(`Conflict: ${scout.name} already has an assignment on ${fixture.date}.`);
    const a = {
      id: nextId('cva'), orgId: req.org.id, fixtureId: fixture.id, fixtureDate: fixture.date,
      fixtureLabel: `${fixture.home} v ${fixture.away}`, fixtureCompetition: fixture.competition,
      scoutUserId: scout.id, scoutName: scout.name, targetPlayerIds: targets,
      travelBudget: validAmountMinor(b.travelBudgetMinor) ? { amountMinor: b.travelBudgetMinor, currency: String(b.travelCurrency ?? 'GBP').slice(0, 3), enteredBy: req.orgUser.name } : null,
      travelNote: 'Travel time/route estimates unavailable — no routing provider is configured. The budget figure is user-entered, not a confirmed cost.',
      warnings, assignedBy: req.orgUser.name, createdAt: Date.now(),
      observedAt: null, assessmentIds: [], cancelledAt: null,
    };
    db.coverageAssignments.push(a);
    notify({ kind: 'org_user', id: scout.id }, 'coverage', `🧭 New observation assignment: ${a.fixtureLabel} on ${a.fixtureDate}${targets.length ? ` (${targets.length} target${targets.length > 1 ? 's' : ''})` : ''}.`, a.id);
    persistNow();
    res.status(201).json({ assignment: a, warnings });
  });

  orgRouter.get('/coverage/assignments', (req, res) => {
    const mine = db.coverageAssignments.filter((a) => a.orgId === req.org.id && !a.cancelledAt);
    const scoutOnly = !isLead(req.orgUser);
    res.json({ items: (scoutOnly ? mine.filter((a) => a.scoutUserId === req.orgUser.id) : mine).slice().reverse() });
  });

  orgRouter.post('/coverage/assignments/:id/complete', (req, res) => {
    const a = db.coverageAssignments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id && !isLead(req.orgUser)) return res.status(403).json({ error: 'NOT_YOUR_ASSIGNMENT' });
    if (a.observedAt) return res.status(409).json({ error: 'ALREADY_COMPLETED' });
    a.observedAt = Date.now();
    const assessmentId = req.body?.assessmentId;
    if (assessmentId && ctx.scoutingReads.assessments.byId(assessmentId)?.orgId === req.org.id) a.assessmentIds.push(assessmentId);
    persistNow();
    res.json({ assignment: a });
  });

  orgRouter.post('/coverage/assignments/:id/cancel', (req, res) => {
    if (!requireLead(req, res)) return;
    const a = db.coverageAssignments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    a.cancelledAt = Date.now();
    persistNow();
    res.json({ assignment: a });
  });

  // Suggested visits: upcoming fixtures near ≥2 of the org's active-interest
  // players (open cases + shortlist), matched by declared locations within
  // 30 km. A heuristic, labelled as one — no schedules are scraped.
  orgRouter.get('/coverage/suggestions', (req, res) => {
    const interest = new Set([
      ...ctx.recruitmentReads.cases.forOrg(req.org.id).filter((c) => !['closed'].includes(c.stage)).map((c) => c.playerId),
      ...db.ledger.filter((l) => l.type === 'shortlist' && l.orgId === req.org.id).map((l) => l.playerId),
    ]);
    const candidates = [...interest].map(findPlayer).filter((p) => p && orgCanSee(req.org, p) && p.location);
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = observableFixtures(req.org).filter((f) => f.date >= today && f.location);
    const covered = new Set(db.coverageAssignments.filter((a) => a.orgId === req.org.id && !a.cancelledAt).map((a) => a.fixtureId));
    const items = upcoming.map((f) => {
      const near = candidates.filter((p) => haversineKm(f.location, p.location) <= 30);
      return near.length >= 2 ? {
        fixture: f, alreadyCovered: covered.has(f.id),
        nearbyTargets: near.map((p) => ({ id: p.id, name: p.name, position: p.position })),
        rationale: `${near.length} players you track are within 30 km of this fixture's location`,
      } : null;
    }).filter(Boolean).sort((a, b) => b.nearbyTargets.length - a.nearbyTargets.length).slice(0, 10);
    res.json({ items, note: 'Location-proximity heuristic over your own tracked players and visible fixtures. It does not know who will actually play, and it never includes players outside your visibility rules.' });
  });

}
