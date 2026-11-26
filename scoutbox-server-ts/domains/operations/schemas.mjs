/**
 * Operations' request input: signing follow-up reports and the player's or guardian's answer, caption tracks, the
 * player's football category and the admin's due-date change. The schemas keep the codes the apps already read
 * (REGISTRATION_STATUS_INVALID, AGREE_REQUIRED, CATEGORY_INVALID, DUE_AT_REQUIRED, VTT_REQUIRED).
 */
import * as v from 'valibot';
import { CURSOR_PAGE, flag, inputOrRefuse, oneOf, text, wholeNumber } from '../platform/schemas.mjs';

export const REGISTRATION_STATUSES = ['registered', 'released', 'left', 'unknown'];
export const FOOTBALL_CATEGORIES = ['mens', 'womens', 'boys', 'girls', 'mixed'];
export const OUTCOME_LIMITS = Object.freeze({ progression: 200, endReason: 200, note: 300 });

const optText = (max) => v.nullish(text(max));

export const OPERATIONS_INPUT = Object.freeze({
  outcomeReport: v.strictObject({
    registrationStatus: oneOf(REGISTRATION_STATUSES),
    matchesPlayed: v.nullish(wholeNumber({ min: 0 })),
    progression: optText(OUTCOME_LIMITS.progression),
    endReason: optText(OUTCOME_LIMITS.endReason),
    note: optText(OUTCOME_LIMITS.note),
  }),
  outcomeAnswer: v.strictObject({
    agree: flag,
    note: optText(OUTCOME_LIMITS.note),
    experienceRating: v.nullish(wholeNumber({ min: 1, max: 5 })),
  }),
  // The route judges the track's header and its size (413 CAPTIONS_TOO_LARGE).
  captions: v.strictObject({ vtt: v.nullish(v.string()) }),
  footballCategory: v.strictObject({ category: v.nullable(oneOf(FOOTBALL_CATEGORIES)) }),
  dueAt: v.strictObject({ dueAt: wholeNumber() }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({
  outcomeReport: { registrationStatus: 'REGISTRATION_STATUS_INVALID' },
  outcomeAnswer: { agree: 'AGREE_REQUIRED' },
  footballCategory: { category: 'CATEGORY_INVALID' },
  dueAt: { dueAt: 'DUE_AT_REQUIRED' },
});

/** The request input read with OPERATIONS_INPUT[name], or `undefined` once the 400 has been sent. */
export const operationsInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, OPERATIONS_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
