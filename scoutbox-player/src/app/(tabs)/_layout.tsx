import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { PopupBanner } from '../../components/PopupBanner';

const TABS = [
  { name: 'discover', title: 'Home', icon: '◎' },
  { name: 'inbox', title: 'Inbox', icon: '▤' },
  { name: 'profile', title: 'Profile', icon: '♟' },
  { name: 'upload', title: 'Upload', icon: '⬆' },
  { name: 'you', title: 'You', icon: '●' },
] as const;

export default function TabsLayout() {
  const { playerId, inbox, unreadMessages, liveConnected, mode } = useSession();
  if (!playerId) return <Redirect href="/onboarding" />;
  const pending = inbox.filter((r) => r.status === 'pending').length;
  // Red indicator: pending requests + unread club messages.
  const inboxBadge = pending + unreadMessages;

  return (
    <View style={{ flex: 1 }}>
      <PopupBanner />
      {mode === 'live' && !liveConnected && (
        <View style={{ backgroundColor: '#3a1f27', paddingVertical: 4, alignItems: 'center' }}>
          <Text style={{ color: colors.danger, fontSize: 12 }}>○ reconnecting — updates resume automatically</Text>
        </View>
      )}
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.bg },
          tabBarStyle: { backgroundColor: colors.bg2, borderTopColor: colors.line },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.muted,
        }}
      >
        {TABS.map((t) => (
          <Tabs.Screen
            key={t.name}
            name={t.name}
            options={{
              title: t.title,
              tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>{t.icon}</Text>,
              ...(t.name === 'inbox' && inboxBadge > 0
                ? { tabBarBadge: inboxBadge, tabBarBadgeStyle: { backgroundColor: colors.danger, color: '#fff' } }
                : {}),
            }}
          />
        ))}
      </Tabs>
    </View>
  );
}
