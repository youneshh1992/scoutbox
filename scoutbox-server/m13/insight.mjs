// F4 — Overlooked-player and exposure review.
// F5 — Scout calibration and decision-quality review.
// F6 — Missing-evidence assistant (transparent, versioned rule engine).
// Shared honesty rules: no inference of protected characteristics, no public
// rankings, no pay-for-priority, small aggregates suppressed, absent evidence
// is NEVER recorded as poor ability, and exposure metrics carry their
// denominators and windows instead of claims about discrimination.
import crypto from 'node:crypto';
import { exposureHook } from './enterprise.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';

const EXPOSURE_WINDOW_DAYS = 90;
const STALE_DAYS = 180;

export function registerInsight(ctx) {
  const {
    db, orgRouter, playerRouter, adminRouter, nextId, persist, persistNow,
    notify, findPlayer, isAdult, orgCanSee, paginate, histAppend, suppress,
    isLead, requireLead, playerViewForOrg,
  } = ctx;

  // =========================================================== F4 exposure
  const dayKey = (ts = Date.now()) => Math.floor(ts / 86_400_000);
  function recordExposure(orgId, playerId, kind) {
    // Dedupe: one event per (org, player, kind, day).
    const dk = dayKey();
    if (db.exposureEvents.some((e) => e.orgId === orgId && e.playerId === playerId && e.kind === kind && e.day === dk)) return false;
    db.exposureEvents.push({ id: nextId('exp'), orgId, playerId, kind, day: dk, at: Date.now() });
    if (db.exposureEvents.length > 50_000) db.exposureEvents.splice(0, 10_000);
    persist();
    return true;
  }
  ctx.recordExposure = recordExposure;

  // Passive capture at the response layer: profile + passport reads become
  // exposure events without touching the M7–M12 handlers.
  exposureHook.fn = (req, res) => {
    if (!req.org || req.method !== 'GET' || res.statusCode !== 200) return;
    const fullPath = String(req.originalUrl ?? '').split('?')[0];
    const mProfile = fullPath.match(/^\/org\/players\/([a-z0-9-]+)$/i);
    const mPassport = fullPath.match(/^\/org\/players\/([a-z0-9-]+)\/passport$/i);
    if (mProfile) recordExposure(req.org.id, mProfile[1], 'profile_view');
    if (mPassport) recordExposure(req.org.id, mPassport[1], 'evidence_view');
  };

  // Impressions: the client reports which players a search actually rendered.
  orgRouter.post('/exposure/impressions', (req, res) => {
    const ids = (Array.isArray(req.body?.playerIds) ? req.body.playerIds : []).slice(0, 50);
    let recorded = 0;
    for (const id of ids) {
      const p = findPlayer(id);
      if (p && orgCanSee(req.org, p) && recordExposure(req.org.id, id, 'impression')) recorded++;
    }
    res.json({ recorded });
  });

  const windowStartDay = () => dayKey() - EXPOSURE_WINDOW_DAYS;

  function funnelFor(orgId) {
    const since = windowStartDay();
    const ev = db.exposureEvents.filter((e) => e.orgId === orgId && e.day >= since);
    const byKind = (k) => new Set(ev.filter((e) => e.kind === k).map((e) => e.playerId));
    const impressions = byKind('impression');
    const profiles = byKind('profile_view');
    const evidence = byKind('evidence_view');
    const sinceTs = Date.now() - EXPOSURE_WINDOW_DAYS * 86_400_000;
    const invited = new Set(db.requests.filter((r) => r.orgId === orgId && r.createdAt >= sinceTs).map((r) => r.playerId));
    const outcomes = new Set(db.signings.filter((s) => s.orgId === orgId && (s.ts ?? 0) >= sinceTs).map((s) => s.playerId));
    return {
      windowDays: EXPOSURE_WINDOW_DAYS,
      definition: 'Unique players per stage within the window; events deduplicated per (player, kind, day). Denominator for each rate is the previous stage.',
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
    // Birth-quarter distribution of players this org ASSESSED in the window —
    // an aggregate lens on selection patterns, suppressed under n<3 and
    // explicitly not a discrimination verdict.
    const sinceTs = Date.now() - EXPOSURE_WINDOW_DAYS * 86_400_000;
    const assessed = db.assessments.filter((a) => a.orgId === req.org.id && a.state !== 'draft' && a.createdAt >= sinceTs);
    const quarters = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    for (const a of assessed) {
      const p = findPlayer(a.playerId);
      // M23 P5.7 (T-9): the UTC month of a READABLE birth day. `getMonth()`
      // on a UTC-midnight date read the previous month in any zone west of
      // Greenwich, so 1 April births counted in Q1 when the server ran in New York.
      const day = parseStrictDateOnly(p?.dob);
      if (day.ok) quarters[`Q${Math.floor(new Date(day.t).getUTCMonth() / 3) + 1}`]++;
    }
    const total = assessed.length;
    res.json({
      funnel,
      birthQuarter: suppress(total)
        ? { suppressed: true, note: `Fewer than 3 assessed players in the window — the distribution is withheld to protect individuals.` }
        : { total, quarters, note: 'Distribution of assessed players by birth quarter (relative-age lens). An aggregate pattern is a prompt to look again — it does not prove discrimination, and nothing here infers ethnicity, socioeconomic status, disability or biological maturity.' },
      absentEvidence: {
        note: 'Players with NO evidence reviewed are counted as “not yet reviewed”, never as poor performers.',
        notYetReviewed: reviewQueueFor(req.org).length,
      },
    });
  });

  // "Not yet assessed" queue — eligible, visible players with exposure but no
  // submitted assessment from this org, oldest exposure first.
  function reviewQueueFor(org) {
    const assessedIds = new Set(db.assessments.filter((a) => a.orgId === org.id && a.state !== 'draft').map((a) => a.playerId));
    const since = windowStartDay();
    const seen = new Map(); // playerId → first day seen
    for (const e of db.exposureEvents.filter((e) => e.orgId === org.id && e.day >= since)) {
      if (!seen.has(e.playerId) || seen.get(e.playerId) > e.day) seen.set(e.playerId, e.day);
    }
    return [...seen.entries()]
      .filter(([pid]) => !assessedIds.has(pid))
      .map(([pid, day]) => ({ player: findPlayer(pid), firstSeenDay: day }))
      .filter((x) => x.player && orgCanSee(org, x.player)) // live eligibility, always
      .sort((a, b) => a.firstSeenDay - b.firstSeenDay);
  }

  orgRouter.get('/review-queue', (req, res) => {
    const later = new Map(db.reviewLater.filter((r) => r.orgId === req.org.id && r.dueAt > Date.now()).map((r) => [r.playerId, r.dueAt]));
    const items = reviewQueueFor(req.org).map(({ player, firstSeenDay }) => ({
      player: playerViewForOrg ? playerViewForOrg(player, req.org) : { id: player.id, name: player.name, position: player.position, age: null },
      firstSeenDaysAgo: dayKey() - firstSeenDay,
      deferredUntil: later.get(player.id) ?? null,
      staleAssessment: null,
    }));
    // Stale evaluations: assessed long ago, still on shortlist/watch.
    const staleCut = Date.now() - STALE_DAYS * 86_400_000;
    const stale = db.assessments
      .filter((a) => a.orgId === req.org.id && a.state !== 'draft' && a.createdAt < staleCut)
      .reduce((m, a) => { const cur = m.get(a.playerId); if (!cur || cur < a.createdAt) m.set(a.playerId, a.createdAt); return m; }, new Map());
    const staleItems = [...stale.entries()]
      .filter(([pid, last]) => !db.assessments.some((a) => a.orgId === req.org.id && a.playerId === pid && a.state !== 'draft' && a.createdAt >= staleCut))
      .map(([pid, last]) => ({ playerId: pid, playerName: findPlayer(pid)?.name, lastAssessedAt: last, note: `last assessed over ${STALE_DAYS} days ago` }))
      .filter((x) => { const p = findPlayer(x.playerId); return p && orgCanSee(req.org, p); });
    res.json({ queue: items.filter((i) => !i.deferredUntil), deferred: items.filter((i) => i.deferredUntil), staleEvaluations: staleItems });
  });

  orgRouter.post('/review-queue/:playerId/later', (req, res) => {
    const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 60);
    db.reviewLater = db.reviewLater.filter((r) => !(r.orgId === req.org.id && r.playerId === req.params.playerId));
    db.reviewLater.push({ id: nextId('rvl'), orgId: req.org.id, playerId: req.params.playerId, byUserId: req.orgUser.id, dueAt: Date.now() + days * 86_400_000, remindedAt: null });
    persistNow();
    res.json({ deferredDays: days });
  });

  // Controlled discovery rotation: a deterministic weekly slice of currently
  // ELIGIBLE players this org has not assessed — visibility rules first,
  // rotation second, so an ineligible player can never enter through it.
  orgRouter.get('/discovery-rotation', (req, res) => {
    const week = Math.floor(dayKey() / 7);
    const assessedIds = new Set(db.assessments.filter((a) => a.orgId === req.org.id && a.state !== 'draft').map((a) => a.playerId));
    const pool = db.players.filter((p) => orgCanSee(req.org, p) && !assessedIds.has(p.id));
    const scored = pool.map((p) => ({
      p, r: crypto.createHash('sha256').update(`${p.id}:${req.org.id}:${week}`).digest()[0],
    })).sort((a, b) => a.r - b.r).slice(0, 6);
    res.json({
      week,
      items: scored.map(({ p }) => (playerViewForOrg ? playerViewForOrg(p, req.org) : { id: p.id, name: p.name, position: p.position })),
      note: 'A rotating slice of eligible players you have not assessed — same pool as search, different order each week. Rotation never includes anyone outside your standing visibility rules, and nothing can pay its way in.',
    });
  });

  // Limited player visibility: coarse counts only, no org identities.
  playerRouter.get('/exposure', (req, res) => {
    const since = windowStartDay();
    const mine = db.exposureEvents.filter((e) => e.playerId === req.player.id && e.day >= since);
    const orgCount = new Set(mine.map((e) => e.orgId)).size;
    const band = (n) => (n === 0 ? '0' : n <= 5 ? '1–5' : n <= 20 ? '6–20' : '20+');
    res.json({
      windowDays: EXPOSURE_WINDOW_DAYS,
      appearedInSearches: band(mine.filter((e) => e.kind === 'impression').length),
      profileViews: band(mine.filter((e) => e.kind === 'profile_view').length),
      clubs: band(orgCount),
      note: 'Coarse ranges over the last 90 days. Which club looked is not shown — interest becomes visible when a club actually contacts you through the proper channel.',
    });
  });

  function insightSweep() {
    let changed = 0;
    for (const r of db.reviewLater) {
      if (r.dueAt < Date.now() && !r.remindedAt) {
        r.remindedAt = Date.now();
        const p = findPlayer(r.playerId);
        notify({ kind: 'org_user', id: r.byUserId }, 'review_queue', `⏰ Review reminder: you deferred ${p?.name ?? 'a player'} — they are back in your review queue.`, r.playerId);
        changed++;
      }
    }
    if (changed) persistNow();
    return changed;
  }
  ctx.insightSweep = insightSweep;

  // ======================================================== F5 calibration
  orgRouter.post('/calibration', (req, res) => {
    if (!requireLead(req, res)) return;
    const tmpl = db.assessmentTemplates.find((t) => t.id === req.body?.templateId);
    if (!tmpl) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
    // Reference footage must be footage this org can legitimately see NOW.
    const mediaId = req.body?.mediaId ? String(req.body.mediaId) : null;
    if (mediaId) {
      const owner = db.players.find((p) => p.media.some((m) => m.id === mediaId));
      if (!owner || !orgCanSee(req.org, owner)) return res.status(403).json({ error: 'FOOTAGE_NOT_ACCESSIBLE', message: 'Calibration footage must be footage your organisation can legitimately access.' });
    }
    const participants = (Array.isArray(req.body?.participantUserIds) ? req.body.participantUserIds : [])
      .filter((uid) => db.users.some((u) => u.id === uid && u.orgId === req.org.id && !u.removedAt));
    if (participants.length < 2) return res.status(400).json({ error: 'PARTICIPANTS_REQUIRED', message: 'Calibration needs at least two participating scouts.' });
    const s = {
      id: nextId('cal'), orgId: req.org.id, title: String(req.body?.title ?? 'Calibration session').slice(0, 120),
      templateId: tmpl.id, templateVersion: tmpl.version, attributesSnapshot: tmpl.attributes, // rubric pinned — later template edits change nothing here
      mediaId, participants, submissions: [], notes: [],
      status: 'open', createdBy: req.orgUser.id, createdAt: Date.now(), closedAt: null,
    };
    db.calibrationSessions.push(s);
    for (const uid of participants) notify({ kind: 'org_user', id: uid }, 'calibration', `🎯 You were added to calibration “${s.title}”. Watch the reference footage and submit blind — you cannot see colleagues’ ratings until you do.`, s.id);
    persistNow();
    res.status(201).json({ session: { ...s, submissions: [] } });
  });

  function sessionView(s, req) {
    const mySubmitted = s.submissions.some((x) => x.userId === req.orgUser.id);
    const released = s.status === 'closed' || mySubmitted;
    const owner = s.mediaId ? db.players.find((p) => p.media.some((m) => m.id === s.mediaId)) : null;
    const footageAccessible = owner ? orgCanSee(req.org, owner) : false;
    return {
      ...s,
      mediaUrl: footageAccessible ? `/media/${s.mediaId}` : null,
      footageNote: s.mediaId && !footageAccessible ? 'Reference footage is no longer accessible to your organisation.' : null,
      // BLIND: until you submit (or a lead closes the session), you see only
      // who has submitted — never what.
      submissions: released ? s.submissions : s.submissions.map((x) => ({ userId: x.userId, userName: x.userName, submittedAt: x.submittedAt })),
      comparison: released ? comparisonFor(s) : null,
      blind: !released,
    };
  }

  function comparisonFor(s) {
    const rows = [];
    for (const attr of s.attributesSnapshot) {
      const vals = s.submissions
        .map((sub) => sub.ratings.find((r) => r.attrId === attr.id))
        .filter((r) => r && !r.notObserved)
        .map((r) => r.value);
      const notObserved = s.submissions.length - vals.length;
      rows.push({
        attrId: attr.id, label: attr.label, values: vals, notObserved,
        range: vals.length ? Math.max(...vals) - Math.min(...vals) : null,
        mean: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
        disagreement: vals.length >= 2 ? (Math.max(...vals) - Math.min(...vals) >= 2 ? 'high' : Math.max(...vals) - Math.min(...vals) === 1 ? 'moderate' : 'aligned') : 'insufficient',
      });
    }
    return {
      rows,
      sampleSize: s.submissions.length,
      confidenceNote: `Comparison of ${s.submissions.length} blind submissions on one reference clip — a conversation starter about the rubric, not a measure of who is “right”.`,
    };
  }

  orgRouter.get('/calibration', (req, res) => {
    const mine = db.calibrationSessions.filter((s) => s.orgId === req.org.id && (s.participants.includes(req.orgUser.id) || isLead(req.orgUser)));
    res.json({ items: mine.map((s) => ({ id: s.id, title: s.title, status: s.status, participants: s.participants.length, submitted: s.submissions.length, createdAt: s.createdAt })) });
  });

  orgRouter.get('/calibration/:id', (req, res) => {
    const s = db.calibrationSessions.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!s.participants.includes(req.orgUser.id) && !isLead(req.orgUser)) return res.status(403).json({ error: 'NOT_A_PARTICIPANT' });
    res.json({ session: sessionView(s, req) });
  });

  orgRouter.post('/calibration/:id/submit', (req, res) => {
    const s = db.calibrationSessions.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (s.status !== 'open') return res.status(409).json({ error: 'SESSION_CLOSED' });
    if (!s.participants.includes(req.orgUser.id)) return res.status(403).json({ error: 'NOT_A_PARTICIPANT' });
    if (s.submissions.some((x) => x.userId === req.orgUser.id)) return res.status(409).json({ error: 'ALREADY_SUBMITTED', message: 'Blind submissions are final — one per participant.' });
    const valid = new Set(s.attributesSnapshot.map((a) => a.id));
    const ratings = (Array.isArray(req.body?.ratings) ? req.body.ratings : [])
      .filter((r) => valid.has(r.attrId))
      .map((r) => (r.notObserved ? { attrId: r.attrId, notObserved: true } : { attrId: r.attrId, value: Math.min(Math.max(Number(r.value) || 1, 1), 5), notObserved: false }));
    if (!ratings.length) return res.status(400).json({ error: 'RATINGS_REQUIRED' });
    s.submissions.push({
      userId: req.orgUser.id, userName: req.orgUser.name, ratings,
      confidence: ['low', 'medium', 'high'].includes(req.body?.confidence) ? req.body.confidence : 'medium',
      submittedAt: Date.now(),
    });
    persistNow();
    res.status(201).json({ session: sessionView(s, req), note: 'Submitted — the comparison is now visible to you.' });
  });

  orgRouter.post('/calibration/:id/close', (req, res) => {
    if (!requireLead(req, res)) return;
    const s = db.calibrationSessions.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    s.status = 'closed';
    s.closedAt = Date.now();
    persistNow();
    res.json({ session: sessionView(s, req) });
  });

  orgRouter.post('/calibration/:id/notes', (req, res) => {
    const s = db.calibrationSessions.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!s.participants.includes(req.orgUser.id) && !isLead(req.orgUser)) return res.status(403).json({ error: 'NOT_A_PARTICIPANT' });
    if (s.status !== 'closed' && !s.submissions.some((x) => x.userId === req.orgUser.id)) return res.status(409).json({ error: 'SUBMIT_FIRST', message: 'Discussion notes open after your blind submission.' });
    s.notes.push({ at: Date.now(), byUserId: req.orgUser.id, byName: req.orgUser.name, text: String(req.body?.text ?? '').slice(0, 500) });
    persistNow();
    res.status(201).json({ notes: s.notes });
  });

  // Decision-quality review: earlier recommendations next to what happened
  // SINCE — with the causal disclaimer stated in the payload itself.
  orgRouter.get('/decision-review', (req, res) => {
    if (!requireLead(req, res)) return;
    const decided = db.assessments.filter((a) => a.orgId === req.org.id && a.state !== 'draft' && a.recommendation);
    const items = decided.slice(-50).map((a) => {
      const laterSigning = db.signings.find((s) => s.playerId === a.playerId && (s.ts ?? 0) > a.createdAt);
      const laterAssessments = db.assessments.filter((x) => x.playerId === a.playerId && x.orgId === req.org.id && x.createdAt > a.createdAt && x.state !== 'draft').length;
      return {
        assessmentId: a.id, playerName: a.playerName, scoutName: a.scoutName,
        recommendation: a.recommendation, at: a.createdAt,
        since: { signedSomewhere: !!laterSigning, furtherAssessments: laterAssessments },
      };
    });
    res.json({
      items,
      disclaimer: 'What happened after a recommendation reflects hundreds of factors. This view supports reflective review of evidence quality — it does not measure whether a scout “caused” an outcome, and it is never published or ranked.',
    });
  });

  // ================================================= F6 missing-evidence
  const RULES_VERSION = 1;
  const RULES = [
    {
      id: 'no_recent_footage', version: RULES_VERSION,
      action: 'Ask for a recent clip (through the proper channel).',
      evaluate(player) {
        const fresh = player.media.filter((m) => new Date(m.uploadedAt ?? 0).getTime() > Date.now() - STALE_DAYS * 86_400_000);
        if (player.media.length && fresh.length) return null;
        return {
          records: player.media.map((m) => m.id),
          explanation: player.media.length === 0
            ? 'No footage on the profile yet.'
            : `All ${player.media.length} clips are older than ${STALE_DAYS} days.`,
        };
      },
    },
    {
      id: 'single_match_sample', version: RULES_VERSION,
      action: 'Request footage from a second match before concluding anything.',
      evaluate(player) {
        if (player.media.length === 0) return null; // covered by no_recent_footage
        const sources = new Set(player.media.map((m) => m.verifiedClip ?? `unverified:${m.id}`));
        const verifiedSources = new Set(player.media.filter((m) => m.verifiedClip).map((m) => m.verifiedClip));
        if (player.media.length >= 2 && verifiedSources.size <= 1 && player.media.every((m) => m.verifiedClip)) {
          return { records: player.media.map((m) => m.id), explanation: 'Every clip is linked to the same verified fixture — one match is a thin sample.' };
        }
        if (player.media.length === 1) {
          return { records: [player.media[0].id], explanation: 'Only one clip available — a single viewing context.' };
        }
        return null;
      },
    },
    {
      id: 'attribute_never_observed', version: RULES_VERSION,
      action: 'Plan an observation that covers the unobserved attribute.',
      evaluate(player, org) {
        const subs = db.assessments.filter((a) => a.orgId === org.id && a.playerId === player.id && a.state !== 'draft');
        if (!subs.length) return null;
        const gaps = [];
        const attrs = subs[subs.length - 1].attributesSnapshot ?? [];
        for (const attr of attrs) {
          const observed = subs.some((a) => a.ratings.some((r) => r.attrId === attr.id && !r.notObserved));
          if (!observed) gaps.push(attr.label);
        }
        if (!gaps.length) return null;
        return { records: subs.map((a) => a.id), explanation: `No evidence yet of: ${gaps.join(', ')} — every submitted report marked ${gaps.length > 1 ? 'them' : 'it'} “not observed”.` };
      },
    },
    {
      id: 'assessment_disagreement', version: RULES_VERSION,
      action: 'A third independent observation would resolve the split.',
      evaluate(player, org) {
        const subs = db.assessments.filter((a) => a.orgId === org.id && a.playerId === player.id && a.state !== 'draft');
        if (subs.length < 2) return null;
        for (const attr of subs[0].attributesSnapshot ?? []) {
          const vals = subs.map((a) => a.ratings.find((r) => r.attrId === attr.id)).filter((r) => r && !r.notObserved).map((r) => r.value);
          if (vals.length >= 2 && Math.max(...vals) - Math.min(...vals) >= 2) {
            return { records: subs.map((a) => a.id), explanation: `Your scouts disagree on “${attr.label}” (ratings span ${Math.min(...vals)}–${Math.max(...vals)}).` };
          }
        }
        return null;
      },
    },
    {
      id: 'stale_assessment', version: RULES_VERSION,
      action: 'Schedule a re-observation — the picture is out of date.',
      evaluate(player, org) {
        const subs = db.assessments.filter((a) => a.orgId === org.id && a.playerId === player.id && a.state !== 'draft');
        if (!subs.length) return null;
        const latest = Math.max(...subs.map((a) => a.createdAt));
        if (latest > Date.now() - STALE_DAYS * 86_400_000) return null;
        return { records: subs.map((a) => a.id), explanation: `The most recent submitted assessment is over ${STALE_DAYS} days old.` };
      },
    },
    {
      id: 'uncorroborated_claims', version: RULES_VERSION,
      action: 'Ask a coach or run a club assessment to corroborate the claim.',
      evaluate(player) {
        const claims = db.evidence.filter((e) => e.playerId === player.id && !e.supersededBy);
        const selfOnly = claims.filter((e) => e.tier === 'self_reported');
        if (!claims.length || selfOnly.length < claims.length || !selfOnly.length) return null;
        return { records: selfOnly.map((e) => e.id), explanation: `All ${selfOnly.length} evidence-passport records are self-reported — nothing is coach-confirmed or club-assessed yet.` };
      },
    },
  ];

  function computeGaps(org, player) {
    const found = [];
    for (const rule of RULES) {
      const hit = rule.evaluate(player, org);
      if (hit) found.push({ ruleId: rule.id, ruleVersion: rule.version, action: rule.action, ...hit });
    }
    // Upsert against stored suggestions: open ones that no longer hit become
    // 'supplied' (the gap closed); new hits become 'suggested'.
    const open = db.evidenceSuggestions.filter((s) => s.orgId === org.id && s.playerId === player.id && ['suggested', 'requested'].includes(s.status));
    for (const s of open) {
      if (!found.some((f) => f.ruleId === s.ruleId)) {
        s.status = 'supplied';
        s.updatedAt = Date.now();
      }
    }
    for (const f of found) {
      const existing = open.find((s) => s.ruleId === f.ruleId);
      if (existing) {
        existing.records = f.records;
        existing.explanation = f.explanation;
        existing.updatedAt = Date.now();
      } else {
        db.evidenceSuggestions.push({
          id: nextId('gap'), orgId: org.id, playerId: player.id, playerName: player.name,
          ruleId: f.ruleId, ruleVersion: f.ruleVersion, records: f.records,
          explanation: f.explanation, action: f.action,
          status: 'suggested', requestedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
        });
      }
    }
    persist();
    return db.evidenceSuggestions.filter((s) => s.orgId === org.id && s.playerId === player.id);
  }

  orgRouter.get('/players/:id/evidence-gaps', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const suggestions = computeGaps(req.org, p);
    res.json({
      items: suggestions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      engine: { kind: 'deterministic rules', version: RULES_VERSION, rules: RULES.map((r) => r.id), note: 'Every suggestion cites its rule and the records behind it. No AI generation is involved.' },
    });
  });

  // The one path that turns a deterministic gap into a player-facing ask.
  // Extracted from the route so a Recruitment Room (M17) raises an evidence
  // request through exactly this code — same anti-pestering window, same
  // guardian routing, same whitelisted player-safe wording. Returns a result
  // object rather than writing a response, so both callers share the rules.
  function requestEvidenceGap({ org, suggestionId }) {
    const s = db.evidenceSuggestions.find((x) => x.id === suggestionId && x.orgId === org.id);
    if (!s) return { ok: false, status: 404, error: 'SUGGESTION_NOT_FOUND' };
    if (s.status !== 'suggested') return { ok: false, status: 409, error: 'NOT_OPEN', detail: { status: s.status } };
    const p = findPlayer(s.playerId);
    if (!p || !orgCanSee(org, p)) return { ok: false, status: 403, error: 'NOT_VISIBLE' };
    // Anti-pestering: one open request per player+rule; a fresh request within
    // 14 days of the last one is refused.
    const recent = db.evidenceSuggestions.find((x) => x.orgId === org.id && x.playerId === s.playerId && x.ruleId === s.ruleId && x.requestedAt && x.requestedAt > Date.now() - 14 * 86_400_000 && x.id !== s.id);
    if (recent) return { ok: false, status: 429, error: 'RECENTLY_REQUESTED', message: 'You asked for this within the last 14 days — give them time.' };
    s.status = 'requested';
    s.requestedAt = Date.now();
    s.updatedAt = Date.now();
    // PLAYER-VISIBLE text is built from the request action only — club-private
    // observations never travel in the explanation.
    const audience = !isAdult(p) && p.guardianId ? { kind: 'guardian', id: p.guardianId } : { kind: 'player', id: p.id };
    const who = audience.kind === 'guardian' ? `${p.name}'s profile` : 'your profile';
    notify(audience, 'evidence_request', `📎 ${org.name} would find ${who} easier to assess with more evidence: ${playerSafeText(s)} You choose what (and whether) to add.`, s.id);
    persistNow();
    return { ok: true, suggestion: s, routedTo: audience.kind };
  }
  ctx.requestEvidenceGap = requestEvidenceGap;
  ctx.computeEvidenceGaps = computeGaps;

  orgRouter.post('/evidence-gaps/:id/request', (req, res) => {
    const out = requestEvidenceGap({ org: req.org, suggestionId: req.params.id });
    if (!out.ok) return res.status(out.status).json({ error: out.error, ...(out.message ? { message: out.message } : {}), ...(out.detail ?? {}) });
    res.json({ suggestion: out.suggestion });
  });

  function playerSafeText(s) {
    // Whitelisted per rule — references the PLAYER's own records only.
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
    const s = db.evidenceSuggestions.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
    s.status = 'dismissed';
    s.updatedAt = Date.now();
    persistNow();
    res.json({ suggestion: s });
  });

  orgRouter.post('/evidence-gaps/:id/reviewed', (req, res) => {
    const s = db.evidenceSuggestions.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
    if (s.status !== 'supplied') return res.status(409).json({ error: 'NOT_SUPPLIED', message: 'Mark reviewed once the gap shows as supplied.' });
    s.status = 'reviewed';
    s.updatedAt = Date.now();
    persistNow();
    res.json({ suggestion: s });
  });
}
