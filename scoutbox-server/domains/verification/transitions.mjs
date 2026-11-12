// Consent-based academy transitions. Nothing is visible to a club without an explicit, revocable, expiring grant;
// nothing about a player is labelled "released"; agencies never receive transition packs.
import { declareAuditedRead } from '../../writeRules.mjs';
import * as v from 'valibot';
import { PLAYER_LEVELS } from '../../repositories/identity.mjs';
import { TRANSITION_LIMITS as L, PACK_KINDS } from '../../repositories/transitionsVouches.mjs';
import { id, idList, inputOrRefuse, oneOf, requiredText, text, wholeNumber } from '../platform/schemas.mjs';

const DAY = 86_400_000;
const FOLLOW_UP_DAYS = 60;

const daysIn = ({ min, max }) => v.nullish(wholeNumber({ min, max }));
const NewTransition = v.strictObject({
  pack: v.nullish(
    v.strictObject(Object.fromEntries(Object.keys(PACK_KINDS).map((k) => [k, v.nullish(idList(L.packItems))]))),
  ),
  note: v.nullish(text(L.note)),
  periodDays: daysIn(L.periodDays),
});
const NewRecipient = v.strictObject({ orgId: id, days: daysIn(L.grantDays) });
const NamedOrg = v.strictObject({ orgId: id });
const Placement = v.strictObject({ orgId: id, note: v.nullish(text(L.placementNote)) });
const LevelReview = v.strictObject({ level: oneOf(PLAYER_LEVELS), reason: requiredText(300) });
const LEVEL_REVIEW_CODES = { fieldCodes: { level: 'BAD_LEVEL', reason: 'REASON_REQUIRED' } };

export function registerTransitions(ctx) {
  const {
    byId,
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    nextId,
    notify,
    notifyAction,
    ledgerAppend,
    findPlayer,
    isAdult,
    orgCanSee,
    emitWebhook,
    players,
    unit,
    users,
    transitionsVouches,
  } = ctx;
  if (typeof notifyAction !== 'function' || typeof emitWebhook !== 'function')
    throw new TypeError('registerTransitions needs notifyAction (registerDelivery) and emitWebhook (registerImports)');
  if (typeof transitionsVouches?.transitionCases?.grant !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerTransitions needs the transitions repository and unit from the data layer');
  const { transitionCases } = transitionsVouches;

  /** Names come from other domains (no length limit at signup), so they are shortened rather than refused. */
  const clip = (name) => (typeof name === 'string' ? name.slice(0, L.name) : null);
  const entry = (actor, action, detail = null) => ({
    id: nextId('aud'),
    at: Date.now(),
    byKind: actor.kind,
    byId: actor.id,
    byName: clip(actor.name),
    action,
    detail,
  });
  const SYSTEM = { kind: 'system', id: 'sweep', name: 'system' };
  const firstStaff = (orgId) => users.firstActive(orgId);

  // ------------------------------------------------------------ views
  const recipientView = (r) => ({
    orgId: r.orgId,
    orgName: r.orgName,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    viewedAt: r.viewedAt,
  });
  const caseView = (t) => ({
    id: t.id,
    playerId: t.playerId,
    playerName: t.playerName,
    startedBy: { ...t.startedBy },
    caseOwner: { ...t.caseOwner },
    note: t.note,
    pack: {
      mediaIds: [...t.pack.mediaIds],
      evidenceIds: [...t.pack.evidenceIds],
      feedbackIds: [...t.pack.feedbackIds],
    },
    periodEndsAt: t.periodEndsAt,
    recipients: t.recipients.map(recipientView),
    status: t.status,
    placement: t.placement && {
      orgId: t.placement.orgId,
      orgName: t.placement.orgName,
      at: t.placement.at,
      note: t.placement.note,
    },
    followUp: t.followUp && { dueAt: t.followUp.dueAt, notifiedAt: t.followUp.notifiedAt },
    createdAt: t.createdAt,
    history: t.history.map((h) => ({
      id: h.id,
      at: h.at,
      byKind: h.byKind,
      byId: h.byId,
      byName: h.byName,
      action: h.action,
      detail: h.detail && { ...h.detail },
    })),
  });

  // ============================================================ helpers
  // Only records the player side owns or was given: club-private material cannot ride along, and of an assessment
  // only published feedback crosses. Ids the player does not own are dropped.
  function buildPack(player, sel) {
    const own = (list, ok) => [...new Set(list ?? [])].filter(ok);
    return {
      mediaIds: own(sel?.mediaIds, (id) => player.media.some((m) => m.id === id)),
      evidenceIds: own(sel?.evidenceIds, (id) => {
        const e = ctx.scoutingReads.evidence.byId(id);
        return !!e && e.playerId === player.id && !e.supersededBy;
      }),
      feedbackIds: own(sel?.feedbackIds, (id) => {
        const a = ctx.scoutingReads.assessments.byId(id);
        return !!a && a.playerId === player.id && !!a.publishedFeedback;
      }),
    };
  }
  function packView(player, pack) {
    return {
      media: player.media
        .filter((m) => pack.mediaIds.includes(m.id))
        .map((m) => ({ id: m.id, title: m.title, url: m.url })),
      evidence: ctx.scoutingReads.evidence
        .forPlayer(player.id)
        .filter((e) => pack.evidenceIds.includes(e.id))
        .map((e) => ({ id: e.id, kind: e.kind, tier: e.tier, summary: e.summary, recordedAt: e.recordedAt })),
      publishedFeedback: pack.feedbackIds
        .map((id) => ctx.scoutingReads.assessments.byId(id))
        .filter((a) => a?.publishedFeedback)
        .map((a) => ({
          id: a.id,
          orgName: byId.org(a.orgId)?.name ?? 'club',
          text: a.publishedFeedback.text,
          at: a.publishedFeedback.at,
        })),
    };
  }

  function createTransition(req, res, player, actor) {
    const body = inputOrRefuse(res, NewTransition, req.body);
    if (!body) return;
    const note = body.note || null;
    const period = body.periodDays ?? L.periodDays.default;
    const pack = buildPack(player, body.pack);
    if (!pack.mediaIds.length && !pack.evidenceIds.length && !pack.feedbackIds.length) {
      return res.status(400).json({
        error: 'PACK_EMPTY',
        message:
          'Select at least one item you own (your media, your evidence passport records, or feedback published to you). Club-private reports cannot be included without the club publishing them to you first.',
      });
    }
    const now = Date.now();
    // In a unit so the id counter commits with the rows.
    const t = unit(() =>
      transitionCases.create({
        id: nextId('trn'),
        playerId: player.id,
        playerName: clip(player.name),
        startedBy: { kind: actor.kind, id: actor.id, name: clip(actor.name) },
        note,
        pack,
        periodEndsAt: now + period * DAY,
        recipients: [],
        status: 'open',
        placement: null,
        followUp: null,
        createdAt: now,
        history: [
          entry(actor, 'opened', { items: pack.mediaIds.length + pack.evidenceIds.length + pack.feedbackIds.length }),
        ],
      }),
    );
    res.status(201).json({
      transition: caseView(t),
      note: 'Nothing is shared yet. Add each receiving club yourself — every grant is individual, expiring and revocable. Your level and profile are unchanged: a transition never re-labels you.',
    });
  }

  playerRouter.post('/transitions', (req, res) => {
    if (req.playerIsMinor)
      return res.status(403).json({
        error: 'GUARDIAN_MANAGED',
        message: 'A transition case for an under-18 is opened and controlled by the parent/guardian.',
      });
    createTransition(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  guardianRouter.post('/children/:id/transitions', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    createTransition(req, res, child, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  function ownedTransition(req, res, actorKind) {
    const t = transitionCases.byId(req.params.id);
    if (!t) {
      res.status(404).json({ error: 'TRANSITION_NOT_FOUND' });
      return null;
    }
    const ownerOk =
      actorKind === 'player'
        ? t.playerId === req.player.id && !req.playerIsMinor
        : req.guardian.childIds.includes(t.playerId);
    if (!ownerOk) {
      res.status(403).json({ error: 'NOT_YOUR_CASE' });
      return null;
    }
    return t;
  }

  const activeIndex = (t, orgId, at = Date.now()) =>
    t.recipients.findIndex((r) => r.orgId === orgId && !r.revokedAt && r.expiresAt > at);

  function addRecipient(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    // The sweep may not have marked the case expired yet.
    if (t.periodEndsAt <= Date.now()) return res.status(409).json({ error: 'CASE_CLOSED', status: 'expired' });
    const body = inputOrRefuse(res, NewRecipient, req.body);
    if (!body) return;
    const grant = body.days ?? L.grantDays.default;
    const org = byId.org(body.orgId);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const player = findPlayer(t.playerId);
    if (org.type === 'agency')
      return res
        .status(403)
        .json({ error: 'AGENCIES_EXCLUDED', message: 'Transition packs go to clubs, never agencies.' });
    if (!orgCanSee(org, player))
      return res.status(403).json({
        error: 'RECIPIENT_NOT_ELIGIBLE',
        message:
          'That club cannot currently see this player (verification, level or distance rules) — a transition grant never overrides eligibility.',
      });
    if (activeIndex(t, org.id) >= 0) return res.status(409).json({ error: 'ALREADY_GRANTED' });
    const now = Date.now();
    const r = {
      orgId: org.id,
      orgName: clip(org.name),
      grantedAt: now,
      expiresAt: Math.min(now + grant * DAY, t.periodEndsAt),
      revokedAt: null,
      viewedAt: null,
    };
    const staff = firstStaff(org.id);
    unit(() => {
      transitionCases.grant(t.id, { recipient: r }, { history: [entry(actor, 'recipient_added', { orgId: org.id })] });
      if (staff)
        notify(
          { kind: 'org_user', id: staff.id },
          'transition',
          `📦 A player has shared a transition evidence pack with ${org.name}. Open Transitions to review it.`,
          t.id,
        );
    });
    emitWebhook(org.id, 'transition.granted', { transitionId: t.id });
    res.status(201).json({ recipient: recipientView(r) });
  }

  function revokeRecipient(req, res, t, actor) {
    const body = inputOrRefuse(res, NamedOrg, req.body);
    if (!body) return;
    const i = t.recipients.findIndex((x) => x.orgId === body.orgId && !x.revokedAt);
    if (i < 0) return res.status(404).json({ error: 'RECIPIENT_NOT_FOUND' });
    const r = t.recipients[i];
    const staff = firstStaff(r.orgId);
    let stored;
    unit(() => {
      stored = transitionCases.revokeGrant(
        t.id,
        { ord: i, at: Date.now() },
        { history: [entry(actor, 'recipient_revoked', { orgId: r.orgId })] },
      );
      if (staff) {
        notifyAction(
          { kind: 'org_user', id: staff.id },
          'transition',
          `A transition evidence pack shared with ${r.orgName} was withdrawn. Platform access has ended; anything your staff already downloaded is outside the platform and cannot be remotely erased — please delete local copies.`,
          t.id,
          Date.now() + 7 * DAY,
        );
      }
    });
    emitWebhook(r.orgId, 'transition.revoked', { transitionId: t.id });
    res.json({
      recipient: recipientView(stored.recipients[i]),
      honest:
        'Future platform access is revoked. Already-downloaded copies cannot be remotely erased — the withdrawal notice asks the club to delete them.',
    });
  }

  function withdrawCase(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    const stored = unit(() =>
      transitionCases.withdraw(t.id, { at: Date.now() }, { history: [entry(actor, 'withdrawn')] }),
    );
    res.json({ transition: caseView(stored) });
  }

  function placeCase(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    const body = inputOrRefuse(res, Placement, req.body);
    if (!body) return;
    const note = body.note || null;
    const org = byId.org(body.orgId);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const now = Date.now();
    const stored = unit(() =>
      transitionCases.place(
        t.id,
        {
          placement: { orgId: org.id, orgName: clip(org.name), at: now, note },
          followUpDueAt: now + FOLLOW_UP_DAYS * DAY,
          at: now,
        },
        { history: [entry(actor, 'placed', { orgId: org.id })] },
      ),
    );
    res.json({
      transition: caseView(stored),
      note: 'Case closed by placement — its history stays. Your registered level changes only through a signing or an audited level review, never automatically.',
    });
  }

  for (const [router, actorOf, own] of [
    [playerRouter, (req) => ({ kind: 'player', id: req.player.id, name: req.player.name }), 'player'],
    [guardianRouter, (req) => ({ kind: 'guardian', id: req.guardian.id, name: req.guardian.name }), 'guardian'],
  ]) {
    const base = own === 'player' ? '/transitions' : '/children-transitions';
    // A short per-player list: not paged.
    router.get(base, (req, res) => {
      const list =
        own === 'player' ? transitionCases.forPlayer(req.player.id) : transitionCases.forPlayers(req.guardian.childIds);
      res.json({ items: list.slice().reverse().map(caseView) });
    });
    router.post(`${base}/:id/recipients`, (req, res) => {
      const t = ownedTransition(req, res, own);
      if (t) addRecipient(req, res, t, actorOf(req));
    });
    router.post(`${base}/:id/revoke-recipient`, (req, res) => {
      const t = ownedTransition(req, res, own);
      if (t) revokeRecipient(req, res, t, actorOf(req));
    });
    router.post(`${base}/:id/withdraw`, (req, res) => {
      const t = ownedTransition(req, res, own);
      if (t) withdrawCase(req, res, t, actorOf(req));
    });
    router.post(`${base}/:id/place`, (req, res) => {
      const t = ownedTransition(req, res, own);
      if (t) placeCase(req, res, t, actorOf(req));
    });
  }

  // ------------------------------------------------------------ club side
  orgRouter.get('/transitions', (req, res) => {
    // There is no browsable pool of "released players": only cases where this org holds a live grant.
    const now = Date.now();
    const mine = transitionCases.grantedTo(req.org.id, now);
    res.json({
      items: mine.map((t) => {
        const r = t.recipients[activeIndex(t, req.org.id, now)];
        return { id: t.id, playerName: t.playerName, grantedAt: r.grantedAt, expiresAt: r.expiresAt, note: t.note };
      }),
      note: 'Each pack was individually shared with your club by the player or their guardian, and can be withdrawn at any time.',
    });
  });

  orgRouter.get('/transitions/:id/pack', (req, res) => {
    const t = transitionCases.byId(req.params.id);
    if (!t) return res.status(404).json({ error: 'TRANSITION_NOT_FOUND' });
    const i = t.status === 'open' ? activeIndex(t, req.org.id) : -1;
    const player = findPlayer(t.playerId);
    if (i < 0 || !orgCanSee(req.org, player))
      return res.status(403).json({
        error: 'TRANSITION_ACCESS_REVOKED',
        message: 'This pack is not (or no longer) shared with your club.',
      });
    declareAuditedRead('a transition pack records who opened it');
    unit(() => {
      transitionCases.recordView(t.id, { ord: i, at: Date.now() });
      ledgerAppend({
        type: 'transition_pack_view',
        playerId: player.id,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
    });
    res.json({ transitionId: t.id, playerName: t.playerName, note: t.note, pack: packView(player, t.pack) });
  });

  // The only path that changes level outside signings.
  adminRouter.post('/players/:id/level-review', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const body = inputOrRefuse(res, LevelReview, req.body, LEVEL_REVIEW_CODES);
    if (!body) return;
    const { level, reason } = body;
    const from = p.level;
    unit(() => {
      players.setLevel(p.id, level);
      ledgerAppend({
        type: 'level_review',
        playerId: p.id,
        orgId: null,
        orgName: 'Trust & Safety',
        userId: null,
        scoutName: 'T&S level review',
        detail: { from, to: level, reason },
      });
    });
    res.json({
      playerId: p.id,
      from,
      to: level,
      note: 'Recorded in the append-only ledger. An academy departure never changes level automatically — this review is the deliberate, audited path.',
    });
  });

  // Each case commits in its own unit and a failure is logged, so one never holds back the rest or escapes the timer.
  function transitionSweep() {
    const now = Date.now();
    let changed = 0;
    const each = (t, work) => {
      try {
        unit(work);
        changed++;
      } catch (e) {
        console.error(`transition sweep ${t.id}: ${e?.code ?? e?.message ?? e}`);
      }
    };
    for (const t of transitionCases.expiredBy(now)) {
      each(t, () => transitionCases.expire(t.id, {}, { history: [entry(SYSTEM, 'expired')] }));
    }
    for (const t of transitionCases.followUpsDue(now)) {
      const p = findPlayer(t.playerId);
      const audience =
        p && !isAdult(p) && p.guardianId ? { kind: 'guardian', id: p.guardianId } : { kind: 'player', id: t.playerId };
      each(t, () => {
        transitionCases.markFollowUpNotified(t.id, { at: now });
        notify(
          audience,
          'transition',
          `How is the placement at ${t.placement?.orgName} going? A quick check-in is due on the transition case.`,
          t.id,
        );
      });
    }
    return changed;
  }
  return { transitionSweep };
}
