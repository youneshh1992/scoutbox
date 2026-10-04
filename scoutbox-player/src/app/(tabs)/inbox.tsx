// M24F.3 — the Inbox, conversation-first.
//
// One list: every request and every thread as a PreviewRow (identity, one
// line, time, unread). A trial invitation carries the warm trial accent and
// the word "Trial"; a contact request the quiet "Request" label; an offer or
// a signing event is a row that opens its own workflow. Opening a row shows
// the detail: the actions stay visible, the full message, the venue notes
// and the metadata sit behind "View full message". Nothing here changes
// who may contact whom — the same client calls answer the same requests.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, TextInput } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import type { AppNotification, Channel } from '../../data/types';
import type { ChildInboxItem, InboxRequest } from '../../domain/types';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { Button, DetailLink, Disclosure, Kicker, Muted, PreviewRow, Row } from '../../components/ui';
import { pt } from '../../i18n';
import { PageHeader, PageTabs } from '../../components/PageChrome';
import { Threads, threadPreview } from '../../components/Threads';
import { AckSection } from '../../components/M13Sections';
import { TrialSlotChips } from '../../components/M23Trial';
import { Icon } from '../../components/Icon';
import { initialsOf } from '../../components/Reference';
import { fmtShortDay, humanDate, relTime } from '../../time';

function isChildItem(r: InboxRequest | ChildInboxItem): r is ChildInboxItem {
  return 'guardianManaged' in r && r.guardianManaged === true;
}

type Entry =
  | { kind: 'request'; id: string; ts: number; req: InboxRequest }
  | { kind: 'child'; id: string; ts: number; item: ChildInboxItem }
  | { kind: 'thread'; id: string; ts: number; channel: Channel }
  | { kind: 'event'; id: string; ts: number; note: AppNotification; event: 'offer' | 'signing' };

const statusWord = (s: InboxRequest['status']) => (s === 'accepted' ? pt('inboxAccepted') : s === 'declined' ? pt('inboxDeclined') : s === 'suspended' ? pt('inboxSuspended') : '');

export default function Inbox() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { playerId, inbox, isMinor, me, refresh, notifications } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'all' | 'unread' | 'requests'>('all');
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [openChild, setOpenChild] = useState<string | null>(null);

  useEffect(() => {
    if (playerId && !isMinor) client.getChannels(playerId).then(setChannels).catch(() => {});
  }, [playerId, isMinor, inbox, notifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    if (playerId && !isMinor) await client.getChannels(playerId).then(setChannels).catch(() => {});
    setRefreshing(false);
  }, [refresh, playerId, isMinor]);

  // The list: requests that have no thread yet, every thread, and the offer /
  // signing events that have their own workflow — newest first.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const threadReqs = new Set(channels.map((c) => c.requestId));
    for (const r of inbox) {
      if (isChildItem(r)) out.push({ kind: 'child', id: r.id, ts: 0, item: r });
      else if (!threadReqs.has(r.id)) out.push({ kind: 'request', id: r.id, ts: r.respondedAt ?? r.createdAt, req: r });
    }
    for (const c of channels) { const last = c.messages[c.messages.length - 1]; out.push({ kind: 'thread', id: c.id, ts: last?.ts ?? c.createdAt, channel: c }); }
    const seen = new Set<string>();
    for (const n of notifications) {
      const k = n.target?.kind;
      if ((k === 'offer' || k === 'signing') && !seen.has(`${k}:${n.refId ?? n.id}`)) { seen.add(`${k}:${n.refId ?? n.id}`); out.push({ kind: 'event', id: n.id, ts: n.ts, note: n, event: k }); }
    }
    // pending requests first, then by time
    return out.sort((a, b) => (Number(b.kind === 'request' && b.req.status === 'pending') - Number(a.kind === 'request' && a.req.status === 'pending')) || b.ts - a.ts);
  }, [inbox, channels, notifications]);

  const isUnread = (e: Entry) => (e.kind === 'request' ? e.req.status === 'pending' : e.kind === 'thread' ? threadPreview(e.channel).unread : e.kind === 'event' ? !e.note.read : e.item.status === 'pending');
  const isRequest = (e: Entry) => e.kind === 'request' || e.kind === 'child' || e.kind === 'event';
  const shown = entries.filter((e) => (tab === 'unread' ? isUnread(e) : tab === 'requests' ? isRequest(e) : true));
  const unreadCount = entries.filter(isUnread).length;

  const respond = async (requestId: string, accept: boolean, isContact: boolean, slot?: string, reply?: string) => {
    if (!playerId) return;
    setError(null);
    try {
      await client.respond(playerId, requestId, accept, accept ? slot : undefined, reply);
      await refresh();
      if (playerId) setChannels(await client.getChannels(playerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not respond');
    }
  };

  const openEntry = (e: Entry) => {
    if (e.kind === 'request') setOpenRequest(e.id);
    else if (e.kind === 'thread') setOpenThread(e.id);
    else if (e.kind === 'child') setOpenChild(e.id);
    else router.push(e.event === 'offer' ? '/opportunities?cat=offer&tab=offer-terms' : '/opportunities?cat=signing&tab=signing-status');
  };

  const request = openRequest ? inbox.find((r): r is InboxRequest => !isChildItem(r) && r.id === openRequest) ?? null : null;
  const child = openChild ? inbox.find((r): r is ChildInboxItem => isChildItem(r) && r.id === openChild) ?? null : null;
  const trialOf = (c: Channel) => inbox.find((r): r is InboxRequest => !isChildItem(r) && r.id === c.requestId && r.type === 'trial') ?? null;

  const tabs = [
    { key: 'all', label: pt('inboxAll') },
    { key: 'unread', label: unreadCount ? `${pt('inboxUnread')} ${unreadCount}` : pt('inboxUnread') },
    { key: 'requests', label: pt('inboxRequests') },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {request ? (
          <RequestDetail r={request} onBack={() => setOpenRequest(null)} onRespond={respond} onOpenThread={(c) => { setOpenRequest(null); setOpenThread(c); }} channels={channels} error={error} />
        ) : child ? (
          <ChildDetail item={child} onBack={() => setOpenChild(null)} />
        ) : openThread && playerId ? (
          <View testID="inbox-thread">
            <Threads
              channels={channels}
              openChannelId={openThread}
              onOpenChange={(id) => setOpenThread(id)}
              onSend={(channelId, text, attachMediaId, clientMsgId) => client.sendMessage(playerId, channelId, text, attachMediaId, clientMsgId)}
              auth={{ kind: 'player', id: playerId }}
              onOpen={(channelId) => void client.markChannelRead(playerId, channelId).catch(() => {})}
              onTyping={(channelId) => void client.sendTyping(playerId, channelId).catch(() => {})}
              attachableClips={me?.media ?? []}
              emptyText={pt('inboxEmpty')}
              headerExtra={(c) => { const t = trialOf(c); return t ? <TrialCard r={t} onView={() => router.push('/opportunities?cat=trial&tab=schedule')} /> : null; }}
            />
          </View>
        ) : (
          <>
            <PageHeader title={isMinor ? pt('tabUpdates') : pt('tabInbox')} />
            <Disclosure label={isMinor ? pt('inboxMinorLine') : pt('inboxSafety')} testID="inbox-safety">
              <Muted size={13}>{isMinor ? pt('inboxMinorFull') : pt('inboxSafetyFull')}</Muted>
            </Disclosure>
            {!isMinor ? <PageTabs tabs={tabs} value={tab} onChange={(k) => setTab(k as typeof tab)} /> : null}
            {error ? <Text style={{ color: colors.danger, fontSize: 13, marginTop: 8 }}>{error}</Text> : null}
            <View testID="inbox-list">
              {shown.length === 0 ? <View style={{ paddingVertical: 24 }}><Muted size={14}>{tab === 'unread' ? pt('inboxEmptyUnread') : tab === 'requests' ? pt('inboxEmptyRequests') : pt('inboxEmpty')}</Muted></View> : null}
              {shown.map((e) => {
                if (e.kind === 'request') {
                  const r = e.req; const trial = r.type === 'trial';
                  const when = trial && r.trialDetails?.proposedDate ? humanDate(r.trialDetails.proposedDate) : null;
                  const line = r.status === 'pending' ? (trial ? `${pt('inboxTrialInvitation')}${when ? ` · ${when}` : ''}` : pt('inboxWantsContact')) : `${trial ? pt('inboxTrialInvitation') : pt('inboxContactRequest')} · ${statusWord(r.status)}`;
                  return <PreviewRow key={e.id} initials={initialsOf(r.orgName)} title={r.orgName} line={line} time={relTime(e.ts)} unread={r.status === 'pending'} accent={trial ? 'trial' : r.status === 'pending' ? 'request' : null} accentLabel={trial ? pt('inboxTrialLabel') : r.status === 'pending' ? pt('inboxRequestLabel') : undefined} onPress={() => openEntry(e)} testID={`inbox-request-${r.id}`} />;
                }
                if (e.kind === 'thread') {
                  const p = threadPreview(e.channel); const t = trialOf(e.channel);
                  return <PreviewRow key={e.id} initials={initialsOf(e.channel.orgName)} title={e.channel.orgName} line={p.line} time={p.time} unread={p.unread} accent={t ? 'trial' : null} accentLabel={t ? pt('inboxTrialLabel') : undefined} onPress={() => openEntry(e)} testID={`thread-${e.channel.id}`} />;
                }
                if (e.kind === 'event') {
                  const offer = e.event === 'offer';
                  return <PreviewRow key={e.id} initials={initialsOf(e.note.text.split(/\s[—·-]\s|:/)[0] || (offer ? 'O' : 'S'))} title={offer ? pt('inboxOfferReceived') : pt('inboxSigningAction')} line={offer ? pt('inboxViewOffer') : pt('inboxViewSigning')} time={relTime(e.ts)} unread={!e.note.read} accent={offer ? 'offer' : 'signing'} accentLabel={offer ? pt('inboxOfferLabel') : pt('inboxSigningLabel')} onPress={() => openEntry(e)} testID={`inbox-event-${e.note.id}`} />;
                }
                const it = e.item;
                return <PreviewRow key={e.id} initials={initialsOf(it.orgName)} title={it.orgName} line={it.status === 'pending' ? pt('inboxWithGuardian') : statusWord(it.status)} unread={it.status === 'pending'} accent={it.type === 'trial' ? 'trial' : null} accentLabel={it.type === 'trial' ? pt('inboxTrialLabel') : undefined} onPress={() => openEntry(e)} testID={`inbox-child-${it.id}`} />;
              })}
            </View>
            {playerId ? <AckSection actor={{ kind: 'player', id: playerId }} /> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** The opened request: the kind, the club, who, when and where, the decision, and the words behind one tap. */
function RequestDetail({ r, onBack, onRespond, onOpenThread, channels, error }: { r: InboxRequest; onBack: () => void; onRespond: (id: string, accept: boolean, isContact: boolean, slot?: string, reply?: string) => Promise<void>; onOpenThread: (channelId: string) => void; channels: Channel[]; error: string | null }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const [slot, setSlot] = useState<string | undefined>(r.trialDetails?.proposedDate ?? undefined);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const trial = r.type === 'trial';
  const pending = r.status === 'pending';
  const thread = channels.find((c) => c.requestId === r.id) ?? null;
  const slots = r.trialDetails?.slots ?? [];
  const altSlots = r.trialDetails?.altSlots ?? [];
  const answer = async (accept: boolean) => { setBusy(true); try { await onRespond(r.id, accept, !trial, slot, reply.trim() || undefined); } finally { setBusy(false); } };
  return (
    <View testID={`request-detail-${r.id}`}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={pt('chatBack')} testID="detail-back" style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}>
        <Icon name="chevron-left" size={18} color={colors.text} /><Text style={{ color: colors.text, fontSize: 13, fontWeight: '500' }}>{pt('tabInbox')}</Text>
      </Pressable>
      <View style={[styles.special, trial && { borderLeftColor: colors.trial, backgroundColor: colors.trialBg }]} testID={trial ? 'trial-card' : 'contact-card'}>
        <Kicker tone={trial ? undefined : 'accent'}>{trial ? pt('inboxTrialInvitation') : pt('inboxContactRequest')}</Kicker>
        <Text role="heading" aria-level={2} style={styles.org}>{r.orgName}</Text>
        <Muted size={13.5}>{pt('inboxFrom')} {r.scoutName}{r.scoutRole ? ` · ${r.scoutRole}` : ''}</Muted>
        {trial ? <Muted size={13.5}>{r.trialDetails?.proposedDate ? humanDate(r.trialDetails.proposedDate) : pt('inboxDateTbc')}{r.trialDetails?.venue ? ` · ${r.trialDetails.venue}` : ''}</Muted> : <Muted size={13.5}>{fmtShortDay(r.createdAt)}</Muted>}
        {pending && trial && slots.length > 0 ? <TrialSlotChips slots={slots} chosenDay={slot ?? r.trialDetails?.proposedDate ?? ''} onPick={setSlot} /> : null}
        {pending && trial && slots.length === 0 && altSlots.length > 0 ? (
          <Row style={{ flexWrap: 'wrap' }}>
            {[r.trialDetails?.proposedDate, ...altSlots].filter((s): s is string => !!s).map((s) => (
              <Pressable key={s} onPress={() => setSlot(s)} accessibilityRole="button" accessibilityState={{ selected: slot === s }} accessibilityLabel={s} testID={`alt-slot-${s}`} style={[styles.slot, slot === s && { borderColor: colors.accent, backgroundColor: colors.panel2 }]}><Text style={{ color: colors.text, fontSize: 13, fontWeight: slot === s ? '700' : '400' }}>{humanDate(s)}</Text></Pressable>
            ))}
          </Row>
        ) : null}
        {pending ? (
          <Row style={{ marginTop: 8 }}>
            <Button primary disabled={busy} label={pt('accept')} onPress={() => void answer(true)} testID={`req-accept-${r.id}`} />
            <Button tertiary danger disabled={busy} label={pt('decline')} onPress={() => void answer(false)} testID={`req-decline-${r.id}`} />
          </Row>
        ) : (
          <Row style={{ marginTop: 6 }}>
            <Text style={{ color: r.status === 'accepted' ? colors.accentText : colors.danger, fontSize: 14, fontWeight: '600' }} testID={`req-status-${r.id}`}>{statusWord(r.status)}</Text>
            {r.status === 'accepted' && trial ? <DetailLink label={pt('inboxViewTrial')} onPress={() => router.push('/opportunities?cat=trial&tab=schedule')} testID="req-view-trial" /> : null}
            {r.status === 'accepted' && !trial && thread ? <DetailLink label={pt('inboxOpenConversation')} onPress={() => onOpenThread(thread.id)} testID="req-open-thread" /> : null}
          </Row>
        )}
        {error ? <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text> : null}
      </View>
      <Disclosure label={pt('inboxViewFullMessage')} testID={`req-details-${r.id}`}>
        {r.subject ? <Text style={styles.subject} testID={`req-subject-${r.id}`}>{r.subject}</Text> : null}
        {r.message ? <Text style={styles.msg} testID={`req-message-${r.id}`}>“{r.message}”</Text> : null}
        {trial && r.trialDetails?.notes ? <Muted size={13}>{r.trialDetails.notes}</Muted> : null}
        <Muted size={12.5}>{[r.orgVerified ? pt('inboxVerifiedClub') : null, r.trustedPartner ? pt('inboxTrustedPartner') : null, relTime(r.createdAt)].filter(Boolean).join(' · ')}</Muted>
        {trial ? <Muted size={12.5}>{pt('inboxReportNote')}</Muted> : null}
        {pending && !trial ? (
          <View style={{ gap: 6, marginTop: 4 }}>
            <Text style={styles.label} nativeID={`reply-label-${r.id}`}>{pt('inboxAddReply')}</Text>
            <TextInput style={styles.input} testID={`req-reply-${r.id}`} accessibilityLabel={pt('ctReply')} accessibilityLabelledBy={`reply-label-${r.id}`} placeholder={pt('ctReplyHint')} placeholderTextColor={colors.muted} value={reply} onChangeText={(v) => setReply(v.slice(0, 500))} multiline maxLength={500} />
            <Muted size={12}>{pt('ctReplyNote')}</Muted>
          </View>
        ) : null}
      </Disclosure>
    </View>
  );
}

/** The trial object at the head of an accepted trial's thread: short, special, one link to the trial itself. */
function TrialCard({ r, onView }: { r: InboxRequest; onView: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.special, { borderLeftColor: colors.trial, backgroundColor: colors.trialBg, marginTop: 10 }]} testID="thread-trial-card">
      <Kicker>{pt('inboxTrialInvitation')}</Kicker>
      <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '600' }}>{r.trialDetails?.proposedDate ? humanDate(r.trialDetails.proposedDate) : pt('inboxDateTbc')}{r.trialDetails?.venue ? ` · ${r.trialDetails.venue}` : ''}</Text>
      <Row><Text style={{ color: colors.accentText, fontSize: 13, fontWeight: '600' }}>{statusWord(r.status)}</Text><DetailLink label={pt('inboxViewTrial')} onPress={onView} /></Row>
    </View>
  );
}

/** A minor's update: the club, the state, and the guardian's note behind the row. */
function ChildDetail({ item, onBack }: { item: ChildInboxItem; onBack: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View testID={`child-detail-${item.id}`}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={pt('chatBack')} testID="detail-back" style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}>
        <Icon name="chevron-left" size={18} color={colors.text} /><Text style={{ color: colors.text, fontSize: 13, fontWeight: '500' }}>{pt('tabUpdates')}</Text>
      </Pressable>
      <View style={[styles.special, item.type === 'trial' && { borderLeftColor: colors.trial, backgroundColor: colors.trialBg }]}>
        <Kicker>{item.type === 'trial' ? pt('inboxTrialInvitation') : pt('inboxContactRequest')}</Kicker>
        <Text role="heading" aria-level={2} style={styles.org}>{item.orgName}</Text>
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{item.status === 'pending' ? pt('inboxWithGuardian') : statusWord(item.status)}</Text>
        <Muted size={13}>{item.note}</Muted>
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  org: { color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  subject: { color: colors.text, fontSize: 15, fontWeight: '600' },
  msg: { color: colors.text, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 10, alignSelf: 'flex-start', minHeight: 40 },
  special: { borderLeftWidth: 3, borderLeftColor: colors.infoInk, backgroundColor: colors.panel2, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16, gap: 6, marginTop: 4 },
  slot: { borderRadius: 10, borderWidth: 1, borderColor: colors.line, paddingVertical: 7, paddingHorizontal: 12 },
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
