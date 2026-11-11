/**
 * Discovery's request input: matching, watchlists, briefs, Nobody Missed, Second Look, club search, saved searches
 * and the Film Room. The schemas check shape and type; the criteria and brief validators (matching/criteria.mjs,
 * shared.mjs) still judge the vocabularies and ranges, under the codes and `details` their refusals have always had.
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  REV_FIELDS,
  REV_FIELD_CODES,
  dayOrBlank,
  declaredCodes,
  flag,
  id,
  inputOrRefuse,
  oneOf,
  text,
  wholeNumber,
  wholeNumberText,
} from '../platform/schemas.mjs';
import { PAGE_LIMITS } from '../platform/paging.mjs';
import { LIMITS as MATCHING_LIMITS } from './matching/criteria.mjs';
import { WATCHLIST_MODES, WATCHLIST_SOURCES, WATCHLIST_STATUSES } from './matching/watchlists.mjs';
import {
  DISMISSAL_REASONS,
  LIMITS,
  NM_DISMISSAL_REASONS,
  NM_SORTS,
  POSITIONS,
  SECOND_LOOK_STATUSES,
  EVIDENCE_REQUIREMENTS,
} from './shared.mjs';
import { SAVED_SEARCH_FILTERS, OPERATIONS_LIMITS } from '../../repositories/operations.mjs';
import { AUDIT_LIMITS } from '../../repositories/safetyAudit.mjs';

/** None of these is a match quality rank; the default is the least suggestive one that is still useful. */
export const MATCH_SORTS = ['recent_evidence', 'name', 'age', 'evidence_confidence', 'distance'];
export const DEFAULT_MATCH_SORT = 'recent_evidence';

export const BRIEF_TITLE_MAX = 120;
export const BRIEF_AVAILABILITY_MAX = 40;
const REF_MAX = 64;
const REASON_CODES_MAX = 20;
const PROTOCOLS_MAX = 50;

const optText = (max) => v.nullish(text(max));
const scalar = v.nullish(v.union([v.string(), v.number()]));
const list = (max, item = v.string()) => v.nullish(v.pipe(v.array(item), v.maxLength(max)));
const distinct = (xs) => new Set(xs).size === xs.length;

/**
 * One criterion as the editor writes it. The fields a type does not use are absent; the type, operator and values are
 * judged by validateCriteria, which names the criterion it refuses.
 */
const Criterion = v.strictObject({
  type: v.string(),
  operator: v.nullish(v.string()),
  value: scalar,
  values: list(MATCHING_LIMITS.maxPositions, v.union([v.string(), v.number()])),
  primaryOnly: v.nullish(flag),
  evidenceKind: v.nullish(v.string()),
  protocol: v.nullish(v.string()),
});
// validateCriteria counts them, refusing too many as CRITERIA_TOO_MANY.
const Criteria = v.strictObject({
  required: v.nullish(v.array(Criterion)),
  preferred: v.nullish(v.array(Criterion)),
});

// readMatchPage reads these: a body carries the limit as a number, a query as text. An offset is refused there.
const MATCH_PAGE_BODY = {
  limit: v.nullish(wholeNumber({ min: 1, max: PAGE_LIMITS.max })),
  cursor: v.nullish(v.string()),
  offset: v.optional(v.unknown()),
};
const MATCH_PAGE_QUERY = { ...CURSOR_PAGE, offset: v.optional(v.unknown()) };

/** `?limit=&offset=` for the short lists Discovery pages by position. */
const OFFSET_QUERY = {
  limit: v.optional(wholeNumberText({ min: 1, max: LIMITS.maxPageSize })),
  offset: v.optional(wholeNumberText()),
};

/** The brief's own fields. Prohibited fields are refused before this schema reads the body (briefProhibited). */
const BRIEF_FIELDS = {
  title: optText(BRIEF_TITLE_MAX),
  positions: list(POSITIONS.length),
  minAge: v.nullish(v.number()),
  maxAge: v.nullish(v.number()),
  radiusKm: v.nullish(v.number()),
  maxLevel: v.nullish(v.string()),
  foot: v.nullish(v.string()),
  availability: optText(BRIEF_AVAILABILITY_MAX),
  evidenceRequirements: list(EVIDENCE_REQUIREMENTS.length),
  minTrustBand: v.nullish(v.string()),
  combineProtocols: list(PROTOCOLS_MAX),
  activeFrom: v.nullish(dayOrBlank),
  activeUntil: v.nullish(dayOrBlank),
};
export const BRIEF_CRITERIA_KEYS = Object.freeze(Object.keys(BRIEF_FIELDS));

const BriefAndPlayer = { briefId: v.nullish(text(REF_MAX)), playerId: v.nullish(text(REF_MAX)) };

const S = OPERATIONS_LIMITS;

export const DISCOVERY_INPUT = Object.freeze({
  // matching
  match: v.strictObject({
    briefId: v.nullish(id),
    criteria: v.optional(Criteria),
    sort: v.nullish(oneOf(MATCH_SORTS)),
    ...MATCH_PAGE_BODY,
  }),
  // watchlists
  watchlistsQuery: v.strictObject({ status: v.optional(oneOf(WATCHLIST_STATUSES)), ...CURSOR_PAGE }),
  newWatchlist: v.strictObject({
    name: optText(MATCHING_LIMITS.maxNameLength),
    mode: v.nullish(oneOf(WATCHLIST_MODES)),
    sourceType: v.nullish(oneOf(WATCHLIST_SOURCES)),
    sourceId: optText(REF_MAX),
    briefId: v.nullish(id),
    criteria: v.optional(Criteria),
    notify: v.nullish(flag),
  }),
  watchlistQuery: v.strictObject({ sort: v.optional(oneOf(MATCH_SORTS)), ...MATCH_PAGE_QUERY }),
  watchlistEdit: v.strictObject({
    name: v.optional(text(MATCHING_LIMITS.maxNameLength)),
    status: v.optional(oneOf(WATCHLIST_STATUSES)),
    mode: v.optional(oneOf(WATCHLIST_MODES)),
    notify: v.optional(flag),
    criteria: v.optional(Criteria),
    ...REV_FIELDS,
  }),
  historyQuery: v.strictObject({ ...CURSOR_PAGE }),
  watchlistRoom: v.strictObject({ playerId: v.nullish(text(REF_MAX)) }),
  // briefs
  briefsQuery: v.strictObject({ ...OFFSET_QUERY }),
  newBrief: v.strictObject({ ...BRIEF_FIELDS, roleId: optText(REF_MAX), vacancyId: optText(REF_MAX) }),
  briefEdit: v.strictObject({ ...BRIEF_FIELDS, status: v.optional(v.string()), ...REV_FIELDS }),
  // Nobody Missed
  nobodyMissedQuery: v.strictObject({
    briefId: v.optional(text(REF_MAX)),
    sort: v.optional(oneOf(NM_SORTS)),
    ...MATCH_PAGE_QUERY,
  }),
  nmReview: v.strictObject(BriefAndPlayer),
  nmDismiss: v.strictObject({ ...BriefAndPlayer, reason: v.nullish(oneOf(NM_DISMISSAL_REASONS)) }),
  // Second Look
  secondLookQuery: v.strictObject({ status: v.optional(oneOf([...SECOND_LOOK_STATUSES, 'all'])), ...OFFSET_QUERY }),
  secondLookDismiss: v.strictObject({ reason: v.nullish(oneOf(DISMISSAL_REASONS)) }),
  secondLookReopen: v.strictObject({ reasonCodes: list(REASON_CODES_MAX) }),
  // club search
  directoryQuery: v.strictObject({
    q: v.optional(text(S.searchQ)),
    position: v.optional(text(REF_MAX)),
    availability: v.optional(text(REF_MAX)),
    country: v.optional(text(S.country)),
    academyPlus: v.optional(oneOf(['true', 'false', ''])),
    ageGroup: v.optional(oneOf(['u16', 'u18', '18-21', 'senior', ''])),
    newDays: v.optional(v.union([v.literal(''), wholeNumberText({ min: 1, max: 99999 })])),
    ...CURSOR_PAGE,
  }),
  note: v.strictObject({ text: optText(AUDIT_LIMITS.note) }),
  savedSearch: v.strictObject({
    name: optText(S.searchName),
    // Each filter's value is judged by readSearchFilters, which reads false, null and blank as "no filter".
    filters: v.nullish(
      v.strictObject(Object.fromEntries(SAVED_SEARCH_FILTERS.map((k) => [k, v.optional(v.unknown())]))),
    ),
  }),
  // Film Room
  tags: v.strictObject({
    tags: v.nullish(v.pipe(v.array(v.string()), v.check(distinct, 'must not name a tag twice'))),
  }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const FIELD_CODES = Object.freeze({
  limit: 'PAGE_LIMIT_INVALID',
  ...REV_FIELD_CODES,
});

/** Codes a field keeps on a given request, where its refusal has always had one. */
const CODES_OF = Object.freeze({
  watchlistsQuery: { status: 'WATCHLIST_STATUS_UNKNOWN' },
  newWatchlist: { mode: 'WATCHLIST_MODE_REQUIRED', sourceType: 'WATCHLIST_SOURCE_UNKNOWN' },
  watchlistEdit: { status: 'WATCHLIST_STATUS_UNKNOWN', mode: 'WATCHLIST_MODE_UNKNOWN' },
  nmDismiss: { reason: 'NM_REASON_UNKNOWN' },
  secondLookDismiss: { reason: 'SECOND_LOOK_REASON_UNKNOWN' },
});

const parseOptions = (name, root) => ({
  root,
  fieldCodes: { ...declaredCodes(DISCOVERY_INPUT[name], FIELD_CODES), ...CODES_OF[name] },
});

/** The request input read with DISCOVERY_INPUT[name], or `undefined` once the 400 has been sent. */
export const discoveryInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, DISCOVERY_INPUT[name], input ?? {}, parseOptions(name, root));
