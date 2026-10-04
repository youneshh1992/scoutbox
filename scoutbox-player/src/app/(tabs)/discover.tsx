// Home — M24F.4 hard reset. The player, one thing to do, three recent events,
// one content section, then everything else one tap away. No greeting, no
// date, no sentence about who can see you: the identity header is the name,
// the football line, the availability word and the month the account was
// opened. Every value is read from the session and the same client calls as
// before; nothing is fabricated, and nothing the old Home said is lost — the
// weekly figures and the scouting stream moved to the Activity page.
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client, type Insights, type PlayerFeedItem } from '../../data/client';
import type { Channel, DirectoryClub, Opportunities } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { Button, DetailLink, Disclosure, Kicker, ListRow, Muted, TimelineItem } from '../../components/ui';
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
            <View style={styles.avatar} accessibilityLabel={me.name}><Text style={styles.avatarText}>{initialsOf(me.name)}</Text></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text role="heading" aria-level={1} style={styles.name}>{me.name}</Text>
              <Text style={styles.identityLine}>{footballLine}</Text>
              {availKey ? <Text style={styles.availability} testID="home-availability">{pt(availKey)}</Text> : null}
              {joined ? <Text style={styles.joined} testID="home-joined">{pt('homeJoined').replace('{when}', joined)}</Text> : null}
            </View>
          </View>
        )}

        {/* The one thing to do now. */}
        <View style={styles.primary} testID="home-primary">
          <Kicker tone="accent">{pt('homeNext')}</Kicker>
          {next ? (
            <>
              <Text style={styles.primaryTitle}>{next.club}</Text>
              <Text style={styles.primarySub}>{next.title}{waiting > 1 ? ` · ${waiting - 1} more` : ''}</Text>
            </>
          ) : (
            // Nothing is waiting: the one action is to look outward.
            <Text style={styles.primarySub}>{pt('homeNothingNext')}</Text>
          )}
          {/* One primary action either way: the waiting request, or Explore clubs. */}
          <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
            <Button primary label={next ? next.cta : pt('homeExploreClubs')} onPress={next ? next.onPress : () => router.push('/opportunities')} testID="home-primary-cta" />
          </View>
        </View>

        {/* Recent — three events, then the page that holds all of them. */}
        <SectionHead title={pt('homeRecent')} testID="home-activity" />
        {recent.length === 0 ? <Muted size={13}>{pt('homeNoActivity')}</Muted> : (
          <View style={{ marginTop: 4 }}>
            {recent.map((e, i) => (
              <TimelineItem key={i} date={relTime(e.ts)} last={i === recent.length - 1} testID="home-recent-row">
                <Text style={{ fontWeight: '600', color: colors.text }}>{e.orgName}</Text><Text style={{ color: colors.muted }}> {EVENT_LABELS[e.type] ?? e.type}</Text>
              </TimelineItem>
            ))}
          </View>
        )}
        <DetailLink label={pt('homeViewAllActivity')} onPress={() => router.push('/activity')} testID="home-activity-all" />

        {/* What is moving — one or two rows, never a wall. */}
        <SectionHead title="Your journey" testID="home-journey" />
        {openTrials.length > 0 ? openTrials.slice(0, 2).map((t) => (
          <ListRow key={t.id} label={`${t.club} · ${t.title}`} value={`${humanDate(t.date)}${t.registered ? ' · Registered' : ''}`} onPress={() => router.push('/opportunities')} />
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
              {isMinor ? (
                <>
                  <Muted size={13}>Only verified clubs inside ScoutBox can see your profile. It is hidden from public browsing, search engines and every agency — and clubs can only talk to your guardian.</Muted>
                  <Muted size={13}>Your medical data is {me.medical.shared ? 'shared by your guardian.' : 'private — no organisation can see any of it.'}</Muted>
                </>
              ) : (
                <>
                  <Muted size={13}>Verified clubs can see you. {me.academyPlus ? 'Academy+ is on: you surface in the boosted fresh-start cohort at the top of club searches.' : 'Academy+ is off. Turn it on in Account to join the boosted fresh-start cohort.'}</Muted>
                  <Muted size={13}>Your medical data is {me.medical.shared ? 'shared — organisations can see your records.' : 'private — no organisation can see any of it.'}</Muted>
                </>
              )}
              {weekly ? <Muted size={13}>This week: {weekly.report.views} profile view{weekly.report.views === 1 ? '' : 's'}, {weekly.report.shortlists} shortlist{weekly.report.shortlists === 1 ? '' : 's'}.</Muted> : null}
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
          <Disclosure label="How discovery works" testID="home-promises">
            {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => <Muted key={p.slice(0, 20)} size={13}>{p}</Muted>)}
          </Disclosure>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  identity: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, paddingTop: 12, paddingBottom: 24 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  avatarText: { color: colors.accentInk, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  name: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.8, lineHeight: 33 },
  identityLine: { color: colors.text, fontSize: 14.5, fontWeight: '500', lineHeight: 20, marginTop: 4 },
  availability: { color: colors.safetyText, fontSize: 13, lineHeight: 18, marginTop: 3 },
  joined: { color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  primary: { paddingVertical: 18, borderTopWidth: 1, borderTopColor: colors.line, gap: 4 },
  primaryTitle: { color: colors.text, fontSize: 21, fontWeight: '600', letterSpacing: -0.5, lineHeight: 27 },
  primarySub: { color: colors.muted, fontSize: 13.5, lineHeight: 20 },
  clubName: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  clubMeta: { color: colors.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  dirRow: { paddingVertical: 8, gap: 2 },
});
