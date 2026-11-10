// The legacy signing route, kept for clients that do not use the signing workflow, and the club's signings list.
// The route writes nothing itself: the completed-signing record and every side effect come from the ONE writer
// (`recordCompletedSigning`), and a recruitment that went through the canonical Offer cannot be short-circuited
// here — an accepted Offer or a signing package between this club and player means the workflow owns the outcome.
import { visibleToOrg } from '../../../domain.mjs';
import { isLeadRole } from '../../../roles.mjs';
import { readPage, sendPageError } from '../../platform/paging.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';

export function registerLegacySigning({ orgRouter, signings, findPlayer, isBlocked, rateLimit, unit, recordCompletedSigning, legacyRecordingBlocker }) {
  if (typeof recordCompletedSigning !== 'function' || typeof legacyRecordingBlocker !== 'function') throw new TypeError('registerLegacySigning needs the signing domain\'s one writer and its legacy blocker');

  orgRouter.post('/players/:id/signing', (req, res) => {
    // Recording a joining is a club's act and a lead's act: an agency has no squad to sign a player into, and a
    // scout could not complete the canonical workflow either.
    if (req.org.type === 'agency' || req.org.level === 'agent') return res.status(403).json({ error: 'SIGNING_NOT_PERMITTED', message: 'Only a club records a signing.' });
    if (!isLeadRole(req.orgUser?.role)) return res.status(403).json({ error: 'LEAD_REQUIRED', message: 'Only recruitment leads and directors can record a signing.' });
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
    if (isBlocked(p.id, req.org.id)) return res.status(403).json({ error: 'BLOCKED' });
    const blocker = legacyRecordingBlocker(p.id, req.org.id, Date.now());
    if (blocker) return res.status(409).json({ ok: false, error: blocker.error, message: blocker.message });
    // ONE standing legacy row per club and player: a second recording while one stands (not cancelled, voided or
    // revoked) would be a second signing row, invoice and set of notifications for one joining. The route also draws
    // on the canonical closure budget, so it is not an unmetered alias of `/signings/:id/complete`.
    const standing = signings.forOrgPlayer(req.org.id, p.id).find((s) => !s.signingPackageId && !s.cancelledAt && !s.revokedAt && !s.voidedAt);
    if (standing) return res.status(409).json({ ok: false, error: 'SIGNING_ALREADY_RECORDED', message: 'A signing of this player by your club is already on record.', signingId: standing.id });
    if (rateLimit.limited('signing_closure', req.org.id)) return res.status(429).json(rateLimitedBody('signing_closure'));
    // A note is text of at most 400 characters, or absent; never sliced.
    const legacyNote = req.body?.note;
    if (legacyNote !== undefined && legacyNote !== null && legacyNote !== '' && (typeof legacyNote !== 'string' || legacyNote.length > 400)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'note', message: 'The note is text of at most 400 characters.' });
    let written;
    try {
      written = unit(() => recordCompletedSigning({ player: p, org: req.org, actor: req.orgUser, at: Date.now(), legacy: { note: typeof legacyNote === 'string' && legacyNote ? legacyNote : null } }));
    } catch (e) {
      console.error(`SIGNING legacy_recording_rolled_back ${p.id}: ${e?.message ?? e}`);
      return res.status(500).json({ ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'The signing could not be recorded; nothing was recorded.' });
    }
    const { signing, effects } = written;
    try { effects?.(); } catch (e) { console.error(`SIGNING legacy side_effect_failed: ${e?.message ?? e}`); }
    res.status(201).json({ ok: true, signing });
  });

  // Newest first, paged by cursor. No app reads this list yet; one that does will need a "load more" (product
  // decision: no load-more UI yet).
  orgRouter.get('/signings', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    res.json(signings.pageForOrg(req.org.id, page));
  });
}
