import { Children, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { Gradient } from './Vivid';
import { useColors } from '../theme';
import { humanDate, uiLocale } from '../time';
import { pt } from '../i18n';

/** Date-only values stay in the organiser's calendar day, never UTC-shifted. */
function calendarDate(value?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const date = new Date(+match[1], +match[2] - 1, +match[3]);
  return date.getFullYear() === +match[1] && date.getMonth() === +match[2] - 1 && date.getDate() === +match[3] ? date : null;
}

export function DateTile({ value }: { value?: string | null }) {
  const c = useColors(); const date = calendarDate(value);
  return <View accessible accessibilityLabel={value ? humanDate(value) : pt('inboxDateTbc')} style={{ width: 64, minHeight: 78, borderRadius: 15, overflow: 'hidden', backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, alignItems: 'center', flexShrink: 0 }}>
    <View style={{ backgroundColor: c.tabActiveBg, width: '100%', alignItems: 'center', paddingVertical: 5 }}><Text style={{ color: c.accentText, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 }}>{date ? date.toLocaleDateString(uiLocale(), { month: 'short' }) : pt('invDate')}</Text></View>
    {date ? <><Text style={{ color: c.text, fontSize: 28, lineHeight: 33, fontWeight: '700' }}>{date.getDate()}</Text><Text style={{ color: c.muted, fontSize: 10, paddingBottom: 6 }}>{date.toLocaleDateString(uiLocale(), { weekday: 'short' })}</Text></> : <View style={{ padding: 12 }}><Icon name="calendar-days" color={c.accentText} size={24} /></View>}
  </View>;
}

/** Event identity, essential details and response controls have separate regions. */
export function InvitationCard({ title, subtitle, date, venue, badge, icon = 'users', children, actions, testID }: { title: string; subtitle?: string; date?: string | null; venue?: string | null; badge?: string; icon?: string; children?: ReactNode; actions?: ReactNode; testID?: string }) {
  const c = useColors();
  return <View testID={testID} style={{ borderRadius: 22, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, overflow: 'hidden', marginVertical: 12 }}>
    <View style={{ padding: 18, gap: 14 }}>
      <Gradient opacity={0.09} />
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        {date !== undefined ? <DateTile value={date} /> : <View style={{ width: 54, height: 54, borderRadius: 18, backgroundColor: c.tabActiveBg, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={29} color={c.accentText} /></View>}
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}><Text style={{ color: c.text, fontSize: 19, lineHeight: 24, fontWeight: '600', letterSpacing: -0.4 }}>{title}</Text>{subtitle && <Text style={{ color: c.muted, fontSize: 12.5, lineHeight: 18 }}>{subtitle}</Text>}{date !== undefined && !calendarDate(date) && <Text style={{ color: c.muted, fontSize: 12 }}>{date ? humanDate(date) : pt('inboxDateTbc')}</Text>}</View>
      </View>
      {venue && <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Icon name="map-pin" size={18} color={c.accentText} /><Text style={{ flex: 1, color: c.text, fontSize: 13, lineHeight: 19, fontWeight: '500' }}>{venue}</Text></View>}
      {badge && <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, backgroundColor: c.panel, borderRadius: 20, paddingVertical: 5, paddingHorizontal: 9 }}><Icon name="shield-check" size={14} color={c.accentText} /><Text style={{ color: c.muted, fontSize: 11 }}>{badge}</Text></View>}
    </View>
    {Children.toArray(children).length > 0 && <View style={{ padding: 18, gap: 16, borderTopWidth: 1, borderTopColor: c.line }}>{children}</View>}
    {actions && <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.panel2, gap: 12 }}>{actions}</View>}
  </View>;
}

export function InvitationDetail({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  const c = useColors();
  return <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}><View style={{ paddingTop: 1 }}><Icon name={icon} size={19} color={c.iconFg} /></View><View style={{ flex: 1, gap: 4 }}><Text style={{ color: c.text, fontSize: 12.5, fontWeight: '600' }}>{title}</Text><Text style={{ color: c.muted, fontSize: 12.5, lineHeight: 19 }}>{children}</Text></View></View>;
}

export function DateOptions({ days, selected, onSelect }: { days: string[]; selected?: string; onSelect: (day: string) => void }) {
  const c = useColors();
  return <View style={{ gap: 9 }}><Text style={{ color: c.text, fontSize: 12.5, fontWeight: '600' }}>{pt('invChooseDate')}</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>{Array.from(new Set(days)).map(day => {
    const active = day === selected; const date = calendarDate(day);
    return <Pressable key={day} testID={`alt-slot-${day}`} accessibilityRole="button" accessibilityLabel={day} accessibilityState={{ selected: active }} aria-pressed={active} onPress={() => onSelect(day)} style={{ flexGrow: 1, flexBasis: 120, minHeight: 60, borderRadius: 14, borderWidth: 1, borderColor: active ? c.accentText : c.line, backgroundColor: active ? c.tabActiveBg : c.panel, padding: 11, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
      <View style={{ flex: 1, gap: 3 }}><Text style={{ color: c.text, fontSize: 14, fontWeight: '600' }}>{humanDate(day)}</Text>{date && <Text style={{ color: c.muted, fontSize: 11 }}>{date.toLocaleDateString(uiLocale(), { weekday: 'long' })}</Text>}</View><View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: active ? c.accentText : c.line, alignItems: 'center', justifyContent: 'center' }}>{active && <Icon name="check" size={14} color={c.accentText} />}</View>
    </Pressable>;
  })}</View></View>;
}
