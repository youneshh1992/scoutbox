// Message threads — shared by adult players and guardians. A thread exists
// only because a request was accepted; every message is moderated and logged,
// and children never appear here at all.

import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Channel } from '../data/types';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';

export function Threads({ channels, onSend, emptyText }: {
  channels: Channel[];
  onSend: (channelId: string, text: string) => Promise<void>;
  emptyText: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const open = channels.find((c) => c.id === openId) ?? null;

  const send = async () => {
    if (!open || !draft.trim()) return;
    setError(null);
    try {
      await onSend(open.id, draft.trim());
      setDraft('');
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    }
  };

  if (channels.length === 0) {
    return (
      <Card>
        <Muted size={13.5}>{emptyText}</Muted>
      </Card>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {!open && channels.map((c) => (
        <Card key={c.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.org}>{c.orgName}</Text>
              <Muted size={12.5}>
                {c.scoutRole} — {c.scoutName}{c.counterparty === 'guardian' ? ` · about ${c.playerName}` : ''} · {c.messages.length} message{c.messages.length === 1 ? '' : 's'}
              </Muted>
            </View>
            <Row>
              {c.orgVerified && <Pill label="Verified" tone="green" />}
              <Button small label="Open" onPress={() => setOpenId(c.id)} />
            </Row>
          </Row>
        </Card>
      ))}
      {open && (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.org}>{open.orgName}</Text>
              <Muted size={12}>{open.scoutRole} — {open.scoutName} · on-platform, moderated, logged</Muted>
            </View>
            <Button small label="Back" onPress={() => setOpenId(null)} />
          </Row>
          <ScrollView ref={scrollRef} style={styles.thread} contentContainerStyle={{ gap: 8, padding: 10 }}>
            {open.messages.length === 0 && <Muted size={13}>The thread is open — say hello.</Muted>}
            {open.messages.map((m) => {
              const mine = m.sender.kind !== 'org_user';
              return (
                <View key={m.id} style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                  <Muted size={10.5}>{m.sender.name}</Muted>
                  <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 19 }}>{m.text}</Text>
                </View>
              );
            })}
          </ScrollView>
          {error && <Text style={{ color: colors.danger, fontSize: 12.5 }}>{error}</Text>}
          <Row>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Write a message (no personal contact details)"
              placeholderTextColor={colors.muted}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={send}
            />
            <Button small primary label="Send" onPress={send} />
          </Row>
        </Card>
      )}
    </View>
  );
}

export function ThreadsHeader() {
  return <SectionTitle>Messages — on-platform only</SectionTitle>;
}

const styles = StyleSheet.create({
  org: { color: colors.text, fontSize: 15.5, fontWeight: '700' },
  thread: {
    maxHeight: 320,
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
  },
  bubble: { maxWidth: '82%', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#14497a' },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.panel2 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
});
