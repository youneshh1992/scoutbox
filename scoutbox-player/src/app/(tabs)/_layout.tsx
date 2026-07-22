import { Redirect, Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSession } from '../../state';
import { colors } from '../../theme';

const TABS = [
  { name: 'discover', title: 'Discover', icon: '◎' },
  { name: 'inbox', title: 'Inbox', icon: '▤' },
  { name: 'profile', title: 'Profile', icon: '♟' },
  { name: 'upload', title: 'Upload', icon: '⬆' },
  { name: 'you', title: 'You', icon: '●' },
] as const;

export default function TabsLayout() {
  const { playerId } = useSession();
  if (!playerId) return <Redirect href="/onboarding" />;

  return (
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
          }}
        />
      ))}
    </Tabs>
  );
}
