# Deploying ScoutBox

The `Dockerfile` builds one container that runs everything a pilot needs:

- the API server on port 4000 (SQLite persistence in `/srv/data`)
- the club app at **`/app`**
- the Trust & Safety console at **`/console`** (gated by `ADMIN_KEY`)

The player app is an Expo project: export it for web
(`npx expo export --platform web`) with `EXPO_PUBLIC_API_URL` pointing at the
deployed API, and host the output on any static host — or ship the native app
through EAS later.

## Quick local run of the production container

```bash
docker build -t scoutbox .
docker run -p 4000:4000 -v scoutbox_data:/srv/data -e ADMIN_KEY=change-me scoutbox
# → http://localhost:4000/app  (club)   http://localhost:4000/console  (T&S)
```

## Fly.io

```bash
flyctl launch --no-deploy          # accepts the checked-in fly.toml
flyctl volumes create scoutbox_data --size 1
flyctl secrets set ADMIN_KEY=$(openssl rand -hex 16)
flyctl deploy
```

## Render

Connect the repo in the Render dashboard — `render.yaml` declares the service,
disk and health check. Set `ADMIN_KEY` in the dashboard.

## Switching the adapters live

Every external integration is behind an adapter with a fully working dev
transport. Setting the env var switches it to the real provider — no code
changes:

| Capability | Env var | Dev behaviour until set |
|---|---|---|
| Email (verification codes, notices) | `SENDGRID_API_KEY` (+ optional `MAIL_FROM`) | mail lands in the admin **Mail outbox** tab |
| Push notifications | `EXPO_ACCESS_TOKEN` | deliveries recorded in `/admin/push-log` |
| Guardian ID verification | `ONFIDO_API_TOKEN` | instant attestation with an audit reference |
| Billing / success fees | `STRIPE_SECRET_KEY` | invoices recorded on the dev ledger (admin **Billing** tab) |
| Media object storage | `S3_BUCKET` (+ credentials) | files stored under `/srv/data/media` |

Also configurable: `ADMIN_KEY` (T&S console key — always set it in
production), `PORT`.

## CI

`.github/workflows/ci.yml` runs on every push: server unit tests + the
51-check API end-to-end against a freshly seeded server, plus typecheck and
production builds of the club app, player app and T&S console.
