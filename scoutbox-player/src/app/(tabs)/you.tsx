import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { client, type FiledReport } from '../../data/client';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { ReportButton } from '../../components/ReportSheet';
import { NotificationBell } from '../../components/NotificationBell';

export default function You() {
  const router = useRouter();
  const { me, mode, isMinor, logout, playerId, notifications } = useSession();
  const [myReports, setMyReports] = useState<FiledReport[]>([]);

  useEffect(() => {
    if (playerId) client.getMyReports(playerId).then(setMyReports).catch(() => {});
  }, [playerId, notifications]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>You</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>

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

        {isMinor && (
          <Card style={{ borderColor: colors.accent2 }}>
            <SectionTitle>Your guardian-managed account</SectionTitle>
            <Muted size={13}>
              Your parent or guardian owns this account and handles everything club-related. If anything
              on ScoutBox ever makes you uncomfortable, use the ⚑ Report button — it&apos;s on every
              screen — or tell your guardian.
            </Muted>
          </Card>
        )}

        {myReports.length > 0 && (
          <>
            <SectionTitle>Safety centre — your reports</SectionTitle>
            {myReports.map((r) => (
              <Card key={r.id}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{r.reason}</Text>
                  <Pill label={r.status === 'resolved' ? 'reviewed' : 'in review'} tone={r.status === 'resolved' ? 'green' : 'gold'} />
                </Row>
                {r.outcome && <Muted size={12.5}>{r.outcome}</Muted>}
              </Card>
            ))}
          </>
        )}

        <SectionTitle>The rules that protect you</SectionTitle>
        {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => (
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
