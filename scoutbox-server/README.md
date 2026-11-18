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
Safety lanes, and the readiness an Offer reads), the Conflict & Compliance Engine (reviewer sign-in and
administration, the agent's own compliance contexts and their conflict evaluation, regulatory consents, facet
rechecks, the compliance overview, the review lifecycle and every kind of decision, dual-control policy versions,
and the Trust & Safety audit and metrics), Trials (the invitation, acceptance,
schedule and its revisions, attendance, completion, cancellation, Box Cam evidence by reference, the trial day, the
calendar export and the mandatory report), structured assessments, the Football Passport's trial timeline, and
Second Look and Nobody Missed (Recruitment Briefs, Evaluation Coverage, and the stored match facts they query),
Explainable Matching and Dynamic Watchlists (one match engine, which Nobody Missed shares), and the club's insight: exposure, the review queue, calibration sessions, the decision review and coverage planning. It
answers every battery in `e2e/batteries.mjs` unchanged.

```sh
npm run esqlite        # once after cloning (Gleam can't resolve the project without it): the patched esqlite
gleam check            # type-check (fast)
gleam test             # unit tests, the generator's snapshots, and the rules proved against domain.ts
gleam run              # the server on PORT (default 4000), data in DATA_DIR (default ./data)
npm run e2e            # build the Erlang release, then run the batteries against it
npm run e2e:sync       # re-copy the batteries from ../../scoutbox/scoutbox-server/e2e
npm run e2e:check      # fail if a copied battery, a generated rule test or LEDGER.md differs from its source,
                       # or a query fails sql:check
npm run cases          # record the TypeScript rules suites' calls; write dev/battery_cases/report.json and the
                       # generated tests in test/scoutbox/battery/ (mapping: dev/battery_cases/map.mjs)
npm run ledger         # write LEDGER.md: every TypeScript battery, where its checks went, which domains are ported
npm run codegen        # regenerate src/scoutbox/rows and src/scoutbox/vocab from priv/migrations
npm run codegen:check  # fail if the committed row modules differ from what the migrations generate
npm run sql:check      # prepare every query the source spells out against the migrated schema, and check its
                       # placeholders against its arguments and each argument against the column it binds
                       # (`gleam dev sql-check --verbose` lists the queries it can't read and the arguments
                       # bound as plain text to an id or vocabulary column)
node dev/perf.mjs      # latency of the hot paths on both servers (after `gleam export erlang-shipment`)
node dev/sse_check.mjs # the event stream's behaviour, and its fan-out to 100 and 1000 streams, on both servers
```

Settings (`src/scoutbox/platform/config.gleam`): `PORT`, `DATA_DIR`, `ADMIN_KEY` (development default
`scoutbox-admin`, refused in production), `NODE_ENV=production` (turns off demo sign-ins and the seed),
`SCOUTBOX_QUIET_LOGS=1`, `SCOUTBOX_FAST_SWEEPS=1` (the sweeps every half second, and the delivery and webhook
retry ladders in milliseconds), `MEDIA_SECRET` (signs media links; in development a random key per boot,
required in production), `DELIVERY_CALLBACK_SECRET` (default: the local fake provider's), and
`ALLOW_LOCAL_WEBHOOKS=1` (a webhook may go to a loopback address).

## Layout

- `src/scoutbox/rows/`, `src/scoutbox/vocab/`: **generated**, one module per table and per shared vocabulary
  (`dev/scoutbox/codegen.gleam`). A row module has the `Row` type, its decoder, `columns`, `width`, `qualified`,
  `insert` and `new(…)`; a CHECK vocabulary is an enum. A domain record is usually the generated `Row`, with what
  is derived from it as functions. Don't edit them: change the migration and run `npm run codegen`.
- `src/scoutbox/platform/`: the store (unit of work, readers, effects), `input` (refusals in the TypeScript
  format), `sql` (fragments that carry their arguments), `distance`, `keyset` and `paging`/`pages`, `http`, `ids`,
  migrations, limits, config.
- `src/scoutbox/rules/`: the pure rules, each proved against the TypeScript one: `age`, `visibility` (one SQL
  expression for every read), `moderation`, `journey`; `time_zones` is generated.
- `src/scoutbox/identity/`, `safety/`, `discovery/`, `recruitment/`, `development/`, `messaging/`,
  `verification/`, `enterprise/`: the domains. `verification/claims` holds the pure rules, proved by the generated
  tests in `test/scoutbox/battery/verification/`.
- `vendor/esqlite.patch`: our change to esqlite, the NIF under sqlight. `npm run esqlite` (`dev/esqlite.mjs`)
  fetches the pinned Hex tarball, checks it, applies the patch and compiles the NIF into `vendor/esqlite/` (not
  committed), which `gleam.toml` takes as a path dependency in place of the Hex copy. The patch adds `fetchall`
  (every row in one call, on a normal scheduler) and `fetchall_dirty`; `platform/scoutbox_store_ffi.erl` caches
  each connection's statements and runs one on the dirty scheduler once it has taken over a millisecond. Stock
  esqlite runs every row's `step` on the dirty schedulers, which made reads several times slower than Node and
  stopped them scaling. An upgrade is a new pin and checksum in `dev/esqlite.mjs` and the patch reapplied.
- `priv/migrations/`: the tables, copied from the TypeScript server's migrated schema. `priv/seed.sql`: its demo
  seed, dumped by `dev/seed_sql.mjs`.
- `dev/`: the generator, and the Node scripts that take data from the TypeScript server: `seed_sql.mjs`,
  `distance_cases.mjs` and `rule_cases.mjs` (test cases from domain.ts), `time_zones.mjs`, `shape_diff.mjs` (the
  same requests of both servers, compared shape by shape) and `perf.mjs`.
- `e2e/`: batteries copied by `e2e/sync.mjs` (do not edit them), and the helpers they import.

## Routes

Every route below is exercised by a battery, except where marked.

| Area | Routes |
|---|---|
| Health | `GET /health` |
| Sign-in | `POST /auth/org/login` (with an organisation password: scrypt, checked before the unit), `/auth/org/register-grassroots`, `/auth/org/accept-invite`, `/auth/logout`, `/auth/player/signup`, `/auth/guardian/signup`, `/auth/guardian/login`; `/auth/sso/start` and `/callback` refuse in production (development: not ported) |
| Staff | `POST /org/tactical` (the lead gate only), `GET /org/staff`, `POST /org/staff/:id/remove`, `/org/invites`, `/org/mfa/setup`, `/verify`, `/disable` (unit-tested only), `PUT /org/delivery/prefs` |
| Discovery | `GET /org/players`, `/org/players/:id`, `/org/shortlist`, `/org/filmroom`, `/org/fixtures`; `POST /org/players/:id/notes`, `/save` (no battery), `/shortlist`, `/org/searches` (create only) |
| Case workspace | `POST /org/cases` (a plain case), `/org/cases/:id/stage` (refused on a case with a Room), `/org/cases/:id/decision` (a non-lead's sign waits for a lead's approval); each answers the whole case record |
| Matching | `GET /org/matching/vocabulary`, `POST /org/matching` (by cursor; a brief's criteria or the club's own) |
| Watchlists | `GET`/`POST /org/watchlists`, `GET`/`PATCH /org/watchlists/:id` (reading one derives its membership and records the transitions), `GET …/:id/history`, `POST …/:id/room` |
| Second Look | `GET /org/second-look` (reconciled with the source records on every read), `/org/second-look/:id`, `/org/second-look/:id/changes`; `POST /org/second-look/:id/review`, `/dismiss`, `/reopen-room` (through the Rooms' own reopen path) |
| Nobody Missed | `GET`/`POST /org/recruitment-briefs`, `GET`/`PATCH /org/recruitment-briefs/:id`, `GET /org/nobody-missed` (over the stored match facts, by cursor), `GET /org/evaluation-coverage`; `POST /org/nobody-missed/add-to-room`, `/review` and `/dismiss` (no battery) |
| Insight | `POST /org/exposure/impressions`, `GET /org/exposure/report`, `/org/review-queue`, `POST /org/review-queue/:id/later`, `GET /org/discovery-rotation`, `/org/decision-review`, `/player/exposure`; `GET /org/players/:id/evidence-gaps`, `POST /org/evidence-gaps/:id/request`, `/dismiss` and `/reviewed` (no battery); `GET`/`POST /org/calibration`, `GET /org/calibration/:id`, `POST …/submit`, `…/close` (no battery), `…/notes`; `GET /org/assessment-templates` (the list only); `GET`/`POST /org/coverage/fixtures`, `/org/coverage-plans`, `/org/coverage/assignments`, `POST …/assignments/:id/complete`, `…/cancel` (no battery), `GET /org/coverage/suggestions`; not the sweep (review reminders, pruning old exposure) |
| Grassroots club | `POST /org/squad`, `/org/open-trials`, `/org/friendlies` (posting only) |
| Recruitment | `POST /org/players/:id/request` (a contact, or a direct trial request with its days, venue and notes; refused while a trial report is outstanding), `/player/requests/:id/respond`, `/guardian/requests/:id/respond` (a trial invitation's acceptance is the trial's birth); `GET /org/requests`, `/org/ledger`, `/org/funnel`, `/player/inbox`, `/guardian/inbox`; `GET /org/signings` (newest first, by cursor), `GET /org/invoices` (the success fees), `POST /org/players/:id/signing` (the legacy recorder, refused when the workflow owns the signing); `GET /org/recruitment-analytics` (the Director Dashboard: every family, the window, filters and trend), `/org/recruitment-analytics/catalogue`, `/org/recruitment-analytics/rows` (the drill-down); `GET /org/feed`; `GET /orgs/directory` (no Grassroots pathway record) |
| Contacts | `GET`/`POST /org/rooms/:id/contacts`, `GET`/`PATCH …/contacts/:cid`, `POST …/contacts/:cid/cancel`, `…/contacts/:cid/send` (the in-app request, the guardian's email copy, the agent beside the player when their authority holds), `POST …/contacts/external`, `GET /org/recruitment/contact-policy`; a recipient's answer lands on the contact through the respond route; `GET /player/insights`; `GET /player/journeys`, `GET /guardian/children/:id/journeys` (what was shared with the recipient), `GET /org/agent/clients/:id/journey` (what the client routed or shared to the agent, as far as the agent's basis, scope and licence open it), signing packages included |
| Trials | `GET`/`POST /org/rooms/:id/trials`, `GET …/trials/:tid`, `POST …/schedule`, `…/reschedule`, `…/cancel`, `…/complete`, `…/sessions/:sid/attendance`, `…/sessions/:sid/evidence`, `…/evidence/:eid/unlink`, `GET …/evidence`, `…/evidence/candidates`, `GET /org/recruitment/trial-policy`; `GET /org/trials`, `/org/trials/:id/day`, `/org/trials/:id/ics`, `POST /org/trials/:id/staff`, `/arrival`, `/cancel`, `/postpone`, `/checkin`, `/report`; `GET /player/trials`, `POST /player/trials/:id/confirm-schedule`, `/decline-schedule`, `/cancel`, `/consent`, `/emergency-contact`, `GET …/safety-pack`, and the guardian's `/guardian/trials…` |
| Signings | `GET /org/rooms/:id/signing`, `POST /org/offers/:id/signing`, `GET`/`PATCH /org/signings/:id`, `GET …/history`, `GET`/`POST …/document`, `POST …/executed-document`, `…/ready`, `…/parties/club/complete`, `…/complete` (the gate, the one signing writer and the move to signed in one unit), `…/cancel`, `…/void`, `…/supersede`; `POST /admin/signings/:id/void`; `GET /player/signings`, `…/:id`, `…/:id/document`, `POST …/:id/complete`; the guardian's (dormant: the minor pathway is closed); `GET /org/agent/clients/:id/signings`; an Offer's view carries its signing summary; `POST /player/availability` refuses a status while a completed signing's contract stands |
| Assessments | `GET`/`POST /org/assessments`, `PUT /org/assessments/:id`, `POST …/submit`, `GET /org/players/:id/assessment-compare` |
| Rooms | `GET`/`POST /org/rooms`, `GET /org/rooms/needs-attention`, `/summaries`, `GET`/`PATCH /org/rooms/:id`, `POST …/status`, `GET …/snapshots`, `…/activity`, `GET`/`POST …/comments`, `PATCH`/`DELETE …/comments/:cid`, `POST …/tasks`, `PATCH …/tasks/:tid`, `GET`/`POST …/decisions`, `POST …/evidence/:eid/review`, `…/assessment-assignments`, `…/evidence-requests`, `…/combine-requests`, `…/link`; `GET /org/rooms-funnel`, `/admin/rooms/overview` |
| Case | `GET /org/rooms/:id/journey` (the club's projection), `POST /org/rooms/:id/lifecycle` (a named action, gated by the evidence provider); `GET /org/rooms/:id/decision`, `POST`/`PATCH`/`DELETE …/decision/draft`, `POST …/decision/finalize`, `…/decision/supersede` |
| Offers | `GET`/`POST /org/rooms/:id/offers`, `GET /org/offers/:id`, `…/history`, `PATCH …/draft`, `POST …/issue`, `…/withdraw`, `…/revise`, `GET /org/recruitment/offer-policy`; `GET /player/offers`, `/player/offers/:id`, `…/documents/:docId`, `POST …/accept`, `…/decline`, `…/share-agent`; the guardian's `/guardian/offers…` |
| Agents | `GET /org/agent/me`, `/home`, `GET`/`POST /org/agent/profile`, `POST …/profile/facets/:facet/submit`; `GET /org/agent/agency`, `GET`/`POST …/agency/team`, `PATCH …/agency/team/:userId`, `POST …/team/:userId/end`, `PATCH …/agency/settings`, `GET …/agency/compliance`, `…/agency/audit`; `GET /org/agent/players`, `/clients`, `POST /org/agent/clients/request`, `GET /org/agent/clients/:id`, `POST …/terminate`, `GET …/opportunities`, `…/offers`; `GET /org/agent/opportunities`, `/inbox`; `GET /player/agent/relationships`, `POST …/:id/confirm`, `/decline`, `/terminate`, `/dispute`, `PATCH …/:id/sharing`; `GET /admin/agent/relationships`, `/admin/agent/profiles` (read only); `POST /org/agent/transactions`, `POST /org/agent/transactions/:id/notes`; `POST /org/rooms/:id/transaction-handoff` |
| Compliance | `GET /ts/me`, `GET`/`POST /ts/reviewers`, `POST …/:id/revoke`; `GET /ts/compliance/reviews`, `GET …/:id`, `POST …/:id/start`, `/resolve`, `/cancel`, `/supersede`; `GET /ts/compliance/audit`, `/metrics`; `GET`/`POST /ts/compliance/policies`, `POST …/:id/approve`; `GET`/`POST /org/agent/compliance/contexts`, `GET …/:id`, `POST …/:id/evaluate`, `/parties`, `/representations`, `/representations/:repId/withdraw`, `/close`, `/consents/request`; `POST /org/agent/compliance/facets/:facet/recheck`; `GET /org/agent/compliance/overview`, `/policies`; `GET /org/compliance/consents`, `/player/agent/consents` and their answers; `GET /admin/compliance/reviews`, `/admin/compliance/policies` (read only). Not ported: the minors approach (no route exists in either server) and the public `policy_version_published` ping |
| Audit and erasure | `GET /org/audit` (Room, Contact, trial, agency and ledger rows); `DELETE /player/account` |
| Opportunity board | `POST /org/opportunities` (published at once; eligibility typed, and forced for a Grassroots club), `GET /org/opportunities` (newest first, by cursor, with application counts); `GET /player/opportunity-board` (club opportunities the player is eligible for, then the open days). Not ported: applications, closing, structured requirements |
| Passport | `GET /player/football-passport` (the trial and assessment timeline only), `GET /player/trust-profile`, `/org/players/:id/trust-profile` (the Trust Score, from its sources' records); `POST /org/players/:id/evidence` (a club's own claim); `GET /org/players/:id/evidence-gaps` |
| Combine | `GET /org/combine/protocols` (the registry, recorded from the TypeScript server by `dev/combine_protocols.mjs`), `/org/combine/players/:id` (results: none, until Box Cam's service hands them over) |
| Threads | `GET /org/channels`, `/org/channels/counts`, `/player/channels`, `/guardian/channels`, `/admin/channels`; `POST /{org,player,guardian}/channels/:id/messages`, `/read`, `/typing` |
| Safety | `POST /player/block`, `/player/report`, `/guardian/report`; `GET /player/reports`; `POST /guardian/block`, `/org/report`, `GET /guardian/reports`, `/org/reports` (no battery) |
| Player | `GET /player/me`, `/player/export`, `GET`/`PATCH /player/box-cam/prefs`, `POST /player/box-cam/sessions/:id/cv/finalize` (its rate limit and session check only); `POST /player/timeline`, `/availability`, `/first-team-seeker`, `/academyplus`, `/medical/share`, `/medical/records`, `/media` (no upload), `/stats`, `/badges`, `/prefs` |
| Guardian | `GET /guardian/me`, `/guardian/children`, `/guardian/log`; `DELETE /guardian/children/:id`; `POST /guardian/children/:id/availability`, `/medical/share`, `/guardian/coguardian` |
| Notifications | `GET /{org,player,guardian}/notifications` (each row with its `target`: the Room tab, the agent's client, or the recipient's request, Trial, Offer or current signing package it leads to); `POST …/notifications/read`, `…/notifications/:id/ack`; `GET`/`PUT …/notification-preferences`; `POST /push/register` |
| Delivery | `GET /org/delivery`, `/admin/delivery`, `/admin/push-log`; `POST /admin/delivery/sweep`, `/admin/delivery/inject-failure`, `/callbacks/delivery` |
| Integrations | `POST /org/webhooks` (and their delivery, signed, by the minute sweep) |
| Media | `GET /media/:id`: every `/media/<id>` value in a response leaves signed for the requesting session (`media/links`), and a fetch checks that session's standing each time |
| Support | `POST /org/support`, `/admin/support/:id/reply` |
| Transitions | `GET /org/transitions`; `POST /player/transitions`, `/player/transitions/:id/recipients`, `/revoke-recipient`; the guardian's `/guardian/children/:id/transitions`, `/guardian/children-transitions/:id/…` |
| Verification | `/org/verification/email` (requesting a code; not confirming it), `/org/verification/…` (me, identity, affiliation, work e-mail, evidence, submit, disputes, public profiles, dashboard, requests and decisions, staff, departures, licences, domains, administrators, root transfers, conflicts, player invitations, references); `/auth/org/verification/apply…`; `/admin/verification/…` (queue, cases, evidence, decisions, root requests, domain requests, disputes, authorities, organisation revocation); `POST /player/invites/accept`, `/guardian/invites/accept`, `/guardian/children`; `GET /player/references`, `/guardian/children/:id/references`, `/org/audit/export`, `/orgs`, `/healthz` |
| Trust & Safety | `GET /admin/overview`, `/metrics`, `/reports`, `/blocks`, `/moderation`, `/clubs`, `/guardians`, `/outbox`; `POST /admin/reports/:id/resolve`, `/blocks/:id/lift`, `/clubs/:id/credentials`, `/clubs/:id/verification`, `/guardians/:id/idv` |

Behaviour that depends on a domain not ported yet says `Not ported yet:` in the code (`grep -rn "Not ported" src`).
The largest: the similarity engine ("more like this"),
the insight sweep, coach vouches, club setup, staff SSO, the Expo push transport, process metrics, and password sign-in
for players and guardians (a new player account stores a hash no password matches). `dev/shape_diff.mjs` lists where responses differ because of them.

## Known differences from the TypeScript server

- An unknown route answers `{ "error": "NOT_FOUND" }` instead of Express's HTML page.
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
- The directory's text search lowers ASCII only (SQLite's `lower()`); the TypeScript server lowers as JavaScript
  does, accented letters included.
- An empty `country` at sign-up is refused as `blank`; the TypeScript server says `too_short`.
- Of several junk saved-search filters, the first in the filters' own order is named; the TypeScript server names
  the first in the order sent.
- A Trust Score never says `simulatedEvidenceIncluded: true`: no provider here produces simulated evidence. The
  TypeScript server says true whenever `BOX_CAM_TEST_PROVIDER` is set.
- Inside a Room, the Passport is its version, the player and the club history only, and has no revision; a
  snapshot records no Passport revision either. A Room's Combine results, development activity and the
  missing-evidence rules that read assessment ratings are not ported (`Not ported yet:`).
- The journey, the evidence provider and the decision surface see no Contact records or Trials (`Not ported yet:`):
  no route here records one.
- The journey has no Trust & Safety projection (`Not ported yet:`).
- A signing's success-fee invoice is written in the completion's unit; the TypeScript server issues it after
  COMMIT. Either way a completion that rolls back issues none.
- A transaction workspace stays at DRAFT: only opening one and its notes are ported, so no party can confirm.
- A mail's withheld one-time codes (`SendMail`'s `secrets`) read as the placeholder in `/admin/outbox` too. The
  TypeScript server's dev transport keeps the full text in process memory and shows it there.
