/**
 * Recruitment analytics routes. Leads only; anyone else gets what a missing route would give. Figures carry
 * no note, comment, assessment or free text and are never broken down by colleague. Drill-down is
 * cursor-paged in a stable order. Nothing is stored: every figure is projected from other modules' records.
 */
import {
  RECRUITMENT_ANALYTICS_POLICY_VERSION,
  METRICS,
  METRIC_IDS,
  METRIC_FAMILIES,
  FAMILY_IDS,
  SMALL_N_MIN,
  TIME_SEMANTICS,
  GROUP_DIMENSIONS,
  PERSON_DIMENSIONS,
  WINDOW_PRESETS,
  DEFAULT_WINDOW,
  FORBIDDEN_METRIC_NAMES,
  assertMetricRegistry,
  resolveWindow,
} from './metrics.mjs';
import { buildReportingContext, buildDashboard, ROOM_PRIORITIES } from './dashboard.mjs';
import { STALL_THRESHOLDS, DEFAULT_STALL_DAYS } from './timeSeries.mjs';
import { SOURCE_CONTEXTS } from '../rooms/shared.mjs';
import { rateLimitedBody, limitCheck } from '../../platform/rateLimit.mjs';
import { metrics } from '../../enterprise/enterprise.mjs';
import { now } from '../../platform/clock.mjs';
import * as v from 'valibot';
import { inputOrRefuse, wholeNumberText } from '../../platform/schemas.mjs';

/** The metrics whose rows a director can page through. */
export const DRILLDOWN_METRICS = [
  'stalled_rooms',
  'decision_outstanding',
  'terminal_with_recorded_decision',
  'overdue_trial_reports',
];
const PAGE_MAX = 50;
const PAGE_DEFAULT = 25;

// Each parameter once, as text: a repeated `?window=a&window=b` arrives as a list and is refused. The vocabularies
// are judged by readQuery, whose codes the dashboard answers as a refusal it can show.
const param = v.optional(v.string());
const FILTERS = {
  groupBy: param,
  group_by: param,
  window: param,
  from: param,
  to: param,
  source: param,
  priority: param,
  brief: param,
  families: param,
  stallDays: param,
};
const DashboardQuery = v.strictObject({ ...FILTERS, simulateFailure: param });
const RowsQuery = v.strictObject({
  ...FILTERS,
  metric: param,
  limit: v.optional(wholeNumberText({ min: 1, max: PAGE_MAX })),
  cursor: v.optional(wholeNumberText()),
});
const QUERY = { root: 'query', fieldCodes: { limit: 'PAGE_LIMIT_INVALID', cursor: 'PAGE_CURSOR_INVALID' } };

export function registerAnalytics(ctx) {
  const { recruitmentReads, scoutingReads, orgRouter, requireLead, findPlayer, orgCanSee } = ctx;
  const reportingReads = { ...recruitmentReads, ...scoutingReads, discovery: ctx.discoveryReads };
  if (
    typeof recruitmentReads?.contacts?.forOrg !== 'function' ||
    typeof recruitmentReads?.offers?.forOrg !== 'function' ||
    typeof recruitmentReads?.signings?.forOrg !== 'function' ||
    typeof recruitmentReads?.signingPackages?.forOrg !== 'function'
  )
    throw new TypeError(
      'registerAnalytics needs recruitmentReads (contacts, offers, signings, signingPackages) from the data layer',
    );

  // Two counters only, neither of which could be read as a measure of anybody.
  metrics.analytics = {
    recruitment_analytics_read: 0,
    recruitment_analytics_rows_read: 0,
    policyVersion: RECRUITMENT_ANALYTICS_POLICY_VERSION,
  };
  const vmetric = (k, n = 1) => {
    metrics.analytics[k] = (metrics.analytics[k] ?? 0) + n;
  };

  // A metric with no limitation, a forbidden name or a private field stops the process before serving.
  const registryShape = assertMetricRegistry();

  const limited = limitCheck(ctx.rateLimit);
  const devFaults = process.env.NODE_ENV !== 'production';

  // ------------------------------------------------------------- validation

  /** Nothing is silently repaired: an unknown source context is a 400, not "everything instead". */
  function readQuery(q) {
    const groupBy = q.groupBy ?? q.group_by ?? null;
    if (groupBy) {
      if (PERSON_DIMENSIONS.includes(groupBy)) {
        return {
          error: 'GROUPING_BY_PERSON_REFUSED',
          status: 400,
          detail:
            'ScoutBox does not break recruitment analytics down by person. These figures measure the process, not any colleague’s performance, and a per-person breakdown of them would be a scout leaderboard.',
          allowed: GROUP_DIMENSIONS,
        };
      }
      if (!GROUP_DIMENSIONS.includes(groupBy)) {
        return {
          error: 'GROUPING_UNKNOWN',
          status: 400,
          detail: `Unknown grouping "${groupBy}".`,
          allowed: GROUP_DIMENSIONS,
        };
      }
    }

    const w = resolveWindow({ preset: q.window, from: q.from, to: q.to }, now());
    if (w.error) return { ...w, status: 400 };

    const filters = {};
    if (q.source != null && q.source !== '') {
      if (!SOURCE_CONTEXTS.includes(q.source)) {
        return {
          error: 'SOURCE_CONTEXT_UNKNOWN',
          status: 400,
          detail: `Unknown source context "${q.source}".`,
          allowed: SOURCE_CONTEXTS,
        };
      }
      filters.sourceContext = q.source;
    }
    if (q.priority != null && q.priority !== '') {
      if (!ROOM_PRIORITIES.includes(q.priority)) {
        return {
          error: 'ROOM_PRIORITY_UNKNOWN',
          status: 400,
          detail: `Unknown priority "${q.priority}".`,
          allowed: ROOM_PRIORITIES,
        };
      }
      filters.priority = q.priority;
    }
    if (q.brief != null && q.brief !== '') filters.briefId = q.brief;

    let families = FAMILY_IDS;
    if (q.families) {
      const asked = q.families
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const unknown = asked.filter((f) => !FAMILY_IDS.includes(f));
      if (unknown.length)
        return {
          error: 'FAMILY_UNKNOWN',
          status: 400,
          detail: `Unknown family: ${unknown.join(', ')}.`,
          allowed: FAMILY_IDS,
        };
      families = asked;
    }

    let stallDays = DEFAULT_STALL_DAYS;
    if (q.stallDays != null && q.stallDays !== '') {
      const n = Number(q.stallDays);
      if (!STALL_THRESHOLDS.includes(n)) {
        return {
          error: 'STALL_THRESHOLD_UNKNOWN',
          status: 400,
          detail: `Stall threshold must be one of ${STALL_THRESHOLDS.join(', ')} days.`,
          allowed: STALL_THRESHOLDS,
        };
      }
      stallDays = n;
    }

    return { window: w, filters, families, stallDays, groupBy: groupBy ?? null };
  }

  const contextFor = (req, parsed) =>
    buildReportingContext({
      reads: reportingReads,
      org: req.org,
      window: parsed.window,
      now: now(),
      orgCanSee,
      findPlayer,
      filters: parsed.filters,
    });

  // ------------------------------------------------------------- the catalogue

  /** Served so clients render definitions from the server's registry rather than a copy that can drift. */
  orgRouter.get('/recruitment-analytics/catalogue', (req, res) => {
    if (!requireLead(req, res)) return;
    res.json({
      policyVersion: RECRUITMENT_ANALYTICS_POLICY_VERSION,
      principle: 'Measure the recruitment process, not the worth of the player or the scout.',
      families: METRIC_FAMILIES,
      timeSemantics: TIME_SEMANTICS,
      smallNMinimum: SMALL_N_MIN,
      smallNNote: `A rate or a median over fewer than ${SMALL_N_MIN} records is withheld and shown as raw counts instead. Counts themselves are never hidden.`,
      groupDimensions: GROUP_DIMENSIONS,
      windows: Object.keys(WINDOW_PRESETS),
      defaultWindow: DEFAULT_WINDOW,
      sourceContexts: SOURCE_CONTEXTS,
      priorities: ROOM_PRIORITIES,
      stallThresholds: STALL_THRESHOLDS,
      registry: registryShape,
      metrics: METRIC_IDS.map((id) => {
        const m = METRICS[id];
        return {
          id: m.id,
          family: m.family,
          name: m.name,
          unit: m.unit,
          semantics: m.semantics,
          sources: m.sources,
          kind: m.distribution ? 'distribution' : m.ratio ? 'ratio' : 'count',
          associationOnly: !!m.association,
          limitation: m.limitation,
        };
      }),
      neverBuilt: {
        note: 'These do not exist in ScoutBox and are not planned.',
        names: FORBIDDEN_METRIC_NAMES,
        reason:
          'A single blended figure invites a decision it cannot support, and a per-person breakdown of process counts is a ranking of colleagues however it is labelled.',
      },
    });
  });

  // -------------------------------------------------------------- the dashboard

  orgRouter.get('/recruitment-analytics', (req, res) => {
    if (!requireLead(req, res)) return;
    if (limited('analytics_read', req.org.id)) return res.status(429).json(rateLimitedBody('analytics_read'));
    const query = inputOrRefuse(res, DashboardQuery, req.query ?? {}, QUERY);
    if (!query) return;
    const parsed = readQuery(query);
    if (parsed.error) return res.status(parsed.status).json(parsed);

    // Fault injection for the partial-failure test; unavailable in production.
    const fault = devFaults && query.simulateFailure ? query.simulateFailure : null;

    const context = contextFor(req, parsed);
    const payload = buildDashboard(context, { families: parsed.families, stallDays: parsed.stallDays, fault });
    vmetric('recruitment_analytics_read');
    // Declared on the wire, as Discover and Matching do: nothing here is ordered by merit.
    res.set('X-ScoutBox-Ordering', 'fixed_vocabulary_then_stable_id');
    res.json(payload);
  });

  // --------------------------------------------------------------- drill-down

  /**
   * The rows behind one figure, paged. The cursor is the next row's index; the order is stable (oldest first,
   * then id), so unchanged data never skips or repeats a row.
   */
  orgRouter.get('/recruitment-analytics/rows', (req, res) => {
    if (!requireLead(req, res)) return;
    if (limited('analytics_read', req.org.id)) return res.status(429).json(rateLimitedBody('analytics_read'));
    const query = inputOrRefuse(res, RowsQuery, req.query ?? {}, QUERY);
    if (!query) return;
    const metric = query.metric ?? '';
    if (!DRILLDOWN_METRICS.includes(metric)) {
      return res.status(400).json({
        error: 'METRIC_HAS_NO_ROWS',
        detail: `"${metric}" has no row-level view.`,
        allowed: DRILLDOWN_METRICS,
      });
    }
    const parsed = readQuery(query);
    if (parsed.error) return res.status(parsed.status).json(parsed);

    const family = METRICS[metric].family;
    const context = contextFor(req, parsed);
    const built = buildDashboard(context, { families: [family], stallDays: parsed.stallDays });
    const slot = built.data[family];
    if (slot?.error) return res.status(200).json({ ...slot, rows: [], total: 0 });

    const all = slot.metrics[metric]?.rows ?? [];
    const limit = query.limit === undefined ? PAGE_DEFAULT : Number(query.limit);
    const cursor = query.cursor === undefined ? 0 : Number(query.cursor);
    const page = all.slice(cursor, cursor + limit);
    vmetric('recruitment_analytics_rows_read');
    res.set('X-ScoutBox-Ordering', 'stable_oldest_first_then_id');
    res.json({
      policyVersion: RECRUITMENT_ANALYTICS_POLICY_VERSION,
      metric,
      limitation: METRICS[metric].limitation,
      total: all.length,
      limit,
      cursor,
      nextCursor: cursor + limit < all.length ? cursor + limit : null,
      rows: page,
    });
  });

  return {
    analyticsCatalogue: () => ({ policyVersion: RECRUITMENT_ANALYTICS_POLICY_VERSION, metrics: METRIC_IDS.length }),
    buildReportingContext: (org, opts) =>
      buildReportingContext({ reads: reportingReads, org, orgCanSee, findPlayer, ...opts }),
  };
}
