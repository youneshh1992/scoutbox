# Final port steps

What has to happen before this server replaces the TypeScript server in `../scoutbox`.

The batteries are all untangled, and 55 of them pass unchanged here (`scoutbox-server/LEDGER.md`). Video analysis
is not part of the port. It is being rebuilt as a separate application, starting from `../scoutbox/box-cam/`. The
TypeScript engine is kept at the tag `box-cam-ts-final` in `../scoutbox`.

Work down the list. Mark each item `[**done**]` when it is done, and commit the mark with that work.

## 1. Extract Box Cam [**done**]

`../scoutbox/box-cam/` holds what the TypeScript CV engine learned: the architecture, the API ↔ CV contract, the
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

## 3. Close the ledger [**done**, except `platform/uploads`]

Every domain was ported except platform, whose one remaining battery, `uploads`, waits for step 5. Every rules
suite's recorded call got a generated case, a row in a matrix, a hand port or a reason it has no counterpart. The
ledger itself was retired in step 4; the `uploads` battery is carried by step 5.7.

**Still open:** the contact, signing, case and transaction routes parse with `parse_coded`, which doesn't keep
the body's key order. If a body has several unknown fields, the refusal can name a different one than the
TypeScript server would. Offers and trials were moved to `parse_in_order` for this reason. No recorded call
exercises the others, so they were left as they are.

## 4. Stop depending on the TypeScript tree [**done**]

Nothing in this repository reads `../scoutbox` any more:

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
5. **Clean-up** [**done**, except the lifecycle rule]. The sweep (periodic and `POST /admin/sweep`) expires each
   open upload past its time, then removes the files of up to 100 expired uploads a sweep, outside any unit, and
   records each in `upload_intents.removed_at`; a failed removal is tried again next sweep. A route that verified
   an upload the sweep then expired finds it stale in `mark_used` and answers `410 UPLOAD_EXPIRED`, so no record
   is left without its file. Erasure still removes clip files straight after its COMMIT; the sweep retries what's
   left in `media_deletions` (`erasure.retry_removals`), skipping a clip a player still carries (the operator
   page's conflicts). The rows stay: `410` depends on them, and only open ones count towards the cap.
   - **Still to do with the real bucket:** an R2 lifecycle rule as the backstop. A PUT that began just before its
     URL expired and was still sending after the 15-minute grace can land after the sweep removed its key.
   - Not covered: an evidence file is never removed, because nothing deletes evidence records yet.
6. **Drop the old routes** (the `dataUrl` fields and `/player/uploads` with its chunks), `platform/media` and the
   `upload_sessions` table.
7. **Batteries.** Add one e2e helper, `upload(client, purpose, bytes, fields)`, use it in the batteries that send a
   `dataUrl`, and rewrite `platform/uploads` around the new flow. It is the last TypeScript battery not yet answered
   here (step 3) and was never copied: start from `../scoutbox/scoutbox-server/e2e/platform/uploads.mjs`, and list
   it in `e2e/batteries.mjs`.
8. **Apps** (`../scoutbox`). The player upload screen, the club and Grassroots signing panels, claim evidence and
   the evidence and document viewers change to "ask for a URL, PUT, send the `uploadId`" and to reading
   `file.url`. The bucket needs a CORS rule for the web portals.

Multipart (resumable) uploads are left for later. When they come, they are R2 multipart on the same intent.

## 6. Host the web portals

The TypeScript server serves the built portals, and this one doesn't
(`../scoutbox/scoutbox-server/domains/platform/http.mjs:50`):

| Route | Portal |
| --- | --- |
| `/app` | the club portal |
| `/console` | the Trust & Safety admin |
| `/grassroots` | Grassroots |
| `/agent` | the Agent portal |

Each route serves `index.html` for its client-side routes. Either add static serving (wisp's `serve_static` with
a single-page fallback), or host the portals separately and say so in the deploy docs.

## 7. Deployment

`../scoutbox/Dockerfile`, `fly.toml` and `render.yaml` build a Node container. Write a Gleam image that:

- builds the patched esqlite (`npm run esqlite`) inside the image
- builds the portals, as the current Dockerfile does
- uses the same `/srv/data` volume
- uses the same `/healthz` check
- uses the same secrets: `ADMIN_KEY`, `MEDIA_SECRET`, `SENDGRID_API_KEY`, `EXPO_ACCESS_TOKEN` and
  `SCOUTBOX_SEED_DEMO`, plus the R2 bucket and credentials from step 5

Check that every setting registered in `domains/platform/capabilities.mjs` has its counterpart in
`platform/config.gleam`.

## 8. CI

This repository has no CI. In `../scoutbox/.github/workflows/ci.yml`, the "Server" job runs the TypeScript
server's boundaries check, `tsc`, unit tests and batteries. Replace it with:

- `npm run esqlite`
- `gleam check`
- `gleam format --check`
- `gleam test`
- `npm run e2e:check`
- `npm run e2e`

The app jobs (club build, player typecheck, tests and web export) stay. The UI e2e suites in `../scoutbox/e2e/`
were out of scope for the battery port: run them against this server once before the switch.

## 9. Move the code the apps share with the server

`scoutbox-club` and `scoutbox-grassroots` import `scoutbox-server/roles.ts`, and the Dockerfile copies it into the
portal builds. Move it, and any other rule an app imports from the server tree, into a shared package first, so
that deleting the TypeScript server doesn't break the apps.

## 10. Decide where this server lives

There are two options:

- Replace `../scoutbox/scoutbox-server` with this repository's `scoutbox-server/`. Choose whether to bring its
  history in with a subtree merge.
- Keep it as a separate repository, and have `../scoutbox` depend on it for deploys and CI.

This decides which repository's git rules apply (this one commits to `main`; `../scoutbox` works on branches
through PRs).

## 11. Switch over

1. Review `scoutbox-server/README.md`'s "Known differences from the TypeScript server" once, and confirm that none
   matters to a user.
2. Swap the server in, delete the TypeScript server and its scripts, and re-seed (there is no production data).
3. Update `../scoutbox/docs/architecture.md`, `scoutbox-server/OPERATIONS.md`, `README.md` and
   `../scoutbox/CLAUDE.md`, which all describe the Node server. This server's own `CLAUDE.md` was rewritten in
   step 4. Here it needs only its git rules from step 10, and any remaining mention of the Node server.
