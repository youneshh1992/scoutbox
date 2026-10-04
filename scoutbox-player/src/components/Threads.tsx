// Message threads — shared by adult players and guardians. A thread exists
// only because a request was accepted; every message is moderated and logged,
// and children never appear here at all. Read receipts, typing indicators and
// clip attachments included.
//
// M24F.3 — conversation-first. The list is one PreviewRow per thread (name,
// one-line preview, time, unread dot); the open thread is a clean header,
// the stream and a composer. Nothing repeats the identity on every bubble.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { client, type Channel, type MessageAttachment } from '../data/client';
import type { MediaItem } from '../domain/types';
import { useColors, useStyles, type Palette } from '../theme';
import { Button, Muted, PreviewRow, Row } from './ui';
import { WebVideo } from './WebVideo';
import { Icon } from './Icon';
import { pt } from '../i18n';
import { initialsOf } from './Reference';
import { fmtClock, relTime } from '../time';

/** The last message of a thread, the one-line preview and whether it is unread for this side. */
export function threadPreview(c: Channel): { line: string; time: string; unread: boolean } {
  const last = c.messages[c.messages.length - 1];
  if (!last) return { line: `${c.scoutName} · ${c.scoutRole}`, time: relTime(c.createdAt), unread: false };
  const mine = last.sender.kind !== 'org_user';
  const text = last.text || (last.attachment ? (last.attachment.kind === 'clip' ? pt('chatClip') : pt('chatReport')) : '');
  const seen = c.readBy?.counterparty ?? 0;
  return { line: mine ? `${pt('chatYou')}: ${text}` : text, time: relTime(last.ts), unread: !mine && last.ts > seen };
}

export function Threads({ channels, onSend, onOpen, onTyping, attachableClips, emptyText, auth, openChannelId, onOpenChange, headerExtra }: {
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
  /** M24F.3 — the open thread may be controlled by the screen (the Inbox opens a thread from its own list). */
  openChannelId?: string | null;
  onOpenChange?: (id: string | null) => void;
  /** M24F.3 — a special object at the head of an open thread (the trial invitation card). */
  headerExtra?: (c: Channel) => ReactNode;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const controlled = openChannelId !== undefined;
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null);
  const openId = controlled ? openChannelId : ownOpenId;
  const setOpenId = (id: string | null) => { if (!controlled) setOwnOpenId(id); onOpenChange?.(id); };
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

  if (channels.length === 0 && !open) {
    return <View style={{ paddingVertical: 12 }}><Muted size={13.5}>{emptyText}</Muted></View>;
  }

  const dayLabel = (ts: number) => {
    const d = new Date(ts); const now = new Date();
    return d.toDateString() === now.toDateString() ? pt('chatToday') : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  return (
    <View style={{ gap: 0 }} testID="threads">
      {!open && channels.map((c) => {
        const p = threadPreview(c);
        return <PreviewRow key={c.id} initials={initialsOf(c.orgName)} title={c.orgName} line={c.counterparty === 'guardian' ? `${p.line} · ${c.playerName}` : p.line} time={p.time} unread={p.unread} onPress={() => setOpenId(c.id)} testID={`thread-${c.id}`} />;
      })}
      {open && (
        <View testID={`thread-open-${open.id}`}>
          <View style={styles.person}>
            <Pressable onPress={() => setOpenId(null)} accessibilityRole="button" accessibilityLabel={pt('chatBack')} testID="thread-back" hitSlop={8} style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}>
              <Icon name="chevron-left" size={18} color={colors.text} />
            </Pressable>
            <View style={styles.clubAvatar}><Text style={{ color: colors.iconFg, fontSize: 12, fontWeight: '600' }}>{initialsOf(open.orgName)}</Text></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text role="heading" aria-level={2} style={styles.personName} numberOfLines={1}>{open.orgName}</Text>
              <Muted size={12}>{open.scoutName} · {open.scoutRole}</Muted>
            </View>
          </View>
          <View style={styles.safety}>
            <Icon name="shield-check" size={13} color={colors.safetyText} />
            <Text style={{ color: colors.safetyText, fontSize: 11 }}>{pt('chatSafetyLine')}</Text>
          </View>
          {headerExtra ? headerExtra(open) : null}
          <ScrollView ref={scrollRef} style={styles.thread} contentContainerStyle={{ paddingVertical: 4 }}>
            {open.messages.length === 0 && <Muted size={13}>{pt('chatSayHello')}</Muted>}
            {open.messages.map((m, i) => {
              const mine = m.sender.kind !== 'org_user';
              const isLastMine = mine && !open.messages.slice(i + 1).some((x) => x.sender.kind !== 'org_user');
              const read = mine && open.readBy?.org != null && open.readBy.org >= m.ts;
              const newDay = i === 0 || new Date(open.messages[i - 1].ts).toDateString() !== new Date(m.ts).toDateString();
              return (
                <View key={m.id}>
                  {newDay ? <Text style={styles.date}>{dayLabel(m.ts)}</Text> : null}
                  <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                    <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{m.text}</Text>
                    <Attachment attachment={m.attachment} />
                    <Text style={styles.meta}>{fmtClock(m.ts)}{isLastMine ? ` · ${read ? pt('chatRead') : pt('chatSent')}` : ''}</Text>
                  </View>
                </View>
              );
            })}
            {outbox.filter((o) => o.channelId === open.id).map((o) => (
              <View key={o.id} style={[styles.bubble, styles.mine, o.status === 'failed' ? styles.failed : styles.pending]}>
                <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{o.text}</Text>
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
              {attachableClips.slice(0, 3).map((m) => (
                <Button
                  key={m.id}
                  small
                  primary={attachId === m.id}
                  label={m.title.slice(0, 18)}
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
        <Muted size={12}>{attachment.title ?? 'clip'}{attachment.verifiedClip ? ' · Verified Clip' : ''}</Muted>
        {src && <WebVideo src={src} />}
      </View>
    );
  }
  return (
    <View style={{ gap: 2, marginTop: 4 }}>
      <Muted size={12}>Trial report — {attachment.orgName ?? ''}</Muted>
      {attachment.summary && <Muted size={11.5}>{attachment.summary}</Muted>}
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  pending: { opacity: 0.65 },
  failed: { borderWidth: 1, borderColor: colors.danger },
  clubAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.iconBg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2, paddingBottom: 12 },
  personName: { color: colors.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  backBtn: { paddingVertical: 8, paddingRight: 4, minHeight: 36, justifyContent: 'center' },
  safety: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line },
  date: { textAlign: 'center', color: colors.chatDate, fontSize: 11, marginVertical: 18 },
  thread: { maxHeight: 440 },
  bubble: { maxWidth: '86%', borderRadius: 14, paddingVertical: 9, paddingHorizontal: 12, marginVertical: 5, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.mine, borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.panel2, borderBottomLeftRadius: 4 },
  meta: { color: colors.bubbleMeta, fontSize: 10.5, marginTop: 4, alignSelf: 'flex-end' },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6, paddingRight: 6, paddingLeft: 14, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 22, marginTop: 14 },
  input: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, paddingVertical: 8 },
  sendBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});
