import { GuidanceNote } from './InformationRows';
// M24F.2 — the Clubs page in four categories: Current, Requests, Development,
// History. Each category composes the sections the page already had (the same
// clients, the same rules) so nothing is lost — it is grouped. Development is
// recomposed: a club's latest feedback, the current objective and the
// progress count up front, the full text and the actions behind "View
// details". Supporting copy is exceptional here, not default.
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon } from './Icon';
import { RecordIdentity } from './RecordDetails';
import { Text, TextInput } from './Text';
import { useRouter } from 'expo-router';
import { m12, type FeedbackItem, type ObjectiveRec } from '../data/m12client';
import { m15 } from '../data/m15client';
import type { InboxRequest } from '../domain/types';
import { useColors, type Palette } from '../theme';
import { pt } from '../i18n';
import { TimelineItem, RecordPanel, DetailFact, InfoNote, Button, Disclosure, FactRow, ListRow, Muted, Row, SectionTitle } from './ui';
import { AckSection, ExposureSection, RepresentationSection, TransitionsSection } from './M13Sections';
import { ReferencesSection } from './M14Sections';
import { AgentSharedOpportunities, MyAgentSection } from './MyAgentSection';
import { AgentConsentSection } from './AgentConsentSection';
import { AgentTransactionSection } from './AgentTransactionSection';
import { humanDate, uiLocale } from '../time';

type Actor = { kind: 'player'; id: string };
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    // the error is cleared with the result, never synchronously inside the effect
    fn().then((x) => { if (ok) { setV(x); setErr(null); } }).catch((e) => ok && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}
const inputStyle = (colors: Palette) => ({
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const);
const day = (ts: number) => new Date(ts).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
const firstSentence = (s: string) => (s.split(/(?<=[.!?])\s/)[0] ?? s).trim();

// ------------------------------------------------------------- Current
export function ClubsCurrent({ actor, isMinor, mediaOptions }: { actor: Actor; isMinor: boolean; mediaOptions: { id: string; title: string }[] }) {
  const [passport] = useLoad(() => m15.passport(actor), [actor.id]);
  const club = passport?.status.currentClub ?? null;
  return (
    <View testID="clubs-current" style={{ gap: 26 }}>
      <View>
        <SectionTitle>{pt('clubsCurrentClub')}</SectionTitle>
        {club
          ? <FactRow k={club.orgName ?? pt('clubsCurrentClub')} sub={club.since ? `${pt('m15since')} ${humanDate(club.since)}` : undefined} v={pt('clubsActive')} />
          : <Muted size={13.5}>{pt('clubsNoClub')}</Muted>}
      </View>
      <MyAgentSection playerId={actor.id} isMinor={isMinor} />
      <RepresentationSection playerId={actor.id} isMinor={isMinor} />
      <TransitionsSection actor={actor} isMinor={isMinor} mediaOptions={mediaOptions} />
      <ExposureSection playerId={actor.id} />
    </View>
  );
}

// ------------------------------------------------------------- Requests
export function ClubsRequests({ actor, isMinor, requests }: { actor: Actor; isMinor: boolean; requests: InboxRequest[] }) {
  const router = useRouter();
  const colors = useColors();
  const pending = requests.filter((r) => r.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
  return (
    <View testID="clubs-requests" style={{ gap: 26 }}>
      <View>
        <SectionTitle>{pt('clubsOpenRequests')}</SectionTitle>
        {pending.length === 0 ? <Muted size={13.5}>{pt('clubsNoRequests')}</Muted> : pending.map((r) => (
          <Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.orgName}. ${r.type === 'trial' ? pt('clubsTrialInvitation') : pt('clubsContactRequest')}`} onPress={() => router.push('/inbox')} testID={`clubs-request-${r.id}`} style={({ pressed }) => ({ paddingVertical: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.line, opacity: pressed ? 0.7 : 1 })}>
            <RecordIdentity name={r.orgName} subtitle={r.type === 'trial' ? pt('clubsTrialInvitation') : pt('clubsContactRequest')} icon={r.type === 'trial' ? 'calendar-days' : 'chat-bubble'} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 53 }}><Muted size={11.5}>{day(r.createdAt)}</Muted><Icon name="arrow-right" size={18} color={colors.accentText} /></View>
          </Pressable>
        ))}
      </View>
      <AgentConsentSection playerId={actor.id} isMinor={isMinor} />
      <AgentSharedOpportunities playerId={actor.id} isMinor={isMinor} />
      <AckSection actor={actor} />
    </View>
  );
}

// ---------------------------------------------------------- Development
export function ClubsDevelopment({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [fb] = useLoad<{ guardianManaged?: boolean; count?: number; items: FeedbackItem[] }>(() => m12.getFeedback(actor.id), [actor.id]);
  const [objectives, reload] = useLoad<ObjectiveRec[]>(() => m12.getObjectives(actor.id), [actor.id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState<Record<string, string>>({});
  if (fb?.guardianManaged) {
    return (
      <View testID="clubs-development">
        <SectionTitle>{pt('clubsDevelopment')}</SectionTitle>
        <Muted size={13.5}>{pt('clubsGuardianFeedback').replace('{n}', String(fb.count ?? 0))}</Muted>
      </View>
    );
  }
  const items = fb?.items ?? [];
  const objs = objectives ?? [];
  const orgs = [...new Set([...items.map((f) => f.orgName), ...objs.map((o) => o.reviewer.orgName ?? o.orgId)])];
  if (orgs.length === 0) {
    return (
      <View testID="clubs-development">
        <SectionTitle>{pt('clubsDevelopment')}</SectionTitle>
        <Muted size={13.5}>{pt('clubsNoFeedback')}</Muted>
      </View>
    );
  }
  return (
    <View testID="clubs-development" style={{ gap: 30 }}>
      {orgs.map((org) => {
        const feedback = items.filter((f) => f.orgName === org).sort((a, b) => b.at - a.at);
        const latest = feedback[0];
        const mine = objs.filter((o) => (o.reviewer.orgName ?? o.orgId) === org);
        const current = mine[0];
        const progress = mine.reduce((n, o) => n + o.progress.length, 0);
        return (
          <View key={org} testID={`clubs-dev-${org.replace(/\s+/g, '-').toLowerCase()}`}>
            <SectionTitle>{org}</SectionTitle>
            {latest ? <FactRow k={pt('clubsLatestFeedback')} v={firstSentence(latest.text)} /> : null}
            {current ? <FactRow k={pt('clubsCurrentObjective')} v={current.objectives[0]?.text ?? '—'} /> : null}
            {mine.length > 0 ? <FactRow k={pt('clubsProgressEntries')} v={String(progress)} /> : null}
            {latest && mine.length === 0 && (
              <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                <Button small label={pt('makeObjective')} onPress={async () => {
                  try {
                    const text = latest.text.split(/[.!]/)[1]?.trim() || 'Work on the published focus area';
                    await m12.createObjective(actor.id, latest.id, [text]);
                    setMsg('Objective agreed from the published feedback.'); reload();
                  } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
                }} />
              </View>
            )}
            <Disclosure label={pt('clubsViewDetails')} testID={`clubs-dev-details-${org.replace(/\s+/g, '-').toLowerCase()}`}>
              {feedback.map((f) => (
                <RecordPanel key={f.id} title={f.byName} subtitle={day(f.at)} icon="message-circle"><Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 20 }}>{f.text}</Text></RecordPanel>
              ))}
              {mine.map((o) => (
                <RecordPanel key={o.id} testID={`objective-${o.id}`}>
                  {o.objectives.map((x) => <Text key={x.id} style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>{x.text}</Text>)}
                  <GuidanceNote size={12}>{o.reviewer.name}{o.reviewer.orgName ? ` · ${o.reviewer.orgName}` : ''} · {o.progress.length} {pt('clubsProgressEntries').toLowerCase()}{o.sharing.orgIds.length ? ` · ${pt('clubsSharedWithClub')}` : ''}</GuidanceNote>
                  {o.reassessments.map((r) => (
                    <InfoNote key={r.id}>{pt('reassess')}: {r.status}{r.outcome ? ` — ${r.outcome.note}` : ''}</InfoNote>
                  ))}
                  <Row style={{ flexWrap: 'wrap' }}>
                    <TextInput style={[inputStyle(colors), { flex: 1, minWidth: 140 }]} placeholder={pt('logProgress')} placeholderTextColor={colors.muted}
                      accessibilityLabel={pt('logProgress')} value={progressNote[o.id] ?? ''} onChangeText={(v) => setProgressNote((s) => ({ ...s, [o.id]: v }))} />
                    <Button small primary label={pt('logProgress')} onPress={async () => {
                      const note = (progressNote[o.id] ?? '').trim(); if (!note) return;
                      await m12.addObjectiveProgress(actor.id, o.id, note);
                      setProgressNote((s) => ({ ...s, [o.id]: '' })); setMsg('Progress logged.'); reload();
                    }} />
                  </Row>
                  <Row style={{ flexWrap: 'wrap' }}>
                    {!o.reassessments.some((r) => r.status === 'requested') && (
                      <Button small label={pt('reassess')} onPress={async () => {
                        try { await m12.requestReassessment(actor.id, o.id); setMsg('Reassessment requested — the reviewer will answer with evidence.'); reload(); }
                        catch (e) { setMsg(e instanceof Error ? e.message : 'Share with the club first.'); }
                      }} />
                    )}
                    <Button small tertiary danger={o.sharing.orgIds.length > 0} label={o.sharing.orgIds.length ? pt('unshare') : pt('share')} onPress={async () => {
                      const enabled = o.sharing.orgIds.length === 0;
                      try { await m12.shareObjective(actor.id, o.id, o.orgId, enabled); setMsg(enabled ? 'Progress now visible to the club — reversible any time.' : 'Sharing stopped — the club no longer sees this.'); reload(); }
                      catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
                    }} />
                  </Row>
                </RecordPanel>
              ))}
            </Disclosure>
          </View>
        );
      })}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12.5}>{msg}</Muted></View>}
    </View>
  );
}

// -------------------------------------------------------------- History
export function ClubsHistory({ actor, isMinor, requests }: { actor: Actor; isMinor: boolean; requests: InboxRequest[] }) {
  const colors = useColors();
  const [objectives] = useLoad<ObjectiveRec[]>(() => m12.getObjectives(actor.id), [actor.id]);
  const answered = requests.filter((r) => r.status !== 'pending').map((r) => ({
    at: r.respondedAt ?? r.createdAt,
    label: r.orgName,
    sub: `${r.type === 'trial' ? pt('clubsTrialInvitation') : pt('clubsContactRequest')} · ${r.status === 'accepted' ? pt('clubsAccepted') : r.status === 'declined' ? pt('clubsDeclined') : r.status}`,
  }));
  const outcomes = (objectives ?? []).flatMap((o) => o.reassessments.filter((r) => r.status !== 'requested').map((r) => ({ at: 0, label: o.reviewer.orgName ?? o.orgId, sub: `${pt('reassess')} ${r.status}${r.outcome ? ` — ${r.outcome.note}` : ''}` })));
  const rows = [...answered, ...outcomes].sort((a, b) => b.at - a.at);
  return (
    <View testID="clubs-history" style={{ gap: 26 }}>
      <View>
        <SectionTitle>{pt('clubsHistory')}</SectionTitle>
        {rows.length === 0 ? <Muted size={13.5}>{pt('clubsNoHistory')}</Muted> : rows.map((r, i) => (
          <TimelineItem key={`${r.label}-${i}`} date={r.at ? day(r.at) : ''} last={i === rows.length - 1}><Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 21 }}>{r.label}</Text><Text style={{ color: colors.muted, fontSize: 12.5, lineHeight: 20 }}>{r.sub}</Text></TimelineItem>
        ))}
      </View>
      <ReferencesSection playerId={actor.id} />
      <AgentTransactionSection playerId={actor.id} isMinor={isMinor} />
    </View>
  );
}
