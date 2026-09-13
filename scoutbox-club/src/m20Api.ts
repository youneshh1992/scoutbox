// M20 typed client (org side): Recruitment Analytics and the Director Dashboard.
//
// The rule this whole module exists to keep:
//
//     Measure the recruitment process, not the worth of the player
//     or the scout.
//
// What the dashboard IS: how the club's recruitment WORK moves. What is in
// flight, what has stopped moving, how long each step takes, whether decisions
// were written down, and whether the demand the club itself wrote down is
// being covered.
//
// What it is NOT, and what nothing in this module may ever become:
//   • A score. There is no Recruitment Score, Scout Score, Player Success
//     Score, Recruitment Efficiency Score, Talent Conversion Score, Club
//     Intelligence Score, or any other blended overall number. Not one.
//   • A leaderboard. No metric is broken down by person, there is no query
//     parameter that produces one, and asking for `groupBy=scout` is refused
//     by name rather than quietly ignored.
//   • A reading of anybody's notes. Reason CODES are a vocabulary the club
//     chose from a visible list and may be counted. The private note beside
//     them is not analytics data and never reaches this client.
//   • A claim of cause. Where the server compares groups it labels the figure
//     association-only and ships the sentence that says so; this client
//     renders that sentence with the number, never the number alone.
//
// The server is the only authority. This module computes no metric, applies
// no suppression of its own and derives no figure a panel does not receive:
// a client that recomputes a rate is a second definition waiting to drift.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM20 } from './m20Demo';

export const FAMILY_IDS = ['pipeline', 'duration', 'aging', 'decision_record', 'coverage', 'source', 'watchlist'] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];

export const WINDOW_PRESETS = ['last_7_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days'] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];
export const DEFAULT_WINDOW: WindowPreset = 'last_90_days';
export const STALL_THRESHOLDS = [14, 30, 90] as const;

/**
 * A figure, exactly as the server produced it.
 *
 * The three absences are the point. `empty` means nothing happened; `value: 0`
 * means it happened and nothing met the condition; `suppressed` means there
 * were too few records to express as a rate, and the raw counts are shown
 * instead. A client that renders all three as "0%" is the failure this shape
 * exists to prevent, so nothing here is coerced to a number.
 */
export interface Figure {
  n: number;
  value: number | null;
  numerator?: number;
  empty: boolean;
  suppressed: boolean;
  minimum?: number;
}

/** A duration: median and interquartile range, never a mean. */
export interface Distribution {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min?: number;
  max?: number;
  empty: boolean;
  suppressed: boolean;
  minimum?: number;
  /** How many records could not contribute because they have not finished. */
  excluded: number;
}

/** Every metric payload carries its own definition and its own caveat. */
export interface MetricMeta {
  id: string;
  family: FamilyId;
  name: string;
  unit: string;
  semantics: 'point_in_time' | 'window_entry' | 'window_completion';
  sources: string[];
  ratio?: boolean;
  distribution?: boolean;
  association?: boolean;
  /** Rendered beside the number. Not a tooltip, not a footnote. */
  limitation: string;
}

export type Metric = MetricMeta & Partial<Figure> & Partial<Distribution> & Record<string, unknown>;

export interface Family {
  family: FamilyId;
  label: string;
  filtersHonoured?: string[];
  /** Filters this family could not apply — declared, never silently dropped. */
  filtersNotApplicable?: string[];
  metrics?: Record<string, Metric>;
  error?: string;
  detail?: string;
}

export interface Window {
  preset: string;
  from: string;
  to: string;
  days: number;
}

/**
 * A period-over-period comparison of one count.
 *
 * `percentChange` is null when the previous period was zero: a rise from
 * nothing has no percentage, and rendering one produces Infinity or a
 * meaningless 100%. `upFromZero` is what the client renders instead.
 */
export interface Comparison {
  current: number;
  previous: number;
  change: number;
  percentChange: number | null;
  upFromZero: boolean;
  unchangedAtZero: boolean;
}

export interface Trend {
  previousWindow: Window;
  note: string;
  rooms_opened: Comparison;
  rooms_ended: Comparison;
  decisions_recorded: Comparison;
}

export interface Dashboard {
  policyVersion: number;
  generatedAt: number;
  /** When these figures were worked out. Read-time, not a live stream. */
  calculatedAt: number;
  liveStream: boolean;
  trend: Trend;
  window: Window;
  filters: { filter: string; value: string }[];
  smallNMinimum: number;
  timeSemantics: Record<string, string>;
  groupDimensions: string[];
  families: FamilyId[];
  /** True when at least one family could not be computed. */
  partial: boolean;
  unavailable: FamilyId[];
  note: string;
  data: Record<string, Family>;
}

export interface CatalogueEntry {
  id: string;
  family: FamilyId;
  name: string;
  unit: string;
  semantics: string;
  sources: string[];
  kind: 'count' | 'ratio' | 'distribution';
  associationOnly: boolean;
  limitation: string;
}

export interface Catalogue {
  policyVersion: number;
  principle: string;
  families: { id: FamilyId; label: string }[];
  timeSemantics: Record<string, string>;
  smallNMinimum: number;
  smallNNote: string;
  groupDimensions: string[];
  windows: string[];
  defaultWindow: string;
  sourceContexts: string[];
  priorities: string[];
  stallThresholds: number[];
  metrics: CatalogueEntry[];
  neverBuilt: { note: string; names: string[]; reason: string };
}

export interface DrilldownRow {
  roomId?: string;
  trialId?: string;
  status?: string;
  idleDays?: number;
  overdueDays?: number;
  playerId?: string | null;
  playerName?: string | null;
}

export interface Drilldown {
  policyVersion: number;
  metric: string;
  limitation: string;
  total: number;
  limit: number;
  cursor: number;
  nextCursor: number | null;
  rows: DrilldownRow[];
}

export interface DashboardFilters {
  window?: string;
  from?: string;
  to?: string;
  source?: string;
  priority?: string;
  brief?: string;
  stallDays?: number;
  families?: string;
}

/**
 * A refusal is an ANSWER, not a crash. The dashboard re-renders with the
 * server's own words — particularly for the person-grouping refusal, whose
 * whole value is that it explains why ScoutBox will not answer.
 */
export type DashboardOutcome =
  | { ok: true; value: Dashboard }
  | { ok: false; error: string; detail: string; allowed?: (string | number)[] };

export interface M20Api {
  catalogue(s: Session): Promise<Catalogue>;
  dashboard(s: Session, filters?: DashboardFilters): Promise<DashboardOutcome>;
  rows(s: Session, metric: string, params?: DashboardFilters & { cursor?: number; limit?: number }): Promise<Drilldown>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v));
  const s = out.toString();
  return s ? `?${s}` : '';
};

/** The refusals a director can actually cause, kept as answers rather than errors. */
const ANSWERABLE_REFUSALS = new Set([
  'GROUPING_BY_PERSON_REFUSED', 'GROUPING_UNKNOWN', 'WINDOW_UNKNOWN', 'WINDOW_INVALID',
  'SOURCE_CONTEXT_UNKNOWN', 'ROOM_PRIORITY_UNKNOWN', 'STALL_THRESHOLD_UNKNOWN', 'FAMILY_UNKNOWN',
]);

export const httpM20: M20Api = {
  catalogue: (s) => req('/org/recruitment-analytics/catalogue', { headers: H(s) }),
  async dashboard(s, filters = {}) {
    const res = await fetch(`${API_URL}/org/recruitment-analytics${qs({ ...filters })}`, { headers: H(s) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 400 && ANSWERABLE_REFUSALS.has(String((body as { error?: string })?.error))) {
      const b = body as { error: string; detail?: string; allowed?: (string | number)[] };
      return { ok: false, error: b.error, detail: String(b.detail ?? ''), allowed: b.allowed };
    }
    if (!res.ok) throw ApiError.fromResponse(res, body);
    return { ok: true, value: body as Dashboard };
  },
  rows: (s, metric, params = {}) => req(`/org/recruitment-analytics/rows${qs({ metric, ...params })}`, { headers: H(s) }),
};

export const m20: M20Api = DEMO_MODE ? demoM20 : httpM20;

// ------------------------------------------------------------ presentation

/**
 * Format a figure for display, given the words for each of its three
 * absences. Nothing here invents a number: a suppressed rate returns its raw
 * counts, and an empty one returns the empty phrase.
 */
export function figureText(
  f: Figure | undefined,
  words: { empty: string; suppressed: (n: number, num: number, min: number) => string; percent: (pct: number, n: number) => string },
): string {
  if (!f) return words.empty;
  if (f.empty) return words.empty;
  if (f.suppressed) return words.suppressed(f.n, f.numerator ?? 0, f.minimum ?? 5);
  return words.percent(Math.round((f.value ?? 0) * 100), f.n);
}

/**
 * A period-over-period change in words. The zero case is the reason this
 * exists: "up 2, from none last period" is true, and "+100%" is not.
 */
export function comparisonText(
  c: Comparison | undefined,
  words: { flat: string; upFromZero: (change: number) => string; changed: (change: number, pct: number) => string },
): string {
  if (!c) return words.flat;
  if (c.unchangedAtZero || c.change === 0) return words.flat;
  if (c.percentChange === null) return words.upFromZero(c.change);
  return words.changed(c.change, Math.round(c.percentChange * 100));
}

/** Round a day count for display without ever rounding a real duration to zero. */
export const dayText = (d: number | null | undefined): string => {
  if (d == null) return '—';
  if (d < 1) return '<1';
  return String(Math.round(d));
};

/** Is this metric one the server will page rows for? */
export const DRILLDOWN_METRICS = ['stalled_rooms', 'decision_outstanding', 'terminal_with_recorded_decision', 'overdue_trial_reports'];
