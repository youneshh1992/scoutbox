/**
 * M20 — Recruitment Analytics: registration and routes.
 *
 * Three rules govern everything here, in priority order. They are M18.2's
 * audit-log rules, deliberately reused rather than reinvented, because this is
 * the same kind of surface: an administrative projection over records other
 * modules own.
 *
 *   1. **Leads only.** A scout sees their own work in their own Rooms. The
 *      organisation-wide view is administrative. Everyone else — other
 *      organisations, players, guardians, Trust & Safety — gets exactly what a
 *      route that does not exist would give them.
 *   2. **No content, and no person.** A figure says what happened and how
 *      long it took. It never carries a note, a comment, an assessment or a
 *      decision's free text, and it is never broken down by the colleague who
 *      did the work. `groupBy=scout` is refused by name, not by accident.
 *   3. **Bounded and stable.** Drill-down is cursor-paged, at most 50 rows,
 *      in an order that does not change between two reads of the same data.
 *
 * M20 writes nothing. There is no analytics store, no materialised rollup and
 * no cache: every figure is projected from the Rooms, decisions, briefs,
 * reviews, watchlists and trials that M12–M19 already own. A number here can
 * therefore never disagree with the record it came from, because it IS the
 * record, read differently.
 */
import {
  RECRUITMENT_ANALYTICS_POLICY_VERSION, METRICS, METRIC_IDS, METRIC_FAMILIES, FAMILY_IDS,
  SMALL_N_MIN, TIME_SEMANTICS, GROUP_DIMENSIONS, PERSON_DIMENSIONS, WINDOW_PRESETS,
  DEFAULT_WINDOW, FORBIDDEN_METRIC_NAMES, assertMetricRegistry, resolveWindow,
} from './metrics.mjs';
import { buildReportingContext, buildDashboard, ROOM_PRIORITIES } from './dashboard.mjs';
import { STALL_THRESHOLDS, DEFAULT_STALL_DAYS } from './timeSeries.mjs';
import { SOURCE_CONTEXTS } from '../m17/shared.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { metrics } from '../m13/enterprise.mjs';

/** The metrics whose rows a director can page through. */
export const DRILLDOWN_METRICS = ['stalled_rooms', 'decision_outstanding', 'terminal_with_recorded_decision', 'overdue_trial_reports'];
const PAGE_MAX = 50;
const PAGE_DEFAULT = 25;

/**
 * The one M20 migration. Additive, idempotent, and incapable of contradicting
 * a Room: it creates no analytics store. All it does is guarantee the
 * collections M20 READS exist on a snapshot that predates them — `db.trials`
 * in particular has only ever been created by the seed, so a snapshot restored
 * without it would have thrown on the first trial read, M20 or not.
 */
export function migrateM20(db) {
  for (const k of ['trials', 'signings', 'requests', 'dynamicWatchlists', 'watchlistHistory']) db[k] ??= [];
}

export function registerAnalytics(ctx) {
  const { db, orgRouter, requireLead, findPlayer, orgCanSee } = ctx;
  migrateM20(db);

  // Counters only, and deliberately only two: how often the page was read and
  // how often a drill-down was opened. There is no counter here that could be
  // read as a measure of anybody — not a scout, not an organisation, not a
  // player. An operational metric about an analytics page must not itself
  // become an analytics page.
  metrics.analytics = {
    recruitment_analytics_read: 0,
    recruitment_analytics_rows_read: 0,
    policyVersion: RECRUITMENT_ANALYTICS_POLICY_VERSION,
  };
  const vmetric = (k, n = 1) => { metrics.analytics[k] = (metrics.analytics[k] ?? 0) + n; };

  // Boot assertion: the registry must be internally consistent before a single
  // number is served. In development this throws; a metric with no stated
  // limitation, a forbidden name or a private field in its declaration stops
  // the process rather than reaching a director.
  const registryShape = assertMetricRegistry();

  const now = () => Date.now();
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);
  const devFaults = process.env.NODE_ENV !== 'production';

  // ------------------------------------------------------------- validation

  /**
   * Parse the query into filters, refusing anything that would change every
   * number on the page without saying so. Nothing is silently repaired: an
   * unknown source context is a 400, not "we showed you everything instead".
   */
  function readQuery(q) {
    const groupBy = q.groupBy ?? q.group_by ?? null;
    if (groupBy) {
      if (PERSON_DIMENSIONS.includes(String(groupBy))) {
        return {
          error: 'GROUPING_BY_PERSON_REFUSED',
          status: 400,
          detail: 'ScoutBox does not break recruitment analytics down by person. These figures measure the process, not any colleague’s performance, and a per-person breakdown of them would be a scout leaderboard.',
          allowed: GROUP_DIMENSIONS,
        };
      }
      if (!GROUP_DIMENSIONS.includes(String(groupBy))) {
        return { error: 'GROUPING_UNKNOWN', status: 400, detail: `Unknown grouping "${groupBy}".`, allowed: GROUP_DIMENSIONS };
      }
    }

    const w = resolveWindow({ preset: q.window, from: q.from, to: q.to }, now());
    if (w.error) return { ...w, status: 400 };

    const filters = {};
    if (q.source != null && q.source !== '') {
      if (!SOURCE_CONTEXTS.includes(String(q.source))) {
        return { error: 'SOURCE_CONTEXT_UNKNOWN', status: 400, detail: `Unknown source context "${q.source}".`, allowed: SOURCE_CONTEXTS };
      }
      filters.sourceContext = String(q.source);
    }
    if (q.priority != null && q.priority !== '') {
      if (!ROOM_PRIORITIES.includes(String(q.priority))) {
        return { error: 'ROOM_PRIORITY_UNKNOWN', status: 400, detail: `Unknown priority "${q.priority}".`, allowed: ROOM_PRIORITIES };
      }
      filters.priority = String(q.priority);
    }
    if (q.brief != null && q.brief !== '') filters.briefId = String(q.brief);

    let families = FAMILY_IDS;
    if (q.families) {
      const asked = String(q.families).split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = asked.filter((f) => !FAMILY_IDS.includes(f));
      if (unknown.length) return { error: 'FAMILY_UNKNOWN', status: 400, detail: `Unknown family: ${unknown.join(', ')}.`, allowed: FAMILY_IDS };
      families = asked;
    }

    let stallDays = DEFAULT_STALL_DAYS;
    if (q.stallDays != null && q.stallDays !== '') {
      const n = Number(q.stallDays);
      if (!STALL_THRESHOLDS.includes(n)) {
        return { error: 'STALL_THRESHOLD_UNKNOWN', status: 400, detail: `Stall threshold must be one of ${STALL_THRESHOLDS.join(', ')} days.`, allowed: STALL_THRESHOLDS };
      }
      stallDays = n;
    }

    return { window: w, filters, families, stallDays, groupBy: groupBy ?? null };
  }

  const contextFor = (req, parsed) => buildReportingContext({
    db, org: req.org, window: parsed.window, now: now(), orgCanSee, findPlayer, filters: parsed.filters,
  });

  // ------------------------------------------------------------- the catalogue

  /**
   * What every number on this page means, before any number is shown. Served
   * separately so a client renders definitions from the server's registry
   * rather than carrying its own copy that can drift.
   */
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
          id: m.id, family: m.family, name: m.name, unit: m.unit,
          semantics: m.semantics, sources: m.sources,
          kind: m.distribution ? 'distribution' : (m.ratio ? 'ratio' : 'count'),
          associationOnly: !!m.association,
          limitation: m.limitation,
        };
      }),
      neverBuilt: {
        note: 'These do not exist in ScoutBox and are not planned.',
        names: FORBIDDEN_METRIC_NAMES,
        reason: 'A single blended figure invites a decision it cannot support, and a per-person breakdown of process counts is a ranking of colleagues however it is labelled.',
      },
    });
  });

  // -------------------------------------------------------------- the dashboard

  orgRouter.get('/recruitment-analytics', (req, res) => {
    if (!requireLead(req, res)) return;
    if (limited('analytics_read', req.org.id)) return res.status(429).json(rateLimitedBody('analytics_read'));
    const parsed = readQuery(req.query ?? {});
    if (parsed.error) return res.status(parsed.status).json(parsed);

    // Fault injection is the M18.2 mechanism, and it exists so the
    // partial-failure path is exercised by a test rather than asserted in
    // prose. It is unavailable in production, by name.
    const fault = devFaults && req.query?.simulateFailure ? String(req.query.simulateFailure) : null;

    const context = contextFor(req, parsed);
    const payload = buildDashboard(context, { families: parsed.families, stallDays: parsed.stallDays, fault });
    vmetric('recruitment_analytics_read');
    // Declared on the wire, as Discover and Matching do. Nothing on this page
    // is ordered by how good anything is.
    res.set('X-ScoutBox-Ordering', 'fixed_vocabulary_then_stable_id');
    res.json(payload);
  });

  // --------------------------------------------------------------- drill-down

  /**
   * The rows behind one figure, paged. Cursor is the index of the next row —
   * the underlying order is already stable (oldest first, then id), so an
   * offset cursor cannot skip or repeat a row between two reads of unchanged
   * data, and a changed dataset is reported rather than papered over.
   */
  orgRouter.get('/recruitment-analytics/rows', (req, res) => {
    if (!requireLead(req, res)) return;
    if (limited('analytics_read', req.org.id)) return res.status(429).json(rateLimitedBody('analytics_read'));
    const metric = String(req.query?.metric ?? '');
    if (!DRILLDOWN_METRICS.includes(metric)) {
      return res.status(400).json({ error: 'METRIC_HAS_NO_ROWS', detail: `"${metric}" has no row-level view.`, allowed: DRILLDOWN_METRICS });
    }
    const parsed = readQuery(req.query ?? {});
    if (parsed.error) return res.status(parsed.status).json(parsed);

    const family = METRICS[metric].family;
    const context = contextFor(req, parsed);
    const built = buildDashboard(context, { families: [family], stallDays: parsed.stallDays });
    const slot = built.data[family];
    if (slot?.error) return res.status(200).json({ ...slot, rows: [], total: 0 });

    const all = slot.metrics[metric]?.rows ?? [];
    const limit = Math.min(Math.max(Number(req.query?.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
    const cursor = Math.max(Number(req.query?.cursor) || 0, 0);
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
    buildReportingContext: (org, opts) => buildReportingContext({ db, org, orgCanSee, findPlayer, ...opts }),
  };
}
