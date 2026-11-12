# Deployment plan: initial summary

Written 12 Nov 2026. Exploratory: nothing here is built, and anything needing a new external service waits until
the feature freeze lifts.

**Summary:** one SQLite server for the main app comfortably carries 50k users in year one. The work is in four
places: video storage, off-box backups, the Box Cam split, and knowing where the scaling ceiling is.

## What the current architecture means for deployment

- **It's built for one process holding one SQLite file.** Writes are synchronous `BEGIN IMMEDIATE` transactions, and
  WAL mode is already on (`scoutbox-server/store.mjs`). Several things live inside the process:
  - rate limits (`SCOUTBOX_RATE_LIMIT_PROVIDER` only accepts `memory`);
  - live events (`domains/platform/liveSync.mjs`);
  - the background timers that work through retries, reminders and expiries.

  That's ideal for starting on one server, and it tells you exactly what has to change to scale.
- **The load is small.** 50k registered users probably means a few hundred active at peak and a handful of writes
  per second. The performance target is a median under 5 ms per request with 100k players. One Node process at that
  speed handles hundreds of requests per second. The data itself will probably be a few GB.
- **Video is the real cost and load.** Today uploads arrive as base64 chunks inside JSON and go to `DATA_DIR/media/`
  on local disk (`domains/media/uploads.mjs`). That costs CPU on the main server and fills its disk. The storage
  adapter is "Not built", and production refuses to start if `S3_BUCKET` is set. Building that adapter is the
  biggest change needed before a real deployment.

## Recommended setup for year one

| Piece | Choice | Why |
|---|---|---|
| Main server | **Hetzner Cloud** dedicated-vCPU VM (CCX13/23 class, roughly €15–35/mo) in Germany or Finland | Best price-to-performance by a wide margin, and generous included traffic. Hetzner has no UK region, but EU hosting is fine under UK GDPR. |
| Deploys | Docker (the `Dockerfile` already exists) plus **Kamal**, or a plain `docker compose` with Caddy for HTTPS | One `git push` → deploy with no Kubernetes. A few seconds of downtime per deploy is acceptable at this stage. |
| Edge | **Cloudflare** for DNS, CDN for the four web portals, DDoS protection, and Cloudflare Pages for the Expo web export | Free or cheap. Set `SCOUTBOX_TRUST_PROXY` and make sure the client IP comes from Cloudflare's header, or the `/auth` rate limit becomes global. |
| Media | **Cloudflare R2**, with uploads and downloads going straight from the app to R2 via presigned URLs | Free egress matters a lot for video, and file bytes never touch the Node process. The existing signed-URL design (`MEDIA_SECRET`) maps naturally onto this. |

### Alternatives

- **Fly.io** is already configured (`fly.toml`, London region) and works if you'd rather run no server yourself. It
  costs more per CPU. Before any real use, two settings must change:
  - `auto_stop_machines = "stop"` and `min_machines_running = 0` stop the machine when it's idle, which also stops
    the background timers. Pin it to exactly one always-on machine.
  - Never let Fly start a second machine. Each machine gets its own volume, so you'd end up with two separate
    databases that drift apart.
- **Render**: disk-backed services can't scale out and have no zero-downtime deploys. Fine for the demo, not as the
  main host.

## Backups

The current `POST /admin/backup` makes a safe copy, but it writes it to the same disk as the live database. That
isn't a backup if the server dies. Use two layers:

1. **Litestream, running alongside the server, continuously streaming the database to R2.** It needs WAL mode, which
   is already on. It gives you restore to any point in time with a few seconds of data loss at most, and it costs
   pennies. Keep around 30 days of history.
2. **A nightly snapshot (`VACUUM INTO`) sent to a second provider**, such as Backblaze B2 or a Hetzner Storage Box.
   Encrypt it first, for example with `age`: this is minors' data. This covers losing the Cloudflare account, or a
   bug that corrupts data slowly and gets faithfully streamed by Litestream.

Notes:

- **Media** in R2 is already durable. Turn on object versioning or a short-lived lock so an accidental mass delete
  can be undone. Once media moves to R2, the backup's `media/` folder and its manifest format will need to change.
- **Privacy:** backups keep deleted players' data until the retention window expires. Write the retention period
  into the privacy policy.
- **Restore drills:** a scripted monthly test restore is worth having once you're live, not before.

## How to scale, step by step

1. **Bigger server.** Cheap and immediate, but it has a limit: request handling runs on one CPU core. Extra cores
   only help the database and Litestream.
2. **Several Node processes on the same server, sharing the one SQLite file.** WAL already allows many readers and
   one writer across processes. Three things need to move out of the process first:
   - the background timers, into one dedicated worker process (otherwise every process runs them);
   - rate limits, into SQLite or Cloudflare's rate limiting;
   - live-event fan-out, through a small events table or a pub/sub service.

   This step probably takes you well past year one.
3. **More than one server.** This is where SQLite's single-writer design really stops you. The realistic options are
   LiteFS (Fly's replicated SQLite, which Fly has deprioritised) or moving to Postgres. Postgres drivers are
   asynchronous, and the units of work are deliberately synchronous (async callbacks are refused). Keeping all SQL
   inside the repositories makes the move possible, but the unit-of-work design would have to change. Treat it as a
   known future project, not a reason to change course now.

## Box Cam as a separate service

Rust with `ffmpeg` (via `ffmpeg-next`, or by calling the binary) and the `opencv` crate is a sound choice. The shape:

- **The main API stays the only thing that writes to the database.** The app gets a presigned URL and uploads the
  video straight to R2. The API records a job row, which fits the existing "background work is stored state with
  bounded retries" pattern.
- **The worker pulls jobs from the API** over authenticated HTTP. It downloads from R2, processes the video, then
  posts the result back to a callback signed with a shared secret (like the delivery-callback pattern). Box Cam
  steps only accept a result while a session is in the right state, so a repeated callback can't double-record.
  Because the worker asks for jobs, adding a second worker later needs no changes on the API side, and no separate
  queue service.
- **Hosting:** if it's classic CV only, a dedicated Hetzner CPU server (a cheap AX machine or a CCX VM). If pose or
  ML models come in, either a Hetzner GPU server (GEX44, roughly €180/mo) or per-second GPU billing (Modal, RunPod)
  if uploads are bursty.
- **Conformance:** keep the existing golden fixtures, `domains/development/boxcam/cv/evaluation.json` and
  `holdout.json`, as the pass/fail test for the Rust engine. The Combine production gate already reads these files,
  so they give a ready-made definition of "the port matches".
- **Playback:** have the worker also produce small playback copies, so you aren't storing and streaming raw phone
  footage. Cloudflare Stream is the managed alternative if you'd rather not run transcoding.

## Rough monthly cost at 50k users

- Main server: €20–40.
- Box Cam worker: €40–200, depending on CPU or GPU.
- R2: the big variable. At 200 MB of stored video per user, that's about 10 TB, or about $150/mo, with free egress.
  Video retention and compression are the biggest cost levers.
- Backups and Cloudflare: under $20.

Total: low hundreds per month. Provider prices are approximate; check current pricing before committing.

## Before a real launch

1. A real storage adapter with direct-to-R2 uploads.
2. Litestream plus nightly snapshots stored off the server.
3. Fly settings fixed, if staying on Fly.
4. Proxy and client-IP settings for Cloudflare.
5. A job endpoint and signed callback for the Box Cam worker.
