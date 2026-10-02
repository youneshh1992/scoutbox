// M24C — ScoutBox Player is a phone application on every surface.
//
// On iOS and Android this wrapper is transparent. On the web it is the one
// place the application's width is decided: the whole app — header, content
// column and bottom navigation — lives in a centred column of at most
// MOBILE_VIEWPORT_MAX px, on a quiet surround, so a wide desktop browser shows
// the same single phone screen a 390px window does. No breakpoint anywhere
// else may change the structure; the frame is the only thing a wide window
// adds, and the screen inside it is never scaled.
import { useEffect, type ReactNode } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { usePathname } from 'expo-router';
import { AUTH_PAGE, useColors } from '../theme';

export const MOBILE_VIEWPORT_MAX = 430;

export function MobileViewport({ children }: { children: ReactNode }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  // M24E — the entry screen has ONE appearance: around it the surround is the
  // entry page's own green, never the light or dark frame the person saved.
  const pathname = usePathname();
  const onAuth = pathname === '/onboarding';
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.body.style.backgroundColor = onAuth ? AUTH_PAGE.page : colors.frame;
  }, [onAuth, colors.frame]);
  if (Platform.OS !== 'web') return <>{children}</>;
  const framed = width > MOBILE_VIEWPORT_MAX;
  return (
    <View style={[styles.surround, { backgroundColor: onAuth ? AUTH_PAGE.page : colors.frame }]} testID="mobile-viewport-surround" data-auth-fixed={onAuth ? '1' : undefined}>
      <View
        testID="mobile-viewport"
        style={[styles.frame, { backgroundColor: onAuth ? AUTH_PAGE.page : colors.bg }, framed && { borderLeftWidth: 1, borderRightWidth: 1, borderColor: onAuth ? AUTH_PAGE.panelLine : colors.frameLine }]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surround: { flex: 1, width: '100%', alignItems: 'center' },
  frame: { flex: 1, width: '100%', maxWidth: MOBILE_VIEWPORT_MAX, overflow: 'hidden' },
});
