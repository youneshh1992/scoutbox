/**
 * M18.1 — explicit event audiences.
 *
 * Since M18.2 the audience table is a VIEW over the canonical event registry
 * (`m182/eventRegistry.mjs`), which also carries payload allowlists, dedupe
 * and replay semantics. This module keeps the M18.1 names so nothing that
 * imported them changes, and so the M18.1 suite keeps asserting the rule it
 * was written for: every event name is classified, and anything unknown
 * FAILS CLOSED to org_private.
 *
 *   player_private      only the subject player (and their guardian)
 *   guardian_private    only the guardian
 *   org_private         only the organisation named in the payload
 *   org_member          any organisation that may currently see the subject
 *   public_safe         any authenticated identity; carries no personal data
 *   trust_safety_only   Trust & Safety only
 */
import { EVENT_REGISTRY, AUDIENCES as REGISTRY_AUDIENCES, audienceFor as registryAudienceFor } from '../m182/eventRegistry.mjs';

export const AUDIENCES = REGISTRY_AUDIENCES;

/** event name → audience, derived from the registry. */
export const EVENT_AUDIENCE = Object.freeze(
  Object.fromEntries(Object.entries(EVENT_REGISTRY).map(([name, def]) => [name, def.audience])),
);

/** Unknown names are org_private — the most restrictive useful default. */
export const audienceFor = registryAudienceFor;

/** Names an event carrying no classification, for the boot assertion. */
export const unclassifiedEvents = (names) => names.filter((n) => !(n in EVENT_REGISTRY));
