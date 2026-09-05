// Message threads — shared by adult players and guardians. A thread exists
// only because a request was accepted; every message is moderated and logged,
// and children never appear here at all. Read receipts, typing indicators and
// clip attachments included.

import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { client, type Channel, type MessageAttachment } from '../data/client';
import type { MediaItem } from '../domain/types';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { WebVideo } from './WebVideo';

export function Threads({ channels, onSend, onOpen, onTyping, attachableClips, emptyText, auth }: {
  channels: Channel[];
  onSend: (channelId: string, text: string, attachMediaId?: string, clientMsgId?: string) => Promise<void>;
  /** Called when a thread is opened — mark it read. */
  onOpen?: (channelId: string) => void;
  /** Called (throttled) while the user types. */
  onTyping?: (channelId: string) => void;
  /** Clips this side may attach into the thread. */
  attachableClips?: MediaItem[];
  emptyText: string;
  /** Identity for the scoped live stream (typing pings). */
  auth?: { kind: 'player' | 'guardian'; id: string };
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachId, setAttachId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const lastTyped = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = channels.find((c) => c.id === openId) ?? null;

  useEffect(() => {
    if (openId && onOpen) onOpen(openId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // Listen for the other side's typing pings on the open thread.
  useEffect(() => {
    return client.onChange((event, payload) => {
      if (event === 'typing' && payload?.channelId === openId && payload?.side === 'org') {
        setTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(false), 3000);
      }
    }, auth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, auth?.kind, auth?.id]);

  const handleDraft = (v: string) => {
    setDraft(v);
    if (open && onTyping && Date.now() - lastTyped.current > 2000) {
      lastTyped.current = Date.now();
      onTyping(open.id);
    }
  };

  // Outbox: pending until the server confirms the message durable, failed
  // (with retry) on error. Retries reuse the client message id, so the server
  // never stores a duplicate.
  const [outbox, setOutbox] = useState<{ id: string; channelId: string; text: string; attach?: string; status: 'pending' | 'failed' }[]>([]);
  const send = async (retryId?: string) => {
    const entry = retryId ? outbox.find((o) => o.id === retryId) : null;
    const text = entry ? entry.text : draft.trim();
    const channelId = entry ? entry.channelId : open?.id;
    if (!channelId || !text) return;
    const cid = entry ? entry.id : `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const attach = entry ? entry.attach : (attachId ?? undefined);
    setError(null);
    if (entry) {
      setOutbox((o) => o.map((x) => (x.id === cid ? { ...x, status: 'pending' } : x)));
    } else {
      setOutbox((o) => [...o, { id: cid, channelId, text, attach, status: 'pending' }]);
      setDraft('');
      setAttachId(null);
    }
    try {
      await onSend(channelId, text, attach, cid);
      setOutbox((o) => o.filter((x) => x.id !== cid));
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250);
    } catch (e) {
      setOutbox((o) => o.map((x) => (x.id === cid ? { ...x, status: 'failed' } : x)));
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
              const read = mine && open.readBy?.org != null && open.readBy.org >= m.ts;
              return (
                <View key={m.id} style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                  <Muted size={10.5}>{m.sender.name}</Muted>
                  <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 19 }}>{m.text}</Text>
                  <Attachment attachment={m.attachment} />
                  {mine && <Muted size={10}>{read ? '✓✓ read' : '✓ sent'}</Muted>}
                </View>
              );
            })}
            {outbox.filter((o) => o.channelId === open.id).map((o) => (
              <View key={o.id} style={[styles.bubble, styles.mine, o.status === 'failed' ? styles.failed : styles.pending]}>
                <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 19 }}>{o.text}</Text>
                {o.status === 'failed'
                  ? <Row><Muted size={10}>not delivered</Muted><Button small label="Retry" onPress={() => send(o.id)} /></Row>
                  : <Muted size={10}>… sending</Muted>}
              </View>
            ))}
            {typing && <Muted size={12}>… {open.orgName} is typing</Muted>}
          </ScrollView>
          {error && <Text style={{ color: colors.danger, fontSize: 12.5 }}>{error}</Text>}
          {attachableClips && attachableClips.length > 0 && (
            <Row>
              <Muted size={12}>📎</Muted>
              {attachableClips.slice(0, 3).map((m) => (
                <Button
                  key={m.id}
                  small
                  primary={attachId === m.id}
                  label={`🎬 ${m.title.slice(0, 18)}${m.verifiedClip ? ' ✅' : ''}`}
                  onPress={() => setAttachId(attachId === m.id ? null : m.id)}
                />
              ))}
            </Row>
          )}
          <Row>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Write a message (no personal contact details)"
              placeholderTextColor={colors.muted}
              value={draft}
              onChangeText={handleDraft}
              onSubmitEditing={() => send()}
            />
            <Button small primary label="Send" onPress={() => send()} />
          </Row>
        </Card>
      )}
    </View>
  );
}

function Attachment({ attachment }: { attachment?: MessageAttachment | null }) {
  if (!attachment) return null;
  if (attachment.kind === 'clip') {
    const src = client.mediaUrl(attachment.url);
    return (
      <View style={{ gap: 4, marginTop: 4 }}>
        <Row>
          <Pill label={`🎬 ${attachment.title ?? 'clip'}`} tone="blue" />
          {attachment.verifiedClip && <Pill label="✅ Verified Clip" tone="green" />}
        </Row>
        {src && <WebVideo src={src} />}
      </View>
    );
  }
  return (
    <View style={{ gap: 2, marginTop: 4 }}>
      <Pill label={`📊 Trial report — ${attachment.orgName ?? ''}`} tone="gold" />
      {attachment.summary && <Muted size={11.5}>{attachment.summary}</Muted>}
    </View>
  );
}

export function ThreadsHeader() {
  return <SectionTitle>Messages — on-platform only</SectionTitle>;
}

const styles = StyleSheet.create({
  pending: { opacity: 0.65 },
  failed: { borderWidth: 1, borderColor: colors.danger },
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
