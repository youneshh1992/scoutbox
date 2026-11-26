// A slot is {day: 'mon'.., start: 'HH:MM', end: 'HH:MM', tz: IANA string}, compared as minutes from the week's start
// in UTC.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function tzOffsetMinutes(tz, ref = new Date('2026-01-15T12:00:00Z')) {
  // The offset at a fixed reference instant (stable for tests); DST-precise comparison would need per-date evaluation.
  try {
    const s =
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(ref)
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return null;
  } // unknown tz: caller treats as unknown, not zero
}
export function slotToUtcRange(slot) {
  const day = DAYS.indexOf(String(slot.day ?? '').toLowerCase());
  const [sh, sm] = String(slot.start ?? '')
    .split(':')
    .map(Number);
  const [eh, em] = String(slot.end ?? '')
    .split(':')
    .map(Number);
  const off = tzOffsetMinutes(slot.tz ?? 'UTC');
  if (day < 0 || Number.isNaN(sh) || Number.isNaN(eh) || off === null) return null;
  const WEEK = 7 * 24 * 60;
  const start = (((day * 24 * 60 + sh * 60 + (sm || 0) - off) % WEEK) + WEEK) % WEEK;
  const end = start + (eh * 60 + (em || 0) - (sh * 60 + (sm || 0)));
  return end > start ? { start, end } : null;
}
export function slotsOverlap(a, b) {
  const ra = slotToUtcRange(a),
    rb = slotToUtcRange(b);
  if (!ra || !rb) return null; // unknown, not false
  const WEEK = 7 * 24 * 60;
  // compare on the circle (a range may wrap the week boundary via tz shift)
  for (const shift of [-WEEK, 0, WEEK]) {
    if (ra.start < rb.end + shift && rb.start + shift < ra.end) return true;
  }
  return false;
}
