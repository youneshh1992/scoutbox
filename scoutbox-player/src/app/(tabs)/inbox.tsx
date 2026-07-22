import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row } from '../../components/ui';

export default function Inbox() {
  const { playerId, inbox, refresh } = useSession();
  const [error, setError] = useState<string | null>(null);

  const respond = async (requestId: string, accept: boolean) => {
    if (!playerId) return;
    setError(null);
    try {
      await client.respond(playerId, requestId, accept);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not respond');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Scout Inbox</Text>
        <Muted>
          Every approach lands here first. Nothing — no message, no call, no DM — reaches you unless you
          accept. Declining is final and the organisation is told nothing more.
        </Muted>

        {error && (
          <Card style={{ borderColor: colors.danger }}>
            <Text style={{ color: colors.danger }}>{error}</Text>
          </Card>
        )}

        {inbox.length === 0 && (
          <Card>
            <Muted size={14}>
              No requests yet. When a scout wants to reach you, it shows up here — attributed to a named
              person at a named organisation.
            </Muted>
          </Card>
        )}

        {inbox.map((r) => (
          <Card key={r.id} style={r.status === 'pending' ? { borderColor: colors.accent2 } : undefined}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.org}>{r.orgName}</Text>
              <Row>
                <Pill label={r.type === 'trial' ? 'trial request' : 'contact request'} tone={r.type === 'trial' ? 'gold' : 'blue'} />
                {r.trustedPartner && <Pill label="Trusted Partner" tone="gold" />}
              </Row>
            </Row>
            <Muted size={13}>
              From {r.scoutName} · {new Date(r.createdAt).toLocaleString()}
            </Muted>
            {r.message ? <Text style={styles.msg}>“{r.message}”</Text> : null}
            {r.status === 'pending' ? (
              <Row>
                <Button small primary label={r.type === 'trial' ? 'Accept trial' : 'Accept contact'} onPress={() => respond(r.id, true)} />
                <Button small danger label="Decline" onPress={() => respond(r.id, false)} />
              </Row>
            ) : (
              <Row>
                <Pill label={r.status} tone={r.status === 'accepted' ? 'green' : 'red'} />
                {r.status === 'accepted' && r.contactChannel && <Pill label={`channel open: ${r.contactChannel}`} />}
                {r.status === 'accepted' && r.type === 'trial' && (
                  <Muted size={12.5}>The club must file a full performance report after your trial — it goes on your profile.</Muted>
                )}
              </Row>
            )}
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
  org: { color: colors.text, fontSize: 16, fontWeight: '700' },
  msg: { color: colors.text, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
});
