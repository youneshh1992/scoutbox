/** Validate the rounded range sent to the segment API. */
export function validClipRange(start: number | null, end: number | null, duration: number): boolean {
  if (start === null || end === null || ![start, end, duration].every(Number.isFinite)) return false;
  const a = Number(start.toFixed(3)), b = Number(end.toFixed(3));
  return start >= 0 && a >= 0 && b > a && end <= duration && b - a <= 600;
}
export function clipTime(seconds: number): string {
  const hundredths = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
  return `${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${(hundredths % 6000 / 100).toFixed(2).padStart(5, '0')}`;
}
