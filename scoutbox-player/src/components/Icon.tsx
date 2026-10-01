// M24A — the platform icon set on the Player: lucide (ISC), the same family
// the portals use, drawn with react-native-svg so iOS, Android and the web
// render the identical 2px round stroke. `lucide.json` holds the path data
// copied from lucide-static; nothing is redrawn by hand.
import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';
import icons from './lucide.json';

type El = [string, Record<string, string>];
const ICONS = icons as unknown as Record<string, El[]>;

export function Icon({ name, size = 18, color = 'currentColor', strokeWidth = 2, label }: { name: string; size?: number; color?: string; strokeWidth?: number; label?: string }) {
  const els = ICONS[name] ?? ICONS['circle-help'];
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" accessibilityLabel={label} accessible={!!label} aria-hidden={!label}>
      {els.map(([tag, a], i) => {
        switch (tag) {
          case 'path': return <Path key={i} d={a.d} />;
          case 'circle': return <Circle key={i} cx={num(a.cx)} cy={num(a.cy)} r={num(a.r)} />;
          case 'ellipse': return <Ellipse key={i} cx={num(a.cx)} cy={num(a.cy)} rx={num(a.rx)} ry={num(a.ry)} />;
          case 'rect': return <Rect key={i} x={num(a.x)} y={num(a.y)} width={num(a.width)} height={num(a.height)} rx={num(a.rx)} ry={num(a.ry)} />;
          case 'line': return <Line key={i} x1={num(a.x1)} y1={num(a.y1)} x2={num(a.x2)} y2={num(a.y2)} />;
          case 'polyline': return <Polyline key={i} points={a.points} />;
          case 'polygon': return <Polygon key={i} points={a.points} />;
          default: return null;
        }
      })}
    </Svg>
  );
}
