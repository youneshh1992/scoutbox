import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client, type Insights } from '../../data/client';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { ReportButton } from '../../components/ReportSheet';
import { NotificationBell } from '../../components/NotificationBell';

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
  const { me, isMinor, playerId, notifications } = useSession();
  const [insights, setInsights] = useState<Insights | null>(null);

  useEffect(() => {
    if (playerId) client.getInsights(playerId).then(setInsights).catch(() => {});
  }, [playerId, notifications]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>Discover</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>
        <Muted>Who&apos;s scouting, and exactly what they can — and can&apos;t — do.</Muted>

        {insights && (
          <Card style={{ borderColor: colors.accent2 }}>
            <SectionTitle>👁 Who&apos;s watching you</SectionTitle>
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

        <SectionTitle>Scouting on ScoutBox</SectionTitle>
        {ORGS.map((o) => (
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
        ))}

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
});
