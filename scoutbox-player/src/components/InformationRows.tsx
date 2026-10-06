import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { useColors } from '../theme';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../domain/safeguarding';

/** Explanations are discrete, scannable rows, never a shared box of paragraphs. */
export function GuidanceNote({ children, title, icon = 'info' }: { children: ReactNode; title?: string; icon?: string; size?: number }) {
  const c = useColors();
  return <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 9 }}>
    <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={16} color={c.iconFg} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>{title && <Text style={{ color: c.text, fontSize: 13, fontWeight: '600', lineHeight: 18 }}>{title}</Text>}<Text style={{ color: c.muted, fontSize: 12.5, lineHeight: 19 }}>{children}</Text></View>
  </View>;
}

export function StatusRow({ title, value, description, icon, positive = false }: { title: string; value: string; description?: string; icon: string; positive?: boolean }) {
  const c = useColors();
  return <View style={{ padding: 14, borderRadius: 16, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, gap: 9 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><Icon name={icon} size={22} color={c.iconFg} /><Text style={{ flex: 1, color: c.text, fontSize: 13, fontWeight: '600' }}>{title}</Text><View style={{ maxWidth: '48%', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: positive ? c.greenBg : c.panel2 }}><Text style={{ color: positive ? c.greenInk : c.muted, fontSize: 11.5, fontWeight: '600' }}>{value}</Text></View></View>
    {description && <Text style={{ color: c.muted, fontSize: 12.5, lineHeight: 19 }}>{description}</Text>}
  </View>;
}

export function PolicyList({ minor }: { minor: boolean }) {
  const titles = minor ? ['Parent-owned account', 'Adults handle conversations', 'Private player profiles', 'Verified clubs only', 'Guardian approves invitations', 'Recorded and moderated'] : ['Free discovery', 'Contact needs your approval', 'Every scout is accountable', 'You control medical sharing'];
  const icons = minor ? ['users', 'chat-bubble', 'lock-keyhole', 'shield-check', 'calendar-days', 'clipboard-list'] : ['eye', 'chat-bubble', 'clipboard-list', 'medical'];
  return <View style={{ gap: 10 }}>{(minor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((text, index) => <GuidanceNote key={text} title={titles[index]} icon={icons[index]}>{text}</GuidanceNote>)}</View>;
}
