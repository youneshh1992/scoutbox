// Player uses the platform system UI: SF Pro on Apple, native sans elsewhere.
// Apple fonts are supplied by the OS, never bundled or fetched at runtime.
// The permanent ScoutBox wordmark retains its original Albert Sans face.
import { forwardRef } from 'react';
import { Platform, StyleSheet, Text as RNText, TextInput as RNTextInput, type StyleProp, type TextInputProps, type TextProps, type TextStyle } from 'react-native';

export const FONT_FILES = {
  'AlbertSans-ExtraBold': require('../../assets/fonts/AlbertSans-ExtraBold.ttf'),
};

export const BRAND_FONT = 'AlbertSans-ExtraBold';
export const WEB_UI_FONT = '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif';
export const UI_FONT = Platform.OS === 'web' ? WEB_UI_FONT : Platform.OS === 'ios' ? 'System' : 'sans-serif';

/** Apply the same family to all Player text and inputs; preserve weight/italic. */
export function withFont(style: StyleProp<TextStyle>, brand = false): TextStyle {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  if (brand) { const { fontWeight, fontStyle, ...rest } = flat; return { ...rest, fontFamily: BRAND_FONT }; }
  return { ...flat, fontFamily: UI_FONT };
}

export const Text = forwardRef<RNText, TextProps & { brand?: boolean }>(function Text({ style, brand, ...props }, ref) {
  return <RNText ref={ref} {...props} style={withFont(style, brand)} />;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <RNTextInput ref={ref} {...props} style={withFont([{ minHeight: 44, borderRadius: 14, fontSize: 16 }, style])} />;
});
