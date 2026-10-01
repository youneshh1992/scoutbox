// Message threads — shared by adult players and guardians. A thread exists
// only because a request was accepted; every message is moderated and logged,
// and children never appear here at all. Read receipts, typing indicators and
// clip attachments included.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { client, type Channel, type MessageAttachment } from '../data/client';
import type { MediaItem } from '../domain/types';
import { useColors, useStyles, type Palette } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { WebVideo } from './WebVideo';
import { Icon } from './Icon';
import { pt } from '../i18n';
import { initialsOf } from './Reference';

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
  const colors = useColors();
  const styles = useStyles(makeStyles);
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

  // M24C — the reference Messages screen: thread rows with the club's
  // avatar, and an open thread as a person header, the safety strip, a date
  // divider, bubbles (theirs on a hairline, mine on the soft green) and the
  // rounded compose pill. Sending, retries, read receipts, typing pings and
  // clip attachments are exactly as before.
  const dayLabel = (ts: number) => {
    const d = new Date(ts); const now = new Date();
    return d.toDateString() === now.toDateString() ? pt('chatToday') : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return (
    <View style={{ gap: 10 }} testID="threads">
      {!open && channels.map((c) => (
        <Pressable key={c.id} onPress={() => setOpenId(c.id)} accessibilityRole="button" accessibilityLabel={`${pt('chatOpen')} ${c.orgName}`} testID={`thread-${c.id}`} style={({ pressed }) => [styles.threadRow, pressed && { opacity: 0.75 }]}>
          <View style={styles.clubAvatar}><Text style={{ color: colors.iconFg, fontSize: 12, fontWeight: '600' }}>{initialsOf(c.orgName)}</Text></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <Text style={styles.org} numberOfLines={1}>{c.orgName}</Text>
              {c.orgVerified && <Pill label="Verified" tone="green" />}
            </Row>
            <Muted size={11}>
              {c.scoutName} · {c.scoutRole}{c.counterparty === 'guardian' ? ` · about ${c.playerName}` : ''} · {c.messages.length} {pt('chatMessages')}
            </Muted>
          </View>
          <Text style={{ color: colors.accent2, fontSize: 12, fontWeight: '500' }}>{pt('chatOpen')}</Text>
          <Icon name="chevron-right" size={15} color={colors.muted} />
        </Pressable>
      ))}
      {open && (
        <View testID={`thread-open-${open.id}`}>
          <View style={styles.person}>
            <View style={styles.clubAvatar}><Text style={{ color: colors.iconFg, fontSize: 12, fontWeight: '600' }}>{initialsOf(open.orgName)}</Text></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text role="heading" aria-level={2} style={styles.personName}>{open.orgName}</Text>
              <Muted size={11}>{open.scoutName} · {open.scoutRole}</Muted>
            </View>
            <Pressable onPress={() => setOpenId(null)} accessibilityRole="button" accessibilityLabel={pt('chatBack')} hitSlop={8} style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}>
              <Icon name="chevron-left" size={16} color={colors.text} />
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '500' }}>{pt('chatBack')}</Text>
            </Pressable>
          </View>
          <View style={styles.safety}>
            <Icon name="shield-check" size={15} color={colors.safetyText} />
            <Text style={{ color: colors.safetyText, fontSize: 11, flex: 1 }}>{pt('chatAccepted')} · {pt('chatModerated')}</Text>
          </View>
          <ScrollView ref={scrollRef} style={styles.thread} contentContainerStyle={{ paddingVertical: 4 }}>
            {open.messages.length === 0 && <Muted size={13}>{pt('chatSayHello')}</Muted>}
            {open.messages.map((m, i) => {
              const mine = m.sender.kind !== 'org_user';
              const read = mine && open.readBy?.org != null && open.readBy.org >= m.ts;
              const newDay = i === 0 || new Date(open.messages[i - 1].ts).toDateString() !== new Date(m.ts).toDateString();
              return (
                <View key={m.id}>
                  {newDay ? <Text style={styles.date}>{dayLabel(m.ts)}</Text> : null}
                  <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                    <Text style={{ color: colors.text, fontSize: 13, lineHeight: 21 }}>{m.text}</Text>
                    <Attachment attachment={m.attachment} />
                    <Text style={styles.meta}>{mine ? pt('chatYou') : m.sender.name.split(' ')[0]} · {timeOf(m.ts)}{mine ? ` · ${read ? pt('chatRead') : pt('chatSent')}` : ''}</Text>
                  </View>
                </View>
              );
            })}
            {outbox.filter((o) => o.channelId === open.id).map((o) => (
              <View key={o.id} style={[styles.bubble, styles.mine, o.status === 'failed' ? styles.failed : styles.pending]}>
                <Text style={{ color: colors.text, fontSize: 13, lineHeight: 21 }}>{o.text}</Text>
                {o.status === 'failed'
                  ? <Row><Text style={styles.meta}>{pt('chatNotDelivered')}</Text><Button small label={pt('chatRetry')} onPress={() => send(o.id)} /></Row>
                  : <Text style={styles.meta}>{pt('chatSending')}</Text>}
              </View>
            ))}
            {typing && <Muted size={12}>… {open.orgName} {pt('chatTyping')}</Muted>}
          </ScrollView>
          {error && <Text style={{ color: colors.danger, fontSize: 12.5 }}>{error}</Text>}
          {attachableClips && attachableClips.length > 0 && (
            <Row style={{ marginTop: 8 }}>
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
          <View style={styles.compose}>
            <TextInput
              style={styles.input}
              placeholder={pt('chatWrite')}
              placeholderTextColor={colors.muted}
              accessibilityLabel={pt('chatWrite')}
              value={draft}
              onChangeText={handleDraft}
              onSubmitEditing={() => send()}
            />
            <Pressable onPress={() => send()} accessibilityRole="button" accessibilityLabel={pt('chatSend')} testID="thread-send" style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.8 }]}>
              <Icon name="arrow-up" size={16} color={colors.accentInk} />
            </Pressable>
          </View>
        </View>
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
  const colors = useColors();
  return <SectionTitle>Messages — on-platform only</SectionTitle>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  pending: { opacity: 0.65 },
  failed: { borderWidth: 1, borderColor: colors.danger },
  org: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  threadRow: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 11 },
  clubAvatar: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.panel2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingTop: 4, paddingBottom: 17 },
  personName: { color: colors.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 8, paddingHorizontal: 6, minHeight: 36 },
  safety: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.safety, borderRadius: 8, padding: 11 },
  date: { textAlign: 'center', color: colors.chatDate, fontSize: 11, marginVertical: 22 },
  thread: { maxHeight: 420 },
  bubble: { maxWidth: '90%', borderRadius: 13, padding: 13, marginVertical: 7.5, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.mine, borderBottomRightRadius: 3 },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderBottomLeftRadius: 3 },
  meta: { color: colors.bubbleMeta, fontSize: 11, marginTop: 8 },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 7, paddingRight: 7, paddingLeft: 13, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 22, marginTop: 20 },
  input: { flex: 1, minWidth: 0, color: colors.text, fontSize: 13, paddingVertical: 6 },
  sendBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});
