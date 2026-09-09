// F7 — Recruitment coverage and observation planning.
// F9 — Recruitment budget and deal scenarios.
// Money is integer minor units end to end; travel times and market values are
// never invented; candidate suggestions only ever contain players the org can
// see under the standing rules.
import { convertMinor } from './shared.mjs';

// Exported for direct fixture testing — ALL integer arithmetic.
export function computeScenarioTotals(scenario) {
  const termMonths = scenario.termMonths;
  const perCurrency = {};
  const bucket = (cur) => (perCurrency[cur] ??= { confirmedMinor: 0, estimatedMinor: 0, conditionalCount: 0 });
  const occurrences = (schedule) =>
    schedule === 'one_off' ? 1
      : schedule === 'monthly' ? termMonths
        : schedule === 'annual' ? Math.ceil(termMonths / 12)
          : /* weekly */ Math.round((termMonths * 52) / 12);
  for (const l of scenario.lines) {
    const b = bucket(l.currency);
    if (l.conditional) { b.conditionalCount++; continue; } // unknown stays unknown — never summed
    const total = l.amountMinor * occurrences(l.schedule);
    if (l.confirmed) b.confirmedMinor += total; else b.estimatedMinor += total;
  }
  // Combined total ONLY when explicit FX assumptions cover every currency.
  let combined = null;
  const currencies = Object.keys(perCurrency);
  if (currencies.length === 1) {
    combined = { currency: currencies[0], ...perCurrency[currencies[0]], viaFx: false };
  } else if (currencies.length > 1) {
    const target = scenario.currency;
    let confirmedMinor = 0, estimatedMinor = 0, ok = true;
    const applied = [];
    for (const cur of currencies) {
      if (cur === target) { confirmedMinor += perCurrency[cur].confirmedMinor; estimatedMinor += perCurrency[cur].estimatedMinor; continue; }
      const fx = (scenario.fxAssumptions ?? []).find((a) => a.from === cur && a.to === target);
      if (!fx) { ok = false; break; }
      const c1 = convertMinor(perCurrency[cur].confirmedMinor, fx.rate);
      const c2 = convertMinor(perCurrency[cur].estimatedMinor, fx.rate);
      if (c1 === null || c2 === null) { ok = false; break; }
      confirmedMinor += c1; estimatedMinor += c2;
      applied.push(fx);
    }
    combined = ok
      ? { currency: target, confirmedMinor, estimatedMinor, viaFx: true, fxApplied: applied, fxNote: 'Converted with the stated manual assumptions — not market rates.' }
      : { unavailable: true, reason: 'Currencies mixed without a stated exchange-rate assumption for each — totals stay per-currency.' };
  }
  return {
    termMonths, perCurrency, combined,
    conditionalLines: scenario.lines.filter((l) => l.conditional).map((l) => ({ label: l.label, amountMinor: l.amountMinor, currency: l.currency, schedule: l.schedule, assumption: l.conditional.assumption })),
    conditionalNote: 'Conditional amounts are listed with their assumptions and EXCLUDED from every total.',
  };
}

export function registerPlanning(ctx) {
  const {
    db, orgRouter, nextId, persistNow, notify, findPlayer, orgCanSee,
    paginate, histAppend, isLead, requireLead, canViewFinance, haversineKm,
    validAmountMinor, convertMinor, CURRENCIES,
  } = ctx;

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
    const orgLoc = (orgId) => db.orgs.find((o) => o.id === orgId)?.location ?? null;
    const friendlies = (db.friendlies ?? []).map((fr) => ({
      id: `fr-${fr.id}`, source: 'friendly_board', competition: 'Friendly',
      home: fr.orgName ?? 'Host club', away: fr.status === 'open' ? 'open invitation' : 'confirmed opponent',
      date: fr.date ?? null, location: orgLoc(fr.orgId),
    })).filter((f) => f.date);
    const trials = (db.openTrials ?? []).map((t) => ({
      id: `tr-${t.id}`, source: 'open_trial', competition: 'Open trial',
      home: t.orgName ?? db.orgs.find((o) => o.id === t.orgId)?.name ?? 'Club', away: '—',
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
    const scout = db.users.find((u) => u.id === b.scoutUserId && u.orgId === req.org.id && !u.removedAt);
    if (!scout) return res.status(404).json({ error: 'SCOUT_NOT_FOUND' });
    // Targets: only players this org can currently see. Never a leak path.
    const targets = (Array.isArray(b.targetPlayerIds) ? b.targetPlayerIds : [])
      .map(findPlayer).filter((p) => p && orgCanSee(req.org, p)).map((p) => p.id);
    const warnings = [];
    const dup = db.coverageAssignments.find((a) => a.orgId === req.org.id && a.fixtureId === fixture.id && !a.cancelledAt);
    if (dup) warnings.push(`Duplicate visit: ${db.users.find((u) => u.id === dup.scoutUserId)?.name ?? 'a scout'} is already assigned to this fixture.`);
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
    if (assessmentId && db.assessments.some((x) => x.id === assessmentId && x.orgId === req.org.id)) a.assessmentIds.push(assessmentId);
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
      ...db.recruitmentCases.filter((c) => c.orgId === req.org.id && !['closed'].includes(c.stage)).map((c) => c.playerId),
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

  // ============================================================ F9 budgets
  const LINE_KINDS = ['wage', 'fee', 'bonus', 'expense'];
  const SCHEDULES = ['one_off', 'weekly', 'monthly', 'annual'];

  function caseFor(req, res) {
    const c = db.recruitmentCases.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!c) { res.status(404).json({ error: 'CASE_NOT_FOUND' }); return null; }
    const access = !c.restricted || c.ownerUserId === req.orgUser.id || (c.assignments ?? []).some((a) => a.userId === req.orgUser.id) || isLead(req.orgUser);
    if (!access) { res.status(403).json({ error: 'CASE_RESTRICTED' }); return null; }
    if (!canViewFinance(req.orgUser)) {
      res.status(403).json({ error: 'FINANCE_ROLE_REQUIRED', message: 'Deal amounts are visible to leads and finance roles only.' });
      return null;
    }
    return c;
  }

  function cleanLines(raw) {
    const out = [];
    for (const l of (Array.isArray(raw) ? raw : []).slice(0, 30)) {
      if (!LINE_KINDS.includes(l.kind) || !SCHEDULES.includes(l.schedule)) continue;
      if (!validAmountMinor(l.amountMinor) || l.amountMinor < 0) continue;
      out.push({
        id: l.id ?? null, kind: l.kind, label: String(l.label ?? l.kind).slice(0, 80),
        amountMinor: l.amountMinor, currency: CURRENCIES.includes(l.currency) ? l.currency : 'GBP',
        schedule: l.schedule, confirmed: l.confirmed === true,
        conditional: l.conditional?.assumption ? { assumption: String(l.conditional.assumption).slice(0, 200) } : null,
      });
    }
    return out;
  }

  ctx.computeScenarioTotals = computeScenarioTotals;

  orgRouter.post('/cases/:id/budget/scenarios', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    const b = req.body ?? {};
    c.budget ??= { scenarios: [] };
    if (c.budget.scenarios.length >= 8) return res.status(409).json({ error: 'TOO_MANY_SCENARIOS' });
    const s = {
      id: nextId('scn'), version: 1, label: String(b.label ?? `Scenario ${c.budget.scenarios.length + 1}`).slice(0, 80),
      currency: CURRENCIES.includes(b.currency) ? b.currency : 'GBP',
      termMonths: Math.min(Math.max(Number(b.termMonths) || 12, 1), 72),
      lines: cleanLines(b.lines).map((l, i) => ({ ...l, id: `ln-${i + 1}` })),
      fxAssumptions: (Array.isArray(b.fxAssumptions) ? b.fxAssumptions : []).slice(0, 6)
        .filter((a) => CURRENCIES.includes(a.from) && CURRENCIES.includes(a.to) && /^\d+(\.\d{1,6})?$/.test(String(a.rate)))
        .map((a) => ({ from: a.from, to: a.to, rate: String(a.rate), source: String(a.source ?? 'manual entry').slice(0, 80), date: String(a.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10), manual: true })),
      approval: null, actuals: [],
      createdBy: req.orgUser.name, createdAt: Date.now(), updatedAt: Date.now(),
    };
    c.budget.scenarios.push(s);
    histAppend(c, 'org_user', req.orgUser.id, req.orgUser.name, 'budget_scenario_created', { scenarioId: s.id });
    persistNow();
    res.status(201).json({ scenario: s, totals: computeScenarioTotals(s), honest: 'All figures are user-entered. ScoutBox never invents market values, resale projections or “expected returns”, and a scenario is planning support — not legal or financial approval.' });
  });

  orgRouter.get('/cases/:id/budget', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    res.json({
      scenarios: (c.budget?.scenarios ?? []).map((s) => ({ ...s, totals: computeScenarioTotals(s) })),
      note: 'Amounts are integer minor units (pence/cents). Mixed currencies combine only under explicitly stated manual rates.',
    });
  });

  orgRouter.put('/cases/:id/budget/scenarios/:sid', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    const s = c.budget?.scenarios.find((x) => x.id === req.params.sid);
    if (!s) return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    const b = req.body ?? {};
    if (b.label) s.label = String(b.label).slice(0, 80);
    if (b.termMonths) s.termMonths = Math.min(Math.max(Number(b.termMonths) || s.termMonths, 1), 72);
    if (b.lines) s.lines = cleanLines(b.lines).map((l, i) => ({ ...l, id: l.id ?? `ln-${i + 1}` }));
    if (b.fxAssumptions) {
      s.fxAssumptions = b.fxAssumptions.slice(0, 6)
        .filter((a) => CURRENCIES.includes(a.from) && CURRENCIES.includes(a.to) && /^\d+(\.\d{1,6})?$/.test(String(a.rate)))
        .map((a) => ({ from: a.from, to: a.to, rate: String(a.rate), source: String(a.source ?? 'manual entry').slice(0, 80), date: String(a.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10), manual: true }));
    }
    s.version += 1;
    s.updatedAt = Date.now();
    // Approval is version-specific: an edit after approval leaves the record
    // but marks it superseded.
    if (s.approval && s.approval.version !== s.version) s.approval = { ...s.approval, superseded: true };
    histAppend(c, 'org_user', req.orgUser.id, req.orgUser.name, 'budget_scenario_edited', { scenarioId: s.id, version: s.version });
    persistNow();
    res.json({ scenario: s, totals: computeScenarioTotals(s) });
  });

  orgRouter.post('/cases/:id/budget/scenarios/:sid/approve', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    if (!requireLead(req, res)) return;
    const s = c.budget?.scenarios.find((x) => x.id === req.params.sid);
    if (!s) return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    s.approval = { by: req.orgUser.name, byUserId: req.orgUser.id, at: Date.now(), version: s.version, superseded: false };
    histAppend(c, 'org_user', req.orgUser.id, req.orgUser.name, 'budget_scenario_approved', { scenarioId: s.id, version: s.version });
    persistNow();
    res.json({ scenario: s, note: 'Internal planning approval by a named lead for THIS version. It is not legal, regulatory or financial-services approval.' });
  });

  orgRouter.post('/cases/:id/budget/scenarios/:sid/actuals', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    const s = c.budget?.scenarios.find((x) => x.id === req.params.sid);
    if (!s) return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    const { lineId, amountMinor } = req.body ?? {};
    if (!s.lines.some((l) => l.id === lineId)) return res.status(404).json({ error: 'LINE_NOT_FOUND' });
    if (!validAmountMinor(amountMinor)) return res.status(400).json({ error: 'AMOUNT_INVALID', message: 'amountMinor must be an integer in minor units.' });
    s.actuals.push({ id: nextId('act'), lineId, amountMinor, at: Date.now(), recordedBy: req.orgUser.name });
    persistNow();
    res.json({ actuals: s.actuals });
  });
}
