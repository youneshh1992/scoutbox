/**
 * M18.1 — explicit event audiences.
 *
 * Delivery used to be inferred entirely from the shape of the payload: an event
 * carrying `orgId` was organisation-private, one carrying `playerId` went to
 * that player and to clubs that could see them, and anything with neither fell
 * through to `return true` — delivered to every connected identity, player and
 * rival club included.
 *
 * Today's unclassified events are harmless cache pings, so nothing has leaked.
 * But "safe because of what we happen to put in the payload" is not a privacy
 * model: the next event with a new shape inherits broadcast-to-everyone as its
 * default. M17 already shipped one leak of exactly this kind (the archive event
 * reached the subject player's stream), which is why this file exists.
 *
 * So every event name is classified here, and anything unknown FAILS CLOSED.
 *
 *   player_private      only the subject player (and their guardian)
 *   guardian_private    only the guardian
 *   org_private         only the organisation named in the payload
 *   org_member          any organisation that may currently see the subject
 *   public_safe         any authenticated identity; carries no personal data
 *   trust_safety_only   Trust & Safety only
 */

export const AUDIENCES = [
  'player_private', 'guardian_private', 'org_private',
  'org_member', 'public_safe', 'trust_safety_only',
];

/**
 * The classification table. The value is the audience; the comment is why.
 *
 * A "catalogue ping" is an event whose payload is a bare signal to refetch
 * something the receiver is already authorised to read. It carries no personal
 * data at all, and the authorised read on the other side re-applies every gate.
 */
export const EVENT_AUDIENCE = {
  // Catalogue pings — no personal data in the payload; the refetch is gated.
  players: 'public_safe',
  orgs: 'public_safe',
  opportunities: 'public_safe',
  openTrials: 'public_safe',
  campaigns: 'public_safe',
  friendlies: 'public_safe',
  ledger: 'public_safe',

  // Channel traffic — resolved against the channel's own membership.
  messages: 'org_private',
  typing: 'org_private',
  inbox: 'player_private',

  // Directed notifications — the payload names its own audience.
  notify: 'player_private',

  // Organisation workspaces.
  requests: 'org_private',
  applications: 'org_private',
  feedback: 'org_private',
  evidence: 'org_private',
  recruitment_room_archived: 'org_private',

  // Player-owned records.
  player_development_evidence_changed: 'player_private',
};

/**
 * Classify an event. Unknown names are org_private — the most restrictive
 * useful default — rather than "everyone". A new event is therefore invisible
 * until someone classifies it, which is the failure we want: something not
 * appearing is a bug report, something leaking is an incident.
 */
export function audienceFor(event) {
  return EVENT_AUDIENCE[event] ?? 'org_private';
}

/** Names an event carrying no classification, for the boot assertion. */
export const unclassifiedEvents = (names) => names.filter((n) => !(n in EVENT_AUDIENCE));
