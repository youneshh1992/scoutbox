// Helpers shared by the feature modules registered in m12/.
import { isAdult, visibleToOrg, haversineKm } from '../domain.mjs';
import { ageOrNull, parseDateOrInstant, isAbsent } from '../temporal.mjs';
import { isLeadUser } from '../roles.mjs';

// ---------------------------------------------------------------- helpers
export function buildShared(ctx) {
  const { nextId } = ctx;

  // Lead = the privileged org role tier for approvals, staff management and
  // restricted cases. Rule-based on the stated role (documented, not hidden);
  // the one definition lives in roles.mjs.
  const isLead = isLeadUser;
  const requireLead = (req, res) => {
    if (isLead(req.orgUser)) return true;
    res.status(403).json({ error: 'LEAD_REQUIRED', message: 'This action needs a recruitment lead (role containing Head/Director/Lead/Manager).' });
    return false;
  };

  // Org access to a player, evaluated live: the same wall search/profile use.
  const orgCanSee = (org, player) => !!player && visibleToOrg(player, org) && !ctx.isBlocked(player.id, org.id);

  // Pagination for growing collections: ?limit=&offset= with sane caps.
  const paginate = (req, list) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return { total: list.length, limit, offset, items: list.slice(offset, offset + limit) };
  };

  // Append-only audit trail on important records: one entry, or the entry pushed onto a record draft.
  const auditEntry = (byKind, byId, byName, action, detail = null) => ({ id: nextId('aud'), at: Date.now(), byKind, byId, byName, action, detail });
  const audit = (record, ...entry) => {
    record.history ??= [];
    record.history.push(auditEntry(...entry));
  };

  // The player-or-guardian actor pattern: many of these flows accept either the
  // adult player or, for a minor, ONLY the owning guardian.
  const guardianOwnsChild = (guardian, playerId) => guardian.childIds.includes(playerId);

  // Evidence provenance tiers — the honest ladder. 'independent' exists in
  // the model but NO code path can set it: there is no integrated
  // independent-measurement provider, and pretending otherwise is the exact
  // failure this feature exists to prevent.
  const EVIDENCE_TIERS = ['self_reported', 'coach_confirmed', 'club_assessed', 'independent'];

  const freshness = (recordedAt) => {
    const days = Math.floor((Date.now() - recordedAt) / 86_400_000);
    return { ageDays: days, fresh: days <= 180 };
  };

  // KNOWN DEFECT, kept until the Founder decides: matched by the coach's NAME, not by a staff account.
  const activeAffiliation = (orgId, userName) => ctx.scoutingReads.coachAffiliations.activeFor(orgId, userName);

  // Eligibility engine shared by opportunities + campaigns. Explicit
  // criteria in, explicit verdict out; missing required data fails CLOSED.
  function checkEligibility(elig, player, org) {
    const reasons = [];
    if (!elig) return { eligible: true, reasons };
    // THE age rule, not a second one. An unreadable date of
    // birth is `null`, and null fails both age bounds below (closed).
    const age = ageOrNull(player.dob, Date.now());
    if (elig.minAge != null && (age === null || age < elig.minAge)) reasons.push(`minimum age ${elig.minAge}`);
    if (elig.maxAge != null && (age === null || age > elig.maxAge)) reasons.push(`maximum age ${elig.maxAge}`);
    if (elig.maxLevel === 'semi_pro' && player.level === 'pro') reasons.push('amateur/semi-pro only');
    if (elig.positionGroup && elig.positionGroup !== 'any') {
      const groups = { GK: ['GK'], DEF: ['CB', 'RB', 'LB', 'RWB', 'LWB'], MID: ['CDM', 'CM', 'CAM'], ATT: ['ST', 'CF', 'RW', 'LW'] };
      if (!(groups[elig.positionGroup] ?? []).includes(player.position)) reasons.push(`position group ${elig.positionGroup}`);
    }
    if (elig.category && elig.category !== 'mixed' && player.footballCategory && player.footballCategory !== elig.category) {
      reasons.push(`this is a ${elig.category} team/competition`);
    }
    if (elig.radiusKm != null) {
      if (!org?.location || !player.location) reasons.push('location required (fail-closed: set your ground/home area)');
      else if (haversineKm(org.location, player.location) > elig.radiusKm) reasons.push(`within ${elig.radiusKm} km`);
    }
    return { eligible: reasons.length === 0, reasons };
  }

  // Distance shown as a band, never a precise home location.
  const distanceBand = (a, b) => {
    if (!a || !b) return null;
    const km = haversineKm(a, b);
    return km <= 5 ? 'under 5 km' : km <= 15 ? '5–15 km' : km <= 30 ? '15–30 km' : km <= 50 ? '30–50 km' : 'over 50 km';
  };

  /**
   * A due date (or a case deadline) is a calendar day or an instant that EXISTS, or it is absent.
   * Returns the canonical stored value (a `YYYY-MM-DD` string or integer ms), null for absent, or undefined after
   * sending a 400.
   */
  const dueAtOrRefuse = (res, raw, field = 'dueAt') => {
    if (isAbsent(raw)) return null;
    const p = parseDateOrInstant(raw, { dayEdge: 'end' });
    if (!p.ok) { res.status(400).json({ error: 'DATE_INVALID', field, message: `A due date is a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset (${p.why}).`, expected: p.expected }); return undefined; }
    return p.precision === 'day' ? p.value : p.ms;
  };

  return {
    isLead, requireLead, orgCanSee, paginate, audit, auditEntry, guardianOwnsChild, dueAtOrRefuse,
    EVIDENCE_TIERS, freshness, activeAffiliation, checkEligibility,
    distanceBand, isAdult, haversineKm,
  };
}
