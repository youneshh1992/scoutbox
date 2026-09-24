# M23 P7.1 — Signing concurrency matrix

Every race the mandate names (§18), the mechanism that decides it, the one
authoritative result, and the exact check that proves it. The store is a
single-threaded process: every act runs to completion before the next, so
"parallel" requests are serialised on arrival; what matters is that each
act re-derives its gate **inside** the act, and that a loser is refused by
a deterministic code rather than partially applied.

| # | Race | Decided by | Winner / loser | Never | Proof |
| --- | --- | --- | --- | --- | --- |
| 1 | complete vs complete | the first completes; the second finds `pkg.status === 'COMPLETED'` → `SIGNING_ALREADY_COMPLETED`; the writer refuses a second row per package and per Offer structurally (H-P71-3) | one 200, one 409 | two rows; two `signed` moves | hardening J1, J12, J13; P7 P group |
| 2 | complete vs cancel | the first act's state change is read by the second: `completionGate` names `STATE_CANCELLED` → `SIGNING_CANCELLED`, or `canCancel` names `COMPLETED` → `SIGNING_ALREADY_COMPLETED` | one 200, one 409 | COMPLETED + CANCELLED | hardening J2; P7 P (#31) |
| 3 | complete vs void | as 2 with `SIGNING_VOIDED` / `SIGNING_ALREADY_COMPLETED` | one 200, one 409 | COMPLETED + VOIDED | hardening J3; P7 P (#32) |
| 4 | complete vs expiry | the completion's own server instant: `effectiveStatus(pkg, at)` is EXPIRED at or after `expiresAt` → gate `EXPIRED` → `SIGNING_EXPIRED`; one millisecond before → lands | deterministic by instant | COMPLETED + EXPIRED | hardening K2–K5; P7 R4–R6 (#29, #33) |
| 5 | final party completion vs cancel | the same two orderings as 2: the cancel refuses a later party (`SIGNING_CANCELLED`); a cancel after the party still cancels (no completion happened) | one order | a cancelled package that completes | hardening J4, J4b |
| 6 | final party completion vs void | as 5 with `SIGNING_VOIDED` | one order | a voided package accepting a signature | hardening J5; P7 AD7 |
| 7 | final party completion vs supersede | `expectedRev` on the supersede: if the party landed first the rev moved and the supersede is `SIGNING_REV_CONFLICT`; if the supersede landed first the party names a revision that is no longer current → `SIGNING_SUPERSEDED` | one order, both legal | a confirmation counting on the wrong revision | hardening J6, J6b, J8 |
| 8 | document replace vs party completion | impossible by state: attach is DRAFT-only, a presented revision is frozen → `SIGNING_STATE_INVALID`; the signature binds the digest it names | the replace always loses | a signature on bytes the party never saw | hardening J9; P7 G11 (#19) |
| 9 | supersede vs party completion | as 7 | one order | — | hardening J8 |
| 10 | party completion vs party completion (same party) | the first completes; the second finds `party.status === 'COMPLETED'` → `SIGNING_PARTY_ALREADY_COMPLETED`; the player's route has no rev, the club's has | one completion per party | two evidence references on one party | hardening J7; P7 Q5 (#34) |
| 11 | player vs club party in parallel | independent parties; the club's `expectedRev` may conflict with the player's bump → `SIGNING_REV_CONFLICT`, retried by the client | both land, or the club retries | a lost signature | hardening J7 |
| 12 | stale rev vs current rev | `revGate` after the state gate: the stale act is `SIGNING_REV_CONFLICT`, or the state code the winner left behind | the stale one loses | a stale write overwriting the current state | hardening J10, M1–M4; P7 Q3 (#36) |
| 13 | duplicate clientKey in parallel | the first stores the key; the others replay (`idempotent: true`) with the same fingerprint or conflict; the writer is idempotent per package | one row; replays return the same result | duplicate rows | hardening J11; P7 K7 (#20, #47) |
| 14 | two different keys, same semantic completion | the second finds COMPLETED → `SIGNING_ALREADY_COMPLETED` | one row | — | hardening J12; P7 K8 |
| 15 | lifecycle `signed` write vs duplicate complete | the lifecycle moves inside the first completion's unit of work; a second completion never reaches the lifecycle | exactly one `room_status_changed → signed` | two case moves | hardening J13; P7 K5 |
| 16 | start vs start | `canStart` finds the live package → `SIGNING_PACKAGE_EXISTS` | one package | two live packages over one Offer | P7 P1 |
| 17 | completion vs restart | the unit of work persists once, after every authoritative write; a crash before persistence leaves nothing, a crash after leaves everything; the key replays to the same result | converges | a half-persisted completion | persistence 5.7a–5.7e; hardening Q |
| 18 | party write vs failure | the party completion is its own unit of work: a throw before persistence restores the party, the statuses, the key, the history and the rev (H-P71-5) | 500 and nothing recorded; the retry is a real act | a party completed in memory only | hardening Q1–Q3 |

## Why "one winner" holds without locks

1. Every act reads its gate from the store at the moment it runs, never from
   what the client sent (state, then rev, then rate).
2. Every terminal transition is a single in-memory assignment sequence followed
   by one `persistNow()`; nothing yields between the gate and the write.
3. The only multi-store act (completion) snapshots first and restores on any
   refusal or throw (M23_P71_SIGNING_PARTIAL_FAILURE_MATRIX.md).
4. Keys and rows are checked structurally (per package, per Offer), so a
   replayed or duplicated request cannot create a second fact even if two
   requests interleave across a restart.

## What is deliberately not "won"

- A player's confirmation and the club's confirmation are independent parties;
  both may land. Only the same party twice is a race with a loser.
- A cancel after a final party confirmation is a legitimate act, not a race
  loser: the club may still stop a package that nobody completed.
