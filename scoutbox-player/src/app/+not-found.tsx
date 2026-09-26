// PRE-M24 (PM-6): an outdated or mistyped link lands here instead of the
// Expo developer page ("Unmatched Route", English only, with a link to the
// /_sitemap route list). Nothing is changed; the reader gets a way home.
import { useRouter } from 'expo-router';
import { SafeAreaView, Text, View } from 'react-native';
import { Button, Card, Muted } from '../components/ui';
import { pt } from '../i18n';
import { colors } from '../theme';

export default function NotFound() {
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 16 }}>
        <Card testID="not-found">
          <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6 }}>{pt('notFoundTitle')}</Text>
          <Muted>{pt('notFoundBody')}</Muted>
          <View style={{ marginTop: 12 }}>
            <Button primary label={pt('notFoundHome')} onPress={() => router.replace('/')} testID="not-found-home" />
          </View>
        </Card>
      </View>
    </SafeAreaView>
  );
}
