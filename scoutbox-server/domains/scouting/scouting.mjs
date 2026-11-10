// Assessments are private recruitment records; only the publish-feedback route makes anything player- or
// guardian-visible.

import { roomRole, roomCan, CASE_PRIORITIES, CASE_DECISION_OUTCOMES } from '../recruitment/rooms/shared.mjs';

const CONFIDENCE = ['low', 'medium', 'high'];
const PRO_STAGES = ['identified', 'review', 'observation', 'trial', 'decision', 'closed'];
const GRASSROOTS_STAGES = ['review', 'invited', 'awaiting_response', 'decision', 'closed'];

import { readPage, sendPageError, pageOf } from '../platform/paging.mjs';
import { CRITERIA_KEYS, CLUB_SETUP_LIMITS, typeTacticalSetup } from '../../repositories/clubSetup.mjs';
import { parseStrictDateOnly } from '../../temporal.mjs';
import { bornByForAge } from '../../repositories/identity.mjs';
import { POSITION_GROUPS, ANCHOR_LEVELS, VERDICTS, VIEWINGS, ASSESSMENT_LIMITS as A_LIMITS } from '../../repositories/scoutingAssessments.mjs';
import { textOrRefuse, storedName } from './passport.mjs';

const CONTEXT_FIELDS = Object.freeze(['fixture', 'date', 'minutesWatched', 'viewing', 'opponentLevel']);
const REF_FIELDS = Object.freeze(['segmentId', 'trialSessionId', 'boxSessionId', 't', 'label']);
const nonEmptyText = (v) => typeof v === 'string' && v.trim().length > 0;
export function registerScouting(ctx) {
  const {
    byId, players, scoutingReads, users, nextId, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter,
    orgCanSee, paginate, audit, auditEntry, isLead, requireLead, moderateOrRefuse, isAdult,
    playerViewForOrg, revokeOrgUserAccess, guardianOwnsChild,
    recruitmentCases, dueAtOrRefuse,
    scoutingAssessments, unit,
    clubSetup,
  } = ctx;
  if (typeof clubSetup?.tactical?.save !== 'function') throw new TypeError('registerScouting needs the club setup repository from the data layer');
  if (typeof scoutingAssessments?.assessments?.create !== 'function' || typeof unit !== 'function') throw new TypeError('registerScouting needs the scouting assessments repository and unit from the data layer');
  const { templates, assessments, segments, playlists } = scoutingAssessments;
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function' || typeof reads?.trials?.byId !== 'function') throw new TypeError('registerScouting needs recruitmentReads (signings, requests, trials) from the data layer');
  const caseOfOrg = (id, orgId) => { const k = reads.cases.byId(id); return k && k.orgId === orgId ? k : null; };
  const orgTrial = (id, orgId) => { const t = reads.trials.byId(id); return t && t.orgId === orgId ? t : null; };
  const { cases } = recruitmentCases;

  // ------------------------------------------------- templates
  // Anchors are descriptive (a 3 means the sentence, not a feeling). A lead publishes a new version; historical
  // assessments keep the version they used.
  const { templates: templateReads, assessments: assessmentReads, segments: segmentReads, playlists: playlistReads } = scoutingReads;
  const currentTemplateFor = (positionGroup) => templateReads.currentFor(positionGroup);
  const fieldInvalid = (res, field, message) => { res.status(400).json({ error: 'FIELD_INVALID', field, message }); return undefined; };

  orgRouter.get('/assessment-templates', (req, res) => {
    res.json({ templates: templateReads.all(), note: 'New versions never alter historical reports — every assessment snapshots its template at creation.' });
  });

  orgRouter.post('/assessment-templates', (req, res) => {
    if (!requireLead(req, res)) return;
    const { positionGroup, attributes } = req.body ?? {};
    if (!POSITION_GROUPS.includes(positionGroup)) return res.status(400).json({ error: 'POSITION_GROUP_INVALID' });
    if (!Array.isArray(attributes) || attributes.length < 2 || attributes.length > A_LIMITS.attributes || attributes.some((a) => !a || typeof a !== 'object' || !nonEmptyText(a.id) || !nonEmptyText(a.label))) {
      return res.status(400).json({ error: 'ATTRIBUTES_INVALID', message: `Two to ${A_LIMITS.attributes} attributes, each with id + label (+ descriptive anchors).` });
    }
    const attrs = [];
    for (const [i, a] of attributes.entries()) {
      const id = a.id.trim().slice(0, A_LIMITS.attrId);
      if (attrs.some((x) => x.id === id)) return res.status(400).json({ error: 'ATTRIBUTES_INVALID', message: 'Each attribute id appears once.' });
      const anchors = a.anchors ?? {};
      if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors) || Object.entries(anchors).some(([k, v]) => !ANCHOR_LEVELS.includes(k) || !nonEmptyText(v))) {
        return fieldInvalid(res, `attributes[${i}].anchors`, `Anchors map the levels ${ANCHOR_LEVELS.join(', ')} to a descriptive sentence.`);
      }
      attrs.push({ id, label: a.label.trim().slice(0, A_LIMITS.attrLabel), anchors: Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, v.slice(0, A_LIMITS.anchor)])) });
    }
    const prev = currentTemplateFor(positionGroup);
    const t = templates.create({
      id: `tpl-${positionGroup.toLowerCase()}`, positionGroup, version: (prev?.version ?? 0) + 1,
      createdAt: Date.now(), createdBy: storedName(req.orgUser.name), attributes: attrs,
    });
    res.status(201).json({ template: t });
  });

  // --------------------------------------------------------- assessments
  function assessmentAccessList(req, playerId) {
    // The blind rule: a scout sees other scouts' assessments of a player only after submitting their own. Leads see
    // everything; they commission the second opinion.
    const mine = assessmentReads.forOrgPlayer(req.org.id, playerId);
    if (isLead(req.orgUser)) return mine;
    const iSubmitted = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    return mine.filter((a) => a.scoutUserId === req.orgUser.id || (iSubmitted && a.state !== 'draft'));
  }
  const ownAssessment = (req) => { const a = assessmentReads.byId(req.params.id); return a && a.orgId === req.org.id ? a : null; };

  function assessmentView(a) {
    const { history, ...rest } = a;
    return rest;
  }

  /** Returns the checked fields, or writes the refusal and returns undefined. The trial fields are fixed at creation. */
  function contextFieldsOrRefuse(res, context) {
    if (context === undefined || context === null) return {};
    if (typeof context !== 'object' || Array.isArray(context)) { res.status(400).json({ error: 'CONTEXT_INVALID' }); return undefined; }
    const unknown = Object.keys(context).find((k) => !CONTEXT_FIELDS.includes(k) && k !== 'trialId' && k !== 'trialSessionId');
    if (unknown) return fieldInvalid(res, `context.${unknown}`, `An assessment's context holds ${[...CONTEXT_FIELDS, 'trialId', 'trialSessionId'].join(', ')}.`);
    const out = {};
    for (const [k, max] of [['fixture', A_LIMITS.fixture], ['opponentLevel', A_LIMITS.opponentLevel]]) {
      if (!(k in context)) continue;
      const v = textOrRefuse(res, context[k], `context.${k}`, max); if (v === undefined) return undefined; out[k] = v;
    }
    if ('date' in context) {
      if (context.date === null || context.date === '') out.date = null;
      else {
        const d = parseStrictDateOnly(context.date);
        if (!d.ok) { res.status(400).json({ error: 'DATE_INVALID', field: 'context.date', message: `date is a calendar day (YYYY-MM-DD) (${d.why}).`, expected: d.expected }); return undefined; }
        out.date = context.date;
      }
    }
    if ('minutesWatched' in context) {
      const m = context.minutesWatched;
      if (m === null) out.minutesWatched = null;
      else if (typeof m === 'number' && Number.isFinite(m) && Math.round(m) >= 1 && Math.round(m) <= A_LIMITS.minutesWatched) out.minutesWatched = Math.round(m);
      else return fieldInvalid(res, 'context.minutesWatched', `minutesWatched is a number of minutes from 1 to ${A_LIMITS.minutesWatched}.`);
    }
    if ('viewing' in context) {
      if (context.viewing !== null && !VIEWINGS.includes(context.viewing)) return fieldInvalid(res, 'context.viewing', `viewing is ${VIEWINGS.join(' or ')}.`);
      out.viewing = context.viewing;
    }
    return out;
  }

  /** Returns `{ trialId, trialSessionId }` (both null when absent), or writes the refusal and returns null. */
  function validateTrialContext(req, res, context, p) {
    const rawTrial = context && typeof context === 'object' ? context.trialId : undefined;
    const rawSession = context && typeof context === 'object' ? context.trialSessionId : undefined;
    if (rawTrial == null && rawSession == null) return { trialId: null, trialSessionId: null };
    if (rawTrial == null) { res.status(400).json({ error: 'TRIAL_CONTEXT_INVALID', message: 'A trial session belongs to a trial; give the trialId too.', field: 'trialId' }); return null; }
    if (typeof rawTrial !== 'string' || !rawTrial) { res.status(400).json({ error: 'TRIAL_CONTEXT_INVALID', field: 'trialId', expected: 'string' }); return null; }
    const t = orgTrial(rawTrial, req.org.id);
    if (!t || t.playerId !== p.id) { res.status(404).json({ error: 'TRIAL_NOT_FOUND' }); return null; }
    if (t.subjectRemovedAt) { res.status(409).json({ error: 'TRIAL_SUBJECT_REMOVED', message: 'This player removed their ScoutBox account; nothing new is written about a person who left.' }); return null; }
    const room = t.caseId ? caseOfOrg(t.caseId, req.org.id) : null;
    if (room) {
      const role = roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
      if (!roomCan(role, 'trial_assess')) { res.status(403).json({ error: 'TRIAL_NOT_PERMITTED', message: 'Assessing this trial needs a role in its Recruitment Room.' }); return null; }
    }
    let trialSessionId = null;
    if (rawSession != null) {
      if (typeof rawSession !== 'string' || !rawSession) { res.status(400).json({ error: 'TRIAL_CONTEXT_INVALID', field: 'trialSessionId', expected: 'string' }); return null; }
      if (!(t.schedule?.sessions ?? []).some((s) => s?.id === rawSession)) { res.status(404).json({ error: 'TRIAL_SESSION_NOT_FOUND' }); return null; }
      trialSessionId = rawSession;
    }
    return { trialId: t.id, trialSessionId };
  }

  orgRouter.get('/assessments', (req, res) => {
    let list;
    if (req.query.playerId) {
      list = assessmentAccessList(req, String(req.query.playerId));
    } else if (isLead(req.orgUser)) {
      list = assessmentReads.forOrg(req.org.id);
    } else {
      list = assessmentReads.forOrgScout(req.org.id, req.orgUser.id);
    }
    // Narrowing by trial goes through the same access list, so the blind rule holds.
    if (req.query.trialId != null) {
      const tid = String(req.query.trialId);
      const t = orgTrial(tid, req.org.id);
      if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      list = (req.query.playerId ? list : assessmentAccessList(req, t.playerId)).filter((a) => a.context?.trialId === tid);
    }
    res.json(paginate(req, list.slice().sort((a, b) => b.createdAt - a.createdAt).map(assessmentView)));
  });

  orgRouter.post('/assessments', (req, res) => {
    const { playerId, positionGroup, context, secondOpinionOf } = req.body ?? {};
    const p = findPlayer(playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const tmpl = currentTemplateFor(positionGroup ?? groupFor(p.position));
    if (!tmpl) return res.status(400).json({ error: 'NO_TEMPLATE' });
    if (secondOpinionOf !== undefined && secondOpinionOf !== null) {
      if (typeof secondOpinionOf !== 'string') return fieldInvalid(res, 'secondOpinionOf', 'secondOpinionOf is an assessment id.');
      const first = assessmentReads.byId(secondOpinionOf);
      if (!first || first.orgId !== req.org.id) return res.status(404).json({ error: 'FIRST_OPINION_NOT_FOUND' });
      if (first.scoutUserId === req.orgUser.id) return res.status(400).json({ error: 'NOT_INDEPENDENT', message: 'A second opinion comes from a different scout.' });
    }
    const fields = contextFieldsOrRefuse(res, context);
    if (fields === undefined) return;
    const trialCtx = validateTrialContext(req, res, context, p);
    if (!trialCtx) return;
    const draft = {
      id: nextId('ass'), orgId: req.org.id, playerId: p.id, playerName: storedName(p.name),
      scoutUserId: req.orgUser.id, scoutName: storedName(req.orgUser.name),
      templateId: tmpl.id, templateVersion: tmpl.version, // the report keeps the scale it was written against
      context: { fixture: null, date: null, minutesWatched: null, viewing: null, opponentLevel: null, ...fields, trialId: trialCtx.trialId, trialSessionId: trialCtx.trialSessionId },
      ratings: [], state: 'draft', recommendation: null,
      secondOpinionOf: secondOpinionOf ?? null,
      createdAt: Date.now(), submittedAt: null, reviewedAt: null, reviewNote: null,
      publishedFeedback: null, history: [],
    };
    audit(draft, 'org', req.orgUser.id, storedName(req.orgUser.name), 'created');
    const a = assessments.create(draft);
    res.status(201).json({ assessment: assessmentView(a) });
  });

  function evidenceRefOrRefuse(res, ref, at) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return fieldInvalid(res, at, 'An evidence reference is an object.');
    const unknown = Object.keys(ref).find((k) => !REF_FIELDS.includes(k));
    if (unknown) return fieldInvalid(res, `${at}.${unknown}`, `An evidence reference holds ${REF_FIELDS.join(', ')}.`);
    const out = {};
    for (const k of ['segmentId', 'trialSessionId', 'boxSessionId']) {
      if (ref[k] === undefined || ref[k] === null) continue;
      if (typeof ref[k] !== 'string' || !ref[k] || ref[k].length > A_LIMITS.ref) return fieldInvalid(res, `${at}.${k}`, `${k} is an id.`);
      out[k] = ref[k];
    }
    if (ref.t !== undefined && ref.t !== null) {
      if (!(typeof ref.t === 'number' && Number.isFinite(ref.t) && ref.t >= 0)) return fieldInvalid(res, `${at}.t`, 't is a number of seconds, 0 or more.');
      out.t = ref.t;
    }
    if (ref.label !== undefined && ref.label !== null) {
      const l = textOrRefuse(res, ref.label, `${at}.label`, A_LIMITS.refLabel); if (l === undefined) return undefined; if (l !== null) out.label = l;
    }
    return out;
  }

  orgRouter.put('/assessments/:id', (req, res) => {
    const a = ownAssessment(req);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id) return res.status(403).json({ error: 'NOT_YOUR_ASSESSMENT' });
    if (a.state !== 'draft') return res.status(409).json({ error: 'NOT_A_DRAFT', message: 'Submitted assessments are immutable; commission a second opinion or a new viewing instead.' });
    const { ratings, context, recommendation } = req.body ?? {};
    // Every field is checked before anything is written.
    let nextRatings;
    if (ratings !== undefined && ratings !== null) {
      if (!Array.isArray(ratings)) return fieldInvalid(res, 'ratings', 'ratings is a list.');
      nextRatings = [];
      for (const [i, r] of ratings.entries()) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) return fieldInvalid(res, `ratings[${i}]`, 'A rating is an object.');
        const attr = a.attributesSnapshot.find((x) => x.id === r.attrId);
        if (!attr) return res.status(400).json({ error: 'ATTR_UNKNOWN', attrId: r.attrId });
        if (nextRatings.some((x) => x.attrId === r.attrId)) return res.status(400).json({ error: 'ATTR_DUPLICATE', attrId: r.attrId, message: 'Each attribute is rated once.' });
        if (!r.notObserved && !(Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5)) return res.status(400).json({ error: 'RATING_INVALID', message: 'Each attribute is a whole number 1–5, or explicitly "not observed" — never a silent zero.' });
        if (r.confidence !== undefined && r.confidence !== null && !CONFIDENCE.includes(r.confidence)) return res.status(400).json({ error: 'CONFIDENCE_INVALID', allowed: CONFIDENCE });
        const note = textOrRefuse(res, r.note, `ratings[${i}].note`, A_LIMITS.ratingNote); if (note === undefined) return;
        if (r.evidenceRefs !== undefined && r.evidenceRefs !== null && !Array.isArray(r.evidenceRefs)) return fieldInvalid(res, `ratings[${i}].evidenceRefs`, 'evidenceRefs is a list.');
        const refs = [];
        for (const [j, raw] of (r.evidenceRefs ?? []).slice(0, A_LIMITS.refs).entries()) {
          const ref = evidenceRefOrRefuse(res, raw, `ratings[${i}].evidenceRefs[${j}]`); if (ref === undefined) return;
          if (ref.segmentId) {
            const s = segmentReads.byId(ref.segmentId);
            if (!s || s.orgId !== req.org.id || s.playerId !== a.playerId) return res.status(400).json({ error: 'SEGMENT_INVALID', segmentId: ref.segmentId });
          }
          // A rating may cite a trial session, or a Box Cam session linked (and not unlinked) to this assessment's
          // trial, by reference only.
          if (ref.trialSessionId !== undefined || ref.boxSessionId !== undefined) {
            const t = a.context?.trialId ? orgTrial(a.context.trialId, req.org.id) : null;
            if (!t) return res.status(400).json({ error: 'TRIAL_EVIDENCE_REF_INVALID', message: 'Trial evidence references need an assessment written in the context of a trial.' });
            const sessions = t.schedule?.sessions ?? [];
            if (ref.trialSessionId !== undefined && !sessions.some((s) => s?.id === ref.trialSessionId)) return res.status(400).json({ error: 'TRIAL_EVIDENCE_REF_INVALID', field: 'trialSessionId' });
            if (ref.boxSessionId !== undefined && !sessions.some((s) => (s?.evidence ?? []).some((e) => e?.kind === 'box_cam_session' && e.sessionId === ref.boxSessionId && !e.removedAt))) return res.status(400).json({ error: 'TRIAL_EVIDENCE_REF_INVALID', field: 'boxSessionId', message: 'Only a Box Cam session linked to this trial can be cited.' });
          }
          refs.push(ref);
        }
        nextRatings.push({ attrId: r.attrId, rating: r.notObserved ? null : r.rating, notObserved: !!r.notObserved, confidence: r.confidence ?? 'medium', note, evidenceRefs: refs });
      }
    }
    let nextContext;
    if (context) {
      if (typeof context !== 'object' || Array.isArray(context)) return res.status(400).json({ error: 'CONTEXT_INVALID' });
      const { trialId, trialSessionId } = context;
      if ((trialId !== undefined && trialId !== a.context?.trialId) || (trialSessionId !== undefined && trialSessionId !== a.context?.trialSessionId)) {
        return res.status(409).json({ error: 'TRIAL_CONTEXT_IMMUTABLE', message: 'The trial an assessment belongs to is set when it is created.' });
      }
      const fields = contextFieldsOrRefuse(res, context);
      if (fields === undefined) return;
      nextContext = { ...a.context, ...fields };
    }
    let nextRecommendation;
    if (recommendation) {
      if (!VERDICTS.includes(recommendation.verdict)) return res.status(400).json({ error: 'VERDICT_INVALID' });
      const reasons = textOrRefuse(res, recommendation.reasons, 'recommendation.reasons', A_LIMITS.reasons); if (reasons === undefined) return;
      nextRecommendation = { verdict: recommendation.verdict, reasons: reasons ?? '' };
    }
    const next = assessments.update(a.id, (d) => {
      if (nextRatings) d.ratings = nextRatings;
      if (nextContext) d.context = nextContext;
      if (nextRecommendation) d.recommendation = nextRecommendation;
    });
    res.json({ assessment: assessmentView(next) });
  });

  orgRouter.post('/assessments/:id/submit', (req, res) => {
    const a = ownAssessment(req);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id) return res.status(403).json({ error: 'NOT_YOUR_ASSESSMENT' });
    if (a.state !== 'draft') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (!a.ratings.length) return res.status(400).json({ error: 'RATINGS_REQUIRED' });
    if (!a.recommendation) return res.status(400).json({ error: 'RECOMMENDATION_REQUIRED', message: 'Every submitted assessment carries a final recommendation with reasons.' });
    const next = unit(() => {
      const done = assessments.update(a.id, (d) => { d.state = 'submitted'; d.submittedAt = Date.now(); audit(d, 'org', req.orgUser.id, storedName(req.orgUser.name), 'submitted'); });
      ledgerAppend({ type: 'assessment_submitted', playerId: a.playerId, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
      return done;
    });
    // An open Room re-reads on this: a colleague's submission changes the case's next action. Ids only; the subject
    // is not named on the stream.
    broadcast('assessment_submitted', { orgId: req.org.id, assessmentId: a.id });
    res.json({ assessment: assessmentView(next) });
  });

  orgRouter.post('/assessments/:id/review', (req, res) => {
    if (!requireLead(req, res)) return;
    const a = ownAssessment(req);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.state !== 'submitted') return res.status(409).json({ error: 'NOT_SUBMITTED' });
    const note = textOrRefuse(res, req.body?.note, 'note', A_LIMITS.reviewNote); if (note === undefined) return;
    const next = assessments.update(a.id, (d) => {
      d.state = 'reviewed';
      d.reviewedAt = Date.now();
      d.reviewNote = note;
      audit(d, 'org', req.orgUser.id, storedName(req.orgUser.name), 'reviewed');
    });
    res.json({ assessment: assessmentView(next) });
  });

  // "Not observed" never enters an average; observedCount is shown instead.
  orgRouter.get('/players/:id/assessment-compare', (req, res) => {
    const list = assessmentAccessList(req, req.params.id).filter((a) => a.state !== 'draft');
    if (!list.length) return res.json({ assessments: [], attributes: [], note: 'No submitted assessments you can see yet — the blind rule hides colleagues’ reports until your own is submitted.' });
    const sameScale = list.every((a) => a.templateId === list[0].templateId && a.templateVersion === list[0].templateVersion);
    const attrIds = [...new Set(list.flatMap((a) => a.attributesSnapshot.map((x) => x.id)))];
    const attributes = attrIds.map((attrId) => {
      const label = list.flatMap((a) => a.attributesSnapshot).find((x) => x.id === attrId)?.label ?? attrId;
      const cells = list.map((a) => {
        const r = a.ratings.find((x) => x.attrId === attrId);
        return { assessmentId: a.id, scoutName: a.scoutName, rating: r?.notObserved ? null : r?.rating ?? null, notObserved: r?.notObserved ?? true, confidence: r?.confidence ?? null, evidenceRefs: r?.evidenceRefs ?? [] };
      });
      const observed = cells.filter((c) => c.rating != null);
      return {
        attrId, label, cells, observedCount: observed.length,
        average: observed.length ? Math.round((observed.reduce((s, c) => s + c.rating, 0) / observed.length) * 10) / 10 : null,
      };
    });
    res.json({
      assessments: list.map((a) => ({ id: a.id, scoutName: a.scoutName, submittedAt: a.submittedAt, context: a.context, recommendation: a.recommendation, templateVersion: a.templateVersion, secondOpinionOf: a.secondOpinionOf })),
      attributes,
      sameScale,
      note: sameScale ? '"Not observed" is excluded from averages — observedCount says how many scouts actually saw each attribute.' : '⚠️ These assessments use different template versions — attribute scales are NOT directly comparable and no combined average is shown.',
      ...(sameScale ? {} : { attributes: attributes.map((x) => ({ ...x, average: null })) }),
    });
  });

  // The only route from private recruitment records to the player/guardian side.
  orgRouter.post('/assessments/:id/publish-feedback', (req, res) => {
    const a = ownAssessment(req);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id && !isLead(req.orgUser)) return res.status(403).json({ error: 'NOT_AUTHORISED' });
    if (a.state === 'draft') return res.status(409).json({ error: 'NOT_SUBMITTED', message: 'Submit the assessment before publishing feedback from it.' });
    if (a.publishedFeedback) return res.status(409).json({ error: 'ALREADY_PUBLISHED' });
    const raw = req.body?.text;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return fieldInvalid(res, 'text', 'text must be text.');
    const text = (raw ?? '').trim();
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (!moderateOrRefuse(res, text, { kind: 'published_feedback', playerId: a.playerId, orgId: req.org.id })) return;
    const p = findPlayer(a.playerId);
    const next = unit(() => {
      const done = assessments.update(a.id, (d) => {
        d.publishedFeedback = { text: text.slice(0, A_LIMITS.feedback), byUserId: req.orgUser.id, byName: storedName(req.orgUser.name), at: Date.now() };
        audit(d, 'org', req.orgUser.id, storedName(req.orgUser.name), 'published_feedback');
      });
      if (p && !isAdult(p) && p.guardianId) {
        notify({ kind: 'guardian', id: p.guardianId }, 'feedback', `${req.org.name} published development feedback for ${p.name}.`, a.id);
        notify({ kind: 'player', id: p.id }, 'feedback', `${req.org.name} shared development feedback with your parent/guardian.`, a.id);
      } else if (p) {
        notify({ kind: 'player', id: p.id }, 'feedback', `📋 ${req.org.name} published development feedback for you.`, a.id);
      }
      return done;
    });
    broadcast('feedback', { playerId: a.playerId });
    res.json({ published: next.publishedFeedback });
  });

  const feedbackViewFor = (playerId) => assessmentReads.withFeedbackForPlayer(playerId)
    .map((a) => ({ id: a.id, orgId: a.orgId, orgName: byId.org(a.orgId)?.name ?? 'Club', byName: a.publishedFeedback.byName, text: a.publishedFeedback.text, at: a.publishedFeedback.at }));

  playerRouter.get('/feedback', (req, res) => {
    if (req.playerIsMinor) {
      // The child sees that feedback exists; the content lives with the guardian.
      return res.json({ guardianManaged: true, count: feedbackViewFor(req.player.id).length, items: [] });
    }
    res.json({ guardianManaged: false, items: feedbackViewFor(req.player.id) });
  });

  guardianRouter.get('/children/:id/feedback', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    res.json({ items: feedbackViewFor(req.params.id) });
  });

  // ========================================================= video segments
  // Segments annotate the source media (no copied files) and are org-private: never public, never a channel to a
  // child.

  function mediaOwner(mediaId) {
    return byId.mediaOwner(mediaId);
  }
  const segmentView = (s) => ({ ...s, mediaUrl: `/media/${s.mediaId}` });

  orgRouter.post('/media/:id/segments', (req, res) => {
    const owner = mediaOwner(req.params.id);
    if (!owner) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    if (!orgCanSee(req.org, owner)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const { startS, endS, labels, eventType, note, drawing } = req.body ?? {};
    const isSeconds = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!isSeconds(startS) || !isSeconds(endS) || !(startS >= 0) || !(endS > startS) || endS - startS > A_LIMITS.segmentSeconds) return res.status(400).json({ error: 'TIMESTAMPS_INVALID', message: 'start ≥ 0, end > start, segment ≤ 10 minutes.' });
    if (labels !== undefined && labels !== null && (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string'))) return fieldInvalid(res, 'labels', 'labels is a list of short texts.');
    const ev = textOrRefuse(res, eventType, 'eventType', A_LIMITS.eventType); if (ev === undefined) return;
    const text = textOrRefuse(res, note, 'note', A_LIMITS.segmentNote); if (text === undefined) return;
    if (drawing !== undefined && drawing !== null && (typeof drawing !== 'object' || Array.isArray(drawing) || JSON.stringify(drawing).length > A_LIMITS.drawing)) return fieldInvalid(res, 'drawing', `drawing is an object of overlay shapes (at most ${A_LIMITS.drawing} characters).`);
    if (text && !moderateOrRefuse(res, text, { kind: 'segment_note', playerId: owner.id, orgId: req.org.id })) return;
    const seg = segments.create({
      id: nextId('seg'), mediaId: req.params.id, playerId: owner.id, orgId: req.org.id,
      createdBy: { userId: req.orgUser.id, name: storedName(req.orgUser.name) },
      startS, endS,
      labels: (labels ?? []).map((l) => l.trim().slice(0, A_LIMITS.label)).filter(Boolean).slice(0, A_LIMITS.labels),
      eventType: ev, note: text,
      drawing: drawing ?? null,
      createdAt: Date.now(),
    });
    res.status(201).json({ segment: segmentView(seg) });
  });

  orgRouter.get('/segments', (req, res) => {
    const playerId = req.query.playerId ? String(req.query.playerId) : null;
    const mediaId = req.query.mediaId ? String(req.query.mediaId) : null;
    // Live entitlement: segments on players no longer visible do not travel.
    const list = segmentReads.forOrg(req.org.id, { playerId, mediaId }).filter((s) => orgCanSee(req.org, findPlayer(s.playerId)));
    res.json(paginate(req, list.map(segmentView)));
  });

  orgRouter.get('/segments/:id', (req, res) => {
    const found = segmentReads.byId(req.params.id);
    const s = found && found.orgId === req.org.id ? found : null;
    if (!s) return res.status(404).json({ error: 'SEGMENT_NOT_FOUND' });
    const owner = findPlayer(s.playerId);
    if (!orgCanSee(req.org, owner)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const media = owner.media.find((m) => m.id === s.mediaId);
    res.json({ segment: segmentView(s), media: media ? { id: media.id, title: media.title, kind: media.kind, verifiedClip: media.verifiedClip, captions: media.captions ? true : false } : null });
  });

  orgRouter.post('/playlists', (req, res) => {
    const raw = req.body?.name;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return fieldInvalid(res, 'name', 'name must be text.');
    const name = (raw ?? '').trim();
    if (!name) return res.status(400).json({ error: 'NAME_REQUIRED' });
    const pl = playlists.create({ id: nextId('pls'), orgId: req.org.id, name: name.slice(0, A_LIMITS.playlistName), createdBy: { userId: req.orgUser.id, name: storedName(req.orgUser.name) }, segmentIds: [], createdAt: Date.now() });
    res.status(201).json({ playlist: pl });
  });

  orgRouter.post('/playlists/:id/segments', (req, res) => {
    const found = playlistReads.byId(req.params.id);
    const pl = found && found.orgId === req.org.id ? found : null;
    if (!pl) return res.status(404).json({ error: 'PLAYLIST_NOT_FOUND' });
    const segFound = typeof req.body?.segmentId === 'string' ? segmentReads.byId(req.body.segmentId) : null;
    const seg = segFound && segFound.orgId === req.org.id ? segFound : null;
    if (!seg) return res.status(404).json({ error: 'SEGMENT_NOT_FOUND' });
    const next = pl.segmentIds.includes(seg.id) ? pl : playlists.update(pl.id, (d) => { d.segmentIds.push(seg.id); });
    res.json({ playlist: next });
  });

  orgRouter.get('/playlists', (req, res) => {
    res.json(playlistReads.forOrg(req.org.id));
  });

  // ===================================================== recruitment cases
  // Cases link to requests, trials and signings; they never copy them.

  const stagesFor = (org) => (org.level === 'grassroots' ? GRASSROOTS_STAGES : PRO_STAGES);

  function caseAccess(req, c) {
    if (!c.restricted) return true;
    return c.ownerUserId === req.orgUser.id || c.assignments.some((a) => a.userId === req.orgUser.id) || isLead(req.orgUser);
  }
  function caseView(c) { return c; } // history is included: it is append-only
  const byStaff = (req, action, detail = null) => ({ history: [auditEntry('org', req.orgUser.id, req.orgUser.name, action, detail)] });

  orgRouter.get('/cases', (req, res) => {
    // The access rule and the stage filter run in SQL. The apps read only the first page; "load more" awaits a
    // product decision.
    let page;
    try { page = readPage(req.query, ['number', 'string']); } catch (e) { return sendPageError(res, e); }
    const stage = req.query.stage === undefined || req.query.stage === '' ? null : req.query.stage;
    if (stage !== null && typeof stage !== 'string') return res.status(400).json({ error: 'STAGE_INVALID', message: 'stage is one stage name.' });
    const { items, nextCursor } = reads.cases.pageForViewer(req.org.id, { userId: req.orgUser.id, isLead: isLead(req.orgUser) }, { stage }, page);
    res.json({ items: items.map(caseView), nextCursor, stages: stagesFor(req.org) });
  });

  orgRouter.post('/cases', (req, res) => {
    const { playerId, vacancyId, priority, deadline, restricted } = req.body ?? {};
    const p = findPlayer(playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (vacancyId && !scoutingReads.vacancies.ofOrg(vacancyId, req.org.id)) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    const due = dueAtOrRefuse(res, deadline, 'deadline');
    if (due === undefined) return;
    const draft = {
      id: nextId('case'), orgId: req.org.id, playerId: p.id, playerName: p.name,
      vacancyId: vacancyId ?? null, ownerUserId: req.orgUser.id, ownerName: req.orgUser.name,
      stage: stagesFor(req.org)[0], priority: CASE_PRIORITIES.includes(priority) ? priority : 'medium',
      deadline: due, restricted: !!restricted,
      assignments: [], tasks: [], approvals: [], decision: null,
      links: { requestIds: [], trialIds: [], signingId: null },
      createdAt: Date.now(), history: [],
    };
    audit(draft, 'org', req.orgUser.id, req.orgUser.name, 'created', draft.stage);
    const c = cases.create(draft);
    res.status(201).json({ case: caseView(c) });
  });

  function findCase(req, res) {
    const c = caseOfOrg(req.params.id, req.org.id);
    if (!c) { res.status(404).json({ error: 'CASE_NOT_FOUND' }); return null; }
    if (!caseAccess(req, c)) { res.status(403).json({ error: 'CASE_RESTRICTED', message: 'This case is restricted to its owner, assignees and recruitment leads.' }); return null; }
    return c;
  }

  orgRouter.get('/cases/:id', (req, res) => {
    const c = findCase(req, res);
    if (c) res.json({ case: caseView(c) });
  });

  orgRouter.post('/cases/:id/assign', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    if (c.ownerUserId !== req.orgUser.id && !isLead(req.orgUser)) return res.status(403).json({ error: 'OWNER_OR_LEAD_REQUIRED' });
    const u = byId.user(req.body?.userId, (x) => x.orgId === req.org.id && !x.removedAt);
    if (!u) return res.status(404).json({ error: 'STAFF_NOT_FOUND' });
    const dueAt = dueAtOrRefuse(res, req.body?.dueAt);
    if (dueAt === undefined) return;
    const asg = { id: nextId('asg'), userId: u.id, name: u.name, task: String(req.body?.task ?? 'Scout this player').slice(0, 200), dueAt, status: 'open', createdAt: Date.now() };
    cases.addAssignment(c.id, { assignment: asg }, byStaff(req, 'assigned', `${u.name}: ${asg.task}`));
    notify({ kind: 'org_user', id: u.id }, 'case', `📌 ${req.orgUser.name} assigned you: ${asg.task} (${c.playerName}).`, c.id);
    res.status(201).json({ assignment: asg });
  });

  orgRouter.post('/cases/:id/tasks', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const assigneeRaw = req.body?.assigneeUserId ? String(req.body.assigneeUserId) : null;
    if (assigneeRaw && !byId.user(assigneeRaw, (u) => u.orgId === req.org.id && !u.removedAt)) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
    const dueAt = dueAtOrRefuse(res, req.body?.dueAt);
    if (dueAt === undefined) return;
    const t = { id: nextId('tsk'), title: String(req.body?.title ?? '').slice(0, 200), dueAt, assigneeUserId: assigneeRaw, status: 'open', createdAt: Date.now() };
    if (!t.title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    cases.addTask(c.id, { task: t });
    res.status(201).json({ task: t });
  });

  orgRouter.post('/cases/:id/tasks/:tid/complete', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    if (!c.tasks.some((x) => x.id === req.params.tid)) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    const fresh = cases.updateTask(c.id, { taskId: req.params.tid, status: 'done', completedAt: Date.now(), completedBy: req.orgUser.name });
    res.json({ task: fresh.tasks.find((x) => x.id === req.params.tid) });
  });

  orgRouter.post('/cases/:id/stage', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    // On a case with a Room the stage is derived from room.status, so it is not writable here: that would bypass the
    // lifecycle (transitions, evidence, history, rev). Mapping a stage back to a status is lossy (eighteen statuses
    // onto six stages) and could move a room backwards.
    if (c.room) {
      return res.status(409).json({
        error: 'STAGE_NOT_SETTABLE_ON_ROOM',
        message: 'This case has a Recruitment Room. Its stage is derived from the room status — move the case through a lifecycle action instead.',
        roomStatus: c.room.status,
        stage: c.stage,
        use: `POST /org/rooms/${c.id}/lifecycle`,
      });
    }
    const stages = stagesFor(req.org);
    const { stage, reason } = req.body ?? {};
    if (!stages.includes(stage)) return res.status(400).json({ error: 'STAGE_INVALID', allowed: stages });
    if (stage === 'closed' && !c.decision) return res.status(409).json({ error: 'DECISION_REQUIRED', message: 'Close a case through a recorded decision — no silent drops.' });
    const fresh = cases.setStage(c.id, { stage }, byStaff(req, 'stage', `${c.stage} → ${stage}${reason ? `: ${reason}` : ''}`));
    res.json({ case: caseView(fresh) });
  });

  // On Pro, a non-lead's sign decision needs lead approval; grassroots and other outcomes record directly.
  orgRouter.post('/cases/:id/decision', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const { outcome, reasons } = req.body ?? {};
    if (!CASE_DECISION_OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'OUTCOME_INVALID' });
    if (!reasons || !String(reasons).trim()) return res.status(400).json({ error: 'REASONS_REQUIRED', message: 'Decisions carry reasons — they outlive the people who made them.' });
    const needsApproval = req.org.level !== 'grassroots' && outcome === 'sign' && !isLead(req.orgUser);
    if (needsApproval) {
      const appr = { id: nextId('apr'), decision: { outcome, reasons: String(reasons).slice(0, 500) }, requestedBy: { userId: req.orgUser.id, name: req.orgUser.name }, status: 'pending', requestedAt: Date.now(), resolvedBy: null };
      cases.requestApproval(c.id, { approval: appr }, byStaff(req, 'approval_requested', outcome));
      return res.status(202).json({ approval: appr, note: 'A sign decision needs a recruitment lead’s approval.' });
    }
    const fresh = unit(() => {
      cases.recordDecision(c.id, { decision: { outcome, reasons: String(reasons).slice(0, 500), byUserId: req.orgUser.id, byName: req.orgUser.name, approvedBy: null, at: Date.now() } }, byStaff(req, 'decision', outcome));
      // On a Room the stage is derived from the lifecycle status, so only a plain case moves stage.
      return c.room ? cases.byId(c.id) : cases.setStage(c.id, { stage: 'decision' });
    });
    res.json({ case: caseView(fresh) });
  });

  orgRouter.post('/cases/:id/approvals/:aid', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    if (!requireLead(req, res)) return;
    const appr = c.approvals.find((x) => x.id === req.params.aid);
    if (!appr || appr.status !== 'pending') return res.status(404).json({ error: 'APPROVAL_NOT_FOUND' });
    const approve = !!req.body?.approve;
    const at = Date.now();
    const fresh = unit(() => {
      let after = cases.resolveApproval(c.id, { approvalId: appr.id, status: approve ? 'approved' : 'rejected', by: { userId: req.orgUser.id, name: req.orgUser.name, at } }, byStaff(req, approve ? 'approved' : 'rejected', appr.decision.outcome));
      if (approve) {
        after = cases.recordDecision(c.id, { decision: { ...appr.decision, byUserId: appr.requestedBy.userId, byName: appr.requestedBy.name, approvedBy: req.orgUser.name, at } });
        if (!c.room) after = cases.setStage(c.id, { stage: 'decision' }); // derived on a Room — see the decision route
      }
      return after;
    });
    notify({ kind: 'org_user', id: appr.requestedBy.userId }, 'case', `${approve ? '✅ approved' : '❌ rejected'}: your ${appr.decision.outcome} decision on ${c.playerName}.`, c.id);
    res.json({ case: caseView(fresh) });
  });

  orgRouter.post('/cases/:id/link', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const { requestId, trialId, signingId } = req.body ?? {};
    // Every reference is checked before anything is written.
    const request = requestId ? reads.requests.byId(requestId) : null;
    if (requestId && !(request && request.orgId === req.org.id && request.playerId === c.playerId)) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    const trial = trialId ? orgTrial(trialId, req.org.id) : null;
    if (trialId && !(trial && trial.playerId === c.playerId)) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
    const signing = signingId ? reads.signings.byId(signingId) : null;
    if (signingId && !(signing && signing.orgId === req.org.id && signing.playerId === c.playerId)) return res.status(404).json({ error: 'SIGNING_NOT_FOUND' });
    const fresh = cases.link(c.id, { requestId: requestId || undefined, trialId: trialId || undefined, signingId: signingId || undefined }, byStaff(req, 'linked', JSON.stringify({ requestId, trialId, signingId })));
    res.json({ case: caseView(fresh) });
  });

  // Removal revokes access at once, but the user row stays so decisions and history remain attributable.
  orgRouter.get('/staff', (req, res) => {
    res.json(users.forOrg(req.org.id).map((u) => ({ id: u.id, name: u.name, role: u.role, lead: isLead(u), removedAt: u.removedAt ?? null })));
  });

  orgRouter.post('/staff/:userId/remove', (req, res) => {
    if (!requireLead(req, res)) return;
    if (req.params.userId === req.orgUser.id) return res.status(400).json({ error: 'CANNOT_REMOVE_SELF' });
    const u = byId.user(req.params.userId, (x) => x.orgId === req.org.id);
    if (!u) return res.status(404).json({ error: 'STAFF_NOT_FOUND' });
    if (u.removedAt) return res.status(409).json({ error: 'ALREADY_REMOVED' });
    const removed = unit(() => {
      const out = users.remove(u.id, { at: Date.now(), by: req.orgUser.id });
      revokeOrgUserAccess(u.id);
      ledgerAppend({ type: 'staff_removed', orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
      return out;
    });
    res.json({ removed: { id: removed.id, name: removed.name, removedAt: removed.removedAt }, note: 'Sessions revoked, event streams silenced, media links dead on next fetch. History stays attributed to the named person.' });
  });

  // ============================================================ tactical fit
  // Rule-based matching: met / not met / unknown, each with its data source. Never a fabricated percentage,
  // potential rating, salary estimate or transfer value.

  const groups = { GK: ['GK'], DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'], MID: ['CDM', 'CM', 'CAM'], ATT: ['ST', 'CF', 'RW', 'LW'] };
  function groupFor(position) {
    return Object.keys(groups).find((g) => groups[g].includes(position)) ?? 'MID';
  }
  const SL = CLUB_SETUP_LIMITS;
  const isText = (v) => typeof v === 'string';
  const optionalText = (v) => v === undefined || v === null || isText(v);
  const tacticalView = (t) => (t ? { formation: t.formation, planningHorizon: t.planningHorizon, windows: t.windows, roles: t.roles, updatedAt: t.updatedAt, updatedBy: t.updatedBy } : null);
  const vacancyView = (v) => ({ id: v.id, orgId: v.orgId, roleId: v.roleId, roleName: v.roleName, window: v.window, notes: v.notes, status: v.status, createdBy: v.createdBy, createdAt: v.createdAt, closedAt: v.closedAt });
  const shadowView = (s) => ({ id: s.id, playerId: s.playerId, name: s.name, source: 'shadow', roleId: s.roleId, addedBy: s.addedBy, addedAt: s.addedAt });
  const squadRowView = (s) => ({ id: s.id, playerId: s.playerId, name: s.name, source: s.source, ...(s.approvedBy ? { approvedBy: s.approvedBy } : {}), addedAt: s.addedAt });
  /** The field a typing reason names (`<label>.<field> …`), for the 400 answer. */
  const fieldOf = (reason, label) => (reason.startsWith(`${label}.`) ? reason.slice(label.length + 1).split(' ')[0].replace(/\.$/, '') : 'body');

  orgRouter.get('/tactical', (req, res) => {
    res.json({ tactical: tacticalView(scoutingReads.tacticalSetups.forOrg(req.org.id)), criteriaKeys: CRITERIA_KEYS });
  });

  orgRouter.post('/tactical', (req, res) => {
    if (!requireLead(req, res)) return;
    const { formation, roles, windows, planningHorizon } = req.body ?? {};
    if (!formation || !Array.isArray(roles)) return res.status(400).json({ error: 'FORMATION_AND_ROLES_REQUIRED' });
    if (!isText(formation) || !formation.trim()) return fieldInvalid(res, 'formation', 'formation is text.');
    if (!optionalText(planningHorizon)) return fieldInvalid(res, 'planningHorizon', 'planningHorizon is text.');
    if (roles.length > SL.roles) return fieldInvalid(res, 'roles', `At most ${SL.roles} roles.`);
    if (!(windows === undefined || windows === null || Array.isArray(windows))) return fieldInvalid(res, 'windows', 'windows is a list.');
    if ((windows ?? []).length > SL.windows) return fieldInvalid(res, 'windows', `At most ${SL.windows} windows.`);
    // A role keeps its id across saves so its vacancies and shadow entries keep their role; a supplied id must be one
    // of this club's current roles.
    const current = new Set(clubSetup.tactical.roleIds(req.org.id));
    const shaped = [];
    for (const [i, r] of roles.entries()) {
      const at = `roles[${i}]`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) return fieldInvalid(res, at, 'Each role is an object.');
      if (r.id !== undefined && r.id !== null && !current.has(r.id)) return fieldInvalid(res, `${at}.id`, "A role id must be one of this club's current roles; leave it out for a new role.");
      if (!isText(r.name) || !r.name.trim()) return fieldInvalid(res, `${at}.name`, 'Each role has a name.');
      if (!optionalText(r.description)) return fieldInvalid(res, `${at}.description`, 'description is text.');
      shaped.push({
        ...r, id: r.id ?? nextId('role'), name: r.name.trim().slice(0, SL.roleName), description: (r.description ?? '').slice(0, SL.description),
        positionGroup: r.positionGroup ?? 'MID', category: r.category ?? 'mixed', required: r.required ?? [], preferred: r.preferred ?? [],
      });
    }
    const shapedWindows = (windows ?? []).map((w) => (w && typeof w === 'object' && !Array.isArray(w) ? { ...w, name: isText(w.name) ? w.name.slice(0, SL.windowName) : (w.name ?? ''), opens: w.opens ?? null, closes: w.closes ?? null } : w));
    const label = 'tactical';
    const typed = typeTacticalSetup({
      orgId: req.org.id, formation: formation.trim().slice(0, SL.formation), planningHorizon: planningHorizon ? planningHorizon.slice(0, SL.planningHorizon) : null,
      windows: shapedWindows, roles: shaped, updatedAt: Date.now(), updatedBy: storedName(req.orgUser.name),
    }, label);
    if (!typed.ok) {
      const field = fieldOf(typed.reason.replace(`${label} ${req.org.id}`, label), label);
      return res.status(400).json({ error: /\.(opens|closes)$/.test(field) ? 'DATE_INVALID' : 'FIELD_INVALID', field, message: typed.reason.replace(`${label} ${req.org.id}.`, '') });
    }
    const tactical = clubSetup.tactical.save(typed.record);
    res.json({ tactical: tacticalView(tactical) });
  });

  orgRouter.post('/vacancies', (req, res) => {
    const { roleId, notes, window } = req.body ?? {};
    const role = isText(roleId) ? scoutingReads.tacticalSetups.roleOf(req.org.id, roleId) : null;
    if (!role) return res.status(404).json({ error: 'ROLE_NOT_FOUND', message: 'Define the tactical role first.' });
    if (!optionalText(notes)) return fieldInvalid(res, 'notes', 'notes is text.');
    if (!optionalText(window)) return fieldInvalid(res, 'window', 'window is text (the name of a transfer window).');
    const v = clubSetup.vacancies.create({ id: nextId('vac'), orgId: req.org.id, roleId, roleName: role.name, window: window ? window.slice(0, SL.windowName) : null, notes: notes ? notes.slice(0, SL.notes) : null, status: 'open', createdBy: storedName(req.orgUser.name), createdAt: Date.now(), closedAt: null });
    res.status(201).json({ vacancy: vacancyView(v) });
  });

  // The club's vacancies grow without limit (they are closed, never deleted), so the list pages, newest first.
  orgRouter.get('/vacancies', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = pageOf(scoutingReads.vacancies.page(req.org.id, page).rows, page.limit, (r) => r.key);
    res.json({ items: items.map((r) => vacancyView(r.vacancy)), nextCursor });
  });

  orgRouter.post('/vacancies/:id/close', (req, res) => {
    const v = scoutingReads.vacancies.ofOrg(req.params.id, req.org.id);
    if (!v) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    if (v.status === 'closed') return res.json({ vacancy: vacancyView(v) }); // closing twice keeps the first close
    const closed = clubSetup.vacancies.update(v.id, (d) => { d.status = 'closed'; d.closedAt = Date.now(); });
    res.json({ vacancy: vacancyView(closed) });
  });

  /**
   * Each criterion's verdict in SQL, mirroring evaluateCriterion (which still gives the answer and its sources).
   * `at` is the clock for the age cutoffs.
   */
  const CRITERION_SQL = {
    positionGroup: (v) => ({ met: ['p.position IN (SELECT value FROM json_each(?))', [JSON.stringify(groups[v] ?? [])]] }),
    minAge: (v, at) => ({ met: ['p.birth_date <= ?', [bornByForAge(v, at)]] }),
    maxAge: (v, at) => ({ met: ['p.birth_date > ?', [bornByForAge(v + 1, at)]] }),
    foot: (v) => ({ unknown: ['p.foot IS NULL', []], met: ['p.foot = ?', [v]] }),
    availability: (v) => ({ unknown: ['p.availability IS NULL', []], met: ['p.availability = ?', [v]] }),
    maxLevel: (v) => ({ met: ["NOT (p.level = 'pro' AND ? <> 'pro')", [v]] }),
    minAppearances: (v) => ({ unknown: ['p.stats_appearances IS NULL', []], met: ['p.stats_appearances >= ?', [v]] }),
    category: (v) => ({ unknown: ['p.football_category IS NULL', []], met: ["(? = 'mixed' OR p.football_category = ?)", [v, v]] }),
  };
  /** `CASE … END` giving 'm' (met), 'u' (unknown) or 'n' (not met) for one criterion, with its arguments. */
  function verdictSql(c, at) {
    const f = CRITERION_SQL[c.key];
    if (!f) return ["'u'", []];
    const { met, unknown } = f(c.value, at);
    return unknown
      ? [`(CASE WHEN ${unknown[0]} THEN 'u' WHEN ${met[0]} THEN 'm' ELSE 'n' END)`, [...unknown[1], ...met[1]]]
      : [`(CASE WHEN ${met[0]} THEN 'm' ELSE 'n' END)`, met[1]];
  }
  function evaluateCriterion(c, p, view) {
    const src = (field) => `profile field: ${field}`;
    switch (c.key) {
      case 'positionGroup':
        return { verdict: (groups[c.value] ?? []).includes(p.position) ? 'met' : 'not_met', source: src('position') };
      case 'minAge': case 'maxAge': {
        if (view.age == null) return { verdict: 'unknown', source: 'age unavailable in this view' };
        const ok = c.key === 'minAge' ? view.age >= c.value : view.age <= c.value;
        return { verdict: ok ? 'met' : 'not_met', source: src('age') };
      }
      case 'foot':
        // A criterion's foot is the player vocabulary (left / right).
        if (!p.foot) return { verdict: 'unknown', source: 'foot not recorded' };
        return { verdict: p.foot === c.value ? 'met' : 'not_met', source: src('foot') };
      case 'availability':
        if (!p.availability) return { verdict: 'unknown', source: 'availability not set' };
        return { verdict: p.availability === c.value ? 'met' : 'not_met', source: src('availability') };
      case 'maxLevel':
        return { verdict: (p.level ?? 'amateur') === 'pro' && c.value !== 'pro' ? 'not_met' : 'met', source: src('level') };
      case 'minAppearances': {
        const apps = p.stats?.appearances;
        if (typeof apps !== 'number') return { verdict: 'unknown', source: 'no appearances statistic recorded' };
        const corroborated = scoutingReads.evidence.currentForPlayer(p.id).some((e) => e.claimType === 'statistic' && e.verification.status !== 'self_reported');
        return { verdict: apps >= c.value ? 'met' : 'not_met', source: corroborated ? 'statistic (has corroborated evidence records)' : 'self-reported statistic' };
      }
      case 'category':
        if (!p.footballCategory) return { verdict: 'unknown', source: 'football category not recorded' };
        return { verdict: c.value === 'mixed' || p.footballCategory === c.value ? 'met' : 'not_met', source: src('footballCategory') };
      default:
        return { verdict: 'unknown', source: 'unrecognised criterion' };
    }
  }

  orgRouter.get('/vacancies/:id/candidates', (req, res) => {
    const v = scoutingReads.vacancies.ofOrg(req.params.id, req.org.id);
    if (!v) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    const role = v.roleId ? scoutingReads.tacticalSetups.roleOf(req.org.id, v.roleId) : null;
    if (!role) return res.status(409).json({ error: 'ROLE_DELETED' });
    // `onSquad` is the squad only; a player the club already shadows is `shadowed`.
    const onSquad = new Set(scoutingReads.squad.playerIds(req.org.id));
    const shadowed = new Set(scoutingReads.shadow.forOrg(req.org.id).map((s) => s.playerId));
    let page;
    try { page = readPage(req.query, ['number', 'number', 'number']); } catch (e) { return sendPageError(res, e); }
    const at = Date.now();
    // Sorted by key, so the statement depends only on which criteria a role names (a bounded set of shapes); the
    // values are bound. The sums and the AND are the same in any order.
    const byKey = (list) => [...list].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const req_ = byKey(role.required).map((c) => verdictSql(c, at));
    const all_ = [...req_, ...byKey(role.preferred).map((c) => verdictSql(c, at))];
    const sum = (list, v) => (list.length ? [list.map(([sql]) => `(${sql} = '${v}')`).join(' + '), list.flatMap(([, a]) => a)] : ['0', []]);
    const [metSql, metArgs] = sum(req_, 'm'); const [unkSql, unkArgs] = sum(all_, 'u');
    const result = players.visiblePage(req.org, {}, {
      order: [[metSql, 'DESC', metArgs], [unkSql, 'ASC', unkArgs], ['p.rowid', 'ASC']],
      where: req_.map(([sql, args]) => ({ sql: `${sql} <> 'n'`, args })),
    }, page);
    const candidates = result.items
      .map((p) => ({ p, view: playerViewForOrg(p, req.org) }))
      .filter((x) => x.view) // same visibility rules as search
      .map(({ p, view }) => {
        const evaluate = (list) => list.map((c) => ({ ...c, ...evaluateCriterion(c, p, view) }));
        const required = evaluate(role.required);
        const preferred = evaluate(role.preferred);
        return {
          playerId: p.id, name: p.name, position: p.position, age: view.age,
          required, preferred,
          requiredMet: required.filter((c) => c.verdict === 'met').length,
          requiredTotal: required.length,
          unknowns: [...required, ...preferred].filter((c) => c.verdict === 'unknown').length,
          onSquad: onSquad.has(p.id),
          shadowed: shadowed.has(p.id),
          caseId: reads.cases.forOrgPlayer(req.org.id, p.id).find((c) => c.stage !== 'closed')?.id ?? null,
        };
      })
      .filter((c) => !c.required.some((r) => r.verdict === 'not_met'));
    res.json({
      vacancy: vacancyView(v), role,
      candidates,
      nextCursor: result.nextCursor,
      note: 'Rule-based comparison: criteria met / not met / unknown with the data source for each. Unknown stays unknown — no invented suitability scores, potential ratings or market values.',
    });
  });

  // The shadow list is its own table: a club considering a player is not that player's club, so nothing that
  // reads the squad (match days, release, the passport, the Trust score) sees a shadow entry.
  orgRouter.post('/squad/shadow', (req, res) => {
    const { playerId, roleId } = req.body ?? {};
    const p = findPlayer(playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (!(roleId === undefined || roleId === null) && !(isText(roleId) && scoutingReads.tacticalSetups.roleOf(req.org.id, roleId))) return res.status(404).json({ error: 'ROLE_NOT_FOUND', message: "roleId must be one of the club's tactical roles." });
    if (scoutingReads.shadow.has(req.org.id, p.id)) return res.status(409).json({ error: 'ALREADY_SHADOWED' });
    const entry = clubSetup.shadow.create({ id: nextId('shd'), orgId: req.org.id, playerId: p.id, name: storedName(p.name), roleId: roleId ?? null, addedBy: storedName(req.orgUser.name), addedAt: Date.now() });
    res.status(201).json({ entry: shadowView(entry) });
  });

  orgRouter.get('/squad-planner', (req, res) => {
    const enrich = (s, base) => {
      const p = findPlayer(s.playerId);
      return { ...base, position: p?.position ?? s.position ?? null, contractUntil: p?.contractUntil ?? null, level: p?.level ?? null, visible: p ? orgCanSee(req.org, p) : false };
    };
    const tactical = scoutingReads.tacticalSetups.forOrg(req.org.id);
    res.json({
      formation: tactical?.formation ?? null,
      roles: tactical?.roles ?? [],
      windows: tactical?.windows ?? [],
      current: scoutingReads.squad.forOrg(req.org.id).map((s) => enrich(s, squadRowView(s))),
      shadow: scoutingReads.shadow.forOrg(req.org.id).map((s) => enrich(s, shadowView(s))),
      vacancies: scoutingReads.vacancies.openForOrg(req.org.id).map(vacancyView),
    });
  });
}
