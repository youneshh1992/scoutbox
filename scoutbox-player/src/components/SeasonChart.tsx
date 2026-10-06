import { Animated, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { Gradient } from './Vivid';
import { ChartEntrance } from './ChartEntrance';
import { useColors } from '../theme';

import { seasonChartData, type RecordedSeason as Season } from './seasonChartData';
export function SeasonChart({ current, history = [], compact = false }: { current: Omit<Season, 'season'>; history?: Season[]; compact?: boolean }) {
  const c = useColors();
  const data = seasonChartData(current, history);
  if (!data) return null;
  const { rows, max } = data;
  return <View testID="season-chart" style={{ padding: compact ? 16 : 20, borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, marginTop: 18, overflow: 'hidden' }}>
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 18 }}><View style={{ width: 36, height: 36, backgroundColor: c.iconBg, borderRadius: 12, justifyContent: 'center', alignItems: 'center' }}><Icon name="activity" size={23} color={c.accentText} /></View><View><Text style={{ color: c.text, fontSize: 19, fontWeight: '700' }}>Your season</Text><Text style={{ color: c.muted, fontSize: 11 }}>Your recorded numbers. Your progress.</Text></View></View>
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>{[{label:'Goals',value:current.goals,color:c.accentText,icon:'soccer-ball'},{label:'Assists',value:current.assists,color:c.infoInk,icon:'football-boot'},{label:'Matches',value:current.appearances,color:c.iconFg,icon:'football-pitch'}].map(x=><View key={x.label} style={{ flex: 1, borderRadius: 16, padding: 10, backgroundColor: c.panel2 }}><Icon name={x.icon} color={x.color} size={20} /><Text style={{ color: c.text, fontSize: compact ? 24 : 27, fontWeight: '800', marginTop: 8 }}>{x.value}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{x.label}</Text></View>)}</View>
    <ChartEntrance>{progress => <View accessibilityLabel={rows.map(s=>`${s.season}: ${s.goals} goals, ${s.assists} assists`).join('. ')} style={{ flexDirection: 'row', gap: 18, alignItems: 'flex-end', paddingTop: 4, borderBottomWidth: 1, borderBottomColor: c.line }}>
      {rows.map((s,i)=><View key={`${s.season}-${i}`} style={{ flex: 1, alignItems: 'center', gap: 8 }}><View style={{ height: compact ? 60 : 120, flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>{[{value:s.goals,colors:['#00e676','#0088ff']},{value:s.assists,colors:['#00c8ff','#0088ff']}].map((bar,j)=><Animated.View key={j} style={{ transformOrigin: 'bottom', transform: [{ scaleY: progress.interpolate({ inputRange: [Math.min(i * 0.09 + j * 0.04, 0.4), 1], outputRange: [0.02, 1], extrapolate: 'clamp' }) }], width: compact ? 19 : 25, height: Math.max(0,bar.value) / max * (compact ? 60 : 120), borderTopLeftRadius: 7, borderTopRightRadius: 7, overflow: 'hidden' }}><Gradient colors={bar.colors} contrast={false} /></Animated.View>)}</View><Text style={{ color: c.muted, fontSize: 10, paddingBottom: 9 }}>{s.season}</Text></View>)}
    </View>}</ChartEntrance>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}><Text style={{ color: c.accentText, fontSize: 11 }}>Goals</Text><Text style={{ color: c.infoInk, fontSize: 11 }}>Assists</Text><Text style={{ color: c.muted, fontSize: 10 }}>Scale 0–{max}</Text></View>
  </View>;
}
