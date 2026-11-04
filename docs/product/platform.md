# Platform contracts

Cross-cutting server contracts: errors, boot, dates and time zones, capabilities and environment, sessions, one-time codes, notifications, rate limits and deployment. Developer setup is in [`../../scoutbox-server/OPERATIONS.md`](../../scoutbox-server/OPERATIONS.md).

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## How it works

### Error contract
- Domain error codes map to HTTP status through one null-prototype table in `scoutbox-server/m23/errors.mjs` (`httpStatusFor`, `sendDomainError`, `publicErrorBody`). There is **no default branch**: an unmapped code returns `null`, the route answers 500 `LIFECYCLE_INTERNAL` and logs the code by name. New domain codes must be added to the table. (M23_ERROR_CONTRACT)
- Bands: 400 bad request; 403 role may never do this; 404 concealment; 409 case moved (reload); 422 evidence record absent; 429 contact cooldown (`retryAt`); 500 our build or data. (M23_ERROR_CONTRACT)
- Hidden, foreign and non-existent cases return **byte-identical** 404 bodies. Existence checks come before role checks, so a 403 only reaches someone who can already see the room. (M23_ERROR_CONTRACT)
- Every 500 returns a fixed body with only the code; internal detail goes to the log only. A corruption error such as `CASE_HISTORY_CORRUPT` is checked *after* concealment, so it never confirms that a case exists. (M23_ERROR_CONTRACT, M23_P2_SWEEP_REPORT)
- `ROOM_VERSION_CONFLICT` (409) body is exactly `expectedRev, currentRev, updatedBy` (a display name, never a user id), `updatedAt`. (M23_ERROR_CONTRACT)
- A protected characteristic can never be a reason (`ROOM_REASON_PROHIBITED`, shared with M17). (M23_ERROR_CONTRACT)
- Malformed body types (an object or number where text is expected) get 400 `FIELD_INVALID` naming the field, and nothing is stored. A rejection from an async handler goes to the error middleware (`m181/asyncErrors.mjs`) and must never crash the process. (PRE_M24_DEFECT_REGISTER)

### Production boot contract
- Boot order in `server.mjs`: seed builder, `loadSnapshot`, `runMigrations`, then `integrityReport` (reports `STORE_MISSING`, **never repairs**), then every module `register*()`, then `app.listen` as the last statement. There is no top-level await in between, so no request reaches a module before all modules have registered. (M23_PRODUCTION_BOOT_CONTRACT)
- Every store read in production is declared in `scoutbox-server/storeContract.mjs` as `migration`, `module` (initialised at registration) or `optional` (absence has product meaning). `PRODUCTION_REQUIRED_STORES` is derived from it. A domain whose reads moved to SQL (since §4.3 step 2: contacts and offers) is not a store: it has no `db.*` collection. (M23_PRODUCTION_BOOT_CONTRACT)
- A `db.x ??=` inside a request handler (store created on first write) is forbidden. Stores are initialised at registration or by migration. (M23_PRODUCTION_BOOT_CONTRACT)
- Containers of user data default to empty. Product configuration does not: `plans` (the billing catalogue, not M21 development plans) and `archetypes` are restored from `catalogue.mjs` if absent, because an empty `plans` silently moves the Grassroots attribution window from 12 to 18 months. `reputationSeed` is empty in production; never fabricate track records. (M23_STORE_INITIALIZATION_AUDIT)
- Restarting must not mutate any collection, and missing rows are never inferred. (M23_PRODUCTION_BOOT_CONTRACT, M23_STORE_INITIALIZATION_AUDIT)

### Production configuration
- `NODE_ENV=production` refuses to boot (fatal) on any of: `MEDIA_SECRET_MISSING`, `ADMIN_KEY_UNSAFE` (unset, `scoutbox-admin`, or <16 characters), `TEST_PROVIDER_IN_PRODUCTION` (`BOX_CAM_TEST_PROVIDER=1`), `AGENT_TEST_PROVIDER_IN_PRODUCTION`, `FAULTS_IN_PRODUCTION` (`SCOUTBOX_FAULTS`), `TEST_IDP_IN_PRODUCTION`, `DEV_LOGIN_IN_PRODUCTION` (`ALLOW_DEV_LOGINS` set), `TRUST_WEIGHTS_INVALID`. (README, PRE_M24_DEFECT_REGISTER; code `m181/capabilities.mjs`)
- A production first boot has no people or clubs, only the product catalogues; `SCOUTBOX_SEED_DEMO=1` opts into the demo world (decided 3 Nov).
- Seeded passwordless dev logins, credential-less org logins and the test identity provider exist in development only, with no production override (`devLoginsEnabled` in `m181/capabilities.mjs`). Pro and Grassroots club credentials come from T&S (`POST /admin/clubs/:id/credentials`). (README, PRE_M24_DEFECT_REGISTER; decided 3 Nov)
- Sessions expire after `SESSION_TTL_DAYS` (default 30), checked on requests, stream connect and signed media. Sign-out revokes the token (`POST /auth/logout`); any 401 or `session_expired` returns the app to login, across tabs. (PRE_M24_DEFECT_REGISTER)
- Connected mode is the default. Demo mode only with `VITE_DEMO=1` / `EXPO_PUBLIC_DEMO=1`; a missing variable never selects mock data, and an outage shows a connection error. (README)
- Mail and push switch to real providers by environment variable: `SENDGRID_API_KEY` (+`MAIL_FROM`) and `EXPO_ACCESS_TOKEN`. Unset, they fall back to dev transports visible in the admin console. ID verification (instant dev attestation), billing (local ledger) and media storage (local disk) have no real provider yet; production refuses `ONFIDO_API_TOKEN`, `STRIPE_SECRET_KEY` and `S3_BUCKET` (`PROVIDER_NOT_IMPLEMENTED`) rather than pretend. (DEPLOY; decided 3 Nov)

### Capabilities (`/capabilities`, Box Cam CV)
- The built-in `production_cv` provider reports `configured`, plus `serverSideObservation`, `syntheticEvaluation: passed`, `realWorldValidation: not_completed`, `combineVerifiedProtocols: []`, `combineVerificationAvailable: false`. **Combine Verified is unavailable for every protocol**; no config or env var can enable it. Only a versioned real-world validation record per protocol can. (M22_CAPABILITIES)
- Prohibited, not merely absent: face or body/gait identity, emotion inference, audio capture (`audio:false`), medical inference, and player scores, rankings or comparisons. Supported only on Chromium; no native support. (M22_CAPABILITIES)

### Temporal types (`scoutbox-server/temporal.mjs`)
- Every decision-bearing date is exactly one of five types (M23_P57_TEMPORAL_TYPE_CONTRACT):
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
  (M23_P57_TEMPORAL_TYPE_CONTRACT)
- Error codes: `DATE_INVALID`, `DOB_INVALID` (future date, or >120 years), `TIMESTAMP_INVALID`, `TIMEZONE_INVALID`, `INTERVAL_INVALID`, `LOCAL_TIME_NONEXISTENT`, `LOCAL_TIME_AMBIGUOUS`, `TIME_INVALID`. Domain wrappers keep their own codes (`TRIAL_*` etc.) but must call these parsers. (M23_P57_DATE_PARSER_CONTRACT)
- Boundaries:
  - A licence "valid until 2028-06-30" expires at 2028-07-01T00:00Z.
  - The trial report is due 7 days after UTC midnight of the trial day.
  - The 72h contact cooldown clears at exactly +72h.
  - A person turns 18 at 00:00 UTC on the birthday (29 Feb counts on 1 Mar). The age of majority is 19 in KR, 18 in GB and by default.
  - A null DOB means "age unknown", never adult.
  (M23_P57_TEMPORAL_TYPE_CONTRACT, M23_P57_IMPORT_LEGACY_AUDIT)
- `isExpiredAt`: absent → false; unreadable → **true**. `isEffectiveAt`: an unreadable end → false. `isDayWithin`: an unreadable bound → false. (M23_P57_DATE_PARSER_CONTRACT)
- Deliberate exceptions: the contact cooldown **fails open** (an unreadable `deliveredAt` means no cooldown), because it limits the club. An absent facet recheck clock keeps its legacy reading. (M23_P57_TEMPORAL_AUTHORIZATION_AUDIT)
- Legacy unreadable values are not migrated; they read closed. (M23_P57_IMPORT_LEGACY_AUDIT)

### Timezone and DST
- A trial day is DATE_ONLY. A session's `startsAt`/`endsAt` are UTC instants with one organiser IANA zone. Wall clocks are derived for display and ICS export, never stored; the club client converts in the organiser zone and the server refuses bare local times. (M23_P57_TRIAL_TIMEZONE_DST_AUDIT)
- A DST gap is refused (`LOCAL_TIME_NONEXISTENT`). An overlap is refused (`LOCAL_TIME_AMBIGUOUS`, both candidates listed) unless the caller passes `resolve:'earlier'|'later'`; the server never picks. (M23_P57_TRIAL_TIMEZONE_DST_AUDIT)
- Session bounds: end > start, 15 min to 12 h inclusive, a new session not entirely past, 1–20 sessions per revision, no overlap, ≤30 revisions. (M23_P57_TRIAL_TIMEZONE_DST_AUDIT)
- Quiet hours (`HH:MM`) and the minors' school-hours mute are evaluated in `notificationPrefs.timezone`, else Europe/London. (M23_P57_TRIAL_TIMEZONE_DST_AUDIT)

### Write sites
- `room.status` has one writer, `applyStatus()` in `m17/rooms.mjs`; `case.stage` is derived from it and never written directly on a Room (`STAGE_NOT_SETTABLE_ON_ROOM`). (M23_WRITE_SITE_AUDIT, M23_P2_SWEEP_REPORT)
- Signings have one writer, `POST /org/players/:id/signing`. No lifecycle transition may create a signing, because a signing bills the club. (M23_WRITE_SITE_AUDIT)
- An idempotent replay still checks permission first. Tables keyed by external data are null-prototype. (M23_P2_SWEEP_REPORT)

### Deployment (neither target is live; both are kept)
- One Docker image (`node:22-slim`, `NODE_ENV=production`) serves the API on port 4000 plus the club app at `/app`, Grassroots at `/grassroots`, Agent at `/agent` and the T&S console at `/console`, built same-origin (`VITE_API_URL=""`). Data lives on a volume at `/srv/data`. The Player app is exported separately (`npx expo export --platform web`) with `EXPO_PUBLIC_API_URL`. (DEPLOY, Dockerfile)
- `fly.toml` (region `lhr`) and `render.yaml` (health check `/orgs/directory`) both mount a volume at `/srv/data`. (DEPLOY)

## Server contracts (from the old operations runbook)

- Paging: a list that grows without limit pages "continue from here" — `?limit=` (1–100, default 50) and
  `?cursor=` (the previous page's `nextCursor`) give `{ items, nextCursor }`; `nextCursor` is null on the last page.
  A bad limit or cursor is refused (400 `PAGE_LIMIT_INVALID` / `PAGE_CURSOR_INVALID`), never clamped. One helper:
  `scoutbox-server/domains/platform/paging.mjs`. Paged so far: the club follow-ups (by due date) and the club
  signings (newest first). The apps read only the first page; a "load more" is not built yet (decided 4 Nov 2026).

- Sessions: the bearer token is returned once and stored only as SHA-256. No file, log,
  backup, `/capabilities` or admin view contains a plain token. Lifetime is
  `SESSION_TTL_DAYS` (30) measured from creation and judged against the current setting.
  Sign-out and revocation delete the row.
- One-time codes (club e-mail-domain challenge, child pairing code): stored hashed only.
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
- The guardian sign-up e-mail code is still stored in plain text.
- The persisted mail outbox withholds secret codes (`[code withheld …]`). The recipient
  still gets the full text.
- Notifications: the feed is newest first by insertion. An identical unread notification
  within 6 h refreshes the existing row in place and does not move it. A notification is
  never durable before the action it announces. Push and live events fire only after
  commit and never for a rolled-back operation.
- Categories `compliance` and `security_account` are mandatory and cannot be set to
  `false`. Preferences survive account deletion.
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
- Signed media URLs last 15 minutes. Each one is bound to the minting session, and the
  viewer's current entitlement is checked again on every fetch.

## Rate limits and test-only providers

- The old runbook has almost nothing for these docs. Their rate limits live in `RATE_LIMIT_POLICY` (`m181/rateLimit.mjs`).
- Agents: the synthetic licence register (`AGENT_VERIFICATION_TEST_PROVIDER`, which verifies any `TEST-VERIFIED-*` reference) is test-only, so an agent cannot self-verify in production.
- Matching-analytics: Combine CV verification stays disabled until real-world validation. Metrics that need a real detector are reported as unsupported, never estimated.

## Open questions and deferred work

- No expiry rule for recorded external contacts (M23_P2_SWEEP_REPORT).
- Lifecycle events are not emitted until a share boundary exists. Atomicity failure-injection was not built (M23_MATRIX).
- Design debt (PRE_M24_DEFECT_REGISTER): a functionless club "Network / Representation" screen; >500 kB bundles with no code splitting; about 87 English-only Player strings; clickable divs and a `useDialog` copied into three apps.
- Box Cam: replay attacks are not solved and over-cadence detection is partial (M22_CAPABILITIES).

## Also worth knowing

- M23_P57_DATE_PARSER_CONTRACT: its input/answer tables (including the New York and London DST cases) are a compact spec for `temporal.mjs`.

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

- ✓ The error table has no default: `httpStatusFor = code => M23_ERROR_HTTP[code] ?? null`, null-prototype table (`m23/errors.mjs:26,234`); `sendDomainError`/`publicErrorBody` at `:284,311`.
- ✓ Fatal production gates `ADMIN_KEY_UNSAFE`, `AGENT_TEST_PROVIDER_IN_PRODUCTION` and `TEST_PROVIDER_IN_PRODUCTION` exist (`m181/capabilities.mjs:137-187`), and boot throws on them (`server.mjs:5058-5066`).
- ✓ Media URLs are signed with `MEDIA_SECRET` only, which production requires (32+ characters). Development uses a per-process key; nothing is stored in the database.
- ✓ The temporal parsers exist (`temporal.mjs:91-311`). Quiet hours default to `PLATFORM_HOME_ZONE='Europe/London'` (`server.mjs:830`) and the zone is validated (`:4140`).
- ✓ Boot order loadSnapshot → runMigrations → … → `app.listen` (`server.mjs:184,190,5184`).
- ✓ The Node contract is ≥22.16 / ≥24 with no JSON fallback (`runtime.mjs:26,40`).
