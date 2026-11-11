// No inference of protected characteristics, no public rankings, no pay-for-priority, small aggregates suppressed,
// absent evidence never recorded as poor ability, and exposure metrics carry their denominators and windows instead of
// claims about discrimination.
import crypto from 'node:crypto';
import { exposureHook } from '../enterprise/enterprise.mjs';
import { readPage, pageOf, sendPageError } from '../platform/paging.mjs';
import { EVIDENCE_RULE_IDS, INSIGHT_LIMITS, typeSubmission } from '../../repositories/insightCoverage.mjs';
import { filled, presentOrRefuse } from '../platform/schemas.mjs';
import { REVIEW_LATER_DAYS, insightInput } from './schemas.mjs';

const EXPOSURE_WINDOW_DAYS = 90;
const STALE_DAYS = 180;
const DAY_MS = 86_400_000;
const fieldInvalid = (res, field, message) => {
  res.status(400).json({ error: 'FIELD_INVALID', field, message });
  return undefined;
};
/**
 * Bounds a rule's hit to INSIGHT_LIMITS: a player with hundreds of clips, or a 20-attribute rubric never observed,
 * would otherwise exceed them and fail the read, and with it the Room view that runs the rules.
 */
export function boundGap(hit) {
  const max = INSIGHT_LIMITS.explanation;
  const explanation = hit.explanation.length > max ? `${hit.explanation.slice(0, max - 1)}…` : hit.explanation;
  return { records: [...new Set(hit.records)].slice(0, INSIGHT_LIMITS.records), explanation };
}

export function registerInsight(ctx) {
  const {
    byId,
    players,
    orgRouter,
    playerRouter,
    nextId,
    notify,
    findPlayer,
    isAdult,
    orgCanSee,
    suppress,
    isLead,
    requireLead,
    playerViewForOrg,
    insightCoverage,
    unit,
  } = ctx;
  if (!insightCoverage || typeof unit !== 'function')
    throw new TypeError('registerInsight needs the insight and coverage repository and the unit of work');
  const { exposure, reviewLater, suggestions, calibration } = insightCoverage;
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function')
    throw new TypeError('registerInsight needs recruitmentReads (signings) from the data layer');

  // ============================================================== exposure
  const dayKey = (ts = Date.now()) => Math.floor(ts / 86_400_000);
  function recordExposure(orgId, playerId, kind) {
    // One event per (org, player, kind, day), the table's unique key.
    const at = Date.now();
    const dk = dayKey(at);
    if (exposure.has(orgId, playerId, kind, dk)) return false;
    return exposure.record({ id: nextId('exp'), orgId, playerId, kind, day: dk, at });
  }

  // Passive capture at the response layer, so the profile and passport handlers stay untouched.
  exposureHook.fn = (req, res) => {
    if (!req.org || req.method !== 'GET' || res.statusCode !== 200) return;
    const fullPath = String(req.originalUrl ?? '').split('?')[0];
    const mProfile = fullPath.match(/^\/org\/players\/([a-z0-9-]+)$/i);
    const mPassport = fullPath.match(/^\/org\/players\/([a-z0-9-]+)\/passport$/i);
    if (mProfile) recordExposure(req.org.id, mProfile[1], 'profile_view');
    if (mPassport) recordExposure(req.org.id, mPassport[1], 'evidence_view');
  };

  // The client reports which players a search actually rendered.
  orgRouter.post('/exposure/impressions', (req, res) => {
    const body = insightInput(res, 'impressions', req.body);
    if (!body) return;
    const ids = body.playerIds;
    // Players this organisation cannot see are skipped, never refused: a refusal would say who is hidden.
    const recorded = unit(
      () =>
        ids.filter((id) => {
          const p = findPlayer(id);
          return p && orgCanSee(req.org, p) && recordExposure(req.org.id, id, 'impression');
        }).length,
    );
    res.json({ recorded });
  });

  const windowStartDay = () => dayKey() - EXPOSURE_WINDOW_DAYS;

  function funnelFor(orgId) {
    const seen = exposure.distinctPlayersByKind(orgId, windowStartDay());
    const impressions = { size: seen.impression };
    const profiles = { size: seen.profile_view };
    const evidence = { size: seen.evidence_view };
    const sinceTs = Date.now() - EXPOSURE_WINDOW_DAYS * 86_400_000;
    const invited = new Set(
      reads.requests
        .forOrg(orgId)
        .filter((r) => r.createdAt >= sinceTs)
        .map((r) => r.playerId),
    );
    const outcomes = new Set(
      reads.signings
        .forOrg(orgId)
        .filter((s) => (s.ts ?? 0) >= sinceTs)
        .map((s) => s.playerId),
    );
    return {
      windowDays: EXPOSURE_WINDOW_DAYS,
      definition:
        'Unique players per stage within the window; events deduplicated per (player, kind, day). Denominator for each rate is the previous stage.',
      stages: [
        { key: 'eligible_impression', players: impressions.size },
        { key: 'profile_review', players: profiles.size, of: impressions.size },
        { key: 'evidence_review', players: evidence.size, of: profiles.size },
        { key: 'invitation', players: invited.size, of: evidence.size },
        { key: 'outcome', players: outcomes.size, of: invited.size },
      ],
    };
  }

  orgRouter.get('/exposure/report', (req, res) => {
    if (!requireLead(req, res)) return;
    const funnel = funnelFor(req.org.id);
    // Birth-quarter distribution of players this org assessed in the window: suppressed under n<3, and not a
    // discrimination verdict.
    const sinceTs = Date.now() - EXPOSURE_WINDOW_DAYS * 86_400_000;
    const assessed = ctx.scoutingReads.assessments
      .forOrg(req.org.id)
      .filter((a) => a.state !== 'draft' && a.createdAt >= sinceTs);
    const quarters = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    for (const a of assessed) {
      const p = findPlayer(a.playerId);
      // The UTC month: `getMonth()` on a UTC-midnight date reads the previous month west of Greenwich (1 April births
      // would count in Q1 on a server in New York).
      const day = parseStrictDateOnly(p?.dob);
      if (day.ok) quarters[`Q${Math.floor(new Date(day.t).getUTCMonth() / 3) + 1}`]++;
    }
    const total = assessed.length;
    res.json({
      funnel,
      birthQuarter: suppress(total)
        ? {
            suppressed: true,
            note: `Fewer than 3 assessed players in the window — the distribution is withheld to protect individuals.`,
          }
        : {
            total,
            quarters,
            note: 'Distribution of assessed players by birth quarter (relative-age lens). An aggregate pattern is a prompt to look again — it does not prove discrimination, and nothing here infers ethnicity, socioeconomic status, disability or biological maturity.',
          },
      absentEvidence: {
        note: 'Players with NO evidence reviewed are counted as “not yet reviewed”, never as poor performers.',
        notYetReviewed: reviewQueueFor(req.org).length,
      },
    });
  });

  // Visible players with exposure but no submitted assessment from this org, oldest exposure first.
  function reviewQueueFor(org) {
    const assessedIds = new Set(
      ctx.scoutingReads.assessments
        .forOrg(org.id)
        .filter((a) => a.state !== 'draft')
        .map((a) => a.playerId),
    );
    return exposure
      .firstSeen(org.id, windowStartDay())
      .filter(({ playerId }) => !assessedIds.has(playerId))
      .map(({ playerId, firstDay }) => ({ player: findPlayer(playerId), firstSeenDay: firstDay }))
      .filter((x) => x.player && orgCanSee(org, x.player)); // live eligibility
  }

  orgRouter.get('/review-queue', (req, res) => {
    const later = reviewLater.activeFor(req.org.id, Date.now());
    const items = reviewQueueFor(req.org).map(({ player, firstSeenDay }) => ({
      player: playerViewForOrg
        ? playerViewForOrg(player, req.org)
        : { id: player.id, name: player.name, position: player.position, age: null },
      firstSeenDaysAgo: dayKey() - firstSeenDay,
      deferredUntil: later.get(player.id) ?? null,
      staleAssessment: null,
    }));
    const staleCut = Date.now() - STALE_DAYS * 86_400_000;
    const submitted = ctx.scoutingReads.assessments.forOrg(req.org.id).filter((a) => a.state !== 'draft');
    const stale = submitted
      .filter((a) => a.createdAt < staleCut)
      .reduce((m, a) => {
        const cur = m.get(a.playerId);
        if (!cur || cur < a.createdAt) m.set(a.playerId, a.createdAt);
        return m;
      }, new Map());
    const staleItems = [...stale.entries()]
      .filter(([pid, last]) => !submitted.some((a) => a.playerId === pid && a.createdAt >= staleCut))
      .map(([pid, last]) => ({
        playerId: pid,
        playerName: findPlayer(pid)?.name,
        lastAssessedAt: last,
        note: `last assessed over ${STALE_DAYS} days ago`,
      }))
      .filter((x) => {
        const p = findPlayer(x.playerId);
        return p && orgCanSee(req.org, p);
      });
    res.json({
      queue: items.filter((i) => !i.deferredUntil),
      deferred: items.filter((i) => i.deferredUntil),
      staleEvaluations: staleItems,
    });
  });

  orgRouter.post('/review-queue/:playerId/later', (req, res) => {
    const body = insightInput(res, 'later', req.body);
    if (!body) return;
    const days = body.days ?? REVIEW_LATER_DAYS.default;
    // Only a player the organisation can see now can be deferred.
    const p = findPlayer(req.params.playerId);
    if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    reviewLater.defer({
      id: nextId('rvl'),
      orgId: req.org.id,
      playerId: p.id,
      byUserId: req.orgUser.id,
      dueAt: Date.now() + days * DAY_MS,
      remindedAt: null,
    });
    res.json({ deferredDays: days });
  });

  // A deterministic weekly slice of eligible players this org has not assessed. Visibility comes first, so an
  // ineligible player can never enter through the rotation.
  orgRouter.get('/discovery-rotation', (req, res) => {
    const week = Math.floor(dayKey() / 7);
    const assessedIds = new Set(
      ctx.scoutingReads.assessments
        .forOrg(req.org.id)
        .filter((a) => a.state !== 'draft')
        .map((a) => a.playerId),
    );
    // The six with the smallest weekly hash byte win (ties keep creation order); only they are decoded.
    const best = [];
    players.scanLight({ visibleTo: req.org }, (p) => {
      if (assessedIds.has(p.id)) return;
      const r = crypto.createHash('sha256').update(`${p.id}:${req.org.id}:${week}`).digest()[0];
      if (best.length === 6 && r >= best[5].r) return;
      let i = best.length;
      while (i > 0 && best[i - 1].r > r) i -= 1;
      best.splice(i, 0, { id: p.id, r });
      if (best.length > 6) best.pop();
    });
    const scored = players.byIds(best.map((b) => b.id)).filter((p) => orgCanSee(req.org, p));
    res.json({
      week,
      items: scored.map((p) =>
        playerViewForOrg ? playerViewForOrg(p, req.org) : { id: p.id, name: p.name, position: p.position },
      ),
      note: 'A rotating slice of eligible players you have not assessed — same pool as search, different order each week. Rotation never includes anyone outside your standing visibility rules, and nothing can pay its way in.',
    });
  });

  // Coarse counts only, no org identities.
  playerRouter.get('/exposure', (req, res) => {
    const mine = exposure.forPlayer(req.player.id, windowStartDay());
    const band = (n) => (n === 0 ? '0' : n <= 5 ? '1–5' : n <= 20 ? '6–20' : '20+');
    res.json({
      windowDays: EXPOSURE_WINDOW_DAYS,
      appearedInSearches: band(mine.byKind.impression),
      profileViews: band(mine.byKind.profile_view),
      clubs: band(mine.orgCount),
      note: 'Coarse ranges over the last 90 days. Which club looked is not shown — interest becomes visible when a club actually contacts you through the proper channel.',
    });
  });

  /** Exposure events before the window are deleted: no reader looks at them. */
  function insightSweep() {
    const at = Date.now();
    let changed = 0;
    for (const r of reviewLater.dueForReminder(at)) {
      unit(() => {
        reviewLater.markReminded(r.id, at);
        const p = findPlayer(r.playerId);
        notify(
          { kind: 'org_user', id: r.byUserId },
          'review_queue',
          `⏰ Review reminder: you deferred ${p?.name ?? 'a player'} — they are back in your review queue.`,
          r.playerId,
        );
      });
      changed++;
    }
    exposure.prune(dayKey(at) - EXPOSURE_WINDOW_DAYS);
    return changed;
  }

  // =========================================================== calibration
  const activeStaffOf = (orgId, uid) => byId.user(uid, (u) => u.orgId === orgId && !u.removedAt);
  orgRouter.post('/calibration', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = insightInput(res, 'calibration', req.body);
    if (!b) return;
    const tmpl = b.templateId ? ctx.scoutingReads.templates.currentById(b.templateId) : null;
    if (!tmpl) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
    const title = filled(b.title) ?? 'Calibration session';
    // Reference footage must be footage this org can see now.
    const mediaId = b.mediaId ?? null;
    if (mediaId) {
      const owner = byId.mediaOwner(mediaId);
      if (!owner || !orgCanSee(req.org, owner))
        return res.status(403).json({
          error: 'FOOTAGE_NOT_ACCESSIBLE',
          message: 'Calibration footage must be footage your organisation can legitimately access.',
        });
    }
    const ids = b.participantUserIds;
    const stranger = ids.find((uid) => !activeStaffOf(req.org.id, uid));
    if (stranger)
      return fieldInvalid(
        res,
        'participantUserIds',
        'Every participant must be a current member of your organisation.',
      );
    if (ids.length < 2)
      return res
        .status(400)
        .json({ error: 'PARTICIPANTS_REQUIRED', message: 'Calibration needs at least two participating scouts.' });
    const s = unit(() => {
      const created = calibration.create({
        id: nextId('cal'),
        orgId: req.org.id,
        title,
        templateId: tmpl.id,
        templateVersion: tmpl.version, // rubric pinned: later template edits change nothing here
        mediaId,
        participants: ids,
        submissions: [],
        notes: [],
        status: 'open',
        createdBy: req.orgUser.id,
        createdAt: Date.now(),
        closedAt: null,
      });
      for (const uid of ids)
        notify(
          { kind: 'org_user', id: uid },
          'calibration',
          `🎯 You were added to calibration “${created.title}”. Watch the reference footage and submit blind — you cannot see colleagues’ ratings until you do.`,
          created.id,
        );
      return created;
    });
    res.status(201).json({ session: sessionView(s, req) });
  });

  function sessionView(s, req) {
    const mySubmitted = s.submissions.some((x) => x.userId === req.orgUser.id);
    const released = s.status === 'closed' || mySubmitted;
    const owner = s.mediaId ? byId.mediaOwner(s.mediaId) : null;
    const footageAccessible = owner ? orgCanSee(req.org, owner) : false;
    const attributesSnapshot = calibration.attributesOf(s);
    return {
      id: s.id,
      orgId: s.orgId,
      title: s.title,
      templateId: s.templateId,
      templateVersion: s.templateVersion,
      attributesSnapshot,
      mediaId: s.mediaId,
      participants: [...s.participants],
      notes: s.notes.map((n) => ({ at: n.at, byUserId: n.byUserId, byName: n.byName, text: n.text })),
      status: s.status,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      closedAt: s.closedAt,
      mediaUrl: footageAccessible ? `/media/${s.mediaId}` : null,
      footageNote:
        s.mediaId && !footageAccessible ? 'Reference footage is no longer accessible to your organisation.' : null,
      // Blind: until you submit (or a lead closes the session), you see who has submitted, never what.
      submissions: s.submissions.map((x) =>
        released
          ? {
              userId: x.userId,
              userName: x.userName,
              ratings: x.ratings.map((r) => ({ ...r })),
              confidence: x.confidence,
              submittedAt: x.submittedAt,
            }
          : { userId: x.userId, userName: x.userName, submittedAt: x.submittedAt },
      ),
      comparison: released ? comparisonFor(s, attributesSnapshot) : null,
      blind: !released,
    };
  }

  function comparisonFor(s, attributes) {
    const rows = [];
    for (const attr of attributes) {
      const vals = s.submissions
        .map((sub) => sub.ratings.find((r) => r.attrId === attr.id))
        .filter((r) => r && !r.notObserved)
        .map((r) => r.value);
      const notObserved = s.submissions.length - vals.length;
      rows.push({
        attrId: attr.id,
        label: attr.label,
        values: vals,
        notObserved,
        range: vals.length ? Math.max(...vals) - Math.min(...vals) : null,
        mean: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
        disagreement:
          vals.length >= 2
            ? Math.max(...vals) - Math.min(...vals) >= 2
              ? 'high'
              : Math.max(...vals) - Math.min(...vals) === 1
                ? 'moderate'
                : 'aligned'
            : 'insufficient',
      });
    }
    return {
      rows,
      sampleSize: s.submissions.length,
      confidenceNote: `Comparison of ${s.submissions.length} blind submissions on one reference clip — a conversation starter about the rubric, not a measure of who is “right”.`,
    };
  }

  orgRouter.get('/calibration', (req, res) => {
    const query = insightInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const rows = calibration.page(req.org.id, {
      userId: isLead(req.orgUser) ? null : req.orgUser.id,
      after: page.after,
      limit: page.limit,
    });
    res.json(
      pageOf(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          participants: r.participants,
          submitted: r.submitted,
          createdAt: r.createdAt,
        })),
        page.limit,
        (r) => [r.createdAt, r.id],
      ),
    );
  });

  orgRouter.get('/calibration/:id', (req, res) => {
    const s = calibration.forOrgById(req.org.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!s.participants.includes(req.orgUser.id) && !isLead(req.orgUser))
      return res.status(403).json({ error: 'NOT_A_PARTICIPANT' });
    res.json({ session: sessionView(s, req) });
  });

  orgRouter.post('/calibration/:id/submit', (req, res) => {
    const s = calibration.forOrgById(req.org.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (s.status !== 'open') return res.status(409).json({ error: 'SESSION_CLOSED' });
    if (!s.participants.includes(req.orgUser.id)) return res.status(403).json({ error: 'NOT_A_PARTICIPANT' });
    if (s.submissions.some((x) => x.userId === req.orgUser.id))
      return res
        .status(409)
        .json({ error: 'ALREADY_SUBMITTED', message: 'Blind submissions are final — one per participant.' });
    const b = insightInput(res, 'submission', req.body);
    if (!b) return;
    if (!b.ratings?.length) return res.status(400).json({ error: 'RATINGS_REQUIRED', field: 'ratings' });
    const confidence = b.confidence ?? 'medium';
    const sub = typeSubmission(
      {
        userId: req.orgUser.id,
        userName: req.orgUser.name ?? null,
        ratings: b.ratings,
        confidence,
        submittedAt: Date.now(),
      },
      'submission',
    );
    if (!sub.ok)
      return fieldInvalid(
        res,
        'ratings',
        `Each rating is { attrId, value 1–5 } or { attrId, notObserved: true }, one per attribute (${sub.reason.replace(/^submission\.?/, '')}).`,
      );
    const rubric = new Set(calibration.attributesOf(s).map((a) => a.id));
    const unknown = sub.record.ratings.find((r) => !rubric.has(r.attrId));
    if (unknown) return fieldInvalid(res, 'ratings', `The pinned rubric has no attribute ${unknown.attrId}.`);
    const fresh = calibration.submit(s.id, sub.record);
    res
      .status(201)
      .json({ session: sessionView(fresh, req), note: 'Submitted — the comparison is now visible to you.' });
  });

  orgRouter.post('/calibration/:id/close', (req, res) => {
    if (!requireLead(req, res)) return;
    if (!insightInput(res, 'none', req.body)) return;
    const s = calibration.forOrgById(req.org.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    res.json({ session: sessionView(calibration.close(s.id, Date.now()), req) });
  });

  orgRouter.post('/calibration/:id/notes', (req, res) => {
    const s = calibration.forOrgById(req.org.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!s.participants.includes(req.orgUser.id) && !isLead(req.orgUser))
      return res.status(403).json({ error: 'NOT_A_PARTICIPANT' });
    if (s.status !== 'closed' && !s.submissions.some((x) => x.userId === req.orgUser.id))
      return res
        .status(409)
        .json({ error: 'SUBMIT_FIRST', message: 'Discussion notes open after your blind submission.' });
    const body = insightInput(res, 'note', req.body);
    if (!body) return;
    const t = filled(body.text);
    if (!presentOrRefuse(res, t, 'text', { error: 'FIELD_INVALID' })) return;
    if (s.notes.length >= INSIGHT_LIMITS.notes)
      return res
        .status(409)
        .json({ error: 'TOO_MANY_NOTES', message: `A session keeps at most ${INSIGHT_LIMITS.notes} notes.` });
    const fresh = calibration.addNote(s.id, {
      at: Date.now(),
      byUserId: req.orgUser.id,
      byName: req.orgUser.name ?? null,
      text: t,
    });
    res
      .status(201)
      .json({ notes: fresh.notes.map((n) => ({ at: n.at, byUserId: n.byUserId, byName: n.byName, text: n.text })) });
  });

  // Earlier recommendations next to what happened since, with the causal disclaimer in the payload.
  orgRouter.get('/decision-review', (req, res) => {
    if (!requireLead(req, res)) return;
    const orgSubmitted = ctx.scoutingReads.assessments.forOrg(req.org.id).filter((a) => a.state !== 'draft');
    const decided = orgSubmitted.filter((a) => a.recommendation);
    const items = decided.slice(-50).map((a) => {
      const laterSigning = reads.signings.forPlayer(a.playerId).find((s) => (s.ts ?? 0) > a.createdAt);
      const laterAssessments = orgSubmitted.filter(
        (x) => x.playerId === a.playerId && x.createdAt > a.createdAt,
      ).length;
      return {
        assessmentId: a.id,
        playerName: a.playerName,
        scoutName: a.scoutName,
        recommendation: a.recommendation,
        at: a.createdAt,
        since: { signedSomewhere: !!laterSigning, furtherAssessments: laterAssessments },
      };
    });
    res.json({
      items,
      disclaimer:
        'What happened after a recommendation reflects hundreds of factors. This view supports reflective review of evidence quality — it does not measure whether a scout “caused” an outcome, and it is never published or ranked.',
    });
  });

  // ====================================================== missing evidence
  const RULES_VERSION = 1;
  const RULES = [
    {
      id: 'no_recent_footage',
      version: RULES_VERSION,
      action: 'Ask for a recent clip (through the proper channel).',
      evaluate(player) {
        const fresh = player.media.filter(
          (m) => new Date(m.uploadedAt ?? 0).getTime() > Date.now() - STALE_DAYS * 86_400_000,
        );
        if (player.media.length && fresh.length) return null;
        return {
          records: player.media.map((m) => m.id),
          explanation:
            player.media.length === 0
              ? 'No footage on the profile yet.'
              : `All ${player.media.length} clips are older than ${STALE_DAYS} days.`,
        };
      },
    },
    {
      id: 'single_match_sample',
      version: RULES_VERSION,
      action: 'Request footage from a second match before concluding anything.',
      evaluate(player) {
        if (player.media.length === 0) return null; // covered by no_recent_footage
        const sources = new Set(player.media.map((m) => m.verifiedClip ?? `unverified:${m.id}`));
        const verifiedSources = new Set(player.media.filter((m) => m.verifiedClip).map((m) => m.verifiedClip));
        if (player.media.length >= 2 && verifiedSources.size <= 1 && player.media.every((m) => m.verifiedClip)) {
          return {
            records: player.media.map((m) => m.id),
            explanation: 'Every clip is linked to the same verified fixture — one match is a thin sample.',
          };
        }
        if (player.media.length === 1) {
          return { records: [player.media[0].id], explanation: 'Only one clip available — a single viewing context.' };
        }
        return null;
      },
    },
    {
      id: 'attribute_never_observed',
      version: RULES_VERSION,
      action: 'Plan an observation that covers the unobserved attribute.',
      evaluate(player, org) {
        const subs = ctx.scoutingReads.assessments.forOrgPlayer(org.id, player.id).filter((a) => a.state !== 'draft');
        if (!subs.length) return null;
        const gaps = [];
        const attrs = subs[subs.length - 1].attributesSnapshot ?? [];
        for (const attr of attrs) {
          const observed = subs.some((a) => a.ratings.some((r) => r.attrId === attr.id && !r.notObserved));
          if (!observed) gaps.push(attr.label);
        }
        if (!gaps.length) return null;
        return {
          records: subs.map((a) => a.id),
          explanation: `No evidence yet of: ${gaps.join(', ')} — every submitted report marked ${gaps.length > 1 ? 'them' : 'it'} “not observed”.`,
        };
      },
    },
    {
      id: 'assessment_disagreement',
      version: RULES_VERSION,
      action: 'A third independent observation would resolve the split.',
      evaluate(player, org) {
        const subs = ctx.scoutingReads.assessments.forOrgPlayer(org.id, player.id).filter((a) => a.state !== 'draft');
        if (subs.length < 2) return null;
        for (const attr of subs[0].attributesSnapshot ?? []) {
          const vals = subs
            .map((a) => a.ratings.find((r) => r.attrId === attr.id))
            .filter((r) => r && !r.notObserved)
            .map((r) => r.value);
          if (vals.length >= 2 && Math.max(...vals) - Math.min(...vals) >= 2) {
            return {
              records: subs.map((a) => a.id),
              explanation: `Your scouts disagree on “${attr.label}” (ratings span ${Math.min(...vals)}–${Math.max(...vals)}).`,
            };
          }
        }
        return null;
      },
    },
    {
      id: 'stale_assessment',
      version: RULES_VERSION,
      action: 'Schedule a re-observation — the picture is out of date.',
      evaluate(player, org) {
        const subs = ctx.scoutingReads.assessments.forOrgPlayer(org.id, player.id).filter((a) => a.state !== 'draft');
        if (!subs.length) return null;
        const latest = Math.max(...subs.map((a) => a.createdAt));
        if (latest > Date.now() - STALE_DAYS * 86_400_000) return null;
        return {
          records: subs.map((a) => a.id),
          explanation: `The most recent submitted assessment is over ${STALE_DAYS} days old.`,
        };
      },
    },
    {
      id: 'uncorroborated_claims',
      version: RULES_VERSION,
      action: 'Ask a coach or run a club assessment to corroborate the claim.',
      evaluate(player) {
        const claims = ctx.scoutingReads.evidence.currentForPlayer(player.id);
        const selfOnly = claims.filter((e) => e.tier === 'self_reported');
        if (!claims.length || selfOnly.length < claims.length || !selfOnly.length) return null;
        return {
          records: selfOnly.map((e) => e.id),
          explanation: `All ${selfOnly.length} evidence-passport records are self-reported — nothing is coach-confirmed or club-assessed yet.`,
        };
      },
    },
  ];

  if (RULES.map((r) => r.id).join() !== EVIDENCE_RULE_IDS.join())
    throw new Error('insight: the evidence-gap rules and the stored rule vocabulary (EVIDENCE_RULE_IDS) differ');
  const RULE_ACTION = Object.fromEntries(RULES.map((r) => [r.id, r.action]));

  const suggestionView = (s) => ({
    id: s.id,
    orgId: s.orgId,
    playerId: s.playerId,
    playerName: s.playerName,
    ruleId: s.ruleId,
    ruleVersion: s.ruleVersion,
    records: [...s.records],
    explanation: s.explanation,
    action: RULE_ACTION[s.ruleId],
    status: s.status,
    requestedAt: s.requestedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });

  /**
   * Open suggestions that no longer fire become 'supplied', new hits become 'suggested', and an open one is rewritten
   * only when its records or explanation changed.
   */
  function computeGaps(org, player) {
    const found = [];
    for (const rule of RULES) {
      const hit = rule.evaluate(player, org);
      if (hit) found.push({ ruleId: rule.id, ruleVersion: rule.version, ...boundGap(hit) });
    }
    const list = unit(() =>
      suggestions.reconcile({
        orgId: org.id,
        playerId: player.id,
        playerName: player.name ?? null,
        found,
        at: Date.now(),
        mintId: () => nextId('gap'),
      }),
    );
    return list.map(suggestionView);
  }

  orgRouter.get('/players/:id/evidence-gaps', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const suggestions = computeGaps(req.org, p);
    res.json({
      items: suggestions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      engine: {
        kind: 'deterministic rules',
        version: RULES_VERSION,
        rules: RULES.map((r) => r.id),
        note: 'Every suggestion cites its rule and the records behind it. No AI generation is involved.',
      },
    });
  });

  // The one path that turns a gap into a player-facing ask, shared with the Recruitment Room so both get the same
  // anti-pestering window, guardian routing and player-safe wording.
  function requestEvidenceGap({ org, suggestionId, playerId = null }) {
    // From a Room, the suggestion must be about that room's player; any other reads as not found.
    const found = suggestions.forOrgById(org.id, suggestionId);
    const s = found && (playerId === null || found.playerId === playerId) ? found : null;
    if (!s) return { ok: false, status: 404, error: 'SUGGESTION_NOT_FOUND' };
    if (s.status !== 'suggested') return { ok: false, status: 409, error: 'NOT_OPEN', detail: { status: s.status } };
    const p = findPlayer(s.playerId);
    if (!p || !orgCanSee(org, p)) return { ok: false, status: 403, error: 'NOT_VISIBLE' };
    // Anti-pestering: one open request per player and rule, and none within 14 days of the last.
    const at = Date.now();
    if (suggestions.recentRequest(org.id, s.playerId, s.ruleId, at - 14 * DAY_MS, s.id))
      return {
        ok: false,
        status: 429,
        error: 'RECENTLY_REQUESTED',
        message: 'You asked for this within the last 14 days — give them time.',
      };
    // Player-visible text comes from the rule's action only; club-private observations never travel.
    const audience =
      !isAdult(p) && p.guardianId ? { kind: 'guardian', id: p.guardianId } : { kind: 'player', id: p.id };
    const who = audience.kind === 'guardian' ? `${p.name}'s profile` : 'your profile';
    // A Room caller's unit joins this one.
    const fresh = unit(() => {
      const moved = suggestions.setStatus(s.id, 'requested', at);
      notify(
        audience,
        'evidence_request',
        `📎 ${org.name} would find ${who} easier to assess with more evidence: ${playerSafeText(s)} You choose what (and whether) to add.`,
        s.id,
      );
      return moved;
    });
    return { ok: true, suggestion: suggestionView(fresh), routedTo: audience.kind };
  }

  orgRouter.post('/evidence-gaps/:id/request', (req, res) => {
    if (!insightInput(res, 'none', req.body)) return;
    const out = requestEvidenceGap({ org: req.org, suggestionId: req.params.id });
    if (!out.ok)
      return res
        .status(out.status)
        .json({ error: out.error, ...(out.message ? { message: out.message } : {}), ...(out.detail ?? {}) });
    res.json({ suggestion: out.suggestion });
  });

  function playerSafeText(s) {
    // Whitelisted per rule; refers to the player's own records only.
    const map = {
      no_recent_footage: 'a recent clip would help (the current footage is older than 6 months).',
      single_match_sample: 'a clip from a second match would give a fuller picture.',
      attribute_never_observed: 'footage covering more aspects of your game would help.',
      assessment_disagreement: 'another opportunity to watch you play would help their review.',
      stale_assessment: 'they would like a more recent look at your game.',
      uncorroborated_claims: 'a coach confirmation on your evidence passport would strengthen it.',
    };
    return map[s.ruleId] ?? 'more recent evidence would help.';
  }

  orgRouter.post('/evidence-gaps/:id/dismiss', (req, res) => {
    if (!insightInput(res, 'none', req.body)) return;
    const s = suggestions.forOrgById(req.org.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
    res.json({ suggestion: suggestionView(suggestions.setStatus(s.id, 'dismissed', Date.now())) });
  });

  orgRouter.post('/evidence-gaps/:id/reviewed', (req, res) => {
    if (!insightInput(res, 'none', req.body)) return;
    const s = suggestions.forOrgById(req.org.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
    if (s.status !== 'supplied')
      return res.status(409).json({ error: 'NOT_SUPPLIED', message: 'Mark reviewed once the gap shows as supplied.' });
    res.json({ suggestion: suggestionView(suggestions.setStatus(s.id, 'reviewed', Date.now())) });
  });

  return { insightSweep, requestEvidenceGap, computeEvidenceGaps: computeGaps };
}
