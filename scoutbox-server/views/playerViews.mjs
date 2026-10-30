/**
 * The exact fields each audience may receive of a player or a guardian
 * (readiness review §6, reconciled against the code). Every view here is a
 * POSITIVE allowlist built field by field — never a spread of the record with
 * a few keys deleted — so a field added to the record later is not served to
 * anyone until a decision puts it on a list. The functions are pure: they take
 * the record (or its read-only view) and the helpers the rule needs, and
 * return a fresh object.
 *
 * Classification of every difference from the pre-S4a responses is in §6:
 * "kept" (as before), "intentional privacy fix" (named by the plan and the
 * PRIVACY_HARDENING suites), or "withdrawn" (a first-draft change not made).
 */

/** §6.1 — what a club (any organisation) receives of a player, before the per-platform rules. */
export const ORG_PLAYER_FIELDS = Object.freeze([
  'id', 'name', 'position', 'foot', 'heightCm', 'weightKg', 'country', 'city', 'level', 'availability', 'contractStatus',
  'identityVerified', 'footballCategory', 'squadNumber', 'createdAt', 'firstTeamSeeker',
  // the pro-market surface: deleted again for grassroots clubs below (kept, as before)
  'academyPlus', 'marketValueRange', 'agentName', 'contractUntil',
  // football record and evidence (kept)
  'stats', 'seasonHistory', 'badges', 'timeline', 'drills', 'media',
]);
/** §6.1 — attendance items without the GPS fix (intentional privacy fix: attendance GPS leaked to clubs). */
export const ORG_ATTENDANCE_FIELDS = Object.freeze(['id', 'fixture', 'venue', 'date', 'verified', 'corroboratedBy', 'deviceConfirmed', 'trialId']);
/** §6.1 — never served to an organisation, whatever the record holds. */
export const ORG_PLAYER_NEVER = Object.freeze(['dob', 'location', 'programme', 'guardianId', 'password', 'activityLog', 'notificationPrefs', 'externalIds', 'drillResults', 'medical', 'trialReports', 'attendance']);
/** §6.5 — what Trust & Safety receives of a guardian: never the password hash, never the e-mail code. */
export const ADMIN_GUARDIAN_FIELDS = Object.freeze(['id', 'name', 'email', 'emailVerified', 'idVerified', 'idvReference', 'disclaimerAccepted', 'childIds', 'coGuardianOf', 'coGuardians', 'notificationPrefs', 'createdAt']);

const UNSHARED_MEDICAL = Object.freeze({ shared: false, records: [], conditionStatus: 'not_shared', note: 'Medical data is player-controlled and has not been shared.' });
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const pick = (record, fields) => { const out = {}; for (const f of fields) if (record[f] !== undefined) out[f] = plain(record[f]); return out; };

/**
 * §6.1 Clubs — the organisation-facing view. `null` when the organisation may
 * not see the player (visibility rule, block). `helpers` are the server's own
 * rules: visibleToOrg, isBlocked, isAdult, ageOn, computeTrustScore,
 * publishedVouchesFor, haversineKm.
 */
export function orgPlayerView(player, org, helpers) {
  const { visibleToOrg, isBlocked, isAdult, ageOn, computeTrustScore, publishedVouchesFor, haversineKm } = helpers;
  if (!player || !org) return null;
  if (!visibleToOrg(player, org)) return null;
  if (isBlocked(player.id, org.id)) return null;
  const minor = !isAdult(player);
  const view = pick(player, ORG_PLAYER_FIELDS);
  view.age = ageOn(player.dob);
  // M18.1 — this number is PROFILE COMPLETENESS, not the Trust Score; `trustScore` stays on the wire as a deprecated alias.
  view.profileSignal = computeTrustScore(player);
  view.trustScore = computeTrustScore(player);
  view.guardianManaged = minor;
  view.medical = player.medical?.shared ? plain(player.medical) : { ...UNSHARED_MEDICAL };
  // Attendance without the GPS fix; trial reports only this organisation's own (the authoritative copy is trials.report).
  view.attendance = (player.attendance ?? []).map((a) => pick(a, ORG_ATTENDANCE_FIELDS));
  view.trialReports = (player.trialReports ?? []).filter((r) => r && r.orgId === org.id).map(plain);
  if (minor) {
    view.city = '';
    view.contactPolicy = 'guardian_only';
  }
  if ((org.level ?? null) === 'grassroots') {
    // Grassroots is semi-pro and below: the pro-market surface does not exist on this platform.
    delete view.academyPlus; delete view.marketValueRange; delete view.agentName; delete view.contractUntil;
    view.distanceKm = Math.round(haversineKm(org.location, player.location) * 10) / 10;
    view.firstTeamSeeker = !!player.firstTeamSeeker; // Grassroots' own cohort
  }
  // Coach references travel with grassroots-journey players everywhere.
  if (player.level !== 'pro') view.vouches = publishedVouchesFor(player.id);
  for (const key of ORG_PLAYER_NEVER) if (key in view && !['medical', 'trialReports', 'attendance'].includes(key)) delete view[key];
  return view;
}

/** §6.3 — a guardian's view of their child: the whole record minus the password hash, plus the derived numbers (kept; the guardian is the child's representative). */
export function guardianChildView(player, helpers) {
  const { ageOn, computeTrustScore, trustBreakdown } = helpers;
  const { password, ...rest } = plain(player);
  return { ...rest, age: ageOn(player.dob), trustScore: computeTrustScore(player), trust: trustBreakdown(player) };
}

/** §6.3 — a guardian's own record: minus the password hash and the outstanding e-mail code (kept as before). */
export function guardianSelfView(guardian) {
  const { password, emailCode, ...safe } = plain(guardian);
  return safe;
}

/** §6.5 — Trust & Safety: a positive allowlist; never the hash, never the code (intentional privacy fix). */
export function adminGuardianView(guardian) {
  return pick(guardian, ADMIN_GUARDIAN_FIELDS);
}
