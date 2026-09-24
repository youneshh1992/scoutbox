import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NotificationTarget } from '../data/types';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Row } from './ui';

export function NotificationBell() {
  const { notifications, unread, markNotificationsRead, guardianId } = useSession();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  // M23 P8 §30 — a row whose server-resolved target is current opens the
  // screen that holds it: a contact or trial invitation lives in the Inbox,
  // a trial schedule, an Offer or a signing on Opportunities (the guardian
  // page for a guardian). A row with no target stays plain text.
  const destinationFor = (target: NotificationTarget | null | undefined): string | null => {
    if (!target) return null;
    if (guardianId) return target.kind === 'inbox' || target.kind === 'trial' || target.kind === 'offer' ? '/guardian' : null;
    if (target.kind === 'inbox') return '/(tabs)/inbox';
    if (target.kind === 'trial' || target.kind === 'offer' || target.kind === 'signing') return '/(tabs)/opportunities';
    return null;
  };

  const openPanel = () => {
    setOpen(true);
    if (unread > 0) void markNotificationsRead();
  };

  return (
    <>
      <Pressable onPress={openPanel} style={styles.bell} accessibilityLabel="Notifications">
        <Text style={{ fontSize: 15 }}>🔔</Text>
        {unread > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread}</Text>
          </View>
        )}
      </Pressable>
      {open && (
        <Modal transparent animationType="slide" onRequestClose={() => setOpen(false)}>
          <View style={styles.veil}>
            <View style={styles.sheet}>
              <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={styles.title}>Notifications</Text>
                <Button small label="Close" onPress={() => setOpen(false)} />
              </Row>
              <ScrollView contentContainerStyle={{ gap: 8 }}>
                {notifications.length === 0 && (
                  <Card>
                    <Muted size={13.5}>Nothing yet — you&apos;ll hear the moment something happens.</Muted>
                  </Card>
                )}
                {notifications.slice(0, 30).map((n) => {
                  const dest = destinationFor(n.target);
                  return (
                    <Card key={n.id}>
                      <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 19 }}>{n.text}</Text>
                      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <Muted size={11.5}>{new Date(n.ts).toLocaleString()}</Muted>
                        {dest ? <Button small label="Open" onPress={() => { setOpen(false); router.push(dest as never); }} /> : null}
                      </Row>
                    </Card>
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

const styles = StyleSheet.create({
  bell: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: colors.danger,
    borderRadius: 999,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  veil: { flex: 1, backgroundColor: 'rgba(3,8,18,0.7)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg2,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
    maxHeight: '80%',
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
});
