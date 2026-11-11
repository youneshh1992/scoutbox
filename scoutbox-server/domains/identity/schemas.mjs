/**
 * Identity's request input: sign-up and login for players, guardians and organisations, the guardian's gates and
 * children, and the admin ID review. The schemas check shape and type; the routes keep the codes the apps already
 * read for a missing field (NAME_AND_DOB_REQUIRED, PASSWORD_REQUIRED, SCOUT_NAME_REQUIRED, …).
 */
import * as v from 'valibot';
import { CURSOR_PAGE, flag, inputOrRefuse, oneOf, text, wholeNumber } from '../platform/schemas.mjs';
import { IDENTITY_LIMITS as L, PLAYER_POSITIONS, PLAYER_FEET } from '../../repositories/identity.mjs';
import { STAFF_LIMITS } from '../../repositories/users.mjs';

export const PASSWORD_MIN = 8;
// Long enough for any pass phrase, short enough that hashing it costs nothing.
const PASSWORD_MAX = 256;
const CODE_MAX = 64;
const DOCUMENT_REF_MAX = 120;

export const CHILD_AVAILABILITY = ['available_now', 'end_of_season', 'not_seeking'];
export const ORG_PLATFORMS = ['main', 'grassroots', 'agent'];

const optText = (max) => v.nullish(text(max));
/** A field the forms may send empty: `''` is no value. */
const blankOr = (schema) => v.nullish(v.union([v.literal(''), schema]));
// A password's length is judged by the route, under PASSWORD_REQUIRED or PASSWORD_TOO_SHORT.
const password = v.nullish(text(PASSWORD_MAX));
const coordinate = (limit) => v.nullish(v.pipe(v.number(), v.minValue(-limit), v.maxValue(limit)));

/** A new player's profile, from the player's own sign-up or a guardian's account. */
const PROFILE = {
  name: optText(L.name),
  // parseDobStrict judges the day, under DOB_INVALID.
  dob: optText(10),
  country: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(L.country))),
  city: optText(L.city),
  position: blankOr(oneOf(PLAYER_POSITIONS)),
  foot: blankOr(oneOf(PLAYER_FEET)),
  heightCm: v.nullish(wholeNumber({ min: L.heightCm[0], max: L.heightCm[1] })),
  weightKg: v.nullish(wholeNumber({ min: L.weightKg[0], max: L.weightKg[1] })),
  lat: coordinate(90),
  lng: coordinate(180),
};

export const IDENTITY_INPUT = Object.freeze({
  // players
  playerSignup: v.strictObject({ ...PROFILE, password }),
  playerLogin: v.strictObject({ playerId: optText(L.id), password }),
  pair: v.strictObject({ code: optText(CODE_MAX) }),
  // guardians
  guardianSignup: v.strictObject({ name: optText(L.name), email: optText(L.email), password }),
  verifyEmail: v.strictObject({ guardianId: optText(L.id), code: optText(CODE_MAX) }),
  guardianLogin: v.strictObject({ guardianId: optText(L.id), email: optText(L.email), password }),
  verifyId: v.strictObject({ documentType: optText(60), documentRef: optText(DOCUMENT_REF_MAX) }),
  disclaimer: v.strictObject({ accepted: v.optional(flag) }),
  child: v.strictObject(PROFILE),
  coGuardian: v.strictObject({ name: optText(L.name), email: optText(L.email) }),
  childAvailability: v.strictObject({ availability: oneOf(CHILD_AVAILABILITY) }),
  medicalShare: v.strictObject({ shared: flag }),
  idReview: v.strictObject({ approved: flag }),
  // organisations
  orgsQuery: v.strictObject({ platform: v.optional(oneOf(ORG_PLATFORMS)) }),
  registerGrassroots: v.strictObject({
    name: optText(120),
    country: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2))),
    city: optText(80),
    lat: coordinate(90),
    lng: coordinate(180),
    federation: optText(120),
    registrationId: optText(60),
    scoutName: optText(STAFF_LIMITS.name),
    role: optText(STAFF_LIMITS.role),
    password,
  }),
  orgLogin: v.strictObject({
    orgId: optText(L.id),
    scoutName: optText(STAFF_LIMITS.name),
    role: optText(STAFF_LIMITS.role),
    platform: v.nullish(oneOf(ORG_PLATFORMS)),
    password,
    mfaCode: optText(CODE_MAX),
    recoveryCode: optText(CODE_MAX),
  }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

/** Codes a field keeps on a given request, where its refusal has always had one. */
const CODES_OF = Object.freeze({
  playerSignup: { dob: 'DOB_INVALID' },
  child: { dob: 'DOB_INVALID' },
  childAvailability: { availability: 'BAD_AVAILABILITY' },
  disclaimer: { accepted: 'DISCLAIMER_NOT_ACCEPTED' },
});

/** The request input read with IDENTITY_INPUT[name], or `undefined` once the 400 has been sent. */
export const identityInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, IDENTITY_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
