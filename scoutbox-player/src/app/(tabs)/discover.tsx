import { PlayerMeta, AvailabilityBadge, PlayerName } from '../../components/PlayerIdentity';
// Home — M24F.4 hard reset. The player, one thing to do, recent events on demand,
// one content section, then everything else one tap away. No greeting, no
// date, no sentence about who can see you: the identity header is the name,
// the football line, the availability word and the month the account was
// opened. Every value is read from the session and the same client calls as
// before; nothing is fabricated, and nothing the old Home said is lost — the
// weekly figures and the scouting stream moved to the Activity page.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { PlayerScreen as SafeAreaView } from '../../components/Vivid';
import { client, type Insights, type PlayerFeedItem } from '../../data/client';
import type { Channel, DirectoryClub, Opportunities } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { GuidanceNote, StatusRow, PolicyList } from '../../components/InformationRows';
import { MetricTiles, RecordPanel, Pill, Row, DetailLink, Disclosure, ListRow, Muted, TimelineItem } from '../../components/ui';
import { Gradient, PitchArt } from '../../components/Vivid';
import { SeasonChart } from '../../components/SeasonChart';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageChrome';
import { useRouter } from 'expo-router';
import { initialsOf, SectionHead } from '../../components/Reference';
import { fmtMonthYear, humanDate, relTime } from '../../time';

export const EVENT_LABELS: Record<string, string> = {
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

  const availKey = me ? (`avail_${me.availability}` as Parameters<typeof pt>[0]) : null;
  const footballLine = [me?.position ?? pt('fbNoPosition'), me?.city].filter(Boolean).join(' · ');
  // The month the account was opened. Only when the record carries it — never invented.
  const joined = me && typeof me.createdAt === 'number' && me.createdAt > 0 ? fmtMonthYear(me.createdAt) : null;
  const unreadIn = (c: Channel) => c.messages.filter((m) => m.sender.kind === 'org_user' && m.ts > (c.readBy?.counterparty ?? 0)).length;

  // ONE thing to do now: a pending request or invitation, an unread reply, else nothing.
  const pending = inbox.filter((r) => r.status === 'pending');
  const unread = channels.filter((c) => unreadIn(c) > 0);
  const next = pending[0]
    ? { club: pending[0].orgName, title: 'guardianManaged' in pending[0] && pending[0].guardianManaged ? pt('homeWithGuardian') : pending[0].type === 'trial' ? pt('homeTrialInvite') : pt('homeContactRequest'), cta: pt('homeView'), onPress: () => router.push('/inbox') }
    : unread[0]
      ? { club: unread[0].orgName, title: pt('homeReplied').replace('{name}', unread[0].scoutName), cta: pt('homeView'), onPress: () => router.push('/inbox') }
      : null;
  const waiting = pending.length + unread.length;

  // Three recent events — the scouting stream, newest first.
  const recent = (insights?.recent ?? []).slice(0, 3);
  const openTrials = opportunities?.clubs.flatMap((c) => c.openTrials.map((t) => ({ ...t, club: c.name }))) ?? [];
  const weekly = feed.find((i): i is Extract<PlayerFeedItem, { type: 'weekly_report' }> => i.type === 'weekly_report');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <PageHeader title={pt('tabHome')} wordmark />

        {/* Identity — the player is the subject of the page, not a record on it. */}
        {me && (
          <View style={styles.identity} testID="home-identity">
            <View style={styles.identityTop}>
              <View style={{ flex: 1 }}><PlayerMeta position={me.position ?? pt('fbNoPosition')} location={me.city} /></View>
              <View style={styles.avatar} accessibilityLabel={me.name}><Text style={styles.avatarText}>{initialsOf(me.name)}</Text></View>
            </View>
            <PlayerName name={me.name} verified={me.identityVerified} style={styles.name} />
            <View style={styles.identityMeta}>
              {availKey ? <AvailabilityBadge label={pt(availKey)} testID="home-availability" /> : null}
              {joined ? <Text style={styles.joined} testID="home-joined">{pt('homeJoined').replace('{when}', joined)}</Text> : null}
            </View>
          </View>
        )}

        {/* The one thing to do now. */}
        <View style={styles.primary} testID="home-primary">
          <Gradient opacity={0.49} />
          <View pointerEvents="none" accessible={false} aria-hidden style={styles.pitchArt}>
            <PitchArt color={colors.gradientInk} />
          </View>
          <View style={styles.primaryTop}>
            <Text style={styles.primaryKicker}>{pt('homeNext')}</Text>
          </View>
          {next ? (
            <>
              <Text style={styles.primaryTitle}>{next.club}</Text>
              <Text style={styles.primarySub}>{next.title}{waiting > 1 ? ` · ${waiting - 1} more` : ''}</Text>
            </>
          ) : (
            <Text style={styles.primaryTitle}>{pt('homeNothingNext')}</Text>
          )}
          <Pressable accessibilityRole="button" accessibilityLabel={next ? next.cta : pt('homeExploreClubs')} onPress={next ? next.onPress : () => router.push('/opportunities')} testID="home-primary-cta" style={({ pressed }) => [styles.primaryAction, pressed && { opacity: 0.75 }]}>
            <Gradient opacity={0.8} control /><Text style={styles.primaryActionText}>{next ? next.cta : pt('homeExploreClubs')}</Text>
            <Icon name="arrow-right" size={20} color={colors.gradientInk} />
          </Pressable>
        </View>

        {me?.stats && me.position !== 'GK' ? <SeasonChart current={me.stats} history={me.seasonHistory ?? []} compact /> : null}

        {/* Recent stays one tap away so the journey is visible sooner on mobile. */}
        <View style={{ marginTop: 18 }}>
          <Disclosure label={pt('homeRecent')} testID="home-activity">
            {recent.length === 0 ? <GuidanceNote size={13}>{pt('homeNoActivity')}</GuidanceNote> : (
              <View style={{ marginTop: 4 }}>
                {recent.map((e, i) => (
                  <TimelineItem key={i} date={relTime(e.ts)} last={i === recent.length - 1} testID="home-recent-row">
                    <Text style={{ fontWeight: '600', color: colors.text }}>{e.orgName}</Text><Text style={{ color: colors.muted }}> {EVENT_LABELS[e.type] ?? e.type}</Text>
                  </TimelineItem>
                ))}
              </View>
            )}
            <DetailLink label={pt('homeViewAllActivity')} onPress={() => router.push('/activity')} testID="home-activity-all" />
          </Disclosure>
        </View>

        {/* What is moving — one or two rows, never a wall. */}
        <SectionHead title="Your journey" testID="home-journey" />
        {openTrials.length > 0 ? openTrials.slice(0, 2).map((t) => (
          <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`${t.club}. ${t.title}. ${humanDate(t.date)}${t.registered ? '. Registered' : ''}`} onPress={() => router.push('/opportunities')} style={({ pressed }) => [styles.fixture, pressed && { opacity: 0.7 }]}>
            <View style={styles.fixtureDate}><Text style={styles.fixtureDateText}>{humanDate(t.date)}</Text></View>
            <View style={styles.fixtureInfo}>
              <Text style={styles.fixtureClub}>{t.club}</Text>
              <Text style={styles.fixtureTitle}>{t.title}{t.registered ? ' · Registered' : ''}</Text>
            </View>
            <Icon name="arrow-up-right" size={19} color={colors.accentText} />
          </Pressable>
        )) : (
          <ListRow label="Nothing in motion yet" onPress={() => router.push('/opportunities')} />
        )}
        {opportunities && opportunities.clubs.length > 0 ? (
          <ListRow label={pt(opportunities.clubs.length === 1 ? 'homeClubsWithinOne' : 'homeClubsWithinMany').replace('{n}', String(opportunities.clubs.length))} onPress={() => router.push('/opportunities')} testID="home-clubs" />
        ) : null}

        {/* Secondary: visibility, the directory and the promises — one tap away each. */}
        <View style={{ marginTop: 26 }}>
          {me && (
            <Disclosure label="Your visibility right now" testID="home-visibility">
              <StatusRow title="Profile visibility" value="Verified clubs" icon="eye" description={isMinor ? 'Visible inside ScoutBox only. Hidden from public browsing, search engines and agencies.' : 'Verified clubs can discover your profile inside ScoutBox.'} />
              {isMinor ? <StatusRow title="Club conversations" value="Guardian managed" icon="users" description="Clubs contact your parent or guardian. You never receive direct club messages." /> : <StatusRow title="Academy+" value={me.academyPlus ? 'On' : 'Off'} positive={me.academyPlus} icon="target" description={me.academyPlus ? 'Included in the boosted fresh-start cohort at the top of club searches.' : 'Turn on Academy+ in Account to join the boosted fresh-start cohort.'} />}
              <StatusRow title="Medical information" value={me.medical.shared ? 'Shared' : 'Private'} positive={!me.medical.shared} icon="medical" description={me.medical.shared ? (isMinor ? 'Your guardian has enabled medical sharing.' : 'Organisations can see your medical records.') : 'No organisation can see your medical records.'} />
              {weekly ? <View style={{ gap: 9 }}><Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>This week</Text><MetricTiles items={[{ label: 'Profile views', value: weekly.report.views, icon: 'eye' }, { label: 'Shortlists', value: weekly.report.shortlists, icon: 'clipboard-list' }]} /></View> : null}
            </Disclosure>
          )}
          <Disclosure label="Club directory" testID="home-directory">
            {directory.length > 0 ? directory.map((d) => (
              <RecordPanel key={d.id} title={d.name} icon="building-2">
                <Row><Pill label={d.verified ? 'Verified' : 'Unverified'} tone={d.verified ? 'green' : 'default'} />{d.trustedPartner && <Pill label="Trusted partner" />}{d.safeguardingCertified && <Pill label="Safeguarding certified" />}{d.pathwayClub && <Pill label="Pathway club" />}</Row>
                <MetricTiles items={[{ label: 'Trials run', value: d.trialsRun, icon: 'calendar-days' }, { label: 'Reports filed', value: d.reportsFiled, icon: 'file-check-2' }]} />
                {d.avgReportDays != null && <StatusRow title="Average report time" value={`${d.avgReportDays} days`} icon="clock" />}
              </RecordPanel>
            )) : ORGS.map((o) => (
              <RecordPanel key={o.name} title={o.name} subtitle={o.type === 'agency' ? 'Agency' : 'Club'} icon="building-2">
                {o.trustedPartner && <Pill label="Trusted partner" />}<GuidanceNote icon="building-2">{o.blurb}</GuidanceNote>
              </RecordPanel>
            ))}
          </Disclosure>
          <Disclosure label="How discovery works" testID="home-promises">
            <PolicyList minor={isMinor} />
          </Disclosure>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  identity: { paddingTop: 20, paddingBottom: 26, gap: 12 },
  identityTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  avatar: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.panel2, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  name: { color: colors.text, fontSize: 38, fontWeight: '700', letterSpacing: -1.7, lineHeight: 42 },
  identityLine: { flex: 1, color: colors.muted, fontSize: 12, fontWeight: '600', lineHeight: 18, letterSpacing: 0.4 },
  identityMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 5, height: 5, backgroundColor: colors.accentText },
  availability: { color: colors.safetyText, fontSize: 12, lineHeight: 18 },
  joined: { color: colors.muted, fontSize: 11, lineHeight: 18 },
  primary: { padding: 20, backgroundColor: colors.panel, borderRadius: 18, overflow: 'hidden', gap: 8 },
  primaryTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  primaryKicker: { color: colors.gradientInk, fontSize: 10, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  primaryTitle: { color: colors.gradientInk, fontSize: 30, fontWeight: '700', letterSpacing: -1, lineHeight: 35 },
  primarySub: { color: colors.gradientInk, fontSize: 13, lineHeight: 20 },
  primaryAction: { overflow: 'hidden', marginTop: 12, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.panel, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  primaryActionText: { color: colors.gradientInk, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  pitchArt: { position: 'absolute', right: 12, top: 12, width: 110, height: 70, opacity: 0.18 },
  fixture: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  fixtureDate: { width: 58, minHeight: 62, backgroundColor: colors.panel2, borderRadius: 8, alignItems: 'center', justifyContent: 'center', padding: 8, borderTopWidth: 3, borderTopColor: colors.accent },
  fixtureDateText: { color: colors.text, fontSize: 17, lineHeight: 22, fontWeight: '700', textAlign: 'center' },
  fixtureInfo: { flex: 1, minWidth: 0, gap: 4 },
  fixtureClub: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  fixtureTitle: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  clubName: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  clubMeta: { color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  dirRow: { paddingVertical: 8, gap: 2 },
});
