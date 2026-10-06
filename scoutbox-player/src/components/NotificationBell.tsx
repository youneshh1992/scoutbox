import { relTime } from '../time';
import { useState } from 'react';
import { playerCategoryFor } from '../caseNav';
import { useRouter } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { NotificationTarget } from '../data/types';
import { useSession } from '../state';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors, useStyles, type Palette } from '../theme';
import { Button, Card, Muted, Row } from './ui';

export function NotificationBell() {
  const { notifications, unread, markNotificationsRead, guardianId } = useSession();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const colors = useColors();
  const styles = useStyles(makeStyles);
  // M23 P8 §30 — a row whose server-resolved target is current opens the
  // screen that holds it: a contact or trial invitation lives in the Inbox,
  // a trial schedule, an Offer or a signing on Opportunities (the guardian
  // page for a guardian). A row with no target stays plain text.
  const destinationFor = (target: NotificationTarget | null | undefined): string | null => {
    if (!target) return null;
    if (guardianId) return target.kind === 'inbox' || target.kind === 'trial' || target.kind === 'offer' ? '/guardian' : null;
    if (target.kind === 'inbox') return '/(tabs)/inbox';
    // M24B — the category of Opportunities that holds the record (Trial / Offer / Signing).
    if (target.kind === 'trial' || target.kind === 'offer' || target.kind === 'signing') return `/(tabs)/opportunities?cat=${playerCategoryFor(target.kind)}`;
    return null;
  };

  const openPanel = () => {
    setOpen(true);
    if (unread > 0) void markNotificationsRead();
  };

  return (
    <>
      {/* M24A — the reference bell: a round hairline button with a green dot while something is unread. */}
      <Pressable onPress={openPanel} style={styles.bell} accessibilityRole="button" accessibilityLabel="Notifications" accessibilityValue={unread > 0 ? { text: `${unread} unread` } : undefined}>
        <Icon name="bell" size={22} color={colors.gold} />
        {unread > 0 && <View style={styles.dot} accessibilityElementsHidden />}
      </Pressable>
      {open && (
        <Modal transparent animationType="slide" onRequestClose={() => setOpen(false)}>
          <View style={styles.veil}>
            <View style={styles.sheet}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: 'center', marginBottom: 18 }} />
              <Row style={{ justifyContent: 'space-between', marginBottom: 20 }}>
                <Text style={styles.title}>Notifications</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setOpen(false)} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel2 }}><Icon name="x" size={21} color={colors.text} /></Pressable>
              </Row>
              <ScrollView contentContainerStyle={{ gap: 8 }}>
                {notifications.length === 0 && (
                  <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 24, gap: 12 }}>
                    <View style={{ width: 70, height: 70, borderRadius: 35, backgroundColor: colors.greenBg, alignItems: 'center', justifyContent: 'center', marginBottom: 5 }}><Icon name="bell" size={33} color={colors.accentText} /></View>
                    <Text style={{ color: colors.text, fontSize: 20, fontWeight: '600' }}>You’re all caught up</Text>
                    <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 21, textAlign: 'center' }}>Your club updates and account activity will appear here.</Text>
                  </View>
                )}
                {notifications.slice(0, 30).map((n) => {
                  const dest = destinationFor(n.target);
                  return (
                    <Pressable key={n.id} disabled={!dest} accessibilityRole={dest ? 'button' : undefined} accessibilityLabel={dest ? `Open notification: ${n.text}` : undefined} testID={dest ? 'notification-open' : undefined} onPress={() => { if (dest) { setOpen(false); router.push(dest as never); } }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: colors.line, opacity: pressed ? 0.7 : 1 })}>
                      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.greenBg }}><Icon name={n.target?.kind === 'inbox' ? 'chat-bubble' : n.target?.kind === 'trial' ? 'calendar-days' : n.target?.kind === 'offer' ? 'file-text' : n.target?.kind === 'signing' ? 'file-check-2' : 'bell'} size={20} color={colors.accentText} /></View>
                      <View style={{ flex: 1, gap: 7 }}><Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 20 }}>{n.text}</Text><Muted size={11.5}>{relTime(n.ts)}</Muted></View>
                      {dest && <Icon name="chevron-right" size={17} color={colors.muted} />}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  bell: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 0,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { position: 'absolute', top: 7, right: 8, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  veil: { flex: 1, backgroundColor: colors.veil, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 0,
    borderColor: colors.line,
    padding: 22,
    maxHeight: '80%',
    // M24C — the sheet keeps the phone's width even when a wide browser
    // hosts the viewport (a Modal renders outside the frame on the web).
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '600', letterSpacing: -0.45 },
});
