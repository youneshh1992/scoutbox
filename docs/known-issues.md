# Known issues

Known defects and limits that are not fixed yet. Remove an entry when it's fixed. Items marked *feature* wait for the
end of the feature freeze.

## Configuration

- **A production server without SendGrid hands out the guardian e-mail code.** With no `SENDGRID_API_KEY` the mail
  adapter is the dev outbox, and `/auth/guardian/signup` then returns `devEmailCode` in its response, even under
  `NODE_ENV=production`. E-mail verification, the first safeguarding gate, is skipped in effect.
- **Production ID verification always approves.** There is no real IDV provider, so the dev attestation runs in
  every mode and any document reference passes. `/capabilities` says so (`authoritative_identity_provider:
  not_configured`), but nothing stops a production guardian from completing the ID gate.

## Security

- **The admin console key has a default.** With no `ADMIN_KEY` set, `server.mjs` accepts `scoutbox-admin` as the
  `x-admin-key` for every `/admin` route, including the guardian ID review, in every mode. Secrets should have no
  default: the server should refuse to serve `/admin` without a key (and the setting should be registered in
  `domains/platform/capabilities.mjs`). The tests and the seed scripts send the default key and would need to set it.
- **A verification decision's T&S reviewer is declared, not authenticated.** The verification review routes take the
  shared admin key and a reviewer named in the request (`domains/verification/claims/index.mjs`), unlike the agent
  reviewers, who have their own sessions.
- **Lead authority comes from the role string typed at sign-in**, not from a role assigned by the organisation
  (`product/journey-analytics.md`).
- **Rate limits are counted per process** (`domains/platform/rateLimit.mjs`). Fine for one server; more than one
  process would multiply every limit.
- **Verification responses spread stored records.** The evidence routes in `domains/verification/claims/review.mjs`
  return `evidence: ev` and `{ ...ev, mediaId: undefined }`; the root-request rejection returns `{ ...rejected, … }`
  and the disputes list `{ ...d }`. A new column would reach the response unasked.

## Data model and product

- **Two analytics figures ignore the Room filters**: `trial_process` and `overdue_trial_reports`
  (`product/journey-analytics.md`).

- **An invitation can bind to a colleague's existing account.** `/auth/org/accept-invite` binds the invite to
  whichever account of the organisation has the invited name, sets that account's e-mail to the invite's and returns
  a session without the account's MFA. So a lead who invites "Maria Keane" to their own address signs in as Maria.
  The fix is probably that an invite under a current colleague's name is refused, or needs that person's
  confirmation: a product question.
- **Club e-mail verification has its own list of free-mail providers.** `domains/verification/clubChecks.mjs` refuses
  fewer providers than the claims' list (`domains/verification/claims/shared.mjs`), so an address at a provider only
  the claims' list knows (for example `yandex` or `zoho`) can verify a club's domain. The shared list can't simply be
  reused, because it also refuses `mail.` hosts, and a club's own `mail.club.example` mailbox does prove control of its
  domain. The fix is one shared list with that difference made explicit.
- **A coach affiliation is matched to a staff member by display name**, not by account (`domains/platform/routeHelpers.mjs`). Keying it
  by account would restrict affiliations to people with a login: a product question.
- **Assessment templates are shared by every club.** When one club's lead publishes a new version of a position
  template (`POST /org/assessment-templates`), it becomes the current template for every club: other clubs' new
  assessments use it, though reports already written keep their version. The fix: each club gets its own templates
  (an `org_id` on `assessment_templates`), starting from the four standard v1 templates.
- **Evidence records copy people's names as text and cut them at 200 characters.** The evidence passport, disputes,
  evidence history, coach affiliations and squad invitations store a copy of the player's, scout's or club's name
  (an org dispute stores "scout · club"). Player signup has no name length limit, and a scout name plus a club
  name can reach 243 characters, so `domains/scouting/passport.mjs` (`storedName`) shortens names to fit rather
  than failing the action. The robust fix is to store only the id and read the current name, which also stops the
  copies going stale when someone renames themselves.
- **`orgs.verified` is kept in step by code**, not derived from the organisation's verification claims.
- **Staff quiet hours are saved but never applied.** `PUT /org/delivery/prefs` stores them, but the delivery centre
  only honours the e-mail on/off switch for staff (players' and guardians' quiet hours do work). *Feature.*
- **A grassroots club approved through a Trust & Safety application is placed in central London.** The claim review
  (`domains/verification/claims/review.mjs`) creates the club at 51.5, -0.1 with the federation registration
  "pending", because the application has no ground location. Its 50 km scouting radius, its place on players' "clubs
  near you" radar and the friendlies board are then measured from a ground that isn't real, and the club can't
  correct it. Clubs that register directly give their real ground. The fix (asking for the ground on the
  application, with a place-to-coordinates lookup) is a *feature* (Founder, 7 Nov).
- **The sign-in screens list every organisation.** `GET /orgs` returns the whole list for the club picker; it isn't
  paged because the apps have no search, so clubs past the first page couldn't find themselves. It needs a name
  search before there are many clubs. *Feature* (Founder, 7 Nov).
- **Screens show the server's error message.** About a hundred places in the apps (`notify(e.message)`, and the Rooms
  screens' fallback) put the API's `message` on screen. It is developer English, untranslated, and for routes moved
  to the input schemas it is the generic wording (`reasons is required.`) rather than the hand-written sentence some
  routes had. The fix is client-side wording from each refusal's `problem`
  ([`app-layer-architecture-improvements.md`](app-layer-architecture-improvements.md), step 6).
- **The apps read only the first page of paged lists** (50 items): the player directory, the Film Room, matching,
  watchlists, Nobody Missed and the admin and club lists. Each has a comment where "load more" is needed. The
  player pickers (assessment, case, objective) walk every directory page; a large club needs a search box there.

## Defects

Found in the November 2026 comment trim (10 Nov). Not yet fixed.

- **`?window=constructor` crashes recruitment analytics.** `WINDOW_PRESETS` (`domains/recruitment/analytics/metrics.mjs`)
  is a plain object indexed by the client's `?window=`, so an inherited key such as `constructor` passes the
  unknown-window check and the route answers 500. It needs a null-prototype table or an own-property check.
- **An expired agent agreement gives a 500, not a 403.** `representationScopeProblem`
  (`domains/agents/compliance/policy.mjs`) returns `REPRESENTATION_EXPIRED`, which the compliance error table maps but
  `TRANSACTION_ERROR_HTTP` (`domains/agents/transactions/errors.mjs`) does not, so
  `POST /org/agent/transactions/:id/representations` answers `TRANSACTION_STATE_UNKNOWN`.
- **Writes outside a unit, or side effects before commit.**
  - Decision drafts: `cases.startDraft`, `editDraft` and `discardDraft` run outside `unit()`
    (`domains/recruitment/lifecycle/decisionRoutes.mjs`), and `editDraft` writes no history entry.
  - Transaction handoff: invite and withdraw (`domains/agents/integration/index.mjs`) write and notify with no unit and
    no `afterCommit`.
  - Signed documents: `evidence.add` writes the vault row before the unit (`domains/recruitment/signings/index.mjs`
    `storeDocument`), so a failed unit leaves an orphan row.
  - Offer sharing: the share-agent route (`domains/recruitment/offers/index.mjs`) calls `notify` inside the unit rather
    than through `afterCommit`.
  - Film Room: `GET /feed` (`domains/discovery/filmRoom.mjs`) writes the reminder-sent flag and notifies outside a unit.
    Its view and tag counters are read-modify-write, so concurrent requests lose counts.
- **The offer issue route returns a stale `rev`.** It answers `kase.room.rev` from the case as read before the move
  (`domains/recruitment/offers/index.mjs`).
- **The claims verification sweep ignores refusals.** `verificationSweep` (`domains/verification/claims/review.mjs`)
  notifies and counts a claim whose `transition()` was refused, one thrown unit stops the rest of the sweep (unlike
  `transitionSweep`), and its warning date uses the server's time zone.
- **A Pro brief with a radius matches nobody.** Only Grassroots clubs may use distance, so the geography criterion is
  false for a Pro club (`domains/discovery/matching/match.mjs`), but a Pro brief with `radiusKm` is accepted rather
  than refused.
- **A watchlist alert can go to a removed staff member.** The watchlist notification goes to `w.createdBy` without the
  `removedAt` check that Second Look makes (`domains/discovery/matching/index.mjs`).
- **The Box Cam source freeze misses some code lines.** `strippedSource` (`domains/development/boxcam/cv/freeze.mjs`)
  drops every line starting with `*` as a comment, including code continuation lines such as
  `* CAPTURE_REQUIREMENTS.lowFpsIntervalTolerance;` in `track.mjs`, so a change there doesn't change the freeze hash.
- **The public passport-share limiter is its own unpruned Map** (`domains/verification/passport/sharing.mjs`) rather
  than the shared `rateLimit`.

## Code clean-up

Found in the November 2026 comment sweep. None is reachable as data loss today; each is a rule the code doesn't yet
keep, or code with nothing left to do.

- **Plain-text passwords are still accepted.** `adapters.mjs` `verifyPassword` accepts a plain-text password record
  and upgrades it on sign-in (player, guardian and organisation logins call the upgrade). The routes hash every
  password they write, so this may only serve seed records that set a password in plain text: check the seed import
  before removing it.
- **Two guardian views spread the stored record.** `guardianChildView` and `guardianSelfView` (`views/playerViews.mjs`)
  copy the record minus its secrets instead of building an allowlist, so a new column would reach the response
  unasked.
- **The signing typers repair input instead of refusing it.** `repositories/signingsFollowUps.mjs` turns a missing
  `method` into `LEGACY_RECORDED`, a missing `rev` or `policyVersion` into 1, drops unknown fields, and reports each in
  `notes`, against the valid-input-only rule.
- **The `/admin` key has a default** (`ADMIN_KEY || 'scoutbox-admin'` in `server.mjs`). Production refuses to boot
  with it (`ADMIN_KEY_UNSAFE`), but the rule is that secrets have no defaults.
- **An agent dispute notice is out of date.** It says attributed T&S review "is not yet available in this build"
  (`domains/agents/core/index.mjs`), but attributed reviewers exist and resolve disputes. `e2e/agents/core.mjs`
  asserts the wording, so the copy and the check change together.
- **Rate-limit policy and the auth limiter disagree.** `RATE_LIMIT_POLICY` (`domains/platform/rateLimit.mjs`) lists
  `auth_attempt` at 30 a minute, but the `/auth` limiter in `server.mjs` allows 40 and nothing seems to read the row.
- **Keys that may now be possible.** `dispatches.org_id` is deferred for a reason that no longer holds (organisations
  are written explicitly). Guardian ids on recruitment requests and trials and on the safety and audit tables carry no
  key for reasons that no longer hold either; a real key may now be possible.
- **Probably dead code:** `sessions.exportRows` (no callers); `oneTimeCodes.validatePairingCodeRow`, which still
  accepts the old plain-code format, and `exportEmailChallenges` / `exportPairingCodes` (used only by
  `scripts/testOneTimeCodes.mjs`); the old fingerprint without a mode accepted in
  `domains/recruitment/lifecycle/contactRoutes.mjs`; `ctx.combineFacts` (only passed through in `server.mjs`); the
  media queue's `liveRecords` option.
- **Tests that test nothing or test old data.** The "a save writes no row" checks in `scripts/testSigningsFollowUps.mjs`
  and `scripts/testRecruitmentContactsOffers.mjs` compare two dumps with no save between them. `s3File` in
  `scripts/coreIdentityTestFixtures.mjs` and the "stale legacy table" test in `scripts/testCoreIdentityServer.mjs`
  still build old `collections` files. One `testUnitOfWork` label still says "memory restored".
- **Milestone names left in the apps.** The server and the browser suites are clean, but the apps still use them:
  files such as `m18Api.ts`, `m20Demo.ts`, `M15Sections.tsx` and `m13tabs.tsx` (about 90 files across the player, Pro,
  Grassroots and admin apps), i18n keys (`m19.*`, `m20.*`, `m21.*`), `data-testid="m22-cv"`, the admin route
  `/admin/m22/validation`, committed screenshot names (`m24f3-after-*.png`) and the agent app's copy ("P5.6A gate
  G-C0"). `e2e/launcher.html` is release notes laid out by milestone. Renaming them is a pass over each app with its
  tests.
- **Stale test labels** that need rewording, not just untagging: labels with "used to" / "no longer" history in
  `e2e/agents/transactions.mjs`, `e2e/discovery/exposureCalibrationAndCoverage.mjs`, `e2e/platform/api.mjs` and
  `e2e/platform/dates.mjs`.
- **One rule, several definitions.** `ROLE_RANK` is defined in `lifecycle.mjs`, `journeyModel.mjs`, `contact.mjs` and
  `trial.mjs` (`domains/recruitment/lifecycle/`) and mirrored by `roomCan` in `rooms/shared.mjs`. `PRO_STAGES` /
  `GRASSROOTS_STAGES` are defined in both `domains/scouting/scouting.mjs` and `rooms/shared.mjs`, with nothing
  asserting they match. `/rooms/needs-attention` spells out `DECISION_OWED_STATUSES`. `briefCriteriaToCanonical`
  (`domains/discovery/matching/match.mjs`) copies `criterionId`'s id rule.
- **Environment settings read directly.** `SCOUTBOX_FAST_SWEEPS` and `TEST_LICENCE_REGISTRY` are not registered in
  `domains/platform/capabilities.mjs`, and `domains/recruitment/analytics/index.mjs` reads `NODE_ENV` directly.
- **Text cut instead of refused.** The open-day outcome note and release reference
  (`domains/development/grassrootsClub.mjs`) and the objectives' "shortened" texts (`objectives.mjs`) use `.slice()`.
- **Notification copy is incomplete.** The `PREF_CATEGORY_MANDATORY` refusal (`domains/platform/notificationPrefs.mjs`)
  names only security and account notices, but `compliance` is mandatory too, and the `/capabilities` note
  (`operator.mjs`) does the same.
- **Event audience and fingerprint gaps (latent).** `eventFingerprint` (`domains/platform/eventRegistry.mjs`) keys on
  ids that the development, assessment and trial payloads don't carry, so each of those events has one fingerprint.
  `org_member` is documented as "may currently see the subject" (`eventAudience.mjs`) but `liveSync` delivers it to
  any org. Only `e2e/platform/contracts.mjs` uses the first, and no event uses the second.
- **Trust and Passport calculations that do nothing.** `calculateTrustScore` (`domains/verification/trust/shared.mjs`)
  sets `excludedComponents` to `[]` on both branches, never applies `POLICY.evidence.recencyDays`, and
  `scoreEvidenceConfidence` ignores `now`. In `passport/shared.mjs`, `a.confirmation || true` and
  `provRank(...) >= 0` are always true. In `compliance/policy.mjs` `evaluateMinorGate`,
  `r.code !== 'FACET_VERIFIED' || true` filters nothing.
- **Trust profile inconsistencies.** The org trust-profile route (`domains/verification/trust/trust.mjs`) tests
  `req.org.type === 'grassroots'` where the rest of the code uses `org.level`, and a blocked player gets 403
  `NOT_VISIBLE` where search conceals with 404.
- **Draft-style updates left in compliance.** The reviewer revoke and policy approve routes
  (`domains/agents/compliance/index.mjs`) still edit records through `reviewers.update` / `policies.update` callbacks.
- **More probably dead code:** `JOURNEY_REQUIRED_STORES` / `JOURNEY_OPTIONAL_STORES` (empty arrays,
  `domains/recruitment/lifecycle/journey.mjs`); the second `boxSessionId` string check and `void at;` in
  `trialRoutes.mjs`; the unused `find` in `domains/development/hub/evidence.mjs` `recordBelongsToPlayer`; the unused
  `roomId` in `domains/discovery/secondLook.mjs` `latestSnapshot`. `buildTrend` in
  `domains/recruitment/analytics/dashboard.mjs` runs outside the per-family `try`, so one throw fails the dashboard.
- **Product text with milestone codes:** the `/recruitment/offer-policy` note ("P6 writes no signing") and the
  'M14 migration…' event reason in `domains/verification/claims/shared.mjs`; the identifier `safeM18Projection`
  (`secondLook.mjs`).
- **The trial evidence-unlink route** (`trialRoutes.mjs`) takes no client key and has no rate limit, unlike the other
  trial writes. Possibly intended.

## Performance

What still misses the target in [`architecture.md`](architecture.md#performance-target), measured with a busy club at
100k players (`npm run perf:recruitment`, 10 November 2026: 19 of 56 timed reads under 5 ms; re-measure before
acting on a figure). None touches every player on a write.

- **Recruitment.** `/org/audit` (about 0.85 s for the busy club, 70 ms for a typical one) and
  `/org/recruitment-analytics` (about 0.45 s) decode records; they need their own projections in SQL. `/org/rooms`
  (about 130 ms) and a Room (about 5.5 ms) are mostly the per-player Passport and Trust assembly. `/org/followups`
  takes about 35 ms. The Room comment write takes about 12 ms. `/player/journeys` (about 130 ms), `/player/offers`
  (about 60 ms), `/player/signings` (about 50 ms) and `/player/trials` (about 12 ms) for a player in many clubs'
  Rooms decode every record of each club's case. `/player/followups` (about 12 ms for 573 follow-ups) reads each
  one's outcome report by id.
- **Discovery.** Matching, Nobody Missed and watchlists count their whole match set for `total` (matching about
  40–70 ms; Nobody Missed counts three times, about 100 ms). Opening a watchlist compares its whole stored membership
  in code (about 0.4 s at 20,000 members) and writes its "as of" clock every time. A player's profile and "more like
  this" (about 0.55 s each), the discovery rotation (about 0.5 s) and the benchmarks (about 120 ms) rank every
  visible player over light rows. A first installation or a trust-policy change derives every player's match facts at
  boot in one transaction (the 100k-player boot takes about 130 s); each later write to an input re-derives its
  player before commit (about 0.7 ms).
- **Directory.** The Grassroots directory orders by distance, so each page sorts the players inside the club's
  radius; the Grassroots directory, Film Room, feed and fixtures take about 90–150 ms each. The Film Room pages by
  view count, which other scouts' views change, so a clip can move across a cursor while someone pages.
- **Sweeps.** "Signings missing follow-ups" counts every signing's follow-ups each minute (about 140 ms at 10,000
  signings).
- **Lists filtered in code after SQL** (bounded by one club, not the player base): the Development Hub's plan list,
  Box Cam's assignment, challenge and Combine request lists, the friendlies board and a guardian's local open days
  (a latitude/longitude box in SQL, the exact 50 km test in code), the player opportunity board, insight's review
  queue (live visibility per player), suggested coverage visits, and saved-search alerts for a new player.
- **Ledger and threads.** `/org/reputation` is a `GROUP BY` over the whole ledger on every request; it needs its own
  projection. The admin report triage sorts the whole reports table per page (no index serves its computed rank). A
  page of a club's inbox decodes each thread's messages whole, so it grows with the length of its conversations.
- **Unpaged per-person lists that can grow:** a person's notification feed (read whole; a busy staff member's bell
  grows with their history), a player's "who's watching" insights and the data export.
- **Transactions.** A transaction projection reads each one's consents, context and evaluation by id; the T&S
  stale-snapshot figure and the agency audit decode their records. Bounded by one agent, one club or the live
  transactions.

## Tests

- **`testBackup` failed once in about 40 parallel `npm test` runs** (3 Nov), and the log wasn't kept. Its strictest
  check compares the backup with the source table for table, so anything the server writes after the copy (other
  than the `backup_created` event) fails it. If it fails again, note which table differed.
- **`testWriterAtomicity` failed once in five full `npm test` runs** (4 Nov), and the log wasn't kept. If it fails
  again, keep the runner's log.
- **`testRecruitmentContactsOffersServer` failed once in three full `npm test` runs** (4 Nov): "reading seen offers
  commits nothing" (`data_version` 3, expected 2). The check asserts that nothing commits in a 3-second window, so a
  late commit of the earlier offer writes under load is the likely cause. If it fails again, note what committed in
  the window.
- **`e2e/agents/compliancePersistence` failed once in three full `npm run e2e` runs** (9 Nov), and the log wasn't
  kept. It passed alone four times and in the next two full runs. If it fails again, keep the runner's log.
- **`e2e/platform/contracts.mjs` fails one check**: `orgPanels.tsx` is no longer byte-identical in `scoutbox-club` and
  `scoutbox-grassroots` (which must share business logic). Grassroots shows audit entries as structured facts since
  `7f93a14` (1 Nov); Club still shows one sentence. Deciding which one both apps use is a design question. It is a
  `knownFailure` check ("orgPanels.tsx drift"), so the battery runs in CI.
- **`e2e/navConfig.test.mjs` fails** (also on `c436154`): the club and Grassroots nav still list the removed
  "representation" destination.
- **`e2e/m24f2DensityAudit` (3 checks) and `e2e/m24fVisualAudit` (2 checks) fail**: Player Account categories, the
  portal ™ label, the Grassroots and Player Home single primary action, and the Player Card/ListRow check. Triage
  them against [`design.md`](design.md).
- **About 20 of the 56 end-to-end batteries check source text, not behaviour.** They read server and app source
  files and match regular expressions against them ("every side effect is wrapped in `safe()`", "*Try again* only
  when retryable", "the request log line has these fields"). Such a check passes while the text matches, even if
  the behaviour is broken, and fails on harmless rewrites (the Biome reformat broke nine). Replace the ones that
  guard real behaviour with tests that exercise it, and ask Tom before dropping the ones that only describe code
  layout.
