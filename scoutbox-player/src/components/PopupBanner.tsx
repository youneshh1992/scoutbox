// Transient in-app notification pop-up — slides in at the top of the screen
// the moment a new message/request/update arrives, on every screen.

import { Pressable, StyleSheet } from 'react-native';
import { useSession } from '../state';
import { Text } from './Text';
import { useStyles, type Palette } from '../theme';

export function PopupBanner() {
  const { popup, dismissPopup } = useSession();
  const styles = useStyles(makeStyles);
  if (!popup) return null;
  return (
    <Pressable style={styles.banner} onPress={dismissPopup} accessibilityLabel="Dismiss notification">
      <Text style={styles.text}>{popup}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 100,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderLeftColor: colors.accent,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  text: { color: colors.text, fontSize: 13.5, lineHeight: 19 },
});
