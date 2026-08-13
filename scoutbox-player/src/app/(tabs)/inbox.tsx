import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import type { Channel } from '../../data/types';
import type { ChildInboxItem, InboxRequest } from '../../domain/types';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { ReportButton } from '../../components/ReportSheet';
import { NotificationBell } from '../../components/NotificationBell';
import { Threads } from '../../components/Threads';

function isChildItem(r: InboxRequest | ChildInboxItem): r is ChildInboxItem {
  return 'guardianManaged' in r && r.guardianManaged === true;
}

export default function Inbox() {
  const { playerId, inbox, isMinor, refresh, notifications } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    if (playerId && !isMinor) client.getChannels(playerId).then(setChannels).catch(() => {});
  }, [playerId, isMinor, inbox, notifications]);

  const respond = async (requestId: string, accept: boolean) => {
    if (!playerId) return;
    setError(null);
    try {
      await client.respond(playerId, requestId, accept);
      await refresh();
      if (playerId) setChannels(await client.getChannels(playerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not respond');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>{isMinor ? 'Updates' : 'Scout Inbox'}</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>
        {isMinor ? (
          <Muted>
            Scouts can&apos;t message you — that&apos;s a promise, not a setting. Clubs talk to your parent
            or guardian, and you see the outcome here. No messages, no likes, no followers.
          </Muted>
        ) : (
          <Muted>
            Every approach lands here first. Nothing — no message, no call, no DM — reaches you unless you
            accept. Declining is final and the organisation is told nothing more.
          </Muted>
        )}

        {error && (
          <Card style={{ borderColor: colors.danger }}>
            <Text style={{ color: colors.danger }}>{error}</Text>
          </Card>
        )}

        {inbox.length === 0 && (
          <Card>
            <Muted size={14}>
              {isMinor
                ? 'Nothing yet. When a verified club is interested, they contact your parent/guardian and the update shows here.'
                : 'No requests yet. When a scout wants to reach you, it shows up here — attributed to a named person at a named organisation.'}
            </Muted>
          </Card>
        )}

        {inbox.map((r) =>
          isChildItem(r) ? (
            <Card key={r.id} style={r.status === 'pending' ? { borderColor: colors.accent2 } : undefined}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.org}>{r.orgName}</Text>
                <Row>
                  {r.orgVerified && <Pill label="Verified club" tone="green" />}
                  <Pill label="guardian-managed" />
                </Row>
              </Row>
              <Muted size={13.5}>{r.note}</Muted>
              <Row>
                <Pill
                  label={r.status === 'pending' ? 'with your guardian' : r.status}
                  tone={r.status === 'accepted' ? 'green' : r.status === 'declined' || r.status === 'suspended' ? 'red' : 'blue'}
                />
              </Row>
            </Card>
          ) : (
            <Card key={r.id} style={r.status === 'pending' ? { borderColor: colors.accent2 } : undefined}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.org}>{r.orgName}</Text>
                <Row>
                  {r.orgVerified && <Pill label="Verified" tone="green" />}
                  <Pill label={r.type === 'trial' ? 'trial request' : 'contact request'} tone={r.type === 'trial' ? 'gold' : 'blue'} />
                  {r.trustedPartner && <Pill label="Trusted Partner" tone="gold" />}
                </Row>
              </Row>
              <Muted size={13}>
                From {r.scoutName}{r.scoutRole ? ` (${r.scoutRole})` : ''} · {new Date(r.createdAt).toLocaleString()}
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
          )
        )}

        {!isMinor && playerId && (
          <>
            <SectionTitle>Messages — open after acceptance, on-platform only</SectionTitle>
            <Threads
              channels={channels}
              onSend={(channelId, text) => client.sendMessage(playerId, channelId, text)}
              emptyText="No threads yet. Accept a request above and the conversation opens here — moderated, logged, and never off-platform."
            />
          </>
        )}
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
