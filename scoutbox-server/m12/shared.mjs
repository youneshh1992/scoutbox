// M12 shared: additive migrations + helpers used by every feature module.
import { isAdult, visibleToOrg, haversineKm } from '../domain.mjs';
import { ageOrNull, parseDateOrInstant, isAbsent } from '../temporal.mjs';
import { isLeadUser } from '../roles.mjs';

// ------------------------------------------------------------- migrations
// Same non-destructive convention as server.mjs: every new collection is
// created empty if absent; nothing existing is renamed, retyped or deleted.
// Versioned by the commit that introduces each line.
/** `players` (S5): the identity repository, for the media caption default (a row write). */
export function migrateM12(db, players) {
  // F1 evidence, F10 coach affiliations and squad invitations: tables of the scouting evidence repository (S9a), read
  // through SQL (scoutingReads); no db.* here.
  // F2 templates and assessments, F7 video segments and playlists: tables of the scouting assessments repository (S9b),
  // read through SQL (scoutingReads); no db.* here.
  // F3 recruitment cases: tables of the recruitment-cases repository, read through SQL (§4.3 step 2); no db.* here.
  // F4 the tactical setup, squad, shadow list and vacancies: tables of the club setup repository (S9c), read through
  // SQL (scoutingReads); no db.* and no organisation facet here.
  // F5 opportunities and applications, F6 campaigns and their submissions: tables of the opportunities and campaigns
  // repository (S9d), read through SQL (scoutingReads); no db.* here.
  // F8 development objectives: a table since S12a (repositories/development.mjs, developmentReads.objectives).
  // F11 follow-ups and outcome reports: tables of the signings repository, read through SQL (§4.3 step 2); no db.* here.
  // F12 resumable upload sessions: tables of repositories/operations.mjs (S13e), domains/media/uploads.mjs.
  // F12E — caption track (vtt text) or null. Since S5 a media item is a row of
  // player_media: the default is written through the repository only where the
  // stored item lacks the field (an existing null stays as it is).
  for (const p of [...db.players]) {
    for (const m of [...(p.media ?? [])]) if (m.captions === undefined) players.patchItem(p.id, 'media', { id: m.id }, { captions: null });
  }
  // F10 honesty audit: coach references (S10c: rows of vouches) state on every read that an email code confirms
  // mailbox control, not coach identity; conflictOfInterest and withdrawn are columns.
}

// ---------------------------------------------------------------- helpers
export function buildShared(ctx) {
  const { db, nextId } = ctx;

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

  // Append-only audit trail on important records.
  const audit = (record, byKind, byId, byName, action, detail = null) => {
    record.history ??= [];
    record.history.push({ id: nextId('aud'), at: Date.now(), byKind, byId, byName, action, detail });
  };

  // The player-or-guardian actor pattern: many M12 flows accept either the
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

  // KNOWN DEFECT, kept until the Founder decides: matched by the coach's NAME, not by a staff account (migration.md §4.5 S9).
  const activeAffiliation = (orgId, userName) => ctx.scoutingReads.coachAffiliations.activeFor(orgId, userName);

  // Eligibility engine shared by opportunities + campaigns (F5/F6). Explicit
  // criteria in, explicit verdict out; missing required data fails CLOSED.
  function checkEligibility(elig, player, org) {
    const reasons = [];
    if (!elig) return { eligible: true, reasons };
    // M23 P5.7 (T-8): THE age rule, not a second one. An unreadable date of
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

  // Distance shown as a band, never a precise home location (F12F).
  const distanceBand = (a, b) => {
    if (!a || !b) return null;
    const km = haversineKm(a, b);
    return km <= 5 ? 'under 5 km' : km <= 15 ? '5–15 km' : km <= 30 ? '15–30 km' : km <= 50 ? '30–50 km' : 'over 50 km';
  };

  /**
   * M23 P5.7: a due date (or a case deadline) is a calendar day or an instant that EXISTS, or it is absent.
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
    isLead, requireLead, orgCanSee, paginate, audit, guardianOwnsChild, dueAtOrRefuse,
    EVIDENCE_TIERS, freshness, activeAffiliation, checkEligibility,
    distanceBand, isAdult, haversineKm,
  };
}
