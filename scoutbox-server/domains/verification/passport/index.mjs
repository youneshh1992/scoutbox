// Football Passport: a projection over existing records. It owns only preferences, self-submitted career entries,
// achievements, shares (hashed tokens) and correction requests.
import { metrics } from '../../enterprise/enterprise.mjs';
import { registerPassportCore } from './passport.mjs';
import { registerPassportSharing } from './sharing.mjs';

export function registerFootballPassport(ctx) {
  if (typeof ctx.passport?.passportPrefs?.save !== 'function')
    throw new TypeError('registerFootballPassport needs the passport repository from the data layer');
  // Counters only.
  metrics.passport = {
    views_self: 0,
    views_guardian: 0,
    views_recruitment: 0,
    share_created: 0,
    share_revoked: 0,
    share_opened_public: 0,
    share_opened_recruitment: 0,
    batch_summaries: 0,
    correction_filed: 0,
    achievement_confirmed: 0,
  };
  const vmetric = (k) => {
    metrics.passport[k] = (metrics.passport[k] ?? 0) + 1;
  };

  const shared = { ...ctx, vmetric };
  registerPassportCore(shared);
  registerPassportSharing(shared);
  return shared;
}
