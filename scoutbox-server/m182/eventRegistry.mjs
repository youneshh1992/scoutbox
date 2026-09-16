/**
 * M18.2 — the canonical event registry.
 *
 * M18.1 classified every live event's AUDIENCE. That closed the leak, but an
 * audience is one fact about an event, and the rest were still implicit in
 * whichever call site happened to emit it: what the payload may carry, whether
 * two emissions of the same fact should collapse, whether the event is
 * replayed to a reconnecting client, whether it may become a notification.
 * Before M19 adds more events, every one of those facts lives here, once.
 *
 * Every field is a decision, not a description:
 *
 *   domain               which product area owns the event
 *   sourceSystem         the canonical store the event is about
 *   audience             who may receive it (M18.1 vocabulary; fails closed)
 *   privacyClass         none | subject_reference | org_internal — what the
 *                        payload could reveal, not what it happens to contain
 *   payload              the ONLY keys a payload may carry. Anything else is
 *                        stripped at broadcast time — and in development it
 *                        throws, because a new key is a new privacy decision
 *   dedupeStrategy       none | coalesce_by_subject | fingerprint — how two
 *                        emissions of the same fact are treated by consumers
 *   replayPolicy         replay | never — whether the SSE reconnect log
 *                        replays it (typing never; catalogue pings do)
 *   notificationEligible whether this event may become a person-facing
 *                        notification (most may not: they are cache pings)
 *   analyticsEligible    whether it may be counted; never with a subject id
 *
 * "public_safe" means the payload carries no personal data at all and the
 * receiver's refetch re-applies every gate. A payload that names a player is
 * routed by the subject rules in shouldDeliver BEFORE the audience default
 * applies, which is why `players` can be public_safe and still carry a
 * playerId: the id narrows delivery, it never widens it.
 */

export const AUDIENCES = [
  'player_private', 'guardian_private', 'org_private',
  'org_member', 'public_safe', 'trust_safety_only',
];
export const PRIVACY_CLASSES = ['none', 'subject_reference', 'org_internal'];
export const DEDUPE = ['none', 'coalesce_by_subject', 'fingerprint'];
export const REPLAY = ['replay', 'never'];

const ping = (domain, sourceSystem, payload = []) => ({
  domain, sourceSystem, audience: 'public_safe',
  privacyClass: payload.length ? 'subject_reference' : 'none',
  payload, dedupeStrategy: payload.length ? 'coalesce_by_subject' : 'none',
  replayPolicy: 'replay', notificationEligible: false, analyticsEligible: false,
});

export const EVENT_REGISTRY = {
  // ---- catalogue pings: "refetch this", nothing more
  players: ping('players', 'players', ['playerId']),
  orgs: ping('organisations', 'orgs'),
  opportunities: ping('recruitment', 'opportunities'),
  openTrials: ping('trials', 'openTrials'),
  campaigns: ping('campaigns', 'campaigns'),
  friendlies: ping('grassroots', 'friendlies'),
  ledger: { ...ping('discovery', 'ledger', ['playerId']), payload: ['type', 'playerId'] },

  // ---- channel traffic, resolved against the channel's own membership
  messages: {
    domain: 'messaging', sourceSystem: 'channels', audience: 'org_private',
    privacyClass: 'subject_reference', payload: ['channelId'],
    dedupeStrategy: 'none', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: false,
  },
  typing: {
    domain: 'messaging', sourceSystem: 'channels', audience: 'org_private',
    privacyClass: 'subject_reference', payload: ['channelId', 'side'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'never', notificationEligible: false, analyticsEligible: false,
  },
  inbox: {
    domain: 'messaging', sourceSystem: 'requests', audience: 'player_private',
    privacyClass: 'subject_reference', payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: false, analyticsEligible: false,
  },

  // ---- directed notification ping: the payload names its own audience
  notify: {
    domain: 'notifications', sourceSystem: 'notifications', audience: 'player_private',
    privacyClass: 'subject_reference', payload: ['audienceKind', 'audienceId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: false, analyticsEligible: false,
  },

  // ---- organisation workspaces
  requests: {
    domain: 'recruitment', sourceSystem: 'requests', audience: 'org_private',
    privacyClass: 'subject_reference', payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },
  applications: {
    domain: 'recruitment', sourceSystem: 'applications', audience: 'org_private',
    privacyClass: 'subject_reference', payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },
  feedback: {
    domain: 'assessments', sourceSystem: 'assessments', audience: 'org_private',
    privacyClass: 'subject_reference', payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: false,
  },
  evidence: {
    domain: 'evidence', sourceSystem: 'evidence', audience: 'org_private',
    privacyClass: 'subject_reference', payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },
  recruitment_room_archived: {
    domain: 'recruitment_rooms', sourceSystem: 'cases', audience: 'org_private',
    // Reduced in M18.2: the live payload used to carry status, reasonCodes,
    // revisitable, decisionAt and the snapshot's sourceRefs. No consumer of
    // the STREAM reads any of them — the client refetches, and Second Look
    // reconciles server-side from the canonical decision row. Ids only.
    privacyClass: 'org_internal', payload: ['orgId', 'roomId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },
  // ---- M23 P5 formal decision. Org-private, ids only (§80, §81): never the
  // outcome, never a reason code, never the rationale. The client refetches
  // through the authorised read; analytics reads the store, not the stream.
  room_decision_finalized: {
    domain: 'recruitment', sourceSystem: 'roomDecisions', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'decisionId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  room_decision_superseded: {
    domain: 'recruitment', sourceSystem: 'roomDecisions', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'decisionId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  recruitment_room_reopened_from_second_look: {
    // Emitted since M18, never classified until M18.2. It carried an orgId, so
    // the subject rules kept it inside the organisation — but only by luck of
    // payload shape, which is exactly what the registry exists to replace.
    domain: 'second_look', sourceSystem: 'cases', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'itemId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },

  // ---- player-owned records
  // ------------------------------------------------------------------ M19
  // A watchlist is organisation-private by construction: the player is never
  // told a club is watching them, so none of these may reach a player channel.
  watchlist_created: {
    domain: 'recruitment', sourceSystem: 'matching', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'none', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: true,
  },
  watchlist_updated: {
    domain: 'recruitment', sourceSystem: 'matching', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: true,
  },
  watchlist_membership_changed: {
    domain: 'recruitment', sourceSystem: 'matching', audience: 'org_private',
    // Ids only: which players entered or left is read from the watchlist,
    // never carried on an event that fans out to every org connection.
    privacyClass: 'org_internal', payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: true,
  },
  watchlist_archived: {
    domain: 'recruitment', sourceSystem: 'matching', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'none', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: true,
  },
  matching_room_created: {
    domain: 'recruitment', sourceSystem: 'matching', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: true,
  },
  // ------------------------------------------------------------------ M21
  // Development Hub. Every one of these is ORGANISATION-PRIVATE and carries
  // ids only, and that is a design decision rather than an accident of shape.
  //
  // An event carrying a bare playerId is delivered by shouldDeliver to every
  // organisation that can currently see that player — correct for a catalogue
  // ping, wrong for a private development plan, where it would announce to
  // every club within the wall that something happened. So M21 emits nothing
  // player-directed on the stream at all: a change the player should hear
  // about reaches them as a NOTIFICATION, which is addressed to one person and
  // passes through their preferences on the way (§44).
  //
  // A player-owned plan shared with two clubs emits one event per club. A
  // private plan emits none, because there is nobody it would be right to tell.
  development_plan_created: {
    domain: 'development', sourceSystem: 'developmentPlans', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: false,
  },
  development_plan_updated: {
    domain: 'development', sourceSystem: 'developmentPlans', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: false,
  },
  development_plan_completed: {
    domain: 'development', sourceSystem: 'developmentPlans', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: false,
  },
  development_goal_created: {
    domain: 'development', sourceSystem: 'developmentGoals', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId', 'goalId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: false,
  },
  development_goal_updated: {
    domain: 'development', sourceSystem: 'developmentGoals', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId', 'goalId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: false,
  },
  development_action_completed: {
    domain: 'development', sourceSystem: 'developmentActions', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId', 'actionId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: false,
  },
  development_evidence_linked: {
    domain: 'development', sourceSystem: 'developmentEvidenceLinks', audience: 'org_private',
    // Ids of the goal or action, never of the evidence: which Combine result
    // or assessment was cited is read back through the authorised projection.
    privacyClass: 'org_internal', payload: ['orgId', 'planId', 'goalId', 'actionId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: false,
  },
  development_review_submitted: {
    domain: 'development', sourceSystem: 'developmentReviews', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'planId', 'reviewId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: true, analyticsEligible: false,
  },

  // ------------------------------------------------------------- M23 P3
  // The Contact workflow. Every one of these is ORGANISATION-PRIVATE and
  // carries ids only. The RECIPIENT side deliberately adds no event: a send
  // creates a `db.requests` row exactly as the legacy request route does, so
  // the recipient hears through the existing `inbox` ping and `notify`, both
  // of which are addressed to one person and pass through their preferences.
  // A draft emits nothing a player could ever receive (§58, §83).
  // ---- M23 P4B Trial. All org_private, ids only (architecture §14). The
  // recipient side keeps the existing `inbox` / `notify` events; no Trial
  // event ever carries a schedule, a venue, an attendance note, an assessment
  // or a guardian id. Analytics reads none of them — counts come from the
  // store, small-n applied.
  trial_invited: {
    domain: 'recruitment', sourceSystem: 'requests', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'requestId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_accepted: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId', 'requestId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_declined: {
    domain: 'recruitment', sourceSystem: 'requests', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'requestId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_scheduled: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_rescheduled: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_cancelled: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_attendance_recorded: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId', 'sessionId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: false, analyticsEligible: false,
  },
  trial_completed: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: true, analyticsEligible: false,
  },
  trial_evidence_linked: {
    domain: 'recruitment', sourceSystem: 'trials', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'trialId', 'sessionId'],
    dedupeStrategy: 'none', replayPolicy: 'never', notificationEligible: false, analyticsEligible: false,
  },
  contact_created: {
    domain: 'recruitment', sourceSystem: 'recruitmentContacts', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none', replayPolicy: 'replay', notificationEligible: false, analyticsEligible: false,
  },
  contact_sent: {
    domain: 'recruitment', sourceSystem: 'recruitmentContacts', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },
  contact_failed: {
    domain: 'recruitment', sourceSystem: 'recruitmentContacts', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: false,
  },
  contact_external_recorded: {
    domain: 'recruitment', sourceSystem: 'recruitmentContacts', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none', replayPolicy: 'replay', notificationEligible: false, analyticsEligible: true,
  },
  contact_responded: {
    domain: 'recruitment', sourceSystem: 'recruitmentContacts', audience: 'org_private',
    privacyClass: 'org_internal', payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none', replayPolicy: 'replay', notificationEligible: true, analyticsEligible: true,
  },

  player_development_evidence_changed: {
    domain: 'box_cam', sourceSystem: 'boxSessions', audience: 'player_private',
    privacyClass: 'subject_reference', payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay', notificationEligible: false, analyticsEligible: false,
  },

  // ------------------------------------------------- M22 production CV
  //
  // Three events, all `player_private` (§72). An observation is something a
  // player did in their own home; there is no cross-organisation broadcast of
  // it, and none of these is analytics-eligible, because counting how often
  // players are observed is one step from ranking them (§137).
  //
  // §41 is enforced here as much as in the route: there is deliberately NO
  // per-frame event in this table, so a future caller cannot emit one without
  // first adding it and answering the privacy question.
  box_cam_cv_session_started: {
    domain: 'box_cam', sourceSystem: 'boxCamCv', audience: 'player_private',
    privacyClass: 'subject_reference', payload: ['playerId', 'sessionId'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: false,
  },
  box_cam_cv_refused: {
    domain: 'box_cam', sourceSystem: 'boxCamCv', audience: 'player_private',
    // The refusal REASON travels, because the player needs to know why and a
    // reason code carries no observation content.
    privacyClass: 'subject_reference', payload: ['playerId', 'sessionId', 'reason'],
    dedupeStrategy: 'fingerprint', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: false,
  },
  box_cam_observed: {
    domain: 'box_cam', sourceSystem: 'boxCamCv', audience: 'player_private',
    // Deliberately carries NO count. The event says an activity was observed;
    // it is not a channel for a measurement, and a count in a payload is a
    // count that ends up somewhere it was never gated for.
    privacyClass: 'subject_reference', payload: ['playerId', 'sessionId'],
    dedupeStrategy: 'coalesce_by_subject', replayPolicy: 'replay',
    notificationEligible: false, analyticsEligible: false,
  },
};

export const EVENT_NAMES = Object.freeze(Object.keys(EVENT_REGISTRY));

/** Audience for an event. Unknown names fail closed — the M18.1 rule, unchanged. */
export function audienceFor(event) {
  return EVENT_REGISTRY[event]?.audience ?? 'org_private';
}

export const isRegistered = (event) => Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, event);

/**
 * Reduce a payload to what the registry allows. Returns the reduced payload
 * and the keys that were dropped, so the caller can decide how loudly to
 * complain: development throws (a new key is a new privacy decision that
 * someone has to make), production strips and counts.
 */
export function minimizePayload(event, payload = {}) {
  const def = EVENT_REGISTRY[event];
  if (!def) return { payload: {}, dropped: Object.keys(payload ?? {}), unregistered: true };
  const allowed = new Set(def.payload);
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (allowed.has(k)) out[k] = v; else dropped.push(k);
  }
  return { payload: out, dropped, unregistered: false };
}

/**
 * One fingerprint rule for every consumer that dedupes. The same canonical
 * fact reaching notifications, Second Look and analytics through different
 * projectors must fingerprint identically, or it becomes four events.
 *
 *   fingerprint          type:sourceSystem:sourceId — the M18 rule
 *   coalesce_by_subject  event:subjectId — repeated pings collapse
 *   none                 every emission distinct
 */
export function eventFingerprint(event, payload = {}) {
  const def = EVENT_REGISTRY[event];
  if (!def) return null;
  switch (def.dedupeStrategy) {
    case 'fingerprint': {
      const id = payload.roomId ?? payload.itemId ?? payload.sourceId ?? payload.playerId ?? '';
      return `${event}:${def.sourceSystem}:${id}`;
    }
    case 'coalesce_by_subject': {
      const subject = payload.playerId ?? payload.channelId ?? payload.audienceId ?? payload.orgId ?? '*';
      return `${event}:${subject}`;
    }
    default:
      return null;
  }
}

/**
 * Boot assertion. Every registered event must be internally consistent, and
 * every name the server is known to emit must be registered. `emitted` is the
 * list of names the caller actually broadcasts (server.mjs passes its own).
 * Development and test throw; production returns the problems so the caller
 * can log them and keep the fail-closed default doing its job.
 */
export function assertEventRegistry({ emitted = [], mode = process.env.NODE_ENV ?? 'development' } = {}) {
  const problems = [];
  for (const [name, def] of Object.entries(EVENT_REGISTRY)) {
    if (!AUDIENCES.includes(def.audience)) problems.push(`${name}: audience "${def.audience}" is not a known audience`);
    if (!PRIVACY_CLASSES.includes(def.privacyClass)) problems.push(`${name}: privacyClass "${def.privacyClass}" unknown`);
    if (!DEDUPE.includes(def.dedupeStrategy)) problems.push(`${name}: dedupeStrategy "${def.dedupeStrategy}" unknown`);
    if (!REPLAY.includes(def.replayPolicy)) problems.push(`${name}: replayPolicy "${def.replayPolicy}" unknown`);
    if (!Array.isArray(def.payload)) problems.push(`${name}: payload allowlist missing`);
    if (def.audience === 'public_safe' && def.privacyClass === 'org_internal') problems.push(`${name}: org_internal content cannot be public_safe`);
    // A payload that names a person is never "no privacy class".
    if ((def.payload ?? []).some((k) => /playerId|guardianId|audienceId/.test(k)) && def.privacyClass === 'none') {
      problems.push(`${name}: names a subject but claims privacyClass none`);
    }
  }
  for (const name of emitted) if (!isRegistered(name)) problems.push(`emitted event "${name}" is not registered`);
  if (problems.length && mode !== 'production') {
    throw new Error(`Event registry invalid:\n  ${problems.join('\n  ')}`);
  }
  return problems;
}
