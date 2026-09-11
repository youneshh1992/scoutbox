// Milestone 18 registration point — Second Look + Nobody Missed.
//
// Registered LAST, after M17, because both systems consume the whole stack:
// M17 decision memory and rooms, M15 the Passport, M16/M16.1 observed
// evidence, M16.2 evidence confidence, M12/M13 evidence, assessments, trials
// and the missing-evidence engine.
//
// Every route registers on the EXISTING authenticated `orgRouter`, so bearer
// sessions, removed users, organisation suspension, `visibleToOrg`, blocks and
// moderation all run before any M18 handler. Neither system is player-facing:
// there is no player, guardian or public route in this milestone at all.
import { buildShared } from '../m12/shared.mjs';
import { metrics } from '../m13/enterprise.mjs';
import { registerSecondLook } from './secondLook.mjs';
import { registerNobodyMissed } from './nobodyMissed.mjs';
import {
  SECOND_LOOK_POLICY_VERSION, EVALUATION_COVERAGE_POLICY_VERSION,
  CHANGE_TYPES, REASON_CHANGE_MAP, PROHIBITED_BRIEF_FIELDS,
  EVIDENCE_REQUIREMENTS, POSITIONS, POSITION_GROUP_OF, SECOND_LOOK_STATUSES,
  SECOND_LOOK_TRANSITIONS, BRIEF_STATUSES, BRIEF_TRANSITIONS,
} from './shared.mjs';

export function migrateM18(db) {
  // Additive only. M18 persists WORKFLOW, never player truth: candidate
  // eligibility and material changes are derived live on every read so a
  // block, a removal or a visibility change takes effect immediately.
  db.secondLookItems ??= [];        // one per (org, room): what the club did with it
  db.recruitmentBriefs ??= [];      // explicit, versioned club demand
  db.nobodyMissedReviews ??= [];    // one per (org, brief, player): workflow only
}

export function registerM18(ctx) {
  migrateM18(ctx.db);

  // Boot assertions: cheap, and they catch the two ways this design could rot.
  for (const [reason, types] of Object.entries(REASON_CHANGE_MAP)) {
    for (const t of types) {
      if (!CHANGE_TYPES.includes(t)) throw new Error(`M18: reason "${reason}" maps to unknown change type "${t}".`);
    }
  }
  for (const p of POSITIONS) {
    if (!POSITION_GROUP_OF[p]) throw new Error(`M18: position "${p}" has no group.`);
  }
  // A protected characteristic must never be an allowed brief criterion.
  const allowed = ['positions', 'minAge', 'maxAge', 'radiusKm', 'maxLevel', 'foot', 'availability', 'evidenceRequirements', 'minTrustBand', 'combineProtocols'];
  for (const a of allowed) {
    if (PROHIBITED_BRIEF_FIELDS.some((p) => a.toLowerCase() === p)) throw new Error(`M18: "${a}" is both allowed and prohibited.`);
  }
  for (const r of EVIDENCE_REQUIREMENTS) if (!r.key || !r.label) throw new Error('M18: evidence requirement missing key or label.');
  for (const s of SECOND_LOOK_STATUSES) if (!SECOND_LOOK_TRANSITIONS[s]) throw new Error(`M18: status "${s}" has no transition list.`);
  for (const s of BRIEF_STATUSES) if (!BRIEF_TRANSITIONS[s]) throw new Error(`M18: brief status "${s}" has no transition list.`);

  metrics.secondLook = {
    second_look_created: 0,
    second_look_reviewed: 0,
    second_look_dismissed: 0,
    second_look_room_reopened: 0,
    recruitment_brief_created: 0,
    recruitment_brief_activated: 0,
    nobody_missed_player_reviewed: 0,
    nobody_missed_player_dismissed: 0,
    nobody_missed_player_added_to_room: 0,
    policyVersion: SECOND_LOOK_POLICY_VERSION,
    coveragePolicyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
  };
  // Counters only. No player id, no player name, no organisation name, and
  // nothing that could identify who was missed or reconsidered.
  const vmetric = (k, n = 1) => { metrics.secondLook[k] = (metrics.secondLook[k] ?? 0) + n; };

  const shared = { ...ctx, ...buildShared(ctx), vmetric };
  registerSecondLook(shared);
  registerNobodyMissed(shared);
  return shared;
}
