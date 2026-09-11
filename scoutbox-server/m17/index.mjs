// Milestone 17 registration point — Recruitment Rooms.
//
// Registered LAST, because a Room consumes every layer beneath it: M12 cases,
// assessments, evidence and trials; M13 missing evidence and transitions; M15
// the Football Passport; M16 Box Cam; M16.1 the At-Home Combine; M16.2 the
// Trust Score. It owns the club's decision layer and nothing else.
//
// Every route registers on the EXISTING authenticated `orgRouter`, so bearer
// sessions, removed users, org suspension, `visibleToOrg`, blocks and
// moderation all run before any M17 handler — a Room grants no access.
import { buildShared } from '../m12/shared.mjs';
import { metrics } from '../m13/enterprise.mjs';
import { registerRooms } from './rooms.mjs';
import {
  ROOM_STATUSES, ROOM_TRANSITIONS, PRO_STAGES, GRASSROOTS_STAGES,
  stageForRoomStatus, ALL_REASON_CODES, PROHIBITED_REASON_CODES,
} from './shared.mjs';

export function migrateM17(db) {
  // Additive only. The Room facet lives on the existing case record; these are
  // the stores nothing existing covers.
  db.roomComments ??= [];        // threaded, mentionable, editable, tombstoned
  db.roomDecisions ??= [];       // append-only decision memory with reason codes
  db.roomSnapshots ??= [];       // decision-time evidence-confidence provenance
  db.roomEvidenceState ??= [];   // the Room's private review state over evidence
  for (const c of db.recruitmentCases ?? []) c.room ??= null;
}

export function registerM17(ctx) {
  migrateM17(ctx.db);

  // Boot assertions. These are cheap and they catch the two ways this design
  // could rot silently: a room status that maps to no stage, and the M12 stage
  // vocabulary drifting away from the copy this module maps onto.
  for (const s of ROOM_STATUSES) {
    for (const level of ['pro', 'grassroots']) {
      const stage = stageForRoomStatus(s, level);
      const vocab = level === 'grassroots' ? GRASSROOTS_STAGES : PRO_STAGES;
      if (!stage || !vocab.includes(stage)) {
        throw new Error(`M17: room status "${s}" maps to "${stage}", which is not a ${level} case stage.`);
      }
    }
    if (!ROOM_TRANSITIONS[s]) throw new Error(`M17: room status "${s}" has no transition list.`);
  }
  for (const list of Object.values(ROOM_TRANSITIONS)) {
    for (const to of list) if (!ROOM_STATUSES.includes(to)) throw new Error(`M17: transition target "${to}" is not a room status.`);
  }
  // A protected characteristic must never be recordable as a recruitment reason.
  const overlap = ALL_REASON_CODES.filter((c) => PROHIBITED_REASON_CODES.includes(c));
  if (overlap.length) throw new Error(`M17: prohibited reason code(s) present in the taxonomy: ${overlap.join(', ')}`);

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
  // Counters only. No player id, no player name, no organisation name.
  const vmetric = (k, n = 1) => { metrics.rooms[k] = (metrics.rooms[k] ?? 0) + n; };

  // M12's shared helpers are the ones a Room must use — `isLead`, `orgCanSee`
  // and the append-only `audit` are reused verbatim rather than re-derived.
  const shared = { ...ctx, ...buildShared(ctx), vmetric };
  registerRooms(shared);
  return shared;
}
