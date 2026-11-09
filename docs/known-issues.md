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

- **A verification decision's T&S reviewer is declared, not authenticated.** The verification review routes take the
  shared admin key and a reviewer named in the request (`domains/verification/claims/index.mjs`), unlike the agent
  reviewers, who have their own sessions.
- **Lead authority comes from the role string typed at sign-in**, not from a role assigned by the organisation
  (`product/journey-analytics.md`).
- **Rate limits are counted per process** (`domains/platform/rateLimit.mjs`). Fine for one server; more than one
  process would multiply every limit.

## Data model and product

- **Two analytics figures ignore the Room filters**: `trial_process` and `overdue_trial_reports`
  (`product/journey-analytics.md`).

- **An invitation can bind to a colleague's existing account.** `/auth/org/accept-invite` binds the invite to
  whichever account of the organisation has the invited name, sets that account's e-mail to the invite's and returns
  a session without the account's MFA. So a lead who invites "Maria Keane" to their own address signs in as Maria.
  The fix is probably that an invite under a current colleague's name is refused, or needs that person's
  confirmation: a product question.
- **A coach affiliation is matched to a staff member by display name**, not by account (`m12/shared.mjs`). Keying it
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
- **The apps read only the first page of paged lists** (50 items): the player directory, the Film Room, matching,
  watchlists, Nobody Missed and the admin and club lists. Each has a comment where "load more" is needed. The
  player pickers (assessment, case, objective) walk every directory page; a large club needs a search box there.

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
- **Milestone names left in code.** Folders `m12/`, `m13/`, `m20/`, `m27/`; identifiers such as `registerM12`,
  `M23_ERROR_HTTP`, `S8D_KEY_OWNERS`, `*_CUTOVER_MIGRATION`; env vars `M13_FAST_RETRY` and `M13_QUIET_LOGS`; test
  files named `m23Live.test.mjs` and similar; and strings that carry tags: error messages ("(S13e)", "M16.2 trust
  policy weights…"), migration `note` strings, the `report()` write modes in `repositories/index.mjs`, the
  `/capabilities` note "moved from the snapshot blob", and test request bodies ("P5.6C suite: …").
- **Stale test labels** that need rewording, not just untagging: `e2e/platform/storeGuarantees.mjs` calls M23 "the
  LAST-registered module" (others register after it); labels with "used to" / "no longer" history in
  `e2e/agents/transactions.mjs`, `e2e/discovery/exposureCalibrationAndCoverage.mjs`, `e2e/platform/api.mjs` and
  `e2e/platform/dates.mjs`; milestone names used as feature names in recruitment and development labels.
- **A stray doc comment** in `domains/development/hub/shared.mjs`: the vocabulary assertion's comment sits above
  `scanCopyForForbiddenNames`'s, attached to nothing.

## Performance

What still misses the target in [`architecture.md`](architecture.md#performance-target), measured with a busy club at
100k players in the November 2026 perf runs (re-measure before acting on a figure). None touches every player on
a write.

- **Recruitment.** `/org/recruitment-analytics` (about 0.5 s) decodes records; it needs its own projections in SQL.
  `/org/rooms` (about 200 ms) and a Room (10–12 ms) are mostly the per-player Passport and Trust assembly. The Room
  comment write took about 75 ms. `/player/journeys`, `/player/signings`,
  `/player/offers` and `/player/trials` for a player in many clubs' Rooms decode every record of each club's case.
- **Discovery.** Matching, Nobody Missed and watchlists count their whole match set for `total` (about 30 ms per
  count; Nobody Missed counts three times, about 100 ms). Opening a watchlist compares its whole stored membership in
  code (about 0.4 s at 20,000 members) and writes its "as of" clock every time. Similar players, "more like this",
  the discovery rotation and the benchmarks rank every visible player over light rows. A first installation or a
  trust-policy change derives every player's match facts at boot in one transaction (about
  70 s at 100k players); each later write to an input re-derives its player before commit (about 0.7 ms).
- **Directory.** The Grassroots directory orders by distance, so each page sorts the players inside the club's
  radius. The Film Room pages by view count, which other scouts' views change, so a clip can move across a cursor
  while someone pages.
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
