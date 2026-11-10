// Registered last because both systems read the whole stack. Every route is on the authenticated `orgRouter`; there
// is no player, guardian or public route here.
import { buildRouteHelpers } from '../platform/routeHelpers.mjs';
import { metrics } from '../enterprise/enterprise.mjs';
import { registerSecondLook } from './secondLook.mjs';
import { registerNobodyMissed } from './nobodyMissed.mjs';
import {
  SECOND_LOOK_POLICY_VERSION, EVALUATION_COVERAGE_POLICY_VERSION,
  CHANGE_TYPES, REASON_CHANGE_MAP, PROHIBITED_BRIEF_FIELDS,
  EVIDENCE_REQUIREMENTS, POSITIONS, POSITION_GROUP_OF, SECOND_LOOK_STATUSES,
  SECOND_LOOK_TRANSITIONS, BRIEF_STATUSES, BRIEF_TRANSITIONS,
} from './shared.mjs';

// Discovery stores only workflow: eligibility and material changes are derived on every read so a block, removal or
// visibility change takes effect immediately.

export function registerDiscovery(ctx) {
  // Boot assertions on the vocabulary tables.
  for (const [reason, types] of Object.entries(REASON_CHANGE_MAP)) {
    for (const t of types) {
      if (!CHANGE_TYPES.includes(t)) throw new Error(`Second Look: reason "${reason}" maps to unknown change type "${t}".`);
    }
  }
  for (const p of POSITIONS) {
    if (!POSITION_GROUP_OF[p]) throw new Error(`Second Look: position "${p}" has no group.`);
  }
  const allowed = ['positions', 'minAge', 'maxAge', 'radiusKm', 'maxLevel', 'foot', 'availability', 'evidenceRequirements', 'minTrustBand', 'combineProtocols'];
  for (const a of allowed) {
    if (PROHIBITED_BRIEF_FIELDS.some((p) => a.toLowerCase() === p)) throw new Error(`Second Look: "${a}" is both allowed and prohibited.`);
  }
  for (const r of EVIDENCE_REQUIREMENTS) if (!r.key || !r.label) throw new Error('Second Look: evidence requirement missing key or label.');
  for (const s of SECOND_LOOK_STATUSES) if (!SECOND_LOOK_TRANSITIONS[s]) throw new Error(`Second Look: status "${s}" has no transition list.`);
  for (const s of BRIEF_STATUSES) if (!BRIEF_TRANSITIONS[s]) throw new Error(`Second Look: brief status "${s}" has no transition list.`);

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
  // Counters only: nothing that could identify who was missed or reconsidered.
  const vmetric = (k, n = 1) => { metrics.secondLook[k] = (metrics.secondLook[k] ?? 0) + n; };

  const shared = { ...ctx, ...buildRouteHelpers(ctx), vmetric };
  registerSecondLook(shared);
  registerNobodyMissed(shared);
  return shared;
}
