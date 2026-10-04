// M24F.3 — human time for the portals. Never a machine timestamp
// ("10/3/2026, 8:45:24 PM") in the interface: a day, or a day and the
// minute. Seconds never appear.
const locale = () => (typeof document !== 'undefined' && document.documentElement.lang === 'fr' ? 'fr-FR' : 'en-GB');

/** "3 Oct 2026" */
export const fmtDay = (ts: number | string | Date) => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });

/** "3 Oct · 20:45" (the year only when it is not this year) */
export function fmtStamp(ts: number | string | Date): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString(locale(), sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return `${day} · ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;
}

/** "20:45" */
export const fmtClock = (ts: number | string | Date) => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
