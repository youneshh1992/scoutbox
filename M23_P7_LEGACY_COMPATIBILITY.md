# M23 P7 — Legacy compatibility

What existed before P7 that touched signings, what happens to it, and the
drift regression that keeps it that way (§6, §72, §88; the inventory is in
M23_P7_EXISTING_SIGNING_WRITER_AUDIT.md).

## 1. The legacy route: `POST /org/players/:id/signing`

Before P7 this route appended to `db.signings` itself, set the player's
level, timeline, availability and `contractStatus`, issued the invoice and
notified. After P7 it is a **thin caller of the ONE writer**:

1. `legacyRecordingBlocker(playerId, orgId)` refuses `409 SIGNING_CANONICAL_REQUIRED`
   when the player has an ACCEPTED Offer from this club, or any live or
   completed signing package between this club and player (K-X0, live C7c).
   The canonical workflow owns that signing.
2. Otherwise it calls `recordCompletedSigning({ player, org, actor, at, legacy: { note } })`
   — `method: 'LEGACY_RECORDED'`, no package, no revision, no digest, no
   contract — and runs the same effects. The row keeps every field existing
   readers consume (`ts`, `playerName`, `orgName`, `userId`, `scoutName`,
   `insideAttributionWindow`).

So a grassroots club recording a signing that never went through an Offer
still can; a Pro club that issued and had an Offer accepted must complete
the signing through the workflow. Nothing about a legacy row is
reinterpreted as a package (X4, #49).

## 2. The legacy status writer: `POST /org/rooms/:id/status`

Unchanged and unable to reach `signed`: the P5 evidence rule requires a
`db.signings` row (`422 ROOM_EVIDENCE_REQUIRED`, L2). A case whose history
says `signed` without a row (a P4-era import) is reported by the signing
surface as a legacy signing when a row exists (`legacySigning` with
`method: 'LEGACY_RECORDED'`) and as nothing when none does; no package is
fabricated (X4, persistence 4.10).

## 3. Readers of `db.signings`

Analytics (M20), the journey (`outcome.signing`), the passport timeline,
the invoice link (`signingId`), the club's `/org/signings` list and the
player's notification all read the same rows as before. New fields
(`method`, `signingPackageId`, `signingRevisionId`, `offerId`, `caseId`,
`documentSha256`, `contract`, `parties`, `policyVersion`) are additive;
legacy rows carry them as `null`/`'LEGACY_RECORDED'`.

## 4. Client code

The club app's earlier "Record signing" control on the player drawer still
calls the legacy route and receives `SIGNING_CANONICAL_REQUIRED` with a
message that names the Signing tab when an accepted Offer exists. The
demo-mode catalogues (club, grassroots) carry the P7 confirmations
byte-identically (m182E2E §16).

## 5. Migration (§5, §89)

`m280_001_signing_workflow` (2307 → 2308) creates `db.signingPackages = []`
and nothing else. Persistence 1 proves: a 2307 store runs exactly this step
once; a fresh boot lands on 2308; a replay applies nothing; a restart
reports 2308; no `db.signings` row, no package, no `under_contract` appears
that was not there before. The P5.6D suites now assert their step is
2307 and that the single step above it is this one.

## 6. Drift regression (§88)

E2E Z1–Z4 sweep every `.mjs` outside `scripts/` and `node_modules/`:
`db.signings.push(` occurs in exactly one file (`m29/index.mjs`);
`contractStatus = 'under_contract'` in exactly one file; the legacy route's
body in `server.mjs` contains neither, nor `playerLevelAfterSigning(`; m29
never assigns `status = 'signed'`. A new direct writer anywhere fails the
suite.
