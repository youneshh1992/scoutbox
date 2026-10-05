export type SeasonNumbers = { goals: number; assists: number; appearances: number };
export type RecordedSeason = SeasonNumbers & { season: string };
const valid = (s: SeasonNumbers) => [s.goals, s.assists, s.appearances].every(n => Number.isFinite(n) && n >= 0);
/** Missing or invalid numbers are not invented as zero, and source records are never reordered. */
export function seasonChartData(current: SeasonNumbers, history: RecordedSeason[] = []) {
  if (!valid(current)) return null;
  const rows = history.filter(valid).slice().sort((a,b) => a.season.localeCompare(b.season)).slice(-2).concat({ ...current, season: 'Now' });
  return { rows, max: Math.max(1, ...rows.flatMap(s => [s.goals, s.assists])) };
}
