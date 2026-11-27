# Known issues

Known defects and limits that are not fixed yet. Remove an entry when it's fixed. Items marked *feature* wait for the
end of the feature freeze. Server paths are relative to `scoutbox-server/`, the Gleam server; the TypeScript server in
`scoutbox-server-ts/` is being retired, and nothing here is fixed there.

## Configuration

- **A production server without SendGrid hands out the guardian e-mail code.** With no `SENDGRID_API_KEY` the mail
  transport is the dev outbox (`src/scoutbox/messaging/transport.gleam`), and `/auth/guardian/signup` then returns
  `devEmailCode` in its response (`src/scoutbox/identity/guardian_routes.gleam`), even under `NODE_ENV=production`.
  E-mail verification, the first safeguarding gate, is skipped in effect.
- **Production ID verification always approves.** There is no real IDV provider, so the dev attestation
  (`src/scoutbox/identity/idv.gleam`) runs in every mode and any document reference passes. `/capabilities` says so
  (`authoritative_identity_provider: not_configured`), but nothing stops a production guardian from completing the
  ID gate.

## Security

- **The admin console key has a default outside production.** With no `ADMIN_KEY` set,
  `src/scoutbox/platform/config.gleam` falls back to `scoutbox-admin` as the `x-admin-key` for every `/admin` route,
  including the guardian ID review. Production refuses to boot without a safe key (`ADMIN_KEY_UNSAFE`), but any other
  deployment (a staging server without `NODE_ENV=production`, say) serves `/admin` behind a publicly known key.
  Secrets should have no default: the server should refuse to serve `/admin` without a key in every mode. The
  batteries and the seed scripts send the default key and would need to set it.
- **A verification decision's T&S reviewer is declared, not authenticated.** The verification review routes take the
  shared admin key and a reviewer named in the request's headers (`src/scoutbox/verification/reviewer.gleam`), unlike
  the agent reviewers, who have their own sessions.
- **Rate limits are counted per process** (`src/scoutbox/platform/limits.gleam`). Fine for one server; more than one
  process would multiply every limit.

## Data model and product

- **Scout track records are not computed yet.** `reputation_seed` holds the figures a scout's track record is meant to
  show (discoveries, success rate, average resale multiple), but only the demo (`priv/seed.sql`) fills it; nothing in
  the product writes it, and production's is empty. The live rows `/org/reputation` computes from the ledger
  (`src/scoutbox/recruitment/request_routes.gleam`) count views, contacts, trials and signings only. Building the
  track record needs the Founder to define each figure (what counts as a discovery and a success, where a resale
  value comes from); the live rows should then carry them, and the table can go. Until then the demo shows figures
  the product cannot produce.
- **Two analytics figures ignore the Room filters**: `trial_process` and `overdue_trial_reports` read every trial and
  invitation, not the filtered Rooms' (`src/scoutbox/recruitment/analytics/context.gleam`;
  `product/journey-analytics.md`).
- **An invitation can bind to a colleague's existing account.** `/auth/org/accept-invite`
  (`src/scoutbox/identity/invite_routes.gleam`) binds the invite to whichever account of the organisation has the
  invited name, sets that account's e-mail to the invite's and returns a session without the account's MFA. So a lead
  who invites "Maria Keane" to their own address signs in as Maria. The fix is probably that an invite under a current
  colleague's name is refused, or needs that person's confirmation: a product question.
- **Club e-mail verification has its own list of free-mail providers.** `src/scoutbox/verification/club_checks.gleam`
  refuses fewer providers than the claims' list (`is_free_mail` in `src/scoutbox/verification/claims.gleam`), so an
  address at a provider only the claims' list knows (for example `yandex` or `zoho`) can verify a club's domain. The
  shared list can't simply be reused, because it also refuses `mail.` hosts, and a club's own `mail.club.example`
  mailbox does prove control of its domain. The fix is one shared list with that difference made explicit.
- **A coach affiliation is matched to a staff member by display name**, not by account (`active_for` in
  `src/scoutbox/scouting/coaches.gleam`). Keying it by account would restrict affiliations to people with a login: a
  product question.
- **Assessment templates are shared by every club.** When one club's lead publishes a new version of a position
  template (`POST /org/assessment-templates`), it becomes the current template for every club: other clubs' new
  assessments use it, though reports already written keep their version. The fix: each club gets its own templates
  (an `org_id` on `assessment_templates`), starting from the four standard v1 templates.
- **Evidence records copy people's names as text and cut them at 200 characters.** The evidence passport, disputes,
  evidence history, coach affiliations and squad invitations store a copy of the player's, scout's or club's name
  (an org dispute stores "scout · club"). Each name is at most 120 characters, but a scout name plus a club name can
  reach 243, so `stored_name` in `src/scoutbox/scouting/evidence.gleam` shortens names to fit rather than failing
  the action. The robust fix is to store only the id and read the current name, which also stops the copies going
  stale when someone renames themselves.
- **`orgs.verified` is kept in step by code**, not derived from the organisation's verification claims.
- **Staff quiet hours are saved but never applied.** `PUT /org/delivery/prefs` stores them, but the delivery centre
  only honours the e-mail on/off switch for staff (players' and guardians' quiet hours do work;
  `src/scoutbox/messaging/notifications.gleam`). *Feature.*
- **A grassroots club approved through a Trust & Safety application is placed in central London.** The application
  review (`src/scoutbox/verification/applications.gleam`) creates the club at 51.5, -0.1 with the federation
  registration "pending", because the application has no ground location. Its 50 km scouting radius, its place on
  players' "clubs near you" radar and the friendlies board are then measured from a ground that isn't real, and the
  club can't correct it. Clubs that register directly give their real ground. The fix (asking for the ground on the
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

Found in the November 2026 comment trim (10 Nov), and still in the Gleam server. Not yet fixed.

- **An expired agent agreement gives a 500, not a 403.** `approach_policy.scope_problem`
  (`src/scoutbox/agents/approach_policy.gleam`) returns `REPRESENTATION_EXPIRED`, which the compliance contract maps
  (`compliance_routes.gleam`) but the transaction contract (`src/scoutbox/agents/transaction_routes.gleam`) does not,
  so `POST /org/agent/transactions/:id/representations` answers `TRANSACTION_STATE_UNKNOWN`.
- **A decision draft's edit writes no history entry.** `case_routes.edit_draft`
  (`src/scoutbox/recruitment/case_routes.gleam`) changes the draft through `decisions.edit_draft` without a
  `cases.record` entry, where starting a draft records `room_decision_drafted`. Only the draft's own `updated_by_*`
  columns say who last changed it.
- **Some reads bring workflow state up to date, because nothing runs on a schedule for them.** Opening a watchlist
  reconciles its membership (`src/scoutbox/discovery/watchlists.gleam`), opening Second Look reconciles its queue
  (`discovery/second_look.gleam`), building a Room or a player's evidence gaps reconciles the gap suggestions
  (`recruitment/room_view.gleam`, `insight/evidence_gaps.gleam`), and the Film Room feed sends the trial-report
  reminder (`discovery/org_feed.gleam`). Each read runs in a `store.unit`, but each belongs in a sweep, as
  [`architecture.md`](architecture.md#writes) says.
- **The offer issue route returns a stale `rev`.** `offer_routes.issue` (`src/scoutbox/recruitment/offer_routes.gleam`)
  answers `room.rev` from the case as read before the lifecycle move and the case audit entry.
- **The claims expiry sweep ignores refusals.** `sweep` (`src/scoutbox/verification/review_routes.gleam`) goes on
  when `core.transition` answers a refusal: it still tells the claim's subject the claim expired, and it counts every
  claim it found, whether or not it changed.
- **The Pro brief form offers a radius.** The brief form (`scoutbox-club/src/m18Screens.tsx`) shows the radius field
  to a Pro club, but the server refuses a Pro brief with a radius (`BRIEF_RADIUS_NOT_AVAILABLE`,
  `src/scoutbox/discovery/briefs.gleam`), because a Pro club cannot see distance. The field should be shown to
  Grassroots clubs only, which is a UI change.
- **A watchlist alert can go to a removed staff member.** The watchlist notification goes to
  `w.row.created_by_user_id` without the `removed_at` check that Second Look's `notify_owner` makes
  (`src/scoutbox/discovery/watchlists.gleam`, `discovery/second_look.gleam`).
- **What cancelling a trial day means is undecided.** A trial has one trial day today: its staff, arrival, consent,
  emergency contact and check-in, shared by all its sessions. `POST /org/trials/:id/cancel`
  (`trial_day.day_status` in `src/scoutbox/recruitment/trial_day.gleam`) records a day status event, blocks check-in
  and tells the family "X cancelled this trial day", but the trial stays open: it can still be completed, and because
  a case has one open trial, no new invitation can be sent for that case. If a cancelled day means the trial is off,
  the day's cancel should go through the trial's own cancel (`trial_routes.cancel`,
  `src/scoutbox/recruitment/trial_routes.gleam`). If trials are to have several trial days, a day's cancellation is
  its own thing and the day records need a day of their own. A question for the Founder. Either way, the day's
  cancel and postpone skip what the trial's own cancel checks: the Room's permission (any club staff member can use
  them, not only a Room lead or recruitment lead), the revision gate, the rate limit and moderation of the reason.

## Code clean-up

Found in the November 2026 comment sweep. None is reachable as data loss today; each is a rule the code doesn't yet
keep, or code with nothing left to do.

- **An agent dispute notice is out of date.** It says attributed T&S review "is not yet available in this build"
  (`src/scoutbox/agents/core_routes.gleam`), but attributed reviewers exist and resolve disputes.
  `e2e/agents/core.mjs` asserts the wording, so the copy and the check change together.
- **Keys that may now be possible.** `dispatches.org_id` is deferred to COMMIT (`priv/migrations/0010_dispatches.sql`)
  for a reason that may no longer hold (organisations are written explicitly). Guardian ids on recruitment requests,
  trials, contacts and offers (`guardian_id`, `recipient_guardian_id` in `0015_recruitment.sql` and
  `0017_recruitment_contacts_offers.sql`) and on the IDV queue (`0013_safety_audit.sql`) carry no key ("checked in
  code"); a real key may now be possible.
- **Probably dead code:** the old fingerprint without a mode, still accepted as a contact's idempotency match in
  `src/scoutbox/recruitment/contact_routes.gleam`.
- **Milestone names left in the apps.** The apps still use them: files such as `m18Api.ts`, `m20Demo.ts`,
  `M15Sections.tsx` and `m13tabs.tsx` (about 90 files across the player, Pro, Grassroots and admin apps), i18n keys
  (`m19.*`, `m20.*`, `m21.*`), `data-testid="m22-cv"`, the admin route `/admin/m22/validation`, committed screenshot
  names (`m24f3-after-*.png`) and the agent app's copy ("P5.6A gate G-C0"). `e2e/launcher.html` is release notes laid
  out by milestone. Renaming them is a pass over each app with its tests.
- **Stale test labels** that need rewording, not just untagging: labels with "used to" / "no longer" history in
  `e2e/agents/transactions.mjs`, `e2e/discovery/exposureCalibrationAndCoverage.mjs` and `e2e/platform/dates.mjs`.
- **One rule, several definitions.** `room_rules.role_rank` (`src/scoutbox/recruitment/room_rules.gleam`) is copied
  as its own rank table in `case_lifecycle.gleam` (`rank`), `room_routes.gleam` (`move_body`), `contact_rules.gleam`
  and `trial_rules.gleam` (`role_allows`), all in `src/scoutbox/recruitment/`. `/rooms/needs-attention`
  (`room_routes.needs_attention`) spells out the decision-owed statuses that `analytics/time_series.gleam` declares
  as `decision_owed_statuses`.
- **Notification copy is incomplete.** The `PREF_CATEGORY_MANDATORY` refusal
  (`src/scoutbox/messaging/notification_prefs.gleam`) names only security and account notices, but `compliance` is
  mandatory too, and the `/capabilities` note (`platform/operator.gleam`) names only `security_account`.
- **Trust calculations that do nothing.** `trust_rules.calculate` (`src/scoutbox/passport/trust_rules.gleam`) always
  reports `excludedComponents` as `[]`, and never applies `recency_days`, which only the published policy shows.
- **Trust profile inconsistencies.** The org trust-profile route (`trust.org_view`, `src/scoutbox/passport/trust.gleam`)
  always projects for a Pro club (`ProClubViewer`), so a Grassroots club gets the Pro view, and a blocked player gets
  403 `NOT_VISIBLE` where search conceals with 404.
- **Product text with a milestone code:** the `/recruitment/offer-policy` note ("P6 writes no signing",
  `src/scoutbox/recruitment/offer_routes.gleam`).
- **The trial evidence-unlink route** (`trial_routes.unlink`, `src/scoutbox/recruitment/trial_routes.gleam`) takes no
  client key and has no rate limit, unlike the other trial writes. Possibly intended.
- **`orgPanels.tsx` differs between `scoutbox-club` and `scoutbox-grassroots`** (which must share business logic).
  Grassroots shows audit entries as structured facts since `7f93a14` (1 Nov); Club still shows one sentence.
  Deciding which one both apps use is a design question.

## Performance

What may miss the target in [`architecture.md`](architecture.md#performance-target). None of it is measured on this
server: `scoutbox-server/dev/perf.mjs` (`gleam export erlang-shipment && node dev/perf.mjs [players=10000]`) times
only the org player view and a report resolution, so each entry below is a shape read from the code, not a figure.
Paths here are under `src/scoutbox/`. Password hashing and the directory text search have entries of their own
below.

- **Recruitment.** `/org/audit` (`enterprise/org_audit.gleam`) reads every source whole (room, trial, contact,
  brief, watchlist, development and ledger history, and an agency's audit), filters actions in code, looks up each
  entry's player, and sorts and pages the pool in memory. `/org/recruitment-analytics`
  (`recruitment/analytics/context.gleam`) reads about a dozen of the club's tables whole and computes every figure
  in code. A page of `/org/rooms` and a Room assemble each player's Passport and Trust profile
  (`recruitment/room_view.sources`). `/player/journeys` (`recruitment/journey.for_recipient`) loads every record of
  each club's case for a player in many clubs' Rooms. `/player/offers`, `/player/signings` and `/player/trials` read
  all of the player's records unpaged, each assembled from its child rows plus by-id lookups of its room, offer,
  org or signing (`recruitment/offer_routes.recipient_offers`, `recruitment/signing_routes.recipient_packages`,
  `recruitment/trials.assemble`). `/player/followups` is unpaged and reads each follow-up's outcome report,
  confirmations, player and org by id (`operations/follow_ups.view`).
- **Discovery.** Matching, Nobody Missed and watchlists count their whole match set for `total`
  (`discovery/matching/query.count`; Nobody Missed counts three times: eligible, evaluated and closed). Opening a
  watchlist (`discovery/watchlists.reconcile`, in a write unit on every GET) reads every matching id, compares it in
  code with the stored membership (pairing members with their checks by a linear scan per member), then deletes and
  reinserts every member and check row and writes `last_reconciled_at`. A player's profile and "more like this"
  score every visible player in SQL per request (`discovery/similarity.most_similar`; the position group first,
  then everyone if that can't decide). The discovery rotation reads every visible unassessed player's id and hashes
  them in code (`insight/exposure.rotation`). The benchmarks decode every amateur and semi-pro player of the
  position group (`development/benchmarks.found`). A first installation or a trust-policy change re-derives every
  player's match facts at boot in one unit (`discovery/match_facts.start`); each later write re-derives its
  marked players before COMMIT (`match_facts.drain`).
- **Directory.** The Grassroots directory orders by distance, a computed expression no index serves, so each page
  sorts the players inside the club's radius (`discovery/directory.directory_order`). The Film Room pages by view
  count, which other scouts' views change, so a clip can move across a cursor while someone pages.
- **Sweeps.** "Signings missing follow-ups" counts every signing's follow-ups each minute
  (`operations/follow_ups.backfill`, a correlated `COUNT(*)` per signing).
- **Lists filtered in code after SQL** (bounded by one club, not the player base): the Development Hub's plan list
  (each plan's player and access in code), Box Cam's assignment and challenge lists and the Combine request list
  (read whole, filtered and paged in code: `development/box_training.page_newest_first`), a guardian's local open
  days (each host's visibility of the child in code), the player opportunity board (eligibility in code), insight's
  review queue (live visibility per player), suggested coverage visits, and saved-search alerts for a new player
  (the club's visibility and the full match in code, per saved search).
- **Ledger and threads.** `/org/reputation` is a `GROUP BY` over the whole ledger on every request
  (`safety/ledger.counts_by_actor`); it needs its own projection. The admin report triage sorts the whole reports
  table per page (`safety/audit.triage_page`: no index serves its computed rank). A page of a club's inbox reads
  each thread's messages and attachments whole (`messaging/channels.with_messages`), so it grows with the length
  of its conversations.
- **Unpaged per-person lists that can grow:** a person's notification feed (read whole, each row's target looked up:
  `messaging/notifications.feed`; a busy staff member's bell grows with their history), a player's "who's
  watching" insights (the player's whole ledger, every request: `discovery/insights.events`) and the data export.
- **Transactions.** A transaction projection (`agents/transaction_routes.project`) reads each one's
  representations, documents, consents, evaluation, agency, party names and threads by id; the T&S stale-snapshot
  figure re-derives every live transaction's staleness per request (`agents/transaction_ts_routes`); the agency
  audit (`agents/agent_audit.rows`) reads each affiliation's and agreement's history with a lookup per event.
  Bounded by one agent, one club or the live transactions.

## Accepted limits

### Password hashing is about 12 times slower than the TypeScript server's

Decided 2026-11-16: keep the pure-Gleam scrypt, and revisit closer to release.

**What it is.** Passwords are hashed with scrypt at Node's default parameters (N = 16384, r = 8, p = 1), the scheme
the TypeScript server uses, so stored hashes (`scrypt$<salt>$<hash>`) work on both servers. OTP's crypto has no
scrypt, so `scoutbox-server/src/scoutbox/platform/scrypt.gleam` implements it in pure Gleam, with no FFI or NIF.
It agrees with Node's `crypto.scryptSync` on every case in `test/fixtures/scrypt_cases.json`.

**The cost.** Measured with `gleam run -m scrypt_bench` on an M1 Pro with 6 schedulers:

- one hash takes **467 ms**, against Node's 38 ms;
- eight at once take 816 ms in all, each on its own scheduler;
- so a password sign-in takes about half a second, and the server handles about 13 a second at most.

Other requests aren't held up meanwhile: the BEAM preempts a long hash, and a 1 ms sleep took at most 3.9 ms while
eight hashes ran. Node's `scryptSync`, by contrast, blocks its only thread for every hash.

**Why it was accepted.** Password sign-ins are rare and rate-limited, so half a second is tolerable for now, and
staying with scrypt keeps the seed, fixtures and both servers on one scheme.

**Options when it's revisited.**

- **A NIF** (a C scrypt, or Argon2id): fast, and Argon2id is the strongest choice. But it brings C code into the VM
  and a C toolchain into the build.
- **PBKDF2-HMAC-SHA256**, which both OTP and Node have natively, with no dependencies. It isn't memory-hard, so it
  is weaker against GPU cracking than scrypt.

Switching scheme means regenerating the seed, whose Trust & Safety reviewer secrets are scrypt hashes. There is no
production data, so nothing needs rehashing.

### A directory text search reads every player the club can see

Found 2026-11-21 while porting the directory search. Accepted for now; it should be fixed before the player table
grows.

**What it is.** The TypeScript server matches a search against the lowered name, country and city in SQL, through a
function it adds to SQLite (`lower_js`, JavaScript's `toLowerCase`, accented letters included). SQLite's own `lower()`
lowers A–Z only, and esqlite gives no way to add an SQL function written in Gleam or Erlang. So `directory_page`
(`scoutbox-server/src/scoutbox/discovery/directory.gleam`) runs the directory's query without the text condition and
without a row limit, decodes every admitted player past the cursor, and matches each one in Gleam with
`platform/js_text.lower`. Results, order and cursors match TypeScript's (120 searches compared).

**The cost.** For a pro club the admitted players are nearly the whole `players` table, read and decoded on every
search, and again from each next page's cursor. TypeScript scans the table too, since no index helps `instr`, but its
scan stays inside SQLite and stops after `limit + 1` matches. This server reads past that point. A common search term
therefore costs a whole-table read here where it costs a short scan there. With the seed's handful of players nobody
notices; with tens of thousands it would mean slow searches and a burst of memory on every request.

**The fix to aim for.** Register a deterministic `lower_js` scalar function on each connection from C, in the esqlite
patch (`vendor/esqlite.patch`), backed by a Unicode lowercase table generated at build time (OTP's or the Unicode
Character Database's), with JavaScript's Final_Sigma rule. The query can then be TypeScript's, filtered and limited in
SQL. The same function would let the foot criterion (matching, watchlists, Nobody Missed) use `lower_js` as
TypeScript does instead of `lower()`. Every stored foot is ASCII today, so that case is harmless. Test the C function
against Node's `toLowerCase`, as `test/scoutbox/platform/js_text_test.gleam` tests `js_text.lower`.

**Until then.** A cheaper stopgap is to scan in batches of a few hundred by the keyset cursor and stop at
`limit + 1` matches. That brings the common case back in line with TypeScript, though a rare term still reads the
whole table. A pre-filter with SQLite's `lower()` isn't safe: JavaScript lowers "İ" to "i" plus a combining dot,
and the Kelvin sign to "k", so it would drop rows that should match.

### Expo's answers are never read, so dead device tokens are never pruned

Found 2026-11-23 while porting the Expo push transport. Ported as the TypeScript server behaves.

**What it is.** With `EXPO_ACCESS_TOKEN` set, a push makes one `POST /--/api/v2/push/send` per device token the
player or guardian registered (`push.deliver`, `scoutbox-server/src/scoutbox/messaging/push.gleam`). It ignores what
Expo answers:

- **Tickets.** Expo answers each message with a ticket. A ticket can say the token is dead (`DeviceNotRegistered`,
  after the app was uninstalled or its token rotated), but the token stays in `push_tokens`, so every later push to
  that person still calls Expo for it.
- **Receipts.** Whether Apple or Google actually delivered a message comes from a later call to Expo's receipts
  endpoint, made with the ticket ids. It is never made, so a delivery failure is never seen. `push_log` only
  records that a push was asked for.
- **Batching.** Expo takes up to 100 messages in one call. The server makes one call per token. It costs nothing
  (Expo is free), but it means more requests and more pressure on Expo's rate limit as volume grows.

**Why it was accepted.** At pilot volume a few wasted calls cost nothing, and staying with the TypeScript server's
behaviour kept the port to parity.

**Fix.** In this order:

1. Read the tickets. Delete the token whose ticket says `DeviceNotRegistered`, and log any other error.
2. Send in batches of up to 100, so one call covers every token of a push, or several pushes in a sweep.
3. If delivery needs to be known, store the ticket ids and have a sweep fetch their receipts about 15 minutes
   later, pruning tokens the same way.

The first two need no schema change. The third needs somewhere to keep ticket ids, either on `push_log` or in a
table of their own.

### A late upload can land after the sweep removed its key

Found 2026-11-26 while finishing uploads (`scoutbox-server/docs/final-port-steps.md`, step 5.5). Waits for a
Cloudflare account and an R2 bucket, which need sign-off.

**What it is.** The sweep expires an open upload once its time has passed, then removes its file and records that in
`upload_intents.removed_at`. A PUT that began just before its signed URL expired, and was still sending after the
15-minute grace, can finish after that removal. Its object then sits in the bucket with no intent that can use it and
no sweep that will remove it again.

**Where it is in the port.** The sweep (`POST /admin/sweep` and the periodic one) handles every upload that finishes
in time. `LocalDisk` has the same gap, but it only serves development and the batteries.

**Fix.** Add an R2 lifecycle rule on the bucket as the backstop, deleting objects older than a set age that nothing
claimed. Pick the age so it can't remove a used upload's file: either keep used files under a prefix the rule skips,
or have the rule only apply to keys the sweep has already released.

### The R2 bucket needs a CORS rule before a web app can upload

Found 2026-11-27 while moving the apps to uploads (`scoutbox-server/docs/final-port-steps.md`, step 11.2). Waits for
the same R2 bucket.

**What it is.** The web portals and the player app's web export PUT files straight to the bucket's signed URLs
(`shared/upload.ts`), a different origin from the API. A browser asks the bucket first (a CORS preflight), and
without a rule allowing it, every upload fails before it starts. The native player app sends no preflight. Opening a
stored file (`file.url`, `/media/<id>`) is a navigation or a `<video>` source, which needs no rule.

**Where it is in the port.** `LocalDisk` serves its URLs from the API's own origin, so development and the
batteries never meet it.

**Fix.** On the bucket, allow `PUT` from each origin that serves a web app (the deployment's own, and wherever the
player's web export is hosted), with the request headers `content-type`, `x-amz-checksum-sha256` and
`if-none-match`.

## Carried over from the TypeScript server

The port kept these as the TypeScript server behaved, so the batteries could agree with it.

### The journey's history lines never name who acted

Found 2026-11-16 while porting the recruitment journey. Ported as the TypeScript server behaves.

**What it is.** `GET /org/rooms/:id/journey` lists a case's history, and each line has a `by` field. For the case's
own entries (`room_created`, `room_status_changed`, `room_reopened`, `room_decision_recorded`, and the transaction
handoff entries), the TypeScript projector (`domains/recruitment/lifecycle/journey.mjs`, `timelineFor`) reads
`h.by?.name`. A case history entry has no `by` field, though: the repository reads it back as `byKind`, `byId` and
`byName` (`historyOut` in `repositories/recruitmentCases.ts`). So `by` is always null on those lines, even when the
entry records a named staff member. Decision, Offer and trial lines are unaffected: those records do carry `by`.

**Where it is in the port.** `scoutbox-server/src/scoutbox/recruitment/journey.gleam` writes `by: null` for those
lines, with a comment, so the batteries agree with the TypeScript server.

**Fix.** Name the actor from the entry's own `by_name` in `journey.gleam`. Check that no client or battery relies
on the null first.

### Scouts' disagreement on an attribute is never suggested as an evidence gap

Found 2026-11-20 while auditing the `Not ported yet:` markers. Ported as the TypeScript server behaves.

**What it is.** The missing-evidence rule `assessment_disagreement` (`domains/insight/insight.mjs`) should fire when
two submitted reports rate one attribute two or more points apart. It reads each rating's `value`, but a rating's
field is `rating` (`repositories/scoutingAssessments.ts`), so every value is `undefined`, the spread is `NaN`, and
the rule never fires.

**Where it is in the port.** `scoutbox-server/src/scoutbox/insight/evidence_gaps.gleam` has no such rule, and its
module comment says why.

**Fix.** Add the rule to `evidence_gaps.gleam`, reading each rating's `rating`, with a battery check that two split
reports raise the suggestion.

### An agent with no profile is told it needs a VERIFIED "undefined"

Found 2026-11-16 while porting the transaction workspace. Ported as the TypeScript server behaves.

**What it is.** `POST /org/agent/transactions` first runs the facet gate (`compliance.facetGateProblem`). For an
agent with no agent profile, the gate answers `{ error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent
profile first.' }`, with no facet fields. The route (`domains/agents/transactions/agentRoutes.mjs`) then replaces the
message with one built from `gate.facet`, `gate.memberAssociation` and `gate.state`. All three are undefined here,
so the agent reads:

> A regulated action needs a VERIFIED undefined; it is undefined.

The code (`AGENT_VERIFICATION_REQUIRED`, 403) is right; only the message is broken.

**Where it is in the port.** `gate_refusal` in `scoutbox-server/src/scoutbox/agents/transaction_routes.gleam`
sends the same text for `compliance_store.NoProfile`, with a comment.

**Fix.** Send the gate's own message when it names no facet ("Create your agent profile first.") from
`gate_refusal`. No battery checks this message.

### A policy version's rules are ordered by the keys of a JSON object

Found 2026-11-18 while porting the policy routes. Ported as the TypeScript server behaves.

**What it is.** `POST /ts/compliance/policies` takes a version's rules as an object keyed by rule id
(`{ "FIFA-8.1": {…}, "FIFA-11.1": {…} }`). The TypeScript server stores each rule's position in the order the keys
were sent (`Object.entries` in `writeRules`, `repositories/compliancePolicies.mjs`), and the policy view returns
`rules` in that order. The admin app renders its rules table straight from it (`Object.entries(p.rules)` in
`scoutbox-admin/src/m25tabs.tsx`). But JSON object members have no order: the standard says so, and a proxy or a
client library may reorder them. The order a Trust & Safety administrator entered is kept only by luck.

**Where it is in the port.** An Erlang map has no order either, so this server reads the order keys were sent in
from the request's raw text (`scoutbox-server/src/scoutbox/platform/key_order.gleam`) and `input` keeps it.

**Fix.** Send and return rules as an array, each carrying its id (`rules: [{ "ruleId": "FIFA-8.1", … }]`), so the
order is part of the data. That changes this server, the admin app and the batteries together.

### A list is accepted as a segment's drawing, or a template's anchors

Found 2026-11-18 while porting video segments. Ported as the TypeScript server behaves.

**What it is.** `POST /org/media/:id/segments` takes an optional `drawing`, documented as an object of overlay
shapes. Its schema (`domains/scouting/scouting.mjs`) is valibot's `record`, which also accepts a list and turns it
into an object keyed by index, so `drawing: [{…}, 3]` is stored and returned as `{ "0": {…}, "1": 3 }`. The schema's
own `!Array.isArray` check sees the converted object, so it never refuses a list. A template's `anchors` are read
the same way, but there a list always fails the levels check (`"0"` isn't a level), so it is only refused with
`invalid` rather than `not_object`.

**Where it is in the port.** `input.record` (`scoutbox-server/src/scoutbox/platform/input.gleam`) reads a list as
valibot does, and both routes use it.

**Fix.** Read both with `input.entries`, which refuses a list. No battery sends a list.

### A training slot "falls inside" the player's available times when it only overlaps them

Found 2026-11-19 while porting suitability. Ported as the TypeScript server behaves.

**What it is.** `GET /player/suitability/:oppId` (and the guardian's view of it) answers `compatible` for the
schedule, with the reason "every published training slot falls inside your available times", when every training slot
*overlaps* one of the player's available slots (`domains/scouting/suitability.mjs`, through `slotsOverlap`). A
player free on Tuesday 17:00–17:30 is told that Tuesday training from 17:00 to 20:00 fits. The same verdict goes into
the summary a club sees once the player shares it.

**Where it is in the port.** `scoutbox-server/src/scoutbox/scouting/suitability.gleam`, `schedule`, uses the same
overlap test.

**Fix.** Test containment for availability (each training slot within one available slot), keeping overlap for
commitments. The `clubOperations` battery's check uses a slot that is contained, so it would still
pass.

### A reconnecting stream is replayed events the registry says are never replayed

Found 2026-11-20 while porting the live events. Ported as the TypeScript server behaves.

**What it is.** Each event in the registry (`domains/platform/eventRegistry.mjs`) has a `replayPolicy`, and 45 of
them say `never`: the agent and compliance events, the trial invitations and schedule changes, a Room's decisions and
handoffs, a draft Offer's edits. But the reconnect log in `domains/platform/liveSync.mjs` keeps every event except
`typing`, so a client that reconnects with a `lastEventId` is sent those events again. Nothing reads `replayPolicy`
except the tests that check each entry has one.

**Where it is in the port.** `scoutbox-server/src/scoutbox/platform/live_event.gleam`, `replays`, keeps every event
but typing too. Until 2026-11-20 this server honoured `replayPolicy`.

**Fix.** Keep only `replay` events in the log. A client sees no difference beyond fewer stale
nudges after a reconnect, since every event is only a cue to refetch.

### Reputation shows every club the whole ledger's activity, players' names included

Found 2026-11-22 while porting `/org/reputation`. Ported as the TypeScript server behaves.

**What it is.** `GET /org/reputation` (TypeScript's `domains/recruitment/ledger.mjs`) answers any club's staff with a
`live` row for every actor name and organisation name pair on the whole ledger (`countsByActor`), not only its own.
Each row gives that pair's counts of profile views, contact requests, trial requests and reports, and signings.
Any club can therefore see how many players each rival club's scouts have viewed, contacted, trialled and signed.

The rows aren't limited to staff, either. Every ledger type opens a row, and some rows name someone who isn't
staff: a message records its sender, so a player who messages a club appears as a "scout" of that club, with all
counts zero. After a `platform/api` run against the TypeScript server, the live rows include
`Kola Adeyemi · Eastport FC` (a player's message), `system · ScoutBox` and `open day` beside the scouts. The same would
show a minor's name, or a guardian's, once they message a club. That tells every club that the player is talking to
that one.

**Where it is in the port.** `request_routes.reputation` and `ledger.counts_by_actor`
(`scoutbox-server/src/scoutbox/recruitment/request_routes.gleam`, `safety/ledger.gleam`) read the whole ledger and
open a row for every type, as TypeScript does. `platform/api` RP2 specifies that behaviour.

**Fix.** Decide what reputation is meant to show, then change this server and RP2 together. The likely answer is
the club's own scouts only (`org_id` = the caller's), counting only staff acts (`user_id IS NOT NULL`). If rivals'
track records are meant to be visible, still drop every row with no staff member, and confirm with the Founder that
clubs may see each other's activity counts. The club and grassroots portals read the endpoint (`getReputation`), so
check what their screens assume first.

### Sending a closed contact says it "cannot be sended"

Found 2026-11-23 while proving the contact validator over its matrix. Ported as the TypeScript server behaves.

**What it is.** `POST /org/rooms/:id/contacts/:cid/send` on a contact that is cancelled, recorded (external) or
answered is refused with `CONTACT_INVALID_STATE` (409) and the message "A contact that is cancelled cannot be
sended." `canContactAction` (`domains/recruitment/lifecycle/contact.mjs`) spells out "edited" and "cancelled", and
builds every other verb as `action + 'ed'`. Sending a delivered contact has its own message
(`CONTACT_ALREADY_SENT`), so only these three states show it. The club and Grassroots portals' demo modes
(`roomsDemo.ts`) already say "cannot be sent".

**Where it is in the port.** `contact_rules.can_act` (`scoutbox-server/src/scoutbox/recruitment/contact_rules.gleam`)
writes "sended", and `test/fixtures/contact_matrix.json` records it.

**Fix.** Spell out "sent" in `can_act`, then re-bless
the fixture (`npm run fixtures:bless`) and check that only those messages changed. The `contacts` battery (D4b)
checks only the code, so no battery changes.

## Questions to revisit

### A close can beat the completion of a fully signed package

Decided 2026-11-17 while porting `recruitment/journeyAdversarial`: the battery was loosened at source
(`40d1c23f`, in the TypeScript server) so the port isn't held up. G6 had assumed the single thread's winner, which is
the request sent first. On the BEAM either request can win.

**What it is.** Section B12 completes a package that both parties have signed while a `closeCase` races it, and
already accepted either outcome. If the close wins, the case closes with both signatures on a READY package and no
signing row, and B12 reopens it. G6 used to require the completed case's stage, and now accepts `review` when no
package completed.

**The question.** Should a close be refused while a package has every signature it needs, or while a signing is in
progress? That is a product rule the single thread hid, since the completion always won there.

### The policy view leaves out a rule's overrides and its own start date

Found 2026-11-18 while porting `agents/compliancePersistence`. Ported as the TypeScript server behaves.

**What it is.** `GET /ts/compliance/policies` (and the agent's and admin's policy lists, which share the view) gives
each rule five fields: `ruleStatus`, `textStatus`, `note`, `params` and `sourceRef` (`policyPublic` in
`domains/agents/compliance/policyRoutes.mjs`). A rule can also carry `overrides`, which name the national rule that
takes its place in a jurisdiction (FIFA-12.8, 12.9 and 12.10 give way to ENG-6.3, 6.4 and 6.5), and its own
`effectiveFrom` (FIFA-RSTP-2027 applies from 1 January 2027). Both are stored, the conflict engine and the policy
rules use them, and `POST /ts/compliance/policies` accepts them, but no view returns them. So a Trust & Safety
reviewer can't see why a FIFA rule doesn't decide an England case, and an administrator who submits a version
can't check what was stored. `scoutbox-server/src/scoutbox/agents/policy_routes.gleam` returns the same five fields.

**The question.** Should the view return `overrides` and a rule's `effectiveFrom`? If it should, check the admin
app's rules table first. If they were left out on purpose, say why in the view.
`agents/compliancePersistence` compares the seeded rules with the snapshot through the stored rows, because the view
doesn't carry them whole.

### A transition pack shows evidence without what it is

Found 2026-11-19 while porting `operations/clubOperations`. Ported as the TypeScript server behaves.

**What it is.** When a club opens a transition pack (`GET /org/transitions/:id/pack`), each evidence record is meant
to show its `kind`, `tier` and `summary` (`packView` in `domains/verification/transitions.mjs`). An evidence record
has none of those fields: it has `claimType`, `label`, `value` and a verification tier under `verification`. So the
club sees only each record's `id` and `recordedAt`, and can't tell what the player chose to share.
`scoutbox-server/src/scoutbox/verification/transitions.gleam` sends the same two fields.

**The question.** Which of the record's fields should a receiving club see? Probably the claim type, label, value
and verification status, since those are what the player's own Passport shows.

### Some requests are no longer counted in the request metrics

Decided 2026-11-20 while porting `platform/contracts`: match the TypeScript server for now, and decide once the port
is done.

**What it is.** The request instrumentation (`scoutbox-server/src/scoutbox/platform/instrument.gleam`) stands where
the TypeScript server's `requestInstrumentation` does, after CORS, the HTTP baseline and the fault layer. So three
kinds of answer get no correlation id, no log line, and no count in `/admin/metrics`: a CORS preflight, a simulated
fault, and a refusal of a body that couldn't be read (`413 REQUEST_TOO_LARGE`, `400 MALFORMED_JSON`). Until this
change the Gleam server counted every request. The TypeScript server misses these only because Express parses the
body, and runs the fault layer, before its instrumentation.

**The question.** Should `/admin/metrics` count every request? An operator watching for abuse would want to see a
burst of oversized or malformed bodies, and a 4xx rate that leaves them out understates it. If it should, move the
instrumentation in front of CORS, the HTTP baseline and the fault layer.

## Tests

The UI suites in the repository's `e2e/`:

- **`e2e/navConfig.test.mjs` fails** (also on `c436154`): the club and Grassroots nav still list the removed
  "representation" destination.
- **`e2e/categoriesBrandAudit` (4 checks) and `e2e/visualQualityAudit` (12 checks) fail** (once `m24f2DensityAudit`
  and `m24fVisualAudit`): Player Account categories, the portal ™ size and its "trademark" label, the Grassroots and
  Player Home single primary action, the Player Card/ListRow check, and in `visualQualityAudit` the Inter font
  tokens and faces, the frozen Grassroots dark tokens, the entry page's layout and row hover, and the portals' ruled
  rows, notes and filter bar. Triage them against [`design.md`](design.md).
- **Some app promises have no test, because the web apps have no test runner.** The server batteries used to check
  them by reading app source, and no longer do. Until the apps get one: a screen can ask for a translation key that
  does not exist and show the raw key, because `t()` accepts any string (typing its key as `keyof typeof en` would
  make `tsc` catch it; EN/FR parity is already enforced by `const fr: typeof en`); nothing checks that every status,
  party role, document type and visibility class the server sends has a word in both languages; the decision
  panel's handoff section never shows the decision's note, rationale or reasons; the club apps never offer an
  agent-only contact route, and the agent's share control is never an "apply"; no app manufactures a next action or
  reads a status from a live event's payload; the web apps re-read on focus, `pageshow` and visibility; the demo
  bundles repeat the server's limitation and "achieved" sentences word for word; and `confirmAction.ts`,
  `conflict.tsx`, `httpState.ts`, `provenance.ts` and `dirtyGuard.ts` stay identical in Club and Grassroots.
