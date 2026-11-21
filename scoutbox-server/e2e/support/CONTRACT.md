# What the batteries need from a server

Besides its routes, a server under test must honour the settings, development routes and header below, because the
batteries rely on them. A port of the server implements all of them, or its batteries can't run unchanged.
`node scripts/e2eContract.mjs` prints which batteries use each one. `testE2ESupport` fails when a battery uses a
setting, development route or header that this page doesn't name.

Development-only means unavailable when `NODE_ENV` is `production`. Where the TypeScript server also refuses to boot
in production with the setting present (`productionConfigProblems` in `domains/platform/capabilities.mjs`), that's
noted.

## Starting the server

| Setting | Meaning |
|---|---|
| `PORT` | The port to listen on. Batteries pick free ones (`support/testPort.mjs`). |
| `DATA_DIR` | The directory holding `scoutbox.db`. A fresh directory gets the migrated schema and, unless `SCOUTBOX_SEED_DEMO` says otherwise, the demo world on first boot. A directory a fixture wrote (`sqlFixture.mjs`) is marked installed, so it isn't seeded. |
| `NODE_ENV` | `production` turns off every development-only behaviour on this page and enables the production boot checks. Anything else is development. |
| `SCOUTBOX_QUIET_LOGS` | `1`: no per-request log lines. |
| `SCOUTBOX_SEED_DEMO` | `1` loads the demo world on first boot and `0` starts empty. Unset, it seeds except in production. Any other value is refused at boot. |
| `SCOUTBOX_FAST_SWEEPS` | `1`: the periodic sweeps (expiries, delivery retries, imports) run every half second instead of every minute. The logic is unchanged. |
| `SESSION_TTL_DAYS` | A session's lifetime in days (default 30). |
| `ADMIN_KEY` | The Trust & Safety key, sent as `x-admin-key`. Unset, it is `scoutbox-admin`, which batteries that don't set it rely on. |
| `MEDIA_SECRET` | The key signing media links. Unset, a random one per process. Production refuses to boot without one. |
| `ALLOW_DEV_LOGINS` | Passwordless demo logins are available outside production anyway; set in production, the server refuses to boot. |
| `ALLOW_LOCAL_WEBHOOKS` | `1`: webhooks may target loopback addresses, so a battery can run the receiver. |
| `SCOUTBOX_ALLOWED_ORIGINS` | Comma-separated CORS origins. Unset, any origin. |
| `SENDGRID_API_KEY` | Set, mail goes through SendGrid; unset, to the local outbox (see Mail). Batteries only name it in production-configuration checks. |
| `SCOUTBOX_TRUST_PROXY` | Which proxies' `X-Forwarded-For` to believe when working out the client address (see The client address). Unset, `0`, `false`, `off` or `no`: none. `true` or `all`: every hop. A whole number N: N hops. Otherwise a comma-separated list of IPv4 or IPv6 addresses, subnets with a prefix of at least 1 (`10.0.0.0/8`, `2001:db8::/32`) and the names `loopback`, `linklocal` and `uniquelocal`, which are trusted proxies. Anything else is invalid: nothing is trusted, and production refuses to boot (`TRUST_PROXY_INVALID`). `/capabilities` reports the setting as `proxy_trust.state`: `not_configured`, `configured` or `invalid`. |

## The client address

Per-address budgets (the `/auth` limiter, `passport_share_read`, `pairing_attempt`) are keyed on the client address.
`/__rate-limits` shows it as the `key` of a `passport_share_read` or `pairing_attempt` bucket. It is worked out as
Express's `trust proxy` does:

1. List the socket's address, then the `X-Forwarded-For` entries from right to left.
2. Walk the list from the socket's address while each address is trusted, and stop at the first that isn't. The
   client address is where the walk stops, or the last entry when every entry before it was trusted.

With a hop count N, the first N entries are trusted, so the client address is the (N+1)th, or the last entry if the
list is shorter. With `true`, every entry is trusted, so the client address is the leftmost forwarded address. With
a list, an entry is trusted when it lies in one of its addresses or subnets. An IPv4-mapped IPv6 address
(`::ffff:127.0.0.1`) matches as its IPv4 address. With nothing trusted, `X-Forwarded-For` is ignored.

## Mail

| Route | Meaning |
|---|---|
| `/admin/outbox` | `GET` with `x-admin-key`: the mail outbox, newest first, as `{ items, nextCursor }`, paged with `limit` and `cursor` (junk paging is 400). A mail the server sent is `{ id, ts, to, subject, text, transport, delivered }`. An e-mail notice the delivery centre dispatched is `{ id, at, channel, to, text, providerMessageId, provider }`. |

Batteries find a mail by `to` and read a one-time code from its `text`, after the words `code is`. The stored outbox
row never holds a code the mail marks as secret: its text reads `[code withheld — delivered to the recipient only]`
instead. With the local outbox as the transport (no `SENDGRID_API_KEY`), the outbox is the delivery, so
`/admin/outbox` shows such a mail's full text, code included, for as long as the process that sent it runs. After a
restart it shows the stored text. With SendGrid, it never shows the code.

## Test providers

Synthetic stand-ins for outside services, development only. None of them makes a network call.

| Setting | Meaning |
|---|---|
| `AGENT_VERIFICATION_TEST_PROVIDER` | `1`: the agent verification provider is the synthetic one, so agent licences and identities can be verified in a test. |
| `TEST_LICENCE_REGISTRY` | `1`: the synthetic coaching-licence register answers; `down`: it is unavailable. Unset, no register is configured. |
| `BOX_CAM_TEST_PROVIDER` | `1`: the test-only Box Cam analysis provider is usable, so Box Cam sessions produce results without real computer vision. Batteries outside Box Cam (trust scores, matching, second look, the development hub) use it to create those results. |

## Faults

| Setting, route or header | Meaning |
|---|---|
| `SCOUTBOX_FAULTS` | Fault rules at boot: `kind:path[:arg]`, separated by `;`, where `*` matches one path segment. Kinds: `delay:PATH:MS` (answer normally after MS ms), `unavailable:PATH` (503 `SOURCE_UNAVAILABLE`, retryable), `timeout:PATH:MS` (hold MS ms, then 504 `SOURCE_TIMEOUT`, retryable), `retryable:PATH[:N]` (503 for the first N hits, default 1), `fatal:PATH` (500 `INTERNAL`, not retryable), `internal:STEP[:N]` (the named step inside a unit of work throws for its first N hits, so the unit rolls back; N = 0 only counts the hits). A simulated failure's body carries `simulated: true`. Refused at boot in production. |
| `/__faults` | `GET` lists the rules with how often each was reached (`{ rules: [{ kind, pattern, arg, hits }] }`). `POST { rules }` replaces them, in the same syntax, and returns `{ ok: true, rules }`, or 400 `FAULT_RULE_INVALID`. Development only. |
| `/__rate-limits` | `GET` lists the live rate-limit buckets as `{ buckets: [{ action, key, spent }] }`, so a battery can see which budget a request drew on without exhausting it. Development only. |

## Time

| Setting or header | Meaning |
|---|---|
| `SCOUTBOX_TEST_CLOCK` | `1`: a request may choose its own time with `x-scoutbox-test-clock`. Development only, and refused at boot in production. |
| `x-scoutbox-test-clock` | Milliseconds since the epoch. With the test clock on, the request is handled as if it were that time; a missing or invalid value means the real time. |

## Stored forms

Fixtures write rows in the migrated schema (`support/schema.sql`), so a server must read the stored forms they plant.

| Column | Form |
|---|---|
| `password_hash` | `scrypt$<salt>$<hash>`: the salt is 32 hex digits, used as its text, and the hash is scrypt (N = 16384, r = 8, p = 1) to 32 bytes, in hex. `support/password.mjs` writes one. |
| `sessions.token_hash` | The bearer token's SHA-256, in hex (`support/sqlFixture.mjs`). |
