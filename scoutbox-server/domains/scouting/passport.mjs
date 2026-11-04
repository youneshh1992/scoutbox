// F1 — Player evidence passport · F10 — Coach identity and affiliations.
//
// The principle: evidence reliability is a property of HOW a claim was
// verified, never of how often someone opens the app. Tiers are earned by
// the verifying actor's authority, corrections supersede without erasing,
// and "insufficient evidence" is a first-class display state.

import { parseDateOrInstant, parseStrictDateOnly, isAbsent, readInstant } from '../../temporal.mjs';
import { CLAIM_TYPES, EVIDENCE_LIMITS as LIMITS } from '../../repositories/scoutingEvidence.mjs';

// S9a (migration 0019): the evidence, coach affiliations and squad invitations are typed tables of the scouting evidence
// repository. Every change is an explicit operation (create / update) — a correction, a corroboration with its
// notification, a resolution and an approved invitation with its squad row each commit as one unit of work — and every
// read is a query (scoutingReads). Junk a client sends (a value that is neither a number nor text, a label or reason
// that is not text, a start date that is not a day) is refused with the field named; over-long text is shortened, as
// it always was.

/** A text field from a request: undefined/null → null; text → shortened to `max`; anything else → a 400 sent, returns undefined. */
function textOrRefuse(res, raw, field, max, { required = false } = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    if (required) { res.status(400).json({ error: `${field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_REQUIRED`, field }); return undefined; }
    return null;
  }
  if (typeof raw !== 'string') { res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} must be text.` }); return undefined; }
  return raw.slice(0, max);
}

/**
 * A person's or organisation's name as the evidence tables store it: text, at most `max` characters, or null. Names
 * come from other domains (a player's signup has no length limit; an org dispute stores "scout · club"), so they are
 * shortened here rather than refused: refusing would block a real user's action. See docs/known-issues.md.
 */
const storedName = (name, max = LIMITS.name) => (name === undefined || name === null ? null : String(name).slice(0, max));

export function registerPassport(ctx) {
  const {
    db, byId, nextId, persist, persistNow, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter, adminRouter,
    orgCanSee, paginate, audit, guardianOwnsChild, freshness, activeAffiliation,
    moderateOrRefuse, isAdult, scoutingReads, scoutingEvidence, unit,
  } = ctx;
  if (typeof scoutingEvidence?.evidence?.create !== 'function' || typeof unit !== 'function') throw new TypeError('registerPassport needs the scouting evidence repository and unit from the data layer');
  /** The player's own record, or null. */
  const ownEvidence = (id, playerId) => { const e = scoutingReads.evidence.byId(id); return e && e.playerId === playerId ? e : null; };
  /** The admin lists' offset paging (the `{ total, limit, offset, items }` shape the admin app reads). */
  const offsetPage = (req) => ({ limit: Math.min(Math.max(Math.floor(Number(req.query.limit)) || 50, 1), 200), offset: Math.max(Math.floor(Number(req.query.offset)) || 0, 0) });

  // ------------------------------------------------------------ evidence core
  /** The evidence record a route creates (not yet written): one event, one clock read. */
  function newEvidence({ player, claimType, label, value, units, season, source, mediaIds, observedAt, note, tier, method, reviewer, correctionOf }) {
    // ONE EVENT, ONE CLOCK READ.
    //
    // This used to call `Date.now()` three times — for `recordedAt`, for
    // `verification.reviewedAt` and for `expiresAt`. Creating a record is one
    // event, so those are one instant; reading the clock three times made them
    // *usually* equal and occasionally 1ms apart, whenever a millisecond
    // boundary fell between two statements.
    //
    // That 1ms was not cosmetic. M18's Second Look asks "was this evidence
    // UPGRADED after it was recorded?" by testing `reviewedAt > recordedAt` —
    // the honest way to tell a later confirmation from a tier the record was
    // born with. A one-millisecond drift made a brand-new upload look like a
    // later upgrade of itself, so the same record produced two material
    // changes (`full_match_added` AND `evidence_quality_improved`) and a club
    // was told its evidence had improved when nothing had been reviewed.
    //
    // Nondeterministically: same action, different product output, depending
    // on where a clock tick fell. Taking the instant once makes
    // `reviewedAt === recordedAt` true by construction for evidence created
    // with a tier, so `>` means exactly what M18 reads it to mean.
    const at = Date.now();
    const rec = {
      id: nextId('evd'),
      playerId: player.id,
      claimType,
      label: String(label).slice(0, LIMITS.label),
      value: typeof value === 'string' ? value.slice(0, LIMITS.valueText) : (value ?? null),
      units: units ? String(units).slice(0, LIMITS.units) : null,
      season: season ? String(season).slice(0, LIMITS.season) : null,
      source: { kind: source.kind, id: source.id, name: storedName(source.name, LIMITS.sourceName) ?? '' }, // kind: 'player'|'guardian'|'org'
      // M23 P5.7: an evidence date the route has already validated (readInstant
      // keeps a legacy row's finite number and drops anything else to null).
      observedAt: readInstant(observedAt),
      recordedAt: at,
      mediaIds: Array.isArray(mediaIds) ? mediaIds.filter((m) => player.media.some((x) => x.id === m)) : [],
      verification: {
        // Honest ladder: self_reported | coach_confirmed | club_assessed.
        // 'independent' exists in the schema but no route can set it — there
        // is no integrated independent-measurement provider.
        status: tier,
        method: method ?? null,
        reviewerId: reviewer?.id ?? null,
        reviewerName: storedName(reviewer?.name),
        reviewedAt: reviewer ? at : null,
      },
      expiresAt: claimType === 'availability' ? at + 90 * 86_400_000 : null,
      correctionOf: correctionOf ?? null,
      supersededBy: null,
      disputes: [],
      note: note ? String(note).slice(0, LIMITS.note) : null,
      history: [],
    };
    return rec;
  }
  /** Append an audit entry to a record draft (the shared history shape). */
  const auditDraft = (rec, byKind, byId, byName, action, detail = null) => audit(rec, byKind, byId, storedName(byName), action, detail === null ? null : String(detail).slice(0, LIMITS.detail));

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
    const records = scoutingReads.evidence.forPlayer(player.id).map(evidenceView);
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
    const { claimType, value, mediaIds, observedAt } = req.body ?? {};
    if (!CLAIM_TYPES.includes(claimType)) return res.status(400).json({ error: 'CLAIM_TYPE_INVALID', allowed: CLAIM_TYPES });
    const label = textOrRefuse(res, req.body?.label, 'label', LIMITS.label, { required: true }); if (label === undefined) return;
    const units = textOrRefuse(res, req.body?.units, 'units', LIMITS.units); if (units === undefined) return;
    const season = textOrRefuse(res, req.body?.season, 'season', LIMITS.season); if (season === undefined) return;
    const note = textOrRefuse(res, req.body?.note, 'note', LIMITS.note); if (note === undefined) return;
    if (!(value === undefined || value === null || Number.isFinite(value) || typeof value === 'string')) return res.status(400).json({ error: 'FIELD_INVALID', field: 'value', message: 'value is a number or text.' });
    if (!(mediaIds === undefined || mediaIds === null || (Array.isArray(mediaIds) && mediaIds.every((m) => typeof m === 'string')))) return res.status(400).json({ error: 'FIELD_INVALID', field: 'mediaIds', message: 'mediaIds is a list of media ids.' });
    if (note && !moderateOrRefuse(res, note, { kind: 'evidence_note', playerId: player.id })) return;
    if (!moderateOrRefuse(res, label, { kind: 'evidence_label', playerId: player.id })) return;
    // M23 P5.7 (§16): an observation date is a calendar day or an instant that
    // exists, and not in the future — evidence of something that has not happened is not evidence.
    let observed = null;
    if (!isAbsent(observedAt)) {
      const p = parseDateOrInstant(observedAt, { dayEdge: 'start' });
      if (!p.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'observedAt', message: `observedAt is a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset (${p.why}).`, expected: p.expected });
      if (p.ms > Date.now() + 5 * 60_000) return res.status(400).json({ error: 'DATE_INVALID', field: 'observedAt', message: 'An observation cannot be dated in the future.' });
      observed = p.ms;
    }
    const draft = newEvidence({
      player, claimType, label, value, units, season, mediaIds: Array.isArray(mediaIds) ? [...new Set(mediaIds)] : [], observedAt: observed, note,
      source: { kind: sourceKind, id: sourceId, name: sourceName },
      tier, method, reviewer,
    });
    auditDraft(draft, sourceKind, sourceId, sourceName, 'created', tier);
    const rec = scoutingEvidence.evidence.create(draft);
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
    const orig = ownEvidence(req.params.id, req.player.id);
    if (!orig) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    if (orig.source.kind === 'org') return res.status(403).json({ error: 'NOT_YOUR_RECORD', message: 'Club-submitted records are corrected by the club, or disputed.' });
    correctEvidence(req, res, orig, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  playerRouter.post('/evidence/:id/dispute', (req, res) => {
    const rec = ownEvidence(req.params.id, req.player.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    fileDispute(req, res, rec, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  function correctEvidence(req, res, orig, actor) {
    const { value } = req.body ?? {};
    if (req.body?.reason === undefined || req.body?.reason === null || (typeof req.body.reason === 'string' && !req.body.reason.trim())) return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Corrections carry a reason — the history stays traceable.' });
    const reason = textOrRefuse(res, req.body.reason, 'reason', LIMITS.reason); if (reason === undefined) return;
    const note = textOrRefuse(res, req.body?.note, 'note', LIMITS.note); if (note === undefined) return;
    if (!(value === undefined || value === null || Number.isFinite(value) || typeof value === 'string')) return res.status(400).json({ error: 'FIELD_INVALID', field: 'value', message: 'value is a number or text.' });
    if (!moderateOrRefuse(res, reason, { kind: 'evidence_correction', playerId: orig.playerId })) return;
    const player = findPlayer(orig.playerId);
    const draft = newEvidence({
      player, claimType: orig.claimType, label: orig.label,
      value: value ?? orig.value, units: orig.units, season: orig.season,
      mediaIds: orig.mediaIds, observedAt: orig.observedAt, note: note ?? orig.note,
      source: actor, tier: actor.kind === 'org' ? orig.verification.status : 'self_reported',
      method: 'correction', correctionOf: orig.id,
    });
    auditDraft(draft, actor.kind, actor.id, actor.name, 'created_as_correction', reason);
    // The correction and the superseded original commit together.
    const rec = unit(() => {
      const created = scoutingEvidence.evidence.create(draft);
      scoutingEvidence.evidence.update(orig.id, (o) => { o.supersededBy = created.id; auditDraft(o, actor.kind, actor.id, actor.name, 'superseded', reason); });
      return created;
    });
    persistNow();
    broadcast('evidence', { playerId: orig.playerId });
    res.status(201).json({ evidence: evidenceView(rec), superseded: orig.id });
  }

  function fileDispute(req, res, rec, actor) {
    const reason = textOrRefuse(res, req.body?.reason, 'reason', LIMITS.reason, { required: true }); if (reason === undefined) return;
    if (!moderateOrRefuse(res, reason, { kind: 'evidence_dispute', playerId: rec.playerId })) return;
    const d = { id: nextId('dsp'), at: Date.now(), by: { kind: actor.kind, id: actor.id, name: storedName(actor.name) }, reason, status: 'open', resolution: null };
    scoutingEvidence.evidence.update(rec.id, (e) => { e.disputes.push(d); auditDraft(e, actor.kind, actor.id, actor.name, 'disputed', d.reason); });
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
    const rec = scoutingReads.evidence.byId(req.params.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const p = findPlayer(rec.playerId);
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'You can only corroborate claims for players visible to your organisation.' });
    if (rec.verification.status !== 'self_reported') return res.status(409).json({ error: 'ALREADY_VERIFIED', status: rec.verification.status });
    if (rec.supersededBy) return res.status(409).json({ error: 'SUPERSEDED', by: rec.supersededBy });
    const affiliation = activeAffiliation(req.org.id, req.orgUser.name);
    const verification = {
      status: affiliation ? 'coach_confirmed' : 'club_assessed',
      method: (affiliation ? `confirmed by club-affiliated coach (${affiliation.role})` : `corroborated by ${req.org.name}`).slice(0, LIMITS.method),
      reviewerId: req.orgUser.id,
      reviewerName: storedName(req.orgUser.name),
      reviewedAt: Date.now(),
    };
    // The upgrade and its notifications commit together.
    const fresh = unit(() => {
      const next = scoutingEvidence.evidence.update(rec.id, (e) => { e.verification = verification; auditDraft(e, 'org', req.org.id, req.org.name, 'corroborated', verification.status); });
      notify({ kind: 'player', id: p.id }, 'evidence', `✅ ${req.org.name} corroborated "${rec.label}" on your evidence passport.`, rec.id);
      if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'evidence', `${req.org.name} corroborated "${rec.label}" on ${p.name}'s evidence passport.`, rec.id);
      return next;
    });
    persistNow();
    broadcast('evidence', { playerId: p.id });
    res.json({ evidence: evidenceView(fresh) });
  });

  orgRouter.post('/evidence/:id/dispute', (req, res) => {
    const rec = scoutingReads.evidence.byId(req.params.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const p = findPlayer(rec.playerId);
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    fileDispute(req, res, rec, { kind: 'org', id: req.org.id, name: `${req.orgUser.name} · ${req.org.name}` });
  });

  // ------------------------------------------------------------ admin routes
  adminRouter.get('/evidence/disputes', (req, res) => {
    res.json(scoutingReads.evidence.disputePage({ all: req.query.all === '1', ...offsetPage(req) }));
  });

  adminRouter.post('/evidence/disputes/:id/resolve', (req, res) => {
    const rec = scoutingReads.evidence.byDispute(req.params.id);
    const d = rec?.disputes.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { resolution, downgrade } = req.body ?? {};
    if (!['upheld', 'rejected'].includes(resolution)) return res.status(400).json({ error: 'RESOLUTION_REQUIRED', allowed: ['upheld', 'rejected'] });
    const note = textOrRefuse(res, req.body?.note, 'note', LIMITS.resolutionNote); if (note === undefined) return;
    const at = Date.now();
    // The resolution, any downgrade and the player's notification commit together.
    const fresh = unit(() => {
      const next = scoutingEvidence.evidence.update(rec.id, (e) => {
        const target = e.disputes.find((x) => x.id === d.id);
        target.status = 'resolved';
        target.resolution = { outcome: resolution, note, at };
        if (resolution === 'upheld' && downgrade) e.verification = { status: 'self_reported', method: 'downgraded after dispute', reviewerId: 'admin', reviewerName: 'Trust & Safety', reviewedAt: at };
        auditDraft(e, 'admin', 'admin', 'Trust & Safety', 'dispute_resolved', resolution);
      });
      notify({ kind: 'player', id: rec.playerId }, 'evidence', `Trust & Safety resolved a dispute on "${rec.label}": ${resolution}.`, rec.id);
      return next;
    });
    persistNow();
    res.json({ dispute: fresh.disputes.find((x) => x.id === d.id), evidence: evidenceView(fresh) });
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
    res.json(scoutingReads.coachAffiliations.forOrg(req.org.id).map(affiliationView));
  });

  orgRouter.post('/coaches', (req, res) => {
    const coachName = textOrRefuse(res, typeof req.body?.coachName === 'string' ? req.body.coachName.trim() : req.body?.coachName, 'coachName', LIMITS.coachName, { required: true }); if (coachName === undefined) return;
    const role = textOrRefuse(res, typeof req.body?.role === 'string' ? req.body.role.trim() : req.body?.role, 'role', LIMITS.role, { required: true }); if (role === undefined) return;
    const coachEmail = textOrRefuse(res, typeof req.body?.coachEmail === 'string' ? req.body.coachEmail.trim() : req.body?.coachEmail, 'coachEmail', LIMITS.coachEmail); if (coachEmail === undefined) return;
    const conflictOfInterest = textOrRefuse(res, req.body?.conflictOfInterest, 'conflictOfInterest', LIMITS.conflict); if (conflictOfInterest === undefined) return;
    let from = new Date().toISOString().slice(0, 10);
    if (!isAbsent(req.body?.from)) {
      const d = parseStrictDateOnly(req.body.from);
      if (!d.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'from', message: `from is a calendar day (YYYY-MM-DD) (${d.why}).`, expected: d.expected });
      from = req.body.from;
    }
    const draft = {
      id: nextId('aff'), orgId: req.org.id, orgName: storedName(req.org.name),
      coachName, coachEmail, role, from,
      to: null,
      status: 'confirmed', // the CLUB is the confirmer — this endpoint runs under org auth
      confirmedBy: { userId: req.orgUser.id, name: storedName(req.orgUser.name) },
      conflictOfInterest,
      createdAt: Date.now(),
      history: [],
    };
    auditDraft(draft, 'org', req.org.id, req.orgUser.name, 'confirmed', draft.role);
    const a = scoutingEvidence.coachAffiliations.create(draft);
    ledgerAppend({ type: 'coach_affiliation_confirmed', orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
    res.status(201).json({ affiliation: affiliationView(a) });
  });

  function closeAffiliation(req, res, status) {
    const found = scoutingReads.coachAffiliations.byId(req.params.id);
    const a = found && found.orgId === req.org.id ? found : null;
    if (!a) return res.status(404).json({ error: 'AFFILIATION_NOT_FOUND' });
    if (a.status !== 'confirmed') return res.status(409).json({ error: 'NOT_CURRENT', status: a.status });
    const reason = textOrRefuse(res, req.body?.reason, 'reason', LIMITS.closeReason); if (reason === undefined) return;
    const fresh = scoutingEvidence.coachAffiliations.update(a.id, (x) => {
      x.status = status; // 'ended' keeps a clean history; 'revoked' flags cause
      x.to = new Date().toISOString().slice(0, 10);
      auditDraft(x, 'org', req.org.id, req.orgUser.name, status, reason);
    });
    persistNow();
    res.json({ affiliation: affiliationView(fresh), note: 'Historical references stay attributed; current coach privileges are removed immediately.' });
  }
  orgRouter.post('/coaches/:id/end', (req, res) => closeAffiliation(req, res, 'ended'));
  orgRouter.post('/coaches/:id/revoke', (req, res) => closeAffiliation(req, res, 'revoked'));

  adminRouter.get('/coaches', (req, res) => {
    const page = scoutingReads.coachAffiliations.page(offsetPage(req));
    res.json({ ...page, items: page.items.map(affiliationView) });
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
    const note = textOrRefuse(res, req.body?.note, 'note', LIMITS.inviteNote); if (note === undefined) return;
    if (note && !moderateOrRefuse(res, note, { kind: 'squad_invite', playerId: p.id, orgId: req.org.id })) return;
    if (scoutingReads.squadInvites.pendingFor(req.org.id, p.id)) {
      return res.status(409).json({ error: 'INVITE_PENDING' });
    }
    const minor = !isAdult(p);
    const draft = {
      id: nextId('sqi'), orgId: req.org.id, orgName: storedName(req.org.name), playerId: p.id, playerName: storedName(p.name),
      byUserId: req.orgUser.id, byName: storedName(req.orgUser.name), note,
      status: minor ? 'pending_guardian' : 'pending_player',
      createdAt: Date.now(), respondedAt: null,
    };
    const invite = unit(() => {
      const created = scoutingEvidence.squadInvites.create(draft);
      if (minor) notify({ kind: 'guardian', id: p.guardianId }, 'squad_invite', `${req.org.name} invites ${p.name} to join their squad list — your approval is required.`, created.id);
      else notify({ kind: 'player', id: p.id }, 'squad_invite', `${req.org.name} invites you to join their squad list.`, created.id);
      return created;
    });
    persistNow();
    res.status(201).json({ invite });
  });
  // The answer, the squad row (the org's squad facet until S9c) and the notification commit together.
  function respondSquadInvite(req, res, invite, approverLabel) {
    const { accept } = req.body ?? {};
    const at = Date.now();
    const fresh = unit(() => {
      const next = scoutingEvidence.squadInvites.update(invite.id, (i) => { i.status = accept ? 'approved' : 'declined'; i.respondedAt = at; });
      if (accept) {
        const org = byId.org(invite.orgId);
        org.squad ??= [];
        if (!org.squad.some((s) => s.playerId === invite.playerId)) {
          org.squad.push({ id: nextId('sq'), playerId: invite.playerId, name: invite.playerName, source: 'invite_approved', approvedBy: approverLabel, addedAt: at });
        }
        notify({ kind: 'org_user', id: invite.byUserId }, 'squad_invite', `✅ ${invite.playerName} joined your squad list (approved by ${approverLabel}).`, invite.id);
      }
      return next;
    });
    persistNow();
    res.json({ invite: fresh });
  }

  playerRouter.get('/squad-invites', (req, res) => {
    res.json(scoutingReads.squadInvites.forPlayers([req.player.id], 'pending_player'));
  });
  playerRouter.post('/squad-invites/:id/respond', (req, res) => {
    const found = scoutingReads.squadInvites.byId(req.params.id);
    const invite = found && found.playerId === req.player.id ? found : null;
    if (!invite) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    if (invite.status === 'pending_guardian') return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian responds to squad invitations.' });
    if (invite.status !== 'pending_player') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    respondSquadInvite(req, res, invite, 'the player');
  });

  guardianRouter.get('/squad-invites', (req, res) => {
    res.json(scoutingReads.squadInvites.forPlayers(req.guardian.childIds, 'pending_guardian'));
  });
  guardianRouter.post('/squad-invites/:id/respond', (req, res) => {
    const found = scoutingReads.squadInvites.byId(req.params.id);
    const invite = found && req.guardian.childIds.includes(found.playerId) ? found : null;
    if (!invite) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    if (invite.status !== 'pending_guardian') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    respondSquadInvite(req, res, invite, `guardian ${req.guardian.name}`);
  });
}
