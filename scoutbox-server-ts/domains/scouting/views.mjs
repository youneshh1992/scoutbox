/** The opportunity, application and board views the scouting routes, the Passport and the Agent workspace share. */

export const eligibilityView = (e) => ({
  minAge: e.minAge,
  maxAge: e.maxAge,
  positionGroup: e.positionGroup,
  ...(e.category !== undefined ? { category: e.category } : {}),
  maxLevel: e.maxLevel,
  radiusKm: e.radiusKm,
});
const slotView = (s) => ({ day: s.day, start: s.start, end: s.end, tz: s.tz });
export const opportunityView = (o) => ({
  id: o.id,
  orgId: o.orgId,
  orgName: o.orgName,
  orgLevel: o.orgLevel,
  type: o.type,
  title: o.title,
  team: o.team,
  category: o.category,
  ageGroup: o.ageGroup,
  role: o.role,
  description: o.description,
  schedule: o.schedule,
  deadline: o.deadline,
  capacity: o.capacity,
  eligibility: eligibilityView(o.eligibility),
  requirements: [...o.requirements],
  status: o.status,
  createdBy: o.createdBy,
  createdAt: o.createdAt,
  closedAt: o.closedAt,
  structured: o.structured
    ? {
        trainingSlots: o.structured.trainingSlots.map(slotView),
        relocationRequired: o.structured.relocationRequired,
        feeMinor: o.structured.feeMinor,
        currency: o.structured.currency,
        expensesCovered: o.structured.expensesCovered,
        environment: [...o.structured.environment],
        accommodations: [...o.structured.accommodations],
      }
    : null,
});
const historyView = (h) => ({
  id: h.id,
  at: h.at,
  byKind: h.byKind,
  byId: h.byId,
  byName: h.byName,
  action: h.action,
  detail: h.detail,
});
export const applicationView = (a) => ({
  id: a.id,
  opportunityId: a.opportunityId,
  orgId: a.orgId,
  playerId: a.playerId,
  playerName: a.playerName,
  submittedBy: { kind: a.submittedBy.kind, id: a.submittedBy.id, name: a.submittedBy.name },
  note: a.note,
  status: a.status,
  outcome: a.outcome
    ? {
        decision: a.outcome.decision,
        note: a.outcome.note,
        byUserId: a.outcome.byUserId,
        byName: a.outcome.byName,
        at: a.outcome.at,
      }
    : null,
  createdAt: a.createdAt,
  remindedAt: a.remindedAt,
  suitabilitySummary: a.suitabilitySummary
    ? {
        approvedAt: a.suitabilitySummary.approvedAt,
        approvedBy: a.suitabilitySummary.approvedBy,
        verdicts: a.suitabilitySummary.verdicts.map((v) => ({ dimension: v.dimension, verdict: v.verdict })),
      }
    : null,
  history: a.history.map(historyView),
});

/**
 * The player's opportunity board, with eligibility computed as the application gate computes it. Shared by the
 * player, guardian and Agent readers.
 */
export function opportunityBoardFor(
  grassrootsReads,
  player,
  { orgCanSee, checkEligibility, distanceBand, scoutingReads, orgOf },
) {
  if (!scoutingReads?.opportunities || !grassrootsReads?.openTrials || typeof orgOf !== 'function')
    throw new TypeError('opportunityBoardFor needs grassrootsReads, scoutingReads and orgOf');
  const today = new Date().toISOString().slice(0, 10);
  const mine = new Map(
    scoutingReads.applications
      .forPlayers([player.id])
      .filter((a) => a.status !== 'withdrawn')
      .map((a) => [a.opportunityId, a]),
  );
  const rows = [];
  for (const o of scoutingReads.opportunities.openOn(today)) {
    const org = orgOf(o.orgId);
    if (!org || org.suspended) continue;
    if (!orgCanSee(org, player)) continue; // visibility is mutual: an org that can't see the player can't receive their application
    const { eligible } = checkEligibility(o.eligibility, player, org);
    if (!eligible) continue;
    const existing = mine.get(o.id);
    rows.push({
      ...opportunityView(o),
      via: 'opportunity',
      distance: distanceBand(org.location, player.location),
      applied: existing ? { id: existing.id, status: existing.status } : null,
    });
  }
  // Grassroots open days ride the same board but keep their own registration flow and records.
  for (const t of grassrootsReads.openTrials.upcoming(today)) {
    const org = orgOf(t.orgId);
    if (!org || org.suspended || !orgCanSee(org, player)) continue;
    rows.push({
      id: t.id,
      via: 'open_trial',
      type: 'open_day',
      orgId: t.orgId,
      orgName: org.name,
      title: t.title,
      deadline: t.date,
      schedule: t.date,
      category: 'mixed',
      distance: distanceBand(org.location, player.location),
      applied: t.registrations.some((r) => r.playerId === player.id) ? { status: 'registered' } : null,
      note: 'Registered through the open-day flow.',
    });
  }
  return rows.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}
