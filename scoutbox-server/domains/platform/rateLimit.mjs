/**
 * Rate limiting. The only provider counts per process, so behind a load
 * balancer each instance allows the full quota; the capability report says
 * `not_configured` rather than implying protection.
 */

/** `scope` names what the key is built from. */
export const RATE_LIMIT_POLICY = {
  // authentication (IP-scoped, applied as Express middleware)
  auth_attempt: { max: 30, windowMs: 60_000, scope: 'ip', note: 'Sign-in attempts.' },

  // recruitment workflow (organisation-scoped)
  room_create: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'New Recruitment Rooms.' },
  // Per minute: an hourly window would not catch a spam burst in a live discussion.
  room_comment: { max: 20, windowMs: 60_000, scope: 'room_user', note: 'Room discussion messages.' },
  room_combine_request: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Combine requests raised from a Room.' },
  brief_write: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Recruitment Brief creates and edits.' },
  matching_query: { max: 240, windowMs: 3_600_000, scope: 'org', note: 'Explainable Matching queries.' },
  watchlist_write: { max: 120, windowMs: 3_600_000, scope: 'org', note: 'Dynamic Watchlist creates and edits.' },
  second_look_action: { max: 200, windowMs: 3_600_000, scope: 'org', note: 'Second Look review, dismiss and reopen.' },
  nobody_missed_action: {
    max: 200,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Candidate review, dismiss and add-to-room.',
  },
  // Generous, to bound only a runaway client: each read scans the organisation's recruitment records.
  analytics_read: { max: 600, windowMs: 3_600_000, scope: 'org', note: 'Recruitment analytics dashboard reads.' },

  // Development Hub. Per actor, so a busy club cannot exhaust a quota the player then hits. Generous on items so
  // ticking off a session's actions is never mistaken for abuse.
  development_plan_write: {
    max: 120,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Development Plan creates, edits and sharing changes.',
  },
  development_item_write: {
    max: 600,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Development goal, action and evidence-link writes.',
  },
  development_review_write: { max: 60, windowMs: 3_600_000, scope: 'actor', note: 'Development Review submissions.' },

  // player-side capture: protects device and storage, and must not punish training a lot
  combine_attempt: { max: 40, windowMs: 3_600_000, scope: 'player', note: 'At-Home Combine attempts.' },
  box_session_create: { max: 30, windowMs: 3_600_000, scope: 'player', note: 'Box Cam capture sessions.' },
  box_dispute: { max: 5, windowMs: 3_600_000, scope: 'player', note: 'Box Cam result disputes.' },

  // Production CV. Separate policies because the costs differ: a session reserves a concurrency slot, frame
  // ingest decodes pixels and runs the engine, and finalize only needs a bound on retry loops. Frames are counted
  // per batch (up to FRAME_LIMITS.maxFramesPerBatch frames each).
  box_cv_session_create: { max: 40, windowMs: 3_600_000, scope: 'player', note: 'Production CV provider sessions.' },
  box_cv_frames: { max: 600, windowMs: 3_600_000, scope: 'player', note: 'Production CV frame batches.' },
  box_cv_finalize: { max: 80, windowMs: 3_600_000, scope: 'player', note: 'Production CV finalization.' },
  box_cv_ready_check: { max: 120, windowMs: 3_600_000, scope: 'player', note: 'Box Cam CV Ready Check runs.' },

  // Contact. Sends reach a real person and are the abuse-sensitive one. Responses are per actor, so a busy club
  // cannot exhaust a recipient's quota. The per-recipient cooldown lives in domains/recruitment/lifecycle/contact.mjs.
  contact_draft: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Contact drafts created or edited.' },
  contact_send: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Contacts sent to players and guardians.' },
  contact_external_record: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'External contacts recorded.' },
  contact_response: { max: 30, windowMs: 3_600_000, scope: 'actor', note: 'Responses to contacts.' },

  // Trial. Invitations are the abuse-sensitive one; responses are per actor. The per-player invitation cooldown
  // lives in domains/recruitment/lifecycle/trialRoutes.mjs.
  trial_invite: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Trial invitations sent to players and guardians.',
  },
  trial_schedule: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Trial schedules proposed, revised or cancelled.',
  },
  trial_response: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Trial schedule confirmations, declines and cancellations by a player or guardian.',
  },
  // Offer. Drafting shares one budget so an alias route cannot double it. Responses are keyed by the person
  // answering, not the player named (a guardian answering for two children is one person).
  offer_draft_write: { max: 120, windowMs: 3_600_000, scope: 'org', note: 'Offer drafts created, edited or revised.' },
  offer_issue: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Offers issued to players and guardians.' },
  offer_withdraw: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Offers withdrawn.' },
  offer_response: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Offer acceptances and declines by a player or guardian.',
  },
  // Signing. Closure acts have their own budgets so other traffic cannot starve the act that ends a signing.
  signing_start: { max: 30, windowMs: 3_600_000, scope: 'org', note: 'Signing packages opened over accepted Offers.' },
  signing_document_write: {
    max: 120,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Signing documents attached, drafts edited, packages presented or superseded.',
  },
  signing_party_completion: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'A party confirming the exact signing document (player, or the club signatory).',
  },
  signing_closure: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Signings completed (the canonical completion).',
  },
  signing_safety_closure: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Signings cancelled or voided by the club: a safety closure with its own budget, so completion traffic cannot exhaust it.',
  },
  trial_evidence_link: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Box Cam sessions linked to a Trial.' },
  trial_attendance: { max: 120, windowMs: 3_600_000, scope: 'org', note: 'Trial attendance and completion records.' },
  // Formal recruitment decisions.
  decision_draft: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Decision drafts opened or edited.' },
  decision_finalize: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Formal recruitment decisions finalized or superseded.',
  },

  // Agent core. Representation requests solicit a person, so they are limited per agent per day, on top of the
  // per-player cooldown in domains/agents/core. Lookups are bounded against enumeration.
  agent_representation_request: {
    max: 40,
    windowMs: 86_400_000,
    scope: 'actor',
    note: "Representation relationship requests that reach a player lookup (malformed input and the agent's own verification refusals do not count).",
  },
  agent_player_lookup: {
    max: 120,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Player lookups from the Agent workspace.',
  },
  agent_profile_write: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Agent profile edits and verification submissions.',
  },
  agent_affiliation_write: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Agency team and settings changes.' },
  agent_client_response: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Relationship confirmations, declines, terminations and disputes by a player.',
  },
  // Conflict & Compliance Engine.
  compliance_context_write: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Compliance context creation, party additions and representation declarations by a licensed agent.',
  },
  compliance_consent_request: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Consent requests sent to parties by a licensed agent.',
  },
  compliance_consent_response: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Consent grants, declines and revocations by a party.',
  },
  ts_review_decision: {
    max: 120,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Attributed Trust & Safety review decisions.',
  },
  ts_policy_publish: {
    max: 10,
    windowMs: 86_400_000,
    scope: 'actor',
    note: 'Policy version proposals by a Trust & Safety administrator.',
  },
  // Agent Transaction Workspace.
  transaction_write: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Transaction creation, party changes, representation bindings, terms and re-evaluations by a licensed agent.',
  },
  transaction_status_write: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Transaction status transitions and party confirmations.',
  },
  transaction_document_write: {
    max: 120,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Transaction document metadata by any party to a transaction.',
  },
  transaction_note_write: {
    max: 120,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Scoped transaction notes by any party to a transaction.',
  },
  // Cross-app integration. Both notify a person and can be withdrawn and repeated, so without a quota the pair
  // would be an unbounded way to spam someone's notifications.
  opportunity_share: {
    max: 60,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Opportunities an agent shares with a client, and withdrawals of them.',
  },
  transaction_handoff: {
    max: 30,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Transaction-workspace invitations a club issues from a recruitment case, and withdrawals of them.',
  },

  // Credential guessing. The per-IP /auth limiter cannot bound guessing against one account from many addresses,
  // and it counts successes, so a shared office's normal sign-ins spend it. This one is charged only for a wrong
  // guess and keyed by the identifier tried.
  login_failure: {
    max: 20,
    windowMs: 900_000,
    scope: 'actor',
    note: 'Failed sign-in attempts, per identifier tried. A successful sign-in costs nothing.',
  },

  // One-time codes, on top of the /auth limiter and the challenge's own attempt count. Minting and sending are
  // bounded per owner; a guess is charged only when wrong.
  email_challenge_request: {
    max: 5,
    windowMs: 3_600_000,
    scope: 'org',
    note: 'Club e-mail-domain verification codes requested (each one sends a mail).',
  },
  email_challenge_confirm: {
    max: 20,
    windowMs: 900_000,
    scope: 'org',
    note: 'Wrong club e-mail verification codes presented. A correct code costs nothing.',
  },
  pairing_code_mint: {
    max: 20,
    windowMs: 3_600_000,
    scope: 'actor',
    note: 'Child pairing codes minted, per guardian.',
  },
  pairing_attempt: {
    max: 20,
    windowMs: 900_000,
    scope: 'ip',
    note: 'Wrong child pairing codes presented, per client address (the route is unauthenticated). A correct code costs nothing.',
  },

  // outbound to people
  evidence_request: { max: 60, windowMs: 3_600_000, scope: 'org', note: 'Evidence requests to players and guardians.' },
  org_invite: { max: 25, windowMs: 86_400_000, scope: 'org', note: 'Staff invitations.' },
  passport_share_read: { max: 60, windowMs: 60_000, scope: 'ip', note: 'Public Passport share link reads.' },
};

/** Correct for a single process only. */
export function memoryRateLimitProvider() {
  const buckets = new Map();
  return {
    id: 'memory',
    distributed: false,
    consume(key, max, windowMs, now = Date.now()) {
      const b = buckets.get(key);
      if (!b || now - b.start > windowMs) {
        // Evict rather than clear: login-failure keys are whatever the caller typed, so clearing when full would
        // let a flood of made-up names wipe every real budget. Expired buckets go first, then the quarter with the
        // fewest hits (a flood touches each key once), oldest among equals.
        if (buckets.size >= 20_000) {
          for (const [k, v] of buckets) if (now - v.start > v.windowMs) buckets.delete(k);
          if (buckets.size >= 20_000) {
            const victims = [...buckets.entries()]
              .sort((x, y) => x[1].n - y[1].n || x[1].start - y[1].start)
              .slice(0, Math.ceil(buckets.size / 4));
            for (const [k] of victims) buckets.delete(k);
          }
        }
        buckets.set(key, { start: now, n: 1, windowMs });
        return { limited: false, remaining: Math.max(0, max - 1), resetAt: now + windowMs };
      }
      b.n += 1;
      return { limited: b.n > max, remaining: Math.max(0, max - b.n), resetAt: b.start + windowMs };
    },
    peek(key, max, windowMs, now = Date.now()) {
      const b = buckets.get(key);
      if (!b || now - b.start > windowMs) return { limited: false, remaining: max, resetAt: now + windowMs };
      return { limited: b.n > max, remaining: Math.max(0, max - b.n), resetAt: b.start + windowMs };
    },
    reset(key) {
      buckets.delete(key);
    },
    size: () => buckets.size,
    /** The live buckets and what each has spent in its window. */
    snapshot(now = Date.now()) {
      return [...buckets.entries()]
        .filter(([, b]) => now - b.start <= b.windowMs)
        .map(([key, b]) => ({ key, spent: b.n }));
    },
  };
}

/**
 * Any provider other than `memory` throws: silently falling back to
 * per-process counting would let an operator believe limits are shared.
 */
export function createRateLimiter({ provider = process.env.SCOUTBOX_RATE_LIMIT_PROVIDER ?? 'memory' } = {}) {
  if (provider !== 'memory') {
    throw new Error(
      `SCOUTBOX_RATE_LIMIT_PROVIDER=${provider} is not available: no shared rate-limit backend is configured in this build. ` +
        'Use "memory" (single instance) or add a provider before enabling it.',
    );
  }
  const impl = memoryRateLimitProvider();

  /** Consumes one unit; true when limited. */
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
    /**
     * Reads without consuming: a failed-login lockout must be tested before the
     * credential is checked, or a correct guess after the budget is gone would succeed.
     */
    peek: (action, keyPart, now) => {
      const policy = RATE_LIMIT_POLICY[action];
      if (!policy) throw new Error(`Unknown rate-limit action "${action}".`);
      return impl.peek(`${action}:${keyPart}`, policy.max, policy.windowMs, now);
    },
    reset: (action, keyPart) => impl.reset(`${action}:${keyPart}`),
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
 * Development only, beside POST /__faults and on the same guard: `GET /__rate-limits` lists the live buckets as
 * `{ action, key, spent }`, so a battery can see which budget a request drew on, and under which key, without
 * spending the whole budget to find out.
 */
export function installRateLimitInspection(app, rateLimit, { enabled }) {
  if (!enabled) return;
  app.get('/__rate-limits', (_req, res) => {
    const buckets = rateLimit.provider.snapshot().map(({ key, spent }) => {
      const at = key.indexOf(':');
      return { action: key.slice(0, at), key: key.slice(at + 1), spent };
    });
    res.json({ buckets });
  });
}

/** Says nothing about the request's subject, so it cannot reveal whether a player exists. */
export const rateLimitedBody = (action) => ({
  error: 'RATE_LIMITED',
  action,
  message: 'Too many requests in a short window — wait a moment and try again.',
});

/** Some unit harnesses register a domain without a limiter; nothing is limited then. */
export const limitCheck = (rateLimit) => (action, keyPart) => !!rateLimit?.limited?.(action, keyPart);

/** Answers 429 when limited; returns whether it answered. */
export const refuseWhenLimited = (rateLimit) => {
  const limited = limitCheck(rateLimit);
  return (res, action, keyPart) => {
    if (!limited(action, keyPart)) return false;
    res.status(429).json(rateLimitedBody(action));
    return true;
  };
};
