// Local Phosphor 2.1.1 (MIT), with ScoutBox-specific passport, board, medical and chat vectors.
import { useColors, useTheme } from '../theme';
import Svg, { Path } from 'react-native-svg';
import icons from './scoutbox-icon-variants.json';
type Shape = { d: string; opacity: number };
const paths = icons as Record<string, Record<'duotone' | 'fill', Shape[]>>;
export function Icon({ name, size = 20, color = 'currentColor', label, active = false }: { name: string; size?: number; color?: string; strokeWidth?: number; label?: string; active?: boolean }) {
  const c = useColors(); const { scheme } = useTheme();
  const hues = scheme === 'dark' ? ['#00e676','#00c8ff','#68b8ff','#e7b35b'] : ['#007c60','#007b96','#005ca8','#945916'];
  const vibrant = color === c.iconFg || color === c.muted || color === c.tabInactive;
  const ink = vibrant ? hues[Array.from(name).reduce((n, x) => n + x.charCodeAt(0), 0) % hues.length] : color;
  if (['passport', 'opportunity-board', 'chat-bubble', 'medical'].includes(name)) {
    return <Svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke={ink} strokeWidth={name === 'chat-bubble' ? 2.3 : 1.8} strokeLinecap="round" strokeLinejoin="round" accessibilityLabel={label} accessible={!!label} aria-hidden={!label}>
      {name === 'passport' && <><Path d="M7 3H25A2 2 0 0 1 27 5V27A2 2 0 0 1 25 29H7A2 2 0 0 1 5 27V5A2 2 0 0 1 7 3Z" fill={ink} fillOpacity={0.09} /><Path d="M5 7H8 M5 25H8 M22 13A6 6 0 1 1 10 13A6 6 0 1 1 22 13 M10 13H22 M16 7C12 10 12 16 16 19C20 16 20 10 16 7 M12 24H20" /></>}
      {name === 'opportunity-board' && <><Path d="M3 5H29V24H3Z" fill={ink} fillOpacity={0.1} /><Path d="M9 24L7 29 M23 24L25 29 M16 2V5 M7 10H13V15H7Z M18 10H25 M18 14H23 M7 19H14 M18 19H25" /></>}
      {name === 'chat-bubble' && <Path d="M10 5H23Q28 5 28 10V19Q28 24 23 24H14L8 29V24Q3 24 3 19V12Q3 5 10 5Z M12 14H20" />}
      {name === 'medical' && <><Path d="M5 5H27V27H5Z" fill={ink} fillOpacity={0.08} /><Path d="M16 10V22 M10 16H22" /></>}
    </Svg>;
  }
  if (name === 'football-boot' || name === 'football-pitch') {
    return <Svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke={ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" accessibilityLabel={label} accessible={!!label} aria-hidden={!label}>
      {name === 'football-boot' ? <><Path d="M4 7L10 6C10 11 13 13 17 14L25 16C28 17 29 19 28 22H4Z" fill={ink} fillOpacity={0.14} /><Path d="M4 22H28 M6 22V26H9V22 M15 22V25H18V22 M24 22V25H27V22 M12 12L10 15 M16 14L14 17 M20 15L18 18" /></> : <><Path d="M3 6H29V26H3Z" fill={ink} fillOpacity={0.12} /><Path d="M16 6V26 M3 11H8V21H3 M29 11H24V21H29" /><Path d="M20 16A4 4 0 1 1 12 16A4 4 0 1 1 20 16" /></>}
    </Svg>;
  }
  return <Svg style={{ position: 'relative', zIndex: 1 }} width={size} height={size} viewBox="0 0 256 256" fill={ink} accessibilityLabel={label} accessible={!!label} aria-hidden={!label}>
    {(paths[name] ?? paths['circle-help'])[active ? 'fill' : 'duotone'].map((path, i) => <Path key={i} d={path.d} opacity={path.opacity} />)}
  </Svg>;
}
