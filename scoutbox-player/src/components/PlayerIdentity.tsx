import { Platform, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors } from '../theme';

export function PlayerMeta({ position, location, availability, centered = false, testID, availabilityTestID }: { position: string; location?: string; availability?: string; centered?: boolean; testID?: string; availabilityTestID?: string }) {
  const c = useColors();
  return <View testID={testID} style={{ alignItems: centered ? 'center' : 'flex-start', gap: 10 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: centered ? 'center' : 'flex-start', gap: 10 }}>
      {!!location && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}><Icon name="map-pin" size={15} color={c.muted} /><Text style={{ color: c.muted, fontSize: 12, flexShrink: 1 }}>{location}</Text></View>}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}><Icon name="football-pitch" size={16} color={c.iconFg} /><Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>{position}</Text></View>
    </View>
    {!!availability && <AvailabilityBadge label={availability} testID={availabilityTestID} />}
  </View>;
}

export function AvailabilityBadge({ label, testID }: { label: string; testID?: string }) {
  const c = useColors();
  return <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 11, borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}><Icon name="calendar-days" size={15} color={c.accentText} /><Text style={{ color: c.text, fontSize: 11.5, fontWeight: '500' }}>{label}</Text></View>;
}

/** Verified identities only. A 1px optical offset centres the seal on the visible name lettering. */
export function VerifiedBadge({ testID }: { testID?: string }) {
  return <View testID={testID} accessibilityLabel="Identity verified" style={{ width: 20.9, height: 20.9, flexShrink: 0, alignSelf: 'center', transform: [{ translateY: 1 }] }}><Svg width={20.9} height={20.9} viewBox="0 -0.5 24 24" aria-hidden accessible={false}><Path fill="#0088ff" d="M12 0.8 15 2.7 18.5 2.7 20.1 5.9 23 8 22.5 11.5 23 15 20.1 17.1 18.5 20.3 15 20.3 12 22.2 9 20.3 5.5 20.3 3.9 17.1 1 15 1.5 11.5 1 8 3.9 5.9 5.5 2.7 9 2.7Z" /><Path d="m7.1 11.5 3.1 3.1 6.6-6.2" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /></Svg></View>;
}

/**
 * The seal is attached to the last word of the name: a narrow screen wraps the name between words,
 * never between the last word and the seal (320px Home). The heading stays one accessible node that
 * reads the full name; on web it also carries the name typography so the heading element reports it.
 */
export function PlayerName({ name, verified, style, testID, badgeTestID, centered }: { name: string; verified: boolean; style?: StyleProp<TextStyle>; testID?: string; badgeTestID?: string; centered?: boolean }) {
  // The final fragment starts after the last space or hyphen (double-barrelled surnames wrap at the
  // hyphen like any browser would); the separator stays at the end of the first part, so one line
  // renders exactly as the unsplit name and a wrapped line breaks where the name itself would.
  const trimmed = name.trim(); const cut = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('-')) + 1;
  const head = cut > 0 && cut < trimmed.length ? trimmed.slice(0, cut) : ''; const last = head ? trimmed.slice(cut) : trimmed;
  return <View role="heading" aria-level={1} accessibilityLabel={name} testID={testID} style={[{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: centered ? 'center' : 'flex-start' }, Platform.OS === 'web' ? (style as StyleProp<ViewStyle>) : null]}>
    {!!head && <Text style={[style, { flexShrink: 1 }, centered && { textAlign: 'center' }]}>{head}</Text>}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, maxWidth: '100%' }}><Text style={[style, { flexShrink: 1 }, centered && { textAlign: 'center' }]}>{last}</Text>{verified && <VerifiedBadge testID={badgeTestID} />}</View>
  </View>;
}
