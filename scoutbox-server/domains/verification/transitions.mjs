// F2 — Consent-based academy transition + second-chance network.
// F10 — Adult representation verification (legacy lane; a blob collection until S11).
// A transition is a consent lifecycle: nothing is visible to any org without an
// explicit, revocable, expiring grant; nothing about a player is labelled
// "released"; agencies stay structurally walled from transition packs.
//
// S10c: a case, its pack, its grants and its history are rows of
// repositories/transitionsVouches.mjs, written through `transitionsVouches`
// (create / update, inside a unit of work with their notifications and ledger
// rows) and read through SQL. Input is checked before anything is written;
// junk is refused with 400 FIELD_INVALID naming the field.
import { isPlainObject } from '../../repositories/recruitment.mjs';
import { TRANSITION_LIMITS as L, PACK_KINDS } from '../../repositories/transitionsVouches.mjs';

const DAY = 86_400_000;
const FOLLOW_UP_DAYS = 60;

export function registerTransitions(ctx) {
  const {
    db, byId, orgRouter, playerRouter, guardianRouter, adminRouter, nextId,
    persistNow, notify, notifyAction, ledgerAppend, findPlayer, isAdult,
    orgCanSee, histAppend, emitWebhook, players, unit, users, transitionsVouches,
  } = ctx;
  if (typeof transitionsVouches?.transitionCases?.update !== 'function' || typeof unit !== 'function') throw new TypeError('registerTransitions needs the transitions repository and unit from the data layer');
  const { transitionCases } = transitionsVouches;

  // ------------------------------------------------------------ input
  const fieldInvalid = (res, field, message) => { res.status(400).json({ error: 'FIELD_INVALID', field, message }); return undefined; };
  /** Optional free text: null when absent or empty, shortened to `max` (as it always was); undefined after refusing junk. */
  const optText = (res, v, field, max) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return fieldInvalid(res, field, `${field} is text.`);
    return v.slice(0, max);
  };
  /** A whole number of days in range, the default when absent; undefined after refusing anything else (never clamped). */
  const days = (res, v, field, { min, max, default: def }) => {
    if (v === undefined || v === null) return def;
    if (!Number.isInteger(v) || v < min || v > max) return fieldInvalid(res, field, `A whole number of days from ${min} to ${max}.`);
    return v;
  };
  const orgIdOf = (res, v) => (typeof v === 'string' && v.length > 0 && v.length <= L.id ? v : fieldInvalid(res, 'orgId', 'Name the club by its id.'));
  /** Names come from other domains (no length limit at signup), so they are shortened rather than refused. */
  const clip = (name) => (typeof name === 'string' ? name.slice(0, L.name) : null);
  const entry = (actor, action, detail = null) => ({ id: nextId('aud'), at: Date.now(), byKind: actor.kind, byId: actor.id, byName: clip(actor.name), action, detail });
  const SYSTEM = { kind: 'system', id: 'sweep', name: 'system' };
  const firstStaff = (orgId) => users.listByOrg(orgId).find((u) => !u.removedAt) ?? null;

  // ------------------------------------------------------------ views (allowlists)
  const recipientView = (r) => ({ orgId: r.orgId, orgName: r.orgName, grantedAt: r.grantedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt, viewedAt: r.viewedAt });
  const caseView = (t) => ({
    id: t.id, playerId: t.playerId, playerName: t.playerName,
    startedBy: { ...t.startedBy }, caseOwner: { ...t.caseOwner },
    note: t.note, pack: { mediaIds: [...t.pack.mediaIds], evidenceIds: [...t.pack.evidenceIds], feedbackIds: [...t.pack.feedbackIds] },
    periodEndsAt: t.periodEndsAt, recipients: t.recipients.map(recipientView), status: t.status,
    placement: t.placement && { orgId: t.placement.orgId, orgName: t.placement.orgName, at: t.placement.at, note: t.placement.note },
    followUp: t.followUp && { dueAt: t.followUp.dueAt, notifiedAt: t.followUp.notifiedAt },
    createdAt: t.createdAt,
    history: t.history.map((h) => ({ id: h.id, at: h.at, byKind: h.byKind, byId: h.byId, byName: h.byName, action: h.action, detail: h.detail && { ...h.detail } })),
  });

  // ============================================================ F2 helpers
  // Evidence pack whitelist: ONLY records the player side owns or was given.
  // Club-private material (assessments, notes, video annotations) can never
  // ride along — publishing feedback (M12) is the one door, and only the
  // published text crosses it. Ids the player does not own are dropped.
  function buildPack(player, sel) {
    const own = (list, ok) => [...new Set(list ?? [])].filter(ok);
    return {
      mediaIds: own(sel?.mediaIds, (id) => player.media.some((m) => m.id === id)),
      evidenceIds: own(sel?.evidenceIds, (id) => { const e = ctx.scoutingReads.evidence.byId(id); return !!e && e.playerId === player.id && !e.supersededBy; }),
      feedbackIds: own(sel?.feedbackIds, (id) => { const a = ctx.scoutingReads.assessments.byId(id); return !!a && a.playerId === player.id && !!a.publishedFeedback; }),
    };
  }
  /** The selection as sent: an object of id lists, or nothing. Undefined after refusing junk. */
  function readSelection(res, sel) {
    if (sel === undefined || sel === null) return {};
    if (!isPlainObject(sel)) return fieldInvalid(res, 'pack', 'Send an object with mediaIds, evidenceIds and feedbackIds.');
    const unknown = Object.keys(sel).filter((k) => !Object.hasOwn(PACK_KINDS, k));
    if (unknown.length) return fieldInvalid(res, `pack.${unknown[0]}`, 'A pack holds mediaIds, evidenceIds and feedbackIds only.');
    for (const k of Object.keys(PACK_KINDS)) {
      const list = sel[k];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list) || list.length > L.packItems || list.some((x) => typeof x !== 'string' || !x.length || x.length > L.id)) return fieldInvalid(res, `pack.${k}`, `A list of up to ${L.packItems} ids.`);
    }
    return sel;
  }

  function packView(player, pack) {
    return {
      media: player.media.filter((m) => pack.mediaIds.includes(m.id)).map((m) => ({ id: m.id, title: m.title, url: m.url })),
      evidence: ctx.scoutingReads.evidence.forPlayer(player.id).filter((e) => pack.evidenceIds.includes(e.id)).map((e) => ({ id: e.id, kind: e.kind, tier: e.tier, summary: e.summary, recordedAt: e.recordedAt })),
      publishedFeedback: pack.feedbackIds.map((id) => ctx.scoutingReads.assessments.byId(id)).filter((a) => a?.publishedFeedback).map((a) => ({ id: a.id, orgName: byId.org(a.orgId)?.name ?? 'club', text: a.publishedFeedback.text, at: a.publishedFeedback.at })),
    };
  }

  function createTransition(req, res, player, actor) {
    const b = req.body ?? {};
    const sel = readSelection(res, b.pack); if (sel === undefined) return;
    const note = optText(res, b.note, 'note', L.note); if (note === undefined) return;
    const period = days(res, b.periodDays, 'periodDays', L.periodDays); if (period === undefined) return;
    const pack = buildPack(player, sel);
    if (!pack.mediaIds.length && !pack.evidenceIds.length && !pack.feedbackIds.length) {
      return res.status(400).json({ error: 'PACK_EMPTY', message: 'Select at least one item you own (your media, your evidence passport records, or feedback published to you). Club-private reports cannot be included without the club publishing them to you first.' });
    }
    const now = Date.now();
    // In a unit, so the id counter commits with the rows.
    const t = unit(() => transitionCases.create({
      id: nextId('trn'), playerId: player.id, playerName: clip(player.name),
      startedBy: { kind: actor.kind, id: actor.id, name: clip(actor.name) },
      note, pack, periodEndsAt: now + period * DAY,
      recipients: [], status: 'open', placement: null, followUp: null, createdAt: now,
      history: [entry(actor, 'opened', { items: pack.mediaIds.length + pack.evidenceIds.length + pack.feedbackIds.length })],
    }));
    res.status(201).json({
      transition: caseView(t),
      note: 'Nothing is shared yet. Add each receiving club yourself — every grant is individual, expiring and revocable. Your level and profile are unchanged: a transition never re-labels you.',
    });
  }

  playerRouter.post('/transitions', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'A transition case for an under-18 is opened and controlled by the parent/guardian.' });
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
    if (!t) { res.status(404).json({ error: 'TRANSITION_NOT_FOUND' }); return null; }
    const ownerOk = actorKind === 'player'
      ? t.playerId === req.player.id && !req.playerIsMinor
      : req.guardian.childIds.includes(t.playerId);
    if (!ownerOk) { res.status(403).json({ error: 'NOT_YOUR_CASE' }); return null; }
    return t;
  }

  /** The index of the organisation's live grant (not revoked, not expired at `at`), or -1. */
  const activeIndex = (t, orgId, at = Date.now()) => t.recipients.findIndex((r) => r.orgId === orgId && !r.revokedAt && r.expiresAt > at);

  function addRecipient(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    // A period that ended before the sweep marked the case expired: closed all the same (a grant would expire before it began).
    if (t.periodEndsAt <= Date.now()) return res.status(409).json({ error: 'CASE_CLOSED', status: 'expired' });
    const orgId = orgIdOf(res, req.body?.orgId); if (orgId === undefined) return;
    const grant = days(res, req.body?.days, 'days', L.grantDays); if (grant === undefined) return;
    const org = byId.org(orgId);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const player = findPlayer(t.playerId);
    // The receiving club must be able to see this player under ALL standing
    // rules (verification for minors, agency wall, grassroots radius+level).
    if (org.type === 'agency') return res.status(403).json({ error: 'AGENCIES_EXCLUDED', message: 'Transition packs go to clubs, never agencies.' });
    if (!orgCanSee(org, player)) return res.status(403).json({ error: 'RECIPIENT_NOT_ELIGIBLE', message: 'That club cannot currently see this player (verification, level or distance rules) — a transition grant never overrides eligibility.' });
    if (activeIndex(t, org.id) >= 0) return res.status(409).json({ error: 'ALREADY_GRANTED' });
    const now = Date.now();
    const r = { orgId: org.id, orgName: clip(org.name), grantedAt: now, expiresAt: Math.min(now + grant * DAY, t.periodEndsAt), revokedAt: null, viewedAt: null };
    const staff = firstStaff(org.id);
    // The grant, its history entry and the club's notification commit together.
    unit(() => {
      transitionCases.update(t.id, (d) => { d.recipients.push(r); d.history.push(entry(actor, 'recipient_added', { orgId: org.id })); });
      if (staff) notify({ kind: 'org_user', id: staff.id }, 'transition', `📦 A player has shared a transition evidence pack with ${org.name}. Open Transitions to review it.`, t.id);
    });
    emitWebhook?.(org.id, 'transition.granted', { transitionId: t.id });
    res.status(201).json({ recipient: recipientView(r) });
  }

  function revokeRecipient(req, res, t, actor) {
    const orgId = orgIdOf(res, req.body?.orgId); if (orgId === undefined) return;
    const i = t.recipients.findIndex((x) => x.orgId === orgId && !x.revokedAt);
    if (i < 0) return res.status(404).json({ error: 'RECIPIENT_NOT_FOUND' });
    const r = t.recipients[i];
    const staff = firstStaff(r.orgId);
    let stored;
    // The revocation, its history entry and the club's acknowledgement request commit together.
    unit(() => {
      stored = transitionCases.update(t.id, (d) => { d.recipients[i].revokedAt = Date.now(); d.history.push(entry(actor, 'recipient_revoked', { orgId: r.orgId })); });
      if (staff) {
        notifyAction({ kind: 'org_user', id: staff.id }, 'transition',
          `A transition evidence pack shared with ${r.orgName} was withdrawn. Platform access has ended; anything your staff already downloaded is outside the platform and cannot be remotely erased — please delete local copies.`,
          t.id, Date.now() + 7 * DAY);
      }
    });
    emitWebhook?.(r.orgId, 'transition.revoked', { transitionId: t.id });
    res.json({ recipient: recipientView(stored.recipients[i]), honest: 'Future platform access is revoked. Already-downloaded copies cannot be remotely erased — the withdrawal notice asks the club to delete them.' });
  }

  function withdrawCase(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    const stored = unit(() => transitionCases.update(t.id, (d) => {
      const now = Date.now();
      for (const r of d.recipients) if (!r.revokedAt) r.revokedAt = now;
      d.status = 'withdrawn';
      d.history.push(entry(actor, 'withdrawn'));
    }));
    res.json({ transition: caseView(stored) });
  }

  function placeCase(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    const orgId = orgIdOf(res, req.body?.orgId); if (orgId === undefined) return;
    const note = optText(res, req.body?.note, 'note', L.placementNote); if (note === undefined) return;
    const org = byId.org(orgId);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const stored = unit(() => transitionCases.update(t.id, (d) => {
      const now = Date.now();
      d.status = 'placed';
      d.placement = { orgId: org.id, orgName: clip(org.name), at: now, note };
      d.followUp = { dueAt: now + FOLLOW_UP_DAYS * DAY, notifiedAt: null }; // placement check-in
      for (const r of d.recipients) if (!r.revokedAt && r.orgId !== org.id) r.revokedAt = now;
      d.history.push(entry(actor, 'placed', { orgId: org.id }));
    }));
    res.json({ transition: caseView(stored), note: 'Case closed by placement — its history stays. Your registered level changes only through a signing or an audited level review, never automatically.' });
  }

  for (const [router, actorOf, own] of [
    [playerRouter, (req) => ({ kind: 'player', id: req.player.id, name: req.player.name }), 'player'],
    [guardianRouter, (req) => ({ kind: 'guardian', id: req.guardian.id, name: req.guardian.name }), 'guardian'],
  ]) {
    const base = own === 'player' ? '/transitions' : '/children-transitions';
    // A player's or a guardian's own cases, newest first (a short, per-player list: not paged).
    router.get(base, (req, res) => {
      const list = own === 'player' ? transitionCases.forPlayer(req.player.id) : transitionCases.forPlayers(req.guardian.childIds);
      res.json({ items: list.slice().reverse().map(caseView) });
    });
    router.post(`${base}/:id/recipients`, (req, res) => {
      const t = ownedTransition(req, res, own); if (t) addRecipient(req, res, t, actorOf(req));
    });
    router.post(`${base}/:id/revoke-recipient`, (req, res) => {
      const t = ownedTransition(req, res, own); if (t) revokeRecipient(req, res, t, actorOf(req));
    });
    router.post(`${base}/:id/withdraw`, (req, res) => {
      const t = ownedTransition(req, res, own); if (t) withdrawCase(req, res, t, actorOf(req));
    });
    router.post(`${base}/:id/place`, (req, res) => {
      const t = ownedTransition(req, res, own); if (t) placeCase(req, res, t, actorOf(req));
    });
  }

  // ------------------------------------------------------------ club side
  orgRouter.get('/transitions', (req, res) => {
    // Only cases where THIS org holds a live grant — there is no browsable
    // pool of "released players", and no list of minors.
    const now = Date.now();
    const mine = transitionCases.grantedTo(req.org.id, now);
    res.json({
      items: mine.map((t) => { const r = t.recipients[activeIndex(t, req.org.id, now)]; return { id: t.id, playerName: t.playerName, grantedAt: r.grantedAt, expiresAt: r.expiresAt, note: t.note }; }),
      note: 'Each pack was individually shared with your club by the player or their guardian, and can be withdrawn at any time.',
    });
  });

  orgRouter.get('/transitions/:id/pack', (req, res) => {
    const t = transitionCases.byId(req.params.id);
    if (!t) return res.status(404).json({ error: 'TRANSITION_NOT_FOUND' });
    const i = t.status === 'open' ? activeIndex(t, req.org.id) : -1;
    const player = findPlayer(t.playerId);
    // Live, every read: grant + standing visibility rules.
    if (i < 0 || !orgCanSee(req.org, player)) return res.status(403).json({ error: 'TRANSITION_ACCESS_REVOKED', message: 'This pack is not (or no longer) shared with your club.' });
    // The grant's last view and the ledger row commit together.
    unit(() => {
      transitionCases.update(t.id, (d) => { d.recipients[i].viewedAt = Date.now(); });
      ledgerAppend({ type: 'transition_pack_view', playerId: player.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    });
    res.json({ transitionId: t.id, playerName: t.playerName, note: t.note, pack: packView(player, t.pack) });
  });

  // Audited level review — the ONLY path that changes level outside signings.
  adminRouter.post('/players/:id/level-review', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const level = req.body?.level;
    if (!['amateur', 'semi_pro', 'pro'].includes(level)) return res.status(400).json({ error: 'BAD_LEVEL' });
    if (!req.body?.reason?.trim()) return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Level reviews are audited — record the basis for the change.' });
    const from = p.level;
    // S4a: the level column and the ledger entry commit together or not at all.
    unit(() => {
      players.update(p.id, { level });
      ledgerAppend({ type: 'level_review', playerId: p.id, orgId: null, orgName: 'Trust & Safety', userId: null, scoutName: 'T&S level review', detail: { from, to: level, reason: String(req.body.reason).slice(0, 300) } });
    });
    res.json({ playerId: p.id, from, to: level, note: 'Recorded in the append-only ledger. An academy departure never changes level automatically — this review is the deliberate, audited path.' });
  });

  // Transition follow-ups + expiry — piggybacks the shared m13 sweep. Indexed
  // queries find only the due cases; each change commits on its own unit (with
  // its notification), and a failure is logged, so one never holds back the rest
  // or escapes the timer.
  function transitionSweep() {
    const now = Date.now();
    let changed = 0;
    const each = (t, work) => { try { unit(work); changed++; } catch (e) { console.error(`transition sweep ${t.id}: ${e?.code ?? e?.message ?? e}`); } };
    for (const t of transitionCases.expiredBy(now)) {
      each(t, () => transitionCases.update(t.id, (d) => { d.status = 'expired'; d.history.push(entry(SYSTEM, 'expired')); }));
    }
    for (const t of transitionCases.followUpsDue(now)) {
      const p = findPlayer(t.playerId);
      const audience = p && !isAdult(p) && p.guardianId ? { kind: 'guardian', id: p.guardianId } : { kind: 'player', id: t.playerId };
      each(t, () => {
        transitionCases.update(t.id, (d) => { d.followUp.notifiedAt = now; });
        notify(audience, 'transition', `How is the placement at ${t.placement?.orgName} going? A quick check-in is due on the transition case.`, t.id);
      });
    }
    return changed;
  }
  ctx.transitionSweep = transitionSweep;

  // ========================================================== F10 helpers
  // The legacy lane still reads and writes db.representations, unchanged by S10c: its rows feed the 2305 mirror into
  // the agent agreements, so the collection moves with the agent stores in S11.
  const repFresh = (r) => {
    if (r.status === 'active' && r.endAt && r.endAt < Date.now()) return 'expired';
    return r.status;
  };
  const repView = (r) => ({ ...r, status: repFresh(r), credential: r.credential && { ...r.credential, honest: r.credential.reviewStatus === 'reviewed_valid' ? 'document reviewed by Trust & Safety — this is a document review, not an independent licence-register check (no register integration is configured)' : 'uploaded document, review pending — NOT an independently verified licence' } });

  /**
   * M23 P5.6E — CLOSED (E-1). This was the legacy F10 writer: any member of any
   * agency-typed org could create a relationship that the player could confirm
   * to `active`, with no licence check, no jurisdiction policy, no conflict
   * evaluation, no consent ledger, no rev and no idempotency. A confirmed
   * legacy row then fed the M16.2 Trust relationship input and the Passport
   * representation headline — which is authority, even though the P5.6B access
   * predicate refused it private client access.
   *
   * P5.6E §5/§7 permit exactly one active authority writer, and it is the
   * canonical P5.6B lane: a LICENSED individual requests, the client confirms.
   * So this route now creates nothing and says where the real one is. The
   * refusal is deliberately explicit rather than a 404: the caller is a
   * legitimate agency user being redirected, not someone probing.
   *
   * The player-side confirm / withdraw / dispute routes below stay OPEN on
   * purpose. A player must always be able to end or dispute a record that
   * already names them; closing those would trap them in it.
   */
  orgRouter.post('/representation/propose', (req, res) => {
    if (req.org.type !== 'agency') return res.status(403).json({ error: 'AGENCY_ONLY', message: 'Representation relationships belong to the agency lane.' });
    return res.status(410).json({
      error: 'REPRESENTATION_LANE_CLOSED',
      message: 'This lane no longer creates relationships. A representation relationship is requested by a licensed agent in ScoutBox Agent and becomes active only when the client confirms it.',
      canonicalRoute: 'POST /org/agent/clients/request',
      note: 'Existing records here remain readable as history, and the player can still withdraw or dispute one.',
    });
  });

  orgRouter.get('/representation', (req, res) => {
    if (req.org.type !== 'agency') return res.status(403).json({ error: 'AGENCY_ONLY' });
    const mine = db.representations.filter((r) => r.agencyOrgId === req.org.id);
    res.json({
      items: mine.map(repView),
      note: 'Active representation requires the player’s confirmation and ends the moment they withdraw it. States are labelled exactly as they are.',
    });
  });

  // Player lane — adult-gated live on EVERY route (16/17-year-olds get 403
  // even if a record somehow existed).
  function adultOnly(req, res) {
    if (!isAdult(req.player)) {
      res.status(403).json({ error: 'UNDER_18_WALL', message: 'Representation tools unlock at the age of majority — evaluated from your date of birth.' });
      return false;
    }
    return true;
  }

  playerRouter.get('/representation', (req, res) => {
    if (!adultOnly(req, res)) return;
    res.json({ items: db.representations.filter((r) => r.playerId === req.player.id).map(repView) });
  });

  playerRouter.post('/representation/:id/confirm', (req, res) => {
    if (!adultOnly(req, res)) return;
    const r = db.representations.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
    if (repFresh(r) !== 'proposed') return res.status(409).json({ error: 'NOT_PROPOSED', status: repFresh(r) });
    r.status = 'active';
    r.confirmedAt = Date.now();
    histAppend(r, 'player', req.player.id, req.player.name, 'confirmed');
    persistNow();
    res.json({ representation: repView(r) });
  });

  playerRouter.post('/representation/:id/withdraw', (req, res) => {
    if (!adultOnly(req, res)) return;
    const r = db.representations.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!['proposed', 'active'].includes(repFresh(r))) return res.status(409).json({ error: 'NOT_ACTIVE', status: repFresh(r) });
    r.status = 'withdrawn';
    r.withdrawnAt = Date.now();
    histAppend(r, 'player', req.player.id, req.player.name, 'withdrawn');
    const firstUser = db.users.find((u) => u.orgId === r.agencyOrgId && !u.removedAt);
    if (firstUser) notify({ kind: 'org_user', id: firstUser.id }, 'representation', `${r.playerName} withdrew the representation relationship. Current access ends now; the historical record stays attributed.`, r.id);
    persistNow();
    res.json({ representation: repView(r), note: 'Current representation access is revoked. History is retained for accountability.' });
  });

  playerRouter.post('/representation/:id/dispute', (req, res) => {
    if (!adultOnly(req, res)) return;
    const r = db.representations.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
    r.status = 'disputed';
    r.disputedAt = Date.now();
    r.disputeReason = String(req.body?.reason ?? '').slice(0, 300);
    histAppend(r, 'player', req.player.id, req.player.name, 'disputed', { reason: r.disputeReason });
    persistNow();
    res.json({ representation: repView(r), note: 'Trust & Safety reviews disputed relationships.' });
  });

  adminRouter.get('/representations', (_req, res) => {
    res.json({ items: db.representations.map(repView) });
  });

  adminRouter.post('/representations/:id/review-credential', (req, res) => {
    const r = db.representations.find((x) => x.id === req.params.id);
    if (!r?.credential) return res.status(404).json({ error: 'NO_CREDENTIAL' });
    const status = req.body?.valid === true ? 'reviewed_valid' : 'reviewed_invalid';
    r.credential.reviewStatus = status;
    r.credential.reviewedAt = Date.now();
    histAppend(r, 'admin', 'ts', 'Trust & Safety', 'credential_reviewed', { status });
    persistNow();
    res.json({ representation: repView(r), honest: 'This records a human document review. No independent licence-register integration exists in this environment, and the record says so.' });
  });
}
