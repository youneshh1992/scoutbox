// Football Passport. Handlers register on the EXISTING authenticated routers, so every standing gate (bearer
// sessions, guardian ownership, visibleToOrg incl. the agency/minor wall and the grassroots radius, blocks,
// moderation) runs first.
//
// The Passport is a projection over existing records. It owns only preferences, self-submitted career entries,
// achievements (+confirmations), shares (hashed tokens) and correction requests, in
// repositories/passport.mjs (ctx.passport writes; ctx.verificationReads reads).
import { metrics } from '../../enterprise/enterprise.mjs';
import { registerPassportCore } from './passport.mjs';
import { registerPassportSharing } from './sharing.mjs';

export function registerFootballPassport(ctx) {
  if (typeof ctx.passport?.passportPrefs?.save !== 'function') throw new TypeError('registerFootballPassport needs the passport repository from the data layer');
  // Privacy-safe product metrics — counters only, no PII, no recruiter
  // identity exposure to players.
  metrics.passport = {
    views_self: 0, views_guardian: 0, views_recruitment: 0,
    share_created: 0, share_revoked: 0, share_opened_public: 0, share_opened_recruitment: 0,
    batch_summaries: 0, correction_filed: 0, achievement_confirmed: 0,
  };
  const vmetric = (k) => { metrics.passport[k] = (metrics.passport[k] ?? 0) + 1; };

  const shared = { ...ctx, vmetric };
  registerPassportCore(shared);
  registerPassportSharing(shared);
  return shared;
}
