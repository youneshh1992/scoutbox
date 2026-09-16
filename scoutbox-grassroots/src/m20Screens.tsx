// M20 org screen — the Director Dashboard.
//
// One sentence governs every pixel below:
//
//     Measure the recruitment process, not the worth of the player
//     or the scout.
//
// So three things are true of this screen and must stay true:
//
//   • Every panel prints its own limitation, next to the number, in the same
//     type as the number. Not a tooltip, not an asterisk, not a help page. A
//     figure whose caveat is one click away is a figure without a caveat.
//
//   • Nothing here is broken down by person, and there is no control that
//     could produce such a breakdown. The filter row offers window, source,
//     priority and brief — properties of the WORK.
//
//   • A withheld figure looks different from a zero, and both look different
//     from "nothing happened". The screen renders whichever of the three the
//     server sent and never coerces one into another.
//
// This screen computes nothing. Every count, rate, median and suppression
// decision arrives from the server: a client that recalculates a rate is a
// second definition waiting to disagree with the first.
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { type Session } from './api';
import {
  m20, dayText, figureText, comparisonText, DRILLDOWN_METRICS, DEFAULT_WINDOW, WINDOW_PRESETS, STALL_THRESHOLDS,
  type Catalogue, type Comparison, type Dashboard, type DashboardFilters, type Distribution,
  type Drilldown, type Family, type Figure, type Metric,
} from './m20Api';
import { t, fmtDate, fmtDateTime } from './i18n';
import { httpState } from './httpState';

export interface M20ScreenProps {
  session: Session;
  tick: number;
  notify: (text: string, error?: boolean) => void;
  filters: DashboardFilters;
  onFilters: (f: DashboardFilters) => void;
}

// ------------------------------------------------------------ small helpers

const metricName = (id: string, fallback: string) => t(`m20.metric.${id}`, fallback);
const familyLabel = (id: string, fallback: string) => t(`m20.family.${id}`, fallback);
const statusLabel = (code: string) => t(`m17.status.${code}`, code.replace(/_/g, ' '));
const sourceLabel = (code: string) => t(`m17.source.${code}`, code.replace(/_/g, ' '));
const categoryLabel = (code: string) => t(`m17.reasonCategory.${code}`, code);
const reasonLabel = (code: string) => t(`m17.reason.${code}`, code.replace(/_/g, ' '));

/** The three absences, kept apart in words as well as in the payload. */
function figureWords(f: Figure | undefined): string {
  return figureText(f, {
    empty: t('m20.fig.empty'),
    suppressed: (n, num, min) => t('m20.fig.suppressed').replace('{num}', String(num)).replace('{n}', String(n)).replace('{min}', String(min)),
    percent: (pct, n) => t('m20.fig.percent').replace('{pct}', String(pct)).replace('{n}', String(n)),
  });
}

/** A median with its spread and its exclusion, or the reason there is none. */
function DistributionValue({ d, unit }: { d: Distribution | undefined; unit: string }) {
  if (!d || d.empty) return <span className="muted">{t('m20.fig.empty')}</span>;
  if (d.suppressed) {
    return (
      <span className="muted" data-suppressed="true">
        {t('m20.fig.tooFewMedian').replace('{n}', String(d.n)).replace('{min}', String(d.minimum ?? 5))}
      </span>
    );
  }
  return (
    <span data-median={String(d.median ?? '')}>
      <b>{dayText(d.median)}</b> {unit}
      {' '}
      <span className="muted">
        {t('m20.fig.iqr').replace('{p25}', dayText(d.p25)).replace('{p75}', dayText(d.p75)).replace('{n}', String(d.n))}
      </span>
    </span>
  );
}

/**
 * One period-over-period comparison. The zero case is why this is a component
 * and not a template string: "+100%" from a previous period of nothing is a
 * number the data cannot support, so it is never rendered.
 */
function TrendCell({ label, c }: { label: string; c: Comparison | undefined }) {
  const words = comparisonText(c, {
    flat: t('m20.trend.flat'),
    upFromZero: (change) => t('m20.trend.upFromZero').replace('{change}', String(change)),
    changed: (change, pct) => t('m20.trend.changed')
      .replace('{change}', change > 0 ? `+${change}` : String(change))
      .replace('{pct}', pct > 0 ? `+${pct}` : String(pct)),
  });
  return (
    <div className="trend-cell" data-trend={label}>
      <span className="muted small">{label}</span>{' '}
      <b data-trend-current={String(c?.current ?? 0)}>{c?.current ?? 0}</b>{' '}
      <span className="muted small" data-trend-words="true">{words}</span>
    </div>
  );
}

/** The caveat. Always rendered, always in the same place, never collapsible. */
const Limitation = ({ text }: { text: string }) => (
  <p className="muted small" data-limitation="true">{text}</p>
);

/** A panel: name, semantics, the figure, then the limitation. */
function Panel({ metric, children }: { metric: Metric | undefined; children: ReactNode }) {
  if (!metric) return null;
  return (
    <section className="card" data-metric={metric.id}>
      <h3>{metricName(metric.id, metric.name)}</h3>
      <p className="muted small">{t(`m20.semantics.${metric.semantics}`, metric.semantics.replace(/_/g, ' '))}</p>
      {children}
      <Limitation text={metric.limitation} />
    </section>
  );
}

// ---------------------------------------------------------------- families

function PipelinePanels({ f }: { f: Family }) {
  const m = f.metrics ?? {};
  const stages = m.pipeline_stage_counts;
  const funnel = m.funnel_progression;
  const mix = m.exit_reason_mix;
  const rows = (stages?.rows ?? []) as { status: string; terminal: boolean; value: number }[];
  const funnelRows = (funnel?.rows ?? []) as { stage: string; value: number; reachedOutsideWindow: number; share: Figure }[];
  const mixRows = (mix?.rows ?? []) as { category: string; value: number; share: Figure }[];
  const codes = (mix?.codes ?? []) as { code: string; category: string; value: number }[];
  return (
    <>
      <Panel metric={stages}>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.status')}</th><th>{t('m20.col.rooms')}</th></tr></thead>
            <tbody>
              {rows.filter((r) => r.value > 0).map((r) => (
                <tr key={r.status}>
                  <td>{statusLabel(r.status)}{r.terminal ? ` · ${t('m20.terminal')}` : ''}</td>
                  <td data-count={r.value}>{r.value}</td>
                </tr>
              ))}
              {rows.every((r) => r.value === 0) && <tr><td colSpan={2} className="muted">{t('m20.fig.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel metric={funnel}>
        <p className="muted small" data-not-a-funnel="true">{t('m20.funnel.notMonotonic')}</p>
        {(funnel?.cohortIncomplete as boolean) && (
          <p className="warn small">
            {t('m20.funnel.incomplete').replace('{days}', String(funnel?.typicalDaysToTerminal ?? '—'))}
          </p>
        )}
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.stage')}</th><th>{t('m20.col.everReached')}</th><th>{t('m20.col.ofCohort')}</th></tr></thead>
            <tbody>
              {funnelRows.filter((r) => r.value > 0).map((r) => (
                <tr key={r.stage}>
                  <td>{statusLabel(r.stage)}</td>
                  <td>{r.value}</td>
                  <td>{figureWords(r.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          {t('m20.funnel.reopened').replace('{n}', String((funnel?.reopenedInCohort as Figure | undefined)?.value ?? 0))}
        </p>
      </Panel>

      <Panel metric={mix}>
        <p className="muted small">{t('m20.mix.overlap')}</p>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.category')}</th><th>{t('m20.col.endings')}</th><th>{t('m20.col.share')}</th></tr></thead>
            <tbody>
              {mixRows.map((r) => (
                <tr key={r.category}>
                  <td>{categoryLabel(r.category)}</td>
                  <td>{r.value}</td>
                  <td>{figureWords(r.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {codes.length > 0 && (
          <p className="muted small">
            {t('m20.mix.codes')}: {codes.map((c) => `${reasonLabel(c.code)} (${c.value})`).join(' · ')}
          </p>
        )}
      </Panel>
    </>
  );
}

function DurationPanels({ f }: { f: Family }) {
  const m = f.metrics ?? {};
  const stageRows = (m.time_in_stage?.rows ?? []) as ({ status: string } & Distribution)[];
  const simple = ['time_to_first_decision', 'time_to_trial_requested', 'time_trial_requested_to_completed', 'open_room_age'];
  return (
    <>
      {simple.map((id) => {
        const metric = m[id];
        if (!metric) return null;
        const buckets = (metric.buckets ?? []) as { id: string; label: string; value: number }[];
        return (
          <Panel key={id} metric={metric}>
            <p><DistributionValue d={metric as unknown as Distribution} unit={t('m20.unit.days')} /></p>
            {/* A median says what the middle looks like; buckets say where the
                work is piling up, which is the question a director has. */}
            {buckets.length > 0 && (
              <div className="table-scroll">
                <table className="data" data-age-buckets="true">
                  <thead><tr><th>{t('m20.col.age')}</th><th>{t('m20.col.rooms')}</th></tr></thead>
                  <tbody>
                    {buckets.map((b) => (
                      <tr key={b.id}><td>{t(`m20.bucket.${b.id}`, b.label)}</td><td data-bucket={b.id}>{b.value}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(metric.excluded as number) > 0 && (
              <p className="muted small" data-excluded={String(metric.excluded)}>
                {t('m20.fig.excluded').replace('{n}', String(metric.excluded))} {String(metric.excludedMeans ?? '')}
              </p>
            )}
          </Panel>
        );
      })}
      <Panel metric={m.time_in_stage}>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.stage')}</th><th>{t('m20.col.median')}</th></tr></thead>
            <tbody>
              {stageRows.map((r) => (
                <tr key={r.status}>
                  <td>{statusLabel(r.status)}</td>
                  <td><DistributionValue d={r} unit={t('m20.unit.days')} /></td>
                </tr>
              ))}
              {stageRows.length === 0 && <tr><td colSpan={2} className="muted">{t('m20.fig.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted small">{String(m.time_in_stage?.excludedMeans ?? '')}</p>
      </Panel>
    </>
  );
}

function AgingPanels({ f, onDrill }: { f: Family; onDrill: (metric: string) => void }) {
  const m = f.metrics ?? {};
  const stalled = m.stalled_rooms;
  const thresholds = (stalled?.thresholds ?? []) as { days: number; value: number }[];
  const rows = (stalled?.rows ?? []) as { roomId: string; status: string; idleDays: number; playerName: string | null }[];
  const overdue = m.overdue_trial_reports;
  const outstanding = m.decision_outstanding;
  return (
    <>
      <Panel metric={stalled}>
        <p>
          <b data-stalled={String(stalled?.value ?? 0)}>{stalled?.value ?? 0}</b>{' '}
          {t('m20.stalled.of').replace('{open}', String((stalled?.openRooms as Figure | undefined)?.value ?? 0)).replace('{days}', String(stalled?.thresholdDays ?? 30))}
        </p>
        <p className="muted small">
          {thresholds.map((th) => `${th.days}d: ${th.value}`).join(' · ')}
        </p>
        {rows.length > 0 && (
          <ul className="plain small">
            {rows.slice(0, 5).map((r) => (
              <li key={r.roomId}>
                {r.playerName ?? t('m20.playerWithheld')} — {statusLabel(r.status)} · {t('m20.stalled.idle').replace('{n}', String(r.idleDays))}
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="link" onClick={() => onDrill('stalled_rooms')}>{t('m20.seeAll')}</button>
      </Panel>

      <Panel metric={overdue}>
        <p><b>{overdue?.value ?? 0}</b> {t('m20.overdue.of').replace('{n}', String((overdue?.awaitingReport as Figure | undefined)?.value ?? 0))}</p>
        <p className="muted small">{String(overdue?.note ?? '')}</p>
        <button type="button" className="link" onClick={() => onDrill('overdue_trial_reports')}>{t('m20.seeAll')}</button>
      </Panel>

      <Panel metric={outstanding}>
        <p><b>{outstanding?.value ?? 0}</b> {t('m20.outstanding.of').replace('{n}', String((outstanding?.atOfferStage as Figure | undefined)?.value ?? 0))}</p>
        <button type="button" className="link" onClick={() => onDrill('decision_outstanding')}>{t('m20.seeAll')}</button>
      </Panel>
    </>
  );
}

function DecisionPanels({ f }: { f: Family }) {
  const m = f.metrics ?? {};
  const evRows = (m.evidence_limited_exits?.rows ?? []) as { code: string; value: number }[];
  return (
    <>
      {['terminal_with_recorded_decision', 'superseded_decision_rate', 'reopen_rate'].map((id) => {
        const metric = m[id];
        if (!metric) return null;
        return (
          <Panel key={id} metric={metric}>
            <p>{figureWords(metric as unknown as Figure)}</p>
            {(metric.neutral as boolean) && <p className="muted small">{t('m20.neutral')}</p>}
          </Panel>
        );
      })}
      <Panel metric={m.evidence_limited_exits}>
        <p>{figureWords(m.evidence_limited_exits as unknown as Figure)}</p>
        <p className="muted small">{t('m20.evidence.why')}</p>
        {evRows.some((r) => r.value > 0) && (
          <p className="muted small">{evRows.filter((r) => r.value > 0).map((r) => `${reasonLabel(r.code)} (${r.value})`).join(' · ')}</p>
        )}
      </Panel>
    </>
  );
}

function CoveragePanels({ f }: { f: Family }) {
  const m = f.metrics ?? {};
  const briefRows = (m.briefs_live?.rows ?? []) as { briefId: string; title: string; version: number }[];
  const backlogRows = (m.nobody_missed_backlog?.rows ?? []) as { briefId: string; title: string; value: number; reviewed: Figure }[];
  return (
    <>
      <Panel metric={m.briefs_live}>
        <p><b>{m.briefs_live?.value ?? 0}</b> {t('m20.briefs.live').replace('{total}', String((m.briefs_live?.total as Figure | undefined)?.value ?? 0))}</p>
        {briefRows.length > 0 && <ul className="plain small">{briefRows.map((b) => <li key={b.briefId}>{b.title}</li>)}</ul>}
      </Panel>
      <Panel metric={m.nobody_missed_backlog}>
        <p><b>{m.nobody_missed_backlog?.value ?? 0}</b> {t('m20.nm.backlog')}</p>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.brief')}</th><th>{t('m20.col.unreviewed')}</th><th>{t('m20.col.reviewed')}</th></tr></thead>
            <tbody>
              {backlogRows.map((r) => (
                <tr key={r.briefId}><td>{r.title}</td><td>{r.value}</td><td>{figureWords(r.reviewed)}</td></tr>
              ))}
              {backlogRows.length === 0 && <tr><td colSpan={3} className="muted">{t('m20.fig.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel metric={m.nobody_missed_review_rate}>
        <p>{figureWords(m.nobody_missed_review_rate as unknown as Figure)}</p>
      </Panel>
      <Panel metric={m.second_look_backlog}>
        <p>
          <b>{m.second_look_backlog?.value ?? 0}</b> {t('m20.sl.open')}
          {' · '}
          {t('m20.sl.expired').replace('{n}', String((m.second_look_backlog?.expired as Figure | undefined)?.value ?? 0))}
        </p>
        <p><DistributionValue d={m.second_look_backlog?.age as Distribution | undefined} unit={t('m20.unit.days')} /></p>
      </Panel>
      <Panel metric={m.second_look_response_time}>
        <p><DistributionValue d={m.second_look_response_time as unknown as Distribution} unit={t('m20.unit.days')} /></p>
        <p className="muted small">{String(m.second_look_response_time?.excludedMeans ?? '')}</p>
      </Panel>
    </>
  );
}

function SourcePanels({ f }: { f: Family }) {
  const m = f.metrics ?? {};
  const mixRows = (m.room_source_mix?.rows ?? []) as { source: string; residual: boolean; value: number; share: Figure }[];
  const reachRows = (m.source_stage_reach?.rows ?? []) as { source: string; cohort: Figure; stages: ({ stage: string } & Figure)[] }[];
  return (
    <>
      <Panel metric={m.room_source_mix}>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.source')}</th><th>{t('m20.col.rooms')}</th><th>{t('m20.col.share')}</th></tr></thead>
            <tbody>
              {mixRows.map((r) => (
                <tr key={r.source}>
                  <td>{sourceLabel(r.source)}{r.residual ? ` · ${t('m20.residual')}` : ''}</td>
                  <td>{r.value}</td>
                  <td>{figureWords(r.share)}</td>
                </tr>
              ))}
              {mixRows.length === 0 && <tr><td colSpan={3} className="muted">{t('m20.fig.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel metric={m.source_stage_reach}>
        {/* The association sentence is rendered WITH the number, from the
            server's own payload, so the figure cannot appear without it. */}
        <p className="warn small" data-association="true">{String(m.source_stage_reach?.associationNote ?? '')}</p>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('m20.col.source')}</th><th>{t('m20.col.rooms')}</th>
                {(reachRows[0]?.stages ?? []).map((s) => <th key={s.stage}>{statusLabel(s.stage)}</th>)}
              </tr>
            </thead>
            <tbody>
              {reachRows.map((r) => (
                <tr key={r.source}>
                  <td>{sourceLabel(r.source)}</td>
                  <td>{r.cohort.value}</td>
                  {r.stages.map((s) => <td key={s.stage}>{figureWords(s)}</td>)}
                </tr>
              ))}
              {reachRows.length === 0 && <tr><td colSpan={3} className="muted">{t('m20.fig.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted small">{t('m20.assoc.alphabetical')}</p>
      </Panel>
    </>
  );
}

function WatchlistPanels({ f }: { f: Family }) {
  const m = f.metrics ?? {};
  return (
    <>
      <Panel metric={m.active_watchlists}>
        <p><b>{m.active_watchlists?.value ?? 0}</b> {t('m20.wl.active').replace('{total}', String((m.active_watchlists?.total as Figure | undefined)?.value ?? 0))}</p>
      </Panel>
      <Panel metric={m.watchlist_membership_churn}>
        <p>
          <b>{m.watchlist_membership_churn?.value ?? 0}</b>{' '}
          {t('m20.wl.churn')
            .replace('{in}', String((m.watchlist_membership_churn?.entered as Figure | undefined)?.value ?? 0))
            .replace('{out}', String((m.watchlist_membership_churn?.left as Figure | undefined)?.value ?? 0))}
        </p>
        <p className="warn small" data-derived-on-read="true">{String(m.watchlist_membership_churn?.refreshNote ?? '')}</p>
      </Panel>
    </>
  );
}

const FAMILY_RENDERERS: Record<string, (p: { f: Family; onDrill: (metric: string) => void }) => ReactElement> = {
  pipeline: ({ f }) => <PipelinePanels f={f} />,
  duration: ({ f }) => <DurationPanels f={f} />,
  aging: ({ f, onDrill }) => <AgingPanels f={f} onDrill={onDrill} />,
  decision_record: ({ f }) => <DecisionPanels f={f} />,
  coverage: ({ f }) => <CoveragePanels f={f} />,
  source: ({ f }) => <SourcePanels f={f} />,
  watchlist: ({ f }) => <WatchlistPanels f={f} />,
};

// ---------------------------------------------------------------- the screen

export function DirectorDashboardScreen({ session, tick, notify, filters, onFilters }: M20ScreenProps) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [refusal, setRefusal] = useState<{ error: string; detail: string; allowed?: (string | number)[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<Drilldown | null>(null);

  useEffect(() => {
    let live = true;
    m20.catalogue(session).then((c) => { if (live) setCatalogue(c); }).catch(() => { /* the dashboard carries its own definitions too */ });
    return () => { live = false; };
  }, [session]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const out = await m20.dashboard(session, filters);
      if (out.ok) { setDash(out.value); setRefusal(null); setError(null); }
      else { setRefusal({ error: out.error, detail: out.detail, allowed: out.allowed }); }
    } catch (e) {
      setError(httpState(e).message);
    } finally {
      setBusy(false);
    }
  }, [session, filters]);

  useEffect(() => { void load(); }, [load, tick]);

  const openDrill = useCallback(async (metric: string) => {
    if (!DRILLDOWN_METRICS.includes(metric)) return;
    try { setDrill(await m20.rows(session, metric, { ...filters, limit: 25 })); }
    catch (e) { notify(httpState(e).message, true); }
  }, [session, filters, notify]);

  const set = (patch: DashboardFilters) => onFilters({ ...filters, ...patch });

  return (
    <div className="screen" data-screen="director-dashboard">
      <p className="muted">{t('m20.subtitle')}</p>

      {/* The governing sentence, from the server, above every number. */}
      {dash && <p className="notice" data-principle="true">{dash.note}</p>}

      <section className="card" aria-label={t('m20.filters')}>
        <div className="row wrap">
          <label>
            {t('m20.filter.window')}
            <select
              aria-label={t('m20.filter.window')}
              value={filters.window ?? DEFAULT_WINDOW}
              onChange={(e) => set({ window: e.target.value, from: undefined, to: undefined })}
            >
              {WINDOW_PRESETS.map((w) => <option key={w} value={w}>{t(`m20.window.${w}`, w.replace(/_/g, ' '))}</option>)}
            </select>
          </label>
          <label>
            {t('m20.filter.source')}
            <select aria-label={t('m20.filter.source')} value={filters.source ?? ''} onChange={(e) => set({ source: e.target.value || undefined })}>
              <option value="">{t('m20.filter.any')}</option>
              {(catalogue?.sourceContexts ?? []).map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
            </select>
          </label>
          <label>
            {t('m20.filter.priority')}
            <select aria-label={t('m20.filter.priority')} value={filters.priority ?? ''} onChange={(e) => set({ priority: e.target.value || undefined })}>
              <option value="">{t('m20.filter.any')}</option>
              {(catalogue?.priorities ?? []).map((p) => <option key={p} value={p}>{t(`m17.priority.${p}`, p)}</option>)}
            </select>
          </label>
          <label>
            {t('m20.filter.stall')}
            <select aria-label={t('m20.filter.stall')} value={String(filters.stallDays ?? 30)} onChange={(e) => set({ stallDays: Number(e.target.value) })}>
              {STALL_THRESHOLDS.map((d) => <option key={d} value={d}>{t('m20.filter.stallDays').replace('{n}', String(d))}</option>)}
            </select>
          </label>
        </div>
        {/* There is no scout filter, and saying so is part of the product. */}
        <p className="muted small" data-no-person-filter="true">{t('m20.filter.noPerson')}</p>
      </section>

      {busy && !dash && <p className="muted">{t('common.loading')}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {refusal && (
        <div className="card error" role="alert" data-refusal={refusal.error}>
          <p>{refusal.detail}</p>
          {refusal.allowed && <p className="muted small">{t('m20.refusal.allowed')}: {refusal.allowed.join(', ')}</p>}
        </div>
      )}

      {dash && (
        <>
          <p className="muted small" data-window={`${dash.window.from}..${dash.window.to}`}>
            {t('m20.windowLabel').replace('{from}', fmtDate(Date.parse(`${dash.window.from}T00:00:00Z`))).replace('{to}', fmtDate(Date.parse(`${dash.window.to}T00:00:00Z`)))}
            {' · '}
            {t('m20.smallN').replace('{min}', String(dash.smallNMinimum))}
            {' · '}
            {/* Read-time projection: say when, rather than imply a live feed. */}
            <span data-calculated-at={String(dash.calculatedAt)}>
              {t('m20.calculatedAt').replace('{when}', fmtDateTime(dash.calculatedAt))}
            </span>
          </p>

          {dash.trend && (
            <section className="card" data-trend-strip="true">
              <h3>{t('m20.trend.title')}</h3>
              <p className="muted small">
                {t('m20.trend.against')
                  .replace('{from}', fmtDate(Date.parse(`${dash.trend.previousWindow.from}T00:00:00Z`)))
                  .replace('{to}', fmtDate(Date.parse(`${dash.trend.previousWindow.to}T00:00:00Z`)))}
              </p>
              <div className="row wrap">
                <TrendCell label={t('m20.trend.opened')} c={dash.trend.rooms_opened} />
                <TrendCell label={t('m20.trend.ended')} c={dash.trend.rooms_ended} />
                <TrendCell label={t('m20.trend.decided')} c={dash.trend.decisions_recorded} />
              </div>
              <p className="muted small">{dash.trend.note}</p>
            </section>
          )}

          {dash.partial && (
            <p className="warn" role="status" data-partial="true">
              {t('m20.partial').replace('{families}', dash.unavailable.map((u) => familyLabel(u, u)).join(', '))}
            </p>
          )}

          {dash.families.map((id) => {
            const fam = dash.data[id];
            if (!fam) return null;
            const Render = FAMILY_RENDERERS[id];
            return (
              <section key={id} data-family={id}>
                <h3 className="section">{familyLabel(id, fam.label)}</h3>
                {fam.error ? (
                  <div className="card warn" role="status" data-family-error={fam.error}>
                    <p>{t('m20.familyUnavailable').replace('{family}', familyLabel(id, fam.label))}</p>
                  </div>
                ) : (
                  <>
                    {(fam.filtersNotApplicable ?? []).length > 0 && (
                      <p className="muted small" data-filters-not-applicable={(fam.filtersNotApplicable ?? []).join(',')}>
                        {t('m20.filterNotApplied').replace('{filters}', (fam.filtersNotApplicable ?? []).join(', '))}
                      </p>
                    )}
                    {Render && <Render f={fam} onDrill={openDrill} />}
                  </>
                )}
              </section>
            );
          })}
        </>
      )}

      {drill && (
        <section className="card" data-drilldown={drill.metric}>
          <h3>{metricName(drill.metric, drill.metric)}</h3>
          <p className="muted small">{t('m20.rows.count').replace('{n}', String(drill.total))}</p>
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>{t('m20.col.player')}</th><th>{t('m20.col.status')}</th><th>{t('m20.col.days')}</th></tr></thead>
              <tbody>
                {drill.rows.map((r, i) => (
                  <tr key={r.roomId ?? r.trialId ?? i}>
                    <td>{r.playerName ?? t('m20.playerWithheld')}</td>
                    <td>{r.status ? statusLabel(r.status) : '—'}</td>
                    <td>{r.idleDays ?? r.overdueDays ?? '—'}</td>
                  </tr>
                ))}
                {drill.rows.length === 0 && <tr><td colSpan={3} className="muted">{t('m20.fig.empty')}</td></tr>}
              </tbody>
            </table>
          </div>
          <Limitation text={drill.limitation} />
          <div className="row">
            {drill.nextCursor != null && (
              <button
                type="button"
                onClick={async () => {
                  try { setDrill(await m20.rows(session, drill.metric, { ...filters, cursor: drill.nextCursor ?? 0, limit: 25 })); }
                  catch (e) { notify(httpState(e).message, true); }
                }}
              >
                {t('m20.rows.more')}
              </button>
            )}
            <button type="button" className="link" onClick={() => setDrill(null)}>{t('common.close')}</button>
          </div>
        </section>
      )}

      {catalogue && (
        <details className="card" data-never-built="true">
          <summary>{t('m20.neverBuilt.title')}</summary>
          <p>{catalogue.neverBuilt.reason}</p>
          <p className="muted small">{catalogue.neverBuilt.names.join(' · ')}</p>
        </details>
      )}
    </div>
  );
}
