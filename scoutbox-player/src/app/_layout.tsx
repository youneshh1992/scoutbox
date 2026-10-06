import { Component, type ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Asset } from 'expo-asset';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../state';
import { palettes, ThemeProvider, useTheme } from '../theme';
import { Text, FONT_FILES, WEB_UI_FONT } from '../components/Text';
import { MobileViewport } from '../components/MobileViewport';

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
      {/* M24C — every route, its header and its bottom navigation render
          inside the phone viewport; a wide browser only adds the surround. */}
      <MobileViewport>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </MobileViewport>
    </>
  );
}

// Only the permanent wordmark is bundled; UI typography comes from the OS.
let webFacesRegistered = false;
function registerWebFaces() {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || webFacesRegistered) return;
  webFacesRegistered = true;
  const uri = (mod: number) => Asset.fromModule(mod).uri;
  const css = `
@font-face { font-family: 'AlbertSans-ExtraBold'; font-style: normal; font-weight: 800; font-display: swap; src: url("${uri(FONT_FILES['AlbertSans-ExtraBold'])}") format('truetype'); }
html, body, input, textarea, button { font-family: ${WEB_UI_FONT}; font-optical-sizing: auto; }`;
  const style = document.createElement('style');
  style.setAttribute('data-sb-fonts', 'system-ui');
  style.textContent = css;
  document.head.appendChild(style);
}
registerWebFaces();

export default function RootLayout() {
  // Native only needs to load the unchanged wordmark face.
  const [fontsReady] = useFonts(Platform.OS === 'web' ? {} : FONT_FILES);
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
