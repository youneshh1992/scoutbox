/**
 * A view over `eventRegistry.mjs`. Unknown events fail closed to org_private.
 *
 *   player_private      only the subject player (and their guardian)
 *   guardian_private    only the guardian
 *   org_private         only the organisation named in the payload
 *   org_member          any organisation that may currently see the subject
 *   public_safe         any authenticated identity; carries no personal data
 *   trust_safety_only   Trust & Safety only
 */
import {
  EVENT_REGISTRY,
  AUDIENCES as REGISTRY_AUDIENCES,
  audienceFor as registryAudienceFor,
} from './eventRegistry.mjs';

export const AUDIENCES = REGISTRY_AUDIENCES;

export const EVENT_AUDIENCE = Object.freeze(
  Object.fromEntries(Object.entries(EVENT_REGISTRY).map(([name, def]) => [name, def.audience])),
);

export const audienceFor = registryAudienceFor;

/** For the boot assertion. */
export const unclassifiedEvents = (names) => names.filter((n) => !(n in EVENT_REGISTRY));
