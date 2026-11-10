// Preferences are private to the player (the guardian for under-18s): clubs see only per-application summaries the
// player or guardian approved. Suitability never overrides mandatory eligibility and never widens the grassroots
// 50 km ceiling.
import { blankPreferences, typePreferences, typeStructured } from '../../repositories/opportunitiesCampaigns.mjs';
import { opportunityView } from './journeys.mjs';
import { slotsOverlap } from './slots.mjs';

// Reading preferences writes nothing: a player who never saved any gets the blank defaults.
const prefsView = (p) => ({
  commitments: p.commitments.map((s) => ({ day: s.day, start: s.start, end: s.end, tz: s.tz, label: s.label })),
  availableSlots: p.availableSlots.map((s) => ({ day: s.day, start: s.start, end: s.end, tz: s.tz, label: s.label })),
  travelLimitKm: p.travelLimitKm,
  transport: p.transport,
  relocation: p.relocation,
  ambitions: p.ambitions,
  environment: [...p.environment],
  accessibility: [...p.accessibility],
  compensation: {
    maxFeeMinor: p.compensation.maxFeeMinor,
    currency: p.compensation.currency,
    expensesNeeded: p.compensation.expensesNeeded,
  },
  updatedAt: p.updatedAt,
});
/** The field a typer's reason names (`<label>.<path> <what>`), and the reason without the label, for a 400. */
const named = (reason, label) => {
  if (!reason.startsWith(`${label}.`)) return { field: 'body', message: reason };
  const rest = reason.slice(label.length + 1);
  return {
    field: rest.split(' ')[0].replace(/\.\[/g, '[').replace(/\.$/, '') || 'body',
    message: rest.replace(/\.\[/g, '[').replace(/\. /, ' '),
  };
};

export function registerSuitability(ctx) {
  const {
    byId,
    orgRouter,
    playerRouter,
    guardianRouter,
    scoutingReads,
    opportunitiesCampaigns,
    findPlayer,
    isAdult,
    haversineKm,
    coarseArea,
  } = ctx;
  if (typeof opportunitiesCampaigns?.preferences?.save !== 'function')
    throw new TypeError('registerSuitability needs the opportunities and campaigns repository from the data layer');

  const DIMENSIONS = ['schedule', 'travel', 'relocation', 'compensation', 'environment', 'accessibility'];
  const fieldInvalid = (res, field, message) => {
    res.status(400).json({ error: 'FIELD_INVALID', field, message });
    return undefined;
  };

  const prefsFor = (playerId) => scoutingReads.playerPrefs.forPlayer(playerId) ?? blankPreferences(playerId);

  /** The fields sent replace the stored ones. Returns the whole typed record, or undefined after a 400. */
  function prefsOrRefuse(res, playerId, body, { adult }) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return fieldInvalid(res, 'body', 'Preferences are a JSON object.');
    const known = [
      'commitments',
      'availableSlots',
      'travelLimitKm',
      'transport',
      'relocation',
      'ambitions',
      'environment',
      'accessibility',
      'compensation',
    ];
    const extra = Object.keys(body).find((k) => !known.includes(k));
    if (extra) return fieldInvalid(res, extra, `Preferences have no field ${extra}.`);
    const next = JSON.parse(JSON.stringify(prefsFor(playerId)));
    const shorten = (v, max) => (typeof v === 'string' ? v.slice(0, max) : v);
    const slotsIn = (list) =>
      Array.isArray(list)
        ? list.map((x) =>
            x && typeof x === 'object'
              ? { ...x, label: x.label === undefined || x.label === '' ? null : shorten(x.label, 60) }
              : x,
          )
        : list;
    if (body.commitments !== undefined) next.commitments = slotsIn(body.commitments);
    if (body.availableSlots !== undefined) next.availableSlots = slotsIn(body.availableSlots);
    if (body.travelLimitKm !== undefined)
      next.travelLimitKm =
        typeof body.travelLimitKm === 'number' && Number.isFinite(body.travelLimitKm)
          ? Math.max(0, Math.min(500, body.travelLimitKm))
          : body.travelLimitKm;
    if (body.transport !== undefined) next.transport = body.transport;
    // An adult field: never collected for minors.
    if (body.relocation !== undefined) next.relocation = adult ? body.relocation : null;
    if (body.ambitions !== undefined) next.ambitions = body.ambitions ? shorten(body.ambitions, 300) : null;
    if (body.environment !== undefined)
      next.environment = Array.isArray(body.environment)
        ? body.environment.map((e) => shorten(e, 40))
        : body.environment;
    if (body.accessibility !== undefined)
      next.accessibility = Array.isArray(body.accessibility)
        ? body.accessibility.map((e) => shorten(e, 80))
        : body.accessibility;
    if (body.compensation !== undefined) {
      const c = body.compensation;
      if (!c || typeof c !== 'object' || Array.isArray(c))
        return fieldInvalid(
          res,
          'compensation',
          'compensation is an object { maxFeeMinor, currency, expensesNeeded }.',
        );
      next.compensation = {
        maxFeeMinor: c.maxFeeMinor === undefined ? next.compensation.maxFeeMinor : c.maxFeeMinor,
        currency: c.currency === undefined ? next.compensation.currency : c.currency,
        expensesNeeded: c.expensesNeeded === undefined ? false : c.expensesNeeded,
      };
    }
    next.updatedAt = Date.now();
    const t = typePreferences(next, 'preferences');
    if (!t.ok) {
      const n = named(t.reason, `preferences ${playerId}`);
      return fieldInvalid(res, n.field, `Preferences: ${n.message}.`);
    }
    return t.record;
  }

  playerRouter.get('/preferences', (req, res) => {
    res.json({
      preferences: prefsView(prefsFor(req.player.id)),
      private: true,
      note: 'Clubs never see this — only summaries you approve on an application.',
    });
  });

  playerRouter.put('/preferences', (req, res) => {
    if (req.playerIsMinor)
      return res.status(403).json({
        error: 'GUARDIAN_MANAGED',
        message: 'Suitability preferences for under-18s are set by your parent/guardian.',
      });
    const prefs = prefsOrRefuse(res, req.player.id, req.body ?? {}, { adult: true });
    if (!prefs) return;
    res.json({ preferences: prefsView(opportunitiesCampaigns.preferences.save(prefs)) });
  });

  guardianRouter.get('/children/:id/preferences', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    res.json({ preferences: prefsView(prefsFor(req.params.id)), private: true });
  });

  guardianRouter.put('/children/:id/preferences', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const prefs = prefsOrRefuse(res, req.params.id, req.body ?? {}, { adult: false });
    if (!prefs) return;
    res.json({ preferences: prefsView(opportunitiesCampaigns.preferences.save(prefs)) });
  });

  // ---------------------------------------------- structured requirements
  // Free-text `schedule` and `requirements` stay untouched; this record is replaced whole.
  orgRouter.put('/opportunities/:id/structured-requirements', (req, res) => {
    const o = scoutingReads.opportunities.ofOrg(req.params.id, req.org.id);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const b = req.body ?? {};
    if (typeof b !== 'object' || Array.isArray(b))
      return fieldInvalid(res, 'body', 'Structured requirements are a JSON object.');
    const shorten = (list, max) =>
      Array.isArray(list) ? list.map((e) => (typeof e === 'string' ? e.slice(0, max) : e)) : list;
    const structured = {
      trainingSlots: b.trainingSlots ?? [],
      relocationRequired: b.relocationRequired ?? false,
      feeMinor: b.feeMinor ?? null, // participation cost, if any
      currency: b.currency ?? 'GBP',
      expensesCovered: b.expensesCovered ?? false,
      environment: shorten(b.environment ?? [], 40),
      accommodations: shorten(b.accommodations ?? [], 80),
    };
    const extra = Object.keys(b).find((k) => !Object.hasOwn(structured, k));
    if (extra) return fieldInvalid(res, extra, `Structured requirements have no field ${extra}.`);
    const t = typeStructured(structured, 'structured');
    if (!t.ok) {
      const n = named(t.reason, 'structured');
      return fieldInvalid(res, n.field, `Structured requirements: ${n.message}.`);
    }
    const saved = opportunitiesCampaigns.opportunities.update(o.id, (d) => {
      d.structured = t.record;
    });
    res.json({ opportunity: { id: saved.id, structured: opportunityView(saved).structured } });
  });

  // -------------------------------------------------------- the comparison
  function verdictsFor(player, prefs, opp, org) {
    const out = [];
    const s = opp.structured;
    const add = (dimension, verdict, reason, source) => out.push({ dimension, verdict, reason, source });

    // schedule: overlapping a commitment is a conflict, fitting an available slot is compatible, else unknown.
    if (!s?.trainingSlots?.length)
      add('schedule', 'unknown', 'the club has not published structured training times', 'opportunity');
    else if (!prefs.commitments.length && !prefs.availableSlots.length)
      add('schedule', 'unknown', 'no commitments or availability recorded yet', 'your preferences');
    else {
      let conflict = null,
        allFit = prefs.availableSlots.length > 0;
      for (const req_ of s.trainingSlots) {
        for (const c of prefs.commitments) {
          if (slotsOverlap(req_, c) === true) {
            conflict = { req: req_, c };
            break;
          }
        }
        if (conflict) break;
        if (prefs.availableSlots.length && !prefs.availableSlots.some((a) => slotsOverlap(req_, a) === true))
          allFit = false;
      }
      if (conflict)
        add(
          'schedule',
          'conflict',
          `training ${conflict.req.day} ${conflict.req.start}–${conflict.req.end} (${conflict.req.tz}) overlaps your commitment “${conflict.c.label ?? conflict.c.day}” (${conflict.c.tz})`,
          'your commitments vs the club’s training times',
        );
      else if (allFit)
        add(
          'schedule',
          'compatible',
          'every published training slot falls inside your available times',
          'your availability vs the club’s training times',
        );
      else
        add(
          'schedule',
          'unknown',
          'no overlap with a recorded commitment, but availability is incomplete',
          'your preferences',
        );
    }

    // travel: coarse distance only; travel time is unavailable.
    if (!org?.location || !player.location)
      add('travel', 'unknown', 'location missing on one side (never guessed)', 'locations');
    else {
      const km = Math.round(haversineKm(org.location, player.location));
      const note = `${km} km from your area to ${coarseArea(org.location)} — travel time unavailable (no routing provider configured)`;
      if (prefs.travelLimitKm == null) add('travel', 'unknown', `${note}; you have not set a travel limit`, 'distance');
      else if (km <= prefs.travelLimitKm)
        add('travel', 'compatible', note, `distance vs your ${prefs.travelLimitKm} km limit`);
      else
        add(
          'travel',
          'conflict',
          `${note}; beyond your ${prefs.travelLimitKm} km limit`,
          `distance vs your ${prefs.travelLimitKm} km limit`,
        );
    }

    if (s?.relocationRequired) {
      if (!isAdult(player))
        add(
          'relocation',
          'conflict',
          'this opportunity expects relocation — not applicable to under-18 players',
          'safeguarding',
        );
      else if (prefs.relocation === 'no')
        add(
          'relocation',
          'conflict',
          'the role expects relocation and your preference is not to relocate',
          'your preferences',
        );
      else if (prefs.relocation === 'yes' || prefs.relocation === 'discuss')
        add(
          'relocation',
          'compatible',
          `relocation expected — your preference: ${prefs.relocation}`,
          'your preferences',
        );
      else add('relocation', 'unknown', 'relocation expected — you have not set a preference', 'your preferences');
    } else add('relocation', 'compatible', 'no relocation required', 'opportunity');

    if (s?.feeMinor != null && s.feeMinor > 0) {
      const max = prefs.compensation?.maxFeeMinor;
      if (max == null)
        add(
          'compensation',
          'unknown',
          'the opportunity has a participation fee and you have not set a maximum',
          'fees',
        );
      else if (s.currency !== (prefs.compensation.currency ?? 'GBP'))
        add(
          'compensation',
          'unknown',
          `fee is in ${s.currency}, your limit is in ${prefs.compensation.currency} — no conversion is assumed`,
          'fees',
        );
      else if (s.feeMinor <= max) add('compensation', 'compatible', 'the fee is within your stated maximum', 'fees');
      else add('compensation', 'conflict', 'the participation fee is above your stated maximum', 'fees');
    } else if (prefs.compensation?.expensesNeeded && s && !s.expensesCovered) {
      add('compensation', 'conflict', 'you need expenses covered and this opportunity does not cover them', 'fees');
    } else add('compensation', 'compatible', s ? 'no fee; expense needs met' : 'no fee declared', 'fees');

    if (!prefs.environment.length || !s?.environment?.length)
      add('environment', 'unknown', 'environment preferences or club tags not set', 'preferences');
    else {
      const hit = prefs.environment.filter((e) => s.environment.includes(e));
      add(
        'environment',
        hit.length ? 'compatible' : 'unknown',
        hit.length ? `matches: ${hit.join(', ')}` : 'no declared overlap — worth a conversation',
        'your preferences vs club tags',
      );
    }

    // accessibility: needs against declared accommodations only.
    if (!prefs.accessibility.length)
      add('accessibility', 'compatible', 'no accessibility requirements recorded', 'your preferences');
    else if (!s?.accommodations?.length)
      add(
        'accessibility',
        'unknown',
        'you listed requirements; the club has not declared its accommodations — nothing is assumed either way',
        'club declaration',
      );
    else {
      const unmet = prefs.accessibility.filter(
        (n) => !s.accommodations.some((a) => a.toLowerCase().includes(n.toLowerCase())),
      );
      if (unmet.length)
        add('accessibility', 'unknown', `not yet declared by the club: ${unmet.join(', ')}`, 'club declaration');
      else
        add(
          'accessibility',
          'compatible',
          'declared accommodations cover your listed requirements',
          'club declaration',
        );
    }
    return out;
  }

  playerRouter.get('/suitability/:oppId', (req, res) => {
    const o = scoutingReads.opportunities.byId(req.params.oppId);
    if (!o) return res.status(404).json({ error: 'OPPORTUNITY_NOT_FOUND' });
    const prefs = prefsFor(req.player.id);
    const org = byId.org(o.orgId);
    res.json({
      opportunityId: o.id,
      verdicts: verdictsFor(req.player, prefs, o, org),
      note: 'Suitability is guidance from YOUR private preferences. Eligibility rules (age, level, distance for grassroots) are separate and always apply.',
    });
  });

  guardianRouter.get('/children/:id/suitability/:oppId', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    const o = scoutingReads.opportunities.byId(req.params.oppId);
    if (!child || !o) return res.status(404).json({ error: 'NOT_FOUND' });
    const org = byId.org(o.orgId);
    res.json({ opportunityId: o.id, verdicts: verdictsFor(child, prefsFor(child.id), o, org) });
  });

  // ------------------------------------- player-approved summary for clubs
  // The only way suitability output reaches an org: verdict summaries attached to the player's own application,
  // explicitly approved.
  function shareHandler(actorKind) {
    return (req, res) => {
      const playerId = actorKind === 'guardian' ? req.params.id : req.player.id;
      if (actorKind === 'guardian' && !req.guardian.childIds.includes(playerId))
        return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
      if (actorKind === 'player' && req.playerIsMinor)
        return res.status(403).json({
          error: 'GUARDIAN_MANAGED',
          message: 'Sharing anything with a club is a guardian decision for under-18s.',
        });
      const applicationId = req.body?.applicationId;
      const a =
        typeof applicationId === 'string' ? scoutingReads.applications.ofPlayers(applicationId, [playerId]) : null;
      if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
      const player = findPlayer(playerId);
      if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      const o = scoutingReads.opportunities.byId(a.opportunityId);
      const org = byId.org(a.orgId);
      if (req.body?.share === false) {
        opportunitiesCampaigns.applications.update(a.id, (d) => {
          d.suitabilitySummary = null;
        });
        return res.json({ shared: false });
      }
      const verdicts = verdictsFor(player, prefsFor(playerId), o, org);
      // Dimension and verdict only: reasons can contain commitments, needs and limits.
      const saved = opportunitiesCampaigns.applications.update(a.id, (d) => {
        d.suitabilitySummary = {
          approvedAt: Date.now(),
          approvedBy: actorKind,
          verdicts: verdicts.map(({ dimension, verdict }) => ({ dimension, verdict })),
        };
      });
      res.json({ shared: true, summary: summaryView(saved.suitabilitySummary) });
    };
  }
  const summaryView = (sm) => ({
    approvedAt: sm.approvedAt,
    approvedBy: sm.approvedBy,
    verdicts: sm.verdicts.map((v) => ({ dimension: v.dimension, verdict: v.verdict })),
  });
  playerRouter.post('/suitability/share', shareHandler('player'));
  guardianRouter.post('/children/:id/suitability/share', shareHandler('guardian'));

  orgRouter.get('/applications/:id/suitability', (req, res) => {
    const a = scoutingReads.applications.ofOrg(req.params.id, req.org.id);
    if (!a) return res.status(404).json({ error: 'APPLICATION_NOT_FOUND' });
    if (!a.suitabilitySummary)
      return res.json({
        summary: null,
        note: 'The player/guardian has not shared a suitability summary for this application.',
      });
    res.json({
      summary: summaryView(a.suitabilitySummary),
      note: 'Verdict summary approved by the player/guardian. Underlying preferences are private.',
    });
  });
}
