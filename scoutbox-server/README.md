# scoutbox-server (Gleam)

A Gleam port of four slices of the ScoutBox server: organisation staff (sign-in, sessions, invitations, MFA), the
safeguarding core (reports, blocks, moderation, the Trust & Safety console, the Discovery Ledger), players and
guardians (sign-up, the player record, the directory, guardians and their children), verification (claims and
their review, organisation applications, domains, the administrator hierarchy, squad invitations, coach
references), message threads (answering a request opens one), and notifications with their preferences, push, the
delivery centre, webhooks and support tickets, live sync over server-sent events (`/events`, for thread messages,
typing and notices), signed media links, password sign-in for organisations, guardian sign-up, the session
lifetime (`SESSION_TTL_DAYS`) and the production boot refusals, and Recruitment Rooms (with the Trust Score, club
evidence, missing-evidence suggestions and Combine requests they read), the recruitment case's journey, lifecycle
actions and formal decision, Offers, the agent core (profiles and verification facets, agency membership,
representation agreements and the player's My Agent, with the compliance engine's adult approach rule and the review
items it opens), the organisation audit and a player's erasure, an agent's transaction workspace (its parties and their own confirmation,
representation bindings, status moves, terms, documents, notes, links, timelines, the club's, player's and Trust &
Safety lanes, and the readiness an Offer reads), the Conflict & Compliance Engine (reviewer sign-in, the dev reviewers seeded into an empty table, and
administration, the agent's own compliance contexts and their conflict evaluation, regulatory consents, facet
rechecks, the compliance overview, the review lifecycle and every kind of decision, dual-control policy versions,
and the Trust & Safety audit and metrics), Trials (the invitation, acceptance,
schedule and its revisions, attendance, completion, cancellation, Box Cam evidence by reference, the trial day, the
calendar export and the mandatory report), structured assessments (with template versions and the feedback a club
publishes to a player), video segments and playlists, the Football Passport (every viewer's projection, preferences,
career entries, achievements, corrections and share links; its Box Cam sections are a player's with none), and
Second Look and Nobody Missed (Recruitment Briefs, Evaluation Coverage, and the stored match facts they query),
Explainable Matching and Dynamic Watchlists (one match engine, which Nobody Missed shares), and the club's insight: exposure, the review queue, calibration sessions, the decision review and coverage planning. It
answers every battery in `e2e/batteries.mjs` unchanged.

```sh
npm run esqlite        # once after cloning (Gleam can't resolve the project without it): the patched esqlite
gleam check            # type-check (fast)
gleam test             # unit tests, the generator's snapshots, and the rules against their blessed fixtures
gleam run              # the server on PORT (default 4000), data in DATA_DIR (default ./data)
npm run e2e            # build the Erlang release, then run the batteries against it
npm run e2e:check      # fail if a battery reaches outside e2e/ or isn't listed, or codegen:check or sql:check fails
npm run fixtures:bless # rewrite the blessed answers in test/fixtures/ from the rules, and print the ones that changed
npm run codegen        # regenerate src/scoutbox/rows and src/scoutbox/vocab from priv/migrations
npm run codegen:check  # fail if the committed row modules differ from what the migrations generate
npm run sql:check      # prepare every query the source spells out against the migrated schema, and check its
                       # placeholders against its arguments and each argument against the column it binds
                       # (`gleam dev sql-check --verbose` lists the queries it can't read and the arguments
                       # bound as plain text to an id or vocabulary column)
node dev/perf.mjs      # latency of the hot paths (after `gleam export erlang-shipment`)
node dev/sse_check.mjs # the event stream's behaviour, and its fan-out to 100 and 1000 streams (after the same)
```

Settings (`src/scoutbox/platform/config.gleam`): `PORT`, `DATA_DIR`, `PUBLIC_DIR` (the built web portals, default
`./public`), `ADMIN_KEY` (development default
`scoutbox-admin`, refused in production), `NODE_ENV=production` (turns off demo sign-ins and the seed),
`SCOUTBOX_QUIET_LOGS=1`, `SCOUTBOX_FAST_SWEEPS=1` (the sweeps every half second, and the delivery and webhook
retry ladders in milliseconds), `MEDIA_SECRET` (signs media links; in development a random key per boot,
required in production), `DELIVERY_CALLBACK_SECRET` (default: the local fake provider's),
`ALLOW_LOCAL_WEBHOOKS=1` (a webhook may go to a loopback address), `SENDGRID_API_KEY` and `MAIL_FROM` (mail through
SendGrid, from `noreply@scoutbox.app` by default; unset, the outbox is the delivery), `EXPO_ACCESS_TOKEN` (push
through Expo, one call per registered device token; unset, the push log is the delivery), the four `R2_*` settings
(uploaded files in Cloudflare R2; none set, on disk under `DATA_DIR/media`) and `TS_REVIEWER_BOOTSTRAP_ID`, `_SECRET`
and `_NAME` (the Trust & Safety admin a deployment starts with, created at boot if no reviewer has that id).

## Layout

- `src/scoutbox/rows/`, `src/scoutbox/vocab/`: **generated**, one module per table and per shared vocabulary
  (`dev/scoutbox/codegen.gleam`). A row module has the `Row` type, its decoder, `columns`, `width`, `qualified`,
  `insert` and `new(…)`; a CHECK vocabulary is an enum. A domain record is usually the generated `Row`, with what
  is derived from it as functions. Don't edit them: change the migration and run `npm run codegen`.
- `src/scoutbox/platform/`: the store (unit of work, readers, effects), `input` (refusals in the TypeScript
  format), `sql` (fragments that carry their arguments), `temporal` (days, instants and their refusals, read once
  where they arrive: a `Day` is always a real one), `zones` (a `Zone` is always one the offsets table knows, from
  `priv/zone_offsets.json`), `distance`, `keyset` and `paging`/`pages`, `http`, `ids`, migrations, limits, config.
- `src/scoutbox/rules/`: the pure rules, each checked against its blessed fixture: `age`, `visibility` (one SQL
  expression for every read), `moderation`, `journey`.
- `src/scoutbox/identity/`, `safety/`, `discovery/`, `recruitment/`, `development/`, `messaging/`,
  `verification/`, `enterprise/`: the domains. `verification/claims` holds the pure rules, checked by the tests
  in `test/scoutbox/battery/verification/`.
- `vendor/esqlite.patch`: our change to esqlite, the NIF under sqlight. `npm run esqlite` (`dev/esqlite.mjs`)
  fetches the pinned Hex tarball, checks it, applies the patch and compiles the NIF into `vendor/esqlite/` (not
  committed), which `gleam.toml` takes as a path dependency in place of the Hex copy. The patch adds `fetchmany`
  (as many rows as it can step in half a millisecond, in one call on a normal scheduler) and `fetchmany_dirty`;
  `platform/scoutbox_store_ffi.erl` caches each connection's statements, fetches in batches until a statement is
  done, and runs a statement's next batch on the dirty scheduler while its batches meet a step slower than a
  millisecond. Stock esqlite runs every row's `step` on the dirty schedulers, which made reads several times slower
  than Node and stopped them scaling; building a large result in one dirty call stopped large reads scaling too. An upgrade is a new pin and checksum in `dev/esqlite.mjs` and the patch reapplied.
- `priv/migrations/`: the tables, one numbered SQL file each (first recorded from the TypeScript server's
  migrations), edited directly. `priv/seed.sql`: the demo world, edited directly.
- `test/fixtures/`: inputs and their blessed answers (`test/scoutbox/blessed.gleam`), one case per line, except
  `scrypt_cases`, `distance_cases` and `proxy_cases`, which pin outside facts and are kept as they are.
- `dev/`: the generator (`scoutbox_dev.gleam`), `bless.mjs`, `esqlite.mjs`, `zone_offsets.mjs` (the zone offsets
  from Node's ICU; re-bless `zone_cases` after running it), and `perf.mjs` and `sse_check.mjs` with
  `perf_population.mjs`.
- `e2e/`: the batteries, the server's behavioural specification, and the helpers they import. Change a battery,
  then the code.

## Routes

Every route below is exercised by a battery, except where marked.

| Area | Routes |
|---|---|
| Health | `GET /health`, `/readyz` |
| Web portals | `GET /app/…` (club), `/console/…` (Trust & Safety), `/grassroots/…`, `/agent/…`: each portal's build from `PUBLIC_DIR/club`, `admin`, `grassroots` and `agent`, if it has an `index.html` at boot (`platform/portals`). A file is served from the build; any other path is its `index.html`, except one naming a missing file (`404`). Checked after every API route |
| Uploads | `POST /player/uploads`, `/org/uploads`, `/auth/org/verification/apply/:id/uploads` (declare a file, answered with the URL to PUT it to); `PUT`/`GET /blobs/:token` (the local store standing in for R2, `platform/blobs`); `GET /media/:id` redirects to a storage link. A route that took a `dataUrl` takes the `uploadId` |
| Backups | `POST /admin/backup` (a copy of the database from a read-only connection, `store.copy_to`, so writes carry on; the media files, less those queued for removal; a checksummed manifest written last), `POST /admin/backup/verify`, `GET /admin/backups` (no battery). The battery restores a backup into a new, empty `DATA_DIR` and boots it |
| Sign-in | `POST /auth/org/login` (with an organisation password: scrypt, checked before the unit), `/auth/org/register-grassroots`, `/auth/org/accept-invite`, `/auth/logout`, `/auth/player/signup`, `/auth/player/login` (a password-protected player, checked before the unit), `/auth/player/pair` (a guardian's pairing code, used once, charged per address only when wrong), `/auth/guardian/signup`, `/auth/guardian/login` (a password-protected guardian by id or e-mail, checked before the unit), `/auth/guardian/verify-email`; `/auth/sso/start` and `/callback` against the local test identity provider (`GET /testidp/authorize`, development only; both refuse in production) |
| Staff | `GET /org/staff`, `POST /org/staff/:id/remove`, `GET`/`POST /org/invites`, `POST /org/invites/:id/revoke`, `GET /org/onboarding`, `/org/mfa/setup`, `/verify`, `/disable` (unit-tested only), `GET /org/sessions`, `POST /org/sessions/revoke`, `PUT /org/security`, `GET`/`PUT /org/sso`, `PUT /org/delivery/prefs` |
| Discovery | `GET /org/players`, `/org/players/:id`, `/org/shortlist`, `/org/filmroom`, `/org/fixtures`; `POST /org/players/:id/notes`, `/save` (no battery), `/shortlist`; `GET`/`POST /org/searches`, `DELETE /org/searches/:id` (a player who joins alerts the staff whose searches they match, as the club sees them) |
| Case workspace | `GET /org/cases` (newest first, by cursor, with the pipeline's stages), `POST /org/cases` (a plain case), `GET /org/cases/:id` (a restricted case only to its owner, assignees and leads), `/org/cases/:id/assign` (by the owner or a lead), `/org/cases/:id/tasks` and `…/tasks/:tid/complete`, `/org/cases/:id/stage` (refused on a case with a Room), `/org/cases/:id/decision` (a non-lead's sign waits for a lead's approval), `…/approvals/:aid` (a lead's answer), `/org/cases/:id/link` (a request, trial or signing of this club and player); each answers the whole case record. `GET /org/cases/:id/budget`, `POST …/budget/scenarios`, `PUT …/scenarios/:sid`, `POST …/:sid/approve` (a lead's, of that version) and `…/:sid/actuals`, for leads and finance roles: totals per currency, combined only under stated rates |
| Matching | `GET /org/matching/vocabulary`, `POST /org/matching` (by cursor; a brief's criteria or the club's own) |
| Watchlists | `GET`/`POST /org/watchlists`, `GET`/`PATCH /org/watchlists/:id` (reading one derives its membership and records the transitions), `GET …/:id/history`, `POST …/:id/room` |
| Second Look | `GET /org/second-look` (reconciled with the source records on every read), `/org/second-look/:id`, `/org/second-look/:id/changes`; `POST /org/second-look/:id/review`, `/dismiss`, `/reopen-room` (through the Rooms' own reopen path) |
| Nobody Missed | `GET`/`POST /org/recruitment-briefs`, `GET`/`PATCH /org/recruitment-briefs/:id`, `GET /org/nobody-missed` (over the stored match facts, by cursor), `GET /org/evaluation-coverage`; `POST /org/nobody-missed/add-to-room`, `/review` and `/dismiss` (no battery) |
| Insight | `POST /org/exposure/impressions`, `GET /org/exposure/report`, `/org/review-queue`, `POST /org/review-queue/:id/later`, `GET /org/discovery-rotation`, `/org/decision-review`, `/player/exposure`; `GET /org/players/:id/evidence-gaps`, `POST /org/evidence-gaps/:id/request`, `/dismiss` and `/reviewed` (no battery); `GET`/`POST /org/calibration`, `GET /org/calibration/:id`, `POST …/submit`, `…/close` (no battery), `…/notes`; `GET`/`POST /org/coverage/fixtures`, `/org/coverage-plans`, `/org/coverage/assignments`, `POST …/assignments/:id/complete`, `…/cancel` (no battery), `GET /org/coverage/suggestions`; the sweep (review reminders, pruning old exposure) |
| Grassroots club | `GET`/`POST /org/squad`, `POST /org/squad/:id/release` (availability restored unless another club's contract stands, the club's reference published), `POST /org/matchday` (verified, coach-signed attendance for the squad players named), `GET /org/matchdays`; `GET`/`POST /org/open-trials` (no ghosting: an unanswered past registrant blocks the next), `DELETE /org/open-trials/:id`, `POST …/registrations/:rid/outcome` (an invitation is a real trial request; a kind no reaches a child's guardian); `POST /org/looking-for`, `GET /org/pathway-record`; `GET`/`POST /org/friendlies` (the club's own and those within the radius), `POST /org/friendlies/:id/respond` |
| Grassroots journey | `GET`/`POST /player/programme`, `POST /player/programme/sessions/:id/complete`, `GET /player/benchmarks`, `/player/opportunities` (the radar: clubs within the radius, nearest first), `POST /player/open-trials/:id/register`, `GET /guardian/children/:id/open-trials`, `POST /guardian/open-trials/:id/register`, `GET /player/season-wrap`; coach references: `POST /player/vouches/request`, `/guardian/children/:id/vouches/request`, `/vouch/submit`, `GET /admin/vouches`, `POST /admin/vouches/:id/withdraw` |
| Recruitment | `POST /org/players/:id/request` (a contact, or a direct trial request with its days, venue and notes; refused while a trial report is outstanding), `/player/requests/:id/respond`, `/guardian/requests/:id/respond` (a trial invitation's acceptance is the trial's birth); `GET /org/requests`, `/org/ledger`, `/org/funnel`, `/player/inbox`, `/guardian/inbox`; `GET /org/signings` (newest first, by cursor), `GET /org/invoices` (the success fees), `/admin/invoices` (every club's), `/org/plan`, `POST /org/players/:id/signing` (the legacy recorder, refused when the workflow owns the signing); `GET /org/recruitment-analytics` (the Director Dashboard: every family, the window, filters and trend), `/org/recruitment-analytics/catalogue`, `/org/recruitment-analytics/rows` (the drill-down); `GET /org/feed`; `GET /orgs/directory` (with a Grassroots club's pathway record) |
| Contacts | `GET`/`POST /org/rooms/:id/contacts`, `GET`/`PATCH …/contacts/:cid`, `POST …/contacts/:cid/cancel`, `…/contacts/:cid/send` (the in-app request, the guardian's email copy, the agent beside the player when their authority holds), `POST …/contacts/external`, `GET /org/recruitment/contact-policy`; a recipient's answer lands on the contact through the respond route; `GET /player/insights`; `GET /player/journeys`, `GET /guardian/children/:id/journeys` (what was shared with the recipient), `GET /org/agent/clients/:id/journey` (what the client routed or shared to the agent, as far as the agent's basis, scope and licence open it), signing packages included |
| Trials | `GET`/`POST /org/rooms/:id/trials`, `GET …/trials/:tid`, `POST …/schedule`, `…/reschedule`, `…/cancel`, `…/complete`, `…/sessions/:sid/attendance`, `…/sessions/:sid/evidence`, `…/evidence/:eid/unlink`, `GET …/evidence`, `…/evidence/candidates`, `GET /org/recruitment/trial-policy`; `GET /org/trials`, `/org/trials/:id/day`, `/org/trials/:id/ics`, `POST /org/trials/:id/staff`, `/arrival`, `/cancel`, `/postpone`, `/checkin`, `/report`; `GET /player/trials`, `POST /player/trials/:id/confirm-schedule`, `/decline-schedule`, `/cancel`, `/consent`, `/emergency-contact`, `GET …/safety-pack`, and the guardian's `/guardian/trials…` |
| Signings | `GET /org/rooms/:id/signing`, `POST /org/offers/:id/signing`, `GET`/`PATCH /org/signings/:id`, `GET …/history`, `GET`/`POST …/document`, `POST …/executed-document`, `…/ready`, `…/parties/club/complete`, `…/complete` (the gate, the one signing writer and the move to signed in one unit), `…/cancel`, `…/void`, `…/supersede`; `POST /admin/signings/:id/void`; `GET /player/signings`, `…/:id`, `…/:id/document`, `POST …/:id/complete`; the guardian's (dormant: the minor pathway is closed); `GET /org/agent/clients/:id/signings`; an Offer's view carries its signing summary; `POST /player/availability` refuses a status while a completed signing's contract stands |
| Assessments | `GET`/`POST /org/assessments`, `PUT /org/assessments/:id`, `POST …/submit`, `…/publish-feedback`, `GET /org/players/:id/assessment-compare`, `GET`/`POST /org/assessment-templates`; `GET /player/feedback`, `/guardian/children/:id/feedback` (no battery) |
| Video | `POST /org/media/:id/segments`, `GET /org/segments`, `/org/segments/:id`; `POST /org/playlists` (`GET`: no battery), `POST /org/playlists/:id/segments` |
| Club setup | `GET`/`POST /org/tactical` (a lead saves the whole setup; roles keep their ids, and are typed with the repository's own reasons), `GET`/`POST /org/vacancies` (the list newest first, by cursor), `…/:id/close`, `…/:id/candidates` (each criterion met, not met or unknown with its source, judged in SQL and paged by cursor), `POST /org/squad/shadow`, `GET /org/squad-planner` |
| Rooms | `GET`/`POST /org/rooms`, `GET /org/rooms/needs-attention`, `/summaries`, `GET`/`PATCH /org/rooms/:id`, `POST …/status`, `GET …/snapshots`, `…/activity`, `GET`/`POST …/comments`, `PATCH`/`DELETE …/comments/:cid`, `POST …/tasks`, `PATCH …/tasks/:tid`, `GET`/`POST …/decisions`, `POST …/evidence/:eid/review`, `…/assessment-assignments`, `…/evidence-requests`, `…/combine-requests`, `…/link`; `GET /org/rooms-funnel`, `/admin/rooms/overview` |
| Case | `GET /org/rooms/:id/journey` (the club's projection), `POST /org/rooms/:id/lifecycle` (a named action, gated by the evidence provider); `GET /org/rooms/:id/decision`, `POST`/`PATCH`/`DELETE …/decision/draft`, `POST …/decision/finalize`, `…/decision/supersede` |
| Offers | `GET`/`POST /org/rooms/:id/offers`, `GET /org/offers/:id`, `…/history`, `PATCH …/draft`, `POST …/issue`, `…/withdraw`, `…/revise`, `GET /org/recruitment/offer-policy`; `GET /player/offers`, `/player/offers/:id`, `…/documents/:docId`, `POST …/accept`, `…/decline`, `…/share-agent`; the guardian's `/guardian/offers…` |
| Agents | `GET /org/agent/me`, `/home`, `GET`/`POST /org/agent/profile`, `POST …/profile/facets/:facet/submit`; `GET /org/agent/agency`, `GET`/`POST …/agency/team`, `PATCH …/agency/team/:userId`, `POST …/team/:userId/end`, `PATCH …/agency/settings`, `GET …/agency/compliance`, `…/agency/audit`; `GET /org/agent/players`, `/clients`, `POST /org/agent/clients/request`, `GET /org/agent/clients/:id`, `POST …/terminate`, `GET …/opportunities`, `…/offers`; `GET /org/agent/opportunities`, `/inbox`; `GET /player/agent/relationships`, `POST …/:id/confirm`, `/decline`, `/terminate`, `/dispute`, `PATCH …/:id/sharing`; `GET /admin/agent/relationships`, `/admin/agent/profiles` (read only); `POST /org/agent/transactions`, `POST /org/agent/transactions/:id/notes`; the integration seam: `GET /org/agent/clients/:id/contacts`, `…/trials`, `…/opportunities/shares`, `POST …/opportunities/:oppId/share`, `…/opportunities/shares/:shareId/withdraw`, `GET /player/agent/shared-opportunities`; `GET`/`POST /org/rooms/:id/transaction-handoff`, `POST …/transaction-handoff/withdraw`, `GET /org/agent/handoffs` |
| Compliance | `GET /ts/me`, `GET`/`POST /ts/reviewers`, `POST …/:id/revoke`; `GET /ts/compliance/reviews`, `GET …/:id`, `POST …/:id/start`, `/resolve`, `/cancel`, `/supersede`; `GET /ts/compliance/audit`, `/metrics`; `GET`/`POST /ts/compliance/policies`, `POST …/:id/approve`; `GET`/`POST /org/agent/compliance/contexts`, `GET …/:id`, `POST …/:id/evaluate`, `/parties`, `/representations`, `/representations/:repId/withdraw`, `/close`, `/consents/request`; `POST /org/agent/compliance/facets/:facet/recheck`; `GET /org/agent/compliance/overview`, `/policies`; `GET /org/compliance/consents`, `/player/agent/consents` and their answers; `GET /admin/compliance/reviews`, `/admin/compliance/policies` (read only). Not ported: the minors approach (no route exists in either server) and the public `policy_version_published` ping |
| Audit and erasure | `GET /org/audit` (Room, Contact, trial, agency and ledger rows); `DELETE /player/account` |
| Opportunity board | `POST /org/opportunities` (published at once; eligibility typed, and forced for a Grassroots club), `GET /org/opportunities` (newest first, by cursor, with application counts); `GET /player/opportunity-board` (club opportunities the player is eligible for, then the open days), `/guardian/children/:id/opportunity-board`; applying, withdrawing, the club's answer and closing; suitability: `GET`/`PUT /player/preferences` and `/guardian/children/:id/preferences`, `PUT /org/opportunities/:id/structured-requirements`, `GET /player/suitability/:oppId` and `/guardian/children/:id/suitability/:oppId`, `POST /player/suitability/share` and `/guardian/children/:id/suitability/share`, `GET /org/applications/:id/suitability`. Not ported: the week-old application reminders |
| Passport | `GET /player/football-passport`, `/guardian/children/:id/football-passport`, `/org/players/:id/football-passport`, `/org/football-passports`, `/admin/passport/:playerId/graph`; `PATCH …/football-passport/prefs`, `POST …/career`, `…/career/:id/withdraw`, `…/achievements`, `…/achievements/:id/withdraw`, `…/corrections` (player and guardian), `POST /org/players/:pid/football-passport/achievements/:id/confirm`, `GET /admin/passport/corrections`, `POST …/:id/resolve`; shares: `GET`/`POST …/football-passport/shares`, `POST …/shares/:id/revoke` (player and guardian), `GET /passport/shared/:token`, `/org/passport/shared/:token`, `GET /admin/passport/shares`, `POST …/:id/revoke`; `GET /player/trust-profile`, `/org/players/:id/trust-profile`, `/org/trust-summaries`, `/admin/trust/:playerId` (the Trust Score, from its sources' records); `GET /org/players/:id/evidence-gaps` |
| Evidence Passport | `GET /player/passport`, `/guardian/children/:id/passport`, `/org/players/:id/passport`; `POST /player/evidence`, `…/:id/correct`, `…/:id/dispute`, `/guardian/children/:id/evidence`, `/org/players/:id/evidence`, `/org/evidence/:id/corroborate`, `/org/evidence/:id/dispute`; `GET /admin/evidence/disputes`, `POST …/:id/resolve`; `GET`/`POST /org/coaches`, `POST …/:id/end`, `…/:id/revoke`, `GET /admin/coaches` (every club's, by offset); `POST /org/squad/invite`, `GET /player/squad-invites`, `/guardian/squad-invites`, `POST …/:id/respond`; coach references: `POST /player/vouches/request`, `/guardian/children/:id/vouches/request`, `/vouch/submit`, `/admin/vouches/:id/withdraw` |
| Combine | `GET /org/combine/protocols`, `/player/combine/protocols` (the registry, declared from `spec/development/boxcam/combineShared.json`); `GET /player/combine`, `/card`, `/attempts`, `/attempts/:id`, `/requests`, `POST /player/combine/attempts`, `…/:id/calibrate`, `/complete`, `/cancel` (the measurement is worked out when the bound Box Cam session completes); `GET /guardian/children/:id/combine`, `…/combine/requests`; `GET`/`POST /org/combine/requests`, `POST …/:id/cancel`, `GET /org/combine/players/:id`, `/org/combine/compare`; `GET /admin/combine/attempts/:id` |
| Development Hub | `GET /{player,guardian,org}/development/catalogue`, `/linkable-evidence`, `GET`/`POST …/development/plans`, `GET`/`PATCH …/plans/:id`, `POST …/plans/:id/status`, `/share`, `/goals`, `GET`/`POST …/plans/:id/reviews`, `GET …/plans/:id/history`, `PATCH …/goals/:id`, `POST …/goals/:id/actions`, `/evidence`, `PATCH …/actions/:id`, `POST …/actions/:id/evidence`, `DELETE …/evidence/:id`, `POST …/reviews/:id/share`; the plans' lifecycle in `GET /org/audit`. Evidence links are resolved live from their source on every read. Not ported: the live events |
| Threads | `GET /org/channels`, `/org/channels/counts`, `/player/channels`, `/guardian/channels`, `/admin/channels`; `POST /{org,player,guardian}/channels/:id/messages`, `/read`, `/typing` |
| Safety | `POST /player/block`, `/player/report`, `/guardian/report`; `GET /player/reports`; `POST /guardian/block`, `/org/report`, `GET /guardian/reports`, `/org/reports` (no battery) |
| Player | `GET /player/me`, `/player/export`, `GET`/`PATCH /player/box-cam/prefs`, `POST /player/box-cam/sessions/:id/cv/begin`, `/frames`, `/finalize`, `/cancel` and `/player/box-cam/cv/ready-check` (the `production_cv` stub: its checks, then `503 provider_unavailable`; the Ready Check reports the provider unavailable), `GET /admin/box-cam/cv/results/:id`; `POST /player/timeline`, `/availability`, `/first-team-seeker`, `/academyplus`, `/medical/share`, `/medical/records`, `/media` (its file named by an upload), `/stats` (a `season` files into the history), `/badges`, `/prefs`, `/location`, `/drills/:id/complete` (a result with video is verified; the video isn't kept), `/aging-up/complete`; `GET /player/feed`, `/player/cv`, `/player/drills`; `POST /guardian/children/:id/first-team-seeker` |
| Guardian | `GET /guardian/me`, `/guardian/children`, `/guardian/log`, `/guardian/export`, `GET`/`POST /guardian/prefs`; `DELETE /guardian/children/:id`; `POST /guardian/verify-id` (the development attestation, as in the TypeScript server), `/guardian/disclaimer`, `/guardian/children/:id/pairing-code`, `/guardian/children/:id/availability`, `/medical/share`, `/guardian/coguardian` |
| Notifications | `GET /{org,player,guardian}/notifications` (each row with its `target`: the Room tab, the agent's client, or the recipient's request, Trial, Offer or current signing package it leads to); `POST …/notifications/read`, `…/notifications/:id/ack`; `GET`/`PUT …/notification-preferences`; `POST /push/register` |
| Delivery | `GET /org/delivery`, `/admin/delivery`, `/admin/push-log`; `POST /admin/delivery/sweep`, `/admin/delivery/inject-failure`, `/callbacks/delivery` |
| Integrations | `GET`/`POST /org/webhooks` (and their delivery, signed, by the minute sweep), `POST …/:id/rotate`, `…/:id/deactivate`, `GET …/:id/deliveries`; `GET`/`POST /org/imports`, `GET …/template`, `…/:id`, `POST …/:id/commit`, `…/:id/reverse`, `GET /admin/imports`; `GET /org/prospects`, `/org/identity-reviews`, `POST …/:id/resolve`; `GET`/`POST /org/api-keys`, `POST …/:id/revoke`, `GET /api/v1/export/prospects`, `/shortlist`; `GET /org/connectors` |
| Media | `GET /media/:id`: every `/media/<id>` value in a response leaves signed for the requesting session (`media/links`), and a fetch checks that session's standing each time |
| Groups | `GET`/`POST /admin/groups`; `GET /org/groups`, `POST /org/groups/:id/invite`, `/accept`, `/leave`, `/templates`, `/programmes`, `/grants/preview`, `/grants`, `GET …/:id/report`; `GET /org/grants`, `/org/grants/counts`, `POST /org/grants/:id/revoke`, `GET /org/shared/:id`; the audit export's grants |
| Support | `GET`/`POST /org/support`, `POST /org/support/:id/approve-access`; `GET /admin/support`, `POST /admin/support/:id/reply`, `…/:id/request-access`, `GET …/:id/org-records` |
| Transitions | `GET /org/transitions`, `GET /org/transitions/:id/pack`; `GET`/`POST /player/transitions`, `/player/transitions/:id/recipients`, `/revoke-recipient`, `/withdraw`, `/place`; the guardian's `/guardian/children/:id/transitions`, `GET /guardian/children-transitions` and `/guardian/children-transitions/:id/…`; `POST /admin/players/:id/level-review`; the expiry and check-in sweep |
| Verification | `/org/verification/email` and `/email/confirm`, `/org/verification/federation` (a Grassroots club's federation registration, for Trust & Safety), `/org/verification/…` (me, identity, affiliation, work e-mail, evidence, submit, disputes, public profiles, dashboard, requests and decisions, staff, departures, licences, domains, administrators, root transfers, conflicts, player invitations, references); `/auth/org/verification/apply…`; `/admin/verification/…` (queue, cases and their assignment, evidence, decisions, root requests, domain requests, disputes, authorities, organisation revocation); `POST /player/invites/accept`, `/guardian/invites/accept`, `/guardian/children`; `GET /player/references`, `/guardian/children/:id/references`, `/org/audit/export`, `/orgs`, `/healthz` |
| Trust & Safety | `GET /admin/overview`, `/metrics`, `/reports`, `/blocks`, `/moderation`, `/clubs`, `/guardians`, `/outbox`; `POST /admin/reports/:id/resolve`, `/blocks/:id/lift`, `/clubs/:id/credentials`, `/clubs/:id/verification`, `/guardians/:id/idv` |

Behaviour not ported yet would say `Not ported yet:` in the code (`grep -rn "Not ported yet:" src`); nothing does
now. Behaviour that stays out of scope (video analysis) says `Out of scope:`.

## Known differences from the TypeScript server

- Files go straight to object storage (docs/final-port-steps.md, step 5): a client declares one, PUTs it to a signed URL
  and names the `uploadId` where it sent a `dataUrl`. The `dataUrl` fields and the chunked `/player/uploads` are
  gone, and a stored file is served on a short-lived storage link (`file: {mime, url}`) instead of base64.

- An unknown route answers `{ "error": "NOT_FOUND" }` instead of Express's HTML page.

- A `TS_REVIEWER_BOOTSTRAP_*` setting that `POST /ts/reviewers` would refuse (an id that isn't 3 to 40 letters,
  digits or dashes, a name over 80 characters, a secret outside 12 to 200), or an id without a secret, refuses to
  start in any mode. The TypeScript server cut the id and the name to fit and took any secret.
- Of several unknown fields in one body, the first in key order is named; the TypeScript server names the first
  in the order sent.
- Ids are minted inside the unit, so a refused act does not use one up.
- A delivery callback's signature is checked over the body as it arrived; the TypeScript server checks it over
  the parsed body serialised again, which is the same text for a compact JSON body.
- Two delivery sweeps can overlap here (the minute sweep and `POST /admin/delivery/sweep`); each send re-reads
  its dispatch in its own unit, so a dispatch is never sent twice.
- Distances agree with domain.ts to the last bit except within about 1e-12 km of the 50 km radius or a rounding
  edge, where macOS's `cos` and V8's `x ** 2` differ in the last place (`test/scoutbox/distance_test.gleam`).
- A foot criterion (matching, watchlists, Nobody Missed) lowers ASCII only (SQLite's `lower()`); the TypeScript server's `lower_js` lowers
  as JavaScript does. Every stored foot is ASCII.
- Second Look's changes, and its queue, break ties of time and kind by code point; the TypeScript server uses
  `localeCompare`, which orders punctuation and case differently. Only items changed in the same millisecond can
  differ.
- An empty `country` at sign-up is refused as `blank`; the TypeScript server says `too_short`.
- Of several junk saved-search filters, the first in the filters' own order is named; the TypeScript server names
  the first in the order sent.
- A signing's success-fee invoice is written in the completion's unit; the TypeScript server issues it after
  COMMIT. Either way a completion that rolls back issues none.
- A forwarded address is read as an address only in standard notation. proxy-addr also reads IPv4 written as one
  number or in hex or octal parts (`2130706433` is 127.0.0.1), so a trusted-proxy list could match such an entry
  there and not here. Proxies write standard notation.
- `/capabilities` counts a notice a preference muted once its unit commits; the TypeScript server counts it at the
  mute, so a muted notice in a unit that then fails is counted there and not here.
- A notification type with no category is delivered and listed in `/capabilities`'s `unknownTypes` in every mode,
  in code point order. The TypeScript server refuses one outside production, and lists them in the order first
  seen.
