// Assessments are private recruitment records; only the publish-feedback route makes anything player- or
// guardian-visible.

import { roomRole, roomCan, CASE_PRIORITIES, CASE_DECISION_OUTCOMES } from '../recruitment/public.mjs';

const CONFIDENCE = ['low', 'medium', 'high'];
const PRO_STAGES = ['identified', 'review', 'observation', 'trial', 'decision', 'closed'];
const GRASSROOTS_STAGES = ['review', 'invited', 'awaiting_response', 'decision', 'closed'];

import * as v from 'valibot';
import { readPage, sendPageError, pageOf } from '../platform/paging.mjs';
import {
  CURSOR_PAGE,
  OFFSET_PAGE,
  OFFSET_PAGE_CODES,
  dayOrBlank,
  dueDate,
  flag,
  id,
  inputOrRefuse,
  oneOf,
  requiredText,
  text,
  wholeNumber,
} from '../platform/schemas.mjs';
import { CRITERIA_KEYS, CLUB_SETUP_LIMITS, typeTacticalSetup } from '../../repositories/clubSetup.mjs';
import { CASE_TEXT_LIMITS as CASE_TEXT } from '../../repositories/recruitmentCases.mjs';
import { bornByForAge } from '../../repositories/identity.mjs';
import {
  POSITION_GROUPS,
  ANCHOR_LEVELS,
  VERDICTS,
  VIEWINGS,
  ASSESSMENT_LIMITS as A_LIMITS,
} from '../../repositories/scoutingAssessments.mjs';
import { storedName } from './passport.mjs';

const SL = CLUB_SETUP_LIMITS;
const nonEmptyText = (x) => typeof x === 'string' && x.trim().length > 0;
const blankToNull = (x) => (typeof x === 'string' && !x.trim() ? null : x);
const refId = v.pipe(v.string(), v.minLength(1), v.maxLength(A_LIMITS.ref));

// A whole map checked at once, so a refusal names the map rather than one of its keys.
const Anchors = v.pipe(
  v.record(v.string(), v.unknown()),
  v.check(
    (a) =>
      !Array.isArray(a) &&
      Object.entries(a).every(([k, x]) => ANCHOR_LEVELS.includes(k) && nonEmptyText(x) && x.length <= A_LIMITS.anchor),
    `must map the levels ${ANCHOR_LEVELS.join(', ')} to a descriptive sentence of at most ${A_LIMITS.anchor} characters`,
  ),
);
const NewTemplate = v.strictObject({
  positionGroup: oneOf(POSITION_GROUPS),
  attributes: v.pipe(
    v.array(
      v.strictObject({
        id: requiredText(A_LIMITS.attrId),
        label: requiredText(A_LIMITS.attrLabel),
        anchors: v.nullish(Anchors),
      }),
    ),
    v.minLength(2),
    v.maxLength(A_LIMITS.attributes),
  ),
});
const TEMPLATE_CODES = {
  fieldCodes: {
    positionGroup: 'POSITION_GROUP_INVALID',
    attributes: 'ATTRIBUTES_INVALID',
    'attributes.id': 'ATTRIBUTES_INVALID',
    'attributes.label': 'ATTRIBUTES_INVALID',
  },
};

const Context = v.strictObject({
  fixture: v.nullish(text(A_LIMITS.fixture)),
  date: v.nullish(dayOrBlank),
  minutesWatched: v.nullish(wholeNumber({ min: 1, max: A_LIMITS.minutesWatched })),
  viewing: v.nullish(oneOf(VIEWINGS)),
  opponentLevel: v.nullish(text(A_LIMITS.opponentLevel)),
  trialId: v.nullish(id),
  trialSessionId: v.nullish(id),
});
const CONTEXT_CODES = {
  context: 'CONTEXT_INVALID',
  'context.trialId': 'TRIAL_CONTEXT_INVALID',
  'context.trialSessionId': 'TRIAL_CONTEXT_INVALID',
};
const NewAssessment = v.strictObject({
  playerId: id,
  positionGroup: v.nullish(oneOf(POSITION_GROUPS)),
  context: v.nullish(Context),
  secondOpinionOf: v.nullish(id),
});
const NEW_ASSESSMENT_CODES = { fieldCodes: { ...CONTEXT_CODES, positionGroup: 'NO_TEMPLATE' } };
const EvidenceRef = v.strictObject({
  segmentId: v.nullish(refId),
  trialSessionId: v.nullish(refId),
  boxSessionId: v.nullish(refId),
  t: v.nullish(v.pipe(v.number(), v.minValue(0))),
  label: v.nullish(text(A_LIMITS.refLabel)),
});
const Rating = v.strictObject({
  attrId: id,
  rating: v.nullish(wholeNumber({ min: 1, max: 5 })),
  notObserved: v.nullish(flag),
  confidence: v.nullish(oneOf(CONFIDENCE)),
  note: v.nullish(text(A_LIMITS.ratingNote)),
  evidenceRefs: v.nullish(v.pipe(v.array(EvidenceRef), v.maxLength(A_LIMITS.refs))),
});
const AssessmentEdit = v.strictObject({
  ratings: v.nullish(v.array(Rating)),
  context: v.nullish(Context),
  recommendation: v.nullish(v.strictObject({ verdict: oneOf(VERDICTS), reasons: v.nullish(text(A_LIMITS.reasons)) })),
});
const ASSESSMENT_EDIT_CODES = {
  fieldCodes: {
    ...CONTEXT_CODES,
    'ratings.attrId': 'ATTR_UNKNOWN',
    'ratings.rating': 'RATING_INVALID',
    'ratings.confidence': 'CONFIDENCE_INVALID',
    'recommendation.verdict': 'VERDICT_INVALID',
  },
};
const Review = v.strictObject({ note: v.nullish(text(A_LIMITS.reviewNote)) });
const Feedback = v.strictObject({ text: v.nullish(text(A_LIMITS.feedback)) });

const NewSegment = v.strictObject({
  startS: v.pipe(v.number(), v.minValue(0)),
  endS: v.number(),
  // Checked as one list, so the refusal names `labels`.
  labels: v.nullish(
    v.pipe(
      v.array(v.unknown()),
      v.check(
        (ls) => ls.length <= A_LIMITS.labels && ls.every((l) => typeof l === 'string' && l.length <= A_LIMITS.label),
        `must be a list of at most ${A_LIMITS.labels} short texts of at most ${A_LIMITS.label} characters`,
      ),
    ),
  ),
  eventType: v.nullish(text(A_LIMITS.eventType)),
  note: v.nullish(text(A_LIMITS.segmentNote)),
  drawing: v.nullish(
    v.pipe(
      v.record(v.string(), v.unknown()),
      v.check(
        (d) => !Array.isArray(d) && JSON.stringify(d).length <= A_LIMITS.drawing,
        `must be an object of overlay shapes of at most ${A_LIMITS.drawing} characters`,
      ),
    ),
  ),
});
const SEGMENT_CODES = { fieldCodes: { startS: 'TIMESTAMPS_INVALID', endS: 'TIMESTAMPS_INVALID' } };
const NewPlaylist = v.strictObject({ name: v.nullish(text(A_LIMITS.playlistName)) });
const PlaylistItem = v.strictObject({ segmentId: id });

const NewCase = v.strictObject({
  playerId: id,
  vacancyId: v.nullish(id),
  priority: v.nullish(oneOf(CASE_PRIORITIES)),
  deadline: v.optional(dueDate),
  restricted: v.nullish(flag),
});
const Assignment = v.strictObject({
  userId: id,
  task: v.nullish(text(CASE_TEXT.task)),
  dueAt: v.optional(dueDate),
});
const NewTask = v.strictObject({
  title: v.nullish(text(CASE_TEXT.title)),
  assigneeUserId: v.nullish(id),
  dueAt: v.optional(dueDate),
});
const stageChange = (stages) => v.strictObject({ stage: oneOf(stages), reason: v.nullish(text(CASE_TEXT.reasons)) });
const PRO_STAGE_CHANGE = stageChange(PRO_STAGES);
const GRASSROOTS_STAGE_CHANGE = stageChange(GRASSROOTS_STAGES);
const STAGE_CODES = { fieldCodes: { stage: 'STAGE_INVALID' } };
const caseListQuery = (stages) => v.strictObject({ ...CURSOR_PAGE, stage: v.optional(oneOf(stages)) });
const PageQuery = v.strictObject(CURSOR_PAGE);
const PRO_CASE_QUERY = caseListQuery(PRO_STAGES);
const GRASSROOTS_CASE_QUERY = caseListQuery(GRASSROOTS_STAGES);
const AssessmentQuery = v.strictObject({ playerId: v.optional(id), trialId: v.optional(id), ...OFFSET_PAGE });
const SegmentQuery = v.strictObject({ playerId: v.optional(id), mediaId: v.optional(id), ...OFFSET_PAGE });
const QUERY = { root: 'query', fieldCodes: OFFSET_PAGE_CODES };
const Decision = v.strictObject({
  outcome: oneOf(CASE_DECISION_OUTCOMES),
  reasons: requiredText(CASE_TEXT.reasons),
});
const DECISION_CODES = { fieldCodes: { outcome: 'OUTCOME_INVALID', reasons: 'REASONS_REQUIRED' } };
const ApprovalAnswer = v.strictObject({ approve: flag });
const CaseLinks = v.strictObject({
  requestId: v.nullish(id),
  trialId: v.nullish(id),
  signingId: v.nullish(id),
});

// A role's and a window's other fields are judged by the tactical setup's typing in the repository.
const Tactical = v.strictObject({
  formation: requiredText(SL.formation),
  planningHorizon: v.nullish(text(SL.planningHorizon)),
  roles: v.pipe(
    v.array(
      v.looseObject({
        id: v.nullish(id),
        name: requiredText(SL.roleName),
        description: v.nullish(text(SL.description)),
      }),
    ),
    v.maxLength(SL.roles),
  ),
  windows: v.nullish(v.pipe(v.array(v.looseObject({ name: v.nullish(text(SL.windowName)) })), v.maxLength(SL.windows))),
});
const NewVacancy = v.strictObject({
  roleId: id,
  notes: v.nullish(text(SL.notes)),
  window: v.nullish(text(SL.windowName)),
});
const NewShadow = v.strictObject({ playerId: id, roleId: v.nullish(id) });
export function registerScouting(ctx) {
  const {
    byId,
    players,
    scoutingReads,
    users,
    nextId,
    notify,
    ledgerAppend,
    broadcast,
    findPlayer,
    orgRouter,
    playerRouter,
    guardianRouter,
    orgCanSee,
    paginate,
    audit,
    auditEntry,
    isLead,
    requireLead,
    moderateOrRefuse,
    isAdult,
    playerViewForOrg,
    revokeOrgUserAccess,
    guardianOwnsChild,
    recruitmentCases,
    dueAtOrRefuse,
    scoutingAssessments,
    unit,
    clubSetup,
  } = ctx;
  if (typeof clubSetup?.tactical?.save !== 'function')
    throw new TypeError('registerScouting needs the club setup repository from the data layer');
  if (typeof scoutingAssessments?.assessments?.create !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerScouting needs the scouting assessments repository and unit from the data layer');
  const { templates, assessments, segments, playlists } = scoutingAssessments;
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function' || typeof reads?.trials?.byId !== 'function')
    throw new TypeError('registerScouting needs recruitmentReads (signings, requests, trials) from the data layer');
  const caseOfOrg = (id, orgId) => {
    const k = reads.cases.byId(id);
    return k && k.orgId === orgId ? k : null;
  };
  const orgTrial = (id, orgId) => {
    const t = reads.trials.byId(id);
    return t && t.orgId === orgId ? t : null;
  };
  const { cases } = recruitmentCases;

  // ------------------------------------------------- templates
  // Anchors are descriptive (a 3 means the sentence, not a feeling). A lead publishes a new version; historical
  // assessments keep the version they used.
  const {
    templates: templateReads,
    assessments: assessmentReads,
    segments: segmentReads,
    playlists: playlistReads,
  } = scoutingReads;
  const currentTemplateFor = (positionGroup) => templateReads.currentFor(positionGroup);
  const fieldInvalid = (res, field, message) => {
    res.status(400).json({ error: 'FIELD_INVALID', field, message });
    return undefined;
  };

  orgRouter.get('/assessment-templates', (req, res) => {
    res.json({
      templates: templateReads.all(),
      note: 'New versions never alter historical reports — every assessment snapshots its template at creation.',
    });
  });

  orgRouter.post('/assessment-templates', (req, res) => {
    if (!requireLead(req, res)) return;
    const body = inputOrRefuse(res, NewTemplate, req.body, TEMPLATE_CODES);
    if (!body) return;
    const { positionGroup } = body;
    const attrs = [];
    for (const a of body.attributes) {
      const attrId = a.id.trim();
      if (attrs.some((x) => x.id === attrId))
        return res.status(400).json({ error: 'ATTRIBUTES_INVALID', message: 'Each attribute id appears once.' });
      attrs.push({ id: attrId, label: a.label.trim(), anchors: { ...(a.anchors ?? {}) } });
    }
    const prev = currentTemplateFor(positionGroup);
    const t = templates.create({
      id: `tpl-${positionGroup.toLowerCase()}`,
      positionGroup,
      version: (prev?.version ?? 0) + 1,
      createdAt: Date.now(),
      createdBy: storedName(req.orgUser.name),
      attributes: attrs,
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
  const ownAssessment = (req) => {
    const a = assessmentReads.byId(req.params.id);
    return a && a.orgId === req.org.id ? a : null;
  };

  function assessmentView(a) {
    const { history, ...rest } = a;
    return rest;
  }

  /** The context fields the request names, blanks read as none. The trial fields are fixed at creation. */
  function contextFields(context) {
    const out = {};
    for (const k of ['fixture', 'opponentLevel', 'date']) if (k in (context ?? {})) out[k] = blankToNull(context[k]);
    for (const k of ['minutesWatched', 'viewing']) if (k in (context ?? {})) out[k] = context[k];
    return out;
  }

  /** Returns `{ trialId, trialSessionId }` (both null when absent), or writes the refusal and returns null. */
  function validateTrialContext(req, res, context, p) {
    const rawTrial = context?.trialId;
    const rawSession = context?.trialSessionId;
    if (rawTrial == null && rawSession == null) return { trialId: null, trialSessionId: null };
    if (rawTrial == null) {
      res.status(400).json({
        error: 'TRIAL_CONTEXT_INVALID',
        message: 'A trial session belongs to a trial; give the trialId too.',
        field: 'trialId',
      });
      return null;
    }
    const t = orgTrial(rawTrial, req.org.id);
    if (!t || t.playerId !== p.id) {
      res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      return null;
    }
    if (t.subjectRemovedAt) {
      res.status(409).json({
        error: 'TRIAL_SUBJECT_REMOVED',
        message: 'This player removed their ScoutBox account; nothing new is written about a person who left.',
      });
      return null;
    }
    const room = t.caseId ? caseOfOrg(t.caseId, req.org.id) : null;
    if (room) {
      const role = roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
      if (!roomCan(role, 'trial_assess')) {
        res.status(403).json({
          error: 'TRIAL_NOT_PERMITTED',
          message: 'Assessing this trial needs a role in its Recruitment Room.',
        });
        return null;
      }
    }
    let trialSessionId = null;
    if (rawSession != null) {
      if (!(t.schedule?.sessions ?? []).some((s) => s?.id === rawSession)) {
        res.status(404).json({ error: 'TRIAL_SESSION_NOT_FOUND' });
        return null;
      }
      trialSessionId = rawSession;
    }
    return { trialId: t.id, trialSessionId };
  }

  orgRouter.get('/assessments', (req, res) => {
    const query = inputOrRefuse(res, AssessmentQuery, req.query ?? {}, QUERY);
    if (!query) return;
    let list;
    if (query.playerId) {
      list = assessmentAccessList(req, query.playerId);
    } else if (isLead(req.orgUser)) {
      list = assessmentReads.forOrg(req.org.id);
    } else {
      list = assessmentReads.forOrgScout(req.org.id, req.orgUser.id);
    }
    // Narrowing by trial goes through the same access list, so the blind rule holds.
    if (query.trialId !== undefined) {
      const tid = query.trialId;
      const t = orgTrial(tid, req.org.id);
      if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      list = (query.playerId ? list : assessmentAccessList(req, t.playerId)).filter((a) => a.context?.trialId === tid);
    }
    res.json(
      paginate(
        query,
        list
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(assessmentView),
      ),
    );
  });

  orgRouter.post('/assessments', (req, res) => {
    const body = inputOrRefuse(res, NewAssessment, req.body, NEW_ASSESSMENT_CODES);
    if (!body) return;
    const { positionGroup, context, secondOpinionOf } = body;
    const p = findPlayer(body.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const tmpl = currentTemplateFor(positionGroup ?? groupFor(p.position));
    if (!tmpl) return res.status(400).json({ error: 'NO_TEMPLATE' });
    if (secondOpinionOf != null) {
      const first = assessmentReads.byId(secondOpinionOf);
      if (!first || first.orgId !== req.org.id) return res.status(404).json({ error: 'FIRST_OPINION_NOT_FOUND' });
      if (first.scoutUserId === req.orgUser.id)
        return res
          .status(400)
          .json({ error: 'NOT_INDEPENDENT', message: 'A second opinion comes from a different scout.' });
    }
    const fields = contextFields(context);
    const trialCtx = validateTrialContext(req, res, context, p);
    if (!trialCtx) return;
    const draft = {
      id: nextId('ass'),
      orgId: req.org.id,
      playerId: p.id,
      playerName: storedName(p.name),
      scoutUserId: req.orgUser.id,
      scoutName: storedName(req.orgUser.name),
      templateId: tmpl.id,
      templateVersion: tmpl.version, // the report keeps the scale it was written against
      context: {
        fixture: null,
        date: null,
        minutesWatched: null,
        viewing: null,
        opponentLevel: null,
        ...fields,
        trialId: trialCtx.trialId,
        trialSessionId: trialCtx.trialSessionId,
      },
      ratings: [],
      state: 'draft',
      recommendation: null,
      secondOpinionOf: secondOpinionOf ?? null,
      createdAt: Date.now(),
      submittedAt: null,
      reviewedAt: null,
      reviewNote: null,
      publishedFeedback: null,
      history: [],
    };
    audit(draft, 'org', req.orgUser.id, storedName(req.orgUser.name), 'created');
    const a = assessments.create(draft);
    res.status(201).json({ assessment: assessmentView(a) });
  });

  /** A stored evidence reference holds only the fields given. */
  function evidenceRef(ref) {
    const out = {};
    for (const k of ['segmentId', 'trialSessionId', 'boxSessionId', 't']) if (ref[k] != null) out[k] = ref[k];
    if (nonEmptyText(ref.label)) out.label = ref.label;
    return out;
  }

  orgRouter.put('/assessments/:id', (req, res) => {
    const a = ownAssessment(req);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id) return res.status(403).json({ error: 'NOT_YOUR_ASSESSMENT' });
    if (a.state !== 'draft')
      return res.status(409).json({
        error: 'NOT_A_DRAFT',
        message: 'Submitted assessments are immutable; commission a second opinion or a new viewing instead.',
      });
    const body = inputOrRefuse(res, AssessmentEdit, req.body, ASSESSMENT_EDIT_CODES);
    if (!body) return;
    const { ratings, context, recommendation } = body;
    // Every field is checked before anything is written.
    let nextRatings;
    if (ratings != null) {
      nextRatings = [];
      for (const r of ratings) {
        const attr = a.attributesSnapshot.find((x) => x.id === r.attrId);
        if (!attr) return res.status(400).json({ error: 'ATTR_UNKNOWN', attrId: r.attrId });
        if (nextRatings.some((x) => x.attrId === r.attrId))
          return res
            .status(400)
            .json({ error: 'ATTR_DUPLICATE', attrId: r.attrId, message: 'Each attribute is rated once.' });
        if (!r.notObserved && r.rating == null)
          return res.status(400).json({
            error: 'RATING_INVALID',
            message: 'Each attribute is a whole number 1–5, or explicitly "not observed" — never a silent zero.',
          });
        const refs = [];
        for (const raw of r.evidenceRefs ?? []) {
          const ref = evidenceRef(raw);
          if (ref.segmentId) {
            const s = segmentReads.byId(ref.segmentId);
            if (!s || s.orgId !== req.org.id || s.playerId !== a.playerId)
              return res.status(400).json({ error: 'SEGMENT_INVALID', segmentId: ref.segmentId });
          }
          // A rating may cite a trial session, or a Box Cam session linked (and not unlinked) to this assessment's
          // trial, by reference only.
          if (ref.trialSessionId !== undefined || ref.boxSessionId !== undefined) {
            const t = a.context?.trialId ? orgTrial(a.context.trialId, req.org.id) : null;
            if (!t)
              return res.status(400).json({
                error: 'TRIAL_EVIDENCE_REF_INVALID',
                message: 'Trial evidence references need an assessment written in the context of a trial.',
              });
            const sessions = t.schedule?.sessions ?? [];
            if (ref.trialSessionId !== undefined && !sessions.some((s) => s?.id === ref.trialSessionId))
              return res.status(400).json({ error: 'TRIAL_EVIDENCE_REF_INVALID', field: 'trialSessionId' });
            if (
              ref.boxSessionId !== undefined &&
              !sessions.some((s) =>
                (s?.evidence ?? []).some(
                  (e) => e?.kind === 'box_cam_session' && e.sessionId === ref.boxSessionId && !e.removedAt,
                ),
              )
            )
              return res.status(400).json({
                error: 'TRIAL_EVIDENCE_REF_INVALID',
                field: 'boxSessionId',
                message: 'Only a Box Cam session linked to this trial can be cited.',
              });
          }
          refs.push(ref);
        }
        nextRatings.push({
          attrId: r.attrId,
          rating: r.notObserved ? null : r.rating,
          notObserved: !!r.notObserved,
          confidence: r.confidence ?? 'medium',
          note: blankToNull(r.note ?? null),
          evidenceRefs: refs,
        });
      }
    }
    let nextContext;
    if (context) {
      const { trialId, trialSessionId } = context;
      if (
        (trialId !== undefined && trialId !== a.context?.trialId) ||
        (trialSessionId !== undefined && trialSessionId !== a.context?.trialSessionId)
      ) {
        return res.status(409).json({
          error: 'TRIAL_CONTEXT_IMMUTABLE',
          message: 'The trial an assessment belongs to is set when it is created.',
        });
      }
      nextContext = { ...a.context, ...contextFields(context) };
    }
    let nextRecommendation;
    if (recommendation) {
      nextRecommendation = {
        verdict: recommendation.verdict,
        reasons: blankToNull(recommendation.reasons ?? null) ?? '',
      };
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
    if (!a.recommendation)
      return res.status(400).json({
        error: 'RECOMMENDATION_REQUIRED',
        message: 'Every submitted assessment carries a final recommendation with reasons.',
      });
    const next = unit(() => {
      const done = assessments.update(a.id, (d) => {
        d.state = 'submitted';
        d.submittedAt = Date.now();
        audit(d, 'org', req.orgUser.id, storedName(req.orgUser.name), 'submitted');
      });
      ledgerAppend({
        type: 'assessment_submitted',
        playerId: a.playerId,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
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
    const body = inputOrRefuse(res, Review, req.body);
    if (!body) return;
    const note = blankToNull(body.note ?? null);
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
    if (!list.length)
      return res.json({
        assessments: [],
        attributes: [],
        note: 'No submitted assessments you can see yet — the blind rule hides colleagues’ reports until your own is submitted.',
      });
    const sameScale = list.every(
      (a) => a.templateId === list[0].templateId && a.templateVersion === list[0].templateVersion,
    );
    const attrIds = [...new Set(list.flatMap((a) => a.attributesSnapshot.map((x) => x.id)))];
    const attributes = attrIds.map((attrId) => {
      const label = list.flatMap((a) => a.attributesSnapshot).find((x) => x.id === attrId)?.label ?? attrId;
      const cells = list.map((a) => {
        const r = a.ratings.find((x) => x.attrId === attrId);
        return {
          assessmentId: a.id,
          scoutName: a.scoutName,
          rating: r?.notObserved ? null : (r?.rating ?? null),
          notObserved: r?.notObserved ?? true,
          confidence: r?.confidence ?? null,
          evidenceRefs: r?.evidenceRefs ?? [],
        };
      });
      const observed = cells.filter((c) => c.rating != null);
      return {
        attrId,
        label,
        cells,
        observedCount: observed.length,
        average: observed.length
          ? Math.round((observed.reduce((s, c) => s + c.rating, 0) / observed.length) * 10) / 10
          : null,
      };
    });
    res.json({
      assessments: list.map((a) => ({
        id: a.id,
        scoutName: a.scoutName,
        submittedAt: a.submittedAt,
        context: a.context,
        recommendation: a.recommendation,
        templateVersion: a.templateVersion,
        secondOpinionOf: a.secondOpinionOf,
      })),
      attributes,
      sameScale,
      note: sameScale
        ? '"Not observed" is excluded from averages — observedCount says how many scouts actually saw each attribute.'
        : '⚠️ These assessments use different template versions — attribute scales are NOT directly comparable and no combined average is shown.',
      ...(sameScale ? {} : { attributes: attributes.map((x) => ({ ...x, average: null })) }),
    });
  });

  // The only route from private recruitment records to the player/guardian side.
  orgRouter.post('/assessments/:id/publish-feedback', (req, res) => {
    const a = ownAssessment(req);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id && !isLead(req.orgUser))
      return res.status(403).json({ error: 'NOT_AUTHORISED' });
    if (a.state === 'draft')
      return res
        .status(409)
        .json({ error: 'NOT_SUBMITTED', message: 'Submit the assessment before publishing feedback from it.' });
    if (a.publishedFeedback) return res.status(409).json({ error: 'ALREADY_PUBLISHED' });
    const body = inputOrRefuse(res, Feedback, req.body);
    if (!body) return;
    const text = (body.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (!moderateOrRefuse(res, text, { kind: 'published_feedback', playerId: a.playerId, orgId: req.org.id })) return;
    const p = findPlayer(a.playerId);
    const next = unit(() => {
      const done = assessments.update(a.id, (d) => {
        d.publishedFeedback = {
          text,
          byUserId: req.orgUser.id,
          byName: storedName(req.orgUser.name),
          at: Date.now(),
        };
        audit(d, 'org', req.orgUser.id, storedName(req.orgUser.name), 'published_feedback');
      });
      if (p && !isAdult(p) && p.guardianId) {
        notify(
          { kind: 'guardian', id: p.guardianId },
          'feedback',
          `${req.org.name} published development feedback for ${p.name}.`,
          a.id,
        );
        notify(
          { kind: 'player', id: p.id },
          'feedback',
          `${req.org.name} shared development feedback with your parent/guardian.`,
          a.id,
        );
      } else if (p) {
        notify(
          { kind: 'player', id: p.id },
          'feedback',
          `📋 ${req.org.name} published development feedback for you.`,
          a.id,
        );
      }
      return done;
    });
    broadcast('feedback', { playerId: a.playerId });
    res.json({ published: next.publishedFeedback });
  });

  const feedbackViewFor = (playerId) =>
    assessmentReads.withFeedbackForPlayer(playerId).map((a) => ({
      id: a.id,
      orgId: a.orgId,
      orgName: byId.org(a.orgId)?.name ?? 'Club',
      byName: a.publishedFeedback.byName,
      text: a.publishedFeedback.text,
      at: a.publishedFeedback.at,
    }));

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
    const body = inputOrRefuse(res, NewSegment, req.body, SEGMENT_CODES);
    if (!body) return;
    const { startS, endS, labels, drawing } = body;
    if (!(endS > startS) || endS - startS > A_LIMITS.segmentSeconds)
      return res
        .status(400)
        .json({ error: 'TIMESTAMPS_INVALID', message: 'start ≥ 0, end > start, segment ≤ 10 minutes.' });
    const ev = blankToNull(body.eventType ?? null);
    const text = blankToNull(body.note ?? null);
    if (text && !moderateOrRefuse(res, text, { kind: 'segment_note', playerId: owner.id, orgId: req.org.id })) return;
    const seg = segments.create({
      id: nextId('seg'),
      mediaId: req.params.id,
      playerId: owner.id,
      orgId: req.org.id,
      createdBy: { userId: req.orgUser.id, name: storedName(req.orgUser.name) },
      startS,
      endS,
      labels: (labels ?? []).map((l) => l.trim()).filter(Boolean),
      eventType: ev,
      note: text,
      drawing: drawing ?? null,
      createdAt: Date.now(),
    });
    res.status(201).json({ segment: segmentView(seg) });
  });

  orgRouter.get('/segments', (req, res) => {
    const query = inputOrRefuse(res, SegmentQuery, req.query ?? {}, QUERY);
    if (!query) return;
    const playerId = query.playerId ?? null;
    const mediaId = query.mediaId ?? null;
    // Live entitlement: segments on players no longer visible do not travel.
    const list = segmentReads
      .forOrg(req.org.id, { playerId, mediaId })
      .filter((s) => orgCanSee(req.org, findPlayer(s.playerId)));
    res.json(paginate(query, list.map(segmentView)));
  });

  orgRouter.get('/segments/:id', (req, res) => {
    const found = segmentReads.byId(req.params.id);
    const s = found && found.orgId === req.org.id ? found : null;
    if (!s) return res.status(404).json({ error: 'SEGMENT_NOT_FOUND' });
    const owner = findPlayer(s.playerId);
    if (!orgCanSee(req.org, owner)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const media = owner.media.find((m) => m.id === s.mediaId);
    res.json({
      segment: segmentView(s),
      media: media
        ? {
            id: media.id,
            title: media.title,
            kind: media.kind,
            verifiedClip: media.verifiedClip,
            captions: media.captions ? true : false,
          }
        : null,
    });
  });

  orgRouter.post('/playlists', (req, res) => {
    const body = inputOrRefuse(res, NewPlaylist, req.body);
    if (!body) return;
    const name = (body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'NAME_REQUIRED' });
    const pl = playlists.create({
      id: nextId('pls'),
      orgId: req.org.id,
      name,
      createdBy: { userId: req.orgUser.id, name: storedName(req.orgUser.name) },
      segmentIds: [],
      createdAt: Date.now(),
    });
    res.status(201).json({ playlist: pl });
  });

  orgRouter.post('/playlists/:id/segments', (req, res) => {
    const found = playlistReads.byId(req.params.id);
    const pl = found && found.orgId === req.org.id ? found : null;
    if (!pl) return res.status(404).json({ error: 'PLAYLIST_NOT_FOUND' });
    const body = inputOrRefuse(res, PlaylistItem, req.body);
    if (!body) return;
    const segFound = segmentReads.byId(body.segmentId);
    const seg = segFound && segFound.orgId === req.org.id ? segFound : null;
    if (!seg) return res.status(404).json({ error: 'SEGMENT_NOT_FOUND' });
    const next = pl.segmentIds.includes(seg.id)
      ? pl
      : playlists.update(pl.id, (d) => {
          d.segmentIds.push(seg.id);
        });
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
    return (
      c.ownerUserId === req.orgUser.id || c.assignments.some((a) => a.userId === req.orgUser.id) || isLead(req.orgUser)
    );
  }
  function caseView(c) {
    return c;
  } // history is included: it is append-only
  const byStaff = (req, action, detail = null) => ({
    history: [auditEntry('org', req.orgUser.id, req.orgUser.name, action, detail)],
  });

  orgRouter.get('/cases', (req, res) => {
    // The access rule and the stage filter run in SQL. The apps read only the first page; "load more" awaits a
    // product decision.
    const query = inputOrRefuse(
      res,
      req.org.level === 'grassroots' ? GRASSROOTS_CASE_QUERY : PRO_CASE_QUERY,
      req.query ?? {},
      { root: 'query', ...STAGE_CODES },
    );
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const stage = query.stage ?? null;
    const { items, nextCursor } = reads.cases.pageForViewer(
      req.org.id,
      { userId: req.orgUser.id, isLead: isLead(req.orgUser) },
      { stage },
      page,
    );
    res.json({ items: items.map(caseView), nextCursor, stages: stagesFor(req.org) });
  });

  orgRouter.post('/cases', (req, res) => {
    const body = inputOrRefuse(res, NewCase, req.body);
    if (!body) return;
    const { vacancyId, priority, deadline, restricted } = body;
    const p = findPlayer(body.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (vacancyId && !scoutingReads.vacancies.ofOrg(vacancyId, req.org.id))
      return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    const due = dueAtOrRefuse(res, deadline, 'deadline');
    if (due === undefined) return;
    const draft = {
      id: nextId('case'),
      orgId: req.org.id,
      playerId: p.id,
      playerName: p.name,
      vacancyId: vacancyId ?? null,
      ownerUserId: req.orgUser.id,
      ownerName: req.orgUser.name,
      stage: stagesFor(req.org)[0],
      priority: priority ?? 'medium',
      deadline: due,
      restricted: !!restricted,
      assignments: [],
      tasks: [],
      approvals: [],
      decision: null,
      links: { requestIds: [], trialIds: [], signingId: null },
      createdAt: Date.now(),
      history: [],
    };
    audit(draft, 'org', req.orgUser.id, req.orgUser.name, 'created', draft.stage);
    const c = cases.create(draft);
    res.status(201).json({ case: caseView(c) });
  });

  function findCase(req, res) {
    const c = caseOfOrg(req.params.id, req.org.id);
    if (!c) {
      res.status(404).json({ error: 'CASE_NOT_FOUND' });
      return null;
    }
    if (!caseAccess(req, c)) {
      res.status(403).json({
        error: 'CASE_RESTRICTED',
        message: 'This case is restricted to its owner, assignees and recruitment leads.',
      });
      return null;
    }
    return c;
  }

  orgRouter.get('/cases/:id', (req, res) => {
    const c = findCase(req, res);
    if (c) res.json({ case: caseView(c) });
  });

  orgRouter.post('/cases/:id/assign', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    if (c.ownerUserId !== req.orgUser.id && !isLead(req.orgUser))
      return res.status(403).json({ error: 'OWNER_OR_LEAD_REQUIRED' });
    const body = inputOrRefuse(res, Assignment, req.body);
    if (!body) return;
    const u = byId.user(body.userId, (x) => x.orgId === req.org.id && !x.removedAt);
    if (!u) return res.status(404).json({ error: 'STAFF_NOT_FOUND' });
    const dueAt = dueAtOrRefuse(res, body.dueAt);
    if (dueAt === undefined) return;
    const asg = {
      id: nextId('asg'),
      userId: u.id,
      name: u.name,
      task: body.task?.trim() || 'Scout this player',
      dueAt,
      status: 'open',
      createdAt: Date.now(),
    };
    unit(() => {
      cases.addAssignment(c.id, { assignment: asg }, byStaff(req, 'assigned', `${u.name}: ${asg.task}`));
      notify(
        { kind: 'org_user', id: u.id },
        'case',
        `📌 ${req.orgUser.name} assigned you: ${asg.task} (${c.playerName}).`,
        c.id,
      );
    });
    res.status(201).json({ assignment: asg });
  });

  orgRouter.post('/cases/:id/tasks', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const body = inputOrRefuse(res, NewTask, req.body);
    if (!body) return;
    const assigneeRaw = body.assigneeUserId ?? null;
    if (assigneeRaw && !byId.user(assigneeRaw, (u) => u.orgId === req.org.id && !u.removedAt))
      return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
    const dueAt = dueAtOrRefuse(res, body.dueAt);
    if (dueAt === undefined) return;
    const t = {
      id: nextId('tsk'),
      title: (body.title ?? '').trim(),
      dueAt,
      assigneeUserId: assigneeRaw,
      status: 'open',
      createdAt: Date.now(),
    };
    if (!t.title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    cases.addTask(c.id, { task: t });
    res.status(201).json({ task: t });
  });

  orgRouter.post('/cases/:id/tasks/:tid/complete', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    if (!c.tasks.some((x) => x.id === req.params.tid)) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    const fresh = cases.updateTask(c.id, {
      taskId: req.params.tid,
      status: 'done',
      completedAt: Date.now(),
      completedBy: req.orgUser.name,
    });
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
        message:
          'This case has a Recruitment Room. Its stage is derived from the room status — move the case through a lifecycle action instead.',
        roomStatus: c.room.status,
        stage: c.stage,
        use: `POST /org/rooms/${c.id}/lifecycle`,
      });
    }
    const schema = req.org.level === 'grassroots' ? GRASSROOTS_STAGE_CHANGE : PRO_STAGE_CHANGE;
    const body = inputOrRefuse(res, schema, req.body, STAGE_CODES);
    if (!body) return;
    const { stage } = body;
    const reason = blankToNull(body.reason ?? null);
    if (stage === 'closed' && !c.decision)
      return res
        .status(409)
        .json({ error: 'DECISION_REQUIRED', message: 'Close a case through a recorded decision — no silent drops.' });
    const fresh = cases.setStage(
      c.id,
      { stage },
      byStaff(req, 'stage', `${c.stage} → ${stage}${reason ? `: ${reason}` : ''}`),
    );
    res.json({ case: caseView(fresh) });
  });

  // On Pro, a non-lead's sign decision needs lead approval; grassroots and other outcomes record directly.
  orgRouter.post('/cases/:id/decision', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const body = inputOrRefuse(res, Decision, req.body, DECISION_CODES);
    if (!body) return;
    const { outcome, reasons } = body;
    const needsApproval = req.org.level !== 'grassroots' && outcome === 'sign' && !isLead(req.orgUser);
    if (needsApproval) {
      const appr = {
        id: nextId('apr'),
        decision: { outcome, reasons },
        requestedBy: { userId: req.orgUser.id, name: req.orgUser.name },
        status: 'pending',
        requestedAt: Date.now(),
        resolvedBy: null,
      };
      cases.requestApproval(c.id, { approval: appr }, byStaff(req, 'approval_requested', outcome));
      return res.status(202).json({ approval: appr, note: 'A sign decision needs a recruitment lead’s approval.' });
    }
    const fresh = unit(() => {
      cases.recordDecision(
        c.id,
        {
          decision: {
            outcome,
            reasons,
            byUserId: req.orgUser.id,
            byName: req.orgUser.name,
            approvedBy: null,
            at: Date.now(),
          },
        },
        byStaff(req, 'decision', outcome),
      );
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
    const body = inputOrRefuse(res, ApprovalAnswer, req.body);
    if (!body) return;
    const { approve } = body;
    const at = Date.now();
    const fresh = unit(() => {
      let after = cases.resolveApproval(
        c.id,
        {
          approvalId: appr.id,
          status: approve ? 'approved' : 'rejected',
          by: { userId: req.orgUser.id, name: req.orgUser.name, at },
        },
        byStaff(req, approve ? 'approved' : 'rejected', appr.decision.outcome),
      );
      if (approve) {
        after = cases.recordDecision(c.id, {
          decision: {
            ...appr.decision,
            byUserId: appr.requestedBy.userId,
            byName: appr.requestedBy.name,
            approvedBy: req.orgUser.name,
            at,
          },
        });
        if (!c.room) after = cases.setStage(c.id, { stage: 'decision' }); // derived on a Room — see the decision route
      }
      notify(
        { kind: 'org_user', id: appr.requestedBy.userId },
        'case',
        `${approve ? '✅ approved' : '❌ rejected'}: your ${appr.decision.outcome} decision on ${c.playerName}.`,
        c.id,
      );
      return after;
    });
    res.json({ case: caseView(fresh) });
  });

  orgRouter.post('/cases/:id/link', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const body = inputOrRefuse(res, CaseLinks, req.body);
    if (!body) return;
    const { requestId, trialId, signingId } = body;
    // Every reference is checked before anything is written.
    const request = requestId ? reads.requests.byId(requestId) : null;
    if (requestId && !(request && request.orgId === req.org.id && request.playerId === c.playerId))
      return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    const trial = trialId ? orgTrial(trialId, req.org.id) : null;
    if (trialId && !(trial && trial.playerId === c.playerId)) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
    const signing = signingId ? reads.signings.byId(signingId) : null;
    if (signingId && !(signing && signing.orgId === req.org.id && signing.playerId === c.playerId))
      return res.status(404).json({ error: 'SIGNING_NOT_FOUND' });
    const fresh = cases.link(
      c.id,
      { requestId: requestId || undefined, trialId: trialId || undefined, signingId: signingId || undefined },
      byStaff(req, 'linked', JSON.stringify({ requestId, trialId, signingId })),
    );
    res.json({ case: caseView(fresh) });
  });

  // Removal revokes access at once, but the user row stays so decisions and history remain attributable.
  orgRouter.get('/staff', (req, res) => {
    res.json(
      users
        .forOrg(req.org.id)
        .map((u) => ({ id: u.id, name: u.name, role: u.role, lead: isLead(u), removedAt: u.removedAt ?? null })),
    );
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
      ledgerAppend({
        type: 'staff_removed',
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
      return out;
    });
    res.json({
      removed: { id: removed.id, name: removed.name, removedAt: removed.removedAt },
      note: 'Sessions revoked, event streams silenced, media links dead on next fetch. History stays attributed to the named person.',
    });
  });

  // ============================================================ tactical fit
  // Rule-based matching: met / not met / unknown, each with its data source. Never a fabricated percentage,
  // potential rating, salary estimate or transfer value.

  const groups = {
    GK: ['GK'],
    DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'],
    MID: ['CDM', 'CM', 'CAM'],
    ATT: ['ST', 'CF', 'RW', 'LW'],
  };
  function groupFor(position) {
    return Object.keys(groups).find((g) => groups[g].includes(position)) ?? 'MID';
  }
  const tacticalView = (t) =>
    t
      ? {
          formation: t.formation,
          planningHorizon: t.planningHorizon,
          windows: t.windows,
          roles: t.roles,
          updatedAt: t.updatedAt,
          updatedBy: t.updatedBy,
        }
      : null;
  const vacancyView = (v) => ({
    id: v.id,
    orgId: v.orgId,
    roleId: v.roleId,
    roleName: v.roleName,
    window: v.window,
    notes: v.notes,
    status: v.status,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    closedAt: v.closedAt,
  });
  const shadowView = (s) => ({
    id: s.id,
    playerId: s.playerId,
    name: s.name,
    source: 'shadow',
    roleId: s.roleId,
    addedBy: s.addedBy,
    addedAt: s.addedAt,
  });
  const squadRowView = (s) => ({
    id: s.id,
    playerId: s.playerId,
    name: s.name,
    source: s.source,
    ...(s.approvedBy ? { approvedBy: s.approvedBy } : {}),
    addedAt: s.addedAt,
  });
  /** The field a typing reason names (`<label>.<field> …`), for the 400 answer. */
  const fieldOf = (reason, label) =>
    reason.startsWith(`${label}.`)
      ? reason
          .slice(label.length + 1)
          .split(' ')[0]
          .replace(/\.$/, '')
      : 'body';

  orgRouter.get('/tactical', (req, res) => {
    res.json({ tactical: tacticalView(scoutingReads.tacticalSetups.forOrg(req.org.id)), criteriaKeys: CRITERIA_KEYS });
  });

  orgRouter.post('/tactical', (req, res) => {
    if (!requireLead(req, res)) return;
    const body = inputOrRefuse(res, Tactical, req.body);
    if (!body) return;
    const { formation, roles, windows, planningHorizon } = body;
    // A role keeps its id across saves so its vacancies and shadow entries keep their role; a supplied id must be one
    // of this club's current roles.
    const current = new Set(clubSetup.tactical.roleIds(req.org.id));
    const shaped = [];
    for (const [i, r] of roles.entries()) {
      if (r.id != null && !current.has(r.id))
        return fieldInvalid(
          res,
          `roles[${i}].id`,
          "A role id must be one of this club's current roles; leave it out for a new role.",
        );
      shaped.push({
        ...r,
        id: r.id ?? nextId('role'),
        name: r.name.trim(),
        description: r.description ?? '',
        positionGroup: r.positionGroup ?? 'MID',
        category: r.category ?? 'mixed',
        required: r.required ?? [],
        preferred: r.preferred ?? [],
      });
    }
    const shapedWindows = (windows ?? []).map((w) => ({
      ...w,
      name: w.name ?? '',
      opens: w.opens ?? null,
      closes: w.closes ?? null,
    }));
    const label = 'tactical';
    const typed = typeTacticalSetup(
      {
        orgId: req.org.id,
        formation: formation.trim(),
        planningHorizon: planningHorizon || null,
        windows: shapedWindows,
        roles: shaped,
        updatedAt: Date.now(),
        updatedBy: storedName(req.orgUser.name),
      },
      label,
    );
    if (!typed.ok) {
      const field = fieldOf(typed.reason.replace(`${label} ${req.org.id}`, label), label);
      return res.status(400).json({
        error: /\.(opens|closes)$/.test(field) ? 'DATE_INVALID' : 'FIELD_INVALID',
        field,
        message: typed.reason.replace(`${label} ${req.org.id}.`, ''),
      });
    }
    const tactical = clubSetup.tactical.save(typed.record);
    res.json({ tactical: tacticalView(tactical) });
  });

  orgRouter.post('/vacancies', (req, res) => {
    const body = inputOrRefuse(res, NewVacancy, req.body);
    if (!body) return;
    const { roleId, notes, window } = body;
    const role = scoutingReads.tacticalSetups.roleOf(req.org.id, roleId);
    if (!role) return res.status(404).json({ error: 'ROLE_NOT_FOUND', message: 'Define the tactical role first.' });
    const vacancy = clubSetup.vacancies.create({
      id: nextId('vac'),
      orgId: req.org.id,
      roleId,
      roleName: role.name,
      window: window || null,
      notes: notes || null,
      status: 'open',
      createdBy: storedName(req.orgUser.name),
      createdAt: Date.now(),
      closedAt: null,
    });
    res.status(201).json({ vacancy: vacancyView(vacancy) });
  });

  // The club's vacancies grow without limit (they are closed, never deleted), so the list pages, newest first.
  orgRouter.get('/vacancies', (req, res) => {
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = pageOf(scoutingReads.vacancies.page(req.org.id, page).rows, page.limit, (r) => r.key);
    res.json({ items: items.map((r) => vacancyView(r.vacancy)), nextCursor });
  });

  orgRouter.post('/vacancies/:id/close', (req, res) => {
    const v = scoutingReads.vacancies.ofOrg(req.params.id, req.org.id);
    if (!v) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    if (v.status === 'closed') return res.json({ vacancy: vacancyView(v) }); // closing twice keeps the first close
    const closed = clubSetup.vacancies.update(v.id, (d) => {
      d.status = 'closed';
      d.closedAt = Date.now();
    });
    res.json({ vacancy: vacancyView(closed) });
  });

  /**
   * Each criterion's verdict in SQL, mirroring evaluateCriterion (which still gives the answer and its sources).
   * `at` is the clock for the age cutoffs.
   */
  const CRITERION_SQL = {
    positionGroup: (v) => ({
      met: ['p.position IN (SELECT value FROM json_each(?))', [JSON.stringify(groups[v] ?? [])]],
    }),
    minAge: (v, at) => ({ met: ['p.birth_date <= ?', [bornByForAge(v, at)]] }),
    maxAge: (v, at) => ({ met: ['p.birth_date > ?', [bornByForAge(v + 1, at)]] }),
    foot: (v) => ({ unknown: ['p.foot IS NULL', []], met: ['p.foot = ?', [v]] }),
    availability: (v) => ({ unknown: ['p.availability IS NULL', []], met: ['p.availability = ?', [v]] }),
    maxLevel: (v) => ({ met: ["NOT (p.level = 'pro' AND ? <> 'pro')", [v]] }),
    minAppearances: (v) => ({ unknown: ['p.stats_appearances IS NULL', []], met: ['p.stats_appearances >= ?', [v]] }),
    category: (v) => ({
      unknown: ['p.football_category IS NULL', []],
      met: ["(? = 'mixed' OR p.football_category = ?)", [v, v]],
    }),
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
      case 'minAge':
      case 'maxAge': {
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
        return {
          verdict: (p.level ?? 'amateur') === 'pro' && c.value !== 'pro' ? 'not_met' : 'met',
          source: src('level'),
        };
      case 'minAppearances': {
        const apps = p.stats?.appearances;
        if (typeof apps !== 'number') return { verdict: 'unknown', source: 'no appearances statistic recorded' };
        const corroborated = scoutingReads.evidence
          .currentForPlayer(p.id)
          .some((e) => e.claimType === 'statistic' && e.verification.status !== 'self_reported');
        return {
          verdict: apps >= c.value ? 'met' : 'not_met',
          source: corroborated ? 'statistic (has corroborated evidence records)' : 'self-reported statistic',
        };
      }
      case 'category':
        if (!p.footballCategory) return { verdict: 'unknown', source: 'football category not recorded' };
        return {
          verdict: c.value === 'mixed' || p.footballCategory === c.value ? 'met' : 'not_met',
          source: src('footballCategory'),
        };
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
    const query = inputOrRefuse(res, PageQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'number', 'number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const at = Date.now();
    // Sorted by key, so the statement depends only on which criteria a role names (a bounded set of shapes); the
    // values are bound. The sums and the AND are the same in any order.
    const byKey = (list) => [...list].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const req_ = byKey(role.required).map((c) => verdictSql(c, at));
    const all_ = [...req_, ...byKey(role.preferred).map((c) => verdictSql(c, at))];
    const sum = (list, v) =>
      list.length ? [list.map(([sql]) => `(${sql} = '${v}')`).join(' + '), list.flatMap(([, a]) => a)] : ['0', []];
    const [metSql, metArgs] = sum(req_, 'm');
    const [unkSql, unkArgs] = sum(all_, 'u');
    const result = players.visiblePage(
      req.org,
      {},
      {
        order: [
          [metSql, 'DESC', metArgs],
          [unkSql, 'ASC', unkArgs],
          ['p.rowid', 'ASC'],
        ],
        where: req_.map(([sql, args]) => ({ sql: `${sql} <> 'n'`, args })),
      },
      page,
    );
    const candidates = result.items
      .map((p) => ({ p, view: playerViewForOrg(p, req.org) }))
      .filter((x) => x.view) // same visibility rules as search
      .map(({ p, view }) => {
        const evaluate = (list) => list.map((c) => ({ ...c, ...evaluateCriterion(c, p, view) }));
        const required = evaluate(role.required);
        const preferred = evaluate(role.preferred);
        return {
          playerId: p.id,
          name: p.name,
          position: p.position,
          age: view.age,
          required,
          preferred,
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
      vacancy: vacancyView(v),
      role,
      candidates,
      nextCursor: result.nextCursor,
      note: 'Rule-based comparison: criteria met / not met / unknown with the data source for each. Unknown stays unknown — no invented suitability scores, potential ratings or market values.',
    });
  });

  // The shadow list is its own table: a club considering a player is not that player's club, so nothing that
  // reads the squad (match days, release, the passport, the Trust score) sees a shadow entry.
  orgRouter.post('/squad/shadow', (req, res) => {
    const body = inputOrRefuse(res, NewShadow, req.body);
    if (!body) return;
    const { roleId } = body;
    const p = findPlayer(body.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (roleId != null && !scoutingReads.tacticalSetups.roleOf(req.org.id, roleId))
      return res
        .status(404)
        .json({ error: 'ROLE_NOT_FOUND', message: "roleId must be one of the club's tactical roles." });
    if (scoutingReads.shadow.has(req.org.id, p.id)) return res.status(409).json({ error: 'ALREADY_SHADOWED' });
    const entry = clubSetup.shadow.create({
      id: nextId('shd'),
      orgId: req.org.id,
      playerId: p.id,
      name: storedName(p.name),
      roleId: roleId ?? null,
      addedBy: storedName(req.orgUser.name),
      addedAt: Date.now(),
    });
    res.status(201).json({ entry: shadowView(entry) });
  });

  orgRouter.get('/squad-planner', (req, res) => {
    const enrich = (s, base) => {
      const p = findPlayer(s.playerId);
      return {
        ...base,
        position: p?.position ?? s.position ?? null,
        contractUntil: p?.contractUntil ?? null,
        level: p?.level ?? null,
        visible: p ? orgCanSee(req.org, p) : false,
      };
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
