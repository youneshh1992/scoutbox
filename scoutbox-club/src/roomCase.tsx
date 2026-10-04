// M24B — the Recruitment Room's new subcategory panels.
//
// Every panel here is either a function the Room already had, moved to its
// own page (Tasks), or a READ over records the Room already reads (Journey,
// Second Look, Inbox, Documents, Timeline, Previous …). None of them writes
// anything new, none invents an event, none keeps a store of its own: a
// document is listed where it lives, a previous Offer is the Offer record
// read back, the timeline is the server's journey history.
import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { Icon } from '../../design-system/icons';
import { ApiError, api, type Session, type Channel } from './api';
import {
  rooms, ROOM_TASK_STATES,
  type Room, type RoomJourney, type RoomDecision, type OfferSurface, type SigningSurface, type DecisionSurface, type TrialList, type SigningClubView,
} from './roomsApi';
import { m18, type SecondLookItem } from './m18Api';
import type { StaffRow } from './m12api';
import { t, fmtDateTime } from './i18n';
import { JourneyTimeline, stageLabel, nextActionLabel } from './journeyStrip';
import { offerStatusLabel } from './offerPanel';
import { signingStatusLabel } from './signingPanel';
import { DecisionCard } from './decisionPanel';
import { resolveTab } from '../../design-system/caseNav';
import { ROOM_NAV } from './caseNav';

export interface CasePanelProps {
  session: Session;
  room: Room;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
  staff: StaffRow[];
  journey?: RoomJourney | null;
  /** Jump to another subcategory of this case (a sub id or a legacy tab id). */
  openSub: (sub: string) => void;
}

const errText = (e: unknown) => (e instanceof ApiError ? (e.code === 'ROOM_VERSION_CONFLICT' ? t('common.conflict') : e.message) : e instanceof Error ? e.message : 'failed');
const taskStateLabel = (code: string) => t(`rm.task.${code}`, code.replace(/_/g, ' '));
const shortSha = (sha: string | null | undefined) => (sha ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : '—');

function useRead<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((b) => b + 1), []);
  useEffect(() => {
    let live = true;
    setError(null);
    fn().then((d) => { if (live) setData(d); }).catch((e) => { if (live) { setData(null); setError(errText(e)); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bump]);
  return { data, error, reload };
}

const Loading = () => <div className="dim">{t('rm.loading')}</div>;
const Refusal = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="notice block" role="status">{message}{onRetry && <> <button onClick={onRetry}>{t('common.retry', 'Try again')}</button></>}</div>
);
const Note = ({ children }: { children: React.ReactNode }) => <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{children}</div>;

/** The sub a journey resource belongs to. */
const RESOURCE_SUB: Record<string, string> = {
  contactId: 'contact', trialRequestId: 'trial', trialId: 'trial', assessmentId: 'assessments', decisionId: 'decision',
  offerId: 'offer', offerRevisionId: 'offer', signingPackageId: 'signing', completedSigningId: 'signing',
};
const subLabel = (sub: string) => t(`rm.tab.${resolveTab(ROOM_NAV, sub)?.sub ?? sub}`, sub);

// ------------------------------------------------------------------ Journey
export function JourneyPanel({ journey, openSub }: CasePanelProps) {
  if (!journey) return <Loading />;
  const jb = journey.journey;
  if (!jb) return <div className="notice block">{t('rm.jnUnavailable')}</div>;
  const na = jb.nextAction;
  const resources = Object.entries(jb.resources ?? {}).filter(([, v]) => !!v);
  return (
    <>
      <div className="section" aria-label={t('rm.jnCurrent')}>
        <h4>{t('rm.jnCurrent')}</h4>
        <div className="list-rows">
          <div className="list-row"><span className="grow">{t('rm.jnCurrent')}</span><span className="pill blue" data-testid="journey-current-stage">{stageLabel(jb.stage)}</span></div>
          <div className="list-row"><span className="grow">{t('jn.nextLabel')}</span><span>{nextActionLabel(na.code)}{na.kind === 'await' ? ` · ${t('rm.tasksAwait')}` : ''}</span>{na.kind !== 'none' && <button onClick={() => openSub(na.tab)}>{t('rm.jnOpen')} {subLabel(na.tab)}</button>}</div>
          {jb.classification !== 'canonical' && <div className="list-row"><span className="grow">{t(`jn.class.${jb.classification}`)}</span>{jb.integrity.length > 0 && <span className="dim">{jb.integrity.join(', ')}</span>}</div>}
        </div>
        <Note>{t('rm.jnNote')}</Note>
      </div>
      <div className="section" aria-label={t('rm.jnDone')}>
        <h4>{t('rm.jnDone')} <span className="dim" style={{ fontSize: 12.5 }}>({jb.completedStages.length})</span></h4>
        {jb.completedStages.length === 0 ? <div className="dim">{t('rm.jnNone')}</div> : (
          <ol className="list-rows" style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="journey-completed">
            {jb.completedStages.map((c) => (
              <li key={c.stage} className="list-row" style={{ flexWrap: 'wrap' }} data-stage={c.stage}>
                <span className="grow"><span aria-hidden="true">✓ </span>{stageLabel(c.stage)}</span>
                <span className="dim">{t(`rm.jnBasis.${c.basis}`, c.basis)}</span>
                <span className="dim">{c.at ? fmtDateTime(c.at) : ''}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="section" aria-label={t('rm.jnRecords')}>
        <h4>{t('rm.jnRecords')}</h4>
        {resources.length === 0 ? <div className="dim">{t('rm.jnNoRecords')}</div> : (
          <div className="list-rows" data-testid="journey-resources">
            {resources.map(([k, v]) => (
              <div key={k} className="list-row" style={{ flexWrap: 'wrap' }}>
                <span className="grow">{t(`rm.jnRes.${k}`, k.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase())}</span>
                <span className="dim" style={{ fontSize: 12 }}>{v}</span>
                {RESOURCE_SUB[k] && <button onClick={() => openSub(RESOURCE_SUB[k])}>{t('rm.jnOpen')} {subLabel(RESOURCE_SUB[k])}</button>}
              </div>
            ))}
          </div>
        )}
      </div>
      {journey.lifecycle && (
        <div className="section" aria-label={t('rm.jnLifecycle')}>
          <h4>{t('rm.jnLifecycle')}</h4>
          <div className="list-rows">
            <div className="list-row"><span className="grow">{t('rm.status')}</span><span className="pill">{t(`rm.st.${journey.lifecycle.currentStage}`, journey.lifecycle.currentStage.replace(/_/g, ' '))}</span></div>
            <div className="list-row"><span className="grow">{t('rm.jnAllowed')}</span><span className="dim">{journey.lifecycle.allowedNext.length ? journey.lifecycle.allowedNext.map((s) => t(`rm.st.${s}`, s.replace(/_/g, ' '))).join(', ') : '—'}</span></div>
            {(journey.lifecycle.terminal || journey.lifecycle.reopenable) && <div className="list-row"><span className="grow">{journey.lifecycle.terminal ? t('rm.jnTerminal') : ''}{journey.lifecycle.terminal && journey.lifecycle.reopenable ? ' · ' : ''}{journey.lifecycle.reopenable ? t('rm.jnReopenable') : ''}</span></div>}
          </div>
          {journey.generatedAt ? <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>{t('jn.asOf')} {fmtDateTime(journey.generatedAt)}</div> : null}
        </div>
      )}
    </>
  );
}

// -------------------------------------------------------------------- Tasks
export function TasksPanel({ session, room, notify, reload, staff, journey, openSub }: CasePanelProps) {
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const na = journey?.journey?.nextAction ?? null;

  const addTask = async () => {
    if (!title.trim()) return;
    try {
      await rooms.createTask(session, room.roomId, { title: title.trim(), assigneeUserId: assignee || null });
      notify(t('rm.taskAdded'));
      setTitle(''); setAssignee('');
      reload();
    } catch (e) { notify(errText(e), true); }
  };
  const setTaskStatus = async (taskId: string, status: string) => {
    try { await rooms.updateTask(session, room.roomId, taskId, { status }); reload(); }
    catch (e) { notify(errText(e), true); }
  };

  return (
    <>
      <div className="section" aria-label={t('rm.tasksNext')} data-testid="tasks-next">
        <h4>{t('rm.tasksNext')}</h4>
        {!journey ? <Loading /> : !na ? <div className="dim">{t('rm.jnUnavailable')}</div> : (
          <div className="list-rows">
            <div className="list-row" style={{ flexWrap: 'wrap' }} data-next={na.code} data-kind={na.kind}>
              <span className="grow">
                {na.kind === 'await' && <Icon name="clock" size={13} label="waiting" />}
                {na.kind === 'none' && <span aria-hidden="true">■ </span>}
                <b>{nextActionLabel(na.code)}</b>
                {na.kind === 'await' && <span className="dim"> · {t('rm.tasksAwait')}</span>}
                {na.kind === 'none' && <span className="dim"> · {t('rm.tasksNone')}</span>}
              </span>
              {na.stage && <span className="pill">{stageLabel(na.stage)}</span>}
              {na.kind !== 'none' && <button className={na.kind === 'club' ? 'primary' : ''} disabled={na.permitted === false || na.blockedBy.length > 0} onClick={() => openSub(na.tab)}>{t('rm.jnOpen')} {subLabel(na.tab)}</button>}
            </div>
            {(na.permitted === false || na.blockedBy.length > 0) && <div className="dim" style={{ fontSize: 12.5 }}>{na.blockedBy.length > 0 ? na.blockedBy.map((b) => t(`jn.blocked.${b}`, b)).join(' ') : t('jn.notPermitted')}</div>}
          </div>
        )}
        <Note>{t('rm.tasksNextNote')}</Note>
      </div>

      <div className="section" aria-label={t('rm.tasks')}>
        <h4>{t('rm.tasks')}</h4>
        <Note>{t('rm.tasksNote')}</Note>
        <div className="list-rows">
          {room.tasks.map((task) => (
            <div key={task.id} className="list-row" style={{ flexWrap: 'wrap' }}>
              <span className="grow"><b>{task.title}</b>{task.description ? <span className="dim"> — {task.description}</span> : null}</span>
              <span className="dim">{task.assigneeName ?? t('rm.unassigned')}</span>
              <select aria-label={`${t('rm.taskStatus')} ${task.title}`} value={task.status} onChange={(e) => setTaskStatus(task.id, e.target.value)}>
                {ROOM_TASK_STATES.map((s) => <option key={s} value={s}>{taskStateLabel(s)}</option>)}
              </select>
            </div>
          ))}
          {room.tasks.length === 0 && <div className="dim">{t('rm.noTasks')}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <input style={{ flex: 1, minWidth: 160 }} aria-label={t('rm.taskTitle')} placeholder={t('rm.taskTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <select aria-label={t('rm.assignee')} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t('rm.unassigned')}</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="primary" onClick={addTask}>{t('rm.newTask')}</button>
        </div>
      </div>
    </>
  );
}

// -------------------------------------------------------------- Second Look
export function SecondLookPanel({ session, room }: CasePanelProps) {
  const r = useRead(() => m18.secondLook(session, { status: 'all', limit: 100 }), [session, room.roomId, room.rev]);
  if (r.error) return <div className="section" aria-label={t('rm.tab.secondlook')}><Refusal message={r.error} onRetry={r.reload} /></div>;
  if (!r.data) return <Loading />;
  const items = (r.data.items ?? []).filter((it: SecondLookItem) => it.playerId === room.playerId);
  return (
    <div className="section" aria-label={t('rm.tab.secondlook')} data-testid="room-secondlook">
      <h4>{t('rm.tab.secondlook')} <span className="dim" style={{ fontSize: 12.5 }}>({items.length})</span></h4>
      <Note>{t('rm.slNote')}</Note>
      {items.length === 0 ? <div className="dim">{t('rm.slNone')}</div> : (
        <div className="list-rows">
          {items.map((it: SecondLookItem) => (
            <div key={it.id} className="list-row" style={{ flexWrap: 'wrap' }} data-second-look={it.id} data-status={it.status}>
              <span className="grow"><b>{it.kindLabel ?? it.kind ?? t('rm.tab.secondlook')}</b>{it.summary ? <span className="dim"> — {it.summary}</span> : null}</span>
              <span className="pill">{t(`sl.st.${it.status}`, it.status)}</span>
              <span className="dim">{it.latestChangeAt ? fmtDateTime(it.latestChangeAt) : it.decisionAt ? fmtDateTime(it.decisionAt) : ''}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8 }}><a className="linklike" href="#/recruitment/second-look">{t('rm.slOpen')}</a></div>
    </div>
  );
}

// -------------------------------------------------------------------- Inbox
export function InboxPanel({ session, room }: CasePanelProps) {
  const r = useRead(() => api.getChannels(session), [session, room.roomId, room.rev]);
  if (!room.playerAvailable) return <div className="notice block">{room.unavailableNote ?? t('rm.unavailable')}</div>;
  if (r.error) return <div className="section" aria-label={t('rm.tab.inbox')}><Refusal message={r.error} onRetry={r.reload} /></div>;
  if (!r.data) return <Loading />;
  const threads = (r.data as Channel[]).filter((c) => c.playerId === room.playerId);
  return (
    <div className="section" aria-label={t('rm.tab.inbox')} data-testid="room-inbox">
      <h4>{t('rm.tab.inbox')} <span className="dim" style={{ fontSize: 12.5 }}>({threads.length})</span></h4>
      <Note>{t('rm.inboxNote')}</Note>
      {threads.length === 0 ? <div className="dim">{t('rm.inboxNone')}</div> : (
        <div className="list-rows">
          {threads.map((c) => {
            const last = c.messages[c.messages.length - 1];
            return (
              <div key={c.id} className="list-row" style={{ flexWrap: 'wrap' }} data-channel={c.id}>
                <span className="grow"><b>{c.counterparty === 'guardian' ? t('ct.routeGuardian') : t('ct.routePlayer')}</b> <span className="dim">· {c.scoutName}{c.scoutRole ? ` (${c.scoutRole})` : ''}</span></span>
                <span className="dim">{c.messages.length} {t('rm.inboxMessages')}</span>
                {last && <span className="dim">{t('rm.inboxLast')} {fmtDateTime(last.ts ?? c.createdAt)}</span>}
                {c.closed && <span className="pill">{t('rm.inboxClosed')}</span>}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 8 }}><a className="linklike" href="#/messages">{t('rm.inboxOpen')}</a></div>
    </div>
  );
}

// ---------------------------------------------------------------- Documents
export function DocumentsPanel({ session, room, notify, openSub }: CasePanelProps) {
  const offers = useRead(() => rooms.offers(session, room.roomId), [session, room.roomId, room.rev]);
  const signing = useRead(() => rooms.signing(session, room.roomId), [session, room.roomId, room.rev]);
  const [busy, setBusy] = useState(false);
  const open = async (pkg: SigningClubView, kind: 'document' | 'executed') => {
    if (busy) return;
    setBusy(true);
    try {
      const d = await rooms.signingDocument(session, pkg.id, kind);
      if (d.file) window.open(`data:${d.file.mime};base64,${d.file.base64}`, '_blank', 'noopener');
      notify(t('rm.docsOpened'));
    } catch (e) { notify(errText(e), true); }
    finally { setBusy(false); }
  };
  const offerDocs = (offers.data as OfferSurface | null)?.offers.flatMap((o) => o.revisions.flatMap((r) => r.documents.map((d) => ({ offer: o, revision: r, doc: d })))) ?? [];
  const packages = (signing.data as SigningSurface | null)?.packages ?? [];
  const signingDocs = packages.flatMap((p) => p.revisions.flatMap((r) => [
    ...(r.document ? [{ pkg: p, revision: r, doc: r.document, kind: 'document' as const }] : []),
    ...(r.executedDocument ? [{ pkg: p, revision: r, doc: r.executedDocument, kind: 'executed' as const }] : []),
  ]));
  const loading = !offers.data && !offers.error || !signing.data && !signing.error;
  return (
    <div className="section" aria-label={t('rm.tab.documents')} data-testid="room-documents">
      <h4>{t('rm.tab.documents')} <span className="dim" style={{ fontSize: 12.5 }}>({offerDocs.length + signingDocs.length})</span></h4>
      <Note>{t('rm.docsNote')}</Note>
      {offers.error && <Refusal message={offers.error} onRetry={offers.reload} />}
      {signing.error && <Refusal message={signing.error} onRetry={signing.reload} />}
      {loading && <Loading />}
      {!loading && offerDocs.length + signingDocs.length === 0 && !offers.error && !signing.error && <div className="dim">{t('rm.docsNone')}</div>}
      <div className="list-rows">
        {offerDocs.map(({ offer, revision, doc }) => (
          <div key={`o-${revision.id}-${doc.id}`} className="list-row" style={{ flexWrap: 'wrap' }} data-document={doc.id} data-source="offer" data-offer={offer.id}>
            <span className="grow"><b>{doc.label ?? doc.id}</b> <span className="dim">· {t('rm.docsOffer')} {revision.revisionNumber} · {offerStatusLabel(revision.status)}</span></span>
            <span className="dim" style={{ fontSize: 12 }}>{t('rm.docsInOffer')}</span>
            <button onClick={() => openSub('offer')}>{t('rm.jnOpen')} {subLabel('offer')}</button>
          </div>
        ))}
        {signingDocs.map(({ pkg, revision, doc, kind }) => (
          <div key={`s-${revision.id}-${kind}`} className="list-row" style={{ flexWrap: 'wrap' }} data-document={doc.id ?? revision.id} data-source="signing">
            <span className="grow"><b>{doc.label ?? doc.filename ?? t('sg.document', 'Document')}</b>{kind === 'executed' ? <span className="dim"> · {t('rm.docsExecuted')}</span> : null} <span className="dim">· {t('rm.docsSigning')} {revision.revisionNumber} · {signingStatusLabel(revision.status)}</span></span>
            <span className="dim" style={{ fontSize: 12 }} title={doc.sha256 ?? undefined}>{t('rm.docsDigest')} {shortSha(doc.sha256)}</span>
            {revision.id === pkg.currentRevisionId
              ? <button disabled={busy} onClick={() => open(pkg, kind)}>{t('rm.docsOpen')}</button>
              : <button onClick={() => openSub('signing')}>{t('rm.jnOpen')} {subLabel('signing')}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- Timeline
export function TimelinePanel({ journey }: CasePanelProps) {
  if (!journey) return <Loading />;
  return <JourneyTimeline journey={journey} />;
}

// ------------------------------------------------------- Previous decisions
export function PastDecisionsPanel({ session, room }: CasePanelProps) {
  const r = useRead(() => rooms.decision(session, room.roomId), [session, room.roomId, room.rev]);
  const recs: RoomDecision[] = room.decision.history.slice().sort((a, b) => b.createdAt - a.createdAt);
  const formal = (r.data as DecisionSurface | null)?.history ?? [];
  return (
    <>
      <div className="section" aria-label={t('rm.hFormal')} data-testid="past-decisions">
        <h4>{t('rm.hFormal')} <span className="dim" style={{ fontSize: 12.5 }}>({formal.length})</span></h4>
        <Note>{t('rm.hNote')}</Note>
        {r.error && <Refusal message={r.error} onRetry={r.reload} />}
        {!r.data && !r.error && <Loading />}
        {r.data && formal.length === 0 && <div className="dim">{t('rm.hNone')}</div>}
        <div className="list-rows">{formal.map((d) => <DecisionCard key={d.id} d={d} compact />)}</div>
        {r.data && (r.data as DecisionSurface).omitted > 0 && <div className="notice block" style={{ marginTop: 6 }}>{(r.data as DecisionSurface).omitted} {t('ct.omitted')}</div>}
      </div>
      <div className="section" aria-label={t('rm.hAdvisory')}>
        <h4>{t('rm.hAdvisory')} <span className="dim" style={{ fontSize: 12.5 }}>({recs.length})</span></h4>
        {recs.length === 0 ? <div className="dim">{t('rm.hNone')}</div> : (
          <div className="list-rows">
            {recs.map((d) => (
              <div key={d.id} className="list-row" style={{ flexWrap: 'wrap' }} data-recommendation={d.id}>
                <span className="grow"><b>{t(`rm.rec.${d.recommendation}`, d.recommendation.replace(/_/g, ' '))}</b> <span className="dim">· {d.by.name}{d.by.role ? ` (${d.by.role})` : ''} · {fmtDateTime(d.createdAt)}</span></span>
                {d.reasonCodes.map((c) => <span key={c} className="pill">{t(`rm.reason.${c}`, c.replace(/_/g, ' '))}</span>)}
                {d.supersededById && <span className="pill">{t('rm.superseded')}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('rm.decisionAppendOnly')}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------- Previous trials
export function PastTrialsPanel({ session, room, openSub }: CasePanelProps) {
  const r = useRead(() => rooms.trials(session, room.roomId), [session, room.roomId, room.rev]);
  if (r.error) return <div className="section" aria-label={t('rm.tab.past-trials')}><Refusal message={r.error} onRetry={r.reload} /></div>;
  if (!r.data) return <Loading />;
  const list = r.data as TrialList;
  const past = list.items.filter((x) => !!x.completion || /completed|cancelled|declined/.test(x.workflowState));
  return (
    <div className="section" aria-label={t('rm.tab.past-trials')} data-testid="past-trials">
      <h4>{t('rm.tab.past-trials')} <span className="dim" style={{ fontSize: 12.5 }}>({past.length})</span></h4>
      <Note>{t('rm.hNote')}</Note>
      {past.length === 0 ? <div className="dim">{t('rm.hNone')}</div> : (
        <div className="list-rows">
          {past.map((x) => (
            <div key={x.id} className="list-row" style={{ flexWrap: 'wrap' }} data-trial={x.id} data-state={x.workflowState}>
              <span className="grow"><b>{x.workflowLabel}</b>{x.completion ? <span className="dim"> · {x.completion.state === 'completed' ? t('rm.hCompleted') : t('rm.hCancelled')} {fmtDateTime(x.completion.at)}{x.completion.reason ? ` — ${x.completion.reason}` : ''}</span> : null}</span>
              <span className="dim">{x.schedule?.sessions.length ?? 0} {t('rm.hSessions')}</span>
              <span className="pill">{x.reportStatus === 'reported' ? t('rm.hReported') : t('rm.hReportOwed')}</span>
            </div>
          ))}
        </div>
      )}
      {list.omitted > 0 && <div className="notice block" style={{ marginTop: 6 }}>{list.omitted} {t('ct.omitted')}</div>}
      <div style={{ marginTop: 8 }}><button onClick={() => openSub('trial')}>{t('rm.jnOpen')} {subLabel('trial')}</button></div>
    </div>
  );
}

// ---------------------------------------------------------- Previous offers
export function PastOffersPanel({ session, room, openSub }: CasePanelProps) {
  const r = useRead(() => rooms.offers(session, room.roomId), [session, room.roomId, room.rev]);
  if (r.error) return <div className="section" aria-label={t('rm.tab.past-offers')}><Refusal message={r.error} onRetry={r.reload} /></div>;
  if (!r.data) return <Loading />;
  const s = r.data as OfferSurface;
  const past = s.offers.filter((o) => o.id !== s.liveOfferId);
  return (
    <div className="section" aria-label={t('rm.tab.past-offers')} data-testid="past-offers">
      <h4>{t('rm.tab.past-offers')} <span className="dim" style={{ fontSize: 12.5 }}>({past.length})</span></h4>
      <Note>{t('rm.hNote')}</Note>
      {past.length === 0 ? <div className="dim">{t('rm.hNone')}</div> : (
        <div className="list-rows">
          {past.map((o) => {
            const last = o.responses[o.responses.length - 1];
            return (
              <div key={o.id} className="list-row" style={{ flexWrap: 'wrap' }} data-offer={o.id} data-status={o.status}>
                <span className="grow"><b>{offerStatusLabel(o.status)}</b> <span className="dim">· {o.revisions.length} {t('rm.hRevisions')} · {fmtDateTime(o.updatedAt ?? o.createdAt)}</span></span>
                {last && <span className="dim">{t('rm.hResponse')}: {t(last.responseType === 'accepted' ? 'of.respAccepted' : 'of.respDeclined')} · {fmtDateTime(last.occurredAt)}</span>}
              </div>
            );
          })}
        </div>
      )}
      {s.liveOfferId && <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{t('rm.hLive')} {t('rm.cat.deal')} › {t('rm.tab.offer')}.</div>}
      <div style={{ marginTop: 8 }}><button onClick={() => openSub('offer')}>{t('rm.jnOpen')} {subLabel('offer')}</button></div>
    </div>
  );
}

// -------------------------------------------------------- Previous signings
export function PastSigningsPanel({ session, room, openSub }: CasePanelProps) {
  const r = useRead(() => rooms.signing(session, room.roomId), [session, room.roomId, room.rev]);
  if (r.error) return <div className="section" aria-label={t('rm.tab.past-signings')}><Refusal message={r.error} onRetry={r.reload} /></div>;
  if (!r.data) return <Loading />;
  const s = r.data as SigningSurface;
  const past = s.packages.filter((p) => p.id !== s.livePackageId);
  return (
    <div className="section" aria-label={t('rm.tab.past-signings')} data-testid="past-signings">
      <h4>{t('rm.tab.past-signings')} <span className="dim" style={{ fontSize: 12.5 }}>({past.length})</span></h4>
      <Note>{t('rm.hNote')}</Note>
      {past.length === 0 ? <div className="dim">{t('rm.hNone')}</div> : (
        <div className="list-rows">
          {past.map((p) => (
            <div key={p.id} className="list-row" style={{ flexWrap: 'wrap' }} data-signing={p.id} data-status={p.status ?? ''}>
              <span className="grow"><b>{signingStatusLabel(p.status)}</b> <span className="dim">· {t('sg.revision', 'revision')} {p.currentRevision?.revisionNumber ?? '—'} · {fmtDateTime(p.updatedAt)}</span></span>
              {p.completion && <span className="dim">{t('rm.hCompleted')} {fmtDateTime(p.completion.completedAt)}{p.completion.contract?.startDate ? ` · ${p.completion.contract.startDate}${p.completion.contract.endDate ? ` → ${p.completion.contract.endDate}` : ''}` : ''}</span>}
              {p.cancelledAt && <span className="dim">{t('rm.hCancelled')} {fmtDateTime(p.cancelledAt)}</span>}
            </div>
          ))}
        </div>
      )}
      {s.legacySigning && <div className="notice" style={{ marginTop: 6 }}>{t('sg.legacy').replace('{when}', fmtDateTime(s.legacySigning.at ?? 0))}</div>}
      <div style={{ marginTop: 8 }}><button onClick={() => openSub('signing')}>{t('rm.jnOpen')} {subLabel('signing')}</button></div>
    </div>
  );
}
