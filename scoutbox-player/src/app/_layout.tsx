import { Component, type ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../state';
import { palettes, ThemeProvider, useTheme } from '../theme';
import { Text, FONT_FILES } from '../components/Text';

// Root error boundary: a runtime failure renders a recoverable screen, never
// a silent white page. Server data is untouched — reloading is always safe.
// (A class component cannot read the theme hook; the light palette is a safe
// fallback for a screen that exists only to recover.)
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      const colors = palettes.light;
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
            <Text style={{ color: colors.accentInk, fontWeight: '700' }}>Reload</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

/** Inside the theme: the status bar and the navigator background follow the appearance. */
function Themed() {
  const { scheme, colors } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  // M24A — Albert Sans (bundled, SIL OFL). On iOS and Android the faces must
  // be registered before any text draws; on the web the browser swaps them
  // in as they load, so the first paint is never blocked.
  const [fontsReady] = useFonts(FONT_FILES);
  if (!fontsReady && Platform.OS !== 'web') return null;
  return (
    <SafeAreaProvider>
      <Boundary>
        <ThemeProvider>
          <SessionProvider>
            <Themed />
          </SessionProvider>
        </ThemeProvider>
      </Boundary>
    </SafeAreaProvider>
  );
}
