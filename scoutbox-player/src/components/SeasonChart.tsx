import { View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { Gradient, Reveal } from './Vivid';
import { useColors } from '../theme';

import { seasonChartData, type RecordedSeason as Season } from './seasonChartData';
export function SeasonChart({ current, history = [], compact = false }: { current: Omit<Season, 'season'>; history?: Season[]; compact?: boolean }) {
  const c = useColors();
  const data = seasonChartData(current, history);
  if (!data) return null;
  const { rows, max } = data;
  return <Reveal><View testID="season-chart" style={{ padding: compact ? 16 : 20, borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, marginTop: 18, overflow: 'hidden' }}>
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 18 }}><View style={{ width: 36, height: 36, backgroundColor: c.iconBg, borderRadius: 12, justifyContent: 'center', alignItems: 'center' }}><Icon name="activity" size={23} color={c.accentText} /></View><View><Text style={{ color: c.text, fontSize: 19, fontWeight: '700' }}>Your season</Text><Text style={{ color: c.muted, fontSize: 11 }}>Your recorded numbers. Your progress.</Text></View></View>
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>{[{label:'Goals',value:current.goals,color:'#00e676',icon:'target'},{label:'Assists',value:current.assists,color:'#37dcff',icon:'arrow-up-right'},{label:'Matches',value:current.appearances,color:'#d099ff',icon:'soccer-ball'}].map(x=><View key={x.label} style={{ flex: 1, borderRadius: 16, padding: 10, backgroundColor: c.panel2 }}><Icon name={x.icon} color={x.color} size={20} /><Text style={{ color: c.text, fontSize: compact ? 24 : 27, fontWeight: '800', marginTop: 8 }}>{x.value}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{x.label}</Text></View>)}</View>
    <View accessibilityLabel={rows.map(s=>`${s.season}: ${s.goals} goals, ${s.assists} assists`).join('. ')} style={{ flexDirection: 'row', gap: 18, alignItems: 'flex-end', paddingTop: 4, borderBottomWidth: 1, borderBottomColor: c.line }}>
      {rows.map((s,i)=><View key={`${s.season}-${i}`} style={{ flex: 1, alignItems: 'center', gap: 8 }}><Reveal grow><View style={{ height: compact ? 60 : 120, flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>{[{value:s.goals,colors:['#ccff76','#00e676','#00a993']},{value:s.assists,colors:['#91f5ff','#37b9ff','#7966ff']}].map((bar,j)=><View key={j} style={{ width: compact ? 19 : 25, height: Math.max(0,bar.value) / max * (compact ? 60 : 120), borderTopLeftRadius: 7, borderTopRightRadius: 7, overflow: 'hidden' }}><Gradient colors={bar.colors} diagonal={false} /></View>)}</View></Reveal><Text style={{ color: c.muted, fontSize: 10, paddingBottom: 9 }}>{s.season}</Text></View>)}
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}><Text style={{ color: c.accentText, fontSize: 11 }}>Goals</Text><Text style={{ color: c.infoInk, fontSize: 11 }}>Assists</Text><Text style={{ color: c.muted, fontSize: 10 }}>Scale 0–{max}</Text></View>
  </View></Reveal>;
}
