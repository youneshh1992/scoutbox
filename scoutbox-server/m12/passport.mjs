// F1 — Player evidence passport · F10 — Coach identity and affiliations.
//
// The principle: evidence reliability is a property of HOW a claim was
// verified, never of how often someone opens the app. Tiers are earned by
// the verifying actor's authority, corrections supersede without erasing,
// and "insufficient evidence" is a first-class display state.

const CLAIM_TYPES = ['statistic', 'attendance', 'assessment_result', 'reference', 'footage', 'availability'];

export function registerPassport(ctx) {
  const {
    db, nextId, persist, persistNow, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter, adminRouter,
    orgCanSee, paginate, audit, guardianOwnsChild, freshness, activeAffiliation,
    moderateOrRefuse, isAdult,
  } = ctx;

  // ------------------------------------------------------------ evidence core
  function newEvidence({ player, claimType, label, value, units, season, source, mediaIds, observedAt, note, tier, method, reviewer, correctionOf }) {
    const rec = {
      id: nextId('evd'),
      playerId: player.id,
      claimType,
      label: String(label).slice(0, 120),
      value: value ?? null,
      units: units ? String(units).slice(0, 20) : null,
      season: season ? String(season).slice(0, 20) : null,
      source, // { kind: 'player'|'guardian'|'org'|'coach', id, name }
      observedAt: observedAt ? new Date(observedAt).getTime() : null,
      recordedAt: Date.now(),
      mediaIds: Array.isArray(mediaIds) ? mediaIds.filter((m) => player.media.some((x) => x.id === m)) : [],
      verification: {
        // Honest ladder: self_reported | coach_confirmed | club_assessed.
        // 'independent' exists in the schema but no route can set it — there
        // is no integrated independent-measurement provider.
        status: tier,
        method: method ?? null,
        reviewerId: reviewer?.id ?? null,
        reviewerName: reviewer?.name ?? null,
        reviewedAt: reviewer ? Date.now() : null,
      },
      expiresAt: claimType === 'availability' ? Date.now() + 90 * 86_400_000 : null,
      correctionOf: correctionOf ?? null,
      supersededBy: null,
      disputes: [],
      note: note ? String(note).slice(0, 300) : null,
      history: [],
    };
    db.evidence.push(rec);
    return rec;
  }

  function evidenceView(rec) {
    const { disputes, history, ...rest } = rec;
    return {
      ...rest,
      freshness: freshness(rec.recordedAt),
      expired: rec.expiresAt ? rec.expiresAt < Date.now() : false,
      openDisputes: disputes.filter((d) => d.status === 'open').length,
      superseded: !!rec.supersededBy,
    };
  }

  // The composed passport: M12 evidence records PLUS the honest relabelling
  // of every pre-M12 "verified" surface. Reliability ≠ ability: nothing here
  // scores the player, it only describes how each claim was checked.
  function composePassport(player) {
    const records = db.evidence.filter((e) => e.playerId === player.id).map(evidenceView);
    const legacy = [];
    for (const a of player.attendance ?? []) {
      if (a.corroboratedBy) {
        legacy.push({ kind: 'attendance', label: `Match attendance ${a.fixture ?? ''}`.trim(), tier: 'club_assessed', method: `match-day roster credited by ${a.corroboratedBy}`, at: a.date ?? null });
      }
    }
    for (const v of db.vouches.filter((x) => x.playerId === player.id && x.status === 'published' && !x.withdrawn)) {
      legacy.push({
        kind: 'reference', label: `Reference from ${v.coachName} (${v.role})`, tier: 'coach_confirmed',
        method: 'email_code', identityVerified: false,
        caveat: 'Email-code reference: confirms mailbox control, not coach identity.',
        conflictOfInterest: v.conflictOfInterest ?? null,
      });
    }
    for (const r of player.drillResults ?? []) {
      legacy.push({
        kind: 'assessment_result', label: `Combine drill ${r.drillId}: ${r.value}`, tier: 'self_reported',
        method: r.videoMediaId || r.verified ? 'video_attached' : 'self_entry',
        caveat: r.videoMediaId || r.verified ? 'An attached video is not a verified measurement — no validated video-analysis capability exists.' : undefined,
      });
    }
    const active = records.filter((r) => !r.superseded && !r.expired);
    const byTier = {};
    for (const r of active) byTier[r.verification.status] = (byTier[r.verification.status] ?? 0) + 1;
    return {
      records,
      legacy,
      summary: {
        activeRecords: active.length,
        byTier,
        corroborated: active.filter((r) => r.verification.status !== 'self_reported').length,
        // Insufficient evidence is said out loud, not padded over.
        insufficient: active.length + legacy.length < 3,
        note: 'Provenance describes how each claim was checked — it is not a rating of football ability, and app usage frequency plays no part in it.',
      },
    };
  }

  function submitClaim(req, res, player, sourceKind, sourceId, sourceName, tier, method, reviewer) {
    const { claimType, label, value, units, season, mediaIds, observedAt, note } = req.body ?? {};
    if (!CLAIM_TYPES.includes(claimType)) return res.status(400).json({ error: 'CLAIM_TYPE_INVALID', allowed: CLAIM_TYPES });
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'LABEL_REQUIRED' });
    if (note && !moderateOrRefuse(res, note, { kind: 'evidence_note', playerId: player.id })) return;
    if (!moderateOrRefuse(res, label, { kind: 'evidence_label', playerId: player.id })) return;
    const rec = newEvidence({
      player, claimType, label, value, units, season, mediaIds, observedAt, note,
      source: { kind: sourceKind, id: sourceId, name: sourceName },
      tier, method, reviewer,
    });
    audit(rec, sourceKind, sourceId, sourceName, 'created', tier);
    persistNow();
    broadcast('evidence', { playerId: player.id });
    res.status(201).json({ evidence: evidenceView(rec) });
  }

  // ----------------------------------------------------------- player routes
  playerRouter.get('/passport', (req, res) => {
    res.json(composePassport(req.player));
  });

  playerRouter.post('/evidence', (req, res) => {
    // Children keep their football life: logging evidence is a football
    // activity (like stats and drills), so minors may self-report — the tier
    // says exactly what that is worth.
    submitClaim(req, res, req.player, 'player', req.player.id, req.player.name, 'self_reported', 'self_entry', null);
  });

  playerRouter.post('/evidence/:id/correct', (req, res) => {
    const orig = db.evidence.find((e) => e.id === req.params.id && e.playerId === req.player.id);
    if (!orig) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    if (orig.source.kind === 'org') return res.status(403).json({ error: 'NOT_YOUR_RECORD', message: 'Club-submitted records are corrected by the club, or disputed.' });
    correctEvidence(req, res, orig, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  playerRouter.post('/evidence/:id/dispute', (req, res) => {
    const rec = db.evidence.find((e) => e.id === req.params.id && e.playerId === req.player.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    fileDispute(req, res, rec, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  function correctEvidence(req, res, orig, actor) {
    const { value, note, reason } = req.body ?? {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Corrections carry a reason — the history stays traceable.' });
    if (!moderateOrRefuse(res, String(reason), { kind: 'evidence_correction', playerId: orig.playerId })) return;
    const player = findPlayer(orig.playerId);
    const rec = newEvidence({
      player, claimType: orig.claimType, label: orig.label,
      value: value ?? orig.value, units: orig.units, season: orig.season,
      mediaIds: orig.mediaIds, observedAt: orig.observedAt, note: note ?? orig.note,
      source: actor, tier: actor.kind === 'org' ? orig.verification.status : 'self_reported',
      method: 'correction', correctionOf: orig.id,
    });
    orig.supersededBy = rec.id;
    audit(orig, actor.kind, actor.id, actor.name, 'superseded', reason);
    audit(rec, actor.kind, actor.id, actor.name, 'created_as_correction', reason);
    persistNow();
    broadcast('evidence', { playerId: orig.playerId });
    res.status(201).json({ evidence: evidenceView(rec), superseded: orig.id });
  }

  function fileDispute(req, res, rec, actor) {
    const { reason } = req.body ?? {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    if (!moderateOrRefuse(res, String(reason), { kind: 'evidence_dispute', playerId: rec.playerId })) return;
    const d = { id: nextId('dsp'), at: Date.now(), by: actor, reason: String(reason).slice(0, 300), status: 'open', resolution: null };
    rec.disputes.push(d);
    audit(rec, actor.kind, actor.id, actor.name, 'disputed', d.reason);
    persistNow();
    res.status(201).json({ dispute: d });
  }

  // --------------------------------------------------------- guardian routes
  guardianRouter.get('/children/:id/passport', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json(composePassport(child));
  });

  guardianRouter.post('/children/:id/evidence', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    submitClaim(req, res, child, 'guardian', req.guardian.id, req.guardian.name, 'self_reported', 'guardian_entry', null);
  });

  // -------------------------------------------------------------- org routes
  orgRouter.get('/players/:id/passport', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    ledgerAppend({ type: 'passport_view', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    res.json(composePassport(p));
  });

  orgRouter.post('/players/:id/evidence', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    submitClaim(req, res, p, 'org', req.org.id, req.org.name, 'club_assessed',
      req.body?.method ? String(req.body.method).slice(0, 80) : 'club_assessment',
      { id: req.orgUser.id, name: req.orgUser.name });
  });

  // Corroboration: an authorised club (or a club-confirmed coach at that
  // club) upgrades a self-reported claim. The original stays; a verification
  // event lands on its history.
  orgRouter.post('/evidence/:id/corroborate', (req, res) => {
    const rec = db.evidence.find((e) => e.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const p = findPlayer(rec.playerId);
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'You can only corroborate claims for players visible to your organisation.' });
    if (rec.verification.status !== 'self_reported') return res.status(409).json({ error: 'ALREADY_VERIFIED', status: rec.verification.status });
    if (rec.supersededBy) return res.status(409).json({ error: 'SUPERSEDED', by: rec.supersededBy });
    const affiliation = activeAffiliation(req.org.id, req.orgUser.name);
    rec.verification = {
      status: affiliation ? 'coach_confirmed' : 'club_assessed',
      method: affiliation ? `confirmed by club-affiliated coach (${affiliation.role})` : `corroborated by ${req.org.name}`,
      reviewerId: req.orgUser.id,
      reviewerName: req.orgUser.name,
      reviewedAt: Date.now(),
    };
    audit(rec, 'org', req.org.id, req.org.name, 'corroborated', rec.verification.status);
    notify({ kind: 'player', id: p.id }, 'evidence', `✅ ${req.org.name} corroborated "${rec.label}" on your evidence passport.`, rec.id);
    if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'evidence', `${req.org.name} corroborated "${rec.label}" on ${p.name}'s evidence passport.`, rec.id);
    persistNow();
    broadcast('evidence', { playerId: p.id });
    res.json({ evidence: evidenceView(rec) });
  });

  orgRouter.post('/evidence/:id/dispute', (req, res) => {
    const rec = db.evidence.find((e) => e.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const p = findPlayer(rec.playerId);
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    fileDispute(req, res, rec, { kind: 'org', id: req.org.id, name: `${req.orgUser.name} · ${req.org.name}` });
  });

  // ------------------------------------------------------------ admin routes
  adminRouter.get('/evidence/disputes', (req, res) => {
    const open = db.evidence
      .flatMap((e) => e.disputes.map((d) => ({ ...d, evidenceId: e.id, playerId: e.playerId, label: e.label, tier: e.verification.status })))
      .filter((d) => req.query.all === '1' || d.status === 'open')
      .sort((a, b) => a.at - b.at);
    res.json(paginate(req, open));
  });

  adminRouter.post('/evidence/disputes/:id/resolve', (req, res) => {
    const rec = db.evidence.find((e) => e.disputes.some((d) => d.id === req.params.id));
    const d = rec?.disputes.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { resolution, note, downgrade } = req.body ?? {};
    if (!['upheld', 'rejected'].includes(resolution)) return res.status(400).json({ error: 'RESOLUTION_REQUIRED', allowed: ['upheld', 'rejected'] });
    d.status = 'resolved';
    d.resolution = { outcome: resolution, note: note ? String(note).slice(0, 300) : null, at: Date.now() };
    if (resolution === 'upheld' && downgrade) {
      rec.verification = { status: 'self_reported', method: 'downgraded after dispute', reviewerId: 'admin', reviewerName: 'Trust & Safety', reviewedAt: Date.now() };
    }
    audit(rec, 'admin', 'admin', 'Trust & Safety', 'dispute_resolved', resolution);
    notify({ kind: 'player', id: rec.playerId }, 'evidence', `Trust & Safety resolved a dispute on "${rec.label}": ${resolution}.`, rec.id);
    persistNow();
    res.json({ dispute: d, evidence: evidenceView(rec) });
  });

  // ================================================================== F10
  // Coach affiliations: the club vouches for the coach, with dates, a
  // conflict declaration and a revocation switch. A confirmed affiliation
  // grants exactly ONE privilege — the coach-confirmed evidence tier at that
  // club. It does NOT grant discovery access, player-data editing, or any
  // contact channel with minors; those walls are untouched.

  function affiliationView(a) {
    const { history, ...rest } = a;
    return { ...rest, current: a.status === 'confirmed' };
  }

  orgRouter.get('/coaches', (req, res) => {
    res.json(db.coachAffiliations.filter((a) => a.orgId === req.org.id).map(affiliationView));
  });

  orgRouter.post('/coaches', (req, res) => {
    const { coachName, coachEmail, role, from, conflictOfInterest } = req.body ?? {};
    if (!coachName || !String(coachName).trim()) return res.status(400).json({ error: 'COACH_NAME_REQUIRED' });
    if (!role || !String(role).trim()) return res.status(400).json({ error: 'ROLE_REQUIRED' });
    const a = {
      id: nextId('aff'), orgId: req.org.id, orgName: req.org.name,
      coachName: String(coachName).trim().slice(0, 80),
      coachEmail: coachEmail ? String(coachEmail).trim().slice(0, 120) : null,
      role: String(role).trim().slice(0, 60),
      from: from ? String(from).slice(0, 10) : new Date().toISOString().slice(0, 10),
      to: null,
      status: 'confirmed', // the CLUB is the confirmer — this endpoint runs under org auth
      confirmedBy: { userId: req.orgUser.id, name: req.orgUser.name },
      conflictOfInterest: conflictOfInterest ? String(conflictOfInterest).slice(0, 200) : null,
      createdAt: Date.now(),
      history: [],
    };
    audit(a, 'org', req.org.id, req.orgUser.name, 'confirmed', a.role);
    db.coachAffiliations.push(a);
    ledgerAppend({ type: 'coach_affiliation_confirmed', orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
    res.status(201).json({ affiliation: affiliationView(a) });
  });

  function closeAffiliation(req, res, status) {
    const a = db.coachAffiliations.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'AFFILIATION_NOT_FOUND' });
    if (a.status !== 'confirmed') return res.status(409).json({ error: 'NOT_CURRENT', status: a.status });
    a.status = status; // 'ended' keeps a clean history; 'revoked' flags cause
    a.to = new Date().toISOString().slice(0, 10);
    audit(a, 'org', req.org.id, req.orgUser.name, status, req.body?.reason ?? null);
    persistNow();
    res.json({ affiliation: affiliationView(a), note: 'Historical references stay attributed; current coach privileges are removed immediately.' });
  }
  orgRouter.post('/coaches/:id/end', (req, res) => closeAffiliation(req, res, 'ended'));
  orgRouter.post('/coaches/:id/revoke', (req, res) => closeAffiliation(req, res, 'revoked'));

  adminRouter.get('/coaches', (req, res) => {
    res.json(paginate(req, db.coachAffiliations.map(affiliationView).sort((a, b) => b.createdAt - a.createdAt)));
  });

  adminRouter.post('/vouches/:id/withdraw', (req, res) => {
    const v = db.vouches.find((x) => x.id === req.params.id);
    if (!v) return res.status(404).json({ error: 'VOUCH_NOT_FOUND' });
    if (v.withdrawn) return res.status(409).json({ error: 'ALREADY_WITHDRAWN' });
    v.withdrawn = { at: Date.now(), by: 'admin', reason: String(req.body?.reason ?? '').slice(0, 200) || 'withdrawn by Trust & Safety' };
    persistNow();
    broadcast('players', { playerId: v.playerId });
    res.json({ withdrawn: v.withdrawn, note: 'The record is kept for history; it no longer appears on any profile view.' });
  });

  // Squad invitations — the controlled onboarding path. A minor's invitation
  // goes to the guardian, an adult's to the player; nobody lands on a squad
  // list (or gets an account) without an approval.
  orgRouter.post('/squad/invite', (req, res) => {
    const p = findPlayer(req.body?.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const note = req.body?.note ? String(req.body.note).slice(0, 200) : null;
    if (note && !moderateOrRefuse(res, note, { kind: 'squad_invite', playerId: p.id, orgId: req.org.id })) return;
    if (db.squadInvites.some((i) => i.orgId === req.org.id && i.playerId === p.id && i.status.startsWith('pending'))) {
      return res.status(409).json({ error: 'INVITE_PENDING' });
    }
    const minor = !isAdult(p);
    const invite = {
      id: nextId('sqi'), orgId: req.org.id, orgName: req.org.name, playerId: p.id, playerName: p.name,
      byUserId: req.orgUser.id, byName: req.orgUser.name, note,
      status: minor ? 'pending_guardian' : 'pending_player',
      createdAt: Date.now(), respondedAt: null,
    };
    db.squadInvites.push(invite);
    if (minor) notify({ kind: 'guardian', id: p.guardianId }, 'squad_invite', `${req.org.name} invites ${p.name} to join their squad list — your approval is required.`, invite.id);
    else notify({ kind: 'player', id: p.id }, 'squad_invite', `${req.org.name} invites you to join their squad list.`, invite.id);
    persistNow();
    res.status(201).json({ invite });
  });

  function respondSquadInvite(req, res, invite, approverLabel) {
    const { accept } = req.body ?? {};
    invite.status = accept ? 'approved' : 'declined';
    invite.respondedAt = Date.now();
    if (accept) {
      const org = db.orgs.find((o) => o.id === invite.orgId);
      org.squad ??= [];
      if (!org.squad.some((s) => s.playerId === invite.playerId)) {
        org.squad.push({ id: nextId('sq'), playerId: invite.playerId, name: invite.playerName, source: 'invite_approved', approvedBy: approverLabel, addedAt: Date.now() });
      }
      notify({ kind: 'org_user', id: invite.byUserId }, 'squad_invite', `✅ ${invite.playerName} joined your squad list (approved by ${approverLabel}).`, invite.id);
    }
    persistNow();
    res.json({ invite });
  }

  playerRouter.get('/squad-invites', (req, res) => {
    res.json(db.squadInvites.filter((i) => i.playerId === req.player.id && i.status === 'pending_player'));
  });
  playerRouter.post('/squad-invites/:id/respond', (req, res) => {
    const invite = db.squadInvites.find((i) => i.id === req.params.id && i.playerId === req.player.id);
    if (!invite) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    if (invite.status === 'pending_guardian') return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian responds to squad invitations.' });
    if (invite.status !== 'pending_player') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    respondSquadInvite(req, res, invite, 'the player');
  });

  guardianRouter.get('/squad-invites', (req, res) => {
    res.json(db.squadInvites.filter((i) => req.guardian.childIds.includes(i.playerId) && i.status === 'pending_guardian'));
  });
  guardianRouter.post('/squad-invites/:id/respond', (req, res) => {
    const invite = db.squadInvites.find((i) => i.id === req.params.id && req.guardian.childIds.includes(i.playerId));
    if (!invite) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    if (invite.status !== 'pending_guardian') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    respondSquadInvite(req, res, invite, `guardian ${req.guardian.name}`);
  });
}
