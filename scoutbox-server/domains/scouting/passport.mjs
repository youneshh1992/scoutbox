// Evidence reliability is a property of how a claim was verified, never of how often someone opens the app. Tiers
// are earned by the verifying actor's authority, corrections supersede without erasing, and "insufficient evidence"
// is a first-class display state.

import { declareAuditedRead } from '../../writeRules.mjs';
import * as v from 'valibot';
import { parseDateOrInstant, isAbsent, readInstant } from '../../temporal.mjs';
import { offsetPage } from '../platform/paging.mjs';
import {
  OFFSET_PAGE,
  OFFSET_PAGE_CODES,
  dayOrBlank,
  dueDate,
  filled,
  flag,
  id,
  idList,
  inputOrRefuse,
  oneOf,
  presentOrRefuse,
  text,
} from '../platform/schemas.mjs';
import { CLAIM_TYPES, EVIDENCE_LIMITS as LIMITS } from '../../repositories/scoutingEvidence.mjs';

const MEDIA_PER_CLAIM = 50;
const optText = (max) => v.nullish(text(max));
const claimValue = v.nullish(v.union([v.pipe(v.number(), v.finite()), text(LIMITS.valueText)]));
const CLAIM_FIELDS = {
  claimType: oneOf(CLAIM_TYPES),
  label: optText(LIMITS.label),
  value: claimValue,
  units: optText(LIMITS.units),
  season: optText(LIMITS.season),
  note: optText(LIMITS.note),
  mediaIds: v.nullish(idList(MEDIA_PER_CLAIM)),
  observedAt: v.optional(dueDate),
};
const NewClaim = v.strictObject(CLAIM_FIELDS);
const NewClubClaim = v.strictObject({ ...CLAIM_FIELDS, method: optText(LIMITS.method) });
const CLAIM_CODES = { fieldCodes: { claimType: 'CLAIM_TYPE_INVALID' } };
const Correction = v.strictObject({ value: claimValue, reason: optText(LIMITS.reason), note: optText(LIMITS.note) });
const Dispute = v.strictObject({ reason: optText(LIMITS.reason) });
const DisputeResolution = v.strictObject({
  resolution: oneOf(['upheld', 'rejected']),
  downgrade: v.optional(flag),
  note: optText(LIMITS.resolutionNote),
});
const RESOLUTION_CODES = { fieldCodes: { resolution: 'RESOLUTION_REQUIRED' } };
const NewAffiliation = v.strictObject({
  coachName: optText(LIMITS.coachName),
  role: optText(LIMITS.role),
  coachEmail: optText(LIMITS.coachEmail),
  conflictOfInterest: optText(LIMITS.conflict),
  from: v.nullish(dayOrBlank),
});
const AffiliationClose = v.strictObject({ reason: optText(LIMITS.closeReason) });
const VouchWithdrawal = v.strictObject({ reason: optText(200) });
const SquadInvite = v.strictObject({ playerId: id, note: optText(LIMITS.inviteNote) });
const InviteAnswer = v.strictObject({ accept: flag });
const DisputeQuery = v.strictObject({ all: v.optional(oneOf(['0', '1'])), ...OFFSET_PAGE });
const PageQuery = v.strictObject(OFFSET_PAGE);
const QUERY = { root: 'query', fieldCodes: OFFSET_PAGE_CODES };

/**
 * A name as the evidence tables store it: text, at most `max` characters, or null. Names come from other domains (a
 * player's signup has no length limit; an org dispute stores "scout · club"), so they are shortened rather than
 * refused: refusing would block a real user's action. See docs/known-issues.md.
 */
export const storedName = (name, max = LIMITS.name) =>
  name === undefined || name === null ? null : String(name).slice(0, max);

export function registerPassport(ctx) {
  const {
    byId,
    nextId,
    notify,
    ledgerAppend,
    broadcast,
    findPlayer,
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    orgCanSee,
    paginate,
    auditEntry,
    guardianOwnsChild,
    freshness,
    activeAffiliation,
    moderateOrRefuse,
    isAdult,
    scoutingReads,
    scoutingEvidence,
    unit,
    joinSquad,
    transitionsVouches,
    coachReferences,
    verificationReads, // coach references are rows of vouches
  } = ctx;
  if (typeof scoutingEvidence?.evidence?.create !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerPassport needs the scouting evidence repository and unit from the data layer');
  const ownEvidence = (id, playerId) => {
    const e = scoutingReads.evidence.byId(id);
    return e && e.playerId === playerId ? e : null;
  };

  // ------------------------------------------------------------ evidence core
  function newEvidence({
    player,
    claimType,
    label,
    value,
    units,
    season,
    source,
    mediaIds,
    observedAt,
    note,
    tier,
    method,
    reviewer,
    correctionOf,
  }) {
    // One clock read: Second Look asks whether evidence was upgraded after it was recorded (`reviewedAt > recordedAt`),
    // and separate reads could land 1ms apart and make a new upload look like a later upgrade of itself.
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
      observedAt: readInstant(observedAt),
      recordedAt: at,
      mediaIds: Array.isArray(mediaIds) ? mediaIds.filter((m) => player.media.some((x) => x.id === m)) : [],
      verification: {
        // 'independent' exists in the schema but no route sets it: there is no independent-measurement provider.
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
  /** One history entry, as an act's bookkeeping (`{ history: [entry] }`). */
  const logged = (byKind, byId, byName, action, detail = null) => ({
    history: [
      auditEntry(
        byKind,
        byId,
        storedName(byName),
        action,
        detail === null ? null : String(detail).slice(0, LIMITS.detail),
      ),
    ],
  });
  const auditDraft = (rec, ...entry) => {
    rec.history ??= [];
    rec.history.push(...logged(...entry).history);
  };

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

  // Evidence records plus the honest relabelling of every other "verified" surface. Reliability is not ability:
  // nothing here scores the player.
  function composePassport(player) {
    const records = scoutingReads.evidence.forPlayer(player.id).map(evidenceView);
    const legacy = [];
    for (const a of player.attendance ?? []) {
      if (a.corroboratedBy) {
        legacy.push({
          kind: 'attendance',
          label: `Match attendance ${a.fixture ?? ''}`.trim(),
          tier: 'club_assessed',
          method: `match-day roster credited by ${a.corroboratedBy}`,
          at: a.date ?? null,
        });
      }
    }
    for (const v of verificationReads.vouches.publishedFor(player.id)) {
      legacy.push({
        kind: 'reference',
        label: `Reference from ${v.coachName} (${v.role})`,
        tier: 'coach_confirmed',
        method: 'email_code',
        identityVerified: false,
        caveat: 'Email-code reference: confirms mailbox control, not coach identity.',
        conflictOfInterest: v.conflictOfInterest ?? null,
      });
    }
    for (const r of player.drillResults ?? []) {
      legacy.push({
        kind: 'assessment_result',
        label: `Combine drill ${r.drillId}: ${r.value}`,
        tier: 'self_reported',
        method: r.videoMediaId || r.verified ? 'video_attached' : 'self_entry',
        caveat:
          r.videoMediaId || r.verified
            ? 'An attached video is not a verified measurement — no validated video-analysis capability exists.'
            : undefined,
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
        insufficient: active.length + legacy.length < 3,
        note: 'Provenance describes how each claim was checked — it is not a rating of football ability, and app usage frequency plays no part in it.',
      },
    };
  }

  function submitClaim(req, res, player, sourceKind, sourceId, sourceName, tier, method, reviewer) {
    const body = inputOrRefuse(res, sourceKind === 'org' ? NewClubClaim : NewClaim, req.body ?? {}, CLAIM_CODES);
    if (!body) return;
    const { claimType, value, mediaIds, observedAt } = body;
    const label = filled(body.label);
    if (!presentOrRefuse(res, label, 'label')) return;
    const units = filled(body.units);
    const season = filled(body.season);
    const note = filled(body.note);
    if (sourceKind === 'org') method = filled(body.method) ?? method;
    if (note && !moderateOrRefuse(res, note, { kind: 'evidence_note', playerId: player.id })) return;
    if (!moderateOrRefuse(res, label, { kind: 'evidence_label', playerId: player.id })) return;
    // Evidence of something that has not happened is not evidence.
    let observed = null;
    if (!isAbsent(observedAt)) {
      const p = parseDateOrInstant(observedAt, { dayEdge: 'start' });
      if (p.ms > Date.now() + 5 * 60_000)
        return res.status(400).json({
          error: 'DATE_INVALID',
          field: 'observedAt',
          message: 'An observation cannot be dated in the future.',
        });
      observed = p.ms;
    }
    const draft = newEvidence({
      player,
      claimType,
      label,
      value,
      units,
      season,
      mediaIds: [...new Set(mediaIds ?? [])],
      observedAt: observed,
      note,
      source: { kind: sourceKind, id: sourceId, name: sourceName },
      tier,
      method,
      reviewer,
    });
    auditDraft(draft, sourceKind, sourceId, sourceName, 'created', tier);
    const rec = scoutingEvidence.evidence.create(draft);
    broadcast('evidence', { playerId: player.id });
    res.status(201).json({ evidence: evidenceView(rec) });
  }

  // ----------------------------------------------------------- player routes
  playerRouter.get('/passport', (req, res) => {
    res.json(composePassport(req.player));
  });

  playerRouter.post('/evidence', (req, res) => {
    // Logging evidence is football activity (like stats and drills), so minors may self-report; the tier says what
    // that is worth.
    submitClaim(req, res, req.player, 'player', req.player.id, req.player.name, 'self_reported', 'self_entry', null);
  });

  playerRouter.post('/evidence/:id/correct', (req, res) => {
    const orig = ownEvidence(req.params.id, req.player.id);
    if (!orig) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    if (orig.source.kind === 'org')
      return res
        .status(403)
        .json({ error: 'NOT_YOUR_RECORD', message: 'Club-submitted records are corrected by the club, or disputed.' });
    correctEvidence(req, res, orig, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  playerRouter.post('/evidence/:id/dispute', (req, res) => {
    const rec = ownEvidence(req.params.id, req.player.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    fileDispute(req, res, rec, { kind: 'player', id: req.player.id, name: req.player.name });
  });

  function correctEvidence(req, res, orig, actor) {
    const body = inputOrRefuse(res, Correction, req.body ?? {});
    if (!body) return;
    const { value } = body;
    const reason = filled(body.reason);
    if (
      !presentOrRefuse(res, reason, 'reason', { message: 'Corrections carry a reason — the history stays traceable.' })
    )
      return;
    const note = filled(body.note);
    if (!moderateOrRefuse(res, reason, { kind: 'evidence_correction', playerId: orig.playerId })) return;
    const player = findPlayer(orig.playerId);
    const draft = newEvidence({
      player,
      claimType: orig.claimType,
      label: orig.label,
      value: value ?? orig.value,
      units: orig.units,
      season: orig.season,
      mediaIds: orig.mediaIds,
      observedAt: orig.observedAt,
      note: note ?? orig.note,
      source: actor,
      tier: actor.kind === 'org' ? orig.verification.status : 'self_reported',
      method: 'correction',
      correctionOf: orig.id,
    });
    auditDraft(draft, actor.kind, actor.id, actor.name, 'created_as_correction', reason);
    const rec = unit(() => {
      const created = scoutingEvidence.evidence.create(draft);
      scoutingEvidence.evidence.supersede(
        orig.id,
        { by: created.id },
        logged(actor.kind, actor.id, actor.name, 'superseded', reason),
      );
      return created;
    });
    broadcast('evidence', { playerId: orig.playerId });
    res.status(201).json({ evidence: evidenceView(rec), superseded: orig.id });
  }

  function fileDispute(req, res, rec, actor) {
    const body = inputOrRefuse(res, Dispute, req.body ?? {});
    if (!body) return;
    const reason = filled(body.reason);
    if (!presentOrRefuse(res, reason, 'reason')) return;
    if (!moderateOrRefuse(res, reason, { kind: 'evidence_dispute', playerId: rec.playerId })) return;
    const d = {
      id: nextId('dsp'),
      at: Date.now(),
      by: { kind: actor.kind, id: actor.id, name: storedName(actor.name) },
      reason,
      status: 'open',
      resolution: null,
    };
    scoutingEvidence.evidence.fileDispute(
      rec.id,
      { dispute: d },
      logged(actor.kind, actor.id, actor.name, 'disputed', d.reason),
    );
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
    submitClaim(
      req,
      res,
      child,
      'guardian',
      req.guardian.id,
      req.guardian.name,
      'self_reported',
      'guardian_entry',
      null,
    );
  });

  // -------------------------------------------------------------- org routes
  orgRouter.get('/players/:id/passport', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p))
      return res
        .status(403)
        .json({ error: req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    declareAuditedRead("the Discovery Ledger records who viewed a player's passport");
    ledgerAppend({
      type: 'passport_view',
      playerId: p.id,
      orgId: req.org.id,
      orgName: req.org.name,
      userId: req.orgUser.id,
      scoutName: req.orgUser.name,
    });
    res.json(composePassport(p));
  });

  orgRouter.post('/players/:id/evidence', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    submitClaim(req, res, p, 'org', req.org.id, req.org.name, 'club_assessed', 'club_assessment', {
      id: req.orgUser.id,
      name: req.orgUser.name,
    });
  });

  // An authorised club (or a club-confirmed coach there) upgrades a self-reported claim; the original stays.
  orgRouter.post('/evidence/:id/corroborate', (req, res) => {
    const rec = scoutingReads.evidence.byId(req.params.id);
    if (!rec) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const p = findPlayer(rec.playerId);
    if (!orgCanSee(req.org, p))
      return res.status(403).json({
        error: 'NOT_VISIBLE',
        message: 'You can only corroborate claims for players visible to your organisation.',
      });
    if (rec.verification.status !== 'self_reported')
      return res.status(409).json({ error: 'ALREADY_VERIFIED', status: rec.verification.status });
    if (rec.supersededBy) return res.status(409).json({ error: 'SUPERSEDED', by: rec.supersededBy });
    const affiliation = activeAffiliation(req.org.id, req.orgUser.name);
    const verification = {
      status: affiliation ? 'coach_confirmed' : 'club_assessed',
      method: (affiliation
        ? `confirmed by club-affiliated coach (${affiliation.role})`
        : `corroborated by ${req.org.name}`
      ).slice(0, LIMITS.method),
      reviewerId: req.orgUser.id,
      reviewerName: storedName(req.orgUser.name),
      reviewedAt: Date.now(),
    };
    const fresh = unit(() => {
      const next = scoutingEvidence.evidence.corroborate(
        rec.id,
        { verification },
        logged('org', req.org.id, req.org.name, 'corroborated', verification.status),
      );
      notify(
        { kind: 'player', id: p.id },
        'evidence',
        `✅ ${req.org.name} corroborated "${rec.label}" on your evidence passport.`,
        rec.id,
      );
      if (p.guardianId)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'evidence',
          `${req.org.name} corroborated "${rec.label}" on ${p.name}'s evidence passport.`,
          rec.id,
        );
      return next;
    });
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
    const query = inputOrRefuse(res, DisputeQuery, req.query ?? {}, QUERY);
    if (!query) return;
    res.json(scoutingReads.evidence.disputePage({ all: query.all === '1', ...offsetPage(query) }));
  });

  adminRouter.post('/evidence/disputes/:id/resolve', (req, res) => {
    const rec = scoutingReads.evidence.byDispute(req.params.id);
    const d = rec?.disputes.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const body = inputOrRefuse(res, DisputeResolution, req.body ?? {}, RESOLUTION_CODES);
    if (!body) return;
    const { resolution, downgrade = false } = body;
    const note = filled(body.note);
    const at = Date.now();
    const fresh = unit(() => {
      const next = scoutingEvidence.evidence.resolveDispute(
        rec.id,
        {
          disputeId: d.id,
          outcome: resolution,
          note,
          at,
          downgrade:
            resolution === 'upheld' && downgrade
              ? {
                  status: 'self_reported',
                  method: 'downgraded after dispute',
                  reviewerId: 'admin',
                  reviewerName: 'Trust & Safety',
                  reviewedAt: at,
                }
              : null,
        },
        logged('admin', 'admin', 'Trust & Safety', 'dispute_resolved', resolution),
      );
      notify(
        { kind: 'player', id: rec.playerId },
        'evidence',
        `Trust & Safety resolved a dispute on "${rec.label}": ${resolution}.`,
        rec.id,
      );
      return next;
    });
    res.json({ dispute: fresh.disputes.find((x) => x.id === d.id), evidence: evidenceView(fresh) });
  });

  // ============================================================ affiliations
  // A confirmed affiliation grants one privilege: the coach-confirmed evidence tier at that club. Not discovery
  // access, player-data editing, or any contact channel with minors.

  function affiliationView(a) {
    const { history, ...rest } = a;
    return { ...rest, current: a.status === 'confirmed' };
  }

  orgRouter.get('/coaches', (req, res) => {
    res.json(scoutingReads.coachAffiliations.forOrg(req.org.id).map(affiliationView));
  });

  orgRouter.post('/coaches', (req, res) => {
    const body = inputOrRefuse(res, NewAffiliation, req.body ?? {});
    if (!body) return;
    const coachName = filled(body.coachName);
    if (!presentOrRefuse(res, coachName, 'coachName')) return;
    const role = filled(body.role);
    if (!presentOrRefuse(res, role, 'role')) return;
    const coachEmail = filled(body.coachEmail);
    const conflictOfInterest = filled(body.conflictOfInterest);
    const from = body.from || new Date().toISOString().slice(0, 10);
    const draft = {
      id: nextId('aff'),
      orgId: req.org.id,
      orgName: storedName(req.org.name),
      coachName,
      coachEmail,
      role,
      from,
      to: null,
      status: 'confirmed', // the club is the confirmer: this route runs under org auth
      confirmedBy: { userId: req.orgUser.id, name: storedName(req.orgUser.name) },
      conflictOfInterest,
      createdAt: Date.now(),
      history: [],
    };
    auditDraft(draft, 'org', req.org.id, req.orgUser.name, 'confirmed', draft.role);
    const a = unit(() => {
      const created = scoutingEvidence.coachAffiliations.create(draft);
      ledgerAppend({
        type: 'coach_affiliation_confirmed',
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
      return created;
    });
    res.status(201).json({ affiliation: affiliationView(a) });
  });

  function closeAffiliation(req, res, status) {
    const found = scoutingReads.coachAffiliations.byId(req.params.id);
    const a = found && found.orgId === req.org.id ? found : null;
    if (!a) return res.status(404).json({ error: 'AFFILIATION_NOT_FOUND' });
    if (a.status !== 'confirmed') return res.status(409).json({ error: 'NOT_CURRENT', status: a.status });
    const body = inputOrRefuse(res, AffiliationClose, req.body ?? {});
    if (!body) return;
    const reason = filled(body.reason);
    // 'ended' keeps a clean history; 'revoked' flags cause.
    const fresh = scoutingEvidence.coachAffiliations.close(
      a.id,
      { status, to: new Date().toISOString().slice(0, 10) },
      logged('org', req.org.id, req.orgUser.name, status, reason),
    );
    res.json({
      affiliation: affiliationView(fresh),
      note: 'Historical references stay attributed; current coach privileges are removed immediately.',
    });
  }
  orgRouter.post('/coaches/:id/end', (req, res) => closeAffiliation(req, res, 'ended'));
  orgRouter.post('/coaches/:id/revoke', (req, res) => closeAffiliation(req, res, 'revoked'));

  adminRouter.get('/coaches', (req, res) => {
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, QUERY);
    if (!query) return;
    const page = scoutingReads.coachAffiliations.page(offsetPage(query));
    res.json({ ...page, items: page.items.map(affiliationView) });
  });

  adminRouter.post('/vouches/:id/withdraw', (req, res) => {
    const v = verificationReads.vouches.byId(req.params.id);
    if (!v) return res.status(404).json({ error: 'VOUCH_NOT_FOUND' });
    if (v.withdrawn) return res.status(409).json({ error: 'ALREADY_WITHDRAWN' });
    const body = inputOrRefuse(res, VouchWithdrawal, req.body ?? {});
    if (!body) return;
    const stored = unit(() =>
      coachReferences.withdraw(v.id, {
        at: Date.now(),
        by: 'admin',
        reason: filled(body.reason) ?? 'withdrawn by Trust & Safety',
      }),
    );
    broadcast('players', { playerId: v.playerId });
    res.json({
      withdrawn: { at: stored.withdrawn.at, by: stored.withdrawn.by, reason: stored.withdrawn.reason },
      note: 'The record is kept for history; it no longer appears on any profile view.',
    });
  });

  // A minor's invitation goes to the guardian, an adult's to the player; nobody joins a squad (or gets an account)
  // without an approval.
  orgRouter.post('/squad/invite', (req, res) => {
    const body = inputOrRefuse(res, SquadInvite, req.body ?? {});
    if (!body) return;
    const p = findPlayer(body.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const note = filled(body.note);
    if (note && !moderateOrRefuse(res, note, { kind: 'squad_invite', playerId: p.id, orgId: req.org.id })) return;
    if (scoutingReads.squadInvites.pendingFor(req.org.id, p.id)) {
      return res.status(409).json({ error: 'INVITE_PENDING' });
    }
    const minor = !isAdult(p);
    const draft = {
      id: nextId('sqi'),
      orgId: req.org.id,
      orgName: storedName(req.org.name),
      playerId: p.id,
      playerName: storedName(p.name),
      byUserId: req.orgUser.id,
      byName: storedName(req.orgUser.name),
      note,
      status: minor ? 'pending_guardian' : 'pending_player',
      createdAt: Date.now(),
      respondedAt: null,
    };
    const invite = unit(() => {
      const created = scoutingEvidence.squadInvites.create(draft);
      if (minor)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'squad_invite',
          `${req.org.name} invites ${p.name} to join their squad list — your approval is required.`,
          created.id,
        );
      else
        notify(
          { kind: 'player', id: p.id },
          'squad_invite',
          `${req.org.name} invites you to join their squad list.`,
          created.id,
        );
      return created;
    });
    res.status(201).json({ invite });
  });
  function respondSquadInvite(req, res, invite, approverLabel) {
    const body = inputOrRefuse(res, InviteAnswer, req.body ?? {});
    if (!body) return;
    const { accept } = body;
    const at = Date.now();
    const fresh = unit(() => {
      const next = scoutingEvidence.squadInvites.respond(invite.id, { accept, at });
      if (accept) {
        joinSquad({
          orgId: invite.orgId,
          playerId: invite.playerId,
          name: invite.playerName ?? findPlayer(invite.playerId)?.name,
          source: 'invite_approved',
          approvedBy: storedName(approverLabel),
          at,
        });
        notify(
          { kind: 'org_user', id: invite.byUserId },
          'squad_invite',
          `✅ ${invite.playerName} joined your squad list (approved by ${approverLabel}).`,
          invite.id,
        );
      }
      return next;
    });
    res.json({ invite: fresh });
  }

  playerRouter.get('/squad-invites', (req, res) => {
    res.json(scoutingReads.squadInvites.forPlayers([req.player.id], 'pending_player'));
  });
  playerRouter.post('/squad-invites/:id/respond', (req, res) => {
    const found = scoutingReads.squadInvites.byId(req.params.id);
    const invite = found && found.playerId === req.player.id ? found : null;
    if (!invite) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    if (invite.status === 'pending_guardian')
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian responds to squad invitations.' });
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
