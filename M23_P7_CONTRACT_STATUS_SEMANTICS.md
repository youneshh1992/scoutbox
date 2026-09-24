# M23 P7 — Contract status semantics

What `under_contract`, the contract days, the player's level, the success-fee
invoice and the affiliation row mean after P7, and the one place each is
written for a recruitment signing (§25–§30, §72–§76).

## 1. `player.contractStatus = 'under_contract'` (§25)

Means: **a signing was completed** — every required party confirmed the
exact document and a recruitment lead completed the package through the
canonical completion — or, for a recruitment that never went through an
Offer, the legacy route recorded a signing through the same writer.
Written in exactly one file, `m29/index.mjs` (`recordCompletedSigning`),
proven by the source sweep (Z2). Never written by Offer acceptance
(B4, #21), by a party's confirmation (#22), by a cancelled, voided, expired
or superseded package (#27–#30), by the lifecycle route, or by a migration
(persistence 1: nothing backfilled).

`under_contract` is a **projection of the completed contract**, not a
promise about its legal standing (§103). The player app says "The contract
is on record with this club."

## 2. Contract days (§26–§28)

`contract.startDate` (required to present) and `contract.endDate`
(optional) are DATE_ONLY strings validated by `parseStrictDateOnly`
(impossible days refused, instants refused, `end ≥ start`, end ≤ 10 years
after start; A13, Y2–Y5, #44). They come from the accepted Offer's terms at
package start and may be edited while the revision is DRAFT. They are
frozen on the presented revision, copied to `pkg.completion.contract` and
to the `db.signings` row's `contract`. They are days, distinct from
`signedAt` (an instant). A future start day is allowed: `under_contract`
is set at completion, and the contract's own start is the day on the
record (§27). No expiry job flips `under_contract` back at `endDate`; that
is a P7.1 question (§28) and is stated here rather than guessed.

## 3. One completed signing per Offer (§29, §30, §71)

`canStart` refuses `SIGNING_ALREADY_COMPLETED` over an Offer with a
completed package; the completion gate names `CONFLICTING_COMPLETED_SIGNING`
if another completed package or a `db.signings` row for the Offer exists;
`recordCompletedSigning` is idempotent per package (`completedRowFor`). An
amendment or a further contract is a further Offer and a further signing,
not a mutation of this one.

## 4. Level, availability, timeline (§73)

`recordCompletedSigning` moves `player.level` by the club's level
(`playerLevelAfterSigning`), sets `availability = 'not_seeking'`, appends a
timeline line ("Signed with <club> — signing completed in ScoutBox") and
the level-up line when the level changed. All inside the unit of work, all
rolled back on failure.

## 5. Success-fee invoice (§73)

Issued at most once per signing, only when `insideAttributionWindow`
(the org's plan window from the first ledger interaction), through the
billing adapter, inside the unit of work (O1, P6b). Rolled back with the
signing on failure (`db.invoices.length` restored).

## 6. Affiliation / squad (§76)

A grassroots club's `org.squad` gains the player on a legacy recording
(source `signing`); a Pro club's squad is not touched by a signing. The
canonical completion never runs for a grassroots club (they have no Offer
surface), so the squad write is reached only through the legacy route.

## 7. Passport and analytics (§75, §78)

The Football Passport reads the timeline line and the level; it does not
read the package, the digest or the note. Recruitment analytics count
`db.signings` rows as before; `method` distinguishes `CANONICAL_COMPLETION`
from `LEGACY_RECORDED` for anyone who needs to. The Trust Score reads
nothing from either (§77, Z6, K13, #50).

## 8. Restart

`under_contract`, the level, the timeline and the row are persisted by
`persistNow()` inside the unit of work; a completion that fails before
persistence leaves nothing in memory or on disk (AD13); a restart after a
completion finds the same row and the same player (Z8–Z11, persistence 3).
