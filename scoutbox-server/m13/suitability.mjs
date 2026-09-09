// F3 — Player-controlled opportunity suitability.
// Preferences are PRIVATE to the player (guardian for under-18s). Clubs never
// see raw preferences — only per-application summaries the player/guardian
// explicitly approved. Suitability NEVER overrides mandatory eligibility
// (which stays in the M12 checkEligibility path) and never widens the
// grassroots 50 km ceiling.
export function registerSuitability(ctx) {
  const {
    db, orgRouter, playerRouter, guardianRouter, nextId, persistNow,
    findPlayer, isAdult, haversineKm, slotsOverlap, coarseArea, paginate,
  } = ctx;

  const DIMENSIONS = ['schedule', 'travel', 'relocation', 'compensation', 'environment', 'accessibility'];

  const blankPrefs = (playerId) => ({
    id: nextId('prf'), playerId,
    commitments: [],      // busy slots: [{day,start,end,tz,label}] — education/work
    availableSlots: [],   // free-to-train slots: same shape
    travelLimitKm: null, transport: null,          // 'own', 'public', 'lift_needed'
    relocation: null,                              // adults only: 'yes' | 'no' | 'discuss'
    ambitions: null, environment: [],              // e.g. ['competitive','development_focus']
    accessibility: [],                             // optional needs, player-controlled
    compensation: { maxFeeMinor: null, currency: 'GBP', expensesNeeded: false },
    updatedAt: null,
  });

  const prefsFor = (playerId) => {
    let p = db.playerPrefs.find((x) => x.playerId === playerId);
    if (!p) { p = blankPrefs(playerId); db.playerPrefs.push(p); }
    return p;
  };

  function applyPrefs(prefs, body, { adult }) {
    const cleanSlot = (s) => ({
      day: String(s.day ?? '').toLowerCase().slice(0, 3), start: String(s.start ?? '').slice(0, 5),
      end: String(s.end ?? '').slice(0, 5), tz: String(s.tz ?? 'Europe/London').slice(0, 40),
      label: s.label ? String(s.label).slice(0, 60) : null,
    });
    if (Array.isArray(body.commitments)) prefs.commitments = body.commitments.slice(0, 20).map(cleanSlot);
    if (Array.isArray(body.availableSlots)) prefs.availableSlots = body.availableSlots.slice(0, 20).map(cleanSlot);
    if (body.travelLimitKm !== undefined) prefs.travelLimitKm = body.travelLimitKm === null ? null : Math.max(0, Math.min(500, Number(body.travelLimitKm) || 0));
    if (body.transport !== undefined) prefs.transport = ['own', 'public', 'lift_needed', null].includes(body.transport) ? body.transport : prefs.transport;
    if (body.relocation !== undefined) {
      // Relocation preference is an ADULT field — never collected for minors.
      prefs.relocation = adult && ['yes', 'no', 'discuss', null].includes(body.relocation) ? body.relocation : null;
    }
    if (body.ambitions !== undefined) prefs.ambitions = body.ambitions ? String(body.ambitions).slice(0, 300) : null;
    if (Array.isArray(body.environment)) prefs.environment = body.environment.slice(0, 8).map((e) => String(e).slice(0, 40));
    if (Array.isArray(body.accessibility)) prefs.accessibility = body.accessibility.slice(0, 8).map((e) => String(e).slice(0, 80));
    if (body.compensation) {
      prefs.compensation = {
        maxFeeMinor: body.compensation.maxFeeMinor === null ? null : (Number.isInteger(body.compensation.maxFeeMinor) ? body.compensation.maxFeeMinor : prefs.compensation.maxFeeMinor),
        currency: String(body.compensation.currency ?? prefs.compensation.currency).slice(0, 3),
        expensesNeeded: body.compensation.expensesNeeded === true,
      };
    }
    prefs.updatedAt = Date.now();
  }

  playerRouter.get('/preferences', (req, res) => {
    res.json({ preferences: prefsFor(req.player.id), private: true, note: 'Clubs never see this — only summaries you approve on an application.' });
  });

  playerRouter.put('/preferences', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Suitability preferences for under-18s are set by your parent/guardian.' });
    const prefs = prefsFor(req.player.id);
    applyPrefs(prefs, req.body ?? {}, { adult: true });
    persistNow();
    res.json({ preferences: prefs });
  });

  guardianRouter.get('/children/:id/preferences', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    res.json({ preferences: prefsFor(req.params.id), private: true });
  });

  guardianRouter.put('/children/:id/preferences', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const prefs = prefsFor(req.params.id);
    applyPrefs(prefs, req.body ?? {}, { adult: false });
    persistNow();
    res.json({ preferences: prefs });
  });

  // ---------------------------------------------- structured requirements
  // Additive: an opportunity may declare structured requirements; free-text
  // `schedule`/`requirements` from M12 stay untouched.
  orgRouter.put('/opportunities/:id/structured-requirements', (req, res) => {
    const o = db.opportunities.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const b = req.body ?? {};
    o.structured = {
      trainingSlots: (Array.isArray(b.trainingSlots) ? b.trainingSlots : []).slice(0, 10).map((s) => ({
        day: String(s.day ?? '').toLowerCase().slice(0, 3), start: String(s.start ?? '').slice(0, 5),
        end: String(s.end ?? '').slice(0, 5), tz: String(s.tz ?? 'Europe/London').slice(0, 40),
      })),
      relocationRequired: b.relocationRequired === true,
      feeMinor: Number.isInteger(b.feeMinor) ? b.feeMinor : null, // participation cost, if any
      currency: String(b.currency ?? 'GBP').slice(0, 3),
      expensesCovered: b.expensesCovered === true,
      environment: (Array.isArray(b.environment) ? b.environment : []).slice(0, 8).map((e) => String(e).slice(0, 40)),
      accommodations: (Array.isArray(b.accommodations) ? b.accommodations : []).slice(0, 8).map((e) => String(e).slice(0, 80)),
    };
    persistNow();
    res.json({ opportunity: { id: o.id, structured: o.structured } });
  });

  // -------------------------------------------------------- the comparison
  function verdictsFor(player, prefs, opp, org) {
    const out = [];
    const s = opp.structured;
    const add = (dimension, verdict, reason, source) => out.push({ dimension, verdict, reason, source });

    // schedule: a required slot that overlaps a commitment = conflict; one
    // that fits an available slot = compatible; otherwise unknown.
    if (!s?.trainingSlots?.length) add('schedule', 'unknown', 'the club has not published structured training times', 'opportunity');
    else if (!prefs.commitments.length && !prefs.availableSlots.length) add('schedule', 'unknown', 'no commitments or availability recorded yet', 'your preferences');
    else {
      let conflict = null, allFit = prefs.availableSlots.length > 0;
      for (const req_ of s.trainingSlots) {
        for (const c of prefs.commitments) {
          if (slotsOverlap(req_, c) === true) { conflict = { req: req_, c }; break; }
        }
        if (conflict) break;
        if (prefs.availableSlots.length && !prefs.availableSlots.some((a) => slotsOverlap(req_, a) === true)) allFit = false;
      }
      if (conflict) add('schedule', 'conflict', `training ${conflict.req.day} ${conflict.req.start}–${conflict.req.end} (${conflict.req.tz}) overlaps your commitment “${conflict.c.label ?? conflict.c.day}” (${conflict.c.tz})`, 'your commitments vs the club’s training times');
      else if (allFit) add('schedule', 'compatible', 'every published training slot falls inside your available times', 'your availability vs the club’s training times');
      else add('schedule', 'unknown', 'no overlap with a recorded commitment, but availability is incomplete', 'your preferences');
    }

    // travel: coarse distance only; travel TIME is honestly unavailable.
    if (!org?.location || !player.location) add('travel', 'unknown', 'location missing on one side (never guessed)', 'locations');
    else {
      const km = Math.round(haversineKm(org.location, player.location));
      const note = `${km} km from your area to ${coarseArea(org.location)} — travel time unavailable (no routing provider configured)`;
      if (prefs.travelLimitKm == null) add('travel', 'unknown', `${note}; you have not set a travel limit`, 'distance');
      else if (km <= prefs.travelLimitKm) add('travel', 'compatible', note, `distance vs your ${prefs.travelLimitKm} km limit`);
      else add('travel', 'conflict', `${note}; beyond your ${prefs.travelLimitKm} km limit`, `distance vs your ${prefs.travelLimitKm} km limit`);
    }

    // relocation (adults only)
    if (s?.relocationRequired) {
      if (!isAdult(player)) add('relocation', 'conflict', 'this opportunity expects relocation — not applicable to under-18 players', 'safeguarding');
      else if (prefs.relocation === 'no') add('relocation', 'conflict', 'the role expects relocation and your preference is not to relocate', 'your preferences');
      else if (prefs.relocation === 'yes' || prefs.relocation === 'discuss') add('relocation', 'compatible', `relocation expected — your preference: ${prefs.relocation}`, 'your preferences');
      else add('relocation', 'unknown', 'relocation expected — you have not set a preference', 'your preferences');
    } else add('relocation', 'compatible', 'no relocation required', 'opportunity');

    // compensation
    if (s?.feeMinor != null && s.feeMinor > 0) {
      const max = prefs.compensation?.maxFeeMinor;
      if (max == null) add('compensation', 'unknown', 'the opportunity has a participation fee and you have not set a maximum', 'fees');
      else if (s.currency !== (prefs.compensation.currency ?? 'GBP')) add('compensation', 'unknown', `fee is in ${s.currency}, your limit is in ${prefs.compensation.currency} — no conversion is assumed`, 'fees');
      else if (s.feeMinor <= max) add('compensation', 'compatible', 'the fee is within your stated maximum', 'fees');
      else add('compensation', 'conflict', 'the participation fee is above your stated maximum', 'fees');
    } else if (prefs.compensation?.expensesNeeded && s && !s.expensesCovered) {
      add('compensation', 'conflict', 'you need expenses covered and this opportunity does not cover them', 'fees');
    } else add('compensation', 'compatible', s ? 'no fee; expense needs met' : 'no fee declared', 'fees');

    // environment
    if (!prefs.environment.length || !s?.environment?.length) add('environment', 'unknown', 'environment preferences or club tags not set', 'preferences');
    else {
      const hit = prefs.environment.filter((e) => s.environment.includes(e));
      add('environment', hit.length ? 'compatible' : 'unknown', hit.length ? `matches: ${hit.join(', ')}` : 'no declared overlap — worth a conversation', 'your preferences vs club tags');
    }

    // accessibility: compare needs against DECLARED accommodations only.
    if (!prefs.accessibility.length) add('accessibility', 'compatible', 'no accessibility requirements recorded', 'your preferences');
    else if (!s?.accommodations?.length) add('accessibility', 'unknown', 'you listed requirements; the club has not declared its accommodations — nothing is assumed either way', 'club declaration');
    else {
      const unmet = prefs.accessibility.filter((n) => !s.accommodations.some((a) => a.toLowerCase().includes(n.toLowerCase())));
      if (unmet.length) add('accessibility', 'unknown', `not yet declared by the club: ${unmet.join(', ')}`, 'club declaration');
      else add('accessibility', 'compatible', 'declared accommodations cover your listed requirements', 'club declaration');
    }
    return out;
  }

  playerRouter.get('/suitability/:oppId', (req, res) => {
    const o = db.opportunities.find((x) => x.id === req.params.oppId);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const prefs = prefsFor(req.player.id);
    const org = db.orgs.find((x) => x.id === o.orgId);
    res.json({
      opportunityId: o.id, verdicts: verdictsFor(req.player, prefs, o, org),
      note: 'Suitability is guidance from YOUR private preferences. Eligibility rules (age, level, distance for grassroots) are separate and always apply.',
    });
  });

  guardianRouter.get('/children/:id/suitability/:oppId', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    const o = db.opportunities.find((x) => x.id === req.params.oppId);
    if (!child || !o) return res.status(404).json({ error: 'NOT_FOUND' });
    const org = db.orgs.find((x) => x.id === o.orgId);
    res.json({ opportunityId: o.id, verdicts: verdictsFor(child, prefsFor(child.id), o, org) });
  });

  // ------------------------------------- player-approved summary for clubs
  // The ONLY way any suitability output reaches an org: attached to that
  // player's own application, verdict summaries only (no raw preferences, no
  // reasons that carry commitments/needs), explicitly approved.
  function shareHandler(actorKind) {
    return (req, res) => {
      const playerId = actorKind === 'guardian' ? req.params.id : req.player.id;
      if (actorKind === 'guardian' && !req.guardian.childIds.includes(playerId)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
      if (actorKind === 'player' && req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Sharing anything with a club is a guardian decision for under-18s.' });
      const a = db.applications.find((x) => x.id === req.body?.applicationId && x.playerId === playerId);
      if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
      const player = findPlayer(playerId);
      const o = db.opportunities.find((x) => x.id === a.opportunityId);
      const org = db.orgs.find((x) => x.id === a.orgId);
      if (req.body?.share === false) { a.suitabilitySummary = null; persistNow(); return res.json({ shared: false }); }
      const verdicts = verdictsFor(player, prefsFor(playerId), o, org);
      // Summary = dimension + verdict ONLY. Reasons stay private: they can
      // contain commitments, needs and limits.
      a.suitabilitySummary = {
        approvedAt: Date.now(), approvedBy: actorKind,
        verdicts: verdicts.map(({ dimension, verdict }) => ({ dimension, verdict })),
      };
      persistNow();
      res.json({ shared: true, summary: a.suitabilitySummary });
    };
  }
  playerRouter.post('/suitability/share', shareHandler('player'));
  guardianRouter.post('/children/:id/suitability/share', shareHandler('guardian'));

  orgRouter.get('/applications/:id/suitability', (req, res) => {
    const a = db.applications.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (!a.suitabilitySummary) return res.json({ summary: null, note: 'The player/guardian has not shared a suitability summary for this application.' });
    res.json({ summary: a.suitabilitySummary, note: 'Verdict summary approved by the player/guardian. Underlying preferences are private.' });
  });
}
