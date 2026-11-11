/**
 * Messaging's request input: thread messages, the notification feed, players' and guardians' quiet hours, device
 * tokens, staff delivery preferences, provider delivery callbacks and the admin's failure injection. The routes keep
 * the codes the apps already read (TEXT_REQUIRED, TOKEN_REQUIRED, TOKEN_INVALID, TIMEZONE_INVALID).
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  flag,
  inputOrRefuse,
  oneOf,
  text,
  timeOfDay,
  timeOrBlank,
  wholeNumber,
} from '../platform/schemas.mjs';
import { MESSAGE_LIMITS as L } from '../../repositories/channels.mjs';

const INJECTABLE_CHANNELS = ['email', 'push', 'contact', 'trial', 'decision'];
const CALLBACK_STATUSES = ['delivered', 'opened', 'bounced', 'failed'];
const CALLBACK_EVENTS_MAX = 100;
const PROVIDER_ID_MAX = 200;
const DEVICE_TOKEN_MAX = 200;
const ZONE_MAX = 64;

const optText = (max) => v.nullish(text(max));
const providerId = v.pipe(v.string(), v.minLength(1), v.maxLength(PROVIDER_ID_MAX));

export const MESSAGING_INPUT = Object.freeze({
  message: v.strictObject({
    text: optText(L.text),
    clientMsgId: optText(L.clientMsgId),
    attachMediaId: optText(L.id),
    attachTrialReportId: optText(L.id),
  }),
  channelsQuery: v.strictObject({
    playerId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(L.id))),
    ...CURSOR_PAGE,
  }),
  personPrefs: v.strictObject({
    quietStart: v.nullish(timeOrBlank),
    quietEnd: v.nullish(timeOrBlank),
    schoolHoursMute: v.nullish(flag),
    // validateIanaZone judges the zone, under TIMEZONE_INVALID.
    timezone: optText(ZONE_MAX),
  }),
  pushToken: v.strictObject({ token: optText(DEVICE_TOKEN_MAX) }),
  staffPrefs: v.strictObject({
    quietStart: v.nullish(timeOfDay),
    quietEnd: v.nullish(timeOfDay),
    email: v.nullish(flag),
  }),
  callback: v.strictObject({
    provider: optText(PROVIDER_ID_MAX),
    events: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            callbackId: providerId,
            providerMessageId: providerId,
            status: oneOf(CALLBACK_STATUSES),
            at: v.nullish(wholeNumber({ min: 1 })),
            reason: optText(),
          }),
        ),
        v.maxLength(CALLBACK_EVENTS_MAX),
      ),
    ),
  }),
  injectFailure: v.strictObject({
    channel: v.nullish(oneOf(INJECTABLE_CHANNELS)),
    count: v.nullish(wholeNumber({ min: 1, max: 20 })),
  }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({
  pushToken: { token: 'TOKEN_INVALID' },
  // Staff quiet hours have always been refused as FIELD_INVALID; players' and guardians' as TIME_INVALID.
  staffPrefs: { quietStart: 'FIELD_INVALID', quietEnd: 'FIELD_INVALID' },
});

/** The request input read with MESSAGING_INPUT[name], or `undefined` once the 400 has been sent. */
export const messagingInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, MESSAGING_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
