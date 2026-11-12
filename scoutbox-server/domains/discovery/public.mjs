// What the discovery domain offers the rest of the server to import: its vocabulary, pure rules and views. Nothing here
// holds state or registers a route; the domain's services reach other domains through server.mjs, not through here.
export { CRITERION_CLASSES, CRITERION_TYPES, LIMITS as MATCH_LIMITS, criterionId } from './matching/criteria.mjs';
export {
  ENTRY_REASONS,
  EXIT_REASONS,
  WATCHLIST_MODES,
  WATCHLIST_SOURCES,
  WATCHLIST_STATUSES,
} from './matching/watchlists.mjs';
export {
  BRIEF_STATUSES,
  DISMISSAL_REASONS,
  EVIDENCE_REQUIREMENTS,
  NM_DISMISSAL_REASONS,
  NOBODY_MISSED_STATES,
  POSITIONS,
  POSITION_GROUP_OF,
  REASON_CHANGE_MAP,
  SECOND_LOOK_KINDS,
  SECOND_LOOK_STATUSES,
  TRUST_BANDS,
  briefIsLiveOn,
} from './shared.mjs';
