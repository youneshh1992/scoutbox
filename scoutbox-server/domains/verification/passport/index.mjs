// Milestone 15 registration point — Football Passport.
// Same architecture as m12–m14: focused modules receive the shared server
// context and register on the EXISTING authenticated routers, so every
// standing gate (bearer sessions, guardian ownership, visibleToOrg incl.
// the agency/minor wall and the grassroots radius, blocks, moderation)
// runs before any M15 handler.
//
// The Passport is a projection over existing records. The only new
// persistence is what Passport genuinely introduces: preferences,
// self-submitted career entries, achievements (+confirmations), shares
// (hashed tokens) and correction requests — since S10b typed tables owned by
// repositories/passport.mjs (ctx.passport writes; ctx.verificationReads reads).
import { metrics } from '../../../m13/enterprise.mjs';
import { registerPassportCore } from './passport.mjs';
import { registerPassportSharing } from './sharing.mjs';

export function registerM15(ctx) {
  if (typeof ctx.passport?.passportPrefs?.save !== 'function') throw new TypeError('registerM15 needs the passport repository from the data layer');
  // Privacy-safe product metrics — counters only, no PII, no recruiter
  // identity exposure to players (§51/§52).
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
