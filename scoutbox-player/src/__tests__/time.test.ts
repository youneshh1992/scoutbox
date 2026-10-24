/// <reference types="jest" />
// Human time (M24F.3): a list shows how long ago, a record shows the day, a
// precise moment shows the day and the minute — never seconds, never a
// machine timestamp. The clock is frozen so the expectations are exact; the
// process runs in UTC (the `test` script sets TZ).
import { relTime, fmtDay, fmtShortDay, fmtDayTime, fmtClock, humanDate, fmtMonthYear, uiLocale } from '../time';
import { setPLang } from '../i18n';

const NOW = new Date('2026-10-14T12:00:00Z');
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); setPLang('en'); });
afterEach(() => { jest.useRealTimers(); setPLang('en'); });

describe('relTime (English)', () => {
  test('under a minute is "Now"', () => { expect(relTime(NOW.getTime() - 30_000, NOW)).toBe('Now'); });
  test('minutes within the hour', () => { expect(relTime(NOW.getTime() - 5 * MIN, NOW)).toBe('5m'); });
  test('hours within the same day', () => { expect(relTime(NOW.getTime() - 3 * HOUR, NOW)).toBe('3h'); });
  test('the day before is "Yesterday", even when fewer than 24 hours ago', () => {
    expect(relTime(new Date('2026-10-13T23:30:00Z').getTime(), NOW)).toBe('Yesterday');
    expect(relTime(NOW.getTime() - DAY, NOW)).toBe('Yesterday');
  });
  test('inside the last six days shows the weekday (14 Oct 2026 is a Wednesday; three days earlier is Sunday)', () => { expect(relTime(NOW.getTime() - 3 * DAY, NOW)).toBe('Sun'); });
  test('older in the same year shows day and month', () => { expect(relTime(NOW.getTime() - 30 * DAY, NOW)).toBe('14 Sept'); });
  test('a previous year shows the year too', () => { expect(relTime(new Date('2025-10-14T12:00:00Z').getTime(), NOW)).toBe('14 Oct 2025'); });
  test('accepts ISO strings as well as epoch milliseconds', () => { expect(relTime('2026-10-14T11:55:00Z', NOW)).toBe('5m'); });
});

describe('relTime (French)', () => {
  test('the two words that are translated, and the French locale for dates', () => {
    setPLang('fr');
    expect(uiLocale()).toBe('fr-FR');
    expect(relTime(NOW.getTime() - 10_000, NOW)).toBe('Maintenant');
    expect(relTime(NOW.getTime() - DAY, NOW)).toBe('Hier');
    expect(relTime(new Date('2025-10-14T12:00:00Z').getTime(), NOW)).toBe('14 oct. 2025');
  });
});

describe('fixed formats', () => {
  const t = new Date('2026-10-03T20:45:30Z').getTime();
  test('a record\'s day', () => { expect(fmtDay(t)).toBe('3 Oct 2026'); });
  test('a day inside the year', () => { expect(fmtShortDay(t)).toBe('3 Oct'); });
  test('a precise moment, to the minute and never the second', () => { expect(fmtDayTime(t)).toBe('3 Oct · 20:45'); expect(fmtClock(t)).toBe('20:45'); });
  test('a month, for a join date', () => { expect(fmtMonthYear(t)).toBe('Oct 2026'); });
});

describe('humanDate (server date strings)', () => {
  test('a full date in the current year shows day and month; another year adds the year', () => {
    expect(humanDate('2026-10-22')).toBe('22 Oct');
    expect(humanDate('2025-05-03')).toBe('3 May 2025');
  });
  test('a year-month shows month and year', () => { expect(humanDate('2026-05')).toBe('May 2026'); });
  test('empty, null and free text pass through unchanged', () => {
    expect(humanDate(null)).toBe(''); expect(humanDate(undefined)).toBe(''); expect(humanDate('')).toBe('');
    expect(humanDate('to be confirmed')).toBe('to be confirmed');
  });
});
