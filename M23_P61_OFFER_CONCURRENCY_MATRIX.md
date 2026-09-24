# M23 P6.1 — Offer concurrency matrix

Winner semantics for every race the Offer can be put in. The server is a
single Node event loop: two requests that arrive "at the same time" are
handled one after the other, each against the store the previous one
left. So every race resolves to a strict order, the second handler sees
the first's result, and the gates (state → rev → key) decide the loser's
answer. No lock, no merge, no last-writer-wins.

Counts are what the store and the streams hold after the race: Offer
rows, revision rows, response rows, case moves (`room_status_changed`
rows written by the ONE lifecycle writer), org-private events on the
club's stream, notifications, history lines, idempotency keys. Each row
names the check that proves it (`m23OfferHardeningE2E` unless stated).

| # | Race | Winner | Loser's answer | Records after | Case moves | Events | Notifications | Proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | issue vs issue (same `expectedRev`, different keys) | first handler | 409 `OFFER_STATE_INVALID` (state is checked before the rev) | 1 Offer, 1 revision ISSUED, 1 `offer_issued` history line | 1 (`offer_consideration → offer_made`) | 1 `offer_issued` | 1 to the recipient | F1–F1d |
| 2 | issue vs edit (same rev) | first handler | 409 (`OFFER_STATE_INVALID` if the edit followed the issue; `OFFER_REV_CONFLICT` if the issue followed the edit) | exactly the winner's shape; the loser changed nothing | 1 or 0 | 1 or 0 | 1 or 0 | F3, F3b |
| 3 | withdraw vs re-issue of an issued revision | the withdrawal | 409 `OFFER_STATE_INVALID` | live revision WITHDRAWN | 1 (`offer_made → offer_consideration`) | 1 `offer_withdrawn` | 1 to the recipient | F4, F4b |
| 4 | two revisions opened at once | first handler | 409 `OFFER_STATE_INVALID` | 1 new DRAFT; revision numbers unique and contiguous | 0 | 1 `offer_revision_opened` | 0 | F5, F5b |
| 5 | stale `expectedRev` vs current | the current one | 409 `OFFER_REV_CONFLICT` | one edit | 0 | 0 | 0 | F6; live S1 (the UI names it) |
| 6 | two drafts while a live Offer exists | nobody | both 409 `OFFER_STATE_INVALID` | unchanged | 0 | 0 | 0 | F8 |
| 7 | two drafts on a case with no live Offer | first handler | 409 `OFFER_STATE_INVALID` | exactly one live Offer on the case | 0 | 1 `offer_draft_created` | 0 | F9, F9b |
| 8 | accept vs accept | first handler | 409 `OFFER_ALREADY_RESPONDED` | 1 response row, revision ACCEPTED | 1 (`→ offer_accepted`) | 1 `offer_responded` | 1 to the club | P1, P1c; probe in the test report |
| 9 | decline vs decline | first handler | 409 `OFFER_ALREADY_RESPONDED` | 1 response row, revision DECLINED | 1 (`→ offer_declined`) | 1 `offer_responded` | 1 to the club | P2, P2c |
| 10 | accept vs decline | first handler | 409 `OFFER_ALREADY_RESPONDED` | 1 response row; the Offer and the case agree | 1 | 1 | 1 | P3, P3c |
| 11 | accept vs withdraw | first handler | 409 `OFFER_ALREADY_RESPONDED` (withdraw after the acceptance) or 409 `OFFER_WITHDRAWN` (accept after the withdrawal) — the loser is told which state won | 1 response row or 0; never both | 1 (to `offer_accepted` or back to `offer_consideration`) | 1 (`offer_responded` or `offer_withdrawn`) | 1 | P4, P4c; live S5 (the player app says "The club withdrew this Offer.") |
| 12 | decline vs withdraw | as 11 | as 11 | as 11 | 1 | 1 | 1 | P5, P5c |
| 13 | accept revision 1 vs issue revision 2 (supersede) | first handler | acceptance first: the unissued draft is discarded (recorded WITHDRAWN, `offer_draft_discarded` on the record) and the issue is 409 `OFFER_STATE_INVALID`; issue first: revision 1 is SUPERSEDED and the acceptance is 409 `OFFER_SUPERSEDED` | exactly one live revision; never an accepted revision beside an issued one | 1 | 1 | 1 | P6, P6b, P6c; live S3 |
| 14 | the same create key twice in parallel | first handler | 200 `idempotent: true` with the same Offer | 1 Offer | 0 | 1 | 0 | G1 |
| 15 | the same issue key twice in parallel | first handler | 200 `idempotent: true` | 1 issued revision, 1 history line | 1 | 1 | 1 | G3 |
| 16 | accept 1 ms before expiry vs accept at expiry | the earlier instant | 409 `OFFER_EXPIRED` | 1 response row when the early one landed; 0 otherwise | 1 or 0 | 1 or 0 | 1 or 0 | E1–E4, E10 |
| 17 | block vs accept | the block, if it landed first (403 `OFFER_BLOCKED` for the acceptance); the acceptance, if it landed first (the block rewrites nothing) | as stated | 0 or 1 response row | 0 or 1 | 0 or 1 | 0 or 1 | D1–D3, D11–D13 |

## Rules the matrix rests on

1. **State before rev before key.** A mutation first asks whether the
   act is possible in the revision's current state, then whether the
   caller's `expectedRev` is the Offer's, then whether the key was used.
   A replay under a used key is answered before the rev is read (G4),
   but only after authority is re-derived (G17).
2. **One live revision.** Every write that produces an issued revision
   either supersedes or discards the one before it in the same handler,
   so no order of events leaves two answerable revisions (P6b).
3. **One response row per revision**, enforced both by the gate and by
   the integrity rule `duplicate_response`.
4. **The lifecycle moves once per winning act**, through
   `ctx.applyLifecycleTransition`; a losing act never reaches it. A
   writer that throws rolls the Offer change back (O3).
5. **Events and notifications follow the persisted truth**, never the
   attempt: a loser emits nothing (P1–P5 count exactly one event).
6. **Expiry is the handler's single instant.** No timestamp from the
   client is read; the request's server instant (`now(req)`) is used for
   the whole handler, so a request "started before expiry" is one whose
   instant precedes it (E10).

## What was NOT changed for the matrix

No lock, queue or retry was added. The single event loop already
serialises handlers; the matrix documents the consequence and proves it
with `Promise.all` pairs on a real server.
