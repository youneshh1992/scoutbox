import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { pt } from '../../i18n';
import { PopupBanner } from '../../components/PopupBanner';

// M23 P2.5 — five destinations. Home / Football / Opportunities / Inbox / You.
// Profile and Upload keep their routes (deep links, back navigation, tests)
// but no longer occupy a bar slot: Profile is the first page tab of You, and
// Upload is the "+ Add evidence" action on Football. Icons are glyphs with
// a meaning rather than abstract shapes.
type TabDef = { name: string; titleKey: 'tabHome' | 'tabFootball' | 'tabOpportunities' | 'tabInbox' | 'tabYou' | 'tabProfile' | 'tabUpload'; icon: string; hidden?: boolean };
const TABS: readonly TabDef[] = [
  { name: 'discover', titleKey: 'tabHome', icon: '⌂' },
  { name: 'football', titleKey: 'tabFootball', icon: '⚽' },
  { name: 'opportunities', titleKey: 'tabOpportunities', icon: '◎' },
  { name: 'inbox', titleKey: 'tabInbox', icon: '✉' },
  { name: 'you', titleKey: 'tabYou', icon: '●' },
  { name: 'profile', titleKey: 'tabProfile', icon: '♟', hidden: true },
  { name: 'upload', titleKey: 'tabUpload', icon: '⬆', hidden: true },
];

export default function TabsLayout() {
  const { playerId, inbox, unreadMessages, liveConnected, mode, isMinor } = useSession();
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
              title: t.name === 'inbox' && isMinor ? pt('tabUpdates') : pt(t.titleKey),
              tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>{t.icon}</Text>,
              ...(t.hidden ? { href: null } : {}),
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
