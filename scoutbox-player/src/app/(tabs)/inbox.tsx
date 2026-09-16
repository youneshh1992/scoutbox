import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import type { Channel } from '../../data/types';
import type { ChildInboxItem, InboxRequest } from '../../domain/types';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { pt } from '../../i18n';
import { PageHeader } from '../../components/PageChrome';
import { Threads } from '../../components/Threads';
import { AckSection } from '../../components/M13Sections';
import { TrialSlotChips } from '../../components/M23Trial';

function isChildItem(r: InboxRequest | ChildInboxItem): r is ChildInboxItem {
  return 'guardianManaged' in r && r.guardianManaged === true;
}

export default function Inbox() {
  const { playerId, inbox, isMinor, me, refresh, notifications } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [chosenSlots, setChosenSlots] = useState<Record<string, string>>({});
  // M23 P3: an optional short reply that travels with the answer to a contact.
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (playerId && !isMinor) client.getChannels(playerId).then(setChannels).catch(() => {});
  }, [playerId, isMinor, inbox, notifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    if (playerId && !isMinor) await client.getChannels(playerId).then(setChannels).catch(() => {});
    setRefreshing(false);
  }, [refresh, playerId, isMinor]);

  const respond = async (requestId: string, accept: boolean, isContact: boolean) => {
    if (!playerId || busy) return;
    setError(null);
    setBusy(requestId);
    try {
      const reply = isContact ? replies[requestId]?.trim() || undefined : undefined;
      await client.respond(playerId, requestId, accept, accept ? chosenSlots[requestId] : undefined, reply);
      setReplies((s) => { const n = { ...s }; delete n[requestId]; return n; });
      await refresh();
      if (playerId) setChannels(await client.getChannels(playerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not respond');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <PageHeader title={isMinor ? pt('tabUpdates') : pt('tabInbox')} />
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
              {r.subject ? <Text style={styles.subject} testID={`req-subject-${r.id}`}>{r.subject}</Text> : null}
              {r.message ? <Text style={styles.msg} testID={`req-message-${r.id}`}>“{r.message}”</Text> : null}
              {r.type === 'trial' && r.trialDetails && (
                <Muted size={12.5}>
                  {r.trialDetails.venue ? `Venue: ${r.trialDetails.venue}. ` : ''}
                  {r.trialDetails.notes}
                </Muted>
              )}
              {r.status === 'pending' && r.type === 'trial' && r.trialDetails?.proposedDate && (
                <>
                  <Muted size={12.5}>{pt('trialSlotPick')}</Muted>
                  {r.trialDetails.slots && r.trialDetails.slots.length > 0 ? (
                    <TrialSlotChips slots={r.trialDetails.slots} chosenDay={chosenSlots[r.id] ?? r.trialDetails.proposedDate} onPick={(day) => setChosenSlots((s) => ({ ...s, [r.id]: day }))} />
                  ) : (
                    <Row style={{ flexWrap: 'wrap' }}>
                      {[r.trialDetails.proposedDate, ...(r.trialDetails.altSlots ?? [])].map((slot) => {
                        const active = (chosenSlots[r.id] ?? r.trialDetails?.proposedDate) === slot;
                        return (
                          <Pressable key={slot} onPress={() => setChosenSlots((s) => ({ ...s, [r.id]: slot }))}>
                            <Pill label={slot} tone={active ? 'green' : undefined} />
                          </Pressable>
                        );
                      })}
                    </Row>
                  )}
                </>
              )}
              {r.status === 'pending' ? (
                <>
                  {r.type === 'contact' && (
                    <>
                      <Text style={styles.label} nativeID={`reply-label-${r.id}`}>{pt('ctReply')}</Text>
                      <TextInput
                        style={styles.input}
                        testID={`req-reply-${r.id}`}
                        accessibilityLabel={pt('ctReply')}
                        accessibilityLabelledBy={`reply-label-${r.id}`}
                        placeholder={pt('ctReplyHint')}
                        placeholderTextColor={colors.muted}
                        value={replies[r.id] ?? ''}
                        onChangeText={(v) => setReplies((s) => ({ ...s, [r.id]: v.slice(0, 500) }))}
                        multiline
                        maxLength={500}
                      />
                      <Muted size={12}>{pt('ctReplyNote')}</Muted>
                    </>
                  )}
                  <Row>
                    <Button small primary label={r.type === 'trial' ? 'Accept trial' : pt('ctAccept')} onPress={() => respond(r.id, true, r.type === 'contact')} />
                    <Button small danger label={pt('decline')} onPress={() => respond(r.id, false, r.type === 'contact')} />
                  </Row>
                </>
              ) : (
                <Row>
                  <Pill label={r.status} tone={r.status === 'accepted' ? 'green' : 'red'} />
                  {r.type === 'contact' && (r.status === 'accepted' || r.status === 'declined') && (
                    <Muted size={12.5}>{r.status === 'accepted' ? pt('ctRespondedAccepted') : pt('ctRespondedDeclined')}</Muted>
                  )}
                  {r.status === 'accepted' && r.contactChannel && <Pill label={`channel open: ${r.contactChannel}`} />}
                  {r.status === 'accepted' && r.type === 'trial' && (
                    <Muted size={12.5}>{r.trialId ? `${pt('trialAccepted')} ` : ''}The club must file a full performance report after your trial — it goes on your profile.</Muted>
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
              onSend={(channelId, text, attachMediaId, clientMsgId) => client.sendMessage(playerId, channelId, text, attachMediaId, clientMsgId)}
              auth={{ kind: 'player', id: playerId }}
              onOpen={(channelId) => void client.markChannelRead(playerId, channelId).catch(() => {})}
              onTyping={(channelId) => void client.sendTyping(playerId, channelId).catch(() => {})}
              attachableClips={me?.media ?? []}
              emptyText="No threads yet. Accept a request above and the conversation opens here — moderated, logged, and never off-platform."
            />
          </>
        )}
        {playerId ? <AckSection actor={{ kind: 'player', id: playerId }} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  org: { color: colors.text, fontSize: 16, fontWeight: '700' },
  subject: { color: colors.text, fontSize: 15, fontWeight: '700' },
  msg: { color: colors.text, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.bg2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: 44,
  },
});
