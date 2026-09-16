// M23 P4B — the Trial tab of a Recruitment Room.
//
// One operational workflow, rendered as the server holds it: an invitation
// (a request the family answers), a trial that exists only once they accept,
// a schedule that is confirmed only when they confirm it, attendance recorded
// per session after it starts, completion as an explicit act behind the
// server's gate, Box Cam evidence cited by reference, and assessments listed
// as existing — never their content. Every gate on this screen is a mirror
// of a server gate; the server decides.
//
// What never appears here: the family's emergency contact, an observation
// payload, a numeric confidence, an assessment body, a recruitment decision.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type Session } from './api';
import { ConflictNotice, conflictOf, type Conflict } from './conflict';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';
import {
  rooms, type Room, type TrialList, type TrialClubView, type TrialDetail, type TrialSessionView, type TrialSessionInput,
  type TrialAttendanceState, type TrialEvidenceView, type TrialEvidenceCandidate, type TrialCaseMove,
} from './roomsApi';
import { m12 } from './m12api';
import { t, fmtDateTime } from './i18n';

interface TrialPanelProps {
  session: Session;
  room: Room;
  notify: (text: string, error?: boolean) => void;
  reload: () => void;
}

// ------------------------------------------------------------------ time
// The club types wall-clock times IN THE ORGANISER ZONE. The browser may sit
// in another zone, so a datetime-local value is converted to an instant with
// the chosen zone, never with the browser's.
const ZONES = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Lisbon', 'Europe/Berlin', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Istanbul', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Cairo', 'Africa/Accra', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City', 'America/Argentina/Buenos_Aires', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];
function zoneOffsetMs(ms: number, zone: string): number {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return asUtc - ms;
}
/** `YYYY-MM-DDTHH:MM` in `zone` → UTC ms (two passes so DST edges land on the right side). */
export function wallToInstant(local: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    const first = guess - zoneOffsetMs(guess, zone);
    return first - (zoneOffsetMs(first, zone) - zoneOffsetMs(guess, zone));
  } catch { return null; }
}
/** UTC ms → `YYYY-MM-DDTHH:MM` wall-clock in `zone` (for editing an existing session). */
export function instantToWall(ms: number, zone: string): string {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  } catch { return ''; }
}
const fmtIn = (ms: number, zone: string | null) => {
  try { return new Date(ms).toLocaleString(undefined, { timeZone: zone ?? undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return fmtDateTime(ms); }
};
const fmtRange = (s: { startsAt: number; endsAt: number }, zone: string | null) => {
  try { return `${fmtIn(s.startsAt, zone)} – ${new Date(s.endsAt).toLocaleTimeString(undefined, { timeZone: zone ?? undefined, hour: '2-digit', minute: '2-digit' })}`; } catch { return `${fmtDateTime(s.startsAt)} – ${fmtDateTime(s.endsAt)}`; }
};
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

export function trialErrMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const specific = t(`tr.err.${e.code}`, '');
    const reasons = (e.details as { reasons?: string[] } | null)?.reasons;
    const tail = Array.isArray(reasons) && reasons.length ? ` ${reasons.map((r) => t(`tr.reason.${r}`, r.replace(/_/g, ' '))).join(' · ')}` : '';
    if (specific) return `${specific}${tail}`;
    if (/VERSION_CONFLICT$/.test(e.code)) return t('common.conflict');
    if (e.code === 'RATE_LIMITED') return t('rm.errRateLimited');
    return `${e.message}${tail}`;
  }
  return e instanceof Error ? e.message : 'failed';
}

const stateTone = (s: string) => (s === 'scheduled' ? 'blue' : s === 'completed' ? 'green' : s === 'cancelled' ? 'red' : 'gold');
const attTone = (s: string) => (s === 'attended' ? 'green' : s === 'partial' ? 'gold' : s === 'not_recorded' ? '' : 'red');
const stateLabel = (s: string, fallback?: string) => t(`tr.state.${s}`, fallback ?? s.replace(/_/g, ' '));
const kindLabel = (k: string | null | undefined) => t(`tr.kind.${k ?? 'training'}`, (k ?? 'training').replace(/_/g, ' '));
const attLabel = (s: string) => t(`tr.att.${s}`, s.replace(/_/g, ' '));

interface SessionDraft { id?: string; kind: string; start: string; end: string; venueName: string; venueTown: string; venueAddress: string; instructions: string }
const blankSession = (venue?: { name: string; town: string; address: string }): SessionDraft => ({ kind: 'training', start: '', end: '', venueName: venue?.name ?? '', venueTown: venue?.town ?? '', venueAddress: venue?.address ?? '', instructions: '' });
const draftsOf = (sessions: TrialSessionView[], zone: string): SessionDraft[] => sessions.map((s) => ({ id: s.id, kind: s.kind, start: instantToWall(s.startsAt, zone), end: instantToWall(s.endsAt, zone), venueName: s.venue?.name ?? '', venueTown: s.venue?.town ?? '', venueAddress: s.venue?.address ?? '', instructions: s.instructions ?? '' }));
function toInputs(drafts: SessionDraft[], zone: string): TrialSessionInput[] {
  return drafts.map((d) => {
    const startsAt = wallToInstant(d.start, zone); const endsAt = wallToInstant(d.end, zone);
    if (startsAt === null || endsAt === null) throw new ApiError(400, 'TRIAL_SCHEDULE_INVALID', t('tr.err.TRIAL_SCHEDULE_INVALID'));
    return { ...(d.id ? { id: d.id } : {}), kind: d.kind, startsAt, endsAt, venue: { name: d.venueName.trim(), town: d.venueTown.trim() || null, address: d.venueAddress.trim() || null }, instructions: d.instructions.trim() || null };
  });
}

function SessionEditor({ drafts, setDrafts, max, kinds, disabled, allowRemove }: { drafts: SessionDraft[]; setDrafts: (d: SessionDraft[]) => void; max: number; kinds: string[]; disabled: boolean; allowRemove: boolean }) {
  const up = (i: number, patch: Partial<SessionDraft>) => setDrafts(drafts.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {drafts.map((d, i) => (
        <div key={d.id ?? i} className="room-details" style={{ padding: 8, border: '1px solid var(--line)', borderRadius: 8 }} aria-label={`${t('tr.session')} ${i + 1}`}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ fontSize: 12.5 }}>{t('tr.kind')}<br />
              <select aria-label={`${t('tr.kind')} ${i + 1}`} value={d.kind} disabled={disabled} onChange={(e) => up(i, { kind: e.target.value })}>
                {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12.5 }}>{t('tr.starts')}<br /><input type="datetime-local" aria-label={`${t('tr.starts')} ${i + 1}`} value={d.start} disabled={disabled} onChange={(e) => up(i, { start: e.target.value })} /></label>
            <label style={{ fontSize: 12.5 }}>{t('tr.ends')}<br /><input type="datetime-local" aria-label={`${t('tr.ends')} ${i + 1}`} value={d.end} disabled={disabled} onChange={(e) => up(i, { end: e.target.value })} /></label>
            {allowRemove && drafts.length > 1 && <button type="button" disabled={disabled} onClick={() => setDrafts(drafts.filter((_, k) => k !== i))}>{t('tr.removeSession')}</button>}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <input style={{ flex: '1 1 140px' }} aria-label={`${t('tr.venueName')} ${i + 1}`} placeholder={t('tr.venueName')} maxLength={120} value={d.venueName} disabled={disabled} onChange={(e) => up(i, { venueName: e.target.value })} />
            <input style={{ flex: '1 1 100px' }} aria-label={`${t('tr.venueTown')} ${i + 1}`} placeholder={t('tr.venueTown')} maxLength={80} value={d.venueTown} disabled={disabled} onChange={(e) => up(i, { venueTown: e.target.value })} />
            <input style={{ flex: '2 1 180px' }} aria-label={`${t('tr.venueAddress')} ${i + 1}`} placeholder={t('tr.venueAddress')} maxLength={200} value={d.venueAddress} disabled={disabled} onChange={(e) => up(i, { venueAddress: e.target.value })} />
          </div>
          <input style={{ width: '100%', marginTop: 6 }} aria-label={`${t('tr.instructions')} ${i + 1}`} placeholder={t('tr.instructions')} maxLength={500} value={d.instructions} disabled={disabled} onChange={(e) => up(i, { instructions: e.target.value })} />
        </div>
      ))}
      {drafts.length < max && <button type="button" disabled={disabled} onClick={() => setDrafts([...drafts, blankSession(drafts[drafts.length - 1] ? { name: drafts[drafts.length - 1].venueName, town: drafts[drafts.length - 1].venueTown, address: drafts[drafts.length - 1].venueAddress } : undefined)])}>{t('tr.addSession')}</button>}
    </div>
  );
}

export function TrialPanel({ session, room, notify, reload }: TrialPanelProps) {
  const [data, setData] = useState<TrialList | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [live, setLive] = useState('');
  // Invitation form.
  const [zone, setZone] = useState(browserZone());
  const [venue, setVenue] = useState({ name: '', town: '', address: '' });
  const [message, setMessage] = useState('');
  const [instructions, setInstructions] = useState('');
  const [slots, setSlots] = useState<SessionDraft[]>([blankSession()]);
  const inviteKey = useMemo(() => `tr-inv-${room.roomId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, [room.roomId, bump]);

  const refresh = useCallback(() => setBump((b) => b + 1), []);
  useEffect(() => {
    let on = true;
    setLoadErr(null);
    rooms.trials(session, room.roomId).then((d) => { if (on) setData(d); }).catch((e) => { if (on) setLoadErr(trialErrMessage(e)); });
    return () => { on = false; };
  }, [session, room.roomId, room.rev, bump]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setConflict(null);
    try { const msg = await fn(); setLive(msg); notify(msg); refresh(); reload(); }
    catch (e) { const c = conflictOf(e); if (c) setConflict(c); else { const m = trialErrMessage(e); setLive(m); notify(m, true); } }
    finally { setBusy(false); }
  };
  const moveText = (moved: TrialCaseMove | undefined) => (moved && 'to' in moved ? ` ${t('tr.caseMoved').replace('{status}', t(`rm.st.${moved.to}`, moved.to))}` : '');

  const sendInvitation = () => run(async () => {
    const slotInputs = toInputs(slots.map((s) => ({ ...s, venueName: venue.name, venueTown: venue.town, venueAddress: venue.address })), zone);
    const r = await rooms.inviteTrial(session, room.roomId, {
      timezone: zone, venue: { name: venue.name.trim(), town: venue.town.trim() || null, address: venue.address.trim() || null },
      message: message.trim(), instructions: instructions.trim() || null,
      slots: slotInputs.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, kind: s.kind })), clientKey: inviteKey,
    });
    setMessage(''); setInstructions(''); setSlots([blankSession()]);
    return `${r.idempotent ? t('tr.invitedAlready') : t('tr.invited')}${moveText(r.case)}`;
  });

  if (loadErr) return <div className="section" aria-label={t('tr.title')}><div className="notice block" role="alert"><div>{loadErr}</div><button style={{ marginTop: 6 }} onClick={refresh}>{t('common.retry')}</button></div></div>;
  if (!data) return <div className="section" aria-label={t('tr.title')}><div className="dim">{t('rm.loading')}</div></div>;

  const routing = data.routing;
  const openTrial = data.items.find((x) => x.workflowState === 'accepted' || x.workflowState === 'scheduled' || x.workflowState === 'legacy_accepted') ?? null;
  const pending = data.invitation && data.invitation.status === 'pending' ? data.invitation : null;
  const canInvite = data.canWrite && data.case.acceptsInvitation && routing.available && !pending && !openTrial && !data.blocked;

  return (
    <>
      <div className="section" aria-label={t('tr.title')}>
        <h4>{t('tr.title')}</h4>
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('tr.intro')}</div>
        <div className="badges" style={{ marginBottom: 8 }} aria-label={t('ct.routingLabel')}>
          {routing.available
            ? <span className={`pill ${routing.type === 'guardian' ? 'gold' : 'blue'}`}>{routing.type === 'guardian' ? t('tr.routeGuardian') : t('tr.routePlayer')}</span>
            : <span className="pill">{t('ct.routeUnavailable')}{routing.reason ? ` — ${t(`tr.err.${routing.reason}`, t(`ct.reason.${routing.reason}`, ''))}` : ''}</span>}
          {data.blocked && <span className="pill red">{t('tr.blocked')}</span>}
        </div>
        {!data.case.acceptsInvitation && !openTrial && !pending && (
          <div className="notice block" role="status" style={{ marginBottom: 8 }}>{t('tr.caseGate')} <span className="dim">({t('rm.status')}: {t(`rm.st.${data.case.status}`, data.case.status)})</span></div>
        )}
        {!data.canWrite && <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('tr.readOnly')}</div>}
        {conflict && <ConflictNotice conflict={conflict} onReload={() => { setConflict(null); refresh(); }} onKeepChanges={() => setConflict(null)} />}

        {pending && (
          <div className="notice block" role="status" aria-label={t('tr.invitationPending')} style={{ marginBottom: 8 }}>
            <b>{t('tr.invitationPending')}</b> <span className="dim">{fmtDateTime(pending.createdAt)}</span>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {pending.slots.map((sl) => <li key={sl.id}>{kindLabel(sl.kind)} · {fmtRange(sl, sl.timezone)} <span className="dim">({sl.timezone})</span>{sl.venue ? ` · ${sl.venue.name}${sl.venue.town ? `, ${sl.venue.town}` : ''}` : ''}</li>)}
            </ul>
            <div className="dim" style={{ fontSize: 12 }}>{t('tr.invitationNote')}</div>
          </div>
        )}
        {data.invitation && data.invitation.status === 'declined' && !openTrial && (
          <div className="notice block" role="status" style={{ marginBottom: 8 }}>{t('tr.invitationDeclined')} <span className="dim">{data.invitation.respondedAt ? fmtDateTime(data.invitation.respondedAt) : ''}</span></div>
        )}

        {data.canWrite && !pending && !openTrial && (
          <form onSubmit={(e) => { e.preventDefault(); sendInvitation(); }} aria-label={t('tr.compose')} className="room-details">
            <h5 style={{ margin: '4px 0 6px' }}>{t('tr.compose')}</h5>
            <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('tr.composeNote')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12.5 }}>{t('tr.timezone')}<br />
                <select aria-label={t('tr.timezone')} value={zone} disabled={!canInvite} onChange={(e) => setZone(e.target.value)}>
                  {[...new Set([zone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </label>
              <input style={{ flex: '1 1 140px' }} aria-label={t('tr.venueName')} placeholder={t('tr.venueName')} maxLength={data.limits.venueName} value={venue.name} disabled={!canInvite} onChange={(e) => setVenue({ ...venue, name: e.target.value })} />
              <input style={{ flex: '1 1 100px' }} aria-label={t('tr.venueTown')} placeholder={t('tr.venueTown')} maxLength={data.limits.venueTown} value={venue.town} disabled={!canInvite} onChange={(e) => setVenue({ ...venue, town: e.target.value })} />
            </div>
            <input style={{ width: '100%', marginTop: 6 }} aria-label={t('tr.venueAddress')} placeholder={t('tr.venueAddressHint')} maxLength={data.limits.venueAddress} value={venue.address} disabled={!canInvite} onChange={(e) => setVenue({ ...venue, address: e.target.value })} />
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12.5, marginBottom: 4 }}>{t('tr.slots')} <span className="dim">({t('tr.slotsNote').replace('{n}', String(data.limits.slots))})</span></div>
              <div style={{ display: 'grid', gap: 6 }}>
                {slots.map((d, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} aria-label={`${t('tr.slot')} ${i + 1}`}>
                    <label style={{ fontSize: 12.5 }}>{t('tr.kind')}<br />
                      <select aria-label={`${t('tr.slot')} ${i + 1} ${t('tr.kind')}`} value={d.kind} disabled={!canInvite} onChange={(e) => setSlots(slots.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}>
                        {data.vocabulary.sessionKinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                      </select>
                    </label>
                    <label style={{ fontSize: 12.5 }}>{t('tr.starts')}<br /><input type="datetime-local" aria-label={`${t('tr.slot')} ${i + 1} ${t('tr.starts')}`} value={d.start} disabled={!canInvite} onChange={(e) => setSlots(slots.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))} /></label>
                    <label style={{ fontSize: 12.5 }}>{t('tr.ends')}<br /><input type="datetime-local" aria-label={`${t('tr.slot')} ${i + 1} ${t('tr.ends')}`} value={d.end} disabled={!canInvite} onChange={(e) => setSlots(slots.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)))} /></label>
                    {slots.length > 1 && <button type="button" disabled={!canInvite} onClick={() => setSlots(slots.filter((_, k) => k !== i))}>{t('tr.removeSession')}</button>}
                  </div>
                ))}
                {slots.length < data.limits.slots && <div><button type="button" disabled={!canInvite} onClick={() => setSlots([...slots, blankSession()])}>{t('tr.addSlot')}</button></div>}
              </div>
            </div>
            <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>{t('tr.message')}
              <textarea style={{ width: '100%', minHeight: 70, marginTop: 2 }} aria-label={t('tr.message')} maxLength={data.limits.message} value={message} disabled={!canInvite} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <label style={{ display: 'block', fontSize: 13, marginTop: 6 }}>{t('tr.instructionsLabel')}
              <input style={{ width: '100%', marginTop: 2 }} aria-label={t('tr.instructionsLabel')} maxLength={data.limits.instructions} value={instructions} disabled={!canInvite} onChange={(e) => setInstructions(e.target.value)} />
            </label>
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('tr.sharedNote')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button type="submit" className="primary" disabled={busy || !canInvite || !message.trim() || !venue.name.trim() || slots.some((s) => !s.start || !s.end)}>{t('tr.sendInvitation')}</button>
            </div>
          </form>
        )}
        <div role="status" aria-live="polite" className="dim" style={{ fontSize: 12.5, marginTop: 8, minHeight: 16 }}>{live}</div>
      </div>

      <div className="section" aria-label={t('tr.listLabel')}>
        <h4>{t('tr.listLabel')} ({data.items.length})</h4>
        {data.omitted > 0 && <div className="notice block" role="status">{t('tr.omitted').replace('{n}', String(data.omitted))}</div>}
        {data.items.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('tr.none')}</div>}
        {data.items.slice().reverse().map((tr) => (
          <TrialCard key={tr.id} session={session} room={room} list={data} trial={tr} busy={busy} run={run} />
        ))}
      </div>
    </>
  );
}

function TrialCard({ session, room, list, trial: tr, busy, run }: { session: Session; room: Room; list: TrialList; trial: TrialClubView; busy: boolean; run: (fn: () => Promise<string>) => Promise<void> }) {
  const [detail, setDetail] = useState<TrialDetail | null>(null);
  const [candidates, setCandidates] = useState<{ items: TrialEvidenceCandidate[]; consent: boolean; reason: string | null } | null>(null);
  const [attState, setAttState] = useState<Record<string, TrialAttendanceState>>({});
  const [attNote, setAttNote] = useState<Record<string, string>>({});
  const [linkChoice, setLinkChoice] = useState<Record<string, string>>({});
  const [reschedule, setReschedule] = useState<SessionDraft[] | null>(null);
  const [rescheduleZone, setRescheduleZone] = useState(tr.schedule?.timezone ?? browserZone());
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const zone = tr.schedule?.timezone ?? null;
  const open = tr.workflowState === 'accepted' || tr.workflowState === 'scheduled' || tr.workflowState === 'legacy_accepted';
  const canWrite = list.canWrite && !list.blocked && !tr.subjectRemovedAt;
  const now = Date.now();

  useEffect(() => {
    let on = true;
    rooms.trial(session, room.roomId, tr.id).then((d) => { if (on) setDetail(d); }).catch(() => { if (on) setDetail(null); });
    if (list.canWrite && (tr.workflowState === 'scheduled' || tr.workflowState === 'completed')) {
      rooms.trialEvidenceCandidates(session, room.roomId, tr.id).then((c) => { if (on) setCandidates(c); }).catch(() => { if (on) setCandidates(null); });
    }
    return () => { on = false; };
  }, [session, room.roomId, tr.id, tr.rev, list.canWrite, tr.workflowState]);

  const sessions = tr.schedule?.sessions ?? [];
  const lastEnded = sessions.length > 0 && sessions.every((s) => s.endsAt <= now);
  const anyAttended = sessions.some((s) => s.attendance.state === 'attended' || s.attendance.state === 'partial');
  const completeBlockers: string[] = [];
  if (tr.workflowState !== 'scheduled') completeBlockers.push('schedule_not_confirmed');
  if (!anyAttended) completeBlockers.push('no_attended_session');
  if (!lastEnded) completeBlockers.push('last_session_not_ended');

  const recordAttendance = (s: TrialSessionView) => run(async () => {
    const state = attState[s.id] ?? 'attended';
    await rooms.recordTrialAttendance(session, room.roomId, tr.id, s.id, { state, note: attNote[s.id]?.trim() || null, expectedRev: tr.rev, clientKey: `tr-att-${tr.id}-${s.id}-${tr.rev}` });
    setAttNote((n) => ({ ...n, [s.id]: '' }));
    return t('tr.attendanceRecorded').replace('{state}', attLabel(state));
  });
  const complete = () => run(async () => {
    const r = await rooms.completeTrial(session, room.roomId, tr.id, { expectedRev: tr.rev, clientKey: `tr-comp-${tr.id}` });
    return `${t('tr.completed')}${r.case && 'to' in r.case ? ` ${t('tr.caseMoved').replace('{status}', t(`rm.st.${r.case.to}`, r.case.to))}` : ''}`;
  });
  const cancel = () => {
    if (!confirmDestructive({ ...DESTRUCTIVE_ACTIONS.cancelTrial, name: tr.playerName ?? '' })) return;
    run(async () => { await rooms.cancelTrial(session, room.roomId, tr.id, { reason: cancelReason.trim(), expectedRev: tr.rev, clientKey: `tr-cancel-${tr.id}-${tr.rev}` }); setCancelReason(''); return t('tr.cancelled'); });
  };
  const submitReschedule = () => run(async () => {
    if (!reschedule) return '';
    const r = await rooms.scheduleTrial(session, room.roomId, tr.id, { timezone: rescheduleZone, sessions: toInputs(reschedule, rescheduleZone), reason: rescheduleReason.trim() || null, expectedRev: tr.rev, clientKey: `tr-sched-${tr.id}-${tr.rev}` });
    setReschedule(null); setRescheduleReason('');
    return r.requiresConfirmation ? t('tr.rescheduledAwaiting') : t('tr.rescheduledKept');
  });
  const link = (s: TrialSessionView) => run(async () => {
    const boxSessionId = linkChoice[s.id];
    if (!boxSessionId) throw new ApiError(400, 'TRIAL_EVIDENCE_REF_INVALID', t('tr.err.TRIAL_EVIDENCE_REF_INVALID'));
    const r = await rooms.linkTrialEvidence(session, room.roomId, tr.id, s.id, { boxSessionId, expectedRev: tr.rev, clientKey: `tr-link-${tr.id}-${s.id}-${boxSessionId}` });
    return r.idempotent ? t('tr.linkedAlready') : t('tr.linked');
  });
  const unlink = (ev: TrialEvidenceView) => run(async () => { await rooms.unlinkTrialEvidence(session, room.roomId, tr.id, ev.id, { expectedRev: tr.rev }); return t('tr.unlinked'); });
  const openAssessment = () => run(async () => {
    await m12.createAssessment(session, tr.playerId, undefined, undefined, { trialId: tr.id });
    return t('tr.assessmentOpened');
  });

  return (
    <div className="room-details" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginTop: 8 }} aria-label={`${t('tr.trial')} ${tr.id}`} data-trial-id={tr.id} data-workflow-state={tr.workflowState}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className={`pill ${stateTone(tr.workflowState)}`} aria-label={t('tr.stateLabel')}>{stateLabel(tr.workflowState, tr.workflowLabel)}</span>
        {tr.legacy && <span className="pill">{t('tr.legacy')}</span>}
        {tr.schedule && !tr.schedule.legacy && tr.schedule.awaitingConfirmation && <span className="pill gold">{t('tr.awaitingFamily')}</span>}
        <span className={`pill ${tr.reportStatus === 'reported' ? 'green' : 'gold'}`}>{tr.reportStatus === 'reported' ? t('tr.reportFiled') : t('tr.reportOwed')}</span>
        {tr.recipient && <span className="pill">{tr.recipient.type === 'guardian' ? t('tr.viaGuardian') : t('tr.viaPlayer')}</span>}
        {tr.subjectRemovedAt && <span className="pill red">{t('tr.subjectRemoved')}</span>}
        <span className="dim" style={{ fontSize: 12 }}>{t('tr.rev')} {tr.rev}{tr.schedule ? ` · ${t('tr.revision')} ${tr.schedule.revision}` : ''}</span>
      </div>
      {tr.completion && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          {tr.completion.state === 'cancelled' ? t('tr.cancelledBy').replace('{who}', t(`tr.actor.${tr.completion.cancelledBy ?? tr.completion.by?.kind ?? 'club'}`, tr.completion.cancelledBy ?? '')) : t('tr.completedAt')} {fmtDateTime(tr.completion.at)}
          {tr.completion.reason ? ` — ${tr.completion.reason}` : ''}
        </div>
      )}
      {tr.schedule?.legacy && <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>{t('tr.legacyNote')} {tr.proposedDate ?? ''}{tr.venue ? ` · ${tr.venue}` : ''}</div>}

      {sessions.length > 0 && (
        <div style={{ marginTop: 8 }} aria-label={t('tr.sessions')}>
          <div style={{ fontSize: 12.5, marginBottom: 4 }}>{t('tr.sessions')} · <span className="dim">{zone}</span></div>
          <div className="table-scroll">
            <table className="data" style={{ width: '100%', fontSize: 12.5 }}>
              <thead><tr><th>{t('tr.kind')}</th><th>{t('tr.when')}</th><th>{t('tr.venue')}</th><th>{t('tr.attendance')}</th><th>{t('tr.evidence')}</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} data-session-id={s.id}>
                    <td>{kindLabel(s.kind)}</td>
                    <td>{fmtRange(s, zone)}</td>
                    <td>{s.venue ? `${s.venue.name}${s.venue.town ? `, ${s.venue.town}` : ''}` : '—'}{s.venue?.address ? <div className="dim">{s.venue.address}</div> : null}{s.instructions ? <div className="dim">{s.instructions}</div> : null}</td>
                    <td><span className={`pill ${attTone(s.attendance.state)}`}>{attLabel(s.attendance.state)}</span></td>
                    <td>{s.evidence?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canWrite && tr.workflowState === 'scheduled' && (
        <details className="room-details" style={{ marginTop: 8 }}>
          <summary>{t('tr.recordAttendance')}</summary>
          <div className="dim" style={{ fontSize: 12.5, margin: '4px 0' }}>{t('tr.attendanceNote')}</div>
          {sessions.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }} aria-label={`${t('tr.attendance')} ${fmtRange(s, zone)}`}>
              <span style={{ fontSize: 12.5, minWidth: 160 }}>{kindLabel(s.kind)} · {fmtIn(s.startsAt, zone)}</span>
              <select aria-label={`${t('tr.attendance')} ${s.id}`} value={attState[s.id] ?? 'attended'} disabled={busy || s.startsAt > now} onChange={(e) => setAttState((a) => ({ ...a, [s.id]: e.target.value as TrialAttendanceState }))}>
                {list.vocabulary.attendanceStates.map((st) => <option key={st} value={st}>{attLabel(st)}</option>)}
              </select>
              <input style={{ flex: '1 1 140px' }} aria-label={`${t('tr.attendanceNoteLabel')} ${s.id}`} placeholder={t('tr.attendanceNoteLabel')} maxLength={list.limits.note} value={attNote[s.id] ?? ''} disabled={busy || s.startsAt > now} onChange={(e) => setAttNote((n) => ({ ...n, [s.id]: e.target.value }))} />
              <button disabled={busy || s.startsAt > now} onClick={() => recordAttendance(s)} title={s.startsAt > now ? t('tr.notStarted') : undefined}>{s.startsAt > now ? t('tr.notStarted') : t('tr.record')}</button>
            </div>
          ))}
        </details>
      )}

      {canWrite && open && (
        <details className="room-details" style={{ marginTop: 8 }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !reschedule) { setReschedule(sessions.length ? draftsOf(sessions, tr.schedule?.timezone ?? rescheduleZone) : [blankSession({ name: tr.venue ?? '', town: '', address: '' })]); setRescheduleZone(tr.schedule?.timezone ?? browserZone()); } }}>
          <summary>{tr.schedule && !tr.schedule.legacy ? t('tr.reschedule') : t('tr.propose')}</summary>
          <div className="dim" style={{ fontSize: 12.5, margin: '4px 0' }}>{t('tr.rescheduleNote')}</div>
          <label style={{ fontSize: 12.5 }}>{t('tr.timezone')}<br />
            <select aria-label={`${t('tr.timezone')} ${tr.id}`} value={rescheduleZone} disabled={busy} onChange={(e) => setRescheduleZone(e.target.value)}>
              {[...new Set([rescheduleZone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
          {reschedule && <div style={{ marginTop: 6 }}><SessionEditor drafts={reschedule} setDrafts={setReschedule} max={list.limits.sessions} kinds={list.vocabulary.sessionKinds} disabled={busy} allowRemove /></div>}
          <input style={{ width: '100%', marginTop: 6 }} aria-label={`${t('tr.rescheduleReason')} ${tr.id}`} placeholder={t('tr.rescheduleReason')} maxLength={list.limits.reason} value={rescheduleReason} disabled={busy} onChange={(e) => setRescheduleReason(e.target.value)} />
          <button className="primary" style={{ marginTop: 8 }} disabled={busy || !reschedule || reschedule.some((d) => !d.start || !d.end || !d.venueName.trim())} onClick={submitReschedule}>{t('tr.submitSchedule')}</button>
        </details>
      )}

      {(tr.workflowState === 'scheduled' || tr.workflowState === 'completed') && (
        <details className="room-details" style={{ marginTop: 8 }}>
          <summary>{t('tr.evidence')} ({tr.evidenceCount})</summary>
          <div className="dim" style={{ fontSize: 12.5, margin: '4px 0' }}>{t('tr.evidenceNote')}</div>
          {(detail?.evidence ?? []).filter((e) => !e.removedAt).map((ev) => (
            <div key={ev.id} style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }} aria-label={`${t('tr.evidenceItem')} ${ev.id}`}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="pill blue">{t('tr.boxCam')}</span>
                <span style={{ fontSize: 12.5 }}>{ev.session ? `${ev.session.drillId ?? ev.session.protocolId ?? ev.session.id}${ev.session.capturedAt ? ` · ${fmtDateTime(ev.session.capturedAt)}` : ''}` : t('tr.sessionUnavailable')}</span>
                {ev.session?.simulated && <span className="pill">{t('tr.simulated')}</span>}
                <span className={`pill ${ev.observation.state === 'accepted' ? 'green' : ev.observation.state === 'evidence_withdrawn' || ev.observation.state === 'unavailable' ? 'red' : 'gold'}`}>{t(`tr.obs.${ev.observation.state}`, ev.observation.state.replace(/_/g, ' '))}</span>
                {canWrite && <button disabled={busy} onClick={() => unlink(ev)}>{t('tr.unlink')}</button>}
              </div>
              <div className="dim" style={{ fontSize: 12 }}>{ev.observation.copy}{ev.observation.qualityState ? ` · ${t('tr.quality')}: ${ev.observation.qualityState}` : ''}</div>
              <div className="dim" style={{ fontSize: 11.5 }}>{t('tr.provenanceLine')} · {t('tr.combineVerifiedNo')}</div>
            </div>
          ))}
          {(detail?.evidence ?? []).filter((e) => !e.removedAt).length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('tr.noEvidence')}</div>}
          {canWrite && candidates && (
            <div style={{ marginTop: 8 }}>
              {!candidates.consent && <div className="notice block" role="status">{t(`tr.err.${candidates.reason ?? 'EVIDENCE_CONSENT_REQUIRED'}`, t('tr.err.EVIDENCE_CONSENT_REQUIRED'))}</div>}
              {candidates.consent && candidates.items.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('tr.noCandidates')}</div>}
              {candidates.consent && candidates.items.length > 0 && sessions.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: 12.5, minWidth: 160 }}>{kindLabel(s.kind)} · {fmtIn(s.startsAt, zone)}</span>
                  <select aria-label={`${t('tr.linkTo')} ${s.id}`} value={linkChoice[s.id] ?? ''} disabled={busy} onChange={(e) => setLinkChoice((c) => ({ ...c, [s.id]: e.target.value }))}>
                    <option value="">{t('tr.pickSession')}</option>
                    {candidates.items.map((c) => <option key={c.id} value={c.id}>{c.drillId ?? c.protocolId ?? c.id}{c.capturedAt ? ` · ${fmtDateTime(c.capturedAt)}` : ''}{c.linked ? ` · ${t('tr.alreadyLinked')}` : ''}</option>)}
                  </select>
                  <button disabled={busy || !linkChoice[s.id]} onClick={() => link(s)}>{t('tr.link')}</button>
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      <details className="room-details" style={{ marginTop: 8 }}>
        <summary>{t('tr.assessments')} ({detail?.assessments.length ?? 0})</summary>
        <div className="dim" style={{ fontSize: 12.5, margin: '4px 0' }}>{t('tr.assessmentsNote')}</div>
        {(detail?.assessments ?? []).map((a) => (
          <div key={a.id} style={{ fontSize: 12.5 }}>{a.scoutName} · <span className="pill">{a.state}</span>{a.published ? ` · ${t('tr.feedbackPublished')}` : ''}{a.submittedAt ? ` · ${fmtDateTime(a.submittedAt)}` : ''}</div>
        ))}
        {list.canAssess && !tr.subjectRemovedAt && !list.blocked && <button style={{ marginTop: 6 }} disabled={busy} onClick={openAssessment}>{t('tr.openAssessment')}</button>}
      </details>

      {canWrite && open && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <button className="primary" disabled={busy || completeBlockers.length > 0} title={completeBlockers.length ? completeBlockers.map((r) => t(`tr.reason.${r}`, r)).join(' · ') : undefined} onClick={complete}>{t('tr.complete')}</button>
          {completeBlockers.length > 0 && <span className="dim" style={{ fontSize: 12 }}>{completeBlockers.map((r) => t(`tr.reason.${r}`, r)).join(' · ')}</span>}
        </div>
      )}
      {(canWrite || (list.blocked && list.canWrite)) && open && !tr.subjectRemovedAt && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input style={{ flex: '1 1 200px' }} aria-label={`${t('tr.cancelReason')} ${tr.id}`} placeholder={t('tr.cancelReason')} maxLength={list.limits.reason} value={cancelReason} disabled={busy} onChange={(e) => setCancelReason(e.target.value)} />
          <button disabled={busy || !cancelReason.trim()} onClick={cancel}>{t('tr.cancel')}</button>
          {list.blocked && <span className="dim" style={{ fontSize: 12 }}>{t('tr.blockedCancelOnly')}</span>}
        </div>
      )}

      <details className="room-details" style={{ marginTop: 8 }}>
        <summary>{t('tr.history')} ({tr.history.length})</summary>
        {tr.history.slice().reverse().map((h) => (
          <div key={h.id} className="dim" style={{ fontSize: 12 }}>{fmtDateTime(h.at)} · {t(`tr.action.${h.action}`, h.action.replace(/_/g, ' '))}{h.by?.name ? ` · ${h.by.name}` : h.by?.kind ? ` · ${t(`tr.actor.${h.by.kind}`, h.by.kind)}` : ''}</div>
        ))}
      </details>
    </div>
  );
}
