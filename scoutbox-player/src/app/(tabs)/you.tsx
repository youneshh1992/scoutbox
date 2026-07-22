import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { SAFEGUARDING_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';

export default function You() {
  const router = useRouter();
  const { me, mode, logout } = useSession();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>You</Text>

        <Card>
          <Text style={styles.cardTitle}>{me?.name ?? '—'}</Text>
          <Muted size={13}>
            {me ? `${me.country}${me.city ? ` · ${me.city}` : ''} · born ${me.dob}` : ''}
          </Muted>
          <Row>
            <Pill label={mode === 'live' ? 'Live sync — connected to scoutbox-server' : 'Demo mode — self-contained'} tone={mode === 'live' ? 'green' : 'blue'} />
          </Row>
        </Card>

        <Card>
          <SectionTitle>Your account, your data</SectionTitle>
          <Muted size={13}>
            ScoutBox is free for players, always. Your profile, your media, your medical records and your
            availability are player-controlled. Organisations act under named-individual accountability and
            everything they do around your profile is on an append-only ledger you benefit from.
          </Muted>
        </Card>

        <SectionTitle>The rules that protect you</SectionTitle>
        {SAFEGUARDING_PROMISES.map((p) => (
          <Card key={p.slice(0, 20)}>
            <Muted size={13}>{p}</Muted>
          </Card>
        ))}

        <Button
          label="Log out"
          onPress={() => {
            logout();
            router.replace('/onboarding');
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  h1: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 6 },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
