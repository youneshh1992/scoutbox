// Activity — M24F.4. The full scouting stream the Home previews: every
// event, grouped Today / This week / Earlier, one line each, plus the week's
// figures as a single quiet line. Server data only (the same calls Home
// makes); tap a row for the organisation's directory entry is not offered
// because the stream carries no private detail — the event is the record.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../components/Text';
import { client, type Insights, type PlayerFeedItem } from '../data/client';
import { useSession } from '../state';
import { useColors, useStyles, type Palette } from '../theme';
import { pt } from '../i18n';
import { Kicker, Muted } from '../components/ui';
import { PageHeader } from '../components/PageChrome';
import { EVENT_LABELS } from './(tabs)/discover';
import { fmtShortDay, relTime } from '../time';

const NOTICED_LABELS: Record<string, string> = {
  first_touch: 'First touch', pace: 'Pace', positioning: 'Positioning', work_rate: 'Work rate',
  left_foot: 'Left foot', right_foot: 'Right foot', aerial: 'Aerial', composure: 'Composure',
  vision: 'Vision', pressing: 'Pressing', finishing: 'Finishing', distribution: 'Distribution',
};

export default function Activity() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const { playerId, notifications } = useSession();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [feed, setFeed] = useState<PlayerFeedItem[]>([]);
  useEffect(() => {
    if (!playerId) return;
    client.getInsights(playerId).then(setInsights).catch(() => {});
    client.getFeed(playerId).then(setFeed).catch(() => {});
  }, [playerId, notifications]);

  const now = Date.now();
  const events = [
    ...(insights?.recent ?? []).map((e) => ({ ts: e.ts, text: `${e.orgName} ${EVENT_LABELS[e.type] ?? e.type}`, org: e.orgName })),
    ...feed.filter((i): i is Extract<PlayerFeedItem, { type: 'scouting_event' }> => i.type === 'scouting_event').map((i) => ({ ts: i.ts, text: `${i.orgName} ${EVENT_LABELS[i.eventType] ?? i.eventType.replace(/_/g, ' ')}`, org: i.orgName })),
  ].filter((e, i, arr) => arr.findIndex((x) => x.ts === e.ts && x.text === e.text) === i).sort((a, b) => b.ts - a.ts);
  const groups: { key: string; label: string; items: typeof events }[] = [
    { key: 'today', label: pt('activityToday'), items: events.filter((e) => now - e.ts < 86_400_000) },
    { key: 'week', label: pt('activityThisWeek'), items: events.filter((e) => now - e.ts >= 86_400_000 && now - e.ts < 7 * 86_400_000) },
    { key: 'earlier', label: pt('activityEarlier'), items: events.filter((e) => now - e.ts >= 7 * 86_400_000) },
  ].filter((g) => g.items.length > 0);
  const weekly = feed.find((i): i is Extract<PlayerFeedItem, { type: 'weekly_report' }> => i.type === 'weekly_report');
  const noticed = feed.find((i): i is Extract<PlayerFeedItem, { type: 'scouts_noticed' }> => i.type === 'scouts_noticed');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} testID="activity-page">
        <PageHeader title={pt('activityTitle')} back />
        {weekly ? (
          <Muted size={13}>
            {pt('activityThisWeekDigest')}: {weekly.report.views} profile view{weekly.report.views === 1 ? '' : 's'}, {weekly.report.shortlists} shortlist{weekly.report.shortlists === 1 ? '' : 's'}
            {insights ? ` · ${insights.thisMonth.views} view${insights.thisMonth.views === 1 ? '' : 's'} this month` : ''}.
          </Muted>
        ) : null}
        {groups.length === 0 ? <View style={{ paddingVertical: 20 }}><Muted size={14}>{pt('homeNoActivity')}</Muted></View> : groups.map((g) => (
          <View key={g.key} style={{ marginTop: 22 }} testID={`activity-group-${g.key}`}>
            <Kicker>{g.label}</Kicker>
            {g.items.map((e, i) => (
              <View key={`${e.ts}-${i}`} style={styles.row} testID="activity-row">
                <Text style={styles.when}>{g.key === 'earlier' ? fmtShortDay(e.ts) : relTime(e.ts)}</Text>
                <Text style={styles.text}><Text style={{ fontWeight: '600', color: colors.text }}>{e.org}</Text>{e.text.slice(e.org.length)}</Text>
              </View>
            ))}
          </View>
        ))}
        {noticed ? (
          <View style={{ marginTop: 26 }}>
            <Kicker>Scouts noticed</Kicker>
            <Text style={[styles.text, { marginTop: 6 }]}>{Object.entries(noticed.tags).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${NOTICED_LABELS[t] ?? t} (${n})`).join(' · ')}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  when: { width: 62, color: colors.muted, fontSize: 12, lineHeight: 19, flexShrink: 0 },
  text: { flex: 1, color: colors.muted, fontSize: 13.5, lineHeight: 19 },
});
