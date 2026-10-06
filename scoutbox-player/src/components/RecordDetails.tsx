import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors } from '../theme';

/** A record has an identity, readable details and a separate action area. */
export function RecordPanel({ title, subtitle, icon = 'file-text', badge, children, actions, testID }: { title?: string; subtitle?: string; icon?: string; badge?: ReactNode; children?: ReactNode; actions?: ReactNode; testID?: string }) {
  const c = useColors();
  return <View testID={testID} style={{ paddingVertical: 16, gap: 14, borderTopWidth: 1, borderTopColor: c.line }}>
    {title && <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={23} color={c.iconFg} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}><Text style={{ color: c.text, fontSize: 15, lineHeight: 21, fontWeight: '600' }}>{title}</Text>{subtitle && <Text style={{ color: c.muted, fontSize: 12.5, lineHeight: 18 }}>{subtitle}</Text>}</View>
    </View>}
    {badge}
    {children}
    {actions && <View style={{ paddingTop: 8, gap: 10 }}>{actions}</View>}
  </View>;
}

export function DetailFact({ label, value, icon }: { label: string; value: string | number; icon?: string }) {
  const c = useColors();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 14, rowGap: 5, paddingVertical: 5 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7, width: '40%', minWidth: 90 }}>{icon && <Icon name={icon} size={16} color={c.iconFg} />}<Text style={{ color: c.muted, fontSize: 11.5, lineHeight: 18, flex: 1 }}>{label}</Text></View>
    <Text style={{ flex: 1, minWidth: 120, color: c.text, fontSize: 13, lineHeight: 19, fontWeight: '500' }}>{value}</Text>
  </View>;
}

export function InfoNote({ children, icon = 'info' }: { children: ReactNode; icon?: string }) {
  const c = useColors();
  return <View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-start', paddingVertical: 9 }}><Icon name={icon} size={18} color={c.iconFg} /><Text style={{ flex: 1, color: c.muted, fontSize: 12.5, lineHeight: 19 }}>{children}</Text></View>;
}

export function MetricTiles({ items }: { items: { label: string; value: string | number; icon: string }[] }) {
  const c = useColors();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{items.map(item => <View key={item.label} style={{ flexGrow: 1, flexBasis: 76, minWidth: 70, padding: 12, borderRadius: 14, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, gap: 5 }}><Icon name={item.icon} size={20} color={c.iconFg} /><Text style={{ color: c.text, fontWeight: '700', fontSize: 23, lineHeight: 28 }}>{item.value}</Text><Text style={{ color: c.muted, fontSize: 11.5, lineHeight: 16 }}>{item.label}</Text></View>)}</View>;
}

/** A person or organisation has one compact identity row, not a nested card. */
export function RecordIdentity({ name, subtitle, status, icon }: { name: string; subtitle?: string; status?: ReactNode; icon?: string }) {
  const c = useColors();
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(n => n[0]).join('').toUpperCase();
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
      <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: c.greenBg, alignItems: 'center', justifyContent: 'center' }}>{icon ? <Icon name={icon} size={23} color={c.iconFg} /> : <Text style={{ fontSize: 14, fontWeight: '700', color: c.greenInk }}>{initials}</Text>}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}><Text style={{ color: c.text, fontSize: 16, fontWeight: '600', lineHeight: 22 }}>{name}</Text>{subtitle && <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{subtitle}</Text>}</View>
    </View>
    {status && <View style={{ alignSelf: 'flex-start' }}>{status}</View>}
  </View>;
}
