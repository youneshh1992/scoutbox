/**
 * Insight's request input: fixtures, coverage plans and assignments, search impressions, review deferrals,
 * calibration sessions and the evidence-gap acts. The schemas check shape and type; the routes keep the checks that
 * span fields (a location needs both coordinates, a currency goes with an amount) and the codes the apps already read
 * (FIXTURE_FIELDS, AMOUNT_INVALID, RATINGS_REQUIRED).
 */
import * as v from 'valibot';
import { CURSOR_PAGE, dateOnly, flag, id, inputOrRefuse, oneOf, text, wholeNumber } from '../platform/schemas.mjs';
import { CALIBRATION_CONFIDENCE, INSIGHT_LIMITS as L } from '../../repositories/insightCoverage.mjs';
import { CURRENCIES } from '../recruitment/public.mjs';

export const REVIEW_LATER_DAYS = Object.freeze({ min: 1, max: 60, default: 7 });
export const IMPRESSIONS_MAX = 50;
const ATTRIBUTE_ID_MAX = 40;

const optText = (max) => v.nullish(text(max));
const distinct = (xs) => new Set(xs).size === xs.length;
const idsOnce = (max, what) =>
  v.pipe(v.array(id), v.maxLength(max), v.check(distinct, `must not name a ${what} twice`));
const coordinate = (limit) => v.nullish(v.pipe(v.number(), v.minValue(-limit), v.maxValue(limit)));

export const INSIGHT_INPUT = Object.freeze({
  // coverage
  fixture: v.strictObject({
    home: optText(L.team),
    away: optText(L.team),
    date: v.nullish(dateOnly),
    competition: optText(L.competition),
    lat: coordinate(90),
    lng: coordinate(180),
    city: optText(L.city),
  }),
  plan: v.strictObject({
    label: optText(L.label),
    competition: optText(L.competition),
    region: optText(L.region),
    goalObservations: v.nullish(wholeNumber({ min: L.goal[0], max: L.goal[1] })),
    windowDays: v.nullish(wholeNumber({ min: L.windowDays[0], max: L.windowDays[1] })),
  }),
  assignment: v.strictObject({
    fixtureId: optText(L.id),
    scoutUserId: optText(L.id),
    targetPlayerIds: v.nullish(idsOnce(L.targets, 'player')),
    // validAmountMinor judges the amount, under AMOUNT_INVALID.
    travelBudgetMinor: v.nullish(v.number()),
    travelCurrency: v.nullish(oneOf(CURRENCIES)),
  }),
  complete: v.strictObject({ assessmentId: v.nullish(id) }),
  // exposure and review
  impressions: v.strictObject({ playerIds: v.pipe(v.array(id), v.maxLength(IMPRESSIONS_MAX)) }),
  later: v.strictObject({
    days: v.nullish(wholeNumber({ min: REVIEW_LATER_DAYS.min, max: REVIEW_LATER_DAYS.max })),
  }),
  // calibration
  calibration: v.strictObject({
    templateId: optText(L.id),
    title: optText(L.calibrationTitle),
    mediaId: v.nullish(id),
    participantUserIds: idsOnce(L.participants, 'scout'),
  }),
  // typeSubmission judges a rating's value against notObserved, and an attribute rated twice.
  submission: v.strictObject({
    ratings: v.nullish(
      v.pipe(
        v.array(
          v.strictObject({
            attrId: v.pipe(v.string(), v.minLength(1), v.maxLength(ATTRIBUTE_ID_MAX)),
            value: v.nullish(wholeNumber({ min: L.rating[0], max: L.rating[1] })),
            notObserved: v.optional(flag),
          }),
        ),
        v.maxLength(L.ratings),
      ),
    ),
    confidence: v.nullish(oneOf(CALIBRATION_CONFIDENCE)),
  }),
  note: v.strictObject({ text: optText(L.note) }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({ assignment: { travelBudgetMinor: 'AMOUNT_INVALID' } });

/** The request input read with INSIGHT_INPUT[name], or `undefined` once the 400 has been sent. */
export const insightInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, INSIGHT_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
