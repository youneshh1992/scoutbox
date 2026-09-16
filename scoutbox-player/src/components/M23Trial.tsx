// M23 P4B — the family's Trial workflow: what has been agreed, session by
// session. The player or guardian confirms or declines a proposed schedule
// and may cancel; nothing here is a judgement. A minor's own device shows the
// guardian-managed outcome line only.
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { m12, isOutcomeLine, type FamilyTrial, type FamilyTrialWorkflow } from '../data/m12client';
import { colors } from '../theme';
import { pt } from '../i18n';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';

type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

const tone = (s: string) => (s === 'scheduled' ? 'blue' : s === 'completed' ? 'green' : s === 'cancelled' ? 'red' : 'gold');
const stateLabel = (s: string) => {
  const key = `trialWfState_${s}` as Parameters<typeof pt>[0];
  try { return pt(key) ?? s; } catch { return s; }
};
const attLabel = (s: string) => {
  const key = `trialWfAttendance_${s}` as Parameters<typeof pt>[0];
  try { return pt(key) ?? s; } catch { return s; }
};
const fmtIn = (ms: number, zone: string | null) => {
  try { return new Date(ms).toLocaleString(undefined, { timeZone: zone ?? undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return new Date(ms).toLocaleString(); }
};
const fmtEnd = (ms: number, zone: string | null) => {
  try { return new Date(ms).toLocaleTimeString(undefined, { timeZone: zone ?? undefined, hour: '2-digit', minute: '2-digit' }); } catch { return new Date(ms).toLocaleTimeString(); }
};

export function TrialWorkflowSection({ actor }: { actor: Actor }) {
  const [trials, setTrials] = useState<FamilyTrial[] | null>(null);
  const [tick, setTick] = useState(0);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    (actor.kind === 'player' ? m12.getTrials(actor.id) : m12.gTrials(actor.id)).then((x) => on && setTrials(x)).catch(() => on && setTrials([]));
    return () => { on = false; };
  }, [actor.id, actor.kind, tick]);
  if (!trials) return null;
  const withWorkflow = trials.filter((t) => t.workflow);
  if (withWorkflow.length === 0) return null;

  const act = async (t: FamilyTrial, what: 'confirm' | 'decline' | 'cancel') => {
    if (busy) return;
    setBusy(t.id); setMsg(null);
    try {
      const r = reason[t.id]?.trim() || undefined;
      if (actor.kind === 'player') {
        if (what === 'confirm') await m12.confirmTrialSchedule(actor.id, t.id);
        else if (what === 'decline') await m12.declineTrialSchedule(actor.id, t.id, r);
        else await m12.cancelTrial(actor.id, t.id, r);
      } else if (what === 'confirm') await m12.gConfirmTrialSchedule(actor.id, t.id);
      else if (what === 'decline') await m12.gDeclineTrialSchedule(actor.id, t.id, r);
      else await m12.gCancelTrial(actor.id, t.id, r);
      setMsg(what === 'confirm' ? pt('trialWfConfirmed') : what === 'decline' ? pt('trialWfDeclined') : pt('trialWfCancelled'));
      setReason((s) => ({ ...s, [t.id]: '' }));
      setTick((x) => x + 1);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(null); }
  };

  return (
    <Card testID="trial-workflow">
      <SectionTitle>📅 {pt('trialWf')}</SectionTitle>
      <Muted size={12.5}>{pt('trialWfHint')}</Muted>
      {withWorkflow.map((t) => {
        const w = t.workflow!;
        if (isOutcomeLine(w)) {
          return (
            <View key={t.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }} testID={`trial-wf-${t.id}`}>
              <Row><Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5, flex: 1 }}>{w.orgName ?? t.orgName}</Text><Pill label={stateLabel(w.workflowState)} tone={tone(w.workflowState)} /></Row>
              <Muted size={12}>{pt('trialWfOutcomeOnly')}</Muted>
            </View>
          );
        }
        const wf = w as FamilyTrialWorkflow;
        const zone = wf.schedule?.timezone ?? null;
        const open = wf.workflowState === 'accepted' || wf.workflowState === 'scheduled' || wf.workflowState === 'legacy_accepted';
        return (
          <View key={t.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }} testID={`trial-wf-${t.id}`} accessibilityLabel={`${pt('trialWf')} ${wf.orgName ?? t.orgName}`}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5, flex: 1 }}>{wf.orgName ?? t.orgName}{actor.kind === 'guardian' ? ` · ${t.playerName}` : ''}</Text>
              <Pill label={stateLabel(wf.workflowState)} tone={tone(wf.workflowState)} />
            </Row>
            {wf.schedule && !wf.schedule.legacy && (
              <View style={{ marginTop: 4 }}>
                <Muted size={12}>{pt('trialWfSessions')} · {pt('trialWfRevision')} {wf.schedule.revision}{zone ? ` · ${zone}` : ''}</Muted>
                {wf.schedule.sessions.map((s) => (
                  <View key={s.id} style={{ marginTop: 4, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
                    <Text style={{ color: colors.text, fontSize: 13 }}>{fmtIn(s.startsAt, zone)} – {fmtEnd(s.endsAt, zone)} · {s.kind.replace(/_/g, ' ')}</Text>
                    {s.venue && <Muted size={12}>📍 {s.venue.name}{s.venue.town ? `, ${s.venue.town}` : ''}</Muted>}
                    {s.venue?.address ? <Muted size={12}>{pt('trialWfAddress')}: {s.venue.address}</Muted> : null}
                    {s.instructions ? <Muted size={12}>{pt('trialWfInstructions')}: {s.instructions}</Muted> : null}
                    {s.attendance.state !== 'not_recorded' && <Muted size={12}>{attLabel(s.attendance.state)}</Muted>}
                  </View>
                ))}
              </View>
            )}
            {wf.schedule?.legacy && <Muted size={12}>{wf.proposedDate ?? ''}{wf.venue ? ` · ${wf.venue}` : ''}</Muted>}
            {wf.completion?.state === 'completed' && <Muted size={12}>{pt('trialWfCompleted')}</Muted>}
            {wf.completion?.state === 'cancelled' && <Muted size={12}>{pt('trialWfCancelledBy')}{wf.completion.reason ? ` — ${wf.completion.reason}` : ''}</Muted>}
            {open && wf.awaitingYourConfirmation && (
              <View style={{ marginTop: 6 }} testID={`trial-wf-awaiting-${t.id}`}>
                <Text style={{ color: colors.gold, fontSize: 13, fontWeight: '700' }}>{pt('trialWfAwaiting')}</Text>
                <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <Button small primary label={pt('trialWfConfirm')} onPress={() => act(t, 'confirm')} />
                  <Button small label={pt('trialWfDeclineSchedule')} onPress={() => act(t, 'decline')} />
                </Row>
              </View>
            )}
            {open && (
              <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <TextInput
                  style={{ flex: 1, minWidth: 140, backgroundColor: colors.panel2, color: colors.text, borderRadius: 8, padding: 8, fontSize: 13 }}
                  placeholder={pt('trialWfReason')} placeholderTextColor={colors.muted} accessibilityLabel={pt('trialWfReason')}
                  value={reason[t.id] ?? ''} onChangeText={(v) => setReason((s) => ({ ...s, [t.id]: v.slice(0, 300) }))} maxLength={300}
                />
                <Button small danger label={pt('trialWfCancel')} onPress={() => act(t, 'cancel')} />
              </Row>
            )}
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite" style={{ marginTop: 6 }}><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

/** The slot chips of a P4B invitation: day + times in the organiser zone + venue. Picking one is choosing the DAY the server accepts. */
export function TrialSlotChips({ slots, chosenDay, onPick }: { slots: { id: string; day: string; kind: string | null; startsAt: number; endsAt: number; timezone: string; venue: { name: string; town: string | null } | null }[]; chosenDay: string; onPick: (day: string) => void }) {
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {slots.map((sl) => {
        const active = chosenDay === sl.day;
        return (
          <View key={sl.id} style={{ borderRadius: 10, borderWidth: 1, borderColor: active ? colors.accent : colors.line, padding: 8, backgroundColor: active ? colors.panel2 : 'transparent' }}>
            <Text
              accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${sl.day} ${fmtIn(sl.startsAt, sl.timezone)}`}
              onPress={() => onPick(sl.day)} style={{ color: colors.text, fontSize: 13, fontWeight: active ? '700' : '400' }}
              testID={`trial-slot-${sl.id}`}
            >
              {active ? '● ' : '○ '}{fmtIn(sl.startsAt, sl.timezone)} – {fmtEnd(sl.endsAt, sl.timezone)} <Text style={{ color: colors.muted }}>({sl.timezone}){sl.kind ? ` · ${sl.kind.replace(/_/g, ' ')}` : ''}</Text>
            </Text>
            {sl.venue && <Muted size={12}>📍 {sl.venue.name}{sl.venue.town ? `, ${sl.venue.town}` : ''}</Muted>}
          </View>
        );
      })}
    </View>
  );
}
