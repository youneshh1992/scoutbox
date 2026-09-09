// F2 — Consent-based academy transition + second-chance network.
// F10 — Adult representation verification.
// Both are consent lifecycles: nothing is visible to any org without an
// explicit, revocable, expiring grant; nothing about a player is labelled
// "released"; agencies stay structurally walled from under-18s (DOB-checked
// live on every route, never a stored flag).
export function registerTransitions(ctx) {
  const {
    db, orgRouter, playerRouter, guardianRouter, adminRouter, nextId,
    persistNow, notify, notifyAction, ledgerAppend, findPlayer, isAdult,
    orgCanSee, histAppend, paginate, emitWebhook,
  } = ctx;

  // ============================================================ F2 helpers
  // Evidence pack whitelist: ONLY records the player side owns or was given.
  // Club-private material (assessments, notes, video annotations) can never
  // ride along — publishing feedback (M12) is the one door, and only the
  // published text crosses it.
  function buildPack(player, sel) {
    const mediaIds = (sel?.mediaIds ?? []).filter((id) => player.media.some((m) => m.id === id));
    const evidenceIds = (sel?.evidenceIds ?? []).filter((id) =>
      db.evidence.some((e) => e.id === id && e.playerId === player.id && !e.supersededBy));
    const feedbackIds = (sel?.feedbackIds ?? []).filter((id) =>
      db.assessments.some((a) => a.id === id && a.playerId === player.id && a.publishedFeedback));
    return { mediaIds, evidenceIds, feedbackIds };
  }

  function packView(player, pack) {
    return {
      media: player.media.filter((m) => pack.mediaIds.includes(m.id)).map((m) => ({ id: m.id, title: m.title, url: m.url })),
      evidence: db.evidence.filter((e) => pack.evidenceIds.includes(e.id)).map((e) => ({ id: e.id, kind: e.kind, tier: e.tier, summary: e.summary, recordedAt: e.recordedAt })),
      publishedFeedback: db.assessments.filter((a) => pack.feedbackIds.includes(a.id)).map((a) => ({ id: a.id, orgName: db.orgs.find((o) => o.id === a.orgId)?.name ?? 'club', text: a.publishedFeedback.text, at: a.publishedFeedback.at })),
    };
  }

  function createTransition(req, res, player, actor) {
    const b = req.body ?? {};
    const pack = buildPack(player, b.pack);
    if (!pack.mediaIds.length && !pack.evidenceIds.length && !pack.feedbackIds.length) {
      return res.status(400).json({ error: 'PACK_EMPTY', message: 'Select at least one item you own (your media, your evidence passport records, or feedback published to you). Club-private reports cannot be included without the club publishing them to you first.' });
    }
    const t = {
      id: nextId('trn'), playerId: player.id, playerName: player.name,
      startedBy: actor, caseOwner: { kind: actor.kind, id: actor.id, name: actor.name },
      note: b.note ? String(b.note).slice(0, 500) : null,
      pack, periodEndsAt: Date.now() + Math.min(Math.max(Number(b.periodDays) || 90, 14), 180) * 86_400_000,
      recipients: [], status: 'open', placement: null,
      followUp: null, createdAt: Date.now(), history: [],
    };
    histAppend(t, actor.kind, actor.id, actor.name, 'opened', { items: pack.mediaIds.length + pack.evidenceIds.length + pack.feedbackIds.length });
    db.transitionCases.push(t);
    persistNow();
    res.status(201).json({
      transition: t,
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
    const t = db.transitionCases.find((x) => x.id === req.params.id);
    if (!t) { res.status(404).json({ error: 'TRANSITION_NOT_FOUND' }); return null; }
    const ownerOk = actorKind === 'player'
      ? t.playerId === req.player.id && !req.playerIsMinor
      : req.guardian.childIds.includes(t.playerId);
    if (!ownerOk) { res.status(403).json({ error: 'NOT_YOUR_CASE' }); return null; }
    return t;
  }

  const activeRecipient = (t, orgId) => t.recipients.find((r) => r.orgId === orgId && !r.revokedAt && r.expiresAt > Date.now());

  function addRecipient(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    const org = db.orgs.find((o) => o.id === req.body?.orgId);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const player = findPlayer(t.playerId);
    // The receiving club must be able to see this player under ALL standing
    // rules (verification for minors, agency wall, grassroots radius+level).
    if (org.type === 'agency') return res.status(403).json({ error: 'AGENCIES_EXCLUDED', message: 'Transition packs go to clubs, never agencies.' });
    if (!orgCanSee(org, player)) return res.status(403).json({ error: 'RECIPIENT_NOT_ELIGIBLE', message: 'That club cannot currently see this player (verification, level or distance rules) — a transition grant never overrides eligibility.' });
    if (activeRecipient(t, org.id)) return res.status(409).json({ error: 'ALREADY_GRANTED' });
    const r = {
      orgId: org.id, orgName: org.name, grantedAt: Date.now(),
      expiresAt: Math.min(Date.now() + Math.min(Math.max(Number(req.body?.days) || 30, 1), 90) * 86_400_000, t.periodEndsAt),
      revokedAt: null, viewedAt: null,
    };
    t.recipients.push(r);
    histAppend(t, actor.kind, actor.id, actor.name, 'recipient_added', { orgId: org.id });
    const firstUser = db.users.find((u) => u.orgId === org.id && !u.removedAt);
    if (firstUser) notify({ kind: 'org_user', id: firstUser.id }, 'transition', `📦 A player has shared a transition evidence pack with ${org.name}. Open Transitions to review it.`, t.id);
    emitWebhook?.(org.id, 'transition.granted', { transitionId: t.id });
    persistNow();
    res.status(201).json({ recipient: r });
  }

  function revokeRecipient(req, res, t, actor) {
    const r = t.recipients.find((x) => x.orgId === req.body?.orgId && !x.revokedAt);
    if (!r) return res.status(404).json({ error: 'RECIPIENT_NOT_FOUND' });
    r.revokedAt = Date.now();
    histAppend(t, actor.kind, actor.id, actor.name, 'recipient_revoked', { orgId: r.orgId });
    const firstUser = db.users.find((u) => u.orgId === r.orgId && !u.removedAt);
    if (firstUser) {
      notifyAction({ kind: 'org_user', id: firstUser.id }, 'transition',
        `A transition evidence pack shared with ${r.orgName} was withdrawn. Platform access has ended; anything your staff already downloaded is outside the platform and cannot be remotely erased — please delete local copies.`,
        t.id, Date.now() + 7 * 86_400_000);
    }
    emitWebhook?.(r.orgId, 'transition.revoked', { transitionId: t.id });
    persistNow();
    res.json({ recipient: r, honest: 'Future platform access is revoked. Already-downloaded copies cannot be remotely erased — the withdrawal notice asks the club to delete them.' });
  }

  function withdrawCase(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    for (const r of t.recipients) if (!r.revokedAt) r.revokedAt = Date.now();
    t.status = 'withdrawn';
    histAppend(t, actor.kind, actor.id, actor.name, 'withdrawn');
    persistNow();
    res.json({ transition: t });
  }

  function placeCase(req, res, t, actor) {
    if (t.status !== 'open') return res.status(409).json({ error: 'CASE_CLOSED', status: t.status });
    const org = db.orgs.find((o) => o.id === req.body?.orgId);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    t.status = 'placed';
    t.placement = { orgId: org.id, orgName: org.name, at: Date.now(), note: req.body?.note ? String(req.body.note).slice(0, 300) : null };
    t.followUp = { dueAt: Date.now() + 60 * 86_400_000, completedAt: null }; // placement check-in
    for (const r of t.recipients) if (!r.revokedAt && r.orgId !== org.id) r.revokedAt = Date.now();
    histAppend(t, actor.kind, actor.id, actor.name, 'placed', { orgId: org.id });
    persistNow();
    res.json({ transition: t, note: 'Case closed by placement — its history stays. Your registered level changes only through a signing or an audited level review, never automatically.' });
  }

  for (const [router, actorOf, own] of [
    [playerRouter, (req) => ({ kind: 'player', id: req.player.id, name: req.player.name }), 'player'],
    [guardianRouter, (req) => ({ kind: 'guardian', id: req.guardian.id, name: req.guardian.name }), 'guardian'],
  ]) {
    const base = own === 'player' ? '/transitions' : '/children-transitions';
    router.get(base, (req, res) => {
      const list = own === 'player'
        ? db.transitionCases.filter((t) => t.playerId === req.player.id)
        : db.transitionCases.filter((t) => req.guardian.childIds.includes(t.playerId));
      res.json({ items: list.slice().reverse() });
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
    const mine = db.transitionCases.filter((t) => t.status === 'open' && activeRecipient(t, req.org.id));
    res.json({
      items: mine.map((t) => ({ id: t.id, playerName: t.playerName, grantedAt: activeRecipient(t, req.org.id).grantedAt, expiresAt: activeRecipient(t, req.org.id).expiresAt, note: t.note })),
      note: 'Each pack was individually shared with your club by the player or their guardian, and can be withdrawn at any time.',
    });
  });

  orgRouter.get('/transitions/:id/pack', (req, res) => {
    const t = db.transitionCases.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'TRANSITION_NOT_FOUND' });
    const r = t.status === 'open' && activeRecipient(t, req.org.id);
    const player = findPlayer(t.playerId);
    // Live, every read: grant + standing visibility rules.
    if (!r || !orgCanSee(req.org, player)) return res.status(403).json({ error: 'TRANSITION_ACCESS_REVOKED', message: 'This pack is not (or no longer) shared with your club.' });
    r.viewedAt = Date.now();
    ledgerAppend({ type: 'transition_pack_view', playerId: player.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
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
    p.level = level;
    ledgerAppend({ type: 'level_review', playerId: p.id, orgId: null, orgName: 'Trust & Safety', userId: null, scoutName: 'T&S level review', detail: { from, to: level, reason: String(req.body.reason).slice(0, 300) } });
    persistNow();
    res.json({ playerId: p.id, from, to: level, note: 'Recorded in the append-only ledger. An academy departure never changes level automatically — this review is the deliberate, audited path.' });
  });

  // Transition follow-ups + expiry — piggybacks the shared m13 sweep.
  function transitionSweep() {
    let changed = 0;
    for (const t of db.transitionCases) {
      if (t.status === 'open' && t.periodEndsAt < Date.now()) {
        t.status = 'expired';
        histAppend(t, 'system', 'sweep', 'system', 'expired');
        changed++;
      }
      if (t.followUp && !t.followUp.completedAt && t.followUp.dueAt < Date.now() && !t.followUp.notifiedAt) {
        t.followUp.notifiedAt = Date.now();
        const p = findPlayer(t.playerId);
        const audience = p && !isAdult(p) && p.guardianId ? { kind: 'guardian', id: p.guardianId } : { kind: 'player', id: t.playerId };
        notify(audience, 'transition', `How is the placement at ${t.placement?.orgName} going? A quick check-in is due on the transition case.`, t.id);
        changed++;
      }
    }
    if (changed) persistNow();
    return changed;
  }
  ctx.transitionSweep = transitionSweep;

  // ========================================================== F10 helpers
  const repFresh = (r) => {
    if (r.status === 'active' && r.endAt && r.endAt < Date.now()) return 'expired';
    return r.status;
  };
  const repView = (r) => ({ ...r, status: repFresh(r), credential: r.credential && { ...r.credential, honest: r.credential.reviewStatus === 'reviewed_valid' ? 'document reviewed by Trust & Safety — this is a document review, not an independent licence-register check (no register integration is configured)' : 'uploaded document, review pending — NOT an independently verified licence' } });

  // Agencies propose; only ADULT players (DOB, live) can be the subject.
  orgRouter.post('/representation/propose', (req, res) => {
    if (req.org.type !== 'agency') return res.status(403).json({ error: 'AGENCY_ONLY', message: 'Representation relationships belong to the agency lane.' });
    const p = findPlayer(req.body?.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!isAdult(p)) return res.status(403).json({ error: 'UNDER_18_WALL', message: 'Representation exists for adults only. Age is evaluated from date of birth at request time.' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (db.representations.some((r) => r.playerId === p.id && r.agencyOrgId === req.org.id && ['proposed', 'active'].includes(repFresh(r)))) {
      return res.status(409).json({ error: 'ALREADY_PROPOSED' });
    }
    const rep = {
      id: nextId('rep'), playerId: p.id, playerName: p.name,
      agencyOrgId: req.org.id, agencyName: req.org.name,
      representativeName: String(req.body?.representativeName ?? req.orgUser.name).slice(0, 80),
      scope: ['full', 'contracts_only', 'commercial_only'].includes(req.body?.scope) ? req.body.scope : 'full',
      startAt: Date.now(), endAt: req.body?.endMonths ? Date.now() + Math.min(Math.max(Number(req.body.endMonths), 1), 36) * 30 * 86_400_000 : null,
      credential: req.body?.credentialNote ? { source: 'uploaded_document', note: String(req.body.credentialNote).slice(0, 200), reviewStatus: 'pending', reviewedAt: null } : null,
      status: 'proposed', confirmedAt: null, withdrawnAt: null, disputedAt: null,
      createdAt: Date.now(), history: [],
    };
    histAppend(rep, 'org', req.orgUser.id, req.orgUser.name, 'proposed');
    db.representations.push(rep);
    notify({ kind: 'player', id: p.id }, 'representation', `${req.org.name} proposes to represent you (${rep.scope.replace('_', ' ')}). Nothing is active until YOU confirm it.`, rep.id);
    persistNow();
    res.status(201).json({ representation: repView(rep) });
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
