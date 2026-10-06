import { GuidanceNote } from '../../components/InformationRows';
// Social inbox: avatar shortcuts, compact previews and tap-to-open messages.
// Request decisions and trial scheduling stay inside the opened conversation.
// Contact, trial, offer and signing retain their distinct routing and permissions.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, TextInput } from '../../components/Text';
import { PlayerScreen as SafeAreaView } from '../../components/Vivid';
import { client } from '../../data/client';
import type { AppNotification, Channel } from '../../data/types';
import type { ChildInboxItem, InboxRequest } from '../../domain/types';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { Button, DetailLink, Disclosure, Kicker, Muted, PreviewRow, Row } from '../../components/ui';
import { pt } from '../../i18n';
import { ColorAvatar } from '../../components/Vivid';
import { ReportButton } from '../../components/ReportSheet';
import { PageHeader } from '../../components/PageChrome';
import { Threads, threadPreview } from '../../components/Threads';
import { AckSection } from '../../components/M13Sections';
import { InvitationCard, InvitationDetail, DateOptions } from '../../components/InvitationCard';
import { TrialSlotChips } from '../../components/M23Trial';
import { Icon } from '../../components/Icon';
import { initialsOf } from '../../components/Reference';
import { fmtClock, fmtShortDay, humanDate, relTime } from '../../time';

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
  const [query, setQuery] = useState('');
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
  const shown = entries.filter((e) => {
    if (!(tab === 'unread' ? isUnread(e) : tab === 'requests' ? isRequest(e) : true)) return false;
    const searchable = e.kind === 'request' ? `${e.req.orgName} ${e.req.scoutName} ${e.req.message ?? ''}` : e.kind === 'thread' ? `${e.channel.orgName} ${threadPreview(e.channel).line}` : e.kind === 'child' ? e.item.orgName : e.note.text;
    return searchable.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
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

  if (openThread && playerId && !request && !child) return <SafeAreaView style={styles.safe} edges={['top']}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID="inbox-thread" style={{ flex: 1, padding: 18 }}>
            <Threads fullHeight
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
          </KeyboardAvoidingView>
</SafeAreaView>;

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

        ) : (
          <>
            <PageHeader title={isMinor ? pt('tabUpdates') : pt('tabInbox')} />
            <View style={styles.search}>
              <Icon name="search" size={21} color={colors.muted} />
              <TextInput accessibilityLabel={pt('inboxSearch')} placeholder={pt('inboxSearch')} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={styles.searchInput} />
              {query ? <Pressable accessibilityRole="button" accessibilityLabel={pt('inboxClearSearch')} onPress={() => setQuery('')} style={styles.clearSearch}><Icon name="x" size={18} color={colors.text} /></Pressable> : null}
            </View>
            {entries.length > 0 && !query.trim() ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 17, paddingVertical: 18 }} accessibilityLabel={pt('inboxShortcuts')}>
              {me && <Pressable accessibilityRole="button" accessibilityLabel={pt('inboxYourProfile')} onPress={() => router.push('/you')} style={styles.shortcut}><ColorAvatar initials={initialsOf(me.name)} size={66} index={0} /><Text numberOfLines={1} style={styles.shortcutName}>{pt('tabYou')}</Text></Pressable>}
              {entries.filter(e => e.kind !== 'event').slice(0, 8).map((e) => { const name = e.kind === 'request' ? e.req.orgName : e.kind === 'thread' ? e.channel.orgName : e.kind === 'child' ? e.item.orgName : ''; return <Pressable key={e.id} accessibilityRole="button" accessibilityLabel={name} onPress={() => openEntry(e)} style={styles.shortcut}><ColorAvatar initials={initialsOf(name)} size={66} index={Array.from(name).reduce((n,c)=>n+c.charCodeAt(0),0)} /><Text numberOfLines={1} style={styles.shortcutName}>{name}</Text></Pressable>; })}
            </ScrollView> : null}
            {!isMinor ? <View role="tablist" aria-label={pt('inboxFilter')} style={styles.filters}>
              {tabs.map((item) => <Pressable key={item.key} role="tab" aria-selected={tab === item.key} onPress={() => setTab(item.key as typeof tab)} style={[styles.filter, tab === item.key && { backgroundColor: colors.tabActiveBg, borderColor: colors.accentText }]}>
                <Text style={{ color: tab === item.key ? colors.accentText : colors.text, fontSize: 13, fontWeight: '600' }}>{item.label}</Text>
              </Pressable>)}
            </View> : null}
            {error ? <Text style={{ color: colors.danger, fontSize: 13, marginTop: 8 }}>{error}</Text> : null}
            <View testID="inbox-list" style={{ paddingHorizontal: 2 }}>
              {shown.length === 0 ? <View style={{ paddingVertical: 24 }}><Muted size={14}>{query.trim() ? pt('inboxNoMatches') : tab === 'unread' ? pt('inboxEmptyUnread') : tab === 'requests' ? pt('inboxEmptyRequests') : pt('inboxEmpty')}</Muted></View> : null}
              {shown.map((e) => {
                if (e.kind === 'request') {
                  const r = e.req; const trial = r.type === 'trial';
                  const when = trial && r.trialDetails?.proposedDate ? humanDate(r.trialDetails.proposedDate) : null;
                  const line = r.status === 'pending' ? (trial ? `${pt('inboxTrialInvitation')}${when ? ` · ${when}` : ''}` : pt('inboxWantsContact')) : `${trial ? pt('inboxTrialInvitation') : pt('inboxContactRequest')} · ${statusWord(r.status)}`;
                  return <PreviewRow key={e.id} initials={initialsOf(r.orgName)} title={r.orgName} line={r.message || line} time={relTime(e.ts)} unread={r.status === 'pending'} accent={trial ? 'trial' : r.status === 'pending' ? 'request' : null} accentLabel={[trial ? pt('inboxTrialLabel') : pt('inboxRequestLabel'), statusWord(r.status)].filter(Boolean).join(' · ')} onPress={() => openEntry(e)} testID={`inbox-request-${r.id}`} />;
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
                return <PreviewRow key={e.id} initials={initialsOf(it.orgName)} title={it.orgName} line={it.status === 'pending' ? pt('inboxWithGuardian') : [statusWord(it.status), pt('inboxGuardianManaged')].filter(Boolean).join(' · ')} unread={it.status === 'pending'} accent={it.type === 'trial' ? 'trial' : null} accentLabel={it.type === 'trial' ? pt('inboxTrialLabel') : undefined} onPress={() => openEntry(e)} testID={`inbox-child-${it.id}`} />;
              })}
            </View>
            <Disclosure label={isMinor ? pt('inboxMinorLine') : pt('inboxSafety')} testID="inbox-safety">
              <GuidanceNote size={13}>{isMinor ? pt('inboxMinorFull') : pt('inboxSafetyFull')}</GuidanceNote>
            </Disclosure>
            {playerId ? <AckSection actor={{ kind: 'player', id: playerId }} /> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A request opens as a message, with its existing decision and scheduling controls below. */
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
      <View style={styles.conversationHeader}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={pt('chatBack')} testID="detail-back" style={styles.backCircle}>
          <Icon name="chevron-left" size={22} color={colors.text} />
        </Pressable>
        <ColorAvatar initials={initialsOf(r.orgName)} size={44} index={1} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text role="heading" aria-level={2} style={styles.org}>{r.orgName}</Text>
          <Muted size={12}>{r.scoutName}{r.scoutRole ? ` · ${r.scoutRole}` : ''}</Muted>
        </View>
        <ReportButton />
      </View>
      <View style={styles.safetyLine}><Icon name="shield-check" size={14} color={colors.safetyText} /><Text style={{ color: colors.safetyText, fontSize: 11 }}>{pt('chatSafetyLine')}</Text></View>
      <Text style={styles.date}>{fmtShortDay(r.createdAt)}</Text>
      <View style={styles.messageRow} testID={`req-details-${r.id}`}>
        <ColorAvatar initials={initialsOf(r.orgName)} size={28} index={1} />
        <View style={styles.messageBubble}>
          {r.subject ? <Text style={styles.subject} testID={`req-subject-${r.id}`}>{r.subject}</Text> : null}
          {r.message ? <Text style={styles.msg} testID={`req-message-${r.id}`}>{r.message}</Text> : null}
          <Text style={styles.messageTime}>{fmtClock(r.createdAt)}</Text>
        </View>
      </View>
      <InvitationCard title={trial ? pt('inboxTrialInvitation') : pt('inboxContactRequest')} subtitle={r.orgName} icon="message-circle" date={trial ? (pending ? slot : r.trialDetails?.proposedDate) ?? null : undefined} venue={trial ? r.trialDetails?.venue : undefined} badge={[r.orgVerified ? pt('inboxVerifiedClub') : null, r.trustedPartner ? pt('inboxTrustedPartner') : null].filter(Boolean).join(' · ')} testID={trial ? 'trial-card' : 'contact-card'} actions={
        <>
          {pending && trial && slots.length > 0 ? <TrialSlotChips slots={slots} chosenDay={slot ?? r.trialDetails?.proposedDate ?? ''} onPick={setSlot} /> : null}
          {pending && trial && slots.length === 0 && altSlots.length > 0 ? <DateOptions days={[r.trialDetails?.proposedDate, ...altSlots].filter((s): s is string => !!s)} selected={slot} onSelect={setSlot} /> : null}
          {pending ? <Row>
            <Button grow primary disabled={busy} label={pt('accept')} onPress={() => void answer(true)} testID={`req-accept-${r.id}`} />
            <Button grow disabled={busy} label={pt('decline')} onPress={() => void answer(false)} testID={`req-decline-${r.id}`} />
          </Row> : <Row>
            <Text style={{ color: r.status === 'accepted' ? colors.accentText : colors.danger, fontSize: 14, fontWeight: '600' }} testID={`req-status-${r.id}`}>{statusWord(r.status)}</Text>
            {r.status === 'accepted' && trial ? <DetailLink label={pt('inboxViewTrial')} onPress={() => router.push('/opportunities?cat=trial&tab=schedule')} testID="req-view-trial" /> : null}
            {r.status === 'accepted' && !trial && thread ? <DetailLink label={pt('inboxOpenConversation')} onPress={() => onOpenThread(thread.id)} testID="req-open-thread" /> : null}
          </Row>}
          {error ? <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text> : null}
        </>
      }>
        {trial && r.trialDetails?.notes ? <InvitationDetail icon="clipboard-list" title={pt('invBeforeArrival')}>{r.trialDetails.notes}</InvitationDetail> : null}
        {trial ? <InvitationDetail icon="file-check-2" title={pt('invReport')}>{pt('invReportSummary')}</InvitationDetail> : null}
        {pending && !trial ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.label} nativeID={`reply-label-${r.id}`}>{pt('inboxAddReply')}</Text>
            <TextInput style={styles.input} testID={`req-reply-${r.id}`} accessibilityLabel={pt('ctReply')} accessibilityLabelledBy={`reply-label-${r.id}`} placeholder={pt('ctReplyHint')} placeholderTextColor={colors.muted} value={reply} onChangeText={(v) => setReply(v.slice(0, 500))} multiline maxLength={500} />
            <Muted size={12}>{pt('ctReplyNote')}</Muted>
          </View>
        ) : null}
      </InvitationCard>

    </View>
  );
}

/** The trial object at the head of an accepted trial's thread: short, special, one link to the trial itself. */
function TrialCard({ r, onView }: { r: InboxRequest; onView: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <InvitationCard title={pt('inboxTrialInvitation')} subtitle={r.orgName} date={r.trialDetails?.proposedDate ?? null} venue={r.trialDetails?.venue} testID="thread-trial-card" actions={<Row><Text style={{ color: colors.accentText, fontSize: 13, fontWeight: '600' }}>{statusWord(r.status)}</Text><DetailLink label={pt('inboxViewTrial')} onPress={onView} /></Row>} />
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
      <View style={styles.conversationHeader}><ColorAvatar initials={initialsOf(item.orgName)} size={44} index={1} /><Text role="heading" aria-level={2} style={[styles.org, { flex: 1 }]}>{item.orgName}</Text><ReportButton /></View>
      <View style={styles.special}>
        <Kicker>{item.type === 'trial' ? pt('inboxTrialInvitation') : pt('inboxContactRequest')}</Kicker>
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{item.status === 'pending' ? pt('inboxWithGuardian') : statusWord(item.status)}</Text>
        <Muted size={12}>{pt('inboxGuardianManaged')}</Muted>
      </View>
      <View style={[styles.messageRow, { marginTop: 18 }]}><ColorAvatar initials={initialsOf(item.orgName)} size={28} index={1} /><View style={styles.messageBubble}><Text style={styles.msg}>{item.note}</Text></View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  shortcut: { alignItems: 'center', width: 70, gap: 8 },
  shortcutName: { color: colors.muted, fontSize: 11, width: 70, textAlign: 'center' },
  conversationHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  backCircle: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: colors.panel2 },
  safetyLine: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8 },
  date: { textAlign: 'center', color: colors.muted, fontSize: 11, marginVertical: 22 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  messageBubble: { flexShrink: 1, maxWidth: '86%', borderRadius: 22, borderBottomLeftRadius: 7, padding: 15, gap: 6, backgroundColor: colors.panel2 },
  messageTime: { color: colors.muted, fontSize: 10, alignSelf: 'flex-end', marginTop: 3 },
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 26, paddingLeft: 14, paddingRight: 6, minHeight: 48, marginTop: 0, marginBottom: 6 },
  searchInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, paddingVertical: 12 },
  clearSearch: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  filters: { flexDirection: 'row', gap: 8, marginTop: 2, marginBottom: 10 },
  filter: { alignItems: 'center', minHeight: 40, paddingHorizontal: 17, paddingVertical: 9, borderRadius: 22, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  org: { color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  subject: { color: colors.text, fontSize: 15, fontWeight: '600' },
  msg: { color: colors.text, fontSize: 15, lineHeight: 22 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 10, alignSelf: 'flex-start', minHeight: 40 },
  // Workflow details remain distinct from the conversational message bubble.
  special: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, padding: 16, borderRadius: 20, gap: 10, marginTop: 18 },
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
