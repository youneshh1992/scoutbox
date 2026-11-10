/** The server clock, and the per-request test clock the time-dependent batteries pin. */

import { testClockEnabled } from './capabilities.mjs';

export const TEST_CLOCK_HEADER = 'x-scoutbox-test-clock';

export const now = () => Date.now();

/** With the test clock enabled (development only), a request may pin its time with the header; otherwise it is ignored. */
export function requestClock(env = process.env) {
  if (!testClockEnabled(env)) return () => Date.now();
  return (req = null) => {
    const n = req?.get ? Number(req.get(TEST_CLOCK_HEADER)) : NaN;
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  };
}
