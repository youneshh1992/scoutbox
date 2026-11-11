// Football Passport assembly and routes. One projection per (player, viewer); clients never rebuild the Passport
// from raw endpoints. Authorisation is the standing gates; the Passport adds no access of its own.
import * as v from 'valibot';
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { ageOrNull } from '../../../temporal.mjs';
import { readPage, sendPageError, pageOf } from '../../platform/paging.mjs';
import {
  CURSOR_PAGE,
  dateWrittenAs,
  filled,
  idsText,
  inputOrRefuse,
  listedIds,
  oneOf,
  presentOrRefuse,
  text,
} from '../../platform/schemas.mjs';
import {
  buildTimeline,
  clubHistory,
  currentStatus,
  temporalConflicts,
  completeness,
  projectPassport,
  passportRevision,
  normWhen,
  whenDisplay,
  evId,
  PROVENANCE_COPY,
} from './shared.mjs';
import { developmentActivity as boxDevelopmentActivity, fmtMs as boxFmtMs } from '../../development/boxcam/shared.mjs';
import { DRILLS as BOX_DRILLS, latestDrill as boxLatestDrill } from '../../development/boxcam/drills.mjs';
// The pure Combine engine, so this does not depend on module registration order.
import {
  combineProtocol as combineProtocolDef,
  personalBest as combinePersonalBest,
  formatCombineValue,
} from '../../development/boxcam/combineShared.mjs';
import { applicationView } from '../../scouting/journeys.mjs';
import {
  blankPrefs,
  PASSPORT_LIMITS as L,
  AVAILABILITY,
  CORRECTION_TARGETS,
  CORRECTION_OUTCOMES,
} from '../../../repositories/passport.mjs';
import { PLAYER_POSITIONS } from '../../../repositories/identity.mjs';

const BOX_DRILLS_BY_ID = new Map(BOX_DRILLS.map((d) => [d.id, d]));

// ------------------------------------------------------------- input
const optText = (max) => v.nullish(text(max));
// A football date keeps the precision the player gave: a year, a month or a day, or the milliseconds of a day.
const FOOTBALL_DATE = 'YYYY, YYYY-MM or YYYY-MM-DD';
const isFootballDate = (x) =>
  (typeof x === 'string' ? /^\d{4}(-\d{2}){0,2}$/.test(x) : Number.isSafeInteger(x)) && normWhen(x) !== null;
const footballDate = v.nullish(dateWrittenAs(isFootballDate, FOOTBALL_DATE));
// '' is a form's "no date".
const footballDateOrBlank = v.nullish(dateWrittenAs((x) => x === '' || isFootballDate(x), FOOTBALL_DATE));
const secondary = v.pipe(v.array(oneOf(PLAYER_POSITIONS)), v.maxLength(L.secondary));
const Positions = v.strictObject({ primary: v.nullish(oneOf(PLAYER_POSITIONS)), secondary: v.nullish(secondary) });
const Prefs = v.strictObject({
  bio: optText(L.bio),
  positions: v.nullish(Positions),
  // `from` is the football date the player started in this position; the row's recordedAt is when it was written.
  positionHistoryAdd: v.nullish(
    v.strictObject({ from: footballDate, primary: oneOf(PLAYER_POSITIONS), secondary: v.nullish(secondary) }),
  ),
  availability: v.nullish(oneOf(AVAILABILITY)),
  availableFrom: footballDateOrBlank,
  // Narrowing only: an unknown id is stored harmlessly, as projection never surfaces what the source keeps
  // non-public.
  publicSelections: v.nullish(
    v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(L.selection))), v.maxLength(L.selections)),
  ),
});
const PREFS_CODES = { fieldCodes: { availability: 'AVAILABILITY_INVALID' } };
const CareerEntry = v.strictObject({
  orgName: optText(L.orgName),
  role: optText(L.role),
  note: optText(L.note),
  from: footballDate,
  to: footballDate,
});
const Achievement = v.strictObject({ title: optText(L.title), orgName: optText(L.orgName), when: footballDateOrBlank });
const Correction = v.strictObject({
  targetType: oneOf(CORRECTION_TARGETS),
  // '' is a form's "the section as a whole".
  targetId: optText(L.targetId),
  reason: optText(L.reason),
});
const CORRECTION_CODES = { fieldCodes: { targetType: 'TARGET_INVALID' } };
const CorrectionsQuery = v.strictObject({ ...CURSOR_PAGE, all: v.optional(oneOf(['0', '1'])) });
const CorrectionResolution = v.strictObject({
  resolution: oneOf(CORRECTION_OUTCOMES),
  reason: optText(L.resolutionReason),
});
const RESOLUTION_CODES = { fieldCodes: { resolution: 'RESOLUTION_REQUIRED' } };
const PassportsQuery = v.strictObject({ ids: v.optional(idsText(100)) });

export function registerPassportCore(ctx) {
  const {
    byId,
    playerRouter,
    guardianRouter,
    orgRouter,
    adminRouter,
    nextId,
    notify,
    ledgerAppend,
    findPlayer,
    isBlocked,
    moderateOrRefuse,
    vmetric,
    passport,
    unit,
  } = ctx;
  const vreads = ctx.verificationReads;
  const boxReads = ctx.boxCamReads;
  if (typeof boxReads?.sessions?.forPlayer !== 'function')
    throw new TypeError('registerPassportCore needs boxCamReads from the data layer');
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function')
    throw new TypeError('registerPassportCore needs recruitmentReads (signings) from the data layer');

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const orgOf = (id) => byId.org(id) ?? null;
  const prefsFor = (playerId) => vreads.passportPrefs.forPlayer(playerId) ?? blankPrefs(playerId);
  ctx.orgCanSee = orgCanSee;

  // Best verified attempt per protocol@version, dropping any whose session T&S invalidated. No raw video, DOB, notes
  // or integrity internals.
  function combineProjectionFor(pid) {
    const attempts = boxReads.attempts
      .forPlayer(pid)
      .filter((a) => a.combineState === 'combine_verified' && a.measuredValue != null);
    const sessions = new Map(boxReads.sessions.byIds(attempts.map((a) => a.boxSessionId)).map((s) => [s.id, s]));
    const live = attempts
      .filter((a) => {
        const s = sessions.get(a.boxSessionId);
        return !(s && s.verificationState === 'invalidated');
      })
      .map((a) => ({ ...a, effectiveState: 'combine_verified' }));
    const byKey = new Map();
    for (const a of live) {
      const k = `${a.protocolId}@${a.protocolVersion}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)).push(a);
    }
    const results = [...byKey.values()]
      .map((list) => combinePersonalBest(list))
      .filter(Boolean)
      .map((a) => {
        const proto = combineProtocolDef(a.protocolId, a.protocolVersion);
        return {
          protocolId: a.protocolId,
          protocolVersion: a.protocolVersion,
          protocolTitle: proto?.title ?? a.protocolId,
          metricUnit: a.metricUnit,
          measuredValue: a.measuredValue,
          display: proto ? formatCombineValue(proto, a.measuredValue) : `${a.measuredValue}`,
          combineVerified: true,
          capturedBy: 'box_cam',
          completedAt: a.completedAt,
        };
      })
      .sort((x, y) => (y.completedAt ?? 0) - (x.completedAt ?? 0));
    return {
      results,
      hasCombineVerifiedResults: results.length > 0,
      note: 'Combine Verified — standardized ScoutBox protocol, live Box Cam capture. Powered by Box Cam. Real numbers, not a talent score.',
    };
  }

  // ------------------------------------------------------ source assembly
  /** Shared with the Trust Score's history source, which needs nothing else of the Passport. */
  function historyInputs(pid) {
    // A club's shadow list is not a relationship.
    const squads = [];
    for (const row of ctx.scoutingReads.squad.forPlayer(pid)) {
      const o = orgOf(row.orgId);
      if (!o || o.suspended) continue; // a suspended organisation lends no current relationship
      squads.push({ orgId: o.id, orgName: o.name, rowId: row.id, addedAt: row.addedAt, orgVerified: !!o.verified });
    }
    for (const inv of ctx.verificationReads.playerInvites.acceptedForPlayer(pid)) {
      if (!squads.some((s) => s.orgId === inv.orgId)) {
        const o = orgOf(inv.orgId);
        if (!o || o.suspended) continue; // same suspension rule as squad rows
        squads.push({
          orgId: inv.orgId,
          orgName: o.name,
          rowId: inv.id,
          addedAt: inv.acceptedAt,
          orgVerified: !!o.verified,
        });
      }
    }
    const signings = reads.signings.forPlayer(pid);
    const outcomes = reads.outcomeReports.forPlayer(pid).map((o) => ({ ...o, orgName: orgOf(o.orgId)?.name ?? null }));
    const signingRows = signings.map((s) => {
      const ended = outcomes.find(
        (o) => o.signingId === s.id && ['released', 'ended', 'left'].includes(String(o.registrationStatus ?? '')),
      );
      // Suspension suppresses the current relationship at read time; the historical signing fact is untouched.
      return {
        id: s.id,
        orgId: s.orgId,
        orgName: s.orgName,
        ts: s.ts,
        endedAt: ended?.at ?? null,
        orgSuspended: !!orgOf(s.orgId)?.suspended,
      };
    });
    const careerEntries = vreads.careerEntries.forPlayer(pid);
    return { squads, signings, outcomes, signingRows, careerEntries };
  }
  const historyFor = (player) => {
    const { squads, careerEntries, signingRows } = historyInputs(player.id);
    return clubHistory({ affiliations: [], squads, careerEntries, signingRows });
  };

  function assemble(player, { light = false } = {}) {
    const pid = player.id;
    const prefs = prefsFor(pid);
    const now = Date.now();

    const { squads, signings, outcomes, signingRows, careerEntries } = historyInputs(pid);

    const trials = reads.trials.forPlayer(pid);
    const assessments = ctx.scoutingReads.assessments
      .forPlayer(pid)
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
      id: e.id,
      claimType: e.claimType,
      label: e.label,
      recordedAt: e.recordedAt,
      tier: e.verification?.status ?? 'self_reported',
      sourceKind: e.source?.kind ?? 'player',
      superseded: !!e.supersededBy,
      expired: e.expiresAt ? e.expiresAt < now : false,
    }));
    // No route sets an objective's completion instant.
    const objectives = ctx.developmentReads.objectives.forPlayer(pid).map((o) => ({
      id: o.id,
      orgId: o.orgId,
      orgName: orgOf(o.orgId)?.name ?? null,
      createdAt: o.createdAt,
      status: o.status,
      completedAt: null,
      sharingOrgIds: [...o.sharing.orgIds],
    }));
    const applications = ctx.scoutingReads.applications.forPlayers([pid]).map((a) => ({
      ...applicationView(a),
      orgName: orgOf(a.orgId)?.name ?? null,
      opportunityTitle: ctx.scoutingReads.opportunities.byId(a.opportunityId)?.title ?? null,
    }));
    const transitions = vreads.transitionCases.forPlayer(pid);
    const agentAgreements = ctx.agentReads.agreements.forClient(pid).map((a) => ({
      id: a.id,
      status: a.status,
      scope: [...a.scope],
      startAt: a.startAt,
      endAt: a.endAt,
      confirmedAt: a.confirmedAt,
      agentUserId: a.agentUserId,
      agentDisplayName:
        ctx.agentReads.profiles.forUser(a.agentUserId)?.displayName ?? byId.user(a.agentUserId)?.name ?? null,
      agencyName: orgOf(a.agencyOrgId)?.name ?? null,
    }));
    const achievements = vreads.achievements.forPlayer(pid);
    const vouches = vreads.vouches.publishedFor(pid);

    const boxSessionsAll = boxReads.sessions
      .finishedForPlayer(pid)
      .filter((s) => s.finalizedAt && !['cancelled', 'invalidated'].includes(s.verificationState));
    const boxDisplayable = boxSessionsAll.filter((s) =>
      ['verified', 'partially_verified'].includes(s.verificationState),
    );
    const boxAssignmentsAll = boxReads.assignments.forPlayer(pid).filter((a) => a.state !== 'cancelled');
    const boxAssignmentsById = new Map(boxAssignmentsAll.map((a) => [a.id, a]));
    const boxPrefs = boxReads.prefs.forPlayer(pid);
    // Milestones only, so the career timeline is not flooded.
    const boxTimelineSessions = boxDisplayable
      .filter((s) => s.targetCompleted === true || (s.verifiedActiveMs ?? 0) >= 15 * 60_000)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 10)
      .map((s) => {
        const a = s.assignmentId
          ? (boxAssignmentsById.get(s.assignmentId) ?? boxReads.assignments.byId(s.assignmentId))
          : null;
        return {
          id: s.id,
          endedAt: s.endedAt,
          drillTitle: boxLatestDrill(s.drillId)?.title ?? s.drillId,
          verifiedActive: boxFmtMs(s.verifiedActiveMs ?? 0),
          verifiedReps: s.verifiedReps ?? null,
          targetCompleted: s.targetCompleted,
          assignedByOrg: a ? { id: a.orgId, name: a.orgName } : null,
        };
      });
    const boxChallengeCompletions = boxReads.entries
      .forPlayer(pid)
      .filter((e) => e.status === 'completed')
      .map((e) => {
        const c = boxReads.challenges.byId(e.challengeId);
        return c
          ? {
              entryId: e.id,
              completedAt: e.completedAt,
              title: c.title,
              publisherName: c.publisher.kind === 'org' ? c.publisher.orgName : 'ScoutBox',
              publisherOrg: c.publisher.kind === 'org' ? { id: c.publisher.orgId, name: c.publisher.orgName } : null,
            }
          : null;
      })
      .filter(Boolean);

    // The player's identity check is a ScoutBox review, not an authoritative provider.
    const identity = player.identityVerified
      ? {
          confirmed: true,
          assurance: 'scoutbox_document_review',
          label: 'Identity confirmed by ScoutBox review',
          provenance: PROVENANCE_COPY.scoutbox_reviewed,
        }
      : null;

    const history = clubHistory({ affiliations: [], squads, careerEntries, signingRows });
    // UTC, so the answer around a birthday does not depend on the server's zone.
    const age = ageOrNull(player.dob, now);

    const fullMatchEvidence = evidence.filter((e) => e.claimType === 'footage' && !e.superseded);
    const recentAssessment = assessments.some((a) => (a.submittedAt ?? a.createdAt) > now - 365 * 86_400_000);
    const lastEvidenceAt = Math.max(0, ...evidence.map((e) => e.recordedAt ?? 0));
    const facts = {
      hasRecentFullMatch: fullMatchEvidence.some((e) => e.recordedAt > now - 180 * 86_400_000),
      fullMatchCount: fullMatchEvidence.length,
      clipCount: (player.media ?? []).length,
      referenceCount: references.length + vouches.length,
      hasConfirmedCurrentClub: history.rows.some(
        (r) =>
          r.current &&
          ['verified_club_confirmed', 'authoritative_registry', 'scoutbox_reviewed'].includes(r.provenance),
      ),
      hasRecentAssessment: recentAssessment,
      hasPosition: !!(prefs.positions?.primary ?? player.position),
      hasAvailability: !!prefs.availability,
      identityConfirmed: !!identity,
      historyRows: history.rows.length,
      hasRecentTrainingEvidence: boxDisplayable.some((s) => (s.endedAt ?? 0) > now - 45 * 86_400_000),
    };

    const full = {
      player: {
        id: pid,
        name: player.name,
        age,
        minor: !isAdult(player),
        position: prefs.positions?.primary ?? player.position ?? null,
        city: player.city ?? player.location?.city ?? null,
        level: player.level ?? null,
      },
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
      developmentActivity: boxDevelopmentActivity({
        sessions: boxSessionsAll,
        assignments: boxAssignmentsAll,
        drillsById: BOX_DRILLS_BY_ID,
        days: 30,
      }),
      combine: combineProjectionFor(pid),
      boxShareRecruitment: boxPrefs?.shareDevelopmentActivity === 'recruitment',
      sharingSummary: {
        active: vreads.shares.activeCount(pid, now),
      },
      assessments,
      trials,
      objectives, // filtered again at projection
      // Separate from the projected fields so the revision depends on source data, not on a viewer or the clock.
      revisionSources: {
        evidence,
        careerEntries: careerEntries.map((c) => ({ id: c.id, withdrawnAt: c.withdrawnAt ?? null })),
      },
    };

    if (!light) {
      full.timeline = buildTimeline({
        affiliations: [],
        careerEntries,
        squads,
        trials,
        assessments,
        references,
        evidence,
        objectives,
        applications,
        transitions,
        signings,
        outcomes,
        achievements,
        positionHistory: prefs.positionHistory,
        boxSessions: boxTimelineSessions,
        boxChallenges: boxChallengeCompletions,
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
  /** Lets a decision snapshot record which Passport the club saw without freezing a copy of it. */
  ctx.passportRevisionOf = (playerId) => {
    const player = findPlayer(playerId);
    if (!player) return null;
    try {
      return passportRevision(assemble(player, { light: false }));
    } catch {
      return null;
    }
  };

  function buildFor(player, viewerKind, opts = {}) {
    const full = assemble(player, opts);
    if (viewerKind === 'pro_club' || viewerKind === 'grassroots_club' || viewerKind === 'agency') {
      full.assessmentsForOrg = full.assessments.filter((a) => a.orgId === opts.orgId);
      full.trialsForOrg = full.trials.filter((t) => t.orgId === opts.orgId);
    }
    // The Trust Score is not embedded: a number inside a Passport reads as a talent rating. Clients compose it into
    // the header from its own endpoint.
    return projectPassport(full, viewerKind, opts);
  }
  ctx.buildFootballPassport = buildFor;

  const viewerKindForOrg = (org) =>
    org.type === 'agency' ? 'agency' : org.level === 'grassroots' ? 'grassroots_club' : 'pro_club';

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
  /** A schema-read football date as stored: the precision the player gave, never an invented day. */
  const storedDate = (input) =>
    input === null || input === undefined || input === '' ? null : whenDisplay(normWhen(input));
  const prefsView = (p) => ({
    playerId: p.playerId,
    bio: p.bio,
    positions: p.positions ? { primary: p.positions.primary, secondary: [...p.positions.secondary] } : null,
    positionHistory: p.positionHistory.map((h) => ({
      id: h.id,
      from: h.from,
      primary: h.primary,
      secondary: [...h.secondary],
      submittedBy: h.submittedBy,
      recordedAt: h.recordedAt,
    })),
    availability: p.availability,
    availableFrom: p.availableFrom,
    publicSelections: [...p.publicSelections],
    updatedAt: p.updatedAt,
  });
  const entryView = (e) => ({
    id: e.id,
    playerId: e.playerId,
    orgName: e.orgName,
    role: e.role,
    from: e.from,
    to: e.to,
    note: e.note,
    submittedBy: e.submittedBy,
    createdAt: e.createdAt,
    withdrawnAt: e.withdrawnAt,
  });
  const achievementRecordView = (a) => ({
    id: a.id,
    playerId: a.playerId,
    title: a.title,
    orgName: a.orgName,
    when: a.when,
    submittedBy: a.submittedBy,
    confirmation: a.confirmation
      ? {
          provenance: a.confirmation.provenance,
          orgId: a.confirmation.orgId,
          orgName: a.confirmation.orgName,
          byName: a.confirmation.byName,
          at: a.confirmation.at,
        }
      : null,
    createdAt: a.createdAt,
    withdrawnAt: a.withdrawnAt,
  });
  const correctionView = (c) => ({
    id: c.id,
    playerId: c.playerId,
    targetType: c.targetType,
    targetId: c.targetId,
    reason: c.reason,
    by: { kind: c.by.kind, id: c.by.id, name: c.by.name },
    status: c.status,
    resolution: c.resolution
      ? { outcome: c.resolution.outcome, reason: c.resolution.reason, at: c.resolution.at }
      : null,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
  });

  // ----------------------------------------------------------- preferences
  function applyPrefs(res, player, input, submittedBy) {
    const body = inputOrRefuse(res, Prefs, input, PREFS_CODES);
    if (!body) return null;
    const set = {};
    if (body.bio !== undefined) {
      const bio = filled(body.bio);
      if (bio && !moderateOrRefuse(res, bio, { kind: 'passport_bio', playerId: player.id })) return null;
      set.bio = bio;
    }
    if (body.positions !== undefined) {
      const primary = body.positions?.primary ?? null;
      const others = [...new Set(body.positions?.secondary ?? [])];
      set.positions = primary || others.length ? { primary, secondary: others } : null;
    }
    let historyRow = null;
    if (body.positionHistoryAdd) {
      const h = body.positionHistoryAdd;
      const from = storedDate(h.from);
      const message = 'Position history needs at least a year.';
      if (!presentOrRefuse(res, from, 'positionHistoryAdd.from', { error: 'DATE_REQUIRED', message })) return null;
      historyRow = {
        id: nextId('ppos'),
        from,
        primary: h.primary,
        secondary: [...new Set(h.secondary ?? [])],
        submittedBy,
        recordedAt: Date.now(),
      };
    }
    if (body.availability !== undefined) set.availability = body.availability;
    if (body.availableFrom !== undefined) set.availableFrom = storedDate(body.availableFrom);
    if (body.publicSelections !== undefined) set.publicSelections = [...new Set(body.publicSelections ?? [])];
    const wasPrimary = prefsFor(player.id).positions?.primary ?? null;
    const saved = unit(() => {
      const p = passport.passportPrefs.save(player.id, (d) => {
        Object.assign(d, set);
        if (historyRow) d.positionHistory.push(historyRow);
        d.updatedAt = Date.now();
      });
      // A source change with its own clock: neither positionHistory.from (a football date) nor prefs.updatedAt (any
      // edit) means "the position changed". Re-saving the same preferences emits nothing.
      const nowPrimary = p.positions?.primary ?? null;
      if (nowPrimary !== wasPrimary) {
        ctx.recordSourceChange?.({
          playerId: player.id,
          type: 'position_changed',
          sourceSystem: 'passport_prefs',
          sourceId: `${player.id}:${nowPrimary ?? 'none'}`,
          detail: { from: wasPrimary, to: nowPrimary, submittedBy },
        });
      }
      if (historyRow) {
        ctx.recordSourceChange?.({
          playerId: player.id,
          type: 'position_changed',
          sourceSystem: 'position_history',
          sourceId: historyRow.id,
          occurredAt: historyRow.recordedAt,
          detail: { to: historyRow.primary, submittedBy },
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
  function addCareerEntry(res, player, input, submittedBy) {
    const body = inputOrRefuse(res, CareerEntry, input);
    if (!body) return null;
    const orgName = filled(body.orgName);
    if (!presentOrRefuse(res, orgName, 'orgName')) return null;
    const role = filled(body.role);
    const note = filled(body.note);
    if (
      !moderateOrRefuse(res, orgName + ' ' + (role ?? '') + ' ' + (note ?? ''), {
        kind: 'passport_career',
        playerId: player.id,
      })
    )
      return null;
    const from = storedDate(body.from);
    const message = 'A year is enough — exact dates are never invented.';
    if (!presentOrRefuse(res, from, 'from', { error: 'DATE_REQUIRED', message })) return null;
    const to = storedDate(body.to);
    const e = passport.careerEntries.create({
      id: nextId('pcar'),
      playerId: player.id,
      orgName,
      role,
      from,
      to,
      note,
      submittedBy,
      createdAt: Date.now(),
      withdrawnAt: null,
    });
    return e;
  }
  playerRouter.post('/football-passport/career', (req, res) => {
    const e = addCareerEntry(res, req.player, req.body ?? {}, 'player');
    if (e)
      res
        .status(201)
        .json({ entry: entryView(e), provenance: 'player_submitted', note: PROVENANCE_COPY.player_submitted });
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
    const e = passport.careerEntries.update(found.id, (d) => {
      d.withdrawnAt = Date.now();
    });
    res.json({
      entry: entryView(e),
      note: 'Self-submitted entries can be withdrawn; confirmed records cannot (request a correction instead).',
    });
  });

  // ------------------------------------------------------------ achievements
  playerRouter.post('/football-passport/achievements', (req, res) =>
    addAchievement(res, req.player, req.body ?? {}, 'player'),
  );
  guardianRouter.post('/children/:id/football-passport/achievements', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    addAchievement(res, child, req.body ?? {}, 'guardian');
  });
  function addAchievement(res, player, input, submittedBy) {
    // A client cannot assert provenance for itself: a body naming a confirmation is refused, and a new achievement is
    // self-submitted.
    const body = inputOrRefuse(res, Achievement, input);
    if (!body) return;
    const title = filled(body.title);
    if (!presentOrRefuse(res, title, 'title')) return;
    const orgName = filled(body.orgName);
    const when = storedDate(body.when);
    if (!moderateOrRefuse(res, title, { kind: 'passport_achievement', playerId: player.id })) return;
    const a = passport.achievements.create({
      id: nextId('pach'),
      playerId: player.id,
      title,
      orgName,
      when,
      submittedBy,
      confirmation: null,
      createdAt: Date.now(),
      withdrawnAt: null,
    });
    res.status(201).json({
      achievement: achievementRecordView(a),
      provenance: submittedBy === 'guardian' ? 'guardian_submitted' : 'player_submitted',
    });
  }
  playerRouter.post('/football-passport/achievements/:id/withdraw', (req, res) => {
    const a = vreads.achievements.byId(req.params.id);
    if (!a || a.playerId !== req.player.id) return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
    if (a.confirmation)
      return res.status(403).json({
        error: 'CONFIRMED_RECORD',
        message: 'A confirmed achievement is part of the record — request a correction instead of deleting it.',
      });
    const done = passport.achievements.update(a.id, (d) => {
      d.withdrawnAt = Date.now();
    });
    res.json({ achievement: achievementRecordView(done) });
  });
  // Confirmation upgrades provenance without rewriting the original.
  orgRouter.post('/players/:pid/football-passport/achievements/:id/confirm', (req, res) => {
    const p = findPlayer(req.params.pid);
    if (!p || !orgCanSee(req.org, p))
      return res.status(p ? 403 : 404).json({
        error: p ? (req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE') : 'PLAYER_NOT_FOUND',
      });
    if (!req.org.verified)
      return res
        .status(403)
        .json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can confirm an achievement.' });
    const a = vreads.achievements.byId(req.params.id);
    if (!a || a.playerId !== p.id || a.withdrawnAt) return res.status(404).json({ error: 'ACHIEVEMENT_NOT_FOUND' });
    if (a.confirmation) return res.status(409).json({ error: 'ALREADY_CONFIRMED' });
    const done = unit(() => {
      const c = passport.achievements.update(a.id, (d) => {
        d.confirmation = {
          provenance: 'verified_club_confirmed',
          orgId: req.org.id,
          orgName: String(req.org.name).slice(0, L.name),
          byName: String(req.orgUser.name ?? '').slice(0, L.name) || null,
          at: Date.now(),
        };
      });
      notify(
        { kind: 'player', id: p.id },
        'passport',
        `🏅 ${req.org.name} confirmed your achievement “${a.title}”.`,
        a.id,
      );
      if (p.guardianId)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'passport',
          `${req.org.name} confirmed ${p.name}'s achievement “${a.title}”.`,
          a.id,
        );
      return c;
    });
    vmetric('achievement_confirmed');
    res.json({ achievement: achievementRecordView(done) });
  });

  // ------------------------------------------------------------ corrections
  function fileCorrection(res, player, input, by) {
    const body = inputOrRefuse(res, Correction, input, CORRECTION_CODES);
    if (!body) return;
    const { targetType } = body;
    const targetId = body.targetId || null;
    const reason = filled(body.reason);
    if (!presentOrRefuse(res, reason, 'reason')) return;
    if (!moderateOrRefuse(res, reason, { kind: 'passport_correction', playerId: player.id })) return;
    const c = passport.corrections.create({
      id: nextId('pcor'),
      playerId: player.id,
      targetType,
      targetId,
      reason,
      by: { ...by, name: by.name ? String(by.name).slice(0, L.name) : null },
      status: 'open',
      resolution: null,
      createdAt: Date.now(),
    });
    vmetric('correction_filed');
    res.status(201).json({
      correction: correctionView(c),
      note: 'Authoritative records are never silently edited — Trust & Safety reviews correction requests, and verification claims can additionally be disputed through the existing verification flow.',
    });
  }
  playerRouter.post('/football-passport/corrections', (req, res) =>
    fileCorrection(res, req.player, req.body ?? {}, { kind: 'player', id: req.player.id, name: req.player.name }),
  );
  guardianRouter.post('/children/:id/football-passport/corrections', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    fileCorrection(res, child, req.body ?? {}, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  // Oldest first; `?all=1` lists resolved ones too.
  adminRouter.get('/passport/corrections', (req, res) => {
    const query = inputOrRefuse(res, CorrectionsQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = pageOf(
      vreads.corrections.page({ all: query.all === '1', ...page }).rows,
      page.limit,
      (r) => r.key,
    );
    res.json({ items: items.map((r) => correctionView(r.record)), nextCursor });
  });
  adminRouter.post('/passport/corrections/:id/resolve', (req, res) => {
    const c = vreads.corrections.byId(req.params.id);
    if (!c) return res.status(404).json({ error: 'CORRECTION_NOT_FOUND' });
    if (c.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const body = inputOrRefuse(res, CorrectionResolution, req.body ?? {}, RESOLUTION_CODES);
    if (!body) return;
    const { resolution } = body;
    const reason = filled(body.reason);
    if (!presentOrRefuse(res, reason, 'reason')) return;
    const done = unit(() => {
      const r = passport.corrections.update(c.id, (d) => {
        d.status = 'resolved';
        d.resolution = { outcome: resolution, reason, at: Date.now() };
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
      return res
        .status(403)
        .json({ error: req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    }
    const viewer = viewerKindForOrg(req.org);
    ledgerAppend({
      type: 'passport_recruitment_view',
      playerId: p.id,
      orgId: req.org.id,
      orgName: req.org.name,
      userId: req.orgUser.id,
      scoutName: req.orgUser.name,
    });
    vmetric('views_recruitment');
    res.json(buildFor(p, viewer, { orgId: req.org.id }));
  });

  orgRouter.get('/football-passports', (req, res) => {
    const query = inputOrRefuse(res, PassportsQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    const items = [];
    for (const id of listedIds(query.ids)) {
      const p = findPlayer(id);
      if (!p || !orgCanSee(req.org, p)) continue; // absent, not an error, so nothing is revealed
      const full = assemble(p, { light: true });
      items.push({
        playerId: p.id,
        position: full.player.position,
        age: full.player.age,
        currentClub: full.status.currentClub
          ? { name: full.status.currentClub.orgName, provenance: full.status.currentClub.provenance }
          : null,
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
