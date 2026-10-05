// M24A — the appearance control from the reference phone header: a switch
// whose "on" state is dark. Announced as a switch with its state on every
// platform; on the web it is a real button, so Space/Enter operate it.
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { useTheme } from '../theme';
import { pt } from '../i18n';

export function ThemeSwitch() {
  const { scheme, colors, toggle } = useTheme();
  const dark = scheme === 'dark';
  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: dark }}
      accessibilityLabel={pt('themeAria')}
      testID="theme-switch"
      style={({ pressed }) => [styles.btn, { backgroundColor: colors.bg2, borderColor: colors.line }, pressed && { opacity: 0.8 }]}
    >
      <Icon name={dark ? 'moon' : 'sun'} size={22} color={colors.iconFg} />

    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 22 },
  track: { width: 27, height: 16, padding: 2, borderRadius: 12 },
  knob: { width: 12, height: 12, borderRadius: 6, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } },
});
