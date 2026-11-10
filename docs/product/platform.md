# Platform contracts

Cross-cutting server contracts: errors, boot, dates and time zones, capabilities and environment, sessions, one-time codes, notifications, rate limits and deployment. Developer setup is in [`../../scoutbox-server/OPERATIONS.md`](../../scoutbox-server/OPERATIONS.md).

Founder decisions for this area are in [`../decisions.md`](../decisions.md); the storage principles are in [`../architecture.md`](../architecture.md).

## How it works

### Error contract
- Domain error codes map to HTTP status through one null-prototype table in `scoutbox-server/domains/recruitment/lifecycle/errors.mjs` (`httpStatusFor`, `sendDomainError`, `publicErrorBody`). There is **no default branch**: an unmapped code returns `null`, the route answers 500 `LIFECYCLE_INTERNAL` and logs the code by name. New domain codes must be added to the table.
- Bands: 400 bad request; 403 role may never do this; 404 concealment; 409 case moved (reload); 422 evidence record absent; 429 contact cooldown (`retryAt`); 500 our build or data.
- Hidden, foreign and non-existent cases return **byte-identical** 404 bodies. Existence checks come before role checks, so a 403 only reaches someone who can already see the room.
- Every 500 returns a fixed body with only the code; internal detail goes to the log only. A corruption error such as `CASE_HISTORY_CORRUPT` is checked *after* concealment, so it never confirms that a case exists.
- `ROOM_VERSION_CONFLICT` (409) body is exactly `expectedRev, currentRev, updatedBy` (a display name, never a user id), `updatedAt`.
- A protected characteristic can never be a reason (`ROOM_REASON_PROHIBITED`, shared with Rooms).
- Malformed body types (an object or number where text is expected) get 400 `FIELD_INVALID` naming the field, and nothing is stored. A rejection from an async handler goes to the error middleware (`domains/platform/asyncErrors.mjs`) and must never crash the process.

### Production boot contract
- Boot order in `server.mjs`: open the store, `attachDataLayer` (the table migrations, then every repository; a first installation imports the seed once), `integrityReport` (reports, **never repairs**), then every module `register*()`, then `app.listen` as the last statement. There is no top-level await in between, so no request reaches a module before all modules have registered.
- Every domain is a table created by its numbered migration before any module registers. Nothing creates a collection in memory: no `db.x ??=` anywhere (`e2e/platform/storeGuarantees.mjs` enforces it).
- Containers of user data default to empty. Product configuration is not stored: the billing plans (not Development Hub plans) and the archetypes are constants in `catalogue.mjs`, so no restore can empty them or silently move the Grassroots attribution window from 12 to 18 months; changing a plan is a release. The demo reputation rows are empty in production; never fabricate track records.
- Restarting must not mutate any collection, and missing rows are never inferred.

### Production configuration
- `NODE_ENV=production` refuses to boot (fatal) on any of: `MEDIA_SECRET_MISSING`, `ADMIN_KEY_UNSAFE` (unset, `scoutbox-admin`, or <16 characters), `TEST_PROVIDER_IN_PRODUCTION` (`BOX_CAM_TEST_PROVIDER=1`), `AGENT_TEST_PROVIDER_IN_PRODUCTION`, `FAULTS_IN_PRODUCTION` (`SCOUTBOX_FAULTS`), `TEST_CLOCK_IN_PRODUCTION` (`SCOUTBOX_TEST_CLOCK`), `TEST_IDP_IN_PRODUCTION`, `DEV_LOGIN_IN_PRODUCTION` (`ALLOW_DEV_LOGINS` set), `TRUST_WEIGHTS_INVALID`. (`domains/platform/capabilities.mjs`)
- A production first boot has no people or clubs, only the product catalogues; `SCOUTBOX_SEED_DEMO=1` opts into the demo world (decided 3 Nov).
- Seeded passwordless dev logins, credential-less org logins and the test identity provider exist in development only, with no production override (`devLoginsEnabled` in `domains/platform/capabilities.mjs`). Pro and Grassroots club credentials come from T&S (`POST /admin/clubs/:id/credentials`). (decided 3 Nov)
- Sessions expire after `SESSION_TTL_DAYS` (default 30), checked on requests, stream connect and signed media. Sign-out revokes the token (`POST /auth/logout`); any 401 or `session_expired` returns the app to login, across tabs.
- Connected mode is the default. Demo mode only with `VITE_DEMO=1` / `EXPO_PUBLIC_DEMO=1`; a missing variable never selects mock data, and an outage shows a connection error.
- Mail and push switch to real providers by environment variable: `SENDGRID_API_KEY` (+`MAIL_FROM`) and `EXPO_ACCESS_TOKEN`. Unset, they fall back to dev transports visible in the admin console. A phone receives the push notices of the account that last signed in on it (a device token belongs to one player or guardian; staff have no push and are notified in their portal and by e-mail). ID verification (instant dev attestation), billing (local ledger) and media storage (local disk) have no real provider yet; production refuses `ONFIDO_API_TOKEN`, `STRIPE_SECRET_KEY` and `S3_BUCKET` (`PROVIDER_NOT_IMPLEMENTED`) rather than pretend (decided 3 Nov).

### Capabilities (`/capabilities`, Box Cam CV)
- The built-in `production_cv` provider reports `configured`, plus `serverSideObservation`, `syntheticEvaluation: passed`, `realWorldValidation: not_completed`, `combineVerifiedProtocols: []`, `combineVerificationAvailable: false`. **Combine Verified is unavailable for every protocol**; no config or env var can enable it. Only a versioned real-world validation record per protocol can.
- Prohibited, not merely absent: face or body/gait identity, emotion inference, audio capture (`audio:false`), medical inference, and player scores, rankings or comparisons. Supported only on Chromium; no native support.

### Temporal types (`scoutbox-server/temporal.mjs`)
- Every decision-bearing date is exactly one of five types:
  - DATE_ONLY: `YYYY-MM-DD`, stored as the string, years 1900–2100 (Trial 2000–2100), rendered with `timeZone:'UTC'`.
  - UTC_INSTANT: ISO with `Z` or an explicit offset, or integer ms; stored as an integer and re-read via `readInstant`.
  - LOCAL_DATETIME+IANA_ZONE: never stored.
  - HISTORICAL_PARTIAL_DATE: a year or year-month, display only, never a gate.
  - DURATION: integer ms, added to instants, never to wall clocks.
- Principles:
  - Parsing is strict; nothing is repaired (30 Feb is refused; 1900-02-29 is refused).
  - **Absent optional bound = open; present but unreadable bound = closed (refuse).**
  - Starts are inclusive and ends exclusive. A DATE_ONLY end covers its whole UTC day.
  - Intervals need `start < end`.
  - Every predicate takes `now`; UTC throughout, no local getters on stored values.
  - A zone must be an exact IANA name (case-sensitive; no `GMT`, `EST` or `+01:00`; explicit ICU legacy aliases are allowed).
  - Authorisation comes before date validation, so a date error never reveals existence.
- Error codes: `DATE_INVALID`, `DOB_INVALID` (future date, or >120 years), `TIMESTAMP_INVALID`, `TIMEZONE_INVALID`, `INTERVAL_INVALID`, `LOCAL_TIME_NONEXISTENT`, `LOCAL_TIME_AMBIGUOUS`, `TIME_INVALID`. Domain wrappers keep their own codes (`TRIAL_*` etc.) but must call these parsers.
- Boundaries:
  - A licence "valid until 2028-06-30" expires at 2028-07-01T00:00Z.
  - The trial report is due 7 days after UTC midnight of the trial day.
  - The 72h contact cooldown clears at exactly +72h.
  - A person turns 18 at 00:00 UTC on the birthday (29 Feb counts on 1 Mar). The age of majority is 19 in KR, 18 in GB and by default.
  - A null DOB means "age unknown", never adult.
- `isExpiredAt`: absent → false; unreadable → **true**. `isEffectiveAt`: an unreadable end → false. `isDayWithin`: an unreadable bound → false.
- Deliberate exceptions: the contact cooldown **fails open** (an unreadable `deliveredAt` means no cooldown), because it limits the club. An absent facet recheck clock keeps its legacy reading.
- Unreadable stored values are not repaired; they read closed.

### Timezone and DST
- A trial day is DATE_ONLY. A session's `startsAt`/`endsAt` are UTC instants with one organiser IANA zone. Wall clocks are derived for display and ICS export, never stored; the club client converts in the organiser zone and the server refuses bare local times.
- A DST gap is refused (`LOCAL_TIME_NONEXISTENT`). An overlap is refused (`LOCAL_TIME_AMBIGUOUS`, both candidates listed) unless the caller passes `resolve:'earlier'|'later'`; the server never picks.
- Session bounds: end > start, 15 min to 12 h inclusive, a new session not entirely past, 1–20 sessions per revision, no overlap, ≤30 revisions.
- Quiet hours (`HH:MM`) and the minors' school-hours mute are evaluated in `notificationPrefs.timezone`, else Europe/London.

### Write sites
- `room.status` has one writer, `applyStatus()` in `domains/recruitment/rooms/rooms.mjs`; `case.stage` is derived from it and never written directly on a Room (`STAGE_NOT_SETTABLE_ON_ROOM`).
- Signings have one writer, `recordCompletedSigning` (package completion and the legacy route `POST /org/players/:id/signing`). No lifecycle transition may create a signing, because a signing bills the club.
- An idempotent replay still checks permission first. Tables keyed by external data are null-prototype.

### Deployment (neither target is live; both are kept)
- One Docker image (`node:22-slim`, `NODE_ENV=production`) serves the API on port 4000 plus the club app at `/app`, Grassroots at `/grassroots`, Agent at `/agent` and the T&S console at `/console`, built same-origin (`VITE_API_URL=""`). Data lives on a volume at `/srv/data`. The Player app is exported separately (`npx expo export --platform web`) with `EXPO_PUBLIC_API_URL`. See `Dockerfile`.
- `fly.toml` (region `lhr`) and `render.yaml` (health check `/orgs/directory`) both mount a volume at `/srv/data`.

## Server contracts

- Paging: a list that grows without limit pages "continue from here" — `?limit=` (1–100, default 50) and
  `?cursor=` (the previous page's `nextCursor`) give `{ items, nextCursor }`; `nextCursor` is null on the last page.
  A bad limit or cursor is refused (400 `PAGE_LIMIT_INVALID` / `PAGE_CURSOR_INVALID`), never clamped. One helper:
  `scoutbox-server/domains/platform/paging.mjs`. The apps read only the first page; a "load more" is not built yet
  (decided 4 Nov 2026).

- Sessions: the bearer token is returned once and stored only as SHA-256. No file, log,
  backup, `/capabilities` or admin view contains a plain token. Lifetime is
  `SESSION_TTL_DAYS` (30) measured from creation and judged against the current setting.
  Sign-out and revocation delete the row.
- One-time codes (club e-mail-domain challenge, child pairing code, guardian sign-up e-mail code): stored hashed only.
  The challenge lives 30 min and the pairing code 15 min. Each org has one live challenge
  and each child one live pairing code; a new issue replaces the old one. Two live pairing
  codes are never the same.
- A code is committed before it is mailed or returned. Consuming a code and its effect
  (org e-mail domain verified / child session created) happen atomically. On failure the
  code stays live.
- A wrong challenge confirmation counts toward the limit (this persists across restarts).
  The 10th wrong attempt cancels the challenge.
- Rate limits:
  - `email_challenge_request`: 5 per org per hour.
  - `email_challenge_confirm`: 20 wrong per org per 15 min.
  - `pairing_code_mint`: 20 per guardian per hour.
  - `pairing_attempt`: 20 wrong per IP per 15 min, on top of `/auth`.
  - Once a budget is spent, the request is refused before the code is judged.
- The persisted mail outbox withholds secret codes (`[code withheld …]`). The recipient
  still gets the full text.
- Notifications: the feed is newest first by insertion. An identical unread notification
  (same person, type, text and record) whose last occurrence was within 6 h refreshes the
  newest such row in place and does not move it. A notification commits with the action
  it announces. Push and live events fire only after commit and never for a rolled-back
  operation. Text over 2,000 characters is shortened.
- Categories `compliance` and `security_account` are mandatory and cannot be set to
  `false`. A preference value must be `true` or `false` (anything else is `400
  PREFS_INVALID`). Preferences survive account deletion.
- Delivery callbacks match the first dispatch in insertion order whose
  `providerMessageId` equals the event's. Dispatch rows survive a person's deletion
  (orphans are kept; retention is undecided).
- Push tokens: registering a repeated primitive token replaces the earlier one. An
  object or array token is always added as a new row.
- Staff roles are assigned by the organisation, never chosen at login.
  - An unknown name on a credentialed org is refused (`STAFF_NOT_PROVISIONED`) and must be
    invited by a lead.
  - The first login on a credentialed org with no staff bootstraps a lead-tier admin
    (`staff_bootstrapped`).
  - Passwordless seeded orgs are dev only.
  - Staff sign in by name, so a name belongs to one account of the organisation (any case,
    removed accounts included). A new account under a taken name is refused
    (`STAFF_NAME_TAKEN`), including when Trust & Safety provisions one (Founder, 6 Nov).
  - Removing a staff member keeps the account (history stays attributed), ends its sessions
    and records who removed it. Accepting a new invitation for a removed person restores
    their account, with the invite's role (Founder, 6 Nov).
  - An e-mail belongs to one current staff member of an organisation (any case). A
    recovery code works exactly once.
- Group workspaces (federations): Trust & Safety creates a group with one admin club;
  agencies can neither join nor administer one. Membership shares nothing; a grant shares
  one shortlist, case or assessment with named fellow members for 1–180 days (30 by
  default). When a club leaves, a grant ends once its owner shares no group with any of
  its recipients; a grant whose other recipients remain stays live for them, and the
  shared read re-checks membership for every reader.
- Grassroots operations: a club's open days, match days and the local friendlies board
  page by cursor (newest first; the board by match date). Deleting an open day takes it
  off every list (its registrants are not told; a scout another club assigned to it keeps
  the assignment). A player listed twice on a match day is credited once. An open day's
  positions are free text (at most 20, each up to 40 characters, repeats dropped). Club
  names on open days and friendlies are the club's current name.
- Uploads, saved searches, invoices and delivery bookkeeping:
  - A resumable upload refuses a size that is not a whole number of bytes, a title that is
    not text and a checksum that is not 64 hexadecimal characters. A
    deleted player's upload sessions and their half-sent chunks are deleted with the account.
  - A saved search refuses unknown or junk filters, naming the field (`filters.<key>`); an
    empty, false or null filter means "no filter". A saved search is written at once. New-player alerts skip staff who were removed.
  - Invoices are stored exactly in cents, one per signing; the club's and the admin's
    invoice lists page by cursor (newest first) and the apps show the first page.
  - The admin failure injection refuses an unknown channel or a count outside 1–20.
- Signed media URLs are signed with `MEDIA_SECRET` (development uses a per-process key) and last 15 minutes. Each one is bound to the minting session, and the
  viewer's current entitlement is checked again on every fetch.

## Rate limits and test-only providers

- Rate limits live in `RATE_LIMIT_POLICY` (`domains/platform/rateLimit.mjs`).
- Agents: the synthetic licence register (`AGENT_VERIFICATION_TEST_PROVIDER`, which verifies any `TEST-VERIFIED-*` reference) is test-only, so an agent cannot self-verify in production.
- Matching-analytics: Combine CV verification stays disabled until real-world validation. Metrics that need a real detector are reported as unsupported, never estimated.

## Open questions and deferred work

- Lifecycle events are not emitted until a share boundary exists. Atomicity failure-injection was not built.
- Design debt: >500 kB bundles with no code splitting; about 87 English-only Player strings; clickable divs and a `useDialog` copied into three apps.
- Box Cam: replay attacks are not solved and over-cadence detection is partial.
