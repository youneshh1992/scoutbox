/**
 * Wrong-code counting for staff second factors (org log-in and MFA set-up): five wrong codes lock the account's code
 * checks for five minutes. Per process, like the rate limiter.
 */
export function createMfaGuards() {
  const attempts = new Map(); // userId → { fails, lockedUntil }
  return {
    mfaLocked(userId) {
      const a = attempts.get(userId);
      return !!a?.lockedUntil && a.lockedUntil > Date.now();
    },
    mfaFail(userId) {
      const a = attempts.get(userId) ?? { fails: 0, lockedUntil: 0 };
      a.fails++;
      if (a.fails >= 5) {
        a.lockedUntil = Date.now() + 5 * 60_000;
        a.fails = 0;
      }
      attempts.set(userId, a);
    },
    clear: (userId) => {
      attempts.delete(userId);
    },
  };
}
