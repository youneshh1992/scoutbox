// Drill guidance and development objectives (feedback → objectives → reassessment). Over-long objective, progress
// and outcome text is shortened rather than refused.
import { DEVELOPMENT_LIMITS as DL } from '../../repositories/development.mjs';
import { parseDate } from './hub/shared.mjs';

/** The same for every combine drill. */
export const DRILL_RECORDING = Object.freeze({
  equipment: 'Any phone camera ≥ 720p', distance: 'Full drill area in frame', surface: 'Flat grass or turf',
  camera: 'Fixed position, side-on, no zooming during the attempt',
});
const DEFAULT_REVIEWER = 'T&S football staff';

const itemView = (i) => ({ id: i.id, text: i.text, exerciseRefs: [...i.exerciseRefs], baselineEvidenceIds: [...i.baselineEvidenceIds] });
const reassessmentView = (r) => ({
  id: r.id, requestedBy: { kind: r.requestedBy.kind, id: r.requestedBy.id, name: r.requestedBy.name }, requestedAt: r.requestedAt, status: r.status,
  outcome: r.outcome ? { note: r.outcome.note, evidenceIds: [...r.outcome.evidenceIds], byUserId: r.outcome.byUserId, byName: r.outcome.byName, at: r.outcome.at } : null,
});
export const objectiveView = (o) => ({
  id: o.id, playerId: o.playerId, sourceFeedbackId: o.sourceFeedbackId, orgId: o.orgId,
  reviewer: { userId: o.reviewer.userId, name: o.reviewer.name, orgName: o.reviewer.orgName },
  objectives: o.objectives.map(itemView),
  progress: o.progress.map((g) => ({ id: g.id, at: g.at, objectiveId: g.objectiveId, note: g.note, evidenceId: g.evidenceId })),
  sharing: { orgIds: [...o.sharing.orgIds] },
  reassessments: o.reassessments.map(reassessmentView),
  reviewAt: o.reviewAt, status: o.status,
  createdBy: { kind: o.createdBy.kind, id: o.createdBy.id, name: o.createdBy.name }, createdAt: o.createdAt,
});

export function registerObjectives(ctx) {
  const {
    byId, scoutingReads, nextId, notify, findPlayer, unit, development, developmentReads,
    orgRouter, playerRouter, guardianRouter, adminRouter,
    orgCanSee, moderateOrRefuse, isAdult, guardianOwnsChild, recordActivity, DRILLS,
  } = ctx;
  if (typeof development?.objectives?.create !== 'function' || !developmentReads) throw new TypeError('registerObjectives needs the development repository from the data layer');
  const reads = developmentReads;
  const fieldInvalid = (res, field, message) => { res.status(400).json({ error: 'FIELD_INVALID', field, message }); return undefined; };
  const evidenceInvalid = (res, field) => { res.status(400).json({ error: 'EVIDENCE_INVALID', field, message: `${field} names evidence that is not this player's.` }); return undefined; };
  const isText = (v) => typeof v === 'string';
  /** A list of the player's own evidence ids (absent is none), or undefined after a 400. */
  const ownEvidence = (res, list, playerId, field) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > DL.evidenceIds || !list.every(isText)) return fieldInvalid(res, field, `${field} is a list of at most ${DL.evidenceIds} evidence ids.`);
    if (new Set(list).size !== list.length) return fieldInvalid(res, field, `${field} names an evidence item twice.`);
    const i = list.findIndex((id) => scoutingReads.evidence.byId(id)?.playerId !== playerId);
    if (i >= 0) return evidenceInvalid(res, `${field}[${i}]`);
    return [...list];
  };

  // A drill counts as reviewed only once a named reviewer reviewed it.
  const guidanceOf = (drillId, review) => ({
    drillId, recording: { ...DRILL_RECORDING },
    coachReview: review ? { status: 'reviewed', reviewer: review.reviewer, at: review.reviewedAt } : { status: 'unreviewed', reviewer: null, at: null },
  });
  const guidance = () => {
    const reviews = new Map(reads.drillReviews.all().map((r) => [r.drillId, r]));
    return DRILLS.map((d) => guidanceOf(d.id, reviews.get(d.id)));
  };

  playerRouter.get('/drill-guidance', (_req, res) => {
    res.json({ items: guidance(), note: 'Coach review status is shown honestly — "unreviewed" guidance has not been validated by a professional.' });
  });

  adminRouter.get('/drill-guidance', (_req, res) => res.json({ items: guidance() }));

  adminRouter.post('/drill-guidance/:drillId/review', (req, res) => {
    const drill = DRILLS.find((d) => d.id === req.params.drillId);
    if (!drill) return res.status(404).json({ error: 'DRILL_NOT_FOUND' });
    const raw = req.body?.reviewer;
    if (raw !== undefined && raw !== null && !isText(raw)) return fieldInvalid(res, 'reviewer', 'reviewer is the reviewer\'s name, as text.');
    const reviewer = (raw ?? '').trim().slice(0, DL.reviewer) || DEFAULT_REVIEWER;
    const review = development.drillReviews.record({ drillId: drill.id, reviewer, reviewedAt: Date.now() });
    res.json({ guidance: guidanceOf(drill.id, review) });
  });

  // ======================================================== objectives
  // Only published feedback can seed an objective, never a private assessment. Sharing progress back is the
  // player's (or guardian's) explicit choice.

  function createObjective(req, res, player, actor) {
    const { feedbackId, objectives } = req.body ?? {};
    const found = typeof feedbackId === 'string' ? scoutingReads.assessments.byId(feedbackId) : null;
    const a = found && found.playerId === player.id && found.publishedFeedback ? found : null;
    if (!a) return res.status(404).json({ error: 'PUBLISHED_FEEDBACK_NOT_FOUND', message: 'Objectives grow from feedback a club chose to publish — private assessments cannot seed them.' });
    if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > DL.objectiveItems) {
      return res.status(400).json({ error: 'ONE_OR_TWO_OBJECTIVES', message: 'One or two focused objectives — not a laundry list.' });
    }
    const items = [];
    for (const [i, o] of objectives.entries()) {
      const at = `objectives[${i}]`;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return fieldInvalid(res, at, 'an objective is an object { text, exerciseRefs, baselineEvidenceIds }.');
      if (!isText(o.text) || !o.text.trim()) return fieldInvalid(res, `${at}.text`, 'every objective says what to work on, as text.');
      const refs = o.exerciseRefs ?? [];
      if (!Array.isArray(refs) || refs.length > DL.exerciseRefs || !refs.every((r) => isText(r) && r.trim() && r.length <= DL.exerciseRef)) {
        return fieldInvalid(res, `${at}.exerciseRefs`, `exerciseRefs is a list of at most ${DL.exerciseRefs} exercise names of up to ${DL.exerciseRef} characters.`);
      }
      const evidence = ownEvidence(res, o.baselineEvidenceIds, player.id, `${at}.baselineEvidenceIds`);
      if (!evidence) return undefined;
      items.push({ text: o.text.trim().slice(0, DL.objectiveText), exerciseRefs: [...refs], baselineEvidenceIds: evidence });
    }
    const reviewAt = parseDate(req.body?.reviewAt, { field: 'reviewAt' });
    if (reviewAt.error) return res.status(400).json(reviewAt);
    const rec = unit(() => development.objectives.create({
      id: nextId('obj'), playerId: player.id, sourceFeedbackId: a.id, orgId: a.orgId,
      reviewer: { userId: a.publishedFeedback.byUserId, name: a.publishedFeedback.byName ?? null, orgName: byId.org(a.orgId)?.name ?? null },
      objectives: items.map((it) => ({ id: nextId('objx'), ...it })),
      progress: [], sharing: { orgIds: [] }, reassessments: [], reviewAt: reviewAt.value,
      status: 'active', createdBy: actor, createdAt: Date.now(),
    }));
    res.status(201).json({ objective: objectiveView(rec) });
  }

  playerRouter.post('/objectives', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian agrees development objectives with clubs.' });
    createObjective(req, res, req.player, { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/children/:id/objectives', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    createObjective(req, res, findPlayer(req.params.id), { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  playerRouter.get('/objectives', (req, res) => res.json(reads.objectives.forPlayer(req.player.id).map(objectiveView)));
  guardianRouter.get('/children/:id/objectives', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    res.json(reads.objectives.forPlayer(req.params.id).map(objectiveView));
  });

  /** The objective `id` if it belongs to one of these players, or null. */
  const objectiveOf = (id, playerIds) => { const o = reads.objectives.byId(id); return o && playerIds.includes(o.playerId) ? o : null; };

  // Minors may log progress themselves: it is football activity.
  playerRouter.post('/objectives/:id/progress', (req, res) => {
    const o = objectiveOf(req.params.id, [req.player.id]);
    if (!o) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
    const { note = null, evidenceId = null, objectiveId = null } = req.body ?? {};
    if (note !== null && !isText(note)) return fieldInvalid(res, 'note', 'note is text.');
    if (evidenceId !== null && (!isText(evidenceId) || scoutingReads.evidence.byId(evidenceId)?.playerId !== req.player.id)) return res.status(400).json({ error: 'EVIDENCE_INVALID' });
    if (objectiveId !== null && !o.objectives.some((x) => x.id === objectiveId)) return fieldInvalid(res, 'objectiveId', 'objectiveId names one of this objective\'s items.');
    const fresh = unit(() => {
      const next = development.objectives.update(o.id, (d) => {
        d.progress.push({ id: nextId('prg'), at: Date.now(), objectiveId, note: note && note.trim() ? note.slice(0, DL.progressNote) : null, evidenceId });
      });
      recordActivity(req.player);
      return next;
    });
    res.status(201).json({ objective: objectiveView(fresh) });
  });

  function setSharing(req, res, playerIds) {
    const o = objectiveOf(req.params.id, playerIds);
    if (!o) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
    const { orgId, enabled } = req.body ?? {};
    if (!isText(orgId) || !byId.org(orgId)) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (typeof enabled !== 'boolean') return fieldInvalid(res, 'enabled', 'enabled is true (share with this club) or false (stop sharing).');
    const fresh = unit(() => development.objectives.update(o.id, (d) => {
      if (enabled && !d.sharing.orgIds.includes(orgId)) d.sharing.orgIds.push(orgId);
      if (!enabled) d.sharing.orgIds = d.sharing.orgIds.filter((x) => x !== orgId);
    }));
    res.json({ objective: objectiveView(fresh) });
  }
  playerRouter.post('/objectives/:id/share', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Sharing progress with a club is a guardian decision for under-18s.' });
    setSharing(req, res, [req.player.id]);
  });
  guardianRouter.post('/objectives/:id/share', (req, res) => setSharing(req, res, req.guardian.childIds));

  function requestReassessment(req, res, playerIds, actor) {
    const o = objectiveOf(req.params.id, playerIds);
    if (!o) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
    if (!o.sharing.orgIds.includes(o.orgId)) return res.status(409).json({ error: 'SHARING_REQUIRED', message: 'Share progress with the club before asking them to look again.' });
    if (o.reassessments.some((r) => r.status === 'requested')) return res.status(409).json({ error: 'ALREADY_REQUESTED' });
    const r = { id: nextId('ras'), requestedBy: actor, requestedAt: Date.now(), status: 'requested', outcome: null };
    const p = findPlayer(o.playerId);
    unit(() => {
      development.objectives.update(o.id, (d) => { d.reassessments.push(r); });
      notify({ kind: 'org_user', id: o.reviewer.userId }, 'reassessment', `🔁 ${p?.name} (via ${actor.name}) requests a reassessment on: ${o.objectives.map((x) => x.text).join(' · ')}`, o.id);
    });
    res.status(201).json({ reassessment: reassessmentView(r) });
  }
  playerRouter.post('/objectives/:id/reassessment', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Re-engaging a club for you is your guardian’s call.' });
    requestReassessment(req, res, [req.player.id], { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.post('/objectives/:id/reassessment', (req, res) =>
    requestReassessment(req, res, req.guardian.childIds, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }));

  // Club follow-up: sees only SHARED objectives; outcomes cite evidence.
  orgRouter.get('/players/:id/objectives', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    res.json(reads.objectives.sharedWith(p.id, req.org.id).map(objectiveView));
  });

  orgRouter.post('/reassessments/:id/outcome', (req, res) => {
    const o = reads.objectives.byReassessment(req.params.id);
    const r = o?.reassessments.find((x) => x.id === req.params.id);
    if (!r || o.orgId !== req.org.id) return res.status(404).json({ error: 'REASSESSMENT_NOT_FOUND' });
    if (!o.sharing.orgIds.includes(req.org.id)) return res.status(403).json({ error: 'SHARING_REVOKED' });
    if (r.status !== 'requested') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { note, evidenceIds } = req.body ?? {};
    if (note !== undefined && note !== null && !isText(note)) return fieldInvalid(res, 'note', 'note is text.');
    if (!note || !note.trim()) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Reassessment outcomes point at evidence, not vibes.' });
    const evidence = ownEvidence(res, evidenceIds, o.playerId, 'evidenceIds');
    if (!evidence) return undefined;
    if (!moderateOrRefuse(res, note, { kind: 'reassessment_outcome', playerId: o.playerId, orgId: req.org.id })) return undefined;
    const outcome = { note: note.slice(0, DL.outcomeNote), evidenceIds: evidence, byUserId: req.orgUser.id, byName: req.orgUser.name ?? null, at: Date.now() };
    const p = findPlayer(o.playerId);
    const text = `📝 ${req.org.name} completed the reassessment: ${outcome.note.slice(0, 120)}`;
    const fresh = unit(() => {
      const next = development.objectives.update(o.id, (d) => {
        const x = d.reassessments.find((y) => y.id === r.id);
        x.status = 'completed';
        x.outcome = outcome;
      });
      if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'reassessment', text, o.id);
      else if (p) notify({ kind: 'player', id: p.id }, 'reassessment', text, o.id);
      return next;
    });
    res.json({ reassessment: reassessmentView(fresh.reassessments.find((x) => x.id === r.id)) });
  });
}
