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

| Domain | Batteries to go | Cases pending | Hand-port calls to do |
| --- | --- | --- | --- |
| recruitment | 9 | 268 | 179 |
| agents | 6 | 407 | 15 |
| platform | 3 | 54 | 51 |

Development and discovery are closed. Platform's three are `uploads` (waits for step 5); `dates`, which records
only agents and trial rules and so closes with C and D below; and `storeGuarantees`, which is
`buildRecruitmentJourney`'s 19 calls and closes with C.

**Decided:** a pending function is generated wherever a Gleam rule plays its role, and closed in `NO_COUNTERPART`
with its reason where this server structurally has none (it refuses what the rule cleans, its types or schema hold
what the rule checks, or the rule only shapes a response the batteries compare). A domain is not closed wholesale
because its batteries pass. A difference a generated case finds is fixed in the Gleam.

The recordings are frozen in `scoutbox-server/dev/battery_cases/recordings.json.gz` (every distinct call, about
320 KB), so this step no longer has to finish before the TypeScript server is deleted. `npm run cases:record`
records them again while the tree exists.

A rule over a small finite domain is proved over its whole matrix rather than call by call (`dev/battery_cases/
matrices.mjs`, status `matrix`). The lifecycle validator is the first: `canTransitionRecruitmentCase` and
`availableActions` are proved by `test/scoutbox/recruitment/lifecycle_matrix_test.gleam`.

**What the first pass found** (commits `c87fd78`, `ec7e2ad`):

- Almost every pending function has a Gleam counterpart, so very little closes in `NO_COUNTERPART`. The `*View`
  functions and the `*Integrity`, `*Corrupt` and `*Consistency` checks all have one (`contact_rules`, `trial_rules`,
  `offer_rules`, `signing_rules`, `decisions`). The batteries don't check fields such as `hasNote` or
  `liveRevisionId`, so closing these as "only shapes a response" would hide untested behaviour. They are generated
  with their module.
- When a TypeScript rule takes closures over a store (`reads.trials.byId`, `staffById`), split the Gleam into a fetch
  and a pure judgement over the fetched rows. The pure half is then tested directly (`development/hub_evidence.judge`,
  `hub_evidence_test.gleam`). Where the decision needs real lookups, test it against `support.fresh_store` and the
  demo seed (`hub_assignee_test.gleam`).
- A rule built inline in a route is moved into the rules module as a function, so a case can call it
  (`hub_rules.plan_summary_json`, `goal_snapshots`).
- Some calls are already answered over HTTP by a battery. `HAND_PORTED` may name that battery
  (`e2e/development/hub.mjs` for `validateTarget("160+")`), with a comment giving the check.
- `npm run cases` regenerates; a printer that throws turns that call into a hand-port call with the thrown reason.
  The quickest way to see a function's calls is a few lines of script over `recordings.json.gz`: under
  `suites[battery].pool`, each call is `{module, name, args, result, why, assertion}`, with `args` and `result`
  as JSON text. For closure calls, read the rules
  suite in `../scoutbox/scoutbox-server/scripts/rules/`.

**What offers found** (fixed in the Gleam): a body with several unknown fields named the wrong one, because the
offer routes parsed without the body's key order (`http.json_body_in_order` and `input.parse_in_order` now); and an
expiry sent as `true`, `{}` or `[]` was "wrong shape" rather than "not a date-time", because `offer_rules` had its
own copy of parseInstant (it uses `temporal.instant` now). The contact, signing, trial and case routes still parse
with `parse_coded`, so expect the first difference again in their modules. A rule that reads a field through the
route's shape is tested through the same check (`offer_rules.terms_check`, composed in `base.offer_terms`), not
through the rule alone. A fixture that leaves out a NOT NULL column (a revision's status, createdAt or terms) is
refused by its printer, not given the base row's value.

**C. Recruitment, one TypeScript module at a time.** For each module: map every pending function in
`dev/battery_cases/map.mjs`, with that module's record printers (built on `base.gleam` row builders), including its
views and integrity checks. Port its hand-port calls, regenerate, run `gleam test` and the domain's batteries, and
commit. In this order:

1. **offers** [**done**] (`offers/offer.mjs`, `offer_rules`): `validateTerms` 48, `effectiveRevisionStatus` 37,
   `validateExpiry` 25, `canRespondToRevision` 20, `minorOfferPathwayOpen` 18, `offerIntegrity` 18, `offerEvidence`
   14, `validateDocumentRefs` 14, then the smaller ones and the three views. The hand-port calls are
   `effectiveRevisionStatus` (4), `validateExpiry` (4) and `offerEvidence` (1).
2. **signings** [**done**] (`signings/signing.mjs`, `signing_rules`): `requiredPartiesFor` 63, `signingIntegrity`
   40, `canStart` 13, `minorSigningPathwayOpen` 11, `signingConsistency` 10, then the rest and the three views.
   `completion_gate` judged the whole Offer; it now takes the facts the TypeScript gate does (`GateOffer`,
   `GateRevision`, built by the route with `gate_offer` and `gate_revision`). `signingConsistency` without rows
   isn't a call either caller makes, so a COMPLETED package passed none is ported by hand.
3. **decisions** [**done**] (`lifecycle/decision.mjs`, `decisions`): `validateDecisionReasons` 30,
   `decisionIntegrity` 25, `validateOutcome` 25, `validateEvidenceRefShapes` 16, `resolveEvidenceRefs` 12 (12
   hand-port calls), `validateNote` 11, `decisionView` 9, `chainHead`, `duplicateFinalHeads`, `isFormal`, `draftView`
   and the rest. No difference turned up. On both servers the four validators sit behind the route's schema, which
   refuses junk under the rule's own code (`DECISION_INPUT_CODES`). So a call the shape refuses compares only the
   code (`base.ByShape`), and the rule's own message for it is never sent. `decisions` now exports the shape's checks
   and codes, and `duplicate_heads` and `requirements_json` come out of inline code. `decisionMilestone` has no
   caller and is closed in `NO_COUNTERPART`. A partial lifecycle or a reference without `meta` is a storable row (the
   columns are nullable), so only the views refuse those fixtures. The views are ported over complete rows, with the
   TypeScript views' answers. `resolveEvidenceRefs` and `summariseAssessments` run against seeded rows.
4. **trials** [**done**] (`lifecycle/trial.mjs` and `domain.ts`'s trial rules, `trial_rules`): `trialStateAllows`
   37, `validateTrialDetails` 35, `validateScheduleInput` 27 (its `mintId` closure calls are hand ports),
   `chooseTrialSlot` 17, `trialIntegrity` 10, then the rest. The 16 `parseTrialDate` hand-port calls are here too.
   No difference turned up. `choose_slot` comes out of the request route, and the session and venue shapes and the
   input codes out of the trial routes, so a case calls the route's own checks. The trial routes parse in key
   order now, as the offer routes do. A trial fixture is printed as the Gleam row holds it, even where only a CHECK
   forbids it (a schedule with no timezone, a session that ends before it starts), because `integrity` names those
   problems. `validateScheduleInput` runs as the route runs it: the shape, `validate_schedule`, ids minted in
   order, then `order_sessions`. The block gate never sees "report" or "assess", and the trials battery checks both
   over HTTP (B10, B8). The views' fixture has no request id, so the views are ported over a stored trial. The 14
   calls left on `recruitment/trials` are `createEvidenceProvider`'s.
5. **contacts** [**done**] (`lifecycle/contact.mjs`, `contact_rules`): `contactIntegrity` 21,
   `resolveContactRecipient` 20 (all closure calls: fetch and judge), `validateContactContent` 8,
   `validateContactReply` 5, and the rest. One difference turned up: `integrity` named a snapshot with a mode and
   no time, but not one with a time and no mode, which the TypeScript check calls malformed too (only a CHECK
   forbids either); it names both now. `recipients.resolve` is a fetch and a pure `judge` over the player row, its
   access and the guardians linked to it; the judgement is tested over rows, and the visibility (an agency or an
   unverified club and a minor) against the seed (`recipients_test.gleam`). The reply rule comes out of the request
   route (`contact_rules.validate_reply`), and the words shape and default code out of the contact routes, so the
   content and reply cases call the routes' own checks; words that aren't text compare only the code
   (`base.ByShape`), as decisions' do. `base.body` drops lone surrogates as `http` does, so a case reads a body as
   the route reads it. The integrity fixture prints only what the check reads, and the views are ported over
   complete rows. No call sent several unknown fields, so the contact routes' `parse_coded` showed no key-order
   difference.
6. **lifecycle** [**done**] (`lifecycle/lifecycle.mjs`): `isLifecycleReason` 19, `validateLifecycleReasons` 14,
   `toAnalyticsRecruitmentStage` 13, and `rooms/shared.mjs#adoptionStatusForStage` 12 (plus
   `roomStatusForStage`'s 14 hand-port calls). One difference turned up: the route's shape lets
   `reasonCodes: null` through, and the TypeScript rule then refuses it (`LIFECYCLE_REASONS_INVALID`); the Gleam
   route read null as no reasons and moved the case. It refuses it now. The reasons rule comes out of the lifecycle
   route (`case_lifecycle.validate_reasons`, with the route's shape and input codes) and carries the TypeScript
   rule's `prohibited` and `unknown`, which the contract keeps from the client. `derivedConditions` comes out of
   the journey (`case_lifecycle.conditions`). `toAnalyticsRecruitmentStage` has no caller and is closed in
   `NO_COUNTERPART`. The prototype-key stages are ported by hand: no such text becomes a `Stage`. What is left on
   the lifecycle battery is item 8's and the evidence calls below.
7. **The journey model** (`lifecycle/journeyModel.mjs`, `journey`): `nextActionFor` (251 calls) is proved over its
   whole matrix, as `canTransitionRecruitmentCase` is (`dev/matrix_cases.mjs`, `matrices.mjs`). The `current*For*`
   selectors, `canonicalStageFor`, `playerStageFor` and `validateRecruitmentJourney` are generated.
8. **The journey builder and the evidence provider.** `buildRecruitmentJourney` (94 hand-port calls, store-backed,
   including `storeGuarantees`' 19) and `createEvidenceProvider` (51), as below.

**D. Agents, one TypeScript module at a time**, the same way:

1. **compliance policy** (`compliance/policy.mjs`, `approach_policy` and `compliance_store`): `evaluateMinorGate`
   34, `selectPolicyVersion` 22, `isRegulatoryMinor` 19, `applicablePolicySet` 13, `earliestPermittedApproachAt`
   12, `representationScopeProblem` 12, `ruleAt`, `ruleStatusAt`, `resolveScope` and `evaluatePolicy`.
2. **conflict** (`compliance/conflict.mjs`, `conflict`): `evaluateConflict` 44, `mostSevere` 36,
   `consentSufficiency` 33, `inputHashOf` and `canonicalJson` (`conflict.input_hash`), `conflictSummaryForParty`.
3. **integration** (`integration/integration.mjs`, `integration`): `agentSurfaceDecision` 30,
   `effectiveHandoffStatus` 21, `agentClientBasis` 13, `handoffBlockers` 12, `surfaceIsRegulated` 12,
   `normaliseDisclosure` (both modules), `contactRouting`, and `duplicateTransactionOf` (closure calls).
4. **transactions** (`transactions/transaction.mjs`, `transaction_rules`): `canSeeVisibility` 36 and
   `actorTransitionAllowed` 14 look like matrix candidates. Then `timelineVisible` 15, `complianceStateFrom`,
   `partyRevisionOf` and the rest.
5. **The provider** (`compliance/provider.mjs`, `verification_provider`): `facetFromProviderAnswer`, and
   `createVerificationProvider`'s closure calls.

When C and D are done, platform/dates closes too, and only platform/uploads is left (step 5).

**Left for later in this step:**

- **The lifecycle's evidence calls go with `createEvidenceProvider`.** 21 of `canTransitionRecruitmentCase`'s calls
  pass the TypeScript fixture provider (`createEvidenceProvider` over plain records: lifecycle H1, H5 and the
  inbound-to-signed sweep; contacts' draft and delivered contact; decisions P15–P19 and the rest of its sweep; offers
  A82–A85; offersAdversarial R-p11). They test which records count as evidence, which here is the SQL in
  `case_lifecycle.evidence`. Port them with `createEvidenceProvider`'s own probes as one store-backed
  `evidence_test.gleam` that seeds contacts, decisions, Offers and signings. Then add `canTransitionRecruitmentCase`
  to `HAND_PORTED`: its other hand-port calls are done (the 15 Gleam's types can't hold are in
  `case_lifecycle_test.gleam`, and the 3 whose provider always says yes are rows of the matrix).

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
