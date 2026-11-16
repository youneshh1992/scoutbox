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
| `SENDGRID_API_KEY` | Set, mail goes through SendGrid; unset, to the local outbox. Batteries only name it in production-configuration checks. |

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
