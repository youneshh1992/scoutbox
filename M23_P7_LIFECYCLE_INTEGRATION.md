# M23 P7 — Lifecycle integration

How the signing workflow meets the recruitment case lifecycle: through the
ONE validator and the ONE lifecycle writer, from exactly one place, on
exactly one event — the canonical completion (§24).

## 1. The seam

`m29` receives `findRoomForRequest`, `applyLifecycleTransition` and the real
`recruitmentEvidenceProvider` from `server.mjs`. It never assigns a status
word (`Z4`: the source sweep proves no `status = 'signed'` in m29). Its
`advanceCase` asks `canTransitionRecruitmentCase(room, 'confirmSignedOutcome',
{ role, evidence, now })` and, when the verdict is ok, calls
`ctx.applyLifecycleTransition` with the trigger `signing:complete:<pkg>`.

## 2. Evidence for `signed`

The evidence provider's `signed_outcome` rule (m23/evidence.mjs) is
satisfied only by a `db.signings` row for this case's player and club. The
completion writes that row **first** (through `recordCompletedSigning`) and
then asks the validator, which finds it. Consequences proven in E2E L and
X and live A3c:

- `POST /org/rooms/:id/lifecycle { action: 'confirmSignedOutcome' }` by hand: `422 LIFECYCLE_EVIDENCE_REQUIRED` (no signing evidences it; #22);
- the legacy status writer `POST /org/rooms/:id/status { status: 'signed' }`: `422 ROOM_EVIDENCE_REQUIRED` (L2);
- a package in progress, even with every party confirmed: still `422` (L4, J5, #26);
- a package cancelled, voided, expired or superseded: writes nothing, so the case cannot reach `signed` (L9–L10, R4–R6, AD6; #27–#30);
- `under_review → signed` is not an edge of the graph at all (`409 ROOM_TRANSITION_INVALID`, X3).

## 3. The unit of work (§70, §87, #47, #48)

```
snapshot ← { pkg, db.signings.length, db.ledger.length, db.invoices.length, player, org.squad, case status, case history length }
rev.status = COMPLETED; pkg.status = COMPLETED
row ← recordCompletedSigning(...)          // the ONE writer; idempotent per package
pkg.completion ← { signingId, completedAt, completedBy, contract, documentSha256, lifecycle: null }
moved ← advanceCase(confirmSignedOutcome)  // the ONE validator + the ONE lifecycle writer
if !moved.applied → rollback → 409 SIGNING_LIFECYCLE_CONFLICT
pkg.completion.lifecycle ← { from, to, at }; case.links.signingId ← row.id
keys, history, audit, touch; persistNow()
any throw → rollback → 500 SIGNING_STATE_UNKNOWN ("nothing was recorded")
then, each under safe(): effects (badges, level/signing notifications, broadcast), agent and club notifications
```

`rollback` restores the package, truncates `db.signings`, the ledger and
the invoices to their lengths, restores the player row and the club squad,
and puts the case status and history back. Group AD (R4) arms the
development fault layer at two seams — after the row, after the lifecycle
— and proves the package, `db.signings`, the case, the player and the
history are byte-for-byte as before, that the same completion then
succeeds with exactly one row, and that a failure in the after-effects
does not undo an authoritative completion.

## 4. Journey and case surfaces

`buildRecruitmentJourney` reads `outcome.signing` from the `db.signings` row
(`{ id, at, method, signingPackageId }`) and lists `outcome.signingPackages`
(id, status, revision number, presented/completed instants) — no term, no
note. The room header reads `Signed` from the case status the ONE writer
set. The Offer's club and recipient views carry `signing` (a summary from
`summaryForOffer`, late-bound into m28): `{ status, signingPackageId,
signingId, completedAt }` — so "Offer accepted — signing pending" becomes
"Signing completed" from the same fact.

## 5. Direction of dependence

m28 (Offer) knows nothing of m29 except the late-bound summary function;
m29 reads Offers and cases and writes neither. Lifecycle transitions are
requested, never performed. The evidence provider is the real one, not a
signing-specific shortcut. This is the shape the P6 audit asked for and the
P7 audit (M23_P7_EXISTING_SIGNING_WRITER_AUDIT.md) preserved.
