import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SAFEGUARDING_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';

// Organisations scouting on ScoutBox. Presentation data only — what an org can
// actually do about you is decided by the server, not this list.
const ORGS = [
  { name: 'Eastport FC', type: 'club', plan: 'Pro', trustedPartner: true, blurb: 'Full-time recruitment desk, files trial reports same week.' },
  { name: 'Harbour City FC', type: 'club', plan: 'Academy', trustedPartner: false, blurb: 'Community club scouting the local leagues.' },
  { name: 'North Star Sports Agency', type: 'agency', plan: 'Agency', trustedPartner: false, blurb: 'Licensed agents. Structurally walled off from minors.' },
] as const;

export default function Discover() {
  const { me } = useSession();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Discover</Text>
        <Muted>Who&apos;s scouting, and exactly what they can — and can&apos;t — do.</Muted>

        {me && (
          <Card style={{ borderColor: colors.accent }}>
            <Text style={styles.cardTitle}>Your visibility right now</Text>
            <Muted size={13.5}>
              {me.academyPlus
                ? 'Academy+ is ON: you surface in the boosted fresh-start cohort at the top of club searches.'
                : 'Academy+ is off. Turn it on in Profile to join the boosted fresh-start cohort.'}
            </Muted>
            <Muted size={13.5}>
              Your medical data is {me.medical.shared ? 'shared — organisations can see your records.' : 'private — no organisation can see any of it.'}
            </Muted>
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
        {SAFEGUARDING_PROMISES.map((p) => (
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
});
