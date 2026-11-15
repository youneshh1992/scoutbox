# scoutbox-server (Gleam)

A Gleam port of a slice of the ScoutBox server: organisation staff sign-in, sessions, staff removal, invitations,
MFA and delivery preferences. It answers the TypeScript server's `platform/staff` e2e battery unchanged.

```sh
gleam check          # type-check (fast)
gleam test           # unit tests: the store, input refusals, TOTP vectors, paging, staff and invite rules
gleam run            # the server on PORT (default 4000), data in DATA_DIR (default ./data)
npm run e2e          # build the Erlang release, then run the batteries against it
npm run e2e:sync     # re-copy the batteries from ../../scoutbox/scoutbox-server/e2e
npm run e2e:check    # fail if a copied battery differs from its source
```

Settings (`src/scoutbox/platform/config.gleam`): `PORT`, `DATA_DIR`, `ADMIN_KEY` (development default
`scoutbox-admin`, refused in production), `NODE_ENV=production` (turns off demo sign-ins and the seed),
`SCOUTBOX_QUIET_LOGS=1`.

## Layout

- `src/scoutbox/platform/`: shared by every domain.
  - `store`: the unit of work. One writer process, read-only pooled connections, effects as data, and a crash
    inside a unit rolls back.
  - `input`: request validation in the TypeScript server's refusal format.
  - `http`, `paging`, `ids`, `migrations`, `limits`/`table` (in-memory rate limits), `vocabulary` (column
    enums), `config`, `wisp_ewe` (vendored Wisp-on-Ewe adapter).
- `src/scoutbox/identity/`: organisations, staff, sessions, invitations, TOTP and their routes.
- `src/scoutbox/messaging/`: the mail outbox and staff delivery preferences.
- `src/scoutbox/safety/`: the ledger and the admin outbox view.
- `priv/migrations/`: the tables this slice owns, copied from the TypeScript server's migrated schema.
- `e2e/`: batteries copied by `e2e/sync.mjs` (do not edit them), and the helpers they import.

## Routes

| Route | Battery-checked |
|---|---|
| `GET /health` | boot only |
| `POST /auth/org/login` | yes |
| `POST /auth/org/accept-invite` | yes |
| `GET /org/staff`, `POST /org/staff/:id/remove` | yes |
| `POST /org/invites` | yes |
| `POST /org/mfa/setup`, `/verify` | yes |
| `POST /org/mfa/disable` | no (unit-tested parts only) |
| `PUT /org/delivery/prefs` | yes |
| `GET /admin/outbox` | yes |

Where behaviour depends on a domain not ported yet, the code says `Not ported yet:` (`grep -rn "Not ported" src`):
club setup's `lookingFor` and `federationCheck` (always empty), open safety reports in `safeguardingCertified`,
imports and coverage plans in onboarding, closing live event streams on removal, the player count in `/health`,
and password-protected organisations (scrypt).

## Known differences from the TypeScript server

- An unknown route answers `{ "error": "NOT_FOUND" }` instead of Express's HTML page.
- Of several unknown fields in one body, the first in key order is named; the TypeScript server names the first
  in the order sent.
- Ids are minted inside the unit, so a refused act does not use one up.
- The outbox view lists mailer records only. Delivery records arrive with the messaging domain.
