// Home — M24F recomposition. Not a dashboard of cards: the player's identity
// first, ONE current action, then what is moving (the journey), the activity
// stream, a development line, and the clubs within reach. Everything the
// previous Home said is still here — the promises, the visibility, the
// weekly figures, the pathway — but ordered by what matters now and kept
// one tap away where it is secondary. Every value is read from the session
// and the same client calls as before; nothing is fabricated.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client, type Insights, type PlayerFeedItem } from '../../data/client';
import type { Channel, DirectoryClub, Opportunities } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { Button, Disclosure, Kicker, ListRow, Muted, SectionTitle } from '../../components/ui';
import { PageHeader } from '../../components/PageChrome';
import { useRouter } from 'expo-router';
import { Icon } from '../../components/Icon';
import { initialsOf, StatusDot, TextButton } from '../../components/Reference';

const NOTICED_LABELS: Record<string, string> = {
  first_touch: 'First touch', pace: 'Pace', positioning: 'Positioning', work_rate: 'Work rate',
  left_foot: 'Left foot', right_foot: 'Right foot', aerial: 'Aerial', composure: 'Composure',
  vision: 'Vision', pressing: 'Pressing', finishing: 'Finishing', distribution: 'Distribution',
};

const EVENT_LABELS: Record<string, string> = {
  view: 'viewed your profile',
  save: 'saved you',
  shortlist: 'shortlisted you',
  contact_request: 'requested contact',
  trial_request: 'requested a trial',
  contact_request_to_guardian: 'contacted your guardian',
  trial_request_to_guardian: 'sent your guardian a trial invite',
};

// Organisations scouting on ScoutBox. Presentation data only — what an org can
// actually do about you is decided by the server, not this list.
const ORGS = [
  { name: 'Eastport FC', type: 'club', plan: 'Pro', trustedPartner: true, blurb: 'Full-time recruitment desk, files trial reports same week.' },
  { name: 'Harbour City FC', type: 'club', plan: 'Academy', trustedPartner: false, blurb: 'Community club scouting the local leagues.' },
  { name: 'North Star Sports Agency', type: 'agency', plan: 'Agency', trustedPartner: false, blurb: 'Licensed agents. Structurally walled off from minors.' },
] as const;

const when = (ts: number) => {
  const d = new Date(ts); const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export default function Discover() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const { me, isMinor, playerId, notifications, refresh, inbox, channels } = useSession();
  const router = useRouter();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [feed, setFeed] = useState<PlayerFeedItem[]>([]);
  const [directory, setDirectory] = useState<DirectoryClub[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunities | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    if (!playerId) return;
    client.getInsights(playerId).then(setInsights).catch(() => {});
    client.getFeed(playerId).then(setFeed).catch(() => {});
    client.getDirectory().then(setDirectory).catch(() => {});
    client.getOpportunities(playerId).then(setOpportunities).catch(() => setOpportunities(null));
  }, [playerId]);

  useEffect(load, [load, notifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    load();
    setRefreshing(false);
  }, [refresh, load]);

  const hour = new Date().getHours();
  const first = (me?.name ?? '').split(/\s+/)[0] || '';
  const greeting = pt(hour < 12 ? 'homeMorning' : hour < 18 ? 'homeAfternoon' : 'homeEvening').replace('{name}', first);
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const availKey = me ? (`avail_${me.availability}` as Parameters<typeof pt>[0]) : null;
  const identityLine = [me?.position ?? pt('fbNoPosition'), me?.city, availKey ? pt(availKey) : null].filter(Boolean).join(' · ');
  const unreadIn = (c: Channel) => c.messages.filter((m) => m.sender.kind === 'org_user' && m.ts > (c.readBy?.counterparty ?? 0)).length;
  const attention: { key: string; icon: string; title: string; sub: string; cta: string }[] = [
    ...inbox.filter((r) => r.status === 'pending').map((r) => ({
      key: r.id,
      icon: r.type === 'trial' ? 'calendar-days' : 'message-circle',
      title: 'guardianManaged' in r && r.guardianManaged ? pt('homeWithGuardian') : r.type === 'trial' ? pt('homeTrialInvite') : pt('homeContactRequest'),
      sub: 'createdAt' in r ? `${r.orgName} · ${new Date(r.createdAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}` : r.orgName,
      cta: r.type === 'trial' ? 'See the invitation' : 'See the request',
    })),
    ...channels.filter((c) => unreadIn(c) > 0).map((c) => ({
      key: c.id,
      icon: 'message-circle',
      title: pt('homeReplied').replace('{name}', c.scoutName),
      sub: `${c.orgName} · ${pt('homeNewMessages').replace('{n}', String(unreadIn(c)))}`,
      cta: 'Open the conversation',
    })),
  ];
  const devFocus = me?.nextActions?.find((a) => a.gain)?.label ?? pt('homeDevDefault');
  const weekly = feed.find((i): i is Extract<PlayerFeedItem, { type: 'weekly_report' }> => i.type === 'weekly_report');
  const noticed = feed.find((i): i is Extract<PlayerFeedItem, { type: 'scouts_noticed' }> => i.type === 'scouts_noticed');
  const openTrials = opportunities?.clubs.flatMap((c) => c.openTrials.map((t) => ({ ...t, club: c.name }))) ?? [];

  // ONE dominant action: a pending request or invitation, else the development focus.
  const primary = attention[0]
    ? { kicker: 'Waiting on you', title: attention[0].title, sub: attention[0].sub, cta: attention[0].cta, onPress: () => router.push('/inbox') }
    : { kicker: 'Your focus', title: devFocus, sub: pt('homeDevHint'), cta: pt('homeStartPractice'), onPress: () => router.push('/football?tab=boxcam') };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <PageHeader title={pt('tabHome')} wordmark />

        {/* Identity — the player is the subject of the page, not a record on it. */}
        {me && (
          <Pressable onPress={() => router.push('/football')} accessibilityRole="button" accessibilityLabel={pt('homeViewPassport')} testID="home-identity" style={({ pressed }) => [styles.identity, pressed && { opacity: 0.8 }]}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{initialsOf(me.name)}</Text></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.kicker} testID="home-greeting">{dateLine} · {greeting}</Text>
              <Text role="heading" aria-level={1} style={styles.name}>{me.name}</Text>
              <Text style={styles.identityLine}>{identityLine}</Text>
              <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <StatusDot label={isMinor ? 'Guardian-managed · verified clubs only' : 'Verified clubs can see you'} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Text style={{ color: colors.accent2, fontSize: 12, fontWeight: '500' }}>{pt('homeViewPassport')}</Text>
                  <Icon name="chevron-right" size={13} color={colors.accent2} />
                </View>
              </View>
            </View>
          </Pressable>
        )}

        {/* The one thing to do now. */}
        <View style={styles.primary} testID="home-primary">
          <Kicker tone="accent">{primary.kicker}</Kicker>
          <Text style={styles.primaryTitle}>{primary.title}</Text>
          <Text style={styles.primarySub}>{primary.sub}</Text>
          <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
            <Button primary label={primary.cta} onPress={primary.onPress} testID="home-primary-cta" />
          </View>
          {attention.length > 1 && (
            <View style={{ marginTop: 8 }}>
              <TextButton label={`${attention.length - 1} more waiting on you`} onPress={() => router.push('/inbox')} />
            </View>
          )}
        </View>

        {/* What is moving: the journey. */}
        <SectionTitle testID="home-journey">Your journey</SectionTitle>
        {openTrials.length > 0 || opportunities?.lookingForYou ? (
          <>
            {openTrials.slice(0, 2).map((t) => (
              <ListRow key={t.id} label={`${t.club} · ${t.title}`} value={`${t.date} · ${t.venue}${t.registered ? ' · Registered' : ''}`} onPress={() => router.push('/opportunities')} />
            ))}
            {opportunities?.lookingForYou ? <ListRow label={`${opportunities.lookingForYou} club${opportunities.lookingForYou === 1 ? ' is' : 's are'} looking for your position`} value="Within 50 km — every one of them can sign you" onPress={() => router.push('/opportunities')} /> : null}
          </>
        ) : (
          <ListRow label="Nothing in motion yet" value="Trials, offers and signings appear here the moment a club moves" onPress={() => router.push('/opportunities')} />
        )}
        {me?.pathway && (
          <ListRow label={`Your pathway · ${me.pathway.steps.find((s) => s.key === me.pathway!.level)?.label ?? me.pathway.level}`} value={me.pathway.nextStep} onPress={() => router.push('/football')} />
        )}

        {/* Activity — a stream, not a wall of boxes. */}
        <SectionTitle testID="home-activity">Activity</SectionTitle>
        {weekly && (
          <Text style={styles.activitySummary}>
            This week: {weekly.report.views} profile view{weekly.report.views === 1 ? '' : 's'}, {weekly.report.shortlists} shortlist{weekly.report.shortlists === 1 ? '' : 's'}
            {weekly.report.topClip ? ` · top clip “${weekly.report.topClip.title}” (${weekly.report.topClip.views} views${weekly.report.topClip.verified ? ', verified' : ''})` : ''}
            {weekly.report.streak > 0 ? ` · ${weekly.report.streak}-day streak` : ''}
            {` · ${Math.min(weekly.report.weeklyGoal.done, weekly.report.weeklyGoal.target)}/${weekly.report.weeklyGoal.target} activities${weekly.report.weeklyGoal.met ? ', goal met' : ''}`}.
          </Text>
        )}
        {insights && insights.recent.length > 0 ? insights.recent.slice(0, 6).map((e, i) => (
          <View key={i} style={styles.activityRow}>
            <Text style={styles.activityWhen}>{when(e.ts)}</Text>
            <Text style={styles.activityText}><Text style={{ fontWeight: '600', color: colors.text }}>{e.orgName}</Text> {EVENT_LABELS[e.type] ?? e.type}</Text>
          </View>
        )) : <Muted size={13}>No scouting activity yet — it shows here the moment it happens.</Muted>}
        {insights && (
          <Text style={styles.activityFoot}>
            {insights.thisMonth.views} view{insights.thisMonth.views === 1 ? '' : 's'} and {insights.thisMonth.shortlists} shortlist{insights.thisMonth.shortlists === 1 ? '' : 's'} this month.
          </Text>
        )}
        {noticed && (
          <Text style={styles.activityFoot}>
            Scouts noticed: {Object.entries(noticed.tags).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${NOTICED_LABELS[t] ?? t} (${n})`).join(', ')}.
          </Text>
        )}

        {/* Development — one line and a way in. */}
        <SectionTitle testID="home-development">Development</SectionTitle>
        <ListRow label={devFocus} value={pt('homeDevHint')} onPress={() => router.push('/football?tab=development')} icon="scan-line" />
        {me?.nextActions && me.nextActions.length > 0 && (
          <Disclosure label="Build your profile strength" hint={`${me.nextActions.length} suggestion${me.nextActions.length === 1 ? '' : 's'}`}>
            {me.nextActions.map((a) => (
              <View key={a.id} style={styles.activityRow}>
                <Text style={[styles.activityWhen, { color: colors.accentText }]}>{a.gain ? `+${a.gain}` : 'Done'}</Text>
                <Text style={styles.activityText}>{a.label}</Text>
              </View>
            ))}
          </Disclosure>
        )}

        {/* Clubs within reach — rows, the primary action only where there is one. */}
        {opportunities && opportunities.clubs.length > 0 && (
          <>
            <SectionTitle testID="home-clubs">Clubs within reach</SectionTitle>
            <Muted size={12.5}>The 50 km rule works both ways: every club below can actually sign you.</Muted>
            {opportunities.clubs.map((c) => (
              <View key={c.id} style={styles.clubRow}>
                <Text style={styles.clubName}>{c.name}</Text>
                <Text style={styles.clubMeta}>
                  {c.distanceKm} km{c.verified ? ' · Verified' : ''}{c.pathwayClub ? ` · Pathway club, ${c.progressed} moved up` : ''}
                  {c.lookingFor.length > 0 ? ` · Looking for ${c.lookingFor.join(', ')}` : ''}
                </Text>
                {c.openTrials.map((t) => (
                  <View key={t.id} style={styles.trialLine}>
                    <Text style={[styles.clubMeta, { flex: 1 }]}>{t.title} · {t.date} · {t.venue}</Text>
                    {t.registered ? (
                      <StatusDot label="Registered" />
                    ) : isMinor ? (
                      <Muted size={12}>Via your guardian</Muted>
                    ) : (
                      <Button small label="Register" onPress={async () => {
                        try { await client.registerOpenTrial(playerId!, t.id); load(); } catch { /* refresh shows truth */ }
                      }} />
                    )}
                  </View>
                ))}
              </View>
            ))}
          </>
        )}

        {/* Secondary: visibility, the directory and the promises — one tap away each. */}
        <SectionTitle testID="home-more">More</SectionTitle>
        {me && (
          <Disclosure label="Your visibility right now" hint={isMinor ? `Verified clubs only · medical data ${me.medical.shared ? 'shared by your guardian' : 'private'}` : `Academy+ ${me.academyPlus ? 'on' : 'off'} · medical data ${me.medical.shared ? 'shared' : 'private'}`} testID="home-visibility">
            {isMinor ? (
              <>
                <Muted size={13}>Only verified clubs inside ScoutBox can see your profile. It is hidden from public browsing, search engines and every agency — and clubs can only talk to your guardian.</Muted>
                <Muted size={13}>Your medical data is {me.medical.shared ? 'shared by your guardian.' : 'private — no organisation can see any of it.'}</Muted>
              </>
            ) : (
              <>
                <Muted size={13}>{me.academyPlus ? 'Academy+ is on: you surface in the boosted fresh-start cohort at the top of club searches.' : 'Academy+ is off. Turn it on in Profile to join the boosted fresh-start cohort.'}</Muted>
                <Muted size={13}>Your medical data is {me.medical.shared ? 'shared — organisations can see your records.' : 'private — no organisation can see any of it.'}</Muted>
              </>
            )}
          </Disclosure>
        )}
        <Disclosure label="Club directory" testID="home-directory">
          {directory.length > 0 ? directory.map((d) => (
            <View key={d.id} style={styles.dirRow}>
              <Text style={styles.clubName}>{d.name}</Text>
              <Text style={styles.clubMeta}>
                {[d.verified ? 'Verified' : 'Unverified', d.trustedPartner ? 'Trusted Partner' : null, d.safeguardingCertified ? 'Safeguarding certified' : null, d.pathwayClub ? 'Pathway club' : null].filter(Boolean).join(' · ')}
              </Text>
              <Text style={styles.clubMeta}>
                {d.trialsRun} trial{d.trialsRun === 1 ? '' : 's'} run · {d.reportsFiled} report{d.reportsFiled === 1 ? '' : 's'} filed{d.avgReportDays != null ? ` · ${d.avgReportDays} day${d.avgReportDays === 1 ? '' : 's'} to file on average` : ''}
              </Text>
            </View>
          )) : ORGS.map((o) => (
            <View key={o.name} style={styles.dirRow}>
              <Text style={styles.clubName}>{o.name}</Text>
              <Text style={styles.clubMeta}>{o.type === 'agency' ? 'Agency' : 'Club'}{o.trustedPartner ? ' · Trusted Partner' : ''} · {o.blurb}</Text>
            </View>
          ))}
        </Disclosure>
        <Disclosure label="How discovery works" hint={isMinor ? 'Our promises to every under-18' : 'Our promises to every player'} testID="home-promises">
          {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => <Muted key={p.slice(0, 20)} size={13}>{p}</Muted>)}
        </Disclosure>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  identity: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, paddingTop: 10, paddingBottom: 22 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  avatarText: { color: colors.accentInk, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  kicker: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  name: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.8, lineHeight: 33, marginTop: 4 },
  identityLine: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 4 },
  primary: { paddingVertical: 20, borderTopWidth: 1, borderTopColor: colors.line, gap: 6 },
  primaryTitle: { color: colors.text, fontSize: 21, fontWeight: '600', letterSpacing: -0.5, lineHeight: 27 },
  primarySub: { color: colors.muted, fontSize: 13.5, lineHeight: 20 },
  activitySummary: { color: colors.text, fontSize: 14, lineHeight: 21, paddingVertical: 6 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.line },
  activityWhen: { width: 68, color: colors.muted, fontSize: 12, lineHeight: 19, flexShrink: 0 },
  activityText: { flex: 1, color: colors.muted, fontSize: 13.5, lineHeight: 19 },
  activityFoot: { color: colors.muted, fontSize: 12.5, lineHeight: 18, paddingTop: 10 },
  clubRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line, gap: 4 },
  clubName: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  clubMeta: { color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  trialLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 6 },
  dirRow: { paddingVertical: 8, gap: 2 },
});
