import { RecordFacts, DetailItems } from './RecordDetails';
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
import { hashForRoom } from './nav';

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
    <section className="card dash-panel" data-metric={metric.id}>
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
  const trialProcess = m.trial_process;
  const trialSteps = (trialProcess?.steps ?? {}) as Record<string, Figure>;
  const decisionOutcomes = m.decision_outcomes;
  // M23 P8 — the journey funnel from the records themselves (case-based).
  const jf = m.journey_evidence_funnel;
  const jfRows = (jf?.rows ?? []) as { stage: string; value: number; historyOnly: number; basis: string; source: string }[];
  const jfIntervals = (jf?.intervals ?? {}) as Record<string, { n: number; medianDays: number | null }>;
  const outcomeFigures = (decisionOutcomes?.outcomes ?? {}) as Record<string, Figure>;
  const supersededFigure = decisionOutcomes?.superseded as Figure | undefined;
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
          <div aria-label={t('m20.mix.codes')}><RecordFacts items={codes.map(c => ({label: reasonLabel(c.code), value: c.value}))} /></div>
        )}
      </Panel>

      {decisionOutcomes && (
        <Panel metric={decisionOutcomes}>
          <p className="muted small" data-no-rate="true">{t('m20.decisionOutcomes.noRate')}</p>
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>{t('m20.col.outcome')}</th><th>{t('m20.col.decisions')}</th></tr></thead>
              <tbody>
                {['progress', 'hold', 'reject'].map((o) => (
                  <tr key={o}>
                    <td>{t(`m20.decisionOutcomes.${o}`)}</td>
                    <td data-count={outcomeFigures[o]?.value ?? 0}>{outcomeFigures[o]?.value ?? 0}</td>
                  </tr>
                ))}
                <tr><td>{t('m20.decisionOutcomes.superseded')}</td><td data-count={supersededFigure?.value ?? 0}>{supersededFigure?.value ?? 0}</td></tr>
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      <Panel metric={trialProcess}>
        <p className="muted small" data-no-rate="true">{t('m20.trialProcess.noRate')}</p>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.step')}</th><th>{t('m20.col.trials')}</th></tr></thead>
            <tbody>
              {['invited', 'declined', 'accepted', 'scheduled', 'completed', 'cancelled'].map((step) => (
                <tr key={step}>
                  <td>{t(`m20.trialProcess.${step}`)}</td>
                  <td data-count={trialSteps[step]?.value ?? 0}>{trialSteps[step]?.value ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel metric={jf}>
        <p className="muted small" data-counting="case">{t('m20.jf.counting')}</p>
        <div className="table-scroll">
          <table className="data" data-testid="journey-evidence-funnel">
            <thead><tr><th>{t('m20.col.stage')}</th><th>{t('m20.col.cases')}</th><th>{t('m20.col.historyOnly')}</th><th>{t('m20.col.record')}</th></tr></thead>
            <tbody>
              {jfRows.map((r) => (
                <tr key={r.stage} data-stage={r.stage}>
                  <td>{t(`m20.jf.${r.stage}`, r.stage.replace(/_/g, ' '))}</td>
                  <td data-count={r.value}>{r.value}</td>
                  <td className="muted">{r.historyOnly}</td>
                  <td className="muted">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h4 style={{ margin: '10px 0 4px' }}>{t('m20.jf.intervals')}</h4>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('m20.col.interval')}</th><th>{t('m20.col.cases')}</th><th>{t('m20.col.medianDays')}</th></tr></thead>
            <tbody>
              {Object.entries(jfIntervals).map(([k, v]) => (
                <tr key={k}><td>{t(`m20.jf.int.${k}`, k.replace(/_/g, ' '))}</td><td>{v.n}</td><td>{v.medianDays === null ? t('m20.fig.empty') : v.medianDays}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <RecordFacts items={thresholds.map(th => ({label: `${th.days} days`, value: th.value}))} />
        {rows.length > 0 && (
          <ul className="plain small">
            {rows.slice(0, 5).map((r) => (
              <li key={r.roomId}>
                <a href={hashForRoom(r.roomId)}>{r.playerName ?? t('m20.playerWithheld')}</a> — {statusLabel(r.status)} · {t('m20.stalled.idle').replace('{n}', String(r.idleDays))}
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
          <RecordFacts items={evRows.filter(r => r.value > 0).map(r => ({label: reasonLabel(r.code), value: r.value}))} />
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

// ---------------------------------------------------------- executive layer
//
// M24F.4 — the top of the page is a director's view: four counts, the
// funnel as bars, time by stage as bars, coverage as a ring, and the five
// things that need attention. Every number is one the server already sent;
// nothing here is recomputed, rated or ranked. The seven families follow as
// the detail, each panel with its own limitation as before.

/** Clean horizontal bars from a list of counts. The longest bar is the largest count; the label and the number are always printed. */
function Bars({ rows, unit, testID }: { rows: { key: string; label: string; value: number | null; words?: string; attrs?: Record<string, string> }[]; unit?: string; testID?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="dash-bars" data-testid={testID}>
      {rows.map((r) => (
        <div key={r.key} className="dash-bar" {...(r.attrs ?? {})}>
          <span className="dash-bar-label">{r.label}</span>
          <span className="dash-bar-track" aria-hidden="true"><span className="dash-bar-fill" style={{ width: `${r.value == null ? 0 : Math.round(((r.value) / max) * 100)}%` }} /></span>
          <span className="dash-bar-value">{r.value == null ? '—' : r.value}{r.value != null && unit ? ` ${unit}` : ''}{r.words ? <span className="muted small"> {r.words}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

/** A ring from a server rate. A withheld or empty rate draws nothing and says so beside it. */
function Ring({ f, label }: { f: Figure | undefined; label: string }) {
  const pct = f && !f.empty && !f.suppressed ? Math.round((f.value ?? 0) * 100) : null;
  const r = 15.9155;
  return (
    <div className="dash-ring-wrap">
      <svg className="dash-ring" viewBox="0 0 36 36" width="92" height="92" role="img" aria-label={`${label} ${pct == null ? figureWords(f) : `${pct}%`}`}>
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--sb-wash)" strokeWidth="3.2" />
        {pct != null && <circle cx="18" cy="18" r={r} fill="none" stroke="var(--sb-green-text)" strokeWidth="3.2" strokeLinecap="round" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset="25" />}
        <text x="18" y="19.6" textAnchor="middle" fontSize="7.5" fontWeight="650" fill="currentColor">{pct == null ? '—' : `${pct}%`}</text>
      </svg>
      <div>
        <div className="dash-ring-label">{label}</div>
        <div className="muted small">{figureWords(f)}</div>
      </div>
    </div>
  );
}

const sumRows = (rows: { value: number }[]) => rows.reduce((a, r) => a + (r.value || 0), 0);

function Executive({ dash, onDrill }: { dash: Dashboard; onDrill: (metric: string) => void }) {
  const pipeline = dash.data.pipeline?.metrics ?? {};
  const duration = dash.data.duration?.metrics ?? {};
  const aging = dash.data.aging?.metrics ?? {};
  const coverage = dash.data.coverage?.metrics ?? {};
  const stageRows = (pipeline.pipeline_stage_counts?.rows ?? []) as { status: string; terminal: boolean; value: number }[];
  const funnelRows = (pipeline.funnel_progression?.rows ?? []) as { stage: string; value: number; share: Figure }[];
  const trialSteps = (pipeline.trial_process?.steps ?? {}) as Record<string, Figure>;
  const jfRows = (pipeline.journey_evidence_funnel?.rows ?? []) as { stage: string; value: number }[];
  const timeRows = (duration.time_in_stage?.rows ?? []) as ({ status: string } & Distribution)[];
  const stalledRows = (aging.stalled_rooms?.rows ?? []) as { roomId: string; status: string; idleDays: number; playerName: string | null }[];
  const openCases = stageRows.length ? sumRows(stageRows.filter((r) => !r.terminal)) : null;
  const trials = trialSteps.completed ? trialSteps.completed.value ?? 0 : null;
  const offers = jfRows.find((r) => r.stage === 'offer_issued')?.value ?? (stageRows.length ? sumRows(stageRows.filter((r) => /^offer_/.test(r.status))) : null);
  const signed = jfRows.find((r) => r.stage === 'signed')?.value ?? stageRows.find((r) => r.status === 'signed')?.value ?? null;
  const kpis: { id: string; label: string; value: number | null }[] = [
    { id: 'open_cases', label: t('m20.kpi.open', 'Open cases'), value: openCases },
    { id: 'trials', label: t('m20.kpi.trials', 'Trials completed'), value: trials },
    { id: 'offers', label: t('m20.kpi.offers', 'Offers issued'), value: offers },
    { id: 'signed', label: t('m20.kpi.signed', 'Signed'), value: signed },
  ];
  const attention: { key: string; text: string; detail?: string; href?: string; metric?: string }[] = [
    ...stalledRows.slice(0, 3).map((r) => ({ key: r.roomId, text: r.playerName ?? t('m20.playerWithheld'), detail: `${statusLabel(r.status)} · ${t('m20.stalled.idle').replace('{n}', String(r.idleDays))}`, href: hashForRoom(r.roomId) })),
    ...((aging.overdue_trial_reports?.value as number | undefined) ? [{ key: 'overdue', text: `${aging.overdue_trial_reports?.value} ${t('m20.overdue.of').replace('{n}', String((aging.overdue_trial_reports?.awaitingReport as Figure | undefined)?.value ?? 0))}`, metric: 'overdue_trial_reports' }] : []),
    ...((aging.decision_outstanding?.value as number | undefined) ? [{ key: 'outstanding', text: `${aging.decision_outstanding?.value} ${t('m20.outstanding.of').replace('{n}', String((aging.decision_outstanding?.atOfferStage as Figure | undefined)?.value ?? 0))}`, metric: 'decision_outstanding' }] : []),
  ].slice(0, 5);
  const medians = timeRows.filter((r) => !r.empty && !r.suppressed && r.median != null);
  return (
    <section className="dash-exec" data-executive="true" aria-label={t('m20.exec.label', 'At a glance')}>
      <div className="stat-grid dash-kpis" data-kpis="true">
        {kpis.map((k) => (
          <div key={k.id} className="stat" data-kpi={k.id}>
            <div className="v">{k.value == null ? '—' : k.value}</div>
            <div className="k">{k.label}</div>
          </div>
        ))}
      </div>
      <div className="dash-grid">
        <div className="dash-visual" data-visual="funnel">
          <h3>{t('m20.exec.funnel', 'Recruitment funnel')}</h3>
          {funnelRows.filter((r) => r.value > 0).length === 0
            ? <p className="muted small">{t('m20.fig.empty')}</p>
            : <Bars rows={funnelRows.filter((r) => r.value > 0).map((r) => ({ key: r.stage, label: statusLabel(r.stage), value: r.value, attrs: { 'data-funnel-stage': r.stage } }))} testID="dash-funnel" />}
        </div>
        <div className="dash-visual" data-visual="time">
          <h3>{t('m20.exec.time', 'Time by stage')}</h3>
          {medians.length === 0
            ? <p className="muted small">{timeRows.length ? t('m20.fig.tooFewMedian').replace('{n}', String(timeRows[0]?.n ?? 0)).replace('{min}', String(timeRows[0]?.minimum ?? 5)) : t('m20.fig.empty')}</p>
            : <Bars rows={medians.map((r) => ({ key: r.status, label: statusLabel(r.status), value: r.median, attrs: { 'data-time-stage': r.status } }))} unit={t('m20.unit.days')} testID="dash-time" />}
        </div>
        <div className="dash-visual" data-visual="coverage">
          <h3>{t('m20.exec.coverage', 'Coverage')}</h3>
          <Ring f={coverage.nobody_missed_review_rate as unknown as Figure | undefined} label={metricName('nobody_missed_review_rate', 'Eligible players reviewed')} />
          <p className="muted small">
            <b>{coverage.briefs_live?.value ?? 0}</b> {t('m20.briefs.live').replace('{total}', String((coverage.briefs_live?.total as Figure | undefined)?.value ?? 0))}
            {' · '}
            <b>{coverage.nobody_missed_backlog?.value ?? 0}</b> {t('m20.exec.unreviewed', 'unreviewed')}
          </p>
        </div>
        <div className="dash-visual" data-visual="attention">
          <h3>{t('m20.exec.attention', 'Needs attention')}</h3>
          {attention.length === 0 ? <p className="muted small">{t('m20.exec.nothing', 'Nothing is waiting on you.')}</p> : (
            <ul className="plain small dash-attention" data-attention="true">
              {attention.map((a) => (
                <li key={a.key}>
                  {a.href
                    ? <a href={a.href}><strong>{a.text}</strong>{a.detail && <span>{a.detail}</span>}</a>
                    : <button type="button" className="linklike" onClick={() => a.metric && onDrill(a.metric)}>{a.text}</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the screen

export function DirectorDashboardScreen({ session, tick, notify, filters, onFilters }: M20ScreenProps) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [refusal, setRefusal] = useState<{ error: string; detail: string; allowed?: (string | number)[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<Drilldown | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

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
    <div className="screen dash" data-screen="director-dashboard">
      {/* M24F.5 — one line of controls: the period, then two quiet ways in. The
          principle, the window and the other filters are one tap away; nothing
          explanatory sits above the numbers until it is asked for. */}
      <div className="dash-head" data-dash-head="true">
        <label className="dash-period">
          {t('m20.filter.window')}
          <select
            aria-label={t('m20.filter.window')}
            value={filters.window ?? DEFAULT_WINDOW}
            onChange={(e) => set({ window: e.target.value, from: undefined, to: undefined })}
          >
            {WINDOW_PRESETS.map((w) => <option key={w} value={w}>{t(`m20.window.${w}`, w.replace(/_/g, ' '))}</option>)}
          </select>
        </label>
        <button type="button" className="linklike dash-toggle" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)} data-testid="dash-more-filters">{t('m20.exec.moreFilters', 'More filters')}</button>
        <button type="button" className="linklike dash-toggle" aria-expanded={showAbout} onClick={() => setShowAbout((v) => !v)} data-testid="dash-about-toggle">{t('m20.exec.about', 'About these figures')}</button>
      </div>

      {showFilters && (
        <section className="dash-filters" aria-label={t('m20.filters')} data-testid="dash-filters">
          <div className="row wrap">
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
      )}

      {showAbout && dash && (
        <section className="dash-about" data-testid="dash-about">
          {/* The governing sentence, from the server, above every number. */}
          <p className="notice" data-principle="true">{dash.note}</p>
          <p className="muted small dash-window" data-window={`${dash.window.from}..${dash.window.to}`}>
            {t('m20.windowLabel').replace('{from}', fmtDate(Date.parse(`${dash.window.from}T00:00:00Z`))).replace('{to}', fmtDate(Date.parse(`${dash.window.to}T00:00:00Z`)))}
            {' · '}
            {t('m20.smallN').replace('{min}', String(dash.smallNMinimum))}
            {' · '}
            {/* Read-time projection: say when, rather than imply a live feed. */}
            <span data-calculated-at={String(dash.calculatedAt)}>
              {t('m20.calculatedAt').replace('{when}', fmtDateTime(dash.calculatedAt))}
            </span>
          </p>
        </section>
      )}

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
          {/* A partial answer is error recovery: it stays above the numbers. */}
          {dash.partial && (
            <p className="warn" role="status" data-partial="true">
              {t('m20.partial').replace('{families}', dash.unavailable.map((u) => familyLabel(u, u)).join(', '))}
            </p>
          )}
          <Executive dash={dash} onDrill={openDrill} />

          <button type="button" className="dash-detail-toggle" aria-expanded={showDetail} onClick={() => setShowDetail((v) => !v)} data-testid="dash-detail-toggle">
            {showDetail ? t('m20.exec.hideAll', 'Hide all figures') : t('m20.exec.showAll', 'Show all figures')}
          </button>
          {/* M24F.5 — every panel, its limitation printed beside its number, one tap deeper. Rendered only when opened (not hidden). */}
          {showDetail && (
            <div className="dash-detail" data-testid="dash-detail">
              {dash.trend && (
                <section className="card dash-trend" data-trend-strip="true">
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

              {dash.families.map((id) => {
                const fam = dash.data[id];
                if (!fam) return null;
                const Render = FAMILY_RENDERERS[id];
                return (
                  <section key={id} data-family={id} className="dash-family">
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
                        <div className="dash-panels">
                          {Render && <Render f={fam} onDrill={openDrill} />}
                        </div>
                      </>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      {drill && (
        <section className="card dash-panel" data-drilldown={drill.metric}>
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

      {catalogue && showDetail && (
        <details className="card f-about" data-never-built="true">
          <summary>{t('m20.neverBuilt.title')}</summary>
          <p>{catalogue.neverBuilt.reason}</p>
          <p className="muted small"><DetailItems items={catalogue.neverBuilt.names} /></p>
        </details>
      )}
    </div>
  );
}
