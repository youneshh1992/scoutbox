/**
 * M18.1 — rate limiting: one provider, one policy table, one honest capability.
 *
 * Before this there were six independent limiters: the adapter's IP limiter on
 * /auth, plus five copy-pasted `limited(key, max, windowMs)` helpers with their
 * own Maps in Combine, Box Cam sessions, Rooms, Nobody Missed and Second Look.
 * Every limit was a number written inline at the call site, so nobody could
 * answer "what are we actually limiting, and to what?" without grepping.
 *
 * Two things are fixed here and one is deliberately NOT:
 *
 *   fixed — every limited action is named once in POLICY below, with its
 *   window and its scope, so the answer to that question is one file;
 *   fixed — consumption goes through a provider interface, so a shared backend
 *   can be added later without touching a single call site;
 *   NOT fixed — there is no shared backend today. The memory provider counts
 *   per process, which is correct for development, demo and a single instance
 *   and WRONG for several instances behind a load balancer, where each one
 *   would allow the full quota. The capability report says exactly that
 *   (`distributed_rate_limit: not_configured`) rather than implying protection
 *   that does not exist.
 */

/**
 * Every rate-limited action in ScoutBox, in one place.
 *
 * `scope` documents what the key is built from, so a limit can be read as a
 * sentence: "brief_write is 60 per hour per organisation".
 */
export const RATE_LIMIT_POLICY = {
  // authentication (IP-scoped, applied as Express middleware)
  auth_attempt: { max: 30, windowMs: 60_000, scope: 'ip', note: 'Sign-in attempts.' },

  // recruitment workflow (organisation-scoped)
  room_create: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'New Recruitment Rooms.' },
  // Kept as a per-MINUTE limit: this one exists to stop a runaway client or
  // a spam burst in a live discussion, which an hourly window would not catch.
  room_comment: { max: 20, windowMs: 60_000, scope: 'room_user', note: 'Room discussion messages.' },
  room_combine_request: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Combine requests raised from a Room.' },
  brief_write: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Recruitment Brief creates and edits.' },
  matching_query: { max: 240, windowMs: 3_600_000, scope: 'org', note: 'Explainable Matching queries.' },
  watchlist_write: { max: 120, windowMs: 3_600_000, scope: 'org', note: 'Dynamic Watchlist creates and edits.' },
  second_look_action: { max: 200, windowMs: 3_600_000, scope: 'org', note: 'Second Look review, dismiss and reopen.' },
  nobody_missed_action: { max: 200, windowMs: 3_600_000, scope: 'org', note: 'Candidate review, dismiss and add-to-room.' },
  // Generous: a dashboard read is a read, and a director flipping between
  // windows and filters must never be told to slow down for using the page.
  // The limit exists only to bound a runaway client, since each read is a
  // full scan of the organisation's recruitment records.
  analytics_read: { max: 600, windowMs: 3_600_000, scope: 'org', note: 'Recruitment analytics dashboard reads.' },

  // M21 Development Hub. Scoped to the ACTOR rather than the organisation,
  // because a plan has three possible authors — a player, a guardian and club
  // staff — and an org-scoped limit would let a busy club exhaust a quota a
  // player then hits. Deliberately generous on items: ticking off a session's
  // worth of actions must never be mistaken for abuse, and being told to slow
  // down for doing the work is the wrong message from a development tool.
  development_plan_write: { max: 120, windowMs: 3_600_000, scope: 'actor', note: 'Development Plan creates, edits and sharing changes.' },
  development_item_write: { max: 600, windowMs: 3_600_000, scope: 'actor', note: 'Development goal, action and evidence-link writes.' },
  development_review_write: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Development Review submissions.' },

  // player-side capture (player-scoped: these protect the player's own device
  // and our storage, and must never read as punishment for training a lot)
  combine_attempt: { max: 40, windowMs: 3_600_000, scope: 'player', note: 'At-Home Combine attempts.' },
  box_session_create: { max: 30, windowMs: 3_600_000, scope: 'player', note: 'Box Cam capture sessions.' },
  box_dispute: { max: 5, windowMs: 3_600_000, scope: 'player', note: 'Box Cam result disputes.' },

  // M22 production CV (§40). THREE separate policies, because the three
  // actions cost wildly different things and one shared limit would be tuned
  // for the wrong one.
  //
  //   session create  cheap, but each one reserves a concurrency slot
  //   frame ingest    the expensive endpoint — this is where pixels are
  //                   decoded and the engine runs, so it gets a deliberate
  //                   limit rather than inheriting a generous one
  //   finalize        once per attempt by construction; the limit exists only
  //                   to bound a retry loop
  //
  // Ingest is per-BATCH, not per-frame: a batch carries up to
  // FRAME_LIMITS.maxFramesPerBatch frames, so 600 batches an hour is roughly
  // 7,200 frames — comfortably more than a session of honest attempts and far
  // below what a runaway client would send.
  box_cv_session_create: { max: 40, windowMs: 3_600_000, scope: 'player', note: 'Production CV provider sessions.' },
  box_cv_frames: { max: 600, windowMs: 3_600_000, scope: 'player', note: 'Production CV frame batches.' },
  box_cv_finalize: { max: 80, windowMs: 3_600_000, scope: 'player', note: 'Production CV finalization.' },
  box_cv_ready_check: { max: 120, windowMs: 3_600_000, scope: 'player', note: 'Box Cam CV Ready Check runs.' },

  // M23 P3 Contact. Sends are the abuse-sensitive one: a message reaches a
  // real person, or a guardian on a child's behalf. Drafts and external
  // records stay inside the organisation and are limited only to bound a
  // runaway client. The response limit is per ACTOR (a player or guardian),
  // so a busy club cannot exhaust a recipient's quota. The per-recipient
  // cooldown (one delivered in-app contact per org+player per 72 h unless
  // answered) is separate and deterministic — see m23/contact.mjs.
  contact_draft: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Contact drafts created or edited.' },
  contact_send: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Contacts sent to players and guardians.' },
  contact_external_record: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'External contacts recorded.' },
  contact_response: { max: 30, windowMs: 3_600_000, scope: 'actor', note: 'Responses to contacts.' },

  // M23 P4B Trial. Invitations reach a real person (or a guardian on a
  // child's behalf) and are the abuse-sensitive one; scheduling, attendance
  // and evidence links stay inside the organisation and are bounded only
  // against a runaway client. Responses are per ACTOR, so a busy club cannot
  // exhaust a family's quota. The per-player invitation cooldown is
  // deterministic and separate — see m23/trialRoutes.mjs.
  trial_invite: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Trial invitations sent to players and guardians.' },
  trial_schedule: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Trial schedules proposed, revised or cancelled.' },
  trial_response: { max: 30, windowMs: 3_600_000, scope: 'actor', note: 'Trial schedule confirmations, declines and cancellations by a player or guardian.' },
  trial_evidence_link: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Box Cam sessions linked to a Trial.' },
  trial_attendance: { max: 120, windowMs: 3_600_000, scope: 'org', note: 'Trial attendance and completion records.' },
  // M23 P5 — formal recruitment decisions. Drafting is cheap and frequent;
  // finalizing is the recruitment act itself.
  decision_draft: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Decision drafts opened or edited.' },
  decision_finalize: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Formal recruitment decisions finalized or superseded.' },

  // M23 P5.6B ScoutBox Agent core. Relationship requests are solicitations of
  // a person and are the abuse-sensitive one: per ACTOR (the licensed
  // individual), per day, and separate from the deterministic per-player
  // cooldown in m24. Lookups are bounded against enumeration.
  agent_representation_request: { max: 40, windowMs: 86_400_000, scope: 'actor', note: 'Representation relationship requests that reach a player lookup (malformed input and the agent\'s own verification refusals do not count).' },
  agent_player_lookup: { max: 120, windowMs: 3_600_000, scope: 'actor', note: 'Player lookups from the Agent workspace.' },
  agent_profile_write: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Agent profile edits and verification submissions.' },
  agent_affiliation_write: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Agency team and settings changes.' },
  agent_client_response: { max: 30, windowMs: 3_600_000, scope: 'actor', note: 'Relationship confirmations, declines, terminations and disputes by a player.' },
  // M23 P5.6C Conflict & Compliance Engine.
  compliance_context_write: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Compliance context creation, party additions and representation declarations by a licensed agent.' },
  compliance_consent_request: { max: 30, windowMs: 3_600_000, scope: 'actor', note: 'Consent requests sent to parties by a licensed agent.' },
  compliance_consent_response: { max: 30, windowMs: 3_600_000, scope: 'actor', note: 'Consent grants, declines and revocations by a party.' },
  ts_review_decision: { max: 120, windowMs: 3_600_000, scope: 'actor', note: 'Attributed Trust & Safety review decisions.' },
  ts_policy_publish: { max: 10, windowMs: 86_400_000, scope: 'actor', note: 'Policy version proposals by a Trust & Safety administrator.' },
  // M23 P5.6D Agent Transaction Workspace.
  transaction_write: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Transaction creation, party changes, representation bindings, terms and re-evaluations by a licensed agent.' },
  transaction_status_write: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Transaction status transitions and party confirmations.' },
  transaction_document_write: { max: 120, windowMs: 3_600_000, scope: 'actor', note: 'Transaction document metadata by any party to a transaction.' },
  transaction_note_write: { max: 120, windowMs: 3_600_000, scope: 'actor', note: 'Scoped transaction notes by any party to a transaction.' },
  // M23 P5.6E cross-app integration. Both writes reach a PERSON with a
  // notification, and both can be repeated: a share can be withdrawn and a new
  // one made, and a handoff invitation can be withdrawn and re-issued (only
  // 'invited' and 'accepted' block a new one, by design — a club must be able to
  // re-invite after it has taken its own invitation back). Without a quota the
  // invite/withdraw pair is an unbounded way to make a player's and an agent's
  // notification list ring, so the same provider that guards every comparable
  // write guards these two.
  opportunity_share: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Opportunities an agent shares with a client, and withdrawals of them.' },
  transaction_handoff: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Transaction-workspace invitations a club issues from a recruitment case, and withdrawals of them.' },

  // outbound to people
  evidence_request: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Evidence requests to players and guardians.' },
  org_invite: { max: 25, windowMs: 86_400_000, scope: 'org', note: 'Staff invitations.' },
  passport_share_read: { max: 60, windowMs: 60_000, scope: 'ip', note: 'Public Passport share link reads.' },
};

/** In-memory provider: correct for one process, honest about being only that. */
export function memoryRateLimitProvider() {
  const buckets = new Map();
  return {
    id: 'memory',
    distributed: false,
    consume(key, max, windowMs, now = Date.now()) {
      const b = buckets.get(key);
      if (!b || now - b.start > windowMs) {
        buckets.set(key, { start: now, n: 1 });
        return { limited: false, remaining: Math.max(0, max - 1), resetAt: now + windowMs };
      }
      b.n += 1;
      // Crude memory bound: this is a speed bump, not an accounting system.
      if (buckets.size > 20_000) buckets.clear();
      return { limited: b.n > max, remaining: Math.max(0, max - b.n), resetAt: b.start + windowMs };
    },
    peek(key, max, windowMs, now = Date.now()) {
      const b = buckets.get(key);
      if (!b || now - b.start > windowMs) return { limited: false, remaining: max, resetAt: now + windowMs };
      return { limited: b.n > max, remaining: Math.max(0, max - b.n), resetAt: b.start + windowMs };
    },
    reset(key) { buckets.delete(key); },
    size: () => buckets.size,
  };
}

/**
 * Build the limiter. `SCOUTBOX_RATE_LIMIT_PROVIDER=distributed` is accepted so
 * a deployment can ASK for the shared backend — and is refused loudly, because
 * no such backend is configured. Silently falling back to per-process counting
 * while an operator believes they have distributed protection is exactly the
 * kind of quiet lie this milestone exists to remove.
 */
export function createRateLimiter({ provider = process.env.SCOUTBOX_RATE_LIMIT_PROVIDER ?? 'memory' } = {}) {
  if (provider !== 'memory') {
    throw new Error(
      `SCOUTBOX_RATE_LIMIT_PROVIDER=${provider} is not available: no shared rate-limit backend is configured in this build. `
      + 'Use "memory" (single instance) or add a provider before enabling it.',
    );
  }
  const impl = memoryRateLimitProvider();

  /** Consume one unit against a named policy. Returns true when LIMITED. */
  const limited = (action, keyPart, now = Date.now()) => {
    const policy = RATE_LIMIT_POLICY[action];
    if (!policy) throw new Error(`Unknown rate-limit action "${action}" — add it to RATE_LIMIT_POLICY.`);
    return impl.consume(`${action}:${keyPart}`, policy.max, policy.windowMs, now).limited;
  };

  return {
    provider: impl,
    policy: RATE_LIMIT_POLICY,
    limited,
    consume: (action, keyPart, now) => {
      const policy = RATE_LIMIT_POLICY[action];
      if (!policy) throw new Error(`Unknown rate-limit action "${action}".`);
      return impl.consume(`${action}:${keyPart}`, policy.max, policy.windowMs, now);
    },
    reset: (action, keyPart) => impl.reset(`${action}:${keyPart}`),
    /** Operator-facing capability. Never claims protection it does not have. */
    capability: () => ({
      provider: impl.id,
      distributed: impl.distributed,
      state: impl.distributed ? 'configured' : 'not_configured',
      note: impl.distributed
        ? 'Limits are enforced across instances.'
        : 'Limits are counted per process. With more than one instance behind a load balancer each instance allows the full quota.',
      actions: Object.keys(RATE_LIMIT_POLICY).length,
    }),
  };
}

/**
 * The response body for a limited request. Deliberately free of anything about
 * the subject of the request: a rate-limit answer must not become a way to
 * learn whether a player exists.
 */
export const rateLimitedBody = (action) => ({
  error: 'RATE_LIMITED',
  action,
  message: 'Too many requests in a short window — wait a moment and try again.',
});
