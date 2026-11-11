/**
 * The Development Hub's request input. The schemas check shape and type; the Hub's own validators
 * (validatePlanBody and the rest in index.mjs, validateTarget, canAssign, validateEvidenceLink, validateReview) still
 * judge meaning and keep the codes the apps read: TITLE_REQUIRED, TEXT_TOO_LONG, PLAN_VISIBILITY_INVALID,
 * TEMPLATE_UNKNOWN, the TARGET_* codes, ASSIGNEE_INVALID, EVIDENCE_ID_REQUIRED, REVIEW_EMPTY. A field with a
 * vocabulary is refused under the code the Hub already used for it.
 *
 * Fields the Hub derives (refusedClientFields) are refused as CLIENT_CANNOT_ASSERT before these schemas run.
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  REV_FIELDS,
  REV_FIELD_CODES,
  dueDate,
  flag,
  id,
  inputOrRefuse,
  oneOf,
  text,
  wholeNumber,
  wholeNumberText,
  ID_MAX,
} from '../../platform/schemas.mjs';
import {
  ACTION_STATUSES,
  ACTION_TYPES,
  BLOCK_REASONS,
  DEVELOPMENT_HUB_LIMITS as L,
  EVIDENCE_SOURCES,
  GOAL_CATEGORIES,
  GOAL_STATUSES,
  PLAN_STATUSES,
  SHARE_SCOPES,
} from './shared.mjs';

// Lengths are judged by boundedText after trimming, which answers TEXT_TOO_LONG with the limit.
const words = v.nullish(v.string());
const optId = v.nullish(text(ID_MAX));

// validateTarget judges each part against the Combine protocols and answers with its TARGET_* codes.
const target = v.strictObject({
  sourceType: v.optional(v.string()),
  protocolId: v.optional(v.string()),
  protocolVersion: v.nullish(wholeNumber({ min: 1 })),
  metricType: v.nullish(v.string()),
  operator: v.optional(v.string()),
  value: v.optional(v.number()),
});

const goalFields = {
  title: words,
  description: words,
  category: v.nullish(oneOf(GOAL_CATEGORIES)),
  targetDate: v.optional(dueDate),
  target: v.nullish(target),
};
const goalCreate = v.strictObject({ ...goalFields, originObjectiveId: optId });

const planFields = {
  title: words,
  visibility: v.nullish(v.string()),
  startDate: v.optional(dueDate),
  nextReviewAt: v.optional(dueDate),
  endDate: v.optional(dueDate),
  templateId: optId,
};
const planCreateFields = {
  ...planFields,
  status: v.optional(oneOf(['draft', 'active'])),
  goals: v.optional(v.array(goalCreate)),
  originObjectiveId: optId,
};

const actionFields = {
  title: words,
  type: v.nullish(oneOf(ACTION_TYPES)),
  dueAt: v.optional(dueDate),
  // canAssign judges who may be assigned, as ASSIGNEE_INVALID.
  assignee: v.nullish(v.strictObject({ kind: v.optional(v.string()), id: v.optional(v.string()) })),
};

const scopes = v.optional(v.array(oneOf(SHARE_SCOPES)));
const listedPage = (max) =>
  v.strictObject({ limit: v.optional(wholeNumberText({ min: 1, max })), cursor: v.optional(text(ID_MAX)) });

export const HUB_INPUT = Object.freeze({
  // A player creates plans for themselves; a guardian or a club names the player.
  planCreateSelf: v.strictObject(planCreateFields),
  planCreateFor: v.strictObject({ ...planCreateFields, playerId: v.optional(v.string()) }),
  planEdit: v.strictObject({ ...planFields, ...REV_FIELDS }),
  planStatus: v.strictObject({ status: oneOf(PLAN_STATUSES), ...REV_FIELDS }),
  planShare: v.strictObject({ orgId: text(ID_MAX), revoke: v.optional(flag) }),
  goalCreate,
  goalEdit: v.strictObject({
    ...goalFields,
    status: v.nullish(oneOf(GOAL_STATUSES)),
    blockReason: v.nullish(oneOf(BLOCK_REASONS)),
    blockNote: words,
    ...REV_FIELDS,
  }),
  actionCreate: v.strictObject(actionFields),
  actionEdit: v.strictObject({ ...actionFields, status: v.nullish(oneOf(ACTION_STATUSES)) }),
  evidenceLink: v.strictObject({
    sourceType: v.optional(oneOf(EVIDENCE_SOURCES)),
    sourceId: v.nullish(text(ID_MAX)),
  }),
  review: v.strictObject({
    summary: words,
    internalNote: words,
    nextReviewAt: v.optional(dueDate),
    shareWithPlayer: v.optional(flag),
    shareScopes: scopes,
    supersedes: v.nullish(id),
  }),
  reviewShare: v.strictObject({ scopes }),
  linkableQuery: v.strictObject({ playerId: v.optional(text(ID_MAX)) }),
  plansQuery: v.strictObject({ ...CURSOR_PAGE, status: v.optional(oneOf(PLAN_STATUSES)), playerId: optId }),
  reviewsQuery: listedPage(L.reviewsPageMax),
  historyQuery: listedPage(L.historyPageMax),
});

const PAGE_CODES = { limit: 'PAGE_LIMIT_INVALID' };
const GOAL_CODES = {
  category: 'GOAL_CATEGORY_UNKNOWN',
  target: 'TARGET_MALFORMED',
  'target.*': 'TARGET_MALFORMED',
};
const ACTION_CODES = { type: 'ACTION_TYPE_UNKNOWN', assignee: 'ASSIGNEE_INVALID', 'assignee.*': 'ASSIGNEE_INVALID' };
const PLAN_CREATE_CODES = {
  status: 'PLAN_STATUS_UNKNOWN',
  'goals.category': 'GOAL_CATEGORY_UNKNOWN',
  'goals.target': 'TARGET_MALFORMED',
  'goals.target.*': 'TARGET_MALFORMED',
};
const CODES_OF = Object.freeze({
  planCreateSelf: PLAN_CREATE_CODES,
  planCreateFor: PLAN_CREATE_CODES,
  planEdit: REV_FIELD_CODES,
  planStatus: { status: 'PLAN_STATUS_UNKNOWN', ...REV_FIELD_CODES },
  goalCreate: GOAL_CODES,
  goalEdit: {
    ...GOAL_CODES,
    status: 'GOAL_STATUS_UNKNOWN',
    blockReason: 'BLOCK_REASON_UNKNOWN',
    ...REV_FIELD_CODES,
  },
  actionCreate: ACTION_CODES,
  actionEdit: { ...ACTION_CODES, status: 'ACTION_STATUS_UNKNOWN' },
  evidenceLink: { sourceType: 'EVIDENCE_SOURCE_UNKNOWN' },
  review: { shareScopes: 'SHARE_SCOPE_UNKNOWN' },
  reviewShare: { scopes: 'SHARE_SCOPE_UNKNOWN' },
  plansQuery: { status: 'PLAN_STATUS_UNKNOWN', limit: 'PAGE_LIMIT_INVALID' },
  reviewsQuery: PAGE_CODES,
  historyQuery: PAGE_CODES,
});

/** The request input read with HUB_INPUT[name], or `undefined` once the 400 has been sent. */
export const hubInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, HUB_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
