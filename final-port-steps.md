# Final port steps

What has to happen before this server replaces the TypeScript server in `../scoutbox`.

The batteries are all untangled, and 53 of them pass unchanged here (`scoutbox-server/LEDGER.md`). Video analysis
is not part of the port. It is being rebuilt as a separate application, starting from `../scoutbox/box-cam/`. The
TypeScript engine is kept at the tag `box-cam-ts-final` in `../scoutbox`.

Work down the list. Mark each item `[**done**]` when it is done, and commit the mark with that work.

## 1. Extract Box Cam [**done**]

`../scoutbox/box-cam/` holds what the TypeScript CV engine learned:

- the architecture and the job flow
- the API ↔ CV contract
- the domain
- the starting thresholds with their reasoning
- the lessons
- privacy
- the validation plan
- spec snapshots and the synthetic fixtures

**Decided:** frames never pass through this server. The phone uploads them to object storage (R2) with a signed
URL the API issues at `cv/begin`, through the same upload flow as every other file (step 5), and the CV app is
told where they are.

This server's `cv_stub` stays as it is until the CV app exists (`503 provider_unavailable`). Replacing it with
issuing the upload URL, notifying the CV app and recording its result is CV-app work, not a blocker for the switch.

The three TypeScript-only CV batteries (`boxCamCvProvider`, `boxCamCvRobustness`, `combineProductionGate`) go
when the TypeScript server goes. Their transport-security and no-frame-persisted checks are written down as
requirements in `box-cam/docs/contract.md`.

## 2. Port what the pilot left out of scope [**done**]

These are marked `Out of scope:` in `src/`. A production server needs every one, except video analysis. Uploads are
not ported as the TypeScript server has them: they are redesigned in step 5.

1. **Expo push transport** (`messaging/push.gleam`). Today every push is `dev-log`.
2. **SendGrid email transport** (`platform/operator.gleam`). Today there is no outbound transport.
3. **The three `box_cam_*` live events** (`platform/live_event.gleam`).

Then update the `Out of scope:` lists in `CLAUDE.md` and `scoutbox-server/README.md` so that only video
analysis and uploads (until step 5) remain.

## 3. Close the ledger

By `LEDGER.md`:

| Domain | Batteries to go |
| --- | --- |
| recruitment | 13 |
| agents | 6 |
| platform | 3 |
| development | 1 |
| discovery | 1 |

That leaves about 4,500 rule cases pending (4,003 of them in recruitment) and about 350 hand-port calls.

**Decide first** whether every pending case must be generated before the switch, or whether a domain whose
batteries pass end to end may close its remaining cases with a recorded reason. The cases are recorded from the
TypeScript rules, so they must be generated (or frozen, see step 4) **before** the TypeScript server is deleted.

## 4. Stop depending on the TypeScript tree

These read `../scoutbox/scoutbox-server`, so they stop working when it is deleted:

- `dev/migrations_sql.mjs`
- `dev/seed_sql.mjs`
- the `dev/*_cases.mjs` scripts
- `dev/battery_cases.mjs`
- `dev/ledger.mjs`
- `dev/shape_diff.mjs`
- `dev/perf.mjs`
- `dev/sse_check.mjs`
- `e2e/sync.mjs`

Make this repository its own reference:

1. **Migrations and seed.** `priv/migrations/*.sql` and `priv/seed.sql` become the source of truth: edit them
   directly and drop the generator. This includes the match-facts triggers: `CLAUDE.md`'s "a new input to the
   facts needs a trigger in the TypeScript migration" changes to the SQL migration here.
2. **Test fixtures.** Freeze everything under `test/fixtures/` and the generated `test/scoutbox/battery/` tests as
   owned files. Retire the generators, or keep them only behind a flag for as long as the tag is checked out.
3. **Batteries.** `scoutbox-server/e2e/` becomes owned here, with no more sync. Remove `e2e/sync.mjs` and the
   "never edit a copy" rule. The launcher `e2e/support/server.mjs` is the only file that needs to change.
4. **Checks.** Retire `ledger.mjs`, `cases:check` and `LEDGER.md` once step 3 is closed. Keep `sql:check` and
   `codegen:check` in `e2e:check`.
5. **Docs.** Rewrite `CLAUDE.md`'s opening ("a pilot port… the TypeScript server is the reference") and the
   sections on batteries and rules suites to match.

## 5. Uploads through object storage

Files go from the client straight to Cloudflare R2 with a signed URL the server issues, and never pass through an
application server. This replaces all three ways the TypeScript server takes bytes:

- the `dataUrl` on `POST /player/media`
- the chunked `/player/uploads`
- the evidence and signing-document `dataUrl`

It is not ported to the TypeScript server, so it comes after step 4: the batteries it changes are owned here by
then.

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
   `dataUrl`, and rewrite `platform/uploads` around the new flow.
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
3. Update `../scoutbox/docs/architecture.md`, `scoutbox-server/OPERATIONS.md`, `README.md` and `CLAUDE.md`,
   which all describe the Node server.
