import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../state';
import { colors } from '../theme';

// Root error boundary: a runtime failure renders a recoverable screen, never
// a silent white page. Server data is untouched — reloading is always safe.
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 }}>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>Something broke in the app</Text>
          <Text style={{ color: colors.muted, fontSize: 13.5, textAlign: 'center' }}>
            The error was contained — your profile and messages live on the server and nothing was lost.
          </Text>
          <Text style={{ color: colors.danger, fontSize: 12 }}>{String(this.state.error)}</Text>
          <Pressable
            onPress={() => {
              this.setState({ error: null });
              if (typeof location !== 'undefined') location.reload();
            }}
            style={{ backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 }}
          >
            <Text style={{ color: '#04240f', fontWeight: '700' }}>Reload</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Boundary>
        <SessionProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          />
        </SessionProvider>
      </Boundary>
    </SafeAreaProvider>
  );
}
