# Final port steps

What has to happen before this server (`scoutbox-server/`) replaces the TypeScript server (`scoutbox-server-ts/`).

The batteries are all untangled, and 55 of them passed unchanged here (the retired `LEDGER.md`). Video analysis
is not part of the port. It is being rebuilt as a separate application, starting from `box-cam/`. The
TypeScript engine is kept at the tag `box-cam-ts-final`.

Work down the list. Mark each item `[**done**]` when it is done, and commit the mark with that work.

## 1. Extract Box Cam [**done**]

`box-cam/` holds what the TypeScript CV engine learned: the architecture, the API ↔ CV contract, the
domain, the thresholds, the lessons, privacy, the validation plan, and the spec snapshots and fixtures.

**Decided:** frames never pass through this server. The phone uploads them to object storage (R2) with a signed
URL the API issues at `cv/begin`, through the same upload flow as every other file (step 5), and the CV app is
told where they are.

This server's `cv_stub` stays as it is (`503 provider_unavailable`) until the CV app exists. Wiring it up is CV-app
work, not a blocker for the switch. The three TypeScript-only CV batteries go when the TypeScript server goes; their
transport-security and no-frame-persisted checks are requirements in `box-cam/docs/contract.md`.

## 2. Port what the pilot left out of scope [**done**]

Expo push, SendGrid email and the three `box_cam_*` live events are ported. Only video analysis and uploads (until
step 5) are still marked `Out of scope:`.

## 3. Close the ledger [**done**]

Every domain was ported except platform, whose one remaining battery, `uploads`, waits for step 5. Every rules
suite's recorded call got a generated case, a row in a matrix, a hand port or a reason it has no counterpart. The
ledger itself was retired in step 4; the `uploads` battery was rewritten in step 5.7.

**Still open:** the contact, signing, case and transaction routes parse with `parse_coded`, which doesn't keep
the body's key order. If a body has several unknown fields, the refusal can name a different one than the
TypeScript server would. Offers and trials were moved to `parse_in_order` for this reason. No recorded call
exercises the others, so they were left as they are.

## 4. Stop depending on the TypeScript tree [**done**]

Nothing in the Gleam server reads the TypeScript tree any more:

- `priv/migrations/*.sql` and `priv/seed.sql` are edited directly; their generators are gone.
- The rule fixtures are blessed: `test/scoutbox/blessed.gleam` checks them, and `npm run fixtures:bless` rewrites
  their answers from the Gleam rules and prints the inputs whose answer changed. They are written one case per line.
  The vocabulary matrices key each answer by its input's name and bless their axes, so they grow with a vocabulary.
  `scrypt_cases`, `distance_cases` and `proxy_cases` are kept as they are. The first bless changed only what the old
  tests didn't compare: the conflict input hashes the TypeScript fixture left null, and contacts' `respond` rows,
  which now store only whether a response moves the contact.
- `test/scoutbox/battery/` are ordinary tests; the recorder, its recordings and the generator are gone.
- The batteries are owned here: `e2e/sync.mjs` is gone, and `e2e/check.mjs` keeps the boundary check and checks
  that every battery is listed.
- `LEDGER.md`, `ledger.mjs` and `cases:check` are gone. `e2e:check` runs the boundary check, `codegen:check` and
  `sql:check`.
- `shape_diff.mjs` and `route_probe.mjs`, which compared the two servers, are gone. `perf.mjs` and `sse_check.mjs`
  run against this server only, with the perf population copied into `dev/perf_population.mjs`.
- `CLAUDE.md` says that this server is the reference. Its git rules wait for step 10, and anything that still
  describes the Node server waits for step 11.

## 5. Uploads through object storage

Files go from the client straight to Cloudflare R2 with a signed URL the server issues, and never pass through an
application server. This replaces every way the TypeScript server takes bytes:

- the `dataUrl` on `POST /player/media`
- the chunked `/player/uploads`
- the evidence `dataUrl` on personal claims, licences and root-organisation applications
- the signing-document `dataUrl`

It is not ported to the TypeScript server, so it comes after step 4: the batteries it changes are owned here now.

1. **Storage interface** (`platform/blobs`) [**done**]: `presign_put`, `presign_get`, `head`, `read_range` and `delete`. It has
   two backends:
   - `R2`: SigV4 presigning in pure Gleam with `gleam_crypto`, tested against AWS's SigV4 vectors, and `httpc` for
     HEAD, ranged GET and DELETE. Set by `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
     `R2_SECRET_ACCESS_KEY`. Without them the server uses `LocalDisk`.
   - `LocalDisk`: for development and batteries. Its signed URLs point back at this server (`PUT /blobs/<token>`,
     `GET /blobs/<token>`), the token an HMAC over the key, method, expiry, size and type. It enforces what R2
     does (the exact length and type, no overwrite), writes to a temporary file and renames it into
     `DATA_DIR/media/<key>`, and keeps what `head` answers in a small file beside it. Only that route takes a body
     larger than the usual cap.

   Clients use the same protocol against both, so the demo takes the production path. The seed writes its clips
   through `blobs` too.
2. **Upload intents, then the domain route** [**done**]. One `upload_intents` table: the id (also the blob key, random and
   never reused), purpose, owner, size, type, declared SHA-256, status (`open`, `used`, `expired`), expiry, and the
   record it produced. Each purpose (`player_clip`, `verification_evidence`, `signing_document`, later `box_cam`)
   has its own policy: who may upload, the size cap and the allowed types. An owner holds at most ten open
   uploads.
   - Each audience asks where it already authenticates: `POST /player/uploads` (clips), `POST /org/uploads`
     (evidence and signing documents), and `POST /auth/org/verification/apply/:id/uploads` (an applicant, by
     `applicantSecret`). The body is `{purpose, size, mime, sha256}`; the answer `{uploadId, put: {url, headers},
     expiresAt}`.
   - The client PUTs the file to that URL.
   - **Decided:** there is no generic `complete` route. Each domain route takes `uploadId` where it took `dataUrl`
     (`POST /player/media {title, uploadId, attendanceId}`, evidence `{uploadId, filename, note}`, a signing
     document `{uploadId, label}`), so each keeps its own checks, moderation and response.
   - The shared part is `uploads.verify`, before the unit because it calls storage: the intent is the caller's,
     open and of this purpose, and `head` finds the object with its size and type (for evidence, `read_range` also
     checks its magic bytes). It never reads the whole object: storage has already checked the SHA-256 (3).
     Inside the unit `uploads.mark_used` moves the intent from `open` to `used` with the record it made, and a
     race answers `store.stale`. **Decided:** a clip named again answers the same clip; an evidence or signing
     upload named again answers `409 UPLOAD_ALREADY_USED` with the evidence id, and the client refetches. The record
     keeps the blob key: a clip in `player_media.blob_key` (its own id comes from the counter, which a re-seed
     restarts), evidence in `ver_evidence.media_id`.
3. **Integrity.** **Decided:** this server never hashes an upload. The presigned PUT signs `content-length`,
   `content-type`, `x-amz-checksum-sha256` (the declared digest) and `If-None-Match: *` into its URL, so the
   client can't drop or change them. Storage refuses bytes whose digest differs, and a successful PUT means the
   stored bytes are the declared ones; nothing needs to read the checksum back (R2 doesn't list
   `x-amz-checksum-mode` on HeadObject). `If-None-Match: *` is applied atomically, so a key is never overwritten.
   **Decided:** storage is trusted with the bytes. A signing document's check compares the digests the revision
   and the vault row record, and that the object is still there (`head`), and never re-reads it: a document
   whose bytes changed in storage after upload is no longer detected. The batteries tamper with the recorded
   digest and remove the object instead. An R2 bucket lock against deletes and overwrites is the later backstop.
   `LocalDisk`
   enforces the same on `PUT /blobs/<token>`, hashing as it writes. The client computes the digest (WebCrypto in
   the portals, `expo-crypto`'s `digest` in the player app).

   **Still to check against a real R2 bucket** (there isn't one yet): R2's
   [release notes](https://developers.cloudflare.com/r2/platform/release-notes/) say S3 PutObject supports SHA-256
   checksums, but its [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) page doesn't list the
   header. Once `platform/blobs` exists, a `gleam dev r2-check` command uses this server's own signer to PUT the
   wrong bytes under a declared digest (expecting a refusal), the right bytes (expecting success), the same key
   again (expecting `412`), and a wrong length or type. If R2 doesn't refuse the wrong digest, fall back to a
   small Cloudflare Worker as the upload endpoint: it checks a token this server issues and stores through the R2
   binding's `put(key, body, {sha256})`, whose check is documented. Clients keep the same protocol.
4. **Reads** [**done**]. `/media/<id>` keeps its session-bound link and live standing check, and answers `302`
   to a signed GET that lives 15 minutes (**decided**: a video player keeps seeking on the link it was redirected
   to, so a minute was too short). **Decided:** the responses that carry a file as base64 (signing documents, offer
   documents, the admin and organisation evidence views) carry `file: {mime, url}` instead, the URL a signed GET
   of the same lifetime.
5. **Clean-up** [**done**]. The sweep (periodic and `POST /admin/sweep`) expires each
   open upload past its time, then removes the files of up to 100 expired uploads a sweep, outside any unit, and
   records each in `upload_intents.removed_at`; a failed removal is tried again next sweep. A route that verified
   an upload the sweep then expired finds it stale in `mark_used` and answers `410 UPLOAD_EXPIRED`, so no record
   is left without its file. Erasure still removes clip files straight after its COMMIT; the sweep retries what's
   left in `media_deletions` (`erasure.retry_removals`), skipping a clip a player still carries (the operator
   page's conflicts). The rows stay: `410` depends on them, and only open ones count towards the cap.
   - The R2 lifecycle rule that catches a PUT landing after the sweep removed its key waits for the bucket: see
     the repository's `docs/known-issues.md`.
   - Not covered: an evidence file is never removed, because nothing deletes evidence records yet.
6. **Drop the old routes** [**done**] (the `dataUrl` fields and `/player/uploads` with its chunks), `platform/media` and the
   `upload_sessions` table: the routes and `platform/media` went with 5.2, and migration 0044 drops
   `upload_sessions` and `upload_session_chunks`.
7. **Batteries** [**done**]. Add one e2e helper, `upload(client, purpose, bytes, fields)`, use it in the batteries that send a
   `dataUrl`, and rewrite `platform/uploads` around the new flow. It is the last TypeScript battery not yet answered
   here (step 3) and was never copied: start from `scoutbox-server-ts/e2e/platform/uploads.mjs`, and list
   it in `e2e/batteries.mjs`.
8. **Apps** [**moved to step 11.2**]: they talk to the TypeScript server until the switch, and it takes no uploads,
   so they change with the swap.

Multipart (resumable) uploads are left for later. When they come, they are R2 multipart on the same intent.

## 6. Host the web portals [**done**]

This server serves the built portals as the TypeScript server does (`registerAppHosting`), from `PUBLIC_DIR`
(default `public/` beside the server), and `platform/appHosting` checks it:

| Route | Portal | Folder |
| --- | --- | --- |
| `/app` | the club portal | `club` |
| `/console` | the Trust & Safety admin | `admin` |
| `/grassroots` | Grassroots | `grassroots` |
| `/agent` | the Agent portal | `agent` |

A portal is mounted only if its folder has an `index.html` at boot. A built file is served; any other GET under the
route is `index.html`, for the portal's own routes. Unlike the TypeScript server, a path naming a missing file (its
last segment has a `.`) answers `404` rather than `index.html`, so a stale tab's old asset fails visibly. Hashed
files under `assets/` may be cached for good; everything else is `no-cache`. The portals are checked after every API
route. The server never builds them: step 7's image puts each build in its folder.

## 7. Deployment [**done**]

The repository's `Dockerfile` builds the portals as before, then this server: the patched esqlite compiled
against the image's own ERTS (`dev/esqlite.mjs`) and an Erlang shipment, built on `erlang:29.1.2` with Gleam
1.19.2 (checksum-pinned) and run on `erlang:29.1.2-slim` from `/srv`. `DATA_DIR` and `PUBLIC_DIR` default to
`/srv/data` (the same volume) and `/srv/public`. `fly.toml` and `render.yaml` keep the port, the `/healthz` check,
the volume and the secrets (`ADMIN_KEY`, `MEDIA_SECRET`, `SENDGRID_API_KEY`, `EXPO_ACCESS_TOKEN`,
`SCOUTBOX_SEED_DEMO`), and name the four `R2_*` settings. CI builds the image and boots it (step 8).

Every setting registered in the TypeScript server's `domains/platform/capabilities.mjs` has its counterpart in
`platform/config.gleam`. Of the four it read elsewhere:

- `SCOUTBOX_RATE_LIMIT_PROVIDER`: it only ever accepted `memory`, which is all this server has.
- `TS_REVIEWER_BOOTSTRAP_ID`, `_SECRET` and `_NAME`: ported after the rest (`agents/reviewer_bootstrap`, proved by
  `platform/sessionsAndPorts` R). Only a reviewer can create another, so it is how a production database not seeded
  with the demo world gets its first Trust & Safety admin. Settings `POST /ts/reviewers` would refuse now refuse to
  start (README, "Known differences").

Until step 11.2 the apps still send uploads the TypeScript way, so an image deployed before then serves portals
whose upload screens fail.

## 8. CI [**done**]

`.github/workflows/ci.yml` has a "Gleam server" job (`npm run esqlite`, `gleam check`, `gleam format --check src
test dev`, `gleam test`, `npm run e2e:check`, `npm run e2e`) on the image's Erlang and Gleam versions, and an
"image" job that builds the Dockerfile, boots it as production would on a fresh volume with the demo world, and
checks `/healthz`, `/app/` and `/console/`. The TypeScript server's job stays until step 11 deletes the server,
since the apps talk to it until then. The app jobs (club build, player typecheck, tests and web export) stay.

The UI e2e suites in `e2e/` were out of scope for the battery port: run them against this server once before the
switch, after the apps' upload change (step 11.2), since their upload flows send what the TypeScript server takes.

## 9. Move the code the apps share with the server [**done**]

`scoutbox-club` and `scoutbox-grassroots` imported `scoutbox-server/roles.ts`. It is `shared/roles.ts` now, which
the portals, the Dockerfile's portal stages and the TypeScript server import. This server keeps the same rule in
`identity/roles.gleam`, and the two must agree. No other app imports from a server tree (the player app's
`domain/` files are mirrors, not imports).

## 10. Decide where this server lives [**done**]

**Decided:** in the ScoutBox repository, at `scoutbox-server/`, its history merged in. The TypeScript server
moved to `scoutbox-server-ts/` until step 11 deletes it. The repository's git rules apply: branches and PRs.

## 11. Switch over

1. **Review the known differences** [**done**]. None of `README.md`'s "Known differences from the TypeScript server"
   matters to a user: most change only the wording of a refusal for a malformed request, or an order no app relies
   on. No app reacts to `too_short`/`blank` or `unknownTypes`. The player app drops its stored session on any code
   containing `NOT_FOUND`, but only from `/player/me` and `/guardian/me`, which exist here. An unknown route's
   `NOT_FOUND` would matter only if an app calls a route this server lacks, which the UI e2e run (step 8) catches.
2. **Move the apps to uploads** [**done**] (from step 5.8), in the same release as the swap: the apps can't talk to
   both servers. `shared/upload.ts` declares a file, PUTs it to storage and returns the `uploadId`, and `fileHref`
   opens a `file.url`.
   - The player app uploads clips, and its large-video card sends one PUT with progress (the chunked client is gone).
     Its offer and signing documents open by their link. Metro watches `../shared`, with Expo's on-demand
     filesystem turned off in `app.json` so that the export can read it.
   - Pro and Grassroots upload signing and executed documents through `/org/uploads`, and open documents by their
     link. No screen sent claim or licence evidence as a file, so only their types changed. The Agent portal and
     the admin console handle no files.
   - Step 5 missed one inline file: `POST /player/drills/:id/complete` took `videoDataUrl`, kept only as
     `verified`. It takes `mediaId` now, one of the player's own clips with its file; the app uploads the drill's
     video as a clip first.
   - The bucket's CORS rule waits for the bucket: see `docs/known-issues.md`.
3. Swap the server in, delete the TypeScript server and its scripts, and re-seed (there is no production data).
4. Update `docs/architecture.md`, `scoutbox-server-ts/OPERATIONS.md` (into this server's own), `README.md` and
   `CLAUDE.md`, which all describe the Node server. This server's own `CLAUDE.md` was rewritten in step 4 and
   takes its git rules from the repository's since step 10; it needs only any remaining mention of the Node
   server.
