// M23 P8 — the Journey strip at the head of a Room: where the case is on the
// canonical journey, which stages are done, and the ONE next action the
// server derived for this person. Nothing here computes a stage or an action:
// the strip renders `journey` from GET /org/rooms/:id/journey and re-reads it
// on every server event, on focus, on visibility and after every act.
//
// A next action that IS a lifecycle action (start the review, resume the
// case) is performed from here through POST /rooms/:id/lifecycle; every other
// act opens the tab where the record is made — a "Prepare Offer" opens the
// Offer tab and creates nothing. When the case moved under the person's feet
// (409 / 422 / 403 from the server) the strip says so in one sentence and
// refreshes rather than failing silently or overwriting anything.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { rooms, type Room, type RoomJourney, type JourneyTab, type JourneyStage } from './roomsApi';
import { t, fmtDateTime } from './i18n';

/** The pipeline stages, in order. The same list as the server's PIPELINE_STAGES. */
export const PIPELINE_STAGES: JourneyStage[] = ['watching', 'review', 'contact', 'trial', 'assessment', 'decision', 'offer', 'acceptance', 'signing', 'signed'];
/** Next actions the strip performs itself (a lifecycle action with no record to make first). */
const PERFORMABLE = new Set(['REVIEW_PLAYER', 'RESUME_CASE']);

export const stageLabel = (s: string) => t(`jn.stage.${s}`, s);
export const nextActionLabel = (code: string) => t(`jn.next.${code}`, code.toLowerCase().replace(/_/g, ' '));
export const journeyEventLabel = (kind: string) => t(`jn.ev.${kind}`, t(`rm.ev.${kind}`, kind.replace(/^(room|case)_/, '').replace(/_/g, ' ')));

/**
 * The journey for a room, re-read whenever the room's revision or the app's
 * server-event tick changes, when the window regains focus or becomes visible
 * (§55), and whenever `bump()` is called after an act.
 */
export function useRoomJourney(session: Session, room: Room, tick: number) {
  const [journey, setJourney] = useState<RoomJourney | null>(null);
  const [bumpN, setBumpN] = useState(0);
  const bump = useCallback(() => setBumpN((b) => b + 1), []);
  useEffect(() => {
    let live = true;
    rooms.journey(session, room.roomId).then((j) => { if (live) setJourney(j); }).catch(() => { if (live) setJourney(null); });
    return () => { live = false; };
  }, [session, room.roomId, room.rev, tick, bumpN]);
  useEffect(() => {
    const onFocus = () => bump();
    const onVisible = () => { if (document.visibilityState === 'visible') bump(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onFocus); };
  }, [bump]);
  return { journey, bump };
}

export function JourneyStrip({ session, room, journey, notify, reload, onTab, bump }: {
  session: Session;
  room: Room;
  journey: RoomJourney | null;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
  onTab: (tab: JourneyTab) => void;
  bump: () => void;
}) {
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const jb = journey?.journey ?? null;
  if (!jb) return null;
  const na = jb.nextAction;
  const currentIdx = PIPELINE_STAGES.indexOf(jb.stage as JourneyStage);
  const done = new Set(jb.completedStages.map((c) => c.stage));
  const performable = na.kind === 'club' && !!na.lifecycleAction && PERFORMABLE.has(na.code) && na.permitted === true && na.blockedBy.length === 0;

  const act = async () => {
    if (busy) return;
    setChanged(false);
    if (!performable) { onTab(na.tab); return; }
    setBusy(true);
    try {
      await rooms.lifecycle(session, room.roomId, { action: na.lifecycleAction!, expectedRev: room.rev });
      notify(t('jn.moved'));
      reload(); bump();
    } catch (e) {
      // The case is not where the strip thought: refresh, say so once, never overwrite.
      if (e instanceof ApiError && [403, 409, 422].includes(e.status)) { setChanged(true); reload(); bump(); }
      else notify(e instanceof Error ? e.message : 'failed', true);
    } finally { setBusy(false); }
  };

  return (
    <section className="section" aria-label={t('jn.title')} data-testid="journey-strip" data-stage={jb.stage} data-next={na.code} data-classification={jb.classification}>
      <ol className="journey-rail" aria-label={t('jn.railLabel')}>
        {PIPELINE_STAGES.map((s, i) => {
          // The current stage is marked current even when it is also done (signed): a reader must always find ONE aria-current step.
          const state = s === jb.stage ? 'current' : done.has(s) ? 'done' : i < currentIdx ? 'passed' : 'pending';
          const glyph = done.has(s) ? '✓' : state === 'current' ? '●' : '○';
          return (
            <li key={s} className={`journey-step ${state}`} aria-current={state === 'current' ? 'step' : undefined} data-stage={s} data-state={state}>
              <span aria-hidden="true">{glyph}</span> <span>{stageLabel(s)}</span>
            </li>
          );
        })}
        {(jb.stage === 'paused' || jb.stage === 'ended') && (
          <li className="journey-step current" aria-current="step" data-stage={jb.stage} data-state="current"><span aria-hidden="true">■</span> <span>{stageLabel(jb.stage)}</span></li>
        )}
      </ol>
      <div className="journey-next" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span className="pill blue">{t('jn.nextLabel')}</span>
        <span className="grow" data-testid="journey-next-action">
          {na.kind === 'await' && <span aria-hidden="true">⏳ </span>}
          {na.kind === 'none' && <span aria-hidden="true">■ </span>}
          {nextActionLabel(na.code)}
        </span>
        {na.kind === 'club' && (
          <button className="primary" data-testid="journey-next-go" disabled={busy || na.permitted === false || na.blockedBy.length > 0} onClick={act} aria-describedby={na.permitted === false || na.blockedBy.length > 0 ? 'journey-next-why' : undefined}>
            {performable ? nextActionLabel(na.code) : `${t('jn.open')} ${t(`rm.tab.${na.tab}`)}`}
          </button>
        )}
        {na.kind === 'await' && <button onClick={() => onTab(na.tab)}>{t('jn.open')} {t(`rm.tab.${na.tab}`)}</button>}
      </div>
      {(na.permitted === false || na.blockedBy.length > 0) && (
        <div id="journey-next-why" className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          {na.blockedBy.length > 0 ? na.blockedBy.map((b) => t(`jn.blocked.${b}`, b)).join(' ') : t('jn.notPermitted')}
        </div>
      )}
      {jb.classification !== 'canonical' && (
        <div className="notice" role="note" style={{ marginTop: 6, fontSize: 12.5 }} data-testid="journey-classification">{t(`jn.class.${jb.classification}`)}{jb.integrity.length > 0 ? ` (${jb.integrity.join(', ')})` : ''}</div>
      )}
      {changed && (
        <div className="notice block" role="status" aria-live="polite" data-testid="journey-changed" style={{ marginTop: 6 }}>{t('jn.changed')}</div>
      )}
      {journey?.generatedAt ? <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>{t('jn.asOf')} {fmtDateTime(journey.generatedAt)}</div> : null}
    </section>
  );
}

/** The journey timeline (Activity tab): milestones derived from the records, never from clicks. */
export function JourneyTimeline({ journey }: { journey: RoomJourney | null }) {
  const entries = journey?.history?.entries ?? [];
  return (
    <div className="section" aria-label={t('jn.timeline')} data-testid="journey-timeline">
      <h4>{t('jn.timeline')} <span className="dim" style={{ fontSize: 12.5 }}>({journey?.history?.total ?? 0})</span></h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('jn.timelineNote')}</div>
      {entries.length === 0 ? <div className="dim">{t('jn.noTimeline')}</div> : (
        <ol className="list-rows" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {entries.map((e, i) => (
            <li key={`${e.kind}:${e.at}:${i}`} className="list-row" style={{ flexWrap: 'wrap' }} data-kind={e.kind}>
              <span className="dim" style={{ minWidth: 120 }}>{fmtDateTime(e.at)}</span>
              <span className="grow">
                {journeyEventLabel(e.kind)}
                {e.to ? <span className="dim"> → {t(`rm.st.${e.to}`, e.to)}</span> : null}
                {typeof e.revisionNumber === 'number' ? <span className="dim"> · {t('jn.revision')} {e.revisionNumber}</span> : null}
                {e.partyType ? <span className="dim"> · {t(`sg.party.${e.partyType}`, e.partyType)}</span> : null}
              </span>
              <span className="dim">{e.by ?? t('rm.system')}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
