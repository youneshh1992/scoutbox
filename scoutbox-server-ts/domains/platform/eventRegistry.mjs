/**
 * Live event registry.
 *
 *   audience             who may receive it (unknown events fail closed)
 *   privacyClass         what the payload could reveal, not what it happens to contain
 *   payload              the only keys allowed: others are stripped at broadcast, and
 *                        throw in development, since a new key is a privacy decision
 *   dedupeStrategy       how consumers treat two emissions of the same fact
 *   replayPolicy         whether the SSE reconnect log replays it
 *   notificationEligible whether it may become a person-facing notification
 *   analyticsEligible    whether it may be counted; never with a subject id
 *
 * `public_safe` payloads carry no personal data and the refetch re-applies
 * every gate. A payload naming a player is routed by the subject rules in
 * shouldDeliver first, so `players` can be public_safe and carry a playerId:
 * the id only narrows delivery.
 */

export const AUDIENCES = [
  'player_private',
  'guardian_private',
  'org_private',
  'org_member',
  'public_safe',
  'trust_safety_only',
];
export const PRIVACY_CLASSES = ['none', 'subject_reference', 'org_internal'];
export const DEDUPE = ['none', 'coalesce_by_subject', 'fingerprint'];
export const REPLAY = ['replay', 'never'];

const ping = (domain, sourceSystem, payload = []) => ({
  domain,
  sourceSystem,
  audience: 'public_safe',
  privacyClass: payload.length ? 'subject_reference' : 'none',
  payload,
  dedupeStrategy: payload.length ? 'coalesce_by_subject' : 'none',
  replayPolicy: 'replay',
  notificationEligible: false,
  analyticsEligible: false,
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
    domain: 'messaging',
    sourceSystem: 'channels',
    audience: 'org_private',
    privacyClass: 'subject_reference',
    payload: ['channelId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  typing: {
    domain: 'messaging',
    sourceSystem: 'channels',
    audience: 'org_private',
    privacyClass: 'subject_reference',
    payload: ['channelId', 'side'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'never',
    notificationEligible: false,
    analyticsEligible: false,
  },
  inbox: {
    domain: 'messaging',
    sourceSystem: 'requests',
    audience: 'player_private',
    privacyClass: 'subject_reference',
    payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },

  // ---- directed notification ping: the payload names its own audience
  notify: {
    domain: 'notifications',
    sourceSystem: 'notifications',
    audience: 'player_private',
    privacyClass: 'subject_reference',
    payload: ['audienceKind', 'audienceId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },

  // ---- organisation workspaces
  requests: {
    domain: 'recruitment',
    sourceSystem: 'requests',
    audience: 'org_private',
    privacyClass: 'subject_reference',
    payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  applications: {
    domain: 'recruitment',
    sourceSystem: 'applications',
    audience: 'org_private',
    privacyClass: 'subject_reference',
    payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  feedback: {
    domain: 'assessments',
    sourceSystem: 'assessments',
    audience: 'org_private',
    privacyClass: 'subject_reference',
    payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  evidence: {
    domain: 'evidence',
    sourceSystem: 'evidence',
    audience: 'org_private',
    privacyClass: 'subject_reference',
    payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  recruitment_room_archived: {
    domain: 'recruitment_rooms',
    sourceSystem: 'cases',
    audience: 'org_private',
    // Ids only: Second Look reconciles from the decision row server-side.
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  // The subject is not named, so nothing about the evaluation reaches the player's or a rival club's stream.
  assessment_submitted: {
    domain: 'assessments',
    sourceSystem: 'assessments',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'assessmentId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  // Ids and the two status words only: no reason code, note or actor.
  recruitment_case_moved: {
    domain: 'recruitment_rooms',
    sourceSystem: 'cases',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'from', 'to'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  // Decision events carry ids only, never the outcome, reason or rationale.
  room_decision_finalized: {
    domain: 'recruitment',
    sourceSystem: 'roomDecisions',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'decisionId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  room_decision_superseded: {
    domain: 'recruitment',
    sourceSystem: 'roomDecisions',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'decisionId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  // Ids only, like the decision events: the internal decision is not exposed.
  transaction_handoff_invited: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentCases',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'handoffId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  transaction_handoff_withdrawn: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentCases',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'handoffId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  recruitment_room_reopened_from_second_look: {
    domain: 'second_look',
    sourceSystem: 'cases',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'itemId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },

  // ---- watchlists and matching
  // The player is never told a club is watching them, so none of these may reach a player channel.
  watchlist_created: {
    domain: 'recruitment',
    sourceSystem: 'matching',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: true,
  },
  watchlist_updated: {
    domain: 'recruitment',
    sourceSystem: 'matching',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: true,
  },
  watchlist_membership_changed: {
    domain: 'recruitment',
    sourceSystem: 'matching',
    audience: 'org_private',
    // Which players entered or left is read from the watchlist, not carried here.
    privacyClass: 'org_internal',
    payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  watchlist_archived: {
    domain: 'recruitment',
    sourceSystem: 'matching',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'watchlistId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: true,
  },
  matching_room_created: {
    domain: 'recruitment',
    sourceSystem: 'matching',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: true,
  },
  // ---- Development Hub. Org-private with an orgId, never a bare playerId: shouldDeliver would send that to
  // every club that can see the player, announcing a private plan. Players hear by notification instead. A plan
  // shared with two clubs emits one event per club; a private plan emits none.
  development_plan_created: {
    domain: 'development',
    sourceSystem: 'developmentPlans',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  development_plan_updated: {
    domain: 'development',
    sourceSystem: 'developmentPlans',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  development_plan_completed: {
    domain: 'development',
    sourceSystem: 'developmentPlans',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  development_goal_created: {
    domain: 'development',
    sourceSystem: 'developmentGoals',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId', 'goalId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  development_goal_updated: {
    domain: 'development',
    sourceSystem: 'developmentGoals',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId', 'goalId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  development_action_completed: {
    domain: 'development',
    sourceSystem: 'developmentActions',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId', 'actionId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  development_evidence_linked: {
    domain: 'development',
    sourceSystem: 'developmentEvidenceLinks',
    audience: 'org_private',
    // Never the evidence id: what was cited is read through the authorised projection.
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId', 'goalId', 'actionId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  development_review_submitted: {
    domain: 'development',
    sourceSystem: 'developmentReviews',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'planId', 'reviewId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },

  // ---- Trial. Ids only: no schedule, venue, attendance note, assessment or guardian id. The recipient hears
  // through `inbox` / `notify`.
  trial_invited: {
    domain: 'recruitment',
    sourceSystem: 'requests',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'requestId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_accepted: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId', 'requestId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_declined: {
    domain: 'recruitment',
    sourceSystem: 'requests',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'requestId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_scheduled: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_rescheduled: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_cancelled: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_attendance_recorded: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId', 'sessionId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: false,
    analyticsEligible: false,
  },
  trial_completed: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  },
  trial_evidence_linked: {
    domain: 'recruitment',
    sourceSystem: 'trials',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'trialId', 'sessionId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: false,
    analyticsEligible: false,
  },
  // ---- Contact workflow. Ids only. A send creates a request, so the recipient hears through `inbox` and
  // `notify`; there is no recipient-side contact event.
  contact_created: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentContacts',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  contact_sent: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentContacts',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  contact_failed: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentContacts',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },
  contact_external_recorded: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentContacts',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: true,
  },
  contact_responded: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentContacts',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'contactId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  // ---- Offers. Ids only: no term, expiry, note, recipient or reason. `status` on `offer_responded` is the
  // new status word alone. The recipient and a shared agent hear by notification.
  offer_draft_created: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentOffers',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'offerId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  offer_draft_updated: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentOffers',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'offerId'],
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: false,
    analyticsEligible: false,
  },
  offer_issued: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentOffers',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'offerId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  offer_superseded: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentOffers',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'offerId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  offer_withdrawn: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentOffers',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'offerId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  offer_responded: {
    domain: 'recruitment',
    sourceSystem: 'recruitmentOffers',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'offerId', 'status'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  // ---- Signing. Ids, plus a party type word on `signing_party_completed`; never a term, document, fee or
  // signatory's identity.
  signing_created: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId', 'offerId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: true,
  },
  signing_ready: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId', 'revisionId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  signing_party_completed: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId', 'revisionId', 'partyType'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  signing_completed: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId', 'signingId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  signing_cancelled: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  signing_voided: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: true,
  },
  signing_superseded: {
    domain: 'recruitment',
    sourceSystem: 'signingPackages',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload: ['orgId', 'roomId', 'signingPackageId', 'revisionId', 'supersedes'],
    dedupeStrategy: 'none',
    replayPolicy: 'replay',
    notificationEligible: true,
    analyticsEligible: false,
  },

  player_development_evidence_changed: {
    domain: 'box_cam',
    sourceSystem: 'boxSessions',
    audience: 'player_private',
    privacyClass: 'subject_reference',
    payload: ['playerId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },

  // ---- Box Cam computer vision. An observation is something a player did at home, so these stay
  // player-private and are not analytics-eligible: counting observations is one step from ranking players.
  // There is no per-frame event.
  box_cam_cv_session_started: {
    domain: 'box_cam',
    sourceSystem: 'boxCamCv',
    audience: 'player_private',
    privacyClass: 'subject_reference',
    payload: ['playerId', 'sessionId'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  box_cam_cv_refused: {
    domain: 'box_cam',
    sourceSystem: 'boxCamCv',
    audience: 'player_private',
    // A reason code carries no observation content, and the player needs to know why.
    privacyClass: 'subject_reference',
    payload: ['playerId', 'sessionId', 'reason'],
    dedupeStrategy: 'fingerprint',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
  box_cam_observed: {
    domain: 'box_cam',
    sourceSystem: 'boxCamCv',
    audience: 'player_private',
    // No count: a measurement in a payload ends up somewhere it was never gated for.
    privacyClass: 'subject_reference',
    payload: ['playerId', 'sessionId'],
    dedupeStrategy: 'coalesce_by_subject',
    replayPolicy: 'replay',
    notificationEligible: false,
    analyticsEligible: false,
  },
};

// ---- Agent core. Org-private to the agency, ids only: no licence reference, dispute reason or client name.
for (const [name, payload] of [
  ['agent_profile_created', ['orgId', 'userId']],
  ['agent_verification_state_changed', ['orgId', 'userId', 'facet', 'state']],
  ['agency_affiliation_created', ['orgId', 'userId']],
  ['agency_affiliation_ended', ['orgId', 'userId']],
  ['representation_requested', ['orgId', 'agreementId', 'agentUserId']],
  ['representation_confirmed', ['orgId', 'agreementId', 'agentUserId']],
  ['representation_rejected', ['orgId', 'agreementId', 'agentUserId']],
  ['representation_terminated', ['orgId', 'agreementId', 'agentUserId']],
  ['representation_disputed', ['orgId', 'agreementId', 'agentUserId']],
  // Not which choice changed: the agent reads that from the relationship.
  ['representation_disclosure_changed', ['orgId', 'agreementId', 'agentUserId']],
  ['contact_agent_routed', ['orgId', 'contactId', 'agentUserId']],
  // Not which opportunity, nor the client.
  ['agent_opportunity_shared', ['orgId', 'agreementId', 'agentUserId']],
]) {
  EVENT_REGISTRY[name] = {
    domain: 'agent',
    sourceSystem: 'representationAgreements',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload,
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  };
}

// ---- Conflict & Compliance. Org-private to the agency, ids and state words only.
for (const [name, payload] of [
  ['regulatory_review_requested', ['orgId', 'reviewId', 'kind']],
  ['regulatory_review_started', ['orgId', 'reviewId']],
  ['regulatory_review_resolved', ['orgId', 'reviewId', 'outcome']],
  // `ctxId`, not `contextId`: the personal-field sweep matches "text" inside "contextId".
  ['conflict_evaluated', ['orgId', 'ctxId', 'outcome']],
  ['regulatory_consent_requested', ['orgId', 'consentId', 'ctxId']],
  ['regulatory_consent_granted', ['orgId', 'consentId', 'ctxId']],
  ['regulatory_consent_declined', ['orgId', 'consentId', 'ctxId']],
  ['regulatory_consent_revoked', ['orgId', 'consentId', 'ctxId']],
  ['agent_authorisation_state_changed', ['orgId', 'userId', 'state']],
]) {
  EVENT_REGISTRY[name] = {
    domain: 'compliance',
    sourceSystem: name.startsWith('regulatory_consent')
      ? 'regulatoryConsents'
      : name === 'conflict_evaluated'
        ? 'complianceContexts'
        : name.startsWith('regulatory_review')
          ? 'regulatoryReviews'
          : 'agentProfiles',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload,
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  };
}
// ---- Agent Transaction Workspace. Org-private to the agency, ids and state words only. `txId` rather than
// `transactionId`, like `ctxId`, because the personal-field sweep matches substrings.
for (const [name, payload] of [
  ['agent_transaction_created', ['orgId', 'txId']],
  ['agent_transaction_party_changed', ['orgId', 'txId', 'partyRole']],
  ['agent_transaction_compliance_updated', ['orgId', 'txId', 'outcome']],
  ['agent_transaction_status_changed', ['orgId', 'txId', 'status']],
  ['agent_transaction_document_added', ['orgId', 'txId', 'docId']],
  ['agent_transaction_message_linked', ['orgId', 'txId']],
  ['agent_transaction_held', ['orgId', 'txId', 'status']],
  ['agent_transaction_cancelled', ['orgId', 'txId', 'status']],
  ['agent_transaction_closed', ['orgId', 'txId', 'status']],
]) {
  EVENT_REGISTRY[name] = {
    domain: 'transaction',
    sourceSystem: name === 'agent_transaction_document_added' ? 'transactionDocuments' : 'agentTransactions',
    audience: 'org_private',
    privacyClass: 'org_internal',
    payload,
    dedupeStrategy: 'none',
    replayPolicy: 'never',
    notificationEligible: true,
    analyticsEligible: false,
  };
}

// A policy publication is a global, content-free fact: clients refetch the policy read.
EVENT_REGISTRY.policy_version_published = ping('compliance', 'jurisdictionPolicies');

export const EVENT_NAMES = Object.freeze(Object.keys(EVENT_REGISTRY));

/** Audience for an event. Unknown names fail closed. */
export function audienceFor(event) {
  return EVENT_REGISTRY[event]?.audience ?? 'org_private';
}

export const isRegistered = (event) => Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, event);

/** Returns the dropped keys too, so the caller can throw in development and strip and count in production. */
export function minimizePayload(event, payload = {}) {
  const def = EVENT_REGISTRY[event];
  if (!def) return { payload: {}, dropped: Object.keys(payload ?? {}), unregistered: true };
  const allowed = new Set(def.payload);
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (allowed.has(k)) out[k] = v;
    else dropped.push(k);
  }
  return { payload: out, dropped, unregistered: false };
}

/**
 * Shared by every deduping consumer, so one fact reaching notifications,
 * Second Look and analytics fingerprints identically.
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
 * `emitted` is the list of names the server broadcasts. Throws outside
 * production; production returns the problems and relies on the fail-closed default.
 */
export function assertEventRegistry({ emitted = [], mode = process.env.NODE_ENV ?? 'development' } = {}) {
  const problems = [];
  for (const [name, def] of Object.entries(EVENT_REGISTRY)) {
    if (!AUDIENCES.includes(def.audience)) problems.push(`${name}: audience "${def.audience}" is not a known audience`);
    if (!PRIVACY_CLASSES.includes(def.privacyClass))
      problems.push(`${name}: privacyClass "${def.privacyClass}" unknown`);
    if (!DEDUPE.includes(def.dedupeStrategy)) problems.push(`${name}: dedupeStrategy "${def.dedupeStrategy}" unknown`);
    if (!REPLAY.includes(def.replayPolicy)) problems.push(`${name}: replayPolicy "${def.replayPolicy}" unknown`);
    if (!Array.isArray(def.payload)) problems.push(`${name}: payload allowlist missing`);
    if (def.audience === 'public_safe' && def.privacyClass === 'org_internal')
      problems.push(`${name}: org_internal content cannot be public_safe`);
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
