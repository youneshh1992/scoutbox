// Money in integer minor units only: no floating-point arithmetic touches an amount, and conversion uses a
// scaled-integer rate.
export const validAmountMinor = (v) => Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
export const CURRENCIES = ['GBP', 'EUR', 'USD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL'];
/** Budget lines: what a line is and how often it is paid. */
export const BUDGET_LINE_KINDS = ['wage', 'fee', 'bonus', 'expense'];
export const BUDGET_SCHEDULES = ['one_off', 'weekly', 'monthly', 'annual'];
/** Convert via an explicit assumption. rate is a decimal STRING (e.g. "1.1732").
 *  Scaled to 1e6 integer math via BigInt; result rounded half-up to minor units. */
export function convertMinor(amountMinor, rateStr) {
  const m = String(rateStr).match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return null;
  const scaled = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  const num = BigInt(amountMinor) * scaled;
  const q = num / 1_000_000n, r = num % 1_000_000n;
  const rounded = r * 2n >= 1_000_000n ? q + 1n : q;
  return Number(rounded);
}
