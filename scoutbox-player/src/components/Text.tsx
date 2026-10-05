// M24E — Inter on every piece of text, on every platform.
//
// React Native has no document-wide default font, so the app's own `Text`
// and `TextInput` wrap the React Native ones and set the family. Two
// variable files (assets/fonts, SIL OFL — see Inter-OFL.txt) carry every
// weight 100–900 and the real italic:
//   • web — `_layout.tsx` registers both files as ONE family "Inter" with a
//     100–900 weight range and the italic style, so `fontWeight: '600'`
//     picks the real semibold and `fontStyle: 'italic'` the real italic,
//     never a synthesised one;
//   • iOS / Android — expo-font registers the upright file as "Inter" and the
//     italic file as "Inter-Italic"; the weight travels as `fontWeight` and the
//     italic as the family, so the platform never obliques an upright face.
// The ScoutBox wordmark alone keeps Albert Sans ExtraBold (the brand mark —
// see Wordmark.tsx); `brand` asks for it.
import { forwardRef } from 'react';
import { Platform, StyleSheet, Text as RNText, TextInput as RNTextInput, type StyleProp, type TextInputProps, type TextProps, type TextStyle } from 'react-native';

export const FONT_FILES = {
  Inter: require('../../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
  'Inter-Italic': require('../../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
  'AlbertSans-ExtraBold': require('../../assets/fonts/AlbertSans-ExtraBold.ttf'),
};

export const BRAND_FONT = 'AlbertSans-ExtraBold';

/** The resolved style: the Inter family for the requested weight and style. */
export function withFont(style: StyleProp<TextStyle>, brand = false): TextStyle {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  if (flat.fontFamily && flat.fontFamily !== 'Inter' && flat.fontFamily !== 'Inter-Italic') return flat; // monospace etc. stays as asked
  if (brand) { const { fontWeight, fontStyle, ...rest } = flat; return { ...rest, fontFamily: BRAND_FONT }; }
  if (Platform.OS === 'web') return { ...flat, fontFamily: 'Inter' };
  const { fontStyle, ...rest } = flat;
  return { ...rest, fontFamily: fontStyle === 'italic' ? 'Inter-Italic' : 'Inter' };
}

export const Text = forwardRef<RNText, TextProps & { brand?: boolean }>(function Text({ style, brand, ...props }, ref) {
  return <RNText ref={ref} {...props} style={withFont(style, brand)} />;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <RNTextInput ref={ref} {...props} style={withFont([{ minHeight: 44, borderRadius: 14, fontSize: 16 }, style])} />;
});
