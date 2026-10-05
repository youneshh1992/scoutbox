// Locally bundled Phosphor 2.1.1, MIT. Duotone surfaces and filled active states.
import { useColors, useTheme } from '../theme';
import Svg, { Path } from 'react-native-svg';
import icons from './scoutbox-icon-variants.json';
type Shape = { d: string; opacity: number };
const paths = icons as Record<string, Record<'duotone' | 'fill', Shape[]>>;
export function Icon({ name, size = 20, color = 'currentColor', label, active = false }: { name: string; size?: number; color?: string; strokeWidth?: number; label?: string; active?: boolean }) {
  const c = useColors(); const { scheme } = useTheme();
  const hues = scheme === 'dark' ? ['#48eec0','#51dfff','#bc95ff','#ff91c4','#ffd277'] : ['#007c60','#007b96','#7040bd','#b92c6d','#945916'];
  const vibrant = color === c.iconFg || color === c.muted || color === c.tabInactive;
  const ink = vibrant ? hues[Array.from(name).reduce((n, x) => n + x.charCodeAt(0), 0) % hues.length] : color;
  return <Svg style={{ position: 'relative', zIndex: 1 }} width={size} height={size} viewBox="0 0 256 256" fill={ink} accessibilityLabel={label} accessible={!!label} aria-hidden={!label}>
    {(paths[name] ?? paths['circle-help'])[active ? 'fill' : 'duotone'].map((path, i) => <Path key={i} d={path.d} opacity={path.opacity} />)}
  </Svg>;
}
