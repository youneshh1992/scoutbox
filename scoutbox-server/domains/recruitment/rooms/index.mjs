// Registered last: a Room consumes cases, assessments, evidence, trials, the Passport, Box Cam, the Combine
// and the Trust Score. Routes sit on the authenticated `orgRouter`, so a Room grants no access of its own.
import { buildRouteHelpers } from '../../platform/routeHelpers.mjs';
import { metrics } from '../../enterprise/enterprise.mjs';
import { registerRooms } from './rooms.mjs';
import {
  ROOM_STATUSES, ROOM_TRANSITIONS, PRO_STAGES, GRASSROOTS_STAGES,
  stageForRoomStatus, ALL_REASON_CODES, PROHIBITED_REASON_CODES,
} from './shared.mjs';


export function registerRecruitmentRooms(ctx) {

  // Boot assertions: every room status maps to a stage and every transition target is a status.
  for (const s of ROOM_STATUSES) {
    for (const level of ['pro', 'grassroots']) {
      const stage = stageForRoomStatus(s, level);
      const vocab = level === 'grassroots' ? GRASSROOTS_STAGES : PRO_STAGES;
      if (!stage || !vocab.includes(stage)) {
        throw new Error(`Rooms: room status "${s}" maps to "${stage}", which is not a ${level} case stage.`);
      }
    }
    if (!ROOM_TRANSITIONS[s]) throw new Error(`Rooms: room status "${s}" has no transition list.`);
  }
  for (const list of Object.values(ROOM_TRANSITIONS)) {
    for (const to of list) if (!ROOM_STATUSES.includes(to)) throw new Error(`Rooms: transition target "${to}" is not a room status.`);
  }
  const overlap = ALL_REASON_CODES.filter((c) => PROHIBITED_REASON_CODES.includes(c));
  if (overlap.length) throw new Error(`Rooms: prohibited reason code(s) present in the taxonomy: ${overlap.join(', ')}`);

  metrics.rooms = {
    recruitment_room_created: 0,
    recruitment_room_status_changed: 0,
    recruitment_room_archived: 0,
    recruitment_room_reopened: 0,
    recruitment_room_signed: 0,
    room_assessment_assigned: 0,
    room_task_created: 0,
    room_decision_recorded: 0,
    room_trial_requested: 0,
    room_combine_requested: 0,
    room_evidence_requested: 0,
    room_comment_added: 0,
  };
  // Counters only: no player or organisation identifiers.
  const vmetric = (k, n = 1) => { metrics.rooms[k] = (metrics.rooms[k] ?? 0) + n; };

  const shared = { ...ctx, ...buildRouteHelpers(ctx), vmetric };
  registerRooms(shared);
  return shared;
}
