import { Redirect, Tabs } from 'expo-router';
import { View } from 'react-native';
import { useSession } from '../../state';
import { useColors, useTheme } from '../../theme';
import { pt } from '../../i18n';
import { Text } from '../../components/Text';
import { Gradient } from '../../components/Vivid';
import { Icon } from '../../components/Icon';
import { PopupBanner } from '../../components/PopupBanner';

// M23 P2.5 — five destinations. Home / Football / Opportunities / Inbox / You.
// Profile and Upload keep their routes (deep links, back navigation, tests)
// but no longer occupy a bar slot: Profile is the first page tab of You, and
// Upload is the "+ Add evidence" action on Football.
// M24A — the Player navigation: Phosphor icons over 11px labels, the
// active destination on a soft green pill.
type TabDef = { name: string; titleKey: 'tabHome' | 'tabFootball' | 'tabOpportunities' | 'tabInbox' | 'tabYou' | 'tabProfile' | 'tabUpload'; icon: string; hidden?: boolean };
const TABS: readonly TabDef[] = [
  { name: 'discover', titleKey: 'tabHome', icon: 'house' },
  { name: 'football', titleKey: 'tabFootball', icon: 'soccer-ball' },
  { name: 'opportunities', titleKey: 'tabOpportunities', icon: 'compass' },
  { name: 'inbox', titleKey: 'tabInbox', icon: 'chat-bubble' },
  { name: 'you', titleKey: 'tabYou', icon: 'user-round' },
  { name: 'profile', titleKey: 'tabProfile', icon: 'user-round', hidden: true },
  { name: 'upload', titleKey: 'tabUpload', icon: 'upload', hidden: true },
];

function TabItem({ icon, label, focused, badge }: { icon: string; label: string; focused: boolean; badge: number }) {
  const colors = useColors();
  const { scheme } = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 6, minHeight: 43, minWidth: 58, borderRadius: 9 }}>
      <View style={{ width: 48, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: focused && icon !== 'chat-bubble' ? (scheme === 'light' ? colors.bg2 : colors.tabActiveBg) : 'transparent' }}>
        {focused && icon !== 'chat-bubble' && <Gradient radius={16} control />}<View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} active={focused} size={icon === 'chat-bubble' ? 29 : 25} color={icon === 'chat-bubble' ? colors.text : focused ? colors.gradientInk : colors.tabInactive} />
        {badge > 0 && (
          <View style={{ position: 'absolute', zIndex: 2, top: -5, right: -7, minWidth: 19, height: 19, borderRadius: 10, paddingHorizontal: 4, backgroundColor: '#dc1748', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '700' }}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}</View>
      </View>
      <Text style={{ color: focused ? colors.tabActive : colors.tabInactive, fontSize: 11, fontWeight: focused ? '600' : '500' }}>{label}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const { playerId, inbox, unreadMessages, liveConnected, mode, isMinor } = useSession();
  const colors = useColors();
  if (!playerId) return <Redirect href="/onboarding" />;
  const pending = inbox.filter((r) => r.status === 'pending').length;
  // Indicator: pending requests + unread club messages.
  const inboxBadge = pending + unreadMessages;

  return (
    <View style={{ flex: 1 }}>
      <PopupBanner />
      {mode === 'live' && !liveConnected && (
        <View style={{ backgroundColor: colors.dangerBg, paddingVertical: 4, alignItems: 'center' }}>
          <Text style={{ color: colors.dangerInk, fontSize: 12 }}>Reconnecting — updates resume automatically</Text>
        </View>
      )}
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.bg },
          tabBarStyle: { backgroundColor: colors.bg2, borderTopColor: colors.line, borderTopWidth: 1, height: 82, paddingTop: 9, paddingBottom: 15, paddingHorizontal: 10 },
          tabBarItemStyle: { paddingVertical: 0 },
          tabBarShowLabel: false,
          tabBarActiveTintColor: colors.tabActive,
          tabBarInactiveTintColor: colors.tabInactive,
        }}
      >
        {TABS.map((t) => {
          const label = t.name === 'inbox' && isMinor ? pt('tabUpdates') : pt(t.titleKey);
          return (
            <Tabs.Screen
              key={t.name}
              name={t.name}
              options={{
                title: label,
                tabBarAccessibilityLabel: t.name === 'inbox' && inboxBadge > 0 ? `${label}, ${inboxBadge}` : label,
                tabBarIcon: ({ focused }) => <TabItem icon={t.icon} label={label} focused={focused} badge={t.name === 'inbox' ? inboxBadge : 0} />,
                ...(t.hidden ? { href: null } : {}),
              }}
            />
          );
        })}
      </Tabs>
    </View>
  );
}
