// M24A — Albert Sans on every piece of text, on every platform.
//
// React Native has no document-wide default font, so the app's own `Text`
// and `TextInput` wrap the React Native ones and resolve the requested weight
// to the bundled static face (assets/fonts, SIL OFL). The weight then travels
// as the family name — `fontWeight` is dropped so neither platform
// synthesises a second emboldening on top of a face that is already bold.
import { forwardRef } from 'react';
import { StyleSheet, Text as RNText, TextInput as RNTextInput, type StyleProp, type TextInputProps, type TextProps, type TextStyle } from 'react-native';

export const FONT_FILES = {
  'AlbertSans-Regular': require('../../assets/fonts/AlbertSans-Regular.ttf'),
  'AlbertSans-Medium': require('../../assets/fonts/AlbertSans-Medium.ttf'),
  'AlbertSans-SemiBold': require('../../assets/fonts/AlbertSans-SemiBold.ttf'),
  'AlbertSans-Bold': require('../../assets/fonts/AlbertSans-Bold.ttf'),
  'AlbertSans-ExtraBold': require('../../assets/fonts/AlbertSans-ExtraBold.ttf'),
  'AlbertSans-RegularItalic': require('../../assets/fonts/AlbertSans-RegularItalic.ttf'),
  'AlbertSans-MediumItalic': require('../../assets/fonts/AlbertSans-MediumItalic.ttf'),
  'AlbertSans-SemiBoldItalic': require('../../assets/fonts/AlbertSans-SemiBoldItalic.ttf'),
  'AlbertSans-BoldItalic': require('../../assets/fonts/AlbertSans-BoldItalic.ttf'),
  'AlbertSans-ExtraBoldItalic': require('../../assets/fonts/AlbertSans-ExtraBoldItalic.ttf'),
};

const faceFor = (weight: TextStyle['fontWeight'], italic: boolean): string => {
  const w = typeof weight === 'number' ? weight : weight === 'bold' ? 700 : weight === 'normal' || weight === undefined ? 400 : Number(weight);
  const name = w >= 800 ? 'ExtraBold' : w >= 700 ? 'Bold' : w >= 600 ? 'SemiBold' : w >= 500 ? 'Medium' : 'Regular';
  return `AlbertSans-${name}${italic ? 'Italic' : ''}`;
};

/** The resolved style: Albert Sans face for the requested weight, weight and style removed. */
export function withFont(style: StyleProp<TextStyle>): TextStyle {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const { fontWeight, fontStyle, ...rest } = flat;
  return { ...rest, fontFamily: faceFor(fontWeight, fontStyle === 'italic') };
}

export const Text = forwardRef<RNText, TextProps>(function Text({ style, ...props }, ref) {
  return <RNText ref={ref} {...props} style={withFont(style)} />;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <RNTextInput ref={ref} {...props} style={withFont(style)} />;
});
