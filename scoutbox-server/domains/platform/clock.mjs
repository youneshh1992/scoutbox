/** The server clock, and the per-request test clock the time-dependent batteries pin. */

import { testClockEnabled } from './capabilities.mjs';

export const TEST_CLOCK_HEADER = 'x-scoutbox-test-clock';

export const now = () => Date.now();

/**
 * One clock per request. With the test clock enabled (development only), a suite may pin a request's time with
 * `x-scoutbox-test-clock: <ms>` so that "the offer has expired" can be proven without waiting for it. Otherwise the
 * header is ignored.
 */
export function requestClock(env = process.env) {
  if (!testClockEnabled(env)) return () => Date.now();
  return (req = null) => {
    const n = req?.get ? Number(req.get(TEST_CLOCK_HEADER)) : NaN;
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  };
}
