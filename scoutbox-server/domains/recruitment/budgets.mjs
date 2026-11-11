// Recruitment budget and deal scenarios.
// Money is integer minor units end to end; market values are never invented.
import { convertMinor, CURRENCIES, BUDGET_LINE_KINDS as LINE_KINDS, BUDGET_SCHEDULES as SCHEDULES } from './money.mjs';
import * as v from 'valibot';
import { dateOnly, flag, id, inputOrRefuse, oneOf, requiredText, text, wholeNumber } from '../platform/schemas.mjs';

const BUDGET_LIMITS = Object.freeze({ label: 80, assumption: 200, source: 80, lines: 30, fx: 6, termMonths: 72 });
// A stated rate is a decimal string (convertMinor), never a float that has already lost digits.
const isRate = (s) => /^\d+(\.\d{1,6})?$/.test(s);
// An absent currency is GBP; an unknown one is refused, never read as GBP.
const currency = v.nullish(oneOf(CURRENCIES));
const BudgetLine = v.strictObject({
  id: v.nullish(id),
  kind: oneOf(LINE_KINDS),
  label: v.nullish(text(BUDGET_LIMITS.label)),
  amountMinor: wholeNumber({ min: 0 }),
  currency,
  schedule: oneOf(SCHEDULES),
  confirmed: v.nullish(flag),
  conditional: v.nullish(v.strictObject({ assumption: requiredText(BUDGET_LIMITS.assumption) })),
});
const FxAssumption = v.strictObject({
  from: oneOf(CURRENCIES),
  to: oneOf(CURRENCIES),
  rate: v.pipe(v.string(), v.check(isRate, 'must be a decimal with at most six places')),
  source: v.nullish(text(BUDGET_LIMITS.source)),
  date: v.nullish(dateOnly),
});
const SCENARIO_FIELDS = {
  label: v.nullish(text(BUDGET_LIMITS.label)),
  termMonths: v.nullish(wholeNumber({ min: 1, max: BUDGET_LIMITS.termMonths })),
  lines: v.nullish(v.pipe(v.array(BudgetLine), v.maxLength(BUDGET_LIMITS.lines))),
  fxAssumptions: v.nullish(v.pipe(v.array(FxAssumption), v.maxLength(BUDGET_LIMITS.fx))),
};
const NewScenario = v.strictObject({ ...SCENARIO_FIELDS, currency });
const ScenarioEdit = v.strictObject(SCENARIO_FIELDS);
const Approval = v.strictObject({});
const Actual = v.strictObject({ lineId: id, amountMinor: wholeNumber() });
const BUDGET_CODES = { fieldCodes: { 'lines.*': 'LINES_INVALID', amountMinor: 'AMOUNT_INVALID' } };

// Exported for fixture tests. Integer arithmetic only.
export function computeScenarioTotals(scenario) {
  const termMonths = scenario.termMonths;
  const perCurrency = {};
  const bucket = (cur) => (perCurrency[cur] ??= { confirmedMinor: 0, estimatedMinor: 0, conditionalCount: 0 });
  const occurrences = (schedule) =>
    schedule === 'one_off'
      ? 1
      : schedule === 'monthly'
        ? termMonths
        : schedule === 'annual'
          ? Math.ceil(termMonths / 12)
          : /* weekly */ Math.round((termMonths * 52) / 12);
  for (const l of scenario.lines) {
    const b = bucket(l.currency);
    if (l.conditional) {
      b.conditionalCount++;
      continue;
    } // unknown stays unknown — never summed
    const total = l.amountMinor * occurrences(l.schedule);
    if (l.confirmed) b.confirmedMinor += total;
    else b.estimatedMinor += total;
  }
  // A combined total only when explicit FX assumptions cover every currency.
  let combined = null;
  const currencies = Object.keys(perCurrency);
  if (currencies.length === 1) {
    combined = { currency: currencies[0], ...perCurrency[currencies[0]], viaFx: false };
  } else if (currencies.length > 1) {
    const target = scenario.currency;
    let confirmedMinor = 0,
      estimatedMinor = 0,
      ok = true;
    const applied = [];
    for (const cur of currencies) {
      if (cur === target) {
        confirmedMinor += perCurrency[cur].confirmedMinor;
        estimatedMinor += perCurrency[cur].estimatedMinor;
        continue;
      }
      const fx = (scenario.fxAssumptions ?? []).find((a) => a.from === cur && a.to === target);
      if (!fx) {
        ok = false;
        break;
      }
      const c1 = convertMinor(perCurrency[cur].confirmedMinor, fx.rate);
      const c2 = convertMinor(perCurrency[cur].estimatedMinor, fx.rate);
      if (c1 === null || c2 === null) {
        ok = false;
        break;
      }
      confirmedMinor += c1;
      estimatedMinor += c2;
      applied.push(fx);
    }
    combined = ok
      ? {
          currency: target,
          confirmedMinor,
          estimatedMinor,
          viaFx: true,
          fxApplied: applied,
          fxNote: 'Converted with the stated manual assumptions — not market rates.',
        }
      : {
          unavailable: true,
          reason: 'Currencies mixed without a stated exchange-rate assumption for each — totals stay per-currency.',
        };
  }
  return {
    termMonths,
    perCurrency,
    combined,
    conditionalLines: scenario.lines
      .filter((l) => l.conditional)
      .map((l) => ({
        label: l.label,
        amountMinor: l.amountMinor,
        currency: l.currency,
        schedule: l.schedule,
        assumption: l.conditional.assumption,
      })),
    conditionalNote: 'Conditional amounts are listed with their assumptions and EXCLUDED from every total.',
  };
}

export function registerBudgets(ctx) {
  const {
    orgRouter,
    nextId,
    isLead,
    requireLead,
    canViewFinance,
    recruitmentCases, // a budget change is one explicit write of its case
  } = ctx;
  const { cases } = recruitmentCases;
  /** The bookkeeping of a budget act by the club user on the request: one history entry. */
  const byStaff = (req, action, detail) => ({
    history: [
      {
        id: nextId('aud'),
        at: Date.now(),
        byKind: 'org_user',
        byId: req.orgUser.id,
        byName: req.orgUser.name,
        action,
        detail,
      },
    ],
  });

  function caseFor(req, res) {
    const found = ctx.recruitmentReads.cases.byId(req.params.id);
    const c = found && found.orgId === req.org.id ? found : null;
    if (!c) {
      res.status(404).json({ error: 'CASE_NOT_FOUND' });
      return null;
    }
    const access =
      !c.restricted ||
      c.ownerUserId === req.orgUser.id ||
      (c.assignments ?? []).some((a) => a.userId === req.orgUser.id) ||
      isLead(req.orgUser);
    if (!access) {
      res.status(403).json({ error: 'CASE_RESTRICTED' });
      return null;
    }
    if (!canViewFinance(req.orgUser)) {
      res
        .status(403)
        .json({ error: 'FINANCE_ROLE_REQUIRED', message: 'Deal amounts are visible to leads and finance roles only.' });
      return null;
    }
    return c;
  }

  /** Lines as stored, from lines the schema has accepted. */
  const storedLines = (lines) =>
    lines.map((l) => ({
      id: l.id ?? null,
      kind: l.kind,
      label: l.label?.trim() || l.kind,
      amountMinor: l.amountMinor,
      currency: l.currency ?? 'GBP',
      schedule: l.schedule,
      confirmed: l.confirmed === true,
      conditional: l.conditional ? { assumption: l.conditional.assumption.trim() } : null,
    }));

  /** Stated FX rates as stored: a manual entry, dated today when no day is given. */
  const storedFx = (fx) =>
    fx.map((a) => ({
      from: a.from,
      to: a.to,
      rate: a.rate,
      source: a.source?.trim() || 'manual entry',
      date: a.date ?? new Date().toISOString().slice(0, 10),
      manual: true,
    }));

  orgRouter.post('/cases/:id/budget/scenarios', (req, res) => {
    const c = caseFor(req, res);
    if (!c) return;
    const b = inputOrRefuse(res, NewScenario, req.body ?? {}, BUDGET_CODES);
    if (!b) return;
    const existing = c.budget?.scenarios ?? [];
    if (existing.length >= 8) return res.status(409).json({ error: 'TOO_MANY_SCENARIOS' });
    const s = {
      id: nextId('scn'),
      version: 1,
      label: b.label?.trim() || `Scenario ${existing.length + 1}`,
      currency: b.currency ?? 'GBP',
      termMonths: b.termMonths ?? 12,
      lines: storedLines(b.lines ?? []).map((l, i) => ({ ...l, id: `ln-${i + 1}` })),
      fxAssumptions: storedFx(b.fxAssumptions ?? []),
      approval: null,
      actuals: [],
      createdBy: req.orgUser.name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    cases.addScenario(c.id, { scenario: s }, byStaff(req, 'budget_scenario_created', { scenarioId: s.id }));
    res.status(201).json({
      scenario: s,
      totals: computeScenarioTotals(s),
      honest:
        'All figures are user-entered. ScoutBox never invents market values, resale projections or “expected returns”, and a scenario is planning support — not legal or financial approval.',
    });
  });

  orgRouter.get('/cases/:id/budget', (req, res) => {
    const c = caseFor(req, res);
    if (!c) return;
    res.json({
      scenarios: (c.budget?.scenarios ?? []).map((s) => ({ ...s, totals: computeScenarioTotals(s) })),
      note: 'Amounts are integer minor units (pence/cents). Mixed currencies combine only under explicitly stated manual rates.',
    });
  });

  orgRouter.put('/cases/:id/budget/scenarios/:sid', (req, res) => {
    const c = caseFor(req, res);
    if (!c) return;
    if (!c.budget?.scenarios.some((x) => x.id === req.params.sid))
      return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    const b = inputOrRefuse(res, ScenarioEdit, req.body ?? {}, BUDGET_CODES);
    if (!b) return;
    const lines = b.lines ? storedLines(b.lines).map((l, i) => ({ ...l, id: l.id ?? `ln-${i + 1}` })) : null;
    if (lines && new Set(lines.map((l) => l.id)).size !== lines.length)
      return res.status(400).json({ error: 'LINES_INVALID', message: 'Each budget line needs its own id.' });
    const held = c.budget.scenarios.find((x) => x.id === req.params.sid);
    // A new version; approval is version-specific, so an edit after approval leaves the record but marks it superseded.
    const fresh = cases.editScenario(
      c.id,
      {
        scenarioId: held.id,
        label: b.label?.trim() || undefined,
        termMonths: b.termMonths ?? undefined,
        lines: lines ?? undefined,
        fxAssumptions: b.fxAssumptions ? storedFx(b.fxAssumptions) : undefined,
        at: Date.now(),
      },
      byStaff(req, 'budget_scenario_edited', { scenarioId: held.id, version: held.version + 1 }),
    );
    const s = fresh.budget.scenarios.find((x) => x.id === req.params.sid);
    res.json({ scenario: s, totals: computeScenarioTotals(s) });
  });

  orgRouter.post('/cases/:id/budget/scenarios/:sid/approve', (req, res) => {
    const c = caseFor(req, res);
    if (!c) return;
    if (!requireLead(req, res)) return;
    if (!c.budget?.scenarios.some((x) => x.id === req.params.sid))
      return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    if (!inputOrRefuse(res, Approval, req.body ?? {})) return;
    const held = c.budget.scenarios.find((x) => x.id === req.params.sid);
    const fresh = cases.approveScenario(
      c.id,
      { scenarioId: held.id, by: req.orgUser.name, byUserId: req.orgUser.id, at: Date.now() },
      byStaff(req, 'budget_scenario_approved', { scenarioId: held.id, version: held.version }),
    );
    const s = fresh.budget.scenarios.find((x) => x.id === req.params.sid);
    res.json({
      scenario: s,
      note: 'Internal planning approval by a named lead for THIS version. It is not legal, regulatory or financial-services approval.',
    });
  });

  orgRouter.post('/cases/:id/budget/scenarios/:sid/actuals', (req, res) => {
    const c = caseFor(req, res);
    if (!c) return;
    const s = c.budget?.scenarios.find((x) => x.id === req.params.sid);
    if (!s) return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    const body = inputOrRefuse(res, Actual, req.body ?? {}, BUDGET_CODES);
    if (!body) return;
    const { lineId, amountMinor } = body;
    if (!s.lines.some((l) => l.id === lineId)) return res.status(404).json({ error: 'LINE_NOT_FOUND' });
    const fresh = cases.recordActual(c.id, {
      scenarioId: s.id,
      actual: { id: nextId('act'), lineId, amountMinor, at: Date.now(), recordedBy: req.orgUser.name },
    });
    res.json({ actuals: fresh.budget.scenarios.find((x) => x.id === s.id).actuals });
  });
}
