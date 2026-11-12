/** The player's signing routes, and the guardian's, which answer as if there were no signing. */

import { notFound, documentNotFound } from './errors.mjs';
import {
  minorSigningPathwayOpen,
  currentRevision,
  findParty,
  signingRecipientView,
  signingHistoryView,
  SIGNING_INPUT,
} from './signing.mjs';

export function registerRecipientRoutes(ctx) {
  const {
    caseOf,
    completeParty,
    documentBytesProblem,
    documentFile,
    err,
    guardianRouter,
    lookupsForPlayers,
    now,
    orgOf,
    playerRouter,
    signingInput,
    soundPackage,
    sp,
  } = ctx;
  /** Re-authorised live: the addressed adult, over an Offer they accepted, on a sound row. */
  function recipientPackages({ by, actorId, playerIds, at }) {
    const out = [];
    const look = lookupsForPlayers(playerIds);
    for (const p of [...new Set(playerIds)].flatMap((pid) => sp.forPlayer(pid))) {
      if (!soundPackage(p, at, look)) continue;
      const rev = currentRevision(p);
      const presented = (p.revisions ?? []).some((r) => r && r.readyAt);
      if (!presented) continue; // a draft is invisible, not redacted
      const party = findParty(rev, by === 'guardian' ? 'GUARDIAN' : 'PLAYER');
      if (!party || party.forEntityId !== actorId) continue;
      if (by === 'guardian' && !minorSigningPathwayOpen(orgOf(p.orgId)?.country ?? 'GB')) continue; // dormant
      out.push(p);
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  function recipientPackage(req, res, { by, actorId, playerIds }) {
    const p = recipientPackages({ by, actorId, playerIds, at: now(req) }).find((x) => x.id === req.params.id) ?? null;
    if (!p) {
      notFound(res, by);
      return null;
    }
    return p;
  }
  const recipientView = (p, at, by, actorId) =>
    signingRecipientView(p, at, {
      orgName: orgOf(p.orgId)?.name ?? null,
      partyType: by === 'guardian' ? 'GUARDIAN' : 'PLAYER',
      forEntityId: actorId,
    });

  playerRouter.get('/signings', (req, res) => {
    const at = now(req);
    const items = recipientPackages({ by: 'player', actorId: req.player.id, playerIds: [req.player.id], at }).map((p) =>
      recipientView(p, at, 'player', req.player.id),
    );
    res.json({
      items,
      note: 'Documents presented to you for signing, exactly as the club presented them. Confirming one records your signature on that exact document; nothing is signed until every required party has confirmed and the club completes the signing.',
    });
  });
  playerRouter.get('/signings/:id', (req, res) => {
    const p = recipientPackage(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] });
    if (!p) return;
    res.json({
      signing: recipientView(p, now(req), 'player', req.player.id),
      history: signingHistoryView(p, { forRecipient: true }),
    });
  });
  playerRouter.get('/signings/:id/document', (req, res) => {
    const p = recipientPackage(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] });
    if (!p) return;
    const q = signingInput(res, SIGNING_INPUT.recipientDocumentQuery, req.query, { root: 'query' });
    if (!q) return;
    const revId = q.revisionId ?? p.currentRevisionId;
    const rev = (p.revisions ?? []).find((r) => r && r.id === revId && r.readyAt);
    if (rev?.document) {
      const dp = documentBytesProblem(p, rev.document);
      if (dp) {
        console.error(`SIGNING document_${dp} ${p.id} ${rev.id}`);
        return err(res, 'SIGNING_STATE_UNKNOWN', 'This document cannot be read.');
      }
    }
    const out = rev?.document ? documentFile(rev.document, p.orgId) : null;
    if (!out) return documentNotFound(res, 'player');
    res.json(out);
  });
  playerRouter.post('/signings/:id/complete', (req, res) => {
    const p = recipientPackage(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] });
    if (!p) return;
    const kase = caseOf(p);
    completeParty(req, res, {
      pkg: p,
      kase,
      partyType: 'PLAYER',
      actorKind: 'player',
      actorId: req.player.id,
      actorName: req.player.name ?? null,
      rateKey: `player:${req.player.id}`,
      orgName: orgOf(p.orgId)?.name ?? null,
    });
  });

  // Dormant: the guardian pathway is closed everywhere, so the list is empty and every act is refused.
  guardianRouter.get('/signings', (req, res) => {
    res.json({
      items: [],
      note: 'Signing on behalf of a player under the age of majority is not open in this jurisdiction.',
    });
  });
  guardianRouter.get('/signings/:id', (req, res) => notFound(res, 'guardian'));
  guardianRouter.get('/signings/:id/document', (req, res) => documentNotFound(res, 'guardian'));
  guardianRouter.post('/signings/:id/complete', (req, res) => {
    const p = recipientPackages({
      by: 'guardian',
      actorId: req.guardian.id,
      playerIds: req.guardian.childIds ?? [],
      at: now(req),
    }).find((x) => x.id === req.params.id);
    if (!p) return notFound(res, 'guardian');
    return err(
      res,
      'SIGNING_PATHWAY_CLOSED',
      'Signing on behalf of a player under the age of majority is not open in this jurisdiction.',
    );
  });
}
