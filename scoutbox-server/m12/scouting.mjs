// F2 — Structured scouting assessments · F7 — Evidence-focused video
// workspace · F3 — Recruitment department workspace · F4 — Tactical fit.
//
// Assessments are private recruitment records by default; only an explicit
// publish step creates player/guardian-visible feedback. Second opinions are
// blind SERVER-SIDE: another scout's report is not delivered to you until
// your own is submitted. "Not observed" is never averaged as zero.

const CONFIDENCE = ['low', 'medium', 'high'];
const PRO_STAGES = ['identified', 'review', 'observation', 'trial', 'decision', 'closed'];
const GRASSROOTS_STAGES = ['review', 'invited', 'awaiting_response', 'decision', 'closed'];

export function registerScouting(ctx) {
  const {
    db, nextId, persistNow, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter,
    orgCanSee, paginate, audit, isLead, requireLead, moderateOrRefuse, isAdult,
    playerViewForOrg, revokeOrgUserAccess, guardianOwnsChild,
  } = ctx;

  // ------------------------------------------------- template seeds (v1)
  // Position-specific templates with DESCRIPTIVE anchors — a 3 means the
  // sentence, not a feeling. Historical assessments snapshot their template.
  if (db.assessmentTemplates.length === 0) {
    const anchor = (a1, a3, a5) => ({ 1: a1, 3: a3, 5: a5 });
    const T = (positionGroup, attributes) => ({
      id: `tpl-${positionGroup.toLowerCase()}`, positionGroup, version: 1,
      createdAt: Date.now(), createdBy: 'seed',
      attributes: attributes.map(([id, label, anchors]) => ({ id, label, anchors })),
    });
    db.assessmentTemplates.push(
      T('GK', [
        ['shot_stopping', 'Shot stopping', anchor('Beaten by savable strikes', 'Makes the expected saves', 'Repeatedly saves strikes most keepers concede')],
        ['distribution', 'Distribution', anchor('Kicks are a turnover', 'Safe short + adequate long', 'Starts attacks under pressure')],
        ['command_of_area', 'Command of area', anchor('Stays rooted on crosses', 'Claims the straightforward ball', 'Owns the box, organises the line')],
        ['one_v_one', '1v1', anchor('Commits early, easily rounded', 'Delays and narrows angles', 'Consistently wins clean 1v1s')],
      ]),
      T('DEF', [
        ['positioning', 'Positioning', anchor('Caught ball-watching', 'Holds the line, tracks runners', 'Reads danger two passes early')],
        ['duels', 'Duels (ground + air)', anchor('Loses most contests', 'Breaks even vs like-for-like', 'Dominant in both phases')],
        ['first_pass', 'First pass out', anchor('Clears blind', 'Finds the free full-back', 'Breaks a line on the ground')],
        ['recovery_pace', 'Recovery pace', anchor('Exposed in space', 'Copes with average movers', 'Recovers vs quick attackers')],
      ]),
      T('MID', [
        ['receiving', 'Receiving under pressure', anchor('Hides from the ball', 'Keeps it simple, keeps it safe', 'Wants it in traffic, turns out of it')],
        ['progression', 'Ball progression', anchor('Sideways and backwards only', 'Moves play forward when on', 'Consistently breaks lines by pass or carry')],
        ['defensive_work', 'Defensive contribution', anchor('Jogs back', 'Screens and tracks adequately', 'Wins it back high, reads screens'), ],
        ['tempo', 'Tempo control', anchor('Rushes everything', 'Plays at the game’s pace', 'Dictates the game’s pace')],
      ]),
      T('ATT', [
        ['finishing', 'Finishing', anchor('Snatches at chances', 'Buries the clear ones', 'Finishes half-chances both feet')],
        ['movement', 'Movement off the ball', anchor('Static, marks himself', 'Finds space in rotation', 'Constantly unbalances the back line')],
        ['first_touch', 'First touch', anchor('Touch escapes under pressure', 'Controls with time', 'Kills any ball instantly under pressure')],
        ['pressing', 'Pressing', anchor('No defensive effort', 'Presses on triggers', 'First defender, sets the press')],
      ]),
    );
  }

  const currentTemplateFor = (positionGroup) =>
    db.assessmentTemplates.filter((t) => t.positionGroup === positionGroup).sort((a, b) => b.version - a.version)[0];

  orgRouter.get('/assessment-templates', (req, res) => {
    res.json({ templates: db.assessmentTemplates, note: 'New versions never alter historical reports — every assessment snapshots its template at creation.' });
  });

  orgRouter.post('/assessment-templates', (req, res) => {
    if (!requireLead(req, res)) return;
    const { positionGroup, attributes } = req.body ?? {};
    if (!['GK', 'DEF', 'MID', 'ATT'].includes(positionGroup)) return res.status(400).json({ error: 'POSITION_GROUP_INVALID' });
    if (!Array.isArray(attributes) || attributes.length < 2 || attributes.some((a) => !a.id || !a.label)) {
      return res.status(400).json({ error: 'ATTRIBUTES_INVALID', message: 'At least two attributes, each with id + label (+ descriptive anchors).' });
    }
    const prev = currentTemplateFor(positionGroup);
    const t = {
      id: `tpl-${positionGroup.toLowerCase()}`, positionGroup, version: (prev?.version ?? 0) + 1,
      createdAt: Date.now(), createdBy: req.orgUser.name,
      attributes: attributes.map((a) => ({ id: String(a.id).slice(0, 40), label: String(a.label).slice(0, 80), anchors: a.anchors ?? {} })),
    };
    db.assessmentTemplates.push(t);
    persistNow();
    res.status(201).json({ template: t });
  });

  // --------------------------------------------------------- assessments
  function assessmentAccessList(req, playerId) {
    // The blind rule, enforced where the data leaves the server: a scout
    // sees OTHER scouts' assessments of a player only after submitting
    // their own (leads see everything — they commission the second opinion).
    const mine = db.assessments.filter((a) => a.orgId === req.org.id && a.playerId === playerId);
    if (isLead(req.orgUser)) return mine;
    const iSubmitted = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    return mine.filter((a) => a.scoutUserId === req.orgUser.id || (iSubmitted && a.state !== 'draft'));
  }

  function assessmentView(a) {
    const { history, ...rest } = a;
    return rest;
  }

  orgRouter.get('/assessments', (req, res) => {
    let list;
    if (req.query.playerId) {
      list = assessmentAccessList(req, String(req.query.playerId));
    } else if (isLead(req.orgUser)) {
      list = db.assessments.filter((a) => a.orgId === req.org.id);
    } else {
      list = db.assessments.filter((a) => a.orgId === req.org.id && a.scoutUserId === req.orgUser.id);
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
    if (secondOpinionOf) {
      const first = db.assessments.find((a) => a.id === secondOpinionOf && a.orgId === req.org.id);
      if (!first) return res.status(404).json({ error: 'FIRST_OPINION_NOT_FOUND' });
      if (first.scoutUserId === req.orgUser.id) return res.status(400).json({ error: 'NOT_INDEPENDENT', message: 'A second opinion comes from a different scout.' });
    }
    const a = {
      id: nextId('ass'), orgId: req.org.id, playerId: p.id, playerName: p.name,
      scoutUserId: req.orgUser.id, scoutName: req.orgUser.name,
      templateId: tmpl.id, templateVersion: tmpl.version,
      attributesSnapshot: tmpl.attributes, // immutability: the report keeps its scale
      context: {
        fixture: context?.fixture ? String(context.fixture).slice(0, 120) : null,
        date: context?.date ?? null,
        minutesWatched: Number(context?.minutesWatched) || null,
        viewing: ['live', 'video'].includes(context?.viewing) ? context.viewing : null,
        opponentLevel: context?.opponentLevel ? String(context.opponentLevel).slice(0, 60) : null,
      },
      ratings: [], state: 'draft', recommendation: null,
      secondOpinionOf: secondOpinionOf ?? null,
      createdAt: Date.now(), submittedAt: null, reviewedAt: null,
      publishedFeedback: null, history: [],
    };
    audit(a, 'org', req.orgUser.id, req.orgUser.name, 'created');
    db.assessments.push(a);
    persistNow();
    res.status(201).json({ assessment: assessmentView(a) });
  });

  orgRouter.put('/assessments/:id', (req, res) => {
    const a = db.assessments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id) return res.status(403).json({ error: 'NOT_YOUR_ASSESSMENT' });
    if (a.state !== 'draft') return res.status(409).json({ error: 'NOT_A_DRAFT', message: 'Submitted assessments are immutable; commission a second opinion or a new viewing instead.' });
    const { ratings, context, recommendation } = req.body ?? {};
    if (Array.isArray(ratings)) {
      for (const r of ratings) {
        const attr = a.attributesSnapshot.find((x) => x.id === r.attrId);
        if (!attr) return res.status(400).json({ error: 'ATTR_UNKNOWN', attrId: r.attrId });
        if (!r.notObserved && !(r.rating >= 1 && r.rating <= 5)) return res.status(400).json({ error: 'RATING_INVALID', message: 'Each attribute is 1–5, or explicitly "not observed" — never a silent zero.' });
        if (r.confidence && !CONFIDENCE.includes(r.confidence)) return res.status(400).json({ error: 'CONFIDENCE_INVALID', allowed: CONFIDENCE });
        if (Array.isArray(r.evidenceRefs)) {
          for (const ref of r.evidenceRefs) {
            if (ref.segmentId && !db.videoSegments.some((s) => s.id === ref.segmentId && s.orgId === req.org.id && s.playerId === a.playerId)) {
              return res.status(400).json({ error: 'SEGMENT_INVALID', segmentId: ref.segmentId });
            }
          }
        }
      }
      a.ratings = ratings.map((r) => ({
        attrId: r.attrId, rating: r.notObserved ? null : Number(r.rating), notObserved: !!r.notObserved,
        confidence: r.confidence ?? 'medium', note: r.note ? String(r.note).slice(0, 300) : null,
        evidenceRefs: Array.isArray(r.evidenceRefs) ? r.evidenceRefs.slice(0, 6) : [],
      }));
    }
    if (context) a.context = { ...a.context, ...context };
    if (recommendation) {
      if (!['sign', 'monitor', 'pass'].includes(recommendation.verdict)) return res.status(400).json({ error: 'VERDICT_INVALID' });
      a.recommendation = { verdict: recommendation.verdict, reasons: String(recommendation.reasons ?? '').slice(0, 500) };
    }
    persistNow();
    res.json({ assessment: assessmentView(a) });
  });

  orgRouter.post('/assessments/:id/submit', (req, res) => {
    const a = db.assessments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id) return res.status(403).json({ error: 'NOT_YOUR_ASSESSMENT' });
    if (a.state !== 'draft') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (!a.ratings.length) return res.status(400).json({ error: 'RATINGS_REQUIRED' });
    if (!a.recommendation) return res.status(400).json({ error: 'RECOMMENDATION_REQUIRED', message: 'Every submitted assessment carries a final recommendation with reasons.' });
    a.state = 'submitted';
    a.submittedAt = Date.now();
    audit(a, 'org', req.orgUser.id, req.orgUser.name, 'submitted');
    ledgerAppend({ type: 'assessment_submitted', playerId: a.playerId, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
    res.json({ assessment: assessmentView(a) });
  });

  orgRouter.post('/assessments/:id/review', (req, res) => {
    if (!requireLead(req, res)) return;
    const a = db.assessments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.state !== 'submitted') return res.status(409).json({ error: 'NOT_SUBMITTED' });
    a.state = 'reviewed';
    a.reviewedAt = Date.now();
    a.reviewNote = req.body?.note ? String(req.body.note).slice(0, 300) : null;
    audit(a, 'org', req.orgUser.id, req.orgUser.name, 'reviewed');
    persistNow();
    res.json({ assessment: assessmentView(a) });
  });

  // Side-by-side comparison across scouts and dates. "Not observed" never
  // enters an average; observedCount is shown instead of pretending.
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

  // Publishing feedback is a deliberate, separate act — the ONLY door from
  // private recruitment records to the player/guardian side.
  orgRouter.post('/assessments/:id/publish-feedback', (req, res) => {
    const a = db.assessments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSESSMENT_NOT_FOUND' });
    if (a.scoutUserId !== req.orgUser.id && !isLead(req.orgUser)) return res.status(403).json({ error: 'NOT_AUTHORISED' });
    if (a.state === 'draft') return res.status(409).json({ error: 'NOT_SUBMITTED', message: 'Submit the assessment before publishing feedback from it.' });
    if (a.publishedFeedback) return res.status(409).json({ error: 'ALREADY_PUBLISHED' });
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (!moderateOrRefuse(res, text, { kind: 'published_feedback', playerId: a.playerId, orgId: req.org.id })) return;
    const p = findPlayer(a.playerId);
    a.publishedFeedback = { text: text.slice(0, 800), byUserId: req.orgUser.id, byName: req.orgUser.name, at: Date.now() };
    audit(a, 'org', req.orgUser.id, req.orgUser.name, 'published_feedback');
    if (p && !isAdult(p) && p.guardianId) {
      notify({ kind: 'guardian', id: p.guardianId }, 'feedback', `${req.org.name} published development feedback for ${p.name}.`, a.id);
      notify({ kind: 'player', id: p.id }, 'feedback', `${req.org.name} shared development feedback with your parent/guardian.`, a.id);
    } else if (p) {
      notify({ kind: 'player', id: p.id }, 'feedback', `📋 ${req.org.name} published development feedback for you.`, a.id);
    }
    persistNow();
    broadcast('feedback', { playerId: a.playerId });
    res.json({ published: a.publishedFeedback });
  });

  const feedbackViewFor = (playerId) => db.assessments
    .filter((a) => a.playerId === playerId && a.publishedFeedback)
    .map((a) => ({ id: a.id, orgId: a.orgId, orgName: db.orgs.find((o) => o.id === a.orgId)?.name ?? 'Club', byName: a.publishedFeedback.byName, text: a.publishedFeedback.text, at: a.publishedFeedback.at }));

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

  // ================================================================== F7
  // Video segments: annotations stored AGAINST source media (no duplicated
  // blobs), org-private workflow records — never public comments, never a
  // channel to a child. Media access itself keeps the signed-URL + live
  // entitlement rules from M11.1.

  function mediaOwner(mediaId) {
    return db.players.find((p) => p.media.some((m) => m.id === mediaId));
  }

  orgRouter.post('/media/:id/segments', (req, res) => {
    const owner = mediaOwner(req.params.id);
    if (!owner) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    if (!orgCanSee(req.org, owner)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const { startS, endS, labels, eventType, note, drawing } = req.body ?? {};
    const s0 = Number(startS), s1 = Number(endS);
    if (!(s0 >= 0) || !(s1 > s0) || s1 - s0 > 600) return res.status(400).json({ error: 'TIMESTAMPS_INVALID', message: 'start ≥ 0, end > start, segment ≤ 10 minutes.' });
    if (note && !moderateOrRefuse(res, note, { kind: 'segment_note', playerId: owner.id, orgId: req.org.id })) return;
    const seg = {
      id: nextId('seg'), mediaId: req.params.id, playerId: owner.id, orgId: req.org.id,
      createdBy: { userId: req.orgUser.id, name: req.orgUser.name },
      startS: s0, endS: s1,
      labels: Array.isArray(labels) ? labels.slice(0, 8).map((l) => String(l).slice(0, 30)) : [],
      eventType: eventType ? String(eventType).slice(0, 40) : null,
      note: note ? String(note).slice(0, 300) : null,
      drawing: drawing && typeof drawing === 'object' ? drawing : null, // simple overlay shapes, stored as data
      createdAt: Date.now(),
    };
    db.videoSegments.push(seg);
    persistNow();
    res.status(201).json({ segment: { ...seg, mediaUrl: `/media/${seg.mediaId}` } });
  });

  orgRouter.get('/segments', (req, res) => {
    let list = db.videoSegments.filter((s) => s.orgId === req.org.id);
    if (req.query.playerId) list = list.filter((s) => s.playerId === req.query.playerId);
    if (req.query.mediaId) list = list.filter((s) => s.mediaId === req.query.mediaId);
    // Live entitlement: segments on players no longer visible do not travel.
    list = list.filter((s) => orgCanSee(req.org, findPlayer(s.playerId)));
    res.json(paginate(req, list.map((s) => ({ ...s, mediaUrl: `/media/${s.mediaId}` }))));
  });

  orgRouter.get('/segments/:id', (req, res) => {
    const s = db.videoSegments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!s) return res.status(404).json({ error: 'SEGMENT_NOT_FOUND' });
    const owner = findPlayer(s.playerId);
    if (!orgCanSee(req.org, owner)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    const media = owner.media.find((m) => m.id === s.mediaId);
    res.json({ segment: { ...s, mediaUrl: `/media/${s.mediaId}` }, media: media ? { id: media.id, title: media.title, kind: media.kind, verifiedClip: media.verifiedClip, captions: media.captions ? true : false } : null });
  });

  orgRouter.post('/playlists', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'NAME_REQUIRED' });
    const pl = { id: nextId('pls'), orgId: req.org.id, name: name.slice(0, 80), createdBy: { userId: req.orgUser.id, name: req.orgUser.name }, segmentIds: [], createdAt: Date.now() };
    db.playlists.push(pl);
    persistNow();
    res.status(201).json({ playlist: pl });
  });

  orgRouter.post('/playlists/:id/segments', (req, res) => {
    const pl = db.playlists.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!pl) return res.status(404).json({ error: 'PLAYLIST_NOT_FOUND' });
    const seg = db.videoSegments.find((s) => s.id === req.body?.segmentId && s.orgId === req.org.id);
    if (!seg) return res.status(404).json({ error: 'SEGMENT_NOT_FOUND' });
    if (!pl.segmentIds.includes(seg.id)) pl.segmentIds.push(seg.id);
    persistNow();
    res.json({ playlist: pl });
  });

  orgRouter.get('/playlists', (req, res) => {
    res.json(db.playlists.filter((p) => p.orgId === req.org.id));
  });

  // ================================================================== F3
  // Recruitment cases: the workspace layer OVER existing requests, trials
  // and signings — cases LINK to those records, they never duplicate them.

  const stagesFor = (org) => (org.level === 'grassroots' ? GRASSROOTS_STAGES : PRO_STAGES);

  function caseAccess(req, c) {
    if (!c.restricted) return true;
    return c.ownerUserId === req.orgUser.id || c.assignments.some((a) => a.userId === req.orgUser.id) || isLead(req.orgUser);
  }
  function caseView(c) { return c; } // history is intentionally included: it is append-only

  orgRouter.get('/cases', (req, res) => {
    let list = db.recruitmentCases.filter((c) => c.orgId === req.org.id && caseAccess(req, c));
    if (req.query.stage) list = list.filter((c) => c.stage === req.query.stage);
    res.json({ ...paginate(req, list.slice().sort((a, b) => b.createdAt - a.createdAt).map(caseView)), stages: stagesFor(req.org) });
  });

  orgRouter.post('/cases', (req, res) => {
    const { playerId, vacancyId, priority, deadline, restricted } = req.body ?? {};
    const p = findPlayer(playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (vacancyId && !db.vacancies.some((v) => v.id === vacancyId && v.orgId === req.org.id)) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    const c = {
      id: nextId('case'), orgId: req.org.id, playerId: p.id, playerName: p.name,
      vacancyId: vacancyId ?? null, ownerUserId: req.orgUser.id, ownerName: req.orgUser.name,
      stage: stagesFor(req.org)[0], priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
      deadline: deadline ?? null, restricted: !!restricted,
      assignments: [], tasks: [], approvals: [], decision: null,
      links: { requestIds: [], trialIds: [], signingId: null },
      createdAt: Date.now(), history: [],
    };
    audit(c, 'org', req.orgUser.id, req.orgUser.name, 'created', c.stage);
    db.recruitmentCases.push(c);
    persistNow();
    res.status(201).json({ case: caseView(c) });
  });

  function findCase(req, res) {
    const c = db.recruitmentCases.find((x) => x.id === req.params.id && x.orgId === req.org.id);
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
    const u = db.users.find((x) => x.id === req.body?.userId && x.orgId === req.org.id && !x.removedAt);
    if (!u) return res.status(404).json({ error: 'STAFF_NOT_FOUND' });
    const asg = { id: nextId('asg'), userId: u.id, name: u.name, task: String(req.body?.task ?? 'Scout this player').slice(0, 200), dueAt: req.body?.dueAt ?? null, status: 'open', createdAt: Date.now() };
    c.assignments.push(asg);
    audit(c, 'org', req.orgUser.id, req.orgUser.name, 'assigned', `${u.name}: ${asg.task}`);
    notify({ kind: 'org_user', id: u.id }, 'case', `📌 ${req.orgUser.name} assigned you: ${asg.task} (${c.playerName}).`, c.id);
    persistNow();
    res.status(201).json({ assignment: asg });
  });

  orgRouter.post('/cases/:id/tasks', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const t = { id: nextId('tsk'), title: String(req.body?.title ?? '').slice(0, 200), dueAt: req.body?.dueAt ?? null, assigneeUserId: req.body?.assigneeUserId ?? null, status: 'open', createdAt: Date.now() };
    if (!t.title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    c.tasks.push(t);
    persistNow();
    res.status(201).json({ task: t });
  });

  orgRouter.post('/cases/:id/tasks/:tid/complete', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const t = c.tasks.find((x) => x.id === req.params.tid);
    if (!t) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    t.status = 'done';
    t.completedAt = Date.now();
    t.completedBy = req.orgUser.name;
    persistNow();
    res.json({ task: t });
  });

  orgRouter.post('/cases/:id/stage', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    // M23 — `case.stage` is a DERIVATION of `case.room.status` once the case has
    // a Room facet, and a derivation is not writable. Accepting a stage here
    // would be a side door around the lifecycle: no transition table, no
    // evidence requirement, no history entry and no rev bump, leaving the two
    // representations of one case disagreeing.
    //
    // Translating the stage back into a status is NOT a safe alternative. The
    // mapping is lossy — eighteen statuses collapse onto six stages — so
    // `decision` alone means any of `offer_consideration`, `offer_made`,
    // `offer_accepted` or `offer_declined`, and its inverse would move a room
    // at `offer_made` BACKWARDS. A lossy inverse cannot be an authoritative
    // write, which is exactly why authority runs status → stage and not back.
    //
    // A plain M12 case (no Room) has no lifecycle, so it is untouched.
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
    audit(c, 'org', req.orgUser.id, req.orgUser.name, 'stage', `${c.stage} → ${stage}${reason ? `: ${reason}` : ''}`);
    c.stage = stage;
    persistNow();
    res.json({ case: caseView(c) });
  });

  // Decisions: on Pro, a "sign" decision by a non-lead needs lead approval
  // (the configured approval requirement); grassroots and pass/monitor
  // decisions record directly. Every decision keeps reasons + actor.
  orgRouter.post('/cases/:id/decision', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const { outcome, reasons } = req.body ?? {};
    if (!['sign', 'pass', 'monitor'].includes(outcome)) return res.status(400).json({ error: 'OUTCOME_INVALID' });
    if (!reasons || !String(reasons).trim()) return res.status(400).json({ error: 'REASONS_REQUIRED', message: 'Decisions carry reasons — they outlive the people who made them.' });
    const needsApproval = req.org.level !== 'grassroots' && outcome === 'sign' && !isLead(req.orgUser);
    if (needsApproval) {
      const appr = { id: nextId('apr'), decision: { outcome, reasons: String(reasons).slice(0, 500) }, requestedBy: { userId: req.orgUser.id, name: req.orgUser.name }, status: 'pending', requestedAt: Date.now(), resolvedBy: null };
      c.approvals.push(appr);
      audit(c, 'org', req.orgUser.id, req.orgUser.name, 'approval_requested', outcome);
      persistNow();
      return res.status(202).json({ approval: appr, note: 'A sign decision needs a recruitment lead’s approval.' });
    }
    c.decision = { outcome, reasons: String(reasons).slice(0, 500), byUserId: req.orgUser.id, byName: req.orgUser.name, at: Date.now() };
    // M23 — recording the decision is the point of this route; moving the case
    // is not. On a Room the stage is derived from the lifecycle status, so
    // writing it here would desync the two. The decision stands either way.
    if (!c.room) c.stage = 'decision';
    audit(c, 'org', req.orgUser.id, req.orgUser.name, 'decision', outcome);
    persistNow();
    res.json({ case: caseView(c) });
  });

  orgRouter.post('/cases/:id/approvals/:aid', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    if (!requireLead(req, res)) return;
    const appr = c.approvals.find((x) => x.id === req.params.aid);
    if (!appr || appr.status !== 'pending') return res.status(404).json({ error: 'APPROVAL_NOT_FOUND' });
    const approve = !!req.body?.approve;
    appr.status = approve ? 'approved' : 'rejected';
    appr.resolvedBy = { userId: req.orgUser.id, name: req.orgUser.name, at: Date.now() };
    if (approve) {
      c.decision = { ...appr.decision, byUserId: appr.requestedBy.userId, byName: appr.requestedBy.name, approvedBy: req.orgUser.name, at: Date.now() };
      if (!c.room) c.stage = 'decision'; // derived on a Room — see the decision route
    }
    audit(c, 'org', req.orgUser.id, req.orgUser.name, approve ? 'approved' : 'rejected', appr.decision.outcome);
    notify({ kind: 'org_user', id: appr.requestedBy.userId }, 'case', `${approve ? '✅ approved' : '❌ rejected'}: your ${appr.decision.outcome} decision on ${c.playerName}.`, c.id);
    persistNow();
    res.json({ case: caseView(c) });
  });

  orgRouter.post('/cases/:id/link', (req, res) => {
    const c = findCase(req, res);
    if (!c) return;
    const { requestId, trialId, signingId } = req.body ?? {};
    if (requestId) {
      const r = db.requests.find((x) => x.id === requestId && x.orgId === req.org.id && x.playerId === c.playerId);
      if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
      if (!c.links.requestIds.includes(requestId)) c.links.requestIds.push(requestId);
    }
    if (trialId) {
      const t = db.trials.find((x) => x.id === trialId && x.orgId === req.org.id && x.playerId === c.playerId);
      if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      if (!c.links.trialIds.includes(trialId)) c.links.trialIds.push(trialId);
    }
    if (signingId) {
      const s = db.signings.find((x) => x.id === signingId && x.orgId === req.org.id && x.playerId === c.playerId);
      if (!s) return res.status(404).json({ error: 'SIGNING_NOT_FOUND' });
      c.links.signingId = signingId;
    }
    audit(c, 'org', req.orgUser.id, req.orgUser.name, 'linked', JSON.stringify({ requestId, trialId, signingId }));
    persistNow();
    res.json({ case: caseView(c) });
  });

  // Staff management: list + removal. Removal is immediate and structural
  // (sessions gone, SSE silenced, media re-checks fail) but the user ROW
  // stays so decisions and history remain attributable.
  orgRouter.get('/staff', (req, res) => {
    res.json(db.users.filter((u) => u.orgId === req.org.id).map((u) => ({ id: u.id, name: u.name, role: u.role, lead: isLead(u), removedAt: u.removedAt ?? null })));
  });

  orgRouter.post('/staff/:userId/remove', (req, res) => {
    if (!requireLead(req, res)) return;
    if (req.params.userId === req.orgUser.id) return res.status(400).json({ error: 'CANNOT_REMOVE_SELF' });
    const u = db.users.find((x) => x.id === req.params.userId && x.orgId === req.org.id);
    if (!u) return res.status(404).json({ error: 'STAFF_NOT_FOUND' });
    if (u.removedAt) return res.status(409).json({ error: 'ALREADY_REMOVED' });
    u.removedAt = Date.now();
    u.removedBy = req.orgUser.name;
    revokeOrgUserAccess(u.id);
    ledgerAppend({ type: 'staff_removed', orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    res.json({ removed: { id: u.id, name: u.name, removedAt: u.removedAt }, note: 'Sessions revoked, event streams silenced, media links dead on next fetch. History stays attributed to the named person.' });
  });

  // ================================================================== F4
  // Tactical fit: transparent, rule-based matching. Criteria met / not met /
  // unknown, each with its data source — never a fabricated percentage,
  // potential rating, salary estimate or transfer value.

  const CRITERIA_KEYS = ['positionGroup', 'minAge', 'maxAge', 'foot', 'availability', 'maxLevel', 'minAppearances', 'category'];
  const groups = { GK: ['GK'], DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'], MID: ['CDM', 'CM', 'CAM'], ATT: ['ST', 'CF', 'RW', 'LW'] };
  function groupFor(position) {
    return Object.keys(groups).find((g) => groups[g].includes(position)) ?? 'MID';
  }

  orgRouter.get('/tactical', (req, res) => {
    res.json({ tactical: req.org.tactical, criteriaKeys: CRITERIA_KEYS });
  });

  orgRouter.post('/tactical', (req, res) => {
    if (!requireLead(req, res)) return;
    const { formation, roles, windows, planningHorizon } = req.body ?? {};
    if (!formation || !Array.isArray(roles)) return res.status(400).json({ error: 'FORMATION_AND_ROLES_REQUIRED' });
    req.org.tactical = {
      formation: String(formation).slice(0, 20),
      planningHorizon: planningHorizon ? String(planningHorizon).slice(0, 40) : null,
      windows: Array.isArray(windows) ? windows.slice(0, 4).map((w) => ({ name: String(w.name ?? '').slice(0, 40), opens: w.opens ?? null, closes: w.closes ?? null })) : [],
      roles: roles.slice(0, 15).map((r) => ({
        id: r.id ?? nextId('role'),
        name: String(r.name ?? '').slice(0, 60),
        positionGroup: ['GK', 'DEF', 'MID', 'ATT'].includes(r.positionGroup) ? r.positionGroup : 'MID',
        description: String(r.description ?? '').slice(0, 300),
        category: ['mens', 'womens', 'boys', 'girls', 'mixed'].includes(r.category) ? r.category : 'mixed',
        required: sanitiseCriteria(r.required),
        preferred: sanitiseCriteria(r.preferred),
      })),
      updatedAt: Date.now(), updatedBy: req.orgUser.name,
    };
    persistNow();
    res.json({ tactical: req.org.tactical });
  });

  function sanitiseCriteria(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((c) => CRITERIA_KEYS.includes(c.key)).map((c) => ({ key: c.key, value: c.value }));
  }

  orgRouter.post('/vacancies', (req, res) => {
    const { roleId, notes, window } = req.body ?? {};
    const role = req.org.tactical?.roles.find((r) => r.id === roleId);
    if (!role) return res.status(404).json({ error: 'ROLE_NOT_FOUND', message: 'Define the tactical role first.' });
    const v = { id: nextId('vac'), orgId: req.org.id, roleId, roleName: role.name, window: window ?? null, notes: notes ? String(notes).slice(0, 300) : null, status: 'open', createdBy: req.orgUser.name, createdAt: Date.now() };
    db.vacancies.push(v);
    persistNow();
    res.status(201).json({ vacancy: v });
  });

  orgRouter.get('/vacancies', (req, res) => {
    res.json(db.vacancies.filter((v) => v.orgId === req.org.id));
  });

  orgRouter.post('/vacancies/:id/close', (req, res) => {
    const v = db.vacancies.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!v) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    v.status = 'closed';
    v.closedAt = Date.now();
    persistNow();
    res.json({ vacancy: v });
  });

  function evaluateCriterion(c, p, view) {
    // Returns { verdict: 'met'|'not_met'|'unknown', source }
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
        if (!p.foot) return { verdict: 'unknown', source: 'foot not recorded' };
        return { verdict: p.foot === c.value || p.foot === 'Both' ? 'met' : 'not_met', source: src('foot') };
      case 'availability':
        if (!p.availability) return { verdict: 'unknown', source: 'availability not set' };
        return { verdict: p.availability === c.value ? 'met' : 'not_met', source: src('availability') };
      case 'maxLevel':
        return { verdict: (p.level ?? 'amateur') === 'pro' && c.value !== 'pro' ? 'not_met' : 'met', source: src('level') };
      case 'minAppearances': {
        const apps = p.stats?.appearances;
        if (typeof apps !== 'number') return { verdict: 'unknown', source: 'no appearances statistic recorded' };
        const corroborated = db.evidence.some((e) => e.playerId === p.id && e.claimType === 'statistic' && !e.supersededBy && e.verification.status !== 'self_reported');
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
    const v = db.vacancies.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!v) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });
    const role = req.org.tactical?.roles.find((r) => r.id === v.roleId);
    if (!role) return res.status(409).json({ error: 'ROLE_DELETED' });
    const candidates = db.players
      .map((p) => ({ p, view: playerViewForOrg(p, req.org) }))
      .filter((x) => x.view) // the wall, the radius, the blocks — same as search
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
          onSquad: req.org.squad.some((s) => s.playerId === p.id),
          caseId: db.recruitmentCases.find((c) => c.orgId === req.org.id && c.playerId === p.id && c.stage !== 'closed')?.id ?? null,
        };
      })
      .filter((c) => !c.required.some((r) => r.verdict === 'not_met'))
      .sort((a, b) => (b.requiredMet - a.requiredMet) || (a.unknowns - b.unknowns));
    res.json({
      vacancy: v, role,
      candidates,
      note: 'Rule-based comparison: criteria met / not met / unknown with the data source for each. Unknown stays unknown — no invented suitability scores, potential ratings or market values.',
    });
  });

  // Squad planner: current squad + shadow candidates + contract ends +
  // vacancies in one view. Grassroots keeps its existing gap analysis.
  orgRouter.post('/squad/shadow', (req, res) => {
    const p = findPlayer(req.body?.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (req.org.squad.some((s) => s.playerId === p.id && s.source === 'shadow')) return res.status(409).json({ error: 'ALREADY_SHADOWED' });
    const entry = { id: nextId('sq'), playerId: p.id, name: p.name, source: 'shadow', roleId: req.body?.roleId ?? null, addedBy: req.orgUser.name, addedAt: Date.now() };
    req.org.squad.push(entry);
    persistNow();
    res.status(201).json({ entry });
  });

  orgRouter.get('/squad-planner', (req, res) => {
    const enrich = (s) => {
      const p = findPlayer(s.playerId);
      return { ...s, position: p?.position ?? null, contractUntil: p?.contractUntil ?? null, level: p?.level ?? null, visible: p ? orgCanSee(req.org, p) : false };
    };
    res.json({
      formation: req.org.tactical?.formation ?? null,
      roles: req.org.tactical?.roles ?? [],
      windows: req.org.tactical?.windows ?? [],
      current: req.org.squad.filter((s) => s.source !== 'shadow').map(enrich),
      shadow: req.org.squad.filter((s) => s.source === 'shadow').map(enrich),
      vacancies: db.vacancies.filter((v) => v.orgId === req.org.id && v.status === 'open'),
    });
  });
}
