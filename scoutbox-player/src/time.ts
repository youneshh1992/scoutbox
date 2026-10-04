// M24F.3 — human time. The product never shows a machine timestamp
// ("10/3/2026, 8:45:24 PM"); a list shows how long ago, a record shows the
// day, and a precise moment shows the day and the minute — never seconds.
import { getPLang } from './i18n';

const locale = () => (getPLang() === 'fr' ? 'fr-FR' : 'en-GB');
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Now", "2m", "1h", "Yesterday", "Tue", "3 Oct", "3 Oct 2025" — for inbox and activity rows. */
export function relTime(ts: number | string, now: Date = new Date()): string {
  const d = new Date(ts);
  const diff = now.getTime() - d.getTime();
  const fr = getPLang() === 'fr';
  if (diff < 60_000) return fr ? 'Maintenant' : 'Now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000 && sameDay(d, now)) return `${Math.floor(diff / 3_600_000)}h`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return fr ? 'Hier' : 'Yesterday';
  if (diff < 6 * 86_400_000 && diff > 0) return d.toLocaleDateString(locale(), { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "3 Oct 2026" — a record's day. */
export const fmtDay = (ts: number | string) => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });

/** "3 Oct" — a day inside the current year. */
export const fmtShortDay = (ts: number | string) => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });

/** "3 Oct · 20:45" — a precise moment, to the minute. */
export const fmtDayTime = (ts: number | string) => `${fmtShortDay(ts)} · ${new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;

/** "20:45" — a clock time inside a thread. */
export const fmtClock = (ts: number | string) => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/** A date string the server sends as "2026-10-22" or "2026-05" → "22 Oct" / "May 2026"; anything else is returned as is. */
export function humanDate(s: string | null | undefined): string {
  if (!s) return '';
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (full) { const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3])); return d.getFullYear() === new Date().getFullYear() ? fmtShortDay(d.getTime()) : fmtDay(d.getTime()); }
  const ym = /^(\d{4})-(\d{2})$/.exec(s);
  if (ym) return new Date(Number(ym[1]), Number(ym[2]) - 1, 1).toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
  return s;
}
