// F9 — Recruitment budget and deal scenarios (moved from m13/planning.mjs).
// Money is integer minor units end to end; market values are never invented.
import { convertMinor, BUDGET_LINE_KINDS as LINE_KINDS, BUDGET_SCHEDULES as SCHEDULES } from '../../m13/shared.mjs';
import { readDateOnly } from '../../temporal.mjs';

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

export function registerBudgets(ctx) {
  const {
    orgRouter, nextId, persistNow, histAppend, isLead, requireLead, canViewFinance,
    validAmountMinor, CURRENCIES,
    recruitmentCases, // S8b: a budget change is one explicit write of its case (cases.update)
  } = ctx;
  const { cases } = recruitmentCases;


  function caseFor(req, res) {
    const found = ctx.recruitmentReads.cases.byId(req.params.id);
    const c = found && found.orgId === req.org.id ? found : null;
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
        id: typeof l.id === 'string' && l.id ? l.id : null, kind: l.kind, label: String(l.label || l.kind).slice(0, 80),
        amountMinor: l.amountMinor, currency: CURRENCIES.includes(l.currency) ? l.currency : 'GBP',
        schedule: l.schedule, confirmed: l.confirmed === true,
        conditional: l.conditional?.assumption ? { assumption: String(l.conditional.assumption).slice(0, 200) } : null,
      });
    }
    return out;
  }

  /** Up to six stated FX rates: known currencies, a decimal rate, a real calendar day (today when none is given). */
  function cleanFx(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, 6)
      .filter((a) => CURRENCIES.includes(a?.from) && CURRENCIES.includes(a?.to) && /^\d+(\.\d{1,6})?$/.test(String(a.rate)))
      .map((a) => ({ from: a.from, to: a.to, rate: String(a.rate), source: String(a.source ?? 'manual entry').slice(0, 80), date: a.date === undefined || a.date === null ? new Date().toISOString().slice(0, 10) : readDateOnly(String(a.date).slice(0, 10)), manual: true }))
      .filter((a) => a.date !== null);
  }

  ctx.computeScenarioTotals = computeScenarioTotals;

  orgRouter.post('/cases/:id/budget/scenarios', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    const b = req.body ?? {};
    const existing = c.budget?.scenarios ?? [];
    if (existing.length >= 8) return res.status(409).json({ error: 'TOO_MANY_SCENARIOS' });
    const s = {
      id: nextId('scn'), version: 1, label: String(b.label ?? `Scenario ${existing.length + 1}`).slice(0, 80),
      currency: CURRENCIES.includes(b.currency) ? b.currency : 'GBP',
      termMonths: Math.min(Math.max(Number(b.termMonths) || 12, 1), 72),
      lines: cleanLines(b.lines).map((l, i) => ({ ...l, id: `ln-${i + 1}` })),
      fxAssumptions: cleanFx(b.fxAssumptions),
      approval: null, actuals: [],
      createdBy: req.orgUser.name, createdAt: Date.now(), updatedAt: Date.now(),
    };
    cases.update(c.id, (d) => {
      d.budget ??= { scenarios: [] };
      d.budget.scenarios.push(s);
      histAppend(d, 'org_user', req.orgUser.id, req.orgUser.name, 'budget_scenario_created', { scenarioId: s.id });
    });
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
    if (!c.budget?.scenarios.some((x) => x.id === req.params.sid)) return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    const b = req.body ?? {};
    const lines = b.lines ? cleanLines(b.lines).map((l, i) => ({ ...l, id: l.id ?? `ln-${i + 1}` })) : null;
    if (lines && new Set(lines.map((l) => l.id)).size !== lines.length) return res.status(400).json({ error: 'LINES_INVALID', message: 'Each budget line needs its own id.' });
    const fresh = cases.update(c.id, (d) => {
      const s = d.budget.scenarios.find((x) => x.id === req.params.sid);
      if (b.label) s.label = String(b.label).slice(0, 80);
      if (b.termMonths) s.termMonths = Math.min(Math.max(Number(b.termMonths) || s.termMonths, 1), 72);
      if (lines) s.lines = lines;
      if (b.fxAssumptions) s.fxAssumptions = cleanFx(b.fxAssumptions);
      s.version += 1;
      s.updatedAt = Date.now();
      // Approval is version-specific: an edit after approval leaves the record
      // but marks it superseded.
      if (s.approval && s.approval.version !== s.version) s.approval = { ...s.approval, superseded: true };
      histAppend(d, 'org_user', req.orgUser.id, req.orgUser.name, 'budget_scenario_edited', { scenarioId: s.id, version: s.version });
    });
    const s = fresh.budget.scenarios.find((x) => x.id === req.params.sid);
    persistNow();
    res.json({ scenario: s, totals: computeScenarioTotals(s) });
  });

  orgRouter.post('/cases/:id/budget/scenarios/:sid/approve', (req, res) => {
    const c = caseFor(req, res); if (!c) return;
    if (!requireLead(req, res)) return;
    if (!c.budget?.scenarios.some((x) => x.id === req.params.sid)) return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    const fresh = cases.update(c.id, (d) => {
      const sc = d.budget.scenarios.find((x) => x.id === req.params.sid);
      sc.approval = { by: req.orgUser.name, byUserId: req.orgUser.id, at: Date.now(), version: sc.version, superseded: false };
      histAppend(d, 'org_user', req.orgUser.id, req.orgUser.name, 'budget_scenario_approved', { scenarioId: sc.id, version: sc.version });
    });
    const s = fresh.budget.scenarios.find((x) => x.id === req.params.sid);
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
    const fresh = cases.update(c.id, (d) => {
      d.budget.scenarios.find((x) => x.id === s.id).actuals.push({ id: nextId('act'), lineId, amountMinor, at: Date.now(), recordedBy: req.orgUser.name });
    });
    persistNow();
    res.json({ actuals: fresh.budget.scenarios.find((x) => x.id === s.id).actuals });
  });
}
