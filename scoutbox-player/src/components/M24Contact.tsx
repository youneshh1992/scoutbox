// M24B — the Club contact and Trial › Invitation views: the person's own
// requests and threads, read from the session's inbox and channels exactly as
// the Inbox tab shows them. Answering stays in the Inbox — the one place the
// safeguarding wording and the slot picker live — so nothing is duplicated
// and nothing reaches the person from here that did not already.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from './Text';
import { client } from '../data/client';
import type { Channel } from '../data/types';
import type { ChildInboxItem, InboxRequest } from '../domain/types';
import { useSession } from '../state';
import { useColors } from '../theme';
import { pt } from '../i18n';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { relTime, uiLocale } from '../time';

const isChild = (r: InboxRequest | ChildInboxItem): r is ChildInboxItem => 'guardianManaged' in r && r.guardianManaged === true;

export function ContactRequestsSection({ kind }: { kind: 'contact' | 'trial' }) {
  const colors = useColors();
  const router = useRouter();
  const { inbox } = useSession();
  const rows = inbox.filter((r) => (isChild(r) ? kind === 'contact' : r.type === kind));
  const title = kind === 'trial' ? pt('ctxTrialReqTitle') : pt('ctxRequestsTitle');
  return (
    <Card testID={`requests-${kind}`}>
      <SectionTitle>{title}</SectionTitle>
      <Muted size={12.5}>{pt('ctxAnswerInInbox')}</Muted>
      {rows.length === 0 && <View style={{ marginTop: 6 }}><Muted size={12.5}>{kind === 'trial' ? pt('ctxTrialReqNone') : pt('ctxRequestsNone')}</Muted></View>}
      {rows.map((r) => (
        <View key={r.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 4 }} testID={`request-${r.id}`}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{r.orgName}</Text>
            <Pill label={isChild(r) && r.status === 'pending' ? pt('ctxWithGuardian') : ({ pending: pt('ctxAwaitingYou'), accepted: pt('inboxAccepted'), declined: pt('inboxDeclined'), suspended: pt('inboxSuspended') } as Record<string, string>)[r.status] ?? r.status} tone={r.status === 'accepted' ? 'green' : r.status === 'declined' ? 'red' : 'gold'} />
          </Row>
          {!isChild(r) && <Muted size={12.5}>{r.scoutName}{r.scoutRole ? ` (${r.scoutRole})` : ''} · {new Date(r.createdAt).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}</Muted>}
          {!isChild(r) && r.subject ? <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>{r.subject}</Text> : null}
          {isChild(r) ? <Muted size={12.5}>{r.note}</Muted> : null}
        </View>
      ))}
      <Row style={{ marginTop: 10 }}>
        <Button small primary label={pt('ctxOpenInbox')} onPress={() => router.push('/(tabs)/inbox' as never)} testID={`open-inbox-${kind}`} />
      </Row>
    </Card>
  );
}

export function MessagesSummarySection() {
  const colors = useColors();
  const router = useRouter();
  const { playerId, isMinor, inbox, notifications } = useSession();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  useEffect(() => {
    let on = true;
    if (playerId && !isMinor) client.getChannels(playerId).then((c) => on && setChannels(c)).catch(() => on && setChannels([]));
    else setChannels([]);
    return () => { on = false; };
  }, [playerId, isMinor, inbox, notifications]);
  return (
    <Card testID="messages-summary">
      <SectionTitle>{pt('ctxMessagesTitle')}</SectionTitle>
      {isMinor ? <Muted size={12.5}>{pt('ctxMinorMessages')}</Muted> : (
        <>
          {channels && channels.length === 0 && <Muted size={12.5}>{pt('ctxMessagesNone')}</Muted>}
          {(channels ?? []).map((c) => {
            const last = c.messages[c.messages.length - 1];
            return (
              <View key={c.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 2 }} testID={`thread-${c.id}`}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{c.orgName}</Text>
                  <Muted size={12}>{c.messages.length} {pt('ctxMessagesCount')}</Muted>
                </Row>
                <Muted size={12.5}>{c.scoutName}{last ? ` · ${relTime(last.ts)}` : ''}</Muted>
              </View>
            );
          })}
        </>
      )}
      <Row style={{ marginTop: 10 }}>
        <Button small primary label={pt('ctxOpenInbox')} onPress={() => router.push('/(tabs)/inbox' as never)} testID="open-inbox-messages" />
      </Row>
    </Card>
  );
}
