// Inline video playback. On web (where the demos and expo web run) this
// renders a real <video> element; on native it shows a placeholder note —
// production wires expo-av here.

import { createElement } from 'react';
import { Platform, Text, View } from 'react-native';
import { colors } from '../theme';

export function WebVideo({ src }: { src: string }) {
  if (Platform.OS === 'web') {
    return createElement('video', {
      src,
      controls: true,
      preload: 'metadata',
      style: { width: '100%', maxHeight: 260, borderRadius: 10, background: '#000' },
    });
  }
  return (
    <View style={{ padding: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 10 }}>
      <Text style={{ color: colors.muted, fontSize: 12.5 }}>▶ Video available — playback on web (native playback ships with expo-av).</Text>
    </View>
  );
}
