# scoutbox-server (Gleam)

A Gleam port of four slices of the ScoutBox server: organisation staff (sign-in, sessions, invitations, MFA), the
safeguarding core (reports, blocks, moderation, the Trust & Safety console, the Discovery Ledger), players and
guardians (sign-up, the player record, the directory, guardians and their children), verification (claims and
their review, organisation applications, domains, the administrator hierarchy, squad invitations, coach
references), message threads (answering a request opens one), and notifications with their preferences, push, the
delivery centre, webhooks and support tickets. It answers nine of the TypeScript server's e2e batteries unchanged:
`platform/staff`, `platform/safeguarding`, `platform/playersAndGuardians`, `platform/storeGuarantees`,
`platform/messaging`, `platform/notifications`, `platform/delivery`, `verification/organisationsAndStaff` and
`verification/organisationsAndStaffAdversarial`.

```sh
gleam check            # type-check (fast)
gleam test             # unit tests, the generator's snapshots, and the rules proved against domain.ts
gleam run              # the server on PORT (default 4000), data in DATA_DIR (default ./data)
npm run e2e            # build the Erlang release, then run the batteries against it
npm run e2e:sync       # re-copy the batteries from ../../scoutbox/scoutbox-server/e2e
npm run e2e:check      # fail if a copied battery, a generated rule test or LEDGER.md differs from its source
npm run cases          # record the TypeScript rules suites' calls; write dev/battery_cases/report.json and the
                       # generated tests in test/scoutbox/battery/ (mapping: dev/battery_cases/map.mjs)
npm run ledger         # write LEDGER.md: every TypeScript battery, where its checks went, which domains are ported
npm run codegen        # regenerate src/scoutbox/rows and src/scoutbox/vocab from priv/migrations
npm run codegen:check  # fail if the committed row modules differ from what the migrations generate
```

Settings (`src/scoutbox/platform/config.gleam`): `PORT`, `DATA_DIR`, `ADMIN_KEY` (development default
`scoutbox-admin`, refused in production), `NODE_ENV=production` (turns off demo sign-ins and the seed),
`SCOUTBOX_QUIET_LOGS=1`, `SCOUTBOX_FAST_SWEEPS=1` (the sweeps every half second, and the delivery and webhook
retry ladders in milliseconds), `DELIVERY_CALLBACK_SECRET` (default: the local fake provider's), and
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
| Sign-in | `POST /auth/org/login`, `/auth/org/accept-invite`, `/auth/player/signup`, `/auth/guardian/login` |
| Staff | `GET /org/staff`, `POST /org/staff/:id/remove`, `/org/invites`, `/org/mfa/setup`, `/verify`, `/disable` (unit-tested only), `PUT /org/delivery/prefs` |
| Discovery | `GET /org/players`, `/org/players/:id`, `/org/shortlist`, `/org/filmroom`, `/org/fixtures`; `POST /org/players/:id/notes`, `/save` (no battery), `/shortlist` |
| Recruitment | `POST /org/players/:id/request` (contact), `/player/requests/:id/respond`, `/guardian/requests/:id/respond`; `GET /org/ledger`, `/org/funnel`, `/guardian/inbox` |
| Threads | `GET /org/channels`, `/org/channels/counts`, `/player/channels`, `/guardian/channels`, `/admin/channels`; `POST /{org,player,guardian}/channels/:id/messages`, `/read`, `/typing` |
| Safety | `POST /player/block`, `/player/report`, `/guardian/report`; `GET /player/reports`; `POST /guardian/block`, `/org/report`, `GET /guardian/reports`, `/org/reports` (no battery) |
| Player | `GET /player/me`, `/player/export`; `POST /player/timeline`, `/availability`, `/first-team-seeker`, `/academyplus`, `/medical/share`, `/stats`, `/badges`, `/prefs` |
| Guardian | `GET /guardian/me`, `/guardian/children`, `/guardian/log`; `POST /guardian/children/:id/availability`, `/medical/share`, `/guardian/coguardian` |
| Notifications | `GET /{org,player,guardian}/notifications`; `POST …/notifications/read`, `…/notifications/:id/ack`; `GET`/`PUT …/notification-preferences`; `POST /push/register` |
| Delivery | `GET /org/delivery`, `/admin/delivery`, `/admin/push-log`; `POST /admin/delivery/sweep`, `/admin/delivery/inject-failure`, `/callbacks/delivery` |
| Integrations | `POST /org/webhooks` (and their delivery, signed, by the minute sweep) |
| Support | `POST /org/support`, `/admin/support/:id/reply` |
| Transitions | `POST /player/transitions`, `/player/transitions/:id/recipients`, `/revoke-recipient`; the guardian's `/guardian/children/:id/transitions`, `/guardian/children-transitions/:id/…` |
| Verification | `/org/verification/…` (me, identity, affiliation, work e-mail, evidence, submit, disputes, public profiles, dashboard, requests and decisions, staff, departures, licences, domains, administrators, root transfers, conflicts, player invitations, references); `/auth/org/verification/apply…`; `/admin/verification/…` (queue, cases, evidence, decisions, root requests, domain requests, disputes, authorities, organisation revocation); `POST /player/invites/accept`, `/guardian/invites/accept`, `/guardian/children`; `GET /player/references`, `/guardian/children/:id/references`, `/org/audit/export`, `/orgs`, `/healthz` |
| Trust & Safety | `GET /admin/overview`, `/metrics`, `/reports`, `/blocks`, `/moderation`, `/clubs`, `/guardians`, `/outbox`; `POST /admin/reports/:id/resolve`, `/blocks/:id/lift`, `/clubs/:id/credentials`, `/clubs/:id/verification`, `/guardians/:id/idv` |

Behaviour that depends on a domain not ported yet says `Not ported yet:` in the code (`grep -rn "Not ported" src`).
The largest: trials and trial requests, signings, the similarity engine ("more like this"),
insights, coach vouches, club setup, live event streams, the Expo push transport, process metrics, and
password hashing (scrypt), which also means a password-protected account can't sign in yet and a new player
account stores a hash no password matches. `dev/shape_diff.mjs` lists where responses differ because of them.

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
- The directory's text search lowers ASCII only (SQLite's `lower()`); the TypeScript server lowers as JavaScript
  does, accented letters included.
- An empty `country` at sign-up is refused as `blank`; the TypeScript server says `too_short`.
- A refused `badges` that is not a list says `invalid`; the TypeScript server says `not_list`.
