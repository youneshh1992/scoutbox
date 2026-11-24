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
application server. This replaces all three ways the TypeScript server takes bytes:

- the `dataUrl` on `POST /player/media`
- the chunked `/player/uploads`
- the evidence and signing-document `dataUrl`

It is not ported to the TypeScript server, so it comes after step 4: the batteries it changes are owned here now.

1. **Storage interface** (`platform/blobs`): `presign_put`, `presign_get`, `head`, `read_range` and `delete`. It has
   two backends:
   - `R2`: SigV4 signing in pure Gleam with `gleam_crypto`, and `httpc` for HEAD, ranged GET and DELETE.
   - `LocalDisk`: for development and batteries. Its signed URLs point back at this server (`PUT /blobs/<token>`,
     `GET /blobs/<token>`) and it stores under `DATA_DIR/media`.

   Clients use the same protocol against both, so the demo takes the production path.
2. **One upload flow for every purpose** (`player_clip`, `verification_evidence`, `signing_document`, later
   `box_cam`). Each purpose has its own policy: who may upload, the size cap, the allowed types and whether the
   title is moderated.
   - `POST …/uploads` with `{purpose, size, mime, sha256, …}` checks the policy, writes an `upload_intents` row,
     and answers `{uploadId, put: {url, headers}, expiresAt}`.
   - The client PUTs the file to that URL.
   - `POST …/uploads/:id/complete`, with the purpose's own fields (`attendanceId` for the Verified Clip, the claim
     or the signing package), checks the object's size, type and checksum with `head`. For evidence it also checks
     the magic bytes with `read_range`. Then one unit creates the domain record and closes the intent. A retry
     answers the same.
3. **Integrity.** The signed PUT includes `x-amz-checksum-sha256`, so storage refuses bytes that don't match the
   declared digest. Keys are never reused. Signing's `bytes_mismatch` check compares the stored checksum instead
   of re-reading the file. **Check first** that R2 enforces a signed SHA-256 checksum. If it doesn't, `complete`
   hashes the object for the purposes that need a digest.
4. **Reads.** `/media/<id>` keeps its session-bound link and live standing check, and answers `302` to a signed GET
   that lives about 60 seconds.
5. **Clean-up.** The sweep deletes the objects of expired intents. The `media_deletions` queue calls
   `blobs.delete` and retries on failure, which covers erasure. An R2 lifecycle rule on unfinished uploads is the
   backstop.
6. **Drop the old routes** (the `dataUrl` fields and `/player/uploads` with its chunks) and the `upload_sessions`
   table.
7. **Batteries.** Add one e2e helper, `upload(client, purpose, bytes, fields)`, use it in the batteries that send a
   `dataUrl`, and rewrite `platform/uploads` around the new flow. It is the last TypeScript battery not yet answered
   here (step 3) and was never copied: start from `../scoutbox/scoutbox-server/e2e/platform/uploads.mjs`, and list
   it in `e2e/batteries.mjs`.
8. **Apps** (`../scoutbox`). The player upload screen, the club and Grassroots signing panels and claim evidence
   change to "ask for a URL, PUT, complete". The bucket needs a CORS rule for the web portals.

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
