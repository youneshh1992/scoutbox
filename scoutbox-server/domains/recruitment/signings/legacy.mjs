// The legacy signing route and the club's signings list. The route writes through `recordCompletedSigning`, and
// refuses when an accepted Offer or a signing package means the workflow owns the outcome.
import { visibleToOrg } from '../../../domain.mjs';
import { isLeadRole } from '../../../roles.mjs';
import { readPage, sendPageError } from '../../platform/paging.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { sideEffectRunner } from '../../platform/sideEffects.mjs';
import * as v from 'valibot';
import { inputOrRefuse, text } from '../../platform/schemas.mjs';

const runSideEffect = sideEffectRunner('SIGNING');
const LegacySigning = v.strictObject({ note: v.nullish(text(400)) });

export function registerLegacySigning({
  orgRouter,
  signings,
  findPlayer,
  isBlocked,
  rateLimit,
  unit,
  recordCompletedSigning,
  legacyRecordingBlocker,
}) {
  if (typeof recordCompletedSigning !== 'function' || typeof legacyRecordingBlocker !== 'function')
    throw new TypeError("registerLegacySigning needs the signing domain's one writer and its legacy blocker");

  orgRouter.post('/players/:id/signing', (req, res) => {
    // An agency has no squad to sign a player into, and a scout could not complete the workflow either.
    if (req.org.type === 'agency' || req.org.level === 'agent')
      return res.status(403).json({ error: 'SIGNING_NOT_PERMITTED', message: 'Only a club records a signing.' });
    if (!isLeadRole(req.orgUser?.role))
      return res
        .status(403)
        .json({ error: 'LEAD_REQUIRED', message: 'Only recruitment leads and directors can record a signing.' });
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
    if (isBlocked(p.id, req.org.id)) return res.status(403).json({ error: 'BLOCKED' });
    const blocker = legacyRecordingBlocker(p.id, req.org.id, Date.now());
    if (blocker) return res.status(409).json({ ok: false, error: blocker.error, message: blocker.message });
    // One standing legacy row per club and player, or one joining gets two signing rows, invoices and sets of
    // notifications. It draws on the same closure budget as `/signings/:id/complete`.
    const standing = signings
      .forOrgPlayer(req.org.id, p.id)
      .find((s) => !s.signingPackageId && !s.cancelledAt && !s.revokedAt && !s.voidedAt);
    if (standing)
      return res.status(409).json({
        ok: false,
        error: 'SIGNING_ALREADY_RECORDED',
        message: 'A signing of this player by your club is already on record.',
        signingId: standing.id,
      });
    const body = inputOrRefuse(res, LegacySigning, req.body ?? {});
    if (!body) return;
    if (rateLimit.limited('signing_closure', req.org.id))
      return res.status(429).json(rateLimitedBody('signing_closure'));
    let written;
    try {
      written = unit(() =>
        recordCompletedSigning({
          player: p,
          org: req.org,
          actor: req.orgUser,
          at: Date.now(),
          legacy: { note: body.note || null },
        }),
      );
    } catch (e) {
      console.error(`SIGNING legacy_recording_rolled_back ${p.id}: ${e?.message ?? e}`);
      return res.status(500).json({
        ok: false,
        error: 'SIGNING_STATE_UNKNOWN',
        message: 'The signing could not be recorded; nothing was recorded.',
      });
    }
    const { signing, effects } = written;
    if (effects) runSideEffect('legacy', effects);
    res.status(201).json({ ok: true, signing });
  });

  // Newest first, paged by cursor. No app reads this list yet.
  orgRouter.get('/signings', (req, res) => {
    let page;
    try {
      page = readPage(req.query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    res.json(signings.pageForOrg(req.org.id, page));
  });
}
