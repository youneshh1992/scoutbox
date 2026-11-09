// M15 — Football Passport assembly + routes.
//
// The server assembles ONE canonical projection per (player, viewer) from
// existing domain records; clients never rebuild the Passport from raw
// endpoints. Authorization reuses the standing gates verbatim:
// visibleToOrg (incl. the agency/minor wall and the grassroots 50 km rule),
// blocks, guardian ownership, adult checks. Passport adds no new access.
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { ageOrNull } from '../../../temporal.mjs';
import { readPage, sendPageError, pageOf } from '../../platform/paging.mjs';
import {
  buildTimeline, clubHistory, currentStatus, temporalConflicts, completeness,
  projectPassport, passportRevision, normWhen, whenDisplay, evId, PROVENANCE_COPY,
} from './shared.mjs';
// M16: the Passport PROJECTS Box Cam data — it never copies it.
import { developmentActivity as boxDevelopmentActivity, fmtMs as boxFmtMs } from '../../development/boxcam/shared.mjs';
import { DRILLS as BOX_DRILLS, latestDrill as boxLatestDrill } from '../../development/boxcam/drills.mjs';
// M16.1 At-Home Combine — the Passport PROJECTS verified Combine results, it
// never copies them. Computed with the pure engine so this stays independent
// of module registration order.
import { combineProtocol as combineProtocolDef, personalBest as combinePersonalBest, formatCombineValue } from '../../development/boxcam/combineShared.mjs';
import { applicationView } from '../../scouting/journeys.mjs';
import { blankPrefs, PASSPORT_LIMITS as L, AVAILABILITY, CORRECTION_TARGETS, CORRECTION_OUTCOMES } from '../../../repositories/passport.mjs';
import { PLAYER_POSITIONS } from '../../../repositories/identity.mjs';

const BOX_DRILLS_BY_ID = new Map(BOX_DRILLS.map((d) => [d.id, d]));

export function registerPassportCore(ctx) {
  const {
    byId, playerRouter, guardianRouter, orgRouter, adminRouter,
    nextId, notify, ledgerAppend, findPlayer, isBlocked,
    moderateOrRefuse, vmetric, passport, unit,
  } = ctx;
  const vreads = ctx.verificationReads;
  const boxReads = ctx.boxCamReads; // S12b: Box Cam, Combine and the CV results are read through SQL
  if (typeof boxReads?.sessions?.forPlayer !== 'function') throw new TypeError('registerPassportCore needs boxCamReads from the data layer');
  // §4.3 step 2: the signings are read through SQL (the signings repository's queries).
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function') throw new TypeError('registerPassportCore needs recruitmentReads (signings) from the data layer');

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const orgOf = (id) => byId.org(id) ?? null;
  // S10b: reading preferences never creates a row; a player who never saved has the blank ones.
  const prefsFor = (playerId) => vreads.passportPrefs.forPlayer(playerId) ?? blankPrefs(playerId);
  ctx.orgCanSee = orgCanSee;

  // Verified At-Home Combine results projected for the Passport: best
  // verified attempt per protocol@version, dropping any whose bound Box Cam
  // session has been invalidated (T&S). Recruitment-safe — no raw video, DOB,
  // notes or integrity internals.
  function combineProjectionFor(pid) {
    const attempts = boxReads.attempts.forPlayer(pid).filter((a) => a.combineState === 'combine_verified' && a.measuredValue != null);
    const sessions = new Map(boxReads.sessions.byIds(attempts.map((a) => a.boxSessionId)).map((s) => [s.id, s]));
    const live = attempts.filter((a) => {
      const s = sessions.get(a.boxSessionId);
      return !(s && s.verificationState === 'invalidated');
    }).map((a) => ({ ...a, effectiveState: 'combine_verified' }));
    const byKey = new Map();
    for (const a of live) { const k = `${a.protocolId}@${a.protocolVersion}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(a); }
    const results = [...byKey.values()].map((list) => combinePersonalBest(list)).filter(Boolean).map((a) => {
      const proto = combineProtocolDef(a.protocolId, a.protocolVersion);
      return {
        protocolId: a.protocolId, protocolVersion: a.protocolVersion,
        protocolTitle: proto?.title ?? a.protocolId, metricUnit: a.metricUnit,
        measuredValue: a.measuredValue, display: proto ? formatCombineValue(proto, a.measuredValue) : `${a.measuredValue}`,
        combineVerified: true, capturedBy: 'box_cam', completedAt: a.completedAt,
      };
    }).sort((x, y) => (y.completedAt ?? 0) - (x.completedAt ?? 0));
    return { results, hasCombineVerifiedResults: results.length > 0, note: 'Combine Verified — standardized ScoutBox protocol, live Box Cam capture. Powered by Box Cam. Real numbers, not a talent score.' };
  }

  // ------------------------------------------------------ source assembly
  // Reads existing collections; writes nothing. `light` skips the timeline
  // for batch summaries (§62 — no full history for 100 players).
  /**
   * The club-history inputs of one player (S14j: one definition, read by the Passport and by the trust band's
   * history source, which needs nothing else of the Passport).
   */
  function historyInputs(pid) {
    // Club relationships: squad rows (invite-approved), accepted M14 squad
    // invitations, signings; plus self/guardian-submitted career entries.
    // S9c: the player's squad rows in one indexed query; a club's shadow list is not a relationship.
    const squads = [];
    for (const row of ctx.scoutingReads.squad.forPlayer(pid)) {
      const o = orgOf(row.orgId);
      if (!o || o.suspended) continue; // a suspended organisation lends no CURRENT relationship (§79#20)
      squads.push({ orgId: o.id, orgName: o.name, rowId: row.id, addedAt: row.addedAt, orgVerified: !!o.verified });
    }
    for (const inv of ctx.verificationReads.playerInvites.acceptedForPlayer(pid)) {
      if (!squads.some((s) => s.orgId === inv.orgId)) {
        const o = orgOf(inv.orgId);
        if (!o || o.suspended) continue; // same suspension rule as squad rows (§79#20)
        squads.push({ orgId: inv.orgId, orgName: o.name, rowId: inv.id, addedAt: inv.acceptedAt, orgVerified: !!o.verified });
      }
    }
    const signings = reads.signings.forPlayer(pid);
    const outcomes = reads.outcomeReports.forPlayer(pid).map((o) => ({ ...o, orgName: orgOf(o.orgId)?.name ?? null }));
    const signingRows = signings.map((s) => {
      const ended = outcomes.find((o) => o.signingId === s.id && ['released', 'ended', 'left'].includes(String(o.registrationStatus ?? '')));
      // Suspension suppresses the CURRENT relationship at read time (same
      // policy as M14 badges); the historical signing fact is untouched.
      return { id: s.id, orgId: s.orgId, orgName: s.orgName, ts: s.ts, endedAt: ended?.at ?? null, orgSuspended: !!orgOf(s.orgId)?.suspended };
    });
    const careerEntries = vreads.careerEntries.forPlayer(pid);
    return { squads, signings, outcomes, signingRows, careerEntries };
  }
  /** A player's club history as the Passport shows it (clubHistory over historyInputs). */
  const historyFor = (player) => { const { squads, careerEntries, signingRows } = historyInputs(player.id); return clubHistory({ affiliations: [], squads, careerEntries, signingRows }); };

  function assemble(player, { light = false } = {}) {
    const pid = player.id;
    const prefs = prefsFor(pid);
    const now = Date.now();

    const { squads, signings, outcomes, signingRows, careerEntries } = historyInputs(pid);

    const trials = reads.trials.forPlayer(pid);
    const assessments = ctx.scoutingReads.assessments.forPlayer(pid)
      .filter((a) => a.state !== 'draft')
      .map((a) => ({ ...a, orgName: orgOf(a.orgId)?.name ?? null }));
    const references = ctx.verificationReads.references.activeForPlayer(pid).map((r) => ({
      ...r,
      provenanceStillCurrent: (() => {
        const claim = ctx.verificationReads.claims.byId(r.provenanceSnapshot?.claimId);
        return !!claim && claim.status === 'verified' && claim.current !== false;
      })(),
    }));
    const evidence = ctx.scoutingReads.evidence.forPlayer(pid).map((e) => ({
      id: e.id, claimType: e.claimType, label: e.label, recordedAt: e.recordedAt,
      tier: e.verification?.status ?? 'self_reported', sourceKind: e.source?.kind ?? 'player',
      superseded: !!e.supersededBy, expired: e.expiresAt ? e.expiresAt < now : false,
    }));
    // S12a: read through SQL. An objective has no completion instant (no route ever set one), so completedAt is null.
    const objectives = ctx.developmentReads.objectives.forPlayer(pid).map((o) => ({
      id: o.id, orgId: o.orgId, orgName: orgOf(o.orgId)?.name ?? null, createdAt: o.createdAt,
      status: o.status, completedAt: null, sharingOrgIds: [...o.sharing.orgIds],
    }));
    // S9d: read through SQL, and built from an allowlist (the player's own application, as before).
    const applications = ctx.scoutingReads.applications.forPlayers([pid]).map((a) => ({
      ...applicationView(a), orgName: orgOf(a.orgId)?.name ?? null,
      opportunityTitle: ctx.scoutingReads.opportunities.byId(a.opportunityId)?.title ?? null,
    }));
    const transitions = vreads.transitionCases.forPlayer(pid); // S10c: read through SQL
    /**
     * The canonical P5.6B relationships, shaped for the projection: a named
     * licensed individual, their agency, the scope and the dates. Read here so
     * the Passport's representation headline comes from the authoritative lane
     * rather than being blind to it (M23 P5.6E §2/§5).
     */
    const agentAgreements = ctx.agentReads.agreements.forClient(pid)
      .map((a) => ({
        id: a.id, status: a.status, scope: [...a.scope],
        startAt: a.startAt, endAt: a.endAt, confirmedAt: a.confirmedAt,
        agentUserId: a.agentUserId,
        agentDisplayName: ctx.agentReads.profiles.forUser(a.agentUserId)?.displayName ?? byId.user(a.agentUserId)?.name ?? null,
        agencyName: orgOf(a.agencyOrgId)?.name ?? null,
      }));
    const achievements = vreads.achievements.forPlayer(pid);
    const vouches = vreads.vouches.publishedFor(pid);

    // M16 Box Cam — displayable (verified/partially verified, never
    // invalidated) sessions, challenge completions and the aggregate
    // development-activity summary.
    const boxSessionsAll = boxReads.sessions.finishedForPlayer(pid).filter((s) => s.finalizedAt && !['cancelled', 'invalidated'].includes(s.verificationState));
    const boxDisplayable = boxSessionsAll.filter((s) => ['verified', 'partially_verified'].includes(s.verificationState));
    const boxAssignmentsAll = boxReads.assignments.forPlayer(pid).filter((a) => a.state !== 'cancelled');
    const boxAssignmentsById = new Map(boxAssignmentsAll.map((a) => [a.id, a]));
    const boxPrefs = boxReads.prefs.forPlayer(pid);
    // Meaningful milestones only — the career timeline is never flooded.
    const boxTimelineSessions = boxDisplayable
      .filter((s) => s.targetCompleted === true || (s.verifiedActiveMs ?? 0) >= 15 * 60_000)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 10)
      .map((s) => {
        const a = s.assignmentId ? (boxAssignmentsById.get(s.assignmentId) ?? boxReads.assignments.byId(s.assignmentId)) : null;
        return {
          id: s.id, endedAt: s.endedAt, drillTitle: boxLatestDrill(s.drillId)?.title ?? s.drillId,
          verifiedActive: boxFmtMs(s.verifiedActiveMs ?? 0), verifiedReps: s.verifiedReps ?? null,
          targetCompleted: s.targetCompleted, assignedByOrg: a ? { id: a.orgId, name: a.orgName } : null,
        };
      });
    const boxChallengeCompletions = boxReads.entries.forPlayer(pid)
      .filter((e) => e.status === 'completed')
      .map((e) => {
        const c = boxReads.challenges.byId(e.challengeId);
        return c ? {
          entryId: e.id, completedAt: e.completedAt, title: c.title,
          publisherName: c.publisher.kind === 'org' ? c.publisher.orgName : 'ScoutBox',
          publisherOrg: c.publisher.kind === 'org' ? { id: c.publisher.orgId, name: c.publisher.orgName } : null,
        } : null;
      })
      .filter(Boolean);

    // Identity: the PLAYER identity surface is the existing IDV outcome —
    // honestly a ScoutBox review, never an authoritative provider.
    const identity = player.identityVerified
      ? { confirmed: true, assurance: 'scoutbox_document_review', label: 'Identity confirmed by ScoutBox review', provenance: PROVENANCE_COPY.scoutbox_reviewed }
      : null;

    const history = clubHistory({ affiliations: [], squads, careerEntries, signingRows });
    // M23 P5.7 (T-8): THE age rule. The local-getter version here gave a
    // different answer around a birthday in any non-UTC zone.
    const age = ageOrNull(player.dob, now);

    const fullMatchEvidence = evidence.filter((e) => e.claimType === 'footage' && !e.superseded);
    const recentAssessment = assessments.some((a) => (a.submittedAt ?? a.createdAt) > now - 365 * 86_400_000);
    const lastEvidenceAt = Math.max(0, ...evidence.map((e) => e.recordedAt ?? 0));
    const facts = {
      hasRecentFullMatch: fullMatchEvidence.some((e) => e.recordedAt > now - 180 * 86_400_000),
      fullMatchCount: fullMatchEvidence.length,
      clipCount: (player.media ?? []).length,
      referenceCount: references.length + vouches.length,
      hasConfirmedCurrentClub: history.rows.some((r) => r.current && ['verified_club_confirmed', 'authoritative_registry', 'scoutbox_reviewed'].includes(r.provenance)),
      hasRecentAssessment: recentAssessment,
      hasPosition: !!(prefs.positions?.primary ?? player.position),
      hasAvailability: !!prefs.availability,
      identityConfirmed: !!identity,
      historyRows: history.rows.length,
      hasRecentTrainingEvidence: boxDisplayable.some((s) => (s.endedAt ?? 0) > now - 45 * 86_400_000),
    };

    const full = {
      player: { id: pid, name: player.name, age, minor: !isAdult(player), position: prefs.positions?.primary ?? player.position ?? null, city: player.city ?? player.location?.city ?? null, level: player.level ?? null },
      identity,
      prefs,
      history,
      status: currentStatus({ history, prefs, agreements: agentAgreements, identity }),
      evidenceSummary: {
        fullMatches: fullMatchEvidence.length,
        clips: (player.media ?? []).length,
        assessments: assessments.length,
        references: references.length + vouches.length,
        lastEvidenceDays: lastEvidenceAt ? Math.floor((now - lastEvidenceAt) / 86_400_000) : null,
        note: 'Counts describe evidence coverage, not football ability.',
      },
      references,
      achievements,
      developmentSummary: {
        active: objectives.filter((o) => o.status === 'active').length,
        completed: objectives.filter((o) => o.status !== 'active').length,
      },
      trialsSummary: { total: trials.length, withReport: trials.filter((t) => t.report).length },
      completeness: completeness(facts),
      developmentActivity: boxDevelopmentActivity({ sessions: boxSessionsAll, assignments: boxAssignmentsAll, drillsById: BOX_DRILLS_BY_ID, days: 30 }),
      combine: combineProjectionFor(pid),
      boxShareRecruitment: boxPrefs?.shareDevelopmentActivity === 'recruitment',
      sharingSummary: {
        active: vreads.shares.activeCount(pid, now),
      },
      assessments, trials, objectives, // raw-ish, filtered again at projection
      // Canonical inputs the M18.1 passport revision hashes. Kept separate from
      // the projected fields so the revision depends on source truth rather
      // than on anything a viewer or a clock could change.
      revisionSources: { evidence, careerEntries: careerEntries.map((c) => ({ id: c.id, withdrawnAt: c.withdrawnAt ?? null })) },
    };

    if (!light) {
      full.timeline = buildTimeline({
        affiliations: [], careerEntries, squads, trials, assessments, references,
        evidence, objectives, applications, transitions, signings, outcomes,
        achievements, positionHistory: prefs.positionHistory,
        boxSessions: boxTimelineSessions, boxChallenges: boxChallengeCompletions,
      });
      full.temporalConflicts = temporalConflicts({ events: full.timeline, history: history.rows, dob: player.dob });
    } else {
      full.timeline = [];
      full.temporalConflicts = [];
    }
    return full;
  }
  ctx.assemblePassport = assemble;
  ctx.passportHistoryFor = historyFor;
  /**
   * The canonical Passport CONTENT revision for a player (M18.1). Exposed so a
   * decision snapshot can record which Passport truth the club was looking at
   * without freezing a copy of the Passport itself.
   */
  ctx.passportRevisionOf = (playerId) => {
    const player = findPlayer(playerId);
    if (!player) return null;
    try { return passportRevision(assemble(player, { light: false })); } catch { return null; }
  };

  function buildFor(player, viewerKind, opts = {}) {
    const full = assemble(player, opts);
    if (viewerKind === 'pro_club' || viewerKind === 'grassroots_club' || viewerKind === 'agency') {
      full.assessmentsForOrg = full.assessments.filter((a) => a.orgId === opts.orgId);
      full.trialsForOrg = full.trials.filter((t) => t.orgId === opts.orgId);
    }
    // NOTE (M16.2): the Trust Score is deliberately NOT embedded here. The
    // Passport projection carries no numeric score of any kind — that is a
    // standing M15 guarantee, because a number inside a Football Passport
    // has always meant a talent rating. The Trust Score is a SEPARATE derived
    // evidence-confidence summary (GET /player/trust-profile and the org
    // equivalent) that consumes the Passport; clients compose it into the
    // Passport header. Keeping it out of this payload preserves both the M15
    // invariant and the M14/M15/M16.2 separation of concerns.
    return projectPassport(full, viewerKind, opts);
  }
  ctx.buildFootballPassport = buildFor;

  const viewerKindForOrg = (org) => org.type === 'agency' ? 'agency' : org.level === 'grassroots' ? 'grassroots_club' : 'pro_club';

  // ------------------------------------------------------------- self view
  playerRouter.get('/football-passport', (req, res) => {
    vmetric('views_self');
    res.json(buildFor(req.player, 'self'));
  });

  guardianRouter.get('/children/:id/football-passport', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    vmetric('views_guardian');
    res.json(buildFor(child, 'guardian'));
  });

  // ------------------------------------------------------- input and views
  // S10b: every field is checked before anything is written; junk is refused naming the field. Free text is still
  // shortened to its limit, as it always was.
  const fieldInvalid = (res, field, message) => { res.status(400).json({ error: 'FIELD_INVALID', field, message }); return null; };
  const dateInvalid = (res, field) => { res.status(400).json({ error: 'DATE_INVALID', field, message: 'Use a year (YYYY), a month (YYYY-MM) or a day (YYYY-MM-DD).' }); return null; };
  const NOT_TEXT = Symbol('not text');
  /** Optional free text: null when absent or empty, shortened to `max`; NOT_TEXT when it is not text. */
  const optText = (v, max) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v.slice(0, max) : NOT_TEXT);
  /** A football date as stored — the precision the player gave, never an invented day — or null when it is not one. */
  const footballDate = (input) => { const w = normWhen(input); return w ? whenDisplay(w) : null; };
  const POSITION_HELP = `Use position codes: ${PLAYER_POSITIONS.join(', ')}.`;
  /** `{ primary, secondary }` from a body, or a refusal (already sent) as null; `primaryRequired` for a history row. */
  function readPositions(res, input, field, { primaryRequired = false } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return fieldInvalid(res, field, 'Send an object with primary and secondary.');
    const primary = input.primary === '' || input.primary === undefined ? null : input.primary;
    if (primary === null ? primaryRequired : !PLAYER_POSITIONS.includes(primary)) return fieldInvalid(res, `${field}.primary`, POSITION_HELP);
    const secondary = input.secondary ?? [];
    if (!Array.isArray(secondary) || secondary.length > L.secondary) return fieldInvalid(res, `${field}.secondary`, `Up to ${L.secondary} position codes.`);
    const wrong = secondary.findIndex((x) => !PLAYER_POSITIONS.includes(x));
    if (wrong >= 0) return fieldInvalid(res, `${field}.secondary[${wrong}]`, POSITION_HELP);
    return { primary, secondary: [...new Set(secondary)] };
  }
  const prefsView = (p) => ({
    playerId: p.playerId, bio: p.bio, positions: p.positions ? { primary: p.positions.primary, secondary: [...p.positions.secondary] } : null,
    positionHistory: p.positionHistory.map((h) => ({ id: h.id, from: h.from, primary: h.primary, secondary: [...h.secondary], submittedBy: h.submittedBy, recordedAt: h.recordedAt })),
    availability: p.availability, availableFrom: p.availableFrom, publicSelections: [...p.publicSelections], updatedAt: p.updatedAt,
  });
  const entryView = (e) => ({ id: e.id, playerId: e.playerId, orgName: e.orgName, role: e.role, from: e.from, to: e.to, note: e.note, submittedBy: e.submittedBy, createdAt: e.createdAt, withdrawnAt: e.withdrawnAt });
  const achievementRecordView = (a) => ({
    id: a.id, playerId: a.playerId, title: a.title, orgName: a.orgName, when: a.when, submittedBy: a.submittedBy,
    confirmation: a.confirmation ? { provenance: a.confirmation.provenance, orgId: a.confirmation.orgId, orgName: a.confirmation.orgName, byName: a.confirmation.byName, at: a.confirmation.at } : null,
    createdAt: a.createdAt, withdrawnAt: a.withdrawnAt,
  });
  const correctionView = (c) => ({
    id: c.id, playerId: c.playerId, targetType: c.targetType, targetId: c.targetId, reason: c.reason,
    by: { kind: c.by.kind, id: c.by.id, name: c.by.name }, status: c.status,
    resolution: c.resolution ? { outcome: c.resolution.outcome, reason: c.resolution.reason, at: c.resolution.at } : null,
    createdAt: c.createdAt, resolvedAt: c.resolvedAt,
  });

  // ----------------------------------------------------------- preferences
  function applyPrefs(res, player, body, submittedBy) {
    const set = {};
    if (body.bio !== undefined) {
      const bio = optText(body.bio, L.bio);
      if (bio === NOT_TEXT) return fieldInvalid(res, 'bio', 'The bio is text.');
      if (bio && !moderateOrRefuse(res, bio, { kind: 'passport_bio', playerId: player.id })) return null;
      set.bio = bio;
    }
    if (body.positions !== undefined) {
      if (body.positions === null) set.positions = null;
      else { const p = readPositions(res, body.positions, 'positions'); if (!p) return null; set.positions = p.primary || p.secondary.length ? p : null; }
    }
    let historyRow = null;
    if (body.positionHistoryAdd) {
      const h = body.positionHistoryAdd;
      // `from` is the FOOTBALL date the player started playing this position; `recordedAt` (M18.1) is when the row was
      // written. They are different events and are never used for each other.
      const from = footballDate(h?.from);
      if (!from) { res.status(400).json({ error: 'DATE_REQUIRED', message: 'Position history needs at least a year.' }); return null; }
      const p = readPositions(res, h, 'positionHistoryAdd', { primaryRequired: true }); if (!p) return null;
      historyRow = { id: nextId('ppos'), from, primary: p.primary, secondary: p.secondary, submittedBy, recordedAt: Date.now() };
    }
    if (body.availability !== undefined) {
      if (body.availability !== null && !AVAILABILITY.includes(body.availability)) { res.status(400).json({ error: 'AVAILABILITY_INVALID', allowed: [...AVAILABILITY, null] }); return null; }
      set.availability = body.availability;
    }
    if (body.availableFrom !== undefined) {
      if (body.availableFrom === null || body.availableFrom === '') set.availableFrom = null;
      else { set.availableFrom = footballDate(body.availableFrom); if (!set.availableFrom) return dateInvalid(res, 'availableFrom'); }
    }
    if (body.publicSelections !== undefined) {
      // Selection is NARROWING-ONLY input: unknown ids are stored harmlessly but can never surface anything the source
      // policy keeps non-public (enforced at projection time, tested in the abuse suite). Repeats mean nothing.
      const list = body.publicSelections ?? [];
      if (!Array.isArray(list) || list.length > L.selections) return fieldInvalid(res, 'publicSelections', `A list of up to ${L.selections} ids.`);
      const wrong = list.findIndex((x) => typeof x !== 'string' || !x || x.length > L.selection);
      if (wrong >= 0) return fieldInvalid(res, `publicSelections[${wrong}]`, `Each selection is an id of at most ${L.selection} characters.`);
      set.publicSelections = [...new Set(list)];
    }
    const wasPrimary = prefsFor(player.id).positions?.primary ?? null;
    const saved = unit(() => {
      const p = passport.passportPrefs.save(player.id, (d) => {
        Object.assign(d, set);
        if (historyRow) d.positionHistory.push(historyRow);
        d.updatedAt = Date.now();
      });
      // M18.1 — a canonical source-change event with its OWN clock: positionHistory.from is the football date the player
      // STARTED playing the position, and prefs.updatedAt is bumped by any preference edit at all. Only a genuine change
      // of the primary position is recorded, so re-saving the same preferences emits nothing.
      const nowPrimary = p.positions?.primary ?? null;
      if (nowPrimary !== wasPrimary) {
        ctx.recordSourceChange?.({
          playerId: player.id, type: 'position_changed',
          sourceSystem: 'passport_prefs', sourceId: `${player.id}:${nowPrimary ?? 'none'}`,
          detail: { from: wasPrimary, to: nowPrimary, submittedBy },
        });
      }
      if (historyRow) {
        ctx.recordSourceChange?.({
          playerId: player.id, type: 'position_changed',
          sourceSystem: 'position_history', sourceId: historyRow.id,
          occurredAt: historyRow.recordedAt, detail: { to: historyRow.primary, submittedBy },
        });
      }
      return p;
    });
    return saved;
  }

  playerRouter.patch('/football-passport/prefs', (req, res) => {
    const p = applyPrefs(res, req.player, req.body ?? {}, 'player');
    if (p) res.json({ prefs: prefsView(p) });
  });
  guardianRouter.patch('/children/:id/football-passport/prefs', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const p = applyPrefs(res, child, req.body ?? {}, 'guardian');
    if (p) res.json({ prefs: prefsView(p) });
  });

  // --------------------------------------------------- self career entries
  function addCareerEntry(res, player, body, submittedBy) {
    if (body.orgName !== undefined && body.orgName !== null && typeof body.orgName !== 'string') return fieldInvalid(res, 'orgName', 'The club name is text.');
    const orgName = String(body.orgName ?? '').trim().slice(0, L.orgName);
    if (!orgName) { res.status(400).json({ error: 'ORG_NAME_REQUIRED' }); return null; }
    const role = optText(body.role, L.role); if (role === NOT_TEXT) return fieldInvalid(res, 'role', 'The role is text.');
    const note = optText(body.note, L.note); if (note === NOT_TEXT) return fieldInvalid(res, 'note', 'The note is text.');
    if (!moderateOrRefuse(res, orgName + ' ' + (role ?? '') + ' ' + (note ?? ''), { kind: 'passport_career', playerId: player.id })) return null;
    const from = footballDate(body.from);
    if (!from) { res.status(400).json({ error: 'DATE_REQUIRED', message: 'A year is enough — exact dates are never invented.' }); return null; }
    const to = body.to != null ? footballDate(body.to) : null;
    if (body.to != null && !to) return dateInvalid(res, 'to');
    const e = passport.careerEntries.create({
      id: nextId('pcar'), playerId: player.id, orgName, role, from, to, note,
      submittedBy, createdAt: Date.now(), withdrawnAt: null,
    });
    return e;
  }
  playerRouter.post('/football-passport/career', (req, res) => {
    const e = addCareerEntry(res, req.player, req.body ?? {}, 'player');
    if (e) res.status(201).json({ entry: entryView(e), provenance: 'player_submitted', note: PROVENANCE_COPY.player_submitted });
  });
  guardianRouter.post('/children/:id/football-passport/career', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    const e = addCareerEntry(res, child, req.body ?? {}, 'guardian');
    if (e) res.status(201).json({ entry: entryView(e), provenance: 'guardian_submitted' });
  });
  playerRouter.post('/football-passport/career/:id/withdraw', (req, res) => {
    const found = vreads.careerEntries.byId(req.params.id);
    if (!found || found.playerId !== req.player.id) return res.status(404).json({ error: 'ENTRY_NOT_FOUND' });
    const e = passport.careerEntries.update(found.id, (d) => { d.withdrawnAt = Date.now(); });
    res.json({ entry: entryView(e), note: 'Self-submitted entries can be withdrawn; confirmed records cannot (request a correction instead).' });
  });

  // ------------------------------------------------------------ achievements
  playerRouter.post('/football-passport/achievements', (req, res) => addAchievement(res, req.player, req.body ?? {}, 'player'));
  guardianRouter.post('/children/:id/football-passport/achievements', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    addAchievement(res, child, req.body ?? {}, 'guardian');
  });
  function addAchievement(res, player, body, submittedBy) {
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') return fieldInvalid(res, 'title', 'The title is text.');
    const title = String(body.title ?? '').trim().slice(0, L.title);
    if (!title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    const orgName = optText(body.orgName, L.orgName); if (orgName === NOT_TEXT) return fieldInvalid(res, 'orgName', 'The organisation name is text.');
    const when = body.when == null || body.when === '' ? null : footballDate(body.when);
    if (body.when != null && body.when !== '' && !when) return dateInvalid(res, 'when');
    if (!moderateOrRefuse(res, title, { kind: 'passport_achievement', playerId: player.id })) return;
    // A client can NEVER assert authoritative provenance for itself (§79#16): whatever the body claims, a new
    // achievement is player/guardian-submitted (the fields it names are not read).
    const a = passport.achievements.create({
      id: nextId('pach'), playerId: player.id, title, orgName, when, submittedBy, confirmation: null, createdAt: Date.now(), withdrawnAt: null,
    });
    res.status(201).json({ achievement: achievementRecordView(a), provenance: submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted' });
  }
  playerRouter.post('/football-passport/achievements/:id/withdraw', (req, res) => {
    const a = vreads.achievements.byId(req.params.id);
    if (!a || a.playerId !== req.player.id) return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
    if (a.confirmation) return res.status(403).json({ error: 'CONFIRMED_RECORD', message: 'A confirmed achievement is part of the record — request a correction instead of deleting it.' });
    const done = passport.achievements.update(a.id, (d) => { d.withdrawnAt = Date.now(); });
    res.json({ achievement: achievementRecordView(done) });
  });
  // Club confirmation upgrades provenance WITHOUT rewriting the original.
  orgRouter.post('/players/:pid/football-passport/achievements/:id/confirm', (req, res) => {
    const p = findPlayer(req.params.pid);
    if (!p || !orgCanSee(req.org, p)) return res.status(p ? 403 : 404).json({ error: p ? (req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE') : 'PLAYER_NOT_FOUND' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can confirm an achievement.' });
    const a = vreads.achievements.byId(req.params.id);
    if (!a || a.playerId !== p.id || a.withdrawnAt) return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
    if (a.confirmation) return res.status(409).json({ error: 'ALREADY_CONFIRMED' });
    // One unit: the confirmation with its notifications.
    const done = unit(() => {
      const c = passport.achievements.update(a.id, (d) => {
        d.confirmation = { provenance: 'verified_club_confirmed', orgId: req.org.id, orgName: String(req.org.name).slice(0, L.name), byName: String(req.orgUser.name ?? '').slice(0, L.name) || null, at: Date.now() };
      });
      notify({ kind: 'player', id: p.id }, 'passport', `🏅 ${req.org.name} confirmed your achievement “${a.title}”.`, a.id);
      if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'passport', `${req.org.name} confirmed ${p.name}'s achievement “${a.title}”.`, a.id);
      return c;
    });
    vmetric('achievement_confirmed');
    res.json({ achievement: achievementRecordView(done) });
  });

  // ------------------------------------------------------------ corrections
  function fileCorrection(res, player, body, by) {
    const targetType = String(body.targetType ?? '');
    if (!CORRECTION_TARGETS.includes(targetType)) return res.status(400).json({ error: 'TARGET_INVALID', allowed: CORRECTION_TARGETS });
    const targetId = body.targetId === undefined || body.targetId === null || body.targetId === '' ? null : body.targetId;
    if (targetId !== null && (typeof targetId !== 'string' || targetId.length > L.targetId)) return fieldInvalid(res, 'targetId', `An id of at most ${L.targetId} characters.`);
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') return fieldInvalid(res, 'reason', 'The reason is text.');
    const reason = String(body.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED' });
    if (!moderateOrRefuse(res, reason, { kind: 'passport_correction', playerId: player.id })) return;
    const c = passport.corrections.create({
      id: nextId('pcor'), playerId: player.id, targetType, targetId, reason: reason.slice(0, L.reason),
      by: { ...by, name: by.name ? String(by.name).slice(0, L.name) : null }, status: 'open', resolution: null, createdAt: Date.now(),
    });
    vmetric('correction_filed');
    res.status(201).json({ correction: correctionView(c), note: 'Authoritative records are never silently edited — Trust & Safety reviews correction requests, and verification claims can additionally be disputed through the existing verification flow.' });
  }
  playerRouter.post('/football-passport/corrections', (req, res) => fileCorrection(res, req.player, req.body ?? {}, { kind: 'player', id: req.player.id, name: req.player.name }));
  guardianRouter.post('/children/:id/football-passport/corrections', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    fileCorrection(res, child, req.body ?? {}, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  // The T&S queue, oldest first, by cursor (`?limit=&cursor=`; `?all=1` lists resolved ones too).
  adminRouter.get('/passport/corrections', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = pageOf(vreads.corrections.page({ all: req.query.all === '1', ...page }).rows, page.limit, (r) => r.key);
    res.json({ items: items.map((r) => correctionView(r.record)), nextCursor });
  });
  adminRouter.post('/passport/corrections/:id/resolve', (req, res) => {
    const c = vreads.corrections.byId(req.params.id);
    if (!c) return res.status(404).json({ error: 'CORRECTION_NOT_FOUND' });
    if (c.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { resolution, reason } = req.body ?? {};
    if (!CORRECTION_OUTCOMES.includes(resolution)) return res.status(400).json({ error: 'RESOLUTION_REQUIRED', allowed: CORRECTION_OUTCOMES });
    if (typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    // One unit: the resolution with the requester's notification.
    const done = unit(() => {
      const r = passport.corrections.update(c.id, (d) => {
        d.status = 'resolved';
        d.resolution = { outcome: resolution, reason: reason.slice(0, L.resolutionReason), at: Date.now() };
        d.resolvedAt = d.resolution.at;
      });
      const target = c.by.kind === 'guardian' ? { kind: 'guardian', id: c.by.id } : { kind: 'player', id: c.playerId };
      notify(target, 'passport', `Trust & Safety resolved your Passport correction request: ${resolution}.`, c.id);
      return r;
    });
    res.json({ correction: correctionView(done) });
  });

  // ------------------------------------------------------------- club view
  orgRouter.get('/players/:id/football-passport', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) {
      return res.status(403).json({ error: req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    }
    const viewer = viewerKindForOrg(req.org);
    ledgerAppend({ type: 'passport_recruitment_view', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    vmetric('views_recruitment');
    res.json(buildFor(p, viewer, { orgId: req.org.id }));
  });

  // Batch summaries for list surfaces — light assembly, no timelines (§62).
  orgRouter.get('/football-passports', (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 100);
    const items = [];
    for (const id of ids) {
      const p = findPlayer(id);
      if (!p || !orgCanSee(req.org, p)) continue; // concealment: absent, not erroring
      const full = assemble(p, { light: true });
      items.push({
        playerId: p.id,
        position: full.player.position,
        age: full.player.age,
        currentClub: full.status.currentClub ? { name: full.status.currentClub.orgName, provenance: full.status.currentClub.provenance } : null,
        evidenceCoverage: full.completeness.evidenceCoverage,
        lastEvidenceDays: full.evidenceSummary.lastEvidenceDays,
        references: full.evidenceSummary.references,
        availability: full.status.availability,
        identityConfirmed: !!full.identity,
      });
    }
    vmetric('batch_summaries');
    res.json({ items });
  });

  // ------------------------------------------------------------ T&S tools
  adminRouter.get('/passport/:playerId/graph', (req, res) => {
    const p = findPlayer(req.params.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json(buildFor(p, 'trust_safety'));
  });
}
