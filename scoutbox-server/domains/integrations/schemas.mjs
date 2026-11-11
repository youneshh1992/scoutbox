/**
 * Integrations' request input: CSV prospect imports and their commit, identity reviews, API keys and webhook
 * endpoints. The schemas check shape and type; the routes judge the CSV itself (rows, columns, the columns a mapping
 * names) and the webhook URL, and keep the codes the apps already read (CONFIRM_REQUIRED, BAD_ACTION,
 * SCOPES_REQUIRED, EVENTS_REQUIRED, WEBHOOK_URL_REJECTED).
 */
import * as v from 'valibot';
import { CURSOR_PAGE, flag, inputOrRefuse, oneOf, text } from '../platform/schemas.mjs';
import {
  API_SCOPES,
  INTEGRATIONS_LIMITS as L,
  PROSPECT_FIELDS,
  WEBHOOK_EVENTS,
} from '../../repositories/integrations.mjs';

export const IDENTITY_ACTIONS = ['link', 'separate'];

const distinct = (xs) => new Set(xs).size === xs.length;
const onceEach = (values, what) =>
  v.nullish(v.pipe(v.array(oneOf(values)), v.check(distinct, `must not name ${what} twice`)));

export const INTEGRATIONS_INPUT = Object.freeze({
  importBatch: v.strictObject({
    csv: v.nullish(v.string()),
    // Column name → prospect field, or null to leave the column out.
    mapping: v.nullish(v.record(v.string(), v.nullable(oneOf(PROSPECT_FIELDS)))),
  }),
  commit: v.strictObject({ confirm: v.nullish(flag) }),
  identityResolve: v.strictObject({ action: v.nullish(oneOf(IDENTITY_ACTIONS)) }),
  apiKey: v.strictObject({ scopes: onceEach(API_SCOPES, 'a scope'), label: v.nullish(text(L.label)) }),
  webhook: v.strictObject({ url: v.nullish(text(L.url)), events: onceEach(WEBHOOK_EVENTS, 'an event') }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({
  commit: { confirm: 'CONFIRM_REQUIRED' },
  identityResolve: { action: 'BAD_ACTION' },
});

/** The request input read with INTEGRATIONS_INPUT[name], or `undefined` once the 400 has been sent. */
export const integrationsInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, INTEGRATIONS_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
