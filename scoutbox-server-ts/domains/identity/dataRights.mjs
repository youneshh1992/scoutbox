// A deletion keeps the append-only ledger (the audit and attribution basis, ids only) but removes the person's content
// everywhere it is held.
import { guardianSelfView, playerSelfView } from '../../views/playerViews.mjs';
import { ownChild } from './guards.mjs';

/**
 * Each `redactors` entry (`(playerId, at) => …`, run in order) tombstones or redacts what its domain holds of the
 * person. The files go after COMMIT (and again at every boot and sweep until gone); while one is queued, /media/:id
 * never serves it.
 */
export function createPlayerErasure({
  unit,
  afterCommit,
  seam,
  findPlayer,
  players,
  sessions,
  codes,
  mediaDeletions,
  uploads,
  storage,
  removeUploadChunks,
  dataDir,
  broadcast,
  redactors,
}) {
  if (!Array.isArray(redactors) || !redactors.every((r) => typeof r === 'function'))
    throw new TypeError("createPlayerErasure needs each domain's redactor as a function");
  if (typeof afterCommit !== 'function') throw new TypeError('createPlayerErasure needs afterCommit from the store');
  return function erasePlayer(playerId) {
    const p = findPlayer(playerId);
    if (!p) return false;
    const at = Date.now();
    unit(() => {
      mediaDeletions.enqueue(
        p.media.map((m) => m.id),
        { playerId, at },
      );
      sessions.revokeFor('player', playerId);
      codes.revokePairingCodesFor(playerId); // before the player row
      players.erase(playerId, { at });
      seam('player.delete.after_erase');
      const uploadIds = uploads.removeForPlayer(playerId);
      for (const redact of redactors) redact(playerId, at);
      broadcast('players');
      // The filesystem boundary, after COMMIT: a failure keeps the queue entry, and the next boot or sweep retries.
      afterCommit(() => {
        mediaDeletions.process(storage);
        removeUploadChunks(dataDir, uploadIds);
      });
    });
    return true;
  };
}

export function registerDataRights({
  playerRouter,
  guardianRouter,
  findPlayer,
  erasePlayer,
  requestsFor,
  requestForRecipient,
  threadsFor,
  notificationFeed,
  insightsFor,
  ledgerFor,
  ledgerView,
}) {
  if (typeof erasePlayer !== 'function' || typeof notificationFeed?.feed !== 'function')
    throw new TypeError('registerDataRights needs the erasure and the notification feed');

  const exportPlayer = (p) => ({
    exportedAt: new Date().toISOString(),
    profile: playerSelfView(p),
    requests: requestsFor(p.id).map(requestForRecipient),
    threads: threadsFor(p.id),
    notifications: notificationFeed.feed('player', p.id),
    insights: insightsFor(p.id),
    ledgerEvents: ledgerFor(p.id).map(ledgerView),
  });

  playerRouter.get('/export', (req, res) => res.json(exportPlayer(req.player)));

  playerRouter.delete('/account', (req, res) => {
    if (req.playerIsMinor)
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Ask your parent/guardian to delete this profile.' });
    erasePlayer(req.player.id);
    res.json({ deleted: true });
  });

  guardianRouter.get('/export', (req, res) => {
    res.json({
      exportedAt: new Date().toISOString(),
      guardian: guardianSelfView(req.guardian),
      children: req.guardian.childIds
        .map((id) => findPlayer(id))
        .filter(Boolean)
        .map(exportPlayer),
    });
  });

  guardianRouter.delete('/children/:id', (req, res) => {
    const child = ownChild(req, res, findPlayer);
    if (!child) return;
    erasePlayer(child.id);
    res.json({ deleted: true });
  });
}
