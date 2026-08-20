import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client, type Insights, type PlayerFeedItem } from '../../data/client';
import type { DirectoryClub } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { ReportButton } from '../../components/ReportSheet';
import { NotificationBell } from '../../components/NotificationBell';

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

export default function Discover() {
  const { me, isMinor, playerId, notifications, refresh } = useSession();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [feed, setFeed] = useState<PlayerFeedItem[]>([]);
  const [directory, setDirectory] = useState<DirectoryClub[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    if (!playerId) return;
    client.getInsights(playerId).then(setInsights).catch(() => {});
    client.getFeed(playerId).then(setFeed).catch(() => {});
    client.getDirectory().then(setDirectory).catch(() => {});
  }, [playerId]);

  useEffect(load, [load, notifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    load();
    setRefreshing(false);
  }, [refresh, load]);

  const weekly = feed.find((i): i is Extract<PlayerFeedItem, { type: 'weekly_report' }> => i.type === 'weekly_report');
  const noticed = feed.find((i): i is Extract<PlayerFeedItem, { type: 'scouts_noticed' }> => i.type === 'scouts_noticed');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>Home</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>

        {weekly && (
          <Card style={{ borderColor: colors.accent }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <SectionTitle>📬 Your weekly scout report</SectionTitle>
              {weekly.report.streak > 0 && <Pill label={`🔥 ${weekly.report.streak}-day streak`} tone="gold" />}
            </Row>
            <Muted size={13.5}>
              {weekly.report.views} profile view{weekly.report.views === 1 ? '' : 's'} and {weekly.report.shortlists} shortlist{weekly.report.shortlists === 1 ? '' : 's'} this week.
              {weekly.report.topClip ? ` Your top clip: “${weekly.report.topClip.title}” (${weekly.report.topClip.views} views${weekly.report.topClip.verified ? ', ✅ verified' : ''}).` : ''}
            </Muted>
            <Row style={{ justifyContent: 'space-between' }}>
              <Muted size={12.5}>Weekly goal: {Math.min(weekly.report.weeklyGoal.done, weekly.report.weeklyGoal.target)}/{weekly.report.weeklyGoal.target} activities</Muted>
              <Pill label={weekly.report.weeklyGoal.met ? 'goal met ✓' : 'keep going'} tone={weekly.report.weeklyGoal.met ? 'green' : 'blue'} />
            </Row>
            <View style={styles.goalTrack}>
              <View style={[styles.goalFill, { width: `${Math.min(100, (weekly.report.weeklyGoal.done / weekly.report.weeklyGoal.target) * 100)}%` }]} />
            </View>
            {weekly.report.suggestion && (
              <Muted size={12.5}>▶ Next best action: {weekly.report.suggestion.label}{weekly.report.suggestion.gain ? ` (+${weekly.report.suggestion.gain} trust)` : ''}</Muted>
            )}
          </Card>
        )}

        {noticed && (
          <Card style={{ borderColor: colors.gold }}>
            <SectionTitle>👀 What scouts noticed</SectionTitle>
            <Row>
              {Object.entries(noticed.tags).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
                <Pill key={t} label={`${NOTICED_LABELS[t] ?? t} ×${n}`} tone="gold" />
              ))}
            </Row>
            <Muted size={12.5}>
              Aggregated anonymously from scouts tagging your clips — professional feedback, not vanity metrics.
            </Muted>
          </Card>
        )}

        {me?.nextActions && me.nextActions.length > 0 && (
          <Card>
            <SectionTitle>💪 Build your profile strength</SectionTitle>
            {me.nextActions.map((a) => (
              <Row key={a.id}>
                <Pill label={a.gain ? `+${a.gain}` : '✅'} tone={a.gain ? 'green' : 'gold'} />
                <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{a.label}</Text>
              </Row>
            ))}
          </Card>
        )}

        {insights && (
          <Card style={{ borderColor: colors.accent2 }}>
            <SectionTitle>👁 Who&apos;s watching you</SectionTitle>
            {insights.weeklySeries && insights.weeklySeries.some((v) => v > 0) && (
              <Row style={{ alignItems: 'flex-end', height: 44, gap: 4 }}>
                {insights.weeklySeries.map((v, i) => {
                  const max = Math.max(...insights.weeklySeries!, 1);
                  return <View key={i} style={{ flex: 1, height: Math.max(4, (v / max) * 40), backgroundColor: i === insights.weeklySeries!.length - 1 ? colors.accent : colors.panel2, borderRadius: 3 }} />;
                })}
              </Row>
            )}
            <Row>
              <View style={styles.insightTile}>
                <Text style={styles.insightV}>{insights.thisWeek.views}</Text>
                <Muted size={11}>views this week</Muted>
              </View>
              <View style={styles.insightTile}>
                <Text style={styles.insightV}>{insights.thisMonth.views}</Text>
                <Muted size={11}>views this month</Muted>
              </View>
              <View style={styles.insightTile}>
                <Text style={styles.insightV}>{insights.thisMonth.shortlists}</Text>
                <Muted size={11}>shortlists</Muted>
              </View>
            </Row>
            {insights.recent.slice(0, 5).map((e, i) => (
              <Muted key={i} size={12.5}>
                {e.orgName} {EVENT_LABELS[e.type] ?? e.type} · {new Date(e.ts).toLocaleDateString()}
              </Muted>
            ))}
            {insights.recent.length === 0 && <Muted size={12.5}>No scouting activity yet — it shows here the moment it happens.</Muted>}
            <Muted size={11.5}>Every action is attributed on the ledger — this is your side of it.</Muted>
          </Card>
        )}

        {me && (
          <Card style={{ borderColor: colors.accent }}>
            <Text style={styles.cardTitle}>Your visibility right now</Text>
            {isMinor ? (
              <>
                <Muted size={13.5}>
                  Only verified clubs inside ScoutBox can see your profile. It is hidden from public
                  browsing, search engines and every agency — and clubs can only talk to your guardian.
                </Muted>
                <Muted size={13.5}>
                  Your medical data is {me.medical.shared ? 'shared by your guardian.' : 'private — no organisation can see any of it.'}
                </Muted>
              </>
            ) : (
              <>
                <Muted size={13.5}>
                  {me.academyPlus
                    ? 'Academy+ is ON: you surface in the boosted fresh-start cohort at the top of club searches.'
                    : 'Academy+ is off. Turn it on in Profile to join the boosted fresh-start cohort.'}
                </Muted>
                <Muted size={13.5}>
                  Your medical data is {me.medical.shared ? 'shared — organisations can see your records.' : 'private — no organisation can see any of it.'}
                </Muted>
              </>
            )}
          </Card>
        )}

        <SectionTitle>Club directory — how clubs actually behave</SectionTitle>
        {directory.length > 0 ? (
          <>
            <Muted size={12.5}>
              Not a follower count: trials run, reports filed and how fast. Clubs earn their standing by
              how they treat players.
            </Muted>
            {directory.map((d) => (
              <Card key={d.id}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.cardTitle}>{d.name}</Text>
                  <Row>
                    {d.verified ? <Pill label="Verified" tone="green" /> : <Pill label="unverified" tone="red" />}
                    {d.trustedPartner && <Pill label="Trusted Partner" tone="gold" />}
                    {d.safeguardingCertified && <Pill label="🛡 Safeguarding certified" tone="green" />}
                  </Row>
                </Row>
                <Muted size={12.5}>
                  {d.trialsRun} trial{d.trialsRun === 1 ? '' : 's'} run · {d.reportsFiled} report{d.reportsFiled === 1 ? '' : 's'} filed
                  {d.avgReportDays != null ? ` · avg ${d.avgReportDays} day${d.avgReportDays === 1 ? '' : 's'} to file` : ''}
                </Muted>
              </Card>
            ))}
          </>
        ) : (
          ORGS.map((o) => (
            <Card key={o.name}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.cardTitle}>{o.name}</Text>
                <Row>
                  <Pill label={o.type} tone={o.type === 'agency' ? 'red' : 'blue'} />
                  {o.trustedPartner && <Pill label="Trusted Partner" tone="gold" />}
                </Row>
              </Row>
              <Muted size={13.5}>{o.blurb}</Muted>
            </Card>
          ))
        )}

        <SectionTitle>How discovery works</SectionTitle>
        {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => (
          <Card key={p.slice(0, 20)}>
            <Muted size={13.5}>{p}</Muted>
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  h1: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 6 },
  cardTitle: { color: colors.text, fontSize: 15.5, fontWeight: '700' },
  insightTile: {
    flexGrow: 1,
    backgroundColor: colors.bg2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  insightV: { color: colors.accent, fontSize: 22, fontWeight: '800' },
  goalTrack: { height: 6, borderRadius: 3, backgroundColor: colors.bg2, overflow: 'hidden' },
  goalFill: { height: '100%', backgroundColor: colors.accent },
});
