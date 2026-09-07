// M12 shared: additive migrations + helpers used by every feature module.
import { isAdult, visibleToOrg, haversineKm } from '../domain.mjs';

// ------------------------------------------------------------- migrations
// Same non-destructive convention as server.mjs: every new collection is
// created empty if absent; nothing existing is renamed, retyped or deleted.
// Versioned by the commit that introduces each line.
export function migrateM12(db) {
  db.evidence ??= [];            // F1 — evidence passport records
  db.coachAffiliations ??= [];   // F10 — club-confirmed coach affiliations
  db.squadInvites ??= [];        // F10 — restricted squad invitations (approval-gated)
  db.assessmentTemplates ??= []; // F2 — versioned, position-specific templates
  db.assessments ??= [];         // F2 — scouting assessments
  db.videoSegments ??= [];       // F7 — timestamped annotations against source media
  db.playlists ??= [];           // F7 — role-scoped segment playlists
  db.recruitmentCases ??= [];    // F3 — recruitment cases
  db.vacancies ??= [];           // F4 — role vacancies / briefs
  db.opportunities ??= [];       // F5 — structured opportunity board
  db.applications ??= [];        // F5 — opportunity applications
  db.campaigns ??= [];           // F6 — club-run assessment campaigns
  db.campaignSubmissions ??= []; // F6 — player submissions + review states
  db.devObjectives ??= [];       // F8 — development objectives
  db.followUps ??= [];           // F11 — persisted post-signing follow-up jobs
  db.outcomeReports ??= [];      // F11 — reported/confirmed/disputed outcomes
  db.uploadSessions ??= [];      // F12 — resumable upload sessions
  for (const o of db.orgs) {
    o.tactical ??= null;         // F4 — formation + role definitions
    o.squad ??= [];              // F4 — shadow/current squad exists for every org now
  }
  for (const p of db.players) {
    for (const m of p.media ?? []) m.captions ??= null; // F12E — caption track (vtt text) or null
  }
  for (const v of db.vouches ?? []) {
    // F10 honesty audit: an email-code reference confirms mailbox control,
    // not coach identity. The flag is now explicit on the record.
    v.identityVerified ??= false;
    v.verificationMethod ??= 'email_code';
    v.conflictOfInterest ??= null;
    v.withdrawn ??= null; // { at, by, reason } — history kept, views exclude
  }
}

// ---------------------------------------------------------------- helpers
export function buildShared(ctx) {
  const { db, nextId } = ctx;

  // Lead = the privileged org role tier for approvals, staff management and
  // restricted cases. Rule-based on the stated role (documented, not hidden).
  const isLead = (user) => /head|director|lead|manager|owner|chief/i.test(user?.role ?? '');
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

  const activeAffiliation = (orgId, userName) =>
    db.coachAffiliations.find((a) => a.orgId === orgId && a.status === 'confirmed'
      && a.coachName.toLowerCase() === String(userName ?? '').toLowerCase());

  // Eligibility engine shared by opportunities + campaigns (F5/F6). Explicit
  // criteria in, explicit verdict out; missing required data fails CLOSED.
  function checkEligibility(elig, player, org) {
    const reasons = [];
    if (!elig) return { eligible: true, reasons };
    const age = player.dob ? Math.floor((Date.now() - new Date(player.dob).getTime()) / (365.25 * 86_400_000)) : null;
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

  return {
    isLead, requireLead, orgCanSee, paginate, audit, guardianOwnsChild,
    EVIDENCE_TIERS, freshness, activeAffiliation, checkEligibility,
    distanceBand, isAdult, haversineKm,
  };
}
